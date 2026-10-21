/**
 * The transport seam every gateway capability call shares: one origin, one bearer token, one timeout and abort policy,
 * one classification of what a failed or lost response means. Capability namespaces build their request and read their
 * answer; they do not construct URLs, headers or abort signals themselves.
 *
 * Nothing here retries. A request whose response was never received is reported as such, and a mutation that could have
 * run on the host is `outcome_unknown` rather than a refusal that a caller might safely repeat.
 */

/** How long one gateway request may take when the caller names no limit. */
export const HOST_REQUEST_TIMEOUT_MS = 20_000;

/** The origin and token a gateway binding already holds. */
export type HostBinding = { readonly gatewayOrigin: string; readonly gatewayToken: string };

/** An injected fetch, for deterministic tests; production passes nothing and gets the runtime's own. */
export type HostFetch = typeof fetch;

/**
 * What repeating a request would mean. A read-only request cannot change gateway state, so losing its answer is only a
 * transport failure. A mutation may have been admitted and run, so losing its answer leaves the outcome unknown.
 */
export type HostRequestPolicy = "read-only" | "mutation";

/**
 * The classifications a caller can act on. `operation_failed` carries the gateway's own refusal (status and wire code),
 * so a definitive refusal is never confused with a request that may or may not have run.
 */
export type HostTransportErrorCode =
	| "gateway_offline"
	| "timeout"
	| "aborted"
	| "unauthorized"
	| "protocol_error"
	| "operation_failed"
	| "outcome_unknown";

export type HostTransportErrorOptions = {
	/** HTTP status of a definitive answer, when the gateway gave one. */
	readonly status?: number;
	/** The gateway's own wire code, when its answer named one. */
	readonly gatewayCode?: string;
	readonly cause?: unknown;
};

/** A typed transport failure. Its message names the request, never the token or the body it carried. */
export class HostTransportError extends Error {
	readonly code: HostTransportErrorCode;
	readonly status?: number;
	readonly gatewayCode?: string;
	constructor(code: HostTransportErrorCode, message: string, options?: HostTransportErrorOptions) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "HostTransportError";
		this.code = code;
		if (options?.status !== undefined) this.status = options.status;
		if (options?.gatewayCode !== undefined) this.gatewayCode = options.gatewayCode;
	}
}

/** What a caller may say about one call: its own cancellation, its own bound, and nothing about the route. */
export type HostRequestOptions = { readonly signal?: AbortSignal; readonly timeoutMs?: number };

/** One call on the gateway. `path` is this package's own route, never a URL a caller supplied. */
export type HostTransportRequest = {
	readonly path: string;
	readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
	/** Content headers and any other header the capability owns. The bearer header is added here. */
	readonly headers?: Readonly<Record<string, string>>;
	/** A string, bytes or a stream: a stream is forwarded, never collected. */
	readonly body?: BodyInit | null;
	/**
	 * Node's fetch requires this hint before it will forward a streamed request body, and refuses one without it. It
	 * changes nothing else about the request, so no browser-side meaning is implied by carrying it here.
	 */
	readonly duplex?: "half";
	/** Caller cancellation. It is composed with the timeout and is never replaced by one. */
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	/** Defaults to read-only for GET and mutation for everything else, which is the safe reading of a POST. */
	readonly policy?: HostRequestPolicy;
};

/**
 * One JSON call: the request carries a value, the answer is decoded by the capability that asked for it. `body` is a
 * value to encode, not a body to forward, so it is typed apart from {@link HostTransportRequest}.
 */
export type HostJsonRequest<T> = Omit<HostTransportRequest, "body"> & {
	readonly body?: unknown;
	/** Reads the answer, or throws for one this capability does not accept. A throw becomes `protocol_error`. */
	readonly decode: (value: unknown) => T;
};

/**
 * What an error message and the outcome policy need from any request: its method and its route. Every kind of request is
 * described by it, so a JSON call, a bytes call and an event stream are classified and named the same way.
 */
type HostRequestIdentity = { readonly method?: HostTransportRequest["method"]; readonly path: string; readonly policy?: HostRequestPolicy };

/** Failures that prove the gateway never saw the request: the connection could not be opened at all. */
const NOT_ADMITTED: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const MAX_ERROR_BODY_CHARS = 4_096;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** The system error code of a failed fetch, wherever the runtime nested it. */
function errorCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** The gateway's wire code from a refusal body, if it sent one. */
function gatewayCodeOf(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		const code = (parsed as { code?: unknown } | null)?.code;
		return typeof code === "string" && code !== "" ? code : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The shared gateway transport. It owns origin joining, the bearer header, timeout and abort composition, status
 * classification and body decoding, so a capability adapter only decides what its own answer means.
 */
export class GatewayHostTransport {
	/** The origin as it is joined: no trailing slashes, so a path's leading slash never doubles. */
	readonly origin: string;
	readonly #token: string;
	readonly #fetch: HostFetch;
	readonly #timeoutMs: number;

	constructor(binding: HostBinding & { readonly fetch?: HostFetch; readonly timeoutMs?: number }) {
		let parsed: URL;
		try {
			parsed = new URL(binding.gatewayOrigin);
		} catch {
			throw new HostTransportError("protocol_error", "the gateway binding has no usable origin");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new HostTransportError("protocol_error", "the gateway binding origin is not an http(s) origin");
		if (binding.gatewayToken === "") throw new HostTransportError("protocol_error", "the gateway binding carries no token");
		this.origin = binding.gatewayOrigin.replace(/\/+$/, "");
		this.#token = binding.gatewayToken;
		this.#fetch = binding.fetch ?? fetch;
		this.#timeoutMs = binding.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS;
	}

	/**
	 * Origin plus route plus query. A route is a path this package wrote: an absolute URL, a protocol-relative one or one
	 * carrying its own query is a bug, not something to forward.
	 */
	url(path: string, query?: HostTransportRequest["query"]): string {
		if (!path.startsWith("/")) throw new HostTransportError("protocol_error", "the gateway route must be an absolute path: " + path);
		if (ABSOLUTE_URL.test(path) || path.startsWith("//")) throw new HostTransportError("protocol_error", "the gateway route must not be an absolute or protocol-relative URL: " + path);
		if (path.includes("?") || path.includes("#")) throw new HostTransportError("protocol_error", "the gateway route must not carry its own query: " + path);
		const route = path.replace(/\/{2,}/g, "/");
		const search = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) search.set(key, String(value));
		const suffix = search.toString();
		return this.origin + route + (suffix === "" ? "" : "?" + suffix);
	}

	/**
	 * One request, any status. Transport failures throw; a definitive answer of any status is returned, because the
	 * caller of a streaming capability decides what a 206 or a refusal means. The timeout covers the request, not the
	 * caller's reading of a large body.
	 */
	async send(request: HostTransportRequest): Promise<Response> {
		return await this.#run(request, async response => response);
	}

	/**
	 * One long-lived answer, such as an event stream: any status and any content type, returned before its body is read,
	 * and no timeout at all. An answer that is *not* returned is classified exactly as any other request is; a caller
	 * that streams for hours is not racing a bound meant for a request.
	 *
	 * The caller's cancellation outlives the return here, because the answer does: a stream handed back unread is still
	 * being read by its caller, and a connection nobody reads is a session nobody releases. The request's own signal is
	 * composed for as long as the body is, so cancelling closes the host request rather than only the reader.
	 */
	async stream(request: HostTransportRequest): Promise<Response> {
		return await this.#run(request, async answer => answer, undefined, { unbounded: true, holdCaller: true });
	}

	/** One request that must be answered with success: 401 is `unauthorized`, any other refusal `operation_failed`. */
	async sendOk(request: HostTransportRequest): Promise<Response> {
		return await this.#run(request, async response => {
			if (response.ok) return response;
			throw await this.#refusal(response, request);
		});
	}

	/** One JSON call: encoded here, refused here, decoded by the capability, and never answered with an empty value. */
	async json<T>(request: HostJsonRequest<T>): Promise<T> {
		const { decode, body, ...rest } = request;
		const encoded = body === undefined ? undefined : JSON.stringify(body);
		return await this.#run(
			{ ...rest, headers: encoded === undefined ? request.headers : { "content-type": "application/json", ...request.headers }, body: encoded },
			async response => {
				if (!response.ok) throw await this.#refusal(response, request);
				let text: string;
				try {
					text = await response.text();
				} catch (error) {
					// The answer started and then broke: the request was admitted, so its outcome follows the policy.
					throw this.#failure(error, request, { timedOut: false });
				}
				if (text.trim() === "") throw new HostTransportError("protocol_error", "the gateway answered " + label(request) + " with an empty body", { status: response.status });
				let value: unknown;
				try {
					value = JSON.parse(text);
				} catch (error) {
					throw new HostTransportError("protocol_error", "the gateway answered " + label(request) + " with malformed JSON", { status: response.status, cause: error });
				}
				try {
					return decode(value);
				} catch (error) {
					throw new HostTransportError("protocol_error", "the gateway answered " + label(request) + " with a body this call does not accept", { status: response.status, cause: error });
				}
			},
			request,
		);
	}

	/**
	 * The composed request: caller cancellation, one timeout, and the classification of whatever came back. A stream is the
	 * one shape whose answer outlives any bound, so it is the one shape that composes a caller's signal without a timer.
	 */
	async #run<T>(request: HostTransportRequest, use: (response: Response) => Promise<T>, described?: HostRequestIdentity, options?: { readonly unbounded?: boolean; readonly holdCaller?: boolean }): Promise<T> {
		const method = request.method ?? "POST";
		const url = this.url(request.path, request.query);
		const caller = request.signal;
		if (caller?.aborted) throw new HostTransportError("aborted", "the caller cancelled " + label(request) + " before it was sent", { cause: caller.reason });
		const controller = new AbortController();
		const forward = () => {
			if (options?.holdCaller === true) caller?.removeEventListener("abort", forward);
			controller.abort(caller?.reason);
		};
		// An unbounded answer outlives this call, so its caller's cancellation must too: the listener stays armed until
		// the caller aborts and removes itself then, which is what lets a reader who walks away close the host request
		// rather than only its reader.
		caller?.addEventListener("abort", forward, { once: options?.holdCaller !== true });
		let timedOut = false;
		const timeoutMs = request.timeoutMs ?? this.#timeoutMs;
		const bounded = options?.unbounded !== true;
		const timer = bounded && Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : undefined;
		try {
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
					headers: { authorization: "Bearer " + this.#token, ...request.headers },
					body: request.body ?? undefined,
					signal: controller.signal,
					...(request.duplex === undefined ? {} : { duplex: request.duplex }),
				} as RequestInit);
			} catch (error) {
				throw this.#failure(error, request, { caller, timedOut });
			}
			try {
				return await use(response);
			} catch (error) {
				if (error instanceof HostTransportError) throw error;
				throw this.#failure(error, request, { caller, timedOut });
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (options?.holdCaller !== true) caller?.removeEventListener("abort", forward);
		}
	}

	/**
	 * What a request that never produced an answer means. The caller's own cancellation wins over the timeout, so a
	 * cancelled call is never reported as a gateway that was too slow; the gateway's refusal is never an unknown outcome.
	 */
	#failure(error: unknown, request: HostRequestIdentity, state: { readonly caller?: AbortSignal; readonly timedOut: boolean }): HostTransportError {
		if (state.caller?.aborted) return new HostTransportError("aborted", "the caller cancelled " + label(request), { cause: error });
		if (state.timedOut) return new HostTransportError("timeout", "the gateway did not answer " + label(request) + " within the timeout", { cause: error });
		const code = errorCode(error);
		if (code !== undefined && NOT_ADMITTED.has(code)) return new HostTransportError("gateway_offline", "the gateway is not reachable for " + label(request), { cause: error });
		if (policyOf(request) === "mutation") return new HostTransportError("outcome_unknown", "the gateway connection was lost during " + label(request) + "; the operation may have run and is never replayed", { cause: error });
		return new HostTransportError("gateway_offline", "the gateway connection failed for " + label(request), { cause: error });
	}

	/** A definitive refusal: the gateway answered, so nothing about this request is unknown. */
	async #refusal(response: Response, request: HostRequestIdentity): Promise<HostTransportError> {
		const text = await response.text().catch(() => "");
		const gatewayCode = gatewayCodeOf(text.slice(0, MAX_ERROR_BODY_CHARS));
		const detail = gatewayCode === undefined ? "" : ": " + gatewayCode;
		if (response.status === 401) return new HostTransportError("unauthorized", "the gateway rejected the credentials for " + label(request) + detail, { status: response.status, ...(gatewayCode === undefined ? {} : { gatewayCode }) });
		return new HostTransportError("operation_failed", "the gateway refused " + label(request) + " with " + response.status + detail, { status: response.status, ...(gatewayCode === undefined ? {} : { gatewayCode }) });
	}
}

function policyOf(request: HostRequestIdentity): HostRequestPolicy {
	const method = request.method ?? "POST";
	return request.policy ?? (method === "GET" ? "read-only" : "mutation");
}

/** The request as an error message may name it: its method and its own route, never its token or its body. */
function label(request: HostRequestIdentity): string {
	return (request.method ?? "POST") + " " + request.path;
}
