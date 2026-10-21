/**
 * Priority-4 item 1, focused follow-up: (a) where exactly does a large text entry start refusing the read, (b) how
 * much of the frame is the entry's own duplication (`text` plus `message`), and (c) what does history navigation do
 * around an entry that large — reachable, skipped, or blocking?
 *
 * Real contracts only: the backend's HTTP read surface over a real SQLite store, and the real submission route.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";
import { FRAME_LIMIT_BYTES, FRAME_TARGET_BYTES } from "../../../apps/server/src/history-window.ts";
import { headers, kib, listen, readJson, report, scratchDir } from "./lib/probe-lib.mjs";

const TOKEN = "probe-frame-token";
const textOf = (bytes) => { let text = ""; while (text.length < bytes) text += "build log line: " + "y".repeat(60) + "\n"; return text.slice(0, bytes); };

async function seeded(base, name, bytes, filler) {
  const dbPath = join(base, name + ".sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < filler; index += 1) {
      await tx.appendEntry(UserEntry, created.id, { model: [{ role: "user", content: "turn " + index + ": explain the thing", timestamp: index * 3 }] });
      await tx.appendEntry(ToolResultEntry, created.id, { model: [{ role: "toolResult", toolCallId: "call-" + index, toolName: "bash", content: [{ type: "text", text: "small result " + index }], isError: false, timestamp: index * 3 + 1 }], data: { diagnostics: [] } });
    }
    if (bytes > 0) await tx.appendEntry(ToolResultEntry, created.id, { model: [{ role: "toolResult", toolCallId: "call-big", toolName: "bash", content: [{ type: "text", text: textOf(bytes) }], isError: false, timestamp: 10_000 }], data: { diagnostics: [] } });
  }, BACKGROUND_CONTEXT);
  const newest = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: created.id }, 1, undefined), BACKGROUND_CONTEXT)).items[0];
  await harness.close();
  return { dbPath, id, newestEntryId: newest === undefined ? null : String(newest.id) };
}

async function serve(dbPath) {
  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage("ok"); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  const { origin } = await listen(server.server);
  return { origin, close: async () => { server.server.closeAllConnections(); await server.close(); } };
}

const results = { frameLimitBytes: FRAME_LIMIT_BYTES, frameTargetBytes: FRAME_TARGET_BYTES, bisect: [], duplication: null, pasteNavigation: null };
const scratch = await scratchDir("hepi-probe-frame2-");
try {
  // ---------------------------------------------------------------- bisect the refusal threshold (newest = large text)
  let low = 300 * 1024, high = 490 * 1024;
  while (high - low > 1024) {
    const mid = Math.floor((low + high) / 2);
    const store = await seeded(scratch.dir, "bisect-" + mid, mid, 6);
    const server = await serve(store.dbPath);
    const state = await readJson(server.origin + "/api/conversations/" + store.id + "/state", TOKEN);
    results.bisect.push({ textBytes: mid, status: state.status, bodyBytes: state.bytes, refusalBytes: state.body?.bytes });
    if (state.status === 413) high = mid; else low = mid;
    await server.close();
  }
  results.refusalTextThresholdBytes = high;
  results.refusalTextThresholdKiB = kib(high);

  // ---------------------------------------------------------------- duplication: entry read vs its own text
  {
    const store = await seeded(scratch.dir, "dup", 300 * 1024, 0);
    const server = await serve(store.dbPath);
    const entry = await readJson(server.origin + "/api/conversations/" + store.id + "/entries/" + store.newestEntryId, TOKEN);
    const state = await readJson(server.origin + "/api/conversations/" + store.id + "/state", TOKEN);
    results.duplication = {
      textBytes: 300 * 1024,
      entryByIdBodyBytes: entry.bytes,
      entryHasTextAndMessage: entry.body?.entry?.text !== undefined && entry.body?.entry?.message !== undefined,
      entryTextLength: entry.body?.entry?.text?.length,
      stateBodyBytes: state.bytes,
      ratioEntryToText: Math.round((entry.bytes / (300 * 1024)) * 100) / 100,
    };
    await server.close();
  }

  // ---------------------------------------------------------------- a large paste: what history navigation reaches
  {
    const store = await seeded(scratch.dir, "paste", 0, 4);
    const server = await serve(store.dbPath);
    const paste = textOf(1536 * 1024);
    const submitted = await fetch(server.origin + "/api/conversations/" + store.id + "/messages", { method: "POST", headers: headers(TOKEN), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "probe-paste", text: paste }) });
    await submitted.text();
    // Status of the first read, sampled while the run is in flight and after it settles.
    const during = [];
    for (let index = 0; index < 40; index += 1) {
      const state = await readJson(server.origin + "/api/conversations/" + store.id + "/state", TOKEN);
      during.push(state.status);
      if (state.status === 200 && state.body.busy === false && state.body.entries.at(-1)?.role === "assistant") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const settled = await readJson(server.origin + "/api/conversations/" + store.id + "/state", TOKEN);
    const page = await readJson(server.origin + "/api/conversations/" + store.id + "/entries", TOKEN);
    const row = {
      pasteTextBytes: Buffer.byteLength(paste),
      statusesDuringRun: during,
      settledStatus: settled.status,
      settledEntries: settled.status === 200 ? settled.body.entries.map(entry => ({ id: entry.id, role: entry.role, textLength: entry.text.length })) : undefined,
      settledHasMore: settled.status === 200 ? settled.body.hasMore : undefined,
      settledOldest: settled.status === 200 ? settled.body.oldestEntryId : undefined,
      pageNoBefore: { status: page.status, entries: page.status === 200 ? page.body.entries.map(entry => entry.id) : undefined, refusal: page.status === 413 ? page.body : undefined },
      pageByBefore: [],
    };
    if (settled.status === 200) {
      const ids = settled.body.entries.map(entry => Number(entry.id));
      for (const candidate of [settled.body.oldestEntryId, String(Math.max(...ids) - 1), String(Math.max(...ids) - 2)]) {
        if (candidate === null || candidate === "NaN") continue;
        const back = await readJson(server.origin + "/api/conversations/" + store.id + "/entries?before=" + candidate, TOKEN);
        row.pageByBefore.push({ before: candidate, status: back.status, entries: back.status === 200 ? back.body.entries.map(entry => ({ id: entry.id, role: entry.role, textLength: entry.text.length })) : undefined, oldestEntryId: back.status === 200 ? back.body.oldestEntryId : undefined, hasMore: back.status === 200 ? back.body.hasMore : undefined, refusal: back.status === 413 ? { entryId: back.body.entryId, bytes: back.body.bytes } : undefined });
      }
    }
    results.pasteNavigation = row;
    await server.close();
  }
} finally {
  await scratch.cleanup();
}
const path = report("frame-text-followup.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "frame-text-followup", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
