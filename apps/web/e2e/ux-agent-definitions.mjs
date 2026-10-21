/**
 * Ticket 05 regression: Execution Host agent definitions, driven through the real UI on both hosts a deployment has.
 *
 * Two journeys, the same one a person performs, on a real local execution host and on a real SSH host:
 *
 *   this script  ->  Next.js (Web UI, loopback)  ->  backend process (apps/server/src/main.ts)
 *                ->  gateway process (packages/gateway/src/main.ts)  ->  a real OpenSSH daemon on loopback
 *                    -> the chosen directory
 *
 * For each host: the sidebar's "New Project…" dialog, the target, a folder from that host's own directories, Create
 * Project, then Settings › Agents — a definition created from the form, a dry run that writes nothing, the same name
 * in the project scope shadowing the user one, a raw document carrying a field this build does not manage and kept
 * through a later form save, an unsupported capability refused, a save while the host is unreachable, and a delete.
 *
 * Every account the test writes to is scoped: the local gateway runs with \`HOME\` set to a temporary directory, and
 * the SSH host is a real \`sshd\` in a mount namespace of its own with a private directory mounted at the account's
 * home. The definitions therefore land in paths this machine's real account does not have, and the test asserts the
 * real \`~/.pi/agent/agents\` never received them.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-agent-definitions.mjs [--keep]
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sshdAvailable, startSshdFixture } from "../../../packages/gateway/test/sshd-fixture.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-agent-definitions-token";
const keep = process.argv.includes("--keep");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");
assert.ok(sshdAvailable(), "this regression needs a local sshd, ssh-keygen and a bwrap sandbox");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux05-"));
const dataDir = join(artifacts, "data");
// The local host's account home: the gateway process reads HOME, so its agent directory is this directory, never the
// real one. The SSH host's account home is the sandbox's private mount, for the same reason.
const localHome = join(artifacts, "local-home");
const remoteHome = join(artifacts, "remote-home");
mkdirSync(dataDir, { recursive: true });
// The local gateway's account home has to exist: it is what its own picker opens on.
mkdirSync(localHome, { recursive: true });
mkdirSync(join(artifacts, "local-root", "work"), { recursive: true });
mkdirSync(remoteHome, { recursive: true });
// The canonical paths the hosts report, so a chosen folder is compared to what the host itself listed.
const localRoot = realpathSync(join(artifacts, "local-root"));
const localWork = realpathSync(join(localRoot, "work"));
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

/** Every child role runs from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
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

let sshd;
let localGateway;
let sshGateway;
let backend;
let web;
let browser;
let page;

/** Poll a backend read until it answers, so a UI save is asserted on its own effect rather than on a transient label. */
async function eventually(read, label, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { const value = await read(); if (value) return value; } catch { /* the save may still be in flight */ }
    await delay(200);
  }
  throw new Error("timed out waiting for " + label);
}

try {
  sshd = await startSshdFixture({ isolated: true, home: remoteHome });
  // Both the profile root the host lists and the folder chosen under it exist only inside the sandbox's tmpfs.
  const sshProfileRoot = dirname(sshd.root);
  const sshRoot = sshd.root;
  check(!existsSync(sshRoot), "the remote project folder is a path this machine does not have");

  const localGatewayPort = await freePort(Number(process.env.HEPI_UX05_LOCAL_PORT ?? 45309));
  const startLocalGateway = async () => {
    const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
      cwd: repoRoot,
      env: childEnv(localHome, {
        HEPI_GATEWAY_TOKEN: token,
        HEPI_GATEWAY_ID: "workstation",
        HEPI_GATEWAY_PORT: String(localGatewayPort),
        HEPI_GATEWAY_DATA: join(dataDir, "local-gateway"),
        HEPI_WORKSPACE_ID: "legacy",
        HEPI_WORKSPACE_ROOT: localRoot,
        HEPI_ALLOWED_COMMANDS: "bash",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const log = capture(child);
    const origin = "http://127.0.0.1:" + localGatewayPort;
    assert.ok(await waitForHttp(origin + "/v1/files", {}, 60_000), "the local gateway started: " + log().slice(-500));
    return { child, origin, log };
  };
  localGateway = await startLocalGateway();

  const sshGatewayPort = await freePort(Number(process.env.HEPI_UX05_SSH_PORT ?? 45409));
  const startSshGateway = async () => {
    const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
      cwd: repoRoot,
      env: childEnv(join(artifacts, "ssh-gateway-home"), {
        HEPI_GATEWAY_TOKEN: token,
        HEPI_GATEWAY_ID: "ssh-prod",
        HEPI_GATEWAY_PORT: String(sshGatewayPort),
        HEPI_GATEWAY_DATA: join(dataDir, "ssh-gateway"),
        HEPI_WORKSPACE_ROOT: sshProfileRoot,
        HEPI_ALLOWED_COMMANDS: "bash",
        HEPI_SSH_HOST: sshd.host,
        HEPI_SSH_PORT: String(sshd.port),
        HEPI_SSH_PROFILE: "prod",
        HEPI_SSH_IDENTITY: sshd.identityFile,
        HEPI_SSH_KNOWN_HOSTS: sshd.knownHostsFile,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const log = capture(child);
    const origin = "http://127.0.0.1:" + sshGatewayPort;
    assert.ok(await waitForHttp(origin + "/v1/files", { authorization: "Bearer " + token, "content-type": "application/json" }, 60_000), "the SSH gateway started: " + log().slice(-500));
    return { child, origin, log };
  };
  sshGateway = await startSshGateway();

  const backendPort = await freePort(Number(process.env.HEPI_UX05_BACKEND_PORT ?? 45209));
  const startBackend = () => {
    const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
      cwd: repoRoot,
      env: childEnv(join(artifacts, "backend-home"), {
        PORT: String(backendPort),
        HEPI_BIND_HOST: "127.0.0.1",
        HEPI_AUTH_TOKEN: token,
        HEPI_DB: join(dataDir, "conversations.sqlite"),
        HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
        HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
        // Both hosts are configured connections. A definition's host is the folder's own owner, so each project is
        // served on the computer its folder was chosen on.
        HEPI_GATEWAYS: JSON.stringify([{ id: "workstation", url: localGateway.origin, token }, { id: "ssh-prod", url: sshGateway.origin, token }]),
        HEPI_WORKSPACE_ID: "legacy",
        HEPI_GATEWAY_ID: "workstation",
        HEPI_GATEWAY_URL: localGateway.origin,
        HEPI_GATEWAY_TOKEN: token,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const log = capture(child);
    return { child, log, origin: "http://127.0.0.1:" + backendPort };
  };
  backend = startBackend();

  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const api = async (path, init) => (await fetch(backend.origin + path, { headers, ...init })).json();
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 60_000), "the backend started: " + backend.log().slice(-500));

  const webPort = await freePort(Number(process.env.HEPI_UX05_WEB_PORT ?? 45109));
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backend.origin,
      HEPI_AUTH_TOKEN: token,
      // The host this Web origin serves. It names the local gateway, and a folder on the SSH host is still addressed
      // on its own gateway because the folder's owner is what decides.
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  const webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto(webOrigin + "/", { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) { await password.fill(token); await page.locator('button[type="submit"]').click(); }
  if (await page.getByRole("button", { name: "Show sidebar", exact: true }).count()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("button", { name: "New Project…", exact: true }).waitFor();

  const groupOf = (scope) => page.locator(".config-sidebar-group").filter({ has: page.locator(".config-sidebar-group-label", { hasText: scope }) });
  const openAgents = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Agents", exact: true }).click();
    await page.getByRole("button", { name: "New definition", exact: true }).waitFor();
  };
  const closeSettings = async () => {
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached" });
  };

  /** Choose one folder in the selected target's own picker: open its parent, click the child, select it. */
  const chooseFolder = async (parent, child) => {
    await page.locator(".new-project-add-folder").click();
    const picker = page.locator(".directory-picker-panel");
    await picker.waitFor();
    await page.locator(".directory-picker-path").first().fill(parent);
    await page.locator(".directory-picker-panel button[type=submit]").click();
    await page.locator('.directory-picker-entry[title="' + child + '"]').waitFor();
    await page.locator('.directory-picker-entry[title="' + child + '"]').click();
    await page.waitForFunction((expected) => document.querySelector(".directory-picker-path")?.value === expected, child);
    await page.locator(".directory-picker-footer").getByRole("button", { name: "Select this folder", exact: true }).click();
    await picker.waitFor({ state: "detached" });
  };

  /** The whole definitions journey on one host: project, form create, dry run, scopes, raw document, delete, offline. */
  const journey = async ({ label, hostId, targetLabel, parent, child, accountFile, projectFile, down, up }) => {
    console.log("- " + label);
    await page.getByRole("button", { name: "New Project…", exact: true }).click();
    const dialog = page.locator(".new-project-panel");
    await dialog.waitFor();
    const targetSelect = page.locator(".new-project-target");
    await targetSelect.waitFor();
    const options = await targetSelect.locator("option").allTextContents();
    const wanted = options.find((option) => option.includes(targetLabel));
    check(wanted !== undefined, label + ": the dialog offers its target: " + JSON.stringify(options));
    await targetSelect.selectOption({ label: wanted });
    if (hostId !== "workstation") await page.locator(".new-project-host").filter({ hasText: "Remote · " }).waitFor();
    await chooseFolder(parent, child);
    await page.locator(".new-project-name").fill(label);
    await page.locator(".new-project-create").click();
    await dialog.waitFor({ state: "detached" });
    await page.locator("textarea").first().waitFor();
    const project = (await api("/api/projects")).projects.find((item) => item.name === label);
    check(project !== undefined && project.hostId === hostId, label + ": the project records the host its folder is on");
    const folder = project.folders.find((item) => item.id === project.defaultFolderId);
    check(folder.root === child, label + ": its default folder is the directory the host listed");
    const workspaceId = folder.workspaceId;
    const listedDefinitions = () => api("/api/agent-definitions?hostId=" + hostId + "&workspaceId=" + workspaceId);
    const document = (scope, name) => api("/api/agent-definitions/document?hostId=" + hostId + "&workspaceId=" + workspaceId + "&scope=" + scope + "&name=" + name);
    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const realFile = join(homedir(), ".pi", "agent", "agents", name + ".md");

    await openAgents();
    // A definition created from the form is written on the host, not on this machine's own account.
    await page.getByRole("button", { name: "New definition", exact: true }).click();
    await page.getByRole("group", { name: "Save to" }).getByRole("button", { name: "user", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description", { exact: true }).fill("Reviewer for " + label);
    await page.getByLabel("Context", { exact: true }).selectOption("fork");
    await page.getByRole("checkbox", { name: "read", exact: true }).check();
    await page.getByLabel("Instructions", { exact: true }).fill("Review on the host.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await groupOf("user").locator(".config-sidebar-item", { hasText: name }).waitFor();
    await eventually(() => existsSync(accountFile(name)), "the form save to reach the host");
    check(existsSync(accountFile(name)), label + ": the form save wrote the definition in the host account's own agent directory");
    check(!existsSync(realFile), label + ": this machine's real account received nothing");
    const onHost = readFileSync(accountFile(name), "utf8");
    check(new RegExp("^name: " + name + "$", "m").test(onHost) && /Review on the host\./.test(onHost), label + ": the host file carries the name and instructions the form gave");

    // A dry run validates and writes nothing.
    await page.getByRole("button", { name: "New definition", exact: true }).click();
    await page.getByRole("group", { name: "Save to" }).getByRole("button", { name: "user", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name + "-dry");
    await page.getByLabel("Description", { exact: true }).fill("Dry run only");
    await page.getByLabel("Instructions", { exact: true }).fill("Dry body.");
    await page.getByRole("button", { name: "Validate", exact: true }).click();
    await page.getByText("Definition is valid.").waitFor();
    check(!existsSync(accountFile(name + "-dry")), label + ": a dry run wrote no file on the host");
    check((await document("user", name + "-dry")).definition === undefined, label + ": and recorded no definition");

    // The same name in the project scope overrides the user one, and both stay addressable.
    await page.getByRole("button", { name: "New definition", exact: true }).click();
    await page.getByRole("group", { name: "Save to" }).getByRole("button", { name: "project", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Description", { exact: true }).fill("Project copy");
    await page.getByLabel("Instructions", { exact: true }).fill("Project body.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const shadowing = await eventually(async () => {
      const view = await listedDefinitions();
      return view.definitions.length === 1 && view.shadowed.length === 1 ? view : undefined;
    }, "the project definition to shadow the user one");
    check(shadowing.definitions[0].scope === "project" && shadowing.definitions[0].description === "Project copy", label + ": the project definition is the effective one");
    check(shadowing.shadowed[0].scope === "user", label + ": the user definition of the same name is shadowed, not lost");
    const projectPath = (await document("project", name)).definition.path;
    check(projectPath === join(child, ".pi", "agents", name + ".md"), label + ": the project document lives in the project folder");
    if (projectFile !== undefined) check(existsSync(projectFile(name)), label + ": and that path is the file the host wrote");

    // A raw document keeps a field this build does not manage, through a later form save.
    await page.getByRole("button", { name: "Raw document", exact: true }).click();
    await page.locator("textarea.agents-system-prompt").fill("---\nname: " + name + "\ndescription: Project copy\ncontext: fork\nx-hepi-note: keep me\n---\nRaw body kept.\n");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await eventually(async () => /x-hepi-note: keep me/.test((await document("project", name)).definition.raw ?? ""), "the raw save to reach the host");
    await page.getByRole("button", { name: "Form", exact: true }).click();
    await page.getByLabel("Description", { exact: true }).fill("Edited from the form");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const afterForm = await eventually(async () => {
      const raw = (await document("project", name)).definition.raw ?? "";
      return /Edited from the form/.test(raw) ? raw : undefined;
    }, "the form save to reach the host");
    check(/x-hepi-note: keep me/.test(afterForm), label + ": the form save kept the unknown frontmatter field");
    check(/Raw body kept\./.test(afterForm), label + ": and the unedited body");

    // A capability this build cannot execute is refused with its field, and nothing is written.
    const refused = await fetch(backend.origin + "/api/agent-definitions", { method: "PUT", headers, body: JSON.stringify({ hostId, workspaceId, scope: "project", name: name + "-refused", fields: { name: name + "-refused", tools: ["mcp:github"] } }) });
    check(refused.status === 400, label + ": an unsupported capability is refused, not silently filtered");
    check((await document("project", name + "-refused")).definition === undefined, label + ": and it wrote nothing");

    // A tool this build does not install is refused too, on the validation path and on the write path alike: accepting
    // the name would save a definition that runs with a smaller loadout than it states.
    const listed = await listedDefinitions();
    const offeredTools = listed.capabilities?.tools ?? [];
    check(offeredTools.length > 0 && !offeredTools.includes("grep"), label + ": the list states the tools this build installs: " + JSON.stringify(offeredTools));
    for (const dryRun of [true, false]) {
      const absent = await fetch(backend.origin + "/api/agent-definitions", { method: "PUT", headers, body: JSON.stringify({ hostId, workspaceId, scope: "project", name: name + "-absent", fields: { name: name + "-absent", description: "Never runnable", tools: ["read", "grep"] }, ...(dryRun ? { dryRun: true } : {}) }) });
      const answer = await absent.json();
      check(absent.status === 400 && answer.code === "unknown_tool" && answer.field === "tools", label + (dryRun ? ": a dry run" : ": a save") + " refuses a tool this build does not install");
    }
    check((await document("project", name + "-absent")).definition === undefined, label + ": and the refused tool set wrote nothing");
    const offeredSave = await fetch(backend.origin + "/api/agent-definitions", { method: "PUT", headers, body: JSON.stringify({ hostId, workspaceId, scope: "project", name: name + "-offered", fields: { name: name + "-offered", description: "Runnable", tools: offeredTools } }) });
    check(offeredSave.status === 200, label + ": every tool the list offers is accepted: " + JSON.stringify(await offeredSave.json()).slice(0, 200));

    // With the host unreachable, a save fails with the backend's own reason and writes nothing anywhere.
    await down();
    await page.getByRole("button", { name: "New definition", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill(name + "-offline");
    await page.getByLabel("Description", { exact: true }).fill("Never written");
    await page.getByLabel("Instructions", { exact: true }).fill("Never written.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "could not be reached" }).waitFor({ timeout: 30_000 });
    check(true, label + ": an unreachable host is reported in the panel, not silently accepted");
    check(!existsSync(accountFile(name + "-offline")) && !existsSync(realFile), label + ": and the refused save wrote no file");
    await up();

    // The host is back, and the user definition is deleted through the panel.
    await closeSettings();
    await openAgents();
    await groupOf("user").locator(".config-sidebar-item", { hasText: name }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await eventually(() => !existsSync(accountFile(name)), "the delete to reach the host");
    check(!existsSync(accountFile(name)), label + ": the deleted definition's file is gone from the host");
    check(!existsSync(realFile), label + ": and this machine's real account still holds nothing");
    await closeSettings();
  };

  await journey({
    label: "Local Definitions",
    hostId: "workstation",
    targetLabel: "This computer",
    parent: localRoot,
    child: localWork,
    accountFile: (name) => join(localHome, ".pi", "agent", "agents", name + ".md"),
    projectFile: (name) => join(localWork, ".pi", "agents", name + ".md"),
    down: async () => { await stop(localGateway.child); },
    up: async () => { localGateway = await startLocalGateway(); },
  });

  await journey({
    label: "Remote Definitions",
    hostId: "ssh-prod",
    targetLabel: "prod",
    parent: sshProfileRoot,
    child: sshRoot,
    accountFile: (name) => join(remoteHome, ".pi", "agent", "agents", name + ".md"),
    down: async () => { await stop(sshGateway.child); },
    up: async () => { sshGateway = await startSshGateway(); },
  });

  check(pageErrors.length === 0, "the page raised no errors: " + pageErrors.join(" | "));
} catch (error) {
  failures.push("threw: " + (error instanceof Error ? error.message : String(error)));
  console.error(error);
  if (page !== undefined) console.error("panel: " + await page.locator(".settings-dialog-surface").innerHTML().catch((inner) => "no panel: " + inner.message));
} finally {
  await browser?.close().catch(() => {});
  await stop(web);
  await stop(backend?.child);
  await stop(localGateway?.child);
  await stop(sshGateway?.child);
  await sshd?.stop().catch(() => {});
  if (failures.length === 0 && !keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("Artifacts kept: " + artifacts);
}

if (failures.length > 0) {
  console.error("UX-05 agent definitions regression failed: " + failures.join(" | "));
  process.exit(1);
}
console.log("UX-05 agent definitions regression passed");
