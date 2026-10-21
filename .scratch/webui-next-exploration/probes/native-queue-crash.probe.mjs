import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const childScript = fileURLToPath(new URL("./native-queue-crash-child.probe.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "hepi-native-queue-research-"));
try {
  const dbPath = join(directory, "queue.sqlite");
  const crashed = spawnSync(process.execPath, [childScript, "crash", dbPath], { encoding: "utf8" });
  assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
  for (const stage of ["reopen", "reopen-cancel"]) {
    const result = spawnSync(process.execPath, [childScript, stage, dbPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
