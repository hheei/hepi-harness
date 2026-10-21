/**
 * The build's own version, substituted by `vite.config.ts` at build time.
 *
 * The service worker's URL carries it, so a new build installs a new cache and the activation deletes the ones it
 * replaces. Nothing else in the page reads it.
 */
declare const __WEB_BUILD_VERSION__: string;
