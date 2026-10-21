import assert from "node:assert/strict";
import { listenerCount } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";
import type { DocxBytesOptions, DocxBytesRead } from "./docx-preview.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { docxParagraphs, loadDocxText, readDocxBytes } = await jiti.import<typeof import("./docx-preview.ts")>("./docx-preview.ts");
const { DOCX_PREVIEW_MAX_BYTES } = await jiti.import<typeof import("@hepi/protocol/files")>("@hepi/protocol/files");

/**
 * The bound a browser-side document preview holds itself to, tested without a Gateway.
 *
 * The number lives in `@hepi/protocol/files` and the gateway enforces its own read policy behind it; what this module
 * owns is that the bound is enforced **while the body arrives**: a `content-length` over it is answered from the header
 * without the body, and a body that grows past it after claiming otherwise is abandoned at the bound. A page that
 * buffered first and decided second would let a remote document occupy the tab before the refusal could be said, so
 * each case states what the stream was allowed to deliver and whether it was closed.
 */

/**
 * A response whose body hands over `chunks`.
 *
 * `delivered` counts bytes the source produced and `cancelled` counts the closes the caller performed — a stream left
 * open on the way to a refusal is the failure these cases are here to catch, and no status code shows it.
 */
/** What one body delivered and what the caller did to it, as each case reads it back. */
type BodySeen = { delivered: number; pulls: number; blocked: number; cancelled: number };

/** How a case watches a body: the pulls and the stall, stated by the case and nothing else. */
type BodyOptions = {
  readonly headers?: Record<string, string>;
  readonly onPull?: (seen: BodySeen) => void;
  readonly failAt?: number;
  readonly blockAt?: number;
  readonly onBlocked?: (seen: BodySeen) => void;
};

function documentBody(chunks: readonly Uint8Array[], options: BodyOptions = {}) {
  const remaining = [...chunks];
  const seen: BodySeen = { delivered: 0, pulls: 0, blocked: 0, cancelled: 0 };
  const stream = new ReadableStream({
    pull(target) {
      seen.pulls += 1;
      options.onPull?.(seen);
      if (options.failAt !== undefined && seen.pulls === options.failAt) {
        target.error(new Error("the transport stopped"));
        return;
      }
      const next = remaining.shift();
      if (next === undefined) { target.close(); return; }
      seen.delivered += next.byteLength;
      target.enqueue(next);
    },
    cancel() { seen.cancelled += 1; }
  });
  return { seen, response: () => new Response(stream, { headers: options.headers }) };
}

/** One chunk of a stated size, as a body carries it. */
const chunk = (bytes: number): Uint8Array<ArrayBuffer> => new Uint8Array(new ArrayBuffer(bytes));

/** How many abort listeners a caller's controller still holds: a signal outlives the read it was for. */
const abortListeners = (signal: AbortSignal): number => listenerCount(signal as unknown as import("node:events").EventEmitter, "abort");

/** The request a case's client was handed, asserted sent so its fields are readable. */
function sentOf(sent: RequestInit | undefined): RequestInit {
  assert.ok(sent !== undefined, "the document request was sent");
  return sent;
}

test("a document whose stated length is past the bound is refused from the header, not from its body", async () => {
  // The body is a kilobyte and the header claims the bound plus one. Reading the refusal's number tells which one the
  // answer came from: naming the claim proves nothing was buffered to find out.
  const body = documentBody([chunk(1024)], { headers: { "content-length": String(DOCX_PREVIEW_MAX_BYTES + 1) } });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "oversize");
  assert.match(answer.message, new RegExp(String(DOCX_PREVIEW_MAX_BYTES + 1)), "the refusal should name the stated size: " + answer.message);
  assert.match(answer.message, /download it instead/, "an over-bound document names the way to get it");
  assert.equal(body.seen.cancelled, 1, "the body the refusal abandoned was left open");
});

test("a body that lied about its size is abandoned at the bound, not buffered past it", async () => {
  const size = DOCX_PREVIEW_MAX_BYTES;
  const body = documentBody([chunk(size), chunk(1), chunk(1)], { headers: { "content-length": "1" } });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "oversize");
  assert.match(answer.message, new RegExp(String(size + 1) + "\\b"), "the refusal names the first byte past the bound, so nothing further was collected: " + answer.message);
  assert.equal(body.seen.cancelled, 1);
});

test("a preview the caller stopped caring about ends its stream instead of finishing it", async () => {
  const controller = new AbortController();
  // The abort lands while the first chunk is being handed over — the state a viewer reaches when the document leaves the
  // screen mid-download, which no pre-aborted signal can show.
  const body = documentBody([chunk(2048), chunk(2048), chunk(2048)], { onPull: (seen) => { if (seen.pulls === 1) controller.abort(); } });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted");
  assert.equal(body.seen.cancelled, 1, "an abandoned preview left its download running");
  assert.ok(body.seen.delivered <= 4096, "it pulled more than the chunk it was on: " + body.seen.delivered);
});

test("a caller that was already gone asks the Gateway for nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = 0;
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open: async () => { opened += 1; return new Response(chunk(8)); } });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted");
  assert.equal(opened, 0, "a dead caller still fetched the document");
});

test("a transport that stops mid-document is a refusal, not a truncated preview", async () => {
  const body = documentBody([chunk(2048), chunk(2048)], { failAt: 1 });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "unavailable");
  assert.match(answer.message, /stopped arriving/);
});

test("a refusal from the surface is the surface's own answer, not an empty document", async () => {
  const answer = await readDocxBytes("https://gateway.test/doc.docx", {
    open: async () => new Response(JSON.stringify({ error: "no such file", code: "not_found" }), { status: 404 }),
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "unavailable");
  assert.match(answer.message, /404/, "the status the Gateway answered is not hidden from the page");
});

test("the bytes that arrive within the bound are handed to the reader whole", async () => {
  const answer = await readDocxBytes("https://gateway.test/doc.docx", {
    open: async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.bytes, 5);
  assert.deepEqual([...new Uint8Array(answer.arrayBuffer)], [1, 2, 3, 4, 5]);
});

/**
 * A transport-shaped body: it is asked for a chunk **only while a read is waiting for one** (`highWaterMark: 0`,
 * which is how a socket-backed stream behaves) and, at `blockAt`, stops answering - the pull stays pending until
 * whoever is reading lets go of the stream.
 *
 * That is the state a remote document reaches when the host stops mid-send, and the only state that separates an abort
 * that is acted on from an abort that is merely remembered: a read already sitting on a pending pull cannot be stopped
 * by checking a flag between chunks, because there is no next chunk to check before the page is left waiting.
 */
function stalledBody(chunks: readonly Uint8Array[], options: BodyOptions = {}) {
  const remaining = [...chunks];
  const seen: BodySeen = { delivered: 0, pulls: 0, blocked: 0, cancelled: 0 };
  let unblock: (() => void) | undefined;
  const stream = new ReadableStream({
    pull(target) {
      seen.pulls += 1;
      options.onPull?.(seen);
      if (options.blockAt === seen.pulls) {
        seen.blocked += 1;
        return new Promise((resolve) => { unblock = () => { seen.cancelled += 1; resolve(); }; options.onBlocked?.(seen); });
      }
      const next = remaining.shift();
      if (next === undefined) { target.close(); return; }
      seen.delivered += next.byteLength;
      target.enqueue(next);
    },
    cancel() { unblock?.(); }
  }, { highWaterMark: 0 });
  return { seen, response: () => new Response(stream, { headers: options.headers }) };
}

test("the preview's abort is the signal the request carries, so the remote read stops with it", async () => {
  const controller = new AbortController();
  let sent: RequestInit | undefined;
  const answer = await readDocxBytes("https://gateway.test/doc.docx", {
    signal: controller.signal,
    init: { credentials: "same-origin" },
    open: async (_address: string, init?: RequestInit) => { sent = init; return new Response(chunk(8)); },
  });
  assert.equal(answer.ok, true);
  assert.equal(sentOf(sent).signal, controller.signal, "the document request was sent without the preview's abort: a preview that leaves the screen keeps its remote read running");
  assert.equal(sentOf(sent).credentials, "same-origin", "composing a signal must not drop the rest of the request");
});

test("a request that names its own signal is not stripped of it", async () => {
  const controller = new AbortController();
  let sent: RequestInit | undefined;
  const answer = await readDocxBytes("https://gateway.test/doc.docx", {
    init: { credentials: "same-origin", signal: controller.signal },
    open: async (_address: string, init?: RequestInit) => { sent = init; return new Response(chunk(8)); },
  });
  assert.equal(answer.ok, true);
  assert.equal(sentOf(sent).signal, controller.signal);
});

test("a stop from either the preview or the request itself ends the read", async () => {
  // The viewer owns one controller and the connection may own another; neither may be the silent loser, or one of the
  // two ways a document stops being wanted goes unanswered and its remote read keeps running.
  const preview = new AbortController();
  const request = new AbortController();
  const body = stalledBody([chunk(2048)], { blockAt: 2, onBlocked: () => request.abort() });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", {
    signal: preview.signal,
    init: { credentials: "same-origin", signal: request.signal },
    open: async (_address: string, init?: RequestInit) => {
      assert.notEqual(init?.signal, preview.signal, "the request signal replaced the preview's instead of joining it");
      assert.notEqual(init?.signal, request.signal);
      return body.response();
    },
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted", "a request stopped by its own signal is the caller walking away, not a broken transport");
  assert.equal(body.seen.cancelled, 1);
});

test("a caller that stops while headers are in flight gets its abort, not a transport failure", async () => {
  const controller = new AbortController();
  let sent: RequestInit | undefined;
  // A request that carries its abort behaves like fetch: it rejects with an AbortError once the caller stops, and the
  // reason reported back is the stop, not a broken connection. The reject is reached only because the signal is on the
  // request - which is the thing this seam was silent about before.
  const open = (_address: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    sent = init;
    // The preview composes its own signal onto the request, so this one is always there to listen to.
    assert.ok(init?.signal !== undefined && init.signal !== null, "the request carries the composed abort");
    init.signal.addEventListener("abort", () => reject(new DOMException("The user aborted a request.", "AbortError")));
  });
  const answer = readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open });
  await Promise.resolve();
  controller.abort();
  const result = await answer;
  assert.equal(sentOf(sent).signal, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "aborted", "a preview the caller walked away from is not a broken connection");
});

test("a stop that arrives while the host has stopped sending closes the read it is waiting on", { timeout: 4000 }, async () => {
  const controller = new AbortController();
  // The second read is the one that hangs: the first chunk arrived, the host sent nothing more, and the abort lands
  // while the page is parked on that pending read. Nothing here ever hands over another byte, so the only way this
  // test settles is the abort closing the stream it is sitting on.
  const body = stalledBody([chunk(2048)], { blockAt: 2, onBlocked: () => controller.abort() });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted");
  assert.equal(body.seen.blocked, 1, "the read was never left waiting on the host");
  assert.equal(body.seen.cancelled, 1, "the stalled read was not closed by the abort");
  assert.equal(body.seen.pulls, 2, "it asked the host for another chunk past the stall: " + body.seen.pulls);
  assert.equal(body.seen.delivered, 2048, "it kept pulling bytes for a preview nobody is watching: " + body.seen.delivered);
  // The listener is what makes that cancellation happen, and a signal outlives one preview: a caller that keeps the
  // same AbortController across documents must not accumulate one reader per preview.
  assert.equal(abortListeners(controller.signal), 0, "the abort listener outlived the read it was for");
});

test("a stop that arrives on the document's last chunk is not a document", async () => {
  const controller = new AbortController();
  // Every byte is here and the end of the body is what the read is waiting on: the loop's next check would have
  // returned the document, so this is the race between finishing and being abandoned, and abandoning has to win.
  const body = stalledBody([chunk(2048)], { onPull: (seen) => { if (seen.pulls === 2) controller.abort(); } });
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open: async () => body.response() });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted", "bytes that arrived after the preview was stopped are not a preview");
  assert.equal(body.seen.delivered, 2048, "it read past the point the caller left: " + body.seen.delivered);
});

test("a read that finishes keeps no abort behind it", async () => {
  const controller = new AbortController();
  const answer = await readDocxBytes("https://gateway.test/doc.docx", { signal: controller.signal, open: async () => new Response(chunk(8)) });
  assert.equal(answer.ok, true);
  assert.equal(abortListeners(controller.signal), 0, "a completed preview still holds its abort");
});

test("the document read itself stops on the caller's abort, with nothing imported and nothing parsed", async () => {
  // loadDocxText is the seam the viewer's hook calls. A document that reads fine is mammoth's territory and asserted in
  // chromium; every refusal before the bytes are whole is this file's, and must stay a value the caller receives rather
  // than an import the page pays for. The abort that lands mid-body is the one the unmounting viewer issues.
  const controller = new AbortController();
  const body = stalledBody([chunk(2048)], { blockAt: 2, onBlocked: () => controller.abort() });
  let sent: RequestInit | undefined;
  const answer = await loadDocxText("https://gateway.test/doc.docx", {
    signal: controller.signal,
    init: { credentials: "same-origin" },
    open: async (_address: string, init?: RequestInit) => { sent = init; return body.response(); },
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "aborted");
  assert.equal(sentOf(sent).signal, controller.signal, "the reader's request went out without the abort the viewer handed it");
  assert.equal(body.seen.cancelled, 1, "the reader left its document stream running");
});

test("the document's text is split into the paragraphs a reader sees", () => {
  assert.deepEqual(docxParagraphs("first\r\n\nsecond\n   \n"), ["first", "second"]);
  // An empty document is a fact about the document, so it stays distinguishable from a preview that produced nothing:
  // the split yields no paragraphs and the viewer says "contains no text" rather than showing a blank frame.
  assert.deepEqual(docxParagraphs("  \n \n"), []);
});
