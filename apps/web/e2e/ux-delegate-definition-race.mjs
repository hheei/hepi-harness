/**
 * Browser regression for ticket 12's review: the quick delegate's definition selector follows the folder the
 * conversation is on.
 *
 * The panel reads the definitions of the conversation's execution workspace. When the conversation moves to another
 * folder, the previous read may still be in flight, and its answer — or the connection's own `disposed` refusal, which
 * is what a retired target states — arrives afterwards. A panel that publishes it shows an error instead of the second
 * folder's definitions, and the selector the user needs disappears.
 *
 * The fixture mounts the production panel in StrictMode with only its network boundary replaced, holds the first
 * folder's read, moves the conversation to the second folder, waits for that folder's definitions, and then releases
 * the first. Everything the assertions read is rendered DOM.
 *
 * Usage: node apps/web/e2e/ux-delegate-definition-race.mjs [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX13_PORT ?? 43113);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux13-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-delegate-definition-race.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-13</title>",
  "<link rel=\"stylesheet\" href=\"./ux-skills-inventory-race.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-delegate-definition-race.fixture.js\"></script>",
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
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    // The first folder's read is held, so nothing is offered yet.
    await page.waitForFunction(() => window.__ux13.alphaHeld === true, undefined, { timeout: 15000 });

    // The conversation moves to the second folder, whose definitions answer at once.
    await page.evaluate(() => { window.__ux13.switchToBeta(); });
    await page.locator("[data-delegate-definition]").waitFor({ timeout: 15000 });
    const offered = await page.locator("[data-delegate-definition] option").allInnerTexts();
    check(offered.length === 1 && offered[0].includes("beta-agent"), "the selector lists the folder the conversation is on: " + JSON.stringify(offered));

    // The previous folder's read now answers for a target the panel has left. It must change nothing.
    await page.evaluate(() => { window.__ux13.releaseAlpha(); });
    await page.waitForTimeout(300);
    check(await page.locator("[data-delegate-error]").count() === 0, "the previous folder's answer reported no failure for the folder on screen");
    check(await page.locator("[data-delegate-definition]").count() === 1, "the selector is still offered");
    const after = await page.locator("[data-delegate-definition] option").allInnerTexts();
    check(after.length === 1 && after[0].includes("beta-agent"), "the previous folder's definitions did not replace the folder on screen: " + JSON.stringify(after));
    check(await page.getByText("Loading definitions...").count() === 0, "the previous answer did not put the panel back into its loading state");
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX13_PORT"
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
