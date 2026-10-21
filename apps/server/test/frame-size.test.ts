import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const directories: string[] = [];
const token = "frame-size-token";
const headers: HeadersInit = { authorization: "Bearer " + token, "content-type": "application/json" };
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/**
 * A conversation whose newest entry carries content the frame budget cannot shrink away.
 *
 * A large **text** output is no longer such a case: text is deferred to a bounded preview behind a read block, exactly
 * as thinking and images are (see `history-text.test.ts`), so a turn that produces one is carried like any other. The
 * case that remains is content with no read block of its own — here a structured `toolCall` whose `input` carries a
 * multi-megabyte string. It is not deferred by any policy, the window shrinks until only that entry remains, and the
 * entry itself is never split or dropped. This is the limit the design still states, and it is recorded rather than
 * fixed here.
 */
async function oversizedConversation(t: TestContext): Promise<{ dbPath: string; id: string; entryId: string; input: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-frame-"));
  directories.push(directory);
  const dbPath = join(directory, "frame.sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const id = created.id as ConversationId;
  const input = "build log line: ".repeat(110_000);
  await harness.harness.commit(async (tx) => {
    await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: "run the build", timestamp: 0 }] });
    // The runtime's own tool-call shape (`id`, `name`, `arguments`), built by the provider's own helper so the entry
    // is exactly what a real generation appends: the one no deferral policy can shrink.
    await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/build.log", content: input }), { timestamp: 1 })] });
  }, BACKGROUND_CONTEXT);
  const entryId = (await harness.harness.commit(tx => tx.scanEntries({ conversationId: id }, 1, undefined), BACKGROUND_CONTEXT)).items[0]!.id;
  await harness.close();
  return { dbPath, id: String(id), entryId: String(entryId), input };
}

async function start(t: TestContext, dbPath: string): Promise<{ backend: BackendServer; origin: string }> {
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("ok")]);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port };
}

test("a read whose frame cannot be carried answers an actionable error, and the entry stays retrievable by id", async (t) => {
  const { dbPath, id, entryId, input } = await oversizedConversation(t);
  const server = await start(t, dbPath);

  // The state read: a named reason and the entry that caused it, never a transcript that claims completeness.
  const response = await fetch(server.origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 413);
  const body = await response.json() as { reason: string; entryId: string; bytes: number };
  assert.equal(body.reason, "frame_too_large");
  assert.equal(body.entryId, entryId, "the offending entry is named");
  assert.ok(body.bytes > 1024 * 1024, "and its size is stated: " + body.bytes);

  // The entry itself is never unreachable: the by-id read serves it whole, structured input and all.
  const entry = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + entryId, { headers });
  assert.equal(entry.status, 200);
  const served = await entry.json() as { entry: { message: { content: { type: string; arguments?: { content?: string }; input?: { content?: string } }[] } } };
  const call = served.entry.message.content[0]!;
  assert.equal(call.type, "toolCall");
  assert.equal(((call.arguments ?? call.input)!.content!).length, input.length, "the whole entry is still readable, not truncated");
});

test("the stream states the oversize baseline instead of writing a frame that would destroy the connection", async (t) => {
  const { dbPath, id } = await oversizedConversation(t);
  const server = await start(t, dbPath);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/events", { headers });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 4 && !text.includes("state_oversize"); index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(text, /event: state_oversize/, "the baseline is stated, not written");
  assert.match(text, /"reason":"frame_too_large"/);
  assert.doesNotMatch(text, /event: snapshot/, "no frame that would exceed the transport guard is written");

  // The stream stays open, so a later commit publishes normally: the connection was not destroyed.
  const submission = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "after-oversize", text: "still alive" }) });
  assert.equal(submission.status, 202);
  let rest = "";
  for (let index = 0; index < 200; index += 1) {
    // The deadline is cleared as soon as a chunk arrives: a race that keeps its timer pending would hold the process
    // open for the whole 5 s after the read had already answered, which is wall time no assertion needs.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("the stream was destroyed: " + rest)), 5000); }),
    ]).finally(() => clearTimeout(deadline));
    if (chunk.done) break;
    rest += decoder.decode(chunk.value, { stream: true });
    if (rest.includes("event: state")) break;
  }
  await reader.cancel();
  assert.match(rest, /event: state/, "a commit after the oversize baseline still publishes on the same stream");
});

test("a conversation inside the transport limit is unaffected: the state read answers the window as before", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-frame-ok-"));
  directories.push(directory);
  const dbPath = join(directory, "ok.sqlite");
  const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
  const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  await harness.harness.commit(tx => tx.appendEntry(UserEntry, created.id as ConversationId, { model: [{ role: "user", content: "hello", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  await harness.close();
  const server = await start(t, dbPath);
  const response = await fetch(server.origin + "/api/conversations/" + String(created.id) + "/state", { headers });
  assert.equal(response.status, 200);
});

test("a page that cannot be carried answers the same named refusal, and the entry stays readable by id", async (t) => {
  // The window refused the frame; a page over the same transcript must refuse it the same way rather than hand back a
  // 3 MB body that claims to be a page and says nothing about the size it could not carry.
  const { dbPath, id, entryId } = await oversizedConversation(t);
  const server = await start(t, dbPath);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/entries", { headers });
  assert.equal(response.status, 413);
  const body = await response.json() as { reason: string; entryId: string; bytes: number };
  assert.equal(body.reason, "frame_too_large");
  assert.equal(body.entryId, entryId, "the page names the entry it could not carry");
  assert.ok(body.bytes > 1024 * 1024, "and its size: " + body.bytes);

  // The refusal names the read that serves the entry whole, and that read still answers.
  const entry = await fetch(server.origin + "/api/conversations/" + id + "/entries/" + entryId, { headers });
  assert.equal(entry.status, 200);
});
