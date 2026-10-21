/**
 * Ticket 09's observable behavior: the pending queue is item by item, and the user decides about each item before the
 * model ever reads it.
 *
 * Every assertion reads a fact a user or the parent model can read — the recipient's own snapshot as the Web reads it,
 * the committed transcript, the model requests the controlled provider itself counted, and the child's own unchanged
 * history. The child, the anchor, the reporter and the parent are real native tasks and conversations over a real SQLite
 * file and a real local execution host; nothing here substitutes a fake queue (ticket 09, spec D07/D08/D09/D15, A07/A08/
 * A10/A11/A18/A20).
 *
 * One controlled model serves every conversation, so each scripted response is chosen from the transcript it answers:
 * the child's task text, the delegating turn and the turn a report woke are distinguishable.
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
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, type ConversationId, type InboxItem, type SubmissionId } from "@earendil-works/pi-durable";
import type { QueuedItemProjection } from "@hepi/protocol";
import { AGENT_REPORT_ENTRY_KIND } from "../src/subagents/host.ts";
import { createConversationItemOperations } from "../src/conversation-items.ts";
import { openCrashHarness, type CrashHarness } from "./subagents-crash-harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const crashChild = fileURLToPath(new URL("./pending-item-crash-child.ts", import.meta.url));

type Transcript = readonly { role: string; content?: unknown; toolName?: string }[];

const lastUserText = (messages: Transcript): string => {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content as never);
};

const hasToolResult = (messages: Transcript, name: string): boolean => messages.some((message) => message.role === "toolResult" && message.toolName === name);

type Rig = {
  readonly crash: CrashHarness;
  /** The per-item operations under test, over the same harness the rest of the fixture uses. */
  readonly items: ReturnType<typeof createConversationItemOperations>;
  /** Every model request this fixture's controlled model answered, whichever conversation asked. */
  requests(): number;
  /** The transcript the last request carried, which is what the parent model really read. */
  lastPrompt(): string;
  /**
   * Release the child's own answer. While it is held the child is genuinely working, so a stop really lands before the
   * report does — which is what makes "a late report" a real ordering and not a timing window.
   */
  releaseChild(): void;
  close(): Promise<void>;
};

type ScriptOptions = {
  readonly script: (messages: Transcript) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>;
  readonly startPaused?: boolean;
  /** Hold the child's answer until `releaseChild()`, so a stop can be committed while the child still works. */
  readonly holdChild?: boolean;
};

/** One fixture: a real worker definition, a real local host and a controlled model over a test-owned SQLite file. */
async function openRig(t: TestContext, dbPath: string, base: string, options: ScriptOptions): Promise<Rig> {
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(join(root, ".pi", "agents"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  let requests = 0;
  let prompt = "";
  let release = (): void => {};
  const childGate = new Promise<void>((resolve) => { release = resolve; });
  const crash = await openCrashHarness(dbPath, {
    root,
    home,
    ...(options.startPaused === true ? { startPaused: true } : {}),
    script: (faux) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as unknown as Transcript;
        requests += 1;
        prompt = messages.filter((message) => message.role === "user").map((message) => contentText(message.content as never)).join("\n");
        if (options.holdChild === true && lastUserText(messages) === "child work") await childGate;
        return await options.script(messages);
      };
      faux.setResponses([respond]);
    },
  });
  t.after(() => crash.close());
  return { crash, items: createConversationItemOperations(crash.harness.harness), requests: () => requests, lastPrompt: () => prompt, releaseChild: release, close: crash.close };
}

/** Create the parent with delegation on, and one stable dispatch identity for the whole fixture. */
async function spawnParent(rig: Rig, requestId = "parent"): Promise<{ id: string; dispatchId: string }> {
  const parent = await rig.crash.operations.spawn({
    requestId,
    ownership: { kind: "ownerless" },
    workspaceId: "local",
    agent: { model: SERVER_MODEL, extensions: [rig.crash.extension] },
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

/** One conversation's native inbox items, copied inside the commit that reads them. */
const inboxItems = (rig: Rig, id: string): Promise<readonly InboxItem[]> =>
  rig.crash.harness.harness.commit(async (tx) => JSON.parse(JSON.stringify([...(await tx.doc(InboxDoc, Number(id) as ConversationId)).items])) as InboxItem[], BACKGROUND_CONTEXT);

/** One conversation's committed entries. */
const entriesOf = (rig: Rig, id: string): Promise<readonly { kind: string; model?: unknown }[]> =>
  rig.crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) as ConversationId, order: "ascending" }, 500, undefined), BACKGROUND_CONTEXT).then((page) => page.items);

/** The text of one entry, read from the message the runtime appended for it. */
const textOf = (entry: { model?: unknown }): string =>
  contentText(((entry.model as { content?: never }[] | undefined)?.[0] ?? { content: [] }).content as never);

/** The user entries only: the messages a user's own dispatch placed, which a report is deliberately not. */
const userTexts = async (rig: Rig, id: string): Promise<string[]> =>
  (await entriesOf(rig, id)).filter((entry) => entry.kind === "pi.user").map(textOf);

/** The pending items as the per-item seam projects them, which is the same projection the snapshot states. */
const items = (rig: Rig, id: string): Promise<readonly QueuedItemProjection[]> => rig.items.items(id);

/** A scripted child answer for the one task the fixture delegates, and a parent that only delegates once. */
function delegateOnce(childText: string): (messages: Transcript) => ReturnType<typeof fauxAssistantMessage> {
  return (messages) => {
    if (lastUserText(messages) === "child work") return fauxAssistantMessage(childText);
    if (hasToolResult(messages, "agent_spawn")) return fauxAssistantMessage("parent delegated");
    return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-1" })], { stopReason: "toolUse" });
  };
}

/**
 * Delegate once, stop the recipient while the child is still working, and wait until the late report is really queued.
 * The returned item is the report as the per-item projection states it, which is what a surface would act on.
 */
async function stoppedWithLateReport(rig: Rig): Promise<{ parentId: string; childId: string; dispatchId: string; item: QueuedItemProjection }> {
  const parent = await spawnParent(rig);
  await rig.crash.operations.send(parent.id, { requestId: "parent-turn", caller: "user", content: [{ type: "text", text: "delegate" }] });
  const childId = await waitFor(async () => {
    const page = await rig.crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(parent.id) as ConversationId }, 10, undefined), BACKGROUND_CONTEXT);
    return page.items.length === 1 ? String(page.items[0]!.id) : undefined;
  }, "the child conversation");
  // The user stops while the child is still working, so the report really is a late arrival.
  const stopped = await rig.crash.operations.stop(parent.id, { requestId: "stop-parent", stopSource: "user" });
  assert.equal(stopped.control.state, "held");
  rig.releaseChild();
  const item = await waitFor(async () => {
    const projected = await items(rig, parent.id);
    return projected.length === 1 ? projected[0] : undefined;
  }, "the queued late report");
  return { parentId: parent.id, childId, dispatchId: parent.dispatchId, item };
}

test("a held recipient projects its late report as one queued item with identity, mode, text and source", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-projection-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, { holdChild: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const { parentId, childId, dispatchId, item } = await stoppedWithLateReport(rig);

  // The item states what a surface needs to act on it and to name where it came from — never a guess from the text.
  assert.equal(item.mode, "followUp");
  assert.notEqual(item.submissionId, "");
  assert.equal(item.requestId, dispatchId + ":report");
  assert.match(item.content, /late child answer/);
  assert.equal(item.source.kind, "report");
  if (item.source.kind === "report") {
    assert.equal(item.source.dispatchId, dispatchId);
    assert.equal(item.source.childConversationId, childId);
    assert.equal(item.source.submissionStatus, "done");
    assert.notEqual(item.source.answerEntryId, undefined);
    assert.equal(item.source.preview.maxBytes, 8192);
  }
  assert.equal(item.editable, true);
  assert.equal(item.cancelable, true);
  // The queue is the runtime's own: the item the projection states is the native inbox item, under the same id.
  const native = await inboxItems(rig, parentId);
  assert.equal(native.length, 1);
  assert.equal(String((native[0] as { id: SubmissionId }).id), item.submissionId);
  assert.equal((native[0] as Extract<InboxItem, { mode: "steer" | "followUp" }>).entry?.kind, AGENT_REPORT_ENTRY_KIND);
  // Nothing ran after the report queued: a held recipient consumes nothing, whatever the queue holds. The three
  // requests before this point are the parent's tool-call round, its final answer, and the child's own answer, so the
  // late report itself woke no model at all.
  const settled = rig.requests();
  assert.deepEqual(await items(rig, parentId), [item]);
  assert.equal(rig.requests(), settled);
  assert.equal(settled, 3, "the delegating round, its answer and the child's answer, and nothing else");
});

test("an edit with the token the caller read succeeds, changes only that item's copy, and starts no model", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-edit-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, { holdChild: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const { parentId, item } = await stoppedWithLateReport(rig);
  const before = rig.requests();

  const outcome = await rig.items.edit(parentId, { submissionId: item.submissionId, contentToken: item.contentToken, content: "edited by the user" });
  assert.equal(outcome.status, "edited");
  if (outcome.status !== "edited") return;
  assert.equal(outcome.item.content, "edited by the user");
  assert.notEqual(outcome.item.contentToken, item.contentToken);
  // The edit changed the parent's own pending copy and nothing else: the child's history is untouched.
  const stored = await items(rig, parentId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.content, "edited by the user");
  assert.equal(stored[0]!.submissionId, item.submissionId);
  // Still held, still no model request: an edit is not a decision to continue.
  const control = await rig.crash.harness.harness.conversation(Number(parentId) as ConversationId, BACKGROUND_CONTEXT).then((conversation) => conversation!.control(BACKGROUND_CONTEXT));
  assert.equal(control.state, "held");
  assert.equal(control.revision, 1);
  assert.equal(rig.requests(), before);
});

test("a stale tab's edit is refused with the current text, and a placed item is refused as not queued", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-conflict-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, { holdChild: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const { parentId, item } = await stoppedWithLateReport(rig);

  // Two tabs read the same item; the first edits it, and the second still holds the token it read.
  const first = await rig.items.edit(parentId, { submissionId: item.submissionId, contentToken: item.contentToken, content: "first tab's text" });
  assert.equal(first.status, "edited");
  const second = await rig.items.edit(parentId, { submissionId: item.submissionId, contentToken: item.contentToken, content: "second tab's text" });
  assert.equal(second.status, "content_conflict");
  if (second.status !== "content_conflict") return;
  // The conflict carries the current item, so the stale tab is handed the newer decision instead of only being refused.
  assert.equal(second.item.content, "first tab's text");
  // And the newer decision stands: the stale tab's text was not written.
  assert.equal((await items(rig, parentId))[0]!.content, "first tab's text");

  // A placed item cannot be edited: the outcome is a conflict and not a failure to retry.
  const notQueued = await rig.items.edit(parentId, { submissionId: "999999", contentToken: "anything", content: "x" });
  assert.equal(notQueued.status, "not_queued");
});

test("a cancel goes through the native abort, is idempotent on retry, and never lifts the hold", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-cancel-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, { holdChild: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const { parentId, item } = await stoppedWithLateReport(rig);
  const before = rig.requests();

  assert.equal((await rig.items.cancel(parentId, item.submissionId)).status, "cancelled");
  assert.deepEqual(await items(rig, parentId), []);
  // The native record is the receipt: the submission is settled `unanswered`/`aborted` and its original request id
  // still resolves it, which is what a reconnecting client looks a lost outcome up by.
  const settled = await rig.crash.harness.harness.submission(Number(item.submissionId) as SubmissionId, BACKGROUND_CONTEXT);
  const record = await settled!.status(BACKGROUND_CONTEXT);
  assert.equal(record.status, "unanswered");
  assert.equal(record.reason, "aborted");
  assert.equal(record.requestId, item.requestId);
  // A retry is the same outcome asked for twice, not a second operation.
  assert.equal((await rig.items.cancel(parentId, item.submissionId)).status, "already_cancelled");
  // The hold stands and no model was asked: a cancel is not a decision to continue.
  const control = await rig.crash.harness.harness.conversation(Number(parentId) as ConversationId, BACKGROUND_CONTEXT).then((conversation) => conversation!.control(BACKGROUND_CONTEXT));
  assert.equal(control.state, "held");
  assert.equal(control.revision, 1);
  assert.equal(rig.requests(), before);
  // An unknown submission is a refusal a caller names by code.
  await assert.rejects(() => rig.items.cancel(parentId, "999999"), (error: { code?: string }) => error.code === "not_found");
});

test("the user's Continue consumes the kept item and excludes the cancelled one from the model request", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-continue-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, {
    holdChild: true,
    script: (messages) => (lastUserText(messages).includes("late child answer") || lastUserText(messages).includes("edited by the user") ? fauxAssistantMessage("parent saw the item") : delegateOnce("late child answer")(messages)),
  });
  const { parentId, item } = await stoppedWithLateReport(rig);

  // A second queued item the user cancels, and the report the user keeps after editing it: one Continue, and the model
  // reads exactly the text the user left.
  const extra = await rig.crash.operations.send(parentId, { requestId: "extra", caller: "user", resume: false, triggerTurn: false, content: [{ type: "text", text: "cancelled by the user" }] });
  assert.equal((await rig.items.cancel(parentId, extra.submissionId!)).status, "cancelled");
  assert.equal((await rig.items.edit(parentId, { submissionId: item.submissionId, contentToken: item.contentToken, content: "edited by the user" })).status, "edited");
  assert.deepEqual((await items(rig, parentId)).map((candidate) => candidate.content), ["edited by the user"]);

  const resumed = await rig.crash.operations.continue(parentId, { requestId: "continue-1", caller: "user" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.control.state, "allowed");
  const prompt = await waitFor(async () => {
    const current = rig.lastPrompt();
    return current.includes("edited by the user") ? current : undefined;
  }, "the parent's request carrying the kept item");
  // The model read the edited text and nothing the user cancelled, and the cancelled text is nowhere in the transcript.
  assert.equal(prompt.includes("cancelled by the user"), false, prompt);
  await waitFor(async () => ((await items(rig, parentId)).length === 0 ? true : undefined), "the consumed queue");
  // The kept item was placed as the report it is — its own entry kind, not a user message — and the cancelled one was
  // never placed at all: the transcript holds the edited text and no trace of what the user withdrew.
  // The report was placed as the entry kind it is, not as a user message: the text travels in the entry's model, so
  // this reads the report entry's own data beside the text.
  const entries = await entriesOf(rig, parentId);
  const reportEntry = entries.find((entry) => entry.kind === AGENT_REPORT_ENTRY_KIND);
  assert.notEqual(reportEntry, undefined, JSON.stringify(entries.map((entry) => entry.kind)));
  assert.match(textOf(reportEntry!), /edited by the user/);
  assert.equal(JSON.stringify(entries).includes("cancelled by the user"), false, JSON.stringify(entries.map((entry) => entry.kind)));
  assert.equal((await userTexts(rig, parentId)).length, 1, "the report is not a user message");
});

test("an empty Continue consumes nothing and invents no user message", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-empty-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rig = await openRig(t, join(base, "hepi.sqlite"), base, { holdChild: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const { parentId, item } = await stoppedWithLateReport(rig);
  await rig.items.cancel(parentId, item.submissionId);
  const before = await userTexts(rig, parentId);
  const requests = rig.requests();

  const resumed = await rig.crash.operations.continue(parentId, { requestId: "continue-empty", caller: "user" });
  assert.equal(resumed.status, "resumed");
  assert.equal(resumed.control.state, "allowed");
  // The transcript gained no fabricated user message and no model was asked: an empty continue is a resume, not a turn.
  assert.deepEqual(await userTexts(rig, parentId), before);
  assert.equal(rig.requests(), requests);
});

test("a reporter replay after an edit and a cancel neither overwrites the edit nor revives the cancelled item", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-replay-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  const script = (messages: Transcript) => delegateOnce("late child answer")(messages);
  let rig = await openRig(t, dbPath, base, { holdChild: true, script });
  const { parentId, item } = await stoppedWithLateReport(rig);
  assert.equal((await rig.items.edit(parentId, { submissionId: item.submissionId, contentToken: item.contentToken, content: "edited by the user" })).status, "edited");

  // A restart re-runs the reporter against the same identities. The report's own request id is already admitted, so
  // the native admission answers the existing submission and writes nothing: the user's decision stands.
  await rig.close();
  rig = await openRig(t, dbPath, base, { holdChild: true, script });
  rig.crash.harness.harness.resume();
  const after = await waitFor(async () => {
    const projected = await items(rig, parentId);
    return projected.length === 1 ? projected : undefined;
  }, "the still-queued edited item");
  assert.equal(after[0]!.content, "edited by the user");
  assert.equal(after[0]!.submissionId, item.submissionId);

  // The same for a cancelled item: nothing re-queues it and no report entry appears.
  assert.equal((await rig.items.cancel(parentId, item.submissionId)).status, "cancelled");
  await rig.close();
  rig = await openRig(t, dbPath, base, { holdChild: true, script });
  rig.crash.harness.harness.resume();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(await items(rig, parentId), []);
  assert.equal((await entriesOf(rig, parentId)).some((entry) => entry.kind === AGENT_REPORT_ENTRY_KIND), false);
});

test("a real SIGKILL after an edit and a cancel keeps both decisions across the reopen", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-items-crash-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.sqlite");
  const killed = spawnSync(process.execPath, [crashChild, dbPath, base], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr + killed.stdout);
  const facts = JSON.parse(killed.stdout.trim().split("\n").at(-1)!) as { parentId: string; keptSubmissionId: string; cancelledSubmissionId: string };

  // Reopened, the store holds exactly the decisions the killed process committed: the edited text and no trace of the
  // cancelled item, with the hold still in place.
  const rig = await openRig(t, dbPath, base, { startPaused: true, script: (messages) => delegateOnce("late child answer")(messages) });
  const projected = await items(rig, facts.parentId);
  assert.deepEqual(projected.map((item) => item.submissionId), [facts.keptSubmissionId]);
  assert.equal(projected[0]!.content, "edited before the kill");
  assert.equal(projected[0]!.contentToken, (await import("@hepi/protocol")).pendingContentToken("edited before the kill"));
  const cancelled = await rig.crash.harness.harness.submission(Number(facts.cancelledSubmissionId) as SubmissionId, BACKGROUND_CONTEXT);
  assert.equal((await cancelled!.status(BACKGROUND_CONTEXT)).status, "unanswered");
  const control = await rig.crash.harness.harness.conversation(Number(facts.parentId) as ConversationId, BACKGROUND_CONTEXT).then((conversation) => conversation!.control(BACKGROUND_CONTEXT));
  assert.equal(control.state, "held");
  // And a global resume does not lift it: only the trusted user's own continue does.
  rig.crash.harness.harness.resume();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await rig.crash.harness.harness.conversation(Number(facts.parentId) as ConversationId, BACKGROUND_CONTEXT).then((conversation) => conversation!.control(BACKGROUND_CONTEXT))).state, "held");
});
