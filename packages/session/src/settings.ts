/**
 * Whose settings a client is holding: the Backend it is connected to and the account scope that Backend states.
 *
 * This is a client-side fact read from the connection descriptor, not a path and not a working directory. Two
 * deployments can offer the same cwd — indeed the same model ids — and hold different catalogs, different
 * `models.json` and different extension inventories, so a settings cache keyed by anything a caller happens to have in
 * hand would hand one deployment's answer to a reader of the other. The descriptor is the only place the identity
 * comes from, which is why the scope is derived from it here and nowhere else.
 */
export type ConnectionScope = {
	readonly backendId: string;
	readonly accountScope: string;
};

/** The part of the connection descriptor this scope is read from: the Backend's identity and the account it serves. */
export type ScopedDescriptor = {
	readonly backend?: { readonly id?: unknown };
	readonly account?: { readonly scope?: unknown };
};

/**
 * The scope one connection's settings belong to, from the descriptor the Backend itself answered.
 *
 * A descriptor that names no Backend, or no account scope, is refused rather than defaulted: collapsing an unstated
 * identity into one shared scope is precisely how two connections would start reading each other's settings, and a
 * client that cannot tell whose catalog it holds has nothing correct to show.
 */
export function connectionScopeOf(descriptor: ScopedDescriptor): ConnectionScope {
	const backendId = descriptor.backend?.id;
	const accountScope = descriptor.account?.scope;
	if (typeof backendId !== "string" || backendId === "" || typeof accountScope !== "string" || accountScope === "") {
		throw new Error("the connection descriptor states no usable Backend identity");
	}
	return { backendId, accountScope };
}

/** One cached answer, with the moment it stops being usable. */
type Entry<T> = { readonly value: T; readonly expiresAt: number };

export type ScopedCacheSettings = {
	/** How long a cached answer is served before the loader is asked again. */
	readonly ttlMs: number;
	/** How many entries one cache keeps, so a long-lived client cannot grow without bound. */
	readonly maxEntries: number;
	/** The clock, injected so an expiry is a fact a test can state rather than a sleep it waits out. */
	readonly now?: () => number;
};

/**
 * A cache of one deployment's answers, keyed by the connection's own scope **and** the caller's key inside it.
 *
 * Both halves matter and neither is enough. The caller's key (a cwd, a conversation) says which answer within one
 * deployment is wanted; the scope says which deployment. A cache keyed by the caller's key alone serves another
 * Backend's catalog the moment a client holds two connections — which is what an App does when its user switches
 * profile — so the scope is part of the identity of every entry and of every read in flight.
 *
 * In flight as well as settled: two reads for the same deployment share one request, and a read for a different one
 * never joins it. `invalidate` is what a save calls, and it bumps a generation so a read that was already running when
 * the save happened cannot populate the cache with the answer the save replaced.
 */
export type ScopedCache<T> = {
	load(scope: ConnectionScope, key: string, loader: () => Promise<T>): Promise<T>;
	/** Drop every entry and every in-flight read, so the next read asks again. A read already running will not populate. */
	invalidate(): void;
	/** How many entries are held, for a caller that bounds its own memory and for a test that states one. */
	readonly size: number;
};

/** The key one entry is held under: the connection's identity, then the caller's own key. */
function cacheKey(scope: ConnectionScope, key: string): string {
	return JSON.stringify([scope.backendId, scope.accountScope, key]);
}

export function createScopedCache<T>(settings: ScopedCacheSettings): ScopedCache<T> {
	const now = settings.now ?? Date.now;
	const entries = new Map<string, Entry<T>>();
	const inFlight = new Map<string, Promise<T>>();
	let generation = 0;
	return {
		get size(): number { return entries.size; },
		load(scope, key, loader) {
			const composite = cacheKey(scope, key);
			const cached = entries.get(composite);
			if (cached !== undefined) {
				if (cached.expiresAt > now()) return Promise.resolve(cached.value);
				entries.delete(composite);
			}
			const existing = inFlight.get(composite);
			if (existing !== undefined) return existing;
			const startedAt = generation;
			const pending: Promise<T> = Promise.resolve()
				.then(loader)
				.then((value) => {
					// A save between the request and its answer makes this answer stale before it arrives: it is returned to
					// the caller that asked, and never becomes what the next reader is served.
					if (generation === startedAt && inFlight.get(composite) === pending) {
						const deadline = now();
						for (const [name, entry] of entries) if (entry.expiresAt <= deadline) entries.delete(name);
						while (entries.size >= settings.maxEntries) {
							const oldest = entries.keys().next().value;
							if (oldest === undefined) break;
							entries.delete(oldest);
						}
						entries.set(composite, { value, expiresAt: deadline + settings.ttlMs });
					}
					return value;
				})
				.finally(() => { if (inFlight.get(composite) === pending) inFlight.delete(composite); });
			inFlight.set(composite, pending);
			return pending;
		},
		invalidate() {
			generation += 1;
			entries.clear();
			inFlight.clear();
		},
	};
}
