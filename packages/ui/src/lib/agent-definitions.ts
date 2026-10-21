/**
 * The Execution Host agent definition surface, in the panel's own terms.
 *
 * The documents, their scopes and the vocabulary a save is validated against are the connection's contract
 * (`@hepi/session/execution-resources`): this module only names the fallbacks a build offers when the host states no
 * capabilities, and the two projections the editor needs. A definition is the whole Markdown document the Backend
 * parses: the known fields below plus whatever unknown frontmatter another runtime owns, which the form never shows and
 * the Backend preserves.
 */

import type {
  AgentDefinition,
  DefinitionCapabilities,
  DefinitionFields,
  DefinitionIssue,
  DefinitionList,
  DefinitionScope,
} from "@hepi/session/execution-resources";

export type AgentDefinitionScope = DefinitionScope;
export const AGENT_DEFINITION_SCOPES: readonly AgentDefinitionScope[] = ["project", "user"];

/** The fallback vocabulary for an answer that states none: the tools the durable runtime installs, the levels it
 * accepts and the context strategies this build registers. */
export const AGENT_DEFINITION_TOOLS: readonly string[] = ["read", "write", "edit", "bash"];
export const AGENT_DEFINITION_THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const AGENT_DEFINITION_CONTEXT_STRATEGIES: readonly string[] = ["fresh", "fork", "compact"];
export type AgentDefinitionContextStrategy = string;

export type AgentDefinitionCapabilities = DefinitionCapabilities;
export type AgentDefinitionIssue = DefinitionIssue;
export type AgentDefinitionView = AgentDefinition;
export type AgentDefinitionFields = DefinitionFields;

export function agentDefinitionKey(definition: Pick<AgentDefinitionView, "scope" | "name">): string {
  return definition.scope + ":" + definition.name;
}

/** The capabilities the answer states, or this build's own when it states none. */
export function capabilitiesOf(body: Pick<DefinitionList, "capabilities"> | undefined): AgentDefinitionCapabilities {
  const stated = body?.capabilities;
  const list = (value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] =>
    Array.isArray(value) && value.length > 0 ? [...value] : [...fallback];
  return {
    tools: list(stated?.tools, AGENT_DEFINITION_TOOLS),
    thinking: list(stated?.thinking, AGENT_DEFINITION_THINKING),
    contextStrategies: list(stated?.contextStrategies, AGENT_DEFINITION_CONTEXT_STRATEGIES),
  };
}
