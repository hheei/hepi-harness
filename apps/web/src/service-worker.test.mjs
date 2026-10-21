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

/** Load the worker into a fresh scope and hand back the listeners it installed. */
async function worker({ cache = new Map(), fetchImpl } = {}) {
  const listeners = new Map();
  const caches = {
    open: async (name) => ({
      addAll: async (urls) => { for (const url of urls) cache.set(url, "precached:" + url); },
      put: async (request, response) => { cache.set(new URL(request.url ?? request).pathname, await response.clone().text()); },
    }),
    match: async (target) => {
      const path = typeof target === "string" ? target : new URL(target.url).pathname;
      const hit = cache.get(path);
      return hit === undefined ? undefined : new Response(hit, { headers: { "content-type": "text/html" } });
    },
    keys: async () => ["pi-web-static-v1"],
    delete: async () => true,
  };
  globalThis.caches = caches;
  globalThis.fetch = fetchImpl ?? (async (request) => new Response("network:" + new URL(request.url).pathname));
  globalThis.self = {
    location: { href: origin + "/sw.js?v=test", origin },
    addEventListener: (type, listener) => listeners.set(type, listener),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => null },
  };
  globalThis.self.registration = { showNotification: async () => {} };
  // A fresh evaluation per case, wrapped so the worker's own top-level names do not collide between cases: the worker
  // installs its listeners at load, and a cached module instance would share them.
  vm.runInThisContext("(function () {" + source + "\n})()", { filename: "sw.js" });
  return listeners;
}

/** Dispatch one fetch event and report what the worker answered with, and what it kept running in the background. */
function dispatch(listeners, url, mode = "cors") {
  const request = new Request(url);
  Object.defineProperty(request, "mode", { value: mode });
  let answered;
  const background = [];
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { answered = promise; },
    waitUntil: (promise) => background.push(promise),
  });
  return { answered, background };
}

test("a first install precaches only static Web assets and claims no API", async () => {
  const cache = new Map();
  const listeners = await worker({ cache });
  let install;
  listeners.get("install")({ waitUntil: (promise) => { install = promise; } });
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
  const cache = new Map([["/offline.html", "<h1>Pi Web is offline</h1>"]]);
  let asked = [];
  const listeners = await worker({
    cache,
    fetchImpl: async (request) => { asked.push(new URL(request.url).pathname); throw new TypeError("Failed to fetch"); },
  });
  const { answered } = dispatch(listeners, origin + "/?session=conv", "navigate");
  const response = await answered;
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
  ]) {
    assert.equal(dispatch(listeners, url, mode).answered, undefined, url + " is not answered by the worker");
  }
});

test("a clicked page notice opens the target the page stated, and only on this origin", async () => {
  const cache = new Map();
  const listeners = await worker({ cache });
  const opened = [];
  globalThis.self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); return null; },
  };
  for (const [data, expected] of [
    [{ url: "/?session=conv" }, origin + "/?session=conv"],
    [{ url: "https://attacker.test/redirect" }, origin + "/"],
    [{}, origin + "/"],
  ]) {
    let pending;
    let closed = false;
    listeners.get("notificationclick")({
      notification: { data, close: () => { closed = true; } },
      waitUntil: (promise) => { pending = promise; },
    });
    await pending;
    assert.equal(closed, true, "the notice is dismissed");
    assert.equal(opened.pop(), expected, JSON.stringify(data));
  }
});

test("Vite's hashed assets are served from cache once, and a cold miss is stored without blocking the response", async () => {
  const cache = new Map();
  let networkCalls = 0;
  const listeners = await worker({
    cache,
    fetchImpl: async (request) => {
      networkCalls += 1;
      const response = new Response("asset:" + new URL(request.url).pathname);
      Object.defineProperty(response, "type", { value: "basic" });
      return response;
    },
  });
  for (const asset of viteAssets) {
    const { answered, background } = dispatch(listeners, origin + asset);
    assert.equal(await (await answered).text(), "asset:" + asset, "the first read comes from the network");
    await Promise.all(background);
  }
  assert.equal(networkCalls, viteAssets.length);
  for (const asset of viteAssets) {
    assert.equal(cache.get(asset), "asset:" + asset, asset + " was written for the next visit");
  }
  const warm = dispatch(listeners, origin + viteAssets[0]);
  assert.equal(await (await warm.answered).text(), "asset:" + viteAssets[0], "a warm read is answered without the network");
  assert.equal(networkCalls, viteAssets.length, "and asks for nothing");
});
