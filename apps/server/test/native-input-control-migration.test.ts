import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { submitConversationInput } from "../src/conversation-input.ts";
import { downgradeInboxToLegacy, inboxItems, openNativeRig, readInboxAsLegacy } from "./native-input-control-fixtures.ts";

test("a version 1 inbox record migrates to allowed and keeps its queued items", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	await submitConversationInput(rig.conversation, { type: "input", content: [{ type: "text", text: "queued by 1.3.0" }], requestId: "legacy-1", triggerTurn: false }, BACKGROUND_CONTEXT);
	const seeded = await inboxItems(rig.conversation);
	await rig.close();
	downgradeInboxToLegacy(rig.dbPath, rig.conversation.id, seeded);

	const migrated = await rig.reopen();
	// No version 1 record ever held input, so it reads as allowed.
	assert.deepEqual(await migrated.conversation.control(BACKGROUND_CONTEXT), { state: "allowed", revision: 0 });
	// Nothing was rewritten yet: a runtime that only knows version 1 can still read this record.
	await readInboxAsLegacy(migrated.conversation);
	// Reading the items through the runtime commits the migration: the version 2 base now holds the same queue.
	assert.equal((await inboxItems(migrated.conversation)).length, 1);
	await assert.rejects(readInboxAsLegacy(migrated.conversation), /has newer version 2 than 1/);
	assert.equal(migrated.requests(), 0);

	// A later admission keeps both the migrated queue and its own input.
	await submitConversationInput(migrated.conversation, { type: "input", content: [{ type: "text", text: "queued after migration" }], requestId: "legacy-2", triggerTurn: false }, BACKGROUND_CONTEXT);
	assert.equal(migrated.requests(), 0);

	const reopened = await migrated.reopen();
	assert.deepEqual(await reopened.conversation.control(BACKGROUND_CONTEXT), { state: "allowed", revision: 0 });
	assert.equal((await inboxItems(reopened.conversation)).length, 2);
});

test("a held record is refused, not read as allowed, by a runtime that predates the control field", async (t: TestContext) => {
	const rig = await openNativeRig(t);
	await rig.conversation.stop({ requestId: "stop-1", stopSource: "user" }, BACKGROUND_CONTEXT);
	await submitConversationInput(rig.conversation, { type: "input", content: [{ type: "text", text: "held report" }], requestId: "held-1", triggerTurn: false }, BACKGROUND_CONTEXT);
	// The old definition cannot read the record at all: it fails instead of admitting the held input.
	await assert.rejects(readInboxAsLegacy(rig.conversation), /has newer version 2 than 1/);
	const control = await rig.conversation.control(BACKGROUND_CONTEXT);
	assert.equal(control.state, "held");
	assert.equal(control.revision, 1);
	assert.equal((await inboxItems(rig.conversation)).length, 1);
	assert.equal(rig.requests(), 0);
});
