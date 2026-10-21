import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { TerminalFanIn } = await createJiti(import.meta.url).import("./terminal-fan-in.ts");

/**
 * Let the reader's own loop drain what was written to the stub's stream. The fan-in's reconnect delay is the only
 * timer this file mocks, so this yields on the real event loop instead of on the clock under test.
 */
const drained = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A platform fetch that records the request the fan-in built and answers with a stream the test writes.
 *
 * The fan-in reads with `fetch`, not `EventSource`, because the App presents a device bearer and no browser API can
 * attach one to an event source. What a test therefore has to see is the request itself: its URL, its headers, its
 * credentials and its signal — plus the bytes the origin wrote, which are the same SSE frames either way.
 */
function platform(respond = () => undefined) {
  const opened = [];
  const fetch = async (url, init = {}) => {
    const answer = respond(opened.length);
    if (answer !== undefined) {
      const record = { url: String(url), headers: new Headers(init.headers), credentials: init.credentials, signal: init.signal, aborted: false, closed: false };
      init.signal?.addEventListener("abort", () => { record.aborted = true; });
      opened.push(record);
      return answer;
    }
    const record = { url: String(url), headers: new Headers(init.headers), credentials: init.credentials, signal: init.signal, aborted: false, closed: false, controller: null, encoder: new TextEncoder() };
    init.signal?.addEventListener("abort", () => { record.aborted = true; });
    opened.push(record);
    const body = new ReadableStream({
      start(controller) {
        record.controller = controller;
        record.write = (text) => controller.enqueue(record.encoder.encode(text));
        record.end = () => { if (!record.closed) { record.closed = true; controller.close(); } };
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { opened, fetch, live: () => opened.filter((record) => !record.aborted && !record.closed) };
}

/** One fan-in over the stub, with the frames and errors every subscriber was told. */
function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stub = platform(options.respond);
  const frames = [];
  const errors = [];
  const opens = [];
  const stream = new TerminalFanIn({ reconnectDelayMs: 5, fetch: stub.fetch, ...(options.credential === undefined ? {} : { credential: options.credential }), ...(options.origin === undefined ? {} : { origin: options.origin }) });
  t.after(() => { stream.close(); t.mock.timers.reset(); });
  const subscribe = (id, cwd, after) => stream.subscribe({ id, cwd, ...(after === undefined ? {} : { after }) }, {
    onFrame: (frame) => frames.push(frame),
    onOpen: () => opens.push(id),
    onError: (failure) => errors.push([id, failure.fatal]),
  });
  return { stream, stub, frames, errors, opens, subscribe };
}

/** The reconnect the fan-in scheduled: its timer is the test's, so the reopen is the next thing to run. */
const reconnect = (t) => t.mock.timers.tick(5);

test("terminal tabs share one request and reconnect with each tab's own cursor", async (t) => {
  const h = harness(t);
  h.subscribe("one", "/workspace/a");
  h.subscribe("two", "/workspace/b");
  // A tab that joins an open stream reopens it — the stream names its tabs, and one already running cannot be given
  // another — so the request that named only the first tab is released and exactly one stream is live.
  assert.equal(h.stub.live().length, 1, "two mounted tabs hold one stream");
  assert.equal(h.stub.opened[0].aborted, true);
  const first = h.stub.opened[1];
  assert.equal(first.url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|,two|%2Fworkspace%2Fb|");
  assert.equal(first.headers.get("accept"), "text/event-stream");
  assert.equal(first.credentials, "same-origin", "the Web page's cookie travels by itself");
  assert.equal(first.headers.get("authorization"), null, "a Web page is never handed a bearer to set");
  await drained();
  assert.deepEqual(h.opens, ["one", "two"], "the stream opened for every attached tab");

  // A keepalive comment carries no event, and one frame is split across two chunks: the reader frames the bytes, not
  // the transport's chunks, so neither the comment nor the split changes what a tab is told.
  first.write(":\n\n");
  first.write('id: one:120\ndata: {"type":"output","id":"one","data":"hel');
  first.write('lo","offset":120}\n\n');
  first.write('id: two:7\ndata: {"type":"output","id":"two","data":"world","offset":7}\n\n');
  await drained();
  assert.deepEqual(h.frames.map((frame) => [frame.id, frame.data]), [["one", "hello"], ["two", "world"]]);

  // The stream drops: every attached tab is told, and the reopen names what each tab has actually read.
  first.end();
  await drained();
  assert.deepEqual(h.errors, [["one", false], ["two", false]]);
  assert.equal(first.aborted, true, "the dropped stream's own request is released");
  reconnect(t);
  assert.equal(h.stub.live().length, 1);
  assert.equal(h.stub.opened.at(-1).url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|120,two|%2Fworkspace%2Fb|7");
});

test("release aborts the request, and a new widget starts from the tail rather than the old cursor", async (t) => {
  const h = harness(t);
  const first = h.subscribe("one", "/workspace/a", 120);
  const source = h.stub.opened[0];
  await drained();
  assert.equal(source.url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|120");
  await drained();
  first.release();
  assert.equal(source.aborted, true, "leaving the last tab aborts the request, so no reader outlives its reader");
  assert.equal(h.stub.live().length, 0);

  const replacement = h.subscribe("one", "/workspace/a");
  const fresh = h.stub.opened.at(-1);
  assert.match(fresh.url, /one\|%2Fworkspace%2Fa\|$/);
  await drained();
  // A frame for the tab the page already detached belongs to an attachment that is over.
  source.write('data: {"type":"output","id":"one","data":"stale","offset":125}\n\n');
  fresh.write('data: {"type":"output","id":"one","data":"fresh","offset":5}\n\n');
  await drained();
  assert.deepEqual(h.frames.map((frame) => frame.data), ["fresh"]);
  replacement.release();
  assert.equal(fresh.aborted, true);
});

test("a device bearer is one explicit header and the browser's cookie is not stated at all", async (t) => {
  const bearer = harness(t, { credential: { kind: "bearer", token: "device-secret" }, origin: "https://gateway.example" });
  bearer.subscribe("one", "/workspace/a");
  const request = bearer.stub.opened.at(-1);
  assert.equal(request.url, "https://gateway.example/api/terminal/events?tabs=one|%2Fworkspace%2Fa|");
  assert.equal(request.headers.get("authorization"), "Bearer device-secret");
  assert.equal(request.credentials, "omit", "an App has no cookie jar to send");
  assert.equal(request.headers.get("cookie"), null);
  bearer.stream.close();
});

test("a refusal is fatal and is not retried, and closing stops the stream for good", async (t) => {
  const h = harness(t, { respond: () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }) });
  const subscription = h.subscribe("one", "/workspace/a");
  await drained();
  assert.deepEqual(h.errors, [["one", true]], "the host refusing the stream is not a repair to retry");
  assert.equal(h.stub.opened.length, 1);
  assert.equal(h.stub.opened[0].headers.get("accept"), "text/event-stream");
  reconnect(t);
  assert.equal(h.stub.opened.length, 1, "a refusal is not retried");

  subscription.reconnect();
  await drained();
  assert.equal(h.stub.opened.length, 2, "an explicit reconnect is the caller's own decision");
  h.stream.close();
  reconnect(t);
  assert.equal(h.stub.opened.length, 2);
});
