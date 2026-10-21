import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { devPlan, selectSteps, DEV_DEFAULTS, REPO_ROOT } from "./dev.mjs";

test("the plan starts gateway, server then web", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  assert.deepEqual(plan.map((step) => step.name), ["gateway", "server", "web"]);
  assert.deepEqual(plan.map((step) => step.package), ["@hepi/gateway", "@hepi/server", "@hepi/web"]);
  for (const step of plan) assert.equal(step.script, "dev");
});

test("the gateway is reachable at the address the backend is told to use", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  const gateway = plan.find((step) => step.name === "gateway");
  const server = plan.find((step) => step.name === "server");
  // A mismatch here is the classic "backend bound no workspace" bug: the two
  // must agree without the operator repeating the port.
  assert.equal(server.env.HEPI_GATEWAY_URL, gateway.url);
  assert.equal(server.env.HEPI_GATEWAY_URL, "http://127.0.0.1:" + DEV_DEFAULTS.HEPI_GATEWAY_PORT);
});

test("the web UI is told to reach the backend the plan started", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  const server = plan.find((step) => step.name === "server");
  const web = plan.find((step) => step.name === "web");
  assert.equal(web.env.HEPI_SERVER_URL, server.url);
});

test("the backend and gateway share one gateway id and workspace id", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  const gateway = plan.find((step) => step.name === "gateway");
  const server = plan.find((step) => step.name === "server");
  // The backend resolves a workspace id to a configured gateway; the gateway
  // seeds the same id. Different spellings would make the binding unresolvable.
  assert.equal(server.env.HEPI_WORKSPACE_ID, gateway.env.HEPI_WORKSPACE_ID);
  assert.equal(server.env.HEPI_GATEWAY_ID, gateway.env.HEPI_GATEWAY_ID);
});

test("development state is kept out of the repository's data directories", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  const server = plan.find((step) => step.name === "server");
  const gateway = plan.find((step) => step.name === "gateway");
  for (const value of [server.env.HEPI_DB, server.env.HEPI_PROJECTS, server.env.HEPI_SKILL_REPOSITORY, gateway.env.HEPI_GATEWAY_DB]) {
    assert.ok(value.startsWith("/repo/.dev/"), `${value} should live under the dev state directory`);
  }
});

test("a caller's environment overrides a development default", () => {
  const plan = devPlan({ repoRoot: "/repo", env: { PORT: "9999", HEPI_AUTH_TOKEN: "mine" } });
  const server = plan.find((step) => step.name === "server");
  const web = plan.find((step) => step.name === "web");
  assert.equal(server.env.PORT, "9999");
  assert.equal(server.env.HEPI_AUTH_TOKEN, "mine");
  // The derived URL follows the override, so the pair stays consistent.
  assert.equal(server.url, "http://127.0.0.1:9999");
  assert.equal(web.env.HEPI_SERVER_URL, "http://127.0.0.1:9999");
});

test("the workspace root is configurable and defaults to the repository", () => {
  assert.equal(devPlan({ repoRoot: "/repo", env: {} }).find((s) => s.name === "gateway").env.HEPI_WORKSPACE_ROOT, "/repo");
  assert.equal(
    devPlan({ repoRoot: "/repo", env: { HEPI_DEV_WORKSPACE: "/tmp/work" } }).find((s) => s.name === "gateway").env.HEPI_WORKSPACE_ROOT,
    "/tmp/work",
  );
});

test("--only selects a subset and rejects an unknown name", () => {
  const plan = devPlan({ repoRoot: "/repo", env: {} });
  assert.deepEqual(selectSteps(plan, "server").map((s) => s.name), ["server"]);
  assert.deepEqual(selectSteps(plan, "web,gateway").map((s) => s.name), ["gateway", "web"]);
  assert.deepEqual(selectSteps(plan, undefined).map((s) => s.name), ["gateway", "server", "web"]);
  assert.throws(() => selectSteps(plan, "bogus"), /Unknown --only target "bogus"/);
});

test("the module resolves the repository root it lives in", () => {
  // The root is the parent of the scripts directory, whatever the checkout is named:
  // a worktree has its own directory name, and the suite must run in one.
  assert.equal(REPO_ROOT, dirname(dirname(fileURLToPath(import.meta.url))));
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name, "hepi-harness");
});
