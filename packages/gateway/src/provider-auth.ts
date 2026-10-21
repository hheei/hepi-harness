import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { ApiKeyCredential, AuthContext, Provider } from "@earendil-works/pi-ai";
import type {
	ProviderAuthFailureCode,
	ProviderAuthRequest,
	ProviderAuthResult,
	ProviderAuthStatus,
	ProviderCredentialType,
} from "@hepi/protocol/gateway";
import { SECRET_MASK } from "@hepi/protocol/mcp-secrets";

export type {
	ProviderAuthFailureCode,
	ProviderAuthRequest,
	ProviderAuthResult,
	ProviderAuthStatus,
	ProviderCredentialType,
} from "@hepi/protocol/gateway";

/**
 * Provider connection state on this execution host: which providers exist, what `auth.json` holds for them, and the
 * API-key write path.
 *
 * This host owns the credential file because it owns the account those credentials belong to. The durable Backend stores
 * no provider credential and is not a broker for one: a key reaches this service from an authenticated Web BFF and goes
 * no further than the execution account's own `auth.json`. Nothing here answers with a stored value — a listing reports
 * presence, type and a display-only hint, and a mutation answers that listing, so a caller can never read back what it
 * wrote.
 *
 * The provider set and every provider's auth semantics come from `@earendil-works/pi-ai`'s own definitions, so this file
 * declares no provider list and no auth protocol. Storage is pi's own shape — one `{ type, ... }` record per provider id
 * — written under the same `proper-lockfile` contract and restrictive modes its `FileAuthStorageBackend` uses, so the pi
 * CLI, the Backend's Pi mode and this service remain three writers of one format rather than three formats.
 */

/** One provider this host serves, as the SDK's own definition declares it. */
export type ProviderCatalogEntry = {
	readonly id: string;
	readonly name: string;
	readonly hasApiKey: boolean;
	readonly hasOAuth: boolean;
};

/** How long a credential mutation waits for another writer of `auth.json` before it refuses. */
export const PROVIDER_AUTH_LOCK_TIMEOUT_MS = 10_000;

/** How long one provider's own `resolve()` may take while a listing reports its status. */
const PROVIDER_RESOLVE_TIMEOUT_MS = 5_000;

/** The source a stored subscription is reported under — the SDK's own word for it, so a listing reads the same here and in `checkAuth`. */
const OAUTH_SOURCE = "OAuth";

/** Restrictive modes: the directory and the file, as pi's own credential store creates them. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** A hint shorter than this discloses nothing: masking every character of a short key would still name it. */
const MIN_HINT_LENGTH = 16;
const HINT_PREFIX = 4;
const HINT_SUFFIX = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The type tag of one stored record, or undefined when it holds nothing pi stores. */
function credentialTypeOf(value: unknown): ProviderCredentialType | undefined {
	if (!isRecord(value)) return undefined;
	return value.type === "api_key" || value.type === "oauth" ? value.type : undefined;
}

/**
 * The display hint of a stored API key: a short prefix and suffix with everything between them replaced.
 *
 * It is derived on the host that owns the value and only its masked form ever leaves. A key short enough that a prefix
 * and a suffix would name most of it gets no hint at all.
 */
export function maskedKeyHint(key: string): string | undefined {
	if (key.length < MIN_HINT_LENGTH) return undefined;
	return key.slice(0, HINT_PREFIX) + SECRET_MASK + key.slice(-HINT_SUFFIX);
}

/** The file exists but cannot be used. Its own detail stays here: the surfaced text is fixed. */
export class ProviderAuthFileError extends Error {
	readonly detail: string;
	constructor(text: string, detail: string) {
		super(text);
		this.name = "ProviderAuthFileError";
		this.detail = detail;
	}
}

/** Another writer holds the lock for longer than this service waits. */
export class ProviderAuthLockError extends Error {
	readonly detail: string;
	constructor(text: string, detail: string) {
		super(text);
		this.name = "ProviderAuthLockError";
		this.detail = detail;
	}
}

/**
 * The `auth.json` of this host's agent directory, read and written the way pi's own store does it.
 *
 * A write replaces the file through a temporary file in the same directory, so a reader never sees a half-written
 * document and a crash leaves either the old file or the new one. The lock is taken for the whole read-modify-write,
 * which is what keeps a concurrent pi CLI login and this service's write from losing each other's entry.
 */
export class ProviderCredentialFile {
	readonly path: string;
	readonly #lockTimeoutMs: number;

	constructor(path: string, lockTimeoutMs = PROVIDER_AUTH_LOCK_TIMEOUT_MS) {
		this.path = path;
		this.#lockTimeoutMs = lockTimeoutMs;
	}

	/** The stored records, as the file holds them. A missing file is an empty store; an unreadable one is an error. */
	read(): Record<string, unknown> {
		if (!existsSync(this.path)) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (error) {
			throw new ProviderAuthFileError("auth.json is not readable JSON", message(error));
		}
		if (!isRecord(parsed)) throw new ProviderAuthFileError("auth.json does not hold an object", "expected a JSON object");
		return parsed;
	}

	/**
	 * Read, change and write the file as one locked step.
	 *
	 * `change` returns the new records, or leaves them out to leave the file untouched, so a request that changed
	 * nothing does not rewrite it. A lock that cannot be taken is reported as its own failure, because a caller can
	 * retry it.
	 *
	 * The file is created inside that lock rather than before it. This credential file has several writers of the same
	 * account — this service, another process of it, and the pi CLI signing in — and a writer that created the file
	 * because it saw none yet would truncate whatever the writer it was waiting for had just stored.
	 */
	async update<T>(change: (records: Record<string, unknown>) => { records?: Record<string, unknown>; value: T }): Promise<T> {
		return await this.#withLock(async () => {
			const { records, value } = change(this.read());
			if (records !== undefined) this.#write(records);
			return value;
		});
	}

	/**
	 * The same locked step, with a change that awaits.
	 *
	 * pi's own `CredentialStore.modify` is async and is the path a login's credential arrives through, and its contract is
	 * that the read, the caller's decision and the write are one serialized step — that is what keeps a token rotated by a
	 * concurrent refresh from being overwritten by a stale one. A synchronous `update` cannot express that, because the
	 * lock would be released before the awaiting half ran. One lock covers all three.
	 */
	async updateAsync<T>(change: (records: Record<string, unknown>) => Promise<{ records?: Record<string, unknown>; value: T }>): Promise<T> {
		return await this.#withLock(async () => {
			const { records, value } = await change(this.read());
			if (records !== undefined) this.#write(records);
			return value;
		});
	}

	/**
	 * Run one step while this host's writers of the file wait.
	 *
	 * The directory and the file are prepared inside the lock, never before it: a writer that creates the file because it
	 * saw none yet would truncate whatever the writer it was waiting for had just stored. The file mode is re-applied on
	 * every step, so a file that a person or another tool widened is put back to what an account's credentials should be
	 * readable under.
	 */
	async #withLock<T>(step: () => Promise<T>): Promise<T> {
		mkdirSync(dirname(this.path), { recursive: true, mode: DIRECTORY_MODE });
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(this.path, {
				realpath: false,
				stale: 30_000,
				retries: lockRetryOptions(this.#lockTimeoutMs),
			});
		} catch (error) {
			throw new ProviderAuthLockError("another writer of auth.json is holding the lock", message(error));
		}
		try {
			this.#createIfAbsent();
			chmodSync(this.path, FILE_MODE);
			return await step();
		} finally {
			await release().catch(() => undefined);
		}
	}

	/**
	 * Make the file exist, without ever overwriting what another writer already put there.
	 *
	 * `wx` is the one create that cannot truncate: it either creates this file or reports that it already exists, so no
	 * window opens between asking whether the file is there and writing it. An existing file is left exactly as it was —
	 * reading it is the next step, and an unreadable one is reported as its own failure.
	 */
	#createIfAbsent(): void {
		try {
			writeFileSync(this.path, "{}\n", { encoding: "utf8", flag: "wx", mode: FILE_MODE });
		} catch (error) {
			if ((error as { code?: string }).code === "EEXIST") return;
			throw error;
		}
	}

	#write(records: Record<string, unknown>): void {
		const temporary = this.path + "." + process.pid + ".tmp";
		try {
			writeFileSync(temporary, JSON.stringify(records, null, 2) + "\n", { encoding: "utf8", mode: FILE_MODE });
			renameSync(temporary, this.path);
		} catch (error) {
			try { unlinkSync(temporary); } catch { /* nothing was created */ }
			throw error;
		}
		chmodSync(this.path, FILE_MODE);
	}
}

/** One provider-auth operation's answer, plus the error classes above as its refusals. */
export class ProviderAuthService {
	readonly #file: ProviderCredentialFile;
	readonly #context: AuthContext;
	readonly #loadCatalog: () => Promise<readonly ProviderCatalogEntry[]>;
	#catalog: Promise<readonly ProviderCatalogEntry[]> | undefined;

	constructor(options: {
		/** The agent directory whose `auth.json` this host owns. */
		readonly agentDir: string;
		/** This host's environment and files, as a provider's own resolution reads them. */
		readonly context: AuthContext;
		/** The providers to serve. Absent reads the SDK's built-in set, which it does lazily. */
		readonly catalog?: () => Promise<readonly ProviderCatalogEntry[]>;
		readonly lockTimeoutMs?: number;
	}) {
		this.#file = new ProviderCredentialFile(join(options.agentDir, "auth.json"), options.lockTimeoutMs);
		this.#context = options.context;
		this.#loadCatalog = options.catalog ?? builtinProviderCatalog;
	}

	/**
	 * The credential file this service owns.
	 *
	 * A sign-in writes through it rather than opening its own handle on the same path: a listing, an API-key write and a
	 * finished flow are three operations on one account file, and one lock budget is the difference between waiting for
	 * another writer and racing a second instance of this process against itself.
	 */
	get credentialFile(): ProviderCredentialFile {
		return this.#file;
	}

	async execute(request: ProviderAuthRequest): Promise<ProviderAuthResult> {
		try {
			const catalog = await this.#catalogOnce();
			switch (request.operation) {
				case "list":
					return { ok: true, value: await this.#listing(catalog) };
				case "set-key":
					return await this.#setKey(catalog, request.providerId, request.apiKey);
				case "remove":
					return await this.#remove(catalog, request.providerId, request.expectedType);
				default:
					return refusal("unsupported_operation", "this gateway does not serve that provider-auth operation");
			}
		} catch (error) {
			return this.#failure(error);
		}
	}

	async #catalogOnce(): Promise<readonly ProviderCatalogEntry[]> {
		this.#catalog ??= this.#loadCatalog();
		return await this.#catalog;
	}

	/**
	 * The listing: every provider this host serves, in the SDK's own order, with what is stored for each.
	 *
	 * A provider whose status cannot be resolved is still listed and reported as not configured, because a provider that
	 * vanished from the listing would be one a panel cannot tell from a provider this host does not serve.
	 */
	async #listing(catalog: readonly ProviderCatalogEntry[]): Promise<readonly ProviderAuthStatus[]> {
		const records = this.#file.read();
		const listing: ProviderAuthStatus[] = [];
		for (const entry of catalog) {
			const record = records[entry.id];
			const storedType = credentialTypeOf(record);
			listing.push({
				providerId: entry.id,
				name: entry.name,
				methods: { apiKey: entry.hasApiKey, oauth: entry.hasOAuth },
				...(await this.#statusOf(entry, storedType, storedType === "api_key" ? (record as ApiKeyCredential) : undefined)),
				...(storedType === undefined ? {} : { storedType }),
				...this.#hintOf(record, storedType),
			});
		}
		return listing;
	}

	/**
	 * Whether a request could be authenticated right now, by either of the two ways a host holds a credential.
	 *
	 * A stored subscription is answered the way the SDK's own `checkAuth` answers it — the entry is there, the provider
	 * declares the method, and no network call is made. A token that needs refreshing is still configured, and `refresh`
	 * is what the next request runs; reporting it unconfigured would hide a provider a person signed in to behind a
	 * listing that offered them the sign-in again.
	 *
	 * `apiKey.resolve()` is the SDK's answer for both a stored key and an ambient one, so a provider authenticated from
	 * the environment reads as configured with nothing stored — which is the truth about this host's file, and why the
	 * two facts are reported separately.
	 */
	async #statusOf(entry: ProviderCatalogEntry, storedType: ProviderCredentialType | undefined, credential: ApiKeyCredential | undefined): Promise<{ configured: boolean; source?: string }> {
		// Read off the catalog entry being listed, not off an SDK provider object: this host's own statement that a
		// subscription is stored and the provider declares the method is the whole question, and a provider registered on
		// this host rather than shipped in the SDK has no entry in that map to be refused by.
		if (storedType === "oauth") return entry.hasOAuth ? { configured: true, source: OAUTH_SOURCE } : { configured: false };
		const provider = await this.#provider(entry.id);
		if (provider?.auth.apiKey === undefined) return { configured: false };
		try {
			const result = await provider.auth.apiKey.resolve({
				ctx: this.#context,
				...(credential === undefined ? {} : { credential }),
				signal: AbortSignal.timeout(PROVIDER_RESOLVE_TIMEOUT_MS),
			});
			if (result === undefined) return { configured: false };
			return { configured: true, ...(result.source === undefined ? {} : { source: result.source }) };
		} catch {
			// A resolution that throws — a malformed ambient file, an unreadable profile — is not a credential this host can
			// use. Its reason is the provider's and can quote a value it read, so it is not reported.
			return { configured: false };
		}
	}

	/** The display hint of a stored API key, and none for any other stored shape. */
	#hintOf(record: unknown, storedType: ProviderCredentialType | undefined): { maskedHint?: string } {
		if (storedType !== "api_key" || !isRecord(record) || typeof record.key !== "string") return {};
		const hint = maskedKeyHint(record.key);
		return hint === undefined ? {} : { maskedHint: hint };
	}

	/**
	 * Store one API key.
	 *
	 * The value is validated as a key this host could use — one non-empty line, bounded — before anything is written, and
	 * the write is a read-modify-write under the file lock that leaves every other provider's entry untouched. The answer
	 * is the listing, so the caller learns the new state and never the value.
	 */
	async #setKey(catalog: readonly ProviderCatalogEntry[], providerId: unknown, apiKey: unknown): Promise<ProviderAuthResult> {
		const known = this.#knownProvider(catalog, providerId);
		if (typeof known !== "string") return known;
		if (typeof apiKey !== "string") return refusal("invalid_request", "set-key requires the key as a string");
		if (!validKey(apiKey)) return refusal("invalid_request", "that is not a usable API key: it must be one non-blank line of at most 8192 characters");
		if (catalog.find((entry) => entry.id === known)?.hasApiKey !== true) return refusal("unsupported_operation", "that provider accepts no API key on this host");
		await this.#file.update((records) => ({ records: { ...records, [known]: { type: "api_key", key: apiKey } }, value: undefined }));
		return { ok: true, value: await this.#listing(catalog) };
	}

	/**
	 * Remove whatever is stored for one provider.
	 *
	 * A provider with nothing stored is a success: the caller asked for a state, and that state now holds. A named type
	 * that does not match what is there refuses without writing, so a stale request cannot discard a credential stored by
	 * a different method after the panel read its listing.
	 */
	async #remove(catalog: readonly ProviderCatalogEntry[], providerId: unknown, expectedType: unknown): Promise<ProviderAuthResult> {
		const known = this.#knownProvider(catalog, providerId);
		if (typeof known !== "string") return known;
		if (expectedType !== undefined && expectedType !== "api_key" && expectedType !== "oauth") return refusal("invalid_request", "expectedType names api_key or oauth");
		await this.#file.update((records) => {
			if (!Object.hasOwn(records, known)) return { value: undefined };
			if (expectedType !== undefined && credentialTypeOf(records[known]) !== expectedType) throw new CredentialMismatchError();
			const next = { ...records };
			delete next[known];
			return { records: next, value: undefined };
		});
		return { ok: true, value: await this.#listing(catalog) };
	}

	/** The provider id as a string, or the refusal that names why it is not one. */
	#knownProvider(catalog: readonly ProviderCatalogEntry[], providerId: unknown): string | ProviderAuthResult {
		if (typeof providerId !== "string" || providerId.trim() === "") return refusal("invalid_request", "the request names no provider");
		const id = providerId.trim();
		return catalog.some((entry) => entry.id === id) ? id : refusal("unknown_provider", "this host serves no provider with that id");
	}

	#provider(providerId: string): Promise<Provider | undefined> {
		this.#providers ??= importProviders();
		return this.#providers.then((providers) => providers.get(providerId));
	}

	#providers: Promise<ReadonlyMap<string, Provider>> | undefined;

	/**
	 * One failure, as the sanitized code and text this surface answers with.
	 *
	 * The upstream text is deliberately not forwarded: pi's own credential errors quote the offending value, and a
	 * provider's resolution error can quote an environment value it read. What is answered is this service's own fixed
	 * sentence for the class of failure.
	 */
	#failure(error: unknown): ProviderAuthResult {
		if (error instanceof CredentialMismatchError) return refusal("credential_mismatch", "the stored credential is not the kind this request expected, so it was left in place");
		if (error instanceof ProviderAuthLockError) return refusal("lock_unavailable", "another writer is holding auth.json; nothing was changed");
		if (error instanceof ProviderAuthFileError) return refusal("auth_file_unreadable", "auth.json on this host could not be used; nothing was changed");
		const code = String((error as { code?: unknown } | undefined)?.code ?? "");
		if (code === "EACCES" || code === "EPERM") return refusal("permission_denied", "this host refused access to its agent directory; nothing was changed");
		return refusal("operation_failed", "the provider-auth operation failed on this host");
	}
}

/** The stored credential is not the type the caller said it would be, so the removal was not performed. */
class CredentialMismatchError extends Error {
	constructor() {
		super("stored credential type does not match");
		this.name = "CredentialMismatchError";
	}
}

function refusal(code: ProviderAuthFailureCode, text: string): ProviderAuthResult {
	return { ok: false, code, message: text };
}

/**
 * The lock retry schedule for one wait budget.
 *
 * The schedule is derived from the budget rather than fixed, because a fixed one either gives up before the budget is
 * spent or outlives it: the retry helper needs a maximum above its minimum, and a caller that states a short budget must
 * get a refusal inside it rather than a schedule it cannot honour.
 */
function lockRetryOptions(timeoutMs: number): { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean } {
	const minTimeout = 50;
	const retries = Math.max(1, Math.ceil(Math.log2(Math.max(2, timeoutMs / minTimeout + 1))) - 1);
	return { retries, factor: 2, minTimeout, maxTimeout: Math.max(minTimeout, timeoutMs / 4), randomize: true };
}

/** Whether a value is a key this host could store and use: one non-blank line, bounded, no surrounding space. */
function validKey(value: string): boolean {
	return value.length > 0 && value.length <= 8192 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * The SDK's own provider set, loaded on first use.
 *
 * The import is a static specifier inside a function so a bundler keeps it in its own chunk: this module is reachable
 * from the gateway's route table, and the provider catalog is megabytes of generated model data that a gateway serving no
 * provider surface should never pay for at startup.
 */
async function importProviders(): Promise<ReadonlyMap<string, Provider>> {
	const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
	return new Map(builtinProviders().map((provider) => [provider.id, provider]));
}

/** The catalog entry of every provider the SDK defines: its id, display name and the auth methods it declares. */
export async function builtinProviderCatalog(): Promise<readonly ProviderCatalogEntry[]> {
	const providers = await importProviders();
	return [...providers.values()].map((provider) => ({ id: provider.id, name: provider.name, hasApiKey: provider.auth.apiKey !== undefined, hasOAuth: provider.auth.oauth !== undefined }));
}

/**
 * The auth context of the account this gateway runs as: this process's environment, and file existence on this host.
 *
 * It is stated explicitly rather than left to the SDK's default so a host whose environment is not this process's — or a
 * test — passes the context it means instead of inheriting one.
 */
export function localProviderAuthContext(env: NodeJS.ProcessEnv = process.env): AuthContext {
	return {
		env: async (name: string) => env[name],
		fileExists: async (path: string) => existsSync(expandHome(path)),
	};
}

function expandHome(path: string): string {
	const home = process.env.HOME;
	if (home === undefined) return path;
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
