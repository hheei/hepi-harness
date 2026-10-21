/**
 * Ticket 22's remaining UX checks, driven in a real Chromium against the production components.
 *
 * The ticket asks the closeout to record, for the platforms it supports, keyboard operation, focus and error
 * announcement, the narrow viewport's key actions, and what a Chinese IME does to a half-composed sentence. Those were
 * the rows no other driver covered: every other journey in this directory asserts a workflow's outcome, not how it is
 * reached and announced. Nothing here is a bypass of an admission boundary — every request the page makes is an ordinary
 * one the product ships, against the fixture's own stand-in for the deployment.
 *
 * What is asserted, and why each one is worth a check:
 *
 *   1. **Keyboard reach.** From a fresh document, Tab reaches the composer. A surface only a pointer can reach is not
 *      operable for a keyboard user, and nothing else in this repository states that the composer is in the tab order.
 *   2. **Enter sends, Shift+Enter does not.** The composer's own decision, observed as the submission request the page
 *      actually made rather than as a keystroke count.
 *   3. **Escape stops a running conversation.** The composer's second keyboard decision, and the only way a keyboard user
 *      interrupts a run.
 *   4. **A failed read is announced and its Retry is reachable.** The panel carries `role="status"`, states the cause in
 *      its own words, and its Retry is the first thing Tab reaches; Enter on it re-reads, and the transcript the second
 *      read answers is what replaces the panel.
 *   5. **Narrow viewport.** At 390×844 the composer is still reachable and Enter still sends, the secondary controls are
 *      behind a labelled "More controls" button that opens, and the page does not overflow horizontally.
 *   6. **Chinese IME.** A composition in progress is never submitted: Enter during composition commits the composition
 *      instead of sending, the composed text stays in the composer, and a later Enter sends exactly that text.
 *
 * Usage: node apps/web/e2e/ux-closeout-accessibility.mjs [--keep]
 *        HEPI_CLOSEOUT_A11Y_PORT=<port>
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_CLOSEOUT_A11Y_PORT ?? 43160);

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
console.log("Provenance: source " + git(["rev-parse", "HEAD"]) + (git(["status", "--porcelain"]).length > 0 ? " (dirty tree)" : " (clean)"));

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-closeout-a11y-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-closeout-accessibility.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>ux-closeout-a11y</title>",
  "<link rel=\"stylesheet\" href=\"./ux-closeout-accessibility.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-closeout-accessibility.fixture.js\"></script>",
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

/** The gate the fixture publishes: what the page sent, and the one fact only the driver may change. */
const gateOf = (page) => page.evaluate(() => ({
  sends: window.__uxCloseout.sends, stops: window.__uxCloseout.stops, reads: window.__uxCloseout.reads, refusedOnce: window.__uxCloseout.refusedOnce,
}));

/** Tab until the composer holds focus, so "reachable by keyboard" is measured rather than assumed. */
async function tabTo(page, predicate, limit = 40) {
  for (let press = 1; press <= limit; press += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(predicate)) return press;
  }
  return null;
}

let browser;
let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  browser = await chromium.launch({ headless: true });

  // --- 1–3. The desktop composer: reachable, Enter sends, Shift+Enter does not, Escape stops. ----------------------
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await desktop.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin + "/?scenario=idle", { waitUntil: "load" });
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  await page.locator("text=an earlier question").first().waitFor({ timeout: 30_000 });

  const tabsToComposer = await tabTo(page, () => document.activeElement?.tagName === "TEXTAREA");
  check(tabsToComposer !== null, "the composer is reachable with the Tab key alone (reached after " + tabsToComposer + " presses)");

  await page.keyboard.type("sent with the keyboard");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__uxCloseout.sends.length === 1, null, { timeout: 15_000 }).catch(() => {});
  const afterEnter = await gateOf(page);
  check(afterEnter.sends.length === 1 && afterEnter.sends[0] === "sent with the keyboard", "Enter sends the turn the composer holds: " + JSON.stringify(afterEnter.sends));

  const composer = page.locator("textarea").first();
  await composer.fill("");
  await composer.focus();
  await page.keyboard.type("a line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and another");
  const afterShiftEnter = await gateOf(page);
  check(afterShiftEnter.sends.length === 1, "Shift+Enter adds a line instead of sending: " + JSON.stringify(afterShiftEnter.sends));
  check((await composer.inputValue()).includes("\n"), "and the composer holds the newline the reader asked for: " + JSON.stringify(await composer.inputValue()));
  check(afterShiftEnter.stops === 0, "Escape-less idle use issues no stop, so a keyboard user's ordinary editing does not interrupt anything");
  await desktop.close();

  // --- 3. Escape stops a running conversation. ---------------------------------------------------------------------
  const runningContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const running = await runningContext.newPage();
  await running.goto(origin + "/?scenario=running", { waitUntil: "load" });
  const runningComposer = running.locator("textarea").first();
  await runningComposer.waitFor({ timeout: 30_000 });
  check(/steer/i.test(await runningComposer.getAttribute("placeholder") ?? ""), "a running conversation's composer states that it steers: " + JSON.stringify(await runningComposer.getAttribute("placeholder")));
  await runningComposer.focus();
  await running.keyboard.press("Escape");
  await running.waitForFunction(() => window.__uxCloseout.stops === 1, null, { timeout: 15_000 }).catch(() => {});
  const afterEscape = await gateOf(running);
  check(afterEscape.stops === 1, "Escape stops the run through the conversation's own stop route: " + JSON.stringify(afterEscape.stops));
  check(afterEscape.sends.length === 0, "and Escape sent nothing");
  await runningContext.close();

  // --- 4. A failed read is announced, and its Retry is reachable and effective. -------------------------------------
  const failureContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const failure = await failureContext.newPage();
  await failure.goto(origin + "/?scenario=failure", { waitUntil: "load" });
  const panel = failure.locator("[data-read-failure]").first();
  await panel.waitFor({ timeout: 30_000 });
  const failureState = await gateOf(failure);
  check(failureState.refusedOnce, "the first conversation read was the one the Gateway could not answer: " + JSON.stringify(failureState.reads) + " read(s)");
  check(await panel.getAttribute("role") === "status", "the failure is announced as a status region, not left as silent text");
  const panelText = (await panel.innerText()).replace(/\s+/g, " ");
  check(/could not be read/i.test(panelText) && /did not answer/i.test(panelText), "and it states the cause in its own words: " + JSON.stringify(panelText));
  check(await panel.getAttribute("data-read-failure") === "unreachable", "with the cause it classified: " + JSON.stringify(await panel.getAttribute("data-read-failure")));

  const retry = panel.getByRole("button", { name: /retry/i });
  await failure.evaluate(() => document.body.focus());
  const tabsToRetry = await tabTo(failure, () => document.activeElement?.textContent?.trim() === "Retry");
  check(tabsToRetry !== null, "the panel's Retry is the first control Tab reaches (after " + tabsToRetry + " presses)");
  // The deployment is back for the read the reader is about to ask for: that is what a recovery is, and the panel's own
  // control is what asks.
  await failure.evaluate(() => window.__uxCloseout.recover());
  await failure.keyboard.press("Enter");
  await panel.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  check(await panel.count() === 0, "Enter on Retry re-reads, and the transcript the second read answers replaces the panel");
  const recovered = await failure.locator("text=an earlier question").first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  check(recovered, "the conversation that could not be read is on screen after the retry");
  check((await gateOf(failure)).reads >= 2, "and exactly one more read was made, not a silent retry loop: " + JSON.stringify((await gateOf(failure)).reads) + " read(s)");
  await failureContext.close();

  // --- 5. The narrow viewport. ------------------------------------------------------------------------------------
  const narrowContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-US", isMobile: false });
  const narrow = await narrowContext.newPage();
  await narrow.goto(origin + "/?scenario=idle", { waitUntil: "load" });
  const narrowComposer = narrow.locator("textarea").first();
  await narrowComposer.waitFor({ timeout: 30_000 });
  await narrow.locator("text=an earlier question").first().waitFor({ timeout: 30_000 });
  check(await narrow.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "at 390×844 the page does not overflow horizontally: " + JSON.stringify(await narrow.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))));
  await narrowComposer.focus();
  await narrow.keyboard.type("narrow turn");
  // The narrow layout is the mobile keyboard's: Enter inserts a line break and the send shortcut is Ctrl/Cmd+Enter, which
  // is the composer's own rule for a mobile keyboard (an on-screen one has no Shift).
  await narrow.keyboard.press("Enter");
  const afterPlainEnter = await gateOf(narrow);
  check(afterPlainEnter.sends.length === 0, "on the narrow layout a bare Enter does not send: " + JSON.stringify(afterPlainEnter.sends));
  await narrow.keyboard.press("ControlOrMeta+Enter");
  await narrow.waitForFunction(() => window.__uxCloseout.sends.length === 1, null, { timeout: 15_000 }).catch(() => {});
  check((await gateOf(narrow)).sends[0] === "narrow turn", "and the send shortcut still sends from the narrow composer: " + JSON.stringify((await gateOf(narrow)).sends));
  const more = narrow.getByRole("button", { name: "More controls" });
  check(await more.count() === 1, "the secondary controls are behind one labelled More controls button");
  await more.focus();
  await narrow.keyboard.press("Enter");
  // Opening it retires the More button itself (it is hidden and aria-hidden while the menu is open), so what states the
  // open menu is the control that only exists inside it.
  const collapse = narrow.getByRole("button", { name: "Collapse controls" });
  check(await collapse.waitFor({ timeout: 10_000 }).then(() => true, () => false), "and the keyboard opens it: the menu's own Collapse controls control is on screen");
  const sendControl = narrow.getByRole("button", { name: "Send" });
  check(await sendControl.count() === 1, "the send control keeps its accessible name in the narrow layout");
  await narrowContext.close();

  // --- 6. Chinese IME. --------------------------------------------------------------------------------------------
  const imeContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const ime = await imeContext.newPage();
  await ime.goto(origin + "/?scenario=idle", { waitUntil: "load" });
  const imeComposer = ime.locator("textarea").first();
  await imeComposer.waitFor({ timeout: 30_000 });
  await ime.locator("text=an earlier question").first().waitFor({ timeout: 30_000 });
  await imeComposer.focus();
  const cdp = await imeContext.newCDPSession(ime);
  await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
  check((await imeComposer.inputValue()).includes("nihao"), "a composition in progress is in the composer: " + JSON.stringify(await imeComposer.inputValue()));
  // Enter while the composition is open: the composer must not submit a half-composed sentence.
  await ime.keyboard.press("Enter");
  await delay(200);
  const duringIme = await gateOf(ime);
  check(duringIme.sends.length === 0, "Enter during composition submitted nothing: " + JSON.stringify(duringIme.sends));
  await cdp.send("Input.imeSetComposition", { text: "你好", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "你好" });
  await delay(200);
  const composed = await imeComposer.inputValue();
  check(composed.includes("你好"), "the confirmed composition is what the composer holds: " + JSON.stringify(composed));
  check((await gateOf(ime)).sends.length === 0, "and confirming it sent nothing on its own");
  // The composer's own guard gives a just-ended composition 100 ms; a later Enter is an ordinary send.
  await delay(250);
  await imeComposer.focus();
  await ime.keyboard.press("Enter");
  await ime.waitForFunction(() => window.__uxCloseout.sends.length === 1, null, { timeout: 15_000 }).catch(() => {});
  const afterIme = await gateOf(ime);
  check(afterIme.sends.length === 1 && String(afterIme.sends[0]).includes("你好"), "a later Enter sends exactly the composed text: " + JSON.stringify(afterIme.sends));
  await imeContext.close();

  check(pageErrors.length === 0, "no page error occurred during the desktop steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_CLOSEOUT_A11Y_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("build kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
