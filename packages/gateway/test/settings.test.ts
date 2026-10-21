import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { openEnvModelRuntime } from "../../../apps/server/src/model-config.ts";
import { createEchoFauxProvider, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";

/**
 * The settings surface of the client ingress, over real HTTP and a real Backend.
 *
 * These are the public-seam tests for ticket 11's route contract: the settings a Backend owns are forwarded unchanged,
 * and the settings no process owns are named as this deployment's limit instead of being answered as a missing
 * conversation. Every answer asserted here is the Backend's own — the ingress forwards it and the client reads it — so
 * no second projection is being verified.
 *
 * The scoped cache that a client holds these answers in is `@hepi/session/settings`, held at its own seam by
 * `packages/ui/src/lib/models-cache.test.mjs`; this file holds the ingress half only.
 */

const BACKEND_TOKEN = "settings-ingress-backend-token";
const WEB_LOGIN = "settings-ingress-login";
const CREDENTIAL_VAR = "HEPI_SETTINGS_TEST_KEY";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Fixture = { origin: string; backend: BackendServer; ingress: ClientIngress; agentDir: string; close(): Promise<void> };

/** One real Backend owning one catalog and one models.json, behind one client ingress. */
async function start(t: { after(fn: () => unknown): void }): Promise<Fixture> {
  const agentDir = await mkdtemp(join(tmpdir(), "hepi-settings-"));
  directories.push(agentDir);
  const modelsPath = join(agentDir, "models.json");
  await writeFile(modelsPath, "{}");
  process.env[CREDENTIAL_VAR] = "settings-ingress-provider-secret";
  // The Backend's own models.json and the runtime that serves it are one authority: a save is validated on a throwaway
  // runtime and applied to the live one, so a client's next read is the catalog after its own save.
  const runtime = await openEnvModelRuntime({ agentDir, custom: createEchoFauxProvider().provider });
  const backend = await createBackendServer({
    dbPath: join(agentDir, "hepi.sqlite"),
    authToken: BACKEND_TOKEN,
    models: runtime,
    defaultModel: SERVER_MODEL,
    modelConfig: { path: modelsPath, runtime },
    buildId: "build-1",
    backendId: "backend-A",
    accountScope: "account-A",
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN });
  await new Promise<void>((resolve) => ingress.server.listen(0, "127.0.0.1", resolve));
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress !== null && typeof ingressAddress === "object");
  t.after(async () => { await ingress.close(); await backend.close(); });
  return { origin: "http://127.0.0.1:" + ingressAddress.port, backend, ingress, agentDir, close: async () => { await ingress.close(); await backend.close(); } };
}

/** The cookie pair a Web login set, as the browser sends it back. */
async function webSession(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the login response set no cookie");
  const pair = header.split(";")[0]!;
  assert.ok(pair.startsWith(WEB_SESSION_COOKIE + "="));
  return pair;
}

test("the client listener names the settings capabilities it does not serve instead of answering them as missing", async (t) => {
  const target = await start(t);
  const cookie = await webSession(target.origin);
  const headers = { cookie, "content-type": "application/json" };
  // Every one of these is a route the retired Web BFF invented and no Backend owns. Through the ingress they must read
  // as the deployment's own limit — the answer a panel turns into "this build cannot do that" — and not as an unknown
  // conversation, which is what a plain forward would say.
  //
  // Provider credentials and provider sign-in belong to this origin's own host service (see
  // `ingress-providers.test.ts` and `ingress-provider-login.test.ts`), so they are answered locally and never forwarded;
  // this fixture configures no host service at all, which is a named limit of its own rather than an unserved capability.
  const notServed = ["models/enabled", "models/refresh", "models-config/discover", "models-config/test", "models-config/catalog"];
  const hostScoped = ["auth/providers", "auth/api-key/anthropic", "auth/login/anthropic", "auth/logout/anthropic"];
  for (const route of notServed) {
    for (const method of ["GET", "PUT"]) {
      const response = await fetch(target.origin + "/api/" + route, { method, headers });
      assert.equal(response.status, 501, method + " " + route + " was not answered as a named limit");
      const body = await response.json() as { code?: string; error?: string };
      assert.equal(body.code, "unsupported", route + " did not carry the unsupported code");
      assert.ok((body.error ?? "").length > 0, route + " named no reason");
    }
  }
  // A route this ingress answers from its own host is not unserved, it is unconfigured: the caller is told which and
  // how to configure it, which is the difference between hiding a control and showing a field that can only fail.
  for (const route of hostScoped) {
    // One admitted call per route, in the method that route's own operation uses: a listing read, a key write, a sign-in
    // read, a sign-out. All four name the same missing host service, because all four are that host's account.
    const write = route !== "auth/providers" && route !== "auth/login/anthropic";
    const payload = route === "auth/api-key/anthropic" ? { apiKey: "x".repeat(20) } : {};
    const response = await fetch(target.origin + "/api/" + route, { method: write ? "POST" : "GET", headers, ...(write ? { body: JSON.stringify(payload) } : {}) });
    assert.equal(response.status, 503, route + " was not answered as the missing host service it is");
    const body = await response.json() as { code?: string; error?: string };
    assert.equal(body.code, "provider_auth_unavailable", route + " did not name the missing host service");
    assert.match(body.error ?? "", /HEPI_INGRESS_MCP_GATEWAY_URL/, route + " named no configuration to set");
  }
  // An unauthenticated caller is told nothing about capabilities at all: the limit is stated only after the identity
  // check, so a stranger cannot enumerate what this deployment does not do.
  assert.equal((await fetch(target.origin + "/api/auth/providers")).status, 401);
  assert.equal((await fetch(target.origin + "/api/auth/api-key/anthropic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: "x".repeat(20) }) })).status, 401);
  assert.equal((await fetch(target.origin + "/api/auth/login/anthropic")).status, 401);
  assert.equal((await fetch(target.origin + "/api/auth/logout/anthropic", { method: "POST" })).status, 401);
  // The routes the Backend does own are forwarded unchanged: a named limit must not swallow the settings that work.
  for (const route of ["models", "models-config", "extensions", "descriptor"]) {
    assert.equal((await fetch(target.origin + "/api/" + route, { headers })).status, 200, route + " was not forwarded to the Backend");
  }
});

test("the settings a Backend owns are its own answer, and a save is applied to the next read", async (t) => {
  const target = await start(t);
  const cookie = await webSession(target.origin);
  const headers = { cookie, "content-type": "application/json" };
  // The catalog is the Backend's: its own models, and the default it states rather than one the client invents.
  const catalog = await (await fetch(target.origin + "/api/models", { headers })).json() as { models: { provider: string; id: string }[]; defaultModel: unknown };
  assert.deepEqual(catalog.models.map((model) => model.provider + ":" + model.id), ["faux:faux-1"]);
  assert.deepEqual(catalog.defaultModel, SERVER_MODEL);

  // The descriptor is where a client's settings cache gets its scope, and it is the Backend's own identity.
  const descriptor = await (await fetch(target.origin + "/api/descriptor", { headers })).json() as { backend: { id: string }; account: { scope: string } };
  assert.deepEqual(descriptor.backend, { id: "backend-A" });
  assert.deepEqual(descriptor.account, { scope: "account-A" });

  // models.json is the Backend's file: an unedited round trip keeps what it read, and a rejected draft changes nothing.
  const file = await (await fetch(target.origin + "/api/models-config", { headers })).json() as { providers?: Record<string, unknown> };
  const roundTrip = await fetch(target.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ ...file, providers: { ...file.providers, beta: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "$" + CREDENTIAL_VAR, models: [{ id: "beta-1" }] } } }) });
  assert.equal(roundTrip.status, 200);
  assert.deepEqual(await roundTrip.json(), { success: true, applied: true });
  const stored = await (await fetch(target.origin + "/api/models-config", { headers })).json() as { providers: Record<string, { apiKey?: string }> };
  assert.deepEqual(Object.keys(stored.providers), ["beta"]);
  assert.equal(stored.providers.beta?.apiKey, "$" + CREDENTIAL_VAR, "the credential reference was not kept as the operator wrote it");
  assert.ok(!JSON.stringify(stored).includes("settings-ingress-provider-secret"), "the resolved credential value reached the client");

  const rejected = await fetch(target.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { beta: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "beta-1", contextWindow: 0 }] } } }) });
  assert.equal(rejected.status, 400);
  const refusal = await rejected.json() as { success: boolean; error: string };
  assert.equal(refusal.success, false);
  assert.match(refusal.error, /contextWindow/);
  assert.deepEqual(Object.keys((await (await fetch(target.origin + "/api/models-config", { headers })).json() as { providers: Record<string, unknown> }).providers), ["beta"], "a rejected draft changed the file");

  // The extension inventory and its global default are the Backend's too, forwarded with their own status codes.
  const extensions = await fetch(target.origin + "/api/extensions", { headers });
  assert.equal(extensions.status, 200);
  const inventory = await extensions.json() as { installed?: unknown; selection?: unknown };
  assert.ok(Array.isArray(inventory.installed), "the extension inventory did not state its installed set");
  assert.equal((await fetch(target.origin + "/api/extensions", { method: "POST", headers, body: JSON.stringify({ extensions: ["ghost-extension"] }) })).status, 400);
});

test("one conversation's model and thinking level are that conversation's own settings", async (t) => {
  const target = await start(t);
  const cookie = await webSession(target.origin);
  const headers = { cookie, "content-type": "application/json" };
  const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: "{}" });
  assert.equal(created.status, 201);
  const conversationId = ((await created.json()) as { conversationId: string }).conversationId;
  const other = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: "{}" });
  const otherId = ((await other.json()) as { conversationId: string }).conversationId;

  const settings = await (await fetch(target.origin + "/api/conversations/" + conversationId + "/settings", { headers })).json() as { model: unknown; thinkingLevel: string };
  assert.deepEqual(settings.model, SERVER_MODEL);
  assert.equal(settings.thinkingLevel, "off");

  // A model this deployment does not offer is refused, and the conversation keeps the model it had: the recovery a
  // client needs is "pick another", not "start over".
  const unknown = await fetch(target.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: "ghost", modelId: "ghost-1" } }) });
  assert.equal(unknown.status, 400);
  assert.deepEqual((await (await fetch(target.origin + "/api/conversations/" + conversationId + "/settings", { headers })).json() as { model: unknown }).model, SERVER_MODEL);

  // A thinking level is this conversation's own: the sibling keeps its own, so a pick cannot leak across a switch.
  const levelled = await fetch(target.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ thinkingLevel: "high" }) });
  assert.equal(levelled.status, 200);
  assert.equal(((await levelled.json()) as { thinkingLevel: string }).thinkingLevel, "high");
  assert.equal(((await (await fetch(target.origin + "/api/conversations/" + otherId + "/settings", { headers })).json()) as { thinkingLevel: string }).thinkingLevel, "off", "a thinking level leaked to another conversation");
  assert.equal((await fetch(target.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ thinkingLevel: "ludicrous" }) })).status, 400);
});

test("no settings answer carries a server credential or echoes the ingress's own identity header", async (t) => {
  const target = await start(t);
  const cookie = await webSession(target.origin);
  const headers = { cookie, "content-type": "application/json" };
  const created = await fetch(target.origin + "/api/conversations", { method: "POST", headers, body: "{}" });
  const conversationId = ((await created.json()) as { conversationId: string }).conversationId;
  const materials = [BACKEND_TOKEN, WEB_LOGIN];
  const assertNoMaterial = (route: string, text: string): void => {
    for (const material of materials) assert.ok(!text.includes(material), route + " carried " + material);
    assert.doesNotMatch(text, /x-hepi-client/i, route + " echoed the ingress's own identity header");
  };
  for (const route of ["/api/descriptor", "/api/models", "/api/models-config", "/api/extensions", "/api/conversations/" + conversationId + "/settings"]) {
    const response = await fetch(target.origin + route, { headers });
    assert.equal(response.status, 200, route);
    assertNoMaterial(route, await response.text());
  }
  // A refusal is a fixed sentence rather than the bytes the reader could not parse, which may include a credential.
  await writeFile(join(target.agentDir, "models.json"), "{ \"providers\": LITERAL-PROVIDER-KEY");
  const unreadable = await fetch(target.origin + "/api/models-config", { headers });
  assert.equal(unreadable.status, 500);
  const text = await unreadable.text();
  assertNoMaterial("/api/models-config (unreadable)", text);
  assert.doesNotMatch(text, /LITERAL-PROVIDER-KEY/);
  assert.match(await readFile(join(target.agentDir, "models.json"), "utf8"), /LITERAL-PROVIDER-KEY/);
});
