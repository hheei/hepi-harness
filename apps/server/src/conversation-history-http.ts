import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { HEARTBEAT_FRAME, MAX_TOOL_RESULT_IMAGE_BYTES, PROTOCOL_VERSION, TOOL_RESULT_IMAGE_MIMES } from "@hepi/protocol";
import { pageEntries, projectEntry, send, type ConversationRuntime } from "./conversation-attachments.ts";
import { handleConversationNavigation, handleConversationNavigationTarget } from "./conversation-navigation.ts";
import type { ConversationReadOperations } from "./conversation-read.ts";
import { handleConversationRead } from "./conversation-read-route.ts";
import { oversizeFrame, scopeFromFacts, tokenFromFacts, VISIBLE_WINDOW } from "./history-window.ts";
import { base64ByteLength, parseReadBlockQuery, readBlockImageAnswer, readBlockTextPage } from "./read-block.ts";

/**
 * The conversation's own read and stream routes: what one conversation's committed history and active window answer.
 *
 * These are the reads a client makes before it can act — the bounded window and its event stream, older pages, the raw
 * fork-aware history, the navigation outline and its target window, one entry, and the three read blocks a deferred
 * preview names. None of them changes durable state, so this module owns no operation of its own: every answer is a
 * projection of the conversation's attachment, of the one raw-history read `agent_read` also calls, or of the
 * navigation seam's own bounded page.
 *
 * The routes are the backend's own; the Web adapter's `/api/sessions/:id/...` mapping happens above this process.
 * A conversation the attachment map does not hold is answered here, with the one refusal every conversation-scoped
 * route states, because resolving that identity is this module's first fact. Everything else it does not recognise is
 * left to the caller (`false`), which is what keeps the command, settings and project routes their own owners.
 */

export type ConversationHistoryHttpOptions = {
  /** The conversation one path segment names, from the attachment map this backend owns. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
  /** The one raw-history read `agent_read` also calls, so an HTTP caller and a model tool read the same history. */
  readonly read: ConversationReadOperations;
  /** The keepalive cadence an attached stream writes at; the deployment states it, the protocol states the default. */
  readonly heartbeatIntervalMs: number;
};

export function createConversationHistoryHttp(options: ConversationHistoryHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
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
    // The bounded raw history of one conversation. What the stream and `state` carry is the **active window**; this is
    // the entry table's own fork-aware record, so a compaction's dropped prefix and a fork's inherited prefix are both
    // readable here. The body is text lines or one image, everything else is stated in `details` and `diagnostics`,
    // and `cursor` continues a page exactly where it stopped. Query: `offset`, `limit`, `entryId`, `blockIndex`,
    // `tail`, `cursor`. The one read every caller shares: `agent_read` calls the same operation.
    if (request.method === "GET" && action === "read" && parts.length === 4) {
      const answer = await handleConversationRead(options.read, id, url.searchParams);
      json(response, answer.status, answer.body); return true;
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
      json(response, answer.status, answer.body); return true;
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
      json(response, answer.status, answer.body); return true;
    }
    // The window's own statement, on the read a client makes before it has a stream: the same bounded entries the
    // stream's first frame carries, with the facts that say what the window is.
    if (request.method === "GET" && action === "state") {
      const current = item.snapshot();
      const oversize = oversizeFrame(current, current.entries.at(-1)?.id ?? null);
      // A read that cannot be carried answers a named reason and the entry that caused it. The entry stays readable
      // through its own route, so the caller is told the first load could not be bounded rather than being handed a
      // transcript that claims to be complete. No unbounded mode is added here: a consumer that needs everything pages.
      if (oversize !== undefined) { json(response, 413, { protocol: PROTOCOL_VERSION, conversationId: id, revision: current.revision, reason: "frame_too_large", ...oversize }); return true; }
      json(response, 200, current); return true;
    }
    // Older history, by entry id. `before` is **exclusive** and is the oldest id the client already holds — the
    // meaning the copied app's own paging gives it — so prepending a page never duplicates the boundary entry. The
    // page is bounded below by the newest head marker at or before it, so it can never hand back entries the active
    // context has left behind, and it applies the same count rule, the same byte budget and the same projection
    // expression as the stream, so a paged entry and a streamed entry cannot differ.
    if (request.method === "GET" && action === "entries" && parts.length === 4) {
      const before = url.searchParams.get("before");
      if (before !== null && !/^[0-9]+$/.test(before)) { json(response, 400, { code: "invalid_request", error: "before must be an entry id" }); return true; }
      const requested = Number(url.searchParams.get("tail") ?? String(VISIBLE_WINDOW));
      if (!Number.isInteger(requested) || requested <= 0) { json(response, 400, { code: "invalid_request", error: "tail must be a positive integer" }); return true; }
      const page = pageEntries(item, before === null ? undefined : Number(before) as EntryId, Math.min(requested, 1000));
      // The page answers the same question the window does about its own size, and for the same reason: a page that
      // cannot be carried must say so by name rather than hand back a body the transport would have refused. The
      // entry it names is the one the budget could not shrink away, and its own read block still serves it whole.
      const oversize = oversizeFrame(page, page.entries.at(-1)?.id ?? null);
      if (oversize !== undefined) { json(response, 413, { protocol: PROTOCOL_VERSION, conversationId: id, reason: "frame_too_large", ...oversize }); return true; }
      json(response, 200, page); return true;
    }
    // One entry, projected and redacted exactly as the stream projects it. It is the read block a deferred history
    // entry names: the full entry stays reachable by id even when the frame that would have carried it could not be.
    if (request.method === "GET" && action === "entries" && parts.length === 5) {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const projected = entry === undefined ? undefined : projectEntry(entry, id);
      if (projected === undefined) { json(response, 404, { code: "not_found", error: "entry not found" }); return true; }
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entry: projected }); return true;
    }
    // The thinking read block: the full text of one block of one entry, which is what a deferred preview replaced.
    // The provider's opaque signature stays native — nothing renders it and nothing sends it back from a projected
    // entry — so this route restores the thinking a user can read and nothing else.
    if (request.method === "GET" && action === "entries" && parts.length === 6 && parts[5] === "thinking") {
      const entry = await visibleEntry(item, Number(parts[4]) as EntryId);
      const content = entry?.model?.[0]?.content;
      if (!Array.isArray(content)) { json(response, 404, { code: "not_found", error: "entry not found" }); return true; }
      const blockIndex = Number(url.searchParams.get("blockIndex") ?? "0");
      const block = Number.isInteger(blockIndex) ? content[blockIndex] : undefined;
      if (block === undefined) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return true; }
      // One bounded page, in the same shape the text block answers: a thinking block can be long, and restoring it must
      // not mean handing over an unbounded body. `thinking` is the field this family's own name, and the page facts
      // ride beside it, so a caller follows `nextOffset` exactly as it would for a text.
      const bounds = parseReadBlockQuery(url.searchParams);
      if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return true; }
      const page = readBlockTextPage(block.type === "thinking" ? block.thinking : "", bounds.offset, bounds.limit);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, thinking: page.text, offset: page.offset, totalBytes: page.totalBytes, truncated: page.truncated, ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }) }); return true;
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
      if (content === undefined) { json(response, 404, { code: "not_found", error: "entry not found" }); return true; }
      const blockIndex = Number(url.searchParams.get("blockIndex") ?? "0");
      if (!Number.isInteger(blockIndex) || blockIndex < 0) { json(response, 400, { code: "invalid_request", error: "blockIndex must be a non-negative integer" }); return true; }
      if (typeof content === "string") {
        if (blockIndex !== 0) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return true; }
        const bounds = parseReadBlockQuery(url.searchParams);
        if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return true; }
        const page = readBlockTextPage(content, bounds.offset, bounds.limit);
        json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, ...page }); return true;
      }
      const block = Array.isArray(content) && blockIndex < content.length ? content[blockIndex] : undefined;
      if (block === undefined) { json(response, 400, { code: "invalid_request", error: "blockIndex is outside this entry's content" }); return true; }
      if ((block as { type?: unknown }).type !== "text") { json(response, 404, { code: "not_found", error: "this block is not text" }); return true; }
      const bounds = parseReadBlockQuery(url.searchParams);
      if (!bounds.ok) { json(response, 400, { code: "invalid_request", error: bounds.error }); return true; }
      const page = readBlockTextPage(String((block as { text?: unknown }).text ?? ""), bounds.offset, bounds.limit);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, entryId: String(parts[4]), blockIndex, ...page }); return true;
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
      if (image === undefined) { json(response, 404, { code: "not_found", error: "image not found" }); return true; }
      if (!TOOL_RESULT_IMAGE_MIMES.has(image.mimeType) || image.bytes > MAX_TOOL_RESULT_IMAGE_BYTES) { json(response, 415, { code: "image_not_served", error: "this image is outside the tool-result image policy" }); return true; }
      // A bounded answer: a caller that only needs a window of the image asks for a byte range and gets those bytes,
      // decoded from the groups the range touches rather than from a copy of the whole image. The refusal for a range
      // outside the block is a 416, so a client learns to ask differently instead of receiving an empty body it would
      // render as a broken image.
      const answer = readBlockImageAnswer(image, request.headers.range);
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body); return true;
    }
    // The conversation's event source. The first frame is the same bounded object `state` answers, and the connection
    // then stays attached: this module owns the attachment lifetime as much as the attachment map does, so the keepalive
    // is armed with the client and disarmed with it, and a disconnected stream leaves nothing running behind it.
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
      const stopKeepalive = startKeepalive(response, options.heartbeatIntervalMs);
      item.clients.add(response);
      request.on("close", () => { stopKeepalive(); item.clients.delete(response); });
      return true;
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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
 * The keepalive one attached event-stream client receives, and the timer that writes it.
 *
 * A conversation publishes nothing while it is quiet, and every hop between this process and the browser bounds how
 * long a body may stay silent, so the attached stream states it is alive on its own cadence instead of relying on a
 * commit to say so.
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
