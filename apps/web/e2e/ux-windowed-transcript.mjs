/**
 * Ticket 10: the production chat mounts only the turns near the viewport, and the behaviours a reader relies on still
 * work over it.
 *
 * The deployment shape only: the production Next build, the real backend over a real SQLite store, a real local
 * execution gateway, and this script's own controlled OpenAI-completions endpoint, so nothing contacts a paid
 * provider. The fixture-based window experiment (`window-experiment.mjs`) is where the implementation was chosen;
 * this is where the shipped surface is read by a browser.
 *
 * What is asserted is what a person sees, plus the one thing only the DOM can say: how many turns are mounted. A
 * conversation far longer than a screen is opened, and the transcript must (a) mount only a bounded number of turns
 * at the top and after paging deep into it, (b) still show the live tail, (c) still reach an entry by search, (d) keep
 * the reader's place when a page of older history is prepended, and (e) keep a manually expanded process group across
 * its turn being unmounted and remounted. Every wait is an observable DOM or request state; nothing here is timed.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-windowed-transcript.mjs
 *        HEPI_WINDOW_WEB_PORT / HEPI_WINDOW_BACKEND_PORT
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
const token = "ux-window-token";
const modelId = "controlled-1";
/** Turns of the long conversation: two entries each, far past any window, so "bounded" is a real claim. Enough of
 *  them that paging back several pages and still having older history to prepend are both true in the same run. */
const TURNS = 140;
/**
 * One turn whose process group is expanded by the reader, so the expansion can be watched across the turn being
 * unmounted and remounted. It sits near the middle, far from both ends, so scrolling to either end releases it.
 */
const PROCESS_TURN = 70;
/** One turn whose answer is far taller than the viewport, so a search for it can only ever be *aligned*, not contained. */
const TALL_TURN = 12;
/** How many turns may be mounted at once. The window mounts what the viewport shows plus overscan (4), and the
 *  transcript is read at a 1400x900 viewport, so this is generous rather than tight — the point is that it does not
 *  grow with the transcript, not that it hits an exact number. */
const MAX_MOUNTED_TURNS = 24;
const webPort = Number(process.env.HEPI_WINDOW_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_WINDOW_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-window-"));
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

/**
 * One OpenAI-completions endpoint that answers with the user's own text, so a submitted phrase lands in the transcript.
 *
 * One turn is answered with a real tool call first: a turn with a tool call is a turn with a process group, which is
 * what a manual expansion has to survive being unmounted. The call is decided from the request itself — the first
 * request of a turn ends with the user's message, the second with the tool's result — so nothing here depends on a
 * counter that could drift from the conversation's own order.
 */
function controlledEndpoint() {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      const base = { id: "chatcmpl-window", object: "chat.completion.chunk", created: 1, model: modelId };
      const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const lastUser = body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const wantsTools = String(lastUser).includes("turn " + PROCESS_TURN + " of the windowed conversation");
      if (wantsTools && body.messages.at(-1)?.role !== "tool") {
        response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-process", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/tmp/window-process.txt" }) } }] }, finish_reason: null }] }));
        response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }));
        response.end("data: [DONE]\n\n");
        return;
      }
      // The turn whose process group is expanded also carries a long answer, so a reader who scrolls into the middle
      // of that turn is far below its own top: the turn's box and the message they are looking at are then different
      // boxes by hundreds of pixels, which is what a saved position must not confuse.
      const text = "answer to " + lastUser
        + (String(lastUser).includes("turn " + PROCESS_TURN + " of the windowed conversation")
          ? "\n\n" + "A line of the process answer. ".repeat(60)
          : "");
      response.write(frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
      response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }));
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
      HEPI_UX06_DB: join(dataDir, "window.sqlite"),
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
/** One settled turn: the transcript is durable before the page that must window it opens. */
async function say(id, text) {
  requestSeq += 1;
  const response = await fetch(backendOrigin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "window-" + requestSeq, text }) });
  assert.equal(response.status, 202, await response.text());
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await api("/api/conversations/" + id + "/state");
    if (!current.busy && current.entries.at(-1)?.role === "assistant") return current;
    await delay(20);
  }
  throw new Error("the turn did not settle");
}

async function newWindow() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); console.error("Browser error: " + error.stack); });
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 60_000 });
  return { page, context, pageErrors };
}

const openSession = async (page, id) => {
  await page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
  await page.locator(".markdown-user-message").first().waitFor({ timeout: 60_000 });
};

/** Which turns the window is drawing, by their own keys, and the transcript's own scroll geometry. */
const windowState = (page) => page.evaluate(() => {
  const scroll = document.querySelector("[data-chat-scroll]");
  return {
    turns: Array.from(document.querySelectorAll("[data-window-turn]")).map((turn) => turn.getAttribute("data-window-turn")),
    scrollTop: scroll?.scrollTop ?? null,
    scrollHeight: scroll?.scrollHeight ?? null,
    clientHeight: scroll?.clientHeight ?? null,
  };
});

/**
 * Bring a turn on screen by its own key, the way a reader scrolls: the window mounts whatever the viewport covers, so
 * the turn is stepped toward until it is mounted rather than jumped to by a position that is not known yet.
 */
async function scrollToTurn(page, key, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await page.evaluate((turnKey) => {
      const turn = document.querySelector('[data-window-turn="' + turnKey + '"]');
      if (!turn) return false;
      turn.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    }, key);
    if (found) return true;
    await page.evaluate(() => {
      const scroll = document.querySelector("[data-chat-scroll]");
      if (scroll) scroll.scrollTop = Math.max(0, scroll.scrollTop - scroll.clientHeight * 0.8);
    });
    await delay(80);
  }
  return false;
}

/**
 * The entry id of a turn's user message, found through the backend's own full-body search.
 *
 * The transcript's state route carries only the window it is drawing, so a turn deep in the conversation has no entry
 * id there; the search is the backend's own answer about which entry holds a phrase, which is exactly the identity
 * these scenes need and never a guess from position.
 */
/** Open the sidebar's search, whether or not it is already open: the toggle closes it as well as opening it. */
async function openSearch(page) {
  if (await page.locator("#session-search-input").count() === 0) {
    await page.getByRole("button", { name: "Search conversations", exact: true }).click();
  }
  await page.locator("#session-search-input").waitFor({ timeout: 20_000 });
}

async function entryIdForTurn(id, turn) {
  const searched = await api("/api/search?" + new URLSearchParams({ q: "turn " + turn + " of the windowed conversation" }));
  const hit = (searched.results ?? []).find((result) => result.conversationId === id);
  assert.ok(hit, "the backend's search found the turn's entry: turn " + turn);
  return hit.entryId;
}

/**
 * Bring a turn on screen the way a reader reaches one in a long conversation: through the sidebar's own search.
 *
 * Scrolling to it would depend on how much history happens to be loaded, which earlier scenes change, so the identity
 * comes from the backend's search and the surface is asked for it by entry. Returns the turn's own key.
 */
async function reachTurnBySearch(page, turn) {
  await openSearch(page);
  await page.locator("#session-search-input").fill("turn " + turn + " of the windowed conversation");
  const result = page.locator("button:has(mark)").first();
  await result.waitFor({ timeout: 30_000 });
  await result.click();
  const reached = await page.waitForFunction((text) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (!scroll) return false;
    return Array.from(document.querySelectorAll("[data-window-turn]")).some((candidate) => {
      const top = candidate.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      if (top <= -40 || top >= scroll.clientHeight) return false;
      return candidate.innerText.includes(text);
    });
  }, "turn " + turn + " of the windowed conversation", { timeout: 30_000 }).then(() => true).catch(() => false);
  assert.ok(reached, "the turn was reached through the sidebar's search: turn " + turn);
  return page.evaluate((text) => {
    const turn = Array.from(document.querySelectorAll("[data-window-turn]"))
      .find((candidate) => candidate.innerText.includes(text));
    return turn === null || turn === undefined ? null : turn.getAttribute("data-window-turn");
  }, "turn " + turn + " of the windowed conversation");
}

/** Open a turn's process group the way a reader does, and answer whether it is open afterwards. */
async function openProcessGroup(page, turnKey) {
  const toggle = page.locator('[data-window-turn="' + turnKey + '"] button[aria-expanded]').first();
  await toggle.waitFor({ timeout: 20_000 });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  return (await toggle.getAttribute("aria-expanded")) === "true";
}

/** The transcript on screen, as a person reads it: each rendered user turn's first line. */
const shown = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".markdown-user-message"))
  .map((element) => element.innerText.trim().split("\n")[0])
  .filter((text) => text.length > 0));

/** How many turns the window has mounted, and how many turns exist in the transcript it is drawing. */
const mounted = (page) => page.evaluate(() => ({
  mountedTurns: document.querySelectorAll("[data-window-turn]").length,
  spacers: document.querySelectorAll("[data-window-spacer]").length,
  scrollTop: document.querySelector("[data-chat-scroll]")?.scrollTop ?? null,
  scrollHeight: document.querySelector("[data-chat-scroll]")?.scrollHeight ?? null,
  clientHeight: document.querySelector("[data-chat-scroll]")?.clientHeight ?? null,
}));

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

  // ------------------------------------------------------------ a conversation far longer than a screen
  const id = await createSession();
  for (let index = 0; index < TURNS; index += 1) {
    // One turn carries a tall answer, so a search for it can only align its start rather than contain it; one carries a
    // process group, so a manual expansion has something to survive an unmount.
    const suffix = index === TALL_TURN ? "\n\n" + "A paragraph of the tall answer. ".repeat(400) : "";
    await say(id, "turn " + index + " of the windowed conversation" + suffix);
  }

  browser = await chromium.launch();
  const window = await newWindow();
  await openSession(window.page, id);
  // The window's own markup is what says a window is in use at all; without it the surface is drawing everything.
  const windowed = await window.page.evaluate(() => document.querySelectorAll("[data-window-turn]").length > 0);
  check(windowed, "the transcript is drawn by the window: it renders turns marked as window turns");

  const atTail = await mounted(window.page);
  check(atTail.mountedTurns > 0, "the newest turns are mounted at the tail: " + atTail.mountedTurns + " turns");
  check(atTail.mountedTurns <= MAX_MOUNTED_TURNS, "and only a bounded number of them, not the whole conversation: " + atTail.mountedTurns + " of " + TURNS + " turns");

  // ------------------------------------------------------------ paging back does not grow the mounted set
  const pageBackOnce = async (previousOldest) => {
    // The sentinel is reached from inside the page rather than by a locator action: the window re-renders as the
    // transcript moves, so an element handle resolved a moment ago can already be detached — and the reader's own
    // gesture is a scroll of the container, which is what this performs.
    const reached = await window.page.evaluate(() => {
      const sentinel = Array.from(document.querySelectorAll("div"))
        .find((element) => element.textContent === "Scroll up to load earlier messages");
      if (!sentinel) return false;
      sentinel.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    });
    if (!reached) return false;
    try {
      await window.page.waitForFunction((oldest) => {
        const first = document.querySelector(".markdown-user-message");
        return first !== null && first.innerText.trim().split("\n")[0] !== oldest;
      }, previousOldest, { timeout: 20_000 });
      return true;
    } catch { return false; }
  };
  // ------------------------------------------------------------ the reader's place survives a prepended page
  // This runs *before* the paging check below, because a prepend needs history still behind the window: once paging
  // has walked back to the conversation's beginning there is nothing left to prepend, and the check would pass or fail
  // for the wrong reason. Scrolling into the middle of what is loaded and asking for one more page is the real
  // scenario — a page of older history arrives above everything on screen.
  // The reader reaches the sentinel at the top of what is loaded, which is what asks for the previous page. The
  // observable result of a prepend is that the page they were reading is no longer the first thing in the transcript
  // and the viewport has been carried down with it — so the assertions are those two facts, read after the page
  // arrives, rather than a before/after pair that the page's own arrival can race.
  //
  // What must hold: the oldest turn the reader was looking at is still mounted, still at the top of the viewport, and
  // the transcript now has content above it (scrollTop > 0 with a spacer standing in for it). A window that let the
  // prepend move the reader would leave them at the very top of the new page instead.
  // Reaching the top of what is loaded is what asks for the previous page: the sentinel becomes visible and the
  // surface fetches the page above. Measuring the reader's place before and after is only meaningful if the page
  // cannot arrive in between, and the sentinel fires as soon as it is visible — so the page's own response is held
  // here and released once the "before" reading is taken. Without this the check races the fetch it is measuring
  // against, which is a property of the test rather than of the window.
  let releaseOlderPage = () => {};
  const olderPageHeld = new Promise((resolveHeld) => { releaseOlderPage = resolveHeld; });
  let olderPageSeen = false;
  // The surface reads the page above through the Web host's own context route (`loadContext`), which is
  // `/api/sessions/:id/context?before=…`.
  await window.page.route("**/api/sessions/**/context**", async (route) => {
    olderPageSeen = true;
    await olderPageHeld;
    await route.continue();
  });
  const beforePrepend = await window.page.evaluate(async () => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (!scroll) return null;
    const sentinel = Array.from(document.querySelectorAll("div"))
      .find((element) => element.textContent === "Scroll up to load earlier messages");
    if (!sentinel) return null;
    const scrollHeight = scroll.scrollHeight;
    scroll.scrollTop = 0;
    // A frame, so the window has re-rendered for the top of the transcript: the turns mounted there are the ones the
    // reader is looking at. The page cannot have arrived, because its response is being held.
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const viewportTop = scroll.getBoundingClientRect().top;
    const turn = Array.from(document.querySelectorAll("[data-window-turn]")).find((element) => {
      const top = element.getBoundingClientRect().top - viewportTop;
      return top <= 0 && element.getBoundingClientRect().bottom - viewportTop > 0;
    }) ?? document.querySelector("[data-window-turn]");
    return {
      scrollHeight,
      anchor: turn === null ? null : {
        key: turn.getAttribute("data-window-turn"),
        offset: Math.round(turn.getBoundingClientRect().top - viewportTop),
      },
    };
  });
  check(beforePrepend !== null && beforePrepend.anchor !== null, "a turn sits at the top of the viewport to anchor on");
  // Release the held page now that the "before" reading is taken, and read the result.
  const prepended = await (async () => {
    const pending = window.page.evaluate(async (before) => {
      const scroll = document.querySelector("[data-chat-scroll]");
      const deadline = Date.now() + 30_000;
      // A prepend is the transcript getting taller.
      const changed = () => scroll.scrollHeight > before.scrollHeight;
      while (Date.now() < deadline && !changed()) await new Promise((done) => requestAnimationFrame(done));
      // And for the window to settle on the position the prepend implies.
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const viewportTop = scroll.getBoundingClientRect().top;
      const turn = document.querySelector('[data-window-turn="' + before.anchor.key + '"]');
      return {
        arrived: changed(),
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
        spacerAbove: document.querySelector('[data-window-spacer="between"]') !== null,
        mounted: turn !== null,
        offset: turn === null ? null : Math.round(turn.getBoundingClientRect().top - viewportTop),
      };
    }, beforePrepend ?? { scrollHeight: 0, anchor: { key: "", offset: 0 } });
    releaseOlderPage();
    return pending;
  })();
  await window.page.unroute("**/api/sessions/**/context**");
  check(olderPageSeen, "reaching the top asked for a page of older history");
  check(prepended.arrived, "a page of older history was actually prepended in front of what the reader had");
  check(prepended.scrollHeight > (beforePrepend?.scrollHeight ?? 0), "and the transcript grew by it");
  check(prepended.scrollTop > 0, "and the reader was carried down with the inserted page rather than left at its top");
  check(prepended.spacerAbove, "with a spacer standing in for the turns above the reader that are not mounted");
  // The contract: the turn the reader was looking at keeps its place. Its top edge need not be exactly at the viewport
  // top — the window anchors on the turn *containing* that edge, which can start above it — so this compares where it
  // was with where it is, not with zero.
  check(
    prepended.mounted,
    "and the turn the reader was on is still mounted after the prepend (" + beforePrepend?.anchor.key + ")",
  );
  check(
    prepended.offset !== null && Math.abs(prepended.offset - (beforePrepend?.anchor.offset ?? 0)) < 16,
    "and it stayed where it was, so the reader's place survived the inserted page ("
      + (beforePrepend?.anchor.offset ?? 0) + " -> " + prepended.offset + "px)",
  );

  // ------------------------------------------------------------ paging back does not grow the mounted set
  const oldestAtTail = (await shown(window.page))[0];
  const pageBackTwice = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await shown(window.page);
      if (!(await pageBackOnce(current[0]))) return;
    }
  };
  await pageBackTwice();
  const paged = await shown(window.page);
  check(paged[0] !== oldestAtTail, "paging back loads older history: the transcript now starts at " + JSON.stringify(paged[0]));
  const deepMounted = await mounted(window.page);
  check(
    deepMounted.mountedTurns <= MAX_MOUNTED_TURNS,
    "the mounted set stayed bounded after paging into the transcript: " + deepMounted.mountedTurns + " turns, with "
      + deepMounted.spacers + " spacers standing in for the rest",
  );
  check(deepMounted.spacers > 0, "and the turns that are not mounted are represented by spacers rather than dropped");

  // ------------------------------------------------------------ a search settles on the block it matched, not the entry
  // A searched answer is looked up by the *matched block's* element and settled on that same element. The entry
  // around it is a wider box: a turn with a process group renders that group above its answer, so a settlement that
  // aligned the entry would report arrival while the matched block sat the whole group below the fold. The group is
  // opened first so the difference between the two boxes is a real height rather than a few pixels of label.
  console.log("== a searched answer settles on the matched block, below the process group above it");
  const laterTurnKey = await reachTurnBySearch(window.page, PROCESS_TURN);
  check(laterTurnKey !== null, "the turn whose answer will be searched is on screen (" + laterTurnKey + ")");
  check(await openProcessGroup(window.page, laterTurnKey), "and its process group is open, so the entry's box is taller than the matched block");
  // The answer's own text, which the backend's search finds in the *assistant* entry of that turn.
  const answerPhrase = "answer to turn " + PROCESS_TURN + " of the windowed conversation";
  await openSearch(window.page);
  await window.page.locator("#session-search-input").fill(answerPhrase);
  const answerResult = window.page.locator("button:has(mark)").first();
  await answerResult.waitFor({ timeout: 30_000 });
  await answerResult.click();
  const blockSettled = await window.page.waitForFunction((phrase) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const block = Array.from(document.querySelectorAll("[data-search-target]"))
      .find((candidate) => candidate.innerText.includes(phrase));
    if (!scroll || block === undefined) return false;
    const top = block.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return top >= 0 && top <= 40;
  }, answerPhrase, { timeout: 30_000 }).then(() => true).catch(() => false);
  const blockWhere = await window.page.evaluate((phrase) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const block = Array.from(document.querySelectorAll("[data-search-target]"))
      .find((candidate) => candidate.innerText.includes(phrase));
    const turn = block?.closest("[data-window-turn]") ?? null;
    return block === undefined || scroll === null ? null : {
      blockTop: Math.round(block.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      entryTop: Math.round((block.closest("[data-entry-id]") ?? block).getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      turnTop: turn === null ? null : Math.round(turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      turnKey: turn?.getAttribute("data-window-turn") ?? null,
    };
  }, answerPhrase);
  check(blockSettled, "the matched block itself was brought to the top of the viewport, not just the entry around it (" + JSON.stringify(blockWhere) + ")");
  check(
    blockWhere !== null && blockWhere.turnTop !== null && blockWhere.turnTop < -20,
    "and the entry's own box really is the wider one: the turn starts above the viewport while the matched block is aligned",
  );


  // ------------------------------------------------------------ a search reaches a turn the window is not drawing
  // The conversation is scrolled to its newest end, so a deep turn is nowhere near the viewport and is not mounted.
  // The sidebar's search finds that turn by its text; clicking the result asks the surface to show that entry, which
  // is a reveal by identity — the window must mount that one turn rather than the surface growing the rendered
  // history until it appears.
  await window.page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
  await delay(500);
  const deepTurn = "turn 5 of the windowed conversation";
  const beforeSearch = await mounted(window.page);
  const shownBefore = await shown(window.page);
  check(beforeSearch.mountedTurns > 0, "the window is drawing turns before the search");
  check(!shownBefore.some((text) => text.includes(deepTurn)), "and the deep turn the search will target is not among them");

  // The sidebar's search field is behind its toggle, exactly as a person reaches it.
  await openSearch(window.page);
  await window.page.locator("#session-search-input").fill(deepTurn);
  const result = window.page.locator('button:has(mark)').first();
  await result.waitFor({ timeout: 30_000 });
  await result.click();
  try {
    await window.page.waitForFunction((text) => {
      const elements = Array.from(document.querySelectorAll(".markdown-user-message"));
      return elements.some((element) => element.innerText.includes(text));
    }, deepTurn, { timeout: 30_000 });
    const afterSearch = await mounted(window.page);
    check(true, "search brought a turn the window was not drawing on screen (" + afterSearch.mountedTurns + " turns mounted)");
    check(
      afterSearch.mountedTurns <= MAX_MOUNTED_TURNS * 2,
      "and it did so with a bounded mount rather than the whole transcript: " + afterSearch.mountedTurns + " turns of " + TURNS,
    );
    // The revealed entry is actually in the viewport rather than merely mounted somewhere in the transcript. The
    // scroll that brings it there is the surface's own; this waits for it rather than reading one instant.
    const viewportState = await window.page.waitForFunction((text) => {
      const scroll = document.querySelector("[data-chat-scroll]");
      if (!scroll) return false;
      const viewportTop = scroll.getBoundingClientRect().top;
      const element = Array.from(document.querySelectorAll(".markdown-user-message"))
        .find((candidate) => candidate.innerText.includes(text));
      if (!element) return false;
      const top = element.getBoundingClientRect().top - viewportTop;
      const bottom = element.getBoundingClientRect().bottom - viewportTop;
      return top < scroll.clientHeight && bottom > 0;
    }, deepTurn, { timeout: 20_000 }).then(() => true).catch(() => false);
    const where = await window.page.evaluate((text) => {
      const scroll = document.querySelector("[data-chat-scroll]");
      const element = Array.from(document.querySelectorAll(".markdown-user-message"))
        .find((candidate) => candidate.innerText.includes(text));
      if (!scroll || !element) return { found: false };
      const viewportTop = scroll.getBoundingClientRect().top;
      return {
        found: true,
        top: Math.round(element.getBoundingClientRect().top - viewportTop),
        bottom: Math.round(element.getBoundingClientRect().bottom - viewportTop),
        clientHeight: scroll.clientHeight,
        scrollTop: Math.round(scroll.scrollTop),
      };
    }, deepTurn);
    check(viewportState === true, "and the revealed entry is inside the viewport, not merely mounted off screen (" + JSON.stringify(where) + ")");
  } catch {
    check(false, "search brought a turn the window was not drawing on screen");
  }

  // ------------------------------------------------------------ a process group's manual expansion survives unmount
  // The reader expands a turn's process group, scrolls far enough away that the window releases that turn, and comes
  // back. The group is a different component instance by then — it was unmounted in between — so an expansion kept in
  // the group's own component state would be gone, and the reader would find the opposite of what they left.
  console.log("== a manual process expansion survives its turn being unmounted and remounted");
  await window.page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
  const processEntryId = await entryIdForTurn(id, PROCESS_TURN);
  // The turn is reached the way a reader reaches a turn in the middle of a long conversation: through the sidebar's
  // search. Scrolling to it would depend on how much history happens to be loaded, which earlier scenes change.
  await openSearch(window.page);
  await window.page.locator("#session-search-input").fill("turn " + PROCESS_TURN + " of the windowed conversation");
  const processResult = window.page.locator("button:has(mark)").first();
  await processResult.waitFor({ timeout: 30_000 });
  await processResult.click();
  const reached = await window.page.waitForFunction((entryId) => {
    const turn = document.querySelector('[data-window-turn="turn-' + entryId + '"]');
    if (turn === null) return false;
    const scroll = document.querySelector("[data-chat-scroll]");
    if (scroll === null) return false;
    const top = turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return top > -40 && top < scroll.clientHeight;
  }, processEntryId, { timeout: 30_000 }).then(() => true).catch(() => false);
  check(reached, "the turn whose process group will be expanded is on screen (" + processEntryId + ")");
  // The reader opens it, whatever state an earlier scene left it in, so the check below is about an *expansion*
  // surviving rather than about a group that happened to be open already.
  const afterToggle = await openProcessGroup(window.page, "turn-" + processEntryId) ? "true" : "false";
  check(afterToggle === "true", "the reader's own toggle expanded the process group");
  // Away to the tail, far enough that the expanded turn leaves the window — and away the way a *person* leaves,
  // with a wheel over the transcript. A programmatic jump is not the reader's own gesture, and a search navigation
  // that is still pending is deliberately paused (not finished) by anything that is not the reader: a paused
  // navigation keeps its reveal in place, so the turn it named stays mounted. Scrolling like a reader is what ends
  // the navigation, which is the state this scene means to leave behind.
  await window.page.locator("[data-chat-scroll]").hover();
  await window.page.mouse.wheel(0, 100_000);
  await delay(400);
  const released = await windowState(window.page);
  check(
    !released.turns.includes("turn-" + processEntryId),
    "the expanded turn left the window at the tail (" + released.turns.length + " turns mounted: "
      + JSON.stringify(released.turns) + ")",
  );
  // And back to it. The expansion is read from the control's own aria-expanded, which is what a person sees.
  const remounted = await scrollToTurn(window.page, "turn-" + processEntryId);
  check(remounted, "the turn with the expanded process group was mounted again");
  const groupAfter = window.page.locator('[data-window-turn="turn-' + processEntryId + '"] button[aria-expanded]').first();
  await groupAfter.waitFor({ timeout: 20_000 });
  const survivedAs = await groupAfter.getAttribute("aria-expanded");
  check(
    survivedAs === afterToggle,
    "the manual expansion survived the unmount and remount (" + afterToggle + " -> " + survivedAs + ")",
  );

  // ------------------------------------------------------------ a tall searched block settles instead of scrolling forever
  // The searched answer is taller than the viewport, so it can never be *contained* by it. A reveal that required
  // containment would scroll every frame forever and the reader could not scroll away; what must happen instead is
  // that the block's start is brought to the alignment and the surface stops.
  console.log("== a searched block taller than the viewport is brought to its start and then left alone");
  const tallEntryId = await entryIdForTurn(id, TALL_TURN);
  await window.page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
  await delay(300);
  const beforeTall = await windowState(window.page);
  await openSearch(window.page);
  await window.page.locator("#session-search-input").fill("turn " + TALL_TURN + " of the windowed conversation");
  const tallResult = window.page.locator("button:has(mark)").first();
  await tallResult.waitFor({ timeout: 30_000 });
  await tallResult.click();
  const tallSettled = await window.page.waitForFunction((entryId) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const entry = document.querySelector('[data-entry-id="' + entryId + '"]');
    if (!scroll || !entry) return false;
    const top = entry.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return top >= 0 && top <= 40;
  }, tallEntryId, { timeout: 30_000 }).then(() => true).catch(() => false);
  check(tallSettled, "the tall searched block was brought to the top of the viewport");
  // Settled means *settled*: the scroll position stops changing on its own, so a reader can scroll away.
  const settledAt = await windowState(window.page);
  await delay(600);
  const stillAt = await windowState(window.page);
  check(
    Math.abs((stillAt.scrollTop ?? 0) - (settledAt.scrollTop ?? 0)) < 2,
    "and the surface stopped scrolling on its own rather than fighting the reader ("
      + Math.round(settledAt.scrollTop ?? 0) + " -> " + Math.round(stillAt.scrollTop ?? 0) + ")",
  );
  // The reader's own scroll is not overridden: they move, and they stay moved.
  const readerMoved = await window.page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (!scroll) return null;
    scroll.scrollTop = Math.max(0, scroll.scrollTop - 500);
    return scroll.scrollTop;
  });
  await delay(600);
  const readerKept = await windowState(window.page);
  check(
    readerMoved !== null && Math.abs((readerKept.scrollTop ?? 0) - readerMoved) < 2,
    "and a reader who scrolls away from it keeps their own position ("
      + Math.round(readerMoved ?? 0) + " -> " + Math.round(readerKept.scrollTop ?? 0) + ")",
  );

  // ------------------------------------------------------------ a session switch returns the reader to their place
  // Leaving a conversation and coming back restores where they were reading. That position is saved from the entries
  // the window actually mounts and restored onto the *turn* the entry belongs to, so this fails if either half of that
  // path is wrong — a save that finds no entries on a windowed transcript, or a restore that rebuilds a turn key from
  // an entry id that does not name one (a leading mid-turn segment is keyed on a message index).
  console.log("== switching away and back restores the reader's place mid-answer");
  // The scene opens the conversation fresh, the way a person returns to one. Earlier scenes have left it scrolled,
  // searched and paged, and — more importantly — the session-switch cache holds a *bounded* window for it; a restore
  // measured against that cached window would be testing the cache's partiality rather than the position being
  // restored. Reloading clears both, so what follows is the ordinary path: open, read into a turn, leave, come back.
  await window.page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
  await window.page.locator(".markdown-user-message").first().waitFor({ timeout: 60_000 });
  // The reader's place is taken *inside* a turn rather than at its top: the turn has an expanded process group and its
  // answer is long, so the turn's own top is far above the viewport while the reader is looking at a message in the
  // middle of it. That is what makes the two boxes different, and a saved position that pairs the turn's identity with
  // the *message's* offset is a jump of exactly that difference.
  const readingTurnKey = await reachTurnBySearch(window.page, PROCESS_TURN);
  check(readingTurnKey !== null, "the turn the reader will read from is on screen (" + readingTurnKey + ")");
  check(await openProcessGroup(window.page, readingTurnKey), "and its process group is expanded, so the turn's top stands well above the reader");
  // Into the middle of the turn, and with a *wheel*: the reader's own gesture is what a person uses to move after
  // finding a search hit, and it is also what ends the search navigation still pending from the step above. A
  // programmatic jump is not the reader's gesture, so it would leave the navigation paused — and a paused navigation
  // deliberately keeps its reveal in place, which is a different scene's subject.
  await window.page.locator("[data-chat-scroll]").hover();
  const wheelBy = await window.page.evaluate((turnKey) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const turn = document.querySelector('[data-window-turn="' + turnKey + '"]');
    if (!scroll || !turn) return null;
    // A third of the way into the turn: past its top, so the turn's own box starts above the viewport.
    return Math.round(turn.getBoundingClientRect().height / 3);
  }, readingTurnKey);
  check(wheelBy !== null, "the turn to read from has a measurable height");
  await window.page.mouse.wheel(0, wheelBy ?? 0);
  await delay(300);
  const scrolledInto = await window.page.evaluate(() => document.querySelector("[data-chat-scroll]")?.scrollTop ?? null);
  check(scrolledInto !== null && scrolledInto > 0, "the reader scrolled into the middle of that turn");
  await delay(300);
  // The reader's place: the turn at the top of the viewport, and where *that turn's own box* sits — the same box a
  // restore moves.
  const reading = await window.page.evaluate(() => {
    const scroll = document.querySelector("[data-chat-scroll]");
    if (!scroll) return null;
    const viewportTop = scroll.getBoundingClientRect().top;
    const turn = Array.from(document.querySelectorAll("[data-window-turn]")).find((candidate) => {
      const top = candidate.getBoundingClientRect().top - viewportTop;
      return top <= 0 && candidate.getBoundingClientRect().bottom - viewportTop > 0;
    }) ?? document.querySelector("[data-window-turn]");
    const entry = turn?.querySelector("[data-entry-id]");
    // The entry the save will anchor on, chosen the same way the surface chooses it: the last one whose top is at or
    // above the viewport's. Its box is what the two coordinates differ by.
    const entries = turn === null ? [] : Array.from(turn.querySelectorAll("[data-entry-id]"));
    let anchorEntry = entries[0] ?? null;
    for (const candidate of entries) {
      if (candidate.getBoundingClientRect().top - viewportTop > 0) break;
      anchorEntry = candidate;
    }
    return turn === null || entry === null || entry === undefined ? null : {
      turnKey: turn.getAttribute("data-window-turn"),
      entryId: entry.getAttribute("data-entry-id"),
      offset: Math.round(turn.getBoundingClientRect().top - viewportTop),
      anchorEntryId: anchorEntry?.getAttribute("data-entry-id") ?? null,
      anchorEntryOffset: anchorEntry === null ? null : Math.round(anchorEntry.getBoundingClientRect().top - viewportTop),
      scrollTop: Math.round(scroll.scrollTop),
    };
  });
  check(reading !== null, "a turn sits at the top of the viewport to be the reader's place");
  // The whole defect is that these two numbers are far apart: the reader's place is measured from the message they are
  // looking at, while the box a restore can move is the turn around it. A position saved as "this turn, that message's
  // offset" is wrong by exactly this difference.
  check(
    reading !== null && reading.offset < -100,
    "and the reader is inside the turn rather than at its top, so the turn's box starts well above the viewport ("
      + reading?.offset + "px)",
  );
  // Material means "a jump a reader would see", not a specific pixel count: the two boxes differ by everything the
  // turn draws above the message being read, which for an expanded process group is tens of pixels at least.
  check(
    reading?.anchorEntryOffset !== null && reading !== null
      && reading.anchorEntryOffset - reading.offset > 24,
    "and the entry the position will anchor on is a different box by a material distance (turn "
      + reading?.offset + "px vs entry " + reading?.anchorEntryOffset + "px)",
  );
  // Away to the shell's home, then back through the sidebar, exactly as a person moves between conversations.
  // The search panel replaces the tree while it is open, so it is closed first — the row lives in the tree.
  if (await window.page.locator("#session-search-input").count() > 0) {
    await window.page.getByRole("button", { name: "Search conversations", exact: true }).click();
    await window.page.locator("#session-search-input").waitFor({ state: "detached", timeout: 20_000 });
  }
  await window.page.getByRole("button", { name: "New", exact: true }).click();
  await window.page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  // The row lives inside a project group, which the tree may hold folded: unfold the groups the way the sidebar's own
  // control does before looking for it.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const folded = window.page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  // The tree renders rows into a virtualised list, so a row outside the scroll window is not in the DOM until the
  // list is scrolled to it. The row is found by walking the list the way a person scrolls it.
  const rowSelector = '[data-row-key="session:group:' + id + '"] .session-tree-main';
  let rowFound = false;
  for (let attempt = 0; attempt < 30 && !rowFound; attempt += 1) {
    rowFound = await window.page.evaluate((selector) => {
      const row = document.querySelector(selector);
      if (row === null) return false;
      row.scrollIntoView({ block: "center", behavior: "instant" });
      return true;
    }, rowSelector);
    if (!rowFound) {
      await window.page.evaluate(() => {
        const list = document.querySelector(".session-tree-scroll");
        if (list) list.scrollTop += list.clientHeight * 0.8;
      });
      await delay(120);
    }
  }
  const keys = await window.page.evaluate(() => Array.from(document.querySelectorAll("[data-row-key]")).map((row) => row.getAttribute("data-row-key")));
  check(rowFound, "the conversation's own sidebar row is reachable (wanted session:group:" + id + ", have " + JSON.stringify(keys.slice(0, 12)) + ")");
  await window.page.locator(rowSelector).click();
  // The transcript is *hidden* while a restore is pending, so presence is what is waited for here rather than
  // visibility: waiting for visibility would wait for the very thing being asserted.
  const restoredVisible = await window.page.waitForFunction(
    () => document.querySelectorAll(".markdown-user-message").length > 0,
    undefined,
    { timeout: 60_000 },
  ).then(() => true).catch(() => false);
  check(restoredVisible, "the conversation came back on screen after the switch");
  // The restored position is the turn the reader was on, brought back to where its top was.
  const restored = await window.page.waitForFunction((before) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const turn = document.querySelector('[data-window-turn="' + before.turnKey + '"]');
    if (!scroll || !turn) return false;
    const offset = turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return Math.abs(offset - before.offset) < 40;
  }, reading, { timeout: 30_000 }).then(() => true).catch(() => false);
  const where = await windowState(window.page);
  check(
    restored,
    "the reader's turn is back where it was, mid-answer rather than at the top of its box (saved " + reading?.offset
      + "px at scrollTop " + reading?.scrollTop + ", now scrollTop " + Math.round(where.scrollTop ?? 0)
      + ")",
  );
  // And the message the reader was actually looking at is where they left it. This is the half the defect moved:
  // pairing the turn's identity with the *message's* offset shifts the whole turn by however much of it stands above
  // that message, so the message ends up that far from where it was even though a turn is mounted and aligned.
  const anchorBack = await window.page.evaluate((before) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const entry = document.querySelector('[data-entry-id="' + before.anchorEntryId + '"]');
    if (!scroll || !entry) return null;
    return Math.round(entry.getBoundingClientRect().top - scroll.getBoundingClientRect().top);
  }, reading);
  check(
    anchorBack !== null && reading?.anchorEntryOffset !== null
      && Math.abs(anchorBack - reading.anchorEntryOffset) < 40,
    "and the message the reader was looking at is where they left it, not shifted by the turn around it (saved "
      + reading?.anchorEntryOffset + "px, now " + anchorBack + "px)",
  );
  check(
    (where.turns ?? []).includes(reading?.turnKey),
    "and it is the same turn, mounted by the window rather than re-derived from an entry id (mounted "
      + JSON.stringify((where.turns ?? []).slice(0, 14)) + ")",
  );

  // ------------------------------------------------------------ a minimap click reaches a turn the transcript draws
  // The minimap enumerates its own turns from the anchor messages it can see; the transcript draws a turn for the
  // leading mid-turn segment too, which has no anchor message. A positional index between the two therefore names a
  // different turn. This clicks the *second* minimap node, which is the one the two enumerations disagree about, and
  // asserts the turn it names is the one that comes on screen.
  console.log("== a minimap node reaches the turn the transcript draws for it");
  const minimapNode = window.page.locator("[data-minimap-node-index]").nth(1);
  await minimapNode.waitFor({ timeout: 30_000 });
  // The preview rows render on hover, which is how a reader reads a node's text before jumping to it.
  const minimapRail = window.page.locator("[data-minimap-node-index]").first().locator("..");
  await minimapRail.hover();
  await window.page.locator('[data-minimap-preview-index="1"] [data-minimap-preview-user]').waitFor({ timeout: 20_000 });
  // Which turn that node names, read from the minimap's own preview row for the same index.
  const nodeText = await window.page.evaluate(() => {
    const row = document.querySelector('[data-minimap-preview-index="1"] [data-minimap-preview-user]');
    return row === null ? null : row.innerText.trim().split("\n")[0];
  });
  await minimapNode.click({ force: true });
  const reachedByNode = await window.page.waitForFunction((text) => {
    if (text === null) return false;
    const scroll = document.querySelector("[data-chat-scroll]");
    if (!scroll) return false;
    return Array.from(document.querySelectorAll(".markdown-user-message")).some((element) => {
      if (!element.innerText.includes(text)) return false;
      const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      return top > -40 && top < scroll.clientHeight;
    });
  }, nodeText, { timeout: 30_000 }).then(() => true).catch(() => false);
  check(nodeText !== null, "the minimap's second node names a turn: " + JSON.stringify(nodeText));
  check(reachedByNode, "clicking it brought that turn's own text into the viewport: " + JSON.stringify(nodeText));

  // ------------------------------------------------------------ a deep hit is paged in until it is found
  // The searched entry is far enough back that one page of history cannot hold it. A surface that stopped after a single
  // page would report the search finished while showing nothing, which is the worst of both: the reader believes the
  // entry is on screen.
  console.log("== a hit several pages back is paged in until it is found");
  const deepest = 4;
  const deepEntryId = await entryIdForTurn(id, deepest);
  // Every loaded page is dropped by reloading the session, so the deep entry is genuinely not held: the surface must
  // page for it rather than find it in what it already has.
  await window.page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
  await window.page.locator(".markdown-user-message").first().waitFor({ timeout: 60_000 });
  const pagesRequested = [];
  window.page.on("request", (request) => {
    if (request.url().includes("/context?") && request.url().includes("before=")) pagesRequested.push(request.url());
  });
  await openSearch(window.page);
  await window.page.locator("#session-search-input").fill("turn " + deepest + " of the windowed conversation");
  const deepResult = window.page.locator("button:has(mark)").first();
  await deepResult.waitFor({ timeout: 30_000 });
  await deepResult.click();
  const deepShown = await window.page.waitForFunction((entryId) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const entry = document.querySelector('[data-entry-id="' + entryId + '"]');
    if (!scroll || !entry) return false;
    const top = entry.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    return top > -40 && top < scroll.clientHeight;
  }, deepEntryId, { timeout: 40_000 }).then(() => true).catch(() => false);
  const deepWhere = await window.page.evaluate((entryId) => {
    const scroll = document.querySelector("[data-chat-scroll]");
    const entry = document.querySelector('[data-entry-id="' + entryId + '"]');
    return {
      mounted: entry !== null,
      turn: entry?.closest("[data-window-turn]")?.getAttribute("data-window-turn") ?? null,
      top: entry === null || scroll === null ? null : Math.round(entry.getBoundingClientRect().top - scroll.getBoundingClientRect().top),
      clientHeight: scroll?.clientHeight ?? null,
      turns: document.querySelectorAll("[data-window-turn]").length,
      pending: document.querySelectorAll("[data-search-target]").length,
    };
  }, deepEntryId);
  check(deepShown, "a hit beyond the first page was paged in and shown: entry " + deepEntryId + " " + JSON.stringify(deepWhere));
  check(pagesRequested.length > 0, "the surface asked for older pages rather than reporting the search finished (" + pagesRequested.length + " page requests)");

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
  if (failures.length === 0) { console.log("WINDOWED TRANSCRIPT BROWSER CHECKS PASSED"); process.exit(0); }
  console.log("WINDOWED TRANSCRIPT BROWSER CHECKS FAILED (" + failures.length + ")");
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
