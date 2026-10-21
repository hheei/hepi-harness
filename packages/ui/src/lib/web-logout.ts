"use client";

import { WEB_LOGOUT_PATH } from "@hepi/protocol";
import type { CapabilityRequest } from "./capability-availability";

/**
 * Ending this client's session, as the surface that offers it must state it.
 *
 * Two facts are decided here rather than in a panel, because a panel that decided them per render is a panel that can
 * offer one host the other host's action:
 *
 * **Which credential a logout can end.** A Web page's session is the ingress's HttpOnly cookie, and `DELETE
 * /api/web-logout` is the one route that clears it. A device bearer is a credential an App install holds; no cookie
 * route ends it, and the ingress deliberately refuses to let a device revoke credentials at all — the App's own shell
 * holds and forgets that material. Offering the cookie logout on a bearer host would be a control whose only possible
 * outcomes are "did nothing" and "did something else", so it is not offered.
 *
 * **Whether the deployment gates its page at all.** `GET /api/web-auth` answers `{ enabled }` for an unauthenticated
 * caller. A deployment that configured no login material has no session to end, so the control stays away instead of
 * clearing a cookie that was never set.
 *
 * **What an answer means.** The route answers `200` and a `Max-Age=0` cookie, and only that is a logout: a refusal, a
 * route this build does not serve, and a transport that never got an answer are all "still signed in", which is what the
 * surface must say rather than reloading into a session that was never ended.
 */
export type LogoutCredential = "cookie" | "bearer";

/**
 * Whether this host's logout is the Web cookie session's.
 *
 * It is the credential alone and not the host's `kind`: the credential is the fact that decides which material a
 * logout would have to clear, and a host that stated a bearer is a host whose session no cookie route ends.
 */
export function cookieLogoutOffered(credential: LogoutCredential): boolean {
  return credential === "cookie";
}

/** One logout attempt's outcome, as the surface may report it. */
export type LogoutOutcome =
  /** The deployment cleared the session cookie; the page's own next read needs admission again. */
  | { readonly kind: "ended" }
  /** The attempt did not end the session, with the reason to show. Nothing is claimed about the cookie. */
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Ask the deployment to end this Web session.
 *
 * The request is the **connection's own**, exactly like every other panel request: an App's document is a bundle whose
 * origin is not the Gateway, so a relative `fetch` here would ask the shell for a route it does not serve. On the host
 * that offers this the connection is the page's own origin under the browser's cookie, which is the material the route
 * clears.
 *
 * A `200` is the deployment stating it cleared the cookie. Anything else — a `403` origin refusal, a `404` from a
 * deployment that does not serve the route, a `5xx` — is reported as the failure it is: the cookie is still the
 * browser's, and a surface that reloaded anyway would show a session that is still admitted as if it had ended. The
 * reason names the status so a person can tell a refusal from a lost request, and never repeats a body that may carry
 * the deployment's own detail.
 */
export async function endWebSession(request: CapabilityRequest): Promise<LogoutOutcome> {
  try {
    const response = await request(WEB_LOGOUT_PATH, { method: "DELETE", headers: { accept: "application/json" } });
    // The answer's body is not this attempt's business — the cookie header is — and a body left unread holds the
    // connection open for the rest of its idle lifetime.
    await response.body?.cancel();
    if (response.ok) return { kind: "ended" };
    return { kind: "failed", reason: "HTTP " + response.status };
  } catch (cause) {
    // A transport that never answered is not a deployment that refused: both leave the session as it was, and both are
    // shown as a failure the person can retry.
    return { kind: "failed", reason: cause instanceof Error && cause.message !== "" ? cause.message : "the request did not reach the deployment" };
  }
}
