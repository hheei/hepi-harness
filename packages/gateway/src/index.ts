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
import type { TerminalSessions } from "./terminal.ts";
import { FilePayloadTransport, filePayloadRoute } from "./transport/file-payload.ts";
import { readJson, writeJson } from "./transport/http.ts";
import { TerminalTransport, terminalRoute } from "./transport/terminal.ts";
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
	/** The filesystem capability this gateway borrows: the JSON file RPC's own, and the payload routes' behind it. */
	readonly #files?: FilesystemServer;
	/** The file payload routes: one file in or out as a body, over that filesystem. */
	readonly #filePayload: FilePayloadTransport;
	readonly #installs?: InstallServer;
	/** The workspace surface this gateway serves: the local one, or an SSH gateway's own remote one. */
	readonly #workspaces?: WorkspaceServer | SshWorkspaceServer;
	/** The worktree surface: the local one, or an SSH gateway's remote one. Absent, the host answers its own limit. */
	readonly #worktrees?: WorktreeServer;
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
	constructor(gateway: LocalGateway | SshGateway, workbench?: GatewayWorkbench, files?: FilesystemServer, installs?: InstallServer, workspaces?: WorkspaceServer | SshWorkspaceServer, worktrees?: WorktreeServer, terminals?: TerminalSessions, mcp?: McpHostService, providers?: ProviderAuthService, providerLogins?: ProviderLoginService) {
		this.gateway = gateway;
		this.#workbench = workbench;
		this.#files = files;
		this.#filePayload = new FilePayloadTransport(files);
		this.#installs = installs;
		this.#workspaces = workspaces;
		this.#worktrees = worktrees;
		this.#terminals = terminals;
		this.#terminal = new TerminalTransport(terminals);
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

	/** Whether this request carries the gateway's own credential; a caller without it is answered here and nowhere else. */
	#admitted(request: IncomingMessage, response: ServerResponse): boolean {
		if (request.headers.authorization === "Bearer " + this.gateway.token) return true;
		writeJson(response, 401, { ok: false, code: "unauthorized" });
		return false;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = request.url ?? "";
		// A transport family recognises its own routes and owns its own framing, and both of them sit behind the same
		// credential: the token is checked here, before a body is read, so no family can be reached without it.
		const terminal = terminalRoute(url, request.method ?? "");
		if (terminal !== undefined) {
			if (!this.#admitted(request, response)) return;
			await this.#terminal.handle(terminal, request, response);
			return;
		}
		// The file payload routes carry a file as a body rather than as base64 inside the 1 MiB JSON request the
		// file RPC reads. They are the same capability and the same token, so they sit beside that route rather than
		// becoming a second file surface.
		const target = new URL(url, "http://gateway");
		const payload = filePayloadRoute(target.pathname, request.method ?? "");
		if (payload !== undefined) {
			if (!this.#admitted(request, response)) return;
			await this.#filePayload.handle(payload, request, response, target);
			return;
		}
		if (request.method !== "POST" || !["/v1/execute", "/v1/workbench", "/v1/files", "/v1/installs", "/v1/abort", "/v1/workspaces", "/v1/worktrees", "/v1/mcp", "/v1/providers/auth", "/v1/providers/login"].includes(url)) {
			response.writeHead(404);
			response.end();
			return;
		}
		if (!this.#admitted(request, response)) return;
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

function validExecuteRequest(value: unknown): value is ExecuteRequest {
  const r = value as ExecuteRequest;
  return !!r && typeof r.gatewayId === "string" && typeof r.workspaceId === "string" && typeof r.callId === "string" && !!r.callId.trim() && Array.isArray(r.command) && r.command.length > 0 && r.command.every(c => typeof c === "string" && !c.includes("\0")) && (r.cwd === undefined || typeof r.cwd === "string") && (r.timeoutMs === undefined || Number.isFinite(r.timeoutMs) && r.timeoutMs >= 0);
}
