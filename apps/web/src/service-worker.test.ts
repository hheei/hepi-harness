import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/**
 * The Web service worker, run against the globals a worker really has.
 *
 * The worker is the Web host's alone: it exists to make a first visit installable and to answer a navigation with an
 * offline page when the ingress is unreachable. Everything it may keep is therefore static — the page shell, the
 * manifest, the icons, the offline page and Vite's own hashed assets — and every API or private answer is left to the
 * network, so a credential-scoped response is never stored by the browser's cache on this worker's behalf.
 *
 * The script is evaluated once per case in a fresh global scope, because a worker installs its listeners at load.
 */
const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const origin = "https://pi.test";
const viteAssets = ["/assets/index-4f3a1c.js", "/assets/index-8b21de.css", "/assets/vendor-91ac2f.woff2"];

/** What one worker event handler is handed: the two settlement hooks and the request it answers. */
interface FetchEventLike {
  readonly request: Request;
  respondWith(promise: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

/** The handler the worker installs for one event type. */
type WorkerListener = (event: never) => void;

/** The fake scope a case evaluates the worker in: the globals `sw.js` itself reads. */
interface FakeWorkerScope {
  caches: unknown;
  fetch: unknown;
  self: {
    location: { href: string; origin: string };
    addEventListener(type: string, listener: unknown): void;
    skipWaiting(): Promise<void>;
    clients: unknown;
    registration?: unknown;
  };
}

/**
 * The fixture stores what a response body says, so a warmed read is the text this worker really wrote rather than a
 * response object a case handed itself.
 */
async function worker({ cache = new Map<string, string>(), fetchImpl }: { cache?: Map<string, string>; fetchImpl?: (request: { url: string }) => Promise<Response> } = {}): Promise<Map<string, WorkerListener>> {
  const listeners = new Map<string, WorkerListener>();
  const caches = {
    open: async (_name: string) => ({
      addAll: async (urls: string[]) => { for (const url of urls) cache.set(url, "precached:" + url); },
      put: async (request: { url?: string } | string, response: Response) => { cache.set(new URL(requestUrl(request)).pathname, await response.clone().text()); },
    }),
    match: async (target: string | { url: string }) => {
      const path = typeof target === "string" ? target : new URL(target.url).pathname;
      const hit = cache.get(path);
      return hit === undefined ? undefined : new Response(hit, { headers: { "content-type": "text/html" } });
    },
    keys: async () => ["pi-web-static-v1"],
    delete: async () => true,
  };
  const scope = globalThis as unknown as FakeWorkerScope;
  scope.caches = caches;
  scope.fetch = fetchImpl ?? (async (request: { url: string }) => new Response("network:" + new URL(request.url).pathname));
  scope.self = {
    location: { href: origin + "/sw.js?v=test", origin },
    addEventListener: (type: string, listener: unknown) => { listeners.set(type, listener as WorkerListener); },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
  };
  scope.self.registration = { showNotification: async () => {} };
  // A fresh evaluation per case, wrapped so the worker's own top-level names do not collide between cases: the worker
  // installs its listeners at load, and a cached module instance would share them.
  vm.runInThisContext("(function () {" + source + "\n})()", { filename: "sw.js" });
  return listeners;
}

/** The address of a cache key or of a request: the worker's own store is keyed by path. */
function requestUrl(request: { url?: string } | string): string {
  return typeof request === "string" ? request : request.url ?? "";
}

/** The one listener a case needs, named so a missing one fails loudly instead of reading as undefined. */
function listenerOf(listeners: Map<string, WorkerListener>, type: string): WorkerListener {
  const listener = listeners.get(type);
  if (listener === undefined) throw new Error("the worker installed no " + type + " listener");
  return listener;
}

/** Dispatch one fetch event and report what the worker answered with, and what it kept running in the background. */
function dispatch(listeners: Map<string, WorkerListener>, url: string, mode = "cors"): { answered: Promise<Response> | undefined; background: Promise<unknown>[] } {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: mode });
  let answered: Promise<Response> | undefined;
  const background: Promise<unknown>[] = [];
  listenerOf(listeners, "fetch")({
    request,
    respondWith: (promise: Promise<Response>) => { answered = promise; },
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  } as never);
  return { answered, background };
}

/** The answer a dispatch produced: a worker that answered nothing is a failure, not a skipped case. */
async function answeredOf(event: { answered: Promise<Response> | undefined }): Promise<Response> {
  if (event.answered === undefined) throw new Error("the worker did not answer this request");
  return await event.answered;
}

test("a first install precaches only static Web assets and claims no API", async () => {
  const cache = new Map<string, string>();
  const listeners = await worker({ cache });
  let install: Promise<unknown> | undefined;
  listenerOf(listeners, "install")({ waitUntil: (promise: Promise<unknown>) => { install = promise; } } as never);
  await install;
  assert.deepEqual([...cache.keys()].sort(), [
    "/icons/apple-touch-icon.png",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/manifest.webmanifest",
    "/offline.html",
  ]);
  assert.equal([...cache.keys()].some((path) => path.startsWith("/api/")), false, "no API answer is precached");
});

test("a navigation asks the network and falls back to the offline page, never to a cached API body", async () => {
  // An installed worker: its install step already precached the offline page.
  const cache = new Map<string, string>([["/offline.html", "<h1>Pi Web is offline</h1>"]]);
  const asked: string[] = [];
  const listeners = await worker({
    cache,
    fetchImpl: async (request: { url: string }) => { asked.push(new URL(request.url).pathname); throw new TypeError("Failed to fetch"); },
  });
  const response = await answeredOf(dispatch(listeners, origin + "/?session=conv", "navigate"));
  assert.deepEqual(asked, ["/"], "the navigation went to the network first");
  assert.match(await response.text(), /offline/i, "and an unreachable ingress answers with the offline page");
});

test("API, private and foreign requests are left to the network", async () => {
  const cache = new Map();
  const listeners = await worker({ cache });
  for (const [url, mode] of [
    [origin + "/api/sessions", "cors"],
    [origin + "/api/conversations/c1/stream", "cors"],
    [origin + "/api/sessions/s1/entries/e1/text", "cors"],
    ["https://foreign.test/assets/app.js", "cors"],
    [origin + "/sw.js", "cors"],
  ] as const) {
    assert.equal(dispatch(listeners, url, mode).answered, undefined, url + " is not answered by the worker");
  }
});

test("a clicked page notice opens the target the page stated, and only on this origin", async () => {
  const cache = new Map<string, string>();
  const listeners = await worker({ cache });
  const opened: string[] = [];
  const scope = globalThis as unknown as FakeWorkerScope;
  scope.self.clients = {
    matchAll: async () => [],
    openWindow: async (url: string) => { opened.push(url); return null; },
  };
  for (const [data, expected] of [
    [{ url: "/?session=conv" }, origin + "/?session=conv"],
    [{ url: "https://attacker.test/redirect" }, origin + "/"],
    [{}, origin + "/"],
  ] as const) {
    let pending: Promise<unknown> | undefined;
    let closed = false;
    listenerOf(listeners, "notificationclick")({
      notification: { data, close: () => { closed = true; } },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    } as never);
    await pending;
    assert.equal(closed, true, "the notice is dismissed");
    assert.equal(opened.pop(), expected, JSON.stringify(data));
  }
});

test("Vite's hashed assets are served from cache once, and a cold miss is stored without blocking the response", async () => {
  const cache = new Map<string, string>();
  let networkCalls = 0;
  const listeners = await worker({
    cache,
    fetchImpl: async (request: { url: string }) => {
      networkCalls += 1;
      const response = new Response("asset:" + new URL(request.url).pathname);
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    },
  });
  for (const asset of viteAssets) {
    const event = dispatch(listeners, origin + asset);
    assert.equal(await (await answeredOf(event)).text(), "asset:" + asset, "the first read comes from the network");
    await Promise.all(event.background);
  }
  assert.equal(networkCalls, viteAssets.length);
  for (const asset of viteAssets) {
    assert.equal(cache.get(asset), "asset:" + asset, asset + " was written for the next visit");
  }
  const warm = dispatch(listeners, origin + viteAssets[0]);
  assert.equal(await (await answeredOf(warm)).text(), "asset:" + viteAssets[0], "a warm read is answered without the network");
  assert.equal(networkCalls, viteAssets.length, "and asks for nothing");
});
