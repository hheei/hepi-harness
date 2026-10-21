/**
 * Ticket 06 regression: an image the browser attaches is submitted as native content to the configured model, and
 * survives SSE projection, a browser reconnect and a backend restart.
 *
 * Real production paths only: the production Next build, the real backend process, the composer's own file input and
 * the real /api/agent prompt route. A controlled OpenAI-completions endpoint stands in for the paid provider and
 * records the exact request body, so the assertions read the bytes a model would have received rather than UI state.
 *
 * Two origins are exercised because submission must work on both: a plain-HTTP LAN origin (an insecure context, where
 * crypto.randomUUID does not exist) and an HTTPS origin terminated by a local self-signed proxy (a secure context).
 * The backend restarts against the same SQLite file to prove durable history.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-image-submit.mjs
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-image-submit-token";
const webPort = Number(process.env.HEPI_UX06_WEB_PORT ?? 43106);
const backendPort = Number(process.env.HEPI_UX06_BACKEND_PORT ?? 44106);
const imageModel = "deepseek-v4.1-flash";
const textOnlyModel = "deepseek-v4-pro";
/** A real 1x1 RGBA PNG; the assertions compare these exact bytes rather than a marker string. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux06-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
console.log("Artifacts: " + artifacts);
assert.ok(readFileSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const failures = [];
const sessions = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000).then(() => child.kill("SIGKILL"))]);
}
const backendChild = () => children.find((child) => child.spawnargs.some((argument) => argument.endsWith("image-submit-fixture.ts")) && child.exitCode === null);

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** One OpenAI-completions endpoint that records every request and answers a minimal streamed completion. */
function controlledEndpoint() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: imageModel, choices: [{ index: 0, delta: { role: "assistant", content: "saw the image" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: imageModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({ origin: "http://127.0.0.1:" + address.port, requests, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

/** The insecure HTTP origin the browser uses: a non-loopback address of this host. */
function lanAddress() {
  const configured = process.env.HEPI_UX06_LAN_HOST;
  if (configured) return configured;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

/**
 * The real backend with a real local execution gateway, so a conversation can load its resources and run. The
 * controlled model endpoint is the only substitution; the fixture script owns the gateway and workspace.
 */
async function startBackend(name, dbPath, model, endpoint) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(artifacts, name),
      HEPI_UX06_DB: dbPath,
      HEPI_UX06_BACKEND_PORT: String(backendPort),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: model,
      HEPI_UX06_ENDPOINT: endpoint.origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(origin + "/api/workspaces", { authorization: "Bearer " + token }, 45_000), "the backend started for " + model + ": " + log().slice(-500));
  return child;
}

/** Wait until the fixture endpoint recorded at least `count` model requests, driven by the fixture's own state. */
async function waitForRequests(requests, count, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && requests.length < count) await delay(50);
  assert.equal(requests.length, count, message + " (recorded " + requests.length + " requests)");
}

async function sessionId() {
  const catalog = await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { headers: { authorization: "Bearer " + token } })).json();
  const bound = catalog.conversations.filter((item) => item.workspaceId === "local");
  assert.equal(bound.length, 1, "the fixture exposes exactly one workspace-bound conversation");
  return bound[0].id;
}

const cookieValue = (cookie) => cookie.replace(/^hepi-web-token=/, "");

/**
 * The login request for the HTTPS origin accepts the driver's own self-signed certificate. The browser already does
 * (ignoreHTTPSErrors), so this keeps the two halves of the same scene consistent without weakening any other origin.
 */
async function loginResponse(origin) {
  const request = { method: "POST", headers: { "content-type": "application/json", origin, host: new URL(origin).host }, body: JSON.stringify({ token }) };
  if (!origin.startsWith("https:")) return fetch(origin + "/api/durable-login", request);
  const { Agent } = await import(join(webRoot, "node_modules", "undici", "index.js"));
  const agent = new Agent({ connect: { rejectUnauthorized: false } });
  try { return await fetch(origin + "/api/durable-login", { ...request, dispatcher: agent }); } finally { await agent.close(); }
}

/** A page on the real Web origin with the durable session in view. */
async function openPage(browser, origin, id, secureExpected) {
  const login = await loginResponse(origin);
  assert.equal(login.status, 200, "the browser session authenticated against " + origin);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", ignoreHTTPSErrors: true });
  await context.addCookies([{ name: "hepi-web-token", value: cookieValue(cookie), url: origin, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin + "/?session=" + id, { waitUntil: "domcontentloaded" });
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  const secure = await page.evaluate(() => window.isSecureContext);
  check(secure === secureExpected, origin + " is " + (secureExpected ? "a secure" : "an insecure") + " context (isSecureContext=" + secure + ")");
  const view = { page, context, pageErrors };
  sessions.push(view);
  return view;
}

const imagePath = join(artifacts, "tiny.png");
writeFileSync(imagePath, TINY_PNG);
const oversizedPath = join(artifacts, "oversized.png");
writeFileSync(oversizedPath, Buffer.alloc(10 * 1024 * 1024 + 1024, 7));
const textPath = join(artifacts, "notes.txt");
writeFileSync(textPath, "not an image");

const imageEndpoint = await controlledEndpoint();
const textOnlyEndpoint = await controlledEndpoint();
const lan = lanAddress();
assert.ok(lan !== undefined, "a non-loopback IPv4 address is required for the insecure-context scene; set HEPI_UX06_LAN_HOST");

const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "0.0.0.0", "-p", String(webPort)], {
  cwd: webRoot,
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(artifacts, "web-home"),
    TMPDIR: tmpdir(),
    HEPI_SERVER_URL: "http://127.0.0.1:" + backendPort,
    HEPI_AUTH_TOKEN: token,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
children.push(web);
const webLog = capture(web);

let httpsProxy;
let browser;

/** Wait for the answer the controlled endpoint streams, so the run settled instead of merely starting. */
const waitForAnswer = (page) => page.getByText("saw the image").first().waitFor({ timeout: 30_000 });

async function attachAndSend(page, message, files) {
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles(files);
  await page.locator("textarea").first().fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

/** A committed transcript image must decode and serve the submitted bytes, whether inline or deferred. */
const submittedImageShown = (page) => page.locator("[data-entry-id] img").evaluateAll(async (images, expected) => {
  for (const image of images) {
    try {
      await image.decode();
      if (image.naturalWidth === 0 || image.getClientRects().length === 0) continue;
      const response = await fetch(image.currentSrc || image.src);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])) return true;
    } catch {
      // A broken or unreadable image does not satisfy the display check.
    }
  }
  return false;
}, Array.from(TINY_PNG));
/** The composer's attachment previews, which a refused submission keeps so the user can retry. */
const composerImageSrc = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.chat-input-shell img[src^="data:image/png;base64,"]')).map((element) => element.getAttribute("src")));

try {
  const webOrigin = "http://" + lan + ":" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 90_000), "the Web UI started on " + webOrigin + ": " + webLog().slice(-500));
  browser = await chromium.launch();

  // 1. Insecure HTTP origin: the real composer submits the attached PNG and the model receives the exact bytes.
  await startBackend("insecure", join(dataDir, "insecure.sqlite"), imageModel, imageEndpoint);
  const insecureId = await sessionId();
  const insecure = await openPage(browser, webOrigin, insecureId, false);
  await attachAndSend(insecure.page, "insecure origin image", [imagePath]);
  await waitForAnswer(insecure.page);
  await waitForRequests(imageEndpoint.requests, 1, "exactly one model request carried the submission");
  const insecureRequest = imageEndpoint.requests[0];
  check(insecureRequest.authorization === "Bearer controlled-key", "the configured key authenticated the request");
  const insecureUser = insecureRequest.body.messages.find((message) => message.role === "user");
  const expectedContent = [
    { type: "text", text: "insecure origin image" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + TINY_PNG.toString("base64") } },
  ];
  check(JSON.stringify(insecureUser.content) === JSON.stringify(expectedContent), "the model received the prompt text and the exact PNG bytes: " + JSON.stringify(insecureUser.content).slice(0, 200));
  check(await submittedImageShown(insecure.page), "the submitted image is rendered from the durable entry");
  check(insecure.pageErrors.length === 0, "no page error occurred: " + insecure.pageErrors.join(" | "));

  // 2. Browser reconnect: a fresh page on the same origin restores image and text from committed history.
  const reconnected = await openPage(browser, webOrigin, insecureId, false);
  await waitForAnswer(reconnected.page);
  check(await submittedImageShown(reconnected.page), "a reconnected browser restores the image from history");
  check((await reconnected.page.getByText("insecure origin image").count()) > 0, "a reconnected browser restores the prompt text");

  // 3. Backend restart on the same database: image and text survive process replacement.
  await stop(backendChild());
  await startBackend("restarted", join(dataDir, "insecure.sqlite"), imageModel, imageEndpoint);
  const restarted = await openPage(browser, webOrigin, insecureId, false);
  await waitForAnswer(restarted.page);
  check(await submittedImageShown(restarted.page), "a page after a backend restart restores the image");
  check((await restarted.page.getByText("insecure origin image").count()) > 0, "a page after a backend restart restores the prompt text");

  // 4. The HTTPS origin the deployment supports: the same submission succeeds in a secure context.
  const tlsDir = join(artifacts, "tls");
  mkdirSync(tlsDir, { recursive: true });
  const keyPath = join(tlsDir, "key.pem");
  const certPath = join(tlsDir, "cert.pem");
  spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  assert.ok(readFileSync(certPath).length > 0, "openssl produced a self-signed certificate");
  const httpsPort = await freePort();
  httpsProxy = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    // The original Host header is forwarded unchanged: the Web route compares Origin's host against it, and a
    // rewritten host would be refused as cross-origin.
    const upstream = httpRequest({ host: "127.0.0.1", port: webPort, path: request.url, method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  await new Promise((resolveListen, reject) => { httpsProxy.once("error", reject); httpsProxy.listen(httpsPort, "127.0.0.1", resolveListen); });
  const httpsOrigin = "https://127.0.0.1:" + httpsPort;
  const httpsPage = await openPage(browser, httpsOrigin, insecureId, true);
  await attachAndSend(httpsPage.page, "https origin image", [imagePath]);
  await waitForAnswer(httpsPage.page);
  await waitForRequests(imageEndpoint.requests, 2, "the HTTPS submission reached the model endpoint");
  const httpsUser = imageEndpoint.requests[1].body.messages.filter((message) => message.role === "user").at(-1);
  check(JSON.stringify(httpsUser.content) === JSON.stringify([
    { type: "text", text: "https origin image" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + TINY_PNG.toString("base64") } },
  ]), "the HTTPS origin sent the prompt text and the exact PNG bytes");

  // 5. Validation: a non-image file and an oversized image are named in the visible error and never sent.
  const before = imageEndpoint.requests.length;
  await httpsPage.page.locator('input[type="file"][accept="image/*"]').setInputFiles([textPath, oversizedPath]);
  await httpsPage.page.getByText("Some images were not attached").waitFor({ timeout: 15_000 });
  const rejectionText = await httpsPage.page.locator('[role="alert"]').first().innerText();
  check(rejectionText.includes("notes.txt"), "the unsupported file is named in the visible error: " + rejectionText.split("\n").join(" | "));
  check(rejectionText.includes("oversized.png"), "the oversized image is named in the visible error");
  check(imageEndpoint.requests.length === before, "a refused attachment never reaches the model");

  // 6. A model without image input refuses the submission with a real error UI instead of dropping the image.
  await stop(backendChild());
  await startBackend("text-only", join(dataDir, "text-only.sqlite"), textOnlyModel, textOnlyEndpoint);
  const textOnlyId = await sessionId();
  const textOnly = await openPage(browser, webOrigin, textOnlyId, false);
  await attachAndSend(textOnly.page, "text only model", [imagePath]);
  // The backend rejection names the selected model and the reason; it is distinct from the composer's own
  // pre-send warning, which only says the model does not support image input.
  const notice = textOnly.page.getByText(/does not accept image input/);
  await notice.first().waitFor({ timeout: 30_000 });
  check(true, "the refusal reason is visible to the user: " + (await notice.first().innerText()).split("\n").join(" | "));
  check(textOnlyEndpoint.requests.length === 0, "the image was never sent to a model that cannot read it");
  check((await textOnly.page.locator("[data-entry-id] img").count()) === 0, "a refused submission leaves no submitted image in the transcript");
  check((await composerImageSrc(textOnly.page)).length === 1, "a refused submission keeps the attachment in the composer so the user can retry");
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const { context } of sessions) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await new Promise((done) => httpsProxy === undefined ? done() : httpsProxy.close(done));
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await imageEndpoint.close();
  await textOnlyEndpoint.close();
  if (failures.length > 0) { console.error("UX-06 image submission checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  rmSync(artifacts, { recursive: true, force: true });
  console.log("UX-06 image submission checks PASSED");
}
