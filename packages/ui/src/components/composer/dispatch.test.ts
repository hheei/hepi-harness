import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createComposerDispatch } = await jiti.import<typeof import("./dispatch.ts")>("./dispatch.ts");

const image = { data: "AQID", mimeType: "image/png", previewUrl: "data:image/png;base64,AQID" };

type Calls = { sent: unknown[]; steered: unknown[]; followed: unknown[]; prompted: unknown[]; cleared: number; unlocked: number; pending: boolean[] };

/** One dispatch over a stated draft, so a case exercises the shipped rule rather than a copy of it. */
function harness(options: {
  text: string;
  images?: (typeof image)[];
  isStreaming?: boolean;
  builtin?: (message: string) => Promise<{ handled: boolean; error?: string }>;
}) {
  const calls: Calls = { sent: [], steered: [], followed: [], prompted: [], cleared: 0, unlocked: 0, pending: [] };
  const draftValue = { text: options.text, images: options.images ?? [] };
  const dispatch = createComposerDispatch({
    isStreaming: options.isStreaming ?? false,
    draft: () => draftValue,
    commands: {
      send: (...args: unknown[]) => { calls.sent.push(args); },
      steer: (...args: unknown[]) => { calls.steered.push(args); },
      followUp: (...args: unknown[]) => { calls.followed.push(args); },
      promptWithStreamingBehavior: (...args: unknown[]) => { calls.prompted.push(args); },
      runBuiltin: async (message: string) => (options.builtin ?? (async () => ({ handled: false })))(message),
      continueRun: async () => "allowed",
      recallQueue: () => {},
      editItem: async () => ({ ok: true }),
      cancelItem: async () => ({ ok: true }),
    },
    clearInput: () => { calls.cleared += 1; },
    unlockAudio: () => { calls.unlocked += 1; },
    onBuiltinPendingChange: (pending: boolean) => { calls.pending.push(pending); },
  });
  return { calls, dispatch, draftValue };
}

test("a submit sends the draft once, with its pictures, and clears it", async () => {
  const { calls, dispatch } = harness({ text: "  review this  ", images: [image] });
  await dispatch.submit();
  assert.deepEqual(calls.sent, [["review this", [image]]]);
  assert.equal(calls.cleared, 1);
  assert.equal(calls.unlocked, 1, "the send is the user's gesture, so audio unlocks with it");
});

test("an empty draft sends nothing", async () => {
  for (const images of [[], undefined]) {
    const { calls, dispatch } = harness({ text: "   ", ...(images === undefined ? {} : { images }) });
    await dispatch.submit();
    dispatch.queue("steer");
    dispatch.queue("followup");
    assert.deepEqual(calls.sent, []);
    assert.deepEqual(calls.steered, []);
    assert.deepEqual(calls.followed, []);
    assert.equal(calls.cleared, 0);
  }
});

test("a prompt while a turn streams is queued, never sent", async () => {
  const { calls, dispatch } = harness({ text: "later", isStreaming: true });
  await dispatch.submit();
  assert.deepEqual(calls.sent, [], "a streaming submit is not a send");
  assert.equal(calls.cleared, 0, "the draft stays in the composer");
});

test("a built-in the runtime answers owns the draft, and one it does not falls through to the send", async () => {
  const owned = harness({ text: "/mcp", builtin: async () => ({ handled: true }) });
  await owned.dispatch.submit();
  assert.deepEqual(owned.calls.sent, [], "an owned command is not also sent as a prompt");
  assert.equal(owned.calls.cleared, 1);

  const unowned = harness({ text: "/mcp", builtin: async () => ({ handled: false }) });
  await unowned.dispatch.submit();
  assert.deepEqual(unowned.calls.sent, [["/mcp", undefined]], "an unowned command is an ordinary prompt");
});

test("a built-in that failed keeps the draft it could not take", async () => {
  const { calls, dispatch } = harness({ text: "/reload", builtin: async () => ({ handled: true, error: "reload failed" }) });
  await dispatch.submit();
  assert.equal(calls.cleared, 0, "a command that did not land must not swallow the text it ran on");
});

test("a second press while a built-in is in flight neither runs it twice nor frees the draft", async () => {
  let resolve: ((result: { handled: boolean }) => void) | undefined;
  const { calls, dispatch } = harness({
    text: "/reload",
    builtin: () => new Promise<{ handled: boolean }>((done) => { resolve = done; }),
  });
  const first = dispatch.submit();
  try {
    await dispatch.submit();
    assert.deepEqual(calls.pending, [true], "one run, one pending state");
  } finally {
    resolve?.({ handled: true });
    await first;
  }
  assert.deepEqual(calls.pending, [true, false]);
});

test("a built-in takes only the text it ran on, so a keystroke during it survives", async () => {
  let resolve: ((result: { handled: boolean }) => void) | undefined;
  const { calls, dispatch, draftValue } = harness({
    text: "/reload",
    builtin: () => new Promise<{ handled: boolean }>((done) => { resolve = done; }),
  });
  const running = dispatch.submit();
  draftValue.text = "/reload and then this";
  resolve?.({ handled: true });
  await running;
  assert.equal(calls.cleared, 0, "the text on screen is no longer the text the command ran on");
});

test("a shell draft is never cleared, idle or queued, because the host refuses it before it is sent", async () => {
  for (const [name, run] of [
    ["idle", async (dispatch: ReturnType<typeof harness>["dispatch"]) => { await dispatch.submit(); }],
    ["steer", async (dispatch: ReturnType<typeof harness>["dispatch"]) => { dispatch.queue("steer"); }],
    ["followup", async (dispatch: ReturnType<typeof harness>["dispatch"]) => { dispatch.queue("followup"); }],
  ] as const) {
    const { calls, dispatch } = harness({ text: "!pwd", isStreaming: name !== "idle" });
    await run(dispatch);
    assert.equal(calls.cleared, 0, name + ": the refused draft stays in the composer");
  }
});

test("a queued steer and follow-up carry pictures and report the mode the user pressed", () => {
  const steer = harness({ text: "look", images: [image], isStreaming: true });
  steer.dispatch.queue("steer");
  assert.deepEqual(steer.calls.steered, [["look", [image]]]);
  assert.equal(steer.calls.cleared, 1);

  const follow = harness({ text: "look", isStreaming: true });
  follow.dispatch.queue("followup");
  assert.deepEqual(follow.calls.followed, [["look", undefined]]);
});

test("a streaming /command draft carries its own queue mode", () => {
  const { calls, dispatch } = harness({ text: "/help me", isStreaming: true });
  dispatch.queue("followup");
  assert.deepEqual(calls.prompted, [["/help me", "followUp", undefined]]);
});

test("a bare /mcp is queued only when the built-in handler declines it", async () => {
  for (const handled of [true, false]) {
    const { calls, dispatch } = harness({ text: "/mcp", isStreaming: true, builtin: async () => ({ handled }) });
    dispatch.queue("followup");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.prompted.length, handled ? 0 : 1, handled ? "an owned /mcp opened Settings" : "an unowned /mcp was queued");
  }
});

test("a compact quote box sends what it holds and reaches no queue", async () => {
  // Its own port: a send, and nothing else to call. The send seam is the same one a chat composer uses.
  const sent: unknown[] = [];
  let cleared = 0;
  const dispatch = createComposerDispatch({
    isStreaming: false,
    draft: () => ({ text: "quoted", images: [] }),
    commands: {
      send: (...args: unknown[]) => { sent.push(args); },
      steer: () => {},
      followUp: () => {},
      promptWithStreamingBehavior: () => {},
      runBuiltin: async () => ({ handled: false }),
      continueRun: async () => "failed",
      recallQueue: () => {},
      editItem: async () => ({ ok: false, reason: "no queue" }),
      cancelItem: async () => ({ ok: false, reason: "no queue" }),
    },
    clearInput: () => { cleared += 1; },
    unlockAudio: () => {},
    onBuiltinPendingChange: () => {},
  });
  await dispatch.submit();
  assert.deepEqual(sent, [["quoted", undefined]]);
  assert.equal(cleared, 1);
});
