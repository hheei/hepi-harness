/**
 * Browser regression for UX ticket 10: the builtin Skills panel must keep showing the execution target the sidebar
 * has selected, even when an earlier target's inventory answer arrives after it.
 *
 * Switching execution host, pressing Refresh, and an operation's own refresh can all have an inventory read in
 * flight at once, and the slowest answer is not necessarily the one asked for last. Before the fix, any answer
 * published, so a late answer for the previous host replaced the current host's skills - and with them the selected
 * detail, hiding an operation outcome that was still true. The failure looked like a flaky smoke test because the
 * outcome notice is what the browser assertions wait for.
 *
 * The fixture mounts the production SkillsConfig in StrictMode, as both hosts do, and replaces only its network
 * boundary, window.fetch. Every inventory answer is held until the driver releases it, so the interleaving is exact
 * rather than timed. Two orders are driven: the first host's answer arriving *after* the selected host's, and — the
 * case a request counter would still get wrong — the first host's answer arriving *before* it, which must neither
 * publish the old host's skills nor end the selected host's loading state. Every wait is an observable DOM or delivery
 * condition, and the assertions are read from rendered DOM.
 *
 * Usage: node apps/web/e2e/ux-skills-inventory-race.mjs [--keep]
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
const port = Number(process.env.HEPI_UX10_PORT ?? 43110);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux10-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-skills-inventory-race.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-10</title>",
  "<link rel=\"stylesheet\" href=\"./ux-skills-inventory-race.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-skills-inventory-race.fixture.js\"></script>",
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

    const hostRow = (label) => page.locator(".config-sidebar .config-sidebar-item", { hasText: label }).first();
    const skillRows = () => page.locator(".config-sidebar-list .config-sidebar-item");

    // Every inventory read is held, so both hosts are still unanswered when the driver selects the second one.
    await hostRow("beta").waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(() => window.__ux10.held.some((entry) => entry.workspaceId === "alpha"), undefined, { timeout: 15000 });
    await hostRow("beta").click();
    await page.waitForFunction(() => window.__ux10.held.some((entry) => entry.workspaceId === "beta"), undefined, { timeout: 15000 });

    // The StrictMode replay disposed the target the first mount selected. A panel that kept reading through the retired
    // instance would now be showing a refusal instead of the selected host's loading state.
    check(await page.locator(".config-sidebar-list .config-sidebar-message").innerText() === "Loading...", "the replayed mount is still loading the selected host, not refusing its retired target");
    check(await page.locator(".config-sidebar-message.is-error").count() === 0, "the replay reported no failure");

    // Order one: the host the panel has left answers first, while the selected host is still loading. Its answer must
    // neither publish its skills nor end the selected host's loading state.
    await page.evaluate(() => { for (const entry of window.__ux10.held) if (entry.workspaceId === "alpha") entry.release(); });
    await page.waitForTimeout(250);
    const whileLoading = await page.locator(".config-sidebar-list .config-sidebar-message").innerText();
    check(whileLoading === "Loading...", "the previous host's answer did not end the selected host's loading state: " + JSON.stringify(whileLoading));
    check((await skillRows().count()) === 0, "the previous host's answer published no skills under the selected host");

    // Order two: the selected host answers.
    await page.evaluate(() => { for (const entry of window.__ux10.held) if (entry.workspaceId === "beta") entry.release(); });
    await page.locator(".config-sidebar-list .config-sidebar-item", { hasText: "beta-skill" }).first().waitFor({ timeout: 15000 });
    const listed = await skillRows().allInnerTexts();
    check(listed.length === 1 && listed[0].trim() === "beta-skill", "the selected host's own skill is listed: " + JSON.stringify(listed));

    // And once more after the selected host has answered, so a late answer cannot replace a list that is already right.
    await page.evaluate(() => { for (const entry of window.__ux10.held) if (entry.workspaceId === "alpha") entry.release(); });
    await page.waitForTimeout(250);
    const rendered = await skillRows().allInnerTexts();
    check(rendered.length === 1 && rendered[0].trim() === "beta-skill", "a late answer for the previous host did not replace the selected host's skills: " + JSON.stringify(rendered));
    // The host rows are the sidebar's first group, before any installed-skill rows: only the selected host may carry
    // aria-current there.
    const currentHosts = await page.locator(".config-sidebar .config-sidebar-group").first().locator(".config-sidebar-item[aria-current=\"page\"]").allInnerTexts();
    check(currentHosts.length === 1 && currentHosts[0].includes("beta"), "the sidebar still shows the second host as the selected execution target: " + JSON.stringify(currentHosts));
    check(await page.locator(".config-sidebar-message.is-error").count() === 0, "no answer reported an error for the host that is selected");
    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX10_PORT"
    : "the regression threw: " + (error instanceof Error ? error.message : String(error));
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
process.exit(failures.length === 0 ? 0 : 1);
