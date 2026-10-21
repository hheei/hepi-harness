import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const {
  canClearBuiltinCommandInput, canRunBuiltinSlashCommandWhileStreaming, composerScopeInstalled,
  getUserMessageText, getUserMessageDraftImages, offersBuiltinSlashCommandWhileStreaming,
  submitsSlashCommandOnEnter,
} = await jiti.import("./ChatInput.tsx");
const { isBareMcpCommand } = await jiti.import("../lib/mcp-command.ts");
const { clearDraft, draftScope, getDraft, hydrateDrafts, mergeRestoredSubmissionDraft, rekeyDraft, setDraft, setDraftScope, resetDraftStoreForTests } = await jiti.import("../lib/draft-store.ts");

function chatInputCallback(name, context) {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Script(ts.transpileModule(find(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

test("composer dispatch preserves images and respects built-in ownership while streaming", async () => {
  const image = { data: "AQID", mimeType: "image/png" };
  for (const [label, value, images, isStreaming, handled, expected] of [
    ["normal image prompt", "review", [image], false, false, [["review", [image]]]],
    ["owned streaming command", "/mcp", [], true, true, []],
    ["unowned idle command", "/mcp", [], false, false, [["/mcp", undefined]]],
    ["streaming text remains in composer", "later", [], true, false, []],
  ]) {
    const sent = [];
    let cleared = 0;
    const handleSend = chatInputCallback("handleSend", {
      value, attachedImages: images, isStreaming, bashMode: false, onAudioUnlock() {},
      offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => handled,
      clearInput() { cleared += 1; },
      onSend: (...args) => sent.push(args),
    });
    await handleSend();
    assert.deepEqual(sent, expected, label);
    assert.equal(cleared, expected.length, label);
  }
  for (const handled of [true, false]) {
    const prompts = [];
    const sendQueued = chatInputCallback("sendQueued", {
      value: "/mcp", attachedImages: [], bashMode: false, onAudioUnlock() {}, clearInput() {},
      onBuiltinCommand: async () => ({ handled }), canRunBuiltinSlashCommandWhileStreaming, isBareMcpCommand,
      runBuiltinCommand: async () => handled,
      onPromptWithStreamingBehavior: (...args) => prompts.push(args),
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
  for (const mode of ["idle", "steer", "followup"]) {
    const cleared = [];
    const dispatched = [];
    const context = {
      value: "!pwd", attachedImages: [], bashMode: true, isStreaming: mode !== "idle",
      onAudioUnlock() {}, offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => false, clearInput() { cleared.push(1); },
      onBuiltinCommand: undefined, canRunBuiltinSlashCommandWhileStreaming, isBareMcpCommand,
      onSend: (...args) => dispatched.push(args),
      onPromptWithStreamingBehavior: (...args) => dispatched.push(args),
      onSteer: (...args) => dispatched.push(args), onFollowUp: (...args) => dispatched.push(args),
    };
    if (mode === "idle") await chatInputCallback("handleSend", context)();
    else chatInputCallback("sendQueued", context)(mode);
    assert.deepEqual(cleared, [], mode + ": the draft stays in the composer");
  }

  const sent = [], cleared = [];
  await chatInputCallback("handleSend", {
    value: "an ordinary prompt", attachedImages: [], bashMode: false, isStreaming: false, onAudioUnlock() {},
    offersBuiltinSlashCommandWhileStreaming, runBuiltinCommand: async () => false,
    clearInput() { cleared.push(1); }, onSend: (...args) => sent.push(args),
  })();
  assert.equal(cleared.length, 1, "an ordinary prompt is still cleared once");
  assert.deepEqual(sent, [["an ordinary prompt", undefined]]);
});

test("pending built-ins run once and preserve input typed while awaiting completion", async () => {
  let resolve;
  const pending = [];
  let cleared = 0;
  const valueRef = { current: "/reload" };
  const run = chatInputCallback("runBuiltinCommand", {
    attachedImages: [], attachedImagesRef: { current: [] }, builtinCommandPendingRef: { current: false },
    canClearBuiltinCommandInput, valueRef,
    clearInput() { cleared += 1; },
    onBuiltinCommand: () => new Promise((done) => { resolve = done; }),
    setBuiltinCommandPending: (value) => pending.push(value),
  });
  const first = run("/reload");
  try {
    assert.equal(await run("/reload"), true);
    assert.deepEqual(pending, [true]);
    valueRef.current = "new follow-up";
  } finally {
    resolve({ handled: true });
    await first;
  }
  assert.equal(cleared, 0);
  assert.deepEqual(pending, [true, false]);
});

test("editing and failed submission recovery preserve text, duplicate images, and draft identity", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const message = { role: "user", content: [
    { type: "text", text: "Review this image " },
    { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } },
  ] };
  assert.equal(getUserMessageText(message), "Review this image ");
  assert.deepEqual(getUserMessageDraftImages(message), [image]);
  const restored = mergeRestoredSubmissionDraft("failed submission", [image, image], "new draft", [image]);
  assert.deepEqual(restored, { value: "failed submission\n\nnew draft", images: [image, image, image] });
  const provisionalKey = "new:/tmp/ui-recovery";
  const sessionKey = "ui-recovery-session";
  try {
    setDraft(provisionalKey, restored);
    assert.deepEqual(rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }), restored);
    assert.equal(getDraft(provisionalKey), null);
    assert.deepEqual(getDraft(sessionKey), restored);
  } finally {
    clearDraft(provisionalKey);
    clearDraft(sessionKey);
  }
});

test("composer Enter actions preserve queue, built-in, completion, and IME priorities", () => {
  const cases = [
    ["Enter steers", {}, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
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
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
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


test("a composer reads and writes its draft only inside its own connection's scope", () => {
  // The store is a page-wide singleton keyed by the connection, so the composer has to ask which connection it is
  // installed for. Before the first descriptor is answered there is none, and after a profile switch the store holds the
  // previous one until the new connection installs its scope: in both windows the key names a conversation this
  // composer is not showing, and a read would adopt another connection's unsent text — which the write that follows
  // would then file under the new connection.
  resetDraftStoreForTests();
  // The tab's own store, so the previous connection's entry is still there when the user switches back.
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null };
  const connectionA = "profile-a|backend-1|acct";
  const connectionB = "profile-b|backend-1|acct";
  assert.equal(draftScope(), "", "a page that has read no descriptor has installed no scope");
  assert.equal(composerScopeInstalled(draftScope(), connectionA), false, "a composer adopts nothing before the scope exists");

  setDraftScope(connectionA);
  hydrateDrafts(storage);
  setDraft("conv", { value: "unsent on A", images: [] });
  assert.equal(composerScopeInstalled(draftScope(), connectionA), true);
  assert.equal(getDraft("conv")?.value, "unsent on A");

  // The switch: the store now holds B, and the composer that belonged to A must neither read nor write through it.
  setDraftScope(connectionB);
  assert.equal(composerScopeInstalled(draftScope(), connectionA), false, "a stale composer writes nothing under the new scope");
  assert.equal(getDraft("conv"), null, "and the new connection starts from empty for the same conversation id");
  assert.equal(composerScopeInstalled(draftScope(), connectionB), true);
  setDraft("conv", { value: "unsent on B", images: [] });

  // Switching back finds each connection's own text, untouched by the other's composer.
  setDraftScope(connectionA);
  assert.equal(getDraft("conv")?.value, "unsent on A");
  resetDraftStoreForTests();
});
