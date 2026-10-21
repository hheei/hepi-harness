/**
 * Ticket 06: an explicit auto-name request, driven through the real production Web UI, the real Web adapter and a real
 * backend process.
 *
 * A session is named from its own transcript only when the user asks: the toolbar's own "Generate title" posts to the
 * browser's `/api/sessions/<id>/auto-name`, the adapter carries it to the backend, the backend reads that
 * conversation's committed context, asks the conversation's own selected model with the reused title prompt, and
 * writes the answer as the same hepi title document the rename writes — so the sidebar row and the catalogue read show
 * it without a page reload. Creating and running a conversation names nothing; a name the user typed is kept until an
 * explicit request replaces it; a failed generation keeps the previous name and reports the reason.
 *
 * Real paths only: the production Next build, the real backend process (the image-submit fixture, so a conversation has
 * a genuine execution host and a real run settles), the sidebar's own row and the toolbar's own button. The model
 * endpoint is this script's own controlled OpenAI-completions server — it answers a naming request from a scripted name
 * and refuses one on demand — so nothing contacts a paid provider. Every wait is an observable UI, request or catalogue
 * state; there are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-session-auto-name.mjs
 *        HEPI_AUTONAME_WEB_PORT=<port> HEPI_AUTONAME_BACKEND_PORT=<port>  (optional; the run picks its own ports)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-session-auto-name-token";
const modelId = "deepseek-v4.1-flash";
const generatedName = "Release checklist";
const typedName = "My own name";
const runReply = "the controlled reply";
const webPort = Number(process.env.HEPI_AUTONAME_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_AUTONAME_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-session-auto-name-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

/** A port this run owns: the one the caller pinned, or an ephemeral one the run picks for itself. */
function freePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(preferred, "127.0.0.1", () => {
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

/**
 * One OpenAI-completions endpoint. A request carrying the reused title system prompt is a naming request and answers
 * the scripted name; every other request is a run and answers the controlled reply. A refusal makes the next naming
 * request fail at the provider, which is the generation failure the surface has to report.
 */
function controlledEndpoint() {
  const requests = [];
  let refuseTitle = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const naming = isNamingRequest(body);
      requests.push({ naming, body });
      if (naming && refuseTitle) { refuseTitle = false; response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "the provider refused this request" } })); return; }
      const content = naming ? generatedName : runReply;
      const base = { id: "chatcmpl-auto-name", object: "chat.completion.chunk", created: 1, model: modelId };
      const frame = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
      response.end("data: [DONE]\n\n");
    });
  });
  let listening = "";
  return {
    requests,
    refuseNextTitle: () => { refuseTitle = true; },
    namingRequests: () => requests.filter((entry) => entry.naming),
    listen: (port) => new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
        listening = "http://127.0.0.1:" + address.port;
        resolveListen();
      });
    }),
    origin: () => listening,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
  };
}

/** The reused title system prompt is what tells a naming request from a run. */
function isNamingRequest(body) {
  const messages = body.messages ?? [];
  const leading = messages.find((message) => message.role === "system" || message.role === "developer");
  return typeof leading?.content === "string" && leading.content.includes("You name chat sessions from a transcript");
}
/** The one user turn of a naming request: the bounded transcript followed by the reused prompt. */
function titleTranscript(entry) {
  const user = (entry.body.messages ?? []).find((message) => message.role === "user");
  const content = user?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
/** Set once from the port this run chose, before anything reaches it. */
let backendOrigin = "";
const api = async (path, init) => (await fetch(backendOrigin + path, { headers, ...init })).json();
const catalogue = async () => (await api("/api/conversations")).conversations;
const catalogueRow = async (id) => (await catalogue()).find((item) => item.id === id);

function startBackend(endpoint, port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(artifacts, "backend"),
      HEPI_UX06_DB: join(dataDir, "auto-name.sqlite"),
      HEPI_UX06_BACKEND_PORT: String(port),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: modelId,
      HEPI_UX06_ENDPOINT: endpoint.origin(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log };
}

/** A window of the real Web origin, logged in exactly as the page does. */
async function openPage(browser, origin) {
  const login = await fetch(origin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
  await context.route("**/api/projects", (route) => route.fulfill({ json: { protocol: "hepi.v1", projects: [] } }));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, context, pageErrors };
}

/** The sidebar row of one conversation, addressed by the row key the tree renders. */
const row = (page, id) => page.locator(`[data-row-key="session:group:${id}"]`);
/** The toolbar's own Generate title control, exactly as the user reaches it. */
const generateTitle = (page) => page.getByRole("button", { name: "Generate title", exact: true });
/** The sidebar rows, by the title the tree shows, with the group folds opened as the user opens them. */
async function rows(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let index = 0; index < 20; index += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  await page.locator(".session-tree-main").first().waitFor({ timeout: 30_000 });
  return page.locator(".session-tree-main").evaluateAll((elements) => elements.map((element) => element.innerText.split("\n")[0]));
}

/** Send one real turn through the composer and wait for its reply, so the transcript exists. */
async function sendTurn(page, text) {
  const composer = page.locator("textarea").first();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await composer.fill(text);
    await delay(80);
    if (await composer.inputValue() === text) break;
  }
  assert.equal(await composer.inputValue(), text, "the composer kept the prompt text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(runReply, { exact: true }).first().waitFor({ timeout: 60_000 });
}

let browser;
const views = [];
try {
  const endpoint = controlledEndpoint();
  await endpoint.listen(0);
  // Both ports are chosen here, once, and propagated to the two child processes: the run is self-contained, and the
  // same backend port is reused when the backend is restarted below.
  const chosenBackendPort = await freePort(backendPort);
  const chosenWebPort = await freePort(webPort);
  backendOrigin = "http://127.0.0.1:" + chosenBackendPort;
  try {
    const started = startBackend(endpoint, chosenBackendPort);
    assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + started.log().slice(-500));
    const bound = (await catalogue()).filter((item) => item.workspaceId === "local");
    assert.ok(bound.length > 0, "the fixture exposed a workspace-bound conversation");
    const sessionId = bound[0].id;

    const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(chosenWebPort)], {
      cwd: webRoot,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(artifacts, "web-home"), TMPDIR: tmpdir(), HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(web);
    const webLog = capture(web);
    const origin = "http://127.0.0.1:" + chosenWebPort;
    assert.ok(await waitForHttp(origin + "/", {}, 90_000), "the Web UI started: " + webLog().slice(-500));
    browser = await chromium.launch();
    const one = await openPage(browser, origin);
    views.push(one);
    await one.page.goto(origin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
    await one.page.locator("textarea").first().waitFor({ timeout: 60_000 });
    check(one.pageErrors.length === 0, "the shell mounted without a page error");

    // ------------------------------------------------------------ creating and running names nothing
    await sendTurn(one.page, "Plan the release checklist");
    check(endpoint.namingRequests().length === 0, "a run makes no naming request");
    check((await catalogueRow(sessionId)).title === null, "a conversation that ran turns is still unnamed");
    check((await rows(one.page)).some((title) => title.includes("Plan the release checklist")), "the row still shows its first message, not a name");

    // ------------------------------------------------------------ an explicit request names it, in the row and the catalogue
    await generateTitle(one.page).click();
    await row(one.page, sessionId).getByText(generatedName, { exact: true }).waitFor({ timeout: 30_000 });
    check(true, "the generated name appears in the sidebar row without a page reload");
    check((await catalogueRow(sessionId)).title === generatedName, "the catalogue the browser reads carries the generated name");
    check(endpoint.namingRequests().length === 1, "exactly one naming request was made, and only when asked: " + endpoint.namingRequests().length);
    const transcript = titleTranscript(endpoint.namingRequests()[0]);
    check(transcript.includes("User: Plan the release checklist"), "the naming request carries the conversation's own transcript: " + transcript.slice(0, 160));
    check(transcript.includes("Assistant: " + runReply), "and what came out of it");
    check(transcript.includes("Create a concise title for this session based on the conversation above."), "with the reused prompt shape");

    // ------------------------------------------------------------ the name is durable state, and a later run leaves it alone
    await one.page.reload({ waitUntil: "domcontentloaded" });
    await row(one.page, sessionId).getByText(generatedName, { exact: true }).waitFor({ timeout: 60_000 });
    check(true, "the generated name survives a page reload");
    await sendTurn(one.page, "A later turn");
    check(endpoint.namingRequests().length === 1, "a later run makes no naming request either");
    check((await catalogueRow(sessionId)).title === generatedName, "and leaves the name alone");

    // ------------------------------------------------------------ a name the user typed is not replaced by any implicit pass
    assert.equal((await fetch(backendOrigin + "/api/conversations/" + sessionId, { method: "PATCH", headers, body: JSON.stringify({ name: typedName }) })).status, 200);
    await one.page.reload({ waitUntil: "domcontentloaded" });
    await row(one.page, sessionId).getByText(typedName, { exact: true }).waitFor({ timeout: 60_000 });
    await sendTurn(one.page, "Another turn");
    check((await catalogueRow(sessionId)).title === typedName, "a name the user typed is not replaced by any implicit pass");
    check(endpoint.namingRequests().length === 1, "still no naming request");

    // ------------------------------------------------------------ a generation failure keeps the previous name and reports it
    endpoint.refuseNextTitle();
    await generateTitle(one.page).click();
    // The toolbar's own control says the generation failed and carries the provider's reason on it, which is the
    // upstream surface: locate the control in that state, because its accessible name has changed with it.
    const failedButton = one.page.locator("button", { hasText: "Generation failed" });
    await failedButton.first().waitFor({ timeout: 30_000 });
    const refused = await failedButton.first().getAttribute("title");
    check(/refused this request/.test(refused ?? ""), "the failed generation reports the provider's own reason: " + refused);
    check((await catalogueRow(sessionId)).title === typedName, "the previous name is still the stored one after a failed generation");
    check(endpoint.namingRequests().length === 2, "the refused attempt did reach the provider");

    // ------------------------------------------------------------ the next explicit request works and replaces it
    await generateTitle(one.page).click();
    await row(one.page, sessionId).getByText(generatedName, { exact: true }).waitFor({ timeout: 30_000 });
    check((await catalogueRow(sessionId)).title === generatedName, "an explicit request replaces the typed name with the generated one");
    check(endpoint.namingRequests().length === 3, "the second explicit request is the third naming request: " + endpoint.namingRequests().length);

    // ------------------------------------------------------------ the name survives a backend restart
    await stop(started.child);
    const restarted = startBackend(endpoint, chosenBackendPort);
    assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend restarted: " + restarted.log().slice(-500));
    await one.page.reload({ waitUntil: "domcontentloaded" });
    await row(one.page, sessionId).getByText(generatedName, { exact: true }).waitFor({ timeout: 60_000 });
    check(true, "the generated name survives a backend restart");

    check(one.pageErrors.length === 0, "no page error occurred: " + one.pageErrors.join(" | "));
  } finally {
    await endpoint.close().catch(() => {});
  }
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  for (const view of views) await view.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failed:");
  for (const message of failures) console.log("  - " + message);
  process.exit(1);
}
console.log("\nUX-06 session auto-name checks PASSED. Artifacts: " + artifacts);
