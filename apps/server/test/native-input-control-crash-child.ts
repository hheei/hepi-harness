import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, type ConversationId, type SubmissionRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readInboxAsLegacy } from "./native-input-control-fixtures.ts";

/**
 * One stage of the SIGKILL recovery matrix, run as its own process over a test-owned SQLite file.
 *
 * `stop`, `continue` and `migrate` commit one durable intent and then kill the process with SIGKILL, with no clean
 * close. The `*-reopen` stages open the same file again and assert the recovered facts through the public API; they
 * print one JSON line of facts for the test to read.
 */
const [, , stage, dbPath, conversationIdText] = process.argv;
// The test passes the conversation ID it created; the brand is only a compile-time identity.
const conversationId = Number(conversationIdText) as ConversationId;
const faux = fauxProvider();
const respond = async (): Promise<ReturnType<typeof fauxAssistantMessage>> => {
	faux.setResponses([respond]);
	return fauxAssistantMessage("child answer " + faux.state.callCount);
};
faux.setResponses([respond]);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(await openNodeSqliteStorage(dbPath!), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
const conversation = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
assert.ok(conversation !== undefined, "conversation " + conversationIdText + " is missing");
const submit = (requestId: string, text: string) => conversation.submit({ type: "input", content: [{ type: "text" as const, text }], requestId }, BACKGROUND_CONTEXT);
const userTexts = async (): Promise<string[]> => {
	const entries = (await conversation.context(BACKGROUND_CONTEXT)).entries;
	return entries.filter(entry => entry.kind === "pi.user").map(entry => {
		const message = (entry.model ?? []).findLast((candidate: Message) => candidate.role === "user");
		return message === undefined ? "" : contentText(message.content);
	});
};
const submissions = async (): Promise<readonly SubmissionRecord[]> => (await harness.inspect(BACKGROUND_CONTEXT)).submissions;

if (stage === "stop") {
	const stopped = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(stopped.status, "accepted");
	assert.equal(stopped.drain, "idle");
	const report = await submit("report-1", "late report");
	assert.equal((await report.status(BACKGROUND_CONTEXT)).status, "queued");
} else if (stage === "continue") {
	assert.equal((await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT)).status, "accepted");
	await submit("report-1", "late report");
	assert.equal((await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT)).status, "resumed");
} else if (stage === "migrate") {
	// Acquiring pi.inbox in a commit stores the migrated version 2 base over the version 1 record.
	await conversation.commit(async tx => { await tx.doc(InboxDoc, conversation.id); }, BACKGROUND_CONTEXT);
} else if (stage === "stop-reopen") {
	harness.resume();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	const control = await conversation.control(BACKGROUND_CONTEXT);
	assert.equal(control.state, "held");
	assert.equal(control.revision, 1);
	assert.equal(control.stopSource, "user");
	// Restarting scheduling consumed nothing: the held report is still queued and no model request happened.
	assert.deepEqual((await submissions()).map(record => [record.type, record.status, record.requestId]), [["input", "queued", "report-1"]]);
	assert.equal(faux.state.callCount, 0);
	// The stop withdrawal committed before the kill is still recorded on the submission it withdrew.
	const withdrawn = await harness.commit(tx => tx.submissionByRequest(conversation.id, "report-before-stop"), BACKGROUND_CONTEXT);
	assert.equal(withdrawn?.status, "unanswered");
	assert.equal(withdrawn?.reason, "aborted");
	// The stop receipt is durable: the same request returns the same answer and control revision.
	const replay = await conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	assert.equal(replay.status, "accepted");
	assert.equal(replay.control.revision, control.revision);
	assert.equal(replay.control.state, "held");
	const resumed = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(resumed.status, "resumed");
	assert.equal(resumed.control.revision, 2);
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.deepEqual(await userTexts(), ["late report"]);
	assert.equal(faux.state.callCount, 1);
	assert.deepEqual(await submissions(), []);
	console.log(JSON.stringify({ stage, requestsAfterRestart: 0, requestsAfterContinue: faux.state.callCount, controls: [control.state, resumed.control.state], texts: await userTexts() }));
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
} else if (stage === "continue-reopen") {
	harness.resume();
	await harness.waitForIdle(BACKGROUND_CONTEXT);
	const control = await conversation.control(BACKGROUND_CONTEXT);
	assert.equal(control.state, "allowed");
	assert.equal(control.revision, 2);
	// The committed continue keeps its receipt and its revision: a retry changes nothing.
	const replay = await conversation.continue({ requestId: "continue-1", caller: "user" }, BACKGROUND_CONTEXT);
	assert.equal(replay.status, "resumed");
	assert.equal(replay.control.revision, 2);
	// The report was placed exactly once and is answered; no run consumed it twice.
	assert.deepEqual(await userTexts(), ["late report"]);
	assert.deepEqual(await submissions(), []);
	console.log(JSON.stringify({ stage, requests: faux.state.callCount, texts: await userTexts(), submissions: (await submissions()).length }));
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
} else if (stage === "migrate-reopen") {
	const control = await conversation.control(BACKGROUND_CONTEXT);
	assert.equal(control.state, "allowed");
	assert.equal(control.revision, 0);
	const inbox = await harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT);
	assert.equal(inbox?.items.length, 1);
	// The migration committed: a runtime that only knows version 1 now refuses this record instead of reading it.
	await assert.rejects(readInboxAsLegacy(conversation), /newer version 2 than 1/);
	console.log(JSON.stringify({ stage, items: inbox?.items.length, state: control.state }));
	await harness.close(BACKGROUND_CONTEXT);
	process.exit(0);
} else {
	throw new Error("unknown stage " + String(stage));
}

// No clean close: the recovery evidence is what a real SIGKILL leaves behind.
process.kill(process.pid, "SIGKILL");
