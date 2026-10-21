/**
 * Ticket 18 regression: the durable-extension selection through the real Web UI, a real backend and a real store.
 *
 * Ticket 15's browser driver mounts the panel with only its network boundary replaced, so it proves what the panel
 * sends and never that the backend stored it. This driver is the other half: the production Next build, the real
 * backend process over a real SQLite store, a real local execution host, and the panel opened the way a person opens
 * it. The assertions read the backend's own answers — the resolved default and each conversation's materialized
 * selection — so "the default survives a restart", "a new conversation selects it" and "an existing conversation does
 * not move" are about stored state rather than about the panel's own memory.
 *
 * Scenes, in order:
 *   1. a conversation created under the deployment's default selects it, and the panel lists exactly the installed
 *      extensions the backend reports;
 *   2. changing the default in the panel reaches the backend, and the backend's answer is what the panel shows;
 *   3. the changed default survives a backend restart against the same database, and the panel reads it back;
 *   4. a conversation created after the change selects the new default;
 *   5. the conversation created before the change keeps the selection it was created with;
 *   6. a per-conversation override writes that conversation's own selection, leaves the default alone, and survives a
 *      reload.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-extensions-selection.mjs [--keep]
 *        HEPI_UX18_EXT_WEB_PORT=<port> HEPI_UX18_EXT_BACKEND_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-extensions-selection-token";
const model = "controlled-1";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux18-ext-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

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

/** Both child roles run from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
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
}

// ---------------------------------------------------------------- the two processes

const backendPort = await freePort(Number(process.env.HEPI_UX18_EXT_BACKEND_PORT ?? 0));
const dbPath = join(dataDir, "extensions.sqlite");
let backend;
function startBackend() {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "image-submit-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      HEPI_UX06_FIXTURE: join(artifacts, "fixture"),
      HEPI_UX06_DB: dbPath,
      HEPI_UX06_BACKEND_PORT: String(backendPort),
      HEPI_UX06_AUTH: token,
      HEPI_UX06_MODEL: model,
      // The provider endpoint is never reached: no turn is run here, and the selection is decided at creation.
      HEPI_UX06_ENDPOINT: "http://127.0.0.1:9",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + backendPort };
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

let browser;
let web;
let webOrigin;
let page;
let cookie;

/** The panel's own reads, addressed the way the browser addresses them, so the answer is the one the UI got. */
const webApi = async (path, init) => (await fetch(webOrigin + "/api" + path, { headers: { ...headers, cookie }, ...init })).json();
const defaultSelection = async () => (await webApi("/extensions")).default;
const installedNames = async () => (await webApi("/extensions")).installed.map((extension) => extension.name);
const conversationSelection = async (id) => (await webApi("/sessions/" + id + "/state")).extensions;

async function signIn(view) {
  const password = view.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await view.locator('button[type="submit"]').click();
  }
  await view.locator("textarea").first().waitFor({ timeout: 60_000 });
}

/** Settings › Extensions, opened the way a person opens it. */
async function openExtensionsSettings(view) {
  await view.getByRole("button", { name: "Settings", exact: true }).first().click();
  await view.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Extensions", exact: true }).click();
  await view.locator(".config-sidebar-item").first().waitFor({ timeout: 30_000 });
}
const closeSettings = (view) => view.keyboard.press("Escape");

/** One extension's row in the panel, and the switch the detail pane shows for the selected row. */
async function selectExtension(view, name) {
  await view.getByRole("button", { name, exact: true }).click();
  await view.locator(".config-detail").waitFor({ timeout: 30_000 });
}
const detailSwitch = (view) => view.locator(".config-detail").getByRole("switch");
async function chooseScope(view, scope) {
  await view.getByRole("button", { name: scope, exact: true }).click();
}
const savedNotice = (view, text) => view.getByText(text).waitFor({ timeout: 30_000 });

try {
  backend = startBackend();
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  // The conversation that exists before any change: it selects the deployment's default as it stood at its creation.
  const createConversation = async () => {
    const response = await fetch(backend.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
    const text = await response.text();
    assert.equal(response.status, 201, "a conversation was created: " + text);
    return JSON.parse(text).conversationId;
  };
  const earlier = await createConversation();

  const webPort = await freePort(Number(process.env.HEPI_UX18_EXT_WEB_PORT ?? 0));
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backend.origin,
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

  // The browser session is the page's own: the same login route the sign-in form posts to.
  const login = await fetch(webOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host }, body: JSON.stringify({ token }) });
  assert.equal(login.status, 200, "the browser session authenticated");
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // --- Scene 1: the installed set and the selection a conversation was created with. --------------------------
  const installed = await installedNames();
  // The registry is the authority: the optional subagent extension is installed so its anchor task definition resolves
  // for every task, but it is not part of the default selection, so ordinary chat is unchanged until it is turned on.
  check(installed.includes("coding-tools") && installed.includes("workspace-resources") && installed.includes("hepi-subagents"), "the backend reports its installed extensions: " + JSON.stringify(installed));
  const selectable = installed.filter((name) => name !== "hepi-subagents");
  const opening = await defaultSelection();
  check(JSON.stringify(opening) === JSON.stringify(selectable), "the deployment's default selects every selectable extension: " + JSON.stringify(opening));
  check(JSON.stringify(await conversationSelection(earlier)) === JSON.stringify(opening), "the conversation created under that default selects it");

  await page.goto(webOrigin + "/?session=" + earlier, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await openExtensionsSettings(page);
  const rows = await page.locator(".config-sidebar-item").allTextContents();
  check(rows.length === installed.length && [...rows].sort().join(" ") === [...installed].sort().join(" "), "the panel lists exactly what the backend installed: " + JSON.stringify(rows));
  check((await page.locator(".config-sidebar-group-count").innerText()).trim() === selectable.length + "/" + installed.length, "the panel reports the backend's own count");

  // --- Scene 2: the default is changed in the panel and the backend is what changed. -------------------------
  await chooseScope(page, "New conversations");
  await selectExtension(page, "workspace-resources");
  check((await detailSwitch(page).getAttribute("aria-checked")) === "true", "the default's own selection is what the row shows");
  await detailSwitch(page).click();
  await savedNotice(page, /default for new conversations is saved/i);
  check(JSON.stringify(await defaultSelection()) === JSON.stringify(["coding-tools"]), "the backend's default is the selection the panel wrote: " + JSON.stringify(await defaultSelection()));
  check((await page.locator(".config-sidebar-group-count").innerText()).trim() === "1/" + installed.length, "the panel reports the backend's answer, not its own guess");
  await closeSettings(page);

  // --- Scene 3: the default survives a backend restart against the same store. -------------------------------
  await stop(backend.child);
  backend = startBackend();
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the restarted backend is up: " + backend.log().slice(-500));
  check(JSON.stringify(await defaultSelection()) === JSON.stringify(["coding-tools"]), "the restarted backend still answers the changed default");
  await page.reload({ waitUntil: "domcontentloaded" });
  await signIn(page);
  await openExtensionsSettings(page);
  await chooseScope(page, "New conversations");
  await selectExtension(page, "workspace-resources");
  check((await detailSwitch(page).getAttribute("aria-checked")) === "false", "the panel reads the persisted default back after the restart");

  // --- Scene 4 and 5: a later conversation selects the new default; an earlier one does not move. ------------
  const later = await createConversation();
  check(JSON.stringify(await conversationSelection(later)) === JSON.stringify(["coding-tools"]), "a conversation created after the change selects the new default");
  check(JSON.stringify(await conversationSelection(earlier)) === JSON.stringify(["coding-tools", "workspace-resources"]), "the conversation created before the change keeps the selection it was created with");

  // --- Scene 6: a per-conversation override is that conversation's own state and leaves the default alone. ---
  await page.goto(webOrigin + "/?session=" + later, { waitUntil: "domcontentloaded" });
  await signIn(page);
  await openExtensionsSettings(page);
  await chooseScope(page, "This conversation");
  await selectExtension(page, "workspace-resources");
  check((await detailSwitch(page).getAttribute("aria-checked")) === "false", "the conversation scope shows that conversation's own selection");
  await detailSwitch(page).click();
  await savedNotice(page, /conversation's own selection is saved/i);
  check(JSON.stringify(await conversationSelection(later)) === JSON.stringify(["coding-tools", "workspace-resources"]), "the override reached that conversation's own state");
  check(JSON.stringify(await defaultSelection()) === JSON.stringify(["coding-tools"]), "the override left the deployment's default alone");
  await closeSettings(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await signIn(page);
  await openExtensionsSettings(page);
  await chooseScope(page, "This conversation");
  await selectExtension(page, "workspace-resources");
  check((await detailSwitch(page).getAttribute("aria-checked")) === "true", "the override survived a reload");
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
