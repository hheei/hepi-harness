/**
 * One subtree request's per-child record, as it becomes durable **while the request is still running**.
 *
 * The operation controls its children concurrently because each child's own runtime contract is independent of its
 * siblings. Its outcomes were nevertheless committed only after `Promise.all` had collected every child, so a request
 * with one fast child and one child still draining had `pending` for **both** until the slow child settled: a reader
 * mid-flight was told nothing had been reached, and a process killed in that window (or a caller retrying the same
 * identity) resumed with every child — including the one it had already controlled — still to do.
 *
 * These cases hold one child inside its model answer, so "the slow child is still draining" is a state the test creates
 * rather than a race it hopes to win. Everything runs over `MemoryStorage` and the faux provider: no store file, no
 * socket, no clock, and no wait that is a sleep. A child that has settled is detected by an event the runtime really
 * emits (a task carrying its abort mark), never by a delay.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type CommitPublication,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type Submission,
} from "@earendil-works/pi-durable";
import { createConversationOperations, type ConversationOperations } from "../src/conversation-operations.ts";
import { SubtreeControlDoc } from "../src/subtree-control.ts";

const MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

function lastUserText(messages: readonly Message[]): string {
  const message = messages.findLast((candidate) => candidate.role === "user");
  return message === undefined ? "" : contentText(message.content);
}

/**
 * The answer gate: a conversation whose last user text is held here does not answer until it is released, and a caller
 * can wait until that answer has really been entered. Both facts are events, so a test states "this run is in flight"
 * without a delay and without assuming which turn the scheduler takes next.
 */
class AnswerGate {
  #held = new Set<string>();
  #entered = new Map<string, () => void>();
  #waiters: (() => void)[] = [];

  hold(text: string): void { this.#held.add(text); }

  release(): void {
    this.#held.clear();
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  /** Resolve once the model has really been entered for this text, whether or not it is held. */
  async entered(text: string): Promise<void> {
    if (!this.#held.has(text)) return;
    await new Promise<void>((resolve) => { this.#entered.set(text, resolve); });
  }

  /** Take the answer for one text: signal entry, then wait while the text is held. */
  async pass(text: string, answer: string): Promise<string> {
    this.#entered.get(text)?.();
    this.#entered.delete(text);
    if (this.#held.has(text)) await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    return answer;
  }
}

type Rig = {
  readonly harness: Harness;
  readonly operations: ConversationOperations;
  readonly gate: AnswerGate;
  /** Every subtree record a commit published, in commit order, as the outcome keys it carried. */
  readonly records: string[][];
};

/** A real harness over in-memory storage and the faux provider, observed through the runtime's public commit seam. */
async function open(t: TestContext): Promise<Rig> {
  const gate = new AnswerGate();
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    const text = lastUserText(transcript.messages);
    return fauxAssistantMessage(await gate.pass(text, "answer: " + text));
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harness.resume();
  t.after(async () => { gate.release(); await harness.close(BACKGROUND_CONTEXT); });
  const records: string[][] = [];
  t.after(harness.subscribeCommits((publication: CommitPublication) => {
    for (const change of publication.changes) {
      if (change.type !== "document" || change.record.kind !== SubtreeControlDoc.definition.kind) continue;
      const value = change.value as { outcomes?: Record<string, unknown> } | null;
      if (value === null) continue;
      records.push(Object.keys(value.outcomes ?? {}));
    }
  }));
  return { harness, operations: createConversationOperations(harness), gate, records };
}

const conversation = async (rig: Rig, id: string): Promise<Conversation> => {
  const attached = await rig.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(attached !== undefined, "conversation " + id);
  return attached;
};

const spawn = async (rig: Rig, requestId: string, displayParentId?: string): Promise<string> =>
  (await rig.operations.spawn({
    requestId,
    ownership: { kind: "ownerless" },
    ...(displayParentId === undefined ? {} : { displayParentId }),
    agent: { model: MODEL },
  })).conversationId;

const submit = (rig: Rig, id: string, text: string): Promise<Submission> =>
  conversation(rig, id).then((attached) => attached.submit({ type: "input", content: [{ type: "text", text }] }, BACKGROUND_CONTEXT));

/**
 * Resolve once the runtime has published the live task of `id` as abort-marked, which is the commit an interrupt makes
 * before it waits for that child to drain. A child's abort is therefore known to have landed without polling for it.
 */
function whenAbortMarked(rig: Rig, id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = rig.harness.subscribeCommits((publication: CommitPublication) => {
      for (const change of publication.changes) {
        if (change.type !== "task") continue;
        if (String(change.value.conversationId) !== id || !change.value.abortRequested) continue;
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Let every commit already queued ahead of the caller run, so a record written by an operation that has just answered a
 * child is readable. This yields session-line turns, not time: a record that was never enqueued is never observed.
 */
async function flush(rig: Rig, turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await rig.harness.commit(() => undefined, BACKGROUND_CONTEXT);
}

const statusOf = (answer: { outcomes: readonly { conversationId: string; status: string }[] } | undefined, id: string): string | undefined =>
  answer?.outcomes.find((outcome) => outcome.conversationId === id)?.status;

test("a child that settled is durable while its slower sibling still drains", async (t) => {
  const rig = await open(t);
  const root = await spawn(rig, "progress-root");
  const fast = await spawn(rig, "progress-fast", root);
  const slow = await spawn(rig, "progress-slow", root);
  // The slow child is really running and answers only when the test says so, so the request stays in flight.
  rig.gate.hold("slow work");
  const slowRun = submit(rig, slow, "slow work");
  await rig.gate.entered("slow work");

  const request = rig.operations.subtreeControl(root, { requestId: "progress-1", action: "interrupt", stopSource: "user" });
  await whenAbortMarked(rig, slow);
  await flush(rig);

  // Mid-flight: the fast child has no live work, so its interrupt is done and its outcome is the record's own, while the
  // slow child is still draining and is still `pending`.
  const progress = await rig.operations.subtreeControlRequest(root, "progress-1");
  assert.equal(progress?.status, "pending", "the request has not finished");
  assert.equal(statusOf(progress, fast), "already-settled", "the child that settled states its own outcome");
  assert.equal(statusOf(progress, slow), "pending", "the child still draining states none");
  // The same fact in the order the store saw it: a record carrying one child's outcome and not the other's.
  const single = rig.records.find((keys) => keys.length === 1 && keys[0] === fast);
  assert.deepEqual(single, [fast], "the record published by the child that settled, before its sibling answered");

  rig.gate.release();
  const answer = await request;
  await slowRun.then((handle) => handle.wait(BACKGROUND_CONTEXT));
  assert.equal(answer.status, "completed");
  assert.deepEqual(answer.outcomes.map((outcome) => [outcome.conversationId, outcome.status]), [[fast, "already-settled"], [slow, "accepted"]]);
  // Each child was reached once: the record that was already durable is not written again.
  assert.deepEqual(rig.records.at(-1), [fast, slow]);
});

test("a resume of the same request does not re-reach the child it already settled, so new work there survives", async (t) => {
  const rig = await open(t);
  const root = await spawn(rig, "resume-root");
  const fast = await spawn(rig, "resume-fast", root);
  const slow = await spawn(rig, "resume-slow", root);
  rig.gate.hold("slow work");
  const slowRun = submit(rig, slow, "slow work");
  await rig.gate.entered("slow work");

  const request = rig.operations.subtreeControl(root, { requestId: "resume-1", action: "interrupt", stopSource: "user" });
  await whenAbortMarked(rig, slow);
  await flush(rig);
  assert.equal(statusOf(await rig.operations.subtreeControlRequest(root, "resume-1"), fast), "already-settled");

  // The user gives the settled child new work, which is genuinely in flight when the request is asked for again.
  rig.gate.hold("new work");
  const newWork = submit(rig, fast, "new work");
  await rig.gate.entered("new work");

  // A separate operations instance over the same store: the record, not this call's memory, is what a resumed request
  // reads. This is the receipt the slow child's drain used to withhold.
  const resumed = createConversationOperations(rig.harness);
  const retry = resumed.subtreeControl(root, { requestId: "resume-1", action: "interrupt", stopSource: "user" });
  rig.gate.release();
  const [first, second] = await Promise.all([request, retry]);

  assert.equal(statusOf(second, fast), "already-settled", "the retry states the settled child's recorded outcome");
  assert.equal(statusOf(first, fast), "already-settled");
  // The new work answered instead of being swept by the retry's abort of a child it had already controlled.
  const settled = await newWork.then((handle) => handle.wait(BACKGROUND_CONTEXT));
  assert.equal(settled.status, "done", "the child's new work ran to an answer");
  assert.equal((await (await conversation(rig, fast)).control(BACKGROUND_CONTEXT)).state, "allowed", "an interrupt sets no hold");
  await slowRun.then((handle) => handle.wait(BACKGROUND_CONTEXT));
});
