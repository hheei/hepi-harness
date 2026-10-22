/**
 * The HTTP surface for Execution Host agent definitions. It is a factory so the backend composition stays in
 * \`server.ts\`: this module owns the routes, the validation and the storage calls, and the server supplies the two
 * things only it can — how a host is resolved from a request, and how a bounded JSON body is read.
 *
 * Routes (authenticated by the caller, like every other \`/api\` route):
 *
 * - \`GET    /api/agent-definitions?hostId=&workspaceId=\`           list project and user definitions, project first.
 * - \`GET    /api/agent-definitions/document?...&scope=&name=\`      one whole document, raw and parsed.
 * - \`PUT    /api/agent-definitions\`                                 validate and, unless \`dryRun\`, save one document.
 * - \`DELETE /api/agent-definitions?...&scope=&name=\`                remove one definition.
 *
 * The PUT body is one of two forms: \`{ scope, name, document }\` carries the whole Markdown a raw editor wrote, and
 * \`{ scope, name, fields }\` carries the form's fields, which are merged onto the document already on the host so
 * unknown frontmatter and untouched fields survive. \`dryRun: true\` validates without writing. A save is atomic and
 * last-write-wins.
 */

import type { IncomingMessage } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AGENT_DEFINITION_CONTEXT_STRATEGIES,
  AGENT_DEFINITION_THINKING,
  AGENT_DEFINITION_TOOLS,
  AgentDefinitionError,
  applyDefinitionEdits,
  buildEffectiveAgentConfiguration,
  isAgentDefinitionScope,
  parseAgentDefinitionDocument,
  serializeAgentDefinitionDocument,
  type AgentDefinitionDocument,
  type AgentDefinitionScope,
  type AgentDefinitionValidationIssue,
} from "./agent-definitions.ts";
import { errorText } from "@hepi/protocol/error-text";
import {
  deleteAgentDefinition,
  listAgentDefinitions,
  readAgentDefinition,
  resolveAgentDefinitions,
  writeAgentDefinition,
  type AgentDefinitionHost,
  type StoredAgentDefinition,
} from "./agent-definitions-store.ts";

export interface AgentDefinitionHandlerDeps {
  /**
   * Resolve the execution host and workspace a request names. The server owns this: it maps the Web origin's gateway id
   * and the routing workspace id to a configured gateway binding. A refusal keeps its status and reason.
   */
  resolveHost(hostId: string | undefined, workspaceId: string | undefined): Promise<
    | { readonly ok: true; readonly host: AgentDefinitionHost }
    | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string }
  >;
  /** Read a bounded JSON request body, or \`undefined\` when it is absent or malformed. */
  readBody(request: IncomingMessage): Promise<unknown>;
}

export interface AgentDefinitionAnswer {
  readonly status: number;
  readonly body: unknown;
}

function definitionView(stored: StoredAgentDefinition, effective: boolean) {
  return {
    name: stored.document.name,
    description: stored.document.description,
    ...(stored.document.model === undefined ? {} : { model: stored.document.model }),
    ...(stored.document.thinking === undefined ? {} : { thinking: stored.document.thinking }),
    tools: [...stored.document.tools],
    context: stored.document.context,
    enabled: stored.document.enabled,
    instructions: stored.document.instructions,
    scope: stored.source.scope,
    hostId: stored.source.hostId,
    workspaceId: stored.source.workspaceId,
    path: stored.source.path,
    effective,
    issues: stored.issues,
    raw: stored.raw,
  };
}

function refusal(error: unknown): AgentDefinitionAnswer {
  if (error instanceof AgentDefinitionError) {
    const status = error.code === "host_unreachable" ? 503 : 400;
    return { status, body: { code: error.code, error: error.message, ...(error.field === undefined ? {} : { field: error.field }) } };
  }
  return { status: 502, body: { code: "host_error", error: errorText(error) } };
}

function validationRefusal(issues: readonly AgentDefinitionValidationIssue[]): AgentDefinitionAnswer {
  const first = issues[0]!;
  return { status: 400, body: { code: first.code, error: first.message, field: first.field, issues } };
}

function parseScope(value: unknown): AgentDefinitionScope | undefined {
  return isAgentDefinitionScope(value) ? value : undefined;
}

function parseName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The form fields a PUT may carry. Unknown keys are ignored; unknown frontmatter is not one of them. */
function readFields(value: unknown): Partial<AgentDefinitionDocument> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  const edits: Record<string, unknown> = {};
  if (typeof fields.name === "string") edits.name = fields.name.trim();
  if (typeof fields.description === "string") edits.description = fields.description;
  if (typeof fields.model === "string") edits.model = fields.model.trim();
  if (typeof fields.thinking === "string") edits.thinking = fields.thinking.trim();
  if (Array.isArray(fields.tools)) edits.tools = fields.tools.filter((tool): tool is string => typeof tool === "string");
  if (typeof fields.context === "string") edits.context = fields.context;
  if (typeof fields.enabled === "boolean") edits.enabled = fields.enabled;
  if (typeof fields.instructions === "string") edits.instructions = fields.instructions;
  return edits as Partial<AgentDefinitionDocument>;
}

export function createAgentDefinitionsHandler(deps: AgentDefinitionHandlerDeps) {
  async function hostFor(hostId: string | undefined, workspaceId: string | undefined): Promise<
    { readonly ok: true; readonly host: AgentDefinitionHost } | { readonly ok: false; readonly answer: AgentDefinitionAnswer }
  > {
    const resolved = await deps.resolveHost(hostId, workspaceId);
    if (resolved.ok) return resolved;
    return { ok: false, answer: { status: resolved.status, body: { code: resolved.code, error: resolved.error } } };
  }

  return async function handleAgentDefinitions(request: IncomingMessage, url: URL): Promise<AgentDefinitionAnswer | undefined> {
    if (!url.pathname.startsWith("/api/agent-definitions")) return undefined;
    const method = request.method ?? "GET";
    const params = url.searchParams;
    const hostId = params.get("hostId") ?? undefined;
    const workspaceId = params.get("workspaceId") ?? undefined;
    try {
      if (method === "GET" && url.pathname === "/api/agent-definitions") {
        const host = await hostFor(hostId, workspaceId);
        if (!host.ok) return host.answer;
        const definitions = await listAgentDefinitions(host.host, BACKGROUND_CONTEXT);
        const resolved = resolveAgentDefinitions(definitions);
        return {
          status: 200,
          body: {
            protocol: "hepi.agent-definitions.v1",
            hostId: host.host.gatewayId,
            workspaceId: host.host.workspaceId,
            // The vocabulary the panel offers is the one this build can execute, answered from the same list the save is
            // validated against, so an offered tool and an accepted tool cannot become two different lists.
            capabilities: {
              tools: [...AGENT_DEFINITION_TOOLS],
              thinking: [...AGENT_DEFINITION_THINKING],
              contextStrategies: [...AGENT_DEFINITION_CONTEXT_STRATEGIES],
            },
            definitions: resolved.effective.map((item) => definitionView(item, true)),
            shadowed: resolved.shadowed.map((item) => definitionView(item, false)),
          },
        };
      }
      if (method === "GET" && url.pathname === "/api/agent-definitions/document") {
        const host = await hostFor(hostId, workspaceId);
        if (!host.ok) return host.answer;
        const scope = parseScope(params.get("scope"));
        const name = parseName(params.get("name"));
        if (scope === undefined || name === undefined) return { status: 400, body: { code: "invalid_request", error: "scope and name are required" } };
        const stored = await readAgentDefinition(host.host, { hostId: host.host.gatewayId, workspaceId: host.host.workspaceId, scope, name }, BACKGROUND_CONTEXT);
        if (stored === undefined) return { status: 404, body: { code: "not_found", error: "no definition named " + name + " in the " + scope + " scope" } };
        return { status: 200, body: { protocol: "hepi.agent-definitions.v1", definition: definitionView(stored, true) } };
      }
      if (method === "PUT" && url.pathname === "/api/agent-definitions") {
        const body = await deps.readBody(request) as Record<string, unknown> | undefined;
        if (body === undefined || body === null || typeof body !== "object") return { status: 400, body: { code: "invalid_request", error: "a JSON body is required" } };
        const resolvedHost = await hostFor(typeof body.hostId === "string" ? body.hostId : hostId, typeof body.workspaceId === "string" ? body.workspaceId : workspaceId);
        if (!resolvedHost.ok) return resolvedHost.answer;
        const host = resolvedHost.host;
        const scope = parseScope(body.scope);
        if (scope === undefined) return { status: 400, body: { code: "invalid_request", error: "scope must be project or user" } };
        const requestedName = parseName(body.name);
        if (requestedName === undefined) return { status: 400, body: { code: "invalid_request", error: "a name is required" } };
        const dryRun = body.dryRun === true;
        let definition: AgentDefinitionDocument;
        if (typeof body.document === "string") {
          // A raw document names itself: the frontmatter's name is the identity and the file it is written to, so a
          // document cannot be silently renamed to whatever the client happened to send alongside it.
          const parsed = parseAgentDefinitionDocument(body.document, requestedName);
          if (parsed.issues.length > 0) return validationRefusal(parsed.issues);
          definition = parsed.definition;
        } else {
          const fields = readFields(body.fields);
          if (fields === undefined) return { status: 400, body: { code: "invalid_request", error: "either a document or a fields object is required" } };
          const existing = await readAgentDefinition(host, { hostId: host.gatewayId, workspaceId: host.workspaceId, scope, name: requestedName }, BACKGROUND_CONTEXT);
          const merged = applyDefinitionEdits(existing?.document, { ...fields, name: requestedName });
          const parsed = parseAgentDefinitionDocument(serializeAgentDefinitionDocument(merged), requestedName);
          if (parsed.issues.length > 0) return validationRefusal(parsed.issues);
          definition = parsed.definition;
        }
        const name = definition.name;
        const identity = { hostId: host.gatewayId, workspaceId: host.workspaceId, scope, name };
        if (dryRun) {
          return { status: 200, body: { protocol: "hepi.agent-definitions.v1", dryRun: true, definition: { ...definition, ...identity, effective: true }, issues: [] } };
        }
        const stored = await writeAgentDefinition(host, identity, definition, BACKGROUND_CONTEXT);
        return { status: 200, body: { protocol: "hepi.agent-definitions.v1", definition: definitionView(stored, true), effective: buildEffectiveAgentConfiguration(stored.document, identity, stored.source.path) } };
      }
      if (method === "DELETE" && url.pathname === "/api/agent-definitions") {
        const host = await hostFor(hostId, workspaceId);
        if (!host.ok) return host.answer;
        const scope = parseScope(params.get("scope"));
        const name = parseName(params.get("name"));
        if (scope === undefined || name === undefined) return { status: 400, body: { code: "invalid_request", error: "scope and name are required" } };
        await deleteAgentDefinition(host.host, { hostId: host.host.gatewayId, workspaceId: host.host.workspaceId, scope, name }, BACKGROUND_CONTEXT);
        return { status: 200, body: { protocol: "hepi.agent-definitions.v1", deleted: { scope, name } } };
      }
      return { status: 405, body: { code: "method_not_allowed", error: "method not allowed for " + url.pathname } };
    } catch (error) {
      return refusal(error);
    }
  };
}
