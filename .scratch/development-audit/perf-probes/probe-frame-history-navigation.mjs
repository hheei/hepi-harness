/**
 * Priority-4 item 1, navigation: with one large text entry in the transcript, what can a client actually page to?
 *
 * Two shapes, both through the real read surface:
 *
 *   A. the large entry sits in the middle and a small entry is newest. This shape is reached by a **direct durable
 *      commit** (an out-of-band append of the kind a legacy/imported transcript or a host that bypassed the tool-output
 *      bound would produce). The ordinary agent tool path cannot produce it: pi-coding-agent truncates tool text to
 *      50 KiB and pi-durable's OutputBuffer/boundContent bound it again to the same 50 KiB.
 *   B. a 1.5 MiB **user paste** through the real submission route, then the assistant's answer — an ordinary path with
 *      no size bound of its own below MAX_SUBMISSION_BODY_BYTES (~141 MiB).
 *
 * The turn is waited for by **observed settlement** (the submission projection reaches `done`), never a fixed sleep.
 * The store's own active range is then read directly, so "unreachable through paging" cannot be confused with
 * "not stored".
 */
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";
import { kib, listen, readJson, report, scanActive, scratchDir, submitAndSettle } from "./lib/probe-lib.mjs";

const TOKEN = "probe-frame-token";
const textOf = (bytes) => { let text = ""; while (text.length < bytes) text += "build log line: " + "y".repeat(60) + "\n"; return text.slice(0, bytes); };

async function seed(base, name, build) {
  const dbPath = join(base, name + ".sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < 8; index += 1) {
      await tx.appendEntry(UserEntry, created.id, { model: [{ role: "user", content: "turn " + index + ": explain the thing", timestamp: index * 3 }] });
      await tx.appendEntry(ToolResultEntry, created.id, { model: [{ role: "toolResult", toolCallId: "call-" + index, toolName: "bash", content: [{ type: "text", text: "small result " + index }], isError: false, timestamp: index * 3 + 1 }], data: { diagnostics: [] } });
    }
    await build(tx, created.id);
  }, BACKGROUND_CONTEXT);
  await harness.close();
  return { dbPath, id };
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

/** Walk the transcript the way the client pages: the window, then `before=<oldest>` until the page stops advancing. */
async function walk(origin, id) {
  const steps = [];
  const state = await readJson(origin + "/api/conversations/" + id + "/state", TOKEN);
  if (state.status !== 200) return { stateStatus: state.status, refusal: state.body, steps };
  steps.push({ read: "state", status: 200, ids: state.body.entries.map(entry => entry.id), hasMore: state.body.hasMore, oldest: state.body.oldestEntryId, bytes: state.bytes });
  let cursor = state.body.oldestEntryId;
  const seen = new Set(state.body.entries.map(entry => entry.id));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (cursor === null) break;
    const page = await readJson(origin + "/api/conversations/" + id + "/entries?before=" + cursor, TOKEN);
    if (page.status !== 200) { steps.push({ read: "page", before: cursor, status: page.status, refusal: { entryId: page.body.entryId, bytes: page.body.bytes, reason: page.body.reason } }); break; }
    const ids = page.body.entries.map(entry => entry.id);
    steps.push({ read: "page", before: cursor, status: 200, ids, hasMore: page.body.hasMore, oldest: page.body.oldestEntryId, bytes: page.bytes });
    const fresh = ids.filter(entry => !seen.has(entry));
    for (const entry of ids) seen.add(entry);
    if (fresh.length === 0 || page.body.oldestEntryId === null || page.body.oldestEntryId === cursor) break;
    cursor = page.body.oldestEntryId;
  }
  return { stateStatus: 200, steps, reached: [...seen].length };
}

const results = { middleLarge: null, pasteLarge: null };
const scratch = await scratchDir("hepi-probe-nav-");
try {
  // A. out-of-band large entry in the middle, small entry newest
  const middle = await seed(scratch.dir, "middle", async (tx, id) => {
    await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-big", toolName: "bash", content: [{ type: "text", text: textOf(700 * 1024) }], isError: false, timestamp: 9000 }], data: { diagnostics: [] } });
    await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-after", toolName: "bash", content: [{ type: "text", text: "small result after the big one" }], isError: false, timestamp: 9001 }], data: [{ diagnostics: [] }][0] });
  });
  {
    const server = await serve(middle.dbPath);
    results.middleLarge = { walk: await walk(server.origin, middle.id) };
    await server.close();
    results.middleLarge.activeRange = await scanActive(openServerHarness, middle.dbPath, middle.id, SERVER_MODEL, BACKGROUND_CONTEXT);
  }

  // B. a 1.5 MiB user paste through the real submission route, then the assistant's answer
  const paste = await seed(scratch.dir, "paste", async () => undefined);
  {
    const server = await serve(paste.dbPath);
    const turn = await submitAndSettle(server.origin, TOKEN, paste.id, "probe-paste-nav", textOf(1536 * 1024));
    const walkResult = await walk(server.origin, paste.id);
    // The entry-by-id recovery the refusal names, for the entry the walk could not page to.
    await server.close();
    const active = await scanActive(openServerHarness, paste.dbPath, paste.id, SERVER_MODEL, BACKGROUND_CONTEXT);
    const big = active.find(entry => entry.kind === "pi.user" && entry.textBytes > 1024 * 1024);
    results.pasteLarge = { acceptedStatus: turn.acceptedStatus, settled: turn.settled, waitedMs: turn.waitedMs, observations: turn.observations, lastObservation: turn.lastObservation, observationTail: turn.observationTail, walk: walkResult, activeRange: active, pasteEntry: big ?? null };
    if (big !== undefined) {
      const reopened = await serve(paste.dbPath);
      const entry = await readJson(reopened.origin + "/api/conversations/" + paste.id + "/entries/" + big.id, TOKEN);
      results.pasteLarge.entryById = { id: big.id, status: entry.status, bytes: entry.bytes, kib: kib(entry.bytes) };
      await reopened.close();
    }
  }
} finally {
  await scratch.cleanup();
}
const path = report("frame-history-navigation.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "frame-history-navigation", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
