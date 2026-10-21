import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { WEB_LOGOUT_PATH } from "@hepi/protocol";
import { createClientIngress, DEFAULT_REVOCATION_CHECK_INTERVAL_MS, WEB_SESSION_COOKIE, type ClientIngress, type ClientIngressSettings } from "../src/ingress/index.ts";

/**
 * The client ingress over a real Backend, over real HTTP.
 *
 * These are the public-seam tests for the credential path: a Web session and a device bearer, issuance and revocation,
 * the connection descriptor, preflight, the refusal of every other material and of the internal execution surface, and
 * the declared bound on how long an already attached stream outlives its revoked credential. The Backend is the real
 * one — its own credential records, its own identity answer — because the authority being tested is the one that ships.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const workspace = async (): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), "hepi-ingress-")); directories.push(directory); return directory; };

const BACKEND_TOKEN = "backend-service-token";
const WEB_LOGIN = "web-login-material";

type Fixture = {
	origin: string;
	backend: BackendServer;
	credentialsPath: string;
	ingress: ClientIngress;
	close(): Promise<void>;
};

/** One real Backend with device credentials, and one client ingress in front of it. */
async function fixture(options: { webLoginToken?: string; appOrigins?: readonly string[]; revocationCheckIntervalMs?: number; startIngress?: boolean } = {}): Promise<Fixture> {
	const directory = await workspace();
	const credentialsPath = join(directory, "device-credentials.sqlite");
	const credentials = createDeviceCredentials({ path: credentialsPath });
	const backend = await createBackendServer({ dbPath: join(directory, "hepi.sqlite"), authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL, deviceCredentials: credentials, buildId: "build-1", backendId: "backend-1", accountScope: "account-1" });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const address = backend.server.address();
	assert.ok(address && typeof address === "object");
	const settings: ClientIngressSettings = {
		backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN },
		...(options.webLoginToken === undefined ? {} : { webLoginToken: options.webLoginToken }),
		appOrigins: options.appOrigins ?? ["http://app.example"],
		...(options.revocationCheckIntervalMs === undefined ? {} : { revocationCheckIntervalMs: options.revocationCheckIntervalMs }),
	};
	const ingress = createClientIngress(settings);
	if (options.startIngress !== false) await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	return {
		origin: "http://127.0.0.1:" + ingressAddress.port,
		backend,
		credentialsPath,
		ingress,
		close: async () => { await ingress.close(); credentials.close(); await backend.close(); },
	};
}

/** The cookie pair a Web login set, as the browser sends it back. */
function sessionCookie(response: Response): string {
	const header = response.headers.get("set-cookie");
	assert.ok(header, "the login response set no cookie");
	const pair = header.split(";")[0]!;
	assert.ok(pair.startsWith(WEB_SESSION_COOKIE + "="), "the login cookie is not the Web session cookie");
	return pair;
}
async function webSession(origin: string, token: string): Promise<string> {
	const response = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
	assert.equal(response.status, 200);
	return sessionCookie(response);
}
/** One device credential, issued the way a Web session issues one. */
async function issueDevice(origin: string, cookie: string, label = "phone"): Promise<{ credential: { id: string; label: string; createdAt: string; revoked: boolean }; token: string }> {
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label }) });
	assert.equal(issued.status, 201);
	return await issued.json() as { credential: { id: string; label: string; createdAt: string; revoked: boolean }; token: string };
}

test("a device credential is issued as a token and stored only as its digest", async () => {
	const path = join(await workspace(), "device-credentials.sqlite");
	const credentials = createDeviceCredentials({ path });
	try {
		const issued = credentials.issue({ label: "workstation laptop" });
		assert.equal(issued.credential.label, "workstation laptop");
		assert.ok(issued.token.length >= 32);
		assert.deepEqual(credentials.check(issued.token), { ok: true, credential: issued.credential });
		const db = new DatabaseSync(path);
		const row = db.prepare("SELECT token_digest, label FROM device_credentials WHERE id = ?").get(issued.credential.id) as { token_digest: string; label: string };
		db.close();
		assert.equal(row.token_digest, createHash("sha256").update(issued.token).digest("hex"));
		assert.notEqual(row.token_digest, issued.token);
		assert.equal(row.label, "workstation laptop");
		assert.ok(!(await readFile(path)).includes(issued.token), "the credential file contains the raw token");
	} finally {
		credentials.close();
	}
});

test("a revoked device credential stays revoked across a restart and leaves the others usable", async () => {
	const path = join(await workspace(), "device-credentials.sqlite");
	const first = createDeviceCredentials({ path });
	const revoked = first.issue({ label: "old phone" });
	const kept = first.issue({ label: "tablet" });
	assert.equal(first.revoke(revoked.credential.id), true);
	assert.equal(first.revoke(revoked.credential.id), true, "revoking an already revoked credential is not an error");
	assert.equal(first.revoke("no-such-credential"), false);
	assert.deepEqual(first.check(revoked.token), { ok: false, reason: "revoked" });
	assert.deepEqual(first.check("not-a-credential"), { ok: false, reason: "unknown" });
	first.close();
	const restarted = createDeviceCredentials({ path });
	try {
		assert.deepEqual(restarted.check(revoked.token), { ok: false, reason: "revoked" });
		assert.equal(restarted.check(kept.token).ok, true);
		assert.deepEqual(restarted.list().map(entry => [entry.id, entry.revoked]), [[revoked.credential.id, true], [kept.credential.id, false]]);
	} finally {
		restarted.close();
	}
});

test("the connection descriptor needs a client identity and answers the Backend's own facts", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		assert.equal((await fetch(target.origin + "/api/descriptor")).status, 401);
		const cookie = await webSession(target.origin, WEB_LOGIN);
		const response = await fetch(target.origin + "/api/descriptor", { headers: { cookie } });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			protocol: "hepi.v1",
			client: { kind: "web" },
			backend: { id: "backend-1" },
			account: { scope: "account-1" },
			build: { id: "build-1" },
			capabilities: { conversations: true, projects: false, skillMarket: false, modelConfiguration: false, workspaceResources: false, deviceCredentials: true },
		});
		// The descriptor is the Backend's answer, not the ingress's invention: the Backend states its own build id.
		const device = await issueDevice(target.origin, cookie, "laptop");
		const asDevice = await fetch(target.origin + "/api/descriptor", { headers: { authorization: "Bearer " + device.token } });
		assert.deepEqual(((await asDevice.json()) as { client: unknown }).client, { kind: "device", id: device.credential.id, label: "laptop" });
	} finally {
		await target.close();
	}
});

test("an unauthenticated caller learns whether Web login is enabled and nothing else", async () => {
	const disabled = await fixture();
	try {
		assert.deepEqual(await (await fetch(disabled.origin + "/api/web-auth")).json(), { enabled: false });
		const login = await fetch(disabled.origin + "/api/web-login", { method: "POST", headers: { origin: disabled.origin, "content-type": "application/json" }, body: JSON.stringify({ token: "" }) });
		assert.equal(login.status, 404, "a deployment with no login material accepted a login");
		assert.equal((await fetch(disabled.origin + "/api/conversations", { headers: { cookie: WEB_SESSION_COOKIE + "=" } })).status, 401);
		assert.equal((await fetch(disabled.origin + "/api/descriptor")).status, 401);
	} finally {
		await disabled.close();
	}
	const enabled = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		assert.deepEqual(await (await fetch(enabled.origin + "/api/web-auth")).json(), { enabled: true });
		assert.equal((await fetch(enabled.origin + "/api/conversations")).status, 401);
	} finally {
		await enabled.close();
	}
});

test("Web login sets an HttpOnly cookie, refuses the wrong material and logout clears it", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		assert.equal((await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: target.origin, "content-type": "application/json" }, body: JSON.stringify({ token: "not-the-login" }) })).status, 401);
		assert.equal((await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: "http://elsewhere.example", "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) })).status, 403, "a cookie write from another origin was accepted");
		const login = await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: target.origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
		assert.equal(login.status, 200);
		const header = login.headers.get("set-cookie") ?? "";
		assert.match(header, /HttpOnly/);
		assert.match(header, /SameSite=Strict/);
		const cookie = sessionCookie(login);
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { cookie } })).status, 200);
		// The route is the one constant the page and this listener both read: a page that spelled it differently would be
		// answered by whatever else that path is — for the obsolete spelling below, an authenticated route forwarded to the
		// Backend, which leaves the cookie exactly where it was.
		const logout = await fetch(target.origin + WEB_LOGOUT_PATH, { method: "DELETE", headers: { origin: target.origin, cookie } });
		assert.equal(logout.status, 200);
		const cleared = logout.headers.get("set-cookie") ?? "";
		assert.match(cleared, /Max-Age=0/);
		assert.match(cleared, new RegExp(WEB_SESSION_COOKIE + "=;"));
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { cookie: WEB_SESSION_COOKIE + "=" } })).status, 401);
		// A logout is the cookie's, not the read's: the route that reports the login state answers no DELETE, and a cookie
		// session that asked it is still admitted afterwards.
		const obsolete = await fetch(target.origin + "/api/web-auth", { method: "DELETE", headers: { origin: target.origin, cookie } });
		assert.notEqual(obsolete.status, 200, "the login-state route answered a logout");
		assert.equal(obsolete.headers.get("set-cookie"), null, "the login-state route cleared the session cookie");
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { cookie } })).status, 200, "the cookie was cleared by a route that is not the logout");
		// A cookie write is same-origin or it is not this session's write at all.
		assert.equal((await fetch(target.origin + WEB_LOGOUT_PATH, { method: "DELETE", headers: { origin: "http://elsewhere.example", cookie } })).status, 403);
	} finally {
		await target.close();
	}
});

test("a device bearer's logout route is the browser's cookie, never its own credential", async () => {
	// The route clears an HttpOnly cookie; it is not a credential operation. A device that asked it would end nothing —
	// and the one thing it must not do is revoke the bearer that asked, or stop the work that bearer is watching. The
	// App's own disconnection is its shell's, which holds the material; this route is the Web page's and stays that.
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	const issued = await issueDevice(target.origin, cookie, "app");
	const bearer = { authorization: "Bearer " + issued.token };
	try {
		const answer = await fetch(target.origin + WEB_LOGOUT_PATH, { method: "DELETE", headers: { origin: target.origin, authorization: bearer.authorization } });
		assert.equal(answer.status, 200);
		assert.match(answer.headers.get("set-cookie") ?? "", new RegExp(WEB_SESSION_COOKIE + "=;"), "the route cleared the browser cookie and nothing else");
		// The credential that asked is untouched: it still reads, and the record the Web session lists still says so.
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: bearer })).status, 200, "a device's logout revoked the device");
		const listed = await fetch(target.origin + "/api/device-credentials", { headers: { cookie } });
		assert.deepEqual(((await listed.json()) as { credentials: { revoked: boolean }[] }).credentials.map(entry => entry.revoked), [false]);
		// And the Web session the cookie belongs to is a different fact: it ended, and asks for admission again.
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { cookie: WEB_SESSION_COOKIE + "=" } })).status, 401);
	} finally {
		await target.close();
	}
});

test("the login material, the service credential and an execution token are not client bearers", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		for (const token of [WEB_LOGIN, BACKEND_TOKEN, "execution-token"]) {
			assert.equal((await fetch(target.origin + "/api/descriptor", { headers: { authorization: "Bearer " + token } })).status, 401, token + " was accepted as a client bearer");
			assert.equal((await fetch(target.origin + "/api/conversations", { headers: { authorization: "Bearer " + token } })).status, 401, token + " reached the Backend as a client bearer");
		}
		// The service credential still works where it belongs: the Backend answers it directly, and the ingress forwards it.
		assert.equal((await fetch("http://127.0.0.1:" + (target.backend.server.address() as { port: number }).port + "/api/conversations", { headers: { authorization: "Bearer " + BACKEND_TOKEN } })).status, 200);
	} finally {
		await target.close();
	}
});

test("a device bearer authenticates, is revoked with no cached success, and stays revoked after a restart", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	const issued = await issueDevice(target.origin, cookie);
	const bearer = { authorization: "Bearer " + issued.token };
	try {
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: bearer })).status, 200);
		// Issuing and enumerating devices is the Web session's authority, not a device's.
		assert.equal((await fetch(target.origin + "/api/device-credentials", { headers: bearer })).status, 403);
		assert.equal((await fetch(target.origin + "/api/device-credentials", { method: "POST", headers: { origin: target.origin, authorization: bearer.authorization, "content-type": "application/json" }, body: JSON.stringify({ label: "second" }) })).status, 403);
		assert.equal((await fetch(target.origin + "/api/device-credentials/" + issued.credential.id, { method: "DELETE", headers: { origin: target.origin, authorization: bearer.authorization } })).status, 403, "a device revoked itself");
		const listed = await fetch(target.origin + "/api/device-credentials", { headers: { cookie } });
		assert.equal(listed.status, 200);
		assert.deepEqual(await listed.json(), { credentials: [issued.credential] });
		assert.equal((await fetch(target.origin + "/api/device-credentials/" + issued.credential.id, { method: "DELETE", headers: { origin: target.origin, cookie } })).status, 200);
		// No success is cached: the next request is refused.
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: bearer })).status, 401);
		assert.equal((await fetch(target.origin + "/api/descriptor", { headers: bearer })).status, 401);
	} finally {
		await target.ingress.close();
		await target.backend.close();
	}
	// The record outlives the process: the same file, a new Backend and a new ingress keep the refusal.
	const credentials = createDeviceCredentials({ path: target.credentialsPath });
	const backend = await createBackendServer({ dbPath: join(await workspace(), "hepi.sqlite"), authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL, deviceCredentials: credentials });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const address = backend.server.address();
	assert.ok(address && typeof address === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN } });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	try {
		assert.equal((await fetch("http://127.0.0.1:" + ingressAddress.port + "/api/descriptor", { headers: bearer })).status, 401, "the restart restored a revoked credential");
	} finally {
		await ingress.close();
		credentials.close();
		await backend.close();
	}
});

test("a declared App origin gets preflight for authorization, content-type and last-event-id, and an unknown one is refused", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		const preflight = await fetch(target.origin + "/api/descriptor", { method: "OPTIONS", headers: { origin: "http://app.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization, content-type, last-event-id" } });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get("access-control-allow-origin"), "http://app.example");
		const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
		for (const name of ["authorization", "content-type", "last-event-id"]) assert.ok(allowed.includes(name), "preflight does not allow " + name);
		assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /GET/);
		assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /DELETE/);
		const unknown = await fetch(target.origin + "/api/descriptor", { method: "OPTIONS", headers: { origin: "http://unknown.example", "access-control-request-method": "GET" } });
		assert.equal(unknown.status, 403);
		assert.equal(unknown.headers.get("access-control-allow-origin"), null);
		assert.equal((await fetch(target.origin + "/api/web-auth", { headers: { origin: "http://unknown.example" } })).status, 403, "an undeclared origin was answered instead of refused");
		const cookie = await webSession(target.origin, WEB_LOGIN);
		const device = await issueDevice(target.origin, cookie);
		const answered = await fetch(target.origin + "/api/descriptor", { headers: { origin: "http://app.example", authorization: "Bearer " + device.token } });
		assert.equal(answered.status, 200);
		assert.equal(answered.headers.get("access-control-allow-origin"), "http://app.example");
		assert.match(answered.headers.get("access-control-expose-headers") ?? "", /last-event-id/i);
	} finally {
		await target.close();
	}
});

test("the internal execution surface is not served on the client listener", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	try {
		for (const path of ["/v1/execute", "/v1/terminal", "/v1/files/bytes", "/internal/credentials/verify"]) {
			for (const headers of [{ cookie }, { authorization: "Bearer " + BACKEND_TOKEN }, {}] as Record<string, string>[]) {
				assert.equal((await fetch(target.origin + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).status, 404, path + " was served on the client listener");
			}
		}
	} finally {
		await target.close();
	}
});

test("an unreachable authority or Backend fails closed instead of answering from a cached success", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	const device = await issueDevice(target.origin, cookie);
	try {
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { cookie } })).status, 200);
		await target.backend.close();
		assert.equal((await fetch(target.origin + "/api/descriptor", { headers: { cookie } })).status, 503);
		assert.equal((await fetch(target.origin + "/api/conversations", { headers: { authorization: "Bearer " + device.token } })).status, 503, "an unreachable authority was not a refusal");
	} finally {
		await target.ingress.close();
	}
});

test("an attached stream ends within the declared revocation bound and not before a re-check", { timeout: 20000 }, async () => {
	const interval = 100;
	const target = await fixture({ webLoginToken: WEB_LOGIN, revocationCheckIntervalMs: interval });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	const device = await issueDevice(target.origin, cookie);
	try {
		const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers: { authorization: "Bearer " + device.token, "content-type": "application/json" }, body: "{}" });
		assert.equal(created.status, 201);
		const conversationId = ((await created.json()) as { conversationId: string }).conversationId;
		const stream = await fetch(target.origin + "/api/conversations/" + conversationId + "/events", { headers: { authorization: "Bearer " + device.token } });
		assert.equal(stream.status, 200);
		const reader = stream.body!.getReader();
		const firstFrame = new TextDecoder().decode((await reader.read()).value);
		assert.match(firstFrame, /event: snapshot/, "the attached stream carried no frame");
		const revokedAt = Date.now();
		assert.equal((await fetch(target.origin + "/api/device-credentials/" + device.credential.id, { method: "DELETE", headers: { origin: target.origin, cookie } })).status, 200);
		const bound = DEFAULT_REVOCATION_CHECK_INTERVAL_MS * 4 + 1000;
		const ended = await Promise.race([
			(async () => { try { for (;;) { if ((await reader.read()).done) return "ended"; } } catch { return "aborted"; } })(),
			new Promise<string>(resolve => setTimeout(() => resolve("still open"), bound)),
		]);
		assert.notEqual(ended, "still open", "the revoked stream stayed open past the declared bound");
		assert.ok(Date.now() - revokedAt >= interval - 20, "the stream ended before a re-check could have run");
	} finally {
		await target.close();
	}
});

test("revoking a device ends its access without aborting the run behind it", { timeout: 20000 }, async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	const cookie = await webSession(target.origin, WEB_LOGIN);
	const device = await issueDevice(target.origin, cookie);
	const bearer = { authorization: "Bearer " + device.token, "content-type": "application/json" };
	try {
		const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers: bearer, body: "{}" });
		assert.equal(created.status, 201);
		const conversationId = ((await created.json()) as { conversationId: string }).conversationId;
		const submitted = await fetch(target.origin + "/api/conversations/" + conversationId + "/messages", { method: "POST", headers: bearer, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId, requestId: "revoked-mid-run", text: "keep going" }) });
		assert.equal(submitted.status, 202);
		assert.equal((await fetch(target.origin + "/api/device-credentials/" + device.credential.id, { method: "DELETE", headers: { origin: target.origin, cookie } })).status, 200);
		// The revoked device is out; the run it started is not. The Web session watches the same conversation settle.
		assert.equal((await fetch(target.origin + "/api/conversations/" + conversationId + "/events", { headers: { authorization: "Bearer " + device.token } })).status, 401);
		let entries: { text: string }[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			const state = await fetch(target.origin + "/api/conversations/" + conversationId + "/state", { headers: { cookie } });
			assert.equal(state.status, 200);
			const body = await state.json() as { entries: { text: string }[]; busy: boolean };
			entries = body.entries;
			if (!body.busy && entries.length >= 2) break;
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.deepEqual(entries.map(entry => entry.text), ["keep going", "Server reply to: keep going"], "the run did not finish after the credential was revoked");
	} finally {
		await target.close();
	}
});

