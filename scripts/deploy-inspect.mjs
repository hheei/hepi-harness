/**
 * `deploy:inspect` — what is deployed, as read-only evidence, with no host facts and no
 * raw host output in its report.
 *
 * Without `--probe` it reports the local side only: the immutable source identity, which
 * role fields are configured (booleans, never values), the image coordinates a plan would
 * use (placeholders, never the real registry), and the evidence timestamp. With `--probe` it
 * runs the plan's fixed read-only command set over SSH — one call per field — and maps the
 * output through a whitelist before printing it. The release marker is addressed by the
 * artifact id the running backend image names, so the probe reads
 * `<runtime-root>/releases/<artifact-id>/SOURCE_COMMIT`, never a fixed path under the root.
 *
 * Raw host output is never printed: it can carry a host name, a path or a login. When a probe
 * fails, the report says which field failed and with what exit code, and the raw text goes to
 * a git-ignored diagnostics file for the operator. The command exits non-zero when the probe
 * it was asked for did not succeed, so a failed probe cannot read as a clean report.
 *
 * `--root=<dir>` inspects a checkout other than the one the script lives in, which is how the
 * tests drive it, and `SSH_COMMAND` overrides the ssh binary the probe spawns, which is how the
 * tests supply a fixture host instead of a real one.
 *
 * Usage: node scripts/deploy-inspect.mjs [--root=<dir>] [--probe] [--json=<path>]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EOL } from "node:os";
import { isMain, parseCli, writeJson } from "./lib/cli.mjs";
import {
  IMAGE_PREFIX,
  deployPlan,
  describeRole,
  parseProbeOutput,
  probePlan,
  readPrivateConfig,
  releaseMarkerPath,
  repoRoot,
  runningReleaseId,
  sourceIdentity,
} from "./lib/deploy.mjs";

/**
 * Run the probe's fixed fields over SSH, then the release marker the running container names,
 * and return their stdout or a failure that names the field.
 *
 * The raw text is returned to the caller for its diagnostics file and is *not* part of the
 * report: a remote shell's stderr is exactly where a host name or a path would appear.
 */
const USAGE = `
Usage: node scripts/deploy-inspect.mjs [--root=<dir>] [--probe] [--json=<path>]

  --root=<dir>    inspect a checkout other than the one the script lives in
  --probe         add the plan's fixed read-only SSH read of the runtime role
  --json=<path>   write the report as JSON at <path>
  -h, --help      print this usage and exit
`;
export function runProbe(probe, { ssh = process.env.SSH_COMMAND ?? "ssh", spawn = spawnSync } = {}) {
  const outputs = {};
  const raw = [];
  const warnings = [];
  const read = (step) => {
    const result = spawn(ssh, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", probe.sshAlias, step.command], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    raw.push([
      "## " + step.field + " (ssh exited " + String(result.status ?? "spawn-failed") + ")",
      "### stdout",
      stdout.trimEnd(),
      "### stderr",
      stderr.trimEnd(),
      "",
    ].join(EOL));
    if (result.error !== undefined) {
      return { ok: false, failedField: step.field, exitCode: 127, reason: "ssh could not be started" };
    }
    if (result.status !== 0) {
      return { ok: false, failedField: step.field, exitCode: result.status, reason: "the read-only probe command exited non-zero" };
    }
    return { ok: true, stdout };
  };

  for (const step of probe.steps) {
    const result = read(step);
    if (!result.ok) return { ok: false, failedField: result.failedField, exitCode: result.exitCode, reason: result.reason, raw };
    outputs[step.field] = result.stdout;
  }

  // The marker's path depends on which release is running, so it is read after the fields
  // that carry the artifact id. A listing that names no running release is a warning, not a
  // guess: the report says the marker was not read rather than inventing a path.
  if (probe.root !== undefined) {
    const release = runningReleaseId(outputs);
    if (release.id === undefined) {
      warnings.push("the release marker was not read: " + release.reason);
    } else {
      const marker = { field: "commit", command: "cat " + releaseMarkerPath(probe.root, release.id) };
      const result = read(marker);
      if (!result.ok) return { ok: false, failedField: result.failedField, exitCode: result.exitCode, reason: result.reason, raw };
      outputs.commit = result.stdout;
    }
  }
  return { ok: true, outputs, raw, warnings };
}

/** The whole report, so `--json` and the printed form cannot drift apart. */
export function inspectReport({ root = repoRoot(), config, probe, now = new Date() } = {}) {
  const privateConfig = config ?? readPrivateConfig(root);
  const source = sourceIdentity(root);
  const roles = {
    build: describeRole("build", privateConfig.roles.build),
    runtime: describeRole("runtime", privateConfig.roles.runtime),
  };
  const plan = deployPlan({ source, roles: privateConfig.roles, artifactId: source.artifactId });
  const probeResult = probe ?? { status: "skipped", detail: "not requested (pass --probe)" };
  return {
    generatedAt: now.toISOString(),
    source,
    privateConfig: {
      path: "deploy/deploy.local.env",
      exists: privateConfig.exists,
      unknownKeys: privateConfig.unknown,
    },
    roles,
    plan: { artifactId: plan.artifactId, images: plan.images, platforms: plan.platforms, affected: plan.affected },
    probe: probeResult,
  };
}

/** The git-ignored directory raw diagnostics go to; `.dev/` is ignored by this repository. */
export function diagnosticsDir(root, now = new Date()) {
  const id = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const dir = join(root, ".dev", "deploy-inspect", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Probe and turn the result into a report value.
 *
 * A probe that did not succeed is reported as a failure with its field and exit code, and the
 * raw output is written under the git-ignored `.dev/`. It is never a silent zero.
 */
export function probeFor({ config, root, now = new Date() } = {}) {
  const planned = probePlan(config, root);
  if (!planned.configured) return { status: "skipped", detail: planned.reason };
  const raw = runProbe(planned);
  if (!raw.ok) {
    const dir = diagnosticsDir(root, now);
    const path = join(dir, "probe-raw.log");
    writeFileSync(path, raw.raw.join(EOL));
    return {
      status: "failed",
      failedField: raw.failedField,
      exitCode: raw.exitCode,
      detail: raw.reason,
      diagnosticsPath: ".dev/deploy-inspect/" + dir.slice(dir.lastIndexOf("/") + 1) + "/probe-raw.log",
      command: "pnpm deploy:inspect --probe",
    };
  }
  const parsed = parseProbeOutput(raw.outputs);
  return { status: "ok", ...parsed, warnings: [...parsed.warnings, ...raw.warnings] };
}

function main(argv) {
  const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["root", "json"], switches: ["probe"] });
  if (exitCode !== undefined) return exitCode;
  const root = flags.root ?? repoRoot();
  const config = readPrivateConfig(root);
  const probe = flags.probe === "true" ? probeFor({ config, root }) : undefined;
  const report = inspectReport({ root, config, probe });
  console.log("source        " + report.source.sha + (report.source.dirty ? " (dirty tree)" : ""));
  console.log("artifact-id   " + report.source.artifactId);
  console.log("generated-at  " + report.generatedAt);
  console.log("private-config " + report.privateConfig.path + (report.privateConfig.exists ? " (present)" : " (absent)"));
  for (const role of Object.values(report.roles)) {
    console.log(
      "role          " + role.role.padEnd(8) +
      " host=" + (role.hostConfigured ? "set" : "unset") +
      " ssh=" + (role.sshAliasConfigured ? "set" : "unset") +
      " root=" + (role.rootConfigured ? "set" : "unset") +
      " arch=" + role.arch +
      (role.configured ? "" : "  (incomplete: " + role.missing.join(", ") + ")"),
    );
  }
  for (const affected of report.plan.affected) {
    console.log("affected      " + affected.role.padEnd(8) + " " + affected.service.padEnd(8) + " " + affected.image + "  (" + affected.changed + ")");
  }
  if (probe === undefined || probe.status === "skipped") {
    console.log("probe         skipped: " + (probe?.detail ?? "not requested (pass --probe)"));
  } else if (probe.status === "failed") {
    console.log("probe         FAILED field=" + probe.failedField + " exit=" + probe.exitCode + " (" + probe.detail + ")");
    console.log("              raw output kept out of this report: " + probe.diagnosticsPath + " (git-ignored)");
  } else {
    console.log("probe         ok, commit " + (probe.commit || "unknown"));
    for (const image of probe.images) console.log("  image       " + image.tag + " " + image.id + " " + image.arch);
    for (const container of probe.containers) {
      console.log("  container   " + container.name + " " + container.image + " restart=" + container.restartCount + " health=" + container.health + " started=" + container.startedAt);
    }
    for (const warning of probe.warnings ?? []) console.log("  warning     " + warning);
  }
  if (flags.json) writeJson(flags.json, report);
  return probe?.status === "failed" ? 3 : 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
