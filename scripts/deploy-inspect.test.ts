/**
 * Workflow 3: `deploy:inspect --probe` and `deploy:plan`, as CLIs.
 *
 * The probe is a real producer: the controlled `ssh` executes the command the plan asked for,
 * and the `docker` on its PATH is an external fixture CLI (`testing/docker-fixture.ts`) that
 * behaves like docker - it reads the subcommand, honours the `--format` template and prints its
 * own state. Nothing here hands the parser the string it wants, so the probe's command line and
 * the parser cannot be written to the same invention: if either drifts, the template fails or the
 * parsed field is wrong.
 *
 * What this protects: a host fact, login, root, registry or secret reaching a report; a probe that
 * failed reading as a clean result; a plan that emits a command able to start production before its
 * gates; and an architecture read from a container instead of the image.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, initRepo, moduleLauncher, runCli, shim, writeAt, type FixtureRepo } from "./testing/fixture.ts";

const INSPECT = fileURLToPath(new URL("./deploy-inspect.mjs", import.meta.url));
const PLAN = fileURLToPath(new URL("./deploy-plan.mjs", import.meta.url));
const DOCKER_FIXTURE = fileURLToPath(new URL("./testing/docker-fixture.ts", import.meta.url));

const FAKE_HOST = "runtime-host.invalid";
const FAKE_ALIAS = "hepi-runtime";
const FAKE_REGISTRY = "registry.invalid/owner/repo";
const SECRET = "token-must-never-be-printed";
const CANARY = "canary-only-a-remote-host-would-print";
const COMMIT = "abc123fakecommit";
const BACKEND_ID = "a1".repeat(32);
const WEB_ID = "b2".repeat(32);
// The artifact id the deployment pinned, which is also the running backend image's tag and
// the name of the release directory. The three agree by the runbook's layout, not by luck.
const RELEASE_ID = "f3652d269697";

/** One record the docker fixture's state holds: the fields the probe's `--format` templates read. */
type DockerRecord = Record<string, unknown>;

/** The state the docker fixture answers from, in place of a daemon. */
type DockerState = { readonly images: DockerRecord[]; readonly containers: DockerRecord[] };

/** The probe section of the inspect report: what the read-only host commands said, whitelisted. */
type ProbeReport =
  | { readonly status: "ok"; readonly commit: string; readonly images: ReadonlyArray<{ readonly tag: string; readonly id: string; readonly arch: string }>; readonly containers: ReadonlyArray<{ readonly name: string; readonly image: string; readonly restartCount: number; readonly startedAt: string; readonly health: string }>; readonly warnings: readonly string[] }
  | { readonly status: "failed"; readonly failedField: string; readonly exitCode: number; readonly detail: string; readonly diagnosticsPath: string }
  | { readonly status: "skipped"; readonly detail: string };

/** The inspect report a `deploy:inspect` run writes. */
type InspectReport = {
  readonly source: { readonly sha: string; readonly dirty: boolean };
  readonly privateConfig: { readonly exists: boolean; readonly unknownKeys: readonly string[] };
  readonly probe: ProbeReport;
};

/** One runbook stage of the deployment plan. */
type PlanStage = {
  readonly stage: string;
  readonly role: string;
  readonly commands: readonly string[];
  readonly blockedBy: readonly string[];
  readonly manualPrerequisites: readonly string[];
  readonly evidence: string;
};

/** The plan report a `deploy:plan` run writes. */
type PlanReport = {
  readonly plan: {
    readonly artifactId: string;
    readonly images: Record<string, string>;
    readonly platforms: Record<string, string>;
    readonly stages: readonly PlanStage[];
    readonly rollback: { readonly automaticOverwrite: boolean };
  };
};

/** A report file a CLI wrote, read back at the shape its own tests assert on. */
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;


/** The stage a plan report names, or a failure: a plan that lost a stage is the finding. */
function stageOf(report: PlanReport, name: string): PlanStage {
  const stage = report.plan.stages.find((candidate) => candidate.stage === name);
  assert.ok(stage !== undefined, "the plan names a " + name + " stage");
  return stage;
}

/** The container a probe reported under `name`, or a failure: a report that dropped it is the finding. */
function containerOf(probe: Extract<ProbeReport, { status: "ok" }>, name: string): Extract<ProbeReport, { status: "ok" }>["containers"][number] {
  const container = probe.containers.find((candidate) => candidate.name === name);
  assert.ok(container !== undefined, "the probe reports " + name);
  return container;
}

/** The probe section as the `ok` result a read-only pass publishes, or a failure saying what it said instead. */
function okProbe(report: InspectReport): Extract<ProbeReport, { status: "ok" }> {
  assert.equal(report.probe.status, "ok", "the probe reports a read-only pass: " + JSON.stringify(report.probe));
  const probe = report.probe;
  return probe as Extract<ProbeReport, { status: "ok" }>;
}

/** What a test may state about the fixture host it builds. */
type FixtureHostOptions = {
  /** Whether the private configuration file exists, as a configured host would have it. */
  readonly withConfig?: boolean;
  /** The docker state the fixture CLI answers from, when a test needs records of its own. */
  readonly dockerState?: DockerState;
};

/** A throwaway repository plus the controlled host the probe reads: its files and its environment. */
type FixtureHost = {
  readonly root: string;
  readonly repo: FixtureRepo;
  readonly deployRoot: string;
  readonly release: string;
  readonly bin: string;
  readonly dockerLog: string;
  readonly sshLog: string;
  readonly env: Record<string, string>;
  readonly ssh: string;
};

/**
 * A throwaway repository plus a controlled host: a release marker the probe reads, an external
 * `docker` CLI, and an `ssh` that runs the remote command locally with that CLI on its PATH.
 */
function fixtureHost({ withConfig = true, dockerState }: FixtureHostOptions = {}): FixtureHost {
  const root = fixtureDir();
  const bin = join(root, "bin");
  // The runtime host's fixed layout: a deploy root holding `releases/<artifact-id>/`, each
  // release directory named by the artifact id the deployment pinned. The marker is not at the
  // deploy root, so a probe that reads `<root>/SOURCE_COMMIT` reads a path that does not exist.
  const deployRoot = join(root, "hepi-harness-deploy");
  const release = join(deployRoot, "releases", RELEASE_ID);
  writeAt(root, ".gitignore", ".dev/\n");
  writeAt(release, "SOURCE_COMMIT", COMMIT + "\n");
  // The fixture's own logs live under .dev/, which the fixture repository ignores: a fixture
  // must not dirty the revision the test is measuring.
  const dockerLog = join(root, ".dev", "docker-argv.log");
  const sshLog = join(root, ".dev", "ssh-argv.log");
  writeAt(root, ".dev/.gitkeep", "");
  // The fixture CLI keeps its source and its types in a module; the launcher is what standing
  // under the bare name `docker` on a PATH requires, since that name carries no extension.
  shim(bin, "docker", moduleLauncher(DOCKER_FIXTURE));
  const ssh = shim(bin, "ssh", [
    "#!/bin/sh",
    "# The last argument is the remote command; everything before it is ssh's own flags.",
    "for arg in \"$@\"; do cmd=\"$arg\"; done",
    "echo \"$cmd\" >> \"$FAKE_SSH_LOG\"",
    "if [ -n \"$FAKE_SSH_FAIL_ON\" ] && echo \"$cmd\" | grep -q \"$FAKE_SSH_FAIL_ON\"; then",
    "  echo \"$FAKE_SSH_CANARY\" >&2",
    "  exit 255",
    "fi",
    "echo \"Warning: permanently added host key\" >&2",
    "PATH=\"$FAKE_HOST_BIN:$PATH\" exec sh -c \"$cmd\"",
    "",
  ].join("\n"));
  if (withConfig) {
    writeAt(root, "deploy/deploy.local.env", [
      "DEPLOY_BUILD_HOST=" + FAKE_HOST,
      "DEPLOY_BUILD_SSH=" + FAKE_ALIAS,
      "DEPLOY_BUILD_ROOT=/home/fake-build/hepi",
      "DEPLOY_BUILD_ARCH=amd64",
      "DEPLOY_RUNTIME_HOST=" + FAKE_HOST,
      "DEPLOY_RUNTIME_SSH=" + FAKE_ALIAS,
      "DEPLOY_RUNTIME_ROOT=" + deployRoot,
      "DEPLOY_RUNTIME_ARCH=arm64",
      "DEPLOY_REGISTRY=" + FAKE_REGISTRY,
      "HEPI_AUTH_TOKEN=" + SECRET,
      "",
    ].join("\n"));
  }
  if (dockerState !== undefined) writeAt(root, "docker-state.json", JSON.stringify(dockerState));
  const repo = initRepo(root);
  repo.commit("fixture host");
  const env: Record<string, string> = {
    SSH_COMMAND: ssh,
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_CANARY: CANARY,
    FAKE_HOST_BIN: bin,
    FAKE_DOCKER_LOG: dockerLog,
    ...(dockerState === undefined ? {} : { FAKE_DOCKER_STATE: join(root, "docker-state.json") }),
  };
  return { root, repo, deployRoot, release, bin, dockerLog, sshLog, env, ssh };
}

/** Run one of the two deployment CLIs against the fixture host. */
const run = (script: string, host: FixtureHost, argv: readonly string[]) => runCli(script, ["--root=" + host.root, ...argv], { cwd: host.root, env: host.env });

/** The private values that must never appear in a report a person or a log can read. */
function assertNoHostFacts(text: string, label: string): void {
  for (const leaked of [FAKE_HOST, FAKE_ALIAS, FAKE_REGISTRY, SECRET, CANARY, "/home/fake-build"]) {
    assert.equal(text.includes(leaked), false, label + " must not contain " + leaked);
  }
}

test("a probe runs the real read-only commands through the controlled host and reports only whitelisted fields", () => {
  const host = fixtureHost();
  const json = join(host.root, "inspect.json");
  const result = run(INSPECT, host, ["--probe", "--json=" + json]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The release marker was read, and the images came back with the architecture docker reports
  // for them - the backend image is arm64 and the Web image amd64, in docker's own shapes.
  assert.match(result.stdout, new RegExp("probe\\s+ok, commit " + COMMIT));
  assert.match(result.stdout, new RegExp("image\\s+hepi-backend:f3652d269697 " + BACKEND_ID + " arm64"));
  assert.match(result.stdout, new RegExp("image\\s+hepi-web:f3652d269697 " + WEB_ID + " amd64"));
  assert.match(result.stdout, /container\s+hepi-backend-1 hepi-backend:f3652d269697 restart=0 health=healthy/);
  const report = readJson<InspectReport>(json);
  const probe = okProbe(report);
  assert.equal(probe.commit, COMMIT);
  assert.equal(probe.images.length, 2, "the dangling <none>:<none> image is dropped");
  assert.deepEqual(probe.images.map((image) => image.arch), ["arm64", "amd64"]);
  assert.equal(probe.containers[0].restartCount, 0);
  assert.equal(probe.containers[0].health, "healthy");
  assert.match(probe.containers[0].startedAt, /^2026-10-11T00:00:00/);
  assertNoHostFacts(result.stdout + result.stderr + JSON.stringify(report), "the probe report");
  // A key the configuration parser does not know is reported, not dropped: a typo must not
  // read as "not configured".
  assert.deepEqual(report.privateConfig.unknownKeys, ["HEPI_AUTH_TOKEN"]);
  // The ssh fixture's own stderr line is captured by the runner and never printed.
  assert.equal((result.stdout + result.stderr).includes("permanently added"), false);
  // The probe asked for exactly the read-only commands the plan documents.
  const asked = readFileSync(host.sshLog, "utf8");
  assert.match(asked, new RegExp("cat " + host.release + "/SOURCE_COMMIT"));
  assert.match(asked, /docker image ls --no-trunc/);
  assert.match(asked, /docker image inspect --format/);
  assert.match(asked, /docker ps --format/);
  assert.match(asked, /docker inspect --format/);
  // Nothing a host could be asked to change: the docker fixture refuses any other subcommand,
  // so the log also proves the probe ran only the verbs it was supposed to.
  for (const line of readFileSync(host.dockerLog, "utf8").split("\n").filter(Boolean)) {
    const argv = JSON.parse(line) as string[];
    assert.ok(["image", "ps", "inspect"].includes(argv[0]), "unexpected docker verb: " + argv.join(" "));
    for (const forbidden of ["up", "build", "buildx", "pull", "push", "exec", "run", "rm", "compose", "restart", "stop", "start"]) {
      assert.equal(argv.includes(forbidden), false, "probe asked for " + forbidden);
    }
  }
});

test("a container with no HEALTHCHECK reports its absence instead of failing the read", () => {
  const host = fixtureHost();
  const json = join(host.root, "inspect.json");
  const result = run(INSPECT, host, ["--probe", "--json=" + json]);
  // docker renders `--format` with `missingkey=error`: a template that names `.State.Health` fails
  // the whole `docker inspect` call - for every container - as soon as one of them has no health
  // check. This fixture host runs one such container, as the runtime host does, so a probe that
  // does not tolerate the absence fails here the way it did against the real host.
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const probe = okProbe(readJson<InspectReport>(json));
  // The release marker was read. The container detail read is planned before it, so a detail
  // read that failed is exactly what used to hide the running release.
  assert.equal(probe.commit, COMMIT);
  const healthless = containerOf(probe, "hepi-redis-1");
  assert.equal(healthless.health, "none", "a container with no health check reports none, not a failure");
  assert.equal(healthless.restartCount, 0);
  assert.match(healthless.startedAt, /^2026-09-20T/);
  const healthy = containerOf(probe, "hepi-backend-1");
  assert.equal(healthy.health, "healthy", "the containers that do have a health check still report theirs");
  assert.match(result.stdout, /container\s+hepi-redis-1 redis:7-alpine restart=0 health=none/);
  assertNoHostFacts(result.stdout + result.stderr + JSON.stringify(probe), "the probe report");
});

test("the architecture comes from the image, not from the configuration or a container", () => {
  const host = fixtureHost({
    dockerState: {
      images: [{ Id: "sha256:" + BACKEND_ID, Repository: "hepi-backend", Tag: "f3652d269697", Architecture: "amd64", Size: "412MB" }],
      containers: [{
        Id: "9f1c0de4".repeat(8),
        Names: "hepi-backend-1",
        Image: "hepi-backend:f3652d269697",
        Status: "Up 3 hours",
        Name: "/hepi-backend-1",
        RestartCount: 0,
        StartedAt: "2026-10-11T00:00:00.123456789Z",
        Config: { Image: "hepi-backend:f3652d269697" },
        State: { StartedAt: "2026-10-11T00:00:00.123456789Z", Health: { Status: "healthy" } },
      }],
    },
  });
  const result = run(INSPECT, host, ["--probe"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The private configuration says the runtime host is arm64; the image says amd64. The image
  // wins, because that is the artifact that would actually run.
  assert.match(result.stdout, new RegExp("image\\s+hepi-backend:f3652d269697 " + BACKEND_ID + " amd64"));
  assert.match(result.stdout, /role\s+runtime\s+host=set ssh=set root=set arch=arm64/);
  assertNoHostFacts(result.stdout, "the probe report");
});

test("a failed probe fails the command and keeps the raw host output out of the report", () => {
  const host = fixtureHost();
  const json = join(host.root, "inspect.json");
  const result = runCli(INSPECT, ["--root=" + host.root, "--probe", "--json=" + json], {
    cwd: host.root,
    env: { ...host.env, FAKE_SSH_FAIL_ON: "image inspect" },
  });
  // Non-zero: a probe that did not succeed must never read as a clean report.
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stdout, /probe\s+FAILED field=imageArch exit=255/);
  assert.match(result.stdout, /the read-only probe command exited non-zero/);
  assert.match(result.stdout, /probe-raw\.log \(git-ignored\)/);
  assertNoHostFacts(result.stdout + result.stderr, "the failed probe report");
  const report = readJson<InspectReport>(json);
  assert.equal(report.probe.status, "failed");
  const failed = report.probe as Extract<ProbeReport, { status: "failed" }>;
  assert.equal(failed.failedField, "imageArch");
  assert.equal(failed.exitCode, 255);
  // A probe that did not succeed is published as its failure, never as a zero that reads clean.
  assert.notEqual(report.probe.status, "skipped");
  assertNoHostFacts(JSON.stringify(report), "the failed probe report");
  // Both streams of the failing call are kept, for the operator, under the git-ignored .dev/.
  const runs = readdirSync(join(host.root, ".dev", "deploy-inspect"));
  assert.equal(runs.length, 1);
  const raw = readFileSync(join(host.root, ".dev", "deploy-inspect", runs[0], "probe-raw.log"), "utf8");
  assert.match(raw, new RegExp(CANARY), "the remote stderr must be kept for the operator");
  assert.match(raw, /## imageArch \(ssh exited 255\)/);
  assert.match(raw, new RegExp(RELEASE_ID), "the output of the steps that did succeed is kept too");
  assert.match(raw, /### stdout/);
  assert.match(raw, /### stderr/);
});

test("the running release comes from the backend image, not another container's tag", () => {
  const host = fixtureHost({
    dockerState: {
      images: [
        { Id: "sha256:" + BACKEND_ID, Repository: "hepi-backend", Tag: RELEASE_ID, Architecture: "arm64", Size: "412MB" },
        { Id: "sha256:" + WEB_ID, Repository: "hepi-web", Tag: "df24b7c", Architecture: "amd64", Size: "233MB" },
      ],
      containers: [
        {
          Id: "9f1c0de4".repeat(8),
          Names: "hepi-backend-1",
          Image: "hepi-backend:" + RELEASE_ID,
          Status: "Up 3 hours",
          Name: "/hepi-backend-1",
          RestartCount: 0,
          StartedAt: "2026-10-11T00:00:00.123456789Z",
          Config: { Image: "hepi-backend:" + RELEASE_ID },
          State: { StartedAt: "2026-10-11T00:00:00.123456789Z", Health: { Status: "healthy" } },
        },
        {
          Id: "8e2b0fd3".repeat(8),
          Names: "hepi-oracle-web-1",
          Image: "hepi-web:df24b7c",
          Status: "Up 3 hours",
          Name: "/hepi-oracle-web-1",
          RestartCount: 0,
          StartedAt: "2026-10-11T00:00:00.123456789Z",
          Config: { Image: "hepi-web:df24b7c" },
          State: { StartedAt: "2026-10-11T00:00:00.123456789Z", Health: { Status: "healthy" } },
        },
      ],
    },
  });
  // A retained release the Web image happens to name, beside the one the backend runs.
  writeAt(host.deployRoot, "releases/df24b7c/SOURCE_COMMIT", "web-release-commit\n");
  const result = run(INSPECT, host, ["--probe"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp("probe\\s+ok, commit " + COMMIT));
  assert.equal(result.stdout.includes("web-release-commit"), false);
  assert.match(readFileSync(host.sshLog, "utf8"), new RegExp("cat " + host.release + "/SOURCE_COMMIT"));
});

test("a release directory no running container names is reported, not guessed", () => {
  const host = fixtureHost({
    dockerState: {
      images: [{ Id: "sha256:" + BACKEND_ID, Repository: "hepi-backend", Tag: "not-a-release", Architecture: "arm64", Size: "412MB" }],
      containers: [{
        Id: "9f1c0de4".repeat(8),
        Names: "hepi-backend-1",
        Image: "hepi-backend:not-a-release",
        Status: "Up 3 hours",
        Name: "/hepi-backend-1",
        RestartCount: 0,
        StartedAt: "2026-10-11T00:00:00.123456789Z",
        Config: { Image: "hepi-backend:not-a-release" },
        State: { StartedAt: "2026-10-11T00:00:00.123456789Z", Health: { Status: "healthy" } },
      }],
    },
  });
  const result = run(INSPECT, host, ["--probe"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /probe\s+ok, commit unknown/);
  assert.match(result.stdout, /warning\s+the release marker was not read: no running container names a release directory/);
  // The probe read the release listing and stopped there: it never invented a marker path.
  assert.equal(readFileSync(host.sshLog, "utf8").includes("SOURCE_COMMIT"), false);
});

test("the plan emits no command that could start production, and states what it cannot determine", () => {
  const host = fixtureHost({ withConfig: false });
  const result = run(PLAN, host, []);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const sha = host.repo.raw("rev-parse", "HEAD").trim();
  assert.match(result.stdout, new RegExp("backend-image <registry>/<owner>/<repo>/backend:" + sha.slice(0, 12)));
  assert.match(result.stdout, /backend-image .* \(built for linux\/<runtime-arch>\)/);
  // The retired Next container is gone from the plan: the Web origin is the client-runtime release, not an image.
  assert.equal(result.stdout.includes("web-image"), false);
  // The dangerous generated path is gone: with no compose command there is no default image
  // and no new named volume to fall back to.
  assert.equal(result.stdout.includes("docker compose"), false);
  assert.equal(result.stdout.includes("--no-build"), false);
  assert.match(result.stdout, /role\s+runtime\s+host=unset arch=<unset>\s+\(incomplete\)/);
  assert.match(result.stdout, /switch\s+\[runtime\]\s+incomplete: needs DEPLOY_RUNTIME_HOST/);
  assert.match(result.stdout, /\(no command emitted: the private inputs this stage needs are unset\)/);
  assert.match(result.stdout, /blocked by: backup must have completed for this run/);
  assert.match(result.stdout, /gate\s+single-writer before switch/);
  assert.match(result.stdout, /gate\s+backup-verified before switch/);
  assert.match(result.stdout, /manual: a runtime override that pins the backend image/);
  assert.match(result.stdout, /manual: the writer stopped and proven stopped before anything is copied/);
  assertNoHostFacts(result.stdout, "the plan");
  // Planning contacts nothing: the controlled host's docker CLI was never invoked.
  assert.equal(existsSync(host.dockerLog), false);
  assert.equal(existsSync(host.sshLog), false);
});

test("each role's own architecture decides the image it is built for", () => {
  const host = fixtureHost();
  const json = join(host.root, "plan.json");
  const result = run(PLAN, host, ["--json=" + json]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson<PlanReport>(json);
  // The backend runs the harness on the runtime host; the client-runtime release is assembled on the build center.
  assert.equal(report.plan.platforms.backend, "linux/arm64");
  assert.deepEqual(Object.keys(report.plan.images), ["backend"]);
  const switchStage = stageOf(report, "switch");
  assert.deepEqual(switchStage.commands, []);
  assert.deepEqual(switchStage.blockedBy, ["backup"]);
  assert.match(switchStage.manualPrerequisites.join(" "), /keeps the existing state volume/);
  assert.equal(report.plan.rollback.automaticOverwrite, false);
  const verifyArtifact = stageOf(report, "verify-artifact");
  assert.equal(verifyArtifact.commands.length, 1);
  assert.match(verifyArtifact.commands[0], /docker image inspect/);
  assertNoHostFacts(JSON.stringify(report), "the plan report");
});

test("a dirty tree is named as such instead of being reported as the commit", () => {
  const host = fixtureHost();
  writeAt(host.root, "uncommitted.txt", "work in progress\n");
  const result = run(PLAN, host, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /source\s+[0-9a-f]{40} \(dirty tree: the plan names a commit this tree is not\)/);
});
