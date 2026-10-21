import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer } from "../src/server.ts";

const directories: string[] = [];
const token = "rename-token";
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function start(t: TestContext, dbPath?: string): Promise<{ backend: BackendServer; origin: string; dbPath: string }> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-rename-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "rename.sqlite");
  const backend = await createBackendServer({ dbPath: path, authToken: token });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path };
}

function headers(): HeadersInit { return { authorization: "Bearer " + token, "content-type": "application/json" }; }
type Row = { id: string; title: string | null; firstMessage: string };
async function catalogue(origin: string): Promise<Row[]> {
  const response = await fetch(origin + "/api/conversations", { headers: headers() });
  assert.equal(response.status, 200);
  return (await response.json() as { conversations: Row[] }).conversations;
}
async function rename(origin: string, id: string, name: unknown): Promise<Response> {
  return fetch(origin + "/api/conversations/" + encodeURIComponent(id), { method: "PATCH", headers: headers(), body: JSON.stringify({ name }) });
}
async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers: headers(), body: JSON.stringify({}) });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

test("a rename is answered as success and the same catalogue read that lists sessions carries the name", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  const before = await catalogue(server.origin);
  assert.equal(before.find((row) => row.id === id)?.title, null, "a conversation with no title states the absence");

  const answer = await rename(server.origin, id, "Release checklist");
  assert.equal(answer.status, 200);
  assert.equal((await answer.json() as { name: string }).name, "Release checklist");

  // One read, every session, each one's own name: the row that was renamed and the rows that were not.
  const rows = await catalogue(server.origin);
  assert.equal(rows.find((row) => row.id === id)?.title, "Release checklist");
  assert.equal(rows.filter((row) => row.id !== id).every((row) => row.title === null), true);
});

test("the name survives a backend restart", async (t) => {
  const first = await start(t);
  const id = await createConversation(first.origin);
  assert.equal((await rename(first.origin, id, "Durable name")).status, 200);
  await first.backend.close();

  const second = await start(t, first.dbPath);
  const rows = await catalogue(second.origin);
  assert.equal(rows.find((row) => row.id === id)?.title, "Durable name");
});

test("a refused rename leaves the previous name in place and reports the backend's reason", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  assert.equal((await rename(server.origin, id, "Kept")).status, 200);

  const unknown = await rename(server.origin, "999999", "Whatever");
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json() as { error: string }).error, /not found/);

  const empty = await rename(server.origin, id, "   ");
  assert.equal(empty.status, 400);
  assert.match((await empty.json() as { error: string }).error, /1 to 80 characters/);

  const long = await rename(server.origin, id, "x".repeat(81));
  assert.equal(long.status, 400);
  assert.match((await long.json() as { error: string }).error, /1 to 80 characters/);

  const missing = await fetch(server.origin + "/api/conversations/" + id, { method: "PATCH", headers: headers(), body: JSON.stringify({}) });
  assert.equal(missing.status, 400);
  assert.match((await missing.json() as { error: string }).error, /name is required/);

  assert.equal((await catalogue(server.origin)).find((row) => row.id === id)?.title, "Kept");
});

test("two clients of one backend read the same name after a rename", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  assert.equal((await rename(server.origin, id, "Shared")).status, 200);
  // Two independent catalogue reads are what two open windows each make; neither is told the other renamed anything.
  const [one, two] = await Promise.all([catalogue(server.origin), catalogue(server.origin)]);
  assert.equal(one.find((row) => row.id === id)?.title, "Shared");
  assert.deepEqual(two, one);
});

test("an over-long name is refused in code points, so a name the backend stores is never cut in half", async (t) => {
  const server = await start(t);
  const id = await createConversation(server.origin);
  assert.equal((await rename(server.origin, id, "🙂".repeat(80))).status, 200);
  assert.equal((await rename(server.origin, id, "🙂".repeat(81))).status, 400);
  assert.equal((await catalogue(server.origin)).find((row) => row.id === id)?.title, "🙂".repeat(80));
});
