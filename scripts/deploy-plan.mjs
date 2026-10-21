/**
 * `deploy:plan` — what a deployment of this revision would do, offline.
 *
 * It prints the runbook stages with the concrete artifact identity (the commit is the
 * release name), the pinned image coordinates, the platform each image is built for, the role
 * each step runs on, the manual prerequisites a stage needs from its operator, and the
 * evidence the step must leave. It executes nothing, contacts no host, reads no secret, and
 * prints no real host name, address, login, absolute root or registry.
 *
 * A stage whose private inputs are unset is printed as incomplete rather than being given a
 * guessed command: no compose command is emitted at all, so nothing here can fall back to a
 * local `hepi-backend:local` tag or create a new named volume. There is deliberately no
 * `apply`: applying a plan is the runbook and an operator. See docs/deployment-runbook.md.
 *
 * `--root=<dir>` plans a checkout other than the one the script lives in.
 *
 * Usage: node scripts/deploy-plan.mjs [--root=<dir>] [--artifact=<id>] [--json=<path>]
 */
import { isMain, parseCli, writeJson } from "./lib/cli.mjs";
import { deployPlan, describeRole, readPrivateConfig, repoRoot, sourceIdentity } from "./lib/deploy.mjs";

const USAGE = `
Usage: node scripts/deploy-plan.mjs [--root=<dir>] [--artifact=<id>] [--json=<path>]

  --root=<dir>      plan a checkout other than the one the script lives in
  --artifact=<id>   name the artifact explicitly (default: the source commit)
  --json=<path>     write the plan as JSON at <path>
  -h, --help        print this usage and exit
`;
function main(argv) {
  const { flags, exitCode } = parseCli(argv, { usage: USAGE, values: ["root", "artifact", "json"] });
  if (exitCode !== undefined) return exitCode;
  const root = flags.root ?? repoRoot();
  const config = readPrivateConfig(root);
  const source = sourceIdentity(root);
  const artifactId = flags.artifact ?? source.artifactId;
  const roles = {
    build: describeRole("build", config.roles.build),
    runtime: describeRole("runtime", config.roles.runtime),
  };
  const plan = deployPlan({ source, roles: config.roles, artifactId });
  console.log("artifact-id   " + plan.artifactId);
  console.log("source        " + source.sha + (source.dirty ? " (dirty tree: the plan names a commit this tree is not)" : ""));
  console.log("backend-image " + plan.images.backend + "  (built for " + plan.platforms.backend + ")");
  console.log("client-release " + plan.clientRelease + "  (ingress bundle + static Web + Backend image)");
  for (const role of Object.values(roles)) {
    console.log("role          " + role.role.padEnd(8) + " host=" + (role.hostConfigured ? "set" : "unset") + " arch=" + role.arch + (role.configured ? "" : "  (incomplete)"));
  }
  for (const gate of plan.gates) {
    console.log("gate          " + gate.gate + " before " + gate.before + ": " + gate.requirement);
  }
  console.log("");
  for (const stage of plan.stages) {
    console.log(stage.stage + "  [" + stage.role + "]" + (stage.requiresConfig.length ? "  incomplete: needs " + stage.requiresConfig.join(", ") : ""));
    for (const command of stage.commands) console.log("  $ " + command);
    if (stage.commands.length === 0) console.log("  $ (no command emitted: the private inputs this stage needs are unset)");
    for (const prerequisite of stage.manualPrerequisites) console.log("  manual: " + prerequisite);
    for (const blocked of stage.blockedBy ?? []) console.log("  blocked by: " + blocked + " must have completed for this run");
    console.log("  evidence: " + stage.evidence);
  }
  console.log("");
  console.log("rollback      application: " + plan.rollback.application);
  console.log("              database:    " + plan.rollback.database);
  console.log("              schema:      " + plan.rollback.schemaCheck);
  for (const note of plan.notes) console.log("note          " + note);
  if (flags.json) writeJson(flags.json, { source, roles, plan });
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
