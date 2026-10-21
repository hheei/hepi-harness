/**
 * Ticket 01 acceptance: an enabled keepalive survives a real idle bound through the whole proxy chain, and a disabled
 * one is torn down by it — both measured at the browser's own source, in one fixture, differing only by the cadence.
 *
 * The chain is the deployment's, not a mock: headless Chromium -> a hop that bounds how long a response body may stay
 * silent -> the production Next build -> the real backend -> the real gateway, which runs the shell. Two streams are
 * measured at once, one per origin writer: the conversation stream (written by the backend) and the terminal stream
 * (written by the gateway).
 *
 * The idle bound is a genuine idle deadline: it is armed when a response starts and re-armed by every byte that
 * arrives, so a body that keeps producing is never cut and a silent one is. It is not a total-duration timeout, and it
 * is not a process-global dispatcher setting — it exists only in this fixture's hop. The cadence and the bound are both
 * stated in milliseconds, so the window is crossed in seconds rather than by waiting real minutes, and no clock is
 * faked: every wait below is for a frame the origin actually wrote or for the hop's own deadline to fire.
 *
 * The browser's own sources are what is asserted on. The page's \`fetch\` streams are recorded, so "one source, no
 * reconnect, no re-baseline" is a statement about the page's real subscriptions; a fixture-owned raw reader beside them
 * is what can see the origin's comment frames, because a comment frame carries no event and therefore never reaches a
 * frame consumer. The hop records every response it destroyed for idleness, which is the fixture's own evidence
 * that the bound under test is the one that acted.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/stream-heartbeat-idle.mjs
 *        HEPI_SHB_HEARTBEAT_MS=<cadence> HEPI_SHB_IDLE_MS=<bound> HEPI_SHB_OUT=<dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "stream-heartbeat-idle-token";
/** The keepalive cadence the enabled run states, and the idle bound both runs sit behind. */
const HEARTBEAT_MS = Number(process.env.HEPI_SHB_HEARTBEAT_MS ?? 250);
const IDLE_MS = Number(process.env.HEPI_SHB_IDLE_MS ?? 1200);
/** How many idle windows the measurement crosses: the same window in both runs, only the cadence differs. */
const WINDOWS = Number(process.env.HEPI_SHB_WINDOWS ?? 3);
const WINDOW_MS = IDLE_MS * WINDOWS;
const outDir = process.env.HEPI_SHB_OUT ?? join(repoRoot, ".scratch", "perf-follow-up", "evidence", "stream-heartbeat-idle");
mkdirSync(outDir, { recursive: true });
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok   " + message); return true; }
  failures.push(message); console.log("  FAIL " + message); return false;
}

/** Both child roles run from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}
function capture(child, log) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); log.write(chunk); });
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
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * The hop the browser reaches: every response is piped through, and a response that stays silent longer than \`idleMs\`
 * is destroyed. The deadline is re-armed by each byte received, so it is an idle bound rather than a total-duration
 * one, and it is armed only here — no process-global setting is touched. Every destruction is recorded, because it is
 * the fixture's own evidence of which response the bound actually acted on.
 */
function idleBoundProxy(targetPort, idleMs) {
  const destroyed = [];
  const server = createHttpServer((request, response) => {
    const upstream = httpRequest({ host: "127.0.0.1", port: targetPort, path: request.url, method: request.method, headers: request.headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      let bytes = 0;
      let timer = null;
      const arm = () => { timer = setTimeout(() => { destroyed.push({ path: request.url, bytes }); response.destroy(); upstreamResponse.destroy(); }, idleMs); timer.unref(); };
      arm();
      upstreamResponse.on("data", (chunk) => { bytes += chunk.length; clearTimeout(timer); arm(); response.write(chunk); });
      upstreamResponse.on("end", () => { clearTimeout(timer); response.end(); });
      upstreamResponse.on("error", () => { clearTimeout(timer); response.destroy(); });
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    // The caller going away is what must cancel the host request. The *response* is watched, not the request: a
    // request's `close` fires once its body has been fully sent, which for a long-lived stream is immediately, and
    // destroying the upstream there would cut the very stream this fixture measures.
    response.on("close", () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });
  return new Promise((resolveProxy) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolveProxy({ server, port: address.port, destroyed, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

/**
 * Observation only. The page's streams are recorded per URL. Both are read through `fetch`: the conversation stream by
 * the shared browser transport, and the terminal's by the page's one fan-in reader, which is what lets an App present a
 * device bearer at all. That is what "one source, no reconnect, no re-baseline" is read from — one request per
 * conversation, one request for every mounted terminal tab, and one baseline frame. Nothing is replaced or changed.
 */
const RECORDER = () => {
  window.__shb = { sources: [], frames: [] };
  const originalFetch = window.fetch;
  window.__shb.unwrappedFetch = originalFetch;
  window.fetch = function recordingFetch(input, init) {
    const url = typeof input === "string" ? input : (input instanceof Request ? input.url : String(input));
    const response = originalFetch.apply(this, arguments);
    // The conversation's stream and the page's one terminal stream are both `fetch` reads; everything else under these
    // prefixes is an ordinary JSON call and is not a source.
    if (!String(url).startsWith("/api/agent/") && !String(url).startsWith("/api/terminal/")) return response;
    return response.then((value) => {
      // A stream is the request that answered `text/event-stream`: a lease renewal, a submission lookup or a terminal
      // command under the same prefix is an ordinary JSON call and is not a source.
      if (!(value.headers.get("content-type") ?? "").startsWith("text/event-stream")) return value;
      const record = { url: String(url), opened: 1, errors: 0, messages: 0, closed: 0 };
      window.__shb.sources.push(record);
      const reader = value.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const body = new ReadableStream({
        async pull(controller) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (error) {
            // The hop tore the response down: this source saw a disconnect, and the reader above must see it too.
            record.errors += 1;
            record.closed += 1;
            controller.error(error);
            return;
          }
          if (chunk.done) { record.closed += 1; controller.close(); return; }
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
            record.messages += 1;
            window.__shb.frames.push({ url: record.url, event, type: JSON.parse(data.join("\n")).type ?? null, t: Math.round(performance.now()) });
          }
          controller.enqueue(chunk.value);
        },
      });
      return new Response(body, { status: value.status, statusText: value.statusText, headers: value.headers });
    });
  };
};

/** The page's composer only renders after the session round-trip, so waiting for it proves the mount effects ran. */
async function appReady(page) { await page.locator("textarea").first().waitFor({ timeout: 30_000 }); }

/** Open the workspace terminal from the Files tab, which is what makes the panel hold the gateway's stream. */
async function openTerminal(page) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.waitFor({ timeout: 20_000 });
  if (await files.getAttribute("aria-selected") !== "true") await files.click();
  await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
  await page.locator(".terminal-panel").waitFor({ timeout: 30_000 });
}

/** One run of the whole fixture: the same stack, the same hop, one cadence parameter. */
async function run(mode, heartbeatMs) {
  const label = mode + " (cadence " + heartbeatMs + " ms, idle bound " + IDLE_MS + " ms, window " + WINDOW_MS + " ms)";
  console.log("\n=== " + label + " ===");
  const artifacts = mkdtempSync(join(tmpdir(), "hepi-shb-"));
  const dataDir = join(artifacts, "data");
  const workspaceRoot = join(artifacts, "workspace");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const log = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
  const children = [];
  let browser;
  let proxy;
  const result = { mode, heartbeatMs, idleMs: IDLE_MS, windowMs: WINDOW_MS, barriers: {}, app: {}, raw: [], proxyDestroyed: [], checks: [] };

  try {
    const gatewayPort = await freePort();
    const gateway = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
      cwd: repoRoot,
      env: childEnv(join(artifacts, "gateway-home"), {
        HEPI_GATEWAY_TOKEN: token, HEPI_GATEWAY_ID: "workstation", HEPI_GATEWAY_PORT: String(gatewayPort),
        HEPI_GATEWAY_DATA: join(dataDir, "gateway"), HEPI_WORKSPACE_ROOT: workspaceRoot,
        HEPI_WORKSPACE_ID: "local", HEPI_ALLOWED_COMMANDS: "bash, sh", HEPI_TERMINAL_HEARTBEAT_MS: String(heartbeatMs),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(gateway);
    const gatewayLog = capture(gateway, log);
    const gatewayOrigin = "http://127.0.0.1:" + gatewayPort;
    assert.ok(await waitForHttp(gatewayOrigin + "/v1/workspaces", { authorization: "Bearer " + token, "content-type": "application/json" }, 60_000), "the gateway started: " + gatewayLog().slice(-500));

    const backendPort = await freePort();
    const backend = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
      cwd: repoRoot,
      env: childEnv(join(artifacts, "backend-home"), {
        PORT: String(backendPort), HEPI_BIND_HOST: "127.0.0.1", HEPI_AUTH_TOKEN: token,
        HEPI_DB: join(dataDir, "conversations.sqlite"), HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
        HEPI_PROJECTS: join(dataDir, "projects.sqlite"), HEPI_WORKSPACE_ID: "local", HEPI_GATEWAY_ID: "workstation",
        HEPI_GATEWAY_URL: gatewayOrigin, HEPI_GATEWAY_TOKEN: token, HEPI_HEARTBEAT_MS: String(heartbeatMs),
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(backend);
    const backendLog = capture(backend, log);
    const backendOrigin = "http://127.0.0.1:" + backendPort;
    assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 60_000), "the backend started: " + backendLog().slice(-500));

    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    const created = await (await fetch(backendOrigin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) })).json();
    const sessionId = created.conversationId;
    assert.equal(typeof sessionId, "string", "the conversation was created");

    const webPort = await freePort();
    const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
      cwd: webRoot,
      env: childEnv(join(artifacts, "web-home"), {
        HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
        NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(web);
    const webLog = capture(web, log);
    assert.ok(await waitForHttp("http://127.0.0.1:" + webPort + "/", {}, 90_000), "the Web UI started: " + webLog().slice(-500));

    // The hop the browser reaches: everything the page asks for travels through it, including both streams.
    proxy = await idleBoundProxy(webPort, IDLE_MS);
    const origin = "http://127.0.0.1:" + proxy.port;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    await context.addInitScript(RECORDER);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
    const password = page.locator('input[type="password"]');
    if (await password.count()) { await password.fill(token); await page.locator('button[type="submit"]').click(); }
    await appReady(page);

    // The application's own conversation source, as the shell opened it.
    const conversationUrl = await page.waitForFunction(() => window.__shb.sources.find((s) => s.url.startsWith("/api/agent/"))?.url ?? null, undefined, { timeout: 30_000 }).then((handle) => handle.jsonValue());
    result.app.conversationUrl = conversationUrl;
    await openTerminal(page);
    // The panel's own source is the gateway stream's reader, and its URL carries the session id and the routing cwd
    // the raw reader below attaches with, so nothing about the terminal path is re-derived here.
    const terminalUrl = await page.waitForFunction(() => window.__shb.sources.find((s) => s.url.startsWith("/api/terminal/"))?.url ?? null, undefined, { timeout: 30_000 }).then((handle) => handle.jsonValue());
    result.app.terminalUrl = terminalUrl;
    result.barriers.connection = { at: Date.now() };
    await delay(300);

    // The fixture-owned raw readers, from the same page and through the same hop. A comment frame carries no event, so
    // this is the only reader that can see the origin's keepalive arrive at the browser.
    await page.evaluate((urls) => {
      window.__shb.raw = [];
      window.__shb.control = [];
      const start = (url) => {
        const record = { url, comments: 0, frames: 0, firstFrameAt: null, firstCommentAt: null, error: null, teardown: false, open: true, endedAt: null };
        window.__shb.raw.push(record);
        const controller = new AbortController();
        window.__shb.control.push({ record, controller });
        void (async () => {
          try {
            // The fixture's own reader bypasses the recorder: it is not a page source, and counting it as one would make
      // "the page holds exactly one conversation source" a statement about this script.
      const response = await (window.__shb.unwrappedFetch ?? fetch)(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
            if (!response.ok || response.body === null) { record.error = "status " + response.status; return; }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = "";
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) { record.error = "ended"; break; }
              pending += decoder.decode(chunk.value, { stream: true });
              let boundary;
              while ((boundary = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const lines = frame.split("\n");
                if (lines.some((line) => line.startsWith(":")) && lines.every((line) => line === "" || line.startsWith(":"))) {
                  record.comments += 1;
                  if (record.firstCommentAt === null) record.firstCommentAt = performance.now();
                } else {
                  record.frames += 1;
                  if (record.firstFrameAt === null) record.firstFrameAt = performance.now();
                }
              }
            }
          } catch (error) {
            record.error = error && error.name ? error.name : String(error);
          } finally {
            record.open = false;
            record.endedAt = performance.now();
          }
        })();
      };
      start(urls.conversation);
      start(urls.terminal);
    }, { conversation: conversationUrl, terminal: terminalUrl });

    // The named frame barriers: the window is only crossed once both origins have really published, so a quiet
    // connection that never attached cannot be mistaken for one that was kept alive.
    const rawAt = () => page.evaluate(() => (window.__shb.raw ?? []).map((record) => ({ ...record })));
    const deadline = Date.now() + 30_000;
    let raw = await rawAt();
    while ((raw.length < 2 || raw.some((record) => record.firstFrameAt === null)) && Date.now() < deadline) {
      await delay(50);
      raw = await rawAt();
    }
    result.barriers.conversationFirstFrame = raw[0]?.firstFrameAt ?? null;
    result.barriers.terminalFirstFrame = raw[1]?.firstFrameAt ?? null;
    check(raw[0]?.firstFrameAt !== null, mode + ": the conversation stream's first frame reached the browser (barrier conversation_first_frame)");
    check(raw[1]?.firstFrameAt !== null, mode + ": the terminal stream's first frame reached the browser (barrier terminal_first_frame)");

    // Cross the same window in both runs. No clock is faked and nothing is waited for that the origin or the hop does
    // not itself produce: this is simply the wall time the stated window takes.
    await delay(WINDOW_MS);
    result.barriers.windowCrossed = { at: Date.now(), wallMs: WINDOW_MS };
    raw = await rawAt();
    const app = await page.evaluate((urls) => ({
      conversation: window.__shb.sources.filter((record) => record.url === urls.conversation),
      terminal: window.__shb.sources.filter((record) => record.url === urls.terminal),
      conversationInstances: window.__shb.sources.filter((record) => record.url.startsWith("/api/agent/")).length,
      terminalInstances: window.__shb.sources.filter((record) => record.url.startsWith("/api/terminal/")).length,
      // The baseline is the handshake: the transport states `connected` when the first window arrives, and the window
      // itself is the backend's own named frame.
      baselines: window.__shb.frames.filter((frame) => frame.url === urls.conversation && (frame.event === "snapshot" || frame.event === "state")).length,
      terminalOutputs: window.__shb.frames.filter((frame) => frame.url === urls.terminal && frame.type === "output").length,
    }), { conversation: conversationUrl, terminal: terminalUrl });
    result.app = { ...result.app, ...app };
    result.raw = raw;
    result.proxyDestroyed = [...proxy.destroyed];
    result.pageErrors = pageErrors;

    const conversationRaw = raw[0];
    const terminalRaw = raw[1];
    const conversationApp = app.conversation[0];
    const terminalApp = app.terminal[0];
    const streaming = (path) => path.startsWith("/api/agent/") || path.startsWith("/api/terminal/");
    const destroyedStreaming = proxy.destroyed.filter((entry) => streaming(entry.path));

    if (mode === "enabled") {
      check(conversationRaw.comments >= 2, mode + ": the conversation origin's comment frames reached the browser across the window (" + conversationRaw.comments + ")");
      check(terminalRaw.comments >= 2, mode + ": the terminal origin's comment frames reached the browser across the window (" + terminalRaw.comments + ")");
      check(conversationRaw.error === null, mode + ": the conversation stream survived the window with no idle reset (" + conversationRaw.error + ")");
      check(terminalRaw.error === null, mode + ": the terminal stream survived the window with no idle reset (" + terminalRaw.error + ")");
      check(destroyedStreaming.length === 0, mode + ": the idle bound never fired on a streaming response (" + JSON.stringify(destroyedStreaming) + ")");
      check(app.conversationInstances === 1, mode + ": the page holds exactly one conversation source (" + app.conversationInstances + ")");
      check(conversationApp !== undefined && conversationApp.errors === 0, mode + ": the page's conversation source saw no error (" + (conversationApp?.errors ?? "no source") + ")");
      check(app.baselines === 1, mode + ": the conversation was never re-baselined (" + app.baselines + " window frames)");
      check(app.terminalInstances === 1, mode + ": the page holds exactly one terminal source (" + app.terminalInstances + ")");
      check(terminalApp !== undefined && terminalApp.errors === 0, mode + ": the page's terminal source saw no error (" + (terminalApp?.errors ?? "no source") + ")");
      check(app.terminalOutputs > 0, mode + ": the terminal really is attached and producing (" + app.terminalOutputs + " output frames)");
    } else {
      // The disabled control: the very same window, the very same bound, and no keepalive to answer it. The idle
      // disconnect is the named barrier, and it must have happened with no comment frame before it.
      const torn = raw.filter((record) => record.error !== null && record.error !== "AbortError" && !record.teardown);
      result.barriers.idleDisconnect = torn.map((record) => ({ url: record.url, error: record.error, at: record.endedAt, comments: record.comments }));
      check(torn.length > 0, mode + ": the idle bound tore the quiet stream down (barrier idle_disconnect)");
      check(raw.every((record) => record.comments === 0), mode + ": no comment frame was written without a keepalive (" + raw.map((record) => record.comments).join("/") + ")");
      check(destroyedStreaming.length > 0, mode + ": the hop is the thing that acted on the quiet response (" + JSON.stringify(destroyedStreaming.map((entry) => entry.path)) + ")");
      check(app.conversationInstances >= 1 && app.conversation.some((record) => record.errors > 0), mode + ": the page's own conversation source saw the disconnect (" + JSON.stringify(app.conversation.map((record) => record.errors)) + ")");
    }

    // The fixture's own teardown, labelled as such so it is never read as an idle reset.
    await page.evaluate(() => { for (const { record, controller } of window.__shb.control ?? []) { record.teardown = true; controller.abort(); } });
    await delay(100);
    await context.close();
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {});
    if (proxy !== undefined) await proxy.close().catch(() => {});
    for (const child of children) await stop(child);
  }
  return result;
}

const results = [];
try {
  results.push(await run("enabled", HEARTBEAT_MS));
  results.push(await run("disabled", 0));
} catch (error) {
  failures.push("the fixture did not finish: " + (error instanceof Error ? error.message : String(error)));
}

// The cross-run statement the two runs exist to make: one fixture, one bound, one window, and the cadence is the only
// difference between surviving it and being cut by it.
const enabled = results.find((result) => result.mode === "enabled");
const disabled = results.find((result) => result.mode === "disabled");
check(enabled !== undefined && disabled !== undefined, "both runs completed against the same fixture and the same idle bound");
check(enabled !== undefined && disabled !== undefined && enabled.idleMs === disabled.idleMs && enabled.windowMs === disabled.windowMs,
  "the enabled and disabled runs crossed the same window behind the same bound, so the cadence is the only variable");
check(enabled?.proxyDestroyed.filter((entry) => entry.path.startsWith("/api/agent/") || entry.path.startsWith("/api/terminal/")).length === 0,
  "with the keepalive enabled the hop destroyed no streaming response");
check((disabled?.proxyDestroyed.filter((entry) => entry.path.startsWith("/api/agent/") || entry.path.startsWith("/api/terminal/")).length ?? 0) > 0,
  "with the keepalive disabled the hop destroyed a streaming response");

const report = { revision: process.env.HEPI_SHB_REVISION ?? null, heartbeatMs: HEARTBEAT_MS, idleMs: IDLE_MS, windowMs: WINDOW_MS, windows: WINDOWS, results, failures };
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("\n" + (failures.length === 0 ? "all checks passed" : failures.length + " check(s) failed") + "; report at " + join(outDir, "report.json"));
if (failures.length > 0) { for (const failure of failures) console.log("FAIL " + failure); process.exit(1); }
