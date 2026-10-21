/**
 * The terminal capability: one host's `/v1/terminal` surface behind the shared transport.
 *
 * Every method here is one host request. Opening, input, resizing and closing are mutations the transport never replays,
 * and each answers with the host's own result — including the host's refusal, because the caller of a terminal reads the
 * reason a session did not open rather than only a status. The event stream is a response handed back unread: a caller
 * pipes its bytes and keeps the host's own `id:` cursor, so a reconnecting browser continues where it left off.
 *
 * Nothing here aggregates streams. A gateway serves one host, so one request is one stream; merging the streams of
 * several bindings into one response is a fan-in decision that belongs to whoever holds those bindings.
 */

import { GatewayHostTransport, HostTransportError, type HostTransportRequest } from "./host-client.ts";
import type { TerminalCloseResult, TerminalCommandResult, TerminalDescription, TerminalOpenRequest, TerminalOpenResult } from "./terminal.ts";

export type TerminalOpenCall = TerminalOpenRequest;
export type TerminalInputCall = { readonly id: string; readonly data: string };
export type TerminalResizeCall = { readonly id: string; readonly cols: number; readonly rows: number };
export type TerminalCloseCall = { readonly id: string };
/** What one session is, which is also how a restored tab tells a live shell from one that has ended. */
export type TerminalDescribeCall = { readonly id: string };

/** One tab of a caller's page stream: the session, and the cursor the caller holds for it. */
export type TerminalFanInTab = { readonly id: string; readonly after?: string | number };

/**
 * The tabs one caller names, as one host's request: a gateway serves one host, so tabs that host runs are attached by
 * one request. Merging the streams of several hosts is the caller's own decision and stays out of this package.
 */
export type TerminalFanInRequest = { readonly tabs: readonly TerminalFanInTab[]; readonly signal?: AbortSignal };

/**
 * One session's stream as a caller asks for it: the session, and the cursor the caller holds. `after` travels as the
 * standard `Last-Event-ID`, which the host prefers over its query parameter, so a reconnect continues from what the
 * caller actually received.
 */
export type TerminalEventRequest = {
	readonly id: string;
	readonly after?: string | number;
	/** Caller cancellation: it closes the host request, which is what releases the session on the host. */
	readonly signal?: AbortSignal;
};

/** One call's cancellation, for the methods whose answer arrives before they return. */
export type TerminalCallOptions = { readonly signal?: AbortSignal };

/** One lifecycle request as this capability builds it: a value to encode and the route's own method, never a body. */
type LifecycleRequest = { readonly method?: "GET" | "DELETE"; readonly body?: unknown; readonly signal?: AbortSignal };

/** The one session this request addresses: its own route, encoded so a name is a segment and never a path. */
function sessionPath(id: string): string {
	if (id === "") throw new HostTransportError("protocol_error", "a terminal call must name its session");
	return "/v1/terminal/" + encodeURIComponent(id);
}

/** The reconnect cursor as a header, or nothing when the caller holds none: an absent cursor asks for the tail. */
function cursorHeader(after: string | number | undefined): Record<string, string> | undefined {
	if (after === undefined) return undefined;
	const cursor = String(after);
	if (cursor === "" || !Number.isFinite(Number(cursor))) return undefined;
	return { "last-event-id": cursor };
}

export class GatewayTerminalCapability {
	readonly #transport: GatewayHostTransport;

	constructor(transport: GatewayHostTransport) {
		this.#transport = transport;
	}

	/**
	 * Ask a host to run a session in one workspace. The caller names the session id, so reopening a tab reaches the shell
	 * it was attached to instead of starting a second one; a session this host cannot start is answered with its code.
	 */
	async open(request: TerminalOpenCall, options?: TerminalCallOptions): Promise<TerminalOpenResult> {
		return await this.#lifecycle<TerminalOpenResult>("/v1/terminal", { body: request, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}

	/** Write to a session. This is a mutation: its answer is the host's, and a lost one is never sent again. */
	async input(call: TerminalInputCall, options?: TerminalCallOptions): Promise<TerminalCommandResult> {
		return await this.#lifecycle<TerminalCommandResult>(sessionPath(call.id) + "/input", { body: { data: call.data }, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}

	/** Lay a session out again after the tab was resized; a dimension the host will not take is its own refusal. */
	async resize(call: TerminalResizeCall, options?: TerminalCallOptions): Promise<TerminalCommandResult> {
		return await this.#lifecycle<TerminalCommandResult>(sessionPath(call.id) + "/resize", { body: { cols: call.cols, rows: call.rows }, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}

	/** End a session, answering the exit the host saw. A session already gone reports `unknown_terminal`. */
	async close(call: TerminalCloseCall, options?: TerminalCallOptions): Promise<TerminalCloseResult> {
		return await this.#lifecycle<TerminalCloseResult>(sessionPath(call.id), { method: "DELETE", ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}

	/** What one session is: its size, its workspace, and whether the shell it ran has already ended. */
	async describe(call: TerminalDescribeCall, options?: TerminalCallOptions): Promise<TerminalDescription> {
		return await this.#lifecycle<TerminalDescription>(sessionPath(call.id), { method: "GET", ...(options?.signal === undefined ? {} : { signal: options.signal }) });
	}

	/**
	 * One session's event stream, handed back before a frame is read. The bytes are the host's, so its `id:` frames and
	 * comment keepalives mean here exactly what they mean there, and its replay is whatever the cursor asked for. The
	 * caller cancels through its own signal — that, and only that, is what releases the session on the host.
	 *
	 * A host that refuses, or answers with no body at all, fails the call: a caller that received a response it cannot
	 * read would attach a stream it would silently never see a frame on.
	 */
	async events(call: TerminalEventRequest): Promise<Response> {
		const headers = cursorHeader(call.after);
		return await this.#stream(sessionPath(call.id) + "/events", "the event stream of terminal " + call.id, { ...(headers === undefined ? {} : { headers }) }, call.signal);
	}

	/**
	 * The tabs of one host, on one request. This host's frames arrive whole and carry their own `id:` cursors, so a
	 * caller's reconnect continues each tab where it left off. One tab this host does not run is not an error here: the
	 * host answers the tabs it does run, which is what its own fan-in stream was written for.
	 */
	async fanIn(call: TerminalFanInRequest): Promise<Response> {
		if (call.tabs.length === 0) throw new HostTransportError("protocol_error", "a page terminal stream names at least one tab");
		// Each field is encoded before the query is: a delimiter can never appear inside a session's name, and the
		// transport's own query encoding keeps the whole value intact on the wire.
		const named = call.tabs.map(tab => encodeURIComponent(tab.id) + ":" + (tab.after === undefined ? "" : String(tab.after))).join(",");
		return await this.#stream("/v1/terminal/events", "the page's terminal stream", { query: { tabs: named } }, call.signal);
	}

	/**
	 * One event stream, handed back before a frame is read. A host that refuses, or answers with no body at all, fails
	 * the call: a caller that received a response it cannot read would attach a stream it would silently never see a
	 * frame on.
	 */
	async #stream(path: string, label: string, extra: { readonly headers?: Record<string, string>; readonly query?: Record<string, string> }, signal: AbortSignal | undefined): Promise<Response> {
		const response = await this.#transport.stream({
			path,
			method: "GET",
			policy: "read-only",
			...extra,
			...(signal === undefined ? {} : { signal }),
		});
		if (!response.ok) throw await refusalOf(response, label);
		if (response.body !== null) return response;
		// A success status with no body is nothing to pipe: a caller would attach a reader to nothing and never learn why.
		throw new HostTransportError("protocol_error", "the gateway answered " + label + " with no body", { status: response.status });
	}

	/**
	 * One lifecycle call, decoding the host's answer.
	 *
	 * The transport classifies what failed: a lost mutation is `outcome_unknown` because a session may have opened or
	 * taken a resize, and nothing here sends it again. A definitive refusal keeps the status and the host's own code, so a
	 * caller reads `unknown_terminal` from the answer it was given rather than from a guess.
	 */
	async #lifecycle<T extends TerminalCommandResult | TerminalCloseResult | TerminalOpenResult>(path: string, request: LifecycleRequest): Promise<T> {
		try {
			return await this.#transport.json({
				path,
				...request,
				decode: (value) => {
					if (typeof value !== "object" || value === null || typeof (value as { ok?: unknown }).ok !== "boolean") throw new Error("not a terminal answer");
					return value as T;
				},
			});
		} catch (error) {
			// A gateway whose execution host serves no terminal answers 501 on every one of these routes. That is a property
			// of the host, not a rejection of this call, so it is reported as the domain failure the terminal surface
			// already names — a caller reads it and stops asking, and nothing about the request is unknown.
			if (error instanceof HostTransportError && error.status === 501) return NOT_SUPPORTED as T;
			throw error;
		}
	}
}

/** A gateway whose execution host serves no terminal: the same answer every terminal route of it gives. */
const NOT_SUPPORTED: TerminalCommandResult = { ok: false, code: "not_supported", message: "this gateway has no terminal capability" };

/** The typed failure of a refused stream, named by what the caller asked for. */
async function refusalOf(response: Response, label: string): Promise<HostTransportError> {
	const detail = await response.text().catch(() => "");
	const code = ((): string | undefined => {
		try {
			const parsed: unknown = JSON.parse(detail);
			const wire = (parsed as { code?: unknown } | null)?.code;
			return typeof wire === "string" && wire !== "" ? wire : undefined;
		} catch {
			return undefined;
		}
	})();
	const suffix = code === undefined ? "" : ": " + code;
	if (response.status === 401) return new HostTransportError("unauthorized", "the gateway rejected the credentials for " + label + suffix, { status: response.status, ...(code === undefined ? {} : { gatewayCode: code }) });
	return new HostTransportError("operation_failed", "the gateway refused " + label + " with " + response.status + suffix, { status: response.status, ...(code === undefined ? {} : { gatewayCode: code }) });
}

/**
 * The terminal capability of one gateway binding. Every call goes through the shared transport, so no caller constructs
 * a URL or a bearer header for a host's terminal surface, and one host's stream is one request.
 */
export function terminalCapability(transport: GatewayHostTransport): GatewayTerminalCapability {
	return new GatewayTerminalCapability(transport);
}
