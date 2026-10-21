import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { InboxDoc, LiveDoc, type InboxControlReceipt, type InboxItem, type SubmissionRecord, type TaskId } from "@earendil-works/pi-durable";
import { submitConversationInput } from "../src/conversation-input.ts";
import { backgroundRegistry, inboxItems, openNativeRig, startBackgroundSleeper, waitFor, type NativeRig } from "./native-input-control-fixtures.ts";

function lastUserText(messages: readonly Message[]): string {
	const message = messages.findLast(candidate => candidate.role === "user");
	return message === undefined ? "" : contentText(message.content);
}

/** The native queued submissions of one rig, read through the public inspection seam. */
async function queued(rig: NativeRig): Promise<readonly SubmissionRecord[]> {
	return (await rig.harness.inspect(BACKGROUND_CONTEXT)).submissions;
}

/** The task that owns the conversation's live run, read from the runtime's own live state. */
async function liveRun(rig: NativeRig): Promise<TaskId> {
	const live = await rig.harness.snapshot(LiveDoc, rig.conversation.id, BACKGROUND_CONTEXT);
	if (live?.run === undefined) throw new Error("the conversation has no live run");
	return live.run.taskId;
}

/** One turn of user input through the native admission path, awaited to its answer. */
async function turn(rig: NativeRig, text: string, requestId: string): Promise<void> {
	await rig.conversation.submit({ type: "input", content: [{ type: "text", text }], requestId }, BACKGROUND_CONTEXT);
	await rig.harness.waitForIdle(BACKGROUND_CONTEXT);
}

/** The user texts of one conversation's active transcript, oldest first. */
async function userTexts(rig: NativeRig): Promise<string[]> {
	const entries = (await rig.conversation.context(BACKGROUND_CONTEXT)).entries;
	return entries.filter(entry => entry.kind === "pi.user").map(entry => lastUserText(entry.model ?? []));
}

test("held queues input at every admission path, and only continue consumes it", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation, harness } = rig;
	await turn(rig, "first", "turn-1");
	assert.equal(rig.requests(), 1);

	const stopped = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stopped.status, "accepted");
	assert.equal(stopped.drain, "idle");
	assert.equal(stopped.control.state, "held");
	assert.equal(stopped.control.revision, 1);
	assert.equal(stopped.control.stopSource, "user");
	assert.equal(typeof stopped.control.stoppedAt, "number");

	// An idle conversation with an empty inbox: direct admission must queue instead of placing a run.
	const first = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "second" }], requestId: "turn-2" }, BACKGROUND_CONTEXT);
	// A second input while the inbox is non-empty: the final-boundary admission would have consumed both when allowed.
	await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "third" }], requestId: "turn-3" }, BACKGROUND_CONTEXT);
	assert.equal(rig.requests(), 1);
	assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).entries.map(entry => entry.kind), ["pi.user", "pi.assistant"]);
	const pending = await queued(rig);
	assert.deepEqual(pending.map(record => [record.status, record.type]), [["queued", "input"], ["queued", "input"]]);
	assert.equal(pending[0]!.id, first);

	// A display-only write changes nothing the model sees: it lands at once and releases nothing.
	const note = await conversation.submit({ type: "write", entry: { kind: "hepi.test-note", data: { note: "visible only" } } }, BACKGROUND_CONTEXT);
	assert.equal((await note.status(BACKGROUND_CONTEXT)).status, "done");
	// A model-visible write would be placed at a boundary; while held it queues behind the input.
	const summary = await conversation.submit({ type: "write", entry: { kind: "hepi.test-summary", model: [{ role: "user", content: [{ type: "text", text: "summary" }], timestamp: 1 }] } }, BACKGROUND_CONTEXT);
	assert.equal((await summary.status(BACKGROUND_CONTEXT)).status, "queued");
	assert.equal(rig.requests(), 1);
	assert.deepEqual((await queued(rig)).map(record => record.type), ["input", "input", "write"]);
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");

	// The global scheduling switch is not the conversation's control state: resume alone consumes nothing.
	harness.resume();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(rig.requests(), 1);
	assert.equal((await queued(rig)).length, 3);

	const resumed = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(resumed.status, "resumed");
	assert.equal(resumed.control.state, "allowed");
	assert.equal(resumed.control.revision, 2);
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	// The queued write lands first, then each queued input runs once under the default one-at-a-time mode.
	assert.equal(rig.requests(), 3);
	assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).entries.map(entry => entry.kind), ["pi.user", "pi.assistant", "hepi.test-note", "hepi.test-summary", "pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
	assert.deepEqual(await userTexts(rig), ["first", "second", "third"]);
	assert.deepEqual(await queued(rig), []);
});

test("a queued reset waits for continue instead of cutting the run while held", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation, harness } = rig;
	await turn(rig, "first", "turn-1");
	await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	const reset = await conversation.reset("handoff while held", BACKGROUND_CONTEXT);
	assert.equal(reset, undefined);
	const pending = (await queued(rig)).find(record => record.type === "write");
	assert.ok(pending !== undefined);
	assert.equal(pending.status, "queued");
	// The reset has not landed: the transcript still starts at the first user entry and no run was started.
	assert.deepEqual(await userTexts(rig), ["first"]);
	assert.equal(rig.requests(), 1);
	await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	// It lands on resume as the runtime's own reset, so the active range now starts at it.
	const entries = (await conversation.context(BACKGROUND_CONTEXT)).entries;
	assert.equal(entries[0]!.kind, "pi.reset");
});

test("a stop withdraws the input queued at its commit point and keeps the input that arrives later", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation, harness } = rig;
	// Queue-only admission without a run, through the adapter the backend uses.
	const before = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "queued before stop" }], requestId: "before", triggerTurn: false }, BACKGROUND_CONTEXT);
	assert.equal(rig.requests(), 0);

	const stopped = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stopped.status, "accepted");
	// The input queued at the commit point is withdrawn natively: settled unanswered/aborted and out of the inbox.
	const withdrawn = await harness.submission(before, BACKGROUND_CONTEXT);
	assert.equal((await withdrawn!.status(BACKGROUND_CONTEXT)).status, "unanswered");
	assert.deepEqual(await inboxItems(conversation), []);

	const after = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "queued after stop" }], requestId: "after", triggerTurn: false }, BACKGROUND_CONTEXT);
	// The same stop request is answered from its receipt and withdraws nothing a second time.
	const replay = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(replay.status, "accepted");
	assert.deepEqual(replay.receipt, stopped.receipt);
	assert.deepEqual(replay.control, stopped.control);
	// A later stop keeps what arrived since and records its own receipt.
	const second = await conversation.stop({ requestId: "stop-2", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(second.status, "held");
	assert.equal(second.control.state, "held");
	assert.equal((await inboxItems(conversation)).length, 1);
	assert.equal((await harness.submission(after, BACKGROUND_CONTEXT))!.id, after);
	// Nothing above ran a turn or touched the model.
	assert.equal(rig.requests(), 0);
});

test("a stop holds a running conversation until its ordinary scope drains, and continue waits for that fact", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "long run" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");

	const stopped = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stopped.status, "accepted");
	assert.equal(stopped.drain, "stopping");
	const late = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "late report" }], requestId: "report-1", triggerTurn: false }, BACKGROUND_CONTEXT);
	const waiting = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(waiting.status, "stopping");
	assert.equal(waiting.control.state, "held");
	// The pending intent is answered from its receipt while the drain continues.
	assert.deepEqual((await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT)).receipt, waiting.receipt);

	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	// The drain ended without consuming the report: it waits for the explicit continue.
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");
	assert.equal(rig.requests(), 1);
	assert.deepEqual((await queued(rig)).map(record => record.id), [late]);

	const resumed = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(resumed.status, "resumed");
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(rig.requests(), 2);
	assert.deepEqual(await userTexts(rig), ["long run", "late report"]);
});

test("a later stop supersedes a pending continue", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "long run" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");
	await conversation.stop({ requestId: "stop-a", stopSource: "user" }, BACKGROUND_CONTEXT);
	await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "kept report" }], requestId: "report-1", triggerTurn: false }, BACKGROUND_CONTEXT);
	assert.equal((await conversation.continue({ requestId: "continue-a", caller: "user" }, BACKGROUND_CONTEXT)).status, "stopping");
	// The user stops again while the drain is still running: it advances the control revision.
	const second = await conversation.stop({ requestId: "stop-b", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(second.status, "held");
	assert.equal(second.control.revision, 2);

	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	// The stale continue must not clear the newer stop or consume what it kept.
	const stale = await conversation.continue({ requestId: "continue-a", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stale.status, "rejected");
	assert.equal(stale.reason, "superseded");
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");
	assert.equal(rig.requests(), 1);
	assert.equal((await queued(rig)).length, 1);

	const fresh = await conversation.continue({ requestId: "continue-b", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(fresh.status, "resumed");
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(rig.requests(), 2);
});

test("a user stop is only cleared by a trusted user continue, and an agent stop never downgrades it", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation } = rig;
	const stopped = await conversation.stop({ requestId: "stop-user", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stopped.control.stopSource, "user");

	const refused = await conversation.continue({ requestId: "continue-model", caller: "agent" }, BACKGROUND_CONTEXT);
	assert.equal(refused.status, "rejected");
	assert.equal(refused.reason, "source_locked");
	// The refusal changed nothing and created no dispatch.
	const held = await conversation.control(BACKGROUND_CONTEXT);
	assert.equal(held.state, "held");
	assert.equal(held.revision, 1);
	assert.equal(held.stopSource, "user");
	assert.deepEqual(await queued(rig), []);
	assert.deepEqual(await inboxItems(conversation), []);

	const agentStop = await conversation.stop({ requestId: "stop-agent", stopSource: "agent" }, BACKGROUND_CONTEXT);
	assert.equal(agentStop.status, "held");
	assert.equal(agentStop.control.stopSource, "user");
	assert.equal(agentStop.control.revision, 2);

	assert.equal((await conversation.continue({ requestId: "continue-user", caller: "user" }, BACKGROUND_CONTEXT)).status, "resumed");
	// An agent stop accepts an explicit agent resume; a model cannot resume a user stop on its own.
	const agentOnly = await conversation.stop({ requestId: "stop-agent-2", stopSource: "agent" }, BACKGROUND_CONTEXT);
	assert.equal(agentOnly.status, "accepted");
	assert.equal(agentOnly.control.stopSource, "agent");
	assert.equal((await conversation.continue({ requestId: "continue-agent", caller: "agent" }, BACKGROUND_CONTEXT)).status, "resumed");
});

test("continue without queued input resumes silently and keeps the configured queue mode", async (t: TestContext) => {
	const one = await openNativeRig(t);
	await one.conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	await one.conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	// An empty continue invents no user message and starts no run.
	assert.deepEqual((await one.conversation.context(BACKGROUND_CONTEXT)).entries, []);
	assert.equal(one.requests(), 0);

	// Two queued inputs: the configured mode decides whether they share one run or run one after the other.
	for (const mode of ["one-at-a-time", "all"] as const) {
		const rig = await openNativeRig(t, { settings: { followUpMode: mode } });
		await rig.conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
		await submitConversationInput(rig.conversation, { type: "input", content: [{ type: "text", text: "a" }], requestId: "a", triggerTurn: false }, BACKGROUND_CONTEXT);
		await submitConversationInput(rig.conversation, { type: "input", content: [{ type: "text", text: "b" }], requestId: "b", triggerTurn: false }, BACKGROUND_CONTEXT);
		assert.equal((await rig.conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT)).status, "resumed");
		await rig.harness.waitForIdle(BACKGROUND_CONTEXT);
		assert.deepEqual(await userTexts(rig), ["a", "b"]);
		const kinds = (await rig.conversation.context(BACKGROUND_CONTEXT)).entries.map(entry => entry.kind);
		assert.equal(rig.requests(), mode === "all" ? 1 : 2);
		assert.deepEqual(kinds, mode === "all" ? ["pi.user", "pi.user", "pi.assistant"] : ["pi.user", "pi.assistant", "pi.user", "pi.assistant"]);
		assert.deepEqual(await queued(rig), []);
	}
});

test("an expected control revision conflict changes no control state", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const conflict = await rig.conversation.stop({ requestId: "stop-1", stopSource: "user", expectedControlRevision: 7 }, BACKGROUND_CONTEXT);
	assert.equal(conflict.status, "rejected");
	assert.equal(conflict.reason, "revision_mismatch");
	assert.equal(conflict.control.state, "allowed");
	assert.equal(conflict.control.revision, 0);
	// A retry of the same request is answered from its receipt, so a corrected revision needs its own request ID.
	assert.equal((await rig.conversation.stop({ requestId: "stop-1", stopSource: "user", expectedControlRevision: 0 }, BACKGROUND_CONTEXT)).reason, "revision_mismatch");
	const accepted = await rig.conversation.stop({ requestId: "stop-2", stopSource: "user", expectedControlRevision: 0 }, BACKGROUND_CONTEXT);
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.control.revision, 1);
});

test("stop's ordinary scope leaves a background task of the same conversation running", async (t: TestContext) => {
	const rig = await openNativeRig(t, { registry: backgroundRegistry() });
	const { conversation, harness } = rig;
	const sleeper = await startBackgroundSleeper(conversation);
	assert.notEqual((await harness.getTask(sleeper, BACKGROUND_CONTEXT))?.state.status, "terminal");

	const stopped = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	// A live background task does not make the ordinary scope non-idle.
	assert.equal(stopped.drain, "idle");
	assert.notEqual((await harness.getTask(sleeper, BACKGROUND_CONTEXT))?.abortRequested, true);
	const settled = await harness.waitForTask(sleeper, BACKGROUND_CONTEXT);
	assert.equal(settled.state.outcome.status, "completed");
});

test("the native abort contract is unchanged: it withdraws queued input without holding the conversation", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation, harness } = rig;
	const queuedId = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "withdrawn by abort" }], requestId: "abort-1", triggerTurn: false }, BACKGROUND_CONTEXT);
	await conversation.abort(BACKGROUND_CONTEXT);
	assert.equal((await (await harness.submission(queuedId, BACKGROUND_CONTEXT))!.status(BACKGROUND_CONTEXT)).status, "unanswered");
	assert.deepEqual(await inboxItems(conversation), []);
	// Abort is not a stop: the control state stays allowed, so the next input runs natively.
	assert.deepEqual(await conversation.control(BACKGROUND_CONTEXT), { state: "allowed", revision: 0 });
	await turn(rig, "after abort", "turn-1");
	assert.equal(rig.requests(), 1);
});

test("a held conversation reports its queued item with its receipts and keeps it out of the transcript", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	const { conversation } = rig;
	await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	const id = await submitConversationInput(conversation, { type: "input", content: [{ type: "text", text: "pending" }], requestId: "pending-1", entry: { kind: "hepi.report", data: { source: "child" } } }, BACKGROUND_CONTEXT);
	const snapshot = await conversation.commit(async tx => {
		const inbox = await tx.doc(InboxDoc, conversation.id);
		return copyJson({ receipts: [...inbox.control.receipts], items: [...inbox.items] }) as unknown as { receipts: readonly InboxControlReceipt[]; items: readonly InboxItem[] };
	}, BACKGROUND_CONTEXT);
	assert.equal(snapshot.items.length, 1);
	assert.equal(snapshot.items[0]!.id, id);
	assert.deepEqual(snapshot.receipts.map(receipt => [receipt.operation, receipt.requestId, receipt.status]), [["stop", "stop-1", "accepted"]]);
	assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).entries, []);
});

test("a rejected stop leaves the live run it did not stop alone", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "long run" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");
	const run = await liveRun(rig);

	// A stale expected revision refuses the request, so it must not mark the run it did not stop.
	const conflict = await conversation.stop({ requestId: "stop-stale", stopSource: "user", expectedControlRevision: 3 }, BACKGROUND_CONTEXT);
	assert.equal(conflict.status, "rejected");
	assert.equal(conflict.reason, "revision_mismatch");
	assert.equal(conflict.control.state, "allowed");
	assert.notEqual((await harness.getTask(run, BACKGROUND_CONTEXT))?.abortRequested, true);

	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	// The run answered rather than ending aborted.
	assert.notEqual((await harness.getTask(run, BACKGROUND_CONTEXT))?.abortRequested, true);
	assert.deepEqual((await conversation.context(BACKGROUND_CONTEXT)).entries.map(entry => entry.kind), ["pi.user", "pi.assistant"]);
	assert.equal(rig.requests(), 1);
});

test("replaying an accepted stop does not abort the run that started after continue", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1, 2] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "first" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");
	assert.equal((await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT)).status, "accepted");
	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal((await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT)).status, "resumed");

	// The allowed conversation runs again, and the provider holds that answer.
	await conversation.submit({ type: "input", content: [{ type: "text", text: "second" }], requestId: "turn-2" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 2, "the second held model request");
	const run = await liveRun(rig);
	// The first stop is answered from its receipt, so it must not stop this run.
	const replay = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(replay.status, "accepted");
	assert.equal(replay.receipt.revision, 1);
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "allowed");
	assert.notEqual((await harness.getTask(run, BACKGROUND_CONTEXT))?.abortRequested, true);

	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.notEqual((await harness.getTask(run, BACKGROUND_CONTEXT))?.abortRequested, true);
	assert.deepEqual(await userTexts(rig), ["first", "second"]);
	assert.equal((await conversation.context(BACKGROUND_CONTEXT)).entries.at(-1)?.kind, "pi.assistant");
	assert.equal(rig.requests(), 2);
});

test("a pending continue is settled only under the stop source it recorded", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "long run" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");
	await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	// The user's continue arrives while the drain runs, so it is recorded as pending instead of settled.
	assert.equal((await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT)).status, "stopping");
	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");

	// The model replaying the user's request ID is not authorization: it clears no stop and admits no input.
	const substituted = await conversation.continue({ requestId: "continue-1", caller: "agent", input: { content: [{ type: "text", text: "replacement" }] } }, BACKGROUND_CONTEXT);
	assert.equal(substituted.status, "rejected");
	assert.equal(substituted.reason, "source_locked");
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");
	assert.equal(rig.requests(), 1);
	assert.deepEqual(await userTexts(rig), ["long run"]);
	assert.deepEqual(await inboxItems(conversation), []);

	// The intent the user recorded is still the user's to settle.
	const resumed = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(resumed.status, "resumed");
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "allowed");
});

test("a pending continue is settled only by the caller that recorded it", async (t: TestContext) => {
	const rig = await openNativeRig(t, { holdRequests: [1] });
	const { conversation, harness } = rig;
	await conversation.submit({ type: "input", content: [{ type: "text", text: "long run" }], requestId: "turn-1" }, BACKGROUND_CONTEXT);
	await waitFor(() => rig.requests() === 1, "the held model request");
	await conversation.stop({ requestId: "stop-1", stopSource: "agent" }, BACKGROUND_CONTEXT);
	assert.equal((await conversation.continue({ requestId: "continue-1", caller: "agent" }, BACKGROUND_CONTEXT)).status, "stopping");
	rig.release();
	await harness.waitForIdle(BACKGROUND_CONTEXT);

	// An agent stop is not source-locked, so the recording caller's own identity refuses the substitution.
	const substituted = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(substituted.status, "rejected");
	assert.equal(substituted.reason, "caller_mismatch");
	assert.equal((await conversation.control(BACKGROUND_CONTEXT)).state, "held");
	assert.equal((await conversation.continue({ requestId: "continue-1", caller: "agent" }, BACKGROUND_CONTEXT)).status, "resumed");
});
