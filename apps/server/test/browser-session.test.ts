import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserDurableSession } from "@hepi/session/browser";
import type { SessionState } from "@hepi/session";
import { createBackendServer } from "../src/server.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

test("pi-web connection adapter consumes real authenticated durable state and reconnects", { timeout: 2500 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-browser-"));
  // The adapter's turn really settles, so this suite injects the offline scripted catalog and its model explicitly.
  const backend = await createBackendServer({ dbPath: join(directory, "test.sqlite"), authToken: "token", models: fauxModels(), defaultModel: SERVER_MODEL });
  const clients: BrowserDurableSession[] = [];
  try {
    await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
    const address = backend.server.address();
    assert.ok(address && typeof address === "object");
    const origin = "http://127.0.0.1:" + address.port;
    // The runtime's own root conversation is a framework record and is never listed, so the conversation this test
    // drives is one it creates.
    const created = await fetch(origin + "/api/conversations", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { conversationId: string }).conversationId;
    let finish!: (state: SessionState) => void;
    let fail!: (error: unknown) => void;
    const completed = new Promise<SessionState>((resolve, reject) => { finish = resolve; fail = reject; });
    const revisions: number[] = [];
    const first = new BrowserDurableSession(origin, "token", id, state => {
      revisions.push(state.revision);
      if (state.entries.length === 2 && !state.busy) finish(state);
    }, fail);
    clients.push(first);
    await first.connect();
    await first.submit("adapter-request", "adapter hello");
    const final = await completed;
    assert.deepEqual(final.entries.map(entry => entry.text), ["adapter hello", "Server reply to: adapter hello"]);
    assert.ok(revisions.every((revision, index) => index === 0 || revision >= revisions[index - 1]!));
    first.close();
    const reconnected = new BrowserDurableSession(origin, "token", id, () => {}, fail);
    clients.push(reconnected);
    await reconnected.connect();
    assert.deepEqual(reconnected.session.state.entries, final.entries);
    assert.equal((await fetch(origin + "/diagnostics")).status, 200);
    assert.equal((await fetch(origin + "/api/conversations")).status, 401);
  } finally {
    for (const client of clients) client.close();
    await backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
