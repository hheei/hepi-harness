import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ReadFailurePanel } = await jiti.import("./ReadFailurePanel.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ReadFailurePanel, props)));

/**
 * What a failed read offers is decided by which failure it was, and the panel is where that decision becomes a surface.
 *
 * The two placements are the ticket's own two cases. A conversation that could not be read at all has nothing to draw, so
 * the panel takes the transcript's place. One that failed a *refresh* still has its accepted window, so the panel is a
 * banner and the reader keeps what they had — that difference is the point of not discarding content on a transient
 * error, and it is visible here as which container the same failure produces.
 */
test("a read that never answered offers a Retry; one the Backend answered does not", () => {
  let retried = 0;
  const unreachable = render({ failure: { kind: "unreachable" }, variant: "surface", onRetry: () => { retried += 1; } });
  assert.match(unreachable, /data-read-failure="unreachable"/);
  assert.match(unreachable, /role="status"/, "the state is announced, not drawn as decoration");
  assert.match(unreachable, /<button[^>]*>Retry<\/button>/, "the retryable failure offers Retry");

  for (const kind of ["missing", "refused"]) {
    const answered = render({ failure: { kind }, variant: "surface", onRetry: () => { retried += 1; } });
    assert.match(answered, new RegExp('data-read-failure="' + kind + '"'));
    assert.equal(/Retry<\/button>/.test(answered), false, kind + " cannot be fixed by reading again, so no Retry is offered");
  }
  assert.equal(retried, 0, "rendering a panel never retries by itself");
});

/** Retrying is a keyboard-reachable button, and a retry in flight says so instead of inviting a second click. */
test("the retry is a real button and states its own progress", () => {
  const idle = render({ failure: { kind: "unreachable" }, variant: "surface", onRetry() {} });
  const retrying = render({ failure: { kind: "unreachable" }, variant: "surface", retrying: true, onRetry() {} });
  assert.match(idle, /<button type="button"/, "the action is a button, so it is focusable and Enter activates it");
  assert.match(retrying, /aria-busy="true"/);
  assert.match(retrying, /disabled/, "a retry in flight cannot be started twice");
});

/** The way back is offered beside the failure whenever the shell can name one, and it is never the only option. */
test("a surface failure can offer the way back to a working conversation", () => {
  const html = render({ failure: { kind: "missing" }, variant: "surface", onBack() {} });
  assert.match(html, /Back to conversations/);
  assert.match(html, /no longer exists/, "a gone conversation is stated as gone rather than as a lost connection");
});

/**
 * The inline placement is a banner, not a replacement.
 *
 * A conversation that failed a refresh still has its transcript, its draft and the reader's place, so the panel must not
 * take the screen: it is a row above the content, dismissible, and it says the same thing.
 */
test("a refresh failure is a dismissible banner that leaves the conversation on screen", () => {
  let dismissed = 0;
  const html = render({ failure: { kind: "unreachable" }, variant: "inline", onRetry() {}, onDismiss: () => { dismissed += 1; } });
  assert.match(html, /data-read-failure="unreachable"/);
  assert.equal(/height:100%/.test(html), false, "the banner does not take the transcript's place");
  assert.match(html, /Dismiss/);
});

/** A refused projection carries a sentence this build authored, and that sentence is what the panel shows. */
test("an authored refusal message replaces the generic sentence", () => {
  const message = "This conversation could not be opened in one piece: frame_too_large, entry 77.";
  const html = render({ failure: { kind: "refused" }, message, variant: "surface" });
  assert.match(html, /could not be opened in one piece/);
});
