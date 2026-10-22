import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createConversationAttachments } from "./conversation-attachments.ts";
import { openServerHarness } from "./harness.ts";

test("one attachment owns concurrent callers and close retires its views before Harness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-attachments-"));
  const runtime = await openServerHarness(join(directory, "state.sqlite"), undefined, undefined, undefined, { startPaused: true });
  let preparations = 0;
  const owner = createConversationAttachments({ harness: runtime.harness, rootId: runtime.root.id, installed: () => [], prepare: async () => { preparations++; } });
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const [first, second] = await Promise.all([owner.attach(conversation), owner.attach(conversation)]);
    assert.equal(first, second);
    assert.equal(preparations, 1);
    assert.equal(owner.get(String(conversation.id)), first);
    assert.equal([...owner.values()].length, 1);
    await owner.close();
    assert.equal([...owner.values()].length, 0);
    assert.equal(owner.get(String(conversation.id)), undefined);
    await assert.rejects(owner.attach(conversation), /attachments are closed/);
    assert.ok(await runtime.harness.conversation(conversation.id, BACKGROUND_CONTEXT), "the owner borrows Harness; closing views leaves durable records readable");
  } finally {
    await owner.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shutdown waits for an admitted attachment and publishes no late view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-attachments-close-"));
  const runtime = await openServerHarness(join(directory, "state.sqlite"), undefined, undefined, undefined, { startPaused: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const owner = createConversationAttachments({ harness: runtime.harness, rootId: runtime.root.id, installed: () => [], prepare: async () => { entered(); await gate; } });
  try {
    const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
    const opening = owner.attach(conversation);
    const rejected = assert.rejects(opening, /attachments are closed/);
    await preparing;
    const closing = owner.close();
    release();
    await Promise.all([rejected, closing]);
    assert.equal([...owner.values()].length, 0);
  } finally {
    release();
    await owner.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
