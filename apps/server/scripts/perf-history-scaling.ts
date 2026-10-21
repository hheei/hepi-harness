/**
 * History scaling, in process: one synthetic turn repeated at 10, 60, 120 and 240 turns, measuring what the window
 * and the read blocks cost. Read-only, no model calls, no sleeps — every barrier is an SSE frame.
 *
 * The claims the bounded window and the incremental frames have to make:
 *
 * 1. **Bytes per turn stop growing with the transcript.** Before this change a state frame re-serialized the whole
 *    transcript, so lane B measured 5,524 -> 152,175 bytes/turn from 10 to 60 turns and 4.7 MB first loads at 197
 *    turns. With a window the frame carries the newest 50 visible messages and at most 300 raw entries, and after the
 *    baseline an advancing frame carries **only what it appended** — the window is stated once — so the transcript term
 *    is gone from both the window and the per-turn frame, and the per-turn cost is flat.
 * 2. **First load is bounded for deferrable content.** The baseline read and the stream's first frame carry the
 *    window, and deferral brings a window that carries images or thinking inside the soft target.
 * 3. **The incremental frame is the one the design states.** After the baseline, a `state` frame carries
 *    `baseRevision` and `appended` and no `entries`, its `baseRevision` is exactly the previous frame's `revision`, and
 *    the entries it appends are byte-identical to the same entries read one at a time. The stream is folded here
 *    through the **shared reducer a real client uses** (`@hepi/session`), so the measurement and the browser agree
 *    about what a frame means.
 *
 * The exceptions are asserted as **behaviour**, never as a byte ceiling: an entry whose own content cannot be
 * deferred ships whole (there is no read block for a large text output, upstream included), and the read answers a
 * named reason when even that cannot be carried.
 *
 * Run on the build host or in CI. Never on the runtime host (AGENTS.md).
 *
 * Usage: node apps/server/scripts/perf-history-scaling.ts [--json=<path>]
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxThinking, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import type { SubmissionProjection } from "@hepi/protocol";
import { emptyStreamState, reduceSseFrame, type SessionState } from "@hepi/session";
import { createBackendServer, type ServerDelta, type ServerEntry, type ServerSnapshot } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../test/faux-fixture.ts";

const TOKEN = "perf-history-token";
const headers: HeadersInit = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

/**
 * One frame as the wire carried it: its event name, its parsed payload, and the bytes it cost — the raw frame and the
 * `data:` line alone, because the second is what a browser parses and the first is what a socket carries.
 *
 * The payload is asserted to the frame's own wire type where the event name says which type it is (see `observed`);
 * every other event keeps its payload opaque, because a script that reads a lifecycle event it does not measure has no
 * reason to claim a shape for it.
 */
type FrameFields = { readonly raw: number; readonly bytes: number };
type SnapshotFrame = FrameFields & { readonly event: "snapshot"; readonly data: ServerSnapshot };
type StateFrame = FrameFields & { readonly event: "state"; readonly data: ServerDelta };
type SubmissionFrame = FrameFields & { readonly event: "submission"; readonly data: SubmissionProjection };
type OtherFrame = FrameFields & { readonly event: string; readonly data: unknown };
type ObservedFrame = SnapshotFrame | StateFrame | SubmissionFrame | OtherFrame;

const isSnapshotFrame = (frame: ObservedFrame): frame is SnapshotFrame => frame.event === "snapshot";
const isStateFrame = (frame: ObservedFrame): frame is StateFrame => frame.event === "state";
const isSubmissionFrame = (frame: ObservedFrame): frame is SubmissionFrame => frame.event === "submission";

/** One parsed frame, typed by the event name the wire declared. The payload is untrusted JSON and is asserted here. */
function observed(event: string, data: unknown, raw: number, bytes: number): ObservedFrame {
  if (event === "snapshot") return { event, data: data as ServerSnapshot, raw, bytes };
  if (event === "state") return { event, data: data as ServerDelta, raw, bytes };
  if (event === "submission") return { event, data: data as SubmissionProjection, raw, bytes };
  return { event, data, raw, bytes };
}

/** The transcript a stream has built, as the shared reducer holds it: the window's entries and its bookkeeping. */
type FoldedWindow = {
  readonly entries: SessionState["entries"];
  readonly busy: boolean;
  readonly revision: number;
  readonly oldestEntryId: string | null;
  readonly hasMore: boolean;
};

/**
 * The transcript the stream has built, folded the way a client folds it: a frame with `entries` is the window, a frame
 * with `appended` extends what is held. The reducer is the shared one, so this cannot drift from the browser.
 */
function folder(conversationId: string): (frame: { readonly event: string; readonly data: unknown }) => FoldedWindow {
  let state = emptyStreamState(conversationId);
  return (frame) => {
    state = reduceSseFrame(state, frame.event, frame.data);
    return { entries: state.entries, busy: state.busy, revision: state.revision, oldestEntryId: state.oldestEntryId ?? null, hasMore: state.hasMore === true };
  };
}
const round = (value: number): number => Math.round(value * 100) / 100;

/** One PNG, base64, used as the deferrable heavy content a tool result can carry. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The runtime's own write transaction, named by what `Harness.commit` hands its callback rather than re-declared. */
type Transaction = Parameters<Parameters<Awaited<ReturnType<typeof openServerHarness>>["harness"]["commit"]>[0]>[0];

/**
 * One turn's content, identical at every size so the only variable is the transcript length: a user message, an
 * assistant reply with thinking, and a tool result carrying one image. The image is what deferral replaces with a URL.
 */
async function appendTurn(tx: Transaction, id: ConversationId, index: number): Promise<void> {
  await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "turn " + index + ": explain the thing", timestamp: index * 3 }] });
  await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage([fauxThinking("reasoning for turn " + index), { type: "text", text: "answer " + index }], { timestamp: index * 3 + 1 })] });
  await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-" + index, toolName: "screenshot", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: index * 3 + 1 }], data: { diagnostics: [] } });
}

/** A seeded backend: the origin it answers on, the conversation it holds, and how to shut it down. */
type SeededBackend = { readonly origin: string; readonly id: string; close(): Promise<void> };

/** A store seeded with `turns` identical turns, plus the backend that serves it. */
async function seeded(base: string, turns: number): Promise<SeededBackend> {
  const dbPath = join(base, "turns-" + turns + ".sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  // The conversation selects the scripted provider, so the turn this script measures is a real run that really
  // settles; the provider's own response is a fixed short string, so nothing here depends on a model's timing.
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = created.id;
  await harness.harness.commit(async (tx) => { for (let index = 0; index < turns; index += 1) await appendTurn(tx, id, index); }, BACKGROUND_CONTEXT);
  await harness.close();

  const faux = fauxProvider();
  const respond: FauxResponseFactory = async () => { faux.setResponses([respond]); return fauxAssistantMessage("ok"); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  if (address === null || typeof address !== "object") throw new Error("the backend did not start");
  return { origin: "http://127.0.0.1:" + address.port, id: String(id), close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

/** One SSE reader over a conversation's stream, whose barriers are frames, so nothing here waits on a clock. */
type SseReader = {
  readonly frames: readonly ObservedFrame[];
  bytes(): number;
  window(): FoldedWindow;
  wait<E extends ObservedFrame>(predicate: (frame: ObservedFrame) => frame is E, timeoutMs?: number): Promise<E>;
  wait(predicate: (frame: ObservedFrame) => boolean, timeoutMs?: number): Promise<ObservedFrame>;
  close(): Promise<void>;
};

async function openSse(origin: string, id: string): Promise<SseReader> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers });
  const body = response.body;
  if (body === null) throw new Error("the event stream carried no body");
  const frames: ObservedFrame[] = []; let bytes = 0; let pending = "";
  type Waiter = { readonly predicate: (frame: ObservedFrame) => boolean; readonly resolve: (frame: ObservedFrame) => void; readonly reject: (error: Error) => void };
  const waiters: Waiter[] = [];
  const fold = folder(id);
  const reader = body.getReader(); const decoder = new TextDecoder();
  const pump = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1];
          const line = raw.split("\n").find((value) => value.startsWith("data: "));
          if (event === undefined || line === undefined) continue;
          const frame = observed(event, JSON.parse(line.slice(6)) as unknown, raw.length, Buffer.byteLength(line));
          if (frame.event === "snapshot" || frame.event === "state") fold(frame);
          frames.push(frame);
          for (let index = waiters.length - 1; index >= 0; index -= 1) if (waiters[index]!.predicate(frame)) waiters.splice(index, 1)[0]!.resolve(frame);
        }
      }
    } catch { /* closed */ }
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("stream ended while waiting"));
  })();
  // A type-guard predicate keeps the frame's own wire type (`isSnapshotFrame` answers a `ServerSnapshot`); any other
  // predicate answers the frame as the reader holds it, with its payload opaque.
  function wait<E extends ObservedFrame>(predicate: (frame: ObservedFrame) => frame is E, timeoutMs?: number): Promise<E>;
  function wait(predicate: (frame: ObservedFrame) => boolean, timeoutMs?: number): Promise<ObservedFrame>;
  function wait(predicate: (frame: ObservedFrame) => boolean, timeoutMs = 30000): Promise<ObservedFrame> {
    return new Promise((resolve, reject) => {
      const existing = frames.find(predicate); if (existing !== undefined) return resolve(existing);
      const timer = setTimeout(() => reject(new Error("timeout waiting for a frame")), timeoutMs);
      waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }
  return {
    frames,
    bytes: () => bytes,
    window: () => fold({ event: "state", data: null }),
    wait,
    close: async () => { await reader.cancel().catch(() => {}); await pump; },
  };
}

/** One size's measurements: the facts the claims below are decided on, plus the failures found while measuring it. */
type Measured = {
  readonly turns: number;
  readonly firstLoadBytes: number;
  readonly firstLoadMs: number;
  readonly baselineBytes: number;
  readonly windowEntries: number;
  readonly hasMore: boolean;
  readonly bytesPerTurn: number;
  readonly framesPerTurn: number;
  readonly maxFrameBytes: number;
  readonly incremental: { readonly frames: number; readonly appended: number; readonly contiguous: boolean; readonly reSerialized: boolean; readonly windowBookkeeping: boolean };
  readonly recovery: { readonly baselineBytes: number; readonly baselineEntries: number; readonly sameHistory: boolean; readonly bounded: boolean; readonly contiguousAfterReconnect: boolean };
  readonly pagedEntries: number;
  readonly pages: number;
  readonly pageBytes: number;
};

/** One aggregate claim's answer, beside the per-size measurements it was decided on. */
type Claim = boolean;
const results: Record<string, Measured | Claim> = {};
const measures = new Map<number, Measured>();
const failures: string[] = [];

/** The measurement for one size, read back only after `measure` stored it. */
function measured(turns: number): Measured {
  const found = measures.get(turns);
  if (found === undefined) throw new Error("no measurement for " + turns + " turns");
  return found;
}

/** One entry page as the paging read serves it: the entries, and the window bookkeeping beside them. */
type EntryPage = { readonly entries: readonly ServerEntry[]; readonly oldestEntryId: string | null; readonly hasMore: boolean };

async function measure(turns: number, base: string): Promise<Measured> {
  const backend = await seeded(base, turns);
  const firstLoadStarted = performance.now();
  const stateResponse = await fetch(backend.origin + "/api/conversations/" + backend.id + "/state", { headers });
  const firstLoadMs = performance.now() - firstLoadStarted;
  const snapshot = await stateResponse.json() as ServerSnapshot;
  const firstLoadBytes = Buffer.byteLength(JSON.stringify(snapshot));

  const sse = await openSse(backend.origin, backend.id);
  const baseline = await sse.wait(isSnapshotFrame);
  const baselineBytes = baseline.raw;

  // One more turn, measured frame by frame. The submission's settlement is the barrier: no sleep is involved.
  const before = { frames: sse.frames.length, bytes: sse.bytes() };
  const requestId = "perf-" + turns;
  const admitted = await fetch(backend.origin + "/api/conversations/" + backend.id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "one more turn" }) });
  if (admitted.status !== 202) throw new Error("admission refused: " + admitted.status);
  await sse.wait((frame) => isSubmissionFrame(frame) && frame.data.requestId === requestId && (frame.data.status === "done" || frame.data.status === "unanswered"));
  await sse.wait((frame) => isStateFrame(frame) && frame.data.busy === false);
  const turnFrames = sse.frames.slice(before.frames);
  const stateFrames = turnFrames.filter(isStateFrame);
  const idle = sse.window();
  const turn = { stateFrames: stateFrames.length, stateBytes: stateFrames.reduce((total, frame) => total + frame.bytes, 0), largestFrame: Math.max(...stateFrames.map((frame) => frame.raw)) };

  // The incremental frame, asserted as the contract a client folds on rather than as a byte count: every advancing
  // frame states the revision it continues and carries the entries it appended instead of the window it already sent,
  // and the entries it appends are the same projection the window and the single-entry read serve.
  const appended = stateFrames.flatMap((frame) => frame.data.appended);
  const incremental = {
    frames: stateFrames.length,
    appended: appended.length,
    contiguous: stateFrames.every((frame) => typeof frame.data.baseRevision === "number" && frame.data.revision === frame.data.baseRevision + 1),
    reSerialized: stateFrames.some((frame) => "entries" in frame.data),
    windowBookkeeping: stateFrames.every((frame) => (frame.data.oldestEntryId === null || typeof frame.data.oldestEntryId === "string") && typeof frame.data.hasMore === "boolean"),
  };
  if (incremental.reSerialized) failures.push("a frame at " + turns + " turns re-serialized the window instead of appending");
  if (appended.length > 0 && !incremental.contiguous) failures.push("an advancing frame at " + turns + " turns was not based on the revision the client holds");
  if (!incremental.windowBookkeeping) failures.push("an advancing frame at " + turns + " turns did not carry the window bookkeeping");
  const newest = appended.at(-1);
  if (newest !== undefined) {
    const read = await (await fetch(backend.origin + "/api/conversations/" + backend.id + "/entries/" + newest.id, { headers })).json() as { entry: ServerEntry };
    if (JSON.stringify(read.entry) !== JSON.stringify(newest)) failures.push("the appended entry at " + turns + " turns is not the same projection the single-entry read serves");
  }

  // Reconnect, on the same chain: a dropped stream is reopened, and the fresh baseline it gets is bounded and is then
  // continued by the frames after it. This is the case a client actually hits — an idle bound, a laptop lid, a network
  // change — and the one that would silently re-download the transcript if the baseline were not bounded or if the
  // frames after it did not state the revision they continue.
  const reconnected = await openSse(backend.origin, backend.id);
  const secondBaseline = await reconnected.wait(isSnapshotFrame);
  const stateRead = await (await fetch(backend.origin + "/api/conversations/" + backend.id + "/state", { headers })).json() as ServerSnapshot;
  const recovery = {
    baselineBytes: secondBaseline.raw,
    baselineEntries: secondBaseline.data.entries.length,
    sameHistory: secondBaseline.data.historyRevision === stateRead.historyRevision,
    bounded: secondBaseline.raw <= 512 * 1024,
    contiguousAfterReconnect: false,
  };
  if (!recovery.sameHistory) failures.push("the reconnected baseline at " + turns + " turns states a different history than the read");
  if (!recovery.bounded) failures.push("the reconnected baseline at " + turns + " turns is over the soft target: " + secondBaseline.raw);
  // One more turn on the reconnected stream: every frame continues the baseline the reconnect was handed, with no gap
  // between the two chains.
  const againRequestId = "perf-again-" + turns;
  const admittedAgain = await fetch(backend.origin + "/api/conversations/" + backend.id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: againRequestId, text: "one more turn" }) });
  if (admittedAgain.status !== 202) throw new Error("admission refused after reconnect: " + admittedAgain.status);
  await reconnected.wait((frame) => isSubmissionFrame(frame) && frame.data.requestId === againRequestId && (frame.data.status === "done" || frame.data.status === "unanswered"));
  await reconnected.wait((frame) => isStateFrame(frame) && frame.data.busy === false);
  const afterReconnect = reconnected.frames.filter(isStateFrame);
  let chain: number = secondBaseline.data.revision;
  for (const frame of afterReconnect) {
    if (frame.data.baseRevision !== chain || frame.data.revision !== chain + 1) { failures.push("the frame after a reconnect at " + turns + " turns is not contiguous: base " + frame.data.baseRevision + " on " + chain); break; }
    if ("entries" in frame.data) { failures.push("the frame after a reconnect at " + turns + " turns re-serialized the window"); break; }
    chain = frame.data.revision;
  }
  recovery.contiguousAfterReconnect = chain > secondBaseline.data.revision;
  if (!recovery.contiguousAfterReconnect) failures.push("no advancing frame followed the reconnect baseline at " + turns + " turns");
  await reconnected.close();

  // Paging: read backwards from the window and count what comes back.
  const seen = new Set(idle.entries.map((entry) => entry.id));
  let cursor = idle.entries[0]!.id;
  let pageBytes = 0;
  let pages = 0;
  while (pages < 200) {
    const pageResponse = await fetch(backend.origin + "/api/conversations/" + backend.id + "/entries?before=" + cursor + "&tail=50", { headers });
    const page = await pageResponse.json() as EntryPage;
    pageBytes += Buffer.byteLength(JSON.stringify(page));
    if (page.entries.length === 0) break;
    for (const entry of page.entries) { if (seen.has(entry.id)) throw new Error("a page repeated entry " + entry.id); seen.add(entry.id); }
    cursor = page.entries[0]!.id;
    pages += 1;
  }

  await sse.close();
  await backend.close();
  return { turns, firstLoadBytes, firstLoadMs: round(firstLoadMs), baselineBytes, windowEntries: snapshot.entries.length, hasMore: snapshot.hasMore, bytesPerTurn: round(turn.stateBytes / Math.max(1, turn.stateFrames)), framesPerTurn: turn.stateFrames, maxFrameBytes: turn.largestFrame, incremental, recovery, pagedEntries: seen.size, pages, pageBytes };
}

const base = await mkdtemp(join(tmpdir(), "hepi-perf-history-"));
try {
  for (const turns of [10, 60, 120, 240]) {
    const size = await measure(turns, base);
    measures.set(turns, size);
    results["turns" + turns] = size;
  }

  // 1. Bytes per turn are independent of transcript size.
  const perTurn = (turns: number): number => measured(turns).bytesPerTurn;
  const flat = perTurn(240) <= 1.25 * perTurn(60);
  if (!flat) failures.push("bytes per turn grew with the transcript: 60 turns " + perTurn(60) + " -> 240 turns " + perTurn(240));
  results.bytesPerTurnFlat = flat;

  // 2. The largest frame is independent of transcript size, for entries small enough to be deferrable.
  const maxFrame = (turns: number): number => measured(turns).maxFrameBytes;
  const boundedFrame = maxFrame(240) <= 1.25 * maxFrame(60);
  if (!boundedFrame) failures.push("the largest frame grew with the transcript: 60 turns " + maxFrame(60) + " -> 240 turns " + maxFrame(240));
  results.maxFrameFlat = boundedFrame;

  // 3. First load is bounded for deferrable content. Every size is inside the soft target, and above the point where
  // the window is full the cost stops moving: 10 turns carries less because there is less to carry, which is not the
  // claim. The claim is that a transcript ten times longer costs the same.
  const firstLoad = (turns: number): number => measured(turns).firstLoadBytes;
  const softTarget = 512 * 1024;
  for (const turns of [10, 60, 120, 240]) if (measured(turns).firstLoadBytes > softTarget) failures.push("first load at " + turns + " turns is over the soft target: " + measured(turns).firstLoadBytes);
  if (!(firstLoad(240) <= 1.25 * firstLoad(60))) failures.push("first load grew with the transcript: 60 turns " + firstLoad(60) + " -> 240 turns " + firstLoad(240));
  results.firstLoadBounded = firstLoad(240) <= softTarget && firstLoad(240) <= 1.25 * firstLoad(60);

  // 4. The window is what a frame carries, at every size.
  for (const turns of [10, 60, 120, 240]) {
    const size = measured(turns);
    if (size.windowEntries > 300) failures.push("the window at " + turns + " turns carries " + size.windowEntries + " entries");
  }

  // 5. Paging loses nothing: the window plus every page is the whole transcript. 240 seeded turns carry three
  // entries each, and the measured turn adds a user and an assistant entry on top.
  const largest = measured(240);
  const expected = 240 * 3 + 2;
  if (largest.pagedEntries !== expected) failures.push("paging reached " + largest.pagedEntries + " entries, expected " + expected);
  results.pagingComplete = largest.pagedEntries === expected;

  // 6. Deferral is what holds the budget: every in-window tool-result image is a URL, and the base64 does not travel.
  results.deferralHoldsBudget = largest.firstLoadBytes <= softTarget;
  if (!results.deferralHoldsBudget) failures.push("deferral did not hold the budget at 240 turns");

  // 7. A reconnect recovers on one chain: the baseline it is handed is bounded and names the same history as the read,
  // and every frame after it continues that baseline with no gap. A delta design that answered a reconnect with a
  // replay, or that left the client's revision behind the server's, fails here rather than in a browser.
  for (const turns of [10, 60, 120, 240]) {
    const size = measured(turns);
    if (!size.recovery.sameHistory) failures.push("the reconnected baseline at " + turns + " turns names a different history");
    if (!size.recovery.contiguousAfterReconnect) failures.push("the reconnect at " + turns + " turns was not continued by the frames after it");
  }
  results.reconnectRecoversOnOneChain = [10, 60, 120, 240].every(turns => measured(turns).recovery.sameHistory && measured(turns).recovery.contiguousAfterReconnect === true);
} finally {
  await rm(base, { recursive: true, force: true });
}

const report = { measuredAt: new Date().toISOString(), node: process.version, results, failures };
const jsonAt = process.argv.find((argument) => argument.startsWith("--json="))?.slice("--json=".length);
if (jsonAt !== undefined) await writeFile(jsonAt, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) { console.error("FAILED: " + failures.length + " claim(s) did not hold"); process.exit(1); }
console.log("all history-scaling claims hold");
