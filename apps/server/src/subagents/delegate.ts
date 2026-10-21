/**
 * The one delegation seam: what `agent_spawn` and `agent_send` do, stated once so a browser request and a model tool
 * cannot disagree about what a delegation is.
 *
 * Both callers are the same business operation over the same host port. A model tool reaches it with the trusted
 * conversation and call identity the host states; the Web reaches it with the conversation the user is in and the
 * request identity of the user's own attempt. Neither passes a policy: the definition decides the configuration and the
 * context strategy, and the host resolves both before anything is created (spec D01, D02, D10, D11).
 *
 * Nothing here is a second runtime. The creation, the admission, the control rule and the definition resolution are the
 * host port's own seams — the same ones the HTTP conversation API uses — and the only state this module owns is the
 * dispatch record the extension already keeps.
 */

import { copyJson, type JsonValue } from "@earendil-works/chord";
import type { AgentChange, ConversationId, ModelRef, Tx } from "@earendil-works/pi-durable";

/** The one commit this module makes, whichever caller supplies it. */
export type SubagentCommit = <T>(change: (tx: Tx) => T | Promise<T>) => Promise<T>;

/** A conversation id on the wire is its numeric string; the runtime's branded id is the number it names. */
const conversationKey = (value: string): ConversationId => Number(value) as ConversationId;
import { SubagentAnchorTask } from "./anchor.ts";
import { DispatchDoc, preparationUnretried, type ExistingDispatch, type SubagentHost } from "./host.ts";
import { createSubagentReporterTask } from "./reporter.ts";

/** One delegation of a definition and a task to a conversation that does not exist yet. */
export type DelegateRequest = {
  /** The conversation the delegation is made from: its creator, its display parent and the anchor's own scope. */
  readonly delegating: string;
  /**
   * The caller's stable identity for this delegation. A tool states the conversation and the call id; the browser states
   * its own attempt identity, which it keeps across retries so a lost answer answers the child already created.
   */
  readonly requestId: string;
  /** The agent definition to run the child as, by its name on the delegating conversation's execution host. */
  readonly definition: string;
  /** The child's complete task. It is the child's own input and never host configuration. */
  readonly task: string;
};

/** One more task for a conversation that already exists. */
export type DispatchRequest = {
  readonly delegating: string;
  readonly requestId: string;
  readonly targetConversationId: string;
  readonly task: string;
};

/**
 * What one delegation answers. A refusal is the answer and never a queue entry: an over-limit request, an unresolvable
 * definition and a user's own stop all refuse before anything is created, so the caller is told what happened instead
 * of work it cannot see (spec D12, A15).
 */
export type DelegateAnswer =
  | {
    readonly ok: true;
    readonly childConversationId: string;
    readonly dispatchId: string;
    readonly requestId: string;
    /** False when this identity already created the child, which is what makes a retry a replay and not a second child. */
    readonly created: boolean;
    readonly definition?: string;
    readonly displayParentId: string;
    readonly preparationRetried?: boolean;
  }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** What one dispatch to an existing conversation answers. */
export type DispatchAnswer =
  | { readonly ok: true; readonly conversationId: string; readonly dispatchId: string; readonly requestId: string; readonly submissionId: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The model a definition names, or the deployment's default when it names none. */
function modelOf(host: SubagentHost, definitionModel: string | null): { readonly ok: true; readonly model: ModelRef | null } | { readonly ok: false; readonly code: string; readonly message: string } {
  if (definitionModel !== null) return host.resolveModel(definitionModel);
  return { ok: true, model: host.defaultModel ?? null };
}

/** The display parents above one conversation, walked through the by-id read so no second graph source exists. */
async function depthOf(host: SubagentHost, conversationId: string): Promise<number | undefined> {
  let depth = 0;
  let cursor: string | undefined = conversationId;
  const seen = new Set<string>();
  while (cursor !== undefined) {
    if (seen.has(cursor)) return undefined;
    seen.add(cursor);
    const info = await host.get(cursor);
    if (info === undefined) return undefined;
    const parent = info.relations.displayParentId;
    if (parent === undefined) return depth;
    depth += 1;
    cursor = parent;
  }
  return depth;
}

/**
 * The one delegation seam, over the host port. The reporter task is built here rather than in the tool, so a browser
 * dispatch and a model dispatch create the same kind of reporter for the same dispatch.
 */
export function createSubagentDelegation(host: SubagentHost) {
  const reporter = createSubagentReporterTask(host);

  /**
   * Create one child from a definition and give it one task, or answer the child this request identity already created.
   *
   * The durable answer comes first: this request identity may already have created a child, and then the answer is that
   * child whatever the definition, the tool set or the concurrency limit say *now*. Re-checking the preconditions first
   * is what would refuse a replay whose work is already committed (spec D04, A19).
   */
  async function delegate(request: DelegateRequest): Promise<DelegateAnswer> {
    const { delegating, requestId } = request;
    if (request.definition.trim() === "") return { ok: false, code: "invalid_request", message: "a delegation needs an agent definition" };
    if (request.task.trim() === "") return { ok: false, code: "invalid_request", message: "a delegation needs the child's complete task" };
    const answered = await host.existingDispatch(delegating, requestId);
    if (answered !== undefined) {
      // A delegation whose context preparation failed is **retryable under this same identity**: the caller's own replay
      // is the retry, so it asks the parked anchor to prepare again — same child, same dispatch, no second admission and
      // no fallback to a fresh context (spec D11, A14).
      const retried = preparationUnretried(answered);
      if (retried && answered.preparationFailedTaskId !== undefined) await host.retryPreparation(delegating, requestId, answered.preparationFailedTaskId);
      return {
        ok: true,
        childConversationId: answered.childConversationId,
        dispatchId: answered.dispatchId,
        requestId,
        created: false,
        displayParentId: delegating,
        ...(answered.definitionName === undefined ? {} : { definition: answered.definitionName }),
        ...(retried ? { preparationRetried: true } : {}),
      };
    }
    const workspaceId = await host.workspace(delegating);
    if (workspaceId === undefined) return { ok: false, code: "no_execution_host", message: "this conversation is bound to no execution workspace, so it cannot resolve an agent definition or run a child" };
    const resolved = await host.resolveDefinition({ workspaceId, name: request.definition });
    if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
    const definition = resolved.definition;
    if (!definition.effective.enabled) return { ok: false, code: "definition_disabled", message: "the definition " + definition.name + " is disabled; enable it before delegating to it" };
    // The strategy is the definition's own decision, and it is read here — never from the request, which carries no
    // policy at all. `fork` and `compact` both start from a position in this conversation, resolved by the host before
    // anything is created, so a later message cannot move the branch point (spec D11).
    const strategy = definition.effective.context;
    const source = strategy === "fresh" ? undefined : await host.sourcePosition(delegating);
    if (strategy !== "fresh" && source === undefined) {
      return { ok: false, code: "no_source_entry", message: "the definition " + definition.name + " asks for context preparation " + strategy + ", but this conversation has no history to prepare from" };
    }
    const chosen = modelOf(host, definition.effective.model);
    if (!chosen.ok) return { ok: false, code: chosen.code, message: chosen.message };
    if (chosen.model === null) return { ok: false, code: "no_model", message: "the definition " + definition.name + " names no model and this deployment configured no default" };
    const chosenThinking = definition.effective.thinking === null
      ? (host.defaultThinkingLevel ?? "off")
      : host.resolveThinkingLevel(definition.effective.thinking);
    if (chosenThinking === undefined || chosenThinking === null) return { ok: false, code: "unknown_thinking", message: "the definition " + definition.name + " asks for thinking level " + String(definition.effective.thinking) + ", which this runtime does not have" };
    // The tools the definition names must really exist in what the child selects: the runtime drops an unknown tool name
    // silently, so this seam refuses instead (spec D10, A13).
    const extensions = await host.childExtensions(workspaceId);
    const available = new Map<string, { name: string }>();
    for (const extension of extensions) for (const tool of extension.tools ?? []) available.set(tool.name, tool as { name: string });
    const missing = definition.effective.tools.filter((name) => !available.has(name));
    if (missing.length > 0) return { ok: false, code: "tool_unavailable", message: "the definition " + definition.name + " asks for " + missing.join(", ") + ", which this execution workspace does not provide" };
    const depth = await depthOf(host, delegating);
    if (depth === undefined) return { ok: false, code: "unknown_conversation", message: "this conversation is not readable, so its delegation depth is unknown" };
    // An over-limit request is refused with its own reason, before anything is created: it never becomes hidden queue
    // work, which is what "no second scheduler" means in practice (spec D12, A15).
    if (depth + 1 > host.limits.maxDepth) return { ok: false, code: "depth_exceeded", message: "a child at depth " + (depth + 1) + " may not delegate; the limit is " + host.limits.maxDepth };
    const active = await host.activeChildren(delegating);
    if (active >= host.limits.maxConcurrentChildren) return { ok: false, code: "children_exceeded", message: "this conversation already has " + active + " children at work; the limit is " + host.limits.maxConcurrentChildren };
    const spawned = await host.spawn({
      requestId,
      ownership: {
        kind: "created-task",
        create: (tx) => tx.createTask(
          SubagentAnchorTask,
          strategy === "compact"
            ? { dispatchId: requestId, delegatingConversationId: delegating, preparation: "compact" }
            : { dispatchId: requestId, delegatingConversationId: delegating },
          { ownership: { kind: "conversation" }, conversationId: conversationKey(delegating), background: true },
        ),
        created: async (tx, record) => {
          const dispatch = await tx.doc(DispatchDoc, conversationKey(delegating), requestId, null);
          dispatch.version = 1;
          dispatch.dispatchId = requestId;
          dispatch.requestId = requestId;
          dispatch.task = request.task;
          dispatch.childConversationId = String(record.id);
          dispatch.anchorTaskId = record.owner === undefined ? undefined : String(record.owner.taskId);
          dispatch.submissionRequestId = requestId;
          dispatch.definitionName = definition.name;
          dispatch.preparation = strategy === "fork" || strategy === "compact" ? strategy : undefined;
          dispatch.createdAt = Date.now();
        },
      },
      ...(source === undefined ? {} : { source }),
      agent: {
        model: chosen.model,
        thinkingLevel: chosenThinking,
        extensions: [...extensions],
        tools: definition.effective.tools.map((name) => available.get(name)! as never),
        modelTools: null,
        instructions: definition.effective.instructions,
        cwd: "/",
      },
      createdBy: delegating,
      displayParentId: delegating,
      workspaceId,
      provenance: {
        origin: "agent",
        definition: { hostId: definition.source.hostId, scope: definition.source.scope, name: definition.name },
        context: {
          strategy,
          ...(source === undefined ? {} : { sourceConversationId: source.conversationId, sourceEntryId: source.entryId }),
        },
      },
    });
    return {
      ok: true,
      childConversationId: spawned.conversationId,
      dispatchId: requestId,
      requestId,
      created: spawned.created,
      definition: definition.name,
      displayParentId: delegating,
    };
  }

  /**
   * Give a conversation that already exists one more task, or answer the dispatch this identity already made.
   *
   * The target keeps its id, its history, its creator, its display parent, its native owner and its configuration: only
   * a new task is admitted. A target the user stopped refuses here, before anything is recorded, so a refused dispatch
   * leaves no trace a later surface could read as a delegation (spec D02, D05, D07, A09).
   *
   * `commit` is the caller's own commit when it has one — a model tool commits on its call's line, which is what
   * attributes the record to the call — and the host's otherwise.
   */
  async function dispatch(request: DispatchRequest, commit: SubagentCommit = (change) => host.commit(change)): Promise<DispatchAnswer> {
    const { delegating, requestId, targetConversationId } = request;
    if (request.task.trim() === "") return { ok: false, code: "invalid_request", message: "a dispatch needs the conversation's complete next task" };
    // A conversation giving itself a task is not a dispatch: it would make the caller its own delegated child.
    if (targetConversationId === delegating) return { ok: false, code: "self_dispatch", message: "a dispatch addresses another conversation; this call is already running in " + delegating };
    const answered = await host.existingDispatch(delegating, requestId);
    if (answered !== undefined) {
      const record = await host.dispatch(delegating, requestId);
      return { ok: true, conversationId: answered.childConversationId, dispatchId: answered.dispatchId, requestId, submissionId: record?.submissionId ?? "" };
    }
    const dispatched = await host.send(targetConversationId, { requestId, caller: "agent", content: [{ type: "text", text: request.task }], whenBusy: "followUp" });
    if (!dispatched.ok) return { ok: false, code: dispatched.code, message: dispatched.message };
    // A resume that is still draining admitted nothing, so there is no submission for a report to wait on.
    if (dispatched.submissionId === undefined) return { ok: false, code: "resume_stopping", message: "the previous stop of " + targetConversationId + " is still draining, so no task was admitted; ask again once it is idle" };
    // The record and the reporter are one commit: the dispatch that names the child submission and the background task
    // that waits it out exist together, so a crash cannot leave a dispatch nothing will ever report (spec D04).
    await commit(async (tx: Tx) => {
      const record = await tx.doc(DispatchDoc, conversationKey(delegating), requestId, null);
      if (record.reporterTaskId !== undefined) return;
      record.version = 1;
      record.dispatchId = requestId;
      record.requestId = requestId;
      record.task = request.task;
      record.childConversationId = targetConversationId;
      record.submissionRequestId = requestId;
      record.submissionId = dispatched.submissionId;
      record.createdAt = Date.now();
      const created = await tx.createTask(reporter, { dispatchId: requestId, delegatingConversationId: delegating }, { ownership: { kind: "conversation" }, conversationId: conversationKey(delegating), background: true });
      record.reporterTaskId = String(created);
    });
    return { ok: true, conversationId: targetConversationId, dispatchId: requestId, requestId, submissionId: dispatched.submissionId };
  }

  return { delegate, dispatch, reporter };
}

/** The details one delegation answer hands a program, in the shape both a tool result and an HTTP body can carry. */
export function delegateDetails(answer: Extract<DelegateAnswer, { ok: true }>): JsonValue {
  return copyJson({
    childConversationId: answer.childConversationId,
    dispatchId: answer.dispatchId,
    requestId: answer.requestId,
    created: answer.created,
    ...(answer.definition === undefined ? {} : { definition: answer.definition }),
    displayParentId: answer.displayParentId,
    ...(answer.preparationRetried === true ? { preparationRetried: true } : {}),
  }, { omitUndefinedProperties: true }) as JsonValue;
}

export type { ExistingDispatch, AgentChange };
