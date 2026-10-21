import assert from "node:assert/strict";
import { test } from "node:test";
import { filePayloadRoute } from "./file-payload.ts";

/**
 * The file payload routes, at the module that owns them.
 *
 * A payload route is the method and the path together, and nothing else decides it: the byte path answers a GET, the
 * two upload paths answer a POST, and every other pair is no payload route at all — which is what keeps a wrong method
 * from reaching a host write. What a caller reads on the wire stays in `test/file-transfer.test.ts`, through the
 * gateway's ordinary admitted entry.
 */

test("a file payload route is the path and the method together", () => {
  assert.equal(filePayloadRoute("/v1/files/bytes", "GET"), "bytes");
  assert.equal(filePayloadRoute("/v1/files/upload", "POST"), "upload");
  assert.equal(filePayloadRoute("/v1/files/upload-check", "POST"), "upload-check");
  // A write is never reached by a method that does not name it, and a read is never reached by a POST.
  assert.equal(filePayloadRoute("/v1/files/upload", "GET"), undefined);
  assert.equal(filePayloadRoute("/v1/files/upload-check", "GET"), undefined);
  assert.equal(filePayloadRoute("/v1/files/bytes", "POST"), undefined);
  // The JSON file RPC is not a payload route, and neither is a prefix of one.
  assert.equal(filePayloadRoute("/v1/files", "POST"), undefined);
  assert.equal(filePayloadRoute("/v1/files/bytes/extra", "GET"), undefined);
  assert.equal(filePayloadRoute("/v1/files/upload-", "POST"), undefined);
});
