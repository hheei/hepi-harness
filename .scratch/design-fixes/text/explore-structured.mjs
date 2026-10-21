
/**
 * Scratch probe: does a scripted assistant toolCall (a structured input, no read block) land as an appended entry
 * the frame cannot shrink? Decides how the frame-size / delta-frames fixtures must be re-expressed once text is
 * deferrable. Own temp dir; no repo source touched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";

const TOKEN = "structured-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const dir = await mkdtemp(join(tmpdir(), "hepi-structured-"));
const dbPath = join(dir, "structured.sqlite");
try {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(tx => tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "write it", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  await harness.close();

  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/big.txt", content: "x".repeat(1_760_000) })); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise(r => server.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.server.address().port;
  const read = async (path) => { const response = await fetch(origin + path, { headers }); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, bytes: Buffer.byteLength(text), body }; };

  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "structured-1", text: "write the file" }) });
  console.log("POST", accepted.status);
  const deadline = Date.now() + 20_000;
  let state = null;
  while (Date.now() < deadline) {
    state = await read("/api/conversations/" + id + "/state");
    if (state.status !== 200) break;
    if (state.body.busy === false) break;
    await new Promise(r => setTimeout(r, 25));
  }
  console.log("STATE", JSON.stringify({ status: state.status, bytes: state.bytes, reason: state.body?.reason, entryId: state.body?.entryId, frameBytes: state.body?.bytes, ids: state.body?.entries?.map(e => e.id), hasMore: state.body?.hasMore, oldest: state.body?.oldestEntryId }));
  const paused = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const range = await paused.harness.commit(tx => tx.scanEntries({ conversationId: Number(id) }, 50, undefined), BACKGROUND_CONTEXT);
  console.log("ACTIVE_ASC", JSON.stringify(range.items.map(e => ({ id: String(e.id), kind: e.kind, role: e.model?.[0]?.role, contentBytes: Buffer.byteLength(JSON.stringify(e.model?.[0]?.content ?? null)) }))));
  await paused.close();
  await server.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
