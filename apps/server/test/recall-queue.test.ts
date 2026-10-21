import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { after, test } from "node:test";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
const token = "recall-token";
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
function headers(): HeadersInit { return { authorization: "Bearer " + token, "content-type": "application/json" }; }

/**
 * One busy conversation holding queued input, a faux provider that stays inside its first response until released, and
 * a real backend over it. The queue is observed through the same committed state snapshot a client reads.
 */
async function busyWithQueue(): Promise<{ origin: string; id: string; release: () => void; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-recall-")); directories.push(directory);
  let markEntered!: () => void;
  let releaseResponse!: () => void;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const release = new Promise<void>(resolve => { releaseResponse = resolve; });
  const faux = fauxProvider();
  faux.setResponses([async () => { markEntered(); await release; return fauxAssistantMessage("first answer"); }, fauxAssistantMessage("second answer")]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(directory, "recall.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, resolve));
  const address = backend.server.address(); assert.ok(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers: headers() })).json() as { conversationId: string };
  const id = created.conversationId;
  const submit = (text: string, whenBusy?: string) => fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text, whenBusy }) });
  assert.equal((await submit("first")).status, 202);
  await entered;
  assert.equal((await submit("steering", "steer")).status, 202);
  assert.equal((await submit("later", "followUp")).status, 202);
  return { origin, id, release: releaseResponse, close: async () => { releaseResponse(); await backend.close(); } };
}

const queued = async (origin: string, id: string) => ((await (await fetch(origin + "/api/conversations/" + id + "/state", { headers: headers() })).json()) as { queuedMessages: { steering: string[]; followUp: string[] } }).queuedMessages;

type Entry = { id: string; role: string; text: string };
type Observed = { readonly event: string; readonly window: HeldWindow<Entry> };
/** A hang guard, not a timing fact: every wait below settles on a frame the backend wrote. */
const DEADLINE_MS = 10_000;

/**
 * The conversation's own event stream, waited on by **barrier** instead of by poll: `until` resolves on the frame that
 * satisfies the predicate, folded through the shared reducer a real client uses, so a wait ends on a byte the backend
 * wrote. The bound below is a hang guard, not a duration under test, and a stream that ends before the frame fails
 * instead of hanging.
 */
async function stream(origin: string, id: string): Promise<{ until(predicate: (frame: Observed) => boolean, description: string): Promise<Observed>; close(): Promise<void> }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers: headers() });
  assert.equal(response.status, 200);
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  const frames: Observed[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  let pending = "";
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const pump = (async () => {
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const line = raw.split("\n").find((value) => value.startsWith("data: "));
        if (event === undefined || line === undefined) continue;
        const data = JSON.parse(line.slice(6));
        if (event === "snapshot" || event === "state") folder.fold(event, data);
        frames.push({ event, window: folder.current() });
        wake();
      }
    }
  })().finally(() => { ended = true; wake(); });
  return {
    until(predicate, description) {
      return new Promise<Observed>((resolve, reject) => {
        const settle = (): void => {
          const at = frames.findIndex(predicate);
          if (at >= 0) { clearTimeout(timer); waiters.delete(settle); resolve(frames.splice(at, 1)[0]!); return; }
          if (!ended) return;
          clearTimeout(timer); waiters.delete(settle);
          reject(new Error("the stream ended before " + description + "; frames: " + frames.map((frame) => frame.event).join(",")));
        };
        const timer = setTimeout(() => { waiters.delete(settle); reject(new Error("timed out waiting for " + description + "; frames: " + frames.map((frame) => frame.event).join(","))); }, DEADLINE_MS);
        waiters.add(settle);
        settle();
      });
    },
    async close() { waiters.clear(); await body.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

/**
 * The state that says the held run is over: no live run and no outstanding submission, read off the stream rather than
 * asked for by polling. The stream is opened after the release, so its baseline can never be a view from before it.
 */
const settled = (frame: Observed): boolean => !frame.window.busy && (frame.window.submissions ?? []).length === 0;
async function idle(origin: string, id: string): Promise<HeldWindow<Entry>> {
  const events = await stream(origin, id);
  try { return (await events.until(settled, "the held run to settle")).window; }
  finally { await events.close(); }
}

test("the catalogue answers a session list on its own, with no per-conversation read", { timeout: 10000 }, async (t) => {
  // The Web adapter builds the session list and the running indicator from this one response. Whatever it needs must
  // be here: a field that is missing forces the adapter to ask each conversation separately, which is the cost this
  // catalogue exists to avoid. Two conversations, one of them busy, so the fields are checked against a real mix.
  const server = await busyWithQueue();
  t.after(server.close);
  const created = await (await fetch(server.origin + "/api/conversations", { method: "POST", headers: headers() })).json() as { conversationId: string };
  const response = await fetch(server.origin + "/api/conversations", { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.json() as { conversations: { id: string; busy: boolean; revision: number; messageCount: number; firstMessage: string }[] };
  const busy = body.conversations.find(entry => entry.id === server.id);
  assert.ok(busy !== undefined, "the busy conversation is listed");
  assert.equal(busy.busy, true);
  // The preview the sidebar shows, and the revision its list version is derived from, come from the same read.
  assert.equal(busy.messageCount, 1);
  assert.equal(busy.firstMessage, "first");
  assert.equal(typeof busy.revision, "number");
  const idle = body.conversations.find(entry => entry.id === created.conversationId);
  assert.ok(idle !== undefined);
  assert.equal(idle.busy, false);
});

test("a queued input can be recalled, which removes it without running it", { timeout: 10000 }, async (t) => {
  const server = await busyWithQueue();
  t.after(server.close);
  assert.deepEqual(await queued(server.origin, server.id), { steering: ["steering"], followUp: ["later"] });

  const recalled = await fetch(server.origin + "/api/conversations/" + server.id + "/recall-queue", { method: "POST", headers: headers() });
  assert.equal(recalled.status, 200);
  // The text comes back so the composer can put it in front of the user again, in queue order.
  assert.deepEqual(await recalled.json(), { protocol: "hepi.v1", steering: ["steering"], followUp: ["later"] });

  // Recalling is not sending: the queue is empty and nothing was added to the transcript. The run in flight is
  // untouched, so it still answers the submission that started it.
  assert.deepEqual(await queued(server.origin, server.id), { steering: [], followUp: [] });
  server.release();
  const entries = (await idle(server.origin, server.id)).entries;
  assert.deepEqual(entries.filter(entry => entry.role === "user").map(entry => entry.text), ["first"]);
  assert.deepEqual(await queued(server.origin, server.id), { steering: [], followUp: [] });
});

test("recalling an empty queue is an empty recall, not a failure", { timeout: 10000 }, async (t) => {
  const server = await busyWithQueue();
  t.after(server.close);
  assert.equal((await fetch(server.origin + "/api/conversations/" + server.id + "/recall-queue", { method: "POST", headers: headers() })).status, 200);
  const second = await fetch(server.origin + "/api/conversations/" + server.id + "/recall-queue", { method: "POST", headers: headers() });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { protocol: "hepi.v1", steering: [], followUp: [] });
});

test("a recalled input is not delivered when the run settles", { timeout: 10000 }, async (t) => {
  const server = await busyWithQueue();
  t.after(server.close);
  await fetch(server.origin + "/api/conversations/" + server.id + "/recall-queue", { method: "POST", headers: headers() });
  // The boundary that would have placed the queued steers and follow-ups now has nothing to place.
  server.release();
  const settledRun = await idle(server.origin, server.id);
  assert.deepEqual(settledRun.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["first"]);
});
