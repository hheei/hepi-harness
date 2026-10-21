import assert from "node:assert/strict";
import { test } from "node:test";
import {
	GatewayRpcServer,
	LocalGateway,
	TERMINAL_RECONNECT_MS,
	TERMINAL_REPLAY_CHARS,
	TerminalSessions,
	WorkspaceRegistry,
	type TerminalEvent,
	type TerminalHost,
	type TerminalLaunch,
	type TerminalLauncher,
	type TerminalOpenRequest,
	type TerminalOpenResult,
} from "../src/index.ts";
import { gatewayHttp, type GatewayHttp } from "./gateway-http.ts";

/**
 * The terminal capability's contract, asserted at its own seams and nowhere else.
 *
 * Two seams carry it. The session store (\`TerminalSessions\`) owns the lifecycle — open, input, resize, close, the
 * retained tail a reconnect continues from, the reconnect window, the stream's cursor and the fan-in frame — and the
 * gateway's HTTP surface (\`GatewayRpcServer\`) owns the wire form of those facts. Neither needs a process: the store is
 * built with an injected \`TerminalLauncher\`, and that launcher is the only thing in the capability that starts anything.
 *
 * What the launchers themselves do — the helper's pseudoterminal, its frame protocol, the process group a close ends,
 * and the same helper over an SSH transport — is asserted where those launchers live, by driving the host seam in
 * memory (\`host-terminal.test.ts\`) and the runner's fake transport (\`ssh-fake.ts\`). Nothing in this file spawns, reads
 * this machine's filesystem, or waits for a duration it did not itself create.
 *
 * Assertions that were a property of a real shell process rather than of this seam are listed at the end of the file,
 * where they were dropped.
 */

const TOKEN = "terminal-token";
/** The methods this file's terminal routes use. The helper's request type names the two it was written for. */
type Method = "GET" | "POST" | "DELETE";
/** How long a wait for a fact the test itself produces may take before it fails instead of hanging. */
const DEADLINE_MS = 10_000;

/**
 * One host session the test drives. Output, exit, input and resize are the test's own facts: the store under test is the
 * only thing that decides when they are produced or delivered.
 */
class FakeHost implements TerminalHost {
	readonly ready: Promise<{ readonly root: string; readonly cwd: string }>;
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: number }>;
	/** Everything the store sent to the host session, in order, so an input or resize that never arrived is visible. */
	readonly input: string[] = [];
	readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
	ended = false;
	readonly launch: TerminalLaunch;
	#resolveReady!: (resolution: { readonly root: string; readonly cwd: string }) => void;
	#rejectReady!: (failure: unknown) => void;
	#resolveExit!: (exit: { readonly exitCode: number | null; readonly signal: number }) => void;

	constructor(launch: TerminalLaunch) {
		this.launch = launch;
		this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
		this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
	}

	/** The host reports the root and directory it resolved, which is what the store then reports and runs in. */
	resolve(root = this.launch.root, cwd = this.launch.cwd): void { this.#resolveReady({ root, cwd }); }
	/** The host refuses the session: a named failure the store has to answer with and forget. */
	refuse(failure: { readonly ok: false; readonly code: string; readonly message?: string }): void { this.#rejectReady(failure); }
	write(data: string): void { this.input.push(data); }
	resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
	/** Ask the host session to end. The exit is its own report, never inferred from this call. */
	end(): void { this.ended = true; }
	/** The host's own exit, which the store turns into an exit event. */
	exitedWith(exitCode: number | null, signal = 0): void { this.#reported = true; this.#resolveExit({ exitCode, signal }); }
	/** Whether this host has reported an exit; a close waits for one, so a fixture ending must supply it. */
	#reported = false;
	/** Report an exit if this host has not already: what a fixture does before it is torn down. */
	finish(exitCode = 0): void { if (!this.#reported) this.exitedWith(exitCode); }
	/** Output as the host would produce it, through the callback the store handed the launcher. */
	say(text: string): void { this.launch.onOutput(text); }
}

/** A launcher that records every session it was asked for and starts nothing. */
function fakeLauncher(): { readonly launcher: TerminalLauncher; readonly hosts: FakeHost[] } {
	const hosts: FakeHost[] = [];
	return { hosts, launcher: (launch) => { const host = new FakeHost(launch); hosts.push(host); return host; } };
}

/** One store over a fake launcher, serving one workspace root. */
type Fixture = { readonly store: TerminalSessions; readonly hosts: FakeHost[] };

function store(root: string, options: { readonly reconnectMs?: number; readonly heartbeatIntervalMs?: number } = {}): Fixture {
	const fake = fakeLauncher();
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root }]);
	return {
		hosts: fake.hosts,
		store: new TerminalSessions({
			id: "workstation",
			workspaces: registry,
			launcher: fake.launcher,
			...(options.reconnectMs === undefined ? {} : { reconnectMs: options.reconnectMs }),
			...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
		}),
	};
}

/**
 * Tear a fixture down: every host it still holds reports the exit its close waits for, then the store is emptied.
 *
 * The store's close asks a host to end and waits for that host's own exit, so a fixture that ended nothing would leave
 * a close pending forever. Reporting the exit here is the fixture's own answer, not a fact the assertions relied on.
 */
async function shutdown(fixture: Fixture): Promise<void> {
	for (const host of fixture.hosts) host.finish();
	await fixture.store.closeAll();
}

/**
 * Wait for a fact the test itself produces, with a deadline. Nothing here polls a duration: the predicate is a fact the
 * store sets as a direct consequence of an action the test took, so the wait ends the moment it is true.
 */
async function waitUntil(predicate: () => boolean, description: string, timeoutMs = DEADLINE_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("timed out waiting for " + description);
}

/**
 * Open a session on the store and let its host accept it.
 *
 * The launcher is the seam, so the open does not finish until this test answers for the host it was handed: the call is
 * started, the host it produced is resolved, and only then is the answer awaited. Awaiting the open first would be
 * waiting for a host nobody has answered for yet.
 */
async function openOn(fixture: Fixture, request: TerminalOpenRequest, resolved?: { readonly root?: string; readonly cwd?: string }): Promise<{ readonly opened: Extract<TerminalOpenResult, { ok: true }>; readonly host: FakeHost }> {
	const before = fixture.hosts.length;
	const pending = fixture.store.open(request);
	await waitUntil(() => fixture.hosts.length > before, "the launcher to be asked for a host");
	const host = fixture.hosts.at(-1)!;
	host.resolve(resolved?.root, resolved?.cwd);
	const opened = await pending;
	assert.equal(opened.ok, true, JSON.stringify(opened));
	return { opened: opened as Extract<TerminalOpenResult, { ok: true }>, host };
}

/** One gateway serving one workspace over a fake launcher, addressed through its own HTTP seam with no port bound. */
type Gateway = { readonly http: GatewayHttp; readonly gatewayId: string; readonly store: TerminalSessions; readonly hosts: FakeHost[]; close(): Promise<void> };

async function startGateway(root = "/work"): Promise<Gateway> {
	const gatewayId = "workstation";
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root }]);
	const fake = fakeLauncher();
	const terminals = new TerminalSessions({ id: gatewayId, workspaces: registry, launcher: fake.launcher });
	const server = new GatewayRpcServer(new LocalGateway({ id: gatewayId, token: TOKEN, workspaces: registry, allowedCommands: ["bash", "sh"] }), undefined, undefined, undefined, undefined, undefined, terminals);
	// The server is handed the connection a socket would have produced, so its own parsing and routing run unmodified
	// while nothing on this machine can reach the fixture and no other test can collide with it.
	const http = gatewayHttp(server.server);
	return {
		http,
		gatewayId,
		store: terminals,
		hosts: fake.hosts,
		// Closing the gateway closes its sessions, and a session's close waits for its host's own exit: the fixture
		// supplies that exit first, so teardown is the fixture's answer rather than an assertion.
		close: async () => {
			for (const host of fake.hosts) host.finish();
			http.close();
			await server.close();
		},
	};
}

/** Opening a session through the HTTP surface, as a browser's panel does, with the host it produced left unanswered. */
function openRequest(gateway: Gateway, extra: { readonly cwd?: string; readonly id?: string; readonly cols?: number; readonly rows?: number; readonly workspaceId?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	return call(gateway.http, "/v1/terminal", "POST", {
		gatewayId: gateway.gatewayId,
		workspaceId: extra.workspaceId ?? "workspace-1",
		cols: extra.cols ?? 80,
		rows: extra.rows ?? 24,
		...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
		...(extra.id === undefined ? {} : { id: extra.id }),
	});
}

/** Open a session through the HTTP surface and let its host accept it, in that order. */
async function openThrough(gateway: Gateway, extra: { readonly cwd?: string; readonly id?: string } = {}): Promise<FakeHost> {
	const before = gateway.hosts.length;
	const pending = openRequest(gateway, extra);
	await waitUntil(() => gateway.hosts.length > before, "the gateway's launcher to be asked for a host");
	const host = gateway.hosts.at(-1)!;
	host.resolve();
	const answer = await pending;
	assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
	return host;
}

/** One request to the gateway's terminal surface, with the answer it gave. */
async function call(http: GatewayHttp, path: string, method: Method = "POST", body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await http.call({ method: method as "GET" | "POST", path, headers: { authorization: "Bearer " + TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
	return { status: response.status, body: JSON.parse(response.body.toString("utf8")) as Record<string, unknown> };
}

/** One frame the stream delivered, kept as its own wire text so the cursor field itself can be asserted. */
type Wire = { readonly id?: string; readonly event: Record<string, unknown>; readonly raw: string };

/**
 * A terminal event stream, read frame by frame from the gateway's HTTP surface.
 *
 * Every wait is a frame the store produced or the caller's own cancellation: the stream's frames are kept whole so a
 * test can assert the wire form — the \`id\` field a browser records as its cursor — and not only the decoded event.
 */
async function attach(http: GatewayHttp, path: string): Promise<{
	readonly frames: readonly Wire[];
	text(): string;
	waitFor(predicate: (text: string) => boolean, description: string): Promise<void>;
	stop(): Promise<void>;
}> {
	// The answer is handed back while the gateway is still writing it, so the body below is the server's own response
	// stream: frames are read as they are produced rather than collected at the end.
	const response = await http.stream({ method: "GET", path, headers: { authorization: "Bearer " + TOKEN } });
	assert.equal(response.status, 200, "attaching to " + path + " answered " + response.status);
	const reader = response.body;
	const decoder = new TextDecoder();
	const frames: Wire[] = [];
	const waiters: (() => void)[] = [];
	let pending = "";
	let ended = false;
	let text = "";
	const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
	void (async () => {
		while (true) {
			// An async iterator holds the body paused between reads, so no frame is emitted into a listener that is not
			// there yet: a chunk that arrived while the test was asserting would be lost by a per-iteration listener.
			const chunk = await reader[Symbol.asyncIterator]().next().catch(() => ({ done: true as const, value: undefined }));
			if (chunk.done) break;
			pending += decoder.decode(chunk.value, { stream: true });
			let boundary: number;
			while ((boundary = pending.indexOf("\n\n")) >= 0) {
				const raw = pending.slice(0, boundary);
				pending = pending.slice(boundary + 2);
				const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
				if (dataLine === undefined) continue;
				const event = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
				const idLine = raw.split("\n").find((line) => line.startsWith("id: "));
				frames.push({ ...(idLine === undefined ? {} : { id: idLine.slice(4) }), event, raw });
				if (event.type === "output") text += String(event.data ?? "");
				wake();
			}
		}
		ended = true;
		wake();
	})();
	return {
		frames,
		text: () => text,
		async waitFor(predicate, description) {
			while (!predicate(text)) {
				if (ended) assert.fail("the stream ended before " + description + "; it showed " + JSON.stringify(text.slice(-400)));
				await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
		// Walking away destroys the body it was reading, which is the caller's connection going away: the gateway's own
		// response closes with it, so the session is left with no attachment rather than a stream nobody reads.
		async stop() { ended = true; reader.destroy(); },
	};
}

/** The output frames one session's tab contributed to a stream, in order. */
function outputs(frames: readonly Wire[], id?: string): Wire[] {
	return frames.filter((frame) => frame.event.type === "output" && (id === undefined || frame.event.id === id));
}

test("a session opens where its host resolved it, streams output as it is produced, and takes input and a resize", async () => {
	const fixture = store("/work");
	const pending = fixture.store.open({ gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
	await waitUntil(() => fixture.hosts.length === 1, "the launcher to be asked for one host");
	const host = fixture.hosts[0]!;
	// The host is asked for the registered root and the directory the caller named, at the size the caller laid out.
	assert.deepEqual({ root: host.launch.root, cwd: host.launch.cwd, cols: host.launch.cols, rows: host.launch.rows }, { root: "/work", cwd: "/work", cols: 80, rows: 24 });
	// The open has not answered yet: it answers once the host says where the session really runs.
	host.resolve("/work", "/work/resolved");
	const opened = await pending;
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.deepEqual({ ...(opened as { id: string }) }, { ok: true, id: (opened as { id: string }).id, workspaceId: "workspace-1", cwd: "/work/resolved", cols: 80, rows: 24 }, "the session reports the folder its host resolved, not the one it was asked for");
	const id = (opened as { id: string }).id;

	// Output the host produces is recorded as it arrives, each frame continuing the session's own offset.
	const seen: TerminalEvent[] = [];
	const subscription = fixture.store.subscribe(id, (event) => seen.push(event));
	assert.ok(subscription !== undefined);
	assert.deepEqual(subscription.replay, { data: "", offset: 0, reset: true }, "a caller with no cursor is shown the retained tail, which is empty, and told so");
	host.say("stream-");
	assert.deepEqual(seen, [{ type: "output", data: "stream-", offset: 7 }]);
	host.say("ok\n");
	assert.deepEqual(seen.at(-1), { type: "output", data: "ok\n", offset: 10 }, "the second frame continues the first frame's offset");

	// Input and a resize reach the host session itself, and the resize is the session's own new size afterwards.
	assert.deepEqual(fixture.store.write(id, "printf 'hi\n'"), { ok: true });
	assert.deepEqual(host.input, ["printf 'hi\n'"], "the input did not reach the host session");
	assert.deepEqual(fixture.store.resize(id, 100, 30), { ok: true });
	assert.deepEqual(host.resizes, [{ cols: 100, rows: 30 }], "the resize did not reach the host session");
	assert.deepEqual({ ...fixture.store.describe(id) }, { ok: true, id, workspaceId: "workspace-1", cwd: "/work/resolved", cols: 100, rows: 30, exited: false });
	// An impossible size is refused here, before the host is told anything.
	assert.deepEqual(fixture.store.resize(id, 0, 30), { ok: false, code: "invalid_request", message: "cols and rows must be positive numbers" });
	assert.equal(host.resizes.length, 1, "a refused resize never reached the host session");

	subscription.unsubscribe();
	await shutdown(fixture);
});

test("a session whose host refuses it answers that named failure and is not left behind", async () => {
	// A directory the host does not have, and one outside the root: the host confines the path, so this seam only
	// carries the request to it and reports its answer.
	for (const [cwd, asked] of [["not-there", "/work/not-there"], ["/etc", "/work/etc"]]) {
		const fixture = store("/work");
		const pending = fixture.store.open({ gatewayId: "workstation", workspaceId: "workspace-1", cwd, cols: 80, rows: 24 });
		await waitUntil(() => fixture.hosts.length === 1, "the launcher to be asked for the confined path");
		// The requested directory is path arithmetic on the registered root and nothing else: no filesystem is read here,
		// and the host is the one that decides whether the directory it was handed is one it will serve.
		assert.equal(fixture.hosts[0]!.launch.cwd, asked, "the requested directory travels to the host as a path under the registered root");
		fixture.hosts[0]!.refuse({ ok: false, code: "path_denied" });
		assert.deepEqual(await pending, { ok: false, code: "path_denied" });
		assert.equal(fixture.store.describe("anything").ok, false, "a refused session is not left behind in the store");
	}

	// A workspace this gateway does not serve, and a gateway id that is not its own, never reach a launcher at all.
	const unknown = store("/work");
	assert.deepEqual(await unknown.store.open({ gatewayId: "workstation", workspaceId: "nope", cols: 80, rows: 24 }), { ok: false, code: "unknown_workspace" });
	assert.deepEqual(await unknown.store.open({ gatewayId: "elsewhere", workspaceId: "workspace-1", cols: 80, rows: 24 }), { ok: false, code: "unknown_gateway" });
	assert.deepEqual(await unknown.store.open({ gatewayId: "workstation", workspaceId: "workspace-1", cols: 0, rows: 24 }), { ok: false, code: "invalid_request", message: "cols and rows must be positive numbers" });
	assert.equal(unknown.hosts.length, 0, "a refused open never reached a launcher");
});

test("a dropped stream reconnects from its cursor, and a caller behind the retained tail is told it reset", async () => {
	const fixture = store("/work");
	const { opened, host } = await openOn(fixture, { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });

	// A first caller reads some output and records its cursor, then goes away: the session keeps running.
	host.say("before-ok\n");
	const first = fixture.store.subscribe(opened.id, () => {});
	assert.ok(first !== undefined);
	assert.deepEqual(first.replay, { data: "before-ok\n", offset: 10, reset: true });
	const cursor = first.replay.offset;
	first.unsubscribe();

	// What the host produced while nothing was attached is exactly what a reconnect shows, and nothing before the cursor.
	host.say("missed-ok\n");
	const resumed = fixture.store.subscribe(opened.id, () => {}, cursor);
	assert.ok(resumed !== undefined);
	assert.deepEqual(resumed.replay, { data: "missed-ok\n", offset: 20, reset: false }, "a cursor inside the retained tail continues instead of resetting");
	assert.equal(resumed.replay.data.includes("before-ok"), false, "the resumed stream repeated output the cursor had already read");

	// The retained tail is bounded: a burst larger than the bound leaves the newest output, and a caller asking from
	// the beginning is told the stream reset rather than shown an inconsistent continuation.
	// Output arrives in pieces as a host produces it, so a burst is many frames rather than one enormous one.
	const piece = "x".repeat(8 * 1024);
	for (let index = 0; index < 20; index += 1) host.say(piece);
	const burst = piece.length * 20;
	const behind = fixture.store.subscribe(opened.id, () => {}, 0);
	assert.ok(behind !== undefined);
	assert.equal(behind.replay.reset, true, "a caller behind the retained tail is told the stream reset");
	assert.equal(behind.replay.data.length <= TERMINAL_REPLAY_CHARS, true, "the replay exceeded the stated bound: " + behind.replay.data.length);
	assert.equal(behind.replay.data.endsWith("x"), true, "the retained tail keeps the newest output");
	assert.equal(behind.replay.offset, 20 + burst);

	// A cursor ahead of the session, and one that is not a number, are the same reset.
	assert.equal(fixture.store.subscribe(opened.id, () => {}, behind.replay.offset + 1)!.replay.reset, true);
	assert.equal(fixture.store.subscribe(opened.id, () => {}, Number.NaN)!.replay.reset, true);
	await shutdown(fixture);
});

test("a session named by its caller is the same session, and its description says whether it is live", async () => {
	const fixture = store("/work");
	const id = "caller-named";
	const { opened, host } = await openOn(fixture, { gatewayId: "workstation", workspaceId: "workspace-1", id, cols: 80, rows: 24 }, { cwd: "/work/sub" });
	assert.equal(opened.id, id, "the session kept the caller's own name");
	assert.deepEqual({ ...fixture.store.describe(id) }, { ok: true, id, workspaceId: "workspace-1", cwd: "/work/sub", cols: 80, rows: 24, exited: false });

	// Opening the same name again reaches the running session rather than starting a second host, and answers with that
	// session's own size rather than the new request's.
	assert.deepEqual({ ...(await fixture.store.open({ gatewayId: "workstation", workspaceId: "workspace-1", id, cols: 100, rows: 30 })) }, { ok: true, id, workspaceId: "workspace-1", cwd: "/work/sub", cols: 80, rows: 24 });
	assert.equal(fixture.hosts.length, 1, "opening a known name started no second host");
	// A name already running elsewhere, and one asking for another directory, are refused rather than replaced.
	assert.equal(((await fixture.store.open({ gatewayId: "workstation", workspaceId: "other-workspace", id, cols: 80, rows: 24 })) as { code: string }).code, "unknown_workspace");
	assert.equal(((await fixture.store.open({ gatewayId: "workstation", workspaceId: "workspace-1", id, cwd: "sub", cols: 80, rows: 24 })) as { code: string }).code, "invalid_request");
	assert.equal(fixture.hosts.length, 1);

	// The host's own exit is the session's exit, and a session whose process is gone says so and takes no input.
	host.exitedWith(0);
	await waitUntil(() => fixture.store.describe(id).ok && (fixture.store.describe(id) as { exited: boolean }).exited, "the session to report its exit");
	assert.deepEqual(fixture.store.write(id, "x"), { ok: false, code: "terminal_exited" }, "a session whose host has exited takes no input");
	assert.deepEqual(fixture.store.resize(id, 10, 10), { ok: false, code: "terminal_exited" });
	// A session this gateway never held is a named outcome on every route, not an empty stream.
	assert.equal((fixture.store.describe("never-opened") as { code: string }).code, "unknown_terminal");
	assert.equal(fixture.store.subscribe("never-opened", () => {}), undefined);
	assert.deepEqual(fixture.store.write("never-opened", "x"), { ok: false, code: "unknown_terminal" });
	assert.deepEqual(fixture.store.resize("never-opened", 10, 10), { ok: false, code: "unknown_terminal" });
	assert.deepEqual(await fixture.store.close("never-opened"), { ok: false, code: "unknown_terminal" });
	await shutdown(fixture);
});

test("closing a session asks its host to end and answers the exit the host reported", async () => {
	const fixture = store("/work");
	const { opened, host } = await openOn(fixture, { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });

	// The close asks the host to end and waits for the host's own report: it does not invent one.
	const closing = fixture.store.close(opened.id);
	await waitUntil(() => host.ended, "the close to ask the host session to end");
	host.exitedWith(7);
	assert.deepEqual(await closing, { ok: true, exit: { type: "exit", exitCode: 7, signal: 0 } }, "the close answered something other than the host's own exit");

	// A session whose host already exited answers that exit without asking it a second time.
	const other = store("/work");
	const second = await openOn(other, { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
	second.host.exitedWith(null, 9);
	await waitUntil(() => (other.store.describe(second.opened.id) as { exited: boolean }).exited === true, "the host's exit to be recorded");
	assert.deepEqual(await other.store.close(second.opened.id), { ok: true, exit: { type: "exit", exitCode: null, signal: 9 } });
	assert.equal(second.host.ended, false, "a close after the exit must not end the host a second time");
	await shutdown(fixture);
	await shutdown(other);
});

test("the reconnect window closes a detached live session and forgets an ended one", async () => {
	// The two numbers this capability introduces, asserted as the values the ticket states.
	assert.equal(TERMINAL_RECONNECT_MS, 120_000);
	assert.equal(TERMINAL_REPLAY_CHARS, 128 * 1024);

	// A live session with nobody attached runs out its window and is closed, so no shell outlives its last caller.
	const live = store("/work", { reconnectMs: 5 });
	const first = await openOn(live, { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
	await waitUntil(() => first.host.ended, "the detached session's window to close its host");
	first.host.exitedWith(0);
	// Once the exit is recorded the window runs again, and this time it forgets the session.
	await waitUntil(() => live.store.describe(first.opened.id).ok === false, "the ended session to be forgotten after its window");

	// An attached session is held outright: the window does not run while a caller is attached.
	const attached = store("/work", { reconnectMs: 5 });
	const held = await openOn(attached, { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
	const subscription = attached.store.subscribe(held.opened.id, () => {});
	assert.ok(subscription !== undefined);
	// An absence is the one fact that needs a duration: the window is given longer than its own length to run, and the
	// assertion is that it did not.
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(held.host.ended, false, "an attached session must not be closed by the window");
	assert.equal(attached.store.describe(held.opened.id).ok, true, "an attached session stays in the store past its window");
	subscription.unsubscribe();
	await waitUntil(() => held.host.ended, "the window to close the session once its last caller left");
	held.host.finish();
	await shutdown(attached);
});

test("one stream carries every mounted tab, with a cursor per tab and an exit that ends only its own", async () => {
	const gateway = await startGateway();
	try {
		const a = await openThrough(gateway, { id: "tab-a" });
		const b = await openThrough(gateway, { id: "tab-b" });
		const stream = await attach(gateway.http, "/v1/terminal/events?tabs=" + encodeURIComponent("tab-a:") + "," + encodeURIComponent("tab-b:"));

		// Both tabs are on the one connection, and a frame says which tab it belongs to: output sent to one is never
		// delivered as the other's.
		a.say("a-one\n");
		await stream.waitFor((text) => text.includes("a-one"), "the first tab's own output");
		b.say("b-two\n");
		await stream.waitFor((text) => text.includes("b-two"), "the second tab's own output");
		// Each tab's first frame is the retained tail a caller with no cursor is handed, which here is empty and marked
		// as a reset; what the host produced follows it.
		assert.deepEqual(outputs(stream.frames, "tab-a").map((frame) => frame.event.data), ["", "a-one\n"]);
		assert.deepEqual(outputs(stream.frames, "tab-b").map((frame) => frame.event.data), ["", "b-two\n"]);

		// Each tab has its own cursor, and it is the offset that tab's own frames reported.
		const cursors = { a: Number(outputs(stream.frames, "tab-a").at(-1)!.event.offset), b: Number(outputs(stream.frames, "tab-b").at(-1)!.event.offset) };
		assert.deepEqual(cursors, { a: 6, b: 6 }, "each tab's frames carry that tab's own offset");

		// A dropped connection is a continuation: each tab resumes from its own cursor and is shown exactly what it
		// missed, with no reset.
		await stream.stop();
		a.say("a-missed\n");
		const resumed = await attach(gateway.http, "/v1/terminal/events?tabs=" + encodeURIComponent("tab-a:" + cursors.a) + "," + encodeURIComponent("tab-b:" + cursors.b));
		await resumed.waitFor((text) => text.includes("a-missed"), "the output produced while the stream was away");
		assert.deepEqual(outputs(resumed.frames, "tab-a").map((frame) => frame.event.data), ["a-missed\n"], "the resumed tab was shown what it missed and nothing it had already read");
		assert.equal(outputs(resumed.frames, "tab-a")[0]!.event.reset, false, "a cursor inside the retained tail continues instead of resetting");

		// A tab this gateway does not know is not an error for the tabs that do.
		const partial = await attach(gateway.http, "/v1/terminal/events?tabs=" + encodeURIComponent("tab-b:" + cursors.b) + ",no-such-tab:");
		b.say("b-after-unknown\n");
		await partial.waitFor((text) => text.includes("b-after-unknown"), "a known tab's output beside an unknown one");

		// One tab's exit ends that tab's frames and nothing else: the stream stays open for the tab still running.
		a.exitedWith(3);
		// The exit travels on the stream that names that tab, and only as that tab's frame.
		await waitUntil(() => resumed.frames.some((frame) => frame.event.type === "exit"), "the exited tab's own exit on the stream that carries it");
		assert.deepEqual(resumed.frames.find((frame) => frame.event.type === "exit")!.event, { type: "exit", id: "tab-a", exitCode: 3, signal: 0 });
		assert.equal(partial.frames.some((frame) => frame.event.type === "exit"), false, "a tab another stream carries must not report its exit on this one");
		b.say("b-still-here\n");
		await partial.waitFor((text) => text.includes("b-still-here"), "the surviving tab after its neighbour exited");
		await partial.stop();
		await resumed.stop();
	} finally {
		await gateway.close();
	}
});

test("each output frame carries its offset as the event stream's own id field", async () => {
	const gateway = await startGateway();
	try {
		const host = await openThrough(gateway, { id: "cursor-tab" });
		const stream = await attach(gateway.http, "/v1/terminal/" + encodeURIComponent("cursor-tab") + "/events");
		host.say("hello\n");
		await stream.waitFor((text) => text.includes("hello"), "an output frame");
		const frame = outputs(stream.frames)[0]!;
		const lines = frame.raw.split("\n");
		// The field name is exactly \`id\`: everything before the colon is the name, and any space there is part of it.
		const name = lines.find((line) => line.includes("id"))!.split(":")[0];
		assert.equal(name, "id", "the cursor was written as the field " + JSON.stringify(name) + " rather than \"id\", so no browser records a cursor: " + JSON.stringify(frame.raw));
		assert.match(lines.find((line) => line.startsWith("id: "))!, /^id: \d+$/, "the id field is not a plain offset: " + JSON.stringify(frame.raw));
		// The cursor is the offset the frame's own payload reports, so the two can never disagree.
		assert.equal(frame.id, String(frame.event.offset), "the cursor and the frame's own offset disagree: " + JSON.stringify(frame.raw));
		await stream.stop();
	} finally {
		await gateway.close();
	}
});

test("a gateway with no terminal capability answers a named limit, and an unknown session is named as such", async () => {
	// A gateway composed without the terminal capability: the limit is the host, and it says so.
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root: "/work" }]);
	const bare = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }));
	const bareHttp = gatewayHttp(bare.server);
	try {
		const refused = await call(bareHttp, "/v1/terminal", "POST", { gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
		assert.equal(refused.status, 501);
		assert.equal(refused.body.code, "not_supported");
		assert.match(String(refused.body.message ?? ""), /terminal/);
		// An unauthenticated caller never reaches the capability at all.
		assert.equal((await bareHttp.call({ method: "POST", path: "/v1/terminal", body: "{}" })).status, 401);
	} finally {
		bareHttp.close();
		await bare.close();
	}

	// A live gateway names a session it does not hold, on both the stream and the close.
	const gateway = await startGateway();
	try {
		const missing = await call(gateway.http, "/v1/terminal/not-a-session/events", "GET");
		assert.equal(missing.status, 404);
		assert.deepEqual(missing.body, { ok: false, code: "unknown_terminal" });
		assert.deepEqual((await call(gateway.http, "/v1/terminal/not-a-session", "DELETE")).body, { ok: false, code: "unknown_terminal" });
	} finally {
		await gateway.close();
	}
});

test("the HTTP surface reports the folder the host resolved, and refuses a directory the host did not accept", async () => {
	const gateway = await startGateway();
	try {
		// A relative cwd is the logical workspace form: it travels to the host, which resolves and confines it.
		const before = gateway.hosts.length;
		const pending = openRequest(gateway, { cwd: "." });
		await waitUntil(() => gateway.hosts.length > before, "the launcher to be asked for the relative directory");
		const host = gateway.hosts.at(-1)!;
		assert.equal(host.launch.cwd, "/work", "a relative directory is resolved against the registered root");
		host.resolve("/work", "/work/real");
		const opened = await pending;
		assert.deepEqual({ ok: opened.body.ok, cwd: opened.body.cwd, cols: opened.body.cols, rows: opened.body.rows }, { ok: true, cwd: "/work/real", cols: 80, rows: 24 });

		// A directory the host refuses is the host's answer, carried through unchanged.
		const refusedBefore = gateway.hosts.length;
		const refusedPending = openRequest(gateway, { cwd: "/etc" });
		await waitUntil(() => gateway.hosts.length > refusedBefore, "the launcher to be asked for the outside directory");
		gateway.hosts.at(-1)!.refuse({ ok: false, code: "path_denied" });
		const refused = await refusedPending;
		assert.deepEqual(refused.body, { ok: false, code: "path_denied" });

		// A workspace this gateway does not serve is refused by the store before any host is asked.
		const hostsBefore = gateway.hosts.length;
		assert.deepEqual((await openRequest(gateway, { workspaceId: "nope" })).body, { ok: false, code: "unknown_workspace" });
		assert.equal(gateway.hosts.length, hostsBefore);
	} finally {
		await gateway.close();
	}
});

/*
 * Assertions this file no longer makes, and where each one lives instead.
 *
 * Every case below was a property of a real process on a real host — a shell, a pseudoterminal, an SSH daemon — and not
 * of the seam this file asserts. None of them is dropped from the project; each is either covered by the launcher's own
 * seam or is a stated limit of what a fake host can express.
 *
 * Moved to the launcher seams:
 * - "the shell starts in the root the session reports" (`printf '%s' "$PWD"`) — the store now asserts that the folder
 *   the host resolved is what it reports and runs in; that a real shell's `$PWD` equals it is the helper's own
 *   contract, covered where the helper is driven (`host-terminal.test.ts`, `ssh-fake.ts`).
 * - "output arrives while a command is still running, gated on a FIFO" — the live-stream property is asserted here by
 *   producing output between two reads of an open stream; that a real command's output is not buffered to its exit is
 *   the helper's framing, covered by its own seam.
 * - "a resize is visible to the shell as `stty size`" — the store asserts the size reaches the host and is the
 *   session's reported size afterwards; the pseudoterminal's `TIOCSWINSZ` is the helper's.
 * - "the shell's own `exit 7` becomes an exit of 7" — the store asserts the exit the host reports is the exit it
 *   answers; the helper mapping a child's status onto that frame is its own seam.
 * - "closing ends the shell's process group, so a `sleep` child dies too" — this is the helper's process-group
 *   handling and is asserted where the helper runs; here the close is asserted to ask the host to end and to answer
 *   that host's own exit.
 * - "a remote root that does not exist on this machine is resolved there" and "an SSH host confines a directory" — the
 *   remote resolution and confinement belong to the SSH launcher and its transport; `ssh-fake.ts` drives them, and
 *   this file asserts only that a path travels to the host and that the host's refusal is carried through unchanged.
 * - "an SSH transport that cannot hold a session open answers `not_supported`" — that decision is made inside
 *   `sshTerminalLauncher` before a host exists, so it is asserted at that launcher rather than through the store.
 * - "a host with no `python3` answers `not_supported` naming python3" — the classification of a missing helper is
 *   the local launcher's own; here a host that cannot serve a session is expressed as the store's `not_supported`
 *   refusal path, and the message that names the program is the launcher's.
 * - "a real shell's pid is not reused and `process.kill(pid, 0)` proves liveness" — a fake host has no pid. The
 *   session's own liveness fact, its exit, replaces it.
 *
 * Not representable at this seam at all:
 * - the pseudoterminal's echo and line discipline (a keystroke coming back as output) — a fake host's input is
 *   recorded, never interpreted;
 * - a real TCP reconnect after the socket is torn down by a network fault — the stream here is the gateway's own HTTP
 *   seam in memory, so a reconnect is a second attach with a cursor, which is the contract the browser depends on.
 */
