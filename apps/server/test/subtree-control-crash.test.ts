import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const child = fileURLToPath(new URL("./subtree-control-crash-child.ts", import.meta.url));

/** Run one stage in its own process over the test's SQLite file. */
function runStage(stage: string, dbPath: string): { status: number | null; signal: string | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [child, dbPath, stage], { encoding: "utf8" });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The facts line a stage prints; a failed assertion makes the stage exit non-zero instead. */
function facts(stage: { status: number | null; stdout: string; stderr: string }): Record<string, unknown> {
  if (stage.status !== 0) throw new Error("stage failed (" + String(stage.status) + "): " + stage.stderr + stage.stdout);
  const line = stage.stdout.trim().split("\n").at(-1);
  assert.ok(line !== undefined && line.startsWith("{"), "stage printed no facts: " + stage.stdout);
  return JSON.parse(line) as Record<string, unknown>;
}

/**
 * The recovery claim the ticket makes: a real SIGKILL between the capture commit and the first child's outcome leaves a
 * resumable request, and the same request identity continues it without stopping a child twice.
 */
test("a real SIGKILL after the capture commit resumes the same request without stopping a child twice", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-subtree-crash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dbPath = join(directory, "subtree.sqlite");
  const killed = runStage("capture", dbPath);
  assert.equal(killed.status, null, "the stage was killed, not exited: " + killed.stderr);
  assert.equal(killed.signal, "SIGKILL");
  const captured = facts({ ...killed, status: 0 });
  assert.equal((captured.scope as string[]).length, 2, "the capture held both children");
  assert.equal(captured.outcomes, 0, "no child had an outcome at the kill point");
  // A fresh process over the same file: the capture is store state, so the request resumes instead of restarting.
  const resumed = facts(runStage("resume", dbPath));
  assert.equal(resumed.capturedStatus, "pending", "the killed request reads back as pending before it resumes");
  assert.deepEqual(resumed.statuses, ["accepted", "accepted"]);
  assert.deepEqual(resumed.scope, captured.scope);
});
