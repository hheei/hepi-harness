import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { unitTestFiles } from "./discovery.mjs";
import { profileSteps, webUnitFiles, webUnitStep } from "./presets.mjs";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot select changed checks: git " + args.join(" ") + " failed");
  return result.stdout;
}

function workspaces(root) {
  const packages = [];
  for (const parent of ["apps", "packages"]) {
    if (!existsSync(join(root, parent))) continue;
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      const dir = parent + "/" + entry.name;
      if (!entry.isDirectory() || !existsSync(join(root, dir, "package.json"))) continue;
      const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
      packages.push({ dir, name: manifest.name, scripts: manifest.scripts ?? {}, dependencies: {
        ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies,
      } });
    }
  }
  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

function scriptTests(root) {
  return { name: "script-tests", command: process.execPath,
    args: ["--test", "--test-reporter=tap", "--test-timeout=120000", ...unitTestFiles(join(root, "scripts"))],
    cwd: join(root, "scripts") };
}

function repositoryCheck(root, name) {
  return { name, command: process.execPath, args: [join(root, "scripts", name + ".mjs"), "--root=" + root], cwd: root };
}

const TEST_FILE = /\.test\.ts$/;

/** A path written the way the package's own suite writes it: relative, `./`-prefixed, forward slashes. */
function packageRelative(dir, file) {
  return "./" + relative(dir, file).split(sep).join("/");
}

/**
 * The package a test file belongs to, the way the package's own suite would find it, or the
 * \`scripts\` pseudo-group: tooling tests live outside every workspace package and run from the
 * scripts directory, so a named one has to resolve to that same cwd and timeout.
 */
function testFileEntry(root, packages, path) {
  const absolute = resolve(root, path);
  if (!TEST_FILE.test(absolute)) return { error: path + " is not a test file" };
  const scriptsDir = join(root, "scripts");
  if (absolute.startsWith(scriptsDir + sep)) {
    if (!existsSync(absolute)) return { error: path + " does not exist" };
    return { dir: "scripts", file: "./" + relative(scriptsDir, absolute).split(sep).join("/") };
  }
  const pkg = packages.find((candidate) => absolute.startsWith(join(root, candidate.dir) + sep));
  if (pkg === undefined) return { error: path + " is not inside a workspace package" };
  if (!existsSync(absolute)) return { error: path + " does not exist" };
  return { package: pkg, dir: pkg.dir, file: packageRelative(pkg.dir, relative(root, absolute)) };
}

/** The timeout each directory's own suite runs with: tooling 120 s, Web 60 s. */
const FOCUSED_TIMEOUTS = { scripts: "120000", "apps/web": "60000" };

/** One \`node --test\` step over exactly these files, in the directory's own cwd. */
function focusedTestStep(root, dir, files) {
  const timeout = FOCUSED_TIMEOUTS[dir];
  return {
    name: "changed-test-" + dir.replace(/[^\w.]+/g, "-"),
    command: process.execPath,
    args: ["--test", "--test-reporter=tap", ...(timeout === undefined ? [] : ["--test-timeout=" + timeout]), ...files],
    cwd: join(root, dir),
  };
}

/** Group focused test files by their directory: one step per package or the scripts group. */
function focusedTestSteps(root, entries) {
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.dir)) grouped.set(entry.dir, []);
    grouped.get(entry.dir).push(entry.file);
  }
  return [...grouped].map(([dir, files]) => focusedTestStep(root, dir, files));
}

/**
 * Select checks from committed, staged, unstaged and untracked paths, without changing Git state.
 *
 * Typecheck keeps its package granularity: a changed file in one package still typechecks that
 * package and every transitive dependent, because types cross the boundary. Tests do not have to:
 * when every changed executable file is a test file, or the caller names the files with
 * `testFiles`, only those files run — a test edit cannot change another package's behaviour, so
 * its full suite would add time without adding evidence. Anything the selector cannot place
 * (`fallbackFiles`) keeps the conservative full profile and refuses a narrowing request.
 */
export function changedChecks(root, base, { testFiles = [] } = {}) {
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const reference = base === undefined ? head : git(root, ["merge-base", head, base]).trim();
  const files = [...new Set([
    ...git(root, ["diff", "--no-renames", "--name-only", "-z", reference, "--"]).split("\0"),
    ...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean))].sort();
  const packages = workspaces(root);
  const affected = new Set();
  const changedTestFiles = [];
  const deletedTestFiles = [];
  const fallbackFiles = [];
  const ignoredFiles = [];
  let sourceChange = false;
  let docs = false;
  let scripts = false;
  for (const file of files) {
    if (/^(?:graphify-out|\.scratch|\.agents|\.dev)\//.test(file) || file === ".agents/skills" || file === ".pi/skills" || file.startsWith(".pi/skills/")) {
      ignoredFiles.push(file);
    } else if (file.startsWith("scripts/")) {
      scripts = true;
    } else if (file.endsWith(".md")) {
      docs = true;
    } else {
      const owner = packages.find((pkg) => file.startsWith(pkg.dir + "/"));
      if (owner === undefined) {
        fallbackFiles.push(file);
      } else if (TEST_FILE.test(file)) {
        affected.add(owner.name);
        if (existsSync(join(root, file))) changedTestFiles.push({ package: owner, dir: owner.dir, file: packageRelative(owner.dir, file) });
        else deletedTestFiles.push(file);
      } else {
        affected.add(owner.name);
        sourceChange = true;
      }
    }
  }
  if (fallbackFiles.length > 0 && testFiles.length > 0) {
    throw new Error("Cannot select changed checks: --test-file cannot narrow the full fallback for " + fallbackFiles.join(", "));
  }
  const requested = [];
  const errors = [];
  for (const path of testFiles) {
    const entry = testFileEntry(root, packages, path);
    if (entry.error !== undefined) errors.push(entry.error);
    else requested.push(entry);
  }
  if (errors.length > 0) throw new Error("Cannot select changed checks: " + errors.join("; "));
  const requestedScripts = requested.some((entry) => entry.package === undefined);
  for (const entry of requested) if (entry.package !== undefined) affected.add(entry.package.name);
  for (let expanded = true; expanded;) {
    expanded = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && Object.keys(pkg.dependencies).some((name) => affected.has(name))) {
        affected.add(pkg.name);
        expanded = true;
      }
    }
  }
  const narrowable = !sourceChange && deletedTestFiles.length === 0;
  const focused = requested.length > 0
    ? requested
    : narrowable && changedTestFiles.length > 0 ? changedTestFiles : [];
  const testSelection = focused.length > 0
    ? {
      mode: requested.length > 0 ? "explicit" : "changed-tests",
      reason: requested.length > 0
        ? "explicit --test-file selection"
        : "every changed file in a workspace package is a test file",
      files: focused.map((entry) => entry.dir + "/" + entry.file.slice(2)).sort(),
    }
    : {
      mode: "full",
      reason: fallbackFiles.length > 0
        ? "unrecognized changed files: " + fallbackFiles.join(", ")
        : deletedTestFiles.length > 0
          ? "deleted test files: " + deletedTestFiles.join(", ")
          : sourceChange
            ? "changed source in " + [...affected].sort().join(", ")
            : "no workspace test change to narrow",
      files: [],
    };
  let steps = [];
  if (fallbackFiles.length > 0) {
    steps = profileSteps("full", root);
    scripts = true;
    docs = true;
  } else {
    const typecheckTargets = packages.filter((pkg) => affected.has(pkg.name) && pkg.scripts.typecheck);
    if (typecheckTargets.length > 0) {
      steps.push({
        name: "changed-typecheck", command: "pnpm",
        args: [...typecheckTargets.flatMap((pkg) => ["--filter", pkg.name]), "-r", "typecheck"], cwd: root,
      });
    }
    if (focused.length > 0) {
      // A narrowed run names its own files, so it does not depend on a package declaring a
      // `test` script: `apps/web` declares none (its suite runs through `webUnitFiles`), and a
      // selection that keyed on that script would schedule no test at all for a Web test file.
      steps.push(...focusedTestSteps(root, focused));
    } else {
      const testTargets = packages.filter((pkg) => affected.has(pkg.name) && pkg.scripts.test);
      if (testTargets.length > 0) {
        steps.push({
          name: "changed-test", command: "pnpm",
          args: [...testTargets.flatMap((pkg) => ["--filter", pkg.name]), "-r", "test"], cwd: root,
        });
      }
      // A narrowed run already replaced the dependent suites, and the Web suite is one of them:
      // running it would put back the full suite the selection just removed.
      if (packages.some((pkg) => pkg.dir === "apps/web" && affected.has(pkg.name))) {
        steps.push(webUnitStep(root, webUnitFiles(root)));
      }
    }
  }
  // An explicit scripts test file replaces the whole tooling suite, the way a named workspace
  // test replaces its package suite; the entrypoint and docs checks it implies still run.
  if (scripts || requestedScripts) {
    if (!steps.some((step) => step.name === "workspace-typecheck")) {
      steps.push({ name: "script-typecheck", command: "pnpm", args: ["typecheck:scripts"], cwd: root });
    }
    if (!requestedScripts) steps.push(scriptTests(root));
    steps.push(repositoryCheck(root, "check-entrypoints"));
    docs = true;
  }
  if (docs) steps.push(repositoryCheck(root, "check-docs"));
  return { base: reference, files, ignoredFiles, packages: [...affected].sort(), fallbackFiles, testSelection, steps };
}
