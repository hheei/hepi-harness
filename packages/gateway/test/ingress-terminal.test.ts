import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { startGateway, type RunningGateway } from "../src/startup.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";
import type { SshRunner } from "../src/index.ts";

/**
 * The terminal fan-in at the client ingress: a Web page or an App opens several terminals on one stream, writes to
 * them, resizes them, resumes each tab from its own cursor and closes them — all under the cookie or the device bearer,
 * and all routed by the Backend to the execution host that really holds each workspace.
 *
 * Everything asserted here is what a client sees: real HTTP, real SSE bytes, a real shell on a real host. The local host
 * is a real gateway process on this machine; the SSH host is the same composition over the repository's Python
 * transport fixture, so the SSH launcher's own argv, the remote workspace id and the helper on the far side are
 * exercised without a daemon, a key or a login. The ingress is the only surface the caller touches, so nothing below
 * can pass by reaching around it.
 *
 * The two things a terminal adds to the conversation slice are asserted as such: **one stream for every mounted tab**
 * (the page's connection budget), and **routing by the tab's own workspace** (an ingress serving one host must still
 * reach the host a tab's cwd names).
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const BACKEND_TOKEN = "ingress-terminal-backend-token";
const LOCAL_TOKEN = "local-execution-token";
const SSH_TOKEN = "ssh-execution-token";
const WEB_LOGIN = "ingress-terminal-login";
const TEST_TIMEOUT_MS = 120_000;

/**
 * The SSH transport of the remote host, answered by this machine: the terminal helper is the real Python program, the
 * argv is exactly the one the SSH launcher builds, and only the transport is local — which is the fixture the
 * repository's other SSH suites use (`ssh-transport.ts`), reduced to the one program a terminal names.
 *
 * It is stated here rather than reused because the filesystem fixture decodes every frame it forwards as a JSON request,
 * and a terminal's frames are its own protocol: reading them as filesystem requests would be a second interpretation of
 * a stream that belongs to the helper.
 */
function terminalSshRunner(): SshRunner {
	return {
		execute: async () => { throw new Error("this transport serves terminal sessions only"); },
		open: (request) => {
			assert.deepEqual(request.command.slice(0, 2), ["python3", "-c"], "the launcher's own argv prefix");
			assert.equal(request.command[4], request.root, "the session carries its own root");
			return spawn("python3", ["-c", request.command[2]!, request.command[3]!, ...request.command.slice(4)], { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"] });
		},
	};
}

type Fixture = {
	readonly origin: string;
	readonly backend: BackendServer;
	readonly ingress: ClientIngress;
	readonly local: RunningGateway;
	readonly ssh: RunningGateway;
	readonly localRoot: string;
	readonly sshRoot: string;
	readonly cookie: string;
	readonly deviceToken: string;
	/** The Backend's terminal streams still attached upstream, counted on the Backend's own server. */
	upstreamOpen(): number;
	/** Every request the ingress itself was asked to serve: the fact that says nothing looped back into it. */
	readonly served: string[];
	close(): Promise<void>;
};

/** One local gateway, one SSH-composed gateway over the Python transport fixture, one Backend, one client ingress. */
async function fixture(t: TestContext): Promise<Fixture> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-terminal-")));
	directories.push(directory);
	const localRoot = join(directory, "local-project");
	const sshRoot = join(directory, "remote-project");
	await mkdir(localRoot);
	await mkdir(sshRoot);

	const local = await startGateway({ mode: "local", gatewayId: "workstation", token: LOCAL_TOKEN, workspaceId: "local", workspaceRoot: localRoot, allowedCommands: [], port: 0, databasePath: join(directory, "local.sqlite") });
	const ssh = await startGateway({
		mode: "ssh", gatewayId: "workstation-ssh", token: SSH_TOKEN, workspaceId: "remote-loopback", workspaceRoot: sshRoot, allowedCommands: [], port: 0,
		databasePath: join(directory, "ssh.sqlite"),
		ssh: { profile: "loopback", host: "loopback.example" },
		sshTransport: { plain: terminalSshRunner(), controlDirectory: false },
	});

	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const backend = await createBackendServer({
		dbPath: join(directory, "hepi.sqlite"),
		authToken: BACKEND_TOKEN,
		models: fauxModels(),
		defaultModel: SERVER_MODEL,
		deviceCredentials: credentials,
		buildId: "build-1",
		backendId: "backend-1",
		accountScope: "account-1",
		gateways: [
			{ gatewayId: "workstation", gatewayOrigin: local.origin, gatewayToken: LOCAL_TOKEN },
			{ gatewayId: "workstation-ssh", gatewayOrigin: ssh.origin, gatewayToken: SSH_TOKEN },
		],
		workspaces: [
			{ id: "local", gatewayId: "workstation", gatewayOrigin: local.origin, gatewayToken: LOCAL_TOKEN },
			{ id: "remote-loopback", gatewayId: "workstation-ssh", gatewayOrigin: ssh.origin, gatewayToken: SSH_TOKEN },
		],
	});
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress && typeof backendAddress === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN, defaultHostId: "workstation" });
	const served: string[] = [];
	ingress.server.on("request", request => { served.push((request.method ?? "GET") + " " + (request.url ?? "/")); });
	let upstreamStreams = 0;
	backend.server.on("request", (request, response) => {
		if (!(request.url ?? "").startsWith("/api/terminal/events")) return;
		upstreamStreams += 1;
		response.on("close", () => { upstreamStreams -= 1; });
	});
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;

	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="), "the login set the Web session cookie");
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
	assert.equal(issued.status, 201);
	const deviceToken = ((await issued.json()) as { token: string }).token;
	served.length = 0;
	t.after(async () => { await ingress.close(); credentials.close(); await backend.close(); await local.close(); await ssh.close(); });
	return { origin, backend, ingress, local, ssh, localRoot, sshRoot, cookie, deviceToken, upstreamOpen: () => upstreamStreams, served, close: async () => {} };
}

/** The cookie a browser attaches by itself, and nothing else. */
const cookieHeaders = (target: Fixture) => ({ cookie: target.cookie });
/** One explicit device bearer, the way a native shell presents its identity. */
const bearerHeaders = (target: Fixture) => ({ authorization: "Bearer " + target.deviceToken });

/** The routing cwd of one workspace, which is the only thing a terminal request carries about its host. */
const cwdOf = (workspaceId: string) => "/workspace/" + workspaceId;

/** Open one tab: the session id, its workspace and the size the panel laid out. */
async function open(target: Fixture, headers: Record<string, string>, workspaceId: string, id: string, size = { cols: 80, rows: 24 }): Promise<Record<string, unknown>> {
	const response = await fetch(target.origin + "/api/terminal?cwd=" + encodeURIComponent(cwdOf(workspaceId)), {
		method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id, cwd: cwdOf(workspaceId), ...size }),
	});
	return await response.json() as Record<string, unknown>;
}

/** One command on a tab: the shape the panel's writer already sends. */
async function command(target: Fixture, headers: Record<string, string>, workspaceId: string, id: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(target.origin + "/api/terminal/" + encodeURIComponent(id) + "?cwd=" + encodeURIComponent(cwdOf(workspaceId)), {
		method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
	});
	return await response.json() as Record<string, unknown>;
}

const input = (target: Fixture, headers: Record<string, string>, workspaceId: string, id: string, data: string) => command(target, headers, workspaceId, id, { type: "input", data });

/** The page's one stream: every named tab, each with the cursor the page holds for it. */
function fanInPath(tabs: readonly { id: string; workspaceId: string; after?: number }[]): string {
	const named = tabs.map(tab => [tab.id, cwdOf(tab.workspaceId), tab.after === undefined ? "" : String(tab.after)].map(encodeURIComponent).join("|")).join(",");
	return "/api/terminal/events?tabs=" + named;
}

/** One SSE response, framed the way the origin wrote it, with a deadline the test owns. */
function reader(response: Response, signal: AbortSignal) {
	const body = response.body!.getReader();
	const decoder = new TextDecoder();
	const frames: string[] = [];
	let pending = "";
	const pump = async (): Promise<void> => {
		while (!signal.aborted) {
			const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
			if (chunk.done) return;
			pending += decoder.decode(chunk.value, { stream: true });
			let boundary: number;
			while ((boundary = pending.indexOf("\n\n")) >= 0) {
				frames.push(pending.slice(0, boundary));
				pending = pending.slice(boundary + 2);
			}
		}
	};
	const running = pump();
	return {
		frames,
		/** Wait for frames the origin really wrote: the predicate is the barrier, the deadline only fails the test. */
		async until(predicate: (current: readonly string[]) => boolean, label: string, timeoutMs = 15_000): Promise<readonly string[]> {
			const started = Date.now();
			const deadline = started + timeoutMs;
			while (!predicate(frames)) {
				if (Date.now() > deadline) throw new Error("timed out waiting for " + label + "; frames: " + JSON.stringify(frames.slice(-4)));
				await new Promise(resolve => setTimeout(resolve, 20));
			}
			return [...frames];
		},
		/** The tab's output as one string, from the data lines of its output frames. */
		text(id: string): string {
			return frames
				.filter(frame => frame.includes('"type":"output"') && frame.includes('"id":"' + id + '"'))
				.map(frame => (JSON.parse(frame.slice(frame.indexOf("data:") + 5).trim()) as { data: string }).data)
				.join("");
		},
		outputs(id: string): { data: string; offset: number; reset?: boolean }[] {
			return frames
				.filter(frame => frame.includes('"type":"output"') && frame.includes('"id":"' + id + '"'))
				.map(frame => JSON.parse(frame.slice(frame.indexOf("data:") + 5).trim()) as { data: string; offset: number; reset?: boolean });
		},
		async cancel(): Promise<void> { await body.cancel().catch(() => {}); await running; },
	};
}

test("a Web page opens several tabs on one stream, writes, resizes and resumes each from its own cursor", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const target = await fixture(t);
	const cookie = cookieHeaders(target);

	// Two tabs in the same workspace: the page's one stream names both, and each open reaches the host once.
	assert.deepEqual(await open(target, cookie, "local", "tab-a", { cols: 100, rows: 30 }), { ok: true, id: "tab-a", workspaceId: "local", cwd: target.localRoot, cols: 100, rows: 30 });
	assert.equal((await open(target, cookie, "local", "tab-b")).ok, true);
	// A restored tab reaches the shell it started rather than a second one.
	const again = await open(target, cookie, "local", "tab-a");
	assert.deepEqual({ ok: again.ok, cwd: again.cwd, cols: again.cols, rows: again.rows }, { ok: true, cwd: target.localRoot, cols: 100, rows: 30 });

	const guard = new AbortController();
	t.after(() => guard.abort());
	const stream = await fetch(target.origin + fanInPath([{ id: "tab-a", workspaceId: "local" }, { id: "tab-b", workspaceId: "local" }]), { headers: { ...cookie, accept: "text/event-stream" }, signal: guard.signal });
	assert.equal(stream.status, 200);
	assert.equal(stream.headers.get("content-type"), "text/event-stream");
	const page = reader(stream, guard.signal);
	t.after(() => page.cancel());

	// Both tabs are attached by the one request, and each is told the retained tail it has read nothing of.
	await page.until(frames => frames.some(frame => frame.includes('"id":"tab-a"')) && frames.some(frame => frame.includes('"id":"tab-b"')), "both tabs' replay on one stream");

	// Input reaches the shell of the tab it names, and only that tab's frames carry the echo.
	assert.equal((await input(target, cookie, "local", "tab-a", "printf 'a-only\\n'\n")).ok, true);
	const echoed = await page.until(frames => frames.some(frame => frame.includes('"id":"tab-a"') && frame.includes("a-only")), "tab a's echo");
	assert.equal(page.text("tab-b").includes("a-only"), false, "one tab's output must not be written into another's");

	// A resize is applied by the host, which the shell itself reports.
	assert.equal((await command(target, cookie, "local", "tab-a", { type: "resize", cols: 100, rows: 30 })).ok, true);
	assert.equal((await input(target, cookie, "local", "tab-a", "stty size\n")).ok, true);
	await page.until(frames => frames.some(frame => frame.includes('"id":"tab-a"') && frame.includes("30 100")), "the shell's own window size");

	// The cursor a reconnect names is the tab's own read position: continuing from it is a continuation, not a reset.
	const offsets = page.outputs("tab-a");
	const cursor = offsets.at(-1)!.offset;
	assert.ok(echoed.length > 0);
	await page.cancel();
	await page.until(() => true, "the first stream to end");
	const resumedGuard = new AbortController();
	t.after(() => resumedGuard.abort());
	// The continuation is answered before any frame: a stream that has nothing to replay is attached all the same, so
	// its caller reads a status instead of waiting on a keepalive.
	const resumed = await fetch(target.origin + fanInPath([{ id: "tab-a", workspaceId: "local", after: cursor }]), { headers: { ...cookie, accept: "text/event-stream" }, signal: resumedGuard.signal });
	assert.equal(resumed.status, 200);
	const second = reader(resumed, resumedGuard.signal);
	t.after(() => second.cancel());
	// A stream that names the cursor it read answers no retained tail at all: there is nothing to re-send.
	await input(target, cookie, "local", "tab-a", "printf 'after-cursor\\n'\n");
	await second.until(frames => frames.some(frame => frame.includes("after-cursor")), "the resumed stream's own output");
	assert.deepEqual(second.outputs("tab-a").filter(output => output.reset === true), [], "a continuation must not reset the screen");
	assert.equal(second.text("tab-a").includes("a-only"), false, "the resumed stream re-sent output the cursor had already covered");
	await second.cancel();

	// Closing a tab ends the shell on the host, and the host reports the exit it saw: a restored tab reads exactly this
	// to tell a live shell from one that has ended, instead of starting a replacement.
	const closed = await fetch(target.origin + "/api/terminal/" + encodeURIComponent("tab-b") + "?cwd=" + encodeURIComponent(cwdOf("local")), { method: "DELETE", headers: cookie });
	assert.equal(closed.status, 200);
	assert.equal(((await closed.json()) as { ok: boolean }).ok, true);
	const described = await (await fetch(target.origin + "/api/terminal/" + encodeURIComponent("tab-b") + "?cwd=" + encodeURIComponent(cwdOf("local")), { headers: cookie })).json() as { ok: boolean; exited?: boolean };
	assert.deepEqual(described, { ok: true, id: "tab-b", workspaceId: "local", cwd: target.localRoot, cols: 80, rows: 24, exited: true }, "a closed tab's shell is reported as ended, not as a live one");
});

test("a device bearer reads, writes and closes the same terminals, and never sees an execution token", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const target = await fixture(t);
	const bearer = bearerHeaders(target);
	// The bearer works although it is neither execution credential this deployment holds: only the Backend presents
	// those, which is the fact that says no execution token ever reaches a client.
	assert.notEqual(target.deviceToken, LOCAL_TOKEN);
	assert.notEqual(target.deviceToken, SSH_TOKEN);
	assert.equal((await open(target, bearer, "local", "phone-tab")).ok, true);

	const guard = new AbortController();
	t.after(() => guard.abort());
	const stream = await fetch(target.origin + fanInPath([{ id: "phone-tab", workspaceId: "local" }]), { headers: { ...bearer, accept: "text/event-stream" }, signal: guard.signal });
	assert.equal(stream.status, 200);
	const page = reader(stream, guard.signal);
	t.after(() => page.cancel());
	assert.equal((await input(target, bearer, "local", "phone-tab", "printf 'from-phone\\n'\n")).ok, true);
	await page.until(frames => frames.some(frame => frame.includes("from-phone")), "the App's own output");
	await page.cancel();

	// The two directions stay apart: the client listener serves no internal route, and it does not accept the
	// execution credential as a client identity.
	assert.equal((await fetch(target.origin + "/v1/terminal/events?tabs=phone-tab:", { headers: bearer })).status, 404, "the client listener serves no /v1 route");
	assert.equal((await fetch(target.origin + "/api/terminal?cwd=" + encodeURIComponent(cwdOf("local")), { method: "POST", headers: { authorization: "Bearer " + LOCAL_TOKEN, "content-type": "application/json" }, body: JSON.stringify({ id: "x", cols: 80, rows: 24 }) })).status, 401, "an execution credential is not a client identity");
	const closed = await fetch(target.origin + "/api/terminal/" + encodeURIComponent("phone-tab") + "?cwd=" + encodeURIComponent(cwdOf("local")), { method: "DELETE", headers: bearer });
	assert.equal(closed.status, 200);
});

test("tabs of two hosts are merged by the Backend, and each tab runs on the host its workspace names", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const target = await fixture(t);
	const cookie = cookieHeaders(target);
	// The ingress serves one default host, and neither of these tabs is addressed through it: each names its own
	// workspace, so the Backend resolves the binding and reaches that gateway.
	assert.equal((await open(target, cookie, "local", "here")).ok, true);
	const remote = await open(target, cookie, "remote-loopback", "there");
	assert.deepEqual({ ok: remote.ok, workspaceId: remote.workspaceId, cwd: remote.cwd, code: remote.code, message: remote.message }, { ok: true, workspaceId: "remote-loopback", cwd: target.sshRoot, code: undefined, message: undefined });

	const guard = new AbortController();
	t.after(() => guard.abort());
	const stream = await fetch(target.origin + fanInPath([{ id: "here", workspaceId: "local" }, { id: "there", workspaceId: "remote-loopback" }]), { headers: { ...cookie, accept: "text/event-stream" }, signal: guard.signal });
	assert.equal(stream.status, 200);
	const page = reader(stream, guard.signal);
	t.after(() => page.cancel());
	// One request, two hosts behind it: the tabs are merged by the Backend, not by a second stream on the page.
	await page.until(frames => frames.some(frame => frame.includes('"id":"here"')) && frames.some(frame => frame.includes('"id":"there"')), "both hosts' tabs on one stream");

	// The remote tab's shell runs in the remote workspace's folder, on the host that workspace names.
	const wrote = await input(target, cookie, "remote-loopback", "there", "pwd\n");
	assert.deepEqual(wrote, { ok: true }, "the SSH tab did not take input");
	const remoteText = await page.until(frames => frames.some(frame => frame.includes('"id":"there"') && frame.includes(target.sshRoot)), "the remote tab's own folder").then(() => page.text("there"));
	assert.ok(remoteText.includes(target.sshRoot), "the SSH tab did not run in its workspace: " + JSON.stringify(remoteText));
	assert.equal(page.text("here").includes(target.sshRoot), false, "one host's output reached the other tab");
	// And the local tab is in its own folder, which the SSH host does not have.
	assert.equal((await input(target, cookie, "local", "here", "pwd\n")).ok, true);
	const localText = await page.until(frames => frames.some(frame => frame.includes('"id":"here"') && frame.includes(target.localRoot)), "the local tab's own folder").then(() => page.text("here"));
	assert.ok(localText.includes(target.localRoot), "the local tab did not run in its workspace: " + JSON.stringify(localText));
	await page.cancel();
});

test("a caller that goes away releases its stream, and no later frame reaches another tab", { timeout: TEST_TIMEOUT_MS }, async (t) => {
	const target = await fixture(t);
	const cookie = cookieHeaders(target);
	assert.equal((await open(target, cookie, "local", "first")).ok, true);
	assert.equal((await open(target, cookie, "local", "second")).ok, true);

	const guard = new AbortController();
	const stream = await fetch(target.origin + fanInPath([{ id: "first", workspaceId: "local" }]), { headers: { ...cookie, accept: "text/event-stream" }, signal: guard.signal });
	const page = reader(stream, guard.signal);
	await page.until(frames => frames.some(frame => frame.includes('"id":"first"')), "the first tab's replay");
	assert.equal(target.upstreamOpen(), 1, "the caller's one stream is the Backend's one stream");

	// The page goes away: its request ends, and the Backend's own request ends with it — nothing stays attached behind a
	// caller that left, which is what keeps a shell from being held by a reader nobody can see.
	await page.cancel();
	const deadline = Date.now() + 10_000;
	while (target.upstreamOpen() !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(target.upstreamOpen(), 0, "the Backend's terminal stream outlived its caller");

	// A second stream is a different attachment: the first tab's output is not carried into it, and the tab it does name
	// is the only one written to.
	const nextGuard = new AbortController();
	t.after(() => nextGuard.abort());
	const next = await fetch(target.origin + fanInPath([{ id: "second", workspaceId: "local" }]), { headers: { ...cookie, accept: "text/event-stream" }, signal: nextGuard.signal });
	const other = reader(next, nextGuard.signal);
	t.after(() => other.cancel());
	await other.until(frames => frames.some(frame => frame.includes('"id":"second"')), "the second tab's replay");
	assert.equal((await input(target, cookie, "local", "first", "printf 'first-only\\n'\n")).ok, true);
	assert.equal((await input(target, cookie, "local", "second", "printf 'second-only\\n'\n")).ok, true);
	await other.until(frames => frames.some(frame => frame.includes("second-only")), "the second tab's own output");
	assert.equal(other.frames.some(frame => frame.includes("first-only")), false, "a detached tab's output was written into the stream that replaced it");
	await other.cancel();

	// Nothing the caller did reached the ingress twice: the relay is the Backend's, and the client listener is not a
	// second hop for its own traffic.
	assert.equal(target.served.some(entry => entry.includes("/v1/")), false, "the client listener was asked for an internal route");
});
