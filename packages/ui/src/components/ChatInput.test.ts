import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  canClearBuiltinCommandInput, canRunBuiltinSlashCommandWhileStreaming,
  getUserMessageText, getUserMessageDraftImages, offersBuiltinSlashCommandWhileStreaming,
  submitsSlashCommandOnEnter,
} = await jiti.import<typeof import("./ChatInput.tsx")>("./ChatInput.tsx");
const { isBareMcpCommand } = await jiti.import<typeof import("../lib/mcp-command.ts")>("../lib/mcp-command.ts");
const { createDraftStore, mergeRestoredSubmissionDraft } = await jiti.import<typeof import("../lib/draft-store.ts")>("../lib/draft-store.ts");

/** One callback out of the composer, run against the deps a case states instead of the props a mount would pass. */
type Deps = Record<string, unknown>;

/**
 * One `useCallback` body out of the real `ChatInput.tsx`, evaluated with `context` as its closure.
 *
 * The composer's dispatch rules live inside a component that needs a browser to mount, so the body is read out of the
 * source rather than copied: the case then exercises the shipped rule, and a change to it shows up here.
 */
function chatInputCallback(name: string, context: Deps): (...args: unknown[]) => unknown {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node: ts.Node): ts.Node | undefined {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, find);
  }
  const body = find(source);
  assert.ok(body, `ChatInput.tsx has no useCallback named ${name}`);
  const compiled = ts.transpileModule(body.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Script(compiled).runInNewContext(context) as (...args: unknown[]) => unknown;
}

test("composer dispatch preserves images and respects built-in ownership while streaming", async () => {
  const image = { data: "AQID", mimeType: "image/png" };
  for (const [label, value, images, isStreaming, handled, expected] of [
    ["normal image prompt", "review", [image], false, false, [["review", [image]]]],
    ["owned streaming command", "/mcp", [], true, true, []],
    ["unowned idle command", "/mcp", [], false, false, [["/mcp", undefined]]],
    ["streaming text remains in composer", "later", [], true, false, []],
  ] as const) {
    const sent: unknown[][] = [];
    let cleared = 0;
    const handleSend = chatInputCallback("handleSend", {
      value, attachedImages: images, isStreaming, bashMode: false, onAudioUnlock() {},
      offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => handled,
      clearInput() { cleared += 1; },
      onSend: (...args: unknown[]) => sent.push(args),
    });
    await handleSend();
    assert.deepEqual(sent, expected, label);
    assert.equal(cleared, expected.length, label);
  }
  for (const handled of [true, false]) {
    const prompts: unknown[][] = [];
    const sendQueued = chatInputCallback("sendQueued", {
      value: "/mcp", attachedImages: [], bashMode: false, onAudioUnlock() {}, clearInput() {},
      onBuiltinCommand: async () => ({ handled }), canRunBuiltinSlashCommandWhileStreaming, isBareMcpCommand,
      runBuiltinCommand: async () => handled,
      onPromptWithStreamingBehavior: (...args: unknown[]) => prompts.push(args),
      onSteer: assert.fail, onFollowUp: assert.fail,
    });
    sendQueued("followup");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts.length, handled ? 0 : 1);
    if (!handled) assert.deepEqual(prompts[0].slice(0, 2), ["/mcp", "followUp"]);
  }
});

test("a shell draft is never cleared, idle or queued, and an ordinary draft still is", async () => {
  // The host refuses a shell draft before it is sent, so the composer must not take the text off the screen for a turn
  // that was never dispatched — on the idle send and on both queued paths alike.
  for (const mode of ["idle", "steer", "followup"] as const) {
    const cleared: number[] = [];
    const dispatched: unknown[][] = [];
    const context: Deps = {
      value: "!pwd", attachedImages: [], bashMode: true, isStreaming: mode !== "idle",
      onAudioUnlock() {}, offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => false, clearInput() { cleared.push(1); },
      onBuiltinCommand: undefined, canRunBuiltinSlashCommandWhileStreaming, isBareMcpCommand,
      onSend: (...args: unknown[]) => dispatched.push(args),
      onPromptWithStreamingBehavior: (...args: unknown[]) => dispatched.push(args),
      onSteer: (...args: unknown[]) => dispatched.push(args), onFollowUp: (...args: unknown[]) => dispatched.push(args),
    };
    if (mode === "idle") await chatInputCallback("handleSend", context)();
    else chatInputCallback("sendQueued", context)(mode);
    assert.deepEqual(cleared, [], mode + ": the draft stays in the composer");
  }

  const sent: unknown[][] = [], cleared: number[] = [];
  await chatInputCallback("handleSend", {
    value: "an ordinary prompt", attachedImages: [], bashMode: false, isStreaming: false, onAudioUnlock() {},
    offersBuiltinSlashCommandWhileStreaming, runBuiltinCommand: async () => false,
    clearInput() { cleared.push(1); }, onSend: (...args: unknown[]) => sent.push(args),
  })();
  assert.equal(cleared.length, 1, "an ordinary prompt is still cleared once");
  assert.deepEqual(sent, [["an ordinary prompt", undefined]]);
});

test("pending built-ins run once and preserve input typed while awaiting completion", async () => {
  let resolve: ((result: { handled: boolean }) => void) | undefined;
  const pending: boolean[] = [];
  let cleared = 0;
  const valueRef = { current: "/reload" };
  const run = chatInputCallback("runBuiltinCommand", {
    attachedImages: [], attachedImagesRef: { current: [] }, builtinCommandPendingRef: { current: false },
    canClearBuiltinCommandInput, valueRef,
    clearInput() { cleared += 1; },
    onBuiltinCommand: () => new Promise<{ handled: boolean }>((done) => { resolve = done; }),
    setBuiltinCommandPending: (value: boolean) => pending.push(value),
  });
  const first = run("/reload");
  try {
    assert.equal(await run("/reload"), true);
    assert.deepEqual(pending, [true]);
    valueRef.current = "new follow-up";
  } finally {
    resolve?.({ handled: true });
    await first;
  }
  assert.equal(cleared, 0);
  assert.deepEqual(pending, [true, false]);
});

test("editing and failed submission recovery preserve text, duplicate images, and draft identity", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const message = { role: "user" as const, content: [
    { type: "text" as const, text: "Review this image " },
    { type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType, data: image.data } },
  ] };
  assert.equal(getUserMessageText(message), "Review this image ");
  assert.deepEqual(getUserMessageDraftImages(message), [image]);
  const restored = mergeRestoredSubmissionDraft("failed submission", [image, image], "new draft", [image]);
  assert.deepEqual(restored, { value: "failed submission\n\nnew draft", images: [image, image, image] });
  const provisionalKey = "new:/tmp/ui-recovery";
  const sessionKey = "ui-recovery-session";
  const store = createDraftStore("test|backend|account");
  store.setDraft(provisionalKey, restored);
  assert.deepEqual(store.rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }), restored);
  assert.equal(store.getDraft(provisionalKey), null);
  assert.deepEqual(store.getDraft(sessionKey), restored);
  store.clearDraft(provisionalKey);
  store.clearDraft(sessionKey);
});

test("composer Enter actions preserve queue, built-in, completion, and IME priorities", () => {
  type Keys = { key?: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; nativeEvent?: { isComposing: boolean; keyCode: number } };
  const cases: [string, Keys, Deps, string][] = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true, keyCode: 13 } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { isComposing: false, keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["pi's built-in /mcp submits at once, also while streaming", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } }] }, "send"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = chatInputCallback("handleKeyDown", {
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true, enterSendMode: "enter",
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      onSteer() {}, onFollowUp() {},
      sendQueued(mode: string) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      submitsSlashCommandOnEnter, value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

