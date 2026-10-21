import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createJiti } from "jiti";
import type { AgentEventSourceLike } from "@hepi/session/browser";
import type { HeldEntry, SessionState } from "@hepi/session";
import type { CompletionNotice } from "./completion-delivery.ts";
import type { SessionScalars } from "./durable-projection.ts";
import type { SubmissionProjection } from "@hepi/protocol";
import type { State } from "./lifecycle-projection.ts";
import type { AgentMessage } from "./types.ts";

// The same resolution the app uses: the modules under test import through the `@` alias.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { CompletionDelivery } = await jiti.import<typeof import("./completion-delivery.ts")>("./completion-delivery.ts");
const { projectSession, projectLive } = await jiti.import<typeof import("./durable-projection.ts")>("./durable-projection.ts");
const { advance, createProjection } = await jiti.import<typeof import("./lifecycle-projection.ts")>("./lifecycle-projection.ts");
const { httpStatement, sseStatement, receiveAccepted } = await jiti.import<typeof import("./lifecycle-acquisition.ts")>("./lifecycle-acquisition.ts");
const { emptyStreamState, reduceSseFrame } = await jiti.import<typeof import("@hepi/session")>("@hepi/session");
const { AgentEventConnection } = await jiti.import<typeof import("@hepi/session/browser")>("@hepi/session/browser");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The text of a projected message, as the surface reads it: a string, or the message's own text blocks. */
function textOf(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  return typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * Reader handover over one physical stream.
 *
 * A conversation has one source however many readers join it, so the reader that joins second — a surface selecting a
 * conversation a background watch is already holding, or a watch inheriting one the surface was showing — is handed
 * where the stream is **now**. Without that transfer its own continuity is an empty state bound to nothing: the shared
 * reducer refuses the next delta, and a surface that projected the state it held would publish an empty transcript over
 * the window it already had, while a watch could never read the terminal frame that would free its slot.
 *
 * Both readers here are the real ones — the real `CompletionDelivery`, which owns the real `AgentEventConnection`, the
 * real reducer, the real projection and the real acceptance fold — over a synthetic source, so the seam under test is
 * the production one and only the socket is fake. Neither case exercises a browser; the browser drivers cover the same
 * seam against the real app.
 */
const submission: SubmissionProjection = { protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", requestId: "r1", type: "input", status: "placed", entryId: "e1" };
/** The one committed entry the window carries: the id the transcript mounts, and the message behind it. */
const heldEntries: HeldEntry<AgentMessage>[] = [{ id: "e1", role: "user", text: "hi", message: { role: "user", content: "hi" } }];

/** The stream's own state once the first snapshot landed, and the scalars a later delta continues it with. */
const baseline: SessionState<AgentMessage> = {
  ...emptyStreamState<AgentMessage>("conv"), projectionId: "P", revision: 1, historyHead: null, historyRevision: "h1",
  oldestEntryId: null, hasMore: false, run: { inputs: ["s1"] }, submissions: [submission],
  entries: heldEntries,
  settings: { model: null, thinkingLevel: "off" }, queuedMessages: { steering: [], followUp: [] },
};
const { entries: ignoredEntries, ...scalars } = baseline;
const delta = { ...scalars, revision: 2, baseRevision: 1, appended: [], partial: "live output" };
const settled = { ...delta, partial: "", busy: false, run: null, submissions: [] };

/** Stage one real turn and accept the HTTP projection of the window, which is what a surface has committed to. */
function seedStage() {
  const staged = advance(createProjection({ composerKey: "conv", conversationId: "conv" }).state, {
    kind: "stage", requestId: "r1", content: { text: "hi" }, whenBusy: "reject",
  });
  const projected = projectSession(baseline);
  const receipt = receiveAccepted(staged, httpStatement({ ...projected, run: projected.run ?? null }, 1));
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.step.state.identity, "P");
  assert.deepEqual(receipt.view.outstanding.map(item => item.submissionId), ["s1"]);
  return receipt.step;
}

/** One source the connection opened, as a case pushes a frame into it and reads whether it is still open. */
type Source = AgentEventSourceLike & { readonly conversationId: string; closed: boolean };

/** Only the socket is fake; everything above it is the production assembly. */
function harness(t: TestContext) {
  const sources: Source[] = [];
  const answers: CompletionNotice[] = [];
  // The stream is the connection's, as it is in the page: the registry joins it as a reader and opens nothing of its own.
  const connection = new AgentEventConnection({
    createSource(conversationId: string): AgentEventSourceLike {
      const source: Source = { conversationId, readyState: 1, closed: false, onmessage: null, onerror: null, close() { source.closed = true; } };
      sources.push(source);
      return source;
    },
    readinessTimeoutMs: 1000, reconnectDelayMs: 1000,
    onUnexpectedError: () => {},
  });
  const delivery = new CompletionDelivery({
    subscribe: (conversationId, listener) => connection.subscribe(conversationId, listener),
    lookup: async () => null,
    onAnswered: (notice) => answers.push(notice),
  });
  t.after(() => { delivery.close(); connection.close(); });
  const current = (id: string): Source | undefined => sources.findLast((source) => source.conversationId === id && !source.closed);
  const last = (id: string): Source | undefined => sources.findLast((source) => source.conversationId === id);
  /** A source a case states is there, so the case reads it rather than guarding what it just asserted. */
  const sourceOf = (id: string): Source => { const found = current(id); assert.ok(found !== undefined, "the conversation has an open source: " + id); return found; };
  const finished = (id: string): Source => { const found = last(id); assert.ok(found !== undefined, "the conversation was given a source: " + id); return found; };
  const emit = (id: string, event: { readonly type: string } & Record<string, unknown>) => {
    const source = current(id);
    assert.ok(source, "the conversation's own source must exist: " + id);
    source.onmessage?.({ data: JSON.stringify({ sessionId: id, ...event }) } as MessageEvent<string>);
  };
  return { delivery, sources, answers, current, sourceOf, finished, last, emit, frame: (id: string, event: string, data: unknown) => emit(id, { type: "frame", event, data }) };
}

test("a surface joining a stream a background watch already holds is handed its continuity", async (t) => {
  const h = harness(t);
  // A background watch opened the conversation's stream and folded its baseline.
  h.delivery.nominate(["conv"]);
  h.emit("conv", { type: "connected" });
  h.frame("conv", "snapshot", baseline);
  await tick();
  assert.equal(h.sources.length, 1, "the watch holds the conversation's one source");

  // The surface joins it, exactly as the hook does: the continuity is taken at the subscription and shown at once.
  h.delivery.select("conv");
  let step = seedStage();
  const held: SessionState<AgentMessage>[] = [];
  const publish = (state: SessionState<AgentMessage>) => {
    const next = projectSession(state), live = projectLive(state);
    const receipt = receiveAccepted(step, sseStatement({ ...next, sessionId: "conv", run: next.run ?? null, queuedMessages: live.queuedMessages }, 1));
    step = receipt.step;
    if (receipt.accepted) held.push(state);
    return receipt;
  };
  const foreground = h.delivery.subscribe("conv", (event) => {
    const frame = event as { readonly type?: string; readonly event?: unknown; readonly data?: { readonly conversationId?: string } };
    if (frame.type !== "frame" || frame.data?.conversationId !== "conv") return;
    const folded = reduceSseFrame(streamState, String(frame.event), frame.data);
    streamState = folded;
    if (folded.resyncRequired === true) return;
    publish(folded);
  });
  let streamState = foreground.continuity() ?? emptyStreamState("conv");
  publish(streamState);

  assert.equal(h.sources.length, 1, "the handover reused the conversation's one source");
  assert.equal(streamState.conversationId, "conv", "the handed state is bound to this conversation");
  assert.equal(streamState.revision, 1, "and it is where the stream is");
  assert.deepEqual(streamState.entries.map(entry => entry.id), ["e1"]);
  // The transcript and the live state are on screen from the transfer alone: no read has answered, and none is needed.
  assert.equal(step.state.identity, "P", "the accepted identity is the conversation's own, not an empty one");
  assert.equal(step.state.revision, 1);
  assert.deepEqual(step.view.messages.map(textOf), ["hi"]);
  assert.deepEqual(step.view.outstanding.map(item => item.submissionId), ["s1"]);
  assert.deepEqual(step.view.activity, { inputs: ["s1"] });

  // The next delta continues the handed window instead of replacing it with what the delta alone carried.
  h.frame("conv", "state", delta);
  assert.equal(streamState.revision, 2);
  assert.equal(streamState.partial, "live output");
  assert.equal(step.state.revision, 2, "the delta advanced the accepted window");
  assert.equal(step.state.identity, "P");
  assert.deepEqual(step.view.messages.map(textOf), ["hi"], "the transcript the surface already had is not erased");
  assert.deepEqual(step.view.activity, { inputs: ["s1"] }, "and the run it was waiting on is still the run");
  foreground.release();
});

test("a watch inheriting a running conversation reads its terminal fact and frees its slot", async (t) => {
  const h = harness(t);
  h.delivery.terminalStream(true); // Background budget: 6 - selected 1 - headroom 2 - terminal 1 = 2.
  h.delivery.select("conv");
  const foreground = h.delivery.subscribe("conv", () => {});
  h.emit("conv", { type: "connected" });
  h.frame("conv", "snapshot", baseline);
  await foreground.ready();

  // The surface hands its projection over and leaves while the watch joins: the stream is never closed and reopened.
  h.delivery.handover("conv", seedStage());
  h.delivery.select("other-selected");
  foreground.release();
  assert.equal(h.sources.length, 1, "the reverse handover also reused the conversation's one source");
  assert.equal(h.sourceOf("conv").closed, false);

  // The watch continues the stream from the state it inherited, so the terminal frames are readable at all.
  h.frame("conv", "state", settled);
  await tick();
  h.emit("conv", { type: "submission", submission: { ...submission, status: "done", answerId: "a1" } });
  await tick();
  assert.deepEqual(h.answers, [{ conversationId: "conv", answerKey: "a1" }], "the inherited run settles once, by name");

  // Settled and no longer nominated: the watch gives up the stream, and the slot it held is available again.
  h.delivery.nominate([]);
  assert.equal(h.finished("conv").closed, true, "a settled conversation holds no stream and no slot");
  h.delivery.nominate(["other-bg", "waiting-bg"]);
  await tick();
  assert.ok(h.current("other-bg"), "the first nominee is admitted");
  assert.ok(h.current("waiting-bg"), "and the slot the settled conversation released admits the next one");
  assert.equal(h.sources.filter(source => source.conversationId === "conv").length, 1, "still one source per conversation");
});
