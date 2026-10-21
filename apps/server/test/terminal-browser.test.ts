import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
	GatewayRpcServer,
	LocalGateway,
	TerminalSessions,
	WorkspaceRegistry,
} from "@hepi/gateway";
import { createBackendServer, type BackendServer } from "../src/server.ts";

/**
 * The browser's terminal route on the backend, asserted at that boundary.
 *
 * The browser never reaches an execution host directly: it names a routing cwd on every request and the backend resolves
 * that to the workspace binding that owns it. That resolution, the command surface, the stream's replay cursor, the
 * close and the caller's own cancellation are what this file covers.
 *
 * The execution host behind the route is an in-memory fake, not a shell: a `TerminalHost` is the seam the gateway
 * already defines, so a test that drives input, resize, output and exit itself covers the whole route without spawning
 * `node-pty`, python or a login shell. The real host program is covered where it lives
 * (`packages/gateway/test/terminal.test.ts`), and the route's own relay and cancellation at its own seam
 * (`apps/server/test/terminal-relay.test.ts`). What is left here is the contract the browser sees: open, input, resize,
 * replay, close, and a caller that goes away.
 */

const TOKEN = "browser-terminal-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
/** How long one wait for a frame the fake host produced may take before the test fails instead of hanging. */
const FRAME_TIMEOUT_MS = 10_000;

/**
 * The execution host's own seam, read from the one exported thing that states it: a `TerminalSessions` is built from a
 * launcher, so the launcher's parameter, its answer and the host it returns are the types its constructor already names.
 * Nothing here declares a second copy of the host contract that could drift from the gateway's.
 */
type Launcher = NonNullable<ConstructorParameters<typeof TerminalSessions>[0]["launcher"]>;
type Launch = Parameters<Launcher>[0];
type Host = ReturnType<Launcher>;
/** The root and working directory a host resolves for one session. */
type Resolution = Awaited<Host["ready"]>;

/**
 * One shell the test drives itself. Input and resize are recorded rather than performed, and output and exit are the
 * test's to give, so every wait is a fact this file created instead of a duration.
 */
class FakeTerminal implements Host {
	readonly ready: Promise<Resolution>;
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: number }>;
	readonly written: string[] = [];
	readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
	ended = false;
	readonly #output: (text: string) => void;
	#resolveExit!: (exit: { readonly exitCode: number | null; readonly signal: number }) => void;
	#resolveReady!: (resolution: Resolution) => void;

	constructor(launch: Launch) {
		this.#output = launch.onOutput;
		this.ready = new Promise<Resolution>((resolve) => { this.#resolveReady = resolve; });
		this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
		// The host reports the root and directory it resolved; here that is the pair it was asked for.
		this.#resolveReady({ root: launch.root, cwd: launch.cwd });
	}

	write(data: string): void { this.written.push(data); }
	resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }

	/** Ask the session to end: the exit is the host's report, never inferred from this call. */
	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.#resolveExit({ exitCode: 0, signal: 0 });
	}

	/** Output as the shell would produce it, delivered through the host's own callback. */
	say(text: string): void { this.#output(text); }
}

type Fixture = {
	/** The backend the browser talks to: every request below goes to this origin. */
	readonly origin: string;
	readonly workspaceId: string;
	readonly root: string;
	/** The routing cwd the browser names, which is what the backend resolves to the workspace above. */
	readonly cwd: string;
	/** Every session the fake host started, in the order it was asked to. */
	readonly shells: FakeTerminal[];
	close(): Promise<void>;
};

/**
 * A backend in front of a gateway whose execution host serves terminals from memory. Composed the way the deployment
 * composes it: the gateway holds the sessions and the backend holds the workspace binding that reaches it.
 */
async function startFixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "hepi-browser-terminal-"));
	const directory = await mkdtemp(join(tmpdir(), "hepi-browser-terminal-db-"));
	const shells: FakeTerminal[] = [];
	const launcher: Launcher = (launch) => {
		const shell = new FakeTerminal(launch);
		shells.push(shell);
		return shell;
	};
	const workspaceId = "local";
	const registry = new WorkspaceRegistry([{ id: workspaceId, root }]);
	const terminals = new TerminalSessions({ id: "workstation", workspaces: registry, launcher });
	const gateway = new GatewayRpcServer(
		new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] }),
		undefined, undefined, undefined, undefined, undefined, terminals,
	);
	await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
	const address = gateway.server.address();
	assert.ok(address !== null && typeof address === "object");
	const models = createModels();
	models.setProvider(fauxProvider().provider);
	const backend: BackendServer = await createBackendServer({
		dbPath: join(directory, "browser.sqlite"),
		authToken: TOKEN,
		models,
		workspaces: [{ id: workspaceId, gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" }],
	});
	await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress !== null && typeof backendAddress === "object");
	return {
		origin: "http://127.0.0.1:" + backendAddress.port,
		workspaceId,
		root,
		cwd: "/workspace/" + workspaceId,
		shells,
		close: async () => {
			backend.server.closeAllConnections();
			await backend.close();
			gateway.server.closeAllConnections();
			await gateway.close();
			await rm(directory, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** One output frame's data and the offset it reports, read from the browser route's own stream. */
type Frame = { readonly data: string; readonly offset: number; readonly reset: boolean };

/** One decoded read, or the fact that the stream ended. */
type Read = { readonly text: string; readonly frames: readonly Frame[]; readonly exit?: { readonly exitCode: number | null; readonly signal: number }; readonly ended: boolean };

/**
 * The browser route's event stream, read frame by frame.
 *
 * Every wait is a frame the host produced or the caller's own cancellation, never a sleep: `until` pulls reads until
 * the predicate holds, the stream ends, the caller aborts or the deadline passes, and the last of those is a failure
 * rather than a hang.
 */
async function attach(origin: string, cwd: string, id: string, after?: number, signal?: AbortSignal): Promise<{ until(predicate: (text: string) => boolean, timeoutMs?: number): Promise<Read>; stop(): Promise<void> }> {
	const query = "?cwd=" + encodeURIComponent(cwd) + (after === undefined ? "" : "&after=" + after);
	const response = await fetch(origin + "/api/terminal/" + encodeURIComponent(id) + "/events" + query, { headers: { authorization: "Bearer " + TOKEN }, ...(signal === undefined ? {} : { signal }) });
	assert.equal(response.status, 200, "attaching through the browser route answered " + response.status);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let text = "";
	const frames: Frame[] = [];
	let exit: { exitCode: number | null; signal: number } | undefined;
	let ended = false;
	return {
		async until(predicate, timeoutMs = FRAME_TIMEOUT_MS) {
			const deadline = Date.now() + timeoutMs;
			while (!predicate(text) && !ended) {
				if (signal?.aborted === true) { ended = true; break; }
				const remaining = deadline - Date.now();
				assert.ok(remaining > 0, "the browser route produced no frame the test was waiting for: " + JSON.stringify(text.slice(-300)));
				const chunk = await Promise.race([
					reader.read(),
					new Promise<{ done: true; value: undefined }>((resolve) => { setTimeout(() => resolve({ done: true, value: undefined }), remaining).unref?.(); }),
				]).catch((error: unknown) => {
					// The caller's own cancellation ends the read: that is the fact under test, not a failure to read.
					if (signal?.aborted === true) return { done: true as const, value: undefined };
					throw error;
				});
				if (chunk.done) { ended = true; break; }
				pending += decoder.decode(chunk.value, { stream: true });
				let boundary: number;
				while ((boundary = pending.indexOf("\n\n")) >= 0) {
					const raw = pending.slice(0, boundary);
					pending = pending.slice(boundary + 2);
					const line = raw.split("\n").find((value) => value.startsWith("data: "));
					if (line === undefined) continue;
					const event = JSON.parse(line.slice(6)) as { type: string; data?: string; offset?: number; reset?: boolean; exitCode?: number | null; signal?: number };
					if (event.type === "output") {
						frames.push({ data: event.data ?? "", offset: event.offset ?? 0, reset: event.reset === true });
						text += event.data ?? "";
					} else exit = { exitCode: event.exitCode ?? null, signal: event.signal ?? 0 };
				}
			}
			return { text, frames, ...(exit === undefined ? {} : { exit }), ended };
		},
		async stop() { ended = true; await reader.cancel().catch(() => {}); },
	};
}

/** One command through the browser's own command surface, with the answer it gave. */
async function command(origin: string, cwd: string, id: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(origin + "/api/terminal/" + encodeURIComponent(id) + "?cwd=" + encodeURIComponent(cwd), { method: "POST", headers, body: JSON.stringify(body) });
	return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** Opening a session through the browser route, as the panel does: its own id, its cwd and the size it laid out. */
async function open(origin: string, cwd: string, id: string, cols = 80, rows = 24): Promise<{ ok: boolean; id: string; cwd: string; cols: number; rows: number }> {
	const response = await fetch(origin + "/api/terminal?cwd=" + encodeURIComponent(cwd), { method: "POST", headers, body: JSON.stringify({ id, cwd, cols, rows }) });
	const answer = await response.text();
	assert.equal(response.status, 200, answer);
	return JSON.parse(answer) as { ok: boolean; id: string; cwd: string; cols: number; rows: number };
}

test("the browser's terminal route opens, types, resizes, replays and closes against a fake host", { timeout: 30_000 }, async () => {
	const fixture = await startFixture();
	try {
		// Opening: the browser names its own session id, the workspace it belongs to and the size it laid out, and the
		// answer carries the folder the host really started the shell in.
		const session = await open(fixture.origin, fixture.cwd, "browser-session");
		assert.deepEqual({ ok: session.ok, id: session.id, cols: session.cols, rows: session.rows }, { ok: true, id: "browser-session", cols: 80, rows: 24 });
		assert.ok(session.cwd.startsWith("/"), "the answer names the folder the shell opened in: " + session.cwd);
		assert.equal(fixture.shells.length, 1, "opening started exactly one host session");
		const shell = fixture.shells[0]!;
		assert.deepEqual({ cols: shell.resizes.length, written: shell.written.length }, { cols: 0, written: 0 }, "a fresh session has taken no input yet");

		// Typing: the bytes reach the host session as the browser sent them.
		const typed = await command(fixture.origin, fixture.cwd, session.id, { type: "input", data: "printf 'browser-%s\\n' ok\n" });
		assert.deepEqual(typed, { status: 200, body: { ok: true } });
		assert.deepEqual(shell.written, ["printf 'browser-%s\\n' ok\n"], "the keystrokes did not reach the host session");

		// Output: what the host produces is what the browser's stream carries, with the offset it belongs at.
		const stream = await attach(fixture.origin, fixture.cwd, session.id);
		shell.say("browser-ok\n");
		const printed = await stream.until((text) => text.includes("browser-ok"));
		assert.ok(printed.text.includes("browser-ok"), "the host's output did not arrive: " + JSON.stringify(printed.text.slice(-300)));
		const cursor = printed.frames.at(-1)!.offset;
		assert.ok(cursor > 0, "the stream reported no output offset");

		// Resizing: the size reaches the host session, which is what the shell would be laid out at.
		const resized = await command(fixture.origin, fixture.cwd, session.id, { type: "resize", cols: 100, rows: 30 });
		assert.deepEqual(resized, { status: 200, body: { ok: true } });
		assert.deepEqual(shell.resizes, [{ cols: 100, rows: 30 }], "the resize did not reach the host session");

		// A reconnect from a cursor continues: the replay is what was produced since, and it does not reset.
		await stream.stop();
		shell.say("missed-ok\n");
		const resumed = await attach(fixture.origin, fixture.cwd, session.id, cursor);
		const replayed = await resumed.until((text) => text.includes("missed-ok"));
		assert.equal(replayed.frames[0]?.reset, false, "a cursor inside the retained tail must continue rather than reset");
		assert.ok(replayed.text.includes("missed-ok"), "the resumed stream did not carry the output produced while away: " + JSON.stringify(replayed.text.slice(-300)));
		assert.equal(replayed.text.includes("browser-ok"), false, "the resumed stream repeated output the cursor had already read");
		await resumed.stop();

		// A cwd that names no workspace is refused by name, before any host is asked.
		const unknown = await fetch(fixture.origin + "/api/terminal?cwd=" + encodeURIComponent("/workspace/nope"), { method: "POST", headers, body: JSON.stringify({ id: "x", cwd: "/workspace/nope", cols: 80, rows: 24 }) });
		assert.equal(unknown.status, 404);
		assert.deepEqual(await unknown.json(), { ok: false, code: "unknown_workspace" });
		// A cwd that is not a workspace path at all is the capability's own named limit.
		const unbound = await fetch(fixture.origin + "/api/terminal?cwd=" + encodeURIComponent("/durable"), { method: "POST", headers, body: JSON.stringify({ id: "x", cwd: "/durable", cols: 80, rows: 24 }) });
		assert.equal(unbound.status, 501);
		assert.equal(((await unbound.json()) as { code: string }).code, "not_supported");
		assert.equal(fixture.shells.length, 1, "a refused open never reached the host");

		// Closing answers the exit the host reported, and the host session is ended by it.
		const closed = await fetch(fixture.origin + "/api/terminal/" + encodeURIComponent(session.id) + "?cwd=" + encodeURIComponent(fixture.cwd), { method: "DELETE", headers });
		const closedText = await closed.text();
		assert.equal(closed.status, 200, closedText);
		const answer = JSON.parse(closedText) as { ok: boolean; exit: { exitCode: number | null } };
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(answer.exit.exitCode, 0, "the close did not answer the exit the host reported: " + closedText);
		assert.equal(shell.ended, true, "the close never asked the host session to end");

		// A session that has ended still answers its exit, so a caller that missed it never waits for one.
		const ended = await attach(fixture.origin, fixture.cwd, session.id);
		const exit = await ended.until(() => false);
		assert.equal(exit.ended, true, "an ended session must still answer its exit");
		assert.deepEqual(exit.exit, { exitCode: 0, signal: 0 }, "the ended session did not report its exit");
		await ended.stop();
	} finally {
		await fixture.close();
	}
});

test("a browser that goes away mid-stream leaves the session it was reading", { timeout: 30_000 }, async () => {
	const fixture = await startFixture();
	const caller = new AbortController();
	try {
		const session = await open(fixture.origin, fixture.cwd, "browser-cancelled");
		const shell = fixture.shells[0]!;
		const stream = await attach(fixture.origin, fixture.cwd, session.id, undefined, caller.signal);
		shell.say("attached\n");
		const live = await stream.until((text) => text.includes("attached"));
		assert.ok(live.text.includes("attached"));
		const cursor = live.frames.at(-1)!.offset;

		// The browser goes away while the host has nothing to send: the stream ends, and the session does not.
		caller.abort();
		const closed = await stream.until(() => false);
		assert.equal(closed.ended, true, "the caller's own cancellation did not end its stream");
		const described = await fetch(fixture.origin + "/api/terminal/" + encodeURIComponent(session.id) + "?cwd=" + encodeURIComponent(fixture.cwd), { headers: { authorization: "Bearer " + TOKEN } });
		assert.equal(described.status, 200);
		assert.deepEqual(await described.json(), { ok: true, id: session.id, workspaceId: fixture.workspaceId, cwd: session.cwd, cols: 80, rows: 24, exited: false });

		// The output produced while nobody was attached is what the next attach replays from the caller's own cursor.
		shell.say("while-away\n");
		const resumed = await attach(fixture.origin, fixture.cwd, session.id, cursor);
		const replayed = await resumed.until((text) => text.includes("while-away"));
		assert.equal(replayed.frames[0]?.reset, false, "a reconnect from the caller's cursor must continue rather than reset");
		assert.ok(replayed.text.includes("while-away"), "the session did not replay what it produced while the caller was away: " + JSON.stringify(replayed.text.slice(-300)));
		await resumed.stop();
		assert.equal(shell.ended, false, "a caller that went away must not end the session it was reading");
	} finally {
		caller.abort();
		await fixture.close();
	}
});
