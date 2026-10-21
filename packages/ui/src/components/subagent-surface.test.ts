import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

/**
 * The child tree and the quick create read the catalogue and nothing else.
 *
 * The status a row shows is the backend's projection of **that** conversation's own facts, delivered on the catalogue
 * read the sidebar already polls. A surface that opened a stream per row would turn a list of children into a list of
 * connections, which is exactly what the ticket forbids: no permanent per-catalogue-item SSE. This asserts the
 * structural fact behind that promise — neither module opens a stream, and neither asks the backend per row.
 */
test("the child tree and the quick create open no per-row stream and read no per-row state", () => {
  for (const file of ["./AgentSessionPanel.tsx", "./QuickDelegatePanel.tsx"]) {
    const text = source(file);
    assert.equal(/new EventSource|EventSource\(/.test(text), false, file + " opens no event source");
    assert.equal(/\/events/.test(text), false, file + " names no stream route");
    // The tree renders the status it was handed; it never fetches one conversation to find it out.
    assert.equal(/\/state/.test(text), false, file + " reads no per-row state");
  }
});

/**
 * The tree shows the real host and the real status, and nothing that is not a fact about the row.
 *
 * A delegation runs on the conversation's own Execution Host, and the acceptance says the interface shows that host
 * rather than the one this Web origin happens to be served from. The catalogue states it (`gatewayId`), so the row
 * states it too — and a row whose catalogue answer carried no host shows no host rather than a default.
 */
test("a child row shows the host the catalogue states, and shows none when it states none", () => {
  const text = source("./AgentSessionPanel.tsx");
  assert.match(text, /session\.gatewayId/, "the row reads the catalogue's own host");
  assert.match(text, /agentSwitcher\.host/, "and states it with the panel's own wording");
  // A row without a host renders no host segment: an absent fact is not replaced by this origin's name.
  assert.match(text, /session\.gatewayId === undefined \? ""/, "an absent host is not defaulted");
});

/**
 * The status a row shows is the backend's, never the row's own guess.
 *
 * The one fallback the panel allows is the catalogue's `busy` flag for a row the catalogue stated no status for, which
 * is still a fact about that conversation. There is no path in which a child is shown running because something else
 * is: the projection is read, not derived.
 */
test("the status shown is the projected one, with no derivation from another conversation", () => {
  const text = source("./AgentSessionPanel.tsx");
  assert.match(text, /session\.runStatus/, "the row reads the projected status");
  assert.equal(/parentSessionId[^\n]*runStatus|runStatus[^\n]*parentSessionId/.test(text), false, "no status is read through a parent edge");
});
