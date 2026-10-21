/**
 * Browser regression for UX ticket 05: the per-response footer renders SVG
 * token statistics with localized accessible names, and Settings' browser
 * preference shows or hides those footers and survives a reload.
 *
 * It bundles apps/web/e2e/chat/ux-token-footer.fixture.tsx with the workspace's own
 * esbuild, serves the build from a temporary directory outside the repository
 * on 127.0.0.1:43105 (override with HEPI_UX05_PORT), and drives it with the
 * installed Playwright. The fixture mounts the production MessageView, the real
 * i18n provider and the real response-usage-visibility module, so the switch
 * here is the same code path Settings › General's switch calls.
 *
 * Assertions read rendered DOM, computed styles, accessible names and real
 * clicks/keystrokes. Every wait is an observable DOM condition. It also writes
 * light/dark, desktop/narrow screenshots to UX05_ARTIFACT_DIR (default
 * /tmp/hepi-ux05-artifacts) at the footer's real 11px display size for human
 * visual review; those images are evidence, not acceptance.
 *
 * Usage: node apps/web/e2e/chat/ux-token-footer.ts [--keep]
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX05_PORT ?? 43105);
const artifactDir = process.env.UX05_ARTIFACT_DIR ?? "/tmp/hepi-ux05-artifacts";
const STORAGE_KEY = "pi-response-usage-visible";

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

const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux05-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-token-footer.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-05</title>",
  "<link rel=\"stylesheet\" href=\"./ux-token-footer.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-token-footer.fixture.js\"></script>",
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
    const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.locator("[data-token-metric]").first().waitFor({ state: "visible", timeout: 15000 });

    const metrics = () => page.evaluate(() => Array.from(document.querySelectorAll("[data-token-metric]")).map((element) => {
      const svg = element.querySelector("svg");
      const box = svg?.getBoundingClientRect();
      const style = svg ? getComputedStyle(svg) : null;
      return {
        key: element.getAttribute("data-token-metric"),
        text: element.textContent,
        title: element.getAttribute("title") ?? "",
        glyphSize: box ? [Math.round(box.width), Math.round(box.height)] : null,
        stroke: style?.stroke,
        strokeWidth: style?.strokeWidth,
        hidden: element.classList.contains("sr-only") ? null : element.querySelector(".sr-only")?.textContent ?? null,
      };
    }));
    const visibleCount = () => page.locator("[data-token-metric]").count();
    const footerText = () => page.locator("[data-fixture-chat]").innerText();

    console.log("== the footer renders one SVG family plus the numbers");
    const rendered = await metrics();
    check(rendered.length === 4, "four token metrics render (" + rendered.map((m) => m.key).join(", ") + ")");
    check(
      rendered.every((m) => m.glyphSize && m.glyphSize[0] === 11 && m.glyphSize[1] === 11),
      "every glyph displays at the footer's 11px size " + JSON.stringify(rendered.map((m) => m.glyphSize)),
    );
    check(
      rendered.every((m) => m.strokeWidth !== undefined && Number.parseFloat(m.strokeWidth) === 1.8),
      "one stroke width across the family " + JSON.stringify(rendered.map((m) => m.strokeWidth)),
    );
    check(rendered.every((m) => m.stroke === "currentColor" || m.stroke === "rgb(94, 102, 115)"),
      "glyphs take their color from the footer text " + JSON.stringify(rendered.map((m) => m.stroke)));
    const values = rendered.map((m) => m.text.trim());
    check(
      JSON.stringify(values) === JSON.stringify(["Input tokens: 1,234", "Output tokens: 567", "Cache read tokens: 89", "Cache write tokens: 12"]),
      "each number keeps its metric name " + JSON.stringify(values),
    );
    check(
      rendered.every((m) => m.title && m.title.includes(m.text.trim().split(": ")[1])),
      "each tooltip keeps the localized name and the value " + JSON.stringify(rendered.map((m) => m.title)),
    );
    check(
      !/1,234 in|567 out|cache R|cache W/.test(await footerText()),
      "the old abbreviated text labels are gone",
    );

    console.log("== direction and shape match the aggregate toolbar's meaning");
    const glyphPaths = await page.evaluate(() => Array.from(document.querySelectorAll("[data-token-metric]")).map((element) => ({
      key: element.getAttribute("data-token-metric") ?? "",
      paths: Array.from(element.querySelectorAll("path")).map((path) => path.getAttribute("d") ?? ""),
      rects: element.querySelectorAll("rect").length,
    })));
    const glyphOf = (key: string): string | undefined => glyphPaths.find((g) => g.key === key)?.paths[0];
    check(glyphOf("input") === "m18 9-6-6-6 6", "input keeps the up arrow the aggregate toolbar uses");
    check(glyphOf("output") === "M12 17V3", "output keeps the down arrow the aggregate toolbar uses");
    const cacheGlyphs = glyphPaths.filter((g) => g.key === "cacheRead" || g.key === "cacheWrite");
    check(
      cacheGlyphs.every((g) => g.rects === 1 && g.paths.filter((d) => d.includes("h.01")).length === 2),
      "both cache metrics keep the same drive silhouette",
    );
    check(
      cacheGlyphs[0]?.paths.join() !== cacheGlyphs[1]?.paths.join(),
      "the cached pair is two different glyphs",
    );
    check(
      glyphOf("cacheRead") === "m16 6-4-4-4 4"
        && glyphOf("cacheWrite") === "M12 2v8",
      "cache read points up like input and cache write points down like output",
    );

    console.log("== the cached pair is distinguishable at its real size, with no tooltip");
    // Rasterize the two live glyphs through a canvas at the footer's own 11px in
    // each theme and compare pixels: a person decides from the picture alone.
    for (const theme of ["light", "dark"]) {
      const raster = await page.evaluate(async (value) => {
        document.documentElement.dataset.theme = value;
        const read = (element: Element) => {
          const svg = element.querySelector("svg");
          if (svg === null) throw new Error("the metric has no glyph");
          svg.setAttribute("stroke", getComputedStyle(element).color);
          return new XMLSerializer().serializeToString(svg);
        };
        const paint = async (markup: string) => {
          const image = new Image();
          image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = 11;
          canvas.height = 11;
          const context = canvas.getContext("2d");
          if (context === null) throw new Error("no 2d context");
          context.drawImage(image, 0, 0, 11, 11);
          return Array.from(context.getImageData(0, 0, 11, 11).data);
        };
        const glyph = (key: string): Element => {
          const found = document.querySelector('[data-token-metric="' + key + '"]');
          if (found === null) throw new Error("the " + key + " metric is not on screen");
          return found;
        };
        const readRaster = await paint(read(glyph("cacheRead")));
        const writeRaster = await paint(read(glyph("cacheWrite")));
        let readInk = 0;
        let writeInk = 0;
        let differing = 0;
        for (let i = 3; i < readRaster.length; i += 4) {
          if (readRaster[i] > 8) readInk += 1;
          if (writeRaster[i] > 8) writeInk += 1;
          if (Math.abs(readRaster[i] - writeRaster[i]) > 8) differing += 1;
        }
        return { readInk, writeInk, differing, pixels: 11 * 11 };
      }, theme);
      check(raster.readInk > 8 && raster.writeInk > 8, theme + ": both glyphs draw ink (" + JSON.stringify(raster) + ")");
      check(
        raster.differing / raster.pixels > 0.12,
        theme + ": the two glyphs differ across enough pixels to read apart (" + raster.differing + "/" + raster.pixels + ")",
      );
    }

    console.log("== light and dark, desktop and narrow");
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      for (const viewport of [{ width: 900, height: 600 }, { width: 360, height: 640 }]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(() => (document.querySelector("[data-token-metric]")?.getBoundingClientRect().width ?? 0) > 0);
        const overflow = await page.evaluate(() => {
          const chat = document.querySelector("[data-fixture-chat]");
          const footer = document.querySelector("[data-token-metric]")?.parentElement;
          if (chat === null || footer === null || footer === undefined) throw new Error("the footer is not on screen");
          return {
            chatRight: Math.round(chat.getBoundingClientRect().right),
            footerRight: Math.round(footer.getBoundingClientRect().right),
            documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        const file = join(artifactDir, "token-footer-" + theme + "-" + viewport.width + ".png");
        await page.screenshot({ path: file });
        check(overflow.footerRight <= overflow.chatRight + 1, theme + " " + viewport.width + "px: the footer stays inside the message (" + JSON.stringify(overflow) + ")");
        check(overflow.documentOverflow <= 0, theme + " " + viewport.width + "px: no horizontal page overflow");
        note("screenshot " + file);
      }
      // The pair above is judged at the footer's real 11px, so keep a magnified
      // copy of the same raster for the human looking at these artifacts.
      const zoomContext = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 8 });
      const zoomPage = await zoomContext.newPage();
      await zoomPage.goto(origin + "/", { waitUntil: "domcontentloaded" });
      await zoomPage.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const footer = zoomPage.locator("[data-token-metric]").first().locator("xpath=..");
      await footer.waitFor({ state: "visible", timeout: 15000 });
      await footer.screenshot({ path: join(artifactDir, "token-footer-" + theme + "-zoom.png") });
      await zoomContext.close();
    }

    console.log("== the switch hides response footers only, and survives a reload");
    const switchLocator = page.locator("[data-fixture-switch]");
    check(await switchLocator.getAttribute("aria-checked") === "true", "the switch starts on, preserving current visibility");
    await switchLocator.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-token-metric]").length === 0, undefined, { timeout: 15000 });
    check(await visibleCount() === 0, "turning it off removes the response footer statistics");
    check((await footerText()).includes("Answer with token statistics"), "the response text itself stays");
    check(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY) === "false", "the choice is stored in this browser");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-fixture-chat]").waitFor({ state: "visible", timeout: 15000 });
    check(await visibleCount() === 0, "the hidden footer stays hidden after a reload");
    check(await switchLocator.getAttribute("aria-checked") === "false", "the switch reflects the stored choice");

    await switchLocator.click();
    await page.locator("[data-token-metric]").first().waitFor({ state: "visible", timeout: 15000 });
    check(await visibleCount() === 4, "turning it back on restores every metric");
    check(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY) === "true", "the restored choice is stored too");

    console.log("== localized accessible names");
    await page.locator('[data-fixture-locale="zh-CN"]').click();
    await page.waitForFunction(
      () => document.querySelector("[data-token-metric]")?.textContent?.includes("输入 tokens"),
      undefined,
      { timeout: 15000 },
    );
    const localized = await metrics();
    check(
      JSON.stringify(localized.map((m) => m.text.trim())) === JSON.stringify([
        "输入 tokens: 1,234",
        "输出 tokens: 567",
        "缓存读取 tokens: 89",
        "缓存写入 tokens: 12",
      ]),
      "the metric names localize while the numbers stay " + JSON.stringify(localized.map((m) => m.text.trim())),
    );
    check(
      localized.every((m) => m.title.startsWith(m.text.trim().split(": ")[0])),
      "the tooltips localize with them " + JSON.stringify(localized.map((m) => m.title)),
    );
    await page.screenshot({ path: join(artifactDir, "token-footer-zh-narrow.png") });
    await page.locator('[data-fixture-locale="en"]').click();

    console.log("== the aggregate session toolbar is untouched");
    // AppShell is a shared UI panel; the Web host only mounts it.
    const appShell = await readFile(join(webRoot, "..", "..", "packages", "ui", "src", "components", "AppShell.tsx"), "utf8");
    check(
      appShell.includes("viewBox=\"0 0 10 10\"") && appShell.includes("strokeWidth=\"1.2\""),
      "the aggregate toolbar keeps its own 10-grid, 1.2-stroke glyphs",
    );
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX05_PORT"
    : (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  console.log(failures.length === 0 ? "\nUX-05 BROWSER CHECKS PASSED" : "\nUX-05 FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
