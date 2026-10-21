/**
 * Development orchestrator: one command starts the gateway, the backend and the
 * Web UI, each with hot restart, so a source edit is felt immediately.
 *
 * The backend and the gateway run under `node --watch`, which restarts on a
 * change to any module in their import graph — including the workspace packages
 * they import (`@hepi/gateway`, `@hepi/protocol`, `@hepi/session`), because
 * those are resolved to their `src` entrypoints. The Web UI runs `next dev`,
 * which already hot-reloads. A SQLite write does not restart anything: `--watch`
 * follows the module graph, not the directory.
 *
 * This script owns only orchestration and development defaults. It changes no
 * production path: `pnpm --filter @hepi/server start` still builds the
 * diagnostic bundle and runs without a watcher.
 *
 * Usage: pnpm dev [--only=gateway,server,web] [--workspace=<dir>]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Development defaults. Every value is overridable from the caller's environment. */
export const DEV_DEFAULTS = {
  HEPI_AUTH_TOKEN: "local-server-token",
  HEPI_GATEWAY_TOKEN: "local-gateway-token",
  HEPI_GATEWAY_ID: "workstation",
  HEPI_WORKSPACE_ID: "local",
  HEPI_ALLOWED_COMMANDS: "bash",
  HEPI_BIND_HOST: "127.0.0.1",
  HEPI_GATEWAY_PORT: "8788",
  PORT: "8787",
};

/**
 * The three processes, in start order. Each entry names the workspace package,
 * the command to run inside it, and which environment it receives.
 *
 * The gateway starts first because the backend resolves its workspace binding at
 * boot; the backend reaching a gateway that is not up yet would only log a
 * failed bind. The Web UI needs neither, but starting it last keeps its startup
 * output readable.
 */
export function devPlan({ repoRoot, env = process.env }) {
  const configured = { ...DEV_DEFAULTS, ...env };
  // Development state lives under .dev/ so a watcher restart never contends with
  // a real deployment's database, and the SQLite files stay out of the repo.
  const stateDir = resolve(repoRoot, ".dev");
  const workspaceRoot = resolve(env.HEPI_DEV_WORKSPACE ?? repoRoot);
  const gatewayUrl = "http://127.0.0.1:" + configured.HEPI_GATEWAY_PORT;
  const serverUrl = "http://127.0.0.1:" + configured.PORT;

  const gatewayEnv = {
    ...configured,
    HEPI_WORKSPACE_ROOT: workspaceRoot,
    HEPI_GATEWAY_DB: resolve(stateDir, "gateway-calls.sqlite"),
  };
  const serverEnv = {
    ...configured,
    HEPI_GATEWAY_URL: gatewayUrl,
    HEPI_DB: resolve(stateDir, "hepi.sqlite"),
    HEPI_SKILL_REPOSITORY: resolve(stateDir, "skill-repository.sqlite"),
    HEPI_PROJECTS: resolve(stateDir, "projects.sqlite"),
  };
  const webEnv = {
    ...configured,
    HEPI_SERVER_URL: serverUrl,
  };

  return [
    { name: "gateway", package: "@hepi/gateway", script: "dev", env: gatewayEnv, url: gatewayUrl },
    { name: "server", package: "@hepi/server", script: "dev", env: serverEnv, url: serverUrl },
    { name: "web", package: "@hepi/web", script: "dev", env: webEnv, url: "http://127.0.0.1:30141" },
  ];
}

/** Select the steps named by `--only`, preserving the plan's start order. */
export function selectSteps(steps, only) {
  if (!only) return steps;
  const wanted = new Set(only.split(",").map((name) => name.trim()).filter(Boolean));
  const known = new Set(steps.map((step) => step.name));
  for (const name of wanted) {
    if (!known.has(name)) throw new Error(`Unknown --only target "${name}". Known: ${[...known].join(", ")}`);
  }
  return steps.filter((step) => wanted.has(step.name));
}

const COLORS = { gateway: "\u001b[36m", server: "\u001b[35m", web: "\u001b[32m" };
const RESET = "\u001b[0m";
const DIM = "\u001b[2m";

function prefixStream(name, stream, sink) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    const color = COLORS[name] ?? "";
    for (const line of lines) sink.write(`${color}${name.padEnd(7)}${RESET} ${DIM}|${RESET} ${line}\n`);
  });
  stream.on("end", () => {
    if (buffered !== "") sink.write(`${COLORS[name] ?? ""}${name.padEnd(7)}${RESET} ${DIM}|${RESET} ${buffered}\n`);
  });
}

function main(argv = process.argv.slice(2), env = process.env) {
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  const workspaceArg = argv.find((arg) => arg.startsWith("--workspace="));
  const effectiveEnv = { ...env };
  if (workspaceArg) effectiveEnv.HEPI_DEV_WORKSPACE = workspaceArg.slice("--workspace=".length);

  const steps = selectSteps(
    devPlan({ repoRoot: REPO_ROOT, env: effectiveEnv }),
    onlyArg?.slice("--only=".length),
  );

  const stateDir = resolve(REPO_ROOT, ".dev");
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  console.log(`${DIM}hepi dev — hot restart for backend and gateway, HMR for the Web UI${RESET}`);
  console.log(`${DIM}workspace root: ${effectiveEnv.HEPI_DEV_WORKSPACE ?? REPO_ROOT}${RESET}`);
  console.log(`${DIM}dev state:      ${stateDir}${RESET}`);
  for (const step of steps) console.log(`${DIM}  ${step.name.padEnd(7)} ${step.url}${RESET}`);
  console.log(`${DIM}ctrl-c stops every process${RESET}\n`);

  const children = [];
  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
    // Give each watcher a moment to run its own SIGTERM handler and close its
    // server before the orchestrator exits.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));

  for (const step of steps) {
    const child = spawn("pnpm", ["--filter", step.package, step.script], {
      cwd: REPO_ROOT,
      env: { ...env, ...step.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      console.error(`\n${COLORS[step.name] ?? ""}${step.name}${RESET} failed to start: ${error.message}`);
      console.error(`${DIM}is pnpm on PATH? this script starts each workspace package through it${RESET}`);
      shutdown("SIGTERM");
    });
    // A watcher exits only when it cannot continue; the others stay up so a
    // single broken process does not tear down the whole dev session.
    child.on("exit", (code, signal) => {
      if (!shuttingDown && code !== 0 && signal === null) {
        console.error(`\n${COLORS[step.name] ?? ""}${step.name}${RESET} exited with code ${code}; other processes keep running`);
      }
    });
    prefixStream(step.name, child.stdout, process.stdout);
    prefixStream(step.name, child.stderr, process.stderr);
    children.push(child);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
