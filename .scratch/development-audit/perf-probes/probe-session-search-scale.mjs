/**
 * Priority-4 item 3: the bounded session search — cost and completeness at scale.
 *
 * Real contract: `GET /api/search?q=` on the real backend over a real SQLite store. Conversations are seeded through
 * the durable commit API (the same append path the runtime uses) with realistic turn sizes, and the needle is placed
 * so that finding it requires scanning the whole catalogue (oldest conversation = scanned last) — the worst case for a
 * bounded, sequential, index-free scan.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";
import { SEARCH_LIMITS } from "../../../apps/server/src/session-search.ts";
import { createEchoFauxProvider } from "../../../apps/server/test/faux-fixture.ts";
import { headers, kib, listen, readJson, report, scratchDir } from "./lib/probe-lib.mjs";

const TOKEN = "probe-search-token";
const TURNS = 15;
const BODY = "the quick brown fox jumps over the lazy dog and then writes a paragraph of ordinary prose. ".repeat(4);

const results = { limits: SEARCH_LIMITS, turnsPerConversation: TURNS, bytesPerTurn: Buffer.byteLength(BODY), scales: [] };
const scratch = await scratchDir("hepi-probe-search-");
try {
  for (const [conversations, needleInOldest] of [[100, true], [500, true], [600, true], [500, false]]) {
    const dbPath = join(scratch.dir, "search-" + conversations + "-" + (needleInOldest ? "oldest" : "everywhere") + ".sqlite");
    const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
    const ids = [];
    for (let index = 0; index < conversations; index += 1) {
      const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
      ids.push(String(created.id));
      const wanted = needleInOldest ? index === 0 : true;
      await harness.harness.commit(async (tx) => {
        for (let turn = 0; turn < TURNS; turn += 1) {
          const text = wanted && turn === TURNS - 1 ? BODY + " NEEDLE-ALPHA here" : BODY;
          await tx.appendEntry(UserEntry, created.id, { model: [{ role: "user", content: "turn " + turn + " " + text, timestamp: turn * 3 }] });
          await tx.appendEntry(AssistantEntry, created.id, { model: [{ role: "assistant", content: [{ type: "text", text: "answer " + turn + " " + BODY }], timestamp: turn * 3 + 1 }] });
          await tx.appendEntry(ToolResultEntry, created.id, { model: [{ role: "toolResult", toolCallId: "c" + turn, toolName: "read", content: [{ type: "text", text: "tool output " + BODY }], isError: false, timestamp: turn * 3 + 2 }], data: { diagnostics: [] } });
        }
      }, BACKGROUND_CONTEXT);
    }
    await harness.close();

    const models = createModels(); models.setProvider(createEchoFauxProvider().provider);
    const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
    const { origin } = await listen(server.server);
    const conversationsBytes = conversations * TURNS * (Buffer.byteLength(BODY) * 3);
    const hit = await readJson(origin + "/api/search?" + new URLSearchParams({ q: "NEEDLE-ALPHA" }), TOKEN);
    const miss = await readJson(origin + "/api/search?" + new URLSearchParams({ q: "NEEDLE-OMEGA" }), TOKEN);
    results.scales.push({
      conversations,
      needle: needleInOldest ? "oldest conversation only" : "every conversation",
      catalogTextMiB: Math.round((conversationsBytes / (1024 * 1024)) * 10) / 10,
      hitStatus: hit.status,
      hitMs: hit.ms,
      hitResults: hit.body?.results?.length,
      hitTruncated: hit.body?.truncated,
      hitResultConversationIsOldest: hit.body?.results?.[0]?.conversationId === ids[0],
      missStatus: miss.status,
      missMs: miss.ms,
      missResults: miss.body?.results?.length,
      missTruncated: miss.body?.truncated,
    });
    await server.close();
  }
} finally {
  await scratch.cleanup();
}
const path = report("session-search-scale.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "session-search-scale", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
