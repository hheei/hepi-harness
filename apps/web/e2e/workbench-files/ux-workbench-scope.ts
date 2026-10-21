/**
 * The connection scope and the router seam, in a real browser.
 *
 * The fixture mounts the real scoped stores and the real client, behind two connections that share a conversation id.
 * What this asserts is the part of the acceptance a Node test cannot hold: the browser's own `sessionStorage`, real
 * blob URLs, and the module-scope stores that live as long as the page does.
 *
 * What it does not do: stand up an ingress or re-implement the conversation slice. Those are held by the Gateway's own
 * tests against a real Backend, and a fixture that mocked them would prove only that the mock works.
 *
 * Usage: node apps/web/e2e/workbench-files/ux-workbench-scope.ts [--keep]
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_WORKBENCH_SCOPE_PORT ?? 43119);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-workbench-scope-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-workbench-scope.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});

const indexHtml = [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>workbench scope</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-workbench-scope.fixture.js\"></script>",
  "</body></html>",
].join("\n");

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  if (name === "index.html") { response.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store" }); response.end(indexHtml); return; }
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
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // The logical query reaches the page the way the host states it: a Web page's search string, and the fragment an
    // App's document carries. Both are the same two parameters to the workbench.
    await page.goto(origin + "/?session=conv&cwd=%2Frepo", { waitUntil: "domcontentloaded" });
    const report = await page.locator("#report[data-state=done]").evaluate(node => JSON.parse(node.textContent), null, { timeout: 30000 });

    // --- 1. The connection's own identity is what scopes the page's state. -------------------------------------
    check(report.scopesDiffer === true, "two profiles on one Backend are two scopes");
    check(report.draftOnA === "unsent on A", "a draft written on one connection reads back on it");
    check(report.viewOnA === "A's history", "and so does a remembered view of the conversation");

    // --- 2. A switch cannot leak the previous connection's state. -----------------------------------------------
    check(report.draftOnB === null, "the second connection has no draft for the same conversation id: " + JSON.stringify(report.draftOnB));
    check(report.viewOnB === null, "and no remembered view of it: " + JSON.stringify(report.viewOnB));
    check(report.draftBackOnA === "unsent on A", "switching back finds the first connection's own draft, not the second's");
    check(typeof report.storageKeys === "number", "the page's own store was written and read: " + report.storageKeys + " keys");

    // --- 3. Resources belong to the connection that loaded them, and disposing one caller closes nothing else. ---
    check(report.imageLoaded === true, "a bounded image becomes a blob lease on the connection that read it");
    check(report.imageResolvesBeforeDispose === true, "the blob URL resolves while its lease is held");
    check(report.imageResolvesAfterDispose === false, "disposing the connection revokes it");
    check(report.disposedClientRefuses === true, "a disposed client refuses later requests instead of using the next connection");
    check(report.otherClientStillWorks === true, "the other connection keeps working: releasing one caller closes no shared stream");
    check(report.otherImageStillResolves === true, "and its own blob is untouched by the other's disposal");

    // --- 4. The logical query is the router's, from whichever address the host has. ------------------------------
    check(report.routeSession === "conv", "the session parameter came from the router location: " + JSON.stringify(report.routeSession));
    check(report.routeCwd === "/repo", "and so did the folder: " + JSON.stringify(report.routeCwd));

    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_WORKBENCH_SCOPE_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await new Promise(done => server.close(done));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("kept build at " + buildDir);
}

console.log(failures.length === 0 ? "PASS (" + "all checks)" : "FAIL (" + failures.length + " check(s))");
process.exit(exitCode);
