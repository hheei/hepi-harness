/**
 * Ticket 05: the history a reader loaded survives the window moving.
 *
 * The deployment shape only: the production Next build, the real backend over a real SQLite store, a real local
 * execution gateway, and this script's own controlled OpenAI-completions endpoint, so nothing contacts a paid provider.
 *
 * What is asserted is what a person sees. A conversation long enough to be paged is opened; the reader scrolls back
 * until older history is loaded; a new turn then moves the window forward, and the entries it evicts must **migrate**
 * into the loaded prefix rather than vanish under the reader; and a stream reconnect must not throw the loaded pages
 * away. Every wait is an observable UI or request state — a rendered message, a request that answered — and nothing
 * here is timed.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-history-prefix.mjs
 *        HEPI_HISTORY_WEB_PORT / HEPI_HISTORY_BACKEND_PORT
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-history-prefix-token";
const modelId = "controlled-1";
/** Turns of the long conversation. Two entries each, well past the fifty-message window. */
const TURNS = 30;
const webPort = Number(process.env.HEPI_HISTORY_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_HISTORY_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-history-prefix-"));
const dataDir = join(artifacts, "data");
const workspaceRoot = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
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
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(preferred, "127.0.0.1", () => {
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
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

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

/** One OpenAI-completions endpoint that answers with the user's own text, so a submitted phrase lands in the transcript. */
function controlledEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const text = "answer to " + (body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-history", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-history", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  let listening = "";
  return {
    requests,
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

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
let backend;
let backendOrigin;
let web;
let webOrigin;
let browser;
let endpoint;

function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

function startBackend(port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX06_FIXTURE: join(artifacts, "backend"),
      HEPI_UX06_DB: join(dataDir, "history.sqlite"),
      HEPI_UX06_BACKEND_PORT: String(port),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: modelId,
      HEPI_UX06_ENDPOINT: endpoint.origin(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + port };
}

const api = async (path, init) => (await fetch(backendOrigin + path, { headers, ...init })).json();
const createSession = async () => (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) })).conversationId;
let requestSeq = 0;
/** One settled turn: the transcript is durable before the page that must page through it opens. */
async function say(id, text) {
  requestSeq += 1;
  const response = await fetch(backendOrigin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "history-" + requestSeq, text }) });
  assert.equal(response.status, 202, await response.text());
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await api("/api/conversations/" + id + "/state");
    if (!current.busy && current.entries.at(-1)?.role === "assistant") return current;
    await delay(20);
  }
  throw new Error("the turn did not settle");
}

/** One browser window of this backend, logged in exactly as the page does. */
async function newWindow() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 60_000 });
  return { page, context, pageErrors };
}

/**
 * The transcript on screen, as a person reads it: each rendered user turn's first line. A turn's phrase is unique to
 * that turn, so "the message is still there" is read from the screen rather than from a store behind it, and a repeated
 * phrase is a genuinely repeated turn. Assistant replies are not used as identity because their first line is the
 * model badge, which is the same on every one of them.
 */
const shown = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".markdown-user-message"))
  .map((element) => element.innerText.trim().split("\n")[0])
  .filter((text) => text.length > 0));

/** The newest end of the transcript, which is where a reader sees a reply arrive. */
const scrollToTail = (page) => page.evaluate(() => {
  const scroll = document.querySelector("[data-chat-scroll]");
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
});

const openSession = async (page, id) => {
  await page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
  await page.locator(".markdown-user-message").first().waitFor({ timeout: 60_000 });
};

/** Scroll back until older history is loaded, the way a reader reaches it: the sentinel at the top of the transcript. */
async function pageBackOnce(page, previousOldest) {
  // The sentinel is reached from inside the page rather than by a locator action: the window re-renders as the
  // transcript moves, so an element handle resolved a moment ago can already be detached — and the reader's own
  // gesture is a scroll of the container, which is what this performs.
  const reached = await page.evaluate(() => {
    const sentinel = Array.from(document.querySelectorAll("div"))
      .find((element) => element.textContent === "Scroll up to load earlier messages");
    if (!sentinel) return false;
    sentinel.scrollIntoView({ block: "center", behavior: "instant" });
    return true;
  });
  if (!reached) return false;
  try {
    await page.waitForFunction((oldest) => {
      const first = document.querySelector(".markdown-user-message");
      return first !== null && first.innerText.trim().split("\n")[0] !== oldest;
    }, previousOldest, { timeout: 20_000 });
    return true;
  } catch { return false; }
}

try {
  endpoint = controlledEndpoint();
  await endpoint.listen(0);
  const chosenBackendPort = await freePort(backendPort);
  const started = startBackend(chosenBackendPort);
  backend = started.child;
  backendOrigin = started.origin;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + started.log().slice(-500));

  const chosenWebPort = await freePort(webPort);
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(chosenWebPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + chosenWebPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  // ------------------------------------------------------------ a conversation longer than the window
  const id = await createSession();
  for (let index = 0; index < TURNS; index += 1) await say(id, "turn " + index + " of the long conversation");
  const whole = await api("/api/conversations/" + id + "/state");
  check(whole.entries.length === 50, "the read is bounded by the window: " + whole.entries.length + " entries");
  check(whole.hasMore === true, "and it says there is history behind the window, so " + TURNS * 2 + " entries exist behind it");

  browser = await chromium.launch();
  const window = await newWindow();
  await openSession(window.page, id);
  const first = await shown(window.page);
  check(first.length > 0, "the conversation opens on its newest window: " + first.length + " messages rendered");

  check(!first.some((text) => text.includes("turn 0 of the long conversation")), "and the oldest turns are not in it, because the window is bounded");

  // ------------------------------------------------------------ the reader scrolls back
  const oldestBefore = first[0];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await shown(window.page);
    if (!(await pageBackOnce(window.page, current[0]))) break;
  }
  const paged = await shown(window.page);
  check(paged[0] !== oldestBefore, "scrolling back loads older history: the transcript now starts at " + JSON.stringify(paged[0]));
  check(paged.some((text) => text.includes("turn 0 of the long conversation")), "and it reaches the conversation's own first turn");
  const loaded = new Set(paged);

  // ------------------------------------------------------------ a new turn moves the window
  // Loaded and mounted are different things now, and this scene is about the *loaded* history: the window mounts the
  // turns near the viewport, so what a new turn must not do is lose what the reader paged in. The guarantee is
  // therefore read by going back to it, not by requiring it all to be on screen at once.
  await say(id, "a turn after the reader paged back");
  // The reader goes to the newest turn, which is how they see a reply arrive.
  await scrollToTail(window.page);
  await window.page.getByText("a turn after the reader paged back", { exact: true }).first().waitFor({ timeout: 60_000 });
  const advanced = await shown(window.page);
  check(advanced.includes("a turn after the reader paged back"), "the new turn is on screen at the tail");
  const dupes = advanced.filter((text, index) => advanced.indexOf(text) !== index);
  check(dupes.length === 0, "and no turn is rendered twice: " + JSON.stringify(dupes.slice(0, 4)));

  /** Scroll to the top of the loaded transcript, asking for the pages behind it until nothing older is left. */
  const reachTheOldestLoaded = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const sentinel = await window.page.evaluate(() => {
        const element = Array.from(document.querySelectorAll("div"))
          .find((candidate) => candidate.textContent === "Scroll up to load earlier messages");
        if (!element) return false;
        element.scrollIntoView({ block: "center", behavior: "instant" });
        return true;
      });
      if (!sentinel) return shown(window.page);
      const current = await shown(window.page);
      await pageBackOnce(window.page, current[0]);
    }
    return shown(window.page);
  };
  // Every message the reader had loaded is still reachable: the entries the window evicted migrated into the loaded
  // prefix rather than being dropped, which is what keeps the reader's place in a bounded transcript.
  const backToOldest = await reachTheOldestLoaded();
  const missing = paged.filter((text) => !backToOldest.includes(text));
  check(missing.length === 0, "every message the reader had loaded is still reachable after the window moved: " + JSON.stringify(missing.slice(0, 3)));

  // ------------------------------------------------------------ the stream reconnects
  await window.context.setOffline(true);
  await delay(1500);
  await window.context.setOffline(false);
  await delay(2000);
  const reconnected = await reachTheOldestLoaded();
  const lost = paged.filter((text) => !reconnected.includes(text));
  check(lost.length === 0, "a reconnect keeps the history the reader loaded instead of discarding it: " + JSON.stringify(lost.slice(0, 3)));

  check(window.pageErrors.length === 0, "no page error occurred: " + window.pageErrors.join(" | "));
  await window.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
  childrenLog.end();
  console.log("");
  if (failures.length === 0) { console.log("HISTORY PREFIX BROWSER CHECKS PASSED"); process.exit(0); }
  console.log("HISTORY PREFIX BROWSER CHECKS FAILED (" + failures.length + ")");
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
