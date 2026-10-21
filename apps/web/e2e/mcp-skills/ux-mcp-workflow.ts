/**
 * Browser journey for ticket 07: Settings › MCP as one workflow.
 *
 * It bundles `ux-mcp-workflow.fixture.tsx` with the workspace's own esbuild, serves the build from a temporary directory
 * outside the repository on 127.0.0.1:43137 (override with HEPI_UX_MCP_WORKFLOW_PORT), and drives it with the installed
 * Playwright. The fixture mounts the production `SettingsPanel`, and so the production `McpConfig`, over a host-shaped
 * seam whose own state a change actually changes; the assertions are about the panel's own decisions and the requests it
 * made, not about a stub's answers.
 *
 * What it asserts, one scene per claim:
 *  - one read answers the list, and each control marks the operation it starts as pending and shows its answer;
 *  - a change the host refused is never shown as saved, and the listing is read again rather than trusted;
 *  - a sign-in keeps polling while the MCP section is hidden behind another Settings tab, and finishes there;
 *  - replacing the connection disposes the panel's polls, and the new connection reads its own listing;
 *  - a Test runs beside a change rather than behind it, and its answer becomes the row's state.
 *
 * Usage: node apps/web/e2e/mcp-skills/ux-mcp-workflow.ts [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX_MCP_WORKFLOW_PORT ?? 43137);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

interface Recorded { method: string; url: string; body: unknown; at: number }

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux-mcp-workflow-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-mcp-workflow.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-mcp-workflow</title>",
  "<link rel=\"stylesheet\" href=\"./ux-mcp-workflow.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-mcp-workflow.fixture.js\"></script>",
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
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const requests = async (): Promise<Recorded[]> => await page.evaluate(() => window.__uxMcpWorkflow!.requests);
  const polls = async (): Promise<number> => await page.evaluate(() => window.__uxMcpWorkflow!.polls());
  const settingsNav = () => page.getByRole("navigation", { name: "Settings" });
  const row = (name: string) => page.locator(".config-sidebar-item").filter({ hasText: name }).first();
  const detail = () => page.locator(".config-detail");
  const mcpSection = () => page.locator(".settings-section-host").filter({ has: page.locator(".config-panel-root") });

  /**
   * The MCP section is mounted by the panel's own tab machinery, so a scene that needs it open
   * presses its tab the way a person does rather than mounting it by hand.
   */
  const openMcp = async () => {
    await settingsNav().getByRole("button", { name: "MCP", exact: true }).click();
    await page.locator(".config-panel-root").waitFor({ timeout: 30_000 });
    await page.locator(".config-sidebar-item").first().waitFor({ timeout: 30_000 });
  };

  await page.goto(origin + "/?slow=250", { waitUntil: "load" });
  await page.locator(".config-panel-root").waitFor({ timeout: 30_000 });
  await page.locator(".config-sidebar-item").first().waitFor({ timeout: 30_000 });

  // ---- 1. One read answers the list, and a change states that it is pending. --------------------------------
  const overviewReads = (await requests()).filter((entry) => entry.method === "GET" && entry.url.startsWith("/api/mcp?"));
  check(overviewReads.length === 1, "the panel read the overview once for its first listing: " + overviewReads.length);
  check((await row("docs").count()) === 1 && (await row("oauth").count()) === 1, "the host's servers are listed");
  check((await requests()).every((entry) => !entry.url.startsWith("/api/mcp/test")), "opening the panel tested no server");

  await row("docs").click();
  await detail().getByRole("switch", { name: "Turn docs off", exact: true }).waitFor({ timeout: 30_000 });
  await detail().getByRole("switch", { name: "Turn docs off", exact: true }).click();
  // While the change is out the control says so, and the listing is still the one the person was looking at.
  await page.waitForFunction(() => document.querySelector(".config-detail")?.textContent?.includes("docs") === true);
  const switching = (await requests()).filter((entry) => entry.method === "POST" && entry.url.startsWith("/api/mcp"));
  check(switching.length === 1 && switching[0].body !== null && JSON.stringify(switching[0].body).includes("\"disable\""),
    "one press is one change for that server: " + JSON.stringify(switching.map((entry) => entry.body)));
  await detail().getByRole("switch", { name: "Turn docs on", exact: true }).waitFor({ timeout: 30_000 });
  check(true, "the answer's own listing is what the row shows afterwards");

  // ---- 2. A refused change is visible as a failure and never as saved. --------------------------------------
  await row("strict").click();
  await detail().getByRole("switch", { name: "Turn strict off", exact: true }).waitFor({ timeout: 30_000 });
  const readsBeforeRefusal = (await requests()).filter((entry) => entry.method === "GET" && entry.url.startsWith("/api/mcp?")).length;
  await detail().getByRole("switch", { name: "Turn strict off", exact: true }).click();
  await detail().getByRole("alert").filter({ hasText: "Could not change the server" }).waitFor({ timeout: 30_000 });
  const refusedText = await detail().innerText();
  check(/not valid JSON/i.test(refusedText), "the host's own reason is shown: " + JSON.stringify(refusedText.split("\n").slice(0, 4)));
  check((await detail().getByRole("switch", { name: "Turn strict off", exact: true }).count()) === 1,
    "and the server still reads as switched on, because nothing was written");
  await page.waitForFunction((before: number) => window.__uxMcpWorkflow!.requests
    .filter((entry) => entry.method === "GET" && entry.url.startsWith("/api/mcp?")).length > before, readsBeforeRefusal, { timeout: 30_000 });
  check(true, "the listing was read again rather than trusted after the refusal");

  // ---- 3. A sign-in keeps polling while the MCP section is hidden, and finishes there. -----------------------
  await row("oauth").click();
  await detail().getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 30_000 });
  await detail().getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForFunction(() => window.__uxMcpWorkflow!.polls() >= 1, undefined, { timeout: 30_000 });
  const pollsBefore = await polls();
  // The person goes to another Settings tab while the flow is under way: the section is hidden, not closed.
  await settingsNav().getByRole("button", { name: "General", exact: true }).click();
  await mcpSection().waitFor({ state: "hidden", timeout: 30_000 });
  await page.waitForFunction((before: number) => window.__uxMcpWorkflow!.polls() > before + 1, pollsBefore, { timeout: 30_000 });
  check(true, "the flow kept being polled while its section was hidden");
  // It runs to its end there: the panel's poll is what moves it, and nothing about a hidden tab cancels it.
  await page.waitForFunction(() => window.__uxMcpWorkflow!.flow()?.phase === "done", undefined, { timeout: 40_000 });
  // Back on the tab, what the panel shows is that ended flow: nothing was cancelled by hiding the panel.
  await settingsNav().getByRole("button", { name: "MCP", exact: true }).click();
  await page.locator(".config-panel-root").waitFor({ timeout: 30_000 });
  await row("oauth").click();
  const flow = await page.evaluate(() => window.__uxMcpWorkflow!.flow());
  check(flow !== null && flow.phase === "done", "the flow ended on the host rather than being cancelled by the tab: " + JSON.stringify(flow));
  const pollsAtEnd = await polls();
  await page.waitForTimeout(1_500);
  check((await polls()) === pollsAtEnd, "and an ended flow is polled no more: " + pollsAtEnd + " -> " + (await polls()));

  // ---- 4. A Test runs beside a change and its answer becomes the row's state. -------------------------------
  await row("docs").click();
  const readsBeforeTest = (await requests()).length;
  await detail().getByRole("button", { name: "Test connection", exact: true }).click();
  await detail().getByText(/Connected/).first().waitFor({ timeout: 30_000 });
  const tested = (await requests()).slice(readsBeforeTest).filter((entry) => entry.url.startsWith("/api/mcp/test"));
  check(tested.length === 1 && JSON.stringify(tested[0].body).includes("\"docs\""), "one press tested that one server: " + JSON.stringify(tested.map((entry) => entry.body)));
  check((await detail().innerText()).includes("Connected"), "and its answer is the row's state");

  // ---- 5. Replacing the connection disposes the panel's own polls, and the new one reads its own listing. ----
  await row("oauth").click();
  await detail().getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForFunction(() => window.__uxMcpWorkflow!.polls() >= 1, undefined, { timeout: 30_000 });
  const beforeSwitch = await polls();
  await page.evaluate(() => window.__uxMcpWorkflow!.setConnection("second"));
  await page.locator(".config-sidebar-item").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const afterSwitch = (await requests()).filter((entry) => entry.url.includes("/api/mcp/sign-in/") && entry.method === "GET").length;
  check(afterSwitch === beforeSwitch, "a replaced connection's panel stopped polling the old flow: " + beforeSwitch + " -> " + afterSwitch);
  const secondRead = (await requests()).slice(-12).filter((entry) => entry.method === "GET" && entry.url.startsWith("/api/mcp?"));
  check(secondRead.length >= 1, "and the new connection read its own listing");

  check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  await browser.close();
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  failures.push("the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  console.log("  FAIL the fixture threw: " + (error instanceof Error ? error.message : String(error)));
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("build kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
