/**
 * Chat lifecycle, background: what the user is told about a conversation they are not looking at.
 *
 * The stack is the real one — the production Next build, the real backend and gateway
 * (apps/server/scripts/image-submit-fixture.ts), the real catalogue poll and the real page — and the model endpoint is
 * this script's own OpenAI-completions server, which holds every answer until the driver releases it. A held run is
 * therefore a real in-flight request, and nothing here sleeps to wait for a state: the driver waits on evidence it
 * recorded (a request held at its barrier, a poll answer, an SSE frame the page received).
 *
 * What is asserted is the user's own experience of a completion: a tone is a real oscillator start recorded in the
 * page, and it is tied to the terminal fact the conversation stated on the wire. Every scene keeps a negative control,
 * so a passing check says the observation was real rather than vacuous — a held run really is live on the wire, an
 * aborted run really did settle as unanswered, and a conversation with nothing outstanding really has no stream.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/chat-lifecycle-background.mjs
 *        HEPI_CLB_WEB_PORT=<port> HEPI_CLB_BACKEND_PORT=<port> HEPI_CLB_OUT=<dir>
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
const token = "chat-lifecycle-background-token";
const webPort = Number(process.env.HEPI_CLB_WEB_PORT ?? 43390);
const backendPort = Number(process.env.HEPI_CLB_BACKEND_PORT ?? 44390);
const model = "deepseek-v4.1-flash";
const ANSWER = "BACKGROUND ANSWER";
const outDir = process.env.HEPI_CLB_OUT ?? join(repoRoot, ".scratch", "chat-lifecycle", "background");
mkdirSync(outDir, { recursive: true });
const timeline = createWriteStream(join(outDir, "timeline.jsonl"), { flags: "a" });
const startedAt = Date.now();
const record = (kind, data = {}) => timeline.write(JSON.stringify({ t: Date.now() - startedAt, kind, ...data }) + "\n");
const artifacts = mkdtempSync(join(tmpdir(), "hepi-clb-"));
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
/** Wait for a recorded observation, so a held state is the driver's own evidence rather than a sleep. */
async function waitFor(what, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error("timed out waiting for " + what);
}
/**
 * Wait for a condition that is itself one of the things under test, giving up quietly so the check can report it. A
 * driver that threw here would end the run at the first missing behaviour instead of naming every one of them.
 */
async function settle(probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!value && Date.now() < deadline) {
    await delay(50);
    value = await probe();
  }
  return value ?? null;
}

/**
 * The controlled model endpoint. Every request waits until the driver releases it, so the driver decides exactly when
 * an answer exists; a request that has arrived is a real in-flight run on the real provider path.
 */
function gatedEndpoint() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", () => {});
    request.on("end", () => { void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = (body.messages ?? []).map((message) => message.content).join(" | ");
      // A request the driver marks as one that must fail is answered with a provider error, so a run that ends in
      // failure is the provider's own failure on the real path rather than a simulated state.
      if (text.includes("FAIL ME")) {
        record("model.failed", { n: requests.length + 1 });
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "controlled provider failure" } }));
        return;
      }
      let release; let arrive;
      const held = new Promise((r) => { release = r; });
      const arrived = new Promise((r) => { arrive = r; });
      const entry = { n: requests.length + 1, arrived, release, arrivedAt: null, releasedAt: null };
      requests.push(entry);
      record("model.request", { n: entry.n, messages: (body.messages ?? []).length });
      arrive();
      await held;
      const write = (text) => { try { response.write(text); return true; } catch { return false; } };
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.flushHeaders();
      write(frame({ id: "chatcmpl-clb", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      write(frame({ id: "chatcmpl-clb", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }] }));
      write(frame({ id: "chatcmpl-clb", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      write("data: [DONE]\n\n");
      response.end();
      record("model.answered", { n: entry.n });
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
        /** Wait for the nth request to be in flight: a real held run. */
        held: async (n) => {
          await waitFor("model request " + n, async () => {
            const entry = requests[n - 1];
            if (entry === undefined) return false;
            await entry.arrived;
            if (entry.arrivedAt === null) { entry.arrivedAt = Date.now() - startedAt; record("model.held", { n }); }
            return true;
          });
        },
        release: (n) => {
          const entry = requests[n - 1];
          if (entry === undefined || entry.releasedAt !== null) return;
          entry.releasedAt = Date.now() - startedAt; record("model.released", { n });
          entry.release();
        },
        releaseAll: () => { for (const entry of requests) {
          if (entry.releasedAt !== null) continue;
          entry.releasedAt = Date.now() - startedAt; record("model.released", { n: entry.n });
          entry.release();
        } },
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
 * Observation only: the driver records the page's own decision to make a sound, every frame the page received on a
 * conversation stream, and the poll answers it read. No handler is replaced and no value is changed.
 *
 * The conversation stream is read through `fetch` by the shared browser transport, so it is recorded there: a response
 * whose content type is `text/event-stream` is passed through a stream this recorder reads first, so each frame is
 * stored under the name the backend gave it (`event`) with its payload (`data`) **before** the surface receives the
 * same bytes. That is what makes "the tone followed the fact" a statement about one order rather than about two
 * independent readers of one stream. The URL of the request is kept beside each frame, which is what the scenes read to
 * say which conversation it belongs to.
 */
const RECORDER = () => {
  window.__clbAudio = [];
  window.__clbSse = [];
  window.__clbStreams = [];
  window.__clbClosed = [];
  window.__clbPolls = [];
  const observeStream = (url, response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const body = new ReadableStream({
      async pull(controller) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          // The page tore the response down: the reader above must see it too, and the close is recorded where it
          // happened so "the page holds nothing for this conversation" is read from the page rather than inferred.
          window.__clbClosed.push({ t: Math.round(performance.now()), url: String(url), error: true });
          controller.error(error);
          return;
        }
        if (chunk.done) { window.__clbClosed.push({ t: Math.round(performance.now()), url: String(url), error: false }); controller.close(); return; }
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
          window.__clbSse.push({ t: Math.round(performance.now()), url: String(url), event, data: JSON.parse(data.join("\n")) });
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
    return OriginalFetch.apply(this, arguments).then((response) => {
      if ((response.headers.get("content-type") ?? "").startsWith("text/event-stream")) {
        window.__clbStreams.push({ t: Math.round(performance.now()), url: String(url) });
        return observeStream(url, response);
      }
      if (path.startsWith("/api/agent/running") || path.startsWith("/api/sessions")) {
        response.clone().json().then((body) => {
          window.__clbPolls.push({ t: Math.round(performance.now()), path, runningSessionIds: body?.runningSessionIds ?? null });
        }).catch(() => {});
      }
      return response;
    });
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
        window.__clbAudio.push({ t: Math.round(performance.now()), group: toneGroup, freq: oscillator.frequency.value });
        if (!pending) {
          pending = true;
          queueMicrotask(() => { toneGroup += 1; pending = false; });
        }
        return start(...args);
      };
      return oscillator;
    };
  }
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
/**
 * The tones that started after the audio already recorded, so each scene counts only its own. A count of what came
 * before is the boundary rather than a timestamp: a tone and the frame that caused it can share a millisecond, and a
 * time-based mark would then attribute the previous scene's tone to the next one.
 */
const tonesAfter = (audio, index) => tones(audio.slice(index));

/** The sidebar's shared document: the unread markers are read back from it, not from a page-local set. */
const uiState = (page) => page.evaluate(async () => (await (await fetch("/api/sessions/ui-state", { cache: "no-store" })).json()).state);
/** The ids carrying an unread marker in that document. */
const unreadIds = async (page) => new Set(Object.entries((await uiState(page)).sessions ?? {})
  .filter(([, family]) => family.unreadAt !== undefined)
  .map(([id]) => id));

const frames = (page, count) => page.evaluate((n) => new Promise((done) => {
  let seen = 0;
  const tick = () => { if (++seen >= n) done(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}), count);

const snapshot = (page) => page.evaluate(() => ({
  audio: window.__clbAudio.slice(),
  sse: window.__clbSse.slice(),
  streams: window.__clbStreams.slice(),
  closed: window.__clbClosed.slice(),
  polls: window.__clbPolls.slice(),
  url: location.href,
}));

/** The conversation ids the page has ever opened a stream for. */
const streamedConversations = (streams) => new Set(streams
  .map((entry) => { try { return new URL(entry.url, "http://page").pathname.split("/")[3]; } catch { return null; } })
  .filter(Boolean));
/** Every frame the page received for one conversation, as the backend named it. */
const framesFor = (sse, conversationId) => sse.filter((frame) => frame.url.includes("/" + conversationId + "/"));
/** The terminal lifecycle facts: the submissions the runtime settled, with the answer each was answered by. */
const terminalFacts = (sse, conversationId) => framesFor(sse, conversationId)
  .filter((frame) => frame.event === "submission" && (frame.data.status === "done" || frame.data.status === "unanswered"))
  .map((frame) => ({ at: frame.t, submissionId: frame.data.submissionId, status: frame.data.status, answerId: frame.data.answerId ?? null }));
/** The windows the conversation stated: its baseline and every advance, which is what "acquired" is read from. */
const stateFrames = (sse, conversationId) => framesFor(sse, conversationId).filter((frame) => frame.event === "snapshot" || frame.event === "state");
/** Every stream the page opened for one conversation, and every one of those it has finished with. */
const streamsFor = (streams, conversationId) => streams.filter((entry) => entry.url.includes("/" + conversationId + "/"));
const closedFor = (closed, conversationId) => closed.filter((entry) => entry.url.includes("/" + conversationId + "/"));

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

const endpoint = await gatedEndpoint();
const backend = (path, init = {}) => fetch("http://127.0.0.1:" + backendPort + path, {
  ...init,
  headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(init.headers ?? {}) },
});
const catalogue = async () => (await (await backend("/api/conversations")).json()).conversations;
const createConversation = async () => {
  const response = await backend("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
  assert.equal(response.status, 201, "the driver created a conversation: " + response.status);
  return (await response.json()).conversationId;
};
const submit = async (conversationId, text, whenBusy) => {
  const response = await backend("/api/conversations/" + encodeURIComponent(conversationId) + "/messages", {
    method: "POST",
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId, text, requestId: "req-" + conversationId + "-" + Math.random().toString(36).slice(2), ...(whenBusy === undefined ? {} : { whenBusy }) }),
  });
  assert.equal(response.status, 202, "the driver submitted " + JSON.stringify(text) + ": " + response.status + " " + (await response.text()));
};
const settledRun = (conversationId) => waitFor("run " + conversationId + " to settle",
  async () => (await catalogue()).find((entry) => entry.id === conversationId)?.busy === false);

let browser;
let backendChild;
const contexts = [];
try {
  backendChild = await startBackend(join(dataDir, "chat-lifecycle-background.sqlite"), endpoint);
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

  // --- Preparation: a conversation that finished before the page looked, and one that is simply idle. --------------
  const settled = await createConversation();
  await submit(settled, "settled before the page looked");
  await endpoint.held(1);
  endpoint.release(1);
  await settledRun(settled);
  const idle = await createConversation();

  const session = await openPage(browser, origin);
  contexts.push(session.context);
  await session.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  // Opening a conversation is the app's own restore path: the URL names it, which is what a reload and a copied link
  // do. It is used to put a conversation on screen.
  const openConversation = async (conversationId) => {
    await session.page.goto(origin + "/?session=" + encodeURIComponent(conversationId), { waitUntil: "domcontentloaded" });
    await waitFor("the open conversation " + conversationId, async () => {
      const url = new URL(session.page.url());
      if (url.searchParams.get("session") !== conversationId) return false;
      return session.page.locator(".chat-content").count();
    });
    await frames(session.page, 20);
  };
  /**
   * Switching is the sidebar's own row click — a client-side switch, which is what the handover is about: a page load
   * would destroy the page's in-memory state and prove nothing about it. The row is found by the key the tree gives it,
   * which is the conversation's own identity rather than its title.
   */
  const switchToRow = async (conversationId) => {
    await waitFor("the sidebar rows", () => session.page.locator(".session-tree-row").count().then((count) => count > 0));
    for (let i = 0; i < 20; i += 1) {
      const folded = session.page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
      if (await folded.count() === 0) break;
      await folded.click();
    }
    const row = session.page.locator('.session-tree-row.session-tree-session[data-row-key$=":' + conversationId + '"]').first();
    await row.waitFor({ timeout: 30_000 });
    await row.locator(".session-tree-main").first().click();
    const landed = await waitFor("the switched conversation", async () => {
      const url = new URL(session.page.url());
      return url.searchParams.get("session") === conversationId ? conversationId : null;
    });
    await frames(session.page, 20);
    return landed;
  };

  // --- Scene 1: a foreign run, observed live, sounds once while the user looks at another conversation. -----------
  await openConversation(settled);
  const before1 = await snapshot(session.page);
  const base1 = before1.audio.length;
  check(streamedConversations(before1.streams).has(settled), "scene1 control: the conversation on screen is the one the user selected");
  check(tonesAfter(before1.audio, 0).length === 0, "scene1: opening a conversation with prior history sounds nothing");

  // A run this browser never dispatched: another client submitted it, so the poll is the only thing that can notice it.
  const foreign = await createConversation();
  await submit(foreign, "a foreign run");
  await endpoint.held(2);
  await waitFor("the poll to nominate the foreign run", async () => {
    const poll = (await snapshot(session.page)).polls.filter((entry) => entry.runningSessionIds !== null).at(-1);
    return poll?.runningSessionIds?.includes(foreign) === true;
  });
  // The stream appearing is not the same as its baseline having arrived, so the wait is for both: a check that ran on
  // the connection alone would race the frame it is about.
  const live = await settle(async () => {
    const current = await snapshot(session.page);
    return streamedConversations(current.streams).has(foreign) && stateFrames(current.sse, foreign).length > 0 ? current : null;
  }) ?? await snapshot(session.page);
  record("scene1.acquired", { conversations: [...streamedConversations(live.streams)] });
  check(streamedConversations(live.streams).has(foreign), "scene1: the poll's nomination acquires the conversation it named");
  check(tonesAfter(live.audio, base1).length === 0, "scene1: a run still in flight sounds nothing");
  check(stateFrames(live.sse, foreign).length > 0, "scene1 control: the acquired stream really delivered the conversation's own projection");
  check(!streamedConversations(live.streams).has(idle), "scene1: no stream is opened for a conversation with nothing outstanding");

  endpoint.release(2);
  const answered = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, foreign).length > 0 ? current : null;
  }) ?? await snapshot(session.page);
  const fact = terminalFacts(answered.sse, foreign)[0];
  const tones1 = tonesAfter(answered.audio, base1);
  record("scene1.answered", { fact, tones: tones1 });
  check(fact?.status === "done" && fact.answerId !== null, "scene1 control: the conversation stated a terminal answer fact on the wire");
  check(tones1.length === 1, "scene1: a foreign run's completion sounds exactly once (" + JSON.stringify(tones1) + ")");
  check(Boolean(fact) && tones1.length > 0 && tones1[0].t >= fact.at, "scene1: the tone followed the terminal answer fact it came from");

  // Duplicate delivery: the same completion cannot sound again, however many polls and frames follow it.
  const pollsBefore = answered.polls.length;
  await waitFor("two more polls", async () => (await snapshot(session.page)).polls.length >= pollsBefore + 2);
  await frames(session.page, 30);
  const quiet = await snapshot(session.page);
  record("scene1.quiet", { tones: tonesAfter(quiet.audio, base1), polls: quiet.polls.length });
  check(tonesAfter(quiet.audio, base1).length === 1, "scene1: later polls and re-delivered frames do not sound the same completion again");
  check(await session.page.locator(".session-tree-unread").count() > 0, "scene1: the completion left an unread marker");
  check(session.pageErrors.length === 0, "scene1: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene1.json"), JSON.stringify({ before1, live, answered, quiet }, null, 1));

  // --- Scene 2: leaving a conversation with work in flight keeps its stream, and the handover loses nothing. ------
  await openConversation(idle);
  const before2 = await snapshot(session.page);
  const base2 = before2.audio.length;
  check(streamedConversations(before2.streams).has(idle), "scene2 control: the conversation on screen has its stream");
  await submit(idle, "run the user leaves");
  await endpoint.held(3);
  const switchedTo = await switchToRow(settled);
  const left = await snapshot(session.page);
  record("scene2.switched", { switchedTo });
  record("scene2.left", { conversations: [...streamedConversations(left.streams)], tones: tonesAfter(left.audio, base2) });
  check(tonesAfter(left.audio, base2).length === 0, "scene2: leaving a conversation with a run in flight sounds nothing");
  check(streamedConversations(left.streams).has(idle), "scene2: the conversation that was left is still watched, so its run is not missed");
  check(new URL(left.url).searchParams.get("session") === settled, "scene2 control: the user really switched to another conversation");

  endpoint.release(3);
  const away = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, idle).length > 0 ? current : null;
  }) ?? await snapshot(session.page);
  const tones2 = tonesAfter(away.audio, base2);
  const awayFact = terminalFacts(away.sse, idle)[0];
  record("scene2.away", { fact: awayFact ?? null, tones: tones2 });
  check(Boolean(awayFact), "scene2 control: the conversation the user left stated its terminal fact on the wire");
  check(tones2.length === 1, "scene2: the completion of the conversation the user left sounds once (" + JSON.stringify(tones2) + ")");
  check(Boolean(awayFact) && tones2.length > 0 && tones2[0].t >= awayFact.at, "scene2: that tone followed the terminal fact of the run the user left");

  // Selecting it back is a handover: the same connection serves it, and the same completion is not sounded again.
  await switchToRow(idle);
  await frames(session.page, 60);
  const returned = await snapshot(session.page);
  record("scene2.returned", { tones: tonesAfter(returned.audio, base2), chat: (await session.page.locator(".chat-content").innerText()).slice(0, 120) });
  check(tonesAfter(returned.audio, base2).length === 1, "scene2: selecting the conversation back duplicates no notice");
  check((await session.page.locator(".chat-content").innerText()).includes(ANSWER), "scene2: the answer is on screen after the handover");
  check(session.pageErrors.length === 0, "scene2: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene2.json"), JSON.stringify({ before2, left, away, returned }, null, 1));

  // --- Scene 3: a queued follow-up is its own later run, so its own later notice. --------------------------------
  const followUp = await createConversation();
  await openConversation(settled);
  const before3 = await snapshot(session.page);
  const base3 = before3.audio.length;
  await submit(followUp, "first");
  await endpoint.held(4);
  await submit(followUp, "queued behind it", "followUp");
  await waitFor("the queued input to be admitted", async () => {
    const state = await (await backend("/api/conversations/" + encodeURIComponent(followUp) + "/state")).json();
    return state.submissions?.some((entry) => entry.status === "queued");
  });
  check(Boolean(await settle(async () => {
    const current = await snapshot(session.page);
    return (streamedConversations(current.streams).has(followUp) && stateFrames(current.sse, followUp).length > 0) || null;
  })), "scene3: the queued conversation is acquired, baseline and all, while it still has work");
  endpoint.release(4);
  await endpoint.held(5);
  const firstSettled = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, followUp).some((entry) => entry.status === "done") ? current : null;
  }) ?? await snapshot(session.page);
  const tones3 = tonesAfter(firstSettled.audio, base3);
  record("scene3.first", { facts: terminalFacts(firstSettled.sse, followUp), tones: tones3 });
  check(tones3.length === 1, "scene3: the first answer of a queued pair sounds once (" + JSON.stringify(tones3) + ")");
  endpoint.release(5);
  const bothSettled = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, followUp).filter((entry) => entry.status === "done").length >= 2 ? current : null;
  }) ?? await snapshot(session.page);
  const facts = terminalFacts(bothSettled.sse, followUp);
  const answerKeys = new Set(facts.map((entry) => entry.answerId));
  const tones3b = tonesAfter(bothSettled.audio, base3);
  record("scene3.both", { facts, tones: tones3b, answerKeys: [...answerKeys] });
  check(tones3b.length === answerKeys.size, "scene3: one tone per distinct answer, never one per submission frame");
  check(tones3b.every((tone) => facts.some((entry) => entry.at <= tone.t)), "scene3: every tone followed the terminal fact it was keyed by");
  // Each scene counts the tones of its own window, so a tone of this one arriving late must not be read as the next
  // one's. Nothing sleeps: the wait is for the count this scene already expects.
  await settle(async () => tonesAfter((await snapshot(session.page)).audio, base3).length === answerKeys.size || null);
  check(session.pageErrors.length === 0, "scene3: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene3.json"), JSON.stringify({ firstSettled, bothSettled }, null, 1));

  // --- Scene 4: a run that ends without answering is never a success tone. ---------------------------------------
  const aborted = await createConversation();
  const before4 = await snapshot(session.page);
  const base4 = before4.audio.length;
  await submit(aborted, "abort me in the background");
  await endpoint.held(6);
  // The baseline matters, not just the connection: the abort is dispatched only once the watch is really following the
  // conversation, or the terminal fact would have nothing to arrive on and the scene would prove nothing.
  check(Boolean(await settle(async () => {
    const current = await snapshot(session.page);
    return (streamedConversations(current.streams).has(aborted) && stateFrames(current.sse, aborted).length > 0) || null;
  })), "scene4: the aborted run's conversation is acquired, baseline and all, while it is running");
  const abortResponse = await backend("/api/conversations/" + encodeURIComponent(aborted) + "/abort", { method: "POST" });
  check(abortResponse.status === 202, "scene4 control: the abort was accepted (" + abortResponse.status + ")");
  const stopped = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, aborted).length > 0 ? current : null;
  }) ?? await snapshot(session.page);
  const abortedFact = terminalFacts(stopped.sse, aborted)[0];
  // The run leaves the polled set on its own schedule, so the absence-based path is given a real chance to speak before
  // this scene concludes that nothing was said: the poll must have seen the conversation running and then stopped.
  await waitFor("the poll to see the aborted run", async () => (await snapshot(session.page)).polls.some((entry) => entry.runningSessionIds?.includes(aborted) === true));
  const pollsBefore4 = stopped.polls.length;
  await waitFor("two more polls", async () => (await snapshot(session.page)).polls.length >= pollsBefore4 + 2);
  const settledQuiet = await snapshot(session.page);
  record("scene4.aborted", { fact: abortedFact, tones: tonesAfter(settledQuiet.audio, base4) });
  check(abortedFact?.status === "unanswered", "scene4 control: the aborted submission settled as unanswered on the wire");
  check(tonesAfter(settledQuiet.audio, base4).length === 0, "scene4: an aborted run in the background plays no completion tone");
  check(session.pageErrors.length === 0, "scene4: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene4.json"), JSON.stringify({ stopped, settledQuiet }, null, 1));

  // --- Scene 4b: a run the provider failed is a failure, not a completion. ---------------------------------------
  const failed = await createConversation();
  const before4b = await snapshot(session.page);
  const base4b = before4b.audio.length;
  await submit(failed, "FAIL ME in the background");
  check(Boolean(await settle(async () => {
    const current = await snapshot(session.page);
    return (streamedConversations(current.streams).has(failed) && stateFrames(current.sse, failed).length > 0) || null;
  })), "scene4b: the failed run's conversation is acquired, baseline and all, while it is running");
  await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, failed)[0] ?? null;
  });
  await waitFor("the poll to see the failed run", async () => (await snapshot(session.page)).polls.some((entry) => entry.runningSessionIds?.includes(failed) === true));
  const pollsBefore4b = (await snapshot(session.page)).polls.length;
  await waitFor("two more polls", async () => (await snapshot(session.page)).polls.length >= pollsBefore4b + 2);
  const failedQuiet = await snapshot(session.page);
  record("scene4b.failed", { fact: terminalFacts(failedQuiet.sse, failed)[0], tones: tonesAfter(failedQuiet.audio, base4b) });
  check(terminalFacts(failedQuiet.sse, failed)[0]?.status === "unanswered", "scene4b control: the failed run settled as unanswered on the wire");
  check(tonesAfter(failedQuiet.audio, base4b).length === 0, "scene4b: a run the provider failed plays no completion tone");
  check(session.pageErrors.length === 0, "scene4b: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene4b.json"), JSON.stringify(failedQuiet, null, 1));

  // --- Scene 4c: a queued follow-up survives a leave made before any poll nomination. -----------------------------
  // The race 85 reproduced: the user leaves between the send and the first poll that could nominate the conversation,
  // so nothing but the handover keeps the stream. The first answer then settles one turn while the follow-up is still
  // queued behind it, and a watch that inherited only "unfinished" would read that first terminal fact as the end of
  // the work, close the stream and never see the second answer. The running poll is held for exactly this window, so
  // "before any nomination" is a proven condition: a poll really was attempted and could not answer.
  const queued = await createConversation();
  await openConversation(queued);
  const before4c = await snapshot(session.page);
  const base4c = before4c.audio.length;
  let releasePoll;
  const pollGate = new Promise((resolveGate) => { releasePoll = resolveGate; });
  let pollsHeld = 0;
  await session.page.route(/\/api\/agent\/running/, async (route) => { pollsHeld += 1; await pollGate; await route.continue().catch(() => {}); });
  await submit(queued, "first, then a queued follow-up");
  await endpoint.held(7);
  await submit(queued, "queued behind it", "followUp");
  await waitFor("the queued follow-up to be admitted", async () => {
    const state = await (await backend("/api/conversations/" + encodeURIComponent(queued) + "/state")).json();
    return state.submissions?.some((entry) => entry.status === "queued");
  });
  await waitFor("the running poll to be held", async () => pollsHeld > 0);
  const pollsBefore4c = (await snapshot(session.page)).polls.length;
  await switchToRow(settled);
  const left4c = await snapshot(session.page);
  record("scene4c.polls", { held: pollsHeld, before: pollsBefore4c, after: left4c.polls.length });
  // The control the claim needs: a poll was attempted inside this window and could not answer, so no poll could have
  // named the conversation running. Nothing else about the poll's timing is asserted, because nothing else is claimed.
  check(pollsHeld > 0, "scene4c control: a running poll really was attempted while the user was leaving");
  check(!left4c.polls.slice(pollsBefore4c).some((entry) => entry.runningSessionIds?.includes(queued) === true), "scene4c control: no poll named the run, so nothing but the handover could keep its stream");
  check(new URL(left4c.url).searchParams.get("session") === settled, "scene4c control: the user really left the conversation");
  const streamsFor4c = (streams) => streams.filter((entry) => entry.url.includes("/" + queued + "/"));
  check(streamsFor4c(left4c.streams).length === 1, "scene4c control: the conversation has one stream, the one the surface opened");

  endpoint.release(7);
  const firstAnswered4c = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, queued).some((entry) => entry.status === "done") ? current : null;
  }) ?? await snapshot(session.page);
  record("scene4c.first", { facts: terminalFacts(firstAnswered4c.sse, queued), tones: tonesAfter(firstAnswered4c.audio, base4c) });
  check(terminalFacts(firstAnswered4c.sse, queued).filter((entry) => entry.status === "done").length === 1, "scene4c control: the first answer really settled on the wire");
  check(tonesAfter(firstAnswered4c.audio, base4c).length === 1, "scene4c: the first answer of the queued pair sounds once");

  // The follow-up is placed and run only after the first answer, which is the ordering that used to lose it.
  await endpoint.held(8);
  endpoint.release(8);
  const bothAnswered4c = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, queued).filter((entry) => entry.status === "done").length >= 2 ? current : null;
  }) ?? await snapshot(session.page);
  const facts4c = terminalFacts(bothAnswered4c.sse, queued);
  const tones4c = tonesAfter(bothAnswered4c.audio, base4c);
  record("scene4c.both", { facts: facts4c, tones: tones4c, keys: [...new Set(facts4c.map((entry) => entry.answerId))] });
  check(new Set(facts4c.map((entry) => entry.answerId)).size === 2, "scene4c control: the two runs answered under distinct answers");
  check(tones4c.length === 2, "scene4c: the queued follow-up own answer is its own notice (" + JSON.stringify(tones4c) + ")");
  check(tones4c.every((tone) => facts4c.some((entry) => entry.at <= tone.t)), "scene4c: both tones followed the terminal fact they were keyed by");
  check(streamsFor4c(bothAnswered4c.streams).length === 1, "scene4c: both answers arrived on the one stream, so the leave never closed it");
  releasePoll();
  await session.page.unroute(/\/api\/agent\/running/);
  check(session.pageErrors.length === 0, "scene4c: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene4c.json"), JSON.stringify({ left4c, firstAnswered4c, bothAnswered4c }, null, 1));

  // --- Scene 5: the stated limit — a run that finished entirely unobserved is silent, and leaves the unread marker.
  const unobserved = await createConversation();
  const before5 = await snapshot(session.page);
  const base5 = before5.audio.length;
  const unreadBefore5 = await unreadIds(session.page);
  check(!unreadBefore5.has(unobserved), "scene5 control: the conversation carries no marker before its run");
  // Dispatch just after a poll, and answer at once: the run starts and finishes between two polls, so no nomination
  // ever names it and nothing acquires it. This is the case the contract states cannot be observed live.
  const pollsBefore5 = before5.polls.length;
  await waitFor("the next poll", async () => (await snapshot(session.page)).polls.length > pollsBefore5);
  await submit(unobserved, "finished while nobody watched");
  await endpoint.held(9);
  endpoint.release(9);
  await settledRun(unobserved);
  await waitFor("two more polls", async () => (await snapshot(session.page)).polls.length >= pollsBefore5 + 2);
  // The marker is the run's own end, which the catalogue states from the run's durable receipt: the sidebar cannot
  // have learned it from a running flag, because no poll ever named this conversation as running (asserted below).
  const marked = await settle(async () => (await unreadIds(session.page)).has(unobserved) ? true : null);
  await frames(session.page, 30);
  const limited = await snapshot(session.page);
  const namedByAPoll = limited.polls.some((entry) => entry.runningSessionIds?.includes(unobserved) === true);
  record("scene5.limit", { conversations: [...streamedConversations(limited.streams)], tones: tonesAfter(limited.audio, base5), namedByAPoll, marked: marked === true });
  check(!streamedConversations(limited.streams).has(unobserved), "scene5: a run that finished entirely unobserved is never acquired after the fact");
  check(tonesAfter(limited.audio, base5).length === 0, "scene5: the unobserved run sounds nothing, which is the stated limit");
  check(namedByAPoll === false, "scene5 control: no poll ever named the unobserved run as running, so its marker cannot come from a running flag");
  check(marked === true, "scene5: the unobserved run still leaves the unread marker, from the run's own end rather than from an absence");
  check(session.pageErrors.length === 0, "scene5: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene5.json"), JSON.stringify({ ...limited, namedByAPoll, marked: marked === true }, null, 1));

  // --- Scene 6: a restarted backend is a new attachment, and its own re-acquisition is silent. --------------------
  const beforeRestart = await snapshot(session.page);
  const base6 = beforeRestart.audio.length;
  await stop(backendChild);
  await waitFor("the backend to stop answering", async () => {
    try { await fetch("http://127.0.0.1:" + backendPort + "/api/workspaces", { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
  });
  backendChild = await startBackend(join(dataDir, "chat-lifecycle-background.sqlite"), endpoint);
  // The page reconnects on its own; the streams it reopens carry a new attachment's identity, which the projection
  // accepts as an acquisition rather than as a fact about a run.
  const reconnected = await waitFor("the page to reconnect after the restart", async () => {
    const current = await snapshot(session.page);
    return current.streams.length > beforeRestart.streams.length ? current : false;
  }, 90_000);
  const pollsBefore6 = reconnected.polls.length;
  await waitFor("two polls after the restart", async () => (await snapshot(session.page)).polls.length >= pollsBefore6 + 2);
  await frames(session.page, 30);
  const restarted = await snapshot(session.page);
  record("scene6.restart", { streams: restarted.streams.length, tones: tonesAfter(restarted.audio, base6) });
  check(tonesAfter(restarted.audio, base6).length === 0, "scene6: a backend restart and its re-acquisition sound nothing");

  // A run started after the restart is still observed live, so the silence above is about the restart rather than a
  // page that stopped following anything.
  const afterRestart = await createConversation();
  await submit(afterRestart, "after the restart");
  await endpoint.held(10);
  check(Boolean(await settle(async () => {
    const current = await snapshot(session.page);
    return (streamedConversations(current.streams).has(afterRestart) && stateFrames(current.sse, afterRestart).length > 0) || null;
  })), "scene6: the page still acquires a run after the restart");
  endpoint.release(10);
  const resumed = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, afterRestart).some((entry) => entry.status === "done") ? current : null;
  }) ?? await snapshot(session.page);
  const resumedTones = tonesAfter(resumed.audio, base6);
  record("scene6.resumed", { fact: terminalFacts(resumed.sse, afterRestart)[0], tones: resumedTones });
  check(resumedTones.length === 1, "scene6: a run after the restart sounds once, so the page is still following the runtime");
  check(session.pageErrors.length === 0, "scene6: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene6.json"), JSON.stringify({ reconnected, restarted, resumed }, null, 1));

  // --- Scene 7: a surface joining a run already in flight is handed the stream's own window. --------------------
  // A conversation has one stream however many readers join it, so the reader that joins second — the surface the user
  // selects into a conversation a background watch is already holding — must be handed where that stream is. Without
  // the handover its own continuity is an empty state bound to nothing: the shared reducer refuses the next delta, and
  // a surface that projects the state it holds then publishes an empty window over the transcript it was already
  // showing, and never recovers on that stream.
  //
  // The surface's own reads are deliberately **not** held here: the surface renders its loading state until the
  // conversation read answers, so a held read keeps the whole chat unmounted and proves nothing about the stream. What
  // distinguishes the two is the delta that follows the join, which is what the assertions below read — the prompt is
  // on screen before the run's advance, and both it and the answer are on screen after it.
  const rejoined = await createConversation();
  await openConversation(settled);
  const before7 = await snapshot(session.page);
  await submit(rejoined, "join me in flight");
  await endpoint.held(11);
  check(Boolean(await settle(async () => {
    const current = await snapshot(session.page);
    return (streamedConversations(current.streams).has(rejoined) && stateFrames(current.sse, rejoined).length > 0) || null;
  })), "scene7 control: the background watch holds the run, baseline and all, while the user looks elsewhere");

  await switchToRow(rejoined);
  const chatText = async () => await session.page.locator(".chat-content").count() === 0 ? "" : await session.page.locator(".chat-content").innerText();
  const opened = await settle(async () => (await chatText()).includes("join me in flight") || null);
  const joined7 = await snapshot(session.page);
  record("scene7.joined", { opened: opened === true, streams: streamsFor(joined7.streams, rejoined).length, chat: (await chatText()).slice(0, 200) });
  check(opened === true, "scene7: the prompt is on screen in the conversation the user selected into");
  check(streamsFor(joined7.streams, rejoined).length === 1, "scene7: the handover reused the conversation's one stream instead of opening another");
  check(stateFrames(joined7.sse, rejoined).length > 0, "scene7 control: the stream the surface joined is the one it was handed, frames and all");

  // The run's own advance is the delta that follows the join. It must continue the window that surface is showing
  // rather than replace it with what the delta alone carried.
  endpoint.release(11);
  const answered7 = await settle(async () => {
    const current = await snapshot(session.page);
    return terminalFacts(current.sse, rejoined).some((entry) => entry.status === "done") ? current : null;
  }) ?? await snapshot(session.page);
  const afterAnswer = await settle(async () => (await chatText()).includes(ANSWER) ? await chatText() : null) ?? "";
  const after7 = await snapshot(session.page);
  record("scene7.answered", { fact: terminalFacts(answered7.sse, rejoined)[0], chat: afterAnswer.slice(0, 300), streams: streamsFor(after7.streams, rejoined).length });
  check(afterAnswer.includes(ANSWER), "scene7: the run's own advance reached the surface that joined it");
  check(afterAnswer.includes("join me in flight"), "scene7: and it continued the window that surface was already showing instead of replacing it");
  check(streamsFor(after7.streams, rejoined).length === 1, "scene7: the delta was read on the same one stream, not a second one");
  check(closedFor(after7.closed, rejoined).length === 0, "scene7 control: the stream is still open while the conversation is on screen");

  // Leaving it hands the stream back to the watch without reopening it, and once the run is settled and no longer
  // nominated the page finishes with it: the conversation holds no stream, so it holds no slot.
  await switchToRow(settled);
  await frames(session.page, 30);
  const left7 = await snapshot(session.page);
  check(streamsFor(left7.streams, rejoined).length === 1, "scene7: leaving it again opened no second stream");
  await waitFor("two polls after the handover", async () => (await snapshot(session.page)).polls.length >= left7.polls.length + 2);
  await frames(session.page, 30);
  const released7 = await snapshot(session.page);
  record("scene7.released", { streams: streamsFor(released7.streams, rejoined).length, closed: closedFor(released7.closed, rejoined).length });
  check(closedFor(released7.closed, rejoined).length === 1, "scene7: a settled conversation the user is not looking at holds no stream");
  check(streamsFor(released7.streams, rejoined).length === 1, "scene7: and it never needed a second one");
  check(session.pageErrors.length === 0, "scene7: no page error: " + session.pageErrors.join(" | "));
  writeFileSync(join(outDir, "scene7.json"), JSON.stringify({ joined7, answered7, after7, left7, released7 }, null, 1));
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
  if (failures.length > 0) { console.error("chat lifecycle background FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("chat lifecycle background PASSED");
}
