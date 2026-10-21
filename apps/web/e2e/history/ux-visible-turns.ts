/**
 * Browser regression for UX ticket 02: the right-side navigation highlights
 * every turn that intersects the chat viewport, while click/keyboard navigation
 * keeps its own focus.
 *
 * It bundles apps/web/e2e/history/ux-visible-turns.fixture.tsx with the workspace's own
 * esbuild, mounts the production ChatMinimap against a fixed layout fixture
 * (short question headers + long separate answers) and reads only rendered DOM
 * attributes, scroll positions and real input events. Nothing here inspects
 * component internals, private state or source text; every wait is an
 * observable DOM condition rather than a fixed sleep.
 *
 * Fixed layout, 900x400 viewport: each turn is a 40px question header plus a
 * much taller answer (300px of turn box for the first three), and the last turn
 * also owns a growing streaming tail. The expected highlighted set for a scroll
 * position is computed here from the fixture's own rendered turn rectangles (an
 * independent oracle), so a header-only turn rectangle or an offscreen
 * highlight both fail.
 *
 * The fixture server binds 127.0.0.1:43102 (override with HEPI_UX02_PORT) and
 * builds into a temporary directory outside the repository, so no production
 * .next output or running service is touched.
 *
 * Usage: node apps/web/e2e/history/ux-visible-turns.ts [--keep]
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX02_PORT ?? 43102);
const TURN_COUNT = 4;
const COLLAPSED_ANSWER_HEIGHT = 40;

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message: string) { console.log("  ..  " + message); }

/** One turn as the fixture laid it out: its top inside the scroller, and its height. */
interface TurnSpan {
  readonly top: number;
  readonly height: number;
}

/** The scroller's own measurements, with every turn's span in the same coordinate. */
interface LayoutMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly turns: TurnSpan[];
}

/** Which rail claim is being awaited: the turns highlighting as visible, or the ones carrying the navigation focus. */
type RailClaim = "visible" | "focused";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux02-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-visible-turns.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-02</title>",
  "<link rel=\"stylesheet\" href=\"./ux-visible-turns.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-visible-turns.fixture.js\"></script>",
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
    const page = await browser.newPage({ viewport: { width: 900, height: 400 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    // The claim's name travels into the page as a plain string, which is what Playwright serializes the argument as.
    const readAttribute = (attribute: string) => {
      const nodes = Array.from(document.querySelectorAll("[data-minimap-node-index]"));
      return nodes
        .filter((element) => element.hasAttribute("data-minimap-node-" + attribute))
        .map((element) => Number(element.getAttribute("data-minimap-node-index")))
        .sort((a, b) => a - b);
    };
    const visible = async (): Promise<number[]> => await page.evaluate(readAttribute, "visible");
    const focused = async (): Promise<number[]> => await page.evaluate(readAttribute, "focused");
    const scrollTop = async () => await page.evaluate(() => {
      const scroll = document.querySelector("[data-fixture-scroll]");
      if (scroll === null) throw new Error("the fixture's scroller is not on the page");
      return scroll.scrollTop;
    });
    const metrics = async (): Promise<LayoutMetrics> => await page.evaluate(() => {
      const scroll = document.querySelector("[data-fixture-scroll]");
      if (!(scroll instanceof HTMLElement)) throw new Error("the fixture's scroller is not on the page");
      const turns = Array.from(document.querySelectorAll("[data-fixture-turn]")).map((turn) => ({
        top: turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
        height: turn.getBoundingClientRect().height,
      }));
      return { scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight, turns };
    });
    const setScroll = async (top: number) => await page.evaluate((value) => window.__ux02!.scrollTo(value), top);
    const setStreamHeight = async (height: number) => await page.evaluate((value) => window.__ux02!.setStreamHeight(value), height);
    const setAnswerHeight = async (index: number, height: number) => await page.evaluate(
      (value) => window.__ux02!.setAnswerHeight(value.index, value.height),
      { index, height },
    );
    const waitForSet = async (attribute: RailClaim, expected: number[], message: string) => {
      try {
        await page.waitForFunction(
          ({ attribute: name, values }) => {
            const actual = Array.from(document.querySelectorAll("[data-minimap-node-index]"))
              .filter((element) => element.hasAttribute("data-minimap-node-" + name))
              .map((element) => Number(element.getAttribute("data-minimap-node-index")))
              .sort((a, b) => a - b);
            return JSON.stringify(actual) === JSON.stringify(values);
          },
          { attribute, values: expected },
          { timeout: 15000 },
        );
        check(true, message + " -> " + JSON.stringify(expected));
      } catch {
        const [actualVisible, actualFocused] = [await visible(), await focused()];
        check(false, message + " -> expected " + JSON.stringify(expected)
          + ", visible " + JSON.stringify(actualVisible) + ", focused " + JSON.stringify(actualFocused));
      }
    };
    const waitForVisible = async (expected: number[], message: string) => await waitForSet("visible", expected, message);
    const waitForFocus = async (expected: number[], message: string) => await waitForSet("focused", expected, message);
    /** Turns intersecting the viewport, from the fixture's own rectangles. */
    const expectedVisible = async () => {
      const layout = await metrics();
      const viewportBottom = layout.scrollTop + layout.clientHeight;
      return layout.turns
        .map((turn, index) => ({ index, turn }))
        .filter(({ turn }) => turn.top < viewportBottom && turn.top + turn.height > layout.scrollTop)
        .map(({ index }) => index);
    };
    const goto = async (top: number, message: string) => {
      await setScroll(top);
      await waitForVisible(await expectedVisible(), message);
    };
    const turnHeights = async () => (await metrics()).turns.map((turn) => Math.round(turn.height));
    /** Waits until the fixture's own turn boxes settled into the given heights. */
    const waitForHeights = async (expected: number[]) => await page.waitForFunction(
      (values) => JSON.stringify(Array.from(document.querySelectorAll("[data-fixture-turn]"))
        .map((turn) => Math.round(turn.getBoundingClientRect().height))) === JSON.stringify(values),
      expected,
      { timeout: 15000 },
    );
    const openPreview = async () => {
      const box = await page.locator(".stage > div").last().boundingBox();
      if (box === null) throw new Error("the stage has no box to point at");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.locator("[data-minimap-preview-user]").first().waitFor({ state: "visible", timeout: 15000 });
    };

    await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible", timeout: 15000 });
    const layout = await metrics();
    note("turn spans " + JSON.stringify(layout.turns.map((turn) => turn.top))
      + " heights " + JSON.stringify(layout.turns.map((turn) => turn.height))
      + ", content " + layout.scrollHeight + "px, viewport " + layout.clientHeight + "px");
    check(layout.turns.length === TURN_COUNT, "the fixture renders " + TURN_COUNT + " turns");
    check(
      layout.turns.every((turn) => turn.height > 200),
      "every turn is far taller than its 40px question header, so header-only rectangles cannot pass",
    );
    check(layout.scrollHeight > layout.clientHeight * 2, "the content is long enough to scroll through several turns");

    console.log("== every viewport-intersecting turn highlights");
    await goto(0, "at the top only the intersecting turns highlight");
    // Turn 1's answer alone covers the viewport here: its header is above the top edge.
    await goto(300, "a turn whose header is scrolled offscreen still highlights from its answer");
    check((await visible()).includes(1), "the answer-only turn is among the highlighted turns");
    await goto(600, "a turn above the viewport is not highlighted");
    const clipped = await metrics();
    await goto(Math.round(clipped.turns[3].top - clipped.clientHeight / 2), "turns clipped at both edges all highlight");
    check((await visible()).length >= 2, "adjacent clipped turns are highlighted together");
    await goto(Math.round(clipped.turns[2].top + clipped.clientHeight - 10), "the bottom-most intersecting turn is highlighted");
    check(!(await visible()).includes(0), "a turn that left the viewport is no longer highlighted");

    console.log("== collapse/expand and streaming growth recompute the range");
    await goto(600, "before a layout change the intersecting turns are highlighted");
    const beforeCollapse = await visible();
    const expandedHeights = await turnHeights();
    await setAnswerHeight(2, COLLAPSED_ANSWER_HEIGHT);
    await waitForHeights(expandedHeights.map((height, index) => (index === 2 ? COLLAPSED_ANSWER_HEIGHT + 40 : height)));
    await waitForVisible(await expectedVisible(), "collapsing a turn recomputes which turns cover the viewport");
    const afterCollapse = await visible();
    check(
      JSON.stringify(beforeCollapse) !== JSON.stringify(afterCollapse),
      "the collapsed turn really changed the range (" + JSON.stringify(beforeCollapse) + " -> " + JSON.stringify(afterCollapse) + ")",
    );
    await setAnswerHeight(2, 260);
    await waitForHeights(expandedHeights);
    await waitForVisible(await expectedVisible(), "expanding it back restores the previous range");
    check(
      JSON.stringify(await visible()) === JSON.stringify(beforeCollapse),
      "the expanded range matches the pre-collapse range " + JSON.stringify(beforeCollapse),
    );

    console.log("== click and keyboard navigation keep their own focus");
    await openPreview();
    await page.locator('[data-minimap-preview-user="3"]').click();
    const clickTarget = await page.evaluate(() => {
      const scroll = document.querySelector("[data-fixture-scroll]");
      const turn = document.querySelector('[data-fixture-turn="3"]');
      if (!(scroll instanceof HTMLElement) || turn === null) throw new Error("the fixture's scroller or the third turn is not on the page");
      const top = turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      return Math.max(0, top - scroll.clientHeight * 0.3);
    });
    await page.waitForFunction(
      (target: number) => Math.abs((document.querySelector("[data-fixture-scroll]")?.scrollTop ?? 0) - target) < 4,
      clickTarget,
      { timeout: 15000 },
    );
    await waitForFocus([3], "the clicked turn becomes the navigation focus");
    await waitForVisible(await expectedVisible(), "the highlighted set still reflects the viewport, not the navigation focus");
    check((await visible()).includes(3), "the clicked turn is also the highlighted one it scrolled into view");

    await openPreview();
    await page.locator('[data-minimap-preview-user="0"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.querySelector("[data-fixture-scroll]")?.scrollTop ?? 0) < 40, undefined, { timeout: 15000 });
    check((await scrollTop()) < 40, "keyboard activation scrolls to the turn (" + Math.round(await scrollTop()) + ")");
    check((await focused())[0] === 0, "the first turn is the navigation focus");
    await waitForFocus([0], "keyboard activation moves the navigation focus");

    console.log("== a growing stream extends the last turn without stealing focus");
    const beforeGrowth = await metrics();
    await setStreamHeight(2400);
    await page.waitForFunction(
      (previous: number) => (document.querySelector("[data-fixture-scroll]")?.scrollHeight ?? 0) > previous + 2000,
      beforeGrowth.scrollHeight,
      { timeout: 15000 },
    );
    await page.evaluate(() => window.__ux02!.scrollToBottom());
    await goto(await scrollTop(), "after the streaming reply grows, the last turn covers the scrolled-to-bottom viewport");
    check((await visible()).includes(3), "the growing streaming reply keeps the last turn highlighted");
    check((await visible()).length === (await expectedVisible()).length, "only turns actually intersecting the viewport are highlighted");
    await waitForFocus([0], "the navigation focus stayed on the activated turn while the content grew");

    console.log("== resizing recomputes the range");
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForFunction(() => (document.querySelector("[data-fixture-scroll]")?.clientHeight ?? 0) > 800, undefined, { timeout: 15000 });
    await goto(Math.round((await metrics()).turns[1].top), "a taller viewport highlights every turn it now intersects");
    const resizedVisible = await visible();
    check(resizedVisible.length >= 2, "the resize highlighted the additional intersecting turns " + JSON.stringify(resizedVisible));

    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX02_PORT"
    : (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nUX-02 BROWSER CHECKS PASSED" : "\nUX-02 FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
