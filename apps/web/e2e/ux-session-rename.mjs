/**
 * Ticket 02 regression, driven through the real production Web UI, the real Web adapter and a real backend process.
 *
 * A session's name is hepi conversation-scoped state: the sidebar's Rename writes it, the row and the catalogue the
 * shell reads show it without a page reload, it survives a reload and a backend restart, and a refused rename leaves
 * the row as it was and reports the reason the backend gave. Two browser windows of one backend agree after a rename.
 *
 * Real paths only: the production Next build, the real backend process with its SQLite store, and the sidebar's own
 * row menu and inline rename input. The model endpoint is this script's own controlled OpenAI-completions server, so
 * nothing contacts a paid provider. Every wait is an observable UI or request state; there are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-session-rename.mjs
 *        HEPI_RENAME_WEB_PORT=<port> HEPI_RENAME_BACKEND_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-session-rename-token";
const modelId = "controlled-1";
const sessionTitle = "Release checklist";
const otherTitle = "Deploy notes";
const refusalName = "x".repeat(81);
const webPort = Number(process.env.HEPI_RENAME_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_RENAME_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-session-rename-"));
const dataDir = join(artifacts, "data");
const workspaceRoot = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

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

function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
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

/** One OpenAI-completions endpoint, so a conversation in the configured workspace can hold a real turn. */
function controlledEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const base = { id: "chatcmpl-rename", object: "chat.completion.chunk", created: 1, model: modelId };
      const frame = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "rename driver answer" }, finish_reason: null }] });
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
      response.end("data: [DONE]\n\n");
    });
  });
  let listening = "";
  return {
    requests,
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

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
let backend;
let backendOrigin;
let web;
let webOrigin;
let browser;
let endpoint;

function startBackend(port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(port),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_WORKSPACE_ID: "local",
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: "http://127.0.0.1:9",
      HEPI_GATEWAY_TOKEN: "unused-gateway-token",
      HEPI_PROVIDER: "controlled",
      HEPI_MODEL: modelId,
      HEPI_PROVIDER_BASE_URL: endpoint.origin() + "/v1",
      HEPI_PROVIDER_API_KEY: "controlled-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + port };
}

const api = async (path, init) => (await fetch(backendOrigin + path, { headers, ...init })).json();

/** One browser window of this backend, logged in exactly as the page does. */
async function newWindow(sessionId) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  return { page, context, pageErrors };
}

/** The sidebar row of one conversation, addressed by the row key the tree renders. */
const row = (page, id) => page.locator(`[data-row-key="session:group:${id}"]`);

/** Rename through the row's own ⋯ menu and inline input, exactly as a user does. */
async function renameThroughSidebar(page, id, name) {
  const target = row(page, id);
  await target.waitFor({ timeout: 30_000 });
  await target.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const input = target.locator("input.session-tree-rename");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(name);
  await input.press("Enter");
}

try {
  endpoint = controlledEndpoint();
  await endpoint.listen(0);
  const chosenBackendPort = await freePort(backendPort);
  const first = startBackend(chosenBackendPort);
  backend = first.child;
  backendOrigin = first.origin;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + first.log().slice(-500));

  const chosenWebPort = await freePort(webPort);
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(chosenWebPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + chosenWebPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  // Two conversations, both recorded the same way: the row's own title is what the catalogue reports, not a file name.
  const firstId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({}) })).conversationId;
  const secondId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({}) })).conversationId;

  browser = await chromium.launch();
  const one = await newWindow(firstId);
  const two = await newWindow(secondId);
  check(one.pageErrors.length === 0 && two.pageErrors.length === 0, "the shell mounted without a page error");

  // ------------------------------------------------------------ rename is applied without a page reload
  await renameThroughSidebar(one.page, firstId, sessionTitle);
  await row(one.page, firstId).getByText(sessionTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "the renamed row shows the new name without a page reload");
  // The catalogue the shell reads is the same read the adapter serves; it must state the name for every session.
  const catalogue = await (await fetch(webOrigin + "/api/sessions", { headers: { cookie: (await one.context.cookies()).map((entry) => entry.name + "=" + entry.value).join("; ") } })).json();
  check(catalogue.sessions.find((session) => session.id === firstId)?.name === sessionTitle, "the catalogue the browser reads carries the name: " + JSON.stringify(catalogue.sessions.map((session) => ({ id: session.id, name: session.name }))));
  check(catalogue.sessions.find((session) => session.id === secondId)?.name === undefined, "a session nobody renamed reports no name");

  // ------------------------------------------------------------ two windows of one backend agree
  await row(two.page, firstId).getByText(sessionTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "the second window shows the name the first window set, without a reload");

  // ------------------------------------------------------------ a refused rename keeps the name and reports why
  const refusal = await fetch(webOrigin + "/api/sessions/" + firstId, {
    method: "PATCH",
    headers: { cookie: (await one.context.cookies()).map((entry) => entry.name + "=" + entry.value).join("; "), "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host },
    body: JSON.stringify({ name: refusalName }),
  });
  const refusalBody = await refusal.json();
  check(refusal.status === 400 && /1 to 80 characters/.test(refusalBody.error ?? ""), "the backend refused the over-long name with its own reason: " + JSON.stringify(refusalBody));
  const unknown = await fetch(webOrigin + "/api/sessions/999999", {
    method: "PATCH",
    headers: { cookie: (await one.context.cookies()).map((entry) => entry.name + "=" + entry.value).join("; "), "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host },
    body: JSON.stringify({ name: "Whatever" }),
  });
  check(unknown.status === 404, "renaming an unknown session is refused as not found: " + unknown.status);
  await renameThroughSidebar(one.page, firstId, refusalName);
  await one.page.getByText(/Couldn’t rename:/).waitFor({ timeout: 30_000 });
  const refusalToast = await one.page.getByText(/Couldn’t rename:/).first().innerText();
  check(refusalToast.includes("1 to 80 characters"), "the refused rename reports the backend's reason in the sidebar: " + refusalToast);
  await row(one.page, firstId).getByText(sessionTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "the refused rename left the previous name in the row");
  check((await api("/api/conversations")).conversations.find((item) => item.id === firstId).title === sessionTitle, "the backend still holds the previous name");

  // ------------------------------------------------------------ a reload and a backend restart keep the name
  await one.page.reload({ waitUntil: "domcontentloaded" });
  await row(one.page, firstId).getByText(sessionTitle, { exact: true }).waitFor({ timeout: 60_000 });
  check(true, "the name survives a page reload");

  await renameThroughSidebar(two.page, secondId, otherTitle);
  await row(two.page, secondId).getByText(otherTitle, { exact: true }).waitFor({ timeout: 30_000 });

  await stop(backend);
  const restarted = startBackend(chosenBackendPort);
  backend = restarted.child;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend restarted: " + restarted.log().slice(-500));
  await one.page.reload({ waitUntil: "domcontentloaded" });
  await row(one.page, firstId).getByText(sessionTitle, { exact: true }).waitFor({ timeout: 60_000 });
  check(true, "the name survives a backend restart");
  await row(one.page, secondId).getByText(otherTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "every renamed session's own name is still listed after the restart");

  check(one.pageErrors.length === 0 && two.pageErrors.length === 0, "no page error occurred: " + [...one.pageErrors, ...two.pageErrors].join(" | "));
  await one.context.close();
  await two.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failed:");
  for (const message of failures) console.log("  - " + message);
  process.exit(1);
}
console.log("\nAll session rename checks passed. Artifacts: " + artifacts);
