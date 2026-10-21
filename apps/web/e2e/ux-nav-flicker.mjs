/**
 * Diagnosis driver for the reported navigation flicker: an image submission in an existing conversation must not
 * bounce the shell back to the home composer, and a fresh conversation must not bounce back to the composer once it
 * owns a session. The controlled model endpoint holds the completion open until the driver releases it, so the
 * "running" window is a real state, not a sleep.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-nav-flicker.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-nav-flicker-token";
const webPort = Number(process.env.HEPI_NAV_WEB_PORT ?? 43107);
const backendPort = Number(process.env.HEPI_NAV_BACKEND_PORT ?? 44107);
const model = "deepseek-v4.1-flash";
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-nav-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
assert.ok(readFileSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

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
  const requests = [];
  const waiters = [];
  let released = false;
  const release = () => { released = true; while (waiters.length > 0) waiters.shift()(); };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const answer = () => {
        const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: "nav answer" }, finish_reason: null }] }));
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
      resolveEndpoint({ origin: "http://127.0.0.1:" + address.port, requests, release, reset: () => { released = false; requests.length = 0; }, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
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

async function conversations() {
  const catalog = await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { headers: { authorization: "Bearer " + token } })).json();
  return catalog.conversations.filter((item) => item.workspaceId === "local");
}

/**
 * Frame-driven observation of what the shell shows. Nothing in the app is patched: the recorder samples the real URL
 * and the real transcript on every animation frame and keeps only the transitions.
 */
const RECORDER = () => {
  window.__navTimeline = [];
  const sample = () => {
    const url = location.pathname + location.search;
    const transcript = document.querySelectorAll("[data-message-role]").length;
    const bubble = document.body ? document.body.innerText.includes("nav existing image") : false;
    const composer = document.querySelectorAll(".chat-input-shell").length;
    const timeline = window.__navTimeline;
    const last = timeline[timeline.length - 1];
    if (!last || last.url !== url || last.transcript !== transcript || last.bubble !== bubble) {
      timeline.push({ url, transcript, bubble, composer, t: Math.round(performance.now()) });
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
  // Production shape: the durable worktree route answers with the durable root for every folder, while the session
  // list reports the conversation's own workspace path. Both are real 514 responses, captured read-only.
  // The durable worktree route answers per-cwd here, so a folder the session list has not reported yet resolves to
  // its own path as the project identity — the same pending-lookup window production has before its answer lands.
  await context.route("**/api/worktrees*", (route) => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    return route.fulfill({ json: { projectRoot: cwd, projectKey: cwd, worktrees: [], isGitRepo: false } });
  });
  await context.route("**/api/projects", (route) => route.fulfill({ json: { protocol: "hepi.v1", projects: [] } }));
  // Production shape, other half: the session list reports a workspace path for a conversation whose composer ran at
  // the durable root, so the same conversation carries two cwds depending on which route answered. Rewriting the
  // response here keeps the app untouched and the contradiction in the transport, where it really lives.
  await context.route("**/api/sessions**", async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => null);
    if (body && Array.isArray(body.sessions)) {
      body.sessions = body.sessions.map((session) => session.cwd === "/workspace/local"
        ? { ...session, cwd: "/durable", projectRoot: "/durable", projectKey: "/durable" }
        : session);
    }
    await route.fulfill({ response, json: body ?? undefined });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  const traffic = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    void response.text().then((body) => traffic.push(response.status() + " " + url.replace(origin, "") + " " + body.slice(0, 400))).catch(() => {});
  });
  return { page, context, pageErrors, traffic };
}

const imagePath = join(artifacts, "tiny.png");
writeFileSync(imagePath, TINY_PNG);

const endpoint = await gatedEndpoint();
let browser;
const contexts = [];
try {
  await startBackend(join(dataDir, "nav.sqlite"), endpoint);
  const bound = await conversations();
  assert.ok(bound.length > 0, "the fixture exposed a workspace-bound conversation");
  const boundId = bound[0].id;
  console.log("  workspace-bound conversation: " + boundId + " cwd=" + bound[0].cwd);

  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(artifacts, "web-home"),
      TMPDIR: tmpdir(),
      HEPI_SERVER_URL: "http://127.0.0.1:" + backendPort,
      HEPI_AUTH_TOKEN: token,
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

  /** Attach and submit, retrying the fill until the composer keeps it: a session load can remount the composer. */
  const sendImage = async (page, text) => {
    await page.locator('input[type="file"][accept="image/*"]').setInputFiles([imagePath]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.locator("textarea").first().fill(text);
      await frames(page, 10);
      if (await page.locator("textarea").first().inputValue() === text) break;
    }
    assert.equal(await page.locator("textarea").first().inputValue(), text, "the composer kept the prompt text");
    await page.getByRole("button", { name: "Send", exact: true }).click();
  };

  const waitForRun = async (label) => {
    const deadline = Date.now() + 20_000;
    while (endpoint.requests.length < 1 && Date.now() < deadline) await delay(50);
    check(endpoint.requests.length === 1, label + ": the gated model received the submission and the run is running");
  };

  const timeline = (page) => page.evaluate(() => window.__navTimeline.slice());
  const reset = (page) => page.evaluate(() => { window.__navTimeline = []; });

  // Scene A: a fresh conversation in the workspace-bound project, then an image submission.
  const freshView = await openPage(browser, origin);
  contexts.push(freshView.context);
  const workspaceRoot = "/workspace/local";
  await freshView.page.goto(origin + "/?cwd=" + encodeURIComponent(workspaceRoot), { waitUntil: "domcontentloaded" });
  await frames(freshView.page, 60);
  console.log("  cwd scene text: " + (await freshView.page.evaluate(() => document.body.innerText)).slice(0, 600).split("\n").join(" | "));
  console.log("  cwd scene traffic: " + JSON.stringify(freshView.traffic.slice(-6)));
  await freshView.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await frames(freshView.page, 10);
  console.log("  fresh composer at " + await freshView.page.evaluate(() => location.pathname + location.search));
  await reset(freshView.page);
  await sendImage(freshView.page, "nav fresh image");
  await waitForRun("fresh");
  await frames(freshView.page, 30);
  const freshDuring = await timeline(freshView.page);
  console.log("  fresh timeline during run: " + JSON.stringify(freshDuring));
  endpoint.release();
  await freshView.page.getByText("nav answer").first().waitFor({ timeout: 30_000 });
  await frames(freshView.page, 60);
  const freshAfter = await timeline(freshView.page);
  console.log("  fresh timeline through completion: " + JSON.stringify(freshAfter));
  const freshFromSession = freshAfter.slice(freshAfter.findIndex((entry) => entry.url.includes("session=")));
  check(freshFromSession.filter((entry) => !entry.url.includes("session=")).length === 0,
    "the fresh conversation stayed selected from send through completion (" + JSON.stringify(freshAfter) + ")");
  check(freshView.pageErrors.length === 0, "no page error in the fresh scene: " + freshView.pageErrors.join(" | "));
  const createdId = new URL("http://x" + freshAfter[freshAfter.length - 1].url).searchParams.get("session");
  console.log("  created session: " + createdId);

  // Scene B: the same conversation reopened from the sidebar, then a second image submission.
  endpoint.reset();
  const existingView = await openPage(browser, origin);
  contexts.push(existingView.context);
  await existingView.page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  // A group is open by default only while it is the current project or a pinned one (isGroupExpanded), and this page
  // opens at "/" with nothing selected — so open the groups as the user does before picking a row. The row being
  // reachable is all this scene needs; which fold an unselected shell starts in is the sidebar's own behaviour and is
  // covered by the sidebar's tests. It matters here in particular because the transport below reports a bound
  // conversation at the durable cwd, which getRecentProjects deliberately refuses to adopt as a project.
  await existingView.page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    const folded = existingView.page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  await existingView.page.locator(".session-tree-main").first().waitFor({ timeout: 30_000 });
  console.log("  rows: " + JSON.stringify(await existingView.page.locator(".session-tree-main").evaluateAll((rows) => rows.map((r) => r.getAttribute("title")))));
  const row = existingView.page.locator(".session-tree-main").filter({ hasText: /nav fresh image/ }).first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await existingView.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  console.log("  selected existing conversation -> " + await existingView.page.evaluate(() => location.pathname + location.search));
  await reset(existingView.page);
  await sendImage(existingView.page, "nav existing image");
  await waitForRun("existing");
  await frames(existingView.page, 30);
  const existingDuring = await timeline(existingView.page);
  console.log("  existing timeline during run: " + JSON.stringify(existingDuring));
  endpoint.release();
  await existingView.page.getByText("nav answer").first().waitFor({ timeout: 30_000 });
  await frames(existingView.page, 60);
  const existingAfter = await timeline(existingView.page);
  console.log("  existing timeline through completion: " + JSON.stringify(existingAfter));
  check(existingAfter.filter((entry) => !entry.url.includes("session=")).length === 0,
    "the existing conversation stayed selected from send through completion (" + JSON.stringify(existingAfter) + ")");
  check(existingView.pageErrors.length === 0, "no page error in the existing scene: " + existingView.pageErrors.join(" | "));

  // Scene C: the user leaves for home while the run is still going. Nothing may pull them back into the conversation.
  endpoint.reset();
  await reset(existingView.page);
  await sendImage(existingView.page, "nav leave image");
  await waitForRun("leave");
  await frames(existingView.page, 10);
  await existingView.page.getByRole("button", { name: "New", exact: true }).click();
  await frames(existingView.page, 20);
  const leftUrl = await existingView.page.evaluate(() => location.pathname + location.search);
  console.log("  user moved home to " + leftUrl);
  endpoint.release();
  await frames(existingView.page, 120);
  const leaveAfter = await timeline(existingView.page);
  console.log("  leave timeline through completion: " + JSON.stringify(leaveAfter));
  check(!leaveAfter.slice(-1)[0].url.includes("session="),
    "the shell stayed on home after the user left the running conversation (" + JSON.stringify(leaveAfter) + ")");
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  if (failures.length > 0) { console.error("UX nav flicker checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  console.log("UX nav flicker checks PASSED");
}
