/**
 * Ticket 13's combined chain: **two** real SIGKILLs on one store, then a process that finishes the work.
 *
 * The owning tickets each pinned one window (06: the creation commit and the admission receipt; 07: the child's
 * settlement and the report's admission; 09: the per-item decisions). Nothing yet stated them as one chain over one
 * SQLite file, where the second crash lands in the work the first crash left unfinished. That is what this test adds,
 * and it is the only claim it makes: the same child, the same dispatch, the same submission and the same report
 * identity across three processes, with no duplicate child, task or report (spec D04, D05, D16, A19).
 *
 * Every stage is its own process over the test's own file. `chainA` dies inside the publication that admits the child's
 * first submission; `chainB` reopens that store, lets the same child finish, and dies inside the publication that
 * admits its report into the recipient; `final` reopens again and reads what the recovered chain really left.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chainChild = fileURLToPath(new URL("./acceptance-chain-child.ts", import.meta.url));

type StageRun = { status: number | null; signal: string | null; stdout: string; stderr: string };
type ChainFacts = {
  stage: "chainA" | "chainB" | "final";
  parentId: string;
  childId: string;
  dispatchId: string;
  submissionId?: string;
  submissionStatus?: string;
  reportSubmissionId?: string;
  checkpoint: string;
  reportDelivered?: boolean;
  childTexts?: string[];
  parentTexts?: string[];
  childAnswers?: number;
  parentAnswers?: number;
  parentAnswerTexts?: string[];
  reportEntries?: number;
  anchors?: number;
  conversations?: number;
  report?: { dispatchId?: string; childConversationId?: string; submissionId?: string; delivery?: string; deliveredSubmissionId?: string };
};

function runStage(stage: string, dbPath: string, base: string): StageRun {
  const result = spawnSync(process.execPath, [chainChild, stage, dbPath, base], { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function facts(run: StageRun): ChainFacts {
  const line = run.stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "the stage printed no facts: " + run.stderr + run.stdout);
  return JSON.parse(line) as ChainFacts;
}

test("two real SIGKILLs in one chain keep one child, one dispatch, one submission and one report, and the third process finishes it", { timeout: 240_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-acceptance-chain-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "chain.sqlite");

  // 1. The first process dies in the admission window: the child and one submission are durable, no tool result exists.
  const first = runStage("chainA", dbPath, base);
  assert.equal(first.status, null, first.stderr + first.stdout);
  assert.equal(first.signal, "SIGKILL");
  const admitted = facts(first);
  assert.equal(admitted.checkpoint, "chain-admitted");
  assert.notEqual(admitted.submissionId, undefined, "the admission the stage made is named");

  // 2. The second process reopens that same store, resumes the same child, and dies inside the report's admission.
  const second = runStage("chainB", dbPath, base);
  assert.equal(second.status, null, second.stderr + second.stdout);
  assert.equal(second.signal, "SIGKILL");
  const reported = facts(second);
  assert.equal(reported.checkpoint, "report-admitted");
  // The identities are the first process's own: the same child, the same dispatch, and the submission it admitted.
  assert.equal(reported.parentId, admitted.parentId, "the second process resumed the same delegating conversation");
  assert.equal(reported.childId, admitted.childId, "the second process reused the child the first one created");
  assert.equal(reported.dispatchId, admitted.dispatchId, "the dispatch identity never changed across the crash");
  assert.notEqual(reported.reportSubmissionId, undefined, "the report the second process admitted is named");

  // 3. The third process finishes the chain and states what it read.
  const third = runStage("final", dbPath, base);
  assert.equal(third.status, 0, third.stderr + third.stdout);
  const finished = facts(third);
  assert.equal(finished.parentId, admitted.parentId);
  assert.equal(finished.childId, admitted.childId);
  assert.equal(finished.dispatchId, admitted.dispatchId);

  // One child, one delegation anchor, one report record — across both crashes.
  assert.equal(finished.conversations, 3, "the recovered store holds the parent, the child and the conversation the runtime keeps for ownerless work");
  assert.equal(finished.anchors, 1, "the delegation's permanent anchor was created once, not once per process");
  assert.equal(finished.reportEntries, 1, "exactly one report entry reached the recipient");
  assert.equal(finished.reportDelivered, true, "the recovered reporter acknowledged the delivery it had already made");
  assert.equal(finished.report?.dispatchId, admitted.dispatchId);
  assert.equal(finished.report?.childConversationId, admitted.childId);
  assert.equal(finished.report?.submissionId, admitted.submissionId, "the report states the submission the first process admitted");
  assert.equal(finished.report?.delivery, "delivered");
  assert.equal(finished.report?.deliveredSubmissionId, reported.reportSubmissionId, "the acknowledgement names the report submission the second process admitted, rather than a new one");

  // The child ran its task once: one user entry and one answer, however many processes touched the store.
  assert.deepEqual(finished.childTexts, ["chain work"]);
  assert.equal(finished.childAnswers, 1, JSON.stringify(finished.childAnswers));

  // The recipient's own turn was replayed once — the runtime's replay of an interrupted generation is expected and is
  // not a second child — but it carries one delegation call and one report, and the report names the same child.
  assert.deepEqual(finished.parentTexts, ["delegate"], "no second delegation turn was admitted into the parent");
  const delegatedTurns = (finished.parentAnswerTexts ?? []).filter((text) => text.includes("agent_spawn")).length;
  assert.equal(delegatedTurns, 1, JSON.stringify(finished.parentAnswerTexts));
});
