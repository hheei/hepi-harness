import type { McpToolList } from "@hepi/protocol/gateway";
import type {
  ConversationMcpGrant,
  ConversationMcpResponse,
  ConversationMcpServer,
  ConversationMcpState,
} from "./api-types";

/**
 * A conversation's MCP tool states, as the browser reads and changes them (ticket 03c).
 *
 * The seam is 03b's and nothing here widens it: `GET /api/conversations/:id/extensions` answers the conversation's
 * selection, its grants, the servers its **host** configures and the names the runtime resolves for it; the same route
 * with `?mcp=<server>` is the one request that asks a host what one named server holds; a `PATCH` to it writes one
 * server's grants. There is no second listing path, no session tool registry and no browser-side grant document.
 *
 * What this module owns is the one thing a browser can add honestly: the **four states kept apart**, each read from the
 * single fact that states it.
 *
 * | State | Stated by | Never inferred from |
 * | --- | --- | --- |
 * | configured | `mcp.servers` — the host's own `read` of its files | a deployment's environment, a grant |
 * | exposed | the tools the `?mcp=<server>` listing answered | `read`'s count of `toolExposure` keys, a grant |
 * | selected | `mcp.grants` — this conversation's durable allowlist | a host listing, the runtime's offer |
 * | available | those three met for one tool, plus this conversation's own selection and binding | a connect |
 *
 * "Currently available" is therefore exactly what this backend can state without asking a host anything (research
 * `.scratch/mcp-conversation-tools/research/03-discovery-and-selection-contract.md` §6): the grant, the entry still
 * existing and being switched on and not hidden in the host's own file, and the conversation selecting `hepi.mcp` with a
 * workspace and gateway to run on. It is deliberately **not** a claim that one registered name resolves: the seam
 * answers `mcp.offered` as the runtime's own list of names, and a registered MCP name is a sanitized, bounded, possibly
 * hash-suffixed identifier that `lib/mcp-tool-display.ts` already records as not splittable back into a server's names.
 * Those names are shown verbatim and never re-derived here, because a browser that recomputed the backend's naming rule
 * would be a second copy of it, free to drift.
 *
 * Discovery is explicit and per named server. Opening a panel, refreshing it or rendering an unrelated setting asks the
 * host to read a file and connects nothing; only {@link mcpListingRoute} is a request that starts a server, and only a
 * person asking makes it. A listing never grants — {@link mcpGrantBody} is the only write that changes what a
 * conversation is offered — and a grant always names exact tools taken from that listing.
 *
 * No credential, resolved entry value or host path is reachable through anything this module returns: it reads a fixed
 * list of fields off the seam's answer, so a hostile or unexpected key in the same body cannot be carried into browser
 * state by it. A granted tool's argument schema is presentation the host wrote for a model, is shown nowhere here, and
 * {@link mcpPanelState} leaves it out for exactly that reason.
 */

/** The one extension every MCP tool is registered by; the name a conversation selects to be offered any of it. */
export const MCP_EXTENSION = "hepi.mcp";

/** The prefix every MCP tool name carries, which is how the panel tells the offered MCP names from the rest of an offer. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Why nothing this conversation holds can run, as a fact of the conversation rather than of a server. */
export type McpAvailabilityLimit = "extension-not-selected" | "no-workspace" | "no-gateway";

/** One tool of one server, as this conversation reads it, with the four states separate. */
export type McpToolRow = {
  readonly server: string;
  readonly scope: "global" | "project";
  readonly tool: string;
  /** The host has an entry for this server, in one of the folder's two `mcp.json` files. */
  readonly configured: boolean;
  /**
   * The host was never asked successfully, so this row cannot say whether an entry exists.
   *
   * Distinct from `configured: false`, which is the host's own "I have no entry of that name": a configuration read
   * that was refused or unreachable states nothing about a server, and a panel must not turn that silence into a "no".
   */
  readonly configUnknown?: true;
  /** The host listed this tool when a person asked it. */
  readonly exposed: boolean;
  /** Nobody asked this host what the server holds, so exposure is an unread question rather than a `no`. */
  readonly exposureUnknown?: true;
  /** This conversation's durable grant names it. */
  readonly selected: boolean;
  /** A call this conversation issued now would reach the host for it. */
  readonly available: boolean;
  /**
   * Whether availability could be stated at all.
   *
   * The host's configuration read is what says an entry still exists, is switched on and is not hidden, so a read that
   * answered nothing leaves availability unknown rather than false: the grants and the runtime's offer are still this
   * conversation's own facts, and the one missing fact is the host's file.
   */
  readonly availableUnknown?: true;
  /** Set when `available` is false for a reason that belongs to the conversation, not to the tool. */
  readonly limitedBy?: McpAvailabilityLimit;
  /** This host marks it `hidden`, so the listing still shows it and a call is refused. */
  readonly hidden?: true;
  /** The server is switched off in the host's file, so it lists nothing and runs nothing. */
  readonly switchedOff?: true;
  /** The host withheld this tool's argument schema; the offer carries an empty argument object and the host validates. */
  readonly schemaOmitted?: true;
  /** The grant's snapshot and this host's newest reading differ, so the model is offered words the server no longer gives. */
  readonly descriptorChanged?: true;
  /** The host's own masked words, from the listing where there was one and from the grant otherwise. */
  readonly description?: string;
  /** The server's own claim, and only when it was the boolean `true`. Absent means unknown, not safe. */
  readonly readOnly?: true;
  /** How this host exposes it, as the listing read its own entry. */
  readonly exposure?: string;
  /** When the host published the snapshot this grant holds. */
  readonly grantedAt?: number;
  /** When the listing this row comes from was read. */
  readonly listedAt?: number;
};

/**
 * One server this conversation can be talked about, whether or not the host's read named it.
 *
 * A panel shows the **union** of what the host configures and what this conversation holds grants of, because those are
 * two independent facts: a host that is offline, or a read that was refused, states no configuration while the
 * conversation's own choices are untouched and must stay visible — and revocable — on this seam. A server named only by
 * a grant is therefore shown with its configured state unknown, never omitted.
 */
export type McpServerBlock = {
  readonly server: string;
  readonly scope: "global" | "project";
  /** The host's read names this server. */
  readonly configured: boolean;
  /** The host's read answered nothing, so `configured: false` here is unknown rather than the host's own "no". */
  readonly configUnknown?: true;
  /** The host's own `enabled`. Absent when the configuration was not read, which is not the same as `false`. */
  readonly enabled?: boolean;
  /** The exposure the host's entry names, when it named one. */
  readonly exposure?: string;
  /** How many of this server's tools this conversation holds a grant for, which is why it is shown at all. */
  readonly selected: number;
};

/**
 * The servers a panel lists, as the union of the host's configuration and this conversation's grants.
 *
 * The host's own order comes first — it is the order a person reads in its file — and a server only a grant names is
 * appended in name order, with its configured state unknown. Nothing is dropped and nothing is invented: a server the
 * host names and no grant touches appears with zero selections, and a server a grant names while the host says nothing
 * appears with the grant and an unknown configuration.
 */
export function mcpServerBlocks(view: ConversationMcpView): McpServerBlock[] {
  const granted = new Map<string, { readonly scope: "global" | "project"; readonly selected: number }>();
  for (const grant of view.grants) {
    const held = granted.get(grant.server);
    const scope = grant.scope === "project" ? "project" : "global";
    granted.set(grant.server, { scope: held === undefined ? scope : held.scope, selected: (held?.selected ?? 0) + 1 });
  }
  const named = new Set<string>();
  const blocks = view.servers.map((entry) => {
    named.add(entry.server);
    return {
      server: entry.server,
      scope: entry.scope === "project" ? "project" as const : "global" as const,
      configured: true,
      enabled: entry.enabled,
      ...(entry.exposure === undefined ? {} : { exposure: entry.exposure }),
      selected: granted.get(entry.server)?.selected ?? 0,
    };
  });
  const grantedOnly = [...granted.keys()].filter((server) => !named.has(server)).sort();
  return [
    ...blocks,
    ...grantedOnly.map((server) => ({
      server,
      scope: granted.get(server)!.scope,
      configured: false,
      ...(view.serversKnown ? {} : { configUnknown: true as const }),
      selected: granted.get(server)!.selected,
    })),
  ];
}

/** What one server is to this conversation, counted from the same rows a panel lists. */
export type McpServerStates = {
  readonly server: string;
  readonly scope: "global" | "project";
  /** Configured is the host's file; it is what makes the other three possible at all. */
  readonly configured: boolean;
  /** The host's read answered nothing, so `configured: false` here means "unknown", never "the host has no entry". */
  readonly configUnknown?: true;
  /** A listing of this server is in this panel's hands, so "exposed" is an answer rather than a question. */
  readonly listed: boolean;
  readonly exposed: number;
  readonly selected: number;
  readonly available: number;
  /** One of its granted tools could not be stated as available or not, because the host's configuration was not read. */
  readonly availableUnknown?: true;
  readonly limitedBy?: McpAvailabilityLimit;
  readonly switchedOff?: true;
};

/** The conversation's own MCP state as the panel holds it, listings included because the seam answered them. */
export type ConversationMcpView = {
  readonly conversationId: string;
  readonly extensionSelected: boolean;
  readonly workspaceBound: boolean;
  readonly gatewayId?: string;
  /** The names the runtime resolves as this conversation's offer right now, filtered to the MCP ones. */
  readonly offered: readonly string[];
  /** The servers the **host** has entries for, as its own read answered them. */
  readonly servers: readonly ConversationMcpServer[];
  /**
   * Whether that read answered at all.
   *
   * `false` is this panel never having been told what the host configures — the host is offline, the gateway is not
   * configured here, or the answer was not a read. The grants below are unaffected, which is why a conversation's own
   * choices stay visible and revocable while its host is away; only the *configured* state becomes unknown.
   */
  readonly serversKnown: boolean;
  /** Why the configuration read stated nothing, when it did not. The seam's own code, never a made-up status. */
  readonly serversRefusal?: McpSeamRefusal;
  readonly grants: readonly ConversationMcpGrant[];
  /** The listings this answer carries — at most the one server a person asked about. */
  readonly listings: readonly McpToolList[];
};

/** A refusal the seam answered with, in the panel's own words. */
export type McpSeamRefusal = { readonly code: string; readonly error: string; readonly status: number };

/** The selection seam of one conversation. Routes are built here so a question and its write cannot name different paths. */
export function mcpSelectionRoute(conversationId: string): string {
  return "/api/conversations/" + encodeURIComponent(conversationId) + "/extensions";
}

/**
 * The one request that connects a server.
 *
 * Nothing calls it to render a setting: its absence from a panel's first request is the property ticket 03c is written
 * around, and a person asking what one named server holds is the only thing that makes it.
 */
export function mcpListingRoute(conversationId: string, server: string): string {
  return mcpSelectionRoute(conversationId) + "?" + new URLSearchParams({ mcp: server }).toString();
}

/**
 * The write that grants or revokes one server's tools, exactly as 03b reads it.
 *
 * The list is the **whole** set this conversation wants of that server, because the seam replaces it; an empty list
 * revokes every grant of that server and asks nothing of a host, which is why a revocation works on an offline one.
 * Nothing here can state a configuration key: the backend refuses `command`, `args`, `env`, `url`, `headers`, `auth`,
 * `config`, `cwd`, `workspaceId` and `token` by name before it writes, and refuses a wildcard rather than expanding it.
 */
export function mcpGrantBody(server: string, tools: readonly string[]): string {
  return JSON.stringify({ mcp: { server, tools: [...new Set(tools)] } });
}

/** The same write with one more tool of that server granted, keeping the grants this conversation already holds. */
export function mcpGrantAddBody(view: ConversationMcpView, server: string, tool: string): string {
  return mcpGrantBody(server, [...grantedTools(view, server), tool]);
}

/** …and with one tool taken away, which says nothing about the others of that server. */
export function mcpGrantRemoveBody(view: ConversationMcpView, server: string, tool: string): string {
  return mcpGrantBody(server, grantedTools(view, server).filter((name) => name !== tool));
}

/** Every tool of one server this conversation holds a grant for, in the order the grant states them. */
export function grantedTools(view: ConversationMcpView, server: string): string[] {
  return view.grants.filter((grant) => grant.server === server).map((grant) => grant.tool);
}

/**
 * One answer as the panel reads it, or the refusal that answer was.
 *
 * A body that is not the seam's answer is reported as a protocol fault rather than as an empty state, because "this host
 * configures no servers" and "this process could not read the answer" are two different sentences to a person.
 */
export function readConversationMcp(
  conversationId: string,
  body: unknown,
  status = 200,
): { readonly ok: true; readonly view: ConversationMcpView } | { readonly ok: false; readonly refusal: McpSeamRefusal } {
  if (status !== 200) return { ok: false, refusal: seamRefusal(body, status) };
  const mcp = (body as ConversationMcpResponse | null)?.mcp;
  if (!isRecord(mcp) || !Array.isArray(mcp.servers) || !Array.isArray(mcp.grants) || !Array.isArray(mcp.offered)) {
    return { ok: false, refusal: { code: "protocol_error", error: "the selection seam answered with something that is not a conversation's MCP state", status } };
  }
  const state = mcp as unknown as ConversationMcpState;
  const listed = state.listed;
  // A seam that predates `serversKnown` — or one that states servers without it — is read as having answered, which is
  // what an absent field meant before the distinction existed: only an explicit `false` claims the host was not read.
  const serversKnown = state.serversKnown !== false;
  return {
    ok: true,
    view: {
      conversationId,
      extensionSelected: state.selected === true,
      serversKnown,
      ...(serversKnown || !isRecord(state.serversRefusal) ? {} : {
        serversRefusal: {
          code: typeof state.serversRefusal.code === "string" ? state.serversRefusal.code : "operation_failed",
          error: typeof state.serversRefusal.error === "string" ? state.serversRefusal.error : "the host configuration read stated no reason",
          status: 0,
        },
      }),
      workspaceBound: typeof state.workspaceId === "string" && state.workspaceId !== "",
      ...(typeof state.gatewayId === "string" && state.gatewayId !== "" ? { gatewayId: state.gatewayId } : {}),
      offered: state.offered.filter((name): name is string => typeof name === "string" && name.startsWith(MCP_TOOL_PREFIX)),
      servers: state.servers.filter((entry) => isRecord(entry) && typeof entry.server === "string").map((entry) => ({
        server: entry.server,
        scope: entry.scope === "project" ? "project" : "global",
        enabled: entry.enabled === true,
        ...(typeof entry.exposure === "string" ? { exposure: entry.exposure } : {}),
      })),
      grants: state.grants.filter((grant) => isRecord(grant) && typeof grant.server === "string" && typeof grant.tool === "string"),
      // A listing the seam answered is a listing this panel holds: the state and the discovery answer come back in one
      // body, so keeping them apart would mean two copies of one fact, which is what 03b refused to build.
      listings: isListing(listed) ? [listed as unknown as McpToolList] : [],
    },
  };
}

/**
 * The one server's listing out of the same answer, or the refusal that listing was.
 *
 * A listing that is not a listing is refused **as a listing**: the conversation's own state still reads, so a panel
 * keeps showing its grants rather than losing them because a host answered oddly.
 */
export function readMcpListing(
  server: string,
  body: unknown,
  status = 200,
): { readonly ok: true; readonly listing: McpToolList } | { readonly ok: false; readonly refusal: McpSeamRefusal } {
  if (status !== 200) return { ok: false, refusal: seamRefusal(body, status) };
  const listed = (body as ConversationMcpResponse | null)?.mcp?.listed;
  if (!isListing(listed)) {
    return { ok: false, refusal: { code: "protocol_error", error: "the host answered the listing with something that is not a tool list", status } };
  }
  return { ok: true, listing: listed as unknown as McpToolList };
}

/**
 * This view, with the listings another view already held for the servers this one says nothing about.
 *
 * A state read and a write both answer a conversation's grants and offer, and neither is a host being asked what a
 * server holds: the listings this panel was given were answers to its own per-server presses, and they stay the newest
 * reading of those servers until a press replaces them. An answer that states a listing is that server's newer reading;
 * one that states none says nothing about any listing at all.
 */
export function withHeldListings(view: ConversationMcpView, held: ConversationMcpView | null): ConversationMcpView {
  if (held === null || held.conversationId !== view.conversationId) return view;
  const named = new Set(view.listings.map((listing) => listing.server));
  const kept = held.listings.filter((listing) => !named.has(listing.server));
  return kept.length === 0 ? view : { ...view, listings: [...view.listings, ...kept] };
}

/**
 * The view a grant or revocation write leaves the panel showing.
 *
 * A write answers the conversation's whole selection, and only a **grant** had to read a host to write its descriptors,
 * so only a grant's answer carries a listing. An answer that states none is therefore not the host saying its server
 * holds nothing, and a panel that read the absence as an empty set would forget every tool the person was looking at the
 * moment they selected one of them.
 */
export function appliedWrite(
  view: ConversationMcpView,
  body: unknown,
  status = 200,
): { readonly ok: true; readonly view: ConversationMcpView } | { readonly ok: false; readonly refusal: McpSeamRefusal } {
  const read = readConversationMcp(view.conversationId, body, status);
  if (!read.ok) return read;
  return { ok: true, view: withHeldListings(read.view, view) };
}

/** The listing this view holds for one server, which is only ever one a person asked about. */
export function listingOf(view: ConversationMcpView, server: string): McpToolList | undefined {
  return view.listings.find((listing) => listing.server === server);
}

/**
 * This view, with one server's newest listing kept beside it.
 *
 * The seam answers a listing only for the server a person just asked about, so the panel holds the readings it was
 * given: a grant write refreshes its own server's listing and leaves the others exactly as they were read, and a
 * revocation asks no host at all and therefore keeps the snapshot it already had rather than losing it.
 */
export function withListing(view: ConversationMcpView, listing: McpToolList): ConversationMcpView {
  return { ...view, listings: [...view.listings.filter((held) => held.server !== listing.server), listing] };
}

/**
 * The rows one server's tools are shown as.
 *
 * A listed tool no grant names, a granted tool the newest listing no longer names and a configured server nobody has
 * listed are three different states, so the rows are the **union** of the listing and the grants: never the listing
 * alone, which would hide a grant whose server has since stopped listing it, and never the grants alone, which would
 * hide the tool a person is being asked to choose.
 */
export function mcpToolRows(view: ConversationMcpView, server: string, listing: McpToolList | undefined): McpToolRow[] {
  const entry = view.servers.find((row) => row.server === server);
  const limit = availabilityLimit(view);
  const granted = new Map(view.grants.filter((grant) => grant.server === server).map((grant) => [grant.tool, grant]));
  const listed = new Map((listing?.tools ?? []).filter((tool) => isRecord(tool) && typeof tool.name === "string").map((tool) => [tool.name, tool]));
  const scope = listing?.scope ?? entry?.scope ?? "global";
  return [...new Set([...listed.keys(), ...granted.keys()])]
    .map((tool) => {
      const described = listed.get(tool);
      const grant = granted.get(tool);
      const descriptorChanged = described !== undefined && grant !== undefined
        && ((described.description ?? "") !== (grant.description ?? "")
          || JSON.stringify(described.inputSchema ?? null) !== JSON.stringify(grant.inputSchema ?? null));
      // Whether the host's file was read at all decides what a missing entry means: with an answer, no entry is the
      // host's own "I have none of that name"; without one, the configured state — and therefore availability — is a
      // question this panel cannot answer, and it says so instead of turning the host's silence into a "no".
      const configUnknown = entry === undefined && !view.serversKnown;
      const available = grant !== undefined && entry !== undefined && entry.enabled && entry.exposure !== "hidden"
        && (described === undefined || described.exposure !== "hidden") && limit === undefined;
      return {
        server,
        scope,
        tool,
        configured: entry !== undefined,
        ...(configUnknown ? { configUnknown: true as const } : {}),
        exposed: described !== undefined,
        ...(described === undefined ? { exposureUnknown: true as const } : {}),
        selected: grant !== undefined,
        // "A call now would resolve", from the four facts and nothing else: this conversation's own grant, the host's
        // entry still existing and being switched on and not hidden, and the conversation's selection and binding.
        // Nobody having pressed List changes none of those, so availability is never withheld for an unasked question —
        // and never claimed for an entry this host switched off or hides, which is what `read` already states without a
        // connect. The host's own `enabled`/`exposure` stay the host's answer at the call; this is the panel's reading
        // of the same two fields, and a call re-checks them whatever is shown here.
        available,
        // A granted tool whose server's configuration could not be read is the one case where availability is unknown
        // rather than false: the grant and the offer are this conversation's own facts, and the missing fact is a file.
        ...(configUnknown && grant !== undefined && limit === undefined ? { availableUnknown: true as const } : {}),
        ...(limit === undefined ? {} : { limitedBy: limit }),
        ...(described?.exposure === "hidden" ? { hidden: true as const } : {}),
        ...(entry !== undefined && !entry.enabled ? { switchedOff: true as const } : {}),
        ...(grant?.schemaOmitted === true ? { schemaOmitted: true as const } : {}),
        ...(descriptorChanged ? { descriptorChanged: true as const } : {}),
        ...(described?.description ?? grant?.description ? { description: described?.description ?? grant?.description } : {}),
        ...(described?.readOnly === true || grant?.readOnly === true ? { readOnly: true as const } : {}),
        ...(typeof described?.exposure === "string" ? { exposure: described.exposure } : {}),
        ...(grant === undefined ? {} : { grantedAt: grant.listedAt }),
        ...(described === undefined || listing === undefined ? {} : { listedAt: listing.listedAt }),
      };
    })
    .sort((left, right) => left.tool.localeCompare(right.tool));
}

/**
 * The four states for one server, counted from the same rows the panel lists.
 *
 * Counting from the rows rather than from the answer keeps a summary from disagreeing with the list beneath it.
 */
export function mcpServerStates(view: ConversationMcpView, server: string, listing: McpToolList | undefined): McpServerStates {
  const rows = mcpToolRows(view, server, listing);
  const entry = view.servers.find((row) => row.server === server);
  const limit = availabilityLimit(view);
  return {
    server,
    scope: entry?.scope ?? listing?.scope ?? view.grants.find((grant) => grant.server === server)?.scope ?? "global",
    configured: entry !== undefined,
    ...(entry === undefined && !view.serversKnown ? { configUnknown: true as const } : {}),
    listed: listing !== undefined,
    exposed: rows.filter((row) => row.exposed).length,
    selected: rows.filter((row) => row.selected).length,
    available: rows.filter((row) => row.available).length,
    ...(rows.some((row) => row.availableUnknown === true) ? { availableUnknown: true as const } : {}),
    ...(limit === undefined ? {} : { limitedBy: limit }),
    ...(entry !== undefined && !entry.enabled ? { switchedOff: true as const } : {}),
  };
}

/** Why nothing this conversation holds can run: its own binding and selection, in the order a person can act on them. */
export function availabilityLimit(view: ConversationMcpView): McpAvailabilityLimit | undefined {
  if (!view.workspaceBound) return "no-workspace";
  if (view.gatewayId === undefined) return "no-gateway";
  if (!view.extensionSelected) return "extension-not-selected";
  return undefined;
}

/**
 * Everything a panel keeps about one conversation, as one plain object.
 *
 * Exported so a check can assert **what browser state is** rather than trust that nothing unwanted was picked: every
 * field is an explicit allowlist, so a host path, a resolved entry value or a credential carried in an unexpected key of
 * the same answer cannot reach the DOM through it. A granted tool's argument schema is absent for the same reason — it
 * is the server's own document, shown nowhere in this panel and sent by nothing in it.
 */
export function mcpPanelState(view: ConversationMcpView): Record<string, unknown> {
  return {
    conversationId: view.conversationId,
    extensionSelected: view.extensionSelected,
    workspaceBound: view.workspaceBound,
    // Whether the host's own configuration read answered, and its named reason when it did not: a panel must be able
    // to say "unknown" where it would otherwise have to say "none", and the seam's own code is what it says it with.
    serversKnown: view.serversKnown,
    ...(view.serversRefusal === undefined ? {} : { serversRefusal: view.serversRefusal.code }),
    ...(view.gatewayId === undefined ? {} : { gatewayId: view.gatewayId }),
    offered: [...view.offered],
    // The four states, per tool, for every server this conversation can be talked about: configured from the host's
    // read, exposed from the listing a person asked for, selected from the grant, available from all three.
    tools: mcpServerBlocks(view).flatMap((block) => mcpToolRows(view, block.server, listingOf(view, block.server)).map((row) => ({
      server: row.server,
      scope: row.scope,
      tool: row.tool,
      configured: row.configured,
      exposed: row.exposed,
      selected: row.selected,
      available: row.available,
      ...(row.configUnknown === undefined ? {} : { configUnknown: true }),
      ...(row.availableUnknown === undefined ? {} : { availableUnknown: true }),
      ...(row.limitedBy === undefined ? {} : { limitedBy: row.limitedBy }),
      ...(row.hidden === undefined ? {} : { hidden: true }),
      ...(row.switchedOff === undefined ? {} : { switchedOff: true }),
      ...(row.descriptorChanged === undefined ? {} : { descriptorChanged: true }),
    }))),
    servers: mcpServerBlocks(view).map((block) => ({
      server: block.server,
      scope: block.scope,
      configured: block.configured,
      ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
      ...(block.configUnknown === undefined ? {} : { configUnknown: true }),
    })),
    grants: view.grants.map((grant) => ({ server: grant.server, tool: grant.tool, scope: grant.scope, listedAt: grant.listedAt })),
    listings: view.listings.map((listing) => ({
      server: listing.server,
      total: listing.total,
      carried: listing.tools.length,
      truncated: listing.truncated,
      listedAt: listing.listedAt,
    })),
  };
}

/**
 * The keys a panel translates a seam code with.
 *
 * 03a and 03b already named every one of these; the panel invents no second status vocabulary and never calls a refused
 * listing an empty one. An unknown code reads as a failure to answer rather than as a named limit, so a person is not
 * told a host refused when it never replied.
 */
export const MCP_SEAM_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  "needs-auth": "mcpTools.refusal.needs-auth",
  "not-authorized": "mcpTools.refusal.not-authorized",
  "server-disabled": "mcpTools.refusal.server-disabled",
  "server-missing": "mcpTools.refusal.server-missing",
  "server-invalid": "mcpTools.refusal.server-invalid",
  "project-untrusted": "mcpTools.refusal.project-untrusted",
  "trust-unreadable": "mcpTools.refusal.trust-unreadable",
  "unknown-workspace": "mcpTools.refusal.unknown-workspace",
  not_listed: "mcpTools.refusal.not-listed",
  offer_unavailable: "mcpTools.refusal.offer-unavailable",
  host_unavailable: "mcpTools.refusal.host-unavailable",
  unavailable_extension: "mcpTools.refusal.unavailable-extension",
  gateway_offline: "mcpTools.refusal.gateway-offline",
  gateway_error: "mcpTools.refusal.gateway-error",
  mcp_unavailable: "mcpTools.refusal.mcp-unavailable",
  mcp_unreachable: "mcpTools.refusal.mcp-unreachable",
  invalid_request: "mcpTools.refusal.invalid-request",
  "invalid-request": "mcpTools.refusal.invalid-request",
  cancelled: "mcpTools.refusal.cancelled",
  timeout: "mcpTools.refusal.timeout",
  protocol_error: "mcpTools.refusal.protocol-error",
  operation_failed: "mcpTools.refusal.operation-failed",
  unsupported: "mcpTools.refusal.unsupported",
};

export function mcpRefusalKey(code: string): string {
  return MCP_SEAM_REFUSAL_KEYS[code] ?? "mcpTools.refusal.operation-failed";
}

/**
 * Whether a refusal is the host's own named answer rather than a failure to answer.
 *
 * It decides the panel's sentence, and nothing else: a named refusal is a fact about a server a person can act on, and
 * an unreachable host or an unreadable answer is a fault to retry — which is why an empty listing and a refused listing
 * are never shown as one state.
 */
export function mcpRefusalIsNamed(refusal: McpSeamRefusal): boolean {
  return refusal.code !== "operation_failed" && refusal.code !== "protocol_error"
    && refusal.code !== "gateway_error" && refusal.code !== "gateway_offline";
}

function seamRefusal(body: unknown, status: number): McpSeamRefusal {
  const answer = (body ?? {}) as { code?: unknown; reason?: unknown; error?: unknown };
  const code = typeof answer.code === "string" ? answer.code : typeof answer.reason === "string" ? answer.reason : "operation_failed";
  return { code, error: typeof answer.error === "string" ? answer.error : "HTTP " + status, status };
}

function isListing(value: unknown): value is McpToolList {
  return isRecord(value) && typeof value.server === "string" && typeof value.listedAt === "number" && Array.isArray(value.tools);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
