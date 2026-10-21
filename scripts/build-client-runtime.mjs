/**
 * `build:client-runtime` — build one immutable client-runtime release on this build host, and record what it is.
 *
 * The release is the three artifacts a cutover deploys together (see `scripts/lib/client-runtime.mjs`): the ingress
 * bundle, the static Web build and the Backend image. It is built from a **committed** revision — a dirty tree is
 * reported and refused, because a release directory is named by the commit and a release whose bytes came from
 * uncommitted edits cannot be named at all.
 *
 * Nothing here deploys, stops a service, reads a secret or contacts a host. It writes one staging directory, verifies
 * it, and prints the release id; promoting it and switching a unit is the operator's step in the runbook.
 *
 * The ingress bundle is built with the client package's own esbuild, from the ingress entry, with the same settings
 * `packages/client/scripts/build.mjs` uses for the execution bundle: ESM, Node 24, third-party license comments kept,
 * and the CJS `require` banner the bundled MCP client needs. One bundle, no install step on the deployment host.
 *
 * Usage: node scripts/build-client-runtime.mjs [--root=<dir>] [--out=<dir>] [--skip-backend] [--skip-web]
 *                                              [--platform=<os/arch>] [--json=<path>] [--keep-staging]
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname, arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { isMain, parseCli, writeJson } from "./lib/cli.mjs";
import {
	RELEASE_LAYOUT,
	backendImageTag,
	buildPlatform,
	provenanceProblems,
	publishRelease,
	releaseConflictMessage,
	releaseDirName,
	artifactIdOf,
} from "./lib/client-runtime.mjs";

const run = promisify(execFile);

const USAGE = `
Usage: node scripts/build-client-runtime.mjs [--root=<dir>] [--out=<dir>] [--platform=<os/arch>]
                                              [--skip-backend] [--skip-web] [--json=<path>]

  --root=<dir>         build a checkout other than the one the script lives in
  --out=<dir>          where to assemble the release (default: <root>/.dev/releases)
  --platform=<os/arch> the platform the Backend image is built for (default: this host's)
  --skip-backend       build only the ingress bundle and the Web build, into a partial-<id> directory
  --skip-web           build only the ingress bundle and the Backend image, into a partial-<id> directory
  --json=<path>        write the build report as JSON at <path>
  -h, --help           print this usage and exit
`;

async function git(root, ...args) {
	const { stdout } = await run("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
	return stdout.trim();
}

async function sha256(file) {
	const hash = createHash("sha256");
	await new Promise((resolveHash, rejectHash) => createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", resolveHash).on("error", rejectHash));
	return hash.digest("hex");
}

/** One command, its raw log kept beside the release, and a failure that carries the log path. */
async function step(root, logDir, name, command, args, options = {}) {
	const started = Date.now();
	const log = join(logDir, name + ".log");
	let exit = 0;
	let output = "";
	try {
		const result = await run(command, args, { cwd: options.cwd ?? root, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...(options.env ?? {}) } });
		output = String(result.stdout ?? "") + String(result.stderr ?? "");
	} catch (error) {
		output = String(error.stdout ?? "") + String(error.stderr ?? "") + String(error?.stack ?? error);
		exit = typeof error.code === "number" ? error.code : 1;
	}
	await mkdir(logDir, { recursive: true });
	await writeFile(log, output);
	const record = { name, command: [command, ...args].join(" "), exit, seconds: Math.round((Date.now() - started) / 1000), log };
	if (exit !== 0) throw Object.assign(new Error(name + " failed (exit " + exit + "); see " + log), { record });
	return record;
}

/** Every file under `dir`, relative, sorted, so two builds' checksum lists can be compared directly. */
async function filesUnder(dir) {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name)).sort();
}

async function main(argv) {
	const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["root", "out", "platform", "json"], switches: ["skip-backend", "skip-web"] });
	if (exitCode !== undefined) return exitCode;
	const root = resolve(flags.root ?? resolve(dirname(new URL(import.meta.url).pathname), ".."));
	const steps = [];

	const revision = await git(root, "rev-parse", "HEAD");
	const dirty = (await git(root, "status", "--porcelain")).length > 0;
	const artifactId = artifactIdOf(revision);
	if (dirty) {
		process.stderr.write("refusing to build a release from a dirty tree: the release is named by " + revision + " and the bytes would not be\n");
		return 1;
	}

	const platform = flags.platform ?? buildPlatform(hostArch());
	const outRoot = resolve(flags.out ?? join(root, ".dev", "releases"));
	// A release is the three artifacts or it is nothing: a directory holding a bundle but no page would start an
	// ingress whose `HEPI_INGRESS_STATIC_DIR` points at a directory that is not there. `--skip-web`/`--skip-backend`
	// are for measuring one part of the build, so they assemble into a separate `-partial` directory that is not a
	// release a unit may name.
	const partial = flags["skip-web"] === "true" || flags["skip-backend"] === "true";
	// Assemble under a staging name and rename once: a failure leaves no directory a start could pick up, and promotion
	// is the only step that changes what a unit would run. The staging name is unique per run so two builds of one
	// revision cannot assemble into each other's tree.
	const staging = join(outRoot, ".staging-" + artifactId + "-" + randomUUID());
	const releaseDir = join(outRoot, partial ? "partial-" + artifactId : releaseDirName(artifactId));
	const logDir = join(outRoot, ".logs-" + artifactId);
	// Refused before anything expensive runs: a published release is immutable input to whatever is serving it, and a
	// rebuild of its own revision cannot improve it. Promotion refuses again, for a build that started concurrently.
	if (!partial && existsSync(releaseDir)) {
		process.stderr.write(releaseConflictMessage(releaseDir) + "\n");
		return 1;
	}
	await mkdir(staging, { recursive: true });
	await mkdir(logDir, { recursive: true });

	const artifacts = [];
	try {

		// 1. The ingress bundle. The client package's esbuild resolves through the workspace, and its settings are the
		// ones the execution bundle already ships with, so the two bundles cannot drift in module format or legal notices.
		// The workspace's `.bin` shim is spawned directly: it selects the platform binary, and `esbuild/bin/esbuild` is
		// that binary rather than a Node script.
		const esbuild = join(root, "packages", "client", "node_modules", ".bin", "esbuild");
		steps.push(await step(root, logDir, "ingress-bundle", esbuild, [
			join(root, "packages", "gateway", "src", "ingress", "main.ts"),
			"--bundle",
			"--format=esm",
			"--platform=node",
			"--target=node24",
			"--legal-comments=eof",
			"--banner:js=import { createRequire as __hepiCreateRequire } from 'node:module'; const require = __hepiCreateRequire(import.meta.url);",
			"--outfile=" + join(staging, RELEASE_LAYOUT.bundle),
		], { cwd: join(root, "packages", "client") }));
		artifacts.push({ path: RELEASE_LAYOUT.bundle, bytes: (await stat(join(staging, RELEASE_LAYOUT.bundle))).size, sha256: await sha256(join(staging, RELEASE_LAYOUT.bundle)) });

		// 2. The execution gateway's client bundle, packed as the tarball a deployment host installs. It is a different
		// artifact from the ingress above and it must come from the same revision: the gateway answers the ingress's
		// host-local MCP calls, and a bundle that predates the cancellation forwarding cannot end one when the caller
		// disconnects.
		steps.push(await step(root, logDir, "gateway-bundle", "pnpm", ["--filter", "@hepi/client", "build"]));
		const packDir = join(staging, "gateway");
		await mkdir(packDir, { recursive: true });
		const packed = await step(root, logDir, "gateway-pack", "npm", ["pack", join(root, "packages", "client"), "--pack-destination", packDir]);
		const tarball = (await readdir(packDir)).find((name) => name.endsWith(".tgz"));
		if (tarball === undefined) throw new Error("npm pack produced no tarball; see " + packed.log);
		artifacts.push({ path: "gateway/" + tarball, kind: "execution-gateway", bytes: (await stat(join(packDir, tarball))).size, sha256: await sha256(join(packDir, tarball)) });

		// 3. The static Web build the ingress serves.
		if (!flags["skip-web"]) {
			steps.push(await step(root, logDir, "web-build", "pnpm", ["--filter", "@hepi/web", "build"]));
			const webDist = join(root, "apps", "web", "dist");
			for (const file of await filesUnder(webDist)) {
				const target = join(staging, RELEASE_LAYOUT.staticDir, relative(webDist, file));
				await mkdir(dirname(target), { recursive: true });
				await copyFile(file, target);
			}
			const indexHtml = join(staging, RELEASE_LAYOUT.staticDir, "index.html");
			if (!(await stat(indexHtml).catch(() => undefined))?.isFile()) throw new Error("the Web build has no index.html: " + webDist);
			artifacts.push({ path: RELEASE_LAYOUT.staticDir + "/", kind: "static-web", files: (await filesUnder(join(staging, RELEASE_LAYOUT.staticDir))).length });
		}

		// 4. The Backend image. Built here, for the platform the runtime host really runs; never on that host.
		const imageTag = backendImageTag(artifactId, flags.platform === undefined ? "workstation" : platform.replace(/[/]/g, "-"));
		let image = null;
		if (!flags["skip-backend"]) {
			steps.push(await step(root, logDir, "backend-image", "docker", [
				"buildx", "build", "--load",
				"--platform", platform,
				"-f", join(root, "deploy", "docker", "backend.Dockerfile"),
				"-t", imageTag,
				".",
			]));
			const { stdout } = await run("docker", ["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", imageTag], { encoding: "utf8" });
			image = { tag: imageTag, platform, id: stdout.trim() };
			artifacts.push({ path: "image:" + imageTag, kind: "backend-image", ...image });
		}

		// The release's own record. `dirty: false` is asserted above, and the marker is what a later inspection reads.
		await writeFile(join(staging, RELEASE_LAYOUT.marker), revision + "\n");
		await writeFile(join(staging, RELEASE_LAYOUT.license), await readFile(join(root, "packages", "client", "LICENSE")));
		await writeFile(join(staging, RELEASE_LAYOUT.notices), await readFile(join(root, "packages", "client", "THIRD_PARTY_NOTICES.md")));
		const provenance = {
			kind: "hepi-client-runtime",
			artifactId,
			revision,
			dirty,
			branch: await git(root, "rev-parse", "--abbrev-ref", "HEAD"),
			builtAt: new Date().toISOString(),
			host: hostname(),
			arch: hostArch(),
			os: hostPlatform(),
			platform,
			toolchain: {
				node: process.version,
				pnpm: (await run("pnpm", ["--version"]).then((result) => result.stdout.trim(), () => null)),
			},
			image,
			artifacts,
			steps,
		};
		const problems = provenanceProblems(provenance);
		if (problems.length > 0) throw new Error("the release record is incomplete: " + problems.join("; "));
		await writeFile(join(staging, RELEASE_LAYOUT.provenance), JSON.stringify(provenance, null, 2) + "\n");

		// Checksums over every file the release ships, written last so it covers what is actually in the directory.
		const sums = [];
		for (const file of await filesUnder(staging)) {
			if (relative(staging, file) === RELEASE_LAYOUT.sums) continue;
			sums.push((await sha256(file)) + "  " + relative(staging, file));
		}
		await writeFile(join(staging, RELEASE_LAYOUT.sums), sums.join("\n") + "\n");

		if (partial) {
			// A partial directory is a measurement, not something a unit runs: it is replaced on each run, and nothing
			// serving it means nothing to lose. A release is published, never replaced.
			await rm(releaseDir, { recursive: true, force: true });
			await rename(staging, releaseDir);
		} else {
			await publishRelease({ staging, releaseDir, rename, exists: existsSync });
		}

		const report = { releaseDir, partial, artifactId, revision, platform, image, artifacts, logDir, steps: steps.map((record) => ({ name: record.name, exit: record.exit, seconds: record.seconds })) };
		if (flags.json) writeJson(flags.json, report);
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
		return 0;
	} catch (error) {
		// The staging directory is removed on failure: a half-built release must not be mistaken for a promotable one.
		await rm(staging, { recursive: true, force: true });
		process.stderr.write(String(error?.message ?? error) + "\n");
		return 1;
	}
}

if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
