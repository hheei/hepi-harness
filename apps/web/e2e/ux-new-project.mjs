/**
 * Tickets 07 and 08 regression: New Project on the Web host, driven through the real UI.
 *
 * The whole path is the user's: the sidebar's "New Project…" dialog, a project name, a folder chosen from the Web
 * host's own directories, Create Project, and the first conversation starting in that folder. The turn that follows is
 * answered by a controlled OpenAI-completions endpoint (this script's own HTTP server), so the model really asks for
 * the `bash` and `read` tools and the assertions are about where those tools actually ran.
 *
 * Three processes, as a deployment composes them:
 *   this script  ->  Next.js (Web UI, loopback)  ->  backend process (apps/server/src/main.ts)
 *                ->  gateway process (packages/gateway/src/main.ts)  ->  the chosen directory on this host
 *
 * `HEPI_WEB_LOCAL_GATEWAY_ID` is set on the **Web UI server**, because which gateway serves the execution host is a
 * property of the Web origin: the backend may serve several origins on different computers and its own account and
 * default workspace say nothing about any of them. The Web origin names that gateway on every host-scoped request;
 * without the name the dialog reports the configuration error instead of guessing a host. The browser never holds a
 * gateway URL or token: it asks the Web origin, which asks the backend, which asks that gateway.
 *
 * Assertions, in order:
 *   1. the dialog names the execution account the backend resolved for the Web host;
 *   2. two folders are chosen from the host's real directories, the same one twice is refused, and Create Project
 *      records one default among them without creating anything;
 *   3. the first conversation runs bash in the project's default folder, reads a file that exists only there, and is
 *      refused a file in the project's other folder — a second folder is metadata, never another tool root;
 *   4. an existing workspace conversation keeps its own root and binding;
 *   5. a page reload and a backend + gateway restart keep both folders and the same default, and the conversation
 *      still executes in the same folder;
 *   6. a restart of the gateway alone — the backend and the browser stay up, and no conversation is created — still
 *      runs that conversation's tools in the same folder;
 *   7. the project's folders are one group, every new-session affordance of that group binds the default folder, and
 *      naming another folder the default (the metadata contract; no default-editing UI in this phase) moves new
 *      conversations to it while the conversations already bound keep their own folders.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-new-project.mjs [--keep]
 *        HEPI_UX07_WEB_PORT=<port> HEPI_UX07_BACKEND_PORT=<port> HEPI_UX07_GATEWAY_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-new-project-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux07-"));
const dataDir = join(artifacts, "data");
const legacyRoot = join(artifacts, "legacy-workspace");
const chosenRoot = join(artifacts, "chosen-project");
// A second existing folder of the same computer. It is added to the same project as metadata only: the project's
// default stays the other one, so the extra folder is never a new conversation's tool root.
const extraRoot = join(artifacts, "extra-folder");
mkdirSync(dataDir, { recursive: true });
mkdirSync(legacyRoot, { recursive: true });
mkdirSync(chosenRoot, { recursive: true });
mkdirSync(extraRoot, { recursive: true });
// The gateway's own account home: browsing starts there, so it has to be a directory that exists.
mkdirSync(join(artifacts, "gateway-home"), { recursive: true });
// A file only the chosen folder holds: the read tool's answer proves which folder the conversation is bound to.
writeFileSync(join(chosenRoot, "note.txt"), "note in the chosen folder");
// A file only the extra folder holds: a read of it from a conversation bound to the default folder must fail.
writeFileSync(join(extraRoot, "extra.txt"), "note in the extra folder");
mkdirSync(join(artifacts, "backend-home"), { recursive: true });
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
  const seen = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const step = script.shift();
      const frame = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      const base = { id: "chatcmpl-ux07", object: "chat.completion.chunk", created: 1, model: modelId };
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
    seen,
    tool: (id, name, args) => script.push({ kind: "tool", id, name, arguments: args }),
    say: (text) => script.push({ kind: "text", text }),
    listen: (port) => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); }),
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// ---------------------------------------------------------------- the two processes

const gatewayPort = await freePort(Number(process.env.HEPI_UX07_GATEWAY_PORT ?? 44107));
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

const backendPort = await freePort(Number(process.env.HEPI_UX07_BACKEND_PORT ?? 44108));
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
/** Submit one prompt and read the event stream until the answer that ends the turn has settled. */
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
  const endpointOrigin = "http://127.0.0.1:" + endpointPort;

  gateway = await startGateway();
  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UX07_WEB_PORT ?? 43107));
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backend.origin,
      HEPI_AUTH_TOKEN: token,
      // This Web origin's own execution host: it names the backend's configured gateway and sends it on every
      // host-scoped request, so two Web origins on one backend each browse and create projects on their own host.
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

  // An existing conversation in the configured workspace, recorded before any project exists.
  const legacyConversation = (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "legacy" }) })).conversationId;
  assert.equal((await api("/api/conversations/" + legacyConversation + "/state")).workspaceId, "legacy");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  await page.getByRole("button", { name: "New Project…", exact: true }).waitFor();

  // 1. The dialog, the host it names, and the folder chosen from that host's real directories.
  await page.getByRole("button", { name: "New Project…", exact: true }).click();
  const dialog = page.locator(".new-project-panel");
  await dialog.waitFor();
  const hostLabel = (await page.locator(".new-project-host").textContent()) ?? "";
  check(hostLabel.startsWith("Local · ") && !hostLabel.includes("Checking"), "the dialog names the Web host's execution account: " + JSON.stringify(hostLabel));
  await page.locator(".new-project-create").click();
  check((await page.locator(".new-project-error").textContent()) !== null, "Create Project without a folder is refused");
  check((await api("/api/projects")).projects.length === 0, "the refusal recorded no project");

  /** Choose one folder in the host's own picker; the dialog is left open with it added. */
  const addFolder = async (root) => {
    await page.locator(".new-project-add-folder").click();
    const picker = page.locator(".directory-picker-panel");
    await picker.waitFor();
    await page.locator(".directory-picker-path").first().fill(artifacts);
    await page.locator(".directory-picker-panel button[type=submit]").click();
    await page.locator('.directory-picker-entry[title="' + root + '"]').waitFor();
    // The host's own listing: the folders created here are what it shows, so it lists more than the one to pick.
    const listed = await page.locator(".directory-picker-entry").count();
    await page.locator('.directory-picker-entry[title="' + root + '"]').click();
    await page.locator(".directory-picker-footer").getByRole("button", { name: "Select this folder", exact: true }).click();
    await picker.waitFor({ state: "detached" });
    return listed;
  };

  check(await addFolder(chosenRoot) >= 2, "the picker lists the host's own directories");
  check((await page.locator(".new-project-folder").first().textContent()) === chosenRoot, "the dialog shows the chosen folder");
  check(await page.locator(".new-project-default").first().isChecked(), "the first folder starts as the project's default");
  check(!existsSync(join(artifacts, "marker.txt")), "choosing a folder creates nothing");

  // The same folder twice is refused in the dialog, before the backend sees it.
  await addFolder(chosenRoot);
  check((await page.locator(".new-project-error").textContent() ?? "").length > 0, "the same folder cannot be added twice");
  check(await page.locator(".new-project-folder").count() === 1, "the duplicate was not added");

  // A second existing folder of this computer joins the same project, and the first stays the default.
  await addFolder(extraRoot);
  check(await page.locator(".new-project-folder").count() === 2, "the second folder is listed");
  check(await page.locator(".new-project-default").first().isChecked(), "the default stays on the folder chosen first");
  check(!(await page.locator(".new-project-default").nth(1).isChecked()), "the extra folder is not the default");

  await page.locator(".new-project-name").fill("Chosen Project");
  await page.locator(".new-project-create").click();
  await dialog.waitFor({ state: "detached" });
  await page.locator("textarea").first().waitFor();
  check((await page.locator(".session-tree-group").filter({ hasText: "Chosen Project" }).count()) > 0, "the sidebar lists the project by its display name");

  const projects = await api("/api/projects");
  check(projects.projects.length === 1, "exactly one project is recorded");
  const project = projects.projects[0];
  const defaultFolder = project.folders.find((folder) => folder.id === project.defaultFolderId);
  const extraFolder = project.folders.find((folder) => folder.root === extraRoot);
  check(project.name === "Chosen Project" && project.hostId === "workstation" && project.folders.length === 2, "the project records its name, its host and both folders");
  check(defaultFolder.root === chosenRoot && defaultFolder.default === true && extraFolder.default === false, "the default folder is the one chosen first, and the extra folder is metadata");
  check(defaultFolder.workspaceId !== project.id && !defaultFolder.root.includes(defaultFolder.workspaceId), "the workspace id is opaque and independent of the path");
  check(defaultFolder.workspaceId !== extraFolder.workspaceId, "each folder has its own opaque workspace id");
  check(project.host?.user === undefined || typeof project.host?.home === "string", "the project reports the account of its host");

  // 2. A turn in the new conversation: the model asks for bash and read, and both run in the chosen folder. The shell
  // creates the conversation with the first message, so its binding is looked for after the turn settles.
  const marker = "project-marker-" + Date.now();
  endpoint.tool("call-bash-write", "bash", { command: "printf " + marker + " > marker.txt" });
  endpoint.tool("call-bash-pwd", "bash", { command: "pwd" });
  endpoint.tool("call-read", "read", { path: "note.txt" });
  // A path only the extra folder holds: the default folder's confinement refuses it, so the extra folder is metadata
  // and never an additional tool root.
  endpoint.tool("call-read-extra", "read", { path: extraRoot + "/extra.txt" });
  endpoint.say("project turn done");
  await page.locator("textarea").first().fill("work in the chosen project");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("project turn done").waitFor({ timeout: 60_000 });
  check(readFileSync(join(chosenRoot, "marker.txt"), "utf8") === marker, "bash ran in the chosen folder");
  check(!existsSync(join(legacyRoot, "marker.txt")), "nothing was written to the other workspace");

  let bound;
  for (let attempt = 0; attempt < 100 && bound === undefined; attempt += 1) {
    bound = (await api("/api/conversations")).conversations.find((item) => item.workspaceId === defaultFolder.workspaceId);
    if (bound === undefined) await delay(100);
  }
  check(bound !== undefined, "the first conversation is bound to the project's default folder");
  check((await api("/api/conversations")).conversations.every((item) => item.workspaceId !== extraFolder.workspaceId), "no conversation was bound to the extra folder");
  const state = await api("/api/conversations/" + bound.id + "/state");
  check(state.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === chosenRoot), "the transcript shows the folder the tools ran in");
  check(state.entries.some((entry) => entry.role === "toolResult" && entry.text === "note in the chosen folder"), "read returned the file that exists only in the chosen folder");
  const extraRead = state.entries.find((entry) => entry.role === "toolResult" && entry.text.includes("extra.txt"));
  check(extraRead === undefined || extraRead.message?.isError === true, "the extra folder is not a tool root: reading it from the default folder's conversation is refused");
  const catalog = await api("/api/conversations");
  check(catalog.conversations.find((item) => item.id === legacyConversation)?.workspaceId === "legacy", "the existing conversation keeps its own workspace");

  // 3. The existing workspace conversation still runs in its own root.
  endpoint.tool("call-legacy-pwd", "bash", { command: "pwd" });
  endpoint.say("legacy turn done");
  const legacyTurn = await runTurn(legacyConversation, "work in the legacy workspace", "legacy-turn-1", "legacy turn done");
  check(legacyTurn.workspaceId === "legacy", "the existing conversation still reports its own workspace");
  check(legacyTurn.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === legacyRoot), "its tools still run in the legacy root");
  check((await api("/api/conversations/" + bound.id + "/state")).workspaceId === defaultFolder.workspaceId, "creating and running elsewhere never retargeted the project conversation");

  // 4. A reload keeps the project and its name.
  await page.reload({ waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "New Project…", exact: true }).waitFor();
  const groups = page.locator(".session-tree-group");
  check((await groups.filter({ hasText: "Chosen Project" }).count()) > 0, "the project name survives a page reload");
  // Every folder of one project is one group, and no folder of it becomes a group of its own: the other groups are
  // this Web UI's own default folder and the configured workspace the legacy conversation is bound to.
  const groupNames = await groups.allInnerTexts();
  const flattened = groupNames.join(" | ");
  check(groupNames.filter((name) => name.includes("Chosen Project")).length === 1, "one group for the project: " + JSON.stringify(groupNames));
  check(!flattened.includes("chosen-project") && !flattened.includes("extra-folder"), "no folder of the project is a group of its own: " + JSON.stringify(groupNames));

  // 5. Both services restart; the recorded project is replayed and the conversation still executes where it did.
  await stop(backend.child);
  await stop(gateway.child);
  gateway = await startGateway();
  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the restarted backend started: " + backend.log().slice(-500));
  const afterRestart = await api("/api/projects");
  const restartedProject = afterRestart.projects[0];
  check(afterRestart.projects.length === 1
    && restartedProject.folders.length === 2
    && restartedProject.defaultFolderId === project.defaultFolderId
    && restartedProject.folders.every((folder) => project.folders.some((before) => before.workspaceId === folder.workspaceId && before.root === folder.root)),
    "both folders of the project survive a backend and gateway restart, the same default among them");
  const secondMarker = "second-marker-" + Date.now();
  endpoint.tool("call-bash-second", "bash", { command: "printf " + secondMarker + " > second.txt" });
  endpoint.say("after restart");
  const restartedTurn = await runTurn(bound.id, "still there?", "restart-turn-1", "after restart");
  check(restartedTurn.workspaceId === defaultFolder.workspaceId, "the conversation keeps its binding across the restart");
  const secondFile = existsSync(join(chosenRoot, "second.txt")) ? readFileSync(join(chosenRoot, "second.txt"), "utf8") : "";
  check(secondFile === secondMarker, "its tools still run in the same folder");
  if (secondFile !== secondMarker) console.log("  ..  the restarted turn: " + JSON.stringify(restartedTurn.entries.map((entry) => [entry.role, entry.text.slice(0, 200)])));

  // 6. The gateway alone restarts, on the address the backend already has. The backend and the browser stay up and no
  // conversation is created: the next request of the existing conversation is what has to restore the project's root.
  await stop(gateway.child);
  gateway = await startGateway();
  const thirdMarker = "third-marker-" + Date.now();
  endpoint.tool("call-bash-third", "bash", { command: "printf " + thirdMarker + " > third.txt" });
  endpoint.tool("call-read-third", "read", { path: "third.txt" });
  endpoint.say("after the gateway alone restarted");
  const afterGatewayRestart = await runTurn(bound.id, "still there after the gateway restarted?", "gateway-restart-turn-1", "after the gateway alone restarted");
  check(afterGatewayRestart.workspaceId === defaultFolder.workspaceId, "the existing conversation keeps its binding after the gateway alone restarts");
  const thirdFile = existsSync(join(chosenRoot, "third.txt")) ? readFileSync(join(chosenRoot, "third.txt"), "utf8") : "";
  check(thirdFile === thirdMarker, "its tools run in the same folder after the gateway alone restarts");
  check(afterGatewayRestart.entries.some((entry) => entry.role === "toolResult" && entry.text === thirdMarker), "read returns the file the same turn wrote, on the restored folder");
  if (thirdFile !== thirdMarker) console.log("  ..  the gateway-restart turn: " + JSON.stringify(afterGatewayRestart.entries.map((entry) => [entry.role, entry.text.slice(0, 200)])));

  // 7. Every new-session affordance of a recorded project starts in its default folder. The group's own "+" is one
  // of them, so a session created from the sidebar binds the default and no conversation is ever bound to the extra
  // folder. Then the default is changed through the metadata contract (PATCH; no default-editing UI in this phase) and
  // the same affordance binds the new default, while both conversations already bound keep the folders they have.
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  // The group's actions appear on hover, as the row's own controls do.
  const groupRow = page.locator(".session-tree-group", { hasText: "Chosen Project" });
  const groupNew = groupRow.getByRole("button", { name: "New session in Chosen Project", exact: true });

  /**
   * The conversation the sidebar's group "+" starts, after one turn in it settles. The new one is the id the catalog
   * did not hold before the click, so the session this step started is named rather than guessed from the order the
   * list happens to come back in.
   */
  const newSessionFromGroup = async (label, turnText) => {
    const known = new Set((await api("/api/conversations")).conversations.map((item) => item.id));
    await groupRow.hover();
    await groupNew.click();
    await page.locator("textarea").first().waitFor();
    endpoint.tool("call-" + label + "-pwd", "bash", { command: "pwd" });
    endpoint.say(label + " done");
    await page.locator("textarea").first().fill(turnText);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText(label + " done").waitFor({ timeout: 60_000 });
    let created;
    for (let attempt = 0; attempt < 100 && created === undefined; attempt += 1) {
      created = (await api("/api/conversations")).conversations.find((item) => !known.has(item.id));
      if (created === undefined) await delay(100);
    }
    return created;
  };

  const fromGroup = await newSessionFromGroup("group-default", "start in the project");
  check(fromGroup !== undefined && fromGroup.workspaceId === defaultFolder.workspaceId, "the group's own new session binds the project's default folder");
  const fromGroupState = fromGroup === undefined ? { entries: [] } : await api("/api/conversations/" + fromGroup.id + "/state");
  check(fromGroupState.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === chosenRoot), "its tools run in the default folder, not the extra one");
  check(!existsSync(join(extraRoot, "marker.txt")) && !existsSync(join(extraRoot, "second.txt")), "no tool of any new session ran in the extra folder");

  const changed = await fetch(backend.origin + "/api/projects/" + project.id, { method: "PATCH", headers, body: JSON.stringify({ defaultFolderId: extraFolder.id, hostId: "workstation" }) });
  check(changed.status === 200, "the metadata contract names another folder the default: HTTP " + changed.status);
  const afterChange = (await api("/api/projects")).projects[0];
  check(afterChange.defaultFolderId === extraFolder.id, "the project reports the new default folder");

  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  const afterChangeSession = await newSessionFromGroup("group-new-default", "start in the new default");
  check(afterChangeSession !== undefined && afterChangeSession.workspaceId === extraFolder.workspaceId, "a new session after the default change binds the new default folder");
  const afterChangeState = afterChangeSession === undefined ? { entries: [] } : await api("/api/conversations/" + afterChangeSession.id + "/state");
  check(afterChangeState.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === extraRoot), "its tools run in the new default folder");

  // The conversations bound before the change keep the folders they have: a default change affects new conversations
  // only, and neither of the earlier conversations was retargeted.
  endpoint.tool("call-immutable-pwd", "bash", { command: "pwd" });
  endpoint.say("immutable done");
  const immutable = await runTurn(bound.id, "still my own folder after the default changed?", "immutable-turn-1", "immutable done");
  check(immutable.workspaceId === defaultFolder.workspaceId, "the conversation bound before the change keeps its folder");
  check(immutable.entries.some((entry) => entry.role === "toolResult" && entry.text.trim() === chosenRoot), "and its tools still run there");

  check(pageErrors.length === 0, "the page raised no errors: " + pageErrors.join(" | "));
} catch (error) {
  failures.push("threw: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  await stop(web);
  await stop(backend?.child);
  await stop(gateway?.child);
  await endpoint?.close().catch(() => {});
  if (failures.length === 0 && !keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("Artifacts kept: " + artifacts);
}

if (failures.length > 0) {
  console.error("UX-07 New Project regression failed: " + failures.join(" | "));
  process.exit(1);
}
console.log("UX-07 New Project regression passed");
