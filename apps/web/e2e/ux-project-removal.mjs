/**
 * Ticket 09 regression: removing a Project, and unlinking one of its folders, driven through the real UI.
 *
 * The whole path is the user's: the sidebar's Project menu, its folder list, the confirmation each removal asks for,
 * the replacement default a default folder's removal must name, and the backend's own answer applied to what the
 * sidebar and the target picker show. Four projects are recorded on a real local gateway, and the last one holds a real
 * conversation whose turns are answered by a controlled OpenAI-completions endpoint (this script's own HTTP server), so
 * the assertions about a retained folder are about where a tool actually ran.
 *
 * Three processes, as a deployment composes them:
 *   this script  ->  Next.js (Web UI, loopback)  ->  backend process (apps/server/src/main.ts)
 *                ->  gateway process (packages/gateway/src/main.ts)  ->  the chosen directories on this host
 *
 * Assertions, in order:
 *   1. the Project menu's folder list names each folder by its own path on the host, and unlinking a non-default
 *      folder asks for confirmation first: the copy says hepi metadata goes and the directory and the conversations do
 *      not, the folder leaves the list, the directory on disk is untouched, and the page never reloaded;
 *   2. unlinking the default folder asks for the replacement default before anything is sent — the control is
 *      unavailable until one of the Project's other folders is chosen — and the chosen folder is what the backend
 *      then reports as the default;
 *   3. a refusal leaves the UI exactly as it was and shows the reason the backend gave (the default changed behind the
 *      open confirmation, so the request arrives without the replacement the backend now requires);
 *   4. removing a Project names what goes and what stays before the action, and afterwards the Project and its name
 *      leave the sidebar and the target picker without a page reload, while the directory on disk stays and the
 *      conversation bound to it stays listed, openable, and still runs a workspace tool in the same folder;
 *   5. a second window of the same backend shows the removal too, from the poll it already runs.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-project-removal.mjs [--keep]
 *        HEPI_UX09_WEB_PORT=<port> HEPI_UX09_BACKEND_PORT=<port> HEPI_UX09_GATEWAY_PORT=<port>
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
const token = "ux-project-removal-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux09-"));
const dataDir = join(artifacts, "data");
// One directory per project folder: the directories are what a metadata-only removal must leave exactly as they are.
const alphaRoot = join(artifacts, "alpha");
const alphaExtra = join(artifacts, "alpha-extra");
const betaRoot = join(artifacts, "beta");
const betaExtra = join(artifacts, "beta-extra");
const deltaRoot = join(artifacts, "delta");
const deltaExtra = join(artifacts, "delta-extra");
const gammaRoot = join(artifacts, "gamma");
for (const root of [alphaRoot, alphaExtra, betaRoot, betaExtra, deltaRoot, deltaExtra, gammaRoot]) mkdirSync(root, { recursive: true });
mkdirSync(join(artifacts, "gateway-home"), { recursive: true });
mkdirSync(join(artifacts, "backend-home"), { recursive: true });
// A file only gamma holds, so a tool's answer says which folder it ran in.
writeFileSync(join(gammaRoot, "note.txt"), "note in gamma");
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
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
  };
}

// ---------------------------------------------------------------- the two processes

const gatewayPort = await freePort(Number(process.env.HEPI_UX09_GATEWAY_PORT ?? 0));
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
      HEPI_WORKSPACE_ROOT: gammaRoot,
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

const backendPort = await freePort(Number(process.env.HEPI_UX09_BACKEND_PORT ?? 0));
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
const projects = async () => (await api("/api/projects?hostId=workstation")).projects;
const projectNamed = async (name) => (await projects()).find((project) => project.name === name);

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
let page;

/** The sidebar's own group row for a Project, and its menu. */
const groupRow = (view, name) => view.locator(".session-tree-group").filter({ hasText: name });
async function openGroupMenu(view, name) {
  const row = groupRow(view, name);
  await row.waitFor();
  await row.hover();
  await row.getByRole("button", { name: name + " actions", exact: true }).click();
  await view.locator(".sidebar-menu").waitFor();
}
/** The open menu's item with this exact label. */
const menuItem = (name) => page.locator(".sidebar-menu").getByRole("menuitem", { name, exact: true });
/** One folder row's unlink control in the open folder list, named by the folder's own path. */
const unlinkButton = (root) => page.locator('.project-removal-unlink[aria-label="Unlink ' + root + '"]');
const confirmButton = () => page.locator(".project-removal-confirm");

async function signIn(view) {
  const password = view.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await view.locator('button[type="submit"]').click();
  }
  const showSidebar = view.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  await view.locator(".session-tree-group-toggle").first().waitFor({ timeout: 30_000 });
}

try {
  const endpointPort = await freePort();
  endpoint = controlledEndpoint("controlled-1");
  await endpoint.listen(endpointPort);
  const endpointOrigin = "http://127.0.0.1:" + endpointPort;

  gateway = await startGateway();
  backend = startBackend(endpointOrigin);
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UX09_WEB_PORT ?? 0));
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

  /** Record one Project on this host, with the folders it is given and the first of them the default. */
  const createProject = async (name, roots) => {
    const response = await fetch(backend.origin + "/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ name, hostId: "workstation", folders: roots.map((root, index) => ({ root, default: index === 0 })) }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, "the project " + name + " was recorded: " + text);
    return JSON.parse(text).project;
  };
  const alpha = await createProject("Alpha", [alphaRoot, alphaExtra]);
  const beta = await createProject("Beta", [betaRoot, betaExtra]);
  const delta = await createProject("Delta", [deltaRoot, deltaExtra]);
  const gamma = await createProject("Gamma", [gammaRoot]);
  const folderAt = (project, root) => project.folders.find((folder) => folder.root === root);
  /** A conversation bound to a Project's default folder: a Project is shown by the conversations that hold it. */
  const bind = async (project) => (await api("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: folderAt(project, project.folders.find((folder) => folder.default).root).workspaceId }) })).conversationId;
  for (const project of [alpha, beta, delta]) await bind(project);
  // The conversation that outlives Gamma: it is bound to the project's folder before the project is removed.
  const bound = await bind(gamma);
  assert.ok(bound !== undefined, "a conversation is bound to the project's folder");

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  await signIn(page);
  // A marker that a page reload would clear: nothing below may reload the page.
  await page.evaluate(() => { window.__hepiNoReload = true; });

  // 1. The folder list, and one non-default folder's unlink.
  await openGroupMenu(page, "Alpha");
  await menuItem("Folders of Alpha").click();
  const folderPaths = await page.locator(".project-removal-path").allInnerTexts();
  check(folderPaths.length === 2 && folderPaths.includes(alphaRoot) && folderPaths.includes(alphaExtra),
    "the Project menu's folder list names each folder by its own path: " + JSON.stringify(folderPaths));
  check(!folderPaths.some((path) => path.includes("/workspace/")), "no folder is shown by the routing path it is addressed by");
  check((await page.locator(".project-removal-note").count()) === 1, "exactly one folder is marked the default");
  await unlinkButton(alphaExtra).click();
  const unlinkCopy = await page.locator(".project-removal").innerText();
  check(unlinkCopy.includes("Only hepi metadata is removed: no directory on disk is deleted and no conversation is removed."),
    "the confirmation says the directory on disk and the conversations are not removed");
  check(unlinkCopy.includes("Unlink " + alphaExtra + "?"), "the confirmation names the folder it is about: " + JSON.stringify(unlinkCopy.slice(0, 80)));
  await confirmButton().click();
  await page.locator(".project-removal-path").first().waitFor();
  const remaining = await page.locator(".project-removal-path").allInnerTexts();
  check(remaining.length === 1 && remaining[0] === alphaRoot, "the unlinked folder left the list: " + JSON.stringify(remaining));
  check(existsSync(alphaExtra) && existsSync(alphaRoot), "both directories on disk are untouched");
  const alphaAfter = await projectNamed("Alpha");
  check(alphaAfter !== undefined && alphaAfter.folders.length === 1 && folderAt(alphaAfter, alphaRoot) !== undefined, "the backend kept the Project and its other folder");
  await page.keyboard.press("Escape");
  await page.locator(".sidebar-menu").waitFor({ state: "detached" });

  // 2. The default folder's removal asks for its replacement first.
  await openGroupMenu(page, "Beta");
  await menuItem("Folders of Beta").click();
  await unlinkButton(betaRoot).click();
  check(await page.locator(".project-removal-replacement").count() === 1, "unlinking the default folder asks for the replacement default");
  const choices = await page.locator(".project-removal-choice").allInnerTexts();
  check(choices.length === 1 && choices[0] === betaExtra, "the replacement is one of the Project's own other folders: " + JSON.stringify(choices));
  check(await confirmButton().isDisabled(), "nothing is sent until a replacement is chosen");
  await page.locator(".project-removal-choice").first().click();
  check(!(await confirmButton().isDisabled()), "choosing the replacement makes the unlink available");
  await confirmButton().click();
  await page.locator(".project-removal-path").first().waitFor();
  const betaAfter = await projectNamed("Beta");
  check(betaAfter !== undefined && betaAfter.folders.length === 1 && folderAt(betaAfter, betaExtra) !== undefined,
    "the backend kept the folder that was named the replacement");
  check(folderAt(betaAfter, betaExtra).default === true && folderAt(betaAfter, betaRoot) === undefined,
    "the chosen replacement is the Project's default and the removed folder is gone");
  await page.keyboard.press("Escape");
  await page.locator(".sidebar-menu").waitFor({ state: "detached" });

  // 3. A refusal leaves the step where it was and shows the reason the backend gave: the default moved behind the open
  //    confirmation, so the request arrives without the replacement the backend now requires.
  await openGroupMenu(page, "Delta");
  await menuItem("Folders of Delta").click();
  await unlinkButton(deltaExtra).click();
  check(await page.locator(".project-removal-replacement").count() === 0, "a non-default folder's unlink asks for no replacement");
  const moved = await fetch(backend.origin + "/api/projects/" + delta.id, { method: "PATCH", headers, body: JSON.stringify({ defaultFolderId: folderAt(delta, deltaExtra).id, hostId: "workstation" }) });
  assert.equal(moved.status, 200, "the default moved behind the open confirmation");
  await confirmButton().click();
  await page.locator(".project-removal-error").waitFor();
  const refusal = await page.locator(".project-removal-error").innerText();
  check(refusal.includes("requires another folder of this project as the replacement default"), "the refusal is the reason the backend gave: " + JSON.stringify(refusal));
  check((await page.locator(".project-removal").innerText()).includes("Unlink " + deltaExtra + "?"), "the step stays where it was");
  const deltaAfter = await projectNamed("Delta");
  check(deltaAfter.folders.length === 2 && folderAt(deltaAfter, deltaExtra).default === true, "the refused removal changed nothing");
  await page.keyboard.press("Escape");
  await page.locator(".sidebar-menu").waitFor({ state: "detached" });

  // 4. A Project's removal, with the conversation it holds.
  // The turn before the removal proves where this conversation really runs.
  endpoint.tool("call-bash-before", "bash", { command: "printf before > before.txt" });
  endpoint.say("before done");
  const beforeTurn = await runTurn(bound, "where do you run?", "before-removal-1", "before done");
  check(beforeTurn.workspaceId === folderAt(gamma, gammaRoot).workspaceId, "the conversation is bound to the Project's folder");
  check(existsSync(join(gammaRoot, "before.txt")), "its tool ran in that folder");

  // The second window of the same backend, open before the removal.
  const second = await context.newPage();
  second.setDefaultTimeout(30_000);
  second.on("pageerror", (error) => pageErrors.push(error.message));
  await second.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  await signIn(second);
  check((await second.locator(".session-tree-group-name").allInnerTexts()).includes("Gamma"), "the other window shows the Project before the removal");

  // The group is expanded so the conversation's own row is on screen: it has to survive the removal.
  const gammaRow = groupRow(page, "Gamma");
  const gammaToggle = gammaRow.locator(".session-tree-group-toggle");
  if (await gammaToggle.getAttribute("aria-expanded") === "false") await gammaToggle.click();
  const conversationRow = page.locator('[data-row-key="session:group:' + bound + '"]');
  await conversationRow.waitFor();
  check(await conversationRow.count() === 1, "the conversation is listed under the Project");

  await openGroupMenu(page, "Gamma");
  await menuItem("Remove Project…").click();
  const removeCopy = await page.locator(".project-removal").innerText();
  check(removeCopy.includes("Remove Gamma?"), "the confirmation names the Project: " + JSON.stringify(removeCopy.slice(0, 60)));
  check(removeCopy.includes("Only hepi metadata is removed: no directory on disk is deleted and no conversation is removed."),
    "and says what is removed (hepi metadata) and what is not (the directory on disk, the conversations)");
  check(removeCopy.includes("The conversations bound to its folders stay listed and keep running where they are."),
    "and says the conversations stay listed and keep running");
  check(await projectNamed("Gamma") !== undefined, "the Project is still recorded before the confirmation is answered");
  await page.locator(".project-removal-confirm").click();
  await page.locator(".sidebar-menu").waitFor({ state: "detached" });

  check(await projectNamed("Gamma") === undefined, "the Project is gone from the backend");
  check(existsSync(gammaRoot) && existsSync(join(gammaRoot, "note.txt")), "its directory on disk is untouched");
  check(await page.evaluate(() => window.__hepiNoReload === true), "the page was never reloaded");
  // The Project's own name left the sidebar; its conversation is still listed, under the folder it is bound to.
  await page.locator(".session-tree-group-name", { hasText: "gamma" }).first().waitFor({ timeout: 15_000 });
  const names = await page.locator(".session-tree-group-name").allInnerTexts();
  check(!names.includes("Gamma") && names.includes("gamma"), "the Project's name left the sidebar and the folder stands in its place: " + JSON.stringify(names));
  // The group the Project's folder now forms is a new one, so it starts folded; opening it shows the conversation
  // that is still listed inside it.
  const retainedRow = page.locator(".session-tree-group").filter({ hasText: "gamma" });
  const retainedToggle = retainedRow.locator(".session-tree-group-toggle");
  if (await retainedToggle.getAttribute("aria-expanded") === "false") await retainedToggle.click();
  check(await page.locator('[data-row-key="session:group:' + bound + '"]').count() === 1, "the conversation stays listed");
  check((await retainedRow.getByRole("button", { name: /New session in/ }).count()) === 0, "and its retained folder is no longer offered as a new session's target");

  // The target picker of the files tab reads the registry too: the removed Project is no longer a choice.
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const projectBox = page.locator(".project-picker.is-stacked .project-picker-button.is-project");
  await projectBox.click();
  // A desktop picker names each Project by its own folder path, as main's dropdowns did.
  const offered = await page.locator(".sidebar-menu").getByRole("menuitemradio").allInnerTexts();
  check(!offered.some((label) => label.includes(gammaRoot)), "the target picker no longer offers the removed Project: " + JSON.stringify(offered));
  check(offered.some((label) => label.includes(alphaRoot)), "and still offers the Projects that are recorded");
  await page.keyboard.press("Escape");

  // The conversation of the removed Project still opens and still runs a workspace tool in the same folder.
  endpoint.tool("call-bash-after", "bash", { command: "printf after > after.txt" });
  endpoint.say("after done");
  const afterTurn = await runTurn(bound, "still there?", "after-removal-1", "after done");
  check(afterTurn.workspaceId === folderAt(gamma, gammaRoot).workspaceId, "the conversation keeps its own folder after the Project was removed");
  check(existsSync(join(gammaRoot, "after.txt")), "and its tools still run in that folder");

  // 5. The second window agrees, from the poll it already runs.
  let otherNames = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    otherNames = await second.locator(".session-tree-group-name").allInnerTexts();
    if (!otherNames.includes("Gamma") && otherNames.includes("gamma")) break;
    await delay(500);
  }
  check(!otherNames.includes("Gamma") && otherNames.includes("gamma"), "the other window shows the removal too: " + JSON.stringify(otherNames));
  check((await second.locator('[data-row-key="session:group:' + bound + '"]').count() + await second.locator(".session-tree-group").filter({ hasText: "gamma" }).count()) > 0,
    "and still lists the conversation the removed Project held");

  check(pageErrors.length === 0, "no page raised an error: " + pageErrors.join(" | "));
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
  console.error("UX-09 Project removal regression failed: " + failures.join(" | "));
  process.exit(1);
}
console.log("UX-09 Project removal regression passed");
