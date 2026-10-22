import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { DEFAULT_HOST_HEADER, WEB_LOGOUT_PATH, type WorkspaceLocality } from "@hepi/protocol";
import { createFileSurface, isFileSurfacePath } from "../files-surface.ts";
import { MAX_UPLOAD_BATCH_BYTES } from "../multipart.ts";
import { createMcpIngressSurface, handlesMcpRoute } from "./mcp.ts";
import { createProviderAuthIngressSurface, handlesProviderAuthRoute, handlesProviderLoginRoute } from "./providers.ts";
import { createStaticSurface } from "./static.ts";

/**
 * The client ingress: the one surface a Web page or an App reaches, and the only place a client identity is checked.
 *
 * It is deliberately neither the execution gateway's listener nor the Backend's own port. A caller here presents either
 * the Web session cookie or a revocable device bearer, and the ingress decides what that identity may do before it
 * forwards anything: every request is checked against the credential authority the Backend owns, a refusal never reaches
 * the Backend, and no successful check is remembered, so a revoked credential is refused on its next request instead of
 * when some cache expires. The Backend is reached with this ingress's own service credential, which is a different
 * material from every client one and is never sent to a client.
 *
 * Four materials stay apart, because a request that mixes them up is a request that must be refused: the Web login
 * material (this ingress's own cookie session), a device credential (bearer, verified by the Backend), the
 * ingress-to-Backend service credential (outbound only), and an execution token (not accepted here at all — this
 * listener serves no internal route, and `/v1` is answered as absent rather than forwarded).
 */

/** The one cookie a Web session is carried in. */
export const WEB_SESSION_COOKIE = "hepi-web-session";

/**
 * How often an already attached request re-checks the identity it was admitted with.
 *
 * A request is checked when it arrives; a response that stays open — a conversation event stream, a terminal — would
 * otherwise outlive the credential it was admitted with. Re-checking on this interval is what makes the declared maximum
 * revocation delay a property of the ingress rather than of how long a client happens to hold a connection.
 */
export const DEFAULT_REVOCATION_CHECK_INTERVAL_MS = 1000;

/** The credential record an identity was admitted with, as the Backend states it. */
export type AdmittedCredential = { readonly id: string; readonly label: string };

/** The answer to presenting a device token, as the Backend gives it. An unreachable Backend is a refusal, not a pass. */
type CredentialCheck = { readonly ok: true; readonly credential: AdmittedCredential } | { readonly ok: false; readonly reason: string };

export type ClientIngressSettings = {
	/** Where the Backend is, and the service credential this ingress reaches it with. Never sent to a client. */
	readonly backend: { readonly origin: string; readonly serviceToken: string };
	/** The Web login material, when this deployment gates its Web page behind one at all. */
	readonly webLoginToken?: string;
	/** The App origins this ingress answers cross-origin requests for. An origin not named here is refused. */
	readonly appOrigins?: readonly string[];
	/** How often an attached request re-checks its identity; absent reads DEFAULT_REVOCATION_CHECK_INTERVAL_MS. */
	readonly revocationCheckIntervalMs?: number;
	/**
	 * The execution host this ingress serves, as trusted configuration: the gateway id whose computer a caller of this
	 * origin is served from.
	 *
	 * It is stated here and not by the caller, because which computer a client is served from is a property of the
	 * deployment, not of a request: two Web origins can share one Backend, each serving its own host. The Backend
	 * resolves the name against the gateways it was configured with, so an id this deployment does not know is a
	 * configuration error there rather than a route to somewhere else. Absent states no default host at all, which
	 * leaves every host-scoped route answering its own `configuration_required` refusal.
	 */
	readonly defaultHostId?: string;
	/**
	 * The most one browser upload may carry, in bytes; absent reads {@link MAX_UPLOAD_BATCH_BYTES}.
	 *
	 * It is a setting because the bound belongs to the deployment — a smaller host may carry less — and because a bound
	 * a test cannot reach without sending a hundred megabytes is a bound nothing really checks.
	 */
	readonly uploadBatchBytes?: number;
	/**
	 * The host service running on this origin's own computer: the gateway reached at its authenticated `POST /v1/mcp`
	 * for MCP configuration, OAuth state and the processes it starts, and at `POST /v1/providers/auth` for this host's
	 * provider credentials.
	 *
	 * One host, two surfaces, and one setting: the same local gateway process owns this account's `mcp.json` and its
	 * `auth.json`, so a second pair of variables could only drift from this one or claim a different machine held the
	 * credentials. Naming one service is what keeps a provider key and an MCP token pointing at the same account.
	 *
	 * It is stated here for the same reason `defaultHostId` is: which computer's MCP configuration an origin serves is
	 * a property of the deployment, not of a request. The token is this ingress's own material, outbound only, and is
	 * never sent to a client. Absent states that this origin serves no such host service, which answers a named limit —
	 * MCP and provider credentials are absent on this deployment — while every other route keeps working.
	 *
	 * `gatewayId` is the same host's name in the Backend's own vocabulary, and it is required with the other two
	 * because a folder-scoped request is checked against it before it is forwarded: the Backend binds a workspace id
	 * to one gateway, and a request whose binding names a different gateway must not be answered by this host's folder
	 * of the same name. Stating the name is what makes that comparison possible without trusting the caller's.
	 */
	readonly mcp?: { readonly origin: string; readonly token: string; readonly gatewayId: string };
	/**
	 * The directory this listener serves the Web build from: the `dist` a Vite build produced, on the same origin as
	 * `/api`.
	 *
	 * Same origin is the whole point. The Web session is an HttpOnly cookie scoped to this origin, so a page served
	 * anywhere else would have to reach this API cross-origin with a credential the browser will not attach, and a
	 * separate static host would then be a second deployment to keep in step with this one. Absent states that this
	 * ingress serves no page at all, which is a legitimate deployment — an App-only ingress, or one behind a proxy that
	 * already serves the build — and every non-`/api` path then stays the `404` it was before.
	 */
	readonly staticDir?: string;
};

export type ClientIngress = {
	readonly server: Server;
	/** Stop accepting, end every attached response, and resolve once the listener is closed. Repeating it closes nothing twice. */
	close(): Promise<void>;
};

/**
 * The client-API settings routes this surface does not serve, and why.
 *
 * A Settings capability with no route of its own: nothing here answers it, and what is left are the model-side settings
 * no owner serves on a client origin at all (provider model availability is the next ticket).
 *
 * They are named here rather than left to fall through to the Backend, because a forward answers `404 conversation not
 * found` — the Backend has no such route and treats the first two path segments as a conversation — and a client reads
 * `404` as "this deployment serves it, the request was wrong". A settings panel would then offer a control that can
 * only fail. `501` with `code: "unsupported"` is the answer this project already gives for a capability a deployment
 * does not have, and it is the one a panel turns into a named limit instead of an error.
 *
 * Each of these is a route the retired Next BFF answered as unsupported for the same reason: no Backend owns it. The
 * settings this deployment does own — the model catalog, `models.json`, the extension inventory and a conversation's
 * own model, thinking level and extension selection — are not listed here and are forwarded unchanged.
 *
 * Provider credentials are owned by neither the Backend nor this list: `auth/providers`, `auth/api-key/:id`,
 * `auth/login/:id` and `auth/logout/:id` are answered above from this origin's own host service, because the account that
 * holds `auth.json` is the one on this machine and a forward would hand the Backend a credential.
 */
const SETTINGS_ROUTES_NOT_SERVED: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
	{ pattern: /^models\/enabled$/, reason: "the enabled-model scope is not served by this client API" },
	{ pattern: /^models\/refresh$/, reason: "provider catalog refresh is not served by this client API" },
	{ pattern: /^models-config\/discover$/, reason: "provider model discovery is not served by this client API" },
	{ pattern: /^models-config\/test$/, reason: "the provider connection test is not served by this client API" },
	{ pattern: /^models-config\/catalog$/, reason: "the upstream model catalog is not served by this client API" },
];

/** Why this admitted settings route is not served here, or undefined when the Backend owns it. */
function settingsLimit(route: string): string | undefined {
	for (const entry of SETTINGS_ROUTES_NOT_SERVED) if (entry.pattern.test(route)) return entry.reason;
	return undefined;
}

/** The identity a request was admitted as: the two branches never share a rule. */
type Identity = { readonly kind: "web"; readonly caller: string } | { readonly kind: "device"; readonly credential: AdmittedCredential; readonly caller: string };

/**
 * The one token a host surface keys a caller's own work by.
 *
 * A device credential already has a Backend-issued id, so it is used as stated. A Web session has only its login
 * material, and that material is never sent on to another process: it is the ingress's own secret, so the caller is named
 * by a digest of it with a domain separator, which is stable for one session, unguessable from an answer, and carries no
 * material a host could replay. Both forms are opaque to the host, which only ever compares them.
 */
function webCaller(cookie: string): string {
	return "web:" + createHash("sha256").update("hepi-ingress-caller").update("\0").update(cookie).digest("hex").slice(0, 32);
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);
/** The request headers the Backend may see: the caller's body description and its stream resumption, nothing else. */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "last-event-id", "range"] as const;
/**
 * The header that carries the ingress's own default host to the Backend, re-stated here for a caller of this package.
 *
 * It is set from configuration and never read from the caller, so a request cannot name the computer it is served
 * from — that is the one routing fact a client is not allowed to choose. A caller's own header of this name is dropped
 * by the forwarded-header list above and replaced below.
 */
export { DEFAULT_HOST_HEADER };
const CORS_ALLOWED_HEADERS = "authorization, content-type, last-event-id, range";
const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

function json(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
	if (response.writableEnded) return;
	response.writeHead(status, { "content-type": "application/json", ...extra });
	response.end(JSON.stringify(body));
}

/** Constant-time comparison of two materials, so a near miss costs the same as a wrong one. */
function sameMaterial(presented: string, expected: string): boolean {
	const left = Buffer.from(presented), right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** One static request, as the wire stated it. A repeated `if-none-match` is joined, as HTTP states the field. */
function staticRequest(method: string, pathname: string, ifNoneMatch: string | string[] | undefined): { method: string; pathname: string; ifNoneMatch?: string } {
	const revalidating = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(", ") : ifNoneMatch;
	return revalidating === undefined ? { method, pathname } : { method, pathname, ifNoneMatch: revalidating };
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
	const header = request.headers.cookie;
	if (header === undefined) return undefined;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return undefined;
}

/** The origin this request was addressed to, as the browser compared it: the deployment's own scheme and host. */
function ownOrigin(request: IncomingMessage): string {
	const secure = request.headers["x-forwarded-proto"] === "https" || (request.socket as { encrypted?: boolean }).encrypted === true;
	return (secure ? "https" : "http") + "://" + (request.headers.host ?? "localhost");
}

export function createClientIngress(settings: ClientIngressSettings): ClientIngress {
	const backendOrigin = settings.backend.origin.replace(/\/+$/, "");
	const appOrigins = new Set((settings.appOrigins ?? []).map(origin => origin.replace(/\/+$/, "")));
	const revocationCheckIntervalMs = settings.revocationCheckIntervalMs ?? DEFAULT_REVOCATION_CHECK_INTERVAL_MS;
	/**
	 * The browser's file surface, served here rather than forwarded.
	 *
	 * A file request is not one Backend call: an upload is a multipart body whose parts each become their own byte
	 * request, a download is a body this hop must pass on unread, and a preview is a workbench read. Translating that
	 * here — in the one module that owns the browser's file vocabulary — is what keeps the ingress a routing and
	 * identity boundary instead of a second file implementation, and it is what makes an App on `tauri://localhost`
	 * reach the same surface a Web page does. Every call it makes is the Backend's own route under this ingress's
	 * service credential, so the caller's identity still stops at this listener.
	 */
	const fileSurface = createFileSurface({
		...(settings.uploadBatchBytes === undefined ? {} : { totalUploadBytes: settings.uploadBatchBytes }),
		call: (path, init) => fetch(backendOrigin + path, {
			...init,
			headers: { authorization: "Bearer " + settings.backend.serviceToken, ...(init?.headers as Record<string, string> | undefined) },
		}),
	});
	/** Every response still attached, so a close ends them instead of leaving a revoked stream running. */
	const attached = new Set<{ response: ServerResponse; abort: () => void; timer?: NodeJS.Timeout }>();

	/**
	 * The CORS answer for one request, decided before anything else: a declared App origin is answered, an undeclared one
	 * is refused, and the Web origin is this same origin and needs no cross-origin permission at all.
	 */
	function corsOf(request: IncomingMessage): { ok: true; headers: Record<string, string> } | { ok: false } {
		const origin = request.headers.origin;
		if (origin === undefined) return { ok: true, headers: {} };
		const normalized = origin.replace(/\/+$/, "");
		if (normalized === ownOrigin(request).replace(/\/+$/, "")) return { ok: true, headers: { vary: "origin" } };
		if (!appOrigins.has(normalized)) return { ok: false };
		return {
			ok: true,
			headers: {
				"access-control-allow-origin": normalized,
				"access-control-allow-credentials": "true",
				"access-control-expose-headers": "last-event-id, content-type, content-length, content-range, accept-ranges",
				vary: "origin",
			},
		};
	}

	/**
	 * Ask the Backend whether a device token is a live credential.
	 *
	 * The Backend owns the records and the revocation, so this is the only authority there is: a token the Backend does
	 * not confirm is not an identity, and a Backend that cannot answer is a refusal. The service credential authenticates
	 * this question, not the client.
	 */
	async function verifyDevice(token: string): Promise<CredentialCheck> {
		let response: Response;
		try {
			response = await fetch(backendOrigin + "/internal/credentials/verify", {
				method: "POST",
				headers: { authorization: "Bearer " + settings.backend.serviceToken, "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
		} catch {
			return { ok: false, reason: "authority_unreachable" };
		}
		if (!response.ok) { await response.body?.cancel(); return { ok: false, reason: "authority_unreachable" }; }
		const checked = await response.json() as CredentialCheck;
		return checked.ok === true && typeof checked.credential?.id === "string" ? checked : { ok: false, reason: "unknown" };
	}

	/** The identity a request presents, or why it presents none. An unreachable authority refuses, it does not pass. */
	async function identityOf(request: IncomingMessage): Promise<{ ok: true; identity: Identity } | { ok: false; status: number; error: string }> {
		const authorization = request.headers.authorization;
		if (authorization !== undefined) {
			const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
			if (token === "") return { ok: false, status: 401, error: "unauthorized" };
			const checked = await verifyDevice(token);
			if (checked.ok) return { ok: true, identity: { kind: "device", credential: checked.credential, caller: "device:" + checked.credential.id } };
			// An authority that could not be asked is not a client that was refused: the two answers stay different, and
			// neither is a success remembered from an earlier request.
			return checked.reason === "authority_unreachable" ? { ok: false, status: 503, error: "authority unreachable" } : { ok: false, status: 401, error: "unauthorized" };
		}
		const cookie = cookieValue(request, WEB_SESSION_COOKIE);
		if (cookie !== undefined && cookie !== "" && settings.webLoginToken !== undefined && sameMaterial(cookie, settings.webLoginToken)) return { ok: true, identity: { kind: "web", caller: webCaller(cookie) } };
		return { ok: false, status: 401, error: "unauthorized" };
	}

	/** A cookie write is same-origin or it is not this session's write at all. A bearer request states its own authority. */
	function originAllowed(request: IncomingMessage): boolean {
		const origin = request.headers.origin;
		if (origin === undefined) return true;
		return origin.replace(/\/+$/, "") === ownOrigin(request).replace(/\/+$/, "");
	}

	/**
	 * Whether the workspace id a client named is a folder on the host this origin's MCP service runs on.
	 *
	 * The Backend owns the binding — which gateway a workspace id belongs to — so it is the only authority that can
	 * answer, and this ingress asks it with its own service credential instead of resolving anything itself. The question
	 * is one narrow one, `WorkspaceLocality`, so no list, profile, root or account shape is read here: two facts have to
	 * agree inside the Backend, and the first alone is not enough, so a workspace bound to another gateway is refused
	 * even when the configured host serves a folder of its own under that same id, and a gateway that executes through
	 * SSH profiles serves folders on other machines (ADR 0005), so it is not this origin's own host either.
	 *
	 * Only an explicit `local: true` is a yes. A refusal, a body that is not that verdict, a transport failure and a
	 * gateway this deployment does not name all answer `false`: "could not ask" is never "asked, and it is this
	 * machine", and no earlier answer is remembered, so a host that goes away stops being this machine at once. Nothing
	 * here resolves a path and nothing is cached.
	 */
	async function servesFolder(workspaceId: string): Promise<boolean> {
		const gatewayId = settings.mcp?.gatewayId ?? "";
		if (gatewayId === "") return false;
		const path = "/api/workspaces/" + encodeURIComponent(workspaceId) + "/locality?gatewayId=" + encodeURIComponent(gatewayId);
		try {
			const response = await fetch(backendOrigin + path, { headers: { authorization: "Bearer " + settings.backend.serviceToken } });
			if (!response.ok) { await response.body?.cancel(); return false; }
			const verdict = await response.json() as Partial<WorkspaceLocality> | undefined;
			return verdict?.local === true;
		} catch {
			return false;
		}
	}

	const mcp = createMcpIngressSurface(settings.mcp, servesFolder);
	/**
	 * Provider credentials of this origin's own account, read from and written to the same host service MCP uses.
	 *
	 * A separate surface because its routes and answer shapes differ, and the same host service because one local account
	 * owns both `mcp.json` and `auth.json`: a deployment that names a host for one has named the host for the other, and a
	 * second pair of variables that could disagree about which machine holds the credentials would be a configuration
	 * error waiting to write a key into the wrong account's file.
	 */
	const providers = createProviderAuthIngressSurface(settings.mcp);

	/** The Web build, when this deployment states one; absent leaves every non-`/api` path a `404`. */
	const staticSurface = settings.staticDir === undefined ? undefined : createStaticSurface(settings.staticDir);

	const server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			// The failure is named, never its material: an error here may have carried a header the caller sent.
			if (response.headersSent) { response.destroy(); return; }
			json(response, 502, { error: error instanceof Error ? error.message : "client ingress failure" });
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", "http://ingress");
		const method = request.method ?? "GET";
		const cors = corsOf(request);
		if (!cors.ok) { json(response, 403, { error: "origin denied" }); return; }
		// An internal execution route is not served here at all: this listener is the client surface, and the execution
		// listener is a different bind with a different credential.
		if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) { json(response, 404, { error: "not found" }, cors.headers); return; }
		if (method === "OPTIONS") {
			response.writeHead(204, { ...cors.headers, "access-control-allow-methods": CORS_ALLOWED_METHODS, "access-control-allow-headers": CORS_ALLOWED_HEADERS, "access-control-max-age": "600" });
			response.end();
			return;
		}
		// `/api` on its own is the client API's own address rather than a route of it, and it is not a navigation either:
		// it stays the `404` it was before this listener served a page, so a page can never stand in for the API.
		if (url.pathname === "/api") { json(response, 404, { error: "not found" }, cors.headers); return; }
		// Everything that is not the client API is the page, when this deployment serves one. The two never mix: an `/api`
		// path is the API's even when it is unknown, so a missing route stays the API's own `404` instead of being
		// answered with a page that would make the caller believe the route exists. A path outside `/api` is never
		// forwarded anywhere, so serving the build here adds no route to the Backend.
		if (!url.pathname.startsWith("/api/")) {
			if (staticSurface !== undefined && await staticSurface(staticRequest(method, url.pathname, request.headers["if-none-match"]), response, cors.headers)) return;
			json(response, 404, { error: "not found" }, cors.headers);
			return;
		}
		const route = url.pathname.slice("/api/".length);
		// The one read an unauthenticated Web caller needs: whether this deployment gates its page behind a login at all.
		// It answers a boolean and nothing else — no identity, no descriptor, no business data.
		if (route === "web-auth" && method === "GET") { json(response, 200, { enabled: settings.webLoginToken !== undefined }, cors.headers); return; }
		if (route === "web-login" && method === "POST") {
			if (!originAllowed(request)) { json(response, 403, { error: "origin denied" }); return; }
			if (settings.webLoginToken === undefined) { json(response, 404, { error: "login is not configured" }); return; }
			const body = await readJson(request);
			const token = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
			if (typeof token !== "string" || token === "" || !sameMaterial(token, settings.webLoginToken)) { json(response, 401, { error: "unauthorized" }); return; }
			// The cookie is HttpOnly and Strict: script cannot read it, and another origin cannot make the browser present
			// it. Secure follows the scheme the request really arrived over, which behind a TLS proxy is the forwarded
			// protocol rather than this process's own socket.
			const secure = ownOrigin(request).startsWith("https:");
			json(response, 200, { ok: true }, { "set-cookie": WEB_SESSION_COOKIE + "=" + token + "; HttpOnly; SameSite=Strict; Path=/; " + (secure ? "Secure; " : "") + "Max-Age=2592000" });
			return;
		}
		// The route the Web page's own logout control asks, spelled from the one constant both sides read: a page and a
		// listener that disagreed about it would answer a logout with something else.
		if (url.pathname === WEB_LOGOUT_PATH && method === "DELETE") {
			if (!originAllowed(request)) { json(response, 403, { error: "origin denied" }); return; }
			json(response, 200, { ok: true }, { "set-cookie": WEB_SESSION_COOKIE + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
			return;
		}

		const identity = await identityOf(request);
		if (!identity.ok) { json(response, identity.status, { error: identity.error }, cors.headers); return; }

		// Device credentials are issued, listed and revoked by the Web session, never by a device: an App cannot mint
		// itself a second identity or enumerate the others. The records are the Backend's, so the call is forwarded.
		if (route === "device-credentials" || route.startsWith("device-credentials/")) {
			if (identity.identity.kind !== "web") { json(response, 403, { error: "forbidden" }, cors.headers); return; }
			if (!originAllowed(request)) { json(response, 403, { error: "origin denied" }); return; }
		}
		// The browser's file surface: served here, because it is a translation between the browser's own vocabulary and
		// the Backend's routes rather than a request the Backend answers as it stands. The identity was checked above, so
		// nothing here re-authenticates; the answer is written with the same CORS headers as every other route.
		if (isFileSurfacePath(url.pathname)) {
			// The caller's own connection, as cancellation: a download outlives the request that opened it, so the
			// Backend call behind it must end when the caller goes away — otherwise the host reader keeps streaming to
			// nobody for the rest of its idle lifetime.
			const caller = new AbortController();
			const gone = () => caller.abort();
			const closed = () => { if (!response.writableEnded) caller.abort(); };
			request.on("aborted", gone);
			response.on("close", closed);
			let answer: Response | null;
			try {
				answer = await fileSurface({ method, url, headers: request.headers, body: method === "GET" || method === "HEAD" ? null : request, signal: caller.signal });
			} finally {
				// The listeners stay armed while the answer's body is still being written, and are released with it.
				response.once("finish", () => { request.off("aborted", gone); response.off("close", closed); });
			}
			// The surface answered: it claimed the path, so there is nothing left for the forwarded route to do.
			if (answer !== null) {
				await writeAnswer(response, answer, cors.headers);
				// A refusal the surface decided on can arrive while the caller is still sending the body — a batch past the
				// bound is exactly that, and its body is refused before a byte of it is read. The answer is written first,
				// because a response written only after the body is drained is a response the caller may never see; the
				// rest of the body is then read out in the background, so the connection stays usable for the caller that
				// reads the refusal and stops. A caller that keeps sending past the cap is cut off.
				if (method !== "GET" && method !== "HEAD" && answer.status >= 400) void drainRequest(request, settings.uploadBatchBytes ?? MAX_UPLOAD_BATCH_BYTES);
			}
			return;
		}

		// MCP configuration, project trust and provider credentials belong to the host this origin runs on, so they
		// are answered here, from that host's own service, and never forwarded to the Backend. This is the only branch that
		// leaves the Backend out of an `/api` route, and it is the reason no MCP credential or provider key reaches it.
		if (handlesMcpRoute(route) || handlesProviderAuthRoute(route)) {
			// The same-origin guard is the cookie's, not the bearer's: a cookie is presented by the browser on its own,
			// so a write has to be same-origin or it is not this session's write, while a bearer is presented deliberately
			// by the caller and an App reaching this origin from its declared origin states its own authority.
			if (identity.identity.kind === "web" && method !== "GET" && !originAllowed(request)) { json(response, 403, { error: "origin denied" }); return; }
			let body: Record<string, unknown> = {};
			if (method === "POST" || method === "PATCH") {
				const parsed = await readJson(request);
				if (parsed === undefined) { json(response, 400, { error: "Expected a JSON body", reason: "invalid-request" }, cors.headers); return; }
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { json(response, 400, { error: "Expected a JSON object", reason: "invalid-request" }, cors.headers); return; }
				body = parsed as Record<string, unknown>;
			}
			// A test starts a server and a provider write waits on another writer of `auth.json`, so these are requests
			// that can outlive the credential they arrived with: a device bearer is re-verified on the same interval every
			// other route uses, and a revocation ends the call instead of letting it finish.
			const controller = new AbortController();
			const entry: { response: ServerResponse; abort: () => void; timer?: NodeJS.Timeout } = { response, abort: () => controller.abort() };
			attached.add(entry);
			// A caller that stops listening stops the host operation with it: a test that started a server, a sign-in
			// mid-exchange, or a key still being written must not keep running on that host after the socket that asked for
			// it is gone.
			response.on("close", () => { if (!response.writableEnded) controller.abort(); });
			// A sign-in is the one host surface whose work is deliberately detached from this request, so a revoked
			// credential has to be acted on twice: end this call, and end the flows that caller owns. It cannot cancel them
			// itself any more — its next request is refused at this entrance — and a flow nobody can act on can still finish
			// and store a credential for an account whose client was just revoked. This listener holds a bearer only while a
			// request of that caller is attached, so it is the only moment it can say so, and it says it for that caller
			// alone. A caller revoked while no request of its own is in flight is bounded by the host's own deadline instead:
			// watching for that would mean keeping a client credential past its request to shorten the bound on a flow that
			// can only ever store its own account's credential, which is not a trade this entrance makes.
			if (identity.identity.kind === "device") {
				const token = (request.headers.authorization ?? "").slice("Bearer ".length).trim();
				const login = handlesProviderLoginRoute(route);
				const caller = identity.identity.caller;
				entry.timer = setInterval(() => {
					void verifyDevice(token).then(checked => {
						if (checked.ok) return;
						controller.abort();
						if (login) void providers.revokeLoginFlows(caller);
					}, () => controller.abort());
				}, revocationCheckIntervalMs);
				entry.timer.unref();
			}
			try {
				// The same admitted request, answered by whichever host surface owns the route.
				const hostRequest = { method, search: url.searchParams, body, signal: controller.signal, caller: identity.identity.caller };
				const reply = handlesProviderAuthRoute(route) ? await providers.handle(route, hostRequest) : await mcp.handle(route, hostRequest);
				json(response, reply.status, reply.body, cors.headers);
			} finally {
				if (entry.timer !== undefined) clearInterval(entry.timer);
				attached.delete(entry);
			}
			return;
		}
		// A settings capability no owner serves is stated as the limit it is, before anything is forwarded: the caller
		// learns what this deployment can do, not that it asked about a conversation that does not exist.
		const limit = settingsLimit(route);
		if (limit !== undefined) { json(response, 501, { code: "unsupported", error: limit }, cors.headers); return; }
		await proxy(route, url, method, request, response, identity.identity, cors.headers);
	}

	/**
	 * The one route rewrite this ingress makes, and the reason it makes one.
	 *
	 * A deferred history block names its read block under `/api/sessions/:id/entries/:entryId/...` — the copied app's own
	 * path, kept by the protocol so one wire fact serves both halves of a client (`textUrl`, `thinkingUrl`,
	 * `toolResultImageUrl`). The Backend's own vocabulary for the same conversation is `/api/conversations/:id/...`, so a
	 * client on this origin would otherwise be handed an address only the Backend answers. Translating it here, once, at
	 * the entrance, is what makes a frame's own address fetchable by the client that received the frame; nothing about
	 * the block is interpreted, and no second projection is created.
	 */
	function backendRoute(route: string): string {
		const match = /^sessions\/([^/]+)\/entries\/([^/]+)\/(text|thinking|tool-result-image)$/.exec(route);
		if (match === null) return route;
		const [, conversationId, entryId, block] = match as unknown as [string, string, string, string];
		return "conversations/" + conversationId + "/entries/" + entryId + "/" + block;
	}

	/**
	 * Forward one admitted request to the Backend under the ingress's own service credential.
	 *
	 * The caller's identity stops here: its cookie and bearer are not forwarded, and the Backend's answer is the caller's
	 * answer. A response that stays open is re-checked against the authority on the revocation interval, so an attached
	 * stream ends within that bound of its credential being revoked — revoking access ends access, and nothing here
	 * touches the run behind the stream.
	 */
	/**
	 * Write one answer this ingress produced itself, headers and body as the file surface stated them.
	 *
	 * The body is piped rather than collected, so a download's backpressure is the caller's own socket: a browser that
	 * stops reading pauses the Backend's stream instead of filling this process. A response that goes away mid-body ends
	 * the upstream read with it, which is the same cancellation every forwarded route gets.
	 */
	async function writeAnswer(response: ServerResponse, answer: Response, headers: Record<string, string>): Promise<void> {
		const outgoing: Record<string, string> = { ...headers };
		for (const [name, value] of answer.headers) {
			const lower = name.toLowerCase();
			if (HOP_BY_HOP.has(lower) || lower === "set-cookie") continue;
			outgoing[lower] = value;
		}
		response.writeHead(answer.status, outgoing);
		if (answer.body === null) { response.end(); return; }
		const body = Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]);
		body.on("error", () => response.destroy());
		response.on("close", () => body.destroy());
		body.pipe(response);
	}

	async function proxy(route: string, url: URL, method: string, request: IncomingMessage, response: ServerResponse, identity: Identity, headers: Record<string, string>): Promise<void> {
		const target = new URL(backendOrigin + "/api/" + backendRoute(route) + url.search);
		const outgoing = new Headers();
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = request.headers[name];
			if (value !== undefined) outgoing.set(name, Array.isArray(value) ? value.join(", ") : value);
		}
		outgoing.set("authorization", "Bearer " + settings.backend.serviceToken);
		// The identity this ingress already admitted, so the Backend describes the caller instead of guessing one. It is
		// set here and never read from the caller, which is why a request cannot claim to be someone else.
		outgoing.set("x-hepi-client", JSON.stringify(identity.kind === "web" ? { kind: "web" } : { kind: "device", id: identity.credential.id, label: identity.credential.label }));
		// The host this ingress serves, when the deployment states one. It is the ingress's own configuration, so the
		// Backend can answer a host-scoped route without a client ever naming a computer.
		if (settings.defaultHostId !== undefined) outgoing.set(DEFAULT_HOST_HEADER, settings.defaultHostId);
		const controller = new AbortController();
		const entry: { response: ServerResponse; abort: () => void; timer?: NodeJS.Timeout } = { response, abort: () => controller.abort() };
		attached.add(entry);
		const release = (): void => { if (entry.timer !== undefined) clearInterval(entry.timer); attached.delete(entry); };
		response.on("close", release);
		let upstream: Response;
		try {
			upstream = await fetch(target, {
				method,
				headers: outgoing,
				signal: controller.signal,
				...(method === "GET" || method === "HEAD" ? {} : ({ body: Readable.toWeb(request), duplex: "half" } as unknown as RequestInit)),
			});
		} catch {
			release();
			json(response, 503, { error: "backend unreachable" }, headers);
			return;
		}
		if (identity.kind === "device") {
			// The credential is re-read from the authority rather than remembered: a revocation is noticed on the next
			// interval, and an authority that cannot answer ends the request instead of extending it.
			const token = (request.headers.authorization ?? "").slice("Bearer ".length).trim();
			entry.timer = setInterval(() => {
				void verifyDevice(token).then(checked => {
					if (checked.ok) return;
					controller.abort();
					response.destroy();
					release();
				}, () => { controller.abort(); response.destroy(); release(); });
			}, revocationCheckIntervalMs);
			entry.timer.unref();
		}
		// The Backend's answer is passed on as it was written. The body below is the upstream stream piped straight into the
		// caller's socket — no frame is parsed, decoded or re-encoded here — so a frame, a keepalive comment and a chunk
		// boundary all reach the caller exactly as the Backend produced them. The ingress maps routing and identity; the
		// bytes of a stream are not its business.
		const responseHeaders: Record<string, string> = { ...headers };
		for (const [name, value] of upstream.headers) {
			const lower = name.toLowerCase();
			// The Backend's own cookie is its business, not the client's: this ingress is the only place a client cookie is
			// set, so a Set-Cookie from behind it is never forwarded.
			if (HOP_BY_HOP.has(lower) || lower === "set-cookie") continue;
			responseHeaders[lower] = value;
		}
		response.writeHead(upstream.status, responseHeaders);
		// The head is sent before the body starts. A stream that has nothing to write yet — a quiet terminal, or a
		// continuation from the cursor the caller already read — is attached all the same, and its caller learns that
		// from the status rather than from a frame that may only come with the next keepalive.
		response.flushHeaders();
		if (upstream.body === null) { response.end(); return; }
		const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
		body.on("error", () => { response.destroy(); release(); });
		response.on("close", () => { body.destroy(); release(); });
		body.pipe(response);
	}

	return {
		server,
		close: () => new Promise<void>(resolve => {
			for (const entry of attached) { entry.abort(); entry.response.destroy(); if (entry.timer !== undefined) clearInterval(entry.timer); }
			attached.clear();
			server.closeAllConnections();
			server.close(() => resolve());
		}),
	};
}

/**
 * Read a request body out that the surface stopped reading, up to one more bound, so a refusal is answerable.
 *
 * A response written while the caller is still sending is a response the caller may never read: the socket is reset
 * under it. Draining first is what makes "the upload is larger than the bound" an answer rather than a broken pipe, and
 * the cap is what keeps that from being an invitation to send without limit.
 */
async function drainRequest(request: IncomingMessage, limit: number): Promise<void> {
	if (request.readableEnded || request.destroyed) return;
	let drained = 0;
	try {
		for await (const chunk of request) {
			drained += Buffer.byteLength(chunk as Buffer);
			if (drained > limit) { request.destroy(); return; }
		}
	} catch {
		// A body that ended badly is a caller that is already gone; there is nothing left to read out.
	}
}

/** One bounded JSON request body. A body that cannot be read is no body, which every caller here already refuses. */
async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += Buffer.byteLength(chunk as Buffer);
		if (bytes > 64 * 1024) return undefined;
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return undefined;
	try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
