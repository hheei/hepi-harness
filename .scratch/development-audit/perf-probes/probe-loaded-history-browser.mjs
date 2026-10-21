/**
 * Priority-4 item 2, loaded-prefix browser cost: what a reader's paged-in history costs the browser.
 *
 * The shape measured is the one the ticket-05 browser driver already proves works: the frozen production Next build
 * (a copy of the audited artifact, served by "next start" from its own directory), the real backend over a real
 * SQLite store, a real local gateway, and this probe's own controlled OpenAI-completions endpoint, so nothing
 * contacts a paid provider.
 *
 * What is measured, per scale:
 *   - CDP Performance.getMetrics (JSHeapUsedSize / JSHeapTotalSize / Nodes / LayoutCount / RecalcStyleCount /
 *     ScriptDuration / TaskDuration) before and after the reader pages older history in;
 *   - the page's own long-task entries (PerformanceObserver) and rendered DOM counts;
 *   - the number of older-history loads the reader actually triggered, each one's wall time, and the bytes the
 *     backend served for it;
 *   - the browser's real session-view cache (globalThis.__piSessionViewCache, the 8-session / 32 MiB LRU) after an
 *     in-app session switch, so the cache's own units can be compared with the heap they sit beside.
 *
 * Seeding is a direct durable commit of the entries a real transcript holds (UserEntry / AssistantEntry with
 * realistic body sizes), not a replayed submission: the run cost of 1000 turns is not what this item measures, and
 * the read surface, the projection and the render path are the real ones. The conversations themselves are created
 * through the backend's own route, so they carry the real workspace binding.
 *
 * Usage: node --import ./lib/register.mjs probe-loaded-history.mjs
 *        HEPI_PERF_SCALES=50,500,2000  HEPI_PERF_PAGE_BUDGET_MS=240000  HEPI_PROBE_KEEP=1
 */
import { execSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outputRoot = join(repoRoot, ".dev", "research-performance", "browser-history");
const artifactWeb = join(repoRoot, ".dev", "research-performance", "browser-artifact", "apps", "web");
const TOKEN = "perf-loaded-history-token";
const MODEL = "controlled-1";
const SCALES = (process.env.HEPI_PERF_SCALES ?? "50,500,2000").split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
const PAGE_BUDGET_MS = Number(process.env.HEPI_PERF_PAGE_BUDGET_MS ?? 240000);
const KEEP = process.env.HEPI_PROBE_KEEP === "1";

if (!existsSync(join(artifactWeb, ".next", "BUILD_ID"))) throw new Error("the frozen artifact is missing: " + artifactWeb);
const buildId = readFileSync(join(artifactWeb, ".next", "BUILD_ID"), "utf8").trim();

mkdirSync(join(outputRoot, "results"), { recursive: true });
mkdirSync(join(outputRoot, "logs"), { recursive: true });
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = mkdtempSync(join(tmpdir(), "hepi-perf-loaded-history-"));
const logPath = join(outputRoot, "logs", "loaded-history-" + runId + ".log");
const log = createWriteStream(logPath, { flags: "a" });
const say = (line) => { const text = String(line); log.write(text + "\n"); console.log(text); };

/** Realistic bodies: a short prompt and a markdown answer of roughly 1.8 KiB, the shape a long agent session holds. */
const userText = (index) => "turn " + index + ": review the change and tell me what to watch for in the release";
const assistantText = (index) => {
  let text = "Answer " + index + ": here is the review.\n\n";
  while (text.length < 1800) text += "- the change is scoped to the owning module, the seam is unchanged, and the regression surface is the read path (" + text.length + ")\n";
  return text;
};

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

async function waitForHttp(url, requestHeaders, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); log.write(chunk); });
  return () => chunks.join("");
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10000).then(() => child.kill("SIGKILL"))]);
}

/** One controlled OpenAI-completions endpoint that answers with a realistic body, so nothing contacts a paid provider. */
function controlledEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const text = assistantText(requests.length);
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-perf", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-perf", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  let listening = "";
  return {
    listen: (port) => new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
        listening = "http://127.0.0.1:" + address.port;
        resolveListen();
      });
    }),
    origin: () => listening,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
  };
}

const requestHeaders = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

function startFixture(port, dbPath, endpointOrigin) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(runDir, "backend"),
      HEPI_UX06_DB: dbPath,
      HEPI_UX06_BACKEND_PORT: String(port),
      HEPI_UX06_AUTH: TOKEN,
      HEPI_UX06_MODEL: MODEL,
      HEPI_UX06_ENDPOINT: endpointOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return { child, origin: "http://127.0.0.1:" + port, log: capture(child) };
}

const api = (origin, path, init) => fetch(origin + path, { headers: requestHeaders, ...init });

/** Append the transcript directly: real entries in the real store, without replaying 1000 runs to build them. */
async function seed(dbPath, plan) {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const seeded = [];
  try {
    for (const { id, count } of plan) {
      const started = Date.now();
      await harness.harness.commit(async (tx) => {
        for (let index = 0; index < Math.floor(count / 2); index += 1) {
          await tx.appendEntry(UserEntry, Number(id), { model: [{ role: "user", content: userText(index), timestamp: index * 2 }] });
          await tx.appendEntry(AssistantEntry, Number(id), { model: [{ role: "assistant", content: [{ type: "text", text: assistantText(index) }], timestamp: index * 2 + 1 }] });
        }
      }, BACKGROUND_CONTEXT);
      seeded.push({ conversationId: id, messages: Math.floor(count / 2) * 2, ms: Date.now() - started });
    }
  } finally {
    await harness.close();
  }
  return seeded;
}

const webRequire = createRequire(join(repoRoot, "apps", "web", "package.json"));
const playwright = await import(pathToFileURL(webRequire.resolve("playwright")).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (chromium === undefined) throw new Error("playwright's chromium was not resolvable");

const results = { revision: null, dirty: null, buildId, artifact: artifactWeb, scales: SCALES, pageBudgetMs: PAGE_BUDGET_MS, startedAt: new Date().toISOString(), conversations: [], measurements: [], cache: [], unmeasured: [] };

let endpoint;
let backend;
let web;
let browser;
try {
  results.revision = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  results.dirty = execSync("git status --porcelain", { cwd: repoRoot }).toString().trim().split("\n").filter(Boolean);
  say("revision " + results.revision + " (dirty files: " + results.dirty.length + "), frozen artifact build " + buildId);

  endpoint = controlledEndpoint();
  await endpoint.listen(0);

  // ------------------------------------------------------------------ create the conversations through the real route
  const dbPath = join(runDir, "history.sqlite");
  const firstPort = await freePort();
  const first = startFixture(firstPort, dbPath, endpoint.origin());
  backend = first.child;
  if (!await waitForHttp(first.origin + "/api/workspaces", requestHeaders, 45000)) throw new Error("the backend did not start: " + first.log().slice(-800));
  const created = [];
  for (const scale of SCALES) {
    const response = await api(first.origin, "/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
    const body = await response.json();
    if (response.status !== 201) throw new Error("conversation create failed: " + response.status + " " + JSON.stringify(body));
    created.push({ id: String(body.conversationId), scale });
  }
  await stop(backend);
  backend = undefined;
  say("created " + created.length + " conversations: " + JSON.stringify(created.map((entry) => ({ id: entry.id, scale: entry.scale }))));

  // ------------------------------------------------------------------ seed the transcripts directly, then serve them
  const seeded = await seed(dbPath, created.map((entry) => ({ id: entry.id, count: entry.scale })));
  results.conversations = created.map((entry, index) => ({ ...entry, seeded: seeded[index] }));
  say("seeded " + JSON.stringify(results.conversations));

  const backendPort = await freePort();
  const second = startFixture(backendPort, dbPath, endpoint.origin());
  backend = second.child;
  if (!await waitForHttp(second.origin + "/api/workspaces", requestHeaders, 45000)) throw new Error("the backend did not restart: " + second.log().slice(-800));
  const backendOrigin = second.origin;

  // ------------------------------------------------------------------ the frozen production build, on its own port
  const webPort = await freePort();
  web = spawn(process.execPath, [join(artifactWeb, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: artifactWeb,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(runDir, "web-home"),
      TMPDIR: tmpdir(),
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      HEPI_SERVER_URL: backendOrigin,
      HEPI_AUTH_TOKEN: TOKEN,
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  const webOrigin = "http://127.0.0.1:" + webPort;
  if (!await waitForHttp(webOrigin + "/", {}, 60000)) throw new Error("the frozen Web build did not start: " + webLog().slice(-800));
  say("frozen Web build serving on " + webOrigin + " against " + backendOrigin);

  browser = await chromium.launch();
  const login = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const loginPage = await login.newPage();
  await loginPage.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = loginPage.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(TOKEN);
    await loginPage.locator('button[type="submit"]').click();
  }
  await loginPage.locator(".session-tree-group-toggle").first().waitFor({ timeout: 60000 });
  const storage = await login.storageState();
  await login.close();
  say("logged in; session tree rendered");

  const cdpMetrics = async (cdp) => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const map = Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]));
    return {
      jsHeapUsed: map.JSHeapUsedSize ?? null,
      jsHeapTotal: map.JSHeapTotalSize ?? null,
      nodes: map.Nodes ?? null,
      documents: map.Documents ?? null,
      layoutCount: map.LayoutCount ?? null,
      recalcStyleCount: map.RecalcStyleCount ?? null,
      scriptDuration: map.ScriptDuration ?? null,
      taskDuration: map.TaskDuration ?? null,
    };
  };

  for (const { id, scale } of created) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US", storageState: storage });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const contextResponses = [];
    page.on("response", (response) => {
      const url = response.url();
      if (url.includes("/context?")) contextResponses.push({ url, status: response.status(), bytes: Number(response.headers()["content-length"] ?? 0) });
    });
    await page.addInitScript(() => {
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__longTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) }); }).observe({ entryTypes: ["longtask"] });
      } catch { /* no long-task support */ }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    // Wire bytes of the older-history reads, from the browser's own network stack (the responses are chunked, so a
    // content-length header is absent and the transfer size is the only browser-side byte fact).
    const pageRequests = new Map();
    await cdp.send("Network.enable").catch(() => {});
    cdp.on("Network.responseReceived", (event) => {
      if (event.response.url.includes("/context?")) pageRequests.set(event.requestId, { url: event.response.url, encoded: 0 });
    });
    cdp.on("Network.loadingFinished", (event) => {
      const entry = pageRequests.get(event.requestId);
      if (entry !== undefined) entry.encoded = event.encodedDataLength;
    });

    const domCounts = () => page.evaluate(() => ({
      userMessages: document.querySelectorAll(".markdown-user-message").length,
      entryNodes: document.querySelectorAll("[data-entry-id]").length,
      domNodes: document.getElementsByTagName("*").length,
      longTasks: window.__longTasks.length,
      longTaskMs: Math.round(window.__longTasks.reduce((total, entry) => total + entry.duration, 0)),
      longestTaskMs: window.__longTasks.reduce((longest, entry) => Math.max(longest, entry.duration), 0),
      scrollHeight: document.querySelector(".scrollbar-subtle.overflow-y-auto")?.scrollHeight ?? null,
    }));

    const measurement = { conversationId: id, scale, openMs: null, pages: 0, perPage: [], before: null, after: null, afterGc: null, pageErrors: [], contextRequests: 0, servedBytes: 0, budgetExhausted: false, stoppedAt: null };
    try {
      const openStarted = Date.now();
      await page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
      await page.locator(".markdown-user-message").first().waitFor({ timeout: 90000 });
      measurement.openMs = Date.now() - openStarted;
      measurement.before = { ...(await cdpMetrics(cdp)), ...(await domCounts()) };
      say("scale " + scale + ": opened in " + measurement.openMs + " ms, window rendered " + measurement.before.userMessages + " user messages, heap " + measurement.before.jsHeapUsed);

      // The sentinel is re-rendered as pages prepend, so it is found again on every attempt and scrolled with a plain
      // scrollIntoView: a locator action waits for the node to be stable, and a node React replaced mid-action never is.
      const scrollSentinelIntoView = () => page.evaluate(() => {
        const label = "Scroll up to load earlier messages";
        const nodes = Array.from(document.querySelectorAll("div"));
        const sentinel = nodes.find((node) => node.childElementCount === 0 && node.textContent !== null && node.textContent.trim() === label);
        if (sentinel === undefined) return false;
        sentinel.scrollIntoView({ block: "center" });
        return true;
      });

      // A page load is observed at the transport, not at the first rendered message: the transcript's own text is
      // expensive to read once the DOM is large, and the request the reader's scroll produced is the load-more fact.
      // After the request, the render is allowed to settle before the cost of it is read.
      const entryCount = () => page.evaluate(() => document.querySelectorAll("[data-entry-id]").length);
      const deadline = Date.now() + PAGE_BUDGET_MS;
      while (Date.now() < deadline) {
        let scrolled = false;
        for (let attempt = 0; attempt < 3 && !scrolled; attempt += 1) {
          scrolled = await scrollSentinelIntoView();
          if (!scrolled) await delay(250);
        }
        if (!scrolled) { measurement.stoppedAt = "no sentinel (start of history)"; break; }
        const pageStarted = Date.now();
        const requestsBefore = contextResponses.length;
        let loaded = false;
        while (Date.now() - pageStarted < 90000) {
          if (contextResponses.length > requestsBefore) { loaded = true; break; }
          await delay(100);
        }
        if (!loaded) { measurement.stoppedAt = "no older-history read followed the scroll"; break; }
        // Settle: the rendered entry count stops changing, or the bounded wait runs out.
        let previousCount = -1;
        let stable = 0;
        const settleDeadline = Date.now() + 30000;
        while (Date.now() < settleDeadline) {
          const count = await entryCount();
          if (count === previousCount) { stable += 1; if (stable >= 3) break; } else { stable = 0; previousCount = count; }
          await delay(150);
        }
        const ms = Date.now() - pageStarted;
        measurement.pages += 1;
        const counts = await domCounts();
        const heap = (await cdpMetrics(cdp)).jsHeapUsed;
        // Every fifth page the heap is read again after a forced collection, so "what the loaded prefix retains" is
        // told apart from "what has not been collected yet".
        let heapGc = null;
        if (measurement.pages % 5 === 0) {
          await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
          heapGc = (await cdpMetrics(cdp)).jsHeapUsed;
        }
        measurement.perPage.push({ page: measurement.pages, ms, userMessages: counts.userMessages, entryNodes: counts.entryNodes, domNodes: counts.domNodes, heap, heapGc, contextRequests: contextResponses.length, longTasks: counts.longTasks, longTaskMs: counts.longTaskMs });
        say("scale " + scale + ": page " + measurement.pages + " in " + ms + " ms, rendered " + counts.userMessages + " user messages, heap " + heap + (heapGc === null ? "" : " (after gc " + heapGc + ")"));
        if (counts.userMessages * 2 >= scale) { measurement.stoppedAt = "the whole seeded transcript is rendered"; break; }
      }
      if (measurement.stoppedAt === null) { measurement.budgetExhausted = true; measurement.stoppedAt = "page budget exhausted"; }
      measurement.after = { ...(await cdpMetrics(cdp)), ...(await domCounts()) };
      measurement.rendered = await page.evaluate(() => {
        const texts = Array.from(document.querySelectorAll(".markdown-user-message")).map((element) => (element.textContent ?? "").trim().split("\n")[0]);
        const ids = Array.from(document.querySelectorAll("[data-entry-id]")).map((element) => element.getAttribute("data-entry-id"));
        return { userTexts: texts.length, distinctUserTexts: new Set(texts).size, entryNodes: ids.length, distinctEntryIds: new Set(ids).size };
      });
      await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
      measurement.afterGc = await cdpMetrics(cdp);
      measurement.contextRequests = contextResponses.length;
      measurement.servedBytes = contextResponses.reduce((total, entry) => total + entry.bytes, 0);
      measurement.wireBytes = [...pageRequests.values()].reduce((total, entry) => total + entry.encoded, 0);
      measurement.wireBytesPerRequest = [...pageRequests.values()].map((entry) => entry.encoded);
      // One page's uncompressed JSON, re-read from this probe after the run, so "the page is this big" is a byte fact
      // about the payload rather than about the compressed transfer.
      const oldest = await page.evaluate(() => document.querySelector("[data-entry-id]")?.getAttribute("data-entry-id") ?? null);
      if (oldest !== null) {
        const pageUrl = backendOrigin + "/api/conversations/" + id + "/entries?before=" + oldest;
        const pageResponse = await fetch(pageUrl, { headers: requestHeaders });
        const pageText = await pageResponse.text();
        measurement.pageJsonBytes = Buffer.byteLength(pageText);
        measurement.pageJsonStatus = pageResponse.status;
      }
      measurement.pageErrors = pageErrors;

      // The real 8-session / 32 MiB LRU, as the browser itself holds it after an in-app session switch.
      const other = page.locator('.session-tree-main:not([aria-current="true"])').first();
      if (await other.count() > 0) {
        await other.click();
        await page.waitForFunction(() => globalThis.__piSessionViewCache !== undefined && globalThis.__piSessionViewCache.size > 0, null, { timeout: 30000 }).catch(() => {});
        const cache = await page.evaluate(() => {
          const store = globalThis.__piSessionViewCache;
          if (store === undefined) return { present: false };
          const entries = [];
          let total = 0;
          for (const [key, value] of store) {
            let bytes = -1;
            try { bytes = JSON.stringify(value).length; } catch { bytes = -1; }
            entries.push({ sessionId: key, bytes, messages: value.messages?.length ?? 0, prefixMessages: value.prefixMessages?.length ?? 0 });
            if (bytes > 0) total += bytes;
          }
          return { present: true, size: store.size, totalBytes: total, entries };
        });
        results.cache.push({ conversationId: id, scale, cache });
        say("scale " + scale + ": browser session-view cache " + JSON.stringify(cache));
      } else {
        results.unmeasured.push({ item: "session-view cache at scale " + scale, reason: "no other session row to switch to" });
      }
    } catch (error) {
      measurement.error = error instanceof Error ? error.stack ?? error.message : String(error);
      say("scale " + scale + " failed: " + measurement.error);
    }
    results.measurements.push(measurement);
    await context.close();
  }
} catch (error) {
  results.fatal = error instanceof Error ? error.stack ?? error.message : String(error);
  say("probe failed: " + results.fatal);
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
  results.finishedAt = new Date().toISOString();
  const resultPath = join(outputRoot, "results", "loaded-history-" + runId + ".json");
  writeFileSync(resultPath, JSON.stringify(results, null, 2) + "\n");
  log.write("results: " + resultPath + "\n");
  log.end();
  console.log("results: " + resultPath);
  if (!KEEP) { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* keep for inspection */ } }
  else console.log("kept temp dir: " + runDir);
}
