import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { submitConversationInput } from "../src/conversation-input.ts";
import type { InboxItem } from "@earendil-works/pi-durable";
import { downgradeInboxToLegacy, inboxItems, openNativeRigAt, type NativeRig } from "./native-input-control-fixtures.ts";

const child = fileURLToPath(new URL("./native-input-control-crash-child.ts", import.meta.url));

type Stage = {
	readonly status: number | null;
	readonly signal: string | null;
	readonly stdout: string;
	readonly stderr: string;
};

/** Run one stage in its own process over the test's SQLite file. */
function runStage(stage: string, rig: { dbPath: string; conversation: { id: number } }): Stage {
	const result = spawnSync(process.execPath, [child, stage, rig.dbPath, String(rig.conversation.id)], { encoding: "utf8" });
	return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The facts line a `*-reopen` stage prints; a failed assertion makes the stage exit non-zero instead. */
function facts(stage: Stage): Record<string, unknown> {
	if (stage.status !== 0) throw new Error("stage failed (" + String(stage.status) + "): " + stage.stderr + stage.stdout);
	const line = stage.stdout.trim().split("\n").at(-1);
	assert.ok(line !== undefined && line.startsWith("{"), "stage printed no facts: " + stage.stdout);
	return JSON.parse(line) as Record<string, unknown>;
}

/** A test-owned directory with a seeded conversation and one queued report, closed so the stages own the file. */
async function seed(t: TestContext): Promise<{ directory: string; rig: NativeRig; items: readonly InboxItem[] }> {
	const directory = await mkdtemp(join(tmpdir(), "hepi-native-control-crash-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const rig = await openNativeRigAt(directory);
	await submitConversationInput(rig.conversation, { type: "input", content: [{ type: "text", text: "queued before stop" }], requestId: "report-before-stop", triggerTurn: false }, BACKGROUND_CONTEXT);
	const items = await inboxItems(rig.conversation);
	await rig.close();
	return { directory, rig, items };
}

test("a real SIGKILL after the stop commit keeps the held state, the receipt and the report that arrived later", async (t: TestContext) => {
	const { directory, rig } = await seed(t);
	const killed = runStage("stop", rig);
	assert.equal(killed.status, null);
	assert.equal(killed.signal, "SIGKILL");

	// Reopen the same file with a fresh harness: the committed stop, its withdrawal and the later report are all there.
	const reopened = await openNativeRigAt(directory);
	t.after(() => reopened.close());
	const recovered = facts(runStage("stop-reopen", reopened));
	assert.equal(recovered.requestsAfterRestart, 0);
	assert.equal(recovered.requestsAfterContinue, 1);
	assert.deepEqual(recovered.controls, ["held", "allowed"]);
	assert.deepEqual(recovered.texts, ["late report"]);
	// The reopened rig sees the same committed control the child reported.
	const control = await reopened.conversation.control(BACKGROUND_CONTEXT);
	assert.equal(control.state, "allowed");
	assert.equal(control.revision, 2);
});

test("a real SIGKILL after the continue commit keeps one report, one answer and the same receipt", async (t: TestContext) => {
	const { directory, rig } = await seed(t);
	const killed = runStage("continue", rig);
	assert.equal(killed.status, null);
	assert.equal(killed.signal, "SIGKILL");

	const reopened = await openNativeRigAt(directory);
	t.after(() => reopened.close());
	const recovered = facts(runStage("continue-reopen", reopened));
	assert.deepEqual(recovered.texts, ["late report"]);
	assert.equal(recovered.submissions, 0);
});

test("a real SIGKILL after the inbox migration leaves a version 2 record an unpatched runtime refuses", async (t: TestContext) => {
	const { directory, rig, items } = await seed(t);
	downgradeInboxToLegacy(rig.dbPath, rig.conversation.id, items);
	const killed = runStage("migrate", rig);
	assert.equal(killed.status, null);
	assert.equal(killed.signal, "SIGKILL");

	const reopened = await openNativeRigAt(directory);
	t.after(() => reopened.close());
	const recovered = facts(runStage("migrate-reopen", reopened));
	assert.equal(recovered.items, 1);
	assert.equal(recovered.state, "allowed");
});
