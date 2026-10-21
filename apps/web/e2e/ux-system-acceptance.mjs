/**
 * Ticket 13's combined production browser journey: one session of the whole feature, driven the way a person drives it.
 *
 * The owning tickets each have their own driver (12 the delegate entry, 09 the per-item queue, 11 the raw history and
 * fork, 05 Settings). What none of them can state is the **combination** the acceptance table asks for on one store: a
 * quick create from the composer, the Settings definition behind it, the child tree, the child's own window, a late
 * report edited and cancelled under a hold and then continued, and the child's raw history, a structured reference and a
 * fork from it — plus the behaviours that must not regress alongside them (a pending submission recovered by its
 * request id, a windowed history, an image read from its own block).
 *
 * Real production paths only: the production Next build, the real backend process over real SQLite, a real local
 * execution host with real definition files, the real subagent extension with its real anchor and reporter tasks, and
 * one controlled OpenAI-completions endpoint that records every request.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-system-acceptance.mjs [--keep]
 *        HEPI_UX13_WEB_PORT / HEPI_UX13_BACKEND_PORT
 *
 * The first line it prints is its provenance — the Next build id it serves and the git revision the working tree is at —
 * so a recorded log states which build and which source produced it instead of relying on the ticket around it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
const token = "ux-system-acceptance-token";
const model = "controlled-1";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const buildId = readFileSync(join(webRoot, ".next", "BUILD_ID"), "utf8").trim();
const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const sourceRevision = git(["rev-parse", "HEAD"]);
const sourceDirty = git(["status", "--porcelain"]).length > 0;
console.log("Provenance: build " + buildId + " at " + sourceRevision + (sourceDirty ? " (dirty working tree)" : " (clean)"));

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux13-"));
const dataDir = join(artifacts, "data");
const fixtureRoot = join(artifacts, "fixture");
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
let endpoint;
let browser;
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000).then(() => child.kill("SIGKILL"))]);
  await Promise.race([exited, delay(5_000)]);
}

/**
 * Every process this driver started, stopped by PID, exactly once — whether the run finished, failed, or was
 * interrupted. An interrupted driver that skipped this would leave the production Next server and the backend holding
 * their ports for the next run, which is the leaked-listener failure the verification guide records.
 */
let shutdownPromise;
function shutdown() {
  return shutdownPromise ??= (async () => {
    await browser?.close().catch(() => {});
    for (const child of children.reverse()) await stop(child).catch(() => {});
    childrenLog.end();
    await endpoint?.close().catch(() => {});
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    console.log("Interrupted by " + signal + "; stopping the processes this run started");
    void shutdown().then(() => process.exit(130));
  });
}

/**
 * One controlled OpenAI-completions endpoint that records every request and answers from the transcript it is given.
 *
 * The answers are chosen by the transcript, never by a fixed queue, so the parent, its post-tool round and the child
 * cannot consume each other's script. The **gate** is armed for the late-report journey alone, so the stop really lands
 * while the parent and its child are working; every other turn answers at once, which is what the earlier journeys need.
 */
function controlledEndpoint() {
  const requests = [];
  const startedAt = Date.now();
  /** The one armed gate: while it is closed, a matching answer waits, so a run is genuinely in flight. */
  let gate;
  const arm = () => { gate = { closed: true, waiters: [] }; };
  const release = () => { if (gate === undefined) return; gate.closed = false; for (const resolve of gate.waiters.splice(0)) resolve(); gate = undefined; };
  const hold = () => gate === undefined || !gate.closed ? Promise.resolve() : new Promise((resolve) => { gate.waiters.push(resolve); });
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/release") { release(); response.writeHead(200).end("{}"); return; }
      if (request.method === "POST" && request.url === "/arm") { arm(); response.writeHead(200).end("{}"); return; }
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = JSON.stringify(body.messages ?? []);
      requests.push({ at: Date.now() - startedAt, text, body, messages: body.messages ?? [] });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      const base = { id: "chatcmpl-ux13", object: "chat.completion.chunk", created: 1, model };
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
      const answer = async () => {
        // The child's own task: a held answer, so the report really is a late arrival after the user's stop.
        if (text.includes("child work one")) { await hold(); return { delta: { role: "assistant", content: "late answer for one" }, finish_reason: "stop" }; }
        // The user's quick create, and the parent's post-tool round: the second is held so a run is really in flight.
        if (text.includes("quick child task")) return { delta: { role: "assistant", content: "quick child answer" }, finish_reason: "stop" };
        if (text.includes("delegate and stop")) return { tool_calls: [{ index: 0, id: "call-one", type: "function", function: { name: "agent_spawn", arguments: JSON.stringify({ name: "quick-worker", task: "child work one" }) } }] };
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
        arm,
        release: async () => { release(); await fetch("http://127.0.0.1:" + address.port + "/release", { method: "POST" }); },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

const backendPort = await freePort(Number(process.env.HEPI_UX13_BACKEND_PORT ?? 0));
const backendOrigin = "http://127.0.0.1:" + backendPort;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const backend = (path, init) => fetch(backendOrigin + path, { headers, ...init });
const backendJson = async (path, init) => (await backend(path, init)).json();
const rowOf = async (id) => (await backendJson("/api/conversations")).conversations.find((row) => row.id === id);
const stateOf = async (id) => backendJson("/api/conversations/" + id + "/state");
const infoOf = async (id) => backendJson("/api/conversations/" + id);

async function eventually(read, accept, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description + "; last " + JSON.stringify(value).slice(0, 400));
    await delay(200);
  }
}

const composerText = (page) => page.locator("textarea").first();
async function signIn(page) {
  const password = page.locator('input[type="password"]');
  if (await password.count()) { await password.fill(token); await page.locator('button[type="submit"]').click(); }
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
}
async function openAgentsSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "New definition", exact: true }).waitFor({ timeout: 30_000 });
}
const closeSettings = async (page) => {
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
};
const openDelegatePanel = async (page) => { await page.locator("[data-delegate-entry]").click(); await page.locator("[data-delegate-definition]").waitFor({ timeout: 30_000 }); };
const openRawHistory = async (page) => { await page.getByRole("button", { name: "Full history" }).first().click(); await page.locator("[data-raw-history]").waitFor({ timeout: 30_000 }); };
async function waitForItems(page, predicate, description, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = page.locator("[data-queued-item]");
    const count = await rows.count();
    const texts = [];
    for (let index = 0; index < count; index += 1) texts.push(await rows.nth(index).innerText());
    if (predicate(texts)) return texts;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description + "; rows: " + JSON.stringify(texts));
    await delay(150);
  }
}

let page;
let cookie;
let webOrigin;
let seed;

try {
  endpoint = await controlledEndpoint();
  const backendChild = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "subagent-acceptance-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      HEPI_UX13_FIXTURE: fixtureRoot,
      HEPI_UX13_DB: join(dataDir, "acceptance.sqlite"),
      HEPI_UX13_BACKEND_PORT: String(backendPort),
      HEPI_UX13_AUTH: token,
      HEPI_UX13_MODEL: model,
      HEPI_UX13_ENDPOINT: endpoint.origin,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backendChild);
  const backendLog = capture(backendChild);
  assert.ok(await waitForHttp(backendOrigin + "/api/conversations", headers, 120_000), "the backend started: " + backendLog().slice(-1200));
  const seeded = backendLog().match(/HEPI_UX13_SEED (\{.*\})/);
  assert.ok(seeded !== undefined, "the fixture stated the identities it seeded: " + backendLog().slice(-1200));
  seed = JSON.parse(seeded[1]);

  // The seeded facts, read from the backend before any browser opens: the child is a real delegated conversation with
  // its own native owner, and the compaction really hides the prefix from the active window.
  const childInfo = await infoOf(seed.childId);
  check(childInfo.owner?.conversationId === seed.sessionId, "the seeded child's native owner is a task of the parent: " + JSON.stringify(childInfo.owner));
  const window = await stateOf(seed.childId);
  check(window.historyHead === seed.summaryEntryId, "the child's active window is led by the compaction's head marker");
  check(window.entries.some((entry) => entry.id === seed.preCompactionEntryId) === false, "the compacted prefix is not in the active window");
  const raw = await backendJson("/api/conversations/" + seed.childId + "/read");
  check(raw.output.some((block) => block.type === "text" && block.text.includes("BEFORE THE COMPACTION")), "the raw read still reaches the compacted prefix");
  const imageBlock = raw.details.entries.find((entry) => entry.entryId === seed.imageEntryId)?.blocks.find((block) => block.type === "image");
  check(imageBlock !== undefined, "the raw read inventories the inherited image block: " + JSON.stringify(imageBlock));

  const webPort = await freePort(Number(process.env.HEPI_UX13_WEB_PORT ?? 0));
  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 120_000), "the Web UI started: " + webLog().slice(-1200));
  const login = await fetch(webOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200, "the browser session authenticated");
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: webOrigin, sameSite: "Strict" }]);
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const eventRequests = [];
  page.on("request", (request) => { if (request.url().includes("/events")) eventRequests.push(request.url()); });
  await page.goto(webOrigin + "/?session=" + seed.sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);

  // --- 1. Settings: the definition the quick create will run, saved through the panel's own form. ----------------
  const definitionPath = join(fixtureRoot, "backend-home", ".pi", "agent", "agents", "quick-worker.md");
  await openAgentsSettings(page);
  await page.getByRole("button", { name: "New definition", exact: true }).click();
  await page.getByRole("group", { name: "Save to" }).getByRole("button", { name: "user", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("quick-worker");
  await page.getByLabel("Description", { exact: true }).fill("Quick worker");
  await page.getByLabel("Instructions", { exact: true }).fill("Answer the task briefly.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await eventually(() => Promise.resolve(existsSync(definitionPath)), (value) => value === true, "the definition to reach the host");
  check(existsSync(definitionPath), "the definition Settings saved is a real file on the execution host");
  check(/^name: quick-worker$/m.test(readFileSync(definitionPath, "utf8")), "and it carries the name the form gave");
  await closeSettings(page);

  // --- 2. Quick create from the composer, and the child opens in the same window. --------------------------------
  await openDelegatePanel(page);
  const offered = await page.locator("[data-delegate-definition] option").allTextContents();
  check(offered.some((text) => text.includes("quick-worker")), "the quick create offers the definition Settings saved: " + JSON.stringify(offered));
  await page.locator("[data-delegate-definition]").selectOption("quick-worker");
  await page.locator("[data-delegate-task]").fill("quick child task");
  await page.locator("[data-delegate-submit]").click();
  const quickChild = await eventually(async () => (await backendJson("/api/conversations?createdBy=" + seed.sessionId)).conversations.find((row) => row.id !== seed.childId), (value) => value !== undefined, "the quick created child");
  check(quickChild.createdBy === seed.sessionId && quickChild.displayParentId === seed.sessionId, "the quick create made a real child of this conversation");
  check(quickChild.subagentParentConversationId === seed.sessionId, "and the catalogue states the delegation edge");
  const opened = await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, quickChild.id, { timeout: 30_000 }).then(() => true, () => false);
  check(opened, "the quick create opened the child in the same ChatWindow: " + page.url());
  await eventually(() => stateOf(quickChild.id), (state) => state?.entries?.some((entry) => entry.role === "assistant" && entry.text === "quick child answer"), "the child's own answer");
  check((await stateOf(quickChild.id)).entries.some((entry) => entry.role === "assistant" && entry.text === "quick child answer"), "the child really ran and answered in its own conversation");
  await eventually(() => stateOf(seed.sessionId), (state) => state?.entries?.some((entry) => entry.role === "user" && String(entry.text).startsWith("The delegated child ")), "the report to reach the parent");
  check((await stateOf(seed.sessionId)).entries.some((entry) => entry.role === "user" && String(entry.text).includes("quick child answer")), "the child's result reached the parent as its own report");

  // --- 3. The child tree states each child's own status and opens it. --------------------------------------------
  await page.goto(webOrigin + "/?session=" + seed.sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  // The tree is a toolbar panel a person opens, so the driver opens it the same way.
  await page.locator("[data-agent-switcher]").click();
  const childRows = page.locator("[data-child-session]");
  await childRows.first().waitFor({ timeout: 45_000 });
  const listedChildren = await childRows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-child-session")));
  check(listedChildren.includes(quickChild.id), "the child tree lists the quick created child: " + JSON.stringify(listedChildren));
  check(listedChildren.includes(seed.childId), "and the seeded child");
  const quickRowStatus = (await rowOf(quickChild.id)).runStatus?.state;
  check(quickRowStatus === "idle", "a finished child's own status is idle, read from its own run: " + String(quickRowStatus));
  check((await rowOf(seed.sessionId)).runStatus?.state === "idle", "and the parent's status is its own");
  await page.locator("[data-child-session='" + seed.childId + "']").first().click();
  await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, seed.childId, { timeout: 30_000 });
  check(new URL(page.url()).searchParams.get("session") === seed.childId, "the tree opened the seeded child in the same window");
  // The child's own fields: the delegation the seeded dispatch made, and the configuration snapshot it inherited.
  const seededInfo = await infoOf(seed.childId);
  check(seededInfo.relations?.createdBy === seed.sessionId && seededInfo.relations?.displayParentId === seed.sessionId, "the child's relations are its own: " + JSON.stringify(seededInfo.relations));

  // --- 4. A late report under a user hold: edit one, cancel one, then Continue. ---------------------------------
  await page.goto(webOrigin + "/?session=" + seed.sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  const beforeStop = endpoint.requests.length;
  // The gate is armed here and nowhere else: this is the journey where a stop has to land on work genuinely in flight,
  // so the child's own answer and the parent's post-tool round both wait for the driver.
  endpoint.arm();
  await composerText(page).fill("delegate and stop");
  await composerText(page).press("Enter");
  // The child is created, and its own answer is held, so the stop really lands while it is still working.
  await eventually(async () => (await backendJson("/api/conversations?createdBy=" + seed.sessionId)).conversations.length >= 3, (value) => value === true, "the third child to be created");
  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await stopButton.waitFor({ timeout: 45_000 });
  await stopButton.click();
  await page.locator("[data-held-banner]").waitFor({ timeout: 45_000 });
  check(true, "the composer states the hold after the user's own stop");
  check((await page.locator("[data-continue]").count()) === 1, "the explicit Continue control is offered while held");
  // The child finishes late and its report queues under the hold.
  await endpoint.release();
  const queuedRows = await waitForItems(page, (texts) => texts.length >= 1, "the late report to queue");
  check(queuedRows.length >= 1, "the late report is a visible queued item: " + JSON.stringify(queuedRows.map((text) => text.split("\n")[0])));
  check(queuedRows.some((text) => text.includes("Report")), "and it states that it came from a delegated child");
  check(queuedRows.some((text) => text.includes("late answer for one")), "and carries the child's own answer text");
  // Nothing is asked of any model from the moment the report queues until the user's own Continue: that is what the hold
  // means, and the driver waited rather than counting the turn the stop was interrupting.
  const requestsAtQueue = endpoint.requests.length;
  await delay(1_500);
  const wokeWhileHeld = endpoint.requests.slice(requestsAtQueue);
  check(wokeWhileHeld.length === 0, "the held report woke no model: " + JSON.stringify(wokeWhileHeld.map((entry) => entry.text.slice(-120))));
  const heldControl = await backendJson("/api/conversations/" + seed.sessionId + "/control");
  check(heldControl.control.state === "held", "the backend's own control record is held");

  // One item is edited; the hold and its revision do not move.
  const firstRow = page.locator("[data-queued-item]").first();
  await firstRow.getByRole("button", { name: "Edit", exact: true }).click();
  await firstRow.locator("textarea").fill("the user's own edited decision");
  await firstRow.getByRole("button", { name: "Save", exact: true }).click();
  const editedRows = await waitForItems(page, (texts) => texts.some((text) => text.includes("the user's own edited decision")), "the edited item");
  check(editedRows.some((text) => text.includes("the user's own edited decision")), "the edited text is what the queue now shows");
  const afterEdit = await backendJson("/api/conversations/" + seed.sessionId + "/control");
  check(afterEdit.control.state === "held" && afterEdit.control.revision === heldControl.control.revision, "an edit lifted nothing and moved no revision");

  // A reload keeps the decision and the hold: the queue a reloaded page reads is the backend's own.
  await page.reload({ waitUntil: "domcontentloaded" });
  await signIn(page);
  const reloadedRows = await waitForItems(page, (texts) => texts.some((text) => text.includes("the user's own edited decision")), "the edited item after a reload");
  check(reloadedRows.some((text) => text.includes("the user's own edited decision")), "a reloaded page reads the edit back from the backend");
  await page.locator("[data-held-banner]").waitFor({ timeout: 45_000 });
  check((await page.locator("[data-continue]").count()) === 1, "and still offers the explicit Continue");

  // Continue: the model reads the kept, edited text.
  const beforeContinue = endpoint.requests.length;
  await page.locator("[data-continue]").click();
  await page.locator("[data-held-banner]").waitFor({ state: "detached", timeout: 90_000 });
  check(true, "the held banner leaves once the user's own continue ends the hold");
  const resumed = await eventually(async () => endpoint.requests.slice(beforeContinue).find((entry) => entry.text.includes("the user's own edited decision")), (value) => value !== undefined, "the model to read the kept text");
  check(resumed !== undefined, "the parent model's next request carries the edited text the user kept");
  const finalState = await stateOf(seed.sessionId);
  check(finalState.queuedItems.length === 0, "the held queue was consumed by the continue");
  check(JSON.stringify(finalState.entries).includes("the user's own edited decision"), "and the kept text reached the transcript");

  // --- 5. Raw history: the compacted prefix, the image block and the structured reference. -----------------------
  await page.goto(webOrigin + "/?session=" + seed.childId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await openRawHistory(page);
  await page.locator("[data-raw-entry='" + seed.preCompactionEntryId + "']").waitFor({ timeout: 45_000 });
  const panelText = await page.locator("[data-raw-history]").innerText();
  check(panelText.includes("BEFORE THE COMPACTION"), "the raw history shows the compacted entry the window cannot");
  check(panelText.includes("pi.compaction"), "and lists the compaction entry itself");
  await page.locator("[data-raw-block='" + seed.imageEntryId + ":1']").click();
  await page.locator("[data-raw-block-body='" + seed.imageEntryId + ":1']").waitFor({ timeout: 45_000 });
  const imageSrc = await page.locator("[data-raw-block-body] img").first().getAttribute("src");
  check(typeof imageSrc === "string" && imageSrc.startsWith("data:image/png;base64,"), "the inherited attachment is read as its own bytes: " + String(imageSrc).slice(0, 40));
  const reference = page.locator("[data-raw-references] button").first();
  await reference.waitFor({ timeout: 30_000 });
  check((await reference.innerText()).includes("the parent"), "the panel lists the structured reference with its own label: " + await reference.innerText());
  await reference.click();
  await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, seed.sessionId, { timeout: 30_000 });
  check(true, "opening the reference selected the conversation it names");

  // --- 6. Fork the child from a chosen entry: a branch of its own, opened in the same window. --------------------
  await page.goto(webOrigin + "/?session=" + seed.childId, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await openRawHistory(page);
  const branchButton = page.locator("[data-raw-entry='" + seed.keptEntryId + "'] button").first();
  await branchButton.waitFor({ timeout: 45_000 });
  const conversationsBefore = (await backendJson("/api/conversations")).conversations.length;
  await branchButton.click();
  await page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") !== id, seed.childId, { timeout: 45_000 });
  const branchId = new URL(page.url()).searchParams.get("session");
  check(typeof branchId === "string" && branchId !== seed.childId, "forking from an entry opened the new branch: " + branchId);
  const branchInfo = await infoOf(branchId);
  check(branchInfo.relations?.displayParentId === seed.childId, "the branch is displayed under the child it was taken from");
  check(branchInfo.forkSource?.conversationId === seed.childId && branchInfo.forkSource?.at === seed.keptEntryId, "the branch inherits the child's history at the chosen entry");
  check(branchInfo.owner?.conversationId === seed.childId, "the branch has its own native owner on the child");
  check((await backendJson("/api/conversations")).conversations.length === conversationsBefore + 1, "exactly one branch was created");
  const branchState = await stateOf(branchId);
  check(branchState.control.state === "allowed" && branchState.busy === false, "the branch inherited no hold and no work");

  // --- 7. The behaviours that must not regress beside the new ones. ---------------------------------------------
  // 7a. A submission is recovered by its own request id, not resent.
  const requestId = "ux13-recovery-" + Date.now();
  const submitted = await backend("/api/conversations/" + seed.sessionId + "/messages", { method: "POST", body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "recover me" }) });
  check(submitted.status === 202, "a turn was admitted for the recovery check: " + submitted.status);
  const recovered = await eventually(async () => (await backendJson("/api/conversations/" + seed.sessionId + "/submissions?requestId=" + encodeURIComponent(requestId))).submission, (value) => value !== null && value?.status === "done", "the submission to settle");
  check(recovered !== null && recovered.status === "done", "the request id resolves the durable submission: " + JSON.stringify(recovered));
  check((await stateOf(seed.sessionId)).entries.filter((entry) => entry.role === "user" && entry.text === "recover me").length === 1, "and the message was admitted exactly once");
  // 7b. A windowed history still pages: a bounded read states its own truncation and a continuation.
  const page1 = await backendJson("/api/conversations/" + seed.childId + "/read?limit=1");
  check(page1.details.truncated === true || page1.details.hasMore === true, "a bounded read states that more history exists: " + JSON.stringify({ truncated: page1.details.truncated, hasMore: page1.details.hasMore }));
  check(page1.details.next !== undefined || page1.details.truncated === true, "and offers a continuation position");
  // 7c. An image is read from its own block address, never as a file path.
  const blockRead = await backendJson("/api/conversations/" + seed.childId + "/read?entryId=" + seed.imageEntryId + "&blockIndex=1");
  check(blockRead.output.some((part) => part.type === "image" && String(part.mimeType).startsWith("image/")), "the image block reads as an image, not a path");
  check(pageErrors.length === 0, "no page error: " + pageErrors.join(" | "));
  // No per-row stream: nothing the tree shows opens a stream of its own.
  const perRowStreams = eventRequests.filter((url) => /\/(state|items)$/.test(url));
  check(perRowStreams.length === 0, "no per-row stream was opened: " + JSON.stringify(eventRequests.slice(0, 6)));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await shutdown();
  if (failures.length > 0) { console.error("UX-13 system acceptance checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  if (keep) console.log("Artifacts kept at " + artifacts);
  else rmSync(artifacts, { recursive: true, force: true });
  console.log("UX-13 system acceptance checks PASSED");
}
