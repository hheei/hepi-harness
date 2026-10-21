import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const webRoot = new URL("../", import.meta.url).pathname;
const publicRoot = join(webRoot, "public");
const jiti = createJiti(import.meta.url);
const { registerServiceWorker } = await jiti.import<typeof import("./pwa.ts")>("./pwa.ts");

test("the Web page registers the versioned worker at the site root", async () => {
  const calls: { url: string; options: RegistrationOptions }[] = [];
  const navigator = {
    serviceWorker: {
      register: async (url: string, options: RegistrationOptions) => { calls.push({ url, options }); return {}; },
    },
  };
  assert.equal(await registerServiceWorker({ navigator, version: "0.10.0" }), true);
  assert.deepEqual(calls, [{ url: "/sw.js?v=0.10.0", options: { scope: "/", updateViaCache: "none" } }]);
});

test("a browser without a worker, or a refused registration, is not a page error", async () => {
  assert.equal(await registerServiceWorker({ navigator: {}, version: "1" }), false);
  const failing = { serviceWorker: { register: async (): Promise<unknown> => { throw new Error("refused"); } } };
  assert.equal(await registerServiceWorker({ navigator: failing, version: "1" }), false);
});

test("the manifest states an installable app whose icons are the files it names", () => {
  const manifest = JSON.parse(readFileSync(join(publicRoot, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.name, "Pi Web");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone", "an installed page opens without browser chrome");
  assert.deepEqual(manifest.icons.map((icon: { sizes: string }) => icon.sizes).sort(), ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    const bytes = readFileSync(join(publicRoot, icon.src.replace(/^\//, "")));
    const [width, height] = icon.sizes.split("x").map(Number);
    // The PNG header states the size the manifest claims, so the icon is what it says it is.
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [width, height], icon.src);
  }
});

test("every path the worker precaches is a file this host ships", () => {
  const worker = readFileSync(join(publicRoot, "sw.js"), "utf8");
  const constants = new Map([...worker.matchAll(/^const ([A-Z_]+) = "([^"]+)";$/gm)].map((match) => [match[1], match[2]]));
  const block = /^const PRECACHE_URLS = \[([\s\S]*?)^\];$/m.exec(worker)?.[1] ?? "";
  const precache = block
    .split("\n")
    .map((line) => /^ {2}"([^"]+)",$/.exec(line)?.[1] ?? (/^ {2}([A-Z_]+),$/.exec(line)?.[1]))
    .filter((entry) => entry !== undefined)
    .map((entry) => constants.get(entry) ?? entry);
  assert.ok(precache.includes("/offline.html"), "the offline page is the reason this worker exists");
  for (const path of precache) {
    assert.ok(statSync(join(publicRoot, path.replace(/^\//, ""))).isFile(), path + " is precached and shipped");
  }
});

test("no shared module registers a service worker: that is the Web host's own act", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && readFileSync(path, "utf8").includes("serviceWorker.register")) offenders.push(path);
    }
  };
  walk(new URL("../../../packages/ui/src/", import.meta.url).pathname);
  assert.deepEqual(offenders, [], "the App mounts the same shared tree and must not gain a worker with it");
});
