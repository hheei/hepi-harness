import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { test } from "node:test";
import { createFileRelay } from "../src/file-relay.ts";

/**
 * The backend's file relay, asserted at its own seam: the host request one caller's upload or download becomes.
 *
 * A browser names a routing cwd and nothing else; the relay resolves that to the workspace binding every other
 * host-facing route uses and forwards the bytes to that host. The bytes must arrive whole — the JSON workbench proxy
 * cannot carry them, which is the whole reason this route exists — and a refusal must keep the host's own status and
 * code instead of becoming a generic failure.
 */

const TOKEN = "file-relay-token";
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "", gatewayToken: TOKEN };

/** What the stand-in host recorded about the requests it was given. */
type Recorded = { method: string; path: string; body: Buffer; headers: IncomingMessage["headers"] };

/** A signal the fake host raises at the moment it does something, so a wait is for that moment and not a poll. */
type Barrier = { readonly waiters: (() => void)[]; readonly satisfied: () => boolean };

function barrier(satisfied: () => boolean): Barrier { return { waiters: [], satisfied }; }

function raise(signal: Barrier): void { for (const wake of signal.waiters.splice(0)) wake(); }

async function reached(signal: Barrier): Promise<void> {
  if (signal.satisfied()) return;
  await new Promise<void>((resolve) => signal.waiters.push(resolve));
}

type Fixture = {
  readonly origin: string;
  readonly seen: Recorded[];
  readonly events: string[];
  /** Resolves when the host has read a whole request, which is the moment the relay's upstream is open. */
  readonly asked: () => Promise<void>;
  /** Resolves when the host's request is over, which is how the caller's departure is seen from the host's side. */
  readonly closed: () => Promise<void>;
  close(): Promise<void>;
};

async function fixture(handler?: (recorded: Recorded, response: import("node:http").ServerResponse) => boolean): Promise<Fixture> {
  const seen: Recorded[] = [];
  const events: string[] = [];
  const asked = barrier(() => seen.length > 0);
  const closed = barrier(() => events.includes("host-request-closed"));
  const host: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("close", () => { events.push("host-request-closed"); raise(closed); });
    request.on("end", () => {
      const recorded: Recorded = { method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks), headers: request.headers };
      seen.push(recorded);
      raise(asked);
      if (handler !== undefined && handler(recorded, response)) return;
      if (recorded.path.startsWith("/v1/files/bytes")) {
        response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "4", "accept-ranges": "bytes" });
        response.end("blob");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, value: { path: "/notes.txt", size: recorded.body.byteLength, skipped: false } }));
    });
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const address = host.address();
  assert.ok(address !== null && typeof address === "object");
  const relay = createFileRelay({
    binding: async (workspaceId) => workspaceId === "local" ? { ...binding, gatewayOrigin: "http://127.0.0.1:" + address.port } : undefined,
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      return text === "" ? undefined : JSON.parse(text);
    },
  });
  const server = createServer((request, response) => {
    void relay(request, response, new URL(request.url ?? "/", "http://relay.test")).then((handled) => {
      if (!handled) { response.writeHead(404); response.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const relayAddress = server.address();
  assert.ok(relayAddress !== null && typeof relayAddress === "object");
  return {
    origin: "http://127.0.0.1:" + relayAddress.port,
    seen,
    events,
    asked: () => reached(asked),
    closed: () => reached(closed),
    close: async () => {
      server.closeAllConnections();
      host.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => host.close(() => resolve()));
    },
  };
}

/** A body sent as a stream, so the relay is exercised the way a browser's own upload arrives. */
function streamedBody(bytes: Buffer, parts = 3): ReadableStream<Uint8Array> {
  const size = Math.ceil(bytes.byteLength / parts);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + size, bytes.byteLength);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
      offset = end;
    },
  });
}

test("an upload larger than the JSON body limit reaches the host as the same bytes", async () => {
  const host = await fixture();
  try {
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 5);
    const response = await fetch(host.origin + "/api/files/upload?cwd=" + encodeURIComponent("/workspace/local/big.bin") + "&conflict=error", {
      method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/octet-stream" },
      body: streamedBody(content),
      // @ts-expect-error a streamed request body needs the half-duplex hint that Node's fetch types do not carry yet
      duplex: "half",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, value: { path: "/notes.txt", size: content.byteLength, skipped: false } });
    assert.equal(host.seen.length, 1);
    const [request] = host.seen;
    assert.equal(request.path, "/v1/files/upload?workspaceId=local&path=%2Fbig.bin&conflict=error");
    assert.deepEqual(request.body, content);
    assert.equal(request.headers.authorization, "Bearer " + TOKEN);
  } finally { await host.close(); }
});

test("the host's own status and headers come back to the caller untouched", async () => {
  const host = await fixture((recorded, response) => {
    if (!recorded.path.startsWith("/v1/files/bytes")) return false;
    response.writeHead(206, { "content-type": "application/octet-stream", "content-length": "4", "content-range": "bytes 2-5/20", "accept-ranges": "bytes" });
    response.end("cdef");
    return true;
  });
  try {
    const response = await fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/workspace/local/blob.bin"), { headers: { authorization: "Bearer " + TOKEN, range: "bytes=2-5" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-5/20");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(await response.text(), "cdef");
    assert.equal(host.seen[0].headers.range, "bytes=2-5");
  } finally { await host.close(); }
});

test("a refusal keeps the host's own code and status", async () => {
  const host = await fixture((recorded, response) => {
    if (!recorded.path.startsWith("/v1/files/upload?")) return false;
    response.writeHead(409, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, code: "conflict", message: "the file already exists", conflicts: ["/notes.txt"], nonReplaceable: [] }));
    return true;
  });
  try {
    const response = await fetch(host.origin + "/api/files/upload?cwd=" + encodeURIComponent("/workspace/local/notes.txt") + "&conflict=error", {
      method: "POST",
      headers: { authorization: "Bearer " + TOKEN },
      body: new Blob([new Uint8Array(Buffer.from("x"))]),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { ok: false, code: "conflict", message: "the file already exists", conflicts: ["/notes.txt"], nonReplaceable: [] });
  } finally { await host.close(); }
});

test("the pre-flight check is the host's own answer about the names it was given", async () => {
  const host = await fixture((recorded, response) => {
    if (!recorded.path.startsWith("/v1/files/upload-check")) return false;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, value: { conflicts: ["notes.txt"], nonReplaceable: [] } }));
    return true;
  });
  try {
    const response = await fetch(host.origin + "/api/files/upload-check", {
      method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/local", fileNames: ["notes.txt"] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, value: { conflicts: ["notes.txt"], nonReplaceable: [] } });
    const [request] = host.seen;
    assert.equal(request.path, "/v1/files/upload-check?workspaceId=local");
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), { workspaceId: "local", path: "/", names: ["notes.txt"] });
  } finally { await host.close(); }
});

test("a cwd that names no workspace, and a host that cannot be reached, keep their own answers", async () => {
  const host = await fixture();
  try {
    const unknown = await fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/workspace/nowhere/blob.bin"), { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, code: "unknown_workspace" });

    const unrouted = await fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/durable"), { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(unrouted.status, 501);
    assert.equal((await unrouted.json() as { code: string }).code, "not_supported");
  } finally { await host.close(); }
});

test("a caller that goes away cancels the host request it opened", async () => {
  const host = await fixture((recorded, response) => {
    if (!recorded.path.startsWith("/v1/files/bytes")) return false;
    // The host has answered with a body it has not finished: the state a download spends its time in.
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "100" });
    response.write("start");
    return true;
  });
  const controller = new AbortController();
  try {
    const pending = fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/workspace/local/blob.bin"), { headers: { authorization: "Bearer " + TOKEN }, signal: controller.signal }).catch((error: Error) => error.name);
    // The host has the request and has written a body it has not finished: the state a download spends its time in, and
    // the state the caller walks away from.
    await host.asked();
    assert.equal(host.seen.length, 1, "the host was never asked for the file");
    controller.abort();
    // The wait is the host's own close, so the assertion below is a fact the host reported rather than one a poll
    // happened to notice in time.
    await host.closed();
    assert.ok(host.events.includes("host-request-closed"), "the host request outlived the caller that opened it");
    await pending;
  } finally { await host.close(); }
});
