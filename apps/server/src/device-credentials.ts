import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * Device credentials: the records the Backend keeps so one App install can be authenticated and, separately, revoked.
 *
 * A credential is a random token the caller holds and a row this store keeps. Only the token's SHA-256 digest is stored,
 * so the file that holds the record cannot be replayed as the credential itself — a stolen database yields no usable
 * token, and nothing here ever writes the raw value after the one response that issued it. The store is a SQLite file
 * of its own beside the conversation database, the same ownership split the project and skill-repository stores use:
 * a credential is not durable conversation state, so it never shares the conversation database.
 */

/** One device credential as a caller may see it. The token is not part of it: only the issuing response carries that. */
export type DeviceCredential = {
	readonly id: string;
	/** What the operator called this device when it was issued, so a revocation list is readable. */
	readonly label: string;
	readonly createdAt: string;
	readonly revoked: boolean;
	/** When access ended, absent while the credential is live. */
	readonly revokedAt?: string;
};

/** The answer to presenting a token: the live credential, or the reason it is not one. */
export type DeviceCredentialCheck = { readonly ok: true; readonly credential: DeviceCredential } | { readonly ok: false; readonly reason: "unknown" | "revoked" };

export type DeviceCredentials = {
	/** Record one credential and answer its token exactly once. The token is not recoverable from this store later. */
	issue(options: { readonly label: string }): { readonly credential: DeviceCredential; readonly token: string };
	/** Resolve a presented token. An unknown and a revoked token are different answers, both refusals. */
	check(token: string): DeviceCredentialCheck;
	/** End one credential's access. A credential that is already revoked stays revoked; an unknown id is not a credential. */
	revoke(id: string): boolean;
	/** Every credential, oldest first, with its revocation state. */
	list(): readonly DeviceCredential[];
	close(): void;
};

export type DeviceCredentialsOptions = { readonly path: string };

const CREDENTIALS_TABLE = "CREATE TABLE IF NOT EXISTS device_credentials (id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT)";
type CredentialRow = { id: string; label: string; created_at: string; revoked_at: string | null };

/** The digest a stored credential is looked up by. It is the only form of the token this module keeps. */
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

function credentialOf(row: CredentialRow): DeviceCredential {
	return { id: row.id, label: row.label, createdAt: row.created_at, revoked: row.revoked_at !== null, ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }) };
}

export function createDeviceCredentials(options: DeviceCredentialsOptions): DeviceCredentials {
	const db = new DatabaseSync(options.path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(CREDENTIALS_TABLE);
	const read = (id: string): DeviceCredential | undefined => {
		const row = db.prepare("SELECT id, label, created_at, revoked_at FROM device_credentials WHERE id = ?").get(id) as CredentialRow | undefined;
		return row === undefined ? undefined : credentialOf(row);
	};
	return {
		issue: ({ label }) => {
			// 32 random bytes: the token is not derived from anything a caller knows, so it cannot be predicted or recomputed.
			const token = randomBytes(32).toString("hex");
			const id = randomUUID();
			const createdAt = new Date().toISOString();
			db.prepare("INSERT INTO device_credentials (id, token_digest, label, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)").run(id, digestOf(token), label, createdAt);
			return { credential: { id, label, createdAt, revoked: false }, token };
		},
		check: (token) => {
			const row = db.prepare("SELECT id, label, created_at, revoked_at FROM device_credentials WHERE token_digest = ?").get(digestOf(token)) as CredentialRow | undefined;
			if (row === undefined) return { ok: false, reason: "unknown" };
			const credential = credentialOf(row);
			return credential.revoked ? { ok: false, reason: "revoked" } : { ok: true, credential };
		},
		revoke: (id) => {
			// The revocation is written once and never cleared: a credential that came back to life would be a second
			// authority on the same token. Repeating the call is the same answer, not an error.
			const changed = db.prepare("UPDATE device_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes;
			if (changed > 0) return true;
			return read(id) !== undefined;
		},
		list: () => (db.prepare("SELECT id, label, created_at, revoked_at FROM device_credentials ORDER BY created_at, id").all() as unknown as CredentialRow[]).map(credentialOf),
		close: () => db.close(),
	};
}
