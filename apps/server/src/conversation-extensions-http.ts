import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import type { McpToolList } from "@hepi/protocol/gateway";
import { PROTOCOL_VERSION } from "@hepi/protocol";
import { grantRequest } from "./mcp-grants.ts";
import type { ConversationRuntime } from "./conversation-attachments.ts";

/**
 * One conversation's extension selection and its MCP grants: the read a surface makes before it offers a tool, and the
 * one seam that writes the two halves.
 *
 * `pi.agent.extensions` says whether this conversation may be granted MCP tools at all and `pi.agent.modelTools` says
 * which ones it is offered; both are the framework's own per-conversation fields, so this route writes them and holds no
 * selection document of its own. What a server **holds** is read through the MCP listing seam, never written by
 * omission: listing connects a server, and an accidental listing is not something a grant request should be able to ask
 * for. The answer is always the whole selection — the names, the offered tools and the grants — so one seam answers the
 * state it just wrote.
 */

/** A host listing a grant write may be refused by, with the status a browser-facing route answers it with. */
export type McpListingRefusal = { readonly ok: false; readonly code: string; readonly error: string; readonly status: number };

export type ConversationExtensionsHttpOptions = {
  /** The conversation one path segment names, from the attachment map this backend owns. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
  /** The stored selection a request asked to write, refused as a whole when it names something this backend lacks. */
  readonly requestedSelection: (body: unknown, workspaceBound: boolean) => { readonly ok: true; readonly extensions: Extension[] } | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string };
  /** One server's tools as its own host lists them, asked only when a request names one. */
  readonly listedServer: (conversationId: string, server: string) => Promise<{ readonly ok: true; readonly gatewayId: string; readonly list: McpToolList } | McpListingRefusal>;
  /** The conversation's grants and the servers its host has configured, as the panel reads them. */
  readonly grantAnswer: (item: ConversationRuntime, conversationId: string, offered: readonly string[]) => Promise<Record<string, unknown>>;
  /** Write one conversation's grants for one server, from the host's own listing of it. */
  readonly writeGrants: (conversationId: string, server: string, tools: readonly string[]) => Promise<McpListingRefusal | undefined>;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

export function createConversationExtensionsHttp(options: ConversationExtensionsHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "conversations") return false;
    const id = parts[2];
    // Only a conversation-scoped path belongs to this module: the catalogue's own `/api/conversations` is another
    // owner's route, and claiming it here would answer the list as an unknown conversation.
    if (id === undefined) return false;
    const item = options.conversation(id);
    if (item === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return true; }
    const action = parts[3];
    // The whole selection of one conversation, read as one answer: the extensions it selects, the tools those select
    // offer it, and inside them its MCP grants and the servers its host has configured. Nothing here asks a host
    // whether it is up, and nothing here derives an offer — `offered` is the runtime's own resolution.
    if (request.method === "GET" && action === "extensions") {
      // `?mcp=<server>` is the one read that asks a host what one server holds, and it is asked, never defaulted: an
      // ordinary read of the selection starts nothing. Every other query of this seam answers the conversation's own
      // durable state and the host's own configuration files.
      const asked = url.searchParams.get("mcp");
      const listing = asked === null || asked.trim() === "" ? undefined : await options.listedServer(id, asked.trim());
      if (listing !== undefined && !listing.ok) { json(response, listing.status, { protocol: PROTOCOL_VERSION, code: listing.code, error: listing.error }); return true; }
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      const toolNames = agent.tools.map(tool => tool.name);
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        conversationId: id,
        extensions: agent.extensions.map(extension => extension.name),
        toolNames,
        mcp: { ...(await options.grantAnswer(item, id, toolNames)), ...(listing === undefined ? {} : { listed: listing.list }) },
      }); return true;
    }
    // The body carries the extension names, exactly as it always did, plus an optional `mcp` section stating one
    // server's grants for this conversation:
    //
    // - `mcp: { server, tools: [...] }` replaces this conversation's grants of that server, and `tools: []` revokes
    //   them. Either half of the body may be left out to say nothing about that half: `{ mcp }` alone writes grants and
    //   leaves the extension selection where it stands, `{ extensions }` alone writes the selection and touches no
    //   grant. What a server **holds** is read (`?mcp=<server>`), never written by omission.
    // - Whatever the body said, the answer is the whole selection: extension names, offered tool names, and the
    //   conversation's grants — one seam answers the state it just wrote.
    //
    // Nothing here takes a client's description of a tool's arguments, and nothing here writes an agent document by
    // hand: a grant's descriptor is copied from the host's listing, the offer is written through the runtime's own
    // `configure` seam, and both halves are validated before either is applied — a bad name writes neither part.
    if (request.method === "PATCH" && action === "extensions") {
      const body = await options.readBody(request);
      const states = (key: string): boolean => body !== null && typeof body === "object" && !Array.isArray(body) && key in body;
      if (!states("extensions") && !states("mcp")) { json(response, 400, { protocol: PROTOCOL_VERSION, code: "invalid_request", error: "the body states extensions, mcp, or both" }); return true; }
      // One seam, two halves, and each half validates in its own words: a request that states only `mcp` says nothing
      // about extensions and is not refused for that, and a request that states both writes both or neither.
      const selection = states("extensions") ? options.requestedSelection(body, item.snapshot().workspaceId !== undefined) : undefined;
      if (selection !== undefined && !selection.ok) { json(response, selection.status, { code: selection.code, error: selection.error }); return true; }
      // The `mcp` section is read with the same care as the extension names, and a key the host owns is refused by name.
      const grant = states("mcp") ? grantRequest((body as { mcp?: unknown }).mcp) : undefined;
      if (grant !== undefined && "code" in grant) { json(response, 400, { protocol: PROTOCOL_VERSION, ...grant }); return true; }
      // The grant is written first, so a host that refuses a name leaves the extension selection exactly as it stood.
      if (grant !== undefined) {
        const refusal = await options.writeGrants(id, grant.server, grant.tools);
        if (refusal !== undefined) { json(response, refusal.status, { protocol: PROTOCOL_VERSION, code: refusal.code, error: refusal.error }); return true; }
      }
      if (selection !== undefined && selection.ok) await item.conversation.configure({ extensions: selection.extensions }, BACKGROUND_CONTEXT);
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      const toolNames = agent.tools.map(tool => tool.name);
      json(response, 200, { protocol: PROTOCOL_VERSION, conversationId: id, extensions: agent.extensions.map(extension => extension.name), toolNames, mcp: await options.grantAnswer(item, id, toolNames) }); return true;
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
