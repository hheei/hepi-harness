
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
const TOKEN = "shape-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const dir = await mkdtemp(join(tmpdir(), "hepi-shape-"));
const dbPath = join(dir, "shape.sqlite");
try {
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, thinkingLevel: "off" } }, BACKGROUND_CONTEXT);
  const id = String(created.id);
  await harness.harness.commit(tx => tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "write it", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  await harness.close();
  const huge = "build log line: ".repeat(110_000);
  const faux = fauxProvider();
  const respond = async () => { faux.setResponses([respond]); return fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/build.log", content: huge })); };
  faux.setResponses([respond]);
  const models = createModels(); models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise(r => server.server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.server.address().port;
  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "shape-1", text: "go" }) });
  console.log("POST", accepted.status);
  await new Promise(r => setTimeout(r, 1500));
  const paused = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const range = await paused.harness.commit(tx => tx.scanEntries({ conversationId: Number(id) }, 50, undefined), BACKGROUND_CONTEXT);
  for (const e of range.items) {
    const c = e.model?.[0]?.content;
    console.log("ENTRY", String(e.id), e.kind, JSON.stringify(Array.isArray(c) ? c.map(b => ({ type: b.type, keys: Object.keys(b), size: JSON.stringify(b).length })) : typeof c));
  }
  await paused.close();
  await server.close();
} finally { await rm(dir, { recursive: true, force: true }); }
