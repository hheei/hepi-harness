/**
 * Ticket 07 browser seam: the honest capability three-state, and the read-only project trust surface.
 *
 * Everything is the production component with only its network boundary replaced: the real `ModelsConfig` (whose
 * provider detail asks its own route before offering model import), the real `SettingsPanel` and the real
 * `ProjectTrustDialog`, bundled from source and driven in a real Chromium. No Next build and no backend are needed:
 * the routes these surfaces call are the fixture's, and the assertions are about what the production surfaces rendered
 * and requested.
 *
 * What it asserts:
 *   1. a served capability offers its control, and nothing says it is missing;
 *   2. the deployment's own unsupported reply (501 + `code: "unsupported"`) hides the control and names the limit;
 *   3. a request that never arrived is reported as unconfirmed, never as the deployment's limit, and no control is
 *      offered on a guess;
 *   4. Settings General offers no background-push control and asks no push route: the prototype is retired, because
 *      this deployment has no push backend to deliver a subscription to;
 *   5. the trust dialog lists the folder's declared servers, says where the decision is recorded, and offers exactly
 *      one control — Close — which closes it.
 *
 * Usage: node apps/web/e2e/auth-shell/ux-capability-trust.ts [--keep]
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX07_PORT ?? 43117);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux07-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-capability-trust.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-07</title>",
  "<link rel=\"stylesheet\" href=\"./ux-capability-trust.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-capability-trust.fixture.js\"></script>",
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
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    const detail = page.locator(".config-detail");
    const importButton = page.getByRole("button", { name: /import models/i });
    const detailText = async () => (await detail.innerText()).replace(/\s+/g, " ");

    // --- 1. A served capability offers its control and claims nothing is missing. ---------------------------------
    await importButton.waitFor({ timeout: 15000 });
    check(await importButton.count() === 1, "a served capability offers its control");
    check(!(await detailText()).includes("does not serve this capability"), "and nothing claims the deployment does not serve it: " + JSON.stringify(await detailText()));
    check(!(await detailText()).includes("could not confirm"), "and nothing says the answer is unconfirmed: " + JSON.stringify(await detailText()));

    // --- 2. The deployment's own unsupported reply hides the control and names the limit. -------------------------
    await page.evaluate(() => { window.__uxCapabilityTrust!.setCapabilityAnswer("unsupported"); });
    await page.locator("p", { hasText: "is not served by this deployment" }).first().waitFor({ timeout: 15000 });
    check(await importButton.count() === 0, "the deployment's own unsupported reply offers no control");
    check(!(await detailText()).includes("could not confirm"), "and it is named as the deployment's limit, not as an unconfirmed answer");

    // --- 3. A request that never arrived is unknown, never the deployment's limit. -------------------------------
    await page.evaluate(() => { window.__uxCapabilityTrust!.setCapabilityAnswer("unknown"); });
    await page.locator("p", { hasText: "could not confirm" }).first().waitFor({ timeout: 15000 });
    const unknownText = await detailText();
    check(!unknownText.includes("is not served by this deployment"), "a request that never arrived is not read as the deployment's limit: " + JSON.stringify(unknownText));
    check(await importButton.count() === 0, "and no control is offered on a guess: " + JSON.stringify(unknownText));
    const importReads = await page.evaluate(() => window.__uxCapabilityTrust!.requests.filter((entry) => entry.url.startsWith("/api/models-config/discover")));
    check(importReads.length === 3, "each mount asked the capability's own route exactly once, with no silent retry: " + JSON.stringify(importReads));

    // --- 4. The retired push prototype is gone: no control and no route read. ------------------------------------
    const pushReads = await page.evaluate(() => window.__uxCapabilityTrust!.requests.filter((entry) => entry.url.startsWith("/api/push")));
    check(pushReads.length === 0, "no surface asks a push route this deployment does not serve: " + JSON.stringify(pushReads));
    const generalText = (await page.locator(".settings-general").innerText()).replace(/\s+/g, " ");
    check(!/background push|register push/i.test(generalText), "Settings General offers no background-push control: " + JSON.stringify(generalText));

    // --- 4. The trust dialog is a reader: it lists, it says where, and it offers only Close. ----------------------
    await page.evaluate(() => { window.__uxCapabilityTrust!.openTrustDialog(); });
    const dialog = page.locator(".project-trust-dialog");
    await dialog.waitFor({ timeout: 15000 });
    await dialog.locator(".project-trust-mcp-server-name", { hasText: "repo" }).waitFor({ timeout: 15000 });
    check(true, "the dialog lists the server the folder's .pi/mcp.json declares");
    const dialogText = (await dialog.innerText()).replace(/\s+/g, " ");
    check(/\/trust/.test(dialogText) && /pi CLI/i.test(dialogText), "the dialog says where the decision is recorded, and how: " + JSON.stringify(dialogText));
    const dialogButtons = await dialog.locator("button").allInnerTexts();
    check(dialogButtons.length === 1 && /close/i.test(dialogButtons[0]), "the dialog offers exactly one control, Close: " + JSON.stringify(dialogButtons));
    check(!/trust project/i.test(dialogText), "and offers no control whose write this deployment does not serve");
    const trustRequests = await page.evaluate(() => window.__uxCapabilityTrust!.requests.filter((entry) => entry.url.startsWith("/api/project-trust")));
    check(trustRequests.length === 1 && trustRequests[0].method === "GET", "the dialog only read the decision: " + JSON.stringify(trustRequests));
    await dialog.getByRole("button", { name: /close/i }).click();
    await dialog.waitFor({ state: "detached", timeout: 15000 });
    check(await page.evaluate(() => window.__uxCapabilityTrust!.trustDialogClosed) === true, "Close closes the dialog through its own handler");

    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX07_PORT"
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
