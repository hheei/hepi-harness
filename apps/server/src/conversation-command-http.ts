import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type ImageContent, type Models, type TextContent } from "@earendil-works/pi-ai";
import {
  ConversationBusy,
  InboxDoc,
  type AgentChange,
  type AgentState,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Harness,
  type ConversationStreamOptions,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { MAX_SUBMISSION_BODY_BYTES, PROTOCOL_VERSION, projectSubmission, validateCommand, type ProtocolCommand, type SubmitImage } from "@hepi/protocol";
import { safeFailure } from "./public-errors.ts";
import { TitleDoc, type ConversationRuntime } from "./conversation-attachments.ts";
import { handleConversationItems, type ConversationItemOperations } from "./conversation-items.ts";
import { ConversationOperationRefusal, type ConversationOperations } from "./conversation-operations.ts";
import { buildTitleTranscript, generateSessionTitle, MAX_TITLE_LENGTH } from "./session-title.ts";
import { tombstoneConversation } from "./session-tombstone.ts";
import { SubtreeControlRefusal, type SubtreeControlResult } from "./subtree-control.ts";
import { createForkAnchor } from "./subagents/anchor.ts";
import type { SubagentHost } from "./subagents/host.ts";
import { createSubagentDelegation, delegateDetails } from "./subagents/delegate.ts";
import { childRecovery, preparationRetryTarget } from "./subagents/recovery.ts";

/**
 * The conversation command routes: everything a client does to one conversation that already exists.
 *
 * One conversation's identity and configuration, its name, its removal, its fork, the delegated children it owns, the
 * input it admits, and the control a user holds over a run. Every route is the operation that already owns the
 * behaviour — the creation, relation and control seam, the admission seam, the delegation seam, the per-item
 * operations, the native abort — so this module decides only what a request states and which refusal a caller reads.
 * It writes no durable model of its own.
 *
 * What it does own is each answer's exactness: the status a refusal is written with, the fields a caller acts on, and
 * the body limits. An ordinary message, a resume's input and a queue-only steer are read at the submission limit; a
 * per-item edit at the same limit. A removed conversation refuses a new turn, a queue write and a naming for the same
 * reason: the caller would be writing into records no surface shows.
 *
 * The routes are the backend's own; the Web adapter's `/api/sessions/:id/...` mapping happens above this process. A
 * conversation the attachment map does not hold is answered here, because resolving that identity is this module's
 * first fact; everything else it does not recognise is left to the caller (`false`).
 */

/** One child's outcome with its current session row attached, which is what a subtree answer projects. */
export type SubtreeAnswer = (controlled: SubtreeControlResult) => Promise<unknown>;

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

export type ConversationCommandHttpOptions = {
  /** The conversation one path segment names, from the attachment map this backend owns. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
  /** The one creation, relation and control seam every conversation-creating and controlling surface goes through. */
  readonly operations: ConversationOperations;
  /** The per-item operations over the runtime's own `pi.inbox`: a projection read, a conditional edit, a cancel. */
  readonly items: ConversationItemOperations;
  /** The one delegation seam the extension's own tools and this route share. */
  readonly delegation: ReturnType<typeof createSubagentDelegation>;
  /** The subagent host, for the one retry write the recovery route performs. */
  readonly subagentHost: SubagentHost;
  /** The runtime's harness: committed reads and the one retry write are made on it. */
  readonly harness: Harness;
  /** This backend's model catalog: the fork's and the settings route's validation, and the auto-name's model. */
  readonly models: Models;
  /** The curated request options a title generation uses, so the naming request follows this deployment's transport. */
  readonly stream: ConversationStreamOptions | undefined;
  /** Attach a conversation this route created, so the next read finds it in the catalogue. */
  readonly attach: (conversation: Conversation, ancestry?: { readonly forkSource?: string; readonly subagentParent?: string }) => Promise<ConversationRuntime>;
  /** The catalogue row one answer states for a conversation, from the one catalogue projection. */
  readonly catalogueRow: (item: ConversationRuntime) => Promise<unknown>;
  /** One subtree request's answer, with each child's current session row beside its recorded outcome. */
  readonly subtreeAnswer: SubtreeAnswer;
  /** The submission content of one input: the expanded text plus the images as native content blocks. */
  readonly submissionContent: (item: ConversationRuntime, text: string, images: readonly SubmitImage[]) => Promise<string | (TextContent | ImageContent)[]>;
  /** Why a submission carrying these images must be refused, or nothing when it may be admitted. */
  readonly imageRefusal: (item: ConversationRuntime, images: readonly SubmitImage[]) => { readonly code: string; readonly message: string } | undefined;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

export function createConversationCommandHttp(options: ConversationCommandHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "conversations") return false;
    const id = parts[2];
    // Only a conversation-scoped path belongs to this module: the catalogue's own `/api/conversations` is another
    // owner's route, and claiming it here would answer the list as an unknown conversation.
    if (id === undefined) return false;
    const item = options.conversation(id);
    // Every conversation-scoped route refuses an unknown conversation the same way, with the code a caller needs to
    // name the refusal in its own language rather than echoing an English sentence.
    if (item === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return true; }
    const action = parts[3];
    // One conversation's identity: its catalogue row plus the relations it records, its native record edges, the
    // references it makes and its effective configuration. The row comes from the same catalogue projection the list
    // uses, and the rest from the one relations seam, so a by-id read and a list read cannot state two creators. A
    // removed conversation still answers — its records are retained — and its relations stay readable.
    if (request.method === "GET" && parts.length === 3) {
      const info = await options.operations.get(id);
      if (info === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return true; }
      json(response, 200, { protocol: PROTOCOL_VERSION, conversation: await options.catalogueRow(item), ...info }); return true;
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
      const body = await options.readBody(request) as { name?: unknown; task?: unknown; conversationId?: unknown; requestId?: unknown } | undefined;
      if (typeof body?.name !== "string" || body.name.trim() === "") { json(response, 400, { code: "invalid_request", error: "name is the agent definition to run" }); return true; }
      if (typeof body.task !== "string" || body.task.trim() === "") { json(response, 400, { code: "invalid_request", error: "task is the child's complete task" }); return true; }
      const requestId = typeof body.requestId === "string" && body.requestId.trim() !== "" ? body.requestId : randomUUID();
      // A dispatch to a conversation that already exists is a different operation: it creates nothing, and the target
      // keeps its identity, its history and its configuration (spec D05).
      if (body.conversationId !== undefined) {
        if (typeof body.conversationId !== "string" || body.conversationId.trim() === "") { json(response, 400, { code: "invalid_request", error: "conversationId must be a conversation id" }); return true; }
        const dispatched = await options.delegation.dispatch({ delegating: id, requestId, targetConversationId: body.conversationId, task: body.task });
        if (!dispatched.ok) { json(response, dispatched.code === "not_found" ? 404 : 409, { protocol: PROTOCOL_VERSION, code: dispatched.code, error: dispatched.message }); return true; }
        const target = options.conversation(dispatched.conversationId);
        json(response, 202, {
          protocol: PROTOCOL_VERSION,
          conversationId: dispatched.conversationId,
          dispatchId: dispatched.dispatchId,
          requestId,
          ...(dispatched.submissionId === "" ? {} : { submissionId: dispatched.submissionId }),
          ...(target === undefined ? {} : { conversation: await options.catalogueRow(target) }),
        }); return true;
      }
      const answered = await options.delegation.delegate({ delegating: id, requestId, definition: body.name, task: body.task });
      if (!answered.ok) {
        // The refusals a caller has to tell apart are the ones a user can act on: an over-limit request is a refusal and
        // not a queue, and an unresolvable definition is a configuration problem rather than a conflict.
        const status = answered.code === "depth_exceeded" || answered.code === "children_exceeded" ? 409
          : answered.code === "unknown_definition" || answered.code === "no_execution_host" || answered.code === "unknown_workspace" ? 404
          : 400;
        json(response, status, { protocol: PROTOCOL_VERSION, code: answered.code, error: answered.message }); return true;
      }
      const existing = options.conversation(answered.childConversationId);
      const attached = existing ?? await (async () => {
        const record = await options.harness.conversation(Number(answered.childConversationId) as ConversationId, BACKGROUND_CONTEXT);
        return record === undefined ? undefined : options.attach(record, { subagentParent: id });
      })();
      json(response, answered.created ? 201 : 200, {
        protocol: PROTOCOL_VERSION,
        ...delegateDetails(answered) as object,
        ...(attached === undefined ? {} : { conversation: await options.catalogueRow(attached) }),
      }); return true;
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
      const recovery = await childRecovery(options.harness, id);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, ...(recovery === undefined ? { recovery: null } : { recovery }) });
      return true;
    }
    if (request.method === "POST" && action === "recovery" && parts.length === 4) {
      const body = await options.readBody(request) as { requestId?: unknown; failedTaskId?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is the dispatch identity the recovery read answered with" }); return true; }
      if (typeof body.failedTaskId !== "string" || body.failedTaskId.trim() === "") { json(response, 400, { code: "invalid_request", error: "failedTaskId is the preparation attempt this retry names" }); return true; }
      const target = await preparationRetryTarget(options.harness, id);
      if (!target.ok) { json(response, 409, { protocol: PROTOCOL_VERSION, code: target.code, error: target.message }); return true; }
      if (target.requestId !== body.requestId || target.failedTaskId !== body.failedTaskId) {
        json(response, 409, { protocol: PROTOCOL_VERSION, code: "identity_stale", error: "conversation " + id + " now states dispatch " + target.requestId + " and failed attempt " + target.failedTaskId + ", so this request names a different attempt" });
        return true;
      }
      await options.subagentHost.retryPreparation(target.delegatingConversationId, target.requestId, target.failedTaskId);
      const recovery = await childRecovery(options.harness, id);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: target.requestId, failedTaskId: target.failedTaskId, recovery });
      return true;
    }
    // A structured reference from this conversation to another, optionally to one entry of it. It is saved as this
    // conversation's own state: the target's relations, workspace and owner are untouched, and the reference grants no
    // control over it and copies none of its content. A repeated reference to the same target **and entry** is
    // idempotent, and one that could not be followed is refused by name before anything is stored — a removed target
    // is `target-unavailable`, an entry outside the target's visible committed fork-aware history is `entry-missing`
    // or `entry-out-of-scope` — so the answer states the same named outcome the resolving read reports later.
    if (request.method === "POST" && action === "references" && parts.length === 4) {
      const body = await options.readBody(request) as { conversationId?: unknown; entryId?: unknown; label?: unknown } | undefined;
      if (typeof body?.conversationId !== "string" || body.conversationId.trim() === "") { json(response, 400, { code: "invalid_request", error: "conversationId is required" }); return true; }
      if (body.entryId !== undefined && typeof body.entryId !== "string") { json(response, 400, { code: "invalid_request", error: "entryId must be an entry id string" }); return true; }
      if (body.label !== undefined && typeof body.label !== "string") { json(response, 400, { code: "invalid_request", error: "label must be a string" }); return true; }
      try {
        const references = await options.operations.addReference(id, { conversationId: body.conversationId, ...(body.entryId === undefined ? {} : { entryId: body.entryId }), ...(body.label === undefined ? {} : { label: body.label }) });
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: id, references }); return true;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
    }
    // Recovery, not the normal path: a client whose send or stream ended before it could tell admission from failure
    // asks the conversation about the one submission it made, by the request id it generated. The answer is the durable
    // record itself — terminal or not — so nothing is inferred and nothing is resent. An id this conversation never
    // admitted answers null, which is a statement about that request and not a failed lookup.
    if (request.method === "GET" && action === "submissions") {
      const requestId = url.searchParams.get("requestId");
      if (requestId === null || requestId.trim() === "") { json(response, 400, { error: "requestId required" }); return true; }
      const record = await item.conversation.commit(tx => tx.submissionByRequest(item.conversation.id, requestId), BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, submission: record === undefined ? null : projectSubmission(record) }); return true;
    }
    // Rename: the name a user sets for a conversation, stored as this conversation's own hepi document. The
    // request and response shape follow upstream's `PATCH /api/sessions/[id]` ({ name }) so the existing browser
    // surface keeps its contract, while the state it writes is durable conversation-scoped hepi state and not a file.
    if (request.method === "PATCH" && parts.length === 3) {
      const body = await options.readBody(request) as { name?: unknown } | undefined;
      const title = typeof body?.name === "string" ? body.name.trim() : undefined;
      if (title === undefined) { json(response, 400, { code: "invalid_request", error: "name is required" }); return true; }
      if (title === "") { json(response, 400, { code: "invalid_request", error: "a session name of 1 to " + MAX_TITLE_LENGTH + " characters is required" }); return true; }
      if ([...title].length > MAX_TITLE_LENGTH) { json(response, 400, { code: "invalid_request", error: "a session name of 1 to " + MAX_TITLE_LENGTH + " characters is required" }); return true; }
      await item.conversation.commit(async (tx) => { (await tx.doc(TitleDoc, item.conversation.id)).title = title; }, BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, name: title }); return true;
    }
    // Auto-name, on an explicit request only (spec decisions 16 and 25): the name is generated from this
    // conversation's own committed transcript by the model this conversation already selected, and written as the
    // same hepi title document the rename writes, so the catalogue lists it in the read that lists the session. No
    // path names a conversation implicitly, and a name the user typed is replaced only here, by this request. The
    // request and response shape follow upstream's `POST /api/sessions/[id]/auto-name`.
    if (request.method === "POST" && action === "auto-name") {
      // A removed conversation is out of the catalogue but its records are retained, so it is still reachable by id.
      // Naming it would produce a name no surface can show, so it is refused with the reason the caller reads.
      if (item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return true; }
      const selected = item.snapshot().settings.model;
      const model = selected === null ? undefined : options.models.getModel(selected.provider, selected.modelId);
      // The framework's own wording for the same failure: a conversation whose selection is gone is told which model
      // is missing, and a deployment that configured none is told that, rather than being handed a manufactured one.
      if (model === undefined) { json(response, 409, { code: "no_model", error: selected === null ? "No model is configured" : "Model " + selected.provider + "/" + selected.modelId + " is not available" }); return true; }
      // The transcript is this conversation's committed model context, read through the runtime's own public read: a
      // turn still in flight only means the newest reply is missing from it, and there is nothing to wait for.
      const transcript = buildTitleTranscript((await item.conversation.context(BACKGROUND_CONTEXT)).messages);
      if (transcript.trim() === "") { json(response, 409, { code: "no_transcript", error: "The session has no usable text to name" }); return true; }
      try {
        const title = await generateSessionTitle({ models: options.models, model, transcript, stream: options.stream });
        await item.conversation.commit(async (tx) => { (await tx.doc(TitleDoc, item.conversation.id)).title = title; }, BACKGROUND_CONTEXT);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, title });
      } catch (error) {
        // A failed generation writes nothing: the name the conversation had is the name it keeps, and the reason is
        // reported so the surface can say what failed instead of showing a name that was never stored.
        json(response, 502, { code: "title_failed", error: safeFailure(error) });
      }
      return true;
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
      await tombstoneConversation(options.harness, item.conversation.id, [id], Date.now());
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, removed: true }); return true;
    }
    // Fork: the new conversation inherits the source's history up to the chosen entry, with the runtime's own
    // fork-aware history and document semantics, and the source is only read, so a live run in it is untouched. Body
    // `{ at?, requestId? }` names the entry — without one the conversation's newest committed entry is the fork point,
    // which is what the sidebar's row menu asks for — and the request identity that makes a retry after a lost answer
    // answer the branch the first attempt created. Everything that can refuse is answered before the fork, and the fork
    // itself is the one creation seam's atomic commit, so a refusal creates nothing. The upstream route's request and
    // response shapes are the contract: answer the new identity plus its catalogue row.
    if (request.method === "POST" && action === "fork") {
      const body = await options.readBody(request) as { at?: unknown; requestId?: unknown; model?: ModelRef; thinkingLevel?: unknown } | undefined;
      const refusal = (code: ForkRefusal) => { json(response, FORK_REFUSALS[code].status, { protocol: PROTOCOL_VERSION, code, error: FORK_REFUSALS[code].error }); };
      const named = body?.at;
      // A named fork point that is not an entry id cannot be one this conversation holds: the upstream "unsaved"
      // source, a client whose transcript is ahead of the durable conversation.
      if (named !== undefined && (typeof named !== "string" || !/^[0-9]+$/.test(named))) { refusal("unsaved"); return true; }
      // A conversation a task owns is a subagent's, and a copy of it is a branch of that subagent: it keeps the
      // conversation it was taken from as its display parent and gets an **independent** native owner — a background
      // anchor of the source's own scope — so it is dispatched, queued and controlled on its own and the source's task
      // is never reused. A branch of an ordinary conversation stays ownerless and top-level, as it always was, so the
      // native fork source and the display parent stay two different facts (spec D14, A17).
      const record = await options.harness.commit(tx => tx.conversation(item.conversation.id), BACKGROUND_CONTEXT);
      if (record === undefined) { refusal("not_found"); return true; }
      const child = record.owner !== undefined;
      // The newest committed entry of the conversation's fork-aware history is its leaf, which is the point a fork
      // with no `at` starts from. Read through the public history read rather than inferred from the view, whose last
      // element is not the newest entry once a head marker leads the active range.
      const leaf = named ?? (await item.conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id;
      if (leaf === undefined) { refusal("empty"); return true; }
      const entryId = Number(leaf) as EntryId;
      // The view the fork would start with, read through the same as-of context a fork uses. It throws for an entry
      // that is not visible from this conversation, which is the refusal; a branch carrying no user or assistant
      // message has nothing to continue from.
      let branch;
      try { branch = await item.conversation.context(BACKGROUND_CONTEXT, { at: entryId }); }
      catch { refusal("unsaved"); return true; }
      if (!branch.entries.some(entry => entry.model?.some(message => message.role === "user" || message.role === "assistant"))) { refusal("empty"); return true; }
      const requestId = typeof body?.requestId === "string" && body.requestId.trim() !== "" ? body.requestId : randomUUID();
      // A branch starts from the configuration in force at the entry it was taken from — the native agent document
      // forks `asOf` — and a caller may name a field to replace on top of that copy. The two fields are the ones the
      // settings route already validates, so a branch cannot be created with a configuration this backend would refuse
      // to store: an unknown model or level is answered before the fork, exactly as it is on the settings route.
      if (body?.model !== undefined && options.models.getModel(body.model.provider, body.model.modelId) === undefined) { json(response, 400, { code: "unknown_model", error: "unknown model" }); return true; }
      if (body?.thinkingLevel !== undefined && (typeof body.thinkingLevel !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(body.thinkingLevel))) { json(response, 400, { code: "invalid_thinking_level", error: "invalid thinking level" }); return true; }
      const overrides: AgentChange = {
        ...(body?.model === undefined ? {} : { model: body.model }),
        ...(body?.thinkingLevel === undefined ? {} : { thinkingLevel: body.thinkingLevel as AgentState["thinkingLevel"] }),
      };
      try {
        const spawned = await options.operations.spawn({
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
        const attached = await options.attach(spawned.conversation, { forkSource: id, ...(child ? { subagentParent: id } : {}) });
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: spawned.conversationId, conversation: await options.catalogueRow(attached) }); return true;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
    }
    // One user message, through the one admission seam: an idle conversation places it and runs, a busy one queues
    // it, and a conversation the user has stopped is resumed by this dispatch — an immediate send is the user's own
    // decision to continue, so it clears `held` atomically with the admission. The caller is the authenticated host,
    // never the body, so no request can claim to be someone else (spec D02, D07).
    if (request.method === "POST" && action === "messages") {
      // A removed conversation is out of the catalogue but its records are retained, so it is still reachable by id.
      // A new turn on it would be a turn the user cannot see, so it is refused with the reason the caller reads.
      if (item.deletedAt() !== undefined) { json(response, 409, { ok: false, code: "session_deleted", accepted: false, message: "This session was deleted. Start a new session to continue." }); return true; }
      const body = await options.readBody(request, MAX_SUBMISSION_BODY_BYTES);
      const command = { ...(typeof body === "object" && body !== null ? body : {}), conversationId: id } as ProtocolCommand;
      const validation = validateCommand(command, { conversationWorkspaceId: item.snapshot().workspaceId });
      if (!validation.ok) { json(response, 400, validation); return true; }
      const whenBusy = (body as { whenBusy?: unknown }).whenBusy;
      if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp" && whenBusy !== "reject") { json(response, 400, { error: "invalid busy behavior" }); return true; }
      const images = command.images ?? [];
      const refusedImages = options.imageRefusal(item, images);
      if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return true; }
      try {
        const sent = await options.operations.send(id, { requestId: command.requestId, caller: "user", content: await options.submissionContent(item, command.text, images), whenBusy: whenBusy ?? "followUp" });
        // A held conversation turns this send into a resume, and the answer states how that went: `stopping` means the
        // old stop still drains and the same request id finishes the intent, which is what the composer retries.
        json(response, 202, { protocol: PROTOCOL_VERSION, requestId: command.requestId, ...(sent.submissionId === undefined ? {} : { submissionId: sent.submissionId }), ...(sent.status === undefined ? {} : { status: sent.status, ...(sent.reason === undefined ? {} : { reason: sent.reason }) }), control: sent.control });
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
        json(response, 409, { code: "conversation_busy", accepted: false });
      }
      return true;
    }
    // The native abort contract is unchanged and stays separate from a stop: it withdraws the queued inputs, marks the
    // ordinary scope for abort and waits for it, and it never sets a hold. A user who wants the conversation to stay
    // paused until they say otherwise uses `stop` (spec D07).
    if (request.method === "POST" && action === "abort") { await item.conversation.abort(BACKGROUND_CONTEXT); json(response, 202, { protocol: PROTOCOL_VERSION, state: "interrupted" }); return true; }
    // Stop: the trusted user's own decision, committed atomically with the withdrawal of the inputs queued at this
    // point and the abort marks of the conversation's ordinary live tasks. It never waits for the drain, so the answer
    // states whether the ordinary scope is already idle; input arriving after the commit stays queued and visible, and
    // repeating the same request id returns the same durable receipt instead of clearing the later items (spec D07).
    if (request.method === "POST" && action === "stop") {
      const body = await options.readBody(request) as { requestId?: unknown; expectedControlRevision?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return true; }
      if (body.expectedControlRevision !== undefined && (!Number.isInteger(body.expectedControlRevision) || (body.expectedControlRevision as number) < 0)) { json(response, 400, { code: "invalid_request", error: "expectedControlRevision must be a non-negative integer" }); return true; }
      try {
        const stopped = await options.operations.stop(id, { requestId: body.requestId, stopSource: "user", ...(body.expectedControlRevision === undefined ? {} : { expectedControlRevision: body.expectedControlRevision as number }) });
        json(response, stopped.status === "rejected" ? 409 : 202, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: body.requestId, status: stopped.status, ...(stopped.reason === undefined ? {} : { reason: stopped.reason }), drain: stopped.drain, control: stopped.control, receipt: stopped.receipt });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return true;
    }
    // Continue: the user's explicit resume. While the old stop's ordinary scope still drains the answer is `stopping`
    // and every queued input stays; once the native scope is idle the same commit clears `held`, admits the optional
    // input and consumes the held period's queue. An empty continue starts no run and invents no user message, and a
    // retry of the same request id reads its durable receipt instead of performing the resume twice (spec D08).
    if (request.method === "POST" && action === "continue") {
      const body = await options.readBody(request, MAX_SUBMISSION_BODY_BYTES) as { requestId?: unknown; expectedControlRevision?: unknown; text?: unknown; images?: unknown; whenBusy?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return true; }
      if (body.expectedControlRevision !== undefined && (!Number.isInteger(body.expectedControlRevision) || (body.expectedControlRevision as number) < 0)) { json(response, 400, { code: "invalid_request", error: "expectedControlRevision must be a non-negative integer" }); return true; }
      const text = body.text === undefined ? undefined : body.text;
      if (text !== undefined && typeof text !== "string") { json(response, 400, { code: "invalid_request", error: "text must be a string" }); return true; }
      const images = (body.images ?? []) as readonly SubmitImage[];
      if (!Array.isArray(body.images ?? []) || (body.images !== undefined && !Array.isArray(body.images))) { json(response, 400, { code: "invalid_request", error: "images must be an array" }); return true; }
      // The resume's optional input is admitted under the runtime's own admission, so it is validated exactly as an
      // ordinary message: a body that would not be a valid submission is refused before the resume commit.
      if (text !== undefined || images.length > 0) {
        const command = { protocol: PROTOCOL_VERSION, type: "conversation.submit", conversationId: id, requestId: body.requestId, text: text ?? "", ...(images.length > 0 ? { images } : {}) } as ProtocolCommand;
        const validation = validateCommand(command, { conversationWorkspaceId: item.snapshot().workspaceId });
        if (!validation.ok) { json(response, 400, validation); return true; }
        const refusedImages = options.imageRefusal(item, images);
        if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return true; }
      }
      const whenBusy = body.whenBusy;
      if (whenBusy !== undefined && whenBusy !== "steer" && whenBusy !== "followUp") { json(response, 400, { code: "invalid_request", error: "whenBusy must be steer or followUp" }); return true; }
      try {
        // The resume's input is admitted under the resume's **own** request id, so a retry after a lost answer is one
        // identity end to end: the control receipt answers the resume and the submission answers the message.
        const resumed = await options.operations.continue(id, {
          requestId: body.requestId,
          caller: "user",
          ...(body.expectedControlRevision === undefined ? {} : { expectedControlRevision: body.expectedControlRevision as number }),
          ...(text === undefined && images.length === 0 ? {} : { input: { content: await options.submissionContent(item, text ?? "", images), whenBusy: whenBusy ?? "followUp" } }),
        });
        json(response, resumed.status === "rejected" ? 409 : 202, { protocol: PROTOCOL_VERSION, conversationId: id, requestId: body.requestId, status: resumed.status, ...(resumed.reason === undefined ? {} : { reason: resumed.reason }), ...(resumed.submissionId === undefined ? {} : { submissionId: resumed.submissionId }), control: resumed.control, receipt: resumed.receipt });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return true;
    }
    // The control state and one durable receipt. A caller whose stop or continue answer was lost reads back what really
    // happened instead of re-sending an intent, and the answer states the *latest* control so an older operation's
    // receipt can never be read as the current state (spec D08).
    if (request.method === "GET" && action === "control") {
      const requestId = url.searchParams.get("requestId") ?? undefined;
      try {
        const current = await options.operations.control(id, requestId === undefined || requestId.trim() === "" ? undefined : requestId);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, control: current.control, receipt: current.receipt ?? null });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return true;
    }
    // Subtree control: an explicit stop or interrupt of the **captured** descendant subtree, which is a different
    // decision from this conversation's own stop. A parent's stop stays local (spec decision 1), so this route is the
    // only one that reaches children, and it reaches them through the same `stop`/`abort` contracts every other caller
    // uses. The scope is captured by the first request under a request id and answered from that capture on a replay, so
    // a child created afterwards is never implicitly included; a selective request names a subset of the same capture.
    // The answer states one outcome and one current control state per child, so a partial result is visible instead of
    // being flattened into a single status, and nothing here touches history, relations or tombstones (spec D01-D05).
    if (request.method === "POST" && action === "subtree-control") {
      const body = await options.readBody(request) as { requestId?: unknown; action?: unknown; selected?: unknown } | undefined;
      if (typeof body?.requestId !== "string" || body.requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return true; }
      if (body.action !== "stop" && body.action !== "interrupt") { json(response, 400, { code: "invalid_request", error: "action must be stop or interrupt" }); return true; }
      if (body.selected !== undefined && (!Array.isArray(body.selected) || body.selected.some((entry) => typeof entry !== "string" || entry.trim() === ""))) {
        json(response, 400, { code: "invalid_request", error: "selected must be an array of conversation ids" }); return true;
      }
      try {
        // The caller is the host's own statement, exactly as it is for a single-conversation stop: this HTTP surface is
        // the user, and nothing in the body selects it.
        const controlled = await options.operations.subtreeControl(id, {
          requestId: body.requestId,
          action: body.action,
          stopSource: "user",
          ...(body.selected === undefined ? {} : { selected: body.selected as string[] }),
        });
        // A partial result is not a failed request: the request was accepted and every child answered, so the answer is
        // 202 with `partial`, each child's own recorded status and each child's current session row beside it.
        json(response, 202, { protocol: PROTOCOL_VERSION, conversationId: id, ...(await options.subtreeAnswer(controlled) as object) });
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        if (error instanceof SubtreeControlRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
      return true;
    }
    // The durable record of one subtree request: the captured scope, every child's committed outcome and each child's
    // current control state. A caller whose answer was lost reads back what really happened instead of re-sending the
    // intent, which is the same recovery read the single-conversation control route offers (spec D04, D05).
    if (request.method === "GET" && action === "subtree-control") {
      const requestId = url.searchParams.get("requestId");
      if (requestId === null || requestId.trim() === "") { json(response, 400, { code: "invalid_request", error: "requestId is required" }); return true; }
      try {
        const controlled = await options.operations.subtreeControlRequest(id, requestId);
        if (controlled === undefined) { json(response, 404, { protocol: PROTOCOL_VERSION, code: "unknown_request", error: "no subtree request with that id on this conversation" }); return true; }
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, ...(await options.subtreeAnswer(controlled) as object) });
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        if (error instanceof SubtreeControlRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
      return true;
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
      if (item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return true; }
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
      json(response, 200, { protocol: PROTOCOL_VERSION, ...recalled }); return true;
    }
    // The busy composer's steer and follow-up: the same admission seam as an ordinary message, with the same control
    // rule and the same content — the protocol's own text and image blocks. It is a **queue-only** input, so it never
    // resumes a held conversation — a draft the user staged while the turn was running is not their decision to
    // continue (spec D07).
    if (request.method === "POST" && action === "busy") {
      const body = await options.readBody(request, MAX_SUBMISSION_BODY_BYTES);
      const mode = typeof body === "object" && body !== null ? (body as { mode?: unknown }).mode : undefined;
      if (mode !== "follow-up" && mode !== "steer") { json(response, 400, { error: "mode must be follow-up or steer" }); return true; }
      const input = (typeof body === "object" && body !== null ? body : {}) as { text?: unknown; requestId?: unknown; images?: unknown };
      if (typeof input.requestId !== "string" || !input.requestId.trim()) { json(response, 400, { error: "requestId required" }); return true; }
      if (input.images !== undefined && !Array.isArray(input.images)) { json(response, 400, { error: "images must be an array" }); return true; }
      // A body that is not the shape this route reads is refused rather than coerced, so a caller is never answered
      // with a draft it did not write.
      if (input.text !== undefined && typeof input.text !== "string") { json(response, 400, { error: "text must be a string" }); return true; }
      const text = input.text ?? "";
      const images = (input.images ?? []) as readonly SubmitImage[];
      // A queued draft is a submission like any other, so it is validated the same way: an empty body and an attachment
      // the protocol refuses are answered before anything is admitted, rather than staged and dropped.
      const validation = validateCommand({ protocol: PROTOCOL_VERSION, type: "conversation.submit", conversationId: id, requestId: input.requestId, text, ...(images.length > 0 ? { images } : {}) } as ProtocolCommand, { conversationWorkspaceId: item.snapshot().workspaceId });
      if (!validation.ok) { json(response, 400, validation); return true; }
      const refusedImages = options.imageRefusal(item, images);
      if (refusedImages !== undefined) { json(response, 400, { ok: false, ...refusedImages }); return true; }
      if (item.deletedAt() !== undefined) { json(response, 409, { ok: false, code: "session_deleted", accepted: false, message: "This session was deleted. Start a new session to continue." }); return true; }
      try {
        const sent = await options.operations.send(id, { requestId: input.requestId, caller: "user", resume: false, content: await options.submissionContent(item, text, images), whenBusy: mode === "steer" ? "steer" : "followUp" });
        json(response, 202, { protocol: PROTOCOL_VERSION, mode, requestId: input.requestId, submissionId: sent.submissionId, control: sent.control });
      } catch (error) {
        if (!(error instanceof ConversationOperationRefusal)) throw error;
        json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) });
      }
      return true;
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
      if (method !== "GET" && item.deletedAt() !== undefined) { json(response, 409, { code: "session_deleted", error: "This session was deleted. Start a new session to continue." }); return true; }
      if (method === "GET" && submissionId === undefined) {
        const answer = await handleConversationItems(options.items, id, "list", undefined, undefined);
        json(response, answer.status, answer.body); return true;
      }
      if (method === "PATCH" && submissionId !== undefined) {
        const answer = await handleConversationItems(options.items, id, "edit", submissionId, await options.readBody(request, MAX_SUBMISSION_BODY_BYTES));
        json(response, answer.status, answer.body); return true;
      }
      if (method === "DELETE" && submissionId !== undefined) {
        const answer = await handleConversationItems(options.items, id, "cancel", submissionId, undefined);
        json(response, answer.status, answer.body); return true;
      }
      json(response, 405, { error: "method not allowed" }); return true;
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
