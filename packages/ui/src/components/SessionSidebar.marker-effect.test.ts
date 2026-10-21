import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import type { SessionUiState } from "@hepi/protocol";

const { transformSync } = createRequire(import.meta.url)("esbuild") as { transformSync: (input: string, options: { loader: "ts" }) => { code: string } };
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { advanceRunMarks } = await jiti.import<typeof import("../lib/run-marks.ts")>("../lib/run-marks.ts");
const { applySessionUiStateRequest, emptySessionUiState } = await jiti.import<typeof import("@hepi/protocol")>("@hepi/protocol");
const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

/** The source between one marker and the next, refused as an unrun case when either is missing. */
function between(startText: string, endText: string): string {
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
  let state: SessionUiState = emptySessionUiState();
  let clock = 1000;
  // The page's rendered sidebar state and the refs the two effects read: what the analysed block treats as its closure.
  // React's own `useCallback` and `useEffect` are narrowed to the fact the block relies on — the body is handed back and
  // run, with no scheduler — and the setters write into the same `state` the assertions read.
  const sandbox = {
    advanceRunMarks,
    useCallback: <T,>(callback: T): T => callback,
    useEffect: (effect: () => void) => effect(),
    unreadRef: { current: new Set<string>() },
    previousRunningSessionIdsRef: { current: new Set<string>() },
    seenRunEndsRef: { current: new Map<string, number>() },
    runMarksSeededRef: { current: false },
    selectedSessionId: null as string | null,
    allSessions: [] as { id: string; lastRunEndedAt: number }[],
    runningSessionIds: new Set<string>(),
    loadSessions() {},
    chunkForSessionUiRequests: (items: unknown) => [items],
    applyUiState(request: Parameters<typeof applySessionUiStateRequest>[1]): Promise<boolean> {
      state = applySessionUiStateRequest(state, request, ++clock).state;
      return Promise.resolve(true);
    },
  };
  const context = createContext(sandbox);
  write.runInContext(context);
  const unread = () => Object.keys(state.sessions).filter(id => state.sessions[id].unreadAt !== undefined);
  function step(endedAt: number, running: boolean, selected: string | null = null) {
    sandbox.unreadRef.current = new Set(unread());
    sandbox.allSessions = [{ id: "a", lastRunEndedAt: endedAt }];
    sandbox.runningSessionIds = new Set(running ? ["a"] : []);
    sandbox.selectedSessionId = selected;
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
