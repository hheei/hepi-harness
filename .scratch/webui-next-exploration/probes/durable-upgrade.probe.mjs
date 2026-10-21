import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const legacyRoot = process.argv[2];
assert.ok(legacyRoot, "Pass an isolated package root pinned to durable/chord/pi-ai 1.1.0");
const currentRoot = fileURLToPath(new URL("../../../apps/server/", import.meta.url));
const script = fileURLToPath(new URL("./durable-upgrade-child.probe.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "hepi-durable-upgrade-"));
try {
  for (const scenario of ["queue", "tool"]) {
    const database = join(directory, scenario + ".sqlite");
    const crashed = spawnSync(process.execPath, [script, scenario + "-crash", database, legacyRoot], { encoding: "utf8", timeout: 15000 });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    const restored = spawnSync(process.execPath, [script, scenario + "-reopen", database, currentRoot], { encoding: "utf8", timeout: 15000 });
    assert.equal(restored.status, 0, restored.stderr);
    process.stdout.write(restored.stdout);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
