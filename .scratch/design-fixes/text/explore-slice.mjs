
/**
 * Scratch probe: the native active-array order and the exact raw slice each page is cut from, so the empty-page
 * shape is read rather than inferred. Own temp dir; no repo source touched.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";

const TOKEN = "slice-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const textOf = (bytes) => { let text = ""; while (text.length < bytes) text += "log line: " + "y".repeat(60) + "\n"; return text.slice(0, bytes); };

const dir = await mkdtemp(join(tmpdir(), "hepi-slice-"));
const dbPath = join(dir, "slice.sqlite");
try {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(async (tx) => {
    for (let index = 0; index < 4; index += 1) {
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
  await new Promise(r => server.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.server.address().port;
  const read = async (path) => { const response = await fetch(origin + path, { headers }); const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: response.status, body }; };

  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "slice-1", text: textOf(512 * 1024) }) });
  console.log("POST", accepted.status);
  let settled = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const current = await read("/api/conversations/" + id + "/state");
    if (current.status === 200 && current.body.busy === false && current.body.entries.length > 0 && current.body.entries.at(-1).role === "assistant") { settled = current; break; }
    await new Promise(r => setTimeout(r, 25));
  }
  console.log("STATE", JSON.stringify({ ids: settled?.body?.entries?.map(e => e.id), hasMore: settled?.body?.hasMore, oldest: settled?.body?.oldestEntryId }));

  // The native active range, in the runtime's own ascending order.
  const paused = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const range = await paused.harness.commit((tx) => tx.scanEntries({ conversationId: Number(id) }, 200, undefined), BACKGROUND_CONTEXT);
  console.log("ACTIVE_ASC", JSON.stringify(range.items.map(e => ({ id: String(e.id), kind: e.kind, role: e.model?.[0]?.role, contentBytes: Buffer.byteLength(JSON.stringify(e.model?.[0]?.content ?? null)) }))));
  await paused.close();

  const view = await (async () => { const h = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true }); const c = await h.harness.conversation(Number(id), BACKGROUND_CONTEXT); const v = await c.viewState(BACKGROUND_CONTEXT); await h.close(); return v; })();
  console.log("VIEW_ENTRIES", JSON.stringify((view.value?.entries ?? view.entries ?? []).map(e => ({ id: String(e.id), kind: e.kind, role: e.model?.[0]?.role, head: e.head === undefined ? undefined : String(e.head) }))));

  for (const before of ["28", "27", "26", "20"]) {
    const page = await read("/api/conversations/" + id + "/entries?before=" + before + "&tail=50");
    console.log("PAGE before=" + before, JSON.stringify({ status: page.status, ids: page.body?.entries?.map(e => e.id), hasMore: page.body?.hasMore, oldest: page.body?.oldestEntryId, reason: page.body?.reason, entryId: page.body?.entryId }));
  }
  await server.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
