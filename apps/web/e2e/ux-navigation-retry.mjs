/**
 * Browser regression for ticket 03's review (P1): a failed deep search hit keeps its request, so Retry can land it.
 *
 * The fixture mounts the production `ChatWindow` in `StrictMode` with only its network boundary replaced. The first
 * navigation read refuses the target; the reader presses the banner's Retry; the second read answers the entry's own
 * bounded window.
 *
 * Two things are asserted, and both were broken: the failure must not retire the shell's pending target (a failure is a
 * state the reader acts on, not the end of the request), and the landing the retry produces must still be aligned — the
 * entry reaches the DOM and the settlement scrolls to it, with the older-history sentinel staying silent throughout.
 *
 * Usage: node apps/web/e2e/ux-navigation-retry.mjs [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_NAV_RETRY_PORT ?? 43123);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-nav-retry-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-navigation-retry.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "css" },
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-nav-retry</title>",
  "<link rel=\"stylesheet\" href=\"./ux-navigation-retry.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-navigation-retry.fixture.js\"></script>",
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

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => console.log("  page: " + message.text()));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    // The first read is refused, and the reader is told so in the outcome's own words.
    await page.locator("[data-navigation-outcome=\"missing\"]").waitFor({ timeout: 20000 });
    check(true, "the failed locate is on screen as its own named state");
    check(await page.evaluate(() => window.__gate.reads) === 1, "one navigation read was issued, not a page walk");
    check(await page.evaluate(() => window.__gate.handled) === 0, "the failure did not retire the shell's pending target");

    // The reader takes the banner's own offer.
    await page.evaluate(() => window.__gate.retry());
    await page.waitForFunction(() => window.__gate.reads === 2, undefined, { timeout: 20000 });

    // The landing is aligned: the entry the retry landed is in the transcript and in the viewport, and the request is
    // retired only now, by the settlement that arrived.
    await page.waitForFunction(() => {
      const entry = document.querySelector('[data-entry-id="100"]');
      if (!entry) return false;
      const box = entry.getBoundingClientRect();
      const viewport = document.querySelector("[data-chat-scroll]")?.getBoundingClientRect();
      return viewport !== undefined && box.top < viewport.bottom && box.bottom > viewport.top;
    }, undefined, { timeout: 20000 });
    check(true, "the retry's landing is mounted and aligned in the viewport");
    // The request is retired by the *settlement*, which is what says the scroll arrived — not by the failure before it.
    await page.waitForFunction(() => window.__gate.handled === 1, undefined, { timeout: 20000 });
    check(true, "the request is retired by the landing, once");
    check(await page.evaluate(() => window.__gate.olderPages) === 0, "no older-history page was read during the settlement");
    check(await page.locator("[data-navigation-outcome]").count() === 0, "the failure banner is gone once the jump landed");
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_NAV_RETRY_PORT"
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
