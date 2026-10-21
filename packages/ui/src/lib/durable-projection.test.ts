import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AgentMessage, AssistantMessage, TextContent } from "./types.ts";
import type { LiveFacts, NativeEntryPage, NativeSnapshot, SessionScalars } from "./durable-projection.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { projectAgentState, projectContext, projectLive, projectMessages, projectSession } = await jiti.import<typeof import("./durable-projection.ts")>("./durable-projection.ts");

/**
 * The browser's one projection, asserted at its own seam: the backend's native payload in, the UI shape out.
 *
 * What this pins is the two things the ticket is about. First, the committed message and the metadata around it travel
 * **unchanged** — the projection never re-derives a message, so the deferred-block metadata a heavy entry carries is
 * still there when the surface renders it. Second, every scalar the backend states is either carried into the shape or
 * deliberately absent: nothing is synthesized that the payload did not say.
 */
/** One deferred text block, as the backend's own frame states it: a bounded preview and the read block behind it. */
const deferred: TextContent & { url: string; totalBytes: number } = { type: "text", text: "bounded preview", deferred: true, url: "/api/sessions/7/entries/11/text?blockIndex=0", totalBytes: 1_572_864 };
/** The committed message the frame carries, in the renderer's own shape. */
const message: AgentMessage = { role: "assistant", content: [{ type: "text", text: "hello" }, deferred], model: "m", provider: "p", stopReason: "endTurn" };

/** The message a case reached, asserted to be the assistant turn it is about. */
function assistantOf(candidate: AgentMessage | null | undefined): AssistantMessage {
  assert.ok(candidate !== undefined && candidate !== null, "the projection answered with a message");
  assert.equal(candidate.role, "assistant");
  return candidate as AssistantMessage;
}

/** One committed entry as the frame states it: the id the transcript mounts and the message behind it. */
function entryOf(id: string): NativeSnapshot["entries"][number] {
  return { id, role: "assistant", text: "hello", message };
}

const snapshot = (overrides: Partial<NativeSnapshot> = {}): NativeSnapshot => ({
  protocol: "hepi.v1",
  conversationId: "7",
  projectionId: "P-7",
  revision: 6,
  historyRevision: "rev-6",
  historyHead: "h-6",
  hasMore: true,
  oldestEntryId: "900",
  run: { inputs: ["s1"] },
  busy: true,
  entries: [entryOf("900")],
  partial: "partial text",
  toolNames: ["bash"],
  extensions: ["coding-tools"],
  liveTools: [],
  settings: { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" },
  queuedMessages: { steering: ["s"], followUp: ["f"] },
  queuedItems: [],
  control: { state: "allowed", revision: 0 },
  failure: { reason: "no_model", message: "no model" },
  submissions: [{ protocol: "hepi.v1", conversationId: "7", submissionId: "s1", type: "input", status: "done", entryId: "900", answerId: "a1" }],
  ...overrides,
});

test("the native message and its deferred metadata reach the surface unchanged", () => {
  const projected = projectSession(snapshot());
  const rendered = assistantOf(projected.context.messages[0]);
  // The payload is kept, never re-derived: the projection normalizes tool-call field names into the shape the renderer's
  // own type states and hands every other block through **by reference**, so the deferred metadata is the backend's own
  // object rather than a copy of it.
  assert.deepEqual(rendered, message);
  assert.equal(rendered.content[1], deferred, "deferred metadata block is the backend's own object");
  assert.deepEqual(projectMessages(snapshot().entries), [message]);
});

test("every lifecycle scalar the backend states is carried, and none is invented", () => {
  const projected = projectSession(snapshot());
  assert.equal(projected.sessionId, "7");
  assert.equal(projected.projectionId, "P-7");
  assert.equal(projected.revision, 6);
  assert.equal(projected.snapshotRevision, "rev-6");
  assert.equal(projected.historyHead, "h-6");
  assert.deepEqual(projected.run, { inputs: ["s1"] });
  assert.deepEqual(projected.submissions, snapshot().submissions);
  assert.deepEqual(projected.toolNames, ["bash"]);
  assert.deepEqual(projected.failure, { reason: "no_model", message: "no model" });
  assert.deepEqual(projected.context.entryIds, ["900"]);
  assert.equal(projected.context.oldestEntryId, "900");
  assert.equal(projected.context.hasMore, true);
  assert.equal(projected.context.thinkingLevel, "high");
  assert.deepEqual(projected.context.model, { provider: "p", modelId: "m" });
  // The runtime's window states no branch, so the projection has no branch tree and no session file or active time to
  // report: a payload that carries no such fact states none rather than a placeholder the UI would render as one.
  assert.equal("tree" in projected, false);
  assert.equal("filePath" in projected, false);
  assert.equal("totalActiveMs" in projected, false);
  assert.equal(projected.leafId, "900");
});

test("a complete window states no boundary, and an absent model stays absent", () => {
  const whole = projectSession(snapshot({ oldestEntryId: null, hasMore: false, settings: { model: null, thinkingLevel: "off" }, busy: false, run: null, failure: null }));
  assert.equal(whole.context.oldestEntryId, null);
  assert.equal(whole.context.hasMore, false);
  assert.equal(whole.context.model, null);
  assert.deepEqual(whole.run, null);
  assert.equal(whole.failure, null);
  // The agent-state view the composer reads carries the same facts: a conversation with no selected model reports none
  // rather than being handed a fabricated default, and the running flag is the native run's.
  const state = projectAgentState(snapshot({ busy: false, settings: { model: null, thinkingLevel: "off" } }));
  assert.equal(state.running, false);
  assert.equal(state.state.isStreaming, false);
  assert.deepEqual(state.extensions, ["coding-tools"]);
  assert.equal(state.state.model, undefined);
  assert.deepEqual(state.state.queuedMessages, { steering: ["s"], followUp: ["f"] });
  // The committed control rides the same frame as the queue it governs, so the composer's view of "held" and the
  // queued items it is holding cannot come from two different statements.
  assert.deepEqual(state.state.control, { state: "allowed", revision: 0 });
});

test("a frame's live facts are projected once, and absence is authoritative", () => {
  // The live rendering comes from the same frame as the committed window, so the two cannot describe different runs.
  const live = projectLive(snapshot());
  assert.equal(live.busy, true);
  assert.equal(live.partial, "partial text");
  assert.deepEqual(live.queuedMessages, { steering: ["s"], followUp: ["f"] });
  assert.deepEqual(live.extensions, ["coding-tools"]);
  // A frame that states no live message and no live tools says the run has ended: the projection states the empty value
  // rather than keeping whatever a previous frame carried, which is what would leave a bubble on screen.
  const ended = projectLive(snapshot({ busy: false, liveMessage: undefined, liveTools: undefined }));
  assert.equal(ended.liveMessage, null);
  assert.deepEqual(ended.liveTools, []);
  // A streaming tool call declared under another name field is read into the renderer's own shape, exactly as a
  // committed one is.
  // The runtime's own streamed call names its tool differently from the committed shape, which is what the projection
  // normalizes; the fixture states that wire shape as the frame really carries it.
  const streamedCall = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } as unknown as AgentMessage;
  const streaming = projectLive(snapshot({ liveMessage: streamedCall }));
  assert.deepEqual(assistantOf(streaming.liveMessage).content, [{ type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "ls" } }]);
});

test("a browser-held stream state projects through the same session and live projections", () => {
  // The state a fold produced is a native snapshot the client holds: the same two projections read it, so a streamed
  // frame and a read cannot disagree about the shape the surface renders.
  // The state a fold produced carries the frame's own protocol and revision beside the facts the two projections read.
  type HeldState = SessionScalars & LiveFacts & { readonly protocol: string; readonly revision: number };
  const held: HeldState = {
    protocol: "hepi.v1", conversationId: "7", revision: 6,
    projectionId: "P-7", historyRevision: "rev-6", historyHead: "h-6", hasMore: true, oldestEntryId: "900",
    run: { inputs: ["s1"] }, busy: true, partial: "partial text",
    entries: [entryOf("900")],
    toolNames: ["bash"], extensions: ["coding-tools"], liveTools: [], liveMessage: undefined,
    settings: { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" },
    queuedMessages: { steering: ["s"], followUp: ["f"] }, failure: { reason: "no_model", message: "no model" },
    submissions: [],
  };
  assert.deepEqual(projectSession(held), projectSession(snapshot({ submissions: [] })));
  assert.deepEqual(projectLive(held), projectLive(snapshot()));
});

test("an older-history page is projected as the entries it carries", () => {
  const page: NativeEntryPage = { entries: snapshot().entries, oldestEntryId: "900", hasMore: true };
  const projected = projectContext(page);
  assert.deepEqual(projected, { messages: [message], entryIds: ["900"], oldestEntryId: "900", hasMore: true });
  // A page states no settings: the accepted snapshot the surface holds already owns the model and the reasoning level.
  assert.equal("model" in projected, false);
  assert.equal("thinkingLevel" in projected, false);
});
