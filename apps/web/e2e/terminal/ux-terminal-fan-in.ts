/**
 * The page's one terminal stream, in a real browser.
 *
 * The Node suites hold the reader's framing, its cursors and its cancellation against a stub fetch, and the Gateway's own
 * suite holds routing, the cookie and the device bearer against a real Backend and a real host. What neither can hold is
 * the browser's own half: that the production panel and the production fan-in open **one** request for two mounted tabs,
 * that the cookie branch lets the browser attach its own cookie while the bearer branch states exactly one header, that a
 * frame reaches only the tab it names, and that releasing the last tab aborts the request instead of leaving a reader
 * behind.
 *
 * The fixture is the real `TerminalPanel`, the real `TerminalFanIn` and the real terminal client; only the ingress is
 * this script's own server, and it answers the routes the panel really asks for.
 *
 * The last case serves the same fixture built against a **development** React, where `StrictMode` really replays the
 * effects, and holds the page to the same one live stream afterwards. A production build cannot make that claim: it does
 * not double-invoke effects, so the replay has to be observed where it happens.
 *
 * Usage: node apps/web/e2e/terminal/ux-terminal-fan-in.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const port = Number(process.env.HEPI_TERMINAL_FAN_IN_PORT ?? 43131);
const bearerToken = "terminal-fixture-bearer";
const cookieName = "hepi-web-token";

let checks = 0;
const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { checks += 1; console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const buildDir = await mkdtemp(join(tmpdir(), "hepi-terminal-fan-in-"));
// The same fixture, built twice: the production bundle the page really ships, and the development one whose
// `StrictMode` replays effects. Nothing else differs between the two cases.
const strictDir = await mkdtemp(join(tmpdir(), "hepi-terminal-fan-in-dev-"));
const { build } = await import("esbuild");
const buildFixture = (outdir: string, mode: "production" | "development") => build({
  entryPoints: [join(here, "ux-terminal-fan-in.fixture.tsx")],
  outdir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  // `conditions` is what makes React resolve its development build: the define alone still bundles the production one,
  // whose StrictMode does not replay effects.
  conditions: mode === "development" ? ["development"] : undefined,
  define: { "process.env.NODE_ENV": JSON.stringify(mode) },
  logLevel: "warning",
});
await buildFixture(buildDir, "production");
await buildFixture(strictDir, "development");
const bundle = await readFile(join(buildDir, "ux-terminal-fan-in.fixture.js"));
const styles = await readFile(join(buildDir, "ux-terminal-fan-in.fixture.css"));
const strictBundle = await readFile(join(strictDir, "ux-terminal-fan-in.fixture.js"));
const strictStyles = await readFile(join(strictDir, "ux-terminal-fan-in.fixture.css"));

/**
 * What the ingress saw: every stream request with the headers and credentials the browser actually sent, and the one
 * event stream it answered. A request that is still open is a reader that still exists, so the close of its response is
 * the fact the cancellation case reads.
 */
interface StreamRecord { url: string; authorization: string | null; cookie: string | null; closed: boolean }
interface CommandRecord { method: string; url: string; body: { type?: string; id?: string; cwd?: string; cols?: number; rows?: number } | undefined }
interface OpenStream { response: ServerResponse; record: StreamRecord; offsets: Map<string, number> }

const streams: StreamRecord[] = [];
const commands: CommandRecord[] = [];
let open: OpenStream | null = null;

/** The stream the fixture is holding open: the one a case writes its own frames into. */
function openStream(): OpenStream {
  assert.ok(open !== null, "a stream is open");
  return open;
}

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const readBody = async (request: IncomingMessage): Promise<CommandRecord["body"]> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (path === "/") {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The Web page's own credential: an HttpOnly cookie the browser attaches by itself, never a header a script sets.
      "set-cookie": cookieName + "=web-session; Path=/; HttpOnly; SameSite=Strict",
    });
    response.end("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>terminal fan-in</title><link rel=\"stylesheet\" href=\"./ux-terminal-fan-in.fixture.css\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"./ux-terminal-fan-in.fixture.js\"></script></body></html>");
    return;
  }
  if (path === "/strict") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    // Absolute paths: a relative one would resolve against "/strict", which is not a directory, and the page would load
    // the production bundle instead.
    response.end("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>terminal fan-in (development React)</title><link rel=\"stylesheet\" href=\"/strict/ux-terminal-fan-in.fixture.css\"></head><body><div id=\"root\"></div><script type=\"module\" src=\"/strict/ux-terminal-fan-in.fixture.js\"></script></body></html>");
    return;
  }
  const asset = path.startsWith("/strict/") ? path.slice("/strict".length) : path;
  if (asset === "/ux-terminal-fan-in.fixture.js" || asset === "/ux-terminal-fan-in.fixture.css") {
    const fromStrict = path.startsWith("/strict/");
    response.writeHead(200, { "content-type": asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "no-store" });
    response.end(asset.endsWith(".js") ? (fromStrict ? strictBundle : bundle) : (fromStrict ? strictStyles : styles));
    return;
  }
  if (path === "/api/terminal/events") {
    const record: StreamRecord = { url: request.url ?? "", authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null, closed: false };
    streams.push(record);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.flushHeaders();
    response.on("close", () => { record.closed = true; });
    open = { response, record, offsets: new Map<string, number>() };
    return;
  }
  if (path.startsWith("/api/terminal")) {
    const body = await readBody(request);
    commands.push({ method: request.method ?? "", url: request.url ?? "", body });
    if (request.method === "DELETE") { json(response, { ok: true }); return; }
    if (body?.type === "input" || body?.type === "resize") { json(response, { ok: true }); return; }
    // Opening or describing a tab: the host answers the folder and the size it really has.
    json(response, { ok: true, id: body?.id, cwd: body?.cwd, cols: body?.cols ?? 80, rows: body?.rows ?? 24 });
    return;
  }
  response.writeHead(404).end("not found");
});
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

/** One frame as the relay writes it: the tab's own session facts, with the session named. */
const output = (id: string, data: string, offset: number, reset?: boolean) => "data: " + JSON.stringify({ type: "output", id, data, offset, ...(reset ? { reset: true } : {}) }) + "\n\n";
const settled = () => new Promise((resolve) => setTimeout(resolve, 250));

/** The streams a reader is still attached to: a request that is over is not one the page holds. */
const live = (): StreamRecord[] => streams.filter((stream) => !stream.closed);

/** The single live stream a case holds the page to, and what it names. */
function liveStream(): StreamRecord {
  assert.equal(live().length, 1, "the page holds one live stream");
  const [stream] = live();
  assert.ok(stream !== undefined, "the live stream");
  return stream;
}
/** Wait for what the browser really did; the deadline only fails the case, it is never the assertion. */
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + label + "; streams: " + JSON.stringify(streams.map((stream) => [stream.url, stream.closed])));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let exitCode = 1;
let browser: Browser | undefined;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true });

  /** A mounted page whose own terminal requests are recorded, and the text each mounted tab shows. */
  async function mount(query: string, prefix = "/"): Promise<{ context: BrowserContext; page: Page; pageErrors: string[]; text: (tab: string) => Promise<string> }> {
    const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + prefix + "?" + query, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__terminalFixture?.mounted() === 2, null, { timeout: 30_000 });
    const text = async (tab: string) => (await page.locator("[data-tab=" + tab + "] .xterm-rows").first().innerText()).replace(/\u00a0/g, " ").trim();
    return { context, page, pageErrors, text };
  }

  // --- 1. The Web page: one stream for two mounted tabs, read with the cookie the browser attaches itself. -----------
  console.log("== the Web page's cookie branch");
  const web = await mount("tabs=tab-a,tab-b&cwd=%2Fworkspace%2Ffixture");
  await settled();

  // A tab that joins an open stream reopens it — the stream names its tabs, and one already running cannot be given
  // another — so what the page holds is exactly one live stream, and it names every mounted tab.
  await waitFor(() => live().length === 1 && live()[0].url.includes("tab-b"), "one live stream naming both tabs");
  check(live().length === 1, "two mounted tabs hold one live stream: " + live().length);
  const webStream = liveStream();
  check(webStream.url.includes("tab-a") && webStream.url.includes("tab-b"), "the live stream names both tabs: " + webStream.url);
  check(webStream.authorization === null, "the cookie branch states no authorization header");
  check((webStream.cookie ?? "").includes(cookieName + "=web-session"), "the browser attached its own HttpOnly cookie");
  check(streams[0].closed === true, "the stream that named only the first tab is over");

  // Each tab's open reached the ingress with its own routing cwd and the size the panel laid out.
  const opened = commands.filter((command) => command.body?.cols !== undefined && command.body?.id !== undefined);
  check(opened.length === 2, "each mounted tab opened its own session: " + opened.length);
  check(opened.every((command) => command.url.includes("cwd=%2Fworkspace%2Ffixture")), "every request names the tab's routing cwd");

  // One frame reaches only the tab it names: the other tab's terminal is not written to.
  openStream().response.write(output("tab-a", "hello-a\r\n", 8));
  await settled();
  const tabA = await web.text("tab-a");
  const tabB = await web.text("tab-b");
  check(tabA.includes("hello-a"), "the frame reached its own tab: " + JSON.stringify(tabA));
  check(!tabB.includes("hello-a"), "and was not written into the other tab: " + JSON.stringify(tabB));

  // A dropped stream is reopened by the page with each tab's own cursor: the first request is over, and the next one
  // names the offset the widget has read rather than the cursor it was first attached with.
  openStream().response.end();
  await waitFor(() => live().length === 1 && live()[0].url.includes("|8"), "the stream reopened from the tab's own cursor");
  check(liveStream().url.includes("tab-a|%2Fworkspace%2Ffixture|8"), "the reopen named the tab's own cursor: " + liveStream().url);
  check(webStream.closed === true, "the dropped request is over");

  // Releasing the last tab aborts the request: the page holds no reader for a stream nothing shows.
  await web.page.evaluate(() => window.__terminalFixture!.close());
  await waitFor(() => live().length === 0, "the last tab's stream to be released");
  check(live().length === 0, "releasing the last tab aborted the stream");
  check(web.pageErrors.length === 0, "no page error occurred: " + web.pageErrors.join(" | "));
  await web.context.close();

  // --- 2. The App: the same one stream, with the device bearer stated once and no cookie jar. ------------------------
  console.log("== the App's device bearer");
  const app = await mount("tabs=tab-a,tab-b&cwd=%2Fworkspace%2Ffixture&credential=bearer&token=" + bearerToken);
  await waitFor(() => live().length === 1 && live()[0].url.includes("tab-b"), "the App's one live stream");
  const appStream = liveStream();
  check(appStream.authorization === "Bearer " + bearerToken, "the bearer branch states its one header: " + appStream.authorization);
  check(appStream.cookie === null, "an App has no cookie jar to present");
  check(!appStream.url.includes(bearerToken), "the credential never travels in the URL: " + appStream.url);

  // The panel's own write presents the same identity its stream was opened with.
  openStream().response.write(output("tab-b", "hello-b\r\n", 8));
  await settled();
  check((await app.text("tab-b")).includes("hello-b"), "the App's tab received its own frame");
  await app.page.evaluate(() => window.__terminalFixture!.close());
  await waitFor(() => live().length === 0, "the App's last tab to release its stream");
  check(appStream.closed === true, "the App's last tab released its stream too");
  check(app.pageErrors.length === 0, "no page error occurred on the App branch: " + app.pageErrors.join(" | "));
  await app.context.close();

  // --- 3. Development React: the replay both hosts' StrictMode roots really perform. -------------------------------
  // A production build does not double-invoke effects, so the case above cannot say anything about a replay. This one
  // serves the same fixture against a development React, where the mount's own effect body really runs twice, and holds
  // the page to the same rule afterwards: the stream that is up is the live one, and a mounted tab is attached to it.
  console.log("== the same page under a development StrictMode replay");
  const replayed = await mount("tabs=tab-a,tab-b&cwd=%2Fworkspace%2Ffixture", "/strict");
  await waitFor(() => replayed.page.evaluate(() => window.__terminalFixture?.effectRuns() ?? 0).then((runs) => runs >= 2), "the development StrictMode replay");
  const runs = await replayed.page.evaluate(() => window.__terminalFixture?.effectRuns() ?? 0);
  check(runs >= 2, "the mount's own effect really was replayed: " + runs + " runs");

  // The replay closed the stream the first pass opened, and the replayed effect must have produced one that is live:
  // a stream the cleanup closed and the memo handed back would leave the page with no attachment at all.
  await waitFor(() => live().length === 1 && live()[0].url.includes("tab-b"), "one live stream after the replay");
  check(live().length === 1, "the replayed page holds exactly one live stream: " + live().length);
  const replayedStream = liveStream();
  check(replayedStream.url.includes("tab-a") && replayedStream.url.includes("tab-b"), "the live stream names both tabs after the replay: " + replayedStream.url);
  check(streams.filter((stream) => stream.closed).length >= 1, "the stream the first pass opened was released by the replay");

  // The attachment is real: a frame still reaches the tab it names.
  openStream().response.write(output("tab-a", "after-replay\r\n", 8));
  await settled();
  check((await replayed.text("tab-a")).includes("after-replay"), "a frame reached its tab after the replay");
  await replayed.page.evaluate(() => window.__terminalFixture?.close());
  await waitFor(() => live().length === 0, "the replayed page's last tab to release its stream");
  check(replayedStream.closed === true, "releasing the last tab released the replayed page's stream");
  check(replayed.pageErrors.length === 0, "no page error occurred under the development replay: " + replayed.pageErrors.join(" | "));
  await replayed.context.close();

  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_TERMINAL_FAN_IN_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
  await rm(buildDir, { recursive: true, force: true });
  await rm(strictDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "PASS (" + checks + " checks)" : "FAIL (" + failures.length + " of " + (checks + failures.length) + " checks)");
process.exit(exitCode);
