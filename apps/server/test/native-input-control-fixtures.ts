import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, InboxDoc, type Conversation, type ConversationId, type HarnessSettings, type InboxItem, type ModelRef, type Registry, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

export const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

/** The harnesses one test opened over one SQLite file, so `close()` leaves nothing running. */
type Family = {
	readonly directory: string;
	readonly dbPath: string;
	/** The conversation every harness of this family attaches to; set when the root is created. */
	conversationId: ConversationId | undefined;
	readonly opened: Harness[];
};

/** A real harness over a test-owned SQLite file and the faux provider, driven only through public runtime API. */
export type NativeRig = {
	readonly harness: Harness;
	readonly conversation: Conversation;
	readonly faux: FauxProviderHandle;
	readonly directory: string;
	readonly dbPath: string;
	/** Model requests the provider has served; the provider's own counter, not a test-side count. */
	requests(): number;
	/** Release every answer currently held by `holdRequests`, so the runs holding them can finish. */
	release(): void;
	/** Close this harness and open another one over the same file and conversation, as a restart does. */
	reopen(settings?: HarnessSettings): Promise<NativeRig>;
	/** Close every harness this test opened over the file. */
	close(): Promise<void>;
};

export type RigOptions = {
	readonly settings?: HarnessSettings;
	readonly registry?: Registry;
	/**
	 * Hold the model answer of these request numbers (1-based, in provider call order) until `release()` runs, so
	 * "busy" is a real state rather than a race.
	 */
	readonly holdRequests?: readonly number[];
};

async function openFamilyRig(family: Family, options: RigOptions): Promise<NativeRig> {
	const faux = fauxProvider();
	const held = new Set<() => void>();
	const releaseHeld = (): void => {
		for (const resolve of [...held]) {
			held.delete(resolve);
			resolve();
		}
	};
	let served = 0;
	const respond: FauxResponseFactory = async () => {
		served += 1;
		// Re-arm inside the response so every request gets an answer, as the existing faux rigs do.
		faux.setResponses([respond]);
		if (options.holdRequests?.includes(served) === true)
			await new Promise<void>(resolve => { held.add(resolve); });
		return fauxAssistantMessage("answer " + faux.state.callCount);
	};
	faux.setResponses([respond]);
	const models = createModels();
	models.setProvider(faux.provider);
	const registry = options.registry ?? createRegistry();
	const harness = await Harness.open(
		await openNodeSqliteStorage(family.dbPath),
		{ models, registry, ...(options.settings === undefined ? {} : { settings: options.settings }) },
		BACKGROUND_CONTEXT,
	);
	family.opened.push(harness);
	const conversation = family.conversationId === undefined
		? await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } })
		: await harness.conversation(family.conversationId, BACKGROUND_CONTEXT);
	if (conversation === undefined) throw new Error("Conversation " + String(family.conversationId) + " is missing");
	family.conversationId = conversation.id;
	harness.resume();
	return {
		harness,
		conversation,
		faux,
		directory: family.directory,
		dbPath: family.dbPath,
		requests: () => faux.state.callCount,
		release: releaseHeld,
		reopen: async (settings) => {
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
			return openFamilyRig(family, { ...options, ...(settings === undefined ? {} : { settings }), holdRequests: [] });
		},
		close: async () => {
			// A held answer blocks the run the close would wait for, so release it first; closing is always possible.
			releaseHeld();
			for (const opened of family.opened.splice(0)) await opened.close(BACKGROUND_CONTEXT).catch(() => {});
		},
	};
}

/** A rig over one existing directory; `control.sqlite` there is created and its root conversation kept. */
export async function openNativeRigAt(directory: string, options: RigOptions = {}): Promise<NativeRig> {
	return openFamilyRig({ directory, dbPath: join(directory, "control.sqlite"), conversationId: undefined, opened: [] }, options);
}

/** A rig over its own temporary directory; the test's cleanup closes it and removes the directory. */
export async function openNativeRig(t: { after(fn: () => void | Promise<void>): void }, options: RigOptions = {}): Promise<NativeRig> {
	const directory = await mkdtemp(join(tmpdir(), "hepi-native-control-"));
	t.after(async () => { await rm(directory, { recursive: true, force: true }); });
	const rig = await openNativeRigAt(directory, options);
	t.after(() => rig.close());
	return rig;
}

/**
 * The exact pre-patch inbox definition: pi-durable 1.3.0's `InboxDoc` was version 1 with only `items`. Reading a
 * version 2 record with it throws the runtime's own newer-version error, which is what an unpatched runtime does.
 */
export const LegacyInboxDoc = defineDoc({
	kind: "pi.inbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ items: [] as InboxItem[] }),
	checkpointWhen: value => value.items.length === 0,
});

/** Poll a real condition on a timer until it holds, so a loaded machine cannot race a fixed sleep. */
export async function waitFor(ready: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!ready()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for " + what);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

/** The native pi.inbox items of one conversation, read detached through the public transaction seam. */
export async function inboxItems(conversation: Conversation): Promise<readonly InboxItem[]> {
	// The committed items are copied while the transaction's overlay is live; a draft node is not readable after it.
	return conversation.commit(async tx => copyJson([...(await tx.doc(InboxDoc, conversation.id)).items]) as InboxItem[], BACKGROUND_CONTEXT);
}

/** Read one conversation's inbox with the version 1 definition, as an unpatched 1.3.0 runtime would. */
export async function readInboxAsLegacy(conversation: Conversation): Promise<void> {
	await conversation.commit(async tx => { await tx.doc(LegacyInboxDoc, conversation.id); }, BACKGROUND_CONTEXT);
}

/**
 * Rewrite the newest stored `pi.inbox` revision of one conversation as the version 1 record 1.3.0 wrote: version 1 and
 * a value of only `items`. A revision row is (document_id, seq, kind, version, content) and `content` holds the value
 * JSON (see the package's `storage/sqlite/storage.js`); this builds a fixture, it asserts nothing.
 */
export function downgradeInboxToLegacy(dbPath: string, conversationId: number, items: readonly InboxItem[]): void {
	const db = new DatabaseSync(dbPath);
	try {
		// The documents row stores its address as JSON, so the kind literal itself is quoted in the column.
		const row = db.prepare("SELECT id FROM documents WHERE kind = '\"pi.inbox\"' AND scope_kind = 'conversation' AND owner_id = ? ORDER BY created_at DESC LIMIT 1").get(conversationId);
		if (row === undefined) throw new Error("Conversation " + String(conversationId) + " has no pi.inbox document");
		const documentId = Number(row.id);
		const base = db.prepare("SELECT seq FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(documentId);
		if (base === undefined) throw new Error("Document " + String(documentId) + " has no base revision");
		const seq = Number(base.seq);
		// The version 1 record was one base holding only the items: drop the deltas and rewrite that base.
		db.prepare("DELETE FROM document_revisions WHERE document_id = ? AND seq > ?").run(documentId, seq);
		db.prepare("UPDATE document_revisions SET version = 1, content = ? WHERE document_id = ? AND seq = ?").run(JSON.stringify({ items }), documentId, seq);
	} finally {
		db.close();
	}
}

/** A background task that sleeps, so a stop can be observed while it is still live. */
export const SleeperTask = defineTask<{ readonly ms: number }, { readonly phase: "sleep" }, { readonly slept: true }>({
	name: "test.native-control-sleeper",
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: async (_task, runtime, context) => {
			await runtime.sleep(runtime.now() + 400, context);
			await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: { slept: true } } } as const), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted", reason: "stopped" } } as const), context);
	},
});

/** A registry with the sleeper task installed, for the background-isolation test. */
export function backgroundRegistry(): Registry {
	const registry = createRegistry();
	registry.install(defineExtension({ name: "test.native-control-background", tasks: [SleeperTask] }));
	return registry;
}

/** Create a background sleeper task of one conversation; the caller waits on its ID. */
export function startBackgroundSleeper(conversation: Conversation, ms = 400): Promise<TaskId<{ readonly slept: true }>> {
	return conversation.commit(tx => tx.createTask(SleeperTask, { ms }, { ownership: { kind: "conversation" }, background: true }), BACKGROUND_CONTEXT);
}
