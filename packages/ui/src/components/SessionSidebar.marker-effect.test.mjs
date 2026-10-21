import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";

const { transformSync } = createRequire(import.meta.url)("esbuild");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { advanceRunMarks } = await jiti.import("../lib/run-marks.ts");
const { applySessionUiStateRequest, emptySessionUiState } = await jiti.import("@hepi/protocol");
const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

function between(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(start >= 0 && end > start, `missing sidebar block: ${startText}`);
  return source.slice(start, end);
}

const write = new Script(transformSync(
  between("const writeUnread = ", "\n  const ") + ";", { loader: "ts" },
).code);
const effects = new Script(transformSync(
  between("  useEffect(() => {\n    const previous = previousRunningSessionIdsRef.current;", "\n  }, [runningSessionIds") + "\n});\n" +
  between("  useEffect(() => {\n    if (!selectedSessionId) return;\n    writeUnread([selectedSessionId], false);", "\n  }, [selectedSessionId") + "\n});",
  { loader: "ts" },
).code);

test("queued completion remains unread across refresh until the conversation opens", () => {
  let state = emptySessionUiState();
  let clock = 1000;
  const context = createContext({
    advanceRunMarks,
    useCallback: fn => fn,
    useEffect: fn => fn(),
    unreadRef: { current: new Set() },
    previousRunningSessionIdsRef: { current: new Set() },
    seenRunEndsRef: { current: new Map() },
    runMarksSeededRef: { current: false },
    selectedSessionId: null,
    loadSessions() {},
    chunkForSessionUiRequests: items => [items],
    applyUiState(request) {
      state = applySessionUiStateRequest(state, request, ++clock).state;
      return Promise.resolve(true);
    },
  });
  write.runInContext(context);
  const unread = () => Object.keys(state.sessions).filter(id => state.sessions[id].unreadAt !== undefined);
  function step(endedAt, running, selected = null) {
    context.unreadRef.current = new Set(unread());
    context.allSessions = [{ id: "a", lastRunEndedAt: endedAt }];
    context.runningSessionIds = new Set(running ? ["a"] : []);
    context.selectedSessionId = selected;
    effects.runInContext(context);
  }
  step(100, true);
  assert.deepEqual(unread(), []);
  step(200, true);
  assert.deepEqual(unread(), ["a"]);
  step(200, false);
  assert.deepEqual(unread(), ["a"]);
  assert.equal(state.sessions.a.unreadAt, 1001);
  step(200, false, "a");
  assert.deepEqual(unread(), []);
});
