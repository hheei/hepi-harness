/**
 * Ticket 13's shared-answer acceptance: two admitted inputs that one run consumes settle on **one** answer identity.
 *
 * The owning tickets proved each half separately — 01/02 the hold, the queue and the two admission paths, 08 the
 * per-dispatch receipts of a reused child. What the acceptance table asks for and nothing asserted end to end is the
 * fact A05 turns on: when the configured queue mode puts two inputs into the same run, both submissions name the same
 * committed answer entry, and neither is invented, split or reported as its own separate answer.
 *
 * Read through the product's own routes: the settled submission lookup by the caller's request id, the state frame's
 * own entries, and the model requests the run really made (spec D05, A05).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const TOKEN = "acceptance-shared-answer-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Submission = { submissionId: string; requestId?: string; status: string; answerId?: string };
type State = { busy: boolean; control: { state: string }; queuedMessages: { steering: string[]; followUp: string[] }; entries: { id: string; role: string; text: string }[]; submissions: Submission[] };

test("two inputs one run consumes settle on the same committed answer, and each keeps its own request id", { timeout: 60_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-acceptance-shared-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const provider = fauxProvider();
  let requests = 0;
  const respond: FauxResponseFactory = async () => {
    requests += 1;
    provider.setResponses([respond]);
    return fauxAssistantMessage("one answer for both");
  };
  provider.setResponses([respond]);
  const models = createModels();
  models.setProvider(provider.provider);
  // The queue mode is the configuration that decides whether two queued inputs share one run. It is a harness setting,
  // so this backend is started with the mode that makes the shared answer the expected shape.
  const backend = await createBackendServer({ dbPath: join(base, "hepi.sqlite"), authToken: TOKEN, models, defaultModel: SERVER_MODEL, settings: { followUpMode: "all" } });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(async () => { backend.server.closeAllConnections(); await backend.close(); });

  const post = (path: string, body?: unknown) => fetch(origin + path, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const get = async <T>(path: string): Promise<T> => {
    const response = await fetch(origin + path, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as T;
  };
  const state = (id: string) => get<State>("/api/conversations/" + id + "/state");
  const submission = async (id: string, requestId: string): Promise<Submission | null> =>
    (await get<{ submission: Submission | null }>("/api/conversations/" + id + "/submissions?requestId=" + encodeURIComponent(requestId))).submission;

  const created = await post("/api/conversations", {});
  assert.equal(created.status, 201, await created.clone().text());
  const id = ((await created.json()) as { conversationId: string }).conversationId;

  // The hold is what lets both inputs be admitted before any run exists, so the queue mode alone decides the pairing.
  const stopped = await post("/api/conversations/" + id + "/stop", { requestId: "stop-1" });
  assert.equal(stopped.status, 202, await stopped.clone().text());
  // Queued, not resumed: the queue-only admission is what a held conversation's own client uses, and it starts no turn.
  for (const [requestId, text] of [["first", "the first decision"], ["second", "the second decision"]] as const) {
    const queued = await post("/api/conversations/" + id + "/busy", { mode: "follow-up", text, requestId });
    assert.equal(queued.status, 202, await queued.clone().text());
  }
  const held = await state(id);
  assert.equal(held.control.state, "held");
  assert.deepEqual(held.queuedMessages.followUp, ["the first decision", "the second decision"], JSON.stringify(held.queuedMessages));
  assert.equal(requests, 0, "a held conversation ran nothing while both inputs queued");

  // The user's own continue is what releases them, and one run consumes both.
  assert.equal((await post("/api/conversations/" + id + "/continue", { requestId: "continue-1" })).status, 202);
  const deadline = Date.now() + 30_000;
  let settled: State | undefined;
  while (Date.now() < deadline) {
    const current = await state(id);
    if (!current.busy && current.queuedMessages.followUp.length === 0 && current.entries.some((entry) => entry.role === "assistant")) { settled = current; break; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(settled !== undefined, "the run consuming both inputs settled");
  assert.equal(requests, 1, "the two merged inputs cost exactly one model request");

  // Both submissions name the same committed answer entry, which is the shared reference A05 asks for, and each still
  // answers the request id its caller chose.
  const first = await submission(id, "first");
  const second = await submission(id, "second");
  assert.ok(first !== null && second !== null, JSON.stringify({ first, second }));
  assert.equal(first.status, "done");
  assert.equal(second.status, "done");
  assert.equal(first.answerId, second.answerId, "the merged inputs share one answer identity: " + JSON.stringify({ first, second }));
  const answer = settled.entries.find((entry) => entry.role === "assistant");
  assert.ok(answer !== undefined);
  assert.equal(first.answerId, answer.id, "and that identity is the committed answer entry, not a second record");
  assert.deepEqual(settled.entries.filter((entry) => entry.role === "user").map((entry) => entry.text), ["the first decision", "the second decision"], "each input reached the transcript once, in the order it queued");
  assert.equal(settled.entries.filter((entry) => entry.role === "assistant").length, 1, "one answer entry serves both inputs");
});
