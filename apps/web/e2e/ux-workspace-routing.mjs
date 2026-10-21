/**
 * CWD routing regression: the two refusals a real deployment showed on opening the UI.
 *
 * Reported from the live Mac deployment (Web UI on :30141, backend/gateway on the workstation host):
 *   (1) opening the page  -> "Only configured /workspace/<id> paths are available"
 *   (2) opening a legacy URL -> "Only configured workspaces are available"
 *
 * Both come from one place: what the Web adapter tells the browser a cwd *is*. It answered the literal sentinel
 * "/durable" for the home folder and for a conversation with no execution workspace, so the copied pi-web file
 * surface treated "no workspace" as a directory and asked the workspace APIs about it; and it accepted only
 * "/durable" or "/workspace/<id>", so a legacy physical root — the very root "/api/workspaces" reports — was
 * refused as an unknown workspace.
 *
 * This fixture is the same three processes a deployment composes, with a real browser:
 *   this script -> Next.js (Web UI, loopback) -> backend -> gateway -> a real workspace root on this host
 *
 * It reproduces both messages exactly, then asserts the fixed behaviour. Every assertion is about what the
 * browser actually asked for and got: the API calls are recorded from the page, not inferred.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-workspace-routing.mjs [--keep]
 *        HEPI_UX514_WEB_PORT / HEPI_UX514_BACKEND_PORT / HEPI_UX514_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-workspace-routing-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux514-"));
const dataDir = join(artifacts, "data");
// The deployment's one configured workspace: the folder its conversations actually run in.
const workspaceRoot = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(join(workspaceRoot, "src"), { recursive: true });
writeFileSync(join(workspaceRoot, "note.txt"), "note in the configured workspace\n");
writeFileSync(join(workspaceRoot, "src", "app.ts"), "export const app = 1;\n");
// A directory that is not a workspace of this deployment: choosing it must stay refused.
const strangerRoot = join(artifacts, "stranger");
mkdirSync(strangerRoot, { recursive: true });
// The reported case: a Project whose folder is a real host directory — the shape a folder in ~/Downloads has. It is
// registered through the public project route, so its workspace id is minted by the backend like any other.
const projectFolderRoot = join(artifacts, "downloads");
mkdirSync(projectFolderRoot, { recursive: true });
writeFileSync(join(projectFolderRoot, "report.csv"), "a,b\n1,2\n");
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

/** One OpenAI-completions endpoint answering a fixed text, so an unbound conversation can still hold a turn. */
function controlledEndpoint(modelId) {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const base = { id: "chatcmpl-ux514", object: "chat.completion.chunk", created: 1, model: modelId };
      const frame = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "unbound answer" }, finish_reason: null }] });
      frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
      response.end("data: [DONE]\n\n");
    });
  });
  return {
    server,
    listen: (port) => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); }),
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

const gatewayPort = await freePort(Number(process.env.HEPI_UX514_GATEWAY_PORT ?? 0));
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

const backendPort = await freePort(Number(process.env.HEPI_UX514_BACKEND_PORT ?? 0));
let backend;
function startBackend(endpointOrigin) {
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
      HEPI_PROVIDER: "controlled",
      HEPI_MODEL: "controlled-1",
      HEPI_PROVIDER_BASE_URL: endpointOrigin + "/v1",
      HEPI_PROVIDER_API_KEY: "controlled-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  return { child, log, origin: "http://127.0.0.1:" + backendPort };
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (path, init) => (await fetch(backend.origin + path, { headers, ...init })).json();

/** Submit one prompt and wait for the turn's answer, so an unbound conversation's chat is proven to still work. */
async function runTurn(conversationId, text, requestId, expected) {
  const path = backend.origin + "/api/conversations/" + conversationId;
  const reader = (await fetch(path + "/events", { headers, signal: AbortSignal.timeout(30_000) })).body.getReader();
  try {
    const submitted = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    assert.equal(submitted.status, 202);
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended before the turn settled");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const line = frame.split("\n").find((value) => value.startsWith("data: "));
        if (line === undefined) continue;
        const current = JSON.parse(line.slice(6));
        // A submission frame carries no entries, so a turn's own admission is skipped rather than read as one.
        if (!Array.isArray(current.entries)) continue;
        if (!current.busy && current.entries.some((entry) => entry.role === "assistant" && entry.text === expected)) return current;
      }
    }
  } finally { await reader.cancel(); }
}

let browser;
let web;
let webOrigin;
let endpoint;

try {
  const endpointPort = await freePort();
  endpoint = controlledEndpoint("controlled-1");
  await endpoint.listen(endpointPort);
  gateway = await startGateway();
  backend = startBackend("http://127.0.0.1:" + endpointPort);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UX514_WEB_PORT ?? 0));
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

  // The two conversations a deployment like this really has: one recorded before any workspace was bound (the
  // legacy, unbound one) and one in the configured workspace.
  const unboundId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({}) })).conversationId;
  const boundId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "integration" }) })).conversationId;
  check((await api("/api/conversations/" + unboundId + "/state")).workspaceId === undefined, "the legacy conversation really has no workspace");
  // A Project on this host whose folder is a plain directory: the folder is what its surfaces must show.
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ hostId: "workstation", name: "Downloads", folders: [{ root: projectFolderRoot, default: true }] }) });
  assert.ok(created?.project?.folders?.[0]?.workspaceId, "the project was recorded: " + JSON.stringify(created));
  const projectWorkspaceId = created.project.folders[0].workspaceId;
  assert.notEqual(projectWorkspaceId, projectFolderRoot, "the workspace id is opaque, not the path");
  const projectId = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: projectWorkspaceId }) })).conversationId;

  // ---------------------------------------------------------------- the adapter's own answers

  // The Web UI authenticates its own browser session with a cookie, not the backend bearer token, so the direct
  // checks log in exactly as the page does and keep that cookie.
  const login = await fetch(webOrigin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin, host: new URL(webOrigin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the Web UI login succeeded");
  const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
  assert.ok(cookie.includes("hepi-web-token"), "the login set the session cookie");
  const webApi = async (path, init) => {
    const response = await fetch(webOrigin + "/api/" + path, { headers: { cookie, origin: webOrigin, host: new URL(webOrigin).host, "content-type": "application/json", ...init?.headers }, ...init });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const sessions = (await webApi("sessions")).body.sessions;
  const unboundSession = sessions.find((item) => item.id === unboundId);
  const boundSession = sessions.find((item) => item.id === boundId);
  check(unboundSession?.cwd === "/durable", "an unbound conversation is still listed, at the adapter's unbound cwd");
  check(unboundSession?.workspaceBound === false, "and it is reported as having no execution workspace");
  check(unboundSession?.projectRoot === undefined && unboundSession?.projectKey === undefined,
    "so it is not presented as a project with a folder: " + JSON.stringify({ projectRoot: unboundSession?.projectRoot, projectKey: unboundSession?.projectKey }));
  check(boundSession?.workspaceBound === true && boundSession?.projectRoot === "/workspace/integration",
    "a bound conversation keeps its own workspace identity: " + JSON.stringify({ projectRoot: boundSession?.projectRoot }));

  // The reported symptom: a project folder in a home directory was shown as /workspace/<uuid> instead of as its own
  // path. The catalog carries the routing root for API calls and the folder for every surface that shows one.
  const projectSessions = (await webApi("sessions")).body.sessions;
  const projectSession = projectSessions.find((item) => item.id === projectId);
  check(projectSession?.cwd === "/workspace/" + projectWorkspaceId,
    "the project conversation keeps its routing cwd: " + JSON.stringify({ cwd: projectSession?.cwd }));
  check(projectSession?.projectRoot === "/workspace/" + projectWorkspaceId,
    "and the routing root it is addressed by: " + JSON.stringify({ projectRoot: projectSession?.projectRoot }));
  check(projectSession?.projectDisplayRoot === projectFolderRoot,
    "while its own folder is reported for display: " + JSON.stringify({ projectDisplayRoot: projectSession?.projectDisplayRoot }));

  const validatedProject = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: projectFolderRoot }) });
  check(validatedProject.status === 200 && validatedProject.body.cwd === "/workspace/" + projectWorkspaceId && validatedProject.body.displayRoot === projectFolderRoot,
    "validating the folder answers the routing path and the folder: " + JSON.stringify(validatedProject.body));

  const workspaces = (await webApi("workspaces")).body.workspaces;
  const configuredHome = workspaces.find((item) => item.id === "integration")?.host?.home;
  const home = (await webApi("home")).body;
  check(home.home === configuredHome, "the home folder is the execution account's own home, not a made-up path: " + JSON.stringify(home));
  const defaultCwd = (await webApi("default-cwd", { method: "POST" })).body;
  check(defaultCwd.cwd === "/workspace/integration", "the default directory of a new session is the configured workspace: " + JSON.stringify(defaultCwd));

  // The reported (2): a legacy physical root is the very root /api/workspaces reports, so it resolves to its own
  // routing path instead of being refused as an unknown workspace.
  const byRoot = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: workspaceRoot }) });
  check(byRoot.status === 200 && byRoot.body.cwd === "/workspace/integration",
    "the configured workspace's own root resolves to its routing path: " + JSON.stringify(byRoot.body));
  const byRootTrailingSlash = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: workspaceRoot + "/" }) });
  check(byRootTrailingSlash.status === 200 && byRootTrailingSlash.body.cwd === "/workspace/integration",
    "a trailing slash is the same folder: " + JSON.stringify(byRootTrailingSlash.body));
  const byRouting = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: "/workspace/integration" }) });
  check(byRouting.status === 200 && byRouting.body.cwd === "/workspace/integration", "the routing path still validates");
  // No blind allow: a directory this deployment does not serve stays refused.
  const stranger = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: strangerRoot }) });
  check(stranger.status === 501, "a directory that is no workspace of this deployment is still refused: " + JSON.stringify(stranger.body));
  const strangerTraversal = await webApi("cwd/validate", { method: "POST", body: JSON.stringify({ cwd: workspaceRoot + "/../stranger" }) });
  check(strangerTraversal.status === 501, "and so is a path that only starts like one: " + JSON.stringify(strangerTraversal.body));

  const worktrees = (await webApi("worktrees?cwd=%2Fworkspace%2Fintegration")).body;
  check(worktrees.projectRoot === "/workspace/integration" && worktrees.projectKey === "/workspace/integration",
    "the worktree answer names the workspace the caller asked about: " + JSON.stringify(worktrees));
  const unboundWorktrees = (await webApi("worktrees?cwd=%2Fdurable")).body;
  check(unboundWorktrees.projectRoot === undefined, "and an unbound cwd is no project at all: " + JSON.stringify(unboundWorktrees));

  // ---------------------------------------------------------------- the real browser

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  /** Every /api call the page made, so the assertions are about real requests. */
  const calls = [];
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(webOrigin + "/api/")) return;
    calls.push({ method: response.request().method(), url: url.slice(webOrigin.length), status: response.status() });
  });
  // The surfaces that exist only for a workspace: the file tree, the file index, Git, project trust, the worktree
  // list and the cwd check. A model list names a cwd too, but it is not a workspace surface. The plugin-update and
  // ui-state routes are unimplemented capabilities that name no cwd at all, so they are not this bug's business.
  const WORKSPACE_SURFACES = ["/api/files", "/api/file-index", "/api/git/", "/api/project-trust", "/api/worktrees", "/api/cwd/validate"];
  // The surfaces this fix routes. /api/project-trust is excluded from the refusal assertion on purpose: the durable
  // adapter does not implement it for ANY cwd — a workspace cwd gets the same 501 — so it is a recorded capability
  // gap, not a cwd-routing failure, and the shell only logs its answer.
  const ROUTED_SURFACES = ["/api/files", "/api/file-index", "/api/git/", "/api/worktrees", "/api/cwd/validate"];
  // The cwd travels percent-encoded in a query string, so the comparison is on the decoded URL: "/durable" and
  // "%2Fdurable" are the same cwd, and only one of them is spelled like the path.
  const asked = (fragment) => calls.filter((call) => WORKSPACE_SURFACES.some((surface) => call.url.startsWith(surface)) && decodeURIComponent(call.url).includes(fragment));
  const refusals = () => calls.filter((call) => call.status === 501 && ROUTED_SURFACES.some((surface) => call.url.startsWith(surface)));

  const openPage = async (path) => {
    calls.length = 0;
    await page.goto(webOrigin + path, { waitUntil: "domcontentloaded" });
    const password = page.locator('input[type="password"]');
    if (await password.count()) {
      await password.fill(token);
      await page.locator('button[type="submit"]').click();
    }
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.count()) await showSidebar.click();
    await page.locator("body").waitFor();
    await delay(2500);
  };

  // Opening the UI: the reported (1). A bare load opens no project at all — a deployment's configured workspace is
  // one of them — so no workspace surface is asked about a cwd and nothing is refused. The workspace's own files are
  // proven by the explicit paths below, which is how a user reaches them.
  await openPage("/");
  check(asked("/durable").length === 0, "no workspace surface is asked about the unbound cwd: " + JSON.stringify(asked("/durable").map((call) => call.url)));
  check(asked("/api/files/workspace/integration").length === 0,
    "a bare load opens no project, so no file surface is asked about one: " + JSON.stringify(asked("/api/files/workspace/integration")));
  check(await page.getByText("note.txt", { exact: true }).count() === 0, "and a project nobody opened lists no files");
  check(refusals().length === 0, "opening the UI raises no refusal: " + JSON.stringify(refusals().map((call) => call.url + " " + call.status)));

  // The reported (2): a legacy URL carries the physical root the old UI used.
  await openPage("/?cwd=" + encodeURIComponent(workspaceRoot));
  const validated = asked("/api/cwd/validate");
  check(validated.length > 0 && validated.every((call) => call.status === 200), "a legacy physical cwd validates: " + JSON.stringify(validated));
  check(await page.getByText("note.txt", { exact: true }).count() > 0, "and lands on the workspace's files");
  check(!(await page.evaluate(() => document.body.innerText)).includes("Only configured workspaces are available"),
    "the reported message is gone from the page");

  // A directory this deployment does not serve is still reported, not silently accepted.
  await openPage("/?cwd=" + encodeURIComponent(strangerRoot));
  check((await page.evaluate(() => document.body.innerText)).includes("Only configured workspaces are available"),
    "a non-workspace cwd is still refused, in the same words");

  // The legacy conversation itself: its chat must stay usable, and it must not ask the workspace APIs anything.
  await openPage("/?session=" + unboundId);
  check(asked("/durable").length === 0,
    "selecting the unbound conversation asks the workspace surfaces nothing: " + JSON.stringify(asked("/durable").map((call) => call.url)));
  check((await page.getByRole("textbox").count()) > 0, "its chat is still there to type in");
  check(refusals().length === 0, "and nothing on that page is refused: " + JSON.stringify(refusals().map((call) => call.url)));

  // The workspace conversation keeps its own files.
  await openPage("/?session=" + boundId);
  check(asked("/api/files/workspace/integration").length > 0, "a workspace conversation opens the workspace's files");
  check(await page.getByText("note.txt", { exact: true }).count() > 0, "and lists them");

  // The project's own folder is what the sidebar shows: its group is titled with the path on the host, and the
  // routing id is nowhere in what the user sees.
  await openPage("/?session=" + projectId);
  const groupTitles = await page.locator(".session-tree-group-toggle").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
  check(groupTitles.includes(projectFolderRoot),
    "the project's group is titled with its folder on the host: " + JSON.stringify(groupTitles));
  const shownText = await page.evaluate(() => document.body.innerText);
  check(!shownText.includes("/workspace/" + projectWorkspaceId),
    "and no surface shows the /workspace/<id> it is addressed by");
  check(shownText.includes("Downloads"),
    "the project is shown by its name: " + JSON.stringify(shownText.slice(0, 200)));
  check(asked("/api/files/workspace/" + projectWorkspaceId).every((call) => call.status === 200),
    "while the file surface is asked about the routing path: " + JSON.stringify(asked("/api/files/workspace/" + projectWorkspaceId)));
  // A path a person hovers is the folder's, too: the tree is addressed by the routing path but titled by the folder.
  const fileTitles = await page.locator("[title]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")).filter((title) => title?.includes("report.csv")));
  check(fileTitles.length > 0 && fileTitles.every((title) => title?.startsWith(projectFolderRoot)),
    "a file's tooltip names the folder it is in: " + JSON.stringify(fileTitles));

  check(pageErrors.length === 0, "the page raised no errors: " + pageErrors.join("; "));

  await context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) await stop(child);
  if (endpoint) await endpoint.close().catch(() => {});
  if (!keep) rmSync(artifacts, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("\n" + failures.length + " UX-514 workspace routing check(s) FAILED:");
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log("\nUX-514 workspace routing regression passed");
