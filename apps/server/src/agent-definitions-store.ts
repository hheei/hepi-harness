/**
 * Execution Host storage for agent definitions. Every read and write goes through the gateway's restricted
 * \`agent-definitions\` surface, so the files are the host's own: the Web and the backend never look in a local directory
 * that happens to match, and an unreachable host fails rather than falling back to another machine.
 *
 * A save is an atomic whole-document replace (staging file + rename), and it is last-write-wins: there is no lease and
 * no optimistic lock. Changing or deleting a definition never touches a conversation that was already created from it,
 * because a created child keeps its own effective-configuration snapshot.
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ExecutionHost, ExecutionHostEnv } from "@hepi/gateway";
import {
  AgentDefinitionError,
  parseAgentDefinitionDocument,
  serializeAgentDefinitionDocument,
  type AgentDefinitionDocument,
  type AgentDefinitionIdentity,
  type AgentDefinitionScope,
  type AgentDefinitionValidationIssue,
} from "./agent-definitions.ts";
import { errorText } from "@hepi/protocol/error-text";

/** The execution host one definition set lives on, with the environment that reaches it. */
export interface AgentDefinitionHost {
  readonly gatewayId: string;
  readonly workspaceId: string;
  readonly env: ExecutionHostEnv;
}

export interface AgentDefinitionSource {
  readonly scope: AgentDefinitionScope;
  readonly hostId: string;
  readonly workspaceId: string;
  readonly path: string;
}

export interface StoredAgentDefinition {
  readonly source: AgentDefinitionSource;
  readonly document: AgentDefinitionDocument;
  readonly issues: readonly AgentDefinitionValidationIssue[];
  /** The whole document exactly as the host holds it. */
  readonly raw: string;
}

function hostOf(host: AgentDefinitionHost, context: Context): Promise<ExecutionHost> {
  return host.env.executionHost(context).then((result) => {
    if (!result.ok) throw new AgentDefinitionError("host_unreachable", "the execution host could not be reached: " + result.error.message);
    return result.value;
  });
}

/** The directory one scope's definitions live in, on the host: project \`.pi/agents\`, account \`<agent dir>/agents\`. */
export function agentDefinitionDirectory(host: ExecutionHost, scope: AgentDefinitionScope): string {
  return scope === "project" ? posix.join(host.workspaceRoot, ".pi", "agents") : posix.join(host.agentDir, "agents");
}

/** The whole document path for one name. The name is validated before it is used, so it cannot escape the directory. */
export function agentDefinitionPath(host: ExecutionHost, scope: AgentDefinitionScope, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new AgentDefinitionError("invalid_name", "a name may contain only letters, numbers, dots, underscores and hyphens", "name");
  return posix.join(agentDefinitionDirectory(host, scope), name + ".md");
}

function failure(error: unknown): never {
  if (error instanceof AgentDefinitionError) throw error;
  const message = errorText(error);
  throw new AgentDefinitionError("host_unreachable", "the execution host could not serve the agent definition: " + message);
}

async function readFile(host: AgentDefinitionHost, path: string, context: Context): Promise<string | undefined> {
  const result = await host.env.agentDefinitions.readTextFile(path, context);
  if (result.ok) return result.value;
  if (result.error.code === "not_found") return undefined;
  failure(result.error);
}

/** One document from the host, parsed with its issues, or \`undefined\` when the file is absent. */
export async function readAgentDefinition(
  host: AgentDefinitionHost,
  identity: AgentDefinitionIdentity,
  context: Context,
): Promise<StoredAgentDefinition | undefined> {
  try {
    const executionHost = await hostOf(host, context);
    const path = agentDefinitionPath(executionHost, identity.scope, identity.name);
    const raw = await readFile(host, path, context);
    if (raw === undefined) return undefined;
    const parsed = parseAgentDefinitionDocument(raw, identity.name);
    return { source: { scope: identity.scope, hostId: identity.hostId, workspaceId: identity.workspaceId, path }, document: parsed.definition, issues: parsed.issues, raw };
  } catch (error) {
    failure(error);
  }
}

/** Every definition of one scope, in name order. A missing directory is an empty scope, not a failure. */
export async function listAgentDefinitions(
  host: AgentDefinitionHost,
  context: Context,
): Promise<readonly StoredAgentDefinition[]> {
  try {
    const executionHost = await hostOf(host, context);
    const found: StoredAgentDefinition[] = [];
    for (const scope of ["project", "user"] as const) {
      const dir = agentDefinitionDirectory(executionHost, scope);
      const exists = await host.env.agentDefinitions.exists(dir, context);
      if (!exists.ok) throw new AgentDefinitionError("host_unreachable", "the execution host could not be reached: " + exists.error.message);
      if (!exists.value) continue;
      const listed = await host.env.agentDefinitions.listDir(dir, context);
      if (!listed.ok) failure(listed.error);
      for (const entry of listed.value) {
        if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
        const name = entry.name.slice(0, -".md".length);
        const path = posix.join(dir, entry.name);
        const raw = await readFile(host, path, context);
        if (raw === undefined) continue;
        const parsed = parseAgentDefinitionDocument(raw, name);
        found.push({ source: { scope, hostId: host.gatewayId, workspaceId: host.workspaceId, path }, document: parsed.definition, issues: parsed.issues, raw });
      }
    }
    return found;
  } catch (error) {
    failure(error);
  }
}

/**
 * Definitions by name with project over user, as the runtime resolves them: a project file replaces the user file of
 * the same name. The shadowed user definition is still returned in \`shadowed\` so the Settings list can say so.
 */
export function resolveAgentDefinitions(
  definitions: readonly StoredAgentDefinition[],
): { readonly effective: readonly StoredAgentDefinition[]; readonly shadowed: readonly StoredAgentDefinition[] } {
  const byName = new Map<string, StoredAgentDefinition>();
  const shadowed: StoredAgentDefinition[] = [];
  for (const definition of definitions.filter((item) => item.source.scope === "project")) byName.set(definition.document.name.toLowerCase(), definition);
  for (const definition of definitions.filter((item) => item.source.scope === "user")) {
    const key = definition.document.name.toLowerCase();
    if (byName.has(key)) shadowed.push(definition);
    else byName.set(key, definition);
  }
  return {
    effective: [...byName.values()].sort((a, b) => a.document.name.localeCompare(b.document.name)),
    shadowed,
  };
}

/**
 * Write one whole document atomically. The staging file is written in the target directory and renamed over the
 * target, so a reader sees either the previous document or the new one, never a partial file; a failed write leaves
 * the previous document in place. Last write wins: no lease and no optimistic lock.
 */
export async function writeAgentDefinition(
  host: AgentDefinitionHost,
  identity: AgentDefinitionIdentity,
  document: AgentDefinitionDocument,
  context: Context,
): Promise<StoredAgentDefinition> {
  try {
    const executionHost = await hostOf(host, context);
    const dir = agentDefinitionDirectory(executionHost, identity.scope);
    const target = agentDefinitionPath(executionHost, identity.scope, identity.name);
    const created = await host.env.agentDefinitions.createDir(dir, context);
    if (!created.ok) failure(created.error);
    const staging = posix.join(dir, "." + identity.name + "." + randomUUID() + ".tmp");
    const content = serializeAgentDefinitionDocument(document);
    const written = await host.env.agentDefinitions.writeFile(staging, content, context);
    if (!written.ok) {
      await host.env.agentDefinitions.remove(staging, context).catch(() => undefined);
      failure(written.error);
    }
    const renamed = await host.env.agentDefinitions.renameFile(staging, target, context);
    if (!renamed.ok) {
      await host.env.agentDefinitions.remove(staging, context).catch(() => undefined);
      failure(renamed.error);
    }
    return { source: { scope: identity.scope, hostId: identity.hostId, workspaceId: identity.workspaceId, path: target }, document, issues: [], raw: content };
  } catch (error) {
    failure(error);
  }
}

/** Remove one definition. Absent is not a failure: the caller asked for the file not to be there. */
export async function deleteAgentDefinition(
  host: AgentDefinitionHost,
  identity: AgentDefinitionIdentity,
  context: Context,
): Promise<void> {
  try {
    const executionHost = await hostOf(host, context);
    const target = agentDefinitionPath(executionHost, identity.scope, identity.name);
    const removed = await host.env.agentDefinitions.remove(target, context);
    if (!removed.ok && removed.error.code !== "not_found") failure(removed.error);
  } catch (error) {
    failure(error);
  }
}
