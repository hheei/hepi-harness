import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import { GatewayRpcServer, LocalGateway, MemoryLedger, ProviderAuthService, WorkspaceRegistry, agentDirOf } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";

/**
 * Provider connection state, at the public seam: `POST /v1/providers/auth` on a real gateway process.
 *
 * The seam is the route, not the service, because that is what a Web BFF calls: the bearer check, the request body, the
 * answer and the file the answer describes are all the contract. The credentials the tests write are synthetic strings,
 * and every assertion about them is that the value does *not* appear in an answer — a listing reports presence, type and
 * a masked hint, and a mutation answers that listing.
 *
 * The host context is stated by the fixture rather than inherited from this process, so a machine with a real
 * `ANTHROPIC_API_KEY` in its environment does not change what a listing reports. The catalog is the SDK's own, because
 * the supported provider set is exactly the thing a listing has to reflect.
 */

const TOKEN = "gateway-token";
const KEY = "sk-test-0123456789abcdefghijklmnop";
// The shapes a stored subscription holds: real forms, asserted only as values that must never appear in an answer.
const ACCESS = "ya29.a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9";
const REFRESH = "1//0abcdefghijklmnopqrstuvwx1234567890ABCDEFGH";

type Fixture = {
	readonly home: string;
	readonly agentDir: string;
	readonly authPath: string;
	readonly call: (body: unknown, token?: string) => Promise<{ status: number; body: any; text: string }>;
	readonly close: () => Promise<void>;
};

/** One gateway process serving the provider surface, over an account directory of its own. */
async function fixture(options: { agentDir?: string; lockTimeoutMs?: number; serve?: boolean } = {}): Promise<Fixture> {
	const base = await mkdtemp(join(tmpdir(), "hepi-provider-auth-"));
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	const agentDir = options.agentDir ?? agentDirOf(home);
	const registry = new WorkspaceRegistry([{ id: "local", root: home }]);
	const gateway = new LocalGateway({ id: "workstation", token: TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	const providers = options.serve === false
		? undefined
		: new ProviderAuthService({
				agentDir,
				// A host whose environment names no provider key and whose ambient credential files are not consulted here:
				// what a listing reports is then the file's own state, not the machine the test happens to run on.
				context: { env: async () => undefined, fileExists: async () => false },
				...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
			});
	const server = new GatewayRpcServer({ gateway, files: new LocalFilesystem(registry), providers });
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address && typeof address === "object");
	const origin = "http://127.0.0.1:" + address.port;
	return {
		home,
		agentDir,
		authPath: join(agentDir, "auth.json"),
		call: async (body, token = TOKEN) => {
			const response = await fetch(origin + "/v1/providers/auth", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
			const text = await response.text();
			return { status: response.status, body: JSON.parse(text), text };
		},
		close: async () => {
			server.server.closeAllConnections();
			await server.close();
			await rm(base, { recursive: true, force: true });
		},
	};
}

/** The provider record the SDK defines, so a test names a provider that really exists in that set. */
const anthropic = "anthropic";

test("lists the providers the SDK defines, with what this host stores for each", async () => {
	const f = await fixture();
	try {
		const answer = await f.call({ operation: "list" });
		assert.equal(answer.status, 200);
		assert.equal(answer.body.ok, true);
		const listing = answer.body.value as any[];
		// The set is the SDK's own: a listing that invented or dropped providers would be one a panel cannot trust.
		const ids = listing.map((entry) => entry.providerId);
		for (const id of ["anthropic", "openai", "openai-codex", "amazon-bedrock"]) assert.ok(ids.includes(id), "listed provider: " + id);
		assert.equal(new Set(ids).size, ids.length, "a provider id appears once");
		const byId = new Map(listing.map((entry) => [entry.providerId, entry]));
		// Which providers are dual-auth is a property of the definitions, read from `auth`, never assumed from an id.
		assert.deepEqual((byId.get("anthropic") as any).methods, { apiKey: true, oauth: true });
		assert.deepEqual((byId.get("openai-codex") as any).methods, { apiKey: false, oauth: true });
		// Nothing is stored on a fresh host, and nothing is created by reading.
		for (const entry of listing) {
			assert.equal(entry.configured, false);
			assert.equal(entry.storedType, undefined);
			assert.equal(entry.maskedHint, undefined);
		}
		assert.equal(existsSync(f.authPath), false, "reading a listing writes no credential file");
	} finally {
		await f.close();
	}
});

test("a set key is written to this host's auth.json with restrictive modes and never echoed", async () => {
	const f = await fixture();
	try {
		const answer = await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		assert.equal(answer.body.ok, true, answer.text);
		// The answer is the listing after the change: the raw key is nowhere in it.
		assert.equal(answer.text.includes(KEY), false, "no raw key in the answer");
		assert.equal(answer.text.includes(KEY.slice(0, 12)), false, "no prefix of the key in the answer");

		const stored = JSON.parse(readFileSync(f.authPath, "utf8"));
		assert.deepEqual(stored, { [anthropic]: { type: "api_key", key: KEY } });
		// The account's directory and the file are readable only by that account.
		assert.equal(statSync(f.authPath).mode & 0o777, 0o600);
		assert.equal(statSync(f.agentDir).mode & 0o777, 0o700);

		const entry = (answer.body.value as any[]).find((row) => row.providerId === anthropic);
		assert.equal(entry.storedType, "api_key");
		// A stored key is not a usable request credential without the provider's own resolution, so the hint is what a
		// panel shows: a short prefix and suffix, not the value.
		assert.equal(typeof entry.maskedHint, "string");
		assert.match(entry.maskedHint, /^sk-t.*mnop$/);
		assert.equal(entry.maskedHint.includes(KEY.slice(4, -4)), false, "the middle of the key is not disclosed");
	} finally {
		await f.close();
	}
});

test("a listing reports a stored key as its own fact, and an ambient one leaves nothing stored", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		const listing = (await f.call({ operation: "list" })).body.value as any[];
		const entry = listing.find((row) => row.providerId === anthropic);
		assert.equal(entry.storedType, "api_key");
		assert.equal(JSON.stringify(listing).includes(KEY), false, "a listing never carries the value");
		// Every other provider keeps no entry: one provider's credential is not copied to another.
		const stored = JSON.parse(readFileSync(f.authPath, "utf8"));
		assert.deepEqual(Object.keys(stored), [anthropic]);
	} finally {
		await f.close();
	}
});


test("a listing reports a stored subscription as configured without asking the network", async () => {
	// A sign-in stores an entry, and a person returning to the panel must see the provider they signed in to. The
	// provider's own resolution is the only way to answer that for a key, and is a network call a listing of every
	// provider cannot make — which is how a stored subscription ended up reported as an empty store. A token that needs
	// refreshing is still configured: `refresh` belongs to the next request, not to this listing.
	const f = await fixture();
	try {
		mkdirSync(f.agentDir, { recursive: true });
		writeFileSync(f.authPath, JSON.stringify({ [anthropic]: { type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
		const listing = (await f.call({ operation: "list" })).body.value as any[];
		const entry = listing.find((row) => row.providerId === anthropic);
		assert.equal(entry.storedType, "oauth");
		assert.equal(entry.configured, true, "a stored subscription was listed as an empty store");
		assert.equal(entry.source, "OAuth");
		// The value stays in the file: a listing says the credential exists, never what it is.
		assert.equal(JSON.stringify(listing).includes(ACCESS), false, "a listing carried the access token");
		assert.equal(JSON.stringify(listing).includes(REFRESH), false, "a listing carried the refresh token");
		assert.equal(entry.maskedHint, undefined, "a subscription has no key hint to show");

		// A subscription stored for a provider this host declares no OAuth method for is named as what it is: an entry
		// nothing here can authenticate with, rather than a configured provider that offers a sign-out to nowhere.
		const noMethod = await fixture();
		try {
			mkdirSync(noMethod.agentDir, { recursive: true });
			writeFileSync(noMethod.authPath, JSON.stringify({ "deepseek": { type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
			const row = ((await noMethod.call({ operation: "list" })).body.value as any[]).find((item) => item.providerId === "deepseek");
			assert.equal(row.storedType, "oauth", "the entry itself is still reported");
			assert.equal(row.configured, false, "a method this host does not serve was reported as usable");
		} finally { await noMethod.close(); }
	} finally {
		await f.close();
	}
});

test("a stored key is removed, and removing nothing is the same success", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		const removed = await f.call({ operation: "remove", providerId: anthropic });
		assert.equal(removed.body.ok, true, removed.text);
		assert.deepEqual(JSON.parse(readFileSync(f.authPath, "utf8")), {});
		let entry = (removed.body.value as any[]).find((row) => row.providerId === anthropic);
		assert.equal(entry.storedType, undefined);
		assert.equal(entry.maskedHint, undefined);

		// A repeated removal, or a second panel, learns the same state rather than an error it cannot act on.
		const again = await f.call({ operation: "remove", providerId: anthropic });
		assert.equal(again.body.ok, true, again.text);
		entry = (again.body.value as any[]).find((row) => row.providerId === anthropic);
		assert.equal(entry.storedType, undefined);
	} finally {
		await f.close();
	}
});

test("a removal naming the wrong stored type leaves the credential in place", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		const refused = await f.call({ operation: "remove", providerId: anthropic, expectedType: "oauth" });
		assert.deepEqual({ ok: refused.body.ok, code: refused.body.code }, { ok: false, code: "credential_mismatch" });
		// The refusal is about a stale panel, and it changes nothing.
		assert.deepEqual(JSON.parse(readFileSync(f.authPath, "utf8")), { [anthropic]: { type: "api_key", key: KEY } });
		assert.equal(refused.text.includes(KEY), false);

		// The matching request is what removes it.
		const removed = await f.call({ operation: "remove", providerId: anthropic, expectedType: "api_key" });
		assert.equal(removed.body.ok, true, removed.text);
		assert.deepEqual(JSON.parse(readFileSync(f.authPath, "utf8")), {});
	} finally {
		await f.close();
	}
});

test("an unknown provider is refused without touching the credential file", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		const before = readFileSync(f.authPath, "utf8");
		for (const body of [
			{ operation: "set-key", providerId: "not-a-real-provider", apiKey: KEY },
			{ operation: "set-key", providerId: "", apiKey: KEY },
			{ operation: "set-key", apiKey: KEY },
			{ operation: "remove", providerId: "not-a-real-provider" },
		]) {
			const answer = await f.call(body);
			assert.equal(answer.body.ok, false, JSON.stringify(body));
			assert.ok(["unknown_provider", "invalid_request"].includes(answer.body.code), answer.body.code);
			assert.equal(answer.text.includes(KEY), false, "a refusal never quotes the key");
		}
		// Refusing an unknown id must not create an entry for it either.
		assert.equal(readFileSync(f.authPath, "utf8"), before);
	} finally {
		await f.close();
	}
});

test("a key that is not one usable line is refused before anything is written", async () => {
	const f = await fixture();
	try {
		for (const apiKey of ["", "   ", "sk-" + "\n" + "other", KEY + " ", "x".repeat(8193), 42, null]) {
			const answer = await f.call({ operation: "set-key", providerId: anthropic, apiKey });
			assert.equal(answer.body.ok, false, "refused: " + JSON.stringify(apiKey));
			assert.equal(answer.body.code, "invalid_request");
		}
		assert.equal(existsSync(f.authPath), false, "a refused key writes no credential file");
	} finally {
		await f.close();
	}
});

test("concurrent writes to different providers all land, and no write is lost", async () => {
	const f = await fixture();
	try {
		const providers = ["anthropic", "openai", "groq", "deepseek"];
		const answers = await Promise.all(providers.map((providerId, index) => f.call({ operation: "set-key", providerId, apiKey: "sk-concurrent-" + index + "-0123456789" })));
		for (const answer of answers) assert.equal(answer.body.ok, true, answer.text);
		// Every provider's entry survived: the lock is a read-modify-write, so one write cannot replace another's file.
		const stored = JSON.parse(readFileSync(f.authPath, "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), [...providers].sort());
		for (const [index, providerId] of providers.entries()) assert.equal(stored[providerId].key, "sk-concurrent-" + index + "-0123456789");
	} finally {
		await f.close();
	}
});

test("a lock another writer holds is reported as retryable, and nothing is changed", async () => {
	const f = await fixture({ lockTimeoutMs: 200 });
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		const before = readFileSync(f.authPath, "utf8");
		// A writer outside this service — the pi CLI signing in on the same account — holds the file's lock.
		const release = await lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 });
		try {
			const refused = await f.call({ operation: "set-key", providerId: "openai", apiKey: "sk-other-0123456789abcdef" });
			assert.deepEqual({ ok: refused.body.ok, code: refused.body.code }, { ok: false, code: "lock_unavailable" });
			assert.equal(readFileSync(f.authPath, "utf8"), before, "a refusal under a held lock writes nothing");
		} finally {
			await release();
		}
		// Once the other writer is done, the same request succeeds: the refusal was about the lock, not the request.
		const accepted = await f.call({ operation: "set-key", providerId: "openai", apiKey: "sk-other-0123456789abcdef" });
		assert.equal(accepted.body.ok, true, accepted.text);
	} finally {
		await f.close();
	}
});

/**
 * A credential file is created under the lock, by an exclusive create, because this host's own store has more than one
 * writer: the gateway, another gateway process of the same account, and the pi CLI signing in on that account.
 *
 * Both regressions ask the ordinary write path to store a key on a host with no `auth.json` yet — the moment two writers
 * can each believe they are the first one.
 */
test("a first write that cannot take the lock leaves no credential file behind", async () => {
	const f = await fixture({ lockTimeoutMs: 200 });
	try {
		// Another process — the pi CLI, or a second gateway on the same account — holds the lock of a file that does not
		// exist yet, and is about to create it with its own credential.
		mkdirSync(f.agentDir, { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(f.authPath, { realpath: false, stale: 30_000, retries: 0 });
		try {
			const refused = await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
			assert.deepEqual({ ok: refused.body.ok, code: refused.body.code }, { ok: false, code: "lock_unavailable" });
			// Waiting for a lock is not a write: this process created nothing, so it has nothing to have truncated.
			assert.equal(existsSync(f.authPath), false, "a write refused before the lock was taken creates no credential file");
			// The other writer now stores its own credential in the file it created under that lock.
			const temporary = f.authPath + ".peer.tmp";
			writeFileSync(temporary, JSON.stringify({ openai: { type: "api_key", key: "sk-second-0123456789abcdef" } }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
			renameSync(temporary, f.authPath);
		} finally {
			await release();
		}
		// Retryable means exactly that: the same request now lands, and the other writer's entry survives it.
		const accepted = await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		assert.equal(accepted.body.ok, true, accepted.text);
		const stored = JSON.parse(readFileSync(f.authPath, "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), [anthropic, "openai"], "the credential stored by the other writer is not replaced");
		assert.equal(stored.openai.key, "sk-second-0123456789abcdef");
		assert.equal(statSync(f.authPath).mode & 0o777, 0o600);
	} finally {
		await f.close();
	}
});

test("concurrent first writers on a host with no credential file all land", async () => {
	const base = await mkdtemp(join(tmpdir(), "hepi-provider-init-"));
	const agentDir = join(base, ".pi/agent");
	// The start line keeps the processes apart until every one of them is ready to be the first writer.
	const go = join(base, "go");
	const writer = join(base, "writer.mjs");
	writeFileSync(writer, [
		"import { existsSync } from \"node:fs\";",
		"const [modulePath, agentDir, providerId, key, go] = process.argv.slice(2);",
		"const { ProviderAuthService } = await import(\"file://\" + modulePath);",
		"process.stdout.write(\"ready\\n\");",
		"while (!existsSync(go)) { /* every first writer waits here until they are all ready */ }",
		"const service = new ProviderAuthService({ agentDir, context: { env: async () => undefined, fileExists: async () => false } });",
		"const answer = await service.execute({ operation: \"set-key\", providerId, apiKey: key });",
		"process.stdout.write(JSON.stringify({ providerId, ok: answer.ok === true, code: answer.code ?? null }) + \"\\n\");",
	].join("\n"));
	const providers = [anthropic, "openai", "groq", "deepseek", "mistral", "xai", "nvidia", "openrouter"];
	try {
		const children = providers.map((providerId, index) => spawn(process.execPath, [writer, join(import.meta.dirname, "..", "src", "provider-auth.ts"), agentDir, providerId, "sk-first-" + index + "-0123456789", go], { stdio: ["ignore", "pipe", "pipe"] }));
		const output = children.map((child) => {
			const state = { text: "" };
			child.stdout.on("data", (chunk) => { state.text += String(chunk); });
			child.stderr.on("data", (chunk) => { state.text += "[stderr] " + String(chunk); });
			return state;
		});
		const started = Date.now();
		while (!output.every((state) => state.text.includes("ready")) && Date.now() - started < 30_000) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(output.every((state) => state.text.includes("ready")), "every writer reached the start line: " + JSON.stringify(output.map((state) => state.text.slice(0, 200))));
		writeFileSync(go, "go");
		const exits = await Promise.all(children.map((child) => new Promise<number>((resolve) => { child.on("close", (code) => resolve(code ?? -1)); })));
		const answers = output.map((state) => state.text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))[0]);
		for (const [index, answer] of answers.entries()) {
			assert.equal(exits[index], 0, providers[index] + " exited " + exits[index] + ": " + output[index].text.slice(0, 300));
			assert.equal(answer?.ok, true, providers[index] + " refused: " + JSON.stringify(answer));
		}
		// The file was created once, by whichever writer got there first, and no writer replaced another's entry.
		const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
		assert.deepEqual(Object.keys(stored).sort(), [...providers].sort(), "every first writer's credential is still there");
		for (const [index, providerId] of providers.entries()) assert.equal(stored[providerId].key, "sk-first-" + index + "-0123456789");
		assert.equal(statSync(join(agentDir, "auth.json")).mode & 0o777, 0o600);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("an unreadable credential file is refused with fixed text and no value from the file", async () => {
	const f = await fixture();
	try {
		// A corrupt file that still contains the key-shaped text a person would not want quoted back.
		mkdirSync(f.agentDir, { recursive: true });
		writeFileSync(f.authPath, "{ this is not json " + KEY, { mode: 0o600 });
		const answer = await f.call({ operation: "list" });
		assert.deepEqual({ ok: answer.body.ok, code: answer.body.code }, { ok: false, code: "auth_file_unreadable" });
		assert.equal(answer.text.includes(KEY), false, "a failure never quotes the file it could not read");
		assert.equal(answer.text.includes("sk-test"), false);
		// The file is left exactly as it was found: a refusal is not a repair.
		assert.equal(readFileSync(f.authPath, "utf8"), "{ this is not json " + KEY);
	} finally {
		await f.close();
	}
});

test("a widened credential file is narrowed on the next write", async () => {
	const f = await fixture();
	try {
		await f.call({ operation: "set-key", providerId: anthropic, apiKey: KEY });
		// Another tool, or a person, made the file group- and world-readable.
		chmodSync(f.authPath, 0o644);
		assert.equal(statSync(f.authPath).mode & 0o777, 0o644);
		await f.call({ operation: "set-key", providerId: "openai", apiKey: "sk-second-0123456789abcdef" });
		assert.equal(statSync(f.authPath).mode & 0o777, 0o600, "the mode is applied on every write, not only on creation");
	} finally {
		await f.close();
	}
});

test("the route keeps its bearer boundary and every operation is answered as JSON", async () => {
	const f = await fixture();
	try {
		const unauthorized = await f.call({ operation: "list" }, "not-the-token");
		assert.deepEqual({ status: unauthorized.status, body: unauthorized.body }, { status: 401, body: { ok: false, code: "unauthorized" } });
		// A body that names no operation is refused by the route before any operation runs.
		const missing = await f.call({});
		assert.deepEqual({ status: missing.status, code: missing.body.code }, { status: 400, code: "invalid_request" });
		const unknown = await f.call({ operation: "sign-in" });
		assert.deepEqual({ ok: unknown.body.ok, code: unknown.body.code }, { ok: false, code: "unsupported_operation" });
	} finally {
		await f.close();
	}
});

test("a gateway that serves no provider surface names that limit instead of a generic refusal", async () => {
	const f = await fixture({ serve: false });
	try {
		const answer = await f.call({ operation: "list" });
		assert.deepEqual({ status: answer.status, ok: answer.body.ok, code: answer.body.code }, { status: 200, ok: false, code: "unsupported_operation" });
		assert.match(answer.body.message, /serves no provider-auth capability/);
	} finally {
		await f.close();
	}
});
