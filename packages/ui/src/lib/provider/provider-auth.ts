import type { ProviderCredentialType } from "@hepi/protocol/gateway";

/**
 * Settings › Models provider connection, as a client reads and changes it.
 *
 * The credential belongs to the execution host's account: it lives in that account's
 * `<home>/.pi/agent/auth.json`, which only the gateway running there may read or write. This module is the panel's half of
 * that boundary — which routes the panel calls, what the host's listing means to a person, and which sentence each refusal
 * earns. It keeps nothing: no key, no masked hint and no listing is written to browser storage by anything here, and a
 * value typed into the key field leaves this side in exactly one request body.
 *
 * The other half is the client ingress (`packages/gateway/src/ingress/providers.ts`), which reaches that host's
 * authenticated `POST /v1/providers/auth` and answers these routes. Neither side hands a credential to the durable
 * Backend, and the Backend serves no route for one: this is a Web-to-Gateway control path, and every answer the panel reads
 * is presence, credential type and a hint the host masked before it left the machine that owns the file.
 *
 * Provider *sign-in* is this file's sibling (`provider-login.ts`): the same account, the same host, and a flow whose
 * lifetime outlives the call that started it. This file is the listing and the key; that one is the steps of a sign-in, and
 * both read one list of refusal codes — a flow's `flow_unknown` and the listing's `credential_mismatch` are the same
 * surface's answers, and a panel cannot be shown two notices for one code.
 */

/** The listing's route. It is also the capability gate this section is offered by. */
export const PROVIDER_AUTH_ROUTE = "/api/auth/providers";

/** The route that writes one provider's API key. The id is the host's provider id, never a display name. */
export function providerApiKeyRoute(providerId: string): string {
	return "/api/auth/api-key/" + encodeURIComponent(providerId);
}

/**
 * The removal route, guarded by the credential type the panel last read.
 *
 * The host refuses a removal whose type no longer matches what it stores (`credential_mismatch`) and leaves the entry
 * alone, so a panel looking at a stale listing cannot delete a credential that was replaced by another method in the
 * meantime.
 */
export function providerApiKeyRemoveRoute(providerId: string, expectedType?: ProviderCredentialType): string {
	const base = providerApiKeyRoute(providerId);
	return expectedType === undefined ? base : base + "?expectedType=" + encodeURIComponent(expectedType);
}

/** The write's body: the one place a raw key exists on this side, and only until the request has been sent. */
export function providerApiKeyBody(apiKey: string): string {
	return JSON.stringify({ apiKey });
}


/**
 * One provider as this surface lists it.
 *
 * `configured` is the host's own answer that a request could be authenticated right now, which covers a credential the host
 * did not store — an environment key, an AWS profile, an ADC file. `storedType` is what the host's file actually holds, and
 * it is the only thing this panel may replace or remove. Keeping them apart is what stops a panel offering "disconnect" for
 * a credential that lives in the host's environment, where no write here could reach it.
 */
export type ProviderPanelRow = {
	readonly id: string;
	readonly name: string;
	readonly displayName: string;
	readonly configured: boolean;
	readonly loggedIn: boolean;
	readonly source?: string;
	readonly storedType?: ProviderCredentialType;
	readonly maskedHint?: string;
	readonly supportsApiKey: boolean;
	readonly supportsOAuth: boolean;
};

/** A row narrowed from the JSON the host answered, or undefined when the body is not a row of this surface. */
export function providerPanelRow(value: unknown): ProviderPanelRow | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "string" || typeof row.configured !== "boolean") return undefined;
	const storedType = row.storedType === "api_key" || row.storedType === "oauth" ? row.storedType : undefined;
	return {
		id: row.id,
		name: typeof row.name === "string" ? row.name : row.id,
		displayName: typeof row.displayName === "string" ? row.displayName : row.id,
		configured: row.configured,
		loggedIn: typeof row.loggedIn === "boolean" ? row.loggedIn : row.configured,
		...(typeof row.source === "string" ? { source: row.source } : {}),
		...(storedType === undefined ? {} : { storedType }),
		...(typeof row.maskedHint === "string" ? { maskedHint: row.maskedHint } : {}),
		// An older host states its methods as a nested object; both shapes mean the same thing and a panel must not offer
		// a key field for a provider that declares no key method just because a field is missing.
		supportsApiKey: row.supportsApiKey === true || (row.methods as { apiKey?: unknown } | undefined)?.apiKey === true,
		supportsOAuth: row.supportsOAuth === true || (row.methods as { oauth?: unknown } | undefined)?.oauth === true,
	};
}

/** The panel's two sections from one listing answer, or undefined when the answer is not this surface's listing. */
export type ProviderAuthSections = {
	readonly oauthProviders: readonly ProviderPanelRow[];
	readonly apiKeyProviders: readonly ProviderPanelRow[];
};

export function readProviderAuthListing(body: unknown): ProviderAuthSections | undefined {
	const answer = body as { oauthProviders?: unknown; apiKeyProviders?: unknown } | null;
	if (answer === null || typeof answer !== "object") return undefined;
	if (!Array.isArray(answer.oauthProviders) || !Array.isArray(answer.apiKeyProviders)) return undefined;
	const rows = (list: readonly unknown[]) => list.map(providerPanelRow).filter((row): row is ProviderPanelRow => row !== undefined);
	return { oauthProviders: rows(answer.oauthProviders), apiKeyProviders: rows(answer.apiKeyProviders) };
}

/**
 * The connection state of one provider, as far as this panel can act on it.
 *
 * `removable` is the honest version of "connected": a person may disconnect what this host holds in its own file, and
 * nothing else. `noteKey` names the two cases that need explaining rather than a control — a provider the host
 * authenticates from its environment (a key field would be writing a second credential the host does not need) and a
 * provider whose stored record is an OAuth one, which this surface can remove but cannot create.
 */
export type ProviderConnection = {
	readonly canEnterKey: boolean;
	readonly removable: boolean;
	readonly storedType?: ProviderCredentialType;
	readonly maskedHint?: string;
	readonly noteKey?: string;
};

export function providerConnection(row: ProviderPanelRow | undefined): ProviderConnection | undefined {
	if (row === undefined) return undefined;
	const storedType = row.storedType;
	return {
		canEnterKey: row.supportsApiKey,
		removable: storedType !== undefined,
		...(storedType === undefined ? {} : { storedType }),
		...(row.maskedHint === undefined ? {} : { maskedHint: row.maskedHint }),
		// An omitted notice rather than an undefined one: a row with nothing to explain is the ordinary case, and a caller
		// should not have to tell "no note" apart from "a note whose key is missing".
		...(storedType === undefined
		? row.configured ? { noteKey: "models.providerAuth.ambient" } : {}
		: storedType === "oauth" ? { noteKey: "models.providerAuth.oauthStored" } : {}),
	};
}

/**
 * What to tell a person about one refusal, and what the panel should do next.
 *
 * The codes are the gateway's own (`ProviderAuthFailureCode`) plus this surface's transport facts, and each one is
 * actionable differently: a host that could not be reached, or one that has no service configured for this origin, is the
 * deployment's own state and says which variable names it; a credential that turned out to be a different kind means
 * somebody changed it elsewhere, so the panel re-reads before offering anything again; an unreadable or inaccessible
 * `auth.json` is that host's file, and a retry there is the person's choice, not a silent second write.
 *
 * A code with no entry here is still a refusal with a message, not a silent failure: `key` is undefined and the caller
 * shows what the host said. `detail` is always the host's own fixed sentence, which carries no credential — that is the
 * gateway's guarantee, and nothing here adds to or repeats the value that was sent.
 */
export type ProviderAuthNotice = { readonly key?: string; readonly retry: boolean; readonly detail: string };

const NOTICES: Record<string, Omit<ProviderAuthNotice, "detail">> = {	// ref

	// A sign-in flow's own refusals, resolved here so the two halves of one surface share one code list.
	flow_unknown: { key: "models.providerAuth.flowGone", retry: false },
	flow_not_waiting: { key: "models.providerAuth.flowMoved", retry: false },
	answer_invalid: { key: "models.providerAuth.answerInvalid", retry: false },
	too_many_flows: { key: "models.providerAuth.tooMany", retry: true },
	provider_auth_unavailable: { key: "models.providerAuth.noHostService", retry: false },
	provider_auth_unreachable: { key: "models.providerAuth.unreachable", retry: true },
	provider_auth_unauthorized: { key: "models.providerAuth.hostRefused", retry: false },
	credential_mismatch: { key: "models.providerAuth.replaced", retry: true },
	unknown_provider: { key: "models.providerAuth.unknown", retry: true },
	invalid_request: { key: "models.providerAuth.invalid", retry: false },
	auth_file_unreadable: { key: "models.providerAuth.fileUnreadable", retry: false },
	lock_unavailable: { key: "models.providerAuth.busy", retry: true },
	permission_denied: { key: "models.providerAuth.denied", retry: false },
	operation_failed: { key: "models.providerAuth.failed", retry: false },
};

export function providerAuthNotice(code: string | undefined, message?: string): ProviderAuthNotice {
	const notice = code === undefined ? undefined : NOTICES[code];
	return { ...(notice?.key === undefined ? {} : { key: notice.key }), retry: notice?.retry ?? false, detail: (message ?? "").trim() };
}

/**
 * One refusal read back off an answer this surface wrote.
 *
 * A `200`, and any answer that is not this surface's refusal shape, is not a refusal: a panel that treated a lost
 * request or an unrelated body as "the deployment serves no provider credentials" would hide a control the deployment
 * has, which is the one mistake this rule exists to prevent.
 */
const ALL_NOTICES_REF = providerAuthRefusal;

export function providerAuthRefusal(response: { status: number }, body: unknown): ProviderAuthNotice | undefined {
	if (response.status === 200) return undefined;
	const answer = body as { code?: unknown; error?: unknown } | null;
	if (answer === null || typeof answer !== "object") return providerAuthNotice(undefined, typeof body === "string" ? body : "");
	const code = typeof answer.code === "string" ? answer.code : undefined;
	const message = typeof answer.error === "string" ? answer.error : undefined;
	// A named limit of the whole deployment (`501` + `unsupported`) is the capability gate's own answer, and reads as the
	// capability's limit rather than as a fault the panel should offer to retry.
	if (response.status === 501 && code === "unsupported") return { key: "models.providerAuthUnavailable", retry: false, detail: (message ?? "").trim() };
	return providerAuthNotice(code, message);
}
