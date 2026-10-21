/**
 * Ticket 07 observable behavior: one child's terminal result reaches its registered recipient by itself.
 *
 * Every assertion reads a fact a user or the parent model can read — the recipient's own committed transcript, its own
 * native inbox, the extension's own report record, the controlled model's request count — and never a helper structure.
 * The reporter, the anchor and the child are real native tasks and conversations over a real SQLite file and a real
 * local execution host; nothing here substitutes a fake delivery for one (ticket 07, spec D04/D05/D16, A04/A06/A07/A11).
 *
 * One controlled model serves every conversation, so each scripted response is chosen from the transcript it answers:
 * a child's task text, the delegating turn and the turn a report woke are distinguishable, and two conversations running
 * at once cannot consume each other's script.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, type ConversationId, type EntryRecord, type InboxItem, type InputEntry, type SubmissionId } from "@earendil-works/pi-durable";
import { tombstoneConversation } from "../src/session-tombstone.ts";
import { AGENT_REPORT_ENTRY_KIND, DispatchDoc, ReportDoc, SUBAGENT_ANCHOR_TASK, SUBAGENT_REPORTER_TASK } from "../src/subagents/host.ts";
import { openCrashHarness, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const crashChild = fileURLToPath(new URL("./subagent-report-crash-child.ts", import.meta.url));

type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
};

const hasToolResult = (messages: Transcript, name: string): boolean => messages.some((message) => message.role === "toolResult" && message.toolName === name);

/** One conversation's committed entries, read from the store rather than from a projection. */
const entriesOf = (report: ReportHarness, id: string): Promise<readonly EntryRecord[]> =>
  report.crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT).then((page) => page.items);

/** One child's own final answer text, read from the child's transcript: what the report is supposed to carry. */
async function childAnswer(report: ReportHarness, childId: string): Promise<string> {
  const entries = await entriesOf(report, childId);
  return entries
    .filter((entry) => entry.kind === "pi.assistant")
    .map((entry) => contentText(((entry.model?.[0] ?? {}) as { content?: never }).content as never))
    .join("\n");
}

/**
 * One conversation's native inbox items, which is where a queued report really is. The items are copied **inside** the
 * commit: a document draft is not readable once its overlay settled, so a value handed out of the commit has to be a
 * detached copy made while the overlay is still live.
 */
const inboxItems = (report: ReportHarness, id: string): Promise<readonly InboxItem[]> =>
  report.crash.harness.harness.commit(async (tx) => copyJson([...(await tx.doc(InboxDoc, Number(id) as ConversationId)).items]) as InboxItem[], BACKGROUND_CONTEXT);

/** The extension's own report record for one dispatch, which is the durable source reference. */
const reportRecord = (report: ReportHarness, delegatingId: string, dispatchId: string) =>
  report.crash.harness.harness.snapshot(ReportDoc, Number(delegatingId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);

/** The report entries of one conversation's transcript: the entry's own kind, its structured data and its text. */
async function reportEntries(report: ReportHarness, id: string): Promise<{ text: string; kind: string; data?: InputEntry }[]> {
  const entries = await entriesOf(report, id);
  return entries
    .filter((entry) => entry.kind === AGENT_REPORT_ENTRY_KIND)
    .map((entry) => ({ text: contentText(((entry.model?.[0] ?? {}) as { content?: never }).content as never), kind: entry.kind, data: copyJson((entry as { data?: InputEntry }).data ?? {}) as InputEntry }));
}

type ReportHarness = {
  readonly crash: CrashHarness;
  /** Model requests whose prompt was a delivered report, which is the wake this ticket claims. */
  reportTurns(): number;
  /** Every model request this fixture's controlled model answered, whichever conversation asked. */
  requests(): number;
  close(): Promise<void>;
};

type ScriptOptions = { readonly script: (messages: Transcript) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>; readonly startPaused?: boolean; readonly onCommit?: (publication: never) => void; readonly wrapSpawn?: (tool: never) => never };

/** One fixture: a real worker definition, a real local host and a controlled model over a test-owned SQLite file. */
async function openReportHarness(t: TestContext, dbPath: string, base: string, options: ScriptOptions): Promise<ReportHarness> {
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  let reportTurns = 0;
  let requests = 0;
  const crash = await openCrashHarness(dbPath, {
    root,
    home,
    ...(options.startPaused === true ? { startPaused: true } : {}),
    ...(options.onCommit === undefined ? {} : { onCommit: options.onCommit as never }),
    ...(options.wrapSpawn === undefined ? {} : { wrapSpawn: options.wrapSpawn as never }),
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as unknown as Transcript;
        requests += 1;
        if (lastUserText(messages).startsWith("The delegated child ")) reportTurns += 1;
        return await options.script(messages);
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());
  return { crash, reportTurns: () => reportTurns, requests: () => requests, close: crash.close };
}

/** Create the parent with delegation on, and one stable dispatch identity for the whole fixture. */
async function spawnParent(report: ReportHarness, requestId = "parent"): Promise<{ id: string; dispatchId: string }> {
  const parent = await report.crash.operations.spawn({
    requestId,
    ownership: { kind: "ownerless" },
    workspaceId: "local",
    agent: { model: SERVER_MODEL, extensions: [report.crash.extension] },
  });
  return { id: parent.conversationId, dispatchId: parent.conversationId + ":call-1" };
}

/** Poll the store until a predicate holds, so a child and its reporter run on their own schedule. */
async function waitFor<T>(accept: () => Promise<T | undefined>, description: string, deadlineMs = 30_000): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await accept();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The child conversation one delegating conversation created. */
async function childOf(report: ReportHarness, parentId: string): Promise<string> {
  const page = await report.crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(parentId) as ConversationId }, 10, undefined), BACKGROUND_CONTEXT);
  assert.equal(page.items.length, 1, JSON.stringify(page.items));
  return String(page.items[0]!.id);
}

/** A scripted child answer for the one task the fixture delegates, and a parent that only delegates once. */
function delegateOnce(childText: string): (messages: Transcript) => ReturnType<typeof fauxAssistantMessage> {
  return (messages) => {
    if (lastUserText(messages) === "child work") return fauxAssistantMessage(childText);
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent delegated");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-1" })], { stopReason: "toolUse" });
  };
}

/** Delegate once and wait until the child conversation exists. */
async function delegate(report: ReportHarness, parentId: string): Promise<string> {
  await report.crash.operations.send(parentId, { requestId: "parent-turn", caller: "user", content: [{ type: "text", text: "delegate" }] });
  return await waitFor(async () => {
    const page = await report.crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(parentId) as ConversationId }, 10, undefined), BACKGROUND_CONTEXT);
    return page.items.length === 1 ? String(page.items[0]!.id) : undefined;
  }, "the child conversation");
}

test("a child's final answer is delivered into the recipient's own transcript and wakes it, with no contact and no summary turn", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-wake-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : delegateOnce("child answer")(messages)),
  });
  const parent = await spawnParent(report);
  const childId = await delegate(report, parent.id);

  // The child answers on its own, and the reporter carries it into the parent: the child's script has no contact call
  // at all, so the delivery cannot depend on one and no summary turn was added anywhere.
  const delivered = await waitFor(async () => {
    const entries = await reportEntries(report, parent.id);
    return entries.length === 1 ? entries : undefined;
  }, "the report entry in the recipient");
  const data = delivered[0]!.data as { dispatchId?: string; childConversationId?: string; submissionId?: string; answerEntryId?: string; submissionStatus?: string };
  assert.equal(delivered[0]!.kind, AGENT_REPORT_ENTRY_KIND);
  assert.equal(data.dispatchId, parent.dispatchId);
  assert.equal(data.childConversationId, childId);
  assert.equal(data.submissionStatus, "done");
  assert.notEqual(data.submissionId, undefined);
  assert.notEqual(data.answerEntryId, undefined);
  // The delivered body is the child's own answer, and the reference names the entry it came from.
  assert.equal(delivered[0]!.text.includes(await childAnswer(report, childId)), true);

  // The recipient was woken by the report itself, and that wake is an ordinary turn that reports nothing further.
  await waitFor(async () => ((await report.reportTurns()) === 1 ? true : undefined), "the recipient's wake turn");
  await waitFor(async () => {
    const entries = await entriesOf(report, parent.id);
    return entries.some((entry) => entry.kind === "pi.assistant" && contentText(((entry.model?.[0] ?? {}) as { content?: never }).content as never) === "parent saw the report") ? true : undefined;
  }, "the recipient's own answer to the report");
  assert.equal(report.reportTurns(), 1);
  assert.equal((await reportEntries(report, parent.id)).length, 1);
  const record = await reportRecord(report, parent.id, parent.dispatchId);
  assert.equal(record?.delivery, "delivered");
  assert.equal(record?.submissionStatus, "done");
  assert.equal(record?.childConversationId, childId);
});

test("a report queues at the running recipient's own boundary without interrupting its tool round, and is consumed there", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-running-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: async (messages) => {
      if (lastUserText(messages).startsWith("The delegated child ")) return fauxAssistantMessage("parent saw the report");
      // The delegating turn stays open after its tool result, so the recipient is genuinely busy when the child answers.
      if (hasToolResult(messages, "agent_spawn")) {
        await gate;
        return fauxAssistantMessage("parent delegated");
      }
      return delegateOnce("child answer")(messages);
    },
  });
  const parent = await spawnParent(report);
  await delegate(report, parent.id);

  // The child answers while the parent is still running: the report lands as a queued inbox item and nothing else.
  const queued = await waitFor(async () => {
    const items = await inboxItems(report, parent.id);
    return items.length === 1 ? items : undefined;
  }, "the queued report");
  const item = queued[0] as Extract<InboxItem, { mode: "steer" | "followUp" }>;
  assert.equal(item.mode, "followUp");
  assert.equal(item.entry?.kind, AGENT_REPORT_ENTRY_KIND);
  // The running turn was not interrupted and no second turn started beside it.
  assert.equal((await reportEntries(report, parent.id)).length, 0);
  assert.equal(report.reportTurns(), 0);

  // Released, the run reaches its own boundary and consumes exactly the queued report as the next turn's input.
  release?.();
  await waitFor(async () => ((await report.reportTurns()) === 1 ? true : undefined), "the boundary wake");
  await waitFor(async () => ((await inboxItems(report, parent.id)).length === 0 ? true : undefined), "the consumed queue");
  assert.equal((await reportEntries(report, parent.id)).length, 1);
});

test("a user-stopped recipient queues the late report, starts no run, and the parent stop never cancels the child or its reporter", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-held-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // The child's answer is held open, so the stop really lands while the child is still working: the report is a late
  // arrival, which is the case this test is about.
  let releaseChild: (() => void) | undefined;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: async (messages) => {
      if (lastUserText(messages).startsWith("The delegated child ")) return fauxAssistantMessage("parent saw the report");
      if (lastUserText(messages) === "child work") { await childGate; return fauxAssistantMessage("late child answer"); }
      return delegateOnce("late child answer")(messages);
    },
  });
  const parent = await spawnParent(report);
  const childId = await delegate(report, parent.id);

  // The user stops the delegating conversation while the child is still working.
  const stopped = await report.crash.operations.stop(parent.id, { requestId: "stop-parent", stopSource: "user" });
  assert.equal(stopped.control.state, "held");
  releaseChild?.();

  // The child finishes on its own anyway: the parent stop reached neither the anchor, the child nor the reporter.
  await waitFor(async () => ((await childAnswer(report, childId)).includes("late child answer") ? true : undefined), "the child's own answer");
  const queued = await waitFor(async () => {
    const items = await inboxItems(report, parent.id);
    return items.length === 1 ? items : undefined;
  }, "the queued late report");
  assert.equal((queued[0] as Extract<InboxItem, { mode: "steer" | "followUp" }>).entry?.kind, AGENT_REPORT_ENTRY_KIND);
  // Zero model requests: a held recipient consumes nothing, whatever the report says.
  assert.equal(report.reportTurns(), 0);
  assert.equal((await reportEntries(report, parent.id)).length, 0);
  // The reporter finished its own work and stated the delivery; the child keeps its identity and its owner.
  const record = await waitFor(async () => {
    const stored = await reportRecord(report, parent.id, parent.dispatchId);
    return stored?.delivery === "delivered" ? stored : undefined;
  }, "the delivered report record");
  assert.equal(record.submissionStatus, "done");
  const conversation = await report.crash.harness.harness.conversation(Number(parent.id) as ConversationId, BACKGROUND_CONTEXT);
  assert.equal((await conversation!.control(BACKGROUND_CONTEXT)).state, "held");
  const owner = await report.crash.harness.harness.commit((tx) => tx.conversation(Number(childId) as ConversationId), BACKGROUND_CONTEXT);
  assert.equal(String(owner?.owner?.conversationId), parent.id);
});

test("a removal that lands between the report's check and its admission still admits nothing, so no model runs", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-delete-race-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : fauxAssistantMessage("parent ran")),
  });
  const harness = report.crash.harness.harness;

  // The race is real ordering, not a timing window: `deliver` checks the tombstone in one commit and admits in a later
  // one, so a removal that commits in between is exactly the case where the report would still be placed and the
  // recipient's model asked. The removal is interleaved at every microtask boundary across the check, so whichever
  // boundary the defect needs is covered, and the assertion is the invariant that must hold at **every** one of them.
  let deleteFirst = 0;
  for (let delay = 0; delay <= 12; delay += 1) {
    const before = report.requests();
    const parent = await spawnParent(report, "parent-" + delay);
    const conversationId = Number(parent.id) as ConversationId;
    const order: string[] = [];
    const unsubscribe = harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === "submission" && change.value.requestId === parent.dispatchId + ":report") order.push("report:" + change.value.status);
        if (change.type === "document" && change.value !== null && (change.value as { deletedAt?: number }).deletedAt !== undefined) order.push("deleted");
      }
    });
    const sent = report.crash.operations.deliver(parent.id, {
      requestId: parent.dispatchId + ":report",
      content: [{ type: "text", text: "late report " + delay }],
      entry: { kind: AGENT_REPORT_ENTRY_KIND },
    }).then((answer) => { order.push("deliver-answered"); return answer; });
    for (let step = 0; step < delay; step += 1) await Promise.resolve();
    const removed = tombstoneConversation(harness, conversationId, [parent.id], Date.now()).then(() => { order.push("delete-returned"); });
    const [delivery] = await Promise.allSettled([sent, removed]);
    if (delivery.status === "fulfilled") await (await harness.submission(Number(delivery.value.submissionId) as SubmissionId, BACKGROUND_CONTEXT))?.status(BACKGROUND_CONTEXT);
    unsubscribe();
    const removedAt = order.indexOf("deleted");
    const admittedAt = order.findIndex((event) => event.startsWith("report:"));
    if (removedAt < 0 || admittedAt < removedAt) continue;
    deleteFirst += 1;
    // The removal committed first, so this conversation admitted nothing: no placed report, no report entry, and no
    // model request to the removed recipient.
    assert.notEqual(order[removedAt + 1], "report:placed", JSON.stringify(order));
    assert.equal((await reportEntries(report, parent.id)).length, 0, JSON.stringify(order));
    assert.equal(before, report.requests(), JSON.stringify(order));
  }
  // The interleaving really did happen, or the test would be asserting nothing.
  assert.equal(deleteFirst > 0, true, "the removal never committed before the report's admission; the race was not exercised");
});

test("a removed recipient terminates the delivery as recipient_deleted, keeps the source result, and writes nothing", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-deleted-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // The child's answer is held open so the removal really happens first.
  let releaseChild: (() => void) | undefined;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: async (messages) => {
      if (lastUserText(messages).startsWith("The delegated child ")) return fauxAssistantMessage("parent saw the report");
      if (lastUserText(messages) === "child work") { await childGate; return fauxAssistantMessage("orphan answer"); }
      return delegateOnce("orphan answer")(messages);
    },
  });
  const parent = await spawnParent(report);
  const childId = await delegate(report, parent.id);

  // The user removes the recipient before the child is done.
  await tombstoneConversation(report.crash.harness.harness, Number(parent.id) as ConversationId, [parent.id], Date.now());
  releaseChild?.();
  await waitFor(async () => ((await childAnswer(report, childId)).includes("orphan answer") ? true : undefined), "the child's answer");

  const record = await waitFor(async () => {
    const stored = await reportRecord(report, parent.id, parent.dispatchId);
    return stored?.delivery === "recipient_deleted" ? stored : undefined;
  }, "the terminal delivery record");
  // The source result survives the removal: the child identity, the settled submission and its answer entry are still
  // named, so the work is not lost with the target.
  assert.equal(record.childConversationId, childId);
  assert.equal(record.submissionStatus, "done");
  assert.notEqual(record.answerEntryId, undefined);
  assert.equal(record.deliveredSubmissionId, undefined);
  // Nothing was written into the removed conversation and nothing is queued for a retry.
  assert.equal((await inboxItems(report, parent.id)).length, 0);
  assert.equal((await reportEntries(report, parent.id)).length, 0);
  assert.equal(report.reportTurns(), 0);
});

test("a large answer is delivered as a bounded deterministic preview whose source stays fully readable", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-preview-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // 12 KiB of answer, over the 8 KiB preview budget, with a marker at the very end that only the source can carry.
  const long = "A".repeat(6000) + "\n" + "B".repeat(6000) + "\nEND-MARKER";
  const report = await openReportHarness(t, join(base, "hepi.sqlite"), base, {
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : delegateOnce(long)(messages)),
  });
  const parent = await spawnParent(report);
  await delegate(report, parent.id);

  const delivered = await waitFor(async () => {
    const entries = await reportEntries(report, parent.id);
    return entries.length === 1 ? entries : undefined;
  }, "the report entry");
  const text = delivered[0]!.text;
  // The cut is stated, and the delivered body is inside the fixed budget.
  assert.match(text, /cut to the 8192-byte report preview/);
  assert.equal(text.includes("END-MARKER"), false);
  const data = delivered[0]!.data as { preview?: { bytes: number; droppedBytes: number; maxBytes: number; maxLines: number }; childConversationId?: string; answerEntryId?: string };
  assert.equal(data.preview?.maxBytes, 8192);
  assert.equal(data.preview?.maxLines, 400);
  assert.equal((data.preview?.droppedBytes ?? 0) > 0, true);
  // The full source is reachable by the reference the report names: the same core bounded read, on the answer entry.
  const source = await report.crash.operations.read({ conversationId: data.childConversationId!, entryId: data.answerEntryId!, limit: 2000 });
  const whole = source.output.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.equal(whole.includes("END-MARKER"), true);
});

test("a report a user cancelled is never revived or overwritten when the reporter runs again", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-cancelled-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  // The child's answer is held open, so the stop and the cancel really happen while it is still working.
  let releaseChild: (() => void) | undefined;
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  const script = async (messages: Transcript) => {
    if (lastUserText(messages).startsWith("The delegated child ")) return fauxAssistantMessage("parent saw the report");
    if (lastUserText(messages) === "child work") { await childGate; return fauxAssistantMessage("cancelled answer"); }
    return delegateOnce("cancelled answer")(messages);
  };
  let report = await openReportHarness(t, dbPath, base, { script });
  const parent = await spawnParent(report);
  await delegate(report, parent.id);
  // The recipient is held, so the report really stays queued and a user can decide about it.
  await report.crash.operations.stop(parent.id, { requestId: "stop-parent", stopSource: "user" });
  releaseChild?.();
  const queued = await waitFor(async () => {
    const items = await inboxItems(report, parent.id);
    return items.length === 1 ? items : undefined;
  }, "the queued report");
  const submissionId = (queued[0] as { id: SubmissionId }).id;
  // The user cancels it through the native operation the Web control will use.
  assert.equal(await report.crash.harness.harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, Number(parent.id) as ConversationId), "aborted");
  assert.equal((await inboxItems(report, parent.id)).length, 0);

  // A restart re-runs the reporter against the same identities. It re-reads the settled child and re-admits nothing:
  // the known request id answers the cancelled submission, which the record states as an unanswered settlement.
  const before = report.reportTurns();
  await report.close();
  report = await openReportHarness(t, dbPath, base, { script });
  const record = await waitFor(async () => {
    const stored = await reportRecord(report, parent.id, parent.dispatchId);
    return stored?.delivery === "delivered" ? stored : undefined;
  }, "the replay's delivery record");
  assert.equal(record.deliveredSubmissionId, String(submissionId));
  // The cancelled item stayed cancelled: no queue entry came back, no report entry exists, and no model was asked.
  assert.equal((await inboxItems(report, parent.id)).length, 0);
  assert.equal((await reportEntries(report, parent.id)).length, 0);
  assert.equal(report.reportTurns(), before);
});

test("a delegation an older installation left admitted but unreported gets exactly one reporter, with no new admission", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-legacy-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  // A **real** baseline: the delegation is created against the pre-07 anchor definition, so the database holds exactly
  // what an installation that ran the older definition holds — an idle anchor, a dispatch record naming an unfinished
  // child submission, and no reporter.
  const killed = spawnSync(process.execPath, [crashChild, dbPath, base, "legacy"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { mode: string; parentId: string; childId: string; dispatchId: string; submissionId: string };

  const report = await openReportHarness(t, dbPath, base, {
    startPaused: true,
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : delegateOnce("legacy answer")(messages)),
  });
  const harness = report.crash.harness.harness;
  const conversation = Number(facts.parentId) as ConversationId;
  // The baseline really is the older shape: the anchor is idle, no reporter exists, and the child's own submission is
  // still unfinished under the dispatch's stable request id.
  const before = await harness.inspect(BACKGROUND_CONTEXT);
  const anchors = before.tasks.filter((task) => task.record.kind === SUBAGENT_ANCHOR_TASK);
  assert.equal(anchors.length, 1, JSON.stringify(before.tasks.map((task) => task.record.kind)));
  assert.equal((anchors[0]!.record.state.checkpoint as { phase?: string }).phase, "idle");
  assert.equal(before.tasks.some((task) => task.record.kind === SUBAGENT_REPORTER_TASK), false, JSON.stringify(before.tasks.map((task) => task.record.kind)));
  const admitted = await harness.commit((tx) => tx.submissionByRequest(Number(facts.childId) as ConversationId, facts.dispatchId), BACKGROUND_CONTEXT);
  assert.equal(String(admitted?.id), facts.submissionId);
  assert.notEqual(admitted?.status, "done");
  assert.notEqual(admitted?.status, "unanswered");
  report.crash.harness.harness.resume();

  // The recovered reporter waits the child out and reports it. Nothing else was created or admitted: the child keeps its
  // conversation, its identity and the very submission the old anchor placed.
  const delivered = await waitFor(async () => {
    const entries = await reportEntries(report, facts.parentId);
    return entries.length === 1 ? entries : undefined;
  }, "the recovered delivery");
  const data = delivered[0]!.data as { dispatchId?: string; childConversationId?: string; submissionId?: string; submissionStatus?: string };
  assert.equal(data.dispatchId, facts.dispatchId);
  assert.equal(data.childConversationId, facts.childId);
  assert.equal(data.submissionId, facts.submissionId);
  assert.equal(data.submissionStatus, "done");
  const record = await reportRecord(report, facts.parentId, facts.dispatchId);
  assert.equal(record?.delivery, "delivered");
  assert.equal(record?.submissionId, facts.submissionId);
  assert.equal((await reportEntries(report, facts.parentId)).length, 1);
  // Exactly one reporter ever existed, and it is the one the dispatch record names: the recovery created it once and
  // the completion settled that same task, so no second reporter was made for the same dispatch.
  const reporters = await harness.commit((tx) => tx.scanTasks({ conversationId: conversation, kind: SUBAGENT_REPORTER_TASK }, 100), BACKGROUND_CONTEXT);
  assert.equal(reporters.items.length, 1, JSON.stringify(reporters.items.map((task) => task.kind)));
  const dispatch = await harness.snapshot(DispatchDoc, conversation, facts.dispatchId, BACKGROUND_CONTEXT);
  assert.equal(String(dispatch?.reporterTaskId), String(reporters.items[0]!.id));
  assert.equal(String(dispatch?.submissionId), facts.submissionId);
  assert.equal(reporters.items[0]!.state.status, "terminal");
  // The child's own admission was never repeated: the same submission id, still the one the report names, and it is the
  // child's only input submission.
  const childAdmission = await harness.commit((tx) => tx.submissionByRequest(Number(facts.childId) as ConversationId, facts.dispatchId), BACKGROUND_CONTEXT);
  assert.equal(String(childAdmission?.id), facts.submissionId);
  assert.equal(childAdmission?.status, "done");
  const childInputs = await harness.commit((tx) => tx.scanEntries({ conversationId: Number(facts.childId) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT);
  assert.equal(childInputs.items.filter((entry) => entry.kind === "pi.user").length, 1, JSON.stringify(childInputs.items.map((entry) => entry.kind)));
  assert.equal(report.reportTurns(), 1);
});

test("a real SIGKILL between the child's settlement and the delivery keeps one report identity across the reopen", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-crash-settled-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, base, "settled"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { mode: string; parentId: string; childId: string; dispatchId: string };

  // Reopened paused: the child's terminal submission is durable and no report record and no delivery exist yet.
  const report = await openReportHarness(t, dbPath, base, {
    startPaused: true,
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : delegateOnce("crash answer")(messages)),
  });
  const pending = await report.crash.harness.harness.inspect(BACKGROUND_CONTEXT);
  assert.equal(pending.tasks.filter((task) => task.record.kind === SUBAGENT_REPORTER_TASK).length, 1, JSON.stringify(pending.tasks.map((task) => task.record.kind)));
  assert.equal((await reportRecord(report, facts.parentId, facts.dispatchId))?.submissionStatus, undefined);
  assert.equal((await inboxItems(report, facts.parentId)).length, 0);
  report.crash.harness.harness.resume();

  // Resumed, the same reporter finishes the same report: one child, one report identity, one delivery.
  const delivered = await waitFor(async () => {
    const entries = await reportEntries(report, facts.parentId);
    return entries.length === 1 ? entries : undefined;
  }, "the recovered delivery");
  const data = delivered[0]!.data as { dispatchId?: string; childConversationId?: string; submissionStatus?: string };
  assert.equal(data.dispatchId, facts.dispatchId);
  assert.equal(data.childConversationId, facts.childId);
  assert.equal(data.submissionStatus, "done");
  assert.equal((await reportEntries(report, facts.parentId)).length, 1);
  assert.equal(report.reportTurns(), 1);
});

test("a real SIGKILL between the report's admission and its acknowledgement keeps one queued item and one submission", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-reports-crash-delivered-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, base, "delivered"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { parentId: string; childId: string; dispatchId: string; reportSubmissionId: string };

  const report = await openReportHarness(t, dbPath, base, {
    startPaused: true,
    script: (messages) => (lastUserText(messages).startsWith("The delegated child ") ? fauxAssistantMessage("parent saw the report") : delegateOnce("crash answer")(messages)),
  });
  // At the kill point the recipient is held, so the admitted report is really still queued: one item, one submission.
  const queued = await inboxItems(report, facts.parentId);
  assert.equal(queued.length, 1, JSON.stringify(queued));
  assert.equal((queued[0] as Extract<InboxItem, { mode: "steer" | "followUp" }>).entry?.kind, AGENT_REPORT_ENTRY_KIND);
  assert.equal(String((queued[0] as { id: SubmissionId }).id), facts.reportSubmissionId);
  report.crash.harness.harness.resume();

  // Resumed, the reporter re-reads the same settled submission, re-admits nothing and acknowledges the delivery it
  // already made: the queue still holds exactly the one item, under the one identity.
  const record = await waitFor(async () => {
    const stored = await reportRecord(report, facts.parentId, facts.dispatchId);
    return stored?.delivery === "delivered" ? stored : undefined;
  }, "the acknowledged delivery");
  assert.equal(record.deliveredSubmissionId, facts.reportSubmissionId);
  assert.equal(record.childConversationId, facts.childId);
  const after = await inboxItems(report, facts.parentId);
  assert.equal(after.length, 1);
  assert.equal(String((after[0] as { id: SubmissionId }).id), facts.reportSubmissionId);
  assert.equal(report.reportTurns(), 0);
});
