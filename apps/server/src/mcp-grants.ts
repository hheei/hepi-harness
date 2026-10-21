import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { AgentDoc, configure, defineDoc, type AgentChange, type AgentState, type ConversationId, type Session } from "@earendil-works/pi-durable";
import type { McpConfigRead, McpToolDescriptor, McpToolList } from "@hepi/protocol/gateway";
import { MCP_TOOL_PREFIX, mcpGrantKey, type McpSelection, type McpToolIdentity } from "./mcp-conversation-tools.ts";
// The one list this package refuses for a host-owned key, so a deployment's fallback and a conversation's grant are the
// same rule about who owns a configuration rather than two lists that can drift. The host refuses them again on its own
// route (`packages/gateway/src/mcp/invocation.ts`); nothing here is the only thing standing between a body and a command.
import { MCP_HOST_CONFIGURATION_KEYS } from "./mcp-declarations.ts";

/**
 * One conversation's MCP grants: durable hepi state, written only by a person's act (ticket 03b).
 *
 * A Gateway owns an MCP server and answers what its tools are (03a); the Backend owns a conversation's tool lifecycle.
 * This document is the half of that seam a conversation chooses: the **identity** of each tool it was granted, plus the
 * descriptor the host published at the moment of the grant. The identity is the whole authority this process holds about
 * a tool, and it is deliberately narrow — it says a person chose this tool for this conversation. Everything the host
 * decides about the server it belongs to is the host's answer at call time: whether the folder is trusted, whether the
 * entry is switched on, whether the tool is exposed, whether the server still has it under that name. Nothing here
 * re-derives those, so this document is never a second answer to a host question and can never honour a stale one.
 *
 * What is deliberately not in it:
 *
 * - No credential, no configuration, no execution property. An entry names a host, a scope, a server, a tool and a
 *   presentation. There is no field for a command, an argument list, a URL, an environment value, a header or a token —
 *   and no path writes one, because the only writer takes its fields from the host's own bounded, masked listing, never
 *   from a request body. A client cannot author the text a model is offered.
 * - No fork inheritance. `fork: "initial"` is the runtime's own semantics for a choice a conversation makes
 *   for itself: a branch of a conversation that held grants starts with none, and its inherited offer is reconciled
 *   against that empty set by the one writer below.
 * - No session default. "Grant this to every conversation I create next" is a product decision this slice does not make;
 *   a deployment that wants tools broadly available has its declaration path, whose role is the operator's fallback
 *   presentation — never a ceiling a grant has to fit inside, and never a switch that turns MCP off.
 *
 * The offer a conversation resolves is derived from this document and never stored as a third copy of it: the runtime
 * offers a deferred tool only when `pi.agent.modelTools` names it, so grants and offer are two readings of one
 * fact, and one writer keeps them from disagreeing.
 */
export type McpGrantEntry = {
  readonly gatewayId: string;
  readonly scope: "global" | "project";
  readonly server: string;
  readonly tool: string;
  /** The host's text for this tool, as published when the grant was made. Presentation, and stale by design. */
  readonly description?: string;
  /** The server's own argument shape at that moment. Absent with `schemaOmitted` means the host withheld it. */
  readonly inputSchema?: JsonValue;
  readonly readOnly?: true;
  readonly schemaOmitted?: true;
  /** When the host published this descriptor: the grant states what it is a snapshot of, not what is true now. */
  readonly listedAt: number;
};

export type McpGrantState = { version: 1; grants: McpGrantEntry[] };

export const McpGrantDoc = defineDoc<McpGrantState>({
  kind: "hepi.mcp-grants",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ version: 1, grants: [] }),
});

/** The grants one write may state for one server, which is the bound the host's own listing already answers within. */
export const MCP_GRANT_MAX_TOOLS = 256;

/** Why a grant or discovery request wrote nothing, named so a surface can say which part it must change. */
export type GrantRefusal = { readonly code: string; readonly error: string };

/**
 * What one conversation asked for inside its own selection write: one server's grants, stated exactly.
 *
 * This is a write, so a request states the names it wants offered, and an empty array states none — which revokes that
 * server's grants. Asking what a server **holds** is a different act with a different cost, because the host must
 * connect the server to answer: it is the read of this seam (`GET …/extensions?mcp=<server>`), never something a write
 * does by omission. A grant is still always taken from that listing, so the two halves meet on the tool's name.
 */
export type GrantRequest = { readonly server: string; readonly tools: readonly string[] };

export function grantRequest(value: unknown): GrantRequest | GrantRefusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { code: "invalid_request", error: "mcp names one server, and optionally the exact tools to grant of it" };
  }
  const body = value as Record<string, unknown>;
  const hostOwned = MCP_HOST_CONFIGURATION_KEYS.filter(key => key in body);
  if (hostOwned.length > 0) {
    return { code: "invalid_request", error: "mcp carries " + hostOwned.join(", ") + ", which the host owns: a grant names a server and its tools" };
  }
  if (typeof body.server !== "string" || body.server.trim() === "") {
    return { code: "invalid_request", error: "server names the configured server whose grants this write replaces" };
  }
  const server = body.server.trim();
  if (body.tools === undefined) return { code: "invalid_request", error: "tools states the exact names to grant of " + server + ", or [] to revoke them; what a server holds is read with ?mcp=" + server };
  if (!Array.isArray(body.tools)) return { code: "invalid_request", error: "tools must be an array of tool names, possibly empty" };
  if (body.tools.length > MCP_GRANT_MAX_TOOLS) return { code: "invalid_request", error: "one server is granted at most " + MCP_GRANT_MAX_TOOLS + " tools" };
  const tools: string[] = [];
  for (const [index, item] of body.tools.entries()) {
    if (typeof item !== "string" || item.trim() === "") return { code: "invalid_request", error: "tools entry " + index + " must be a tool name" };
    const name = item.trim();
    // A wildcard is refused by name, not expanded: an allowlist that accepts "everything" is not an allowlist.
    if (name === "*") return { code: "invalid_request", error: "tools must name each granted tool; a wildcard grants nothing" };
    if (name.startsWith(MCP_TOOL_PREFIX)) return { code: "invalid_request", error: "tools names a whole tool name (" + name + "); name the tool the server reports" };
    if (tools.includes(name)) return { code: "invalid_request", error: "tools names " + name + " twice" };
    tools.push(name);
  }
  return { server, tools };
}

/** The identities one grant list carries, in the key a registration meets them on. */
export function mcpGrantKeys(entries: readonly McpGrantEntry[]): string[] {
  return [...new Set(entries.map(entry => mcpGrantKey(entry)))];
}

/**
 * A conversation's grants as the adapter reads them.
 *
 * Grouped per server because that is how a surface states a grant and how the host's own refusals arrive. The identity a
 * call checks against is the registration's own host, server and tool, so a grant written for another gateway cannot
 * authorize a call on this one.
 */
export function mcpGrantSelection(entries: readonly McpGrantEntry[]): McpSelection {
  const byServer = new Map<string, string[]>();
  const granted = new Map(entries.map(entry => [mcpGrantKey(entry), entry.scope]));
  for (const entry of entries) {
    const list = byServer.get(entry.server);
    if (list === undefined) byServer.set(entry.server, [entry.tool]);
    else if (!list.includes(entry.tool)) list.push(entry.tool);
  }
  return {
    servers: Object.fromEntries([...byServer].map(([server, tools]) => [server, tools])),
    // The scope is the grant's own, and one identity has one: a conversation grants a tool in the file it was listed
    // from, and a later grant of the same identity replaces it rather than adding a second scope beside it.
    scopeOf: (identity: McpToolIdentity) => granted.get(mcpGrantKey(identity)),
  };
}

/** A conversation's grants, and the offer they state. */
export type McpGrants = { readonly grants: readonly McpGrantEntry[]; readonly keys: readonly string[] };

/**
 * Read one conversation's grants.
 *
 * A missing document is exactly "granted nothing", which is the state a conversation that never asked for a tool is in,
 * and the state a revoked conversation returns to.
 */
export async function readMcpGrants(session: Pick<Session, "snapshot">, conversationId: string | number, context: Context = BACKGROUND_CONTEXT): Promise<McpGrants> {
  const stored = await session.snapshot(McpGrantDoc, Number(conversationId) as ConversationId, context);
  const grants = Array.isArray(stored?.grants) ? stored.grants : [];
  return { grants, keys: mcpGrantKeys(grants) };
}

/** A stored name list, ignoring anything that is not a name. */
function names(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The offer one grant set implies, kept in the shape the conversation's own filter is already in.
 *
 * A granted MCP tool is registered deferred, and the runtime offers a deferred tool only when `modelTools` names it. So
 * the grant set is what loads these tools, and a name this set no longer states is dropped from the offer — which is what
 * makes a revoked grant and a fork's inherited offer lose their names instead of lingering.
 *
 * An exact array is kept an exact array: that shape means `exactly these tools, in this order`, and rewriting one as an
 * edit would silently widen a conversation's offer back to every non-deferred tool it selected. Otherwise `add` carries
 * the grant set and `remove` carries the names this set dropped; a re-granted name leaves `remove` and returns to
 * `add`, and a name that is not an MCP identity is preserved untouched in whichever list held it. That preservation is the
 * point: this writer owns MCP offers and nothing else, and a grant request says nothing about another part of a
 * conversation's tool set.
 */
export function mcpGrantOffer(stored: unknown, keys: readonly string[]): string[] | { add?: string[]; remove?: string[] } {
  const isMcp = (name: string): boolean => name.startsWith(MCP_TOOL_PREFIX);
  const granted = new Set(keys);
  if (Array.isArray(stored)) {
    const kept = names(stored).filter(name => !isMcp(name) || granted.has(name));
    return [...kept, ...keys.filter(key => !kept.includes(key))];
  }
  const edit = stored as { add?: unknown; remove?: unknown } | undefined | null;
  const add = names(edit?.add);
  const remove = names(edit?.remove);
  const outside = (list: readonly string[]) => list.filter(name => !isMcp(name));
  // A granted name is loaded, and a name that lost its grant is taken back whether it sat in `add` or in
  // `remove` before. Everything this writer does not own stays in the list that held it — dropping a stored
  // `remove` of a non-MCP name would widen the conversation's offer on a request that said nothing about it.
  const next = [...new Set([...outside(add), ...keys])];
  const dropped = [...new Set([...outside(remove), ...[...add, ...remove].filter(name => isMcp(name) && !granted.has(name))])];
  return { ...(next.length === 0 ? {} : { add: next }), ...(dropped.length === 0 ? {} : { remove: dropped }) };
}

/**
 * The `pi.agent.tools` a grant implies, or `undefined` when the conversation's own filter already admits every granted
 * name.
 *
 * An exact array is the only shape that states an allowlist, so it is the only one this writer widens: a granted name is
 * appended in grant order and every other name stays where it was. A `{ remove }` filter and an unset filter admit
 * everything they do not name, so a grant needs no change to them — and writing one would be this writer editing a
 * decision it does not own.
 */
export function mcpEnabledOffer(stored: AgentState["tools"], keys: readonly string[]): string[] | undefined {
  if (!Array.isArray(stored)) return undefined;
  const missing = keys.filter(key => !stored.includes(key));
  return missing.length === 0 ? undefined : [...stored, ...missing];
}

/** Whether a stored filter already states this offer, so a boot or a fork with nothing to change writes nothing. */
function statesSame(stored: unknown, next: string[] | { add?: string[]; remove?: string[] }): boolean {
  if (Array.isArray(next)) return Array.isArray(stored) && sameNames(names(stored), next);
  // An empty edit and an unset filter state one offer — "everything this conversation's extensions offer, except the
  // deferred ones no grant names" — so an adoption with nothing to add and nothing to drop writes nothing. That is not
  // cosmetic: an attach runs for every conversation at every boot, and a spurious commit there would rewrite the agent
  // document of every conversation that holds no grants at all.
  if ((next.add?.length ?? 0) === 0 && (next.remove?.length ?? 0) === 0) return !Array.isArray(stored);
  if (stored === undefined || stored === null || Array.isArray(stored)) return false;
  const edit = stored as { add?: unknown; remove?: unknown };
  return sameNames(names(edit.add), next.add ?? []) && sameNames(names(edit.remove), next.remove ?? []);
}

/**
 * A grant's name list in the shape `configure()` takes: the seam narrows tool objects to their names, so a name is
 * carried as `{ name }` and nothing else about a tool is claimed by this writer.
 */
function offerChange(offer: string[] | { add?: string[]; remove?: string[] }): NonNullable<AgentChange["modelTools"]> {
  // `AgentChange` types its tools as registrations and immediately maps them to `.name`; a stored grant name is a
  // name, so it travels as a name carrier, which is the only field that seam reads.
  return (Array.isArray(offer)
    ? carriers(offer)
    : {
        ...(offer.add === undefined ? {} : { add: carriers(offer.add) }),
        ...(offer.remove === undefined ? {} : { remove: carriers(offer.remove) }),
      }) as NonNullable<AgentChange["modelTools"]>;
}

/**
 * A stored name as the carrier `configure()` reads. `applyChange` maps every tool entry to `.name` before it stores
 * anything, so this is a transport shape and never a claim about a tool.
 */
function carriers(names: readonly string[]): { readonly name: string }[] {
  return names.map(name => ({ name }));
}

/**
 * An exact `pi.agent.tools` list in the shape `configure()` takes. The field is typed as registrations and narrowed to
 * names by the seam itself, so a name travels as a carrier here for the same reason it does in {@link offerChange}.
 */
function toolsChange(names: readonly string[]): NonNullable<AgentChange["tools"]> {
  return carriers(names) as unknown as NonNullable<AgentChange["tools"]>;
}

function sameNames(stored: readonly string[], next: readonly string[]): boolean {
  return stored.length === next.length && stored.every((name, index) => name === next[index]);
}

/**
 * Write one server's grants and the offer that follows from them, in one commit.
 *
 * The grant document and `pi.agent.modelTools` are two records about one fact and must not be able to
 * disagree: a conversation told it holds a grant it was never offered, or offered a grant it does not hold, would be
 * answered one thing by a read and another by a run. So one transaction writes both, and it reconciles the offer
 * against the **whole** grant set rather than only this server's, because replacing one server's grants must leave the
 * others offered. Entries arrive from the host's own listing and are copied through the runtime's own JSON narrowing.
 *
 * A conversation whose own `pi.agent.tools` states an **exact** list is one whose enabled set is already narrowed —
 * a child delegated from an agent definition, for instance. A grant written there would otherwise be loaded into
 * `modelTools` and still not offered, because the runtime filters the enabled set first: the write would commit a grant
 * that no resolution can reach, which is the one answer a person must never be given about their own act. So the same
 * commit adds the granted names to that exact list, and only to that list: an unset or `{ remove }` filter states no
 * allowlist of its own and is left alone.
 *
 * The offer is written with `configure()`, the runtime's own seam for `pi.agent` (pi-durable
 * `dist/harness/agent.js`: `configure` → `applyChange`, the same path the framework's `addTools` writes for
 * `tool_search`). It is the only public way a host of this library can change a conversation's tool filter, and nothing
 * in this repository assigns `AgentDoc` any more: the document is read here and written by the framework. `AgentChange`
 * carries tools as objects and `applyChange` stores their names (`agent.js` `names()`), so the writer hands the seam
 * name carriers — `.name` is the only field the runtime reads, and a grant is durable state that must outlive the code
 * that first offered it.
 */
export async function writeMcpGrants(
  session: Session,
  conversationId: string | number,
  server: string,
  entries: readonly McpGrantEntry[],
  context: Context = BACKGROUND_CONTEXT,
): Promise<McpGrants> {
  const id = Number(conversationId) as ConversationId;
  return await session.commit(async tx => {
    const document = await tx.doc(McpGrantDoc, id);
    const others = (Array.isArray(document.grants) ? document.grants : []).filter(entry => entry.server !== server);
    document.grants = copyJson([...others, ...entries], { omitUndefinedProperties: true }) as McpGrantEntry[];
    const keys = mcpGrantKeys(document.grants);
    // The stored filter is read to keep what this writer does not own; it is written through `configure`, which
    // replaces the field and narrows it the way the runtime itself does.
    const before = await tx.doc(AgentDoc, id);
    const enabled = mcpEnabledOffer(before.tools, keys);
    await configure(tx, id, {
      ...(enabled === undefined ? {} : { tools: toolsChange(enabled) }),
      modelTools: offerChange(mcpGrantOffer(before.modelTools, keys)),
    });
    return { grants: [...document.grants], keys };
  }, context);
}

/**
 * Make a conversation's offer match its grants, and say whether anything changed.
 *
 * This is the one writer of MCP names in `modelTools` besides the grant write, and it runs wherever a stored
 * offer could have arrived from somewhere other than this conversation's own grants: a boot (a restart re-offers what a
 * conversation holds, from the durable document and nothing else) and a fork or copy (which inherits the source's agent
 * document and none of its grants). A branch that starts with an empty grant list therefore loses the source's granted
 * names from its filter, which is what makes "a grant is a person's act" a fact of the store rather than a hope about a
 * surface. A conversation with nothing to change writes nothing.
 */
export async function reconcileMcpOffer(
  session: Session,
  conversationId: string | number,
  keys: readonly string[],
  context: Context = BACKGROUND_CONTEXT,
): Promise<boolean> {
  const id = Number(conversationId) as ConversationId;
  return await session.commit(async tx => {
    const state = await tx.doc(AgentDoc, id);
    const next = mcpGrantOffer(state.modelTools, keys);
    const enabled = mcpEnabledOffer(state.tools, keys);
    if (enabled === undefined && statesSame(state.modelTools, next)) return false;
    await configure(tx, id, { ...(enabled === undefined ? {} : { tools: toolsChange(enabled) }), modelTools: offerChange(next) });
    return true;
  }, context);
}

/**
 * The host's own listing answer, taken as what a grant may be written from, or refused as what was not one.
 *
 * The route reaches the host through the same client every other host call uses, and that client hands back the host's
 * answer as JSON the transport already read. So this is where the shape is checked before a grant is written from it:
 * a body that is not a listing — a refusal the caller forgot to test for, or an answer from a host that does not
 * understand the operation — grants nothing rather than writing a half-read document.
 */
export function mcpToolListOf(value: unknown): McpToolList | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const list = value as Record<string, unknown>;
  if (list.scope !== "global" && list.scope !== "project") return undefined;
  if (typeof list.server !== "string" || list.server.trim() === "") return undefined;
  if (typeof list.listedAt !== "number" || !Number.isFinite(list.listedAt)) return undefined;
  if (!Array.isArray(list.tools)) return undefined;
  const tools = list.tools.filter(tool => typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string");
  // A tool the host did not name is not one a person can grant, and the answer says it was incomplete rather than
  // letting a smaller list read as the server's own count.
  return {
    scope: list.scope,
    server: list.server,
    listedAt: list.listedAt,
    tools: tools as McpToolDescriptor[],
    total: typeof list.total === "number" ? list.total : list.tools.length,
    truncated: list.truncated === true || tools.length < list.tools.length,
    pages: typeof list.pages === "number" ? list.pages : 1,
    durationMs: typeof list.durationMs === "number" ? list.durationMs : 0,
    ...(typeof list.serverInfo === "object" && list.serverInfo !== null ? { serverInfo: list.serverInfo as McpToolList["serverInfo"] } : {}),
  };
}

/**
 * The host's answer to `operation: "read"`, taken as what a server list may be read from, or refused as what was not one.
 *
 * A settings panel names the servers a person can ask about before anything is granted, and the only honest source of
 * that list is the host's own configuration files: `read` describes an entry from the file without connecting, so this
 * seam never starts a server to render a state and never repeats a deployment's environment as if it were the host's
 * configuration. A body that is not a read answer states no servers rather than a half-read list.
 */
export function mcpConfigReadOf(value: unknown): McpConfigRead | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const read = value as Record<string, unknown>;
  if (!Array.isArray(read.servers)) return undefined;
  const servers = read.servers.filter((server): server is McpConfigRead["servers"][number] => typeof server === "object" && server !== null && typeof (server as { name?: unknown }).name === "string");
  const files = Array.isArray(read.files) ? read.files.filter((file): file is McpConfigRead["files"][number] => typeof file === "object" && file !== null && typeof (file as { path?: unknown }).path === "string") : [];
  return { servers, files } as McpConfigRead;
}

/**
 * The grant entries one listing answers for the tools a person asked to grant.
 *
 * The host's answer is the only source of a granted tool's presentation, and only the tools it named are grantable: a
 * request for a tool the server did not list is reported rather than granted, because a name the host does not have
 * would be an offer the host then refuses at every call. A descriptor over the host's own schema bound arrives as
 * `schemaOmitted`, which is what the registration below turns into an empty argument object rather than a
 * guess — a tool whose arguments cannot be seen is still a tool the person chose, and the host validates its own
 * arguments at the call.
 */
export function grantEntriesOf(list: McpToolList, gatewayId: string, requested: readonly string[]): { readonly entries: McpGrantEntry[]; readonly missing: readonly string[] } {
  const byName = new Map(list.tools.map(tool => [tool.name, tool]));
  const entries: McpGrantEntry[] = [];
  const missing: string[] = [];
  for (const tool of requested) {
    const described = byName.get(tool);
    if (described === undefined) { missing.push(tool); continue; }
    const schemaless = described.inputSchema === undefined;
    entries.push({
      gatewayId,
      scope: list.scope,
      server: list.server,
      tool,
      ...(described.description === undefined ? {} : { description: described.description }),
      ...(schemaless ? { schemaOmitted: true } : { inputSchema: described.inputSchema as JsonValue }),
      ...(described.readOnly === true ? { readOnly: true } : {}),
      listedAt: list.listedAt,
    });
  }
  return { entries, missing };
}
