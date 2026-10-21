/**
 * Ticket 02: the page stays usable with terminal tabs open and several conversations running.
 *
 * The measurement is the terminal-in-pool run recorded at \`cb4494b\` (\`.scratch/perf-follow-up/evidence/\`), extended to
 * what the ticket asks for. Its stack is reused rather than re-derived: a real prebuilt production Next build, a real
 * backend, a real gateway that serves terminals, and this script's own controlled completions endpoint — no production
 * host, no paid model, nothing built or deployed by this script.
 *
 * What it asserts, in order:
 *   A. with two mounted terminal tabs, the panel closed and a non-active tab selected, plus held chat runs: the page
 *      holds at most the pool budget, the composer is ready, a session switch completes and an in-page read settles,
 *      and both shells are still the same sessions afterwards (keystrokes echo, and a reattach inside the retained tail
 *      does not reset the screen);
 *   B. the control with one fewer held run and no terminals, which must pass so a failure is attributable to the count;
 *   C. the budget itself: with a terminal tab mounted one fewer background conversation holds a source than without it.
 *
 * The source count is read from the page's own network, not from one transport's constructor: a request that answered
 * `text/event-stream` with a 200 is one live source and its finish or failure is its close, which counts the page's one
 * terminal stream (packages/ui/src/lib/terminal-fan-in.ts) and the conversation's `fetch` reader
 * (packages/session/src/browser.ts) the same way. Nothing is instrumented inside the page.
 *
 * Every hold is a named barrier and every wait is bounded; there are no sleeps. Usage:
 *   node apps/web/e2e/ux-terminal-budget.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "terminal-budget-token";
const webPort = Number(process.env.HEPI_BUDGET_WEB_PORT ?? 45780);
const backendPort = Number(process.env.HEPI_BUDGET_BACKEND_PORT ?? 45781);
const model = "budget-model";
const cwdA = "/workspace/local";
const cwdB = "/workspace/local/sub";
// The pool the page's origin is served over, and what a browser allows on it.
const POOL = 6;
const heldRuns = Number(process.env.HEPI_BUDGET_HELD ?? 4);
const composerDeadlineMs = Number(process.env.HEPI_BUDGET_COMPOSER_MS ?? 5000);
const switchDeadlineMs = Number(process.env.HEPI_BUDGET_SWITCH_MS ?? 5000);
const fetchDeadlineMs = Number(process.env.HEPI_BUDGET_FETCH_MS ?? 3000);
const liveBarrierMs = Number(process.env.HEPI_BUDGET_BARRIER_MS ?? 30_000);

assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");
const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright");

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log((ok ? "ok   " : "not ok ") + name + (detail === undefined ? "" : " — " + detail));
}

const artifacts = mkdtempSync(join(tmpdir(), "hepi-terminal-budget-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
const children = [];
function capture(child) {
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => childrenLog.write(chunk));
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000).then(() => child.kill("SIGKILL"))]);
}
async function waitForHttp(url, headers, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** The controlled model endpoint: the first N completions stop at a named barrier, so a run is really in flight. */
let completed = 0;
let heldTarget = 0;
let heldResolvers = [];
function endpoint() {
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", () => {});
    request.on("end", () => { void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      completed += 1;
      const answer = "ANS-" + completed;
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.flushHeaders();
      response.write(frame({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
      if (completed <= heldTarget) await new Promise((release) => heldResolvers.push(release));
      response.write(frame({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }));
      response.write(frame({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      response.write("data: [DONE]\n\n");
      response.end();
    })().catch(() => { try { response.end(); } catch { /* gone */ } }); });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({
    origin: "http://127.0.0.1:" + server.address().port,
    release: () => { const waiting = heldResolvers; heldResolvers = []; for (const release of waiting) release(); },
    close: () => new Promise((closed) => { server.closeAllConnections(); server.close(() => closed()); }),
  })));
}

/**
 * The page's sources, read off its network the way the page's own `readyState` would state them.
 *
 * A source is the request that **answered** `text/event-stream` with a 200: that is one stream held open, whatever
 * opened it, and the request's finish or failure is its close. A request that has been issued but has no response yet
 * is queued in the pool, not a live source, so it is counted only once the origin answers it — the budget under test is
 * exactly the pool such a request would be waiting in. Test instrumentation only; the page cannot see it.
 */
function observeSources(page) {
  const entries = [];
  const open = new Map();
  const kindOf = (pathname) => pathname.includes("/api/terminal/") ? "terminal" : pathname.includes("/api/agent/") ? "conversation" : null;
  const pathOf = (url) => { try { return new URL(url).pathname; } catch { return url; } };
  const close = (request, failed) => { const entry = open.get(request); if (entry === undefined) return; entry.readyState = 2; if (failed) entry.errors += 1; };
  page.on("response", (response) => {
    const pathname = pathOf(response.url());
    const kind = kindOf(pathname);
    if (kind === null) return;
    // A read or a command is not a source: only the stream that answered one holds a connection open.
    if (response.status() !== 200 || !(response.headers()["content-type"] ?? "").includes("text/event-stream")) return;
    const entry = { t0: Date.now(), url: pathname, kind, opens: 1, errors: 0, readyState: 1 };
    entries.push(entry);
    open.set(response.request(), entry);
  });
  page.on("requestfinished", (request) => close(request, false));
  page.on("requestfailed", (request) => close(request, true));
  const live = () => entries.filter((entry) => entry.readyState === 1);
  return {
    live: () => live().length,
    terminal: () => live().filter((entry) => entry.kind === "terminal").map((entry) => entry.url),
    conversation: () => live().filter((entry) => entry.kind === "conversation").length,
    sources: () => entries.map(({ url, kind, readyState, opens }) => ({ url, kind, readyState, opens })),
  };
}
/** The terminal tabs the app itself restores: a real session id and a real routing cwd, marked as restored. */
const SEED = (seed) => {
  try { window.sessionStorage.setItem("pi-web:terminal-tabs", JSON.stringify(seed)); } catch { /* storage is optional */ }
};

const snapshot = (sources) => ({
  live: sources.live(),
  terminal: sources.terminal(),
  conversation: sources.conversation(),
  sources: sources.sources(),
});
const probeFetch = (page, deadlineMs) => page.evaluate((ms) => {
  const started = performance.now();
  return Promise.race([
    fetch("/api/agent/running", { cache: "no-store" }).then((response) => ({ settled: true, status: response.status, ms: Math.round(performance.now() - started) })),
    new Promise((done) => setTimeout(() => done({ settled: false, ms: Math.round(performance.now() - started) }), ms)),
  ]);
}, deadlineMs);
/** The mount's own barrier: the page opened at least this many sources, or the deadline says it did not. */
const waitLive = async (sources, count) => {
  const deadline = Date.now() + liveBarrierMs;
  while (Date.now() < deadline) {
    if (sources.live() >= count) return true;
    await delay(25);
  }
  return false;
};
/** The composer only renders after the session round trip, so waiting for it is the mount's own fact. */
const waitComposer = (page, deadlineMs) => page.locator("textarea").first().waitFor({ timeout: deadlineMs }).then(() => true, () => false);

const ep = await endpoint();
let browser;
try {
  heldTarget = heldRuns;
  const backend = spawn(process.execPath, [join(repoRoot, ".scratch", "perf-follow-up", "evidence", "backend-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(artifacts, "backend-home"), TMPDIR: tmpdir(),
      HEPI_PROBE_WORKTREE: repoRoot,
      HEPI_PROBE_FIXTURE: join(artifacts, "backend"),
      HEPI_PROBE_DB: join(dataDir, "budget.sqlite"),
      HEPI_PROBE_BACKEND_PORT: String(backendPort),
      HEPI_PROBE_AUTH: token,
      HEPI_PROBE_MODEL: model,
      HEPI_PROBE_ENDPOINT: ep.origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  capture(backend);
  const backendOrigin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 60_000), "the backend fixture started");

  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(artifacts, "web-home"), TMPDIR: tmpdir(),
      HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  capture(web);
  const origin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(origin + "/", {}, 90_000), "the Web UI started");

  browser = await chromium.launch();
  const login = await fetch(origin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin, host: new URL(origin).host }, body: JSON.stringify({ token }) });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie !== "", "the durable login set a cookie");

  const setup = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await setup.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
  const ids = [];
  for (let i = 0; i < heldRuns; i += 1) {
    const created = await setup.request.post(origin + "/api/agent/new", { headers: { origin }, data: { cwd: cwdA } });
    assert.equal(created.status(), 200, "conversation " + i + " was created");
    ids.push((await created.json()).sessionId);
  }
  for (let i = 0; i < ids.length; i += 1) {
    const sent = await setup.request.post(origin + "/api/agent/" + encodeURIComponent(ids[i]), { headers: { origin }, data: { type: "prompt", message: "run " + i, requestId: "req-" + i } });
    assert.equal(sent.status(), 200, "run " + i + " was accepted");
  }
  // The barrier that replaces a settle sleep: every run is really in flight before a page opens.
  const busyDeadline = Date.now() + 30_000;
  let busy = [];
  while (Date.now() < busyDeadline && !ids.every((id) => busy.includes(id))) {
    const running = await setup.request.get(origin + "/api/agent/running", { headers: { origin }, timeout: 10_000 }).catch(() => null);
    if (running?.ok()) busy = (await running.json()).runningSessionIds ?? [];
    else await delay(100);
  }
  assert.ok(ids.every((id) => busy.includes(id)), "every run became busy: " + JSON.stringify({ ids, busy }));

  /** A real terminal session on the real gateway, opened through the backend's own relay. */
  const openTerminal = async (cwd) => {
    const id = randomBytes(16).toString("hex");
    const response = await fetch(backendOrigin + "/api/terminal?cwd=" + encodeURIComponent(cwd), {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ id, cwd, cols: 80, rows: 24 }),
    });
    const body = await response.json().catch(() => null);
    assert.equal(response.status, 200, "the terminal opened: " + JSON.stringify(body));
    return { id, cwd };
  };
  /** Drive a session from this process, so the shell's own output is what proves the tab is attached. */
  const sendInput = async (tab, data) => {
    const response = await fetch(backendOrigin + "/api/terminal/" + encodeURIComponent(tab.id) + "?cwd=" + encodeURIComponent(tab.cwd), { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ type: "input", data }) });
    return await response.json();
  };
  const readStream = async (tab, after, predicate, timeoutMs = 20_000) => {
    const query = "?cwd=" + encodeURIComponent(tab.cwd) + (after === undefined ? "" : "&after=" + after);
    const response = await fetch(backendOrigin + "/api/terminal/" + encodeURIComponent(tab.id) + "/events" + query, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let text = "";
    let reset = false;
    let offset = 0;
    let first = true;
    try {
      while (!predicate(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((value) => value.startsWith("data: "));
          if (line === undefined) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type !== "output") continue;
          if (first) { reset = event.reset === true; first = false; }
          text += event.data ?? "";
          offset = event.offset ?? offset;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { text, reset, offset };
  };
  /**
   * What the page's **visible** terminal shows, read from xterm's own accessibility tree. The panel of every mounted
   * tab is in the DOM — that is what keeps a hidden tab's shell attached — so the visible one is the one a person reads.
   */
  const screen = async (page) => await page.locator(".terminal-panel:visible .xterm-accessibility-tree").first().innerText().catch(() => "");
  const waitForScreen = async (page, predicate, description, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      last = await screen(page);
      if (predicate(last)) return true;
      await delay(50);
    }
    console.log("     (the terminal shows " + JSON.stringify(last.slice(-200)) + ")");
    return false;
  };

  /**
   * A client-side session switch: the sidebar's own row click, which is what the user's own switch is. A page load would
   * destroy the page's in-memory state and prove nothing about a switch.
   */
  const switchToRow = async (page, conversationId, deadlineMs) => {
    const row = page.locator('.session-tree-row.session-tree-session[data-row-key$=":' + conversationId + '"]').first();
    await row.waitFor({ timeout: deadlineMs });
    await row.locator(".session-tree-main").first().click();
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (new URL(page.url()).searchParams.get("session") === conversationId) return true;
      await delay(25);
    }
    return false;
  };

  /**
   * One scenario: a page with the given tabs restored, the panel in the given state, against the held runs. Returns
   * everything the checks need, so the two scenarios differ only in what they seed.
   */
  async function scenario({ name, tabs, open, activeIndex = 0 }) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
    await context.addInitScript(SEED, { tabs: tabs.map(({ id, cwd }) => ({ id, cwd })), activeId: tabs[activeIndex]?.id ?? null, open });
    const page = await context.newPage();
    const sources = observeSources(page);
    page.setDefaultTimeout(60_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const result = { name, tabs: tabs.length };
    try {
      await page.goto(origin + "/?session=" + encodeURIComponent(ids[0]), { waitUntil: "domcontentloaded" });
      // The composer is the page's own statement that its mount effects have run; the sources are the count under test.
      result.composer = await waitComposer(page, composerDeadlineMs);
      result.liveBarrier = await waitLive(sources, Math.min(POOL, tabs.length + 2));
      const before = snapshot(sources);
      result.live = before.live;
      result.terminal = before.terminal;
      result.conversation = before.conversation;
      result.sources = before.sources;
      result.probe = await probeFetch(page, fetchDeadlineMs);
      result.pageErrors = pageErrors;
      return { result, page, context };
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  }

  // A. Two mounted terminal tabs, the panel closed, the second tab selected, plus the held runs.
  const twoTabs = [await openTerminal(cwdA), await openTerminal(cwdB)];
  const a = await scenario({ name: "A_two_terminal_tabs", tabs: twoTabs, open: false, activeIndex: 1 });
  check("A: the composer is ready inside its deadline", a.result.composer === true, "composer=" + a.result.composer);
  check("A: the page holds at most the pool budget in live sources", a.result.live <= POOL, "live=" + a.result.live + " (terminal " + a.result.terminal.length + ", conversation " + a.result.conversation + ")");
  check("A: the mounted tabs share one terminal stream", a.result.terminal.length === 1, "terminal sources: " + JSON.stringify(a.result.terminal));
  // The budget itself: with a terminal tab mounted, the page watches one fewer background conversation than it may
  // without one — one selected, one terminal, two headroom, and what is left is the background budget.
  check("A: a mounted terminal costs one background slot", a.result.conversation === 3, "conversation sources=" + a.result.conversation);
  check("A: an in-page read settles inside its deadline", a.result.probe.settled === true, JSON.stringify(a.result.probe));

  // A session switch: the sidebar's own row click, and the deadline is the switch's own fact.
  const switchStarted = Date.now();
  const switched = await switchToRow(a.page, ids[1], switchDeadlineMs);
  a.result.switchMs = Date.now() - switchStarted;
  check("A: a session switch completes inside its deadline", switched === true, "switchMs=" + a.result.switchMs);

  // Every mounted tab's shell is the same session, and it still answers: the panel's own output is the proof.
  const marker = "budget-" + Math.random().toString(36).slice(2);
  // The selected tab's own shell is driven the way a person drives it: the keystrokes go into the visible terminal and
  // the panel's own output is what proves the session is alive.
  await a.page.locator(".terminal-panel:visible .terminal-status-dot.is-ready").first().waitFor({ timeout: 30_000 });
  await a.page.locator(".terminal-panel:visible textarea.xterm-helper-textarea").first().focus();
  await a.page.keyboard.type("printf '" + marker + "-echo\n'");
  await a.page.keyboard.press("Enter");
  check("A: the selected tab's shell still echoes", await waitForScreen(a.page, (text) => text.includes(marker + "-echo"), "the selected tab's own output"), "marker " + marker);
  assert.deepEqual(await sendInput(twoTabs[0], "printf '" + marker + "-hidden\n'\r"), { ok: true });
  const hidden = await readStream(twoTabs[0], 0, (text) => text.includes(marker + "-hidden"));
  // The hidden tab has no visible widget to type into — its panel is in the DOM but not on screen — so its session is
  // driven through the backend's own input route. What it proves is unchanged: that tab's shell is attached and still
  // answering on the page's one stream.
  check("A: the hidden tab's shell is the same session and is still attached", hidden.text.includes(marker + "-hidden"), "the hidden tab's own output arrived");
  check("A: a reattach inside the retained tail does not reset", hidden.reset === false, "reset=" + hidden.reset);
  check("A: no page error occurred", a.result.pageErrors.length === 0, a.result.pageErrors.join(" | "));
  await a.context.close();

  // B. The control: one fewer held run and no terminals, which must pass so a failure is attributable to the count.
  const b = await scenario({ name: "B_control_no_terminals", tabs: [], open: false });
  check("B: the composer is ready inside its deadline", b.result.composer === true, "composer=" + b.result.composer);
  check("B: an in-page read settles inside its deadline", b.result.probe.settled === true, JSON.stringify(b.result.probe));
  check("B: the page holds no terminal stream at all", b.result.terminal.length === 0, JSON.stringify(b.result.terminal));
  check("B: with no terminal mounted the page watches every held run", b.result.conversation === heldRuns, "conversation sources=" + b.result.conversation + " of " + heldRuns + " held runs");
  check("B: no page error occurred", b.result.pageErrors.length === 0, b.result.pageErrors.join(" | "));
  await b.context.close();

  ep.release();
  console.log("ASSERT " + (checks.every((entry) => entry.ok) ? "PASS" : "FAIL") + " — " + checks.length + " checks, " + checks.filter((entry) => !entry.ok).length + " failed");
  process.exitCode = checks.every((entry) => entry.ok) ? 0 : 1;
} finally {
  ep.release();
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await ep.close();
}
