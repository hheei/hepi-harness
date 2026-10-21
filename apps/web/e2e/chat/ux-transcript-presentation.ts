/**
 * Browser regression for the transcript presentation seam: the notice shelf's clocks, and follow-tail in the viewport.
 *
 * The failure this pins is the one the ticket names (acceptance C6, C7): a notice's countdown, its pause while the reader
 * is on it, and its leave animation were held by the **conversation session**, so a surface that stopped drawing left a
 * timer running, and a reader scrolled into history was pulled to the tail by a live turn arriving. Both behaviours are
 * driven here through the production modules the workbench mounts — `NoticeShelf` and `useTranscriptPresentation` — with
 * real timers and a real scrolling element.
 *
 * Every action is an ordinary one a reader performs: hovering a toast, scrolling the transcript, a turn arriving. The
 * fixture decides nothing; it states what a conversation would state.
 *
 * Usage: node apps/web/e2e/chat/ux-transcript-presentation.ts [--keep]
 *        HEPI_UX_PRESENTATION_PORT=<port>
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX_PRESENTATION_PORT ?? 43131);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux-presentation-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-transcript-presentation.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>transcript presentation</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-transcript-presentation.fixture.js\"></script>",
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
    await page.waitForFunction(() => window.__presentation !== undefined, undefined, { timeout: 20000 });

    const viewport = () => page.evaluate(() => window.__presentation!.viewport());
    const toasts = page.locator(".notice-shelf-item");

    console.log("== a stated notice is drawn, and the shelf's own clock retires it");
    await page.evaluate(() => window.__presentation!.stateNotice("a dropped file was uploaded"));
    await toasts.first().waitFor({ state: "visible", timeout: 5000 });
    check(await toasts.count() === 1, "the notice the conversation stated is on screen");
    check((await page.evaluate(() => window.__presentation!.held())).length === 1, "and the conversation still holds it while it is drawn");
    // The shelf draws a notice for its stated time and then leaves: nothing the conversation stated removed it.
    await page.waitForFunction(() => window.__presentation!.held().length === 0, undefined, { timeout: 15000 });
    check(await toasts.count() === 0, "the shelf retired it on its own clock, and handed the fact back");

    console.log("== hovering a notice keeps it, and it resumes for the time it had left");
    await page.evaluate(() => window.__presentation!.stateNotice("another notice"));
    await toasts.first().waitFor({ state: "visible", timeout: 5000 });
    // Two seconds of its five are drawn before the reader's pointer reaches it, so what a resume owes is about three.
    await page.waitForTimeout(2_000);
    await toasts.first().hover();
    await page.waitForTimeout(6_000);
    check(await toasts.count() === 1, "a notice the reader is on is not taken away from them, however long they stay");
    const leftHover = Date.now();
    await page.mouse.move(0, 0);
    await page.waitForFunction(() => window.__presentation!.held().length === 0, undefined, { timeout: 8_000 });
    const afterHover = Date.now() - leftHover;
    check(await toasts.count() === 0, "and it leaves once the reader moves off it");
    // A resume, not a restart: a shelf that reset the clock would hold it for another full duration (5.18s including
    // the leave animation), while the remainder of a notice already drawn for two seconds is well short of that.
    check(afterHover < 4_500, "for the time it had left, not the whole duration again: " + afterHover + "ms");

    console.log("== a reader scrolled back into history is not pulled to the tail");
    await page.evaluate(() => window.__presentation!.setBusy(true));
    const before = await viewport();
    check(before.scrollHeight > before.clientHeight, "the transcript overflows the viewport it is drawn in");
    check(before.scrollTop + before.clientHeight >= before.scrollHeight - 8, "a conversation opens at its live end: scrollTop " + before.scrollTop);
    // The reader's own gesture: scroll up into what is already loaded.
    await page.locator("[data-scroll]").evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(100);
    const atTop = await viewport();
    check(atTop.scrollTop === 0, "the reader is at the top of the loaded transcript");
    check(atTop.jumping === true, "and the surface offers to jump back to the latest: " + JSON.stringify(atTop));
    await page.evaluate(() => window.__presentation!.arrive());
    await page.waitForTimeout(300);
    const afterArrival = await viewport();
    check(afterArrival.scrollTop === 0, "a turn arriving left the reader where they were reading: scrollTop " + afterArrival.scrollTop);

    console.log("== returning to the tail re-attaches the follow");
    await page.locator("[data-scroll]").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => window.__presentation!.viewport().jumping === false, undefined, { timeout: 5000 });
    const atTail = await viewport();
    check(atTail.jumping === false, "a reader at the tail is offered nothing to jump to");
    // The run ends, and the turn that ends it is the one a following reader is carried to.
    await page.evaluate(() => window.__presentation!.setBusy(false));
    await page.evaluate(() => window.__presentation!.arrive());
    await page.waitForTimeout(300);
    const followed = await viewport();
    check(followed.scrollTop > atTail.scrollTop, "and the next turn follows them: " + atTail.scrollTop + " -> " + followed.scrollTop);
    check(followed.scrollTop + followed.clientHeight >= followed.scrollHeight - 8, "still at the tail after the follow");
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX_PRESENTATION_PORT"
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
