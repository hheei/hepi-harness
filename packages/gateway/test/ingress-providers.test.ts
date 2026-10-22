import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createFauxCore, createProvider, type AuthEvent, type AuthPrompt, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { GatewayRpcServer, LocalGateway, MemoryLedger, ProviderAuthService, ProviderLoginService, WorkspaceRegistry, agentDirOf, builtinProviderCatalog } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";

/**
 * Provider connection through the client ingress, over real HTTP against a real Backend and a real credential host.
 *
 * This is the public-seam test for ticket 02: the ordinary journey a Settings › Models panel takes — read the listing,
 * store a key, read it back, disconnect it — plus what each failure means to the caller. The seam is the client API
 * (`GET /api/auth/providers`, `POST|DELETE /api/auth/api-key/:id`), because that is what a Web page and an App both call,
 * and behind it the host's own `POST /v1/providers/auth` and the account's `auth.json`.
 *
 * Two facts are asserted in every test here, and together they are the ticket: the raw key never appears in any answer,
 * because the host answers a listing of presence, type and a masked hint; and the durable Backend is never asked about a
 * provider at all, because these routes belong to the host this origin runs on and are answered before anything is
 * forwarded. The credential written here is a synthetic string, and it is checked that it reaches only the host's file.
 *
 * A sign-in is tested here as far as this entrance owns it — which caller may follow a flow, what a revoked one loses, and
 * that an answer never travels on a route the Backend sees. The flow's own lifecycle is the host service's and is covered
 * at that seam in `provider-login.test.ts`.
 */

const BACKEND_TOKEN = "provider-ingress-backend-token";
const WEB_LOGIN = "provider-ingress-login";
const GATEWAY_TOKEN = "provider-ingress-gateway-token";
const KEY = "sk-test-0123456789abcdefghijklmnop";
const PROVIDER = "anthropic";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
const temporary = async (prefix: string): Promise<string> => { const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory; };

/**
 * A host that accepts a connection and drops it without an answer: what a gateway process that is down looks like from
 * here. Nothing waits on it — a silent listener that held the socket would turn every case that reaches it into a
 * thirty-second deadline — so the drop is the transport fact the routes have to classify.
 */
function silentHost(): Server {
	const server = createServer();
	server.on("connection", (socket) => { socket.destroy(); });
	return server;
}

type Host = {
	readonly origin: string;
	readonly agentDir: string;
	readonly authPath: string;
	close(): Promise<void>;
};

/**
 * One credential host: a real gateway serving `POST /v1/providers/auth` for an account directory of its own.
 *
 * The host context is stated rather than inherited, so a machine with a real `ANTHROPIC_API_KEY` in its environment does
 * not change what a listing reports here.
 */
async function host(options: { serveProviders?: boolean; serveLogins?: boolean; script?: ReturnType<typeof scripted>; graceMs?: number } = {}): Promise<Host> {
	const base = await temporary("hepi-ingress-provider-host-");
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const agentDir = agentDirOf(home);
	const registry = new WorkspaceRegistry([{ id: "local", root: home }]);
	const gateway = new LocalGateway({ id: "workstation", token: GATEWAY_TOKEN, workspaces: registry, allowedCommands: ["bash"] }, new MemoryLedger());
	// One catalog for both surfaces, as a deployment has one: the scripted provider this test signs in to has to be a
	// provider this host lists, or a flow that stored a credential would report a store the listing says it does not serve.
	const catalog = async () => [...(await builtinProviderCatalog()), { id: SIGN_IN, name: "Scripted", hasApiKey: true, hasOAuth: true }];
	const providers = options.serveProviders === false
		? undefined
		: new ProviderAuthService({ agentDir, context: { env: async () => undefined, fileExists: async () => false }, catalog });
	// A sign-in needs a provider whose flow a test can drive, and the real credential file to write into: the scripted
	// provider is registered beside the SDK's set, exactly as a test of the host service would, so this entrance relays a
	// flow that is upstream's work rather than a stand-in for it.
	const script = options.script ?? scripted();
	const logins = options.serveLogins === false || providers === undefined
		? undefined
		: new ProviderLoginService({
				agentDir,
				context: { env: async () => undefined, fileExists: async () => false },
				auth: providers,
				catalog,
				extraProviders: [script.provider],
				// A case that holds a flow where the provider never reports a step would otherwise spend the production
				// grace on every start; the bound itself is unchanged.
				...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
			});
	const server = new GatewayRpcServer({ gateway, files: new LocalFilesystem(registry), providers, providerLogins: logins, });
	await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
	const address = server.server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		agentDir,
		authPath: join(agentDir, "auth.json"),
		close: async () => { logins?.stop(); server.server.closeAllConnections(); await server.close(); },
	};
}

/** The provider this test signs in to, which is the scripted one the host was built with. */
const SIGN_IN = "scripted";
const ACCESS = "ya29.a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9";
const REFRESH = "1//0abcdefghijklmnopqrstuvwx1234567890ABCDEFGH";

/**
 * A provider whose sign-in a test can hold at any step.
 *
 * It states an address, asks for a value, and then waits on the flow's own signal before it would store a credential — the
 * device/paste-back shape a real provider has. `exchange` says how long the step after an answer takes, which is what lets
 * a revocation be shown arriving mid-exchange rather than after it.
 */
function scripted(options: { exchangeMs?: number } = {}): {
	readonly provider: Provider;
	/** Every answer the flow was handed, in order — the fixture's own record of what this entrance delivered. */
	answers(): string[];
	phaseReached(): string[];
} {
	const answers: string[] = [];
	const reached: string[] = [];
	const exchangeMs = options.exchangeMs ?? 30_000;
	const provider: Provider = createProvider({
		id: SIGN_IN,
		name: "Scripted",
		auth: {
			apiKey: { name: "Scripted API key", resolve: async () => undefined },
			oauth: {
				name: "Scripted subscription",
				isSubscription: true,
				login: async (interaction) => {
					const aborted = new Promise<never>((_resolve, reject) => {
						const stop = (): void => reject(interaction.signal.reason);
						if (interaction.signal.aborted) stop();
						else interaction.signal.addEventListener("abort", stop, { once: true });
					});
					reached.push("login");
					interaction.notify({ type: "auth_url", url: "https://scripted.example/oauth/authorize?code_challenge=E9Melhoa2Owv&state=abc", instructions: "Approve the sign-in in the browser" } as AuthEvent);
					reached.push("prompt");
					answers.push(await Promise.race([interaction.prompt({ type: "manual_code", message: "Paste the redirect address" } as AuthPrompt), aborted]));
					reached.push("answered");
					// The fixture's own exchange, not the host's deadline: unref'd so a case that never unblocks it is not a reason
					// this run stays alive after its assertions.
					await Promise.race([new Promise((resolve) => setTimeout(resolve, exchangeMs).unref()), aborted]);
					reached.push("exchanged");
					return { type: "oauth", access: ACCESS, refresh: REFRESH, expires: Date.now() + 3_600_000 } satisfies OAuthCredential;
				},
				refresh: async (stored) => stored,
				toAuth: async () => ({ headers: { authorization: "Bearer scripted" } }),
			},
		},
		models: createFauxCore({ provider: SIGN_IN }).models,
		api: { stream: createFauxCore({ provider: SIGN_IN }).stream, streamSimple: createFauxCore({ provider: SIGN_IN }).streamSimple },
	});
	return { provider, answers: () => answers.slice(), phaseReached: () => reached.slice() };
}

/** The flow this host reported for a caller, narrowed the way a panel narrows it. */
function flowOf(answer: { status: number; body: any; text: string }): any {
	assert.equal(answer.status, 200, answer.text);
	assert.equal(answer.body.success, true, answer.body.error ?? answer.text);
	assert.equal(typeof answer.body.flow?.flowId, "string", "the route answered no flow: " + answer.text);
	return answer.body.flow;
}

type Deployment = {
	readonly origin: string;
	readonly host: Host;
	readonly cookie: string;
	readonly device: string;
	/** The id of `device`, which is what a revocation names. */
	readonly deviceId: string;
	/** Issue another caller's credential, so two admitted clients can be told apart. */
	issueDevice(label: string): Promise<{ id: string; token: string }>;
	/** One call with an arbitrary bearer, so a second admitted client can be told apart from the first. */
	as(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any; text: string }>;
	/** End one credential, as the Web session that owns the list of them does. */
	revoke(id: string): Promise<number>;
	/** Every request that actually reached the Backend, as the relay in front of it recorded it. */
	backendRequests(): { method: string; url: string; body: string }[];
	/** One admitted call, as the Web page (its cookie) or the App (its device bearer) makes it. */
	call(identity: "web" | "device", path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any; text: string }>;
	close(): Promise<void>;
};

/**
 * One recording relay in front of the real Backend.
 *
 * The claim this fixture has to make is that the durable Backend was never asked about a provider and never saw a
 * credential, and only the Backend's own listener can say what arrived there. Reading it from outside — a recording hop
 * that forwards method, headers and body unchanged and writes the answer back unchanged — is what lets the test state
 * that without touching the Backend's request parsing from a second listener.
 */
async function relayTo(backendOrigin: string): Promise<{ origin: string; received: { method: string; url: string; body: string }[]; close(): Promise<void> }> {
	const received: { method: string; url: string; body: string }[] = [];
	const relay: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks);
			received.push({ method: request.method ?? "", url: request.url ?? "", body: body.toString("utf8") });
			const headers: Record<string, string> = {};
			// Only the hop-by-hop headers are dropped: a copied `transfer-encoding` next to the body this relay already read
			// is a pair a caller cannot send twice.
			for (const [name, value] of Object.entries(request.headers)) {
				if (typeof value !== "string") continue;
				if (name === "host" || name === "transfer-encoding" || name === "connection" || name === "content-length" || name === "content-encoding") continue;
				headers[name] = value;
			}
			void fetch(backendOrigin + (request.url ?? "/"), { method: request.method, headers, ...(body.length === 0 ? {} : { body }) })
				.then(async (answer) => {
					response.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([name]) => name.toLowerCase() !== "transfer-encoding")));
					response.end(Buffer.from(await answer.arrayBuffer()));
				}, () => response.destroy());
		});
	});
	await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
	const address = relay.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		received,
		close: async () => { relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve())); },
	};
}

/**
 * One real Backend with device credentials, one client ingress in front of it, and the credential host it serves.
 * `serveHost` false is a deployment that configures no host service at all, which is a legitimate deployment and answers
 * a named limit while every other route keeps working.
 */
async function deployment(options: { host?: Host; serveHost?: boolean; serveLogins?: boolean; script?: ReturnType<typeof scripted>; revocationCheckIntervalMs?: number; graceMs?: number } = {}): Promise<Deployment> {
	const directory = await temporary("hepi-ingress-provider-");
	const providerHost = options.host ?? await host({ serveLogins: options.serveLogins, script: options.script, ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }) });
	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const backend: BackendServer = await createBackendServer({
		dbPath: join(directory, "hepi.sqlite"),
		authToken: BACKEND_TOKEN,
		models: fauxModels(),
		defaultModel: SERVER_MODEL,
		deviceCredentials: credentials,
		buildId: "build-1",
		backendId: "backend-1",
		accountScope: "account-1",
	});
	await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
	const backendAddress = backend.server.address();
	assert.ok(backendAddress !== null && typeof backendAddress === "object");
	const relay = await relayTo("http://127.0.0.1:" + backendAddress.port);
	const ingress: ClientIngress = createClientIngress({
		backend: { origin: relay.origin, serviceToken: BACKEND_TOKEN },
		webLoginToken: WEB_LOGIN,
		appOrigins: ["http://app.example"],
		...(options.serveHost === false ? {} : { mcp: { origin: providerHost.origin, token: GATEWAY_TOKEN, gatewayId: "workstation" } }),
		...(options.revocationCheckIntervalMs === undefined ? {} : { revocationCheckIntervalMs: options.revocationCheckIntervalMs }),
	});
	await new Promise<void>((resolve) => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress !== null && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="));
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
	assert.equal(issued.status, 201);
	const issuedBody = (await issued.json()) as { token: string; credential: { id: string } };
	const device = issuedBody.token;
	/** The id this credential carries, which is what a revocation names. */
	const deviceId = issuedBody.credential.id;
	const bearerCall = async (token: string, path: string, init: { method?: string; body?: unknown } = {}) => {
		const headers: Record<string, string> = { authorization: "Bearer " + token };
		if (init.body !== undefined) { headers["content-type"] = "application/json"; headers.origin = origin; }
		else if (init.method !== undefined && init.method !== "GET") headers.origin = origin;
		const response = await fetch(origin + path, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
		const text = await response.text();
		return { status: response.status, body: JSON.parse(text) as any, text };
	};
	return {
		origin,
		host: providerHost,
		cookie,
		device,
		deviceId,
		issueDevice: async (label) => {
			const next = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label }) });
			assert.equal(next.status, 201);
			const body = (await next.json()) as { token: string; credential: { id: string } };
			return { token: body.token, id: body.credential.id };
		},
		as: (token, path, init) => bearerCall(token, path, init),
		revoke: async (id) => (await fetch(origin + "/api/device-credentials/" + encodeURIComponent(id), { method: "DELETE", headers: { cookie, origin } })).status,
		backendRequests: () => relay.received.slice(),
		call: async (identity, path, init = {}) => {
			const headers: Record<string, string> = identity === "web" ? { cookie } : { authorization: "Bearer " + device };
			if (init.body !== undefined) { headers["content-type"] = "application/json"; headers.origin = origin; }
			else if (init.method !== undefined && init.method !== "GET") headers.origin = origin;
			const response = await fetch(origin + path, { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
			const text = await response.text();
			return { status: response.status, body: JSON.parse(text) as any, text };
		},
		close: async () => { await ingress.close(); await relay.close(); credentials.close(); await backend.close(); if (options.host === undefined) await providerHost.close(); },
	};
}

/** The panel's row for one provider, out of a listing answer. */
function rowOf(body: { apiKeyProviders?: any[] }, id = PROVIDER): any {
	return (body.apiKeyProviders ?? []).find((row: any) => row.id === id);
}

test("the client API lists this host's providers and stores, reads back and removes an API key", async () => {
	const d = await deployment();
	try {
		// The listing is the host's own provider set, with nothing stored on a fresh account.
		const empty = await d.call("web", "/api/auth/providers");
		assert.equal(empty.status, 200);
		assert.ok(Array.isArray(empty.body.apiKeyProviders) && empty.body.apiKeyProviders.length > 0, "the listing named no providers");
		assert.equal(rowOf(empty.body).storedType, undefined);
		assert.equal(rowOf(empty.body).maskedHint, undefined);
		assert.equal(rowOf(empty.body).configured, false);
		assert.equal(existsSync(d.host.authPath), false, "a read created a credential file");

		// One key, as the panel sends it: written to this host's file, and answered back only as presence and a hint.
		const saved = await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: { apiKey: KEY } });
		assert.equal(saved.status, 200, saved.text);
		assert.equal(saved.body.success, true);
		assert.equal(saved.text.includes(KEY), false, "the raw key came back in the answer");
		const stored = JSON.parse(readFileSync(d.host.authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
		assert.equal(stored[PROVIDER]?.type, "api_key");
		assert.equal(stored[PROVIDER]?.key, KEY, "the key did not reach the host's own file");
		const row = (saved.body.providers as any[]).find((entry: any) => entry.id === PROVIDER)!;
		assert.equal(row.storedType, "api_key");
		assert.equal(row.configured, true);
		// The hint is the host's masked form: enough to tell two keys apart, never the value.
		assert.equal(typeof row.maskedHint, "string");
		assert.ok(!row.maskedHint.includes(KEY.slice(4, -4)), "the hint carried the middle of the key");

		// The next listing reads the same state, and the App's own bearer reads it too.
		const listed = await d.call("device", "/api/auth/providers");
		assert.equal(listed.status, 200);
		assert.equal(rowOf(listed.body).storedType, "api_key");
		assert.equal(rowOf(listed.body).maskedHint, row.maskedHint);

		// Removing it asks with the type this listing read, and answers the state afterwards.
		const removed = await d.call("web", "/api/auth/api-key/" + PROVIDER + "?expectedType=" + row.storedType, { method: "DELETE" });
		assert.equal(removed.status, 200, removed.text);
		assert.equal(removed.text.includes(KEY), false, "the raw key came back in the removal answer");
		assert.equal((removed.body.providers as any[]).find((entry: any) => entry.id === PROVIDER)!.storedType, undefined);
		assert.equal(JSON.parse(readFileSync(d.host.authPath, "utf8"))[PROVIDER], undefined, "the removal left the entry in place");

		// A removal of something that is not there is an idempotent success: a second panel or a repeated click learns
		// the same state rather than an error it cannot act on.
		const again = await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "DELETE" });
		assert.equal(again.status, 200, again.text);

		// The Backend was never part of any of this: not one provider request, and no body carrying the key.
		const asked = d.backendRequests();
		assert.deepEqual(asked.filter(entry => entry.url.includes("auth/")), [], "the ingress forwarded a provider route to the Backend");
		for (const entry of asked) assert.ok(!entry.body.includes(KEY), "a Backend request carried the raw key: " + entry.url);
	} finally { await d.close(); }
});

test("a provider-auth failure is named so the panel can say what to do next", async () => {
	const d = await deployment();
	try {
		// An id this host serves no provider for is refused before anything is written, and reads as the wrong target
		// rather than as a fault.
		const unknown = await d.call("web", "/api/auth/api-key/no-such-provider", { method: "POST", body: { apiKey: KEY } });
		assert.equal(unknown.status, 403, unknown.text);
		assert.equal(unknown.body.code, "unknown_provider");
		assert.equal(unknown.body.success, false);
		assert.ok((unknown.body.error as string).length > 0, "the refusal named no reason");
		assert.equal(existsSync(d.host.authPath), false, "a refusal wrote a credential file");

		// A write that carries no key is refused by this surface, without asking the host to interpret it.
		const noKey = await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: {} });
		assert.equal(noKey.status, 400, noKey.text);
		assert.equal(noKey.body.code, "invalid_request");

		// A guard that does not match what the host now holds refuses and leaves the entry alone: a stale panel cannot
		// delete a credential that was replaced by a different method in the meantime.
		await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: { apiKey: KEY } });
		const mismatch = await d.call("web", "/api/auth/api-key/" + PROVIDER + "?expectedType=oauth", { method: "DELETE" });
		assert.equal(mismatch.status, 409, mismatch.text);
		assert.equal(mismatch.body.code, "credential_mismatch");
		assert.equal(JSON.parse(readFileSync(d.host.authPath, "utf8"))[PROVIDER]?.key, KEY, "a refused removal changed the file");
		assert.equal(mismatch.text.includes(KEY), false, "the refusal carried the raw key");

		// A method this route does not have is the wrong route, not a host failure.
		const wrong = await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "PUT" });
		assert.equal(wrong.status, 405, wrong.text);

		// And an unknown query guard is refused here rather than forwarded as a nameless expectedType.
		const badGuard = await d.call("web", "/api/auth/api-key/" + PROVIDER + "?expectedType=password", { method: "DELETE" });
		assert.equal(badGuard.status, 400, badGuard.text);
		assert.equal(badGuard.body.code, "invalid_request");
	} finally { await d.close(); }
});

test("an origin with no provider host service names the limit and keeps serving everything else", async () => {
	const d = await deployment({ serveHost: false });
	try {
		// The limit is the deployment's own state, so it is 503 with the sentence that names what to configure — the
		// same shape MCP uses, and not a listing of nothing, which a panel would read as "no provider is configured".
		const listed = await d.call("web", "/api/auth/providers");
		assert.equal(listed.status, 503);
		assert.equal(listed.body.code, "provider_auth_unavailable");
		assert.match(listed.body.error, /HEPI_INGRESS_MCP_GATEWAY_URL/);

		const written = await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: { apiKey: KEY } });
		assert.equal(written.status, 503);
		assert.equal(written.body.code, "provider_auth_unavailable");
		assert.equal(written.text.includes(KEY), false, "the refusal carried the raw key");

		// The named limit is not the whole surface: every other client route still answers.
		assert.equal((await d.call("web", "/api/descriptor")).status, 200);

		// And no identity is admitted for it either: the limit is what a caller that was admitted is told.
		const anonymous = await fetch(d.origin + "/api/auth/providers");
		assert.equal(anonymous.status, 401);
	} finally { await d.close(); }
});

test("a gateway that serves no provider capability is the deployment's limit, not a fault to retry", async () => {
	// An SSH gateway, or one composed without the service, answers `unsupported_operation`. That is the deployment
	// stating it does not do this at all, so it reads as the same 501 with `code: "unsupported"` every other unserved
	// Settings capability answers, and the panel withholds the control instead of offering a field that can only fail.
	// The host is closed with the deployment: a gateway this test created and left listening is a handle that keeps the
	// runner alive after every assertion has been made.
	const noCapability = await host({ serveProviders: false });
	const d = await deployment({ host: noCapability });
	try {
		const listed = await d.call("web", "/api/auth/providers");
		assert.equal(listed.status, 501, listed.text);
		assert.equal(listed.body.code, "unsupported");
		assert.match(listed.body.error, /no provider-auth capability/);
		assert.equal((await d.call("web", "/api/descriptor")).status, 200);
	} finally { await d.close(); await noCapability.close(); }
});

test("provider sign-out removes what is stored, whatever kind the listing did not name", async () => {
	// Sign-out is the host's own removal with no type named, so it drops an OAuth credential as well as a key. The flows
	// beside it are covered in `ingress-provider-login.test.ts`; this asserts the one route that shares the listing
	// surface's answer shape, on the seam the panel calls.
	const d = await deployment();
	try {
		await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: { apiKey: KEY } });
		const signedOut = await d.call("web", "/api/auth/logout/" + PROVIDER, { method: "POST", body: {} });
		assert.equal(signedOut.status, 200, signedOut.text);
		assert.equal(signedOut.body.success, true);
		const stored = JSON.parse(readFileSync(d.host.authPath, "utf8")) as Record<string, unknown>;
		assert.equal(stored[PROVIDER], undefined, "sign-out left the provider's entry in the host's file");
		assert.equal(signedOut.text.includes(KEY), false, "the sign-out answer carried the stored key");
	} finally { await d.close(); }
});

test("a sign-in's steps reach the caller through this entrance, its answer reaches the provider, and its credential lands on the host", async () => {
	// The whole journey a Settings panel takes, over real HTTP: start, read the question the provider is asking, answer
	// it, and see what the host stored. The exchange after the answer is short on purpose, so the answer's own reply can
	// carry the flow's ending rather than a bare "running" — which is the same reply a real panel gets and the reason it
	// polls: a flow that needs longer is answered as working, and read again.
	const script = scripted({ exchangeMs: 60 });
	const d = await deployment({ script });
	const PASTED = "http://localhost:53692/callback?code=4tY4Kj7m2QsVbX&state=xyz";
	try {
		const started = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		assert.equal(started.providerId, SIGN_IN);
		assert.equal(started.phase, "waiting_for_input", "the flow was reported as something other than the question it asks");
		// Both kinds of step at once is the copy-code case: a browser address to open and a value to paste back from it.
		assert.deepEqual(started.waitingFor, ["browser", "input"], "the caller was told to offer neither, or the wrong one");
		assert.equal(started.prompt?.type, "manual_code");
		// The address a person has to open travels whole. Its PKCE verifier is not a credential this host holds, and a
		// mask here would break the sign-in the flow is asking for.
		assert.match(started.event?.url ?? "", /code_challenge=E9Melhoa/, "the authorization address was damaged");
		assert.ok(started.expiresInMs > 0, "a waiting flow reported no deadline");

		// A repeated start by the same caller is the same sign-in: two browser addresses and two credentials racing one
		// file entry is worse than answering with the work already running.
		const again = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		assert.equal(again.flowId, started.flowId, "a repeated start opened a second flow");

		// A read reports the question still open and hands the provider nothing: following a flow is not answering it.
		const polled = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId)));
		assert.equal(polled.phase, "waiting_for_input");
		assert.equal(script.answers().length, 0, "a read handed the provider an answer nobody gave");

		// The answer: one body, one request, and the step it produced.
		const answered = await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId), { method: "POST", body: { answer: PASTED } });
		assert.equal(answered.status, 200, answered.text);
		assert.deepEqual(script.answers(), [PASTED], "the answer did not reach the provider that asked for it");
		const done = answered.body.flow;
		assert.equal(done.phase, "succeeded", "the flow was still not ended after its exchange: " + JSON.stringify(done));
		assert.equal(done.storedType, "oauth");
		assert.equal(done.expiresInMs, 0, "a finished flow still counted down");
		assert.deepEqual(done.waitingFor, [], "a finished flow still offered a field");
		// Nothing that came back is, or carries, what the person typed or what the flow produced.
		for (const secret of [PASTED, ACCESS, REFRESH]) assert.equal(answered.text.includes(secret), false, "the answer came back with " + secret.slice(0, 8) + "…");

		// The credential is the host's own file's, in pi's shape, and only that file's.
		const stored = JSON.parse(readFileSync(d.host.authPath, "utf8")) as Record<string, Record<string, unknown>>;
		assert.deepEqual(Object.keys(stored), [SIGN_IN], "a sign-in wrote someone else's entry");
		assert.equal(stored[SIGN_IN]?.type, "oauth");
		assert.equal(stored[SIGN_IN]?.access, ACCESS);
		assert.equal(statSync(d.host.authPath).mode & 0o777, 0o600, "the credential file is readable by others");

		// The listing beside it says configured without ever holding what made it configured.
		const listed = await d.call("web", "/api/auth/providers");
		const row = (listed.body.oauthProviders as any[]).find((entry: any) => entry.id === SIGN_IN);
		assert.equal(row?.storedType, "oauth");
		assert.equal(row?.configured, true, "a stored subscription was listed as an empty store");
		assert.equal(row?.source, "OAuth");
		for (const secret of [ACCESS, REFRESH, PASTED]) assert.equal(listed.text.includes(secret), false, "the listing carried a value");

		// And a finished flow stays followable for the host's own readable window, then says the same thing it did.
		const after = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId)));
		assert.equal(after.phase, "succeeded", "a poll arriving late learned something other than what happened");

		// None of this is the Backend's business: it saw no provider route, no sign-in, and no answer.
		const asked = d.backendRequests();
		assert.deepEqual(asked.filter((entry) => /auth\/|login/.test(entry.url)), [], "the ingress forwarded a provider route to the Backend");
		for (const entry of asked) {
			for (const secret of [KEY, PASTED, ACCESS, REFRESH]) assert.ok(!entry.body.includes(secret), "a Backend request carried a credential: " + entry.url);
		}
	} finally { await d.close(); }
});

test("a sign-in answers only the caller that started it, and another admitted client is told nothing", async () => {
	// One host bearer serves every client of an ingress, so the flow's id is the only thing separating two of them: it
	// has to be unguessable and it has to be checked. A refused read is worded exactly as an id that never existed,
	// because anything more would name the flows this host is running to someone who cannot act on them.
	const script = scripted();
	const d = await deployment({ script });
	const other = await d.issueDevice("second-device");
	try {
		const started = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		const follow = "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId);

		for (const [method, body] of [["GET", undefined], ["POST", { answer: "whoever-this-is" }], ["DELETE", undefined]] as const) {
			const refused = await d.as(other.token, follow, body === undefined ? { method } : { method, body });
			assert.equal(refused.status, 404, method + ": " + refused.text);
			assert.equal(refused.body.code, "flow_unknown", method);
			assert.equal(refused.text.includes(started.prompt?.message ?? "\u0000"), false, method + ": a refusal carried the question it could not answer");
			assert.equal(refused.text.includes(started.event?.url ?? "\u0000"), false, method + ": a refusal carried the address it could not open");
		}
		assert.equal(script.answers().length, 0, "another caller's attempt reached the provider");

		// The flow the first caller started is still its own, untouched and answerable.
		assert.equal(flowOf(await d.call("device", follow)).phase, "waiting_for_input");

		// A caller with nothing open reads the same nothing: no flow is invented for a caller that has none.
		const noneForOther = await d.as(other.token, "/api/auth/login/" + SIGN_IN);
		assert.equal(noneForOther.status, 404, noneForOther.text);
		assert.equal(noneForOther.body.code, "flow_unknown");

		// A second caller signing in to the same provider is a second flow: one account, two people following their own.
		const own = flowOf(await d.as(other.token, "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		assert.notEqual(own.flowId, started.flowId, "two callers were joined onto one sign-in");

		// A Web session is its own caller too: the cookie's material never travels to the host, so the flow it starts is
		// keyed by this entrance's own token for it and cannot be read by a device on the same account.
		const webFlow = await d.call("web", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(own.flowId));
		assert.equal(webFlow.status, 404, "a device's flow was readable by the web session: " + webFlow.text);
	} finally { await d.close(); }
});

test("a revoked device credential loses its own sign-in, and says nothing about another caller's", async () => {
	// A sign-in is the one host surface whose work is deliberately detached from the request that started it, because the
	// person is finishing it in another browser and the tab that opened it is expected to go away. That is exactly why a
	// revocation has to reach it: that caller can no longer cancel its own flow — its next request is refused at this
	// entrance — and a flow nobody can act on can still finish and store a credential for an account just revoked.
	// The entrance notices a revoked bearer only while a request of that caller is attached, so this is what a real client
	// does: it answers its prompt, the credential is revoked mid-exchange, and the submit is still open when that happens.
	const script = scripted({ exchangeMs: 4_000 });
	const d = await deployment({ script, revocationCheckIntervalMs: 25 });
	const doomed = await d.issueDevice("to-be-revoked");
	const kept = await d.issueDevice("to-be-kept");
	try {
		const mine = flowOf(await d.as(doomed.token, "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		const other = flowOf(await d.as(kept.token, "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));
		const submitting = d.as(doomed.token, "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(mine.flowId), { method: "POST", body: { answer: "code-1" } });
		// The revocation lands while the provider is inside its exchange, with the submit still attached.
		assert.equal(await d.revoke(doomed.id), 200, "the revocation was refused");
		const attached = await submitting;
		assert.ok(attached.status === 200 || attached.status === 503, "the attached submit answered strangely: " + attached.status + " " + attached.text);
		assert.deepEqual(script.answers(), ["code-1"], "the answer the revoked caller gave never reached the provider");

		// The detached flow went with the credential: the provider's own wait was ended rather than run out, so the
		// exchange that would have produced a credential never happened and the account's file stayed as it was.
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(script.phaseReached().includes("exchanged"), false, "a revoked caller's exchange completed after its revocation");
		assert.equal(existsSync(d.host.authPath), false, "a revoked caller's flow stored a credential");

		// The revoked caller cannot reach what it started, and is refused by this entrance rather than by the host.
		const after = await d.as(doomed.token, "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(mine.flowId));
		assert.equal(after.status, 401, "a revoked caller kept reading its flow: " + after.text);
		assert.deepEqual(d.backendRequests().filter((entry) => /auth\/|login/.test(entry.url)), [], "a sign-in route reached the Backend");

		// One caller's revocation says nothing about another's: the other sign-in survives, is still its own flow, and is
		// still waiting for the answer only its caller can give. Dropping it would log someone else out of their browser.
		const still = flowOf(await d.as(kept.token, "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(other.flowId)));
		assert.equal(still.flowId, other.flowId, "another caller's flow was dropped by this revocation");
		assert.equal(still.phase, "waiting_for_input", "the surviving flow was not the one this caller started: " + JSON.stringify(still));
		assert.equal(flowOf(await d.as(kept.token, "/api/auth/login/" + SIGN_IN)).flowId, other.flowId, "the surviving caller could no longer read its own flow by provider");
	} finally { await d.close(); }
});

test("a sign-in route that is refused answers the shape a panel reads, and never a partial flow", async () => {
	// The boundary cases this entrance owns: what a bodyless answer, a nonexistent flow, a wrong method and a host that
	// serves no sign-in capability each look like. A panel decides its next action from these, so each stays one shape.
	const d = await deployment({ graceMs: 25 });
	try {
		const started = flowOf(await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} }));

		// An answer with no value in it is refused rather than handed to the provider as an empty string. The code names
		// the step it was refused at — the flow is open and waiting, and this is not an answer for it — which is a
		// different fact from a request whose shape made no sense, and the panel says "give it another answer" because of it.
		const blank = await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId), { method: "POST", body: { answer: "   " } });
		assert.equal(blank.status, 400, blank.text);
		assert.equal(blank.body.code, "answer_invalid");
		assert.equal("flow" in blank.body, false, "a refusal answered a flow nobody acted on");

		// A cancel that names no flow is the same wrong route, not a host call to guess about.
		const vague = await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "DELETE" });
		assert.equal(vague.status, 400, vague.text);

		// A flow this host does not hold is 404 in both directions, and worded the same either way.
		const ghost = await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent("00000000-0000-4000-8000-000000000000"));
		assert.equal(ghost.status, 404, ghost.text);
		assert.equal(ghost.body.code, "flow_unknown");

		// The answer a flow is not holding is refused by the host and relayed as its own code, not flattened.
		const waiting = await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId), { method: "POST", body: { answer: "first-code" } });
		assert.equal(waiting.status, 200, waiting.text);
		const twice = await d.call("device", "/api/auth/login/" + SIGN_IN + "?flow=" + encodeURIComponent(started.flowId), { method: "POST", body: { answer: "second-code" } });
		assert.equal(twice.status, 409, twice.text);
		assert.equal(twice.body.code, "flow_not_waiting");
		assert.equal("flow" in twice.body, false, "a refusal carried a flow the caller had to be told it lost");

		// A method a sign-in route does not have, and an id that decodes to nothing.
		assert.equal((await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "PUT" })).status, 405);
		assert.equal((await d.call("device", "/api/auth/login/%20", { method: "POST", body: {} })).status, 400);
	} finally { await d.close(); }
});

test("a host that serves no provider sign-in names that limit, while the key path beside it keeps working", async () => {
	// A gateway composed without the sign-in service — an SSH host, or a deployment that only stores keys — answers
	// `unsupported_operation`. This entrance has to pass that on as the same 501 with `code: "unsupported"` every other
	// unserved capability answers, so the panel withholds sign-in instead of opening a flow the host will not run.
	const noLogins = await host({ serveLogins: false });
	const d = await deployment({ host: noLogins });
	try {
		const started = await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} });
		assert.equal(started.status, 501, started.text);
		assert.equal(started.body.code, "unsupported");
		assert.match(started.body.error, /no provider sign-in capability/);
		assert.equal("flow" in started.body, false, "a limit answered a flow");

		// A sign-out is the listing surface's removal, which this host does serve: the limit is the flow's, not the
		// account file's, and a panel that read it as one limit would hide a control the deployment really has.
		await d.call("web", "/api/auth/api-key/" + PROVIDER, { method: "POST", body: { apiKey: KEY } });
		const signedOut = await d.call("web", "/api/auth/logout/" + PROVIDER, { method: "POST", body: {} });
		assert.equal(signedOut.status, 200, signedOut.text);
		assert.equal(signedOut.body.success, true);

		// The other routes keep answering, as they do for every named limit.
		assert.equal((await d.call("web", "/api/auth/providers")).status, 200);
		assert.equal((await d.call("web", "/api/descriptor")).status, 200);
	} finally { await d.close(); await noLogins.close(); }
});

test("an origin with no provider host names the limit for a sign-in too, and admits no anonymous caller to it", async () => {
	// The same deployment-level fact the listing answers: no host service configured. A sign-in cannot be started against
	// it, cannot be read, and is never answered as a flow that would run nowhere.
	const d = await deployment({ serveHost: false });
	try {
		// Every shape of request that makes sense on its own — read, start, answer — meets the same answer, because none
		// of them can be served. A request that does not carry an answer is refused on its shape first, which is the other
		// test; here each body is well-formed so the only thing left to say is where the work would have gone.
		for (const [method, body, query] of [["GET", undefined, ""], ["POST", {}, ""], ["POST", { answer: "x" }, "?flow=some-flow"]] as const) {
			const answer = await d.call("device", "/api/auth/login/" + SIGN_IN + query, { method, ...(body === undefined ? {} : { body }) });
			assert.equal(answer.status, 503, method + " " + JSON.stringify(body) + ": " + answer.text);
			assert.equal(answer.body.code, "provider_auth_unavailable", method);
			assert.match(answer.body.error, /HEPI_INGRESS_MCP_GATEWAY_URL/);
			assert.equal("flow" in answer.body, false, method + ": a limit answered a flow");
		}
		// The limit is what a caller that was admitted is told; an anonymous one is refused before it learns anything.
		const anonymous = await fetch(d.origin + "/api/auth/login/" + SIGN_IN);
		assert.equal(anonymous.status, 401);
		assert.equal((await d.call("web", "/api/descriptor")).status, 200, "the named limit reached past this route");
	} finally { await d.close(); }
});

test("a provider host that cannot be reached cannot be signed in to either, and says so as a fault", async () => {
	// The transport fact has to stay distinguishable from the deployment's limit: a person with a down host should retry,
	// a person on an entry that serves no flows should not. A silent host answers neither with an empty flow.
	const silent: Server = silentHost();
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	const address = silent.address();
	assert.ok(address !== null && typeof address === "object");
	const d = await deployment({ host: { origin: "http://127.0.0.1:" + address.port, agentDir: "", authPath: "", close: async () => undefined } });
	try {
		const started = await d.call("device", "/api/auth/login/" + SIGN_IN, { method: "POST", body: {} });
		assert.equal(started.status, 503, started.text);
		assert.equal(started.body.code, "provider_auth_unreachable");
		assert.equal("flow" in started.body, false, "an unreachable host answered a flow");
	} finally {
		await d.close();
		silent.closeAllConnections();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	}
});

/**
 * A host that answers nothing: the transport failure has to read as a fault the panel can retry, not as a limit and not
 * as an empty listing. One plain listener stands in for a gateway process that is down.
 */
test("a provider host that cannot be reached is a retryable fault, not an empty listing", async () => {
	const silent: Server = silentHost();
	await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
	const address = silent.address();
	assert.ok(address !== null && typeof address === "object");
	const d = await deployment({ host: { origin: "http://127.0.0.1:" + address.port, agentDir: "", authPath: "", close: async () => undefined } });
	try {
		const listed = await d.call("web", "/api/auth/providers");
		assert.equal(listed.status, 503);
		assert.equal(listed.body.code, "provider_auth_unreachable");
		assert.equal(Array.isArray(listed.body.apiKeyProviders), false, "an unreachable host was answered as an empty listing");
		assert.equal((await d.call("web", "/api/descriptor")).status, 200);
	} finally {
		await d.close();
		silent.closeAllConnections();
		await new Promise<void>((resolve) => silent.close(() => resolve()));
	}
});
