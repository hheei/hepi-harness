/**
 * Browser regression for ticket 15: the Settings › Extensions panel drives the durable-extension surface the backend
 * already answers (ticket 14).
 *
 * It bundles apps/web/e2e/mcp-skills/ux-extensions-panel.fixture.tsx with the workspace's own esbuild, serves the build from a
 * temporary directory outside the repository on 127.0.0.1:43115 (override with HEPI_UX15_PORT), and drives it with the
 * installed Playwright. The fixture mounts the production ExtensionsConfig and records every request it receives, so
 * the assertions are about what the panel decided and sent, and the waits are observable DOM conditions.
 *
 * What it asserts: exactly the installed extensions are listed and nothing else; disabling one globally changes the
 * default for new conversations and writes the whole selection in one request; the per-conversation scope writes that
 * conversation's own route; several extensions switch at once in one request; the conversation scope is refused in
 * visible words when no conversation is open; and no install, update, check or generic editor exists anywhere.
 *
 * Usage: node apps/web/e2e/mcp-skills/ux-extensions-panel.ts [--keep]
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX15_PORT ?? 43115);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux15-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-extensions-panel.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-15</title>",
  "<link rel=\"stylesheet\" href=\"./ux-extensions-panel.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-extensions-panel.fixture.js\"></script>",
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
  await page.goto(origin + "/?session=conversation", { waitUntil: "load" });
  await page.getByRole("button", { name: "coding-tools", exact: true }).waitFor({ timeout: 30000 });
  const requests = async () => await page.evaluate(() => window.__ux15!.requests);
  const openedSections = async () => await page.evaluate(() => window.__ux15!.openedSections);
  const detail = page.locator(".config-detail");

  // Exactly the installed extensions are listed: the sidebar names each one and nothing else, and no control the panel
  // cannot perform exists anywhere in it.
  const rows = await page.locator(".config-sidebar-item").allTextContents();
  check(rows.length === 2 && rows.join(" ") === "coding-tools workspace-resources", "the sidebar lists exactly the installed extensions: " + JSON.stringify(rows));
  for (const forbidden of [/\bInstall\b/, /\bRemove\b/, /\bUpdate\b/, /\bCheck\b/, /Add extension/, /Add plugin/, /\bPackages?\b/]) {
    check(!forbidden.test(await page.locator("body").innerText()), "the panel offers no " + forbidden + " control");
  }
  check((await page.locator(".config-detail input, .config-detail textarea, .config-detail select").count()) === 0, "no generic per-extension editor is rendered");

  // Disabling one extension globally writes the whole default selection in one request.
  const beforeGlobal = (await requests()).length;
  await detail.getByRole("switch").click();
  await page.getByText(/default for new conversations is saved/i).waitFor({ timeout: 30000 });
  const globalWrites = (await requests()).slice(beforeGlobal).filter((entry) => entry.method === "POST" && entry.url === "/api/extensions");
  check(globalWrites.length === 1, "one global change is one request");
  check(JSON.stringify(globalWrites[0]?.body) === JSON.stringify({ extensions: ["workspace-resources"] }), "the request carries the whole selection after the change: " + JSON.stringify(globalWrites[0]?.body));
  check((await detail.getByRole("switch").getAttribute("aria-checked")) === "false", "the switch reads off after the write");
  // The row's own state follows: the sidebar dot and the footer count are the answer the backend gave.
  check((await page.locator(".config-sidebar-group-count").innerText()).trim() === "1/2", "the group switch reports the backend's answer");

  // The per-conversation scope reads and writes that conversation's own state, which differs from the default.
  await page.getByRole("button", { name: "This conversation", exact: true }).click();
  await page.getByText(/1 of 2 extensions enabled/).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "workspace-resources", exact: true }).click();
  check((await detail.getByRole("switch").getAttribute("aria-checked")) === "false", "the conversation scope shows the conversation's own selection, not the default");
  const beforeConversation = (await requests()).length;
  await detail.getByRole("switch").click();
  await page.getByText(/conversation's own selection is saved/i).waitFor({ timeout: 30000 });
  const conversationWrites = (await requests()).slice(beforeConversation).filter((entry) => entry.method === "PATCH");
  check(conversationWrites.length === 1 && conversationWrites[0].url === "/api/conversations/session-1/extensions", "the conversation scope writes that conversation's own route, on the Backend's vocabulary this deployment serves: " + JSON.stringify(conversationWrites.map((entry) => entry.url)));
  check(JSON.stringify(conversationWrites[0]?.body) === JSON.stringify({ extensions: ["coding-tools", "workspace-resources"] }), "the conversation write carries the whole selection: " + JSON.stringify(conversationWrites[0]?.body));
  // The default was not touched by that write: the only POSTs are the global ones made before this scope was used.
  const globalWritesBeforeConversation = (await requests()).slice(0, beforeConversation).filter((entry) => entry.method === "POST" && entry.url === "/api/extensions").length;
  check((await requests()).filter((entry) => entry.method === "POST" && entry.url === "/api/extensions").length === globalWritesBeforeConversation, "the conversation override did not write the global default");

  // Several at once is one action and one request. The default holds one extension here, so the group switch reads
  // off and the first click is the one that changes two extensions in one request; the second switches both off.
  await page.getByRole("button", { name: "New conversations", exact: true }).click();
  const beforeBulkOn = (await requests()).length;
  await page.locator(".config-sidebar-group-switch").getByRole("switch").click();
  await page.getByText(/default for new conversations is saved/i).waitFor({ timeout: 30000 });
  const bulkOn = (await requests()).slice(beforeBulkOn).filter((entry) => entry.method === "POST");
  check(bulkOn.length === 1, "a bulk toggle of two extensions at once is one request");
  check(JSON.stringify(bulkOn[0]?.body) === JSON.stringify({ extensions: ["coding-tools", "workspace-resources"] }), "the bulk write carries the whole selection: " + JSON.stringify(bulkOn[0]?.body));
  check((await page.locator(".config-sidebar-group-count").innerText()).trim() === "2/2", "the group switch reads on after the bulk write");
  const beforeBulkOff = (await requests()).length;
  await page.locator(".config-sidebar-group-switch").getByRole("switch").click();
  await page.getByText(/default for new conversations is saved/i).waitFor({ timeout: 30000 });
  const bulkOff = (await requests()).slice(beforeBulkOff).filter((entry) => entry.method === "POST");
  check(bulkOff.length === 1, "a bulk toggle off is one request");
  check(JSON.stringify(bulkOff[0]?.body) === JSON.stringify({ extensions: [] }), "the bulk off write carries the whole selection: " + JSON.stringify(bulkOff[0]?.body));
  check((await page.locator(".config-sidebar-group-count").innerText()).trim() === "0/2", "the group switch reports none enabled after the bulk off");

  // An extension that owns a settings surface links to it rather than being given an editor here.
  await page.getByRole("button", { name: "New conversations", exact: true }).click();
  await page.getByRole("button", { name: "workspace-resources", exact: true }).click();
  await detail.getByRole("button", { name: /^Open / }).click();
  check((await openedSections()).join(",") === "skills", "the extension's own surface is reached by opening its Settings section: " + JSON.stringify(await openedSections()));
  // coding-tools owns no surface here, so its detail offers no link at all.
  await page.getByRole("button", { name: "coding-tools", exact: true }).click();
  check((await detail.getByRole("button", { name: /^Open / }).count()) === 0, "an extension with no settings surface offers no link");

  // With no conversation open the per-conversation scope is refused in visible words, and the default still works.
  await page.goto(origin + "/?session=none", { waitUntil: "load" });
  await page.getByRole("button", { name: "coding-tools", exact: true }).waitFor({ timeout: 30000 });
  const scopeSwitch = page.locator(".config-scope-switch-field").first();
  check((await scopeSwitch.getByRole("button", { name: "This conversation", exact: true }).isDisabled()), "without a conversation the per-conversation scope is unavailable");
  check(/Open a conversation to change its own selection/.test(await scopeSwitch.innerText()), "and the reason is visible text: " + JSON.stringify(await scopeSwitch.innerText()));
  const beforeNoSession = (await requests()).length;
  await detail.getByRole("switch").click();
  await page.getByText(/default for new conversations is saved/i).waitFor({ timeout: 30000 });
  const noSessionWrites = (await requests()).slice(beforeNoSession).filter((entry) => entry.method !== "GET");
  check(noSessionWrites.length === 1 && noSessionWrites[0].url === "/api/extensions", "with no conversation only the global default is written: " + JSON.stringify(noSessionWrites.map((entry) => entry.url)));

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
