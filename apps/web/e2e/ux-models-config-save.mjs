/**
 * Ticket 12 regression, driven through the real production Web UI and a real backend process.
 *
 * The Settings > Models editor must read and save the backend's own models.json, the save must take effect on the next
 * request the backend makes, and it must survive a backend restart. Two controlled OpenAI-completions endpoints stand in
 * for the deployment's provider, so the endpoint that actually receives each request is observed rather than inferred:
 * endpoint A is the environment deployment, endpoint B is what the editor saves.
 *
 * The environment provider is an environment-owned base layer, not a file entry: the editor's first read is empty, and
 * the file the browser saves is an override of the deployment's own alias. Removing that override restores the
 * environment endpoint, which is why this is not a claim that the editor deleted the deployment's provider.
 *
 * Every wait is an observable UI, request or file change; there are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-models-config-save.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-models-config-token";
const provider = "magpie";
const modelId = "deepseek-v4.1-flash";
const apiKeyVar = "HEPI_PROVIDER_API_KEY";
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-models-config-e2e-"));
const dataDir = join(artifacts, "data");
const agentDir = join(artifacts, "agent");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

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
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** One controlled OpenAI-completions endpoint. It records every model request and can hold the next one open. */
function controlledEndpoint(reply) {
  const requests = [];
  let hold = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      // Only a real completions call is recorded; anything else (a probe, a stray GET) is answered as not found rather
      // than parsed as JSON, so the recorded requests are exactly the model traffic.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ authorization: request.headers.authorization, model: body.model, messages: JSON.stringify(body.messages) });
      if (hold !== null) { const current = hold; hold = null; current.arrived(); await current.wait; }
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      // The ordinal is part of the reply, so each turn's answer is a distinct rendered string and a wait cannot be
      // satisfied by an earlier turn's text.
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: reply + " " + requests.length }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return {
    requests,
    listen: () => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); }),
    origin: () => "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
    /** Hold the next model request open until release(), so a save can be observed against in-flight work. */
    holdNext() {
      let arrive;
      let release;
      const opened = new Promise((resolveOpen) => { arrive = resolveOpen; });
      const held = new Promise((resolveHeld) => { release = resolveHeld; });
      hold = { arrived: arrive, wait: held };
      return { opened, release };
    },
  };
}

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
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000).then(() => child.kill("SIGKILL"))]);
}

const failures = [];
function check(condition, message) {
  if (condition) { console.log("PASS: " + message); return; }
  failures.push(message);
  console.log("FAIL: " + message);
}

// Distinct replies, so which endpoint served a turn is read off the rendered conversation rather than inferred.
const endpointA = controlledEndpoint("answered by the environment endpoint");
const endpointB = controlledEndpoint("answered by the saved endpoint");
await endpointA.listen();
await endpointB.listen();

let browser;
let gatewayOrigin;
let backend;
let backendOrigin;
let web;
let webOrigin;
const gatewayToken = "ux-models-config-gateway-token";

/**
 * The real workbench gateway, so the conversation's execution host is a real process. It is not a stub for this ticket:
 * a model turn needs the execution environment the resource loader and tools resolve through.
 */
async function startGateway() {
  const workspaceRoot = join(artifacts, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), { HEPI_GATEWAY_PORT: String(port), HEPI_GATEWAY_TOKEN: gatewayToken, HEPI_WORKSPACE_ID: "local", HEPI_WORKSPACE_ROOT: workspaceRoot, HEPI_GATEWAY_DB: join(dataDir, "gateway.sqlite") }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + port;
  assert.ok(await waitForHttp(origin + "/v1/workbench", {}, 45_000).catch(() => true), "the gateway started: " + log().slice(-500));
  return { child, origin };
}

async function startBackend(port) {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(port),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      PI_CODING_AGENT_DIR: agentDir,
      HEPI_WORKSPACE_ID: "local",
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: gatewayOrigin,
      HEPI_GATEWAY_TOKEN: gatewayToken,
      HEPI_PROVIDER: provider,
      HEPI_MODEL: modelId,
      HEPI_PROVIDER_BASE_URL: endpointA.origin() + "/v1",
      [apiKeyVar]: "env-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + port;
  assert.ok(await waitForHttp(origin + "/api/workspaces", { authorization: "Bearer " + token }, 45_000), "the backend started: " + log().slice(-500));
  return { child, origin };
}

/** One browser session against the real Web UI, with the durable conversation in view. */
async function newPage(sessionId) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
  const password = page.locator('input[type="password"]');
  if (await password.count()) {
    await password.fill(token);
    await page.locator('button[type="submit"]').click();
  }
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  return { page, context, pageErrors };
}

/** Submit one prompt through the composer and settle on the reply the named endpoint streamed. */
async function ask(page, text, reply) {
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText(reply, { exact: true }).last().waitFor({ timeout: 60_000 });
}

/** Save one model configuration through the real Settings > Models editor, exactly as a user does. */
async function saveThroughEditor(page, baseUrl) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Models", exact: true }).click();
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("button", { name: /OpenAI \/ Anthropic compatible/ }).click();

  await page.getByPlaceholder("provider-name").fill(provider);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByPlaceholder("https://api.example.com/v1").fill(baseUrl);
  await page.getByPlaceholder("ENV_VAR_NAME, !shell-command, or literal key").fill("$" + apiKeyVar);
  await page.locator(".models-sidebar-add-item").first().click();
  await page.getByPlaceholder("model-id").fill(modelId);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor({ timeout: 30_000 });
  // Settings is embedded in the app dialog, so its own close control is what returns to the chat.
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
}

try {
  gatewayOrigin = (await startGateway()).origin;
  // The Web process proxies to one backend origin for its whole life, so the restart reuses this port.
  const backendPort = await freePort();
  const first = await startBackend(backendPort);
  backend = first.child;
  backendOrigin = first.origin;

  const webPort = await freePort();
  web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  browser = await chromium.launch();
  // The conversation is created on the real gateway workspace, so its model turns resolve tools and resources through
  // the execution host rather than failing for want of an environment.
  const created = await fetch(backendOrigin + "/api/conversations", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "local" }) });
  const sessionId = (await created.json()).conversationId;
  check(created.status === 201 && typeof sessionId === "string", "the backend created a conversation on the real gateway workspace");

  const modelsConfigPath = join(agentDir, "models.json");
  const view = await newPage(sessionId);
  const { page, context, pageErrors } = view;

  // The editor reads the backend's file, and there is no file yet: the environment deployment is a base layer, not a
  // file entry, so this is empty instead of pretending the deployment was persisted.
  const before = await (await fetch(webOrigin + "/api/models-config", { headers: { cookie: (await context.cookies()).map((entry) => entry.name + "=" + entry.value).join("; ") } })).json();
  check(JSON.stringify(before) === JSON.stringify({ providers: {} }), "the editor's first read is the backend's empty models.json: " + JSON.stringify(before));
  check(!existsSync(modelsConfigPath), "reading the configuration does not create a file");

  // The environment endpoint serves the deployment before any save.
  await ask(page, "before-save", "answered by the environment endpoint 1");
  check(endpointA.requests.length === 1 && endpointB.requests.length === 0, "the environment endpoint served the request before any save");
  check(endpointA.requests[0].authorization === "Bearer env-key", "the environment credential authenticated that request");
  check(endpointA.requests[0].model === modelId, "the request named the deployment's model id");

  // An in-flight request keeps the endpoint it was prepared with; the save applies to the next request only.
  const held = endpointA.holdNext();
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.fill("in-flight");
  await page.getByRole("button", { name: "Send" }).click();
  await held.opened;
  await saveThroughEditor(page, endpointB.origin() + "/v1");
  check(JSON.parse(readFileSync(modelsConfigPath, "utf8")).providers[provider].baseUrl === endpointB.origin() + "/v1", "the editor's save wrote the backend's models.json");
  check(JSON.parse(readFileSync(modelsConfigPath, "utf8")).providers[provider].apiKey === "$" + apiKeyVar, "the saved file kept the environment credential reference instead of copying a key");
  held.release();
  await page.getByText("answered by the environment endpoint 2", { exact: true }).last().waitFor({ timeout: 60_000 });
  check(endpointA.requests.length === 2 && endpointB.requests.length === 0, "the request already in flight finished on the endpoint it was prepared with");

  // The next request resolves the saved configuration.
  await ask(page, "after-save", "answered by the saved endpoint 1");
  check(endpointB.requests.length === 1 && endpointA.requests.length === 2, "the saved endpoint served the next request");
  check(endpointB.requests[0].authorization === "Bearer env-key", "the saved reference still resolves the environment credential");
  check(endpointB.requests[0].model === modelId, "the saved model id reached the endpoint");
  check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));

  // A restart re-applies the environment provider and then reads the saved file, so the saved endpoint still wins.
  await stop(backend);
  const second = await startBackend(backendPort);
  backend = second.child;
  backendOrigin = second.origin;
  await context.close();
  const reopened = await newPage(sessionId);
  await ask(reopened.page, "after-restart", "answered by the saved endpoint 2");
  check(endpointB.requests.length === 2 && endpointA.requests.length === 2, "the saved endpoint served the request after the backend restarted (environment " + endpointA.requests.length + ", saved " + endpointB.requests.length + ")");
  check(JSON.parse(readFileSync(modelsConfigPath, "utf8")).providers[provider].baseUrl === endpointB.origin() + "/v1", "the saved file is unchanged by the restart");
  check(reopened.pageErrors.length === 0, "no page error occurred after the restart: " + reopened.pageErrors.join(" | "));
  await reopened.context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) await stop(child);
  await endpointA.close();
  await endpointB.close();
  if (failures.length > 0) {
    console.error("Models-config Web regression failed: " + failures.join(" | "));
    console.error("Children log tail: " + readFileSync(join(artifacts, "children.log"), "utf8").slice(-2000));
    process.exitCode = 1;
  } else {
    console.log("Models-config Web regression passed. Artifacts: " + artifacts);
  }
  if (process.env.HEPI_KEEP_ARTIFACTS === undefined) rmSync(artifacts, { recursive: true, force: true });
}
