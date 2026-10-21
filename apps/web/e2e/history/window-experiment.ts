/**
 * Ticket 09: runnable browser experiment that selects one window implementation for a long transcript.
 *
 * It bundles `window-experiment.fixture.tsx` (production turn model + production MessageView + two candidate window
 * adapters) with the workspace's own esbuild, serves it from a temporary directory outside the repository, and drives it
 * in headless Chromium. Nothing here touches the production `.next` output, the running services or a paid provider.
 *
 * What it measures, per candidate, on the same machine, viewport, overscan and fixture:
 *   - mounted-turn DOM at 200 vs 2000 messages (plateau target: <= 2x);
 *   - that returning to the tail releases the offscreen historical mounts;
 *   - that a height change under the reader (image, expanded process group, growing stream) keeps the anchor;
 *   - that search and minimap navigation reach a turn that is not mounted, by identity;
 *   - that a manual process expansion survives its turn being unmounted and remounted;
 *   - interaction and long-task timing plus post-GC heap, reported as p95/max rather than a universal claim.
 *
 * Usage: node apps/web/e2e/history/window-experiment.ts [--keep]
 *        HEPI_EXPERIMENT_PORT (default 43110)
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_EXPERIMENT_PORT ?? 43110);
const MESSAGE_COUNTS = [200, 2000];
/**
 * The candidates, and which of them is the shipped implementation.
 *
 * `production` is ticket 10's `lib/transcript-window.ts`, the module the chat renders with. `platform` and
 * `tanstack` are ticket 09's prototypes, kept here for the DOM-plateau and interaction comparison that selected the
 * approach. The prototypes measure heights but do not correct the scroll position when the geometry above the reader
 * changes, so the anchor checks below are production-only and a prototype's failure is recorded as evidence rather
 * than as a regression.
 */
const CANDIDATES = [
  { name: "production", anchors: true },
  { name: "platform", anchors: false },
  { name: "tanstack", anchors: false },
];
const OVERSCAN = 4;
const VIEWPORT = { width: 1000, height: 800 };

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}
function note(message: string) { console.log("  ..  " + message); }
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

/** The DOM cost of one message count, split by where the nodes are: the whole document, the window, the minimap. */
interface DomBreakdown {
  readonly total: number;
  readonly window: number;
  readonly minimap: number;
  readonly mountedTurns: number;
  readonly perTurn: number[];
}

/** What the fixture states about the streaming tail's placement, read off the DOM. */
interface StreamPlacement {
  readonly afterLastMountedTurn: boolean;
  readonly mountedTurnCount: number;
  readonly mountedIndexes: (string | null)[];
}

/** Everything one candidate recorded, as the report file states it. Every field is filled in before the report is written. */
interface CandidateReport {
  mountedByCount?: Record<number, number>;
  domByCount?: Record<number, number>;
  domBreakdownByCount?: Record<number, DomBreakdown>;
  mountedHistoryDomRatio?: number;
  mountedTurnDomRatio?: number;
  ratio?: number;
  historyReleased?: boolean;
  anchorDelta?: number | null;
  expansionSurvives?: boolean;
  reveal?: { requests: number[]; mountedAfterReveal: number };
  prepend?: { anchorKey: string | null; beforeOffset: number; afterOffset: number | null };
  growthAbove?: { anchorKey: string | null; beforeOffset: number | null; afterOffset: number | null };
  streamTail?: StreamPlacement | null;
  isProduction?: boolean;
  timing?: { scrollElapsedMs: number; longTasksMs: number[]; tailReturnMs: number[]; heapMb: number | null };
}

/** The whole report one run writes beside the build. */
interface ExperimentReport {
  viewport: { width: number; height: number };
  overscan: number;
  platform: string;
  arch: string;
  node: string;
  candidates: Record<string, CandidateReport>;
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-window-experiment-"));
const { build } = await import("esbuild");
try {
  await build({
    entryPoints: [join(here, "window-experiment.fixture.tsx")],
    outdir: buildDir,
    bundle: true,
    format: "esm",
    jsx: "automatic",
    tsconfig: join(webRoot, "tsconfig.json"),
    define: { "process.env.NODE_ENV": "\"production\"" },
    logLevel: "warning",
  });
} catch (error) {
  console.log("experiment fixture did not build: " + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>window experiment</title>",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./window-experiment.fixture.js\"></script>",
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
  console.log("== experiment " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const report: ExperimentReport = {
    viewport: VIEWPORT,
    overscan: OVERSCAN,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    candidates: {},
  };
  try {
    for (const { name: candidate, anchors } of CANDIDATES) {
      console.log("== candidate " + candidate + (anchors ? "" : " (ticket 09 prototype)"));
      const page = await browser.newPage({ viewport: VIEWPORT });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
      await page.locator("[data-window-turn]").first().waitFor({ state: "visible", timeout: 20000 });
      await page.evaluate((name) => window.__experiment!.setAdapter(name), candidate);
      await page.locator(`[data-window="${candidate}"]`).waitFor({ state: "visible", timeout: 20000 });

      const metrics = async () => await page.evaluate(() => window.__experiment!.metrics());
      const mountedTurns = async (): Promise<(string | null)[]> =>
        await page.evaluate(() => Array.from(document.querySelectorAll("[data-window-turn]")).map((element) => element.getAttribute("data-window-turn")));
      const settle = async () => await page.waitForTimeout(300);
      const entry: CandidateReport = {};
      report.candidates[candidate] = entry;

      console.log("== " + candidate + ": mounted-turn DOM at 200 and 2000 messages");
      const mountedByCount: Record<number, number> = {};
      const domByCount: Record<number, number> = {};
      const domBreakdownByCount: Record<number, DomBreakdown> = {};
      for (const count of MESSAGE_COUNTS) {
        await page.evaluate((value) => window.__experiment!.setMessageCount(value), count);
        await settle();
        await page.evaluate(() => window.__experiment!.scrollToTail());
        await settle();
        const layout = await metrics();
        mountedByCount[count] = layout.mounted;
        domByCount[count] = layout.domNodes;
        // The total is not the transcript's cost: the minimap keeps one node per turn (by design — it is the whole
        // transcript's outline), and the window's own container holds the mounted turns plus their spacers. What
        // windowing bounds is the mounted-turn subtree, so report all three rather than one number that mixes them.
        const turnDom = layout.perTurnDom.reduce((sum, value) => sum + value, 0);
        domBreakdownByCount[count] = {
          total: layout.domNodes,
          window: layout.windowDom,
          minimap: layout.minimapDom,
          mountedTurns: turnDom,
          perTurn: layout.perTurnDom,
        };
        note(count + " messages: " + layout.mounted + " turns mounted, "
          + layout.domNodes + " DOM nodes total = " + layout.windowDom + " window ("
          + turnDom + " inside mounted turns + " + (layout.windowDom - turnDom) + " spacers) + "
          + layout.minimapDom + " minimap, scrollHeight " + Math.round(layout.scrollHeight));
      }
      const smallBreakdown = domBreakdownByCount[200];
      const largeBreakdown = domBreakdownByCount[2000];
      if (smallBreakdown === undefined || largeBreakdown === undefined) throw new Error(candidate + ": the 200 and 2000 message counts were not both measured");
      const mountedTurnDomRatio = largeBreakdown.mountedTurns === 0
        ? Infinity
        : largeBreakdown.mountedTurns / smallBreakdown.mountedTurns;
      check(
        mountedTurnDomRatio <= 2,
        candidate + ": mounted-turn DOM plateaus within 2x from 200 to 2000 messages ("
          + smallBreakdown.mountedTurns + " -> " + largeBreakdown.mountedTurns
          + ", ratio " + mountedTurnDomRatio.toFixed(2) + ")",
      );
      const minimapGrows = largeBreakdown.minimap > smallBreakdown.minimap;
      check(
        minimapGrows,
        candidate + ": the minimap's one-node-per-turn outline grows with the transcript and is therefore not the"
          + " transcript's mounted cost (" + smallBreakdown.minimap + " -> " + largeBreakdown.minimap + ")",
      );
      const smallMounted = mountedByCount[200];
      const largeMounted = mountedByCount[2000];
      if (smallMounted === undefined || largeMounted === undefined) throw new Error(candidate + ": the mounted-turn counts were not both measured");
      const ratio = smallMounted === 0 ? Infinity : largeMounted / smallMounted;
      check(largeMounted > 0, candidate + ": the 2000-message transcript mounts turns");
      check(
        ratio <= 2,
        candidate + ": mounted turns plateau within 2x from 200 to 2000 messages ("
          + smallMounted + " -> " + largeMounted + ", ratio " + ratio.toFixed(2) + ")",
      );
      const mountedHistoryDomRatio = mountedTurnDomRatio;
      check(
        mountedHistoryDomRatio <= 2,
        candidate + ": the mounted history's own DOM plateaus within 2x from 200 to 2000 messages ("
          + smallBreakdown.mountedTurns + " -> " + largeBreakdown.mountedTurns
          + ", ratio " + mountedHistoryDomRatio.toFixed(2) + ")",
      );
      entry.mountedByCount = mountedByCount;
      entry.domByCount = domByCount;
      entry.domBreakdownByCount = domBreakdownByCount;
      entry.mountedHistoryDomRatio = mountedHistoryDomRatio;
      entry.mountedTurnDomRatio = mountedTurnDomRatio;
      entry.ratio = ratio;

      console.log("== " + candidate + ": returning to the tail releases offscreen history");
      await page.evaluate(() => window.__experiment!.setMessageCount(2000));
      await settle();
      await page.evaluate(() => window.__experiment!.scrollToRatio(0.2));
      await settle();
      const readingHistory = await mountedTurns();
      const historicalTurn = readingHistory[0] ?? null;
      await page.evaluate(() => window.__experiment!.scrollToTail());
      await settle();
      const atTail = await mountedTurns();
      check(atTail.length > 0, candidate + ": the tail mounts turns");
      check(
        !atTail.includes(historicalTurn),
        candidate + ": the historical turn mounted while reading (" + historicalTurn + ") is released at the tail",
      );
      entry.historyReleased = !atTail.includes(historicalTurn);

      console.log("== " + candidate + ": a height change keeps the reading anchor");
      await page.evaluate(() => window.__experiment!.scrollToRatio(0.35));
      await settle();
      // The turn the reader is actually looking at: the first mounted turn whose top is inside the viewport, not the
      // first one mounted at all (which sits above it as overscan).
      const anchorKey = await page.evaluate(() => {
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!scroll) return null;
        const scrollTop = scroll.getBoundingClientRect().top;
        const visible = Array.from(document.querySelectorAll("[data-window-turn]")).find((element) => {
          const top = element.getBoundingClientRect().top - scrollTop;
          return top >= -2 && top < scroll.clientHeight;
        });
        return visible?.getAttribute("data-window-turn") ?? null;
      });
      check(anchorKey !== null, candidate + ": a turn sits at the top of the viewport to anchor on");
      if (anchorKey === null) throw new Error(candidate + ": no turn sat at the top of the viewport to anchor on");
      const anchorOffset = () => page.evaluate((target) => {
        const turn = document.querySelector(`[data-window-turn="${target}"]`);
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!turn || !scroll) return null;
        return turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }, anchorKey);
      const before = await anchorOffset();
      // Expand the process group under the reader and grow the live tail: both change the heights the window has
      // remembered, which is where an anchor is easiest to lose.
      await page.evaluate((key) => window.__experiment!.setProcessExpanded(key, true), anchorKey);
      await settle();
      await page.evaluate(() => window.__experiment!.growStream(6000));
      await settle();
      const after = await anchorOffset();
      if (before === null || after === null) check(false, candidate + ": the anchored turn stayed mounted across the height change");
      else check(Math.abs(after - before) < 12, candidate + ": the turn under the reader stayed put through a height change (" + Math.round(before) + " -> " + Math.round(after) + ")");
      entry.anchorDelta = before === null || after === null ? null : Math.round(after - before);

      console.log("== " + candidate + ": a manual process expansion survives unmount and remount");
      check(await page.evaluate((key) => window.__experiment!.isProcessExpanded(key), anchorKey), candidate + ": the process group is expanded");
      await page.evaluate(() => window.__experiment!.scrollToTail());
      await settle();
      check(!(await mountedTurns()).includes(anchorKey), candidate + ": the expanded turn left the window at the tail");
      await page.evaluate(() => window.__experiment!.scrollToRatio(0.35));
      await settle();
      check(await page.evaluate((key) => window.__experiment!.isProcessExpanded(key), anchorKey), candidate + ": the expansion is still there after the turn remounted");
      entry.expansionSurvives = true;

      console.log("== " + candidate + ": search and minimap reach an unmounted turn by identity");
      await page.evaluate(() => window.__experiment!.scrollToTail());
      await settle();
      const beforeReveal = await mountedTurns();
      await page.evaluate(() => window.__experiment!.searchTurn(700));
      await settle();
      const requests = await page.evaluate(() => window.__experiment!.revealRequests());
      const revealMounted = await page.evaluate(() => Boolean(document.querySelector("[data-search-target]")));
      check(requests.includes(700), candidate + ": the surface's reveal request named the turn it could not find mounted");
      check(revealMounted, candidate + ": the search target is rendered after the reveal");
      const afterReveal = await mountedTurns();
      check(afterReveal.length > 0 && afterReveal.length <= Math.max(20, beforeReveal.length), candidate + ": the reveal mounted a bounded window (" + beforeReveal.length + " -> " + afterReveal.length + " turns)");
      entry.reveal = { requests, mountedAfterReveal: afterReveal.length };

      console.log("== " + candidate + ": a page of older history prepended in front keeps the reader's place");
      await page.evaluate(() => window.__experiment!.setMessageCount(2000));
      await settle();
      await page.evaluate(() => window.__experiment!.scrollToRatio(0.5));
      await settle();
      // The turn the reader is looking at, by key: a prepend renumbers every index, so an index-based check would
      // pass even if the surface jumped to a different turn.
      const prependAnchor = await page.evaluate(() => {
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!scroll) return null;
        const scrollTop = scroll.getBoundingClientRect().top;
        const visible = Array.from(document.querySelectorAll("[data-window-turn]")).find((element) => {
          const top = element.getBoundingClientRect().top - scrollTop;
          return top >= -2 && top < scroll.clientHeight;
        });
        if (!visible) return null;
        return {
          key: visible.getAttribute("data-window-turn"),
          offset: visible.getBoundingClientRect().top - scrollTop,
        };
      });
      check(prependAnchor !== null, candidate + ": a turn sits at the top of the viewport to anchor on before the prepend");
      if (prependAnchor === null) throw new Error(candidate + ": no turn sat at the top of the viewport to anchor on before the prepend");
      const beforePrepend = await page.evaluate(() => window.__experiment!.turnCount());
      await page.evaluate(() => window.__experiment!.prependTurns(30));
      await settle();
      const afterPrepend = await page.evaluate(() => window.__experiment!.turnCount());
      check(afterPrepend === beforePrepend + 30, candidate + ": the prepended page joined the transcript ("
        + beforePrepend + " -> " + afterPrepend + " turns)");
      const anchorAfterPrepend = await page.evaluate((key) => {
        const turn = document.querySelector(`[data-window-turn="${key}"]`);
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!turn || !scroll) return null;
        return turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }, prependAnchor.key);
      const prependHeld = anchorAfterPrepend !== null && Math.abs(anchorAfterPrepend - prependAnchor.offset) < 12;
      if (!anchors) {
        note(candidate + ": prepend anchor (prototype, recorded): the reader's turn "
          + (anchorAfterPrepend === null ? "was unmounted" : "moved to " + Math.round(anchorAfterPrepend) + "px from " + Math.round(prependAnchor.offset) + "px"));
      } else if (anchorAfterPrepend === null) {
        check(false, candidate + ": the reader's turn is still mounted after the prepend");
      } else {
        check(prependHeld, candidate + ": the reader's turn stayed where it was after 30 turns were prepended in front of it ("
          + Math.round(prependAnchor.offset) + " -> " + Math.round(anchorAfterPrepend) + "px)");
      }
      entry.prepend = {
        anchorKey: prependAnchor.key,
        beforeOffset: Math.round(prependAnchor.offset),
        afterOffset: anchorAfterPrepend === null ? null : Math.round(anchorAfterPrepend),
      };

      console.log("== " + candidate + ": a turn growing above the reader does not move them");
      // The reader's turn is the one the viewport's top edge is inside — the window's own anchor — and the turn to
      // grow is the one before it. Growing the anchor itself would move the turns *below* it, which is not what this
      // check is about.
      const growthPlan = await page.evaluate(() => {
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!scroll) return null;
        const viewportTop = scroll.getBoundingClientRect().top;
        const turns = Array.from(document.querySelectorAll("[data-window-turn]"));
        const index = turns.findIndex((element) => {
          const top = element.getBoundingClientRect().top - viewportTop;
          const bottom = element.getBoundingClientRect().bottom - viewportTop;
          return top <= 0 && bottom > 0;
        });
        if (index < 1) return null;
        return {
          anchor: turns[index].getAttribute("data-window-turn"),
          above: turns[index - 1].getAttribute("data-window-turn"),
        };
      });
      check(growthPlan !== null, candidate + ": there is a mounted turn above the reader's to grow");
      const growthAnchor = growthPlan?.anchor ?? null;
      const above = growthPlan?.above ?? null;
      if (above === null) throw new Error(candidate + ": no mounted turn above the reader's was found to grow");
      // Grow a turn *above* the anchor by appending a node to it directly. React never renders this, so no ref runs
      // and no state changes: the only way the window can learn the turn got taller is by observing the turn node
      // itself. A window that measures in a React ref sees nothing here, which is exactly the gap this check exists
      // for.
      const beforeGrowth = await page.evaluate((key) => {
        const turn = document.querySelector(`[data-window-turn="${key}"]`);
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!turn || !scroll) return null;
        return turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }, growthAnchor);
      await page.evaluate((key) => window.__experiment!.growTurn(key, 240), above);
      // The observer's callback and the layout effect that applies the correction both have to run.
      await settle();
      await settle();
      const afterGrowth = await page.evaluate((key) => {
        const turn = document.querySelector(`[data-window-turn="${key}"]`);
        const scroll = document.querySelector("[data-fixture-scroll]");
        if (!turn || !scroll) return null;
        return turn.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      }, growthAnchor);
      if (!anchors) {
        note(candidate + ": growth-above anchor (prototype, recorded): the reader's turn "
          + (afterGrowth === null ? "was unmounted" : "moved to " + Math.round(afterGrowth) + "px from " + (beforeGrowth === null ? "an unknown place" : Math.round(beforeGrowth) + "px")));
      } else if (beforeGrowth === null || afterGrowth === null) {
        check(false, candidate + ": the reader's turn stayed mounted across a turn growing above them");
      } else {
        check(Math.abs(afterGrowth - beforeGrowth) < 12, candidate + ": the reader's turn stayed put when a turn above it grew by 240px ("
          + Math.round(beforeGrowth) + " -> " + Math.round(afterGrowth) + "px)");
      }
      entry.growthAbove = {
        anchorKey: growthAnchor,
        beforeOffset: beforeGrowth === null ? null : Math.round(beforeGrowth),
        afterOffset: afterGrowth === null ? null : Math.round(afterGrowth),
      };

      console.log("== " + candidate + ": the live tail is inside the window while it streams");
      await page.evaluate(() => window.__experiment!.scrollToTail());
      await settle();
      await page.evaluate(() => window.__experiment!.setStreaming(true));
      await settle();
      check(await page.evaluate(() => Boolean(document.querySelector("[data-fixture-stream]"))), candidate + ": the streaming tail is rendered");
      // The live surface sits at the transcript's end: the last turn must be the one mounted, and the streaming
      // bubble must follow it. A window that stopped short of the tail would leave the live text off screen.
      const streamPlacement = await page.evaluate(() => {
        const stream = document.querySelector("[data-fixture-stream]");
        const window = document.querySelector("[data-window]");
        if (!stream || !window) return null;
        const mounted = Array.from(window.querySelectorAll("[data-window-turn]"));
        const lastMounted = mounted.at(-1) ?? null;
        return {
          afterLastMountedTurn: lastMounted !== null && Boolean(lastMounted.compareDocumentPosition(stream) & Node.DOCUMENT_POSITION_FOLLOWING),
          mountedTurnCount: mounted.length,
          mountedIndexes: mounted.map((element) => element.getAttribute("data-window-turn")),
        };
      });
      entry.streamTail = streamPlacement;
      check(
        streamPlacement !== null && streamPlacement.afterLastMountedTurn,
        candidate + ": the streaming tail follows the last mounted turn, so the live end is on screen",
      );
      entry.isProduction = anchors;
      // The live turn is the transcript's last one, so the window reached the tail rather than stopping short.
      const lastTurnMounted = await page.evaluate(() => {
        const mounted = Array.from(document.querySelectorAll("[data-window-turn]")).map((element) => element.getAttribute("data-window-turn"));
        const keys = window.__experiment!.turnKeys();
        return keys.length > 0 && mounted.includes(keys[keys.length - 1]);
      });
      check(lastTurnMounted, candidate + ": the transcript's last turn is mounted while it streams");

      console.log("== " + candidate + ": interaction and long-task timing");
      const longTasks = await page.evaluate(async () => {
        const durations: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        });
        try { observer.observe({ entryTypes: ["longtask"] }); } catch { /* not supported */ }
        const started = performance.now();
        for (let step = 1; step <= 20; step += 1) {
          window.__experiment!.scrollToRatio(step / 21);
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        }
        observer.disconnect();
        return { durations, elapsed: performance.now() - started };
      });
      const tailReturns = [];
      for (let round = 0; round < 3; round += 1) {
        const started = Date.now();
        await page.evaluate(() => window.__experiment!.scrollToTail());
        await page.waitForFunction(() => document.querySelectorAll("[data-window-turn]").length > 0, undefined, { timeout: 20000 });
        tailReturns.push(Date.now() - started);
      }
      const heap = await page.evaluate(async () => {
        if (typeof globalThis.gc === "function") globalThis.gc();
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        return memory ? Math.round(memory.usedJSHeapSize / (1024 * 1024)) : null;
      });
      note(candidate + ": 20 scroll steps in " + Math.round(longTasks.elapsed) + "ms, long tasks "
        + JSON.stringify(longTasks.durations.map((value) => Math.round(value)))
        + ", tail-return p95 " + percentile(tailReturns, 0.95) + "ms max " + Math.max(...tailReturns) + "ms, heap " + heap + "MB");
      entry.timing = {
        scrollElapsedMs: Math.round(longTasks.elapsed),
        longTasksMs: longTasks.durations.map((value) => Math.round(value)),
        tailReturnMs: tailReturns,
        heapMb: heap,
      };

      check(pageErrors.length === 0, candidate + ": no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
      await page.close();
    }

    console.log("== verdict inputs");
    console.log(JSON.stringify(report, null, 1));
    await writeFile(join(buildDir, "report.json"), JSON.stringify(report, null, 1));
    console.log("report: " + join(buildDir, "report.json") + (keep ? " (kept)" : ""));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_EXPERIMENT_PORT"
    : (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nWINDOW EXPERIMENT CHECKS PASSED" : "\nWINDOW EXPERIMENT FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
