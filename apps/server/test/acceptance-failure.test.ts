/**
 * Ticket 13's failure states, read back by builds that differ only in what they install.
 *
 * The questions the acceptance table asks and no owning ticket answered end to end:
 *
 * 1. **An unsafe call is never blind-replayed.** A store whose tool task died mid-execute is reopened; the call is
 *    reported interrupted, and the tool body does not run a second time — the file it wrote says so, which is stronger
 *    evidence than a status field (spec D16, A20).
 * 2. **A missing task definition is stated as blocked.** An admitted delegation is reopened by a build that installs no
 *    anchor definition at all, which is the state an installation whose extension was uninstalled leaves. The child's own
 *    history and relations stay readable, and the anchor is blocked with the runtime's own reason (spec D15, A01/A21).
 *
 * Each stage is its own process over the test's own SQLite file, so nothing here reads another test's store and nothing
 * touches a deployment's.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { openCrashHarness } from "./subagents-crash-harness.ts";

const failureChild = fileURLToPath(new URL("./acceptance-failure-child.ts", import.meta.url));

type StageRun = { status: number | null; signal: string | null; stdout: string; stderr: string };

function runStage(stage: string, dbPath: string, base: string): StageRun {
  const result = spawnSync(process.execPath, [failureChild, stage, dbPath, base], { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function facts(run: StageRun): Record<string, unknown> {
  const line = run.stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "the stage printed no facts: " + run.stderr + run.stdout);
  return JSON.parse(line) as Record<string, unknown>;
}

/** The task states one conversation's live work is in, by task kind, from the runtime's own inspection. */
async function taskStates(harness: Harness, conversationId: string): Promise<{ kind: string; state: string; reason?: string }[]> {
  return (await harness.inspect(BACKGROUND_CONTEXT)).tasks
    .filter((task) => String(task.record.conversationId) === conversationId)
    .map((task) => ({ kind: task.record.kind, state: task.state.kind, ...(task.state.kind === "blocked" ? { reason: task.state.reason } : {}) }));
}

const waitFor = async (ready: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("a tool call the store says was executing is interrupted after a real SIGKILL and its side effect is never repeated", { timeout: 120_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-acceptance-unsafe-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "unsafe.sqlite");
  const killed = runStage("unsafe", dbPath, base);
  assert.equal(killed.status, null, killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(facts(killed).checkpoint, "unsafe-executing");
  const before = await readFile(join(base, "side-effects.log"), "utf8");
  assert.deepEqual(before.trim().split("\n"), ["published"], "the killed attempt recorded exactly one effect");

  // Reopen the same store: the tool task is live, its checkpoint said `execute`, and the tool's policy is unsafe.
  const crash = await openCrashHarness(dbPath, { root: join(base, "workspace"), home: join(base, "home"), startPaused: true });
  t.after(() => crash.close());
  const paused = (await crash.harness.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => task.record.kind === "pi.tool");
  assert.equal(paused.length, 1, "the interrupted tool task survived the restore");

  // Resumed, the runtime's own recovery decides: the stored intent and the current policy both have to say safe.
  crash.harness.harness.resume();
  await waitFor(async () => (await crash.harness.harness.inspect(BACKGROUND_CONTEXT)).tasks.every((task) => task.record.kind !== "pi.tool"), "the interrupted call to settle");
  const after = await readFile(join(base, "side-effects.log"), "utf8");
  assert.deepEqual(after.trim().split("\n"), ["published"], "the recovered process did not run the unsafe body a second time");

  // The call states what happened instead of a result: the runtime's own interrupted text, which is the truthful answer
  // for work that may have partly run (spec D16 — no exactly-once claim for an external side effect).
  const parentId = String(facts(killed).parentId);
  const entries = await crash.harness.harness.commit((tx) => tx.scanEntries({ conversationId: Number(parentId) as ConversationId, order: "ascending" }, 200, undefined), BACKGROUND_CONTEXT);
  const results = entries.items.filter((entry) => entry.kind === "pi.tool-result");
  assert.equal(results.length, 1, "the interrupted call settled exactly one result entry");
  const resultText = JSON.stringify(results[0]!.model ?? "");
  assert.match(resultText, /interrupted and may have partially run/, resultText);
});

test("a store whose task definition this build does not have states missing_task and keeps the child readable", { timeout: 120_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-acceptance-missing-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dbPath = join(base, "delegation.sqlite");
  const killed = runStage("delegation", dbPath, base);
  assert.equal(killed.status, null, killed.stderr + killed.stdout);
  assert.equal(killed.signal, "SIGKILL");
  const stated = facts(killed);
  const parentId = String(stated.parentId);
  const childId = String(stated.childId);

  // A build that installs **no** task definitions: the state an installation whose extension was uninstalled leaves.
  const crash = await openCrashHarness(dbPath, { root: join(base, "workspace"), home: join(base, "home"), startPaused: true, tasks: [] });
  t.after(() => crash.close());

  // The child is still a real, readable conversation with its own transcript and its own native owner.
  const child = await crash.harness.harness.conversation(Number(childId) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(child !== undefined, "the delegated child conversation is still readable");
  const context = await child.context(BACKGROUND_CONTEXT);
  assert.ok(context.entries.length > 0, "the child's own transcript survived the restart");
  const owned = await crash.harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: Number(parentId) as ConversationId }, 10, undefined), BACKGROUND_CONTEXT);
  assert.deepEqual(owned.items.map((record) => String(record.id)), [childId], "the child's native owner edge still names the parent");

  // The anchor is live and blocked, and the reason is the runtime's own.
  crash.harness.harness.resume();
  await waitFor(async () => (await taskStates(crash.harness.harness, parentId)).some((task) => task.state === "blocked"), "the anchor to state blocked");
  const anchor = (await taskStates(crash.harness.harness, parentId)).find((task) => task.kind === "hepi.subagent-anchor");
  assert.equal(anchor?.state, "blocked");
  assert.equal(anchor?.reason, "missing_task", "the runtime's own reason, not a sentence invented here");
});
