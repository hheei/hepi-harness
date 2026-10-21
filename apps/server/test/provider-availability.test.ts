import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { ProviderAuthService, agentDirOf } from "@hepi/gateway";
import { openEnvModelRuntime } from "../src/model-config.ts";
import { loadPiConfig } from "../src/pi-config.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";

/**
 * Model availability after a credential this host did not write, at the seam the ticket states.
 *
 * Ticket 01/02/03 put the credential file on the Gateway account; the Backend owns the model registry. The question this
 * file answers is the one that only exists where those two meet: after this host's `auth.json` gains or loses a
 * credential, does the Backend offer or withdraw the model that credential authenticates — and does answering that
 * require a restart, a refresh route, or a credential reaching the Backend?
 *
 * So the write is the Gateway's own service, over the real wire shape it answers with, and the read is the Backend's own
 * route. Neither is stubbed, and the two processes are deliberately the same one here because that is the deployment the
 * claim is about: one host, one agent directory, one account (`HEPI_CONFIG_SOURCE=pi`, docs/pi-config.md).
 *
 * The provider id is not an SDK built-in. A model the file names with no key of its own is the only shape that makes
 * availability depend on nothing but `auth.json`; the SDK's own providers would also answer from this machine's ambient
 * `*_API_KEY`, which is a fact about the test host and not about this contract. The Gateway serves a catalog naming it,
 * which is the seam `ProviderAuthService` already states for exactly this reason.
 */

const directories: string[] = [];
const token = "provider-availability-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
/** One synthetic key, asserted only as a value that must never come back. */
const KEY = "{{API_KEY_0f3d9b7c2a8e4156}}";
const PROVIDER = "vault";
const MODEL = "vault-1";

after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Fixture = {
  readonly origin: string;
  readonly agentDir: string;
  readonly authPath: string;
  readonly providerAuth: ProviderAuthService;
  readonly catalog: () => Promise<{ status: number; body: { models?: { provider: string; id: string }[]; defaultModel?: unknown } & Record<string, unknown> }>;
};

/** One Backend reading this directory as its registry, beside one Gateway service writing that directory's credentials. */
async function start(t: TestContext, authJson: unknown): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "hepi-provider-availability-"));
  directories.push(base);
  // The agent directory the Backend is pointed at, and the one the Gateway writes: one account, as `agentDirOf` composes
  // it for a local gateway. Nothing here needs them to be the same string by luck.
  const home = join(base, "home");
  await mkdir(home, { recursive: true });
  const agentDir = agentDirOf(home);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: { [PROVIDER]: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: MODEL, name: "Vault One" }] } },
  }), "utf8");
  await writeFile(join(agentDir, "auth.json"), JSON.stringify(authJson), "utf8");

  const config = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: agentDir });
  assert.ok(config, "the Backend loads this directory as its registry");
  const backend: BackendServer = await createBackendServer({
    dbPath: join(base, "backend.sqlite"),
    authToken: token,
    models: config.models,
    defaultModel: config.defaultModel,
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());

  return {
    origin: "http://127.0.0.1:" + address.port,
    agentDir,
    authPath: join(agentDir, "auth.json"),
    providerAuth: new ProviderAuthService({
      agentDir,
      // This host's file is the only thing a listing may answer from: no ambient variable, no credential file elsewhere.
      context: { env: async () => undefined, fileExists: async () => false },
      catalog: async () => [{ id: PROVIDER, name: "Vault", hasApiKey: true, hasOAuth: false }],
    }),
    catalog: async () => {
      const response = await fetch("http://127.0.0.1:" + (backend.server.address() as { port: number }).port + "/api/models", { headers });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
  };
}

/** The ids the Backend offers, as one string, so a withdrawal is as visible as an arrival. */
function offered(body: { models?: { provider: string; id: string }[] }): string {
  return (body.models ?? []).map((model) => model.provider + "/" + model.id).join(",");
}

test("a credential this host's Gateway stores is available to the Backend with no restart and no refresh call", async (t) => {
  const fixture = await start(t, {});

  // Nothing stored: the model the file names is not offered, and the Backend says so rather than failing.
  const before = await fixture.catalog();
  assert.equal(before.status, 200);
  assert.equal(offered(before.body), "", "a catalog model with no credential is not offered");

  // The Gateway stores a key: the write is its own, into its own account's file, and its answer is its own masked listing.
  const stored = await fixture.providerAuth.execute({ operation: "set-key", providerId: PROVIDER, apiKey: KEY });
  assert.equal(stored.ok, true, JSON.stringify(stored));

  // The next read of the Backend's route offers it. Same process, same runtime, no restart and no refresh signal: the
  // Backend's availability pass re-reads the file it was configured with, which is why ticket 04 adds no route.
  const after = await fixture.catalog();
  assert.equal(after.status, 200);
  assert.equal(offered(after.body), PROVIDER + "/" + MODEL, "the stored credential makes the model available");
  assert.ok(!JSON.stringify(after.body).includes(KEY), "the Backend's catalog answer carries no credential value");

  // What the host's file now holds, reported by the service that wrote it. `configured` is deliberately not asserted
  // here: that field is the SDK's own resolution answer, and a provider the SDK does not ship has no resolution to be
  // asked about — which is exactly why this fixture names one (an SDK provider would also authenticate from this
  // machine's ambient `ANTHROPIC_API_KEY`, a fact about the test host rather than about this contract). The file's own
  // state is what `storedType` and the masked hint report, and those are the facts a caller reads back.
  const listing = await fixture.providerAuth.execute({ operation: "list" });
  assert.equal(listing.ok, true);
  const row = listing.ok && listing.value.find((entry) => entry.providerId === PROVIDER);
  assert.equal(row?.storedType, "api_key");
  assert.ok(row?.maskedHint !== undefined, "the host states its key only as a hint it masked on its own machine");
  assert.ok(!JSON.stringify(listing).includes(KEY), "the listing answers no credential value");

  // And a removal withdraws it just as quietly: the Backend's next read stops offering the model.
  const removed = await fixture.providerAuth.execute({ operation: "remove", providerId: PROVIDER, expectedType: "api_key" });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(offered((await fixture.catalog()).body), "", "a removed credential withdraws the model it authenticated");
});

test("a credential replaced by another writer is what the Backend offers next, without duplicating the entry", async (t) => {
  const fixture = await start(t, {});
  await fixture.providerAuth.execute({ operation: "set-key", providerId: PROVIDER, apiKey: KEY });
  const second = await fixture.providerAuth.execute({ operation: "set-key", providerId: PROVIDER, apiKey: "{{API_KEY_9c41be7d5f208a33}}" });
  assert.equal(second.ok, true);

  // One provider, one record: a repeated write replaces the entry the file holds rather than adding a second one the
  // Backend could resolve twice, which is what "availability reflects the changed credential" means at the file.
  const records = JSON.parse(await readFile(fixture.authPath, "utf8")) as Record<string, { type?: string; key?: string }>;
  assert.deepEqual(Object.keys(records), [PROVIDER]);
  assert.equal(records[PROVIDER]?.key, "{{API_KEY_9c41be7d5f208a33}}");
  assert.equal(offered((await fixture.catalog()).body), PROVIDER + "/" + MODEL);
});

/**
 * The other half of the contract, and the half an operator is more likely to meet: an environment-mode Backend reads
 * this file by no means at all. docs/providers.md states it as a property of the mode — credentials live in memory, no
 * `auth.json` is consulted — and the same statement has to hold when the writer is this repository's own Gateway
 * service rather than the pi CLI. If it did not, a stored key would change which models one deployment offers depending
 * on a file that deployment is configured to ignore.
 *
 * So the claim tested here is the absence: the credential is written, is real, is listed by the host that owns it, and
 * the Backend's catalog still does not offer the model it would authenticate. Ticket 04's refresh is not a way to
 * bridge that, and no signal this repository could send would: what decides it is which account the Backend is
 * configured to read (docs/deployment.md).
 */
test("an environment-mode Backend is not made to offer a model by a credential this host's Gateway stores", async (t) => {
  const fixture = await start(t, {});
  const stored = await fixture.providerAuth.execute({ operation: "set-key", providerId: PROVIDER, apiKey: KEY });
  assert.equal(stored.ok, true, JSON.stringify(stored));

  // The same directory, read the other way: an environment-mode runtime over the file this Backend would overlay.
  // An empty environment: whether the credential ends up in this Backend's account must not depend on the machine
  // running the check holding some provider's key.
  const runtime = await openEnvModelRuntime({ agentDir: fixture.agentDir, env: {} });
  const backend = await createBackendServer({
    dbPath: join(fixture.agentDir, "..", "env-backend.sqlite"),
    authToken: token,
    models: runtime,
    defaultModel: null,
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");

  const offered = await (await fetch("http://127.0.0.1:" + (address as { port: number }).port + "/api/models", { headers })).json() as { models?: { provider: string; id: string }[] };
  assert.equal((offered.models ?? []).some((model) => model.provider === PROVIDER), false, "an environment-mode Backend read the stored credential it does not consult");
  assert.ok(!JSON.stringify(offered).includes(KEY), "and answered no credential value either way");

  // The host that wrote it still reports it: the credential is real and this surface is not what hides it.
  const listing = await fixture.providerAuth.execute({ operation: "list" });
  assert.equal(listing.ok && listing.value.find((entry) => entry.providerId === PROVIDER)?.storedType, "api_key");
});

test("a Backend that cannot load the catalog reports it and rolls back nothing the host stored", async (t) => {
  const fixture = await start(t, {});
  const stored = await fixture.providerAuth.execute({ operation: "set-key", providerId: PROVIDER, apiKey: KEY });
  assert.equal(stored.ok, true);
  assert.equal(offered((await fixture.catalog()).body), PROVIDER + "/" + MODEL);

  // The file becomes unreadable to the Backend between two of its reads — the permission of a file another account left
  // behind, not a write of ours: the ticket's other half is that a failed availability read is *stated* and rolls nothing
  // back, which a test that overwrote the file itself could not show.
  const bytesOnDisk = await readFile(fixture.authPath, "utf8");
  chmodSync(fixture.authPath, 0o000);
  let failed;
  try {
    failed = await fixture.catalog();
  } finally {
    chmodSync(fixture.authPath, 0o600);
  }
  assert.equal(failed.status, 500);
  const text = JSON.stringify(failed.body);
  assert.match(failed.body.error as string, /could not be loaded/);
  assert.ok(!text.includes(KEY), "the failure never quotes the stored key");
  assert.ok(!text.includes(fixture.authPath), "the failure never quotes the path it could not read");
  // The failed read changed nothing: the bytes the Gateway wrote are still the bytes on disk.
  assert.equal(await readFile(fixture.authPath, "utf8"), bytesOnDisk, "a Backend that could not read wrote nothing");

  // And the same read succeeds again with no restart and no repair write — the credential was valid storage all along,
  // which is what distinguishes surfacing a failed refresh from rolling back a good one.
  assert.equal(offered((await fixture.catalog()).body), PROVIDER + "/" + MODEL, "a Backend that could not read once reads again");
});
