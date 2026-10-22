/**
 * The conversation lifetime across a real browser: a same-conversation reload that re-reads instead of rebuilding, an
 * unknown submission recovered by lookup with no resend, and an answer that arrives while the conversation is off
 * screen and is noticed exactly once.
 *
 * The rules themselves are covered without a browser (`packages/ui/src/lib/conversation-session.test.ts`,
 * `hooks/useAgentSession.lifecycle.test.ts`, `lib/completion-delivery.test.ts`). What only a mounted tree can show is
 * that the production `ChatWindow` keeps its own DOM across a reload, that the production registry and the production
 * session share one stream reader, and that the tone the page reports is the registry's own claim rather than a second
 * completion path.
 *
 * Usage: node apps/web/e2e/chat/ux-conversation-lifetime.ts [--keep]
 *        HEPI_CONVERSATION_LIFETIME_PORT
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_CONVERSATION_LIFETIME_PORT ?? 43171);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-conversation-lifetime-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-conversation-lifetime.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  // The shipped Web build is Vite's, which compiles a `process.env.X` read to a property read off an object literal, so
  // the page never names `process`. A bare esbuild bundle does not, so the fixture states the same shape by hand.
  define: {
    "process.env.NODE_ENV": "\"production\"",
    "process.env.NEXT_PUBLIC_APP_VERSION": "undefined",
    "process.env.NEXT_PUBLIC_PI_VERSION": "undefined",
  },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>conversation lifetime</title></head>",
  "<body><div id=\"root\"></div><script type=\"module\" src=\"./ux-conversation-lifetime.fixture.js\"></script>",
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

const COMPOSER = "textarea[placeholder*=\"Message\"]";

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => (window.__lifetime?.requests ?? []).some((path) => path.includes("/state")), undefined, { timeout: 20000 });

    // --- 1. C5: a same-conversation reload is a read, not a rebuild. ----------------------------------------------
    // The reader's own place in the transcript is the evidence: a rebuilt chat would be a new DOM node and would read
    // the conversation from scratch, so the marker survives only if the surface did.
    await page.evaluate(() => {
      const chat = document.querySelector("[data-chat-scroll]") ?? document.querySelector("textarea[placeholder*=\"Message\"]")?.closest("div");
      if (chat) (chat as HTMLElement).dataset.lifetimeMarker = "kept";
    });
    const readsBefore = await page.evaluate(() => (window.__lifetime?.requests ?? []).filter((path) => path.includes("/state")).length);
    await page.evaluate(() => window.__lifetime!.reload());
    await page.waitForFunction((before) => (window.__lifetime?.requests ?? []).filter((path) => path.includes("/state")).length > before, readsBefore, { timeout: 20000 });
    const reloadRequests = await page.evaluate(() => window.__lifetime!.requests.filter((path) => path.includes("/reload")));
    check(reloadRequests.length === 1, "the reload is the Backend's own reload route, asked once: " + JSON.stringify(reloadRequests));
    check(await page.evaluate(() => document.querySelector("[data-lifetime-marker=\"kept\"]") !== null), "the chat surface is the one already on screen: the reload re-read, it did not rebuild");
    check(await page.evaluate(() => (window.__lifetime?.requests ?? []).some((path) => path.includes("/state"))), "and the read that states the reloaded resources is the conversation's own");

    // --- 2. C3/N8: an unknown submission is recovered by lookup, and nothing is sent twice. -----------------------
    await page.locator(COMPOSER).fill("a turn whose answer never arrived");
    await page.locator(COMPOSER).press("Enter");
    await page.waitForFunction(() => (window.__lifetime?.requests ?? []).some((path) => path.includes("/submissions?")), undefined, { timeout: 20000 });
    const sends = await page.evaluate(() => window.__lifetime!.requests.filter((path) => path.startsWith("POST") && path.includes("/messages")));
    check(sends.length === 1, "the admission was sent once: " + JSON.stringify(sends));
    const lookups = await page.evaluate(() => window.__lifetime!.requests.filter((path) => path.includes("/submissions?")));
    check(lookups.length === 1, "the unknown outcome was resolved by one lookup: " + JSON.stringify(lookups));
    check(await page.evaluate(() => window.__lifetime!.tones.length) === 0, "a lookup is a repair, not a completion: no tone was reported for it");

    // --- 3. C4: the answer arrives while the conversation is off screen, and is noticed once. ---------------------
    // A second turn is admitted and left waiting: that is the work the surface is still waiting for when it leaves, so
    // the projection it hands over is the interest the shell keeps the stream for.
    await page.locator(COMPOSER).fill("a second turn, still in flight");
    await page.locator(COMPOSER).press("Enter");
    await page.waitForFunction(() => (window.__lifetime?.requests ?? []).filter((path) => path.startsWith("POST") && path.includes("/messages")).length === 2, undefined, { timeout: 20000 });
    await page.locator("[data-fixture-show=\"composer\"]").click();
    await page.locator(COMPOSER).waitFor({ timeout: 20000 });
    // The answer arrives with the conversation off screen, on the stream the shell kept for it.
    await page.evaluate(() => window.__lifetime!.emit("conv-a", { type: "submission", sessionId: "conv-a", submission: {
      protocol: "hepi.v1", conversationId: "conv-a", submissionId: "s2", type: "input", status: "done", entryId: "e3", answerId: "a2",
    } }));
    await page.waitForFunction(() => (window.__lifetime?.tones.length ?? 0) > 0, undefined, { timeout: 20000 });
    // A duplicate frame of the same answer is the same notice: the registry has one answer key.
    await page.evaluate(() => window.__lifetime!.emit("conv-a", { type: "submission", sessionId: "conv-a", submission: {
      protocol: "hepi.v1", conversationId: "conv-a", submissionId: "s2", type: "input", status: "done", entryId: "e3", answerId: "a2",
    } }));
    await page.waitForTimeout(200);
    const tones = await page.evaluate(() => window.__lifetime!.tones);
    check(tones.length === 1, "one answer group is one notice: " + JSON.stringify(tones));
    check(tones[0]?.conversationId === "conv-a" && tones[0]?.answerKey === "a2", "and it is the answer's own identity: " + JSON.stringify(tones));

    // --- 4. C4 negative control: a failed or aborted turn is never a completion. ---------------------------------
    await page.evaluate(() => window.__lifetime!.emit("conv-a", { type: "submission", sessionId: "conv-a", submission: {
      protocol: "hepi.v1", conversationId: "conv-a", submissionId: "s3", type: "input", status: "unanswered", reason: "aborted",
    } }));
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__lifetime!.tones.length) === 1, "an aborted run does not sound a success");

    // --- 5. Returning to the conversation keeps the same surface and the stream it already had. ------------------
    await page.locator("[data-fixture-show=\"conversation\"]").click();
    await page.locator(COMPOSER).waitFor({ timeout: 20000 });
    check(await page.evaluate(() => (window.__lifetime?.tones.length ?? 0)) === 1, "coming back does not replay the notice the registry already claimed");
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    assert.ok(true);
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_CONVERSATION_LIFETIME_PORT"
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
