import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { capabilityNoticeKey, capabilityServed, unsupportedCapability } = await jiti.import<typeof import("./capability-availability.ts")>("./capability-availability.ts");
const { createClient } = await jiti.import<typeof import("../client.ts")>("../client.ts");

/**
 * The one rule a settings control is offered by, at its public seam.
 *
 * A capability this deployment does not serve must be withheld, and a request that never arrived must not be read as
 * that limit: the two answers look alike only if a panel treats "I could not ask" as "they said no". These tests hold the
 * distinction the panel's own text and controls both depend on, and hold the composer's two stars to it.
 *
 * The question is asked through the connection's own transport, so the deployment it is asked of is the connection the
 * control would write to. That is asserted here by handing the rule the request a connection hands out and by refusing
 * the page's own `fetch` outright: a question that fell back to the document's origin would fail rather than pass.
 */
test("a panel withholds its control only for the deployment's explicit refusal", () => {
  assert.equal(capabilityNoticeKey(false, "models.defaultUnavailable"), "models.defaultUnavailable");
  assert.equal(capabilityNoticeKey(true, "models.defaultUnavailable"), undefined);
  // Unknown reads as "not confirmed", never as the deployment's own limit.
  assert.equal(capabilityNoticeKey(null, "models.defaultUnavailable"), "settings.capabilityUnknown");
});

test("a refusal already read off an answer is recognized in the same shape", () => {
  assert.equal(unsupportedCapability({ status: 501 }, { code: "unsupported", error: "not served" }), "not served");
  assert.equal(unsupportedCapability({ status: 501 }, { error: "gateway exploded" }), null);
  assert.equal(unsupportedCapability({ status: 200 }, { code: "unsupported" }), null);
});

test("the capability question is asked through the connection's own request, and reads its three answers", async () => {
  // The page's own origin is not a transport this rule may use: any relative fetch would land here.
  const pageFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the capability question left the connection"); };
  try {
    const asked: { url: string; accept: string | null }[] = [];
    const answerFor = (status: number, body: unknown) => async (url: unknown, init?: RequestInit) => {
      asked.push({ url: String(url), accept: new Headers(init?.headers).get("accept") });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
    const connectionOf = (transport: typeof fetch) => createClient({
      origin: "https://gateway.example",
      credential: { kind: "bearer", token: "device" },
      fetch: transport,
      createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
    });

    const served = connectionOf(answerFor(200, { ok: true }));
    assert.equal(await capabilityServed(served.request, "/api/models-config/discover"), true, "a served route is the deployment's own yes");

    const limited = connectionOf(answerFor(501, { code: "unsupported", error: "not served" }));
    assert.equal(await capabilityServed(limited.request, "/api/models-config/discover"), false, "the explicit unsupported reply is the deployment's own no");

    // A request that never arrived is not an answer about the deployment, whichever way it failed.
    const lost = connectionOf(async () => { throw new TypeError("fetch failed"); });
    assert.equal(await capabilityServed(lost.request, "/api/models-config/discover"), null, "a lost request is unknown, not a limit");

    // The question and the action name one surface: the path the control itself calls, on the connection's origin, with
    // the credential that connection presents.
    assert.deepEqual(asked, [
      { url: "https://gateway.example/api/models-config/discover", accept: "application/json" },
      { url: "https://gateway.example/api/models-config/discover", accept: "application/json" },
    ]);
    // A disposed connection sends nothing, so its capability reads as unknown rather than as the deployment's answer.
    assert.equal(served.disposed, false);
    served.dispose();
    const before = asked.length;
    assert.equal(await capabilityServed(served.request, "/api/models-config/discover"), null, "a disposed connection asks nothing");
    assert.equal(asked.length, before, "and its transport was not reached");
  } finally {
    globalThis.fetch = pageFetch;
  }
});
