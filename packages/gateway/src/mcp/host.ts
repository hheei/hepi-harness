import { randomUUID } from "node:crypto";
import { McpOAuthAuthorizationRequiredError, McpOAuthProvider, authorizeMcp } from "@earendil-works/pi-mcp/oauth";
import type { McpHostRequest, McpHostResult, McpSignInFlowInfo, McpSignInPhase, McpTestResult, McpTestState } from "@hepi/protocol/gateway";
import { editMcpConfig, oauthUrlOf, patchMcpServer, readMcpConfig, readProjectTrust, readServerConfig, validateServerConfig, type McpScope } from "./config.ts";
import { CANCELLED_BEFORE_STORE, McpAuthStore, connectServer, fetchWithHeaders, message, redactorFor, redirectUrlOf, resolveConnectionValues, storeUnlessCancelled, type Redactor, type ServerTarget } from "./connection.ts";
import { invokeTool, type InvocationHost } from "./invocation.ts";
import { listServerTools, type ListingHost } from "./listing.ts";
import type { WorkspaceRegistry } from "../workspaces.ts";

// The request and answer shapes of `/v1/mcp` belong to the wire, so they are declared once in
// `@hepi/protocol/gateway` and re-exported here under the names this package has always exported. The CLI's own paste
// outcome below stays this service's: it is not a shape the route answers with.
export type { McpHostRequest, McpHostResult, McpSignInFlowInfo, McpSignInPhase, McpTestResult, McpTestState, McpToolDescriptor, McpToolList, McpToolListFailureCode, McpToolListRequest, McpToolListResult } from "@hepi/protocol/gateway";

/**
 * The MCP host capability of the Web host service: it starts a configured server, reports what it
 * found, and runs an OAuth sign-in against the server's authorization server. It is the host's own
 * account and filesystem that own all of this — the durable backend is not an MCP participant and
 * never receives a credential.
 *
 * The request and response shapes are upstream's (a test's outcome, a sign-in's phases, a masked
 * failure reason), and the credentials live in the host's `mcp-auth.json` under the keys the pi CLI
 * on the same host uses, so one account per server serves both.
 *
 * Sign-in is the paste flow, not a loopback callback: the browser runs on the user's computer, which
 * is not this host, so the redirected address is handed back to the host rather than received by it.
 * That is exactly what upstream's own panel does when its callback is unreachable.
 */

/** The outcome of handing one redirected address to a waiting sign-in, as the CLI's own paste callback reports it. */
export type McpSignInPaste = { readonly ok: true; readonly flow: McpSignInFlowInfo } | { readonly ok: false; readonly code: "sign-in-unknown" | "sign-in-not-waiting" | "redirect-invalid" | "redirect-state-mismatch" | "redirect-no-code" | "redirect-denied"; readonly message: string; readonly flow?: McpSignInFlowInfo };

/** How long a test may take end to end. */
export const MCP_TEST_DEADLINE_MS = 30_000;
/** How long a sign-in keeps waiting for the redirected address, as upstream's own flow does. */
export const MCP_SIGN_IN_TTL_MS = 5 * 60_000;
/** How long an ended sign-in stays readable, so a poll that arrives late still learns the outcome. */
const MCP_SIGN_IN_KEEP_MS = 60_000;
const MCP_SIGN_IN_MAX_FLOWS = 100;
const MCP_SIGN_IN_MAX_PASTE_CHARS = 16 * 1024;

/** One connection attempt: connect, list the tools, and close it again whatever happened. */
async function connectAndList(target: ServerTarget, auth: McpAuthStore | undefined, redactor: Redactor, signal: AbortSignal): Promise<McpTestResult> {
	const started = Date.now();
	const opened = await connectServer(target, auth, redactor, signal);
	if (!opened.ok) {
		const needsAuth = opened.error instanceof McpOAuthAuthorizationRequiredError;
		return {
			state: needsAuth ? "needs-auth" : "failed",
			error: redactor.redact(message(opened.error)),
			...(opened.stderr === "" ? {} : { stderr: redactor.redact(opened.stderr).slice(-2000) }),
			durationMs: Date.now() - started,
			testedAt: Date.now(),
		};
	}
	const connection = opened.connection;
	try {
		const tools = await connection.client.listTools({ signal });
		const info = connection.client.serverInfo;
		return {
			state: "connected",
			toolCount: tools.length,
			...(info === undefined ? {} : { serverInfo: { name: info.name, version: info.version } }),
			durationMs: Date.now() - started,
			testedAt: Date.now(),
		};
	} catch (error) {
		const stderr = connection.stderr();
		const needsAuth = error instanceof McpOAuthAuthorizationRequiredError;
		return {
			state: needsAuth ? "needs-auth" : "failed",
			error: redactor.redact(message(error)),
			...(stderr === "" ? {} : { stderr: redactor.redact(stderr).slice(-2000) }),
			durationMs: Date.now() - started,
			testedAt: Date.now(),
		};
	} finally {
		await connection.close();
	}
}

type Flow = {
	readonly flowId: string;
	readonly name: string;
	readonly url: string;
	readonly scope: McpScope;
	/** The folder a project-scoped sign-in belongs to: its entry is read from that folder's own file. */
	readonly cwd?: string;
	phase: McpSignInPhase;
	authorizationUrl?: string;
	redirectUrl?: string;
	readonly provider: McpOAuthProvider;
	readonly redactor: Redactor;
	state?: string;
	expiresAt: number;
	result?: McpTestResult;
	error?: string;
};

/**
 * The MCP capability one Web host service serves. Its account is the execution account of the host
 * it runs on, so configuration, credentials and every server process stay on that machine.
 */
export class McpHostService {
	readonly #agentDir: string;
	readonly #flows = new Map<string, Flow>();
	/** The folders this host serves. Absent serves none, which refuses every workspace-scoped request by name. */
	readonly #workspaces: WorkspaceRegistry | undefined;
	/** The tool calls this host is running, by call identity and conversation, so the bound is this host own count. */
	readonly #calls = new Set<string>();
	/** The calls in flight, so stopping the service waits for them rather than leaving a server running. */
	readonly #inFlight = new Set<Promise<unknown>>();
	/** Aborted when this service stops: a call still running ends with the service that started it. */
	readonly #stopping = new AbortController();

	constructor(agentDir: string, workspaces?: WorkspaceRegistry) {
		this.#agentDir = agentDir;
		this.#workspaces = workspaces;
	}

	/**
	 * One operation, and the caller's own abort.
	 *
	 * The signal is the request's, not this service's: when the caller goes away — a revoked credential, a closed
	 * socket — the work this operation started ends with it, and nothing it produced is stored afterwards.
	 */
	async execute(request: McpHostRequest, signal?: AbortSignal): Promise<McpHostResult> {
		const folder = this.#folder(request);
		if (!folder.ok) return folder;
		request = folder.request;
		try {
			switch (request.operation) {
				case "read":
					return { ok: true, value: this.#read(request.cwd) };
				case "trust": {
					// A trust decision is about a folder: a request that names none is refused here rather than read as the
					// host's own account.
					const cwd = request.cwd;
					if (cwd === undefined) return { ok: false, code: "invalid_request", message: "a trust read names a folder: cwd or workspaceId" };
					return { ok: true, value: readProjectTrust(cwd, this.#agentDir) };
				}
				case "write":
					return this.#write(request);
				case "patch":
					return this.#patch(request);
				case "test":
					return await this.#test(request, signal);
				case "tools": {
					// A listing is held here as a call is: stopping this service means nothing it started is still running,
					// and a listing that opened a server is exactly such a thing.
					const read = this.#tools(request, signal);
					this.#inFlight.add(read);
					try {
						return await read;
					} finally {
						this.#inFlight.delete(read);
					}
				}
				case "sign-in":
					return await this.#signIn(request, signal);
				case "sign-in-poll":
					return this.#poll(request.flowId);
				case "sign-in-paste":
					return await this.#paste(request.flowId, request.redirectUrl, signal);
				case "sign-in-cancel":
					return this.#cancel(request.flowId);
				case "sign-out":
					return this.#signOut(request);
				case "invoke": {
					// An invocation is not a host setting: it runs one already-selected tool and answers with its result.
					// It is the one operation whose answer a conversation records, so it is a shape of its own, and the
					// call is held here so a stopping service can wait for it instead of leaving a server running.
					const call = invokeTool(this.#invocationHost(request), request, signal);
					this.#inFlight.add(call);
					try {
						return await call;
					} finally {
						this.#inFlight.delete(call);
					}
				}
				default:
					return { ok: false, code: "invalid_request", message: "unknown MCP host operation" };
			}
		} catch (error) {
			return { ok: false, code: "operation_failed", message: message(error) };
		}
	}

	/**
	 * The folder a request names, as this host resolves it.
	 *
	 * A caller that already resolved a path names it (`cwd`, which the Backend's control surface sends); a client that
	 * only knows the browser's routing address names the workspace id, and it is resolved here, against the folders this
	 * host serves — so no caller synthesizes a path on this machine, and a folder of another host is refused by name
	 * instead of being read as a path this host happens to have. A request that names both is resolved by id: the id is
	 * what this host owns, and the path a client sent is not allowed to override it.
	 */
	#folder(request: McpHostRequest): { readonly ok: true; readonly request: McpHostRequest } | { readonly ok: false; readonly code: string; readonly message: string } {
		if (!("workspaceId" in request)) return { ok: true, request };
		const { workspaceId, ...rest } = request;
		if (workspaceId === undefined) return { ok: true, request };
		const workspace = this.#workspaces?.get(workspaceId);
		if (workspace === undefined) return { ok: false, code: "unknown-workspace", message: "this host serves no folder " + workspaceId };
		return { ok: true, request: { ...rest, cwd: workspace.root } as McpHostRequest };
	}

	/**
	 * What the listing capability needs from this host: the same one configured server entry a test and a call resolve,
	 * the account directory its credentials live in, and this service's own stopping signal.
	 *
	 * Like invocation, it names no capability beyond reading the entry: a listing cannot connect a server this host does
	 * not have configured, and a request that carried a `config` or a command would have nothing to say to this method.
	 */
	#listingHost(request: Extract<McpHostRequest, { operation: "tools" }>): ListingHost {
		return {
			agentDir: this.#agentDir,
			server: (name, cwd) => {
				const target = this.#target(request.scope, cwd, name);
				return "refusal" in target ? { refusal: target.refusal, message: target.message } : target;
			},
			stopping: this.#stopping.signal,
		};
	}

	/**
	 * What the invocation capability needs from this host: the entry of one configured server, resolved exactly as a
	 * test resolves it, and the account directory its credentials live in.
	 *
	 * An invocation never names a configuration, so this is the only door between the wire request and the file: the
	 * server name is looked up in the folder's own file, validated, and refused by name when it is missing, invalid or
	 * switched off. A request that carried a `config` or a command would have nothing to say to this method.
	 */
	#invocationHost(request: Extract<McpHostRequest, { operation: "invoke" }>): InvocationHost {
		return {
			agentDir: this.#agentDir,
			server: (name: string, cwd: string | undefined) => {
				const target = this.#target(request.scope, cwd, name);
				return "refusal" in target ? { refusal: target.refusal, message: target.message } : target;
			},
			running: this.#calls,
			stopping: this.#stopping.signal,
		};
	}

	/**
	 * Stop this service: cancel every flow, end every running tool call, and wait for the connections those calls opened
	 * to close, so a stopping host leaves no server process and no socket behind. Waiting is what makes the promise
	 * mean "nothing this service started is still running" rather than "a cancellation was requested".
	 */
	async close(): Promise<void> {
		for (const flow of this.#flows.values()) flow.phase = "cancelled";
		this.#flows.clear();
		this.#stopping.abort();
		await Promise.allSettled([...this.#inFlight]);
	}

	#read(cwd: string | undefined): unknown {
		return readMcpConfig({ agentDir: this.#agentDir, ...(cwd === undefined ? {} : { cwd }) });
	}

	#write(request: Extract<McpHostRequest, { operation: "write" }>): McpHostResult {
		const outcome = editMcpConfig({ agentDir: this.#agentDir, scope: request.scope, ...(request.cwd === undefined ? {} : { cwd: request.cwd }), name: request.name, ...(request.config === undefined ? {} : { config: request.config }), ...(request.requireNew === undefined ? {} : { requireNew: request.requireNew }) });
		if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, path: outcome.path };
		// The answer is the listing after the change, so a caller shows the host's real state without a second read.
		return { ok: true, value: readMcpConfig({ agentDir: this.#agentDir, ...(request.scope === "project" && request.cwd !== undefined ? { cwd: request.cwd } : {}) }) };
	}

	/** A change to named keys of one entry, answered with the listing after it, as a write is. */
	#patch(request: Extract<McpHostRequest, { operation: "patch" }>): McpHostResult {
		const outcome = patchMcpServer({ agentDir: this.#agentDir, scope: request.scope, ...(request.cwd === undefined ? {} : { cwd: request.cwd }), name: request.name, patch: request.patch });
		if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message, path: outcome.path };
		return { ok: true, value: readMcpConfig({ agentDir: this.#agentDir, ...(request.scope === "project" && request.cwd !== undefined ? { cwd: request.cwd } : {}) }) };
	}

	async #test(request: Extract<McpHostRequest, { operation: "test" }>, signal?: AbortSignal): Promise<McpHostResult> {
		const target = this.#target(request.scope, request.cwd, request.name);
		if ("refusal" in target) return { ok: false, code: target.refusal, message: target.message };
		const redactor = redactorFor(target.config);
		// A stdio server has no OAuth account, so the store is only built for a server that has a URL.
		const url = typeof target.config.url === "string" ? target.config.url : undefined;
		const auth = url === undefined ? undefined : new McpAuthStore(this.#agentDir, target.name, url);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), MCP_TEST_DEADLINE_MS);
		// The deadline is this operation's own; the caller's abort is the caller's. Either one ends the connection, so
		// the server a test started is closed by a revoked credential exactly as it is by the test running too long.
		const deadline = signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
		try {
			return { ok: true, value: await connectAndList(target, auth, redactor, deadline) };
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * One configured server's tools, as that server answers.
	 *
	 * It is the sibling of #test and shares its whole shape — the entry door, the masking, the deadline composed with the
	 * caller's abort, the connection closed whatever happened — and differs in one thing only: what a test keeps of a
	 * listing (a count) is what this answers with, bounded. A listing is a deliberate act by a person who wants to see one
	 * server's tools, never a side effect of reading the host's settings, which is why read (#read) still answers from the
	 * files alone and starts nothing.
	 */
	async #tools(request: Extract<McpHostRequest, { operation: "tools" }>, signal?: AbortSignal): Promise<McpHostResult> {
		const answer = await listServerTools(this.#listingHost(request), request, signal);
		return answer.ok ? { ok: true, value: answer.value } : { ok: false, code: answer.code, message: answer.message };
	}

	async #signIn(request: Extract<McpHostRequest, { operation: "sign-in" }>, signal?: AbortSignal): Promise<McpHostResult> {
		this.#sweep();
		const target = this.#target(request.scope, request.cwd, request.name);
		if ("refusal" in target) return { ok: false, code: target.refusal, message: target.message };
		const url = oauthUrlOf(target.config);
		if (url === undefined) return { ok: false, code: "sign-in-not-oauth", message: `server "${target.name}" does not sign in with OAuth: it is a stdio server, sends a provider token, or sets an Authorization header` };
		// A server already holding tokens needs no sign-in; the answer says so instead of starting a flow.
		const auth = new McpAuthStore(this.#agentDir, target.name, url);
		if (auth.load()?.tokens !== undefined) {
			return { ok: true, value: { flowId: randomUUID(), scope: target.scope, name: target.name, phase: "done", alreadySignedIn: true, expiresInMs: 0 } satisfies McpSignInFlowInfo };
		}
		const existing = [...this.#flows.values()].find((flow) => flow.phase === "authorize" && flow.name === target.name && flow.url === url);
		if (existing !== undefined) return { ok: true, value: this.#info(existing) };

		const redactor = redactorFor(target.config);
		const redirectUrl = redirectUrlOf(target.config);
		// The caller's abort reaches the resolution, so a sign-in whose caller has gone away does not wait out a slow
		// `!command` header value before finding out.
		const { headers } = await resolveConnectionValues(target.config, redactor, signal);
		let authorizationUrl: string | undefined;
		const provider = new McpOAuthProvider({
			serverUrl: url,
			redirectUrl,
			clientMetadata: { client_name: "hepi Web host", redirect_uris: [redirectUrl] },
			...(typeof target.config.oauth === "object" && target.config.oauth !== null && typeof (target.config.oauth as Record<string, unknown>).clientId === "string" ? { clientId: (target.config.oauth as Record<string, unknown>).clientId as string } : {}),
			store: { load: () => auth.load(), save: (state) => storeUnlessCancelled(auth, state, signal) },
			onRedirect: (value) => { authorizationUrl = String(value); },
		});
		const flow: Flow = { flowId: randomUUID(), name: target.name, url, scope: target.scope, ...(target.cwd === undefined ? {} : { cwd: target.cwd }), phase: "authorize", provider, redactor, expiresAt: Date.now() + MCP_SIGN_IN_TTL_MS };
		try {
			const outcome = await authorizeMcp(provider, { serverUrl: url, fetch: fetchWithHeaders(headers), ...(signal === undefined ? {} : { signal }) });
			if (outcome === "AUTHORIZED") {
				flow.phase = "done";
				flow.result = await connectAndList(target, auth, redactor, AbortSignal.timeout(MCP_TEST_DEADLINE_MS));
			} else {
				if (authorizationUrl === undefined) throw new Error("the OAuth flow produced no authorization URL");
				flow.authorizationUrl = authorizationUrl;
				flow.redirectUrl = redirectUrl;
				flow.state = await provider.state();
			}
		} catch (error) {
			this.#settle(flow, error, signal, redactor);
		}
		if (flow.phase === "authorize") this.#remember(flow);
		return { ok: true, value: this.#info(flow) };
	}

	#poll(flowId: string): McpHostResult {
		this.#sweep();
		const flow = this.#flows.get(flowId);
		if (flow === undefined) return { ok: false, code: "sign-in-unknown", message: "no sign-in has that id: it ended over a minute ago, or the host service restarted" };
		return { ok: true, value: this.#info(flow) };
	}

	async #paste(flowId: string, redirectUrl: unknown, signal?: AbortSignal): Promise<McpHostResult> {
		this.#sweep();
		const flow = this.#flows.get(flowId);
		if (flow === undefined) return { ok: false, code: "sign-in-unknown", message: "no sign-in has that id: it ended over a minute ago, or the host service restarted" };
		if (flow.phase !== "authorize") return { ok: false, code: "sign-in-not-waiting", message: "the sign-in is not waiting for a redirected address", flow: this.#info(flow) };
		if (typeof redirectUrl !== "string" || redirectUrl.length > MCP_SIGN_IN_MAX_PASTE_CHARS) return { ok: false, code: "redirect-invalid", message: "the pasted text is not a URL", flow: this.#info(flow) };
		let parsed: URL;
		try {
			parsed = new URL(redirectUrl.trim());
		} catch {
			return { ok: false, code: "redirect-invalid", message: "the pasted text is not a URL", flow: this.#info(flow) };
		}
		const denied = parsed.searchParams.get("error");
		if (denied !== null) {
			const description = parsed.searchParams.get("error_description");
			return { ok: false, code: "redirect-denied", message: flow.redactor.redact(description ?? denied), flow: this.#info(flow) };
		}
		if (parsed.searchParams.get("state") !== flow.state) return { ok: false, code: "redirect-state-mismatch", message: "the pasted URL's state is not this sign-in's", flow: this.#info(flow) };
		const code = parsed.searchParams.get("code");
		if (code === null || code === "") return { ok: false, code: "redirect-no-code", message: "the pasted URL carries no authorization code", flow: this.#info(flow) };
		flow.phase = "finishing";
		const target = this.#target(flow.scope, flow.cwd, flow.name);
		const iss = parsed.searchParams.get("iss") ?? undefined;
		try {
			await authorizeMcp(flow.provider, { serverUrl: flow.url, authorizationCode: code, ...(iss === undefined ? {} : { iss }), ...(signal === undefined ? {} : { signal }) });
			flow.phase = "done";
			if (!("refusal" in target)) flow.result = await connectAndList(target, new McpAuthStore(this.#agentDir, flow.name, flow.url), flow.redactor, AbortSignal.timeout(MCP_TEST_DEADLINE_MS));
		} catch (error) {
			this.#settle(flow, error, signal, flow.redactor);
		}
		this.#remember(flow);
		return { ok: true, value: this.#info(flow) };
	}

	/**
	 * How a flow ends when its exchange did not finish: a failure the caller can read, or — when the caller itself is
	 * gone — a cancellation whose outcome is unknown, because the provider may have completed what this host refused to
	 * store. The two are not the same answer, and the second is not reported as the first.
	 */
	#settle(flow: Flow, error: unknown, signal: AbortSignal | undefined, redactor: Redactor): void {
		if (signal?.aborted === true) {
			flow.phase = "cancelled";
			flow.error = CANCELLED_BEFORE_STORE;
			return;
		}
		flow.phase = "failed";
		flow.error = redactor.redact(message(error)).slice(0, 2000);
	}

	#cancel(flowId: string): McpHostResult {
		this.#sweep();
		const flow = this.#flows.get(flowId);
		if (flow === undefined) return { ok: false, code: "sign-in-unknown", message: "no sign-in has that id: it ended over a minute ago, or the host service restarted" };
		flow.phase = "cancelled";
		flow.expiresAt = Date.now() + MCP_SIGN_IN_KEEP_MS;
		return { ok: true, value: this.#info(flow) };
	}

	#signOut(request: Extract<McpHostRequest, { operation: "sign-out" }>): McpHostResult {
		const target = this.#target(request.scope, request.cwd, request.name);
		if ("refusal" in target) return { ok: false, code: target.refusal, message: target.message };
		const url = oauthUrlOf(target.config);
		if (url === undefined) return { ok: false, code: "sign-in-not-oauth", message: `server "${target.name}" does not sign in with OAuth` };
		for (const flow of this.#flows.values()) if (flow.name === target.name && flow.url === url) flow.phase = "cancelled";
		const removed = new McpAuthStore(this.#agentDir, target.name, url).remove();
		return { ok: true, value: { scope: target.scope, name: target.name, removed } };
	}

	/**
	 * One configured server, as this host resolves it for use.
	 *
	 * A project entry is read only for a folder whose own trust store trusts it, which is the same gate the host's
	 * resource loader applies and the one a project write passes: a decision is about the folder's content, and a
	 * project `mcp.json` is trust-requiring content. Without this, an entry behind an untrusted folder would be
	 * startable — and, through an invocation, callable — while the loader that serves a conversation would never read
	 * it, which is exactly the state the write gate exists to prevent.
	 */
	#target(scope: McpScope, cwd: string | undefined, name: string): ServerTarget | { readonly refusal: string; readonly message: string } {
		if (scope === "project") {
			if (cwd === undefined || cwd === "") return { refusal: "project-untrusted", message: "a project scope names the folder it applies to" };
			const trust = readProjectTrust(cwd, this.#agentDir);
			if (trust.error !== undefined) return { refusal: "trust-unreadable", message: trust.error };
			if (!trust.trusted) {
				const recorded = trust.decision === false ? `${trust.decisionPath ?? cwd} is recorded as not trusted` : `${cwd} has no trust decision`;
				return { refusal: "project-untrusted", message: `${recorded}, so its .pi/mcp.json is not used` };
			}
		}
		const found = readServerConfig({ agentDir: this.#agentDir, scope, ...(cwd === undefined ? {} : { cwd }), name });
		if ("refusal" in found) return { refusal: found.refusal, message: found.message };
		const validation = validateServerConfig(name, found.config);
		if (typeof validation === "string") return { refusal: "server-invalid", message: validation };
		return { name, config: found.config, scope, ...(cwd === undefined ? {} : { cwd }), agentDir: this.#agentDir };
	}

	#remember(flow: Flow): void {
		if (this.#flows.size >= MCP_SIGN_IN_MAX_FLOWS) {
			const oldest = [...this.#flows.values()].sort((left, right) => left.expiresAt - right.expiresAt)[0];
			if (oldest !== undefined) this.#flows.delete(oldest.flowId);
		}
		this.#flows.set(flow.flowId, flow);
	}

	/** Drop flows whose keep window passed, and mark a flow still waiting past its limit as expired. */
	#sweep(): void {
		const now = Date.now();
		for (const [flowId, flow] of this.#flows) {
			if (flow.phase === "authorize" && now > flow.expiresAt) flow.phase = "expired";
			if (flow.phase !== "authorize" && now > flow.expiresAt + MCP_SIGN_IN_KEEP_MS) this.#flows.delete(flowId);
		}
	}

	#info(flow: Flow): McpSignInFlowInfo {
		return {
			flowId: flow.flowId,
			scope: flow.scope,
			name: flow.name,
			phase: flow.phase,
			...(flow.authorizationUrl === undefined ? {} : { authorizationUrl: flow.authorizationUrl }),
			...(flow.redirectUrl === undefined ? {} : { redirectUrl: flow.redirectUrl }),
			expiresInMs: flow.phase === "authorize" ? Math.max(0, flow.expiresAt - Date.now()) : 0,
			...(flow.result === undefined ? {} : { result: flow.result }),
			...(flow.error === undefined ? {} : { error: flow.error }),
		};
	}
}
