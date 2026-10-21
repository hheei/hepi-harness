/**
 * The one place the App's Rust build states its cost, so every build of the shell pays the same one.
 *
 * Three settings, each with a reason a caller can check:
 *
 * - **One shared target directory for the whole repository, not one per worktree.** A worktree is a checkout, not a
 *   second toolchain: separate `src-tauri/target` trees meant the same crates were compiled once per checkout (the
 *   observed one was 3.4 GiB for a single App build). The shared directory lives under the repository's own git-ignored
 *   `.dev/`, so it is still disposable, still outside the source tree, and one `cargo` at a time locks it — a second
 *   concurrent build waits on the target lock instead of compiling the same crate twice.
 *
 *   The path is computed from `git rev-parse --git-common-dir`, which every worktree of a repository answers with the
 *   main checkout's `.git`. That is what makes it genuinely shared: `$(git rev-parse --show-toplevel)/.dev` would
 *   name each worktree's own directory, and `[build] target-dir` in a checked-in config file cannot be written
 *   relative to a root whose depth differs between the main checkout and a worktree.
 *
 * - **Six jobs.** The build host has more cores than that, and this is a workstation that stays usable while it
 *   compiles; the number is stated once so a build log cannot disagree with the guide.
 *
 * - **Incremental compilation on for a development build, off for a release build.** Incremental is what makes the
 *   second and later development builds fast, so it is on by default here. It is off for `--profile=release` because
 *   incremental release builds trade code quality and compile time for reuse — a release artifact is built once and
 *   measured, so the trade is the wrong way round there. Neither setting is a disk strategy: the disk cost of the cache
 *   is bounded by keeping one shared directory and at most two generations of it, never by turning incremental off.
 *
 * Nothing here changes the release profile's own optimisation (`apps/app/src-tauri/Cargo.toml`: `opt-level = "s"`,
 * `lto = true`, `codegen-units = 1`, `strip = "symbols"`, `panic = "abort"`). A development build is a debug
 * build with its symbols intact, and it is never reported as a production artifact.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The profiles a caller may select. `debug` is the default because development is the default use of this build. */
export const PROFILES = ["debug", "release"];

/** How many crates `cargo` may compile at once. */
export const CARGO_JOBS = 6;

/** The repository a checkout belongs to: the main checkout's root, shared by every worktree of it. */
export function sharedRepoRoot(root) {
	const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: root, encoding: "utf8" });
	const common = result.status === 0 ? result.stdout.trim() : "";
	if (common === "") return resolve(root);
	return dirname(resolve(root, common));
}

/** The one target directory every build of this repository shares, and the only cache this project owns. */
export function sharedCargoTargetDir(root) {
	return join(sharedRepoRoot(root), ".dev", "cargo-target");
}

/**
 * The environment a Rust build of the App runs under.
 *
 * Returned rather than exported as constants so a caller can record exactly what it ran with: a provenance file that
 * says "the shared cache" without saying which directory, or "six jobs" without saying it was passed, is not evidence.
 */
export function cargoBuildEnvironment(root, profile = "debug") {
	if (!PROFILES.includes(profile)) throw new Error("Unknown cargo profile \"" + profile + "\". Known: " + PROFILES.join(", "));
	return {
		CARGO_TARGET_DIR: sharedCargoTargetDir(root),
		CARGO_BUILD_JOBS: String(CARGO_JOBS),
		CARGO_INCREMENTAL: profile === "debug" ? "1" : "0",
	};
}

/** Where a build of this profile leaves the executable and its bundles, given the environment above. */
export function cargoOutputPaths(root, profile = "debug") {
	const targetDir = cargoBuildEnvironment(root, profile).CARGO_TARGET_DIR;
	const profileDir = join(targetDir, profile);
	return { targetDir, profileDir, binary: join(profileDir, "hepi-app"), bundleDir: join(profileDir, "bundle", "deb") };
}

/**
 * The cache generations this project owns, newest first.
 *
 * A "generation" is one `cargo-target` directory: the shared one, plus any `cargo-target.<stamp>` a rotation left
 * behind. There are no per-commit target directories by construction — the directory is shared by every checkout — so
 * the count here is normally one, and the retention rule is what keeps a rotation from accumulating.
 */
export function cacheGenerations(root) {
	const dev = join(sharedRepoRoot(root), ".dev");
	if (!existsSync(dev)) return [];
	return readdirSync(dev)
		.filter((name) => name === "cargo-target" || name.startsWith("cargo-target."))
		.map((name) => {
			const directory = join(dev, name);
			const measured = Number(spawnSync("du", ["-s", "--block-size=1", directory], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0]);
			return { directory, name, bytes: Number.isFinite(measured) ? measured : null, modified: statSync(directory).mtimeMs };
		})
		.sort((a, b) => b.modified - a.modified);
}

/**
 * Keep at most `keep` generations of this project's cache, preferring one.
 *
 * Deleting a cache is never how a build is made cheap — incremental compilation is — so this only runs when asked, and
 * it only ever removes directories this project created under `.dev/`. A checkout's own `src-tauri/target` is not
 * this function's to delete: it may belong to another worktree's build.
 */
export function pruneCacheGenerations(root, keep = 2) {
	const generations = cacheGenerations(root);
	const removed = [];
	for (const generation of generations.slice(keep)) {
		rmSync(generation.directory, { recursive: true, force: true });
		removed.push(generation.directory);
	}
	return { kept: generations.slice(0, keep).map((generation) => generation.directory), removed };
}

if (process.argv[1] !== undefined && import.meta.url === new URL("file://" + resolve(process.argv[1])).href) {
	// `eval "$(node apps/app/scripts/cargo-build.mjs --profile=debug)"` puts an ad-hoc `cargo`/`tauri dev` run on the
	// same shared cache the artifact script uses, so a development shell does not create a second 3 GiB tree.
	if (process.argv.includes("--prune-cache")) {
		const result = pruneCacheGenerations(process.cwd());
		process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	} else {
		const profile = process.argv.slice(2).find((argument) => argument.startsWith("--profile="))?.split("=").slice(1).join("=") ?? "debug";
		const environment = cargoBuildEnvironment(process.cwd(), profile);
		for (const [name, value] of Object.entries(environment)) process.stdout.write("export " + name + "=" + JSON.stringify(value) + "\n");
	}
}
