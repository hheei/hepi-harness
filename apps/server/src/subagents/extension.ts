/**
 * The optional subagent extension: the model-facing delegation tools, and the task definition their children are owned
 * by.
 *
 * The registered tools are exactly agent_spawn, agent_send, agent_stop, agent_get and agent_read. conversation_* stays
 * the underlying API and is never a model tool: the five `agent_*` tools are the whole model-facing surface, and every
 * one of them is a caller of the same operations the HTTP surfaces use (spec D01, D02).
 *
 * agent_send gives a conversation that already exists another task. It creates no conversation: the target keeps its id,
 * its history, its creator, its display parent, its native owner and its configuration, and each explicit send is a
 * dispatch of its own with its own admission and its own report back to the conversation that asked for it. agent_stop
 * holds a conversation through the same atomic control a user's stop uses, so an agent stop never downgrades a user's
 * stop and a user's stop is never cleared by a model (spec D02, D05, D07).
 *
 * The trusted caller is the host's own statement: the delegating conversation and the call come from
 * ToolExecutionApi.conversationId and .callId, never from the arguments, so a model cannot claim to be another
 * conversation and cannot override the policy, the plugin set or the context source. The definition is resolved on the
 * Execution Host the delegating conversation runs on, and the child inherits that same binding (spec D02, D10, D11).
 *
 * The tool is replay-safe: after a crash it reruns, and the rerun answers the child the first attempt created — the
 * creation request identity is the call's own id, and the child, its anchor task and its dispatch record were committed
 * together, so recovery never makes a second child, a second submission or a second side effect (spec D04, A19).
 */

import { Type } from "@earendil-works/pi-ai";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  type Extension,
  type ModelRef,
  type ToolDiagnostic,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { errorText } from "@hepi/protocol/error-text";
import { SubagentAnchorTask } from "./anchor.ts";
import { createSubagentDelegation, delegateDetails } from "./delegate.ts";
import { DispatchDoc, preparationUnretried, SUBAGENT_ANCHOR_TASK, SUBAGENT_EXTENSION, type ExistingDispatch, type SubagentHost } from "./host.ts";

/**
 * The limits this ticket fixes for delegation. They are host facts, checked before anything is created, so an
 * over-limit request is refused instead of becoming hidden queue work (spec D12). A depth limit of 1 says a
 * conversation of its own may delegate and a child may not — the child also does not select this extension — and the
 * concurrency bound is per delegating conversation.
 */
export const SUBAGENT_LIMITS = { maxDepth: 1, maxConcurrentChildren: 4 } as const;

/** A refusal a model can read: the message is the answer, and the code is the diagnostic a UI can name. */
function refusal(code: string, message: string): ToolExecutionResult {
  const diagnostic: ToolDiagnostic = { severity: "error", code, message };
  return { output: [{ type: "text", text: message }], isError: true, diagnostics: [diagnostic] };
}

/** The result a tool hands the model, plus the structured details a UI or a program reads. */
function answer<TDetails extends JsonValue>(text: string, details: TDetails): ToolExecutionResult<TDetails> {
  return { output: [{ type: "text", text }], details };
}

/** Whether the argument object carries a key this tool does not accept; the offending key is named. */
function unexpected(args: object, allowed: readonly string[]): string | undefined {
  const permitted = new Set(allowed);
  return Object.keys(args).find((key) => !permitted.has(key));
}

const SpawnParameters = Type.Object({
  name: Type.String({ description: "The agent definition to run the child as, by its name on this workspace's execution host." }),
  task: Type.String({ description: "The complete task for the child. It is the child's own input, never host configuration." }),
});

const SendParameters = Type.Object({
  conversationId: Type.String({ description: "The conversation to give another task to. It keeps its own identity, history and configuration; only a new task is admitted." }),
  task: Type.String({ description: "The complete task for that conversation. It is the conversation's own input, never host configuration." }),
});

const StopParameters = Type.Object({
  conversationId: Type.String({ description: "The conversation whose own work to stop." }),
});

const GetParameters = Type.Object({
  conversationId: Type.Optional(Type.String({ description: "One conversation's identity, relations and configuration." })),
  requestId: Type.Optional(Type.String({ description: "With conversationId: one delegation's own record on that conversation, including the context preparation it asked for and any preparation failure." })),
  createdBy: Type.Optional(Type.String({ description: "List conversations this conversation id created." })),
  displayParentId: Type.Optional(Type.String({ description: "List conversations displayed beneath this conversation id." })),
  ownerConversationId: Type.Optional(Type.String({ description: "List conversations whose owner task belongs to this conversation id." })),
  workspaceId: Type.Optional(Type.String({ description: "List conversations bound to this execution workspace." })),
  limit: Type.Optional(Type.Number({ description: "Maximum rows to return; the listing is paged by conversation id." })),
  cursor: Type.Optional(Type.String({ description: "Continue a listing after this conversation id." })),
});

const ReadParameters = Type.Object({
  conversationId: Type.String({ description: "The conversation whose raw history is read." }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start at." })),
  limit: Type.Optional(Type.Number({ description: "Maximum lines; defaults to 2000 lines or 50 KiB." })),
  entryId: Type.Optional(Type.String({ description: "Read one entry instead of the whole history." })),
  blockIndex: Type.Optional(Type.Number({ description: "Read one content block of the named entry, which is how an image is read." })),
  tail: Type.Optional(Type.String({ description: "Pin the snapshot's end, as a previous read stated it." })),
  cursor: Type.Optional(Type.Object({
    version: Type.Number(),
    entryId: Type.String(),
    blockIndex: Type.Number(),
    blockLine: Type.Number(),
    charOffset: Type.Number(),
    offset: Type.Number(),
    tail: Type.String(),
  }, { description: "The exact position a previous page ended at, as its details.next stated it." })),
});

/** The output one read page carries: its text lines, or the one image the page is. */
function readOutput(result: Awaited<ReturnType<SubagentHost["read"]>>): ToolExecutionResult["output"] {
  const image = result.output.find((part) => part.type === "image");
  if (image !== undefined) return [{ type: "image", data: image.data, mimeType: image.mimeType }];
  return result.output.filter((part) => part.type === "text").map((part) => ({ type: "text" as const, text: part.text }));
}

/**
 * The answer a replay of an already-created delegation gets: the child the first attempt created, read back from the
 * core state, with the identity that request already owns. Nothing is created, nothing is checked again, and the
 * caller cannot tell a replay from the original answer except by `created` (spec D04, A19).
 */
async function replayAnswer(host: SubagentHost, dispatch: ExistingDispatch, delegating: string, requestId: string, retried: boolean): Promise<ToolExecutionResult> {
  const child = await host.get(dispatch.childConversationId);
  return answer(
    "child " + dispatch.childConversationId + " (dispatch " + requestId + ") was already created by this call. It runs on its own."
    + (retried ? " Its context preparation had failed, so this replay asked for it to be prepared again; the child still admits nothing until that succeeds." : ""),
    copyJson({
      childConversationId: dispatch.childConversationId,
      dispatchId: dispatch.dispatchId,
      requestId,
      created: false,
      ...(retried ? { preparationRetried: true } : {}),
      ...(dispatch.definitionName === undefined ? {} : { definition: dispatch.definitionName }),
      displayParentId: delegating,
      ...(child === undefined ? {} : { child: child as unknown as JsonValue }),
    }, { omitUndefinedProperties: true }) as JsonValue,
  );
}

/**
 * Build the one extension, over the host port the composition supplies.
 *
 * The five tools are the whole model-facing surface, and the two that delegate are callers of the **same** seam the
 * Web's own delegation route calls (`delegate.ts`): a browser's quick create and a model's `agent_spawn` cannot
 * disagree about what a delegation is, which definition it resolves or which limits it checks. Nothing about the tool
 * surface — the parameters, the trusted caller, the replay identity — is delegated to that seam: the tool states those
 * and the seam states the business operation.
 */
export function createSubagentExtension(host: SubagentHost, delegation = createSubagentDelegation(host)): Extension {
  // The delegation seam is the caller's when it has one — the backend builds it once and hands the same one to its own
  // delegation route — and this extension's own otherwise. Either way the anchor creates the reporter per admission by
  // its registered name, so both definitions are installed by this one extension and neither holds the other's
  // composition.
  const { delegate, dispatch: dispatchTask, reporter } = delegation;
  const spawn = defineTool({
    name: "agent_spawn",
    parameters: SpawnParameters,
    description: "Create a durable child conversation from a configured agent definition and give it one task, then return immediately with the child's identity. The child runs on its own; read it later with agent_get and agent_read.",
    replay: "safe",
    execute: async (args, api: ToolExecutionApi): Promise<ToolExecutionResult> => {
      const unknown = unexpected(args, ["name", "task"]);
      if (unknown !== undefined) return refusal("unsupported_parameter", "agent_spawn takes only a definition name and a task; the argument " + unknown + " is host configuration the model does not set");
      if (args.name.trim() === "") return refusal("invalid_request", "name must be a configured agent definition");
      if (args.task.trim() === "") return refusal("invalid_request", "task must be the child's complete task");
      // The trusted caller is the host's own statement about this call, never anything the model wrote. The request
      // identity names the delegating conversation as well as the call, because the session-scoped creation index is
      // global: a call id alone could collide with another conversation's, and the dedupe would answer the wrong child.
      const delegating = String(api.conversationId);
      const requestId = delegating + ":" + api.callId;
      // The trusted caller is the host's own statement about this call, never anything the model wrote. The request
      // identity names the delegating conversation as well as the call, because the session-scoped creation index is
      // global: a call id alone could collide with another conversation's, and the dedupe would answer the wrong child.
      // The seam below is the same one the Web's own delegation route calls, so both surfaces resolve the definition,
      // check the same limits and write the same dispatch record (spec D01, D10, D12).
      const answered = await delegate({ delegating, requestId, definition: args.name, task: args.task });
      if (!answered.ok) return refusal(answered.code, answered.message);
      const child = await host.get(answered.childConversationId);
      return answer(
        "child " + answered.childConversationId + " is " + (answered.definition ?? args.name) + " (dispatch " + requestId + ")" + (answered.created ? "" : ", already created by this call") + ". It runs on its own."
        + (answered.preparationRetried === true ? " Its context preparation had failed, so this replay asked for it to be prepared again; the child still admits nothing until that succeeds." : ""),
        copyJson({
          ...delegateDetails(answered) as object,
          ...(child === undefined ? {} : { child: child as unknown as JsonValue }),
        }, { omitUndefinedProperties: true }) as JsonValue,
      );
    },
  });

  const get = defineTool({
    name: "agent_get",
    parameters: GetParameters,
    description: "Read one conversation's identity — its creator, display parent, native owner and fork source, its references, and its credential-free configuration — one delegation's own record on a conversation, or list conversations by those relations.",
    execute: async (args): Promise<ToolExecutionResult> => {
      const unknown = unexpected(args, ["conversationId", "requestId", "createdBy", "displayParentId", "ownerConversationId", "workspaceId", "limit", "cursor"]);
      if (unknown !== undefined) return refusal("unsupported_parameter", "agent_get does not accept the argument " + unknown);
      if (args.requestId !== undefined) {
        if (args.conversationId === undefined) return refusal("invalid_request", "requestId needs the conversationId the delegation was made on");
        const dispatch = await host.dispatch(args.conversationId, args.requestId);
        if (dispatch === undefined) return refusal("not_found", "conversation " + args.conversationId + " records no delegation " + args.requestId);
        // A failed preparation is a fact about the delegation, so it is reported as the answer's own status rather than
        // left for the caller to infer from a child that produced nothing.
        // A failure the caller has not retried is the delegation's current status; one that has been retried is a
        // past attempt, so the answer says the delegation is preparing again rather than reporting a stale reason as
        // the state of a delegation that is now working on it.
        const body = { ...dispatch, status: preparationUnretried(dispatch) ? "preparation_failed" : dispatch.preparationError === undefined ? "dispatched" : "preparation_retrying" };
        return answer(JSON.stringify(body, null, 2), copyJson(body as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonValue);
      }
      if (args.conversationId !== undefined) {
        const info = await host.get(args.conversationId);
        if (info === undefined) return refusal("not_found", "no conversation has id " + args.conversationId);
        return answer(JSON.stringify(info, null, 2), copyJson(info as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonValue);
      }
      const listed = await host.list({
        ...(args.createdBy === undefined ? {} : { createdBy: args.createdBy }),
        ...(args.displayParentId === undefined ? {} : { displayParentId: args.displayParentId }),
        ...(args.ownerConversationId === undefined ? {} : { ownerConversationId: args.ownerConversationId }),
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      });
      if (!listed.ok) return refusal(listed.code, listed.message);
      const body = { conversations: listed.conversations, ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }) };
      return answer(JSON.stringify(body, null, 2), copyJson(body as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonValue);
    },
  });

  const read = defineTool({
    name: "agent_read",
    parameters: ReadParameters,
    description: "Read a conversation's raw history, one entry of it, or one content block of one entry, with the same bounded paging, image support and continuation position the backend's own read uses.",
    execute: async (args): Promise<ToolExecutionResult> => {
      const unknown = unexpected(args, ["conversationId", "offset", "limit", "entryId", "blockIndex", "tail", "cursor"]);
      if (unknown !== undefined) return refusal("unsupported_parameter", "agent_read does not accept the argument " + unknown);
      try {
        const result = await host.read({
          conversationId: args.conversationId,
          ...(args.offset === undefined ? {} : { offset: args.offset }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
          ...(args.entryId === undefined ? {} : { entryId: args.entryId }),
          ...(args.blockIndex === undefined ? {} : { blockIndex: args.blockIndex }),
          ...(args.tail === undefined ? {} : { tail: args.tail }),
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        });
        return { output: readOutput(result), details: copyJson(result as unknown as JsonValue, { omitUndefinedProperties: true }) as JsonValue };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "read_failed";
        return refusal(code, errorText(error));
      }
    },
  });

  /**
   * The tool set this ticket fixes: a second task for a conversation that already exists, and a stop of one.
   *
   * A send is a dispatch, and every dispatch is identified by the **caller's own** stable request id — the delegating
   * conversation and this call's id, both the host's statement and never the model's. That identity is what makes the
   * whole thing recoverable in either crash window: the task text is admitted natively under it, so a replay after the
   * admission but before this record was written re-admits the same id and is answered with the submission the first
   * attempt made — one task, never two — while a replay after the record exists is answered from the record itself and
   * re-validates nothing (spec D04, D05, A19).
   */
  const send = defineTool({
    name: "agent_send",
    parameters: SendParameters,
    description: "Give a conversation that already exists one more task and return immediately. It keeps its own identity, history and configuration; the result of this task comes back to this conversation as its own report.",
    replay: "safe",
    execute: async (args, api: ToolExecutionApi, context): Promise<ToolExecutionResult> => {
      const unknown = unexpected(args, ["conversationId", "task"]);
      if (unknown !== undefined) return refusal("unsupported_parameter", "agent_send takes only a conversation id and a task; the argument " + unknown + " is host configuration the model does not set");
      if (args.task.trim() === "") return refusal("invalid_request", "task must be the conversation's complete next task");
      const delegating = String(api.conversationId);
      const requestId = delegating + ":" + api.callId;
      // The same seam the Web's own "delegate again" control calls, with this call's own commit: the dispatch record
      // and the reporter that will deliver the result are written on the call's line, so a crash cannot leave a
      // dispatch nothing will report (spec D04, D05, A19).
      const dispatched = await dispatchTask({ delegating, requestId, targetConversationId: args.conversationId, task: args.task }, (change) => api.commit(change, context));
      if (!dispatched.ok) return refusal(dispatched.code, dispatched.message);
      const child = await host.get(args.conversationId);
      return answer(
        "conversation " + args.conversationId + " was given this task (dispatch " + requestId + "). It keeps its own history; the result comes back here as a report."
        + (dispatched.submissionId === "" ? " It was already dispatched by this call." : ""),
        copyJson({
          conversationId: args.conversationId,
          dispatchId: dispatched.dispatchId,
          requestId,
          ...(dispatched.submissionId === "" ? {} : { submissionId: dispatched.submissionId }),
          ...(child === undefined ? {} : { child: child as unknown as JsonValue }),
        }, { omitUndefinedProperties: true }) as JsonValue,
      );
    },
  });

  /**
   * A stop of another conversation's own work, through the same atomic control a user's stop uses.
   *
   * The model's stop is an *agent* stop, and that is the whole safety property: the runtime's control record keeps the
   * stop source, so an agent stop can never downgrade a user's, a user's stop refuses this call outright, and a stop
   * this model recorded is one this model may explicitly resume. A conversation stopping itself is refused — the user
   * stops the conversation they are in, not the model (spec D02, D07, A09).
   */
  const stop = defineTool({
    name: "agent_stop",
    parameters: StopParameters,
    description: "Stop another conversation's own work and hold it. A user's stop is never downgraded by this, and this conversation cannot stop itself.",
    execute: async (args, api: ToolExecutionApi, context): Promise<ToolExecutionResult> => {
      const unknown = unexpected(args, ["conversationId"]);
      if (unknown !== undefined) return refusal("unsupported_parameter", "agent_stop takes only a conversation id; the argument " + unknown + " is host configuration the model does not set");
      const caller = String(api.conversationId);
      if (args.conversationId === caller) return refusal("self_stop", "a model cannot stop the conversation it is running in; the user stops it");
      const requestId = caller + ":" + api.callId;
      const stopped = await host.stop(args.conversationId, { requestId, stopSource: "agent" });
      if (!stopped.ok) return refusal(stopped.code, stopped.message);
      const body = copyJson({
        conversationId: args.conversationId,
        requestId,
        status: stopped.status,
        ...(stopped.reason === undefined ? {} : { reason: stopped.reason }),
        drain: stopped.drain,
        control: stopped.control as unknown as JsonValue,
        receipt: stopped.receipt as unknown as JsonValue,
      }, { omitUndefinedProperties: true }) as JsonValue;
      return answer(JSON.stringify(body, null, 2), body);
    },
  });

  return defineExtension({
    name: SUBAGENT_EXTENSION,
    tools: [spawn, send, stop, get, read],
    // The anchor definition is installed with the tools and resolves by name for every task, so a recovered anchor is
    // resumable even while no conversation selects this extension (spec D15, A01).
    tasks: [SubagentAnchorTask, reporter],
  });
}

export { SUBAGENT_ANCHOR_TASK, SUBAGENT_EXTENSION };
export { SUBAGENT_REPORTER_TASK } from "./host.ts";
export type { SubagentHost } from "./host.ts";
