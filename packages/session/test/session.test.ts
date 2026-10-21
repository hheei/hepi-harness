import assert from "node:assert/strict";
import test from "node:test";
import { DurableSession } from "../src/index.ts";

test("serializes submissions through one durable session client", async () => {
  const calls: { body?: BodyInit | null }[] = []; 
  const client = new DurableSession("http://server", "token", "c1", async (input, init) => { calls.push({ body: init?.body }); return new Response(JSON.stringify({ protocol: "hepi.v1", requestId: "r1", submissionId: "s1" }), { status: 202, headers: { "content-type": "application/json" } }); });
  const result = await client.submit("r1", "hello");
  assert.deepEqual(result, { protocol: "hepi.v1", requestId: "r1", submissionId: "s1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body, JSON.stringify({ protocol: "hepi.v1", requestId: "r1", type: "conversation.submit", text: "hello" }));
});
