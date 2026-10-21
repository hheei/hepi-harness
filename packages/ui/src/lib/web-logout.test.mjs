import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { WEB_LOGOUT_PATH } = await jiti.import("@hepi/protocol");
const { cookieLogoutOffered, endWebSession } = await jiti.import("./web-logout.ts");

/**
 * The Web logout contract at its public seam.
 *
 * The surface that offers "Log out" asks one route, on one credential, and reports one of two outcomes. Each of those
 * three is a place this went wrong before: the panel named a route the ingress does not serve for logout, and the
 * section was offered to a bearer host that has no cookie to clear. So these cases hold the route (the constant both
 * sides read), the credential matrix (a cookie host offers it, a bearer host does not), and the answer (only a 2xx is a
 * logout; a refusal and a lost request both leave the session standing).
 */
const answer = (status, body = {}) => ({ response: new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });

/** One transport that records what it was asked and answers with the given status. */
function transport(status, body) {
  const calls = [];
  return {
    calls,
    request: async (path, init) => {
      calls.push({ path, init });
      const { response } = answer(status, body);
      return response;
    },
  };
}

test("a logout is the credential's own: a cookie host offers it and a bearer host does not", () => {
  assert.equal(cookieLogoutOffered("cookie"), true);
  assert.equal(cookieLogoutOffered("bearer"), false);
});

test("a logout asks the route the ingress serves, as a DELETE, on the connection's own transport", async () => {
  const sent = transport(200, { ok: true });
  const outcome = await endWebSession(sent.request);
  assert.deepEqual(outcome, { kind: "ended" });
  assert.equal(sent.calls.length, 1);
  assert.equal(sent.calls[0].path, WEB_LOGOUT_PATH);
  assert.equal(WEB_LOGOUT_PATH, "/api/web-logout", "the route the page asks is the one the ingress clears the cookie on");
  assert.equal(sent.calls[0].init.method, "DELETE");
});

test("only the deployment's own 2xx ends the session; every other answer leaves it standing", async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const outcome = await endWebSession(transport(status, { error: "no" }).request);
    assert.equal(outcome.kind, "failed", "HTTP " + status + " was reported as a logout");
    assert.match(outcome.reason, new RegExp(String(status)), "the reason names the status a person has to act on");
  }
});

test("a request that never reached the deployment is a failure, never an ended session", async () => {
  const outcome = await endWebSession(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.reason, /Failed to fetch/);
  // A transport that refuses with nothing to say is still a failure with a reason, not an empty success.
  const silent = await endWebSession(async () => { throw new Error(""); });
  assert.equal(silent.kind, "failed");
  assert.ok(silent.reason.length > 0);
});
