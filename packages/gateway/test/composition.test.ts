import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FilesystemServer } from "../src/filesystem.ts";
import type { McpHostService } from "../src/mcp/host.ts";
import type { ProviderLoginService } from "../src/provider-login.ts";
import type { TerminalSessions } from "../src/terminal.ts";
import { GatewayRpcServer, LocalGateway, MemoryLedger, WorkspaceRegistry } from "../src/index.ts";

/**
 * What a gateway entry composes, and what stopping it disposes.
 *
 * The composition is one named set of capabilities, so an entry states which surfaces its host serves instead of
 * remembering an argument position. The lifetimes belong to the gateway that borrowed them: `close` ends terminals, the
 * provider sign-ins this host is running, MCP, the filesystem, the connections still holding a request, the execution
 * gateway with its ledger, and finally the listener — once each, in that order, whatever the server was composed with.
 * Repeating a close awaits the one already running and disposes nothing a second time.
 */

const TOKEN = "composition-token";
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** One disposal a capability reports, counted so the order and the count are observable from outside. */
type Disposal = { readonly count: number };

/** A capability stand-in whose one disposal method records that it ran. */
function recorder(order: string[], name: string, method: "close" | "closeAll" | "stop"): Disposal & { [key: string]: unknown } {
	const record = { count: 0 };
	return Object.defineProperty(record, method, { value: async () => { record.count += 1; order.push(name); } }) as Disposal & { [key: string]: unknown };
}

/** The instances one entry composes, with every disposal watched. */
async function composed(): Promise<{ order: string[]; server: GatewayRpcServer; ledger: MemoryLedger; disposals: Record<string, Disposal> }> {
	const root = await mkdtemp(join(tmpdir(), "hepi-gateway-composition-"));
	directories.push(root);
	const order: string[] = [];
	const terminals = recorder(order, "terminals", "closeAll");
	const logins = recorder(order, "logins", "stop");
	const mcp = recorder(order, "mcp", "close");
	const files = recorder(order, "files", "close");
	const ledger = new MemoryLedger();
	const server = new GatewayRpcServer({
		gateway: new LocalGateway({ id: "workstation", token: TOKEN, workspaces: new WorkspaceRegistry([{ id: "local", root }]), allowedCommands: ["bash"] }, ledger),
		// A filesystem that reads nothing: these cases observe its disposal, and the file routes' own answers are
		// asserted by the suites that drive them.
		files: { execute: async () => ({ ok: false }), close: files.close as () => Promise<void> } as unknown as FilesystemServer,
		terminals: terminals as unknown as TerminalSessions,
		mcp: mcp as unknown as McpHostService,
		providerLogins: logins as unknown as ProviderLoginService,
	});
	return { order, server, ledger, disposals: { terminals, logins, mcp, files } };
}

test("close disposes every borrowed capability once, in the order their lifetimes nest", async () => {
	const { order, server, ledger, disposals } = await composed();
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	// A call the ledger knows, so a closed ledger is observable rather than assumed.
	assert.equal(ledger.begin("call-1", "fingerprint"), true);

	await server.close();

	assert.deepEqual(order, ["terminals", "logins", "mcp", "files"], "the capabilities were not disposed in the documented order");
	for (const [name, record] of Object.entries(disposals)) assert.equal(record.count, 1, name + " was disposed " + record.count + " times");
	// The ledger closes with the gateway that owns it, so no call ID outlives the process that answered it.
	assert.equal(ledger.lookup("call-1"), undefined, "the execution gateway was not closed with the server");
	assert.equal(server.server.listening, false, "the listener outlived the gateway");
});

test("repeating a close awaits the one already running and disposes nothing twice", async () => {
	const { server, disposals } = await composed();
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));

	await Promise.all([server.close(), server.close()]);
	await server.close();

	for (const [name, record] of Object.entries(disposals)) assert.equal(record.count, 1, name + " was disposed " + record.count + " times across repeated closes");
});

test("a host that composes no capability closes cleanly and answers each absent surface's own limit", async () => {
	const root = await mkdtemp(join(tmpdir(), "hepi-gateway-composition-bare-"));
	directories.push(root);
	const server = new GatewayRpcServer({
		gateway: new LocalGateway({ id: "workstation", token: TOKEN, workspaces: new WorkspaceRegistry([{ id: "local", root }]), allowedCommands: ["bash"] }, new MemoryLedger()),
	});
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		// Nothing to dispose is not a failure. The file RPC's absent capability is its own bare refusal, not a generic one.
		const call = await fetch("http://127.0.0.1:" + address.port + "/v1/files", {
			method: "POST",
			headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
			body: JSON.stringify({ operation: "list", workspaceId: "local", path: "." }),
		});
		assert.deepEqual(await call.json(), { ok: false });
	} finally { await server.close(); }
	assert.equal(server.server.listening, false, "the listener outlived the gateway");
});
