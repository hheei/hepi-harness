/**
 * The step definitions the check scripts share, so a command lives in one place
 * and the profiles below stay readable.
 *
 * The workspace gates go through pnpm's own recursive run — the same gate the
 * repository documents. The Web suite is a separate step because `apps/web`
 * declares no `test` script, so `pnpm -r test` never reaches it and the omission
 * would otherwise be invisible.
 *
 * Nothing here runs a paid provider, a browser driver or a deployment: a profile
 * is the fast, deterministic gate.
 */
import { join } from "node:path";
import { unitTestFiles } from "./discovery.mjs";

/** `pnpm -r typecheck` in the repository root. */
export function typecheckStep(repoRoot) {
  return { name: "workspace-typecheck", command: "pnpm", args: ["-r", "typecheck"], cwd: repoRoot };
}

/** `pnpm -r test` in the repository root. */
export function workspaceTestStep(repoRoot) {
  return { name: "workspace-tests", command: "pnpm", args: ["-r", "test"], cwd: repoRoot };
}

/** `node --test` over every Web `*.test.mjs`, enumerated explicitly and TAP-reported. */
export function webUnitStep(repoRoot, files) {
  return {
    name: "web-unit",
    command: process.execPath,
    args: ["--test", "--test-reporter=tap", "--test-timeout=60000", ...files],
    cwd: join(repoRoot, "apps", "web"),
  };
}

/** The Web unit test files relative to `repoRoot/apps/web`. */
export function webUnitFiles(repoRoot) {
  return unitTestFiles(join(repoRoot, "apps", "web"));
}

/**
 * Named verification profiles. `fast` is the default gate: the split is
 * `fast` ⊂ `full`, so `full` adds the Web suite without changing what `fast` means.
 */
export const PROFILES = ["fast", "full", "changed"];

/** The steps one profile runs, in order. */
export function profileSteps(profile, repoRoot) {
  if (!["fast", "full"].includes(profile)) throw new Error("Unknown static profile \"" + profile + "\". Known: fast, full");
  const steps = [typecheckStep(repoRoot), workspaceTestStep(repoRoot)];
  if (profile === "full") steps.push(webUnitStep(repoRoot, webUnitFiles(repoRoot)));
  return steps;
}
