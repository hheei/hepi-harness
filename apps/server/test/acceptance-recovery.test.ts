/**
 * Ticket 13's combined recovery chain: the control windows, each killed in its own **backend process** over its own
 * SQLite file, and read back through the same product routes the killed process served.
 *
 * The narrow windows themselves already have native evidence at their owning tickets (01's stop/continue commits, 09's
 * per-item decisions, 07's report admission, 06's creation/admission). What this file adds is the **combination** the
 * acceptance table asks for and no single ticket could state: one backend process, the real HTTP surface, a stop that is
 * committed but not drained, a continue whose answer never reached the caller, and a newer stop that outlives an older
 * continue's retry — each followed by a reopen that re-reads the decisions through HTTP.
 *
 * Every assertion reads a fact a user or a client can read: the control record, its receipt, the queued texts, the
 * committed transcript and the model requests the reopened process served (spec D04-D09, D16, A19-A21).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer, type ServerSnapshot } from "../src/server.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const crashChild = fileURLToPath(new URL("./acceptance-crash-backend.ts", import.meta.url));
const token = "acceptance-crash-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

type StageRun = { status: number | null; signal: string | null; stdout: string; stderr: string };

/** Run one stage in its own process over the test's own SQLite file. */
function runStage(stage: string, dbPath: string, base: string): StageRun {
  const result = spawnSync(process.execPath, [crashChild, stage, dbPath, base], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The facts line a stage printed at its kill point; a stage that reached no window exits non-zero instead. */
function facts(run: StageRun): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "the stage printed no facts: " + run.stderr + run.stdout);
  return JSON.parse(line) as Record<string, unknown>;
}

type Rig = {
  readonly origin: string;
  readonly conversationId: string;
  readonly requests: () => number;
  close: () => Promise<void>;
};

/**
 * Reopen the same SQLite file in this process, through the real backend, so every recovered fact is read through the
 * routes the killed process served. The controlled model answers immediately: these windows are about what the store
 * held, not about holding a model again.
 */
async function reopen(dbPath: string, conversationId: string): Promise<Rig> {
  const faux = fauxProvider();
  const respond: FauxResponseFactory = async (): Promise<AssistantMessage> => {
    faux.setResponses([respond]);
    return fauxAssistantMessage("recovered answer " + faux.state.callCount);
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath, authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    conversationId,
    requests: () => faux.state.callCount,
    close: async () => { backend.server.closeAllConnections(); await backend.close(); },
  };
}

const post = (rig: Rig, path: string, body?: unknown) => fetch(rig.origin + path, { method: "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const readJson = async <T>(rig: Rig, path: string): Promise<T> => {
  const response = await fetch(rig.origin + path, { headers });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as T;
};
const state = (rig: Rig) => readJson<ServerSnapshot>(rig, "/api/conversations/" + rig.conversationId + "/state");
const control = (rig: Rig, requestId?: string) => readJson<{ control: ServerSnapshot["control"]; receipt: { requestId: string; operation: string; status: string; revision: number } | null }>(rig, "/api/conversations/" + rig.conversationId + "/control" + (requestId === undefined ? "" : "?requestId=" + encodeURIComponent(requestId)));
const userTexts = (current: ServerSnapshot): string[] => current.entries.filter((entry) => entry.role === "user").map((entry) => entry.text);

/** Poll a real condition on the committed state, so a loaded machine cannot race a fixed sleep. */
async function waitForState(rig: Rig, ready: (current: ServerSnapshot) => boolean, what: string): Promise<ServerSnapshot> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await state(rig);
    if (ready(current)) return current;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what + ": " + JSON.stringify({ busy: current.busy, control: current.control, queued: current.queuedMessages, entries: current.entries.length }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** One test-owned directory holding the SQLite file both processes use; never the deployment's own store. */
async function directory(t: { after(fn: () => Promise<void>): void }): Promise<{ dir: string; dbPath: string; base: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hepi-acceptance-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dbPath: join(dir, "acceptance.sqlite"), base: dir };
}

test("a real SIGKILL in the stop's undrained window keeps the hold, the receipt and the report that arrived after it", { timeout: 90_000 }, async (t) => {
  const { dbPath, base } = await directory(t);
  const killed = runStage("stop-drain", dbPath, base);
  assert.equal(killed.status, null, killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  const stated = facts(killed);
  assert.equal(stated.stage, "stop-drain");
  assert.equal(stated.drain, "stopping", "the kill landed before the ordinary scope drained");

  const rig = await reopen(dbPath, String(stated.conversationId));
  t.after(() => rig.close());

  // The hold, its revision and its trusted source are the killed process's own decision, read back over HTTP.
  const recovered = await control(rig, "stop-1");
  assert.equal(recovered.control.state, "held");
  assert.equal(recovered.control.revision, 1);
  assert.equal(recovered.control.stopSource, "user");
  assert.equal(recovered.receipt?.status, "accepted");
  assert.deepEqual(recovered.control, stated.control);
  // The late report is still queued and the restart alone consumed nothing.
  const held = await waitForState(rig, (current) => !current.busy, "the recovered drain to settle");
  assert.deepEqual(held.queuedMessages.followUp, ["late report"]);
  assert.equal(rig.requests(), 0, "reopening a held conversation serves no model request");
  // The aborted run's own text was placed before the stop, so it stays in the transcript; the held report does not.
  assert.deepEqual(userTexts(held), ["long run"], "the held report is still outside the transcript");

  // The user's own continue consumes it once, and a retry of the same request id changes nothing.
  const resumed = await post(rig, "/api/conversations/" + rig.conversationId + "/continue", { requestId: "continue-1" });
  assert.equal(resumed.status, 202, await resumed.clone().text());
  const settled = await waitForState(rig, (current) => !current.busy && userTexts(current).length === 2, "the recovered report to run");
  // The aborted run's text stays where it was placed; the held report is what the user's continue put after it.
  assert.deepEqual(userTexts(settled), ["long run", "late report"]);
  assert.equal(rig.requests(), 1);
  const retry = await post(rig, "/api/conversations/" + rig.conversationId + "/continue", { requestId: "continue-1" });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json() as { status: string }).status, "resumed");
  assert.equal(rig.requests(), 1, "a replayed continue serves no second request");
});

test("a real SIGKILL inside the continue's own answer keeps the resume receipt and consumes the kept item once", { timeout: 90_000 }, async (t) => {
  const { dbPath, base } = await directory(t);
  const killed = runStage("continue-answer", dbPath, base);
  assert.equal(killed.status, null, killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  const stated = facts(killed);
  assert.equal(stated.stage, "continue-answer");
  assert.deepEqual(stated.control ? (stated.control as { state: string }).state : "", "allowed");

  const rig = await reopen(dbPath, String(stated.conversationId));
  t.after(() => rig.close());

  // The resume decision survived with its own receipt even though its HTTP answer never reached the caller.
  const recovered = await control(rig, "continue-1");
  assert.equal(recovered.control.state, "allowed");
  assert.equal(recovered.receipt?.operation, "continue");
  assert.equal(recovered.receipt?.status, "resumed");
  assert.equal((recovered.receipt as { revision: number }).revision, (stated.receipt as { revision: number }).revision);
  // The kept item was consumed by the resumed turn, once: a replay of the same continue admits nothing again.
  const settled = await waitForState(rig, (current) => !current.busy && userTexts(current).length === 1, "the kept report to run");
  assert.deepEqual(userTexts(settled), ["kept report"]);
  const requests = rig.requests();
  const replay = await post(rig, "/api/conversations/" + rig.conversationId + "/continue", { requestId: "continue-1" });
  assert.equal(replay.status, 202, await replay.clone().text());
  assert.equal((await replay.json() as { status: string }).status, "resumed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(rig.requests(), requests, "the replayed continue served no additional request");
  assert.deepEqual(userTexts(await state(rig)), ["kept report"]);
});

test("a real SIGKILL after a newer stop leaves the older continue superseded and the newer hold in force", { timeout: 90_000 }, async (t) => {
  const { dbPath, base } = await directory(t);
  const killed = runStage("newer-stop-old-continue", dbPath, base);
  assert.equal(killed.status, null, killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  const stated = facts(killed);
  assert.equal(stated.stage, "newer-stop-old-continue");
  assert.equal((stated.control as { revision: number }).revision, 2, "the newer stop committed its own revision");

  const rig = await reopen(dbPath, String(stated.conversationId));
  t.after(() => rig.close());

  // The newer stop is what holds, and the queue it kept is still there: the kill changed neither.
  const recovered = await control(rig, "stop-b");
  assert.equal(recovered.control.state, "held");
  assert.equal(recovered.control.revision, 2);
  const held = await waitForState(rig, (current) => !current.busy, "the recovered drain to settle");
  assert.deepEqual(held.queuedMessages.followUp, ["kept report"]);
  assert.equal(rig.requests(), 0, "the restart consumed nothing that the newer stop held");

  // The older continue's retry is refused as superseded and changes nothing; the fresh continue resumes.
  const stale = await post(rig, "/api/conversations/" + rig.conversationId + "/continue", { requestId: "continue-a" });
  // A refused intent is a refusal on the wire as well as in the body, which is what a caller acts on.
  assert.equal(stale.status, 409, await stale.clone().text());
  const staleBody = await stale.json() as { status: string; reason?: string };
  assert.equal(staleBody.status, "rejected", JSON.stringify(staleBody));
  assert.equal(staleBody.reason, "superseded", JSON.stringify(staleBody));
  assert.equal((await control(rig)).control.state, "held");
  assert.equal(rig.requests(), 0, "a superseded continue starts no run");
  const fresh = await post(rig, "/api/conversations/" + rig.conversationId + "/continue", { requestId: "continue-b" });
  assert.equal(fresh.status, 202, await fresh.clone().text());
  const settled = await waitForState(rig, (current) => !current.busy && userTexts(current).length === 2, "the kept report to run after the fresh continue");
  assert.deepEqual(userTexts(settled), ["long run", "kept report"]);
  assert.equal(rig.requests(), 1);
});
