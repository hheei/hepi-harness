/**
 * The durable conversation adapter for Gateway MCP tools (ticket 02).
 *
 * Gateway owns an MCP server: its configuration, its credentials, its OAuth state and the process it starts. The backend
 * owns a conversation's tool lifecycle. This module is the seam between them and nothing else — it turns the tools a
 * deployment has declared or a conversation has granted for a conversation into native durable tool registrations, runs one call through the Gateway
 * invocation contract, and lets the runtime commit the result and settle a cancellation through the same lifecycle every
 * other tool uses.
 *
 * **No MCP credential crosses this seam in either direction.** A request carries a server name, a tool name and the
 * model's arguments; the answer carries the server's own masked blocks. Nothing here reads an `mcp.json`, starts a
 * server, resolves a value out of an entry, or holds anything but the gateway binding the backend already had.
 *
 * **Configured, exposed and selected stay three states** (spec principle 2), and this file does not merge them:
 *
 * - What exists on a host is the host's answer at call time. A declared server the folder does not have, is switched
 *   off, is hidden or belongs to a folder no decision trusts settles as the host's own refusal (`server-missing`,
 *   `server-disabled`, `not-exposed`, `not-authorized`) with nothing sent to the server. The backend keeps no parallel
 *   trust store and re-derives nothing, because a second answer to the host's question is a second thing to get wrong.
 * - What a conversation may call is its own `pi.agent.extensions` selection, written through the backend's existing
 *   per-conversation selection seam. Installing this extension offers a model nothing until a conversation selects it,
 *   and (since 03b, with a grant provider composed) selecting it still offers nothing until that conversation is
 *   granted a tool of it.
 *
 * **What a conversation may call is a grant, and a grant is a person's act.** Since 03b the offer is not only the
 * deployment's declaration list: a conversation holds its own granted tools — identity **plus** the descriptor the host
 * published at grant time — in a durable document (`mcp-grants.ts`). This file reads that document twice, at two
 * different moments, for two different questions:
 *
 * - **What a call may run**: `selection` answers the conversation's own grant set at the moment the call executes.
 * - **What is offered and how its arguments are validated**: {@link McpToolBridge.stage} adopts the granted descriptor
 *   as that identity's live registration, so the model is shown the host's own description and its arguments are
 *   validated against the host's own schema **as this conversation's grant recorded them**. Re-granting after the host
 *   changed a schema replaces the registration on the next write — no rebuild, no redeploy, no restart — which is the
 *   only thing that makes a re-grant a repair rather than a note about the past.
 *
 * With a grant provider composed, **every** registration — a declared one and a granted one alike — is `deferred`, the
 * runtime's own "not offered until loaded": the framework then offers a name to exactly the conversations whose
 * `pi.agent.modelTools` states it, and a model-issued call to an unoffered name settles `tool_unavailable` before
 * arguments are prepared and before anything leaves this process. A tool that is registered but no longer granted is not
 * offered either, because the one writer takes the name out of that filter. What a declaration therefore adds to a
 * backend is a descriptor nothing has to ask a host for, never an offer of its own.
 *
 * **The host's answer about its own server is re-read at call time, never here.** Whether a folder is trusted, whether an
 * entry is switched on, whether a tool is exposed, and whether the server still has it are the host's facts, and the host
 * answers them for every call. A grant carries a descriptor only as a presentation snapshot, so a revocation on the host
 * takes effect on the next call with no document changing here.
 *
 * **A call that may have run is never repeated.** The whole rule is `replay: "unsafe"` on the registration below — the
 * runtime's own reading, which settles an interrupted call as `interrupted` instead of running it again. Nothing in this
 * file retries an invocation at any layer, and each uncertain end keeps the words that say the server may have acted.
 */

import { Type, type TSchema } from "@earendil-works/pi-ai";
import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { defineTool, type Extension, type ToolDiagnostic, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";

/**
 * Why this module owns a mutable registration set and a `deferred` flag rather than a per-conversation tool list.
 *
 * pi-durable 1.3.0 resolves a conversation's agent from **the registry snapshot** (`dist/harness/agent.js`
 * `resolveAgent`: `for (const tool of extension.tools ?? []) composed.set(tool.name, tool)`), and what a conversation
 * stores is names only (`dist/harness/types.d.ts` `AgentState`: "Stored choices of one conversation; names, not
 * objects"). So one tool name maps to exactly one registration process-wide: a per-conversation *definition* is not a
 * thing this runtime has. What it does have is `deferred` (offer only when `modelTools` names it) and installing an
 * extension with the same name in place (`dist/harness/registry.js` `install`, README "Installing an extension with an
 * installed name replaces it in place, in one step") — which is how one `hepi.mcp` extension can carry a descriptor
 * that a person re-granted, while every conversation's own `modelTools` still decides which of them it is offered.
 */

import { MCP_INVOKE_MAX_ARGUMENT_BYTES, type McpScope, type McpToolCallOutcome, type McpToolCallRequest, type McpToolCallResult } from "@hepi/protocol/gateway";
import { HostTransportError } from "@hepi/gateway";

/** The one extension every MCP tool is registered by, and the name a conversation selects to be offered any of them. */
export const MCP_EXTENSION = "hepi.mcp";

/** A tool's native name is the host, the server and the tool: two gateways with one server name are two tools. */
export const MCP_TOOL_PREFIX = "mcp__";
/** The longest name a provider accepts. A collision inside it is refused by name, never silently renamed. */
export const MCP_TOOL_NAME_MAX = 64;

/** The tools one server contributes, and the tools one backend installs across every host and server. */
export const MCP_MAX_TOOLS_PER_SERVER = 128;
export const MCP_MAX_TOOLS = 256;
/** The description a declaration left empty still gets, so a model is never offered a tool with nothing to read. */
export const MCP_FALLBACK_DESCRIPTION = "No description provided by the server.";
const MAX_DESCRIPTION_BYTES = 2 * 1024;
/** An argument shape a provider cannot be offered a call for. */
const NON_OBJECT_TYPES = new Set(["array", "string", "number", "integer", "boolean", "null"]);

/** One host's tool, as the deployment declares it: names, a presentation, and the server's own argument schema. */
export type McpToolDeclaration = {
  readonly gatewayId: string;
  readonly scope: McpScope;
  readonly server: string;
  readonly tool: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
};

/**
 * The two identities a call is bound to, both resolved by the backend and neither claimable by a model.
 *
 * The folder is named as this host's own routing id, never as a path: the host resolves a workspace id against the
 * folders it serves, which is what stops one host's folder being read as another's and a caller being able to name a
 * directory it was not given.
 */
export type McpCallTarget = { readonly gatewayId: string; readonly workspaceId: string };

/**
 * The identity of one tool: which host, which configured server, which tool of it. A grant is this plus a presentation,
 * which is why the identity is a type of its own — a description or a schema travels beside a grant and is never part of
 * what authorizes a call.
 */
export type McpToolIdentity = { readonly gatewayId: string; readonly server: string; readonly tool: string };

/**
 * The key a grant and a registration meet on: the tool's native name.
 *
 * This module owns the function rather than each caller spelling a name out, because the writer of an offer and the
 * reader of a call must compute it identically — a name differing by one separator is a grant that silently never takes
 * effect, which is a worse answer than a refusal.
 */
export function mcpGrantKey(identity: McpToolIdentity): string {
  return mcpToolName(identity.gatewayId, identity.server, identity.tool);
}

/**
 * What one conversation may call, as the composition answers it at the moment a call runs.
 *
 * An empty selection is what a conversation that selected no MCP extension, is bound to no execution host, and was
 * granted nothing all answer with: to a call those are the same fact — this tool is not this conversation's to run. It is
 * grouped per server because that is how a surface states a grant and how the host's own refusals arrive.
 */
export type McpSelection = {
  /** The granted tool names of one server. An absent server, or an empty array, grants nothing of it. */
  readonly servers: Readonly<Record<string, readonly string[]>>;
  /**
   * The scope this conversation granted that exact identity in, or `undefined` when it granted none.
   *
   * The scope is answered here rather than taken from the registration because one tool name is one identity: a global
   * entry and a project entry of the same server and tool are the same name, and which file the call must be resolved
   * from is a fact of **this conversation's grant**, not of whichever descriptor this process registered last. It is the
   * whole authority this module asks a conversation about, and the answer is the scope a call is sent with.
   */
  scopeOf(identity: McpToolIdentity): McpScope | undefined;
};

/** The tools one conversation may call, read from its own durable grants at the moment they are needed. */
export type McpSelectionProvider = (conversationId: string, context: Context) => Promise<McpSelection>;

/** The host a call runs on, as the composition answers it. `undefined` is a conversation with no execution host. */
export type McpTargetResolver = (conversationId: string, context: Context) => Promise<McpCallTarget | undefined>;

/** The invocation contract of one configured gateway, taken as this adapter needs it and nothing more. */
export type McpInvoke = (gatewayId: string, request: McpToolCallRequest, options: { readonly signal?: AbortSignal }) => Promise<McpToolCallResult>;

/** Why a declared tool is not installed, named instead of dropped. */
export type McpToolRefusal = { readonly gatewayId: string; readonly server: string; readonly tool: string; readonly reason: string };

/** A declaration this adapter can install: named, bounded, and carrying its own argument schema. */
export type McpUsableTool = {
  readonly gatewayId: string;
  readonly scope: McpScope;
  readonly server: string;
  readonly tool: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: TSchema;
};

/**
 * One tool's native name. It is a pure function of the three names, which is what makes a conversation's selection
 * survive a restart, a redeploy of the same declaration, and a re-read of the same host.
 *
 * The alphabet is the one a provider accepts for a function name, and the segments are joined inside it too, so nothing
 * outside it can ever reach a request.
 */
export function mcpToolName(gatewayId: string, server: string, tool: string): string {
  return (MCP_TOOL_PREFIX + [gatewayId, server, tool].map(safe).join("__")).slice(0, MCP_TOOL_NAME_MAX);
}

/**
 * The part of a name a path or an odd server name cannot contribute.
 *
 * Anything outside the provider alphabet is replaced rather than refused, because a server named `web.search` and one
 * named `web search` are the same one tool. Two names that meet after replacement collide, which is refused by name.
 */
function safe(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The whole offer of one deployment's declarations: every usable tool, and every refusal by name.
 *
 * A schema this process cannot carry is refused, not offered as an empty object: a tool whose arguments are silently
 * unvalidated would be a tool a model is invited to call with anything. A non-object argument shape cannot be called
 * through a provider at all, so it is refused for the same reason.
 */
export function mcpUsableTools(declarations: readonly McpToolDeclaration[]): { readonly usable: readonly McpUsableTool[]; readonly refused: readonly McpToolRefusal[] } {
  const usable: McpUsableTool[] = [];
  const refused: McpToolRefusal[] = [];
  const taken = new Map<string, McpUsableTool>();
  const collided = new Set<string>();
  const perServer = new Map<string, number>();
  const serverOf = (declaration: McpToolDeclaration) => declaration.gatewayId + "__" + declaration.server;
  for (const declaration of declarations) {
    const serverKey = serverOf(declaration);
    if ((perServer.get(serverKey) ?? 0) >= MCP_MAX_TOOLS_PER_SERVER) {
      refused.push({ gatewayId: declaration.gatewayId, server: declaration.server, tool: declaration.tool, reason: "server " + declaration.server + " declares more than " + MCP_MAX_TOOLS_PER_SERVER + " tools" });
      continue;
    }
    if (usable.length >= MCP_MAX_TOOLS) {
      refused.push({ gatewayId: declaration.gatewayId, server: declaration.server, tool: declaration.tool, reason: "this backend installs no more than " + MCP_MAX_TOOLS + " MCP tools" });
      continue;
    }
    const name = mcpToolName(declaration.gatewayId, declaration.server, declaration.tool);
    if (collided.has(name)) {
      refused.push({ gatewayId: declaration.gatewayId, server: declaration.server, tool: declaration.tool, reason: "its name " + name + " is claimed by another declared tool" });
      continue;
    }
    const clash = taken.get(name);
    if (clash !== undefined) {
      // The name is what a model calls, so two tools cannot be offered under one. Both are refused, the name is marked
      // claimed, and the words say which two: which host was meant is not this process's to guess.
      collided.add(name);
      taken.delete(name);
      usable.splice(usable.indexOf(clash), 1);
      refused.push({ gatewayId: clash.gatewayId, server: clash.server, tool: clash.tool, reason: "its name " + name + " collides with " + declaration.gatewayId + "/" + declaration.server + "/" + declaration.tool });
      refused.push({ gatewayId: declaration.gatewayId, server: declaration.server, tool: declaration.tool, reason: "its name " + name + " collides with " + clash.gatewayId + "/" + clash.server + "/" + clash.tool });
      continue;
    }
    const parameters = mcpParametersOf(declaration.inputSchema);
    if ("error" in parameters) {
      refused.push({ gatewayId: declaration.gatewayId, server: declaration.server, tool: declaration.tool, reason: parameters.error });
      continue;
    }
    const description = bounded(typeof declaration.description === "string" ? declaration.description : "");
    const tool: McpUsableTool = { gatewayId: declaration.gatewayId, scope: declaration.scope, server: declaration.server, tool: declaration.tool, name, description: description === "" ? MCP_FALLBACK_DESCRIPTION : description, parameters };
    taken.set(name, tool);
    usable.push(tool);
    // The count moves only for a tool that installed: one entry this process refused must not make the next valid entry
    // of the same server read as the one that passed a bound.
    perServer.set(serverKey, (perServer.get(serverKey) ?? 0) + 1);
  }
  return { usable, refused };
}

/**
 * One conversation's granted tool, as its durable grant states it: the identity plus the descriptor the host published
 * at grant time. This is the offer's own input — the description a model reads and the argument shape its call is
 * validated against — and never a second answer about the host's server.
 *
 * `listedAt` is the moment the host published that descriptor. It decides which of two conversations' grants of the
 * same identity this process registers, because a tool name holds exactly one registration in a runtime registry
 * (§"why this module owns a mutable registration set" above): the newest read of that identity wins, and every
 * conversation's own grant document still states the descriptor it was granted.
 */
export type McpGrantedTool = McpToolIdentity & {
  readonly scope: McpScope;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly listedAt?: number;
};

/** A granted descriptor converted to the vocabulary an offer is built from. */
function grantDeclaration(grant: McpGrantedTool): McpToolDeclaration {
  return {
    gatewayId: grant.gatewayId,
    scope: grant.scope,
    server: grant.server,
    tool: grant.tool,
    ...(grant.description === undefined ? {} : { description: grant.description }),
    ...(grant.inputSchema === undefined ? {} : { inputSchema: grant.inputSchema }),
  };
}

/** One server's own argument schema, as a schema this process can hold — or the reason it cannot. */
function mcpParametersOf(inputSchema: unknown): TSchema | { readonly error: string } {
  if (inputSchema === undefined) return Type.Object({});
  if (inputSchema === null || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return { error: "its input schema is not an object" };
  const source = inputSchema as Record<string, unknown>;
  if (typeof source.type === "string" && NON_OBJECT_TYPES.has(source.type)) return { error: "its input schema is of type " + source.type + ", which is not an argument object" };
  let text: string;
  try {
    text = JSON.stringify(source);
  } catch {
    return { error: "its input schema is not JSON" };
  }
  if (Buffer.byteLength(text, "utf8") > MCP_INVOKE_MAX_ARGUMENT_BYTES) return { error: "its input schema is larger than the " + MCP_INVOKE_MAX_ARGUMENT_BYTES + " bytes one call may carry" };
  // The schema is the server's own and is carried verbatim: `Type.Unsafe` is the only way to hold a schema this process
  // did not author, and the runtime compiles it and validates the model's arguments against it before anything is sent.
  return Type.Unsafe<Record<string, unknown>>({ ...(JSON.parse(text) as Record<string, unknown>), type: "object", properties: source.properties ?? {} });
}

/** A description cut to what one conversation should carry of it, at a UTF-8 boundary. */
function bounded(description: string): string {
  if (Buffer.byteLength(description, "utf8") <= MAX_DESCRIPTION_BYTES) return description;
  return Buffer.from(description, "utf8").subarray(0, MAX_DESCRIPTION_BYTES).toString("utf8").replace(/\uFFFD+$/, "") + "…";
}

/** What one call needs from the backend: the host it runs on, the contract that reaches it, and its grants. */
export type McpToolBridgeOptions = {
  /**
   * The operator's fallback declarations (`HEPI_MCP_TOOLS`): identities and presentation this deployment states without
   * asking a host. Since 03b this is a **fallback, not a ceiling**: it seeds the presentation of a tool a person grants,
   * and it is the only source a deployment has when it declares tools its host cannot be asked about. A tool a host
   * lists that no declaration names is grantable anyway, because the grant's own descriptor is what the offer is built
   * from. An unset `HEPI_MCP_TOOLS` therefore declares no fallback and disables nothing.
   */
  readonly declarations: readonly McpToolDeclaration[];
  /** The execution host one conversation is bound to, read from the conversation's own durable binding. */
  readonly target: McpTargetResolver;
  /** One call on one configured gateway. A lost answer is thrown, exactly as the transport classified it. */
  readonly invoke: McpInvoke;
  /**
   * What one conversation was granted, read now rather than at install: a grant written after this tool registered is
   * granted to this call, and one revoked after it is not. Passing one is what makes every registration `deferred`, so
   * the conversation's own `pi.agent.modelTools` is what offers it; absent keeps ticket 02's behaviour — a selected
   * extension offers every tool it holds at once, which is what a composition with no grant document (a crash-replay
   * test's own stub) needs to stay meaningful.
   */
  readonly selection?: McpSelectionProvider;
  /** Reports an installation refusal, so nothing is dropped silently. Defaults to the backend's own startup report. */
  readonly diagnostics?: (message: string) => void;
};

/** The bridge: the extension it installs, what it refused to install, and what a grant can attach to. */
export type McpToolBridge = {
  /**
   * The one extension every MCP tool is registered by. It is optional: no conversation is offered one until it selects
   * it, and with a selection provider every tool it holds is `deferred`, so being selected offers nothing by itself.
   *
   * Its `tools` are read fresh whenever the runtime resolves a conversation's agent (pi-durable
   * `dist/harness/agent.js` `resolveAgent` iterates `extension.tools`), rebuilt only when a grant changed a descriptor.
   * That is what makes a granted descriptor the live offer rather than a note about the past, with no registry churn
   * and no reinstall per conversation.
   */
  readonly extension: Extension & { readonly tools?: readonly ToolRegistration[] };
  /** The identities this process refused to register, and the reason each was. */
  readonly refused: () => readonly McpToolRefusal[];
  /**
   * Whether these granted descriptors could be registered, asked before anything is written.
   *
   * A grant is committed with the offer it states, so the one thing that must not happen is a grant that this process
   * cannot register: a person would be told the grant was made and then be offered nothing. The bound is the same one
   * {@link mcpUsableTools} applies, asked over the set the write would produce, and the answer names the tool so the
   * refusal can say which one.
   */
  admits(entries: readonly McpGrantedTool[]): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /**
   * Take one conversation's granted descriptors as this process's live presentation for those identities.
   *
   * Called wherever the backend reads a conversation's grants for its own sake — the one adoption point every
   * conversation passes through (boot, create, fork) and the grant write — so the registrations a request is resolved
   * from are built from the descriptors the durable grants hold, not from the environment this process started with.
   * A re-grant of a schema the host changed replaces it here, on the next resolution; a restarted backend restores the
   * same registrations from its store without asking a host anything.
   */
  stage(grants: readonly McpGrantedTool[]): void;
};

/**
 * Compose one backend's MCP bridge: the operator's fallback declarations, the host each call runs on, the invocation
 * contract, and the conversation grants whose descriptors become the live registrations.
 *
 * The registrations are conversation-independent — a tool's identity is its host, server and name — and what is per
 * conversation is resolved at the moment a call runs: the conversation's own workspace binding, and its own grants. A
 * tool that reaches no host is refused there with the claim that nothing was sent, which is the one statement this
 * process is entitled to make; a tool its conversation was not granted is refused before that, with nothing sent.
 *
 * A granted identity replaces the declared entry of the same identity rather than joining it, because one name cannot
 * be offered twice; a new identity is appended, in the order it was first staged. The bounds in
 * {@link mcpUsableTools} apply to the whole set, so an identity this process cannot register is refused by name.
 */
export function createMcpToolBridge(options: McpToolBridgeOptions): McpToolBridge {
  const report = options.diagnostics ?? ((message: string) => console.error(message));
  const host: McpToolHost = {
    target: options.target,
    invoke: options.invoke,
    deferred: options.selection !== undefined,
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  };
  /** The identities a grant stated, newest descriptor per name. */
  const granted = new Map<string, McpGrantedTool>();
  /** The live registrations and the refusals that go with them, replaced only when a descriptor changed. */
  let current: { readonly tools: readonly ToolRegistration[]; readonly refused: readonly McpToolRefusal[] } = build(new Set());

  /**
   * The declarations one registration set is built from: every granted descriptor first, then the operator's fallback.
   *
   * **Grants go first, and that ordering is the whole capacity rule.** A bound in {@link mcpUsableTools} cuts from the
   * end, so a deployment whose fallback names a whole server's worth of tools would otherwise take the room a person's
   * grant needed and silently leave a listed tool unoffered — the grant would be durable and its tool absent, which is
   * the one disagreement this module exists to prevent. A granted identity replaces the declared entry of the same
   * identity rather than joining it, because one name cannot be offered with two shapes.
   */
  function registrationList(grants: Iterable<McpGrantedTool>): McpToolDeclaration[] {
    const list: McpToolDeclaration[] = [];
    const claimed = new Set<string>();
    for (const grant of grants) {
      const key = mcpGrantKey(grant);
      if (claimed.has(key)) continue;
      claimed.add(key);
      list.push(grantDeclaration(grant));
    }
    for (const declaration of options.declarations) if (!claimed.has(mcpGrantKey(declaration))) list.push(declaration);
    return list;
  }

  /**
   * Build the registrations from every granted descriptor plus the operator's fallback.
   *
   * `knownRefusals` names what was already reported, so a refusal is stated once rather than on every conversation that
   * holds the grant.
   */
  function build(knownRefusals: ReadonlySet<string>) {
    const built = mcpUsableTools(registrationList(granted.values()));
    for (const dropped of built.refused) {
      if (knownRefusals.has(mcpGrantKey(dropped))) continue;
      // A granted identity this process cannot register is stated, never dropped quietly: a conversation would hold a
      // durable grant for a tool nothing offers, which is the operator's to see rather than a silent absence.
      report((granted.has(mcpGrantKey(dropped)) ? "granted MCP tool " : "MCP tool ") + dropped.gatewayId + "/" + dropped.server + "/" + dropped.tool + " is not offered: " + dropped.reason);
    }
    return { tools: built.usable.map(tool => mcpToolRegistration(tool, host)), refused: built.refused };
  }

  return {
    // One installed object, whose `tools` the runtime re-reads at every resolution: that is what lets a re-granted
    // descriptor become the live offer without touching the registry, which every other conversation resolves against.
    extension: { name: MCP_EXTENSION, get tools() { return current.tools; } } as Extension,
    refused: () => current.refused,
    /**
     * The registrations these grants would produce, asked without staging them.
     *
     * The candidate set is the one a stage of these entries would leave behind — this conversation's entries replacing
     * whatever of their identities is held now, everything else kept — so the answer is about the set the write actually
     * produces rather than about the request's own list.
     */
    admits(entries: readonly McpGrantedTool[]): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
      const candidate = new Map(granted);
      for (const entry of entries) candidate.set(mcpGrantKey(entry), entry);
      const refused = mcpUsableTools(registrationList(candidate.values())).refused.find(dropped => entries.some(entry => mcpGrantKey(entry) === mcpGrantKey(dropped)));
      return refused === undefined ? { ok: true } : { ok: false, reason: refused.reason };
    },
    stage(entries: readonly McpGrantedTool[]): void {
      let changed = false;
      for (const entry of entries) {
        const key = mcpGrantKey(entry);
        const held = granted.get(key);
        // Newest read wins, and an equal reading replaces: two conversations of one host that read the same server get
        // the same live descriptor whichever grant was staged second, rather than one of them keeping an older schema
        // because it attached first.
        if (held !== undefined && (entry.listedAt ?? 0) < (held.listedAt ?? 0)) continue;
        // The descriptor is replaced when anything a call reads has changed — including its **scope**, because a global
        // and a project entry of one identity are two different servers. The moment is always kept: a descriptor that
        // reads the same but was published later is newer evidence, and a later stage of an older one must not overwrite
        // it, so the held entry carries the newest `listedAt` even when nothing is rebuilt.
        if (held !== undefined && held.scope === entry.scope && held.description === entry.description && JSON.stringify(held.inputSchema) === JSON.stringify(entry.inputSchema)) {
          if ((entry.listedAt ?? 0) > (held.listedAt ?? 0)) granted.set(key, { ...held, listedAt: entry.listedAt });
          continue;
        }
        granted.set(key, entry);
        changed = true;
      }
      if (!changed) return;
      current = build(new Set(current.refused.map(refused => mcpGrantKey(refused))));
    },
  };
}

/** One host, one invocation contract, and one conversation's grants — what a call needs to reach the right server. */
type McpToolHost = {
  readonly target: McpTargetResolver;
  readonly invoke: McpInvoke;
  /** Present when the composition grants per conversation: a call without a grant is refused here, before anything leaves. */
  readonly selection?: McpSelectionProvider;
  /** Whether this registration is deferred, which is what makes the runtime's offer the grant list. */
  readonly deferred: boolean;
};

/**
 * One tool, as the runtime holds it.
 *
 * **The replay rule, stated once where the runtime reads it.** `replay: "unsafe"` is the runtime's own default, and it
 * is what preserves the approved restart semantics: after a crash an interrupted call is settled as `interrupted` and
 * is never rerun, so an external side effect the host may have performed is not silently performed twice. Everything
 * else here is presentation; this is the guarantee, and it is the first thing to check in any change to this file.
 *
 * **Selection is two levels, and both are the framework's own state.** A conversation is offered none of these tools
 * until its own `pi.agent.extensions` names {@link MCP_EXTENSION} — the coarse switch ticket 02 shipped, written through
 * the backend's existing selection seam and never re-read against a later default. Since 03b a second level sits inside
 * it: with a selection provider composed, every registration is `deferred`, so the runtime offers a tool only when the
 * conversation's own `pi.agent.modelTools` names it, and that filter is written from the conversation's grants by one
 * backend writer. Neither level is a second answer to the host: what the host exposes, switches on and trusts is still
 * the host's decision at the call.
 *
 * **`callers: ["model"]` keeps the seam one-way.** A script or a nested tool caller does not reach an external side
 * effect through the registry: the conversation's own selection is what authorizes a call, and only the model's turn
 * carries that.
 *
 * **One conversation runs one MCP call at a time.** `executionMode: "sequential"` is the runtime's own bound for that
 * (pi-durable `dist/harness/generation.js`: a round containing an offered sequential call starts its calls one after
 * another, in call order, instead of all at once). It is the smallest statement of ticket 04's per-conversation bound and
 * the only one that needs no state in this process: the host bounds how many calls it **runs** (8, across every
 * conversation), so without a per-conversation bound one model asking for eight tools in one round would hold every slot
 * on the gateway and every other conversation's call would be refused `busy` until it finished. The bound lives in the
 * runtime's own round, so two conversations still run at once, and a round that mixes an MCP call with ordinary tools
 * runs in call order — a slower turn, and the price of keeping one conversation's calls from overlapping at the host.
 *
 * **A grant is checked again inside the call, and not only by the offer.** The runtime resolves a model-issued call
 * against the conversation's offer, so an ungranted deferred name settles `tool_unavailable` before this body runs, and
 * the check here is what keeps that true for a conversation whose grants changed between the turn's start and this call —
 * a revocation is answered by the next call either way, and by these words when the call is already in the body. The two
 * answers name the same boundary, so neither one is a hole the other has to paper over.
 */
function mcpToolRegistration(tool: McpUsableTool, host: McpToolHost): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description + " (MCP server " + tool.server + " on gateway " + tool.gatewayId + ")",
    parameters: tool.parameters,
    replay: "unsafe",
    callers: ["model"],
    executionMode: "sequential",
    deferred: host.deferred ? true : undefined,
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      // The grant is read now, not at install, and it is the conversation's own durable state: a tool revoked after this
      // registration was built is not this call's to run, and one granted a moment ago is. Nothing is sent for it — the
      // refusal is made before the host is even resolved, because a grant a conversation does not hold is not a question
      // to ask another machine.
      // The conversation's grant answers **which scope** this call is resolved in, not only whether it may run. One tool
      // name is one identity across both of the host's config files, so a registration built from whichever descriptor
      // this process staged last cannot say which entry this conversation meant: a project grant would be sent as
      // `global`, and a later project descriptor elsewhere would send a global grant as `project`. The grant is the
      // record a person wrote, so it is what the request states.
      const selection = host.selection === undefined ? undefined : await host.selection(String(api.conversationId), context);
      const grantedScope = selection === undefined ? undefined : selection.scopeOf(tool);
      if (selection !== undefined && grantedScope === undefined) {
        return refusal("not_granted", "this conversation was not granted " + tool.server + "/" + tool.tool + ", so nothing was sent to the server");
      }
      // The host is the conversation's own fact, read now rather than at install: a binding written after this tool was
      // registered is still the host this call runs on, and a conversation bound to nothing has no host to run on.
      const target = await host.target(String(api.conversationId), context);
      if (target === undefined || target.gatewayId !== tool.gatewayId) {
        return refusal("host_unavailable", "this conversation is bound to no execution host named " + tool.gatewayId + ", so nothing was sent to the server");
      }
      // The identity of the call is the runtime's, never the model's: the host echoes it, so a repeat of the same call
      // is recognizable to it rather than a second anonymous one, and no caller can address another conversation's work.
      // No `deadlineMs` is sent: the host's own default is the host's policy, not this caller's to override.
      const request: McpToolCallRequest = {
        operation: "invoke",
        callId: api.callId,
        conversationId: String(api.conversationId),
        workspaceId: target.workspaceId,
        scope: grantedScope ?? tool.scope,
        server: tool.server,
        tool: tool.tool,
        arguments: args as Record<string, unknown>,
      };
      const signal = context.abortSignal;
      let answer: McpToolCallResult;
      try {
        // The caller's cancellation is handed to the transport, which ends the host request with it. The host's own
        // deadline still bounds the call. Neither is retried here, or by the transport, or by the runtime.
        answer = await host.invoke(target.gatewayId, request, signal === undefined ? {} : { signal });
      } catch (error) {
        // The answer never arrived. The transport already classified that, and only it can say which ways it is
        // uncertain: a gateway that was never reached and a rejected credential ran nothing, and a connection that was
        // lost after the request was admitted may not have.
        if (error instanceof HostTransportError) return refusal(error.code, error.message + (UNCERTAIN_TRANSPORT.has(error.code) ? UNCERTAIN_SUFFIX : ""));
        return refusal("operation_failed", "the MCP host call failed: " + (error instanceof Error ? error.message : String(error)) + UNCERTAIN_SUFFIX);
      }
      return mcpSettle(answer, tool);
    },
  });
}

/** The claim every uncertain end carries, stated once, because it is the reason nothing here retries. */
const UNCERTAIN_SUFFIX = " Nothing is repeated for a call whose outcome is unknown.";

/**
 * The transport's classifications that leave a call's outcome unknown: the request was admitted, or this process
 * cannot say it was not. `gateway_offline` and `unauthorized` are absent, because both answer before any server ran.
 */
const UNCERTAIN_TRANSPORT: ReadonlySet<string> = new Set(["outcome_unknown", "timeout", "aborted", "protocol_error"]);

/**
 * One call's answer, on the runtime's own channels: the server's blocks for the model, the host's facts as structured
 * output and details, and every failure as a diagnostic named by the code that says what it means.
 *
 * A tool that reported its own failure is still an answer about the call, not a transport failure: `isError` and the
 * server's own masked text are recorded, and nothing is inferred about whether the server acted.
 */
export function mcpSettle(answer: McpToolCallResult, tool: McpUsableTool): ToolExecutionResult {
  if (!answer.ok) {
    // The host's own code is kept: `timeout` and `cancelled` are already the words that say the server may have acted,
    // and a refusal that says nothing ran (`server-missing`, `not-exposed`, `busy`) stays that refusal.
    const uncertain = answer.code === "timeout" || answer.code === "cancelled";
    return refusal(answer.code.replace(/-/g, "_"), answer.message + (uncertain ? UNCERTAIN_SUFFIX : ""));
  }
  const outcome: McpToolCallOutcome = answer.value;
  const blocks = outcome.content.map(block => block.type === "text" ? { type: "text" as const, text: block.text } : { type: "image" as const, data: block.data, mimeType: block.mimeType });
  const output = blocks.length === 0 ? [{ type: "text" as const, text: "(the tool returned no content)" }] : blocks;
  // The host's facts ride the durable entry's own details channel. There is deliberately no `structuredOutput`: the
  // runtime refuses one for a tool that declares no schema, and a tool whose argument schema came from a server has no
  // schema of its own to declare here — programs get the result's bounded output, which is the server's answer.
  const details = copyJson({ callId: outcome.callId, gatewayId: tool.gatewayId, server: outcome.server, tool: outcome.tool, isError: outcome.isError, truncated: outcome.truncated, durationMs: outcome.durationMs }, { omitUndefinedProperties: true });
  const diagnostics: ToolDiagnostic[] = [];
  if (outcome.isError) diagnostics.push({ severity: "error", code: "tool_error", message: "tool_error: the tool reported a failure of its own" });
  if (outcome.truncated) diagnostics.push({ severity: "warn", code: "truncated", message: "truncated: the result exceeded the host's output bound and was cut to it" });
  return { output, isError: outcome.isError, details, ...(diagnostics.length === 0 ? {} : { diagnostics }) };
}

/**
 * A failure the model can act on. The code is in the message as well as the diagnostic, because the durable entry
 * carries the rendered diagnostics to the model and nothing else of the diagnostic: a refusal that only says "it
 * failed" is a refusal a model has to guess about, and guessing is what leads to a repeat.
 */
function refusal(code: string, message: string): ToolExecutionResult {
  const text = code + ": " + message;
  return { output: [{ type: "text", text: message }], isError: true, diagnostics: [{ severity: "error", code, message: text }] };
}
