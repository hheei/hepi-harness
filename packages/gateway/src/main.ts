import { homedir } from "node:os";
import { join } from "node:path";
import { parseTerminalHeartbeatMs, remoteWorkspaceId, startGateway } from "./startup.ts";

/**
 * The gateway's own entrypoint: read the environment, then start the one shared composition.
 *
 * Everything this file does belongs to an entry — read configuration, state the defaults, report the listening line,
 * and stop on a signal. The gateway's capabilities, their single registry, the journal, the SSH master and the close
 * order live in `startGateway`, which the packaged CLI calls with its own resolved settings, so both entries start the
 * same gateway instead of keeping a composition each.
 */

const token = process.env.HEPI_GATEWAY_TOKEN;
const root = process.env.HEPI_WORKSPACE_ROOT;
if (!token || !root) throw new Error("Set HEPI_GATEWAY_TOKEN and HEPI_WORKSPACE_ROOT");

const id = process.env.HEPI_GATEWAY_ID ?? "workstation";
const allowedCommands = (process.env.HEPI_ALLOWED_COMMANDS ?? "").split(",").filter(Boolean);
const sshHost = process.env.HEPI_SSH_HOST;
// An SSH gateway addresses its workspace as `remote-<profile>`, the id the protocol already uses. The default
// follows that shape, and a configured id that names something else is refused by the shared composition rather than
// silently ignored — the same rule the CLI applies to the same setting.
const profile = process.env.HEPI_SSH_PROFILE ?? "loopback";
const workspaceId = process.env.HEPI_WORKSPACE_ID ?? (sshHost === undefined ? "local" : remoteWorkspaceId(profile));

// The call ledger outlives the process by default: a call that was running when the gateway stopped is answered as
// outcome-unknown after a restart instead of being run a second time. HEPI_GATEWAY_DB names the file; the default sits
// in the gateway user's own state directory, never in the workspace it serves. The SSH control directory lives beside
// it, in the same state directory.
const dataDirectory = process.env.HEPI_GATEWAY_DATA ?? join(homedir(), ".hepi", "gateway");
const databasePath = process.env.HEPI_GATEWAY_DB ?? join(dataDirectory, "calls.sqlite");

// The keepalive cadence this deployment states for its terminal streams. It exists because a hop in front of the
// gateway bounds how long a response body may stay silent; `0` states no keepalive at all, and an unset value reads the
// stated default. The value is refused here with the same rule the CLI applies.
const terminalHeartbeatMs = process.env.HEPI_TERMINAL_HEARTBEAT_MS === undefined ? undefined : parseTerminalHeartbeatMs(process.env.HEPI_TERMINAL_HEARTBEAT_MS);

const running = await startGateway({
	mode: sshHost === undefined ? "local" : "ssh",
	gatewayId: id,
	token,
	workspaceId,
	workspaceRoot: root,
	allowedCommands,
	port: Number(process.env.HEPI_GATEWAY_PORT ?? 8788),
	databasePath,
	...(sshHost === undefined ? {} : {
		ssh: {
			profile,
			host: sshHost,
			...(process.env.HEPI_SSH_PORT === undefined ? {} : { port: Number(process.env.HEPI_SSH_PORT) }),
			...(process.env.HEPI_SSH_IDENTITY === undefined ? {} : { identityFile: process.env.HEPI_SSH_IDENTITY }),
			...(process.env.HEPI_SSH_KNOWN_HOSTS === undefined ? {} : { knownHostsFile: process.env.HEPI_SSH_KNOWN_HOSTS }),
		},
	}),
	...(terminalHeartbeatMs === undefined ? {} : { terminalHeartbeatMs }),
});
console.log("hepi workbench gateway listening on " + databasePath);

// A signal stops the gateway the way a supervisor expects: close the surfaces, then the SSH master, and let the
// process end. The close is the running handle's own, so a second signal closes nothing twice.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void running.close(); });
await running.closed;
