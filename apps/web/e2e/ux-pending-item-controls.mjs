/**
 * Ticket 09 regression: the user's stop, the late reports it holds, and the per-item decision before the model reads.
 *
 * Real production paths only: the production Next build, the real backend process over a real SQLite store, a real local
 * execution host with a real agent definition, the real subagent extension with its real anchor and reporter tasks, and
 * the browser driving the composer a person drives. One controlled OpenAI-completions endpoint stands in for the paid
 * provider and records every request, so the assertion that matters is the one the ticket makes: the parent model's next
 * request carries the text the user kept and nothing they cancelled.
 *
 * The journey:
 *   1. the user delegates two tasks in one turn, so the parent is running while two children work;
 *   2. the user presses Stop: the composer's Stop is the trusted user stop, which holds admission without cancelling the
 *      children or their reporters;
 *   3. both children finish and both reports arrive **late**, so both are queued, editable items under the hold, and the
 *      parent model has been asked nothing since;
 *   4. the user edits one item and cancels the other, and neither decision lifts the hold;
 *   5. the user presses Continue: the kept, edited text is what the parent model reads, and the cancelled text is
 *      nowhere — not in the request and not in the transcript.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-pending-item-controls.mjs [--keep]
 *        HEPI_UX09_WEB_PORT=<port> HEPI_UX09_BACKEND_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-pending-items-token";
const model = "controlled-1";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux09-"));
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

function freePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = probeServer();
    probe.on("error", reject);
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
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
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

const childEnv = (home, extra) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra });

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
  await Promise.race([once(child, "exit"), delay(5_000)]);
}

/**
 * One controlled OpenAI-completions endpoint that records every request and answers from the transcript it is given.
 *
 * The three answers are chosen by the transcript, never by a fixed queue, so the parent, its post-tool round and the two
 * children cannot consume each other's script. The two held answers are what make this a real ordering: the children
 * cannot finish until the driver says so, so the stop really lands while they are working and both reports really are
 * late arrivals.
 */
function controlledEndpoint() {
  const requests = [];
  const startedAt = Date.now();
  let released = false;
  const waiters = [];
  const release = () => { released = true; for (const resolve of waiters.splice(0)) resolve(); };
  const hold = () => released ? Promise.resolve() : new Promise((resolve) => { waiters.push(resolve); });
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/release") { release(); response.writeHead(200).end("{}"); return; }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = JSON.stringify(body.messages ?? []);
      requests.push({ at: Date.now() - startedAt, text, body, messages: body.messages ?? [] });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      const base = { id: "chatcmpl-ux09", object: "chat.completion.chunk", created: 1, model };
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const answer = async () => {
        if (text.includes("child work one") || text.includes("child work two")) {
          await hold();
          return { delta: { role: "assistant", content: "late answer for " + (text.includes("child work one") ? "one" : "two") }, finish_reason: "stop" };
        }
        if (text.includes("delegate two things")) {
          return { tool_calls: [
            { index: 0, id: "call-one", type: "function", function: { name: "agent_spawn", arguments: JSON.stringify({ name: "worker", task: "child work one" }) } },
            { index: 1, id: "call-two", type: "function", function: { name: "agent_spawn", arguments: JSON.stringify({ name: "worker", task: "child work two" }) } },
          ] };
        }
        // The parent's post-tool round: held until the driver releases, so the parent is genuinely running when Stop is
        // pressed, and the stop really marks a live ordinary task for abort.
        await hold();
        return { delta: { role: "assistant", content: "parent finished its own turn" }, finish_reason: "stop" };
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      void answer().then((choice) => {
        if (choice.tool_calls !== undefined) {
          response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: choice.tool_calls }, finish_reason: null }] }));
          response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }));
        } else {
          response.write(frame({ ...base, choices: [{ index: 0, delta: choice.delta, finish_reason: null }] }));
          response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
        }
        response.end("data: [DONE]\n\n");
      });
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({
        origin: "http://127.0.0.1:" + address.port,
        requests,
        release: async () => { await fetch("http://127.0.0.1:" + address.port + "/release", { method: "POST" }); },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

const backendPort = await freePort(Number(process.env.HEPI_UX09_BACKEND_PORT ?? 0));
const backendOrigin = "http://127.0.0.1:" + backendPort;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
let endpoint;
let backend;
function startBackend() {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "pending-items-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      HEPI_UX09_FIXTURE: join(artifacts, "fixture"),
      HEPI_UX09_DB: join(dataDir, "items.sqlite"),
      HEPI_UX09_BACKEND_PORT: String(backendPort),
      HEPI_UX09_AUTH: token,
      HEPI_UX09_MODEL: model,
      HEPI_UX09_ENDPOINT: endpoint.origin,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log };
}

let browser;
let web;
let webOrigin;
let page;
let cookie;

async function signIn(view) {
  const password = view.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await view.locator('button[type="submit"]').click();
  }
  await view.locator("textarea").first().waitFor({ timeout: 60_000 });
}

/** Poll a real condition on the browser's own view of the queue. */
async function waitForItem(view, predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = view.locator("[data-queued-item]");
    const count = await rows.count();
    const texts = [];
    for (let index = 0; index < count; index += 1) texts.push(await rows.nth(index).innerText());
    if (predicate(texts)) return texts;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description + "; rows: " + JSON.stringify(texts));
    await delay(150);
  }
}

const composerText = (view) => view.locator("textarea").first();

/**
 * A child's own model request, told apart from the parent's by its shape and not by its text: a child is dispatched
 * with its own instructions, so its request is one system message and one user message. The parent's post-tool request
 * quotes the children's tasks back in its tool results, so a search for the task text alone would match the parent too.
 */
const isChildRequest = (entry) => entry.messages.length === 2 && entry.messages[0].role === "system";

try {
  endpoint = await controlledEndpoint();
  backend = startBackend();
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-800));
  const catalog = await (await fetch(backendOrigin + "/api/conversations", { headers })).json();
  const bound = catalog.conversations.find((item) => item.workspaceId === "local");
  assert.ok(bound !== undefined, "the fixture exposed a workspace-bound conversation");
  const sessionId = bound.id;

  const webPort = await freePort(Number(process.env.HEPI_UX09_WEB_PORT ?? 0));
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backendOrigin,
      HEPI_AUTH_TOKEN: token,
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-800));

  const login = await fetch(webOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200, "the browser session authenticated");
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);

  // --- 1. Delegate two tasks in one turn, so the parent is running while two children work. -----------------------
  const parentRequestsBefore = endpoint.requests.length;
  await composerText(page).fill("delegate two things");
  await composerText(page).press("Enter");
  const childRequests = await (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const seen = endpoint.requests.filter(isChildRequest);
      if (seen.length === 2) return seen;
      if (Date.now() > deadline) throw new Error("the two children were never asked; requests: " + JSON.stringify(endpoint.requests.map((entry) => entry.at)) + " :: " + JSON.stringify(endpoint.requests.map((entry) => ({ keys: Object.keys(entry.body), messages: entry.messages.map((message) => [message.role, typeof message.content === "string" ? message.content.slice(0, 60) : JSON.stringify(message.content ?? "").slice(0, 60)]) }))));
      await delay(150);
    }
  })();
  check(childRequests.length === 2, "two real children were delegated and both asked their own model");
  // The parent is genuinely running: the stop control is on screen because a run is in flight.
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await stopButton.waitFor({ timeout: 30_000 });
  check(await stopButton.isVisible(), "the Stop control is offered while the parent is running");

  // --- 2. The user's stop: admission is held, and neither child nor its reporter is cancelled. --------------------
  const requestsBeforeStop = endpoint.requests.length;
  await stopButton.click();
  await page.locator("[data-held-banner]").waitFor({ timeout: 30_000 });
  check(true, "the composer states the hold after the user's own stop");
  check((await page.locator("[data-continue]").count()) === 1, "the explicit Continue control is offered while held");

  // --- 3. Both children finish late, and both reports queue under the hold. --------------------------------------
  await endpoint.release();
  const rows = await waitForItem(page, (texts) => texts.length === 2, "two queued items");
  check(rows.length === 2, "both late reports are visible as queued items: " + JSON.stringify(rows.map((text) => text.split("\n")[0])));
  check(rows.every((text) => text.includes("Report")), "each item states that it came from a delegated child");
  check(rows.every((text) => text.includes("late answer for")), "each item carries the child's own answer text");
  // The hold did its job: the reports arrived and the parent model was asked nothing since the stop.
  const afterStop = endpoint.requests.slice(requestsBeforeStop).filter((entry) => !isChildRequest(entry));
  check(afterStop.length === 0, "a held recipient woke no model at all: " + JSON.stringify(afterStop.map((entry) => entry.text.slice(0, 60))));
  const controlHeld = await (await fetch(backendOrigin + "/api/conversations/" + sessionId + "/control", { headers })).json();
  check(controlHeld.control.state === "held", "the backend's own control record is still held");

  // --- 4. One item is edited and the other cancelled, and neither decision lifts the hold. -----------------------
  const firstRow = page.locator("[data-queued-item]").first();
  const secondRow = page.locator("[data-queued-item]").nth(1);
  const cancelledText = await secondRow.innerText();
  await firstRow.getByRole("button", { name: "Edit", exact: true }).click();
  const editBox = firstRow.locator("textarea");
  await editBox.fill("the user's own edited decision");
  await firstRow.getByRole("button", { name: "Save", exact: true }).click();
  const edited = await waitForItem(page, (texts) => texts.some((text) => text.includes("the user's own edited decision")), "the edited item");
  check(edited.some((text) => text.includes("the user's own edited decision")), "the edited text is what the queue now shows");

  await secondRow.getByRole("button", { name: "Cancel", exact: true }).click();
  const remaining = await waitForItem(page, (texts) => texts.length === 1, "the cancelled item to leave the queue");
  check(remaining.length === 1, "the cancelled item left the queue and the edited one stayed");
  const afterDecisions = await (await fetch(backendOrigin + "/api/conversations/" + sessionId + "/control", { headers })).json();
  check(afterDecisions.control.state === "held", "neither an edit nor a cancel lifted the hold");
  check(afterDecisions.control.revision === controlHeld.control.revision, "and neither moved the control revision");

  // --- 4b. A browser reconnect keeps the decisions: the queue a reloaded page reads is the same one. -------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await signIn(page);
  const reconnected = await waitForItem(page, (texts) => texts.length === 1, "the surviving item after a reload");
  check(reconnected.length === 1 && reconnected[0].includes("the user's own edited decision"), "a reloaded page reads the edited item back from the backend");
  await page.locator("[data-held-banner]").waitFor({ timeout: 30_000 });
  check(true, "and reads the hold it left, so the user is not shown a queue that looks runnable");
  check((await page.locator("[data-continue]").count()) === 1, "with the Continue control still offered");

  // --- 5. The user's Continue: the model reads the kept text and nothing they cancelled. -------------------------
  const requestsBeforeContinue = endpoint.requests.length;
  await page.locator("[data-continue]").click();
  await page.locator("[data-held-banner]").waitFor({ state: "detached", timeout: 60_000 });
  check(true, "the held banner leaves once the user's own continue ends the hold");
  const afterContinue = await (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const seen = endpoint.requests.slice(requestsBeforeContinue).filter((entry) => entry.text.includes("the user's own edited decision"));
      if (seen.length > 0) return seen;
      if (Date.now() > deadline) throw new Error("the parent model was never asked with the kept text; requests: " + JSON.stringify(endpoint.requests.slice(requestsBeforeContinue).map((entry) => entry.text.slice(0, 200))));
      await delay(150);
    }
  })();
  check(afterContinue.length > 0, "the parent model's next request carries the edited text the user kept");
  check(afterContinue.every((entry) => !entry.text.includes("late answer for")), "and the request does not carry the child's original preview text");
  const state = await (await fetch(backendOrigin + "/api/conversations/" + sessionId + "/state", { headers })).json();
  check(state.queuedItems.length === 0, "the held queue was consumed by the continue");
  check(JSON.stringify(state.entries).includes("the user's own edited decision"), "the kept text reached the transcript");
  // The cancelled item's own text never reached the model: the row was cancelled before the continue, and its report
  // text is not in the request the model was finally asked with.
  const cancelledLine = cancelledText.split("\n").find((line) => line.includes("late answer for")) ?? "";
  const cancelledBody = cancelledLine.trim();
  check(cancelledBody.length > 0, "the cancelled item's own text was read from the row before it was withdrawn");
  check(!afterContinue.some((entry) => entry.text.includes(cancelledBody)), "the cancelled text is nowhere in the request the model read: " + cancelledBody.slice(0, 80));
  check(!JSON.stringify(state.entries).includes(cancelledBody), "and nowhere in the transcript");
  check(pageErrors.length === 0, "no page error: " + pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint?.close().catch(() => {});
  if (failures.length > 0) { console.error("UX-09 pending item controls checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  if (keep) console.log("Artifacts kept at " + artifacts);
  else rmSync(artifacts, { recursive: true, force: true });
  console.log("UX-09 pending item controls checks PASSED");
}
