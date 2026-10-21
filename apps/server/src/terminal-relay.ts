import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayHostClient, HostTransportError, type GatewayTerminalCapability } from "@hepi/gateway";
import { routingLocation } from "./routing-location.ts";

/**
 * The browser's terminal route on the backend: the one place a browser's terminal request reaches the execution host.
 *
 * The browser addresses a terminal by its own session id and by the routing cwd it belongs to; this relay resolves that
 * cwd to a workspace binding and forwards the operation to that host's `/v1/terminal` surface. Nothing about a session
 * is kept here: the binding is resolved on every request from the cwd the caller names, so a backend restart loses no
 * session and no second registry can disagree with the host about which shell exists.
 *
 * Output travels as the host produced it: the event stream is piped through unchanged, including its `id:` cursor, so
 * a browser's own reconnect continues from the last event it received and the host replays what was missed.
 */

/** One workspace as the host that owns it is reached: its id, the connection and the gateway that serves it. */
export type TerminalBinding = { readonly id: string; readonly gatewayId: string; readonly gatewayOrigin: string; readonly gatewayToken: string };

export type TerminalRelayOptions = {
	/** The binding one workspace id resolves to, or undefined when this deployment serves no such workspace. */
	readonly binding: (workspaceId: string) => Promise<TerminalBinding | undefined>;
	/** The backend's own bounded body reader, so this route adds no second limit to the ones the server already has. */
	readonly readBody: (request: IncomingMessage) => Promise<unknown>;
};

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/**
 * The answer one relayed failure keeps. A refusal the host sent keeps its own status and wire code; a connection that
 * produced no answer is the offline answer this relay has always given; and a lifecycle mutation whose answer was lost
 * keeps the transport's own classification, so nothing reads it as a refusal it could safely retry.
 */
function refused(response: ServerResponse, error: unknown): void {
	if (error instanceof HostTransportError && error.status !== undefined) { json(response, error.status, { ok: false, code: error.gatewayCode ?? "operation_failed" }); return; }
	json(response, 503, { ok: false, code: error instanceof HostTransportError ? error.code : "gateway_offline" });
}

/**
 * The status one lifecycle answer keeps: the host answers a refused open with 409 and every other lifecycle call with
 * 200, and a host that serves no terminal at all is its own named limit — the 501 this relay has always answered.
 */
function lifecycleStatus(result: { readonly ok: boolean; readonly code?: string }, refusalStatus: number): number {
	if (result.ok) return 200;
	return result.code === "not_supported" ? 501 : refusalStatus;
}

/**
 * The terminal routes this relay answers. It returns true when the request was one of them, so the caller's own
 * routing is untouched by every other path.
 */
export function createTerminalRelay(options: TerminalRelayOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
	/** One workspace binding for a cwd the caller named, or the refusal the caller reads. */
	const bound = async (cwd: string | null | undefined, response: ServerResponse): Promise<{ binding: TerminalBinding; relativePath: string } | null> => {
		const location = cwd === null || cwd === undefined ? null : routingLocation(cwd);
		if (location === null) { json(response, 501, { ok: false, code: "not_supported", message: "a terminal is opened in a conversation's workspace, so its routing cwd is required" }); return null; }
		const binding = await options.binding(location.workspaceId);
		if (binding === undefined) { json(response, 404, { ok: false, code: "unknown_workspace" }); return null; }
		return { binding, relativePath: location.relativePath };
	};
	/** The terminal capability of one resolved binding: one host's session surface, over the one shared transport. */
	const terminalOf = (binding: TerminalBinding): GatewayTerminalCapability => new GatewayHostClient({ gatewayOrigin: binding.gatewayOrigin, gatewayToken: binding.gatewayToken }).terminal;
	/**
	 * One lifecycle request to a host's terminal surface, answered with the host's own result.
	 *
	 * A refusal the host sent keeps its status and wire code, a call that produced no answer names what the transport
	 * concluded, and nothing here replays a lifecycle call whose answer was lost.
	 */
	const lifecycle = async (call: () => Promise<{ readonly ok: boolean; readonly code?: string }>, response: ServerResponse, refusalStatus: number): Promise<void> => {
		try {
			const result = await call();
			json(response, lifecycleStatus(result, refusalStatus), result);
		} catch (error) {
			refused(response, error);
		}
	};
	const body = async (message: IncomingMessage): Promise<Record<string, unknown> | undefined> => {
		const parsed = await options.readBody(message);
		return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
	};

	/**
	 * One tab of the page's terminal stream: the session, the routing cwd its workspace is resolved from, and the cursor
	 * the page holds for it.
	 */
	type FanInTab = { readonly id: string; readonly cwd: string; readonly after?: number };
	/**
	 * The tabs a caller named: `tabs=<id>|<cwd>|<after>,...`, each field percent-encoded so a delimiter can never
	 * appear inside one. A tab with no cursor, or an unusable one, asks for that session's retained tail.
	 */
	const fanInTabs = (url: URL): FanInTab[] => {
		const named = url.searchParams.get("tabs") ?? "";
		const tabs: FanInTab[] = [];
		for (const entry of named.split(",")) {
			if (entry === "") continue;
			const [id = "", cwd = "", after = ""] = entry.split("|").map(decodeURIComponent);
			if (id === "" || cwd === "") continue;
			tabs.push({ id, cwd, ...(after === "" || !Number.isFinite(Number(after)) ? {} : { after: Number(after) }) });
		}
		return tabs;
	};

	/**
	 * The page's one terminal stream.
	 *
	 * A browser allows six connections per origin, and one stream per mounted terminal tab spends them on terminals —
	 * including the tabs of a closed panel, because a mounted tab's shell has to stay attached. This carries every
	 * mounted tab's frames on one connection instead, and it is the backend that merges them: a tab is addressed by its
	 * own routing cwd, and tabs may belong to different workspaces, so the host requests are grouped by binding and
	 * merged here rather than by making the page hold one stream per project.
	 *
	 * Every tab's binding is resolved before anything is streamed, so a tab this backend cannot place is answered with a
	 * status the caller can act on rather than by a stream that is silently missing one of its sessions.
	 */
	const fanIn = async (message: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
		if (message.method !== "GET") { json(response, 405, { ok: false, code: "invalid_request" }); return true; }
		const tabs = fanInTabs(url);
		// A stream that names no tab is a caller that has nothing to attach to. It is not an error, and it is not a stream
		// either: nothing here would ever be written to it.
		if (tabs.length === 0) { json(response, 400, { ok: false, code: "invalid_request", message: "at least one tab is required" }); return true; }
		// The caller's own connection is watched before any binding is resolved, so a caller that goes away while a
		// workspace is being registered has no host stream opened behind it — the same reason the per-session route
		// watches first.
		const abort = new AbortController();
		const cancelled = () => abort.abort();
		message.on("close", cancelled);
		response.on("close", cancelled);
		const detached = () => abort.signal.aborted || response.destroyed || response.writableEnded;
		try {
			const grouped = new Map<string, { binding: TerminalBinding; tabs: FanInTab[] }>();
			for (const tab of tabs) {
				const location = routingLocation(tab.cwd);
				if (location === null) { if (!detached()) json(response, 501, { ok: false, code: "not_supported", message: "a terminal is opened in a conversation's workspace, so its routing cwd is required" }); return true; }
				const binding = await options.binding(location.workspaceId);
				if (binding === undefined) { if (!detached()) json(response, 404, { ok: false, code: "unknown_workspace" }); return true; }
				const group = grouped.get(binding.gatewayOrigin + "\u0000" + binding.id);
				if (group === undefined) grouped.set(binding.gatewayOrigin + "\u0000" + binding.id, { binding, tabs: [tab] });
				else group.tabs.push(tab);
			}
			if (detached()) return true;
			// Each host's request is cancellable on its own as well as with the caller: one host's stream ending ends this
			// one, and the hosts still running must be let go rather than left writing into a response that is closing.
			const upstreams: { stream: Response; host: AbortController }[] = [];
			const release = async (): Promise<void> => { for (const { stream } of upstreams) await stream.body?.cancel().catch(() => {}); };
			for (const group of grouped.values()) {
				// This group's request is cancellable on its own as well as with the caller, so one host's stream can be
				// let go without the hosts still running; the capability composes that with the caller's connection.
				const host = new AbortController();
				const stream: Response | Error = await terminalOf(group.binding).fanIn({
					tabs: group.tabs.map((tab) => ({ id: tab.id, ...(tab.after === undefined ? {} : { after: tab.after }) })),
					signal: AbortSignal.any([abort.signal, host.signal]),
				}).catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error)));
				// A host that cannot be reached, or one that refused its part of the merge, is answered before any frame
				// is written, so the caller learns about it instead of reading a stream that will never carry its tabs.
				if (stream instanceof Error) {
					if (!detached()) refused(response, stream);
					await release();
					return true;
				}
				upstreams.push({ stream, host });
			}
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			// The head is flushed rather than left to the first frame. A stream that continues from the cursor its caller
			// already read has nothing to replay, and a page whose reconnect is waiting on a status it never receives
			// would sit on a connection that is in fact attached — until the idle bound in front of it cut it.
			response.flushHeaders();
			// One writer for the caller's stream however many hosts are behind it: frames from different bindings are
			// written whole and in the order they arrived, so a merge can never split one.
			//
			// A host stream that ends ends this one, and the hosts still running are let go with it. The page holds one
			// stream for all of its tabs, so a host going away is not a fact one tab can be told and the others left
			// waiting on: the stream closes, the page reopens it, and every tab is re-attached — which is also what
			// re-attaches the tabs of the host that went away, instead of leaving them on a stream that will never carry
			// them again. Nothing is lost by it: the page names each tab's cursor when it comes back.
			const pipes = upstreams.map(({ stream }) => pipeFrames(stream, response, detached));
			await Promise.race(pipes);
			for (const { host } of upstreams) host.abort();
			await Promise.all(pipes);
			if (!response.writableEnded && !response.destroyed) response.end();
			return true;
		} finally {
			message.off("close", cancelled);
			response.off("close", cancelled);
		}
	};

	/**
	 * One host's frames into a response that other hosts are writing to as well.
	 *
	 * The bytes are passed through unaltered — a cursor, a payload and a comment frame all mean what the host said they
	 * mean — and a frame is written only once its terminating blank line has arrived, because a chunk boundary in the
	 * middle of a frame is not a frame boundary and half a frame is a payload the caller would have to discard. A
	 * trailing partial frame is discarded for the same reason: this stream is about to end, and what the caller does
	 * next is reconnect with the last complete cursor it saw, so half a frame here is a payload the next attach would
	 * repeat from a cursor that never moved.
	 */
	const pipeFrames = async (upstream: Response, response: ServerResponse, detached: () => boolean): Promise<void> => {
		const reader = upstream.body!.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		try {
			while (!detached()) {
				const chunk = await reader.read();
				if (chunk.done) break;
				if (response.writableEnded || response.destroyed) break;
				pending += decoder.decode(chunk.value, { stream: true });
				let boundary: number;
				while ((boundary = pending.indexOf("\n\n")) >= 0) {
					response.write(pending.slice(0, boundary + 2));
					pending = pending.slice(boundary + 2);
				}
			}
		} catch { /* the host stream ended or was cancelled with the caller */ }
		finally { await reader.cancel().catch(() => {}); }
	};

	return async (message, response, url) => {
		const path = url.pathname;
		if (path !== "/api/terminal" && !path.startsWith("/api/terminal/")) return false;
		// The page's one terminal stream, before the session routes below parse the same path as a session id: it carries
		// every mounted tab's frames, so it is a route of its own rather than one tab's.
		if (path === "/api/terminal/events") return await fanIn(message, response, url);
		const segments = path === "/api/terminal" ? [] : path.slice("/api/terminal/".length).split("/").map(decodeURIComponent);

		// Opening: the browser names its own session id, the workspace it belongs to and the size it laid out, and the
		// host answers the session it now runs. The tab's own routing cwd travels on every request, so no registry here
		// has to remember which workspace a session id belongs to.
		if (segments.length === 0) {
			if (message.method !== "POST") { json(response, 405, { ok: false, code: "invalid_request" }); return true; }
			const open = await body(message);
			const target = await bound(typeof open?.cwd === "string" ? open.cwd : null, response);
			if (target === null) return true;
			if (typeof open?.id !== "string" || typeof open.cols !== "number" || typeof open.rows !== "number") { json(response, 400, { ok: false, code: "invalid_request" }); return true; }
			await lifecycle(() => terminalOf(target.binding).open({ gatewayId: target.binding.gatewayId, workspaceId: target.binding.id, cwd: target.relativePath, cols: open.cols as number, rows: open.rows as number, id: open.id as string }), response, 409);
			return true;
		}

		const id = segments[0] ?? "";
		const action = segments[1];
		if (id === "" || segments.length > 2) { json(response, 404, { ok: false, code: "unknown_terminal" }); return true; }
		// The event stream is the one route whose host request outlives this handler, so it is dispatched before the
		// binding the other routes share: it resolves that binding itself, with the caller's own connection watched
		// first. The routes below never hold anything open, so they need no such watching.
		if (action === "events" && message.method === "GET") {
			// This host request exists only for this caller, so it is cancelled with the caller's own connection, from
			// the first moment there is a request to cancel until the stream ends. An attached stream is what holds a
			// session open — its reconnect window runs only while nobody is attached — so a request left behind by a
			// caller that went away would keep the shell alive for as long as the gateway runs, with no caller left to
			// ever read it. The connection is watched *before* the binding is resolved: resolving it re-registers the
			// workspace with the host, which is an ordinary await, and a caller that disconnects during it would
			// otherwise have no listener yet and its host stream would open afterwards with nobody to read it.
			const abort = new AbortController();
			const cancelled = () => abort.abort();
			message.on("close", cancelled);
			response.on("close", cancelled);
			const detached = () => abort.signal.aborted || response.destroyed || response.writableEnded;
			try {
				const target = await bound(url.searchParams.get("cwd"), response);
				// The caller is gone, so there is no one to answer and no host request to open: a session's stream
				// opened here would be attached with nobody to read it, holding the shell past its reconnect window.
				if (target === null || detached()) return true;
				// The stream is piped through, cursor and all. The upstream request carries the caller's own cursor, so
				// a reconnecting browser continues from the last event it received instead of being given the tail
				// blindly.
				const after = url.searchParams.get("after");
				const lastEventId = message.headers["last-event-id"];
				// The cursor the caller holds: the standard reconnect header the browser sent, or the query cursor it
				// named when it first attached. The host prefers the header, so passing the newer of the two keeps a
				// reconnect a continuation instead of a first attach it would answer with a reset.
				const cursor = typeof lastEventId === "string" && lastEventId !== "" ? lastEventId : after === null || after === "" ? undefined : after;
				let upstream: Response;
				try {
					// No timeout of its own: a session's stream lasts as long as the session does. It ends when the host's
					// stream ends, or when the caller's connection does.
					upstream = await terminalOf(target.binding).events({ id, ...(cursor === undefined ? {} : { after: cursor }), signal: abort.signal });
				} catch (error) {
					// The caller's own connection is gone, so there is nobody left to answer; otherwise the host is
					// unreachable, or refused this session with a status of its own.
					if (!detached()) refused(response, error);
					return true;
				}
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				// Same as the page's stream: a session that is quiet, or a continuation with nothing to replay, is
				// attached all the same, and its caller learns that from the head rather than from a frame that may
				// never come.
				response.flushHeaders();
				const reader = upstream.body!.getReader();
				try {
					while (!abort.signal.aborted) {
						const chunk = await reader.read();
						if (chunk.done) break;
						if (response.writableEnded || response.destroyed) break;
						response.write(chunk.value);
					}
				} catch { /* the host stream ended or was cancelled with the caller: the response is closed below either way */ }
				finally {
					await reader.cancel().catch(() => {});
					if (!response.writableEnded && !response.destroyed) response.end();
				}
				return true;
			} finally {
				// Every exit above — answered, unreachable, streamed or cancelled — leaves the caller's connection
				// unwatched, so nothing here outlives the request that armed it.
				message.off("close", cancelled);
				response.off("close", cancelled);
			}
		}
		// A session this backend cannot place is answered before anything is forwarded: the caller learns that its cwd
		// names no workspace rather than that some host does not know the session.
		const target = await bound(url.searchParams.get("cwd"), response);
		if (target === null) return true;

		if (action === undefined && message.method === "DELETE") {
			await lifecycle(() => terminalOf(target.binding).close({ id }), response, 200);
			return true;
		}
		if (action === undefined && message.method === "GET") {
			// What the session is, which is also how a restored tab tells a live shell from one that has ended.
			await lifecycle(() => terminalOf(target.binding).describe({ id }), response, 200);
			return true;
		}
		if (action === undefined && message.method === "POST") {
			// Input and resize travel as one command surface, the shape the browser's own writer already sends.
			const command = await body(message);
			if (command?.type === "input" && typeof command.data === "string") {
				const data = command.data;
				await lifecycle(() => terminalOf(target.binding).input({ id, data }), response, 200);
				return true;
			}
			if (command?.type === "resize" && typeof command.cols === "number" && typeof command.rows === "number") {
				const cols = command.cols;
				const rows = command.rows;
				await lifecycle(() => terminalOf(target.binding).resize({ id, cols, rows }), response, 200);
				return true;
			}
			json(response, 400, { ok: false, code: "invalid_request" });
			return true;
		}
		json(response, 405, { ok: false, code: "invalid_request" });
		return true;
	};
}
