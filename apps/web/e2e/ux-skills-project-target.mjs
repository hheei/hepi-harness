/**
 * Browser regression for UX ticket 11: a Project-scope skill operation lands on the project's own default folder, and
 * names no conversation when the session that asked is bound to another folder of that same project.
 *
 * Usage: node apps/web/e2e/ux-skills-project-target.mjs [--keep]
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
const port = Number(process.env.HEPI_UX11_PORT ?? 43111);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux11-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-skills-project-target.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-11</title>",
  "<link rel=\"stylesheet\" href=\"./ux-skills-project-target.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-skills-project-target.fixture.js\"></script>",
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
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: "load" });
  await page.getByText("notes", { exact: true }).first().waitFor({ timeout: 30000 });
  const requests = async () => await page.evaluate(() => window.__ux11.requests);

  const beforeToggle = (await requests()).length;
  // The detail pane's own switch, which is what a user presses. The skill is placed in the project, so the operation
  // is a workspace-scope one; the project's default folder is BETA while the session runs on ALPHA.
  await page.locator(".config-detail").getByRole("switch").first().click();
  await page.getByText(/dormant|already in that state/i).first().waitFor({ timeout: 30000 });
  const toggle = (await requests()).slice(beforeToggle).find((entry) => entry.method === "PATCH" && entry.url.startsWith("/api/skill-market/skills"));
  check(toggle !== undefined, "the switch sent the canonical PATCH /api/skill-market/skills");
  check(toggle.body.workspaceId === "beta", "the project operation targeted the project's own default folder (beta), not the folder the session runs on: " + JSON.stringify(toggle.body));
  check(toggle.body.scope === "workspace", "the project placement was written at the host's workspace scope: " + JSON.stringify(toggle.body));
  check(toggle.body.conversationId === undefined, "no conversation was named: nothing on the sidebar's folder runs where this write lands");
  check(Array.isArray(toggle.body.directories) && toggle.body.directories[0] === "notes", "the body named the host directory the panel lists: " + JSON.stringify(toggle.body.directories));
  check(toggle.body.disableModelInvocation === true, "the request asked for the state the switch was moved to");

  // The revision question is its own request, and it names the same execution target the operation would write to.
  const beforeCheck = (await requests()).length;
  await page.locator(".config-detail").getByRole("button", { name: /check for updates/i }).click();
  await page.getByText(/up to date/i).first().waitFor({ timeout: 30000 });
  const checkRequest = (await requests()).slice(beforeCheck).find((entry) => entry.url.startsWith("/api/skill-market/check"));
  check(checkRequest !== undefined, "the check asked the backend about this installation's revision");
  check(new URL(checkRequest.url, origin).searchParams.get("workspaceId") === "beta", "the check named the project's default folder: " + checkRequest.url);
  check(new URL(checkRequest.url, origin).searchParams.get("scope") === "workspace", "the check named the installation's own scope");

  // The add pane installs into the folder its scope resolves to, which for a Project is the project's own default and
  // so is not the folder the sidebar shows. It therefore has to hold a target for THAT folder: a pane that only knew
  // the selected one would refuse with "No execution workspace is configured" and send nothing at all.
  await page.getByRole("button", { name: /add skill/i }).first().click();
  const beforeInstall = (await requests()).length;
  await page.locator(".config-add-source-heading").getByRole("button", { name: "project", exact: true }).click();
  await page.locator(".market-card", { hasText: "journal" }).getByRole("button", { name: /^install$/i }).click();
  await page.getByText(/installed|adopted/i).first().waitFor({ timeout: 30000 });
  const install = (await requests()).slice(beforeInstall).find((entry) => entry.method === "POST" && entry.url.startsWith("/api/skill-market/install"));
  check(install !== undefined, "the add pane sent the installation the user asked for");
  check(install?.body.workspaceId === "beta", "the installation was addressed to the project's own default folder (beta), not the folder the sidebar shows: " + JSON.stringify(install?.body));
  check(install?.body.scope === "workspace", "and at the host's workspace scope: " + JSON.stringify(install?.body));
  check(install?.body.conversationId === undefined, "naming no conversation, because nothing on the sidebar's folder runs where the write lands");

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
