import assert from "node:assert/strict";
import { request as httpRequest, type Server } from "node:http";
import { Duplex, duplexPair } from "node:stream";
import { test } from "node:test";
import {
	GatewayRpcServer,
	LocalGateway,
	MemoryLedger,
	TERMINAL_REPLAY_CHARS,
	TERMINAL_STREAM_BUDGET_BYTES,
	TerminalSessions,
	WorkspaceRegistry,
} from "../src/index.ts";
import { gatewayHttp } from "./gateway-http.ts";

/**
 * The terminal streams' byte budget, at the gateway's own wire.
 *
 * A terminal subscriber is synchronous and its listener returns nothing, so a consumer that stops reading cannot be
 * paced: the helper keeps reading its pseudoterminal whatever the gateway does with the bytes. The bounded answer is to
 * end the connection at a stated number of unwritten bytes, leave the shell and every other reader alone, and let the
 * caller reconnect from the cursor it read.
 *
 * Nothing here is a socket, a shell or a process. The shell is a fake host the test writes to by hand, and the
 * connection below the gateway's HTTP server is this process's memory: a consumer that reads answers each write, one
 * that reads slowly answers late, and one that reads nothing answers none — which is exactly the queue the gateway
 * compares its budget against. The volume is stated in characters here instead of being produced by a command, so the
 * numbers the budget is chosen from are the same and the case is reachable without a pseudoterminal.
 */

const TOKEN = "terminal-stream-budget-token";

type Fixture = {
	/** Open one session, which is the same request a browser makes. */
	open(workspaceId: string, id: string): Promise<string>;
	/** Hand one session's output to the gateway, as its shell would. */
	emit(id: string, text: string): void;
	/** What one session reports about itself, without attaching to it. */
	describe(id: string): Promise<Record<string, unknown>>;
	/** Attach to one stream over a connection whose consumer reads at the stated pace. */
	stream(path: string, pace?: Pace): Stream;
	close(): void;
};

/** How fast the consumer below one connection reads: at once, late, or never at all. */
type Pace = "fast" | "slow" | "none";

function start(options: { streamBudgetBytes?: number; reconnectMs?: number } = {}): Fixture {
	/** The fake shells the gateway opened, in the order it opened them, and the one each session id names. */
	const created: { emit(text: string): void }[] = [];
	const shells = new Map<string, { emit(text: string): void }>();
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root: "/workspace" }]);
	const sessions = new TerminalSessions({
		id: "workstation",
		workspaces: registry,
		// No keepalive in these cases: the frames under test are the output frames, and a comment frame would only add
		// bytes the budget already has a measured bound for.
		heartbeatIntervalMs: 0,
		reconnectMs: options.reconnectMs ?? 120_000,
		...(options.streamBudgetBytes === undefined ? {} : { streamBudgetBytes: options.streamBudgetBytes }),
		launcher: (launch) => {
			let resolveExit!: (exit: { exitCode: number | null; signal: number }) => void;
			const exited = new Promise<{ exitCode: number | null; signal: number }>((resolve) => { resolveExit = resolve; });
			const shell = { emit: (text: string) => launch.onOutput(text) };
			created.push(shell);
			return {
				// The execution host canonicalizes the paths it is given; this one takes them as they are.
				ready: Promise.resolve({ root: launch.root, cwd: launch.cwd }),
				write: () => {},
				resize: () => {},
				end: () => { resolveExit({ exitCode: null, signal: 0 }); },
				exited,
			};
		},
	});
	const server = new GatewayRpcServer({
		gateway: new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash", "sh"] }, new MemoryLedger()),
		terminals: sessions,
	});
	const http = gatewayHttp(server.server);
	const auth = (): Record<string, string> => ({ authorization: "Bearer " + TOKEN, "content-type": "application/json" });

	const call = async (request: { method: "GET" | "POST"; path: string; body?: string }): Promise<Record<string, unknown>> => {
		const response = await http.call({ method: request.method, path: request.path, headers: auth(), ...(request.body === undefined ? {} : { body: request.body }) });
		return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
	};

	return {
		async open(workspaceId, id) {
			const before = created.length;
			const body = await call({ method: "POST", path: "/v1/terminal", body: JSON.stringify({ gatewayId: "workstation", workspaceId, cols: 80, rows: 24, id }) });
			assert.equal(body.ok, true, JSON.stringify(body));
			const shell = created[before];
			assert.ok(shell !== undefined, "the gateway started no host session");
			shells.set(id, shell);
			return String(body.id);
		},
		emit: (id, text) => {
			const shell = shells.get(id);
			assert.ok(shell !== undefined, "the gateway opened no host session for " + id);
			shell.emit(text);
		},
		describe: async (id) => await call({ method: "GET", path: "/v1/terminal/" + encodeURIComponent(id) }),
		stream: (path, pace = "fast") => attach(server.server, path, pace),
		close: () => { http.close(); void sessions.closeAll(); },
	};
}

/**
 * The connection below the gateway's HTTP server, in this process.
 *
 * A socket hands the server what it accepted and takes what it was written; the bytes a consumer has not read stay
 * queued on it, which is exactly what a response's `writableLength` reports. This connection is that socket: a
 * consumer that reads answers each write, one that reads late answers after a turn, and one that reads nothing answers
 * none — so the queue the gateway measures against its budget is the queue a stalled socket would hold.
 */
class FakeConnection extends Duplex {
	/** Bytes the gateway wrote into this connection, read or not. */
	received = 0;
	/** The most bytes this connection was holding at once, which is what the budget bounds. */
	peak = 0;
	readonly #upstream: Duplex;
	readonly #pace: Pace;
	#replies: ((error?: Error | null) => void)[] = [];
	#handedHead = false;

	constructor(upstream: Duplex, pace: Pace) {
		super();
		this.#upstream = upstream;
		this.#pace = pace;
		// Nothing is buffered on the way in either: a consumer that reads answers every write, so what the gateway has
		// queued is exactly what has not been answered — which is the number its budget is compared against.
		this.cork();
		process.nextTick(() => this.uncork());
		upstream.on("data", (chunk: Buffer) => { if (!this.push(chunk)) upstream.pause(); });
		upstream.on("end", () => this.push(null));
	}

	_read(): void { this.#upstream.resume(); }

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.received += chunk.byteLength;
		this.#replies.push(callback);
		this.peak = Math.max(this.peak, this.writableLength);
		if (this.#pace === "none" && this.#handedHead) {
			// The consumer read the status line and then stopped: from here every byte stays queued on this connection,
			// which is the queue the gateway compares its budget against, and nothing is answered again.
			return;
		}
		// What a socket takes is what the caller reads, so the bytes travel to the other end of the pair.
		this.#upstream.write(chunk);
		this.#handedHead = true;
		// A reading consumer answers at once; a slow one answers a turn late, so its queue holds a frame or two and never
		// the budget; and the first write of a consumer that reads nothing is the status line, which it does read.
		if (this.#pace === "slow") setImmediate(() => this.#release());
		else this.#release();
	}

	_destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		// What the connection was holding when the gateway ended it is the queue the budget is stated against.
		this.peak = Math.max(this.peak, this.writableLength);
		this.#replies = [];
		this.#upstream.destroy();
		callback(error);
	}

	#release(): void { this.#replies.shift()?.(null); }
}

/** One terminal stream: the frames as they arrive, the bytes they took, and how the connection ended. */
type Stream = {
	/** Resolves with the status the gateway answered once its head arrived, or 0 when the connection ended first. */
	readonly ready: Promise<number>;
	readonly status: number;
	/** The connection below the gateway's HTTP server, for a case that states its own queue. */
	readonly connection: FakeConnection;
	/** Every frame received so far, in order, without the blank line that ends it. */
	frames(): string[];
	/** Wire bytes received so far, blank lines included. */
	bytes(): number;
	/** Resolves once the predicate holds over the frames received so far, or fails at the deadline. */
	until(predicate: (all: string[]) => boolean, description: string): Promise<string[]>;
	/** True once the connection is over, however it ended. */
	ended(): boolean;
	/** Resolves once the connection is over. */
	readonly closed: Promise<void>;
	cancel(): void;
};

function attach(server: Server, path: string, pace: Pace): Stream {
	const [client, host] = duplexPair();
	const connection = new FakeConnection(host, pace);
	// The server is handed the connection it would have accepted: its own parsing, routing and framing run unmodified,
	// and only the transport below them is this process's memory.
	server.emit("connection", connection);
	const outgoing = httpRequest({ host: "gateway.invalid", port: 80, method: "GET", path, headers: { authorization: "Bearer " + TOKEN, accept: "text/event-stream" }, createConnection: () => client });
	// A connection the gateway ended is an outcome these cases assert, not a failure of them.
	outgoing.on("error", () => {});
	outgoing.end();

	const frames: string[] = [];
	let bytes = 0;
	let pending = "";
	let status = 0;
	let over = false;
	let resolveReady!: (status: number) => void;
	const ready = new Promise<number>((resolve) => { resolveReady = resolve; });
	const waiters = new Set<() => void>();
	const wake = () => { for (const waiter of [...waiters]) waiter(); };
	const closed = new Promise<void>((resolve) => {
		outgoing.on("response", (answer) => {
			status = answer.statusCode ?? 0;
			resolveReady(status);
			answer.on("data", (chunk: Buffer) => {
				pending += chunk.toString("utf8");
				let boundary: number;
				while ((boundary = pending.indexOf("\n\n")) >= 0) {
					frames.push(pending.slice(0, boundary));
					bytes += Buffer.byteLength(pending.slice(0, boundary + 2));
					pending = pending.slice(boundary + 2);
				}
				wake();
			});
			// An ended body, a closed one and a reset one are the same fact to a caller: the stream is over.
			answer.on("end", () => { over = true; wake(); resolve(); });
			answer.on("close", () => { over = true; wake(); resolve(); });
			answer.on("error", () => { over = true; wake(); resolve(); });
		});
		// A connection the gateway ended before an answer arrived has no body to read: the end is the fact.
		connection.on("close", () => { over = true; resolveReady(status); wake(); resolve(); });
	});

	return {
		ready,
		get status() { return status; },
		connection,
		frames: () => [...frames],
		bytes: () => bytes,
		ended: () => over,
		closed,
		async until(predicate, description) {
			const deadline = Date.now() + 5_000;
			while (!predicate(frames)) {
				if (over) assert.fail("the stream ended before " + description + "; frames: " + frames.length);
				if (Date.now() > deadline) assert.fail("timed out waiting for " + description + "; frames: " + frames.length);
				// A quiet stream produces no wake-up of its own, and the deadline above is what turns that silence into a
				// failure instead of a hang.
				await new Promise<void>((resolve) => {
					waiters.add(resolve);
					setTimeout(() => { waiters.delete(resolve); resolve(); }, 5);
				});
			}
			return [...frames];
		},
		cancel: () => { outgoing.destroy(); client.destroy(); connection.destroy(); },
	};
}

/** Every `data:` payload of the frames a reader saw, parsed. */
function payloads(all: readonly string[]): Record<string, unknown>[] {
	const parsed: Record<string, unknown>[] = [];
	for (const frame of all) {
		const line = frame.split("\n").find((value) => value.startsWith("data: "));
		if (line !== undefined) parsed.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
	}
	return parsed;
}

/** One session's output, produced in the pieces a pseudoterminal read would hand the gateway. */
async function emitVolume(fixture: Fixture, id: string, total: number, piece: number, byte = "x"): Promise<void> {
	for (let produced = 0; produced < total; produced += piece) {
		fixture.emit(id, byte.repeat(Math.min(piece, total - produced)));
		// The consumer reads between pieces, which is what a reading consumer does and what a flood to a stalled one
		// does not get: without the turn, this test's own producer would be the stall under test.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

test("a slow consumer is ended at the stream budget while its shell and another reader keep running", async (t) => {
	// The budget is small so the case is reachable without megabytes; the shape of it — one number for the connection,
	// whatever the connection holds — is the production one.
	const BUDGET = 64 * 1024;
	const FLOOD = 256 * 1024;
	const fixture = start({ streamBudgetBytes: BUDGET });
	try {
		const id = await fixture.open("workspace-1", "slow-tab");
		// The consumer that reads nothing: its connection answers no write, so the gateway's queue is the queue a
		// stalled socket holds.
		const stalled = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events", "none");
		assert.equal(await stalled.ready, 200, "the stream opened");

		// A second, reading consumer of the same session, attached before the flood: it must keep working while the
		// stalled one is being ended.
		const healthy = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events");
		assert.equal(await healthy.ready, 200);

		// The shell writes several times the budget while the stalled connection accepts nothing. The flood is over when
		// the reading consumer has seen its last piece, which is the only fact that says the producer is done.
		await emitVolume(fixture, id, FLOOD, 4 * 1024);
		await healthy.until((all) => payloads(all).reduce((total, event) => total + (typeof event.data === "string" ? event.data.length : 0), 0) >= FLOOD, "the whole flood on the reading consumer");
		const delivered = payloads(healthy.frames()).reduce((total, event) => total + (typeof event.data === "string" ? event.data.length : 0), 0);
		assert.ok(delivered >= FLOOD, "a reading consumer lost output: it saw " + delivered + " of " + FLOOD + " bytes");

		// The stalled consumer's connection was ended by the budget: the gateway destroyed the socket rather than leaving
		// a flood queued on a connection nobody is going to read.
		await stalled.closed;
		t.diagnostic("the stalled consumer's connection ended after " + stalled.connection.received + " bytes, peaking at " + stalled.connection.peak + " queued against a " + BUDGET + "-byte budget; a reading consumer received all " + delivered + " characters");
		assert.equal(stalled.connection.destroyed, true, "the stalled consumer's connection was not ended");
		assert.ok(stalled.connection.peak > BUDGET, "the stalled consumer's queue never crossed the budget, so this case proves nothing: " + stalled.connection.peak);
		// The queue stays bounded by the budget plus the one frame being written, which is what makes the bound a bound.
		assert.ok(stalled.connection.peak <= BUDGET + 8 * 1024, "the stalled consumer's queue outgrew the budget by more than one frame: " + stalled.connection.peak);

		// The shell is untouched: the session is still live and takes input, which is the whole point of ending the
		// consumer rather than the session.
		const described = await fixture.describe(id);
		assert.equal(described.ok, true, JSON.stringify(described));
		assert.equal(described.exited, false, "the shell outlived the connection that could not read it");

		// The reading consumer is still attached and still receiving: it sees output written after the disconnect.
		fixture.emit(id, "after-disconnect");
		await healthy.until((all) => payloads(all).some((event) => typeof event.data === "string" && event.data.includes("after-disconnect")), "output after the other consumer was ended");
		healthy.cancel();

		// A reconnect after a budget disconnect is a continuation of the session, not a new one: the caller is answered
		// from the session's own retained tail with a reset, which is what makes the disconnect recoverable.
		const resumed = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events?after=0");
		await resumed.until((all) => payloads(all).length > 0, "the retained tail after the disconnect");
		const first = payloads(resumed.frames())[0] as { data: string; reset?: boolean };
		assert.equal(first.reset, true, "a caller behind the retained tail is told the stream reset");
		assert.equal(first.data.length <= TERMINAL_REPLAY_CHARS, true, "the replay exceeded the retained bound: " + first.data.length);
		resumed.cancel();
		stalled.cancel();
	} finally {
		fixture.close();
	}
});

test("a replay larger than the budget still advances the caller instead of looping", async (t) => {
	// The one outcome the bound must not cause: an attach whose replay is larger than the budget being refused, leaving
	// the caller with no cursor so every reconnect is answered with the same replay and the same refusal. The budget is
	// stated far below the retained tail here, which is the shape of that case without emitting megabytes.
	const BUDGET = 8 * 1024;
	const fixture = start({ streamBudgetBytes: BUDGET });
	try {
		const id = await fixture.open("workspace-1", "big-replay");
		// The shell's output is control characters, so the replay frame is many times the budget on its own: each of
		// them is escaped by JSON at six bytes on the wire.
		await emitVolume(fixture, id, TERMINAL_REPLAY_CHARS + 64 * 1024, 32 * 1024, "\u0001");

		// The first attach must deliver a whole replay frame, cursor and all, even though that frame is larger than the
		// budget: the caller then holds a cursor, so its next attach is a continuation rather than a repetition.
		const first = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events");
		await first.until((all) => payloads(all).some((event) => event.type === "output" && typeof event.data === "string" && event.data.length > BUDGET), "a replay larger than the budget");
		const replay = payloads(first.frames()).find((event) => event.type === "output")!;
		assert.equal(replay.reset, true);
		assert.ok((replay.data as string).length > BUDGET, "the replay frame was not larger than the budget, so this case proves nothing");
		const cursor = Number(replay.offset);
		t.diagnostic("a " + BUDGET + "-byte budget still delivered a " + (replay.data as string).length + "-character replay frame with cursor " + cursor);
		first.cancel();

		// A reconnect from that cursor is a continuation: no reset, and nothing the caller already read is repeated.
		const resumed = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events?after=" + cursor);
		fixture.emit(id, "live-after-big-replay");
		const after = await resumed.until((all) => payloads(all).some((event) => typeof event.data === "string" && event.data.includes("live-after-big-replay")), "the continuation to carry new output");
		const continued = payloads(after).filter((event) => event.type === "output");
		assert.equal(continued.some((event) => event.reset === true), false, "the continuation was answered with a reset instead of continuing from the cursor");
		resumed.cancel();
	} finally {
		fixture.close();
	}
});

test("a reading-but-slow consumer receives a large bounded replay whole: write back-pressure alone never disconnects", async (t) => {
	// The policy's other half. A write the socket takes late only means the connection passed its water mark; it is not
	// a disconnect. A consumer that keeps reading, however slowly, must be served its whole legal replay. The budget is
	// stated small here so the replay crosses the connection's water mark repeatedly, and the reader answers each write
	// a turn late — so back-pressure is genuinely present while the total stays bounded.
	const BUDGET = 512 * 1024;
	const VOLUME = 1 * 1024 * 1024;
	const fixture = start({ streamBudgetBytes: BUDGET });
	try {
		const id = await fixture.open("workspace-1", "slow-reader");
		await emitVolume(fixture, id, VOLUME, 8 * 1024);

		const slow = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events?after=0", "slow");
		assert.equal(await slow.ready, 200);
		// The whole retained tail arrives: the connection was not ended for back-pressure alone.
		const all = await slow.until((frames) => payloads(frames).reduce((total, event) => total + (typeof event.data === "string" ? event.data.length : 0), 0) > TERMINAL_REPLAY_CHARS / 2, "the retained tail on a slow reader");
		const received = payloads(all).reduce((total, event) => total + (typeof event.data === "string" ? event.data.length : 0), 0);
		t.diagnostic("a reading-but-slow consumer received " + received + " characters, peaking at " + slow.connection.peak + " queued against a " + BUDGET + "-byte budget, and was not disconnected (ended=" + slow.ended() + ")");
		assert.equal(slow.ended(), false, "the connection was ended although the consumer kept reading within its budget");
		assert.equal(slow.connection.destroyed, false, "the connection was destroyed although the consumer kept reading");
		assert.ok(slow.connection.peak > 0, "no back-pressure was present, so this case proves nothing");
		assert.ok(slow.connection.peak <= BUDGET, "a slow but reading consumer's queue crossed the budget: " + slow.connection.peak);
		slow.cancel();
	} finally {
		fixture.close();
	}
});

test("repeated attach and detach leaves no attachment behind: the session's lease still runs out", async (t) => {
	// A leaked subscription would hold the session open forever, because an attached caller is exactly what stops the
	// reconnect lease. Five attaches and detaches, then the lease must still close and forget the session — asserted on
	// the lease's own timer, so the case takes no time rather than waiting a window out.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const fixture = start({ reconnectMs: 400 });
	try {
		const id = await fixture.open("workspace-1", "churn-tab");
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const attached = fixture.stream("/v1/terminal/" + encodeURIComponent(id) + "/events");
			assert.equal(await attached.ready, 200, "attach " + attempt);
			await attached.until((all) => all.length > 0, "the replay of attach " + attempt);
			attached.cancel();
			await attached.closed;
		}
		// Detaching arms the lease again: the window is the sessions' own stated one, so no attachment was left holding
		// the session.
		await flush();
		await flush();

		// The window runs out: the shell is asked to end, and its exit is reported as the session's.
		t.mock.timers.tick(400);
		await flush();
		const closed = await fixture.describe(id);
		assert.equal(closed.ok, true, "the session was forgotten before its shell ended: " + JSON.stringify(closed));
		assert.equal(closed.exited, true, "the window ran out without ending the shell: " + JSON.stringify(closed));

		// The exit re-arms the window, and that one forgets the session: no attachment, no shell, nothing left behind.
		t.mock.timers.tick(400);
		await flush();
		const forgotten = await fixture.describe(id);
		assert.equal(forgotten.ok, false, "the session was never forgotten: " + JSON.stringify(forgotten));
		assert.equal(forgotten.code, "unknown_terminal", JSON.stringify(forgotten));
	} finally {
		fixture.close();
	}
});

test("a legal aggregate replay of several tabs' control output arrives whole, within the budget", async (t) => {
	// The worst encoding a legal replay can have: the retained tail is control characters, each escaped by JSON at six
	// bytes. Three such tabs is the largest aggregate a page attaches, and it must arrive without the connection being
	// ended — a budget below it would make a healthy caller reconnect in a loop.
	const fixture = start();
	try {
		const tabs = ["replay-a", "replay-b", "replay-c"];
		for (const id of tabs) {
			await fixture.open("workspace-1", id);
			// More than the retained bound, so the attach is answered with the tail and a reset rather than with the
			// exact continuation of a cursor that is still inside what is kept.
			await emitVolume(fixture, id, TERMINAL_REPLAY_CHARS + 64 * 1024, 32 * 1024, "\u0001");
		}
		const query = tabs.map((id) => encodeURIComponent(id) + ":0").join(",");
		const reader = fixture.stream("/v1/terminal/events?tabs=" + query);
		assert.equal(await reader.ready, 200);
		// The replay is the first frame each tab is sent: the wait is for a frame per tab that is a whole retained tail,
		// and the assertion is on the *first* output frame each tab received, which is the replay's own place in the
		// stream.
		const isReplay = (event: Record<string, unknown>): boolean => event.type === "output" && typeof event.data === "string" && (event.data as string).length > TERMINAL_REPLAY_CHARS / 2;
		const all = await reader.until((frames) => tabs.every((id) => payloads(frames).some((event) => event.id === id && isReplay(event))), "every tab's replay");
		const firstByTab = new Map<string, Record<string, unknown>>();
		for (const event of payloads(all)) {
			const id = String(event.id);
			if (event.type === "output" && !firstByTab.has(id)) firstByTab.set(id, event);
		}
		for (const id of tabs) {
			const event = firstByTab.get(id);
			assert.ok(event !== undefined, "no output frame for " + id);
			assert.equal(event.reset, true, id + " was not told its stream reset");
			assert.ok((event.data as string).length <= TERMINAL_REPLAY_CHARS, id + "'s replay exceeded the retained bound: " + (event.data as string).length);
			assert.ok((event.data as string).length > TERMINAL_REPLAY_CHARS / 2, id + "'s replay was not the retained tail: " + (event.data as string).length);
		}
		const wire = reader.bytes();
		t.diagnostic("three tabs of " + TERMINAL_REPLAY_CHARS + " control characters replayed in " + wire + " wire bytes (budget " + TERMINAL_STREAM_BUDGET_BYTES + ")");
		assert.ok(wire > TERMINAL_REPLAY_CHARS * 3, "the worst-case replay should be larger than its payload: " + wire);
		assert.ok(wire < TERMINAL_STREAM_BUDGET_BYTES, "a legal aggregate replay must fit the budget, not end the connection: " + wire);

		// The stream is still open after the whole aggregate arrived, which is what proves nothing ended it.
		fixture.emit(tabs[0]!, "live-after-replay");
		await reader.until((frames) => payloads(frames).some((event) => typeof event.data === "string" && event.data.includes("live-after-replay")), "live output after the aggregate replay");
		assert.equal(reader.ended(), false, "the aggregate replay ended the connection");
		reader.cancel();
	} finally {
		fixture.close();
	}
});

/** Let the gateway's own promises and this process's streams run: no timer, so nothing is waited for, only turned. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 4; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
