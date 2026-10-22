import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createDiagnosticsHttp, createDiagnosticsPages } from "./diagnostics-http.ts";
import { createWorkspaceHttp } from "./workspace-http.ts";
import { createSettingsHttp } from "./settings-http.ts";
import { createConversationHistoryHttp } from "./conversation-history-http.ts";
import { createConversationCommandHttp } from "./conversation-command-http.ts";
import { createConversationExtensionsHttp } from "./conversation-extensions-http.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ImageContent, type Models, type TextContent } from "@earendil-works/pi-ai";
import { safeFailure } from "./public-errors.ts";
import { createConversationAttachments, type ConversationRuntime } from "./conversation-attachments.ts";
export type { ServerSnapshot, ServerEntry, ServerDelta, ServerFrame, ServerFailure } from "./conversation-attachments.ts";
import { type ConversationId, type TaskInspection, type Cursor, type ModelRef, type Extension } from "@earendil-works/pi-durable";
import { GatewayHostClient, gatewayEnvironment, HostTransportError, type EnvironmentBinding, type ExecutionHostEnv } from "@hepi/gateway";
import { DEFAULT_HOST_HEADER, HEARTBEAT_INTERVAL_MS, PROTOCOL_VERSION, type ConversationProvenance, type SubmitImage } from "@hepi/protocol";
import type { McpToolList, WorkbenchOperation, WorkspaceRequest as HostRequest } from "@hepi/protocol/gateway";
import { readSidebarState } from "./sidebar-state.ts";
import { ConversationOperationRefusal, createConversationOperations, WorkspaceDoc } from "./conversation-operations.ts";
import { type SubtreeChildOutcome, type SubtreeControlResult } from "./subtree-control.ts";
import { conversationPage } from "./conversation-page.ts";
import { catalogueListVersion, type CatalogueWorkspace } from "./catalogue-binding.ts";
import { createConversationItemOperations } from "./conversation-items.ts";
import { SearchQueryTooLong, searchConversationBodies } from "./session-search.ts";
import { ensureAdoptedResources, resourceSummary, type WorkspaceResources } from "./workspace-resources.ts";
import { ENVIRONMENT_EXTENSION, openServerHarness, type ExtensionInstallFailure, type ServerHarness, type HarnessConfiguration } from "./harness.ts";
import { extensionNameList, ExtensionSelectionDoc, materializeSelection, readDefaultSelection, resolveDefaultSelection, writeDefaultSelection, type InstalledExtension } from "./extension-selection.ts";
import { type ModelConfigTarget } from "./model-config.ts";
import { skillMarketRoute, type SkillMarket } from "./skill-repository.ts";
import { boundedMessage, createInstaller, installRequest, toggleRequest, updateRequest, type Installer } from "./skill-install.ts";
import { createTerminalRelay } from "./terminal-relay.ts";
import { createFileRelay } from "./file-relay.ts";
import { createAgentDefinitionsHandler } from "./agent-definitions-http.ts";
import { createSubagentHost, type SubagentCatalogueRow } from "./subagents/composition.ts";
import { createSubagentExtension } from "./subagents/extension.ts";
import { DispatchDoc, SUBAGENT_ANCHOR_TASK, SUBAGENT_EXTENSION } from "./subagents/host.ts";
import { createSubagentDelegation } from "./subagents/delegate.ts";
import { projectRunStatus, type ConversationRunStatus } from "./subagents/status.ts";
import { createMcpToolBridge, MCP_EXTENSION, MCP_TOOL_PREFIX, type McpCallTarget, type McpToolDeclaration } from "./mcp-conversation-tools.ts";
import { grantEntriesOf, mcpConfigReadOf, mcpGrantSelection, mcpToolListOf, readMcpGrants, reconcileMcpOffer, writeMcpGrants } from "./mcp-grants.ts";

/** The two per-catalogue facts a status needs, read once for a whole list. */
type CatalogueFacts = { readonly tasks: ReadonlyMap<string, readonly TaskInspection[]>; readonly waitingReports: ReadonlySet<string> };

/** One child's outcome with its current session row attached, which is what a subtree answer projects. */
type SubtreeProjectedOutcome = SubtreeChildOutcome & { readonly session?: CatalogueEntry };


/** One subtree request's answer as the HTTP surface states it: the recorded outcomes plus each child's current row. */
type SubtreeProjectedResult = Omit<SubtreeControlResult, "outcomes"> & { readonly outcomes: readonly SubtreeProjectedOutcome[] };
import { createProjectRegistry, WEB_HOST_REQUIRED, type GatewayConnection, type ProjectMutation } from "./project-registry.ts";
import type { ProjectRecord, ProjectStore } from "./project-store.ts";
import type { DeviceCredentials } from "./device-credentials.ts";

export type BackendServer = { readonly server: Server; close(): Promise<void> };
/**
 * One conversation as the catalogue lists it: what the session list and the running poll both need, from one read.
 * The fork route answers the row this builds for its new conversation, so the row a caller is handed and the row the
 * next list read shows for the same conversation cannot be two different things. The hepi-owned title is part of the
 * row — the runtime's record has none — and a conversation with no title states the absence explicitly rather than
 * omitting the field, so a caller cannot read a missing field as "not loaded yet".
 *
 * `subagentParentConversationId` is the creator edge of a conversation a task created: a subagent's own conversation,
 * and the conversation whose task owns it. The row reports it rather than leaving a client to guess, because every
 * surface that asks "is this a subagent's?" — the completion sound, the notification, the unread marker, the session
 * tree — otherwise reads a set that is empty by construction. It is reported whether or not the owning conversation is
 * still listed: it is a fact about this conversation, and a client that could not see it would treat a subagent's
 * completion as the user's.
 *
 * It is **not** reported for a conversation the user branched from a child. That branch is task-owned — by its own
 * background anchor, in the source's scope — but its owner is not a delegation: nobody asked for it, so reporting the
 * edge would make a surface read the user's own branch as a subagent's, fold it into the source's family and treat its
 * answer as a silent completion. The branch states its source through `parentConversationId` and its place through
 * `displayParentId`; the native owner stays readable through the by-id read, where it is a fact and not a
 * classification (spec D14).
 *
 * `lastRunEndedAt` is when this conversation's newest finished run ended, from the committed task table. It is the one
 * fact that says a run happened at all: a run that starts and finishes between two polls is never seen as busy, so a
 * client that only compared running flags could not learn it ran, while a client comparing this can. It is reported
 * without a per-poll read — the value is read once when the conversation is attached and kept current from this
 * process's commit stream, exactly as the title and the removal are — and it states no outcome: whether a run answered,
 * aborted or failed is the transcript's and the submission's business, and a marker that said otherwise would be a
 * completion notice the durable facts do not support.
 */
type CatalogueEntry = {
  id: string;
  workspaceId: string | null;
  gatewayId: string | null;
  /**
   * The binding facts about `workspaceId`, from the same lookup that resolved it: the folder's recorded root, whether a
   * removal retained it, and the Project it is a folder of. Absent for a conversation bound to no workspace, and the
   * `gatewayId` above is kept beside it because every surface that names a host already reads it there.
   */
  workspace?: CatalogueWorkspace;
  busy: boolean;
  /**
   * This conversation's own execution status, projected from facts about **it** — its own run, its own committed
   * control, its own live tasks and whether its delegated result is waiting in its creator's queue. A surface reads
   * this instead of inferring a child's state from a parent's busy flag (spec D15).
   */
  runStatus: ConversationRunStatus;
  /**
   * The extensions this conversation currently selects, from the runtime's own resolution of its stored choice. It is
   * the same list the state frame already publishes, so a surface that has to know whether this conversation may
   * delegate reads it here instead of making a second per-conversation request — and the delegate entry follows the
   * conversation's own selection rather than a deployment-wide guess (spec D15).
   */
  extensions: readonly string[];
  revision: number;
  messageCount: number;
  firstMessage: string;
  title: string | null;
  lastRunEndedAt?: number;
  /**
   * The hepi-owned creator edge: the conversation that asked for this one. It is separate from
   * `subagentParentConversationId` (the native task ownership edge) because an ordinary conversation can create an
   * independent one, and separate from `parentConversationId` (the native fork source).
   */
  createdBy?: string;
  /**
   * The conversation this one is displayed under, from its hepi-owned relations. It is kept even when that parent is
   * tombstoned, with `displayParentDeleted` stating the parent is unavailable, so a child is never promoted to a
   * conversation of its own and its relation stays readable (spec D03).
   */
  displayParentId?: string;
  displayParentDeleted?: boolean;
  /** The native immutable fork source, projected from the conversation record; absent when the conversation is no fork. */
  parentConversationId?: string;
  /** The native task ownership edge, absent for a conversation the user branched (see above). */
  subagentParentConversationId?: string;
};
/**
 * A workspace a removed folder left behind. It resolves like any other binding, so a conversation already bound to it
 * keeps its host, its root and its execution environment; the marker is what keeps it out of every target picker and
 * out of the home and default-directory answers (spec decision 23).
 */
/** The gateway id a Web origin named for the host it serves, as it arrives on a host-scoped request. */
const namedHostId = (value: string | null | undefined): string | undefined => value === null || value === undefined || value.trim() === "" ? undefined : value.trim();
/**
 * One folder of one project, as the unlink route addresses it: `/api/projects/<projectId>/folders/<folderId>`. The
 * folder is named inside the project's own path because it is the project's folder and not a workspace, and the two
 * ids are captured undecoded so a percent-encoded id reaches the store as the caller sent it.
 */
const folderUnlinkPath = /^\/api\/projects\/([^/]+)\/folders\/([^/]+)$/;
/**
 * The host requests and answers this backend sends and reads are declared once, for every consumer, in
 * `@hepi/protocol/gateway`: the routes are the gateway's, and a second declaration of the same JSON here could only
 * drift from it silently. The aliases keep the names this file already used for them.
 */
type HostAnswer = { ok: true; value: unknown } | { ok: false; code: string; status: number };

/**
 * What a host call that produced no domain answer means to a browser-facing route. The transport already decided: a
 * connection that never opened is offline, a caller's own cancellation and a refused request are not unknown, and a
 * mutation whose answer was lost may have run. `mutating` is the route's own statement about the request, so a lost
 * registration or checkout is reported as an unknown outcome instead of as an offline host a caller might retry.
 */
function hostTransportAnswer(error: unknown, mutating: boolean): { readonly code: string; readonly status: number; readonly message?: string } {
  if (error instanceof HostTransportError) {
    if (error.code === "outcome_unknown" || (mutating && (error.code === "timeout" || error.code === "aborted"))) return { code: "outcome_unknown", status: 503 };
    if (error.code === "gateway_offline" || error.code === "timeout" || error.code === "aborted") return { code: "gateway_offline", status: 503 };
    // A host that answered and was not understood is still the host's answer: a rejected credential, a refusal whose
    // code this route does not know, and a body it could not read keep the 502 this route already gave them.
    return { code: "gateway_error", status: 502, ...(error.status === undefined ? {} : { message: "the execution host answered " + error.status }) };
  }
  return { code: "gateway_offline", status: 503 };
}
/**
 * `defaultModel`: a reference is the model new conversations start with, and `null` states that none is configured at
 * all — which the harness keeps as "none" rather than replacing with a manufactured one.
 */
type Options = HarnessConfiguration & { dbPath: string; authToken: string; workspaces?: readonly EnvironmentBinding[]; gateways?: readonly GatewayConnection[]; projects?: ProjectStore; defaultModel?: ModelRef | null; models?: Models; modelConfig?: ModelConfigTarget; workspaceResources?: WorkspaceResources; skillMarket?: SkillMarket; installer?: Installer; heartbeatIntervalMs?: number; deviceCredentials?: DeviceCredentials; buildId?: string; backendId?: string; accountScope?: string; mcpTools?: readonly McpToolDeclaration[] };

/** The bounded JSON body reader every route shares: one limit per route, and a body that is not JSON reads as absent. */
async function readBody(request: IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > limitBytes) throw new Error("request body exceeds " + Math.floor(limitBytes / 1024) + " KiB"); chunks.push(chunk as Buffer); }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
function authorized(request: IncomingMessage, token: string): boolean { return request.headers.authorization === "Bearer " + token; }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
/**
 * One project as a client sees it: its identity and name, the host every folder is on, and each recorded folder with
 * the `/workspace/<id>` routing its conversations bind plus whether it is the project's default. The default is what a
 * new conversation uses; naming another folder the default (PATCH) never moves a binding an existing conversation
 * holds, so every folder here stays resolvable for the conversations already in it.
 */
type ProjectFolderView = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectView = { id: string; name: string; hostId: string; profileId?: string; defaultFolderId: string; folders: ProjectFolderView[]; createdAt: string };

function projectView(project: ProjectRecord): ProjectView {
  return {
    id: project.id,
    name: project.name,
    hostId: project.hostId,
    ...(project.profileId === undefined ? {} : { profileId: project.profileId }),
    defaultFolderId: project.defaultFolderId,
    folders: project.folders.map(folder => ({ id: folder.id, workspaceId: folder.workspaceId, root: folder.root, cwd: "/workspace/" + folder.workspaceId, default: folder.id === project.defaultFolderId })),
    createdAt: project.createdAt,
  };
}

export async function createBackendServer(options: Options): Promise<BackendServer> {
  // The keepalive cadence one attached conversation stream writes at. A deployment that must sit under a stricter
  // idle bound states its own here; everything else reads the protocol's stated default.
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  // The execution-side resource loader is the only resource extension: skills, prompts and context all come from the
  // conversation's execution host (ADR 0002). There is no harness-local resource fallback.
  options = { ...options, resourceExtension: options.workspaceResources?.extension };
  // The project/workspace registry: the one owner of the configured workspaces, the optional ProjectStore, the
  // configured gateway connections and the live metadata a conversation resolves through. Resolution, registration
  // replay and the publication revision live there, so no route splices a project list, assembles a binding twice or
  // increments a revision itself.
  const registry = createProjectRegistry({ ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }), ...(options.gateways === undefined ? {} : { gateways: options.gateways }), ...(options.projects === undefined ? {} : { projects: options.projects }) });
  // Every gateway this deployment configured, by id. A project names one of them, so a project can never be routed to
  // a host the operator did not configure, and project metadata never stores a gateway URL or token.
  const gateways = new Map(registry.connections().map(connection => [connection.gatewayId, connection]));
  /**
   * The binding a request is built with. A project's root is registered again here — idempotently, and before the
   * environment is created — because the gateway keeps its workspaces in memory: a gateway that restarted while this
   * backend stayed up no longer serves a project's folder, and a conversation that was already bound has no other
   * chance to say so. Registration is the only thing replayed. An execution, write, installation or other call whose
   * outcome was unknown when a gateway went away is never repeated; it fails, and the next request is served normally.
   * A host that cannot be reached stays unreachable: this reports nothing and never redirects to another host.
   */
  const ensureBinding = registry.ensureBinding;
  // Every recorded folder's root lives in the gateway's memory, so all of them are replayed on every start: a project's
  // extra folders hold no conversation yet, but a conversation created against one of them has to find it registered.
  await registry.registerAll();
  /**
   * The one client for a resolved binding. Every host call in this file goes through it, so the origin join, the bearer
   * header, each route's own bound and the meaning of a lost answer are one policy instead of one per route. Building
   * one is a value, not a connection.
   */
  const clientOf = (binding: { gatewayOrigin: string; gatewayToken: string }): GatewayHostClient => new GatewayHostClient({ gatewayOrigin: binding.gatewayOrigin, gatewayToken: binding.gatewayToken });
  /** One request to a gateway's workspace management surface. The gateway owns the host's account and its roots. */
  const hostRequest = async (binding: { gatewayOrigin: string; gatewayToken: string }, body: HostRequest): Promise<HostAnswer> => {
    try {
      const result = await clientOf(binding).control.workspaces(body);
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, code: result.code, status: result.code === "workspace_conflict" ? 409 : 400 };
    } catch (error) {
      // Registration is the only workspace operation that changes the host; a listing or a browse that lost its answer
      // changed nothing, and the route's own status vocabulary keeps reporting both as the host it could not reach.
      const failure = hostTransportAnswer(error, body.operation === "register");
      return { ok: false, code: failure.code, status: failure.status };
    }
  };
  /** The execution targets one configured gateway offers. A gateway with no remote profiles answers with an empty list. */
  const hostProfiles = async (connection: GatewayConnection): Promise<{ ok: true; value: unknown } | { ok: false; code: string }> => {
    const listed = await hostRequest(connection, { operation: "profiles" });
    return listed.ok ? { ok: true, value: listed.value } : { ok: false, code: listed.code };
  };
  /**
   * The gateway a Web origin named for the host it serves, resolved against the configured connections. The Web UI
   * server owns that mapping (`HEPI_WEB_LOCAL_GATEWAY_ID`), because the host a browser is served from is a property of
   * the Web origin and not of this process: two origins can share one backend with a different local host each.
   */
  const webHostOf = (hostId: string | undefined): { ok: true; connection: GatewayConnection } | { ok: false; error: string } => {
    if (hostId === undefined) return { ok: false, error: WEB_HOST_REQUIRED };
    const connection = gateways.get(hostId);
    return connection === undefined
      ? { ok: false, error: "the Web UI server named gateway " + hostId + ", which this deployment does not configure" }
      : { ok: true, connection };
  };
  /**
   * The harness stores exactly what this backend decided. The states are passed through untouched: a caller that
   * omitted the default keeps the built-in scripted one, and an explicit "none" reaches the harness as none rather
   * than being folded back into a manufactured reference.
   */
  // The environment factory is always installed: a deployment that starts with no configured workspace has not decided
  // that it never has one. A project registered later through the public API is an ordinary target, and its
  // conversation has to reach the tools, so the emptiness of the workspace list at boot cannot stand in for the live
  // answer. The factory itself is still the authority for one request: a conversation bound to nothing resolves no
  // binding and gets no environment, with no fallback to another project's root.
  const runtime: ServerHarness = await openServerHarness(options.dbPath, options.defaultModel, options.models, async (target, context) => {
    const stored = await target.read.snapshot(WorkspaceDoc, target.conversationId, context);
    const binding = await ensureBinding(stored?.workspaceId);
    return binding ? gatewayEnvironment(binding, target.cwd ?? "/") : undefined;
  }, { ...options, startPaused: true });
  const conversations = createConversationAttachments({
    harness: runtime.harness, rootId: runtime.root.id, installed: () => installed(),
    prepare: id => adoptMcpOffer(id),
    resources: options.workspaceResources === undefined ? undefined : id => resourceSummary(runtime.harness, id, BACKGROUND_CONTEXT),
  });
  // Committed reads for skill state: the Harness is the Session, so it reads documents without opening a commit.
  const readCommitted = runtime.harness;
  const getConversation = (id: string): ConversationRuntime | undefined => conversations.get(id);
  /**
   * The one creation and relation seam: every conversation-creating surface goes through it, so request dedupe, the
   * hepi-owned relations and the execution binding are written in one commit and the model tools of ticket 06 can share
   * the same entry instead of a second creation path.
   */
  const operations = createConversationOperations(runtime.harness);
  // The pending queue's per-item controls: one projection of the runtime's own inbox and two operations on one item.
  // They sit beside the whole-queue recall, which stays what it is — a recall returns the text to the composer, while
  // these decide one item's fate without touching the others.
  const items = createConversationItemOperations(runtime.harness);
  /**
   * The optional subagent extension, installed here — after the one creation seam exists, before the boot scan attaches
   * anything and before scheduling resumes — so its anchor task definition is registered by the time any task is
   * reserved. The port it is composed with is the backend's own objects, so the extension is a caller of the core, not a
   * second runtime; `selectionFor` and `catalogueEntry` are referenced lazily, and both exist long before a tool runs.
   * A refused install is named through the harness's own failure list instead of taking the backend down (spec D01, D15).
   */
  const subagentHost = createSubagentHost({
    operations,
    // The Web's own delegation route commits on the same harness every other operation does, so a browser dispatch
    // writes the same kind of record a model tool writes, on the same store and with no second writer.
    commit: (change) => runtime.harness.commit(change, BACKGROUND_CONTEXT),
    catalogue: (): readonly SubagentCatalogueRow[] => [...conversations.values()].filter(item => item.deletedAt() === undefined).map(item => catalogueEntry(item)),
    workspace: async (conversationId) => runtime.harness.snapshot(WorkspaceDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT).then(stored => stored?.workspaceId),
    // The preparation's branch point: the newest visible entry of the delegating conversation, read through the
    // conversation's own fork-aware context so a fork and a compaction start from the same position the runtime would
    // fork at (spec D11, D13).
    sourceEntry: async (conversationId) => {
      const conversation = await runtime.harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) return undefined;
      const view = await conversation.context(BACKGROUND_CONTEXT);
      const newest = view.entries.at(-1);
      return newest === undefined ? undefined : String(newest.id);
    },
    activeChildren: async (conversationId) => {
      const delegating = Number(conversationId) as ConversationId;
      // The child conversations this conversation's own tasks own: the native immutable edge, read as it is stored and
      // never copied into a counter. A delegation that has finished keeps its conversation and its anchor forever, so
      // the count below is of work, not of identities (spec D12).
      const children = new Map<string, string>();
      let conversationCursor: Cursor | undefined;
      do {
        const stored = await runtime.harness.commit(tx => tx.scanConversations({ ownerConversationId: delegating }, 100, conversationCursor), BACKGROUND_CONTEXT);
        for (const record of stored.items) if (record.owner !== undefined) children.set(String(record.id), String(record.owner.taskId));
        conversationCursor = stored.next;
      } while (conversationCursor !== undefined);
      if (children.size === 0) return 0;
      // A delegation is pending while its anchor has not admitted it yet, and active while its own conversation runs
      // live work. The permanent anchor is neither: it stays in an idle phase for the life of the child, so counting
      // non-terminal anchors would count every child that ever finished and refuse the next one forever.
      //
      // "Live work" is the native ordinary scope, not the presence of any live task: the anchor of a child is a live
      // background task of that child's conversation for as long as the child exists — and so is the anchor of every
      // branch a user takes from it — so a count that included background tasks would read a finished child as work
      // forever and refuse the next delegation. A task that is live and not background is exactly what an ordinary
      // stop of the child would reach.
      const admitting = new Set<string>();
      let anchorCursor: Cursor | undefined;
      do {
        const stored = await runtime.harness.commit(tx => tx.scanTasks({ conversationId: delegating, kind: SUBAGENT_ANCHOR_TASK }, 100, anchorCursor), BACKGROUND_CONTEXT);
        for (const record of stored.items) {
          const state = record.state;
          if (state.status === "terminal" || state.status === "completing") continue;
          if ((state.checkpoint as { phase?: string } | undefined)?.phase === "admit") admitting.add(String(record.id));
        }
        anchorCursor = stored.next;
      } while (anchorCursor !== undefined);
      const live = new Set((await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(task => !task.record.background).map(task => String(task.record.conversationId)));
      let active = 0;
      for (const [childId, anchorId] of children) if (admitting.has(anchorId) || live.has(childId)) active += 1;
      return active;
    },
    definitionHost: (workspaceId) => {
      const binding = registry.bindingOf(workspaceId);
      return binding === undefined ? undefined : { gatewayId: binding.gatewayId, workspaceId: binding.id, env: gatewayEnvironment(binding, "/") as ExecutionHostEnv };
    },
    childExtensions: (workspaceId) => selectionFor(workspaceId, [SUBAGENT_EXTENSION]),
    readDispatch: (conversationId, requestId) => runtime.harness.snapshot(DispatchDoc, Number(conversationId) as ConversationId, requestId, BACKGROUND_CONTEXT),
    // The retry is one write to the extension's own document, which is the record the parked anchor watches: it names
    // the failed attempt's own task, so asking twice is asking once and the anchor wakes on durable state (spec D11).
    retryPreparation: (conversationId, requestId, failedTaskId) => runtime.harness.commit(async (tx) => {
      const record = await tx.doc(DispatchDoc, Number(conversationId) as ConversationId, requestId, null);
      record.preparationRetriedTaskId = failedTaskId;
    }, BACKGROUND_CONTEXT),
    models: runtime.models,
    defaultModel: runtime.model,
    defaultThinkingLevel: options.defaultThinkingLevel,
  });
  // One delegation seam, shared: the extension's two delegating tools and the backend's own delegation route are the
  // same business operation over the same host port, so a browser's quick create and a model's agent_spawn cannot
  // disagree about what a delegation is (spec D01, D15).
  const delegation = createSubagentDelegation(subagentHost);
  const subagents = createSubagentExtension(subagentHost, delegation);
  runtime.install(subagents);
  /**
   * The Gateway MCP bridge, installed for **every** backend that configures a gateway (tickets 02 and 03b).
   *
   * A tool's identity is a gateway, a server and a tool — three names, and nothing else: no command, no environment, no
   * URL and no credential, because the host owns those and reads them from its own files. A gateway this deployment does
   * not configure is dropped from the operator's fallback declarations, so a declaration can never route a call to a
   * host the operator did not name.
   *
   * `HEPI_MCP_TOOLS` is the **operator's fallback**, not a ceiling: it states identities and presentation for a
   * deployment that does not want to ask a host what its servers hold, and it changes nothing about what a conversation
   * may be granted. What a person may grant comes from the Gateway's own listing of a configured server (03a), and what
   * a conversation is offered comes from its own grants. An unset variable therefore declares no fallback and disables
   * nothing — which is the role the approved ticket keeps for it.
   *
   * The conversation's host is resolved **at call time** from its own durable workspace binding, through the same
   * resolution every other host call uses: a conversation bound to no execution workspace has no host to run on, and a
   * project folder is re-registered on its gateway first, exactly as an execution or a worktree call does, so the host
   * resolves the workspace id it is sent against a folder it actually serves. Its grants are read at that same moment,
   * from its own durable document, so a revoked tool is refused on the next call rather than at the next restart, and a
   * tool that was never granted is refused before the host is addressed at all.
   */
  const mcp = gateways.size === 0
    ? undefined
    : createMcpToolBridge({
      declarations: (options.mcpTools ?? []).filter(declaration => gateways.has(declaration.gatewayId)),
      target: async (conversationId, context) => {
        const stored = await runtime.harness.snapshot(WorkspaceDoc, Number(conversationId) as ConversationId, context);
        const binding = await ensureBinding(stored?.workspaceId);
        return binding === undefined ? undefined : { gatewayId: binding.gatewayId, workspaceId: binding.id };
      },
      invoke: async (gatewayId, request, invokeOptions) => {
        const connection = gateways.get(gatewayId);
        if (connection === undefined) throw new HostTransportError("gateway_offline", "the gateway " + gatewayId + " this MCP tool belongs to is not configured");
        return await clientOf(connection).control.invoke(request, invokeOptions);
      },
      // The conversation's own grants, read from its durable document at the moment a call asks: nothing is cached here,
      // and nothing is inferred from what a deployment declared or from what another conversation holds.
      selection: async (conversationId, context) => mcpGrantSelection((await readMcpGrants(runtime.harness, conversationId, context)).grants),
    });
  if (mcp !== undefined) runtime.install(mcp.extension);
  /**
   * The execution host one conversation would run a granted tool on, resolved exactly as a call resolves it.
   *
   * A grant is written against a host, and a listing is asked of one, so both must be answered by the same resolution a
   * call uses — the conversation's own durable workspace binding through the one binding resolver, with a project folder
   * re-registered first. Otherwise a route could grant tools of a gateway the conversation cannot reach.
   */
  const mcpConversationHost = async (conversationId: string): Promise<McpCallTarget | undefined> => {
    if (mcp === undefined) return undefined;
    // The field is read inside the commit: a document a transaction returned is a live overlay that is settled when the
    // commit ends, so reading it afterwards is not a committed read but a use of a closed one.
    const workspaceId = await runtime.harness.commit(async tx => (await tx.doc(WorkspaceDoc, Number(conversationId) as ConversationId)).workspaceId, BACKGROUND_CONTEXT);
    const binding = await ensureBinding(workspaceId);
    return binding === undefined ? undefined : { gatewayId: binding.gatewayId, workspaceId: binding.id };
  };
  /** Why a listing or a grant wrote nothing, with the status a browser-facing route answers it with. */
  type McpHostRefusal = { readonly ok: false; readonly code: string; readonly error: string; readonly status: number };
  /**
   * Which of the host's two config files an entry of this name lives in, as the host itself says.
   *
   * A listing is folder- and scope-scoped (`packages/gateway/src/mcp/host.ts`), and the host is the only authority on
   * whether an entry is global or belongs to this conversation's project — a project entry of an untrusted folder is
   * refused there, and the same name in the global file is not. So a grant or a listing asks for the read it already
   * made for the panel and lists the scope the entry was found in, rather than guessing one and reporting the host's
   * "no such server" as a person's mistake.
   */
  const mcpServerScope = async (host: McpCallTarget, server: string): Promise<{ readonly ok: true; readonly scope: "global" | "project" } | McpHostRefusal> => {
    const connection = gateways.get(host.gatewayId);
    if (connection === undefined) return { ok: false, code: "gateway_offline", error: "the gateway " + host.gatewayId + " this server belongs to is not configured", status: 503 };
    let answer;
    try {
      answer = await clientOf(connection).control.mcp({ operation: "read", workspaceId: host.workspaceId });
    } catch (error) {
      const failure = hostTransportAnswer(error, false);
      return { ok: false, code: failure.code, error: failure.message ?? "the execution host could not be reached for the listing", status: failure.status };
    }
    if (!answer.ok) {
      const auth = answer.code === "needs-auth" || answer.code === "not-authorized";
      return { ok: false, code: answer.code, error: answer.message, status: auth ? 403 : answer.code === "invalid_request" ? 400 : 409 };
    }
    const read = mcpConfigReadOf(answer.value);
    if (read === undefined) return { ok: false, code: "protocol_error", error: "the host answered the configuration read with something that is not a read", status: 502 };
    // A project entry shadows a global one of the same name for a conversation running in that folder, which is how the
    // host's own loader resolves them, so the same order decides here.
    const found = read.servers.find(entry => entry.name === server && entry.scope === "project") ?? read.servers.find(entry => entry.name === server);
    if (found === undefined) return { ok: false, code: "server-missing", error: "the host configures no MCP server named " + server + " for this conversation's folder, so nothing can be listed or granted of it", status: 409 };
    return { ok: true, scope: found.scope };
  };
  /**
   * One server's tools as its own host lists them — asked of the host, never of this deployment's environment.
   *
   * This is the only way this backend asks a host what a server holds, and it is reached only by a deliberate act: a
   * person asking what one named server's tools are, or a grant write that needs the host's own words for a tool it is
   * about to offer. An ordinary state read never starts a server to ask. The answer is the host's bounded, masked
   * listing (03a) — so a granted tool's description and argument shape are the host's text and never a client's. A
   * listing changes nothing on the host, which is why a lost answer is a fault to retry rather than an unknown outcome.
   */
  const mcpListedServer = async (conversationId: string, server: string): Promise<{ readonly ok: true; readonly gatewayId: string; readonly list: McpToolList } | McpHostRefusal> => {
    // One host resolution for the whole request: the folder is registered once, and the scope and the listing are
    // answered against the same binding a call would use.
    const host = await mcpConversationHost(conversationId);
    if (host === undefined) {
      return { ok: false, code: "host_unavailable", error: "this conversation is bound to no execution workspace, so no MCP server of it can be listed", status: 409 };
    }
    const scope = await mcpServerScope(host, server);
    if (!scope.ok) return scope;
    const connection = gateways.get(host.gatewayId)!;
    let answer;
    try {
      answer = await clientOf(connection).control.mcp({ operation: "tools", scope: scope.scope, workspaceId: host.workspaceId, name: server });
    } catch (error) {
      const failure = hostTransportAnswer(error, false);
      return { ok: false, code: failure.code, error: failure.message ?? "the execution host could not be reached for the listing", status: failure.status };
    }
    if (!answer.ok) {
      const auth = answer.code === "needs-auth" || answer.code === "not-authorized";
      return { ok: false, code: answer.code, error: answer.message, status: auth ? 403 : answer.code === "invalid_request" ? 400 : 409 };
    }
    const list = mcpToolListOf(answer.value);
    if (list === undefined) return { ok: false, code: "protocol_error", error: "the host answered the listing with something that is not a tool list", status: 502 };
    return { ok: true, gatewayId: host.gatewayId, list };
  };
  /**
   * What the selection seam answers about one conversation's MCP tools: its grants, and the offer the runtime resolves.
   *
   * The two stay separate because they are two facts: the grants are the person's own durable list, carrying the host's
   * published words for each tool as they stood at that moment; the offered names are the runtime's own resolution of
   * the conversation's agent, asked now rather than read out of the projection, so a surface sees what a call would
   * actually meet. The servers named here are the ones the **host** has entries for, read from its own configuration
   * files rather than from this deployment's environment, so this is what a panel shows before anything is granted: it
   * asks the host to read a file and starts no server.
   */
  const mcpGrantAnswer = async (item: ConversationRuntime, conversationId: string, offered: readonly string[]): Promise<Record<string, unknown>> => {
    const snapshot = item.snapshot();
    const gatewayId = registry.resolve(snapshot.workspaceId)?.gatewayId;
    const { grants } = await readMcpGrants(runtime.harness, conversationId, BACKGROUND_CONTEXT);
    const configured = await mcpHostServers(conversationId);
    return {
      conversationId,
      ...(gatewayId === undefined ? {} : { gatewayId }),
      workspaceId: snapshot.workspaceId,
      selected: snapshot.extensions.includes(MCP_EXTENSION),
      servers: configured.servers,
      // Whether the host answered that read at all. An empty list with `serversKnown: true` is the host stating it
      // configures nothing; `false` is this process never having been told, which a panel must not present as a "no".
      serversKnown: configured.known,
      ...(configured.refusal === undefined ? {} : { serversRefusal: configured.refusal }),
      grants,
      offered: offered.filter(name => name.startsWith(MCP_TOOL_PREFIX)),
    };
  };
  /**
   * The servers this conversation's host has configured, and how each reads: from the host's own files, no connect.
   *
   * `read` is the one operation that describes an entry from the file without starting anything, and it answers both
   * scopes of the folder at once (`packages/gateway/src/mcp/host.ts` → `readMcpConfig`), which is what keeps a settings
   * panel instant. A host that cannot be asked answers **no configuration and a named reason** rather than an empty
   * list, because "this host configures nothing" and "this process never saw the file" are different sentences: a
   * surface that collapsed them would hide a conversation's own grants behind a host that happens to be offline, and
   * would state a "no" it was never told.
   */
  const mcpHostServers = async (conversationId: string): Promise<{
    readonly servers: readonly { readonly server: string; readonly scope: string; readonly enabled: boolean; readonly exposure?: string }[];
    readonly known: boolean;
    readonly refusal?: { readonly code: string; readonly error: string };
  }> => {
    const unknown = (code: string, error: string) => ({ servers: [], known: false, refusal: { code, error } });
    const host = await mcpConversationHost(conversationId);
    if (host === undefined) return unknown("host_unavailable", "this conversation is bound to no execution workspace, so no host configuration of it can be read");
    const connection = gateways.get(host.gatewayId);
    if (connection === undefined) return unknown("gateway_offline", "the gateway " + host.gatewayId + " this conversation's host belongs to is not configured, so its configuration was not read");
    let answer;
    try {
      answer = await clientOf(connection).control.mcp({ operation: "read", workspaceId: host.workspaceId });
    } catch (error) {
      const failure = hostTransportAnswer(error, false);
      return unknown(failure.code, failure.message ?? "the execution host could not be reached to read its configuration");
    }
    if (!answer.ok) return unknown(answer.code, answer.message);
    const read = mcpConfigReadOf(answer.value);
    if (read === undefined) return unknown("protocol_error", "the host answered the configuration read with something that is not a read");
    return {
      known: true,
      servers: read.servers.map(server => ({
        server: server.name,
        scope: server.scope,
        enabled: server.enabled,
        ...(server.exposure === undefined ? {} : { exposure: server.exposure }),
      })),
    };
  };
  /**
   * Write one conversation's grants for one server, from the host's own listing of it.
   *
   * The host's listing is the only source of a granted tool's description and argument shape, so a grant asks the host
   * what the server holds and refuses a name it did not list: a tool the host does not have would be an offer the host
   * then refuses at every call. Nothing here consults `HEPI_MCP_TOOLS` for permission — a declared entry is a fallback
   * presentation, and a host-listed tool needs no declaration to be grantable.
   *
   * An empty tool list revokes every grant of that server without asking the host anything: revoking is this backend
   * taking an offer away, and it must work on a host that is offline. The write itself is the one writer that keeps the
   * grant document and `pi.agent.modelTools` in step, so a read after it states the offer, not just the list.
   */
  const writeMcpConversationGrants = async (
    conversationId: string,
    server: string,
    tools: readonly string[],
  ): Promise<McpHostRefusal | undefined> => {
    if (tools.length === 0) {
      await writeMcpGrants(runtime.harness, conversationId, server, [], BACKGROUND_CONTEXT);
      return undefined;
    }
    const listed = await mcpListedServer(conversationId, server);
    if (!listed.ok) return listed;
    // The listing is the whole allowlist of names this conversation may be granted of this server, and one source: a
    // name the host did not list is refused rather than written down to be refused at every call.
    const { entries, missing } = grantEntriesOf(listed.list, listed.gatewayId, tools);
    if (missing.length > 0) {
      return { ok: false, code: "not_listed", error: "the host lists no tool " + missing.join(", ") + " on server " + server + ", so a call there would be refused", status: 409 };
    }
    // Whether this process can register them is asked **before** the write, because the write commits the grant and the
    // offer together: a grant this process could not register would be answered 200 and offer nothing, which is the one
    // answer a person must never be given about their own act. Nothing is written when the answer is no.
    const admitted = mcp?.admits(entries);
    if (admitted !== undefined && !admitted.ok) {
      return { ok: false, code: "offer_unavailable", error: "this backend cannot offer " + tools.join(", ") + " of server " + server + ": " + admitted.reason + ", so nothing was granted", status: 409 };
    }
    await writeMcpGrants(runtime.harness, conversationId, server, entries, BACKGROUND_CONTEXT);
    // The host's fresh words become this process's offer for those identities at once, so the description a model reads
    // and the schema its arguments are checked against are the ones the grant was written from, not the ones a
    // deployment happened to declare at startup. A re-grant after the server changed its schema therefore takes effect
    // on the next resolution rather than the next restart.
    mcp?.stage(entries);
    return undefined;
  };
  /**
   * Adopt one conversation's stored offer to its own durable grants.
   *
   * This is the second half of the one writer `pi.agent.modelTools` has for MCP tools (the first is the grant route),
   * and it runs wherever a stored offer could have arrived from somewhere other than this conversation's own grants: a
   * boot, where the durable grants are the only statement of what a restarted backend should offer, and a fork or a copy,
   * which inherits the source's agent document and none of its grants. A branch therefore loses the source's granted names
   * from its filter, which makes `a grant is a person's act` a fact of the store rather than a hope about a surface.
   * Nothing here asks a host anything: an adoption reads one document and writes one field.
   */
  const adoptMcpOffer = async (conversationId: string): Promise<void> => {
    if (mcp === undefined) return;
    const { grants, keys } = await readMcpGrants(runtime.harness, conversationId, BACKGROUND_CONTEXT);
    // The stored descriptors are this process's presentation for those identities from here on, including after a
    // restart, which never asks a host what a server holds. A tool no grant states keeps whatever the operator declared
    // for it, and a name nothing offers stays out of every conversation's offer.
    mcp.stage(grants);
    await reconcileMcpOffer(runtime.harness, conversationId, keys, BACKGROUND_CONTEXT);
  };
  /** The installed extensions and their own tools, in install order, from the runtime's registry. The one authority. */
  const installed = (): InstalledExtension[] => runtime.registry.snapshot().installed().map(extension => ({
    name: extension.name,
    tools: (extension.tools ?? []).map(tool => tool.name),
    // Which of them the runtime withholds until a conversation's own offer names one. This is what lets a snapshot
    // state the tools a conversation was granted instead of every tool its extensions could offer.
    deferred: (extension.tools ?? []).filter(tool => tool.deferred === true).map(tool => tool.name),
  }));
  const installedExtensions = (): string[] => installed().map(extension => extension.name);
  /**
   * Delegation is installed but never enabled by default. Its task definitions resolve for every task whatever a
   * conversation selects, so a recovered anchor is resumable either way; the model tools, though, are a capability a
   * deployment turns on per conversation (or as its global default), which is what keeps ordinary chat unchanged and
   * keeps "delegation is off" a state a user can actually reach (spec D15, A01). An explicit selection that names it is
   * still honoured, so the switch works in both directions.
   */
  const optionalExtensions: readonly string[] = [SUBAGENT_EXTENSION, ...(mcp === undefined ? [] : [MCP_EXTENSION])];
  const defaultSelectable = (): string[] => installedExtensions().filter(name => !optionalExtensions.includes(name));
  /**
   * The stored global default, read once at startup and kept current from this process's own commit stream, so the
   * inventory and a conversation's creation read one value and a write is visible to the next request without a
   * document read per request. It is the same read-then-watch pattern the catalogue's title uses.
   */
  let storedDefault: readonly string[] | undefined = await readDefaultSelection(runtime.harness);
  runtime.harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== ExtensionSelectionDoc.definition.kind) continue;
      storedDefault = change.value === null ? undefined : (change.value as { extensions?: string[] }).extensions;
    }
  });
  /**
   * The extensions a conversation selects when it is created: the resolved global default less the environment-backed
   * extensions it has no execution workspace for. The names are written into the conversation's own `pi.agent` in the
   * same commit that creates it, which is what makes the selection explicit state rather than a reading of the default:
   * a later change to the default cannot move it.
   */
  const selectionFor = async (workspaceId: string | undefined, withheld: readonly string[] = []): Promise<Extension[]> => {
    const snapshot = runtime.registry.snapshot();
    // A conversation bound to no execution workspace can run neither a coding tool nor a child, so both are withheld
    // from it outright; everything else the caller withheld — a child does not delegate in turn — is dropped the same way.
    // The stored default resolves against every installed extension, so an explicit default naming the optional one
    // is honoured; when none was ever stored the fallback is the selectable set, which keeps the optional extension
    // off until a deployment turns it on. A conversation bound to no execution workspace withholds both, and a child
    // withholds delegation whatever the default says.
    const names = materializeSelection(installedExtensions(), storedDefault ?? defaultSelectable(), [...(workspaceId === undefined ? [ENVIRONMENT_EXTENSION, SUBAGENT_EXTENSION, MCP_EXTENSION] : []), ...withheld]);
    return names.map(name => snapshot.extension(name)!);
  };
  /**
   * The stored selection a request asked to write, refused as a whole when it names an extension this backend does not
   * have or one this conversation cannot use. Nothing is partially applied: a request that names one good and one
   * unknown extension writes neither, so the selection a client reads back is the one it asked for or the one it had.
   */
  const requestedSelection = (body: unknown, workspaceBound: boolean): { ok: true; names: string[]; extensions: Extension[] } | { ok: false; status: number; code: string; error: string } => {
    const names = extensionNameList((body as { extensions?: unknown } | undefined)?.extensions);
    if (names === undefined) return { ok: false, status: 400, code: "invalid_request", error: "extensions must be an array of extension names" };
    const snapshot = runtime.registry.snapshot();
    const unknown = names.filter(name => snapshot.extension(name) === undefined);
    if (unknown.length > 0) return { ok: false, status: 400, code: "unknown_extension", error: "no installed extension is named " + unknown.join(", ") };
    if (!workspaceBound && names.includes(ENVIRONMENT_EXTENSION)) {
      return { ok: false, status: 409, code: "unavailable_extension", error: ENVIRONMENT_EXTENSION + " needs an execution workspace, and this conversation is bound to none" };
    }
    // MCP tools run on the conversation's execution host, so an unbound conversation cannot select them either: an
    // offer it could not run would be refused at the call, which is a worse answer than a refusal at the selection.
    if (!workspaceBound && names.includes(MCP_EXTENSION)) {
      return { ok: false, status: 409, code: "unavailable_extension", error: MCP_EXTENSION + " needs an execution workspace, and this conversation is bound to none" };
    }
    return { ok: true, names, extensions: names.map(name => snapshot.extension(name)!) };
  };
  /**
   * The installed extensions as a client reads them: the runtime's own registry, each entry's own tools and sections,
   * whether the global default selects it, and the global default itself. A client is told the tools an extension
   * offers so it can show what enabling it would add, and the default is resolved against what is installed, so a name
   * that is no longer installed is not reported as selected.
   */
  const extensionInventory = (): { protocol: typeof PROTOCOL_VERSION; installed: { name: string; tools: string[]; sections: string[]; enabled: boolean }[]; default: string[]; failures: readonly ExtensionInstallFailure[]; } => {
    // The stored default is resolved against every installed extension — the same set the write was validated
    // against — so an explicit default that names the optional extension is honoured instead of silently dropped. The
    // fallback, when no default was ever stored, is the selectable set, which is what keeps the optional extension off
    // until a deployment turns it on.
    const defaultNames = resolveDefaultSelection(installedExtensions(), storedDefault ?? defaultSelectable());
    return {
      protocol: PROTOCOL_VERSION,
      installed: runtime.registry.snapshot().installed().map(extension => ({ name: extension.name, tools: (extension.tools ?? []).map(tool => tool.name), sections: (extension.sections ?? []).map(section => section.key), enabled: defaultNames.includes(extension.name) })),
      default: defaultNames,
      failures: runtime.failures,
    };
  };
  const attach = conversations.attach;
  /**
   * The two facts a status needs that are not in a conversation's own published snapshot, read **once** for a whole
   * catalogue rather than once per row: the live tasks, from the runtime's own inspection, and the child conversations
   * whose delegated result is sitting queued in their creator's inbox, which the creators' own snapshots already state.
   *
   * Neither is a second scheduler and neither is a per-row read: the inspection is one call for the whole list, and the
   * waiting reports are collected from snapshots this backend already holds.
   */
  const NO_FACTS: CatalogueFacts = { tasks: new Map(), waitingReports: new Set() };
  const catalogueFacts = async (): Promise<CatalogueFacts> => {
    const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
    const tasks = new Map<string, TaskInspection[]>();
    for (const task of inspection.tasks) {
      const id = String(task.record.conversationId);
      const list = tasks.get(id);
      if (list === undefined) tasks.set(id, [task]);
      else list.push(task);
    }
    const waitingReports = new Set<string>();
    for (const item of conversations.values()) {
      if (item.deletedAt() !== undefined) continue;
      for (const queued of item.snapshot().queuedItems) {
        if (queued.source.kind === "report") waitingReports.add(queued.source.childConversationId);
      }
    }
    return { tasks, waitingReports };
  };

  /**
   * One conversation's catalogue row: the single read the session list and the running poll are both built from. The
   * fork route answers the same row for its new conversation, so the row a caller is handed and the row the next list
   * read shows cannot be two different things.
   */
  const catalogueEntry = (item: ConversationRuntime, facts: CatalogueFacts = NO_FACTS): CatalogueEntry => {
    const current = item.snapshot();
    const workspace = registry.catalogueOf(current.workspaceId);
    const stats = item.catalogueStats();
    // A fork is told apart from its source by this relation, so it is reported only while the source is still listed:
    // a removed source leaves a row that reports no parent, which is what keeps a removed conversation from being
    // named by a surface after it is gone. The immutable record keeps the ancestry either way.
    const parent = item.parentConversationId === undefined ? undefined : getConversation(item.parentConversationId);
    const parentConversationId = parent === undefined || parent.deletedAt() !== undefined ? undefined : item.parentConversationId;
    const lastRunEndedAt = item.lastRunEndedAt();
    // The display parent is stated even while it is tombstoned — unlike the fork source above — because a hidden parent
    // is a fact about the relation, not a reason to erase it: the child keeps its place and is not promoted, and a
    // surface that could not see the edge would show an independent conversation.
    const relations = item.relations();
    const displayParentId = relations.displayParentId;
    const displayParentDeleted = displayParentId !== undefined && getConversation(displayParentId)?.deletedAt() !== undefined;
    return {
      id: String(item.conversation.id),
      workspaceId: current.workspaceId ?? null,
      // One resolution answers both fields: the row's `gatewayId` and its `workspace` facts are two statements about
      // the same binding, so a row that resolved it twice could state two different ones.
      gatewayId: workspace?.gatewayId ?? null,
      ...(workspace === undefined ? {} : { workspace }),
      busy: current.busy,
      extensions: current.extensions,
      runStatus: projectRunStatus({
        busy: current.busy,
        control: current.control,
        tasks: facts.tasks.get(String(item.conversation.id)) ?? [],
        waitingReport: facts.waitingReports.has(String(item.conversation.id)),
      }),
      revision: current.revision,
      messageCount: stats.count,
      firstMessage: stats.firstMessage,
      title: item.title() ?? null,
      ...(lastRunEndedAt === undefined ? {} : { lastRunEndedAt }),
      ...(parentConversationId === undefined ? {} : { parentConversationId }),
      ...(relations.createdBy === undefined ? {} : { createdBy: relations.createdBy }),
      ...(displayParentId === undefined ? {} : { displayParentId }),
      ...(displayParentDeleted ? { displayParentDeleted: true } : {}),
      // A user branch is a conversation of its own that happens to be task-owned by its own anchor, so its owner edge
      // is not the delegation edge the catalogue reports; a delegated child — whose provenance is the agent that asked
      // for it — keeps reporting its creator (spec D14).
      ...(item.subagentParentConversationId === undefined || relations.provenance?.origin === "user" ? {} : { subagentParentConversationId: item.subagentParentConversationId }),
    };
  };
  /**
   * One subtree request answered as the wire states it: each child's durable outcome beside **the row the session list
   * shows for it now**, from one shared facts read.
   *
   * The two halves answer two different questions and neither rewrites the other. `status` and `control` are what the
   * request recorded when it reached that child; `session` is the same projection `GET /api/conversations` gives, so a
   * caller polling one subtree operation sees a stop's drain settle, a child the user resumed on its own, a report that
   * arrived after the request, or a run a restart interrupted — without a second request per child, without a scheduler
   * of its own, and without the durable record being restated from the present (ticket 02). A child the catalogue does
   * not list — removed, or unknown to this process — states no row rather than an invented one: the removal is already
   * the outcome's own conflict, and a row would claim a surface shows a conversation that shows nothing.
   */
  const subtreeAnswer = async (controlled: SubtreeControlResult): Promise<SubtreeProjectedResult> => {
    const facts = await catalogueFacts();
    const outcomes = controlled.outcomes.map((outcome): SubtreeProjectedOutcome => {
      const item = getConversation(outcome.conversationId);
      if (item === undefined || item.deletedAt() !== undefined) return { ...outcome };
      return { ...outcome, session: catalogueEntry(item, facts) };
    });
    return { ...controlled, outcomes };
  };

  // The runtime's root conversation is a framework record, not a conversation a client created: it owns the work that
  // belongs to no conversation, every deployment has exactly one, and nothing in this backend submits to it. It is
  // therefore never attached, so it is in no catalogue, no search result and no conversation route, and the sidebar
  // cannot present it as a project of its own. Its record stays in the store; nothing here removes anything.
  try {
    await conversations.recover();
  } catch (error) {
    await conversations.close();
    await runtime.close();
    throw error;
  }
  runtime.harness.resume();
  // The installation orchestrator: the repository supplies content, the conversation's own workspace gateway publishes
  // it, and the initiating conversation is the only one asked to adopt the result.
  const installer = options.installer ?? (options.skillMarket === undefined ? undefined : createInstaller({
    market: options.skillMarket,
    workspaces: registry.targets,
    resources: options.workspaceResources,
    ensure: async (workspaceId) => { await ensureBinding(workspaceId); },
    boundWorkspace: async (conversationId) => getConversation(conversationId)?.snapshot().workspaceId,
    conversation: (conversationId) => getConversation(conversationId)?.conversation,
  }));
  const resourceEnvironment = async (item: ConversationRuntime): Promise<ExecutionHostEnv | undefined> => {
    const binding = await ensureBinding(item.snapshot().workspaceId);
    return binding ? gatewayEnvironment(binding, "/") as ExecutionHostEnv : undefined;
  };
  /**
   * The submission content of one input: the expanded text plus the images as native content blocks. A text-only
   * submission keeps the plain string shape it always had, so nothing about existing history or commands changes.
   */
  const submissionContent = async (item: ConversationRuntime, text: string, images: readonly SubmitImage[]): Promise<string | (TextContent | ImageContent)[]> => {
    const expanded = await expandInput(item, text);
    if (images.length === 0) return expanded;
    return [...(expanded.trim() ? [{ type: "text" as const, text: expanded }] : []), ...images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
  };
  /**
   * Why a submission carrying these images must be refused, or nothing when it may be admitted.
   *
   * An image the selected model cannot read would be replaced by the provider adapter's placeholder, so a submission
   * that carries one is refused with that reason instead of being silently downgraded. Only a model that exists and
   * declares no image input is refused: a selection the catalog no longer serves is not a statement about modality, so
   * the submission is admitted and the run reports the framework's own `no_model` failure. Every admission route that
   * takes images — an ordinary message, a resume's input and a queue-only steer or follow-up — asks this one question,
   * so a queued draft cannot be the one place an unreadable image is dropped.
   */
  const imageRefusal = (item: ConversationRuntime, images: readonly SubmitImage[]): { readonly code: string; readonly message: string } | undefined => {
    if (images.length === 0) return undefined;
    const selected = item.snapshot().settings.model;
    if (selected === null) return undefined;
    const model = runtime.models.getModel(selected.provider, selected.modelId);
    if (model === undefined || model.input.includes("image")) return undefined;
    return { code: "unsupported_model_images", message: selected.provider + "/" + selected.modelId + " does not accept image input; remove the attached images or select an image-capable model" };
  };
  const expandInput = async (item: ConversationRuntime, text: string) => {
    if (options.workspaceResources === undefined) return text;
    const env = await resourceEnvironment(item);
    // The adopted catalog decides expansion; a first-load failure blocks this run only, and an unexpanded command
    // falls through so the text is submitted unchanged. The run's prefix and catalog are fixed for its whole run:
    // `ensureAdoptedResources` only performs the first load, and a reload during an active run is deferred, so
    // steering and later rounds of this run expand against the catalog it adopted.
    const state = await ensureAdoptedResources(item.conversation, readCommitted, options.workspaceResources, env, BACKGROUND_CONTEXT);
    return options.workspaceResources.expand(state, env, text, BACKGROUND_CONTEXT);
  };
  // The terminal relay binds a routing cwd to the workspace it names and forwards to that host, reusing the binding
  // resolution every other host-facing route uses, so a project folder, a retained binding and a configured workspace
  // all reach the host that really owns them.
  const terminalRelay = createTerminalRelay({ binding: (workspaceId) => ensureBinding(workspaceId), readBody });
  // The file relay moves file bytes for the browser: an upload into a workspace folder, a pre-flight conflict check,
  // and a download or preview. It binds a routing cwd to its workspace exactly as the terminal relay does, so a
  // project folder, a retained binding and a configured workspace all reach the host that really owns them. The bytes
  // travel as a body, which is what the workbench proxy's JSON request could not carry above about 768 KiB.
  const fileRelay = createFileRelay({ binding: (workspaceId) => ensureBinding(workspaceId), readBody });
  /**
   * Execution Host agent definitions: the whole Markdown document is read and written on the workspace's own host, not
   * on the machine this backend runs on. The workspace binding is the authority on which host that is — a Project
   * folder records the host its folders were chosen on, and a configured workspace its gateway — so the remote profile
   * comes from the binding. A request may name the gateway it serves, and naming another one is refused rather than
   * redirected: a Web origin cannot manage definitions on a host it does not serve.
   */
  const agentDefinitions = createAgentDefinitionsHandler({
    readBody,
    resolveHost: async (hostId, workspaceId) => {
      const workspace = namedHostId(workspaceId);
      if (workspace === undefined) return { ok: false, status: 400, code: "invalid_request", error: "a workspaceId is required" };
      const binding = await ensureBinding(workspace);
      if (binding === undefined) return { ok: false, status: 404, code: "unknown_workspace", error: "this deployment binds no workspace " + workspace };
      const named = namedHostId(hostId);
      if (named !== undefined && named !== binding.gatewayId) return { ok: false, status: 409, code: "wrong_host", error: "the workspace " + workspace + " is on gateway " + binding.gatewayId + ", not " + named };
      return { ok: true, host: { gatewayId: binding.gatewayId, workspaceId: binding.id, env: gatewayEnvironment(binding, "/") } };
    },
  });
  /**
   * The execution host this Backend serves the caller of *this* request from, as the ingress that admitted it stated.
   *
   * Which computer a client is served from is the deployment's own fact, so the ingress states it as trusted
   * configuration on the request it already authenticated; the caller's own request never carries it. It is resolved
   * against the gateways this Backend was configured with, exactly like a host a caller named, so an id this deployment
   * does not know is answered with the same `configuration_required` refusal instead of a route to somewhere else.
   */
  const statedDefaultHost = (request: IncomingMessage): string | undefined => {
    const header = request.headers[DEFAULT_HOST_HEADER];
    return namedHostId(typeof header === "string" ? header : undefined);
  };
  /**
   * The host a host-scoped route acts on: the one the request named, or the one the ingress stated when it named none.
   *
   * A caller may still narrow a request to a host it knows — that is the existing `hostId` query and body field — but
   * it cannot substitute one for the deployment's default, because naming a host the deployment does not serve is
   * refused by the same resolution the stated one goes through.
   */
  const hostOfRequest = (request: IncomingMessage, named: string | undefined): string | undefined => named ?? statedDefaultHost(request);
  /**
   * The HTTP domain owners, composed once and dispatched in this fixed order. Each is a concrete handler over the
   * operations it uses — never a registry and never a shared context — so a route change touches its owner and this
   * wiring. Order is the entry's own: the pages and the descriptor before admission, the deployment's metadata and the
   * relays next, then the project routes and the catalogue, and the conversation-scoped domains last, because they
   * resolve a conversation identity first.
   */
  const pages = createDiagnosticsPages();
  const diagnostics = createDiagnosticsHttp({
    buildId: options.buildId,
    backendId: options.backendId ?? process.env.HEPI_BACKEND_ID ?? "hepi-backend",
    accountScope: options.accountScope ?? process.env.HEPI_ACCOUNT_SCOPE ?? "default",
    // The capabilities this build really has, stated from what the caller configured rather than from what a client
    // hopes for. A capability a deployment did not configure is absent, which is the honest answer a client can act on.
    capabilities: {
      conversations: true,
      projects: options.projects !== undefined,
      skillMarket: options.skillMarket !== undefined,
      modelConfiguration: options.modelConfig !== undefined,
      workspaceResources: options.workspaceResources !== undefined,
      deviceCredentials: options.deviceCredentials !== undefined,
    },
    deviceCredentials: options.deviceCredentials,
    readBody,
  });
  const workspaces = createWorkspaceHttp({
    bindings: registry.bindings,
    gateways: registry.connections,
    profiles: hostProfiles,
  });
  const settings = createSettingsHttp({
    conversation: getConversation,
    models: runtime.models,
    defaultModel: runtime.model,
    defaultThinkingLevel: options.defaultThinkingLevel,
    modelConfig: options.modelConfig,
    resources: options.workspaceResources,
    readCommitted,
    session: runtime.harness,
    resourceEnvironment,
    readBody,
  });
  const conversationHistory = createConversationHistoryHttp({ conversation: getConversation, read: operations, heartbeatIntervalMs });
  const conversationCommands = createConversationCommandHttp({
    conversation: getConversation,
    operations,
    items,
    delegation,
    subagentHost,
    harness: runtime.harness,
    models: runtime.models,
    stream: options.settings?.stream,
    attach,
    catalogueRow: async (attached) => catalogueEntry(attached, await catalogueFacts()),
    subtreeAnswer,
    submissionContent,
    imageRefusal,
    readBody,
  });
  const conversationExtensions = createConversationExtensionsHttp({
    conversation: getConversation,
    requestedSelection,
    listedServer: mcpListedServer,
    grantAnswer: mcpGrantAnswer,
    writeGrants: writeMcpConversationGrants,
    readBody,
  });

  const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => json(response, 500, { error: safeFailure(error) })); });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    // The operator pages answer before admission; everything below them is a client route that admission guards.
    if (await pages(request, response, url)) return;
    if (!authorized(request, options.authToken)) { json(response, 401, { error: "unauthorized" }); return; }
    // The diagnostics surface: the descriptor, the device credentials and the authority check the ingress asks. It is
    // composed here because it is what this build states about itself, and it answers nothing about a conversation.
    if (await diagnostics(request, response, url)) return;
    if (options.skillMarket !== undefined && url.pathname.startsWith("/api/skill-market/")) {
      // Repository and market browsing are decoupled from conversations: no conversation is touched or listed here.
      // Installation is the one exception, and it names the conversation it installs for: publication and that
      // conversation's adoption are separate outcomes, and no other conversation is touched.
      const method = request.method ?? "GET";
      if (method === "POST" && url.pathname === "/api/skill-market/install") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const parsed = installRequest(await readBody(request));
        if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "a bundle id, an execution target and a scope are required" } }); return; }
        const installed = await installer.install(parsed);
        json(response, installed.status, installed.body); return;
      }
      // Updating an installed skill and asking what an update would do both name the installed skill, so they share
      // one body shape: the initiating conversation, the scope, and the bundle to install in its place.
      if (method === "GET" && url.pathname === "/api/skill-market/installed") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const status = await installer.status({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined }, url.searchParams.get("name"), url.searchParams.get("scope"));
        json(response, status.status, status.body); return;
      }
      // The execution-side skill inventory of one workspace: what the host actually holds, with each installation's
      // provenance, baseline state and source-revision state. No conversation is needed, so browsing does not require
      // an active run; the workspace names the execution target explicitly.
      if (method === "GET" && url.pathname === "/api/skill-market/inventory") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const inventory = await installer.inventory({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined });
        json(response, inventory.status, inventory.body); return;
      }
      // What one installed skill's source revision is. Asked for explicitly, so browsing a host's skills lists them
      // without reaching the repository: only this request resolves a current commit.
      if (method === "GET" && url.pathname === "/api/skill-market/check") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const checked = await installer.check({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined }, url.searchParams.get("name"), url.searchParams.get("scope"));
        json(response, checked.status, checked.body); return;
      }
      // Switching one or many installed skills' model-invocation key. Each directory is answered on its own, so a
      // refusal applies to that directory alone; the edit is written on the execution host, never on this one.
      if (method === "PATCH" && url.pathname === "/api/skill-market/skills") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const parsed = toggleRequest(await readBody(request));
        if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "an execution target, a scope, at least one skill directory and the state to switch to are required" } }); return; }
        const toggled = await installer.toggle(parsed);
        json(response, toggled.status, toggled.body); return;
      }
      if (method === "POST" && url.pathname === "/api/skill-market/update") {
        if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return; }
        const parsed = updateRequest(await readBody(request));
        if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "a bundle id, installed skill name, execution target and scope are required" } }); return; }
        const updated = await installer.update(parsed);
        json(response, updated.status, updated.body); return;
      }
      const result = await skillMarketRoute(options.skillMarket, method, url.pathname, url.searchParams, method === "POST" ? await readBody(request) : undefined);
      if (result === undefined) { json(response, 404, { error: "not found" }); return; }
      json(response, result.status, result.body); return;
    }
    // The browser's terminal reaches the conversation's execution host through here. The relay resolves the routing
    // cwd the caller names to a binding on every request, so it keeps no session state of its own and a backend restart
    // loses no shell. A cwd that names no workspace, and a deployment that serves no terminal host, are named outcomes.
    if (url.pathname === "/api/terminal" || url.pathname.startsWith("/api/terminal/")) {
      if (await terminalRelay(request, response, url)) return;
    }
    // The browser's file bytes reach the same execution host through here. The three payload routes are its own, so the
    // read-only workbench proxy below is untouched: it keeps answering the JSON operations it always did.
    if (url.pathname === "/api/files/upload" || url.pathname === "/api/files/upload-check" || url.pathname === "/api/files/bytes") {
      if (await fileRelay(request, response, url)) return;
    }
    // The deployment's execution targets: the workspaces it binds and the gateways it configured. Both are metadata,
    // and a workspace's account is the host's own answer rather than this process's identity.
    if (await workspaces(request, response, url)) return;
    // The directories of the host named on the request, so a folder can be chosen on the computer that serves this Web
    // origin or on a configured remote host. Browsing is that host's own read-only listing: the backend never reads a
    // directory and never substitutes its own account, and the profile is passed through so the listing is the
    // remote host's, not the profile's configured root served locally.
    if (request.method === "GET" && url.pathname === "/api/host/directories") {
      const host = webHostOf(hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!host.ok) { json(response, 409, { code: "configuration_required", error: host.error }); return; }
      const requested = url.searchParams.get("path");
      const profileId = namedHostId(url.searchParams.get("profileId"));
      const browsed = await hostRequest(host.connection, { operation: "browse", ...(requested === null ? {} : { path: requested }), ...(profileId === undefined ? {} : { profileId }) });
      if (!browsed.ok) { json(response, browsed.status, { code: browsed.code, error: "the Web host could not list that folder: " + browsed.code }); return; }
      json(response, 200, browsed.value); return;
    }
    // The recorded projects, each with the account of the host its folders live on. Listing is metadata for every
    // project — every folder, and which one is the default — but the account is resolved only for the host the calling
    // Web origin named: another host's projects are reported as belonging to that host instead of showing this origin
    // an account it does not serve.
    if (request.method === "GET" && url.pathname === "/api/projects") {
      const hostId = hostOfRequest(request, namedHostId(url.searchParams.get("hostId")));
      const listed = await Promise.all(registry.projects().map(async (project) => {
        if (project.hostId !== hostId) return { ...projectView(project), hostError: "this project's folders are on gateway " + project.hostId + ", which this Web origin does not serve" };
        // The account is the host's, and any folder of the project answers for it: they are all on that one host.
        const firstFolder = project.folders[0];
        const binding = firstFolder === undefined ? undefined : registry.bindingOfFolder(project, firstFolder);
        if (binding === undefined) return { ...projectView(project), hostError: "the configured gateway " + project.hostId + " is not available" };
        const result = await (gatewayEnvironment(binding, "/") as ExecutionHostEnv).executionHost(BACKGROUND_CONTEXT);
        return result.ok ? { ...projectView(project), host: { user: result.value.user, home: result.value.home } } : { ...projectView(project), hostError: boundedMessage(result.error.message) };
      }));
      json(response, 200, { protocol: PROTOCOL_VERSION, projects: listed }); return;
    }
    // Creating a project records its identity, display name and the folders chosen on one computer, exactly one of
    // which is its default. Every folder must already exist on the Web host: the gateway validates and canonicalizes
    // each one, and nothing here creates or renames a directory. The request names one host, so a project can never
    // combine folders of two computers; a folder that is not a directory on that host fails the whole request, and no
    // project is recorded until every folder has been accepted.
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const body = await readBody(request) as { name?: unknown; folders?: unknown; hostId?: unknown; profileId?: unknown } | undefined;
      const folders = Array.isArray(body?.folders) ? body.folders.map(entry => { const folder = entry as { root?: unknown; default?: unknown }; return { root: typeof folder.root === "string" ? folder.root : "", isDefault: folder.default === true }; }) : undefined;
      if (folders === undefined) { json(response, 400, { code: "invalid_request", error: "at least one folder on the Web host is required" }); return; }
      const profileId = typeof body?.profileId === "string" && body.profileId.trim() !== "" ? body.profileId.trim() : undefined;
      // The registry owns the whole creation: the host identity, the profile's validation, every folder's registration
      // before anything is recorded, the Project row, the live snapshot it publishes and the revision — a route that
      // wrote any of those itself could publish a Project no lookup resolves, or resolve one no store holds.
      let created: ProjectMutation<ProjectRecord>;
      try {
        created = await registry.create({ name: typeof body?.name === "string" ? body.name : "", folders, ...(profileId === undefined ? {} : { profileId }) }, hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      } catch (error) { json(response, 500, { error: safeFailure(error) }); return; }
      if (!created.ok) { json(response, created.status, { ...(created.code === undefined ? {} : { code: created.code }), error: created.error }); return; }
      json(response, 201, { protocol: PROTOCOL_VERSION, project: projectView(created.value) }); return;
    }
    // Naming another of a project's own folders the default: new conversations bind it from then on, while every
    // conversation already bound keeps the folder it has. This is the metadata contract ticket 08 defines; no editor
    // for it is part of this phase.
    if (request.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      const body = await readBody(request) as { hostId?: unknown; defaultFolderId?: unknown } | undefined;
      // The recorded Project names its host; a named one may only confirm it. Naming a remote Project's own host is what
      // a Web origin does when it edits a folder there, and it stays accepted.
      const changed = registry.setDefault(projectId, typeof body?.defaultFolderId === "string" ? body.defaultFolderId : "", hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      if (!changed.ok) { json(response, changed.status, { ...(changed.code === undefined ? {} : { code: changed.code }), error: changed.error }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(changed.value) }); return;
    }
    // Unlinking one folder of a project: the folder's own operation, separate from the default selector. A non-default
    // folder goes on its own and the project's default is unchanged. The default folder may only go when the request
    // names another folder of the same project as the replacement in this same call, so no project is ever left
    // without a default. The last folder's removal removes the project record in the same transaction, so no request
    // ever reads a project with no folders. Like a project removal this is metadata only — no directory is created,
    // changed or deleted, no conversation is deleted, no workspace id is reused, no host registration is undone — and
    // it writes the same retained binding for the folder that left, which is what keeps a conversation already bound
    // to it executing while the folder is never a target for a new conversation again.
    if (request.method === "DELETE" && folderUnlinkPath.test(url.pathname)) {
      const [, projectId, folderId] = folderUnlinkPath.exec(url.pathname)!;
      const unlinked = registry.unlink(decodeURIComponent(projectId!), decodeURIComponent(folderId!), namedHostId(url.searchParams.get("defaultFolderId")), hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!unlinked.ok) { json(response, unlinked.status, { ...(unlinked.code === undefined ? {} : { code: unlinked.code }), error: unlinked.error }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: unlinked.value.project === null ? null : projectView(unlinked.value.project), removedFolderId: unlinked.value.removedFolderId }); return;
    }
    // Removing a project removes metadata only: the project record and its folder links go, in one transaction with
    // the retained binding of every folder, and nothing else changes. No directory on the host is created, changed or
    // deleted, no conversation is deleted, no workspace id is reused and no host registration is undone. Nothing is
    // refused because conversations are bound — no conversation is read here at all — and the retained bindings keep
    // the removed folders resolvable for the conversations that already hold them while never becoming a target for a
    // new one.
    if (request.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
      const removed = registry.remove(decodeURIComponent(url.pathname.slice("/api/projects/".length)), hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!removed.ok) { json(response, removed.status, { ...(removed.code === undefined ? {} : { code: removed.code }), error: removed.error }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(removed.value) }); return;
    }
    if (request.method === "POST" && url.pathname === "/api/worktrees") {
      const body = await readBody(request) as { workspaceId?: unknown; operation?: unknown; branch?: unknown; path?: unknown; force?: unknown } | undefined;
      const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
      const operation = typeof body?.operation === "string" ? body.operation : "";
      const result = operation === "list" ? await registry.listCheckouts(workspaceId)
        : operation === "create" ? await registry.createCheckout(workspaceId, typeof body?.branch === "string" ? body.branch : "")
        : operation === "remove" ? await registry.removeCheckout(workspaceId, typeof body?.path === "string" ? body.path : "", body?.force === true)
        : { ok: false as const, status: 400, code: "invalid_request", error: "unknown worktree operation" };
      if (result.ok) json(response, 200, { ok: true, value: result.value });
      else { const { status, ...body } = result; json(response, status, body); }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/workbench") {
      const body = await readBody(request) as { workspaceId?: string; operation?: string; path?: string } | undefined;
      const binding = await ensureBinding(body?.workspaceId);
      if (binding === undefined) { json(response, 404, { ok: false, code: "unknown_workspace" }); return; }
      if (!["files", "read", "changes", "diff"].includes(body?.operation ?? "")) { json(response, 400, { ok: false, code: "invalid_request" }); return; }
      const operation = body!.operation as WorkbenchOperation;
      const target = body!.path;
      // Every workbench operation reads, so nothing here may run twice and a lost answer is only an unreachable host.
      // The host's own refusal keeps its code, and the route answers it with the status it always did.
      try {
        const result = await clientOf(binding).control.workbench({ workspaceId: binding.id, operation, ...(target === undefined ? {} : { path: target }) });
        json(response, result.ok ? 200 : 409, result);
      } catch { json(response, 503, { ok: false, code: "gateway_offline" }); }
      return;
    }
    // The agent definitions of one workspace's own execution host. The whole document is read, validated and written
    // there, so a refusal names its field and a dry run touches no disk on any host.
    if (url.pathname === "/api/agent-definitions" || url.pathname.startsWith("/api/agent-definitions/")) {
      const answered = await agentDefinitions(request, url);
      if (answered !== undefined) { json(response, answered.status, answered.body); return; }
    }
    // The settings surface: this deployment's model catalog, the models.json it owns, the shared sidebar document, and
    // one conversation's own configuration and adopted resources.
    if (await settings(request, response, url)) return;
    // The durable extensions this backend installed and the global default selection. The installed set is the
    // runtime's registry and the tools and sections are those extensions' own, so nothing here can drift from what a
    // conversation is offered. The default is hepi state: it is what a conversation created after a change selects, and
    // it is never read again for a conversation that already exists.
    if (url.pathname === "/api/extensions") {
      if (request.method === "GET") { json(response, 200, extensionInventory()); return; }
      if (request.method === "POST") {
        const body = await readBody(request);
        const asked = requestedSelection(body, true);
        if (!asked.ok) { json(response, asked.status, { code: asked.code, error: asked.error }); return; }
        await writeDefaultSelection(runtime.harness, asked.names);
        json(response, 200, extensionInventory()); return;
      }
      json(response, 405, { error: "method not allowed" }); return;
    }
    // The catalogue states everything a session list needs about each conversation: its workspace and host, whether a
    // run is in flight, its revision, and the summary the list shows. `snapshot()` returns the already-published view
    // rather than rebuilding it, so this is one pass over this process's own map and no per-conversation request: a
    // client asking which conversations are busy — the sidebar's running poll — reads one list instead of every
    // transcript, and the same list still carries the preview it showed before.
    if (request.method === "GET" && url.pathname === "/api/conversations") {
      // The sidebar's own revision rides on this one read: a client that compares it with the revision it last saw
      // knows its pins, archive and project order changed in another window, without a second request per poll.
      const sidebar = await readSidebarState(runtime.harness);
      // A removed conversation is not in the catalogue it was removed from; its records still read back through the
      // conversation-scoped routes, which is what makes the removal a tombstone rather than a deletion.
      const facts = await catalogueFacts();
      const listed = [...conversations.values()].filter(item => item.deletedAt() === undefined).map(item => catalogueEntry(item, facts));
      // The relation filters select rows this projection already holds — by creator, display parent, fork source, owner
      // or workspace — and `limit`/`cursor` page them by conversation id. This is the filtered, paginated list the
      // relations seam answers with, reusing the catalogue rather than a second graph service.
      const wanted = (name: string): string | null => url.searchParams.get(name);
      const filtered = listed.filter((entry) =>
        (wanted("createdBy") === null || entry.createdBy === wanted("createdBy"))
        && (wanted("displayParentId") === null || entry.displayParentId === wanted("displayParentId"))
        && (wanted("forkSource") === null || entry.parentConversationId === wanted("forkSource"))
        && (wanted("ownerConversationId") === null || entry.subagentParentConversationId === wanted("ownerConversationId"))
        && (wanted("workspaceId") === null || entry.workspaceId === wanted("workspaceId")));
      filtered.sort((left, right) => Number(left.id) - Number(right.id));
      const limitParam = wanted("limit");
      const limit = limitParam === null ? undefined : Number(limitParam);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) { json(response, 400, { code: "invalid_request", error: "limit must be a positive integer" }); return; }
      const cursor = wanted("cursor");
      if (cursor !== null && !/^[0-9]+$/.test(cursor)) { json(response, 400, { code: "invalid_request", error: "cursor must be a conversation id" }); return; }
      // A poll asks which conversations are busy and nothing else, so it is answered from the flag the rows were
      // already built with rather than from a second scan.
      const compactRunning = wanted("running") === "compact";
      // It answers the whole filtered list, so a page bound it cannot honour is refused rather than silently answered in full.
      if (compactRunning && (limitParam !== null || cursor !== null)) { json(response, 400, { code: "invalid_request", error: "running=compact cannot be combined with limit or cursor" }); return; }
      const { window, nextCursor } = conversationPage(filtered, limit, cursor ?? undefined);
      // The version of this listing, so a client comparing it can tell "nothing changed" from "re-read": it is a
      // property of the **list** rather than of one page of it, which is why it counts the filtered rows and not the
      // window, and every surface that reports it reads this one function.
      const sessionListVersion = catalogueListVersion(filtered);
      // The scan is this backend's whole catalogue either way; only the answer is smaller.
      if (compactRunning) {
        json(response, 200, {
          protocol: PROTOCOL_VERSION,
          sidebarStateRevision: sidebar.revision,
          projectsRevision: registry.revision(),
          sessionListVersion,
          runningConversationIds: filtered.filter(row => row.busy).map(row => row.id),
        }); return;
      }
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        sidebarStateRevision: sidebar.revision,
        projectsRevision: registry.revision(),
        sessionListVersion,
        conversations: window,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }); return;
    }
    // Full-body search over the conversations this catalogue lists, with no index: the entries are read through the
    // runtime's public paginated reads, so an entry appended after a previous search is found by the next one with
    // nothing to rebuild. A removed conversation is not in the catalogue it was removed from, so it is not searched;
    // the matcher, the bounds and the response shape are upstream pi-web's (`./session-search.ts`).
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query === "") { json(response, 200, { protocol: PROTOCOL_VERSION, results: [], truncated: false }); return; }
      try {
        const searched = await searchConversationBodies([...conversations.values()].filter(item => item.deletedAt() === undefined).map(item => item.conversation), query);
        const facts = await catalogueFacts();
        json(response, 200, { protocol: PROTOCOL_VERSION, results: searched.results.map(hit => ({ ...hit, session: catalogueEntry(getConversation(hit.conversationId)!, facts) })), truncated: searched.truncated }); return;
      } catch (error) {
        // An over-long query is refused with the reason it was refused, not answered as an empty result.
        if (error instanceof SearchQueryTooLong) { json(response, 400, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/conversations") {
      const body = await readBody(request) as { workspaceId?: string; requestId?: string; createdBy?: string; displayParentId?: string; provenance?: unknown } | undefined;
      // Only a configured workspace or a folder of a recorded project is a target for a new conversation. A binding a
      // removal retained resolves for the conversations that already hold it, and a new conversation cannot be bound to
      // a folder that is no longer a Project folder.
      if (body?.workspaceId && !registry.isTarget(body.workspaceId)) { json(response, 400, { error: "unknown workspace" }); return; }
      // A project's root is re-registered here: the gateway keeps its workspaces in memory, so a gateway restarted
      // while this backend stayed up still serves the conversation that is about to bind that folder.
      if (body?.workspaceId) await registry.ensureBinding(body.workspaceId);
      // The relations a caller states are identities only. A value that is not a conversation id string is refused
      // here; an identity that names no conversation is refused inside the same creation commit that would use it.
      if (body?.createdBy !== undefined && (typeof body.createdBy !== "string" || body.createdBy.trim() === "")) { json(response, 400, { code: "invalid_request", error: "createdBy must be a conversation id" }); return; }
      if (body?.displayParentId !== undefined && (typeof body.displayParentId !== "string" || body.displayParentId.trim() === "")) { json(response, 400, { code: "invalid_request", error: "displayParentId must be a conversation id" }); return; }
      // The conversation's extension selection is materialized here, in the commit that creates it: the resolved global
      // default is written into this conversation's own `pi.agent.extensions` as an explicit name list. That is what
      // makes the selection this conversation's own state — a later change to the default is a change to what the *next*
      // conversation selects, and this one is not re-read against it. Creation, relations, the workspace binding and the
      // request dedupe are the one creation seam's commit; a replay of the same request id answers the same conversation.
      try {
        const spawned = await operations.spawn({
          requestId: body?.requestId !== undefined && body.requestId.trim() !== "" ? body.requestId : randomUUID(),
          ownership: { kind: "ownerless" },
          agent: { model: runtime.model, thinkingLevel: options.defaultThinkingLevel, extensions: await selectionFor(body?.workspaceId), cwd: "/" },
          ...(body?.createdBy === undefined ? {} : { createdBy: body.createdBy }),
          ...(body?.displayParentId === undefined ? {} : { displayParentId: body.displayParentId }),
          ...(body?.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          ...(body?.provenance === undefined ? {} : { provenance: body.provenance as ConversationProvenance }),
        });
        const attached = await attach(spawned.conversation);
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: spawned.conversationId, conversation: catalogueEntry(attached, await catalogueFacts()) }); return;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
    }
    // The conversation-scoped routes. Each domain module resolves the conversation it is asked about and answers its
    // own paths, so a route change touches one module and this wiring; the entry keeps only the dispatch order and the
    // final fallback.
    if (await conversationHistory(request, response, url)) return;
    if (await conversationCommands(request, response, url)) return;
    if (await conversationExtensions(request, response, url)) return;
    json(response, 404, { code: "not_found", error: "conversation not found" });
  }

  return { server, async close() { await conversations.close(); await runtime.close(); await new Promise<void>((resolve) => { if (!server.listening) resolve(); else server.close(() => resolve()); }); } };
}
