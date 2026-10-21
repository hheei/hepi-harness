import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PROVIDER_LOGIN_POLL_INTERVAL_MS,
  providerAnswerBody,
  providerFlowEnded,
  providerFlowOutcome,
  providerLoginRefusal,
  providerSignInRoute,
  readProviderFlow,
} = await jiti.import("./provider-login.ts");
const { providerFlowView } = await jiti.import("../lib/provider-flow-view.ts");

/**
 * A provider sign-in read by a panel, at its own seam.
 *
 * The flow itself is the execution host's (packages/gateway/src/provider-login.ts) and its OAuth work is the SDK's. What
 * this file owns is the client's half: which path a step is taken on, which answer can be rendered at all, and which
 * sentence a refusal earns. The bug classes held here are the ones that would strand a person mid-sign-in: a flow read
 * as a body that is not one, an ended flow still offered a field, a step a panel has no shape for, or a lost request
 * presented as the deployment's limit.
 */

const flow = (overrides = {}) => ({
  flowId: "8f2f4c1e-0000-4000-8000-000000000001",
  providerId: "anthropic",
  phase: "waiting_for_input",
  waitingFor: ["browser", "input"],
  expiresInMs: 60_000,
  ...overrides,
});

test("a sign-in route names the provider, and names the flow in the query", () => {
  // The path stays the one the capability gate probes, so every poll of one provider is one capability rather than a new
  // one per flow. The id is a query value, and a value that would escape it is encoded rather than trusted.
  assert.equal(providerSignInRoute("anthropic"), "/api/auth/login/anthropic");
  assert.equal(providerSignInRoute("anthropic", "f1"), "/api/auth/login/anthropic?flow=f1");
  assert.equal(providerSignInRoute("open-ai", "a/b?c"), "/api/auth/login/open-ai?flow=a%2Fb%3Fc");
  // An empty id is no flow: the route then means "start one", which is the host's own reading.
  assert.equal(providerSignInRoute("anthropic", ""), "/api/auth/login/anthropic");

  // The answer is a body, never a path segment: a pasted redirect address carries query text of its own.
  const pasted = "http://localhost:53692/callback?code=4tY4Kj7m2QsVbX&state=xyz";
  assert.deepEqual(JSON.parse(providerAnswerBody(pasted)), { answer: pasted });

  assert.ok(PROVIDER_LOGIN_POLL_INTERVAL_MS >= 500, "a panel reads a flow faster than a host can answer it");
});

test("a flow is read only when it is one, and its steps are the host's own", () => {
  const read = readProviderFlow({ success: true, flow: flow() });
  assert.equal(read?.flowId, flow().flowId);
  assert.deepEqual(read?.waitingFor, ["browser", "input"]);

  // A bare flow object, as the host answers it on its own seam.
  assert.equal(readProviderFlow(flow())?.phase, "waiting_for_input");

  // A body that is no flow is no flow: a 204, a proxy's page, or a host that answered something else entirely. A panel
  // that rendered these would show a step nobody can act on.
  for (const broken of [null, undefined, {}, "not json", [], 7, { flow: null }, { flow: {} }]) assert.equal(readProviderFlow(broken), undefined);
  assert.equal(readProviderFlow({ flow: { ...flow(), phase: "authenticated" } }), undefined, "an unknown phase was read as a step");
  assert.equal(readProviderFlow({ flow: { providerId: "x", phase: "running", flowId: "" } }), undefined);

  // A waiting-for list with a kind this surface has no control for is dropped rather than rendered.
  assert.deepEqual(readProviderFlow({ flow: flow({ waitingFor: ["input", "carrier-pigeon"] }) })?.waitingFor, ["input"]);
  // A host that stated none is a flow with nothing offered, not one with everything offered.
  assert.deepEqual(readProviderFlow({ flow: { ...flow(), waitingFor: undefined } })?.waitingFor, []);
});

test("an open question and a statement are shown as the step each one is", () => {
  // The copy-code case: a link stated and a value asked for at once, answered by the field.
  const copyCode = readProviderFlow({ flow: flow({
    prompt: { type: "manual_code", message: "Paste the redirect address", placeholder: "http://localhost:53692/callback?code=…" },
    event: { type: "auth_url", url: "https://claude.ai/oauth/authorize?code_challenge=E9Melhoa&state=abc" },
  }) });
  const step = providerFlowView(copyCode);
  assert.equal(step.kind, "answer");
  assert.equal(step.secret, false);
  assert.match(step.link, /code_challenge=E9Melhoa/, "the authorization address was damaged");
  assert.equal(step.message, "Paste the redirect address");

  // A secret is the same field; the panel's own input decides nothing about it — the host's shape does.
  assert.equal(providerFlowView(readProviderFlow({ flow: flow({ prompt: { type: "secret", message: "Enter your API key to finish" } }) })).secret, true);

  // A select never asks a person to type an id: the options travel with the question.
  const selected = providerFlowView(readProviderFlow({ flow: flow({ prompt: { type: "select", message: "Choose a workspace", options: [{ id: "acc-a", label: "Account A" }, { id: "acc-b", label: "Account B", description: "personal" }] } }) }));
  assert.equal(selected.kind, "select");
  assert.deepEqual(selected.options.map((option) => option.id), ["acc-a", "acc-b"]);

  // A device flow: the code is shown whole, since it is only useful next to the URI a person types it into.
  const device = providerFlowView(readProviderFlow({ flow: flow({ phase: "waiting_for_browser", waitingFor: ["browser"], event: { type: "device_code", userCode: "GQV-GBNN", verificationUri: "https://openai.com/device", intervalSeconds: 5, expiresInSeconds: 900 } }) }));
  assert.equal(device.kind, "device_code");
  assert.equal(device.userCode, "GQV-GBNN");
  assert.equal(device.expiresInSeconds, 900);

  // A browser step with no question open is a link and a sentence.
  const browser = providerFlowView(readProviderFlow({ flow: flow({ phase: "waiting_for_browser", waitingFor: ["browser"], event: { type: "auth_url", url: "https://provider.example/authorize" } }) }));
  assert.equal(browser.kind, "browser");
  assert.equal(browser.link, "https://provider.example/authorize");

  // Nothing to act on: a flow working, or one that stated only a progress line.
  assert.equal(providerFlowView(readProviderFlow({ flow: flow({ phase: "running", waitingFor: [] }) })).kind, "waiting");
  assert.equal(providerFlowView(readProviderFlow({ flow: flow({ event: { type: "progress", message: "Still working" } }) })).kind, "progress");

  // A prompt with no options, or an event of a type this surface has no shape for, is no step rather than a broken one.
  assert.equal(providerFlowView(readProviderFlow({ flow: flow({ prompt: { type: "select", message: "Choose", options: [] } }) })).kind, "waiting");
  assert.equal(providerFlowView(readProviderFlow({ flow: flow({ event: { type: "carrier" } }) })).kind, "waiting");
});

test("a flow is over when it holds nothing open, and its end says which way", () => {
  for (const phase of ["succeeded", "failed", "cancelled", "expired"]) assert.equal(providerFlowEnded(phase), true, phase);
  for (const phase of ["running", "waiting_for_input", "waiting_for_browser"]) assert.equal(providerFlowEnded(phase), false, phase);

  // The one end a panel celebrates, named by the kind the host stored.
  assert.deepEqual(providerFlowOutcome(readProviderFlow({ flow: flow({ phase: "succeeded", waitingFor: [], expiresInMs: 0, storedType: "oauth" }) })), { kind: "stored", storedType: "oauth" });

  // The three that are not faults to retry: the flow is over and the next action is a new sign-in, or none.
  const cancelled = providerFlowOutcome(readProviderFlow({ flow: flow({ phase: "cancelled", waitingFor: [], code: "operation_failed", message: "this sign-in was cancelled" }) }));
  assert.equal(cancelled.kind, "ended");
  assert.equal(cancelled.phase, "cancelled");
  assert.equal(cancelled.key, "models.providerAuth.failed");
  assert.equal(cancelled.detail, "this sign-in was cancelled");

  // An end the host gave no code for still says what happened in its own sentence, rather than an invented reason.
  const bare = providerFlowOutcome(readProviderFlow({ flow: flow({ phase: "expired", waitingFor: [], message: "this sign-in stopped waiting" }) }));
  assert.equal(bare.key, undefined);
  assert.equal(bare.detail, "this sign-in stopped waiting");
});

test("each sign-in refusal names what the person can do next, and a lost answer is never a limit", () => {
  const cases = [
    // The flow this panel followed is gone from the host's memory: nothing to retry, the action is a new sign-in.
    [404, { code: "flow_unknown", error: "no sign-in has that id" }, "models.providerAuth.flowGone", false],
    // The answer arrived while the flow was somewhere else — usually a second window that answered it first.
    [409, { code: "flow_not_waiting", error: "this sign-in is not waiting for an answer" }, "models.providerAuth.flowMoved", false],
    [400, { code: "answer_invalid", error: "that is not an answer this question accepts" }, "models.providerAuth.answerInvalid", false],
    // This host is at its limit for open flows, and the limit clears by itself.
    [429, { code: "too_many_flows", error: "this host already has 1 provider sign-ins open" }, "models.providerAuth.tooMany", true],
    [503, { code: "provider_auth_unreachable", error: "fetch failed" }, "models.providerAuth.unreachable", true],
    [503, { code: "lock_unavailable", error: "another writer is holding auth.json" }, "models.providerAuth.busy", true],
    [503, { code: "permission_denied", error: "this host refused access" }, "models.providerAuth.denied", false],
  ];
  for (const [status, body, key, retry] of cases) {
    const notice = providerLoginRefusal({ status }, body);
    assert.equal(notice.key, key, body.error);
    assert.equal(notice.retry, retry, body.error);
    assert.equal(notice.detail, body.error, "the host's own sentence is kept");
  }

  // The deployment's own named limit reads as the capability gate reads it, which is what keeps sign-in withheld rather
  // than offered and refused on a click.
  const unsupported = providerLoginRefusal({ status: 501 }, { code: "unsupported", error: "this deployment serves no provider sign-in" });
  assert.equal(unsupported.key, "models.providerSignInUnavailable");
  assert.equal(unsupported.retry, false);

  // A 200 is never a refusal, and a body with no code is still a fault with a message rather than a silent failure.
  assert.equal(providerLoginRefusal({ status: 200 }, { flow: flow() }), undefined);
  const bare = providerLoginRefusal({ status: 502 }, "the proxy said no");
  assert.equal(bare.key, undefined);
  assert.equal(bare.detail, "the proxy said no");
  // A request that never arrived is not a statement about this deployment.
  assert.equal(providerLoginRefusal({ status: 0 }, { error: "fetch failed" }).retry, false);
});
