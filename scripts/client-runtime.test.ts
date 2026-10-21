/**
 * The client-runtime release contract, and the two scripts that render it.
 *
 * These are the decisions a cutover depends on and cannot re-derive at the host: what a release directory is called,
 * what it must hold, which image tag it pins, which variables the ingress reads, and that no template or unit carries a
 * value. They are asserted here, without building or deploying anything, because a mistake in any of them is a
 * deployment that starts the wrong thing or writes a secret into a file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, runCli, runProcess, writeAt } from "./testing/fixture.ts";
import { deployPlan } from "./lib/deploy.mjs";
import {
	INGRESS_ENVIRONMENT,
	RELEASE_LAYOUT,
	SECRET_VARIABLES,
	artifactIdOf,
	backendImageTag,
	buildPlatform,
	OPTIONAL_INGRESS_VARIABLES,
	ingressEnvTemplate,
	ingressUnit,
	provenanceProblems,
	publishRelease,
	releaseDirName,
	releaseNameForRevision,
	releaseArtifacts,
} from "./lib/client-runtime.mjs";

/** The path of a shipped operational script, which keeps its `.mjs` name: only tests moved to TypeScript. */
const script = (name: string): string => fileURLToPath(new URL("./" + name + ".mjs", import.meta.url));

test("a release is named by the short commit and holds the page with its API", () => {
	const sha = "644ac55e8fae6a0057c7d0f3120f1c7d7e736536";
	assert.equal(artifactIdOf(sha), "644ac55");
	assert.equal(releaseDirName("644ac55"), "release-644ac55");
	// The bundle and the static build live in the same directory because the page's origin is the API's origin.
	// The bundle is an ES module, so it says so in its name rather than relying on a package.json beside it.
	assert.equal(RELEASE_LAYOUT.bundle, "ingress.mjs");
	assert.equal(RELEASE_LAYOUT.staticDir, "web");
});

test("the backend image keeps the existing tag convention and states its platform", () => {
	assert.equal(backendImageTag("644ac55"), "hepi-backend:644ac55-workstation");
	assert.equal(backendImageTag("644ac55", "remote-host"), "hepi-backend:644ac55-remote-host");
	// The platform is read from the build host, never from a running container.
	assert.equal(buildPlatform("x64"), "linux/amd64");
	assert.equal(buildPlatform("arm64"), "linux/arm64");
});

test("the ingress environment names every variable the process reads, and no value", () => {
	const names = INGRESS_ENVIRONMENT.map((entry) => entry.name);
	// The two the process refuses to start without, and the one that makes this a Web origin rather than an API.
	for (const required of ["HEPI_INGRESS_BACKEND", "HEPI_INGRESS_SERVICE_TOKEN", "HEPI_INGRESS_STATIC_DIR"]) {
		assert.ok(names.includes(required), "the environment names " + required);
	}
	// The materials that must never be treated as one: three secrets here, and the execution token deliberately absent
	// because this listener serves no /v1 route.
	assert.deepEqual([...SECRET_VARIABLES].sort(), ["HEPI_INGRESS_MCP_GATEWAY_TOKEN", "HEPI_INGRESS_SERVICE_TOKEN", "HEPI_WEB_LOGIN_TOKEN"].sort());
	assert.equal(names.includes("HEPI_GATEWAY_TOKEN"), false, "the ingress environment carries no execution token");
	assert.equal(names.includes("HEPI_AUTH_TOKEN"), false, "the ingress environment carries no Backend client token");

	const template = ingressEnvTemplate();
	for (const entry of INGRESS_ENVIRONMENT) {
		// Every variable is named; only the ones a deployment must state are assigned.
		const line = template.split("\n").find((candidate) => candidate.replace(/^# /, "").startsWith(entry.name + "="));
		assert.ok(line !== undefined, "the template names " + entry.name);
		if (OPTIONAL_INGRESS_VARIABLES.includes(entry.name)) assert.equal(line.startsWith("# "), true, "an optional variable is unset, not stated empty: " + entry.name);
		else assert.equal(line.startsWith("# "), false, "the template assigns " + entry.name);
		const value = line.replace(/^# /, "").slice(entry.name.length + 1);
		if (entry.secret) assert.equal(value, "", "a secret starts empty in the template: " + entry.name);
		else assert.ok(value === "" || value === "127.0.0.1" || value === "30141", "a stated value is a deployment default: " + entry.name + "=" + value);
	}
});

test("the unit runs the promoted bundle under a pinned interpreter with its env from a 0600 file", () => {
	// No documentation URL is stated: the unit then carries no `Documentation=` line at all.
	const unit = ingressUnit({ releaseDir: "/home/u/.local/share/hepi/client/release-644ac55", envFile: "%h/.config/hepi/ingress.env", documentation: undefined });
	assert.match(unit, /^\[Unit\]/);
	assert.match(unit, /\nEnvironmentFile=%h\/\.config\/hepi\/ingress\.env\n/);
	assert.match(unit, /\nExecStart=\/usr\/bin\/node \/home\/u\/\.local\/share\/hepi\/client\/release-644ac55\/ingress\.mjs\n/);
	assert.match(unit, /\nRestart=always\n/);
	assert.match(unit, /\nWantedBy=default\.target\n/);
	// No token in the unit, and no dependence on the unit it replaces: the ingress takes over that unit's port.
	assert.equal(/TOKEN/.test(unit), false);
	assert.equal(/Requisite=/.test(unit), false);
});

test("a provenance record is refused when it cannot answer what is running", () => {
	const complete = { kind: "hepi-client-runtime", artifactId: "644ac55", revision: "644ac55e8fae", dirty: false, builtAt: "2026-10-18T00:00:00.000Z", host: "workstation", arch: "x64", platform: "linux/amd64", toolchain: {}, artifacts: [{ path: "ingress.js" }] };
	assert.deepEqual(provenanceProblems(complete), []);
	assert.deepEqual(provenanceProblems({ ...complete, dirty: true }), ["the tree was dirty: the revision does not name what was built"]);
	assert.deepEqual(provenanceProblems({ ...complete, platform: undefined }), ["missing field: platform"]);
	assert.deepEqual(provenanceProblems({ ...complete, artifacts: [] }), ["no artifacts recorded"]);
});

test("both commands answer --help and refuse an unknown flag", () => {
	for (const name of ["build-client-runtime", "ingress-unit"]) {
		for (const flag of ["--help", "-h"]) {
			const result = runCli(script(name), [flag], { cwd: fixtureDir() });
			assert.equal(result.status, 0, name + " " + flag + ": " + result.stderr);
			assert.match(result.stdout, /^Usage: node scripts\//);
		}
		const refused = runCli(script(name), ["--nope"], { cwd: fixtureDir() });
		assert.equal(refused.status, 2, name + " --nope");
		assert.match(refused.stderr, /unknown flag/);
	}
	// The unit command prints the template and the inventory without a release directory; only the unit needs one.
	assert.equal(runCli(script("ingress-unit"), ["--env-template"]).status, 0);
	assert.equal(runCli(script("ingress-unit"), ["--check"]).status, 0);
	assert.equal(runCli(script("ingress-unit"), []).status, 2);
});

test("the deployment plan names the client-runtime release as the artifact a Web cutover switches", () => {
	const source = { sha: "644ac55e8fae6a0057c7d0f3120f1c7d7e736536", artifactId: "644ac55e8fa" };
	const plan = deployPlan({ source, artifactId: source.artifactId });
	// The plan and the builder name one directory from one commit: a plan that prints a name the build never creates is
	// a cutover aimed at nothing.
	assert.equal(plan.clientRelease, releaseNameForRevision(source.sha));
	assert.equal(plan.clientRelease, releaseDirName(artifactIdOf(source.sha)));
	assert.equal(plan.clientRelease, "release-644ac55");
	const build = plan.stages.find((stage) => stage.stage === "build");
	assert.ok(build !== undefined, "the plan names a build stage");
	assert.ok(build.commands.some((command) => command.includes("scripts/build-client-runtime.mjs")), "the build stage builds the release");
	assert.ok(build.evidence.includes(plan.clientRelease), "the build evidence names the release directory");
	const switchStage = plan.stages.find((stage) => stage.stage === "switch");
	assert.ok(switchStage !== undefined, "the plan names a switch stage");
	assert.ok(switchStage.manualPrerequisites.some((line) => line.includes("ingress-unit.mjs")), "the switch renders the ingress unit from the release");
	assert.ok(switchStage.manualPrerequisites.some((line) => line.includes("proven stopped before the ingress starts")), "the port's previous holder is stopped first");
	assert.ok(plan.affected.some((entry) => entry.service === "ingress"), "the affected roles name the ingress");
});

/**
 * The template a deployment copies, filled in the way the guide says: the required materials only, everything else as
 * the template leaves it. Started for real against the ingress entry, because "the file is valid" is a claim about a
 * parser (`Number("") === 0`), not about the text.
 */
test("the env template starts the ingress once its required materials are filled in", () => {
	const template = ingressEnvTemplate();
	// An optional variable that changes behavior is named but not assigned: a stated empty value is a configuration
	// the ingress refuses at start, so a template that assigns one cannot be filled in and run.
	for (const name of ["HEPI_REVOCATION_CHECK_MS", "HEPI_UPLOAD_BATCH_BYTES", "HEPI_APP_ORIGINS", "HEPI_INGRESS_STATIC_DIR"]) {
		const line = template.split("\n").find((candidate) => candidate.startsWith(name + "="));
		assert.equal(line, undefined, name + " is not assigned an empty value in the template");
		assert.ok(template.split("\n").includes("# " + name + "="), name + " is still named in the template");
	}
	const assignments = Object.fromEntries(
		template.split("\n").filter((line) => line !== "" && !line.startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
	const ingress = fileURLToPath(new URL("../packages/gateway/src/ingress/main.ts", import.meta.url));
	// The listener binds port 0 and is killed by the timeout: reaching the listen is what proves the configuration parsed.
	const started = runProcess(process.execPath, [ingress], {
		env: { ...assignments, HEPI_INGRESS_BACKEND: "http://127.0.0.1:1", HEPI_INGRESS_SERVICE_TOKEN: "fixture-service", HEPI_INGRESS_PORT: "0" },
		timeoutMs: 4000,
	});
	assert.equal(started.timedOut, true, "the template's own values start the listener: " + started.stderr);
	// And a stated empty numeric is exactly the failure the template must not produce.
	for (const name of ["HEPI_REVOCATION_CHECK_MS", "HEPI_UPLOAD_BATCH_BYTES"]) {
		const refused = runProcess(process.execPath, [ingress], {
			env: { ...assignments, [name]: "", HEPI_INGRESS_BACKEND: "http://127.0.0.1:1", HEPI_INGRESS_SERVICE_TOKEN: "fixture-service", HEPI_INGRESS_PORT: "0" },
			timeoutMs: 4000,
		});
		assert.equal(refused.status, 1, name + "= refuses to start");
		assert.match(refused.stderr, new RegExp(name + " must be a positive number"));
	}
});

/**
 * Promotion is the one step that changes what a unit runs, so it is the one that must never delete a published release.
 * The fixture publishes a staged directory twice: the first claim wins, the second is refused, and the published
 * directory is read back byte-for-byte.
 */
test("publishing refuses an existing release and leaves it exactly as it was", async () => {
	const root = fixtureDir();
	writeAt(root, "build/ingress.mjs", "published\n");
	const releaseDir = join(root, "release-644ac55");
	await publishRelease({ staging: join(root, "build"), releaseDir, rename, exists: existsSync });
	assert.equal(readFileSync(join(releaseDir, "ingress.mjs"), "utf8"), "published\n");
	// A second build of the same revision stages its own tree and is refused at promotion, not allowed to replace one.
	writeAt(root, "second/ingress.mjs", "replacement\n");
	await assert.rejects(
		publishRelease({ staging: join(root, "second"), releaseDir, rename, exists: existsSync }),
		/already exists: a published release is immutable/,
	);
	assert.equal(readFileSync(join(releaseDir, "ingress.mjs"), "utf8"), "published\n", "the published release is unchanged");
	assert.ok(statSync(join(releaseDir, "ingress.mjs")).isFile());
	// The same holds when the check went stale: an empty claim left at the path is replaced, a populated one is not.
	await rm(releaseDir, { recursive: true });
	writeAt(root, "release-644ac55/ingress.mjs", "someone else\n");
	await assert.rejects(publishRelease({ staging: join(root, "second"), releaseDir, rename, exists: () => false }), /already exists/);
	assert.equal(readFileSync(join(releaseDir, "ingress.mjs"), "utf8"), "someone else\n", "a rename never clobbers a populated directory");
});

test("the build script refuses a published release before it builds anything", () => {
	const root = fixtureDir();
	const repo = initRepo(root);
	const revision = repo.raw("rev-parse", "HEAD").trim();
	const out = fixtureDir();
	const releaseDir = writeAt(out, releaseDirName(artifactIdOf(revision)) + "/ingress.mjs", "published\n");
	// Refused at the same seam the plan and the guide use, and before the workspace it does not have is touched: an
	// error about the release directory is the proof, and the published file is still the one that was there.
	const result = runCli(script("build-client-runtime"), ["--root=" + root, "--out=" + out]);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, new RegExp(releaseDirName(artifactIdOf(revision)) + " already exists: a published release is immutable"));
	assert.equal(readFileSync(releaseDir, "utf8"), "published\n");
});

/**
 * A journey that runs against the release directory is evidence about the artifact a cutover switches; one that runs
 * against `apps/web/dist` and the TypeScript entrypoints is evidence about the checkout. This is the seam that tells the
 * two apart: the published release's own bundle, page and gateway tarball, or a refusal naming what is missing.
 */
test("a published release names the three things a run of it uses", () => {
	const root = fixtureDir();
	const releaseDir = join(root, "release-644ac55");
	writeAt(releaseDir, RELEASE_LAYOUT.bundle, "// bundle\n");
	writeAt(releaseDir, RELEASE_LAYOUT.staticDir + "/index.html", "<html></html>\n");
	writeAt(releaseDir, RELEASE_LAYOUT.gatewayDir + "/hepi-client-0.1.0.tgz", "tarball\n");
	writeAt(releaseDir, RELEASE_LAYOUT.marker, "644ac55e8fae\n");
	writeAt(releaseDir, RELEASE_LAYOUT.sums, "");
	writeAt(releaseDir, RELEASE_LAYOUT.provenance, JSON.stringify({ kind: "hepi-client-runtime", artifactId: "644ac55", revision: "644ac55e8fae", dirty: false, builtAt: "2026-10-18T00:00:00.000Z", host: "workstation", arch: "x64", os: "linux", platform: "linux/amd64", toolchain: { node: "v26.5.1" }, artifacts: [{ path: "ingress.mjs" }], image: { tag: "hepi-backend:644ac55-workstation", id: "sha256:abc amd64" } }) + "\n");
	const run = releaseArtifacts(releaseDir);
	assert.equal(run.bundle, join(releaseDir, "ingress.mjs"));
	assert.equal(run.staticDir, join(releaseDir, "web"));
	assert.equal(run.gatewayTarball, join(releaseDir, "gateway/hepi-client-0.1.0.tgz"));
	assert.equal(run.revision, "644ac55e8fae", "and the release states the commit it was built from");
	// A run of the release also starts the Backend image the release records, so the image tag is part of what a run
	// uses rather than something the caller guesses from the directory name.
	assert.equal(run.imageTag, "hepi-backend:644ac55-workstation");
	assert.equal(run.artifactId, "644ac55");
	// What is not a release is refused by name, because a run that silently fell back to the checkout would report the
	// checkout as the artifact. The page directory and the gateway tarball are the two the cutover switches.
	const noPage = fixtureDir();
	writeAt(noPage, RELEASE_LAYOUT.bundle, "// bundle\n");
	writeAt(noPage, RELEASE_LAYOUT.marker, "644ac55e8fae\n");
	assert.throws(() => releaseArtifacts(noPage), new RegExp(RELEASE_LAYOUT.staticDir));
	const noGateway = join(root, "release-partial");
	writeAt(noGateway, RELEASE_LAYOUT.bundle, "// bundle\n");
	writeAt(noGateway, RELEASE_LAYOUT.staticDir + "/index.html", "<html></html>\n");
	writeAt(noGateway, RELEASE_LAYOUT.marker, "644ac55e8fae\n");
	assert.throws(() => releaseArtifacts(noGateway), new RegExp(RELEASE_LAYOUT.gatewayDir));
	// A release whose record cannot answer "what image is this" is not something a run may call the artifact either.
	const badRecord = join(root, "release-norecord");
	writeAt(badRecord, RELEASE_LAYOUT.bundle, "// bundle\n");
	writeAt(badRecord, RELEASE_LAYOUT.staticDir + "/index.html", "<html></html>\n");
	writeAt(badRecord, RELEASE_LAYOUT.gatewayDir + "/hepi-client-0.1.0.tgz", "tarball\n");
	writeAt(badRecord, RELEASE_LAYOUT.marker, "644ac55e8fae\n");
	writeAt(badRecord, RELEASE_LAYOUT.provenance, "{}\n");
	assert.throws(() => releaseArtifacts(badRecord), /provenance/);
});

test("the build script refuses a dirty tree instead of naming a commit it did not build", () => {
	const root = fixtureDir();
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "one"], { cwd: root });
	// A clean tree gets past the refusal and fails later on the workspace it does not have, which is what proves the
	// dirty check ran first rather than after an expensive build.
	const clean = runCli(script("build-client-runtime"), ["--root=" + root, "--skip-backend", "--skip-web"]);
	assert.equal(clean.status, 1);
	assert.equal(/dirty tree/.test(clean.stderr), false, clean.stderr);
	writeFileSync(join(root, "dirty.txt"), "x\n");
	const dirty = runCli(script("build-client-runtime"), ["--root=" + root]);
	assert.equal(dirty.status, 1);
	assert.match(dirty.stderr, /refusing to build a release from a dirty tree/);
});
