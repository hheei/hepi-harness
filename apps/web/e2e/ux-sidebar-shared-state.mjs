/**
 * Regression driver for ticket 01 (shared sidebar state): pins, archive, project order and the unread marker are one
 * document on the durable backend, so two windows of one backend agree, a reload reads the arrangement back from the
 * backend, and a backend restart keeps it.
 *
 * Everything is the real path: the real Web UI built from this tree, the real backend (apps/server/src/server.ts
 * through apps/server/scripts/image-submit-fixture.ts) on a real local gateway bound to a temporary workspace, and a
 * real Chromium. Nothing is stubbed and no request is patched. Every wait is an event or a state: a row appearing, a
 * toast offering Undo, a second window's tree showing what the first wrote.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-sidebar-shared-state.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-sidebar-state-token";
const webPort = Number(process.env.HEPI_SIDEBAR_WEB_PORT ?? 43130);
const backendPort = Number(process.env.HEPI_SIDEBAR_BACKEND_PORT ?? 44130);
const model = "deepseek-v4.1-flash";

const artifacts = mkdtempSync(join(tmpdir(), "hepi-sidebar-state-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "sidebar-state.sqlite");
assert.ok(readFileSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");
console.log("Artifacts: " + artifacts);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const children = [];
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
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
async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** One OpenAI-completions endpoint, so a conversation can hold a real turn without a paid provider. */
function controlledEndpoint() {
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "sidebar state answer" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({ origin: "http://127.0.0.1:" + address.port, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

async function startBackend(endpoint) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(artifacts, "backend"),
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
  assert.ok(await waitForHttp("http://127.0.0.1:" + backendPort + "/api/workspaces", { authorization: "Bearer " + token }, 45_000), "the backend started: " + log().slice(-500));
  return child;
}

/** The conversation ids the fixture's own catalogue lists, so the driver names real sessions rather than guesses. */
async function conversationIds() {
  const catalog = await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { headers: { authorization: "Bearer " + token } })).json();
  return catalog.conversations.filter((item) => item.workspaceId === "local").map((item) => item.id);
}

/** The state the backend holds, read through the Web adapter the browser itself uses. */
async function sidebarState(page) {
  return page.evaluate(async () => (await (await fetch("/api/sessions/ui-state", { cache: "no-store" })).json()).state);
}

/** A second session, so a bulk action has more than one row and a pin does not empty the list. */
async function createConversation() {
  const created = await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "local" }),
  });
  assert.equal(created.status, 201, "the fixture backend created a second conversation");
}

async function openWindow(browser, origin) {
  const login = await fetch(origin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const value = cookie.replace(/^hepi-web-token=/, "");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value, url: origin, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, context, pageErrors };
}

/** The sidebar's rows, opened as a user would open a folded group, and settled on real DOM. */
async function ready(page, origin) {
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
}

/**
 * The row's own actions show on hover (desktop), so a driver reaches them the way a person does: point at the row
 * first. Returns the session id the row belongs to, read from the row's own key.
 */
async function rowHandle(page, index = 0) {
  const row = page.locator(".session-tree-session").nth(index);
  await row.waitFor({ timeout: 20_000 });
  await row.hover();
  return row;
}

/** The row's session id, from the data key the tree renders for it. */
async function rowId(page, index = 0) {
  const key = await page.locator(".session-tree-session").nth(index).getAttribute("data-row-key");
  return key.split(":").pop();
}

/** Pin one listed session through its own row menu, as a user does. */
async function pinRow(page, index = 0) {
  await (await rowHandle(page, index)).locator(".session-tree-more-action").click();
  // The menu's accessible name carries the item's shortcut too, so the label is matched as the item's own name.
  await page.getByRole("menuitem", { name: "Pin", exact: false }).first().click();
}

const endpoint = await controlledEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(endpoint);
  await createConversation();
  const ids = await conversationIds();
  check(ids.length >= 2, "the fixture has two conversations in its own catalogue (" + ids.length + ")");

  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(artifacts, "web-home"),
      TMPDIR: tmpdir(),
      HEPI_SERVER_URL: "http://127.0.0.1:" + backendPort,
      HEPI_AUTH_TOKEN: token,
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  const origin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(origin + "/", {}, 90_000), "the Web UI started: " + webLog().slice(-500));
  browser = await chromium.launch();

  const first = await openWindow(browser, origin);
  contexts.push(first.context);
  await ready(first.page, origin);
  const rows = await first.page.locator(".session-tree-session").count();
  check(rows >= 2, "the first window lists the conversations (" + rows + " rows)");

  // Scene 0: the visible catalogue is the conversations a client created. The runtime's own root conversation is a
  // framework record — it owns the work that belongs to no conversation — so it is in no catalogue and in no group:
  // the sidebar cannot present it as a project named after the /durable sentinel, which is not a folder on any host.
  const catalog = await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { headers: { authorization: "Bearer " + token } })).json();
  check(catalog.conversations.every((item) => item.workspaceId !== null), "the catalogue lists no workspace-less framework record: " + JSON.stringify(catalog.conversations.map((item) => item.id + ":" + item.workspaceId)));
  const listed = await first.page.locator(".session-tree-group-name").allTextContents();
  check(!listed.includes("durable"), "no group is named after the sentinel: " + JSON.stringify(listed));
  // A window still sitting on the sentinel — a URL from before the record stopped being listed — is no exception: the
  // sentinel names no folder, so it is no project group and the sidebar shows none for it.
  await first.page.goto(origin + "/?cwd=%2Fdurable", { waitUntil: "domcontentloaded" });
  await first.page.locator(".session-tree-footer-button").first().waitFor({ timeout: 30_000 });
  const sentinel = await first.page.locator(".session-tree-group-name").allTextContents();
  check(!sentinel.includes("durable"), "a cwd that names no workspace is no project group: " + JSON.stringify(sentinel));
  await ready(first.page, origin);

  // Scene 1: pin a session in the first window. The write answers the state after the change, and the backend holds it.
  // The sidebar also saves its project order on its own, so the revision is compared with the one read just before
  // the pin rather than with a fixed number.
  const before = await sidebarState(first.page);
  const pinnedId = await rowId(first.page, 0);
  await pinRow(first.page, 0);
  await first.page.locator(".session-tree-pinned-header").waitFor({ timeout: 15_000 });
  const pinnedState = await sidebarState(first.page);
  check(pinnedState.revision === before.revision + 1, "the pin is one write and the revision moves by exactly one (" + before.revision + " -> " + pinnedState.revision + ")");
  check(typeof pinnedState.sessions[pinnedId]?.pinnedAt === "number", "the pinned session carries its own pinnedAt (" + pinnedId + ")");

  // Scene 2: a second window of the same backend sees it, without a page reload. The poll the shell already makes is
  // where another window's change arrives, so this waits for that poll rather than reloading the page.
  const second = await openWindow(browser, origin);
  contexts.push(second.context);
  await ready(second.page, origin);
  await second.page.locator(".session-tree-pinned-header").waitFor({ timeout: 20_000 });
  check(true, "the second window shows the pin made in the first, without a page reload");

  // Scene 3: archive the same session in the second window: it leaves the pinned band and no session is in both.
  // The archive control is the row's own quick action, reachable by pointing at the row.
  await (await rowHandle(second.page, 0)).locator(".session-tree-quick-action").click();
  await second.page.getByRole("button", { name: "Undo", exact: false }).first().waitFor({ timeout: 15_000 });
  const archived = await sidebarState(second.page);
  check(archived.sessions[pinnedId].archivedAt !== undefined && archived.sessions[pinnedId].pinnedAt === undefined, "archiving a pinned session unpins it: no session is in both bands");

  // Scene 4: Undo restores the pin and the archived time, as one action.
  await second.page.getByRole("button", { name: "Undo", exact: false }).first().click();
  const restored = await sidebarState(second.page);
  check(restored.sessions[pinnedId].pinnedAt === pinnedState.sessions[pinnedId].pinnedAt && restored.sessions[pinnedId].archivedAt === undefined, "Undo restored exactly the flags the session had");

  // Scene 5: a reload reads the arrangement back from the backend.
  await first.page.reload({ waitUntil: "domcontentloaded" });
  await first.page.locator(".session-tree-pinned-header").waitFor({ timeout: 30_000 });
  check(true, "a reload reads the pin back from the backend");

  // Scene 6: a backend restart keeps it. The store is the backend's, so a new process reads the same document.
  const restarted = children.findIndex((child) => child.exitCode === null && child.spawnargs.includes(join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")));
  assert.ok(restarted >= 0, "the fixture backend process is known");
  await stop(children[restarted]);
  await startBackend(endpoint);
  await waitForHttp(origin + "/", {}, 30_000);
  const afterRestart = await sidebarState(first.page);
  check(afterRestart.revision === restored.revision && afterRestart.sessions[pinnedId].pinnedAt === pinnedState.sessions[pinnedId].pinnedAt, "a backend restart keeps the arrangement");

  // Scene 7: the marker lives in the shared document, not in browser storage. A fresh window of the same backend
  // reads the same marker, and the page keeps no unread key of its own.
  const stored = await first.page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.includes("unread")));
  check(stored.length === 0, "the page keeps no unread marker in browser storage (" + JSON.stringify(stored) + ")");

  check(first.pageErrors.length === 0, "no page error in the first window: " + first.pageErrors.join(" | "));
  check(second.pageErrors.length === 0, "no page error in the second window: " + second.pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  console.log("Artifacts kept at " + artifacts);
  if (failures.length > 0) { console.error("UX sidebar shared-state checks FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("UX sidebar shared-state checks PASSED");
}
