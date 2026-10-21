/**
 * One stage of ticket 07's recovery matrix, as its own process over a test-owned SQLite file.
 *
 * The stage composes the real pieces through public seams (`subagents-crash-harness.ts`), creates one parent
 * conversation, delegates once with a deterministic tool-call id, and kills itself with SIGKILL inside one **named**
 * commit publication, with no clean close. Each window is pinned at the seam that really separates the two states
 * rather than by holding a model response:
 *
 * - `settled`: the kill runs synchronously inside the publication that settles the **child's** submission. That
 *   publication is the child's answer; the reporter's own `wait` phase resolves from it and commits the report record
 *   afterwards, so at this point the child is done and no report identity exists yet.
 * - `delivered`: the recipient is stopped first, so the report really queues. The kill runs synchronously inside the
 *   publication that **admits the report** into the recipient's inbox, which is after the reporter read the settled
 *   answer and before it commits its own acknowledgement.
 * - `legacy`: the delegation is created against the **pre-07 anchor definition**, which admits the child and creates no
 *   reporter, and the kill runs synchronously inside the publication that **places the child's initial submission** —
 *   so the database really is the one an installation that ran the older definition holds: an idle anchor, a dispatch
 *   record naming an unfinished child submission, and no reporter anywhere.
 *
 * The facts each stage prints are the ones it read from the store at its own kill point.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { DispatchDoc } from "../src/subagents/host.ts";
import { openCrashHarness, CRASH_WORKSPACE } from "./subagents-crash-harness.ts";
import { LegacyAnchorTask } from "./subagent-legacy-anchor.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , dbPath, base, mode = "settled"] = process.argv;
assert.ok(dbPath !== undefined && base !== undefined, "usage: subagent-report-crash-child <db> <base> [settled|delivered]");
assert.ok(mode === "settled" || mode === "delivered" || mode === "legacy", "mode is settled, delivered or legacy");
const CALL_ID = "call-1";
const root = join(base, "workspace");
const home = join(base, "home");
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

/** The facts one stage states before it dies, read from the publication at the kill point. */
type Facts = { mode: string; parentId: string; childId: string; dispatchId: string; submissionId?: string; submissionStatus?: string; reportSubmissionId?: string };

let parentId = "";
let childId = "";
let killed = false;
const dispatchId = (): string => parentId + ":" + CALL_ID;

/** Kill inside one named publication, synchronously, so nothing after it has run. */
const killAt = (publication: CommitPublication): void => {
  if (killed || parentId === "") return;
  const id = dispatchId();
  // The child's own conversation is created before anything this fixture reports on, and the publication that creates
  // it is the one fact that names it without polling: a read the fixture made between commits could miss the window
  // entirely, and this window is stated by the commit itself.
  for (const change of publication.changes) {
    if (change.type === "conversation" && String(change.value.id) !== parentId) childId = String(change.value.id);
  }
  if (mode === "legacy") {
    // The anchor's own admit commit, as the **pre-07 definition** wrote it: the dispatch record gains the child
    // submission and the anchor's checkpoint becomes idle, and no reporter is created anywhere. Killing inside this
    // publication leaves exactly the database an installation that ran the older definition holds.
    for (const change of publication.changes) {
      if (change.type !== "document" || change.value === null) continue;
      const value = change.value as { dispatchId?: string; submissionId?: string };
      if (value.dispatchId !== id || value.submissionId === undefined) continue;
      const facts: Facts = { mode, parentId, childId, dispatchId: id, submissionId: value.submissionId };
      killed = true;
      console.log(JSON.stringify(facts));
      process.kill(process.pid, "SIGKILL");
      return;
    }
    return;
  }
  for (const change of publication.changes) {
    if (change.type !== "submission") continue;
    const record = change.value;
    if (mode === "settled") {
      // The child's own settlement: not the parent's, and terminal. Nothing of the report has been written yet.
      if (String(record.conversationId) === parentId) continue;
      if (record.status !== "done" && record.status !== "unanswered") continue;
      const facts: Facts = { mode, parentId, childId: childId === "" ? String(record.conversationId) : childId, dispatchId: id, submissionId: String(record.id), submissionStatus: record.status };
      killed = true;
      console.log(JSON.stringify(facts));
      process.kill(process.pid, "SIGKILL");
      return;
    }
    // The report's own admission into the recipient: the identity the reporter derived from the dispatch.
    if (String(record.conversationId) === parentId && record.requestId === id + ":report") {
      const facts: Facts = { mode, parentId, childId, dispatchId: id, reportSubmissionId: String(record.id), submissionStatus: record.status };
      killed = true;
      console.log(JSON.stringify(facts));
      process.kill(process.pid, "SIGKILL");
      return;
    }
  }
};

// The `delivered` window needs the recipient held before the report is admitted, so the child's own answer waits for
// the stop to be committed: the window then really is "the report was admitted while the recipient was held".
let releaseChild: (() => void) | undefined;
const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });

const crash = await openCrashHarness(dbPath, {
  root,
  home,
  onCommit: killAt,
  // The baseline is produced by the real tool, creation seam, child conversation and storage; the one thing that makes
  // it an older installation is the definition that reserves the anchor record.
  ...(mode === "legacy" ? { tasks: [LegacyAnchorTask] } : {}),
  script: (faux) => {
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
      const lastUser = messages.findLast((message) => message.role === "user");
      const text = lastUser === undefined ? "" : JSON.stringify(lastUser.content ?? "");
      if (text.includes("child work")) {
        if (mode === "delivered") await childGate;
        return fauxAssistantMessage("crash answer");
      }
      if (messages.some((message) => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
      return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: CALL_ID })], { stopReason: "toolUse" });
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

// The child exists as soon as the anchor's admit commit lands; the window then decides what to do with it. The
// dispatch record is the durable statement of the same fact, so either read answers before the next commit runs.
const deadline = Date.now() + 30_000;
while (childId === "" && Date.now() < deadline) {
  const dispatch = await crash.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, dispatchId(), BACKGROUND_CONTEXT);
  if (dispatch?.childConversationId !== undefined) childId = dispatch.childConversationId;
  else await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.notEqual(childId, "", "the delegation created a child");
// The `delivered` window needs the recipient held at the moment of admission, so the report really stays queued.
if (mode === "delivered") {
  const stopped = await crash.operations.stop(parentId, { requestId: "stop-parent", stopSource: "user" });
  assert.equal(stopped.control.state, "held", "the recipient is held before the delivery");
  releaseChild?.();
}

// A fixture that never reaches its window is a failure, not a hang: the window is stated by the mode.
while (!killed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
console.error("the " + mode + " window was never reached; the fixture refuses to claim a kill it did not make");
process.exit(1);
