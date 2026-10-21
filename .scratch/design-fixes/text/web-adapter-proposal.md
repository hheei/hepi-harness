# web-adapter-proposal.md — the Web half of the text read block

Owner of `apps/web/adapters/durable-api.ts`: the host worker (exclusive). This file is a proposal, not a patch applied by
me. Everything below is additive to what the backend already publishes (see `diagnosis.md` beside this file).

## 1. Proxy: forward the third read block (required, ~4 lines)

The adapter already forwards the two read blocks a deferred entry can name. Text is the third, and it is JSON exactly
like `thinking`, so the existing branch only needs its name list widened:

```diff
-    if (parts[2] === "entries" && parts[3] && (parts[4] === "thinking" || parts[4] === "tool-result-image")) {
+    if (parts[2] === "entries" && parts[3] && (parts[4] === "thinking" || parts[4] === "text" || parts[4] === "tool-result-image")) {
```

No other change to that branch: `text` takes the same `forward(upstream)` path `thinking` takes, and the byte path
stays exclusive to `tool-result-image`. The upstream URL the browser asks for is
`/api/sessions/<sessionId>/entries/<entryId>/text?blockIndex=<n>` and the backend answers
`{ protocol, conversationId, entryId, blockIndex, text }`, 400 for a `blockIndex` outside the content, 404 for an
unknown or foreign entry.

## 2. Types: the two new fields on a text block (`apps/web/lib/types.ts`)

```diff
 export interface TextContent {
   type: "text";
   text: string;
+  /** Historical content is a bounded preview; the full text is loaded on demand from `textUrl`. */
+  deferred?: boolean;
+  /** The read block that restores the text this preview replaced. Present exactly when `deferred` is true. */
+  textUrl?: string;
 }
```

`ToolResultMessage.content` and `UserMessage.content` already allow `TextContent`, so no other type changes.

## 3. Renderer: preview in place, explicit expand, copy what is shown

The three places a text block is rendered need the same treatment; the loader is one shared helper so the rule lives in
one place.

**Loader** (in `MessageView.tsx`, beside `loadThinkingContent` at `:161`):

```ts
function loadDeferredText(textUrl: string): Promise<string> {
  const cached = textContentCache.get(textUrl);
  if (cached) return cached;
  const request = fetch(textUrl).then(async (response) => {
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json() as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("Invalid text response");
    return data.text;
  }).catch((error) => { textContentCache.delete(textUrl); throw error; });
  textContentCache.set(textUrl, request);
  return request;
}
```

with the same small LRU bound `thinkingContentCache` already uses. It is called **only** from an expand handler, never
from an effect, so opening or reconnecting a conversation never fetches a full text.

**A shared `DeferredText` component**, used by all three call sites: renders `text` (the preview) when collapsed, an
expand control that calls `loadDeferredText(textUrl)`, a loading/error state, and — when expanded — the full text in a
plain `<pre>` (markdown is deliberately skipped for a multi-megabyte body, the same reasoning
`SafeMarkdownBody` already applies at `MAX_MARKDOWN_CHARS`). Copy copies **what is displayed**: the preview while
collapsed, the full text once loaded. It never triggers a load.

**Call sites:**
- assistant text block: `TextBlock` (`:997`) — pass `entryId`/`sessionId` down (already available: `BlockView` receives
  them at `:981`, `:861`) only if the block has no `textUrl`; with the URL on the block, no new props are needed.
- user prompt: `UserMessageView` (`:349`/`:374`, the `content` string and `copyTarget`) — a deferred text-only prompt
  arrives as a one-block array with `deferred: true`, so the existing `typeof message.content === "string"` branch is
  not taken; the array branch must render `DeferredText` for a deferred text block. **Editing** a deferred prompt
  (`replaceUserMessageText`) must load the full text first, or the edit prefills the composer with a preview — this is
  the one place a load is legitimate without an explicit expand, and it should be stated in the handler's comment.
- tool result: `ToolCallBlock`'s `resultText` (`:1150-1155`) feeds `PairedResult` (`:1269`, `:1281`). A deferred tool
  result text needs its own expand path inside that panel rather than a second copy of the fetch logic; the block's own
  `textUrl` is what it should use.

## 4. i18n (three locales, parity enforced by `lib/i18n/registry.test.mjs`)

New keys, added to `en.ts`, `zh-CN.ts`, `zh-TW.ts` at the same place:

- `i18n.loadingText` — "Loading message..." / "正在加载消息内容..." / "正在載入訊息內容..."
- `i18n.textUnavailable` — "Message content unavailable" / "消息内容不可用" / "訊息內容不可用"
- `i18n.showFullText` — "Show full text" / "显示完整文本" / "顯示完整文字"
- `i18n.hideFullText` — "Show preview only" / "仅显示预览" / "僅顯示預覽"

`registry.test.mjs` compares key sets and placeholders across locales, so a missing translation fails that test.

## 5. What must NOT happen (the reviewer's constraints, restated as checks)

- No full-text fetch on mount, on reconnect, on scroll or on copy.
- No change to `ThinkingBlock` or image rendering.
- No change to `useAgentSession`: the block carries its own URL, so the hook does not need to know a text read exists.
  If the hook turns out to need a change, it is a separate request to the lifecycle owner, not part of this fix.
- The proxy change is required; without it the backend route is unreachable from the browser even though the read block
  names it.
