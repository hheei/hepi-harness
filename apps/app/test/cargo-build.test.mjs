import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CARGO_JOBS, PROFILES, cacheGenerations, cargoBuildEnvironment, cargoOutputPaths, pruneCacheGenerations, sharedCargoTargetDir, sharedRepoRoot } from "../scripts/cargo-build.mjs";

/**
 * The App's Rust build cost, asserted where a caller can see it.
 *
 * The two facts that make a build cheap here are the ones a worktree gets wrong by default: the target directory is the
 * repository's, not the checkout's, and the profile decides whether incremental compilation is on. Both are checked
 * against a real git repository rather than a stub, because the sharing rule *is* a git fact (`--git-common-dir`).
 */
function repo() {
	const root = mkdtempSync(join(tmpdir(), "hepi-cargo-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: root });
	process.on("exit", () => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("every worktree of a repository shares one target directory", () => {
	const root = repo();
	const worktree = join(root, "..", "hepi-cargo-worktree-" + process.pid);
	execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], { cwd: root });
	process.on("exit", () => rmSync(worktree, { recursive: true, force: true }));
	// A worktree's own top level is itself; the shared repository is what `--git-common-dir` answers.
	assert.equal(sharedRepoRoot(root), root);
	assert.equal(sharedRepoRoot(worktree), root, "a worktree resolves to the main checkout, not to itself");
	assert.equal(sharedCargoTargetDir(worktree), join(root, ".dev", "cargo-target"));
	// The directory is disposable and outside the source tree, which is what makes it safe to prune.
	assert.equal(sharedCargoTargetDir(root).startsWith(join(root, ".dev")), true);
});

test("the profile decides incremental compilation, and the release profile is untouched", () => {
	assert.deepEqual(PROFILES, ["debug", "release"]);
	const debug = cargoBuildEnvironment("/x", "debug");
	assert.equal(debug.CARGO_INCREMENTAL, "1");
	assert.equal(debug.CARGO_BUILD_JOBS, String(CARGO_JOBS));
	assert.equal(CARGO_JOBS, 6);
	const release = cargoBuildEnvironment("/x", "release");
	assert.equal(release.CARGO_INCREMENTAL, "0", "a release build is measured once, so it does not trade quality for reuse");
	// The target directory is the same for both profiles: they are subdirectories of one cache, not two caches.
	assert.equal(release.CARGO_TARGET_DIR, debug.CARGO_TARGET_DIR);
	assert.throws(() => cargoBuildEnvironment("/x", "fast"), /Unknown cargo profile/);
});

test("the output path follows the profile, so a debug artifact is never read as a release one", () => {
	const debug = cargoOutputPaths("/x", "debug");
	const release = cargoOutputPaths("/x", "release");
	assert.equal(debug.profileDir, join(debug.targetDir, "debug"));
	assert.equal(release.profileDir, join(release.targetDir, "release"));
	assert.equal(debug.binary, join(debug.targetDir, "debug", "hepi-app"));
	assert.equal(debug.bundleDir, join(debug.targetDir, "debug", "bundle", "deb"));
	assert.notEqual(debug.binary, release.binary);
});

test("retention keeps at most two cache generations and only removes this project's own", () => {
	const root = repo();
	const dev = join(root, ".dev");
	mkdirSync(join(dev, "cargo-target"), { recursive: true });
	mkdirSync(join(dev, "cargo-target.20260101"), { recursive: true });
	mkdirSync(join(dev, "cargo-target.20250101"), { recursive: true });
	// A checkout's own src-tauri/target is another worktree's business and must survive any pruning here.
	mkdirSync(join(root, "apps", "app", "src-tauri", "target"), { recursive: true });
	assert.equal(cacheGenerations(root).length, 3);
	const kept = pruneCacheGenerations(root, 2);
	assert.equal(kept.removed.length, 1);
	assert.equal(kept.kept.length, 2);
	assert.equal(cacheGenerations(root).length, 2);
	assert.equal(cacheGenerations(root).some((generation) => generation.directory.endsWith("src-tauri/target")), false, "a checkout's own target is not a generation");
	// Idempotent: pruning again removes nothing.
	assert.deepEqual(pruneCacheGenerations(root, 2).removed, []);
});
