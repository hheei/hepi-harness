/**
 * Ticket 12's production browser journey: the user defines an agent in Settings, delegates from the main conversation's
 * own composer, opens the child, watches it finish, gives it one more task, turns the capability off, and reads the
 * child's history back.
 *
 * The real deployment shape only: the production Next build, the real backend process over a real SQLite store, a real
 * local execution host whose workspace is a temporary directory, the real subagent extension with its real anchor and
 * reporter tasks, and this script's own controlled OpenAI-completions endpoint. Nothing here is a DOM-only check: the
 * assertions read the backend's own records — the definition file the host really wrote, the child's own relations and
 * its projected status, the native owner edge, the committed control — beside what the screen shows.
 *
 * The negative journeys are driven for real too: the fifth delegation is refused by the concurrency bound while four
 * children are genuinely at work, and the definition panel is opened after the execution host has been taken away, so
 * an unreachable host is the host's own failure rather than a stubbed response.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-subagent-delegate.mjs [--keep]
 *        HEPI_UX12_WEB_PORT / HEPI_UX12_BACKEND_PORT / HEPI_UX12_CONTROL_PORT
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-subagent-delegate-token";
const model = "controlled-1";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux12-"));
const dataDir = join(artifacts, "data");
const fixtureRoot = join(artifacts, "fixture");
const backendHome = join(artifacts, "backend-home");
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

/** Every child role runs from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
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
}

/**
 * The controlled OpenAI-completions endpoint: every request is answered, so a turn the driver sends really settles.
 *
 * The parent and each child are told apart by the transcript they are answered from, never by a fixed queue, so a child
 * working while the parent runs cannot consume the parent's answer. A task whose text names the word "hold" is held
 * until the driver releases it, which is what makes "four children are genuinely at work" a real ordering rather than a
 * timing guess.
 */
function controlledEndpoint() {
  const requests = [];
  let released = false;
  const waiters = [];
  const release = () => { released = true; for (const resolveWaiter of waiters.splice(0)) resolveWaiter(); };
  const hold = () => released ? Promise.resolve() : new Promise((resolveWaiter) => { waiters.push(resolveWaiter); });
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/release") { release(); response.writeHead(200).end("{}"); return; }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = body.messages ?? [];
      const text = JSON.stringify(messages);
      const lastUser = messages.filter((message) => message.role === "user").at(-1)?.content;
      const prompt = typeof lastUser === "string" ? lastUser : JSON.stringify(lastUser ?? "");
      requests.push({ at: Date.now(), text, prompt, messages });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      const base = { id: "chatcmpl-ux12", object: "chat.completion.chunk", created: 1, model };
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const answer = async () => {
        // A child is dispatched with its own instructions, so its request is one system message and one user message;
        // the parent's request quotes the children's tasks back inside its tool results, so the shape — not the text —
        // is what tells them apart. A child is answered from its own task, whatever the instructions added around it.
        const isChild = messages.length === 2 && messages[0]?.role === "system";
        if (isChild) {
          const task = prompt.trim();
          if (task.includes("hold ")) { await hold(); return { content: "held answer for " + task }; }
          if (task.includes("first child task")) return { content: "first child answer" };
          if (task.includes("second child task")) return { content: "second child answer" };
          if (task.includes("an ordinary child message")) return { content: "ordinary child answer" };
          return { content: "child idle" };
        }
        return { content: "parent idle" };
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      void answer().then((choice) => {
        response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: choice.content }, finish_reason: null }] }));
        response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
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

const backendPort = await freePort(Number(process.env.HEPI_UX12_BACKEND_PORT ?? 0));
const controlPort = await freePort(Number(process.env.HEPI_UX12_CONTROL_PORT ?? 0));
const backendOrigin = "http://127.0.0.1:" + backendPort;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

let endpoint;
let browser;
let web;
let page;
let cookie;
let webOrigin;
let sessionId;

const backend = (path, init) => fetch(backendOrigin + path, { headers, ...init });
const backendJson = async (path, init) => (await backend(path, init)).json();
/**
 * One request to the Web origin as the browser makes it: the session cookie, and the origin/host the same-origin check
 * reads. A request without them is refused by the origin guard, which is not a statement about delegation.
 */
const webRequest = (path, init = {}) => fetch(webOrigin + path, { ...init, headers: { ...headers, cookie, origin: webOrigin, host: new URL(webOrigin).host, ...(init.headers ?? {}) } });
const webApi = async (path, init) => (await webRequest("/api" + path, init)).json();
/** One conversation's catalogue row, read the way the sidebar reads it. */
const rowOf = async (id) => (await backendJson("/api/conversations")).conversations.find((row) => row.id === id);
const childrenOf = async (id) => (await backendJson("/api/conversations?createdBy=" + id)).conversations;
const infoOf = async (id) => backendJson("/api/conversations/" + id);
const stateOf = async (id) => backendJson("/api/conversations/" + id + "/state");

async function signIn(view) {
  const password = view.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await view.locator('button[type="submit"]').click();
  }
  await view.locator("textarea").first().waitFor({ timeout: 60_000 });
}

/** Poll a real read until it holds, so a run is asserted on its own effect rather than on a timing guess. */
async function eventually(read, accept, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description + "; last " + JSON.stringify(value));
    await delay(200);
  }
}

/** Open the Settings panel's Agents section the way a person opens it. */
async function openAgentsSettings(view) {
  await view.getByRole("button", { name: "Settings", exact: true }).first().click();
  await view.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Agents", exact: true }).click();
  await view.getByRole("button", { name: "New definition", exact: true }).waitFor({ timeout: 30_000 });
}
const closeSettings = async (view) => {
  await view.getByRole("button", { name: "Close", exact: true }).first().click();
  await view.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
};

/** The quick delegate panel, opened from the toolbar control the user clicks. */
async function openDelegatePanel(view) {
  await view.locator("[data-delegate-entry]").click();
  await view.locator("[data-delegate-definition]").waitFor({ timeout: 30_000 });
}

try {
  endpoint = await controlledEndpoint();
  const backendChild = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "subagent-delegate-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(backendHome, {
      HEPI_UX12_FIXTURE: fixtureRoot,
      HEPI_UX12_DB: join(dataDir, "delegate.sqlite"),
      HEPI_UX12_BACKEND_PORT: String(backendPort),
      HEPI_UX12_CONTROL_PORT: String(controlPort),
      HEPI_UX12_AUTH: token,
      HEPI_UX12_MODEL: model,
      HEPI_UX12_ENDPOINT: endpoint.origin,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backendChild);
  const backendLog = capture(backendChild);
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 90_000), "the backend started: " + backendLog().slice(-800));
  const seed = backendLog().match(/HEPI_UX12_SEED (\{.*\})/);
  assert.ok(seed !== undefined, "the fixture stated the conversation it seeded: " + backendLog().slice(-800));
  sessionId = JSON.parse(seed[1]).sessionId;

  const webPort = await freePort(Number(process.env.HEPI_UX12_WEB_PORT ?? 0));
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
  assert.ok(await waitForHttp(webOrigin + "/", {}, 90_000), "the Web UI started: " + webLog().slice(-800));

  const login = await fetch(webOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200, "the browser session authenticated");
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // Every event-stream request this page makes, so "no per-row stream" is a measured fact rather than a promise.
  const eventRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/events")) eventRequests.push(url);
  });
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);

  // --- 1. The user defines the agent in Settings, through the same document interface the quick create reads. -----
  // The host's own account directory, which the gateway process resolves from the home the fixture gave it.
  const definitionPath = join(fixtureRoot, "backend-home", ".pi", "agent", "agents", "quick-worker.md");
  await openAgentsSettings(page);
  await page.getByRole("button", { name: "New definition", exact: true }).click();
  await page.getByRole("group", { name: "Save to" }).getByRole("button", { name: "user", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("quick-worker");
  await page.getByLabel("Description", { exact: true }).fill("Quick worker");
  await page.getByLabel("Instructions", { exact: true }).fill("Answer the task briefly.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(() => Promise.resolve(existsSync(definitionPath)), (value) => value === true, "the definition to reach the host");
  check(existsSync(definitionPath), "the definition the user saved is a real file on the execution host");
  check(/^name: quick-worker$/m.test(readFileSync(definitionPath, "utf8")), "and it carries the name the form gave");
  await closeSettings(page);

  // The quick create offers exactly what Settings saved, read through the same route.
  const listed = await webApi("/agent-definitions?cwd=" + encodeURIComponent("/workspace/local"));
  check(listed.definitions.some((definition) => definition.name === "quick-worker"), "the quick create's own definition list carries the saved definition: " + JSON.stringify(listed.definitions?.map((definition) => definition.name)));
  await openDelegatePanel(page);
  const offered = await page.locator("[data-delegate-definition] option").allTextContents();
  check(offered.some((text) => text.includes("quick-worker")), "the panel offers the saved definition: " + JSON.stringify(offered));
  check(!offered.some((text) => /token|secret|bearer/i.test(text)), "and leaks no credential or internal scheduler detail");

  // --- 2. Delegate from the main conversation, and open the child. ------------------------------------------------
  await page.locator("[data-delegate-definition]").selectOption("quick-worker");
  await page.locator("[data-delegate-task]").fill("first child task");
  await page.locator("[data-delegate-submit]").click();
  const child = await eventually(async () => (await childrenOf(sessionId))[0], (value) => value !== undefined, "the delegation to create a child");
  check(child.createdBy === sessionId && child.displayParentId === sessionId, "the child is a real conversation of this one: " + JSON.stringify({ createdBy: child.createdBy, displayParentId: child.displayParentId }));
  check(child.subagentParentConversationId === sessionId, "and the catalogue states the delegation edge the child tree reads");
  check(child.workspaceId === "local", "the child is bound to the same execution workspace the definition was resolved on");
  // Opening the child is what the panel does with the answer: the same ChatWindow, the child's own native stream.
  const opened = await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, child.id, { timeout: 20_000 }).then(() => true, () => false);
  if (!opened) console.log("  note: the URL is " + page.url() + " and the panel says " + JSON.stringify(await page.locator("[data-delegate-created]").allTextContents()) + " / refusal " + JSON.stringify(await page.locator("[data-delegate-refusal]").allTextContents()));
  check(opened, "the quick create opened the child in the same window: " + page.url());
  await eventually(() => stateOf(child.id), (state) => state?.entries?.some((entry) => entry.role === "assistant" && entry.text === "first child answer"), "the child's own answer");
  check((await stateOf(child.id)).entries.some((entry) => entry.role === "assistant" && entry.text === "first child answer"), "the child really ran and answered in its own conversation");
  const childInfo = await infoOf(child.id);
  check(childInfo.owner?.conversationId === sessionId, "the child is owned by a real task of this conversation: " + JSON.stringify(childInfo.owner));
  // The report comes back: the parent's own transcript carries the child's answer, so a delegation is not fire-and-forget.
  await eventually(() => stateOf(sessionId), (state) => state?.entries?.some((entry) => entry.role === "user" && String(entry.text).startsWith("The delegated child ")), "the report to reach the parent");
  check((await stateOf(sessionId)).entries.some((entry) => entry.role === "user" && String(entry.text).includes("first child answer")), "the child's result reached the parent as its own report");

  // --- 3. The child tree states the child's real status, and the parent's own status is not used for it. ---------
  //
  // The child on screen does not select the delegation capability — a child may not delegate in turn — so the entry is
  // gone here while its history stays, which is the capability rule read from the child's own selection. The tree is
  // opened from the parent, where the child is listed beneath it.
  check((await page.locator("[data-delegate-entry]").count()) === 0, "a child's own view offers no delegate entry, because a child may not delegate");
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await eventually(() => rowOf(child.id), (row) => row?.runStatus?.state === "idle", "the child to settle");
  check((await rowOf(child.id)).runStatus?.state === "idle", "a finished child's own status is idle, read from its own run");
  check((await rowOf(sessionId)).runStatus?.state === "idle", "and the parent's status is its own, not the child's");
  eventRequests.length = 0;
  await page.locator("[data-agent-switcher]").click();
  const treeRows = await eventually(
    async () => (await page.locator("[data-child-session]").allTextContents()),
    (rows) => rows.length === 1,
    "the child tree to list the delegation",
  );
  check(treeRows.length === 1, "the child tree lists the delegation beneath its parent: " + JSON.stringify(treeRows));
  check(treeRows.some((text) => /Idle/i.test(text)), "and states the child's own real status: " + JSON.stringify(treeRows));
  // The row states the host the work really runs on, from the catalogue's own answer, rather than this origin's name.
  const childRow = await rowOf(child.id);
  check(typeof childRow.gatewayId === "string" && childRow.gatewayId !== "", "the catalogue states the child's own execution host: " + JSON.stringify(childRow.gatewayId));
  check(treeRows.some((text) => text.includes(childRow.gatewayId)), "and the tree row shows it: " + JSON.stringify({ rows: treeRows, host: childRow.gatewayId }));
  // No per-row stream. The page streams the conversation it has open and nothing else, so opening the tree must not
  // add a request for any child's own stream: a count that grew with the number of listed children would be exactly
  // the permanent per-catalogue-item SSE the ticket forbids.
  const streamRequestsWhileOpen = eventRequests.filter((url) => url.includes("/" + child.id + "/events"));
  check(streamRequestsWhileOpen.length === 0, "the child tree opened no stream of its own for the child row: " + JSON.stringify(eventRequests));
  // Opening the row is what the tree is for: it selects the child in the same window.
  await page.locator("[data-child-session]").first().click();
  await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, child.id, { timeout: 30_000 });
  check(new URL(page.url()).searchParams.get("session") === child.id, "the tree opened the child in the same ChatWindow");

  // --- 4. Delegate again to the child that already exists, explicitly. ------------------------------------------
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await openDelegatePanel(page);
  const targets = await page.locator("[data-delegate-target] option").allTextContents();
  check(targets.length >= 2, "the panel offers the existing child as an explicit target beside a new one: " + JSON.stringify(targets));
  await page.locator("[data-delegate-definition]").selectOption("quick-worker");
  await page.locator("[data-delegate-target]").selectOption(child.id);
  await page.locator("[data-delegate-task]").fill("second child task");
  await page.locator("[data-delegate-submit]").click();
  await eventually(() => stateOf(child.id), (state) => state?.entries?.filter((entry) => entry.role === "user").length >= 2, "the child's second task");
  const childAfter = await stateOf(child.id);
  check(childAfter.entries.filter((entry) => entry.role === "user").map((entry) => entry.text).join("|").includes("second child task"), "the second task was admitted into the same child");
  check((await childrenOf(sessionId)).length === 1, "delegating again created no second child");
  const childAfterInfo = await infoOf(child.id);
  check(childAfterInfo.owner?.conversationId === sessionId && childAfterInfo.relations?.displayParentId === sessionId, "the child kept its owner and its display parent through the second delegation");
  check(childAfterInfo.owner?.taskId === childInfo.owner?.taskId, "and it did not reuse or replace its own native task");

  // --- 5. A plain message in the child is not a delegation, and registers no report to the parent. ---------------
  const parentUserCount = (await stateOf(sessionId)).entries.filter((entry) => entry.role === "user").length;
  // The reports the parent has already been given, which is what a plain chat must not add to.
  const reportsBefore = (await stateOf(sessionId)).entries.filter((entry) => entry.role === "user" && String(entry.text).startsWith("The delegated child ")).length;
  await page.goto(webOrigin + "/?session=" + child.id, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await page.locator("textarea").first().fill("an ordinary child message");
  await page.locator("textarea").first().press("Enter");
  await eventually(() => stateOf(child.id), (state) => state?.entries?.some((entry) => entry.role === "user" && entry.text === "an ordinary child message"), "the child's own ordinary turn");
  await delay(2000);
  const parentAfterOrdinary = await stateOf(sessionId);
  const reports = parentAfterOrdinary.entries.filter((entry) => entry.role === "user" && String(entry.text).startsWith("The delegated child "));
  check(reports.length === reportsBefore, "a plain chat in the child registered no new report to the parent: " + JSON.stringify({ before: reportsBefore, after: reports.length, texts: reports.map((entry) => entry.text.slice(0, 60)) }));
  check(parentAfterOrdinary.entries.filter((entry) => entry.role === "user").length === parentUserCount, "and the parent's own transcript is unchanged");

  // --- 6. Turning the capability off removes the entry, and the child's history and control stay. ---------------
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await page.locator("[data-delegate-entry]").waitFor({ timeout: 30_000 });
  const off = await webRequest("/api/sessions/" + sessionId + "/extensions", { method: "PATCH", body: JSON.stringify({ extensions: ["coding-tools"] }) });
  check(off.status === 200, "the capability was turned off for the conversation: " + off.status + " " + await off.text());
  await page.reload({ waitUntil: "domcontentloaded" });
  await signIn(page);
  await delay(1000);
  check((await page.locator("[data-delegate-entry]").count()) === 0, "the delegate entry is gone once the capability is off");
  const childStill = await infoOf(child.id);
  check(childStill.relations?.createdBy === sessionId && childStill.relations?.displayParentId === sessionId, "the child's relations survived the capability being turned off");
  check((await stateOf(child.id)).entries.filter((entry) => entry.role === "user").length >= 2, "and so did its whole history");
  // The generic control still works: the child can be stopped and continued without the delegation capability.
  const stopped = await backend("/api/conversations/" + child.id + "/stop", { method: "POST", body: JSON.stringify({ requestId: "stop-after-off" }) });
  check(stopped.status === 202, "the child can still be stopped: " + stopped.status);
  const continued = await backend("/api/conversations/" + child.id + "/continue", { method: "POST", body: JSON.stringify({ requestId: "continue-after-off" }) });
  check(continued.status === 202, "and continued: " + continued.status);
  await page.goto(webOrigin + "/?session=" + child.id, { waitUntil: "domcontentloaded" });
  await signIn(page);
  check((await page.locator("textarea").count()) >= 1, "the child still opens in the same ChatWindow with the capability off");

  // --- 7. The negative journeys: over the limit, and an unreachable host. ---------------------------------------
  const on = await webRequest("/api/sessions/" + sessionId + "/extensions", { method: "PATCH", body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  check(on.status === 200, "the capability is back on for the limit journey");
  const held = [];
  for (let index = 1; index <= 4; index += 1) {
    const answer = await backend("/api/conversations/" + sessionId + "/delegate", { method: "POST", body: JSON.stringify({ name: "quick-worker", task: "hold " + index, requestId: "limit-" + index }) });
    check(answer.status === 201, "delegation " + index + " of 4 was admitted: " + answer.status + " " + await answer.clone().text());
    held.push((await answer.json()).childConversationId);
  }
  const refused = await backend("/api/conversations/" + sessionId + "/delegate", { method: "POST", body: JSON.stringify({ name: "quick-worker", task: "hold 5", requestId: "limit-5" }) });
  const refusal = await refused.json();
  check(refused.status === 409 && refusal.code === "children_exceeded", "the fifth delegation is refused by the concurrency bound: " + refused.status + " " + JSON.stringify(refusal));
  check(/children at work; the limit is 4/.test(refusal.error ?? ""), "and the refusal names the limit rather than queueing hidden work");
  check((await childrenOf(sessionId)).length === 5, "the refused delegation created no child: " + (await childrenOf(sessionId)).length);
  const webRefused = await webRequest("/api/sessions/" + sessionId + "/delegate", { method: "POST", body: JSON.stringify({ name: "quick-worker", task: "hold 6", requestId: "limit-6" }) });
  check(webRefused.status === 409, "and the Web origin reports the same refusal to the browser: " + webRefused.status);
  await endpoint.release();
  for (const id of held) await eventually(() => rowOf(id), (row) => row?.runStatus?.state === "idle", "a held child to finish", 90_000);

  // The host is taken away for real: the definition panel's own route has nothing to reach.
  const offline = await fetch("http://127.0.0.1:" + controlPort + "/offline", { method: "POST" });
  check(offline.status === 200, "the execution host was taken away for the offline journey");
  const unreachable = await webRequest("/api/agent-definitions?cwd=" + encodeURIComponent("/workspace/local"));
  const unreachableBody = await unreachable.json();
  // With the host gone the deployment can no longer even prove which gateway owns the folder, so the refusal is the
  // configuration one — still a failure with a named code, never an empty definition list a user would read as "none
  // exist". Either refusal is truthful; what must not happen is a 200 with nothing in it.
  check(unreachable.status >= 400, "an unreachable host is a failure rather than an empty list: " + unreachable.status + " " + JSON.stringify(unreachableBody).slice(0, 200));
  check(typeof unreachableBody.code === "string" && unreachableBody.code !== "", "and the failure is named by code rather than by a bare status: " + JSON.stringify(unreachableBody).slice(0, 200));
  check(/host|gateway/i.test(JSON.stringify(unreachableBody)), "and its reason is about the host, not about the definitions: " + JSON.stringify(unreachableBody).slice(0, 200));
  const refusedWhileOffline = await webRequest("/api/sessions/" + sessionId + "/delegate", { method: "POST", body: JSON.stringify({ name: "quick-worker", task: "offline task", requestId: "offline-1" }) });
  const offlineBody = await refusedWhileOffline.json();
  check(refusedWhileOffline.status >= 400, "a delegation while the host is away is refused: " + refusedWhileOffline.status + " " + JSON.stringify(offlineBody).slice(0, 200));
  check(offlineBody.code === "host_unreachable" || offlineBody.code === "backend_unreachable" || offlineBody.code === "no_execution_host", "with the code that names it: " + JSON.stringify(offlineBody).slice(0, 200));

  check(pageErrors.length === 0, "no page error: " + pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint?.close().catch(() => {});
  if (failures.length > 0) { console.error("UX-12 subagent delegate checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  if (keep) console.log("Artifacts kept at " + artifacts);
  else rmSync(artifacts, { recursive: true, force: true });
  console.log("UX-12 subagent delegate checks PASSED");
}
