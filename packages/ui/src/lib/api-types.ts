import type {
  CodemodeInlineBudgetSetting,
  CodemodeModeSetting,
  McpCodemodePreference,
  McpScope,
} from "@hepi/protocol/mcp-ui";
import type { McpToolList } from "@hepi/protocol/gateway";

/**
 * The shapes the Web workbench reads from its own client API, and nothing else: Settings › Tools, the app update, the
 * extension catalogue and one conversation's MCP seam.
 *
 * The MCP panel's contract is not here. It is declared in `@hepi/protocol/mcp-ui` because the gateway answers those
 * routes and the browser renders the answer, and every surface that needs one imports it from there.
 */

export interface ToolSettingsResponse {
  isWindows: boolean;
  powerShellEnabled: boolean;
  /** "always" when the global defaultTools starts sessions with codemode active (ADR 0006). */
  codemode: McpCodemodePreference;
  /** The global `codemode.mode`. */
  codemodeMode: CodemodeModeSetting;
  /** The global `codemode.inlineBudget`. */
  codemodeInlineBudget: CodemodeInlineBudgetSetting;
}

// ---------------------------------------------------------------------------
// Settings › MCP (ADR 0006). Every refusal carries `{ error, reason }`: `error`
// is an English diagnostic, `reason` a code the panel translates.
// ---------------------------------------------------------------------------

export interface AppUpdateResponse {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

/**
 * One durable extension as `GET /api/extensions` reports it: the name it is selected by, the tools and prompt
 * sections it would add, and whether the resolved global default currently selects it. The set comes from the
 * backend's own registry, so it is exactly what a conversation can be offered.
 */
export interface DurableExtension {
  name: string;
  tools: string[];
  sections: string[];
  enabled: boolean;
}

/** One extension the runtime refused to install at startup, with its own reason, so a broken one is named. */
export interface DurableExtensionFailure {
  name: string;
  message: string;
}

export interface DurableExtensionsResponse {
  protocol: string;
  installed: DurableExtension[];
  /** The resolved global default: what a conversation created after a change selects. */
  default: string[];
  failures: DurableExtensionFailure[];
}

/** `PATCH /api/conversations/<id>/extensions`: the selection that conversation now holds and the tools it offers. */
export interface DurableConversationExtensionsResponse {
  protocol: string;
  conversationId: string;
  extensions: string[];
  toolNames: string[];
}
/**
 * One server this conversation's **host** has an entry for, as the seam's configuration read states it.
 *
 * The backend asks the host to read its own `mcp.json` files and connects nothing, which is what makes this the
 * `configured` state of ticket 03c: a server named here exists on the host whether or not anyone listed it, granted
 * it or ran it. No value the entry holds travels with it — no command, argument, environment value, URL, header or
 * path — because the host's read reports an entry's shape and never its secrets.
 */
export interface ConversationMcpServer {
  server: string;
  scope: McpScope;
  /** The host's own `enabled`, re-read at every call; a switched-off server lists nothing and runs nothing. */
  enabled: boolean;
  /** The entry's `exposure` as written, when it names one the SDK accepts. */
  exposure?: string;
}

/**
 * One granted tool: the identity a person chose, plus the descriptor the host published at that moment.
 *
 * The descriptor is a **presentation snapshot and never an authority** (ticket 03b): the host re-resolves trust,
 * exposure and the tool's own existence on every call, so a stale description here is a stale sentence rather than a
 * stale permission. It carries no configuration value and no credential, and the seam refuses a request that names
 * one by name before it writes anything.
 */
export interface ConversationMcpGrant {
  gatewayId: string;
  scope: McpScope;
  server: string;
  tool: string;
  description?: string;
  /** The server's own argument shape at grant time. Absent with `schemaOmitted`: the host withheld it. */
  inputSchema?: unknown;
  readOnly?: true;
  schemaOmitted?: true;
  listedAt: number;
}

/**
 * One conversation's MCP state, as `GET|PATCH /api/conversations/<id>/extensions` answers it (tickets 03b, 03c).
 *
 * Four separate facts, deliberately not collapsed into one status: `servers` is what the **host** configures, the
 * `listed` tools are what that host **exposes** for one named server when a person asked, `grants` is what this
 * conversation **selected**, and `offered` is what the runtime resolves for it right now. An ordinary read asks no host
 * to connect anything, which is why `listed` is absent until the explicit `?mcp=<server>` request was made.
 */
export interface ConversationMcpState {
  conversationId: string;
  workspaceId: string | null;
  /** Absent when the conversation's workspace resolves to no gateway, which is why nothing of it can run. */
  gatewayId?: string;
  /** Whether this conversation selects `hepi.mcp` at all. Selecting it grants nothing by itself. */
  selected: boolean;
  servers: ConversationMcpServer[];
  /**
   * Whether the host actually answered the configuration read.
   *
   * `false` is "this process was never told", which is a different sentence from an empty `servers`: a host that is
   * offline, a gateway this deployment does not configure or an answer that was not a read states no configuration
   * **and says so**, so a surface never presents an unread file as a host that configures nothing. The grants are
   * unaffected either way, which is what keeps a conversation's own choices visible and revocable while its host is away.
   */
  serversKnown: boolean;
  /** Why the configuration read answered nothing, when `serversKnown` is false. The seam's own code and words. */
  serversRefusal?: { code: string; error: string };
  grants: ConversationMcpGrant[];
  /** The offered MCP tool names, as the runtime's own resolution states them. */
  offered: string[];
  /** The one server a person just asked about, answered by the server's own host. */
  listed?: McpToolList;
}

/** The seam's answer with one conversation's MCP state in it: the selection read and both writes' answers. */
export interface ConversationMcpResponse extends DurableConversationExtensionsResponse {
  mcp: ConversationMcpState;
}
