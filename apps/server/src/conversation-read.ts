import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { Conversation, ConversationId, Cursor, EntryId, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "@hepi/protocol";

/**
 * The raw conversation read: the bounded, resumable read of a conversation's own fork-aware history (spec D13).
 *
 * It reads the **native history**, not a window of it: `Conversation.entries()` is the runtime's fork-aware,
 * membership-checked scan over the entry table, so a compaction's head marker does not hide the entries it dropped, a
 * fork still reads the prefix it inherited, and an entry id from another conversation is not readable here. The state
 * route's active range, the stream's window and the search scan are different questions and none of them is this one.
 *
 * The presentation is the native Read's: the content is **text lines or one image**, and everything about the range —
 * where it started, which entries and blocks it covered, why it stopped and where to continue — travels in `details`
 * and `diagnostics` rather than in the body. `offset` is a 1-based **actual text line** number and `limit` the
 * maximum number of lines, both the native Read's own meanings, and the defaults are its defaults too (2000 lines or
 * 50 KiB, whichever is reached first). The first page pins the snapshot's end (`tail`) and every page states it, so an
 * entry appended while a caller pages does not move a line the caller already read. A continuation carries the entry,
 * the block, the line inside that block, the character offset inside that line and the pinned tail, and starts at that
 * entry through the native scan instead of re-walking the history from its oldest entry. The same coverage is what
 * `details.entries` states, including an entry that carries no text line at all — an image or a tool call — so a block
 * a caller never received as text is still addressable by its id and block index.
 *
 * Deliberate limits, both recorded in the ticket: a first read with a large absolute `offset` locates its start by
 * walking the history from the oldest entry — no O(1) random access, and no line index is built or persisted — and one
 * entry is decoded whole before it is split into lines, so the 50 KiB budget bounds the **output** and is not a bound
 * on the memory one entry costs.
 */

/** The presentation version of this read. A continuation carries the version that produced it and a mismatch is refused. */
export const READ_VERSION = 1;
/** Maximum lines one page carries when the caller names none: the native Read's own default. */
export const READ_MAX_LINES = 2000;
/** Byte budget of one page: the native Read's own default, and the budget a single over-long line is cut at. */
export const READ_MAX_BYTES = 50 * 1024;
/** Entries read per native scan; one page usually needs one scan, and a cursor continues the scan rather than restarting it. */
const ENTRY_PAGE = 50;

/** A refusal a caller names by code and status instead of matching on a message. */
export class ConversationReadRefusal extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ConversationReadRefusal";
    this.code = code;
    this.status = status;
  }
}

/** The role one entry's message states; `null` for an entry that contributes no message. */
export type ConversationReadRole = "user" | "assistant" | "toolResult" | "system";

/**
 * One content block of one entry, as this read addresses it. `blockIndex` is the **native** block index: an array
 * content block's own index, or `0` for a message stored as a plain string, which is the addressing the existing
 * text, thinking and image read blocks already use. `startLine`/`endLine` are stated only for a text-bearing block
 * that contributed lines to this page, so a caller can map the lines it received back to the block that produced them;
 * an image or tool-call block states its own metadata instead of a line range.
 */
export type ConversationReadBlockRef = {
  readonly blockIndex: number;
  readonly type: "text" | "thinking" | "image" | "toolCall";
  readonly startLine?: number;
  readonly endLine?: number;
  readonly mimeType?: string;
  readonly bytes?: number;
  readonly name?: string;
};

/** One entry the page covered, with the block inventory a caller needs to address a block of it. */
export type ConversationReadEntry = {
  readonly entryId: string;
  readonly kind: string;
  readonly role: ConversationReadRole | null;
  readonly blocks: readonly ConversationReadBlockRef[];
};

/**
 * Where a continuation starts. `entryId`/`blockIndex`/`blockLine`/`charOffset` name the position exactly, so the
 * next page is read from that entry through the native scan; `offset` is the absolute 1-based line number of that
 * position, carried forward so a page states its own numbering without walking the history again; `tail` is the end of
 * the snapshot the mapping belongs to; `version` is the presentation that produced it.
 */
export type ConversationReadCursor = {
  readonly version: number;
  readonly entryId: string;
  readonly blockIndex: number;
  readonly blockLine: number;
  readonly charOffset: number;
  readonly offset: number;
  readonly tail: string;
};

/** What one page read: the whole raw history, one entry of it, or one block of one entry. */
export type ConversationReadScope =
  | { readonly kind: "history" }
  | { readonly kind: "entry"; readonly entryId: string }
  | { readonly kind: "block"; readonly entryId: string; readonly blockIndex: number };

export type ConversationReadDetails = {
  readonly version: number;
  readonly scope: ConversationReadScope;
  /** The end of the snapshot this page's line numbering belongs to; `null` when the conversation holds no entry. */
  readonly tail: string | null;
  /** The 1-based line number of the first line in `output`; `0` when the output carries no line (an image). */
  readonly offset: number;
  /** The line limit in force for this page, after the default. */
  readonly limit: number;
  /** The byte budget in force for this page. */
  readonly maxBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  /** True when the snapshot holds a line this page did not return, which `next` names. */
  readonly hasMore: boolean;
  /**
   * The entries the page covered, in history order, each with its block inventory: the entries whose lines it returned
   * and the entries it passed that carry no text line. An image-only or tool-call-only message is listed with its block
   * even though it contributed no line, so a caller can address a block it never received as text.
   */
  readonly entries: readonly ConversationReadEntry[];
  /** Present exactly when `hasMore`: the position to continue from. */
  readonly next?: ConversationReadCursor;
};

export type ConversationReadDiagnostic = { readonly severity: "info" | "warn" | "error"; readonly code: string; readonly message: string };

export type ConversationReadOutput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export type ConversationReadResult = {
  readonly conversationId: string;
  readonly output: readonly ConversationReadOutput[];
  readonly details: ConversationReadDetails;
  readonly diagnostics: readonly ConversationReadDiagnostic[];
};

/**
 * One read. `offset`/`limit` are the native Read's own. `entryId` scopes the read to one entry — and `blockIndex`
 * to one block of it, which is how an image is read; an entry- or block-scoped read numbers its lines inside its own
 * scope. `tail` pins the snapshot's end. When `cursor` is present it is the position to continue from and `offset`
 * is ignored: the cursor states the absolute line itself.
 */
export type ConversationReadRequest = {
  readonly conversationId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly entryId?: string;
  readonly blockIndex?: number;
  readonly tail?: string;
  readonly cursor?: ConversationReadCursor;
};

/** The read as the shared operations object exposes it; `agent_read` (ticket 06) calls this same entry. */
export type ConversationReadOperations = { read(request: ConversationReadRequest): Promise<ConversationReadResult> };

/** Open the raw-history read over one harness. */
export function createConversationRead(harness: Harness): ConversationReadOperations {
  return { read: (request) => readConversation(harness, request) };
}

/**
 * Read one page of a conversation's raw history.
 *
 * A refusal is a `ConversationReadRefusal` carrying the code and status the HTTP route answers with, so the core and
 * the route cannot state two different reasons for the same read.
 */
export async function readConversation(harness: Harness, request: ConversationReadRequest): Promise<ConversationReadResult> {
  const conversationId = requireConversationId(request.conversationId);
  const conversation = await harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
  if (conversation === undefined) throw new ConversationReadRefusal("not_found", 404, "conversation not found");
  const limit = positiveInteger(request.limit, "limit") ?? READ_MAX_LINES;
  const offset = positiveInteger(request.offset, "offset") ?? 1;
  const cursor = request.cursor === undefined ? undefined : checkCursor(request.cursor);
  if (request.blockIndex !== undefined && request.entryId === undefined) {
    throw new ConversationReadRefusal("invalid_request", 400, "blockIndex needs the entryId it belongs to");
  }
  if (request.entryId === undefined) {
    const tail = request.tail === undefined ? undefined : requireEntryId(request.tail, "tail");
    if (cursor !== undefined && tail !== undefined && cursor.tail !== tail) {
      throw new ConversationReadRefusal("invalid_request", 400, "the cursor and tail name two different snapshots");
    }
    // A continuation carries the snapshot it belongs to, so it states its own tail instead of asking the conversation
    // for its newest entry again: the page a caller continues belongs to the snapshot the cursor was made in.
    if (cursor !== undefined && tail === undefined) return await readHistory(conversation, conversationId, { limit, offset, cursor, tail: cursor.tail });
    return await readHistory(conversation, conversationId, { limit, offset, cursor, tail });
  }
  const entryId = requireEntryId(request.entryId, "entryId");
  if (cursor !== undefined && cursor.entryId !== entryId) {
    throw new ConversationReadRefusal("invalid_request", 400, "the cursor names another entry than entryId");
  }
  const entry = await visibleEntry(conversation, entryId);
  if (entry === undefined) throw new ConversationReadRefusal("not_found", 404, "entry not found");
  if (request.blockIndex !== undefined) return await readBlock(conversationId, entry, nonNegativeInteger(request.blockIndex, "blockIndex"), { limit, offset, cursor });
  return await walk([entry], { conversationId, scope: { kind: "entry", entryId }, tail: entryId, offset, limit, cursor });
}

/** One page of the whole raw history, bounded at the snapshot's end. */
async function readHistory(conversation: Conversation, conversationId: string, options: { limit: number; offset: number; cursor?: ConversationReadCursor; tail?: string }): Promise<ConversationReadResult> {
  const newest = options.tail ?? (await conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id;
  if (newest === undefined) {
    return { conversationId, output: [], details: { version: READ_VERSION, scope: { kind: "history" }, tail: null, offset: options.offset, limit: options.limit, maxBytes: READ_MAX_BYTES, outputLines: 0, outputBytes: 0, truncated: false, truncatedBy: null, hasMore: false, entries: [] }, diagnostics: [] };
  }
  const tail = String(newest);
  // A pinned tail this conversation cannot see would bound the read with another conversation's entry id, which is the
  // membership check the entry table itself performs; a page silently bounded by it is a page the caller cannot
  // reconcile, so it is refused by the same rule every other entry read uses.
  if (options.tail !== undefined && await visibleEntry(conversation, tail) === undefined) {
    throw new ConversationReadRefusal("not_found", 404, "tail is not an entry of this conversation");
  }
  return await walk(scanHistory(conversation, options.cursor?.entryId, tail), { conversationId, scope: { kind: "history" }, tail, offset: options.offset, limit: options.limit, cursor: options.cursor });
}

/**
 * The fork-aware history of one conversation, oldest first, up to and including `tail`. The native scan is the
 * membership check and the fork walk at once: it reads the conversation's own entries and its ancestors' up to each fork
 * point, and it continues from a cursor by id rather than from the start of the history.
 */
async function* scanHistory(conversation: Conversation, from: string | undefined, tail: string): AsyncGenerator<EntryRecord> {
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ ...(from === undefined ? {} : { minEntryId: Number(from) as EntryId }), maxEntryId: Number(tail) as EntryId, order: "ascending" }, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) yield entry;
    cursor = page.next;
  } while (cursor !== undefined);
}

/**
 * One entry as this conversation's own history holds it, or `undefined` when it is not visible here. The runtime's
 * global `tx.entry()` is a lookup by id alone and entry ids are inherited, so the read resolves through the
 * conversation's fork-aware range — an id from another conversation is not readable, while an ancestor entry a fork
 * inherited still is. The range is exactly one id, so it costs one lookup and scans no transcript.
 *
 * Exported because the navigation reads ask the same question of the same record: one fence decides what one
 * conversation can see, and a second spelling of it would be a second rule for visibility.
 */
export async function visibleEntry(conversation: Conversation, id: string): Promise<EntryRecord | undefined> {
  const page = await conversation.entries({ minEntryId: Number(id) as EntryId, maxEntryId: Number(id) as EntryId }, 1, undefined, BACKGROUND_CONTEXT);
  return page.items[0];
}

/** The lines one entry contributes, and the block each of them came from. */
type BlockChunk = { readonly blockIndex: number; readonly type: "text" | "thinking"; readonly text: string };

/** The role one entry's message states, or `null` when the entry contributes no message. */
function roleOf(entry: EntryRecord): ConversationReadRole | null {
  const role = entry.model?.[0]?.role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system" ? role : null;
}

/**
 * Every block of one entry, in native order: the text-bearing ones as lines to hand out, and all of them as the block
 * inventory a caller addresses a block by. Text and thinking blocks are the text this read serves; an image is served by
 * its own block read and a tool call carries no text at all — both are still listed, because a caller that could not see
 * them could not ask for the image or tell the transcript's shape.
 */
function entryBlocks(entry: EntryRecord): { chunks: readonly BlockChunk[]; blocks: readonly ConversationReadBlockRef[] } {
  const content = entry.model?.[0]?.content;
  if (typeof content === "string") return { chunks: [{ blockIndex: 0, type: "text", text: content }], blocks: [{ blockIndex: 0, type: "text" }] };
  if (!Array.isArray(content)) return { chunks: [], blocks: [] };
  const chunks: BlockChunk[] = [];
  const blocks: ConversationReadBlockRef[] = [];
  content.forEach((block, blockIndex) => {
    if (block.type === "text") { chunks.push({ blockIndex, type: "text", text: block.text }); blocks.push({ blockIndex, type: "text" }); }
    else if (block.type === "thinking") { chunks.push({ blockIndex, type: "thinking", text: block.thinking }); blocks.push({ blockIndex, type: "thinking" }); }
    else if (block.type === "image") blocks.push({ blockIndex, type: "image", mimeType: block.mimeType, bytes: Buffer.from(block.data, "base64").byteLength });
    else if (block.type === "toolCall") blocks.push({ blockIndex, type: "toolCall", name: block.name });
  });
  return { chunks, blocks };
}

/** The lines of one block: its text split on newlines, a trailing newline contributing no final empty line. */
function blockLines(text: string): readonly string[] {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * One block read: its text lines, or the image itself. The block index addresses the **native** content, so a text-only
 * prompt stored as a plain string answers index 0 with the whole string. A block index outside the content is refused as
 * a bad request and a block that carries no text is refused as not found — the same pair of answers the existing text,
 * thinking and image read blocks give. The block's own lines are the scope, so `offset` numbers them inside the block
 * and a cursor continues a block that did not fit one page.
 *
 * An image is subject to the one wire policy the deferred history blocks already use, so a caller is never handed an
 * image the rest of the system would refuse to serve.
 */
async function readBlock(conversationId: string, entry: EntryRecord, blockIndex: number, options: { limit: number; offset: number; cursor?: ConversationReadCursor }): Promise<ConversationReadResult> {
  const entryId = String(entry.id);
  const content = entry.model?.[0]?.content;
  const scope: ConversationReadScope = { kind: "block", entryId, blockIndex };
  if (content === undefined) throw new ConversationReadRefusal("not_found", 404, "this entry carries no message content");
  if (typeof content === "string" && blockIndex !== 0) throw new ConversationReadRefusal("invalid_request", 400, "blockIndex is outside this entry's content");
  const block = typeof content === "string" ? { type: "text" as const, text: content } : Array.isArray(content) ? content[blockIndex] : undefined;
  if (block === undefined) throw new ConversationReadRefusal("invalid_request", 400, "blockIndex is outside this entry's content");
  if (block.type === "image") {
    const bytes = Buffer.from(block.data, "base64").byteLength;
    if (!TOOL_RESULT_IMAGE_MIMES.has(block.mimeType) || bytes > MAX_TOOL_RESULT_IMAGE_BYTES) {
      throw new ConversationReadRefusal("image_not_served", 415, "this image is outside the image policy");
    }
    return {
      conversationId,
      output: [{ type: "image", data: block.data, mimeType: block.mimeType }],
      details: { version: READ_VERSION, scope, tail: entryId, offset: 0, limit: options.limit, maxBytes: READ_MAX_BYTES, outputLines: 0, outputBytes: bytes, truncated: false, truncatedBy: null, hasMore: false, entries: [{ entryId, kind: entry.kind, role: roleOf(entry), blocks: entryBlocks(entry).blocks }] },
      diagnostics: [{ severity: "info", code: "image", message: "Read image block " + blockIndex + " of entry " + entryId + " (" + block.mimeType + ", " + bytes + " bytes)." }],
    };
  }
  if (block.type !== "text" && block.type !== "thinking") throw new ConversationReadRefusal("not_found", 404, "this block is not text");
  // A block read is the same walk over one block: its lines are numbered inside its own scope, and it continues from a
  // cursor the same way a history page does — a block larger than the byte budget is cut into pieces, not re-read from
  // its first line on every page.
  return await walk([entry], { conversationId, scope, tail: entryId, offset: options.offset, limit: options.limit, blockIndex, cursor: options.cursor });
}

/** A mutable block reference while a page is being assembled. */
type MutableBlockRef = { -readonly [Key in keyof ConversationReadBlockRef]: ConversationReadBlockRef[Key] };

/** One entry a page covered, with its block inventory being annotated as lines are returned. */
type Spanned = { readonly entryId: string; readonly kind: string; readonly role: ConversationReadRole | null; readonly blocks: MutableBlockRef[] };

/** One page being assembled. */
type WalkState = {
  readonly output: string[];
  outputBytes: number;
  readonly spanned: Map<string, Spanned>;
  truncatedBy: "lines" | "bytes" | null;
  next?: ConversationReadCursor;
  firstLine: number;
  /** The last absolute line number the walk visited; it is the snapshot's line count when the walk reached its end. */
  visited: number;
};

type WalkOptions = { conversationId: string; scope: ConversationReadScope; tail: string; offset: number; limit: number; cursor?: ConversationReadCursor; blockIndex?: number };

/** The page's own record of one entry it covered, added the first time the entry is reached. */
function spannedFor(state: WalkState, entry: EntryRecord, blocks: readonly ConversationReadBlockRef[]): Spanned {
  const existing = state.spanned.get(String(entry.id));
  if (existing !== undefined) return existing;
  const spanned: Spanned = { entryId: String(entry.id), kind: entry.kind, role: roleOf(entry), blocks: blocks.map((block) => ({ ...block })) };
  state.spanned.set(spanned.entryId, spanned);
  return spanned;
}

/**
 * Note one returned line in the page's own record of what it covered: the entry joins the list the first time one of its
 * lines is returned, and the text-bearing block that produced the line states the range it covers — first line first,
 * last line updated as the page grows, so a block cut in half states the half that was returned.
 */
function markSpanned(state: WalkState, entry: EntryRecord, blocks: readonly ConversationReadBlockRef[], blockIndex: number, line: number): void {
  const ref = spannedFor(state, entry, blocks).blocks.find((candidate) => candidate.blockIndex === blockIndex);
  if (ref === undefined) return;
  if (ref.startLine === undefined) ref.startLine = line;
  ref.endLine = line;
}

/** The continuation one page that stopped early hands back. */
function cursorAt(entryId: string, blockIndex: number, blockLine: number, charOffset: number, offset: number, tail: string): ConversationReadCursor {
  return { version: READ_VERSION, entryId, blockIndex, blockLine, charOffset, offset, tail };
}

/** The result one finished page states, from its own accumulated state. */
function result(state: WalkState, options: WalkOptions): ConversationReadResult {
  const text = state.output.join("\n");
  const next = state.next;
  const diagnostics: ConversationReadDiagnostic[] = [];
  if (next !== undefined) {
    if (state.truncatedBy === "lines") {
      diagnostics.push({ severity: "info", code: "truncated", message: "Showing " + state.output.length + " line(s) from line " + state.firstLine + ". More lines remain in this snapshot; continue with the returned cursor (entry " + next.entryId + ", block " + next.blockIndex + ", block line " + next.blockLine + ", char " + next.charOffset + ", offset " + next.offset + ")." });
    } else if (next.charOffset > 0) {
      const piece = next.charOffset - (state.output.at(-1)?.length ?? 0);
      diagnostics.push({ severity: "warn", code: "truncated", message: "The line at entry " + next.entryId + " block " + next.blockIndex + " line " + next.blockLine + " is longer than the " + READ_MAX_BYTES + "-byte budget; this page carries its characters from char " + piece + " to char " + next.charOffset + ". Continue with the returned cursor: the next page returns the rest of that same line." });
    } else {
      diagnostics.push({ severity: "info", code: "truncated", message: "The " + READ_MAX_BYTES + "-byte budget was reached before the line at entry " + next.entryId + " block " + next.blockIndex + " line " + next.blockLine + "; continue with the returned cursor (offset " + next.offset + ")." });
    }
  } else if (state.output.length === 0 && options.cursor === undefined && options.offset > 1 && state.visited > 0) {
    diagnostics.push({ severity: "info", code: "end_of_history", message: "Offset " + options.offset + " is beyond the end of this snapshot, which holds " + state.visited + " line(s)." });
  }
  return {
    conversationId: options.conversationId,
    output: text === "" ? [] : [{ type: "text", text }],
    details: {
      version: READ_VERSION,
      scope: options.scope,
      tail: options.tail,
      offset: state.firstLine,
      limit: options.limit,
      maxBytes: READ_MAX_BYTES,
      outputLines: state.output.length,
      outputBytes: state.outputBytes,
      truncated: next !== undefined,
      truncatedBy: state.truncatedBy,
      hasMore: next !== undefined,
      entries: [...state.spanned.values()].map((spanned) => ({ entryId: spanned.entryId, kind: spanned.kind, role: spanned.role, blocks: spanned.blocks })),
      ...(next === undefined ? {} : { next }),
    },
    diagnostics,
  };
}

/**
 * One page over the entries of a snapshot — the whole read.
 *
 * The walk skips to the start position and then hands out whole lines until the line limit or the byte budget is
 * reached, never a partial line, with one exception the native Read also has: a **first** line larger than the whole
 * byte budget is returned as a UTF-8-safe prefix of itself, with a cursor that continues inside that same line. The line
 * that does not fit is never consumed, so the cursor always names a position the walk has already reached and a
 * continuation never needs to know what comes next.
 *
 * Without a cursor the start position is the absolute `offset`th line of the snapshot, found by counting lines from the
 * oldest entry — the read the ticket bounds rather than indexes. With a cursor it is the named entry, block and block
 * line, which is what lets a continuation start at that entry instead of re-walking the history.
 */
async function walk(source: Iterable<EntryRecord> | AsyncIterable<EntryRecord>, options: WalkOptions): Promise<ConversationReadResult> {
  const cursor = options.cursor;
  const state: WalkState = { output: [], outputBytes: 0, spanned: new Map(), truncatedBy: null, firstLine: 0, visited: 0 };
  const only = options.blockIndex;
  let lineNo = 1;
  let started = cursor === undefined;
  let charOffset = cursor?.charOffset ?? 0;
  let stopped = false;
  outer: for await (const entry of source) {
    const { chunks, blocks } = entryBlocks(entry);
    // The page's inventory is what it covered, not only what it printed. An entry the walk has passed inside the
    // page's own range that carries **no** text line joins the list with its blocks, because an image-only or
    // tool-call-only message is exactly the entry a caller has to address by id and block index without having been
    // told either from outside; an entry whose lines were returned joins it as those lines are handed out. Entries
    // before the start position are skipped here as their lines are, and the walk stops at the same boundary either
    // way, so the inventory stays as bounded as the page.
    if (started && chunks.length === 0 && blocks.length > 0 && (cursor !== undefined || lineNo >= options.offset)) spannedFor(state, entry, blocks);
    for (const chunk of chunks) {
      if (only !== undefined && chunk.blockIndex !== only) continue;
      const lines = blockLines(chunk.text);
      for (let blockLine = 0; blockLine < lines.length; blockLine += 1) {
        // The start position: a cursor names its own line, and an absolute offset skips whole lines from the snapshot's
        // oldest entry. Either way the page's first returned line is the line this ends at.
        if (!started) {
          if (String(entry.id) !== cursor!.entryId || chunk.blockIndex !== cursor!.blockIndex || blockLine !== cursor!.blockLine) { lineNo += 1; continue; }
          started = true;
          lineNo = cursor!.offset;
        } else if (cursor === undefined && lineNo < options.offset) { lineNo += 1; continue; }
        const raw = lines[blockLine]!;
        // Where this page's piece of the line starts: a continuation states it, and the cursor it hands back adds to it
        // rather than replacing it, so the pieces of one over-long line advance instead of repeating.
        const from = charOffset;
        if (from > raw.length) throw new ConversationReadRefusal("stale_cursor", 409, "the cursor names a character position outside its line");
        const line = from > 0 ? raw.slice(from) : raw;
        charOffset = 0;
        const lineBytes = utf8ByteLength(line);
        // A line that does not fit ends the page before it is consumed, so the cursor names this very line.
        if (state.output.length > 0) {
          if (state.output.length >= options.limit) { state.truncatedBy = "lines"; state.next = cursorAt(String(entry.id), chunk.blockIndex, blockLine, 0, lineNo, options.tail); stopped = true; break outer; }
          if (state.outputBytes + 1 + lineBytes > READ_MAX_BYTES) { state.truncatedBy = "bytes"; state.next = cursorAt(String(entry.id), chunk.blockIndex, blockLine, 0, lineNo, options.tail); stopped = true; break outer; }
        } else if (lineBytes > READ_MAX_BYTES) {
          const piece = cutAtByteBudget(line, READ_MAX_BYTES);
          state.firstLine = lineNo;
          state.output.push(piece);
          state.outputBytes = utf8ByteLength(piece);
          markSpanned(state, entry, blocks, chunk.blockIndex, lineNo);
          state.truncatedBy = "bytes";
          state.next = cursorAt(String(entry.id), chunk.blockIndex, blockLine, from + piece.length, lineNo, options.tail);
          stopped = true;
          break outer;
        }
        if (state.firstLine === 0) state.firstLine = lineNo;
        state.outputBytes += (state.output.length > 0 ? 1 : 0) + lineBytes;
        state.output.push(line);
        markSpanned(state, entry, blocks, chunk.blockIndex, lineNo);
        lineNo += 1;
      }
    }
  }
  if (!started) throw new ConversationReadRefusal("stale_cursor", 409, "the cursor does not name a line this read can reach");
  if (!stopped) state.visited = lineNo - 1;
  return result(state, options);
}

/**
 * The largest prefix of `text` whose UTF-8 length is at most `maxBytes`, cut at a code-point boundary. It walks code
 * points rather than re-encoding prefixes, so it is one pass and it never splits a surrogate pair or emits a replacement
 * character.
 */
export function cutAtByteBudget(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    const pair = code >= 0xd800 && code <= 0xdbff && end + 1 < text.length && text.charCodeAt(end + 1) >= 0xdc00 && text.charCodeAt(end + 1) <= 0xdfff;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += pair ? 2 : 1;
  }
  return text.slice(0, end);
}

function requireConversationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new ConversationReadRefusal("not_found", 404, "conversation not found");
  return value;
}

function requireEntryId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new ConversationReadRefusal("invalid_request", 400, name + " must be an entry id");
  return value;
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ConversationReadRefusal("invalid_request", 400, name + " must be a positive integer");
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new ConversationReadRefusal("invalid_request", 400, name + " must be a non-negative integer");
  return value;
}

/** A cursor is checked as a whole: a partially stated position would be read as a different one. */
function checkCursor(value: ConversationReadCursor): ConversationReadCursor {
  if (value.version !== READ_VERSION) {
    throw new ConversationReadRefusal("version_mismatch", 409, "this cursor was produced by read version " + String(value.version) + "; the current version is " + READ_VERSION);
  }
  return {
    version: READ_VERSION,
    entryId: requireEntryId(value.entryId, "cursor entryId"),
    blockIndex: nonNegativeInteger(value.blockIndex, "cursor blockIndex"),
    blockLine: nonNegativeInteger(value.blockLine, "cursor blockLine"),
    charOffset: nonNegativeInteger(value.charOffset, "cursor charOffset"),
    offset: positiveInteger(value.offset, "cursor offset")!,
    tail: requireEntryId(value.tail, "cursor tail"),
  };
}
