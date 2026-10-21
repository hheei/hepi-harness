/**
 * The durable submission projection, driven through the real UI: a send whose outcome the surface could not establish.
 *
 * Real production paths only: the production Next build, the real backend and gateway, the real composer and the real
 * /api/agent prompt route. The model endpoint is this script's own OpenAI-completions server and holds its answer until
 * the driver releases it, so "the run is in flight" is a real state rather than a sleep.
 *
 * Two scenes, both about the same seam — the browser must not infer a submission's fate from the transcript:
 *
 * 1. **Reorder.** The prompt's HTTP answer arrives after the state frame that already names the submission. The turn
 *    must stay on screen and must end up in the transcript exactly once, not twice.
 * 2. **Recovery.** The prompt's HTTP answer is lost after the backend received it. The outcome is unknown, not a
 *    rejection: the turn stays on screen, the text is not put back in the composer, and the surface asks the
 *    conversation for that one submission by its request id instead of sending it again. The model endpoint must see
 *    exactly one request, and the lookup must settle the turn into the transcript.
 * 3. **Recall.** A queued turn is withdrawn while the run is in flight: the terminal frame the backend sends about that
 *    submission is the only thing that may take it off the screen, and the text it hands back is a deliberate act.
 * 4. **Admitted, then lost.** The durable fact that the conversation took the submission reaches the surface before the
 *    HTTP answer does, and then the answer never arrives at all: the turn is committed, so its unknown outcome is a
 *    fact about a message in the transcript and the recovery lookup comes back with nothing. It must be stated on
 *    screen, never as a turn the surface invented, and nothing may be restored, resent or rung for it.
 * 6. **A shell draft while the run is in flight.** The idle send refuses a `!` draft, and the busy paths — Enter,
 *    Alt+Enter, Steer, Follow-up — reach the host through a seam of their own: each must refuse too, before it stages
 *    a turn, clears the composer or POSTs anything, and must state the same reason. An ordinary draft still queues and
 *    is admitted by its own POST straight away and reaches the model once the run it waited behind finishes.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-submission-recovery.mjs
 *        HEPI_SUB_WEB_PORT=<port> HEPI_SUB_BACKEND_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-sub-recovery-token";
const webPort = Number(process.env.HEPI_SUB_WEB_PORT ?? 43140);
const backendPort = Number(process.env.HEPI_SUB_BACKEND_PORT ?? 44140);
const model = "deepseek-v4.1-flash";
const prompt = "submission recovery text";

/** A real 1x1 RGBA PNG, so the attachment scene exercises the composer's own file input and stored bytes. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-subrecovery-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
const imagePath = join(artifacts, "tiny.png");
writeFileSync(imagePath, TINY_PNG);
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

/** One OpenAI-completions endpoint that records every request and holds its answer until the driver releases it. */
function gatedEndpoint() {
  let requests = [];
  let waiters = [];
  let released = false;
  let arrived = [];
  const release = () => { released = true; while (waiters.length > 0) waiters.shift()(); };
  /** The next request the endpoint receives, as a fact the driver waits on instead of polling for it. */
  const nextRequest = () => {
    if (requests.length > 0) return Promise.resolve(requests[0]);
    return new Promise((resolveArrived) => arrived.push(resolveArrived));
  };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      while (arrived.length > 0) arrived.shift()(requests[requests.length - 1]);
      const answer = () => {
        const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "recovery answer" }, finish_reason: null }] }));
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
        response.end("data: [DONE]\n\n");
      };
      if (released) answer();
      else waiters.push(answer);
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({
        origin: "http://127.0.0.1:" + address.port,
        get requests() { return requests; },
        nextRequest,
        release,
        reset: () => { released = false; waiters = []; arrived = []; requests = []; },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

async function startBackend(dbPath, endpoint) {
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

/** Frame-driven observation of what the shell shows: the real transcript bubbles and the composer's own text. */
const RECORDER = () => {
  window.__subTimeline = [];
  // One completion tone is two oscillator starts; an outcome that was never established must play none of them.
  window.__subAudio = [];
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (AudioCtor) {
    const createOscillator = AudioCtor.prototype.createOscillator;
    AudioCtor.prototype.createOscillator = function patchedCreateOscillator() {
      const oscillator = createOscillator.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (...args) => {
        window.__subAudio.push({ t: Math.round(performance.now()), freq: oscillator.frequency.value });
        return start(...args);
      };
      return oscillator;
    };
  }
  const sample = () => {
    const body = document.body ? document.body.innerText : "";
    const area = document.querySelector(".chat-input-textarea");
    const entry = {
      bubbles: document.querySelectorAll(".markdown-user-message").length,
      drafted: area instanceof HTMLTextAreaElement ? area.value : "",
      onScreen: body.includes("submission recovery text"),
      unknown: body.includes("outcome of this message is unknown"),
      unknownShown: document.querySelectorAll("[data-submission-unknown]").length,
      pending: document.querySelectorAll("[data-pending-submission]").length,
      queued: document.body.innerText.includes("Recall to input"),
      t: Math.round(performance.now()),
    };
    const timeline = window.__subTimeline;
    const last = timeline[timeline.length - 1];
    if (!last || ["bubbles", "drafted", "onScreen", "unknown", "unknownShown", "pending", "queued"].some((key) => last[key] !== entry[key])) timeline.push(entry);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

/**
 * The composer's own attachment previews. A freshly attached file is shown from a \`blob:\` object URL and one restored
 * from the tab's store is shown from its own \`data:\` bytes, so both are counted; the bytes are asserted separately.
 */
const composerImageSrc = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".chat-input-shell img"))
  .map((element) => element.getAttribute("src") ?? "")
  .filter((src) => src.startsWith("blob:") || src.startsWith("data:image/png;base64,")));
const composerText = (page) => page.locator("textarea").first().inputValue();
/** Wait for the composer of a reloaded page, which adopts its draft before its first paint. */
async function reloadComposer(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(page, 20);
}

const frames = (page, count) => page.evaluate((n) => new Promise((done) => {
  let seen = 0;
  const tick = () => { if (++seen >= n) done(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), count);

async function openPage(browser, origin) {
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
  await context.addInitScript(RECORDER);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, context, pageErrors };
}

/** Open a fresh conversation through the real New affordance, so the composer is the one a user gets. */
async function openComposer(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  await frames(page, 30);
  const newButton = page.locator(".sidebar-new-button");
  await newButton.waitFor({ timeout: 30_000 });
  // Nothing is adopted by itself: the project is picked the way a user picks it — the listed group's own New — and
  // the shell's New affordance then starts the composer this scene works in.
  await page.locator(".session-tree-group-actions .session-tree-group-action:first-child").first().click();
  await newButton.click();
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(page, 20);
}

const endpoint = await gatedEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(join(dataDir, "submission-recovery.sqlite"), endpoint);
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

  // --- Scene 1: the state frame names the submission before the HTTP answer does. ------------------------------
  const reorder = await openPage(browser, origin);
  contexts.push(reorder.context);
  await reorder.context.route("**/api/agent/**", async (route) => {
    const body = route.request().postData() ?? "";
    if (route.request().method() === "POST" && body.includes('"type":"prompt"')) await delay(2500);
    await route.continue();
  });
  await reorder.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(reorder.page);
  await reorder.page.locator("textarea").first().fill(prompt);
  await frames(reorder.page, 5);
  await reorder.page.evaluate(() => { window.__subTimeline = []; });
  await reorder.page.getByRole("button", { name: "Send", exact: true }).click();
  // The endpoint answering is the proof the prompt reached the backend and the run started.
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "reorder: the gated model received the submission");
  await frames(reorder.page, 40);
  const reorderDuringRun = await reorder.page.evaluate(() => window.__subTimeline.slice());
  check(reorderDuringRun.some((entry) => entry.onScreen), "reorder: the turn is on screen while the run is in flight");
  endpoint.release();
  await reorder.page.getByText("recovery answer").first().waitFor({ timeout: 30_000 });
  await frames(reorder.page, 60);
  const reorderBubbles = await reorder.page.locator(".markdown-user-message").count();
  check(reorderBubbles === 1, "reorder: the turn ends up in the transcript exactly once (" + reorderBubbles + " user turns)");
  check(endpoint.requests.length === 1, "reorder: the model saw exactly one request");
  check(reorder.pageErrors.length === 0, "reorder: no page error: " + reorder.pageErrors.join(" | "));
  await reorder.context.close();

  // --- Scene 2: the HTTP answer is lost after the backend received it. ------------------------------------------
  endpoint.reset();
  const recovery = await openPage(browser, origin);
  contexts.push(recovery.context);
  // The request reaches the backend and the browser never sees its answer: the connection carrying the submission ended
  // before either outcome was known. That is the glossary's unknown outcome, and it is not a rejection. The lookup's own
  // answer is held for a moment so the wait is a real state rather than a frame that may be missed.
  let releaseLookup;
  const lookupHeld = new Promise((resolveHeld) => { releaseLookup = resolveHeld; });
  await recovery.context.route("**/api/agent/**", async (route) => {
    const url = route.request().url();
    const body = route.request().postData() ?? "";
    if (url.includes("/submissions?requestId=")) { await lookupHeld; await route.continue(); return; }
    if (route.request().method() === "POST" && body.includes('"type":"prompt"')) {
      await route.fetch();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await recovery.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(recovery.page);
  await recovery.page.locator("textarea").first().fill(prompt);
  await frames(recovery.page, 5);
  await recovery.page.evaluate(() => { window.__subTimeline = []; });
  // The lookup is the recovery seam: the surface asks about its own request id instead of sending again. The wait is
  // registered before Send, and it watches the request rather than the response, because this driver deliberately holds
  // that response to make the wait observable.
  let lookupUrl = "";
  recovery.page.on("request", (request) => { if (request.url().includes("/submissions?requestId=")) lookupUrl = request.url(); });
  const lookupSeen = (async () => {
    const deadlineLookup = Date.now() + 20_000;
    while (lookupUrl === "" && Date.now() < deadlineLookup) await delay(50);
    return lookupUrl;
  })();
  await recovery.page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "recovery: the backend received the submission");
  check((await lookupSeen).includes("/submissions?requestId="), "recovery: the surface asked the conversation about its own submission by request id (" + lookupUrl + ")");
  await frames(recovery.page, 40);
  const unknownTimeline = await recovery.page.evaluate(() => window.__subTimeline.slice());
  console.log("  recovery timeline: " + JSON.stringify(unknownTimeline));
  check(unknownTimeline.some((entry) => entry.onScreen), "recovery: the turn stays on screen instead of being erased");
  check(unknownTimeline.some((entry) => entry.pending >= 1), "recovery: the turn is drawn as a pending turn of its own");
  // Only the entries after the send matter for the draft: the composer held the text before Send, and putting it back
  // after the failure is what would present an unknown outcome as a rejection.
  const afterSend = unknownTimeline.slice(unknownTimeline.findIndex((entry) => entry.drafted === "") === -1 ? 0 : unknownTimeline.findIndex((entry) => entry.drafted === ""));
  check(afterSend.every((entry) => entry.drafted === ""), "recovery: the text is not restored to the composer as a rejection");
  check(endpoint.requests.length === 1, "recovery: the submission was never sent again");
  // Answer the lookup: the turn settles from the durable record it found, and the transcript owns it once.
  releaseLookup();
  // The lookup finds the admitted record, so the turn settles from it and the transcript owns it once.
  endpoint.release();
  await recovery.page.getByText("recovery answer").first().waitFor({ timeout: 30_000 });
  await frames(recovery.page, 60);
  const recoveryBubbles = await recovery.page.locator(".markdown-user-message").count();
  check(recoveryBubbles === 1, "recovery: the lookup settled the turn into the transcript exactly once (" + recoveryBubbles + " user turns)");
  check(recovery.pageErrors.length === 0, "recovery: no page error: " + recovery.pageErrors.join(" | "));
  await recovery.context.close();

  // --- Scene 3: a queued turn is recalled while the run is in flight. -------------------------------------------
  // The withdrawal is terminal for that submission, and it changes no entry and no document: the only thing that can
  // tell the surface the turn was taken back is the terminal frame the backend sends about it. Reading its absence
  // from the outstanding set would leave it on screen as an unknown outcome forever, which is what this scene rules out.
  endpoint.reset();
  const recall = await openPage(browser, origin);
  contexts.push(recall.context);
  await recall.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(recall.page);
  await recall.page.locator("textarea").first().fill(prompt);
  await frames(recall.page, 5);
  await recall.page.evaluate(() => { window.__subTimeline = []; });
  await recall.page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "recall: the run is in flight and holding the model answer");
  // A second turn sent while the first is running is queued, so it has no entry at all — the state the transcript
  // cannot represent and the outstanding projection can.
  const queuedText = prompt + " queued";
  await recall.page.locator("textarea").first().fill(queuedText);
  await frames(recall.page, 5);
  await recall.page.keyboard.press("Enter");
  await frames(recall.page, 20);
  const queuedTimeline = await recall.page.evaluate(() => window.__subTimeline.slice());
  check(queuedTimeline.some((entry) => entry.queued), "recall: the queued turn is shown as waiting in the queue");
  check(queuedTimeline.some((entry) => entry.pending >= 1), "recall: the queued turn is drawn as a pending turn of its own");
  // Recall it through the real affordance: the backend settles that submission as unanswered with its durable reason.
  await recall.page.getByRole("button", { name: "Recall to input" }).first().click();
  await frames(recall.page, 60);
  const afterRecall = await recall.page.evaluate(() => window.__subTimeline.slice());
  console.log("  recall timeline: " + JSON.stringify(afterRecall));
  const settled = afterRecall[afterRecall.length - 1];
  // The withdrawn turn is gone from the pending set, and it got there by its own terminal frame rather than by
  // lingering until something else happened: a turn read off the screen by absence would still be here.
  check(settled.pending === 0, "recall: the withdrawn turn left the pending set");
  check(!settled.unknown, "recall: the withdrawn turn is not reported as an unknown outcome");
  // The one turn still on screen is the running one; a withdrawn turn is never written into the transcript.
  const recalledBubbles = await recall.page.locator(".markdown-user-message").count();
  check(recalledBubbles === 1, "recall: only the running turn is on screen (" + recalledBubbles + " user turns)");
  // Recall hands the text back, which is the one thing a withdrawal does that a rejection also does — and it is a
  // deliberate act by the user, not an inference the surface made.
  check(settled.drafted.includes(queuedText), "recall: the withdrawn text is handed back to the composer");
  endpoint.release();
  await frames(recall.page, 60);
  check(recall.pageErrors.length === 0, "recall: no page error: " + recall.pageErrors.join(" | "));
  await recall.context.close();

  // --- Scene 4: the submission is admitted, then the transport carrying its outcome is lost. --------------------
  // The durable fact that the conversation took the submission reaches the surface before the HTTP answer does, and
  // then the answer never arrives at all. The turn is committed by then, so it is not a pending turn any more: the
  // unknown outcome is a fact about a message in the transcript, and the recovery lookup comes back with nothing. The
  // read is held for the whole scene, so the only projection the surface can be showing is the one the stream carried.
  endpoint.reset();
  const admitted = await openPage(browser, origin);
  contexts.push(admitted.context);
  let releaseLoss;
  const lossGate = new Promise((resolveLoss) => { releaseLoss = resolveLoss; });
  let releaseRead;
  const readGate = new Promise((resolveRead) => { releaseRead = resolveRead; });
  const lookupUrls = [];
  admitted.page.on("request", (request) => { if (request.url().includes("/submissions?requestId=")) lookupUrls.push(request.url()); });
  // Any conversation read this scene makes is held for its whole length: a snapshot would re-state the submission as
  // outstanding and clear the unknown, so the projection on screen is the one the stream carried.
  // The conversation read itself: the Web host forwards the backend's native snapshot, so the read carries no query.
  // The sidebar's own shared-state document is a different route and is left alone.
  await admitted.context.route(/\/api\/sessions\/(?!ui-state(?:\?|$))[^/?#]+(?:\?|$)/, async (route) => { await readGate; await route.continue(); });
  await admitted.context.route("**/api/agent/**", async (route) => {
    const url = route.request().url();
    const body = route.request().postData() ?? "";
    // The recovery is uncertain: the surface asks about its own submission and the answer never comes back.
    if (url.includes("/submissions?requestId=")) { await route.abort("failed"); return; }
    if (route.request().method() === "POST" && body.includes('"type":"prompt"')) {
      // The backend receives the submission; the browser never sees the answer, and not until the admission is on
      // screen, so the loss applies to a turn the conversation already committed.
      await route.fetch();
      await lossGate;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await admitted.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(admitted.page);
  await admitted.page.locator("textarea").first().fill(prompt);
  await frames(admitted.page, 5);
  await admitted.page.evaluate(() => { window.__subTimeline = []; });
  await admitted.page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "admitted: the run is in flight and the model answer is held");
  // The admission is on screen: the conversation committed the message and the surface no longer draws a turn of its
  // own for it. That is the fact the loss then applies to.
  await admitted.page.waitForFunction(
    () => document.querySelectorAll(".markdown-user-message").length === 1 && document.querySelectorAll("[data-pending-submission]").length === 0,
    null,
    { timeout: 30_000 },
  );
  releaseLoss();
  // Bounded, so a surface that states nothing fails the named check below instead of aborting the driver.
  await admitted.page.waitForFunction(() => document.querySelectorAll("[data-submission-unknown]").length > 0, null, { timeout: 15_000 }).catch(() => {});
  await frames(admitted.page, 60);
  const lostTimeline = await admitted.page.evaluate(() => window.__subTimeline.slice());
  const lostAudio = await admitted.page.evaluate(() => window.__subAudio.slice());
  console.log("  admitted timeline: " + JSON.stringify(lostTimeline));
  check(lostTimeline.some((entry) => entry.unknownShown > 0), "admitted: the unknown outcome of the admitted turn is stated on screen");
  check(lostTimeline.some((entry) => entry.pending === 0 && entry.bubbles === 1), "admitted: the turn is in the transcript and is not drawn as a pending turn");
  // Only the entries after the send matter for the draft: the composer held the text before Send, and putting it back
  // after the outcome was lost is what would present an unknown outcome as a rejection.
  const afterSendAdmitted = lostTimeline.slice(lostTimeline.findIndex((entry) => entry.drafted === "") === -1 ? 0 : lostTimeline.findIndex((entry) => entry.drafted === ""));
  check(afterSendAdmitted.every((entry) => entry.drafted === ""), "admitted: the admitted turn's text is never put back in the composer");
  check(lookupUrls.length > 0, "admitted: the surface asked the conversation about its own submission by request id instead of resending it (" + lookupUrls[0] + ")");
  check(endpoint.requests.length === 1, "admitted: the submission was never sent again");
  check(lostTimeline[lostTimeline.length - 1].unknownShown > 0, "admitted: the statement is still on screen after the loss settled");
  check(lostAudio.length === 0, "admitted: no completion tone is played for an outcome that was never established (" + JSON.stringify(lostAudio) + ")");
  const admittedBubbles = await admitted.page.locator(".markdown-user-message").count();
  check(admittedBubbles === 1, "admitted: the admitted turn is in the transcript exactly once (" + admittedBubbles + " user turns)");
  check(admitted.pageErrors.length === 0, "admitted: no page error: " + admitted.pageErrors.join(" | "));
  releaseRead();
  await frames(admitted.page, 10);
  await admitted.context.close();

  // --- Scene 5: an unsent draft survives a hard refresh of the page that is already open. ----------------------
  // The composer's draft belongs to the tab, and the tab's own store is what carries it across a reload: the text and
  // the attached image are put back into the composer the tab was showing, a fresh composer's key included, because
  // that key is per composer and the tab is the only place it can come from. The same scene then rules out the two
  // failures a persisted draft can cause — a sent turn's text coming back, and a reload resending or re-notifying.
  endpoint.reset();
  const handover = await openPage(browser, origin);
  contexts.push(handover.context);
  await handover.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(handover.page);
  const draftText = prompt + " unsent draft";
  await handover.page.locator("textarea").first().fill(draftText);
  await handover.page.locator('input[type="file"][accept="image/*"]').setInputFiles([imagePath]);
  await frames(handover.page, 30);
  check((await composerImageSrc(handover.page)).length === 1, "draft: the image is attached before the refresh");
  await reloadComposer(handover.page);
  check(await composerText(handover.page) === draftText, "draft: the unsent text is back in the composer after a hard refresh (" + JSON.stringify(await composerText(handover.page)) + ")");
  const restoredImages = await composerImageSrc(handover.page);
  check(restoredImages.length === 1 && restoredImages[0] === "data:image/png;base64," + TINY_PNG.toString("base64"), "draft: the attached image is back with its exact bytes after the refresh (" + JSON.stringify(restoredImages.map((src) => src.slice(0, 30))) + ")");
  check(handover.pageErrors.length === 0, "draft: no page error after the refresh: " + handover.pageErrors.join(" | "));

  // Sending clears the draft, so the reload that follows must not put the sent text back: that would present a
  // committed turn as unsent. The submission is the one the click made — nothing is resent — and it rings once.
  const audioBeforeSend = (await handover.page.evaluate(() => window.__subAudio.slice())).length;
  await handover.page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "draft: the refreshed composer's send reached the model exactly once");
  await frames(handover.page, 10);
  check(await composerText(handover.page) === "", "draft: sending clears the composer");
  endpoint.release();
  await handover.page.getByText("recovery answer").first().waitFor({ timeout: 30_000 });
  await frames(handover.page, 60);
  // One completion tone is two oscillator starts; this run was observed live, so it is the one that sounds.
  const audioAfterSend = (await handover.page.evaluate(() => window.__subAudio.slice())).length;
  check(audioAfterSend === audioBeforeSend + 2, "draft: the answered turn rings exactly once (" + audioBeforeSend + " -> " + audioAfterSend + " oscillator starts)");
  await reloadComposer(handover.page);
  check(await composerText(handover.page) === "", "draft: a sent turn's text is not resurrected into the composer by a reload");
  check((await composerImageSrc(handover.page)).length === 0, "draft: a sent turn's image is not resurrected either");
  check(endpoint.requests.length === 1, "draft: the reload resends nothing (" + endpoint.requests.length + " model request)");
  // The recorder starts again with the reloaded document, so any tone here would be one the reload itself produced:
  // an answered turn already in the transcript must not be re-notified.
  const audioAfterReload = (await handover.page.evaluate(() => window.__subAudio.slice())).length;
  check(audioAfterReload === 0, "draft: the reload plays no completion tone for the already-answered turn (" + audioAfterReload + " oscillator starts)");
  const handoverBubbles = await handover.page.locator(".markdown-user-message").count();
  check(handoverBubbles === 1, "draft: the sent turn is in the transcript exactly once after the reload (" + handoverBubbles + " user turns)");

  // The same store holds an open conversation's composer too, and a draft the user clears stays cleared.
  const sessionUrl = handover.page.url();
  check(sessionUrl.includes("session="), "draft: the reloaded page is on the conversation it sent to (" + sessionUrl + ")");
  const existingText = prompt + " existing draft";
  await handover.page.locator("textarea").first().fill(existingText);
  await frames(handover.page, 20);
  await reloadComposer(handover.page);
  check(await composerText(handover.page) === existingText, "draft: an open conversation's unsent text survives the refresh too");
  await handover.page.locator("textarea").first().fill("");
  await frames(handover.page, 20);
  await reloadComposer(handover.page);
  check(await composerText(handover.page) === "", "draft: text the user removed is not restored by the next reload");
  check(handover.pageErrors.length === 0, "draft: no page error across the scene: " + handover.pageErrors.join(" | "));
  await handover.context.close();

  // --- Scene 6: a shell draft is refused on every busy path, before anything can be staged or sent. --------------
  // The idle send already refuses a `!` draft. The paths that exist only while a run is in flight — Enter, Alt+Enter
  // and the Steer and Follow-up buttons — stage and dispatch through a different seam, so each one is driven here:
  // none may POST, stage a turn or clear the composer, and the same reason the idle path gives must be on screen. The
  // scene then shows the rule is about the draft rather than about being busy: an ordinary draft still queues, and is
  // delivered exactly once when the run it waited behind finishes.
  endpoint.reset();
  const shellDraft = "!pwd";
  const refusal = "does not run shell commands from the composer";
  const shell = await openPage(browser, origin);
  contexts.push(shell.context);
  const shellPosts = [];
  shell.page.on("request", (request) => {
    if (request.method() === "POST" && (request.postData() ?? "").includes('"type":"prompt"')) shellPosts.push(request.url());
  });
  await shell.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(shell.page);
  await shell.page.locator("textarea").first().fill(prompt);
  await frames(shell.page, 5);
  await shell.page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.nextRequest();
  check(endpoint.requests.length === 1, "shell: the run is in flight and holding the model answer");
  check(shellPosts.length === 1, "shell: the running turn is the only prompt POSTed so far (" + shellPosts.length + " prompt POST)");
  await shell.page.locator("textarea").first().fill(shellDraft);
  await frames(shell.page, 10);
  const stagedWhileRunning = await shell.page.locator("[data-pending-submission]").count();
  /** One busy affordance: it must refuse without touching the composer, the queue, the host or the model. */
  const refused = async (label, act) => {
    const requestsBefore = endpoint.requests.length;
    const postsBefore = shellPosts.length;
    await act();
    await frames(shell.page, 20);
    check(shellPosts.length === postsBefore, label + ": nothing was POSTed to the host (" + shellPosts.length + " prompt POST)");
    check(endpoint.requests.length === requestsBefore, label + ": the model was asked nothing");
    check(await shell.page.locator("[data-pending-submission]").count() === stagedWhileRunning, label + ": no turn was staged");
    check(await shell.page.getByRole("button", { name: "Recall to input" }).count() === 0, label + ": nothing entered the queue");
    check(await composerText(shell.page) === shellDraft, label + ": the composer still holds the refused draft (" + JSON.stringify(await composerText(shell.page)) + ")");
    check(await shell.page.getByText(refusal).count() > 0, label + ": the reason is stated on screen");
  };
  await refused("shell enter", () => shell.page.keyboard.press("Enter"));
  await refused("shell alt+enter", () => shell.page.keyboard.press("Alt+Enter"));
  await refused("shell steer button", () => shell.page.getByRole("button", { name: "Steer", exact: true }).click());
  await refused("shell follow-up button", () => shell.page.getByRole("button", { name: "Follow-up", exact: true }).click());

  // The same text with an attachment beside it is an ordinary prompt rather than a command nobody can run
  // (lib/composer-limits.ts states that boundary and the composer's own limit notice follows it), so it queues like
  // any other busy draft — the refusal above is about the shell draft, not a blanket refusal of the composer.
  await shell.page.locator('input[type="file"][accept="image/*"]').setInputFiles([imagePath]);
  await frames(shell.page, 30);
  check((await composerImageSrc(shell.page)).length === 1, "shell: the image is attached to the busy draft");
  await shell.page.keyboard.press("Enter");
  await frames(shell.page, 20);
  check(await composerText(shell.page) === "", "shell: an ordinary busy draft still queues and clears the composer");
  check(await shell.page.getByRole("button", { name: "Recall to input" }).count() === 1, "shell: the ordinary draft is shown as waiting in the queue");
  // A busy draft is admitted by its own POST while the run is still in flight; the queue is what holds its turn, and
  // the model is asked only once the run ahead of it has finished. Both halves are asserted: two prompt POSTs here,
  // one model request, and the second model request arriving after the release rather than before it.
  check(shellPosts.length === 2, "shell: the ordinary busy draft is admitted by its own POST (" + shellPosts.length + " prompt POST)");
  check(endpoint.requests.length === 1, "shell: the model is not asked for the queued turn while the run is in flight (" + endpoint.requests.length + " request)");
  endpoint.release();
  const deliveredDeadline = Date.now() + 30_000;
  while (endpoint.requests.length < 2 && Date.now() < deliveredDeadline) await delay(50);
  check(endpoint.requests.length === 2, "shell: the model saw the queued turn exactly once after the run finished (" + endpoint.requests.length + " request)");
  check(shellPosts.length === 2, "shell: the release sends nothing new (" + shellPosts.length + " prompt POST)");
  await frames(shell.page, 60);
  check(shell.pageErrors.length === 0, "shell: no page error: " + shell.pageErrors.join(" | "));
  await shell.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  console.log("Artifacts kept at " + artifacts);
  if (failures.length > 0) { console.error("UX submission recovery checks FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("UX submission recovery checks PASSED");
}
