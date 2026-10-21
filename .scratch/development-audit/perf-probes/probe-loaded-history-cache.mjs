/**
 * Priority-4 item 4: the cost of manually loaded history.
 *
 * Two real contracts, no fixtures:
 *
 *   A. the paging route `GET /api/conversations/:id/entries?before=` on the real backend over a real SQLite store —
 *      every page a reader loads, its wire bytes and its time, and the cumulative payload the browser then holds;
 *   B. the Web app's own `session-view-cache` module (the exact code the browser runs), exercised directly for its
 *      documented bounds: 8 sessions, 32 MiB of serialized snapshots, a 10-minute TTL, and an oversize refusal.
 *
 * Explicitly **not measured here**: DOM node counts, JS heap and long-task time in a real browser. The main checkout's
 * production Web build predates the current Web sources (BUILD_ID 2026-10-13 21:12; 544 files under apps/web/app,
 * lib, hooks and components are newer), and the browser verification worktree is reserved by another worker, so a
 * browser run here would measure a stale bundle. The render input is measured instead (entries and messages loaded,
 * their serialized bytes); DOM/heap numbers are left as a named next experiment.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";
import { getSessionViewSnapshot, resetSessionViewCacheForTests, setSessionViewSnapshot } from "../../../apps/web/lib/session-view-cache.ts";
import { kib, listen, readJson, report, scratchDir } from "./lib/probe-lib.mjs";

const TOKEN = "probe-history-token";
const TURNS = 60;
const results = { turns: TURNS, pages: [], loaded: null, cache: null };
const scratch = await scratchDir("hepi-probe-loaded-");
try {
  const dbPath = join(scratch.dir, "history.sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < TURNS; index += 1) {
      await tx.appendEntry(UserEntry, created.id, { model: [{ role: "user", content: "turn " + index + ": " + "explain the module in detail. ".repeat(20), timestamp: index * 3 }] });
      await tx.appendEntry(AssistantEntry, created.id, { model: [{ role: "assistant", content: [{ type: "text", text: "answer " + index + ": " + "the module does the following. ".repeat(60) }], timestamp: index * 3 + 1 }] });
      await tx.appendEntry(ToolResultEntry, created.id, { model: [{ role: "toolResult", toolCallId: "c" + index, toolName: "read", content: [{ type: "text", text: "tool output " + index + ": " + "line of output. ".repeat(120) }], isError: false, timestamp: index * 3 + 2 }], data: { diagnostics: [] } });
    }
  }, BACKGROUND_CONTEXT);
  await harness.close();

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ok")]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  const { origin } = await listen(server.server);

  const state = await readJson(origin + "/api/conversations/" + id + "/state", TOKEN);
  let loadedEntries = state.body.entries.length;
  let loadedMessages = state.body.entries.length;
  let loadedBytes = state.bytes;
  let cursor = state.body.oldestEntryId;
  const seen = new Set(state.body.entries.map(entry => entry.id));
  for (let page = 0; page < 20 && cursor !== null; page += 1) {
    const read = await readJson(origin + "/api/conversations/" + id + "/entries?before=" + cursor, TOKEN);
    if (read.status !== 200) { results.pages.push({ page, status: read.status, refusal: read.body }); break; }
    const ids = read.body.entries.map(entry => entry.id);
    const fresh = ids.filter(entry => !seen.has(entry));
    results.pages.push({ page, status: 200, entries: ids.length, fresh: fresh.length, bytes: read.bytes, ms: read.ms, hasMore: read.body.hasMore, oldestEntryId: read.body.oldestEntryId });
    for (const entry of ids) seen.add(entry);
    loadedEntries += ids.length;
    loadedMessages += ids.length;
    loadedBytes += read.bytes;
    if (read.body.oldestEntryId === null || read.body.oldestEntryId === cursor || fresh.length === 0) break;
    cursor = read.body.oldestEntryId;
  }
  results.loaded = { entries: loadedEntries, messages: loadedMessages, cumulativeKiB: kib(loadedBytes), windowKiB: kib(state.bytes), pages: results.pages.length };
  await server.close();

  // ---- the Web app's own session-view cache, exercised directly
  resetSessionViewCacheForTests();
  const snapshotOf = (sessionId, messageBytes) => ({ sessionId, revision: "r1", messages: [{ id: "m", role: "assistant", text: "x".repeat(messageBytes) }], entryIds: ["1"], leafId: "1", oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null, loadedEntryIds: [], prefixEntryIds: [], prefixMessages: [], prefixHistoryHead: null });
  const inserted = [];
  for (let index = 0; index < 12; index += 1) inserted.push(setSessionViewSnapshot(snapshotOf("session-" + index, 5 * 1024 * 1024)));
  const cacheStore = globalThis.__piSessionViewCache;
  const cacheBytes = [...(cacheStore?.values() ?? [])].reduce((total, snapshot) => total + Buffer.byteLength(JSON.stringify(snapshot)), 0);
  const oversizeRefused = setSessionViewSnapshot(snapshotOf("session-oversize", 40 * 1024 * 1024)) === false;
  const afterOversize = globalThis.__piSessionViewCache;
  const afterOversizeBytes = [...(afterOversize?.values() ?? [])].reduce((total, snapshot) => total + Buffer.byteLength(JSON.stringify(snapshot)), 0);
  results.cache = {
    insertedAll: inserted.every(Boolean),
    sessionsAfterTwelveInserts: cacheStore?.size,
    bytesAfterTwelveInsertsKiB: kib(cacheBytes),
    oversizeRefused,
    sessionsAfterOversize: afterOversize?.size,
    bytesAfterOversizeKiB: kib(afterOversizeBytes),
    oldestEvicted: getSessionViewSnapshot("session-0") === null,
    newestKept: getSessionViewSnapshot("session-11") !== null,
  };
  resetSessionViewCacheForTests();
} finally {
  await scratch.cleanup();
}
const path = report("loaded-history-cost.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "loaded-history-cost", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
