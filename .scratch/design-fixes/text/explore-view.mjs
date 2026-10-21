
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

const TOKEN = "view-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const dir = await mkdtemp(join(tmpdir(), "hepi-view-"));
const dbPath = join(dir, "view.sqlite");
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
  const view = await (async () => { const c = await harness.harness.conversation(Number(id), BACKGROUND_CONTEXT); const v = await c.viewState(BACKGROUND_CONTEXT); return v; })();
  console.log("VIEW_ENTRIES_BEFORE", JSON.stringify((view.value?.entries ?? view.entries ?? []).map(e => String(e.id))));
  await harness.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
