/**
 * What the workbench shows when the connection it was configured for cannot read its descriptor.
 *
 * One rule, stated once, because the two hosts are refused for different reasons and only one of them has a surface a
 * person can act on. A Web page's credential is the ingress's HttpOnly cookie: a refusal means this browser has no
 * session for this deployment yet, and the page's own login form is what obtains one. An App's credential is a device
 * bearer the shell stored: a refusal is a credential that was revoked or never issued, and no form inside the page can
 * mint another — the shell's configuration surface is the only place that changes it. Collapsing the two into one
 * "unauthorized" paragraph is what leaves a gated deployment showing a bare word with nothing to click.
 *
 * The deployment's own login state is a separate fact, read from `GET /api/web-auth`, which is the one route an
 * unauthenticated caller may ask: a page that offered a login form to a deployment which configured no login material
 * would be a form that can only fail, so that case is reported as the configuration it is.
 *
 * A refusal also states **which kind** it is, because the two kinds have different next steps and a surface that offered
 * the wrong one would send a person to change a credential that was never the problem, or to repeat a read that cannot
 * answer differently. `credential` is the deployment deciding this caller is not admitted; `unreachable` is a
 * deployment that could not answer at all.
 */

/** The two ways this workbench authenticates, as the host stated them. */
export type AdmissionCredential = "cookie" | "bearer";

export type AdmissionInput = {
	/** How this host authenticates: the browser's own cookie, or the device bearer a shell stored. */
	readonly credential: AdmissionCredential;
	/**
	 * The outcome of the connection's first read, as the transport reported it.
	 *
	 * It is stated as an outcome rather than as an optional status, because "there was no status" is a real failure — a
	 * transport that never reached the deployment — and a gate that read a missing status as success would show a
	 * workbench over a connection that does not exist.
	 */
	readonly read: { readonly kind: "ok" } | { readonly kind: "failed"; readonly status?: number };
	/**
	 * Whether this deployment gates its page behind a login, as `GET /api/web-auth` answered.
	 *
	 * Undefined means the answer has not arrived, or could not be read, which is not the same as "no login": a page that
	 * treated an unanswered question as a configuration error would refuse a deployment that is merely slow.
	 */
	readonly loginEnabled?: boolean;
};

/**
 * Which of the two failures a refusal is.
 *
 * `credential` is a deployment that answered and did not admit this caller: only a different credential changes that, so
 * the surface offers the host's connection management where the host has one. `unreachable` is a deployment that never
 * answered — a 5xx, a missing route, a transport that got nothing — and repeating the read is the only step that can
 * change it.
 */
export type RefusalState = "credential" | "unreachable";

export type Admission =
	/** The connection was admitted; the workbench renders its tree. */
	| { readonly kind: "admitted" }
	/** This browser needs the deployment's login material, and the page's own form obtains it. */
	| { readonly kind: "sign-in" }
	/**
	 * Nothing inside this page admits it; the reason says what the person has to change, and `state` says which kind of
	 * failure it is so the surface can offer the one step that can make progress.
	 */
	| { readonly kind: "refused"; readonly reason: string; readonly state: RefusalState };

export function admissionOf(input: AdmissionInput): Admission {
	if (input.read.kind === "ok") return { kind: "admitted" };
	const status = input.read.status;
	// A refusal is the only failure a login answers. A 5xx, an unreachable authority, a missing route or a transport that
	// never got an answer is a deployment that could not answer, and showing a password field for it would invite a
	// person to retype a credential that was never the problem.
	if (status !== 401 && status !== 403) {
		return {
			kind: "refused",
			state: "unreachable",
			reason: status === undefined ? "This deployment could not be reached." : "This deployment refused the connection (" + status + ").",
		};
	}
	if (input.credential === "bearer") {
		return {
			kind: "refused",
			state: "credential",
			reason: "This App's device credential was refused. Configure the connection again with a credential this Gateway admits, or disconnect this App.",
		};
	}
	if (input.loginEnabled === false) {
		return { kind: "refused", state: "credential", reason: "This deployment serves no login, and it refused the request without one." };
	}
	return { kind: "sign-in" };
}
