/**
 * Ticket 05 (capability integration) regression: searching full conversation bodies.
 *
 * The real deployment shape only: the production Next build, the real backend over a real SQLite store, a real local
 * execution gateway and the sidebar's own search box and result rows. The model endpoint is this script's own
 * controlled OpenAI-completions server, so nothing contacts a paid provider.
 *
 * What is asserted is what the user sees and what the durable API holds: a phrase that appears only deep in a past
 * transcript returns that session with an excerpt containing the match, clicking the result opens that session at the
 * matching turn, a deleted session never appears, an entry appended after a search is found by the next search with
 * nothing rebuilt, hitting the result bound is reported as truncation rather than passed off as the whole answer, and
 * an over-long query is refused with a reason the user reads. Every wait is an observable UI or request state; there
 * are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-session-search.mjs
 *        HEPI_SEARCH_WEB_PORT / HEPI_SEARCH_BACKEND_PORT
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
const token = "ux-session-search-token";
const modelId = "controlled-1";
/** The phrase only the deep turn holds, and the phrase the removed session holds. */
const needle = "the deep decision phrase";
const removedPhrase = "a phrase the removed session alone held";
/** A phrase of its own for the no-index scene, so no other scene's results can answer for it. */
const appendedPhrase = "a phrase appended after the search";
/** A phrase of its own for the bound scene, so the 31 conversations it creates cannot pollute another search. */
const boundPhrase = "a phrase many sessions hold";
const webPort = Number(process.env.HEPI_SEARCH_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_SEARCH_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-session-search-"));
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
      const text = "search driver answer to " + (body.messages.filter((message) => message.role === "user").at(-1)?.content ?? "");
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-search", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-search", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }));
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
      HEPI_UX06_DB: join(dataDir, "search.sqlite"),
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
/** One settled turn: the transcript is durable before the search that must find it. */
async function say(id, text) {
  const response = await fetch(backendOrigin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text.replace(/\s+/g, "-").slice(0, 40) + "-" + Math.random().toString(36).slice(2, 8), text }) });
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
  // A bare load opens no project and so no composer: the shell having mounted is read from its sidebar, which is
  // where every scene here works.
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 60_000 });
  return { page, context, pageErrors };
}

async function openGroups(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let index = 0; index < 20; index += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
}

async function renameThroughSidebar(page, id, name) {
  await openGroups(page);
  const target = page.locator('[data-row-key="session:group:' + id + '"]');
  await target.waitFor({ timeout: 30_000 });
  await target.hover();
  await target.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const input = target.locator("input.session-tree-rename");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(name);
  await input.press("Enter");
  await target.getByText(name, { exact: true }).waitFor({ timeout: 30_000 });
}

/** The search panel's result rows: the buttons inside the sessions panel while the search view is open. */
const results = (page) => page.locator("#session-sidebar-panel-sessions button");
const status = (page) => page.locator("#session-sidebar-panel-sessions [role=status]").first();
const partial = (page) => page.locator("#session-sidebar-panel-sessions [role=status]").last();

/**
 * Wait for the panel to have answered the query it was just given.
 *
 * The wait is the panel's own request followed by its own rendered answer, never a duration: the response is awaited
 * first, so the "searching" render the panel makes before it issues the request has certainly happened, and the text
 * it shows afterwards is the answer rather than the previous query's.
 */
async function answered(page) {
  const response = await page.waitForResponse((candidate) => candidate.url().includes("/api/sessions/search"), { timeout: 30_000 });
  check(response.status() < 500, "the search answered without a transport failure: " + response.status());
  await page.waitForFunction(() => {
    const status = document.querySelector("#session-sidebar-panel-sessions [role=status]");
    return status !== null && status.textContent !== "Searching...";
  }, undefined, { timeout: 30_000 });
  return response;
}

/** Type a query as a user does and wait for the panel's own answer. */
async function search(page, query) {
  await page.locator("#session-search-input").fill(query);
  return answered(page);
}

/**
 * Search the same query again, as a user does by clearing the box and typing it once more. The panel re-runs on a
 * changed query, so this is the ordinary way to ask again rather than a driver-only shortcut.
 */
async function searchAgain(page, query) {
  await page.locator("#session-search-input").fill("");
  await search(page, query);
}

/**
 * The panel's over-long-query refusal, reached the way any client reaches it: a request whose query is past the bound.
 * The input's own cap stops a person typing one, so the value is set programmatically and React's change is dispatched
 * — which is exactly the client this refusal exists for.
 */
async function searchOverLong(page, length) {
  await page.locator("#session-search-input").evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, "x".repeat(length));
  return answered(page);
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

  // ------------------------------------------------------------ a phrase only a deep turn holds
  const deepId = await createSession();
  const otherId = await createSession();
  await say(deepId, "the opening turn of this session");
  await say(deepId, "a middle turn that says nothing in particular");
  await say(deepId, "the deep turn holds " + needle);
  await say(deepId, "the closing turn of this session");
  await say(otherId, "an unrelated session with its own turn");
  const deepTranscript = await api("/api/conversations/" + deepId + "/state");

  browser = await chromium.launch();
  const window = await newWindow();
  check(window.pageErrors.length === 0, "the shell mounted without a page error");
  await renameThroughSidebar(window.page, deepId, "Deep decision session");
  await renameThroughSidebar(window.page, otherId, "Unrelated session");

  await window.page.getByRole("button", { name: "Search conversations", exact: true }).click();
  await window.page.locator("#session-search-input").waitFor({ timeout: 30_000 });
  await search(window.page, needle);
  const rows = await results(window.page).allInnerTexts();
  check(rows.length === 1, "one conversation matched the phrase: " + JSON.stringify(rows));
  check(rows[0].includes("Deep decision session"), "the result names the session: " + JSON.stringify(rows[0]));
  check(rows[0].includes("the deep turn holds " + needle), "the result shows an excerpt containing the match: " + JSON.stringify(rows[0]));
  check(!rows[0].includes("the opening turn"), "the excerpt is around the match, not the session's first message: " + JSON.stringify(rows[0]));

  // ------------------------------------------------------------ opening a result opens that session at the turn
  const deepEntry = deepTranscript.entries.find((entry) => entry.text.includes(needle));
  await results(window.page).first().click();
  // The opened session renders the entry the search named, and it is on screen: the result is a way into the
  // conversation at the turn, not a way back to the top of it.
  const turn = window.page.locator('[data-entry-id="' + deepEntry.id + '"]');
  await turn.waitFor({ timeout: 30_000 });
  check((await turn.innerText()).includes(needle), "the opened session shows the matching turn: " + JSON.stringify((await turn.innerText()).slice(0, 200)));
  check(await turn.isVisible(), "the matching turn is on screen after opening the result");
  check(await results(window.page).first().getAttribute("aria-current") === "true", "the opened result is the sidebar's current session");

  // ------------------------------------------------------------ no index: an appended entry is found by the next search
  await window.page.locator("#session-search-input").fill(appendedPhrase);
  await search(window.page, appendedPhrase);
  check((await results(window.page).count()) === 0, "the phrase is not found before it is written: " + JSON.stringify(await results(window.page).allInnerTexts()));
  await say(otherId, "a later turn holds " + appendedPhrase);
  await searchAgain(window.page, appendedPhrase);
  const appended = await results(window.page).allInnerTexts();
  check(appended.length === 1 && appended[0].includes("Unrelated session"), "the next search finds the appended entry with nothing rebuilt: " + JSON.stringify(appended));

  // ------------------------------------------------------------ a deleted session never appears
  const removedId = await createSession();
  await say(removedId, removedPhrase);
  await search(window.page, removedPhrase);
  check((await results(window.page).count()) === 1, "the session holding the phrase is a result before it is removed");
  const removal = await fetch(backendOrigin + "/api/conversations/" + encodeURIComponent(removedId), { method: "DELETE", headers });
  check(removal.status === 200, "the session was removed: " + removal.status);
  check((await api("/api/conversations/" + removedId + "/state")).entries.some((entry) => entry.text.includes(removedPhrase)), "its records are retained, so the phrase is still in the store");
  // A different query, so the panel genuinely asks again rather than reusing the answer it already holds.
  await search(window.page, "removed session alone held");
  check((await results(window.page).count()) === 0, "the removed session is not a result: " + JSON.stringify(await results(window.page).allInnerTexts()));
  check((await status(window.page).innerText()).includes("No matching conversations"), "the panel says nothing matched rather than showing a stale row");

  // ------------------------------------------------------------ an over-long query is refused with a reason
  await searchOverLong(window.page, 201);
  const refusal = await status(window.page).innerText();
  check(/limited to 200 characters/.test(refusal), "the over-long query is refused with a readable reason: " + JSON.stringify(refusal));
  check((await results(window.page).count()) === 0, "the refusal is not rendered as a result row");
  await search(window.page, "a query at the bound");
  check(!/limited to 200 characters/.test(await status(window.page).innerText()), "a query within the bound is answered normally again");

  // ------------------------------------------------------------ hitting the result bound is reported as truncation
  // Thirty-one conversations holding one phrase, so the search's own result bound is genuinely reached and the panel
  // has a truncation to report. Every wait above is an observable state; nothing here is timed.
  for (let index = 0; index < 31; index += 1) {
    const id = await createSession();
    await say(id, boundPhrase + " number " + index);
  }
  await search(window.page, boundPhrase);
  const boundRows = await results(window.page).count();
  check(boundRows === 30, "the result count is bounded: " + boundRows);
  check((await partial(window.page).innerText()).includes("Search limit reached"), "the panel reports that the bound was hit: " + JSON.stringify(await partial(window.page).innerText()));

  check(window.pageErrors.length === 0, "no page error occurred: " + window.pageErrors.join(" | "));
  await window.context.close();
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
  childrenLog.end();
  console.log("Artifacts kept at " + artifacts);
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failed:");
  for (const message of failures) console.log("  - " + message);
  process.exit(1);
}
console.log("\nUX session search checks PASSED");
