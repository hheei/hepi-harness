/**
 * Ticket 13 regression, driven through the real production Web UI, a real backend and a real gateway.
 *
 * A selected model is deleted from the backend's own models.json. The next prompt must show the framework's own
 * no_model failure: the turn is never answered by a fabricated assistant reply, the deleted model is never called, and
 * another session on a valid model is unaffected. The selection stays the reference the user chose (no automatic
 * fallback), survives a backend restart and a browser reload together with the visible failure, and an explicit
 * reselection through the composer's model selector resumes normally on the controlled provider.
 *
 * The deleted model is owned by a *new* provider the editor creates in this file, so removing it really removes the
 * model: the environment deployment's own alias is a separate provider and is never touched.
 *
 * The model and the reasoning level a **fresh** composer picks are the conversation's from its first prompt: the
 * conversation does not exist when the pick is made (the send creates it), so nothing but the creation path can carry
 * the choice, and the deployment's default model must serve no request of that session. The file-owned model declares
 * reasoning, so its own level list is the model's rather than the single "off" a non-reasoning model has.
 *
 * Every wait is an observable UI, request or state change; there are no fixed sleeps.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-missing-model-recovery.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-missing-model-token";
/** The environment deployment: the alias the backend registers from its own environment on every boot. */
const provider = "magpie";
const modelId = "deepseek-v4.1-flash";
/** A provider only this file owns, so deleting its model is a real deletion. */
const fileProvider = "fileonly";
const fileModelId = "ephemeral-1";
const apiKeyVar = "HEPI_PROVIDER_API_KEY";
/** This ticket's own ports, so nothing else's Next server or backend is touched. */
const webPort = 43113;
const backendPort = 44113;
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-missing-model-e2e-"));
const dataDir = join(artifacts, "data");
const agentDir = join(artifacts, "agent");
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });
const backendHeaders = { authorization: "Bearer " + token, "content-type": "application/json" };

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

/** One controlled OpenAI-completions endpoint. It records only real completions calls, so an empty list means no traffic. */
function controlledEndpoint(reply) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ model: JSON.parse(Buffer.concat(chunks).toString("utf8")).model });
      const frame = (payload) => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      // The ordinal makes each turn's answer a distinct rendered string, so a wait cannot be satisfied by an older turn.
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: requests.at(-1).model, choices: [{ index: 0, delta: { role: "assistant", content: reply + " " + requests.length }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: requests.at(-1).model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return {
    requests,
    listen: () => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()); }),
    origin: () => "http://127.0.0.1:" + server.address().port,
    close: () => new Promise((resolveClose) => { server.closeAllConnections(); server.close(() => resolveClose()); }),
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

/** Distinct replies, so which endpoint served a turn is read off the rendered conversation rather than inferred. */
const deletedEndpoint = controlledEndpoint("answered by the file endpoint");
const environmentEndpoint = controlledEndpoint("answered by the environment endpoint");
await deletedEndpoint.listen();
await environmentEndpoint.listen();

let browser;
let backend;
let backendOrigin;
let webOrigin;
let sessionId;
let otherSessionId;
const gatewayToken = "ux-missing-model-gateway-token";

/** The real workbench gateway: a turn resolves its execution environment through this host. */
async function startGateway() {
  const workspaceRoot = join(artifacts, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  const child = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), { HEPI_GATEWAY_PORT: String(port), HEPI_GATEWAY_TOKEN: gatewayToken, HEPI_WORKSPACE_ID: "local", HEPI_WORKSPACE_ROOT: workspaceRoot, HEPI_GATEWAY_DB: join(dataDir, "gateway.sqlite") }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + port;
  assert.ok(await waitForHttp(origin + "/v1/workbench", {}, 45_000).catch(() => true), "the gateway started: " + log().slice(-500));
  return origin;
}

async function startBackend() {
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort),
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
      HEPI_PROVIDER_BASE_URL: environmentEndpoint.origin() + "/v1",
      [apiKeyVar]: "env-key",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const log = capture(child);
  const origin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(origin + "/api/workspaces", backendHeaders, 45_000), "the backend started: " + log().slice(-500));
  return { child, origin };
}

/** One browser session against the real Web UI, with the durable conversation in view. */
async function newPage(id) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(webOrigin + "/?session=" + id, { waitUntil: "domcontentloaded" });
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

/** Pick a model in the composer's own selector, exactly as a user does. */
async function selectModel(page, optionName) {
  await page.locator(".model-selector button").first().click();
  await page.getByRole("option", { name: optionName }).click();
  await page.locator('[role="listbox"]').waitFor({ state: "detached", timeout: 30_000 });
}

async function openModelSettings(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Models", exact: true }).click();
}

async function closeSettings(page) {
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
}

/** Create the file-owned provider and its one model through the Settings > Models editor, then save. */
async function saveFileProvider(page, baseUrl) {
  await openModelSettings(page);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("button", { name: /OpenAI \/ Anthropic compatible/ }).click();
  await page.getByPlaceholder("provider-name").fill(fileProvider);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByPlaceholder("https://api.example.com/v1").fill(baseUrl);
  await page.getByPlaceholder("ENV_VAR_NAME, !shell-command, or literal key").fill("$" + apiKeyVar);
  await page.locator(".models-sidebar-add-item").first().click();
  await page.getByPlaceholder("model-id").fill(fileModelId);
  // The model's own capability: a reasoning model is offered levels, a non-reasoning one only "off", so this is what
  // makes the level a fresh session is created with observable at all.
  await page.getByRole("checkbox", { name: "Reasoning / thinking" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor({ timeout: 30_000 });
  await closeSettings(page);
}

/** Delete that one model through the same editor: the provider stays, the model does not. */
async function deleteFileModel(page) {
  await openModelSettings(page);
  // The provider and model rows are the panel's own sidebar; the section navigation above only holds the sections.
  await page.locator(".config-sidebar").getByRole("button", { name: fileProvider, exact: true }).click();
  // The row is named by its id; a capability badge of its own is a separate span in the same row, so the id is
  // matched as the row's name rather than as its whole text.
  await page.locator(".config-sidebar").getByRole("button", { name: new RegExp("^" + fileModelId + "\\b") }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor({ timeout: 30_000 });
  await closeSettings(page);
}

async function createConversation() {
  const created = await fetch(backendOrigin + "/api/conversations", { method: "POST", headers: backendHeaders, body: JSON.stringify({ workspaceId: "local" }) });
  assert.equal(created.status, 201);
  return (await created.json()).conversationId;
}

async function backendState(id) {
  return await (await fetch(backendOrigin + "/api/conversations/" + id + "/state", { headers: backendHeaders })).json();
}

let gatewayOrigin;
try {
  gatewayOrigin = await startGateway();
  backendOrigin = (await startBackend()).origin;
  backend = children.at(-1);

  webOrigin = "http://127.0.0.1:" + webPort;
  const web = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], {
    cwd: webRoot,
    env: childEnv(join(artifacts, "web-home"), { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the Web UI started: " + webLog().slice(-500));

  browser = await chromium.launch();
  sessionId = await createConversation();
  otherSessionId = await createConversation();
  const { page, context, pageErrors } = await newPage(sessionId);

  // The file-owned provider and its model, saved through the editor as a user would.
  await saveFileProvider(page, deletedEndpoint.origin() + "/v1");
  const file = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
  check(file.providers?.[fileProvider]?.models?.[0]?.id === fileModelId, "the editor's save created the file-owned model");

  // Select it and use it, so the conversation is bound to a model that is about to disappear.
  await selectModel(page, fileModelId);
  await ask(page, "before-deletion", "answered by the file endpoint 1");
  check(deletedEndpoint.requests.length === 1 && environmentEndpoint.requests.length === 0, "the file-owned model served the first turn");

  // A **fresh** composer, in its own context: the model and the level are chosen before any conversation exists, and
  // the first prompt is the request that must carry them. This is the path the creation adapter owns — the send itself
  // creates the conversation, so no `set_model` command precedes the prompt — and it is the path a user takes every
  // time they start a session with a model in mind. The conversation the pick creates is found in the catalog as the id
  // the catalog did not hold before the send, and its own settings are read from the backend, not from the UI.
  const fresh = await newPage(sessionId);
  const known = new Set((await (await fetch(backendOrigin + "/api/conversations", { headers: backendHeaders })).json()).conversations.map((item) => item.id));
  await fresh.page.locator(".sidebar-new-button").click();
  await fresh.page.locator("textarea").first().waitFor();
  await selectModel(fresh.page, fileModelId);
  const reasoningButton = fresh.page.getByRole("button", { name: "Change reasoning level", exact: true });
  await reasoningButton.click();
  await fresh.page.getByRole("option", { name: /^high\b/ }).click();
  check(/high/i.test(await reasoningButton.innerText()), "the fresh composer states the chosen reasoning level before anything is sent");
  check((await (await fetch(backendOrigin + "/api/conversations", { headers: backendHeaders })).json()).conversations.every((item) => known.has(item.id)), "choosing a model and a level in a fresh composer creates no conversation");
  await ask(fresh.page, "fresh-composer", "answered by the file endpoint 2");
  const created = (await (await fetch(backendOrigin + "/api/conversations", { headers: backendHeaders })).json()).conversations.find((item) => !known.has(item.id));
  check(created !== undefined, "the first prompt created the conversation");
  check(deletedEndpoint.requests.length === 2 && environmentEndpoint.requests.length === 0, "the chosen model served the fresh session's first request: the deployment's default was never called");
  check(deletedEndpoint.requests.at(-1).model === fileModelId, "the first provider request of the fresh session named the chosen model: " + JSON.stringify(deletedEndpoint.requests.at(-1)));
  const freshSettings = created === undefined ? {} : (await backendState(created.id)).settings;
  check(JSON.stringify(freshSettings.model) === JSON.stringify({ provider: fileProvider, modelId: fileModelId }), "the created conversation's own settings state the chosen model: " + JSON.stringify(freshSettings));
  check(freshSettings.thinkingLevel === "high", "and the chosen reasoning level: " + JSON.stringify(freshSettings));
  check(fresh.pageErrors.length === 0, "no page error occurred in the fresh composer: " + fresh.pageErrors.join(" | "));
  await fresh.context.close();

  // A creation that is refused dispatches nothing: the send gets the refusal answer, no prompt is submitted for a
  // conversation that was never created, the controlled provider is never called, and the text stays with the user.
  // The adapter's own public test proves the real settings refusal happens before the state read and before any
  // prompt; this is the browser's half of that contract, driven with the refusal answer the route itself returns
  // rather than by changing the backend.
  const refused = await newPage(sessionId);
  const catalogCount = async () => (await (await fetch(backendOrigin + "/api/conversations", { headers: backendHeaders })).json()).conversations.length;
  const refusedCount = await catalogCount();
  let creations = 0;
  await refused.page.route("**/api/agent/new", (route) => {
    creations += 1;
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unknown model" }) });
  });
  const prompts = [];
  refused.page.on("request", (request) => {
    if (request.method() !== "POST") return;
    try {
      const body = request.postDataJSON();
      if (body?.type === "prompt") prompts.push(body);
    } catch { /* a request that is not JSON carries no prompt command */ }
  });
  await refused.page.locator(".sidebar-new-button").click();
  await refused.page.locator("textarea").first().waitFor();
  await selectModel(refused.page, fileModelId);
  const refusedComposer = refused.page.locator("textarea").first();
  await refusedComposer.fill("refused-create");
  await refused.page.getByRole("button", { name: "Send", exact: true }).click();
  await refused.page.getByText(/HTTP 400|unknown model/).first().waitFor({ timeout: 30_000 });
  check(creations === 1, "the send attempted the creation, so the refusal is the answer it got");
  check((await refusedComposer.inputValue()) === "refused-create", "a refused creation keeps the user's text in the composer");
  check(prompts.length === 0, "no prompt command was dispatched");
  check((await catalogCount()) === refusedCount, "no conversation was created");
  check(deletedEndpoint.requests.length === 2 && environmentEndpoint.requests.length === 0, "the controlled provider was never called for the refused send");
  check(refused.pageErrors.length === 0, "no page error occurred for the refused creation: " + refused.pageErrors.join(" | "));
  await refused.context.close();

  // Delete that model. The conversation's selection is not rewritten; only the catalog loses it.
  await deleteFileModel(page);
  const catalog = await (await fetch(backendOrigin + "/api/models", { headers: backendHeaders })).json();
  check(!catalog.models.some((model) => model.provider === fileProvider), "the deleted model is gone from the catalog");
  check(JSON.stringify((await backendState(sessionId)).settings.model) === JSON.stringify({ provider: fileProvider, modelId: fileModelId }), "the selection is preserved instead of being switched to another model");

  // The next prompt is the failure itself: never an assistant reply, and the deleted model is never called.
  const composer = page.locator("textarea").first();
  await composer.click();
  await composer.fill("after-deletion");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("This turn could not be answered", { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByText(new RegExp("Model " + fileProvider + "/" + fileModelId + " is not available")).waitFor({ timeout: 30_000 });
  check(true, "the framework's own no_model failure is shown above the composer");
  check(deletedEndpoint.requests.length === 2 && environmentEndpoint.requests.length === 0, "no request was made for the deleted model");
  check(await page.getByText("after-deletion", { exact: true }).count() > 0, "the user's turn is in the transcript");
  check(await page.getByText(/answered by the file endpoint/).count() === 1, "the failed turn produced no assistant reply");
  check(await page.locator("textarea").first().isEnabled(), "the composer accepts input again: the run is not left busy");


  // Another session on a model that still exists is unaffected.
  const other = await newPage(otherSessionId);
  await ask(other.page, "other-session", "answered by the environment endpoint 1");
  check(environmentEndpoint.requests.length === 1, "a session on a valid model is served normally");
  check(await other.page.getByText("This turn could not be answered", { exact: true }).count() === 0, "the other session shows no failure");
  await other.context.close();

  // A backend restart and a browser reload keep the selection and the observable failure: neither is a client callback.
  await stop(backend);
  backend = (await startBackend()).child;
  check(JSON.stringify((await backendState(sessionId)).settings.model) === JSON.stringify({ provider: fileProvider, modelId: fileModelId }), "the missing selection survives the backend restart");
  await context.close();
  const reopened = await newPage(sessionId);
  await reopened.page.getByText("This turn could not be answered", { exact: true }).waitFor({ timeout: 60_000 });
  check(true, "the failure is observable again after the restart and reload");
  // The composer's selector is the one place the selection is stated, so its own label is what is asserted. It waits
  // for the catalog read to land, because that is what tells the composer this selection is no longer offered.
  await reopened.page.waitForFunction(
    (expected) => document.querySelector(".model-selector")?.textContent?.includes(expected) ?? false,
    fileProvider + "/" + fileModelId + " (unavailable)",
    { timeout: 30_000 },
  );
  check(true, "the composer names the selected model as unavailable");
  check(await reopened.page.getByText(/answered by the file endpoint/).count() === 1, "the reloaded transcript still has no assistant reply for the failed turn");

  // Explicit recovery through the same selector: the newly selected model serves the next turn and the failure clears.
  // The option is named by the catalog, so its label is read from the backend rather than guessed.
  const catalogAgain = await (await fetch(backendOrigin + "/api/models", { headers: backendHeaders })).json();
  const environmentName = catalogAgain.models.find((model) => model.provider === provider).name;
  await selectModel(reopened.page, new RegExp("^" + environmentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  await ask(reopened.page, "after-reselection", "answered by the environment endpoint 2");
  check(await reopened.page.getByText("This turn could not be answered", { exact: true }).count() === 0, "the failure clears once a valid model answers");
  check(environmentEndpoint.requests.length === 2, "the reselected model reached the provider");
  check(await reopened.page.locator(".model-selector").innerText() === environmentName, "the composer shows the reselected model");
  check(pageErrors.length === 0 && reopened.pageErrors.length === 0, "no page error occurred: " + [...pageErrors, ...reopened.pageErrors].join(" | "));
  await reopened.context.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children) await stop(child);
  await deletedEndpoint.close();
  await environmentEndpoint.close();
  if (failures.length > 0) {
    console.error("Missing-model Web regression failed: " + failures.join(" | "));
    console.error("Children log tail: " + readFileSync(join(artifacts, "children.log"), "utf8").slice(-2000));
    process.exitCode = 1;
  } else {
    console.log("Missing-model Web regression passed. Artifacts: " + artifacts);
  }
  if (process.env.HEPI_KEEP_ARTIFACTS === undefined) rmSync(artifacts, { recursive: true, force: true });
}
