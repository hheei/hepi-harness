/**
 * Ticket 11 regression: the worktree picker in the browser, driven through the real production UI.
 *
 * The whole path is the user's: the project and worktree boxes of the bar above a fresh composer and of the files tab,
 * "New worktree…", the checkout it creates, the conversation that starts in it, and the removal of a checkout with
 * uncommitted work — refused once, then forced. Four processes, as a deployment composes them:
 *
 *   this script  ->  Next.js (Web UI, loopback)  ->  backend process (apps/server/src/main.ts)
 *                ->  gateway process (packages/gateway/src/main.ts)  ->  a real git repository on this host
 *
 * The turn that follows is answered by a controlled OpenAI-completions endpoint (this script's own HTTP server), so
 * the model really asks for the `bash` tool and the assertions are about where that tool actually ran: a marker file
 * inside the created checkout, and the checkout's own directory printed by `pwd`. Nothing here re-implements a host
 * capability — git, the checkout and the removal are the gateway's own work.
 *
 * Assertions, in order:
 *   1. the worktree box names the main checkout, and the list marks it as main from the host's own answer;
 *   2. "New worktree…" adds the checkout to the list without a page reload, records it as a folder of the project, and
 *      moves the composer into it;
 *   3. the conversation created there runs bash inside the created checkout;
 *   4. a dirty checkout is refused with the picker's own question, and Force is a separate action that removes it;
 *   5. after the removal the checkout is gone from the host, out of the project's folders, and out of the list — while
 *      the conversation already bound to it keeps running;
 *   6. a checkout whose directory was deleted behind git's back falls back to the project root instead of breaking the
 *      list;
 *   7. a host that cannot serve worktrees shows a named limit, and the project box keeps working.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-worktree-picker.mjs [--keep]
 *        HEPI_UX11_WEB_PORT=<port> HEPI_UX11_BACKEND_PORT=<port> HEPI_UX11_GATEWAY_PORT=<port>
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const runGit = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-worktree-picker-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux11-"));
const dataDir = join(artifacts, "data");
const legacyRoot = join(artifacts, "legacy-workspace");
const repositoryRoot = join(artifacts, "app");
mkdirSync(dataDir, { recursive: true });
mkdirSync(legacyRoot, { recursive: true });
mkdirSync(join(artifacts, "gateway-home"), { recursive: true });
mkdirSync(join(artifacts, "backend-home"), { recursive: true });
// A real repository with one commit: the host's own git creates and removes the checkouts under test.
mkdirSync(repositoryRoot, { recursive: true });
await runGit("git", ["init", "-q", repositoryRoot]);
await runGit("git", ["-C", repositoryRoot, "config", "user.email", "test@example.com"]);
await runGit("git", ["-C", repositoryRoot, "config", "user.name", "Test"]);
writeFileSync(join(repositoryRoot, "README.md"), "baseline\n");
await runGit("git", ["-C", repositoryRoot, "add", "README.md"]);
await runGit("git", ["-C", repositoryRoot, "commit", "-qm", "baseline"]);
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

// ---------------------------------------------------------------- the controlled model endpoint

/**
 * One OpenAI-completions endpoint answering from a script: each request takes the next step, so the model's tool calls
 * are decided here and the tools themselves run for real on the gateway.
 */
function controlledEndpoint(modelId) {
  const script = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const step = script.shift();
      const frame = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      const base = { id: "chatcmpl-ux11", object: "chat.completion.chunk", created: 1, model: modelId };
      const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (step === undefined) {
        frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "no scripted response left" }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      } else if (step.kind === "tool") {
        frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: step.id, type: "function", function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
      } else {
        frame({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] });
        frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
      }
      response.end("data: [DONE]\n\n");
    });
  });
  return {
    server,
    tool: (id, name, args) => script.push({ kind: "tool", id, name, arguments: args }),
    say: (text) => script.push({ kind: "text", text }),
    listen: (port) => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); }),
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
  };
}

// ---------------------------------------------------------------- the three processes

const gatewayPort = await freePort(Number(process.env.HEPI_UX11_GATEWAY_PORT ?? 0));
let gateway;
async function startGateway() {
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), {
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_PORT: String(gatewayPort),
      HEPI_GATEWAY_DATA: dataDir,
      HEPI_WORKSPACE_ID: "legacy",
      HEPI_WORKSPACE_ROOT: legacyRoot,
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

const backendPort = await freePort(Number(process.env.HEPI_UX11_BACKEND_PORT ?? 0));
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
      HEPI_WORKSPACE_ID: "legacy",
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

/** Submit one prompt and read the event stream until the answer that ends the turn settles. */
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
        if (!Array.isArray(current.entries)) continue;
        if (!current.busy && current.entries.some((entry) => entry.role === "assistant" && entry.text === expected)) return current;
      }
    }
  } finally { await reader.cancel(); }
}

const projects = async () => (await api("/api/projects?hostId=workstation")).projects;
const folderAt = (project, root) => project.folders.find((folder) => folder.root === root);

let browser;
let web;
let webOrigin;
let endpoint;
let page;

/** The worktree box of the picker in the layout under test. */
const worktreeBox = (layout) => page.locator(`.project-picker.is-${layout} .project-picker-button:not(.is-project)`);
const projectBox = (layout) => page.locator(`.project-picker.is-${layout} .project-picker-button.is-project`);
const menuItem = (name) => page.locator(".sidebar-menu").getByRole("menuitem", { name, exact: true });
/** The choices the open menu lists — a worktree row is a radio, a project row a radio, an action a plain item. */
const menuChoices = () => page.locator(".sidebar-menu [role=menuitemradio]");
/** The worktree rows the open menu lists, read from the menu itself rather than from the API. */
const listedWorktrees = async () => (await menuChoices().allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
/** Waits for the open menu to list exactly this many checkout choices. */
const waitForList = (count) => page.locator(`.sidebar-menu [role=menuitemradio]`).nth(count - 1).waitFor({ timeout: 30_000 });
/**
 * Waits for a real host effect, by asking the filesystem. Every wait here is an observable state — the directory is
 * there or it is not — so nothing depends on a fixed delay.
 */
async function waitForPath(path, present, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) === present) return true;
    await delay(50);
  }
  return existsSync(path) === present;
}

try {
  const endpointPort = await freePort();
  endpoint = controlledEndpoint("controlled-1");
  await endpoint.listen(endpointPort);
  const endpointOrigin = "http://127.0.0.1:" + endpointPort;

  gateway = await startGateway();
  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UX11_WEB_PORT ?? 0));
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

  // The project under test: a real git repository recorded through the public route, as the New Project dialog does.
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ hostId: "workstation", name: "App", folders: [{ root: repositoryRoot, default: true }] }) });
  assert.ok(created?.project?.folders?.[0]?.workspaceId, "the project was recorded: " + JSON.stringify(created));
  const mainWorkspaceId = created.project.folders[0].workspaceId;
  const projectCwd = "/workspace/" + mainWorkspaceId;

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // A fresh composer in the project's main checkout: the bar above it is the inline picker.
  await page.goto(webOrigin + "/?cwd=" + encodeURIComponent(projectCwd), { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  // The box appears once the sidebar has resolved the project and the host has answered its checkout list.
  await worktreeBox("inline").waitFor({ timeout: 30_000 });
  check(true, "the bar above a fresh composer offers the worktree box");

  // 1. The list comes from the host: the main checkout is marked, and it is the one in use.
  await worktreeBox("inline").click();
  await page.locator(".sidebar-menu.is-classic").waitFor();
  await waitForList(1);
  check((await listedWorktrees()).length === 1 && (await listedWorktrees())[0].includes("main"), "the list marks the main checkout: " + JSON.stringify(await listedWorktrees()));
  check((await worktreeBox("inline").innerText()).includes("main"), "the box names the checkout in use as main: " + JSON.stringify(await worktreeBox("inline").innerText()));

  // 2. "New worktree…" creates one on a branch, and the list and the box follow without a page reload.
  await menuItem("New worktree…").click();
  await page.locator(".sidebar-worktree-input").fill("feature/one");
  await page.locator(".sidebar-worktree-create").click();
  const createdPath = join(artifacts, "app-worktrees", "feature-one");
  await page.locator(".sidebar-menu.is-classic").waitFor({ state: "detached" });
  check(existsSync(createdPath), "the host created the checkout on the branch: " + createdPath);
  check((await worktreeBox("inline").innerText()).includes("feature/one"), "the box moved to the created checkout without a page reload: " + JSON.stringify(await worktreeBox("inline").innerText()));
  const afterCreate = await projects();
  const featureFolder = folderAt(afterCreate[0], createdPath);
  check(featureFolder !== undefined, "the created checkout is recorded as a folder of the project");
  check(afterCreate[0].defaultFolderId === created.project.folders[0].id, "and the project's default folder is untouched");
  await worktreeBox("inline").click();
  await page.locator(".sidebar-menu.is-classic").waitFor();
  await waitForList(2);
  check((await listedWorktrees()).length === 2 && (await listedWorktrees()).some((row) => row.includes("feature/one")), "the created checkout is in the list: " + JSON.stringify(await listedWorktrees()));
  await page.keyboard.press("Escape");

  // 3. A conversation created in that checkout runs its tools inside it.
  const marker = "worktree-marker-" + Date.now();
  endpoint.tool("call-bash-write", "bash", { command: "printf " + marker + " > marker.txt" });
  endpoint.tool("call-bash-pwd", "bash", { command: "pwd" });
  endpoint.say("worktree turn done");
  await page.locator("textarea").first().fill("work in the new checkout");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("worktree turn done").waitFor({ timeout: 60_000 });
  check(readFileSync(join(createdPath, "marker.txt"), "utf8") === marker, "bash ran inside the created checkout");
  check(!existsSync(join(repositoryRoot, "marker.txt")), "and not in the main checkout");
  let bound;
  for (let attempt = 0; attempt < 100 && bound === undefined; attempt += 1) {
    bound = (await api("/api/conversations")).conversations.find((item) => item.workspaceId === featureFolder.workspaceId);
    if (bound === undefined) await delay(100);
  }
  check(bound !== undefined, "the conversation is bound to the created checkout's own workspace");
  const state = await api("/api/conversations/" + bound.id + "/state");
  check(state.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === createdPath), "the transcript shows the checkout the tools ran in");

  // 4. The files tab's picker removes a checkout, and a dirty one is refused with its own question first.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await projectBox("stacked").waitFor();
  await worktreeBox("stacked").click();
  await page.locator(".sidebar-menu.is-classic").waitFor();
  await waitForList(2);
  check((await listedWorktrees()).length === 2, "the files tab lists both checkouts: " + JSON.stringify(await listedWorktrees()));
  writeFileSync(join(createdPath, "uncommitted.txt"), "work in progress\n");
  await page.locator(`.sidebar-menu .sidebar-menu-secondary[aria-label="Remove worktree checkout ${createdPath}; the branch is kept"]`).click();
  const force = page.locator(".sidebar-menu .sidebar-worktree-force");
  await force.waitFor({ timeout: 30_000 });
  check(await force.isVisible(), "a dirty checkout is refused with the picker's own question and a Force action");
  check(existsSync(join(createdPath, "uncommitted.txt")), "nothing was discarded before the force");
  check((await projects())[0].folders.length === 2, "and the project's folders are untouched by the refusal");

  // 5. Force is a separate action: the checkout goes, its folder record goes with it, and the list follows.
  await force.click();
  // The forced removal answers by going back to the list, which the picker fetched again; the checkout's own
  // directory disappearing is the host effect the removal really had.
  await waitForList(1);
  check(await waitForPath(createdPath, false), "the forced removal removed the checkout from the host");
  check((await listedWorktrees()).length === 1 && (await listedWorktrees())[0].includes("main"), "the removed checkout left the list: " + JSON.stringify(await listedWorktrees()));
  await page.keyboard.press("Escape");
  check((await projects())[0].folders.length === 1, "the removed checkout left the project's folders");
  const workspaces = (await api("/api/workspaces")).workspaces;
  check(workspaces.find((workspace) => workspace.id === featureFolder.workspaceId)?.retained === true, "and its binding is retained for the conversation that holds it");
  // The conversation keeps its binding: the workspace it holds still resolves, and its next turn is answered in that
  // workspace — which the removal emptied — rather than being silently retargeted at the project root, where the same
  // command would have run in the wrong place.
  endpoint.tool("call-bash-retained", "bash", { command: "printf retained-marker > marker.txt" });
  endpoint.say("retained turn done");
  const kept = await runTurn(bound.id, "still there?", "after-removal", "retained turn done");
  check(kept.workspaceId === featureFolder.workspaceId, "the conversation keeps its workspace after the checkout is gone");
  check(!existsSync(join(repositoryRoot, "marker.txt")), "and its turn did not run in the main checkout instead");

  // 6. A checkout whose directory was deleted behind git's back falls back to the project root.
  const second = await api("/api/worktrees", { method: "POST", body: JSON.stringify({ workspaceId: mainWorkspaceId, operation: "create", branch: "gone" }) });
  assert.ok(second?.value?.path, "a second checkout was created: " + JSON.stringify(second));
  rmSync(second.value.path, { recursive: true, force: true });
  await worktreeBox("stacked").click();
  await page.locator(".sidebar-menu.is-classic").waitFor();
  await waitForList(1);
  check((await listedWorktrees()).length === 1 && (await listedWorktrees())[0].includes("main"), "a vanished checkout does not break the list: " + JSON.stringify(await listedWorktrees()));
  await page.keyboard.press("Escape");

  // 7. A host that cannot serve worktrees shows a named limit, and the rest of the picker keeps working.
  await page.route("**/api/worktrees**", (route) => route.fulfill({
    status: 501,
    contentType: "application/json",
    body: JSON.stringify({ code: "not_supported", error: "this host cannot serve worktree operations" }),
  }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const hint = page.locator(".project-picker.is-stacked .project-picker-button.is-inactive");
  await hint.waitFor({ timeout: 30_000 });
  // The box first says the list is being checked; the host's limit replaces that once the answer arrives.
  await page.locator(".project-picker.is-stacked .project-picker-button.is-inactive", { hasText: "Worktrees unavailable" }).waitFor({ timeout: 30_000 });
  const hintText = ((await hint.textContent()) ?? "").trim();
  check(hintText === "Worktrees unavailable", "a host limit is shown as a named limit: " + JSON.stringify(hintText));
  check(((await hint.getAttribute("title")) ?? "").includes("cannot serve worktree operations"), "and names the host's own reason: " + JSON.stringify(await hint.getAttribute("title")));
  await projectBox("stacked").click();
  await page.locator(".sidebar-menu.is-classic").waitFor();
  const projectMenu = (await page.locator(".sidebar-menu").innerText()).trim();
  check((await page.locator(".sidebar-menu [role=menuitemradio]").count()) > 0 && projectMenu.includes("Use default directory"), "the project box still works while the host limit stands: " + JSON.stringify(projectMenu));
  await page.keyboard.press("Escape");

  check(pageErrors.length === 0, "the shell mounted without a page error: " + pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child);
  await endpoint?.close().catch(() => {});
  if (!keep && failures.length === 0) rmSync(artifacts, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failed:");
  for (const message of failures) console.log("  - " + message);
  process.exit(1);
}
console.log("\nAll worktree picker checks passed. Artifacts: " + artifacts);
