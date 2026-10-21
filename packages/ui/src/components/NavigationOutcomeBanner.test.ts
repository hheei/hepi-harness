import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { NavigationFailure, NavigationOutcome } from "../lib/history-navigation.ts";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import<typeof import("react")>("react");
const { renderToStaticMarkup } = await jiti.import<typeof import("react-dom/server")>("react-dom/server");
const { I18nProvider } = await jiti.import<typeof import("../hooks/useI18n.tsx")>("../hooks/useI18n.tsx");
const { NavigationOutcomeBanner } = await jiti.import<typeof import("./NavigationOutcomeBanner.tsx")>("./NavigationOutcomeBanner.tsx");
const { NAVIGATION_OUTCOMES } = await jiti.import<typeof import("../lib/history-navigation.ts")>("../lib/history-navigation.ts");
const { encodeNavigationAnchor, buildNavigationTargetWindow } = await jiti.import<typeof import("@hepi/protocol/navigation")>("@hepi/protocol/navigation");

/** One window a landing could have brought, around the entry the request named. */
function windowOf(entryId: string) {
  const scope = CONVERSATION + "|9";
  return buildNavigationTargetWindow({
    protocol: "hepi.v1",
    conversationId: CONVERSATION,
    snapshot: scope + "|120",
    scope,
    target: { entryId, anchor: encodeNavigationAnchor({ version: 1, conversationId: CONVERSATION, scope, entryId }), present: true, blocks: [0] },
    entries: [{ id: entryId, role: "user", text: "the target", message: { role: "user", content: "the target" } }],
    hasOlder: false,
    hasNewer: false,
    capped: false,
  });
}

/**
 * The outcome states a reader can be left in, each rendered as a state of its own.
 *
 * The ticket's acceptance is that stale, missing, cancelled, deferred-busy and error each have a *distinct rendered*
 * state and that no failure path ends as a silent handled. A translation lookup that misses returns the key itself, so
 * "it rendered something" proves nothing; these cases read the sentence, the reason's own name in the DOM, and the two
 * offers, so a collapsed pair or an unworded reason fails here rather than on the page.
 */

const CONVERSATION = "42";

/** One failed settlement of a named kind, as the coordinator reports it. */
function failed(failure: NavigationFailure, entryId = "100"): NavigationOutcome {
  return {
    kind: "failed",
    request: { conversationId: CONVERSATION, target: { entryId, ...(failure === "malformed" ? {} : { block: 2 }) } },
    failure,
    detail: "the Backend's own sentence",
    retry: () => {},
    clear: () => {},
  };
}

type BannerProps = Parameters<typeof NavigationOutcomeBanner>[0];
const render = (outcome: NavigationOutcome | null, props: Partial<BannerProps> = {}) => renderToStaticMarkup(React.createElement(I18nProvider, null,
  React.createElement(NavigationOutcomeBanner, {
    outcome,
    conversationId: CONVERSATION,
    onOpenSession: () => {},
    onDismiss: () => {},
    minimapWidth: 36,
    columnPadding: 16,
    isMobile: false,
    ...props,
  }),
));

/** The rendered text and the reason's name, read out of the markup the surface produces. */
function stated(html: string) {
  const name = html.match(/data-navigation-outcome="([^"]+)"/)?.[1] ?? null;
  const words = [...html.matchAll(/>([^<>]+)</g)].map(([, text]) => text.trim()).filter(Boolean);
  return { name, words, buttons: (html.match(/<button/g) ?? []).length };
}

test("every unresolved outcome renders its own named state, with retry and dismissal", () => {
  const seen = new Map<string, string>();
  for (const failure of NAVIGATION_OUTCOMES) {
    const html = render(failed(failure));
    const shown = stated(html);
    assert.equal(shown.name, failure, failure + " states its own reason in the DOM");
    assert.ok(shown.words.includes("navigation.outcome." + failure) === false, failure + " renders a sentence, not an unworded key: " + JSON.stringify(shown.words));
    assert.ok(shown.words.some((word) => word.length > 20), failure + " states what happened in words a reader can act on: " + JSON.stringify(shown.words));
    // `aria-live="polite"` with `role="status"`: a locate that failed while the reader's focus stayed on the composer
    // is announced, which is the half of "rendered state" a screenshot cannot show.
    assert.ok(html.includes('role="status"') && html.includes('aria-live="polite"'), failure + " is announced, not only painted");
    assert.equal(shown.buttons, 3, failure + " offers retry, raw history and dismissal");
    assert.ok(shown.words.includes("Retry"), failure + " offers a retry");
    // The two names the client owns say what the reader can do about them, in their own words.
    if (failure === "deferred-busy") assert.ok(shown.words.some((word) => word.includes("mid-run")), "a parked jump says the run is why");
    if (failure === "cancelled") assert.ok(shown.words.some((word) => word.includes("moved on")), "an abandoned jump says the reader is why");
    seen.set(failure, shown.words.join("|"));
  }
  assert.equal(seen.size, NAVIGATION_OUTCOMES.length, "all seven names are covered here");
  const sentences = new Set([...seen.values()].map((words) => words.split("|")[0]));
  assert.equal(sentences.size, NAVIGATION_OUTCOMES.length, "no two outcomes share the sentence a reader distinguishes them by");
});

test("a landing renders nothing, and a navigation still held renders nothing", () => {
  // The two states that must *not* produce a banner: a `held` landing is the transcript's business, and no outcome at
  // all is the ordinary case. A banner over a landing would be a failure the reader never had.
  assert.equal(render(null), "");
  const held: NavigationOutcome = {
    kind: "held",
    request: { conversationId: CONVERSATION, target: { entryId: "100" } },
    loaded: true,
    window: windowOf("100"),
    coordinate: { version: 1, conversationId: CONVERSATION, scope: CONVERSATION + "|9", entryId: "100" },
  };
  assert.equal(render(held), "");
});

test("the raw-history offer is made only when there is an entry to open", () => {
  // An address this contract could not read (`malformed`) names no entry, and a surface outside a conversation has no
  // history panel to open — in both cases the offer would be a button that does nothing.
  assert.equal(stated(render(failed("malformed", ""))).buttons, 2, "an unreadable address offers no raw history");
  assert.equal(stated(render(failed("missing"), { conversationId: null })).buttons, 2, "no conversation, no raw history");
  assert.equal(stated(render(failed("missing"), { onOpenSession: undefined })).buttons, 2, "a host without the seam gets no dead button");
  const html = render(failed("missing"));
  assert.ok(html.includes("Open the raw history instead"), "and where the entry exists, the offer is the second thing a reader is told");
});
