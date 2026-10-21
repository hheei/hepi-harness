import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { devPlan, selectSteps, DEV_DEFAULTS, REPO_ROOT } from "./dev.mjs";

/**
 * One process the development plan starts, as this suite depends on it: the environment it is
 * handed (a variable that is not stated is absent, so a read is `| undefined`), the package and
 * script it runs, and the address it serves. The shape is stated here because `dev.mjs` is
 * operational JavaScript: these tests are the contract, so the contract is what they name.
 */
type DevStep = {
  readonly name: string;
  readonly package: string;
  readonly script: string;
  readonly env: Record<string, string | undefined>;
  readonly url: string;
};

const planOf = (options: { readonly repoRoot: string; readonly env: Record<string, string> }): DevStep[] => devPlan(options) as DevStep[];

/** The step `name` names, or a failure that says the plan lost it. */
function stepOf(plan: readonly DevStep[], name: string): DevStep {
  const step = plan.find((candidate) => candidate.name === name);
  assert.ok(step !== undefined, "the plan names a " + name + " step");
  return step;
}

/** The environment one step is handed. */
const envOf = (plan: readonly DevStep[], name: string): Record<string, string | undefined> => stepOf(plan, name).env;

/** The value a step's environment must state, or a failure naming both the variable and the step. */
function envValue(plan: readonly DevStep[], step: string, variable: string): string {
  const value = envOf(plan, step)[variable];
  assert.ok(value !== undefined, step + " states " + variable);
  return value;
}

test("the plan starts gateway, server then web", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  assert.deepEqual(plan.map((step) => step.name), ["gateway", "server", "web"]);
  assert.deepEqual(plan.map((step) => step.package), ["@hepi/gateway", "@hepi/server", "@hepi/web"]);
  for (const step of plan) assert.equal(step.script, "dev");
});

test("the gateway is reachable at the address the backend is told to use", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  // A mismatch here is the classic "backend bound no workspace" bug: the two
  // must agree without the operator repeating the port.
  assert.equal(envValue(plan, "server", "HEPI_GATEWAY_URL"), stepOf(plan, "gateway").url);
  assert.equal(envValue(plan, "server", "HEPI_GATEWAY_URL"), "http://127.0.0.1:" + DEV_DEFAULTS.HEPI_GATEWAY_PORT);
});

test("the web UI is told to reach the backend the plan started", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  assert.equal(envValue(plan, "web", "HEPI_SERVER_URL"), stepOf(plan, "server").url);
});

test("the backend and gateway share one gateway id and workspace id", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  // The backend resolves a workspace id to a configured gateway; the gateway
  // seeds the same id. Different spellings would make the binding unresolvable.
  assert.equal(envValue(plan, "server", "HEPI_WORKSPACE_ID"), envValue(plan, "gateway", "HEPI_WORKSPACE_ID"));
  assert.equal(envValue(plan, "server", "HEPI_GATEWAY_ID"), envValue(plan, "gateway", "HEPI_GATEWAY_ID"));
});

test("development state is kept out of the repository's data directories", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  for (const [step, variable] of [["server", "HEPI_DB"], ["server", "HEPI_PROJECTS"], ["server", "HEPI_SKILL_REPOSITORY"], ["gateway", "HEPI_GATEWAY_DB"]] as const) {
    assert.ok(envValue(plan, step, variable).startsWith("/repo/.dev/"), variable + " should live under the dev state directory");
  }
});

test("a caller's environment overrides a development default", () => {
  const plan = planOf({ repoRoot: "/repo", env: { PORT: "9999", HEPI_AUTH_TOKEN: "mine" } });
  assert.equal(envValue(plan, "server", "PORT"), "9999");
  assert.equal(envValue(plan, "server", "HEPI_AUTH_TOKEN"), "mine");
  // The derived URL follows the override, so the pair stays consistent.
  assert.equal(stepOf(plan, "server").url, "http://127.0.0.1:9999");
  assert.equal(envValue(plan, "web", "HEPI_SERVER_URL"), "http://127.0.0.1:9999");
});

test("the workspace root is configurable and defaults to the repository", () => {
  assert.equal(envValue(planOf({ repoRoot: "/repo", env: {} }), "gateway", "HEPI_WORKSPACE_ROOT"), "/repo");
  assert.equal(envValue(planOf({ repoRoot: "/repo", env: { HEPI_DEV_WORKSPACE: "/tmp/work" } }), "gateway", "HEPI_WORKSPACE_ROOT"), "/tmp/work");
});

test("--only selects a subset and rejects an unknown name", () => {
  const plan = planOf({ repoRoot: "/repo", env: {} });
  assert.deepEqual(selectSteps(plan, "server").map((step: DevStep) => step.name), ["server"]);
  assert.deepEqual(selectSteps(plan, "web,gateway").map((step: DevStep) => step.name), ["gateway", "web"]);
  assert.deepEqual(selectSteps(plan, undefined).map((step: DevStep) => step.name), ["gateway", "server", "web"]);
  assert.throws(() => selectSteps(plan, "bogus"), /Unknown --only target "bogus"/);
});

test("the module resolves the repository root it lives in", () => {
  // The root is the parent of the scripts directory, whatever the checkout is named:
  // a worktree has its own directory name, and the suite must run in one.
  assert.equal(REPO_ROOT, dirname(dirname(fileURLToPath(import.meta.url))));
  assert.equal((JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name, "hepi-harness");
});
