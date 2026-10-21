import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	GatewayExecutionJournal,
	GatewayHostClient,
	GatewayRpcServer,
	LocalGateway,
	SshGateway,
	createSystemSshRunner,
	gatewayEnvironment,
	type ExecuteRequest,
	type SshRunner,
	type SshRunnerRequest,
  MemoryLedger,
} from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

async function workspace(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "hepi-exec-"));
}

/** One event-loop turn: enough for a frame that is not held back to be delivered, without waiting on a clock. */
function turn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** A resolved barrier, and the function that releases it. */
function barrier(): { readonly passed: Promise<void>; readonly open: () => void } {
	let open = () => {};
	const passed = new Promise<void>((resolve) => (open = resolve));
	return { passed, open: () => open() };
}

/** A promise that never settles, and rejects as soon as the call is aborted: what a running command waits on. */
function until(gate: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(Object.assign(new Error("aborted"), { code: "aborted" as const }));
	return Promise.race([
		gate,
		new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "aborted" as const })), { once: true })),
	]);
}

/**
 * A runner whose command is a script of chunks, each emitted when the test opens that step's gate. The test decides when
 * output exists, so a call that must still be running is one whose next step has not been released yet — no pipe for a
 * process to block on, no polling and no clock.
 */
function scriptedRunner(
	steps: readonly { readonly text: string; readonly stream?: "stdout" | "stderr"; readonly gate?: Promise<void> }[],
	outcome: { readonly exitCode?: number } = {},
): { readonly runner: SshRunner; readonly started: Promise<void> } {
	const started = barrier();
	const runner: SshRunner = {
		execute: async (request: SshRunnerRequest) => {
			started.open();
			let stdout = "";
			let stderr = "";
			for (const step of steps) {
				if (step.gate !== undefined) await until(step.gate, request.signal);
				const stream = step.stream ?? "stdout";
				if (stream === "stdout") stdout += step.text;
				else stderr += step.text;
				await request.onOutput?.({ stream, text: step.text });
			}
			return { stdout, stderr, exitCode: outcome.exitCode ?? 0 };
		},
	};
	return { runner, started: started.passed };
}

/** A gateway serving one loopback origin, closed by the test that made it. */
async function listening(gateway: LocalGateway | SshGateway, files?: LocalFilesystem): Promise<{ readonly origin: string; close(): Promise<void> }> {
	const server = new GatewayRpcServer(gateway, undefined, files);
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	return { origin: "http://127.0.0.1:" + address.port, close: async () => { await server.close(); } };
}

test("streams output while the command is still running", async () => {
	const root = await workspace();
	const next = barrier();
	const scripted = scriptedRunner([{ text: "first" }, { text: "second", gate: next.passed }]);
	const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
	const gateway = new SshGateway({ id: "gateway-1", token: "secret", profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), allowedCommands: ["bash"], runner: scripted.runner });
	const server = await listening(gateway);
	try {
		const client = new GatewayHostClient({ gatewayOrigin: server.origin, gatewayToken: "secret" });
		const request: ExecuteRequest = {
			gatewayId: "gateway-1",
			workspaceId: "remote-prod",
			callId: "stream-1",
			// The command reports, waits for the test, then reports again: the first output has to arrive before the call
			// settles, which the test observes as a frame while the second step is still unreleased.
			command: ["bash", "-c", "true"],
		};
		const seen: string[] = [];
		const first = barrier();
		let finished = false;
		const pending = client.process.execute(request, (chunk) => {
			seen.push(chunk.text);
			first.open();
		}).then((result) => {
			finished = true;
			return result;
		});
		await first.passed;
		assert.equal(finished, false, "output arrived before the command finished");
		next.open();
		const result = await pending;
		assert.deepEqual(result, { ok: true, gatewayId: "gateway-1", workspaceId: "remote-prod", callId: "stream-1", stdout: "firstsecond", stderr: "", exitCode: 0 });
		assert.deepEqual(seen, ["first", "second"]);
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("awaits an output callback before delivering the next chunk", async () => {
	const root = await workspace();
	const scripted = scriptedRunner([{ text: "one" }, { text: "two" }]);
	const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
	const gateway = new SshGateway({ id: "gateway-1", token: "secret", profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), allowedCommands: ["bash"], runner: scripted.runner });
	const server = await listening(gateway);
	try {
		const env = gatewayEnvironment({ id: "remote-prod", gatewayId: "gateway-1", gatewayOrigin: server.origin, gatewayToken: "secret" }, "/", { base: "env-await-1" });
		const order: string[] = [];
		const held = barrier();
		const first = barrier();
		const pending = env.exec(
			["bash", "-c", "true"],
			{
				// The first chunk's callback is held open; the next chunk must not arrive until it settles.
				onOutput: async (text) => {
					order.push("begin:" + text);
					if (order.length === 1) {
						first.open();
						await held.passed;
					}
					order.push("end:" + text);
				},
			},
			BACKGROUND_CONTEXT,
		);
		await first.passed;
		// The command's second chunk is already written; the first callback still holds it back.
		await turn();
		assert.deepEqual(order, ["begin:one"], "the second chunk waited for the first callback");
		held.open();
		const result = await pending;
		assert.deepEqual(order, ["begin:one", "end:one", "begin:two", "end:two"]);
		assert.equal(result.ok, true);
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("one execution scope gives every command its own identity", async () => {
	const root = await workspace();
	try {
		const counter = join(root, "runs");
		await writeFile(counter, "");
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"] });
		const server = await listening(gateway);
		const binding = { id: "workspace-1", gatewayId: "gateway-1", gatewayOrigin: server.origin, gatewayToken: "secret" };
		// The environment a tool runs in for one call: it is where a tool that runs several commands gets its scope.
		const env = gatewayEnvironment(binding, "/").forCall({ conversationId: "conversation-1", taskId: "task-1", callId: "call-1" });
		const first = await env.exec(["/bin/bash", "-c", "printf one >> runs"], undefined, BACKGROUND_CONTEXT);
		const second = await env.exec(["/bin/bash", "-c", "printf two >> runs"], undefined, BACKGROUND_CONTEXT);
		assert.equal(first.ok, true);
		assert.equal(second.ok, true, "two different commands in one call both run");
		// A tool that runs the same command twice means two executions, not one repeated request: each command in the
		// scope carries its own identity, so the second is run rather than answered from the record of the first.
		const third = await env.exec(["/bin/bash", "-c", "printf same >> runs"], undefined, BACKGROUND_CONTEXT);
		const fourth = await env.exec(["/bin/bash", "-c", "printf same >> runs"], undefined, BACKGROUND_CONTEXT);
		assert.equal(third.ok, true);
		assert.equal(fourth.ok, true, "a repeated command in one call still runs");
		assert.equal(await readFile(counter, "utf8"), "onetwosamesame");
		await server.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * Replace `node:child_process`'s `spawn` for one test, so `createSystemSshRunner` builds its real argv and reads its
 * real streams while the process it would have started is the child the test hands back. Nothing is started and
 * nothing is waited for; the runner's argv, its stream pumps and its result classification all still run.
 */
function standInSpawn(make: () => ChildProcess): { readonly calls: readonly (readonly string[])[]; restore(): void } {
	const original = childProcess.spawn;
	const calls: string[][] = [];
	childProcess.spawn = ((file: string, args: readonly string[]) => {
		calls.push([file, ...args]);
		return make();
	}) as unknown as typeof childProcess.spawn;
	syncBuiltinESMExports();
	return { calls, restore: () => { childProcess.spawn = original; syncBuiltinESMExports(); } };
}

/** A child that writes one chunk, waits for the test to release it, then writes the next and ends. */
function pacedChild(): { readonly child: ChildProcess; readonly release: () => void; readonly wroteSecond: Promise<void> } {
	const child = new EventEmitter() as unknown as ChildProcess;
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const released = barrier();
	const wroteSecond = barrier();
	Object.assign(child, { stdout, stderr, stdin: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
	// A started process cannot write before the runner is reading: the chunk is written once the listeners exist.
	setImmediate(() => stdout.write("one"));
	void (async () => {
		await released.passed;
		stdout.write("two");
		wroteSecond.open();
		stdout.end();
		stderr.end();
		child.emit("close", 0, null);
	})();
	return { child, release: () => released.open(), wroteSecond: wroteSecond.passed };
}

test("an SSH runner holds its stream back while a callback is pending", async () => {
	const root = await workspace();
	const paced = pacedChild();
	const stand = standInSpawn(() => paced.child);
	try {
		const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
		const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), allowedCommands: ["bash"], runner: createSystemSshRunner() });
		const server = await listening(gateway);
		try {
			const client = new GatewayHostClient({ gatewayOrigin: server.origin, gatewayToken: "secret" });
			const order: string[] = [];
			const held = barrier();
			const first = barrier();
			const pending = client.process.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "await-1", command: ["bash", "-c", "true"] }, async (chunk) => {
				order.push("begin:" + chunk.text);
				// The first chunk's callback is held open: the runner must not hand over the second one until it settles.
				if (order.length === 1) {
					first.open();
					await held.passed;
				}
				order.push("end:" + chunk.text);
			});
			await first.passed;
			paced.release();
			await paced.wroteSecond;
			await turn();
			assert.deepEqual(order, ["begin:one"], "the second chunk was held back until the first callback settled");
			held.open();
			const result = await pending;
			assert.deepEqual(order, ["begin:one", "end:one", "begin:two", "end:two"]);
			assert.equal(result.ok, true);
			assert.equal(result.ok === true && result.stdout, "onetwo");
			assert.deepEqual(stand.calls.map((call) => call[0]), ["ssh"], "the transport the runner builds is ssh");
		} finally {
			await server.close();
		}
	} finally {
		stand.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("caps captured output, never runs a call twice, and refuses a reused call ID", async () => {
	const root = await workspace();
	try {
		const counter = join(root, "runs");
		await writeFile(counter, "");
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"], captureBytes: 8 });
		const request: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "once-1", command: ["/bin/bash", "-c", "printf 123456789012345 >> runs; printf 123456789012345"] };
		const first = await gateway.execute(request);
		assert.equal(first.ok, true);
		assert.equal(first.ok === true && first.stdout, "12345678");
		assert.equal(first.ok === true && first.truncated, true, "output past the cap is reported, not silently dropped");
    const ledger = new MemoryLedger({ maxEntries: 1 });
    assert.equal(ledger.begin("old", "request"), true);
    ledger.complete("old", { ok: true, exitCode: 0 }, { stdout: "text", stderr: "" });
    assert.equal(ledger.begin("new", "request"), true);
    assert.equal(ledger.begin("old", "request"), false, "output eviction must not forget spent IDs");
		assert.equal(await readFile(counter, "utf8"), "123456789012345");

		const repeated = await gateway.execute(request);
		assert.equal(repeated.ok === true && repeated.stdout, "12345678");
		assert.equal(await readFile(counter, "utf8"), "123456789012345", "the repeated call did not run the command again");

		// Call IDs are model-generated and repeat, so the same ID with another command must not be answered from the
		// record of the first one.
		const reused = await gateway.execute({ ...request, command: ["/bin/bash", "-c", "printf other"] });
		assert.equal(reused.ok, false);
		assert.equal(reused.ok === false && reused.code, "invalid_request");
		assert.equal(await readFile(counter, "utf8"), "123456789012345", "the reused ID ran nothing");
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("refuses a call aborted before it was admitted, and stops one that is running", async () => {
	const root = await workspace();
	const next = barrier();
	const scripted = scriptedRunner([{ text: "started" }, { text: "finished", gate: next.passed }]);
	const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
	const remote = new SshGateway({ id: "gateway-1", token: "secret", profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), allowedCommands: ["bash"], runner: scripted.runner });
	try {
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"] });
		assert.equal(gateway.abort("early-1"), false, "nothing was running under that call ID");
		const early = await gateway.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "early-1", command: ["/bin/bash", "-c", "printf ran > early"] });
		assert.equal(early.ok, false);
		assert.equal(early.ok === false && early.code, "aborted");
		await assert.rejects(readFile(join(root, "early")), "the refused call never ran");
		gateway.close();

		// A call whose next step the test has not released is still running, which is what an abort stops.
		const running = remote.execute({ gatewayId: "gateway-1", workspaceId: "remote-prod", callId: "running-1", command: ["bash", "-c", "true"] });
		await scripted.started;
		assert.equal(remote.abort("running-1"), true, "the running call was found");
		const stopped = await running;
		assert.equal(stopped.ok, false);
		assert.equal(stopped.ok === false && stopped.code, "aborted");
		remote.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("keeps duplicate protection across a restart", async () => {
	const root = await workspace();
	const dbPath = join(root, "journal.sqlite");
	try {
		const counter = join(root, "runs");
		await writeFile(counter, "");
		const request: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "durable-1", command: ["/bin/bash", "-c", "printf x >> runs; printf done"] };
		const first = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"] }, new GatewayExecutionJournal({ path: dbPath }));
		assert.equal((await first.execute(request)).ok, true);
		first.close();

		const second = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"] }, new GatewayExecutionJournal({ path: dbPath }));
		const repeated = await second.execute(request);
		assert.equal(repeated.ok === true && repeated.stdout, "done");
		assert.equal(await readFile(counter, "utf8"), "x", "the restarted gateway did not run the call again");
		second.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("answers a call left running at restart as unknown instead of running it again", async () => {
	const root = await workspace();
	const dbPath = join(root, "journal.sqlite");
	const next = barrier();
	let runs = 0;
	const scripted = scriptedRunner([{ text: "started" }, { text: "replayed", gate: next.passed }]);
	const counting: SshRunner = { execute: async (request) => { runs += 1; return await scripted.runner.execute(request); } };
	const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
	const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
	const request: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "remote-prod", callId: "interrupted-1", command: ["bash", "-c", "true"] };
	const before = new SshGateway({ id: "gateway-1", token: "secret", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner: counting }, new GatewayExecutionJournal({ path: dbPath }));
	try {
		const running = before.execute(request);
		// The call is admitted, dispatched, and still waiting for the step the test has not released: it never finished.
		await scripted.started;

		// A gateway process that starts now finds that call dispatched, which says nothing about whether it ran.
		const after = new SshGateway({ id: "gateway-1", token: "secret", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner: counting }, new GatewayExecutionJournal({ path: dbPath }));
		const lost = await after.execute(request);
		assert.equal(lost.ok, false);
		assert.equal(lost.ok === false && lost.code, "outcome-unknown");
		assert.equal(runs, 1, "the interrupted call was not replayed");

		next.open();
		const settled = await running;
		assert.equal(settled.ok, true);
		assert.equal(settled.ok === true && settled.stdout, "startedreplayed");
		before.close();
		after.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports a lost response as unknown and sends nothing again", async () => {
	let requests = 0;
  let malformed = false;
	const server = createServer((_request, response) => {
		requests += 1;
		response.writeHead(200, { "content-type": "application/x-ndjson" });
    if (malformed) { response.end(JSON.stringify({ type: "result" }) + "\n"); return; }
		// One output frame, then the connection dies before the result frame.
		response.write(JSON.stringify({ type: "output", stream: "stdout", text: "partial" }) + "\n");
		setImmediate(() => response.destroy());
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		const client = new GatewayHostClient({ gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "secret" });
		const seen: string[] = [];
		const result = await client.process.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "lost-1", command: ["bash", "-c", "true"] }, (chunk) => {
			seen.push(chunk.text);
		});
		assert.deepEqual(result, { ok: false, code: "outcome-unknown", callId: "lost-1", message: "the gateway response ended before the call settled" });
		assert.deepEqual(seen, ["partial"], "output before the loss was still delivered");
		assert.equal(requests, 1, "the call was not sent again");
    malformed = true;
    const invalid = await client.process.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "invalid-frame", command: ["bash", "-c", "true"] });
    assert.equal(!invalid.ok && invalid.code, "outcome-unknown", "malformed result is uncertainty, not a thrown tool fault");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("a lost command answer says so at the execution seam, and a refusal stays the gateway's own answer", async () => {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const callId = String((JSON.parse(body) as ExecuteRequest).callId);
			requests.push(callId);
			response.writeHead(200, { "content-type": "application/x-ndjson" });
			if (callId === "conversation-1:task-1:lost-1#1" || callId === "conversation-1:task-1:slow-1#1") {
				if (callId.endsWith("slow-1#1")) {
					// The gateway's own named timeout: an answer, not a lost one.
					response.end(JSON.stringify({ type: "result", result: { ok: false, code: "timeout", callId, message: "the command exceeded 1s" } }) + "\n");
					return;
				}
				// One output frame, then the connection dies before the result frame: nothing can conclude the call.
				response.write(JSON.stringify({ type: "output", stream: "stdout", text: "partial" }) + "\n");
				setImmediate(() => response.destroy());
				return;
			}
			response.end(JSON.stringify({ type: "result", result: { ok: false, code: "command_denied", callId } }) + "\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const binding = { id: "workspace-1", gatewayId: "gateway-1", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "secret" };
	try {
		// The answer the environment reports is all the tool result and the model get: upstream's `ExecutionError` codes
		// are a closed set with no unknown-outcome member, so the may-have-run distinction travels in the message.
		const lost = await gatewayEnvironment(binding, "/").forCall({ conversationId: "conversation-1", taskId: "task-1", callId: "lost-1" })
			.exec(["bash", "-c", "true"], undefined, BACKGROUND_CONTEXT);
		assert.equal(lost.ok, false);
		assert.equal(lost.ok === false && lost.error.code, "unknown", "a lost answer is not a timeout or a cancellation");
		const message = lost.ok === false ? lost.error.message : "";
		assert.ok(message.startsWith("outcome_unknown:"), message);
		assert.match(message, /may have run/, message);
		assert.match(message, /never replayed/, message);
		assert.match(message, /the gateway response ended before the call settled/, message);
		assert.ok(message.includes("conversation-1:task-1:lost-1#1"), "the message names the spent call ID: " + message);

		// A named timeout stays itself: only a lost answer becomes the unknown-outcome statement.
		const timedOut = await gatewayEnvironment(binding, "/").forCall({ conversationId: "conversation-1", taskId: "task-1", callId: "slow-1" })
			.exec(["bash", "-c", "true"], undefined, BACKGROUND_CONTEXT);
		assert.equal(timedOut.ok, false);
		assert.equal(timedOut.ok === false && timedOut.error.code, "timeout", "the environment's code, not the gateway code's spelling");
		assert.equal(timedOut.ok === false && timedOut.error.message, "the command exceeded 1s");

		// A definitive refusal is the gateway's own answer and is not dressed up as uncertainty.
		const refused = await gatewayEnvironment(binding, "/").forCall({ conversationId: "conversation-1", taskId: "task-1", callId: "denied-1" })
			.exec(["bash", "-c", "true"], undefined, BACKGROUND_CONTEXT);
		assert.equal(refused.ok, false);
		assert.equal(refused.ok === false && refused.error.message, "command_denied");
		assert.equal(requests.length, 3, "no lost answer, timeout or refusal was sent again");
		assert.deepEqual(requests, ["conversation-1:task-1:lost-1#1", "conversation-1:task-1:slow-1#1", "conversation-1:task-1:denied-1#1"], "one request per execution identity");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("bash pwd reports the physical workspace, and a file tool reads and edits what it printed", async () => {
	const root = await workspace();
  let server: { readonly origin: string; close(): Promise<void> } | undefined;
	try {
		const nested = join(root, "src", "nested");
		await mkdir(nested, { recursive: true });
		await writeFile(join(nested, "app.ts"), "export const value = 1;\n");
		const registry = new WorkspaceRegistry([{ id: "workspace-1", root }]);
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: registry, allowedCommands: ["bash"] });
		server = await listening(gateway, new LocalFilesystem(registry));
		const binding = { id: "workspace-1", gatewayId: "gateway-1", gatewayOrigin: server.origin, gatewayToken: "secret" };
		const env = gatewayEnvironment(binding, "/src/nested");
		const printed: string[] = [];
		const pwd = await env.exec(["bash", "-c", "pwd"], { onOutput: (text) => { printed.push(text); } }, BACKGROUND_CONTEXT);
		assert.equal(pwd.ok, true);
		const physical = printed.join("").trim();
		assert.equal(physical, await realpath(nested), "the shell reports the physical directory it runs in");
		// The path the shell printed, and the logical workspace path, both name the file the file tools then edit.
		assert.equal((await env.readTextFile(physical + "/app.ts", BACKGROUND_CONTEXT)).ok, true);
		const edited = await env.writeFile(physical + "/app.ts", "export const value = 2;\n", BACKGROUND_CONTEXT);
		assert.equal(edited.ok, true);
		assert.equal(await readFile(join(nested, "app.ts"), "utf8"), "export const value = 2;\n");
		assert.equal((await env.readTextFile("/src/nested/app.ts", BACKGROUND_CONTEXT)).ok, true);
	} finally {
		await server?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("streams the complete output of an SSH call and reports that no spill file was preserved", async () => {
	const root = await workspace();
	try {
		// The remote host has no file the caller can read, so a spill request is answered with the full streamed output
		// and an explicit warning instead of a path, or a refusal that would break the bash tool.
		// The bash tool always asks for a spill, so an SSH gateway must still run the call and stream its output.
		const runner = { execute: async () => ({ stdout: "remote-out", stderr: "", exitCode: 0 }) };
		const profiles = [{ id: "prod", host: "ignored", remoteRoot: root }];
		const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), allowedCommands: ["bash"], runner });
		const server = await listening(gateway);
		const client = new GatewayHostClient({ gatewayOrigin: server.origin, gatewayToken: "secret" });
		const seen: string[] = [];
		const result = await client.process.execute(
			{ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-spill-1", command: ["bash", "-c", "seq 1 200"], spill: { afterBytes: 16, afterLines: 2 } },
			(chunk) => {
				seen.push(chunk.text);
			},
		);
		assert.equal(result.ok, true);
		assert.equal(result.ok === true && result.spillUnsupported, true, "the caller is told no spill file was preserved");
		assert.equal(result.ok === true && result.spillPath, undefined);
		assert.equal(result.ok === true && result.stdout, "remote-out", "the output still reached the caller");
		// This runner reports its output in the result without streaming; a streaming runner would also call the sink.
		await server.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("forwards spill and window to the local environment and reports the spill path", async () => {
	const root = await workspace();
	try {
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"] });
		const result = await gateway.execute({
			gatewayId: "gateway-1",
			workspaceId: "workspace-1",
			callId: "spill-1",
			command: ["/bin/bash", "-c", "seq 1 500"],
			spill: { afterBytes: 16, afterLines: 2 },
		});
		assert.equal(result.ok, true);
		assert.ok(result.ok === true && result.spillPath !== undefined, "the complete output was preserved");
		assert.equal(result.ok === true && result.spillUnsupported, undefined, "local execution can spill");
		const spilled = await readFile(result.ok === true ? result.spillPath! : "", "utf8");
		assert.equal(spilled.split("\n").length, 501, "the spill file holds the complete output");
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
