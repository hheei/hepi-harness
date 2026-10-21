/**
 * Browser regression for ticket 08: a Settings write that changes what a conversation runs with asks that conversation
 * to re-read its resources, and reports what the conversation established.
 *
 * The fixture mounts the production `AgentsConfig` and the production `SettingsPanel` General section under one
 * connection whose `refreshes` registry holds a scripted conversation reload, so every assertion below is about what
 * the panel decided: which conversation it asked, whether it asked at all, and what it then displayed.
 *
 * What it asserts: saving an agent definition asks exactly the conversation Settings was opened for, once; a reload
 * the conversation reported as failed is shown as a failure and never as a reload; a reload that established nothing
 * (`superseded`) is not reported as one; and with no conversation open nothing is asked and nothing is claimed.
 *
 * Usage: node apps/web/e2e/mcp-skills/ux-definition-refresh.ts [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX08_PORT ?? 43108);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux08-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-definition-refresh.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-08</title>",
  "<link rel=\"stylesheet\" href=\"./ux-definition-refresh.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-definition-refresh.fixture.js\"></script>",
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
    const open = async (query: string) => {
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(origin + "/" + query, { waitUntil: "load" });
      return { page, pageErrors };
    };
    const refreshes = async (page: import("playwright").Page) => await page.evaluate(() => window.__ux08!.refreshes) as string[];
    const requests = async (page: import("playwright").Page) => await page.evaluate(() => window.__ux08!.requests);

    // Saving a definition asks the conversation Settings was opened from, and shows what its read established.
    {
      const { page, pageErrors } = await open("");
      await page.getByRole("button", { name: "reviewer", exact: true }).waitFor({ timeout: 30000 });
      const before = (await requests(page)).length;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText(/Reloaded 2 skills and 1 prompts/).waitFor({ timeout: 30000 });
      check(JSON.stringify(await requests(page).then((list) => list.slice(before).filter((entry) => entry.method === "PUT").map((entry) => entry.url))) === JSON.stringify(["/api/agent-definitions"]), "the save wrote the definition once");
      check(JSON.stringify(await refreshes(page)) === JSON.stringify(["session-1"]), "and asked exactly the conversation Settings was opened for: " + JSON.stringify(await refreshes(page)));
      check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
      await page.close();
    }

    // A reload the conversation reported as failed is stated as a failure; the definition is still saved.
    {
      const { page } = await open("?outcome=failed");
      await page.getByRole("button", { name: "reviewer", exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText(/Reload failed: the Backend refused the read/).waitFor({ timeout: 30000 });
      const footer = await page.locator(".config-footer").innerText();
      check(!/Reloaded 2 skills/.test(footer), "a failed conversation read is never shown as a reload: " + JSON.stringify(footer));
      check(/the Backend refused the read/.test(footer), "the failure states the reason the conversation gave: " + JSON.stringify(footer));
      await page.close();
    }

    // With no conversation open there is nothing to re-read: no refresh is asked for and nothing is claimed.
    {
      const { page } = await open("?session=none");
      await page.getByRole("button", { name: "reviewer", exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.locator(".config-footer").getByText("Saved", { exact: true }).waitFor({ timeout: 30000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      check((await refreshes(page)).length === 0, "no conversation was asked, because none is open: " + JSON.stringify(await refreshes(page)));
      check(!/Reloaded|could not pick it up|Reload failed/.test(await page.locator(".config-footer").innerText()), "and nothing was claimed about one");
      await page.close();
    }

    // A read that established nothing about this panel's surface is not reported as a reload either.
    {
      const { page } = await open("?outcome=superseded");
      await page.getByRole("button", { name: "reviewer", exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved", { exact: true }).first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(500);
      check(JSON.stringify(await refreshes(page)) === JSON.stringify(["session-1"]), "the conversation was asked: " + JSON.stringify(await refreshes(page)));
      const footer = await page.locator(".config-footer").innerText();
      check(!/Reloaded|Reload failed/.test(footer), "a superseded read claims neither a reload nor a failure: " + JSON.stringify(footer));
      await page.close();
    }

    // A conversation write answered after the reader moved on belongs to the conversation it named, not the one on screen.
    {
      const { page } = await open("");
      await page.evaluate(() => window.__ux08!.setView("extensions"));
      await page.getByRole("button", { name: "coding-tools", exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole("button", { name: "This conversation", exact: true }).click();
      // The conversation's own selection is read before the switch is usable: the scope stays the default until it is.
      await page.getByText(/of 1 extension/).waitFor({ timeout: 30000 });
      await page.locator(".config-detail").getByRole("switch").click();
      // The write is in flight for session-1 while the reader opens session-2, which selects nothing.
      await page.waitForFunction(() => window.__ux08!.held.length === 1, undefined, { timeout: 30000 });
      await page.evaluate(() => window.__ux08!.setSession("session-2"));
      await page.getByText(/0 of 1 extension|No extensions are selected/).waitFor({ timeout: 30000 });
      await page.evaluate(() => { for (const entry of window.__ux08!.held) entry.release(); });
      await page.waitForTimeout(500);
      check(!/conversation's own selection is saved/.test(await page.locator("body").innerText()), "the earlier conversation's answer is not shown as this conversation's save");
      check((await page.locator(".config-detail").getByRole("switch").getAttribute("aria-checked")) === "false", "and the switch still reads the conversation on screen");
      check(JSON.stringify((await requests(page)).filter((entry) => entry.method === "PATCH").map((entry) => entry.url)) === JSON.stringify(["/api/conversations/session-1/extensions"]), "the write went to the conversation it was made in");
      await page.close();
    }

    // Settings › General's shell-tool switch asks the same conversation, once, and reports a failure the same way.
    {
      const { page } = await open("?outcome=failed");
      await page.evaluate(() => window.__ux08!.setView("general"));
      await page.locator(".settings-shell-option").getByRole("switch").waitFor({ timeout: 30000 });
      await page.locator(".settings-shell-option").getByRole("switch").click();
      await page.getByText(/Reload failed: the Backend refused the read/).waitFor({ timeout: 30000 });
      const writes = (await requests(page)).filter((entry) => entry.method === "PUT" && entry.url === "/api/tools/settings");
      check(writes.length === 1, "the setting was written once: " + JSON.stringify(writes.length));
      check(JSON.stringify(await refreshes(page)) === JSON.stringify(["session-1"]), "and the open conversation was asked once: " + JSON.stringify(await refreshes(page)));
      check(/the Backend refused the read/.test(await page.locator(".settings-general").innerText()), "the failed read is visible in the panel");
      await page.close();
    }

    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
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
