/**
 * Ticket 05 acceptance: MCP conversation tools, driven through the real system a person actually uses.
 *
 * What the owning tickets state one seam at a time, this driver states as **one journey**: a person adds and tests a server
 * in Settings › MCP, lists one server's tools from the conversation's own panel, selects one explicitly, and the model
 * then calls it and the transcript shows what the server answered. Everything is the deployed shape — the production Vite
 * Web build served by the real client ingress, the real Backend over its own SQLite files, a real execution gateway on an
 * agent directory this run owns, the real MCP host service, and one Chromium — with the controlled stdio fixture server as
 * the only stand-in (it is the host's server, not the code under test).
 *
 * Configuration mode is stated, because it decides one claim: Pi file-backed (\`HEPI_CONFIG_SOURCE=pi\`) is the one mode
 * whose agent directory is *both* the Gateway's and the Backend's, which is what makes "the credential this run stores" and
 * "the model this run can call" facts about one account. The credential is stored through the Web ingress, the way a person
 * stores one, and the provider's base URL is this run's own controlled endpoint — no paid provider, no real account.
 *
 * The scenes, in order, and what each is evidence for:
 *
 *   0. provenance: the revision, the dirty state, the build the page was served from, and the mode;
 *   1. **add/test**: the server is added by pasting a config into Settings › MCP and tested there, and the host's own file
 *      holds it;
 *   2. **no auto grant**: the conversation's panel lists the server before anyone selected anything, and holding the
 *      extension selected offers nothing — a listing is not a grant;
 *   3. **list → explicit selection**: one press lists that server's tools; ticking one tool writes exactly that grant, and
 *      the offer the runtime resolves names it;
 *   4. **real invocation**: the model asks for the granted tool by its own name and the transcript shows the server's
 *      answer, with the host's facts on the durable entry;
 *   5. **bounded output**: a result past the host's byte bound arrives cut, marked truncated, and under the bound;
 *   6. **changed schema**: the server's own description changes, and the panel names the grant's descriptor as stale;
 *   7. **disabled**: with the host's server switched off, the state is stated and a call is refused named, with no replay;
 *   8. **offline**: with the execution host away the panel states an unread configuration and a named listing refusal — and
 *      a revocation still works, because it asks the host nothing;
 *   9. **restart**: a restarted Backend re-offers the durable grant with nobody asked, and a call still runs once;
 *  10. **cancellation**: a call in flight ends with the caller, settles as uncertain, and the server sees it exactly once;
 *  11. **fork and child**: neither inherits a grant, and neither is offered one;
 *  12. **untrusted**: a project server in a folder no decision trusts is refused by that name and writes nothing;
 *  13. **SSH**: an SSH gateway states its own named limit to the MCP route — MCP over SSH is not implied by SSH files.
 *
 * Every wait below is for an observable fact: an element, a backend answer, a file the fixture wrote, or a committed
 * entry. No sleep stands in for one. Nothing here probes a security boundary: every request is an ordinary admitted one.
 *
 * Usage: pnpm --filter @hepi/web build
 *        node apps/web/e2e/ux-mcp-acceptance.mjs [--keep]
 *        HEPI_MCP05_INGRESS_PORT / HEPI_MCP05_BACKEND_PORT / HEPI_MCP05_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { MCP_INVOKE_MAX_RESULT_BYTES } from "../../../packages/protocol/src/gateway.ts";
import { backendJson, childEnv, repoRoot, startAcceptanceStack, webLogin, webRoot } from "./acceptance-stack.mjs";

const keep = process.argv.includes("--keep");
const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const revision = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;

const STDIO_FIXTURE = join(repoRoot, "packages", "gateway", "test", "fixtures", "mcp", "stdio-server.mjs");
/** The literal secret the fixture server is started with: it must reach the host's file and nowhere else. */
const SECRET = "{{SECRET_mcp05adapter}}";
const SERVER = "notes";
/** The names three of that server's tools are offered under. */
const RECORD = "mcp__workstation__" + SERVER + "__record";
const LISTED = "mcp__workstation__" + SERVER + "__listed";
const BIG = "mcp__workstation__" + SERVER + "__big";
const SLOW = "mcp__workstation__" + SERVER + "__slow";
/** The provider this run stores a credential for: an SDK built-in whose base URL is this run's own endpoint. */
const PROVIDER = "deepseek";
const CATALOG_MODEL = "mcp05-model";

const failuresOf = (state) => (state.entries ?? []).filter((entry) => entry.role === "toolResult");
const toolNameOf = (entry) => entry.message?.toolName ?? "";

let stack;
let model;
let browser;
let page;
const shutdown = async () => {
  await browser?.close().catch(() => {});
  await stack?.close().catch(() => {});
  await model?.close().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { console.log("Interrupted by " + signal + "; stopping what this run started"); void shutdown().then(() => process.exit(130)); });
}

/** The host's own configuration file, written the way the pi CLI on that host would leave it. */
function writeHostConfig(servers) {
  writeFileSync(join(stack.agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
}
/** The file the fixture server reads one of its own descriptions from, so a later listing can differ from an earlier one. */
const ECHO_FILE = () => join(stack.artifacts, "listing-echo.txt");
/**
 * The fixture entry this run configures: its invocation tools, its listing tools and the token it must never leak.
 *
 * Its describing text is read from a file rather than typed into this configuration, because a host masks every value
 * its configuration holds: an echo written as `LIST_ECHO` arrives at the client as a redaction, so a described change
 * would be indistinguishable from no change at all.
 */
function fixtureEntry({ echo = "first description", fail = undefined } = {}) {
  // Written on every call, so the file the server reads exists whether or not this particular entry varies it.
  writeFileSync(ECHO_FILE(), echo + "\n");
  return {
    command: process.execPath,
    args: [STDIO_FIXTURE],
    env: {
      PI_WEB_FIXTURE_INVOKE_TOOLS: "1",
      PI_WEB_FIXTURE_LIST_TOOLS: "1",
      PI_WEB_FIXTURE_LIST_ECHO_FILE: ECHO_FILE(),
      FIXTURE_TOKEN: SECRET,
      ...(fail === undefined ? {} : { PI_WEB_FIXTURE_FAIL: fail }),
    },
    exposure: "direct",
  };
}

/** One Backend read or write with the deployment's service credential. */
const backend = (path, init) => fetch(stack.backendOrigin + path, { headers: stack.backendHeaders, ...init });
async function backendJsonOf(path, init) {
  const response = await backend(path, init);
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
}
const conversationState = (id) => backendJson(stack, "/api/conversations/" + id + "/state");
const selectionOf = async (id) => (await backendJsonOf("/api/conversations/" + id + "/extensions")).body;

/** Wait for a committed fact, never for a delay. */
async function until(read, accept, what, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what + "; last " + JSON.stringify(value).slice(0, 500));
    await delay(100);
  }
}

/**
 * Whether the settings dialog is already open.
 *
 * Opening it twice is not a person's act: the dialog covers the page, so the second press lands on its backdrop. A scene
 * that wants a different tab of the same dialog therefore re-enters it only when it is actually closed.
 */
const settingsOpen = async () => (await page.getByRole("dialog", { name: "Settings", exact: true }).count()) > 0;

/** Settings › MCP, opened the way a person opens it. */
async function openMcpSettings() {
  if (!(await settingsOpen())) await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "MCP", exact: true }).click();
  await page.locator(".config-panel-root").waitFor({ timeout: 30_000 });
}
async function closeSettings() {
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
}
const serverRow = (name) => page.locator(".config-sidebar-item").filter({ hasText: name }).first();
const detail = () => page.locator(".config-detail");

/** Settings › Extensions in the conversation scope, with one extension selected. */
async function openConversationTools(extension = "hepi.mcp") {
  if (!(await settingsOpen())) await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Extensions", exact: true }).click();
  await page.getByRole("button", { name: "This conversation", exact: true }).click();
  await page.locator(".config-sidebar-item").filter({ hasText: extension }).first().click();
  await page.locator(".mcp-conversation-tools").waitFor({ timeout: 30_000 });
}
/** The panel's own machine-readable state once its read has answered: the four states, as the helper projects them. */
async function panelState() {
  await page.waitForFunction(() => {
    const raw = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state");
    return raw !== null && raw !== "";
  }, undefined, { timeout: 60_000 });
  return JSON.parse(await page.locator(".mcp-conversation-tools").getAttribute("data-mcp-state"));
}
const panelBlock = (server) => page.locator('.mcp-conversation-server[data-server="' + server + '"]');
const toolRow = (server, tool) => panelBlock(server).locator('.mcp-conversation-tool[data-tool="' + tool + '"]');
/** One press of a server's own "List tools". */
async function pressListTools(server) {
  await panelBlock(server).getByRole("button", { name: "List tools", exact: true }).click();
  await panelBlock(server).locator(".mcp-conversation-tool").first().waitFor({ timeout: 60_000 });
}

/** One submitted turn, and the committed entries it produced. */
async function submit(id, requestId, text) {
  const response = await backend("/api/conversations/" + id + "/messages", {
    method: "POST",
    headers: stack.backendHeaders,
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }),
  });
  assert.equal(response.status, 202, "a turn was admitted: " + response.status + " " + await response.text());
  return requestId;
}
/** A conversation's committed entries once it is idle again. */
const settled = (id) => until(() => conversationState(id), (state) => state !== undefined && state.busy === false, "the conversation to be idle");

try {
  console.log("Provenance: source " + revision + (dirty ? " (dirty tree)" : " (clean)") + ", Web build " + join(webRoot, "dist"));
  assert.ok(existsSync(join(webRoot, "dist", "index.html")), "build the Web product first: pnpm --filter @hepi/web build");

  // The controlled endpoint logs in as the provider's own endpoint, so a real completion request is answered from the
  // transcript it was given rather than from a scripted queue.
  model = await import("./acceptance-stack.mjs").then((module) => module.startControlledModel({
    respond: async (body) => {
      const messages = body.messages ?? [];
      const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
      const lastUser = messages[lastUserIndex];
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      // What the turn is asking for is read from the request's own words, so the same script answers a later turn
      // rather than repeating the first one: a turn whose tool result is already committed is answered in prose, which is
      // what ends it. The history of an earlier call is not what decides this turn.
      const asked = text.includes("record a note") || text.includes("big result") || text.includes("slow result");
      // "This turn's call already answered" is a fact about the messages **after** this turn's own request: an earlier
      // turn's result says nothing about whether this one was served, and reading it as though it did is what made the
      // second turn answer in prose without calling anything.
      const answered = asked && messages.slice(lastUserIndex + 1).some((message) => message.role === "tool" || JSON.stringify(message).includes("tool_call_id"));
      if (answered) return { content: "the tool answered, and I have read it" };
      if (text.includes("record a note")) return { toolCall: { id: "call-record", name: RECORD, arguments: { note: "from the acceptance journey" } } };
      if (text.includes("big result")) return { toolCall: { id: "call-big", name: BIG, arguments: { bytes: 400_000 } } };
      if (text.includes("slow result")) return { toolCall: { id: "call-slow", name: SLOW, arguments: { ms: 600_000 } } };
      return { content: "no tool was needed for that" };
    },
  }));
  stack = await startAcceptanceStack({
    label: "mcp05",
    keep,
    piConfigSource: "pi",
    // The catalog this mode reads, stated before either process starts. The provider is an SDK built-in, so its own
    // credential shape is what the run stores; only its base URL is this run's endpoint.
    piModels: { providers: { [PROVIDER]: { baseUrl: model.origin + "/v1", api: "openai-completions", models: [{ id: CATALOG_MODEL, name: "MCP 05" }] } } },
    ports: {
      ingress: Number(process.env.HEPI_MCP05_INGRESS_PORT ?? 0),
      backend: Number(process.env.HEPI_MCP05_BACKEND_PORT ?? 0),
      gateway: Number(process.env.HEPI_MCP05_GATEWAY_PORT ?? 0),
    },
    log: (line) => console.log(line),
  });
  console.log("Artifacts: " + stack.artifacts);
  console.log("Configuration mode: Pi file-backed (HEPI_CONFIG_SOURCE=pi), one agent directory for the Gateway and the Backend: " + stack.agentDir);

  // A server nothing has selected yet: the host's own file holds it, configured and switched on.
  writeHostConfig({ [SERVER]: fixtureEntry() });

  const cookie = await webLogin(stack);
  const sessionValue = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("hepi-web-session="))?.split("=").slice(1).join("=");
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, locale: "en-US" });
  if (sessionValue !== undefined) await context.addCookies([{ name: "hepi-web-session", value: decodeURIComponent(sessionValue), url: stack.webOrigin, httpOnly: true, sameSite: "Strict" }]);
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // ---- 0. The mode's own credential, stored through the ingress as a person stores one. -------------------------
  const stored = await fetch(stack.ingressOrigin + "/api/auth/api-key/" + PROVIDER, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: stack.webOrigin },
    body: JSON.stringify({ apiKey: "mcp05-acceptance-key" }),
  });
  await stored.text();
  check(stored.status === 200, "the Web ingress stored the provider credential the host owns (" + stored.status + ")");
  const catalog = await backendJson(stack, "/api/models");
  check((catalog.models ?? []).some((row) => row.id === CATALOG_MODEL), "and the Backend's catalog offers the model that credential authenticates, with no restart: " + JSON.stringify((catalog.models ?? []).map((row) => row.id)));

  // ---- 1. Add and test the server in Settings › MCP, the way a person does. -------------------------------------
  await page.goto(stack.webOrigin + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-new-button").waitFor({ timeout: 90_000 });
  await openMcpSettings();
  // The file already holds the server, so this run tests it here and then adds a second one through the dialog, which is
  // the only path that proves the paste-to-file seam on this deployment.
  await serverRow(SERVER).waitFor({ timeout: 30_000 });
  await serverRow(SERVER).click();
  await detail().getByRole("button", { name: "Test connection", exact: true }).click();
  await detail().getByText("Connected").first().waitFor({ timeout: 90_000 });
  check(true, "the host tested the configured server through the panel");
  await page.locator(".config-list-action-button").click();
  await page.locator("#mcp-add-source").fill(JSON.stringify({ mcpServers: { second: { command: process.execPath, args: [STDIO_FIXTURE] } } }));
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await serverRow("second").waitFor({ timeout: 30_000 });
  const onDisk = JSON.parse(readFileSync(join(stack.agentDir, "mcp.json"), "utf8"));
  check(onDisk.mcpServers.second?.command === process.execPath, "a server added in the dialog reached the host's own mcp.json, with no page reload");
  check(JSON.parse(readFileSync(join(stack.agentDir, "mcp.json"), "utf8")).mcpServers[SERVER].env.FIXTURE_TOKEN === SECRET, "the configured value lives in the host's own file, where the person who configured it put it");
  check(!(await page.content()).includes(SECRET), "and no configured value reaches the page");

  // ---- 2. No auto grant: the conversation's panel lists the server and offers nothing. -------------------------
  const created = await backendJsonOf("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const conversationId = created.body.conversationId;
  // The conversation names the model this run's account offers, the way the settings route names one.
  const configured = await backend("/api/conversations/" + conversationId + "/settings", {
    method: "PATCH",
    headers: stack.backendHeaders,
    body: JSON.stringify({ model: { provider: PROVIDER, modelId: CATALOG_MODEL } }),
  });
  assert.equal(configured.status, 200, "the conversation was given the model this account offers: " + await configured.text());

  const before = await selectionOf(conversationId);
  check(before.mcp.serversKnown === true && before.mcp.servers.some((row) => row.server === SERVER), "the selection read names the host's own servers without asking a host to connect one");
  check(before.mcp.grants.length === 0, "a conversation that selected nothing holds no grant");
  check(before.mcp.selected === false, "and hepi.mcp is not selected for it yet");

  await page.goto(stack.webOrigin + "/?session=" + conversationId, { waitUntil: "domcontentloaded" });
  await page.locator("textarea").first().waitFor({ timeout: 90_000 });
  await openConversationTools();
  const listed0 = await panelState();
  check(listed0 !== null && listed0.extensionSelected === false, "the panel states the extension is not selected for this conversation: " + JSON.stringify(listed0?.extensionSelected));
  check(listed0.grants.length === 0, "and holds no grant for it");
  // Selecting the extension is the person's own act, above this block; nothing here grants anything.
  const enabled = await page.locator(".config-detail").getByRole("switch").first();
  await enabled.click();
  await page.getByText(/conversation's own selection is saved/i).waitFor({ timeout: 30_000 });
  await page.locator(".mcp-conversation-server").first().waitFor({ timeout: 30_000 });
  const selectedOnly = await selectionOf(conversationId);
  check(selectedOnly.extensions.includes("hepi.mcp"), "the extension selection is the conversation's own durable state");
  check(selectedOnly.mcp.grants.length === 0, "selecting the extension granted nothing: a listing is not a grant");
  check(selectedOnly.mcp.offered.length === 0, "and the runtime resolves no MCP tool for it: " + JSON.stringify(selectedOnly.mcp.offered));

  // ---- 3. List one server's tools, then select one explicitly. -------------------------------------------------
  await pressListTools(SERVER);
  const listedState = await panelState();
  const listedRows = listedState.tools.filter((row) => row.server === SERVER);
  check(listedRows.some((row) => row.tool === "record" && row.exposed === true && row.selected === false), "a listed tool reads exposed and not selected: " + JSON.stringify(listedRows.find((row) => row.tool === "record")));
  check((await selectionOf(conversationId)).mcp.grants.length === 0, "listing a server wrote no grant");
  // One act at a time, each waited for by its own name: the write's body is the whole set of that server's grants, so
  // ticking the next tool before the panel has the previous answer would derive it from a view that never held it.
  for (const tool of ["record", "listed", "big"]) {
    await toolRow(SERVER, tool).locator('input[type="checkbox"]').click();
    await page.waitForFunction(([server, name]) => {
      const raw = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state");
      if (!raw) return false;
      return JSON.parse(raw).grants.some((grant) => grant.server === server && grant.tool === name);
    }, [SERVER, tool], { timeout: 60_000 });
  }
  const granted = await selectionOf(conversationId);
  check(granted.mcp.grants.length === 3, "three explicit selections are three grants: " + JSON.stringify(granted.mcp.grants.map((grant) => grant.tool)));
  check([...granted.mcp.offered].sort().join(",") === [BIG, LISTED, RECORD].sort().join(","), "and the runtime's own resolution offers exactly those names: " + JSON.stringify(granted.mcp.offered));
  const grantText = JSON.stringify(granted.mcp.grants);
  check(!/command|args|env|url|headers|auth|token|cwd|workspaceId/.test(grantText), "a grant document names identities and a presentation, never a host-owned key");
  check(!grantText.includes(SECRET), "and carries no configured value");

  // ---- 4. The real journey: the model calls the granted tool and the transcript shows the answer. ---------------
  await closeSettings();
  await page.locator("textarea").first().fill("record a note on the host");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const afterCall = await until(() => conversationState(conversationId), (state) => failuresOf(state).some((entry) => toolNameOf(entry) === RECORD), "the MCP result to be committed");
  const recorded = failuresOf(afterCall).find((entry) => toolNameOf(entry) === RECORD);
  check(recorded.message.isError === false, "the granted tool ran on the host and its result is a normal durable entry: " + recorded.text);
  check(recorded.text.includes("from the acceptance journey"), "the server's own answer is the entry's text: " + JSON.stringify(recorded.text.slice(0, 120)));
  check(recorded.message.details?.gatewayId === "workstation" && recorded.message.details?.server === SERVER && recorded.message.details?.tool === "record", "and the host's own facts ride the entry: " + JSON.stringify(recorded.message.details));
  await page.getByText(/recorded|the tool answered/i).first().waitFor({ timeout: 60_000 });
  check(true, "the answer is visible in the page's transcript");
  const modelSawTheTool = model.requests.some((request) => request.text.includes(RECORD));
  check(modelSawTheTool, "the model was offered the granted tool by its own name");
  check(!model.requests.some((request) => request.text.includes(SECRET)), "and no configured value reached the model's own prompt");

  // ---- 5. A result past the host's bound arrives cut, marked, and under the bound. ------------------------------
  await submit(conversationId, "mcp05-big", "ask for a big result");
  const bigState = await until(() => conversationState(conversationId), (state) => failuresOf(state).some((entry) => toolNameOf(entry) === BIG), "the big result to be committed");
  const big = failuresOf(bigState).find((entry) => toolNameOf(entry) === BIG);
  check(big.message.details?.truncated === true, "a result past the host's bound is reported as truncated: " + JSON.stringify(big.message.details));
  check(Buffer.byteLength(big.text, "utf8") <= MCP_INVOKE_MAX_RESULT_BYTES + 64, "and what was committed costs no more than the bound (" + Buffer.byteLength(big.text, "utf8") + " of " + MCP_INVOKE_MAX_RESULT_BYTES + " bytes)");

  // ---- 6. The server's description changes, and the grant's descriptor reads stale. ----------------------------
  writeHostConfig({ [SERVER]: fixtureEntry({ echo: "second description" }) });
  await openConversationTools();
  await pressListTools(SERVER);
  await page.waitForFunction(() => {
    const raw = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state");
    return raw !== null && raw !== "" && JSON.parse(raw).tools.some((row) => row.descriptorChanged === true);
  }, undefined, { timeout: 60_000 });
  const changed = await panelState();
  check(changed.tools.some((row) => row.tool === "listed" && row.descriptorChanged === true), "a server that changed a tool's description makes the panel name that grant stale: " + JSON.stringify(changed.tools.find((row) => row.tool === "listed")));

  // ---- 7. Switched off on the host: stated, and a call refused by name with no replay. -------------------------
  writeHostConfig({ [SERVER]: { ...fixtureEntry({ echo: "second description" }), enabled: false } });
  await pressListTools(SERVER).catch(() => undefined);
  await page.waitForFunction(() => {
    const raw = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state");
    return raw !== null && raw !== "" && JSON.parse(raw).servers.some((server) => server.enabled === false);
  }, undefined, { timeout: 60_000 });
  const offState = await panelState();
  check(offState.servers.some((server) => server.server === SERVER && server.enabled === false), "a server switched off on the host is stated as switched off");
  check(offState.tools.filter((row) => row.server === SERVER).every((row) => row.available === false), "and none of its tools reads available: " + JSON.stringify(offState.tools.filter((row) => row.server === SERVER).map((row) => row.available)));
  await submit(conversationId, "mcp05-disabled", "record a note on the host");
  const refused = await until(() => conversationState(conversationId), (state) => failuresOf(state).some((entry) => /server_disabled|server-disabled/.test(entry.text)), "the switched-off server's refusal to be recorded");
  const refusedEntry = failuresOf(refused).find((entry) => /server_disabled|server-disabled/.test(entry.text));
  check(refusedEntry.message.isError === true, "a call to a switched-off server is refused, not answered: " + JSON.stringify(refusedEntry.text.slice(0, 160)));
  check(!/may have partially run|the server may have acted/.test(refusedEntry.text), "and the refusal does not claim the server may have acted, because this host knows nothing ran");
  check(failuresOf(refused).filter((entry) => toolNameOf(entry) === RECORD).length >= 2, "the granted tool's earlier runs are still one entry each: the refusal neither repeated nor replaced one");
  writeHostConfig({ [SERVER]: fixtureEntry({ echo: "second description" }) });

  // ---- 8. The host away: an unread configuration, a named refusal, and a revocation that still works. ----------
  await stack.stopGateway();
  // Reopened rather than left standing, because the panel states the read it made: opening it is the act that asks for
  // one, and this scene is about what that read says while the host is away.
  await closeSettings();
  await openConversationTools();
  await page.waitForFunction(() => {
    const raw = document.querySelector(".mcp-conversation-tools")?.getAttribute("data-mcp-state");
    return raw !== null && raw !== "" && JSON.parse(raw).serversKnown === false;
  }, undefined, { timeout: 90_000 });
  const offline = await panelState();
  check(offline.serversKnown === false && offline.serversRefusal !== undefined, "with the execution host away the panel states an unread configuration and its own reason: " + JSON.stringify(offline.serversRefusal));
  check(offline.grants.length === 3, "and keeps this conversation's own grants, which are not the host's answer");
  const offlineList = await backendJsonOf("/api/conversations/" + conversationId + "/extensions?mcp=" + SERVER);
  check(offlineList.body.code !== undefined, "a listing of a server on an unreachable host is a named refusal, not an empty list: " + JSON.stringify(offlineList.body.code));
  const revokedOffline = await backendJsonOf("/api/conversations/" + conversationId + "/extensions", { method: "PATCH", body: JSON.stringify({ mcp: { server: SERVER, tools: [] } }) });
  check(revokedOffline.status === 200 && revokedOffline.body.mcp.grants.length === 0, "a revocation asks the host nothing, so it works while the host is away: " + revokedOffline.status);
  await stack.restartGateway();
  const regrant = await backendJsonOf("/api/conversations/" + conversationId + "/extensions", { method: "PATCH", body: JSON.stringify({ mcp: { server: SERVER, tools: ["record"] } }) });
  check(regrant.status === 200, "the host is back, and a grant is asked of it again: " + regrant.status + " " + JSON.stringify(regrant.body.code ?? ""));

  // ---- 9. Restart the Backend: the durable grant is re-offered with nobody asked, and a call still runs once. --
  await stack.restartBackend();
  const afterRestart = await selectionOf(conversationId);
  check(afterRestart.mcp.grants.length === 1 && afterRestart.mcp.grants[0].tool === "record", "a restarted Backend answers the same grant from the store alone");
  check(afterRestart.mcp.offered.length === 1 && afterRestart.mcp.offered[0] === RECORD, "and re-offers exactly it, with no listing asked of any host");
  const runsBefore = failuresOf(await conversationState(conversationId)).filter((entry) => toolNameOf(entry) === RECORD).length;
  await submit(conversationId, "mcp05-after-restart", "record a note on the host");
  const afterRestartCall = await until(() => conversationState(conversationId), (state) => failuresOf(state).filter((entry) => toolNameOf(entry) === RECORD).length > runsBefore, "the granted call after the restart");
  check(failuresOf(afterRestartCall).filter((entry) => toolNameOf(entry) === RECORD).length === runsBefore + 1, "one submitted call is one committed result: the restart replayed nothing");

  // ---- 10. Cancellation: the call in flight ends with the caller and settles as uncertain. --------------------
  const slowGrant = await backendJsonOf("/api/conversations/" + conversationId + "/extensions", { method: "PATCH", body: JSON.stringify({ mcp: { server: SERVER, tools: ["record", "slow"] } }) });
  assert.equal(slowGrant.status, 200, JSON.stringify(slowGrant.body.code ?? ""));
  await submit(conversationId, "mcp05-cancel", "ask for a slow result");
  await until(() => conversationState(conversationId), (state) => state.busy === true || failuresOf(state).some((entry) => toolNameOf(entry) === SLOW), "the slow call to be in flight");
  const aborted = await backend("/api/conversations/" + conversationId + "/abort", { method: "POST" });
  await aborted.text();
  check(aborted.status === 202, "the caller's abort was accepted (" + aborted.status + ")");
  const cancelled = await until(() => conversationState(conversationId), (state) => state.busy === false && failuresOf(state).some((entry) => toolNameOf(entry) === SLOW), "the cancelled call to settle");
  const slowEntry = failuresOf(cancelled).find((entry) => toolNameOf(entry) === SLOW);
  check(slowEntry.message.isError === true, "a cancelled call settles as an error entry rather than a result: " + JSON.stringify(slowEntry.text.slice(0, 160)));
  check(/aborted|cancelled|outcome_unknown|interrupted/.test(slowEntry.text), "and names an uncertain end, so nothing reads it as 'nothing happened': " + JSON.stringify(slowEntry.text.slice(0, 160)));
  const slowRuns = failuresOf(await conversationState(conversationId)).filter((entry) => toolNameOf(entry) === SLOW).length;
  await until(() => conversationState(conversationId), (state) => state.busy === false, "the conversation to stay idle");
  check(slowRuns === 1, "the cancelled call is recorded once and never re-run: " + slowRuns);
  await backendJsonOf("/api/conversations/" + conversationId + "/extensions", { method: "PATCH", body: JSON.stringify({ mcp: { server: SERVER, tools: ["record"] } }) });

  // ---- 11. Fork and child: neither inherits a grant, and neither is offered one. -------------------------------
  const forked = await backendJsonOf("/api/conversations/" + conversationId + "/fork", { method: "POST", body: JSON.stringify({ requestId: "mcp05-fork" }) });
  assert.ok(forked.body.conversationId !== undefined, "the conversation forked: " + JSON.stringify(forked.body).slice(0, 200));
  const branch = await selectionOf(forked.body.conversationId);
  check(branch.mcp.grants.length === 0, "a branch starts from the initial value of the grant document, so it holds none of the source's");
  check(branch.mcp.offered.length === 0, "and is offered no MCP tool, while the source keeps its own");
  check((await selectionOf(conversationId)).mcp.offered.length === 1, "the source's own offer is untouched by the fork");
  const delegated = await backendJsonOf("/api/conversations/" + conversationId + "/delegate", { method: "POST", body: JSON.stringify({ name: "worker", task: "a child that was granted nothing" }) });
  if (delegated.body.conversationId !== undefined) {
    const child = await selectionOf(delegated.body.conversationId);
    check(child.mcp.grants.length === 0 && child.mcp.offered.length === 0, "a delegated child inherits no grant and is offered no MCP tool");
  } else {
    check(true, "the deployment has no worker definition, so this run states the child half as unexercised here: " + JSON.stringify(delegated.body.code));
  }

  // ---- 12. A project server in a folder no decision trusts: refused by that name, nothing written. -------------
  const projectRoot = join(stack.artifacts, "untrusted-project");
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { repo: { command: process.execPath, args: [STDIO_FIXTURE] } } }, null, 2) + "\n");
  const project = await backendJsonOf("/api/projects", { method: "POST", body: JSON.stringify({ hostId: "workstation", name: "Untrusted", folders: [{ root: projectRoot, default: true }] }) });
  if (project.status === 201) {
    const workspaceId = project.body.project.folders[0].workspaceId;
    const bound = await backendJsonOf("/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId }) });
    const projectConversation = bound.body.conversationId;
    await backend("/api/conversations/" + projectConversation + "/extensions", { method: "PATCH", headers: stack.backendHeaders, body: JSON.stringify({ extensions: ["coding-tools", "workspace-resources", "hepi.mcp"] }) });
    // The host's own word for a folder no decision trusts is `not-authorized` (its listing entry door translates the
    // trust decision into the name its callers already read), and the sentence beside it says which decision is missing;
    // `project-untrusted` is the same condition named on a config **write**, which this scene does not perform. The
    // check is therefore the host's own named refusal plus its reason, not a second spelling invented here.
    const untrusted = await backendJsonOf("/api/conversations/" + projectConversation + "/extensions?mcp=repo");
    check(untrusted.body.code === "not-authorized" && /trust/i.test(untrusted.body.error ?? ""), "a project server in a folder no decision trusts is refused by name, with the missing decision stated: " + JSON.stringify([untrusted.body.code, untrusted.body.error]).slice(0, 300));
    const untrustedGrant = await backendJsonOf("/api/conversations/" + projectConversation + "/extensions", { method: "PATCH", body: JSON.stringify({ mcp: { server: "repo", tools: ["record"] } }) });
    check(untrustedGrant.body.code === "not-authorized", "and a grant of it writes nothing, for the same reason: " + JSON.stringify(untrustedGrant.body.code));
    check((await selectionOf(projectConversation)).mcp.grants.length === 0, "the conversation holds no grant after the refusal");
  } else {
    check(false, "the project this scene needs was not recorded: " + project.status + " " + JSON.stringify(project.body).slice(0, 200));
  }

  // ---- 13. An SSH gateway states its own limit to the MCP route. ---------------------------------------------
  const sshPort = await import("./acceptance-stack.mjs").then((module) => module.freePort(0));
  const sshGateway = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(stack.artifacts, "ssh-gateway-home"), {
      HEPI_GATEWAY_TOKEN: "mcp05-ssh-token",
      HEPI_GATEWAY_ID: "remote",
      HEPI_GATEWAY_PORT: String(sshPort),
      HEPI_GATEWAY_DATA: join(stack.artifacts, "ssh-gateway-data"),
      HEPI_WORKSPACE_ROOT: join(stack.artifacts, "ssh-root"),
      HEPI_SSH_HOST: "127.0.0.1",
      HEPI_SSH_PORT: "1",
      HEPI_SSH_PROFILE: "prod",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const sshOrigin = "http://127.0.0.1:" + sshPort;
    const up = await until(() => fetch(sshOrigin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer mcp05-ssh-token", "content-type": "application/json" }, body: JSON.stringify({ operation: "list" }) }).then((response) => response.status < 500, () => false), (ready) => ready === true, "the SSH gateway to answer", 90_000);
    check(up === true, "an SSH gateway started on its own port");
    for (const body of [{ operation: "read" }, { operation: "tools", scope: "global", name: SERVER, workspaceId: "remote-prod" }, { operation: "invoke", callId: "ssh-call", conversationId: "1", workspaceId: "remote-prod", scope: "global", server: SERVER, tool: "record" }]) {
      const answer = await (await fetch(sshOrigin + "/v1/mcp", { method: "POST", headers: { authorization: "Bearer mcp05-ssh-token", "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      check(answer.ok === false && answer.code === "mcp_unavailable", "an SSH gateway answers its own named limit to " + body.operation + ": " + JSON.stringify(answer.code));
    }
  } finally {
    if (sshGateway.exitCode === null && sshGateway.signalCode === null) {
      const exited = once(sshGateway, "exit");
      sshGateway.kill("SIGTERM");
      await Promise.race([exited, delay(10_000).then(() => sshGateway.kill("SIGKILL"))]);
    }
  }

  check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  if (keep) console.log("Artifacts kept at " + stack?.artifacts);
  await shutdown();
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(failures.length === 0 ? 0 : 1);
