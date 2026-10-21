"use client";

import { useState } from "react";
import type { RefusalState } from "../lib/web-session-gate";

/**
 * What a refused connection offers, on the host that owns its credential.
 *
 * A refusal is not one state. A deployment that **refused the credential** is changed by a different credential, and no
 * amount of repeating the read changes it; a deployment that **could not answer** is changed by nothing but asking again,
 * and sending a person to retype a bearer that was never the problem is how a transient outage turns into a lost
 * credential. Both are stated, and each offers only the steps that can make progress.
 *
 * Who may act is the host's fact, not this surface's. A Web page's credential is the ingress's own cookie, so a refused
 * Web page has no connection to configure or forget — its steps are the deployment's login form and, for an outage, a
 * retry. A packaged App holds a device bearer in the OS credential store, and its shell is the only thing that can replace
 * or delete it, so the App states the two actions it can perform and this surface offers exactly those.
 *
 * Disconnecting is deliberately two steps. It is the one action here that destroys something, and the surface has to be
 * unambiguous about what it destroys: this machine's stored connection, not the device credential the Gateway still holds
 * a record of, and not a durable run that keeps going on the execution host. Replacing a connection is the same
 * distinction from the other side — cancelling the configuration form leaves the stored connection exactly as it was.
 */

/** The actions this surface may offer. */
export type RecoveryActionId = "retry" | "configure" | "disconnect";

export interface RecoveryAction {
	readonly id: RecoveryActionId;
	readonly label: string;
	/** The step that makes progress for this state, and the one that receives focus. */
	readonly primary: boolean;
}

/**
 * The actions one refusal offers, in the order they are shown.
 *
 * Pure and exported on its own so the rule can be asserted without a document: the wrong step in a refusal is what sends
 * someone to change a credential that was fine, or to disconnect an App over an outage that had already ended.
 */
export function recoveryPlan(input: { readonly state: RefusalState; readonly managed: boolean }): RecoveryAction[] {
	const configure: RecoveryAction = { id: "configure", label: "Configure connection…", primary: false };
	const disconnect: RecoveryAction = { id: "disconnect", label: "Disconnect…", primary: false };
	if (input.state === "unreachable") {
		return [
			{ id: "retry", label: "Try again", primary: true },
			...(input.managed ? [configure, disconnect] : []),
		];
	}
	// A refused credential: repeating the same read cannot admit it, so retrying is not offered at all.
	return input.managed ? [{ ...configure, primary: true }, disconnect] : [];
}

/** What the surface states about this refusal, before the actions. */
export function recoveryHeadline(state: RefusalState): string {
	return state === "unreachable" ? "This Gateway could not be reached." : "This Gateway did not admit this connection.";
}

/** The one sentence that says which step changes the state. */
export function recoveryDetail(state: RefusalState, managed: boolean): string {
	if (state === "unreachable") {
		return managed
			? "The address and credential are kept. Try again when the Gateway is back, or configure a different one."
			: "Nothing was changed. Try again when the deployment is back.";
	}
	return managed
		? "The device credential this App was configured with was refused, so no page inside it can admit it. Configure this App with a credential the Gateway admits, or disconnect it."
		: "A page inside this deployment cannot replace the credential it was given.";
}

/** The steps the host can perform on its own connection, or nothing when the credential is not this host's to change. */
export interface ConnectionManagement {
	/** Replace this machine's stored connection. The host restarts into it; cancelling keeps the current one. */
	readonly configure: () => void;
	/** Delete this machine's stored connection. The host restarts unconfigured. */
	readonly disconnect: () => void;
}

/**
 * The confirmation a disconnect asks for, stated as what it does and what it does not.
 *
 * Its own component because it is the one place on this surface that destroys something, and the copy is the whole of what
 * makes it honest: deleting this machine's stored connection is not revoking the device credential the Gateway holds a
 * record of, and it is not stopping a durable run that is already executing on the execution host. A person who read
 * "sign out" here would believe they had ended something they had not.
 */
export function DisconnectConfirm(props: { readonly onConfirm: () => void; readonly onCancel: () => void }) {
	return (
		<section aria-labelledby="hepi-disconnect-heading" style={{ border: "1px solid currentColor", borderRadius: 6, padding: 12 }}>
			<h2 id="hepi-disconnect-heading" style={{ fontSize: 15, marginTop: 0 }}>Disconnect this computer?</h2>
			<p style={{ fontSize: 13 }}>
				This deletes the connection stored on this machine and reopens the App unconfigured. It does not revoke the device
				credential on the Gateway, and it does not stop anything already running on the execution host.
			</p>
			<button type="button" autoFocus onClick={props.onConfirm}>Disconnect this computer</button>{" "}
			<button type="button" onClick={props.onCancel}>Cancel</button>
		</section>
	);
}

export function ConnectionRecovery(props: {
	readonly state: RefusalState;
	readonly reason: string;
	/** The host's own connection management, when this host has one. */
	readonly management?: ConnectionManagement;
	/** Read the connection again; only meaningful for a deployment that could not answer. */
	readonly retry?: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const plan = recoveryPlan({ state: props.state, managed: props.management !== undefined });
	const act = (id: RecoveryActionId) => {
		if (id === "retry") props.retry?.();
		if (id === "configure") props.management?.configure();
		if (id === "disconnect") setConfirming(true);
	};
	return (
		<main style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 560 }}>
			<h1 style={{ fontSize: 20 }}>{recoveryHeadline(props.state)}</h1>
			{/* The gate's own words, unedited: the surface states why, not a paraphrase of why. */}
			<p role="alert">{props.reason}</p>
			<p>{recoveryDetail(props.state, props.management !== undefined)}</p>
			{confirming ? (
				<DisconnectConfirm
					onConfirm={() => props.management?.disconnect()}
					onCancel={() => setConfirming(false)}
				/>
			) : (
				<div role="group" aria-label="Connection recovery" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
					{plan.map((action) => (
						<button key={action.id} type="button" autoFocus={action.primary} onClick={() => act(action.id)}>
							{action.label}
						</button>
					))}
				</div>
			)}
		</main>
	);
}
