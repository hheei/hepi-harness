/**
 * Browser regression for the rail's history scope: a compaction while the outline is open.
 *
 * The bug this holds: the outline was read once per conversation, so a compaction that moved the conversation's head
 * marker left the rail listing anchors of the history it had replaced. Every one of them was then refused by the
 * coordinator's own fence as `stale-snapshot`, retry included — the reader's rail looked like a history that could
 * never be reached, and only a manual re-read of the whole outline recovered it.
 *
 * The fixture mounts the production `useHistoryNavigation` over a `ConversationApi` this driver controls. Four facts are
 * asserted, each one a behaviour of the hook rather than of the fixture:
 *
 *  1. an append does not re-read the outline (a turn arriving is not a re-baseline);
 *  2. a compaction re-reads it once, from its first page;
 *  3. a page that answers late, describing the replaced history, is dropped instead of listed;
 *  4. a jump made after the refresh is addressed over the scope the conversation states now, so it lands instead of
 *     failing `stale-snapshot` forever.
 *
 * Usage: node apps/web/e2e/ux-history-scope.mjs [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_HISTORY_SCOPE_PORT ?? 43124);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-history-scope-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-history-scope.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>history-scope</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-history-scope.fixture.js\"></script>",
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
    await page.waitForFunction(() => window.__scope !== undefined, undefined, { timeout: 20000 });
    const state = () => page.evaluate(() => window.__scope.state());
    const scopes = () => page.evaluate(() => window.__scope.outlineScopes());
    const reads = () => page.evaluate(() => window.__scope.targetReads());

    await page.waitForFunction(() => window.__scope.state().anchors.length === 1, undefined, { timeout: 20000 });
    check((await state()).scope === "77|head1", "the rail's first page is read under the conversation's own scope");
    const firstReads = (await scopes()).length;

    console.log("== an append does not re-page the outline");
    await page.evaluate(() => window.__scope.append());
    await page.waitForFunction(() => window.__scope.state().revision === "77|head1|99", undefined, { timeout: 20000 });
    // Nothing is awaited beyond the state itself: the rule under test is that no read follows, so a read that arrives
    // late would be a failure the check below catches.
    await page.waitForTimeout(250);
    check((await scopes()).length === firstReads, "a turn arriving asked for no page (" + (await scopes()).length + " reads)");
    check((await state()).anchors.length === 1, "and the anchors the rail held are still listed");

    console.log("== a compaction re-reads the outline, from its first page");
    await page.evaluate(() => window.__scope.compact());
    await page.waitForFunction(() => window.__scope.outlineScopes().length > 1, undefined, { timeout: 20000 });
    const afterCompaction = await scopes();
    check(afterCompaction.at(-1) === "77|head2", "the re-read is addressed over the scope the conversation states now");
    check((await state()).loading === true, "and the rail says it is reading rather than showing a list it cannot reach");

    console.log("== a page that answers late, describing the replaced history, is dropped");
    await page.evaluate(() => window.__scope.answerLate());
    // The dropped page is not listed, and the re-read that belongs to the new history is what the rail ends up holding.
    await page.waitForFunction(() => window.__scope.state().anchors.length === 1 && window.__scope.state().scope === "77|head2", undefined, { timeout: 20000 });
    const settled = await state();
    check(settled.scope === "77|head2", "the list the rail holds is the history the conversation states: " + JSON.stringify(settled.scope));
    check(settled.anchors.length === 1 && settled.anchors[0] === "20", "with the anchor of that history, not of the replaced one: " + JSON.stringify(settled.anchors));

    console.log("== a jump after the refresh lands instead of failing stale-snapshot forever");
    await page.evaluate(() => window.__scope.jump());
    await page.waitForFunction(() => window.__scope.state().landed === 1, undefined, { timeout: 20000 });
    const afterJump = await state();
    check(afterJump.failure === null, "the jump settled as a landing, not as a failure: " + JSON.stringify(afterJump.failure));
    check((await reads()).length === 1, "and it cost exactly one target read (" + (await reads()).length + ")");
    check((await reads())[0].includes("77%7Chead2"), "addressed over the scope the conversation states: " + (await reads())[0]);
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_HISTORY_SCOPE_PORT"
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
