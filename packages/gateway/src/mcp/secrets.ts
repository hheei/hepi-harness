import { SECRET_MASK, argSecretParts, commandSecretParts, isReferenceOnly, maskArgs, maskCommand, maskUrl, urlSecretParts } from "@hepi/protocol/mcp-secrets";

// Masking for everything this service reports to a caller (ADR 0006): a test's
// failure reason, a sign-in's error, and the entries a listing describes. The
// rules are upstream's own, preserved verbatim in `@hepi/protocol/mcp-secrets`; this module
// is only the walk that decides which values of one entry are secrets.
//
// A reported reason is text a remote server produced, so it can quote any value
// the host resolved before connecting. Every such value is collected here and
// replaced with the mask, longest first, so a value is never left half replaced
// by a shorter one inside it.

export { SECRET_MASK } from "@hepi/protocol/mcp-secrets";

/** Values shorter than this are not treated as secrets: masking every short word would hide the reason itself. */
const MASK_MIN_LENGTH = 4;

/** `Bearer`, `Basic`: a scheme word beside a token is not itself a secret. */
const AUTHORIZATION_SCHEME = /^(?:bearer|basic|digest|token)$/i;

/** A value the SDK resolves before it connects: `${NAME}`, `$NAME`, `!command`. */
function isResolved(value: string): boolean {
	return value.startsWith("!") || /\$\{?[A-Za-z_$!]/.test(value);
}

/** The literal values of one entry: env and header values that are not references, and `oauth.clientSecret`. */
export function literalSecrets(config: Record<string, unknown>): string[] {
	const values: string[] = [];
	const collect = (source: unknown): void => {
		if (typeof source !== "object" || source === null || Array.isArray(source)) return;
		for (const value of Object.values(source)) {
			if (typeof value === "string" && !isReferenceOnly(value) && !isResolved(value)) values.push(value);
		}
	};
	if (typeof config.url === "string") {
		collect(config.headers);
		values.push(...urlSecretParts(config.url));
		if (typeof config.oauth === "object" && config.oauth !== null && !Array.isArray(config.oauth)) {
			const secret = (config.oauth as Record<string, unknown>).clientSecret;
			if (typeof secret === "string" && !isReferenceOnly(secret)) values.push(secret);
		}
	} else {
		collect(config.env);
		if (typeof config.command === "string") values.push(...commandSecretParts(config.command));
		if (Array.isArray(config.args)) values.push(...argSecretParts(config.args.filter((arg): arg is string => typeof arg === "string")));
	}
	return values;
}

/**
 * A function that replaces every secret it was built with by the mask.
 * `extra` carries values resolved outside the entry: a transport's actual
 * environment and headers, or a secret a sign-in resolved.
 */
export function createRedactor(config: Record<string, unknown>, extra: readonly string[] = []): (text: string) => string {
	const replacements = new Map<string, { raw: string; word: boolean }>();
	const add = (raw: string, word: boolean): void => {
		const trimmed = raw.trim();
		if (trimmed.length < MASK_MIN_LENGTH) return;
		const existing = replacements.get(trimmed);
		if (!existing || (existing.word && !word)) replacements.set(trimmed, { raw: trimmed, word });
	};
	const secret = (value: string): void => {
		add(value, false);
		// `Bearer <token>`: the token alone may be echoed by a server.
		for (const word of value.trim().split(/\s+/)) {
			if (word !== value.trim() && !AUTHORIZATION_SCHEME.test(word)) add(word, true);
		}
	};
	for (const value of [...literalSecrets(config), ...extra]) secret(value);
	// Longest first, so a value is never left half replaced by a shorter one inside it.
	const ordered = [...replacements.values()].sort((left, right) => right.raw.length - left.raw.length);
	return (text: string): string => {
		let masked = text;
		for (const { raw, word } of ordered) {
			masked = word ? masked.replace(new RegExp(`\\b${escapeRegExp(raw)}\\b`, "g"), SECRET_MASK) : masked.split(raw).join(SECRET_MASK);
		}
		return masked;
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One entry's shown command, arguments and URL, with the parts that look like credentials masked. */
export function maskedEntry(config: Record<string, unknown>): { readonly command?: string; readonly args?: string[]; readonly url?: string } {
	if (typeof config.url === "string") return { url: maskUrl(config.url).value };
	const shown: { command?: string; args?: string[] } = {};
	if (typeof config.command === "string") shown.command = maskCommand(config.command).value;
	if (Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string")) shown.args = maskArgs(config.args as string[]).args;
	return shown;
}
