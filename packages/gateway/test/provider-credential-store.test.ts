import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import lockfile from "proper-lockfile";
import type { Credential } from "@earendil-works/pi-ai";
import { ProviderCredentialFile } from "../src/provider-auth.ts";
import { ProviderFileCredentialStore } from "../src/provider-credential-store.ts";

/**
 * The store's abort contract, at the door a login's credential arrives through.
 *
 * Upstream hands `modify` the login's own signal and calls it after its network work has settled, so the two moments that
 * belong to this store — waiting for the file lock, and committing what `fn` returned — are where a cancelled or expired
 * sign-in is still separable from one that stored a credential. So these tests hold the lock from outside, the way the pi
 * CLI or a second gateway process of the same account does, and ask what an abort arriving mid-wait costs.
 *
 * The other half of the contract is what must *not* change: a legitimate wait for another writer still commits exactly once,
 * and the read-decide-write stays one lock. An abort check that let a write through the queue, or that re-ran `fn` on a
 * retry, would be worse than the bug it fixed.
 */

const KEY = "{{API_KEY_5d1f7c0b8e934a26}}";
const ACCESS = "ya29.a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9";
const REFRESH = "1//0abcdefghijklmnopqrstuvwx1234567890ABCDEFGH";
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const oauth = (): Credential => ({ type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000 });

/** One host's credential file, with a lock budget short enough that a refused wait is a test result and not a hang. */
async function fixture(initial?: Record<string, unknown>): Promise<{ store: ProviderFileCredentialStore; file: ProviderCredentialFile; path: string }> {
	const base = await mkdtemp(join(tmpdir(), "hepi-credential-store-"));
	directories.push(base);
	const path = join(base, "auth.json");
	if (initial !== undefined) await writeFile(path, JSON.stringify(initial, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
	const file = new ProviderCredentialFile(path, 2_000);
	return { store: new ProviderFileCredentialStore(file), file, path };
}

/** Another writer holding the lock of this file, exactly as provider-auth.test.ts stages that contention. */
async function holdLock(path: string): Promise<() => Promise<void>> {
	return await lockfile.lock(path, { realpath: false, stale: 30_000, retries: 0 });
}

function aborted(reason: Error): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

test("a write whose caller already went away stores nothing and is never asked its credential decision", async () => {
	const f = await fixture({ anthropic: { type: "api_key", key: KEY } });
	let asked = 0;
	const reason = new Error("this sign-in was cancelled");
	await assert.rejects(
		f.store.modify("openai", async () => { asked += 1; return oauth(); }, { signal: aborted(reason) }),
		(error: unknown) => error === reason,
		"the abort reached the caller as something other than the reason it carries",
	);
	assert.equal(asked, 0, "a cancelled flow was still asked to decide a credential");
	const records = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(records), ["anthropic"], "the aborted write added an entry to the account file");
});

test("a caller that ends while the write waits for another writer stores nothing, and the decision is not replayed", async () => {
	const f = await fixture({ anthropic: { type: "api_key", key: KEY } });
	const release = await holdLock(f.path);
	let asked = 0;
	const controller = new AbortController();
	const pending = f.store.modify("openai", async () => {
		asked += 1;
		await delay(40);
		return oauth();
	}, { signal: controller.signal });
	await delay(20); // the write is queued behind the other writer now
	// The flow ends here — a cancel, a deadline, a revoked bearer — while this store is still waiting for the lock.
	controller.abort(new Error("this sign-in was cancelled"));
	await release();
	const caught: unknown = await pending.catch((error: unknown) => error);
	assert.ok(caught instanceof Error && /cancelled/i.test(caught.message), "the queued write resolved instead of aborting: " + JSON.stringify(caught));
	assert.equal(asked, 0, "a flow this host ended still had its credential decision asked");
	const records = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
	assert.deepEqual(Object.keys(records), ["anthropic"], "the aborted write committed an entry once the lock was handed to it");
});

test("an answer that arrives after the credential was decided is refused, not committed", async () => {
	const f = await fixture();
	const controller = new AbortController();
	// fn awaits — a provider handing the store its token is not instantaneous — and the caller ends during that await.
	const written = f.store.modify("openai", async () => {
		const pending = new Promise<Credential>((resolve) => setTimeout(() => resolve(oauth()), 60));
		controller.abort(new Error("this sign-in has ended"));
		return await pending;
	}, { signal: controller.signal });
	const caught: unknown = await written.catch((error: unknown) => error);
	assert.ok(caught instanceof Error && /ended/i.test(caught.message), "a credential decided after the abort was committed anyway");
	assert.deepEqual(f.file.read(), {}, "the late credential was stored after its flow was ended");
});

test("a legitimate wait for another writer commits exactly once, under one lock covering the whole decision", async () => {
	const f = await fixture({ anthropic: { type: "api_key", key: KEY } });
	const release = await holdLock(f.path);
	let asked = 0;
	const pending = f.store.modify("openai", async () => {
		asked += 1;
		// Asked inside the lock: what is stored right now is what the decision sees, which is the property that keeps a token
		// another process just rotated from being overwritten by a stale one.
		assert.equal("openai" in f.file.read(), false, "the decision was asked before the lock was this writer's");
		await delay(60);
		return oauth();
	});
	await delay(20);
	await release();
	assert.equal((await pending)?.type, "oauth");
	assert.equal(asked, 1, "waiting for the lock replayed the credential decision");
	const stored = f.file.read();
	assert.deepEqual(Object.keys(stored).sort(), ["anthropic", "openai"], "the other writer's entry was lost");
	assert.equal((stored.anthropic as { key?: string }).key, KEY);
	assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("writes to one file all land, each under the lock it waited for", async () => {
	const f = await fixture();
	await Promise.all([
		f.store.modify("openai", async () => oauth()),
		f.store.modify("anthropic", async () => ({ type: "api_key", key: KEY }) as Credential),
		f.store.modify("xai", async () => ({ ...oauth(), access: "ya29.a0secondsecondsecondsecond" })),
	]);
	const stored = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, { type?: string }>;
	assert.deepEqual(Object.keys(stored).sort(), ["anthropic", "openai", "xai"], "one concurrent write was lost");
	assert.deepEqual(Object.values(stored).map((entry) => entry.type).sort(), ["api_key", "oauth", "oauth"]);
});

test("a read and a list answer the file as it stands and need no signal", async () => {
	const f = await fixture({ openai: { type: "oauth", access: ACCESS, refresh: REFRESH } });
	assert.equal((await f.store.read("openai", { signal: aborted(new Error("unused")) }))?.type, "oauth", "a read refused a credential it was never asked to write");
	assert.deepEqual(await f.store.list(), [{ providerId: "openai", type: "oauth" }]);
	assert.equal(await f.store.read("groq"), undefined);
});
