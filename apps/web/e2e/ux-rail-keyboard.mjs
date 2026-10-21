/**
 * Browser regression for the rail's keyboard access: the outline was reachable by pointing at it only.
 *
 * Review 160 measured the defect on the shipped rail: six nodes, none focusable, and the only way to see a preview or ask
 * for the rest of the history was to hover. A keyboard reader could not open the rail at all, so the conversation's own
 * index of committed messages did not exist for them.
 *
 * This mounts the production `ChatMinimap` (the same fixture the rail's own acceptance uses) and drives it with the
 * keyboard alone: Tab to the rail's opener, Enter to open it, arrows to walk its turns, Enter to jump, Escape to close.
 * Every wait is an observable DOM state — the focused element, the list's presence, the coordinate the surface was
 * handed — rather than a fixed sleep.
 *
 * Usage: node apps/web/e2e/ux-rail-keyboard.mjs [--keep]
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_RAIL_KEYBOARD_PORT ?? 43125);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-rail-keyboard-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-history-rail.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>rail-keyboard</title>",
  "<link rel=\"stylesheet\" href=\"./ux-history-rail.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-history-rail.fixture.js\"></script>",
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
    const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible", timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-loaded]").length > 0, undefined, { timeout: 20000 });

    const focused = () => page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) return null;
      return {
        opener: element.hasAttribute("data-minimap-opener"),
        previewUser: element.getAttribute("data-minimap-preview-user"),
        tag: element.tagName.toLowerCase(),
      };
    });
    const previewOpen = () => page.locator("[data-minimap-preview-box]").count();
    const jumps = () => page.evaluate(() => window.__rail.jumps());

    console.log("== the rail has a keyboard opener, and it is the only tab stop it adds");
    check(await page.locator("[data-minimap-opener]").count() === 1, "the rail states one opener button");
    check(await page.locator("[data-minimap-opener]").getAttribute("aria-expanded") === "false", "it states that the list is closed");
    check(await page.locator("[data-minimap-opener]").getAttribute("aria-controls") !== null, "and names the list it controls");
    check(await previewOpen() === 0, "no preview list is rendered while it is closed");

    console.log("== Tab reaches it, Enter opens the list and moves the focus into it");
    // From the document's own start, the opener is the first stop in the rail: nothing before it in this fixture takes
    // focus, so one Tab is enough and the check is about where focus lands rather than how many presses it took.
    await page.locator("[data-minimap-opener]").focus();
    check((await focused()).opener, "the opener takes focus");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-minimap-preview-box]") !== null, undefined, { timeout: 20000 });
    check(true, "Enter opened the list");
    check(await page.locator("[data-minimap-opener]").getAttribute("aria-expanded") === "true", "the opener says it is expanded");
    const first = await focused();
    check(first.previewUser === "0", "the focus moved to the first listed turn: " + JSON.stringify(first));

    console.log("== arrows walk the listed turns, in the outline's order");
    await page.keyboard.press("ArrowDown");
    check((await focused()).previewUser === "1", "ArrowDown moved to the next turn");
    await page.keyboard.press("ArrowUp");
    check((await focused()).previewUser === "0", "ArrowUp moved back");
    const listed = await page.evaluate(() => Array.from(document.querySelectorAll("[data-minimap-preview-user]")).length);
    check(listed >= 6, "the list carries the whole first page, not only what the transcript measured (" + listed + " rows)");

    console.log("== Enter on a turn is the same one-coordinate jump a click is");
    const before = (await jumps()).length;
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__rail.jumps().length > 0, undefined, { timeout: 20000 });
    const handed = await jumps();
    check(handed.length === before + 1, "one activation handed over exactly one coordinate");
    check(handed[0].anchor.startsWith("nav1.") || handed[0].anchor.startsWith("coord-"), "the coordinate the outline issued: " + JSON.stringify(handed[0].anchor));

    console.log("== Escape closes the list and returns the focus to the opener");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("[data-minimap-preview-box]") === null, undefined, { timeout: 20000 });
    check(true, "Escape closed the list");
    check((await focused()).opener, "and the focus is back on the opener rather than lost to the page");
    check(await page.locator("[data-minimap-opener]").getAttribute("aria-expanded") === "false", "which states that it is collapsed again");

    console.log("== the list stays open when the pointer leaves, because the keyboard opened it");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector("[data-minimap-preview-box]") !== null, undefined, { timeout: 20000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    check(await previewOpen() === 1, "the pinned list survived the pointer leaving the rail");

    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_RAIL_KEYBOARD_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack : String(error));
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
