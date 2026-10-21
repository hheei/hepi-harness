/**
 * Browser driver for the composer's interaction ticket: IME, undo/redo, completions, attachments, and drafts that move.
 *
 * The behaviours here cannot be stated without a browser. An IME sends no keydown the DOM-less composer code can see, a
 * native undo stack belongs to the textarea rather than to React, and a draft that survives a move is a fact about the
 * connection's store and the component that reads it. So the driver bundles the production `ChatInput` with the
 * workspace's own esbuild, serves it from a temporary directory, and drives it with the installed Playwright — real
 * keys, real composition events, real paste, real clipboard files.
 *
 * What is asserted is what a person would observe: the text on screen, the caret, the send the surface dispatched, and
 * the draft a reload restores. Nothing reaches into component state.
 *
 * Usage: node apps/web/e2e/chat/ux-composer-interaction.ts [--keep]
 *        HEPI_COMPOSER_PORT / COMPOSER_ARTIFACT_DIR override the port and artifact directory.
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_COMPOSER_PORT ?? 43117);
const artifactDir = process.env.COMPOSER_ARTIFACT_DIR ?? "/tmp/hepi-composer-artifacts";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message: string) { console.log("  ..  " + message); }

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const buildDir = await mkdtemp(join(tmpdir(), "hepi-composer-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-composer-interaction.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>composer</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-composer-interaction.fixture.js\"></script>",
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

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  await mkdir(artifactDir, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 620 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    const textarea = page.locator("textarea");
    await textarea.waitFor({ state: "visible", timeout: 15000 });

    const value = () => textarea.inputValue();
    const sends = () => page.evaluate(() => window.__composer?.sends ?? []);
    const queued = () => page.evaluate(() => window.__composer?.queued ?? []);
    const caret = () => page.evaluate(() => {
      const element = document.querySelector("textarea");
      return element === null ? null : [element.selectionStart, element.selectionEnd];
    });

    console.log("== typing and the plain send");
    await textarea.click();
    await page.keyboard.type("first draft");
    check(await value() === "first draft", "typed text is the live value");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__composer?.sends.length ?? 0) === 1, undefined, { timeout: 15000 });
    check(JSON.stringify(await sends()) === JSON.stringify([{ text: "first draft", images: 0 }]), "Enter sent the draft once");
    check(await value() === "", "the sent draft left the composer");

    console.log("== Shift+Enter is a newline, and nothing is sent");
    await textarea.click();
    await page.keyboard.type("line one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line two");
    check(await value() === "line one\nline two", "Shift+Enter inserted the newline in place");
    check((await sends()).length === 1, "a newline never sends");

    console.log("== IME composition does not send, and the Enter that confirms it is swallowed");
    await textarea.press("Control+A");
    await page.keyboard.press("Backspace");
    // A composition is dispatched from the page, because a headless browser has no IME: the events are the ones an IME
    // really produces, in the order it produces them.
    await textarea.evaluate((element) => {
      const area = element as HTMLTextAreaElement;
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      area.value = "こんにちは";
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await textarea.press("Enter");
    // A real IME consumes this Enter itself; a synthetic composition cannot, so what is asserted is that the composer
    // neither sent the text nor added a line break of its own.
    check((await value()).startsWith("こんにちは"), "Enter during a composition reaches the IME, not the composer");
    check((await sends()).length === 1, "no send happened during the composition");
    await textarea.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "こんにちは" }));
    });
    await textarea.press("Enter");
    check((await sends()).length === 1, "the Enter that confirms a composition is not a send");
    await page.waitForTimeout(200);
    await textarea.press("Enter");
    await page.waitForFunction(() => (window.__composer?.sends.length ?? 0) === 2, undefined, { timeout: 15000 });
    check(JSON.stringify((await sends())[1]) === JSON.stringify({ text: "こんにちは", images: 0 }), "a later Enter sends the composed text");

    console.log("== undo and redo of a completed @ mention stay native");
    await textarea.click();
    await page.keyboard.type("see @REA");
    await page.locator("button", { hasText: "README.md" }).first().waitFor({ state: "visible", timeout: 15000 });
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("README.md"), undefined, { timeout: 15000 });
    const completed = await value();
    check(completed.includes("README.md"), "Tab completed the mention into the draft: " + JSON.stringify(completed));
    // A native replacement leaves the whole edit on the textarea's own undo stack: one undo returns to the typed token.
    await page.keyboard.press("Control+Z");
    await page.waitForTimeout(150);
    const undone = await value();
    check(undone !== completed, "undo reverted the completion (" + JSON.stringify(undone) + ")");
    await page.keyboard.press("Control+Shift+Z");
    await page.waitForTimeout(150);
    check(await value() === completed, "redo restored the completion");

    console.log("== the slash palette completes, and its own Enter behaviour is kept");
    await textarea.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("/hel");
    await page.locator("button", { hasText: "/help" }).first().waitFor({ state: "visible", timeout: 15000 });
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector("textarea")?.value.startsWith("/help "), undefined, { timeout: 15000 });
    check((await value()).startsWith("/help "), "Tab completed the command and left a space for its arguments");
    check((await sends()).length === 2, "completing a command sends nothing");

    console.log("== a queued steer and follow-up while a turn streams");
    await page.locator("[data-fixture-stream]").click();
    await textarea.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("steer this");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__composer?.queued.length ?? 0) === 1, undefined, { timeout: 15000 });
    await textarea.click();
    await page.keyboard.type("then follow up");
    await page.keyboard.press("Alt+Enter");
    await page.waitForFunction(() => (window.__composer?.queued.length ?? 0) === 2, undefined, { timeout: 15000 });
    check(
      JSON.stringify(await queued()) === JSON.stringify([
        { mode: "steer", text: "steer this" },
        { mode: "followUp", text: "then follow up" },
      ]),
      "Enter steered and Alt+Enter followed up, each with its own text",
    );
    check((await sends()).length === 2, "nothing was sent while the turn streamed");
    await page.locator("[data-fixture-stream]").click();

    console.log("== a pasted picture is attached, and it travels with the send");
    await textarea.press("Control+A");
    await page.keyboard.press("Backspace");
    await textarea.evaluate(async (element) => {
      // A real clipboard payload: the composer reads clipboardData.items, so the item list is the browser's own shape.
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const file = new File([bytes], "pixel.png", { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll("img").length > 0, undefined, { timeout: 15000 });
    check(true, "the pasted picture is previewed in the composer");
    await page.keyboard.type("with a picture");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (window.__composer?.sends.length ?? 0) === 3, undefined, { timeout: 15000 });
    const withImage = (await sends())[2];
    check(withImage.text === "with a picture" && withImage.images === 1, "the send carried the text and the picture: " + JSON.stringify(withImage));

    console.log("== a draft survives a reload, and a promotion carries it to the new key");
    await textarea.click();
    await page.keyboard.type("unsent words");
    await page.waitForFunction(() => window.sessionStorage.length > 0, undefined, { timeout: 15000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await textarea.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "unsent words", undefined, { timeout: 15000 });
    check(await value() === "unsent words", "the tab's own draft came back after the reload");

    await page.locator("[data-fixture-rekey]").click();
    await page.waitForTimeout(100);
    check(await value() === "unsent words", "a promotion rekeys the draft without losing its text");
    await page.reload({ waitUntil: "domcontentloaded" });
    await textarea.waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "unsent words", undefined, { timeout: 15000 });
    check(await value() === "unsent words", "the promoted key's draft is what the reload reads");

    console.log("== moving to another key parks this draft and adopts the destination's");
    await textarea.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type("for this conversation");
    await page.locator("[data-fixture-move]").click();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "", undefined, { timeout: 15000 });
    check(await value() === "", "the destination composer starts from its own draft, not this one's text");
    await textarea.click();
    await page.keyboard.type("destination text");
    await page.locator("[data-fixture-rekey]").click();
    await page.waitForTimeout(150);
    check((await page.evaluate(() => window.__composer?.draftKeys ?? [])).length > 0, "the fixture tracked the key changes");

    await page.screenshot({ path: join(artifactDir, "composer.png") });
    note("screenshot " + join(artifactDir, "composer.png"));
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_COMPOSER_PORT"
    : (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nCOMPOSER INTERACTION CHECKS PASSED" : "\nCOMPOSER FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
