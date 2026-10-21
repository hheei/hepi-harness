/**
 * Ticket 13's **combined** recovery chain: one store, two real SIGKILLs, one delegation.
 *
 * The individual windows are already pinned by their owning tickets (06's creation and admission, 07's settlement and
 * report admission). What nothing states yet is the chain: a process killed while a child is being admitted, a second
 * process that resumes that same child, lets it finish, and is killed again inside the publication that admits its
 * report — and a third process that finishes the work. Every identity has to be the first attempt's own at the end, and
 * nothing may be duplicated (spec D04, D05, D16, A19).
 *
 * Each stage prints one JSON facts line read from the publication at its own kill point; `final` prints what the third
 * process read after it let the recovered chain run to its end.
 *
 * Usage: node test/acceptance-chain-child.ts <chainA|chainB|final> <dbPath> <base>
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DispatchDoc, ReportDoc, SUBAGENT_ANCHOR_TASK } from "../src/subagents/host.ts";
import { openCrashHarness, CRASH_WORKSPACE, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, base] = process.argv;
assert.ok(stage !== undefined && dbPath !== undefined && base !== undefined, "usage: acceptance-chain-child <stage> <db> <base>");
assert.ok(stage === "chainA" || stage === "chainB" || stage === "final", "stage is chainA, chainB or final");
const CALL_ID = "call-chain";
const DISPATCH = (parentId: string): string => parentId + ":" + CALL_ID;
const root = join(base, "workspace");
const home = join(base, "home");
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

let parentId = "";
let childId = "";
let killed = false;
type Facts = { stage: string; parentId: string; childId: string; dispatchId: string; submissionId?: string; submissionStatus?: string; reportSubmissionId?: string; checkpoint: string };

/** Kill inside the publication that admits the child's submission, before the tool returns (the admission window). */
const wrapSpawn = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    await tool.execute(args as never, api, context);
    const delegating = Number(api.conversationId) as ConversationId;
    const requestId = String(api.conversationId) + ":" + api.callId;
    const first = await api.snapshot(DispatchDoc, delegating, requestId, context);
    assert.ok(first?.childConversationId !== undefined, "the real tool created a child");
    const submissionRequestId = first.submissionRequestId ?? requestId;
    const deadline = Date.now() + 20_000;
    let dispatch = first;
    while (dispatch.submissionId === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      dispatch = (await api.snapshot(DispatchDoc, delegating, requestId, context)) ?? dispatch;
    }
    const submission = await api.commit((tx) => tx.submissionByRequest(Number(first.childConversationId) as ConversationId, submissionRequestId), context);
    assert.ok(submission !== undefined, "the admitted submission is readable");
    killed = true;
    const facts: Facts = { stage, parentId, childId: String(first.childConversationId), dispatchId: requestId, submissionId: String(submission.id), submissionStatus: submission.status, checkpoint: "chain-admitted" };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return await new Promise<never>(() => {});
  },
});

/** Kill inside the publication that admits the child's **report** into the recipient's inbox (queued, not yet acked). */
const killAtReportAdmission = (publication: CommitPublication): void => {
  if (killed || parentId === "") return;
  for (const change of publication.changes) {
    if (change.type !== "submission") continue;
    const record = change.value;
    if (String(record.conversationId) !== parentId) continue;
    if (record.requestId !== DISPATCH(parentId) + ":report") continue;
    killed = true;
    const facts: Facts = { stage, parentId, childId, dispatchId: DISPATCH(parentId), reportSubmissionId: String(record.id), submissionStatus: record.status, checkpoint: "report-admitted" };
    console.log(JSON.stringify(facts));
    process.kill(process.pid, "SIGKILL");
    return;
  }
};

/** One controlled model: the child answers its task, the parent delegates once and then answers each report. */
const script = (faux: Parameters<NonNullable<Parameters<typeof openCrashHarness>[1]["script"]>>[0]): void => {
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
    const lastUser = messages.findLast((message) => message.role === "user");
    const text = lastUser === undefined ? "" : JSON.stringify(lastUser.content ?? "");
    if (text.includes("chain work")) return fauxAssistantMessage("chain child answer");
    if (text.startsWith("The delegated child ")) return fauxAssistantMessage("parent saw the chain report");
    if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent delegated");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "chain work" }, { id: CALL_ID })], { stopReason: "toolUse" });
  };
  faux.setResponses([respond]);
};

const open = (options: { wrapSpawn?: (tool: ToolRegistration) => ToolRegistration; onCommit?: (publication: CommitPublication) => void; startPaused?: boolean }): Promise<CrashHarness> => openCrashHarness(dbPath!, {
  root,
  home,
  ...(options.wrapSpawn === undefined ? {} : { wrapSpawn: options.wrapSpawn }),
  ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit }),
  ...(options.startPaused === true ? { startPaused: true } : {}),
  script,
});

const conversationIdOf = (value: string): ConversationId => Number(value) as ConversationId;
const userTextsOf = async (crash: CrashHarness, id: string): Promise<string[]> => {
  const conversation = await crash.harness.harness.conversation(conversationIdOf(id), BACKGROUND_CONTEXT);
  assert.ok(conversation !== undefined, "conversation " + id + " is readable");
  return (await conversation.context(BACKGROUND_CONTEXT)).entries.filter((entry) => entry.kind === "pi.user").map((entry) => {
    const message = (entry.model ?? []).findLast((candidate) => candidate.role === "user");
    const content = (message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") return content;
    return Array.isArray(content) ? content.filter((part) => (part as { type?: string }).type === "text").map((part) => (part as { text?: string }).text ?? "").join("") : "";
  });
};

if (stage === "chainA") {
  const crash = await open({ wrapSpawn });
  const parent = await crash.operations.spawn({ requestId: "chain-parent", ownership: { kind: "ownerless" }, workspaceId: CRASH_WORKSPACE, agent: { model: SERVER_MODEL, extensions: [crash.extension] } });
  parentId = parent.conversationId;
  await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "chain-turn" }, BACKGROUND_CONTEXT);
  const deadline = Date.now() + 30_000;
  while (!killed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  console.error("chainA never reached its window");
  process.exit(1);
}

// Both later stages reopen the store chainA left behind, paused, and read the parent it created.
const paused = await open(stage === "chainB" ? { onCommit: killAtReportAdmission, startPaused: true } : { startPaused: true });
const found = await paused.harness.harness.inspect(BACKGROUND_CONTEXT);
// The parent is the only ownerless conversation with a delegation record; its own anchor is the task that names it.
const dispatchCursor = await paused.harness.harness.commit((tx) => tx.scanTasks({ kind: SUBAGENT_ANCHOR_TASK }, 50, undefined), BACKGROUND_CONTEXT);
assert.ok(dispatchCursor.items.length > 0, "the recovered store holds the delegation's anchor");
const anchor = dispatchCursor.items[0]!;
parentId = String(anchor.conversationId);
const dispatch = await paused.harness.harness.snapshot(DispatchDoc, conversationIdOf(parentId), DISPATCH(parentId), BACKGROUND_CONTEXT);
assert.ok(dispatch?.childConversationId !== undefined, "the delegation record the first attempt wrote is readable");
childId = dispatch.childConversationId;

if (stage === "chainB") {
  // The second process resumes the same store: the child must run once, answer once, and its report must be admitted
  // once — the kill lands inside that admission, so the acknowledgement is what the crash takes.
  paused.harness.harness.resume();
  const deadline = Date.now() + 40_000;
  while (!killed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  console.error("chainB never reached its window");
  process.exit(1);
}

// The third process finishes the chain and states what it read.
paused.harness.harness.resume();
const deadline = Date.now() + 60_000;
let reportDelivered = false;
for (;;) {
  const record = await paused.harness.harness.snapshot(ReportDoc, conversationIdOf(parentId), DISPATCH(parentId), BACKGROUND_CONTEXT);
  if (record?.delivery === "delivered") { reportDelivered = true; break; }
  if (Date.now() > deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const childTexts = await userTextsOf(paused, childId);
const parentTexts = await userTextsOf(paused, parentId);
const parentEntries = await paused.harness.harness.commit((tx) => tx.scanEntries({ conversationId: conversationIdOf(parentId), order: "ascending" }, 200, undefined), BACKGROUND_CONTEXT);
const childEntries = await paused.harness.harness.commit((tx) => tx.scanEntries({ conversationId: conversationIdOf(childId), order: "ascending" }, 200, undefined), BACKGROUND_CONTEXT);
const record = await paused.harness.harness.snapshot(ReportDoc, conversationIdOf(parentId), DISPATCH(parentId), BACKGROUND_CONTEXT);
const taskCounts = await paused.harness.harness.commit(async (tx) => ({ anchors: (await tx.scanTasks({ conversationId: conversationIdOf(parentId), kind: SUBAGENT_ANCHOR_TASK }, 50, undefined)).items.length, conversations: (await tx.scanConversations({}, 200, undefined)).items.length }), BACKGROUND_CONTEXT);
console.log(JSON.stringify({
  stage,
  parentId,
  childId,
  dispatchId: DISPATCH(parentId),
  reportDelivered,
  childTexts,
  parentTexts,
  childAnswers: childEntries.items.filter((entry) => entry.kind === "pi.assistant").length,
  parentAnswers: parentEntries.items.filter((entry) => entry.kind === "pi.assistant").length,
  // The parent's own answers, named, so a replayed tool call's duplicate turn is stated instead of hidden by a count.
  parentAnswerTexts: parentEntries.items.filter((entry) => entry.kind === "pi.assistant").map((entry) => JSON.stringify((entry.model ?? []).map((message) => (message as { content?: unknown }).content ?? "")).slice(0, 120)),
  reportEntries: parentEntries.items.filter((entry) => entry.kind === "hepi.agent-report").length,
  anchors: taskCounts.anchors,
  conversations: taskCounts.conversations,
  report: record,
  submissions: found.submissions.length,
}));
await paused.close();
process.exit(0);
