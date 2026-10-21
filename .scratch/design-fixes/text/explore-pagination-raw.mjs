
/**
 * Scratch probe: isolate the raw-only empty older page from the large-text deferral question.
 * Fixture: small turns, then a large NON-text entry (a write tool call's input), then a bookkeeping system entry,
 * then a small assistant answer. The page whose slice ends with the bookkeeping entry is the shape under test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, SystemEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";

const TOKEN = "pagination-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const dir = await mkdtemp(join(tmpdir(), "hepi-pagination-"));
const dbPath = join(dir, "pagination.sqlite");
try {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < 4; index += 1) {
      await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "turn " + index, timestamp: index * 3 }] });
      await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "c" + index, toolName: "bash", content: [{ type: "text", text: "small result " + index }], isError: false, timestamp: index * 3 + 1 }], data: { diagnostics: [] } });
    }
    // A large entry that no text policy can defer: a write tool call whose input carries the file body.
    await tx.appendEntry(AssistantEntry, id, { model: [{ role: "assistant", content: [{ type: "toolCall", toolCallId: "big-write", toolName: "write", input: { path: "/tmp/big.txt", content: "x".repeat(700 * 1024) } }], timestamp: 100 }] });
    await tx.appendEntry(SystemEntry, id, { model: [{ role: "system", content: "" }] });
    await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage("done", { timestamp: 101 })] });
  }, BACKGROUND_CONTEXT);
  await harness.close();

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("ok")]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise(r => server.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.server.address().port;
  const read = async (path) => { const response = await fetch(origin + path, { headers }); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; };
  const brief = (r) => ({ status: r.status, ids: r.body?.entries?.map(e => e.id), hasMore: r.body?.hasMore, oldest: r.body?.oldestEntryId, reason: r.body?.reason, entryId: r.body?.entryId, bytes: r.body?.bytes });

  const state = await read("/api/conversations/" + id + "/state");
  console.log("STATE", JSON.stringify(brief(state)));
  const cursor = state.body?.oldestEntryId ?? state.body?.entries?.[0]?.id ?? null;
  console.log("CURSOR", cursor);
  let before = cursor;
  for (let step = 0; step < 6 && before; step += 1) {
    const page = await read("/api/conversations/" + id + "/entries?before=" + before + "&tail=50");
    console.log("PAGE before=" + before, JSON.stringify(brief(page)));
    before = page.body?.oldestEntryId ?? null;
  }
  await server.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
