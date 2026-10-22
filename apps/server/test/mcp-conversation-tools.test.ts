/**
 * Ticket 02's durable conversation adapter for Gateway MCP tools, at the two seams it is written against.
 *
 * The **native lifecycle** is the backend's own HTTP surface, a controlled model that makes the tool call, and the
 * runtime's real SQLite store. The **host contract** is a gateway serving the MCP host service over its own
 * `POST /v1/mcp` with the controlled stdio fixture, so nothing here reaches a network, a real provider or a paid call,
 * and every wait is for an answer or for a file the fixture wrote — never a delay taken as evidence. The one window no
 * in-process test can produce, a backend that dies inside a call, is a real SIGKILL of a real process over the same
 * store, reopened by a second build.
 *
 * What the suite holds the adapter to:
 *
 * - A selected tool's call runs on the bound gateway and its result is committed through the ordinary durable tool
 *   lifecycle, with the host's own facts as the entry's details.
 * - A conversation that never selected the MCP extension is offered nothing and reaches no server: the runtime settles
 *   the call `tool_unavailable`, and the fixture's own pid file proves nothing was started.
 * - The host's refusals are recorded as they arrived; every uncertain end keeps the claim that the server may have
 *   acted; and a restart settles an interrupted call without running it a second time.
 * - No MCP credential crosses into the backend in either direction.
 * - The adapter's own bounds — naming, collisions, counts, argument shapes, result size — are stated, not assumed.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, McpHostService, MemoryLedger, WorkspaceRegistry, agentDirOf } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { SECRET_MASK } from "@hepi/protocol/mcp-secrets";
import type { McpScope, McpToolCallRequest, McpToolCallResult } from "@hepi/protocol/gateway";
import { createBackendServer, type ServerSnapshot } from "../src/server.ts";
import {
  MCP_EXTENSION,
  MCP_FALLBACK_DESCRIPTION,
  MCP_MAX_TOOLS,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  createMcpToolBridge,
  mcpSettle,
  mcpToolName,
  mcpUsableTools,
  type McpCallTarget,
  type McpGrantedTool,
  type McpToolDeclaration,
} from "../src/mcp-conversation-tools.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const STDIO_FIXTURE = fileURLToPath(new URL("../../../packages/gateway/test/fixtures/mcp/stdio-server.ts", import.meta.url));
const GATEWAY_TOKEN = "gateway-token";
const BACKEND_TOKEN = "server-token";
const HEADERS = { authorization: "Bearer " + BACKEND_TOKEN, "content-type": "application/json" };
/** The literal secret the fixture server is started with, and which its own `env_get` tool echoes back. */
const SECRET = "durable-adapter-literal-secret-value";

/** The names three declared tools of the `workstation` host are offered under. */
const RECORD = mcpToolName("workstation", "notes", "record");
const ENV_GET = mcpToolName("workstation", "notes", "env_get");
const SLOW = mcpToolName("workstation", "notes", "slow");

type Entry = ServerSnapshot["entries"][number];
type ToolResultEntry = Entry & { message: { toolName?: string; isError?: boolean; details?: Record<string, unknown>; diagnostics?: { code?: string; message?: string }[] } };

/** The conversation's committed tool results, oldest first. */
function resultsOf(entries: readonly Entry[]): ToolResultEntry[] {
  return entries.filter((entry): entry is ToolResultEntry => entry.role === "toolResult");
}
/** The tool one result answers for. */
const toolNameOf = (entry: ToolResultEntry): string => entry.message.toolName ?? "";
/**
 * The codes one settled entry reports. The runtime stores a failed call's diagnostics on the entry and renders them into
 * the text a model reads, so a refusal is recognized by the code it names in that text — which is the only place the
 * adapter's own codes appear, and what a projection of this conversation can be checked against.
 */
function codesOf(entry: ToolResultEntry): string[] {
  const stored = (entry.message.diagnostics ?? []).map(item => item.code ?? "");
  if (stored.length > 0) return stored;
  const codes = [...entry.text.matchAll(/\[(?:error|warn)\] ([a-z_][a-z0-9_]*)/g)].map(match => match[1]!);
  // The framework's own settlements carry no adapter code, only their fixed wording: a tool no selected extension
  // offers, and a call recovery refused to repeat. Both are named here because both are this seam's boundary.
  if (codes.length === 0) for (const [wording, code] of FRAMEWORK_WORDINGS) if (wording.test(entry.text)) codes.push(code);
  return codes;
}

/** The runtime's fixed refusal wordings, and the boundary each one names. */
const FRAMEWORK_WORDINGS: readonly [RegExp, string][] = [
  [/Tool .+ is not available/, "tool_unavailable"],
  [/Tool .+ was aborted/, "aborted"],
  [/may have partially run/, "interrupted"],
];

const recordDeclaration: McpToolDeclaration = { gatewayId: "workstation", scope: "global", server: "notes", tool: "record", description: "Return the note it was given.", inputSchema: { type: "object", properties: { note: { type: "string" } } } };
const slowDeclaration: McpToolDeclaration = { gatewayId: "workstation", scope: "global", server: "notes", tool: "slow", description: "Wait, then report that it waited.", inputSchema: { type: "object", properties: { ms: { type: "number" } } } };

// ---------------------------------------------------------------------------
// The adapter's own rules, with no host in sight
// ---------------------------------------------------------------------------

test("a native name is the host, the server and the tool, in the alphabet a provider accepts", () => {
  assert.equal(RECORD, "mcp__workstation__notes__record");
  // A path or a spaced name does not become a different tool: `web.search` and `web search` are the same one server,
  // so the segment is replaced rather than refused, and nothing outside the alphabet can reach a request.
  assert.equal(mcpToolName("web host", "a.b/c", "search now"), "mcp__web_host__a_b_c__search_now");
  // Two hosts with one server name are two tools, which is what a per-host declaration has to mean.
  assert.notEqual(mcpToolName("a", "s", "t"), mcpToolName("b", "s", "t"));
  assert.equal(mcpToolName("workstation", "s".repeat(90), "record").length, MCP_TOOL_NAME_MAX);
});

test("an installed offer refuses a collision by name rather than offering two tools under one", () => {
  const { usable, refused } = mcpUsableTools([
    { gatewayId: "a.b", scope: "global", server: "x", tool: "y" },
    { gatewayId: "a_b", scope: "global", server: "x", tool: "y" },
  ]);
  assert.deepEqual(usable, []);
  assert.equal(refused.length, 2);
  assert.match(refused[0]!.reason, /collides with a_b\/x\/y/);
  assert.match(refused[1]!.reason, /collides with a\.b\/x\/y/);
});

test("a schema this process cannot carry is refused, and a tool with nothing stated is still described", () => {
  const refusalCases: readonly [unknown, RegExp][] = [
    [{ type: "array" }, /of type array/],
    [null, /not an object/],
    [[], /not an object/],
    [{ type: "object", properties: { blob: { type: "string", default: "x".repeat(70_000) } } }, /larger than the 65536 bytes one call may carry/],
  ];
  for (const [schema, expected] of refusalCases) {
    const { usable, refused } = mcpUsableTools([{ gatewayId: "g", scope: "global", server: "s", tool: "t", description: "d", inputSchema: schema }]);
    assert.equal(usable.length, 0, JSON.stringify(schema) + " is not an offer");
    assert.match(refused[0]!.reason, expected);
  }
  // What does install: an absent schema is an empty argument object, and an empty description is still a description.
  const bare = mcpUsableTools([{ gatewayId: "g", scope: "global", server: "s", tool: "t" }]);
  assert.equal(bare.usable.length, 1);
  assert.equal(bare.usable[0]!.description, MCP_FALLBACK_DESCRIPTION);
  assert.deepEqual((bare.usable[0]!.parameters as { properties?: unknown }).properties, {});
  // The server's own schema travels verbatim, so the runtime validates the model's arguments before anything is sent.
  const carried = mcpUsableTools([{ gatewayId: "g", scope: "global", server: "s", tool: "t", description: "d", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }]);
  assert.deepEqual((carried.usable[0]!.parameters as { required?: unknown }).required, ["note"]);
});

test("the offer is bounded per server and per backend, and every dropped tool names itself", () => {
  const overServer = mcpUsableTools(Array.from({ length: MCP_MAX_TOOLS_PER_SERVER + 2 }, (_unused, index) => ({ gatewayId: "g", scope: "global" as const, server: "s", tool: "tool" + index })));
  assert.equal(overServer.usable.length, MCP_MAX_TOOLS_PER_SERVER);
  assert.equal(overServer.refused.length, 2);
  assert.match(overServer.refused[0]!.reason, /more than 128 tools/);

  const servers = Math.ceil((MCP_MAX_TOOLS + 4) / MCP_MAX_TOOLS_PER_SERVER);
  const overBackend = mcpUsableTools(Array.from({ length: servers * MCP_MAX_TOOLS_PER_SERVER }, (_unused, index) => ({ gatewayId: "g", scope: "global" as const, server: "s" + Math.floor(index / MCP_MAX_TOOLS_PER_SERVER), tool: "tool" + index })));
  assert.equal(overBackend.usable.length, MCP_MAX_TOOLS);
  assert.match(overBackend.refused[0]!.reason, /no more than 256 MCP tools/);
});

/** A bridge over a captured request list, with nothing real behind it: the invoke contract is the seam under test. */
function capturingBridge(options: {
  readonly declarations?: readonly McpToolDeclaration[];
  readonly sent: McpToolCallRequest[];
  readonly selection?: (conversationId: string) => { readonly servers: Readonly<Record<string, readonly string[]>>; readonly scopeOf: (identity: { gatewayId: string; server: string; tool: string }) => McpScope | undefined };
  readonly reported?: string[];
}) {
  return createMcpToolBridge({
    declarations: options.declarations ?? [],
    target: async () => ({ gatewayId: "workstation", workspaceId: "local" }),
    invoke: async (gatewayId, request) => {
      options.sent.push(request);
      return { ok: true, value: { callId: request.callId, server: request.server, tool: request.tool, content: [{ type: "text", text: "done" }], isError: false, truncated: false, durationMs: 1 } } as McpToolCallResult;
    },
    ...(options.selection === undefined ? {} : { selection: async (conversationId: string) => options.selection!(conversationId) }),
    diagnostics: options.reported === undefined ? () => {} : (message) => options.reported!.push(message),
  });
}

const grantedRecord = (over: Partial<McpGrantedTool> = {}): McpGrantedTool => ({
  gatewayId: "workstation",
  scope: "global",
  server: "notes",
  tool: "record",
  description: "Return the note it was given.",
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
  listedAt: 1,
  ...over,
});

test("a call is sent in the scope its own conversation granted, whichever descriptor built the registration", async () => {
  // One name is one registration process-wide, and a global and a project entry of one identity carry the same name.
  // The registration therefore cannot answer which entry a call belongs in; the calling conversation's own grant can.
  const sent: McpToolCallRequest[] = [];
  const grantedTo = (scope: McpScope) => ({ servers: { notes: ["record"] }, scopeOf: (identity: { gatewayId: string; server: string; tool: string }) => (identity.tool === "record" ? scope : undefined) });
  const bridge = capturingBridge({ declarations: [recordDeclaration], sent, selection: (conversationId) => grantedTo(conversationId === "2" ? "project" : "global") });
  // The live descriptor is the project entry's, published later: the registration a global call resolves against is
  // built from a project grant, which is exactly the shape of the leak this must not produce.
  bridge.stage([grantedRecord({ scope: "project", listedAt: 5 })]);

  const tool = bridge.extension.tools!.find(registration => registration.name === RECORD)!;
  await tool.execute({ note: "global note" }, apiOf("call-global", "1"), NO_CONTEXT);
  await tool.execute({ note: "project note" }, apiOf("call-project", "2"), NO_CONTEXT);
  assert.deepEqual(sent.map(request => [request.conversationId, request.scope]), [["1", "global"], ["2", "project"]], "each call is resolved in the entry its own conversation was granted from");

  // A re-grant of one conversation's identity changes the live descriptor, and must not move the other's scope with it.
  bridge.stage([grantedRecord({ scope: "project", description: "A changed project description.", listedAt: 9 })]);
  await tool.execute({ note: "global note" }, apiOf("call-global-again", "1"), NO_CONTEXT);
  assert.equal(sent.at(-1)!.scope, "global", "a changed project descriptor sends a global grant as global");
});

test("the descriptor this process offers is the newest the host published, and a call without a grant provider states the scope it was built from", () => {
  const a1 = grantedRecord({ description: "a", inputSchema: { type: "object", properties: { a: { type: "string" } } }, listedAt: 1 });
  const a3 = grantedRecord({ description: "a", inputSchema: { type: "object", properties: { a: { type: "string" } } }, listedAt: 3 });
  const b2 = grantedRecord({ description: "b", inputSchema: { type: "object", properties: { b: { type: "string" } } }, listedAt: 2 });
  const offered = (bridge: ReturnType<typeof capturingBridge>) => bridge.extension.tools!.find(registration => registration.name === RECORD)!;

  const bridge = capturingBridge({ sent: [] });
  bridge.stage([a1]);
  // An identical reading of the same identity carries no new presentation, and the registrations need no rebuild — but
  // the moment is newer evidence, and a later stage of an older reading must not win against it.
  bridge.stage([a3]);
  bridge.stage([b2]);
  assert.match(offered(bridge).description, /^a /, "the descriptor of the newest read stands against a later-staged older one");

  const newer = capturingBridge({ sent: [] });
  newer.stage([a3]);
  newer.stage([{ ...b2, listedAt: 4 }]);
  assert.match(offered(newer).description, /^b /, "and a newer reading replaces it");

  // Two entries of one identity in different scopes are two servers: the scope is part of what a registration is built
  // from, so a scope change replaces it. This is the only composition with no grant to ask at the call, so the request
  // states the scope the registration was built from.
  const sent: McpToolCallRequest[] = [];
  const scoped = capturingBridge({ sent });
  scoped.stage([grantedRecord({ scope: "global", listedAt: 1 })]);
  scoped.stage([grantedRecord({ scope: "project", listedAt: 2 })]);
  const registration = offered(scoped);
  return (async () => {
    await registration.execute({ note: "x" }, apiOf("call-1", "1"), NO_CONTEXT);
    assert.equal(sent[0]!.scope, "project", "a scope change on one identity replaces the registration it was built from");
  })();
});

test("a granted tool is registered ahead of the operator's fallback, and an offer that cannot be built is refused before anything is written", () => {
  // A deployment whose fallback fills one server's whole bound must not take the room a person's grant needs: the
  // grant wins the capacity, and the fallback it pushed out is the one named as refused.
  const fallback = Array.from({ length: MCP_MAX_TOOLS_PER_SERVER }, (_unused, index) => ({
    gatewayId: "workstation",
    scope: "global" as const,
    server: "notes",
    tool: "filler" + index,
  }));
  const reported: string[] = [];
  const bridge = capturingBridge({ declarations: fallback, sent: [], reported });
  const grant = grantedRecord();
  assert.deepEqual(bridge.admits([grant]), { ok: true }, "a grant is admitted when the fallback, not the grant, is what overflows");
  bridge.stage([grant]);
  assert.ok(bridge.extension.tools!.some(registration => registration.name === RECORD), "the granted tool is registered");
  assert.equal(bridge.refused().some(refused => refused.tool === "record"), false, "and is not among the refusals");
  assert.ok(bridge.refused().length === 1 && /filler127/.test(bridge.refused()[0]!.tool), "the fallback entry past the bound is the one refused, by name");

  // A grant this process cannot register is named, before any document is written: the route answers the refusal and
  // the conversation's durable grants stay as they were.
  const full = capturingBridge({ sent: [] });
  full.stage(Array.from({ length: MCP_MAX_TOOLS_PER_SERVER }, (_unused, index) => grantedRecord({ tool: "held" + index, listedAt: index + 1 })));
  assert.deepEqual(full.admits([grantedRecord({ tool: "held0", listedAt: 0 })]), { ok: true }, "a re-grant of a held identity takes no new room");
  const overflow = full.admits([grantedRecord({ tool: "one-more" })]);
  assert.equal(overflow.ok, false, "a server whose grants pass the bound is refused");
  assert.match((overflow as { reason: string }).reason, /more than 128 tools/);
});

test("a tool whose conversation reaches no matching host is refused there, with the claim that nothing was sent", async () => {
  // Two ways a call has no host to run on, and one answer: the conversation bound to nothing, and the conversation on a
  // gateway this tool does not belong to. Either way no request leaves, so a reaching host would throw.
  const cases: readonly [readonly McpToolDeclaration[], McpCallTarget | undefined, RegExp][] = [
    [[recordDeclaration], undefined, /nothing was sent/],
    [[{ gatewayId: "other", scope: "global", server: "notes", tool: "record" }], { gatewayId: "workstation", workspaceId: "local" }, /no execution host named other/],
  ];
  for (const [declarations, target, expected] of cases) {
    const bridge = createMcpToolBridge({
      declarations,
      target: async () => target,
      invoke: async () => { throw new Error("a host this call cannot reach must receive no request"); },
      diagnostics: () => {},
    });
    const result = await bridge.extension.tools![0]!.execute({ note: "x" }, apiOf("call-1", "7"), NO_CONTEXT);
    assert.equal(result.isError, true);
    assert.equal(result.diagnostics![0]!.code, "host_unavailable");
    assert.match(result.diagnostics![0]!.message, expected);
  }
});

test("one call's answer settles on the runtime's own channels, and every refusal keeps its own claim", () => {
  const tool = { gatewayId: "g", scope: "global" as const, server: "s", tool: "t", name: "mcp__g__s__t", description: "d", parameters: {} as never };
  const outcome = (extra: Record<string, unknown> = {}): McpToolCallResult => ({ ok: true, value: { callId: "c1", server: "s", tool: "t", content: [{ type: "text", text: "done" }], isError: false, truncated: false, durationMs: 3, ...extra } } as unknown as McpToolCallResult);

  const success = mcpSettle(outcome(), tool);
  assert.equal(success.isError, false);
  assert.deepEqual(success.output, [{ type: "text", text: "done" }]);
  // The host's facts, on the channel a program reads and the one a UI reads. None of them is a configuration value.
  assert.deepEqual(success.details, { callId: "c1", gatewayId: "g", server: "s", tool: "t", isError: false, truncated: false, durationMs: 3 });

  assert.match(JSON.stringify(mcpSettle(outcome({ content: [] }), tool).output), /returned no content/);

  // A tool that reported its own failure is an answer about the call, not a transport failure.
  const failed = mcpSettle({ ok: true, value: { callId: "c1", server: "s", tool: "t", content: [{ type: "text", text: "the tool refused this call" }], isError: true, truncated: false, durationMs: 1 } } as unknown as McpToolCallResult, tool);
  assert.equal(failed.isError, true);
  assert.equal(failed.diagnostics?.[0]?.code, "tool_error");

  assert.deepEqual(mcpSettle(outcome({ truncated: true }), tool).diagnostics?.[0], { severity: "warn", code: "truncated", message: "truncated: the result exceeded the host's output bound and was cut to it" });

  // A refusal that says nothing ran keeps the host's own code and adds no claim about a server that never started.
  const refused = mcpSettle({ ok: false, code: "server-disabled", message: 'server "notes" is switched off' } as McpToolCallResult, tool);
  assert.equal(refused.diagnostics?.[0]?.code, "server_disabled");
  assert.doesNotMatch(refused.diagnostics![0]!.message, /Nothing is repeated/);

  // The two ends that leave the outcome unknown: the host's words, plus the reason nothing here retries.
  for (const code of ["timeout", "cancelled"] as const) {
    const uncertain = mcpSettle({ ok: false, code, message: "the server may have acted before the connection ended" } as McpToolCallResult, tool);
    assert.equal(uncertain.diagnostics?.[0]?.code, code);
    assert.match(uncertain.diagnostics![0]!.message, /Nothing is repeated for a call whose outcome is unknown/);
  }
});

/** One scripted turn: each tool call in its own assistant answer, then one final text answer to read them. */
function calls(requests: readonly [name: string, args: Parameters<typeof fauxToolCall>[1], id: string][], final = "adapter done") {
  return [...requests.map(([name, args, id]) => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" })), fauxAssistantMessage(final)];
}

/** The runtime's own call identity, as a tool sees it: the adapter reads nothing else from the api. */
function apiOf(callId: string, conversationId: string) {
  return { callId, conversationId: Number(conversationId) } as never;
}

const NO_CONTEXT = { abortSignal: undefined, value: () => undefined, toString: () => "no-context" } as never;

// ---------------------------------------------------------------------------
// One rig: the backend's routes, a gateway with the MCP host service, the fixture
// ---------------------------------------------------------------------------

type RigOptions = {
  /** The tools this deployment declares. Absent: none, which is what an ordinary deployment has. */
  readonly declarations?: readonly McpToolDeclaration[];
  /** The entries the **host's own** `mcp.json` holds. The backend never reads this file and never needs to. */
  readonly servers?: Record<string, unknown>;
  /** Whether this gateway serves MCP at all: `false` is a gateway in front of an SSH host. */
  readonly servesMcp?: boolean;
  /** A configured gateway with nothing behind it, for a tool whose host a conversation is not on. */
  readonly extraGatewayId?: string;
  /** The conversation's model answers. Absent: one call to `notes/record`, then a finish. */
  readonly script?: (faux: ReturnType<typeof fauxProvider>) => void;
};

type Rig = {
  readonly origin: string;
  readonly folder: string;
  readonly pidFile: string;
  readonly reachedFile: string;
  create(): Promise<string>;
  /** The one selection seam: extensions, and inside them this conversation's MCP grants. */
  select(conversationId: string, extensions: readonly string[], mcp?: { server: string; tools?: readonly string[] }): Promise<{ status: number; body: any }>;
  /** One person's act: grant this conversation these tools of one server, replacing what it held of that server. */
  grant(conversationId: string, server: string, tools: readonly string[]): Promise<{ status: number; body: any }>;
  /** Ask the host, on purpose, what one server holds — the same seam, `tools` left out. */
  discover(conversationId: string, server: string): Promise<{ status: number; body: any }>;
  /** What this conversation holds and offers, as the selection seam states it. */
  grants(conversationId: string): Promise<any>;
  submit(conversationId: string, requestId: string, text: string): Promise<number>;
  abort(conversationId: string): Promise<number>;
  /** The user's own stop: holds the conversation, and ends the ordinary work it was running. */
  stop(conversationId: string, requestId: string): Promise<{ status: number; body: any }>;
  /** The user's explicit resume after a stop. It starts no work of its own beyond the input it carries. */
  continue(conversationId: string, requestId: string): Promise<{ status: number; body: any }>;
  json(path: string): Promise<any>;
  /** Restart this backend over the same store. */
  restart(): Promise<void>;
  /** A branch of a conversation, through the product's own fork route. */
  fork(conversationId: string, requestId: string): Promise<{ status: number; body: any }>;
  state(conversationId: string): Promise<ServerSnapshot>;
  /** Poll a committed fact, so a loaded machine races its own answer and not a fixed delay. */
  until<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, what: string): Promise<T>;
  close(): Promise<void>;
};

/**
 * One backend and one gateway over a folder and an account directory of the test's own.
 *
 * The gateway is reached over its own HTTP surface with the MCP host service, so it reads the `mcp.json` this test
 * writes and starts the stdio fixture as its own account. Without that service it is what a gateway fronting an SSH
 * host is, and it answers its own named limit.
 */
async function rig(t: TestContext, options: RigOptions = {}): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "hepi-mcp-adapter-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const folder = join(home, "project");
  const agentDir = agentDirOf(home);
  const pidFile = join(base, "server.pid");
  const reachedFile = join(base, "slow.reached");
  await mkdir(folder, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // The fixture entry the tests call: the stdio server, its invocation tools on, and its own pid and evidence files.
  const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    command: process.execPath,
    args: [STDIO_FIXTURE],
    env: { PI_WEB_FIXTURE_INVOKE_TOOLS: "1", PI_WEB_FIXTURE_PID_FILE: pidFile, PI_WEB_FIXTURE_SLOW_FILE: reachedFile, FIXTURE_TOKEN: SECRET },
    ...extra,
  });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: options.servers ?? { notes: entry() } }, null, 2) + "\n");

  const registry = new WorkspaceRegistry([{ id: "local", root: folder }]);
  const gateway = new LocalGateway({ id: "workstation", token: GATEWAY_TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
  const host = new GatewayRpcServer({
    gateway,
    files: new LocalFilesystem(registry, { identity: { user: "operator", home } }),
    mcp: options.servesMcp === false ? undefined : new McpHostService(agentDir, registry),
  });
  await new Promise<void>(resolve => host.server.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = host.server.address();
  assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
  const gatewayOrigin = "http://127.0.0.1:" + gatewayAddress.port;
  const gateways = [{ gatewayId: "workstation", gatewayOrigin, gatewayToken: GATEWAY_TOKEN }];
  if (options.extraGatewayId !== undefined) gateways.push({ gatewayId: options.extraGatewayId, gatewayOrigin: "http://127.0.0.1:1", gatewayToken: GATEWAY_TOKEN });

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  if (options.script === undefined) {
    // The default script calls the declared tool once, then reads its answer and finishes: one durable tool round trip.
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      return transcript.messages.some(message => message.role === "toolResult")
        ? fauxAssistantMessage("adapter done")
        : fauxAssistantMessage([fauxToolCall(RECORD, { note: "from the conversation" }, { id: "call-record" })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  } else options.script(faux);

  const dbPath = join(base, "hepi.sqlite");
  // The backend build is a function because a restart is one of the facts under test: the same store, a new process of
  // this same file, and the same gateway and model answering on the other side of it.
  const start = async (): Promise<{ readonly backend: Awaited<ReturnType<typeof createBackendServer>>; readonly origin: string }> => {
    const backend = await createBackendServer({
      dbPath,
      authToken: BACKEND_TOKEN,
      models,
      workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin, gatewayToken: GATEWAY_TOKEN }],
      gateways,
      defaultModel: SERVER_MODEL,
      ...(options.declarations === undefined ? {} : { mcpTools: options.declarations }),
      // A refused declaration is asserted directly by the tests that produce one, not read out of a log.
      diagnostics: () => {},
    });
    await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
    const address = backend.server.address();
    assert.ok(address !== null && typeof address === "object");
    return { backend, origin: "http://127.0.0.1:" + address.port };
  };
  let started = await start();
  let origin = started.origin;

  return {
    get origin() { return origin; },
    folder,
    pidFile,
    reachedFile,
    /**
     * Close this backend and open another over the same store, and say where the next request goes. A conversation's
     * grants are durable state, so the reopened backend has to answer the same offer from the store alone — no host was
     * asked what it has, and nothing a person granted is re-derived from a declaration.
     */
    async restart() {
      started.backend.server.closeAllConnections();
      await started.backend.close();
      started = await start();
      origin = started.origin;
    },
    async fork(conversationId, requestId) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/fork", { method: "POST", headers: HEADERS, body: JSON.stringify({ requestId }) });
      const body = await response.text();
      return { status: response.status, body: JSON.parse(body) as any };
    },
    async create() {
      const response = await fetch(origin + "/api/conversations", { method: "POST", headers: HEADERS, body: JSON.stringify({ workspaceId: "local" }) });
      const body = await response.text();
      assert.equal(response.status, 201, body);
      return (JSON.parse(body) as { conversationId: string }).conversationId;
    },
    async select(conversationId, extensions, mcp) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/extensions", { method: "PATCH", headers: HEADERS, body: JSON.stringify(mcp === undefined ? { extensions } : { extensions, mcp }) });
      const body = await response.text();
      return { status: response.status, body: JSON.parse(body) as any };
    },
    // A grant and a listing are one act on one seam: this conversation's selection write, with its `mcp` section
    // stating the tools to grant, or naming only the server to ask the host about.
    async grant(conversationId, server, tools) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/extensions", { method: "PATCH", headers: HEADERS, body: JSON.stringify({ mcp: { server, tools } }) });
      const body = await response.text();
      return { status: response.status, body: JSON.parse(body) as any };
    },
    async discover(conversationId, server) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/extensions?mcp=" + encodeURIComponent(server), { method: "GET", headers: HEADERS });
      return { status: response.status, body: await response.json() as any };
    },
    async grants(conversationId) {
      const body = await (await fetch(origin + "/api/conversations/" + conversationId + "/extensions", { headers: HEADERS })).text();
      assert.match(body, /^[{[]/, "the selection seam answered no JSON body");
      return (JSON.parse(body) as { mcp: any }).mcp;
    },
    async submit(conversationId, requestId, text) {
      return (await fetch(origin + "/api/conversations/" + conversationId + "/messages", { method: "POST", headers: HEADERS, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) })).status;
    },
    async abort(conversationId) {
      return (await fetch(origin + "/api/conversations/" + conversationId + "/abort", { method: "POST", headers: HEADERS })).status;
    },
    async stop(conversationId, requestId) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/stop", { method: "POST", headers: HEADERS, body: JSON.stringify({ requestId }) });
      const body = await response.text();
      return { status: response.status, body: JSON.parse(body) as any };
    },
    async continue(conversationId, requestId) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/continue", { method: "POST", headers: HEADERS, body: JSON.stringify({ requestId }) });
      const body = await response.text();
      return { status: response.status, body: JSON.parse(body) as any };
    },
    async json(path) {
      const body = await (await fetch(origin + path, { headers: HEADERS })).text();
      assert.match(body, /^[{[]/, path + " answered no JSON body");
      return JSON.parse(body);
    },
    async state(conversationId) {
      const response = await fetch(origin + "/api/conversations/" + conversationId + "/state", { headers: HEADERS });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      return JSON.parse(body) as ServerSnapshot;
    },
    async until(read, ready, what) {
      const deadline = Date.now() + 25_000;
      for (;;) {
        const value = await read();
        if (ready(value)) return value;
        if (Date.now() > deadline) throw new Error("timed out waiting for " + what + ": " + JSON.stringify(value).slice(0, 800));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    close: async () => {
      started.backend.server.closeAllConnections();
      await started.backend.close();
      await host.close();
    },
  };
}

/** Whether the scripted final answer is in this conversation's visible window. */
const answered = (state: ServerSnapshot): boolean => state.entries.some(entry => entry.role === "assistant" && entry.text === "adapter done");

/** Whether a pid is still running, as a signal check rather than a guess about the process table. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The lifecycle, at the seam a conversation is written against
// ---------------------------------------------------------------------------

test("a selected tool is offered, runs on the bound gateway, and is committed as an ordinary durable tool result", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const conversationId = await r.create();

  // Installed is not selected: the extension is optional, so a new conversation is offered none of its tools.
  const before = await r.state(conversationId);
  assert.deepEqual(before.extensions.filter(name => name === MCP_EXTENSION), [], "a new conversation selects no MCP extension");
  assert.equal(before.toolNames.some(name => name.startsWith("mcp__")), false, "and is offered no MCP tool");

  // The conversation's own selection, through the existing per-conversation selection seam. Since 03b selecting the
  // extension is only half of it: its tools are registered deferred, so nothing is offered until a grant names one.
  const selected = await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.deepEqual(selected.body.extensions, [MCP_EXTENSION]);
  assert.equal(selected.body.toolNames.includes(RECORD), false, "a selected extension offers no tool of its own yet");

  const granted = await r.grant(conversationId, "notes", ["record"]);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.mcp.offered, [RECORD], "the granted tool is offered by its native name");
  assert.deepEqual(granted.body.mcp.grants.map((entry: any) => entry.tool), ["record"]);
  assert.equal(granted.body.mcp.grants[0].description, "Return the note it was given.", "the descriptor is the host's own text");
  assert.equal(granted.body.extensions.includes(MCP_EXTENSION), true, "a grant-only write left the extension selection it did not state");

  assert.equal(await r.submit(conversationId, "mcp-record", "record a note"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD), "the MCP call to settle");
  const call = resultsOf(settled.entries).find(entry => toolNameOf(entry) === RECORD)!;
  // The server's own answer, in the entry the model reads and the one the next request replays.
  assert.equal(call.text, JSON.stringify({ recorded: "from the conversation" }));
  assert.equal(call.message.isError, false);
  // The host's own facts about the call, on the entry the durable lifecycle recorded.
  const details = call.message.details!;
  assert.equal(details.callId, "call-record");
  assert.equal(details.gatewayId, "workstation");
  assert.equal(details.server, "notes");
  assert.equal(details.tool, "record");
  assert.equal(details.isError, false);
  assert.equal(details.truncated, false);
  assert.equal(typeof details.durationMs, "number");
  assert.equal(settled.entries.at(-1)!.text, "adapter done", "the run continued on the tool's answer");
  assert.equal(existsSync(r.pidFile), true, "the host started the configured server for the call");
});

test("a conversation that never selected the extension is refused before any request leaves the backend", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, {
    declarations: [recordDeclaration],
    // The host has the server, so only the conversation's own selection stands between it and a call.
    script: (faux) => faux.setResponses(calls([[RECORD, { note: "not selected" }, "call-unselected"]]))
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  assert.equal(await r.submit(conversationId, "mcp-unselected", "call it anyway"), 202);

  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length >= 1 && answered(state), "the unselected call to settle");
  const [call] = resultsOf(settled.entries);
  assert.deepEqual(codesOf(call!), ["tool_unavailable"]);
  assert.equal(call!.message.isError, true);
  // Nothing was sent: the host never started the server, so its folder was never read and no process was spawned.
  assert.equal(existsSync(r.pidFile), false, "an unselected tool reaches no MCP server at all");
});

test("the host's own refusals are recorded as they arrived, and none of them starts a server", { timeout: 60_000 }, async (t) => {
  const declarations: readonly McpToolDeclaration[] = [
    recordDeclaration,
    { gatewayId: "workstation", scope: "global", server: "hidden", tool: "record" },
    { gatewayId: "workstation", scope: "global", server: "off", tool: "record" },
    { gatewayId: "workstation", scope: "global", server: "notes", tool: "no_such_tool" },
    // A deployment cannot name a host this backend does not configure, so this one is never installed at all.
    { gatewayId: "absent", scope: "global", server: "notes", tool: "record" },
  ];
  const r = await rig(t, {
    declarations,
    servers: {
      notes: { command: process.execPath, args: [STDIO_FIXTURE] },
      hidden: { command: process.execPath, args: [STDIO_FIXTURE], exposure: "hidden" },
      off: { command: process.execPath, args: [STDIO_FIXTURE], enabled: false },
    },
    // Only the hidden server's tool is called: a grant could never be written for the other two (asserted below), so a
    // call is no longer the place those two refusals arrive, and this script must not produce an answer that never settles.
    script: (faux) => faux.setResponses(calls([
      [mcpToolName("workstation", "hidden", "record"), {}, "c-hidden"],
    ], "refusals done")),
  });
  t.after(() => r.close());

  const inventory = await r.json("/api/extensions");
  const installed = inventory.installed.find((extension: { name: string }) => extension.name === MCP_EXTENSION);
  // The offer is built from what this deployment declares **plus** what a conversation was granted, and the gateway a
  // declaration names but this backend does not configure contributes nothing: an identity with no host behind it would
  // be an offer no call of this conversation could ever reach.
  assert.deepEqual(installed.tools, [RECORD, mcpToolName("workstation", "hidden", "record"), mcpToolName("workstation", "off", "record"), mcpToolName("workstation", "notes", "no_such_tool")], "a host this backend does not configure contributes no tool");
  assert.equal(installed.enabled, false, "and the extension stays out of the default selection");

  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);

  // Two boundaries, because since 03b a grant is the second place a host's own answer can refuse an offer. A name the
  // server does not list is refused *before* it can become an offer: granting it would be writing a tool the host then
  // refuses on every call, which is a worse answer than refusing the grant.
  const unlisted = await r.grant(conversationId, "notes", ["no_such_tool"]);
  assert.equal(unlisted.status, 409, JSON.stringify(unlisted.body));
  assert.equal(unlisted.body.code, "not_listed");
  // A server the **host** has no entry for is refused by the host's own answer, not by this deployment's environment:
  // the backend asked which of its files an entry of that name lives in, and the host said none.
  const otherServer = await r.grant(conversationId, "absent-server", ["record"]);
  assert.equal(otherServer.status, 409, JSON.stringify(otherServer.body));
  assert.equal(otherServer.body.code, "server-missing");

  // A server switched off refuses the listing itself, with the host's own code and the host's own message: this backend
  // re-reads that answer at every grant and never carries a second copy of it.
  const switchedOff = await r.discover(conversationId, "off");
  assert.equal(switchedOff.status, 409, JSON.stringify(switchedOff.body));
  assert.equal(switchedOff.body.code, "server-disabled");
  assert.equal((await r.grant(conversationId, "off", ["record"])).status, 409, "and the grant it would have needed is refused with it");

  // A hidden server is the one refusal that must still reach a call: a listing shows what a server holds *including*
  // what its entry withholds from a model (03a), so the grant is honest, and the host's exposure rule decides at the call.
  const hidden = await r.discover(conversationId, "hidden");
  assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
  assert.equal(hidden.body.mcp.listed.tools.find((tool: any) => tool.name === "record").exposure, "hidden", "the listing states the exposure rather than dropping the tool");
  assert.equal((await r.grant(conversationId, "hidden", ["record"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-refusals", "call what the host refuses"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length === 1, "the host's refusal to settle");
  const [call] = resultsOf(settled.entries);
  assert.deepEqual(codesOf(call!), ["not_exposed"]);
  assert.equal(call!.message.isError, true, "recorded as the refusal it was, not as a success");
  assert.equal(existsSync(r.pidFile), false, "the hidden server was never started for it");
});

test("the host masks a credential before it reaches the backend, in either direction", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, {
    declarations: [{ gatewayId: "workstation", scope: "global", server: "notes", tool: "env_get", description: "The value of a variable in the server's environment.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
    script: (faux) => faux.setResponses(calls([[ENV_GET, { name: "FIXTURE_TOKEN" }, "call-env"]]))
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal(await (await r.grant(conversationId, "notes", ["env_get"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-secret", "echo the token you were given"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length >= 1 && answered(state), "the echo to settle");

  // The server echoed the value it was started with, and the host masked it before answering: what the backend holds is
  // the mask, in the entry text and in every projection of this conversation.
  const [call] = resultsOf(settled.entries);
  assert.equal(existsSync(r.pidFile), true, "the call did reach the server, so the mask is what stopped the value");
  assert.match(call!.text, new RegExp(SECRET_MASK));
  assert.doesNotMatch(call!.text, new RegExp(SECRET));
  const whole = JSON.stringify(await r.state(conversationId));
  assert.equal(whole.includes(SECRET), false, "no credential value is in any part of the conversation state");
});

test("a gateway in front of an SSH host answers its own named limit to a listing and a grant", { timeout: 60_000 }, async (t) => {
  // The host's capability is the host's to state, and 03b means a grant asks it: a tool this backend may only offer from
  // a host listing cannot be offered by a host that serves no MCP at all. So the refusal arrives at the grant rather than
  // at a call, with the gateway's own code and the gateway's own words, and nothing is offered and nothing is sent.
  const r = await rig(t, { declarations: [recordDeclaration], servesMcp: false });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  const listed = await r.discover(conversationId, "notes");
  assert.equal(listed.status, 409, JSON.stringify(listed.body));
  assert.equal(listed.body.code, "mcp_unavailable");
  const granted = await r.grant(conversationId, "notes", ["record"]);
  assert.equal(granted.status, 409, JSON.stringify(granted.body));
  assert.equal(granted.body.code, "mcp_unavailable");
  const state = await r.grants(conversationId);
  assert.deepEqual(state.grants, [], "the refusal wrote no grant");
  assert.deepEqual(state.offered, [], "and the conversation is offered no tool of it");
  assert.equal(existsSync(r.pidFile), false, "a capability refusal started no server");
  // The configuration read answered nothing, and the seam says exactly that instead of an empty list that a surface
  // would present as "this host configures nothing": the two are different sentences (ticket 03c review).
  assert.equal(state.serversKnown, false, "a host that could not be read states no known configuration");
  assert.equal(state.serversRefusal.code, "mcp_unavailable", "with the host's own code, not a made-up one");
  assert.match(state.serversRefusal.error, /MCP/);
  // Revoking is this backend taking an offer away, so it asks the host nothing and is answered on a host that cannot be
  // read at all: an empty set is a write, not a listing.
  const revoked = await r.grant(conversationId, "notes", []);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual(revoked.body.mcp.grants, [], "and the empty set is stored");
  assert.equal(revoked.body.mcp.serversKnown, false, "while the configuration stays unknown rather than becoming empty");
  assert.equal(existsSync(r.pidFile), false, "no revocation started a server");
});

test("a conversation bound to no execution workspace cannot select MCP tools, and is offered none", { timeout: 40_000 }, async (t) => {
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const response = await fetch(r.origin + "/api/conversations", { method: "POST", headers: HEADERS, body: JSON.stringify({}) });
  const { conversationId } = await response.json() as { conversationId: string };
  // The same rule the coding tools already have: an offer a conversation cannot run is refused at the selection.
  const refusal = await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal(refusal.status, 409);
  assert.equal(refusal.body.code, "unavailable_extension");
  assert.match(refusal.body.error, /execution workspace/);
  assert.deepEqual((await r.state(conversationId)).extensions.filter(name => name === MCP_EXTENSION), [], "the refusal wrote nothing");
  // The same boundary on the two grant routes: an unbound conversation has no host to grant against or to list.
  const grantRefusal = await r.grant(conversationId, "notes", ["record"]);
  assert.equal(grantRefusal.status, 409, JSON.stringify(grantRefusal.body));
  assert.equal(grantRefusal.body.code, "host_unavailable");
  const listRefusal = await r.discover(conversationId, "notes");
  assert.equal(listRefusal.status, 409, JSON.stringify(listRefusal.body));
  assert.equal(listRefusal.body.code, "host_unavailable");

  // A tool call it attempts anyway reaches no host, with the claim that nothing was sent.
  assert.equal(await r.submit(conversationId, "mcp-unbound", "call it"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length === 1, "the unbound call to settle");
  assert.deepEqual(codesOf(resultsOf(settled.entries)[0]!), ["tool_unavailable"]);
});

test("a caller that goes away ends the host request, and the uncertain call is not run again", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, {
    declarations: [slowDeclaration],
    script: (faux) => faux.setResponses(calls([[SLOW, { ms: 30_000 }, "call-slow"]]))
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal(await (await r.grant(conversationId, "notes", ["slow"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-cancel", "start the slow one and stop me"), 202);

  // The call reached the server: the file it writes on entry is the evidence, not a delay that hopes the call arrived.
  await r.until(() => existsSync(r.reachedFile), reached => reached, "the slow tool to be reached on the host");
  const pid = Number(await readFile(r.pidFile, "utf8"));
  assert.equal(alive(pid), true, "the host's server process is running for the call");

  assert.equal(await r.abort(conversationId), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length >= 1, "the cancelled call to settle");
  const [call] = resultsOf(settled.entries);
  assert.equal(call!.message.isError, true);
  // The cancellation reached the underlying MCP request, so the server the host started ends with it.
  await r.until(() => alive(pid), gone => !gone, "the fixture server to exit once the caller went away");
  // The settlement names an uncertain end, in the runtime's or the host's own words, and never claims nothing ran.
  assert.ok(["aborted", "cancelled", "outcome_unknown"].includes(codesOf(call!)[0]!), "the settlement is an uncertain end: " + JSON.stringify(codesOf(call!)));
  assert.equal(JSON.parse(await readFile(r.reachedFile, "utf8")).ms, 30_000, "the server was reached once with the arguments it was given");

  // A later turn is not a reason to repeat it: the model answers, and the interrupted call stays the only one.
  assert.equal(await r.submit(conversationId, "mcp-after", "what happened?"), 202);
  const done = await r.until(() => r.state(conversationId), state => !state.busy && state.entries.some(entry => entry.role === "assistant" && entry.text === "adapter done"), "the follow-up turn to answer");
  assert.equal(resultsOf(done.entries).filter(entry => toolNameOf(entry) === SLOW).length, 1, "the interrupted call ran exactly once");
});

// ---------------------------------------------------------------------------
// A grant is the conversation's own durable state, not a fact about this process
// ---------------------------------------------------------------------------

test("a granted tool is still offered after the backend that granted it is gone", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal((await r.grant(conversationId, "notes", ["record"])).status, 200);

  const before = await r.grants(conversationId);
  assert.deepEqual(before.offered, [RECORD]);

  // A new process over the same store: the durable grants are the only statement of what this conversation is offered,
  // so the reopened backend re-offers them without asking any host what a server holds.
  await r.restart();
  const after = await r.grants(conversationId);
  assert.deepEqual(after.grants.map((entry: any) => entry.tool), ["record"], "the grant is durable state, not this process's memory");
  assert.deepEqual(after.offered, [RECORD], "and the reopened backend offers it, with no listing asked of anyone");

  // The reopened offer is the one a call meets: the tool runs, which is the whole point of re-offering it.
  assert.equal(await r.submit(conversationId, "mcp-restarted", "record it after the restart"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD), "the restarted call to settle");
  assert.equal(resultsOf(settled.entries).find(entry => toolNameOf(entry) === RECORD)!.text, JSON.stringify({ recorded: "from the conversation" }));

  // A revocation survives the next restart too: the name leaves the filter, and a tool that is not offered cannot be
  // called by a model that no longer sees it.
  assert.equal((await r.grant(conversationId, "notes", [])).status, 200);
  assert.deepEqual((await r.grants(conversationId)).offered, [], "revoked now, and not offered now");
  await r.restart();
  assert.deepEqual((await r.grants(conversationId)).offered, [], "still not offered after another restart");
});

test("a branch of a granted conversation holds none of its grants", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal((await r.grant(conversationId, "notes", ["record"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-fork-source", "record it so the branch has history"), 202);
  await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD), "the source call to settle");

  // The product's own fork route: a branch inherits the source's history and its agent document, which carries the
  // source's granted names in `modelTools` — and inherits none of its grants, because the grant document does not fork.
  const forked = await r.fork(conversationId, "mcp-fork-1");
  assert.equal(forked.status, 201, JSON.stringify(forked.body));
  const branchId = forked.body.conversationId as string;
  const branch = await r.grants(branchId);
  assert.deepEqual(branch.grants, [], "a branch is a new conversation, and a grant is one conversation's act");
  assert.deepEqual(branch.offered, [], "so the inherited names are dropped from its offer rather than lingering as tools it cannot run");

  // The source keeps what it was granted, whatever its branch did.
  const source = await r.grants(conversationId);
  assert.deepEqual(source.offered, [RECORD], "a branch's isolation never takes a grant from the conversation that holds it");
});

test("a revoked tool is refused on the next call, and the grant states the offer it took away", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, {
    declarations: [recordDeclaration],
    // Two turns: the granted call runs, then the same tool is attempted again after the revocation landed between them.
    script: (faux) => faux.setResponses([
      fauxAssistantMessage([fauxToolCall(RECORD, { note: "first" }, { id: "c-granted" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("granted once"),
      fauxAssistantMessage([fauxToolCall(RECORD, { note: "again" }, { id: "c-revoked" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("revoked and refused"),
    ]),
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal((await r.grant(conversationId, "notes", ["record"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-granted-turn", "record it once"), 202);
  await r.until(() => r.state(conversationId), state => !state.busy && state.entries.some(entry => entry.text === "granted once"), "the granted turn to finish");

  // A person takes the tool away mid-conversation. The next resolution does not offer it, so the model's next attempt
  // meets the runtime's own refusal rather than a host call: nothing is sent, and the host is never started for it.
  assert.equal((await r.grant(conversationId, "notes", [])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-revoked-turn", "record it again"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length === 2 && state.entries.some(entry => entry.text === "revoked and refused"), "the revoked attempt to settle");
  const [first, second] = resultsOf(settled.entries);
  assert.equal(first!.message.isError, false, "the call made while granted ran");
  assert.deepEqual(codesOf(second!), ["tool_unavailable"], "the same tool after the revocation is refused before the host is addressed");
  assert.equal(existsSync(r.pidFile), true, "the server ran once for the granted call");
  const whole = JSON.stringify(await r.state(conversationId));
  assert.equal(whole.includes(SECRET), false, "and no host value reached the conversation state through either call");
});

// ---------------------------------------------------------------------------
// The grant, not the declaration, is what offers and describes a tool (03b finding 1 and 2)
// ---------------------------------------------------------------------------

test("a tool no deployment declared is listed by its host, granted, and runs", { timeout: 60_000 }, async (t) => {
  // This backend starts with **no** `HEPI_MCP_TOOLS`: the bridge is installed because a gateway is configured, and every
  // identity it offers comes from the host's own listing of its own server. Nothing here needs an operator declaration
  // to grant a tool, which is the whole of finding 1.
  const r = await rig(t, {});
  t.after(() => r.close());
  const inventory = await r.json("/api/extensions");
  const installed = inventory.installed.find((extension: { name: string }) => extension.name === MCP_EXTENSION);
  assert.ok(installed !== undefined, "the extension is installed with no declaration to build it");
  assert.deepEqual(installed.tools, [], "and declares no tool of its own until a conversation grants one");

  const conversationId = await r.create();
  // The servers a panel shows come from the host's own configuration files, and reading them starts nothing.
  const state = await r.grants(conversationId);
  assert.deepEqual(state.servers.map((server: any) => server.server), ["notes"], "the host's read names its own servers");
  assert.deepEqual(state.grants, [], "and this conversation holds no grants yet");
  assert.equal(existsSync(r.pidFile), false, "a state read started no server");

  await r.select(conversationId, [MCP_EXTENSION]);
  const listed = await r.discover(conversationId, "notes");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  // The host lists what its server actually holds — including `slow`, `big` and `fail`, which this fixture only answers
  // when it is started in invocation mode. Nothing here was filtered by a declaration, which is the point.
  assert.ok(listed.body.mcp.listed.tools.some((tool: any) => tool.name === "record"), "the host's own listing, no declaration involved");
  assert.equal(listed.body.mcp.listed.tools.find((tool: any) => tool.name === "record")!.description, "Return the note it was given.", "the server's own description");

  const granted = await r.grant(conversationId, "notes", ["record"]);
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.deepEqual(granted.body.mcp.offered, [RECORD], "the grant is what offers it, with no declaration anywhere");
  assert.deepEqual(granted.body.mcp.grants.map((entry: any) => entry.description), ["Return the note it was given."], "described in the host's own words");

  assert.equal(await r.submit(conversationId, "mcp-undeclared", "record it"), 202);
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD), "the undeclared call to settle");
  assert.equal(resultsOf(settled.entries).find(entry => toolNameOf(entry) === RECORD)!.text, JSON.stringify({ recorded: "from the conversation" }), "and the tool runs on the host that lists it");
});

test("a granted schema is what the runtime validates a call against, and a mismatch sends nothing", { timeout: 60_000 }, async (t) => {
  // `env_get`'s own schema requires `name`. The grant copied that schema into the registration, so a model call without
  // it is refused by the runtime before this process addresses the host: the answer is the runtime's own invalid-arguments
  // settlement, and no request was sent. This is what it means for a stored grant to be an offer rather than a note
  // about the past — an argument shape a client invented could not refuse the call this way.
  const r = await rig(t, {
    declarations: [recordDeclaration],
    script: (faux) => faux.setResponses(calls([[ENV_GET, {}, "call-no-name"]], "refused the arguments")),
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal((await r.grant(conversationId, "notes", ["env_get"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-bad-args", "read a variable without naming it"), 202);

  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length === 1, "the invalid call to settle");
  const [call] = resultsOf(settled.entries);
  assert.equal(call!.message.isError, true);
  // The refusal is the runtime's own, in its own wording, and it quotes the required property **the host's schema
  // stated**: this rig declares no `env_get` entry at all, so nothing but the granted descriptor could have asked for it.
  assert.match(call!.text, /Validation failed for tool "mcp__workstation__notes__env_get"/);
  assert.match(call!.text, /name: must have required properties name/);
  // The adapter's every answer carries the host's facts as `details`; their absence is the proof this call never got
  // as far as its body, so nothing was sent. (The server's pid file was written by the listing that made the grant.)
  assert.equal(call!.message.details, undefined, "the refused call recorded no host outcome: " + JSON.stringify(call!.message).slice(0, 300));
});

test("a grant that names a key the host owns is refused by name and writes nothing", { timeout: 60_000 }, async (t) => {
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  for (const key of ["command", "url", "env", "headers", "auth", "workspaceId"]) {
    const response = await fetch(r.origin + "/api/conversations/" + conversationId + "/extensions", { method: "PATCH", headers: HEADERS, body: JSON.stringify({ mcp: { server: "notes", tools: ["record"], [key]: "x" } }) });
    const body = await response.json() as any;
    assert.equal(response.status, 400, key + ": " + JSON.stringify(body));
    assert.match(body.error, new RegExp(key), "the refusal names the key it refused");
  }
  const state = await r.grants(conversationId);
  assert.deepEqual(state.grants, [], "and nothing was granted");
  assert.deepEqual(state.offered, [], "so nothing is offered");
});

// ---------------------------------------------------------------------------
// The restart window: a real SIGKILL inside a call that may have acted
// ---------------------------------------------------------------------------

const crashChild = fileURLToPath(new URL("./mcp-replay-crash-child.ts", import.meta.url));

/** Run one stage of the crash child in its own process over the test's own SQLite file. */
function runStage(stage: string, dbPath: string, base: string, effects: string, conversationId?: string) {
  return spawnSync(process.execPath, [crashChild, stage, dbPath, base, effects, ...(conversationId === undefined ? [] : [conversationId])], { encoding: "utf8", timeout: 120_000 });
}

/** The facts line a stage printed; a stage that reached no window fails instead of reporting a guess. */
function facts(run: { status: number | null; signal: string | null; stdout: string; stderr: string }, killed: boolean): Record<string, unknown> {
  if (killed) {
    assert.equal(run.status, null, run.stderr + run.stdout);
    assert.equal(run.signal, "SIGKILL", run.stderr + run.stdout);
  } else {
    assert.equal(run.status, 0, run.stderr + run.stdout);
  }
  const line = run.stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "the stage printed no facts: " + run.stderr + run.stdout);
  return JSON.parse(line) as Record<string, unknown>;
}

test("a real SIGKILL inside an MCP call settles it as interrupted and never repeats the side effect", { timeout: 120_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-mcp-replay-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  /** The file the stub host appends to: one line per real execution, which is what a replay would double. */
  const effects = join(base, "external-effects.log");

  const killed = facts(runStage("kill-inside-call", dbPath, base, effects), true);
  assert.equal(killed.checkpoint, "unsafe-executing", "the kill landed inside the call, after its effect was on disk");
  assert.equal((await readFile(effects, "utf8")).trim().split("\n").length, 1, "the call reached the external side effect once");

  // Reopen the same store in a fresh process: the task's checkpoint says `execute` and its policy says unsafe, so the
  // runtime settles it and never calls the host again.
  const reopened = facts(runStage("reopen", dbPath, base, effects, String(killed.conversationId)), false);
  assert.equal(reopened.callsAfterRestart, 0, "recovery never re-ran a call whose replay is unsafe");
  assert.equal(reopened.results, 1, "the interrupted call settled exactly one result entry");
  assert.equal(reopened.interrupted, true, "and settled as the runtime's own interrupted wording: " + JSON.stringify(reopened.settlement));
  assert.equal((await readFile(effects, "utf8")).trim().split("\n").length, 1, "the external side effect is exactly what the killed process left");

  // A second reopen is a second restart: the settled result is already committed, so nothing runs again, ever.
  const again = facts(runStage("reopen", dbPath, base, effects, String(killed.conversationId)), false);
  assert.equal(again.callsAfterRestart, 0);
  assert.equal(again.results, 1, "one interrupted call, one committed result");
});

// ---------------------------------------------------------------------------
// Child and fork lifecycle (ticket 04)
// ---------------------------------------------------------------------------

test("a conversation's MCP calls run one at a time, so one round cannot take the host's whole bound", { timeout: 120_000 }, async (t) => {
  // The host bounds how many calls it **runs** across every conversation (8). Without a per-conversation bound, one model
  // asking for nine tools **in one round** would take every slot and the ninth — and every other conversation's call —
  // would be refused `busy` by the host. `executionMode: "sequential"` is the runtime's own round rule, so the proof is
  // at the public seam: one assistant answer asking for nine calls settles all nine, and a second conversation running
  // beside it is not refused.
  const r = await rig(t, {
    declarations: [slowDeclaration],
    script: (faux) => {
      // Each conversation's own transcript decides its answer, so two runs cannot consume each other's script.
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        if (transcript.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage("adapter done");
        const user = transcript.messages.findLast(message => message.role === "user");
        const wanted = contentText(user?.content as never).includes("nine") ? 9 : 1;
        // One answer, many calls: the round the per-conversation bound governs.
        return fauxAssistantMessage(
          Array.from({ length: wanted }, (_unused, index) => fauxToolCall(SLOW, { ms: 400 }, { id: "slow-" + index })),
          { stopReason: "toolUse" },
        );
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => r.close());
  const first = await r.create();
  const second = await r.create();
  for (const conversationId of [first, second]) {
    await r.select(conversationId, [MCP_EXTENSION]);
    assert.equal((await r.grant(conversationId, "notes", ["slow"])).status, 200);
  }

  assert.equal(await r.submit(first, "mcp-concurrent-1", "wait nine times"), 202);
  assert.equal(await r.submit(second, "mcp-concurrent-2", "wait once beside it"), 202);
  const settled = await r.until(
    () => Promise.all([r.state(first), r.state(second)]),
    ([one, two]) => !one.busy && !two.busy && resultsOf(one.entries).length === 9 && resultsOf(two.entries).length === 1,
    "both conversations' calls to settle",
  );
  const [nine, one] = settled.map(state => resultsOf(state.entries));
  // Every call ran. A round that started all nine at once would have been refused `busy` by the host past its own
  // bound of eight, which is the failure this bound exists to prevent.
  assert.deepEqual(nine!.map(entry => entry.message.isError), Array.from({ length: 9 }, () => false), "every call of the round ran: " + JSON.stringify(nine!.map(entry => entry.text)));
  assert.deepEqual(nine!.map(entry => entry.message.details?.callId), Array.from({ length: 9 }, (_unused, index) => "slow-" + index), "and in call order, one after another");
  // The other conversation's call settled too, rather than being refused the host's slots the first conversation held.
  assert.equal(one![0]!.message.isError, false, "a second conversation's call was not refused busy: " + one![0]!.text);
  assert.equal(one![0]!.text, JSON.stringify({ slept: true }));
});

test("a branch of a granted conversation is offered none of its tools, and a grant written on the branch stays there", { timeout: 60_000 }, async (t) => {
  // The fork half of ticket 04 at the public seam: `fork: "initial"` is the grant document's own policy, and the attach
  // path reconciles the branch's inherited `modelTools` against its empty grant list. The other half is that a grant a
  // person then writes **on the branch** is the branch's own: the source's offer is untouched, so neither conversation
  // can move the other's tools.
  const r = await rig(t, { declarations: [recordDeclaration] });
  t.after(() => r.close());
  const source = await r.create();
  await r.select(source, [MCP_EXTENSION]);
  assert.equal((await r.grant(source, "notes", ["record"])).status, 200);
  assert.equal(await r.submit(source, "mcp-fork-granted", "record it so the branch has history"), 202);
  await r.until(() => r.state(source), state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD), "the source call to settle");

  const forked = await r.fork(source, "mcp-fork-isolation");
  assert.equal(forked.status, 201, JSON.stringify(forked.body));
  const branch = forked.body.conversationId as string;
  assert.deepEqual((await r.grants(branch)).offered, [], "the branch inherits no offer of its source's tools");

  // A grant on the branch is the branch's: it is offered there and nowhere else.
  assert.equal((await r.grant(branch, "notes", ["record"])).status, 200);
  assert.deepEqual((await r.grants(branch)).offered, [RECORD], "the branch is offered what it was granted");
  assert.deepEqual((await r.grants(source)).offered, [RECORD], "and the source keeps exactly its own grant");
  assert.deepEqual((await r.grants(source)).grants.map((entry: any) => entry.tool), ["record"], "the source's grant document was not written by the branch's grant");
  // Revoking on the branch takes nothing from the source, which is the same fact stated the other way round.
  assert.equal((await r.grant(branch, "notes", [])).status, 200);
  assert.deepEqual((await r.grants(branch)).offered, []);
  assert.deepEqual((await r.grants(source)).offered, [RECORD], "a branch's revocation never reaches the conversation that holds the grant");
});

test("a delegated child is offered no MCP tool even when the default selects the extension, and the refusal reaches no host", { timeout: 90_000 }, async (t) => {
  // The child half of ticket 04: inheritance is explicit policy and never a consequence of being delegated to. The
  // delegating conversation holds a grant and is offered the tool. The deployment's **default selection** is then turned
  // on for `hepi.mcp`, so the child really does select the extension — and it is still offered nothing, because the one
  // delegation seam writes no loaded tool names over the agent document the runtime copies (`modelTools: null`, and
  // every MCP registration is `deferred`, so an unset filter loads none).
  const r = await rig(t, {
    declarations: [recordDeclaration],
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const user = transcript.messages.findLast(message => message.role === "user");
        const text = contentText(user?.content as never);
        // The child's own turn: it tries the tool its parent holds, then answers on the refusal.
        if (text.includes("child task")) {
          if (transcript.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage("child answered");
          return fauxAssistantMessage([fauxToolCall(RECORD, { note: "child attempt" }, { id: "child-record" })], { stopReason: "toolUse" });
        }
        if (text.includes("delegate now")) {
          if (transcript.messages.some(message => message.role === "toolResult" && (message as any).toolName === "agent_spawn")) return fauxAssistantMessage("parent delegated");
          return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child task: record a note" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("adapter done");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => r.close());
  // The definition the child runs as, written where the host keeps project definitions.
  await mkdir(join(r.folder, ".pi", "agents"), { recursive: true });
  await writeFile(join(r.folder, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

  const parent = await r.create();
  await r.select(parent, [MCP_EXTENSION, "hepi-subagents"]);
  assert.equal((await r.grant(parent, "notes", ["record"])).status, 200);
  assert.deepEqual((await r.grants(parent)).offered, [RECORD], "the delegating conversation holds a grant and is offered the tool");

  // Turn the extension on for every conversation created from here, so a child selects it: the isolation that remains is
  // the delegation seam's own, not an extension the child never chose.
  const written = await r.json("/api/extensions");
  assert.equal(written.default.includes(MCP_EXTENSION), false, "the extension starts out of the default selection");
  // The default keeps every extension it already had — a child still needs the coding tools its definition names — and
  // adds the two optional ones, so the isolation under test is the delegation seam's and not a missing tool.
  const inventory = await fetch(r.origin + "/api/extensions", { method: "POST", headers: HEADERS, body: JSON.stringify({ extensions: [...written.default, MCP_EXTENSION, "hepi-subagents"] }) });
  assert.equal(inventory.status, 200, await inventory.text());

  assert.equal(await r.submit(parent, "mcp-child-delegate", "delegate now"), 202);
  const delegated = await r.until(
    () => r.json("/api/conversations"),
    (body: any) => body.conversations.some((row: any) => row.displayParentId === parent),
    "the child to be created",
  );
  const child = (delegated.conversations as any[]).find(row => row.displayParentId === parent).id as string;
  const childState = await r.until(() => r.state(child), state => !state.busy, "the child's turn to settle");
  assert.equal(childState.extensions.includes(MCP_EXTENSION), true, "the child does select the extension, so this is not a withheld selection");

  // The child resolves no MCP name, and holds no grant of its own: the offer its parent was given did not come with it.
  assert.deepEqual(childState.toolNames.filter(name => name.startsWith(MCP_TOOL_PREFIX)), [], "a child inherits no loaded MCP tool");
  assert.deepEqual((await r.grants(child)).grants, [], "and no grant document of its own");

  // Its attempt is the runtime's own refusal, recorded with no host outcome: nothing left this process for it.
  const [attempt] = resultsOf(childState.entries);
  assert.deepEqual(codesOf(attempt!), ["tool_unavailable"], "an ungranted name settles before anything leaves the process");
  assert.equal(attempt!.message.details, undefined, "and recorded no host outcome, so no call was sent");
  assert.equal(childState.entries.some(entry => entry.text === "child answered"), true, "the child's run continued on the refusal");
  assert.equal(JSON.stringify(childState).includes(SECRET), false, "no host value reached the child's state");
  // The parent keeps its own grant whatever its child attempted.
  assert.deepEqual((await r.grants(parent)).offered, [RECORD], "a child never moves its parent's offer");
});

// ---------------------------------------------------------------------------
// Ticket 04's remaining lifecycle seams: what a stop, a child's own grant and
// a definition-restricted conversation really do
// ---------------------------------------------------------------------------

test("a conversation's own stop ends the MCP call it is running, and the resumed turn never repeats it", { timeout: 60_000 }, async (t) => {
  // Cancellation and parent stop semantics, at the seam a person uses: `POST …/abort` was already covered, and a stop is
  // a different contract (it holds the conversation, and its resume is an explicit act). The call is ended by the
  // conversation's own scope, the host's server exits with it, the settlement says the outcome is unknown, and a resume
  // answers the earlier turn rather than running the call again.
  //
  // Nothing here waits out a duration. The slow call's `ms` is only the bound the fixture would take if no one ended
  // it — the stop below is what ends it — and the model is counted, so "the resume started no work" is observed on the
  // provider instead of assumed from a delay.
  const unendedMs = 60_000;
  const steps = calls([[SLOW, { ms: unendedMs }, "call-stopped"]]);
  let asked = 0;
  const r = await rig(t, {
    declarations: [slowDeclaration],
    script: (faux) => {
      const respond: FauxResponseFactory = async () => {
        asked += 1;
        faux.setResponses([respond]);
        return steps.shift() ?? fauxAssistantMessage("a turn this test did not submit");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => r.close());
  const conversationId = await r.create();
  await r.select(conversationId, [MCP_EXTENSION]);
  assert.equal((await r.grant(conversationId, "notes", ["slow"])).status, 200);
  assert.equal(await r.submit(conversationId, "mcp-stop", "start the slow one and stop the conversation"), 202);
  await r.until(() => existsSync(r.reachedFile), reached => reached, "the slow tool to be reached on the host");
  const pid = Number(await readFile(r.pidFile, "utf8"));
  assert.equal(alive(pid), true, "the host's server process is running for the call");

  const stopped = await r.stop(conversationId, "mcp-stop-request");
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
  assert.equal(stopped.body.status, "accepted");
  assert.equal(stopped.body.control.state, "held", "a stop holds the conversation; it is not the abort contract");
  // The stop reached the underlying MCP request: the server the host started ends with it.
  await r.until(() => alive(pid), gone => !gone, "the fixture server to exit once the conversation was stopped");
  const settled = await r.until(() => r.state(conversationId), state => !state.busy && resultsOf(state.entries).length === 1, "the stopped call to settle");
  const [call] = resultsOf(settled.entries);
  assert.equal(call!.message.isError, true);
  assert.ok(["aborted", "cancelled", "outcome_unknown", "interrupted"].includes(codesOf(call!)[0]!), "the settlement names an uncertain end: " + JSON.stringify(codesOf(call!)));
  assert.equal(JSON.parse(await readFile(r.reachedFile, "utf8")).ms, unendedMs, "the server was reached once, with the arguments it was given");

  // The resume is the user's explicit act and starts no work of its own — an empty continue invents no turn — so the
  // recorded settlement stands and the side effect stays one. Nothing about a stop or a resume relaxes `replay`
  // semantics: the uncertain call is settled where it was recorded, and no layer re-runs it.
  const askedByTheStoppedTurn = asked;
  const resumed = await r.continue(conversationId, "mcp-resume-request");
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
  assert.equal(resumed.body.status, "resumed", "the resume was committed, not left pending behind a drain");
  assert.equal(resumed.body.control.state, "allowed");
  assert.equal(resumed.body.submissionId, undefined, "an empty resume admits no input of its own");
  // The resume is answered only after its commit, so an invented turn would already be admitted here and the
  // conversation would be busy; and one that started later would have to come from a queued input, of which there is
  // none. Both are committed facts read on the resume's own answer, with no delay standing in for them.
  const done = await r.state(conversationId);
  assert.equal(done.busy, false, "an empty resume starts no run");
  assert.deepEqual(done.queuedMessages, { steering: [], followUp: [] }, "and leaves nothing queued that could start one");
  assert.equal(asked, askedByTheStoppedTurn, "the model was asked nothing after the resume, so no turn was invented");
  assert.equal(resultsOf(done.entries).filter(entry => toolNameOf(entry) === SLOW).length, 1, "the stopped call ran exactly once, and the resume did not run it again");
  assert.equal(done.entries.filter(entry => entry.role === "toolResult").length, 1, "and the settlement it recorded is still the only one");
  assert.equal(JSON.parse(await readFile(r.reachedFile, "utf8")).ms, unendedMs, "the server was still reached exactly once, with the same arguments");
});


test("a child that is granted a tool is offered it and runs it, and a definition-restricted child reports only its own tools", { timeout: 90_000 }, async (t) => {
  // Ticket 04's child half states that inheritance is explicit policy, never implicit. The other direction is the one a
  // person's own act takes: a child **is** a conversation, so granting it a tool must offer it that tool — the same
  // deferred name, loaded by the same durable grant, with no inherited grant and no second registry. The definition
  // restricts the child's enabled tools, which is exactly the case an offer computed from the extension's tool list alone
  // reports wrongly.
  const r = await rig(t, {
    declarations: [recordDeclaration],
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const user = transcript.messages.findLast(message => message.role === "user");
        const text = contentText(user?.content as never);
        if (text.includes("child task")) {
          // The child's first turn is the delegation's own task; the second is a turn the test submits after granting it
          // the tool, and only that one may reach the host — the first has no grant to call with.
          const granted = text.includes("record it now");
          if (!granted || transcript.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage(granted ? "child recorded" : "child answered");
          return fauxAssistantMessage([fauxToolCall(RECORD, { note: "from the child" }, { id: "child-record" })], { stopReason: "toolUse" });
        }
        if (text.includes("delegate now")) {
          if (transcript.messages.some(message => message.role === "toolResult")) return fauxAssistantMessage("parent delegated");
          return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child task: record a note" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("adapter done");
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => r.close());
  // A definition that enables only `read`: the runtime's `pi.agent.tools` filter is what narrows the child's enabled set,
  // and an offer must follow it rather than the extension's own list.
  await mkdir(join(r.folder, ".pi", "agents"), { recursive: true });
  await writeFile(join(r.folder, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

  const parent = await r.create();
  await r.select(parent, [MCP_EXTENSION, "hepi-subagents"]);
  assert.equal((await r.grant(parent, "notes", ["record"])).status, 200);
  const written = await r.json("/api/extensions");
  const inventory = await fetch(r.origin + "/api/extensions", { method: "POST", headers: HEADERS, body: JSON.stringify({ extensions: [...written.default, MCP_EXTENSION, "hepi-subagents"] }) });
  assert.equal(inventory.status, 200, await inventory.text());

  assert.equal(await r.submit(parent, "mcp-child-grant", "delegate now"), 202);
  const delegated = await r.until(
    () => r.json("/api/conversations"),
    (body: any) => body.conversations.some((row: any) => row.displayParentId === parent),
    "the child to be created",
  );
  const child = (delegated.conversations as any[]).find(row => row.displayParentId === parent).id as string;
  await r.until(() => r.state(child), state => !state.busy, "the child's first turn to settle");

  // A restricted child reports exactly the tools it can be offered: `read` from its definition, and no MCP name, because
  // it holds no grant. Reporting the extension's whole tool list here would state a tool this conversation cannot run.
  const before = await r.grants(child);
  assert.deepEqual(before.offered, [], "a child with no grant is offered no MCP tool");
  assert.deepEqual((await r.state(child)).toolNames.filter(name => name.startsWith(MCP_TOOL_PREFIX)), [], "and its own projection agrees");
  assert.deepEqual((await r.state(child)).toolNames, ["read"], "a definition-restricted child reports the tools its own filter enables, not its extensions' whole list");

  // The child is a conversation, so a person may grant it a tool: the same seam, the same deferred registration, and the
  // same durable document. Nothing is inherited, and nothing is copied from the parent.
  assert.equal((await r.grant(child, "notes", ["record"])).status, 200);
  assert.deepEqual((await r.grants(child)).offered, [RECORD], "a grant on the child offers it the granted tool");
  assert.deepEqual((await r.state(child)).toolNames, ["read", RECORD], "and the child's own projection states the offer a call would meet");
  assert.deepEqual((await r.grants(parent)).offered, [RECORD], "the parent keeps exactly its own offer");
  // The granted child really runs it, on the same host, with its own identity in the request — the tool its parent
  // holds, granted to this conversation by a person, offered through the same deferred registration and loaded by the
  // same durable document. Nothing was inherited: this grant was written for this child.
  assert.equal(await r.submit(child, "mcp-child-run", "child task: record it now"), 202);
  const ran = await r.until(
    () => r.state(child),
    state => !state.busy && resultsOf(state.entries).some(entry => toolNameOf(entry) === RECORD),
    "the child's granted call to settle",
  );
  const result = resultsOf(ran.entries).find(entry => toolNameOf(entry) === RECORD)!;
  assert.equal(result.message.isError, false, "the child's granted tool ran: " + result.text);
  assert.equal(result.text, JSON.stringify({ recorded: "from the child" }));
  // The host's own facts, on the entry the child's own turn committed: the identity the runtime gave the call, and the
  // host, server and tool it ran on. Nothing about the parent's turn appears here.
  assert.equal(result.message.details?.callId, "child-record");
  assert.equal(result.message.details?.gatewayId, "workstation");
  assert.equal(result.message.details?.server, "notes");
  assert.equal(result.message.details?.tool, "record");
});
