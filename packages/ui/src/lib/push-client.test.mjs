import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * The Push prototype is retired, and nothing may quietly bring it back.
 *
 * A Web Push subscription is only real if a server holds the subscription and can send to it. This deployment has no
 * push backend: the routes the prototype called (`/api/push/config`, `/api/push/subscribe`) are answered by nothing, so
 * a subscription registered from the page could never be delivered to, and the button that registered one claimed a
 * background notification the product does not have. The page's completion notice is the in-page one, decided by the
 * lifecycle projection, and universal background push stays an explicit non-goal.
 */
const uiRoot = new URL("../", import.meta.url).pathname;
const webRoot = new URL("../../../../apps/web/", import.meta.url).pathname;

function sources(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // A vendored upstream snapshot is a copy, not this host's code: it is never imported and stays byte-identical.
      if (entry.isDirectory()) { if (entry.name !== "vendor" && entry.name !== "node_modules" && entry.name !== "dist") walk(path); }
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

test("no executable source asks for a push subscription or a push route", () => {
  const offenders = [];
  for (const path of [...sources(uiRoot), ...sources(webRoot)]) {
    const text = readFileSync(path, "utf8");
    if (/\/api\/push\//.test(text) || /pushManager|PushManager|subscribePush|setupPushSubscription/.test(text)) offenders.push(path);
  }
  assert.deepEqual(offenders, [], "the Push prototype stays deleted");
});

test("the worker installs no push or background handler: no background delivery is claimed", () => {
  const worker = readFileSync(join(webRoot, "public", "sw.js"), "utf8");
  // `notificationclick` is not one of these: the page raises its own completion notices through this worker's
  // registration, and the click on one of them has to be followed up. A push, sync or periodic-sync handler would claim
  // delivery that no server and no product feature here provides.
  for (const handler of ["push", "sync", "periodicsync"]) {
    assert.equal(new RegExp('addEventListener\\(\\s*"' + handler + '"').test(worker), false, "the worker handles no " + handler);
  }
});
