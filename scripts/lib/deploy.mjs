/**
 * Read-only deployment inspection and offline planning.
 *
 * Three rules shape this module:
 *
 * - **Nothing here writes to a host.** `inspect` reads the repository, reads git-ignored
 *   private configuration, and (only when asked) runs one fixed set of read-only commands
 *   over SSH. `plan` prints what a deployment would do and touches nothing. There is no
 *   apply, no sync and no deploy: those need the runbook and an operator.
 * - **Host-specific facts never reach a public report.** Real host names, addresses, logins,
 *   absolute roots and registry coordinates live in git-ignored private configuration. A
 *   report says `host=set`, never the host; a plan prints `<registry>/...`, never the
 *   registry. A probe result is mapped through a whitelist before it is printed.
 * - **A command is printed only when it is fully determined.** Where a step needs a private
 *   value the configuration does not carry - the state paths, the runtime override that pins
 *   an image - the plan states the prerequisite instead of guessing a command, a volume or a
 *   default tag.
 *
 * The stage names and their evidence match docs/deployment-runbook.md; where the two
 * disagree, the runbook is the contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitState } from "./cli.mjs";
import { releaseNameForRevision } from "./client-runtime.mjs";

/** The repository root, derived from this file: `scripts/lib/` -> repository. */
export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Roles this repository has. Two hosts, two jobs: build center, runtime host. */
export const ROLES = ["build", "runtime"];

/**
 * The image coordinates a plan prints. Deliberately not the real registry: a plan is public
 * output, and a registry host is a host-specific fact like any other.
 */
export const IMAGE_PREFIX = "<registry>/<owner>/<repo>";

/** The fields a role must carry before a deployment step can run against it. */
export const ROLE_FIELDS = ["host", "ssh", "root", "arch"];

/**
 * The runtime backend image's repository name, as `deploy/compose.yaml` and the runbook tag it.
 * The backend runs the artifact a release directory names, so its image tag is the artifact id
 * the release directory is named by; the Web image's tag is a different role's and must not be
 * read as a release name.
 */
export const BACKEND_IMAGE = "hepi-backend";

/** The git-ignored private configuration, beside the other deployment files. */
export function privateConfigPath(root = repoRoot()) {
  return join(root, "deploy", "deploy.local.env");
}

/** The keys a role may carry. Anything else is reported, never silently dropped. */
const ROLE_KEYS = { host: "host", ssh: "ssh", root: "root", arch: "arch" };

const TOP_KEYS = { registry: "registry" };

/**
 * Parse the private config: `DEPLOY_<ROLE>_<KEY>=value` plus `DEPLOY_<KEY>=value`.
 *
 * Deliberately the same shape as the deployment env files an operator already keeps, so
 * this adds a file convention rather than a configuration system. Unknown keys are
 * returned as warnings instead of being ignored silently: a typo in a host name would
 * otherwise read as "not configured".
 */
export function parsePrivateConfig(text) {
  const roles = { build: {}, runtime: {} };
  const top = {};
  const unknown = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      unknown.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    const parts = key.split("_");
    if (parts[0] !== "DEPLOY") {
      unknown.push(key);
      continue;
    }
    const role = parts[1]?.toLowerCase();
    if (role !== undefined && ROLES.includes(role)) {
      const field = parts.slice(2).join("_").toLowerCase();
      if (field === "" || !(field in ROLE_KEYS)) {
        unknown.push(key);
        continue;
      }
      roles[role][field] = value;
      continue;
    }
    const field = parts.slice(1).join("_").toLowerCase();
    if (field === "" || !(field in TOP_KEYS)) {
      unknown.push(key);
      continue;
    }
    top[field] = value;
  }
  return { roles, registry: top.registry, unknown };
}

/**
 * Read the private configuration. Absence is a normal, reported state, not an error: a
 * contributor without host access can still run `inspect` and `plan`, minus the probe.
 */
export function readPrivateConfig(root = repoRoot(), path = privateConfigPath(root)) {
  if (!existsSync(path)) {
    return { ok: true, exists: false, path, roles: { build: {}, runtime: {} }, registry: undefined, unknown: [] };
  }
  const parsed = parsePrivateConfig(readFileSync(path, "utf8"));
  return { ok: true, exists: true, path, ...parsed };
}

/** The configuration keys a role is still missing, as `DEPLOY_<ROLE>_<KEY>`. */
export function missingRoleKeys(name, fields = {}) {
  return ROLE_FIELDS.filter((field) => !fields[field]).map((field) => "DEPLOY_" + name.toUpperCase() + "_" + field.toUpperCase());
}

/**
 * A role as it may appear in a report: which fields are set, never their values.
 *
 * `host`, `ssh` and `root` are the fields that would leak a host, a login or a personal
 * path, so all three collapse to booleans here and stay that way through every printer.
 * `arch` is an architecture, not an identity, and is reported as itself.
 */
export function describeRole(name, config) {
  const fields = config ?? {};
  return {
    role: name,
    hostConfigured: Boolean(fields.host),
    sshAliasConfigured: Boolean(fields.ssh),
    rootConfigured: Boolean(fields.root),
    arch: fields.arch ?? "<unset>",
    configured: ROLE_FIELDS.every((field) => Boolean(fields[field])),
    missing: missingRoleKeys(name, fields),
  };
}

/**
 * The immutable source identity: the commit is the release name, and a dirty tree is
 * reported beside it rather than hidden, because a dirty run measured something the
 * commit does not name.
 */
export function sourceIdentity(root = repoRoot(), revision = "HEAD") {
  const state = gitState(root);
  const sha = state.sha || revision;
  return {
    revision,
    sha,
    dirty: state.dirty,
    dirtyFiles: state.dirtyFiles,
    artifactId: sha.slice(0, 12),
    archiveCommand: "git archive --format=tar.gz -o hepi-" + sha.slice(0, 12) + ".tar.gz " + sha,
  };
}

/**
 * The read-only probe plan: one fixed command per field, run only when the operator asks
 * for it and only when the runtime role has an ssh alias.
 *
 * Every command is read-only by construction - `cat` of the release marker, `docker image
 * ls`, `docker image inspect`, `docker ps` - with no `up`, `build`, `pull`, `exec`,
 * `systemctl`, no write and no secret read. The commands are plain text on purpose: this
 * side parses their output into a fixed structure, so nothing is asked of the host beyond
 * the docker CLI it already runs. The *architecture* is read from the images, never from a
 * running container. The release marker is addressed by the artifact id a running container
 * names - `<root>/releases/<artifact-id>/SOURCE_COMMIT` - never by a fixed path under the
 * runtime root, because the runtime root holds `releases/<artifact-id>/`, not the marker.
 *
 * The container detail template reaches the health status through `index`, not `.State.Health`:
 * docker renders `--format` with `missingkey=error`, so naming `Health` fails the *whole* call as
 * soon as one running container has no `HEALTHCHECK` - the normal state on a shared host, and not
 * a fact about the container the probe is asking after. `index` yields the zero value for a key
 * that is absent, so a container without a health check reports `none` instead of failing the
 * read, and the containers that do have one still report theirs.
 */
export function probePlan(config, root = repoRoot()) {
  const runtime = config.roles.runtime ?? {};
  if (!config.exists) {
    return { configured: false, reason: "no private configuration at deploy/deploy.local.env" };
  }
  if (!runtime.ssh) {
    return { configured: false, reason: "DEPLOY_RUNTIME_SSH is not set in the private configuration" };
  }
  const steps = [];
  if (runtime.root) {
    // The runtime root holds the fixed layout `releases/<artifact-id>/`; the marker is read
    // from the release directory, whose id the running container names (see runningReleaseId).
    steps.push({ field: "releases", command: "ls -1 " + runtime.root + "/releases" });
  }
  steps.push(
    { field: "images", command: "docker image ls --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}'" },
    { field: "imageArch", command: "docker image inspect --format '{{.Id}} {{.Architecture}}' $(docker image ls -q)" },
    { field: "containers", command: "docker ps --format '{{.Names}} {{.Image}} {{.Status}}'" },
    {
      field: "containerDetail",
      // `index` rather than `.State.Health.Status`: docker's `missingkey=error` would fail every
      // container's inspect as soon as one lacks a health check. See the module comment.
      command: "docker inspect --format '{{.Name}} {{.Config.Image}} {{.RestartCount}} {{.State.StartedAt}} {{with index .State \"Health\"}}{{.Status}}{{else}}none{{end}}' $(docker ps -q)",
    },
  );
  return {
    configured: true,
    transport: "ssh",
    sshAlias: runtime.ssh,
    root: runtime.root,
    rootConfigured: Boolean(runtime.root),
    notProbed: [
      "the durable database files: their paths are container-local and private, so integrity is the backup stage's operator check, not a probe",
    ],
    steps,
  };
}

const stripDigest = (id) => String(id ?? "").replace(/^sha256:/, "");
const linesOf = (text) => String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);

/**
 * The release marker's path in the runtime host's fixed layout.
 *
 * The runbook's roots put each release under `<runtime-root>/releases/<artifact-id>/`, and a
 * release directory is named by the artifact id the deployment pinned - the same id the
 * running backend image carries. The marker is addressed by that id, never by a fixed path
 * under the runtime root.
 */
export function releaseMarkerPath(root, artifactId) {
  return root + "/releases/" + artifactId + "/SOURCE_COMMIT";
}

/**
 * Which release the probe's own output says is running, from the two fields that name it.
 *
 * The layout names a release directory after the artifact id, and the deployment tags the
 * running backend image with that same id, so the running release is the release directory
 * whose name appears as a running backend container's image tag. Both facts come from the same
 * probe, so nothing assumes which release is "current": a rollback that re-points the tag is
 * followed, and a listing that matches no backend container, or more than one, is reported
 * rather than guessed. A Web container's tag is not consulted: it names a different role and
 * could coincide with a retained release directory.
 */
export function runningReleaseId(outputs = {}) {
  const ids = linesOf(outputs.releases).filter((id) => !id.startsWith("."));
  if (ids.length === 0) return { reason: "the runtime root lists no release directories" };
  const tags = new Set();
  for (const line of linesOf(outputs.containers)) {
    const [, image] = line.split(/\s+/);
    const [repository, tag] = String(image ?? "").split(":");
    if (repository === BACKEND_IMAGE && tag) tags.add(tag);
  }
  const matched = ids.filter((id) => tags.has(id));
  if (matched.length === 1) return { id: matched[0] };
  if (matched.length === 0) return { reason: "no running container names a release directory" };
  return { reason: "more than one release directory is named by a running container: " + matched.join(", ") };
}

/**
 * Map the probe's plain-text outputs into the report whitelist.
 *
 * Only these fields survive: the release commit, image tag/id/architecture, and container
 * name/image/restart count/start time/health (`none` when the container has no health check).
 * Absolute paths, host names, logins,
 * environment values and anything else a host happens to print are dropped by construction,
 * because this function never copies a field it was not given a slot for.
 *
 * `outputs` is keyed by probe field, so a producer that stops filling a field leaves an
 * empty section rather than a crash.
 */
export function parseProbeOutput(outputs = {}) {
  const warnings = [];
  const commit = linesOf(outputs.commit)[0] ?? "";

  const archByImageId = new Map();
  for (const line of linesOf(outputs.imageArch)) {
    const [id, arch] = line.split(/\s+/);
    if (id && arch) archByImageId.set(stripDigest(id), arch);
  }
  const images = [];
  for (const line of linesOf(outputs.images)) {
    const [tag, id] = line.split(/\s+/);
    if (!tag || tag === "<none>:<none>") continue;
    const key = stripDigest(id ?? "");
    const matched = [...archByImageId.keys()].find((full) => full.startsWith(key) || key.startsWith(full));
    images.push({ tag, id: key, arch: matched === undefined ? "" : archByImageId.get(matched) });
  }
  if (images.length > 0 && archByImageId.size === 0) {
    warnings.push("image architectures were not reported; the architecture check has no image to read");
  }

  const detailByName = new Map();
  for (const line of linesOf(outputs.containerDetail)) {
    const [name, image, restart, startedAt, health] = line.split(/\s+/);
    if (!name) continue;
    const restartCount = Number.parseInt(restart ?? "", 10);
    detailByName.set(name.replace(/^\//, ""), {
      image: image ?? "",
      restartCount: Number.isInteger(restartCount) ? restartCount : null,
      startedAt: startedAt ?? "",
      health: health ?? "",
    });
  }
  const containers = linesOf(outputs.containers).map((line) => {
    const [name, image, ...status] = line.split(/\s+/);
    const detail = detailByName.get(name) ?? {};
    return {
      name,
      image,
      status: status.join(" "),
      restartCount: detail.restartCount ?? null,
      startedAt: detail.startedAt ?? "",
      health: detail.health ?? "",
    };
  }).filter((container) => container.name);

  return { commit, images, containers, warnings };
}

/**
 * The offline plan: the runbook stages with the concrete artifact identity, the pinned image
 * tags, the role each step runs on, the manual prerequisites a stage needs from its operator,
 * and the evidence the step must leave.
 *
 * It prints commands, never executes them; every host-specific value is a placeholder and
 * every step whose private inputs are unset is marked incomplete instead of being given a
 * guessed command. The one thing it will not do is emit a compose command that would silently
 * fall back to a local image or a fresh volume.
 */
export function deployPlan({ source, roles = {}, artifactId }) {
  const id = artifactId ?? source.artifactId;
  const build = roles.build ?? {};
  const runtime = roles.runtime ?? {};
  const backendImage = IMAGE_PREFIX + "/backend:" + id;
  // The client-runtime release is the one artifact a Web cutover switches: the ingress bundle, the static Web build and
  // the Backend image, named by the commit and promoted as one directory (scripts/lib/client-runtime.mjs). Named by the
  // builder's own function, from the commit: the plan and the build must not be able to disagree about the directory a
  // cutover switches to.
  const clientRelease = releaseNameForRevision(source.sha);
  // The backend runs the harness, so it is built for the runtime host. The ingress bundle and the static Web build are
  // built and served from the build center, so the release is assembled there.
  const backendPlatform = runtime.arch ?? "<runtime-arch>";
  const buildMissing = missingRoleKeys("build", build);
  const runtimeMissing = missingRoleKeys("runtime", runtime);

  const stages = [
    {
      stage: "inspect",
      role: "either",
      commands: runtime.ssh ? ["node scripts/deploy-inspect.mjs --probe"] : ["node scripts/deploy-inspect.mjs"],
      manualPrerequisites: runtime.ssh
        ? []
        : ["set the runtime role in the private configuration to read the deployed state; without it only the local side is inspected"],
      requiresConfig: [],
      evidence: "running units, image tags and ids, image architecture, release commit; compared against the record",
    },
    {
      stage: "plan",
      role: "either",
      commands: ["node scripts/deploy-plan.mjs --artifact=" + id],
      manualPrerequisites: [],
      requiresConfig: [],
      evidence: "this plan: immutable source, artifact identity, affected roles, and the previous image it replaces",
    },
    {
      stage: "build",
      role: "build",
      commands: [
        "git archive --format=tar.gz -o hepi-" + id + ".tar.gz " + source.sha,
        "pnpm install --frozen-lockfile",
        "pnpm -r typecheck && pnpm -r test",
        "node scripts/build-client-runtime.mjs --platform=linux/" + backendPlatform,
        "docker buildx build --platform linux/" + backendPlatform + " -f deploy/docker/backend.Dockerfile -t " + backendImage + " .",
      ],
      manualPrerequisites: ["the build center's Docker layer cache and pnpm store are reused; nothing here runs on the runtime host"],
      requiresConfig: buildMissing.concat(runtime.arch ? [] : ["DEPLOY_RUNTIME_ARCH"]),
      evidence: "one image id per image, tagged by commit rather than by a floating tag, plus the " + clientRelease + " directory with its SHA256SUMS and provenance; never built on the runtime host",
    },
    {
      stage: "verify-artifact",
      role: "runtime",
      commands: ["docker image inspect --format '{{.Id}} {{.Architecture}}' " + backendImage],
      manualPrerequisites: ["compare the inspected digest and architecture against the build center's output before anything is switched"],
      requiresConfig: runtimeMissing,
      evidence: "image digest and architecture equal to the build center's, read from the image and never from a container",
    },
    {
      stage: "backup",
      role: "runtime",
      commands: [],
      manualPrerequisites: [
        "the writer stopped and proven stopped before anything is copied",
        "the state paths taken from the running backend's own environment (HEPI_DB, HEPI_PROJECTS, HEPI_SKILL_REPOSITORY), not assumed",
        "one verified copy per durable database, checked with integrity_check and expected row counts before it is called a backup",
      ],
      requiresConfig: runtimeMissing,
      evidence: "one verified copy per durable database, named by the paths the running container actually uses",
    },
    {
      stage: "switch",
      role: "runtime",
      commands: [],
      manualPrerequisites: [
        "a runtime override that pins the backend image to this artifact and keeps the existing state volume",
        "the existing env file (mode 0600) carrying the provider settings and the auth token",
        "the " + clientRelease + " directory promoted with a single rename, and the ingress unit rendered from it by node scripts/ingress-unit.mjs",
        "the process that used to bind the Web origin's port stopped and proven stopped before the ingress starts on it",
        "both gates below satisfied for this run",
      ],
      requiresConfig: runtimeMissing,
      blockedBy: ["backup"],
      evidence: "new pinned artifact; RestartCount=0 and an unchanged StartedAt when the artifact is byte-identical",
    },
    {
      stage: "smoke",
      role: "runtime",
      commands: [
        "curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:<backend-port>/api/models",
        "curl -s -H \"authorization: Bearer <token>\" http://127.0.0.1:<backend-port>/api/models",
      ],
      manualPrerequisites: ["the port and the token are read from the running container's environment, not assumed"],
      requiresConfig: runtimeMissing,
      evidence: "401 unauthenticated, 200 authenticated, conversation continuity; read-only, no model call",
    },
    {
      stage: "record",
      role: "either",
      commands: ["node scripts/deploy-plan.mjs --json=<path>"],
      manualPrerequisites: [],
      requiresConfig: [],
      evidence: "a dated record under docs/ with the ids, digests, counts and smoke results",
    },
  ];

  return {
    artifactId: id,
    clientRelease,
    images: { backend: backendImage },
    platforms: { backend: "linux/" + backendPlatform },
    stages,
    affected: [
      { role: "runtime", service: "backend", image: backendImage, changed: "always (the harness runs here)" },
      { role: "build", service: "ingress", image: clientRelease, changed: "always (the client surface and the page it serves)" },
      { role: "build", service: "gateway", image: "<client bundle>", changed: "only when packages/ moved across the range" },
    ],
    gates: [
      {
        gate: "single-writer",
        before: "switch",
        requirement: "exactly one writer holds the state files; the previous process is stopped and proven stopped",
      },
      {
        gate: "backup-verified",
        before: "switch",
        requirement: "every durable database has a verified copy taken by this run",
      },
    ],
    rollback: {
      application: "re-pin the previous artifact (or restore the copied unit) and restart; the database is untouched",
      database: "a separate operation: stop the writer, verify the backup, move the live file aside, record it",
      schemaCheck: "required before an image rollback: confirm the older image can read the current schema",
      automaticOverwrite: false,
    },
    notes: [
      "No step in this plan runs on the runtime host except deploy, run and read-only verification.",
      "The runtime host never builds, installs or runs the test gate: the backend image is built for the runtime host's architecture, and the client-runtime release (ingress bundle, static Web build, gateway tarball) is assembled on the build center.",
      "No image default and no new named volume is assumed. The switch stage resolves its image and its state volume from private configuration and the runtime override, never from a compose default, and no step may fall back to a local hepi-backend:local tag.",
      "Existing state paths are preserved: this plan does not move, rename or migrate a database.",
      "Applying this plan is an operator action; the scripts print it and stop. There is no apply command.",
    ],
  };
}
