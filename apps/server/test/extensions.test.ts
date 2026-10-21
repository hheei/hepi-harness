import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createWorkspaceResources, type WorkspaceResources } from "../src/workspace-resources.ts";
import { reportedSelection } from "../src/extension-selection.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const TOKEN = "extensions-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const installedNames = ["coding-tools", "workspace-resources"];
// The optional subagent extension is installed — its anchor task definition has to resolve for every task — but it is
// never part of the default selection, so ordinary chat is unchanged until a deployment turns delegation on.
const allInstalledNames = [...installedNames, "hepi-subagents"];

type Inventory = { installed: { name: string; tools: string[]; sections: string[]; enabled: boolean }[]; default: string[]; failures: { name: string; message: string }[] };
type Fixture = { origin: string; backend: BackendServer; dbPath: string; faux: ReturnType<typeof fauxProvider>; reported: string[]; close(): Promise<void> };

/**
 * A backend over a real SQLite store, a real local execution host and a controlled faux model. The execution host is
 * what makes `coding-tools` a conversation's real offered tools, so "a disabled extension is absent from the tools a
 * conversation is offered" is observable rather than asserted about a list this process built for itself.
 */
async function start(t: { after(fn: () => unknown): void }, dbPath: string, resources?: WorkspaceResources): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // The execution host's own account: a workspace root that exists, because the gateway canonicalizes it on the host.
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  const workspace = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: workspace, allowedCommands: ["bash"] }), undefined, new GatewayFiles(workspace));
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const reported: string[] = [];
  // The deployment always installs the execution-side resource extension (main.ts does), so the fixture does too: the
  // installed set under test is the one a real backend has, not a subset that happens to make an assertion easier.
  const backend = await createBackendServer({ dbPath, authToken: TOKEN, models, workspaces: [binding], workspaceResources: resources ?? createWorkspaceResources({ diagnostics: () => {} }), diagnostics: message => reported.push(message), defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress && typeof serverAddress === "object");
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); });
  return {
    origin: "http://127.0.0.1:" + serverAddress.port,
    backend,
    dbPath,
    faux,
    reported,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); await gateway.close(); },
  };
}

const inventory = async (origin: string): Promise<Inventory> => {
  const response = await fetch(origin + "/api/extensions", { headers });
  assert.equal(response.status, 200);
  return await response.json() as Inventory;
};

const setDefault = (origin: string, extensions: unknown) => fetch(origin + "/api/extensions", { method: "POST", headers, body: JSON.stringify({ extensions }) });
const createConversation = async (origin: string, workspaceId?: string): Promise<string> => {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
};
const state = async (origin: string, id: string): Promise<{ extensions: string[]; toolNames: string[]; entries: { role: string; text: string; message: { isError?: boolean } }[] }> => {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as never;
};
const override = (origin: string, id: string, extensions: unknown) => fetch(origin + "/api/conversations/" + id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions }) });

/** One settled turn, read back from the durable state rather than waited on by a timer. */
async function runTurn(fixture: Fixture, id: string, requestId: string, expected: string): Promise<{ toolNames: string[]; entries: { role: string; text: string; message: { isError?: boolean } }[] }> {
  const response = await fetch(fixture.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "use a tool" }) });
  assert.equal(response.status, 202, await response.text());
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await state(fixture.origin, id);
    if (current.entries.some(entry => entry.role === "assistant" && entry.text === expected)) return current;
  }
  throw new Error("run did not settle");
}

test("the installed extensions come from the runtime's registry, with their own tools and sections", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-store-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await start(t, join(base, "hepi.sqlite"));
  const listed = await inventory(fixture.origin);
  // The registry is the authority: the names are the ones the backend installed, and the tools are those extensions'
  // own tools, so no second list can drift from what a conversation is really offered.
  assert.deepEqual(listed.installed.map(extension => extension.name).sort(), [...allInstalledNames].sort());
  assert.deepEqual(listed.installed.find(extension => extension.name === "coding-tools")?.tools.slice().sort(), ["bash", "edit", "read", "write"]);
  assert.deepEqual(listed.installed.find(extension => extension.name === "workspace-resources")?.sections, ["resources"]);
  // The default was never changed, so every installed extension is selected, and nothing failed to install.
  assert.deepEqual(listed.default, installedNames);
  assert.deepEqual(listed.failures, []);
  // The default is what a new conversation selects, and the optional extension is not in it.
  assert.ok(listed.installed.filter(extension => installedNames.includes(extension.name)).every(extension => extension.enabled));
  assert.equal(listed.installed.find(extension => extension.name === "hepi-subagents")?.enabled, false);
});

test("the global default is hepi state: it survives a restart, applies to a new conversation, and never rewrites an existing one", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-default-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  const fixture = await start(t, dbPath);

  const before = await createConversation(fixture.origin, "local");
  assert.deepEqual((await state(fixture.origin, before)).extensions, installedNames);
  assert.deepEqual((await state(fixture.origin, before)).toolNames.slice().sort(), ["bash", "edit", "read", "write"]);

  const written = await setDefault(fixture.origin, ["workspace-resources"]);
  assert.equal(written.status, 200);
  assert.deepEqual((await written.json() as Inventory).default, ["workspace-resources"]);

  const after = await createConversation(fixture.origin, "local");
  assert.deepEqual((await state(fixture.origin, after)).extensions, ["workspace-resources"]);
  // The conversation created after the change is offered the tools of the selection it materialized, and nothing else.
  assert.deepEqual((await state(fixture.origin, after)).toolNames, []);

  // The conversation that already existed keeps the selection it was created with, including its offered tools.
  assert.deepEqual((await state(fixture.origin, before)).extensions, installedNames);
  assert.deepEqual((await state(fixture.origin, before)).toolNames.slice().sort(), ["bash", "edit", "read", "write"]);

  await fixture.close();
  const restarted = await start(t, dbPath);
  assert.deepEqual((await inventory(restarted.origin)).default, ["workspace-resources"]);
  // The stored default is durable state, so the conversation created before the restart still holds its own selection.
  assert.deepEqual((await state(restarted.origin, before)).extensions, installedNames);
  assert.deepEqual((await state(restarted.origin, after)).extensions, ["workspace-resources"]);
});

test("an extension the conversation does not select is absent from the tools it is offered, and its call is refused", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-tools-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await start(t, join(base, "hepi.sqlite"));
  const enabled = await createConversation(fixture.origin, "local");
  assert.equal((await setDefault(fixture.origin, ["workspace-resources"])).status, 200);
  const disabled = await createConversation(fixture.origin, "local");

  // The same request against both conversations: the one that selects the extension runs the tool, the one that does
  // not is refused by the runtime because the tool is not among the tools it is offered.
  fixture.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf enabled" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("enabled turn done"),
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf disabled" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("disabled turn done"),
  ]);
  const ran = await runTurn(fixture, enabled, "tools-enabled", "enabled turn done");
  assert.notEqual(ran.entries.filter(entry => entry.role === "toolResult").at(0)?.message.isError, true);
  const refused = await runTurn(fixture, disabled, "tools-disabled", "disabled turn done");
  const refusedResult = refused.entries.filter(entry => entry.role === "toolResult").at(0);
  assert.equal(refusedResult?.message.isError, true, refusedResult?.text);
  assert.match(refusedResult?.text ?? "", /not available/);
});

test("a per-conversation override writes that conversation's own selection and survives a reload", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-override-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await start(t, join(base, "hepi.sqlite"));
  const id = await createConversation(fixture.origin, "local");
  const other = await createConversation(fixture.origin, "local");

  const answer = await override(fixture.origin, id, ["workspace-resources"]);
  assert.equal(answer.status, 200);
  // One seam answers the whole selection it wrote: the extensions, the tools they offer, and — with nothing granted and
  // no declaration to offer — an empty MCP state beside them.
  const written = await answer.json() as { protocol: string; conversationId: string; extensions: string[]; toolNames: string[]; mcp: { selected: boolean; grants: unknown[]; offered: unknown[] } };
  assert.deepEqual({ protocol: written.protocol, conversationId: written.conversationId, extensions: written.extensions, toolNames: written.toolNames }, { protocol: "hepi.v1", conversationId: id, extensions: ["workspace-resources"], toolNames: [] });
  assert.equal(written.mcp.selected, false, "and this conversation selected no MCP extension");
  assert.deepEqual(written.mcp.grants, []);
  assert.deepEqual(written.mcp.offered, []);
  // The override is that conversation's own stored state, so a later read of the same conversation states it and the
  // conversation that never overrode anything is untouched.
  assert.deepEqual((await state(fixture.origin, id)).extensions, ["workspace-resources"]);
  assert.deepEqual((await state(fixture.origin, other)).extensions, installedNames);
  // And it is not the global default: a conversation created afterwards still selects the default.
  assert.deepEqual((await state(fixture.origin, await createConversation(fixture.origin, "local"))).extensions, installedNames);
  // Turning it back on is the same write in the other direction.
  assert.equal((await override(fixture.origin, id, installedNames)).status, 200);
  assert.deepEqual((await state(fixture.origin, id)).extensions, installedNames);
});

test("a selection naming an extension the backend does not have is refused with the reason", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-refusal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await start(t, join(base, "hepi.sqlite"));
  const id = await createConversation(fixture.origin, "local");

  const unknownGlobal = await setDefault(fixture.origin, ["no-such-extension"]);
  assert.equal(unknownGlobal.status, 400);
  assert.equal((await unknownGlobal.json() as { code: string }).code, "unknown_extension");
  // A refused write changes nothing: the default is still what it was.
  assert.deepEqual((await inventory(fixture.origin)).default, installedNames);

  const unknownConversation = await override(fixture.origin, id, ["no-such-extension"]);
  assert.equal(unknownConversation.status, 400);
  assert.equal((await unknownConversation.json() as { code: string }).code, "unknown_extension");
  assert.deepEqual((await state(fixture.origin, id)).extensions, installedNames);

  const malformed = await setDefault(fixture.origin, "coding-tools");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json() as { code: string }).code, "invalid_request");

  // A conversation with no execution workspace has nothing for the coding tools to run in, so it cannot select them.
  const unbound = await createConversation(fixture.origin);
  assert.deepEqual((await state(fixture.origin, unbound)).extensions, ["workspace-resources"]);
  const unavailable = await override(fixture.origin, unbound, installedNames);
  assert.equal(unavailable.status, 409);
  const refusal = await unavailable.json() as { code: string; error: string };
  assert.equal(refusal.code, "unavailable_extension");
  assert.match(refusal.error, /execution workspace/);
  assert.deepEqual((await state(fixture.origin, unbound)).extensions, ["workspace-resources"]);
});

test("an extension that fails to install is reported at startup and listed as a failure instead of silently absent", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-failure-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // An extension the runtime's own validation refuses: two tools with one name. The backend must still start, and the
  // failure must be visible — an extension that silently vanished would be reported as "not installed" with no reason.
  const duplicate = CodingTools.tools![0]!;
  const broken = defineExtension({ name: "broken-extension", tools: [duplicate, duplicate] }) as Extension;
  const resources = { extension: broken, discover: async () => { throw new Error("unused"); }, commands: () => [], expand: async (_state: unknown, _env: unknown, text: string) => text } as unknown as WorkspaceResources;
  const fixture = await start(t, join(base, "hepi.sqlite"), resources);

  const listed = await inventory(fixture.origin);
  assert.deepEqual(listed.installed.map(extension => extension.name).sort(), ["coding-tools", "hepi-subagents"]);
  assert.equal(listed.failures.length, 1);
  assert.equal(listed.failures[0]?.name, "broken-extension");
  assert.match(listed.failures[0]?.message ?? "", /two tools named read/);
  assert.deepEqual(listed.default, ["coding-tools"]);
  // The startup report names the extension and its reason, so an operator reading the log knows which one is broken.
  assert.equal(fixture.reported.length, 1);
  assert.match(fixture.reported[0]!, /broken-extension/);
  assert.match(fixture.reported[0]!, /two tools named read/);
  // The rest of the backend works: a conversation is created and offered the tools of the extensions that did install.
  const id = await createConversation(fixture.origin, "local");
  assert.deepEqual((await state(fixture.origin, id)).extensions, ["coding-tools"]);
});

test("the runtime's harness-wide default is never set, so it cannot move a conversation that never chose", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-settings-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  // A conversation recorded with no stored selection, written before the backend opens the store.
  const harness = await import("../src/harness.ts");
  const { SERVER_MODEL, fauxModels } = await import("./faux-fixture.ts");
  const writer = await harness.openServerHarness(dbPath, SERVER_MODEL, fauxModels(), (async () => undefined) as never, { startPaused: true });
  const bare = await writer.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const bareId = String(bare.id);
  assert.deepEqual((await bare.agent(BACKGROUND_CONTEXT)).extensions.map(extension => extension.name), ["coding-tools"]);
  await writer.close();

  const fixture = await start(t, dbPath);
  // Changing the hepi default writes only this backend's own document. The harness-wide layer the runtime reads for a
  // conversation with no stored selection is untouched, so that conversation still follows the whole installed registry —
  // including the optional extension, which is installed but not in the hepi default. Relying on that layer as the
  // default is exactly what would have moved it.
  assert.deepEqual((await state(fixture.origin, bareId)).extensions.sort(), [...allInstalledNames].sort());
  await setDefault(fixture.origin, ["workspace-resources"]);
  assert.deepEqual((await state(fixture.origin, bareId)).extensions.sort(), [...allInstalledNames].sort(), "a conversation with no stored selection is not moved by the hepi default");
  // A conversation this backend creates does carry an explicit selection, which is what makes the default apply to new
  // conversations only and never to a stored choice.
  const created = await createConversation(fixture.origin, "local");
  assert.deepEqual((await state(fixture.origin, created)).extensions, ["workspace-resources"]);
});

test("the global default can turn delegation on for a new conversation, and never for one bound to no workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-extensions-optin-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await start(t, join(base, "hepi.sqlite"));

  // The stored default is validated against every installed extension, so an explicit opt-in names the optional one
  // and is stored as written instead of being silently dropped by a fallback set that omits it.
  const written = await setDefault(fixture.origin, ["coding-tools", "hepi-subagents"]);
  assert.equal(written.status, 200);
  assert.deepEqual((await written.json() as Inventory).default, ["coding-tools", "hepi-subagents"]);

  // A conversation created under that default is really offered the delegation tool: the answer is the runtime's own
  // resolution of the stored selection, not a list this process built.
  const opted = await createConversation(fixture.origin, "local");
  const optedState = await state(fixture.origin, opted);
  assert.deepEqual(optedState.extensions.sort(), ["coding-tools", "hepi-subagents"]);
  assert.equal(optedState.toolNames.includes("agent_spawn"), true, JSON.stringify(optedState.toolNames));

  // A conversation bound to no execution workspace can run neither a coding tool nor a child, so both names the
  // default selects are withheld from it outright: the opt-in reaches a workspace-bound conversation only.
  const unbound = await createConversation(fixture.origin);
  const unboundState = await state(fixture.origin, unbound);
  assert.deepEqual(unboundState.extensions, []);
  assert.equal(unboundState.toolNames.includes("agent_spawn"), false, JSON.stringify(unboundState.toolNames));

  // Turning it back off is the same write in the other direction, and the next conversation is ordinary again.
  assert.equal((await setDefault(fixture.origin, ["coding-tools", "workspace-resources"])).status, 200);
  const ordinary = await createConversation(fixture.origin, "local");
  assert.equal((await state(fixture.origin, ordinary)).toolNames.includes("agent_spawn"), false);
  // The conversation created while it was on keeps the selection it was created with.
  assert.equal((await state(fixture.origin, opted)).toolNames.includes("agent_spawn"), true);
});

test("a report of what a conversation is offered applies its enabled-tool filter before its model filter", () => {
  // The runtime resolves an agent as `filterTools(enabled, state.tools)` and then `offeredTools(modelCallable,
  // state.modelTools)`, so a report that skipped the first step would name tools a request can never offer. A child
  // delegated from an agent definition carries exactly such an enabled list.
  const installed = [
    { name: "coding-tools", tools: ["read", "write", "edit", "bash"] },
    { name: "hepi.mcp", tools: ["mcp__workstation__notes__record", "mcp__workstation__notes__slow"], deferred: ["mcp__workstation__notes__record", "mcp__workstation__notes__slow"] },
  ];
  const extensions = ["coding-tools", "hepi.mcp"];
  // An unset enabled filter offers everything the extensions hold, minus the deferred names nothing grants.
  assert.deepEqual(reportedSelection(installed, extensions, undefined, undefined).tools, ["read", "write", "edit", "bash"]);
  // An exact enabled list is the whole offer inside those extensions, and a grant loads a deferred name **inside** it.
  const restricted = ["read", "mcp__workstation__notes__record"];
  assert.deepEqual(reportedSelection(installed, extensions, { add: ["mcp__workstation__notes__record"] }, restricted).tools, ["read", "mcp__workstation__notes__record"]);
  // A name the enabled list leaves out is not offered, and a grant naming it does not put it back: the runtime filters
  // the enabled set first, so reporting otherwise would state a tool the conversation cannot run.
  assert.deepEqual(reportedSelection(installed, extensions, { add: ["mcp__workstation__notes__slow"] }, ["read"]).tools, ["read"]);
  // An enabled name no selected extension holds is dropped, the way the runtime drops it.
  assert.deepEqual(reportedSelection(installed, ["coding-tools"], undefined, ["read", "mcp__workstation__notes__record"]).tools, ["read"]);
});
