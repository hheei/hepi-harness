/**
 * "Ask in new chat" from a quoted passage, driven in Chromium against the production shell.
 *
 * The journey: the reader selects a passage of an answer, asks a question about it in a new chat, the shell forks the
 * conversation and the question is sent there — once. The reader then visits another conversation and comes back, and
 * the question is not sent again.
 *
 * The second half is the reason this scene exists. A fresh chat is handed the quoted prompt as a one-shot
 * `initialPrompt` and reports back when it has consumed it; a report that answers without being called leaves the
 * prompt standing, so a remount of the same conversation sends the reader's question a second time. Both are ordinary
 * moves — following a quote, and stepping away from a conversation and returning to it — so the count of admissions is
 * what the scene asserts.
 *
 * What is real: the production `AppShell`, the selection, the composer, the quote popover and the fork it performs. What
 * is stated by the page: the Backend's routes, answered from a fixture, because the question is which requests this
 * surface makes and how many times — not what a Backend returns.
 *
 * Usage: node apps/web/e2e/chat/ux-quote-initial-prompt.ts [--keep]
 *        HEPI_QUOTE_INITIAL_PROMPT_PORT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_QUOTE_INITIAL_PROMPT_PORT ?? 43180);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-quote-initial-prompt-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-quote-initial-prompt.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  // The shipped Web build is Vite's, which compiles a `process.env.X` read to a property read off an object literal, so
  // the page never names `process`. A bare esbuild bundle does not, so the fixture states the same shape by hand.
  define: {
    "process.env.NODE_ENV": "\"production\"",
    "process.env.NEXT_PUBLIC_APP_VERSION": "undefined",
    "process.env.NEXT_PUBLIC_PI_VERSION": "undefined",
  },
  logLevel: "warning",
  loader: { ".css": "css" },
});
// The two rules the shell needs to be laid out at a desktop viewport: the phone drawer's backdrop, which the product
// hides by media query, and the sidebar's own container. The scene ships no compiled Tailwind.
await writeFile(join(buildDir, "ux-quote-initial-prompt.fixture.page.css"), [
  ".sidebar-overlay-backdrop { display: none !important; }",
  ".sidebar-container { position: relative; overflow: hidden; display: flex; flex-direction: column; }",
  "html, body, #root { height: 100%; margin: 0; }",
  "body { font: 14px/1.4 system-ui, sans-serif; }",
].join("\n"));
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>quote in new chat</title>",
  "<link rel=\"stylesheet\" href=\"./ux-quote-initial-prompt.fixture.page.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-quote-initial-prompt.fixture.js\"></script>",
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
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

const COMPOSER = "textarea[placeholder*=\"Message\"]";
const PASSAGE = "A passage worth asking about.";
const QUESTION = "What does this passage mean?";
const FORK = "forked";

/** Every message admission this page made, as the text the composer sent. */
const admissions = (page: Page) => page.evaluate(() => window.__quoteFixture?.admissions ?? []);
const forks = (page: Page) => page.evaluate(() => window.__quoteFixture?.forks ?? []);

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/?session=source", { waitUntil: "domcontentloaded" });
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    await page.locator("[data-message-role=\"assistant\"][data-entry-id=\"e2\"]").waitFor({ timeout: 30000 });

    // --- 1. The reader selects a passage of the answer, and the quote affordance appears. -------------------------
    // A real selection in the document, then the pointer-up the surface listens for: the same two steps a person's
    // drag makes, without depending on where a glyph happens to sit.
    const offered = await page.evaluate((passage) => {
      const entry = document.querySelector("[data-message-role=\"assistant\"][data-entry-id=\"e2\"]");
      if (entry === null) return "no entry";
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const at = text.indexOf(passage);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + passage.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        // The content container is the surface's own listener; a bubbling pointer-up is what a drag ends with.
        entry.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        return "selected";
      }
      return "passage not found";
    }, PASSAGE);
    check(offered === "selected", "the reader's selection of the passage is offered a quote: " + offered);
    const askInNewChat = page.getByRole("button", { name: "Ask in new chat" });
    await askInNewChat.waitFor({ timeout: 20000 });
    check(true, "the selection offers \"Ask in new chat\"");

    // --- 2. Asking in a new chat forks the conversation and sends the question there, once. ----------------------
    await askInNewChat.click();
    const quoteBox = page.getByRole("dialog", { name: "New chat about selected text" });
    await quoteBox.waitFor({ timeout: 20000 });
    const quoteText = quoteBox.locator("textarea");
    await quoteText.waitFor({ timeout: 20000 });
    check((await quoteText.inputValue()).includes(PASSAGE),
      "the new chat's own box already carries the passage as a quote: " + JSON.stringify((await quoteText.inputValue()).slice(0, 80)));
    await quoteText.fill("About this passage:\n\n> " + PASSAGE + "\n\n" + QUESTION);
    await quoteText.press("Enter");
    // The fork is the Backend's own route, and the shell adopts the conversation it answered with.
    await page.waitForFunction(() => (window.__quoteFixture?.forks ?? []).length > 0, undefined, { timeout: 20000 });
    check((await forks(page)).length === 1, "asking in a new chat forked the conversation once: " + JSON.stringify(await forks(page)));
    await page.waitForFunction(() => new URLSearchParams(window.location.search).get("session") === "forked", undefined, { timeout: 20000 });
    check(true, "and the surface is the fork the Backend answered with");
    const admitted = await page.waitForFunction(() => (window.__quoteFixture?.admissions ?? []).length > 0, undefined, { timeout: 20000 }).then(() => true, () => false);
    if (!admitted) {
      const seen = await page.evaluate(() => (window.__quoteFixture?.requests ?? []).map((request) => request.method + " " + request.path));
      console.log("  note  requests this page made: " + JSON.stringify(seen.slice(-12)));
      console.log("  note  the document showed: " + JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 400)));
    }
    const first = await admissions(page);
    check(first.length === 1 && first[0].includes(QUESTION),
      "the question was sent in the fork, once: " + JSON.stringify(first.map((text) => text.slice(0, 60))));

    // --- 3. The reader steps away and comes back; nothing is sent again. -----------------------------------------
    // The fork is in the sidebar beside the conversations it was made from, and both are ordinary rows.
    const collapsed = page.locator(".session-tree-group-toggle[aria-expanded='false']");
    for (let index = 0; index < await collapsed.count(); index += 1) await collapsed.nth(index).click();
    const sourceRow = page.locator("[data-row-key='session:group:source']").first();
    const rowAppeared = await sourceRow.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!rowAppeared) {
      const keys = await page.evaluate(() => [...document.querySelectorAll("[data-row-key]")].map((node) => node.getAttribute("data-row-key")));
      const shown = (await page.evaluate(() => document.body.innerText)).slice(0, 300);
      check(false, "the sidebar never listed the conversation the quote came from: " + JSON.stringify(keys) + " / showed " + JSON.stringify(shown));
      throw new Error("no source row");
    }
    // The row's own button is what a pointer lands on, and it is what a click addresses.
    const sourceBox = await sourceRow.boundingBox();
    console.log("  note  the source row is at " + JSON.stringify(sourceBox));
    await sourceRow.locator("button.session-tree-main").first().click();
    const backToSource = await page.waitForFunction(() => new URLSearchParams(window.location.search).get("session") === "source", undefined, { timeout: 20000 }).then(() => true, () => false);
    check(backToSource, "the reader returned to the conversation the quote came from: " + page.url());
    // The fork is a row of the same folder, so its group has to be open again after the move.
    const closedAgain = page.locator(".session-tree-group-toggle[aria-expanded='false']");
    for (let index = 0; index < await closedAgain.count(); index += 1) await closedAgain.nth(index).click();
    const forkRow = page.locator("[data-row-key='session:group:" + FORK + "']").first();
    const forkAppeared = await forkRow.waitFor({ timeout: 20000 }).then(() => true, () => false);
    if (!forkAppeared) {
      const keys = await page.evaluate(() => [...document.querySelectorAll("[data-row-key]")].map((node) => node.getAttribute("data-row-key")));
      check(false, "the sidebar never listed the fork the shell just adopted: " + JSON.stringify(keys));
      throw new Error("no fork row");
    }
    await forkRow.locator("button.session-tree-main").first().click();
    const backToFork = await page.waitForFunction(() => new URLSearchParams(window.location.search).get("session") === "forked", undefined, { timeout: 20000 }).then(() => true, () => false);
    check(backToFork, "and the reader came back to the fork: " + page.url());
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    // A remount of the fork is exactly the state that used to re-send the prompt; give it the same settling time a
    // person's next keystroke would.
    await page.waitForTimeout(1500);
    const afterReturn = await admissions(page);
    check(afterReturn.length === 1,
      "coming back to the fork sends nothing again: " + JSON.stringify(afterReturn.map((text) => text.slice(0, 60))));
    check((await forks(page)).length === 1, "and nothing forked a second time");
    check(pageErrors.length === 0, "no page error occurred across the journey" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));

    await browser.close();
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_QUOTE_INITIAL_PROMPT_PORT"
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
