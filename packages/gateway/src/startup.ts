import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { GatewayExecutionJournal } from "./execution.ts";
import { LocalFilesystem, localExecutionHostIdentity } from "./filesystem.ts";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway, SshGateway, WorkspaceServer, type SshProfile, type WorktreeServer } from "./index.ts";
import { LocalInstallServer, SshInstallServer } from "./install.ts";
import { agentDirOf } from "./mcp/config.ts";
import { McpHostService } from "./mcp/host.ts";
import { localProviderAuthContext, ProviderAuthService } from "./provider-auth.ts";
import { ProviderLoginService } from "./provider-login.ts";
import { createSystemSshRunner, managedControlMaster, type ManagedControlMaster, type SshRunner } from "./runner.ts";
import { SshFilesystem } from "./ssh-filesystem.ts";
import { SshWorkspaceServer } from "./ssh-workspaces.ts";
import { localTerminalLauncher, sshTerminalLauncher, TerminalSessions, TERMINAL_HEARTBEAT_MS } from "./terminal.ts";
import { GatewayWorkbench } from "./workbench/index.ts";
import { sshWorkbench } from "./workbench/ssh-files.ts";
import { SshWorktreeServer } from "./worktrees.ts";
import { sshWorkspaceSeed, WorkspaceRegistry } from "./workspaces.ts";

/**
 * One Gateway composition, shared by every entry that starts one.
 *
 * A gateway is the same set of capabilities whoever starts it: one registry every surface serves, one call journal, the
 * execution runner and its SSH transport, the surfaces themselves, the loopback listener, and a close that releases
 * the surfaces before the SSH master they used. That composition lives here once. An entry — the gateway's own
 * environment-configured entrypoint, or the CLI that resolves flags, environment and a config file — resolves its
 * settings, calls this, and keeps only what belongs to an entry: reading configuration, signals and its own output.
 *
 * The resolved settings decide the mode. Local and SSH are mutually exclusive: an SSH gateway serves one profile's
 * remote root and seeds its registry from that profile, a local gateway serves its own configured root and owns MCP,
 * which belongs to this host's account. Everything else — worktrees, terminals, installation, files, workspace
 * management — is composed the same way in both modes.
 */
export type GatewaySshSettings = {
	readonly profile: string;
	readonly host: string;
	readonly port?: number;
	readonly identityFile?: string;
	readonly knownHostsFile?: string;
};

/**
 * The SSH transport this gateway's processes are composed over.
 *
 * Production reads the system one: `ssh` built from the resolved connection profile, multiplexed over a master this
 * gateway owns. It is a setting rather than a constant because a gateway composed in a test process is reached by a
 * transport that answers the same contract in that process — and only the transport changes, so what a caller sees
 * stays exactly what a real host serves.
 */
export type GatewaySshTransport = {
	/** The transport installation and execution multiplex over the gateway's managed master. */
	readonly shared?: SshRunner;
	/** The transport files, workspaces, worktrees and terminals open their own sessions on. */
	readonly plain?: SshRunner;
	/**
	 * Whether this gateway creates, checks and reaps its own master socket directory. A transport that answers the host
	 * itself has no socket to bind, so it states that instead of leaving an empty directory behind.
	 */
	readonly controlDirectory?: boolean;
};

/** Everything one gateway process needs, already resolved and validated by the entry that read it. */
export type GatewayStartupSettings = {
	readonly mode: "local" | "ssh";
	readonly gatewayId: string;
	readonly token: string;
	readonly workspaceId: string;
	readonly workspaceRoot: string;
	readonly allowedCommands: readonly string[];
	readonly port: number;
	/** The call journal's file. The SSH control directory sits beside it, in this gateway's own state. */
	readonly databasePath: string;
	readonly ssh?: GatewaySshSettings;
	/** The SSH transport the SSH mode is composed over; absent reads the system transport and its managed master. */
	readonly sshTransport?: GatewaySshTransport;
	/** The terminal stream's keepalive cadence in milliseconds; absent reads the stated default and `0` states none. */
	readonly terminalHeartbeatMs?: number;
	/** The worktree surface to compose over the registry; absent reads the local one, which runs git on this machine. */
	readonly worktrees?: (workspaces: WorkspaceRegistry) => WorktreeServer;
};

/** The handle a started gateway returns: where it is, and how it stops. */
export type RunningGateway = {
	/** The loopback origin it is reachable at, with the port it actually bound. */
	readonly origin: string;
	readonly port: number;
	/** Resolves once this gateway has closed, which is what an entry waits on before it exits. */
	readonly closed: Promise<void>;
	/** Close the surfaces, then the SSH master this process created. Repeating it closes nothing twice. */
	close(): Promise<void>;
};

/** The keepalive cadence an unset value reads. */
export const DEFAULT_TERMINAL_HEARTBEAT_MS = TERMINAL_HEARTBEAT_MS;

/**
 * The workspace id an SSH gateway serves: `remote-<profile>`, the shape the protocol already addresses.
 *
 * It is derived from the profile rather than configured, because the gateway seeds its registry under this id and its
 * own RPC looks the id up as an opaque key. Every entry derives it here, so both agree on the spelling.
 */
export const remoteWorkspaceId = (profile: string): string => "remote-" + profile;

/**
 * Why one stated terminal keepalive cadence is unusable, or undefined when it is usable.
 *
 * Every entry that reads a cadence asks this, so a value one entry accepts is a value the other accepts, and a value
 * either refuses is refused for the same stated reason instead of falling back to a default silently. `0` is a value,
 * not an absence: it states no keepalive at all.
 */
export function terminalHeartbeatProblem(value: string): string | undefined {
	const text = value.trim();
	const milliseconds = Number(text);
	if (text === "" || !Number.isFinite(milliseconds) || milliseconds < 0) {
		return "HEPI_TERMINAL_HEARTBEAT_MS/--terminal-heartbeat-ms must be a non-negative number of milliseconds: " + value;
	}
	return undefined;
}

/** The cadence one stated value means, or a thrown error naming why it means nothing. */
export function parseTerminalHeartbeatMs(value: string): number {
	const problem = terminalHeartbeatProblem(value);
	if (problem !== undefined) throw new Error(problem);
	return Number(value.trim());
}

/**
 * Why one workspace ID cannot be served by an SSH gateway, worded once for every entry that resolves one.
 *
 * An SSH gateway seeds its registry from its profile under the `remote-<profile>` ID the protocol already uses, so a
 * different configured ID would advertise a workspace its own RPC refuses. It is a configuration error, not something
 * to rewrite or ignore.
 */
export function sshWorkspaceIdProblem(profile: string, workspaceId: string): string {
	return "HEPI_WORKSPACE_ID/--workspace-id must be " + remoteWorkspaceId(profile) + " for an SSH gateway (profile " + profile + "): the gateway addresses the workspace as remote-<profile>; it was " + workspaceId;
}

/** The profile this gateway serves, or undefined for a local one. Refuses a configuration the two modes cannot share. */
export function sshProfileOf(settings: GatewayStartupSettings): SshProfile | undefined {
	if (settings.mode === "local") {
		if (settings.ssh !== undefined) throw new Error("a local gateway must not be given SSH settings");
		return undefined;
	}
	if (settings.ssh === undefined) throw new Error("an SSH gateway needs its SSH settings");
	if (settings.workspaceId !== remoteWorkspaceId(settings.ssh.profile)) throw new Error(sshWorkspaceIdProblem(settings.ssh.profile, settings.workspaceId));
	const ssh = settings.ssh;
	return {
		id: ssh.profile,
		host: ssh.host,
		remoteRoot: resolve(settings.workspaceRoot),
		...(ssh.port === undefined ? {} : { port: ssh.port }),
		...(ssh.identityFile === undefined ? {} : { identityFile: ssh.identityFile }),
		...(ssh.knownHostsFile === undefined ? {} : { knownHostsFile: ssh.knownHostsFile }),
	};
}

/**
 * Start the gateway these settings describe: open the journal, compose every surface over one registry, listen on
 * loopback, and return the running handle.
 *
 * A startup that fails releases what it created before it rethrows, so a caller that reports the failure — or retries
 * — is not left holding a journal, a socket or an SSH master from the attempt that did not come up.
 */
export async function startGateway(settings: GatewayStartupSettings): Promise<RunningGateway> {
	const profile = sshProfileOf(settings);
	await mkdir(dirname(settings.databasePath), { recursive: true });
	// The call ledger outlives the process: a call that was running when the gateway stopped is answered as
	// outcome-unknown after a restart instead of being run a second time. The default sits in the gateway user's own
	// state directory, never in the workspace it serves.
	const ledger = new GatewayExecutionJournal({ path: settings.databasePath });
	let master: ManagedControlMaster | undefined;
	let rpc: GatewayRpcServer | undefined;
	try {
		// One registry for every surface this gateway serves. A workspace registered at runtime (the backend's project
		// bindings) is therefore served by execution, files and installation at once, instead of each surface keeping its
		// own boot-time copy. The environment's workspace is seeded here and keeps its configured root and id unchanged.
		const registry = new WorkspaceRegistry([{ id: settings.workspaceId, root: resolve(settings.workspaceRoot) }]);
		// An SSH gateway seeds its registry from its profiles — the same `remote-<profile>` id the CLI contract already
		// uses — and serves its runtime registrations from that one registry, so a project folder is executed, read,
		// installed and managed through the same profile lookup instead of each surface parsing the id's spelling.
		const sshRegistry = profile === undefined ? registry : new WorkspaceRegistry(sshWorkspaceSeed([profile]));
		const workspaces = profile === undefined ? registry : sshRegistry;
		// Installation and execution multiplex over one gateway-managed SSH master, keyed on the full connection profile
		// and living in the gateway's own state directory, beside its journal. The user's own SSH configuration and
		// masters are untouched: these options are added to the argv of the gateway's own install and execution processes
		// only. The directory is created here, before the first spawn, because ssh refuses a missing ControlPath
		// directory instead of falling back to a direct connection. Files, workspaces, worktrees and terminals keep the
		// plain transport — a terminal already holds one connection for the life of a session.
		const transport = settings.sshTransport;
		const plainRunner = profile === undefined ? undefined : transport?.plain ?? createSystemSshRunner();
		// The master is this gateway's own socket directory: it is created and mode-checked before the first spawn,
		// because ssh exits 255 rather than falling back when the ControlPath directory is missing. A stated transport
		// that answers the host itself binds no socket, so it states that no directory is to be created either.
		master = profile === undefined || transport?.controlDirectory === false
			? undefined
			: managedControlMaster({ directory: join(dirname(settings.databasePath), "ssh-control") });
		await master?.prepare();
		const sharedRunner = profile === undefined
			? undefined
			: transport?.shared ?? transport?.plain ?? createSystemSshRunner(master);
		const gateway = profile === undefined
			? new LocalGateway({ id: settings.gatewayId, token: settings.token, workspaces: registry, allowedCommands: settings.allowedCommands }, ledger)
			: new SshGateway({ id: settings.gatewayId, token: settings.token, profiles: [profile], allowedCommands: settings.allowedCommands, workspaces: sshRegistry, runner: sharedRunner! }, ledger);
		const files = profile === undefined ? new LocalFilesystem(registry) : new SshFilesystem({ id: settings.gatewayId, profiles: [profile], runner: plainRunner!, workspaces: sshRegistry });
		// Installation is its own narrow capability: it publishes whole directories into an installation scope and stores
		// the scope lock. It is not the file RPC, so ordinary resource mutations keep their existing boundaries.
		const installs = profile === undefined ? new LocalInstallServer(registry) : new SshInstallServer({ profiles: [profile], runner: sharedRunner!, workspaces: sshRegistry });
		// Workspace management: the local surface browses this machine's own directories, and the SSH one browses the
		// remote host's, canonicalizes a chosen path there, and registers it under an opaque id. Neither creates or
		// renames anything.
		const admin = profile === undefined ? new WorkspaceServer(registry, { identity: localExecutionHostIdentity() }) : new SshWorkspaceServer(sshRegistry, { profiles: [profile], runner: plainRunner! });
		// The read-only workbench is mounted on both kinds of gateway: the same surface and the same protocol, composed
		// over the host that really holds the workspace. Locally that is this machine; on an SSH gateway the previews
		// and listings read through the filesystem above and Git runs through the plain runner the worktree surface
		// already uses, so no SSH credential reaches the backend or the browser and no second transport is opened.
		const workbench = profile === undefined
			? new GatewayWorkbench(registry)
			: sshWorkbench({ workspaces: sshRegistry, profiles: [profile], files, runner: plainRunner! });
		// Worktrees are a host capability, so both kinds of gateway serve them: the local one runs git here, the SSH one
		// runs the same git argv on the host the profile names.
		const worktrees = settings.worktrees !== undefined
			? settings.worktrees(workspaces)
			: profile === undefined ? new GatewayWorktrees(registry) : new SshWorktreeServer(sshRegistry, { profiles: [profile], runner: plainRunner! });
		// Terminal sessions: the same helper on either host, reached directly here and through the runner's interactive
		// SSH transport there. It is the only surface with a lifecycle of its own, and it writes nothing to a transcript.
		const terminals = new TerminalSessions({
			id: settings.gatewayId,
			workspaces,
			launcher: profile === undefined ? localTerminalLauncher() : sshTerminalLauncher({ profiles: [profile], runner: plainRunner!, workspaces: sshRegistry }),
			...(settings.terminalHeartbeatMs === undefined ? {} : { heartbeatIntervalMs: settings.terminalHeartbeatMs }),
		});
		// MCP belongs to the Web host's own account and filesystem, so only a local gateway serves it. An SSH gateway
		// executes and reads on a remote host; that host's MCP configuration is not this Web host's.
		const mcp = profile === undefined ? new McpHostService(agentDirOf(localExecutionHostIdentity().home), registry) : undefined;
		// Provider credentials are the execution account's own and live in its agent directory, so this surface is the local
		// gateway's for the same reason MCP is: an SSH gateway's `auth.json` belongs to a remote account this Web host does
		// not own, and writing it from here would be storing a credential somewhere its owner did not choose.
		const providers = profile === undefined
			? new ProviderAuthService({ agentDir: agentDirOf(localExecutionHostIdentity().home), context: localProviderAuthContext() })
			: undefined;
		// A sign-in writes the same file as the listing beside it, so it is composed with the same owner of that file
		// rather than opening a second handle on one account. An SSH gateway serves neither, for the same reason.
		const providerLogins = providers === undefined
			? undefined
			: new ProviderLoginService({ agentDir: agentDirOf(localExecutionHostIdentity().home), context: localProviderAuthContext(), auth: providers });
		// The one composition every entry shares: the capabilities this host serves, by name. A capability the mode does
		// not serve is simply absent, and its routes answer their own named limit.
		rpc = new GatewayRpcServer({ gateway, workbench, files, installs, workspaces: admin, worktrees, terminals, mcp, providers, providerLogins });
		await listen(rpc, settings.port);
	} catch (error) {
		// A startup that did not come up leaves nothing behind: the surfaces close first — releasing the journal with
		// them — and only then the master, which no surface uses once they are closed.
		if (rpc !== undefined) await rpc.close().catch(() => undefined);
		else ledger.close();
		await master?.close().catch(() => undefined);
		throw error;
	}
	const address = rpc.server.address();
	if (address === null || typeof address !== "object") {
		await rpc.close().catch(() => undefined);
		await master?.close().catch(() => undefined);
		throw new Error("the gateway did not bind a TCP port");
	}
	let resolveClosed: () => void = () => {};
	const closed = new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise; });
	let closing: Promise<void> | undefined;
	return {
		origin: "http://127.0.0.1:" + address.port,
		port: address.port,
		closed,
		// The master is reaped after the surfaces that use it are closed, and only the sockets this process created go
		// with it. A close that fails still attempts both, and the failure is reported to the caller that asked to stop.
		close: () => (closing ??= (async () => {
			let failure: unknown;
			try { await rpc.close(); } catch (error) { failure = error; }
			try { await master?.close(); } catch (error) { failure ??= error; }
			if (failure !== undefined) throw failure;
		})().finally(resolveClosed)),
	};
}

/** Bind the listener, reporting a bind failure as a rejected startup rather than an unhandled server event. */
async function listen(rpc: GatewayRpcServer, port: number): Promise<void> {
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error): void => rejectListen(error);
		rpc.server.once("error", onError);
		rpc.server.listen(port, "127.0.0.1", () => {
			rpc.server.off("error", onError);
			resolveListen();
		});
	});
}
