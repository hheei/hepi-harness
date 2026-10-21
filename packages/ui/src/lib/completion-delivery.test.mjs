import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The same resolution the app uses: the modules under test import through the `@/` alias.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { CompletionDelivery } = await jiti.import("./completion-delivery.ts");
const { advance, createProjection } = await jiti.import("./lifecycle-projection.ts");
// The registry is a reader of the connection's stream, so the stream owner in these cases is the real one.
const { AgentEventConnection } = await jiti.import("@hepi/session/browser");
const tick = () => new Promise(resolve => setImmediate(resolve));
const wire = (sessionId, submissionId, status, answerId) => ({
  protocol: "hepi.v1", conversationId: sessionId, submissionId, type: "input", status,
  ...(status === "queued" ? {} : { entryId: "e-" + submissionId }),
  ...(answerId ? { answerId } : {}),
});
/**
 * One native window as the backend publishes it, delivered as the transport's own `frame` event: the watch folds it
 * with the shared reducer and projects the held state, exactly as the open surface does.
 */
const stateFrame = (sessionId, revision = 1, submissions = [], run = null) => ({
  type: "frame", sessionId, event: "snapshot",
  data: {
    protocol: "hepi.v1", conversationId: sessionId, projectionId: "P-" + sessionId, revision,
    historyRevision: "rev-" + revision, historyHead: "h1", oldestEntryId: null, hasMore: false,
    run, busy: false, partial: "", toolNames: [], extensions: [], liveTools: [],
    settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
    failure: null, submissions,
    entries: [{ id: "e1", role: "user", text: "hi", message: { role: "user", content: "hi" } }],
  },
});
const terminal = (sessionId, submissionId = "s1", answerId = "a1") => ({
  type: "submission", sessionId, submission: wire(sessionId, submissionId, "done", answerId),
});
function harness(t, options = {}) {
  const sources = [], answers = [];
  const connection = new AgentEventConnection({
    createSource(conversationId) {
      const source = {
        conversationId, readyState: 1, closed: false, onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) }); },
        close() { this.readyState = 2; this.closed = true; },
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
    onAnswered: notice => answers.push(notice),
  });
  t.after(() => { delivery.close(); connection.close(); });
  return { delivery, sources, answers, source: id => sources.findLast(s => s.conversationId === id && !s.closed) };
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
  assert.equal(h.source("c4"), undefined);
  h.source("c1").message(stateFrame("c1"));
  await tick();
  h.delivery.nominate(["c2", "c3", "c4", "c5"]);
  await tick();
  assert.ok(h.source("c4"), "a deferred watch acquires the freed slot");
  assert.equal(live().length, 3);
  const reader = h.delivery.subscribe("shown", () => {});
  h.delivery.select("shown");
  await tick();
  assert.ok(h.source("shown"));
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
