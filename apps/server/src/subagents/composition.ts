/**
 * The composition of the optional subagent extension: the host port, built from the objects this backend already owns.
 *
 * The server calls this once, after the one creation seam exists and before scheduling resumes, and installs the
 * returned extension through the harness's own installer. Everything the extension can reach is an existing seam — the
 * creation operations, the read operations, the catalogue projection, the workspace binding and the Execution Host's
 * agent definitions — so this module is wiring, not a second runtime (spec D01, D15).
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import { conversationPage } from "../conversation-page.ts";
import type { AgentDefinitionHost } from "../agent-definitions-store.ts";
import { readAgentDefinition } from "../agent-definitions-store.ts";
import { AGENT_DEFINITION_THINKING, buildEffectiveAgentConfiguration } from "../agent-definitions.ts";
import type { ConversationOperations } from "../conversation-operations.ts";
import { SUBAGENT_EXTENSION, type DispatchRecord, type SubagentDeliverAnswer, type SubagentDeliverRequest, type SubagentHost, type SubagentListAnswer, type SubagentListRequest, type SubagentSendAnswer, type SubagentStopAnswer } from "./host.ts";
import { SUBAGENT_LIMITS } from "./extension.ts";

/** One catalogue row as the listing projects it, in the same shape the HTTP catalogue route answers with. */
export type SubagentCatalogueRow = {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly busy: boolean;
  readonly title: string | null;
  readonly createdBy?: string;
  readonly displayParentId?: string;
  readonly displayParentDeleted?: boolean;
  readonly subagentParentConversationId?: string;
};

/**
 * What the composition needs from the backend. Every entry is an existing seam the server already has: the extension
 * adds no store, no scheduler and no second view of a conversation.
 */
export type SubagentCompositionDeps = {
  readonly operations: Pick<ConversationOperations, "spawn" | "get" | "read" | "deliver" | "send" | "stop">;
  /** One atomic commit on the same harness the operations run on; the Web's delegation route writes its record here. */
  readonly commit: SubagentHost["commit"];
  /** The committed catalogue rows, exactly as the HTTP catalogue route builds them. */
  readonly catalogue: () => readonly SubagentCatalogueRow[];
  /** The execution workspace one conversation is bound to, or undefined when it has none. */
  readonly workspace: (conversationId: string) => Promise<string | undefined>;
  /**
   * The newest visible entry of one conversation, which is where a `fork` or `compact` preparation starts. The
   * backend reads it through the conversation's own fork-aware context, so the position is the one the runtime would
   * fork at and no second history source exists (spec D11, D13).
   */
  readonly sourceEntry: (conversationId: string) => Promise<string | undefined>;
  /**
   * The delegations of one conversation that are still work: a child whose anchor has not admitted it yet, or whose
   * own conversation has live work. A finished delegation is not counted, because its conversation and its permanent
   * anchor stay for the life of the child (spec D12).
   */
  readonly activeChildren: (conversationId: string) => Promise<number>;
  /** The extension's own durable record of one delegation, read from the core session by its stable request identity. */
  readonly readDispatch: (conversationId: string, requestId: string) => Promise<DispatchRecord | undefined>;
  /**
   * Ask a delegation to prepare again, by naming the failed attempt's own task in its dispatch record. It is one write
   * to the extension's own document — the record the parked anchor is watching — so the retry is durable state, not a
   * call into the anchor.
   */
  readonly retryPreparation: (conversationId: string, requestId: string, failedTaskId: string) => Promise<void>;
  /** The agent definition host of one workspace, or undefined when this deployment binds no such workspace. */
  readonly definitionHost: (workspaceId: string) => AgentDefinitionHost | undefined;
  /** The extensions a child of this workspace selects; this composition removes the subagent extension itself. */
  readonly childExtensions: (workspaceId: string | undefined) => Promise<readonly Extension[]>;
  readonly models: Models;
  readonly defaultModel: SubagentHost["defaultModel"];
  readonly defaultThinkingLevel: SubagentHost["defaultThinkingLevel"];
};

/** The model a definition names. `provider/modelId` is explicit; a bare id is searched across the configured providers. */
function resolveModel(models: Models, text: string): ReturnType<SubagentHost["resolveModel"]> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, model: null };
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    if (models.getModel(provider, modelId) === undefined) return { ok: false, code: "unknown_model", message: "no model " + provider + "/" + modelId + " is configured" };
    return { ok: true, model: { provider, modelId } };
  }
  for (const provider of models.getProviders()) {
    if (models.getModel(provider.id, trimmed) !== undefined) return { ok: true, model: { provider: provider.id, modelId: trimmed } };
  }
  return { ok: false, code: "unknown_model", message: "no configured provider offers a model named " + trimmed };
}

/** One listing page over the catalogue projection, filtered by the relation fields the route already filters on. */
function list(catalogue: readonly SubagentCatalogueRow[], request: SubagentListRequest): SubagentListAnswer {
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit <= 0)) return { ok: false, code: "invalid_request", message: "limit must be a positive integer" };
  if (request.cursor !== undefined && !/^[0-9]+$/.test(request.cursor)) return { ok: false, code: "invalid_request", message: "cursor must be a conversation id" };
  const filtered = catalogue.filter((row) =>
    (request.createdBy === undefined || row.createdBy === request.createdBy)
    && (request.displayParentId === undefined || row.displayParentId === request.displayParentId)
    && (request.ownerConversationId === undefined || row.subagentParentConversationId === request.ownerConversationId)
    && (request.workspaceId === undefined || row.workspaceId === request.workspaceId));
  const sorted = [...filtered].sort((left, right) => Number(left.id) - Number(right.id));
  const { window, nextCursor } = conversationPage(sorted, request.limit, request.cursor);
  return {
    ok: true,
    conversations: window.map((row) => ({
      conversationId: row.id,
      busy: row.busy,
      ...(row.createdBy === undefined ? {} : { createdBy: row.createdBy }),
      ...(row.displayParentId === undefined ? {} : { displayParentId: row.displayParentId }),
      ...(row.displayParentDeleted === true ? { displayParentDeleted: true } : {}),
      ...(row.subagentParentConversationId === undefined ? {} : { ownerConversationId: row.subagentParentConversationId }),
      ...(row.workspaceId === null ? {} : { workspaceId: row.workspaceId }),
      ...(row.title === null ? {} : { title: row.title }),
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/**
 * One report admission, mapped to the answer the reporter names by code.
 *
 * A removed recipient is the one refusal the reporter has to tell apart from every other: it is terminal, so it ends the
 * delivery instead of retrying, while an unknown conversation is a missing target and anything else is a real failure
 * that propagates. Nothing else is caught, because a report that failed for another reason must not be recorded as
 * delivered (spec D05, A22).
 */
async function deliver(deps: SubagentCompositionDeps, request: SubagentDeliverRequest): Promise<SubagentDeliverAnswer> {
  try {
    const result = await deps.operations.deliver(request.recipientConversationId, {
      requestId: request.requestId,
      content: request.content,
      entry: request.entry,
      ...(request.whenBusy === undefined ? {} : { whenBusy: request.whenBusy }),
    });
    return { ok: true, submissionId: result.submissionId, status: result.status };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "session_deleted") return { ok: false, code: "recipient_deleted", message: error instanceof Error ? error.message : String(error) };
    if (code === "not_found") return { ok: false, code: "not_found", message: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

/**
 * One agent dispatch into an existing conversation, mapped to the answer the model reads.
 *
 * Every refusal the control seam names is a decision, not a failure, so it is returned as one: a target held by a
 * **user** is `user_stopped` — the model cannot clear that hold and no dispatch is created for it — while a removed
 * target is terminal for the same reason a removed recipient is on the report path (spec D02, D07, A09).
 */
async function send(deps: SubagentCompositionDeps, conversationId: string, request: Parameters<SubagentHost["send"]>[1]): Promise<SubagentSendAnswer> {
  try {
    const result = await deps.operations.send(conversationId, request);
    return {
      ok: true,
      control: result.control,
      ...(result.submissionId === undefined ? {} : { submissionId: result.submissionId }),
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // A user's stop is the one refusal the model has to be told apart from a real failure: it is the user's decision
    // and it stays the user's, so the model is answered rather than handed an error it could retry around.
    if (code === "source_locked") return { ok: false, code: "user_stopped", message: error instanceof Error ? error.message : String(error) };
    if (code === "session_deleted") return { ok: false, code: "recipient_deleted", message: error instanceof Error ? error.message : String(error) };
    if (code === "not_found") return { ok: false, code: "not_found", message: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

/** One agent stop, mapped the same way: the control decision is the answer, an unknown target is not. */
async function stop(deps: SubagentCompositionDeps, conversationId: string, request: Parameters<SubagentHost["stop"]>[1]): Promise<SubagentStopAnswer> {
  try {
    const result = await deps.operations.stop(conversationId, request);
    return {
      ok: true,
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      drain: result.drain,
      control: result.control,
      receipt: result.receipt,
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "session_deleted") return { ok: false, code: "recipient_deleted", message: error instanceof Error ? error.message : String(error) };
    if (code === "not_found") return { ok: false, code: "not_found", message: error instanceof Error ? error.message : String(error) };
    throw error;
  }
}

/** Build the host port over the backend's own seams. */
export function createSubagentHost(deps: SubagentCompositionDeps): SubagentHost {
  return {
    spawn: (request) => deps.operations.spawn(request),
    commit: (change) => deps.commit(change),
    dispatch: (conversationId, requestId) => deps.readDispatch(conversationId, requestId),
    get: (conversationId) => deps.operations.get(conversationId),
    read: (request) => deps.operations.read(request),
    deliver: (request) => deliver(deps, request),
    send: (conversationId, request) => send(deps, conversationId, request),
    stop: (conversationId, request) => stop(deps, conversationId, request),
    list: (request) => Promise.resolve(list(deps.catalogue(), request)),
    workspace: (conversationId) => deps.workspace(conversationId),
    async sourcePosition(conversationId) {
      const entryId = await deps.sourceEntry(conversationId);
      return entryId === undefined ? undefined : { conversationId, entryId };
    },
    activeChildren: (conversationId) => deps.activeChildren(conversationId),
    retryPreparation: (conversationId, requestId, failedTaskId) => deps.retryPreparation(conversationId, requestId, failedTaskId),
    async existingDispatch(conversationId, requestId) {
      const stored = await deps.readDispatch(conversationId, requestId);
      // A record without a child is one whose creating commit never completed: it is not an answer, so the caller
      // creates the delegation as if it were the first attempt.
      if (stored?.childConversationId === undefined) return undefined;
      return {
        dispatchId: stored.dispatchId ?? requestId,
        childConversationId: stored.childConversationId,
        ...(stored.definitionName === undefined ? {} : { definitionName: stored.definitionName }),
        ...(stored.preparationFailedTaskId === undefined ? {} : { preparationFailedTaskId: stored.preparationFailedTaskId }),
        ...(stored.preparationRetriedTaskId === undefined ? {} : { preparationRetriedTaskId: stored.preparationRetriedTaskId }),
      };
    },
    resolveModel: (text) => resolveModel(deps.models, text),
    // The definition vocabulary's own level set, so a definition can never configure a level this build silently ignores.
    resolveThinkingLevel: (text) => AGENT_DEFINITION_THINKING.includes(text) ? text as NonNullable<AgentChange["thinkingLevel"]> : undefined,
    async resolveDefinition({ workspaceId, name }) {
      if (workspaceId === undefined) return { ok: false, code: "no_execution_host", message: "this conversation is bound to no execution workspace" };
      const host = deps.definitionHost(workspaceId);
      if (host === undefined) return { ok: false, code: "unknown_workspace", message: "this deployment binds no workspace " + workspaceId };
      try {
        const identity = { hostId: host.gatewayId, workspaceId: host.workspaceId, name };
        // A project definition shadows a user one of the same name, exactly as the Settings listing resolves them.
        const stored = await readAgentDefinition(host, { ...identity, scope: "project" }, BACKGROUND_CONTEXT)
          ?? await readAgentDefinition(host, { ...identity, scope: "user" }, BACKGROUND_CONTEXT);
        if (stored === undefined) return { ok: false, code: "unknown_definition", message: "no agent definition named " + name + " is on this execution host" };
        const issue = stored.issues[0];
        if (issue !== undefined) return { ok: false, code: issue.code, message: issue.message };
        return {
          ok: true,
          definition: {
            name: stored.document.name,
            description: stored.document.description,
            effective: buildEffectiveAgentConfiguration(stored.document, { hostId: host.gatewayId, workspaceId: host.workspaceId, scope: stored.source.scope, name: stored.document.name }, stored.source.path),
            source: stored.source,
          },
        };
      } catch (error) {
        return { ok: false, code: "host_unreachable", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async childExtensions(workspaceId) {
      const selected = await deps.childExtensions(workspaceId);
      return selected.filter((extension) => extension.name !== SUBAGENT_EXTENSION);
    },
    defaultModel: deps.defaultModel,
    defaultThinkingLevel: deps.defaultThinkingLevel,
    limits: SUBAGENT_LIMITS,
  };
}

export { SUBAGENT_EXTENSION };
export type { AgentDefinitionHost };
