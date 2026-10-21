/**
 * One stage of ticket 06's recovery matrix, as its own process over a test-owned SQLite file.
 *
 * The stage composes the real pieces through public seams (`subagents-crash-harness.ts`), creates one parent
 * conversation, turns delegation on for it, and asks it to delegate with a deterministic tool-call id. It then kills
 * itself with SIGKILL inside one **named** window, with no clean close, so the next stage reads exactly what was durable
 * at that point.
 *
 * Each window is pinned at the seam that really separates the two states, not by holding a model response:
 *
 * - `commit`: the kill runs **synchronously inside the commit publication** that carries the new child conversation —
 *   the commit that also created the anchor task and the dispatch record. The scheduler's drain is a microtask and
 *   cannot run inside a synchronous listener, so the child is committed while its initial admission is not yet durable.
 * - `receipt`: the `agent_spawn` registration is wrapped through the extension's own native `wraps` seam. The wrapper
 *   runs the real tool, waits until the child's initial submission is durable, and kills **before it returns** — so the
 *   child is admitted while the `pi.tool` task that called it has committed no result entry.
 *
 * The child's own model request is also never answered, which keeps a child *answer* out of both windows, but the facts
 * each stage prints are the ones it read from the store at its own kill point.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DispatchDoc } from "../src/subagents/host.ts";
import { openCrashHarness, CRASH_WORKSPACE } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , dbPath, root, home, mode = "commit"] = process.argv;
assert.ok(dbPath !== undefined && root !== undefined && home !== undefined, "usage: subagents-crash-child <db> <root> <home> [commit|receipt|prepare|parked|send]");
assert.ok(mode === "commit" || mode === "receipt" || mode === "prepare" || mode === "parked" || mode === "send", "mode is commit, receipt, prepare, parked or send");
const CALL_ID = mode === "commit" ? "call-crash-commit" : mode === "receipt" ? "call-crash-receipt" : mode === "prepare" ? "call-crash-prepare" : mode === "parked" ? "call-crash-parked" : "call-crash-send-spawn";
/** Ticket 08's window: the **second** dispatch to an existing child, whose admission is a different seam from a spawn's. */
const SEND_CALL_ID = "call-crash-send";
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
// The `prepare` and `parked` windows need a definition that asks for a context preparation; the other two use a plain one.
await writeFile(join(root, ".pi", "agents", "worker.md"), mode === "prepare" || mode === "parked"
  ? "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: compact\n---\n\nbody\n"
  : "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

/** The facts one stage states before it dies, read from the store at the kill point. */
type Facts = {
  mode: string;
  parentId: string;
  childId: string;
  callId: string;
  checkpoint: string;
  admissionDurable: boolean;
  toolResultCommitted: boolean;
  anchorTaskId?: string;
  submissionId?: string;
  submissionStatus?: string;
  compactionTaskId?: string;
  preparationFailedTaskId?: string;
  /** The child's own first task, when the window needed the child to run one before the second dispatch. */
  firstTask?: string;
};

let parentId = "";
let crash: Awaited<ReturnType<typeof openCrashHarness>> | undefined;

/**
 * Kill inside the commit that carries the child conversation, before anything below it has run.
 *
 * Both facts this window claims are read **from the publication itself**, synchronously, so neither can race the
 * scheduler: a publication is exactly the set of writes that one commit made. The creating commit writes the child
 * record, the anchor task and the dispatch document, and the anchor's `admit` phase is a later commit, so it cannot be
 * part of this one; the calling `pi.tool` task's result entry is written only after the tool returns, which is later
 * still. The stage therefore states that the child is committed while its initial admission and the calling call's
 * receipt are not — the same facts this process reads back from the reopened store.
 */
const killAtChildCommit = (publication: CommitPublication): void => {
  if (parentId === "") return;
  for (const change of publication.changes) {
    if (change.type !== "conversation" || String(change.value.id) === parentId) continue;
    const childId = String(change.value.id);
    const admittedHere = publication.changes.some((candidate) => candidate.type === "submission" && String(candidate.value.conversationId) === childId);
    const resultHere = publication.changes.some((candidate) => candidate.type === "entry" && candidate.value.kind === "pi.tool-result");
    const facts: Facts = { mode, parentId, childId, callId: CALL_ID, checkpoint: "child-committed", admissionDurable: admittedHere, toolResultCommitted: resultHere };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return;
  }
};

/**
 * Kill inside the commit that creates the **preparation** of a child whose definition asked for one.
 *
 * The creating commit has already written the child, its inherited history and the anchor; this window is the anchor's
 * own next commit, the one that creates the compaction task. A publication is exactly the writes of one commit, so the
 * stage states from the publication itself that the preparation task exists while the child has no submission: the
 * anchor admits the task text only in a later commit, after the preparation has settled. Nothing is read back from the
 * scheduler, which is what keeps the claimed fact from racing the work it is a claim about.
 */
const killAtPreparationCommit = (publication: CommitPublication): void => {
  if (parentId === "") return;
  for (const change of publication.changes) {
    if (change.type !== "task" || change.value.kind !== "pi.compaction") continue;
    const childId = String(change.value.conversationId);
    const admittedHere = publication.changes.some((candidate) => candidate.type === "submission" && String(candidate.value.conversationId) === childId);
    const facts: Facts = { mode, parentId, childId, callId: CALL_ID, checkpoint: "preparation-started", admissionDurable: admittedHere, toolResultCommitted: false, compactionTaskId: String(change.value.id) };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return;
  }
};

/**
 * Kill inside the commit that **states** a preparation failure.
 *
 * The window is the publication that writes the failure onto the dispatch record, which is the last durable fact of a
 * failed preparation and the state a caller's retry is answered from. It is read from the publication itself — the
 * document incarnation that carries the failure id and the reason — so the stage states that the failure is durable
 * while the child has no submission and the anchor is still live. What this proves is that the parking is store state
 * rather than a live invocation: nothing about it was written by a clean close.
 */
const killAtParkedFailure = (publication: CommitPublication): void => {
  if (parentId === "") return;
  for (const change of publication.changes) {
    if (change.type !== "document" || change.record.kind !== DispatchDoc.definition.kind || change.value === null) continue;
    const value = change.value as { preparationFailedTaskId?: string; preparationError?: string; childConversationId?: string };
    if (value.preparationFailedTaskId === undefined || value.childConversationId === undefined) continue;
    const childId = value.childConversationId;
    const admittedHere = publication.changes.some((candidate) => candidate.type === "submission" && String(candidate.value.conversationId) === childId);
    const facts: Facts = { mode, parentId, childId, callId: CALL_ID, checkpoint: "preparation-failed", admissionDurable: admittedHere, toolResultCommitted: false, preparationFailedTaskId: value.preparationFailedTaskId };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return;
  }
};

/**
 * Kill inside the commit that admits a **second** dispatch to a conversation that already exists.
 *
 * Ticket 07 pinned a spawn's two windows; this one pins `agent_send`'s, which is a different seam: the admission is a
 * native submission under the caller's own request id, and the dispatch record that names it — with the reporter that
 * will deliver it — is written by a **later** commit. A publication is exactly the writes of one commit, so this stage
 * states from the publication itself that the admission is durable while no dispatch record for it exists: that is the
 * window in which a replay could admit the task twice, and the window the caller's stable identity has to close.
 */
const killAtSendAdmission = (publication: CommitPublication): void => {
  if (parentId === "") return;
  for (const change of publication.changes) {
    if (change.type !== "submission" || change.value.requestId !== parentId + ":" + SEND_CALL_ID) continue;
    const childId = String(change.value.conversationId);
    // The dispatch record is written by the tool's **later** commit, so this publication cannot carry it: the reopened
    // store confirms the same fact below, and it is what makes the replay's own identity the thing under test.
    const facts: Facts = { mode, parentId, childId, callId: SEND_CALL_ID, checkpoint: "send-admitted", admissionDurable: true, toolResultCommitted: false, submissionId: String(change.value.id), submissionStatus: change.value.status };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return;
  }
};

/**
 * The `receipt` window's seam: the real `agent_spawn` registration, wrapped by the native wrapper an extension would
 * carry. The wrapper kills after the child's admission is durable and before it returns, so the calling tool task is
 * still running and no result entry for this call exists.
 */
const wrapSpawn = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    await tool.execute(args as never, api, context);
    const delegating = Number(api.conversationId) as ConversationId;
    const requestId = String(api.conversationId) + ":" + api.callId;
    const first = await api.snapshot(DispatchDoc, delegating, requestId, context);
    assert.ok(first?.childConversationId !== undefined, "the real tool created a child");
    const childId = Number(first.childConversationId) as ConversationId;
    const submissionRequestId = first.submissionRequestId ?? requestId;
    // Wait for the anchor's own commit, which records the submission it admitted: strictly after the submission itself
    // became durable, so waiting on it is waiting on the stronger fact.
    const deadline = Date.now() + 20_000;
    let dispatch = first;
    while (dispatch.submissionId === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      dispatch = (await api.snapshot(DispatchDoc, delegating, requestId, context)) ?? dispatch;
    }
    assert.ok(dispatch.submissionId !== undefined, "the anchor admitted the child's initial submission");
    const submission = await api.commit((tx) => tx.submissionByRequest(childId, submissionRequestId), context);
    assert.ok(submission !== undefined, "the admitted submission is readable");
    const facts: Facts = {
      mode,
      parentId,
      childId: String(childId),
      callId: CALL_ID,
      checkpoint: "child-admitted",
      admissionDurable: true,
      toolResultCommitted: false,
      ...(dispatch.anchorTaskId === undefined ? {} : { anchorTaskId: dispatch.anchorTaskId }),
      submissionId: String(submission.id),
      submissionStatus: submission.status,
    };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return await new Promise<never>(() => {});
  },
});

crash = await openCrashHarness(dbPath, {
  root,
  home,
  // A preparation only really summarizes when the policy leaves something to compact: the `parked` window needs a
  // summarizer request that fails, which a short context with nothing to keep is what produces.
  ...(mode === "parked" ? { settings: { compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0, backgroundTokens: 0 } } } : {}),
  ...(mode === "commit" ? { onCommit: killAtChildCommit } : mode === "prepare" ? { onCommit: killAtPreparationCommit } : mode === "parked" ? { onCommit: killAtParkedFailure } : mode === "send" ? { onCommit: killAtSendAdmission } : { wrapSpawn }),
  script: (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
      const lastUser = messages.findLast((message) => message.role === "user");
      // The child's own request is never answered: an answer would be a receipt, and none of these windows has one.
      // The `send` window is the exception: its second dispatch only exists after the child's first task has settled.
      if (mode === "send") {
        if (JSON.stringify(lastUser?.content ?? "").includes("crash send work")) return fauxAssistantMessage("child answer two");
        if (JSON.stringify(lastUser?.content ?? "").includes("crash work")) return fauxAssistantMessage("child answer one");
      } else if (lastUser !== undefined && JSON.stringify(lastUser.content ?? "").includes("crash work")) {
        return await new Promise<never>(() => {});
      }
      // The `parked` window's preparation must fail, so its summarizer answers with a tool call, which is not a summary.
      const head = messages[0];
      if (head !== undefined && head.role === "system" && JSON.stringify(head.content ?? "").includes("context summarization assistant")) {
        return mode === "parked" ? fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" }) : fauxAssistantMessage("## Goal\nsummary");
      }
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) {
        // The `send` window's second dispatch: the same child, a task of its own, under the caller's own stable id.
        if (mode === "send" && !messages.some((message) => message.role === "toolResult" && message.toolName === "agent_send")) {
          const spawned = messages.findLast((message) => message.role === "toolResult" && message.toolName === "agent_spawn");
          const childId = /child ([0-9]+) is /.exec(JSON.stringify(spawned?.content ?? ""))?.[1];
          assert.ok(childId !== undefined, "the spawn result names the child it created");
          return fauxAssistantMessage([fauxToolCall("agent_send", { conversationId: childId, task: "crash send work" }, { id: SEND_CALL_ID })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("parent done");
      }
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "crash work" }, { id: CALL_ID })], { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
  },
});

const parent = await crash.operations.spawn({
  requestId: "crash-parent",
  ownership: { kind: "ownerless" },
  workspaceId: CRASH_WORKSPACE,
  agent: { model: SERVER_MODEL, extensions: [crash.extension] },
});
parentId = parent.conversationId;
await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "crash-turn" }, BACKGROUND_CONTEXT);

// A fixture that never reaches its window is a failure, not a hang: the window is stated by the mode.
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
console.error("the " + mode + " window was never reached; the fixture refuses to claim a kill it did not make");
process.exit(1);
