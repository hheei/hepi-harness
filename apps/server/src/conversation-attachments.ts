import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, type ConversationView, type EntryId, type EntryRecord, type Harness, type LiveState, type AgentState, type InboxState, type ToolSlot, type Cursor, defineDoc, watchEvents } from "@earendil-works/pi-durable";
import { projectSubmission, textUrl, toolResultImageUrl, PROTOCOL_VERSION, type ServerDelta as ServerDeltaOf, type ServerFailure as ServerFailureOf, type ServerEntry as ServerEntryOf, type ServerFrame as ServerFrameOf, type ServerSnapshot as ServerSnapshotOf, type ConversationRelations, type ResolvedReference, type SubmissionProjection } from "@hepi/protocol";
import { TombstoneDoc } from "./session-tombstone.ts";
import { readConversationRelations, RelationsDoc, resolveConversationReferences, WorkspaceDoc } from "./conversation-operations.ts";
import type { ResourceSummary } from "./workspace-resources.ts";
import { reportedSelection, type InstalledExtension, type StoredAgentExtensions } from "./extension-selection.ts";
import { advanceCatalogueStats, advanceHistoryFacts, appendedEntries, catalogueStats, continuationIndex, deferHistoryMessage, historyFacts, oversizeFrame, tokenFromFacts, WindowProjector, type CatalogueStats, type HeldWindow, type HistoryFacts, type ProjectedWindow, type WindowItem } from "./history-window.ts";
import { projectQueuedItems } from "./conversation-items.ts";
import { safeEntry, safeFailure } from "./public-errors.ts";

type Client = ServerResponse;
/**
 * The raw projection frames, consumed from `@hepi/protocol` where they are declared once for every production
 * consumer, with the two payloads this backend fills in: a committed entry carries the runtime's own `Message` and a
 * live message is that same record. Everything else — the window's bookkeeping, the attachment's identity, the
 * outstanding submissions and the resource summary — is the shared declaration, so a wire change is one edit.
 */
export type ServerEntry = ServerEntryOf<Message>;
export type ServerDelta = ServerDeltaOf<Message, ToolSlot>;
export type ServerFrame = ServerFrameOf<Message, ToolSlot>;
/**
 * One complete state of a conversation, as both transports publish it. `projectionId` names this attachment instance
 * and `revision` counts the states this instance published, so the pair is what a client compares when two reads could
 * have come from different backends: two identities are two clocks, and an opaque token is what makes that detectable
 * instead of guessed from a counter that restarted at zero. `run` states the native run's inputs, or null when there
 * is no run — an empty input list is a run with no inputs and is never read as its absence.
 */
export type ServerSnapshot = ServerSnapshotOf<Message, ToolSlot>;
export type ServerFailure = ServerFailureOf;

/**
 * A conversation's hepi-owned title. The runtime's conversation record carries no title and cannot be filtered on
 * one, so the name a user sets is conversation-scoped hepi state written through the same durable document path as
 * every other hepi document — no framework change, and no second store (spec decisions 8 and 17). A fork copies the
 * title it had, like any other conversation document.
 */
export const TitleDoc = defineDoc<{ title?: string }>({ kind: "hepi.title", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}) });

export type ConversationRuntime = {
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
 * One raw active entry as every surface publishes it. This is the **one** projection expression: the baseline, an
 * older page, a delta append and a single-entry read all come through here, so `safeEntry` runs once per entry and no
 * surface can forget the redaction, and the deferred shape of heavy history content cannot drift between them.
 *
 * Deferral is applied to **history** only and is lossless: a thinking block becomes a preview with the provider's
 * opaque `thinkingSignature` dropped, and a tool-result image inside the wire policy becomes the URL of the read
 * block that serves it. Both are restored by a read block, which is why the server may emit the URL at all. The live
 * partial never comes through here: a streaming message stays exact.
 */
export function projectEntry(entry: EntryRecord, conversationId: string): ServerEntry | undefined {
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

/** One page of older history, as the read that answers it states it. */
export type ServerPage = { protocol: typeof PROTOCOL_VERSION; conversationId: string; entries: ServerEntry[]; oldestEntryId: string | null; hasMore: boolean };

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
export function pageEntries(item: ConversationRuntime, before: EntryId | undefined, tail: number): ServerPage {
  const entries = item.view().entries;
  const end = before === undefined ? entries.length : entries.findIndex(entry => String(entry.id) === String(before));
  const upto = end < 0 ? 0 : end;
  const page = new WindowProjector(projectedItem(String(item.conversation.id)), tail).advance(entries.slice(0, upto));
  return { protocol: PROTOCOL_VERSION, conversationId: String(item.conversation.id), entries: page.items.map(item => item.entry), oldestEntryId: page.oldestEntryId, hasMore: page.hasMore };
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

export function send(response: ServerResponse, event: string, data: unknown): boolean {
  if (response.writableEnded || response.destroyed) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  response.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
  return true;
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

/** Live views borrow Harness; durable creation remains in conversation operations. */
export function createConversationAttachments(options: {
  readonly harness: Harness;
  readonly rootId: ConversationId;
  readonly installed: () => readonly InstalledExtension[];
  readonly prepare: (conversationId: string) => Promise<void>;
  readonly resources?: (conversationId: ConversationId) => Promise<ResourceSummary | undefined>;
}) {
  const { harness } = options;
  const attached = new Map<string, ConversationRuntime>();
  const pending = new Map<string, Promise<ConversationRuntime>>();
  let closed = false;
  let stopCommits: (() => void) | undefined;
  let draining: Promise<void> | undefined;
  const queue = new Set<string>();
  const get = (id: string) => attached.get(id);
  const attach = (conversation: Conversation, ancestry: Ancestry = {}): Promise<ConversationRuntime> => {
    const id = String(conversation.id);
    if (closed) return Promise.reject(new Error("conversation attachments are closed"));
    const existing = attached.get(id);
    if (existing !== undefined) return Promise.resolve(existing);
    const active = pending.get(id);
    if (active !== undefined) return active;
    const opening = (async () => {
      const workspaceId = await conversation.commit(async tx => (await tx.doc(WorkspaceDoc, conversation.id)).workspaceId, BACKGROUND_CONTEXT);
      await options.prepare(id);
      const item = await attachConversation(conversation, harness, options.installed, workspaceId,
        options.resources === undefined ? undefined : () => options.resources!(conversation.id),
        () => readRunFailure(harness, conversation.id), () => readPendingSubmissions(harness, conversation.id), ancestry);
      if (closed) { await item.close(); throw new Error("conversation attachments are closed"); }
      attached.set(id, item);
      return item;
    })();
    pending.set(id, opening);
    void opening.finally(() => pending.delete(id)).catch(() => {});
    return opening;
  };
  const attachRecord = async (id: ConversationId): Promise<void> => {
    if (closed || String(id) === String(options.rootId) || get(String(id)) !== undefined) return;
    const record = await harness.commit(tx => tx.conversation(id), BACKGROUND_CONTEXT);
    if (record === undefined || closed) return;
    const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (conversation === undefined || closed) return;
    await attach(conversation, {
      forkSource: record.parent === undefined ? undefined : String(record.parent.conversationId),
      subagentParent: record.owner === undefined ? undefined : String(record.owner.conversationId),
    });
  };
  const drain = (): void => {
    if (draining !== undefined || closed) return;
    draining = (async () => {
      while (queue.size > 0 && !closed) {
        const id = queue.values().next().value!;
        queue.delete(id);
        await attachRecord(Number(id) as ConversationId);
      }
    })();
    void draining.catch(() => {}).finally(() => {
      draining = undefined;
      if (queue.size > 0) drain();
    });
  };
  return {
    get,
    values: () => attached.values(),
    attach,
    async recover(): Promise<void> {
      let cursor: Cursor | undefined;
      do {
        const page = await harness.commit(tx => tx.scanConversations({}, 100, cursor), BACKGROUND_CONTEXT);
        for (const record of page.items) await attachRecord(record.id);
        cursor = page.next;
      } while (cursor !== undefined);
      stopCommits = harness.subscribeCommits(publication => {
        for (const change of publication.changes) {
          if (change.type !== "conversation" || String(change.value.id) === String(options.rootId)) continue;
          const id = String(change.value.id);
          if (get(id) === undefined) queue.add(id);
        }
        if (queue.size > 0) drain();
      });
    },
    async close(): Promise<void> {
      closed = true;
      stopCommits?.();
      queue.clear();
      await Promise.allSettled([...(draining === undefined ? [] : [draining]), ...pending.values()]);
      await Promise.all([...attached.values()].map(item => item.close()));
      attached.clear();
    },
  };
}
