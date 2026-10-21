import assert from "node:assert/strict";
import test from "node:test";
import { getInitialNavigation, withTabOpen } from "./initial-navigation.ts";

test("URL choices precede remembered tabs; an empty URL restores the previous composer or session", () => {
  const chosen = getInitialNavigation(new URLSearchParams({ cwd: " /repo ", session: "old", sidebar: "collapsed" }));
  assert.deepEqual(chosen, { requestedCwd: "/repo", sessionId: null, sidebarCollapsed: true });
  const tab = { kind: "session", sessionId: "remembered" };
  assert.equal(withTabOpen(chosen, tab), chosen);
  const session = getInitialNavigation(new URLSearchParams({ session: "explicit" }));
  assert.equal(withTabOpen(session, tab), session);
  assert.equal(session.sessionId, "explicit");
  const empty = getInitialNavigation(new URLSearchParams());
  assert.deepEqual(empty, { requestedCwd: null, sessionId: null, sidebarCollapsed: false });
  assert.equal(withTabOpen(empty, tab).sessionId, "remembered");
  assert.equal(withTabOpen(empty, { kind: "new", cwd: "/repo" }).requestedCwd, "/repo");
});
