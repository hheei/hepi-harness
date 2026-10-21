import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	GatewayRpcServer,
	LocalGateway,
	TerminalSessions,
	WorkspaceRegistry,
	localTerminalLauncher,
} from "../src/index.ts";

/**
 * The terminal event stream's idle keepalive, asserted at the gateway's own wire.
 *
 * A terminal is quiet most of its life: nothing is written between the replay and the next keystroke. The gateway
 * writes a comment frame — an SSE line with no event — on a fixed cadence, so a transport's idle bound cannot tear
 * down an attached stream and make the panel reconnect and take a reset.
 *
 * The cadence is shortened through the terminal sessions' own option, so the wait is for a frame the gateway wrote,
 * never a sleep, and the replay/exit behaviour is asserted unchanged beside it.
 */

const TOKEN = "terminal-heartbeat-token";
const HEARTBEAT_MS = 40;
/** How long a frame that must arrive is waited for before the test calls it absent. */
const DEADLINE_MS = 5_000;

type Reader = {
	/** Every frame received so far, in order. A comment frame is exactly `":"`. */
	frames(): string[];
	/** Resolves with the frames once the predicate holds, or fails at the deadline. */
	until(predicate: (frames: string[]) => boolean, description: string): Promise<string[]>;
	/** Whether the stream is over: its body was fully read or its connection dropped. */
	ended(): boolean;
	cancel(): Promise<void>;
};

function reader(response: Response): Reader {
	const frames: string[] = [];
	const waiters: (() => void)[] = [];
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
	const stream = response.body!.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let done = false;
	void (async () => {
		while (true) {
			const chunk = await stream.read().catch(() => ({ done: true as const, value: undefined }));
			if (chunk.done) { done = true; wake(); return; }
			pending += decoder.decode(chunk.value, { stream: true });
			let boundary: number;
			while ((boundary = pending.indexOf("\n\n")) >= 0) {
				frames.push(pending.slice(0, boundary));
				pending = pending.slice(boundary + 2);
			}
			wake();
		}
	})();
	return {
		frames: () => [...frames],
		ended: () => done,
		async until(predicate, description) {
			// Every frame and the end of the stream both call `wake`, so the wait is woken by the thing it is waiting for
			// rather than by a clock. The deadline is only a backstop for a frame that never comes: it is one timer per
			// call, kept referenced so a silence produces a failure instead of an abandoned test, and cleared as soon as
			// a wake-up arrives so a satisfied wait does not sit on it.
			while (!predicate(frames)) {
				if (done) assert.fail("the stream ended before " + description + "; frames: " + JSON.stringify(frames));
				// Only the backstop firing is a timeout: a wake-up that arrives without satisfying the predicate is ordinary
				// progress (a frame that is not the one awaited), and the loop simply waits again.
				let expired = false;
				const backstop = new Promise<void>((resolve) => { timeout = setTimeout(() => { expired = true; resolve(); }, DEADLINE_MS); });
				await Promise.race([new Promise<void>((resolve) => { waiters.push(resolve); }), backstop]);
				clearTimeout(timeout);
				if (expired) assert.fail("timed out waiting for " + description + "; frames: " + JSON.stringify(frames));
			}
			return [...frames];
		},
		async cancel() { await stream.cancel().catch(() => {}); },
	};
}

/** A local gateway whose execution host opens a real shell, with the keepalive cadence shortened. */
async function start(): Promise<{ origin: string; id: string; root: string; close: () => Promise<void> }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-terminal-heartbeat-")));
	const id = "workstation";
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root }]);
	const terminals = new TerminalSessions({ id, workspaces: registry, launcher: localTerminalLauncher(), heartbeatIntervalMs: HEARTBEAT_MS });
	const server = new GatewayRpcServer({
		gateway: new LocalGateway({ id, token: TOKEN, workspaces: registry, allowedCommands: ["bash", "sh"] }),
		terminals,
	});
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		id,
		root,
		close: async () => { server.server.closeAllConnections(); await server.close(); await rm(root, { recursive: true, force: true }); },
	};
}

async function openSession(origin: string, workspaceId: string): Promise<string> {
	const response = await fetch(origin + "/v1/terminal", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ gatewayId: "workstation", workspaceId, cols: 80, rows: 24 }) });
	const body = await response.json() as { ok: boolean; id?: string };
	assert.equal(body.ok, true, JSON.stringify(body));
	return body.id!;
}

test("a quiet terminal stream receives comment frames and stays attached", async () => {
	const fixture = await start();
	try {
		const id = await openSession(fixture.origin, "workspace-1");
		const response = await fetch(fixture.origin + "/v1/terminal/" + encodeURIComponent(id) + "/events", { headers: { authorization: "Bearer " + TOKEN } });
		assert.equal(response.status, 200);
		const events = reader(response);
		try {
			const frames = await events.until((current) => current.filter(frame => frame === ":").length >= 2, "two comment frames on a quiet terminal");
			// The replay is still the first thing a caller sees — an output frame, cursor and all — and a comment frame
			// never carries a cursor: an `id:` line on one would move the browser's reconnect position to a place no
			// output exists, and the next reconnect would resume from a hole.
			assert.match(frames[0], /^id: [0-9]+\ndata: /, "the replay is still the first frame, with its own cursor");
			for (const frame of frames) {
				if (frame === ":") continue;
				assert.match(frame, /^(id: [0-9]+\n)?data: /, "every non-comment frame is one output or exit frame: " + JSON.stringify(frame));
			}
			assert.equal(frames.filter(frame => frame.includes("id: ")).length >= 1, true, "output frames still carry their cursors");
		} finally {
			await events.cancel();
		}
	} finally {
		await fixture.close();
	}
});

test("a comment frame is never written inside an output frame", async () => {
	const fixture = await start();
	try {
		const id = await openSession(fixture.origin, "workspace-1");
		const response = await fetch(fixture.origin + "/v1/terminal/" + encodeURIComponent(id) + "/events", { headers: { authorization: "Bearer " + TOKEN } });
		const events = reader(response);
		try {
			const frames = await events.until((current) => current.includes(":"), "a comment frame");
			for (const frame of frames) {
				if (frame === ":") continue;
				assert.equal(frame.includes("\n:"), false, "a comment line was written inside an output frame: " + JSON.stringify(frame));
				assert.match(frame, /^(id: [0-9]+\n)?data: /, "every non-comment frame is one complete event frame: " + JSON.stringify(frame));
			}
		} finally {
			await events.cancel();
		}
	} finally {
		await fixture.close();
	}
});

test("output still arrives between comment frames, and the exit frame still ends the stream", async () => {
	const fixture = await start();
	try {
		const id = await openSession(fixture.origin, "workspace-1");
		const response = await fetch(fixture.origin + "/v1/terminal/" + encodeURIComponent(id) + "/events", { headers: { authorization: "Bearer " + TOKEN } });
		const events = reader(response);
		try {
			await events.until((current) => current.includes(":"), "a comment frame");
			await fetch(fixture.origin + "/v1/terminal/" + encodeURIComponent(id) + "/input", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ data: "printf 'alive-%s\\n' ok\nexit 3\n" }) });
			const frames = await events.until((current) => current.some(frame => frame.includes("alive-ok") && frame.includes('"type":"output"')), "output after a comment frame");
			const output = frames.filter(frame => frame.includes('"type":"output"'));
			assert.equal(output.length >= 2, true, "the replay and the new output are both present");
			const exited = await events.until((current) => current.some(frame => frame.includes('"type":"exit"')), "the session's exit frame");
			assert.equal(exited.at(-1)!.includes('"exitCode":3'), true, "the exit frame carries the shell's own code");
		} finally {
			await events.cancel();
		}
	} finally {
		await fixture.close();
	}
});

test("the page's one terminal stream carries the same keepalive, and only while it holds sessions", { timeout: DEADLINE_MS }, async (t) => {
	// Both spies go on before the gateway exists: the arming happens while the stream attaches and the clearing when
	// the caller goes away, so a spy installed after either point would wrap a timer that was already armed or cleared.
	const armed = t.mock.method(globalThis, "setInterval");
	// The real `clearInterval` is captured first and the spy hands every call straight to it, so the timer is still
	// genuinely cleared — the spy observes the call, it does not replace the effect. The clear also resolves the promise
	// below, so the wait for it is woken by the clear itself instead of by polling turns or a clock.
	const realClearInterval = globalThis.clearInterval;
	let onClear = () => {};
	const clearedOnce = new Promise<void>((resolve) => { onClear = resolve; });
	const cleared = t.mock.method(globalThis, "clearInterval", (timer: Parameters<typeof clearInterval>[0]) => { realClearInterval(timer); onClear(); });
	const fixture = await start();
	try {
		const first = await openSession(fixture.origin, "workspace-1");
		const second = await openSession(fixture.origin, "workspace-1");
		const response = await fetch(fixture.origin + "/v1/terminal/events?tabs=" + encodeURIComponent(first) + ":," + encodeURIComponent(second) + ":", { headers: { authorization: "Bearer " + TOKEN } });
		assert.equal(response.status, 200);
		const events = reader(response);
		try {
			const frames = await events.until((current) => current.filter(frame => frame === ":").length >= 2, "two comment frames on a quiet fan-in stream");
			// The comment frame is written on this stream's own frame boundary, by the writer that owns it, and it carries
			// no cursor: an `id:` line on one would be read as an output offset and would move every tab's reconnect
			// position to a place no output exists.
			for (const frame of frames) {
				if (frame === ":") continue;
				assert.match(frame, /^id: [^:]+:[0-9]+\ndata: /, "a fan-in frame names its session in the cursor: " + JSON.stringify(frame));
			}
			assert.equal(frames.some(frame => frame.includes('"id":"' + first + '"')), true, "the first tab's frames are on this stream");
			// The cadence belongs to the stream while it holds sessions: it was armed once, and the caller going away
			// clears it, so a dropped connection leaves no timer armed behind it.
			assert.equal(armed.mock.callCount(), 1, "the fan-in stream did not arm exactly one keepalive");
			assert.equal(armed.mock.calls[0]?.arguments[1], HEARTBEAT_MS, "the keepalive ran at another cadence than the sessions' own");
			assert.equal(cleared.mock.callCount(), 0, "the keepalive was cleared while the stream was still attached");
		} finally {
			await events.cancel();
		}
		// The server observes the caller's departure on its own turn, so the wait is woken by the clear itself and
		// nothing polls. The only bound is the test's own `timeout` option: node:test aborts `t.signal` when it
		// expires, so a clear that never comes fails here with this message instead of hanging — and the passing path
		// creates no timer at all, rather than one that has to be cleared afterwards.
		// node:test reports an expiry as "test timed out", which says nothing about what was awaited, so the reason is
		// emitted as a diagnostic as well: it is the line that names the failure in the output. The listener is removed
		// once the wait is over because the signal also aborts when the test finishes normally — left attached, a
		// passing run would report the failure it never had.
		let onAbort = () => {};
		const signalBound = new Promise<void>((_, reject) => {
			onAbort = () => {
				t.diagnostic("the keepalive was left armed after the caller went away");
				reject(new Error("the keepalive was left armed after the caller went away"));
			};
			t.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.race([clearedOnce, signalBound]);
		} finally {
			t.signal.removeEventListener("abort", onAbort);
		}
		assert.equal(cleared.mock.callCount(), 1, "the keepalive was left armed after the caller went away");
		// The spy observes the call and forwards it to the real `clearInterval`, so the timer it is handed is the one
		// that was armed: the effect is the product's own, not a stub's.
		assert.equal(cleared.mock.calls[0]?.arguments[0], armed.mock.calls[0]?.result, "the clear did not reach the armed timer");
	} finally {
		await fixture.close();
	}
});

test("a fan-in stream that holds no session arms no keepalive", async (t) => {
	// The cadence belongs to the sessions a stream actually holds: the fan-in route arms its keepalive only when it
	// attached at least one, and at zero otherwise. The spy goes on before the gateway exists, so no `setInterval` call
	// anywhere in it can be missed — the gateway arms nothing else, so a count of zero is the whole answer.
	const armed = t.mock.method(globalThis, "setInterval");
	const fixture = await start();
	try {
		const response = await fetch(fixture.origin + "/v1/terminal/events?tabs=no-such-tab:", { headers: { authorization: "Bearer " + TOKEN } });
		assert.equal(response.status, 200);
		const events = reader(response);
		try {
			// The route answers and arms on its own turn, and the request above resolved before that turn ran, so the
			// stream is given one more turn before the absence is read. A stream that armed a timer has armed it by now.
			// One event-loop turn: `fetch` resolves once the response is flushed, and the route arms on its own turn
			// after that. A microtask would not be enough — it runs before the server's I/O callback — so the barrier is
			// a macrotask, and a stream that armed a timer has armed it by the time this line runs.
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(armed.mock.callCount(), 0, "a stream attached to no session armed a keepalive");
			assert.deepEqual(events.frames(), [], "a stream attached to no session wrote a frame");
			// It stays open — the caller named its tabs, and a refusal here would fail the tabs that do exist.
			assert.equal(events.ended(), false, "a stream attached to no session was ended");
		} finally {
			await events.cancel();
		}
	} finally {
		await fixture.close();
	}
});
