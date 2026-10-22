import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentState, Conversation, Extension, ModelRef } from "@earendil-works/pi-durable";
import { PROTOCOL_VERSION, type ConversationProvenance } from "@hepi/protocol";
import { conversationPage } from "./conversation-page.ts";
import { catalogueListVersion } from "./catalogue-binding.ts";
import type { ConversationRuntime } from "./conversation-attachments.ts";
import { ConversationOperationRefusal, type ConversationOperations } from "./conversation-operations.ts";
import type { ConversationCatalogue } from "./conversation-catalogue.ts";
import type { ProjectRegistry } from "./project-registry.ts";
import { safeFailure } from "./public-errors.ts";
import { readSidebarState } from "./sidebar-state.ts";
import { SearchQueryTooLong, searchConversationBodies } from "./session-search.ts";

/**
 * The conversation catalogue: the session list and its running poll, full-body search, and the creation of a
 * conversation.
 *
 * These are the conversation routes that name no conversation yet — they list what exists, search it, and add to it —
 * so they cannot live in a handler that resolves one identity first. What they share is the catalogue projection and
 * the attachment map: a list is one pass over the conversations this process already holds, and the row a creation
 * answers with is the row the next list read shows for it.
 */

export type ConversationCatalogueHttpOptions = {
  /** Every attached conversation this process holds: the list's rows and the search's bodies. */
  readonly conversations: () => Iterable<ConversationRuntime>;
  /** The attached conversation one id names, for a search hit's row. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
  /** The durable conversation operations: creation is the one seam that records it, with its relations and dedupe. */
  readonly operations: ConversationOperations;
  /** The catalogue projection every row comes from. */
  readonly catalogue: ConversationCatalogue;
  /** The registry, for the publication revision the list states and the targets a creation may bind. */
  readonly registry: ProjectRegistry;
  /** The committed sidebar document, whose revision rides on the list read. */
  readonly session: Parameters<typeof readSidebarState>[0];
  /** Attach the conversation a creation committed, so the row answered is the row the next list read shows. */
  readonly attach: (conversation: Conversation) => Promise<ConversationRuntime>;
  /** The model new conversations start with, as this deployment resolved it; absent when it configured none. */
  readonly model: ModelRef | undefined;
  /** The thinking level new conversations start with, as the deployment configured it. */
  readonly defaultThinkingLevel: AgentState["thinkingLevel"];
  /** The extensions one new conversation selects, resolved against its workspace. */
  readonly selectionFor: (workspaceId: string | undefined) => Promise<Extension[]>;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

export function createConversationCatalogueHttp(options: ConversationCatalogueHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  const listed = (): ConversationRuntime[] => [...options.conversations()].filter(item => item.deletedAt() === undefined);
  return async (request, response, url) => {
    // The catalogue states everything a session list needs about each conversation: its workspace and host, whether a
    // run is in flight, its revision, and the summary the list shows. `snapshot()` returns the already-published view
    // rather than rebuilding it, so this is one pass over this process's own map and no per-conversation request: a
    // client asking which conversations are busy — the sidebar's running poll — reads one list instead of every
    // transcript, and the same list still carries the preview it showed before.
    if (request.method === "GET" && url.pathname === "/api/conversations") {
      // The sidebar's own revision rides on this one read: a client that compares it with the revision it last saw
      // knows its pins, archive and project order changed in another window, without a second request per poll.
      const sidebar = await readSidebarState(options.session);
      // A removed conversation is not in the catalogue it was removed from; its records still read back through the
      // conversation-scoped routes, which is what makes the removal a tombstone rather than a deletion.
      const facts = await options.catalogue.facts();
      const rows = listed().map(item => options.catalogue.entry(item, facts));
      // The relation filters select rows this projection already holds — by creator, display parent, fork source, owner
      // or workspace — and `limit`/`cursor` page them by conversation id. This is the filtered, paginated list the
      // relations seam answers with, reusing the catalogue rather than a second graph service.
      const wanted = (name: string): string | null => url.searchParams.get(name);
      const filtered = rows.filter((entry) =>
        (wanted("createdBy") === null || entry.createdBy === wanted("createdBy"))
        && (wanted("displayParentId") === null || entry.displayParentId === wanted("displayParentId"))
        && (wanted("forkSource") === null || entry.parentConversationId === wanted("forkSource"))
        && (wanted("ownerConversationId") === null || entry.subagentParentConversationId === wanted("ownerConversationId"))
        && (wanted("workspaceId") === null || entry.workspaceId === wanted("workspaceId")));
      filtered.sort((left, right) => Number(left.id) - Number(right.id));
      const limitParam = wanted("limit");
      const limit = limitParam === null ? undefined : Number(limitParam);
      if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) { json(response, 400, { code: "invalid_request", error: "limit must be a positive integer" }); return true; }
      const cursor = wanted("cursor");
      if (cursor !== null && !/^[0-9]+$/.test(cursor)) { json(response, 400, { code: "invalid_request", error: "cursor must be a conversation id" }); return true; }
      // A poll asks which conversations are busy and nothing else, so it is answered from the flag the rows were
      // already built with rather than from a second scan.
      const compactRunning = wanted("running") === "compact";
      // It answers the whole filtered list, so a page bound it cannot honour is refused rather than silently answered in full.
      if (compactRunning && (limitParam !== null || cursor !== null)) { json(response, 400, { code: "invalid_request", error: "running=compact cannot be combined with limit or cursor" }); return true; }
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
          projectsRevision: options.registry.revision(),
          sessionListVersion,
          runningConversationIds: filtered.filter(row => row.busy).map(row => row.id),
        }); return true;
      }
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        sidebarStateRevision: sidebar.revision,
        projectsRevision: options.registry.revision(),
        sessionListVersion,
        conversations: window,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }); return true;
    }
    // Full-body search over the conversations this catalogue lists, with no index: the entries are read through the
    // runtime's public paginated reads, so an entry appended after a previous search is found by the next one with
    // nothing to rebuild. A removed conversation is not in the catalogue it was removed from, so it is not searched;
    // the matcher, the bounds and the response shape are upstream pi-web's (`./session-search.ts`).
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query === "") { json(response, 200, { protocol: PROTOCOL_VERSION, results: [], truncated: false }); return true; }
      try {
        const searched = await searchConversationBodies(listed().map(item => item.conversation), query);
        const facts = await options.catalogue.facts();
        json(response, 200, { protocol: PROTOCOL_VERSION, results: searched.results.map(hit => ({ ...hit, session: options.catalogue.entry(options.conversation(hit.conversationId)!, facts) })), truncated: searched.truncated }); return true;
      } catch (error) {
        // An over-long query is refused with the reason it was refused, not answered as an empty result.
        if (error instanceof SearchQueryTooLong) { json(response, 400, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
    }
    if (request.method === "POST" && url.pathname === "/api/conversations") {
      const body = await options.readBody(request) as { workspaceId?: string; requestId?: string; createdBy?: string; displayParentId?: string; provenance?: unknown } | undefined;
      // Only a configured workspace or a folder of a recorded project is a target for a new conversation. A binding a
      // removal retained resolves for the conversations that already hold it, and a new conversation cannot be bound to
      // a folder that is no longer a Project folder.
      if (body?.workspaceId && !options.registry.isTarget(body.workspaceId)) { json(response, 400, { error: "unknown workspace" }); return true; }
      // A project's root is re-registered here: the gateway keeps its workspaces in memory, so a gateway restarted
      // while this backend stayed up still serves the conversation that is about to bind that folder.
      if (body?.workspaceId) await options.registry.ensureBinding(body.workspaceId);
      // The relations a caller states are identities only. A value that is not a conversation id string is refused
      // here; an identity that names no conversation is refused inside the same creation commit that would use it.
      if (body?.createdBy !== undefined && (typeof body.createdBy !== "string" || body.createdBy.trim() === "")) { json(response, 400, { code: "invalid_request", error: "createdBy must be a conversation id" }); return true; }
      if (body?.displayParentId !== undefined && (typeof body.displayParentId !== "string" || body.displayParentId.trim() === "")) { json(response, 400, { code: "invalid_request", error: "displayParentId must be a conversation id" }); return true; }
      // The conversation's extension selection is materialized here, in the commit that creates it: the resolved global
      // default is written into this conversation's own `pi.agent.extensions` as an explicit name list. That is what
      // makes the selection this conversation's own state — a later change to the default is a change to what the *next*
      // conversation selects, and this one is not re-read against it. Creation, relations, the workspace binding and the
      // request dedupe are the one creation seam's commit; a replay of the same request id answers the same conversation.
      try {
        const spawned = await options.operations.spawn({
          requestId: body?.requestId !== undefined && body.requestId.trim() !== "" ? body.requestId : randomUUID(),
          ownership: { kind: "ownerless" },
          agent: { model: options.model, thinkingLevel: options.defaultThinkingLevel, extensions: await options.selectionFor(body?.workspaceId), cwd: "/" },
          ...(body?.createdBy === undefined ? {} : { createdBy: body.createdBy }),
          ...(body?.displayParentId === undefined ? {} : { displayParentId: body.displayParentId }),
          ...(body?.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          ...(body?.provenance === undefined ? {} : { provenance: body.provenance as ConversationProvenance }),
        });
        const attached = await options.attach(spawned.conversation);
        json(response, 201, { protocol: PROTOCOL_VERSION, conversationId: spawned.conversationId, conversation: options.catalogue.entry(attached, await options.catalogue.facts()) }); return true;
      } catch (error) {
        if (error instanceof ConversationOperationRefusal) { json(response, error.status, { protocol: PROTOCOL_VERSION, code: error.code, error: safeFailure(error) }); return true; }
        throw error;
      }
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
