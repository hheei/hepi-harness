/**
 * Priority-4 item 1, detail: the exact shape of the read surface for a conversation whose newest entry is the
 * assistant answer to a 1.5 MiB user paste. Dumps the state window and every page body around the large entry, plus
 * the runtime's own active range, so "which entries are reachable and why" is read rather than inferred.
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
const brief = (body) => body === undefined ? undefined : { keys: Object.keys(body), entries: Array.isArray(body.entries) ? body.entries.map(entry => ({ id: entry.id, role: entry.role, textLength: entry.text?.length })) : undefined, hasMore: body.hasMore, oldestEntryId: body.oldestEntryId, reason: body.reason, entryId: body.entryId, bytes: body.bytes, revision: body.revision };

const scratch = await scratchDir("hepi-probe-navdetail-");
const results = {};
try {
  const dbPath = join(scratch.dir, "paste.sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < 8; index += 1) {
      await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "turn " + index, timestamp: index * 3 }] });
      await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "c" + index, toolName: "bash", content: [{ type: "text", text: "small result " + index }], isError: false, timestamp: index * 3 + 1 }], data: { diagnostics: [] } });
    }
  }, BACKGROUND_CONTEXT);
  await harness.close();

  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage("ok"); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  const { origin } = await listen(server.server);

  const turn = await submitAndSettle(origin, TOKEN, id, "probe-detail", textOf(1536 * 1024));
  const state = await readJson(origin + "/api/conversations/" + id + "/state", TOKEN);
  results.settlement = turn.settled;
  results.state = { status: state.status, bytes: state.bytes, ...brief(state.body) };
  results.pages = [];
  for (const before of ["36", "35", "34", "30", "29", "28", "13"]) {
    const page = await readJson(origin + "/api/conversations/" + id + "/entries?before=" + before, TOKEN);
    results.pages.push({ before, status: page.status, bytes: page.bytes, body: brief(page.body) });
  }
  for (const tail of [50, 200, 1000]) {
    const page = await readJson(origin + "/api/conversations/" + id + "/entries?tail=" + tail, TOKEN);
    results.pages.push({ tail, status: page.status, bytes: page.bytes, body: brief(page.body) });
  }
  await server.close();
  results.activeRange = await scanActive(openServerHarness, dbPath, id, SERVER_MODEL, BACKGROUND_CONTEXT);
} finally {
  await scratch.cleanup();
}
const path = report("frame-navigation-detail.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "frame-navigation-detail", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
