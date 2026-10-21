import type { SessionInfo } from "./types";

/**
 * The shape of a session search answer, and the only half of the upstream matcher that stays on the Web host.
 *
 * Upstream's `lib/session-search.ts` reads each session's JSONL file and matches inside it. A durable conversation is
 * not a file, so the reading half lives in the backend (`apps/server/src/session-search.ts`), which reads entries
 * through the runtime's public paginated reads and applies upstream's matcher, limits and bounds. What remains here is
 * the response shape the sidebar renders, byte-for-byte the upstream one: the session, the entry and block the match
 * is in, and the excerpt around it.
 */
/**
 * The longest query a search accepts, counted in characters as upstream counts it. It is the same number on all three
 * sides: the input's own `maxLength`, the route's refusal, and the backend's matcher. One constant, so a bound stated
 * in the panel and a bound enforced in the backend cannot drift apart.
 */
export const MAX_SEARCH_QUERY_CHARS = 200;

export interface SessionSearchResult {
  session: SessionInfo;
  entryId?: string;
  blockIndex: number;
  before: string;
  match: string;
  after: string;
}

export interface SessionSearchResponse {
  results: SessionSearchResult[];
  truncated: boolean;
}
