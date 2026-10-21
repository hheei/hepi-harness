/**
 * Terminal-in-pool probe — the measurement the SSE research note records as a gap.
 *
 * Reuses the Lane C controlled stack: a real production Next build (prebuilt, never built here), a real backend
 * fixture, a real gateway that serves terminals, and this script's own local completions endpoint. No production
 * host, no paid model, no tracked product file.
 *
 * Measures, against the browser's per-origin HTTP/1.1 connection budget:
 *   A: 1 selected + 3 running background conversations + 2 mounted terminal tabs -> 6 held -> an ordinary in-page
 *      fetch does not settle within its deadline, and closing the right panel leaves the terminal sources OPEN;
 *   B: the same with one terminal tab -> 5 held -> the same fetch settles.
 *
 * Every hold is a named barrier and every wait is bounded. Usage:
 *   node .scratch/perf-follow-up/evidence/terminal-pool-probe.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "..", "..", "..");
const worktree = process.env.HEPI_PROBE_WORKTREE ?? join(repoRoot, ".dev", "worktrees", "perf-lane-c");
const webRoot = join(worktree, "apps", "web");
const token = "terminal-pool-probe-token";
const webPort = Number(process.env.HEPI_PROBE_WEB_PORT ?? 45580);
const backendPort = Number(process.env.HEPI_PROBE_BACKEND_PORT ?? 45581);
const model = "probe-model";
const cwdA = "/workspace/local";
const cwdB = "/workspace/local/sub";
const conversations = Number(process.env.HEPI_PROBE_CONVERSATIONS ?? 4);
const fetchDeadlineMs = Number(process.env.HEPI_PROBE_FETCH_MS ?? 3000);
const liveBarrierMs = Number(process.env.HEPI_PROBE_BARRIER_MS ?? 20_000);

const require = createRequire(join(webRoot, "package.json"));
const { chromium } = require("playwright");

const report = {
  startedAt: new Date().toISOString(),
  worktree,
  revision: null,
  buildId: null,
  node: process.version,
  protocol: null,
  conversations,
  fetchDeadlineMs,
  scenarios: {},
  checks: [],
};
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log((ok ? "ok   " : "not ok ") + name + (detail === undefined ? "" : " — " + detail));
}
report.buildId = readFileSync(join(webRoot, ".next", "BUILD_ID"), "utf8").trim();
report.revision = (await new Promise((done) => {
  const child = spawn("git", ["-C", worktree, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.on("close", () => done(out.trim()));
})).slice(0, 40);

const artifacts = mkdtempSync(join(tmpdir(), "hepi-terminal-pool-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
const childrenLogPath = join(artifacts, "children.log");
const childrenLog = createWriteStream(childrenLogPath, { flags: "a" });
const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(String(chunk)); childrenLog.write(chunk); });
  return () => chunks.join("");
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

// The controlled model endpoint. The first N completions stop at a named barrier, so a conversation is really busy
// and its stream really stays open.
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

// The page-side recorder: every EventSource and every fetch, with its readyState transitions. It never resets.
const RECORDER = () => {
  const w = window;
  w.__sse = [];
  w.__http = [];
  const Original = w.EventSource;
  const Wrapped = function (url, init) {
    const entry = { t0: performance.now(), url: String(url), opens: 0, errors: 0, closedAt: null, readyState: 0 };
    w.__sse.push(entry);
    const source = new Original(url, init);
    const originalClose = source.close.bind(source);
    source.close = () => { entry.readyState = 2; if (entry.closedAt === null) entry.closedAt = performance.now(); return originalClose(); };
    source.addEventListener("open", () => { entry.opens += 1; entry.readyState = 1; });
    source.addEventListener("error", () => { entry.errors += 1; entry.readyState = source.readyState; if (source.readyState === 2 && entry.closedAt === null) entry.closedAt = performance.now(); });
    return source;
  };
  Wrapped.prototype = Original.prototype; Wrapped.CONNECTING = 0; Wrapped.OPEN = 1; Wrapped.CLOSED = 2;
  w.EventSource = Wrapped;
  const originalFetch = w.fetch;
  w.fetch = function (input, init) {
    let path = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    try { const parsed = new URL(path, location.href); path = parsed.pathname + parsed.search; } catch { /* raw */ }
    const entry = { t0: performance.now(), method: (init && init.method) || (input instanceof Request ? input.method : "GET"), path, t1: null, status: null };
    w.__http.push(entry);
    return originalFetch.apply(this, arguments).then((response) => { entry.t1 = performance.now(); entry.status = response.status; return response; }, (error) => { entry.t1 = performance.now(); entry.status = "error"; throw error; });
  };
};
const SEED = (seed) => {
  // addInitScript passes one argument, so the whole seed travels as one value.
  try { window.sessionStorage.setItem("pi-web:terminal-tabs", JSON.stringify(seed)); } catch { /* storage is optional */ }
};

const snap = (page) => page.evaluate(() => ({
  live: (window.__sse ?? []).filter((entry) => entry.readyState === 1).length,
  terminalLive: (window.__sse ?? []).filter((entry) => entry.readyState === 1 && entry.url.includes("/api/terminal/")).length,
  conversationLive: (window.__sse ?? []).filter((entry) => entry.readyState === 1 && entry.url.includes("/api/agent/")).length,
  sse: (window.__sse ?? []).map((entry) => ({ url: entry.url.split("?")[0], readyState: entry.readyState, opens: entry.opens, errors: entry.errors })),
  pending: (window.__http ?? []).filter((entry) => entry.t1 === null).map((entry) => entry.method + " " + entry.path.split("?")[0]),
  composer: Boolean(document.querySelector("textarea")),
  panelClass: document.querySelector("#file-panel")?.className ?? null,
  terminalPanels: document.querySelectorAll(".terminal-panel").length,
  terminalErrors: [...document.querySelectorAll(".terminal-panel-error")].map((node) => node.textContent),
  seededTabs: (() => { try { return window.sessionStorage.getItem("pi-web:terminal-tabs"); } catch { return null; } })(),
  terminalRequests: (window.__http ?? []).filter((entry) => entry.path.includes("/api/terminal")).map((entry) => entry.method + " " + entry.path.split("?")[0] + ":" + entry.status),
  protocol: performance.getEntriesByType("navigation")[0]?.nextHopProtocol ?? "unknown",
}));
const probeFetch = (page, deadlineMs) => page.evaluate((ms) => {
  const started = performance.now();
  return Promise.race([
    fetch("/api/agent/running", { cache: "no-store" }).then((response) => ({ settled: true, status: response.status, ms: Math.round(performance.now() - started) })),
    new Promise((done) => setTimeout(() => done({ settled: false, ms: Math.round(performance.now() - started) }), ms)),
  ]);
}, deadlineMs);
const waitLive = (page, count) => page.waitForFunction((n) => ((window.__sse ?? []).filter((entry) => entry.readyState === 1).length >= n), count, { timeout: liveBarrierMs }).then(() => true, () => false);

const ep = await endpoint();
let browser;
try {
  heldTarget = conversations;
  const backend = spawn(process.execPath, [join(evidenceDir, "backend-fixture.ts")], {
    cwd: worktree,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(artifacts, "backend-home"), TMPDIR: tmpdir(),
      HEPI_PROBE_WORKTREE: worktree,
      HEPI_PROBE_FIXTURE: join(artifacts, "backend"),
      HEPI_PROBE_DB: join(dataDir, "probe.sqlite"),
      HEPI_PROBE_BACKEND_PORT: String(backendPort),
      HEPI_PROBE_AUTH: token,
      HEPI_PROBE_MODEL: model,
      HEPI_PROBE_ENDPOINT: ep.origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  const backendLog = capture(backend);
  const backendOrigin = "http://127.0.0.1:" + backendPort;
  if (!await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 60_000)) throw new Error("backend fixture did not start: " + backendLog().slice(-600));

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
  const webLog = capture(web);
  const origin = "http://127.0.0.1:" + webPort;
  if (!await waitForHttp(origin + "/", {}, 90_000)) throw new Error("Web UI did not start: " + webLog().slice(-600));

  browser = await chromium.launch();

  const login = await fetch(origin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin, host: new URL(origin).host }, body: JSON.stringify({ token }) });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  if (cookie === "") throw new Error("the durable login set no cookie");

  // The conversations: one selected, the rest running in the background.
  const setup = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await setup.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
  const ids = [];
  for (let i = 0; i < conversations; i += 1) {
    const created = await setup.request.post(origin + "/api/agent/new", { headers: { origin }, data: { cwd: cwdA } });
    if (created.status() !== 200) throw new Error("conversation " + i + " was not created: " + created.status());
    const id = (await created.json()).sessionId;
    if (typeof id !== "string") throw new Error("conversation " + i + " has no id");
    ids.push(id);
  }
  for (let i = 0; i < ids.length; i += 1) {
    const sent = await setup.request.post(origin + "/api/agent/" + encodeURIComponent(ids[i]), { headers: { origin }, data: { type: "prompt", message: "run " + i, requestId: "req-" + i } });
    if (sent.status() !== 200) throw new Error("run " + i + " was not accepted: " + sent.status());
  }
  // The barrier that replaces a settle sleep: every run is really busy before a page opens.
  const busyDeadline = Date.now() + 30_000;
  let busy = [];
  while (Date.now() < busyDeadline && !ids.every((id) => busy.includes(id))) {
    const running = await setup.request.get(origin + "/api/agent/running", { headers: { origin }, timeout: 10_000 }).catch(() => null);
    if (running?.ok()) busy = (await running.json()).runningSessionIds ?? [];
    else await delay(100);
  }
  if (!ids.every((id) => busy.includes(id))) throw new Error("not every run became busy: " + JSON.stringify({ ids, busy }));
  report.busyRuns = busy.length;

  // Real terminal sessions on the real gateway, opened through the backend's own relay, so a restored tab has a live
  // shell to describe and attach to.
  const openTerminal = async (cwd) => {
    const id = randomBytes(16).toString("hex");
    const response = await fetch(backendOrigin + "/api/terminal?cwd=" + encodeURIComponent(cwd), {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ id, cwd, cols: 80, rows: 24 }),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || body?.ok !== true) throw new Error("terminal open failed for " + cwd + ": " + response.status + " " + JSON.stringify(body));
    return { id, cwd };
  };

  async function scenario({ name, tabs, open, expectLive }) {
    const result = { tabs: tabs.length, open, expectedLive: expectLive };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
    await context.addInitScript(RECORDER);
    await context.addInitScript(SEED, { tabs: tabs.map(({ id, cwd }) => ({ id, cwd })), activeId: tabs[0].id, open });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    try {
      await page.goto(origin + "/?session=" + encodeURIComponent(ids[0]), { waitUntil: "domcontentloaded" });
      result.barrierReached = await waitLive(page, expectLive);
      const before = await snap(page);
      result.live = before.live;
      result.terminalLive = before.terminalLive;
      result.conversationLive = before.conversationLive;
      result.sse = before.sse;
      result.pending = before.pending;
      result.composer = before.composer;
      result.panelClassBefore = before.panelClass;
      result.terminalPanels = before.terminalPanels;
      result.terminalErrors = before.terminalErrors;
      result.seededTabs = before.seededTabs;
      result.terminalRequests = before.terminalRequests;
      result.protocol = before.protocol;
      report.protocol = before.protocol;
      result.probe = await probeFetch(page, fetchDeadlineMs);
      result.pageErrors = pageErrors;
    } finally {
      await context.close().catch(() => {});
    }
    report.scenarios[name] = result;
    console.log(name + ": live=" + result.live + " (terminal " + result.terminalLive + ", conversation " + result.conversationLive + ") probe=" + JSON.stringify(result.probe) + " panelClosed=" + (result.panelClassBefore ?? "").includes("right-panel-closed"));
    return result;
  }

  const twoTabs = [await openTerminal(cwdA), await openTerminal(cwdB)];
  const a = await scenario({ name: "A_two_terminal_tabs_panel_open", tabs: twoTabs, open: true, expectLive: conversations + 2 });
  check("A: six sources are held (1 selected + 3 background + 2 terminals)", a.live === conversations + 2, "live=" + a.live + " terminal=" + a.terminalLive + " conversation=" + a.conversationLive);
  check("A: an ordinary in-page fetch does not settle within " + fetchDeadlineMs + " ms", a.probe.settled === false, JSON.stringify(a.probe));

  // The same two tabs with the panel closed from the load: the container is always mounted, so a closed panel must
  // hold the same two terminal streams.
  const closedTabs = [await openTerminal(cwdA), await openTerminal(cwdB)];
  const c = await scenario({ name: "C_two_terminal_tabs_panel_closed", tabs: closedTabs, open: false, expectLive: conversations + 2 });
  check("C: the right panel really is closed", (c.panelClassBefore ?? "").includes("right-panel-closed"), "panel=" + c.panelClassBefore);
  check("C: a closed panel still holds both terminal sources OPEN", c.live === conversations + 2 && c.terminalLive === 2, "live=" + c.live + " terminal=" + c.terminalLive + " conversation=" + c.conversationLive);
  check("C: the same in-page fetch does not settle", c.probe.settled === false, JSON.stringify(c.probe));

  const oneTab = [await openTerminal(cwdA)];
  const b = await scenario({ name: "B_one_terminal_tab", tabs: oneTab, open: true, expectLive: conversations + 1 });
  check("B: five sources are held (one fewer terminal)", b.live === conversations + 1, "live=" + b.live + " terminal=" + b.terminalLive + " conversation=" + b.conversationLive);
  check("B: the same in-page fetch settles", b.probe.settled === true, JSON.stringify(b.probe));

  report.finishedAt = new Date().toISOString();
  report.childrenLog = childrenLogPath;
  report.failed = report.checks.filter((entry) => !entry.ok).length;
  writeFileSync(join(evidenceDir, "terminal-pool-probe.json"), JSON.stringify(report, null, 1));
  console.log("ASSERT " + (report.failed === 0 ? "PASS" : "FAIL") + " — " + report.checks.length + " checks, " + report.failed + " failed");
  for (const entry of report.checks.filter((entry) => !entry.ok)) console.log("  not ok: " + entry.name + " — " + entry.detail);
  console.log("written to " + join(evidenceDir, "terminal-pool-probe.json") + " (children log " + childrenLogPath + ")");
  process.exitCode = report.failed === 0 ? 0 : 1;
  ep.release();
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await ep.close();
}
