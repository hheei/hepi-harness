import type { ConversationSettings, ModelRef, NavigationOutlinePage, NavigationTargetWindow, QueuedItemProjection, ServerSnapshot, SubmissionProjection } from "@hepi/protocol";
import { createConversationControl, type ConversationControl, type OperationResult } from "@hepi/session/control";
import type { WorkbenchClient } from "../client.ts";
import { catalogueRow, catalogueRows, catalogueRunning, type Catalogue, type CatalogueEntry, type CatalogueRow, type CompactRunningCatalogue } from "./conversation-catalogue.ts";
import type { SessionSearchResponse } from "./session-search.ts";
import type { AgentMessage } from "./types.ts";
import type { NativeEntryPage } from "./durable-projection.ts";

/**
 * The conversation API the shared workbench asks its connection for.
 *
 * One vocabulary, the Backend's own: `/api/conversations…` is the route the client ingress forwards unchanged, so what a
 * surface reads here is the contract the Backend publishes rather than a translation of the retired Next BFF's
 * `/api/sessions…` and `/api/agent…` routes. The Gateway makes no business rewrite and the Backend keeps its one
 * projection; the only thing that changes between the two hosts is the origin and the credential, which the client
 * already owns.
 *
 * What this module is responsible for is the two things that genuinely differ from a raw request:
 *
 * - **the catalogue row**, which the sidebar renders. It is a projection of the Backend's own answer (see
 *   `conversation-catalogue.ts`), not a second source of truth: a row states only facts the catalogue stated.
 * - **the three-outcome rule** for writes, which `@hepi/session/control` already owns. A lost answer is never retried
 *   here; it carries the request id the attempt was made under and is resolved by asking the conversation about it.
 */

/** One conversation's own native snapshot, as `GET /api/conversations/:id` and `/state` answer it. */
export type NativeSnapshot = ServerSnapshot<AgentMessage>;

/** The durable record of one submission, as `GET /api/conversations/:id/submissions` answers it. */
export type SubmissionRecord = SubmissionProjection & { readonly requestId: string };

export type ConversationApi = {
  /** The catalogue, as the sidebar lists it: the rows, the running set and the revisions beside them. */
  list(options?: { readonly signal?: AbortSignal }): Promise<{ sessions: CatalogueRow[]; runningSessionIds: string[]; sessionListVersion: number; sessionUiStateRevision: number; projectsRevision: number }>;
  /** The catalogue's own bounded full-body search, with each hit's row projected the same way the list projects it. */
  search(query: string, options?: { readonly signal?: AbortSignal }): Promise<SessionSearchResponse>;
  /** The same catalogue read as the poll asks it: the running set and the revisions, without the rows. */
  running(options?: { readonly signal?: AbortSignal }): Promise<{ runningSessionIds: string[]; sessionListVersion: number; sessionUiStateRevision: number; projectsRevision: number }>;
  /** Create a conversation. `requestId` is the attempt identity a lost answer is answered by, not repeated. */
  create(options: { readonly requestId?: string; readonly workspaceId?: string; readonly signal?: AbortSignal }): Promise<{ conversationId: string; conversation?: CatalogueEntry }>;
  /**
   * The conversation's own native snapshot: the transcript window and the composer state beside it, from one answer.
   *
   * `null` is the Backend's `not_found`: this conversation does not exist (any more), which is a statement about the
   * read rather than a failure of it. Every other refusal is thrown, so a surface still tells "gone" from "unreadable".
   */
  read(conversationId: string, options?: { readonly signal?: AbortSignal }): Promise<NativeSnapshot | null>;
  /** The conversation's identity as the by-id read states it: relations, references and its catalogue row. */
  open(conversationId: string): Promise<CatalogueRow & { readonly conversation?: unknown }>;
  /** The durable record of one submission by the request id it was made under. `null` means it was never admitted. */
  submission(conversationId: string, requestId: string, options?: { readonly signal?: AbortSignal }): Promise<SubmissionRecord | null>;
  /** One page of older history, in the shape the browser's own projection reads. */
  historyPage(conversationId: string, options?: { readonly leafId?: string; readonly before?: string; readonly tail?: number; readonly signal?: AbortSignal }): Promise<NativeEntryPage>;
  /** The raw history behind the window: the Backend's own bounded read over the fork-aware entry table. */
  rawRead<T = unknown>(conversationId: string, query: string): Promise<T>;
  /**
   * One bounded target window around one navigation coordinate, as the Backend's own read answers it.
   *
   * `query` is the caller's full query string (`?anchor=…&snapshot=…`): the bounds, the pin and the search hit's exact
   * block are the contract's own parameters, and this side forwards them rather than assembling a window of its own.
   * A refusal arrives as the connection's error carrying the Backend's `code`, which is what names `missing`,
   * `stale-snapshot`, `wrong-scope` or `malformed` to the navigation coordinator.
   */
  navigationTarget(conversationId: string, query: string, options?: { readonly signal?: AbortSignal }): Promise<NavigationTargetWindow>;
  /**
   * One bounded page of the conversation's user-message outline.
   *
   * `cursor` continues the page this surface last held (exclusive, the Backend's own ordering value) and `scope` is the
   * scope it was read under, so a history that re-baselined answers `stale-snapshot` rather than a mixed page. The
   * bounds are the contract's: a caller that names no `limit` is served the default page, and no caller asks for the
   * whole index.
   */
  navigationOutline(conversationId: string, options?: { readonly limit?: number; readonly cursor?: number; readonly scope?: string; readonly signal?: AbortSignal }): Promise<NavigationOutlinePage>;

  /** Ask the Backend to name this conversation from its own committed transcript, and read the name it wrote. */
  autoName(conversationId: string): Promise<{ title?: string }>;
  /** The conversation's effective configuration: the model and reasoning level a composer states. */
  settings(conversationId: string): Promise<{ model: ModelRef | null; thinkingLevel: string }>;
  /** Apply an explicit choice to one conversation. The Backend validates it and answers what it stored. */
  updateSettings(conversationId: string, settings: { model?: ModelRef; thinkingLevel?: string }): Promise<{ model: ModelRef | null; thinkingLevel: string }>;
  /** The commands this conversation's own catalogue offers. */
  commands(conversationId: string): Promise<{ commands: { name: string; description: string; source: "prompt" | "skill" }[] }>;
  /** Explicit reload of the conversation's workspace resources. A refusal is the Backend's own diagnostic. */
  reload(conversationId: string): Promise<{ resources?: { pending?: boolean; skills?: number; prompts?: number } }>;
  /** The named control, queue, fork and relation operations of one conversation. */
  control(conversationId: string): ConversationControl;
};

/**
 * The error one operation's refusal is thrown as, so a caller that already distinguishes a refusal from a lost answer
 * keeps doing so through `instanceof`. A refusal carries the Backend's own status and code; an unknown outcome carries
 * the request id the attempt was made under and is never retried here.
 */
export class ConversationRefusal extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly unknown: boolean;
  constructor(result: Extract<OperationResult<unknown>, { ok: false }>) {
    super(result.kind === "refused" ? result.message : result.reason);
    this.name = "ConversationRefusal";
    this.unknown = result.kind === "unknown";
    if (result.kind === "refused") {
      this.status = result.status;
      this.code = result.code;
    } else {
      this.requestId = result.requestId;
    }
  }
}

/** Whether one thrown read is the Backend's own `not_found`, which is a statement about the read and not a failure. */
function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;
}

/** Whether one thrown operation is the Backend refusing this request, as opposed to an answer that never arrived. */
export const isRefusal = (error: unknown): boolean => error instanceof ConversationRefusal && !error.unknown;

/** One failed operation as the error a caller throws, so a surface states the reason it was given. */
export const operationFailure = (result: Extract<OperationResult<unknown>, { ok: false }>): ConversationRefusal => new ConversationRefusal(result);

/**
 * A request id for one attempt.
 *
 * `crypto.randomUUID` exists only in a secure context, and a Web origin is also served over plain HTTP, so an insecure
 * page falls back to `getRandomValues`, which every context provides.
 */
export function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The Backend's conversation routes, under the connection's own origin. */
const CONVERSATIONS = "/api/conversations";

/**
 * The conversation API of one connection.
 *
 * Every request goes through the client, which is what makes it the connection's own: its origin, its credential, and a
 * refusal once it is disposed. The control surface is handed the client's own `request` rather than a global `fetch`,
 * so a stop or a send cannot leave the connection it was made on.
 */
export function createConversationApi(client: WorkbenchClient): ConversationApi {
  return {
    async list(options = {}) {
      return catalogueRows(await client.readJson<Catalogue>(CONVERSATIONS, options));
    },
    async search(query, options = {}) {
      // The Backend states the excerpt and the catalogue row each hit is in; this side projects the row, so the search
      // answer and the list answer carry the same row shape.
      const answer = await client.readJson<{ results: (Omit<SessionSearchResponse["results"][number], "session"> & { session: CatalogueEntry })[]; truncated: boolean }>(
        "/api/search?" + new URLSearchParams({ q: query }).toString(),
        options.signal === undefined ? {} : { signal: options.signal },
      );
      // Each hit's row is projected by the same function the list uses, so the row a result hands the sidebar and the
      // row the next list read shows for that conversation cannot be two different things.
      return { results: answer.results.map(({ session, ...excerpt }) => ({ session: catalogueRow(session), ...excerpt })), truncated: answer.truncated };
    },
    async running(options = {}) {
      return catalogueRunning(await client.readJson<CompactRunningCatalogue>(CONVERSATIONS + "?running=compact", options));
    },
    async create(options = {}) {
      const requestId = options.requestId ?? createRequestId();
      return await client.readJson<{ conversationId: string; conversation?: CatalogueEntry }>(CONVERSATIONS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    async read(conversationId, options = {}) {
      try {
        return await client.readJson<NativeSnapshot>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/state", options.signal === undefined ? {} : { signal: options.signal });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async open(conversationId) {
      const answer = await client.readJson<{ conversation?: CatalogueEntry } & Record<string, unknown>>(CONVERSATIONS + "/" + encodeURIComponent(conversationId));
      // The by-id answer is the conversation's identity *and* its catalogue row, so the row is projected from the same
      // answer rather than from a second list read that would have to race it.
      return answer.conversation === undefined ? (answer as unknown as CatalogueRow) : { ...catalogueRow(answer.conversation), ...answer };
    },
    async submission(conversationId, requestId, options = {}) {
      const answer = await client.readJson<{ submission?: SubmissionRecord | null }>(
        CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/submissions?requestId=" + encodeURIComponent(requestId),
        options.signal === undefined ? {} : { signal: options.signal },
      );
      return answer.submission ?? null;
    },
    async historyPage(conversationId, options = {}) {
      // Older history is the Backend's own entry page: this side forwards the reader's own cursor and hands the answer
      // to the projection that renders it, so a paged entry and a streamed one are one shape.
      const query = new URLSearchParams();
      if (options.before !== undefined && options.before !== "") query.set("before", options.before);
      if (options.tail !== undefined) query.set("tail", String(options.tail));
      return await client.readJson<NativeEntryPage>(
        CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/entries" + (query.size === 0 ? "" : "?" + query.toString()),
        options.signal === undefined ? {} : { signal: options.signal },
      );
    },
    async rawRead<T>(conversationId: string, query: string): Promise<T> {
      return await client.readJson<T>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/read" + query);
    },
    async navigationTarget(conversationId, query, options = {}) {
      return await client.readJson<NavigationTargetWindow>(
        CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/navigation/around" + query,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    },
    async navigationOutline(conversationId, options = {}) {
      const query = new URLSearchParams();
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor !== undefined) query.set("cursor", String(options.cursor));
      if (options.scope !== undefined && options.scope !== "") query.set("scope", options.scope);
      return await client.readJson<NavigationOutlinePage>(
        CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/navigation" + (query.size === 0 ? "" : "?" + query.toString()),
        options.signal === undefined ? {} : { signal: options.signal },
      );
    },
    async autoName(conversationId) {
      return await client.readJson<{ title?: string }>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/auto-name", { method: "POST" });
    },
    async settings(conversationId) {
      const answer = await client.readJson<ConversationSettings & Record<string, unknown>>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/settings");
      return { model: answer.model ?? null, thinkingLevel: answer.thinkingLevel };
    },
    async updateSettings(conversationId, settings) {
      const answer = await client.readJson<{ model: ModelRef | null; thinkingLevel: string }>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      return { model: answer.model ?? null, thinkingLevel: answer.thinkingLevel };
    },
    async commands(conversationId) {
      const answer = await client.readJson<{ commands?: { name: string; description: string; source: "prompt" | "skill" }[] }>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/commands");
      return { commands: answer.commands ?? [] };
    },
    async reload(conversationId) {
      return await client.readJson<{ resources?: { pending?: boolean; skills?: number; prompts?: number } }>(CONVERSATIONS + "/" + encodeURIComponent(conversationId) + "/reload", { method: "POST" });
    },
    control(conversationId) {
      return createConversationControl({
        conversationId,
        // A path, not an origin: the control surface's own fetch is the connection's request, which is what resolves
        // the path against this connection's Gateway and attaches its credential.
        basePath: CONVERSATIONS,
        // The connection's own request: its origin, its credential, and nothing at all once it is disposed. Passing
        // `fetch` here instead would let a control write leave the connection it was made on.
        fetch: (input, init) => client.request(input, init),
      });
    },
  };
}

