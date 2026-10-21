import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { remoteWorkspaceId, sshWorkspaceIdProblem, terminalHeartbeatProblem, type GatewaySshSettings, type GatewayStartupSettings } from "../../gateway/src/startup.ts";

/** Commands the CLI accepts. `help` and `version` print and exit without reading configuration. */
export type Command = "gateway" | "doctor" | "help" | "version";

/** Options every command shares. Values stay as given; `resolveSettings` validates them. */
export type CliFlags = {
  readonly config?: string;
  readonly tokenFile?: string;
  readonly port?: string;
  readonly root?: string;
  readonly workspaceId?: string;
  readonly gatewayId?: string;
  readonly allowedCommands?: string;
  readonly dataDir?: string;
  readonly host?: string;
  readonly profile?: string;
  readonly sshPort?: string;
  readonly identity?: string;
  readonly knownHosts?: string;
  readonly terminalHeartbeatMs?: string;
  readonly json?: boolean;
};

/**
 * Everything one gateway process needs, resolved from flags, environment and the optional config file. It is the
 * shared startup composition's own settings plus the config file this run read, so the CLI and the gateway's own
 * entrypoint hand `startGateway` the same shape and neither keeps a private one.
 */
export type GatewaySettings = GatewayStartupSettings & { readonly configFile?: string };

export const DEFAULT_PORT = 8788;
export const DEFAULT_SSH_PROFILE = "loopback";
export const DEFAULT_GATEWAY_ID = "workstation";

const FLAG_KEYS: Readonly<Record<string, keyof CliFlags>> = {
  "--config": "config",
  "--token-file": "tokenFile",
  "--port": "port",
  "--root": "root",
  "--workspace-id": "workspaceId",
  "--gateway-id": "gatewayId",
  "--allowed-commands": "allowedCommands",
  "--data-dir": "dataDir",
  "--host": "host",
  "--profile": "profile",
  "--ssh-port": "sshPort",
  "--identity": "identity",
  "--known-hosts": "knownHosts",
  "--terminal-heartbeat-ms": "terminalHeartbeatMs",
};

const COMMANDS = new Set<Command>(["gateway", "doctor", "help"]);

export function parseArgs(argv: readonly string[]): { command?: Command; flags: CliFlags; problems: string[] } {
  const flags: Record<string, string | boolean> = {};
  const problems: string[] = [];
  let command: Command | undefined;
  let help = false;
  let version = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") { help = true; continue; }
    if (argument === "--version" || argument === "-v") { version = true; continue; }
    if (argument === "--json") { flags.json = true; continue; }
    if (argument.startsWith("--")) {
      const key = FLAG_KEYS[argument];
      if (key === undefined) { problems.push("unknown option: " + argument); continue; }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) { problems.push("missing value for " + argument); continue; }
      flags[key] = value;
      index += 1;
      continue;
    }
    if (COMMANDS.has(argument as Command)) {
      if (command === undefined) command = argument as Command;
      else problems.push("unexpected argument: " + argument);
      continue;
    }
    problems.push("unknown command: " + argument);
  }
  const resolved: Command | undefined = help ? "help" : version ? "version" : command;
  return { command: resolved, flags: flags as CliFlags, problems };
}

/** One flag beats the environment, which beats the config file. Nothing is read twice and no secret is echoed. */
export function resolveSettings(input: {
  flags: CliFlags;
  env: Record<string, string | undefined>;
  file?: Record<string, unknown>;
  filePath?: string;
  tokenFileValue?: string;
}): { settings?: GatewaySettings; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const fromEnv = (key: string): string | undefined => {
    const value = input.env[key];
    return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
  };
  const fromFile = (key: string): string | undefined => {
    const value = input.file?.[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") { problems.push(key + " in the config file must be a string"); return undefined; }
    return value.trim() !== "" ? value.trim() : undefined;
  };
  const pick = (key: string, flag?: string): string | undefined => flag ?? fromEnv(key) ?? fromFile(key);
  const integer = (value: string | undefined, fallback: number, field: string, minimum: number, maximum: number): number => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      problems.push(field + " must be an integer between " + minimum + " and " + maximum + ": " + value);
      return fallback;
    }
    return parsed;
  };

  const token = input.tokenFileValue ?? fromEnv("HEPI_GATEWAY_TOKEN") ?? fromFile("HEPI_GATEWAY_TOKEN");
  if (token === undefined) problems.push("HEPI_GATEWAY_TOKEN is required: set it in the environment, the config file, or pass --token-file");

  const workspaceRoot = pick("HEPI_WORKSPACE_ROOT", input.flags.root);
  if (workspaceRoot === undefined) problems.push("HEPI_WORKSPACE_ROOT is required: the workspace root on the execution host");
  else if (!isAbsolute(workspaceRoot)) problems.push("HEPI_WORKSPACE_ROOT must be an absolute path: " + workspaceRoot);

  const host = pick("HEPI_SSH_HOST", input.flags.host);
  const profile = pick("HEPI_SSH_PROFILE", input.flags.profile) ?? DEFAULT_SSH_PROFILE;
  const identityFile = pick("HEPI_SSH_IDENTITY", input.flags.identity);
  const knownHostsFile = pick("HEPI_SSH_KNOWN_HOSTS", input.flags.knownHosts);
  if (identityFile !== undefined && !isAbsolute(identityFile)) problems.push("HEPI_SSH_IDENTITY must be an absolute path: " + identityFile);
  if (knownHostsFile !== undefined && !isAbsolute(knownHostsFile)) problems.push("HEPI_SSH_KNOWN_HOSTS must be an absolute path: " + knownHostsFile);
  const sshPort = pick("HEPI_SSH_PORT", input.flags.sshPort) === undefined ? undefined : integer(pick("HEPI_SSH_PORT", input.flags.sshPort), 22, "HEPI_SSH_PORT/--ssh-port", 1, 65535);

  const allowedCommands = (pick("HEPI_ALLOWED_COMMANDS", input.flags.allowedCommands) ?? "").split(",").map(value => value.trim()).filter(value => value !== "");
  if (host !== undefined && allowedCommands.length === 0) warnings.push("no commands are allowed: every execution request will be refused (set HEPI_ALLOWED_COMMANDS)");
  const port = integer(pick("HEPI_GATEWAY_PORT", input.flags.port), DEFAULT_PORT, "HEPI_GATEWAY_PORT/--port", 0, 65535);
  const dataDir = pick("HEPI_GATEWAY_DATA", input.flags.dataDir);
  const databasePath = pick("HEPI_GATEWAY_DB") ?? join(dataDir ?? join(homedir(), ".hepi", "gateway"), "calls.sqlite");
  // An SSH workspace is addressed as remote-<profile> by the gateway protocol; the mapping is not configurable, so a
  // custom ID would make the gateway advertise an ID its own RPC refuses. Reject it here rather than rewrite it.
  const configuredWorkspaceId = pick("HEPI_WORKSPACE_ID", input.flags.workspaceId);
  if (host !== undefined && configuredWorkspaceId !== undefined && configuredWorkspaceId !== remoteWorkspaceId(profile)) {
    problems.push(sshWorkspaceIdProblem(profile, configuredWorkspaceId));
  }
  const workspaceId = configuredWorkspaceId ?? (host === undefined ? "local" : remoteWorkspaceId(profile));
  const gatewayId = pick("HEPI_GATEWAY_ID", input.flags.gatewayId) ?? DEFAULT_GATEWAY_ID;
  // The terminal stream's keepalive cadence. Unset reads the shared default, and a value that is not a non-negative
  // number is refused by the same rule the gateway's own entrypoint applies, so neither entry accepts what the other
  // rejects. It is not resolved here: the composition states what an unset value means.
  const terminalHeartbeat = pick("HEPI_TERMINAL_HEARTBEAT_MS", input.flags.terminalHeartbeatMs);
  if (terminalHeartbeat !== undefined) {
    const problem = terminalHeartbeatProblem(terminalHeartbeat);
    if (problem !== undefined) problems.push(problem);
  }

  if (problems.length > 0 || token === undefined || workspaceRoot === undefined) return { problems, warnings };
  const ssh: GatewaySshSettings | undefined = host === undefined ? undefined : { profile, host, ...(sshPort === undefined ? {} : { port: sshPort }), ...(identityFile === undefined ? {} : { identityFile }), ...(knownHostsFile === undefined ? {} : { knownHostsFile }) };
  return {
    settings: {
      mode: ssh === undefined ? "local" : "ssh",
      gatewayId,
      token,
      workspaceId,
      workspaceRoot,
      allowedCommands,
      port,
      databasePath,
      ...(input.filePath === undefined ? {} : { configFile: input.filePath }),
      ...(ssh === undefined ? {} : { ssh }),
      ...(terminalHeartbeat === undefined ? {} : { terminalHeartbeatMs: Number(terminalHeartbeat.trim()) }),
    },
    problems,
    warnings,
  };
}
