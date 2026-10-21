import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  ConversationBusy,
  createRegistry,
  Harness,
  InboxDoc,
  MemoryStorage,
  type Conversation,
  type InboxItem,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { submitConversationInput } from "../src/conversation-input.ts";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

type Rig = {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly faux: FauxProviderHandle;
  /** Releases the first held response; a no-op when the rig was opened without holding one. */
  release(): void;
};

function lastUserText(messages: readonly Message[]): string {
  const message = messages.findLast(candidate => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content);
}

/**
 * A real harness over `MemoryStorage` and the faux provider: the adapter runs against the native runtime, and every
 * assertion reads native state — `Harness.inspect`, the submission handle, the committed entries — rather than a test
 * double. With `holdFirst`, the first model answer is held so "the conversation is busy" is a real state, not a race.
 */
async function openRig(t: TestContext, holdFirst = false): Promise<Rig> {
  const faux = fauxProvider();
  let releaseResponse = () => {};
  const gate = new Promise<void>(resolve => { releaseResponse = resolve; });
  let held = false;
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    if (holdFirst && !held) { held = true; await gate; }
    return fauxAssistantMessage("answer: " + lastUserText(transcript.messages));
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: MODEL } });
  harness.resume();
  t.after(() => harness.close(BACKGROUND_CONTEXT));
  return { harness, conversation, faux, release: () => releaseResponse() };
}

/** The native `pi.inbox` items, read through the public transaction seam the adapter writes them with. */
async function inboxItems(conversation: Conversation): Promise<readonly InboxItem[]> {
  return conversation.commit(
    // The committed value is copied while the transaction's overlay is live; a draft node is not readable after commit.
    async (tx) => copyJson([...(await tx.doc(InboxDoc, conversation.id)).items]) as unknown as readonly InboxItem[],
    BACKGROUND_CONTEXT,
  );
}

test("triggerTurn true delegates to the native submit and runs the turn", async (t) => {
  const rig = await openRig(t);
  const id = await submitConversationInput(
    rig.conversation,
    { type: "input", content: [{ type: "text", text: "hello" }], requestId: "default" },
    BACKGROUND_CONTEXT,
  );
  const handle = await rig.harness.submission(id, BACKGROUND_CONTEXT);
  assert.ok(handle !== undefined);
  const settled = await handle.wait(BACKGROUND_CONTEXT);
  // The native path placed the input, ran the model once, and answered it: the adapter returned the native ID.
  assert.equal(settled.status, "done");
  assert.equal(rig.faux.state.callCount, 1);
  const entries = (await rig.conversation.context(BACKGROUND_CONTEXT)).entries;
  assert.deepEqual(entries.map(entry => entry.kind), ["pi.user", "pi.assistant"]);
  assert.equal(lastUserText(entries[0].model ?? []), "hello");
});

test("triggerTurn false enqueues without running, and a replay never duplicates or overwrites", async (t) => {
  const rig = await openRig(t);
  const draft = { type: "input" as const, content: [{ type: "text" as const, text: "queued text" }], requestId: "queued-1", triggerTurn: false };
  const id = await submitConversationInput(rig.conversation, draft, BACKGROUND_CONTEXT);
  // No model call and no entry: the input is admitted but has not reached a boundary, which only the native snapshot says.
  assert.equal(rig.faux.state.callCount, 0);
  assert.deepEqual((await rig.conversation.context(BACKGROUND_CONTEXT)).entries, []);
  const queued = (await rig.harness.inspect(BACKGROUND_CONTEXT)).submissions;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, id);
  assert.equal(queued[0].type, "input");
  assert.equal(queued[0].status, "queued");
  assert.equal(queued[0].requestId, "queued-1");
  // A replay returns the same submission and writes no second one.
  assert.equal(await submitConversationInput(rig.conversation, draft, BACKGROUND_CONTEXT), id);
  const items = await inboxItems(rig.conversation);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.ok(item.mode !== "write");
  assert.equal(item.mode, "followUp");
  assert.deepEqual(item.content, [{ type: "text", text: "queued text" }]);
  // An edit to the queued native item survives a retry: dedup returns the existing submission and never rewrites the item.
  await rig.conversation.commit(async (tx) => {
    const live = (await tx.doc(InboxDoc, rig.conversation.id)).items.find(candidate => candidate.id === id);
    if (live !== undefined && live.mode !== "write") live.content = copyJson([{ type: "text", text: "edited text" }]) as typeof live.content;
  }, BACKGROUND_CONTEXT);
  assert.equal(await submitConversationInput(rig.conversation, draft, BACKGROUND_CONTEXT), id);
  const edited = await inboxItems(rig.conversation);
  assert.equal(edited.length, 1);
  assert.ok(edited[0].mode !== "write");
  assert.deepEqual(edited[0].content, [{ type: "text", text: "edited text" }]);
  // The native cancel withdraws the queued input; a replay after it returns the settled record and writes nothing new.
  assert.equal(await rig.harness.abortSubmission(id, BACKGROUND_CONTEXT), "aborted");
  assert.deepEqual((await rig.harness.inspect(BACKGROUND_CONTEXT)).submissions, []);
  const cancelled = await rig.harness.submission(id, BACKGROUND_CONTEXT);
  assert.ok(cancelled !== undefined);
  assert.equal((await cancelled.status(BACKGROUND_CONTEXT)).status, "unanswered");
  assert.deepEqual(await inboxItems(rig.conversation), []);
  assert.equal(await submitConversationInput(rig.conversation, draft, BACKGROUND_CONTEXT), id);
  assert.deepEqual((await rig.harness.inspect(BACKGROUND_CONTEXT)).submissions, []);
  assert.deepEqual(await inboxItems(rig.conversation), []);
});

test("a manual enqueue keeps steer and entry metadata, and reject busy stays the native refusal", async (t) => {
  const rig = await openRig(t, true);
  // Occupy the conversation with a held run so "busy" is observable.
  await rig.conversation.submit({ type: "input", content: [{ type: "text", text: "hold" }], requestId: "hold" }, BACKGROUND_CONTEXT);
  await assert.rejects(
    submitConversationInput(
      rig.conversation,
      { type: "input", content: [{ type: "text", text: "rejected" }], requestId: "rejected", whenBusy: "reject", triggerTurn: false },
      BACKGROUND_CONTEXT,
    ),
    error => error instanceof ConversationBusy,
  );
  assert.equal((await rig.harness.inspect(BACKGROUND_CONTEXT)).submissions.some(submission => submission.requestId === "rejected"), false);
  rig.release();
  await rig.harness.waitForIdle(BACKGROUND_CONTEXT);
  // Enqueue a steer with a custom entry: still queued, still no run of its own.
  const kept = await submitConversationInput(
    rig.conversation,
    { type: "input", content: [{ type: "text", text: "kept content" }], requestId: "note", whenBusy: "steer", entry: { kind: "app.note", data: { author: "amy" } }, triggerTurn: false },
    BACKGROUND_CONTEXT,
  );
  const queued = (await inboxItems(rig.conversation)).find(item => item.id === kept);
  assert.ok(queued !== undefined && queued.mode === "steer");
  assert.equal(rig.faux.state.callCount, 1);
  // A later native submit continues the queue; the custom entry lands with its kind, data, and content intact.
  await rig.conversation.submit({ type: "input", content: [{ type: "text", text: "continue" }], requestId: "continue", whenBusy: "followUp" }, BACKGROUND_CONTEXT);
  await rig.harness.waitForIdle(BACKGROUND_CONTEXT);
  const placed = (await rig.conversation.context(BACKGROUND_CONTEXT)).entries.find(entry => entry.kind === "app.note");
  assert.ok(placed !== undefined);
  assert.deepEqual(placed.data, { author: "amy" });
  assert.equal(lastUserText(placed.model ?? []), "kept content");
  const keptHandle = await rig.harness.submission(kept, BACKGROUND_CONTEXT);
  assert.ok(keptHandle !== undefined);
  assert.equal((await keptHandle.status(BACKGROUND_CONTEXT)).status, "done");
});
