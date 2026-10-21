/**
 * Default-workspace regression: a deployment's configured workspace must not open itself.
 *
 * Reported from the live split deployment (Web UI on the client host, backend and gateway on the runtime host): a
 * bare "/" — a first visit, a bookmark, a new tab — came up with the window titled "workspace - Pi Web" and the
 * composer bound to ~/.local/share/hepi/workspace, the deployment's own configured workspace. Nobody had picked it:
 * the sidebar adopted the most recently active project on first load, and on this deployment that project is the
 * configured workspace, so the page opened a project of its own accord.
 *
 * This fixture is the same three processes a deployment composes, with a real browser:
 *   this script -> Next.js (Web UI, loopback) -> backend -> gateway -> a real workspace root on this host
 *
 * The configured workspace holds a conversation, and so does a recorded Project, because the fix must not hide
 * either: the groups stay listed with their conversations and open when the user picks one. Every assertion is about
 * what the browser rendered and asked for, recorded from the page rather than inferred.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-default-workspace.mjs [--keep]
 *        HEPI_UXDW_WEB_PORT / HEPI_UXDW_BACKEND_PORT / HEPI_UXDW_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-default-workspace-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-uxdw-"));
const dataDir = join(artifacts, "data");
// The deployment's one configured workspace: the folder its conversations actually run in. Its last path segment is
// the name the sidebar gives the group, which is why the reported window title read "workspace".
const workspaceRoot = join(artifacts, "workspace");
// A recorded Project on this host, so the fixture also proves an ordinary project is still opened by a pick.
const projectFolderRoot = join(artifacts, "downloads");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(projectFolderRoot, { recursive: true });
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
function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

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

const gatewayPort = await freePort(Number(process.env.HEPI_UXDW_GATEWAY_PORT ?? 0));
let gateway;
async function startGateway() {
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), {
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_PORT: String(gatewayPort),
      HEPI_GATEWAY_DATA: dataDir,
      HEPI_WORKSPACE_ID: "integration",
      HEPI_WORKSPACE_ROOT: workspaceRoot,
      HEPI_ALLOWED_COMMANDS: "bash",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + gatewayPort;
  assert.ok(await waitForHttp(origin + "/v1/files", {}, 45_000), "the gateway started: " + log().slice(-500));
  return { child, origin, log };
}

const backendPort = await freePort(Number(process.env.HEPI_UXDW_BACKEND_PORT ?? 0));
let backend;
function startBackend() {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_WORKSPACE_ID: "integration",
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: gateway.origin,
      HEPI_GATEWAY_TOKEN: token,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + backendPort };
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (path, init) => (await fetch(backend.origin + path, { headers, ...init })).json();

/** The sidebar's rows and groups, read from the rendered tree once the sidebar has loaded its catalogue. */
const groupNames = (page) => page.locator(".session-tree-group-name").allTextContents();
const sessionRows = (page) => page.locator(".session-tree-session");
const openRow = (page) => page.locator('.session-tree-main[aria-current="true"]');
const rowFor = (page, id) => page.locator('.session-tree-session[data-row-key$=":' + id + '"]');

/** The sidebar's catalogue, opened the way a user opens it: every folded group unfolded so its rows are rendered. */
async function sidebarReady(page) {
  await page.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
  for (let i = 0; i < 20; i += 1) {
    const folded = page.locator('.session-tree-group-toggle[aria-expanded="false"]').first();
    if (await folded.count() === 0) break;
    await folded.click();
  }
}

/** The row's own key carries the session id it belongs to, so a pick is made on the row the fixture created. */
async function pickRow(page, id) {
  const row = rowFor(page, id);
  await row.waitFor({ timeout: 20_000 });
  await row.locator(".session-tree-main").click();
}

let browser;
let web;
let webOrigin;

try {
  gateway = await startGateway();
  backend = startBackend();
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UXDW_WEB_PORT ?? 0));
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

  // The deployment's own state: a conversation in the configured workspace, and a Project of its own with one.
  const configuredId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "integration" }) })).conversationId;
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ hostId: "workstation", name: "Downloads", folders: [{ root: projectFolderRoot, default: true }] }) });
  assert.ok(created?.project?.folders?.[0]?.workspaceId, "the project was recorded: " + JSON.stringify(created));
  const projectId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: created.project.folders[0].workspaceId }) })).conversationId;
  assert.notEqual(configuredId, projectId, "the fixture has one conversation in the configured workspace and one in the Project");

  // The Web UI authenticates its own browser session with a cookie, not the backend bearer token.
  const login = await fetch(webOrigin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the Web UI login succeeded");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");

  browser = await chromium.launch();
  // A fresh context: no session or tab memory, which is what a first visit and a new tab have.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value: cookie.replace(/^hepi-web-token=/, ""), url: webOrigin, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const asked = [];
  page.on("request", (request) => asked.push(request.method() + " " + new URL(request.url()).pathname));

  // ------------------------------------------------------------- 1. a bare load opens nothing

  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  await sidebarReady(page);

  const groups = await groupNames(page);
  check(groups.includes("workspace"), "the configured workspace is listed as a group (" + JSON.stringify(groups) + ")");
  check(groups.includes("Downloads"), "the recorded Project is listed as a group (" + JSON.stringify(groups) + ")");
  const rows = await sessionRows(page).count();
  check(rows >= 2, "both conversations are listed, none hidden (" + rows + " rows)");
  check(await page.title() === "Pi Web", "a bare load names no project in the window title (" + JSON.stringify(await page.title()) + ")");
  check(await openRow(page).count() === 0, "a bare load opens no conversation");
  check(!asked.some((entry) => entry.endsWith(" /api/default-cwd")), "a bare load never asks for the default directory");
  const visible = await page.locator("body").innerText();
  check(!visible.includes(workspaceRoot), "the configured workspace's folder is nowhere on screen: " + workspaceRoot);
  check(pageErrors.length === 0, "the page raised no errors: " + pageErrors.join(" | "));

  // ------------------------------------------- 2. an explicit project pick opens that project

  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  const projectBox = page.locator(".project-picker.is-stacked .project-picker-button.is-project");
  await projectBox.waitFor({ timeout: 20_000 });
  check((await projectBox.innerText()).includes("Select project"), "with nothing open the picker asks for a project");
  await projectBox.click();
  // The desktop menu names each choice by its folder path, so the Project is picked by the folder it records.
  const projectChoice = page.locator('.sidebar-menu [role=menuitemradio][title="' + projectFolderRoot + '"]');
  await projectChoice.waitFor({ timeout: 20_000 });
  await projectChoice.click();
  await page.waitForFunction(() => document.title !== "Pi Web", undefined, { timeout: 20_000 });
  check(await page.title() === "downloads - Pi Web", "picking the Project opens it (" + JSON.stringify(await page.title()) + ")");

  // ------------------------------------------------- 3. a pick opens the conversation it names

  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await sidebarReady(page);
  await pickRow(page, configuredId);
  await page.waitForFunction((id) => new URLSearchParams(location.search).get("session") === id, configuredId, { timeout: 20_000 });
  check(await openRow(page).count() === 1, "picking a conversation opens it");
  check(await page.title() === "workspace - Pi Web", "the configured workspace is open because it was picked (" + JSON.stringify(await page.title()) + ")");

  // ------------------------------------------------------ 4. a reload keeps that conversation

  await page.reload({ waitUntil: "domcontentloaded" });
  await sidebarReady(page);
  await openRow(page).waitFor({ timeout: 20_000 });
  const reloaded = await page.evaluate(() => new URLSearchParams(location.search).get("session"));
  check(reloaded === configuredId, "a reload of the URL keeps the conversation open (" + reloaded + ")");

  // ------------- 5. a bare load in this tab keeps the user's own last pick, and adopts no other project

  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  await sidebarReady(page);
  const keptRow = rowFor(page, configuredId).locator('.session-tree-main[aria-current="true"]');
  await keptRow.waitFor({ timeout: 20_000 });
  check(await keptRow.count() === 1, "a bare load in this tab keeps the conversation this tab had open");
  check(await rowFor(page, projectId).locator('.session-tree-main[aria-current="true"]').count() === 0,
    "and it adopts no other project's conversation");
  check(await page.title() === "workspace - Pi Web", "and names only that conversation's project (" + JSON.stringify(await page.title()) + ")");
  check(pageErrors.length === 0, "no page error was raised in any scene: " + pageErrors.join(" | "));

  if (failures.length > 0) {
    console.log("body text:\n" + (await page.locator("body").innerText()));
  }
} finally {
  await browser?.close();
  await stop(web);
  await stop(backend?.child);
  await stop(gateway?.child);
  if (!keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("kept: " + artifacts);
}

if (failures.length > 0) {
  console.error("UX default-workspace regression FAILED (" + failures.length + "):\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("UX default-workspace regression passed");
