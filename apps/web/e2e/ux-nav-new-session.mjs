/**
 * Regression driver for the reported navigation flicker on a NORMAL new conversation:
 *   home -> (sidebar) New -> type plain text -> Send -> "back home immediately" -> 2-8s later the conversation returns.
 *
 * Everything is the user's own path and every answer is the real one: the real Web UI (built from this tree), the real
 * backend (apps/server/src/server.ts through apps/server/scripts/image-submit-fixture.ts) and a real local gateway
 * bound to a temporary workspace, so /api/sessions, /api/worktrees, /api/cwd/validate and /api/projects keep their own
 * semantics and nothing is stubbed. The model endpoint is this script's own OpenAI-completions server, and it holds
 * its answer until the driver releases it, so "the run is in flight" is a real state rather than a sleep.
 *
 * What is asserted is what the user sees: the sent turn stays on screen from Send until its answer arrives, and the
 * shell never falls back to the empty composer/welcome it started from. The URL is recorded too, but a turn that
 * leaves the screen while the URL still names the conversation is the same bug to the person watching it.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-nav-new-session.mjs
 *        HEPI_NAV_WEB_PORT=<port> HEPI_NAV_BACKEND_PORT=<port>
 *        HEPI_NAV_VARIANT=hold-prompt|hold-events   (delays one request, to widen the window; same assertions)
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-nav-new-token";
const webPort = Number(process.env.HEPI_NAV_WEB_PORT ?? 43120);
const backendPort = Number(process.env.HEPI_NAV_BACKEND_PORT ?? 44120);
const model = "deepseek-v4.1-flash";
const prompt = "nav new session text";
// Widens one window at a time so a regression can be read even on a fast machine. Both are request gates on the real
// routes; neither patches the app, and the assertions are the same for every variant.
const variant = process.env.HEPI_NAV_VARIANT ?? "baseline";
const holdMs = Number(process.env.HEPI_NAV_HOLD_MS ?? 3000);

const artifacts = mkdtempSync(join(tmpdir(), "hepi-navnew-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
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
  const release = () => { released = true; while (waiters.length > 0) waiters.shift()(); };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      // Each answer names its own turn, so waiting for a specific one is unambiguous across two submissions.
      const answer = () => {
        const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "nav answer " + requests.length }, finish_reason: null }] }));
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
        release,
        reset: () => { released = false; waiters = []; requests = []; },
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
 * Frame-driven observation of what the shell shows: the real URL, the real composer, the real transcript bubbles and
 * the composer's own text on every animation frame. Only transitions are kept, and a transition that takes the sent
 * turn off the screen while the chat is still mounted is recorded with what the user is looking at then.
 */
const RECORDER = () => {
  window.__navTimeline = [];
  window.__navGone = [];
  const sample = () => {
    const body = document.body ? document.body.innerText : "";
    const area = document.querySelector(".chat-input-textarea");
    const entry = {
      url: location.pathname + location.search,
      composer: document.querySelectorAll(".chat-input-shell").length,
      bubbles: document.querySelectorAll(".markdown-user-message").length,
      drafted: area instanceof HTMLTextAreaElement ? area.value : "",
      pending: body.includes("nav new session text"),
      welcome: body.includes("Get Started") || body.includes("Select a project directory from the sidebar"),
      placeholder: body.includes("Select a session from the sidebar"),
      opening: body.includes("Opening workspace..."),
      t: Math.round(performance.now()),
    };
    const timeline = window.__navTimeline;
    const last = timeline[timeline.length - 1];
    if (!last || ["url", "composer", "bubbles", "drafted", "welcome", "placeholder", "opening"].some((key) => last[key] !== entry[key])) {
      timeline.push(entry);
      // The moment the sent turn leaves the screen. The URL is deliberately part of the record: with it unchanged this
      // is the composer/welcome the user described, not a navigation.
      if (last && last.bubbles >= 1 && entry.bubbles === 0) {
        const chat = document.querySelector(".chat-content");
        window.__navGone.push({ t: entry.t, url: entry.url, chatMounted: Boolean(chat), text: (chat ? chat.innerText : body).replace(/\s+/g, " ").trim().slice(0, 120) });
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

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
  if (variant === "hold-prompt") {
    // The prompt command's own response arrives late; nothing else about the request changes.
    await context.route("**/api/agent/*", async (route) => {
      const body = route.request().postData() ?? "";
      if (route.request().method() === "POST" && body.includes('"type":"prompt"')) await delay(holdMs);
      await route.continue();
    });
  }
  if (variant === "hold-events") {
    // The event stream's first snapshot arrives late; the stream itself is the real one.
    await context.route("**/api/agent/*/events", async (route) => { await delay(holdMs); await route.continue(); });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { page, context, pageErrors };
}

const endpoint = await gatedEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(join(dataDir, "nav-new.sqlite"), endpoint);
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

  const view = await openPage(browser, origin);
  contexts.push(view.context);
  await view.page.goto(origin + "/", { waitUntil: "domcontentloaded" });

  // The real sidebar reads the real catalogue and adopts nothing by itself: the driver picks the project the way a
  // user does — the listed group's own New — and the shell's New affordance follows from that pick. A folded group is
  // opened as a user would before reading the list.
  await view.page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    const folded = view.page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  await frames(view.page, 30);
  const newButton = view.page.locator(".sidebar-new-button");
  await newButton.waitFor({ timeout: 30_000 });
  check(!(await newButton.isEnabled()), "with no project picked the real New button asks for one");
  await view.page.locator(".session-tree-group-actions .session-tree-group-action:first-child").first().click();
  await view.page.waitForFunction(() => document.querySelector(".sidebar-new-button")?.disabled === false, undefined, { timeout: 30_000 });
  check(await newButton.isEnabled(), "the real New button is enabled once the user picked a project");

  // Scene A: New -> plain text -> Send. The turn must stay on screen until its answer arrives.
  await newButton.click();
  await view.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(view.page, 20);
  const afterNew = await view.page.evaluate(() => location.pathname + location.search);
  check(afterNew.includes("cwd="), "New opened a fresh composer at its own cwd (" + afterNew + ")");
  // The fresh composer is the one place a tool-set picker used to be offered. R9 removed it because the create request
  // carries no tool selection and no command changes one afterwards, so a fresh composer must offer no such control at
  // all — an ignored choice is worse than no choice.
  check(await view.page.locator('[aria-label="Change tool preset"], [title^="Change tool preset"]').count() === 0, "the fresh composer offers no tool-set picker");

  const sendTurn = async (label, n) => {
    await view.page.locator("textarea").first().fill(prompt);
    await frames(view.page, 5);
    assert.equal(await view.page.locator("textarea").first().inputValue(), prompt, label + ": the composer kept the plain prompt text");
    await view.page.evaluate(() => { window.__navTimeline = []; window.__navGone = []; });
    await view.page.getByRole("button", { name: "Send", exact: true }).click();
    // Event gate, not a sleep: the gated endpoint answering is the proof the prompt was admitted and the run started.
    const deadline = Date.now() + 20_000;
    while (endpoint.requests.length < n && Date.now() < deadline) await delay(25);
    check(endpoint.requests.length === n, label + ": the gated model received the submission");
    await frames(view.page, 45);
    endpoint.release();
    await view.page.getByText("nav answer " + n).first().waitFor({ timeout: 30_000 });
    await frames(view.page, 60);
    const seen = await view.page.evaluate(() => ({ timeline: window.__navTimeline.slice(), gone: window.__navGone.slice() }));
    console.log("  " + label + " timeline:");
    for (const entry of seen.timeline) console.log("    " + JSON.stringify(entry));
    if (seen.gone.length > 0) console.log("  " + label + " turn left the screen: " + JSON.stringify(seen.gone));
    const pendingIndex = seen.timeline.findIndex((entry) => entry.pending && entry.composer >= 1);
    check(pendingIndex >= 0, label + ": the sent turn was rendered in a composer view");
    if (pendingIndex >= 0) {
      check(seen.gone.length === 0, label + ": the sent turn never left the screen before its answer (" + JSON.stringify(seen.gone.slice(0, 3)) + ")");
      const left = seen.timeline.slice(pendingIndex).filter((entry) => entry.welcome || entry.placeholder || entry.composer === 0 || (!entry.url.includes("session=") && !entry.url.includes("cwd=")));
      check(left.length === 0, label + ": the shell never fell back to home once the turn was sent (" + JSON.stringify(left.slice(0, 3)) + ")");
    }
    return seen;
  };

  const first = await sendTurn("fresh", 1);
  const createdId = new URL("http://x" + first.timeline[first.timeline.length - 1].url).searchParams.get("session");
  check(Boolean(createdId), "the fresh conversation owns a session id (" + createdId + ")");

  // Scene B: the same conversation, the same plain text again. This is both the second-turn path and the repeat-text
  // path: the second turn must render alongside the first instead of being taken for it.
  endpoint.reset();
  await sendTurn("repeat", 1);
  const bubbles = await view.page.locator(".markdown-user-message").count();
  check(bubbles === 2, "the repeated text renders as its own second turn (" + bubbles + " user turns on screen)");
  check(view.pageErrors.length === 0, "no page error: " + view.pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  console.log("Artifacts kept at " + artifacts + " variant=" + variant);
  if (failures.length > 0) { console.error("UX nav new-session checks FAILED [" + variant + "]: " + failures.join(" | ")); process.exit(1); }
  console.log("UX nav new-session checks PASSED [" + variant + "]");
}
