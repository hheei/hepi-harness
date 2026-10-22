import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalCursor, terminalFanInCursors, terminalRoute } from "./terminal.ts";

/**
 * The terminal transport's own framing decisions, at the module that owns them.
 *
 * These are the two facts a reconnect depends on and nothing else in the gateway decides: which route a request names,
 * and which cursor a stream continues from. They are pure, so they are asserted here rather than through a listener;
 * what a caller actually reads on the wire — statuses, frames, cursors, budget — stays in `test/terminal.test.ts` and
 * `test/terminal-stream-budget.test.ts`, through the gateway's ordinary admitted entry.
 */

test("a terminal route names the session and the operation the request asks for", () => {
  assert.deepEqual(terminalRoute("/v1/terminal", "POST"), { kind: "open" });
  assert.deepEqual(terminalRoute("/v1/terminal/events", "GET"), { kind: "fanIn" });
  assert.deepEqual(terminalRoute("/v1/terminal/tab%2Fa/events", "GET"), { kind: "events", id: "tab/a" });
  assert.deepEqual(terminalRoute("/v1/terminal/tab-a/input?x=1", "POST"), { kind: "input", id: "tab-a" });
  assert.deepEqual(terminalRoute("/v1/terminal/tab-a/resize", "POST"), { kind: "resize", id: "tab-a" });
  assert.deepEqual(terminalRoute("/v1/terminal/tab-a", "DELETE"), { kind: "close", id: "tab-a" });
  assert.deepEqual(terminalRoute("/v1/terminal/tab-a", "GET"), { kind: "describe", id: "tab-a" });
  // A method the route does not serve is no route at all, so the transport answers its own 404 rather than a refusal.
  assert.equal(terminalRoute("/v1/terminal/tab-a", "POST"), undefined);
  assert.equal(terminalRoute("/v1/terminal/tab-a/input", "GET"), undefined);
  assert.equal(terminalRoute("/v1/terminal/tab-a/unknown", "POST"), undefined);
  assert.equal(terminalRoute("/v1/terminal/", "GET"), undefined);
  assert.equal(terminalRoute("/v1/terminals", "GET"), undefined);
});

test("a stream continues from the browser's own record before the cursor it named when it attached", () => {
  // The header wins: an EventSource that reconnects sends both, and the header is what it actually received.
  assert.equal(terminalCursor("/v1/terminal/a/events?after=3", "7"), 7);
  assert.equal(terminalCursor("/v1/terminal/a/events?after=3"), 3);
  assert.equal(terminalCursor("/v1/terminal/a/events", "7"), 7);
  // An absent or unusable cursor is no cursor, which asks for the retained tail rather than for offset NaN.
  assert.equal(terminalCursor("/v1/terminal/a/events"), undefined);
  assert.equal(terminalCursor("/v1/terminal/a/events?after=", ""), undefined);
  assert.equal(terminalCursor("/v1/terminal/a/events?after=abc", "nope"), undefined);
  // Offset zero is a cursor: a caller that read the first frame resumes after it, not from the tail.
  assert.equal(terminalCursor("/v1/terminal/a/events", "0"), 0);
});

test("a page names its tabs with one cursor each, and a tab it names without a usable one asks for its tail", () => {
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs=a:0,b:12"), [{ id: "a", after: 0 }, { id: "b", after: 12 }]);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs=a:,b:12"), [{ id: "a" }, { id: "b", after: 12 }]);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs=a,b:x"), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs=%2Ftab%2Fa:4"), [{ id: "/tab/a", after: 4 }]);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs=:4,a:1"), [{ id: "a", after: 1 }]);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events"), []);
  assert.deepEqual(terminalFanInCursors("/v1/terminal/events?tabs="), []);
});
