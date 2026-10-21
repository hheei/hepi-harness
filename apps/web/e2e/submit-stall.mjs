/**
 * Submit-stall browser test: the turn shows itself before the work starts.
 *
 * Drives the exact reported path — a fresh conversation, the real composer, the real Next production build, the real
 * backend and a controlled local model endpoint — and records every layer on ONE clock (epoch ms, so the page and the
 * driver agree): click, staged turn on screen, the status the projection states, session creation, SSE acquire
 * (request/open/connected), prompt dispatch, provider entry, first busy frame, first token, answer on screen, plus the
 * rAF gap (a frozen main thread stops sampling) and the per-conversation EventSource count.
 *
 * The contract under test (`.scratch/submit-stall/spec.md`, slice B): the staged turn and a status are on screen from
 * the click, before session creation, the stream handshake and discovery; the status states `preparing` until the
 * projection reports the native run and `waiting_model` only from then; and a failure of session creation states the
 * truth and restores the draft exactly once.
 *
 * No sleeps decide anything: every hold is a real in-flight request released by name.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/submit-stall.mjs
 *        HEPI_SS_WEB_PORT=<port> HEPI_SS_BACKEND_PORT=<port> HEPI_SS_OUT=<dir>
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
const token = "submit-stall-token";
const webPort = Number(process.env.HEPI_SS_WEB_PORT ?? 43660);
const backendPort = Number(process.env.HEPI_SS_BACKEND_PORT ?? 44660);
const model = "deepseek-v4.1-flash";
const ANSWER = "STALL ANSWER";
const prompt = "test";
// Raw logs belong under the git-ignored `.dev/`: the artifacts committed under `.scratch/submit-stall/` are the
// red run's own evidence and a later run must not rewrite them.
const outDir = process.env.HEPI_SS_OUT ?? join(repoRoot, ".dev", "submit-stall");
mkdirSync(outDir, { recursive: true });
const timeline = createWriteStream(join(outDir, "timeline.jsonl"), { flags: "a" });
const record = (kind, data = {}) => timeline.write(JSON.stringify({ t: Date.now(), kind, ...data }) + "\n");
const artifacts = mkdtempSync(join(tmpdir(), "hepi-ss-"));
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

/** The controlled model endpoint: each stage waits on a named barrier the driver opens, so a held provider is real. */
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
      requests.push({ at: Date.now(), body });
      record("model.request", { n: requests.length, messages: (body.messages ?? []).length });
      const write = (text) => { try { response.write(text); return true; } catch { return false; } };
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      arrive("modelreqseen");
      await pass("modelreqseen");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.flushHeaders();
      write(frame({ id: "chatcmpl-ss", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      arrive("admission");
      await pass("admission");
      arrive("beforefirsttoken");
      await pass("beforefirsttoken");
      write(frame({ id: "chatcmpl-ss", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] }));
      arrive("firsttoken");
      await pass("firsttoken");
      write(frame({ id: "chatcmpl-ss", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
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
 * Observation only. Every entry carries an absolute epoch-ms timestamp, so the page's DOM samples, the page's HTTP and
 * stream frames and the driver's own endpoint events share one timeline. Nothing is decided from a sleep.
 *
 * The conversation stream is read through `fetch` by the shared browser transport, so it is recorded there: a request
 * under `/api/agent/` whose answer is `text/event-stream` is one source, and every frame it carries is stored under
 * the name the backend gave it with its payload.
 */
const RECORDER = () => {
  window.__ss = { frames: [], http: [], sse: [], sources: [], clicks: [], gaps: [] };
  const stamp = () => Date.now();
  // The stream is passed through a reader this recorder owns, so every frame is stored **before** the surface receives
  // the same bytes: the timeline it builds is one order of events, not two independent readers of one stream.
  const observeStream = (path, response) => {
    const entry = { t: stamp(), path, opened: true, openedAt: stamp(), connectedAt: null, errorAt: null, frames: 0 };
    window.__ss.sources.push(entry);
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
          const payload = JSON.parse(data.join("\n"));
          entry.frames += 1;
          if (event === "snapshot" || event === "state") {
            if (entry.connectedAt === null) entry.connectedAt = stamp();
            window.__ss.sse.push({ t: stamp(), path, event, busy: payload.busy ?? null, status: null, projectionId: payload.projectionId ?? null, revision: payload.revision ?? null, run: payload.run === undefined ? undefined : (payload.run === null ? null : (payload.run.inputs?.length ?? 0)) });
          } else if (event === "submission") {
            window.__ss.sse.push({ t: stamp(), path, event, busy: null, status: payload.status ?? null, projectionId: null, revision: null, run: undefined });
          }
        }
        controller.enqueue(chunk.value);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const OriginalFetch = window.fetch;
  window.fetch = function recordingFetch(input, init) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    let path = url;
    try { path = new URL(url, location.href).pathname + new URL(url, location.href).search; } catch { /* keep raw */ }
    const body = typeof init?.body === "string" ? init.body.slice(0, 120) : null;
    const entry = { t: stamp(), path, body, method: init?.method ?? "GET", doneAt: null, status: null };
    window.__ss.http.push(entry);
    return OriginalFetch.apply(this, arguments).then(
      (response) => {
        entry.doneAt = stamp(); entry.status = response.status;
        if (path.startsWith("/api/agent/") && (response.headers.get("content-type") ?? "").startsWith("text/event-stream")) return observeStream(path, response);
        return response;
      },
      (error) => { entry.doneAt = stamp(); entry.status = "error"; throw error; },
    );
  };
  const OriginalEventSource = window.EventSource;
  if (OriginalEventSource) {
    const Recording = function (url, init) {
      const source = new OriginalEventSource(url, init);
      let path = String(url);
      try { path = new URL(String(url), location.href).pathname; } catch { /* keep raw */ }
      const entry = { t: stamp(), path, opened: false, connectedAt: null, errorAt: null, frames: 0 };
      window.__ss.sources.push(entry);
      source.addEventListener("open", () => { entry.opened = true; entry.openedAt = stamp(); });
      source.addEventListener("error", () => { entry.errorAt = stamp(); });
      source.addEventListener("message", (message) => {
        entry.frames += 1;
        let event = null;
        try { event = JSON.parse(message.data); } catch { /* not json */ }
        window.__ss.sse.push({ t: stamp(), path, event: "message", type: event?.type ?? null, busy: event?.busy ?? null, status: event?.submission?.status ?? null, projectionId: event?.projectionId ?? null, revision: event?.revision ?? null, run: event?.run === undefined ? undefined : (event.run === null ? null : (event.run.inputs?.length ?? 0)) });
        if (event?.type === "connected") entry.connectedAt = stamp();
      });
      return source;
    };
    Recording.CONNECTING = OriginalEventSource.CONNECTING;
    Recording.OPEN = OriginalEventSource.OPEN;
    Recording.CLOSED = OriginalEventSource.CLOSED;
    Recording.prototype = OriginalEventSource.prototype;
    window.EventSource = Recording;
  }
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button");
    if (!button) return;
    window.__ss.clicks.push({ t: stamp(), label: (button.getAttribute("aria-label") || button.textContent || "").trim().slice(0, 40) });
  }, true);
  let last = stamp();
  const sample = () => {
    const chat = document.querySelector(".chat-content");
    const text = chat ? chat.innerText : "";
    const body = document.body ? document.body.innerText : "";
    const now = stamp();
    // A frozen main thread stops sampling: the gap is the freeze, measured rather than inferred.
    if (now - last > 150) window.__ss.gaps.push({ from: last, to: now, ms: now - last });
    last = now;
    // The status is read from the element the surface renders it in, not from prose: `data-agent-status` is the phase
    // the projection stated, so a frame that shows a live run and no status is visible as exactly that.
    const status = document.querySelector("[data-agent-status]");
    window.__ss.frames.push({
      t: now,
      loading: body.includes("Loading session"),
      chatMounted: chat !== null,
      chatText: text.slice(0, 300),
      pending: document.querySelectorAll("[data-pending-submission]").length,
      statusKind: status === null ? null : status.getAttribute("data-agent-status"),
      statusText: status === null ? null : (status.textContent ?? "").trim() || null,
      composerValue: document.querySelector("textarea")?.value ?? null,
      sendDisabled: document.querySelector('button[aria-label="Send"], button[aria-label="Stop"]')?.disabled ?? null,
    });
    if (window.__ss.frames.length > 4000) window.__ss.frames.splice(0, window.__ss.frames.length - 4000);
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

const frames = (page, count) => page.evaluate((n) => new Promise((done) => {
  let seen = 0;
  const tick = () => { if (++seen >= n) done(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), count);

const snapshot = (page) => page.evaluate(() => ({
  frames: window.__ss.frames.slice(),
  http: window.__ss.http.slice(),
  sse: window.__ss.sse.slice(),
  sources: window.__ss.sources.slice(),
  clicks: window.__ss.clicks.slice(),
  gaps: window.__ss.gaps.slice(),
  bodyText: document.body.innerText.slice(0, 800),
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
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => record("console", { level: message.type(), text: message.text().slice(0, 300) }));
  return { page, context, pageErrors };
}

/** Open a fresh composer in a project: the reported path is a new conversation, not a follow-up. */
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

/** Type the prompt and click the real Send button. Returns nothing: the page's own click listener stamps the time. */
async function typeAndSend(page, text) {
  const box = page.locator("textarea").first();
  await box.fill(text);
  await frames(page, 5);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const sessionIdOf = (page) => new URL(page.url()).searchParams.get("session");

/** The per-layer timings, read off the one clock. Everything is a first occurrence after the click. */
function layers(snapshotValue, clickT) {
  const after = (list, predicate) => list.filter((entry) => entry.t >= clickT).find(predicate) ?? null;
  const click = snapshotValue.clicks.filter((entry) => entry.t >= clickT - 50).find((entry) => /Send/i.test(entry.label)) ?? null;
  const pendingFrame = after(snapshotValue.frames, (frame) => frame.pending > 0);
  const statusFrame = after(snapshotValue.frames, (frame) => frame.statusText !== null);
  const create = after(snapshotValue.http, (entry) => entry.path.startsWith("/api/agent/new"));
  const sseRequest = after(snapshotValue.sources, () => true);
  // The handshake is the first window the transport folded: the baseline frame is what says the attachment is up.
  const connected = after(snapshotValue.sse, (entry) => entry.event === "snapshot" || entry.event === "state");
  const promptPost = after(snapshotValue.http, (entry) => /^\/api\/agent\/[^/]+$/.test(entry.path) && entry.method === "POST" && (entry.body ?? "").includes('"prompt"'));
  const busy = after(snapshotValue.sse, (entry) => (entry.event === "snapshot" || entry.event === "state") && entry.busy === true);
  const placed = after(snapshotValue.sse, (entry) => entry.event === "submission" && entry.status === "placed");
  const answerFrame = after(snapshotValue.frames, (frame) => frame.chatText.includes(ANSWER));
  return {
    clickT: click?.t ?? null,
    stageMs: pendingFrame === null ? null : pendingFrame.t - (click?.t ?? clickT),
    statusMs: statusFrame === null ? null : statusFrame.t - (click?.t ?? clickT),
    createStartMs: create === null ? null : create.t - (click?.t ?? clickT),
    createDoneMs: create === null || create.doneAt === null ? null : create.doneAt - (click?.t ?? clickT),
    sseRequestMs: sseRequest === null ? null : sseRequest.t - (click?.t ?? clickT),
    sseConnectedMs: connected === null ? null : connected.t - (click?.t ?? clickT),
    promptStartMs: promptPost === null ? null : promptPost.t - (click?.t ?? clickT),
    promptDoneMs: promptPost === null || promptPost.doneAt === null ? null : promptPost.doneAt - (click?.t ?? clickT),
    promptDoneAt: promptPost === null ? null : promptPost.doneAt,
    busyMs: busy === null ? null : busy.t - (click?.t ?? clickT),
    placedMs: placed === null ? null : placed.t - (click?.t ?? clickT),
    answerMs: answerFrame === null ? null : answerFrame.t - (click?.t ?? clickT),
    maxGapMs: snapshotValue.gaps.length === 0 ? 0 : Math.max(...snapshotValue.gaps.map((gap) => gap.ms)),
    sources: snapshotValue.sources.length,
  };
}

const endpoint = await gatedEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(join(dataDir, "submit-stall.sqlite"), endpoint);
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

  // --- Scene 1: first turn in a fresh conversation, free-running. The baseline for every layer. ------------------
  const first = await openPage(browser, origin);
  contexts.push(first.context);
  await first.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(first.page);
  const click1 = Date.now();
  await typeAndSend(first.page, prompt);
  await endpoint.wait("modelreqseen");
  await frames(first.page, 30);
  const heldAt = Date.now();
  const held = await snapshot(first.page);
  const l1held = layers(held, click1);
  record("scene1.held", { ...l1held, heldAt, prompt: held.frames.at(-1)?.chatText?.slice(0, 80) ?? null });
  check(l1held.stageMs !== null && l1held.stageMs <= 500, "scene1: the staged turn is on screen within 500 ms of Send (" + l1held.stageMs + " ms)");
  check(l1held.statusMs !== null && l1held.statusMs <= 500, "scene1: a status is on screen within 500 ms of Send (" + l1held.statusMs + " ms)");
  // The free-running window the user reported: the send is dispatched and the run is live, and the surface is silent.
  check(l1held.statusMs !== null && l1held.busyMs !== null && l1held.statusMs <= l1held.busyMs, "scene1: the status is on screen before the run's first busy frame (" + l1held.statusMs + " ms <= " + l1held.busyMs + " ms)");
  check(l1held.promptStartMs !== null, "scene1: the prompt was dispatched");
  check(l1held.promptStartMs !== null && l1held.promptStartMs <= 5000, "scene1: the prompt was dispatched within 5 s of Send (" + l1held.promptStartMs + " ms)");
  check(l1held.sseConnectedMs !== null && l1held.promptStartMs !== null && l1held.promptStartMs >= l1held.sseConnectedMs, "scene1: the prompt followed the stream's connected frame (" + l1held.sseConnectedMs + " -> " + l1held.promptStartMs + " ms)");
  endpoint.autoAll();
  await first.page.getByText(ANSWER).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await frames(first.page, 60);
  const answered = await snapshot(first.page);
  const l1 = layers(answered, click1);
  record("scene1.answered", l1);
  check(l1.answerMs !== null, "scene1: the answer reached the screen (" + l1.answerMs + " ms)");
  check(l1.maxGapMs <= 500, "scene1: the main thread never froze for more than 500 ms (max rAF gap " + l1.maxGapMs + " ms)");
  check(l1.sources === 1, "scene1: one stream for one conversation (" + l1.sources + ")");
  check(first.pageErrors.length === 0, "scene1: no page error: " + first.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene1.json"), JSON.stringify({ held, answered, l1held, l1 }, null, 1));
  const sessionId = sessionIdOf(first.page);
  check(Boolean(sessionId), "scene1: the conversation was promoted (" + sessionId + ")");

  // --- Scene 2: the same first turn, but the stream handshake is held. Deterministic, no sleep. -----------------
  endpoint.reset();
  const gated = await openPage(browser, origin);
  contexts.push(gated.context);
  let releaseStream;
  const streamGate = new Promise((resolveGate) => { releaseStream = resolveGate; });
  let streamSeen;
  const streamSeenPromise = new Promise((resolveSeen) => { streamSeen = resolveSeen; });
  let streamRequests = 0;
  await gated.page.route(/\/api\/agent\/[^/]+\/events/, async (route) => {
    streamRequests += 1;
    record("scene2.streamHeld", { n: streamRequests });
    streamSeen();
    await streamGate;
    await route.continue();
  });
  await gated.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(gated.page);
  const click2 = Date.now();
  await typeAndSend(gated.page, prompt);
  await streamSeenPromise;
  await frames(gated.page, 60);
  const heldStream = await snapshot(gated.page);
  const l2 = layers(heldStream, click2);
  const frames2 = heldStream.frames.filter((frame) => frame.t >= click2);
  const firstStatus2 = frames2.find((frame) => frame.statusText !== null) ?? null;
  record("scene2.heldStream", { ...l2, streamRequests, body: heldStream.bodyText.slice(0, 300) });
  check(streamRequests > 0, "scene2 control: the stream request really is held (" + streamRequests + ")");
  check(l2.stageMs !== null && l2.stageMs <= 500, "scene2: the staged turn is on screen while the stream is held (" + l2.stageMs + " ms)");
  check(l2.statusMs !== null && l2.statusMs <= 500, "scene2: a status is on screen while the stream is held (" + l2.statusMs + " ms)");
  // Nothing about a slow attach may be silent, and nothing may claim a run the projection has not reported.
  check(firstStatus2 !== null && frames2.filter((frame) => frame.t >= firstStatus2.t).every((frame) => frame.statusText !== null && frame.statusKind === "preparing"), "scene2: the status is on screen for the whole held window and never claims a run (" + (firstStatus2 === null ? null : frames2.filter((frame) => frame.t >= firstStatus2.t).length) + " frames)");
  check(l2.promptStartMs === null, "scene2: the prompt is NOT dispatched before the stream handshake (dispatch at " + l2.promptStartMs + " ms)");
  check(l2.maxGapMs <= 500, "scene2: the main thread never froze while the stream was held (max rAF gap " + l2.maxGapMs + " ms)");
  releaseStream();
  await frames(gated.page, 30);
  check(gated.pageErrors.length === 0, "scene2: no page error: " + gated.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene2.json"), JSON.stringify({ heldStream, l2 }, null, 1));
  await gated.context.close();

  // --- Scene 3: the second turn in the conversation scene 1 created. The reported contrast. ----------------------
  endpoint.reset();
  const second = await openPage(browser, origin);
  contexts.push(second.context);
  await second.page.goto(origin + "/?session=" + encodeURIComponent(sessionId), { waitUntil: "domcontentloaded" });
  await second.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(second.page, 30);
  const click3 = Date.now();
  await typeAndSend(second.page, prompt);
  await endpoint.wait("modelreqseen");
  await frames(second.page, 60);
  const followUp = await snapshot(second.page);
  const l3 = layers(followUp, click3);
  record("scene3.followUp", l3);
  check(l3.stageMs !== null && l3.stageMs <= 500, "scene3: the second turn's staged turn is on screen within 500 ms (" + l3.stageMs + " ms)");
  check(l3.statusMs !== null && l3.statusMs <= 500, "scene3: the second turn's status is on screen within 500 ms (" + l3.statusMs + " ms)");
  check(l3.promptStartMs !== null && l3.promptStartMs <= 5000, "scene3: the second turn's prompt was dispatched (" + l3.promptStartMs + " ms)");
  check(l3.createStartMs === null, "scene3 control: the second turn created no session (create at " + l3.createStartMs + " ms)");
  check(second.pageErrors.length === 0, "scene3: no page error: " + second.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene3.json"), JSON.stringify({ followUp, l3 }, null, 1));
  await second.context.close();

  // --- Scene 4: the refresh contrast. The run is live and held; reload and see what the surface shows and when. ---
  endpoint.reset();
  const refreshed = await openPage(browser, origin);
  contexts.push(refreshed.context);
  await refreshed.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(refreshed.page);
  await typeAndSend(refreshed.page, prompt);
  await endpoint.wait("modelreqseen");
  await frames(refreshed.page, 60);
  const beforeReload = await snapshot(refreshed.page);
  const liveSession = sessionIdOf(refreshed.page);
  record("scene4.beforeReload", { liveSession, pending: beforeReload.frames.at(-1)?.pending ?? null, status: beforeReload.frames.at(-1)?.statusText ?? null, chatText: beforeReload.frames.at(-1)?.chatText?.slice(0, 120) ?? null });
  check(Boolean(liveSession), "scene4 control: the run is live in a real conversation (" + liveSession + ")");
  const reloadT = Date.now();
  await refreshed.page.reload({ waitUntil: "domcontentloaded" });
  await refreshed.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(refreshed.page, 90);
  const afterReload = await snapshot(refreshed.page);
  const reloadStatus = afterReload.frames.find((frame) => frame.t >= reloadT && frame.statusText !== null) ?? null;
  const reloadTurn = afterReload.frames.find((frame) => frame.t >= reloadT && frame.chatText.includes(prompt)) ?? null;
  const reloadPending = afterReload.frames.find((frame) => frame.t >= reloadT && frame.pending > 0) ?? null;
  record("scene4.afterReload", {
    statusMs: reloadStatus === null ? null : reloadStatus.t - reloadT,
    turnMs: reloadTurn === null ? null : reloadTurn.t - reloadT,
    pendingMs: reloadPending === null ? null : reloadPending.t - reloadT,
    maxGapMs: afterReload.gaps.length === 0 ? 0 : Math.max(...afterReload.gaps.map((gap) => gap.ms)),
    status: afterReload.frames.at(-1)?.statusText ?? null,
    pending: afterReload.frames.at(-1)?.pending ?? null,
    chatText: afterReload.frames.at(-1)?.chatText?.slice(0, 160) ?? null,
  });
  check(reloadTurn !== null, "scene4: the live turn is on screen after the reload (" + (reloadTurn === null ? null : reloadTurn.t - reloadT) + " ms)");
  check(reloadStatus !== null, "scene4: the waiting status is on screen after the reload (" + (reloadStatus === null ? null : reloadStatus.t - reloadT) + " ms)");
  check(reloadStatus !== null && reloadStatus.statusKind === "waiting_model", "scene4: the reloaded live run states waiting for the model, not preparation (" + (reloadStatus === null ? null : reloadStatus.statusKind) + ")");
  check(afterReload.gaps.every((gap) => gap.ms <= 500), "scene4: the reload never froze the main thread (max rAF gap " + (afterReload.gaps.length === 0 ? 0 : Math.max(...afterReload.gaps.map((gap) => gap.ms))) + " ms)");
  endpoint.autoAll();
  await frames(refreshed.page, 60);
  check(refreshed.pageErrors.length === 0, "scene4: no page error: " + refreshed.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene4.json"), JSON.stringify({ beforeReload, afterReload, liveSession }, null, 1));
  await refreshed.context.close();

  // --- Scene 5: the first-turn-only step. Session creation is held, so the surface is exactly where a cold attach
  // --- would leave it: the turn staged, the conversation not yet made, and nothing dispatched. ---------------------
  endpoint.reset();
  const creating = await openPage(browser, origin);
  contexts.push(creating.context);
  let releaseCreate;
  const createGate = new Promise((resolveGate) => { releaseCreate = resolveGate; });
  let createSeen;
  const createSeenPromise = new Promise((resolveSeen) => { createSeen = resolveSeen; });
  await creating.page.route(/\/api\/agent\/new$/, async (route) => {
    record("scene5.createHeld", {});
    createSeen();
    await createGate;
    await route.continue();
  });
  await creating.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(creating.page);
  const click5 = Date.now();
  await typeAndSend(creating.page, prompt);
  await createSeenPromise;
  await frames(creating.page, 90);
  const heldCreate = await snapshot(creating.page);
  const l5 = layers(heldCreate, click5);
  record("scene5.heldCreate", { ...l5, body: heldCreate.bodyText.slice(0, 300) });
  const frames5 = heldCreate.frames.filter((frame) => frame.t >= click5);
  const firstStatus5 = frames5.find((frame) => frame.statusText !== null) ?? null;
  check(l5.createStartMs !== null, "scene5 control: session creation really is held (" + l5.createStartMs + " ms)");
  check(l5.stageMs !== null && l5.stageMs <= 500, "scene5: the staged turn is on screen while creation is held (" + l5.stageMs + " ms)");
  check(l5.statusMs !== null && l5.statusMs <= 500, "scene5: a status is on screen while creation is held (" + l5.statusMs + " ms)");
  check(firstStatus5 !== null && frames5.filter((frame) => frame.t >= firstStatus5.t).every((frame) => frame.statusText !== null && frame.statusKind === "preparing"), "scene5: the status is on screen for the whole held window and never claims a run (" + (firstStatus5 === null ? null : frames5.filter((frame) => frame.t >= firstStatus5.t).length) + " frames)");
  check(l5.maxGapMs <= 500, "scene5: the main thread never froze while creation was held (max rAF gap " + l5.maxGapMs + " ms)");
  releaseCreate();
  await frames(creating.page, 30);
  endpoint.autoAll();
  await creating.page.getByText(ANSWER).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await frames(creating.page, 60);
  const created = await snapshot(creating.page);
  const l5done = layers(created, click5);
  record("scene5.done", l5done);
  check(l5done.answerMs !== null, "scene5: the answer arrived once creation was released (" + l5done.answerMs + " ms)");
  check(creating.pageErrors.length === 0, "scene5: no page error: " + creating.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene5.json"), JSON.stringify({ heldCreate, created, l5, l5done }, null, 1));
  await creating.context.close();

  // --- Scene 6: the run is live on the wire and the provider is held before its first token. Does the surface show
  // --- the turn and the status for the whole window, and does a frame ever go missing between the two? -------------
  endpoint.reset();
  const inflight = await openPage(browser, origin);
  contexts.push(inflight.context);
  await inflight.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(inflight.page);
  const click6 = Date.now();
  await typeAndSend(inflight.page, prompt);
  await endpoint.wait("modelreqseen");
  endpoint.open("modelreqseen");
  await endpoint.wait("admission");
  endpoint.open("admission");
  await endpoint.wait("beforefirsttoken");
  await frames(inflight.page, 120);
  const live = await snapshot(inflight.page);
  const l6 = layers(live, click6);
  const liveFrames = live.frames.filter((frame) => frame.t >= click6);
  const clickT6 = l6.clickT ?? click6;
  const dispatchedT = l6.promptDoneAt;
  const busyT = l6.busyMs === null ? null : clickT6 + l6.busyMs;
  const statusT = l6.statusMs === null ? null : clickT6 + l6.statusMs;
  // The gap the user feels: the send is dispatched and the run is live on the wire, but the surface says nothing.
  const dispatchedToStatus = dispatchedT === null || statusT === null ? null : statusT - dispatchedT;
  const dispatchedFrames = dispatchedT === null ? [] : liveFrames.filter((frame) => frame.t >= dispatchedT);
  const silentFrames = dispatchedFrames.filter((frame) => frame.statusText === null);
  const statusFrames6 = liveFrames.filter((frame) => frame.statusText !== null);
  const beforeBusy = busyT === null ? [] : statusFrames6.filter((frame) => frame.t < busyT);
  const afterBusy = busyT === null ? [] : statusFrames6.filter((frame) => frame.t >= busyT);
  record("scene6.inflight", {
    ...l6,
    sampled: liveFrames.length,
    dispatchedToStatus,
    dispatchedSampled: dispatchedFrames.length,
    silent: silentFrames.length,
    firstSilent: silentFrames.length === 0 ? null : silentFrames[0].t - click6,
    lastSilent: silentFrames.length === 0 ? null : silentFrames.at(-1).t - click6,
    beforeBusy: beforeBusy.map((frame) => frame.statusKind),
    afterBusy: afterBusy.map((frame) => frame.statusKind),
    sse: live.sse.map((frame) => [frame.t - click6, frame.event, frame.busy, frame.run]),
  });
  check(l6.busyMs !== null, "scene6 control: the run really is live on the wire (" + l6.busyMs + " ms)");
  check(liveFrames.at(-1).pending > 0 || liveFrames.at(-1).chatText.includes(prompt), "scene6: the turn is on screen while the provider is held");
  check(liveFrames.at(-1).statusText !== null, "scene6: the status is on screen while the provider is held");
  check(silentFrames.length === 0, "scene6: no frame after the dispatch showed a live run with no status (" + silentFrames.length + " of " + dispatchedFrames.length + ")");
  // The waiting model is claimed only from the run itself: every status before the run's first busy frame states
  // preparation, and the run's own phase takes over from it.
  check(beforeBusy.length > 0 && beforeBusy.every((frame) => frame.statusKind === "preparing"), "scene6: every status between the click and the run's first busy frame states preparation (" + beforeBusy.length + " frames)");
  check(afterBusy.some((frame) => frame.statusKind === "waiting_model"), "scene6: waiting for the model is claimed once the run is live on the wire (" + afterBusy.length + " frames)");
  endpoint.autoAll();
  await inflight.page.getByText(ANSWER).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await frames(inflight.page, 60);
  check(inflight.pageErrors.length === 0, "scene6: no page error: " + inflight.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene6.json"), JSON.stringify({ live, l6 }, null, 1));
  await inflight.context.close();

  // --- Scene 7: the stream handshake is held for a sustained window. Nothing about a slow attach may be silent. ---
  endpoint.reset();
  const sustained = await openPage(browser, origin);
  contexts.push(sustained.context);
  let releaseSustained;
  const sustainedGate = new Promise((resolveGate) => { releaseSustained = resolveGate; });
  let sustainedSeen;
  const sustainedSeenPromise = new Promise((resolveSeen) => { sustainedSeen = resolveSeen; });
  await sustained.page.route(/\/api\/agent\/[^/]+\/events/, async (route) => { sustainedSeen(); await sustainedGate; await route.continue(); });
  await sustained.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(sustained.page);
  const click7 = Date.now();
  await typeAndSend(sustained.page, prompt);
  await sustainedSeenPromise;
  await frames(sustained.page, 300);
  const after5s = await snapshot(sustained.page);
  const l7 = layers(after5s, click7);
  const frames7 = after5s.frames.filter((frame) => frame.t >= click7);
  const firstStatus7 = frames7.find((frame) => frame.statusText !== null) ?? null;
  const sustainedFrames = firstStatus7 === null ? [] : frames7.filter((frame) => frame.t >= firstStatus7.t);
  record("scene7.sustained", { ...l7, sampled: frames7.length, windowMs: frames7.at(-1).t - click7, statusFrames: frames7.filter((f) => f.statusText !== null).length, pendingFrames: frames7.filter((f) => f.pending > 0).length, dispatch: l7.promptStartMs });
  check(frames7.at(-1).t - click7 >= 4000, "scene7 control: the window really is sustained (" + (frames7.at(-1).t - click7) + " ms)");
  check(l7.promptStartMs === null, "scene7: a held stream handshake never dispatches the prompt (" + l7.promptStartMs + " ms)");
  check(firstStatus7 !== null, "scene7: a status is on screen during the sustained window (" + frames7.filter((f) => f.statusText !== null).length + " status frames of " + frames7.length + ")");
  check(sustainedFrames.length > 0 && sustainedFrames.every((frame) => frame.statusText !== null && frame.statusKind === "preparing"), "scene7: the status never goes silent and never claims a run for the whole sustained window (" + sustainedFrames.length + " frames)");
  check(frames7.at(-1).pending > 0 && frames7.at(-1).chatText.includes(prompt), "scene7: the staged turn is still the only thing on screen at the end of the window");
  check(after5s.gaps.every((gap) => gap.ms <= 500), "scene7: the sustained window never froze the main thread (max rAF gap " + (after5s.gaps.length === 0 ? 0 : Math.max(...after5s.gaps.map((gap) => gap.ms))) + " ms)");
  releaseSustained();
  await frames(sustained.page, 30);
  check(sustained.pageErrors.length === 0, "scene7: no page error: " + sustained.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene7.json"), JSON.stringify({ after5s, l7 }, null, 1));
  await sustained.context.close();

  // --- Scene 8: session creation fails. The send must say so, not restore the draft as if the user never pressed. --
  endpoint.reset();
  const refused = await openPage(browser, origin);
  contexts.push(refused.context);
  await refused.page.route(/\/api\/agent\/new$/, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the conversation could not be created" }) }));
  await refused.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await openComposer(refused.page);
  const click8 = Date.now();
  await typeAndSend(refused.page, prompt);
  await frames(refused.page, 120);
  const refusedSnap = await snapshot(refused.page);
  const frames8 = refusedSnap.frames.filter((frame) => frame.t >= click8);
  record("scene8.createFailed", {
    sampled: frames8.length,
    stageMs: layers(refusedSnap, click8).stageMs,
    pendingFrames: frames8.filter((f) => f.pending > 0).length,
    lastPending: frames8.filter((f) => f.pending > 0).length === 0 ? null : frames8.filter((f) => f.pending > 0).at(-1).t - click8,
    composerAtEnd: frames8.at(-1).composerValue,
    body: refusedSnap.bodyText.slice(0, 400),
  });
  check(frames8.some((frame) => frame.pending > 0), "scene8: the turn was staged before the failure");
  check(frames8.at(-1).pending === 0, "scene8: a failed creation does not leave a ghost turn");
  check((frames8.at(-1).composerValue ?? "").includes(prompt), "scene8: the failed turn's text is back in the composer (" + JSON.stringify(frames8.at(-1).composerValue) + ")");
  check(/HTTP 500|could not be created|Unable|error|failed/i.test(refusedSnap.bodyText), "scene8: the failure is stated to the user (" + JSON.stringify(refusedSnap.bodyText.split("\n").find((line) => /HTTP 500|could not|error/i.test(line)) ?? "") + ")");
  check(refused.pageErrors.length === 0, "scene8: no page error: " + refused.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene8.json"), JSON.stringify({ refusedSnap }, null, 1));
  await refused.context.close();
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
  if (failures.length > 0) { console.error("submit stall FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("submit stall PASSED");
}
