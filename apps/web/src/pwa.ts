/**
 * The Web host's install surface: one registration of the page's own service worker.
 *
 * This is the Web entry's act and nobody else's. The shared workbench never registers a worker, because the same tree
 * runs inside the packaged App, whose document has no origin to claim and whose offline behaviour is the shell's — the
 * App's own bundle test asserts that no registration reaches it. The manifest and the worker are served from
 * `apps/web/public`, which only this host builds.
 *
 * The worker's URL carries the build's version, so a new build installs a new cache and the activation deletes the ones
 * it replaces. That is not a migration of an old install: nothing is read out of an older cache and no older page is
 * kept working.
 */
export interface ServiceWorkerRegistrationEnvironment {
  readonly navigator: { readonly serviceWorker?: { register(url: string, options: RegistrationOptions): Promise<unknown> } };
  readonly version: string;
}

export async function registerServiceWorker(environment: ServiceWorkerRegistrationEnvironment): Promise<boolean> {
  const container = environment.navigator.serviceWorker;
  if (container === undefined) return false;
  try {
    await container.register("/sw.js?v=" + encodeURIComponent(environment.version), {
      scope: "/",
      updateViaCache: "none",
    });
    return true;
  } catch {
    // A refused registration costs the offline page, not the page: the app itself is served normally.
    return false;
  }
}
