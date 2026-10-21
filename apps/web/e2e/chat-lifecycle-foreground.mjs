/**
 * Chat lifecycle, foreground: what the open conversation sounds and shows between Send and the answer.
 *
 * Two proven reds are asserted here against the real stack — the production Next build, the real backend and gateway
 * (apps/server/scripts/image-submit-fixture.ts), the real composer, and this script's own OpenAI-completions endpoint
 * held at named barriers, each released by the driver, so a held state is a real in-flight request and never a sleep:
 *
 *   1. a completion tone must not play before the provider is entered;
 *   2. a held conversation read must not keep the surface on Loading when a complete stream projection has arrived.
 *
 * Every scene keeps its negative control, so a passing check says the observation was real rather than vacuous: the
 * tone does play once the answer exists, and with both transports held the surface really is on Loading.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/chat-lifecycle-foreground.mjs
 *        HEPI_CLF_WEB_PORT=<port> HEPI_CLF_BACKEND_PORT=<port> HEPI_CLF_OUT=<dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "chat-lifecycle-foreground-token";
const webPort = Number(process.env.HEPI_CLF_WEB_PORT ?? 43360);
const backendPort = Number(process.env.HEPI_CLF_BACKEND_PORT ?? 44360);
const model = "deepseek-v4.1-flash";
const ANSWER = "FOREGROUND ANSWER";
const prompt = "test";
const outDir = process.env.HEPI_CLF_OUT ?? join(repoRoot, ".scratch", "chat-lifecycle", "foreground");
/**
 * The conversation read itself: `/api/sessions/<id>` with no query, and neither the state read, the older-history
 * page nor the sidebar's own document. The Web host forwards the backend's native snapshot, so the read names no
 * deferred content and no tree format — this is the one request these scenes hold.
 */
const CONVERSATION_READ = /\/api\/sessions\/(?!ui-state(?:\?|$))[^/?#]+(?:\?|$)/;
mkdirSync(outDir, { recursive: true });
const timeline = createWriteStream(join(outDir, "timeline.jsonl"), { flags: "a" });
const startedAt = Date.now();
const record = (kind, data = {}) => timeline.write(JSON.stringify({ t: Date.now() - startedAt, kind, ...data }) + "\n");
const artifacts = mkdtempSync(join(tmpdir(), "hepi-clf-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
assert.ok(readFileSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");
console.log("Artifacts: " + artifacts + "\nTimeline: " + join(outDir, "timeline.jsonl"));

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok   " + message); record("check", { ok: true, message }); return true; }
  failures.push(message); console.log("  FAIL " + message); record("check", { ok: false, message });
  return false;
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

/**
 * The controlled model endpoint. Each stage of one answer waits on its own named barrier and the driver opens it, so a
 * held provider is a real in-flight request. Barrier arrival is recorded with its own timestamp.
 */
const BARRIERS = ["modelreqseen", "admission", "beforefirsttoken", "firsttoken", "finalanswer"];
function gatedEndpoint() {
  const gates = new Map();
  const requests = [];
  const gateFor = (name) => {
    if (!gates.has(name)) {
      let arrive; let open;
      const arrived = new Promise((r) => { arrive = r; });
      const opened = new Promise((r) => { open = r; });
      gates.set(name, { name, arrived, opened, arrive, open, arrivedAt: null, openedAt: null, auto: false });
    }
    return gates.get(name);
  };
  const arrive = (name) => {
    const gate = gateFor(name);
    if (gate.arrivedAt !== null) return;
    gate.arrivedAt = Date.now(); gate.arrive(); record("barrier", { name, phase: "arrived" });
    if (gate.auto) open(name);
  };
  const pass = async (name) => { const gate = gateFor(name); if (gate.auto) return; await gate.opened; };
  const open = (name) => { const gate = gateFor(name); if (gate.openedAt === null) { gate.openedAt = Date.now(); gate.open(); record("barrier", { name, phase: "released" }); } };
  const auto = (name) => { const gate = gateFor(name); gate.auto = true; open(name); };
  const autoAll = () => { for (const name of BARRIERS) auto(name); };

  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", () => {});
    request.on("end", () => { void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ at: Date.now() - startedAt, body });
      record("model.request", { n: requests.length, messages: (body.messages ?? []).length });
      const write = (text) => { try { response.write(text); return true; } catch { return false; } };
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      arrive("modelreqseen");
      await pass("modelreqseen");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.flushHeaders();
      write(frame({ id: "chatcmpl-clf", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      arrive("admission");
      await pass("admission");
      arrive("beforefirsttoken");
      await pass("beforefirsttoken");
      write(frame({ id: "chatcmpl-clf", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] }));
      arrive("firsttoken");
      await pass("firsttoken");
      write(frame({ id: "chatcmpl-clf", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      write("data: [DONE]\n\n");
      response.end();
      arrive("finalanswer");
    })().catch((error) => { record("model.error", { message: String(error) }); try { response.end(); } catch { /* already gone */ } }); });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({
        origin: "http://127.0.0.1:" + address.port,
        get requests() { return requests; },
        wait: (name) => gateFor(name).arrived,
        open,
        autoAll,
        reset: () => { gates.clear(); requests.length = 0; },
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

/**
 * Observation only: the driver records the application's own decisions to make a sound, every SSE frame the surface
 * received, and a per-frame sample of what the user can see. No handler is replaced and no value is changed.
 *
 * The conversation stream is read through `fetch` by the shared browser transport, so it is recorded there: a response
 * whose content type is `text/event-stream` is passed through a stream this recorder reads first, so each frame is
 * stored under the name the backend gave it (`event`) with its payload (`data`) **before** the surface receives the
 * same bytes. That is what makes "the tone followed the fact" a statement about one order rather than about two
 * independent readers of one stream.
 */
const RECORDER = () => {
  window.__clfFrames = [];
  window.__clfAudio = [];
  window.__clfSse = [];
  window.__clfHttp = [];
  const observeStream = (url, response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const body = new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) { controller.close(); return; }
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          let event = "message";
          const data = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (data.length === 0) continue;
          window.__clfSse.push({ t: Math.round(performance.now()), url: String(url), event, data: JSON.parse(data.join("\n")) });
        }
        controller.enqueue(chunk.value);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const OriginalFetch = window.fetch;
  window.fetch = function recordingFetch(input) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    let path = url;
    try { path = new URL(url, location.href).pathname + new URL(url, location.href).search; } catch { /* keep the raw value */ }
    const startedAt = Math.round(performance.now());
    const entry = { t: startedAt, path, doneAt: null, status: null };
    window.__clfHttp.push(entry);
    return OriginalFetch.apply(this, arguments).then(
      (response) => {
        entry.doneAt = Math.round(performance.now()); entry.status = response.status;
        if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) return observeStream(url, response);
        return response;
      },
      (error) => { entry.doneAt = Math.round(performance.now()); entry.status = "error"; throw error; },
    );
  };
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (AudioCtor) {
    // One tone is one playDone call, and it starts its oscillators synchronously in one turn. The recorded timestamps
    // are millisecond-rounded, so two oscillators of one tone can straddle a millisecond boundary and a clock-based
    // grouping would call one tone two. The group is therefore assigned where the call happens: a microtask flush marks
    // the boundary, so oscillators started in the same turn share a group and a later tone gets its own.
    let toneGroup = 0;
    let pending = false;
    const createOscillator = AudioCtor.prototype.createOscillator;
    AudioCtor.prototype.createOscillator = function patchedCreateOscillator() {
      const oscillator = createOscillator.call(this);
      const start = oscillator.start.bind(oscillator);
      oscillator.start = (...args) => {
        window.__clfAudio.push({ t: Math.round(performance.now()), group: toneGroup, freq: oscillator.frequency.value, contextState: this.state });
        if (!pending) {
          pending = true;
          queueMicrotask(() => { toneGroup += 1; pending = false; });
        }
        return start(...args);
      };
      return oscillator;
    };
  }
  const sample = () => {
    const chat = document.querySelector(".chat-content");
    const text = chat ? chat.innerText : "";
    const body = document.body ? document.body.innerText : "";
    window.__clfFrames.push({
      t: Math.round(performance.now()),
      loading: body.includes("Loading session"),
      chatMounted: chat !== null,
      chatText: text.slice(0, 400),
      pending: document.querySelectorAll("[data-pending-submission]").length,
      audio: window.__clfAudio.length,
      notice: (document.querySelector("[data-notice]")?.innerText ?? "").slice(0, 200),
    });
    if (window.__clfFrames.length > 1200) window.__clfFrames.splice(0, window.__clfFrames.length - 1200);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

/**
 * One completion tone is one call to the sound callback; the tone itself is two oscillators started together. The
 * grouping is the recorder's own (one turn of the page's loop is one tone), so a tone whose two oscillators round to
 * adjacent milliseconds is still one tone — the clock is reported, never used to decide what a tone is.
 */
const tones = (audio) => {
  const byGroup = new Map();
  for (const entry of [...audio].sort((left, right) => left.t - right.t)) {
    const group = byGroup.get(entry.group);
    if (group === undefined) byGroup.set(entry.group, { t: entry.t, oscillators: 1 });
    else group.oscillators += 1;
  }
  return [...byGroup.values()].sort((left, right) => left.t - right.t);
};

const frames = (page, count) => page.evaluate((n) => new Promise((done) => {
  let seen = 0;
  const tick = () => { if (++seen >= n) done(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), count);

const snapshot = (page) => page.evaluate(() => ({
  frames: window.__clfFrames.slice(),
  audio: window.__clfAudio.slice(),
  sse: window.__clfSse.slice(),
  http: window.__clfHttp.slice(),
  loading: document.body.innerText.includes("Loading session"),
  chatText: document.querySelector(".chat-content")?.innerText ?? "",
  bodyText: document.body.innerText,
}));

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
  page.on("console", (message) => record("console", { level: message.type(), text: message.text().slice(0, 300) }));
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/api/agent") || url.pathname.startsWith("/api/sessions")) {
      record("http.response", { status: response.status(), path: url.pathname + url.search });
    }
  });
  return { page, context, pageErrors };
}

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
  if (await newButton.isDisabled()) {
    await page.locator(".session-tree-group-actions .session-tree-group-action:first-child").first().click();
    await page.waitForFunction(() => document.querySelector(".sidebar-new-button")?.disabled === false, undefined, { timeout: 30_000 });
  }
  await newButton.click();
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(page, 20);
}

/** Send one message from the composer, held at the provider's next barrier. */
async function sendHeld(page, endpoint, text) {
  await page.locator("textarea").first().fill(text);
  await frames(page, 5);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await endpoint.wait("modelreqseen");
  endpoint.open("modelreqseen");
  await endpoint.wait("admission");
  endpoint.open("admission");
  await endpoint.wait("beforefirsttoken");
}

const sessionIdOf = (page) => {
  const url = new URL(page.url());
  return url.searchParams.get("session");
};

const endpoint = await gatedEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(join(dataDir, "chat-lifecycle-foreground.sqlite"), endpoint);
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

  // --- Scene 1: the first proven red, and the tone that must still come with the answer. --------------------------
  const first = await openPage(browser, origin);
  contexts.push(first.context);
  await first.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(first.page);
  await sendHeld(first.page, endpoint, prompt);
  // The provider is entered and held: the run is live on the wire and cannot answer.
  await frames(first.page, 90);
  const held = await snapshot(first.page);
  // A busy window is stated by either native frame: the baseline and every advance carry the run's own flag.
  const heldBusy = held.sse.filter((frame) => (frame.event === "snapshot" || frame.event === "state") && frame.data.busy === true);
  record("scene1.held", { loading: held.loading, pending: held.frames.at(-1)?.pending ?? null, audio: held.audio, busyFrames: heldBusy.length });
  check(held.audio.length === 0, "scene1: no completion tone while the provider is held before its first token (" + JSON.stringify(held.audio) + ")");
  check(heldBusy.length > 0, "scene1 control: the run really is live on the wire while the provider is held (" + heldBusy.length + " busy frames)");
  check(held.chatText.includes(prompt), "scene1: the sent turn is still on screen while the provider is held");
  check(!held.loading, "scene1: the held run does not put the surface back on Loading");
  endpoint.autoAll();
  await first.page.getByText(ANSWER).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await frames(first.page, 90);
  const answered = await snapshot(first.page);
  const answerFrame = answered.frames.find((frame) => frame.chatText.includes(ANSWER));
  // The runtime's own terminal fact: the input settled done carrying the answer it produced. The tone is keyed by that
  // answer, so it can only follow this frame, and the committed entry travels in the same fact.
  const terminal = answered.sse.find((frame) => frame.event === "submission" && frame.data.status === "done" && frame.data.answerId !== undefined);
  record("scene1.answered", { answerAt: answerFrame?.t ?? null, terminal: terminal?.data ?? null, terminalAt: terminal?.t ?? null, audio: answered.audio, chatText: answered.chatText.slice(0, 200) });
  check(Boolean(answerFrame), "scene1: the answer reached the screen");
  const answerTones = tones(answered.audio);
  record("scene1.tones", { answerTones });
  check(answerTones.length === 1, "scene1 control: exactly one completion tone once the answer exists (" + JSON.stringify(answerTones) + ")");
  check(Boolean(terminal), "scene1 control: the conversation stated a terminal answer fact on the wire");
  check(Boolean(terminal) && answerTones[0].t >= terminal.t, "scene1: the tone followed the terminal answer fact rather than preceding it");
  check(first.pageErrors.length === 0, "scene1: no page error: " + first.pageErrors.join(" | "));
  const sessionId = sessionIdOf(first.page);
  check(Boolean(sessionId), "scene1: the conversation was promoted to a session (" + sessionId + ")");
  writeFileSync(join(outDir, "scene1.json"), JSON.stringify({ held, answered }, null, 1));
  await first.context.close();

  // --- Scene 2: the second proven red, with both transports held as its control. ---------------------------------
  endpoint.reset();
  const held2 = await openPage(browser, origin);
  contexts.push(held2.context);
  let releaseRead;
  const readGate = new Promise((resolveGate) => { releaseRead = resolveGate; });
  let readSeen;
  const readSeenPromise = new Promise((resolveSeen) => { readSeen = resolveSeen; });
  let heldReadRequests = 0;
  // The conversation read carries no query any more: the Web host forwards the backend's own snapshot rather than
  // naming deferred content and a tree format for it, so the read is `/api/sessions/<id>` itself. The pattern still
  // excludes the catalogue, the state read, the context page and the sidebar's own document.
  await held2.page.route(CONVERSATION_READ, async (route) => {
    heldReadRequests += 1;
    readSeen();
    await readGate;
    await route.continue();
  });
  await held2.page.goto(origin + "/?session=" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
  await readSeenPromise;
  await frames(held2.page, 90);
  const heldRead = await snapshot(held2.page);
  record("scene2.heldRead", { loading: heldRead.loading, chatText: heldRead.chatText.slice(0, 200), heldReadRequests });
  check(heldReadRequests > 0, "scene2 control: the conversation read really is held (" + heldReadRequests + " requests)");
  check(heldRead.loading === false, "scene2: the held conversation read does not hold the surface on Loading");
  check(heldRead.chatText.includes(ANSWER), "scene2: the transcript arrived from the stream's projection while the read was held");
  releaseRead();
  await frames(held2.page, 90);
  const released = await snapshot(held2.page);
  check(!released.loading && released.chatText.includes(ANSWER), "scene2: releasing the read does not regress the view");
  check(held2.pageErrors.length === 0, "scene2: no page error: " + held2.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene2.json"), JSON.stringify({ heldRead, released }, null, 1));
  await held2.context.close();

  // --- Scene 2 control: with both transports held there is nothing to project, so Loading is the honest state. ---
  const both = await openPage(browser, origin);
  contexts.push(both.context);
  let releaseBoth;
  const bothGate = new Promise((resolveGate) => { releaseBoth = resolveGate; });
  let streamSeen;
  const streamSeenPromise = new Promise((resolveSeen) => { streamSeen = resolveSeen; });
  await both.page.route(CONVERSATION_READ, async (route) => { await bothGate; await route.continue(); });
  await both.page.route(/\/api\/agent\/[^/]+\/events/, async (route) => { streamSeen(); await bothGate; await route.continue(); });
  await both.page.goto(origin + "/?session=" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
  await streamSeenPromise;
  await frames(both.page, 90);
  const bothHeld = await snapshot(both.page);
  record("scene2.bothHeld", { loading: bothHeld.loading, chatText: bothHeld.chatText.slice(0, 120) });
  check(bothHeld.loading === true, "scene2 control: with the stream held too the surface is on Loading, so the transcript above came from the stream");
  check(!bothHeld.chatText.includes(ANSWER), "scene2 control: with both transports held the transcript is not shown");
  releaseBoth();
  await frames(both.page, 90);
  check(both.pageErrors.length === 0, "scene2 control: no page error: " + both.pageErrors.join(" | "));
  await both.context.close();

  // --- Scene 3: an abort is not a success, and its reason is shown. ----------------------------------------------
  endpoint.reset();
  const aborted = await openPage(browser, origin);
  contexts.push(aborted.context);
  await aborted.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(aborted.page);
  await sendHeld(aborted.page, endpoint, prompt);
  await frames(aborted.page, 60);
  await aborted.page.getByRole("button", { name: "Stop", exact: true }).click();
  await frames(aborted.page, 120);
  const stopped = await snapshot(aborted.page);
  const abortedFact = stopped.sse.find((frame) => frame.event === "submission" && (frame.data.status === "unanswered" || frame.data.status === "done"));
  record("scene3.stopped", { terminal: abortedFact?.data ?? null, audio: stopped.audio, bodyTail: stopped.bodyText.split("\n").filter(Boolean).slice(-6) });
  check(abortedFact?.data.status === "unanswered", "scene3 control: the aborted submission settled as unanswered on the wire");
  check(stopped.audio.length === 0, "scene3: an aborted run plays no completion tone (" + JSON.stringify(stopped.audio) + ")");
  check((abortedFact?.data.reason ?? "").length > 0 && stopped.bodyText.includes(abortedFact.data.reason), "scene3: the reason the runtime gave is shown to the user (" + JSON.stringify(abortedFact?.data.reason) + ")");
  check(aborted.pageErrors.length === 0, "scene3: no page error: " + aborted.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene3.json"), JSON.stringify(stopped, null, 1));
  await aborted.context.close();

  // --- Scene 4: a steer group sharing one answer sounds once. ----------------------------------------------------
  endpoint.reset();
  const group = await openPage(browser, origin);
  contexts.push(group.context);
  await group.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(group.page);
  await sendHeld(group.page, endpoint, "one");
  await frames(group.page, 30);
  // A second input while the run is live is a steer: it joins the run, and the run settles both inputs with one answer.
  await group.page.locator("textarea").first().fill("two");
  await frames(group.page, 5);
  await group.page.locator("textarea").first().press("Enter");
  await frames(group.page, 60);
  const steered = await snapshot(group.page);
  const admissions = steered.sse.filter((frame) => frame.event === "submission").map((frame) => [frame.data.submissionId, frame.data.status]);
  record("scene4.steered", { admissions, pending: steered.frames.at(-1)?.pending ?? null, audio: steered.audio });
  check(admissions.filter(([, status]) => status === "placed").length >= 1, "scene4 control: the steer joined the run as a placed submission (" + JSON.stringify(admissions) + ")");
  check(steered.audio.length === 0, "scene4: no tone while the run carrying the steer is still held");
  endpoint.autoAll();
  await group.page.getByText(ANSWER).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await frames(group.page, 120);
  const grouped = await snapshot(group.page);
  const settled = grouped.sse.filter((frame) => frame.event === "submission" && frame.data.status === "done").map((frame) => [frame.data.submissionId, frame.data.answerId, frame.t]);
  const answerKeys = new Set(settled.map(([, answerId]) => answerId));
  record("scene4.grouped", { settled, answerKeys: [...answerKeys], audio: grouped.audio, chatText: grouped.chatText.slice(0, 200) });
  check(settled.length >= 2, "scene4 control: both inputs of the steer settled on the wire (" + JSON.stringify(settled) + ")");
  // The notice is keyed by the answer, so the number of tones is the number of distinct answers — never one per
  // submission frame — and every tone follows the terminal fact that carried its answer. The shared-answer case (one
  // tone for a whole steer group) is the same rule and is covered at the projection's own seam.
  const groupedTones = tones(grouped.audio);
  check(groupedTones.length === answerKeys.size, "scene4: one tone per distinct answer, never per submission frame (" + JSON.stringify(settled) + " -> " + JSON.stringify(groupedTones) + ")");
  check(groupedTones.every((tone) => settled.some(([, , at]) => at <= tone.t)), "scene4: every tone followed the terminal answer fact it was keyed by");
  check(group.pageErrors.length === 0, "scene4: no page error: " + group.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene4.json"), JSON.stringify({ steered, grouped }, null, 1));
  await group.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  timeline.end();
  appendFileSync(join(outDir, "summary.txt"), (failures.length > 0 ? "FAILED: " + failures.join(" | ") : "PASSED") + "\n");
  console.log("Artifacts kept at " + artifacts);
  if (failures.length > 0) { console.error("chat lifecycle foreground FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("chat lifecycle foreground PASSED");
}
