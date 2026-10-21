import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { connectionIdentityOf, connectionScopeKey, scopedKey } = await createJiti(import.meta.url).import("./connection-scope.ts");

const descriptor = { backend: { id: "backend-a" }, account: { scope: "account-a" } };

test("a connection's scope is its profile, its Backend and its account, and nothing else", () => {
  const identity = connectionIdentityOf("profile-1", descriptor);
  assert.deepEqual(identity, { profile: "profile-1", backendId: "backend-a", accountScope: "account-a" });
  // The same three facts are the same scope; any one of them changing is a different one. Two Backends really can hold
  // a conversation with the same id, so a scope that ignored the Backend would answer one of them with the other's data.
  assert.equal(connectionScopeKey(identity), connectionScopeKey(connectionIdentityOf("profile-1", descriptor)));
  assert.notEqual(connectionScopeKey(identity), connectionScopeKey(connectionIdentityOf("profile-2", descriptor)));
  assert.notEqual(connectionScopeKey(identity), connectionScopeKey(connectionIdentityOf("profile-1", { ...descriptor, backend: { id: "backend-b" } })));
  assert.notEqual(connectionScopeKey(identity), connectionScopeKey(connectionIdentityOf("profile-1", { ...descriptor, account: { scope: "account-b" } })));
});

test("a part that contains the separator cannot impersonate a different scope", () => {
  // Percent-encoding each part is what makes the join unambiguous: an id with a "|" in it would otherwise be able to
  // spell a different connection's key.
  const a = connectionScopeKey({ profile: "a|b", backendId: "c", accountScope: "d" });
  const b = connectionScopeKey({ profile: "a", backendId: "b|c", accountScope: "d" });
  assert.notEqual(a, b);
  assert.equal(a.split("|").length, 3, "the separator appears exactly twice, however the parts are spelled");
});

test("a descriptor that states no identity is refused rather than collapsed into one shared scope", () => {
  // An unstated identity defaulted to "" would put every connection in one scope, which is the failure the scope exists
  // to prevent. The ingress answers these fields on every descriptor; a payload without them is not a connection.
  for (const broken of [
    {},
    { backend: {} },
    { account: { scope: "account-a" } },
    { backend: { id: "backend-a" } },
    { backend: { id: "" }, account: { scope: "account-a" } },
    { backend: { id: "backend-a" }, account: { scope: "" } },
    { backend: { id: 7 }, account: { scope: "account-a" } },
  ]) assert.throws(() => connectionIdentityOf("profile-1", broken), /no usable Backend identity/, JSON.stringify(broken));
});

test("one store key inside a scope is not another connection's key", () => {
  const scope = connectionScopeKey(connectionIdentityOf("profile-1", descriptor));
  const other = connectionScopeKey(connectionIdentityOf("profile-2", descriptor));
  // The same conversation id on two connections is two different keys, which is what keeps a draft, a remembered view
  // and a staged turn from being read by the wrong one.
  assert.notEqual(scopedKey(scope, "conv"), scopedKey(other, "conv"));
  assert.equal(scopedKey(scope, "conv"), scope + "/conv");
});
