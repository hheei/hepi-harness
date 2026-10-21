import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer } from "../src/server.ts";

/**
 * The conversation event stream's idle keepalive, asserted at the wire the backend itself writes.
 *
 * A quiet conversation publishes nothing, and a transport that bounds an idle body tears the connection down and
 * makes the browser reconnect and re-baseline. The backend answers that with a comment frame — an SSE line that
 * carries no event — on a fixed cadence, which is the only thing that keeps an idle stream alive without inventing a
 * lifecycle fact the client would have to interpret.
 *
 * The cadence is shortened through the server's own option, so the bound under test is reached in milliseconds. Every
 * wait below is a **barrier**: it settles on the frame the server wrote, and its deadline exists only so a frame that
 * never arrives fails instead of hanging. A faked global clock is deliberately not used — the keepalive interval and
 * the socket reader run in this same process, so moving the clock would move the server's timer and undici's timers
 * together and the test would observe its own clock instead of the bytes on the wire.
 *
 * What the lifetime test does instead is narrower: it captures the **one** interval scheduled at the keepalive cadence
 * and drives its callback itself, leaving every other timer in the process alone. That makes "the heartbeat wrote" and
 * "the heartbeat was cleared" facts the test can observe directly, at the moment they happen, rather than inferences
 * from elapsed time.
 */

const token = "heartbeat-token";
const HEARTBEAT_MS = 40;
/** How long a frame that must arrive is waited for before the test calls it absent: a hang guard, not a timing fact. */
const DEADLINE_MS = 5_000;
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function start(t: TestContext): Promise<{ backend: BackendServer; origin: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-heartbeat-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "server.sqlite"), authToken: token, heartbeatIntervalMs: HEARTBEAT_MS });
  await new Promise<void>((resolve) => backend.server.listen(0, resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port };
}

function headers(): HeadersInit { return { authorization: "Bearer " + token, "content-type": "application/json" }; }

/** One interval the server scheduled at the keepalive cadence, captured instead of left to fire on its own. */
type Captured = {
  /** The callback the server would have run on each tick. Calling it is that tick. */
  fire(): void;
  /** Whether the server called `unref` on the handle it was given, so an idle stream cannot hold the process open. */
  readonly unrefd: boolean;
  /** Resolves once the server clears this interval — the end of the keepalive's lifetime, not a guess about it. */
  readonly cleared: Promise<void>;
};

/**
 * Capture the keepalive interval, and only it.
 *
 * The seam is the global the production code already calls: `setInterval` at the keepalive cadence is recorded and
 * given a handle whose lifetime the test can see, while every other interval in this process — the harness's own
 * background work included — is scheduled for real and never touched. Production keeps calling `setInterval`,
 * `unref` and `clearInterval` exactly as it does without a test.
 */
function captureKeepalive(t: TestContext): { intervals: Captured[]; restore(): void } {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervals: Captured[] = [];
  const owners = new Map<object, () => void>();
  globalThis.setInterval = ((callback: () => void, intervalMs?: number, ...args: unknown[]) => {
    if (Number(intervalMs) !== HEARTBEAT_MS) return (realSetInterval as (...a: unknown[]) => unknown)(callback, intervalMs, ...args);
    let cleared: () => void = () => {};
    const clearedPromise = new Promise<void>((resolve) => { cleared = resolve; });
    const record = { unrefd: false };
    const handle = { unref: () => { record.unrefd = true; }, ref: () => {} };
    owners.set(handle, cleared);
    intervals.push({ fire: () => callback(), get unrefd() { return record.unrefd; }, cleared: clearedPromise });
    return handle;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: unknown) => {
    const cleared = typeof handle === "object" && handle !== null ? owners.get(handle) : undefined;
    if (cleared === undefined) return (realClearInterval as (h: unknown) => void)(handle);
    owners.delete(handle as object);
    cleared();
  }) as unknown as typeof clearInterval;
  const restore = (): void => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; };
  t.after(restore);
  return { intervals, restore };
}

/** Fail instead of hanging when an event that must happen never does. A guard on the wait, never a duration under test. */
function within<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + description)), DEADLINE_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers: headers(), body: JSON.stringify({}) });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

/** One SSE frame as the reader received it, reassembled across chunk boundaries by the frame separator. */
type Reader = {
  /** The frames received so far, in order. A comment frame is exactly `":"`. */
  frames(): string[];
  /** Resolves with the frames once the predicate holds, or fails at the deadline. */
  until(predicate: (frames: string[]) => boolean, description: string): Promise<string[]>;
  /** Resolves once the stream has ended and the last bytes it carried are parsed. */
  settled(): Promise<void>;
  cancel(): Promise<void>;
};

function reader(response: Response): Reader {
  const frames: string[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const pump = (async () => {
    while (true) {
      const chunk = await stream.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        frames.push(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
      }
      wake();
    }
  })().finally(() => { ended = true; wake(); });
  return {
    frames: () => [...frames],
    // The predicate is re-checked on every parsed frame, so the wait ends on the frame that satisfies it and not at
    // the next tick of a sleep loop. The stream ending is a failure here: it means the frame never came.
    until(predicate, description) {
      if (predicate(frames)) return Promise.resolve([...frames]);
      return new Promise<string[]>((resolve, reject) => {
        const settle = (): void => {
          if (!ended && !predicate(frames)) return;
          clearTimeout(timer); waiters.delete(settle);
          if (ended && !predicate(frames)) reject(new Error("the stream ended before " + description + "; frames: " + JSON.stringify(frames)));
          else resolve([...frames]);
        };
        const timer = setTimeout(() => { waiters.delete(settle); reject(new Error("timed out waiting for " + description + "; frames: " + JSON.stringify(frames))); }, DEADLINE_MS);
        waiters.add(settle);
      });
    },
    settled: () => pump,
    async cancel() { waiters.clear(); await stream.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

test("a quiet conversation stream receives comment frames and stays attached", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/events", { headers: headers() });
  assert.equal(response.status, 200);
  const events = reader(response);
  try {
    const frames = await events.until((current) => current.filter(frame => frame === ":").length >= 2, "two comment frames on a stream with nothing to publish");
    assert.equal(frames[0].startsWith("event: snapshot"), true, "the baseline snapshot is still the first frame");
    // One source, never a reconnect: the baseline is published once, so a second one would mean the client was made to
    // re-baseline because the transport dropped an idle stream.
    assert.equal(frames.filter(frame => frame.startsWith("event: snapshot")).length, 1, "the stream was re-baselined while it was still attached");
  } finally {
    await events.cancel();
  }
});

test("a comment frame carries no event and is never folded into a data frame", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/events", { headers: headers() });
  const events = reader(response);
  try {
    const frames = await events.until((current) => current.includes(":"), "a comment frame");
    for (const frame of frames) {
      if (frame === ":") continue;
      assert.equal(frame.includes("\n:"), false, "a comment line was written inside a data frame: " + JSON.stringify(frame));
      assert.match(frame, /^event: [a-z_]+\ndata: /, "every non-comment frame is one complete event frame: " + JSON.stringify(frame));
    }
  } finally {
    await events.cancel();
  }
});

test("the keepalive writes on its tick, then stops with the connection and leaves the server serving", async (t) => {
  const capture = captureKeepalive(t);
  const server = await start(t);
  const id = await createConversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/events", { headers: headers() });
  const events = reader(response);
  try {
    // The baseline is the server's own write, so it arrives whether or not a keepalive tick ever happens. That makes it
    // the barrier that says the stream is attached, and only then is the keepalive's lifetime meaningful.
    await events.until((current) => current.some(frame => frame.startsWith("event: snapshot")), "the baseline snapshot");
    // Exactly one interval runs at this cadence, and it belongs to this attached client. The others in this process
    // were scheduled for real, so the count is the keepalive's own lifetime and nothing else's.
    assert.equal(capture.intervals.length, 1, "one attached client scheduled one keepalive");
    const [keepalive] = capture.intervals as [Captured];
    assert.equal(keepalive.unrefd, true, "an idle stream does not hold the process open by itself");
    assert.equal(events.frames().includes(":"), false, "the keepalive has not written yet: its tick is the test's to drive");

    // The tick is driven here, so "the heartbeat writes" is observed on the connection rather than inferred from a
    // clock: the captured callback runs, and the comment frame it wrote is the next thing the reader parses.
    keepalive.fire();
    const fired = await events.until((current) => current.includes(":"), "the frame the heartbeat tick wrote");
    assert.equal(fired.filter(frame => frame === ":").length, 1, "one tick wrote one comment frame");

    await events.cancel();
    await events.settled();
    // Reader settlement is the close boundary: the server has observed the dropped stream, so it must have cleared the
    // interval it scheduled. That is the assertion the elapsed-time version could only guess at — the lifetime ends
    // here, on the server's own `clearInterval`, not on a wait long enough to make a stale timer unlikely.
    await within(keepalive.cleared, "the keepalive interval to be cleared when the connection dropped");
  } finally {
    await events.cancel();
  }
  // The server outlived the dropped stream, and its next attach is served a baseline like any other.
  const state = await fetch(server.origin + "/api/conversations/" + id + "/state", { headers: headers() });
  assert.equal(state.status, 200);
});
