/**
 * Ticket 13's control recovery matrix, as one **isolated backend process** over its own SQLite file.
 *
 * The product's real HTTP surface is the seam: this stage opens `createBackendServer` on its own loopback port, drives
 * the same routes a user's browser drives, and then kills itself with SIGKILL — no clean close, no drain, no flush — so
 * the next process reads exactly what the killed one had committed (spec D04-D09, D16, A19-A21).
 *
 * The windows are stated by the stage, not by a sleep:
 *
 * - `stop-drain`: a run is in flight (the controlled model holds its answer forever), the user's stop commits and reports
 *   `stopping`, a late report queues, and the kill lands before the ordinary scope drained. Nothing waited for the drain,
 *   so the hold, the queue and the stop receipt are the only facts that can survive.
 * - `continue-answer`: the conversation is held with one queued report; the continue commits under the caller's own
 *   request id and the kill lands before its HTTP answer is read. What has to survive is the receipt and one consumption.
 * - `newer-stop-old-continue`: a stop is draining, a second (newer) stop advances the control revision, and the kill lands
 *   after it. The older continue's retry must be refused as superseded, and the newer hold must still hold the queue.
 *
 * Each stage prints one JSON line of the facts it read at its own kill point.
 *
 * Usage: node test/acceptance-crash-backend.ts <stage> <dbPath> <base>
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, base] = process.argv;
assert.ok(dbPath !== undefined && base !== undefined, "usage: acceptance-crash-backend <stage> <db> <base>");
const token = "acceptance-crash-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

/** The controlled model: the first answer never returns while a stage holds it, which is what "a run is in flight" is. */
let holdNext = true;
const faux = fauxProvider();
const respond: FauxResponseFactory = async (): Promise<AssistantMessage> => {
  faux.setResponses([respond]);
  if (holdNext) {
    holdNext = false;
    return await new Promise<never>(() => {});
  }
  return fauxAssistantMessage("answer " + faux.state.callCount);
};
faux.setResponses([respond]);
const models = createModels();
models.setProvider(faux.provider);

// The stage composes the real backend over its own file and its own port. These windows are a conversation's own control
// and queue, so no workspace binding is needed and nothing here reaches a delegated child.
const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
const address = backend.server.address();
assert.ok(address !== null && typeof address === "object");
const origin = "http://127.0.0.1:" + address.port;

const post = (path: string, body?: unknown) => fetch(origin + path, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const getJson = async <T>(path: string): Promise<T> => {
  const response = await fetch(origin + path, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as T;
};
type Snapshot = { busy: boolean; control: { state: string; revision: number; stopSource?: string }; queuedMessages: { steering: string[]; followUp: string[] }; entries: { role: string; text: string }[] };
type ControlRead = { control: Snapshot["control"]; receipt: { requestId: string; operation: string; status: string; revision: number } | null };

const created = await post("/api/conversations", {});
assert.equal(created.status, 201, await created.clone().text());
const conversationId = (await created.json() as { conversationId: string }).conversationId;
const state = () => getJson<Snapshot>("/api/conversations/" + conversationId + "/state");
const waitFor = async (ready: (current: Snapshot) => boolean, what: string): Promise<Snapshot> => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const current = await state();
    if (ready(current)) return current;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what + ": " + JSON.stringify({ busy: current.busy, control: current.control, queued: current.queuedMessages }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A late report: the queue-only admission the composer's held path and the reporter's delivery both take. */
const queueReport = async (text: string, requestId: string): Promise<void> => {
  const response = await post("/api/conversations/" + conversationId + "/busy", { mode: "follow-up", text, requestId });
  assert.equal(response.status, 202, await response.clone().text());
};

const kill = (facts: Record<string, unknown>): never => {
  console.log(JSON.stringify({ stage, conversationId, ...facts }));
  process.kill(process.pid, "SIGKILL");
  return undefined as never;
};

await mkdir(base, { recursive: true });

if (stage === "stop-drain") {
  assert.equal((await post("/api/conversations/" + conversationId + "/messages", { protocol: "hepi.v1", type: "conversation.submit", requestId: "turn-1", text: "long run" })).status, 202);
  await waitFor((current) => current.busy, "the run to reach the provider");
  const stopped = await post("/api/conversations/" + conversationId + "/stop", { requestId: "stop-1" });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  const body = await stopped.json() as { drain: "idle" | "stopping"; control: Snapshot["control"] };
  // The window is "committed but not drained": the backend says so itself and nothing waits for the drain afterwards.
  assert.equal(body.drain, "stopping", JSON.stringify(body));
  assert.equal(body.control.state, "held");
  await queueReport("late report", "report-1");
  const queued = await state();
  assert.deepEqual(queued.queuedMessages.followUp, ["late report"]);
  kill({ drain: body.drain, control: body.control, queued: queued.queuedMessages.followUp });
} else if (stage === "continue-answer") {
  assert.equal((await post("/api/conversations/" + conversationId + "/stop", { requestId: "stop-1" })).status, 202);
  await queueReport("kept report", "report-1");
  // The continue is issued and not awaited: the kill lands while its HTTP answer is still unread, so the answer is what a
  // crash takes and the committed decision is what has to survive.
  const continuing = post("/api/conversations/" + conversationId + "/continue", { requestId: "continue-1" });
  void continuing.catch(() => undefined);
  const committed = await waitFor((current) => current.control.state === "allowed", "the resume to commit");
  const receipt = await getJson<ControlRead>("/api/conversations/" + conversationId + "/control?requestId=continue-1");
  assert.equal(receipt.control.state, "allowed");
  assert.equal(receipt.receipt?.status, "resumed");
  kill({ control: committed.control, receipt: receipt.receipt, queued: committed.queuedMessages.followUp });
} else if (stage === "newer-stop-old-continue") {
  assert.equal((await post("/api/conversations/" + conversationId + "/messages", { protocol: "hepi.v1", type: "conversation.submit", requestId: "turn-1", text: "long run" })).status, 202);
  await waitFor((current) => current.busy, "the run to reach the provider");
  assert.equal((await post("/api/conversations/" + conversationId + "/stop", { requestId: "stop-a" })).status, 202);
  await queueReport("kept report", "report-1");
  const pending = await post("/api/conversations/" + conversationId + "/continue", { requestId: "continue-a" });
  assert.equal(pending.status, 202, await pending.clone().text());
  assert.equal((await pending.json() as { status: string }).status, "stopping");
  const second = await post("/api/conversations/" + conversationId + "/stop", { requestId: "stop-b" });
  assert.equal(second.status, 202, await second.clone().text());
  const body = await second.json() as { control: Snapshot["control"] };
  assert.equal(body.control.revision, 2, JSON.stringify(body.control));
  kill({ control: body.control, queued: (await state()).queuedMessages.followUp });
} else {
  throw new Error("unknown stage " + String(stage));
}

// A stage that reached no window is a failure, not a hang; every branch above kills the process.
process.exit(1);
