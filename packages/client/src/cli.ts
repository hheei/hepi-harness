#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, resolveSettings, type CliFlags } from "./config.ts";
import { formatDoctor, runDoctor, systemProbe, type DoctorProbe } from "./doctor.ts";
import { startGateway, type RunningGateway } from "../../gateway/src/startup.ts";
import type { WorkspaceRegistry, WorktreeServer } from "../../gateway/src/index.ts";
import { VERSION } from "./version.ts";

export const USAGE = [
  "hepi-client " + VERSION + " — local or SSH execution gateway for the Hepi harness",
  "",
  "Usage:",
  "  hepi-client gateway [options]   start the gateway on 127.0.0.1",
  "  hepi-client doctor  [options]   check configuration and reachability, without printing secrets",
  "  hepi-client --help | --version",
  "",
  "Options (a flag beats the environment, which beats the config file):",
  "  --config <file>              JSON file keyed by the environment variable names below",
  "  --token-file <file>          read the gateway token from this file instead of the environment",
  "  --root <dir>                 workspace root on the execution host (HEPI_WORKSPACE_ROOT)",
  "  --workspace-id <id>          workspace ID the backend addresses (HEPI_WORKSPACE_ID)",
  "  --gateway-id <id>            gateway ID the backend expects (HEPI_GATEWAY_ID, default workstation)",
  "  --port <n>                   listen port on 127.0.0.1 (HEPI_GATEWAY_PORT, default 8788)",
  "  --allowed-commands <list>    comma-separated command names that may run (HEPI_ALLOWED_COMMANDS)",
  "  --data-dir <dir>             directory for the call journal (HEPI_GATEWAY_DATA)",
  "  --host <user@host>           SSH execution host; without it the gateway runs locally",
  "  --profile <id>               SSH profile name (HEPI_SSH_PROFILE, default loopback)",
  "  --ssh-port <n>               SSH port (HEPI_SSH_PORT)",
  "  --identity <file>            SSH identity file (HEPI_SSH_IDENTITY)",
  "  --known-hosts <file>         SSH known-hosts file (HEPI_SSH_KNOWN_HOSTS)",
  "  --terminal-heartbeat-ms <n>  terminal keepalive cadence in ms, 0 for none (HEPI_TERMINAL_HEARTBEAT_MS)",
  "  --json                       machine-readable output for doctor",
  "",
  "The token is never printed. An SSH gateway addresses the workspace as remote-<profile>.",
].join("\n");

export type RunOptions = {
  readonly env: Record<string, string | undefined>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly onStarted?: (running: RunningGateway) => void;
  /** The reachability probes doctor uses. Tests decide the verdict; the default reaches the real host. */
  readonly probe?: DoctorProbe;
  /**
   * The worktree surface to compose instead of the one that runs git on this machine, given the registry the gateway
   * serves. Absent reads the local surface; a caller that supplies one states which host its worktree operations reach.
   */
  readonly worktrees?: (workspaces: WorkspaceRegistry) => WorktreeServer;
};

/** Read the config file when one is named. A missing or malformed file is a problem, never silently ignored. */
async function readConfigFile(path: string): Promise<{ file?: Record<string, unknown>; problems: string[] }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // A filesystem error names the file, which is useful and holds no content from it.
    return { problems: ["cannot read config file " + path + ": " + (error as Error).message] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Node can quote the offending source in a parse error, and that source is a config file that may hold the token.
    // The message stays generic so no content from the file can reach stdout or stderr.
    if (error instanceof SyntaxError) return { problems: ["invalid JSON in config file " + path] };
    return { problems: ["cannot read config file " + path + ": " + (error as Error).message] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { problems: ["config file must hold a JSON object: " + path] };
  return { file: parsed as Record<string, unknown>, problems: [] };
}

/**
 * Run one command. Returns the process exit code: 0 success, 1 a failed check or runtime failure, 2 a usage error.
 * The gateway command does not return until the process is asked to stop.
 */
export async function run(argv: readonly string[], options: RunOptions): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === "help") { options.out(USAGE + "\n"); return 0; }
  if (parsed.command === "version") { options.out(VERSION + "\n"); return 0; }
  if (parsed.command === undefined) {
    for (const problem of parsed.problems) options.err("hepi-client: " + problem + "\n");
    options.err(USAGE + "\n");
    return 2;
  }
  const problems = [...parsed.problems];
  const flags: CliFlags = parsed.flags;
  const configPath = flags.config ?? options.env.HEPI_CLIENT_CONFIG;
  let file: Record<string, unknown> | undefined;
  if (configPath !== undefined) {
    const loaded = await readConfigFile(configPath);
    problems.push(...loaded.problems);
    file = loaded.file;
  }
  let tokenFileValue: string | undefined;
  if (flags.tokenFile !== undefined) {
    try {
      tokenFileValue = (await readFile(flags.tokenFile, "utf8")).trim();
      if (tokenFileValue === "") problems.push("token file is empty: " + flags.tokenFile);
    } catch (error) {
      problems.push("cannot read token file " + flags.tokenFile + ": " + (error as Error).message);
    }
  }
  const resolved = resolveSettings({ flags, env: options.env, file, filePath: configPath, tokenFileValue });
  problems.push(...resolved.problems);
  for (const warning of resolved.warnings) options.err("hepi-client: warning: " + warning + "\n");
  if (problems.length > 0 || resolved.settings === undefined) {
    for (const problem of problems) options.err("hepi-client: " + problem + "\n");
    options.err(USAGE + "\n");
    return 2;
  }
  const settings = resolved.settings;
  if (parsed.command === "doctor") {
    const result = await runDoctor(settings, options.probe ?? systemProbe);
    options.out(formatDoctor(result, flags.json === true, [settings.token]) + "\n");
    return result.ok ? 0 : 1;
  }
  const running = await startGateway(options.worktrees === undefined ? settings : { ...settings, worktrees: options.worktrees });
  // One JSON line per event, so a supervisor can wait for readiness without parsing prose. The token is not in it.
  options.out(JSON.stringify({ event: "listening", origin: running.origin, port: running.port, mode: settings.mode, gatewayId: settings.gatewayId, workspaceId: settings.workspaceId, workspaceRoot: settings.workspaceRoot, journal: settings.databasePath, allowedCommands: settings.allowedCommands }) + "\n");
  options.onStarted?.(running);
  await running.closed;
  return 0;
}

/**
 * Run only when this file is the program, not when a test imports it. `npm install` links the bin through
 * `node_modules/.bin`, so the invoked path is a link to the real module and both sides are resolved before comparing.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await run(process.argv.slice(2), {
    env: process.env,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
    onStarted: running => {
      // A signal stops the gateway the way a supervisor expects: settle in-flight work, then exit 0.
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => { void running.close(); });
      }
    },
  });
  process.exitCode = code;
}
