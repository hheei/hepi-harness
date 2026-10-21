import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionError, ShellOutputInfo } from "@earendil-works/pi-durable/env";
import { GatewayFiles, resolveWorkspacePath } from "./filesystem.ts";
import { DOWNLOAD_CHUNK_BYTES, hostFailure, inspectUpload, openDownload, parseUploadConflict, uploadFile, type Download, type UploadConflict } from "./file-transfer.ts";
// The upload conflict vocabulary is part of the file surface's wire contract: a caller of the capability names one of
// these strategies, and a relay that reads the browser's query names it the same way instead of casting a string.
export { parseUploadConflict, UPLOAD_CONFLICT_STRATEGIES } from "./file-transfer.ts";
export type { UploadConflictStrategy } from "./file-transfer.ts";
import { gatewayEnvironment } from "./environment.ts";
import {
	GatewayExecutionJournal,
	MemoryLedger,
	OutputCapture,
	encodeFrame,
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
import { TerminalSessions, TERMINAL_RECONNECT_MS, TERMINAL_REPLAY_CHARS, TERMINAL_HEARTBEAT_FRAME, TERMINAL_STREAM_BUDGET_BYTES, type TerminalEvent, type TerminalExit, type TerminalFanInEvent, type TerminalOpenRequest, type TerminalReplay } from "./terminal.ts";
import { installFailure, type InstallRequest, type InstallServer } from "./install.ts";
import { GatewayWorkbench, type WorkbenchRequest } from "./workbench/index.ts";
import type { WorktreeRequest, WorktreeServer } from "./worktrees.ts";
import { workspaceOwner, WorkspaceRegistry, type WorkspaceRequest, type WorkspaceServer } from "./workspaces.ts";
import type { SshWorkspaceServer } from "./ssh-workspaces.ts";
import { agentDirOf } from "./mcp/config.ts";
import { McpHostService, type McpHostRequest, type McpHostResult } from "./mcp/host.ts";
import type { ProviderAuthRequest, ProviderAuthResult, ProviderAuthService } from "./provider-auth.ts";
import type { ProviderLoginRequest, ProviderLoginResult } from "@hepi/protocol/gateway";
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
	readonly #workbench?: GatewayWorkbench;
	readonly #files?: GatewayFiles;
	readonly #installs?: InstallServer;
	/** The workspace surface this gateway serves: the local one, or an SSH gateway's own remote one. */
	readonly #workspaces?: WorkspaceServer | SshWorkspaceServer;
	/** The worktree surface: the local one, or an SSH gateway's remote one. Absent, the host answers its own limit. */
	readonly #worktrees?: WorktreeServer;
	/** The terminal sessions this gateway holds, when the execution host it serves can open one at all. */
	readonly #terminals?: TerminalSessions;
	/**
	 * The MCP capability this host owns. A gateway serving a remote SSH host serves no MCP: MCP belongs to
	 * the Web host's own account, and in a split deployment that is the local gateway beside the Web
	 * container, not the one the backend reaches over SSH.
	 */
	readonly #mcp?: McpHostService;
	/**
	 * The provider connection surface this host owns. An SSH gateway serves none: the credentials a person manages here
	 * belong to the account whose `auth.json` the Web host's own gateway writes, and that is the host the Web process runs
	 * beside rather than the machine it reaches over SSH.
	 */
	readonly #providers?: ProviderAuthService;
	/**
	 * The provider sign-ins this host is running. It shares the credential file and the agent directory with
	 * {@link #providers} and is composed beside it, so a gateway that serves no provider accounts serves no sign-ins either.
	 */
	readonly #providerLogins?: ProviderLoginService;
	constructor(gateway: LocalGateway | SshGateway, workbench?: GatewayWorkbench, files?: GatewayFiles, installs?: InstallServer, workspaces?: WorkspaceServer | SshWorkspaceServer, worktrees?: WorktreeServer, terminals?: TerminalSessions, mcp?: McpHostService, providers?: ProviderAuthService, providerLogins?: ProviderLoginService) {
		this.gateway = gateway;
		this.#workbench = workbench;
		this.#files = files;
		this.#installs = installs;
		this.#workspaces = workspaces;
		this.#worktrees = worktrees;
		this.#terminals = terminals;
		this.#mcp = mcp;
		this.#providers = providers;
		this.#providerLogins = providerLogins;
		this.server = createServer((request, response) => {
			void this.#handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
				if (!response.writableEnded) response.end(JSON.stringify({ ok: false, code: "execution_failed" }));
			});
		});
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = request.url ?? "";
		const terminal = terminalRoute(url, request.method ?? "");
		if (terminal !== undefined) {
			if (request.headers.authorization !== "Bearer " + this.gateway.token) {
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, code: "unauthorized" }));
				return;
			}
			await this.#terminal(terminal, request, response);
			return;
		}
		// The file payload routes carry a file as a body rather than as base64 inside the 1 MiB JSON request the
		// file RPC reads. They are the same capability and the same token, so they sit beside that route rather than
		// becoming a second file surface.
		const payload = filePayloadRoute(new URL(url, "http://gateway").pathname, request.method ?? "");
		if (payload !== undefined) {
			if (request.headers.authorization !== "Bearer " + this.gateway.token) {
				response.writeHead(401, { "content-type": "application/json" });
				response.end(JSON.stringify({ ok: false, code: "unauthorized" }));
				return;
			}
			await this.#filePayload(payload, request, response, new URL(url, "http://gateway"));
			return;
		}
		if (request.method !== "POST" || !["/v1/execute", "/v1/workbench", "/v1/files", "/v1/installs", "/v1/abort", "/v1/workspaces", "/v1/worktrees", "/v1/mcp", "/v1/providers/auth", "/v1/providers/login"].includes(url)) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (request.headers.authorization !== "Bearer " + this.gateway.token) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: false, code: "unauthorized" }));
			return;
		}
		const body = await readJson(request);
    if (!body || typeof body !== "object" || (request.url === "/v1/execute" && !validExecuteRequest(body)) || ((request.url === "/v1/workspaces" || request.url === "/v1/worktrees" || request.url === "/v1/mcp" || request.url === "/v1/providers/auth" || request.url === "/v1/providers/login") && typeof (body as {operation?: unknown}).operation !== "string") || (request.url === "/v1/abort" && (typeof (body as {callId?: unknown}).callId !== "string" || !(body as {callId: string}).callId.trim()))) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, code: "invalid_request" })); return;
    }
		if (request.url === "/v1/execute") {
			await this.#execute(request, body as ExecuteRequest, response);
			return;
		}
		if (request.url === "/v1/abort") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: this.gateway.abort((body as { callId: string }).callId) }));
			return;
		}
		// MCP is the host's own capability, beside execution and files: it reads and writes this account's
		// MCP configuration, starts a configured server to report what it found, and signs in to one. A
		// gateway that serves no MCP answers the named limit instead of a generic refusal, so the surface
		// can say the host cannot serve it while every other setting keeps working.
		if (request.url === "/v1/mcp") {
			// A caller that goes away ends the operation it asked for: the ingress aborts its own call on a revoked
			// credential or a disconnected client, and this is where that reaches the work it started — a server being
			// started, or a sign-in mid-exchange — so nothing keeps running, and nothing keeps writing, after the caller
			// that asked for it is gone.
			const controller = new AbortController();
			response.on("close", () => { if (!response.writableEnded) controller.abort(); });
			const result: McpHostResult = this.#mcp === undefined
				? { ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" }
				: await this.#mcp.execute(body as McpHostRequest, controller.signal);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
			return;
		}
		// Provider connection state is the execution host's own, beside MCP: the credential file belongs to the account this
		// gateway runs as. The answer is a listing after the change — never the value that was written — so nothing here can
		// be read back into a caller's hands.
		if (request.url === "/v1/providers/auth") {
			const result: ProviderAuthResult = this.#providers === undefined
				? { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider-auth capability" }
				: await this.#providers.execute(body as ProviderAuthRequest);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
			return;
		}
		// A provider sign-in is the host's own work with a life of its own: the flow runs here while the person finishes in
		// another browser, so an operation on an open flow is not ended by the request that carried it — its deadline, an
		// explicit cancel, or this gateway stopping are. A start whose caller vanished during the create is cancelled by the
		// service itself, because nobody holds its id.
		if (request.url === "/v1/providers/login") {
			const result: ProviderLoginResult = this.#providerLogins === undefined
				? { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider sign-in capability" }
				: await this.#providerLogins.execute(body as ProviderLoginRequest);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
			return;
		}
		// Workspace management is its own narrow surface: which roots this gateway serves, and the host's own
		// directories to choose one from. It is not the file RPC and grants no access to any of those directories.
		if (request.url === "/v1/workspaces") {
			const result = await this.#workspaces?.execute(body as WorkspaceRequest) ?? { ok: false, code: "operation_failed" };
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
			return;
		}
		// Worktrees are a host capability of their own: which checkouts a registered root has, one created on a branch,
		// and one removed. A gateway with no worktree surface answers the host's own named limit rather than a generic
		// failure, so a caller can tell "this host cannot do that" from "that request was wrong".
		if (request.url === "/v1/worktrees") {
			const result = await this.#worktrees?.execute(body as WorktreeRequest) ?? { ok: false, code: "not_supported", message: "this host cannot serve worktree operations" };
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
			return;
		}
		// The read-only workbench reads on the host that really holds the workspace, so a caller that goes away leaves no
		// reason for that read to keep running: this is where the disconnect reaches the work it started — the remote Git
		// command, or the listing's walk — and ends it, exactly as the MCP route ends a server it was starting. The route
		// then answers the refusal itself, since a cancelled call has no caller left to write to; a refused path keeps the
		// workbench's own 409 and code, which is what the caller's classification reads.
		if (request.url === "/v1/workbench") {
			const controller = new AbortController();
			response.on("close", () => { if (!response.writableEnded) controller.abort(); });
			const answered = await this.#workbench?.execute(body as WorkbenchRequest, { signal: controller.signal }) ?? { ok: false, code: "not_supported" };
			if (response.writableEnded || response.destroyed) return;
			response.writeHead(answered.ok ? 200 : 409, { "content-type": "application/json" });
			response.end(JSON.stringify(answered));
			return;
		}
		// The installation capability is not the general file RPC: it publishes whole directories into one installation
		// scope and stores the scope lock, and it never accepts a caller-chosen destination path.
		const result = request.url === "/v1/files"
			? await this.#files?.execute(body as never) ?? { ok: false }
			: await this.#installs?.execute(body as InstallRequest) ?? installFailure("not_supported", "installation is not enabled on this gateway");
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify(result, (_key, value) => (value instanceof Error ? { code: (value as Error & { code?: string }).code, message: value.message } : value)));
	}

	/**
	 * One file in, or one file out, as a body.
	 *
	 * An upload is written to a host-created temporary file and renamed over its target only once the whole body
	 * arrived, so a refused or interrupted upload leaves no partial file; the conflict rules and the 16 MiB ceiling are
	 * the file surface's own. A download is read in bounded chunks through the host's reader handle, and the handle is
	 * closed whether the range was served or the caller went away first.
	 */
	async #filePayload(route: FilePayloadRoute, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		const files = this.#files;
		if (files === undefined) { json(404, { ok: false, code: "unknown_workspace", message: "this gateway serves no filesystem" }); return; }
		const workspaceId = url.searchParams.get("workspaceId") ?? "";
		if (workspaceId === "") { json(400, { ok: false, code: "invalid_request", message: "a request names the workspace it is about" }); return; }

		if (route === "upload-check") {
			const body = await readJson(request) as { path?: unknown; names?: unknown } | undefined;
			if (typeof body?.path !== "string" || !Array.isArray(body.names) || body.names.some((name) => typeof name !== "string")) {
				json(400, { ok: false, code: "invalid_request", message: "a check names the directory and the file names" });
				return;
			}
			const inspected = await inspectUpload(files, workspaceId, body.path, body.names as string[]);
			if (!inspected.ok) { json(payloadStatus(inspected.error.code), { ok: false, ...hostFailure(inspected.error, body.path) }); return; }
			json(200, { ok: true, value: inspected.value });
			return;
		}

		const path = url.searchParams.get("path") ?? "";
		if (path === "") { json(400, { ok: false, code: "invalid_request", message: "a request names the file it is about" }); return; }

		if (route === "upload") {
			const strategy = parseUploadConflict(url.searchParams.get("conflict"));
			if (strategy === null) { json(400, { ok: false, code: "invalid_request", message: "conflict names one of error, overwrite or skip" }); return; }
			const result = await uploadFile(files, workspaceId, path, strategy, request);
			if (result.ok) { json(200, { ok: true, value: result.value }); return; }
			const conflict = (result as { conflict?: UploadConflict }).conflict;
			// The host's own code and status answer; its words are put in workspace terms, because a failure it found on
			// its own disk would otherwise state where this workspace lives on that host.
			json(payloadStatus(result.error.code), { ok: false, ...hostFailure(result.error, path), ...(conflict ?? {}) });
			return;
		}

		const opened = await openDownload(files, workspaceId, path, request.headers.range ?? null);
		if (!opened.ok) { json(payloadStatus(opened.error.code), { ok: false, ...hostFailure(opened.error, path) }); return; }
		await this.#streamFile(files, workspaceId, opened.value, response);
	}

	/** The opened range, written as it is read: one bounded chunk at a time, and the host's reader closed either way. */
	async #streamFile(files: GatewayFiles, workspaceId: string, download: Download, response: ServerResponse): Promise<void> {
		const partial = download.length !== download.size;
		response.writeHead(partial ? 206 : 200, {
			"content-type": "application/octet-stream",
			"content-length": String(download.length),
			"accept-ranges": "bytes",
			...(partial ? { "content-range": "bytes " + download.offset + "-" + (download.offset + download.length - 1) + "/" + download.size } : {}),
		});
		let gone = false;
		const cancelled = () => { gone = true; };
		response.on("close", cancelled);
		let offset = download.offset;
		let remaining = download.length;
		try {
			while (remaining > 0 && !gone && !response.writableEnded) {
				const read = await files.execute({ workspaceId, method: "reader.read", handle: download.handle, offset, length: Math.min(remaining, DOWNLOAD_CHUNK_BYTES) }) as { ok: true; value: string } | { ok: false; error: { code: string; message: string } };
				// The status and length are already sent, so a host read that fails here ends the body rather than
				// answering something else: the caller reads a short body, never a wrong one.
				if (!read.ok) break;
				const chunk = Buffer.from(read.value, "base64");
				if (chunk.byteLength === 0) break;
				offset += chunk.byteLength;
				remaining -= chunk.byteLength;
				if (!response.write(chunk)) await drained(response);
			}
		} finally {
			response.off("close", cancelled);
			await files.execute({ workspaceId, method: "reader.close", handle: download.handle }).catch(() => undefined);
			if (!response.writableEnded && !response.destroyed) response.end();
		}
	}

	/** Stream one call: output frames as they arrive, then the single result frame that ends the response. */
	async #execute(incoming: IncomingMessage, request: ExecuteRequest, response: ServerResponse): Promise<void> {
		const write = async (frame: ExecuteFrame) => {
      if (response.writableEnded || response.destroyed) return;
      const encoded = encodeFrame(frame);
      if (response.writableLength + Buffer.byteLength(encoded) > 1024 * 1024) { response.destroy(); return; }
      if (!response.write(encoded)) await new Promise<void>(resolve => {
        const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
        response.once("drain", done); response.once("close", done);
      });
    };
		response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", "transfer-encoding": "chunked" });
		let clientGone = false;
		response.on("close", () => {
			// A client that stops listening does not stop the call: nothing says whether it ran, so the ledger keeps it.
			if (!response.writableEnded) clientGone = true;
		});
		const result = await this.gateway.execute(request, (chunk) => {
			return write({ type: "output", stream: chunk.stream, text: chunk.text, ...(chunk.skipped === undefined ? {} : { skipped: chunk.skipped }) });
		});
		if (!clientGone) await write({ type: "result", result });
		response.end();
	}

	/**
	 * The terminal surface: open a session, stream its output, send input, apply a resize and close it.
	 *
	 * A gateway whose execution host serves no terminal answers `not_supported` and names the limit, and an unknown
	 * session answers `unknown_terminal`. Output travels as server-sent events, so a caller that lost its connection
	 * can attach again. Nothing about a session is written to a conversation's transcript, because a session belongs to
	 * no conversation.
	 */
	async #terminal(route: TerminalRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const sessions = this.#terminals;
		if (sessions === undefined) {
			response.writeHead(501, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: false, code: "not_supported", message: "this gateway has no terminal capability: its execution host is not configured to serve one" }));
			return;
		}
		const json = (status: number, body: unknown) => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};
		if (route.kind === "open") {
			const body = await readJson(request);
			const open = body as Partial<TerminalOpenRequest> | undefined;
			if (open === null || typeof open !== "object" || typeof open.gatewayId !== "string" || typeof open.workspaceId !== "string" || typeof open.cols !== "number" || typeof open.rows !== "number" || (open.cwd !== undefined && typeof open.cwd !== "string") || (open.id !== undefined && typeof open.id !== "string")) {
				json(400, { ok: false, code: "invalid_request" });
				return;
			}
			const result = await sessions.open(open as TerminalOpenRequest);
			json(result.ok ? 200 : 409, result);
			return;
		}
		if (route.kind === "describe") {
			json(200, sessions.describe(route.id));
			return;
		}
		if (route.kind === "events") {
			await this.#terminalEvents(route.id, sessions, request, response, terminalCursor(request.url ?? "", request.headers["last-event-id"]));
			return;
		}
		if (route.kind === "fanIn") {
			await this.#terminalFanIn(sessions, request, response, terminalFanInCursors(request.url ?? ""));
			return;
		}
		if (route.kind === "close") {
			json(200, await sessions.close(route.id));
			return;
		}
		const body = await readJson(request);
		const command = body as { data?: unknown; cols?: unknown; rows?: unknown } | undefined;
		if (route.kind === "input") {
			if (command === null || typeof command !== "object" || typeof command.data !== "string") {
				json(400, { ok: false, code: "invalid_request" });
				return;
			}
			json(200, sessions.write(route.id, command.data));
			return;
		}
		if (command === null || typeof command !== "object" || typeof command.cols !== "number" || typeof command.rows !== "number") {
			json(400, { ok: false, code: "invalid_request" });
			return;
		}
		json(200, sessions.resize(route.id, command.cols, command.rows));
	}

	/**
	 * The page's one terminal stream: every mounted tab's frames, on one connection.
	 *
	 * A browser allows six connections per origin, and one stream per mounted tab spends them on terminals — including
	 * the tabs of a panel that is closed, because a mounted tab's shell has to stay attached. This carries the same
	 * session facts on one connection instead: each frame names its session, and each session's attachment is held for
	 * exactly as long as the caller names it, so a mounted tab keeps its shell and a closed tab releases it, which is
	 * the lease behaviour the per-session stream already had.
	 *
	 * The caller names its sessions and their cursors. Nothing is enumerated here: attaching to every session this
	 * gateway runs would hold shells no caller asked about open past their reconnect window, including another page's.
	 */
	async #terminalFanIn(sessions: TerminalSessions, request: IncomingMessage, response: ServerResponse, tabs: readonly { id: string; after?: number }[]): Promise<void> {
		const attachments: { unsubscribe(): void }[] = [];
		const replays: { id: string; replay: TerminalReplay; exit?: TerminalExit }[] = [];
		// The attachments are taken before a byte is written and each one names the tab's own frames, so the replay and
		// every later event are one ordered stream: a subscriber's listener is synchronous, so nothing can arrive
		// between the two.
		for (const tab of tabs) {
			const subscription = sessions.subscribe(tab.id, (event) => {
				// One tab's exit ends that tab's frames and nothing else: this stream carries every mounted tab, so it
				// stays open for the tabs still running and is ended by its caller going away, never by one session's
				// exit. Ending it here would make a page whose tabs have all exited reconnect on every retry.
				if (event.type === "output") this.#writeTerminalFrame(response, tab.id + ":" + event.offset, { type: "output", id: tab.id, data: event.data, offset: event.offset, ...(event.reset === undefined ? {} : { reset: event.reset }) } satisfies TerminalFanInEvent);
				else this.#writeTerminalFrame(response, "", { type: "exit", id: tab.id, exitCode: event.exitCode, signal: event.signal } satisfies TerminalFanInEvent);
			}, tab.after);
			// A session this gateway does not know is not an error for the stream: the caller named several, and the tab
			// that has no session is answered by its own describe read rather than by failing every other tab with it.
			if (subscription === undefined) continue;
			attachments.push(subscription);
			// What the caller missed arrives before anything new, and the offset it should continue from is the replay's
			// own, exactly as the per-session stream reports it.
			replays.push({ id: tab.id, replay: subscription.replay, ...(subscription.exit === undefined ? {} : { exit: subscription.exit }) });
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		// The head is flushed rather than left to the first frame: a stream that named no session this gateway runs has no
		// frame to write, and without the flush a caller would wait on a status that never arrives instead of reading a
		// stream it can decide about.
		response.flushHeaders();
		for (const { id, replay } of replays) {
			if (replay.data !== "" || replay.reset) this.#writeTerminalFrame(response, id + ":" + replay.offset, { type: "output", id, data: replay.data, offset: replay.offset, reset: replay.reset } satisfies TerminalFanInEvent);
		}
		for (const { id, exit } of replays) {
			if (exit === undefined) continue;
			this.#writeTerminalFrame(response, "", { type: "exit", id, exitCode: exit.exitCode, signal: exit.signal } satisfies TerminalFanInEvent);
		}
		// The cadence belongs to the sessions this stream actually holds: a stream that named only sessions this gateway
		// does not run holds nothing, so it has nothing to keep alive and arms nothing. It stays open — the caller named
		// its tabs and a refusal here would fail the tabs that do exist — and is ended by the caller going away.
		await this.#holdTerminalStream(response, request, attachments.length > 0 ? sessions.heartbeatIntervalMs : 0, () => { for (const attachment of attachments) attachment.unsubscribe(); });
	}

	/**
	 * One session's event stream: output as the host produces it, then exactly one exit frame that ends the response.
	 *
	 * A caller that names a session this gateway does not know is refused before the stream opens, so a reconnecting
	 * client gets a status it can act on rather than an empty stream. A session that has already ended delivers its
	 * exit at once, so nothing waits for an event that will never come.
	 */
	async #terminalEvents(id: string, sessions: TerminalSessions, request: IncomingMessage, response: ServerResponse, after: number | undefined): Promise<void> {
		// The attachment is taken before a byte is written, so the replay and every later event are one ordered stream:
		// a subscriber's listener is synchronous, so nothing can arrive between the two.
		const subscription = sessions.subscribe(id, (event) => {
			this.#writeTerminalFrame(response, event.type === "output" ? String(event.offset) : "", event);
			// The session's own exit is the end of its stream: the caller reads the frame that ends it rather than
			// waiting for an event that will never come.
			if (event.type === "exit") response.end();
		}, after);
		// A caller that names a session this gateway does not know is refused before the stream opens, so a reconnecting
		// client gets a status it can act on rather than an empty stream.
		if (subscription === undefined) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: false, code: "unknown_terminal" }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		response.flushHeaders();
		// The replay is the first thing a caller sees, so what it missed arrives before anything new, and its own
		// cursor travels in the event's id: a client that reconnects with Last-Event-ID continues from there.
		if (subscription.replay.data !== "" || subscription.replay.reset) {
			this.#writeTerminalFrame(response, String(subscription.replay.offset), { type: "output", data: subscription.replay.data, offset: subscription.replay.offset, reset: subscription.replay.reset } satisfies TerminalEvent);
		}
		// A session that has already ended delivers its exit at once, and the stream is over with it.
		if (subscription.exit !== undefined) {
			this.#writeTerminalFrame(response, "", subscription.exit);
			subscription.unsubscribe();
			response.end();
			return;
		}
		await this.#holdTerminalStream(response, request, sessions.heartbeatIntervalMs, () => subscription.unsubscribe());
	}

	/**
	 * Keep a terminal stream open for as long as its caller is there, and let go of every attachment exactly once.
	 *
	 * The keepalive is written on the sessions' own cadence through the same writer as every other terminal byte, so a
	 * comment frame lands on a frame boundary this stream owns and is measured against the same byte budget. A cadence
	 * of zero states no keepalive: a gateway with no idle bound in front of it writes nothing rather than arming a timer
	 * whose whole purpose is a bound that is not there. A request that ends and a response that closes are the same fact
	 * here — the caller is gone — and either one releases the attachments, so a dropped connection leaves no
	 * subscription behind and no timer armed.
	 */
	async #holdTerminalStream(response: ServerResponse, request: IncomingMessage, cadence: number, detach: () => void): Promise<void> {
		const keepalive = cadence > 0 ? setInterval(() => this.#writeTerminalComment(response), cadence) : null;
		keepalive?.unref();
		try {
			await new Promise<void>((resolve) => {
				request.once("close", resolve);
				response.once("close", resolve);
			});
		} finally {
			if (keepalive !== null) clearInterval(keepalive);
			detach();
			if (!response.writableEnded && !response.destroyed) response.end();
		}
	}

	/**
	 * One frame of a terminal stream, written by the single place that owns the shape and the byte budget.
	 *
	 * The field name is `id`, with nothing before the colon: a leading space would make the field name `" id"`, which
	 * no client recognises, so a browser would never record a cursor and every automatic reconnect would arrive with no
	 * `Last-Event-ID` and be answered with the retained tail and a reset. An empty cursor writes no id field at all,
	 * which is what an exit frame needs.
	 *
	 * The frame is encoded once and measured against what this connection has not yet taken. A subscriber's listener is
	 * synchronous and returns nothing, so the producer cannot be paced: ending the consumer is the only bounded answer,
	 * and the caller reconnects with the cursor it read. The shell and every other reader are untouched by it.
	 *
	 * The rule is "already behind", not "would go over": a frame is written unless this connection is *already* holding
	 * more than its budget. That is what keeps a frame the unit of progress. A rule that refused a frame for crossing
	 * the budget would refuse the very first frame of an attach whose replay is larger than the budget, the caller would
	 * have read nothing, and its reconnect would be answered with the same replay and the same refusal — a reconnect
	 * loop caused by the bound itself. With this rule every attempt delivers at least one whole frame, so the caller's
	 * cursors advance and a reconnect converges; what stays bounded is the *pending* bytes, which are the budget plus at
	 * most the one frame being written.
	 */
	#writeTerminalFrame(response: ServerResponse, cursor: string, event: unknown): void {
		this.#writeTerminalBytes(response, (cursor === "" ? "" : "id: " + cursor + "\n") + "data: " + JSON.stringify(event) + "\n\n");
	}

	/**
	 * The stream's keepalive: bytes with no event, on its own frame boundary, and measured like every other frame.
	 *
	 * A terminal is quiet between keystrokes, and a transport that bounds an idle body would tear the stream down and
	 * make the panel reconnect — which it answers with a reset. A comment frame defeats that bound without moving the
	 * caller's cursor: an `id:` line here would be read as an output offset and would move every tab's reconnect
	 * position to a place no output exists.
	 */
	#writeTerminalComment(response: ServerResponse): void {
		this.#writeTerminalBytes(response, TERMINAL_HEARTBEAT_FRAME);
	}

	/** One write of a terminal stream's bytes, under the one budget every terminal byte is measured against. */
	#writeTerminalBytes(response: ServerResponse, bytes: string): void {
		if (response.writableEnded || response.destroyed) return;
		if (response.writableLength > (this.#terminals?.streamBudgetBytes ?? TERMINAL_STREAM_BUDGET_BYTES)) {
			// The consumer is not reading and cannot be paced: more than its budget is already unwritten, so nothing
			// here would reach it anyway. The connection ends — the socket is what holds those bytes, so ending the
			// response alone would leave them queued on a socket nobody is going to read — and the session does not, so
			// the caller reconnects with the cursor it read and is answered from the session's own retained tail.
			(response.socket ?? response).destroy();
			return;
		}
		response.write(bytes);
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

type TerminalRoute = { readonly kind: "open" } | { readonly kind: "fanIn" } | { readonly kind: "describe" | "events" | "input" | "resize" | "close"; readonly id: string };

/** The file payload routes: one file in as a body, one file out as a body. */
type FilePayloadRoute = "upload" | "upload-check" | "bytes";

/** The file payload route this request names, or undefined when it names none of them. */
function filePayloadRoute(path: string, method: string): FilePayloadRoute | undefined {
	if (path === "/v1/files/upload") return method === "POST" ? "upload" : undefined;
	if (path === "/v1/files/upload-check") return method === "POST" ? "upload-check" : undefined;
	if (path === "/v1/files/bytes") return method === "GET" ? "bytes" : undefined;
	return undefined;
}

/** The HTTP status one file payload failure keeps: the caller reads the host's own code and reason. */
/**
 * Wait until a response can take another write, or until it is over.
 *
 * A caller that goes away mid-body is the state a download spends its time in, and its close may already have fired by
 * the time a write reports backpressure. Checking the state first is what makes this a wait that always ends: a
 * promise waiting for a `close` that already happened is a host reader nobody ever releases.
 */
function drained(response: ServerResponse): Promise<void> {
	if (response.writableEnded || response.destroyed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
		response.once("drain", done);
		response.once("close", done);
	});
}

function payloadStatus(code: string): number {
	switch (code) {
		case "invalid_request": return 400;
		case "unknown_workspace": case "unknown_directory": case "not_found": case "not_a_file": return 404;
		case "permission_denied": return 403;
		case "conflict": case "not_replaceable": return 409;
		case "file_too_large": return 413;
		case "invalid_range": return 400;
		case "unsatisfiable_range": return 416;
		case "not_supported": return 501;
		default: return 500;
	}
}

/** The terminal routes this gateway answers, or undefined when the request names none of them. */
function terminalRoute(url: string, method: string): TerminalRoute | undefined {
	const path = url.split("?", 1)[0] ?? "";
	if (path === "/v1/terminal") return method === "POST" ? { kind: "open" } : undefined;
	// The page's one terminal stream. It carries every mounted tab's frames, so it is a route of its own rather than a
	// session's: a session id in this position would read as one tab's stream and answer the wrong shape.
	if (path === "/v1/terminal/events") return method === "GET" ? { kind: "fanIn" } : undefined;
	if (!path.startsWith("/v1/terminal/")) return undefined;
	const segments = path.slice("/v1/terminal/".length).split("/");
	const id = decodeURIComponent(segments[0] ?? "");
	if (id === "") return undefined;
	if (segments.length === 1) return method === "DELETE" ? { kind: "close", id } : method === "GET" ? { kind: "describe", id } : undefined;
	if (segments.length !== 2) return undefined;
	if (segments[1] === "events") return method === "GET" ? { kind: "events", id } : undefined;
	if (method !== "POST") return undefined;
	if (segments[1] === "input") return { kind: "input", id };
	if (segments[1] === "resize") return { kind: "resize", id };
	return undefined;
}

/**
 * The output offset an event stream continues from: the standard `Last-Event-ID` a reconnecting client sends, or the
 * `after` query a client names itself. An absent or unusable cursor is no cursor, which asks for the retained tail.
 */
function terminalCursor(url: string, lastEventId?: string | string[]): number | undefined {
	const query = url.indexOf("?");
	const named = query === -1 ? null : new URLSearchParams(url.slice(query + 1)).get("after");
	// The header wins: it is the browser's own record of the last event it actually received, while `after` is the
	// cursor the client named when it first attached. A reconnecting EventSource sends both, and the newer one is right.
	const cursor = (typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : named) ?? undefined;
	if (cursor === null || cursor === undefined || cursor === "" || !Number.isFinite(Number(cursor))) return undefined;
	return Number(cursor);
}

/**
 * The sessions a fan-in caller names, with the cursor it holds for each: `tabs=<id>:<after>,<id>:<after>`.
 *
 * The cursors are the caller's own record of what it received per tab, so a reconnect continues each tab exactly where
 * it left off. A tab named with no cursor, or with one that is not a number, asks for that session's retained tail and
 * is answered with `reset`, which is what the per-session stream does with an absent or unusable cursor.
 */
function terminalFanInCursors(url: string): { id: string; after?: number }[] {
	const query = url.indexOf("?");
	if (query === -1) return [];
	const named = new URLSearchParams(url.slice(query + 1)).get("tabs");
	if (named === null || named === "") return [];
	const tabs: { id: string; after?: number }[] = [];
	for (const entry of named.split(",")) {
		const separator = entry.indexOf(":");
		const id = decodeURIComponent(separator === -1 ? entry : entry.slice(0, separator));
		if (id === "") continue;
		const after = separator === -1 ? "" : entry.slice(separator + 1);
		tabs.push({ id, ...(after === "" || !Number.isFinite(Number(after)) ? {} : { after: Number(after) }) });
	}
	return tabs;
}

function validExecuteRequest(value: unknown): value is ExecuteRequest {
  const r = value as ExecuteRequest;
  return !!r && typeof r.gatewayId === "string" && typeof r.workspaceId === "string" && typeof r.callId === "string" && !!r.callId.trim() && Array.isArray(r.command) && r.command.length > 0 && r.command.every(c => typeof c === "string" && !c.includes("\0")) && (r.cwd === undefined || typeof r.cwd === "string") && (r.timeoutMs === undefined || Number.isFinite(r.timeoutMs) && r.timeoutMs >= 0);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; if (bytes > 1024 * 1024) return undefined; chunks.push(chunk as Buffer); }
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}
