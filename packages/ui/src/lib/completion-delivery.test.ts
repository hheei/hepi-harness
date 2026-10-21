import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createJiti } from "jiti";
import type { AgentEventSourceLike } from "@hepi/session/browser";
import type { CompletionDeliveryOptions, CompletionNotice } from "./completion-delivery.ts";
import type { NativeSnapshot } from "./durable-projection.ts";
import type { WireSubmission } from "./lifecycle-acquisition.ts";

// The same resolution the app uses: the modules under test import through the `@/` alias.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { CompletionDelivery } = await jiti.import<typeof import("./completion-delivery.ts")>("./completion-delivery.ts");
const { advance, createProjection } = await jiti.import<typeof import("./lifecycle-projection.ts")>("./lifecycle-projection.ts");
// The registry is a reader of the connection's stream, so the stream owner in these cases is the real one.
const { AgentEventConnection } = await jiti.import<typeof import("@hepi/session/browser")>("@hepi/session/browser");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const wire = (sessionId: string, submissionId: string, status: WireSubmission["status"], answerId?: string): TestSubmission => ({
  protocol: "hepi.v1", conversationId: sessionId, submissionId, type: "input", status,
  ...(status === "queued" ? {} : { entryId: "e-" + submissionId }),
  ...(answerId === undefined ? {} : { answerId }),
});
/**
 * One native window as the backend publishes it, delivered as the transport's own `frame` event: the watch folds it
 * with the shared reducer and projects the held state, exactly as the open surface does.
 */
/** One submission as a snapshot states it. */
type TestSubmission = import("@hepi/protocol").SubmissionProjection;

/** One frame the transport delivers, in the shape the stream reads. */
type TestFrame = { readonly type: "frame"; readonly sessionId: string; readonly event: "snapshot"; readonly data: NativeSnapshot };

const stateFrame = (sessionId: string, revision: number = 1, submissions: readonly TestSubmission[] = [], run: NativeSnapshot["run"] = null): TestFrame => ({
  type: "frame", sessionId, event: "snapshot",
  data: {
    protocol: "hepi.v1", conversationId: sessionId, projectionId: "P-" + sessionId, revision,
    historyRevision: "rev-" + revision, historyHead: "h1", oldestEntryId: null, hasMore: false,
    run, busy: false, partial: "", toolNames: [], extensions: [], liveTools: [],
    settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
    failure: null, submissions, queuedItems: [], control: { state: "allowed", revision: 0 },
    entries: [{ id: "e1", role: "user", text: "hi", message: { role: "user", content: "hi" } }],
  },
});
const terminal = (sessionId: string, submissionId: string = "s1", answerId: string = "a1") => ({
  type: "submission", sessionId, submission: wire(sessionId, submissionId, "done", answerId),
});

/** One source the connection opened, as a case pushes a frame into it and reads whether it is still open. */
type Source = AgentEventSourceLike & {
  readonly conversationId: string;
  readyState: number;
  closed: boolean;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  message(event: unknown): void;
};

/** The registry, the sources it opened and the notices it reported, joined the way the page joins them. */
function harness(t: TestContext, options: Partial<CompletionDeliveryOptions> = {}) {
  const sources: Source[] = [];
  const answers: CompletionNotice[] = [];
  const connection = new AgentEventConnection({
    createSource(conversationId: string): AgentEventSourceLike {
      const source: Source = {
        conversationId, readyState: 1, closed: false, onmessage: null, onerror: null,
        message(event: unknown) { source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); },
        close() { source.readyState = 2; source.closed = true; },
      };
      sources.push(source);
      return source;
    },
    readinessTimeoutMs: 1000, reconnectDelayMs: 5,
    onUnexpectedError: () => {},
  });
  const delivery = new CompletionDelivery({
    ...options,
    subscribe: (conversationId, listener) => connection.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered: (notice) => answers.push(notice),
  });
  t.after(() => { delivery.close(); connection.close(); });
  /** Whether a source the cases hold is still open, since a released watch closes it. */
  const source = (id: string): Source => {
    const found = sources.findLast((s) => s.conversationId === id && !s.closed);
    assert.ok(found !== undefined, "the conversation has an open source");
    return found;
  };
  return { delivery, sources, answers, source, maybeSource: (id: string) => sources.findLast((s) => s.conversationId === id && !s.closed) };
}

test("live shared answers report once; history, aborts and subagents stay silent", async (t) => {
  const h = harness(t, { isSuppressed: id => id === "helper" });
  h.delivery.nominate(["conv", "helper"]);
  const source = h.source("conv");
  source.message(stateFrame("conv", 1, [wire("conv", "old", "done", "history")]));
  await tick();
  assert.deepEqual(h.answers, [], "acquired history is silent");
  source.message(terminal("conv", "s1", "a1"));
  source.message(terminal("conv", "s2", "a1"));
  await tick();
  assert.deepEqual(h.answers, [{ conversationId: "conv", answerKey: "a1" }]);
  source.message({ type: "submission", sessionId: "conv", submission: { ...wire("conv", "s3", "unanswered"), reason: "aborted" } });
  await tick();
  assert.equal(h.answers.length, 1, "aborted work never sounds a success");
  h.source("helper").message(stateFrame("helper"));
  h.source("helper").message(terminal("helper"));
  await tick();
  assert.equal(h.answers.length, 1);
  assert.equal(h.delivery.settle({ conversationId: "helper", answerKey: "a1" }), false, "suppressed answers are still claimed");
  assert.equal(h.delivery.settle({ conversationId: "conv", answerKey: "a1" }), false, "another owner cannot report twice");
});

test("handover retains queued follow-ups until their own answers then releases the source", async (t) => {
  const h = harness(t);
  const conversationId = "conv";
  const submissions = [wire(conversationId, "s1", "placed"), wire(conversationId, "s2", "queued")];
  const shown = advance(createProjection({ composerKey: conversationId, conversationId }).state, {
    kind: "snapshot", conversationId, acquisition: 1, via: "sse",
    snapshot: { projectionId: "P-conv", revision: 1, data: { entries: [] }, submissions, run: { inputs: ["s1"] } },
  });
  h.delivery.select(conversationId);
  const reader = h.delivery.subscribe(conversationId, () => {});
  const source = h.source(conversationId);
  await tick();
  h.delivery.handover(conversationId, shown);
  h.delivery.select("other");
  reader.release();
  source.message(terminal(conversationId));
  await tick();
  assert.deepEqual(h.answers.map(a => a.answerKey), ["a1"]);
  assert.equal(source.closed, false, "the queued follow-up still needs this stream");
  source.message(stateFrame(conversationId, 2, [wire(conversationId, "s2", "placed")], { inputs: ["s2"] }));
  source.message(terminal(conversationId, "s2", "a2"));
  await tick();
  assert.deepEqual(h.answers.map(a => a.answerKey), ["a1", "a2"]);
  source.message(stateFrame(conversationId, 3));
  await tick();
  assert.equal(source.closed, true, "settled work holds no stream");
});

test("terminal streams reserve a slot; deferred watches recover while the foreground keeps its source", async (t) => {
  const h = harness(t);
  const live = () => h.sources.filter(s => !s.closed);
  h.delivery.nominate(["c1", "c2", "c3", "c4", "c5"]);
  assert.equal(live().length, 3);
  assert.equal(h.maybeSource("c4"), undefined);
  h.source("c1").message(stateFrame("c1"));
  await tick();
  h.delivery.nominate(["c2", "c3", "c4", "c5"]);
  await tick();
  assert.ok(h.maybeSource("c4"), "a deferred watch acquires the freed slot");
  assert.equal(live().length, 3);
  const reader = h.delivery.subscribe("shown", () => {});
  h.delivery.select("shown");
  await tick();
  assert.ok(h.maybeSource("shown"));
  assert.equal(live().length, 4);
  h.delivery.terminalStream(true);
  await tick();
  assert.ok(h.source("shown"), "the foreground stream is reserved");
  assert.equal(live().length, 3, "terminal fan-in consumes a background slot");
  h.delivery.terminalStream(false);
  await tick();
  assert.equal(live().length, 4, "closing the terminal admits a deferred watch");
  reader.release();
});
