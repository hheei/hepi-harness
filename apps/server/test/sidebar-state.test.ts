import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MAX_SESSION_UI_IDS_PER_REQUEST, MAX_SESSION_UI_REQUEST_BYTES } from "@hepi/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { readSidebarState, SidebarStateDoc, writeSidebarState } from "../src/sidebar-state.ts";

const TOKEN = "sidebar-state-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

type Fixture = { origin: string; backend: BackendServer; close(): Promise<void> };

/** One backend on the given store, so a restart reads the same database rather than a new one. */
async function start(dbPath: string): Promise<Fixture> {
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const backend = await createBackendServer({ dbPath, authToken: TOKEN, models });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    backend,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); },
  };
}

/** A store of its own, removed when the test ends. */
async function store(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hepi-sidebar-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "hepi.sqlite");
}

const readState = async (origin: string) => (await (await fetch(origin + "/api/sidebar-state", { headers })).json()).state;

function post(origin: string, body: unknown, init: RequestInit = {}) {
  return fetch(origin + "/api/sidebar-state", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

test("a write answers the state after the change, and a restart reads the same arrangement back", async (t) => {
  const dbPath = await store(t);
  const fixture = await start(dbPath);
  t.after(() => fixture.close());

  assert.deepEqual(await readState(fixture.origin), { version: 1, revision: 0, sessions: {}, projects: {} });
  const pinned = await (await post(fixture.origin, { action: "set", ids: ["7", "9"], pinned: true })).json();
  assert.equal(pinned.state.revision, 1);
  assert.deepEqual(Object.keys(pinned.state.sessions).sort(), ["7", "9"]);

  // A second client of the same backend reads what the first wrote, from the document rather than from its own storage.
  assert.deepEqual(await readState(fixture.origin), pinned.state);

  const archived = await (await post(fixture.origin, { action: "set", ids: ["7"], archived: true })).json();
  assert.equal(archived.state.revision, 2);
  assert.equal(typeof archived.state.sessions["7"].archivedAt, "number");
  assert.equal(archived.state.sessions["7"].pinnedAt, undefined, "no session is in both bands");
  assert.deepEqual(archived.state.sessions["9"], pinned.state.sessions["9"]);

  // Pinning an archived session restores it, in the same write.
  const restored = await (await post(fixture.origin, { action: "set", ids: ["7"], pinned: true })).json();
  assert.equal(restored.state.sessions["7"].archivedAt, undefined);
  assert.equal(typeof restored.state.sessions["7"].pinnedAt, "number");

  // A backend restart reads the arrangement out of its own store, not out of any process memory.
  await fixture.close();
  const restarted = await start(dbPath);
  t.after(() => restarted.close());
  assert.deepEqual(await readState(restarted.origin), restored.state);
});

test("a document of another version is not read as this one", async (t) => {
  // The value carries its own version, and a value of another version reads as an empty state rather than as this
  // shape: another version may mean other rules, so its fields are not reinterpreted. Written through the same
  // document path a real write uses, so this is the reader's own rule and not a hand-edited database.
  const dbPath = await store(t);
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const harness = await openServerHarness(dbPath, { provider: "faux", modelId: "faux-1" }, models);
  t.after(() => harness.close());

  await harness.harness.commit(async (tx) => {
    const draft = await tx.doc(SidebarStateDoc);
    draft.version = 2;
    draft.revision = 9;
    draft.sessions = { a: { pinnedAt: 1 } };
    draft.projects = { "/r": { pinnedAt: 1, root: "/r" } };
    draft.projectOrder = ["/r"];
  }, BACKGROUND_CONTEXT);
  assert.deepEqual(await readSidebarState(harness.harness), { version: 1, revision: 0, sessions: {}, projects: {} });

  // A write over it starts from the empty state this version reads and stores its own version.
  const written = await writeSidebarState(harness.harness, { action: "set", ids: ["b"], pinned: true });
  assert.equal(written.version, 1);
  assert.equal(written.revision, 1);
  assert.deepEqual(Object.keys(written.sessions), ["b"]);
  assert.deepEqual(await readSidebarState(harness.harness), written);
});

test("an unchanged write is accepted, writes nothing and answers the state as it was", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  const first = await (await post(fixture.origin, { action: "set", ids: ["a"], archived: true })).json();
  const noop = await (await post(fixture.origin, { action: "set", ids: ["b"], pinned: false })).json();
  assert.equal(noop.state.revision, first.state.revision, "nothing changed, so nothing was written");
  assert.deepEqual(noop.state, first.state);
});

test("a bulk archive is one intent and its undo restores every flag", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  const ids = Array.from({ length: 5 }, (_, index) => String(index));
  await post(fixture.origin, { action: "set", ids, pinned: true });
  const before = await readState(fixture.origin);
  const snapshot = ids.map((id) => ({ id, pinnedAt: before.sessions[id].pinnedAt, archivedAt: null, unreadAt: null }));

  const archived = await (await post(fixture.origin, { action: "set", ids, archived: true })).json();
  for (const id of ids) {
    assert.equal(archived.state.sessions[id].pinnedAt, undefined, "archiving unpins");
    assert.equal(typeof archived.state.sessions[id].archivedAt, "number");
  }

  const undone = await (await post(fixture.origin, { action: "restore", entries: snapshot })).json();
  assert.deepEqual(undone.state.sessions, before.sessions, "one action undoes the whole bulk archive");
});

test("an entry for a session that is no longer shown is harmless and is kept", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  // Nothing checks an id against the catalogue: an id the sidebar no longer lists is a normal entry.
  const written = await (await post(fixture.origin, { action: "set", ids: ["999999"], pinned: true })).json();
  assert.equal(typeof written.state.sessions["999999"].pinnedAt, "number");
  assert.deepEqual((await readState(fixture.origin)).sessions["999999"], written.state.sessions["999999"]);
});

test("project order and pins are written and read back as one document", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  await post(fixture.origin, { action: "add-projects", keys: ["/b", "/a"] });
  const pinned = await (await post(fixture.origin, { action: "pin-project", projectKey: "/a", root: "/A", pinned: true })).json();
  assert.equal(pinned.state.projects["/a"].root, "/A");
  assert.deepEqual(pinned.state.projectOrder, ["/a", "/b"], "a pin lands next to the band boundary");
  const moved = await (await post(fixture.origin, { action: "move-project", projectKey: "/b", anchorKey: "/a", position: "before", add: [] })).json();
  assert.deepEqual(moved.state.projectOrder, ["/b", "/a"]);

  // A project nobody shows any more keeps its saved place.
  await post(fixture.origin, { action: "pin-project", projectKey: "/gone", root: "/gone", pinned: false });
  assert.deepEqual((await readState(fixture.origin)).projectOrder, ["/b", "/a"]);
});

test("the unread marker is written by the same document and by the same rules", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  const marked = await (await post(fixture.origin, { action: "set-unread", ids: ["a", "b"], unread: true })).json();
  assert.equal(typeof marked.state.sessions.a.unreadAt, "number");
  const read = await (await post(fixture.origin, { action: "set-unread", ids: ["a"], unread: false })).json();
  assert.equal(read.state.sessions.a, undefined, "a read session with no other flag leaves no entry");
  assert.equal(typeof read.state.sessions.b.unreadAt, "number");
  assert.deepEqual((await readState(fixture.origin)).sessions, read.state.sessions);
});

test("a refused write leaves the state exactly as it was and reports the backend's reason", async (t) => {
  const fixture = await start(await store(t));
  t.after(() => fixture.close());

  const before = await (await post(fixture.origin, { action: "set", ids: ["a"], pinned: true })).json();
  const contentTypeCases: [RequestInit, number, string][] = [
    [{ headers: { authorization: "Bearer " + TOKEN, "content-type": "text/plain" } }, 415, "content-type"],
    [{ headers: { authorization: "Bearer " + TOKEN } }, 415, "content-type"],
  ];
  for (const [init, status, reason] of contentTypeCases) {
    const response = await post(fixture.origin, { action: "set", ids: ["b"], pinned: true }, init);
    assert.equal(response.status, status);
    assert.equal((await response.json()).reason, reason);
  }

  const refused: [unknown, string][] = [
    ["{ nope", "invalid-request"],
    [[], "invalid-request"],
    [{ action: "drop-everything" }, "invalid-request"],
    [{ action: "set", ids: ["a"], pinned: true, archived: true }, "invalid-request"],
    [{ action: "set", ids: [], archived: true }, "invalid-request"],
    [{ action: "set", ids: ["../escape"], pinned: true }, "invalid-request"],
    [{ action: "set", ids: Array.from({ length: MAX_SESSION_UI_IDS_PER_REQUEST + 1 }, (_, index) => String(index)), pinned: true }, "invalid-request"],
    [{ action: "move-project", projectKey: "/a", anchorKey: "/a", position: "before" }, "invalid-request"],
  ];
  for (const [body, reason] of refused) {
    const response = await post(fixture.origin, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await response.json()).reason, reason);
  }

  // A payload over the documented limit is refused without being applied.
  const oversized = JSON.stringify({ action: "add-projects", keys: ["x".repeat(4096)] });
  const padded = oversized + " ".repeat(MAX_SESSION_UI_REQUEST_BYTES - oversized.length + 1);
  const large = await post(fixture.origin, padded);
  assert.equal(large.status, 413);
  assert.equal((await large.json()).reason, "too-large");

  assert.deepEqual(await readState(fixture.origin), before.state, "every refusal left the state exactly as it was");
});
