import type { ProviderAuthRequest, ProviderAuthStatus, ProviderLoginRequest } from "@hepi/protocol/gateway";

/**
 * Provider connection state on the client ingress.
 *
 * These routes are not the Backend's and are not forwarded to it: the credential file belongs to the account of the host
 * this origin runs on, so the ingress answers them itself by reaching that host's authenticated
 * `POST /v1/providers/auth`. A raw API key therefore travels from the caller to this listener and on to the one host that
 * owns the file, and no further — the durable Backend receives no credential and serves no route for one. A deployment
 * that configures no host service answers a named limit (`provider_auth_unavailable`) while every other route keeps
 * working, exactly as the MCP surface does.
 *
 * A caller still needs an identity: these routes are answered after the ingress admitted one, and a device bearer is
 * re-verified while the request is in flight, so a revoked credential ends a credential write the same way it ends any
 * other request.
 *
 * What this surface answers is presence, credential type and the hint the host masked — never a stored value, and never
 * the value a caller wrote. A successful mutation restates the listing it produced, so the panel shows the state that
 * really holds without reading back what it sent.
 *
 * Provider *sign-in* is served here too, because it is the same account on the same host. A flow runs there while the
 * person finishes in another browser, so these routes relay to that host's `POST /v1/providers/login` and answer the
 * flow's state: the question it is asking, the address it wants opened, and the listing after it stored something. The
 * flow's lifetime is the host's and not this socket's — a page that reloads, or a browser that closes, must not end a
 * sign-in nobody cancelled — which is why this surface is polled rather than streamed: a stream would make a reconnect
 * look like a cancelled login, and a detached browser flow has no socket that could mean anything else. A caller that
 * loses its address reads its open flow back by provider (`GET /api/auth/login/<providerId>`) and resumes it.
 *
 * A sign-in answer never carries a credential: what a person typed into a prompt stays in the provider's hands, and what
 * the flow produced goes into the host's file. Both are masked out of every message this surface can pass along.
 */

/** Why the provider surface cannot be served here, named rather than refused generically. */
export const PROVIDER_AUTH_UNAVAILABLE_ERROR = "No provider host service is configured for this client origin: set HEPI_INGRESS_MCP_GATEWAY_URL and HEPI_INGRESS_MCP_GATEWAY_TOKEN to the gateway whose account holds this host's provider credentials";

/** How long one host call may take: a listing asks each provider to resolve its own credential. */
const PROVIDER_HOST_TIMEOUT_MS = 30_000;

/** The longest answer a sign-in request may carry: a code or a pasted redirect address, never a document. */
const MAX_LOGIN_ANSWER_CHARS = 8_192;

/** How a caller names the flow it means, on a route that already names the provider. */
const FLOW_QUERY = "flow";

/**
 * One host answer, widened past the gateway's own refusal codes.
 *
 * The gateway's `ProviderAuthResult` names what its service could not do; this surface adds the transport facts — no host
 * is configured, the host could not be reached, the host refused this origin's credential — which are the same shape and
 * are the difference between a panel saying "not served by this deployment" and saying "this host could not be reached".
 */
type ProviderHostAnswer =
	| { readonly ok: true; readonly value: readonly ProviderAuthStatus[] }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * One host sign-in answer.
 *
 * `value` stays the host's own JSON: a flow's state is rendered by the panel that follows it, and this surface invents no
 * projection of a provider's prompt — the one thing it must not do is decide what a flow is asking.
 */
type ProviderLoginHostAnswer =
	| { readonly ok: true; readonly value: Record<string, unknown> }
	| { readonly ok: false; readonly code: string; readonly message: string };

/** One admitted provider request, as the ingress read it. */
export type ProviderIngressRequest = {
	readonly method: string;
	readonly search: URLSearchParams;
	readonly body: Record<string, unknown>;
	/** Aborted when the identity this request was admitted with stops being valid. */
	readonly signal: AbortSignal;
	/**
	 * Who this request was admitted as, in one stable token: a device credential id, or this origin's own Web session.
	 *
	 * The host keys an open sign-in by it, so a second admitted client of one ingress cannot answer or cancel the first
	 * one's browser flow with the shared host bearer. It is stated here from the admission, never read from a body, and it
	 * is never part of an answer.
	 */
	readonly caller: string;
};

/** One answer this surface writes: an HTTP status and the JSON body, framework-free. */
export type ProviderReply = { readonly status: number; readonly body: unknown };

/**
 * One provider as the panel lists it.
 *
 * The row carries no credential value: a hint is a hint because the host masked it. The names are the ones the existing
 * Settings panel already reads (`displayName` for the key section, `loggedIn` for the subscription one), so a client on
 * this origin renders the same panel it rendered behind the retired entry — only the owner of the answer changed.
 */
export type ProviderPanelRow = {
	readonly id: string;
	readonly name: string;
	readonly displayName: string;
	/** Whether a request could be authenticated on this host right now, by any means the provider resolves. */
	readonly configured: boolean;
	/** The subscription panel's own word for the same fact. */
	readonly loggedIn: boolean;
	readonly source?: string;
	/** What this host's credential file holds, which is the only thing this surface may replace or remove. */
	readonly storedType?: string;
	readonly maskedHint?: string;
	/** Whether the provider also accepts an API key, so the panel lists it in both sections. */
	readonly supportsApiKey: boolean;
	readonly supportsOAuth: boolean;
};

/**
 * The routes the ingress answers itself.
 *
 * They name the host this origin serves rather than a Backend resource, so the entrance is the last place that may decide
 * they are answered locally — which is the only way a provider key stops being a Backend concern.
 */
export function handlesProviderAuthRoute(route: string): boolean {
	return (
		route === "auth/providers"
		|| segmentOf(route, "auth/api-key/")
		|| segmentOf(route, "auth/login/")
		|| segmentOf(route, "auth/logout/")
	);
}

/** Whether a route is a provider *sign-in* route, whose work outlives the request that started it. */
export function handlesProviderLoginRoute(route: string): boolean {
	return segmentOf(route, "auth/login/");
}

/** Whether `route` is `prefix` plus exactly one non-empty path segment. */
function segmentOf(route: string, prefix: string): boolean {
	if (!route.startsWith(prefix)) return false;
	const rest = route.slice(prefix.length);
	return rest !== "" && !rest.includes("/");
}

/**
 * The status a refusal is answered with, and the reason a panel needs three kinds of "no" apart.
 *
 * `unsupported_operation` is the host stating that it serves no provider-auth capability at all — an SSH gateway, or one
 * composed without the service — and is answered as the same 501 with `code: "unsupported"` every other unserved Settings
 * capability uses, so a panel withholds the control instead of offering a field that can only fail. A refusal that says the
 * request was wrong, or that the host's state changed underneath the caller, is 4xx and shown against the field the person
 * just used. Everything else — the credential file could not be read, another writer holds its lock, this host refused
 * access, the operation failed — means the host could not do what was asked and is 503 with the code the panel offers a
 * retry against. An unknown code reads as the host failing, never as a limit: guessing "not served" would hide a control
 * the deployment really does have.
 */
export function providerAuthRefusalStatus(code: string): number {
	if (code === "unsupported_operation") return 501;
	if (code === "invalid_request") return 400;
	if (code === "unknown_provider") return 403;
	if (code === "credential_mismatch") return 409;
	return 503;
}

/**
 * The status a sign-in refusal is answered with.
 *
 * It is the listing surface's rule with the flow's own names added. `flow_unknown` is 404 rather than a limit: the caller
 * is not allowed to follow a flow that ended, is not its own, or vanished with a restarted host, and 404 says "there is
 * nothing here to follow" in the one word a panel needs to drop back to idle. `flow_not_waiting` is 409 — the answer
 * arrived while the flow was somewhere else — and `too_many_flows` is 429, a limit that clears by itself, which is the
 * difference between "retry" and "this deployment cannot".
 */
export function providerLoginRefusalStatus(code: string): number {
	if (code === "unsupported_operation") return 501;
	if (code === "invalid_request" || code === "answer_invalid") return 400;
	if (code === "unknown_provider") return 403;
	if (code === "flow_unknown") return 404;
	if (code === "flow_not_waiting" || code === "credential_mismatch") return 409;
	if (code === "too_many_flows") return 429;
	return 503;
}

export function createProviderAuthIngressSurface(host: { readonly origin: string; readonly token: string } | undefined) {
	/**
	 * Ask this origin's own host for one provider-auth operation.
	 *
	 * The answer is the host's, or a transport fact, or the named limit — never an invented empty listing. A host that
	 * cannot be reached is something a person can act on (this deployment's configuration, or that machine being down), so
	 * it is reported as that rather than as a listing of nothing, which would read as "no provider is configured here".
	 */
	async function callHost(request: ProviderAuthRequest, signal: AbortSignal): Promise<ProviderHostAnswer> {
		if (host === undefined) return { ok: false, code: "provider_auth_unavailable", message: PROVIDER_AUTH_UNAVAILABLE_ERROR };
		let response: Response;
		try {
			response = await fetch(host.origin + "/v1/providers/auth", {
				method: "POST",
				headers: { authorization: "Bearer " + host.token, "content-type": "application/json" },
				body: JSON.stringify(request),
				// The request's own deadline, and the admission's: a revoked credential aborts the call, and a host that
				// never answers cannot hold the socket open past the deadline.
				signal: AbortSignal.any([AbortSignal.timeout(PROVIDER_HOST_TIMEOUT_MS), signal]),
			});
		} catch (error) {
			return { ok: false, code: "provider_auth_unreachable", message: error instanceof Error ? error.message : String(error) };
		}
		if (response.status === 401) return { ok: false, code: "provider_auth_unauthorized", message: "the provider host service refused this client origin's credential" };
		if (!response.ok) { await response.body?.cancel(); return { ok: false, code: "operation_failed", message: "the provider host service answered " + response.status }; }
		const answer = await response.json().catch(() => null) as ProviderHostAnswer | null;
		// A body that is not the host's own answer shape is a transport fault, not an empty listing.
		if (answer === null || typeof answer.ok !== "boolean") return { ok: false, code: "operation_failed", message: "the provider host service answered without a provider-auth result" };
		return answer;
	}

	/**
	 * Ask this origin's own host to run or follow one sign-in.
	 *
	 * The caller token travels beside the operation, because which admitted client a flow belongs to is a fact only this
	 * listener knows. A flow's own work continues on the host after this call answers, so the host is asked with the
	 * request's deadline but *not* with the caller's abort: a browser that closes while a device flow is mid-exchange is
	 * not a person who cancelled their sign-in, and the host has no way to tell the two apart from a socket.
	 */
	async function callLoginHost(request: ProviderLoginRequest): Promise<ProviderLoginHostAnswer> {
		if (host === undefined) return { ok: false, code: "provider_auth_unavailable", message: PROVIDER_AUTH_UNAVAILABLE_ERROR };
		let response: Response;
		try {
			response = await fetch(host.origin + "/v1/providers/login", {
				method: "POST",
				headers: { authorization: "Bearer " + host.token, "content-type": "application/json" },
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(PROVIDER_HOST_TIMEOUT_MS),
			});
		} catch (error) {
			return { ok: false, code: "provider_auth_unreachable", message: error instanceof Error ? error.message : String(error) };
		}
		if (response.status === 401) return { ok: false, code: "provider_auth_unauthorized", message: "the provider host service refused this client origin's credential" };
		if (!response.ok) { await response.body?.cancel(); return { ok: false, code: "operation_failed", message: "the provider host service answered " + response.status }; }
		const answer = await response.json().catch(() => null) as ProviderLoginHostAnswer | null;
		if (answer === null || typeof answer.ok !== "boolean") return { ok: false, code: "operation_failed", message: "the provider host service answered without a provider sign-in result" };
		return answer;
	}

	/** The host's listing as the two sections the panel lists, in the host's own order. */
	function sections(listing: readonly ProviderAuthStatus[]): { readonly oauthProviders: readonly ProviderPanelRow[]; readonly apiKeyProviders: readonly ProviderPanelRow[] } {
		const rows: ProviderPanelRow[] = listing.map((entry) => ({
			id: entry.providerId,
			name: entry.name,
			displayName: entry.name,
			configured: entry.configured,
			...(entry.source === undefined ? {} : { source: entry.source }),
			...(entry.storedType === undefined ? {} : { storedType: entry.storedType }),
			...(entry.maskedHint === undefined ? {} : { maskedHint: entry.maskedHint }),
			loggedIn: entry.configured,
			supportsApiKey: entry.methods.apiKey,
			supportsOAuth: entry.methods.oauth,
		}));
		// A provider belongs in the key section when the host can store a key for it, or already stores something for it:
		// a record the file holds has to be showable and removable even for a provider whose definitions declare no key
		// method, which is how a credential another tool stored still gets disconnected here.
		return { oauthProviders: rows.filter((row) => row.supportsOAuth), apiKeyProviders: rows.filter((row) => row.supportsApiKey || row.storedType !== undefined) };
	}

	/**
	 * One refusal, in the shape the panel reads.
	 *
	 * `code` is the host's own name, so the panel decides its notice from a stable code rather than from parsing a
	 * sentence, and `error` is the host's fixed text — this surface invents no reason and forwards no upstream one,
	 * because a credential error can quote the value it choked on.
	 */
	function refused(answer: { readonly code: string; readonly message: string }, statusOf: (code: string) => number = providerAuthRefusalStatus): ProviderReply {
		const status = statusOf(answer.code);
		if (status === 501) return { status, body: { code: "unsupported", error: answer.message } };
		return { status, body: { success: false, code: answer.code, error: answer.message } };
	}

	/**
	 * One sign-in route, relayed and answered as the flow it describes.
	 *
	 * `POST /api/auth/login/<providerId>` with no flow in the query starts one; with one it answers the question that flow
	 * is asking. `GET /api/auth/login/<providerId>` reads the flow this caller has open for that provider, which is how a
	 * reloaded panel resumes instead of starting a second sign-in. A `flowId` travels through the query rather than the
	 * path because the route a person acts on names the *provider*, and the capability gate asks about that route: an id
	 * in the path would make every poll a different capability to probe.
	 */
	async function handleLogin(providerId: string, request: ProviderIngressRequest): Promise<ProviderReply> {
		const flowId = request.search.get(FLOW_QUERY);
		if (request.method === "GET") {
			const answer = await callLoginHost(flowId === null
				? { operation: "login-status", providerId, caller: request.caller }
				: { operation: "login-poll", flowId, caller: request.caller });
			if (answer.ok === false) return refused(answer, providerLoginRefusalStatus);
			return { status: 200, body: { success: true, flow: answer.value } };
		}
		if (request.method === "DELETE") {
			if (flowId === null) return invalidRequest("A sign-in cancel must name the flow");
			const answer = await callLoginHost({ operation: "login-cancel", flowId, caller: request.caller });
			if (answer.ok === false) return refused(answer, providerLoginRefusalStatus);
			return { status: 200, body: { success: true, flow: answer.value } };
		}
		if (request.method !== "POST") return methodNotAllowed();
		if (flowId === null) {
			const answer = await callLoginHost({ operation: "login-start", providerId, caller: request.caller });
			if (answer.ok === false) return refused(answer, providerLoginRefusalStatus);
			return { status: 200, body: { success: true, flow: answer.value } };
		}
		const answer = await submitAnswer(providerId, flowId, request);
		if (answer.ok === false) return refused(answer, providerLoginRefusalStatus);
		return { status: 200, body: { success: true, flow: answer.value } };
	}

	/**
	 * The answer a caller gave a flow, taken from the body and bounded here.
	 *
	 * One field, one shape: `answer` is what the open question asked for (a pasted redirect address, a code, an option id,
	 * or text). The host validates it against the prompt it is holding; this surface only refuses an oversized or absent
	 * body before it reaches a host, because a body that is not an answer has no business waking a provider's exchange.
	 */
	async function submitAnswer(providerId: string, flowId: string, request: ProviderIngressRequest): Promise<ProviderLoginHostAnswer> {
		const answer = request.body.answer;
		if (typeof answer !== "string" || answer === "") return { ok: false, code: "invalid_request", message: "The request must carry an answer" };
		if (answer.length > MAX_LOGIN_ANSWER_CHARS) return { ok: false, code: "answer_invalid", message: "That answer is too long for a sign-in question" };
		void providerId;
		return await callLoginHost({ operation: "login-submit", flowId, caller: request.caller, answer });
	}

	function methodNotAllowed(): ProviderReply {
		return { status: 405, body: { success: false, code: "invalid_request", error: "Method not allowed" } };
	}

	function invalidRequest(error: string): ProviderReply {
		return { status: 400, body: { success: false, code: "invalid_request", error } };
	}

	async function handle(route: string, request: ProviderIngressRequest): Promise<ProviderReply> {
		if (route === "auth/providers") {
			if (request.method !== "GET") return methodNotAllowed();
			const answer = await callHost({ operation: "list" }, request.signal);
			if (answer.ok === false) return refused(answer);
			return { status: 200, body: sections(answer.value) };
		}
		const prefix = route.startsWith("auth/login/") ? "auth/login/"
			: route.startsWith("auth/logout/") ? "auth/logout/"
				: "auth/api-key/";
		const providerId = decodeURIComponent(route.slice(prefix.length));
		// A segment that decodes to nothing or to a nested path is the wrong route rather than a request worth asking a
		// host about: this surface names exactly one provider per path, and the host validates the id against its own set.
		if (providerId.trim() === "" || providerId.includes("/")) return invalidRequest("The request must name one provider");
		if (prefix === "auth/login/") return await handleLogin(providerId, request);
		if (prefix === "auth/logout/") {
			// A sign-out is the one removal this account's file supports: the stored credential, whatever kind it is. Naming
			// no type is deliberate — a panel signs a provider out, it does not choose which of its credentials to drop.
			if (request.method !== "POST") return methodNotAllowed();
			const answer = await callHost({ operation: "remove", providerId }, request.signal);
			if (answer.ok === false) return refused(answer);
			return { status: 200, body: { success: true, providers: sections(answer.value).apiKeyProviders } };
		}
		if (request.method === "POST") {
			const apiKey = request.body.apiKey;
			if (typeof apiKey !== "string" || apiKey.trim() === "") return invalidRequest("The request must carry an API key");
			const answer = await callHost({ operation: "set-key", providerId, apiKey }, request.signal);
			if (answer.ok === false) return refused(answer);
			return { status: 200, body: { success: true, providers: sections(answer.value).apiKeyProviders } };
		}
		if (request.method === "DELETE") {
			const expectedType = request.search.get("expectedType");
			if (expectedType !== null && expectedType !== "api_key" && expectedType !== "oauth") return invalidRequest("expectedType names api_key or oauth");
			const answer = await callHost(expectedType === null ? { operation: "remove", providerId } : { operation: "remove", providerId, expectedType }, request.signal);
			if (answer.ok === false) return refused(answer);
			return { status: 200, body: { success: true, providers: sections(answer.value).apiKeyProviders } };
		}
		return methodNotAllowed();
	}

	/**
	 * End every flow one caller has open, best-effort, and report whether the host agreed.
	 *
	 * A device credential that stops being valid must reach a flow that is detached from any request: its caller cannot
	 * cancel it, because its next call is refused at this entrance, and a flow nobody can act on can still finish and
	 * store a credential for an account whose client was just revoked. Nothing is done with the answer — a caller that is
	 * gone will not see it — and a host that cannot be reached is stated for the log, because the flow then lives out its
	 * own deadline instead, which is the one bound that always holds.
	 */
	async function revokeLoginFlows(caller: string): Promise<boolean> {
		const answer = await callLoginHost({ operation: "login-forget", caller });
		return answer.ok === true;
	}

	return { handle, revokeLoginFlows };
}
