import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { FanInFrame, FanInSubscription } from "./terminal-fan-in.ts";
import type { TerminalConnection } from "./terminal-client.ts";

const { TerminalFanIn } = await createJiti(import.meta.url).import<typeof import("./terminal-fan-in.ts")>("./terminal-fan-in.ts");

/**
 * Let the reader's own loop drain what was written to the stub's stream. The fan-in's reconnect delay is the only
 * timer this file mocks, so this yields on the real event loop instead of on the clock under test.
 */
const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One request the fan-in opened: what it asked for, and — for a streamed answer — the levers a case writes with. */
type OpenedRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials | undefined;
  readonly signal: AbortSignal | null | undefined;
  /** True once the fan-in released this request, whichever way it ended. */
  aborted: boolean;
  /** True once the body a case writes was closed by `end()`. */
  closed: boolean;
  /** Write one SSE chunk into the body this request answers with. */
  write(text: string): void;
  /** End the body, as an origin that closed the stream would. */
  end(): void;
};

/** The platform a case stands in for: its fetch, the requests it opened, and which of them are still live. */
type Platform = {
  readonly opened: OpenedRequest[];
  readonly fetch: typeof fetch;
  /** The requests neither aborted nor closed: what the fan-in is actually holding open. */
  readonly live: () => OpenedRequest[];
};

/** The answer one request gets: a Response to return, or nothing to be given a stream this test writes. */
type Respond = (index: number) => Response | undefined;

/**
 * A platform fetch that records the request the fan-in built and answers with a stream the test writes.
 *
 * The fan-in reads with fetch, not EventSource, because the App presents a device bearer and no browser API can
 * attach one to an event source. What a test therefore has to see is the request itself: its URL, its headers, its
 * credentials and its signal — plus the bytes the origin wrote, which are the same SSE frames either way.
 */
function platform(respond: Respond = () => undefined): Platform {
  const opened: OpenedRequest[] = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const answer = respond(opened.length);
    const signal = init?.signal;
    const record: OpenedRequest = {
      url: String(input), headers: new Headers(init?.headers), credentials: init?.credentials, signal,
      aborted: false, closed: false,
      write: () => { throw new Error("this answer has no body this case writes"); },
      end: () => { throw new Error("this answer has no body this case writes"); },
    };
    signal?.addEventListener("abort", () => { record.aborted = true; });
    opened.push(record);
    if (answer !== undefined) return answer;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        record.write = (text) => { controller.enqueue(encoder.encode(text)); };
        record.end = () => { if (!record.closed) { record.closed = true; controller.close(); } };
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { opened, fetch: fetchStub as typeof fetch, live: () => opened.filter((record) => !record.aborted && !record.closed) };
}

/** What a case states about the connection its fan-in is handed. */
type HarnessOptions = {
  readonly respond?: Respond;
  readonly credential?: TerminalConnection["credential"];
  readonly origin?: string;
};

/** What a case drives: the fan-in, the platform under it, and everything its subscribers were told. */
type Harness = {
  readonly stream: InstanceType<typeof TerminalFanIn>;
  readonly stub: Platform;
  /** Every frame any subscriber was handed, in arrival order. */
  readonly frames: FanInFrame[];
  /** Every error any subscriber was handed: the tab it was about, and whether it is fatal. */
  readonly errors: (readonly [id: string, fatal: boolean])[];
  /** Every tab whose stream opened, in arrival order. */
  readonly opens: string[];
  readonly subscribe: (id: string, cwd: string, after?: number) => FanInSubscription;
};

function harness(t: test.TestContext, options: HarnessOptions = {}): Harness {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stub = platform(options.respond);
  const frames: FanInFrame[] = [];
  const errors: (readonly [id: string, fatal: boolean])[] = [];
  const opens: string[] = [];
  const stream = new TerminalFanIn({
    reconnectDelayMs: 5, fetch: stub.fetch,
    ...(options.credential === undefined ? {} : { credential: options.credential }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  });
  t.after(() => { stream.close(); t.mock.timers.reset(); });
  const subscribe = (id: string, cwd: string, after?: number): FanInSubscription => stream.subscribe(
    { id, cwd, ...(after === undefined ? {} : { after }) },
    {
      onFrame: (frame) => { frames.push(frame); },
      onOpen: () => { opens.push(id); },
      onError: (failure) => { errors.push([id, failure.fatal]); },
    },
  );
  return { stream, stub, frames, errors, opens, subscribe };
}

/** The reconnect the fan-in scheduled: its timer is the test's, so the reopen is the next thing to run. */
const reconnect = (t: test.TestContext): void => { t.mock.timers.tick(5); };

/** One request a case reached for: the fan-in always opened it, so its absence is the failure. */
function openedAt(platformUnder: Platform, index: number): OpenedRequest {
  const request = platformUnder.opened[index];
  assert.ok(request, "the fan-in opened the request at " + index);
  return request;
}

/** The output frames a case was handed, as the tab each was about and the bytes it carried. */
function outputs(frames: readonly FanInFrame[]): (readonly [id: string, data: string])[] {
  return frames.map((frame) => frame.type === "output" ? [frame.id, frame.data] as const : null)
    .filter((frame): frame is readonly [string, string] => frame !== null);
}

/** The most recent request the fan-in opened. */
function lastOpened(platformUnder: Platform): OpenedRequest {
  const request = platformUnder.opened.at(-1);
  assert.ok(request, "the fan-in opened a request");
  return request;
}

test("terminal tabs share one request and reconnect with each tab's own cursor", async (t) => {
  const h = harness(t);
  h.subscribe("one", "/workspace/a");
  h.subscribe("two", "/workspace/b");
  // A tab that joins an open stream reopens it — the stream names its tabs, and one already running cannot be given
  // another — so the request that named only the first tab is released and exactly one stream is live.
  assert.equal(h.stub.live().length, 1, "two mounted tabs hold one stream");
  assert.equal(openedAt(h.stub, 0).aborted, true);
  const first = openedAt(h.stub, 1);
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
  assert.deepEqual(outputs(h.frames), [["one", "hello"], ["two", "world"]]);

  // The stream drops: every attached tab is told, and the reopen names what each tab has actually read.
  first.end();
  await drained();
  assert.deepEqual(h.errors, [["one", false], ["two", false]]);
  assert.equal(first.aborted, true, "the dropped stream's own request is released");
  reconnect(t);
  assert.equal(h.stub.live().length, 1);
  assert.equal(lastOpened(h.stub).url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|120,two|%2Fworkspace%2Fb|7");
});

test("release aborts the request, and a new widget starts from the tail rather than the old cursor", async (t) => {
  const h = harness(t);
  const first = h.subscribe("one", "/workspace/a", 120);
  const source = openedAt(h.stub, 0);
  await drained();
  assert.equal(source.url, "/api/terminal/events?tabs=one|%2Fworkspace%2Fa|120");
  await drained();
  first.release();
  assert.equal(source.aborted, true, "leaving the last tab aborts the request, so no reader outlives its reader");
  assert.equal(h.stub.live().length, 0);

  const replacement = h.subscribe("one", "/workspace/a");
  const fresh = lastOpened(h.stub);
  assert.match(fresh.url, /one\|%2Fworkspace%2Fa\|$/);
  await drained();
  // A frame for the tab the page already detached belongs to an attachment that is over.
  source.write('data: {"type":"output","id":"one","data":"stale","offset":125}\n\n');
  fresh.write('data: {"type":"output","id":"one","data":"fresh","offset":5}\n\n');
  await drained();
  assert.deepEqual(outputs(h.frames).map(([, data]) => data), ["fresh"]);
  replacement.release();
  assert.equal(fresh.aborted, true);
});

test("a device bearer is one explicit header and the browser's cookie is not stated at all", async (t) => {
  const bearer = harness(t, { credential: { kind: "bearer", token: "device-secret" }, origin: "https://gateway.example" });
  bearer.subscribe("one", "/workspace/a");
  const request = lastOpened(bearer.stub);
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
  assert.equal(openedAt(h.stub, 0).headers.get("accept"), "text/event-stream");
  reconnect(t);
  assert.equal(h.stub.opened.length, 1, "a refusal is not retried");

  subscription.reconnect();
  await drained();
  assert.equal(h.stub.opened.length, 2, "an explicit reconnect is the caller's own decision");
  h.stream.close();
  reconnect(t);
  assert.equal(h.stub.opened.length, 2);
});
