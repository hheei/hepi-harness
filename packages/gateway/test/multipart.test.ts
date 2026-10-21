import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MAX_UPLOAD_BATCH_BYTES, UPLOAD_FIELD, UploadTooLargeError, readUploadParts, type UploadPart } from "../src/multipart.ts";

/**
 * The bounded multipart reader, on its own.
 *
 * This is the one thing the old Next-private parser was kept for, so what it must do is asserted as a contract rather
 * than as a shape: a declared body over the bound is refused before it is read, a chunked one is counted as it arrives,
 * every file reaches the caller as its own stream in arrival order, a refusal ends the request where it stands, and a
 * body that dies mid-flight is reported as the failure it is instead of a silent short file.
 */

const BOUNDARY = "hepi-multipart-test";

function body(parts: readonly (readonly [string, string, string?])[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, value, fileName] of parts) {
    const disposition = fileName === undefined ? `form-data; name="${name}"` : `form-data; name="${name}"; filename="${fileName}"`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(Buffer.from(value));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

const headers = (extra: Record<string, string> = {}) => ({ "content-type": "multipart/form-data; boundary=" + BOUNDARY, ...extra });

/** Every file the reader handed on, as the caller took it: its name and its bytes. */
async function collect(payload: Readable, limits: { totalBytes?: number; headers?: Record<string, string> } = {}): Promise<[string, string][]> {
  const seen: [string, string][] = [];
  await readUploadParts({
    headers: limits.headers ?? headers(),
    body: payload,
    ...(limits.totalBytes === undefined ? {} : { totalBytes: limits.totalBytes }),
    take: async (part: UploadPart) => {
      const chunks: Buffer[] = [];
      for await (const chunk of part.body) chunks.push(chunk as Buffer);
      seen.push([part.fileName, Buffer.concat(chunks).toString("utf8")]);
    },
  });
  return seen;
}

test("every file reaches the caller as its own stream, in arrival order, under the field the upload uses", async () => {
  const payload = body([["files", "first", "one.txt"], ["note", "ignored"], ["files", "second", "two.txt"], ["files", "third", "../escape.txt"]]);
  // A field the surface does not serve is read out rather than left in the way of the parts behind it, and a name that
  // is not one file's own name is passed on untouched: refusing it is the upload's rule, not the parser's.
  assert.deepEqual(await collect(Readable.from(payload)), [["one.txt", "first"], ["two.txt", "second"], ["../escape.txt", "third"]]);
  assert.equal(UPLOAD_FIELD, "files");
});

test("a declared body over the bound is refused before a byte of it is read", async () => {
  const payload = body([["files", "small", "small.txt"]]);
  let read = 0;
  const counted = new Readable({
    read() { read += 1; this.push(payload); this.push(null); },
  });
  await assert.rejects(
    () => readUploadParts({ headers: headers({ "content-length": String(payload.byteLength) }), body: counted, totalBytes: 8, take: async () => undefined }),
    UploadTooLargeError,
  );
  assert.equal(read, 0, "the body was read before the declared bound was checked");
});

test("a chunked body is counted as it arrives, and stops the request where the bound is passed", async () => {
  const payload = body([["files", "x".repeat(64), "big.txt"]]);
  const chunked = new Readable({
    read() {
      for (let offset = 0; offset < payload.byteLength; offset += 8) this.push(payload.subarray(offset, offset + 8));
      this.push(null);
    },
  });
  await assert.rejects(
    () => readUploadParts({ headers: headers(), body: chunked, totalBytes: 40, take: async () => undefined }),
    (error: unknown) => error instanceof UploadTooLargeError && error.limit === 40,
  );
});

test("a body inside the bound is read whole, and the default bound is the batch the surface states", async () => {
  const payload = body([["files", "small", "small.txt"]]);
  assert.deepEqual(await collect(Readable.from(payload)), [["small.txt", "small"]]);
  assert.equal(MAX_UPLOAD_BATCH_BYTES, 100 * 1024 * 1024);
});

test("a caller that refuses a part ends the request, and later parts are never handed on", async () => {
  const payload = body([["files", "first", "one.txt"], ["files", "second", "two.txt"]]);
  const seen: string[] = [];
  await assert.rejects(
    () => readUploadParts({
      headers: headers(),
      body: Readable.from(payload),
      take: async (part: UploadPart) => {
        seen.push(part.fileName);
        if (part.fileName === "two.txt") throw new Error("refused " + part.fileName);
      },
    }),
    /refused two.txt/,
  );
  assert.deepEqual(seen, ["one.txt", "two.txt"]);
});

test("a request with no file part hands nothing on, and a body that dies is a failure rather than a short file", async () => {
  assert.deepEqual(await collect(Readable.from(body([["note", "nothing to upload"]]))), []);

  const truncated = body([["files", "partial", "partial.txt"]]);
  const dying = new Readable({
    read() {
      this.push(truncated.subarray(0, 40));
      this.destroy(new Error("connection reset"));
    },
  });
  await assert.rejects(() => readUploadParts({ headers: headers(), body: dying, take: async () => undefined }), /connection reset/);
});
