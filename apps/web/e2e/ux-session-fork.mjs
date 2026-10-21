/**
 * Ticket 04 (capability integration) regression: forking a session at a chosen point.
 *
 * The real deployment shape only: the production Next build, the real backend over a real SQLite store, a real local
 * execution gateway and the composer's own controls. The model endpoint is this script's own OpenAI-completions
 * server and it holds its answer until the driver releases it, so "the source's run is in flight while it is forked"
 * is a real state rather than a sleep.
 *
 * What is asserted is what the user sees: Fork from a row's menu makes a new row appear in the sidebar without a page
 * reload, the copy's transcript is the source's history up to the fork point, the source's own run finishes
 * undisturbed, a second window of the same backend agrees, and a session with nothing in it is refused with a reason
 * the user can read.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-session-fork.mjs
 *        HEPI_FORK_WEB_PORT / HEPI_FORK_BACKEND_PORT
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
const token = "ux-session-fork-token";
const webPort = Number(process.env.HEPI_FORK_WEB_PORT ?? 43108);
const backendPort = Number(process.env.HEPI_FORK_BACKEND_PORT ?? 44108);
const model = "deepseek-v4.1-flash";

const artifacts = mkdtempSync(join(tmpdir(), "hepi-fork-"));
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
async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/**
 * One OpenAI-completions endpoint that records every request and holds its answer until the driver releases it, so the
 * run is genuinely in flight while the fork happens. The answer names the prompt it answered, so the transcript tells
 * the turns apart without a timestamp.
 */
function gatedEndpoint() {
  const requests = [];
  const waiters = [];
  let released = false;
  let hold = false;
  const release = () => { released = true; while (waiters.length > 0) waiters.shift()(); };
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages.filter((message) => message.role === "user").at(-1)?.content;
      requests.push({ body, prompt });
      const answer = () => {
        const text = "answer to " + (typeof prompt === "string" ? prompt : JSON.stringify(prompt));
        const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
        response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
        response.end("data: [DONE]\n\n");
      };
      if (released || !hold) answer();
      else waiters.push(answer);
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({ origin: "http://127.0.0.1:" + address.port, requests, gate: () => { hold = true; released = false; }, release, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
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

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const conversations = async () => (await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { headers })).json()).conversations;
/** The transcript of one conversation, straight from the backend: what the copy must equal, not what the page shows. */
const transcript = async (id) => (await (await fetch("http://127.0.0.1:" + backendPort + "/api/conversations/" + id + "/state", { headers })).json()).entries.map((entry) => entry.role + ":" + entry.text);

/** A window of the real Web origin, logged in, with the API traffic it made recorded. */
async function openPage(browser, origin) {
  const login = await fetch(origin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
  await context.route("**/api/projects", (route) => route.fulfill({ json: { protocol: "hepi.v1", projects: [] } }));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  return { page, context, pageErrors };
}

/** The sidebar rows, by the title the tree shows, with the group folds opened as the user opens them. */
async function rows(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let index = 0; index < 20; index += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
  await page.locator(".session-tree-main").first().waitFor({ timeout: 30_000 });
  return page.locator(".session-tree-main").evaluateAll((elements) => elements.map((element) => element.innerText.split("\n")[0]));
}

/** The transcript the page renders, so "the copy shows the source's history" is read from the screen too. */
const shown = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".markdown-user-message, [data-message-role='assistant']"))
  .map((element) => element.innerText.trim().split("\n")[0])
  .filter((text) => text.length > 0));

const send = async (page, text) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.locator("textarea").first().fill(text);
    await page.waitForTimeout(80);
    if (await page.locator("textarea").first().inputValue() === text) break;
  }
  assert.equal(await page.locator("textarea").first().inputValue(), text, "the composer kept the prompt text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
};

/** Fork one row from its ⋯ menu, the way the user does: the new row must appear without a reload. */
async function forkRow(page, title) {
  const row = page.locator(".session-tree-main").filter({ hasText: title }).first();
  await row.waitFor({ timeout: 30_000 });
  const item = row.locator("xpath=..");
  await item.hover();
  await item.locator(".session-tree-more-action").click();
  const menu = page.locator('[role="menu"]').last();
  await menu.waitFor({ timeout: 15_000 });
  const fork = menu.locator('[data-sidebar-menu-item]').filter({ hasText: "Fork" });
  assert.equal(await fork.count(), 1, "the row menu offers Fork");
  await fork.click();
}

const endpoint = await gatedEndpoint();
let browser;
const views = [];
try {
  await startBackend(join(dataDir, "fork.sqlite"), endpoint);
  const bound = (await conversations()).filter((item) => item.workspaceId === "local");
  assert.ok(bound.length > 0, "the fixture exposed a workspace-bound conversation");
  const sourceId = bound[0].id;

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

  // One window on the source conversation: two turns, so there is a point in the middle to fork from.
  const first = await openPage(browser, origin);
  views.push(first);
  await first.page.goto(origin + "/?session=" + sourceId, { waitUntil: "domcontentloaded" });
  await first.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await send(first.page, "fork turn one");
  await first.page.getByText("answer to fork turn one").first().waitFor({ timeout: 30_000 });
  await send(first.page, "fork turn two");
  await first.page.getByText("answer to fork turn two").first().waitFor({ timeout: 30_000 });
  const history = await transcript(sourceId);
  check(history.length === 4, "the source holds two turns: " + JSON.stringify(history));

  // The source runs while it is forked: the model endpoint holds the answer until the driver releases it, so the run
  // is genuinely in flight and its user turn is already committed.
  endpoint.gate();
  await send(first.page, "fork while running");
  const deadline = Date.now() + 20_000;
  while (endpoint.requests.length < 3 && Date.now() < deadline) await delay(50);
  check(endpoint.requests.length === 3, "the source's third turn reached the model and its run is in flight");
  const atFork = await transcript(sourceId);

  // A second window of the same backend forks the running source. The sidebar's Fork must make the copy's row appear
  // in that window without a page reload, and the first window must hear of it the same way.
  const second = await openPage(browser, origin);
  views.push(second);
  await second.page.goto(origin + "/?session=" + sourceId, { waitUntil: "domcontentloaded" });
  await second.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  const beforeFork = await rows(second.page);
  await forkRow(second.page, "fork turn one");
  await second.page.getByText(/Forked/).first().waitFor({ timeout: 30_000 });
  const afterFork = await rows(second.page);
  check(afterFork.length === beforeFork.length + 1, "the copy's row appeared without a reload: " + JSON.stringify(afterFork));
  check(second.pageErrors.length === 0, "no page error in the forking window: " + second.pageErrors.join(" | "));

  // The copy's history is the source's at the moment of the fork, read back through the durable API and shown on
  // screen: the turn the source was in the middle of is there as a user turn, and the answer it was waiting for is not.
  const catalog = await conversations();
  const copyRow = catalog.find((item) => item.parentConversationId === sourceId);
  check(copyRow !== undefined, "the backend records the copy's parent");
  const copyId = copyRow.id;
  const copyHistory = await transcript(copyId);
  check(JSON.stringify(copyHistory) === JSON.stringify(atFork), "the copy carries exactly the source's history at the fork: " + JSON.stringify(copyHistory));
  check(copyHistory.at(-1) === "user:fork while running", "the copy ends at the source's newest committed entry");
  const copyView = await openPage(browser, origin);
  views.push(copyView);
  await copyView.page.goto(origin + "/?session=" + copyId, { waitUntil: "domcontentloaded" });
  await copyView.page.getByText("fork turn two").first().waitFor({ timeout: 30_000 });
  const copyShown = await shown(copyView.page);
  check(copyShown.some((text) => text.includes("fork turn one")), "the copy shows the history up to the fork point");
  check(!copyShown.some((text) => text.includes("answer to fork while running")), "the copy shows no turn that was not committed when it was forked: " + JSON.stringify(copyShown));

  // The source's run is undisturbed: releasing the gate lets its own turn finish, in the source only, and the window
  // that was on the source still shows the source.
  endpoint.release();
  await first.page.getByText("answer to fork while running").first().waitFor({ timeout: 30_000 });
  const sourceAfter = await transcript(sourceId);
  check(sourceAfter.length === atFork.length + 1 && sourceAfter.at(-1) === "assistant:answer to fork while running", "the source's run finished: " + JSON.stringify(sourceAfter));
  check(JSON.stringify(await transcript(copyId)) === JSON.stringify(copyHistory), "the source's later turn did not reach the copy");
  check(first.pageErrors.length === 0, "no page error in the source's window: " + first.pageErrors.join(" | "));
  const firstRows = await rows(first.page);
  check(firstRows.length === afterFork.length, "the first window's sidebar also shows the copy, without a reload: " + JSON.stringify(firstRows));

  // A session with nothing in it is refused with a reason the user reads, and nothing is created. The refusal is
  // exercised from the row menu, so it is the toast the user would actually see.
  const countBefore = (await conversations()).length;
  const emptyCreated = await fetch("http://127.0.0.1:" + backendPort + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  assert.equal(emptyCreated.status, 201);
  const emptyId = (await emptyCreated.json()).conversationId;
  // An empty conversation's row is titled by its id, as a row with no name and no first message is.
  const emptyTitle = emptyId.slice(0, 12);
  const emptyDeadline = Date.now() + 20_000;
  let emptyRows = await rows(second.page);
  while (!emptyRows.some((title) => title.includes(emptyTitle))) {
    if (Date.now() > emptyDeadline) break;
    await delay(500);
    emptyRows = await rows(second.page);
  }
  check(emptyRows.some((title) => title.includes(emptyTitle)), "the empty session is listed so it can be forked from: " + JSON.stringify(emptyRows));
  await forkRow(second.page, emptyTitle);
  const refusal = second.page.getByText("Nothing to fork: this branch has no messages yet");
  await refusal.first().waitFor({ timeout: 20_000 });
  check(true, "an empty session is refused with a readable reason: " + (await refusal.first().innerText()).split("\n").join(" | "));
  check((await conversations()).length === countBefore + 1, "the refusal created nothing beyond the empty conversation itself");
  check((await transcript(emptyId)).length === 0, "the refused source is untouched");
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const view of views) await view.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpoint.close();
  if (failures.length > 0) { console.error("UX session fork checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  console.log("UX session fork checks PASSED");
}
