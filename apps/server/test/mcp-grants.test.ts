/**
 * One conversation's MCP grants, at the seam that stores them (ticket 03b).
 *
 * The backend owns a conversation's tool lifecycle, so the two facts this file pins are the two the backend is answerable
 * for: a granted tool is **offered** and a revoked one stops being offered at once, and both statements survive the
 * process that wrote them. The host's own answers — trust, exposure, whether a server still holds a name — are
 * pinned by 03a and by the adapter's call tests, and are deliberately not re-asserted here: this document is a
 * presentation snapshot, never an authority, and a test that treated it as one would be testing the wrong half of the seam.
 *
 * Three states stay three: what a deployment declares (the operator's fallback presentation, never a ceiling), what the
 * host exposes, and what this conversation was granted. Only the last one is written here, only from a person's act, and
 * never by a model: the runtime has no `tool_search` installed on this backend, which the last case reads off the registry
 * itself rather than from a comment.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import type { McpToolList } from "@hepi/protocol/gateway";
import { createMcpToolBridge, MCP_TOOL_PREFIX, mcpToolName, type McpToolDeclaration } from "../src/mcp-conversation-tools.ts";
import {
  grantEntriesOf,
  grantRequest,
  mcpConfigReadOf,
  mcpGrantKeys,
  mcpGrantOffer,
  mcpGrantSelection,
  mcpToolListOf,
  readMcpGrants,
  reconcileMcpOffer,
  writeMcpGrants,
} from "../src/mcp-grants.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const GATEWAY = "workstation";
const RECORD = mcpToolName(GATEWAY, "notes", "record");
const SLOW = mcpToolName(GATEWAY, "notes", "slow");

/** The fallback presentation one deployment declares through `HEPI_MCP_TOOLS`, which grants nothing on its own. */
const DECLARATIONS: readonly McpToolDeclaration[] = [
  { gatewayId: GATEWAY, scope: "global", server: "notes", tool: "record", description: "Return the note it was given.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { gatewayId: GATEWAY, scope: "global", server: "notes", tool: "slow", description: "Wait, then report that it waited.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
];

/**
 * The host's own listing answer for that server, with a tool the deployment declared no entry for and one the host
 * withheld its schema for — both are shapes a grant has to survive without inventing anything.
 */
const LISTING: McpToolList = {
  scope: "global",
  server: "notes",
  listedAt: 1_700_000_000_000,
  total: 4,
  truncated: false,
  pages: 1,
  durationMs: 12,
  tools: [
    { name: "record", description: "Return the note it was given.", inputSchema: { type: "object", properties: { note: { type: "string" } } } },
    { name: "slow", description: "Wait, then report that it waited.", readOnly: true, inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
    { name: "env_get", description: "The value of a variable in the server environment.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
    { name: "withheld", description: "A tool whose schema the host would not send." },
  ],
};

const directories: string[] = [];
test("the request shape a grant accepts, and the wildcard it refuses", () => {
  assert.deepEqual(grantRequest({ server: "notes", tools: ["record", "slow"] }), { server: "notes", tools: ["record", "slow"] });
  // An empty list is a sentence with a subject: it revokes that server's grants, and nothing else.
  assert.deepEqual(grantRequest({ server: "notes", tools: [] }), { server: "notes", tools: [] });
  for (const [body, code] of [
    [{}, "invalid_request"],
    // A write states its names; what a server holds is read, because reading it connects a server.
    [{ server: "notes" }, "invalid_request"],
    [{ server: "notes", tools: "record" }, "invalid_request"],
    [{ server: "notes", tools: ["*"] }, "invalid_request"],
    [{ server: "notes", tools: ["record", "record"] }, "invalid_request"],
    [{ server: "notes", tools: ["  "] }, "invalid_request"],
    [{ server: "notes", tools: ["mcp__workstation__notes__record"] }, "invalid_request"],
    [{ server: " notes ", tools: ["record"] }, undefined],
  ] as const) {
    const asked = grantRequest(body);
    assert.equal("code" in asked ? asked.code : undefined, code, JSON.stringify(body));
  }
});

test("a grant that tries to author the host's configuration is refused by name", () => {
  // Each of these is a field of the host's own `mcp.json` entry or of the invocation this process builds. Silently
  // dropping one would leave a person believing they had configured a server, so the request is refused where it is
  // written, and the reason names the key.
  for (const key of ["command", "args", "env", "url", "headers", "auth", "config", "cwd", "workspaceId", "token"] as const) {
    const asked = grantRequest({ server: "notes", tools: ["record"], [key]: "x" });
    assert.equal("code" in asked ? asked.code : undefined, "invalid_request", key);
    assert.ok("error" in asked && asked.error.includes(key), key + " is named in the refusal");
  }
});

test("the host's configuration read answers servers, and anything else answers none", () => {
  assert.equal(mcpConfigReadOf(undefined), undefined);
  assert.equal(mcpConfigReadOf({ servers: "notes" }), undefined);
  assert.equal(mcpConfigReadOf({ files: [] }), undefined, "a read answer without a server list states no servers");
  const read = mcpConfigReadOf({
    files: [{ scope: "global", path: "/home/u/.pi/agent/mcp.json", exists: true, problems: [] }],
    servers: [
      { name: "notes", scope: "global", sourcePath: "/x", enabled: true, transport: "stdio", masked: false, envNames: [], headerNames: [], usesOAuth: false, signedIn: false, oauthStateStored: false },
      { name: "hidden", scope: "project", sourcePath: "/y", enabled: false, exposure: "hidden", masked: false, envNames: [], headerNames: [], usesOAuth: false, signedIn: false, oauthStateStored: false },
      { description: "an entry with no name" },
    ],
  })!;
  assert.deepEqual(read.servers.map(server => server.name), ["notes", "hidden"], "a named entry is reported, an unnamed one is not");
  assert.equal(read.servers[1]!.enabled, false, "a switched-off entry stays stated as switched off");
});

test("a granted entry is the host's own description of the tool, and nothing else", () => {
  const { entries, missing } = grantEntriesOf(LISTING, GATEWAY, ["record", "slow", "withheld", "no_such"]);
  assert.deepEqual(missing, ["no_such"], "a name the host did not list is reported, not granted");
  assert.deepEqual(entries.map(entry => entry.tool), ["record", "slow", "withheld"]);
  const [record] = entries;
  assert.deepEqual(record, {
    gatewayId: GATEWAY,
    scope: "global",
    server: "notes",
    tool: "record",
    description: "Return the note it was given.",
    inputSchema: LISTING.tools[0]!.inputSchema,
    listedAt: LISTING.listedAt,
  }, "identity, presentation and the moment it was read — no command, no environment, no URL, no credential");
  // A host that withheld an argument shape is still a granted tool; the adapter turns that into an empty object the
  // host validates against anyway, and the entry says why.
  const withheld = entries.find(entry => entry.tool === "withheld")!;
  assert.equal(withheld.inputSchema, undefined);
  assert.equal(withheld.schemaOmitted, true);
  assert.equal(entries.find(entry => entry.tool === "slow")!.readOnly, true);
});

test("an answer that is not a listing grants nothing", () => {
  assert.equal(mcpToolListOf(undefined), undefined);
  assert.equal(mcpToolListOf({ ok: false, code: "needs-auth", message: "the server needs a sign-in" }), undefined);
  assert.equal(mcpToolListOf({ scope: "global", server: "notes", tools: [] }), undefined, "a listing without a moment is not one");
  assert.equal(mcpToolListOf({ scope: "elsewhere", server: "notes", tools: [], listedAt: 1 }), undefined);
  const partial = mcpToolListOf({ scope: "global", server: "notes", listedAt: 1, tools: [{ name: "record" }, { description: "unnamed" }] });
  assert.deepEqual(partial!.tools.map(tool => tool.name), ["record"], "the describable tools survive");
  assert.equal(partial!.truncated, true, "and the answer says it was incomplete rather than reading as the server's count");
});

test("the offer a grant set implies keeps the conversation's own filter shape and every non-MCP name in it", () => {
  const keys = mcpGrantKeys(grantEntriesOf(LISTING, GATEWAY, ["record", "slow"]).entries);
  // A null filter means "everything the conversation's extensions offer", so a grant becomes an edit beside it rather
  // than a list that silently drops every coding tool the conversation also holds.
  assert.deepEqual(mcpGrantOffer(undefined, keys), { add: keys });
  assert.deepEqual(mcpGrantOffer({ remove: ["bash"] }, keys), { remove: ["bash"], add: keys });
  // An exact array states "exactly these tools", and rewriting it as an edit would widen the offer back to every
  // non-deferred tool, so the shape is preserved and only MCP names move.
  assert.deepEqual(mcpGrantOffer(["read", RECORD], [RECORD]), ["read", RECORD]);
  assert.deepEqual(mcpGrantOffer(["read", RECORD], []), ["read"], "a revoked exact array loses only its MCP name");
  // A re-granted name leaves remove and returns to add; a name that is not an MCP identity is never touched.
  assert.deepEqual(mcpGrantOffer({ add: [RECORD], remove: [SLOW] }, [SLOW]), { add: [SLOW], remove: [RECORD] });
  // A name this set does not grant stays taken back, and a name the writer does not own stays where it was: an MCP
  // name in remove is not dropped just because nothing grants it, and a non-MCP add of another subsystem is never moved.
  assert.deepEqual(mcpGrantOffer({ add: ["skill:pdf"], remove: [RECORD] }, []), { add: ["skill:pdf"], remove: [RECORD] });
});

test("a grant is durable, is offered, and is the only thing that offers it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-mcp-grants-"));
  directories.push(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "grants.sqlite");

  const opened = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const bridge = createMcpToolBridge({
    declarations: DECLARATIONS,
    target: async () => ({ gatewayId: GATEWAY, workspaceId: "local" }),
    invoke: async () => { throw new Error("not this test's business"); },
    // The 03b composition: a selection provider is what makes every registration deferred, which is the whole reason a
    // grant can decide what a conversation is offered instead of its extensions offering everything they hold.
    selection: async conversationId => mcpGrantSelection((await readMcpGrants(opened.harness, conversationId, BACKGROUND_CONTEXT)).grants),
  });
  opened.install(bridge.extension);
  assert.deepEqual(opened.failures, [], "the extension with a selection provider installed");
  const harness = opened.harness;
  const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, extensions: [bridge.extension] } }, BACKGROUND_CONTEXT);
  const parentId = String(parent.id);
  await harness.commit(tx => tx.appendEntry(UserEntry, parent.id, { model: [{ role: "user", content: "grant me a tool", timestamp: 0 }] }), BACKGROUND_CONTEXT);

  // Registered, selected, and still offered nothing: the grant is what loads a deferred tool.
  const before = await parent.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(before.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [], "a selected extension with no grant offers no MCP tool");
  assert.deepEqual((await readMcpGrants(harness, parentId)).grants, [], "and it holds no grants");

  // One act writes both records: the grant and the offer that follows from it.
  const { entries } = grantEntriesOf(LISTING, GATEWAY, ["record"]);
  await writeMcpGrants(harness, parentId, "notes", entries, BACKGROUND_CONTEXT);
  const granted = await parent.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(granted.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [RECORD], "the granted tool is offered");
  const state = await readMcpGrants(harness, parentId);
  assert.deepEqual(state.grants.map(entry => entry.tool), ["record"]);
  assert.deepEqual(state.keys, [RECORD]);
  // The selection the adapter reads at the call is the same set, keyed by the identity a registration carries, and it
  // carries the scope too: a call is resolved from the file this conversation's own grant was read from.
  const selection = mcpGrantSelection(state.grants);
  assert.equal(selection.scopeOf({ gatewayId: GATEWAY, server: "notes", tool: "record" }), "global");
  assert.equal(selection.scopeOf({ gatewayId: "other", server: "notes", tool: "record" }), undefined, "a grant of one host authorizes no call on another");
  assert.equal(selection.scopeOf({ gatewayId: GATEWAY, server: "notes", tool: "slow" }), undefined, "an ungranted identity answers no scope");
  assert.deepEqual(selection.servers, { notes: ["record"] });

  // A second server's write leaves the first one's grant offered: the offer is reconciled against the whole set.
  await writeMcpGrants(harness, parentId, "notes", grantEntriesOf(LISTING, GATEWAY, ["record", "slow"]).entries, BACKGROUND_CONTEXT);
  const both = await parent.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(both.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [RECORD, SLOW]);

  // Revocation takes the offer away, and says it took something away.
  await writeMcpGrants(harness, parentId, "notes", [], BACKGROUND_CONTEXT);
  const revoked = await parent.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(revoked.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [], "a revoked tool is not offered on the next resolution");
  assert.deepEqual((await readMcpGrants(harness, parentId)).keys, []);

  // A branch is a new conversation: it inherits the source's agent document and none of its grants.
  await writeMcpGrants(harness, parentId, "notes", entries, BACKGROUND_CONTEXT);
  const leaf = (await parent.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]!;
  const branch = await parent.fork(leaf.id, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const branchId = String(branch.id);
  await reconcileMcpOffer(harness, branchId, (await readMcpGrants(harness, branchId)).keys, BACKGROUND_CONTEXT);
  const inherited = await branch.agent(BACKGROUND_CONTEXT);
  assert.deepEqual((await readMcpGrants(harness, branchId)).keys, [], "a branch holds no grants of its own");
  assert.deepEqual(inherited.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [], "so it is offered none of its source's tools");
  assert.deepEqual(
    inherited.tools.map(tool => tool.name).filter(name => !name.startsWith(MCP_TOOL_PREFIX)),
    (await parent.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name).filter(name => !name.startsWith(MCP_TOOL_PREFIX)),
    "and the reconciliation touched no other tool the branch inherited its offer for"
  );

  // The other conversation keeps its grants whatever a branch did.
  assert.deepEqual((await readMcpGrants(harness, parentId)).keys, [RECORD]);

  // A reopened store re-offers exactly what the durable grants state, with nothing asked of a host.
  await opened.close();
  const reopened = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  t.after(() => reopened.close());
  reopened.install(bridge.extension);
  const again = await reopened.harness.conversation(Number(parentId) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(again !== undefined, "the conversation is readable after reopen");
  const restored = await again.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(restored.tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), [RECORD], "a restart re-offers the grant, from the store alone");
  assert.deepEqual((await readMcpGrants(reopened.harness, parentId)).grants.map(entry => entry.listedAt), [LISTING.listedAt], "and the descriptor is the snapshot the grant was made from");

  // Nothing on this backend lets a model reach a deferred tool it was not granted: there is no self-discovery surface
  // installed, so the only route to `modelTools` is the grant writer and the adopt on attach.
  assert.deepEqual(reopened.registry.snapshot().installed().map(extension => extension.name).filter(name => name.includes("tool-search") || name.includes("tool_search")), [], "no tool_search extension is installed");
});

test("an adoption writes nothing when a conversation's offer already states its grants", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-mcp-adopt-"));
  directories.push(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const opened = await openServerHarness(join(directory, "adopt.sqlite"), SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  t.after(() => opened.close());
  const bridge = createMcpToolBridge({
    declarations: DECLARATIONS,
    target: async () => ({ gatewayId: GATEWAY, workspaceId: "local" }),
    invoke: async () => { throw new Error("not this test's business"); },
    // The 03b composition: a selection provider is what makes every registration deferred, which is the whole reason a
    // grant can decide what a conversation is offered instead of its extensions offering everything they hold.
    selection: async conversationId => mcpGrantSelection((await readMcpGrants(opened.harness, conversationId, BACKGROUND_CONTEXT)).grants),
  });
  opened.install(bridge.extension);
  const conversation = await opened.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, extensions: [bridge.extension] } }, BACKGROUND_CONTEXT);
  const id = String(conversation.id);
  await opened.harness.commit(tx => tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "hold a grant", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  assert.equal(await reconcileMcpOffer(opened.harness, id, [], BACKGROUND_CONTEXT), false, "a conversation with no grants and no MCP names writes nothing");
  await writeMcpGrants(opened.harness, id, "notes", grantEntriesOf(LISTING, GATEWAY, ["record"]).entries, BACKGROUND_CONTEXT);
  assert.equal(await reconcileMcpOffer(opened.harness, id, mcpGrantKeys((await readMcpGrants(opened.harness, id)).grants), BACKGROUND_CONTEXT), false, "and an offer that already states its grant writes nothing again");
  // A grant revoked behind the offer's back — an older process, a hand-written state — is taken away by the adoption.
  await opened.harness.commit(async tx => { (await tx.doc(AgentDoc, Number(id) as ConversationId)).modelTools = { add: [RECORD] } as never; }, BACKGROUND_CONTEXT);
  assert.equal(await reconcileMcpOffer(opened.harness, id, [], BACKGROUND_CONTEXT), true, "the adoption notices the name no grant states");
  assert.deepEqual((await conversation.agent(BACKGROUND_CONTEXT)).tools.map(tool => tool.name).filter(name => name.startsWith(MCP_TOOL_PREFIX)), []);
});
