import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionError, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { resolveWorkspacePath, type FilesystemServer } from "./filesystem.ts";
// The upload conflict vocabulary is part of the file surface's wire contract: a caller of the capability names one of
// these strategies, and a relay that reads the browser's query names it the same way instead of casting a string.
export { parseUploadConflict, UPLOAD_CONFLICT_STRATEGIES, type UploadConflictStrategy } from "./file-transfer.ts";
import { gatewayEnvironment } from "./environment.ts";
import {
	GatewayExecutionJournal,
	MemoryLedger,
	OutputCapture,
	validExecuteRequest,
	type ExecuteFailureCode,
	type LedgerEntry,
	type ExecuteFrame,
	type ExecuteRequest,
	type ExecuteResult,
	type ExecutionLedger,
	type LedgerOutcome,
	type LedgerOutput,
	type OutputChunk,
} from "./execution.ts";
import { createSystemSshRunner, managedControlMaster, type SshRunner } from "./runner.ts";
import type { TerminalSessions } from "./terminal.ts";
import { FilePayloadTransport, filePayloadRoute } from "./transport/file-payload.ts";
import { writeJson } from "./transport/http.ts";
import { ControlTransport, controlRoute } from "./transport/control.ts";
import { ExecutionTransport, executionRoute } from "./transport/execution.ts";
import { McpTransport, mcpRoute } from "./transport/mcp.ts";
import { ProviderTransport, providerRoute } from "./transport/providers.ts";
import { TerminalTransport, terminalRoute } from "./transport/terminal.ts";
import type { InstallServer } from "./install.ts";
import type { GatewayWorkbench } from "./workbench/index.ts";
import type { WorktreeServer } from "./worktrees.ts";
import { workspaceOwner, WorkspaceRegistry, type WorkspaceServer } from "./workspaces.ts";
import type { SshWorkspaceServer } from "./ssh-workspaces.ts";
import { agentDirOf } from "./mcp/config.ts";
import { McpHostService } from "./mcp/host.ts";
import type { ProviderAuthService } from "./provider-auth.ts";
import type { ProviderLoginService } from "./provider-login.ts";

export { gatewayEnvironment } from "./environment.ts";
export type { EnvironmentBinding, ExecutionHostEnv, ExecutionIdentity } from "./environment.ts";
export { MAX_FILE_BYTES, MAX_FRONTMATTER_BYTES, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ENTRIES, executionHost, localExecutionHostIdentity, resourceRoots, resourceSnapshot, skillHead } from "./filesystem.ts";
export { ResourceIgnoreRules, ignorePattern } from "./resource-ignore.ts";
export type { ExecutionHost, ExecutionHostIdentity, ResourceRoot, ResourceSnapshot, SnapshotDirectory, SnapshotEntry, SnapshotFailure, SnapshotFile, SnapshotUnreadableDirectory } from "./filesystem.ts";
export { findShadowedContextFile } from "./worktree-shadow.ts";
export { createSystemSshRunner, managedControlMaster, sshConnectionArgs } from "./runner.ts";
export type { ManagedControlMaster, SshConnection, SshOpenRequest, SshRunner, SshRunnerRequest, SshRunnerResult } from "./runner.ts";
export { localTerminalLauncher, sshTerminalLauncher, TerminalSessions, TERMINAL_RECONNECT_MS, TERMINAL_REPLAY_CHARS, TERMINAL_HEARTBEAT_MS, TERMINAL_HEARTBEAT_FRAME, TERMINAL_STREAM_BUDGET_BYTES, terminalHelperCommand } from "./terminal.ts";
export type {
	TerminalCloseResult,
	TerminalCommandResult,
	TerminalDescription,
	TerminalEvent,
	TerminalExit,
	TerminalFailure,
	TerminalFailureCode,
	TerminalHost,
	TerminalLaunch,
	TerminalLauncher,
	TerminalOpenRequest,
	TerminalOpenResult,
	TerminalReplay,
	TerminalSubscription,
} from "./terminal.ts";
export { emptyLockDocument, folderContentHash, installFailure, installLockPath, installScopeRoot, INSTALL_DIRECTORY_PATTERN, LINK_DIGEST_PREFIX, LocalInstallServer, safeInstallPath, sameDigests, SshInstallServer, validLockDocument, validLockEntry } from "./install.ts";
export type { DirectoryInspection, ExpectedDigests, InstallError, InstallFailureCode, InstallLockDocument, InstallLockEntry, InstallRequest, InstallResult, InstallScope, InstallServer, PublishFile, PublishedDirectory, ToggledSkill } from "./install.ts";
export { setDisableModelInvocation } from "./skill-frontmatter.ts";
export { GatewayExecutionJournal, MemoryLedger, OutputCapture, parseFrames } from "./execution.ts";
export type {
	ExecuteFailureCode,
	ExecuteFrame,
	ExecuteRequest,
	ExecuteResult,
	ExecutionLedger,
	LedgerEntry,
	LedgerOutcome,
	OutputChunk,
	OutputSink,
	ShellLimits,
} from "./execution.ts";

export { GatewayWorktrees, SshWorktreeServer, localGitRunner, worktreeRemovalRequiresForce, WORKTREE_ADD_TIMEOUT_MS, WORKTREE_GIT_TIMEOUT_MS } from "./worktrees.ts";
export type { GitCommandResult, GitCommandRunner, WorktreeEntry, WorktreeFailureCode, WorktreeListing, WorktreeRequest, WorktreeResult, WorktreeServer } from "./worktrees.ts";
export { sshWorkspaceSeed, workspaceOwner, WorkspaceRegistry, WorkspaceServer } from "./workspaces.ts";
export type { WorkspaceConfig, WorkspaceDirectory, WorkspaceListing, WorkspaceProfile, WorkspaceRegistration, WorkspaceRequest, WorkspaceResult, WorkspaceServerOptions } from "./workspaces.ts";
export { SshWorkspaceServer } from "./ssh-workspaces.ts";
export type { SshWorkspaceOptions } from "./ssh-workspaces.ts";

// The MCP capability this host owns, as its entrypoint composes it. The public surface of the capability is
// `POST /v1/mcp` on this gateway, not a TypeScript API: `McpHostService` and `agentDirOf` are what a composition
// point needs, and the operation and answer shapes are what a caller of that route reads.
export { agentDirOf } from "./mcp/config.ts";
export type { McpConfigFileInfo, McpConfigFileProblem, McpConfigRead, McpScope, McpServerInfo, McpTransportKind, ProjectTrust } from "./mcp/config.ts";
export { McpHostService } from "./mcp/host.ts";

// The control surfaces — workspaces, worktrees, the read-only workbench, MCP and installation scopes — as one namespace
// over the shared transport. A server call site builds it from the binding it already resolved. The request and answer
// shapes stay in `@hepi/protocol/gateway`; the installation ones stay this package's own, which owns that surface.
export { CONTROL_TIMEOUT_MS, controlCapability } from "./control.ts";
export type { ControlRequestOptions, GatewayControl } from "./control.ts";
export { GatewayHostTransport, HOST_REQUEST_TIMEOUT_MS, HostTransportError } from "./host-client.ts";
export type { HostBinding, HostFetch, HostJsonRequest, HostRequestOptions, HostRequestPolicy, HostTransportErrorCode, HostTransportErrorOptions, HostTransportRequest } from "./host-client.ts";
export { createProcessCapability } from "./process.ts";
export type { ProcessCapability } from "./process.ts";
export { GatewayHostClient } from "./client.ts";
export type { GatewayHostClientOptions } from "./client.ts";
export { GatewayFilesCapability, filesCapability } from "./host-files.ts";
export type { FilesBytesCall, FilesCallOptions, FilesUploadCall, FilesUploadCheckCall } from "./host-files.ts";
export { GatewayTerminalCapability, terminalCapability } from "./host-terminal.ts";
export type { TerminalCallOptions, TerminalCloseCall, TerminalDescribeCall, TerminalEventRequest, TerminalFanInRequest, TerminalFanInTab, TerminalInputCall, TerminalOpenCall, TerminalResizeCall } from "./host-terminal.ts";
export type { McpHostRequest, McpHostResult, McpSignInFlowInfo, McpSignInPhase, McpTestResult, McpTestState, McpToolDescriptor, McpToolList, McpToolListFailureCode, McpToolListRequest, McpToolListResult } from "./mcp/host.ts";

// Provider connection state is the execution host's own, like MCP: the account whose `auth.json` holds the credentials is
// the account this gateway runs as. The wire shapes stay in `@hepi/protocol/gateway`; the service, the masked hint it
// derives and the file it writes are this package's.
export { builtinProviderCatalog, localProviderAuthContext, maskedKeyHint, PROVIDER_AUTH_LOCK_TIMEOUT_MS, ProviderAuthFileError, ProviderAuthLockError, ProviderAuthService, ProviderCredentialFile } from "./provider-auth.ts";
export type { ProviderAuthFailureCode, ProviderAuthRequest, ProviderAuthResult, ProviderAuthStatus, ProviderCatalogEntry, ProviderCredentialType } from "./provider-auth.ts";
// A provider sign-in is the same host account's, and a composition root that wires an ingress to `POST
// /v1/providers/auth` needs to know the second route exists and what it answers; the flow itself is upstream's.
export { PROVIDER_LOGIN_KEEP_MS, PROVIDER_LOGIN_MAX_FLOWS, PROVIDER_LOGIN_TTL_MS, ProviderLoginService } from "./provider-login.ts";
export type { ProviderLoginClock } from "./provider-login.ts";
export type { ProviderLoginRequest, ProviderLoginResult } from "@hepi/protocol/gateway";

// The browser's file surface: the routing vocabulary, the listing, preview, upload and Git translations, and the one
// bounded multipart reader. It is served by whichever entry fronts the browser, so it is a capability of this package
// rather than of one entry — and the file policy it applies (batch bound, conflict rules, byte ranges) stays the host's.
export { createFileSurface, isFileSurfacePath } from "./files-surface.ts";
export type { FileSurfaceCall, FileSurfaceOptions, FileSurfaceRequest } from "./files-surface.ts";
export { MAX_UPLOAD_BATCH_BYTES, readUploadParts, UploadTooLargeError, UPLOAD_FIELD } from "./multipart.ts";
export type { ReadUploadPartsOptions, UploadBody, UploadPart, UploadRequestHeaders } from "./multipart.ts";

/** Output the gateway keeps from one call before it stops storing and reports the drop instead. */
const DEFAULT_CAPTURE_BYTES = 4 * 1024 * 1024;
/** How long an abort that arrived before its call is remembered, so a late duplicate is not run. */
const REFUSAL_TTL_MS = 60_000;

export type SshProfile = { readonly id: string; readonly host: string; readonly remoteRoot: string; readonly port?: number; readonly identityFile?: string; readonly knownHostsFile?: string };
export type SshGatewayOptions = {
	readonly id: string;
	readonly token: string;
	readonly profiles: readonly SshProfile[];
	readonly allowedCommands: readonly string[];
	readonly runner?: SshRunner;
	/** The gateway's shared registry: a folder the backend registered at runtime executes on the profile it names. */
	readonly workspaces: WorkspaceRegistry;
	readonly captureBytes?: number;
};

export type SshExecuteRequest = ExecuteRequest;

type LocalGatewayOptions = { readonly id: string; readonly token: string; readonly workspaces: WorkspaceRegistry; readonly allowedCommands: readonly string[]; readonly captureBytes?: number };

function fail(code: ExecuteFailureCode, callId?: string, message?: string, spillPath?: string): ExecuteResult {
	return { ok: false, code, ...(callId === undefined ? {} : { callId }), ...(message === undefined ? {} : { message }), ...(spillPath === undefined ? {} : { spillPath }) };
}
function isWithin(root: string, path: string): boolean { const child = relative(root, path); return child === "" || (!child.startsWith(".." + "/") && child !== ".." && !child.startsWith("/")); }
/** The working directory one call runs in: relative, logical workspace-absolute and physical absolute all name the same place. */
function workspaceCwd(root: string, cwd: string | undefined): string { return resolveWorkspacePath(root, cwd === undefined || cwd === "" ? "." : cwd); }
function commandName(command: string): string { return basename(command); }
function mapSshError(error: unknown): ExecuteFailureCode { const code = (error as { code?: string }).code; return code === "unreachable" ? "ssh_unreachable" : code === "timeout" ? "timeout" : code === "aborted" ? "aborted" : code === "outcome_unknown" ? "outcome-unknown" : "execution_failed"; }

/**
 * The request a call ID was used for, so a repeated ID with different arguments is refused instead of answered from the
 * record of another request. JSON keeps the fields apart: a command containing the separator cannot forge a match.
 */
function fingerprintRequest(request: ExecuteRequest): string {
	return JSON.stringify([request.cwd ?? null, request.command, request.env ?? null, request.timeoutMs ?? null, request.spill ?? null, request.window ?? null]);
}

/** What a gateway's transport reports about one call, before the gateway adds its own identity and the call's output. */
type RunOutcome =
	| { readonly ok: true; readonly exitCode: number; readonly spillPath?: string; readonly stdout?: string; readonly stderr?: string; readonly spillUnsupported?: true }
	| { readonly ok: false; readonly code: ExecuteFailureCode; readonly message?: string; readonly spillPath?: string };

/**
 * The lifecycle every gateway shares: one ledger decides whether a call may run, output streams to a sink, and the
 * result is recorded before it is returned. A gateway that fails mid-call records the failure it can name and leaves
 * the call unknown when it cannot.
 */
abstract class Gateway {
	readonly id: string;
	readonly token: string;
	readonly #ledger: ExecutionLedger;
	readonly #active = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<ExecuteResult>>();
	readonly #refusals = new Map<string, number>();
	readonly #captureBytes: number;

	constructor(id: string, token: string, ledger: ExecutionLedger, captureBytes: number) {
		this.id = id;
		this.token = token;
		this.#ledger = ledger;
		this.#captureBytes = captureBytes;
	}

	/** Check the request and dispatch it, unless the ledger already knows the call ID. */
	async execute(request: ExecuteRequest, onOutput?: (chunk: OutputChunk) => void | Promise<void>): Promise<ExecuteResult> {
    const pending = this.#execute(request, onOutput); this.#pending.add(pending);
    try { return await pending; } finally { this.#pending.delete(pending); }
  }

  async #execute(request: ExecuteRequest, onOutput?: (chunk: OutputChunk) => void | Promise<void>): Promise<ExecuteResult> {
    if (!validExecuteRequest(request)) return fail("invalid_request");
		// Call IDs are model-generated and repeat across conversations, so the ledger key is scoped to this gateway's
		// workspace and the fingerprint pins the request: the same ID with a different command is refused, never
		// answered with another request's output.
		const key = this.id + "\u0000" + request.workspaceId + "\u0000" + request.callId;
		const fingerprint = fingerprintRequest(request);
		const known = this.#ledger.lookup(key);
		if (known !== undefined) return this.#answer(request, known, fingerprint);

		// An abort can arrive before its call does: remember it, so the call is refused instead of run and aborted.
		this.#sweepRefusals();
		if (this.#refusals.has(key)) {
			const outcome = { ok: false as const, code: "aborted" as const, message: "aborted before the call was admitted" };
			this.#ledger.refuse(key, fingerprint, outcome);
			return fail(outcome.code, request.callId, outcome.message);
		}

		const rejection = await this.validate(request);
		if (rejection !== undefined) return fail(rejection, request.callId);

		// Admission is the point of no return: after it the call ID is spent, whether or not it starts.
		if (!this.#ledger.begin(key, fingerprint)) {
			const raced = this.#ledger.lookup(key)!;
			return this.#answer(request, raced, fingerprint);
		}
		const controller = new AbortController();
		this.#active.set(key, controller);
		if (this.#refusals.has(key)) controller.abort();

		// The output the call produced, kept in the ledger as well as streamed, so a repeated call can be answered
		// without running it again. Each stream keeps its own chunks under its own `captureBytes` budget, so appending
		// costs what the chunk wrote rather than the size of what is already retained, and the retained text is joined
		// once. A live caller is never truncated: the whole output still travels the sink.
		const captured = { stdout: new OutputCapture(this.#captureBytes), stderr: new OutputCapture(this.#captureBytes) };
		const sink = (chunk: OutputChunk) => {
			captured[chunk.stream].append(chunk.text);
			return onOutput?.(chunk);
		};

    let streamed = false;
    const trackedSink = (chunk: OutputChunk) => { streamed = true; return sink(chunk); };
		this.#ledger.dispatch(key);
		let outcome: RunOutcome;
		try {
			outcome = await this.run(request, controller.signal, trackedSink);
		} catch (error) {
			// The process is gone and nothing can say whether it finished: the call stays unknown, and is never replayed.
			outcome = { ok: false, code: "outcome-unknown", message: error instanceof Error ? error.message : String(error) };
		} finally {
			this.#active.delete(key);
		}

		// A command whose complete output went to a spill file lost nothing, so its capture being clipped is not a loss
		// to report. A transport that cannot spill says so instead. Recording both keeps a repeated call's answer
		// identical to the first one's.
    if (outcome.ok && !streamed) {
      if (outcome.stdout) await sink({ stream: "stdout", text: outcome.stdout });
      if (outcome.stderr) await sink({ stream: "stderr", text: outcome.stderr });
    }
		const spillPath = outcome.spillPath;
		const spillUnsupported = outcome.ok && outcome.spillUnsupported ? { spillUnsupported: true as const } : {};
		const clipped = captured.stdout.clipped || captured.stderr.clipped;
		const truncated = clipped && spillPath === undefined ? { truncated: true as const } : {};
		const recorded: LedgerOutcome = outcome.ok
			? { ok: true, exitCode: outcome.exitCode, ...(spillPath === undefined ? {} : { spillPath }), ...spillUnsupported, ...truncated }
			: { ok: false, code: outcome.code, ...(outcome.message === undefined ? {} : { message: outcome.message }), ...(spillPath === undefined ? {} : { spillPath }) };
		const output: LedgerOutput = { stdout: captured.stdout.text(), stderr: captured.stderr.text() };
		this.#ledger.complete(key, recorded, output);

		if (!outcome.ok) return fail(outcome.code, request.callId, outcome.message, spillPath);
		return {
			ok: true,
			gatewayId: this.id,
			workspaceId: request.workspaceId,
			callId: request.callId,
			stdout: output.stdout,
			stderr: output.stderr,
			exitCode: outcome.exitCode,
			...(spillPath === undefined ? {} : { spillPath }),
			...spillUnsupported,
			...truncated,
		};
	}

	/** Stop a call this gateway is running. True when it was running here; an abort of an unknown call is remembered. */
	abort(callId: string): boolean {
		this.#sweepRefusals();
		// An abort names a call ID, which may exist under any workspace on this gateway: stop every match.
		let stopped = false;
		for (const [key, controller] of this.#active) {
			if (key.endsWith("\u0000" + callId)) {
				controller.abort();
				stopped = true;
			}
		}
		if (stopped) return true;
		// Nothing was running under that ID here. Remember the refusal under every workspace this gateway serves, so a
		// request that arrives late is refused instead of started and immediately aborted.
		for (const workspaceId of this.workspaceIds()) this.#refusals.set(this.id + "\u0000" + workspaceId + "\u0000" + callId, Date.now());
		return false;
	}

	/** The workspaces this gateway accepts calls for, used to scope an abort that names only a call ID. */
	protected abstract workspaceIds(): readonly string[];

	async close(): Promise<void> {
    for (const controller of this.#active.values()) controller.abort();
    await Promise.allSettled([...this.#pending]);
		this.#ledger.close();
	}

	#sweepRefusals(): void {
		const now = Date.now();
		for (const [callId, at] of this.#refusals) if (now - at > REFUSAL_TTL_MS) this.#refusals.delete(callId);
	}

	/**
	 * Answer a call the ledger already knows, without running it.
	 *
	 * A call ID that is known but was first used for a different request is refused: the recorded output belongs to
	 * that other request, and handing it back would answer a command nobody ran.
	 */
	#answer(request: ExecuteRequest, known: LedgerEntry, fingerprint: string): ExecuteResult {
		if (known.fingerprint !== fingerprint) {
			return fail("invalid_request", request.callId, "this call ID was already used for a different request");
		}
		if (known.state === "admitted" || known.state === "dispatched") {
			return fail("outcome-unknown", request.callId, "the call is already admitted and may be running");
		}
		const outcome = known.outcome;
		if (outcome === undefined) return fail("outcome-unknown", request.callId, "no recorded outcome for this call");
		return outcome.ok
			? {
					ok: true,
					gatewayId: this.id,
					workspaceId: request.workspaceId,
					callId: request.callId,
					stdout: known.output.stdout,
					stderr: known.output.stderr,
					exitCode: outcome.exitCode,
					...(outcome.spillPath === undefined ? {} : { spillPath: outcome.spillPath }),
					...(outcome.spillUnsupported === true ? { spillUnsupported: true as const } : {}),
					...(outcome.truncated === true ? { truncated: true as const } : {}),
				}
			: fail(outcome.code, request.callId, outcome.message, outcome.spillPath);
	}

	protected abstract validate(request: ExecuteRequest): Promise<ExecuteFailureCode | undefined>;
	/**
	 * Run one admitted call. `stdout` and `stderr` are the complete output when the transport carried it — SSH does,
	 * local execution does not — and are omitted to fall back on what the sink captured.
	 */
	protected abstract run(request: ExecuteRequest, signal: AbortSignal, sink: (chunk: OutputChunk) => void | Promise<void>): Promise<RunOutcome>;

	protected async isAllowedPath(root: string, path: string): Promise<boolean> {
		try {
			await access(path, constants.F_OK);
			return isWithin(root, await realpath(path));
		} catch {
			return isWithin(root, path);
		}
	}
}

export class LocalGateway extends Gateway {
	/** The gateway's shared registry: a workspace registered at runtime is served without a restart. */
	readonly #workspaces: WorkspaceRegistry;
	readonly #allowedCommands: ReadonlySet<string>;

	constructor(options: LocalGatewayOptions, ledger?: ExecutionLedger) {
		super(options.id, options.token, ledger ?? new MemoryLedger(), options.captureBytes ?? DEFAULT_CAPTURE_BYTES);
		this.#workspaces = options.workspaces;
		this.#allowedCommands = new Set(options.allowedCommands);
	}

	protected async validate(request: ExecuteRequest): Promise<ExecuteFailureCode | undefined> {
		if (request.gatewayId !== this.id) return "unknown_gateway";
		const workspace = this.#workspaces.get(request.workspaceId);
		if (workspace === undefined) return "unknown_workspace";
		if (request.callId.trim() === "" || request.command.length === 0) return "invalid_request";
		const root = await realpath(workspace.root);
		const cwd = workspaceCwd(root, request.cwd);
		if (!(await this.isAllowedPath(root, cwd))) return "path_denied";
		if (!this.#allowedCommands.has(commandName(request.command[0]!))) return "command_denied";
		return undefined;
	}

	protected workspaceIds(): readonly string[] {
		return this.#workspaces.ids();
	}

	protected async run(request: ExecuteRequest, signal: AbortSignal, sink: (chunk: OutputChunk) => void | Promise<void>): Promise<RunOutcome> {
		const workspace = this.#workspaces.get(request.workspaceId)!;
		const root = await realpath(workspace.root);
		const env = new NodeExecutionEnv({ cwd: root });
		try {
			const result = await env.exec(
				request.command,
				{
					cwd: workspaceCwd(root, request.cwd),
					timeout: request.timeoutMs === undefined ? undefined : request.timeoutMs / 1000,
					env: request.env,
					inheritEnv: false,
					// `NodeExecutionEnv` does not wait for this callback, so the local path cannot be paced by a slow
					// sink; see the caveat on `OutputSink`. The gateway still writes each chunk through in order.
					onOutput: (text: string, _context: Context, info: ShellOutputInfo) => {
						void sink({ stream: info.stream, text, ...(info.skipped === undefined ? {} : { skipped: info.skipped }) });
					},
					...(request.spill === undefined ? {} : { spill: request.spill }),
					...(request.window === undefined ? {} : { window: request.window }),
				},
				{ ...BACKGROUND_CONTEXT, abortSignal: signal },
			);
			if (!result.ok) {
				const error = result.error as ExecutionError;
				const code: ExecuteFailureCode = error.code === "timeout" ? "timeout" : error.code === "aborted" ? "aborted" : "execution_failed";
				// A command that timed out or was aborted may still have spilled its complete output before it failed.
				return { ok: false, code, message: error.message, ...(error.spillPath === undefined ? {} : { spillPath: error.spillPath }) };
			}
			// The environment spills into its own temp directory, which is not a workspace path, so the path is reported
			// as the gateway-local absolute path it is. Nothing here claims the caller can read it.
			return { ok: true, exitCode: result.value.exitCode, ...(result.value.spillPath === undefined ? {} : { spillPath: result.value.spillPath }) };
		} finally {
			await env.cleanup(BACKGROUND_CONTEXT);
		}
	}
}

export class SshGateway extends Gateway {
	readonly #profiles: ReadonlyMap<string, SshProfile>;
	readonly #workspaces: WorkspaceRegistry;
	readonly #allowedCommands: ReadonlySet<string>;
	readonly #runner: SshRunner;

	constructor(options: SshGatewayOptions, ledger?: ExecutionLedger) {
		super(options.id, options.token, ledger ?? new MemoryLedger(), options.captureBytes ?? DEFAULT_CAPTURE_BYTES);
		this.#profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));
		// The registry seeds every profile under the id the CLI contract already uses, and every runtime registration
		// lands beside it. One lookup resolves an id to its profile and root, so no surface parses an id's spelling.
		this.#workspaces = options.workspaces;
		this.#allowedCommands = new Set(options.allowedCommands);
		this.#runner = options.runner ?? createSystemSshRunner();
	}

	/** The SSH protocol carries text, not files, so a remote spill path cannot be served to the caller. */
	protected async validate(request: ExecuteRequest): Promise<ExecuteFailureCode | undefined> {
		if (request.gatewayId !== this.id) return "unknown_gateway";
		const owner = this.#owner(request.workspaceId);
		if (owner === undefined) return "unknown_workspace";
		if (request.callId.trim() === "" || request.command.length === 0) return "invalid_request";
		if (!isWithin(owner.root, workspaceCwd(owner.root, request.cwd))) return "path_denied";
		if (!this.#allowedCommands.has(commandName(request.command[0]!))) return "command_denied";
		return undefined;
	}

	protected workspaceIds(): readonly string[] {
		return this.#workspaces.ids();
	}

	/**
	 * A spill file would live on the remote host, where the caller cannot read it, so the request's `spill` is ignored:
	 * the output still streams in full and the result reports `spillUnsupported` rather than a path nobody can open.
	 * Refusing the call instead would break `bash`, which always asks for a spill.
	 */
	protected async run(request: ExecuteRequest, signal: AbortSignal, sink: (chunk: OutputChunk) => void | Promise<void>): Promise<RunOutcome> {
		const owner = this.#owner(request.workspaceId)!;
		const profile = owner.profile;
		try {
			// The runner's result carries the complete output; `onOutput` is only the live view of it, so a runner that
			// does not stream still reports its output. The runner pauses its streams while the sink is pending.
			const result = await this.#runner.execute({
				profile: profile.id,
				host: profile.host,
				cwd: workspaceCwd(owner.root, request.cwd),
				root: owner.root,
				port: profile.port,
				identityFile: profile.identityFile,
				knownHostsFile: profile.knownHostsFile,
				env: request.env,
				command: request.command,
				timeoutMs: request.timeoutMs,
				signal,
				onOutput: (chunk) => sink(chunk),
			});
			return { ok: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(request.spill === undefined ? {} : { spillUnsupported: true as const }) };
		} catch (error) {
			return { ok: false, code: mapSshError(error), message: error instanceof Error ? error.message : String(error) };
		}
	}

	#owner(workspaceId: string): { readonly profile: SshProfile; readonly root: string } | undefined {
		return workspaceOwner(this.#workspaces, this.#profiles, workspaceId);
	}
}

/** A gateway's identity and the ledger that decides which calls it may run. */
export class GatewayRpcServer {
	readonly server: Server;
	readonly gateway: LocalGateway | SshGateway;
	/** The filesystem capability this gateway borrows: the JSON file RPC's own, and the payload routes' behind it. */
	readonly #files?: FilesystemServer;
	/** The execution family: the frame stream of one call, and the abort that ends one. */
	readonly #execution: ExecutionTransport;
	/** The file payload routes: one file in or out as a body, over that filesystem. */
	readonly #filePayload: FilePayloadTransport;
	/** The host control family: workspaces, worktrees, the workbench, the JSON file RPC and installations. */
	readonly #control: ControlTransport;
	/** The MCP family: this host's own configuration, servers and sign-ins. */
	readonly #mcpTransport: McpTransport;
	/** The provider family: this account's stored connections, and the sign-ins that outlive a request. */
	readonly #providersTransport: ProviderTransport;
	/** The terminal sessions this gateway holds, when the execution host it serves can open one at all. */
	readonly #terminals?: TerminalSessions;
	/** The terminal surface, over those sessions. */
	readonly #terminal: TerminalTransport;
	/**
	 * The MCP capability this host owns. A gateway serving a remote SSH host serves no MCP: MCP belongs to
	 * the Web host's own account, and in a split deployment that is the local gateway beside the Web
	 * container, not the one the backend reaches over SSH.
	 */
	readonly #mcp?: McpHostService;
	/**
	 * The provider sign-ins this host is running, which {@link close} ends because no host is left to finish them once this
	 * gateway stops. The credential surface beside them needs no disposal of its own: every call of it completes within the
	 * request that carried it.
	 */
	readonly #providerLogins?: ProviderLoginService;
	constructor(gateway: LocalGateway | SshGateway, workbench?: GatewayWorkbench, files?: FilesystemServer, installs?: InstallServer, workspaces?: WorkspaceServer | SshWorkspaceServer, worktrees?: WorktreeServer, terminals?: TerminalSessions, mcp?: McpHostService, providers?: ProviderAuthService, providerLogins?: ProviderLoginService) {
		this.gateway = gateway;
		this.#files = files;
		this.#execution = new ExecutionTransport(gateway);
		this.#filePayload = new FilePayloadTransport(files);
		this.#control = new ControlTransport({ files, installs, workspaces, worktrees, workbench });
		this.#mcpTransport = new McpTransport(mcp);
		this.#providersTransport = new ProviderTransport(providers, providerLogins);
		this.#terminals = terminals;
		this.#terminal = new TerminalTransport(terminals);
		this.#mcp = mcp;
		this.#providerLogins = providerLogins;
		this.server = createServer((request, response) => {
			void this.#handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
				if (!response.writableEnded) response.end(JSON.stringify({ ok: false, code: "execution_failed" }));
			});
		});
	}

	/** Whether this request carries the gateway's own credential; a caller without it is answered here and nowhere else. */
	#admitted(request: IncomingMessage, response: ServerResponse): boolean {
		if (request.headers.authorization === "Bearer " + this.gateway.token) return true;
		writeJson(response, 401, { ok: false, code: "unauthorized" });
		return false;
	}

	/**
	 * Answer one request: recognise whose route it is here, admit it once, and hand it to that family.
	 *
	 * Recognition is the entry's own and it comes first, so an unknown route is a 404 whether or not the caller held a
	 * credential — nothing here serves it either way. The credential is then checked once, before any family reads a body,
	 * so no family can be reached without it. What happens after that belongs to the family the route named: its own
	 * parsing, its own statuses and envelopes, and its own lifetime rule for the work it starts.
	 */
	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = request.url ?? "";
		const method = request.method ?? "";
		const target = new URL(url, "http://gateway");
		const terminal = terminalRoute(url, method);
		// The payload routes carry a file as a body rather than as base64 inside the 1 MiB JSON request the file RPC
		// reads, so they are recognised by the path the query is stripped from.
		const payload = filePayloadRoute(target.pathname, method);
		const execution = executionRoute(url, method);
		const control = controlRoute(url, method);
		const mcp = mcpRoute(url, method);
		const provider = providerRoute(url, method);
		if (terminal === undefined && payload === undefined && execution === undefined && control === undefined && mcp === undefined && provider === undefined) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (!this.#admitted(request, response)) return;
		if (terminal !== undefined) return await this.#terminal.handle(terminal, request, response);
		if (payload !== undefined) return await this.#filePayload.handle(payload, request, response, target);
		if (execution !== undefined) return await this.#execution.handle(execution, request, response);
		if (control !== undefined) return await this.#control.handle(control, request, response);
		if (mcp !== undefined) return await this.#mcpTransport.handle(mcp, request, response);
		return await this.#providersTransport.handle(provider!, request, response);
	}

	async close(): Promise<void> {
		await this.#terminals?.closeAll();
		// A sign-in this host is running has no host left to finish on once this gateway is down, so each flow is ended
		// the way a caller's own cancel would have ended it rather than left to outlive the process that started it.
		this.#providerLogins?.stop();
		await this.#mcp?.close();
		await this.#files?.close();
    this.server.closeAllConnections();
		await this.gateway.close();
		await new Promise<void>((resolveClose) => {
			if (!this.server.listening) resolveClose();
			else this.server.close(() => resolveClose());
		});
	}
}
