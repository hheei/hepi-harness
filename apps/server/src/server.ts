import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, getSupportedThinkingLevels, type ImageContent, type Models, type Message, type TextContent } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { type AgentChange, type Conversation, type ConversationId, type ConversationView, type EntryId, type EntryRecord, type Harness, type LiveState, type AgentState, type InboxState, type ToolSlot, type TaskInspection, type Cursor, type ModelRef, AgentDoc, InboxDoc, defineDoc, ConversationBusy, watchEvents, type Extension } from "@earendil-works/pi-durable";
import { GatewayHostClient, gatewayEnvironment, HostTransportError, type EnvironmentBinding, type ExecutionHostEnv } from "@hepi/gateway";
import { DEFAULT_HOST_HEADER, HEARTBEAT_FRAME, HEARTBEAT_INTERVAL_MS, parseSessionUiStateRequest, projectSubmission, textUrl, toolResultImageUrl, validateCommand, MAX_SESSION_UI_REQUEST_BYTES, MAX_SUBMISSION_BODY_BYTES, MAX_TOOL_RESULT_IMAGE_BYTES, PROTOCOL_VERSION, TOOL_RESULT_IMAGE_MIMES, type ProtocolCommand, type ServerDelta as ServerDeltaOf, type ServerFailure as ServerFailureOf, type ServerEntry as ServerEntryOf, type ServerFrame as ServerFrameOf, type ServerSnapshot as ServerSnapshotOf, type SessionUiStateRefusalReason, type ConversationProvenance, type ConversationRelations, type ResolvedReference, type SubmissionProjection, type SubmitImage } from "@hepi/protocol";
import type { McpToolList, WorkbenchOperation, WorktreeListing, WorktreeRequest as WorktreeHostRequest, WorkspaceRequest as HostRequest } from "@hepi/protocol/gateway";
import { readSidebarState, writeSidebarState } from "./sidebar-state.ts";
import { submitConversationInput } from "./conversation-input.ts";
import { buildTitleTranscript, generateSessionTitle, MAX_TITLE_LENGTH } from "./session-title.ts";
import { tombstoneConversation, TombstoneDoc } from "./session-tombstone.ts";
import { ConversationOperationRefusal, createConversationOperations, readConversationRelations, RelationsDoc, resolveConversationReferences, WorkspaceDoc } from "./conversation-operations.ts";
import { SubtreeControlRefusal, type SubtreeChildOutcome, type SubtreeControlResult } from "./subtree-control.ts";
import { conversationPage } from "./conversation-page.ts";
import { catalogueListVersion, type CatalogueWorkspace } from "./catalogue-binding.ts";
import { handleConversationRead } from "./conversation-read-route.ts";
import { handleConversationNavigation, handleConversationNavigationTarget } from "./conversation-navigation.ts";
import { base64ByteLength, parseReadBlockQuery, readBlockImageAnswer, readBlockTextPage } from "./read-block.ts";
import { createConversationItemOperations, handleConversationItems, projectQueuedItems } from "./conversation-items.ts";
import { SEARCH_LIMITS, SearchQueryTooLong, searchConversationBodies } from "./session-search.ts";
import { ensureAdoptedResources, readEffectiveResources, reloadResources, resourceSummary, type ResourceSummary, type WorkspaceResources } from "./workspace-resources.ts";
import { ENVIRONMENT_EXTENSION, openServerHarness, type ExtensionInstallFailure, type ServerHarness, type HarnessConfiguration } from "./harness.ts";
import { extensionNameList, ExtensionSelectionDoc, materializeSelection, readDefaultSelection, reportedSelection, resolveDefaultSelection, writeDefaultSelection, type InstalledExtension, type StoredAgentExtensions } from "./extension-selection.ts";
import { readModelConfig, saveModelConfig, type ModelConfigTarget } from "./model-config.ts";
import { skillMarketRoute, type SkillMarket } from "./skill-repository.ts";
import { boundedMessage, createInstaller, installRequest, toggleRequest, updateRequest, type Installer } from "./skill-install.ts";
import { createTerminalRelay } from "./terminal-relay.ts";
import { createFileRelay } from "./file-relay.ts";
import { createAgentDefinitionsHandler } from "./agent-definitions-http.ts";
import { createSubagentHost, type SubagentCatalogueRow } from "./subagents/composition.ts";
import { createSubagentExtension } from "./subagents/extension.ts";
import { DispatchDoc, SUBAGENT_ANCHOR_TASK, SUBAGENT_EXTENSION } from "./subagents/host.ts";
import { createForkAnchor } from "./subagents/anchor.ts";
import { createSubagentDelegation, delegateDetails } from "./subagents/delegate.ts";
import { childRecovery, preparationRetryTarget } from "./subagents/recovery.ts";
import { projectRunStatus, tasksOf, type ConversationRunStatus } from "./subagents/status.ts";
import { createMcpToolBridge, MCP_EXTENSION, MCP_TOOL_PREFIX, type McpCallTarget, type McpToolDeclaration } from "./mcp-conversation-tools.ts";
import { grantEntriesOf, grantRequest, mcpConfigReadOf, mcpGrantSelection, mcpToolListOf, readMcpGrants, reconcileMcpOffer, writeMcpGrants } from "./mcp-grants.ts";

/** The two per-catalogue facts a status needs, read once for a whole list. */
type CatalogueFacts = { readonly tasks: ReadonlyMap<string, readonly TaskInspection[]>; readonly waitingReports: ReadonlySet<string> };

/** One child's outcome with its current session row attached, which is what a subtree answer projects. */
type SubtreeProjectedOutcome = SubtreeChildOutcome & { readonly session?: CatalogueEntry };

/** One subtree request's answer as the HTTP surface states it: the recorded outcomes plus each child's current row. */
type SubtreeProjectedResult = Omit<SubtreeControlResult, "outcomes"> & { readonly outcomes: readonly SubtreeProjectedOutcome[] };
import { advanceCatalogueStats, advanceHistoryFacts, appendedEntries, catalogueStats, continuationIndex, deferHistoryMessage, FRAME_LIMIT_BYTES, historyFacts, oversizeFrame, scopeFromFacts, tokenFromFacts, VISIBLE_WINDOW, WindowProjector, type CatalogueStats, type HeldWindow, type HistoryFacts, type ProjectedWindow, type WindowItem } from "./history-window.ts";
import { createProjectRegistry, type GatewayConnection } from "./project-registry.ts";
import type { ProjectFolder, ProjectRecord, ProjectStore } from "./project-store.ts";
import type { DeviceCredentials } from "./device-credentials.ts";

/**
 * The raw projection frames, consumed from `@hepi/protocol` where they are declared once for every production
 * consumer, with the two payloads this backend fills in: a committed entry carries the runtime's own `Message` and a
 * live message is that same record. Everything else — the window's bookkeeping, the attachment's identity, the
 * outstanding submissions and the resource summary — is the shared declaration, so a wire change is one edit.
 */
export type ServerEntry = ServerEntryOf<Message>;
export type ServerDelta = ServerDeltaOf<Message, ToolSlot>;
export type ServerFrame = ServerFrameOf<Message, ToolSlot>;
export type ServerSnapshot = ServerSnapshotOf<Message, ToolSlot>;
export type ServerFailure = ServerFailureOf;
export type BackendServer = { readonly server: Server; close(): Promise<void> };
/**
 * A conversation's hepi-owned title. The runtime's conversation record carries no title and cannot be filtered on
 * one, so the name a user sets is conversation-scoped hepi state written through the same durable document path as
 * every other hepi document — no framework change, and no second store (spec decisions 8 and 17). A fork copies the
 * title it had, like any other conversation document.
 */
const TitleDoc = defineDoc<{ title?: string }>({ kind: "hepi.title", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}) });
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
 * The refusals the upstream fork route names, honoured here so a caller can tell why a fork is unavailable instead of
 * receiving a bare status. `not_found`: no such conversation. `unsaved`: the named fork point is not committed in that
 * conversation, which is a client whose transcript is ahead of the durable one. `empty`: the branch carries no user or
 * assistant message.
 */
type ForkRefusal = "not_found" | "unsaved" | "empty";
const FORK_REFUSALS: Record<ForkRefusal, { status: number; error: string }> = {
  not_found: { status: 404, error: "Session not found" },
  unsaved: { status: 409, error: "This session has not been saved yet. Send a message before forking it." },
  empty: { status: 409, error: "Nothing to fork: the session has no messages" },
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
type WorktreeHostAnswer = { ok: true; value: unknown } | { ok: false; code: string; message?: string };

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
type Client = ServerResponse;

/**
 * Upstream credential and configuration failures embed the offending auth.json/models.json value in the thrown
 * message: `@earendil-works/pi-ai` dist/auth/resolve.js appends the cause through `withCauseDetail`, and
 * `@earendil-works/pi-coding-agent` dist/core/auth-storage.js formats the raw auth.json text into parse errors.
 * Those values are operator secrets, so the backend replaces such a message with a fixed one before it can reach an
 * HTTP response, an SSE frame or a conversation entry. Provider and protocol errors keep their own message.
 */
const SAFE_CREDENTIAL_ERROR = "the model catalog or credentials could not be loaded; check the backend model and credential configuration";
const CREDENTIAL_FAILURE_PREFIXES: readonly string[] = [
  "Credential store read failed for",
  "Credential store modify failed for",
  "Credential store delete failed for",
  "Credential store read failed",
  "API key auth failed for provider",
  "API key auth check failed for provider",
  "OAuth refresh failed for",
  "OAuth auth derivation failed for",
  "OAuth refresh returned a token that expires too soon for",
  "Model refresh failed for",
  "Provider is not configured:",
  "Unknown provider:",
  "Read-only credential storage cannot modify auth.json",
  "Failed to read auth.json",
  "Invalid auth.json",
  "Failed to resolve ",
  // `models.json` accepts any string as a provider's `api`, so startup succeeds and the value is echoed only when a
  // model call reaches the api registry: dist/index.js throws this, and dist/api/lazy.js copies it into the entry.
  "No API provider registered for api:",
  "Mismatched api:",
];

function isCredentialFailure(message: string): boolean {
  return CREDENTIAL_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * Catalog metadata crosses into the browser, so nested objects are rebuilt field by field instead of forwarded:
 * models.json passes unknown properties through the upstream schema and provider composer (`applyModelOverride`
 * spreads the override), and an apiKey or authorization smuggled into `cost` or `thinkingLevelMap` would otherwise
 * reach every client. `ModelCost` and `ThinkingLevelMap` in `@earendil-works/pi-ai` dist/types.d.ts define the
 * allowed fields.
 */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const COST_RATES: readonly string[] = ["input", "output", "cacheRead", "cacheWrite"];

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectCostRates(source: Record<string, unknown>): Record<string, number> | undefined {
  const rates: Record<string, number> = {};
  for (const key of COST_RATES) {
    const value = finiteNumber(source[key]);
    if (value === undefined) return undefined;
    rates[key] = value;
  }
  return rates;
}

function projectCost(cost: unknown): Record<string, unknown> | undefined {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const source = cost as Record<string, unknown>;
  const rates = projectCostRates(source);
  if (rates === undefined) return undefined;
  const tiers: Record<string, number>[] = [];
  if (Array.isArray(source.tiers)) {
    for (const tier of source.tiers) {
      if (tier === null || typeof tier !== "object" || Array.isArray(tier)) continue;
      const rates = projectCostRates(tier as Record<string, unknown>);
      const above = finiteNumber((tier as Record<string, unknown>).inputTokensAbove);
      if (rates === undefined || above === undefined) continue;
      tiers.push({ inputTokensAbove: above, ...rates });
    }
  }
  return tiers.length === 0 ? rates : { ...rates, tiers };
}

function projectThinkingLevelMap(map: unknown): Record<string, string | null> | undefined {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return undefined;
  const source = map as Record<string, unknown>;
  const projected: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    const value = source[level];
    if (typeof value === "string") projected[level] = value;
    else if (value === null) projected[level] = null;
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}

/**
 * A model carries the `api` id straight from `models.json`, which accepts any string, so an unregistered api would
 * echo the configured value to every client. Registered ids come from code or an extension, not from configuration.
 */
const SAFE_API = "unknown";

/** An assistant entry never carries a configured api id or a credential/configuration failure message. */
function safeEntry(message: Message): Message {
  if (message.role !== "assistant") return message;
  const failure = message.errorMessage !== undefined && isCredentialFailure(message.errorMessage);
  const api = getApiProvider(message.api) === undefined ? SAFE_API : message.api;
  if (!failure && api === message.api) return message;
  return { ...message, ...(failure ? { errorMessage: SAFE_CREDENTIAL_ERROR } : {}), api };
}

/** A rejected request keeps a protocol or provider message; a credential/configuration one is replaced. */
function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return isCredentialFailure(message) ? SAFE_CREDENTIAL_ERROR : message;
}

type ConversationRuntime = {
  readonly conversation: Conversation;
  readonly snapshot: () => ServerSnapshot;
  /** The conversation's hepi-owned title, kept current by its document watch; undefined while none is set. */
  readonly title: () => string | undefined;
  /**
   * The hepi-owned relations this conversation records — its creator, display parent and provenance — kept current from
   * this process's commit stream so a catalogue read states them without a per-conversation document read. The native
   * fork source and owner are separate fields, projected from the immutable record.
   */
  readonly relations: () => ConversationRelations;
  /**
   * The structured references this conversation makes to others, kept current the same way, each stated with the named
   * outcome when it cannot be followed now. The stored record is what the commit stream keeps current; whether it
   * resolves is a read over the **target's** own state, so it is answered per read rather than cached against a commit
   * this conversation never sees.
   */
  readonly references: () => Promise<readonly ResolvedReference[]>;
  /** The time this conversation was removed from the catalogue, or undefined while it is listed. */
  readonly deletedAt: () => number | undefined;
  /** The extensions this conversation currently selects, from the runtime's own resolution of its stored choice. */
  readonly extensions: () => readonly string[];
  readonly clients: Set<Client>;
  readonly close: () => Promise<void>;
  /**
   * The conversation this one was forked from, from its own immutable record. It is what lets the catalogue say a
   * conversation is a fork without reading its record per list read, and it is set once, when the conversation is
   * attached.
   */
  readonly parentConversationId?: string;
  /**
   * The conversation whose task created this one, from the conversation's own immutable record. It is what lets the
   * catalogue say a conversation is a subagent's without reading its record per list read, and it is set once, when the
   * conversation is attached — the same way its fork source is.
   */
  readonly subagentParentConversationId?: string;
  /**
   * When this conversation's newest finished run ended, or undefined while it has finished none. Read once when the
   * conversation is attached and kept current from this process's commit stream, so the catalogue states it without a
   * per-conversation read on every poll.
   */
  readonly lastRunEndedAt: () => number | undefined;
  /**
   * The message count and first user text the catalogue row states, kept current from this conversation's own view
   * advances. They are counted incrementally — an ordinary append adds what it appended — so a catalogue read costs
   * the same whether the conversation has ten entries or ten thousand, and it never re-reads a transcript that is no
   * longer held in one piece. A head marker moves the active range, so the counters are recounted from the new view.
   */
  readonly catalogueStats: () => CatalogueStats;
  /**
   * The two committed history facts this attachment keeps current: the newest head marker and the newest visible
   * entry. The navigation outline reads them rather than re-deriving a token, so the identity a page states is the
   * same one the window beside it states, and a page costs no pass over the range the attachment already holds.
   */
  readonly historyFacts: () => HistoryFacts;
  /**
   * The committed view this attachment currently holds. An older page is a suffix of the **same** active range the
   * window is, so the range's own lower bound — the newest head marker's head, or the transcript's start — is what a
   * page is bounded by, and reading it here costs no storage call and cannot disagree with the frame beside it.
   */
  readonly view: () => ConversationView;
};

/**
 * The ancestry a conversation's own immutable record states, read once when the conversation is attached: the
 * conversation it was forked from, and the conversation whose task created it. They are separate edges — a fork of a
 * subagent's conversation is refused, so a conversation has one or the other — and each is absent when the record
 * states none.
 */
type Ancestry = { readonly forkSource?: string; readonly subagentParent?: string };

/**
 * What one conversation's stored choice selects and offers, resolved against what is installed. Reporting only.
 *
 * Both fields travel in the view the projection is built from, so a snapshot states the offer the runtime itself will
 * resolve for a request rather than every tool a selected extension could offer if all of them were loaded: a deferred
 * tool is in that second list only when a person granted it.
 */
type SelectionReader = (stored: AgentState["extensions"], modelTools: AgentState["modelTools"], tools: AgentState["tools"]) => { readonly extensions: string[]; readonly tools: string[] };

/**
 * One complete state of a conversation, as both transports publish it. `projectionId` names this attachment instance
 * and `revision` counts the states this instance published, so the pair is what a client compares when two reads could
 * have come from different backends: two identities are two clocks, and an opaque token is what makes that detectable
 * instead of guessed from a counter that restarted at zero. `run` states the native run's inputs, or null when there
 * is no run — an empty input list is a run with no inputs and is never read as its absence.
 */
/**
 * One raw active entry as every surface publishes it. This is the **one** projection expression: the baseline, an
 * older page, a delta append and a single-entry read all come through here, so `safeEntry` runs once per entry and no
 * surface can forget the redaction, and the deferred shape of heavy history content cannot drift between them.
 *
 * Deferral is applied to **history** only and is lossless: a thinking block becomes a preview with the provider's
 * opaque `thinkingSignature` dropped, and a tool-result image inside the wire policy becomes the URL of the read
 * block that serves it. Both are restored by a read block, which is why the server may emit the URL at all. The live
 * partial never comes through here: a streaming message stays exact.
 */
function projectEntry(entry: EntryRecord, conversationId: string): ServerEntry | undefined {
  const message = entry.model?.[0];
  if (message === undefined || (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult")) return undefined;
  const id = String(entry.id);
  // The compatible `text` field is the same projection as the message beside it, so it is read back off the deferred
  // message rather than off the raw content: the two representations of one entry cannot disagree about whether a
  // heavy text was replaced by a preview, and the 2.03× wire amplification of carrying the raw text twice is gone with
  // the same rule instead of a second one.
  const projected = deferHistoryMessage(safeEntry(message), index => toolResultImageUrl(conversationId, id, index), index => textUrl(conversationId, id, index));
  return { id, role: message.role, text: contentText(projected.content), message: projected };
}

/**
 * The one projection expression, as the window projector uses it: an entry with the bytes it will cost on the wire, or
 * `undefined` for an entry that contributes no message. The size is measured **once**, here, at the only place an entry
 * is projected — so the byte budget reads a number instead of re-serializing the entry, and no surface can project an
 * entry by a second path.
 */
function projectedItem(conversationId: string) {
  return (entry: EntryRecord): WindowItem & { readonly entry: ServerEntry } | undefined => {
    const projected = projectEntry(entry, conversationId);
    return projected === undefined ? undefined : { id: projected.id, bytes: Buffer.byteLength(JSON.stringify(projected)), entry: projected };
  };
}

/**
 * The projected entries of one raw window, for a caller that has no window of its own to keep — a test, or a read of a
 * range nobody holds. The attachment's own window is kept by a `WindowProjector` and advanced, not rebuilt, because a
 * publication that re-derived the window would project 300 entries to publish two.
 *
 * The window is a **suffix** of the active range, so it is selected on the raw entries first (`windowStart` reads a
 * kind and a count, not a transcript) and only the selected entries are projected; whole entries are then dropped from
 * the oldest end until the count rule and the byte budget hold, and the newest entry is never dropped, so a single
 * oversized entry is still carried whole rather than split or silently truncated. `oldestEntryId` is the boundary the
 * window **actually** has — the first entry it carries when older entries exist behind it, and `null` when it is the
 * whole active range — which is what lets a client keep a prefix it already loaded and still replace everything the
 * window covers.
 */
function projectWindow(entries: readonly EntryRecord[], conversationId: string): { entries: ServerEntry[]; hasMore: boolean; oldestEntryId: string | null } {
  const window = new WindowProjector(projectedItem(conversationId)).advance(entries);
  return { entries: window.items.map(item => item.entry), hasMore: window.hasMore, oldestEntryId: window.oldestEntryId };
}

/** One page of older history, as the read that answers it states it. */
type ServerPage = { protocol: typeof PROTOCOL_VERSION; conversationId: string; entries: ServerEntry[]; oldestEntryId: string | null; hasMore: boolean };

/**
 * One page of older history, addressed by entry id.
 *
 * The page is a slice of the **native active range** the attachment already holds — the same array the window is cut
 * from — so it follows the runtime's own active order rather than entry-id order. That is not a detail: a head marker
 * is kept first by the native view and carries a *newer* id than the entries it keeps, so a page ordered by id can
 * never reach it and the summary of everything the context dropped becomes unreachable. Slicing by position reaches
 * it, hands it out exactly once, and cannot cross it, because the marker is the first element of the range.
 *
 * `before` is exclusive and names the oldest entry the caller already holds. An id this range does not hold has no
 * page behind it, which is the same answer as reaching the start. The same count rule, byte budget and projection
 * expression as the window are applied to the slice, so a paged entry and a streamed entry cannot differ.
 */
function pageEntries(item: ConversationRuntime, before: EntryId | undefined, tail: number): ServerPage {
  const entries = item.view().entries;
  const end = before === undefined ? entries.length : entries.findIndex(entry => String(entry.id) === String(before));
  const upto = end < 0 ? 0 : end;
  const page = new WindowProjector(projectedItem(String(item.conversation.id)), tail).advance(entries.slice(0, upto));
  return { protocol: PROTOCOL_VERSION, conversationId: String(item.conversation.id), entries: page.items.map(item => item.entry), oldestEntryId: page.oldestEntryId, hasMore: page.hasMore };
}

/**
 * One entry as this conversation's own history holds it.
 *
 * The runtime's global `tx.entry()` is a lookup by id alone, and entry ids are **inherited**: a fork's entries and
 * its parent's are the same records. A read block therefore resolves through the conversation's fork-aware history,
 * so an id from another conversation is not readable here, while an ancestor entry a fork inherited still is. The
 * read is a native range of exactly one id, so it costs one lookup and scans no transcript.
 */
async function visibleEntry(item: ConversationRuntime, id: EntryId): Promise<EntryRecord | undefined> {
  const page = await item.conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND_CONTEXT);
  return page.items[0];
}

/** One base64 image block as the read block reads it, whichever of the two shapes it was written in. */
function readBlockImage(block: unknown): { data: string; mimeType: string; bytes: number } | undefined {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return undefined;
  const value = block as Record<string, unknown>;
  if (value.type !== "image") return undefined;
  const source = typeof value.source === "object" && value.source !== null ? value.source as Record<string, unknown> : undefined;
  const data = typeof value.data === "string" ? value.data : source?.type === "base64" && typeof source.data === "string" ? source.data : undefined;
  const mimeType = typeof value.mimeType === "string" ? value.mimeType : typeof source?.media_type === "string" ? source.media_type : undefined;
  if (data === undefined || mimeType === undefined) return undefined;
  // The size is arithmetic over the base64 length, not a decode: measuring an image must not allocate a copy of it, and
  // the answer a range produces is sliced from the characters the range touches (`read-block.ts`).
  return { data, mimeType, bytes: base64ByteLength(data) };
}

/**
 * One complete state of a conversation, built from the attachment's **kept** window and history facts.
 *
 * Both are inputs rather than derived here, and that is the whole point: an advance that appended entries advances the
 * window and the facts incrementally, so a publication projects what it appended instead of the window it already sent
 * and does not rescan the active range for a token. A recompute path (the first read, a head marker, a truncation) hands
 * in freshly derived ones, so the two paths state the same facts in the same shape.
 */
function project(view: ConversationView, revision: number, projectionId: string, window: ProjectedWindow<WindowItem & { readonly entry: ServerEntry }>, facts: HistoryFacts, submissions: readonly SubmissionProjection[] = [], select: SelectionReader = () => ({ extensions: [], tools: [] })): ServerSnapshot {
  const conversationId = String(view.conversation.id);
  const entries = window.items.map(item => item.entry);
  const live = view.docs["pi.live"] as LiveState | undefined;
  const partial = live?.generation?.message === undefined ? undefined : safeEntry(live.generation.message);
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const selected = select(agent?.extensions, agent?.modelTools, agent?.tools);
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const queued = (mode: "steer" | "followUp") => (inbox?.items ?? []).flatMap(item => item.mode === mode ? [contentText(item.content)] : []);
  // The same queue as items: one projection, read in this same pass, so the text lists beside it and the items a
  // surface acts on cannot disagree. Each item's own admission request id is taken from the outstanding submissions
  // this frame already states, so no extra read is made and the identity a caller resolves a submission by travels
  // with the item it belongs to (spec D09).
  const requestIds = new Map<string, string>();
  for (const submission of submissions) if (submission.requestId !== undefined) requestIds.set(submission.submissionId, submission.requestId);
  const queuedItems = projectQueuedItems(inbox?.items ?? [], requestIds).map(item => ({ ...item, conversationId }));
  // The control record is part of the same `pi.inbox` document the queue is read from, so "held" and the queued item
  // it governs travel in one frame and a client cannot read one without the other. A version 1 record has no control
  // field; it reads as the default `allowed` the runtime's own migration gives it.
  const control = inbox?.control ?? { state: "allowed" as const, revision: 0, receipts: [] };
  // A conversation that selected no model reports none: the transcript is the only statement about it, and the public
  // snapshot must not hand a client a model the runtime was never asked to serve.
  return { liveTools: live?.tools ?? [], toolNames: selected.tools, extensions: selected.extensions, ...(partial ? { liveMessage: partial } : {}), settings: { model: agent?.model ?? null, thinkingLevel: agent?.thinkingLevel ?? "off" }, queuedMessages: { steering: queued("steer"), followUp: queued("followUp") }, queuedItems, control: { state: control.state, revision: control.revision, ...(control.stopSource === undefined ? {} : { stopSource: control.stopSource }), ...(control.stoppedAt === undefined ? {} : { stoppedAt: control.stoppedAt }) }, protocol: PROTOCOL_VERSION, revision, projectionId, historyRevision: tokenFromFacts(conversationId, facts), historyHead: facts.head, hasMore: window.hasMore, oldestEntryId: window.oldestEntryId, run: live?.run === undefined ? null : { inputs: live.run.inputs.map(String) }, conversationId, busy: live?.run !== undefined, entries, partial: partial === undefined ? "" : contentText(partial.content), failure: null, submissions };
}

/**
 * The submissions this conversation has admitted and not yet settled, read through the runtime's inspection (live
 * tasks and unsettled submissions, read on the session line). They are what a reconnecting client cannot rebuild from
 * the transcript: an input that is still queued has no entry, and one that was placed has an entry the client cannot
 * tell apart from older history without being told the submission owns it. Settled submissions are absent by
 * construction, so the list stays bounded by the work actually outstanding.
 */
async function readPendingSubmissions(harness: Harness, conversationId: ConversationId): Promise<readonly SubmissionProjection[]> {
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  return inspection.submissions.filter(record => record.conversationId === conversationId).map(record => projectSubmission(record));
}

/**
 * When one conversation's newest generation run ended, from the committed task table. It is the one fact that says a run
 * happened at all: a run that starts and finishes between two catalogue polls is never observed as busy, so a client
 * that only compared running flags could not learn it ran. The receipt states no outcome — whether the run answered,
 * aborted or failed is the transcript's and the submission's business — so this is a marker source and never a
 * completion signal. Reading the newest generation task is the same read `readRunFailure` makes, so a live run reports
 * no end (its record has none yet) and a finished one reports its own.
 */
async function readLastRunEndedAt(harness: Harness, conversationId: ConversationId): Promise<number | undefined> {
  const page = await harness.commit(tx => tx.scanTasks({ conversationId, kind: "pi.generation", order: "descending" }, 1, undefined), BACKGROUND_CONTEXT);
  return page.items[0]?.endedAt;
}

/**
 * The framework's own `no_model` settlement for one conversation's newest generation run, read from the committed task
 * table rather than from a callback: the durable task record keeps its terminal reason and message across a reconnect
 * and a backend restart, so the failure a user saw is still there afterwards without this process remembering anything.
 *
 * Only `no_model` is projected, because it is the one generation failure the framework settles without appending
 * anything: a request the provider rejected is already shown through the assistant entry that failure appends, and
 * repeating it above the composer would say the same thing twice.
 *
 * Scanning the newest generation task, not the newest *failed* one, is what makes the state self-correcting: a run that
 * is still live has no outcome yet, so it reports none, and a run that succeeds replaces a previous failure with its
 * own completed outcome.
 */
async function readRunFailure(harness: Harness, conversationId: ConversationId): Promise<ServerFailure | null> {
  const page = await harness.commit(tx => tx.scanTasks({ conversationId, kind: "pi.generation", order: "descending" }, 1, undefined), BACKGROUND_CONTEXT);
  const outcome = page.items[0]?.state.outcome;
  if (outcome === undefined || outcome.status !== "failed") return null;
  const detail = outcome.error.detail;
  const reason = typeof detail === "object" && detail !== null && !Array.isArray(detail) && typeof (detail as Record<string, unknown>).reason === "string" ? (detail as Record<string, string>).reason : undefined;
  return reason === "no_model" ? { reason, message: safeFailure(outcome.error.message) } : null;
}

function send(response: ServerResponse, event: string, data: unknown): boolean {
  if (response.writableEnded || response.destroyed) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  response.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  return true;
}
/**
 * The keepalive one attached event-stream client receives, and the timer that writes it.
 *
 * A conversation publishes nothing while it is quiet, and every hop between this process and the browser bounds how
 * long a body may stay silent. The comment frame is bytes that carry no event, so it defeats that bound without
 * inventing a lifecycle fact a client would have to interpret.
 *
 * The write is skipped when the client is mid-backlog: a keepalive is worth nothing if the connection is already
 * behind, and the ordinary send path is what closes a client that cannot keep up. The interval is unref'd, so an idle
 * stream never holds this process open by itself.
 */
function startKeepalive(response: ServerResponse, intervalMs: number): () => void {
  // A cadence of zero states no keepalive at all: an origin with no idle bound in front of it writes nothing, and the
  // stream is then exactly as quiet as its own events make it.
  if (!(intervalMs > 0)) return () => {};
  const timer = setInterval(() => {
    if (response.writableEnded || response.destroyed) return;
    if (response.writableLength > 0) return;
    response.write(HEARTBEAT_FRAME);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
async function readBody(request: IncomingMessage, limitBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) { bytes += Buffer.byteLength(chunk); if (bytes > limitBytes) throw new Error("request body exceeds " + Math.floor(limitBytes / 1024) + " KiB"); chunks.push(chunk as Buffer); }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
function authorized(request: IncomingMessage, token: string): boolean { return request.headers.authorization === "Bearer " + token; }
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
/** A refused sidebar-state write: the reason the caller can act on, in the shared response shape. */
function sidebarRefusal(response: ServerResponse, status: number, reason: SessionUiStateRefusalReason, error: string): void {
  json(response, status, { error, reason });
}

/**
 * A Web origin names the gateway that serves its own execution host, and the backend resolves that name against the
 * gateways this deployment configured. Nothing else can tell the backend which host a browser is served from: two Web
 * origins can be pointed at one backend, each with its own local host, and the backend's own account, default
 * workspace and container directory are unrelated to either. An unnamed or unknown host is an explicit configuration
 * error rather than a guessed one, which would show one computer's directories under another computer's account.
 */
const WEB_HOST_REQUIRED = "no Web host gateway is named: the Web UI server sends the configured gateway id it serves (HEPI_WEB_LOCAL_GATEWAY_ID) on every host-scoped request";

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

/**
 * One conversation's event source, the state a client is served from it, and the two native durable streams it
 * consumes. Neither stream replaces the other:
 *
 * - `conversation.watch()` carries the committed structural view — the entries and built-in documents the state
 *   projection is built from — as a serialized exact-frame watch on the session line. The acquisition frame and the
 *   registration for later commits are taken together, and a consumer that falls behind gets a fresh frame instead of
 *   an unbounded buffer, so the runtime owns order, the initial snapshot and overflow.
 * - `watchEvents()` carries the submission lifecycle, which the view does not: admitting, placing or settling a
 *   submission changes no entry and no document, so a view-only consumer never observes it. Its records are projected
 *   into the stable `SubmissionProjection` and published with the same state, which is what lets a client stop
 *   inferring a submission's fate from the number of committed entries it happens to be holding.
 *
 * The two streams publish through one snapshot, so a client never reads entries and outstanding submissions from
 * different moments.
 *
 * A settlement is the one lifecycle fact that cannot ride the state frame: the settled submission leaves the
 * outstanding set, so a state-only client reads its *absence*, which is not a fact about the turn. It is therefore
 * delivered as its own `submission` frame, carrying the terminal projection — status, the entry it owns, and the
 * durable reason — to every client currently following that submission. The frame is live and is never buffered or
 * replayed: a client that was not there when it settled opens with the snapshot, which states the outstanding set
 * truthfully, and asks `/submissions?requestId=` about the turn it is waiting on. So the memory a settlement costs
 * does not grow with the number of finished turns, and a client that missed one always has a path to the answer.
 */
async function attachConversation(conversation: Conversation, harness: Harness, readInstalled: () => readonly InstalledExtension[], workspaceId?: string, readResources?: () => Promise<ResourceSummary | undefined>, readFailure?: () => Promise<ServerFailure | null | undefined>, readSubmissions?: () => Promise<readonly SubmissionProjection[]>, ancestry: Ancestry = {}): Promise<ConversationRuntime> {
  const view = await conversation.watch(BACKGROUND_CONTEXT);
  const events = await watchEvents(harness, conversation.id, BACKGROUND_CONTEXT);
  // The title is not one of the view's built-in documents, so the catalogue entry is kept current from this
  // process's own commit stream: the document is read once here, and every later commit that writes it — including
  // the first one, for a conversation that had no title until it was renamed — replaces the value this process
  // reports. A catalogue read therefore states the current name without asking any conversation about its state.
  let title: string | undefined = (await harness.snapshot(TitleDoc, conversation.id, BACKGROUND_CONTEXT))?.title;
  // Read once here and kept current from the commit stream, exactly as the title is, so a catalogue read states the
  // removal without asking any conversation about its own state.
  let deletedAt: number | undefined = (await harness.snapshot(TombstoneDoc, conversation.id, BACKGROUND_CONTEXT))?.deletedAt;
  // The hepi-owned relations, read once here and kept current from the commit stream, exactly as the title is: a
  // catalogue or by-id read states them without a document read per conversation. The references are not cached this
  // way: whether one resolves is a fact of the **target's** own state, so it is answered per read by the owner that
  // holds that verdict rather than from a commit stream this conversation never sees.
  let relations: ConversationRelations = await readConversationRelations(harness, String(conversation.id));
  // Read once here and kept current from the commit stream for the same reason: a catalogue read states when this
  // conversation's newest run ended without a per-conversation read on every poll. The value only ever moves forward,
  // because a later commit cannot make a finished run unfinished.
  let lastRunEndedAt: number | undefined = await readLastRunEndedAt(harness, conversation.id);
  const stopTitleWatch = harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      // A run's own receipt: the generation task's record carries when it ended, and it is the only place a run that
      // was never observed as busy leaves a trace. Its outcome is not read here — a marker says a run happened, and
      // whether it answered is the submission's and the transcript's business.
      if (change.type === "task") {
        if (String(change.value.conversationId) !== String(conversation.id) || change.value.kind !== "pi.generation") continue;
        if (change.value.endedAt !== undefined) {
          lastRunEndedAt = lastRunEndedAt === undefined ? change.value.endedAt : Math.max(lastRunEndedAt, change.value.endedAt);
        }
        continue;
      }
      if (change.type !== "document" || change.conversationId === undefined || String(change.conversationId) !== String(conversation.id)) continue;
      // A removed conversation is hidden from the catalogue by its own document, kept current from this same stream so
      // the removal needs no per-list read. The title rides it too: a conversation with no title until it was renamed
      // replaces the value this process reports on the commit that writes it.
      if (change.record.kind === TombstoneDoc.definition.kind) { deletedAt = change.value === null ? undefined : (change.value as { deletedAt?: number }).deletedAt; continue; }
      if (change.record.kind === RelationsDoc.definition.kind) { relations = change.value === null ? {} : change.value as ConversationRelations; continue; }
      if (change.record.kind !== TitleDoc.definition.kind) continue;
      title = change.value === null ? undefined : (change.value as { title?: string }).title;
    }
  });
  // This process's own publication order, exactly as the wire always described the revision. Both streams advance the
  // one counter, so every published state stays totally ordered regardless of which stream caused it.
  let revision = 0;
  let published = -1;
  // This attachment's own identity, minted once here and carried on every snapshot it publishes, HTTP and SSE alike.
  // Two attachments are two clocks even when they read the same store, so the token is what lets a client tell a read
  // from another backend from one of its own; it is deliberately opaque and deliberately not persisted, because a
  // restarted backend is a new attachment whose revision means nothing against the old one's.
  const projectionId = randomUUID();
  /**
   * The extensions this conversation selects and the tools they offer it, stated with the framework's own selection rule
   * against the registry's installed set and the conversation's own committed offer. All of it is read from the view
   * the projection is already built from, so it is derived per publication rather than read again on the session line,
   * and it states what the runtime resolves for a request: a selected extension's tools are offered, a deferred one only
   * when `pi.agent.modelTools` names it, and an unselected extension's are not.
   *
   * The installed set is read from the registry **at each publication**, not snapshotted at attach: a granted tool first
   * staged after this conversation was attached is part of what the runtime can resolve for it, and a projection frozen
   * at attach would state an offer the next request would not answer.
   */
  const select: SelectionReader = (stored, modelTools, tools) => reportedSelection(readInstalled(), stored as StoredAgentExtensions, modelTools, tools);
  const base = (value: ServerSnapshot): ServerSnapshot => ({ ...value, workspaceId });
  // The outstanding submissions, seeded by the committed table because the event stream starts from now and kept
  // current by the `submission` events. A settlement removes the projection: its committed entry represents it.
  const pending = new Map<string, SubmissionProjection>();
  for (const projection of (readSubmissions === undefined ? [] : await readSubmissions())) pending.set(projection.submissionId, projection);
  const outstanding = (): readonly SubmissionProjection[] => [...pending.values()].sort((left, right) => Number(left.submissionId) - Number(right.submissionId));
  let latestView: ConversationView = view.value;
  // The catalogue counters, seeded once from the view this attachment acquired and advanced by every later view.
  let stats: CatalogueStats = catalogueStats(latestView.entries);
  // The bounded window and the history facts, kept current by every advance: an advance that appended entries extends
  // both by what it appended, and any other advance recomputes them from the view. This is the attachment's own state
  // and it is bounded by the window, so a long conversation costs no more of it than a short one.
  const projector = new WindowProjector(projectedItem(String(conversation.id)));
  let window: ProjectedWindow<WindowItem & { readonly entry: ServerEntry }> = projector.advance(latestView.entries);
  let facts: HistoryFacts = historyFacts(latestView.entries);
  let current: ServerSnapshot = base(project(latestView, revision, projectionId, window, facts, outstanding(), select));
  if (readResources !== undefined) {
    const resources = await readResources();
    if (resources !== undefined) current = { ...current, resources };
  }
  const clients = new Set<Client>();
  // The committed resource state rides on the existing state snapshot and event, so a reconnecting client sees the
  // adopted catalog and any reload waiting for the next run without a second event architecture. The newest terminal
  // run's outcome rides it the same way, which is what makes it survive a reconnect and a backend restart. Reads are
  // serialized by revision, so a slower read cannot publish an older view over a newer one.
  // A live run supersedes the newest terminal outcome: while it is in flight the previous failure describes a turn
  // this run has already replaced, so nothing stale is shown, and the read is skipped entirely because a busy
  // conversation publishes often. When idle the committed task table is read, so a reconnect and a backend restart
  // observe the same failure without this process remembering anything.
  const settledFailure = async (busy: boolean): Promise<ServerFailure | null | undefined> => readFailure === undefined || busy ? undefined : (await readFailure()) ?? null;
  // The window the clients actually received, so the next frame can continue it instead of restating it. It starts
  // as the baseline every attached client was handed, and a frame refused for size is not written and therefore not
  // remembered: the next frame is built on the last window the clients really hold, which is what keeps `baseRevision`
  // exact across a refusal. It is a fact about the window, not about any client — no cursor, buffer or ack is kept.
  let written: HeldWindow = { revision: current.revision, entries: current.entries, head: current.historyHead };
  /**
   * The frame one publication sends: the whole window when the clients cannot continue from what they hold, and an
   * append delta when they can. The rule is {@link continuationIndex}, stated once beside the window rule it belongs
   * to, so the baseline, a page and an advancing frame cannot disagree about what a window is.
   */
  const frameFor = (value: ServerSnapshot): ServerFrame => {
    const index = continuationIndex(written, { head: value.historyHead, entries: value.entries });
    if (index < 0) return value;
    const { entries: held, ...scalars } = value;
    return { ...scalars, baseRevision: written.revision, appended: held.slice(index + 1) };
  };
  const publish = async (value: ServerSnapshot): Promise<void> => {
    const resources = readResources === undefined ? undefined : await readResources();
    const failure = await settledFailure(value.busy);
    if (value.revision < published) return;
    published = value.revision;
    current = { ...base(value), ...(resources === undefined ? {} : { resources }), ...(failure === undefined ? {} : { failure }) };
    // The frame is built first and measured as it is, because the frame is what would be written. Measuring the
    // snapshot instead would refuse an advance whose delta fits — the appended entry is what costs, and the window it
    // joins is already held — and a refusal is not written, so the client's revision would never advance and every
    // later frame would refuse too. A frame that cannot be carried is **stated**, never written: the transport's guard
    // would destroy the connection and the client would reconnect to the same frame. The statement names the entry and
    // its size, the stream stays open, and the next commit publishes normally, so size never produces an endless resync
    // and never a silent truncation.
    const frame = frameFor(current);
    const oversize = oversizeFrame(frame, current.entries.at(-1)?.id ?? null);
    if (oversize !== undefined) { for (const client of clients) send(client, "state_oversize", { protocol: PROTOCOL_VERSION, conversationId: String(conversation.id), revision: current.revision, reason: "frame_too_large", ...oversize }); return; }
    written = { revision: current.revision, entries: current.entries, head: current.historyHead };
    for (const client of clients) send(client, "state", frame);
  };
  const initialFailure = await settledFailure(current.busy);
  if (initialFailure !== undefined) current = { ...current, failure: initialFailure };
  /** One lifecycle fact, delivered live to the clients following this conversation. Nothing is retained: the state
   * snapshot is the whole truth for a client that arrives later, and the lookup answers for a single turn. */
  const announce = (projection: SubmissionProjection): void => {
    for (const client of clients) send(client, "submission", projection);
  };
  // A commit may publish to both streams; each callback advances the revision once, so the same commit cannot produce
  // two states with the same revision and a publication is never lost by later overwriting earlier.
  /**
   * Advance the window and the facts for one view publication, from the ops the runtime published rather than from a
   * comparison of two entry arrays. An append-only advance — the ordinary case — extends both by exactly what it
   * appended; anything else (a head marker, a truncation, a replacement, an overflow's root replace) recomputes them
   * from the view, which is the re-baseline the design states and is also what keeps them exact rather than adjusted.
   */
  const onAdvance = (appended?: readonly EntryRecord[]): void => {
    window = projector.advance(latestView.entries, appended);
    facts = appended === undefined ? historyFacts(latestView.entries) : advanceHistoryFacts(facts, appended);
    revision += 1;
    void publish(base(project(latestView, revision, projectionId, window, facts, outstanding(), select))).catch(() => {});
  };
  view.start(async (value, ops) => {
    // The counters advance from the same value the frame is built from, so the catalogue row and the transcript can
    // never disagree about how many messages a conversation has.
    stats = advanceCatalogueStats(stats, latestView.entries, value.entries);
    const appended = appendedEntries<EntryRecord>(ops, latestView.entries.length);
    latestView = value;
    onAdvance(appended);
  });
  events.start(async (batch) => {
    // The stream's own overflow recovery replaces undelivered batches with a snapshot, and a snapshot carries the view
    // rather than the submissions a settlement may have removed in between. Re-reading the committed table is what
    // keeps the list honest across that gap; without it a settled submission could stay outstanding forever.
    let overflowed = false;
    for (const event of batch) {
      if (event.type === "snapshot") { overflowed = true; continue; }
      if (event.type !== "submission") continue;
      const projection = projectSubmission(event.record);
      // A settled submission leaves the list: its entry is in the transcript and its reason reached the run that
      // carried it. Queued and placed stay, which is the state a client cannot read out of the entries.
      const settled = projection.status === "done" || projection.status === "unanswered";
      const followed = pending.delete(projection.submissionId);
      if (!settled) pending.set(projection.submissionId, projection);
      // Every transition of a submission a client is following is delivered, so a client is told a turn was placed
      // and, at the end, told *how* it ended instead of watching it disappear from the outstanding set. A settlement
      // is delivered to the clients that had the submission; a queued or placed one always is, because it is
      // outstanding. Nothing is replayed to a client that was not there.
      if (followed || !settled) announce(projection);
    }
    if (overflowed && readSubmissions !== undefined) {
      pending.clear();
      for (const projection of await readSubmissions()) pending.set(projection.submissionId, projection);
    }
    // A submission transition changes no entry: the frame carries the same window and the same facts, states what it
    // appended (nothing), and advances the revision. The projector is told so explicitly rather than being handed the
    // view again, because re-deriving a window nothing moved would cost what the window holds.
    onAdvance([]);
  });
  return {
    conversation,
    snapshot: () => current,
    title: () => title,
    relations: () => relations,
    references: () => resolveConversationReferences(harness, String(conversation.id)),
    deletedAt: () => deletedAt,
    lastRunEndedAt: () => lastRunEndedAt,
    catalogueStats: () => stats,
    historyFacts: () => facts,
    view: () => latestView,
    extensions: () => current.extensions,
    clients,
    ...(ancestry.forkSource === undefined ? {} : { parentConversationId: ancestry.forkSource }),
    ...(ancestry.subagentParent === undefined ? {} : { subagentParentConversationId: ancestry.subagentParent }),
    close: async () => {
      for (const client of clients) client.end();
      clients.clear();
      stopTitleWatch();
      await Promise.all([view.stop(), events.stop()]);
    },
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
  /**
   * One request to a gateway's worktree surface. The host owns the git work — which checkouts a registered root has,
   * one created on a branch, one removed — and its refusal keeps its own name, so a dirty checkout, a host limit and an
   * unreachable transport stay three different answers. A create or a remove whose answer never arrived is an unknown
   * outcome rather than an offline host, because the checkout may exist on the host either way.
   */
  const hostWorktreeRequest = async (binding: { gatewayOrigin: string; gatewayToken: string }, body: WorktreeHostRequest): Promise<WorktreeHostAnswer> => {
    try {
      const result = await clientOf(binding).control.worktrees(body);
      if (result.ok) return { ok: true, value: result.value };
      return { ok: false, code: result.code, ...(result.message === undefined ? {} : { message: result.message }) };
    } catch (error) {
      const failure = hostTransportAnswer(error, body.operation !== "list");
      return { ok: false, code: failure.code, ...(failure.message === undefined ? {} : { message: failure.message }) };
    }
  };
  /**
   * One checkout of a root as a folder of the Project that owns the root: hepi mints the workspace id, the host
   * canonicalizes and registers the root, and the record is written only after the host accepted it. This is what
   * makes a worktree a conversation target — a conversation binds a workspace id, and a root hepi holds no record of
   * is a root no conversation can run in. The record is the same project folder a folder chosen in the dialog is, so
   * nothing else about the project has to learn about worktrees.
   */
  const folderForCheckout = async (project: ProjectRecord, root: string): Promise<ProjectFolder | undefined> => {
    // A checkout this project already records is that folder: the record is keyed by root, so a worktree seen twice —
    // or one registered by an earlier list — is one folder with one workspace id, never two.
    const existing = project.folders.find(folder => folder.root === root);
    if (existing !== undefined) { await registry.ensureFolder(project, existing); return existing; }
    const workspaceId = randomUUID();
    const binding = registry.bindingOfFolder(project, { id: randomUUID(), workspaceId, root, createdAt: new Date().toISOString() });
    if (binding === undefined) return undefined;
    const registered = await hostRequest(binding, { operation: "register", workspaceId, root, ...(project.profileId === undefined ? {} : { profileId: project.profileId }) });
    if (!registered.ok) return undefined;
    const added = registry.addFolder(project.id, { id: randomUUID(), workspaceId, root: (registered.value as { root: string }).root }, new Date().toISOString());
    if (added === undefined || !added.ok) return undefined;
    return added.project.folders.find(folder => folder.workspaceId === workspaceId);
  };
  /**
   * The status a worktree refusal is answered with. A dirty checkout keeps upstream's own 409 with its `dirty` marker,
   * because that is what makes the browser ask for an explicit force instead of discarding uncommitted work.
   */
  const worktreeFailureStatus = (code: string): number => code === "dirty" ? 409 : code === "not_supported" ? 501 : code === "unreachable" || code === "outcome_unknown" || code === "gateway_offline" ? 503 : code === "unknown_workspace" ? 404 : 400;
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
   * The host a **recorded Project's** metadata operations act on: the one the Project itself names, which the request
   * may only confirm. A Project's folders live on one host, recorded when it was created, and that is the identity the
   * operation belongs to — the calling Web origin's own host mapping says which computer it serves, not which host
   * every Project it can see is on. A named host that differs from the recorded one is still the caller asking for
   * another origin's Project, and is refused exactly as before; a caller that names none acts on the recorded host,
   * which is what lets a Web origin remove the remote Project it created without claiming it on its own gateway.
   */
  const projectHostOf = (project: ProjectRecord, named: string | undefined): { ok: true; connection: GatewayConnection } | { ok: false; error: string; mismatch: "wrong_host" | "configuration_required" } => {
    if (named !== undefined && named !== project.hostId) return { ok: false, error: "this project's folders are on gateway " + project.hostId + ", which this Web origin does not serve", mismatch: "wrong_host" };
    const connection = gateways.get(project.hostId);
    return connection === undefined
      ? { ok: false, error: "the gateway " + project.hostId + " this project's folders are on is not configured", mismatch: "configuration_required" }
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
  const conversations = new Map<string, ConversationRuntime>();
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
  const attach = async (conversation: Conversation, ancestry: Ancestry = {}): Promise<ConversationRuntime> => {
    const existing = getConversation(String(conversation.id));
    if (existing !== undefined) return existing;
    const workspaceId = await conversation.commit(async tx => (await tx.doc(WorkspaceDoc, conversation.id)).workspaceId, BACKGROUND_CONTEXT);
    // Adopted before anything reads this conversation, at the one point every conversation arrives through.
    await adoptMcpOffer(String(conversation.id));
    const attached = await attachConversation(conversation, runtime.harness, installed, workspaceId, options.workspaceResources === undefined ? undefined : () => resourceSummary(readCommitted, conversation.id, BACKGROUND_CONTEXT), () => readRunFailure(runtime.harness, conversation.id), () => readPendingSubmissions(runtime.harness, conversation.id), ancestry);
    conversations.set(String(conversation.id), attached);
    return attached;
  };
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
  let cursor: Cursor | undefined;
  while (true) {
    const stored = await runtime.harness.commit(tx => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
    for (const record of stored.items) {
      // The same framework record, for the same reason: the scan sees it because it is stored, and nothing lists it.
      if (String(record.id) === String(runtime.root.id)) continue;
      const conversation = await runtime.harness.conversation(record.id, BACKGROUND_CONTEXT);
      // The scan already holds each record, so the ancestry the catalogue reports costs no extra read.
      if (conversation !== undefined) await attach(conversation, {
        forkSource: record.parent === undefined ? undefined : String(record.parent.conversationId),
        subagentParent: record.owner === undefined ? undefined : String(record.owner.conversationId),
      });
    }
    if (!stored.next) break;
    cursor = stored.next;
  }
  /**
   * Every conversation any surface creates is attached as it is committed, so a child the model's own tool created is
   * in the catalogue, the watch and the chat window immediately — not only after the next boot scan. The listener runs
   * on the session line and must not block, so the attach is queued off it; the commit it saw is already durable.
   */
  const attachQueue: string[] = [];
  let drainingAttach = false;
  const drainAttach = async (): Promise<void> => {
    if (drainingAttach) return;
    drainingAttach = true;
    try {
      while (attachQueue.length > 0) {
        const id = attachQueue.shift()!;
        if (getConversation(id) !== undefined) continue;
        const record = await runtime.harness.commit(tx => tx.conversation(Number(id) as ConversationId), BACKGROUND_CONTEXT);
        if (record === undefined) continue;
        const conversation = await runtime.harness.conversation(record.id, BACKGROUND_CONTEXT);
        if (conversation === undefined) continue;
        await attach(conversation, {
          forkSource: record.parent === undefined ? undefined : String(record.parent.conversationId),
          subagentParent: record.owner === undefined ? undefined : String(record.owner.conversationId),
        });
      }
    } finally {
      drainingAttach = false;
    }
  };
  runtime.harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      if (change.type !== "conversation" || String(change.value.id) === String(runtime.root.id)) continue;
      const id = String(change.value.id);
      if (getConversation(id) !== undefined || attachQueue.includes(id)) continue;
      attachQueue.push(id);
    }
    if (attachQueue.length > 0) void drainAttach();
  });
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
   * The identity this deployment states to a client that asks who it is connected to. It is configuration, not a
   * negotiation: a client either speaks this build's protocol or it does not connect, and nothing here adapts to an
   * older one.
   */
  const backendId = options.backendId ?? process.env.HEPI_BACKEND_ID ?? "hepi-backend";
  /**
   * The capabilities this build really has, stated from what the caller configured rather than from what a client hopes
   * for. A capability a deployment did not configure is absent, which is the honest answer a client can act on.
   */
  const capabilitiesOf = (configured: Options): Record<string, boolean> => ({
    conversations: true,
    projects: configured.projects !== undefined,
    skillMarket: configured.skillMarket !== undefined,
    modelConfiguration: configured.modelConfig !== undefined,
    workspaceResources: configured.workspaceResources !== undefined,
    deviceCredentials: configured.deviceCredentials !== undefined,
  });
  /** The account scope every conversation, project and credential in this Backend belongs to. */
  const accountScope = options.accountScope ?? process.env.HEPI_ACCOUNT_SCOPE ?? "default";
  /**
   * The client identity the ingress admitted, which it states on every request it forwards.
   *
   * It travels on the ingress's own service-credential request, so this server does not have to re-derive an identity it
   * never saw: the ingress is the one surface that admits a client, and a header it sets is a fact about the request it
   * already authorized. A malformed one is refused rather than defaulted, because a descriptor that names the wrong
   * client is worse than no descriptor.
   */
  const readIdentity = (request: IncomingMessage, response: ServerResponse): { kind: "web" } | { kind: "device"; id: string; label: string } | undefined => {
    const header = request.headers["x-hepi-client"];
    const value = typeof header === "string" ? header : undefined;
    if (value === undefined) { json(response, 400, { error: "the client identity is required" }); return undefined; }
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { json(response, 400, { error: "the client identity is malformed" }); return undefined; }
    if (typeof parsed !== "object" || parsed === null) { json(response, 400, { error: "the client identity is malformed" }); return undefined; }
    const stated = parsed as { kind?: unknown; id?: unknown; label?: unknown };
    if (stated.kind === "web") return { kind: "web" };
    if (stated.kind === "device" && typeof stated.id === "string" && typeof stated.label === "string") return { kind: "device", id: stated.id, label: stated.label };
    json(response, 400, { error: "the client identity is malformed" });
    return undefined;
  };
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
  const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => json(response, 500, { error: safeFailure(error) })); });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && (url.pathname === "/diagnostics" || url.pathname === "/diagnostics.js")) {
      const script = url.pathname.endsWith(".js");
      const page = await readFile(new URL(script ? "../public/diagnostics.js" : "../public/diagnostics.html", import.meta.url));
      response.writeHead(200, { "content-type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }); response.end(page); return;
    }
    if (request.method === "GET" && (url.pathname === "/workbench" || url.pathname === "/workbench.js")) {
      const script = url.pathname.endsWith(".js");
      const page = await readFile(new URL(script ? "../public/workbench.js" : "../public/workbench.html", import.meta.url));
      response.writeHead(200, { "content-type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }); response.end(page); return;
    }
    if (!authorized(request, options.authToken)) { json(response, 401, { error: "unauthorized" }); return; }
    // The one client-facing description of this Backend. It states the identity a caller is connected to, the account
    // scope it is scoped to, the build that answered and the capabilities this build really has — and nothing a client
    // could infer a version negotiation from, because there is none: a client speaks this protocol or it does not
    // connect. The caller's own identity is added by the ingress that admitted it, so this route never guesses one.
    if (url.pathname === "/api/descriptor" && request.method === "GET") {
      const identity = readIdentity(request, response);
      if (identity === undefined) return;
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        client: identity,
        backend: { id: backendId },
        account: { scope: accountScope },
        build: { id: options.buildId ?? null },
        capabilities: capabilitiesOf(options),
      });
      return;
    }
    if (url.pathname === "/api/device-credentials") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return; }
      if (request.method === "GET") { json(response, 200, { credentials: options.deviceCredentials.list() }); return; }
      if (request.method === "POST") {
        const body = await readBody(request) as { label?: unknown } | undefined;
        if (typeof body?.label !== "string" || body.label.trim() === "") { json(response, 400, { error: "a label is required" }); return; }
        json(response, 201, options.deviceCredentials.issue({ label: body.label.trim() })); return;
      }
      json(response, 405, { error: "method not allowed" }); return;
    }
    if (url.pathname.startsWith("/api/device-credentials/") && request.method === "DELETE") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return; }
      const id = decodeURIComponent(url.pathname.slice("/api/device-credentials/".length));
      const revoked = options.deviceCredentials.revoke(id);
      json(response, revoked ? 200 : 404, revoked ? { ok: true, id } : { error: "unknown credential" }); return;
    }
    // One client request's authority, asked by the client ingress on every request it admits and again on the revocation
    // interval for a response that stays open. It is a check, never an issuance, and it answers with the credential's
    // identity only: the digest it was looked up by is never in the answer.
    if (url.pathname === "/internal/credentials/verify" && request.method === "POST") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return; }
      const body = await readBody(request) as { token?: unknown } | undefined;
      const checked = typeof body?.token === "string" && body.token !== "" ? options.deviceCredentials.check(body.token) : { ok: false as const, reason: "unknown" as const };
      json(response, 200, checked); return;
    }
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
    // The execution workspaces this backend can bind, each with the account its tools actually run as. Resolving the
    // account goes through the gateway's own executionHost answer, so a UI label can never substitute this process's
    // identity for the host's. An unreachable host is reported as such instead of being shown as the backend's account.
    if (request.method === "GET" && url.pathname === "/api/workspaces") {
      const workspaces = await Promise.all(registry.bindings().map(async (binding) => {
        const { id, gatewayId } = binding;
        // A binding a removal retained stays in this list — a conversation bound to it resolves its display root from
        // here — but says so, so no picker and no home/default-directory answer can offer it as a target.
        const marker = binding.retained === true ? { retained: true as const } : {};
        const result = await (gatewayEnvironment(binding, "/") as ExecutionHostEnv).executionHost(BACKGROUND_CONTEXT);
        return result.ok
          ? { id, gatewayId, ...marker, host: { user: result.value.user, home: result.value.home }, workspaceRoot: result.value.workspaceRoot }
          : { id, gatewayId, ...marker, hostError: boundedMessage(result.error.message) };
      }));
      json(response, 200, { workspaces }); return;
    }
    // The execution targets this deployment configured: each gateway's id, and for a gateway that serves remote
    // profiles, those profiles with the account the host itself reports. Ids and names only — never a gateway URL or
    // token — so the New Project dialog can offer a remote host explicitly instead of guessing one.
    if (request.method === "GET" && url.pathname === "/api/hosts") {
      const hosts = await Promise.all([...gateways.values()].map(async (connection) => {
        const listed = await hostProfiles(connection);
        return listed.ok
          ? { id: connection.gatewayId, profiles: listed.value }
          : { id: connection.gatewayId, profiles: [], error: listed.code };
      }));
      json(response, 200, { protocol: PROTOCOL_VERSION, hosts }); return;
    }
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
      const host = webHostOf(hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      if (!host.ok) { json(response, 409, { code: "configuration_required", error: host.error }); return; }
      if (!registry.canRecord()) { json(response, 500, { error: "project storage is not configured" }); return; }
      // A remote project names the one profile its folders are on. It is validated against what that gateway actually
      // serves, so a project can never be recorded against a profile the host does not have.
      const profileId = typeof body?.profileId === "string" && body.profileId.trim() !== "" ? body.profileId.trim() : undefined;
      if (profileId !== undefined) {
        const available = await hostProfiles(host.connection);
        if (!available.ok) { json(response, available.code === "gateway_offline" ? 503 : 502, { code: available.code, error: "the host's execution targets could not be read: " + available.code }); return; }
        if (!(available.value as readonly { id: string }[]).some(profile => profile.id === profileId)) { json(response, 400, { code: "unknown_profile", error: "gateway " + host.connection.gatewayId + " does not serve a profile named " + profileId }); return; }
      }
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > 120) { json(response, 400, { code: "invalid_request", error: "a project name of 1 to 120 characters is required" }); return; }
      if (!Array.isArray(body?.folders) || body.folders.length === 0) { json(response, 400, { code: "invalid_request", error: "at least one folder on the Web host is required" }); return; }
      const requested: { root: string; isDefault: boolean }[] = [];
      for (const entry of body.folders) {
        const folder = entry as { root?: unknown; default?: unknown };
        const root = typeof folder.root === "string" ? folder.root.trim() : "";
        if (root === "") { json(response, 400, { code: "invalid_request", error: "a folder on the Web host is required" }); return; }
        requested.push({ root, isDefault: folder.default === true });
      }
      const defaultCount = requested.filter(folder => folder.isDefault).length;
      if (defaultCount !== 1) { json(response, 400, { code: "invalid_request", error: "exactly one folder must be the default" }); return; }
      if (new Set(requested.map(folder => folder.root)).size !== requested.length) { json(response, 400, { code: "invalid_request", error: "the same folder cannot be added twice" }); return; }
      // Each folder's workspace id is opaque and unrelated to its path: a later default change picks another workspace
      // instead of moving one that existing conversations are already bound to. The ids are minted before the roots are
      // registered so a folder keeps its id across the whole request.
      const candidates = requested.map(folder => ({ id: randomUUID(), workspaceId: randomUUID(), root: folder.root, isDefault: folder.isDefault }));
      const folders: { id: string; workspaceId: string; root: string }[] = [];
      for (const candidate of candidates) {
        const registered = await hostRequest(host.connection, { operation: "register", workspaceId: candidate.workspaceId, root: candidate.root, ...(profileId === undefined ? {} : { profileId }) });
        if (!registered.ok) { json(response, registered.status, { code: registered.code, error: "the folder was not accepted on the Web host: " + registered.code }); return; }
        folders.push({ id: candidate.id, workspaceId: candidate.workspaceId, root: (registered.value as { root: string }).root });
      }
      const defaultCandidate = candidates.find(candidate => candidate.isDefault)!;
      let project: ProjectRecord;
      try {
        // The registry owns the recorded Project, the live snapshot it publishes and the revision: a route that wrote
        // any of the three itself could publish a Project no lookup resolves, or resolve one no store holds.
        const created = registry.create({ id: randomUUID(), name, hostId: host.connection.gatewayId, ...(profileId === undefined ? {} : { profileId }), defaultFolderId: defaultCandidate.id, folders, createdAt: new Date().toISOString() });
        if (created === undefined) { json(response, 500, { error: "project storage is not configured" }); return; }
        project = created;
      } catch (error) { json(response, 500, { error: safeFailure(error) }); return; }
      json(response, 201, { protocol: PROTOCOL_VERSION, project: projectView(project) }); return;
    }
    // Naming another of a project's own folders the default: new conversations bind it from then on, while every
    // conversation already bound keeps the folder it has. This is the metadata contract ticket 08 defines; no editor
    // for it is part of this phase.
    if (request.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      const project = registry.projects().find(item => item.id === projectId);
      if (project === undefined) { json(response, 404, { code: "unknown_project", error: "no project with that id is recorded" }); return; }
      if (!registry.canRecord()) { json(response, 500, { error: "project storage is not configured" }); return; }
      const body = await readBody(request) as { hostId?: unknown; defaultFolderId?: unknown } | undefined;
      // The recorded Project names its host; a named one may only confirm it (see `projectHostOf`). Naming a remote
      // Project's own host is what a Web origin does when it edits a folder there, and it stays accepted.
      const host = projectHostOf(project, hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      if (!host.ok) { json(response, 409, { code: host.mismatch, error: host.error }); return; }
      const defaultFolderId = typeof body?.defaultFolderId === "string" ? body.defaultFolderId : "";
      if (defaultFolderId === "") { json(response, 400, { code: "invalid_request", error: "a folder of this project is required" }); return; }
      const changed = registry.setDefault(project.id, defaultFolderId);
      if (changed === undefined) { json(response, 500, { error: "project storage is not configured" }); return; }
      if (!changed.ok) { json(response, changed.code === "unknown_project" ? 404 : 400, { code: changed.code, error: changed.code === "unknown_project" ? "no project with that id is recorded" : "that folder does not belong to this project" }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(changed.project) }); return;
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
      const project = registry.projects().find(item => item.id === decodeURIComponent(projectId!));
      if (project === undefined) { json(response, 404, { code: "unknown_project", error: "no project with that id is recorded" }); return; }
      if (!registry.canRecord()) { json(response, 500, { error: "project storage is not configured" }); return; }
      const host = projectHostOf(project, hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!host.ok) { json(response, 409, { code: host.mismatch, error: host.error }); return; }
      const replacement = namedHostId(url.searchParams.get("defaultFolderId"));
      const unlinked = registry.unlink(project.id, decodeURIComponent(folderId!), replacement);
      if (unlinked === undefined) { json(response, 500, { error: "project storage is not configured" }); return; }
      if (!unlinked.ok) {
        const refusal = unlinked.code === "unknown_project" ? { status: 404, error: "no project with that id is recorded" }
          : unlinked.code === "unknown_folder" ? { status: 400, error: "that folder is not another folder of this project" }
          : unlinked.code === "unexpected_replacement" ? { status: 400, error: "only the default folder's removal names a replacement default" }
          : { status: 400, error: "removing this project's default folder requires another folder of this project as the replacement default" };
        json(response, refusal.status, { code: unlinked.code, error: refusal.error }); return;
      }
      // The registry already followed the answer: the folder that left is gone from its live snapshot, the
      // replacement it named is the default, the project itself is gone when its last folder was, the folder's binding
      // is retained from here on, and the revision moved once — so a conversation that already holds the folder
      // re-registers and resolves it like any other retained record.
      json(response, 200, { protocol: PROTOCOL_VERSION, project: unlinked.project === null ? null : projectView(unlinked.project), removedFolderId: unlinked.removedFolderId }); return;
    }
    // Removing a project removes metadata only: the project record and its folder links go, in one transaction with
    // the retained binding of every folder, and nothing else changes. No directory on the host is created, changed or
    // deleted, no conversation is deleted, no workspace id is reused and no host registration is undone. Nothing is
    // refused because conversations are bound — no conversation is read here at all — and the retained bindings keep
    // the removed folders resolvable for the conversations that already hold them while never becoming a target for a
    // new one.
    if (request.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      const project = registry.projects().find(item => item.id === projectId);
      if (project === undefined) { json(response, 404, { code: "unknown_project", error: "no project with that id is recorded" }); return; }
      if (!registry.canRecord()) { json(response, 500, { error: "project storage is not configured" }); return; }
      const host = projectHostOf(project, hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!host.ok) { json(response, 409, { code: host.mismatch, error: host.error }); return; }
      const removed = registry.remove(project.id);
      if (removed === undefined) { json(response, 500, { error: "project storage is not configured" }); return; }
      if (!removed.ok) { json(response, 404, { code: "unknown_project", error: "no project with that id is recorded" }); return; }
      // This process keeps serving the removed folders from here on: the retained records are what the next
      // conversation request re-registers and what the workspace list answers their display root from.
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(removed.project) }); return;
    }
    // A project's checkouts, and the two mutations of them, on the execution host that holds the project's folders.
    // The host owns the git work — which checkouts a registered root has, one created on a branch, one removed, and
    // git's own refusal of a dirty checkout — and this route adds the two hepi-owned facts the browser needs:
    //
    // - a created checkout is recorded as a folder of the project, because a conversation binds a workspace id and a
    //   root hepi holds no record of is a root no conversation can run in. The host canonicalizes and registers the
    //   root first; the record is written only after the host accepted it.
    // - a removed checkout's folder record goes with it, in the same request, and its binding is retained, so a
    //   conversation already bound to that checkout keeps running while the checkout is no longer a target.
    //
    // The request names a workspace id, exactly as the host's own `/v1/worktrees` surface does, and every refusal
    // keeps its own name: `dirty` for git's refusal of uncommitted work, `not_supported` for a host that cannot
    // serve the capability, `unreachable`/`outcome_unknown` for a transport failure, and the project's own
    // `default_folder`/`last_folder` when a checkout cannot leave the project's folder list.
    if (request.method === "POST" && url.pathname === "/api/worktrees") {
      const body = await readBody(request) as { workspaceId?: unknown; operation?: unknown; branch?: unknown; path?: unknown; force?: unknown } | undefined;
      const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
      const operation = typeof body?.operation === "string" ? body.operation : "";
      const binding = await ensureBinding(workspaceId === "" ? undefined : workspaceId);
      if (binding === undefined) { json(response, 404, { ok: false, code: "unknown_workspace", message: "this deployment serves no such workspace" }); return; }
      const resolved = registry.resolve(workspaceId === "" ? undefined : workspaceId);
      // The folder a checkout is recorded as: the project's own list is the only place a target for a new conversation
      // can come from, so a workspace that belongs to no project has no checkout to offer and says so.
      const projectOf = (): ProjectRecord | undefined => resolved?.kind === "project" ? resolved.project : undefined;
      const forward = (result: { ok: true; value: unknown } | { ok: false; code: string; message?: string }, status = 200): void => {
        if (result.ok) { json(response, 200, { ok: true, value: result.value }); return; }
        json(response, worktreeFailureStatus(result.code), { ok: false, code: result.code, error: result.message ?? result.code, ...(result.code === "dirty" ? { dirty: true } : {}) });
      };
      if (operation === "list") {
        const listed = await hostWorktreeRequest(binding, { operation: "list", workspaceId });
        if (!listed.ok) { forward(listed); return; }
        const listing = listed.value as WorktreeListing;
        // Each checkout is addressed by the folder the project records for its root: a checkout hepi holds no record
        // of is listed truthfully and is simply not a target, which is what the browser shows.
        const project = projectOf();
        const worktrees = listing.worktrees.map(entry => {
          const folder = project?.folders.find(candidate => candidate.root === entry.path);
          return { path: entry.path, branch: entry.branch, isMain: entry.isMain, ...(folder === undefined ? {} : { workspaceId: folder.workspaceId }) };
        });
        json(response, 200, { ok: true, value: { isGit: listing.isGit, isTopLevel: listing.isTopLevel, currentWorktreePath: listing.currentWorktreePath, worktrees } });
        return;
      }
      if (operation === "create") {
        const project = projectOf();
        if (project === undefined) { json(response, 400, { ok: false, code: "not_a_project_folder", error: "this folder is not a Project folder, so a worktree of it cannot be a conversation target" }); return; }
        const branch = typeof body?.branch === "string" ? body.branch : "";
        const created = await hostWorktreeRequest(binding, { operation: "create", workspaceId, branch });
        if (!created.ok) { forward(created); return; }
        const made = created.value as { path: string; branch: string };
        const folder = await folderForCheckout(project, made.path);
        if (folder === undefined) {
          // The checkout exists on the host but hepi could not record it, so nothing may claim it is a target. The
          // host's own root is what was registered, and the browser is told exactly that.
          json(response, 502, { ok: false, code: "not_recorded", error: "the checkout was created on the host but this deployment could not record it as a target: " + made.path });
          return;
        }
        json(response, 200, { ok: true, value: { path: made.path, branch: made.branch, workspaceId: folder.workspaceId } });
        return;
      }
      if (operation === "remove") {
        const path = typeof body?.path === "string" ? body.path : "";
        if (path === "") { json(response, 400, { ok: false, code: "invalid_request", error: "a worktree path is required" }); return; }
        const project = projectOf();
        const folder = project?.folders.find(candidate => candidate.root === path);
        // The project always keeps a default, so its default checkout is not removable here: naming a replacement is
        // ticket 08's own rule, and refusing before git touches anything keeps the project's folder list and the
        // host's checkouts from disagreeing about which checkout a conversation may still run in.
        if (project !== undefined && folder !== undefined && project.defaultFolderId === folder.id) {
          json(response, 409, { ok: false, code: "default_folder", error: "this checkout is this Project's default folder; name another folder the default first" });
          return;
        }
        const removed = await hostWorktreeRequest(binding, { operation: "remove", workspaceId, path, force: body?.force === true });
        if (!removed.ok) { forward(removed); return; }
        if (project !== undefined && folder !== undefined) {
          // The record that made the checkout a target is dropped by the one unlink operation the folder route also uses,
          // so a checkout removal and a folder unlink keep the same retained binding in the same transaction.
          const dropped = registry.unlink(project.id, folder.id);
          if (dropped === undefined || !dropped.ok) { json(response, 502, { ok: false, code: "not_recorded", error: "the checkout was removed on the host but this deployment could not drop its folder record" }); return; }
          // The default folder is refused above, so the project survives; the registry already applied both outcomes to
          // its snapshot and retained the folder's binding, exactly as the folder route's unlink does.
        }
        json(response, 200, { ok: true, value: removed.value });
        return;
      }
      json(response, 400, { ok: false, code: "invalid_request", error: "unknown worktree operation" });
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
    // The model configuration the Settings editor reads and saves. It is the backend's own agent-directory models.json
    // and the runtime that serves it, so a save is validated, written and applied to the same authority that answers the
    // next request. There is no second registry and no synthetic seed: an unconfigured environment deployment is an
    // environment-owned base provider, not a file entry, so an empty file reads as empty instead of pretending otherwise.
    if (url.pathname === "/api/models-config") {
      const target = options.modelConfig;
      if (target === undefined) { json(response, 404, { error: "model configuration is not owned by this backend" }); return; }
      if (request.method === "GET") {
        try {
          json(response, 200, readModelConfig(target.path));
        } catch {
          // The read error can quote the file's own bytes, which may include a credential reference.
          json(response, 500, { error: "models.json could not be read; fix the file on the backend host" });
        }
        return;
      }
      if (request.method === "PUT") {
        const result = await saveModelConfig(target, await readBody(request));
        // Three outcomes stay distinct: a rejected draft leaves the file and the running runtime untouched; a saved
        // draft that could not be applied is reported as saved-but-not-applied instead of as success.
        if (result.status === "invalid") { json(response, 400, { success: false, error: result.error }); return; }
        json(response, 200, result.applied ? { success: true, applied: true } : { success: true, applied: false, error: result.error });
        return;
      }
      json(response, 405, { error: "method not allowed" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      // Resolving credentials is the only fallible work of this route, and the raw rejection can quote auth.json or
      // models.json: upstream `AuthStorage.readLatestData` parses auth.json without wrapping, so the failure here is a
      // bare `SyntaxError` whose message contains the file's first bytes. Report the safe text instead.
      let available;
      try {
        available = await runtime.models.getAvailable();
      } catch {
        json(response, 500, { error: SAFE_CREDENTIAL_ERROR });
        return;
      }
      const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
      const models = available.map((model) => {
        const thinkingLevelMap = projectThinkingLevelMap(model.thinkingLevelMap);
        if (thinkingLevelMap !== undefined) thinkingLevelMaps[model.provider + ":" + model.id] = thinkingLevelMap;
        return { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: projectCost(model.cost), input: [...model.input], thinkingLevelMap };
      });
      // `defaultModel` is stated explicitly, including as null: a deployment that configured none must not leave the
      // field absent, because a client would then read the absence as "unspecified" and pick something itself.
      json(response, 200, { models, thinkingLevels: Object.fromEntries(available.map(model => [model.provider + ":" + model.id, getSupportedThinkingLevels(model)])), thinkingLevelMaps, defaultModel: runtime.model ?? null, defaultThinkingLevel: options.defaultThinkingLevel ?? "off" }); return;
    }
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
    // The sidebar's shared state: pins, archive, project order and the unread marker, as one session-scoped
    // document, so every client of this backend reads and writes the same arrangement. One change per request, and the
    // answer is the state after the change, so a client never has to guess what happened. A body over the documented
    // limit is refused before it is read, and a body that is not this protocol's is refused with the reason.
    if (url.pathname === "/api/sidebar-state") {
      if (request.method === "GET") { json(response, 200, { protocol: PROTOCOL_VERSION, state: await readSidebarState(runtime.harness) }); return; }
      if (request.method === "POST") {
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") { sidebarRefusal(response, 415, "content-type", "Content-Type must be application/json"); return; }
        let body: unknown;
        try {
          body = await readBody(request, MAX_SESSION_UI_REQUEST_BYTES);
        } catch (error) {
          sidebarRefusal(response, 413, "too-large", safeFailure(error));
          return;
        }
        const parsed = parseSessionUiStateRequest(body);
        if (!parsed.ok) { sidebarRefusal(response, 400, "invalid-request", parsed.error); return; }
        json(response, 200, { protocol: PROTOCOL_VERSION, state: await writeSidebarState(runtime.harness, parsed.request) }); return;
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
    const parts = url.pathname.split("/").filter(Boolean);
    const id = parts[2];
    const item = id === undefined ? undefined : getConversation(id);
    // Every conversation-scoped route refuses an unknown conversation the same way, with the code a caller needs to
    // name the refusal in its own language rather than echoing an English sentence.
    if (parts[0] !== "api" || parts[1] !== "conversations" || item === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return; }
    const action = parts[3];
    // One conversation's identity: its catalogue row plus the relations it records, its native record edges, the
    // references it makes and its effective configuration. The row comes from the same catalogue projection the list
    // uses, and the rest from the one relations seam, so a by-id read and a list read cannot state two creators. A
    // removed conversation still answers — its records are retained — and its relations stay readable.
    if (request.method === "GET" && parts.length === 3) {
      const info = await operations.get(id);
      if (info === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, conversation: catalogueEntry(item, await catalogueFacts()), ...info }); return;
    }
    // The bounded raw history of one conversation. What the stream and `state` carry is the **active window**; this is
    // the entry table's own fork-aware record, so a compaction's dropped prefix and a fork's inherited prefix are both
    // readable here. The body is text lines or one image, everything else is stated in `details` and `diagnostics`,
    // and `cursor` continues a page exactly where it stopped. Query: `offset`, `limit`, `entryId`, `blockIndex`,
    // `tail`, `cursor`. The one read every caller shares: `agent_read` calls the same operation.
    if (request.method === "GET" && action === "read" && parts.length === 4) {
      const answer = await handleConversationRead(operations, id, url.searchParams);
      json(response, answer.status, answer.body); return;
    }
    // The navigation outline: one bounded page of this conversation's committed user messages, read from its
    // **fork-aware committed history** rather than the active window, so a compaction's dropped prefix and a fork's
    // inherited prefix stay enumerable. Each anchor carries an opaque coordinate over the conversation, the history
    // scope and the entry it names, and a short preview of the committed user text — no message body, and no
    // unbounded index: `limit` is capped, the page is measured, and `nextCursor` continues where it stopped. The
    // identity it states is the window's own `historyRevision` token plus its append-invariant scope part, so a
    // caller can tell an append (which extends the outline and keeps every anchor) from a re-baseline (which retires
    // the page, by name). Query: `limit`, `cursor`, `scope`.
    if (request.method === "GET" && action === "navigation" && parts.length === 4) {
      const facts = item.historyFacts();
      const answer = await handleConversationNavigation(
        { conversation: item.conversation, snapshot: tokenFromFacts(id, facts), scope: scopeFromFacts(id, facts), tail: facts.tail },
        id,
        url.searchParams,
      );
      json(response, answer.status, answer.body); return;
    }
    // The bounded target window one of the outline's own coordinates addresses: the committed history around that
    // entry, projected by the **same** expression the stream and an older page are projected by (so a target entry
    // and a live entry cannot differ, and the deferred read blocks behind a heavy block are the same URLs), bounded
    // by the two message counts the caller asks for and by the page byte budget, and read against the snapshot the
    // caller names so an append cannot move the window under it. The membership fence is the runtime's own
    // membership-checked scan, which is why a compacted entry is readable, a fork's inherited entry is readable in
    // the fork, and an entry of a sibling branch is `missing` rather than silently absent from a window that looks
    // complete. The route carries no second projection and no history derivation of its own. Query: `anchor`,
    // `before`, `after`, `snapshot`, `entry`, `block`.
    if (request.method === "GET" && action === "navigation" && parts[4] === "around" && parts.length === 5) {
      const facts = item.historyFacts();
      const answer = await handleConversationNavigationTarget(
        { conversation: item.conversation, snapshot: tokenFromFacts(id, facts), scope: scopeFromFacts(id, facts), tail: facts.tail, project: entry => projectEntry(entry, id) },
        id,
        url.searchParams,
      );
      json(response, answer.status, answer.body); return;
    }
    // The browser's own delegation, over the **same** seam the model's two delegating tools call. The user picked the
    // definition and wrote the task in the main conversation's composer; the definition decides the configuration and
    // the context strategy, and the request carries neither, so a quick create cannot override the policy the
    // definition or the user's configuration set (spec D01, D10, D11).
    //
    // The body names a definition and a task. `conversationId` addresses a conversation that already exists — the
    // child tree's own "delegate again" — and its absence means a child this request creates. `requestId` is the
    // caller's stable attempt identity: a retry after a lost answer is answered with the child or the dispatch the
    // first attempt made rather than a second one (spec D04, A19).
    //
    // Every refusal is the answer and never a queue entry: an over-limit request, an unresolvable definition and a
    // user's own stop on the target are all stated with the code that names them (spec D12, A15).
    if (request.method === "POST" && action === "delegate" && parts.length === 4) {
      const body = await readBody(request) as { name?: unknown; task?: unknown; conversationId?: unknown; requestId?: unknown } | undefined;
      if (typeof body?.name !== "string" || body.name.trim() === "") { json(response, 400, { code: "invalid_request", error: "name is the agent definition to run" }); return; }
      if (typeof body.task !== "string" || body.task.trim() === "") { json(response, 400, { code: "invalid_request", error: "task is the child's complete task" }); return; }
      const requestId = typeof body.requestId === "string" && body.requestId.trim() !== "" ? body.requestId : randomUUID();
      // A dispatch to a conversation that already exists is a different operation: it creates nothing, and the target
      // keeps its identity, its history and its configuration (spec D05).
      if (body.conversationId !== undefined) {
        if (typeof body.conversationId !== "string" || body.conversationId.trim() === "") { json(response, 400, { code: "invalid_request", error: "conversationId must be a conversation id" }); return; }
        const dispatched = await delegation.dispatch({ delegating: id, requestId, targetConversationId: body.conversationId, task: body.task });
        if (!dispatched.ok) { json(response, dispatched.code === "not_found" ? 404 : 409, { protocol: PROTOCOL_VERSION, code: dispatched.code, error: dispatched.message }); return; }
        const target = getConversation(dispatched.conversationId);
        json(response, 202, {
          protocol: PROTOCOL_VERSION,
          conversationId: dispatched.conversationId,
          dispatchId: dispatched.dispatchId,
          requestId,
          ...(dispatched.submissionId === "" ? {} : { submissionId: dispatched.submissionId }),
          ...(target === undefined ? {} : { conversation: catalogueEntry(target, await catalogueFacts()) }),
        }); return;
      }
      const answered = await delegation.delegate({ delegating: id, requestId, definition: body.name, task: body.task });
      if (!answered.ok) {
        // The refusals a caller has to tell apart are the ones a user can act on: an over-limit request is a refusal and
        // not a queue, and an unresolvable definition is a configuration problem rather than a conflict.
        const status = answered.code === "depth_exceeded" || answered.code === "children_exceeded" ? 409
          : answered.code === "unknown_definition" || answered.code === "no_execution_host" || answered.code === "unknown_workspace" ? 404
          : 400;
        json(response, status, { protocol: PROTOCOL_VERSION, code: answered.code, error: answered.message }); return;
      }
      const existing = getConversation(answered.childConversationId);
      const attached = existing ?? await (async () => {
        const record = await runtime.harness.conversation(Number(answered.childConversationId) as ConversationId, BACKGROUND_CONTEXT);
        return record === undefined ? undefined : attach(record, { subagentParent: id });
      })();
      json(response, answered.created ? 201 : 200, {
        protocol: PROTOCOL_VERSION,
        ...delegateDetails(answered) as object,
        ...(attached === undefined ? {} : { conversation: catalogueEntry(attached, await catalogueFacts()) }),
      }); return;
    }
    //
    // **One delegated child's recovery facts, and the retry of its preparation** (the audit's G2 and G6).
    //
    // The read answers what the runtime already holds per durable object — the dispatch record, the anchor's phase,
    // and where that dispatch's report stands — beside the child's own `runStatus`, which this does not replace. No
    // second status store and no whole-child flag: a conversation with no delegation under it answers `null`.
    //
    // The write is the retry the delegation seam **already** supports, and nothing else: it takes the dispatch/request
    // identity the read answered with and the failed attempt's own task id, and performs the one write
    // `retryPreparation` performs when a caller replays its own delegation request (spec D11, A14). Same child, same
    // dispatch, no second admission and no fresh identity — and no automatic retry anywhere: an identity that no longer
    // matches what the record states is refused by name rather than retried into a different attempt. The answer
    // restates the child's recovery facts, because the retry write is durable and the parked anchor acts on it on its
    // own schedule: what the caller reads back is the record's state, not a promise about a task.
    if (request.method === "GET" && action === "recovery" && parts.length === 4) {
      const recovery = await childRecovery(runtime.harness, id);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, ...(recovery === undefined ? { recovery: null } : { recovery }) });
      return;
    }
    if (request.method === "POST" && action === "recovery" && parts.length === 4) {
      const body = await readBody(request) as { requestId?: unknown; failedTaskId?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is the dispatch identity the recovery read answered with" }); return; }
      if (typeof body.failedTaskId !== "string" || body.failedTaskId.trim() === "") { json(response, 400, { code: "invalid_request", error: "failedTaskId is the preparation attempt this retry names" }); return; }
      const target = await preparationRetryTarget(runtime.harness, id);
      if (!target.ok) { json(response, 409, { protocol: PROTOCOL_VERSION, code: target.code, error: target.message }); return; }
      if (target.requestId !== body.requestId || target.failedTaskId !== body.failedTaskId) {
        json(response, 409, { protocol: PROTOCOL_VERSION, code: "identity_stale", error: "conversation " + id + " now states dispatch " + target.requestId + " and failed attempt " + target.failedTaskId + ", so this request names a different attempt" });
        return;
      }
      await subagentHost.retryPreparation(target.delegatingConversationId, target.requestId, target.failedTaskId);
      const recovery = await childRecovery(runtime.harness, id);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: target.requestId, failedTaskId: target.failedTaskId, recovery });
      return;
    }
    // A structured reference from this conversation to another, optionally to one entry of it. It is saved as this
    // conversation's own state: the target's relations, workspace and owner are untouched, and the reference grants no
    // control over it and copies none of its content. A repeated reference to the same target **and entry** is
    // idempotent, and one that could not be followed is refused by name before anything is stored — a removed target
    // is `target-unavailable`, an entry outside the target's visible committed fork-aware history is `entry-missing`
    // or `entry-out-of-scope` — so the answer states the same named outcome the resolving read reports later.
    if (request.method === "POST" && action === "references" && parts.length === 4) {
      const body = await readBody(request) as { conversationId?: unknown; entryId?: unknown; label?: unknown } | undefined;
      if (typeof body?.conversationId !== "string" || body.conversationId.trim() === "") { json(response, 400, { code: "invalid_request", error: "conversationId is required" }); return; }
      if (body.entryId !== undefined && typeof body.entryId !== "string") { json(response, 400, { code: "invalid_request", error: "entryId must be an entry id string" }); return; }
      if (body.label !== undefined && typeof body.label !== "string") { json(response, 400, { code: "invalid_request", error: "label must be a string" }); return; }
      try {
        const references = await operations.addReference(id, { conversationId: body.conversationId, ...(body.entryId === undefined ? {} : { entryId: body.entryId }), ...(body.label === undefined ? {} : { label: body.label }) });
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: id, references }); return;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
    }
    // The window's own statement, on the read a client makes before it has a stream: the same bounded entries the
    // stream's first frame carries, with the facts that say what the window is.
    if (request.method === "GET" && action === "state") {
      const current = item.snapshot();
      const oversize = oversizeFrame(current, current.entries.at(-1)?.id ?? null);
      // A read that cannot be carried answers a named reason and the entry that caused it. The entry stays readable
      // through its own route, so the caller is told the first load could not be bounded rather than being handed a
      // transcript that claims to be complete. No unbounded mode is added here: a consumer that needs everything pages.
      if (oversize !== undefined) { json(response, 413, { protocol: PROTOCOL_VERSION, conversationId: id, revision: current.revision, reason: "frame_too_large", ...oversize }); return; }
      json(response, 200, current); return;
    }
    // Older history, by entry id. `before` is **exclusive** and is the oldest id the client already holds — the
    // meaning the copied app's own paging gives it — so prepending a page never duplicates the boundary entry. The
    // page is bounded below by the newest head marker at or before it, so it can never hand back entries the active
    // context has left behind, and it applies the same count rule, the same byte budget and the same projection
    // expression as the stream, so a paged entry and a streamed entry cannot differ.
    if (request.method === "GET" && action === "entries" && parts.length === 4) {
      const before = url.searchParams.get("before");
      if (before !== null && !/^[0-9]+$/.test(before)) { json(response, 400, { code: "invalid_request", error: "before must be an entry id" }); return; }
      const requested = Number(url.searchParams.get("tail") ?? String(VISIBLE_WINDOW));
      if (!Number.isInteger(requested) || requested <= 0) { json(response, 400, { code: "invalid_request", error: "tail must be a positive integer" }); return; }
      const page = pageEntries(item, before === null ? undefined : Number(before) as EntryId, Math.min(requested, 1000));
      // The page answers the same question the window does about its own size, and for the same reason: a page that
      // cannot be carried must say so by name rather than hand back a body the transport would have refused. The
      // entry it names is the one the budget could not shrink away, and its own read block still serves it whole.
      const oversize = oversizeFrame(page, page.entries.at(-1)?.id ?? null);
      if (oversize !== undefined) { json(response, 413, { protocol: PROTOCOL_VERSION, conversationId: id, reason: "frame_too_large", ...oversize }); return; }
      json(response, 200, page); return;
    }
    // One entry, projected and redacted exactly as the stream projects it. It is the read block a deferred history
    // entry names: the full entry stays reachable by id even when the frame that would have carried it could not be.
    if (request.method === "GET" && action === "entries" && parts.length === 5) {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const projected = entry === undefined ? undefined : projectEntry(entry, id);
      if (projected === undefined) { json(response, 404, { code: "not_found", error: "entry not found" }); return; }
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entry: projected }); return;
    }
    // The thinking read block: the full text of one block of one entry, which is what a deferred preview replaced.
    // The provider's opaque signature stays native — nothing renders it and nothing sends it back from a projected
    // entry — so this route restores the thinking a user can read and nothing else.
    if (request.method === "GET" && action === "entries" && parts.length === 6 && parts[5] === "thinking") {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const content = entry?.model?.[0]?.content;
      if (!Array.isArray(content)) { json(response, 404, { code: "not_found", error: "entry not found" }); return; }
      const blockIndex = Number(url.searchParams.get("blockIndex") ?? "0");
      const block = Number.isInteger(blockIndex) ? content[blockIndex] : undefined;
      if (block === undefined) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return; }
      // One bounded page, in the same shape the text block answers: a thinking block can be long, and restoring it must
      // not mean handing over an unbounded body. `thinking` is the field this family's own name, and the page facts
      // ride beside it, so a caller follows `nextOffset` exactly as it would for a text.
      const bounds = parseReadBlockQuery(url.searchParams);
      if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return; }
      const page = readBlockTextPage(block.type === "thinking" ? block.thinking : "", bounds.offset, bounds.limit);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, thinking: page.text, offset: page.offset, totalBytes: page.totalBytes, truncated: page.truncated, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) }); return;
    }
    // The text read block: the full text a deferred **text** preview replaced. It is the third member of the family the
    // thinking and tool-result-image blocks already form, resolved through the same fork-aware history read, so the
    // entry a preview names is restored by the same primitive that restores the other two and nothing about entry
    // scope is decided twice.
    //
    // The block index addresses the **native** content: a text-only prompt is stored as a plain string rather than as
    // an array of blocks, so that shape answers index 0 with the whole string. A block index outside the content, or a
    // block that is not text, answers the reason it could not be served rather than an empty string that a caller
    // would render as an empty message.
    if (request.method === "GET" && action === "entries" && parts.length === 6 && parts[5] === "text") {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const content = entry?.model?.[0]?.content;
      if (content === undefined) { json(response, 404, { code: "not_found", error: "entry not found" }); return; }
      const blockIndex = Number(url.searchParams.get("blockIndex") ?? "0");
      if (!Number.isInteger(blockIndex) || blockIndex < 0) { json(response, 400, { code: "invalid_request", error: "blockIndex must be a non-negative integer" }); return; }
      if (typeof content === "string") {
        if (blockIndex !== 0) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return; }
        const bounds = parseReadBlockQuery(url.searchParams);
        if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return; }
        const page = readBlockTextPage(content, bounds.offset, bounds.limit);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, ...page }); return;
      }
      const block = Array.isArray(content) && blockIndex < content.length ? content[blockIndex] : undefined;
      if (block === undefined) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return; }
      if ((block as { type?: unknown }).type !== "text") { json(response, 404, { code: "not_found", error: "this block is not text" }); return; }
      const bounds = parseReadBlockQuery(url.searchParams);
      if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return; }
      const page = readBlockTextPage(String((block as { text?: unknown }).text ?? ""), bounds.offset, bounds.limit);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, ...page }); return;
    }
    // The image read block: exactly the bytes the frame's deferred URL names. It serves the image block of **any**
    // entry, because the policy that decided the frame's shape is the message's, not its role's: a user's own accepted
    // prompt image is deferred to this same block. An image the policy would not defer is refused with a named reason
    // rather than served anyway.
    if (request.method === "GET" && action === "entries" && parts.length === 6 && parts[5] === "tool-result-image") {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const content = entry?.model?.[0]?.content;
      const blockIndex = Number(url.searchParams.get("blockIndex") ?? "0");
      const block = Array.isArray(content) && Number.isInteger(blockIndex) ? content[blockIndex] : undefined;
      const image = readBlockImage(block);
      if (image === undefined) { json(response, 404, { code: "not_found", error: "image not found" }); return; }
      if (!TOOL_RESULT_IMAGE_MIMES.has(image.mimeType) || image.bytes > MAX_TOOL_RESULT_IMAGE_BYTES) { json(response, 415, { code: "image_not_served", error: "this image is outside the tool-result image policy" }); return; }
      // A bounded answer: a caller that only needs a window of the image asks for a byte range and gets those bytes,
      // decoded from the groups the range touches rather than from a copy of the whole image. The refusal for a range
      // outside the block is a 416, so a client learns to ask differently instead of receiving an empty body it would
      // render as a broken image.
      const answer = readBlockImageAnswer(image, request.headers.range);
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body); return;
    }
    // Recovery, not the normal path: a client whose send or stream ended before it could tell admission from failure
    // asks the conversation about the one submission it made, by the request id it generated. The answer is the durable
    // record itself — terminal or not — so nothing is inferred and nothing is resent. An id this conversation never
    // admitted answers null, which is a statement about that request and not a failed lookup.
    if (request.method === "GET" && action === "submissions") {
      const requestId = url.searchParams.get("requestId");
      if (requestId === null || requestId.trim() === "") { json(response, 400, { error: "requestId required" }); return; }
      const record = await item.conversation.commit(tx => tx.submissionByRequest(item.conversation.id, requestId), BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, submission: record === undefined ? null : projectSubmission(record) }); return;
    }
    if (request.method === "GET" && action === "commands") {
      // Commands come from the catalog in effect for this conversation alone: listing never rediscovers the execution
      // host, and a candidate deferred to the next run is listed so the UI shows what that run will adopt.
      const adopted = options.workspaceResources === undefined ? undefined : await readEffectiveResources(readCommitted, item.conversation.id, BACKGROUND_CONTEXT);
      json(response, 200, { commands: adopted === undefined ? [] : options.workspaceResources!.commands(adopted) }); return;
    }
    // Rename: the name a user sets for a conversation, stored as this conversation's own hepi document. The
    // request and response shape follow upstream's `PATCH /api/sessions/[id]` ({ name }) so the existing browser
    // surface keeps its contract, while the state it writes is durable conversation-scoped hepi state and not a file.
    if (request.method === "PATCH" && parts.length === 3) {
      const body = await readBody(request) as { name?: unknown } | undefined;
      const title = typeof body?.name === "string" ? body.name.trim() : undefined;
      if (title === undefined) { json(response, 400, { code: "invalid_request", error: "name is required" }); return; }
      if (title === "") { json(response, 400, { code: "invalid_request", error: "a session name of 1 to " + MAX_TITLE_LENGTH + " characters is required" }); return; }
      if ([...title].length > MAX_TITLE_LENGTH) { json(response, 400, { code: "invalid_request", error: "a session name of 1 to " + MAX_TITLE_LENGTH + " characters is required" }); return; }
      await item.conversation.commit(async (tx) => { (await tx.doc(TitleDoc, item.conversation.id)).title = title; }, BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, name: title }); return;
    }
    // Auto-name, on an explicit request only (spec decisions 16 and 25): the name is generated from this
    // conversation's own committed transcript by the model this conversation already selected, and written as the
    // same hepi title document the rename writes, so the catalogue lists it in the read that lists the session. No
    // path names a conversation implicitly, and a name the user typed is replaced only here, by this request. The
    // request and response shape follow upstream's `POST /api/sessions/[id]/auto-name`.
    if (request.method === "POST" && action === "auto-name") {
      // A removed conversation is out of the catalogue but its records are retained, so it is still reachable by id.
      // Naming it would produce a name no surface can show, so it is refused with the reason the caller reads.
      if (item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return; }
      const selected = item.snapshot().settings.model;
      const model = selected === null ? undefined : runtime.models.getModel(selected.provider, selected.modelId);
      // The framework's own wording for the same failure: a conversation whose selection is gone is told which model
      // is missing, and a deployment that configured none is told that, rather than being handed a manufactured one.
      if (model === undefined) { json(response, 409, { code: "no_model", error: selected === null ? "No model is configured" : "Model " + selected.provider + "/" + selected.modelId + " is not available" }); return; }
      // The transcript is this conversation's committed model context, read through the runtime's own public read: a
      // turn still in flight only means the newest reply is missing from it, and there is nothing to wait for.
      const transcript = buildTitleTranscript((await item.conversation.context(BACKGROUND_CONTEXT)).messages);
      if (transcript.trim() === "") { json(response, 409, { code: "no_transcript", error: "The session has no usable text to name" }); return; }
      try {
        const title = await generateSessionTitle({ models: runtime.models, model, transcript, stream: options.settings?.stream });
        await item.conversation.commit(async (tx) => { (await tx.doc(TitleDoc, item.conversation.id)).title = title; }, BACKGROUND_CONTEXT);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, title });
      } catch (error) {
        // A failed generation writes nothing: the name the conversation had is the name it keeps, and the reason is
        // reported so the surface can say what failed instead of showing a name that was never stored.
        json(response, 502, { code: "title_failed", error: safeFailure(error) });
      }
      return;
    }
    // Removal, as a hepi-owned tombstone: the conversation's records are retained because pi-durable 1.1.0 has no
    // conversation deletion, and this hides the conversation from the catalogue instead. The tombstone is written
    // through the durable document path — nothing is deleted from any store — and the removal is presented as an
    // ordinary one. The family's own pin, archive and unread entries are cleared in the same commit, so no orphan
    // entry is left in the shared sidebar document. A live run is not stopped or waited for: the removal is answered
    // at once and the run settles into the retained records. The conversation's children keep their own entries and
    // their own rows, and nothing about them points at a parent that is gone, because a removed conversation only
    // leaves the catalogue.
    if (request.method === "DELETE" && parts.length === 3) {
      await tombstoneConversation(runtime.harness, item.conversation.id, [id], Date.now());
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, removed: true }); return;
    }
    if (request.method === "GET" && action === "settings") { json(response, 200, { protocol: PROTOCOL_VERSION, ...item.snapshot().settings }); return; }
    // The whole selection of one conversation, read as one answer: the extensions it selects, the tools those select
    // offer it, and inside them its MCP grants and the servers its host has configured. Nothing here asks a host
    // whether it is up, and nothing here derives an offer — `offered` is the runtime's own resolution.
    if (request.method === "GET" && action === "extensions") {
      // `?mcp=<server>` is the one read that asks a host what one server holds, and it is asked, never defaulted: an
      // ordinary read of the selection starts nothing. Every other query of this seam answers the conversation's own
      // durable state and the host's own configuration files.
      const asked = url.searchParams.get("mcp");
      const listing = asked === null || asked.trim() === "" ? undefined : await mcpListedServer(id, asked.trim());
      if (listing !== undefined && !listing.ok) { json(response, listing.status, { protocol: PROTOCOL_VERSION, code: listing.code, error: listing.error }); return; }
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      const toolNames = agent.tools.map(tool => tool.name);
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        conversationId: id,
        extensions: agent.extensions.map(extension => extension.name),
        toolNames,
        mcp: { ...(await mcpGrantAnswer(item, id, toolNames)), ...(listing === undefined ? {} : { listed: listing.list }) },
      }); return;
    }
    // `pi.agent.extensions` says whether this conversation may be granted MCP tools at all and `pi.agent.modelTools`
    // says which ones it is offered; both are the framework's own per-conversation fields, and the approved shape is
    // one seam that writes them rather than a second route family, a second registry concept or a second selection
    // document. The body therefore carries the extension names, exactly as it always did, plus an optional `mcp`
    // section stating one server's grants for this conversation:
    //
    // - `mcp: { server, tools: [...] }` replaces this conversation's grants of that server, and `tools: []` revokes
    //   them. Either half of the body may be left out to say nothing about that half: `{ mcp }` alone writes grants and
    //   leaves the extension selection where it stands, `{ extensions }` alone writes the selection and touches no
    //   grant. What a server **holds** is read (`?mcp=<server>`), never written by omission, because listing connects a
    //   server and an accidental listing is not something a grant request should be able to ask for.
    // - Whatever the body said, the answer is the whole selection: extension names, offered tool names, and the
    //   conversation's grants — one seam answers the state it just wrote.
    //
    // Nothing here takes a client's description of a tool's arguments, and nothing here writes an agent document by
    // hand: a grant's descriptor is copied from the host's listing, the offer is written through the runtime's own
    // `configure` seam, and both halves are validated before either is applied — a bad name writes neither part.
    if (request.method === "PATCH" && action === "extensions") {
      const body = await readBody(request);
      const states = (key: string): boolean => body !== null && typeof body === "object" && !Array.isArray(body) && key in body;
      if (!states("extensions") && !states("mcp")) { json(response, 400, { protocol: PROTOCOL_VERSION, code: "invalid_request", error: "the body states extensions, mcp, or both" }); return; }
      // One seam, two halves, and each half validates in its own words: a request that states only `mcp` says nothing
      // about extensions and is not refused for that, and a request that states both writes both or neither.
      const selection = states("extensions") ? requestedSelection(body, item.snapshot().workspaceId !== undefined) : undefined;
      if (selection !== undefined && !selection.ok) { json(response, selection.status, { code: selection.code, error: selection.error }); return; }
      // The `mcp` section is read with the same care as the extension names, and a key the host owns is refused by name.
      const grant = states("mcp") ? grantRequest((body as { mcp?: unknown }).mcp) : undefined;
      if (grant !== undefined && "code" in grant) { json(response, 400, { protocol: PROTOCOL_VERSION, ...grant }); return; }
      // The grant is written first, so a host that refuses a name leaves the extension selection exactly as it stood.
      if (grant !== undefined) {
        const refusal = await writeMcpConversationGrants(id, grant.server, grant.tools);
        if (refusal !== undefined) { json(response, refusal.status, { protocol: PROTOCOL_VERSION, code: refusal.code, error: refusal.error }); return; }
      }
      if (selection !== undefined && selection.ok) await item.conversation.configure({ extensions: selection.extensions }, BACKGROUND_CONTEXT);
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      const toolNames = agent.tools.map(tool => tool.name);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, extensions: agent.extensions.map(extension => extension.name), toolNames, mcp: await mcpGrantAnswer(item, id, toolNames) }); return;
    }
    // Fork: the new conversation inherits the source's history up to the chosen entry, with the runtime's own
    // fork-aware history and document semantics, and the source is only read, so a live run in it is untouched. Body
    // `{ at?, requestId? }` names the entry — without one the conversation's newest committed entry is the fork point,
    // which is what the sidebar's row menu asks for — and the request identity that makes a retry after a lost answer
    // answer the branch the first attempt created. Everything that can refuse is answered before the fork, and the fork
    // itself is the one creation seam's atomic commit, so a refusal creates nothing. The upstream route's request and
    // response shapes are the contract: answer the new identity plus its catalogue row.
    if (request.method === "POST" && action === "fork") {
      const body = await readBody(request) as { at?: unknown; requestId?: unknown; model?: ModelRef; thinkingLevel?: unknown } | undefined;
      const refusal = (code: ForkRefusal) => { json(response, FORK_REFUSALS[code].status, { protocol: PROTOCOL_VERSION, code, error: FORK_REFUSALS[code].error }); };
      const named = body?.at;
      // A named fork point that is not an entry id cannot be one this conversation holds: the upstream "unsaved"
      // source, a client whose transcript is ahead of the durable conversation.
      if (named !== undefined && (typeof named !== "string" || !/^[0-9]+$/.test(named))) { refusal("unsaved"); return; }
      // A conversation a task owns is a subagent's, and a copy of it is a branch of that subagent: it keeps the
      // conversation it was taken from as its display parent and gets an **independent** native owner — a background
      // anchor of the source's own scope — so it is dispatched, queued and controlled on its own and the source's task
      // is never reused. A branch of an ordinary conversation stays ownerless and top-level, as it always was, so the
      // native fork source and the display parent stay two different facts (spec D14, A17).
      const record = await runtime.harness.commit(tx => tx.conversation(item.conversation.id), BACKGROUND_CONTEXT);
      if (record === undefined) { refusal("not_found"); return; }
      const child = record.owner !== undefined;
      // The newest committed entry of the conversation's fork-aware history is its leaf, which is the point a fork
      // with no `at` starts from. Read through the public history read rather than inferred from the view, whose last
      // element is not the newest entry once a head marker leads the active range.
      const leaf = named ?? (await item.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id;
      if (leaf === undefined) { refusal("empty"); return; }
      const entryId = Number(leaf) as EntryId;
      // The view the fork would start with, read through the same as-of context a fork uses. It throws for an entry
      // that is not visible from this conversation, which is the refusal; a branch carrying no user or assistant
      // message has nothing to continue from.
      let branch;
      try { branch = await item.conversation.context(BACKGROUND_CONTEXT, { at: entryId }); }
      catch { refusal("unsaved"); return; }
      if (!branch.entries.some(entry => entry.model?.some(message => message.role === "user" || message.role === "assistant"))) { refusal("empty"); return; }
      const requestId = typeof body?.requestId === "string" && body.requestId.trim() !== "" ? body.requestId : randomUUID();
      // A branch starts from the configuration in force at the entry it was taken from — the native agent document
      // forks `asOf` — and a caller may name a field to replace on top of that copy. The two fields are the ones the
      // settings route already validates, so a branch cannot be created with a configuration this backend would refuse
      // to store: an unknown model or level is answered before the fork, exactly as it is on the settings route.
      if (body?.model !== undefined && runtime.models.getModel(body.model.provider, body.model.modelId) === undefined) { json(response, 400, { code: "unknown_model", error: "unknown model" }); return; }
      if (body?.thinkingLevel !== undefined && (typeof body.thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(body.thinkingLevel))) { json(response, 400, { code: "invalid_thinking_level", error: "invalid thinking level" }); return; }
      const overrides: AgentChange = {
        ...(body?.model === undefined ? {} : { model: body.model }),
        ...(body?.thinkingLevel === undefined ? {} : { thinkingLevel: body.thinkingLevel as AgentState["thinkingLevel"] }),
      };
      try {
        const spawned = await operations.spawn({
          requestId,
          source: { conversationId: id, entryId: String(entryId) },
          ...(Object.keys(overrides).length === 0 ? {} : { agent: overrides }),
          // The child's anchor is created inside the same commit as the branch, so the branch's native owner exists
          // exactly when the branch does, and it starts in the permanent idle phase: a branch has no delegation to
          // admit, only an owner of its own (spec D14).
          ownership: child
            ? { kind: "created-task", create: (tx) => createForkAnchor(tx, item.conversation.id) }
            : { kind: "ownerless" },
          ...(child ? { createdBy: id, displayParentId: id, provenance: { origin: "user" as const } } : {}),
        });
        const attached = await attach(spawned.conversation, { forkSource: id, ...(child ? { subagentParent: id } : {}) });
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: spawned.conversationId, conversation: catalogueEntry(attached, await catalogueFacts()) }); return;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
    }
    if (request.method === "PATCH" && action === "settings") {
      const body = await readBody(request) as { model?: ModelRef; thinkingLevel?: string } | undefined;
      if (!body || (!body.model && body.thinkingLevel === undefined)) { json(response, 400, { error: "settings required" }); return; }
      if (body.model && !runtime.models.getModel(body.model.provider, body.model.modelId)) { json(response, 400, { error: "unknown model" }); return; }
      const level = body.thinkingLevel;
      if (level !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) { json(response, 400, { error: "invalid thinking level" }); return; }
      await item.conversation.configure({ model: body.model, thinkingLevel: level as AgentState["thinkingLevel"] }, BACKGROUND_CONTEXT);
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, model: agent.model, thinkingLevel: agent.thinkingLevel }); return;
    }
    if (request.method === "GET" && action === "events") {
      const requestedRevision = Number(url.searchParams.get("after") ?? "0");
      const current = item.snapshot();
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // The baseline is the same bounded object the HTTP read answers, so it is bounded here too. A baseline that
      // cannot be carried is **stated** rather than written: the transport would destroy the connection and the client
      // would reconnect to the same frame, which is the endless resync this margin exists to prevent. The stream stays
      // open, the next commit publishes normally, and the named entry stays readable through its own route.
      const oversize = oversizeFrame(current, current.entries.at(-1)?.id ?? null);
      if (oversize === undefined) send(response, "snapshot", current);
      else send(response, "state_oversize", { protocol: PROTOCOL_VERSION, conversationId: id, revision: current.revision, reason: "frame_too_large", ...oversize });
      if (url.searchParams.has("after") && (!Number.isInteger(requestedRevision) || requestedRevision !== current.revision)) send(response, "resync_required", { protocol: PROTOCOL_VERSION, conversationId: id, revision: current.revision });
      // This connection is attached from here on, and a conversation can stay quiet for as long as its user leaves it
      // alone. The keepalive is armed with the attachment and disarmed with it, so an idle stream outlives every idle
      // bound in front of it while a disconnected one leaves nothing running behind it.
      const stopKeepalive = startKeepalive(response, heartbeatIntervalMs);
      item.clients.add(response);
      request.on("close", () => { stopKeepalive(); item.clients.delete(response); });
      return;
    }
    // One user message, through the one admission seam: an idle conversation places it and runs, a busy one queues
    // it, and a conversation the user has stopped is resumed by this dispatch — an immediate send is the user's own
    // decision to continue, so it clears `held` atomically with the admission. The caller is the authenticated host,
    // never the body, so no request can claim to be someone else (spec D02, D07).
    if (request.method === "POST" && action === "messages") {
      // A removed conversation is out of the catalogue but its records are retained, so it is still reachable by id.
      // A new turn on it would be a turn the user cannot see, so it is refused with the reason the caller reads.
      if (item.deletedAt() !== undefined) { json(response, 409, { ok: false, code: "session_deleted", accepted: false, message: "This session was deleted. Start a new session to continue." }); return; }
      const body = await readBody(request, MAX_SUBMISSION_BODY_BYTES);
      const command = { ...(typeof body === "object" && body !== null ? body : {}), conversationId: id } as ProtocolCommand;
      const validation = validateCommand(command, { conversationWorkspaceId: item.snapshot().workspaceId });
      if (!validation.ok) { json(response, 400, validation); return; }
      const whenBusy = (body as { whenBusy?: unknown }).whenBusy;
      if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp" && whenBusy !== "reject") { json(response, 400, { error: "invalid busy behavior" }); return; }
      const images = command.images ?? [];
      const refusedImages = imageRefusal(item, images);
      if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return; }
      try {
        const sent = await operations.send(id, { requestId: command.requestId, caller: "user", content: await submissionContent(item, command.text, images), whenBusy: whenBusy ?? "followUp" });
        // A held conversation turns this send into a resume, and the answer states how that went: `stopping` means the
        // old stop still drains and the same request id finishes the intent, which is what the composer retries.
        json(response, 202, { protocol: PROTOCOL_VERSION, requestId: command.requestId, ...(sent.submissionId === undefined ? {} : { submissionId: sent.submissionId }), ...(sent.status === undefined ? {} : { status: sent.status, ...(sent.reason === undefined ? {} : { reason: sent.reason }) }), control: sent.control });
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
        json(response, 409, { code: "conversation_busy", accepted: false });
      }
      return;
    }
    if (request.method === "POST" && action === "reload") {
      // Explicit Reload: discover and parse a complete candidate, then commit it atomically. A failure changes nothing
      // and answers with the error, so the UI can notify without the conversation losing its adopted prefix.
      if (options.workspaceResources === undefined) { json(response, 404, { error: "resource loading is not configured" }); return; }
      try {
        await reloadResources(item.conversation, options.workspaceResources, await resourceEnvironment(item), BACKGROUND_CONTEXT);
        json(response, 200, { protocol: PROTOCOL_VERSION, resources: await resourceSummary(readCommitted, item.conversation.id, BACKGROUND_CONTEXT) });
      } catch (error) {
        json(response, 500, { error: safeFailure(error), resources: await resourceSummary(readCommitted, item.conversation.id, BACKGROUND_CONTEXT) });
      }
      return;
    }
    // The native abort contract is unchanged and stays separate from a stop: it withdraws the queued inputs, marks the
    // ordinary scope for abort and waits for it, and it never sets a hold. A user who wants the conversation to stay
    // paused until they say otherwise uses `stop` (spec D07).
    if (request.method === "POST" && action === "abort") { await item.conversation.abort(BACKGROUND_CONTEXT); json(response, 202, { protocol: PROTOCOL_VERSION, state: "interrupted" }); return; }
    // Stop: the trusted user's own decision, committed atomically with the withdrawal of the inputs queued at this
    // point and the abort marks of the conversation's ordinary live tasks. It never waits for the drain, so the answer
    // states whether the ordinary scope is already idle; input arriving after the commit stays queued and visible, and
    // repeating the same request id returns the same durable receipt instead of clearing the later items (spec D07).
    if (request.method === "POST" && action === "stop") {
      const body = await readBody(request) as { requestId?: unknown; expectedControlRevision?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return; }
      if (body.expectedControlRevision !== undefined && (!Number.isInteger(body.expectedControlRevision) || (body.expectedControlRevision as number) < 0)) { json(response, 400, { code: "invalid_request", error: "expectedControlRevision must be a non-negative integer" }); return; }
      try {
        const stopped = await operations.stop(id, { requestId: body.requestId, stopSource: "user", ...(body.expectedControlRevision === undefined ? {} : { expectedControlRevision: body.expectedControlRevision as number }) });
        json(response, stopped.status === "rejected" ? 409 : 202, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: body.requestId, status: stopped.status, ...(stopped.reason === undefined ? {} : { reason: stopped.reason }), drain: stopped.drain, control: stopped.control, receipt: stopped.receipt });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return;
    }
    // Continue: the user's explicit resume. While the old stop's ordinary scope still drains the answer is `stopping`
    // and every queued input stays; once the native scope is idle the same commit clears `held`, admits the optional
    // input and consumes the held period's queue. An empty continue starts no run and invents no user message, and a
    // retry of the same request id reads its durable receipt instead of performing the resume twice (spec D08).
    if (request.method === "POST" && action === "continue") {
      const body = await readBody(request, MAX_SUBMISSION_BODY_BYTES) as { requestId?: unknown; expectedControlRevision?: unknown; text?: unknown; images?: unknown; whenBusy?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return; }
      if (body.expectedControlRevision !== undefined && (!Number.isInteger(body.expectedControlRevision) || (body.expectedControlRevision as number) < 0)) { json(response, 400, { code: "invalid_request", error: "expectedControlRevision must be a non-negative integer" }); return; }
      const text = body.text === undefined ? undefined : body.text;
      if (text !== undefined && typeof text !== "string") { json(response, 400, { code: "invalid_request", error: "text must be a string" }); return; }
      const images = (body.images ?? []) as readonly SubmitImage[];
      if (!Array.isArray(body.images ?? []) || (body.images !== undefined && !Array.isArray(body.images))) { json(response, 400, { code: "invalid_request", error: "images must be an array" }); return; }
      // The resume's optional input is admitted under the runtime's own admission, so it is validated exactly as an
      // ordinary message: a body that would not be a valid submission is refused before the resume commit.
      if (text !== undefined || images.length > 0) {
        const command = { protocol: PROTOCOL_VERSION, type: "conversation.submit", conversationId: id, requestId: body.requestId, text: text ?? "", ...(images.length > 0 ? { images } : {}) } as ProtocolCommand;
        const validation = validateCommand(command, { conversationWorkspaceId: item.snapshot().workspaceId });
        if (!validation.ok) { json(response, 400, validation); return; }
        const refusedImages = imageRefusal(item, images);
        if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return; }
      }
      const whenBusy = body.whenBusy;
      if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") { json(response, 400, { code: "invalid_request", error: "whenBusy must be steer or followUp" }); return; }
      try {
        // The resume's input is admitted under the resume's **own** request id, so a retry after a lost answer is one
        // identity end to end: the control receipt answers the resume and the submission answers the message.
        const resumed = await operations.continue(id, {
          requestId: body.requestId,
          caller: "user",
          ...(body.expectedControlRevision === undefined ? {} : { expectedControlRevision: body.expectedControlRevision as number }),
          ...(text === undefined && images.length === 0 ? {} : { input: { content: await submissionContent(item, text ?? "", images), whenBusy: whenBusy ?? "followUp" } }),
        });
        json(response, resumed.status === "rejected" ? 409 : 202, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: body.requestId, status: resumed.status, ...(resumed.reason === undefined ? {} : { reason: resumed.reason }), ...(resumed.submissionId === undefined ? {} : { submissionId: resumed.submissionId }), control: resumed.control, receipt: resumed.receipt });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return;
    }
    // The control state and one durable receipt. A caller whose stop or continue answer was lost reads back what really
    // happened instead of re-sending an intent, and the answer states the *latest* control so an older operation's
    // receipt can never be read as the current state (spec D08).
    if (request.method === "GET" && action === "control") {
      const requestId = url.searchParams.get("requestId") ?? undefined;
      try {
        const current = await operations.control(id, requestId === undefined || requestId.trim() === "" ? undefined : requestId);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, control: current.control, receipt: current.receipt ?? null });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return;
    }
    // Subtree control: an explicit stop or interrupt of the **captured** descendant subtree, which is a different
    // decision from this conversation's own stop. A parent's stop stays local (spec decision 1), so this route is the
    // only one that reaches children, and it reaches them through the same `stop`/`abort` contracts every other caller
    // uses. The scope is captured by the first request under a request id and answered from that capture on a replay, so
    // a child created afterwards is never implicitly included; a selective request names a subset of the same capture.
    // The answer states one outcome and one current control state per child, so a partial result is visible instead of
    // being flattened into a single status, and nothing here touches history, relations or tombstones (spec D01-D05).
    if (request.method === "POST" && action === "subtree-control") {
      const body = await readBody(request) as { requestId?: unknown; action?: unknown; selected?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return; }
      if (body.action !== "stop" && body.action !== "interrupt") { json(response, 400, { code: "invalid_request", error: "action must be stop or interrupt" }); return; }
      if (body.selected !== undefined && (!Array.isArray(body.selected) || body.selected.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
        json(response, 400, { code: "invalid_request", error: "selected must be an array of conversation ids" }); return;
      }
      try {
        // The caller is the host's own statement, exactly as it is for a single-conversation stop: this HTTP surface is
        // the user, and nothing in the body selects it.
        const controlled = await operations.subtreeControl(id, {
          requestId: body.requestId,
          action: body.action,
          stopSource: "user",
          ...(body.selected === undefined ? {} : { selected: body.selected as string[] }),
        });
        // A partial result is not a failed request: the request was accepted and every child answered, so the answer is
        // 202 with `partial`, each child's own recorded status and each child's current session row beside it.
        json(response, 202, { protocol: PROTOCOL_VERSION, conversationId: id, ...(await subtreeAnswer(controlled)) });
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        if (error instanceof SubtreeControlRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
      return;
    }
    // The durable record of one subtree request: the captured scope, every child's committed outcome and each child's
    // current control state. A caller whose answer was lost reads back what really happened instead of re-sending the
    // intent, which is the same recovery read the single-conversation control route offers (spec D04, D05).
    if (request.method === "GET" && action === "subtree-control") {
      const requestId = url.searchParams.get("requestId");
      if (requestId === null || requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return; }
      try {
        const controlled = await operations.subtreeControlRequest(id, requestId);
        if (controlled === undefined) { json(response, 404, { protocol: PROTOCOL_VERSION, code: "unknown_request", error: "no subtree request with that id on this conversation" }); return; }
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, ...(await subtreeAnswer(controlled)) });
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        if (error instanceof SubtreeControlRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return; }
        throw error;
      }
      return;
    }
    // Recall: take the queued inputs back out of the conversation and hand their text to the caller, which is the one
    // thing the runtime does not already offer. `abort()` withdraws the same items but discards them, because an abort
    // means the user no longer wants what they queued. A recall means the user wants it back to edit, so the items are
    // withdrawn with the runtime's own `pi.inbox` document and settled as unanswered — never placed, so the boundary
    // that would have run them has nothing left to place — while the text is returned in queue order. The run already
    // in flight is untouched: this removes what has not started, it does not stop what has.
    if (request.method === "POST" && action === "recall-queue") {
      // A removed conversation keeps its records but is out of every surface, so a queue write on it is refused for the
      // same reason a new turn is: the caller would be editing a queue nobody can see (spec D09, A22).
      if (item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return; }
      const recalled = { steering: [] as string[], followUp: [] as string[] };
      await item.conversation.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, item.conversation.id);
        // Backwards, so splicing the array the runtime reads cannot skip an item; `unshift` restores queue order.
        for (let index = inbox.items.length - 1; index >= 0; index--) {
          const queued = inbox.items[index];
          // A queued write is not user input and has no text to hand back; it stays for its own boundary.
          if (queued.mode === "write") continue;
          // The runtime names the mode `steer`; the snapshot a client reads calls that list `steering`.
          recalled[queued.mode === "steer" ? "steering" : "followUp"].unshift(contentText(queued.content));
          tx.settleSubmission(queued.id, { status: "unanswered", reason: "recalled" });
          inbox.items.splice(index, 1);
        }
      }, BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, ...recalled }); return;
    }
    // The busy composer's steer and follow-up: the same admission seam as an ordinary message, with the same control
    // rule and the same content — the protocol's own text and image blocks. It is a **queue-only** input, so it never
    // resumes a held conversation — a draft the user staged while the turn was running is not their decision to
    // continue (spec D07).
    if (request.method === "POST" && action === "busy") {
      const body = await readBody(request, MAX_SUBMISSION_BODY_BYTES);
      const mode = typeof body === "object" && body !== null ? (body as { mode?: unknown }).mode : undefined;
      if (mode !== "follow-up" && mode !== "steer") { json(response, 400, { error: "mode must be follow-up or steer" }); return; }
      const input = (typeof body === "object" && body !== null ? body : {}) as { text?: unknown; requestId?: unknown; images?: unknown };
      if (typeof input.requestId !== "string" || !input.requestId.trim()) { json(response, 400, { error: "requestId required" }); return; }
      if (input.images !== undefined && !Array.isArray(input.images)) { json(response, 400, { error: "images must be an array" }); return; }
      // A body that is not the shape this route reads is refused rather than coerced, so a caller is never answered
      // with a draft it did not write.
      if (input.text !== undefined && typeof input.text !== "string") { json(response, 400, { error: "text must be a string" }); return; }
      const text = input.text ?? "";
      const images = (input.images ?? []) as readonly SubmitImage[];
      // A queued draft is a submission like any other, so it is validated the same way: an empty body and an attachment
      // the protocol refuses are answered before anything is admitted, rather than staged and dropped.
      const validation = validateCommand({ protocol: PROTOCOL_VERSION, type: "conversation.submit", conversationId: id, requestId: input.requestId, text, ...(images.length > 0 ? { images } : {}) } as ProtocolCommand, { conversationWorkspaceId: item.snapshot().workspaceId });
      if (!validation.ok) { json(response, 400, validation); return; }
      const refusedImages = imageRefusal(item, images);
      if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return; }
      if (item.deletedAt() !== undefined) { json(response, 409, { ok: false, code: "session_deleted", accepted: false, message: "This session was deleted. Start a new session to continue." }); return; }
      try {
        const sent = await operations.send(id, { requestId: input.requestId, caller: "user", resume: false, content: await submissionContent(item, text, images), whenBusy: mode === "steer" ? "steer" : "followUp" });
        json(response, 202, { protocol: PROTOCOL_VERSION, mode, requestId: input.requestId, submissionId: sent.submissionId, control: sent.control });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return;
    }
    // The pending queue, item by item, and the two per-item operations the Web offers on it. The queue is the
    // runtime's own `pi.inbox`, so nothing here is a second queue: a read projects it, an edit writes one item's
    // content in one commit after confirming the token the caller read, and a cancel is the native abort. Neither
    // operation clears a hold or starts a run — a hold is the user's decision, and deciding about one queued item is
    // not a decision to continue (spec D09, A11).
    if (action === "items") {
      const submissionId = parts[4];
      const method = request.method ?? "GET";
      // A removed conversation keeps its records but is out of every surface, so a queue write on it is refused for the
      // same reason a new turn is: the caller would be editing a queue nobody can see (spec D09, A22).
      if (method !== "GET" && item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return; }
      if (method === "GET" && submissionId === undefined) {
        const answer = await handleConversationItems(items, id, "list", undefined, undefined);
        json(response, answer.status, answer.body); return;
      }
      if (method === "PATCH" && submissionId !== undefined) {
        const answer = await handleConversationItems(items, id, "edit", submissionId, await readBody(request, MAX_SUBMISSION_BODY_BYTES));
        json(response, answer.status, answer.body); return;
      }
      if (method === "DELETE" && submissionId !== undefined) {
        const answer = await handleConversationItems(items, id, "cancel", submissionId, undefined);
        json(response, answer.status, answer.body); return;
      }
      json(response, 405, { error: "method not allowed" }); return;
    }
    json(response, 404, { error: "not found" });
  }

  return { server, async close() { for (const item of conversations.values()) await item.close(); conversations.clear(); await runtime.close(); await new Promise<void>((resolve) => { if (!server.listening) resolve(); else server.close(() => resolve()); }); } };
}
