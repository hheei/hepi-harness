import { createScopedCache, connectionScopeOf, type ConnectionScope, type ScopedCache } from "@hepi/session/settings";
import type { ConnectionIdentity } from "./connection-scope";

/**
 * The deployment's model catalog, cached under the connection that read it.
 *
 * The catalog is read on every conversation switch — the composer needs it to render a model list — so it is worth
 * holding. What it must never be is one answer for two connections: two Backends, or two account scopes of one Backend,
 * can serve the same folder path and offer different models, so the cache key is the connection's own identity plus the
 * folder inside it. Keying by the folder alone is not a stale answer but the wrong one, which is what this seam exists
 * to prevent.
 *
 * The rule is not written here. `@hepi/session/settings` owns both halves — `connectionScopeOf` reads the identity off
 * the descriptor, `createScopedCache` scopes entries **and** in-flight reads and refuses to let an invalidated read
 * repopulate — so a second client surface cannot end up with a slightly different version of the same rule.
 */

const MODELS_CACHE_TTL_MS = 60_000;
const MAX_MODELS_CACHE_ENTRIES = 32;

/** The scope a cached catalog belongs to, from the identity the workbench's connection stated. */
export function modelsScopeOf(identity: ConnectionIdentity): ConnectionScope {
  return connectionScopeOf({ backend: { id: identity.backendId }, account: { scope: identity.accountScope } });
}

/** One cache per page: the model catalog is one deployment's answer set, not one per panel that renders a selector. */
export function createModelsCache<T>(settings: { readonly now?: () => number } = {}): ScopedCache<T> {
  return createScopedCache<T>({
    ttlMs: MODELS_CACHE_TTL_MS,
    maxEntries: MAX_MODELS_CACHE_ENTRIES,
    ...(settings.now === undefined ? {} : { now: settings.now }),
  });
}

let pageCatalogCache: ScopedCache<unknown> | undefined;

/**
 * The page's one catalog cache, held here rather than by whichever hook first read a catalog.
 *
 * The catalog is read by the composer and by anything else that lists models, and it is *changed* by a surface that
 * stores or removes a credential — which is a different component, on a different route, in a different package
 * directory. An instance owned by the reader would make that surface reach into the reader's module state, so the
 * instance belongs to the rule instead: one page, one cache, one place that says when its answer is superseded.
 */
export function pageModelsCache<T>(): ScopedCache<T> {
  return (pageCatalogCache ??= createModelsCache<T>()) as ScopedCache<T>;
}

/** The readers a model change has to reach: one per mounted consumer of the catalog. */
const catalogReaders = new Set<() => void>();

/**
 * Follow the model catalog: this reader is told when a change this page applied superseded what it holds.
 *
 * The readers are the mounted consumers — the composer's catalog read and anything else listing models — and the
 * subscription is what makes "mounted" a fact rather than a guess: a reader that unsubscribed is not holding anything
 * to re-read, so a change costs it nothing. The callback is the reader's own bounded read, not a fetch of this module's:
 * the retry policy, the scope and the fence belong to whoever asked, and this only says that what it holds is old.
 *
 * Every writer of a model-domain resource — a `models.json` save the Backend applied, a stored or removed credential, an
 * `enabledModels` write — states the change through {@link invalidateModelCatalog}, so there is one rule rather than one
 * per surface. It is deliberately not a global event bus: it carries no payload, names no other domain and reaches no
 * reader that did not ask to follow this catalog.
 */
export function subscribeModelCatalog(reader: () => void): () => void {
  catalogReaders.add(reader);
  return () => { catalogReaders.delete(reader); };
}

/**
 * State that the deployment's model list may no longer be what this page read.
 *
 * A provider credential is the host's own and the Backend resolves availability from it on each read, so nothing needs
 * to be told on the server: what a stored or removed credential changes is that this page is holding an answer the
 * change superseded. Dropping it is what makes the next read ask, and the generation rule inside the cache is what
 * stops a read already running when the credential changed from becoming the answer served afterwards.
 *
 * Mounted readers are then told, so a composer that is on screen re-reads now instead of showing an answer the change
 * replaced until someone closes Settings. Nothing is fetched here: a reader re-reads through its own bounded read, and a
 * page with no mounted reader fetches nothing at all — the next read is simply the fresh one. The current model, the
 * draft and any selection stay exactly as they were: this says the list is old, not what the session should run.
 */
export function invalidateModelCatalog(): void {
  pageModelsCache<unknown>().invalidate();
  for (const reader of [...catalogReaders]) reader();
}
