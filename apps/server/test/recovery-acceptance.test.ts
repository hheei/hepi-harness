/**
 * Ticket 04: the crash windows the capability audit left unmeasured, measured on this revision.
 *
 * Gap G3 is the system-level recovery of a **delegated child's** command whose gateway answer is lost. The audit found
 * that shape only for the parent's own coding tools (`execution-scope.test.ts`), only for a stream that broke while the
 * host stayed alive (`packages/gateway/test/execution.test.ts`), and never for a child conversation with its own anchor
 * and reporter, on a gateway that is really dead, over a call journal that really outlives it.
 *
 * Gap G4 is a process that dies **while an answer streams**. Upstream states that a committed partial survives as an
 * assistant entry whose response ended and that the run resumes; before this file that was tested only as a property of
 * pi-durable's internals, never across a `SIGKILL` of this application's own process and a reopen of its own store.
 *
 * Gap G5 is what the surfaces say about a conversation whose task records were written by a definition this build does
 * not ship. The projection and the refusal wording existed; only `missing_task` had a crash test, and `task_too_old` and
 * `migration_failed` had no evidence on any revision, no test, and no route that reached them.
 *
 * The method is the one `acceptance-recovery.test.ts` and `acceptance-failure.test.ts` established: run a stage that
 * reaches the window, end a real process with `SIGKILL`, reopen the same SQLite over the same path through the product's
 * own entrypoint, and assert that the durable records and what the surfaces publish agree — and state no more than
 * either supports. Each reopened store has exactly one owner: the HTTP backend for a store the backend or a crash stage
 * wrote, the crash harness for a store the harness wrote.
 *
 * What this file does **not** do, as the ticket requires:
 * - no test that reaches the path without the ledger identity by widening an allowlist or dropping the token; ticket 01
 *   measured that boundary and its conclusion stands
 * - no retries and no replay-policy change; a call identity that is spent is not re-earned here
 * - no power-loss, disk-full, kill-during-commit or corrupt-journal claim: `SIGKILL` is a process end, and that is the
 *   only window these tests can honestly stand behind
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer } from "../src/server.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { projectRunStatus } from "../src/subagents/status.ts";
import { openCrashHarness } from "./subagents-crash-harness.ts";
import { FutureAnchorTask } from "./subagent-anchor-v2.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { executeRequest, requireFacts, startRequestWitness, startGatewayHost } from "./recovery-acceptance-host.ts";

const TOKEN = "recovery-acceptance-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const CHILD = "test/recovery-acceptance-child.ts";
const GATEWAY_ID = "workstation";
const WORKSPACE_ID = "local";
const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

type Snapshot = {
  busy: boolean;
  partial: string;
  entries: { id: string; role: string; text: string; message: { stopReason?: string; isError?: boolean; toolName?: string } }[];
};
type Row = {
  id: string;
  workspaceId: string | null;
  busy: boolean;
  runStatus: { state: string; reason?: string };
  createdBy?: string;
  subagentParentConversationId?: string;
};

/**
 * Run one stage of the child script and wait for it to end.
 *
 * This is a real asynchronous spawn rather than `spawnSync`, and it has to be: the `child-bash` stage's commands run
 * against a gateway this test owns, through a witness hop that lives in **this** process. A blocking spawn would stop
 * this process from answering, and the stage would then be measuring a fixture that could not reply, not a lost call.
 *
 * `killed` states which process the window ends — the stage itself, or the gateway host the test owns (whose death the
 * caller asserts on the host's own signal). A stage that exits where it was supposed to be killed, or is killed where
 * it was supposed to settle, is a window that was never reached, so the outcome is asserted and not assumed.
 */
async function runStage(args: readonly string[], killed: "stage" | "host"): Promise<{ stdout: string; stderr: string }> {
  const staged = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CHILD, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => { out.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { err.push(chunk); });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => { resolveRun({ stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), code, signal }); });
  });
  if (killed === "stage") {
    assert.equal(staged.code, null, "the stage exited on its own instead of being killed: " + staged.stderr + staged.stdout);
    assert.equal(staged.signal, "SIGKILL", "the stage was ended by " + String(staged.signal) + ", not SIGKILL: " + staged.stderr);
  } else {
    assert.equal(staged.code, 0, "the stage did not settle after its host died: " + staged.stderr + staged.stdout);
  }
  return staged;
}

async function readState(origin: string, id: string): Promise<Snapshot> {
  const answer = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(answer.status, 200, await answer.clone().text());
  return await answer.json() as Snapshot;
}

async function listConversations(origin: string, query = ""): Promise<Row[]> {
  const answer = await fetch(origin + "/api/conversations" + query, { headers });
  assert.equal(answer.status, 200, await answer.clone().text());
  return (await answer.json() as { conversations: Row[] }).conversations;
}

async function waitFor<T>(ready: () => Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ready();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

/** The gateway the `child-bash` stage ran against: a real host process, its journal, and the requests it was sent. */
async function openGatewayHost(base: string) {
  // The host serves the workspace the stage will write its agent definition into, so both exist before it starts.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(base, "workspace", ".pi", "agents"), { recursive: true });
  await mkdir(join(base, "gateway-home/.pi/agent"), { recursive: true });
  const common = {
    token: TOKEN,
    gatewayId: GATEWAY_ID,
    workspaceId: WORKSPACE_ID,
    workspaceRoot: join(base, "workspace"),
    allowedCommands: ["printf", "sleep", "bash"],
    journalPath: join(base, "gateway.db"),
    home: join(base, "gateway-home"),
    pidPath: join(base, "gateway.pid"),
  };
  let host = await startGatewayHost(common);
  // The application's gateway origin points at a hop that records the execution requests the environment really sent
  // and forwards every answer untouched. It decides nothing: when the host dies, its response ends with no result.
  let witness = await startRequestWitness(host.origin, TOKEN);
  return {
    get origin() { return witness.origin; },
    requests: () => witness.requests(),
    output: () => host.output(),
    ended: host.ended,
    kill: () => { host.kill(); },
    /** Bring the same journal back: the only way the durable half of G3 can be measured. */
    restart: async () => {
      host = await startGatewayHost(common);
      const previous = witness;
      witness = await startRequestWitness(host.origin, TOKEN);
      await previous.close();
      return witness.origin;
    },
    close: async () => { host.kill(); await witness.close(); },
  };
}

/**
 * The backend that reopens a killed store: the product's own composition over the same path, and a model catalog whose
 * only provider is the caller's script. Every assertion below is answered through an HTTP route, because that is what
 * the surfaces read.
 */
async function openReopenedBackend(dbPath: string, options: { gatewayOrigin?: string; script?: (transcript: { messages: readonly unknown[] }) => string } = {}) {
  const faux = fauxProvider();
  if (options.script !== undefined) {
    const decide = options.script;
    const respond: FauxResponseFactory = async (transcript) => {
      faux.setResponses([respond]);
      return fauxAssistantMessage(decide(transcript));
    };
    faux.setResponses([respond]);
  }
  const models = createModels();
  models.setProvider(faux.provider);
  const gateway = options.gatewayOrigin === undefined ? undefined : { gatewayId: GATEWAY_ID, gatewayOrigin: options.gatewayOrigin, gatewayToken: TOKEN };
  const backend = await createBackendServer({
    dbPath,
    authToken: TOKEN,
    models,
    defaultModel: SERVER_MODEL,
    ...(gateway === undefined ? {} : { workspaces: [{ id: WORKSPACE_ID, ...gateway }], gateways: [gateway] }),
  });
  await new Promise<void>((resolveListen) => backend.server.listen(0, "127.0.0.1", resolveListen));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    origin: "http://127.0.0.1:" + address.port,
    requests: () => faux.state.callCount,
    close: async () => { await backend.server.closeAllConnections(); await backend.close(); },
  };
}

// ── G3: the delegated child's command, and the gateway process that owed the answer ────────────────────────────

test("a delegated child's command whose gateway process dies is told to the child as an outcome it can read, and the restarted journal refuses the spent call identity without running the command twice", { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "recovery-03-child-bash-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.db");
  const effectLog = join(base, "workspace", "effect.log");
  const host = await openGatewayHost(base);
  try {
    // The stage runs the child and waits for the loss; this test owns the host process, so this test makes the kill.
    const staging = runStage(["child-bash", dbPath, base, host.origin, join(base, "gateway.pid")], "host");
    // The window is stated by the command's own effect on the host, not by a guess about time: the line on disk means
    // the call was admitted, dispatched and answered by nothing. Ending the host earlier would measure a call that was
    // never made, so the kill waits for the effect the running command produced.
    const effectLog = join(base, "workspace", "effect.log");
    await waitFor(async () => ((await readFile(effectLog, "utf8").catch(() => "")).includes("running") ? true : undefined), "the child's command to run on the gateway host");
    host.kill();
    assert.deepEqual(await host.ended, { signal: "SIGKILL", code: null }, "the gateway host this test killed did not end by SIGKILL: " + host.output());
    const staged = await staging;
    const sent = host.requests();
    const facts = requireFacts(staged.stdout, staged.stderr);
    const childId = String(facts.childId);
    const parentId = String(facts.parentId);
    // The command's effect on the host is what makes this a lost **mutation** and not a call that never started.
    assert.deepEqual(facts.effects, ["running"], "the command did not run on the host, so nothing was lost: " + staged.stderr);
    // The one execution request the child made, exactly as the environment sent it: the identity a replay is judged
    // against. Handing the restarted journal a rebuilt request could differ in a field nobody thought of.
    assert.equal(sent.length, 1, "the child made " + String(sent.length) + " execution requests, not one: " + staged.stderr);
    const request = JSON.parse(sent[0]) as Record<string, unknown>;
    assert.ok(String(request.callId).startsWith(childId + ":"), "the child's call is not scoped to its own conversation: " + request.callId);
    assert.ok(String(request.callId).includes("call-hang"), "the recorded call is not the child's tool call: " + sent[0]);

    // What the child's model was handed for the call it made: the loss named, with the identity that is spent. It is
    // committed in the child's own transcript, so this is the seam the child's next request reads.
    const resultText = String(facts.resultText);
    assert.equal(facts.resultIsError, true, resultText);
    assert.match(resultText, /outcome_unknown/u);
    assert.match(resultText, /the command may have run and its outcome is not established/u);
    assert.match(resultText, /this call is never replayed/u);
    assert.match(resultText, new RegExp(String(request.callId), "u"), "the child was not told which call identity is spent");
    // The child continued on that stated outcome rather than hanging or guessing, and its report went to its parent.
    const transcript = (facts.childTranscript as [string, string][]).map(row => row[1]).join("\n");
    assert.match(transcript, /child settled/u, "the child did not finish its own turn on the stated outcome");
    assert.equal(facts.resultCount, 1, "the lost call produced more than one tool result: " + JSON.stringify(facts.resultText));
    // The delegation's own durable identities are unchanged by the loss, and its report still reached the parent: the
    // child settled, so the dispatch is reported rather than left waiting for a command nobody will answer.
    assert.notEqual(String(facts.anchorTaskId), "");
    assert.notEqual(String(facts.reporterTaskId), "");
    const parentTranscript = (facts.parentTranscript as [string, string][]).map(row => row[1]).join("\n");
    assert.match(parentTranscript, /finished with status/u, "the parent was never told its child ended: " + JSON.stringify(facts.parentTranscript));
    assert.match(parentTranscript, /child settled/u, "the report the parent was given is not the child's settled answer: " + parentTranscript);
    // Nothing about the lost command became a **work** state. The delegation's anchor is a background task parked for
    // the life of the child, which is what it was before the crash and what it stays; what matters is that no ordinary
    // task of either conversation is left claimed as work by this build, because the loss settled rather than stalled.
    const tasks = facts.tasks as { kind: string; state: string; background: boolean }[];
    assert.deepEqual(tasks.filter(task => !task.background && task.state === "running"), [], "the loss left ordinary work running: " + JSON.stringify(tasks));
    // The anchor is still live and still a **background** task: the inspection the surfaces read holds no ordinary
    // work for either conversation, which is why neither is shown as running (spec D12's distinction, measured here).
    assert.ok(tasks.every(task => task.background), "the loss left an ordinary task live on this delegation: " + JSON.stringify(tasks));

    // The restarted journal answers the identical call with its own rule and its own reason, and the effect never doubled.
    const restarted = await host.restart();
    const refused = await executeRequest(restarted, TOKEN, sent[0]);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, "outcome-unknown");
    assert.equal(refused.callId, request.callId, "the journal answered under a different identity than the spent one");
    assert.equal(refused.message, "gateway restarted while the call was running", "the journal's own reason was rewritten");
    assert.deepEqual((await readFile(effectLog, "utf8")).split("\n").filter(Boolean), ["running"], "the restarted gateway replayed the child's command");

    // Reopen the child's records over the same store, now through the surfaces a user reads. The gateway it points at
    // is the restarted one: the same journal, so the durable statement of the loss is the same one the child got.
    const reopened = await openReopenedBackend(dbPath, { gatewayOrigin: restarted });
    try {
      const listed = await listConversations(reopened.origin);
      const child = listed.find(row => row.id === childId);
      const parent = listed.find(row => row.id === parentId);
      assert.ok(child !== undefined && parent !== undefined, "the crash left the parent or its child out of the catalogue: " + JSON.stringify(listed));
      // The child is still the parent's, in the same workspace, and the loss is not a reason to erase the relation.
      assert.equal(child.createdBy, parentId);
      assert.equal(child.subagentParentConversationId, parentId);
      assert.equal(child.workspaceId, WORKSPACE_ID);
      assert.equal((await listConversations(reopened.origin, "?createdBy=" + parentId)).length, 1, "the parent's child tree did not survive the loss");
      // The transcript a reopen reads still states the loss, with the spent identity: nothing was rewritten or forgotten.
      const settled = await readState(reopened.origin, childId);
      const carried = settled.entries.find(entry => entry.role === "toolResult" && entry.message.isError === true);
      assert.ok(carried !== undefined, "the reopened child holds no error result: " + JSON.stringify(settled.entries));
      assert.match(carried.text, /outcome_unknown/u);
      assert.match(carried.text, new RegExp(String(request.callId), "u"));
      assert.ok(settled.entries.some(entry => entry.role === "assistant" && entry.text === "child settled"));
      // A lost command is not a failed delegation: neither conversation is busy, held, blocked or interrupted, because
      // both settled on a stated outcome. Any other state here would be a status the surfaces had to interpret.
      assert.equal(settled.busy, false);
      assert.deepEqual(child.runStatus, { state: "idle" }, "the child's status became a guess: " + JSON.stringify(child.runStatus));
      assert.deepEqual(parent.runStatus, { state: "idle" }, "the parent's status became a guess: " + JSON.stringify(parent.runStatus));
      // And the reopened store did not re-send anything for the dead call: no provider turn was needed to read it back.
      assert.equal(reopened.requests(), 0, "reopening sent " + String(reopened.requests()) + " provider requests for a settled child");
    } finally {
      await reopened.close();
    }
  } finally {
    await host.close();
  }
});

// ── G4: the process dies mid-generation ───────────────────────────────────────────────────────────────────────

test("a process killed while an answer streams keeps the partial it had committed as an ended assistant entry, and the reopened run takes that turn up once rather than replaying the dead request", { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "recovery-03-mid-generation-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.db");
  const staged = await runStage(["mid-generation", dbPath, base], "stage");
  const facts = requireFacts(staged.stdout, staged.stderr);
  const parentId = String(facts.parentId);
  const partial = String(facts.partial);
  const fullText = String(facts.fullText);
  // The window is real: the runtime had committed a prefix of the streaming answer, and no answer existed yet.
  assert.match(partial, /^tok-0 tok-1 tok-2/u);
  assert.notEqual(partial, fullText, "the answer had already streamed whole, so nothing was interrupted");
  assert.equal(facts.busy, true, "the run was not in flight at the kill: " + staged.stderr);
  assert.equal(facts.committedAnswer, false, "the answer was already committed, so nothing was interrupted");
  assert.equal(facts.providerRequests, 1);

  // What the reopened catalog is asked decides its answer, and the script records every transcript it was handed:
  // that record is what separates "the run resumed from its committed progress" from "the dead request was replayed".
  const asked: { roles: string; lastUser: string }[] = [];
  const reopened = await openReopenedBackend(dbPath, {
    script: ({ messages }) => {
      asked.push({ roles: messages.map(message => (message as { role?: string }).role).join(","), lastUser: lastUser(messages) });
      return "the resumed answer " + String(asked.length);
    },
  });
  try {
    // The reopened run takes up its interrupted turn by itself: nobody re-submits it, so the first thing the store does
    // with a catalog is continue the work the dead process left.
    const settled = await waitFor(async () => {
      const current = await readState(reopened.origin, parentId);
      return !current.busy && current.entries.some(entry => entry.role === "assistant" && entry.text.startsWith("the resumed answer")) ? current : undefined;
    }, "the reopened conversation to finish the turn it had in flight");
    const listed = await listConversations(reopened.origin);
    const row = listed.find(entry => entry.id === parentId);
    assert.ok(row !== undefined, "the interrupted conversation left the catalogue: " + JSON.stringify(listed));
    // Upstream's documented rule, measured across this application's own process boundary: what the dead process had
    // committed survives as an assistant entry whose response ended. Its text is the prefix and nothing else — no
    // invented completion, no lost progress, and no live partial a dead process is still publishing.
    const survivors = settled.entries.filter(entry => entry.role === "assistant" && entry.message.stopReason === "aborted");
    assert.equal(survivors.length, 1, "the committed partial did not survive as exactly one ended assistant entry: " + JSON.stringify(settled.entries));
    // The stage read a prefix, then the stream kept committing until the kill: what survives is that prefix, grown and
    // never shortened or replaced. It is the whole of what the dead process had committed of that answer.
    assert.ok(survivors[0].text.startsWith(partial), "the survived entry is not the prefix the stage saw, grown: " + JSON.stringify([partial, survivors[0].text]));
    assert.notEqual(survivors[0].text, fullText, "the answer had completed before the kill, so nothing was interrupted");
    const committed = survivors[0].text;
    assert.equal(settled.partial, "", "a partial from the dead process is still published as live text");
    // The reopened run asks **once**, for the interrupted turn itself: the user's own text is what it was handed, and
    // nobody had to submit it again. What it is **not** handed is the partial the dead process committed — the ended
    // entry survives for the reader, and the model resumes from the conversation as it stood before that answer began,
    // so the turn is restated rather than continued. That is a capability limit, recorded in
    // docs/migration-status.md, not something this test is free to call a continuation.
    assert.equal(asked.length, 1, "the reopened run sent " + String(asked.length) + " provider requests for the interrupted turn");
    assert.equal(asked[0].roles, "user", "the resumed request was not just the interrupted turn: " + JSON.stringify(asked));
    assert.equal(asked[0].lastUser, "stream the answer", "the user's own turn did not survive the crash: " + JSON.stringify(asked));
    // Both statements of the run stay in the transcript, oldest first: nothing was overwritten, and the partial was not
    // silently dropped when the answer after it arrived.
    assert.deepEqual(settled.entries.map(entry => [entry.role, entry.text]), [["user", "stream the answer"], ["assistant", committed], ["assistant", "the resumed answer 1"]]);
    // The conversation ends idle rather than held, blocked or interrupted: the resumed run settled on its own.
    assert.equal(row.busy, false);
    assert.deepEqual(row.runStatus, { state: "idle" }, "the restart became a status a surface has to interpret: " + JSON.stringify(row.runStatus));
  } finally {
    await reopened.close();
  }
});

/** The last user text of a transcript, which is the turn a reopened run takes up. */
function lastUser(messages: readonly unknown[]): string {
  const last = [...messages].reverse().find(message => (message as { role?: string }).role === "user") as { content?: unknown } | undefined;
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(block => String((block as { text?: string }).text ?? "")).join("");
  return "";
}

// ── G5: a task record whose definition this build does not ship ───────────────────────────────────────────────

test("a store whose anchor record is newer than this build's definition is blocked with task_too_old on the catalogue a user reads, and its child keeps its relation and stays readable", { timeout: 300_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "recovery-03-task-too-old-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.db");
  // The store, written by a build whose anchor definition was a version 2 one that could migrate this build's records:
  // the record it leaves is stamped 2, which is what this build reads and cannot take.
  const staged = await runStage(["anchor-v2", dbPath, base], "stage");
  const facts = requireFacts(staged.stdout, staged.stderr);
  const parentId = String(facts.parentId);
  const childId = String(facts.childId);
  assert.equal(facts.anchorVersion, 2, "the stage did not write the record at the version this fixture claims: " + staged.stderr);
  assert.equal(facts.anchorState, "running");
  assert.notEqual(String(facts.submissionId), "", "the admission never happened, so the record is not a live delegation");

  const reopened = await openReopenedBackend(dbPath);
  try {
    const listed = await listConversations(reopened.origin);
    const row = listed.find(entry => entry.id === parentId);
    assert.ok(row !== undefined, "the blocked conversation left the catalogue: " + JSON.stringify(listed));
    assert.equal(row.busy, false);
    // The user's surface states the refusal as the runtime's own reason, and the state says what it is: live work this
    // build cannot take, not work that finished and not work that failed.
    assert.deepEqual(row.runStatus, { state: "blocked", reason: "task_too_old" });
    // The child is neither orphaned nor deleted: it keeps its creator edge and its workspace, and its own records read.
    const child = listed.find(entry => entry.id === childId);
    assert.ok(child !== undefined, "the child of a blocked anchor left the catalogue: " + JSON.stringify(listed));
    assert.equal(child.createdBy, parentId);
    assert.equal(child.workspaceId, WORKSPACE_ID);
    const branch = await readState(reopened.origin, childId);
    assert.ok(branch.entries.some(entry => entry.role === "user" && entry.text === "child work"), "the child's admitted task is not readable: " + JSON.stringify(branch.entries));
    // Read twice: the refusal is a state of the records, not a first-read artifact that a second read would clear.
    const again = await listConversations(reopened.origin);
    assert.deepEqual(again.find(entry => entry.id === parentId)?.runStatus, { state: "blocked", reason: "task_too_old" });
  } finally {
    await reopened.close();
  }
});

test("a version 1 anchor record met by a version 2 definition with no migration is blocked with migration_failed, and the projection the catalogue uses states the same reason", { timeout: 300_000 }, async (t) => {
  // The other half of the same refusal. This build's own definition wrote the record, so no route this build ships can
  // meet it with a higher definition — which is why the seam here is the runtime's own inspection plus the single
  // projection the catalogue route calls. The reason is the runtime's; nothing here is a second opinion about it.
  const base = await mkdtemp(join(tmpdir(), "recovery-03-migration-failed-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "hepi.db");
  const staged = await runStage(["anchor-legacy", dbPath, base], "stage");
  const facts = requireFacts(staged.stdout, staged.stderr);
  const parentId = String(facts.parentId);
  const childId = String(facts.childId);
  const dispatchId = String(facts.dispatchId);
  const anchorTaskId = String(facts.anchorTaskId);
  assert.equal(facts.anchorVersion, 1, "the baseline record must be the version this build ships: " + staged.stderr);

  // Same store, same path: a definition at version 2 with no `migrate` to carry the record over.
  const reopened = await openCrashHarness(dbPath, { root: join(base, "workspace"), home: join(base, "home"), tasks: [FutureAnchorTask] });
  try {
    // The runtime's own resolution of the record, read from the one live-work inspection the catalogue route shares.
    const inspection = await reopened.harness.harness.inspect(BACKGROUND_CONTEXT);
    const own = inspection.tasks.filter(task => String(task.record.conversationId) === parentId);
    const blocked = own.find(task => String(task.record.id) === anchorTaskId)?.state;
    assert.ok(blocked !== undefined && blocked.kind === "blocked", "the anchor was not blocked by the runtime: " + JSON.stringify(own.map(task => task.state)));
    assert.equal(blocked.reason, "migration_failed");
    // The refusal is the runtime's own sentence about the definition it holds, not a summary this build wrote.
    // The reason travels with the runtime's own sentence about the definition it holds; the inspection types it as the
    // error it carried, so the text is read through that shape rather than assumed to be a string.
    assert.match(String((blocked.error as { message?: string } | undefined)?.message), /version 2 has no migration from 1/u);
    // The projection the catalogue route calls over those same facts: a blocked task is a state the surfaces publish,
    // and the reason is carried rather than mapped to something a caller can ignore.
    assert.deepEqual(projectRunStatus({ busy: false, control: { state: "allowed" }, tasks: own, waitingReport: false }), { state: "blocked", reason: "migration_failed" });
    assert.equal(own.length, 1, "the blocked anchor is not the only live work the parent holds: " + JSON.stringify(own.map(task => task.record.kind)));
    // The record itself is untouched by the refusal: same version, still not terminal, still owned by the parent.
    const stored = await reopened.harness.harness.commit(tx => tx.task(Number(anchorTaskId) as TaskId), BACKGROUND_CONTEXT);
    assert.equal(stored?.version, 1);
    assert.equal(String(stored?.conversationId), parentId);
    // The dispatch keeps every identity the caller holds, because a refusal to run is not a result for it, and the
    // child's own conversation is untouched: no report was fabricated for a delegation that cannot proceed.
    const dispatch = await reopened.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);
    assert.equal(dispatch?.childConversationId, childId);
    assert.equal(dispatch?.submissionId, String(facts.submissionId));
    const branch = await reopened.harness.harness.conversation(Number(childId) as ConversationId, BACKGROUND_CONTEXT);
    assert.ok(branch !== undefined, "the child of an un-migratable anchor is not readable");
    const history = await branch.context(BACKGROUND_CONTEXT);
    assert.equal(history.entries.length, 3, "the child's committed history is not what its admission wrote: " + JSON.stringify(history.entries.map(entry => entry.kind)));
    assert.ok(history.entries.every(entry => entry.model !== undefined), "a committed entry reaches the model with no content");
  } finally {
    await reopened.close();
  }

  // The control, on the same store: this build's **own** definition meets a version 1 record, so nothing is blocked.
  // Without it the assertion above would say no more than "this fixture always blocks", and it is also the state the
  // un-migratable refusal is recovered by — a definition that fits, not a retry or a rewritten record.
  const fitted = await openCrashHarness(dbPath, { root: join(base, "workspace"), home: join(base, "home") });
  try {
    const inspection = await fitted.harness.harness.inspect(BACKGROUND_CONTEXT);
    const own = inspection.tasks.filter(task => String(task.record.conversationId) === parentId);
    assert.equal(own.find(task => String(task.record.id) === anchorTaskId)?.state.kind, "running", "the same record is not live under the definition that wrote it");
    assert.deepEqual(projectRunStatus({ busy: false, control: { state: "allowed" }, tasks: own, waitingReport: false }), { state: "idle" });
  } finally {
    await fitted.close();
  }
});
