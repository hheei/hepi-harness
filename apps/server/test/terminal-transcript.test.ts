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
	SshGateway,
	TerminalSessions,
	WorkspaceRegistry,
	sshWorkspaceSeed,
	type SshProfile,
	type SshRunner,
	type TerminalHost,
	type TerminalLaunch,
	type TerminalLauncher,
} from "@hepi/gateway";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

/**
 * A terminal is a host session with its own lifecycle, and nothing about it reaches a conversation.
 *
 * The claim is asserted against the conversation's own record read back through the durable API, which is the only thing
 * that can prove no transcript was written to. The terminal itself runs on an injected `TerminalHost`: the gateway's
 * terminal surface is what this file covers, so the execution host is a fake the test drives — it produces the output
 * the panel would see, and reports its own exit. Nothing here starts a shell, an SSH daemon or any other process.
 *
 * What the launchers do — the helper's pseudoterminal on a local host, and the same helper over an SSH transport — is
 * asserted where those launchers live (`packages/gateway/test/host-terminal.test.ts` and the runner's fake transport in
 * `packages/gateway/test/ssh-fake.ts`). Here the two host shapes differ only in routing: which gateway id and workspace a
 * caller names, and which root that workspace resolves to.
 *
 * Every wait is a fact this file produced. A host is handed to the launcher, the host ends when the close asks it to, the
 * conversation states it is idle on its own event stream, and the terminal's bytes arrive on the stream the panel reads.
 * No wait is a duration, so a missing fact fails the test through its own bound instead of being waited out.
 */

const TOKEN = "transcript-token";
const GATEWAY_TOKEN = "gateway-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
/**
 * The bound a stream this file holds may sit quiet for. It is a property of the transport, not a deadline the test races:
 * a stream that never carries the fact under test is aborted and fails its read.
 */
const STREAM_BOUND_MS = 5_000;
/** One test's own bound, so a stuck fixture fails instead of holding the file. */
const TEST_TIMEOUT_MS = 6_000;

type Exit = { readonly exitCode: number | null; readonly signal: number };
type Resolution = { readonly root: string; readonly cwd: string };

/** One execution host session the test drives, on either host shape. */
class FakeHost implements TerminalHost {
	readonly ready: Promise<Resolution>;
	readonly exited: Promise<Exit>;
	readonly input: string[] = [];
	readonly resizes: { readonly cols: number; readonly rows: number }[] = [];
	readonly launch: TerminalLaunch;
	/** Resolves when the session asked this host to end, which is the fact a close waits on. */
	readonly ended: Promise<void>;
	#resolveReady!: (resolution: Resolution) => void;
	#resolveExit!: (exit: Exit) => void;
	#resolveEnded!: () => void;
	#reported = false;

	constructor(launch: TerminalLaunch) {
		this.launch = launch;
		this.ready = new Promise((resolve) => { this.#resolveReady = resolve; });
		this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
		this.ended = new Promise((resolve) => { this.#resolveEnded = resolve; });
	}

	/** The host resolves the pair it was asked for; here that is the pair itself, reported as the host's own answer. */
	resolve(): void { this.#resolveReady({ root: this.launch.root, cwd: this.launch.cwd }); }
	write(data: string): void { this.input.push(data); }
	resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
	end(): void { this.#resolveEnded(); }
	/** The host's own exit, which the session turns into its exit frame. */
	exitedWith(exitCode: number | null, signal = 0): void { this.#reported = true; this.#resolveExit({ exitCode, signal }); }
	/** Report an exit if none was reported yet: what a fixture does before it tears the gateway down. */
	finish(exitCode = 0): void { if (!this.#reported) this.exitedWith(exitCode); }
	/** Output as the host would produce it, through the callback the session handed the launcher. */
	say(text: string): void { this.launch.onOutput(text); }
}

/** A launcher that records the session it was asked for and starts nothing. */
function fakeLauncher(): { readonly launcher: TerminalLauncher; readonly next: Promise<FakeHost> } {
	let announce!: (host: FakeHost) => void;
	const next = new Promise<FakeHost>((resolve) => { announce = resolve; });
	return {
		next,
		launcher: (launch) => {
			const host = new FakeHost(launch);
			announce(host);
			return host;
		},
	};
}

/** One gateway serving a terminal, with the fake host it hands its one session to. */
type Host = {
	readonly origin: string;
	readonly gatewayId: string;
	readonly workspaceId: string;
	/** The root this workspace is registered with, as the gateway addresses it. */
	readonly root: string;
	/** The host the launcher was asked for, which is the session's own execution host. */
	readonly shell: Promise<FakeHost>;
	close(): Promise<void>;
};

/** Listen on a loopback port and answer the fixture once it is up, with the host shape it serves. */
async function listen(server: GatewayRpcServer, shape: { readonly gatewayId: string; readonly workspaceId: string; readonly root: string }, shell: Promise<FakeHost>): Promise<Host> {
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		...shape,
		shell,
		// Closing a gateway closes its sessions, and a session's close waits for its host's own exit: the fixture
		// supplies that exit first, so teardown is the fixture's answer rather than an assertion.
		close: async () => {
			(await shell).finish();
			server.server.closeAllConnections();
			await server.close();
		},
	};
}

/** A local gateway: one workspace on this execution host, addressed by the id the local host registers it under. */
async function startLocalHost(): Promise<Host> {
	const gatewayId = "workstation";
	// A root this machine does not have: a gateway that resolved the workspace locally would fail instead of routing it.
	const root = "/work";
	const registry = new WorkspaceRegistry([{ id: "local", root }]);
	const fake = fakeLauncher();
	const terminals = new TerminalSessions({ id: gatewayId, workspaces: registry, launcher: fake.launcher });
	const server = new GatewayRpcServer({
		gateway: new LocalGateway({ id: gatewayId, token: GATEWAY_TOKEN, workspaces: registry, allowedCommands: ["bash"] }),
		terminals,
	});
	return await listen(server, { gatewayId, workspaceId: "local", root }, fake.next);
}

/**
 * The same gateway shape for a remote workspace: the workspace id comes from the SSH seed, its root is a directory of
 * the remote host, and the runner refuses every command — so a passing test proves this gateway never reached a system
 * `ssh` at all. The remote root is a path this machine does not have, so a gateway that resolved it locally would fail
 * outright instead of handing it to the host.
 */
async function startSshHost(): Promise<Host> {
	const gatewayId = "workstation-ssh";
	const root = "/srv/remote-work";
	const profiles: SshProfile[] = [{ id: "prod", host: "build.example", remoteRoot: root }];
	const registry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
	// The runner refuses every command and every session: a passing test proves this gateway never reached a system ssh.
	const runner: SshRunner = {
		execute: async () => { throw new Error("this test never runs a command on an SSH host"); },
		open: () => { throw new Error("this test never opens a session on an SSH transport"); },
	};
	const fake = fakeLauncher();
	const terminals = new TerminalSessions({ id: gatewayId, workspaces: registry, launcher: fake.launcher });
	const server = new GatewayRpcServer({
		gateway: new SshGateway({ id: gatewayId, token: GATEWAY_TOKEN, profiles, allowedCommands: ["bash"], runner, workspaces: registry }),
		terminals,
	});
	return await listen(server, { gatewayId, workspaceId: "remote-prod", root }, fake.next);
}

/**
 * The routing facts of one host shape, asserted before a session is driven: which workspace id the profile seeds, and
 * which root that workspace resolves to on its own host.
 */
function assertRouting(host: Host): void {
	if (host.gatewayId === "workstation") {
		assert.deepEqual({ gatewayId: host.gatewayId, workspaceId: host.workspaceId, root: host.root }, { gatewayId: "workstation", workspaceId: "local", root: "/work" });
		return;
	}
	assert.deepEqual({ gatewayId: host.gatewayId, workspaceId: host.workspaceId, root: host.root }, { gatewayId: "workstation-ssh", workspaceId: "remote-prod", root: "/srv/remote-work" }, "an SSH profile seeds one workspace per profile, named by that profile and rooted at its remote root");
}

/** The gateway's own terminal surface, with the credential the gateway itself checks. */
function call(host: Host, path: string, method = "POST", body?: unknown): Promise<Response> {
	return fetch(host.origin + path, { method, headers: { authorization: "Bearer " + GATEWAY_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/**
 * One terminal session driven to completion over the gateway's own surface: open, input, resize, output, close.
 *
 * Every step is a request the panel makes and a fact this file supplies, so nothing is waited for that the test did not
 * itself cause. The output the host produces is the text a shell would print, which is what makes the transcript
 * assertion meaningful: it is a string that would be unmistakable if it ever reached a conversation.
 */
async function runTerminal(host: Host, marker: string): Promise<void> {
	assertRouting(host);
	// The open does not answer until the host says where the session runs, so the host this launcher was asked for is
	// resolved first and the answer is awaited second.
	const opening = call(host, "/v1/terminal", "POST", { gatewayId: host.gatewayId, workspaceId: host.workspaceId, cols: 80, rows: 24 });
	const shell = await host.shell;
	// The routing the caller named reached the launcher: this workspace's own root, untouched, at the size it laid out.
	assert.deepEqual({ workspaceId: shell.launch.workspaceId, root: shell.launch.root, cwd: shell.launch.cwd, cols: shell.launch.cols, rows: shell.launch.rows }, { workspaceId: host.workspaceId, root: host.root, cwd: host.root, cols: 80, rows: 24 });
	shell.resolve();
	const opened = await opening;
	const session = await opened.json() as { ok: boolean; id: string; cwd: string };
	assert.equal(session.ok, true, JSON.stringify(session));
	assert.equal(session.cwd, host.root, "the session reports the folder the host resolved for this workspace");

	const command = async (path: string, body: unknown): Promise<void> => {
		const answer = await call(host, "/v1/terminal/" + encodeURIComponent(session.id) + "/" + path, "POST", body);
		assert.deepEqual(await answer.json(), { ok: true });
	};
	const typed = "echo transcript-probe-" + marker + "\n";
	await command("input", { data: typed });
	await command("resize", { cols: 100, rows: 30 });
	assert.deepEqual(shell.input, [typed], "the keystrokes did not reach the host session");
	assert.deepEqual(shell.resizes, [{ cols: 100, rows: 30 }], "the resize did not reach the host session");

	// The host answers what the command would have printed before the panel attaches, so the panel's first frame is the
	// session's own replay of it: the read below is answered by bytes the fixture already produced.
	shell.say("transcript-probe-" + marker + "\n");
	const events = await call(host, "/v1/terminal/" + encodeURIComponent(session.id) + "/events", "GET");
	assert.equal(events.status, 200);
	const reader = events.body!.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	try {
		while (!seen.includes("transcript-probe-" + marker)) {
			const chunk = await reader.read();
			if (chunk.done) assert.fail("the stream ended before the host's output arrived: " + JSON.stringify(seen.slice(-200)));
			seen += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}

	// The close asks the host to end and answers the exit the host reported, so the session is over when it returns.
	const closing = call(host, "/v1/terminal/" + encodeURIComponent(session.id), "DELETE");
	await shell.ended;
	shell.exitedWith(0);
	const closed = await closing;
	assert.deepEqual(await closed.json(), { ok: true, exit: { type: "exit", exitCode: 0, signal: 0 } });
}

type Entry = ServerSnapshot["entries"][number];
type Frame = { readonly event: string; readonly data: unknown; readonly window: HeldWindow<Entry> };

/**
 * One conversation's own event stream, folded the way a client folds it. `next` is the barrier: it resolves on the
 * frame that satisfies the predicate, so the test is told the conversation settled instead of asking whether it has.
 */
async function openConversation(origin: string, id: string): Promise<{ next(match: (frame: Frame) => boolean): Promise<Frame>; close(): Promise<void> }> {
	const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(STREAM_BOUND_MS) });
	assert.equal(response.status, 200);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const folder = streamFolder<Entry>(id);
	const frames: Frame[] = [];
	let pending = "";
	return {
		async next(match) {
			while (true) {
				const found = frames.findIndex(match);
				if (found >= 0) return frames.splice(found, 1)[0]!;
				const chunk = await reader.read();
				if (chunk.done) assert.fail("the conversation stream ended before the frame under test arrived");
				pending += decoder.decode(chunk.value, { stream: true });
				let boundary: number;
				while ((boundary = pending.indexOf("\n\n")) >= 0) {
					const raw = pending.slice(0, boundary);
					pending = pending.slice(boundary + 2);
					const event = /^event: (.*)$/m.exec(raw)?.[1];
					const line = raw.split("\n").find((value) => value.startsWith("data: "));
					if (event === undefined || line === undefined) continue;
					const data = JSON.parse(line.slice(6));
					if (event === "snapshot" || event === "state") folder.fold(event, data);
					frames.push({ event, data, window: folder.current() });
				}
			}
		},
		close: async () => { await reader.cancel().catch(() => {}); },
	};
}

/**
 * A terminal is a host session with its own lifecycle: nothing about it reaches the conversation. The assertion is the
 * conversation's own record read back through the durable API, which is the only thing that can prove a transcript was
 * not written to.
 */
async function transcriptCase(name: string, start: () => Promise<Host>, marker: string): Promise<void> {
	test(name + ": a terminal session writes no entry to the conversation's transcript", { timeout: TEST_TIMEOUT_MS }, async () => {
		const host = await start();
		const directory = await mkdtemp(join(tmpdir(), "hepi-terminal-transcript-"));
		const models = createModels();
		models.setProvider(fauxProvider().provider);
		const backend: BackendServer = await createBackendServer({
			dbPath: join(directory, "transcript.sqlite"),
			authToken: TOKEN,
			models,
			workspaces: [{ id: host.workspaceId, gatewayId: host.gatewayId, gatewayOrigin: host.origin, gatewayToken: GATEWAY_TOKEN }],
			defaultModel: SERVER_MODEL,
		});
		await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
		const address = backend.server.address();
		assert.ok(address !== null && typeof address === "object");
		const origin = "http://127.0.0.1:" + address.port;
		try {
			const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: host.workspaceId }) });
			const createdBody = await created.text();
			assert.equal(created.status, 201, createdBody);
			const id = (JSON.parse(createdBody) as { conversationId: string }).conversationId;
			const settled = async (): Promise<ServerSnapshot> => {
				const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
				return await response.json() as ServerSnapshot;
			};
			const catalogue = async (): Promise<{ id: string; messageCount: number }[]> =>
				((await (await fetch(origin + "/api/conversations", { headers })).json()) as { conversations: { id: string; messageCount: number }[] }).conversations;
			// The turn is read to its end on the conversation's own stream, so "the run is over" is a frame the backend
			// stated rather than a state this file re-asked for until it happened to be true.
			const stream = await openConversation(origin, id);
			try {
				const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "before-terminal", text: "one turn" }) });
				assert.equal(submit.status, 202, await submit.text());
				await stream.next((frame) => (frame.event === "state" || frame.event === "snapshot") && !frame.window.busy && frame.window.entries.some((entry) => entry.role === "assistant"));
			} finally {
				await stream.close();
			}
			const before = await settled();
			assert.ok(before.entries.length > 0, "the conversation recorded no entries to compare against");
			const rowsBefore = await catalogue();

			await runTerminal(host, marker);

			const after = await settled();
			assert.deepEqual(after.entries, before.entries, "the terminal changed the conversation's transcript");
			// The terminal's own text is nowhere in what the conversation kept: not as an entry, not as a message.
			assert.equal(JSON.stringify(after.entries).includes("transcript-probe-" + marker), false, "the terminal's output reached the conversation's transcript");
			// The catalogue agrees: a terminal opened no conversation and added no message to this one.
			assert.deepEqual(await catalogue(), rowsBefore, "the terminal changed the conversation catalogue");
		} finally {
			backend.server.closeAllConnections();
			await backend.close();
			await host.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}

transcriptCase("local gateway", startLocalHost, "local");
transcriptCase("SSH gateway", startSshHost, "ssh");
