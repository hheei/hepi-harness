/**
 * Which connection a host is showing, as one value a lifetime can depend on.
 *
 * Both hosts state their configuration as an object literal in their render, and the functions in it — the platform
 * fetch and the host's own `createSource` — are written inline, so their identity changes on every render while nothing
 * about the connection did. A lifetime keyed on that object therefore tears the connection down and builds it again on
 * every keystroke: the client a surface captured is replaced under it, and its next request answers "the connection this
 * request belonged to is closed".
 *
 * What actually identifies a connection is stated here and nowhere else: which host, which ingress origin, which
 * profile, and which credential. A changed one of those is a different connection — a different Gateway, a different
 * account, a reissued device bearer — and a new object holding the same four is the same connection, whose streams,
 * drafts and cached views must survive the re-render.
 *
 * The profile is part of it because it names the connection in the page's own scope key; the credential is part of it
 * because a reissued bearer is a different identity even against the same Gateway; the host kind is part of it because a
 * Web page and an App state different origins and different transports for the same Backend. The functions are not part
 * of it: they are read from the newest render when they are used.
 */

/** The parts of a host configuration a connection is identified by. */
export interface ConnectionIdentitySource {
	readonly host: { readonly kind: string; readonly ingressOrigin: string };
	readonly profile: string;
	readonly credential: { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly token: string };
}

/**
 * One string naming the connection, for a lifetime to depend on.
 *
 * Parts are percent-encoded and joined with a separator no part may contain, so two different connections cannot produce
 * one key and one connection cannot produce two — the same rule the scope key follows, for the same reason.
 */
export function connectionKeyOf(config: ConnectionIdentitySource): string {
	const credential = config.credential.kind === "bearer" ? "bearer:" + config.credential.token : "cookie";
	return [config.host.kind, config.host.ingressOrigin, config.profile, credential].map(encodeURIComponent).join("|");
}