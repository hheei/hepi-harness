import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { AgentState, DocumentReader, ModelRef } from "@earendil-works/pi-durable";
import { MAX_SESSION_UI_REQUEST_BYTES, PROTOCOL_VERSION, parseSessionUiStateRequest, type SessionUiStateRefusalReason } from "@hepi/protocol";
import { safeFailure, SAFE_CREDENTIAL_ERROR } from "./public-errors.ts";
import { readSidebarState, writeSidebarState } from "./sidebar-state.ts";
import type { ConversationRuntime } from "./conversation-attachments.ts";
import { readEffectiveResources, reloadResources, resourceSummary, type WorkspaceResources } from "./workspace-resources.ts";
import { readModelConfig, saveModelConfig, type ModelConfigTarget } from "./model-config.ts";

/**
 * The settings and resource routes: what a client reads and writes about this deployment's own configuration, and
 * what one conversation adopts from its execution host.
 *
 * Two owners meet here and neither is duplicated. The model catalog is the runtime's own `Models` — the same authority
 * that answers the next request — so a saved `models.json` is validated, written and applied to it in one place, and the
 * listing states the catalog's own thinking levels rather than a second table. Resources are the execution host's:
 * the conversation's adopted catalog is read from its own durable state, and a reload discovers a complete candidate
 * on that host and commits it atomically.
 *
 * The sidebar document is here for the same reason: it is deployment-scoped state one client writes and every client
 * reads, and the body bound and content type of that write are its contract, not a transport detail.
 */

/** The cost and thinking-level fields a model row states, projected field by field from the catalog. */
const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const COST_RATES: readonly string[] = ["input", "output", "cacheRead", "cacheWrite"];

export type SettingsHttpOptions = {
  /** The conversation one path segment names, from the attachment map this backend owns. */
  readonly conversation: (id: string) => ConversationRuntime | undefined;
  /** The runtime's own catalog: the authority a save is applied to and every model answer is read from. */
  readonly models: Models;
  /** The model a deployment configured as its default, stated explicitly — including as null — in the listing. */
  readonly defaultModel: ModelRef | undefined;
  /** The thinking level new conversations start with, as the deployment configured it. */
  readonly defaultThinkingLevel: string | undefined;
  /** The `models.json` this backend owns, when it owns one. */
  readonly modelConfig: ModelConfigTarget | undefined;
  /** The execution-side resource catalog, when this deployment loads one. */
  readonly resources: WorkspaceResources | undefined;
  /** Committed document reads, for the adopted catalog and the sidebar document. */
  readonly readCommitted: DocumentReader;
  /** The session committed writes are made on, for the sidebar document. */
  readonly session: SidebarSession;
  /** The execution host one conversation's resources are adopted from. */
  readonly resourceEnvironment: (item: ConversationRuntime) => Promise<ResourcesEnvironment | undefined>;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

/** The two committed operations the sidebar document needs; the harness is the Session that answers them. */
type SidebarSession = Parameters<typeof readSidebarState>[0];
/** The execution host environment the resource catalog is loaded from, as `workspace-resources.ts` names it. */
type ResourcesEnvironment = NonNullable<Parameters<typeof reloadResources>[2]>;

export function createSettingsHttp(options: SettingsHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    // The model configuration the Settings editor reads and saves. It is the backend's own agent-directory models.json
    // and the runtime that serves it, so a save is validated, written and applied to the same authority that answers the
    // next request. There is no second registry and no synthetic seed: an unconfigured environment deployment is an
    // environment-owned base provider, not a file entry, so an empty file reads as empty instead of pretending otherwise.
    if (url.pathname === "/api/models-config") {
      const target = options.modelConfig;
      if (target === undefined) { json(response, 404, { error: "model configuration is not owned by this backend" }); return true; }
      if (request.method === "GET") {
        try {
          json(response, 200, readModelConfig(target.path));
        } catch {
          // The read error can quote the file's own bytes, which may include a credential reference.
          json(response, 500, { error: "models.json could not be read; fix the file on the backend host" });
        }
        return true;
      }
      if (request.method === "PUT") {
        const result = await saveModelConfig(target, await options.readBody(request));
        // Three outcomes stay distinct: a rejected draft leaves the file and the running runtime untouched; a saved
        // draft that could not be applied is reported as saved-but-not-applied instead of as success.
        if (result.status === "invalid") { json(response, 400, { success: false, error: result.error }); return true; }
        json(response, 200, result.applied ? { success: true, applied: true } : { success: true, applied: false, error: result.error });
        return true;
      }
      json(response, 405, { error: "method not allowed" });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      // Resolving credentials is the only fallible work of this route, and the raw rejection can quote auth.json or
      // models.json: upstream `AuthStorage.readLatestData` parses auth.json without wrapping, so the failure here is a
      // bare `SyntaxError` whose message contains the file's first bytes. Report the safe text instead.
      let available;
      try {
        available = await options.models.getAvailable();
      } catch {
        json(response, 500, { error: SAFE_CREDENTIAL_ERROR });
        return true;
      }
      const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
      const models = available.map((model) => {
        const thinkingLevelMap = projectThinkingLevelMap(model.thinkingLevelMap);
        if (thinkingLevelMap !== undefined) thinkingLevelMaps[model.provider + ":" + model.id] = thinkingLevelMap;
        return { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: projectCost(model.cost), input: [...model.input], thinkingLevelMap };
      });
      // `defaultModel` is stated explicitly, including as null: a deployment that configured none must not leave the
      // field absent, because a client would then read the absence as "unspecified" and pick something itself.
      json(response, 200, { models, thinkingLevels: Object.fromEntries(available.map(model => [model.provider + ":" + model.id, getSupportedThinkingLevels(model)])), thinkingLevelMaps, defaultModel: options.defaultModel ?? null, defaultThinkingLevel: options.defaultThinkingLevel ?? "off" }); return true;
    }
    // The sidebar's shared state: pins, archive, project order and the unread marker, as one session-scoped
    // document, so every client of this backend reads and writes the same arrangement. One change per request, and the
    // answer is the state after the change, so a client never has to guess what happened. A body over the documented
    // limit is refused before it is read, and a body that is not this protocol's is refused with the reason.
    if (url.pathname === "/api/sidebar-state") {
      if (request.method === "GET") { json(response, 200, { protocol: PROTOCOL_VERSION, state: await readSidebarState(options.session) }); return true; }
      if (request.method === "POST") {
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (contentType !== "application/json") { sidebarRefusal(response, 415, "content-type", "Content-Type must be application/json"); return true; }
        let body: unknown;
        try {
          body = await options.readBody(request, MAX_SESSION_UI_REQUEST_BYTES);
        } catch (error) {
          sidebarRefusal(response, 413, "too-large", safeFailure(error));
          return true;
        }
        const parsed = parseSessionUiStateRequest(body);
        if (!parsed.ok) { sidebarRefusal(response, 400, "invalid-request", parsed.error); return true; }
        json(response, 200, { protocol: PROTOCOL_VERSION, state: await writeSidebarState(options.session, parsed.request) }); return true;
      }
      json(response, 405, { error: "method not allowed" }); return true;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "conversations") return false;
    const id = parts[2];
    // Only a conversation-scoped path belongs to this module: the catalogue's own `/api/conversations` is another
    // owner's route, and claiming it here would answer the list as an unknown conversation.
    if (id === undefined) return false;
    const item = options.conversation(id);
    // Every conversation-scoped route refuses an unknown conversation the same way, with the code a caller needs to
    // name the refusal in its own language rather than echoing an English sentence.
    if (item === undefined) { json(response, 404, { code: "not_found", error: "conversation not found" }); return true; }
    const action = parts[3];
    // The configuration this conversation's own agent document holds, as the runtime resolved it. A read is the
    // snapshot the state frame already states; a write validates the two fields a conversation may change and then
    // answers the configuration the runtime resolved after it.
    if (request.method === "GET" && action === "settings") { json(response, 200, { protocol: PROTOCOL_VERSION, ...item.snapshot().settings }); return true; }
    if (request.method === "PATCH" && action === "settings") {
      const body = await options.readBody(request) as { model?: ModelRef; thinkingLevel?: string } | undefined;
      if (!body || (!body.model && body.thinkingLevel === undefined)) { json(response, 400, { error: "settings required" }); return true; }
      if (body.model && !options.models.getModel(body.model.provider, body.model.modelId)) { json(response, 400, { error: "unknown model" }); return true; }
      const level = body.thinkingLevel;
      if (level !== undefined && !THINKING_LEVELS.includes(level)) { json(response, 400, { error: "invalid thinking level" }); return true; }
      await item.conversation.configure({ model: body.model, thinkingLevel: level as AgentState["thinkingLevel"] }, BACKGROUND_CONTEXT);
      const agent = await item.conversation.agent(BACKGROUND_CONTEXT);
      json(response, 200, { protocol: PROTOCOL_VERSION, model: agent.model, thinkingLevel: agent.thinkingLevel }); return true;
    }
    if (request.method === "GET" && action === "commands") {
      // Commands come from the catalog in effect for this conversation alone: listing never rediscovers the execution
      // host, and a candidate deferred to the next run is listed so the UI shows what that run will adopt.
      const adopted = options.resources === undefined ? undefined : await readEffectiveResources(options.readCommitted, item.conversation.id, BACKGROUND_CONTEXT);
      json(response, 200, { commands: adopted === undefined ? [] : options.resources!.commands(adopted) }); return true;
    }
    if (request.method === "POST" && action === "reload") {
      // Explicit Reload: discover and parse a complete candidate, then commit it atomically. A failure changes nothing
      // and answers with the error, so the UI can notify without the conversation losing its adopted prefix.
      if (options.resources === undefined) { json(response, 404, { error: "resource loading is not configured" }); return true; }
      try {
        await reloadResources(item.conversation, options.resources, await options.resourceEnvironment(item), BACKGROUND_CONTEXT);
        json(response, 200, { protocol: PROTOCOL_VERSION, resources: await resourceSummary(options.readCommitted, item.conversation.id, BACKGROUND_CONTEXT) });
      } catch (error) {
        json(response, 500, { error: safeFailure(error), resources: await resourceSummary(options.readCommitted, item.conversation.id, BACKGROUND_CONTEXT) });
      }
      return true;
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** A refused sidebar-state write: the reason the caller can act on, in the shared response shape. */
function sidebarRefusal(response: ServerResponse, status: number, reason: SessionUiStateRefusalReason, error: string): void {
  json(response, status, { error, reason });
}

/**
 * Catalog metadata crosses into the browser, so nested objects are rebuilt field by field instead of forwarded:
 * models.json passes unknown properties through the upstream schema and provider composer (`applyModelOverride`
 * spreads the override), and an apiKey or authorization smuggled into `cost` or `thinkingLevelMap` would otherwise
 * reach every client. `ModelCost` and `ThinkingLevelMap` in `@earendil-works/pi-ai` dist/types.d.ts define the
 * allowed fields.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectCostRates(source: Record<string, unknown>): Record<string, number> | undefined {
  const rates: Record<string, number> = {};
  for (const key of COST_RATES) {
    const value = finiteNumber(source[key]);
    if (value === undefined) return undefined;
    rates[key] = value;
  }
  return rates;
}

function projectCost(cost: unknown): Record<string, unknown> | undefined {
  if (cost === null || typeof cost !== "object" || Array.isArray(cost)) return undefined;
  const source = cost as Record<string, unknown>;
  const rates = projectCostRates(source);
  if (rates === undefined) return undefined;
  const tiers: Record<string, number>[] = [];
  if (Array.isArray(source.tiers)) {
    for (const tier of source.tiers) {
      if (tier === null || typeof tier !== "object" || Array.isArray(tier)) continue;
      const rates = projectCostRates(tier as Record<string, unknown>);
      const above = finiteNumber((tier as Record<string, unknown>).inputTokensAbove);
      if (rates === undefined || above === undefined) continue;
      tiers.push({ inputTokensAbove: above, ...rates });
    }
  }
  return tiers.length === 0 ? rates : { ...rates, tiers };
}

function projectThinkingLevelMap(map: unknown): Record<string, string | null> | undefined {
  if (map === null || typeof map !== "object" || Array.isArray(map)) return undefined;
  const source = map as Record<string, unknown>;
  const projected: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    const value = source[level];
    if (typeof value === "string") projected[level] = value;
    else if (value === null) projected[level] = null;
  }
  return Object.keys(projected).length === 0 ? undefined : projected;
}
