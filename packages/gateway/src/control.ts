/**
 * The control capability: the gateway's JSON surfaces that say what a host serves and change part of it — its
 * workspaces, its checkouts, the read-only workbench, its MCP configuration and its installation scopes.
 *
 * Every call is one body in and one declared answer out. The route, the bearer header, the timeout and the
 * classification of a failed or lost response belong to {@link GatewayHostTransport}; the request and answer shapes
 * belong to `@hepi/protocol/gateway` (the installation shapes to this package, which owns that surface). Nothing is
 * declared twice here.
 *
 * Two things stay this capability's business:
 *
 * - A definitive refusal that names one of the surface's own codes is that surface's answer, so it is returned as the
 *   domain result it already is rather than flattened into a transport failure.
 * - A mutation whose answer never arrived is `outcome_unknown`: it may have run on the host, so it is never reported as
 *   a refusal a caller might safely repeat, and it is never sent again.
 */

import { MCP_INVOKE_MAX_DEADLINE_MS, type McpHostRequest, type McpHostResult, type McpInvocationFailureCode, type McpToolCallRequest, type McpToolCallResult, type WorkbenchRequest, type WorkbenchResult, type WorkspaceRequest, type WorkspaceResult, type WorktreeRequest, type WorktreeResult } from "@hepi/protocol/gateway";
import { GatewayHostTransport, HostTransportError, type HostRequestPolicy } from "./host-client.ts";
import { installFailure, type InstallOperation, type InstallResult } from "./install.ts";

/**
 * How long each control route may take when its caller names no limit. They are the bounds the routes already had: a
 * worktree create runs git on the host, an MCP operation may start a server and finish a sign-in, and an installation
 * may publish a directory over SSH.
 */
export const CONTROL_TIMEOUT_MS = {
	workspaces: 10_000,
	worktrees: 5 * 60_000,
	workbench: 20_000,
	mcp: 60_000,
	/** One tool call: the longest deadline a caller may ask for, plus the host's own overhead for the round trip. */
	invoke: MCP_INVOKE_MAX_DEADLINE_MS + 30_000,
	installs: 60_000,
} as const;

/**
 * What one call may change about its own transport: a tighter bound and the caller's own cancellation. `workspaceId`
 * is only read by `installs`, whose route derives its destination from the binding the capability was built with.
 */
export type ControlRequestOptions = { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly workspaceId?: string };

/** The gateway's control surfaces, as one namespace of the host client. */
export type GatewayControl = {
	workspaces(request: WorkspaceRequest, options?: ControlRequestOptions): Promise<WorkspaceResult>;
	worktrees(request: WorktreeRequest, options?: ControlRequestOptions): Promise<WorktreeResult>;
	workbench(request: WorkbenchRequest, options?: ControlRequestOptions): Promise<WorkbenchResult>;
	mcp(request: McpHostRequest, options?: ControlRequestOptions): Promise<McpHostResult>;
	/**
	 * One selected tool of one configured server, run on that host.
	 *
	 * It is separate from {@link GatewayControl.mcp} because its answer is a tool result a conversation records, not a
	 * host setting: the value is the outcome itself rather than an opaque `unknown`, and a call whose answer was lost
	 * is an unknown outcome the caller must never repeat — the host may have acted on it.
	 */
	invoke(request: McpToolCallRequest, options?: ControlRequestOptions): Promise<McpToolCallResult>;
	installs<T = unknown>(request: InstallOperation, options?: ControlRequestOptions): Promise<InstallResult<T>>;
};

/** The codes each surface answers a refusal with, as the shared declaration spells them. */
const WORKSPACE_CODES: ReadonlySet<string> = new Set(["invalid_request", "invalid_workspace_id", "invalid_root", "workspace_conflict", "not_found", "not_a_directory", "permission_denied", "not_supported", "unreachable", "operation_failed"]);
/** Git's own refusals (`dirty`, `main_worktree`) stay named beside the host's, so three answers stay three. */
const WORKTREE_CODES: ReadonlySet<string> = new Set(["invalid_request", "unknown_workspace", "invalid_root", "not_a_worktree", "main_worktree", "dirty", "not_supported", "unreachable", "outcome_unknown", "operation_failed"]);
/** The workbench answers its refusals with a 409, which is still a refusal the caller can act on, not a lost request. */
const WORKBENCH_CODES: ReadonlySet<string> = new Set(["unknown_workspace", "path_denied", "not_found", "operation_failed", "not_supported"]);
/** Any code at all: the MCP surface's refusal vocabulary is the host service's own, not this package's. */
const ANY_CODE: ReadonlySet<string> = { has: () => true } as unknown as ReadonlySet<string>;

/**
 * Which requests change the host. A register, a create, a remove, a write, a sign-in or a publication may have run even
 * when its answer was lost; a listing, a read or a preview cannot.
 */
function workspacesPolicy(request: WorkspaceRequest): HostRequestPolicy {
	return request.operation === "register" ? "mutation" : "read-only";
}

function worktreesPolicy(request: WorktreeRequest): HostRequestPolicy {
	return request.operation === "list" ? "read-only" : "mutation";
}

/**
 * Which installation operations change the host. It matters to the transport's own classification, even though this
 * surface reports every lost call the same way: an inspection and a lock read change nothing, and the three operations
 * that publish, record or rewrite must never be read as a repetition a caller could safely retry.
 */
function installsPolicy(request: InstallOperation): HostRequestPolicy {
	return request.operation === "inspectDirectory" || request.operation === "readLock" ? "read-only" : "mutation";
}

/**
 * Which MCP operations write. Reading configuration, checking a folder's trust, polling a sign-in that is already
 * running and testing a server change nothing a repetition could duplicate; writing, patching and every sign-in
 * transition do.
 */
const MCP_MUTATIONS: ReadonlySet<string> = new Set(["write", "patch", "sign-in", "sign-in-paste", "sign-in-cancel", "sign-out", "invoke"]);

/** A refusal turned back into its surface's own result, given the code and status the gateway answered with. */
type RefusalTo<T> = (code: string, status: number) => T;

/** One control call: the transport, the request, and what this surface answers with. */
type ControlCall<T> = {
	readonly route: string;
	readonly body: unknown;
	readonly policy: HostRequestPolicy;
	readonly timeoutMs: number;
	readonly options?: ControlRequestOptions;
	/** Reads a success body. A body this surface does not accept throws, which the transport reports as a protocol error. */
	readonly decode: (value: unknown) => T;
	/** The refusal this surface knows by code, or nothing when any refusal stays a transport failure. */
	readonly refuse?: { readonly codes: ReadonlySet<string>; readonly to: RefusalTo<T> };
};

/** One answer whose `ok` decides the shape and whose `value` carries the operation's own result. */
function domainAnswer<T>(value: unknown, codes: ReadonlySet<string>): T {
	const answer = value as { ok?: unknown; code?: unknown; value?: unknown } | null;
	if (answer !== null && typeof answer === "object" && answer.ok === true && "value" in answer) return answer as T;
	if (answer !== null && typeof answer === "object" && answer.ok === false && typeof answer.code === "string" && codes.has(answer.code)) return answer as T;
	throw new Error("the gateway answered with a body this operation does not accept");
}

/**
 * The control namespace of one transport, plus the workspace its installation surface belongs to. Callers reach it
 * through the composite client, which composes every capability over one transport.
 */
export function controlCapability(transport: GatewayHostTransport, options: { readonly workspaceId?: string } = {}): GatewayControl {
	const boundWorkspace = options.workspaceId;

	const call = async <T>(one: ControlCall<T>): Promise<T> => {
		try {
			return await transport.json({
				path: one.route,
				body: one.body,
				policy: one.policy,
				timeoutMs: one.options?.timeoutMs ?? one.timeoutMs,
				...(one.options?.signal === undefined ? {} : { signal: one.options.signal }),
				decode: one.decode,
			});
		} catch (error) {
			// A refusal the gateway actually sent is the surface's answer, not an unknown outcome: nothing may have run.
			const code = error instanceof HostTransportError && error.code === "operation_failed" ? error.gatewayCode : undefined;
			if (code !== undefined && one.refuse !== undefined && one.refuse.codes.has(code)) return one.refuse.to(code, error instanceof HostTransportError ? error.status ?? 0 : 0);
			throw error;
		}
	};

	const control: GatewayControl = {
		workspaces: (request, options) =>
			call({
				route: "/v1/workspaces",
				body: request,
				policy: workspacesPolicy(request),
				timeoutMs: CONTROL_TIMEOUT_MS.workspaces,
				options,
				decode: (value) => domainAnswer<WorkspaceResult>(value, WORKSPACE_CODES),
				refuse: { codes: WORKSPACE_CODES, to: (code) => ({ ok: false, code }) as WorkspaceResult },
			}),
		worktrees: (request, options) =>
			call({
				route: "/v1/worktrees",
				body: request,
				policy: worktreesPolicy(request),
				timeoutMs: CONTROL_TIMEOUT_MS.worktrees,
				options,
				decode: (value) => domainAnswer<WorktreeResult>(value, WORKTREE_CODES),
				// A refusal keeps its own name — `dirty`, `main_worktree`, `not_supported` — so a caller can tell git's
				// judgement from a host that cannot do this at all. A lost answer is never one of these.
				refuse: { codes: WORKTREE_CODES, to: (code) => ({ ok: false, code }) as WorktreeResult },
			}),
		workbench: (request, options) =>
			call({
				route: "/v1/workbench",
				body: request,
				// Every workbench operation reads: a preview, a listing, a diff and a file's text change nothing.
				policy: "read-only",
				timeoutMs: CONTROL_TIMEOUT_MS.workbench,
				options,
				decode: (value) => domainAnswer<WorkbenchResult>(value, WORKBENCH_CODES),
				refuse: { codes: WORKBENCH_CODES, to: (code) => ({ ok: false, code }) as WorkbenchResult },
			}),
		mcp: (request, options) =>
			call({
				route: "/v1/mcp",
				body: request,
				policy: MCP_MUTATIONS.has(request.operation) ? "mutation" : "read-only",
				timeoutMs: CONTROL_TIMEOUT_MS.mcp,
				options,
				decode: (value) => {
					const answer = value as { ok?: unknown; code?: unknown; message?: unknown } | null;
					if (answer !== null && typeof answer === "object" && answer.ok === true) return answer as McpHostResult;
					if (answer !== null && typeof answer === "object" && answer.ok === false && typeof answer.code === "string" && typeof answer.message === "string") return answer as McpHostResult;
					throw new Error("the gateway answered with a body this operation does not accept");
				},
				// The MCP surface's refusal vocabulary is the host service's own, so a refusal it names is passed through
				// as the panel's answer — with the wire code and the status it came with, never invented.
				refuse: { codes: ANY_CODE, to: (code, status) => ({ ok: false, code, message: "the MCP host service refused this request with " + status }) as McpHostResult },
			}),
		invoke: (request, options) =>
			call({
				route: "/v1/mcp",
				body: request,
				// A tool call can have external side effects, so a lost answer is an unknown outcome: the transport
				// reports it as one and nothing here sends the call again.
				policy: "mutation",
				timeoutMs: CONTROL_TIMEOUT_MS.invoke,
				options,
				decode: (value) => {
					const answer = value as { ok?: unknown; code?: unknown; message?: unknown; value?: unknown } | null;
					if (answer !== null && typeof answer === "object" && answer.ok === true) {
						const outcome = answer.value as { callId?: unknown; content?: unknown } | null;
						if (outcome === null || typeof outcome !== "object" || typeof outcome.callId !== "string" || !Array.isArray(outcome.content)) throw new Error("the gateway answered an invocation with a body this call does not accept");
						return answer as McpToolCallResult;
					}
					if (answer !== null && typeof answer === "object" && answer.ok === false && typeof answer.code === "string" && typeof answer.message === "string") return answer as McpToolCallResult;
					throw new Error("the gateway answered an invocation with a body this call does not accept");
				},
				// The invocation's refusal vocabulary is the host service's own, so a refusal it names is passed through
				// as the answer a caller records — with the code it came with, never invented.
				refuse: { codes: ANY_CODE, to: (code, status) => ({ ok: false, code: code as McpInvocationFailureCode, message: "the MCP host service refused this invocation with " + status }) },
			}),
		installs: async (request, options) => {
			const workspaceId = options?.workspaceId ?? boundWorkspace;
			if (workspaceId === undefined || workspaceId === "") throw new HostTransportError("protocol_error", "no workspace is bound, so an installation has no destination to name");
			try {
				const answer = await call<InstallResult<unknown>>({
					route: "/v1/installs",
					body: { ...request, workspaceId },
					policy: installsPolicy(request),
					timeoutMs: CONTROL_TIMEOUT_MS.installs,
					options,
					decode: (value) => {
						const answer = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } } | null;
						if (answer !== null && typeof answer === "object" && answer.ok === true) return answer as InstallResult<unknown>;
						if (answer !== null && typeof answer === "object" && answer.ok === false && typeof answer.error?.code === "string" && typeof answer.error.message === "string") return answer as InstallResult<unknown>;
						throw new Error("the gateway answered with a body this operation does not accept");
					},
				});
				// The wire carries the operation's own value, which only the caller knows the shape of: the cast is this
				// surface's, exactly as the install route has always spelled it per operation, and it adds no assertion
				// about the host.
				return answer as InstallResult<never>;
			} catch (error) {
				// An installation is never replayed. A refusal the gateway actually sent — a refusal, an unauthorized
				// answer — is a known failure, spelled as this surface always spelled it; anything else — a timeout, a
				// lost connection, a body that broke — may have published, so it is an unknown outcome.
				if (error instanceof HostTransportError && error.status !== undefined) return installFailure("unknown", "the gateway refused the installation request: " + error.status);
				return installFailure("outcome_unknown", "the gateway installation outcome is unknown; nothing was replayed");
			}
		},
	};
	return control;
}
