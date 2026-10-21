/**
 * The usage contract every check CLI shares, driven as a table.
 *
 * Each command is asked two questions, and both are about *not* running the workflow:
 *
 * - `-h`/`--help` answers with a usage line naming the flags the script really has, and
 *   starts nothing: no test suite, no probe, no plan, no report file, no run directory.
 * - an unknown flag, a value flag without a value, a value on a switch or a stray argument
 *   exits 2 and names the mistake, instead of quietly running a workflow the caller did not
 *   ask for — a misspelled flag must not be a minute of work or a host contact.
 *
 * The table is the point: seven scripts share one contract, so one case per question covers
 * all of them, and a script added later is covered by adding its row.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureDir, runCli } from "./testing/fixture.ts";

const script = (name: string): string => fileURLToPath(new URL("./" + name + ".mjs", import.meta.url));

/** Every script, with the flags its usage line must list. */
const COMMANDS = [
  { name: "check-docs", flags: ["--root", "--json"] },
  { name: "check-entrypoints", flags: ["--root", "--strict", "--json"] },
  { name: "test-web-unit", flags: ["--root", "--json", "--log-dir", "--quiet"] },
  { name: "verify", flags: ["--profile", "--root", "--json", "--log-dir", "--quiet", "--base", "--dry-run", "--test-file"] },
  { name: "compare-tests", flags: ["--base", "--root", "--suite", "--no-install", "--cleanup", "--log-dir", "--json", "--quiet"] },
  { name: "deploy-inspect", flags: ["--root", "--probe", "--json"] },
  { name: "deploy-plan", flags: ["--root", "--artifact", "--json"] },
  { name: "build-client-runtime", flags: ["--root", "--out", "--platform", "--skip-backend", "--skip-web", "--json"] },
  { name: "ingress-unit", flags: ["--release-dir", "--env-file", "--node", "--env-template", "--check"] },
];

test("--help answers with the script's own flags and runs nothing", () => {
  for (const command of COMMANDS) {
    for (const flag of ["--help", "-h"]) {
      const root = fixtureDir();
      const result = runCli(script(command.name), [flag], { cwd: root });
      assert.equal(result.status, 0, command.name + " " + flag + ": " + result.stderr);
      assert.match(result.stdout, /^Usage: node scripts\//, command.name + " " + flag + " prints a usage line");
      for (const expected of command.flags) {
        assert.ok(result.stdout.includes(expected), command.name + " names " + expected);
      }
      // Nothing ran: no run directory, no report, nothing written into the checkout.
      assert.deepEqual(readdirSync(root), [], command.name + " " + flag + " wrote into the checkout");
    }
  }
});

test("an unknown flag, a missing value, a value on a switch or a stray argument exits 2", () => {
  const cases = [
    { name: "check-docs", argv: ["--nope"] },
    { name: "check-entrypoints", argv: ["--nope"] },
    { name: "test-web-unit", argv: ["--nope"] },
    { name: "verify", argv: ["--nope"] },
    { name: "compare-tests", argv: ["--base=HEAD", "--nope"] },
    { name: "deploy-inspect", argv: ["--nope"] },
    { name: "deploy-plan", argv: ["--nope"] },
    { name: "build-client-runtime", argv: ["--nope"] },
    { name: "ingress-unit", argv: ["--nope"] },
    { name: "verify", argv: ["--profile"] },
    { name: "check-entrypoints", argv: ["--strict=yes"] },
    { name: "compare-tests", argv: ["--base=HEAD", "stray"] },
  ];
  for (const entry of cases) {
    const root = fixtureDir();
    const result = runCli(script(entry.name), entry.argv, { cwd: root });
    assert.equal(result.status, 2, entry.name + " " + entry.argv.join(" ") + ": " + result.stdout + result.stderr);
    assert.match(result.stderr, /^(unknown flag|unexpected argument|--\S+ needs a value|--\S+ takes no value)/, entry.name + " names the mistake");
    assert.match(result.stderr, /Usage: node scripts\//, entry.name + " prints the usage");
    // A usage mistake must not have started the workflow it refused to run.
    assert.deepEqual(readdirSync(root), [], entry.name + " ran the workflow anyway");
  }
});
