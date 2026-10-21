/**
 * The conversation lifetime in the production shell, driven in Chromium.
 *
 * The sibling `ux-conversation-lifetime.ts` drives `ChatWindow` with a registry the page states; this drives the
 * production `AppShell` — the registry, the selection, the Settings panel and the chat's reload registration — because
 * two of the rules are the shell's own and cannot be stated from the chat alone:
 *
 * - a connection switch rebuilds the shell's registry over the new client, so the replaced connection's watches are
 *   released rather than left attached to a scope nothing shows;
 * - Settings › General asks the conversation's own reload exactly once, however many surfaces wanted the change.
 *
 * What is asserted is what the real components do with the Backend's answers: the routes the shell actually asked for,
 * the stream each connection holds, and the notice the surface is left with.
 *
 * Usage: node apps/web/e2e/chat/ux-conversation-lifetime-shell.ts [--keep]
 *        HEPI_CONVERSATION_LIFETIME_SHELL_PORT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_CONVERSATION_LIFETIME_SHELL_PORT ?? 43172);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-conversation-lifetime-shell-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-conversation-lifetime-shell.fixture.tsx")],
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
  loader: { ".css": "css" },
});
// The page's own stylesheet, stated here rather than imported: the scene ships no compiled Tailwind, so the two rules
// the shell needs to be laid out at a desktop viewport are restated — the phone drawer's backdrop, which the product
// hides by media query, and the sidebar's own container.
await writeFile(join(buildDir, "ux-conversation-lifetime-shell.fixture.page.css"), [
  ".sidebar-overlay-backdrop { display: none !important; }",
  ".sidebar-container { position: relative; overflow: hidden; display: flex; flex-direction: column; }",
  "html, body, #root { height: 100%; margin: 0; }",
  "body { font: 14px/1.4 system-ui, sans-serif; }",
].join("\n"));
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>conversation lifetime in the shell</title>",
  "<link rel=\"stylesheet\" href=\"./ux-conversation-lifetime-shell.fixture.page.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-conversation-lifetime-shell.fixture.js\"></script>",
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
/** The one conversation this scene is about: the address opens it, and both connections hold the same id. */
const CONVERSATION = "shell-conv";

/** The Backend routes this page answered, as `METHOD path`. */
async function routes(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).map((request) => request.method + " " + request.path));
}

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    // A desktop viewport, as the scene is written: the phone drawer's backdrop is what a narrow one adds, and the
    // scene's own stylesheet hides it for the same reason the product's media query does.
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    // The shell opens the conversation the address names, so the whole scene is about that conversation.
    await page.goto(origin + "/?session=shell-conv", { waitUntil: "domcontentloaded" });
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => (window.__lifetimeShell?.requests ?? []).some((request) => request.path.startsWith("/api/conversations/shell-conv/state")), undefined, { timeout: 20000 });

    // --- 1. Settings › General asks the conversation's own reload exactly once. -----------------------------------
    // The reviewer's finding: Settings awaited the Backend's route and then asked the chat's registered reload, which
    // asked it again. The ordinary workflow is one toggle, and what follows is one reload route and one read.
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.locator(".settings-general-title").waitFor({ timeout: 20000 });
    const reloadRoutesBefore = await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.endsWith("/reload")).length);
    await page.getByRole("switch", { name: /powershell/i }).click();
    await page.waitForFunction((before) => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.endsWith("/reload")).length > before, reloadRoutesBefore, { timeout: 20000 });
    const reloadRoutes = await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.endsWith("/reload")));
    check(reloadRoutes.length === 1, "the Backend's reload route was asked once: " + JSON.stringify(reloadRoutes));
    // The read that states the reloaded resources is the conversation's own, and it follows the reload.
    const ordered = await routes(page);
    const reloadAt = ordered.findIndex((route) => route.endsWith("/reload"));
    check(reloadAt >= 0 && ordered.slice(reloadAt).some((route) => route.includes("/api/conversations/shell-conv/state")),
      "and the read that follows it is this conversation's own: " + JSON.stringify(ordered.slice(reloadAt, reloadAt + 4)));
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    // Close Settings so the conversation's own surface is what the next scene addresses.
    await page.keyboard.press("Escape");

    // --- 2. A connection that keeps its scope does not remount the shell, and its registry is rebuilt. ------------
    // The I18nProvider above the shell is keyed by the connection's **scope**, so a different scope remounts the tree and
    // rebuilds everything in it — a remount is exactly what made a once-initialized registry look correct. A connection
    // that keeps its scope replaces the provider value only: the same shell renders again inside it, and the registry it
    // was holding belongs to the client that was just replaced.
    await page.evaluate(() => {
      const chat = document.querySelector("[data-chat-scroll]") ?? document.querySelector("textarea[placeholder*=\"Message\"]")?.closest("div");
      if (chat) (chat as HTMLElement).dataset.shellMarker = "survived";
    });
    const reloadsBeforeSwitch = await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.endsWith("/reload")).length);
    // Which connection holds the conversation's stream before the switch. The shell joined it through the first
    // connection's client, so that is the source a frame has to travel through to reach the chat right now.
    const streamsBefore = await page.evaluate(() => window.__lifetimeShell?.openStreams ?? []);
    check(JSON.stringify(streamsBefore) === JSON.stringify(["first:" + CONVERSATION]),
      "the first connection holds this conversation's stream: " + JSON.stringify(streamsBefore));

    await page.evaluate(() => window.__lifetimeShell?.replaceConnection(true));
    // The shell is still the same tree — the marker is the evidence — and the conversation is read again through the new
    // connection, because a conversation id in another connection is another conversation.
    await page.waitForFunction((before) => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.startsWith("/api/conversations/shell-conv/state")).length > before,
      await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.startsWith("/api/conversations/shell-conv/state")).length), { timeout: 20000 });
    check(await page.evaluate(() => document.querySelector("[data-shell-marker=\"survived\"]") !== null),
      "a connection that keeps its scope does not remount the shell: the same tree is still on screen");
    check(await page.evaluate(() => (window.__lifetimeShell?.requests ?? []).filter((request) => request.path.endsWith("/reload")).length) === reloadsBeforeSwitch,
      "and the switch is not a reload: nothing asked the Backend's reload route for it");

    // The registry itself, not a count of it. The replaced connection's source is released, and the new connection's
    // source for the same conversation is what the shell now holds — the two facts the production registry replacement
    // is made of. A registry that survived the switch would leave the first source open and never open the second, so
    // these two assertions fail if the guard in AppShell is disabled.
    await page.waitForFunction(() => (window.__lifetimeShell?.openStreams ?? []).includes("replaced:" + "shell-conv"), undefined, { timeout: 20000 });
    const streamsAfter = await page.evaluate(() => window.__lifetimeShell?.openStreams ?? []);
    const everyStream = await page.evaluate(() => window.__lifetimeShell?.streams ?? []);
    check(JSON.stringify(streamsAfter) === JSON.stringify(["replaced:" + CONVERSATION]),
      "the replaced connection's watch was released and the new connection holds the same conversation: " + JSON.stringify(streamsAfter));
    check(everyStream.includes("first:" + CONVERSATION + ":closed"),
      "the outgoing source was closed, not merely forgotten: " + JSON.stringify(everyStream));

    // And the new source is the one the chat is actually reading, proven by delivering a frame through it. The frame
    // states a window the production chat has never seen; the only way its text reaches the transcript is the shell
    // having subscribed this connection's source to this surface.
    await page.evaluate(() => window.__lifetimeShell?.emitOn("replaced", "shell-conv", {
      type: "frame", sessionId: "shell-conv", event: "state",
      data: {
        protocol: "hepi.v1", revision: 7, conversationId: "shell-conv", projectionId: "P-shell-conv",
        historyRevision: "rev-1", historyHead: "h-1", hasMore: false, oldestEntryId: null,
        run: null, busy: false,
        entries: [{
          id: "e7", role: "assistant", text: "a frame from the replacement connection",
          message: { role: "assistant", content: [{ type: "text", text: "a frame from the replacement connection" }] },
        }],
        partial: "", toolNames: [], extensions: [], liveTools: [],
        settings: { model: null, thinkingLevel: "off" },
        queuedMessages: { steering: [], followUp: [] }, queuedItems: [],
        control: { state: "allowed", revision: 0 }, failure: null, submissions: [],
      },
    }));
    await page.waitForFunction(() => document.body.textContent?.includes("a frame from the replacement connection") === true, undefined, { timeout: 20000 });
    check(await page.evaluate(() => document.body.textContent?.includes("a frame from the replacement connection") === true),
      "and the replacement connection's own stream delivers frames into the chat");
    check(pageErrors.length === 0, "no page error occurred across the switch" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));

    // --- 3. A different scope remounts the tree, and the shell is whole again. ------------------------------------
    await page.evaluate(() => window.__lifetimeShell?.replaceConnection(false));
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => (window.__lifetimeShell?.requests ?? []).some((request) => request.path.startsWith("/api/conversations/shell-conv/state")), undefined, { timeout: 20000 });
    check(await page.evaluate(() => document.querySelector("[data-shell-marker=\"survived\"]") === null),
      "a different scope is a different tree: the shell was remounted, not re-rendered");
    check(pageErrors.length === 0, "and no page error occurred across the remount" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));

    await browser.close();
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_CONVERSATION_LIFETIME_SHELL_PORT"
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
