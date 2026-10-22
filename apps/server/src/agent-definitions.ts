/**
 * Execution Host agent definitions: the whole Markdown document, its known fields, and the capability registry that
 * decides what may be saved.
 *
 * A definition is configuration, not a run: it names the model, thinking level, tools, context preparation strategy
 * and instructions one agent should run with. The backend parses and validates it here; the Web never reads or writes
 * a definition file on its own disk, and a definition file is only ever reached through the gateway's restricted
 * \`agent-definitions\` surface (\`apps/server/src/agent-definitions-store.ts\`).
 *
 * The frontmatter reader is adapted from pi-web's \`lib/frontmatter.ts\` (MIT; the pinned bytes and LICENSE sit in
 * \`packages/gateway/vendor/pi-web/\`, where they moved from the retired \`apps/web/vendor/pi-web/\`) and the profile
 * rules from pi-web's \`lib/subagents.ts\` (\`packages/gateway/vendor/pi-web/subagents.ts\`). Unknown frontmatter is
 * preserved exactly, so saving a definition this build does not fully understand never drops a field another runtime
 * owns; a key that names a capability this build cannot execute is refused instead of being silently filtered.
 */

import { CodingTools } from "@earendil-works/pi-durable/tools";
import { dump as stringifyYaml, load as parseYaml } from "js-yaml";
import { errorText } from "@hepi/protocol/error-text";

export type AgentDefinitionScope = "project" | "user";
export const AGENT_DEFINITION_SCOPES: readonly AgentDefinitionScope[] = ["project", "user"];

/**
 * The tools a child can actually be given: the names of the tools this deployment installs, read from the extension
 * that carries them so the vocabulary cannot drift from what a run resolves. A name outside this set is refused rather
 * than dropped, because a definition that named a tool no request can offer would otherwise save and then quietly run
 * with a smaller loadout than it asked for.
 */
export const AGENT_DEFINITION_TOOLS: readonly string[] = (CodingTools.tools ?? []).map(tool => tool.name);
const KNOWN_TOOLS = new Set(AGENT_DEFINITION_TOOLS);

/** The thinking levels the runtime accepts. */
export const AGENT_DEFINITION_THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const KNOWN_THINKING = new Set(AGENT_DEFINITION_THINKING);

/** The context preparation strategies this build registers. Default is \`fresh\`; the model cannot choose one. */
export const AGENT_DEFINITION_CONTEXT_STRATEGIES: readonly string[] = ["fresh", "fork", "compact"];
const KNOWN_CONTEXT = new Set(AGENT_DEFINITION_CONTEXT_STRATEGIES);
export type AgentDefinitionContextStrategy = (typeof AGENT_DEFINITION_CONTEXT_STRATEGIES)[number];

/** Frontmatter keys this build owns and rewrites on save. Everything else is preserved verbatim. */
const MANAGED_KEYS = new Set(["name", "description", "model", "thinking", "tools", "context", "enabled"]);

/**
 * Keys that name a capability this build does not execute. They are recognised by name so they are refused explicitly:
 * a definition that asks for MCP servers or extensions must fail loudly, not be saved with the request quietly removed.
 */
const UNSUPPORTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["mcp", "MCP servers"],
  ["mcp_servers", "MCP servers"],
  ["mcpservers", "MCP servers"],
  ["extensions", "extensions"],
  ["extension", "extensions"],
  ["plugins", "plugins"],
  ["hooks", "hooks"],
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type AgentDefinitionValidationCode =
  | "invalid_frontmatter"
  | "invalid_name"
  | "invalid_description"
  | "invalid_model"
  | "invalid_thinking"
  | "invalid_tools"
  | "unknown_tool"
  | "unsupported_capability"
  | "unknown_context_strategy"
  | "invalid_enabled";

export interface AgentDefinitionValidationIssue {
  readonly field: string;
  readonly code: AgentDefinitionValidationCode;
  readonly message: string;
}

/** A refusal a caller can act on, in the shared shape the HTTP handler reports. */
export class AgentDefinitionError extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = "AgentDefinitionError";
    this.code = code;
    this.field = field;
  }
}

export interface AgentDefinitionDocument {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly tools: readonly string[];
  readonly context: AgentDefinitionContextStrategy;
  readonly enabled: boolean;
  readonly instructions: string;
  /** Unknown frontmatter keys, in file order, carried through a save untouched. */
  readonly unknownFrontmatter: Readonly<Record<string, unknown>>;
}

export interface AgentDefinitionParseResult {
  readonly definition: AgentDefinitionDocument;
  readonly issues: readonly AgentDefinitionValidationIssue[];
}

interface FrontmatterBlock {
  readonly yaml: string;
  readonly rest: string;
  /** True when a fence opens and never closes: there is no block to read and the document is refused, not guessed at. */
  readonly unclosed: boolean;
}

function extractFrontmatter(markdown: string): FrontmatterBlock | null {
  const opening = FRONTMATTER_OPEN_RE.exec(markdown);
  if (!opening) return null;
  const closing = /^---[ \t]*(?:(?:\r\n|\n|\r)|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(markdown);
  if (!match) return { yaml: "", rest: markdown, unclosed: true };
  return {
    yaml: markdown.slice(opening[0].length, match.index).replace(/(?:\r\n|\n|\r)$/, ""),
    rest: markdown.slice(match.index + match[0].length),
    unclosed: false,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

/**
 * Parse one whole definition document. The result always carries a best-effort definition so a listing can show a
 * damaged file with its issues; a save refuses whenever \`issues\` is not empty.
 */
export function parseAgentDefinitionDocument(source: string, fallbackName?: string): AgentDefinitionParseResult {
  const issues: AgentDefinitionValidationIssue[] = [];
  const block = extractFrontmatter(source);
  if (block !== null && block.unclosed) {
    issues.push({ field: "frontmatter", code: "invalid_frontmatter", message: "the frontmatter fence opens and never closes" });
    return { definition: emptyDefinition(fallbackName ?? ""), issues };
  }
  let frontmatter: Record<string, unknown> = {};
  const body = block === null ? source : block.rest;
  if (block !== null && block.yaml.trim() !== "") {
    try {
      const parsed: unknown = parseYaml(block.yaml);
      if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
        issues.push({ field: "frontmatter", code: "invalid_frontmatter", message: "the frontmatter must be a mapping" });
      } else if (parsed !== null && parsed !== undefined) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch (error) {
      issues.push({ field: "frontmatter", code: "invalid_frontmatter", message: "the frontmatter is not valid YAML: " + errorText(error) });
    }
  }
  for (const [key, capability] of UNSUPPORTED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      issues.push({ field: key, code: "unsupported_capability", message: "this build cannot execute " + capability + "; remove the '" + key + "' field or use a runtime that supports it" });
    }
  }
  const rawName = stringValue(frontmatter.name) ?? fallbackName ?? "";
  const name = rawName;
  if (!NAME_RE.test(name)) issues.push({ field: "name", code: "invalid_name", message: "a name may contain only letters, numbers, dots, underscores and hyphens, and must start with a letter or number" });
  const description = stringValue(frontmatter.description) ?? name;
  if (frontmatter.description !== undefined && stringValue(frontmatter.description) === undefined) {
    issues.push({ field: "description", code: "invalid_description", message: "description must be a non-empty string" });
  }
  const model = stringValue(frontmatter.model);
  if (frontmatter.model !== undefined && model === undefined) issues.push({ field: "model", code: "invalid_model", message: "model must be a non-empty string" });
  const thinking = stringValue(frontmatter.thinking);
  if (frontmatter.thinking !== undefined && (thinking === undefined || !KNOWN_THINKING.has(thinking))) {
    issues.push({ field: "thinking", code: "invalid_thinking", message: "thinking must be one of " + AGENT_DEFINITION_THINKING.join(", ") });
  }
  const tools: string[] = [];
  if (frontmatter.tools !== undefined) {
    if (typeof frontmatter.tools !== "string" && !Array.isArray(frontmatter.tools)) {
      issues.push({ field: "tools", code: "invalid_tools", message: "tools must be a list or a comma-separated string" });
    } else {
      for (const tool of stringList(frontmatter.tools)) {
        if (KNOWN_TOOLS.has(tool)) { tools.push(tool); continue; }
        if (tool.toLowerCase().startsWith("ext:") || tool.toLowerCase().startsWith("mcp:")) {
          issues.push({ field: "tools", code: "unsupported_capability", message: "tool '" + tool + "' names a capability this build cannot execute" });
        } else {
          issues.push({ field: "tools", code: "unknown_tool", message: "unknown tool '" + tool + "'; known tools are " + AGENT_DEFINITION_TOOLS.join(", ") });
        }
      }
    }
  }
  const contextValue = stringValue(frontmatter.context) ?? "fresh";
  const context = KNOWN_CONTEXT.has(contextValue) ? contextValue as AgentDefinitionContextStrategy : "fresh";
  if (!KNOWN_CONTEXT.has(contextValue)) {
    issues.push({ field: "context", code: "unknown_context_strategy", message: "context must be one of " + AGENT_DEFINITION_CONTEXT_STRATEGIES.join(", ") });
  }
  let enabled = true;
  if (frontmatter.enabled !== undefined) {
    if (typeof frontmatter.enabled !== "boolean") issues.push({ field: "enabled", code: "invalid_enabled", message: "enabled must be a boolean" });
    else enabled = frontmatter.enabled;
  }
  const unknownFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!MANAGED_KEYS.has(key) && !UNSUPPORTED_KEYS.has(key)) unknownFrontmatter[key] = value;
  }
  return {
    definition: {
      name,
      description,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      tools,
      context,
      enabled,
      instructions: body.trim(),
      unknownFrontmatter,
    },
    issues,
  };
}

function emptyDefinition(name: string): AgentDefinitionDocument {
  return { name, description: name, tools: [], context: "fresh", enabled: true, instructions: "", unknownFrontmatter: {} };
}

/** Refuse a document with validation issues, naming the first field that failed. */
export function requireValidDefinition(result: AgentDefinitionParseResult): AgentDefinitionDocument {
  const issue = result.issues[0];
  if (issue !== undefined) throw new AgentDefinitionError(issue.code, issue.message, issue.field);
  return result.definition;
}

/** Render one definition back to Markdown: managed keys first, unknown frontmatter in its own order, then the body. */
export function serializeAgentDefinitionDocument(definition: AgentDefinitionDocument): string {
  const frontmatter: Record<string, unknown> = {
    name: definition.name,
    description: definition.description,
  };
  if (definition.model !== undefined) frontmatter.model = definition.model;
  if (definition.thinking !== undefined) frontmatter.thinking = definition.thinking;
  frontmatter.tools = [...definition.tools];
  frontmatter.context = definition.context;
  frontmatter.enabled = definition.enabled;
  for (const [key, value] of Object.entries(definition.unknownFrontmatter)) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  const body = definition.instructions.trim();
  return "---\n" + yaml + "\n---\n\n" + body + "\n";
}

/**
 * The fields a form submits, merged onto an existing definition: a field the form did not send keeps the value already
 * in the file, so an editor that shows only some fields cannot silently clear the rest. Unknown frontmatter always
 * comes from the existing file.
 */
export function applyDefinitionEdits(
  existing: AgentDefinitionDocument | undefined,
  edits: Partial<Pick<AgentDefinitionDocument, "name" | "description" | "model" | "thinking" | "tools" | "context" | "enabled" | "instructions">>,
): AgentDefinitionDocument {
  const base = existing ?? emptyDefinition(edits.name ?? "");
  // An empty string for \`model\` or \`thinking\` is an explicit clear: the form sends every field it shows, so a cleared
  // box must remove the value rather than leave the file's old one in place.
  const model = edits.model === undefined ? base.model : (edits.model.trim() === "" ? undefined : edits.model.trim());
  const thinking = edits.thinking === undefined ? base.thinking : (edits.thinking.trim() === "" ? undefined : edits.thinking.trim());
  return {
    name: edits.name ?? base.name,
    description: edits.description ?? base.description,
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking }),
    tools: edits.tools === undefined ? [...base.tools] : [...edits.tools],
    context: edits.context ?? base.context,
    enabled: edits.enabled ?? base.enabled,
    instructions: edits.instructions ?? base.instructions,
    unknownFrontmatter: { ...base.unknownFrontmatter },
  };
}

/** The identity a definition is addressed by: the execution host, the workspace, the scope and the name. */
export interface AgentDefinitionIdentity {
  readonly hostId: string;
  readonly workspaceId: string;
  readonly scope: AgentDefinitionScope;
  readonly name: string;
}

export function agentDefinitionIdentityKey(identity: AgentDefinitionIdentity): string {
  return [identity.hostId, identity.workspaceId, identity.scope, identity.name].join("\u0000");
}

export function isAgentDefinitionScope(value: unknown): value is AgentDefinitionScope {
  return value === "project" || value === "user";
}

/**
 * The full effective configuration of one definition, fixed when a child is created. Every field is set explicitly —
 * including \`model\` and \`thinking\` as \`null\` when the definition does not name them — so a child never inherits part
 * of its parent's configuration, and editing or deleting the definition later cannot change a session already created
 * from it.
 */
export interface AgentDefinitionEffectiveConfiguration {
  readonly version: 1;
  readonly definition: AgentDefinitionIdentity & { readonly path: string };
  readonly name: string;
  readonly description: string;
  readonly model: string | null;
  readonly thinking: string | null;
  readonly tools: readonly string[];
  readonly context: AgentDefinitionContextStrategy;
  readonly enabled: boolean;
  readonly instructions: string;
}

export function buildEffectiveAgentConfiguration(
  definition: AgentDefinitionDocument,
  identity: AgentDefinitionIdentity,
  path: string,
): AgentDefinitionEffectiveConfiguration {
  return {
    version: 1,
    definition: { ...identity, path },
    name: definition.name,
    description: definition.description,
    model: definition.model ?? null,
    thinking: definition.thinking ?? null,
    tools: [...definition.tools],
    context: definition.context,
    enabled: definition.enabled,
    instructions: definition.instructions,
  };
}
