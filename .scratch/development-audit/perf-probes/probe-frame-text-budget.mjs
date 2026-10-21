/**
 * Priority-4 item 1: large pure text vs the frame budgets.
 *
 * Question: when a conversation's newest entry is a large **text** tool result (or a large user submission), what does
 * the real read surface do at and around FRAME_TARGET_BYTES (512 KiB, soft) and FRAME_LIMIT_BYTES (960 KiB, hard)?
 * What is the recovery, and is a >960 KiB entry reachable through an ordinary path?
 *
 * Contracts exercised (all real): the backend's own HTTP read surface (`/state`, `/entries`, `/entries/:id`,
 * `/messages`), the durable commit API the runtime itself appends through, and the two bound functions the agent
 * tool path actually applies to tool output (pi-coding-agent's `truncateTail`/`truncateHead`, pi-durable's
 * `OutputBuffer`/`boundOutput`).
 *
 * Research only. Own temp dir, own SQLite file, own ephemeral port.
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";
import { FRAME_LIMIT_BYTES, FRAME_TARGET_BYTES, VISIBLE_WINDOW, rawWindowCap } from "../../../apps/server/src/history-window.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { headers, kib, listen, packageFile, readJson, report, scratchDir } from "./lib/probe-lib.mjs";

// The durable package does not export its deep paths, so the two bound functions are loaded by file path: they are the
// exact modules the runtime's own tool path imports.
const { boundOutput, OutputBuffer } = await import("file://" + packageFile("@earendil-works/pi-durable", "dist/harness/output.js"));

const TOKEN = "probe-frame-token";
const line = (bytes) => "x".repeat(bytes - 1) + "\n";
const textOf = (bytes) => { let text = ""; while (text.length < bytes) text += "build log line: " + "y".repeat(60) + "\n"; return text.slice(0, bytes); };

/** A store with \`filler\` small turns and one newest entry carrying \`bytes\` of pure text. */
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

const results = { frameLimitBytes: FRAME_LIMIT_BYTES, frameTargetBytes: FRAME_TARGET_BYTES, visibleWindow: VISIBLE_WINDOW, rawWindowCap: rawWindowCap(VISIBLE_WINDOW), toolOutputBound: {}, sweep: [], softTarget: null, largeSubmission: null };

// ---------------------------------------------------------------- the bound the agent tool path really applies
{
  const big = textOf(5 * 1024 * 1024);
  const tail = truncateTail(big, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const head = truncateHead(big, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const buffer = new OutputBuffer({ maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" });
  buffer.push(big);
  const snapshot = buffer.snapshot();
  const bounded = boundOutput(snapshot.text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES, retain: "tail" });
  results.toolOutputBound = {
    inputBytes: Buffer.byteLength(big),
    defaultMaxBytes: DEFAULT_MAX_BYTES,
    defaultMaxLines: DEFAULT_MAX_LINES,
    truncateTailBytes: Buffer.byteLength(tail.content),
    truncateHeadBytes: Buffer.byteLength(head.content),
    outputBufferBytes: Buffer.byteLength(snapshot.text),
    outputBufferDroppedBytes: snapshot.droppedBytes,
    boundOutputBytes: Buffer.byteLength(bounded.text),
  };
}

// ---------------------------------------------------------------- sweep: the newest entry is large text
const scratch = await scratchDir("hepi-probe-frame-");
try {
  const sizes = [64 * 1024, 300 * 1024, 490 * 1024, 700 * 1024, 900 * 1024, 1000 * 1024, 1536 * 1024, 3 * 1024 * 1024];
  for (const bytes of sizes) {
    const seededStore = await seeded(scratch.dir, "big-" + bytes, bytes, 6);
    const server = await serve(seededStore.dbPath);
    const state = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/state", TOKEN);
    const row = {
      entryTextBytes: bytes,
      stateStatus: state.status,
      stateBodyBytes: state.bytes,
      stateMs: state.ms,
      refusal: state.status === 413 ? { reason: state.body.reason, entryId: state.body.entryId, bytes: state.body.bytes } : undefined,
      windowEntries: state.status === 200 ? state.body.entries.length : undefined,
      hasMore: state.status === 200 ? state.body.hasMore : undefined,
      oldestEntryId: state.status === 200 ? state.body.oldestEntryId : undefined,
    };
    const page = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/entries", TOKEN);
    row.pageStatus = page.status;
    row.pageBodyBytes = page.bytes;
    row.pageMs = page.ms;
    row.pageEntries = page.status === 200 ? page.body.entries?.length : undefined;
    if (seededStore.newestEntryId !== null) {
      const entry = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/entries/" + seededStore.newestEntryId, TOKEN);
      row.entryByIdStatus = entry.status;
      row.entryByIdBytes = entry.bytes;
      row.entryByIdMs = entry.ms;
      row.entryByIdTextLength = entry.status === 200 ? entry.body.entry?.message?.content?.[0]?.text?.length : undefined;
    }
    // Recovery through the real submission route: one settled small turn.
    const submitted = await fetch(server.origin + "/api/conversations/" + seededStore.id + "/messages", { method: "POST", headers: headers(TOKEN), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "probe-" + bytes, text: "one more turn" }) });
    row.submitStatus = submitted.status;
    await submitted.text();
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/state", TOKEN);
    row.stateAfterTurnStatus = after.status;
    row.stateAfterTurnBytes = after.bytes;
    row.stateAfterTurnEntries = after.status === 200 ? after.body.entries.map(entry => entry.id) : undefined;
    row.stateAfterTurnHasMore = after.status === 200 ? after.body.hasMore : undefined;
    row.stateAfterTurnOldest = after.status === 200 ? after.body.oldestEntryId : undefined;
    // Paging back from the recovered window: does the oversize entry block the page behind it?
    if (after.status === 200 && after.body.hasMore === true && after.body.oldestEntryId !== null) {
      const back = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/entries?before=" + after.body.oldestEntryId, TOKEN);
      row.pageBackStatus = back.status;
      row.pageBackBytes = back.bytes;
      row.pageBackRefusal = back.status === 413 ? { reason: back.body.reason, entryId: back.body.entryId, bytes: back.body.bytes } : undefined;
      row.pageBackEntries = back.status === 200 ? back.body.entries?.length : undefined;
    }
    results.sweep.push(row);
    await server.close();
  }

  // ---------------------------------------------------------------- soft target: many small entries over 512 KiB
  {
    const seededStore = await seeded(scratch.dir, "soft", 0, 0);
    const harness = await openServerHarness(seededStore.dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
    await harness.harness.commit(async (tx) => {
      for (let index = 0; index < 40; index += 1) {
        await tx.appendEntry(UserEntry, seededStore.id, { model: [{ role: "user", content: "turn " + index, timestamp: index * 2 }] });
        await tx.appendEntry(ToolResultEntry, seededStore.id, { model: [{ role: "toolResult", toolCallId: "c" + index, toolName: "bash", content: [{ type: "text", text: textOf(20 * 1024) }], isError: false, timestamp: index * 2 + 1 }], data: { diagnostics: [] } });
      }
    }, BACKGROUND_CONTEXT);
    await harness.close();
    const server = await serve(seededStore.dbPath);
    const state = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/state", TOKEN);
    results.softTarget = {
      totalTranscriptTextBytes: 40 * 20 * 1024,
      stateStatus: state.status,
      stateBodyBytes: state.bytes,
      stateMs: state.ms,
      windowEntries: state.status === 200 ? state.body.entries.length : undefined,
      hasMore: state.status === 200 ? state.body.hasMore : undefined,
    };
    await server.close();
  }

  // ---------------------------------------------------------------- a large user submission through the real route
  {
    const seededStore = await seeded(scratch.dir, "paste", 0, 4);
    const server = await serve(seededStore.dbPath);
    const paste = textOf(1536 * 1024);
    const submitted = await fetch(server.origin + "/api/conversations/" + seededStore.id + "/messages", { method: "POST", headers: headers(TOKEN), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "probe-paste", text: paste }) });
    const submitBody = await submitted.text();
    const row = { pasteTextBytes: Buffer.byteLength(paste), submitStatus: submitted.status, submitBodyBytes: Buffer.byteLength(submitBody) };
    await new Promise(resolve => setTimeout(resolve, 500));
    const state = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/state", TOKEN);
    row.stateStatus = state.status;
    row.stateBodyBytes = state.bytes;
    row.stateEntries = state.status === 200 ? state.body.entries.map(entry => ({ id: entry.id, role: entry.role, textLength: entry.text.length })) : undefined;
    row.stateHasMore = state.status === 200 ? state.body.hasMore : undefined;
    row.stateOldest = state.status === 200 ? state.body.oldestEntryId : undefined;
    if (state.status === 200 && state.body.hasMore === true) {
      const back = await readJson(server.origin + "/api/conversations/" + seededStore.id + "/entries?before=" + state.body.oldestEntryId, TOKEN);
      row.pageBackStatus = back.status;
      row.pageBackBytes = back.bytes;
      row.pageBackRefusal = back.status === 413 ? { reason: back.body.reason, entryId: back.body.entryId, bytes: back.body.bytes } : undefined;
      row.pageBackEntries = back.status === 200 ? back.body.entries?.length : undefined;
    }
    results.largeSubmission = row;
    await server.close();
  }
} finally {
  await scratch.cleanup();
}

const path = report("frame-text-budget.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "frame-text-budget", results });
console.log(JSON.stringify({ toolOutputBound: results.toolOutputBound, sweep: results.sweep.map(row => ({ entryKiB: kib(row.entryTextBytes), state: row.stateStatus, bodyKiB: kib(row.stateBodyBytes), ms: row.stateMs, windowEntries: row.windowEntries, page: row.pageStatus, entryById: row.entryByIdStatus, afterTurn: row.stateAfterTurnStatus, pageBack: row.pageBackStatus })), softTarget: results.softTarget, largeSubmission: results.largeSubmission }, null, 2));
console.log("report: " + path);
