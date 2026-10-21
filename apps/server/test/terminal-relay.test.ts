import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";
import { createTerminalRelay } from "../src/terminal-relay.ts";

/**
 * The backend's terminal relay, asserted at its own seam: the host request it opens for one caller.
 *
 * The relay exists only for the caller that asked for it, so that request is cancelled with the caller's own
 * connection — during setup as well as mid-stream. An attached stream is what holds a session open on the host: its
 * reconnect window runs only while nobody is attached, so a request left behind by a caller that went away would hold
 * the shell open for as long as the gateway runs, with no caller left to read it and no window that could ever expire.
 *
 * The stand-in below is the host: a real HTTP server that reports what happened to its own request. Nothing here waits
 * for a fact by re-checking: a fact the fixture reports resolves the one promise that was waiting for it, and every
 * read is answered by bytes the fixture wrote or rejected by the test's own guard, so no test sits on an unbounded
 * read and no failure path leaves a stream pending.
 */

const TOKEN = "relay-token";
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "", gatewayToken: TOKEN };

/** A test-level bound: a fact that never arrives fails the test instead of hanging the suite. */
const TEST_TIMEOUT_MS = 20_000;

/** The facts one stand-in reported, each with the promise that waits for it. No polling, no deadline. */
type Facts = {
  readonly seen: string[];
  push(fact: string): void;
  wait(fact: string): Promise<string>;
  happened(fact: string): boolean;
};

function facts(): Facts {
  const seen: string[] = [];
  const waiting = new Map<string, ((fact: string) => void)[]>();
  return {
    seen,
    push(fact) {
      seen.push(fact);
      for (const resolve of waiting.get(fact) ?? []) resolve(fact);
      waiting.delete(fact);
    },
    wait(fact) {
      if (seen.includes(fact)) return Promise.resolve(fact);
      return new Promise<string>((resolve) => {
        const queued = waiting.get(fact) ?? [];
        queued.push(resolve);
        waiting.set(fact, queued);
      });
    },
    happened: (fact) => seen.includes(fact),
  };
}

/**
 * One read, bounded by the caller's own guard. Every read below is answered by bytes the fixture wrote; the guard is
 * what a failing path aborts, so a read can never outlive the test that started it.
 */
function bounded<T>(pending: Promise<T>, guard: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(new Error("the read outlived the test: no bytes arrived and no caller was left to send any"));
    if (guard.aborted) { cancelled(); return; }
    guard.addEventListener("abort", cancelled, { once: true });
    void pending.then(
      (value) => { guard.removeEventListener("abort", cancelled); resolve(value); },
      (error: unknown) => { guard.removeEventListener("abort", cancelled); reject(error); },
    );
  });
}

/** The host, the relay in front of it, and the origin a caller reaches the relay at. */
type Fixture = {
  readonly origin: string;
  /** What the host recorded about its own requests, in order. */
  readonly host: Facts;
  /** What the relay itself did, in order: entering a binding, seeing the caller's connection close, finishing a request. */
  readonly relay: Facts;
  /** Release a host request whose headers have not been sent yet. */
  release(): void;
  /** Answer a binding the relay is waiting on. */
  releaseBinding(): void;
  /** Write one more frame to every event stream the host is holding open. */
  send(frame: string): void;
  close(): Promise<void>;
};

/**
 * A relay in front of a stand-in host. `holdHeaders` keeps the host's answer unsent, which is where a caller
 * disconnects mid-setup; `bindingGate` holds the relay inside its binding resolution, which is where a caller
 * disconnects before any host request exists.
 */
async function fixture(options: { readonly holdHeaders?: boolean; readonly bindingGate?: boolean } = {}): Promise<Fixture> {
  const hostFacts = facts();
  const relayFacts = facts();
  const releases: (() => void)[] = [];
  const bindingReleases: (() => void)[] = [];
  const held: ServerResponse[] = [];
  const host: Server = createServer((request: IncomingMessage, response) => {
    const url = request.url ?? "";
    if (!url.includes("/events")) { response.writeHead(404, { "content-type": "application/json" }); response.end("{}"); return; }
    hostFacts.push("request");
    request.on("close", () => hostFacts.push("request-closed"));
    response.on("close", () => hostFacts.push("response-closed"));
    held.push(response);
    if (options.holdHeaders === true) {
      releases.push(() => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write("data: {}\n\n"); });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // One frame, so the caller knows its stream is live, and then silence: nothing else is written until a test asks.
    response.write("id: 1\ndata: {\"type\":\"output\",\"data\":\"ready\",\"offset\":5}\n\n");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  assert.ok(address !== null && typeof address === "object");
  const relay = createTerminalRelay({
    binding: async (workspaceId) => {
      if (workspaceId !== "local") return undefined;
      if (options.bindingGate === true) { relayFacts.push("binding"); await new Promise<void>((resolve) => bindingReleases.push(resolve)); }
      return { ...binding, gatewayOrigin: "http://127.0.0.1:" + address.port };
    },
    readBody: async () => undefined,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.test");
    // The caller's own connection, reported by the relay's own server rather than by the relay: a fact that exists
    // whether or not the relay is watching for it.
    response.on("close", () => relayFacts.push("caller-closed"));
    void relay(request, response, url).then((handled) => {
      // The relay's handler returned, so nothing of this request can still be running inside it.
      relayFacts.push("handled");
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relayAddress = server.address();
  assert.ok(relayAddress !== null && typeof relayAddress === "object");
  return {
    origin: "http://127.0.0.1:" + relayAddress.port,
    host: hostFacts,
    relay: relayFacts,
    release: () => releases.shift()?.(),
    releaseBinding: () => bindingReleases.shift()?.(),
    send: (frame) => { for (const response of held) if (!response.writableEnded && !response.destroyed) response.write(frame); },
    close: async () => {
      server.closeAllConnections();
      host.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

/** One decoded read, or the fact that the stream ended. */
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, guard: AbortSignal): Promise<{ text: string; done: boolean }> {
  const chunk = await bounded(reader.read(), guard);
  return chunk.done ? { text: "", done: true } : { text: decoder.decode(chunk.value, { stream: true }), done: false };
}

test("a caller that goes away while its stream is quiet takes the host request with it", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = await fixture();
  const guard = new AbortController();
  const caller = new AbortController();
  try {
    const stream = await fetch(host.origin + "/api/terminal/tab-1/events?cwd=" + encodeURIComponent("/workspace/local"), { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    // The host's own first frame, so the stream is live and the request it belongs to is the one that must be released.
    assert.match((await frame(reader, new TextDecoder(), guard.signal)).text, /ready/);
    assert.equal(host.host.seen.filter((fact) => fact === "request").length, 1, "the host saw exactly one request");

    // The caller goes away while the host has nothing to send. Nothing else is asked of the session.
    caller.abort();
    assert.equal(await host.host.wait("request-closed"), "request-closed", "the host request stayed open after the caller disconnected: the relay never cancelled it, so an attached stream would hold the session for as long as the gateway runs");
    await reader.cancel().catch(() => undefined);
  } finally {
    caller.abort();
    guard.abort();
    await host.close();
  }
});

test("a caller that goes away while the host request is still being set up cancels it too", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = await fixture({ holdHeaders: true });
  const caller = new AbortController();
  try {
    const pending = fetch(host.origin + "/api/terminal/tab-1/events?cwd=" + encodeURIComponent("/workspace/local"), { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal }).catch((error: Error) => error.name);
    // The host has the request but has not answered it yet, which is where the caller disconnects.
    assert.equal(await host.host.wait("request"), "request");
    caller.abort();
    assert.equal(await host.host.wait("request-closed"), "request-closed", "the host request outlived the caller that disconnected before it was answered");
    host.release();
    await pending;
  } finally {
    caller.abort();
    await host.close();
  }
});

test("a caller that goes away while its binding is still being resolved opens no host request at all", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = await fixture({ bindingGate: true });
  const caller = new AbortController();
  try {
    const pending = fetch(host.origin + "/api/terminal/tab-1/events?cwd=" + encodeURIComponent("/workspace/local"), { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal }).catch((error: Error) => error.name);
    // The relay is inside the binding call — the await that re-registers a workspace with the host — and the caller
    // disconnects there, before any host request has been opened for it.
    assert.equal(await host.relay.wait("binding"), "binding");
    caller.abort();
    assert.equal(await host.relay.wait("caller-closed"), "caller-closed");
    host.releaseBinding();
    // The relay's own handler returned, so no host request can still be on its way out of it. With the connection
    // watched only after the binding, the relay opened one anyway and held it: the caller is gone, so nothing would
    // ever read that stream, and an attached stream is what keeps a session alive past its reconnect window.
    assert.equal(await host.relay.wait("handled"), "handled", "the relay never finished the request: it opened a host stream for a caller that had already disconnected while its binding was being resolved");
    assert.deepEqual(host.host.seen, [], "the relay opened a host stream after the caller had already gone");
    await pending;
  } finally {
    caller.abort();
    await host.close();
  }
});

test("a caller that stays attached leaves the host request open", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = await fixture();
  const guard = new AbortController();
  const caller = new AbortController();
  try {
    const stream = await fetch(host.origin + "/api/terminal/tab-1/events?cwd=" + encodeURIComponent("/workspace/local"), { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    assert.match((await frame(reader, decoder, guard.signal)).text, /ready/);
    // A second frame the host writes only because the caller is still there: the request that carries it is open, and
    // cancelling here would end a session the user is watching.
    host.send("id: 2\ndata: {\"type\":\"output\",\"data\":\"still-here\",\"offset\":15}\n\n");
    assert.match((await frame(reader, decoder, guard.signal)).text, /still-here/);
    assert.equal(host.host.happened("request-closed"), false, "an attached caller's host request was closed while it was still attached");
    caller.abort();
    assert.equal(await host.host.wait("request-closed"), "request-closed");
    await reader.cancel().catch(() => undefined);
  } finally {
    caller.abort();
    guard.abort();
    await host.close();
  }
});

/**
 * The page's one terminal stream, relayed to the host that runs its tabs.
 *
 * The page names its tabs and their cursors, and the backend is what merges them, because a tab is addressed by its own
 * routing cwd and two tabs may belong to different workspaces. What is asserted here is the relay's own part of that:
 * one caller connection becomes the host's own stream, the host's frames reach the caller whole, and the caller's
 * connection is what the host request lives for.
 */
test("the page's terminal stream is relayed to the host with its tabs and cursors", { timeout: TEST_TIMEOUT_MS }, async () => {
  const hostFacts = facts();
  const urls: string[] = [];
  const host: Server = createServer((request: IncomingMessage, response) => {
    if (!(request.url ?? "").includes("/events")) { response.writeHead(404, { "content-type": "application/json" }); response.end("{}"); return; }
    urls.push(request.url ?? "");
    hostFacts.push("request");
    request.on("close", () => hostFacts.push("request-closed"));
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    // A frame split across two writes, so the relay's own framing is what the caller's frames depend on.
    response.write("id: 7\ndata: {\"type\":\"output\",\"id\":\"tab-1\",\"data\":\"he");
    response.write("llo\",\"offset\":7}\n\n");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  assert.ok(address !== null && typeof address === "object");
  const relay = createTerminalRelay({
    binding: async (workspaceId) => workspaceId === "local" ? { ...binding, gatewayOrigin: "http://127.0.0.1:" + address.port } : undefined,
    readBody: async () => undefined,
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.test");
    void relay(request, response, url).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relayAddress = server.address();
  assert.ok(relayAddress !== null && typeof relayAddress === "object");
  const caller = new AbortController();
  const guard = new AbortController();
  try {
    const tabs = encodeURIComponent("tab-1") + "|" + encodeURIComponent("/workspace/local") + "|" + encodeURIComponent("5");
    const stream = await fetch("http://127.0.0.1:" + relayAddress.port + "/api/terminal/events?tabs=" + tabs, { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The host's frame arrives whole although it was written in two pieces, so one frame boundary is the whole read.
    while (!text.includes("\n\n")) {
      const read = await frame(reader, decoder, guard.signal);
      if (read.done) break;
      text += read.text;
    }
    // The cursor the caller named travels to the host as the tab's own cursor. The query is encoded by the transport,
    // so the value is read back the way any caller of that route reads it.
    assert.equal(urls.length, 1, "the relay opened one host request per caller");
    assert.equal(new URL(urls[0]!, "http://host").searchParams.get("tabs"), "tab-1:5", "the caller's per-tab cursor did not reach the host: " + urls[0]);
    assert.ok(text.includes("hello"), "the split frame did not arrive whole: " + JSON.stringify(text));
    assert.ok(text.endsWith("\n\n"), "the relay wrote a partial frame: " + JSON.stringify(text));

    // The host request lives for the caller's own connection and no longer.
    caller.abort();
    assert.equal(await hostFacts.wait("request-closed"), "request-closed", "the host request outlived the caller: " + JSON.stringify(hostFacts.seen));
    await reader.cancel().catch(() => undefined);
  } finally {
    caller.abort();
    guard.abort();
    server.closeAllConnections();
    host.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

/**
 * One caller's page stream, with the hosts it merges behind it. Two hosts are used because the failure this covers is
 * about what happens to the *other* one: a page's tabs may belong to two workspaces, and the merge is the only place
 * that can see both.
 */
async function merged(hosts: { readonly write: (response: ServerResponse) => void }[]): Promise<{
  readonly origin: string;
  readonly requests: string[];
  readonly facts: Facts;
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const reported = facts();
  const servers: Server[] = [];
  for (const [index, host] of hosts.entries()) {
    const server: Server = createServer((request: IncomingMessage, response) => {
      requests[index] = request.url ?? "";
      request.on("close", () => reported.push("host-" + index + "-closed"));
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      host.write(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
  }
  const origins = servers.map((server) => {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return "http://127.0.0.1:" + address.port;
  });
  const relay = createTerminalRelay({
    binding: async (workspaceId) => {
      const index = workspaceId === "first" ? 0 : workspaceId === "second" ? 1 : -1;
      return index === -1 ? undefined : { id: workspaceId, gatewayId: workspaceId, gatewayOrigin: origins[index]!, gatewayToken: TOKEN };
    },
    readBody: async () => undefined,
  });
  const server = createServer((request, response) => {
    void relay(request, response, new URL(request.url ?? "/", "http://relay.test")).then((handled) => { if (!handled) { response.writeHead(404); response.end(); } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    requests,
    facts: reported,
    close: async () => {
      server.closeAllConnections();
      for (const host of servers) host.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const host of servers) await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

test("one host's stream ending ends the page's stream and releases the host still running", { timeout: TEST_TIMEOUT_MS }, async () => {
  // The page holds one stream for every mounted tab, and its tabs may belong to two workspaces. When one host's stream
  // ends, leaving the merge open would strand that host's tabs on a stream that will never carry them again: the page
  // would keep them mounted, keep its shell attachment to the other host, and never learn to reconnect. So the merge
  // ends with the host that ended, and the host still running is released with it — the page then reopens the stream and
  // names every tab's cursor, which is what re-attaches all of them.
  const merge = await merged([
    { write: (response) => response.end() },
    { write: (response) => response.write("id: b:1\ndata: {\"type\":\"output\",\"id\":\"b\",\"data\":\"B\",\"offset\":1}\n\n") },
  ]);
  const guard = new AbortController();
  const caller = new AbortController();
  try {
    const tabs = encodeURIComponent("a") + "|" + encodeURIComponent("/workspace/first") + "|," + encodeURIComponent("b") + "|" + encodeURIComponent("/workspace/second") + "|";
    const stream = await fetch(merge.origin + "/api/terminal/events?tabs=" + tabs, { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The merge's end is the caller's end, and the first host ended its own stream: reading until the body finishes is
    // the assertion, and the guard is what a merge that stayed open would fail against.
    while (true) {
      const read = await frame(reader, decoder, guard.signal);
      if (read.done) break;
      text += read.text;
    }
    assert.equal(merge.requests.length, 2, "the merge did not open one host request per binding: " + JSON.stringify(merge.requests));
    // The host's own report that its request was closed, waited for rather than assumed: releasing it is a fact that
    // happens at the stand-in host, not in this process.
    assert.equal(await merge.facts.wait("host-1-closed"), "host-1-closed", "the host still running was left attached to a stream that had ended: " + JSON.stringify(merge.facts.seen));
  } finally {
    caller.abort();
    guard.abort();
    await merge.close();
  }
});

test("a host frame split at the end of a stream is never delivered as half a frame", { timeout: TEST_TIMEOUT_MS }, async () => {
  // This stream is about to end, and what the caller does next is reconnect naming the last complete cursor it saw. Half
  // a frame written here would be a payload the next attach repeats from a cursor that never moved, so a trailing
  // partial frame is discarded rather than forwarded.
  const merge = await merged([
    { write: (response) => { response.write("id: a:1\ndata: {\"type\":\"output\",\"id\":\"a\",\"data\":\"whole\",\"offset\":1}\n\n"); response.write("id: a:2\ndata: {\"type\":\"output\",\"id\":\"a\",\"data\":\"half"); response.end(); } },
    { write: (response) => response.write("id: b:1\ndata: {\"type\":\"output\",\"id\":\"b\",\"data\":\"B\",\"offset\":1}\n\n") },
  ]);
  const guard = new AbortController();
  const caller = new AbortController();
  try {
    const tabs = encodeURIComponent("a") + "|" + encodeURIComponent("/workspace/first") + "|," + encodeURIComponent("b") + "|" + encodeURIComponent("/workspace/second") + "|";
    const stream = await fetch(merge.origin + "/api/terminal/events?tabs=" + tabs, { headers: { authorization: "Bearer " + TOKEN }, signal: caller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // The first host ends its own stream, so the merge ends with it and this read is bounded by that end.
    while (true) {
      const read = await frame(reader, decoder, guard.signal);
      if (read.done) break;
      text += read.text;
    }
    assert.ok(text.includes("whole"), "the complete frame did not reach the caller: " + JSON.stringify(text));
    assert.equal(text.includes("half"), false, "half a frame was written to the caller: " + JSON.stringify(text));
    assert.ok(text.endsWith("\n\n"), "the stream ended mid-frame: " + JSON.stringify(text));
  } finally {
    caller.abort();
    guard.abort();
    await merge.close();
  }
});
