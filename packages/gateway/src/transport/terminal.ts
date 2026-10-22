import type { IncomingMessage, ServerResponse } from "node:http";
import { TERMINAL_HEARTBEAT_FRAME, TERMINAL_STREAM_BUDGET_BYTES, type TerminalEvent, type TerminalExit, type TerminalFanInEvent, type TerminalOpenRequest, type TerminalReplay, type TerminalSessions } from "../terminal.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * The terminal surface: open a session, stream its output, send input, apply a resize and close it.
 *
 * A gateway whose execution host serves no terminal answers `not_supported` and names the limit, and an unknown session
 * answers `unknown_terminal`. Output travels as server-sent events, so a caller that lost its connection can attach
 * again. Nothing about a session is written to a conversation's transcript, because a session belongs to no
 * conversation.
 *
 * The framing rules are this file's own and none of them belong to the transport that admitted the request: the cursor
 * a reconnect continues from (the browser's `Last-Event-ID` before the `after` query), the per-tab cursors a page
 * names, the order in which a replay and the live events of one attach are written, the keepalive that defeats an idle
 * bound without moving a cursor, and the byte budget that ends a connection that stopped reading instead of the shell
 * behind it.
 */

/** The terminal routes this gateway answers, or undefined when the request names none of them. */
export type TerminalRoute = { readonly kind: "open" } | { readonly kind: "fanIn" } | { readonly kind: "describe" | "events" | "input" | "resize" | "close"; readonly id: string };

/** The terminal route this request names, or undefined when it names none of them. */
export function terminalRoute(url: string, method: string): TerminalRoute | undefined {
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
export function terminalCursor(url: string, lastEventId?: string | string[]): number | undefined {
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
export function terminalFanInCursors(url: string): { id: string; after?: number }[] {
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

/** The terminal routes of one gateway, over the sessions it borrows. */
export class TerminalTransport {
	readonly #sessions: TerminalSessions | undefined;

	constructor(sessions: TerminalSessions | undefined) {
		this.#sessions = sessions;
	}

	async handle(route: TerminalRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const sessions = this.#sessions;
		if (sessions === undefined) {
			writeJson(response, 501, { ok: false, code: "not_supported", message: "this gateway has no terminal capability: its execution host is not configured to serve one" });
			return;
		}
		if (route.kind === "open") {
			const body = await readJson(request);
			const open = body as Partial<TerminalOpenRequest> | undefined;
			if (open === null || typeof open !== "object" || typeof open.gatewayId !== "string" || typeof open.workspaceId !== "string" || typeof open.cols !== "number" || typeof open.rows !== "number" || (open.cwd !== undefined && typeof open.cwd !== "string") || (open.id !== undefined && typeof open.id !== "string")) {
				writeJson(response, 400, { ok: false, code: "invalid_request" });
				return;
			}
			const result = await sessions.open(open as TerminalOpenRequest);
			writeJson(response, result.ok ? 200 : 409, result);
			return;
		}
		if (route.kind === "describe") {
			writeJson(response, 200, sessions.describe(route.id));
			return;
		}
		if (route.kind === "events") {
			await this.#events(route.id, sessions, request, response, terminalCursor(request.url ?? "", request.headers["last-event-id"]));
			return;
		}
		if (route.kind === "fanIn") {
			await this.#fanIn(sessions, request, response, terminalFanInCursors(request.url ?? ""));
			return;
		}
		if (route.kind === "close") {
			writeJson(response, 200, await sessions.close(route.id));
			return;
		}
		const body = await readJson(request);
		const command = body as { data?: unknown; cols?: unknown; rows?: unknown } | undefined;
		if (route.kind === "input") {
			if (command === null || typeof command !== "object" || typeof command.data !== "string") {
				writeJson(response, 400, { ok: false, code: "invalid_request" });
				return;
			}
			writeJson(response, 200, sessions.write(route.id, command.data));
			return;
		}
		if (command === null || typeof command !== "object" || typeof command.cols !== "number" || typeof command.rows !== "number") {
			writeJson(response, 400, { ok: false, code: "invalid_request" });
			return;
		}
		writeJson(response, 200, sessions.resize(route.id, command.cols, command.rows));
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
	async #fanIn(sessions: TerminalSessions, request: IncomingMessage, response: ServerResponse, tabs: readonly { id: string; after?: number }[]): Promise<void> {
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
				if (event.type === "output") this.#writeFrame(response, tab.id + ":" + event.offset, { type: "output", id: tab.id, data: event.data, offset: event.offset, ...(event.reset === undefined ? {} : { reset: event.reset }) } satisfies TerminalFanInEvent);
				else this.#writeFrame(response, "", { type: "exit", id: tab.id, exitCode: event.exitCode, signal: event.signal } satisfies TerminalFanInEvent);
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
			if (replay.data !== "" || replay.reset) this.#writeFrame(response, id + ":" + replay.offset, { type: "output", id, data: replay.data, offset: replay.offset, reset: replay.reset } satisfies TerminalFanInEvent);
		}
		for (const { id, exit } of replays) {
			if (exit === undefined) continue;
			this.#writeFrame(response, "", { type: "exit", id, exitCode: exit.exitCode, signal: exit.signal } satisfies TerminalFanInEvent);
		}
		// The cadence belongs to the sessions this stream actually holds: a stream that named only sessions this gateway
		// does not run holds nothing, so it has nothing to keep alive and arms nothing. It stays open — the caller named
		// its tabs and a refusal here would fail the tabs that do exist — and is ended by the caller going away.
		await this.#holdStream(response, request, attachments.length > 0 ? sessions.heartbeatIntervalMs : 0, () => { for (const attachment of attachments) attachment.unsubscribe(); });
	}

	/**
	 * One session's event stream: output as the host produces it, then exactly one exit frame that ends the response.
	 *
	 * A caller that names a session this gateway does not know is refused before the stream opens, so a reconnecting
	 * client gets a status it can act on rather than an empty stream. A session that has already ended delivers its
	 * exit at once, so nothing waits for an event that will never come.
	 */
	async #events(id: string, sessions: TerminalSessions, request: IncomingMessage, response: ServerResponse, after: number | undefined): Promise<void> {
		// The attachment is taken before a byte is written, so the replay and every later event are one ordered stream:
		// a subscriber's listener is synchronous, so nothing can arrive between the two.
		const subscription = sessions.subscribe(id, (event) => {
			this.#writeFrame(response, event.type === "output" ? String(event.offset) : "", event);
			// The session's own exit is the end of its stream: the caller reads the frame that ends it rather than
			// waiting for an event that will never come.
			if (event.type === "exit") response.end();
		}, after);
		// A caller that names a session this gateway does not know is refused before the stream opens, so a reconnecting
		// client gets a status it can act on rather than an empty stream.
		if (subscription === undefined) {
			writeJson(response, 404, { ok: false, code: "unknown_terminal" });
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		response.flushHeaders();
		// The replay is the first thing a caller sees, so what it missed arrives before anything new, and its own
		// cursor travels in the event's id: a client that reconnects with Last-Event-ID continues from there.
		if (subscription.replay.data !== "" || subscription.replay.reset) {
			this.#writeFrame(response, String(subscription.replay.offset), { type: "output", data: subscription.replay.data, offset: subscription.replay.offset, reset: subscription.replay.reset } satisfies TerminalEvent);
		}
		// A session that has already ended delivers its exit at once, and the stream is over with it.
		if (subscription.exit !== undefined) {
			this.#writeFrame(response, "", subscription.exit);
			subscription.unsubscribe();
			response.end();
			return;
		}
		await this.#holdStream(response, request, sessions.heartbeatIntervalMs, () => subscription.unsubscribe());
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
	async #holdStream(response: ServerResponse, request: IncomingMessage, cadence: number, detach: () => void): Promise<void> {
		const keepalive = cadence > 0 ? setInterval(() => this.#writeComment(response), cadence) : null;
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
	#writeFrame(response: ServerResponse, cursor: string, event: unknown): void {
		this.#writeBytes(response, (cursor === "" ? "" : "id: " + cursor + "\n") + "data: " + JSON.stringify(event) + "\n\n");
	}

	/**
	 * The stream's keepalive: bytes with no event, on its own frame boundary, and measured like every other frame.
	 *
	 * A terminal is quiet between keystrokes, and a transport that bounds an idle body would tear the stream down and
	 * make the panel reconnect — which it answers with a reset. A comment frame defeats that bound without moving the
	 * caller's cursor: an `id:` line here would be read as an output offset and would move every tab's reconnect
	 * position to a place no output exists.
	 */
	#writeComment(response: ServerResponse): void {
		this.#writeBytes(response, TERMINAL_HEARTBEAT_FRAME);
	}

	/** One write of a terminal stream's bytes, under the one budget every terminal byte is measured against. */
	#writeBytes(response: ServerResponse, bytes: string): void {
		if (response.writableEnded || response.destroyed) return;
		if (response.writableLength > (this.#sessions?.streamBudgetBytes ?? TERMINAL_STREAM_BUDGET_BYTES)) {
			// The consumer is not reading and cannot be paced: more than its budget is already unwritten, so nothing
			// here would reach it anyway. The connection ends — the socket is what holds those bytes, so ending the
			// response alone would leave them queued on a socket nobody is going to read — and the session does not, so
			// the caller reconnects with the cursor it read and is answered from the session's own retained tail.
			(response.socket ?? response).destroy();
			return;
		}
		response.write(bytes);
	}
}
