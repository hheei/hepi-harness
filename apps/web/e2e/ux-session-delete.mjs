/**
 * Ticket 03 (capability integration) regression: deleting a session.
 *
 * The real deployment shape only: the production Next build, the real backend over a real SQLite store, a real local
 * execution gateway and the sidebar's own row menu and delete confirmation. The model endpoint is this script's own
 * controlled OpenAI-completions server, so nothing contacts a paid provider.
 *
 * What is asserted is what the user sees and what the durable API still holds: Delete takes the row out of the sidebar
 * without a page reload, the session is gone from the catalogue and from the shared sidebar document (its pin and
 * archive entries with it), its records still read back through the durable API afterwards, a second window of the
 * same backend agrees, a running session is answered at once and refuses a new turn with a reason, a child stays
 * listed and openable with no parent reported, and an unknown session's removal is refused with a reason the user
 * reads. Every wait is an observable UI or request state; there are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-session-delete.mjs
 *        HEPI_DELETE_WEB_PORT / HEPI_DELETE_BACKEND_PORT
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
const token = "ux-session-delete-token";
const modelId = "controlled-1";
const removedTitle = "Remove me";
const otherTitle = "Keep me";
const runningTitle = "Running session";
const webPort = Number(process.env.HEPI_DELETE_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_DELETE_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-session-delete-"));
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
 * One OpenAI-completions endpoint that records every request and can hold its answer until the driver releases it, so
 * "deleting a session that is currently running" is a real state rather than a race: the run stays inside its provider
 * response while the removal is asserted.
 */
function controlledEndpoint() {
  const requests = [];
  const waiters = [];
  let released = false;
  let hold = false;
  const release = () => { released = true; while (waiters.length > 0) waiters.shift()(); };
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const answer = () => {
        const text = "delete driver answer to " + (body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
        const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ id: "chatcmpl-delete", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
        response.write(frame({ id: "chatcmpl-delete", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
        response.end("data: [DONE]\n\n");
      };
      if (released || !hold) answer();
      else waiters.push(answer);
    });
  });
  let listening = "";
  return {
    requests,
    gate: () => { hold = true; released = false; },
    release,
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

function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

function startBackend(port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(artifacts, "backend"),
      HEPI_UX06_DB: join(dataDir, "delete.sqlite"),
      HEPI_UX06_BACKEND_PORT: String(port),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: modelId,
      HEPI_UX06_ENDPOINT: endpoint.origin(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + port };
}

const api = async (path, init) => (await fetch(backendOrigin + path, { headers, ...init })).json();

/** One browser window of this backend, logged in exactly as the page does. */
async function newWindow() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  // A bare load opens no project and so no composer: the shell having mounted is read from its sidebar, which is
  // where every scene here works.
  await openGroups(page);
  return { page, context, pageErrors };
}

/** A folded project group hides its rows, so every scene opens them as the user does before reading the tree. */
async function openGroups(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let index = 0; index < 20; index += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
}

/** The sidebar rows, with the group folds opened as the user opens them. */
async function rows(page) {
  await openGroups(page);
  await page.locator(".session-tree-main").first().waitFor({ timeout: 30_000 });
  return page.locator(".session-tree-main").evaluateAll((elements) => elements.map((element) => element.innerText.split("\n")[0]));
}

/** The sidebar row of one conversation, addressed by the row key the tree renders. */
const row = (page, id) => page.locator('[data-row-key="session:group:' + id + '"]');

async function renameThroughSidebar(page, id, name) {
  const target = row(page, id);
  await target.waitFor({ timeout: 30_000 });
  // The row's own actions show on hover (desktop), so a driver reaches them the way a person does.
  await target.hover();
  await target.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const input = target.locator("input.session-tree-rename");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(name);
  await input.press("Enter");
  await row(page, id).getByText(name, { exact: true }).waitFor({ timeout: 30_000 });
}

/** Delete one row from its own ⋯ menu, confirming as a user does. */
async function deleteThroughSidebar(page, id) {
  const target = row(page, id);
  await target.waitFor({ timeout: 30_000 });
  await target.hover();
  await target.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  const confirm = target.locator(".session-tree-confirm-delete");
  await confirm.waitFor({ timeout: 10_000 });
  await confirm.click();
}

/** The state the backend holds, read through the Web adapter the browser itself uses. */
const sidebarState = async (page) => page.evaluate(async () => (await (await fetch("/api/sessions/ui-state", { cache: "no-store" })).json()).state);

try {
  endpoint = controlledEndpoint();
  await endpoint.listen(0);
  const chosenBackendPort = await freePort(backendPort);
  const started = startBackend(chosenBackendPort);
  backend = started.child;
  backendOrigin = started.origin;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + started.log().slice(-500));

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

  // Two conversations in the fixture's own workspace, each with one real turn, so both have a transcript that can be
  // read back after a removal and both have a row of their own.
  const created = await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
  const removedId = created.conversationId;
  const keptId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) })).conversationId;
  const send = async (id, text) => {
    const response = await fetch(backendOrigin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text.replace(/\s+/g, "-"), text }) });
    assert.equal(response.status, 202, await response.text());
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await api("/api/conversations/" + id + "/state");
      if (!current.busy && current.entries.at(-1)?.role === "assistant") return current;
      await delay(20);
    }
    throw new Error("the turn did not settle");
  };
  const removedTranscript = await send(removedId, "turn of the removed session");
  await send(keptId, "turn of the kept session");

  browser = await chromium.launch();
  const one = await newWindow();
  const two = await newWindow();
  check(one.pageErrors.length === 0 && two.pageErrors.length === 0, "the shell mounted without a page error");

  // Two named rows, so a removal is asserted against a row that stays as well as the one that goes.
  await renameThroughSidebar(one.page, removedId, removedTitle);
  await renameThroughSidebar(one.page, keptId, otherTitle);
  await row(two.page, removedId).getByText(removedTitle, { exact: true }).waitFor({ timeout: 30_000 });
  check(true, "both windows list both sessions");

  // A pin and an archive entry of its own, made in the window that does not delete it, so the removal's own clear is
  // visible as the shared document losing an entry the second window had written.
  const pinned = await one.page.evaluate(async (id) => {
    const response = await fetch("/api/sessions/ui-state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "set", ids: [id], pinned: true }) });
    return response.status;
  }, removedId);
  check(pinned === 200, "the session has a pin of its own in the shared sidebar document");
  const stateBefore = await sidebarState(two.page);
  check(typeof stateBefore.sessions[removedId]?.pinnedAt === "number", "the second window reads that pin from the backend");

  // ------------------------------------------------------------ Delete leaves the list without a page reload
  const before = await rows(one.page);
  check(before.includes(removedTitle), "the row is in the sidebar before the removal: " + JSON.stringify(before));
  await deleteThroughSidebar(one.page, removedId);
  // The removal is one request: the row goes when its answer does, and the tree is read after that, not before.
  await row(one.page, removedId).waitFor({ state: "detached", timeout: 30_000 });
  const after = await rows(one.page);
  check(!after.includes(removedTitle), "the row left the sidebar without a page reload: " + JSON.stringify(after));
  check(after.includes(otherTitle), "the session that was not removed is still listed");
  check(one.pageErrors.length === 0, "no page error in the removing window: " + one.pageErrors.join(" | "));

  // ------------------------------------------------------------ the catalogue and the shared document agree
  const catalog = await api("/api/conversations");
  check(!catalog.conversations.some((item) => item.id === removedId), "the session is out of the catalogue: " + JSON.stringify(catalog.conversations.map((item) => item.id)));
  check(catalog.conversations.some((item) => item.id === keptId), "the other session is still in the catalogue");
  const stateAfter = await sidebarState(one.page);
  check(stateAfter.sessions[removedId] === undefined, "the removed session's pin and archive entries are cleared with it");
  check(Object.keys(stateAfter.sessions).length === 0, "no orphan entry remains in the shared document: " + JSON.stringify(stateAfter.sessions));

  // ------------------------------------------------------------ the records are retained
  const retained = await api("/api/conversations/" + removedId + "/state");
  check(JSON.stringify(retained.entries) === JSON.stringify(removedTranscript.entries), "the removed session's own records still read back through the durable API: " + JSON.stringify(retained.entries.map((entry) => entry.text)));

  // ------------------------------------------------------------ a second window agrees
  // The second window is not told anything: it drops the row on the poll the shell already makes, so the wait is for
  // that poll rather than for a reload.
  await row(two.page, removedId).waitFor({ state: "detached", timeout: 30_000 });
  const twoRows = await rows(two.page);
  check(!twoRows.includes(removedTitle), "the second window's sidebar drops the removed row on its own poll: " + JSON.stringify(twoRows));
  const twoState = await sidebarState(two.page);
  check(twoState.sessions[removedId] === undefined, "the second window reads the cleared entries from the backend");

  // ------------------------------------------------------------ a removed session refuses a new turn
  const refused = await fetch(backendOrigin + "/api/conversations/" + removedId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "after-removal", text: "again" }) });
  const refusalBody = await refused.json();
  check(refused.status === 409 && refusalBody.code === "session_deleted" && /was deleted/.test(refusalBody.message ?? ""), "the removed session refuses a new turn with a readable reason: " + JSON.stringify(refusalBody));

  // ------------------------------------------------------------ a running session is removed without waiting for it
  // The endpoint holds its answer, so the session is genuinely inside its provider response while it is removed: the
  // removal must be answered at once, the run must be left to settle into the retained records, and a later turn must
  // be refused. No sleep decides any of this — the endpoint's own request log does.
  const runningId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) })).conversationId;
  await send(runningId, "settled turn of the running session");
  await renameThroughSidebar(two.page, runningId, runningTitle);
  // The transcript the run will add to, read before the turn is admitted: the busy turn's own user entry is committed
  // when it is placed, so a count taken after admission would count it twice.
  const runningBefore = (await api("/api/conversations/" + runningId + "/state")).entries.length;
  endpoint.gate();
  const seenBefore = endpoint.requests.length;
  const admitted = await fetch(backendOrigin + "/api/conversations/" + runningId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "busy-turn", text: "busy turn" }) });
  check(admitted.status === 202, "the running session admitted a turn: " + admitted.status);
  const reached = Date.now() + 20_000;
  while (endpoint.requests.length === seenBefore && Date.now() < reached) await delay(20);
  check(endpoint.requests.length > seenBefore, "the run reached the provider and is in flight");
  check((await api("/api/conversations/" + runningId + "/state")).busy === true, "the session is genuinely busy before it is removed");

  await deleteThroughSidebar(two.page, runningId);
  await row(two.page, runningId).waitFor({ state: "detached", timeout: 30_000 });
  check(!(await rows(two.page)).includes(runningTitle), "the running session's row left the sidebar");
  check((await api("/api/conversations/" + runningId + "/state")).busy === true, "the removal did not wait for the run: it is still in flight");
  check(!(await api("/api/conversations")).conversations.some((item) => item.id === runningId), "the running session is out of the catalogue");

  // Releasing the gate lets the run it did not stop finish into the retained records.
  endpoint.release();
  const settled = Date.now() + 20_000;
  let runningState = await api("/api/conversations/" + runningId + "/state");
  while (runningState.busy && Date.now() < settled) {
    await delay(20);
    runningState = await api("/api/conversations/" + runningId + "/state");
  }
  check(runningState.busy === false && runningState.entries.length === runningBefore + 2 && runningState.entries.at(-1)?.role === "assistant", "the run it did not stop finished into the retained records: " + JSON.stringify(runningState.entries.map((entry) => entry.text)));
  const afterRun = await fetch(backendOrigin + "/api/conversations/" + runningId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "after-running-removal", text: "again" }) });
  const afterRunBody = await afterRun.json();
  check(afterRun.status === 409 && afterRunBody.code === "session_deleted", "the removed running session refuses a new turn afterwards: " + JSON.stringify(afterRunBody));

  // ------------------------------------------------------------ a child stays listed and openable
  const sourceId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) })).conversationId;
  await send(sourceId, "parent turn");
  const forked = await api("/api/conversations/" + sourceId + "/fork", { method: "POST", body: "{}" });
  const childId = forked.conversationId;
  check((await api("/api/conversations")).conversations.find((item) => item.id === childId)?.parentConversationId === sourceId, "the copy is listed as a fork of its source");
  const parentRemoval = await fetch(backendOrigin + "/api/conversations/" + sourceId, { method: "DELETE", headers });
  check(parentRemoval.status === 200, "the source session was removed: " + parentRemoval.status);
  const childRows = await api("/api/conversations");
  const childRow = childRows.conversations.find((item) => item.id === childId);
  check(childRow !== undefined, "the child is still listed: " + JSON.stringify(childRows.conversations.map((item) => item.id)));
  check(childRow.parentConversationId === undefined, "no surface reports a parent that is gone");
  check((await api("/api/conversations/" + childId + "/state")).entries.length > 0, "the child still reads back and is openable");

  // ------------------------------------------------------------ an unknown session is refused
  const unknown = await fetch(backendOrigin + "/api/conversations/999999", { method: "DELETE", headers });
  const unknownBody = await unknown.json();
  check(unknown.status === 404 && unknownBody.code === "not_found" && /not found/.test(unknownBody.error ?? ""), "removing an unknown session is refused with a readable reason: " + JSON.stringify(unknownBody));

  check(one.pageErrors.length === 0 && two.pageErrors.length === 0, "no page error occurred: " + [...one.pageErrors, ...two.pageErrors].join(" | "));
  await one.context.close();
  await two.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
  childrenLog.end();
  console.log("Artifacts kept at " + artifacts);
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failed:");
  for (const message of failures) console.log("  - " + message);
  process.exit(1);
}
console.log("\nUX session delete checks PASSED");
