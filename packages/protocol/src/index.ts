export const PROTOCOL_VERSION = "hepi.v1" as const;

/**
 * The cadence of the keepalive comment frame on a long-lived server-sent event stream, and the frame itself.
 *
 * A conversation and a terminal are quiet most of the time, and every hop in front of them bounds an idle body. A
 * comment frame — a line with no field name — is what the event-stream format defines for exactly this: it carries no
 * event, so no client folds it into state, and it is bytes on the wire, so no idle bound fires.
 *
 * It is a protocol constant rather than a value each writer picks, because the two origin writers must agree on it and
 * the proxies in front of them must never write one of their own: only the process that owns a frame boundary can add
 * a frame to a stream without splitting one.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_FRAME = ":\n\n";

/**
 * The header a client ingress states its own default execution host on.
 *
 * The computer a caller is served from is a property of the deployment, not of a request, so the ingress that already
 * admitted the caller states it here — from its own configuration, never from anything the caller sent. The Backend
 * resolves the name against the gateways it was configured with, so an id this deployment does not know is a
 * configuration refusal rather than a route to somewhere else. It is a protocol constant because both writers have to
 * agree on the spelling, and a second spelling would silently be a different fact.
 */
export const DEFAULT_HOST_HEADER = "x-hepi-default-host";

/**
 * The route that ends a Web cookie session, as one string.
 *
 * It is here because it has two writers that must not disagree: the ingress, which clears the cookie, and the Web page,
 * which asks it to. A page that named a different route than the listener serves is a logout that answers something
 * else — an authenticated read forwarded to the Backend, or a 404 — and the person is left believing a session ended
 * that did not. The Web session's login is deliberately not a constant beside it: only the logout is a client action,
 * the login is the form the page itself posts and the ingress alone spells.
 */
export const WEB_LOGOUT_PATH = "/api/web-logout";

/**
 * The one answer a client ingress asks the Backend for about a folder: whether a workspace is a folder on the machine
 * of the gateway that ingress configured, at `GET /api/workspaces/:workspaceId/locality?gatewayId=:gatewayId`.
 *
 * It is a protocol shape because both processes write it: the Backend decides it from its own binding and host-profile
 * metadata, and the ingress reads it and nothing else. The decision is the Backend's alone — a caller names the gateway
 * it serves, never the one a workspace is on — so this states a verdict and no topology: no list, no profile, no root.
 *
 * A successfully evaluated query answers exactly this. `local: false` covers every evaluated negative — a workspace
 * this deployment does not bind, an owner that is another gateway, an SSH-profile host, a host result this predicate
 * does not accept. A query the Backend could not evaluate is not answered with `false`: it keeps its own non-success,
 * because "could not ask" is not "asked, and it is not this machine".
 */
export type WorkspaceLocality = { readonly local: boolean };

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type ConversationId = string;
export type WorkspaceId = string;
export type GatewayId = string;
export type RequestId = string;

export type WorkspaceBinding =
  | { id: WorkspaceId; gatewayId: GatewayId; kind: "local"; cwd: string }
  | { id: WorkspaceId; gatewayId: GatewayId; kind: "ssh"; cwd: string; sshProfile: string };

export type GatewayBinding = {
  id: GatewayId;
  kind: "local" | "workstation";
  displayName: string;
};

export type OperationState =
  | "queued"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "outcome-unknown";

/**
 * Trusted origin of a stop or a resume. It is the host's statement about who asked — a user decision, or the runtime's
 * own agent caller — and never a value a model or a request body may supply about itself (spec D02, D07).
 */
export type ControlStopSource = "user" | "agent";

/** Whether new input may start a turn (`allowed`) or must stay queued (`held`) until a trusted user resumes. */
export type ConversationControlState = {
  readonly state: "allowed" | "held";
  /** Advances on every recorded control change; a rejected request does not move it. */
  readonly revision: number;
  readonly stopSource?: ControlStopSource;
  readonly stoppedAt?: number;
};

/**
 * One durable control receipt, as the wire names it: the stable answer to one `requestId` of a stop or a continue.
 *
 * It is a durable fact, not a transport answer, which is what makes a lost HTTP response harmless — a retry with the
 * same `requestId` reads this record back instead of performing the operation again (spec D08).
 */
export type ControlReceipt = {
  readonly requestId: RequestId;
  readonly operation: "stop" | "continue";
  readonly status: "accepted" | "held" | "rejected" | "stopping" | "resumed" | "allowed";
  /** Why a request was refused. `superseded` means a later stop overtook it; a refusal changes no state. */
  readonly reason?: "revision_mismatch" | "source_locked" | "superseded" | "caller_mismatch";
  readonly revision: number;
  readonly stopSource?: ControlStopSource;
  readonly caller?: ControlStopSource;
  readonly at: number;
};

/** One base64 image block of a submission; the runtime accepts the same shape as native image content. */
export type SubmitImage = { type: "image"; data: string; mimeType: string };

/** Attached images a submission may carry. Mirrored by the browser composer, so both sides refuse the same input. */
export const MAX_SUBMISSION_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SUBMISSION_IMAGES = 10;
/**
 * Body bound of one accepted submission: every image at the per-image limit, base64-expanded, plus JSON overhead.
 * The backend and the Web proxy read this instead of a fixed text limit, so a submission this validator accepts can
 * never be truncated before validation.
 */
export const MAX_SUBMISSION_BODY_BYTES = MAX_SUBMISSION_IMAGES * 4 * Math.ceil(MAX_SUBMISSION_IMAGE_BYTES / 3) + 1024 * 1024;

export type SubmitCommand = {
  protocol: ProtocolVersion | string;
  requestId: RequestId;
  conversationId: ConversationId;
  type: "conversation.submit";
  text: string;
  /** Images reach the model with the text as native content blocks; text-only submissions omit the field. */
  images?: readonly SubmitImage[];
  whenBusy?: "steer" | "followUp" | "reject";
  workspaceId?: WorkspaceId;
  gatewayId?: GatewayId;
};

export type ProtocolCommand = SubmitCommand;

export type CommandValidationError =
  | { ok: false; code: "unsupported_protocol" }
  | { ok: false; code: "invalid_request_id" }
  | { ok: false; code: "invalid_conversation_id" }
  | { ok: false; code: "invalid_text" }
  | { ok: false; code: "invalid_images"; message: string }
  | { ok: false; code: "unknown_workspace" }
  | { ok: false; code: "unknown_gateway" }
  | { ok: false; code: "workspace_gateway_mismatch" }
  | { ok: false; code: "workspace_immutable" };

export type CommandValidationResult = { ok: true } | CommandValidationError;

export type ProtocolContext = {
  workspaces?: readonly WorkspaceBinding[];
  gateways?: readonly GatewayBinding[];
  /**
   * The workspace the addressed conversation is already bound to. A conversation cannot switch workspaces anywhere in
   * its lifecycle (ADR 0002), including while idle, so a command naming a different one is refused rather than
   * silently applied to the conversation's existing workspace.
   */
  conversationWorkspaceId?: WorkspaceId;
};

export function validateCommand(command: unknown, context: ProtocolContext = {}): CommandValidationResult {
  if (!isRecord(command) || command.protocol !== PROTOCOL_VERSION) return { ok: false, code: "unsupported_protocol" };
  if (typeof command.requestId !== "string" || command.requestId.trim() === "") return { ok: false, code: "invalid_request_id" };
  if (typeof command.conversationId !== "string" || command.conversationId.trim() === "") return { ok: false, code: "invalid_conversation_id" };
  if (command.type !== "conversation.submit" || typeof command.text !== "string") return { ok: false, code: "invalid_text" };
  const images = validateSubmitImages(command.images);
  if (images !== undefined && images.ok === false) return images;
  // An empty text is valid only as an image submission, and an image submission needs at least one image: an empty
  // list is a text-only command, which still needs text.
  const imageCount = Array.isArray(command.images) ? command.images.length : 0;
  if (command.text.trim() === "" && imageCount === 0) return { ok: false, code: "invalid_text" };
  const workspaceId = command.workspaceId;
  const gatewayId = command.gatewayId;
  // Checked before the workspace lookup: the refusal is about the conversation's binding, not about whether the named
  // workspace happens to be configured for this process.
  if (workspaceId !== undefined && context.conversationWorkspaceId !== undefined && workspaceId !== context.conversationWorkspaceId) return { ok: false, code: "workspace_immutable" };
  const workspace = workspaceId === undefined ? undefined : context.workspaces?.find((candidate) => candidate.id === workspaceId);
  if (workspaceId !== undefined && workspace === undefined) return { ok: false, code: "unknown_workspace" };
  const gateway = gatewayId === undefined ? undefined : context.gateways?.find((candidate) => candidate.id === gatewayId);
  if (gatewayId !== undefined && gateway === undefined) return { ok: false, code: "unknown_gateway" };
  if (workspace !== undefined && gateway !== undefined && workspace.gatewayId !== gateway.id) return { ok: false, code: "workspace_gateway_mismatch" };
  return { ok: true };
}

/**
 * The raw projection frames, declared **once** for every production consumer.
 *
 * The backend publishes them, the Web adapter proxies them, and each consumer adapts them to its own display shape —
 * that adaptation stays explicit and is not declared here. What is declared here is the transport-neutral wire: the
 * scalars both transports send on every frame, the window's own bookkeeping, and the one field whose payload belongs to
 * another owner (the committed message, which is a pi-ai record on the backend and the Web's own mirror of it in the
 * browser). The frame is parameterized by that payload rather than importing it, because a package that declares a wire
 * must not depend on the runtime that fills it in.
 */

/** One model reference as the wire names it. */
export type ModelRef = { readonly provider: string; readonly modelId: string };
/** A conversation's selected model and reasoning level, as every frame states them. */
export type ConversationSettings = { readonly model: ModelRef | null; readonly thinkingLevel: string };

/**
 * The hepi-owned relation state of one conversation: who created it, where it is displayed, and the configuration and
 * context it came from. It is stored as the conversation's own document and never copies a mutable native record — the
 * native fork source and task ownership are projected from the immutable conversation record instead — so creator,
 * display parent, fork source and owner stay four separate facts (spec D03).
 */
export type ConversationRelations = {
  readonly createdBy?: ConversationId;
  readonly displayParentId?: ConversationId;
  readonly provenance?: ConversationProvenance;
};

/** Where one conversation's configuration and context came from, fixed when it was created. */
export type ConversationProvenance = {
  readonly origin?: "user" | "agent" | "system";
  readonly definition?: { readonly hostId: GatewayId; readonly scope: "project" | "user"; readonly name: string };
  readonly context?: { readonly strategy: string; readonly sourceConversationId?: ConversationId; readonly sourceEntryId?: string };
};

/**
 * A structured pointer from one conversation to another, optionally to one entry of it. It is saved as the referencing
 * conversation's own state: the target's relations, workspace and owner are untouched, and the reference grants no
 * control over it (spec D03).
 *
 * `entryId` is the same stable entry identity the history owner already issues, not a coordinate, ordinal or copy of
 * the target's content: the Backend validates it against the target's visible committed fork-aware history when the
 * reference is created, so a stored reference always names an entry the target can land on. A reference that a later
 * removal, compaction or fork makes unresolvable stays stored — a removal never cascades into another conversation's
 * state — and the read reports it as one of the named outcomes below rather than as a nearest neighbour.
 */
export type ConversationReference = {
  readonly conversationId: ConversationId;
  readonly entryId?: string;
  readonly label?: string;
};

/**
 * Why one reference cannot be resolved right now. Each is a distinct answer a surface renders as its own state, so a
 * caller never has to read a message to tell a deleted target from a missing entry (cross-session references, decision
 * 6). The Backend is the only producer: it holds the tombstone, the target's committed history and the read failure.
 *
 * - `target-missing` — no conversation with that id exists at all.
 * - `target-unavailable` — the target exists and is removed, so it is out of every visible surface.
 * - `entry-missing` — the target is readable but its committed fork-aware history does not hold that entry.
 * - `entry-out-of-scope` — the entry exists somewhere, but not in *this* target's history (another conversation's
 *   entry, or a sibling branch's), which is the case an id lookup alone would have got wrong.
 * - `stale` — the reference was resolvable and no longer is: the target or the entry went away after it was stored.
 * - `error` — the read itself failed, so nothing about the reference was established; this is the one outcome a retry
 *   can change.
 */
export type ReferenceOutcome = "target-missing" | "target-unavailable" | "entry-missing" | "entry-out-of-scope" | "stale" | "error";

/**
 * One reference as a resolving read answers it: the stored record, whether it resolves now, and — when it does not —
 * the named outcome. It carries no target content, no preview and no substitute entry, because a reference is a pointer
 * and a follow that cannot land is stated as such.
 */
export type ResolvedReference = ConversationReference & {
  /** The named reason this reference cannot be followed; absent when it resolves. */
  readonly outcome?: ReferenceOutcome;
};

/** A conversation's effective agent configuration, projected without provider credentials or resolved tool objects. */
export type ConversationConfig = {
  readonly model: ModelRef | null;
  readonly thinkingLevel: string;
  readonly extensions: readonly string[];
  readonly tools: readonly string[];
  readonly instructions?: string;
  readonly cwd?: string;
};

/** One conversation's identity as a by-id read states it: hepi-owned relations, native record edges and effective config. */
export type ConversationInfo = {
  readonly conversationId: ConversationId;
  readonly relations: ConversationRelations;
  /** The native immutable fork edge, projected as-is; absent when the conversation is no fork. */
  readonly forkSource?: { readonly conversationId: ConversationId; readonly at: string };
  /** The native immutable task ownership edge, projected as-is; absent when no task owns the conversation. */
  readonly owner?: { readonly conversationId: ConversationId; readonly taskId: string };
  /**
   * The references this conversation makes, each with the named outcome when it cannot be resolved now. A reference is
   * stored state, so it is listed whether or not it resolves: a target that was removed after the reference was made
   * still names a fact about this conversation, and hiding it would silently lose the user's link.
   */
  readonly references: readonly ResolvedReference[];
  readonly config: ConversationConfig;
  /** True when a display parent is recorded but that parent is tombstoned; the child is not promoted and stays readable. */
  readonly displayParentDeleted: boolean;
};

/**
 * One delegated child's recovery facts, **per durable object** (the audit's G2), as the backend's own projection states
 * them. A child's `runStatus` remains one state per conversation; this is the other question a client asks — what the
 * delegation's record, the anchor and the reporter each say about themselves — so a pending reporter and a preparation
 * whose failure the caller has not retried are two stated facts rather than one flattened `waiting-report`.
 *
 * Every field is the runtime's own value under the runtime's own name, absent exactly when the object states nothing:
 * there is no whole-child bucket, no aggregate flag and no default. `requestId` is stated because on this seam it **is**
 * the dispatch identity — a delegation's id is the caller's request id — and together with `preparationFailedTaskId` it
 * is the pair the retry of a failed preparation takes (the audit's G6): a reader that holds these facts can ask for the
 * retry of the child it is looking at **under the identity that child was created with**.
 */
export type ChildRecoveryFacts = {
  /**
   * The caller's stable request identity this dispatch answers. On this seam it **is** the dispatch id — a
   * delegation's id is the request id it was created under (spec D04) — and it is stated once, as `requestId`, because
   * it is one of the two values a preparation retry takes. A client therefore retries the child it is looking at under
   * the identity that child was created with; nothing here mints a second one.
   */
  readonly requestId: string;
  readonly definition?: string;
  readonly anchorTaskId?: string;
  readonly reporterTaskId?: string;
  /** The preparation the definition asked for, from the dispatch record: `fork` or `compact`. */
  readonly preparationStrategy?: string;
  /**
   * The retry state of the preparation, as the runtime's own `preparationUnretried` predicate names it: a stated
   * failure nobody has asked about is `unretried-failure` (the state a retry is offered on), and a failure the caller
   * has named once is `retried` — asking twice is naming it once.
   */
  readonly preparation?: "unretried-failure" | "retried";
  readonly preparationFailedTaskId?: string;
  readonly preparationRetriedTaskId?: string;
  readonly preparationError?: string;
  readonly preparationOutcome?: string;
  /** The anchor's own live phase; a task nobody can take or one a restart abandoned states itself rather than a phase. */
  readonly anchorPhase?: "preparing" | "admitting" | "idle" | "blocked" | "interrupted";
  /**
   * Where this dispatch's report stands: the reporter's live phase while it runs, `awaiting-delivery` once the child
   * settled and the report is recorded but not yet admitted, and the delivery the report record states thereafter.
   */
  readonly delivery?: "waiting-child" | "delivering" | "awaiting-delivery" | "delivered" | "recipient_deleted" | "recipient_missing" | "blocked" | "interrupted";
  readonly childSubmissionStatus?: "done" | "unanswered";
  readonly childSubmissionReason?: string;
};
/** The framework's own outcome for a conversation's newest terminal run: a reason and a client-safe message. */
export type ServerFailure = { readonly reason: string; readonly message: string };
/**
 * Committed resource loading state, as the backend publishes it on every conversation state frame. `pending` marks a
 * reload that has been committed but applies to the next run.
 */
export type ResourceSummary =
  | { readonly status: "loaded"; readonly skills: number; readonly prompts: number; readonly loadedAtMs: number; readonly pending: boolean }
  | { readonly status: "failed"; readonly error: string; readonly pending: boolean };
/**
 * Presentation of one tool call of the current round, as the wire carries it. Declared structurally, like
 * `SubmissionFacts`, so this package needs no dependency on the runtime that produces it: the shape is the runtime's
 * own slot rather than a narrowed copy, because the whole slot is what the wire carries. A backend whose slot ids are
 * branded passes its own type as the frame's second argument rather than casting them to strings here.
 */
export type LiveToolSlot = {
  readonly callId: string;
  readonly name: string;
  readonly taskId?: string;
  readonly status: "pending" | "running" | "done";
  readonly output?: string;
  readonly droppedBytes?: number;
  readonly droppedLines?: number;
  readonly details?: unknown;
  readonly diagnostics?: readonly unknown[];
  readonly entry?: string;
};
/**
 * One committed transcript entry on the wire: the runtime's message projection plus the compatible `text` rendering of
 * it, so a consumer that reads only text and one that reads the structured message cannot be handed two shapes.
 */
export type ServerEntry<TMessage = unknown> = { readonly id: string; readonly role: "user" | "assistant" | "toolResult"; readonly text: string; readonly message: TMessage };
/**
 * One complete state of a conversation as both transports publish it: the HTTP conversation read and the stream's
 * snapshot frame carry the same payload, so the two transports cannot state two different lifecycles for one
 * conversation.
 *
 * `entries` is the bounded **window**, never the whole transcript. Four fields state what that window is, and they
 * travel together on every surface that returns one, so a consumer can trim to the server's window instead of growing
 * a transcript of its own:
 *
 * - `historyRevision` — an opaque token over two committed, immutable facts (the newest head marker and the newest
 *   visible entry), so it is stable across two reads with no commit, changes on an append and on a head marker, is
 *   equal for two attachments of one conversation, and survives a backend restart on the same store. It is
 *   deliberately **not** `revision` (this attachment's publication counter) and **not** `projectionId` (an
 *   attachment identity): those are per-attachment clocks, and this answers a different question — "may I keep the
 *   history I already paged in".
 * - `historyHead` — the newest head marker's id, or null when the conversation has none. A client that sees it move
 *   knows the active context restarted (a compaction or a reset), which is the one event that ends a loaded prefix.
 * - `oldestEntryId` — the boundary the window **actually** has: the id of the first entry it carries, read off the
 *   entries it is publishing, and `null` when it carries the whole active range. It is what lets a client keep a
 *   prefix it already loaded and still replace everything the window covers.
 * - `hasMore` — at least one active entry exists older than the window, computed from the window's start index rather
 *   than from a scan.
 */
export type ServerSnapshot<TMessage = unknown, TToolSlot = LiveToolSlot> = {
  readonly protocol: ProtocolVersion;
  readonly revision: number;
  readonly conversationId: ConversationId;
  readonly projectionId: string;
  readonly historyRevision: string;
  readonly historyHead: string | null;
  readonly hasMore: boolean;
  readonly oldestEntryId: string | null;
  readonly run: { readonly inputs: readonly string[] } | null;
  readonly busy: boolean;
  readonly entries: readonly ServerEntry<TMessage>[];
  readonly partial: string;
  readonly workspaceId?: string;
  readonly toolNames: readonly string[];
  readonly extensions: readonly string[];
  readonly liveMessage?: TMessage;
  readonly liveTools: readonly TToolSlot[];
  readonly settings: ConversationSettings;
  readonly queuedMessages: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  /**
   * The same queue as a list of **items**: identity, mode, text, source and the token an edit is validated against, so
   * a surface can act on one item instead of only counting the queue. It is a projection of the same `pi.inbox` the
   * text lists beside it are, read in the same pass, so the two cannot disagree and neither is a second queue. A write
   * the queue holds for its own boundary is not user input and is not projected here (spec D09).
   */
  readonly queuedItems: readonly QueuedItemProjection[];
  /**
   * The conversation's committed input control: whether admission is `allowed` or `held`, its revision and the
   * trusted stop source. It rides the same frame as the queue it governs, so a client that reads "held" and a client
   * that reads a queued item read them from one statement (spec D07, D08).
   */
  readonly control: ConversationControlState;
  readonly resources?: ResourceSummary;
  readonly failure: ServerFailure | null;
  readonly submissions: readonly SubmissionProjection[];
};
/**
 * A frame that **continues** the revision a consumer already holds, instead of restating the window it already has.
 *
 * `baseRevision` is exactly the revision the frame is built on, and `appended` is what this advance produced. The
 * window itself is not re-serialized: the consumer keeps it, prunes its tail to the frame's own `oldestEntryId`, and
 * takes every scalar from this frame. A consumer whose current revision is not `baseRevision` cannot continue it and
 * answers by taking a fresh bounded read, which is the same answer a revision gap gets.
 */
export type ServerDelta<TMessage = unknown, TToolSlot = LiveToolSlot> = Omit<ServerSnapshot<TMessage, TToolSlot>, "entries"> & { readonly baseRevision: number; readonly appended: readonly ServerEntry<TMessage>[] };
export type ServerFrame<TMessage = unknown, TToolSlot = LiveToolSlot> = ServerSnapshot<TMessage, TToolSlot> | ServerDelta<TMessage, TToolSlot>;

/** The marker that a consumer's revision is not the one the publisher holds, so it must take a fresh read. */
export type ServerResyncFrame = { readonly protocol: ProtocolVersion; readonly conversationId: ConversationId; readonly revision: number };

/**
 * Stable projection of one durable submission: the lifecycle facts this protocol promises a browser, named here rather
 * than by the runtime record they were read from. The runtime's own types stay behind the adapter, so a runtime upgrade
 * changes the adapter and not the wire.
 */
export type SubmissionProjection = {
  protocol: ProtocolVersion;
  conversationId: ConversationId;
  submissionId: string;
  /** The host request the submission was admitted under; absent when the runtime recorded none. */
  requestId?: RequestId;
  type: "input" | "write";
  status: "queued" | "placed" | "done" | "unanswered";
  /** The transcript entry the submission owns, or the one it was answered by; absent while only queued. */
  entryId?: string;
  /**
   * The committed answer entry a `done` input was answered by; absent for a write, for an unanswered input and while
   * the input has no answer yet. It is the runtime's own identity for the answer, which is what a completion notice is
   * grouped by: a client cannot tell from the transcript alone which answer settles which input.
   */
  answerId?: string;
  /** Why an `unanswered` submission can never be answered. It is a durable fact, not a transport failure. */
  reason?: string;
};

/**
 * The durable submission facts a projection is built from. Declared structurally so this package needs no dependency on
 * the runtime that stores them: a caller passes the record it already holds.
 */
export type SubmissionFacts = {
  id: string | number;
  conversationId: string | number;
  requestId?: string;
  type: "input" | "write";
  status: "queued" | "placed" | "done" | "unanswered";
  entry?: string | number;
  answer?: string | number;
  reason?: string;
};

/** One submission as the wire names it. Identity is stringified, exactly as committed entry and conversation IDs are. */
export function projectSubmission(facts: SubmissionFacts): SubmissionProjection {
  return {
    protocol: PROTOCOL_VERSION,
    conversationId: String(facts.conversationId),
    submissionId: String(facts.id),
    ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    type: facts.type,
    status: facts.status,
    ...(facts.entry === undefined ? {} : { entryId: String(facts.entry) }),
    ...(facts.answer === undefined ? {} : { answerId: String(facts.answer) }),
    ...(facts.reason === undefined ? {} : { reason: facts.reason }),
  };
}

/**
 * One queued item as a surface reads it: the native identity a per-item operation addresses, the mode the runtime will
 * place it in, the text the model would receive, where the item came from, and the token an edit is validated against.
 *
 * The queue is the runtime's own `pi.inbox`; this is a **projection** of it, not a second queue. The bare text lists
 * beside it in a snapshot stay for the consumers that only count or echo the queue, so nothing about an existing
 * reader changes (spec D09).
 */
export type QueuedItemMode = "steer" | "followUp";

/**
 * Where one queued item came from. A user's own input and an automatic report share one queue — and one set of
 * per-item controls — but they are told apart here, and a report carries the source references its preview came from,
 * so a surface can name the child and open the whole answer it only received a cut of (spec D05, D09).
 */
export type QueuedItemSource =
  | { readonly kind: "user" }
  | {
    readonly kind: "report";
    readonly dispatchId: string;
    readonly childConversationId: string;
    /** The child submission that settled, and the terminal status it settled as. */
    readonly submissionId: string;
    readonly submissionStatus: "done" | "unanswered";
    readonly answerEntryId?: string;
    readonly answerReason?: string;
    readonly preview: {
      readonly bytes: number;
      readonly droppedBytes: number;
      readonly droppedLines: number;
      readonly sourceTruncated: boolean;
      readonly maxBytes: number;
      readonly maxLines: number;
    };
  };

/** One queued item, as the wire names it. Identity is stringified, exactly as committed entry and conversation IDs are. */
export type QueuedItemProjection = {
  readonly protocol: ProtocolVersion;
  readonly conversationId: ConversationId;
  /** The native submission this item is; the identity every per-item operation addresses. */
  readonly submissionId: string;
  /** The host request the item was admitted under; absent when the runtime recorded none. */
  readonly requestId?: RequestId;
  readonly mode: QueuedItemMode;
  /** The text the model would read if this item is placed, exactly as the queue holds it. */
  readonly content: string;
  readonly source: QueuedItemSource;
  /**
   * The token of `content` at this revision. An edit names the token it read, and a token that no longer matches is a
   * conflict answered with the **current** item: a stale tab cannot overwrite a newer decision (spec D09, A11).
   */
  readonly contentToken: string;
  /** Whether this item can still be edited: a queued item can, a placed or settled one cannot. */
  readonly editable: boolean;
  /** Whether this item can still be cancelled: the same condition, through the native abort. */
  readonly cancelable: boolean;
};

/**
 * The durable facts one queued item is projected from. Declared structurally so this package needs no dependency on the
 * runtime that stores them: a caller passes what it already read from the item and the submission beside it.
 */
export type QueuedItemFacts = {
  readonly submissionId: string | number;
  readonly conversationId?: string | number;
  readonly requestId?: string;
  readonly mode: QueuedItemMode;
  /** The item's text, already rendered from its native content blocks by the caller's own projection. */
  readonly content: string;
  /** The report entry's own data, when this item was admitted as one; absent for a user's input. */
  readonly report?: {
    readonly dispatchId: string;
    readonly childConversationId: string;
    readonly submissionId: string;
    readonly submissionStatus: "done" | "unanswered";
    readonly answerEntryId?: string;
    readonly answerReason?: string;
    readonly preview: {
      readonly bytes: number;
      readonly droppedBytes: number;
      readonly droppedLines: number;
      readonly sourceTruncated: boolean;
      readonly maxBytes: number;
      readonly maxLines: number;
    };
  };
};

/**
 * The content token of one queued item: a deterministic digest of the text, so two reads of an unchanged item produce
 * the same token and any edit produces a different one.
 *
 * It is a **conditional-edit token**, not an authorization and not a revision of the conversation: it says "the text I
 * read is still the text you have", which is the one thing an edit has to confirm. The length travels with the digest
 * so two texts of different length can never collide on a truncated prefix.
 */
export function pendingContentToken(content: string): string {
  const bytes = new TextEncoder().encode(content);
  // FNV-1a over the UTF-8 bytes, stated twice with different offsets so a 32-bit collision needs both to agree.
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const byte of bytes) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0;
  }
  return bytes.length.toString(16) + "-" + first.toString(16).padStart(8, "0") + second.toString(16).padStart(8, "0");
}

/** One queued item as the wire names it, from the facts a reader already holds. */
export function projectQueuedItem(facts: QueuedItemFacts): QueuedItemProjection {
  const source: QueuedItemSource = facts.report === undefined
    ? { kind: "user" }
    : {
      kind: "report",
      dispatchId: facts.report.dispatchId,
      childConversationId: facts.report.childConversationId,
      submissionId: facts.report.submissionId,
      submissionStatus: facts.report.submissionStatus,
      ...(facts.report.answerEntryId === undefined ? {} : { answerEntryId: facts.report.answerEntryId }),
      ...(facts.report.answerReason === undefined ? {} : { answerReason: facts.report.answerReason }),
      preview: { ...facts.report.preview },
    };
  return {
    protocol: PROTOCOL_VERSION,
    conversationId: String(facts.conversationId ?? ""),
    submissionId: String(facts.submissionId),
    ...(facts.requestId === undefined ? {} : { requestId: facts.requestId }),
    mode: facts.mode,
    content: facts.content,
    source,
    contentToken: pendingContentToken(facts.content),
    // A queued item is projected only while it is queued, so both controls are stated as available; the item is
    // projected from the same read that decided it is still in the inbox, which is what makes this not a guess.
    editable: true,
    cancelable: true,
  };
}

export type WorkspaceValidationResult = { ok: true } | { ok: false; code: "invalid_workspace_cwd" | "secret_field_not_allowed" | "invalid_workspace" };

export function validateWorkspace(value: unknown): WorkspaceValidationResult {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.gatewayId !== "string" || (value.kind !== "local" && value.kind !== "ssh")) return { ok: false, code: "invalid_workspace" };
  if (typeof value.cwd !== "string" || !value.cwd.startsWith("/")) return { ok: false, code: "invalid_workspace_cwd" };
  if ("privateKey" in value || "password" in value || "token" in value) return { ok: false, code: "secret_field_not_allowed" };
  if (value.kind === "ssh" && (typeof value.sshProfile !== "string" || value.sshProfile.trim() === "")) return { ok: false, code: "invalid_workspace" };
  return { ok: true };
}

/**
 * At most MAX_SUBMISSION_IMAGES base64 images of MAX_SUBMISSION_IMAGE_BYTES each. The browser composer and this
 * validator share these limits, so a submission the composer accepted is never silently dropped by the command layer.
 */
export function validateSubmitImages(value: unknown): CommandValidationResult | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return { ok: false, code: "invalid_images", message: "images must be an array" };
  if (value.length > MAX_SUBMISSION_IMAGES) return { ok: false, code: "invalid_images", message: "A message can include at most " + MAX_SUBMISSION_IMAGES + " images" };
  for (const image of value) {
    if (!isRecord(image) || image.type !== "image") return { ok: false, code: "invalid_images", message: "Each attachment must be an image" };
    if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) return { ok: false, code: "invalid_images", message: "Each attachment must be valid base64 image data of " + MAX_SUBMISSION_IMAGE_BYTES / (1024 * 1024) + "MB or smaller" };
    const bytes = base64DecodedByteLength(image.data);
    if (bytes === null || bytes > MAX_SUBMISSION_IMAGE_BYTES) return { ok: false, code: "invalid_images", message: "Each attachment must be valid base64 image data of " + MAX_SUBMISSION_IMAGE_BYTES / (1024 * 1024) + "MB or smaller" };
  }
  return { ok: true };
}

function base64DataChar(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
}

/** Decoded byte length of padded base64, or null when the value is not base64. */
function base64DecodedByteLength(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataEnd = value.length - padding;
  for (let index = 0; index < dataEnd; index += 1) if (!base64DataChar(value.charCodeAt(index))) return null;
  for (let index = dataEnd; index < value.length; index += 1) if (value[index] !== "=") return null;
  return (value.length / 4) * 3 - padding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The wire policy for deferred tool-result images: which images a history frame may replace with the URL of the read
 * block that serves them, and how large one may be. It lives here rather than in a Web copy because the server now
 * produces that shape and must not emit a URL for an image it would refuse to serve.
 *
 * It was duplicated in two Web copies (`apps/web/lib/tool-result-images.ts` and its vendored provenance copy). The
 * executable Web copy was retired with the dormant Web runtime (ticket 04); the vendored snapshot stays byte-identical
 * as provenance, and this is the only executable copy.
 */
export const MAX_TOOL_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;

export const TOOL_RESULT_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

/**
 * The read block for one deferred image block of one entry. The shape and the path are the copied app's own, so the
 * browser half — which already fetches this URL when a collapsed tool result is expanded — keeps working unchanged.
 *
 * It serves the image of the **message that carries it, whatever its role**: the same policy defers a tool result's
 * screenshot and a user's own accepted prompt attachment, so the name is the copied app's read block rather than a
 * claim about which role produced the block.
 */
export function toolResultImageUrl(sessionId: string, entryId: string, blockIndex: number): string {
  return "/api/sessions/" + encodeURIComponent(sessionId) + "/entries/" + encodeURIComponent(entryId) + "/tool-result-image?blockIndex=" + blockIndex;
}

/** The read block for one deferred thinking block: the full text the preview replaced. */
export function thinkingUrl(sessionId: string, entryId: string, blockIndex: number): string {
  return "/api/sessions/" + encodeURIComponent(sessionId) + "/entries/" + encodeURIComponent(entryId) + "/thinking?blockIndex=" + blockIndex;
}

/**
 * The read block for one deferred **text** block: the full text the preview replaced.
 *
 * It is the third member of one family — thinking, tool-result image, text — and it exists for the same reason the
 * other two do: a frame carries a bounded representation of heavy history content, and the read block restores exactly
 * what the preview replaced. Text is the one heavy class with no read block upstream, which is why a large accepted
 * prompt, answer or tool output used to be unreachable from the browser even though it was committed and readable by
 * id.
 *
 * The path is under the same `/api/sessions/:id/entries/:entryId/…` prefix the other two use, so one proxy rule and
 * one browser loader pattern serve all three.
 */
export function textUrl(sessionId: string, entryId: string, blockIndex: number): string {
  return "/api/sessions/" + encodeURIComponent(sessionId) + "/entries/" + encodeURIComponent(entryId) + "/text?blockIndex=" + blockIndex;
}

export * from "./sidebar-state.ts";
export * from "./navigation.ts";
