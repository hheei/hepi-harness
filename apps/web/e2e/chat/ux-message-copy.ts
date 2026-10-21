/**
 * Browser regression for the prompt copy seam: a copy of a prompt whose text arrived as a deferred preview writes the
 * **whole** text to the clipboard — on the first copy, on a copy repeated after the preview was replaced, and after the
 * reader expanded the block by hand.
 *
 * It bundles `ux-message-copy.fixture.tsx` with the workspace's own esbuild, serves it from a temporary directory outside
 * the repository, and drives it in headless Chromium. The fixture mounts the production `MessageView` under a real
 * `createClient`, so the read goes through the connection's own reader and the clipboard is the browser's own
 * `writeText`. Every action is an ordinary click on the surface a reader uses; nothing reaches into a component's state.
 *
 * The failure this pins: a prompt holding a deferred block reported its text from the frame's preview whenever no block
 * was still unread. The first copy resolved the block, so the second copy — and a copy after an expand — wrote the
 * truncated preview while the bubble showed the whole text.
 *
 * Usage: node apps/web/e2e/chat/ux-message-copy.ts [--keep]
 *        HEPI_UX_COPY_PORT=<port>
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COPIED_TEXT, WHOLE_TEXT } from "./ux-message-copy-prompt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX_COPY_PORT ?? 43106);

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
};

const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux-copy-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-message-copy.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>prompt copy</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-message-copy.fixture.js\"></script>",
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
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.locator("#prompt [data-deferred-text]").waitFor({ state: "visible", timeout: 15000 });

    const copies = () => page.evaluate(() => window.copies.slice());
    const reads = () => page.evaluate(() => window.reads.slice());
    // The prompt's actions appear on hover, as they do for a reader: the row is what a pointer reaches first.
    const copy = async () => {
      await page.locator("#prompt").hover();
      await page.locator("#prompt [data-copy-state]").click();
    };
    const expandButton = page.locator("#prompt [data-deferred-text] button");
    const expectCopy = async (label: string, count: number) => {
      await page.waitForFunction((n) => window.copies.length === n, count, { timeout: 15000 });
      const written = await copies();
      check(
        written.at(-1) === COPIED_TEXT,
        label + " writes the whole prompt, not the preview " + JSON.stringify(written.at(-1)),
      );
    };

    console.log("== the preview is what the surface starts with, and nothing is read before an action");
    check(await page.locator("#prompt [data-deferred-state]").getAttribute("data-deferred-state") === "preview", "the block starts as a bounded preview");
    check((await reads()).length === 0, "mount reads no read block");
    const bubble = await page.locator("#prompt").innerText();
    check(bubble.includes("the whole prompt…") && !bubble.includes(WHOLE_TEXT), "the bubble shows the preview the frame carried");

    console.log("== a copy reads the block through the connection and writes the original");
    await copy();
    await expectCopy("the first copy", 1);
    check((await reads()).length === 1, "the copy is one read of the block the prompt named " + JSON.stringify(await reads()));
    check((await page.locator("#prompt [data-copy-state]").getAttribute("data-copy-state")) === "copied", "the surface reports the copy");

    console.log("== a repeated copy still writes the original");
    // The block is resolved now, so the surface's own state is what the second copy must read from.
    await page.waitForFunction(() => document.querySelector("#prompt [data-copy-state]")?.getAttribute("data-copy-state") === "idle", undefined, { timeout: 5000 });
    await copy();
    await expectCopy("a second copy", 2);
    check((await reads()).length === 1, "the reader's own cache answered, so the block was not read twice " + JSON.stringify(await reads()));

    console.log("== a copy after the reader expanded the block writes what the bubble now shows");
    await page.waitForFunction(() => document.querySelector("#prompt [data-copy-state]")?.getAttribute("data-copy-state") === "idle", undefined, { timeout: 5000 });
    await expandButton.click();
    await page.locator("#prompt [data-deferred-state=\"expanded\"]").waitFor({ state: "visible", timeout: 15000 });
    const expandedText = await page.locator("#prompt pre").textContent();
    check(expandedText === WHOLE_TEXT, "the expanded block shows the whole text " + JSON.stringify(expandedText));
    await copy();
    await expectCopy("a copy after expanding", 3);

    console.log("== the message the copy wrote is the one on screen, in order");
    check((await copies()).every((text) => text === COPIED_TEXT), "every copy wrote the same whole prompt");
    note("reads " + JSON.stringify(await reads()));
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX_COPY_PORT"
    : (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nMESSAGE COPY BROWSER CHECKS PASSED" : "\nMESSAGE COPY FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
