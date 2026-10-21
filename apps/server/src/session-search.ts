import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, UserEntry, type Conversation, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";

/**
 * Bounded full-body search over the durable conversations, with no index.
 *
 * The matcher, the bounds and the response shape are upstream pi-web's
 * (`packages/gateway/vendor/pi-web/session-search.ts`, the pinned upstream bytes that used to sit under the retired
 * `apps/web/vendor/pi-web/lib/`): a literal, case-insensitive search over the
 * user and assistant text of each conversation, at most one result per conversation, a snippet around the match, and
 * `{ results, truncated }`. Only the reading half differs, because a durable conversation is not a JSONL file to
 * stream: entries are read through the runtime's public paginated `Conversation.entries()`, so an entry appended
 * after a previous search is found by the next search with nothing to rebuild and no index to keep current.
 *
 * The scan is sequential, and the runtime is why: entry reads are serialized on the session line
 * (`Harness.readOnLine`), so concurrent workers would only queue behind one another while adding a second ordering to
 * explain. Every bound upstream applies is applied here — conversations examined, results, wall-clock budget, text
 * examined per conversation, one entry's text, and the query's length.
 */

/**
 * The upstream bounds, in this backend's terms. One JSONL file upstream is one conversation here, and upstream's byte
 * and line caps bound the entry text this backend reads instead. The test asserts these numbers against the vendored
 * upstream file, so the two cannot drift apart unnoticed.
 */
export type SearchLimits = {
  /** Upstream `MAX_FILES`. */
  maxConversations: number;
  /** Upstream `MAX_RESULTS`. */
  maxResults: number;
  /** Upstream `TIME_BUDGET_MS`: the wall-clock budget of one search. */
  timeBudgetMs: number;
  /** Upstream `MAX_FILE_BYTES`: text examined per conversation. */
  maxConversationBytes: number;
  /** Upstream `MAX_LINE_CHARS`: one entry's text. */
  maxEntryChars: number;
  /** The query length upstream refuses rather than answering empty. */
  maxQueryChars: number;
};

export const SEARCH_LIMITS: SearchLimits = {
  maxConversations: 500,
  maxResults: 30,
  timeBudgetMs: 3000,
  maxConversationBytes: 16 * 1024 * 1024,
  maxEntryChars: 1024 * 1024,
  maxQueryChars: 200,
};

/** Entries read per paginated read. It bounds one read, not the scan: the scan follows the cursor to the end. */
const ENTRY_PAGE = 200;

/** One conversation's match, before its catalogue row is attached. */
export type SessionSearchHit = {
  conversationId: string;
  /** The entry the match is in, so opening the result can reach it. */
  entryId: string;
  /** Index of the matching text block within that entry's message. */
  blockIndex: number;
  before: string;
  match: string;
  after: string;
};

export type SessionSearchResponse = { results: SessionSearchHit[]; truncated: boolean };

/** A query over the upstream cap: refused with a reason, never answered as an empty result. */
export class SearchQueryTooLong extends RangeError {
  readonly code = "query_too_long";
}

/** One entry's text blocks, with each block's own index in the message, as the browser's transcript numbers them. */
function textBlocksOf(content: unknown): { text: string; blockIndex: number }[] {
  if (typeof content === "string") return [{ text: content, blockIndex: 0 }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, blockIndex) =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string"
      ? [{ text: (block as { text: string }).text, blockIndex }]
      : []);
}

/**
 * The matching entry as a result: the entry it is in, the block within it, and the snippet around the match. The
 * offsets are in the original text, which is why the query is escaped into a literal rather than compiled as one.
 */
function hitOf(conversation: Conversation, entry: EntryRecord, blocks: readonly { text: string; blockIndex: number }[], text: string, match: RegExpExecArray): SessionSearchHit {
  const start = match.index;
  const end = start + match[0].length;
  let blockOffset = 0;
  const matched = blocks.find((block) => {
    const blockEnd = blockOffset + block.text.length;
    blockOffset = blockEnd + 1;
    return start <= blockEnd;
  });
  return {
    conversationId: String(conversation.id),
    entryId: String(entry.id),
    blockIndex: matched?.blockIndex ?? 0,
    before: (start > 80 ? "..." : "") + text.slice(Math.max(0, start - 80), start).replace(/\s+/g, " ").trimStart(),
    match: match[0].replace(/\s+/g, " "),
    after: text.slice(end, end + 80).replace(/\s+/g, " ").trimEnd() + (end + 80 < text.length ? "..." : ""),
  };
}

/**
 * One conversation's first match, in entry order, and whether the scan stopped before the end of its history.
 *
 * Only user and assistant entries are searched, as upstream searches only its `user`/`assistant` message lines: a
 * tool result, a thinking block, an image, a compaction summary and a system prompt are not what a user remembers
 * having written or read. The first match wins, so a conversation answers with one result rather than repeating itself
 * once per turn that mentions the phrase.
 */
async function scanConversation(conversation: Conversation, matcher: RegExp, limits: SearchLimits, deadline: number, now: () => number): Promise<{ hit?: SessionSearchHit; truncated: boolean }> {
  let cursor: Cursor | undefined;
  let bytes = 0;
  let truncated = false;
  while (true) {
    if (now() >= deadline) return { truncated: true };
    const page = await conversation.entries({ order: "ascending" }, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (now() >= deadline) return { truncated: true };
      if (!UserEntry.is(entry) && !AssistantEntry.is(entry)) continue;
      const blocks = textBlocksOf(entry.model?.[0]?.content);
      const text = blocks.map((block) => block.text).join("\n");
      bytes += Buffer.byteLength(text, "utf8");
      // An entry past the per-entry cap is not searched, and the caller is told the answer may be incomplete rather
      // than being given a transcript that silently has a hole in it.
      if (text.length > limits.maxEntryChars) { truncated = true; continue; }
      if (bytes >= limits.maxConversationBytes) return { truncated: true };
      const match = matcher.exec(text);
      if (match === null) continue;
      return { hit: hitOf(conversation, entry, blocks, text, match), truncated };
    }
    if (page.next === undefined) return { truncated };
    cursor = page.next;
  }
}

/**
 * Search the given conversations' whole bodies and answer the sessions and their matching excerpts.
 *
 * `now` is injectable so the wall-clock bound is exercised by a test without waiting for it, exactly as the skill
 * repository's cache clock is. `limits` is injectable for the same reason: a test proves the bound logic without
 * building five hundred conversations, and the shipped numbers are asserted against the vendored upstream file.
 */
export async function searchConversationBodies(
  conversations: readonly Conversation[],
  query: string,
  options: { now?: () => number; limits?: SearchLimits } = {},
): Promise<SessionSearchResponse> {
  const limits = options.limits ?? SEARCH_LIMITS;
  const now = options.now ?? Date.now;
  const response: SessionSearchResponse = { results: [], truncated: false };
  const needle = query.trim();
  if (!needle) return response;
  if (needle.length > limits.maxQueryChars) throw new SearchQueryTooLong("a search query of at most " + limits.maxQueryChars + " characters is required");
  // Escape every operator: this is literal search, with offsets in the original text.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const deadline = now() + limits.timeBudgetMs;
  // Newest first, as upstream reads its files. The durable catalogue carries no modified time (the runtime's
  // conversation record has none), so the id it was minted with is the order it was created in.
  const candidates = [...conversations].sort((left, right) => Number(right.id) - Number(left.id));
  for (const [index, conversation] of candidates.entries()) {
    if (index >= limits.maxConversations || response.results.length >= limits.maxResults || now() >= deadline) { response.truncated = true; break; }
    try {
      const scanned = await scanConversation(conversation, matcher, limits, deadline, now);
      if (scanned.hit !== undefined) response.results.push(scanned.hit);
      if (scanned.truncated) response.truncated = true;
    } catch {
      // A conversation whose history cannot be read must not hide every other conversation's results, and the caller
      // is told the answer is incomplete instead of being given a silent hole.
      response.truncated = true;
    }
  }
  return response;
}
