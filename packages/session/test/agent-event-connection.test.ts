import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventConnection,
  type AgentEventSourceLike,
} from "../src/agent-event-connection.ts";

/** A stand-in source: the handshake and the frames are driven by the test, never by a socket. */
type FakeSource = AgentEventSourceLike & {
  readonly sessionId: string;
  closeCount: number;
  message(event: unknown): void;
  open(): void;
};

/**
 * The handshake deadline and the reconnect delay are this file's to run: they are advanced by the test, not waited on
 * by it, so a test that reaches a timeout reaches it at the same point every run.
 */
function harness(t: test.TestContext, readinessTimeoutMs = 100) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources: FakeSource[] = [];
  const connection = new AgentEventConnection({
    createSource(sessionId) {
      let readyState = 0;
      const source: FakeSource = {
        sessionId, closeCount: 0,
        get readyState() { return readyState; },
        onmessage: null, onerror: null,
        message(event) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); },
        close() { readyState = 2; this.closeCount++; },
        open() { readyState = 1; this.message({ type: "connected" }); },
      };
      sources.push(source);
      return source;
    },
    readinessTimeoutMs, reconnectDelayMs: 5,
  });
  t.after(() => {
    connection.close();
    t.mock.timers.reset();
  });
  return { connection, sources, advance: (ms: number) => t.mock.timers.tick(ms) };
}

test("readers share one stream, reconnect together, and release independently of other conversations", async (t) => {
  const { connection, sources } = harness(t);
  const seen: string[][] = [[], []];
  const a = connection.subscribe("conv", event => seen[0]!.push(event.type));
  const b = connection.subscribe("conv", event => seen[1]!.push(event.type));
  const other = connection.subscribe("other", () => {});
  assert.deepEqual(sources.map(source => source.sessionId), ["conv", "other"]);
  sources[0]!.open();
  sources[1]!.open();
  await Promise.all([a.ready(), b.ready(), other.ready()]);
  a.reconnect();
  assert.equal(sources[0]!.closeCount, 1);
  sources[2]!.open();
  await Promise.all([a.ready(), b.ready()]);
  sources[2]!.message({ type: "submission" });
  assert.deepEqual(seen, Array.from({ length: 2 }, () => ["connected", "connected", "submission"]));
  a.release();
  sources[2]!.message({ type: "agent_start" });
  assert.equal(seen[0]!.length, 3);
  assert.equal(seen[1]!.at(-1), "agent_start");
  assert.equal(sources[2]!.closeCount, 0, "one reader leaving does not close the stream another still reads");
  b.release();
  assert.equal(sources[2]!.closeCount, 1, "the last reader leaving closes the source");
  assert.equal(sources[1]!.closeCount, 0, "another conversation's source is untouched");
  other.release();
});

test("release, missing handshake and explicit startup refusal reject readiness", async (t) => {
  const { connection, sources, advance } = harness(t, 10);
  const released = connection.subscribe("released", () => assert.fail("released reader heard a frame"));
  const ready = released.ready();
  released.release();
  await assert.rejects(ready, (error: Error & { status?: string }) => error.status === "closed");
  sources[0]!.open();
  const timeout = connection.subscribe("timeout", () => {});
  const timeoutReady = timeout.ready();
  // No handshake frame arrives, so advancing to the deadline is the timeout: the rejection is the assertion's to await.
  advance(10);
  await assert.rejects(timeoutReady, (error: Error & { status?: string }) => error.status === "ready_timeout");
  timeout.release();
  const refused = connection.subscribe("refused", () => {});
  const refusedReady = refused.ready();
  sources.filter(source => source.sessionId === "refused").at(-1)!
    .message({ type: "startup_error", errorMessage: "broken config" });
  await assert.rejects(
    refusedReady,
    (error: Error & { status?: string }) => error.status === "startup_error" && error.message === "broken config",
  );
  // A refusal is the conversation declining to run, so no retry is scheduled at all: advancing well past the reconnect
  // delay opens no replacement attachment for it.
  advance(50);
  assert.equal(sources.filter(source => source.sessionId === "refused").length, 1, "explicit refusal is not retried");
});

/**
 * One conversation's window as the backend publishes it. The frames below are the wire's own: what a reader makes of
 * them is decided above this transport, which is why the continuity it hands over is checked as the frames it was
 * assembled from rather than as a projection.
 */
const baseline = { protocol: "hepi.v1", conversationId: "conv", revision: 1, partial: "", busy: false, oldestEntryId: null, hasMore: false, entries: [{ id: "e1", role: "user", text: "hi" }] };
const { entries: _ignored, ...scalars } = baseline;
const delta = { ...scalars, revision: 2, baseRevision: 1, appended: [{ id: "e2", role: "assistant", text: "there" }], oldestEntryId: "e1", hasMore: true };

test("a reader joining a stream already open is handed its continuity instead of an empty state", async (t) => {
  const { connection, sources } = harness(t);
  const a = connection.subscribe("conv", () => {});
  sources[0]!.open();
  await a.ready();
  assert.equal(a.continuity(), null, "the first reader of an attachment has nothing to be handed");
  sources[0]!.message({ type: "frame", event: "snapshot", data: baseline });
  sources[0]!.message({ type: "frame", event: "state", data: delta });
  // The reader that joins second is the one a handover creates: a surface selecting a conversation a background watch
  // is already holding, or a watch inheriting one the surface was showing.
  const b = connection.subscribe("conv", () => {});
  assert.equal(sources.length, 1, "the reader that joined reused the conversation's one source");
  const joined = b.continuity();
  assert.equal(joined?.conversationId, "conv", "the handed state is bound to this conversation, so its frames fold");
  assert.equal(joined?.revision, 2, "and it is where the stream is now, not where it started");
  assert.deepEqual(joined?.entries.map(entry => entry.id), ["e1", "e2"], "with the window the stream assembled");
  // What the stream receives after the join is the joiner's own to fold, from exactly where it was handed over.
  sources[0]!.message({ type: "frame", event: "state", data: { ...delta, revision: 3, baseRevision: 2, appended: [{ id: "e3", role: "user", text: "more" }] } });
  assert.equal(b.continuity()?.revision, 2, "the transfer is taken once and does not follow the stream");
  a.release();
  b.release();
});

test("a stream that cannot continue a frame hands over nothing rather than a window that is not its own", async (t) => {
  const { connection, sources } = harness(t);
  const a = connection.subscribe("conv", () => {});
  sources[0]!.open();
  await a.ready();
  // A delta before any baseline: the attachment has stated no window, so there is none to hand a joiner. The joiner is
  // answered the way a revision gap is — it asks the conversation — instead of being told the conversation is empty.
  sources[0]!.message({ type: "frame", event: "state", data: delta });
  assert.equal(connection.subscribe("conv", () => {}).continuity(), null, "an unstated window is not handed over");
  sources[0]!.message({ type: "frame", event: "snapshot", data: baseline });
  assert.equal(connection.subscribe("conv", () => {}).continuity()?.revision, 1, "the baseline is what restates it");
  // A replacement attachment is a new lifecycle clock for the same history: it states nothing until it states it.
  a.reconnect();
  sources[1]!.open();
  await a.ready();
  assert.equal(connection.subscribe("conv", () => {}).continuity(), null, "the previous attachment's window is not carried over");
  sources[1]!.message({ type: "frame", event: "snapshot", data: { ...baseline, revision: 7 } });
  assert.equal(connection.subscribe("conv", () => {}).continuity()?.revision, 7, "and the replacement's own baseline is");
  a.release();
});

