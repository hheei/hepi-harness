import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import<typeof import("react")>("react");
const { renderToStaticMarkup } = await jiti.import<typeof import("react-dom/server")>("react-dom/server");
const { OAuthPastePanel, oauthPasteKeySubmits } = await jiti.import<typeof import("./OAuthPastePanel.tsx")>("./OAuthPastePanel.tsx");

test("OAuth paste submits a ready value, never empty, pending, or composing input", () => {
  for (const [value, disabled, blocked] of [["  ", false, true], ["code", false, false], ["code", true, true]] as const) {
    const html = renderToStaticMarkup(React.createElement(OAuthPastePanel, {
      value, disabled, message: "Paste code", placeholder: "code", submitLabel: "Submit",
      onValueChange() {}, onSubmit() {},
    }));
    const button = html.match(/<button\b[^>]*>/)?.[0];
    assert.ok(button, "submit button exists");
    assert.equal(/\bdisabled\b/.test(button), blocked);
  }
  const enter = { key: "Enter", metaKey: false, ctrlKey: false, isComposing: false, keyCode: 13 };
  assert.equal(oauthPasteKeySubmits(enter, true), true);
  assert.equal(oauthPasteKeySubmits(enter, false), false);
  assert.equal(oauthPasteKeySubmits({ ...enter, ctrlKey: true }, false), true);
  assert.equal(oauthPasteKeySubmits({ ...enter, isComposing: true }, true), false);
  assert.equal(oauthPasteKeySubmits({ ...enter, keyCode: 229, ctrlKey: true }, false), false);
});
