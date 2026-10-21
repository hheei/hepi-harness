import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { connectionScopeOf, createScopedCache } = await jiti.import<typeof import("../../../session/src/settings.ts")>("../../../session/src/settings.ts");
const { modelsScopeOf, createModelsCache, invalidateModelCatalog, pageModelsCache, subscribeModelCatalog } = await jiti.import<typeof import("./models-cache.ts")>("./models-cache.ts");

/**
 * The scoped settings cache, at its public seam.
 *
 * A settings answer belongs to one connection: the Backend the descriptor named and the account scope it serves. These
 * tests hold the two ways that identity could leak — an entry keyed by the caller's own key alone, and an in-flight read
 * joined by a reader of another connection — plus the rule that a read already running when a save happened cannot
 * become what the next reader is served.
 */

const alpha = { backendId: "backend-A", accountScope: "account-A" };
const beta = { backendId: "backend-B", accountScope: "account-B" };
const clock = (start: number = 0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("the scope is read off the descriptor and an identity-less descriptor is refused", () => {
  assert.deepEqual(connectionScopeOf({ backend: { id: "backend-A" }, account: { scope: "account-A" } }), alpha);
  for (const broken of [
    {},
    { backend: { id: "" }, account: { scope: "account-A" } },
    { backend: { id: "backend-A" } },
    { backend: { id: "backend-A" }, account: { scope: "" } },
    { backend: { id: 7 }, account: { scope: "account-A" } },
  ]) {
    assert.throws(() => connectionScopeOf(broken), /identity/, "an identity-less descriptor produced a scope");
  }
  // The workbench's own identity yields exactly the same scope, so both halves name one connection.
  assert.deepEqual(modelsScopeOf({ profile: "web", backendId: "backend-A", accountScope: "account-A" }), alpha);
});

test("an entry is keyed by the connection as well as the caller's key", async () => {
  const cache = createScopedCache({ ttlMs: 1_000, maxEntries: 4, now: clock().now });
  let alphaReads = 0;
  let betaReads = 0;
  assert.deepEqual(await cache.load(alpha, "/workspace/one", async () => { alphaReads += 1; return ["alpha:alpha-1"]; }), ["alpha:alpha-1"]);
  assert.deepEqual(await cache.load(beta, "/workspace/one", async () => { betaReads += 1; return ["beta:beta-1"]; }), ["beta:beta-1"]);
  // The same scope and key is served from the entry: no second read.
  assert.deepEqual(await cache.load(alpha, "/workspace/one", async () => { alphaReads += 1; return ["wrong"]; }), ["alpha:alpha-1"]);
  assert.equal(alphaReads, 1);
  assert.equal(betaReads, 1);
  assert.equal(cache.size, 2);
});

test("an in-flight read is not joined by a reader of another connection", async () => {
  const cache = createScopedCache({ ttlMs: 1_000, maxEntries: 4, now: clock().now });
  const [a, aAgain, b] = await Promise.all([
    cache.load(alpha, "/workspace/one", async () => ["alpha:alpha-1"]),
    cache.load(alpha, "/workspace/one", async () => ["alpha:alpha-1"]),
    cache.load(beta, "/workspace/one", async () => ["beta:beta-1"]),
  ]);
  assert.deepEqual(a, ["alpha:alpha-1"]);
  assert.deepEqual(aAgain, ["alpha:alpha-1"]);
  assert.deepEqual(b, ["beta:beta-1"], "a load for another Backend identity joined the first one's in-flight read");
});

test("an invalidated read answers its own caller and never populates the cache", async () => {
  const cache = createScopedCache({ ttlMs: 1_000, maxEntries: 4, now: clock().now });
  let release: (value: string[]) => void = () => undefined;
  const held = new Promise<string[]>((resolve) => { release = resolve; });
  const inFlight = cache.load(alpha, "/workspace/two", async () => {
    await held;
    return ["before-save"];
  });
  cache.invalidate();
  release(["before-save"]);
  assert.deepEqual(await inFlight, ["before-save"], "the read in flight answered something other than what it read");
  assert.deepEqual(await cache.load(alpha, "/workspace/two", async () => ["after-save"]), ["after-save"], "an invalidated read populated the cache after the save");
});

test("an entry expires on the stated clock, and the cache keeps its bound", async () => {
  const time = clock();
  const cache = createScopedCache({ ttlMs: 1_000, maxEntries: 2, now: time.now });
  await cache.load(alpha, "one", async () => 1);
  await cache.load(alpha, "two", async () => 2);
  assert.equal(cache.size, 2);
  await cache.load(alpha, "three", async () => 3);
  assert.equal(cache.size, 2, "the cache grew past its stated bound");
  time.advance(1_001);
  assert.equal(await cache.load(alpha, "three", async () => 30), 30, "an expired entry was served");
});

test("the page's cache is the instance a credential change drops", async () => {
  // The composer reads the catalog through this instance; Settings › Models changes what that answer describes from a
  // different component on a different route. Two instances would make the invalidation a no-op that still passed a
  // unit test, so what is asserted here is that the caller and the dropper hold one cache.
  const cache = pageModelsCache();
  assert.equal(cache, pageModelsCache(), "a second call produced a second cache");
  let reads = 0;
  await cache.load(alpha, "/workspace/one", async () => { reads += 1; return ["first"]; });
  assert.deepEqual(await cache.load(alpha, "/workspace/one", async () => { reads += 1; return ["second"]; }), ["first"]);
  assert.equal(reads, 1);
  invalidateModelCatalog();
  assert.deepEqual(await cache.load(alpha, "/workspace/one", async () => { reads += 1; return ["after-change"]; }), ["after-change"]);
  assert.equal(reads, 2, "a credential change did not supersede the cached catalog");
  // Another connection's answer goes too: a stored key is one account's fact, and the page holds one account's cache.
  assert.equal(cache.size, 1);
});

test("a change reaches the readers that follow the catalog, and no reader that stopped", () => {
  // The cache answers "what did the deployment say"; this is the other half — "who is holding that answer on screen".
  // A mounted reader re-reads through its own bounded read, so the rule only has to say that it happened, exactly once
  // per change, and never to a reader that unsubscribed.
  let reads = 0;
  const stop = subscribeModelCatalog(() => { reads += 1; });
  invalidateModelCatalog();
  assert.equal(reads, 1, "a change did not reach the mounted reader");
  assert.equal(pageModelsCache().size, 0, "the change left the page's cached answer in place");
  stop();
  invalidateModelCatalog();
  assert.equal(reads, 1, "a change reached a reader that had stopped following");
});

test("a catalog read running when the credential changed cannot become the answer served afterwards", async () => {
  const cache = pageModelsCache();
  invalidateModelCatalog();
  let release: () => void = () => undefined;
  const running = cache.load(alpha, "/workspace/one", () => new Promise<string[]>((resolve) => { release = () => resolve(["mid-change"]); }));
  // The loader runs on the cache's own promise chain, so the read is only in flight once that chain has reached it.
  await Promise.resolve();
  invalidateModelCatalog();
  release();
  assert.deepEqual(await running, ["mid-change"], "the caller already waiting on it is not left without an answer");
  assert.deepEqual(await cache.load(alpha, "/workspace/one", async () => ["asked again"]), ["asked again"], "the superseded read repopulated the cache");
});

test("the workbench's cache is that rule, with the catalog's own lifetime", async () => {
  const time = clock();
  const cache = createModelsCache({ now: time.now });
  await cache.load(alpha, "/workspace/one", async () => ["alpha:alpha-1"]);
  await cache.load(beta, "/workspace/one", async () => ["beta:beta-1"]);
  assert.equal(cache.size, 2, "two connections shared one catalog entry");
  time.advance(60_001);
  assert.deepEqual(await cache.load(beta, "/workspace/one", async () => ["beta-2"]), ["beta-2"]);
});
