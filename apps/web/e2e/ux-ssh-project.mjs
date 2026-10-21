/**
 * Ticket 09 regression: an SSH New Remote Project, driven through the real UI.
 *
 * The whole path is the user's: the sidebar's "New Project…" dialog, a remote execution host chosen from the
 * configured targets, a folder chosen from that host's own directories, Create Project, and the first conversation
 * running its tools there. The turn is answered by a controlled OpenAI-completions endpoint (this script's own HTTP
 * server), so the model really asks for the `bash` and `read` tools and the assertions are about where they ran.
 *
 * Four processes, as a deployment composes them:
 *   this script  ->  client ingress (packages/gateway/src/ingress/main.ts, loopback: it serves the built Web page and
 *                    forwards `/api` to the backend under its own service credential)
 *                ->  backend process (apps/server/src/main.ts)
 *                ->  SSH gateway process (packages/gateway/src/main.ts)  ->  a real OpenSSH daemon on loopback
 *                    -> the chosen remote directory
 *
 * The page is the production Vite build (`apps/web/dist`) and its origin is the ingress, so the login cookie, the
 * `/api` forwarding and the host resolution are the deployed ones. This origin states **no** default execution host
 * (`HEPI_INGRESS_DEFAULT_HOST` is left out): a remote target is named by the caller and by nothing else, which is the
 * same deployment fact the retired Next origin stated with `HEPI_WEB_LOCAL_GATEWAY_ID`.
 *
 * The SSH host is a real \`sshd\` with its own host key, user key and pinned known-hosts file (the fixture
 * \`packages/client/scripts/smoke-pack.mjs\` uses for its SSH check). No mock transport stands in for it, and no
 * remote credential is required beyond the generated key. Two configured gateway connections, each with its own
 * profile and root on that host, prove the chosen profile is the one that runs.
 *
 * Assertions, in order:
 *   1. the dialog offers the configured remote targets and names the account the chosen host itself reports;
 *   2. the picker lists that host's real remote directories, and the project records the chosen profile;
 *   3. the first conversation runs bash in the chosen remote folder, reads the remote file of a name that also exists
 *      locally, and is refused the local path — the same relative name resolves to the remote copy;
 *   4. the remote folder holds the marker the shell wrote and no local directory does;
 *   5. the project is one sidebar group and its own new-session affordance binds the remote default folder;
 *   6. a bare SSH gateway restart still executes that conversation's tools, without creating another conversation;
 *   7. a project on the second configured profile reads the second profile's file, so neither profile answers for the
 *      other;
 *   8. a page reload and a backend restart keep the project, its profile and its remote folder.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-ssh-project.mjs [--keep]
 *        HEPI_UX09_WEB_PORT=<port> HEPI_UX09_BACKEND_PORT=<port> HEPI_UX09_GATEWAY_PORT=<port>
 *        HEPI_UX09_PAGE_DIST=<dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sshdAvailable, startSshdFixture } from "../../../packages/gateway/test/sshd-fixture.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-ssh-project-token";
// The Web login material this ingress admits. It is not the backend's service credential: a page proves it is a page,
// and the ingress proves it may ask the backend.
const webLogin = "ux-ssh-project-web-login";
const keep = process.argv.includes("--keep");
// The build the ingress serves. `dist`, because `@hepi/web` is a Vite app: an assertion naming `.next` here would be
// advice no command can follow.
const pageDist = process.env.HEPI_UX09_PAGE_DIST ?? join(webRoot, "dist");
assert.ok(existsSync(join(pageDist, "index.html")), "build first: pnpm --filter @hepi/web build (the ingress serves " + pageDist + ")");
assert.ok(sshdAvailable(), "this regression needs a local sshd, ssh-keygen and a bwrap sandbox");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux09-"));
const dataDir = join(artifacts, "data");
const localRoot = join(artifacts, "local-workspace");
// The same relative name on both computers, with different content: which copy a tool reads is the proof of where it
// ran. The local file is what the backend process and this machine can see; the remote one is what the host holds.
const localFolder = join(localRoot, "alpha");
mkdirSync(dataDir, { recursive: true });
mkdirSync(localFolder, { recursive: true });
mkdirSync(join(artifacts, "gateway-home"), { recursive: true });
mkdirSync(join(artifacts, "backend-home"), { recursive: true });
writeFileSync(join(localFolder, "note.txt"), "note on the local computer");
const localNote = join(localFolder, "note.txt");
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
 * are decided here and the tools themselves run for real on the gateway. A request that arrives with no step left is
 * an error the turn reports, not a silent pass.
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
      const base = { id: "chatcmpl-ux09", object: "chat.completion.chunk", created: 1, model: modelId };
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
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// ---------------------------------------------------------------- the real SSH host and the three child processes

const sshd = await startSshdFixture();
// One directory per configured profile on the same host, so the two profiles are told apart by their own roots.
const remoteProdRoot = join(sshd.root, "prod");
const remoteStagingRoot = join(sshd.root, "staging");
const remoteFolder = join(remoteProdRoot, "alpha");
const stagingFolder = join(remoteStagingRoot, "beta");
mkdirSync(remoteFolder, { recursive: true });
mkdirSync(stagingFolder, { recursive: true });
writeFileSync(join(remoteFolder, "note.txt"), "note on the ssh host");
writeFileSync(join(stagingFolder, "note.txt"), "note on the staging profile");
const realRemoteFolder = realpathSync(remoteFolder);
const realStagingFolder = realpathSync(stagingFolder);
// The profile roots themselves are what the remote host lists: each holds exactly its own project folder.
const realProdRoot = realpathSync(remoteProdRoot);
const realStagingRoot = realpathSync(remoteStagingRoot);

const gatewayPort = await freePort(Number(process.env.HEPI_UX09_GATEWAY_PORT ?? 45109));
const stagingGatewayPort = await freePort(gatewayPort + 1);

/** One packaged SSH gateway: the same entrypoint a deployment runs, configured from the environment. */
async function startSshGateway(options) {
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), {
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: options.id,
      HEPI_GATEWAY_PORT: String(options.port),
      HEPI_GATEWAY_DATA: join(dataDir, "gateway-" + options.id),
      HEPI_WORKSPACE_ROOT: options.remoteRoot,
      HEPI_ALLOWED_COMMANDS: "bash",
      HEPI_SSH_HOST: sshd.host,
      HEPI_SSH_PORT: String(sshd.port),
      HEPI_SSH_PROFILE: options.profile,
      HEPI_SSH_IDENTITY: sshd.identityFile,
      HEPI_SSH_KNOWN_HOSTS: sshd.knownHostsFile,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + options.port;
  assert.ok(await waitForHttp(origin + "/v1/files", { authorization: "Bearer " + token, "content-type": "application/json" }, 60_000), "the SSH gateway " + options.id + " started: " + log().slice(-500));
  return { child, origin, log, id: options.id, port: options.port };
}

let prodGateway = await startSshGateway({ id: "ssh-prod", profile: "prod", remoteRoot: remoteProdRoot, port: gatewayPort });
const stagingGateway = await startSshGateway({ id: "ssh-staging", profile: "staging", remoteRoot: remoteStagingRoot, port: stagingGatewayPort });

const backendPort = await freePort(Number(process.env.HEPI_UX09_BACKEND_PORT ?? 44109));
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
      // The deployment's configured gateway connections, each reached at the address this process resolves. The
      // profile of each lives on its own gateway, so a project names both explicitly and no credential crosses to the
      // browser. The workspace binding below is this deployment's own configured SSH workspace, which is what makes
      // the coding tools available; it is the legacy \`remote-<profile>\` id and stays unchanged.
      HEPI_GATEWAYS: JSON.stringify([
        { id: "ssh-prod", url: prodGateway.origin, token },
        { id: "ssh-staging", url: stagingGateway.origin, token },
      ]),
      HEPI_WORKSPACE_ID: "remote-prod",
      HEPI_GATEWAY_ID: "ssh-prod",
      HEPI_GATEWAY_URL: prodGateway.origin,
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

/**
 * Submit one prompt and read the event stream until the answer that ends the turn has settled.
 *
 * A `state` frame is either the whole window or the entries appended to the window this stream already holds, and a
 * `submission` frame is neither, so the answer is read from both shapes. A driver that looked only at `entries` would
 * wait for a turn that lands in a delta — which is what a settled answer always is once the baseline has been sent.
 */
async function runTurn(conversationId, text, requestId, expected) {
  const path = backend.origin + "/api/conversations/" + conversationId;
  const reader = (await fetch(path + "/events", { headers, signal: AbortSignal.timeout(180_000) })).body.getReader();
  try {
    const submitted = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
    assert.equal(submitted.status, 202);
    const decoder = new TextDecoder();
    let pending = "";
    let held = [];
    let scalars = {};
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
        const { entries, appended, ...rest } = JSON.parse(line.slice(6));
        if (Array.isArray(entries)) held = entries;
        else if (Array.isArray(appended)) held = [...held, ...appended];
        else continue;
        scalars = rest;
        if (rest.busy === false && held.some((entry) => entry.role === "assistant" && entry.text === expected)) return { ...scalars, entries: held };
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
  const endpointOrigin = "http://127.0.0.1:" + endpointPort;

  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 60_000), "the backend started: " + backend.log().slice(-500));

  // The page's origin is the client ingress: one listener serving the built page and forwarding `/api`, which is what a
  // deployment runs. No default host is stated, so this origin serves no local execution host and the remote targets are
  // named explicitly by the deployment's configured gateways instead of being guessed from this origin.
  const webPort = await freePort(Number(process.env.HEPI_UX09_WEB_PORT ?? 43109));
  web = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_INGRESS_HOST: "127.0.0.1",
      HEPI_INGRESS_PORT: String(webPort),
      HEPI_INGRESS_BACKEND: backend.origin,
      HEPI_INGRESS_SERVICE_TOKEN: token,
      HEPI_WEB_LOGIN_TOKEN: webLogin,
      HEPI_INGRESS_STATIC_DIR: pageDist,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the client ingress started: " + webLog().slice(-500));
  // The page it serves is the build under test, not a stand-in: a listener whose static directory is wrong answers 404
  // here and would leave every later assertion describing nothing.
  const shell = await fetch(webOrigin + "/");
  assert.ok(shell.ok && (shell.headers.get("content-type") ?? "").includes("text/html"), "the ingress does not serve the Web build at " + pageDist);
  await shell.body?.cancel();

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  // The login form is the deployment's own gate: the ingress admits this material as the Web session's cookie. It is a
  // render, so it is waited for rather than sampled once after `domcontentloaded` — a page whose gate was skipped would
  // spend the rest of the run describing a 401.
  const password = page.locator('input[type="password"]');
  try {
    await password.waitFor({ state: "visible", timeout: 45_000 });
  } catch {
    /* The origin already admitted this session: the shell is showing. */
  }
  if (await password.count()) {
    await password.fill(webLogin);
    await page.locator('button[type="submit"]').click();
    await page.getByRole("button", { name: "New Project…", exact: true }).waitFor({ timeout: 45_000 });
  }
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  await page.getByRole("button", { name: "New Project…", exact: true }).waitFor();

  // 1. The dialog offers the configured remote targets, and the picker lists that host's own directories.
  await page.getByRole("button", { name: "New Project…", exact: true }).click();
  const dialog = page.locator(".new-project-panel");
  await dialog.waitFor();
  const targetSelect = page.locator(".new-project-target");
  await targetSelect.waitFor();
  const targetLabels = await targetSelect.locator("option").allTextContents();
  check(targetLabels.length === 3, "the dialog offers this computer and both configured remote profiles: " + JSON.stringify(targetLabels));
  check(targetLabels.some((label) => label.includes(sshd.host) && label.includes("prod")), "the remote prod target names its host and profile");
  check(targetLabels.some((label) => label.includes(sshd.host) && label.includes("staging")), "the remote staging target names its host and profile");

  await targetSelect.selectOption({ label: targetLabels.find((label) => label.includes("prod")) });
  await page.locator(".new-project-host").filter({ hasText: "Remote · " }).waitFor();
  const hostLabel = (await page.locator(".new-project-host").textContent()) ?? "";
  check(hostLabel.includes(sshd.user) && hostLabel.includes("prod"), "the dialog names the account the remote host itself reports: " + JSON.stringify(hostLabel));

  /**
   * Choose one folder in the target host's own picker: navigate to its parent, click the child the host lists, then
   * select it. The dialog is left open with it added, and the number of directories the host listed is returned.
   */
  const addFolder = async (parentPath, root) => {
    await page.locator(".new-project-add-folder").click();
    const picker = page.locator(".directory-picker-panel");
    await picker.waitFor();
    await page.locator(".directory-picker-path").first().fill(parentPath);
    await page.locator(".directory-picker-panel button[type=submit]").click();
    await page.locator('.directory-picker-entry[title="' + root + '"]').waitFor();
    const listed = await page.locator(".directory-picker-entry").count();
    await page.locator('.directory-picker-entry[title="' + root + '"]').click();
    // Wait for the host's answer to that directory before selecting it: the path field only holds the directory the
    // host confirmed, so selecting it is selecting that directory rather than the one the picker opened on.
    await page.waitForFunction((expected) => document.querySelector(".directory-picker-path")?.value === expected, root);
    await page.locator(".directory-picker-footer").getByRole("button", { name: "Select this folder", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    return listed;
  };

  // The remote host's own listing: the parent directory holds the profile roots, and the local folder of this machine
  // is not among them.
  check(await addFolder(realProdRoot, realRemoteFolder) >= 1, "the picker lists the remote host's own directories");
  check((await page.locator(".new-project-folder").first().textContent()) === realRemoteFolder, "the dialog shows the chosen remote folder");
  check(!existsSync(join(localRoot, "marker.txt")), "choosing a folder creates nothing locally");

  await page.locator(".new-project-name").fill("Remote Project");
  await page.locator(".new-project-create").click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("textarea").first().waitFor();
  check((await page.locator(".session-tree-group").filter({ hasText: "Remote Project" }).count()) > 0, "the sidebar lists the project by its display name");

  const projects = await api("/api/projects");
  const project = projects.projects.find((item) => item.name === "Remote Project");
  check(project !== undefined, "the remote project is recorded");
  const defaultFolder = project.folders.find((folder) => folder.id === project.defaultFolderId);
  check(project.hostId === "ssh-prod" && project.profileId === "prod", "the project records the configured gateway and its profile");
  check(defaultFolder.root === realRemoteFolder && defaultFolder.default === true, "its default folder is the remote directory chosen");
  check(!defaultFolder.root.includes(defaultFolder.workspaceId) && defaultFolder.workspaceId !== project.id, "the workspace id is opaque and independent of the remote path");

  // 2. The first conversation: bash and read really run on the SSH host.
  const marker = "remote-marker-" + Date.now();
  endpoint.tool("call-ssh-bash-write", "bash", { command: "printf " + marker + " > marker.txt" });
  endpoint.tool("call-ssh-bash-pwd", "bash", { command: "pwd" });
  endpoint.tool("call-ssh-read", "read", { path: "note.txt" });
  endpoint.tool("call-ssh-read-local", "read", { path: localNote });
  endpoint.say("remote turn done");
  await page.locator("textarea").first().fill("work in the remote project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("remote turn done").waitFor({ timeout: 90_000 });
  check(readFileSync(join(remoteFolder, "marker.txt"), "utf8") === marker, "bash ran in the chosen remote folder");
  check(!existsSync(join(localRoot, "marker.txt")), "nothing was written to the local workspace");

  let bound;
  for (let attempt = 0; attempt < 100 && bound === undefined; attempt += 1) {
    bound = (await api("/api/conversations")).conversations.find((item) => item.workspaceId === defaultFolder.workspaceId);
    if (bound === undefined) await delay(100);
  }
  check(bound !== undefined, "the first conversation is bound to the remote default folder");
  const state = await api("/api/conversations/" + bound.id + "/state");
  check(state.entries.some((entry) => entry.role === "toolResult" && entry.text.split("\n")[0] === realRemoteFolder), "the transcript shows the remote folder the tools ran in");
  check(state.entries.some((entry) => entry.role === "toolResult" && entry.text === "note on the ssh host"), "read returned the remote copy of a name that also exists locally");
  const localRead = state.entries.find((entry) => entry.role === "toolResult" && entry.text.includes("note.txt"));
  check(localRead === undefined || localRead.message?.isError === true || localRead.text !== "note on the local computer", "the local file of that name is not what the remote conversation read");
  check(readFileSync(localNote, "utf8") === "note on the local computer", "the local copy was left untouched");

  // 3. The project is one group, and its own new-session affordance binds the remote default folder.
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  const groupRow = page.locator(".session-tree-group", { hasText: "Remote Project" });
  const groupNew = groupRow.getByRole("button", { name: "New session in Remote Project", exact: true });
  const known = new Set((await api("/api/conversations")).conversations.map((item) => item.id));
  await groupRow.hover();
  await groupNew.click();
  await page.locator("textarea").first().waitFor();
  endpoint.tool("call-group-pwd", "bash", { command: "pwd" });
  endpoint.say("group turn done");
  await page.locator("textarea").first().fill("start in the project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("group turn done").waitFor({ timeout: 90_000 });
  let fromGroup;
  for (let attempt = 0; attempt < 100 && fromGroup === undefined; attempt += 1) {
    fromGroup = (await api("/api/conversations")).conversations.find((item) => !known.has(item.id));
    if (fromGroup === undefined) await delay(100);
  }
  check(fromGroup !== undefined && fromGroup.workspaceId === defaultFolder.workspaceId, "the group's own new session binds the remote default folder");

  // 4. A bare SSH gateway restart: the backend and the browser stay up, no conversation is created, and the existing
  // conversation executes on the remote host again.
  await stop(prodGateway.child);
  prodGateway = await startSshGateway({ id: "ssh-prod", profile: "prod", remoteRoot: remoteProdRoot, port: prodGateway.port });
  endpoint.tool("call-ssh-restart-pwd", "bash", { command: "pwd" });
  endpoint.tool("call-ssh-restart-read", "read", { path: "marker.txt" });
  endpoint.say("after the ssh restart");
  const afterRestart = await runTurn(bound.id, "still there?", "ssh-restart-turn-1", "after the ssh restart");
  check(afterRestart.workspaceId === defaultFolder.workspaceId, "the conversation keeps its remote folder after the gateway restarted");
  check(afterRestart.entries.some((entry) => entry.role === "toolResult" && entry.text.split("\n")[0] === realRemoteFolder), "its tools run on the remote host again without a new conversation");
  check(afterRestart.entries.some((entry) => entry.role === "toolResult" && entry.text === marker), "the remote file the shell wrote is still what the host serves");
  check((await api("/api/conversations")).conversations.length === known.size + 1, "the restart created no conversation");

  // 5. A project on the second configured profile reads that profile's file, so neither profile answers for the other.
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "New Project…", exact: true }).click();
  await dialog.waitFor();
  // The targets come from the backend's configured gateways, so the select appears once that listing has arrived.
  await page.locator(".new-project-target").waitFor();
  const stagingLabels = await page.locator(".new-project-target option").allTextContents();
  await page.locator(".new-project-target").selectOption({ label: stagingLabels.find((label) => label.includes("staging")) });
  await page.waitForFunction(() => (document.querySelector(".new-project-host")?.textContent ?? "").startsWith("Remote · "));
  await addFolder(realStagingRoot, realStagingFolder);
  await page.locator(".new-project-name").fill("Staging Project");
  await page.locator(".new-project-create").click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("textarea").first().waitFor();
  const stagingProject = (await api("/api/projects")).projects.find((item) => item.name === "Staging Project");
  check(stagingProject !== undefined && stagingProject.hostId === "ssh-staging" && stagingProject.profileId === "staging", "the second project records its own gateway and profile");
  check(stagingProject.folders.find((folder) => folder.id === stagingProject.defaultFolderId).root === realStagingFolder, "its default folder is on the staging profile's own root");

  endpoint.tool("call-staging-read", "read", { path: "note.txt" });
  endpoint.say("staging turn done");
  await page.locator("textarea").first().fill("work on staging");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("staging turn done").waitFor({ timeout: 90_000 });
  let stagingBound;
  for (let attempt = 0; attempt < 100 && stagingBound === undefined; attempt += 1) {
    stagingBound = (await api("/api/conversations")).conversations.find((item) => item.workspaceId === stagingProject.folders.find((folder) => folder.id === stagingProject.defaultFolderId).workspaceId);
    if (stagingBound === undefined) await delay(100);
  }
  const stagingState = stagingBound === undefined ? { entries: [] } : await api("/api/conversations/" + stagingBound.id + "/state");
  check(stagingState.entries.some((entry) => entry.role === "toolResult" && entry.text === "note on the staging profile"), "the staging conversation read the staging profile's file, not the prod one");

  // 6. A page reload and a backend restart keep the project, its profile and its remote folder.
  await stop(backend.child);
  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 60_000), "the backend restarted: " + backend.log().slice(-500));
  endpoint.tool("call-ssh-backend-restart-pwd", "bash", { command: "pwd" });
  endpoint.say("after the backend restarted");
  const afterBackendRestart = await runTurn(bound.id, "after the backend restarted", "ssh-backend-restart-1", "after the backend restarted");
  check(afterBackendRestart.workspaceId === defaultFolder.workspaceId, "the conversation keeps its remote folder after the backend restarted");
  const reloaded = await api("/api/projects");
  const reloadedProject = reloaded.projects.find((item) => item.id === project.id);
  check(reloadedProject !== undefined && reloadedProject.profileId === "prod", "the project keeps its recorded profile across the restart");
  check(reloadedProject.folders.find((folder) => folder.id === reloadedProject.defaultFolderId).root === realRemoteFolder, "and its remote default folder");

  check(pageErrors.length === 0, "the page raised no errors: " + pageErrors.join(" | "));
} catch (error) {
  failures.push("threw: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  await stop(web);
  await stop(backend?.child);
  await stop(prodGateway?.child);
  await stop(stagingGateway?.child);
  await endpoint?.close().catch(() => {});
  await sshd?.stop().catch(() => {});
  if (failures.length === 0 && !keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("Artifacts kept: " + artifacts);
}

if (failures.length > 0) {
  console.error("UX-09 SSH project regression failed: " + failures.join(" | "));
  process.exit(1);
}
console.log("UX-09 SSH project regression passed");
