import type {
	ProviderAuthEvent,
	ProviderAuthPrompt,
	ProviderCredentialType,
	ProviderLoginFailureCode,
	ProviderLoginInfo,
	ProviderLoginPhase,
} from "@hepi/protocol/gateway";
import { providerAuthNotice, type ProviderAuthNotice } from "./provider-auth.ts";

/**
 * One provider sign-in, as a panel follows it.
 *
 * A flow is not a request. It outlives the call that started it, because the person is working in another browser and the
 * tab that opened the sign-in reloads, is closed, or comes back later — so nothing here streams. A panel reads the flow,
 * acts on the step it reports, and reads it again, the way the MCP surface does. The answer is the host's own state, which
 * is the same state any other window of the same caller would read. A stream would turn a reconnect into a cancelled login,
 * and a browser flow that runs detached has no socket that could mean anything else.
 *
 * The OAuth work itself is the SDK's: this module reads and answers the steps a flow on the execution host reports. It
 * keeps no credential — what a person types exists here in one request body and is dropped, and what a flow produced is
 * written by that host and never travels back through the panel.
 *
 * The other half is the client ingress (packages/gateway/src/ingress/providers.ts), which relays these routes to that
 * host's authenticated POST /v1/providers/login. The durable Backend serves no route for either.
 */

/** How often a panel reads a flow that is not waiting for it. The deadline a flow holds is the host's own; this is only the reading. */
export const PROVIDER_LOGIN_POLL_INTERVAL_MS = 1_500;

/**
 * The sign-in route: with no flow, the step that starts one; with one, the step of the flow named.
 *
 * The panel asks its capability gate about the same path it posts to, which is why a flow id is a query parameter here and
 * not a route family of its own: every poll of one provider would otherwise read as a different capability to probe.
 */
export function providerSignInRoute(providerId: string, flowId?: string): string {
	const route = "/api/auth/login/" + encodeURIComponent(providerId);
	return flowId === undefined || flowId === "" ? route : route + "?flow=" + encodeURIComponent(flowId);
}

/** The route that drops a provider's stored credential. A sign-out names the account, never a flow. */
export function providerSignOutRoute(providerId: string): string {
	return "/api/auth/logout/" + encodeURIComponent(providerId);
}

/** The answer's body: the one place on this side a typed code or a pasted address exists, and only until the request has been sent. */
export function providerAnswerBody(answer: string): string {
	return JSON.stringify({ answer });
}

/**
 * The flow a host reported, or nothing when the answer is not one.
 *
 * Narrowing is shallow on purpose: the identity of a flow and the step it is on are checked, and the prompt and event are
 * passed through as the host wrote them. This side invents no interpretation of a provider's question. What it does refuse
 * is rendering a body that is no flow at all — the answer a lost or proxied request returns — which a panel would otherwise
 * show as a step with nothing to do about it.
 */
export function readProviderFlow(body: unknown): ProviderLoginInfo | undefined {
	const value = (body as { flow?: unknown } | null)?.flow ?? body;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const flow = value as Record<string, unknown>;
	// Both ids have to be there and non-empty: a flow this panel cannot name is one it cannot follow, answer, or
	// cancel, so it is the same as no flow at all rather than a step with no way out of it.
	if (typeof flow.flowId !== "string" || flow.flowId === "") return undefined;
	if (typeof flow.providerId !== "string" || flow.providerId === "") return undefined;
	if (typeof flow.phase !== "string" || !LOGIN_PHASES.includes(flow.phase)) return undefined;
	const prompt = narrowPrompt(flow.prompt);
	const event = narrowEvent(flow.event);
	const waitingFor = Array.isArray(flow.waitingFor)
		? flow.waitingFor.filter((kind) => kind === "browser" || kind === "input") as ("browser" | "input")[]
		: [];
	return {
		flowId: flow.flowId,
		providerId: flow.providerId,
		phase: flow.phase as ProviderLoginPhase,
		waitingFor,
		expiresInMs: typeof flow.expiresInMs === "number" ? flow.expiresInMs : 0,
		...(prompt === undefined ? {} : { prompt }),
		...(event === undefined ? {} : { event }),
		...(typeof flow.code === "string" ? { code: flow.code as ProviderLoginFailureCode } : {}),
		...(typeof flow.message === "string" ? { message: flow.message } : {}),
		...(flow.storedType === "api_key" || flow.storedType === "oauth" ? { storedType: flow.storedType } : {}),
	};
}

/** Whether a flow reached a phase that holds nothing open, so a panel stops asking and says what happened. */
export function providerFlowEnded(phase: ProviderLoginPhase): boolean {
	return phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "expired";
}

/**
 * What a flow's end is worth to a person: the credential it stored, or the reason it ended the other way.
 *
 * A host ends a flow four ways and a panel has to say which — a person cancelled it, its deadline passed, the exchange
 * failed, or it stored something — and only the last is a success. None of the others is a thing to retry: the flow is
 * over, and the next action is a new sign-in or none at all. The host's own code names the difference, so it is read
 * through this surface's one table of codes rather than a second list that can fall out of step with the first.
 */
export function providerFlowOutcome(flow: ProviderLoginInfo): ProviderFlowOutcome {
	if (flow.phase === "succeeded") return { kind: "stored", ...(flow.storedType === undefined ? {} : { storedType: flow.storedType }) };
	const notice = providerAuthNotice(flow.code, flow.message);
	return {
		kind: "ended",
		phase: flow.phase as ProviderEndedPhase,
		...(notice.key === undefined ? {} : { key: notice.key }),
		detail: notice.detail,
	};
}

/** The end of a flow, as the panel says it. `key` is undefined for a code this surface has no words for; the detail travels. */
export type ProviderFlowOutcome =
	| { readonly kind: "stored"; readonly storedType?: ProviderCredentialType }
	| { readonly kind: "ended"; readonly phase: ProviderEndedPhase; readonly key?: string; readonly detail: string };

type ProviderEndedPhase = "failed" | "cancelled" | "expired";

const LOGIN_PHASES: readonly string[] = ["running", "waiting_for_input", "waiting_for_browser", "succeeded", "failed", "cancelled", "expired"];
/**
 * The refusal of a sign-in call, as a notice.
 *
 * A flow's refusals are about the step a person is standing on, so they read against that step rather than against the
 * listing: an id that ended means the sign-in is gone and the panel drops back to idle, an answer that does not fit the
 * open question means the field was wrong, and too many open flows is a limit that clears by itself. The deployment's own
 * limit (501 with code "unsupported") still reads the way the capability gate reads it, which is what keeps sign-in
 * withheld on a host that serves no provider surface. The codes are the gateway's own, shared with the listing surface.
 */
export function providerLoginRefusal(response: { status: number }, body: unknown): ProviderAuthNotice | undefined {
	if (response.status === 200) return undefined;
	const answer = body as { code?: unknown; error?: unknown } | null;
	if (answer === null || typeof answer !== "object") return providerAuthNotice(undefined, typeof body === "string" ? body : "");
	const code = typeof answer.code === "string" ? answer.code : undefined;
	const message = typeof answer.error === "string" ? answer.error : undefined;
	if (response.status === 501 && code === "unsupported") return { key: "models.providerSignInUnavailable", retry: false, detail: (message ?? "").trim() };
	return providerAuthNotice(code, message);
}

/** A prompt the host wrote, kept only when it is a question a field or a list of options can answer. */
function narrowPrompt(value: unknown): ProviderAuthPrompt | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const prompt = value as Record<string, unknown>;
	if (typeof prompt.message !== "string") return undefined;
	if (prompt.type === "select") {
		if (!Array.isArray(prompt.options)) return undefined;
		const options = prompt.options.flatMap((option) => {
			const entry = option as { id?: unknown; label?: unknown; description?: unknown };
			if (typeof entry?.id !== "string" || typeof entry?.label !== "string") return [];
			return [{ id: entry.id, label: entry.label, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }];
		});
		return options.length === 0 ? undefined : { type: "select", message: prompt.message, options };
	}
	if (prompt.type !== "text" && prompt.type !== "secret" && prompt.type !== "manual_code") return undefined;
	return { type: prompt.type, message: prompt.message, ...(typeof prompt.placeholder === "string" ? { placeholder: prompt.placeholder } : {}) };
}

/** What a flow last said, kept only when it is a step a panel can show. An event this side does not know is no event, not a broken panel. */
function narrowEvent(value: unknown): ProviderAuthEvent | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const event = value as Record<string, unknown>;
	switch (event.type) {
		case "auth_url":
			return typeof event.url === "string"
				? { type: "auth_url", url: event.url, ...(typeof event.instructions === "string" ? { instructions: event.instructions } : {}) }
				: undefined;
		case "device_code":
			if (typeof event.userCode !== "string" || typeof event.verificationUri !== "string") return undefined;
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(typeof event.intervalSeconds === "number" ? { intervalSeconds: event.intervalSeconds } : {}),
				...(typeof event.expiresInSeconds === "number" ? { expiresInSeconds: event.expiresInSeconds } : {}),
			};
		case "progress":
			return typeof event.message === "string" ? { type: "progress", message: event.message } : undefined;
		case "info": {
			if (typeof event.message !== "string") return undefined;
			const links = Array.isArray(event.links)
				? event.links.flatMap((link) => {
					const entry = link as { url?: unknown; label?: unknown };
					return typeof entry?.url === "string"
						? [{ url: entry.url, ...(typeof entry.label === "string" ? { label: entry.label } : {}) }]
						: [];
				})
				: [];
			return { type: "info", message: event.message, ...(links.length === 0 ? {} : { links }) };
		}
		default:
			return undefined;
	}
}
