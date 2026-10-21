/**
 * Shared CLI machinery for the repository's check scripts: what a step is, how it
 * is run, and what is preserved about it.
 *
 * A check result is only evidence if it carries the revision it ran against, the
 * command that produced it, the exit code, and the raw log. Every helper here
 * exists so a script cannot accidentally report a number without those, the way
 * `docs/agents/verification.md` requires.
 *
 * Nothing here stashes, resets or writes to a working tree: a check may only read
 * repository state. Baselines are read from a separate detached worktree instead.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** True when the module is the process entry point, so `main` runs only as a CLI. */
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  return argv1 !== undefined && moduleUrl === pathToFileURL(resolve(argv1)).href;
}

/** Run `git` in `cwd`; returns stdout, or "" when git fails (e.g. outside a repository). */
export function gitOutput(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

/**
 * The revision a run is happening on, and whether the working tree is clean.
 *
 * The SHA alone is not enough: an uncommitted edit means the run measured
 * something the SHA does not name, so `dirtyFiles` is reported beside it rather
 * than hidden.
 */
export function gitState(cwd) {
  const sha = gitOutput(cwd, ["rev-parse", "HEAD"]).trim();
  const porcelain = gitOutput(cwd, ["status", "--porcelain"]);
  const dirtyFiles = porcelain
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  return { sha, dirty: dirtyFiles.length > 0, dirtyFiles };
}

/** The exact command line an operator can paste to re-run one step. */
function commandLine(step) {
  return [step.command, ...step.args].join(" ");
}

/**
 * The environment a step receives.
 *
 * `node --test` sets `NODE_TEST_CONTEXT` in its children, and a child that sees it
 * refuses to start another test run ("skipping running files"), so a check script
 * that itself runs under a test runner would silently measure nothing. The marker is
 * therefore cleared: a step runs its own suite regardless of who started the script.
 */
function stepEnvironment(env, extra) {
  const merged = { ...env, ...(extra ?? {}) };
  delete merged.NODE_TEST_CONTEXT;
  delete merged.NODE_TEST_WORKER_ID;
  return merged;
}

/**
 * Run one step, preserving everything a result needs: the command, the SHA and
 * dirty state at its start, its exit code, its duration, and the raw combined
 * output written to `logPath`.
 *
 * `exitCode` is 127 when the command could not be spawned at all, so a missing
 * binary reads as a failure rather than as a silent pass.
 */
export function runStep(step, { logDir, env = process.env, echo = true } = {}) {
  const cwd = step.cwd ?? process.cwd();
  const state = gitState(cwd);
  const started = new Date();
  const result = spawnSync(step.command, step.args, {
    cwd,
    env: stepEnvironment(env, step.env),
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const finished = new Date();
  const spawnFailure = result.error === undefined ? null : String(result.error.message ?? result.error);
  const exitCode = spawnFailure === null ? result.status : 127;

  if (echo) {
    process.stdout.write(step.command + " " + step.args.join(" ") + "\n");
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  const logPath = join(logDir, step.name.replace(/[^\w.-]+/g, "_") + ".log");
  const lines = [
    "# step: " + step.name,
    "# command: " + commandLine(step),
    "# cwd: " + cwd,
    "# sha: " + state.sha,
    "# dirty: " + state.dirty + (state.dirtyFiles.length === 0 ? "" : " (" + state.dirtyFiles.join(", ") + ")"),
    "# started: " + started.toISOString(),
    "",
    "## stdout",
    result.stdout ?? "",
    "## stderr",
    result.stderr ?? "",
    "",
    "## result",
    "# finished: " + finished.toISOString(),
    "# durationMs: " + (finished.getTime() - started.getTime()),
    "# exit code: " + exitCode,
    "# signal: " + (result.signal ?? "none"),
    ...(spawnFailure === null ? [] : ["# spawn failure: " + spawnFailure]),
    "",
  ];
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, lines.join("\n"));

  return {
    name: step.name,
    command: commandLine(step),
    cwd,
    sha: state.sha,
    dirty: state.dirty,
    dirtyFiles: state.dirtyFiles,
    exitCode,
    signal: result.signal ?? null,
    durationMs: finished.getTime() - started.getTime(),
    logPath,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Write `value` as JSON at `path`, creating its directory. Returns the path. */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  return path;
}

/**
 * `--flag=value` and `--flag value` both land in `flags`; anything else is `rest`.
 *
 * `repeated` keeps every occurrence of a flag in order, which is what a flag given once per
 * item (`--test-file a --test-file b`) needs; `flags` keeps the last one, as before.
 */
function parseArgv(argv) {
  const flags = {};
  const repeated = {};
  const rest = [];
  const record = (key, value) => {
    flags[key] = value;
    (repeated[key] ??= []).push(value);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      record(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      record(arg.slice(2), argv[i + 1]);
      i += 1;
    } else {
      record(arg.slice(2), "true");
    }
  }
  return { flags, repeated, rest };
}

/**
 * Parse one script's command line from a small declaration, and answer the caller when the
 * line is one this script cannot run.
 *
 * Deliberately not a CLI framework: `parseArgv` already handles the `--flag=value` and
 * `--flag value` forms every script accepts, and this adds only the two things a caller needs
 * from any command — a usage line that lists the flags the script really has, and a refusal to
 * run with an argument the script does not understand.
 *
 * `-h`/`--help` prints the usage and returns 0 *before* anything runs, so asking what a
 * command does cannot start a check, a probe or a plan. An unknown flag, a value flag without a
 * value, a value given to a switch, or a stray positional argument prints the usage on stderr
 * and returns 2: a typo must not silently run a workflow that takes a minute or a host.
 *
 * A flag named in `multi` is a value flag that may be given once per item; it arrives as an
 * array in `flags`, empty when it was not given at all.
 *
 * Returns `{flags}` on success, or `{exitCode}` when it has already answered the caller.
 */
export function parseCli(argv, { usage, values = [], switches = [], multi = [] }) {
  const print = (stream) => stream.write(usage.trim() + "\n");
  const fail = (message) => {
    process.stderr.write(message + "\n");
    print(process.stderr);
    return { exitCode: 2 };
  };

  if (argv.includes("--help") || argv.includes("-h")) {
    print(process.stdout);
    return { exitCode: 0 };
  }

  const { flags, repeated, rest } = parseArgv(argv);
  if (rest.length > 0) return fail("unexpected argument: " + rest.join(" "));
  const known = new Set([...values, ...switches, ...multi]);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) return fail("unknown flag: --" + key);
  }
  for (const key of multi) {
    const items = repeated[key] ?? [];
    if (items.some((item) => item === "" || item === "true")) return fail("--" + key + " needs a value");
    flags[key] = items;
  }
  for (const key of values) {
    if (flags[key] === undefined) continue;
    if (flags[key] === "" || flags[key] === "true") return fail("--" + key + " needs a value");
  }
  for (const key of switches) {
    if (flags[key] !== undefined && flags[key] !== "true") return fail("--" + key + " takes no value");
  }
  return { flags };
}

/** The command as one summary line: the full text is in the log, this stays readable. */
function shortenedCommand(command, limit = 96) {
  return command.length <= limit ? command : command.slice(0, limit - 4) + "...";
}

/** Print a one-line-per-step summary and return the number of failed steps. */
export function printSummary(title, records, logDir) {
  console.log("");
  console.log(title);
  let failed = 0;
  for (const record of records) {
    const ok = record.exitCode === 0;
    if (!ok) failed += 1;
    console.log("  " + (ok ? "PASS" : "FAIL") + "  " + record.name.padEnd(24) + " exit=" + record.exitCode + "  " + shortenedCommand(record.command));
  }
  console.log("  sha " + (records[0]?.sha ?? "unknown") + (records.some((r) => r.dirty) ? " (dirty tree)" : "") + "; logs in " + logDir);
  return failed;
}

/** A timestamped artifact directory under `.dev/` (git-ignored), one per run. */
export function runDir(repoRoot, label, stamp = new Date()) {
  const id = stamp.toISOString().replace(/[:.]/g, "-").replace("Z", "") + "-" + label;
  const dir = join(repoRoot, ".dev", "verify", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
