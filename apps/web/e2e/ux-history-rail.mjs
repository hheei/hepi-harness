/**
 * Browser acceptance for history-navigation ticket 04: the right-side rail is the conversation's full committed user
 * history, not only the turns the transcript happens to carry.
 *
 * It bundles apps/web/e2e/ux-history-rail.fixture.tsx with the workspace's own esbuild and mounts the production
 * `ChatMinimap` against a fixed layout: a twelve-anchor outline whose first page states six, and a transcript that
 * carries only the last three turns. The driver reads rendered DOM attributes, scroll positions and real input events
 * only; every wait is an observable DOM condition rather than a fixed sleep.
 *
 * What it proves, and why each is a browser check rather than a unit one:
 *
 *  - nodes beyond the loaded window are listed, in the server's order, with a bounded preview;
 *  - an unloaded node's dot carries no visibility claim, because the rail knows its order and not its height;
 *  - clicking an unloaded node hands over exactly **one** coordinate and issues no page request at all — the shape of
 *    the sequential hydration this ticket removes;
 *  - a loaded node's local measured jump still works, unchanged;
 *  - the outline's "more" is one read per activation, and a failed page is named rather than ending the list silently.
 *
 * The fixture server binds 127.0.0.1:43104 (override with HEPI_RAIL_PORT) and builds into a temporary directory outside
 * the repository, so no production output or running service is touched.
 *
 * Usage: node apps/web/e2e/ux-history-rail.mjs [--keep]
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_RAIL_PORT ?? 43104);

const ANCHOR_COUNT = 12;
const FIRST_PAGE = 6;
const FIRST_LOADED = 9;

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message) { console.log("  ..  " + message); }

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const buildDir = await mkdtemp(join(tmpdir(), "hepi-rail-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-history-rail.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>history-rail</title>",
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

    const nodes = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-minimap-node-index]")).map((element) => ({
      index: Number(element.getAttribute("data-minimap-node-index")),
      entryId: element.getAttribute("data-minimap-node-entry"),
      loaded: element.hasAttribute("data-minimap-node-loaded"),
      visible: element.hasAttribute("data-minimap-node-visible"),
    })));
    const jumps = () => page.evaluate(() => window.__rail.jumps());
    const outlineRequests = () => page.evaluate(() => window.__rail.outlineRequests());
    const scrollTop = () => page.evaluate(() => document.querySelector("[data-fixture-scroll]").scrollTop);
    const openPreview = async () => {
      const box = await page.locator("[data-minimap-node-index]").first().locator("..").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.locator("[data-minimap-preview-user]").first().waitFor({ state: "visible", timeout: 15000 });
    };

    await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible", timeout: 15000 });
    // The measurement that gives the loaded nodes their geometry runs on the rail's own throttle, so the state the
    // checks below describe is awaited rather than assumed.
    await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-loaded]").length > 0, undefined, { timeout: 15000 });

    console.log("== the rail lists the conversation's committed anchors, loaded or not");
    const listed = await nodes();
    note("nodes " + JSON.stringify(listed));
    // The page's own anchors, plus the measured tail newer than the newest anchor it listed: the reader's window sits at
    // the end of the conversation, and a turn committed after the last page was read is newer than that page. Those are
    // real nodes with measured geometry, not a second index, so the rail's bottom edge keeps up with the transcript.
    const tail = ANCHOR_COUNT - FIRST_LOADED;
    check(
      listed.length === FIRST_PAGE + tail,
      "the rail lists the first page and the measured tail past it (" + listed.length + " nodes, expected " + (FIRST_PAGE + tail) + ")",
    );
    check(
      JSON.stringify(listed.map((node) => node.entryId)) === JSON.stringify(listed.map((node) => node.entryId).slice().sort()),
      "nodes are ordered by the server's cursor, oldest first",
    );
    const loadedIds = listed.filter((node) => node.loaded).map((node) => node.entryId);
    check(loadedIds.length === tail, "only the turns the transcript carries are marked loaded (" + loadedIds.length + ")");
    check(
      listed.filter((node) => !node.loaded).every((node) => !node.visible),
      "an unloaded node never claims to be visible, because the rail has no geometry for it",
    );
    check(
      listed.filter((node) => !node.loaded).length === FIRST_PAGE,
      "every anchor the transcript does not carry is still listed, which is the whole point of the page",
    );

    console.log("== an unloaded node's preview is the server's bounded text");
    await openPreview();
    const previewText = await page.evaluate(() => {
      const row = document.querySelector('[data-minimap-preview-index="0"] [data-minimap-preview-user]');
      return row === null ? null : row.innerText.trim();
    });
    check(previewText !== null && previewText.length > 0, "the unloaded node's preview renders its committed text: " + JSON.stringify(previewText));
    check(previewText.length <= 241, "and it is bounded rather than the whole message (" + previewText.length + " chars)");
    check(
      await page.locator('[data-minimap-preview-index="0"]').getAttribute("data-minimap-preview-loaded") === null,
      "the preview row of an unloaded node says so",
    );

    console.log("== clicking an unloaded node issues one coordinate and no page request");
    const beforeJumps = (await jumps()).length;
    const beforeRequests = await outlineRequests();
    await page.locator('[data-minimap-preview-user="0"]').click();
    await page.waitForFunction(() => window.__rail.jumps().length > 0, undefined, { timeout: 15000 });
    const handed = await jumps();
    check(handed.length === beforeJumps + 1, "one click handed over exactly one coordinate (" + (handed.length - beforeJumps) + ")");
    check(handed[0].anchor.startsWith("coord-"), "the coordinate is the one the outline issued: " + JSON.stringify(handed[0].anchor));
    check(
      await outlineRequests() === beforeRequests,
      "and it asked for no outline page: a jump is a target read, never a walk toward it (" + (await outlineRequests()) + " requests)",
    );
    // The fixture's surface mounts the target's turn and aligns it, which is what `landWindow` plus the settlement do.
    await page.waitForFunction((entryId) => {
      const scroll = document.querySelector("[data-fixture-scroll]");
      const element = document.querySelector('[data-fixture-entry="' + entryId + '"]');
      if (!scroll || !element) return false;
      const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      return top > -40 && top < scroll.clientHeight;
    }, handed[0].entryId, { timeout: 15000 });
    check(true, "the target's turn came on screen: " + handed[0].entryId);
    // The rail re-measures on its own throttle once the landed turn is in the transcript, so the state is awaited
    // rather than read on the frame the scroll finished.
    const becameLoaded = await page.waitForFunction((entryId) => {
      const element = document.querySelector('[data-minimap-node-entry="' + entryId + '"]');
      return element !== null && element.hasAttribute("data-minimap-node-loaded");
    }, handed[0].entryId, { timeout: 15000 }).then(() => true).catch(() => false);
    check(becameLoaded, "and the node the reader jumped to is now a loaded node of the rail");
    check(
      (await jumps()).length === 1,
      "the landing cost one request in total, with nothing issued for the nodes the viewport crossed (" + (await jumps()).length + ")",
    );

    console.log("== a loaded node's local measured jump still works");
    const loadedNode = (await nodes()).find((node) => node.loaded);
    await openPreview();
    await page.locator('[data-minimap-preview-index="' + loadedNode.index + '"] [data-minimap-preview-user]').click();
    await page.waitForFunction((entryId) => {
      const scroll = document.querySelector("[data-fixture-scroll]");
      const element = document.querySelector('[data-fixture-entry="' + entryId + '"]');
      if (!scroll || !element) return false;
      const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      return top > -40 && top < scroll.clientHeight;
    }, loadedNode.entryId, { timeout: 15000 });
    check(true, "clicking a loaded node scrolled to its measured turn: " + loadedNode.entryId);
    check(
      (await jumps()).length === handed.length,
      "and it issued no navigation request at all, because the turn was already measured",
    );

    console.log("== the outline's own more is one read per activation, and its failure is named");
    await openPreview();
    const requestsBefore = await outlineRequests();
    await page.locator("[data-minimap-outline-request]").click();
    await page.waitForFunction(() => window.__rail.outlineRequests() === 1, undefined, { timeout: 15000 });
    check(await outlineRequests() === requestsBefore + 1, "reaching for the rest of the history asked for exactly one page");
    // The fixture answers with the page that continues the outline; the rail lists it without a second read.
    await page.evaluate(() => window.__rail.answerOutline());
    await page.waitForFunction(
      (expected) => document.querySelectorAll("[data-minimap-node-index]").length === expected,
      ANCHOR_COUNT,
      { timeout: 15000 },
    );
    check((await nodes()).length === ANCHOR_COUNT, "the page that answered it is listed, to " + ANCHOR_COUNT + " nodes");
    check(await outlineRequests() === requestsBefore + 1, "and listing it cost no further read");
    const scrollBefore = await scrollTop();

    console.log("== a failed page is a named state, not the end of the list");
    await page.evaluate(() => window.__rail.answerOutline("stale-snapshot"));
    await page.locator("[data-minimap-outline-failure]").waitFor({ timeout: 15000 });
    const failure = await page.locator("[data-minimap-outline-failure]").getAttribute("data-minimap-outline-failure");
    check(failure === "stale-snapshot", "the failure is named where the reader is looking: " + JSON.stringify(failure));
    check(
      (await nodes()).length === ANCHOR_COUNT,
      "and the anchors the rail already held are still listed rather than dropped by the failure",
    );
    check(Math.abs((await scrollTop()) - scrollBefore) < 4, "the rail's own failure did not move the transcript");

    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_RAIL_PORT"
    : (error instanceof Error ? error.stack : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nHISTORY-RAIL BROWSER CHECKS PASSED" : "\nHISTORY-RAIL FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
