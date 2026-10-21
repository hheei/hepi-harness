import { PROTOCOL_VERSION } from "@hepi/protocol";
import {
  ConversationReadRefusal,
  type ConversationReadCursor,
  type ConversationReadOperations,
  type ConversationReadResult,
} from "./conversation-read.ts";

/**
 * The raw-history HTTP adapter: one request answered from one core read.
 *
 * The route is a thin translation and nothing else — it parses the query into the read's own request, calls the same
 * `read()` an `agent_read` tool call would use, and states the answer in the wire shape. It holds no second
 * implementation of the bounds, the cursor or the membership rule, so an HTTP caller and a model tool cannot be served
 * two different histories, and a refusal is the core's own code and status rather than a message matched on.
 *
 * Query parameters, all optional except the scope they imply:
 * - `offset` — 1-based actual text line to start at (default 1).
 * - `limit` — maximum lines (default 2000).
 * - `entryId` — read one entry of the history instead of the whole of it.
 * - `blockIndex` — read one block of `entryId`; a block that is text returns its lines, an image returns the image.
 * - `tail` — the snapshot's end, as returned by a previous page; pins the line mapping.
 * - `cursor` — a JSON-encoded continuation position from a previous page's `details.next`.
 */

/** The answer one request produces: the status the route writes and the body it writes with it. */
export type ConversationReadAnswer = { readonly status: number; readonly body: unknown };

/**
 * One raw-history request, as the route answers it. The conversation is already resolved by the caller (the route
 * pattern owns that), so an unknown conversation never reaches here: what a read can refuse is its own scope.
 */
export async function handleConversationRead(read: ConversationReadOperations, conversationId: string, query: URLSearchParams): Promise<ConversationReadAnswer> {
  let request;
  try {
    request = {
      conversationId,
      ...(query.get("offset") === null ? {} : { offset: integerParameter(query, "offset") }),
      ...(query.get("limit") === null ? {} : { limit: integerParameter(query, "limit") }),
      ...(query.get("entryId") === null ? {} : { entryId: entryIdParameter(query, "entryId") }),
      ...(query.get("blockIndex") === null ? {} : { blockIndex: integerParameter(query, "blockIndex") }),
      ...(query.get("tail") === null ? {} : { tail: entryIdParameter(query, "tail") }),
      ...(query.get("cursor") === null ? {} : { cursor: cursorParameter(query) }),
    };
  } catch (error) {
    if (!(error instanceof ConversationReadRefusal)) throw error;
    return { status: error.status, body: { protocol: PROTOCOL_VERSION, conversationId, code: error.code, error: error.message } };
  }
  try {
    const read_ = await read.read(request);
    return { status: 200, body: { protocol: PROTOCOL_VERSION, ...read_ } };
  } catch (error) {
    if (!(error instanceof ConversationReadRefusal)) throw error;
    return { status: error.status, body: { protocol: PROTOCOL_VERSION, conversationId, code: error.code, error: error.message } };
  }
}

/** A numeric parameter as the query states it: a decimal integer, never a value `Number` would coerce from noise. */
function integerParameter(query: URLSearchParams, name: string): number {
  const value = query.get(name)!;
  if (!/^[0-9]+$/.test(value)) throw new ConversationReadRefusal("invalid_request", 400, name + " must be a non-negative integer");
  return Number(value);
}

function entryIdParameter(query: URLSearchParams, name: string): string {
  const value = query.get(name)!;
  if (!/^[0-9]+$/.test(value)) throw new ConversationReadRefusal("invalid_request", 400, name + " must be an entry id");
  return value;
}

/** A continuation is one opaque value: the core checks it as a whole, so a malformed one is a bad request and nothing else. */
function cursorParameter(query: URLSearchParams): ConversationReadCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(query.get("cursor")!);
  } catch {
    throw new ConversationReadRefusal("invalid_request", 400, "cursor must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ConversationReadRefusal("invalid_request", 400, "cursor must be a JSON object");
  return parsed as ConversationReadCursor;
}

/** The wire body of a successful read, for a caller that types the answer rather than the generic one. */
export type ConversationReadResponse = ConversationReadResult & { readonly protocol: typeof PROTOCOL_VERSION };
