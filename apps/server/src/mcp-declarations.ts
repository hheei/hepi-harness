/**
 * The deployment's MCP tool declarations, read from its environment (ticket 02's composition half).
 *
 * Since 03b this is the **operator's fallback**, not a ceiling. What a conversation may be granted comes from the host's
 * own listing — `operation: "tools"`, one named server's descriptors, bounded and masked
 * ([MCP on the Web host](../../../docs/mcp-on-the-web-host.md#listing-one-servers-tools-ticket-03a)) — and what it is
 * offered comes from that conversation's own grant. This file states identities and presentation a backend can offer
 * without asking a host anything, for a deployment that would rather declare them than list them; a declared tool the
 * host does not actually have is not a callable one, and the host refuses the call by name (`unknown-tool`), which is the
 * honest answer and needs no second authority here.
 *
 * What a declaration names is an **identity and a presentation**: a gateway id, a scope, a server, a tool, an optional
 * description, an optional argument schema. It never carries a command, an argument list, a URL, an environment value or
 * a credential — those stay in the host's own `mcp.json`, which this process does not read. A declaration that tried to
 * carry one is refused at startup rather than passed on, so the shape of the file can never become a way to have the
 * host run something nobody selected.
 *
 * A bad declaration is a startup failure, not a silent absence: a deployment that means to offer three tools and gets
 * one because a bracket was misplaced has a wrong belief about its own conversation, and the reason is printed once,
 * naming the entry.
 */

import { MCP_MAX_TOOLS, type McpToolDeclaration } from "./mcp-conversation-tools.ts";

/** The backend's one MCP declaration variable, a JSON array of the entries {@link parseMcpToolDeclarations} accepts. */
export const MCP_TOOLS_ENV = "HEPI_MCP_TOOLS";

/**
 * The keys a host owns, refused by name wherever this process could be handed one.
 *
 * They are the fields of the host's own `mcp.json` entry, of the invocation request this process may never build, and of
 * the credential a signed-in server holds. Naming one is a mistake about who owns what, so it is refused where it is
 * written rather than silently dropped: a declaration or a grant that lost its `command` would leave someone believing
 * they had configured a server. Both paths in this package refuse the same list — here for the deployment's fallback at
 * startup, and in `mcp-grants.ts` for a conversation's grant request — and the host refuses them again on its own route
 * (`packages/gateway/src/mcp/invocation.ts`), so this list is a boundary convenience, never the only thing standing
 * between a request body and a command.
 */
export const MCP_HOST_CONFIGURATION_KEYS = ["command", "args", "env", "url", "headers", "auth", "config", "cwd", "workspaceId", "token"] as const;

/**
 * Parse and validate the declared tools. `undefined` (or blank) means this backend declares no fallback: the extension
 * is still installed whenever a gateway is configured, and every tool a conversation is then offered came from a grant.
 *
 * `knownGatewayIds` is the deployment's own configured gateway list, and it is a boundary rather than a convenience: a
 * declaration naming a host this process cannot reach would install a tool that always fails at the call, which is a
 * worse answer than a startup that says the host was never configured.
 */
export function parseMcpToolDeclarations(raw: string | undefined, knownGatewayIds: readonly string[]): readonly McpToolDeclaration[] {
  if (raw === undefined || raw.trim() === "") return [];
  // A parse failure's own message quotes the offending text, and an operator pastes server configuration into this
  // variable, so the input is never echoed: the reason is stated as a fixed message.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(MCP_TOOLS_ENV + " is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error(MCP_TOOLS_ENV + " must be a JSON array of { gatewayId, scope, server, tool, description?, inputSchema? }");
  const known = new Set(knownGatewayIds);
  const declared = parsed.map((entry, index) => declarationOf(entry, index, known));
  // The install bounds belong to the adapter that enforces them; stating them here turns a silent drop into a startup
  // failure, which is the same rule the rest of this file follows.
  if (declared.length > MCP_MAX_TOOLS) throw new Error(MCP_TOOLS_ENV + " declares " + declared.length + " tools, and one backend installs no more than " + MCP_MAX_TOOLS);
  return declared;
}

/** One entry, or the reason this deployment does not start with it. */
function declarationOf(entry: unknown, index: number, known: ReadonlySet<string>): McpToolDeclaration {
  const at = MCP_TOOLS_ENV + " entry " + index;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(at + " must be an object with a string gatewayId, scope, server and tool");
  const value = entry as Record<string, unknown>;
  for (const field of ["gatewayId", "server", "tool"] as const) {
    if (typeof value[field] !== "string" || (value[field] as string).trim() === "") throw new Error(at + " needs a non-empty string " + field);
  }
  if (value.scope !== "global" && value.scope !== "project") throw new Error(at + " scope must be \"global\" or \"project\"");
  if (value.description !== undefined && typeof value.description !== "string") throw new Error(at + " description must be a string");
  if (value.inputSchema !== undefined && (typeof value.inputSchema !== "object" || value.inputSchema === null || Array.isArray(value.inputSchema))) {
    throw new Error(at + " inputSchema must be a JSON object");
  }
  // The configuration fields exist on the host's own entry and on the invocation request the backend may never build:
  // naming one here is a mistake about who owns what, so it is refused where it is written.
  for (const field of MCP_HOST_CONFIGURATION_KEYS) {
    if (value[field] !== undefined) throw new Error(at + " carries " + field + ", which the host owns: an MCP tool declaration names a gateway, a scope, a server and a tool");
  }
  const gatewayId = (value.gatewayId as string).trim();
  if (!known.has(gatewayId)) throw new Error(at + " names gateway " + gatewayId + ", which this backend does not configure");
  const scope = value.scope as "global" | "project";
  const server = (value.server as string).trim();
  const tool = (value.tool as string).trim();
  const description = value.description as string | undefined;
  const inputSchema = value.inputSchema;
  // Only the fields that are present are carried, so an absent description stays absent and the adapter's own fallback
  // is what a model reads rather than an empty string.
  return { gatewayId, scope, server, tool, ...(description === undefined ? {} : { description }), ...(inputSchema === undefined ? {} : { inputSchema }) };
}
