/**
 * The Web host's service worker.
 *
 * It exists for two things only: a first visit can be installed to the home screen, and a navigation the ingress cannot
 * answer shows the offline page instead of the browser's own error. Nothing here is a background capability — there is
 * no push handler and no sync handler, because this deployment serves no push backend and the App never registers this
 * worker at all.
 *
 * What may be kept is static and public: the page shell's own assets, the manifest, the icons and the offline page.
 * Every API request and every private answer is left to the network. A cache is not scoped to a credential, so a
 * response the ingress produced for one signed-in browser must never be readable from the cache by another, and a
 * conversation read is exactly that kind of answer.
 */
const CACHE_PREFIX = "pi-web-static";
const CACHE_VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = CACHE_PREFIX + "-" + CACHE_VERSION;
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
// A reachable port backed by a dead upstream accepts the connection and then never answers: fetch() neither resolves nor
// rejects, so the navigation hangs forever instead of falling back to offline.html. Bound every network wait.
const NAVIGATION_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 8000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX + "-") && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Conversation data, session data, resource blocks and this worker's own script must always come from the ingress.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS).catch(async () => {
        const fallback = await caches.match(OFFLINE_URL);
        return fallback ?? Response.error();
      }),
    );
    return;
  }

  // Vite emits every chunk and asset under /assets/ with a content hash in its name, so one name is one file forever and
  // a cache hit needs no revalidation. Nothing outside that prefix is kept: a path the build did not hash may be
  // replaced in place, and a stale copy of it would outlive its own upgrade.
  if (url.pathname.startsWith("/assets/") || PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, event));
  }
});

/**
 * A page notification the user clicked.
 *
 * The page raises its completion notices through this worker's registration when one exists, so the click arrives here
 * rather than in the page. Only the target that page stated is honoured, and only on this origin: a notice carrying a
 * foreign address opens the site root instead.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requestedUrl = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : "/";
  let targetUrl = new URL("/", self.location.origin);
  try {
    const candidate = new URL(requestedUrl, self.location.origin);
    if (candidate.origin === self.location.origin) targetUrl = candidate;
  } catch {
    // Keep the root URL when notification data is malformed.
  }

  event.waitUntil(focusOrOpenWindow(targetUrl.href));
});

async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const exactClient = windowClients.find((client) => client.url === targetUrl);
  const candidates = exactClient
    ? [exactClient, ...windowClients.filter((client) => client !== exactClient)]
    : windowClients;

  for (const client of candidates) {
    try {
      const targetClient = client.url === targetUrl
        ? client
        : (await client.navigate(targetUrl)) ?? client;
      await targetClient.focus();
      return;
    } catch {
      // The window may have closed between matchAll and focus; try the next one.
    }
  }

  await self.clients.openWindow(targetUrl);
}

/**
 * Fetch with a ceiling on the wait for the response headers (time to first byte). The timer is cleared as soon as they
 * arrive, so a response that streams a long body is never cut off mid-stream.
 */
async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request, event) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetchWithTimeout(request, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    // Deliberately NOT awaited before returning the response. A cold visit after an upgrade misses on every chunk and
    // writes them all at once; awaiting each write held every response behind Cache Storage I/O. waitUntil keeps this
    // worker alive until the write finishes without blocking the response.
    const copy = response.clone();
    event.waitUntil(
      caches
        .open(STATIC_CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => {
          // A failed write only costs one network re-fetch next time.
        }),
    );
  }
  return response;
}
