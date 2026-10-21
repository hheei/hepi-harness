/**
 * The child recovery surface in a browser: what a person reads and can do when a delegated child's preparation failed,
 * and which answer wins when two reads of the same child are in flight.
 *
 * The HTTP contract and the retry's effect on the runtime belong to the server's acceptance suite
 * (`apps/server/test/child-recovery.test.ts`), which reads and writes a real delegation. What only a mounted component
 * can show is whether those facts reach a person as **three separate objects**, whether a failed read leaves a way back,
 * whether the retry sends the identities the read stated, and whether an answer that was superseded — by a later refresh,
 * by another child, or by a replaced connection — is dropped instead of written over newer facts.
 *
 * The fixture replaces only the transport: every recovery request is held until this driver answers it, so the order of
 * arrival is decided here rather than hoped for. Answers are read after a frame boundary, not after a sleep.
 *
 * Usage: node apps/web/e2e/ux-child-recovery.mjs [--keep]
 *        HEPI_CHILD_RECOVERY_PORT=<port>
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_CHILD_RECOVERY_PORT ?? 43134);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

/** A parked preparation and a live reporter, in the wire shape the Backend answers with. */
const PARKED = {
  requestId: "parent:attempt-1",
  preparation: "unretried-failure",
  preparationFailedTaskId: "41",
  preparationOutcome: "failed",
  preparationError: "the summarizer answered no summary",
  anchorPhase: "preparing",
};
const RETRIED = { ...PARKED, preparation: "retried", preparationRetriedTaskId: "41" };
/** The same child, another attempt: a failure a later read states, distinct from the one above. */
const LATER = {
  requestId: "parent:attempt-2",
  preparation: "unretried-failure",
  preparationFailedTaskId: "57",
  anchorPhase: "idle",
  delivery: "awaiting-delivery",
};
/** A child whose report the reporter is still waiting on: delivery and preparation are separate facts. */
const WAITING = { requestId: "parent:attempt-3", delivery: "waiting-child", anchorPhase: "idle" };

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-child-recovery-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-child-recovery.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-child-recovery</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-child-recovery.fixture.js\"></script>",
  "</body></html>",
].join("\n"));

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  const type = name.includes("/") || name.includes("..") ? undefined : contentTypes[extname(name)];
  if (!type) { response.writeHead(404).end("not found"); return; }
  readFile(join(buildDir, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

/** Read the child's panel as rendered: its state, its words, and the actions it offers. */
const panel = (page) => page.evaluate(() => {
  const node = document.querySelector("#child [data-child-recovery]");
  if (node === null) return { state: "absent", words: [], buttons: [], preparation: null, delivery: null, anchor: null, notices: [] };
  const button = (selector) => [...(node.querySelectorAll(selector) ?? [])].map((each) => each.textContent?.trim() ?? "");
  return {
    state: node.getAttribute("data-child-recovery"),
    preparation: node.getAttribute("data-child-preparation"),
    delivery: node.getAttribute("data-child-delivery"),
    anchor: node.getAttribute("data-child-anchor"),
    words: [...node.querySelectorAll("[data-recovery-word]")].map((each) => (each.getAttribute("data-recovery-word") ?? "") + "=" + (each.textContent ?? "").trim()),
    buttons: button("button"),
    notices: button("[data-child-recovery-notice]"),
    text: (node.textContent ?? "").trim(),
  };
});

/** The browser has committed the last state update: two frame boundaries, never a sleep. */
const committed = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** Ask the current child for its facts again, the way a person does. */
const refresh = (page) => page.locator("#child button", { hasText: "Refresh" }).click();

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    // ── Journey 1: a read that failed says so, offers its own way back, and the retry it then offers carries the
    // identities the read stated to the same child.
    await page.waitForFunction(() => window.__recovery?.reads === 1, undefined, { timeout: 15_000 });
    const asked = await page.evaluate(() => ({ reads: window.__recovery.reads, conversations: window.__recovery.conversations }));
    check(asked.conversations.length === 1 && asked.conversations[0] === "child-1", "one read, at the child's own address: " + JSON.stringify(asked));
    check((await panel(page)).state === "loading", "the panel states that it is reading, and claims nothing yet");

    // The read never produced an answer: the connection dropped before it answered.
    await page.evaluate(() => { window.__recovery.failRead(1); });
    await page.waitForFunction(() => document.querySelector("#child [data-child-recovery=\"unavailable\"]") !== null, undefined, { timeout: 15_000 });
    const unavailable = await panel(page);
    check(/could not be read/i.test(unavailable.text), "a read that never answered is stated as one: " + unavailable.text);
    check(unavailable.buttons.some((label) => /Refresh/i.test(label)), "and offers a way to read again from the child itself: " + JSON.stringify(unavailable.buttons));

    // Read again, and answer with a parked preparation this time.
    await page.locator("#child button", { hasText: "Refresh" }).click();
    await page.waitForFunction(() => window.__recovery.reads === 2, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(2, facts); }, PARKED);
    await page.waitForFunction(() => document.querySelector("#child [data-child-recovery=\"facts\"]") !== null, undefined, { timeout: 15_000 });
    const facts = await panel(page);
    check(facts.preparation === "unretried-failure", "the preparation is its own fact: " + facts.preparation);
    check(facts.anchor === "preparing", "the anchor parked on it is stated beside it: " + facts.anchor);
    check(facts.delivery === "none", "a dispatch with no report claims no delivery: " + facts.delivery);
    check(/context preparation failed/.test(facts.text), "the failed preparation is worded for a person: " + facts.text);
    check(facts.text.includes(PARKED.preparationError), "the runtime's own reason is shown as it arrived");
    check(facts.buttons.some((label) => /Retry preparation/i.test(label)), "the retry is offered: " + JSON.stringify(facts.buttons));

    // The retry is one POST to the same child, carrying exactly the read's two identities.
    await page.locator("#child [data-child-recovery-retry]").click();
    await page.waitForFunction(() => window.__recovery.retries === 1, undefined, { timeout: 15_000 });
    const sent = await page.evaluate(() => ({ bodies: window.__recovery.retryBodies, conversations: window.__recovery.retryConversations }));
    check(sent.conversations[0] === "child-1", "the retry addresses the same child: " + sent.conversations[0]);
    assert.deepEqual(sent.bodies[0], { requestId: PARKED.requestId, failedTaskId: PARKED.preparationFailedTaskId });
    check(true, "and sends the identities the read stated, nothing else: " + JSON.stringify(sent.bodies[0]));

    await page.evaluate((facts) => { window.__recovery.answerRetry(1, facts); }, RETRIED);
    await page.waitForFunction(() => document.querySelector("#child [data-child-preparation=\"retried\"]") !== null, undefined, { timeout: 15_000 });
    const retried = await panel(page);
    check(/preparation retry asked/.test(retried.text), "the answer restates the child's facts as retried: " + retried.text);
    check(!retried.buttons.some((label) => /Retry preparation/i.test(label)), "and the offer is gone, because asking twice is asking once: " + JSON.stringify(retried.buttons));

    // ── Journey 2: a retry is still in flight when the reader asks for the facts again, and the retry answers last.
    // The newer decision — the read — is the one on screen; the retry's late answer is dropped rather than written over
    // it, and the facts it would have restated never appear.
    await refresh(page);
    await page.waitForFunction(() => window.__recovery.reads === 3, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(3, facts); }, PARKED);
    await page.waitForFunction(() => document.querySelector("#child [data-child-recovery-retry]") !== null, undefined, { timeout: 15_000 });

    await page.locator("#child [data-child-recovery-retry]").click();
    await page.waitForFunction(() => window.__recovery.retries === 2, undefined, { timeout: 15_000 });
    await refresh(page);
    await page.waitForFunction(() => window.__recovery.reads === 4, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(4, facts); }, WAITING);
    await page.waitForFunction(() => document.querySelector("#child [data-child-delivery=\"waiting-child\"]") !== null, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRetry(2, facts); }, LATER);
    await committed(page);
    const afterStaleRetry = await panel(page);
    check(afterStaleRetry.delivery === "waiting-child", "the read asked for after the retry is the one on screen: " + afterStaleRetry.delivery);
    check(afterStaleRetry.preparation === "none", "and the retry's late answer did not restate the facts over it: " + afterStaleRetry.preparation);
    check(!afterStaleRetry.buttons.some((label) => /Retry preparation/i.test(label)), "so no retry is offered for an attempt those facts do not name: " + JSON.stringify(afterStaleRetry.buttons));

    // ── Journey 3: the child on screen is replaced while a read of the previous one is still in flight. That answer
    // must not appear under the new child's name — neither when the session changes nor when the connection does.
    await refresh(page);
    await page.waitForFunction(() => window.__recovery.reads === 5, undefined, { timeout: 15_000 });
    await page.evaluate(() => { window.__recovery.swapSession(); });
    await page.waitForFunction(() => window.__recovery.reads === 6, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(6, facts); }, LATER);
    await page.waitForFunction(() => document.querySelector("#child [data-child-preparation=\"unretried-failure\"]") !== null, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(5, facts); }, WAITING);
    await committed(page);
    const afterSession = await panel(page);
    check(afterSession.delivery === "awaiting-delivery", "the new child's own delivery is on screen: " + afterSession.delivery);
    check(afterSession.preparation === "unretried-failure", "the previous child's late answer did not replace it: " + afterSession.preparation);

    // A replaced connection is a new client; the previous one is left undisposed, so only the panel's ordering rule can
    // keep its answer off the screen.
    await refresh(page);
    await page.waitForFunction(() => window.__recovery.reads === 7, undefined, { timeout: 15_000 });
    await page.evaluate(() => { window.__recovery.swapConnection(); });
    await page.waitForFunction(() => window.__recovery.reads === 8, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(8, facts); }, WAITING);
    await page.waitForFunction(() => document.querySelector("#child [data-child-delivery=\"waiting-child\"]") !== null, undefined, { timeout: 15_000 });
    await page.evaluate((facts) => { window.__recovery.answerRead(7, facts); }, LATER);
    await committed(page);
    const afterConnection = await panel(page);
    check(afterConnection.delivery === "waiting-child", "the replaced connection's own read is on screen: " + afterConnection.delivery);
    check(afterConnection.preparation === "none", "the previous connection's late answer did not land under it: " + afterConnection.preparation);

    // An ordinary conversation is no delegation's child: it asks nothing and states nothing, whatever else is on screen.
    const ordinary = await page.evaluate(() => document.querySelector("#ordinary [data-child-recovery]") === null);
    check(ordinary, "a conversation the catalogue does not state as a delegated child renders nothing");
    const named = await page.evaluate(() => window.__recovery.conversations);
    check(!named.includes("ordinary-1"), "and never asks the Backend about it: " + JSON.stringify(named));
    check(pageErrors.length === 0, "the page raised no error" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_CHILD_RECOVERY_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("fixture kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
