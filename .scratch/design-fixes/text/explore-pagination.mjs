
/**
 * Exploration: the exact read-surface shapes around a large accepted text entry, and around a raw-only suffix.
 * Scratch probe (my own): no repo source touched. Run with the audit resolve hook.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SystemEntry, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { SERVER_MODEL, fauxModels } from "../../../apps/server/test/faux-fixture.ts";

const TOKEN = "explore-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const textOf = (bytes) => { let text = ""; while (text.length < bytes) text += "log line: " + "y".repeat(60) + "\n"; return text.slice(0, bytes); };

const dir = await mkdtemp(join(tmpdir(), "hepi-explore-"));
const dbPath = join(dir, "explore.sqlite");
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

  const read = async (path) => {
    const response = await fetch(origin + path, { headers });
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    return { status: response.status, bytes: Buffer.byteLength(text), body };
  };
  const brief = (b) => b === undefined || b === null ? b : { status: b.status, entries: Array.isArray(b.body?.entries) ? b.body.entries.map(e => ({ id: e.id, role: e.role, textLength: e.text?.length, msgBytes: JSON.stringify(e.message ?? null).length, contentTypes: Array.isArray(e.message?.content) ? e.message.content.map(c => c.type) : typeof e.message?.content })) : b.body?.entries, hasMore: b.body?.hasMore, oldestEntryId: b.body?.oldestEntryId, reason: b.body?.reason, entryId: b.body?.entryId, bytes: b.body?.bytes };

  const baseline = await read("/api/conversations/" + id + "/state");
  console.log("BASELINE", JSON.stringify(brief(baseline)));

  // A real accepted 0.5 MiB paste.
  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "explore-1", text: textOf(512 * 1024) }) });
  console.log("POST status", accepted.status, "bytes", Buffer.byteLength(await accepted.text()));
  // Settle by observation: busy false and the newest entry advanced.
  const deadline = Date.now() + 20_000;
  let settled = null;
  while (Date.now() < deadline) {
    const current = await read("/api/conversations/" + id + "/state");
    if (current.status === 200 && current.body.busy === false && current.body.entries.length > 0 && current.body.entries.at(-1).role === "assistant") { settled = current; break; }
    if (current.status !== 200) { settled = current; break; }
    await new Promise(r => setTimeout(r, 25));
  }
  console.log("AFTER SETTLE", JSON.stringify(brief(settled)));
  const cursor = settled?.body?.oldestEntryId ?? null;
  console.log("CURSOR", cursor);
  if (cursor !== null) {
    const page1 = await read("/api/conversations/" + id + "/entries?before=" + cursor + "&tail=50");
    console.log("PAGE before=" + cursor, JSON.stringify(brief(page1)));
    const next = page1.body?.oldestEntryId;
    if (next) {
      const page2 = await read("/api/conversations/" + id + "/entries?before=" + next + "&tail=50");
      console.log("PAGE before=" + next, JSON.stringify(brief(page2)));
    }
  }
  // By-id read of the large entry, if it can be found.
  const active = await read("/api/conversations/" + id + "/state");
  console.log("STATE ENTRIES IDS", JSON.stringify(active.body?.entries?.map(e => e.id)));
  await server.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
