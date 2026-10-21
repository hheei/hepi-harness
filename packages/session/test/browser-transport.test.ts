import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentEventConnection,
  bearerSource,
  conversationSource,
  type AgentEventSourceLike,
} from "../src/browser.ts";

/** One recorded request: the URL, the headers it carried and whether the browser was to attach its own cookie. */
type Opened = { url: string; headers: Record<string, string>; credentials?: RequestCredentials };

/**
 * A stand-in `fetch` that answers with a stream and records the request, so the two ways in are asserted on the wire
 * they actually produce rather than on a browser API neither of them uses.
 */
function stubFetch(t: test.TestContext, frames: readonly string[], opened: Opened[]) {
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { headers: Record<string, string>; credentials?: RequestCredentials }) => {
    opened.push({ url, headers: init.headers, credentials: init.credentials });
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)); controller.close(); },
      }),
    };
  };
  t.after(() => {
    if (previous === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = previous;
  });
}

/** Wait for the reader's own loop to drain the stub's stream. */
const drained = () => new Promise(resolve => setImmediate(resolve));

test("the Web source is a same-origin conversation URL that carries no credential of its own", async (t) => {
  const opened: Opened[] = [];
  stubFetch(t, [], opened);
  const source = conversationSource()("a b/c");
  await drained();
  conversationSource("/api/conversations")("plain");
  await drained();
  source.close();
  assert.deepEqual(opened, [
    // The cookie is the browser's own and travels by itself, which is why nothing is stated here: a Web page must not
    // be handed the backend's token to set a header with. The path is the Backend's own conversation route, which is
    // what the ingress forwards.
    { url: "/api/conversations/a%20b%2Fc/events", headers: {}, credentials: "same-origin" },
    { url: "/api/conversations/plain/events", headers: {}, credentials: "same-origin" },
  ], "the source is the page's own origin path, percent-encoded, with nothing attached");
});

test("the stream reader speaks the backend's own frame names to the connection", async (t) => {
  const opened: Opened[] = [];
  const frames = [
    ":\n\n",
    `event: snapshot\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", revision: 2 })}\n\n`,
    `event: state\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", revision: 3, baseRevision: 2, appended: [] })}\n\n`,
    `event: submission\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", type: "input", status: "placed" })}\n\n`,
    `event: resync_required\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", revision: 9 })}\n\n`,
    `event: state_oversize\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", revision: 9, reason: "frame_too_large", entryId: "77", bytes: 12 })}\n\n`,
  ];
  stubFetch(t, frames, opened);
  const source = bearerSource("http://backend.test", "secret")("conv/1");
  const heard: { type: string; event?: string }[] = [];
  source.onmessage = event => heard.push(JSON.parse(event.data) as { type: string; event?: string });
  await drained();
  assert.deepEqual(opened, [{
    url: "http://backend.test/api/conversations/conv%2F1/events",
    headers: { authorization: "Bearer secret" },
    credentials: "same-origin",
  }], "the diagnostic page reaches the backend directly and is the one place a bearer token is used");
  assert.deepEqual(heard, [
    // The handshake the connection waits for is the baseline frame: it is what says the attachment is up.
    { type: "connected", sessionId: "conv/1" },
    { type: "frame", sessionId: "conv/1", event: "snapshot", data: { protocol: "hepi.v1", conversationId: "conv", revision: 2 } },
    { type: "frame", sessionId: "conv/1", event: "state", data: { protocol: "hepi.v1", conversationId: "conv", revision: 3, baseRevision: 2, appended: [] } },
    { type: "submission", sessionId: "conv/1", submission: { protocol: "hepi.v1", conversationId: "conv", submissionId: "s1", type: "input", status: "placed" } },
    { type: "resync", sessionId: "conv/1" },
    { type: "oversize", sessionId: "conv/1", reason: "frame_too_large", entryId: "77", bytes: 12, revision: 9 },
  ], "the keepalive comment is skipped and every other frame reaches the connection under the name the backend gave it");
});

test("a source hands its frames to the shared connection and releases with its last reader", async (t) => {
  const opened: Opened[] = [];
  let aborted = false;
  const previous = (globalThis as { fetch?: unknown }).fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string, init: { signal: AbortSignal }) => {
    init.signal.addEventListener("abort", () => { aborted = true; });
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          // The stream stays open, as a real attached conversation's does: only the release ends it.
          controller.enqueue(new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify({ protocol: "hepi.v1", conversationId: "conv", revision: 1 })}\n\n`));
        },
      }),
    };
  };
  t.after(() => {
    if (previous === undefined) delete (globalThis as { fetch?: unknown }).fetch;
    else (globalThis as { fetch?: unknown }).fetch = previous;
  });
  const connection = new AgentEventConnection({
    createSource: bearerSource("http://backend.test", "secret") as (conversationId: string) => AgentEventSourceLike,
    readinessTimeoutMs: 1000, reconnectDelayMs: 1000,
  });
  t.after(() => connection.close());
  const heard: string[] = [];
  const subscription = connection.subscribe("conv", event => heard.push(event.type));
  await drained();
  assert.equal(aborted, false);
  subscription.release();
  assert.deepEqual(heard, ["connected", "frame"]);
  assert.equal(aborted, true, "the last reader leaving aborts the request, so no reader outlives its reader");
});
