/**
 * The Web host's install, offline and cache seam, in a real browser.
 *
 * The page under test is the real production build (`pnpm --filter @hepi/web build`), served by a real HTTP server and
 * loaded in a fresh Chromium profile: nothing here is a fixture of the app, and no state from an earlier visit exists
 * when the first navigation happens. What it asserts is the boundary the PWA work exists for:
 *
 *   1. the browser itself parses the manifest the page links, with the name, start URL and both icons it needs to offer
 *      an install;
 *   2. a first visit registers the worker, which activates and controls the page;
 *   3. a navigation the server cannot answer shows the offline page;
 *   4. Vite's hashed assets are served from the worker's cache on a later offline visit;
 *   5. an API response is never cached: it is asked of the network every time and is unavailable offline.
 *
 * What it does not assert: the browser's own install prompt. Headless Chromium exposes no way to accept one, and the
 * install surface is claimed here as what it is — a parsed manifest, an active worker and its icons.
 *
 * Usage: node apps/web/e2e/ux-pwa-offline.mjs [--keep]
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX_PWA_PORT ?? 43123);
const dist = join(webRoot, "dist");

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

// The production build this test loads. A stale dist would be a different page than the sources state.
const { build } = await import(join(webRoot, "node_modules", "vite", "dist", "node", "index.js"));
await build({ configFile: join(webRoot, "vite.config.ts"), logLevel: "warn" });

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
let apiReads = 0;
const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (path.startsWith("/api/")) {
    apiReads += 1;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ read: apiReads, private: "a signed-in conversation" }));
    return;
  }
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  const type = contentTypes[extname(name)] ?? (name.includes(".") ? undefined : contentTypes[".html"]);
  if (type === undefined) { response.writeHead(404).end("not found"); return; }
  readFile(join(dist, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

let exitCode = 1;
try {
  console.log("== production build served at " + origin);
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  // A fresh profile: no service worker, no cache storage and no cookie from any earlier visit.
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    // A fresh profile: no worker exists for this origin before the page is loaded at all.
    check(context.serviceWorkers().length === 0, "a fresh browser profile has no worker for this origin");
    const firstVisit = await page.goto(origin + "/", { waitUntil: "load" });
    check(firstVisit !== null && firstVisit.status() === 200, "and loads the page");

    // --- 1. The browser parses the manifest the page links. ------------------------------------------------------
    const cdp = await context.newCDPSession(page);
    const manifest = await cdp.send("Page.getAppManifest");
    check(manifest.url.endsWith("/manifest.webmanifest"), "the browser reads the linked manifest: " + manifest.url);
    check(manifest.errors.length === 0, "with no manifest error: " + JSON.stringify(manifest.errors));
    check(/"name"\s*:\s*"Pi Web"/.test(manifest.data), "the manifest names the app");
    check(/"start_url"\s*:\s*"\/"/.test(manifest.data), "and states the site root as its start URL");
    check(/"display"\s*:\s*"standalone"/.test(manifest.data), "and opens installed without browser chrome");
    const icons = JSON.parse(manifest.data).icons ?? [];
    check(icons.length === 2 && icons.every((icon) => /^\/icons\/icon-\d+\.png$/.test(icon.src)), "with the two install icons: " + JSON.stringify(icons.map((icon) => icon.src)));
    for (const icon of icons) {
      const response = await context.request.get(origin + icon.src);
      check(response.status() === 200 && response.headers()["content-type"] === "image/png", icon.src + " is served as a PNG");
    }

    // --- 2. The first visit registers the worker, which activates and controls the page. -------------------------
    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, script: ready.active?.scriptURL ?? null, state: ready.active?.state ?? null, controlled: navigator.serviceWorker.controller !== null };
    });
    check(registration.scope === origin + "/", "the worker claims the whole site: " + registration.scope);
    check(/\/sw\.js\?v=/.test(registration.script ?? ""), "its script is the versioned one: " + registration.script);
    check(registration.state === "activated", "and it is activated");
    check(registration.controlled === true, "and it controls the page it was registered from");
    // Nothing this visit kept came from an older site's worker: the cache holds this build's own static paths only.
    const kept = await page.evaluate(() => caches.keys().then((keys) => Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))).then((lists) => lists.flat().map((request) => new URL(request.url).pathname)));
    check(!kept.some((path) => path.startsWith("/_next/")), "no path from the retired Next worker is in the cache: " + JSON.stringify(kept.filter((path) => path.startsWith("/_next/"))));

    // The asset URL the build really emitted, so the offline read below is of a file that exists. The first load
    // fetched it before the worker controlled the page, so the reload below is what puts it through the worker's cache —
    // exactly what a returning visitor's second visit does.
    const asset = await page.evaluate(() => [...document.querySelectorAll("script[src]")].map((script) => script.getAttribute("src")).find((src) => /^\/assets\/.*\.js$/.test(src)) ?? null);
    check(typeof asset === "string", "the page loads a hashed Vite asset: " + asset);
    await page.reload({ waitUntil: "load" });
    check(await page.evaluate((url) => caches.match(url).then((hit) => hit !== undefined), asset), "the worker keeps the hashed asset it served");

    // --- 3. An API answer is asked of the network and never kept. ------------------------------------------------
    const firstRead = await page.evaluate(() => fetch("/api/sessions").then((response) => response.json()));
    const secondRead = await page.evaluate(() => fetch("/api/sessions").then((response) => response.json()));
    check(secondRead.read === firstRead.read + 1, "two API reads reach the server twice, never the cache: " + JSON.stringify([firstRead.read, secondRead.read]));
    const keptPaths = await page.evaluate(() => caches.keys().then((keys) => Promise.all(keys.map(async (key) => (await caches.open(key)).keys()))).then((lists) => lists.flat().map((request) => new URL(request.url).pathname)));
    check(!keptPaths.some((path) => path.startsWith("/api/")), "and no API path is in any cache: " + JSON.stringify(keptPaths.filter((path) => path.startsWith("/api/"))));

    // --- 4. Offline: the navigation shows the offline page and the asset still comes from the worker. -------------
    await context.setOffline(true);
    const offline = await page.goto(origin + "/?session=conv", { waitUntil: "load" });
    check(offline !== null && /Pi Web is offline/.test(await page.content()), "an unreachable ingress answers with the offline page");
    const offlineApi = await page.evaluate(() => fetch("/api/sessions").then(() => "answered", () => "refused"));
    check(offlineApi === "refused", "and a conversation read is refused rather than served from a cache: " + offlineApi);
    const offlineAsset = await page.evaluate(async (url) => {
      const response = await fetch(url);
      return { ok: response.ok, fromCache: (await caches.match(url)) !== undefined };
    }, asset);
    check(offlineAsset.fromCache === true, "the hashed asset is still in the worker's cache");
    check(offlineAsset.ok === true, "and is served from it while the server is unreachable");
    await context.setOffline(false);

    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other server or set HEPI_UX_PWA_PORT"
    : "the run threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  if (keep) console.log("dist kept at " + dist);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
