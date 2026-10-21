import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { AgentEventSubscription } from "@hepi/session/browser";
import type { AgentMessage } from "./types.ts";
import type { AgentEventLike } from "./agent-event-wire.ts";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { ConversationSession } = await jiti.import<typeof import("./conversation-session.ts")>("./conversation-session.ts");
const { ConversationRefusal } = await jiti.import<typeof import("./conversation-api.ts")>("./conversation-api.ts");

/** One reader the fake source handed out, as the cases drive it and read what it did. */
type Reader = { conversationId: string; listener: (event: AgentEventLike) => void; released: boolean; reconnects: number };

/**
 * A fake ordinary `ConversationApi`: the operations this session performs, and nothing else. It is the same contract the
 * connection's real API implements, so a case states what the Backend answers rather than how the session calls it.
 */
function fakeApi(t: { after(fn: () => void): void }, answer: {
  read?: (conversationId: string) => Promise<unknown>;
  send?: (options: { requestId: string; text: string; queueOnly?: boolean; whenBusy?: string; images?: unknown }) => unknown;
  submission?: (requestId: string) => Promise<unknown>;
  reload?: () => Promise<unknown>;
} = {}) {
  const calls: { read: string[]; send: unknown[]; submission: string[]; reload: string[] } = { read: [], send: [], submission: [], reload: [] };
  const api = {
    read: async (conversationId: string) => { calls.read.push(conversationId); return (answer.read?.(conversationId) ?? Promise.resolve({ conversationId })) as never; },
    reload: async (conversationId: string) => { calls.reload.push(conversationId); return (await answer.reload?.() ?? {}) as never; },
    submission: async (conversationId: string, requestId: string) => { calls.submission.push(requestId); return (await answer.submission?.(requestId) ?? null) as never; },
    control: () => ({
      send: async (requestId: string, text: string, options?: { queueOnly?: boolean; whenBusy?: "steer" | "followUp"; images?: unknown }) => {
        calls.send.push({ requestId, text, ...(options ?? {}) });
        return answer.send?.({ requestId, text, ...(options ?? {}) }) as never;
      },
    }),
  };
  void t;
  return { api: api as unknown as ConstructorParameters<typeof ConversationSession>[0]["api"], calls };
}

/** One shell source per conversation, as the page states it: a reader joins the conversation's single source. */
function fakeSource() {
  const readers: Reader[] = [];
  const subscribe = (conversationId: string, listener: (event: AgentEventLike) => void): AgentEventSubscription<AgentMessage> => {
    const reader: Reader = { conversationId, listener, released: false, reconnects: 0 };
    readers.push(reader);
    return {
      ready: async () => {},
      reconnect: () => { reader.reconnects += 1; },
      release: () => { reader.released = true; },
      continuity: () => null,
    };
  };
  return { readers, subscribe, open: () => readers.filter((reader) => !reader.released) };
}

test("a join is idempotent per conversation and leaving hands the reader back", (t) => {
  const { api } = fakeApi(t);
  const source = fakeSource();
  const session = new ConversationSession({ api, subscribe: source.subscribe });
  const listener = () => {};

  const first = session.join("conv", listener);
  assert.equal(source.readers.length, 1, "the first join opens one reader");
  assert.equal(first.continuity, null, "a first reader continues from nothing");
  session.join("conv", listener);
  assert.equal(source.readers.length, 1, "a join for the conversation already joined is a no-op");
  assert.equal(session.isJoined("conv"), true);

  // A join for another conversation leaves the first: this surface reads one conversation at a time.
  session.join("other", listener);
  assert.equal(source.readers[0].released, true, "the conversation left keeps its stream only through the shell");
  assert.deepEqual(source.open().map((reader) => reader.conversationId), ["other"]);
  assert.equal(session.isJoined("conv"), false);

  session.release();
  assert.equal(source.open().length, 0, "releasing withdraws this reader's interest");
  session.release();
  assert.equal(source.open().length, 0, "a repeated release changes nothing");
});

test("a reconnect belongs to the conversation this surface is on", (t) => {
  const { api } = fakeApi(t);
  const source = fakeSource();
  const session = new ConversationSession({ api, subscribe: source.subscribe });
  session.join("conv", () => {});
  session.reconnect("other");
  assert.equal(source.readers[0].reconnects, 0, "another conversation's stream is not this surface's to reset");
  session.reconnect("conv");
  assert.equal(source.readers[0].reconnects, 1);
});

test("concurrent reads of one conversation are one request, and a forced read shares nothing", async (t) => {
  let release!: (value: unknown) => void;
  const held = new Promise<unknown>((resolve) => { release = resolve; });
  let reads = 0;
  const { api, calls } = fakeApi(t, { read: () => { reads += 1; return held; } });
  const session = new ConversationSession({ api });

  const a = session.read("conv");
  const b = session.read("conv");
  assert.equal(reads, 1, "a mount, a stream settle and a reconcile asking at once send one read");
  const forced = session.read("conv", { force: true });
  assert.equal(reads, 2, "a Retry does not take the answer it is recovering from");
  release({ conversationId: "conv" });
  assert.deepEqual(await a, { conversationId: "conv" });
  assert.deepEqual(await b, { conversationId: "conv" });
  assert.deepEqual(await forced, { conversationId: "conv" });
  assert.deepEqual(calls.read, ["conv", "conv"], "and the next read is a fresh request");
  await session.read("conv");
  assert.equal(reads, 3);
});

test("one admission path carries the queue options and never invents a resend", async (t) => {
  const refusals: unknown[] = [];
  const { api, calls } = fakeApi(t, {
    send: (options) => options.requestId === "refused"
      ? { ok: false, kind: "refused", status: 400, code: "prompt_rejected", message: "bad image" }
      : { ok: true, value: { submissionId: "s-" + options.requestId } },
  });
  const session = new ConversationSession({ api });

  assert.deepEqual(await session.send("conv", { requestId: "r1", text: "hello", images: [{ type: "image", data: "AQID", mimeType: "image/png" }] }), { submissionId: "s-r1" });
  assert.deepEqual(calls.send, [{ requestId: "r1", text: "hello", images: [{ type: "image", data: "AQID", mimeType: "image/png" }] }]);

  // A queued steer is the same admission with the queue options, so no send path reaches the wire by a route of its own.
  await session.send("conv", { requestId: "r2", text: "steer", queueOnly: true, whenBusy: "steer" });
  assert.deepEqual(calls.send[1], { requestId: "r2", text: "steer", queueOnly: true, whenBusy: "steer" });

  await assert.rejects(session.send("conv", { requestId: "refused", text: "no" }), (error: unknown) => {
    refusals.push(error);
    return error instanceof ConversationRefusal && error.code === "prompt_rejected";
  });
  assert.equal(calls.send.length, 3, "a refusal is thrown as stated and nothing is sent again");
});

test("an unknown outcome is resolved by lookup and a reload is the Backend's own operation", async (t) => {
  const { api, calls } = fakeApi(t, {
    submission: async (requestId) => ({ protocol: "hepi.v1", conversationId: "conv", requestId, submissionId: "s1", type: "input", status: "done", entryId: "e2", answerId: "a1" }),
    reload: async () => ({ resources: { skills: 2, prompts: 1 } }),
  });
  const session = new ConversationSession({ api });
  const record = await session.lookup("conv", "r1");
  assert.equal(record?.answerId, "a1", "the durable record is what the fold repairs the turn from");
  assert.deepEqual(calls.submission, ["r1"], "the lookup is by request identity, once");
  assert.deepEqual(calls.send, [], "and nothing is admitted");

  assert.deepEqual(await session.reload("conv"), { resources: { skills: 2, prompts: 1 } });
  assert.deepEqual(calls.reload, ["conv"]);
});

test("disposing releases the reader and forgets the reads it was sharing, so a replay joins again", async (t) => {
  const { api } = fakeApi(t);
  const source = fakeSource();
  const session = new ConversationSession({ api, subscribe: source.subscribe });
  session.join("conv", () => {});
  await session.read("conv");
  session.dispose();
  assert.equal(source.readers[0].released, true, "the stream reader is the surface's own interest and is given back");
  assert.equal(session.isJoined("conv"), false);

  // React's setup/cleanup replay is a mount of the same surface: it joins again rather than being answered by the
  // lifetime that ended, and it opens no second reader of its own beside the shell's.
  session.join("conv", () => {});
  assert.equal(source.open().length, 1);
  assert.equal(source.readers.length, 2, "the replay is a new reader of the shell's one source");
});

test("a host that states no source joins nothing instead of failing", (t) => {
  const { api } = fakeApi(t);
  const session = new ConversationSession({ api });
  const join = session.join("conv", () => {});
  assert.equal(join.continuity, null);
  assert.equal(session.isJoined("conv"), false);
  session.release();
  session.reconnect("conv");
});
