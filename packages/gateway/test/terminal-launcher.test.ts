import assert from "node:assert/strict";
import { test } from "node:test";
import {
	GatewayRpcServer,
	LocalGateway,
	SshGateway,
	TerminalSessions,
	WorkspaceRegistry,
	localTerminalLauncher,
	sshTerminalLauncher,
	sshWorkspaceSeed,
	type SshRunner,
} from "../src/index.ts";
import { failingSshRunner } from "./ssh-transport.ts";
import { gatewayHttp } from "./gateway-http.ts";

/**
 * The two terminal launchers, and what a host that cannot serve a session answers with.
 *
 * `terminal.test.ts` asserts the session store with an injected launcher and lists, at its end, the cases it dropped
 * because they belong to the launcher: "an SSH transport that cannot hold a session open answers `not_supported`" and "a
 * host with no `python3` answers `not_supported` naming python3". This file is those owners. A host that is gone is the
 * SSH launcher's classification (`code 255`), a missing helper program is the local launcher's, and in both cases the
 * caller has to be handed a named reason rather than a session that never produces output or an empty success.
 *
 * The transport is the repository's own fake (`ssh-transport.ts`): a real child process that writes what a real host
 * writes and ends with the code a real host ends with, so the framing, the readiness wait and the failure classification
 * all run unmodified. Nothing here needs a network, a daemon, a credential or a pseudoterminal.
 */

const TOKEN = "terminal-launcher-token";
const PROFILE = { id: "prod", host: "builder@fake-host", remoteRoot: "/srv/app", port: 2222, identityFile: "/keys/id", knownHostsFile: "/keys/known" };
const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed([PROFILE]));
const WORKSPACE_ID = "remote-prod";
const GATEWAY_ID = "ssh-gateway";

/** One SSH gateway's terminal launcher, composed the way `startup.ts` composes it. */
function sshLauncher(runner: SshRunner, workspaces = sshWorkspaces) {
	return { workspaces, store: new TerminalSessions({ id: GATEWAY_ID, workspaces, launcher: sshTerminalLauncher({ profiles: [PROFILE], runner, workspaces }) }) };
}

/**
 * The store's answer about a session id it was never given: `describe` is the only way to ask, and its refusal names the
 * reason. Narrowed here once, so the two callers state the same fact about a session that never started.
 */
function absentSessionCode(store: TerminalSessions, id = "anything"): string {
	const described = store.describe(id);
	assert.equal(described.ok, false, "a session that never started was left in the store: " + JSON.stringify(described));
	return (described as unknown as { code: string }).code;
}

/**
 * Open a session on a host that cannot serve one, and read back the named reason plus the fact that nothing was left
 * behind: a session id the store still holds, or an `ok: true` answer, is the failure this asserts against.
 */
async function refusal(store: TerminalSessions): Promise<{ readonly code: string; readonly message?: string }> {
	const opened = await store.open({ gatewayId: GATEWAY_ID, workspaceId: WORKSPACE_ID, cols: 80, rows: 24 });
	assert.equal(opened.ok, false, "a host that cannot serve a terminal was reported as a session: " + JSON.stringify(opened));
	const failure = opened as unknown as { code: string; message?: string };
	assert.equal(absentSessionCode(store), "unknown_terminal");
	return failure;
}

// ---------------------------------------------------------------- the SSH launcher's classifications

test("an SSH host that cannot be reached ends the open as unreachable, not as a session or an empty success", async () => {
	const failure = await refusal(sshLauncher(failingSshRunner({ stderr: "ssh: connect to host fake-host port 2222: Connection refused\n", exitCode: 255 })).store);
	assert.equal(failure.code, "unreachable");
	assert.equal(failure.message, "the SSH host is unreachable");
});

/**
 * An SSH host with no `python3` on PATH: the same named limit the local launcher answers for an absent program, and the
 * same one the SSH filesystem answers for that host fact (`ssh-filesystem.ts`'s `#death`). Over SSH the absence arrives
 * as the host's stderr and exit 127 instead of as a spawn error, so the launcher's shared classification reads that.
 */
test("an SSH host whose python3 is not on PATH answers not_supported naming python3", async () => {
	const failure = await refusal(sshLauncher(failingSshRunner({ stderr: "bash: line 1: python3: command not found\n", exitCode: 127 })).store);
	assert.equal(failure.code, "not_supported");
	assert.match(String(failure.message), /python3/);
});

test("an SSH host whose python3 has no pty module answers not_supported naming pty", async () => {
	const failure = await refusal(sshLauncher(failingSshRunner({ stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'pty'\n", exitCode: 1 })).store);
	assert.equal(failure.code, "not_supported");
	assert.match(String(failure.message), /pty/);
});

test("an SSH host that ends for a reason with no name gives its own last line, and never an empty session", async () => {
	const failure = await refusal(sshLauncher(failingSshRunner({ stderr: "could not get a pseudo terminal: Operation not permitted\n", exitCode: 1 })).store);
	assert.equal(failure.code, "operation_failed");
	assert.equal(failure.message, "could not get a pseudo terminal: Operation not permitted");
});

test("an SSH transport that cannot hold a session open answers a named limit and starts nothing", async () => {
	// A runner with only the one-shot path: a terminal needs pipes that outlive a request, so the capability is absent
	// and the answer says so before any host is contacted.
	const executeOnly: SshRunner = { execute: async () => { throw new Error("this transport has no session path"); } };
	const failure = await refusal(sshLauncher(executeOnly).store);
	assert.equal(failure.code, "not_supported");
	assert.match(String(failure.message), /terminal session/);
});

test("a workspace no profile owns never reaches the SSH transport", async () => {
	let opens = 0;
	const counting: SshRunner = {
		execute: async () => { throw new Error("not asked"); },
		open: (request) => { opens += 1; return failingSshRunner({ exitCode: 255 }).open!(request); },
	};
	const { store } = sshLauncher(counting);
	assert.deepEqual(await store.open({ gatewayId: GATEWAY_ID, workspaceId: "not-registered", cols: 80, rows: 24 }), { ok: false, code: "unknown_workspace" });
	assert.equal(opens, 0, "a workspace this gateway does not serve reached the transport");
});

// ---------------------------------------------------------------- the local launcher's own classification

/** A launcher whose host program cannot start at all: `spawn` reports it the way any absent program is reported. */
function missingPythonLauncher(): TerminalSessions {
	return new TerminalSessions({
		id: "workstation",
		workspaces: new WorkspaceRegistry([{ id: "workspace-1", root: "/work" }]),
		launcher: localTerminalLauncher({ python: "hepi-terminal-launcher-no-such-python" }),
	});
}

test("a machine with no python3 on PATH answers not_supported naming python3", async () => {
	const store = missingPythonLauncher();
	const opened = await store.open({ gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 });
	assert.equal(opened.ok, false, JSON.stringify(opened));
	const failure = opened as unknown as { code: string; message?: string };
	assert.equal(failure.code, "not_supported");
	assert.match(String(failure.message), /python3/);
	assert.equal(absentSessionCode(store), "unknown_terminal");
});

// ---------------------------------------------------------------- the same answers on the gateway's own route

/**
 * One gateway's terminal surface, addressed without binding a port: the refusal has to survive the route's own status
 * and JSON shape, which is what the panel reads to decide what it can say about this host.
 */
async function refusedOpen(gateway: { close(): Promise<void> }, server: GatewayRpcServer, body: string): Promise<{ status: number; code?: string; message?: string }> {
	const http = gatewayHttp(server.server);
	try {
		const response = await http.call({ method: "POST", path: "/v1/terminal", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body });
		return { status: response.status, ...(JSON.parse(response.body.toString("utf8")) as { code?: string; message?: string }) };
	} finally {
		http.close();
		await gateway.close();
	}
}

test("the SSH gateway's terminal route answers an unreachable host by name, with no session behind it", async () => {
	const workspaces = sshWorkspaces;
	const runner = failingSshRunner({ stderr: "ssh: connect to host fake-host port 2222: Connection refused\n", exitCode: 255 });
	const store = sshLauncher(runner, workspaces).store;
	const server = new GatewayRpcServer(
		new SshGateway({ id: GATEWAY_ID, token: TOKEN, profiles: [PROFILE], allowedCommands: [], runner: { execute: async () => { throw new Error("not asked"); } }, workspaces }),
		undefined, undefined, undefined, undefined, undefined, store,
	);
	const answer = await refusedOpen({ close: async () => { await store.closeAll(); } }, server, JSON.stringify({ gatewayId: GATEWAY_ID, workspaceId: WORKSPACE_ID, cols: 80, rows: 24 }));
	assert.equal(answer.code, "unreachable", JSON.stringify(answer));
	// A refused open keeps one refusal status whatever the named reason, and `501` stays the answer of a gateway composed
	// without the capability at all (`terminal.test.ts`). The reason travels in the body, which is what the panel shows.
	assert.equal(answer.status, 409, JSON.stringify(answer));
});

test("the local gateway's terminal route answers a missing helper as the named limit it is", async () => {
	const registry = new WorkspaceRegistry([{ id: "workspace-1", root: "/work" }]);
	const store = missingPythonLauncher();
	const server = new GatewayRpcServer(
		new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }),
		undefined, undefined, undefined, undefined, undefined, store,
	);
	const answer = await refusedOpen({ close: async () => { await store.closeAll(); } }, server, JSON.stringify({ gatewayId: "workstation", workspaceId: "workspace-1", cols: 80, rows: 24 }));
	assert.equal(answer.code, "not_supported", JSON.stringify(answer));
	assert.match(String(answer.message), /python3/);
	// A refused open keeps the route's refusal status, with the reason in the body: `501` is the answer of a gateway
	// composed without the capability at all (`terminal.test.ts`), which is a different fact about the deployment.
	assert.equal(answer.status, 409, JSON.stringify(answer));
});

test("the SSH gateway's terminal route answers a host with no python3 as the same named limit the local host gives", async () => {
	const workspaces = sshWorkspaces;
	const store = sshLauncher(failingSshRunner({ stderr: "bash: line 1: python3: command not found\n", exitCode: 127 }), workspaces).store;
	const server = new GatewayRpcServer(
		new SshGateway({ id: GATEWAY_ID, token: TOKEN, profiles: [PROFILE], allowedCommands: [], runner: { execute: async () => { throw new Error("not asked"); } }, workspaces }),
		undefined, undefined, undefined, undefined, undefined, store,
	);
	const answer = await refusedOpen({ close: async () => { await store.closeAll(); } }, server, JSON.stringify({ gatewayId: GATEWAY_ID, workspaceId: WORKSPACE_ID, cols: 80, rows: 24 }));
	assert.equal(answer.code, "not_supported", JSON.stringify(answer));
	assert.equal(answer.status, 409, JSON.stringify(answer));
});
