/**
 * Ticket 18 regression: truthfulness across the surfaces blocks A–F touched, and the submission rules ADR 0006 keeps.
 *
 * Real production paths only: the production Next build, the real backend process over a real SQLite store, a real
 * local execution host, and the browser driving the surfaces a person drives. No paid model call is made: the one
 * submission scene is refused by the backend before a run starts, and no other scene submits anything.
 *
 * What it asserts, in order:
 *   1. a control this deployment cannot serve is visibly unavailable before it is clicked — the sidebar's file-manager
 *      button is disabled and says why — while the control beside it stays available;
 *   2. a backend-answered failure is shown as that failure with its reason, and leaves the surface as it was;
 *   3. a transport failure is shown as a transport failure: the extensions panel reports that it could not read the
 *      installed set instead of reporting an empty one, and reads it again once the backend is back;
 *   4. the new surfaces offer only what they can do: the extensions panel has no install, remove, update or check
 *      control, and the MCP panel on a Web host with no MCP service names that limit in plain language;
 *   5. a Settings surface outside blocks A–F is visibly unavailable and otherwise unchanged: Sub-agents states the
 *      missing capability in plain language, lists no profile it never read, and the rest of Settings keeps working;
 *   6. the catalogue is honest about what the runtime cannot supply: no row carries a timestamp or an invented name,
 *      and the rendered row shows no placeholder time;
 *   7. only a readable rejection restores the draft: the refusal reason is visible, the turn never reaches the
 *      transcript, and the text comes back to the composer.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-truthfulness.mjs [--keep]
 *        HEPI_UX18_WEB_PORT=<port> HEPI_UX18_BACKEND_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-truthfulness-token";
const model = "controlled-1";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux18-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
/** A real 1x1 PNG: the refusal this driver provokes is about modality, so the bytes only have to be a real image. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const imagePath = join(artifacts, "tiny.png");
writeFileSync(imagePath, TINY_PNG);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

function freePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = probeServer();
    probe.on("error", reject);
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** Wait until nothing answers on this port, so "the backend is gone" is observed rather than assumed. */
async function waitForRefusal(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(url, { signal: AbortSignal.timeout(1000) }); } catch { return true; }
    await delay(100);
  }
  return false;
}

const childEnv = (home, extra) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra });

const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000).then(() => child.kill("SIGKILL"))]);
  await Promise.race([once(child, "exit"), delay(5_000)]);
}

const backendPort = await freePort(Number(process.env.HEPI_UX18_BACKEND_PORT ?? 0));
const backendOrigin = "http://127.0.0.1:" + backendPort;
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
let backend;
function startBackend() {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      HEPI_UX06_FIXTURE: join(artifacts, "fixture"),
      HEPI_UX06_DB: join(dataDir, "truthfulness.sqlite"),
      HEPI_UX06_BACKEND_PORT: String(backendPort),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: model,
      HEPI_UX06_ENDPOINT: "http://127.0.0.1:9",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log };
}

let browser;
let web;
let webOrigin;
let page;
let cookie;

const webApi = async (path) => (await fetch(webOrigin + "/api" + path, { headers: { ...headers, cookie } })).json();
const sidebarTab = (view, name) => view.locator(".sidebar-tab", { hasText: name });

async function signIn(view) {
  const password = view.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await view.locator('button[type="submit"]').click();
  }
  await view.locator("textarea").first().waitFor({ timeout: 60_000 });
}

async function openSettingsSection(view, name) {
  await view.getByRole("button", { name: "Settings", exact: true }).first().click();
  await view.getByRole("navigation", { name: "Settings" }).getByRole("button", { name, exact: true }).click();
  await view.locator(".settings-dialog-main").waitFor({ timeout: 30_000 });
}
/** Only the visible section's text: a visited section stays mounted but hidden. */
const settingsBody = (view) => view.locator(".settings-dialog-main").innerText();
const closeSettings = (view) => view.keyboard.press("Escape");

try {
  backend = startBackend();
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));
  const catalog = await (await fetch(backendOrigin + "/api/conversations", { headers })).json();
  const bound = catalog.conversations.find((item) => item.workspaceId === "local");
  assert.ok(bound !== undefined, "the fixture exposed a workspace-bound conversation");
  const sessionId = bound.id;

  const webPort = await freePort(Number(process.env.HEPI_UX18_WEB_PORT ?? 0));
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backendOrigin,
      HEPI_AUTH_TOKEN: token,
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  const login = await fetch(webOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200, "the browser session authenticated");
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  await signIn(page);

  // --- 1. A control this deployment cannot serve is visibly unavailable before it is clicked. -------------------
  await sidebarTab(page, "Files").click();
  const actions = page.locator(".sidebar-files-actions");
  await actions.waitFor({ timeout: 30_000 });
  const fileManager = actions.locator("button").nth(1);
  await fileManager.waitFor({ timeout: 30_000 });
  const fileManagerTitle = await fileManager.getAttribute("title");
  check(await fileManager.isDisabled(), "the file-manager button is disabled rather than answering a refusal when clicked");
  check(typeof fileManagerTitle === "string" && /not supported|only available/i.test(fileManagerTitle), "and it says why before it is clicked: " + JSON.stringify(fileManagerTitle));
  check(!(await actions.locator("button").first().isDisabled()), "the terminal button beside it is available, so the unavailable control is the exception");
  await sidebarTab(page, "Sessions").click();

  // --- 2. A backend-answered failure is shown as that failure, with its reason. --------------------------------
  const refusalName = "x".repeat(81);
  const row = page.locator('[data-row-key="session:group:' + sessionId + '"]');
  await row.waitFor({ timeout: 30_000 });
  await row.hover();
  await row.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  const renameInput = row.locator("input.session-tree-rename");
  await renameInput.waitFor({ timeout: 10_000 });
  await renameInput.fill(refusalName);
  await renameInput.press("Enter");
  const refusalToast = await page.getByText(/Couldn’t rename:/).first().innerText({ timeout: 30_000 });
  check(/1 to 80 characters/.test(refusalToast), "the refused rename reports the backend's own reason: " + JSON.stringify(refusalToast));
  check(!(await page.locator(".session-tree-title").allTextContents()).includes(refusalName), "and the row keeps the name it had");

  // --- 3. A transport failure is shown as a transport failure, never as an empty success. ----------------------
  await stop(backend.child);
  check(await waitForRefusal(backendOrigin + "/api/workspaces", 20_000), "the backend is really gone before the next read");
  await openSettingsSection(page, "Extensions");
  await page.getByText(/Could not read the installed extensions/).first().waitFor({ timeout: 30_000 });
  const offlineBody = await settingsBody(page);
  check(/Could not read the installed extensions/.test(offlineBody), "the extensions panel reports that it could not read the installed set: " + JSON.stringify(offlineBody.slice(0, 160)));
  check(!/installed no durable extensions/i.test(offlineBody), "and never reports an empty installed set as if the backend had answered");
  backend = startBackend();
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", headers, 45_000), "the backend is back: " + backend.log().slice(-500));
  const refresh = page.locator(".settings-dialog-main button:visible").filter({ hasText: "Refresh" }).first();
  await refresh.click();
  await page.locator(".config-sidebar-item").first().waitFor({ timeout: 30_000 });
  check(/coding-tools/.test(await settingsBody(page)), "the surface reads the installed set again once the backend is back");

  // --- 4. The new surfaces offer only what they can do. --------------------------------------------------------
  const extensionsBody = await settingsBody(page);
  for (const forbidden of [/Install/, /Remove/, /Update/, /Check/, /Add extension/, /Packages?/]) {
    check(!forbidden.test(extensionsBody), "the extensions panel offers no " + forbidden + " control");
  }
  check(/coding-tools/.test(extensionsBody) && /workspace-resources/.test(extensionsBody), "it lists the installed extensions the backend reports");
  await closeSettings(page);

  await openSettingsSection(page, "MCP");
  await page.getByText(/MCP is not available on this deployment/).first().waitFor({ timeout: 30_000 });
  const mcpBody = await settingsBody(page);
  check(/MCP is not available on this deployment/.test(mcpBody), "MCP names the missing host service in plain language");
  check(!/Add server|Add/.test(mcpBody), "and offers no editor for a configuration this Web origin cannot serve");
  await closeSettings(page);

  // --- 5. A Settings surface outside blocks A–F is visibly unavailable and unchanged. --------------------------
  await openSettingsSection(page, "Sub-agents");
  await page.getByText(/not connected to the durable server yet/).first().waitFor({ timeout: 30_000 });
  const agentsBody = await settingsBody(page);
  check(/not connected to the durable server yet/.test(agentsBody), "Sub-agents states the missing capability in plain language");
  check((await page.locator(".settings-dialog-main .config-sidebar-item:visible").count()) === 0, "and lists no profile it never read");
  await closeSettings(page);
  await openSettingsSection(page, "General");
  await page.getByText(/Appearance|Theme|Language/).first().waitFor({ timeout: 30_000 });
  check(/Appearance|Theme|Language/.test(await settingsBody(page)), "the Settings surface outside those blocks keeps working around it");
  await closeSettings(page);

  // --- 6. The catalogue is honest about what the runtime cannot supply. ----------------------------------------
  const listed = await webApi("/sessions");
  check(listed.sessions.length > 0, "the catalogue lists the conversation");
  check(listed.sessions.every((item) => item.created === "" && item.modified === ""), "no row carries a timestamp the runtime cannot supply: " + JSON.stringify(listed.sessions.map((item) => [item.created, item.modified])));
  check(listed.sessions.every((item) => item.name === undefined), "no row carries a name the backend never wrote: " + JSON.stringify(listed.sessions.map((item) => item.name)));
  const metaText = (await page.locator('[data-row-key="session:group:' + sessionId + '"] .session-tree-meta').innerText()).trim();
  check(metaText === "", "and the rendered row shows no placeholder time: " + JSON.stringify(metaText));

  // --- 7. Only a readable rejection restores the draft. --------------------------------------------------------
  // The configured model declares text input only, so the backend refuses an image with its own reason instead of
  // dropping the attachment. That refusal is the one outcome that puts the text back in the composer.
  const composer = page.locator("textarea").first();
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles([imagePath]);
  await composer.fill("truthfulness rejection text");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const rejection = page.getByText(/does not accept image input/).first();
  await rejection.waitFor({ timeout: 30_000 });
  check(true, "the refusal reason is visible: " + JSON.stringify((await rejection.innerText()).slice(0, 160)));
  check((await page.locator(".markdown-user-message").count()) === 0, "the refused turn never reached the transcript");
  check((await composer.inputValue()) === "truthfulness rejection text", "the readable rejection put the text back in the composer");
  check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  if (keep) console.log("artifacts kept at " + artifacts);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(failures.length === 0 ? 0 : 1);
