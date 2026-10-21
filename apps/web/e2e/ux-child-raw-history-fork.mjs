/**
 * Ticket 11's production browser journey: a user opens a child conversation, reads the raw history a compaction hid,
 * opens the attachment behind an image block, opens a structured reference, forks the child at a chosen entry, hides the
 * parent, and reads the branch and its inherited content afterwards.
 *
 * The real deployment shape only: the production Next build, the real backend over a real SQLite store seeded through
 * the product's own creation seam, a real local execution gateway, and this script's own controlled OpenAI-completions
 * endpoint. Nothing here is a DOM-only check of a tree: the assertions read the backend's own records — the native
 * owner edge, the branch's history, the display parent and its removal — beside what the screen shows.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-child-raw-history-fork.mjs
 *        HEPI_UX11_WEB_PORT / HEPI_UX11_BACKEND_PORT
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-child-fork-token";
const model = "deepseek-v4.1-flash";
const webPort = Number(process.env.HEPI_UX11_WEB_PORT ?? 0);
const backendPort = Number(process.env.HEPI_UX11_BACKEND_PORT ?? 0);
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-child-fork-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const children = [];
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
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
async function freePort(preferred) {
  const probe = createHttpServer();
  await new Promise((resolveListen, reject) => { probe.once("error", reject); probe.listen(preferred, "127.0.0.1", resolveListen); });
  const address = probe.address();
  const port = address !== null && typeof address === "object" ? address.port : preferred;
  await new Promise((done) => probe.close(() => done()));
  return port;
}
async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** The controlled endpoint: every request is answered, so a turn the driver sends really settles. */
function endpoint() {
  const requests = [];
  const server = createHttpServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const prompt = body.messages.filter((message) => message.role === "user").at(-1)?.content;
      requests.push({ body, prompt });
      const text = "answer to " + (typeof prompt === "string" ? prompt : JSON.stringify(prompt));
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveEndpoint, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address !== "object") { reject(new Error("no endpoint port")); return; }
      resolveEndpoint({ origin: "http://127.0.0.1:" + address.port, requests, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) });
    });
  });
}

/** The backend fixture: it seeds the child, the compaction, the image and the reference, then serves them. */
function startBackend(dbPath, endpointOrigin, port, tombstoneParent) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "child-fork-fixture.ts")], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TMPDIR: tmpdir(),
      HEPI_UX11_FIXTURE: join(artifacts, "backend"),
      HEPI_UX11_DB: dbPath,
      HEPI_UX11_BACKEND_PORT: String(port),
      HEPI_UX11_AUTH: token,
      HEPI_UX11_MODEL: model,
      HEPI_UX11_ENDPOINT: endpointOrigin,
      ...(tombstoneParent ? { HEPI_UX11_TOMBSTONE_PARENT: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
/** The port this run's backend really listens on: the environment's, or the free one this driver picked. */
let activeBackendPort = backendPort;
const backend = (path) => fetch("http://127.0.0.1:" + activeBackendPort + path, { headers });
const info = async (id) => await (await backend("/api/conversations/" + id)).json();
const read = async (id, query = "") => await (await backend("/api/conversations/" + id + "/read" + query)).json();

/** A window of the real Web origin, logged in, with the page errors it produced. */
async function openPage(browser, origin) {
  const login = await fetch(origin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: origin, sameSite: "Strict" }]);
  await context.route("**/api/projects", (route) => route.fulfill({ json: { protocol: "hepi.v1", projects: [] } }));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
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

/** The raw-history panel, opened from the toolbar's Full history control the way a user opens it. */
async function openRawHistory(page) {
  await page.getByRole("button", { name: "Full history" }).first().click();
  await page.locator("[data-raw-history]").waitFor({ timeout: 30_000 });
}

const seedLine = (output) => output.match(/HEPI_UX11_SEED (\{.*\})/);

const endpointServer = await endpoint();
let browser;
const views = [];
let seed;
try {
  const chosenBackendPort = backendPort || await freePort(0);
  const chosenWebPort = webPort || await freePort(0);
  activeBackendPort = chosenBackendPort;
  const backendChild = startBackend(join(dataDir, "seed.sqlite"), endpointServer.origin, chosenBackendPort, false);
  const backendLog = capture(backendChild);
  const backendOrigin = "http://127.0.0.1:" + chosenBackendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/conversations", { authorization: "Bearer " + token }, 90_000), "the backend started: " + backendLog().slice(-800));
  const parsed = seedLine(backendLog());
  assert.ok(parsed !== undefined, "the fixture stated the identities it seeded: " + backendLog().slice(-800));
  seed = JSON.parse(parsed[1]);
  check(typeof seed.childId === "string" && typeof seed.preCompactionEntryId === "string", "the seed exposes the child and the compacted entry: " + JSON.stringify(seed));

  // The facts this journey is about, read from the backend before any browser is opened: the child is a real delegated
  // conversation with its own native owner, and the compaction really hides the prefix from the active window.
  const childInfo = await info(seed.childId);
  check(childInfo.owner?.conversationId === seed.parentId, "the child's native owner is a task of the parent: " + JSON.stringify(childInfo.owner));
  check(childInfo.relations?.displayParentId === seed.parentId, "the child is displayed under the parent: " + JSON.stringify(childInfo.relations));
  const window = await (await backend("/api/conversations/" + seed.childId + "/state")).json();
  check(window.historyHead === seed.summaryEntryId, "the active window is led by the compaction's head marker: " + JSON.stringify({ head: window.historyHead, summary: seed.summaryEntryId }));
  check(window.entries.some((entry) => entry.id === seed.preCompactionEntryId) === false, "the compacted prefix is not in the window");
  const raw = await read(seed.childId);
  check(raw.output.some((block) => block.type === "text" && block.text.includes("BEFORE THE COMPACTION")), "the raw read still reaches the compacted prefix");
  const imageBlock = raw.details.entries.find((entry) => entry.entryId === seed.imageEntryId)?.blocks.find((block) => block.type === "image");
  check(imageBlock !== undefined, "the raw read inventories the image block: " + JSON.stringify(imageBlock));

  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(chosenWebPort)], {
    cwd: webRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(artifacts, "web-home"),
      TMPDIR: tmpdir(),
      HEPI_SERVER_URL: backendOrigin,
      HEPI_AUTH_TOKEN: token,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  const origin = "http://127.0.0.1:" + chosenWebPort;
  assert.ok(await waitForHttp(origin + "/", {}, 90_000), "the Web UI started: " + webLog().slice(-800));
  browser = await chromium.launch();

  // 1. Open the child and read the raw history the window does not carry.
  const view = await openPage(browser, origin);
  views.push(view);
  await view.page.goto(origin + "/?session=" + seed.childId, { waitUntil: "domcontentloaded" });
  await view.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await openRawHistory(view.page);
  await view.page.locator("[data-raw-entry='" + seed.preCompactionEntryId + "']").waitFor({ timeout: 30_000 });
  check(true, "the compacted entry is listed in the raw history panel");
  const panelText = await view.page.locator("[data-raw-history]").innerText();
  const panelHistory = await view.page.locator("[data-raw-history-text]").innerText().catch(() => "(no history text element)");
  check(panelText.includes("BEFORE THE COMPACTION"), "the panel shows the compacted entry's own text: " + JSON.stringify(panelHistory.slice(0, 200)) + " / panel " + JSON.stringify(panelText.slice(0, 200)));
  check(panelText.includes("pi.compaction"), "the panel lists the compaction entry itself: " + panelText.split("\n").slice(0, 12).join(" | "));

  // 2. Open the attachment behind the image block: the bytes are fetched by the block's own address.
  await view.page.locator("[data-raw-block='" + seed.imageEntryId + ":1']").click();
  await view.page.locator("[data-raw-block-body='" + seed.imageEntryId + ":1']").waitFor({ timeout: 30_000 });
  const imageSrc = await view.page.locator("[data-raw-block-body] img").first().getAttribute("src");
  check(typeof imageSrc === "string" && imageSrc.startsWith("data:image/png;base64,"), "the image block is opened as its own bytes: " + String(imageSrc).slice(0, 40));

  // 3. Open the structured reference: it opens the target conversation without injecting its text.
  const reference = await view.page.locator("[data-raw-references] button").first();
  await reference.waitFor({ timeout: 15_000 });
  check((await reference.innerText()).includes("the parent"), "the panel lists the reference with its own label: " + await reference.innerText());
  await reference.click();
  await view.page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") === id, seed.parentId, { timeout: 30_000 });
  check(true, "opening the reference selects the target conversation");
  check(view.pageErrors.length === 0, "no page error while browsing the raw history: " + view.pageErrors.join(" | "));

  // 4. Fork the child at a chosen entry from the panel, and read the branch back from the backend.
  await view.page.goto(origin + "/?session=" + seed.childId, { waitUntil: "domcontentloaded" });
  await view.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await openRawHistory(view.page);

  // 3b. A reference that names an entry the active window no longer carries. The transcript cannot show it — the
  // compaction dropped it from the window, which the backend read asserted above — so the raw read is the surface
  // that still holds it, and opening the reference must land there positioned on that entry. Before the fix the
  // navigation only moved the live window, the target cleared, and nothing was shown.
  const droppedReference = view.page.locator("[data-raw-references] button", { hasText: "the dropped decision" });
  await droppedReference.waitFor({ timeout: 15_000 });
  await droppedReference.click();
  await view.page.locator("[data-raw-history]").waitFor({ timeout: 30_000 });
  const focus = view.page.locator("[data-raw-focus='" + seed.preCompactionEntryId + "']");
  let focusShown = true;
  try { await focus.waitFor({ timeout: 20_000 }); } catch { focusShown = false; }
  check(focusShown, "a reference to a compacted entry opens the raw read positioned on that entry");
  // The positioned row is the compacted entry itself, and the history pane beside the inventory carries its line — the
  // window never could, which is why the reference had to reach this surface.
  if (focusShown) {
    check((await focus.innerText()).includes(seed.preCompactionEntryId), "the positioned entry is the one the reference named: " + (await focus.innerText()).replace(/\n/g, " ").slice(0, 80));
    check((await view.page.locator("[data-raw-history-text]").innerText()).includes("BEFORE THE COMPACTION"), "the positioned read carries the compacted entry's own line");
  }
  check(view.pageErrors.length === 0, "no page error while opening a reference to a compacted entry: " + view.pageErrors.join(" | "));

  const branchButton = view.page.locator("[data-raw-entry='" + seed.keptEntryId + "'] button").first();
  await branchButton.waitFor({ timeout: 30_000 });

  // 4a. A fork whose answer is lost. The first request really reaches the backend and commits — the route is allowed
  // to proceed and its response is then dropped — and the browser never hears the answer. The retry must be answered
  // with the branch that already exists instead of making a second one, which is only true if the retry carries the
  // attempt's own request identity rather than a fresh identity minted per HTTP request.
  const conversationsBefore = (await (await backend("/api/conversations")).json()).conversations.length;
  let forkRequests = 0;
  await view.page.route("**/api/sessions/" + seed.childId + "/fork", async (route) => {
    forkRequests += 1;
    if (forkRequests === 1) {
      // The commit happens upstream; the answer is dropped, so the panel is left with a failure and the user retries.
      await route.fetch().catch(() => undefined);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await branchButton.click();
  await delay(1500);
  const afterLostAnswer = (await (await backend("/api/conversations")).json()).conversations.length;
  check(afterLostAnswer === conversationsBefore + 1, "the lost-answer attempt committed a branch on the backend: " + JSON.stringify({ before: conversationsBefore, after: afterLostAnswer }));
  const retryButton = view.page.locator("[data-raw-entry='" + seed.keptEntryId + "'] button").first();
  await retryButton.click();
  await view.page.waitForFunction((id) => new URL(window.location.href).searchParams.get("session") !== id, seed.childId, { timeout: 30_000 });
  const branchId = new URL(view.page.url()).searchParams.get("session");
  check(typeof branchId === "string" && branchId !== seed.childId, "forking from an entry opens the new branch: " + branchId);
  const afterRetry = (await (await backend("/api/conversations")).json()).conversations.length;
  check(afterRetry === conversationsBefore + 1, "the retry after a lost answer reuses the attempt's identity instead of making a second branch: " + JSON.stringify({ before: conversationsBefore, afterRetry, branchId }));

  const branchInfo = await info(branchId);
  check(branchInfo.relations?.displayParentId === seed.childId, "the branch is displayed under the child it was taken from: " + JSON.stringify(branchInfo.relations));
  check(branchInfo.forkSource?.conversationId === seed.childId && branchInfo.forkSource?.at === seed.keptEntryId, "the branch inherits the child's history at the chosen entry: " + JSON.stringify(branchInfo.forkSource));
  check(branchInfo.owner?.conversationId === seed.childId, "the branch has its own native owner on the child: " + JSON.stringify(branchInfo.owner));
  check(branchInfo.owner?.taskId !== childInfo.owner?.taskId, "the branch does not reuse the child's own task");
  check(branchInfo.displayParentDeleted === false, "the live child is not reported as hidden");
  const branchRead = await read(branchId);
  const branchText = branchRead.output.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  // The branch point was the entry the compaction kept, so the branch holds the whole prefix up to it — including the
  // entry the compaction had dropped from the window — and nothing the child appended after it.
  check(branchText.includes("BEFORE THE COMPACTION") && branchText.includes("KEPT AFTER THE COMPACTION"), "the branch reads the inherited history up to the chosen entry: " + branchText.slice(0, 160));
  check(branchText.includes("an attachment") === false, "the entry after the branch point is not in the branch: " + branchText.slice(0, 160));
  check(branchRead.details.entries.some((entry) => entry.entryId === seed.imageEntryId) === false, "the attachment entry is not in the branch");
  check(view.pageErrors.length === 0, "no page error while forking from the raw history: " + view.pageErrors.join(" | "));

  // 5. Hide the parent, then read the child and the branch again: the removal must not cascade or promote anything.
  const parentView = await openPage(browser, origin);
  views.push(parentView);
  await parentView.page.goto(origin + "/?session=" + seed.parentId, { waitUntil: "domcontentloaded" });
  await parentView.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  const deleted = await fetch(backendOrigin + "/api/conversations/" + seed.parentId, { method: "DELETE", headers });
  check(deleted.status === 200, "the parent is removed: " + deleted.status);
  await delay(1000);

  const childAfter = await info(seed.childId);
  check(childAfter.relations?.displayParentId === seed.parentId, "the child keeps its display parent after the removal");
  check(childAfter.displayParentDeleted === true, "the child reports its parent as hidden instead of being promoted");
  check(childAfter.owner?.conversationId === seed.parentId, "the child keeps its own native owner");
  const branchAfter = await info(branchId);
  check(branchAfter.relations?.displayParentId === seed.childId, "the branch keeps the live child as its display parent");
  check(branchAfter.displayParentDeleted === false, "the branch is not marked by its grandparent's removal");
  const childReadAfter = await read(seed.childId);
  check(childReadAfter.output.some((block) => block.type === "text" && block.text.includes("BEFORE THE COMPACTION")), "the child's inherited history still reads after the parent is hidden");
  const branchReadAfter = await read(branchId);
  check(branchReadAfter.output.some((block) => block.type === "text" && block.text.includes("KEPT AFTER THE COMPACTION")), "the branch's inherited content still reads after the parent is hidden");

  // The child's own window still shows the child, and the branch is still openable in the browser afterwards.
  await view.page.goto(origin + "/?session=" + branchId, { waitUntil: "domcontentloaded" });
  await view.page.locator("textarea").first().waitFor({ timeout: 30_000 });
  check(true, "the branch is still openable in the browser after the parent is hidden");

  // 6. The sidebar keeps the child and the branch listed after the parent leaves: a removal must not cascade into the
  // rows beneath it. The child's row is titled by its first message, so the row text is the identity read here.
  const listedRows = await rows(view.page);
  const catalogue = (await (await backend("/api/conversations")).json()).conversations;
  const childRow = catalogue.find((item) => item.id === seed.childId);
  const branchRow = catalogue.find((item) => item.id === branchId);
  // The row is titled by the conversation's own name or its first message, so the titles are read from the same
  // catalogue the sidebar reads rather than guessed from the transcript.
  const titleOf = (item) => (item.title ?? item.firstMessage ?? item.id).slice(0, 20);
  check(childRow !== undefined, "the backend still lists the child after its parent is hidden");
  check(listedRows.some((title) => title.includes(titleOf(childRow))), "the child stays listed after its parent is hidden: " + JSON.stringify({ rows: listedRows, child: childRow, catalogue: catalogue.map((item) => ({ id: item.id, title: item.title, firstMessage: item.firstMessage, subagentParent: item.subagentParentConversationId, parent: item.parentConversationId })) }));
  check(branchRow !== undefined && listedRows.some((title) => title.includes(titleOf(branchRow))), "the branch stays listed after its grandparent is hidden: " + JSON.stringify({ rows: listedRows, expected: branchRow === undefined ? null : titleOf(branchRow) }));
  check(view.pageErrors.length === 0, "no page error after the parent was hidden: " + view.pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  for (const view of views) await view.context.close().catch(() => {});
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await endpointServer.close();
  if (failures.length > 0) { console.error("UX child raw history and fork checks FAILED: " + failures.join(" | ")); console.log("Artifacts kept at " + artifacts); process.exit(1); }
  console.log("UX child raw history and fork checks PASSED");
}
