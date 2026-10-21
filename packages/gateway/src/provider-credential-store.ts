import type { AuthOperationOptions, Credential, CredentialStore } from "@earendil-works/pi-ai";
import type { ProviderCredentialFile } from "./provider-auth.ts";

/**
 * The SDK's credential store over this host's own `auth.json`.
 *
 * A login flow produces a credential and hands it to the store; that is upstream's own sequence in `Models.login`, and it
 * arrives through exactly one door — `modify`, the serialized read-modify-write, taken after the flow's network work
 * settled. Pointing that door at this host's file is what lets this repository reuse pi's flows without inventing a second
 * place a credential lands: the flow's result is written here, under this host's file lock, with this host's permissions,
 * and every other provider's entry untouched.
 *
 * The lock is held across the whole read-decide-write. That is the contract upstream states for a store — "mutual
 * exclusion per provider id, cross-process too where the backing store supports it" — and it is the reason a token another
 * process just rotated cannot be overwritten by a stale credential this flow read before that write. A best-effort
 * in-memory view would be the wrong shortcut here: this file has three live writers (this service, another process of it,
 * and the pi CLI signing in) and one account.
 */
export class ProviderFileCredentialStore implements CredentialStore {
	readonly #file: ProviderCredentialFile;

	constructor(file: ProviderCredentialFile) {
		this.#file = file;
	}

	/** The stored credential for one provider, possibly expired. Nothing is ever resolved or refreshed by a read. */
	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return credentialOf(this.#file.read()[providerId]);
	}

	/**
	 * Presence and type per provider, with no value in it and no ambient lookup.
	 *
	 * Upstream requires that listing never executes a configured API-key command; this one reads the file's own type tags,
	 * which is all a caller of the store is allowed to learn.
	 */
	async list(_options?: AuthOperationOptions): Promise<readonly { providerId: string; type: Credential["type"] }[]> {
		const records = this.#file.read();
		const entries: { providerId: string; type: Credential["type"] }[] = [];
		for (const [providerId, value] of Object.entries(records)) {
			const credential = credentialOf(value);
			if (credential !== undefined) entries.push({ providerId, type: credential.type });
		}
		return entries;
	}

	/**
	 * The store's only write path.
	 *
	 * `fn` sees what is stored right now — the case upstream names, a login landing while a refresh rotated the token — and
	 * its return value becomes the entry, or leaves it untouched when it returns nothing. A rejection from `fn` propagates
	 * and writes nothing, so a flow that failed mid-exchange cannot leave half a credential behind.
	 *
	 * The operation's signal is honoured at the two moments that are this store's to decide, and nowhere else: an aborted
	 * flow must not end up with a credential in the file. A caller cancels (or the deadline passes) while this write waits
	 * for the lock, and the lock is then handed to it with the abort already true — that is the window this covers, and it is
	 * a real one, because upstream hands the login's own signal here and its flow work has already finished by then. So the
	 * signal is checked once inside the lock before `fn` is asked anything, and once again after `fn` returns and before the
	 * commit, since `fn` is allowed to await. An abort throws the reason it carries: nothing is written, `fn` is not replayed
	 * on a later attempt, and upstream reports the abort rather than a credential it never stored. The serialized
	 * read-decide-write stays one lock, which is the property a concurrent pi CLI login depends on.
	 */
	async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const signal = options?.signal;
		return await this.#file.updateAsync(async (records) => {
			throwIfAborted(signal);
			const credential = await fn(credentialOf(records[providerId]));
			throwIfAborted(signal);
			if (credential === undefined) return { value: undefined };
			return { records: { ...records, [providerId]: credential }, value: credential };
		});
	}

	/**
	 * Remove a provider's entry (a sign-out).
	 *
	 * Removing what is not there succeeds, because the state the caller asked for is the state the file is in, and the same
	 * lock that covers a write covers this — a removal cannot race past a login's write and delete a credential that landed
	 * after the caller read the listing.
	 */
	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		await this.#file.updateAsync(async (records) => {
			if (!(providerId in records)) return { value: undefined };
			const next = { ...records };
			delete next[providerId];
			return { records: next, value: undefined };
		});
	}
}

/** The abort a caller asked for, thrown as the reason it carries rather than as a storage failure. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) throw signal.reason;
}

/** One stored record as a credential, or nothing when it holds no shape pi stores. */
function credentialOf(value: unknown): Credential | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const type = (value as { type?: unknown }).type;
	return type === "api_key" || type === "oauth" ? (value as Credential) : undefined;
}
