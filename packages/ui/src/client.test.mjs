import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The same resolution the app uses: the modules under test import through the `@/` alias.
const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") } });
const { createClient, WorkbenchRequestError } = await jiti.import("./client.ts");
const { CompletionDelivery } = await jiti.import("./lib/completion-delivery.ts");

/**
 * The connection seam a page's whole conversation workflow crosses.
 *
 * Every read, page, submission, lease and stream below the workbench is the client's own request: its Gateway origin and
 * its credential, and nothing at all once it is disposed. These cases state that at the seam itself — the one the App
 * relies on, where the document's own origin is the bundle and a relative `fetch` would ask the shell for history it
 * does not serve.
 */
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A platform fetch that records what this connection asked for and answers a stream the test can write to.
 *
 * A client's binding is stated once, so a test reads it back as the value a surface hands to the stream it owns: the
 * origin, the credential and the fetch, and nothing a surface chose for itself.
 */
function streamPlatform() {
  const opened = [];
  const fetch = async (url, init = {}) => {
    const record = { url: String(url), headers: new Headers(init.headers), credentials: init.credentials, aborted: false };
    init.signal?.addEventListener("abort", () => { record.aborted = true; });
    opened.push(record);
    return new Response(new ReadableStream({ start(controller) { record.write = (text) => controller.enqueue(new TextEncoder().encode(text)); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { opened, fetch };
}

/** One conversation's stream, as the transport's own source: only the socket is synthetic. */
function sourceFactory(sources) {
  return conversationId => {
    const source = {
      conversationId, readyState: 1, closed: false, onmessage: null, onerror: null,
      close() { this.readyState = 2; this.closed = true; },
    };
    sources.push(source);
    return source;
  };
}

test("requests carry the connection's Gateway origin and credential, and a disposed connection answers nothing", async (t) => {
  const calls = [], sources = [];
  const client = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-token" },
    createSource: sourceFactory(sources),
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), credentials: init?.credentials });
      return jsonResponse({ sessions: [] });
    },
  });
  t.after(() => client.dispose());

  // The App states its Gateway, so the address is that origin and never the document's own: a path assembled here is
  // resolved once, by the client, and no caller below it sees an origin at all.
  assert.equal(client.origin, "https://gateway.example", "the trailing slash is normalized away");
  await client.readJson("/api/sessions?summary=1");
  assert.equal(calls[0].url, "https://gateway.example/api/sessions?summary=1");
  assert.equal(calls[0].headers.get("authorization"), "Bearer device-token", "the device bearer is the credential");
  assert.equal(calls[0].credentials, "same-origin", "the browser's cookie jar is not asked for another origin's cookies");

  // A named refusal is a value a caller shows: the Backend's status, code and body travel on the rejection.
  const refusing = createClient({
    origin: "https://gateway.example",
    credential: { kind: "bearer", token: "device-token" },
    createSource: sourceFactory(sources),
    fetch: async () => jsonResponse({ error: "conversation not found", code: "not_found" }, 404),
  });
  t.after(() => refusing.dispose());
  await assert.rejects(refusing.readJson("/api/sessions/gone"), (error) => {
    assert.equal(error instanceof WorkbenchRequestError, true);
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    assert.equal(error.message, "conversation not found");
    return true;
  });

  // A Web page states no origin and no bearer: the same read is relative, and the httpOnly cookie goes by itself.
  const cookieCalls = [];
  const cookie = createClient({
    origin: "",
    credential: { kind: "cookie" },
    createSource: sourceFactory(sources),
    fetch: async (url, init) => { cookieCalls.push({ url: String(url), headers: new Headers(init?.headers) }); return jsonResponse({}); },
  });
  await cookie.readJson("/api/descriptor");
  assert.equal(cookieCalls[0].url, "/api/descriptor");
  assert.equal(cookieCalls[0].headers.has("authorization"), false, "a cookie connection states no bearer");
  cookie.dispose();

  // Disposal is the connection being gone: a late caller is refused rather than answered with the next connection's data.
  client.dispose();
  assert.equal(client.disposed, true);
  const before = calls.length;
  await assert.rejects(client.readJson("/api/sessions"), /closed/);
  assert.equal(calls.length, before, "a disposed client sends nothing");
});

test("connection disposal aborts pending requests and fences a transport that answers late", async (t) => {
  // The request belongs to the connection, so disposal reaches the read that is already on the wire.
  const held = Promise.withResolvers();
  let signal;
  const client = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: async (_url, init) => { signal = init.signal; await held.promise; return jsonResponse({ stale: true }); },
  });
  const read = client.readJson("/api/models");
  client.dispose();
  held.resolve();
  assert.equal(signal?.aborted, true, "pending reads belong to their connection");
  await assert.rejects(read, /closed/);

  // A caller's own signal ends that caller's request and nothing else: the connection's lifetime is a separate fact.
  const caller = new AbortController();
  const live = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: async (_url, init) => {
      await new Promise((resolve) => init.signal.addEventListener("abort", resolve, { once: true }));
      throw new DOMException("aborted", "AbortError");
    },
  });
  t.after(() => live.dispose());
  const pending = live.readJson("/api/models", { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(live.disposed, false, "a caller's abort is not the connection's disposal");
});

test("a client states one connection binding, and it is the credential its streams present", async (t) => {
  const stub = streamPlatform();
  const client = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-secret" },
    fetch: stub.fetch,
    createSource: sourceFactory([]),
  });
  t.after(() => client.dispose());
  assert.deepEqual(client.connection, { origin: "https://gateway.example", credential: { kind: "bearer", token: "device-secret" }, fetch: stub.fetch });
  // The binding is one value: a surface compares it by identity to decide whether the stream it holds is still this
  // connection's, so a fresh object per read would restart a mounted tab's stream on every render.
  assert.equal(client.connection, client.connection);

  // A Web page states no origin and no bearer, and a disposed connection is a connection that is gone.
  const cookie = createClient({ origin: "", credential: { kind: "cookie" }, fetch: stub.fetch, createSource: sourceFactory([]) });
  assert.deepEqual(cookie.connection, { credential: { kind: "cookie" }, fetch: stub.fetch });
  cookie.dispose();
  await assert.rejects(cookie.request("/api/descriptor"), /closed/);
});

test("the shell's completion registry reads the connection's one stream, and closing it closes nothing", async (t) => {
  const sources = [], answers = [], lookups = [];
  const client = createClient({
    origin: "https://gateway.example",
    credential: { kind: "bearer", token: "device-token" },
    createSource: sourceFactory(sources),
    fetch: async (url) => {
      lookups.push(String(url));
      return jsonResponse({ submission: null });
    },
  });
  t.after(() => client.dispose());
  // The shell's registry as it is assembled there: a reader of the connection's stream, not the owner of a second one.
  const delivery = new CompletionDelivery({
    subscribe: (conversationId, listener) => client.subscribe(conversationId, listener),
    lookup: async (conversationId, requestId) => {
      const answer = await client.readJson(`/api/agent/${encodeURIComponent(conversationId)}/submissions?requestId=${encodeURIComponent(requestId)}`).catch(() => null);
      return answer?.submission ?? null;
    },
    onAnswered: notice => answers.push(notice),
  });

  // A background watch opens the conversation's stream on the connection.
  delivery.nominate(["conv"]);
  assert.equal(sources.length, 1, "the watch opened the conversation's one source");
  const source = sources[0];

  // The open surface joins the same conversation: one stream, two readers — never a second socket.
  const surface = client.subscribe("conv", () => {});
  assert.equal(sources.length, 1, "the surface joined the stream the watch holds");

  // Leaving the shell releases its interest only. The surface still reads, so the source stays open.
  delivery.close();
  assert.equal(source.closed, false, "closing the registry closed a stream its own reader had left");

  // A closed registry watches nothing further: a later nomination opens no stream behind the surface's back.
  delivery.nominate(["other"]);
  assert.equal(sources.filter(item => item.conversationId === "other").length, 0);

  // The shell that owns the registry remounts with it: opening it again watches, and that is the pair a Strict Mode
  // double mount and a re-created tree need.
  delivery.open();
  delivery.nominate(["other"]);
  assert.equal(sources.filter(item => item.conversationId === "other").length, 1, "an opened registry watches again");

  // The last reader leaving is what ends the source, and disposing the connection ends whatever is left.
  surface.release();
  assert.equal(source.closed, true, "the last reader leaving closes the conversation's source");
  const remaining = client.subscribe("conv2", () => {});
  client.dispose();
  assert.equal(sources.find(item => item.conversationId === "conv2").closed, true, "disposal closes the connection's streams");
  remaining.release();
  assert.deepEqual(lookups, [], "no lookup was issued by these steps");
  assert.deepEqual(answers, [], "no completion was invented by these steps");
});
test("read blocks are read on the connection: its origin, its credential, and a disposal that revokes the lease", async (t) => {
  const calls = [];
  const client = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-token" },
    createSource: sourceFactory([]),
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), credentials: init?.credentials });
      if (String(url).includes("/text")) return jsonResponse({ text: "the whole text", totalBytes: 14 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
    },
  });
  t.after(() => client.dispose());

  // A read block is resolved against this connection's Gateway, never the document's own origin — the failure a native
  // shell has, where a relative path would ask the App bundle for conversation history.
  const text = await client.resources.text("/api/sessions/s/entries/e/text?blockIndex=0");
  assert.deepEqual(text, { ok: true, value: "the whole text" });
  assert.equal(calls[0].url, "https://gateway.example/api/sessions/s/entries/e/text?blockIndex=0");
  assert.equal(calls[0].headers.get("authorization"), "Bearer device-token", "the read block presents the device bearer");
  assert.equal(calls[0].credentials, "omit", "a bearer read states no cookie jar");
  assert.equal(calls[0].url.includes("device-token"), false, "the credential never enters the URL");

  // An address on another origin is refused before a request is made: presenting this identity elsewhere would be the
  // client handing it to whatever a frame named.
  const before = calls.length;
  assert.deepEqual(await client.resources.text("https://elsewhere.example/api/sessions/s/entries/e/text?blockIndex=0"), { ok: false, reason: "not_found" });
  assert.equal(calls.length, before, "an undeclared origin is refused without a request");

  // An image is a lease, and the connection owns it: disposing the connection is what revokes the blob, so a page that
  // switched connection cannot keep showing the previous one's screenshot.
  const image = await client.resources.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0");
  assert.equal(image.ok, true);
  assert.match(image.value.url, /^blob:/);
  assert.equal(image.value.revoked, false);
  client.dispose();
  assert.equal(image.value.revoked, true, "disposal revoked the lease this connection handed out");

  // A Web page states no origin and no bearer: the same read is relative, and the httpOnly cookie goes by itself.
  const cookieCalls = [];
  const cookie = createClient({
    origin: "",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: async (url, init) => { cookieCalls.push({ url: String(url), headers: new Headers(init?.headers), credentials: init?.credentials }); return jsonResponse({ text: "cookie text" }); },
  });
  t.after(() => cookie.dispose());
  await cookie.resources.text("/api/sessions/s/entries/e/text?blockIndex=0");
  assert.equal(cookieCalls[0].url, "/api/sessions/s/entries/e/text?blockIndex=0");
  assert.equal(cookieCalls[0].headers.has("authorization"), false, "a cookie connection states no bearer");
  assert.equal(cookieCalls[0].credentials, "same-origin", "the browser attaches its own HttpOnly cookie");
});

test("a caller's signal and the connection's lifetime still reach a body that arrives after the headers", async (t) => {
  // A response's body is the rest of the request: the transport answers headers first and the bytes follow, so a request
  // is not over when `fetch` resolves. The stub models the platform: an abort on the signal it was handed errors the body.
  const bodyCase = (record) => async (_url, init) => {
    record.signal = init.signal;
    const stream = new ReadableStream({
      start(controller) {
        record.push = (text) => controller.enqueue(new TextEncoder().encode(text));
        record.end = () => controller.close();
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  };

  // The reported shape: a caller's own signal is supplied, the headers arrive, the body stalls, and the connection is
  // disposed. The connection's lifetime has to reach the read that is still in flight.
  const disposing = {};
  const withCaller = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: bodyCase(disposing),
  });
  const caller = new AbortController();
  const callerRead = withCaller.readJson("/api/models", { signal: caller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposing.signal.aborted, false, "the body is still on the wire after the headers");
  withCaller.dispose();
  assert.equal(disposing.signal.aborted, true, "disposal reaches a body that arrived after the headers");
  await assert.rejects(callerRead, /closed/);

  // The same shape without a caller's signal: the body is still the connection's request.
  const plain = {};
  const noCaller = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: bodyCase(plain),
  });
  const plainRead = noCaller.readJson("/api/models");
  await new Promise((resolve) => setImmediate(resolve));
  noCaller.dispose();
  assert.equal(plain.signal.aborted, true, "a body without a caller signal is ended by disposal too");
  await assert.rejects(plainRead, /closed/);

  // A caller's abort mid-body ends its own request and nothing else.
  const own = {};
  const ownClient = createClient({
    origin: "https://gateway.example",
    credential: { kind: "cookie" },
    createSource: sourceFactory([]),
    fetch: bodyCase(own),
  });
  t.after(() => ownClient.dispose());
  const ownCaller = new AbortController();
  const ownRead = ownClient.readJson("/api/models", { signal: ownCaller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  ownCaller.abort();
  assert.equal(own.signal.aborted, true, "the caller's abort reaches the body it started");
  // What a caller does with an aborted body is its own: this seam states the transport fact and the connection's life,
  // and a body read answers `{}` for a body it could not read whether or not the caller cancelled it.
  await ownRead;
  assert.equal(ownClient.disposed, false, "a caller's abort is not the connection's disposal");
});

