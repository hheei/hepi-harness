import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProviderLoginRequest, ProviderLoginResult } from "@hepi/protocol/gateway";
import type { ProviderAuthRequest, ProviderAuthResult } from "../provider-auth.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * The provider family: this account's stored connections, and the sign-ins that outlive a request.
 *
 * Both routes answer with the credential file's state and never with a value: a listing says which providers are
 * configured, and a sign-in answers a flow's phase, its question and the listing after it succeeded. The two routes also
 * have deliberately different lifetimes, which is the rule this file owns. A provider `auth` operation is request-bound
 * work: it completes, answers and is done. A sign-in is not — the person finishes in another window, so an operation on
 * an open flow is *not* ended by the request that carried it; its deadline, an explicit cancel, or this gateway stopping
 * are. A start whose caller vanished during the create is cancelled by the service itself, because nobody holds its id.
 * That is why nothing here watches the socket: wiring one global abort to every route would erase this distinction.
 *
 * A gateway that serves no provider accounts answers `unsupported_operation` with its own message on each route, so a
 * caller can tell "this host cannot do that" from "that request was wrong".
 */

/** The route this family answers, or undefined when the path and method name another family's request. */
export type ProviderRoute = "auth" | "login";

/** The provider route this request names: the path and the method together. */
export function providerRoute(target: string, method: string): ProviderRoute | undefined {
	if (method !== "POST") return undefined;
	if (target === "/v1/providers/auth") return "auth";
	if (target === "/v1/providers/login") return "login";
	return undefined;
}

/**
 * What this family needs of each provider surface: one operation, answered by the host's own store or flow.
 *
 * Neither states a signal, and that is the whole point of the distinction this file owns: a sign-in is not ended by the
 * request that carried it, so nothing here hands one the socket's lifetime.
 */
export type ProviderAuthCapability = { execute(request: ProviderAuthRequest): Promise<ProviderAuthResult> };
export type ProviderLoginCapability = { execute(request: ProviderLoginRequest): Promise<ProviderLoginResult> };

/** The provider routes of one gateway, over the account surfaces it borrows and may not have. */
export class ProviderTransport {
	readonly #auth: ProviderAuthCapability | undefined;
	readonly #logins: ProviderLoginCapability | undefined;

	constructor(auth: ProviderAuthCapability | undefined, logins: ProviderLoginCapability | undefined) {
		this.#auth = auth;
		this.#logins = logins;
	}

	async handle(route: ProviderRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson(request);
		if (!body || typeof body !== "object" || typeof (body as { operation?: unknown }).operation !== "string") {
			writeJson(response, 400, { ok: false, code: "invalid_request" });
			return;
		}
		if (route === "auth") {
			const result: ProviderAuthResult = this.#auth === undefined
				? { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider-auth capability" }
				: await this.#auth.execute(body as ProviderAuthRequest);
			writeJson(response, 200, result);
			return;
		}
		const result: ProviderLoginResult = this.#logins === undefined
			? { ok: false, code: "unsupported_operation", message: "this gateway host serves no provider sign-in capability" }
			: await this.#logins.execute(body as ProviderLoginRequest);
		writeJson(response, 200, result);
	}
}
