/**
 * Ticket 06 browser seam: the sidebar, the New Project dialog and the folder picker ask the connection's own origin with
 * the connection's own credential.
 *
 * Everything is the production surface — the real `SessionSidebar` (its catalogue read, its running poll, its shared
 * sidebar document and its project/workspace listings), the real `NewProjectDialog` and the real `DirectoryPicker` —
 * behind one real `createClient` configured with an ingress origin that is not this document's and one device bearer.
 * No ingress and no backend are needed: the client's own transport is the fixture's, and the assertions are about what
 * the production surfaces asked for and which credential they presented.
 *
 * What it asserts:
 *   1. the catalogue row is projected into the Project's group, so the sidebar really read the Backend's own answer;
 *   2. the sidebar's project, workspace and shared-document reads resolve against the configured ingress origin;
 *   3. a pin write goes through the connection as `POST /api/sidebar-state`;
 *   4. the New Project dialog and the folder picker browse `/api/host/directories` through the connection;
 *   5. the retired Next BFF vocabulary (`/api/home`, `/api/default-cwd`, `/api/open-in-explorer`,
 *      `/api/sessions/ui-state`, `/api/cwd/*`, `GET /api/worktrees?cwd=`) is never asked;
 *   6. every request presented the connection's bearer, and none reached the page's own origin.
 *
 * Usage: node apps/web/e2e/ux-sidebar-ingress.mjs [--keep]
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_SIDEBAR_INGRESS_PORT ?? 43135);

const INGRESS_ORIGIN = "https://ingress.example:9443";
const BEARER = "sidebar-ingress-device-bearer";

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-sidebar-ingress-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-sidebar-ingress.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>sidebar ingress</title>",
  "<link rel=\"stylesheet\" href=\"./ux-sidebar-ingress.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-sidebar-ingress.fixture.js\"></script>",
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

    const connection = async () => await page.evaluate(() => window.__uxSidebarIngress.connection);
    const setView = async (view) => { await page.evaluate((next) => window.__uxSidebarIngress.setView(next), view); };
    const waitForPath = async (path, method) => {
      await page.waitForFunction(
        ([wanted, verb]) => window.__uxSidebarIngress.connection.some((entry) => entry.url.startsWith(window.__uxSidebarIngress.origin + wanted) && (verb === null || entry.method === verb)),
        [path, method ?? null],
        { timeout: 30000 },
      );
    };

    // --- 1. The catalogue row is projected into the Project's group. -----------------------------------------
    await page.locator(".session-tree-group", { hasText: "Downloads" }).waitFor({ timeout: 30000 });
    check(true, "the sidebar shows the Project group the Backend's catalogue row stated");
    await waitForPath("/api/conversations", "GET");
    await waitForPath("/api/projects", "GET");
    await waitForPath("/api/workspaces", "GET");
    await waitForPath("/api/sidebar-state", "GET");

    // --- 2. A pin writes the sidebar document through the connection. ----------------------------------------
    await page.locator(".fixture-pin").click();
    await waitForPath("/api/sidebar-state", "POST");
    const pin = (await connection()).find((entry) => entry.method === "POST" && entry.url === INGRESS_ORIGIN + "/api/sidebar-state");
    check(pin !== undefined, "a pin writes through the connection");
    check(pin !== undefined && JSON.parse(pin.body).action === "set" && JSON.parse(pin.body).pinned === true, "the write carries the pin request: " + pin?.body);
    // The write's own answer is what the sidebar keeps: its revision is the one only the Backend's answer carries, so
    // an optimistic frame that has not settled yet is told apart from an adopted answer.
    await page.waitForFunction(() => window.__uxSidebarIngress.state().revision === 4, undefined, { timeout: 30000 });
    const pinned = await page.evaluate(() => window.__uxSidebarIngress.state());
    check(typeof pinned.sessions["conversation-1"]?.pinnedAt === "number", "the write's own answer became the sidebar's state: " + JSON.stringify(pinned.sessions));

    // --- 3. The folder picker browses the host's own directories through the connection. ----------------------
    await setView("directory");
    await page.locator(".directory-picker-entry", { hasText: "projects" }).waitFor({ timeout: 30000 });
    const browse = (await connection()).find((entry) => entry.url.startsWith(INGRESS_ORIGIN + "/api/host/directories"));
    check(browse !== undefined, "the folder picker browses through the connection");
    check(browse !== undefined && new URL(browse.url).searchParams.get("path") === "/home/operator", "the browse names the path it was asked for: " + browse?.url);
    check(browse !== undefined && new URL(browse.url).searchParams.get("hostId") === null, "a local browse names no host: the deployment states it: " + browse?.url);

    // --- 4. The New Project dialog reads its targets and its host's account through the connection. -----------
    await setView("new-project");
    await page.locator(".new-project-panel").waitFor({ timeout: 30000 });
    await waitForPath("/api/hosts", "GET");
    await page.locator(".new-project-host").filter({ hasText: "operator" }).waitFor({ timeout: 30000 });
    check(true, "the dialog names the account the host reported");
    const newProjectBrowse = (await connection()).filter((entry) => entry.url.startsWith(INGRESS_ORIGIN + "/api/host/directories"));
    check(newProjectBrowse.length >= 2, "the dialog browsed through the same connection: " + newProjectBrowse.length);

    // --- 5. The retired Next BFF vocabulary was never asked. -------------------------------------------------
    const all = await connection();
    const retired = all.filter((entry) => {
      const path = entry.url.slice(INGRESS_ORIGIN.length).split("?")[0];
      return path === "/api/home" || path === "/api/default-cwd" || path === "/api/open-in-explorer"
        || path === "/api/sessions/ui-state" || path.startsWith("/api/cwd/")
        || (path === "/api/worktrees" && entry.method === "GET");
    });
    check(retired.length === 0, "the retired Next BFF vocabulary was never asked: " + JSON.stringify(retired.map((entry) => entry.method + " " + entry.url)));

    // --- 6. Every request went to the connection's origin with the connection's credential. ------------------
    check(all.length > 0, "the surfaces made requests to assert on: " + all.length);
    check(all.every((entry) => entry.url.startsWith(INGRESS_ORIGIN + "/")), "every request resolved against the configured ingress origin, never the page's: " + JSON.stringify(all.filter((entry) => !entry.url.startsWith(INGRESS_ORIGIN + "/")).map((entry) => entry.url)));
    check(all.every((entry) => entry.authorization === "Bearer " + BEARER), "every request presented the connection's own bearer: " + JSON.stringify([...new Set(all.map((entry) => entry.authorization))]));
    check(all.every((entry) => entry.credentials === "same-origin"), "every request kept the browser's own cookie policy: " + JSON.stringify([...new Set(all.map((entry) => entry.credentials))]));

    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_SIDEBAR_INGRESS_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("build kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
