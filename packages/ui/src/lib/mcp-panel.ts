import type {
  McpActionItemResult,
  McpActionResponse,
  McpConfigFileInfo,
  McpErrorResponse,
  McpProjectInfo,
  McpRefusalReason,
  McpResponse,
  McpScope,
  McpServerInfo,
  McpServerStatus,
  McpSignInFlowInfo,
  McpTestResult,
  ProjectTrustStatus,
} from "./api-types.ts";
import type {
  McpConfigFileInfo as HostFile,
  McpConfigRead as HostRead,
  McpHostResult as HostAnswer,
  McpServerInfo as HostServer,
  McpSignInFlowInfo as HostFlow,
  McpTestResult as HostTestResult,
  ProjectTrust as HostTrust,
} from "@hepi/protocol/gateway";
import { fillMcpImportFields, isValidServerName, parseMcpImport, type McpImportFieldValue, type McpImportNote } from "./mcp-import.ts";

/**
 * Settings › MCP and the project trust dialog, as a client reads and writes them.
 *
 * The configuration, the credentials and every server process belong to the host service that owns the
 * origin's computer (the gateway's authenticated \`POST /v1/mcp\`); this module is the aggregate a client
 * consumes: it asks the host for what it owns, maps the host's own words into the panel's shapes, and
 * answers every request with the listing read after it, so a change shows without a page reload.
 *
 * The client entry point is the client ingress (\`packages/gateway/src/ingress/mcp.ts\`, which reaches the
 * configuration host directly); the Next route that answered the same routes from the Web process was retired
 * with that app in ticket 17. A caller differs only in the two things handed in here: how the host service is
 * called, and where a browser cwd names a folder. Nothing here holds an MCP credential, and no MCP request
 * reaches the durable backend.
 *
 * One fact is this process's own, and it is stated as what it is: a test's last answer, kept here (keyed
 * by the entry it was about) so a reload still shows the Connection row. The host keeps no test history,
 * as upstream keeps none; a process restart loses these, and the panel then reads \`on\` until the next test.
 *
 * What the host cannot do is not offered: the panel is given no Code mode settings (that surface is the
 * runtime's, not this host's), no undo of a removal (the host keeps no copy of an entry), and no way to
 * record a folder's trust decision (that asks a person, on the host that owns the folder).
 */

// ---------------------------------------------------------------------------
// What the caller hands in
// ---------------------------------------------------------------------------

/** One answer the caller writes: an HTTP status and the JSON body, framework-free. */
export interface McpReply {
  readonly status: number;
  readonly body: unknown;
}

/** The host service, as the caller reaches it, and the status a host refusal answers with. */
export interface McpPanelHost {
  call(body: Record<string, unknown>): Promise<HostAnswer>;
  status(code: string): number;
}

/**
 * The folder a request names: the address the browser uses, and how the host that owns it is told which
 * folder is meant. The two are deliberately different — the browser's cwd is a routing address — and they
 * are the two vocabularies the host accepts: a path on its own filesystem, or a workspace id it resolves
 * against the folders it serves, so a caller that only knows the routing address never synthesizes a path.
 */
export interface McpPanelFolder {
  readonly routing: string;
  readonly ref: { readonly cwd: string } | { readonly workspaceId: string };
}

/**
 * Where a browser cwd names a folder the host serves, or that it names none this origin serves. The caller
 * hands this in, because a browser cwd is a routing address (\`/workspace/<id>\`) the host service knows
 * nothing about: which folders this origin serves is the routing adapter's knowledge, and the MCP surface
 * only carries the answer to the host.
 */
export type McpPanelFolderResolver = (cwd: string) => Promise<{ kind: "folder"; ref: McpPanelFolder["ref"] } | { kind: "unbound" } | { kind: "refused" }>;

/**
 * The status a host refusal answers with: a limit is 503, a folder this host does not serve is 403, anything else a
 * conflict the caller can act on. It is here rather than in a caller, because it belongs to this contract: two entries
 * answering the same refusal with different statuses would be two surfaces, not one.
 */
export function hostRefusalStatus(code: string): number {
  if (code === "mcp_unavailable" || code === "mcp_unreachable") return 503;
  if (code === "unknown-workspace") return 403;
  return code === "invalid-request" || code === "invalid_request" ? 400 : 409;
}

/** A host operation that answered, or the panel-shaped refusal to answer with instead. */
type Hosted<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reply: McpReply };

/** Why a request was refused, in the panel's own vocabulary: the host's code where the panel knows it. */
const PANEL_REASONS: Record<string, McpRefusalReason> = {
  "invalid-request": "invalid-request",
  invalid_request: "invalid-request",
  "server-invalid": "server-invalid",
  "server-missing": "server-missing",
  "entry-not-object": "entry-not-object",
  "name-taken": "name-taken",
  "project-untrusted": "project-untrusted",
  "trust-unreadable": "trust-unreadable",
  unparsable: "unparsable",
  "invalid-shape": "invalid-shape",
  "file-too-large": "too-large",
  "sign-in-not-oauth": "sign-in-not-oauth",
  "sign-in-unknown": "sign-in-unknown",
  "sign-in-not-waiting": "sign-in-not-waiting",
  "redirect-invalid": "redirect-invalid",
  "redirect-state-mismatch": "redirect-state-mismatch",
  "redirect-no-code": "redirect-no-code",
  "redirect-denied": "redirect-denied",
  "unknown-workspace": "cwd-denied",
};

function panelReason(code: string): McpRefusalReason {
  return PANEL_REASONS[code] ?? "internal";
}

function reply(body: unknown, init: { status: number }): McpReply {
  return { status: init.status, body };
}

/** One host operation, or the refusal the panel shows: the host's words, under the reason it named. */
async function hostCall<T>(host: McpPanelHost, body: Record<string, unknown>): Promise<Hosted<T>> {
  const answer = await host.call(body);
  if (answer.ok) return { ok: true, value: answer.value as T };
  return { ok: false, reply: refusal(host, answer.code, answer.message, { ...(answer.path === undefined ? {} : { path: answer.path }) }) };
}

function refusal(host: McpPanelHost, code: string, error: string, extra: Partial<McpErrorResponse> = {}): McpReply {
  // A limit is not a refusal of what the caller asked for: it names itself (\`code\`) and carries the
  // host's own words, which the panel shows as they are rather than as a translated refusal reason.
  if (code === "mcp_unavailable" || code === "mcp_unreachable") return reply({ error, code }, { status: host.status(code) });
  return reply({ error, reason: PANEL_REASONS[code] ?? "internal", ...extra }, { status: host.status(code) });
}

/** A request the panel could not have sent: its own guard, answered before the host is asked anything. */
function invalidRequest(error: string): McpReply {
  return reply({ error, reason: "invalid-request" } satisfies McpErrorResponse, { status: 400 });
}

function methodNotAllowed(): McpReply {
  return reply({ error: "method not allowed", reason: "invalid-request" } satisfies McpErrorResponse, { status: 405 });
}

// ---------------------------------------------------------------------------
// The panel's aggregate
// ---------------------------------------------------------------------------

/**
 * The key the panel uses to tell one version of an entry from another, and the key a test's answer
 * is recorded under: the entry as the host describes it, which holds no value. It is deliberately
 * not a hash of the file's JSON, which this process never sees.
 */
function configKey(server: HostServer): string {
  return JSON.stringify([server.scope, server.sourcePath, server.name, server.enabled, server.transport ?? "", server.invalidError ?? "", server.command ?? "", server.args ?? [], server.url ?? "", server.envNames, server.headerNames, server.usesOAuth, server.exposure ?? "", server.toolExposureCount ?? 0]);
}

/** A test's last answer, by the entry it was about. */
const lastTests = new Map<string, { configKey: string; result: McpTestResult }>();
/** The entry a sign-in was started for, by flow: the answer names it, and the host's flow does not. */
const flowKeys = new Map<string, string>();
/** How many entries keep their last test answer; a deployment has far fewer servers than this. */
const LAST_TESTS_MAX = 200;
/** How many sign-ins keep the entry they were started for; a deployment has far fewer at once. */
const FLOW_KEYS_MAX = 200;

function recordTest(scope: McpScope, name: string, key: string, result: McpTestResult): void {
  if (lastTests.size >= LAST_TESTS_MAX && !lastTests.has(scope + "\u0000" + name)) lastTests.delete(lastTests.keys().next().value as string);
  lastTests.set(scope + "\u0000" + name, { configKey: key, result });
}

/** Remember which version of an entry a sign-in was started for, for the flow's own answers. */
function rememberFlowKey(flowId: string, key: string): void {
  if (flowKeys.size >= FLOW_KEYS_MAX && !flowKeys.has(flowId)) flowKeys.delete(flowKeys.keys().next().value as string);
  flowKeys.set(flowId, key);
}

/** The last test answer for an entry, when it was recorded for the entry as the file holds it now. */
function testStatus(server: HostServer): McpServerStatus | undefined {
  const record = lastTests.get(server.scope + "\u0000" + server.name);
  if (record === undefined || record.configKey !== configKey(server)) return undefined;
  return { origin: "test", ...record.result };
}

function panelTestResult(result: HostTestResult): McpTestResult {
  return {
    state: result.state,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
    // The host reports how many tools it found, not what they were: the panel shows the count and no list.
    toolCount: result.toolCount ?? 0,
    ...(result.serverInfo === undefined ? {} : { serverInfo: result.serverInfo }),
    durationMs: result.durationMs,
    testedAt: result.testedAt,
  };
}

function panelServer(server: HostServer, shadowed: boolean, replaces: boolean): McpServerInfo {
  const status = testStatus(server);
  return {
    name: server.name,
    scope: server.scope,
    sourcePath: server.sourcePath,
    configKey: configKey(server),
    enabled: server.enabled,
    // The host's validator is the authority on what an entry means: an entry it refused is not validated.
    validated: server.invalidError === undefined,
    ...(server.invalidError === undefined ? {} : { invalidError: server.invalidError }),
    ...(server.notAnObject === true ? { notAnObject: true as const } : {}),
    ...(server.transport === undefined ? {} : { transport: server.transport }),
    ...(server.exposure === undefined ? {} : { exposure: server.exposure as NonNullable<McpServerInfo["exposure"]> }),
    ...(server.toolExposureCount === undefined ? {} : { toolExposureCount: server.toolExposureCount }),
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    envNames: [...server.envNames],
    ...(server.url === undefined ? {} : { url: server.url }),
    headerNames: [...server.headerNames],
    usesOAuth: server.usesOAuth,
    ...(server.url === undefined ? {} : { signedIn: server.signedIn, oauthStateStored: server.oauthStateStored }),
    // What the host resolves on its own account is not described here, and nothing is claimed about it.
    commandFields: [],
    variableReferences: [],
    ...(server.masked ? { masked: true } : { masked: false }),
    ...(shadowed ? { shadowedByProject: true } : {}),
    ...(replaces ? { replacesGlobal: true } : {}),
    ...(status === undefined ? {} : { status }),
  };
}

/** The panel's files, as the host reports them: its own problems, and no path it did not name. */
function panelFiles(files: readonly HostFile[]): McpConfigFileInfo[] {
  return files.map((file) => ({
    scope: file.scope,
    path: file.path,
    exists: file.exists,
    problems: file.problems.map((problem) => ({ reason: problem.reason as McpConfigFileInfo["problems"][number]["reason"], error: problem.error })),
  }));
}

/**
 * The folder's trust, as the panel reads it: the host's decision, and whether the folder's own
 * \`.pi/mcp.json\` is what that decision is about. Absent when the host could not read the store,
 * which the panel then says instead of guessing a decision.
 */
function panelTrust(trust: HostTrust, requiresTrust: boolean): ProjectTrustStatus {
  return {
    requiresTrust,
    trusted: trust.trusted,
    decision: trust.decision,
    ...(trust.decisionPath === undefined ? {} : { decisionPath: trust.decisionPath }),
    inherited: trust.inherited,
  };
}

/** The panel's project: its folder, and the trust decision a project-scoped configuration is gated on. */
function panelProject(routing: string, read: HostRead, trust: HostTrust | undefined): McpProjectInfo {
  const projectFile = read.files.find((file) => file.scope === "project");
  return {
    cwd: routing,
    ...(trust === undefined || trust.error !== undefined ? {} : { trust: panelTrust(trust, projectFile?.exists === true) }),
    ...(trust?.error === undefined ? {} : { trustError: trust.error }),
  };
}

/** The listing as the panel reads it, from the host's own read and the folder's trust. */
function panelOverview(read: HostRead, routing: string | undefined, trust: HostTrust | undefined): McpResponse {
  const projectNames = new Set(read.servers.filter((server) => server.scope === "project").map((server) => server.name));
  const globalNames = new Set(read.servers.filter((server) => server.scope === "global").map((server) => server.name));
  return {
    mcp: { available: true },
    // The Code mode settings belong to the sessions' runtime, which this origin does not serve:
    // the panel is given none, so it offers no control it could not perform.
    files: panelFiles(read.files),
    servers: read.servers.map((server) => panelServer(server, server.scope === "global" && projectNames.has(server.name), server.scope === "project" && globalNames.has(server.name))),
    ...(routing === undefined ? {} : { project: panelProject(routing, read, trust) }),
  };
}

/** The host's read of one folder, and the folder's trust when the panel covers one. */
async function hostRead(host: McpPanelHost, folder: McpPanelFolder | undefined): Promise<Hosted<{ read: HostRead; trust: HostTrust | undefined }>> {
  const read = await hostCall<HostRead>(host, { operation: "read", ...(folder === undefined ? {} : folder.ref) });
  if (!read.ok) return read;
  if (folder === undefined) return { ok: true, value: { read: read.value, trust: undefined } };
  const trust = await hostCall<HostTrust>(host, { operation: "trust", ...folder.ref });
  // A trust store that cannot be read leaves the listing standing: the panel says the decision is
  // unknown and refuses the project scope, which is what an unreadable store means.
  return { ok: true, value: { read: read.value, trust: trust.ok ? trust.value : undefined } };
}

/** The overview the panel shows: the host's listing after the change, as GET returns it. */
async function overview(host: McpPanelHost, folder: McpPanelFolder | undefined): Promise<Hosted<McpResponse>> {
  const hosted = await hostRead(host, folder);
  if (!hosted.ok) return hosted;
  return { ok: true, value: panelOverview(hosted.value.read, folder?.routing, hosted.value.trust) };
}

/** The overview plus what one action adds to it, from a listing the host already answered with. */
async function overviewAfter(host: McpPanelHost, folder: McpPanelFolder | undefined, read: HostRead, extra: Partial<McpActionResponse> = {}): Promise<McpReply> {
  let trust: HostTrust | undefined;
  if (folder !== undefined) {
    const hosted = await hostCall<HostTrust>(host, { operation: "trust", ...folder.ref });
    if (hosted.ok) trust = hosted.value;
  }
  const overviewValue = panelOverview(read, folder?.routing, trust);
  const projectTrust = overviewValue.project?.trust;
  return reply({ ...overviewValue, ...extra, ...(projectTrust === undefined ? {} : { trust: projectTrust }) } satisfies McpActionResponse, { status: 200 });
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

function scopeOf(body: Record<string, unknown>, search: URLSearchParams): McpScope {
  const scope = body.scope ?? search.get("scope");
  return scope === "project" ? "project" : "global";
}

function cwdOf(body: Record<string, unknown>, search: URLSearchParams): string | null {
  const cwd = typeof body.cwd === "string" ? body.cwd : search.get("cwd");
  return cwd === undefined || cwd === "" ? null : cwd;
}

/**
 * The folder a request names, as the host is told about it. A browser cwd is a routing address
 * (\`/workspace/<id>\`), which the host knows nothing about, so the folder is looked up the way every other
 * host-facing route looks it up. A path this origin serves no folder for is refused as one, and the
 * sentinel that means "no folder" (a conversation bound to none) leaves the global configuration alone.
 */
async function folderOf(cwd: string | null, resolve: McpPanelFolderResolver): Promise<{ ok: true; folder: McpPanelFolder | undefined } | { ok: false; reply: McpReply }> {
  if (cwd === null) return { ok: true, folder: undefined };
  const location = await resolve(cwd);
  if (location.kind === "unbound") return { ok: true, folder: undefined };
  if (location.kind === "refused") return { ok: false, reply: reply({ error: "This origin serves no such folder", reason: "cwd-denied" }, { status: 403 }) };
  return { ok: true, folder: { routing: cwd, ref: location.ref } };
}

function nameOf(body: Record<string, unknown>): string | undefined {
  return typeof body.name === "string" && body.name !== "" ? body.name : undefined;
}

const EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);

/** The largest paste an add reads, as upstream's own add route reads it. */
const ADD_MAX_TEXT = 256 * 1024;

/** The field values an add sends: the text typed for each, or the variable a value reads instead. */
function addValues(value: unknown): Record<string, McpImportFieldValue> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const values: Record<string, McpImportFieldValue> = {};
  for (const [id, given] of Object.entries(value as Record<string, unknown>)) {
    if (typeof given === "string") values[id] = given;
    else if (typeof given === "object" && given !== null && typeof (given as { reference?: unknown }).reference === "string") values[id] = { reference: (given as { reference: string }).reference };
    else return undefined;
  }
  return values;
}

/** The variable names an add typed for the paste's own literal secrets. */
function addSecretReferences(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const references: Record<string, string> = {};
  for (const [label, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name !== "string") return undefined;
    references[label] = name;
  }
  return references;
}

/** A refusal of an add, in the panel's words: the reason, and what it names about the paste. */
function refusedAdd(reason: McpRefusalReason, error: string, extra: { name?: string; fields?: string[]; notes?: readonly McpImportNote[] } = {}): McpReply {
  const body: McpErrorResponse = { error, reason, ...(extra.name === undefined ? {} : { name: extra.name }), ...(extra.fields === undefined ? {} : { fields: extra.fields }), ...(extra.notes === undefined ? {} : { notes: [...extra.notes] }) };
  return reply(body, { status: 409 });
}

/**
 * An add: the pasted text is read here by the same pure importer the panel previewed it with, so what
 * is written is what the importer makes of the text, and the browser cannot slip in a key the importer
 * would have dropped. A project file is often committed, so a literal secret keeps the entry global,
 * as upstream refuses it too.
 */
async function add(host: McpPanelHost, body: Record<string, unknown>, scope: McpScope, folder: McpPanelFolder | undefined): Promise<McpReply> {
  const text = typeof body.text === "string" ? body.text : undefined;
  if (text === undefined) return invalidRequest("an add carries the pasted text");
  if (text.length > ADD_MAX_TEXT) return invalidRequest("the pasted text is too long");
  const listed = await hostRead(host, folder);
  if (!listed.ok) return listed.reply;
  const taken = listed.value.read.servers.filter((server) => server.scope === scope).map((server) => server.name);
  const parsed = parseMcpImport(text, { rawPi: body.rawPi === true, takenNames: taken });
  if (!parsed.ok) return refusedAdd("import-failed", "No MCP server could be read from the pasted text", { notes: parsed.notes });
  const index = typeof body.server === "number" && Number.isInteger(body.server) ? body.server : 0;
  const source = parsed.servers[index];
  if (source === undefined) return invalidRequest("The pasted text holds " + parsed.servers.length + " server(s); there is no server " + index);
  const name = nameOf(body) ?? source.name;
  if (!isValidServerName(name)) return refusedAdd("name-invalid", '"' + name + '" is not a server name pi accepts: use letters, digits, "_" and "-"', { name });
  const values = addValues(body.values);
  if (values === undefined) return invalidRequest("values must map field ids to text or to a variable name");
  const secretReferences = addSecretReferences(body.secretReferences);
  if (secretReferences === undefined) return invalidRequest("secretReferences must map secret labels to variable names");
  const filled = fillMcpImportFields(source, values, secretReferences);
  if (!filled.ok) return refusedAdd("fields-incomplete", "Some values to fill in are missing or invalid", { notes: filled.notes });
  if (scope === "project" && filled.secretPaths.length > 0) {
    return refusedAdd("secret-global-only", '"' + name + '" holds a literal secret (' + filled.secretPaths.join(", ") + "), so it is saved only in the global mcp.json", { name, fields: filled.secretPaths });
  }
  const written = await hostCall<HostRead>(host, { operation: "write", scope, name, ...(folder === undefined ? {} : folder.ref), config: filled.config, requireNew: true });
  if (!written.ok) return written.reply;
  const path = written.value.files.find((file) => file.scope === scope)?.path;
  return await overviewAfter(host, folder, written.value, path === undefined ? {} : { added: { scope, name, path } });
}

/** One flow as the panel polls it: the host's phases, and the connection the sign-in made. */
function panelFlow(flow: HostFlow, key: string): McpSignInFlowInfo {
  const result = flow.result;
  return {
    flowId: flow.flowId,
    scope: flow.scope,
    name: flow.name,
    configKey: key,
    phase: flow.phase,
    ...(flow.authorizationUrl === undefined ? {} : { authorizationUrl: flow.authorizationUrl }),
    ...(flow.redirectUrl === undefined ? {} : { redirectUrl: flow.redirectUrl }),
    expiresInMs: flow.expiresInMs,
    ...(flow.alreadySignedIn === true ? { alreadySignedIn: true as const } : {}),
    ...(result === undefined ? {} : { result: { ...panelTestResult(result), afterSignIn: true as const } }),
    ...(flow.error === undefined ? {} : { error: flow.error, failure: "sign-in-failed" as const }),
  };
}

/** One change to the configuration, answered with the listing after it. */
async function action(host: McpPanelHost, body: Record<string, unknown>, scope: McpScope, folder: McpPanelFolder | undefined): Promise<McpReply> {
  const what = body.action;
  const name = nameOf(body);
  const project = { ...(folder === undefined ? {} : folder.ref) };

  // A switch, or a change to how a server's tools reach the model: one patch of the entry's own keys,
  // so a value this process never sees (an env or header value) is left exactly as the file holds it.
  if (what === "enable" || what === "disable" || what === "set-exposure") {
    if (name === undefined) return invalidRequest("name is required");
    let patch: Record<string, unknown>;
    if (what === "set-exposure") {
      const exposure = body.exposure;
      if (typeof exposure !== "string" || !EXPOSURES.has(exposure)) return invalidRequest('exposure must be one of "codemode", "deferred", "direct", "hidden"');
      patch = { exposure };
    } else {
      patch = { enabled: what === "enable" };
    }
    const written = await hostCall<HostRead>(host, { operation: "patch", scope, name, ...project, patch });
    if (!written.ok) return written.reply;
    return await overviewAfter(host, folder, written.value);
  }

  // One switch for a whole group: each server is patched, and each answer is reported by name, so a
  // server the host refused keeps its state and is named rather than silently dropped.
  if (what === "set-enabled") {
    const enabled = body.enabled === true;
    const asked = Array.isArray(body.servers) ? body.servers.filter((item): item is { scope?: unknown; name?: unknown } => typeof item === "object" && item !== null) : [];
    if (asked.length === 0) return invalidRequest("servers is required");
    const results: McpActionItemResult[] = [];
    let read: HostRead | undefined;
    for (const item of asked) {
      const itemScope: McpScope = item.scope === "project" ? "project" : "global";
      const itemName = typeof item.name === "string" ? item.name : "";
      const written = itemName === "" ? undefined : await hostCall<HostRead>(host, { operation: "patch", scope: itemScope, name: itemName, ...project, patch: { enabled } });
      if (written === undefined) {
        results.push({ scope: itemScope, name: itemName, reason: "invalid-request", error: "a server name is required" });
        continue;
      }
      if (written.ok) {
        results.push({ scope: itemScope, name: itemName });
        read = written.value;
      } else {
        results.push({ scope: itemScope, name: itemName, reason: panelReason("invalid-request"), error: (written.reply.body as McpErrorResponse).error });
      }
    }
    if (read === undefined) {
      const hosted = await hostRead(host, folder);
      if (!hosted.ok) return hosted.reply;
      return reply({ ...panelOverview(hosted.value.read, folder?.routing, hosted.value.trust), results }, { status: 200 });
    }
    // The listing the last patch answered with, with the folder's trust read as it stands now.
    let trust: HostTrust | undefined;
    if (folder !== undefined) {
      const hosted = await hostCall<HostTrust>(host, { operation: "trust", ...folder.ref });
      if (hosted.ok) trust = hosted.value;
    }
    return reply({ ...panelOverview(read, folder?.routing, trust), results }, { status: 200 });
  }

  if (what === "remove") {
    if (name === undefined) return invalidRequest("name is required");
    const written = await hostCall<HostRead>(host, { operation: "write", scope, name, ...project });
    if (!written.ok) return written.reply;
    // No undo: the host keeps no copy of an entry, and offering one this process cannot honour would
    // be a control that does not perform.
    return await overviewAfter(host, folder, written.value);
  }

  if (what === "sign-out") {
    if (name === undefined) return invalidRequest("name is required");
    const signedOut = await hostCall<{ removed: boolean }>(host, { operation: "sign-out", scope, name, ...project });
    if (!signedOut.ok) return signedOut.reply;
    const listed = await hostRead(host, folder);
    if (!listed.ok) return listed.reply;
    return await overviewAfter(host, folder, listed.value.read, { signedOut: { scope, name, removed: signedOut.value.removed === true } });
  }

  if (what === "add") return await add(host, body, scope, folder);
  return invalidRequest("unknown MCP action");
}

/**
 * The client surface for MCP configuration and project trust, bound to one host service.
 *
 * Each method answers one route of the client API with the panel's own shapes, and the caller decides
 * how a request reaches it (method, query, body) and how a browser cwd names a folder.
 */
export function createMcpPanel(host: McpPanelHost) {
  /** \`GET /api/mcp\`: the configuration host's MCP configuration, as the panel lists it. */
  async function overviewOf(query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const resolved = await folderOf(cwdOf({}, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const hosted = await overview(host, resolved.folder);
    return hosted.ok ? reply(hosted.value, { status: 200 }) : hosted.reply;
  }

  /** \`POST /api/mcp\`: one change, answered with the listing after it. */
  async function actionOf(body: Record<string, unknown>, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const resolved = await folderOf(cwdOf(body, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    return await action(host, body, scopeOf(body, query), resolved.folder);
  }

  /**
   * \`POST /api/mcp/test\`: one server's test. The host starts it, reports what it found and masks every
   * value it resolved; the answer names the version of the entry that was tested.
   */
  async function test(body: Record<string, unknown>, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const scope = scopeOf(body, query);
    const resolved = await folderOf(cwdOf(body, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const folder = resolved.folder;
    const name = nameOf(body);
    if (name === undefined) return invalidRequest("name is required");
    // The entry as the listing describes it, so the answer names the version of it that was tested.
    const listed = await hostRead(host, folder);
    if (!listed.ok) return listed.reply;
    const server = listed.value.read.servers.find((item) => item.scope === scope && item.name === name);
    if (server === undefined) return refusal(host, "server-missing", "no " + scope + ' MCP server "' + name + '" is configured');
    const tested = await hostCall<HostTestResult>(host, { operation: "test", scope, name, ...(folder === undefined ? {} : folder.ref) });
    if (!tested.ok) return tested.reply;
    const result = panelTestResult(tested.value);
    const key = configKey(server);
    recordTest(scope, name, key, result);
    return reply({ scope, name, configKey: key, result }, { status: 200 });
  }

  /**
   * \`POST /api/mcp/sign-in\`: start a sign-in. The flow itself lives on the host service; this surface
   * carries the request and the answer, and remembers which version of the entry it was started for.
   */
  async function signIn(body: Record<string, unknown>, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const scope = scopeOf(body, query);
    const resolved = await folderOf(cwdOf(body, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const folder = resolved.folder;
    const name = nameOf(body);
    if (name === undefined) return invalidRequest("name is required");
    const listed = await hostRead(host, folder);
    if (!listed.ok) return listed.reply;
    const server = listed.value.read.servers.find((item) => item.scope === scope && item.name === name);
    const flow = await hostCall<HostFlow>(host, { operation: "sign-in", scope, name, ...(folder === undefined ? {} : folder.ref) });
    if (!flow.ok) return flow.reply;
    const key = server === undefined ? "" : configKey(server);
    rememberFlowKey(flow.value.flowId, key);
    return reply(panelFlow(flow.value, key), { status: 200 });
  }

  /** \`GET /api/mcp/sign-in/<flowId>\`: the flow as it stands, as the panel polls it. */
  async function signInPoll(flowId: string, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const resolved = await folderOf(cwdOf({}, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const answer = await hostCall<HostFlow>(host, { operation: "sign-in-poll", flowId });
    if (!answer.ok) return answer.reply;
    return reply(panelFlow(answer.value, flowKeys.get(flowId) ?? ""), { status: 200 });
  }

  /** \`POST /api/mcp/sign-in/<flowId>\`: finish the flow with the address the browser landed on. */
  async function signInPaste(flowId: string, body: Record<string, unknown>, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const resolved = await folderOf(cwdOf({}, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const answer = await hostCall<HostFlow>(host, { operation: "sign-in-paste", flowId, redirectUrl: body.redirectUrl });
    if (!answer.ok) return answer.reply;
    return reply(panelFlow(answer.value, flowKeys.get(flowId) ?? ""), { status: 200 });
  }

  /** \`DELETE /api/mcp/sign-in/<flowId>\`: cancel a flow the person abandoned. */
  async function signInCancel(flowId: string, query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const resolved = await folderOf(cwdOf({}, query), resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const answer = await hostCall<HostFlow>(host, { operation: "sign-in-cancel", flowId });
    if (!answer.ok) return answer.reply;
    return reply(panelFlow(answer.value, flowKeys.get(flowId) ?? ""), { status: 200 });
  }

  /**
   * \`GET /api/project-trust\`: the folder's trust decision, read from the host that owns the folder, with
   * what the folder's own \`.pi/mcp.json\` declares so the trust dialog can list it before anyone trusts the
   * folder. Recording a decision is not this route's job (a decision asks a person, on the host that owns
   * the folder), so only the read is answered here.
   */
  async function projectTrust(query: URLSearchParams, resolveCwd: McpPanelFolderResolver): Promise<McpReply> {
    const cwd = query.get("cwd");
    if (cwd === null || cwd === "") return invalidRequest("cwd is required");
    const resolved = await folderOf(cwd, resolveCwd);
    if (!resolved.ok) return resolved.reply;
    const folder = resolved.folder;
    const read = await hostCall<HostRead>(host, { operation: "read", ...(folder === undefined ? {} : folder.ref) });
    if (!read.ok) return read.reply;
    const trust = folder === undefined
      ? { ok: true as const, value: { cwd, trusted: false, decision: null, inherited: false } satisfies HostTrust }
      : await hostCall<HostTrust>(host, { operation: "trust", ...folder.ref });
    const mcpFile = read.value.files.find((file) => file.scope === "project");
    const listing = {
      ...(mcpFile === undefined ? {} : { mcpFile: panelFiles([mcpFile])[0] }),
      mcpServers: read.value.servers.filter((server) => server.scope === "project").map((server) => panelServer(server, false, false)),
    };
    if (!trust.ok) {
      // The listing does not depend on the trust store, so the dialog still shows it while saying why the status is unknown.
      return reply({ ...listing, error: trust.reply.status === 503 ? "no MCP host service" : "trust.json could not be read", reason: "trust-unreadable" }, { status: trust.reply.status });
    }
    const projectFile = mcpFile;
    return reply({ ...panelTrust(trust.value, projectFile?.exists === true), ...listing }, { status: 200 });
  }

  return { overview: overviewOf, action: actionOf, test, signIn, signInPoll, signInPaste, signInCancel, projectTrust, methodNotAllowed, invalidRequest };
}
