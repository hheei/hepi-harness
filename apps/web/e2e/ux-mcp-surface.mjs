/**
 * Ticket 17 driver: the MCP settings dialog is wired to the Web host service.
 *
 * Everything is the real path: the real Web UI built from this tree, the real durable backend, a real
 * hepi-gateway serving the MCP capability on this host, and a real Chromium. The MCP servers the host
 * starts are the controlled local fixtures (a stdio server that fails with a secret in its stderr, and
 * an OAuth-protected HTTP server with its own authorization server), so nothing here reaches a network,
 * a provider or a paid call. Every wait is an observable UI, request or file change: no sleeps.
 *
 * Scenes: list the host's own configuration, a masked failure, a test that lists tools, add a server,
 * sign in and sign out against the fake authorization server, remove it, the trust-gated project scope,
 * and the named limit when the host service cannot be reached.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-mcp-surface.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-mcp-surface-token";
const secret = "{{BROKEN_TOKEN_9f2xk4}}";
const stdioFixture = join(repoRoot, "packages", "gateway", "test", "fixtures", "mcp", "stdio-server.mjs");
const oauthFixture = join(repoRoot, "packages", "gateway", "test", "fixtures", "mcp", "oauth-server.mjs");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-mcp-surface-"));
const dataDir = join(artifacts, "data");
const gatewayHome = join(artifacts, "gateway-home");
const workspaceRoot = join(artifacts, "workspace");
const projectRoot = join(artifacts, "mcp-project");
mkdirSync(dataDir, { recursive: true });
mkdirSync(gatewayHome, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(join(projectRoot, ".pi"), { recursive: true });
console.log("Artifacts: " + artifacts);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

// The host's own configuration, written before anything starts, as the pi CLI on that host would leave it:
// one server that answers, and one that cannot start and says so with a secret in its own words.
const agentDir = join(gatewayHome, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
const globalConfigPath = join(agentDir, "mcp.json");
writeFileSync(globalConfigPath, JSON.stringify({
  mcpServers: {
    inventory: { command: process.execPath, args: [stdioFixture], exposure: "direct" },
    broken: { command: process.execPath, args: [stdioFixture], env: { BROKEN_TOKEN: secret, PI_WEB_FIXTURE_FAIL: "cannot start: token " + secret } },
  },
}, null, 2) + "\n");
// The project's own file, before anyone trusts the folder: a project server a decision gates.
const projectConfigPath = join(projectRoot, ".pi", "mcp.json");
writeFileSync(projectConfigPath, JSON.stringify({ mcpServers: { repo: { command: process.execPath, args: [stdioFixture] } } }, null, 2) + "\n");

const children = [];
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
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
function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
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
    try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

// ---------------------------------------------------------------- the three processes

const gatewayPort = await freePort();
let gateway;
async function startGateway() {
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(gatewayHome, {
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_PORT: String(gatewayPort),
      HEPI_GATEWAY_DATA: dataDir,
      HEPI_WORKSPACE_ID: "local",
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

const backendPort = await freePort();
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
      HEPI_WORKSPACE_ID: "local",
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

const webPort = await freePort();
let web;
async function startWeb(extra = {}) {
  const child = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_SERVER_URL: backend.origin,
      HEPI_AUTH_TOKEN: token,
      HEPI_WEB_LOCAL_GATEWAY_ID: "workstation",
      // This Web origin's MCP host service: the gateway on this Web host, reached directly.
      HEPI_WEB_GATEWAY_URL: gateway.origin,
      HEPI_WEB_GATEWAY_TOKEN: token,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      ...extra,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(origin + "/", {}, 60_000), "the Web UI started: " + log().slice(-500));
  return { child, log, origin };
}

/** The fake OAuth-protected MCP server and its authorization server, in this process. */
async function startOAuthFake() {
  const module = await import(oauthFixture);
  return module.startFakeOAuthServer();
}

/** Open the fake's sign-in page and return the address the browser is sent to, as a person would paste it. */
async function approve(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(response.status, 302, "the fake approves at once");
  return response.headers.get("location");
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (path, init) => (await fetch(backend.origin + path, { headers, ...init })).json();

async function openWindow(browser, origin) {
  const login = await fetch(origin + "/api/durable-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const value = login.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ").replace(/^hepi-web-token=/, "");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-token", value, url: origin, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  const mcpRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("/api/mcp")) mcpRequests.push(request.url()); });
  return { page, context, pageErrors, mcpRequests };
}

/** Settings › MCP, opened the way a person opens it. */
async function openMcpSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "MCP", exact: true }).click();
  await page.locator(".config-panel-root").waitFor({ timeout: 30_000 });
}

const row = (page, name) => page.locator(".config-sidebar-item").filter({ hasText: name }).first();
const detail = (page) => page.locator(".config-detail");

let browser;
let oauth;
try {
  gateway = await startGateway();
  backend = startBackend();
  assert.ok(await waitForHttp(backend.origin + "/api/workspaces", headers, 45_000), "the backend started: " + backend.log().slice(-500));
  web = await startWeb();
  oauth = await startOAuthFake();
  browser = await chromium.launch();
  const window_ = await openWindow(browser, web.origin);
  const { page, pageErrors, mcpRequests } = window_;
  await page.goto(web.origin + "/", { waitUntil: "domcontentloaded" });

  // Scene 1: the dialog lists the host's own configuration, and offers no control this Web origin cannot serve.
  await openMcpSettings(page);
  await row(page, "inventory").waitFor({ timeout: 30_000 });
  check(await row(page, "broken").count() === 1, "the global group lists both of the host's servers");
  check(await page.locator('.config-sidebar-item:has-text("Code mode")').count() === 0, "no Code mode control is offered: this Web origin serves no settings for it");
  await row(page, "inventory").click();
  await detail(page).getByText(stdioFixture).first().waitFor({ timeout: 15_000 });
  check(true, "the detail shows the command the host's own mcp.json holds");

  // Scene 2: a test failure reports a masked reason, and no secret reaches the page.
  await row(page, "broken").click();
  await detail(page).getByRole("button", { name: "Test connection", exact: true }).click();
  await detail(page).getByText("Did not connect").first().waitFor({ timeout: 60_000 });
  const failedPane = await detail(page).innerText();
  const stderr = await detail(page).locator(".mcp-test-output").innerText();
  // The host resolved the entry's literal env values before starting it, so the words it wrote with one of them
  // are masked: what the pane shows is the mask, and never the value.
  check(stderr.includes("•••") && !stderr.includes(secret), "the failure the server reported is masked: " + JSON.stringify(stderr));
  check(failedPane.includes("Did not connect"), "the test reports that it did not connect");
  check(!failedPane.includes(secret), "no secret appears in the dialog");
  check((await page.content()).includes(secret) === false, "no secret appears anywhere in the page");

  // Scene 3: a test that answers reports what it found; the host counts the tools, so no list is claimed.
  await row(page, "inventory").click();
  await detail(page).getByRole("button", { name: "Test connection", exact: true }).click();
  await detail(page).getByText("Connected").first().waitFor({ timeout: 60_000 });
  const connectedPane = await detail(page).innerText();
  check(/4 tool\(s\) listed/.test(connectedPane), "the connection reports the tools the host found: " + JSON.stringify(connectedPane.split("\n").find((line) => line.includes("tool(s) listed")) ?? ""));
  check(await page.locator(".mcp-test-tools").count() === 0, "no tool list is shown: the host reports the count only");

  // Scene 4: a server is added through the dialog, and the host's own file holds it.
  await page.locator(".config-list-action-button").click();
  await page.locator("#mcp-add-source").fill(JSON.stringify({ mcpServers: { docs: { url: oauth.url } } }));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await row(page, "docs").waitFor({ timeout: 30_000 });
  const onDisk = JSON.parse(readFileSync(globalConfigPath, "utf8"));
  check(onDisk.mcpServers.docs?.url === oauth.url, "the added server is in the host's mcp.json, with no page reload");
  check((await api("/api/conversations")).conversations !== undefined, "the backend is still answering");

  // Scene 5: sign in against the controlled authorization server, then sign out.
  await row(page, "docs").click();
  await detail(page).getByRole("button", { name: "Sign in", exact: true }).click();
  const link = detail(page).locator('a[href^="' + oauth.origin + '/authorize"]').first();
  await link.waitFor({ timeout: 30_000 });
  const authorizationUrl = await link.getAttribute("href");
  check(authorizationUrl.startsWith(oauth.origin + "/authorize"), "the host's own sign-in page is offered as a link");
  const redirected = await approve(authorizationUrl);
  await page.locator(".oauth-paste-input").fill(redirected);
  await page.locator(".oauth-paste-submit").click();
  // The box goes when the flow ends, and the flow ends after the host stored what the fake issued.
  await page.locator(".oauth-paste-panel").waitFor({ state: "detached", timeout: 60_000 });
  await detail(page).getByText("Signed in. Connection above shows what the server offers.", { exact: true }).waitFor({ timeout: 60_000 });
  const authPath = join(agentDir, "mcp-auth.json");
  const stored = JSON.parse(readFileSync(authPath, "utf8"));
  const record = Object.values(stored)[0];
  check(oauth.issued.access.has(record?.tokens?.access_token), "the host's own mcp-auth.json holds the token the fake issued");
  check((await page.content()).includes(record.tokens.access_token) === false, "the token never reaches the page");

  await detail(page).getByRole("button", { name: "Sign out", exact: true }).click();
  await detail(page).getByText("Signed out: the tokens stored for this server were deleted.", { exact: true }).waitFor({ timeout: 30_000 });
  check(Object.keys(JSON.parse(readFileSync(authPath, "utf8"))).length === 0, "signing out removed the host's stored credentials");

  // Scene 6: remove the server: the list drops it and the host's file no longer defines it.
  await detail(page).getByRole("button", { name: "Remove", exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("docs"), undefined, { timeout: 30_000 });
  check(JSON.parse(readFileSync(globalConfigPath, "utf8")).mcpServers.docs === undefined, "the removal reached the host's mcp.json");
  check(await page.locator(".config-notice").filter({ hasText: "Undo" }).count() === 0, "no Undo is offered: the host keeps no copy of an entry");

  // Scene 7: the project scope is gated by the host's own trust decision.
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
  await page.getByRole("button", { name: "New Project…", exact: true }).click();
  await page.locator(".new-project-add-folder").click();
  await page.locator(".directory-picker-path").first().fill(artifacts);
  await page.locator(".directory-picker-panel button[type=submit]").click();
  await page.locator('.directory-picker-entry[title="' + projectRoot + '"]').waitFor({ timeout: 30_000 });
  await page.locator('.directory-picker-entry[title="' + projectRoot + '"]').click();
  await page.locator(".directory-picker-footer").getByRole("button", { name: "Select this folder", exact: true }).click();
  await page.locator(".directory-picker-panel").waitFor({ state: "detached" });
  await page.locator(".new-project-name").fill("MCP Project");
  await page.locator(".new-project-create").click();
  await page.locator(".new-project-panel").waitFor({ state: "detached", timeout: 30_000 });

  await openMcpSettings(page);
  await row(page, "repo").waitFor({ timeout: 30_000 });
  check(/repo: Project not trusted/.test(await row(page, "repo").getAttribute("aria-label") ?? ""), "the project's server is listed and reads as untrusted: " + JSON.stringify(await row(page, "repo").getAttribute("aria-label")));
  await page.locator(".config-notice").filter({ hasText: "recorded on the Web host" }).first().waitFor({ timeout: 15_000 });
  check(await page.getByRole("button", { name: "Trust project…", exact: true }).count() === 0, "no trust control is offered: this Web origin only reads the decision");
  const projectRequest = mcpRequests.map((url) => new URL(url).searchParams.get("cwd")).filter(Boolean).pop();
  const refused = await page.evaluate(async (cwd) => {
    const response = await fetch("/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "remove", scope: "project", cwd, name: "repo" }) });
    return { status: response.status, body: await response.json() };
  }, projectRequest);
  check(refused.status === 409 && refused.body.reason === "project-untrusted", "a project write is refused by the host's trust gate: " + JSON.stringify(refused));

  // The decision is recorded on the host that owns the folder (the pi CLI's own store); the dialog reads it back.
  const trustPath = join(agentDir, "trust.json");
  writeFileSync(trustPath, JSON.stringify({ [realpathSync(projectRoot)]: true }, null, 2) + "\n");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.config-sidebar-item[aria-label^="repo:"]')?.getAttribute("aria-label") === "repo: On", undefined, { timeout: 30_000 });
  check(true, "with the decision recorded on the host, the project's server reads On");
  await row(page, "repo").click();
  await detail(page).getByRole("button", { name: "Test connection", exact: true }).click();
  await detail(page).getByText("Connected").first().waitFor({ timeout: 60_000 });
  check(true, "the project's server connects, tested through the dialog");

  // Scene 8: a host service that cannot be reached is the deployment's named limit, not an empty list.
  await stop(gateway.child);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".config-sidebar-message.is-error").waitFor({ timeout: 30_000 });
  const limit = await page.locator(".config-sidebar-message.is-error").innerText();
  check(/MCP is not available on this deployment: the MCP host service did not answer/.test(limit), "the dialog names the limit: " + JSON.stringify(limit));
  check(await page.locator(".config-list-action-button").count() === 0, "no control is offered while the host service cannot be reached");
  check(await page.locator(".config-sidebar-item").count() === 0, "no server is listed as if it were read");

  check(pageErrors.length === 0, "no page error: " + pageErrors.join(" | "));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await browser?.close().catch(() => {});
  for (const child of [...children].reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  await oauth?.close().catch(() => {});
  console.log("Artifacts kept at " + artifacts);
  if (failures.length > 0) { console.error("UX MCP surface checks FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("UX MCP surface checks PASSED");
}
