
/**
 * The red/green driver for the accepted-text finding, asserted at the public HTTP seam only.
 *
 * It imports nothing from the changed source, so a red run is the **symptom** and never a missing export. Run it once
 * against the pre-fix backend (it must fail on the first assertion that matters) and once against the fixed one (it
 * must pass). Own temp directory; no repository source is written by this script.
 *
 * Usage: node --import <audit>/lib/register.mjs red-proof.mjs
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

const TOKEN = "red-proof-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const checks = [];
const check = (ok, message, detail) => { checks.push({ ok, message, detail }); console.log((ok ? "  ok   " : "  FAIL ") + message + (ok || detail === undefined ? "" : " — " + detail)); };

const PASTE_BYTES = 512 * 1024;
const textOf = (bytes, sentinel) => {
  const line = "build log line: " + "y".repeat(60) + "\n";
  const tail = "\n" + sentinel;
  let text = "";
  while (text.length + line.length + tail.length <= bytes) text += line;
  return text + "z".repeat(bytes - text.length - tail.length) + tail;
};
const SENTINEL = "RED-PROOF-SENTINEL";

const dir = await mkdtemp(join(tmpdir(), "hepi-red-proof-"));
const dbPath = join(dir, "red.sqlite");
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

  const pasted = textOf(PASTE_BYTES, SENTINEL);
  const accepted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "red-1", text: pasted }) });
  check(accepted.status === 202, "the paste is accepted with 202", "status " + accepted.status);

  // Settle by observation: not busy, and the newest entry is an assistant answer.
  let state = { status: 0, body: {} };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    state = await read("/api/conversations/" + id + "/state");
    if (state.status !== 200) break;
    if (state.body.busy === false && (state.body.entries ?? []).some(e => e.role === "assistant")) break;
    await new Promise(r => setTimeout(r, 25));
  }
  check(state.status === 200, "the state read after the paste is carried (no 413)", "status " + state.status + " " + JSON.stringify(state.body).slice(0, 160));

  const entries = state.body.entries ?? [];
  // The window (or a page) must carry the accepted message, with a bounded preview and a read block that restores it.
  let deferred = null;
  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) if (block.type === "text" && block.deferred === true && typeof block.textUrl === "string") deferred = { entry, block };
  }
  check(deferred !== null, "the frame carries the accepted message as a bounded preview naming a read block", "window ids " + JSON.stringify(entries.map(e => e.id)));
  check(JSON.stringify(state.body).includes(SENTINEL) === false, "the full text does not ride the frame");

  if (deferred !== null) {
    check(deferred.block.text.length < PASTE_BYTES, "the preview is smaller than the paste", String(deferred.block.text.length));
    const readBlock = deferred.block.textUrl.replace("/api/sessions/" + id + "/", "/api/conversations/" + id + "/");
    const served = await read(readBlock);
    check(served.status === 200, "the read block the preview names answers 200", "status " + served.status);
    check(served.body.text === pasted, "the read block restores the whole text byte for byte");
  }

  // Paging: from the window's own boundary, every page must either be carried or state the end, and must advance.
  let cursor = state.body.oldestEntryId ?? entries[0]?.id ?? null;
  let pages = 0;
  let reachedPaste = deferred !== null;
  let pagingOk = true;
  let ended = "cursor-null";
  while (cursor !== null && pages < 20) {
    const page = await read("/api/conversations/" + id + "/entries?before=" + cursor + "&tail=50");
    if (page.status !== 200) { pagingOk = false; ended = "status " + page.status + " " + JSON.stringify(page.body).slice(0, 120); break; }
    const pageEntries = page.body.entries ?? [];
    if (pageEntries.some(e => e.id === deferred?.entry.id)) reachedPaste = true;
    pages += 1;
    if (pageEntries.length === 0) {
      if (page.body.hasMore === true) { pagingOk = false; ended = "empty page with hasMore true and cursor " + String(page.body.oldestEntryId); }
      else ended = "empty page states the end";
      break;
    }
    const oldest = page.body.oldestEntryId ?? null;
    if (oldest === null || oldest === cursor) { ended = page.body.hasMore === true ? "cannot advance while hasMore true" : "terminal page"; if (page.body.hasMore === true) pagingOk = false; break; }
    cursor = oldest;
  }
  check(pagingOk, "every older page is carried and advances (no empty page claiming more)", ended);
  check(reachedPaste, "the accepted message is reachable from the window or by paging");

  await server.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
const failed = checks.filter(c => !c.ok);
console.log(failed.length === 0 ? "RED-PROOF: PASS (" + checks.length + " checks)" : "RED-PROOF: FAIL (" + failed.length + " of " + checks.length + " checks)");
process.exitCode = failed.length === 0 ? 0 : 1;
