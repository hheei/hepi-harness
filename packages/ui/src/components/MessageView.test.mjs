import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MessageView, replaceUserMessageText } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");
const { clearExpandedToolCalls, setToolCallExpanded } = await jiti.import("../lib/tool-call-expansion.ts");
const { workbenchConnection, WorkbenchConnectionProvider } = await jiti.import("../lib/workbench-scope.ts");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(MessageView, { message, ...props })));
}

test("editing a user message preserves its image and renders the full revised text", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJDRA==" } };
  const message = { role: "user", content: [{ type: "text", text: "original" }, image] };
  const revised = replaceUserMessageText(message, "First line\nLast line");
  assert.deepEqual(revised.content, [{ type: "text", text: "First line\nLast line" }, image]);
  assert.equal(message.content[0].text, "original");
  const html = renderMessage(revised);
  assert.match(html, /First line/);
  assert.match(html, /Last line/);
  assert.match(html, /aria-label="Preview image"/);
  assert.match(html, /data:image\/png;base64,QUJDRA==/);
});

test("paired tool results show images while collapsed and preserve failures when expanded", () => {
  const screenshot = { type: "toolCall", toolCallId: "shot", toolName: "page_screenshot", input: { tabId: 7 } };
  const patch = { type: "toolCall", toolCallId: "patch", toolName: "apply_patch", input: {
    input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
  } };
  const results = new Map([
    ["shot", { role: "toolResult", toolCallId: "shot", content: [
      { type: "text", text: "captured-1280x720" }, { type: "image", data: "YWJj", mimeType: "image/png" },
    ] }],
    ["patch", { role: "toolResult", toolCallId: "patch", content: [
      { type: "text", text: "apply_patch failed. Recovery: MUST read src/a.ts before retrying." },
    ], details: { result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] } } }],
  ]);
  clearExpandedToolCalls();
  try {
    const collapsed = renderMessage({ role: "assistant", content: [screenshot, patch] }, { toolResults: results });
    assert.match(collapsed, /data:image\/png;base64,YWJj/);
    assert.doesNotMatch(collapsed, /captured-1280x720/);
    assert.doesNotMatch(collapsed, /"tabId"/);
    // apply_patch reports failures in details even when the SDK omits isError.
    assert.match(collapsed, /border:1px solid rgba\(248,113,113,0\.45\)/);
    setToolCallExpanded("patch", true);
    const expanded = renderMessage({ role: "assistant", content: [patch] }, { toolResults: results });
    assert.match(expanded, /Recovery: MUST read src\/a.ts before retrying/);
    assert.doesNotMatch(expanded, /captured-1280x720/);
  } finally {
    clearExpandedToolCalls();
  }
});

test("Code mode pairs its script and failed nested call with the returned error", () => {
  const block = { type: "toolCall", toolCallId: "code", toolName: "codemode", input: { code: 'return await tools.bash({command: "false"});' } };
  setToolCallExpanded(block.toolCallId, true);
  try {
    const html = renderMessage({ role: "assistant", content: [block] }, { toolResults: new Map([["code", {
      role: "toolResult", toolCallId: "code", isError: true,
      content: [{ type: "text", text: "Script error:\nError: exit code 2" }],
      details: { calls: [{ id: "code/1", name: "bash", args: '{"command":"false"}', status: "error", error: "exit code 2" }] },
    }]]) });
    assert.match(html, /return await tools.bash/);
    assert.match(html, /Tool calls/);
    assert.match(html, /aria-label="Failed"/);
    assert.match(html, /Script error:[\s\S]*exit code 2/);
  } finally {
    setToolCallExpanded(block.toolCallId, false);
  }
});

test("provider failures and truncation retain partial answers and expose an alert", () => {
  for (const [label, stopReason, errorMessage, expected] of [
    ["provider failure", "error", "API credit expired", /API credit expired/],
    ["output limit", "length", undefined, /output limit/i],
  ]) {
    const html = renderMessage({ role: "assistant", content: [{ type: "text", text: "Partial answer" }], stopReason, errorMessage });
    assert.match(html, /Partial answer/, label);
    assert.match(html, /role="alert"/, label);
    assert.match(html, expected, label);
  }
});

test("a deferred preview renders bounded and reads nothing on mount, through the connection it is mounted under", () => {
  const reads = [];
  const client = {
    origin: "",
    credential: { kind: "cookie" },
    disposed: false,
    request: async () => { throw new Error("this surface reads no request"); },
    readJson: async () => { throw new Error("this surface reads no request"); },
    resources: {
      resolve: (address) => address,
      text: async (address) => { reads.push(address); return { ok: true, value: "whole" }; },
      image: async () => ({ ok: false, reason: "not_found" }),
      retained: { images: 0, imageBytes: 0, texts: 0, textBytes: 0 },
      dispose() {},
    },
  };
  const message = { role: "user", content: [{ type: "text", text: "BOUNDED PREVIEW", deferred: true, textUrl: "/api/sessions/s/entries/e/text?blockIndex=0" }] };
  const html = renderToStaticMarkup(React.createElement(WorkbenchConnectionProvider,
    { value: workbenchConnection(client, { profile: "test", backendId: "test", accountScope: "test" }) },
    React.createElement(I18nProvider, null,
      React.createElement(MessageView, { message, sessionId: "s", entryId: "e" }))));
  assert.match(html, /data-deferred-state="preview"/);
  assert.match(html, /BOUNDED PREVIEW/);
  assert.equal(reads.length, 0, "mount and render read no read block");
});
