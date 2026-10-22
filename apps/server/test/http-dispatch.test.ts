import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer } from "../src/server.ts";

const directories: string[] = [];
const token = "dispatch-token";
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function start(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-dispatch-"));
  directories.push(directory);
  const backend: BackendServer = await createBackendServer({ dbPath: join(directory, "dispatch.sqlite"), authToken: token });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return "http://127.0.0.1:" + address.port;
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const call = (origin: string, method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("every domain owner is composed behind one admitted entry, which still answers what no owner claimed", async (t) => {
  const origin = await start(t);
  // Admission is the entry's and comes first: no route, owned or not, answers a caller that did not authenticate.
  assert.equal((await fetch(origin + "/api/conversations")).status, 401);
  assert.equal((await fetch(origin + "/api/not-a-route")).status, 401);

  // The fixed dispatch order is still the only routing: a path no owner claims keeps the entry's own answer, with the
  // code a client names it by, and it is not answered by whichever module was composed last.
  for (const path of ["/api/not-a-route", "/api/conversations/1/not-an-action", "/api/skill-market/not-a-route"]) {
    const answer = await call(origin, "GET", path);
    assert.equal(answer.status, 404, path);
    assert.equal((await answer.json() as { code?: string }).code, "not_found", path);
  }

  // A module that owns a path answers a method it does not serve itself, rather than letting the entry fall through to
  // its unknown-route answer: the refusal belongs beside the route that makes it.
  const extensions = await call(origin, "PUT", "/api/extensions");
  assert.equal(extensions.status, 405);
  assert.match((await extensions.json() as { error: string }).error, /method not allowed/);

  // The catalogue module owns the conversation paths that name no conversation yet, and its refusal of a page bound it
  // cannot honour is stated there instead of in the entry.
  assert.equal((await call(origin, "GET", "/api/conversations?limit=0")).status, 400);
  assert.equal((await call(origin, "GET", "/api/conversations?running=compact&limit=5")).status, 400);
  const empty = await call(origin, "GET", "/api/search?q=");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { protocol: "hepi.v1", results: [], truncated: false });
});

test("the retired operator pages are gone, and nothing is served ahead of admission", async (t) => {
  const origin = await start(t);
  // The backend used to serve two operator pages of its own ahead of admission. They are retired with their assets and
  // their build step, so the paths are no route at all rather than a page a caller can still reach — and no path is
  // served without the credential admission asks for, which is now the first thing every request passes.
  for (const path of ["/diagnostics", "/diagnostics.js", "/diagnostics.html", "/workbench", "/workbench.js", "/workbench.html"]) {
    assert.equal((await fetch(origin + path)).status, 401, path + " without admission");
    const answer = await call(origin, "GET", path);
    assert.equal(answer.status, 404, path);
    assert.equal((await answer.json() as { code?: string }).code, "not_found", path);
  }
});

test("the project and checkout routes decode and the registry answers, including its own refusals", async (t) => {
  const origin = await start(t);
  // No ProjectStore is configured for this deployment: the registry answers every mutation with its own outcome, and the
  // route states it instead of writing any metadata itself.
  const created = await call(origin, "POST", "/api/projects", { name: "x", folders: [{ root: "/", default: true }] });
  assert.equal(created.status, 409);
  assert.equal((await created.json() as { code?: string }).code, "configuration_required");

  // An unknown checkout operation is refused by the route that decoded it, not by the entry's unknown-route answer.
  const unknown = await call(origin, "POST", "/api/worktrees", { workspaceId: "w", operation: "nope" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { code?: string }).code, "invalid_request");

  // A checkout of a workspace this deployment does not serve keeps the registry's own refusal and status.
  const unserved = await call(origin, "POST", "/api/worktrees", { workspaceId: "nope", operation: "list" });
  assert.equal(unserved.status, 404);
  assert.equal((await unserved.json() as { code?: string }).code, "unknown_workspace");

  // The workbench proxy resolves the binding before it reads anything, and answers an unserved workspace the same way.
  const workbench = await call(origin, "POST", "/api/workbench", { workspaceId: "nope", operation: "files" });
  assert.equal(workbench.status, 404);
  assert.deepEqual(await workbench.json(), { ok: false, code: "unknown_workspace" });
});

test("a listing answers through the one catalogue projection the list, poll and creation all read", async (t) => {
  const origin = await start(t);
  const created = await call(origin, "POST", "/api/conversations", {});
  assert.equal(created.status, 201);
  const row = (await created.json() as { conversation: { id: string; title: string | null; workspaceId: string | null } }).conversation;
  assert.equal(row.title, null, "a conversation with no title states the absence");

  const listed = await call(origin, "GET", "/api/conversations");
  assert.equal(listed.status, 200);
  const body = await listed.json() as { conversations: { id: string }[]; projectsRevision: number };
  assert.equal(body.conversations.some(entry => entry.id === row.id), true);
  assert.equal(typeof body.projectsRevision, "number");

  // The running poll is the same projection: it reports the busy flag of the rows the list would have returned.
  const running = await call(origin, "GET", "/api/conversations?running=compact");
  assert.equal(running.status, 200);
  assert.deepEqual((await running.json() as { runningConversationIds: string[] }).runningConversationIds, []);
});
