import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PROVIDER_AUTH_ROUTE,
  providerApiKeyBody,
  providerApiKeyRemoveRoute,
  providerApiKeyRoute,
  providerAuthNotice,
  providerAuthRefusal,
  providerConnection,
  readProviderAuthListing,
} = await jiti.import<typeof import("./provider-auth.ts")>("./provider-auth.ts");
const { providerAnswerBody, providerFlowOutcome, providerLoginRefusal, providerSignInRoute, providerSignOutRoute, readProviderFlow } = await jiti.import<typeof import("./provider-login.ts")>("./provider-login.ts");

/**
 * The panel's half of provider connection state, at its own seam.
 *
 * The credential itself is the execution host's business (`packages/gateway/src/provider-auth.ts`); what this file owns is
 * which route a control calls, what a listing row lets the panel offer, and which sentence each refusal earns. These
 * tests hold the three ways that could go wrong: a path that differs between the question and the action, a control
 * offered for a credential this host does not hold, and a fault presented as the deployment's limit.
 */

/** One host row, as the ingress answers it. */
const row = (overrides = {}) => ({
  id: "anthropic",
  name: "Anthropic",
  displayName: "Anthropic",
  configured: false,
  loggedIn: false,
  supportsApiKey: true,
  supportsOAuth: true,
  ...overrides,
});

test("the routes name one provider per path and the key never appears in one", () => {
  // The id is a path segment, so a value that would escape the segment is encoded rather than trusted.
  assert.equal(providerApiKeyRoute("anthropic"), "/api/auth/api-key/anthropic");
  assert.equal(providerApiKeyRoute("openai-codex"), "/api/auth/api-key/openai-codex");
  assert.equal(providerApiKeyRoute("../evil"), "/api/auth/api-key/..%2Fevil");

  // A removal carries the type the listing read, so the host can refuse a stale panel instead of deleting the replacement.
  assert.equal(providerApiKeyRemoveRoute("anthropic"), "/api/auth/api-key/anthropic");
  assert.equal(providerApiKeyRemoveRoute("anthropic", "api_key"), "/api/auth/api-key/anthropic?expectedType=api_key");

  // The key travels in one body and nowhere else: no route, and no query, carries it.
  const body = providerApiKeyBody("sk-ant-secret-value");
  assert.deepEqual(JSON.parse(body), { apiKey: "sk-ant-secret-value" });
  assert.equal(providerApiKeyRoute("anthropic").includes("sk-ant"), false);
  assert.equal(providerApiKeyRemoveRoute("anthropic", "api_key").includes("sk-ant"), false);

  // The listing's route is the capability gate the section is offered by; sign-in is a route of its own, and a sign-out
  // names the account rather than a flow.
  assert.equal(PROVIDER_AUTH_ROUTE, "/api/auth/providers");
  assert.equal(providerSignInRoute("anthropic"), "/api/auth/login/anthropic");
  assert.equal(providerSignOutRoute("anthropic"), "/api/auth/logout/anthropic");

  // An answer travels in one body, never in a path: a pasted redirect address carries query text of its own, which
  // belongs in a body and not in a route.
  const pasted = "http://localhost:53692/callback?code=4tY4Kj7m2QsVbX&state=xyz";
  assert.deepEqual(JSON.parse(providerAnswerBody(pasted)), { answer: pasted });
  assert.equal(providerSignInRoute("anthropic", "f1").includes("4tY4Kj7m"), false);
});

test("a listing row says what the panel may do with this host's credential", () => {
  // Nothing stored: a key may be entered, and there is nothing to disconnect.
  assert.deepEqual(providerConnection(row()), { canEnterKey: true, removable: false });

  // A stored API key: replaceable, removable, and shown only as the hint the host masked.
  assert.deepEqual(providerConnection(row({ configured: true, storedType: "api_key", maskedHint: "sk-a****9012" })), {
    canEnterKey: true,
    removable: true,
    storedType: "api_key",
    maskedHint: "sk-a****9012",
  });

  // Authenticated from the host's own environment: configured, with no key here to remove and the reason stated.
  assert.deepEqual(providerConnection(row({ configured: true, loggedIn: true, source: "ANTHROPIC_API_KEY" })), {
    canEnterKey: true,
    removable: false,
    noteKey: "models.providerAuth.ambient",
  });

  // A stored subscription record: removable, never overwritable with a key this host would not resolve.
  assert.deepEqual(providerConnection(row({ configured: true, loggedIn: true, supportsApiKey: false, storedType: "oauth" })), {
    canEnterKey: false,
    removable: true,
    storedType: "oauth",
    noteKey: "models.providerAuth.oauthStored",
  });

  // A provider the host does not serve at all is no state the panel can show, rather than an invented one.
  assert.equal(providerConnection(undefined), undefined);
});

test("a listing answer is narrowed, and a body that is not one is not a listing", () => {
  const sections = readProviderAuthListing({ oauthProviders: [row()], apiKeyProviders: [row({ configured: true })] });
  assert.equal(sections?.oauthProviders.length, 1);
  assert.equal(sections?.apiKeyProviders[0]?.configured, true);

  // A refusal answers no listing: the caller keeps what it read and names the fault.
  assert.equal(readProviderAuthListing({ code: "provider_auth_unavailable", error: "no host" }), undefined);
  // A body with one section missing is not this surface's answer either — inventing an empty half would read as
  // "this host holds nothing", which is a claim about the credential file nobody made.
  assert.equal(readProviderAuthListing({ apiKeyProviders: [row()] }), undefined);
  for (const broken of [null, undefined, "not json", [], 7]) assert.equal(readProviderAuthListing(broken), undefined);

  // A row that states no id or no configured flag is dropped rather than rendered: an unknown row cannot be acted on.
  assert.equal(readProviderAuthListing({ oauthProviders: [], apiKeyProviders: [{ name: "no id" }] })?.apiKeyProviders.length, 0);

  // A method set stated the older nested way is still understood, so a panel never offers a key field for a provider
  // that declares no key method just because a field moved.
  const nested = readProviderAuthListing({ oauthProviders: [], apiKeyProviders: [{ id: "x", configured: false, methods: { apiKey: false, oauth: true } }] });
  assert.equal(nested?.apiKeyProviders[0]?.supportsApiKey, false);
  assert.equal(nested?.apiKeyProviders[0]?.supportsOAuth, true);
});

test("each refusal names what the person can do next, and a lost answer is never a limit", () => {
  const cases: [string, string, boolean][] = [
    ["provider_auth_unavailable", "models.providerAuth.noHostService", false],
    ["provider_auth_unreachable", "models.providerAuth.unreachable", true],
    ["provider_auth_unauthorized", "models.providerAuth.hostRefused", false],
    ["credential_mismatch", "models.providerAuth.replaced", true],
    ["unknown_provider", "models.providerAuth.unknown", true],
    ["invalid_request", "models.providerAuth.invalid", false],
    ["auth_file_unreadable", "models.providerAuth.fileUnreadable", false],
    ["lock_unavailable", "models.providerAuth.busy", true],
    ["permission_denied", "models.providerAuth.denied", false],
    ["operation_failed", "models.providerAuth.failed", false],
  ];
  for (const [code, key, retry] of cases) {
    const notice = providerAuthNotice(code, "the host's own sentence");
    assert.equal(notice.key, key, code + " mapped to the wrong notice");
    assert.equal(notice.retry, retry, code + " guessed the wrong next action");
    // The host's sentence is kept as the detail, because it names the reason; "an error occurred" would throw it away.
    assert.equal(notice.detail, "the host's own sentence");
  }

  // A code from a host newer than this panel is still a refusal with a message, not a silent failure.
  assert.deepEqual(providerAuthNotice("some_future_code", "reason"), { retry: false, detail: "reason" });
  assert.deepEqual(providerAuthNotice(undefined), { retry: false, detail: "" });
});

test("a refusal is read off the answer this surface wrote, and a 200 never is one", () => {
  assert.equal(providerAuthRefusal({ status: 200 }, { apiKeyProviders: [] }), undefined);

  const mismatch = providerAuthRefusal({ status: 409 }, { success: false, code: "credential_mismatch", error: "left in place" });
  assert.equal(mismatch?.key, "models.providerAuth.replaced");
  assert.equal(mismatch?.retry, true);

  // The whole-deployment limit (501 + `unsupported`) is the capability's own statement: it is never a retryable fault,
  // because asking again would give the same answer.
  const limit = providerAuthRefusal({ status: 501 }, { code: "unsupported", error: "this gateway host serves no provider-auth capability" });
  assert.equal(limit?.key, "models.providerAuthUnavailable");
  assert.equal(limit?.retry, false);
  assert.match(limit?.detail, /no provider-auth capability/);

  // A fault body that is not this shape at all still reports what arrived, and stays retryable-or-not by its own name.
  assert.equal(providerAuthRefusal({ status: 503 }, "the proxy said no")?.detail, "the proxy said no");
});
