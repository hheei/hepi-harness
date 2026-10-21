/**
 * Priority-4 probe: session search (apps/server/src/session-search.ts) at realistic history scale, through its public
 * HTTP surface (GET /api/search on a real backend), with the store seeded in batch through the native harness.
 *
 * Research only. No business or test code is touched; the store is a temp SQLite file under the git-ignored
 * .dev/research-performance/ and the only provider is the offline scripted one (createEchoFauxProvider), so no paid
 * model is contacted.
 *
 * Scenarios, each a distinct literal in one seeded store:
 *   - early: the needle is the first entry of the newest conversation (candidate order is newest first);
 *   - late: the needle is only in the last entry of the oldest conversation (every candidate is scanned);
 *   - missing: no conversation holds it (the whole store is scanned, the truthful answer is empty);
 *   - all: every conversation holds it, so the 30-result bound is hit and must be reported as truncated.
 * A separate store with SEARCH_LIMITS.maxConversations + 10 conversations proves the 500-conversation bound is
 * reported, not silently clipped. The 3000 ms budget is reported as not reached at these scales; the bound itself is
 * exercised by the existing unit test with an injected clock, not by waiting three seconds here.
 *
 * Run as: node --import ./lib/register.mjs probe-session-search.mjs
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { createEchoFauxProvider } from "../../../apps/server/test/faux-fixture.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SEARCH_LIMITS } from "../../../apps/server/src/session-search.ts";
import { outputRoot, readJson, timed } from "./lib/probe-lib.mjs";

const results = { limits: { ...SEARCH_LIMITS }, scales: [], conversationBound: {} };
const scratch = await mkdtemp(join(tmpdir(), "hepi-probe-session-search-"));
const token = "probe-token";
const emit = (name, payload) => {
  const directory = join(outputRoot, "resource-search");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name + ".json");
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
};

/**
 * Batch seeding through the runtime's own public write path: one commit per conversation appending every entry.
 * Conversation 0 (the oldest) gets the late marker last; conversation count-1 (the newest) gets the early marker
 * first; every conversation gets the shared marker last.
 */
async function seed(dbPath, count, fillerEntries, markers, textBytes = 0) {
  const harness = await openServerHarness(dbPath, undefined, undefined, undefined, { startPaused: true });
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const id = created.id;
    ids.push(id);
    await harness.harness.commit(async (tx) => {
      const append = (user, text) => tx.appendEntry(user ? UserEntry : AssistantEntry, id, { model: [user ? { role: "user", content: text, timestamp: 0 } : fauxAssistantMessage(text)] });
      if (markers && index === count - 1) await append(true, "early needle in the newest conversation");
      for (let turn = 0; turn < fillerEntries; turn += 1) {
        const user = turn % 2 === 0;
        const filler = textBytes === 0 ? "" : " " + "x".repeat(textBytes);
        await append(user, (user ? "conversation " + index + " turn " + turn + " asks about filler text" : "conversation " + index + " turn " + turn + " answers with filler text") + filler);
      }
      if (markers && index === 0) await append(true, "late needle in the oldest conversation");
      if (markers) await append(true, "shared needle " + index);
    }, BACKGROUND_CONTEXT);
  }
  await harness.close();
  return ids;
}

/** One real backend over the seeded store; the offline scripted provider is the only model catalog. */
async function start(dbPath) {
  const models = createModels();
  models.setProvider(createEchoFauxProvider().provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  return { backend, origin: "http://127.0.0.1:" + address.port };
}

const search = (origin, query) => readJson(origin + "/api/search?" + new URLSearchParams({ q: query }), token);

try {
  for (const count of [10, 100, 500]) {
    const dbPath = join(scratch, "search-" + count + ".sqlite");
    const fillerEntries = 20;
    const seeded = await timed(() => seed(dbPath, count, fillerEntries, true));
    const ids = seeded.value.map(String);
    const boot = await timed(() => start(dbPath));
    const { backend, origin } = boot.value;
    const scenarios = [
      { name: "early", q: "early needle in the newest conversation", expect: (body) => { assert.equal(body.results.length, 1); assert.equal(body.truncated, false); } },
      { name: "late", q: "late needle in the oldest conversation", expect: (body) => { assert.equal(body.results.length, 1); assert.equal(body.truncated, false); } },
      { name: "missing", q: "no conversation holds this phrase", expect: (body) => { assert.equal(body.results.length, 0); assert.equal(body.truncated, false); } },
      { name: "all", q: "shared needle", expect: (body) => { assert.equal(body.results.length, Math.min(count, SEARCH_LIMITS.maxResults)); assert.equal(body.truncated, count > SEARCH_LIMITS.maxResults); } },
    ];
    const scenarioResults = {};
    for (const scenario of scenarios) {
      const runs = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const measured = await search(origin, scenario.q);
        assert.equal(measured.status, 200, JSON.stringify(measured.body));
        scenario.expect(measured.body);
        runs.push({ ms: measured.ms, results: measured.body.results.length, truncated: measured.body.truncated, bytes: measured.bytes });
      }
      const warm = runs.slice(1);
      scenarioResults[scenario.name] = {
        query: scenario.q,
        coldMs: runs[0].ms,
        warmMs: warm.map((run) => run.ms),
        results: runs[0].results,
        truncated: runs[0].truncated,
        responseBytes: runs[0].bytes,
        budgetReached: false,
      };
    }
    // The truthful early/late distinction, read from the hit itself: the early hit is the newest conversation, the late
    // one is the oldest, so the late answer proves the whole candidate list was scanned.
    const late = await search(origin, "late needle in the oldest conversation");
    scenarioResults.late.hitConversationId = late.body.results[0].conversationId;
    scenarioResults.late.oldestConversationId = ids[0];
    scenarioResults.late.isOldest = late.body.results[0].conversationId === ids[0];
    const early = await search(origin, "early needle in the newest conversation");
    scenarioResults.early.hitConversationId = early.body.results[0].conversationId;
    scenarioResults.early.newestConversationId = ids.at(-1);
    scenarioResults.early.isNewest = early.body.results[0].conversationId === ids.at(-1);
    results.scales.push({
      conversations: count,
      entriesPerConversation: fillerEntries + 2,
      entriesPerStore: count * (fillerEntries + 2),
      conversationsScanned: { early: 1, late: count, missing: count, all: Math.min(count, SEARCH_LIMITS.maxResults) },
      seedMs: seeded.ms,
      bootMs: boot.ms,
      scenarios: scenarioResults,
    });
    await backend.close();
  }

  // ---- the conversation bound, over SEARCH_LIMITS.maxConversations, on its own store.
  {
    const count = SEARCH_LIMITS.maxConversations + 10;
    const dbPath = join(scratch, "search-bound.sqlite");
    const seeded = await timed(() => seed(dbPath, count, 2, false));
    const ids = seeded.value.map(String);
    const boot = await timed(() => start(dbPath));
    const { backend, origin } = boot.value;
    const every = await search(origin, "asks about filler text");
    assert.equal(every.status, 200);
    const oldest = await timed(() => search(origin, "conversation 0 turn 0"));
    results.conversationBound = {
      conversations: count,
      overMaxConversations: count - SEARCH_LIMITS.maxConversations,
      seedMs: seeded.ms,
      bootMs: boot.ms,
      ms: every.ms,
      results: every.body.results.length,
      truncated: every.body.truncated,
      oldestConversationQueried: "conversation 0 turn 0",
      oldestConversationMs: oldest.ms,
      oldestConversationFound: oldest.value.body.results.length > 0,
      oldestConversationTruncated: oldest.value.body.truncated,
      oldestConversationId: ids[0],
      note: "the bound is reported as truncated rather than passed off as the whole answer",
    };
    assert.equal(every.body.truncated, true, "over the conversation bound the answer is reported as truncated");
    await backend.close();
  }

  // ---- labeled synthetic boundary: 500 conversations x 4 entries x 8 KiB, 16 MiB of searched text, to show how the
  // wall-clock budget behaves when the bytes (not the conversation count) dominate.
  {
    const count = 500;
    const entries = 4;
    const textBytes = 8 * 1024;
    const dbPath = join(scratch, "search-text.sqlite");
    const seeded = await timed(() => seed(dbPath, count, entries, false, textBytes));
    const boot = await timed(() => start(dbPath));
    const { backend, origin } = boot.value;
    const missing = await search(origin, "no conversation holds this phrase");
    assert.equal(missing.body.results.length, 0);
    assert.equal(missing.body.truncated, false, "a full scan under the wall-clock budget is a complete answer");
    const searchedMiB = (count * entries * textBytes) / (1024 * 1024);
    results.textBoundary = {
      label: "synthetic: 500 conversations x 4 entries x 8 KiB",
      conversations: count,
      entriesPerConversation: entries,
      searchedTextMiB: Math.round(searchedMiB * 100) / 100,
      seedMs: seeded.ms,
      bootMs: boot.ms,
      fullScanMs: missing.ms,
      perMiBMs: Math.round((missing.ms / searchedMiB) * 100) / 100,
      truncated: missing.body.truncated,
      budgetMs: SEARCH_LIMITS.timeBudgetMs,
      budgetReached: missing.body.truncated,
    };
    await backend.close();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const revision = execSync("git rev-parse HEAD", { cwd: outputRoot }).toString().trim();
const path = emit("session-search", { revision, probe: "session-search-scale", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
