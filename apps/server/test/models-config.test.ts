import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openEnvModelRuntime, readModelConfig, saveModelConfig, serializeModelConfig, type ModelConfigTarget } from "../src/model-config.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const PROVIDER = "magpie";
const MODEL = "deepseek-v4.1-flash";
const API_KEY_VAR = "HEPI_PROVIDER_API_KEY";
const token = "models-config-token";

type Captured = { authorization: string | undefined; model: unknown };
type Controlled = { origin: string; requests: Captured[] };

/** One OpenAI-completions endpoint that records what actually reached it, so a saved endpoint is proven by traffic. */
async function controlledEndpoint(t: TestContext): Promise<Controlled> {
  const requests: Captured[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Only a real completions call is recorded; anything else is answered as not found rather than parsed as JSON,
      // so the recorded requests are exactly the model traffic.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      requests.push({ authorization: request.headers.authorization, model: body.model });
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: "http://127.0.0.1:" + address.port, requests };
}

/** The environment-owned provider the deployment configures: alias, endpoint and an environment credential reference. */
function envProvider(origin: string): Provider {
  return createProvider({
    id: PROVIDER,
    name: PROVIDER,
    baseUrl: origin + "/v1",
    auth: { apiKey: envApiKeyAuth(PROVIDER + " API key", [API_KEY_VAR]) },
    models: [{ id: MODEL, name: MODEL, api: "openai-completions", provider: PROVIDER, baseUrl: origin + "/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    api: openAICompletionsApi(),
  });
}

async function agentDirectory(_t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-models-config-"));
  directories.push(directory);
  return directory;
}

async function startBackend(t: TestContext, agentDir: string, runtime: ModelRuntime): Promise<{ origin: string; backend: BackendServer }> {
  const backend = await createBackendServer({ dbPath: join(agentDir, "models-config.sqlite"), authToken: token, models: runtime, defaultModel: { provider: PROVIDER, modelId: MODEL }, modelConfig: { path: join(agentDir, "models.json"), runtime } });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { origin: "http://127.0.0.1:" + address.port, backend };
}

const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

/** One entry of the window these tests read off the wire. */
type Entry = { role: string; text: string };
/** One SSE frame as the reader received it, beside the window every frame so far folds into. */
type Observed = { event: string; data: unknown; window: HeldWindow<Entry> };

/**
 * One conversation's event stream, folded the way a client folds it, and the barrier every wait in this file uses.
 *
 * `follow` resolves on the frame the backend itself wrote once its condition holds, so a turn is waited for by its own
 * publication rather than by a sleep that hopes the turn has finished. The connection carries its own bound, which
 * turns a stream that goes quiet into a failure instead of a hang; that bound is a property of the transport and never
 * a delay the passing path spends.
 */
async function openStream(origin: string, id: string): Promise<{ follow: (match: (frame: Observed) => boolean, description: string) => Promise<Observed>; close: () => Promise<void> }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "the conversation stream is attached");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  let pending = "";
  return {
    async follow(match, description) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the event stream ended before " + description);
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const line = raw.split("\n").find(value => value.startsWith("data: "));
          if (event === undefined || line === undefined) continue;
          const data: unknown = JSON.parse(line.slice(6));
          // A submission lifecycle frame folds into nothing: the window a predicate reads is the window the client
          // holds at that frame, so a lifecycle fact never has to be inferred from a later read.
          if (event === "snapshot" || event === "state") folder.fold(event, data);
          const frame: Observed = { event, data, window: folder.current() };
          if (match(frame)) return frame;
        }
      }
    },
    async close() { await reader.cancel().catch(() => {}); },
  };
}

/**
 * The frame that states a turn is over: no run in flight and the entries the turn committed are in the window. `appended`
 * is what this turn must have added, so a frame that was already held before the submit can never satisfy it.
 */
const idleAfter = (before: HeldWindow<Entry>, appended: number) => (frame: Observed): boolean =>
  (frame.event === "state" || frame.event === "snapshot") && !frame.window.busy && frame.window.entries.length >= before.entries.length + appended;

/** One turn through the real HTTP surface, settling on the assistant reply the controlled endpoint streamed. */
async function ask(origin: string, text: string, conversationId?: string): Promise<void> {
  const id = conversationId ?? ((await (await fetch(origin + "/api/conversations", { method: "POST", headers })).json() as { conversationId: string }).conversationId);
  const stream = await openStream(origin, id);
  try {
    // The baseline is read before the turn exists, so the settled frame below cannot be one this client already held.
    const before = await stream.follow((frame) => frame.event === "snapshot", "the baseline snapshot");
    const submitted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text }) });
    assert.equal(submitted.status, 202);
    await stream.follow((frame) => idleAfter(before.window, 2)(frame) && frame.window.entries.some((entry) => entry.role === "assistant" && entry.text === "ok"), "the assistant reply to " + JSON.stringify(text));
  } finally { await stream.close(); }
}

function draft(baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { providers: { [PROVIDER]: { baseUrl, api: "openai-completions", apiKey: "$" + API_KEY_VAR, models: [{ id: MODEL }], ...extra } } };
}

test("the editor reads and writes the backend's own models.json", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  const { origin } = await startBackend(t, agentDir, runtime);

  // No file yet: the editor gets an empty catalog, not the environment deployment dressed up as a file entry. The
  // environment provider is an in-memory base layer, so nothing here pretends it was persisted.
  const empty = await fetch(origin + "/api/models-config", { headers });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { providers: {} });
  assert.equal(existsSync(join(agentDir, "models.json")), false, "reading does not create the file");

  const saved = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify(draft(endpoint.origin + "/v2")) });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { success: true, applied: true });
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")), draft(endpoint.origin + "/v2"));
  assert.deepEqual(await (await fetch(origin + "/api/models-config", { headers })).json(), draft(endpoint.origin + "/v2"));
});

test("a saved configuration reaches the next request and survives a restart", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const first = await controlledEndpoint(t);
  const second = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(first.origin) });
  const started = await startBackend(t, agentDir, runtime);

  await ask(started.origin, "before-save");
  assert.equal(first.requests.length, 1, "the environment endpoint served the first request");
  assert.equal(first.requests[0]?.authorization, "Bearer env-key");
  assert.equal(first.requests[0]?.model, MODEL);

  const saved = await fetch(started.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify(draft(second.origin + "/v1")) });
  assert.deepEqual(await saved.json(), { success: true, applied: true });
  await started.backend.close();

  // A restart re-applies the environment provider and then reads the saved file, so the saved endpoint still wins.
  const restarted = await openEnvModelRuntime({ agentDir, custom: envProvider(first.origin) });
  const restartedServer = await startBackend(t, agentDir, restarted);
  await ask(restartedServer.origin, "after-restart");
  assert.equal(second.requests.length, 1, "the saved endpoint served the request after the restart");
  assert.equal(first.requests.length, 1, "the environment endpoint was not used again");

  // The file layer is an override, not the owner of the environment deployment: removing it restores the environment
  // endpoint. This is not a deletion of the environment provider, which stays registered as the base layer.
  const cleared = await fetch(restartedServer.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: {} }) });
  assert.deepEqual(await cleared.json(), { success: true, applied: true });
  await ask(restartedServer.origin, "after-clear");
  assert.equal(first.requests.length, 2, "the environment endpoint serves again once the file override is removed");
  assert.ok(restarted.getModel(PROVIDER, MODEL), "the environment-owned base model is still present, not deleted");
});

test("a rejected draft leaves the file and the running runtime untouched, without echoing values", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  const { origin } = await startBackend(t, agentDir, runtime);

  const original = JSON.stringify(draft(endpoint.origin + "/saved"));
  await writeFile(join(agentDir, "models.json"), original);

  // A schema error: the message names the offending path, never the secret the draft also carried. (A partial cost
  // group is not an error: the editor completes it with zero, which the save below exercises.)
  const rejected = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { [PROVIDER]: { baseUrl: endpoint.origin + "/v1", api: "openai-completions", apiKey: "SUPER-SECRET-KEY", models: [{ id: MODEL, contextWindow: 0 }] } } }) });
  assert.equal(rejected.status, 400);
  const body = await rejected.json() as { success: boolean; error: string };
  assert.equal(body.success, false);
  assert.match(body.error, /contextWindow/);
  assert.doesNotMatch(JSON.stringify(body), /SUPER-SECRET-KEY/);
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), original, "the file is byte-identical after a rejected save");

  // A provider definition the composer cannot use is rejected on the same path. (Omitting baseUrl on the deployment's
  // own alias is not such a case: the environment base layer supplies the endpoint, which is the override contract.)
  const uncomposable = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { ghost: { api: "openai-completions", models: [{ id: "ghost-1" }] } } }) });
  assert.equal(uncomposable.status, 400);
  assert.match((await uncomposable.json() as { error: string }).error, /baseUrl/);
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), original);

  // A malformed cost group is the caller's mistake, not something the serializer repairs: a string, an array, and a
  // known rate that is not a finite number are all rejected by the loader, so the draft never reaches the file and the
  // running runtime keeps serving. Repairing these would let a draft the operator cannot read replace a working file.
  for (const cost of ["SUPER-SECRET-COST", ["input", 1], { input: "not-a-number", output: 1, cacheRead: 1, cacheWrite: 1 }, { unknownRate: 1 }]) {
    const rejectedCost = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { [PROVIDER]: { baseUrl: endpoint.origin + "/v1", api: "openai-completions", apiKey: "$" + API_KEY_VAR, models: [{ id: MODEL, cost }] } } }) });
    assert.equal(rejectedCost.status, 400, "a malformed cost group is refused: " + JSON.stringify(cost));
    assert.equal((await rejectedCost.json() as { success: boolean }).success, false);
    assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), original, "the file is untouched by a malformed cost group");
  }

  // A partial cost group of known finite rates is completed with zero rather than rejected, matching the editor. The
  // distinction is the whole rule: a group the editor model can express is completed, one it cannot is refused.
  const completed = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { [PROVIDER]: { baseUrl: endpoint.origin + "/v1", api: "openai-completions", apiKey: "$" + API_KEY_VAR, models: [{ id: MODEL, cost: { input: 1 } }] } } }) });
  assert.equal(completed.status, 200);
  assert.deepEqual((JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")) as { providers: { magpie: { models: { cost: unknown }[] } } }).providers.magpie.models[0]?.cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });

  // The live runtime still serves the saved endpoint, so none of those rejections changed anything about running work.
  await ask(origin, "after-rejection");
  assert.equal(endpoint.requests.length, 1);
});

test("a malformed models.json is reported as unusable and cannot be overwritten by a draft", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  const { origin } = await startBackend(t, agentDir, runtime);
  const broken = "{ \"providers\": SECRET-abc";
  await writeFile(join(agentDir, "models.json"), broken);

  const read = await fetch(origin + "/api/models-config", { headers });
  assert.equal(read.status, 500);
  assert.doesNotMatch(JSON.stringify(await read.json()), /SECRET-abc/);
  assert.equal(readModelConfigThrows(join(agentDir, "models.json")), true, "the reader refuses the file");
  assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), broken);
});

function readModelConfigThrows(path: string): boolean {
  try { readModelConfig(path); return false; } catch { return true; }
}

test("a command credential in a draft never runs during validation or save", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const marker = join(agentDir, "command-ran");
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  const { origin } = await startBackend(t, agentDir, runtime);

  const saved = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify(draft(endpoint.origin + "/v1", { apiKey: "!touch " + marker })) });
  assert.equal(saved.status, 200);
  // The save's own completion is the proof: validation and the live refresh have both finished, and no command ran.
  // No sleep is involved, so a slower machine cannot turn this into a pass by finishing late.
  assert.equal(existsSync(marker), false, "saving a configuration never executes its credential command");
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "models.json"), "utf8")), JSON.parse(JSON.stringify(draft(endpoint.origin + "/v1", { apiKey: "!touch " + marker }))), "the command reference is persisted as written");
});

test("environment mode keeps credentials in memory and never reads the agent directory's auth.json", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  // A stored credential for another provider must not become available just because a file names it.
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ vault: { type: "api_key", key: "stored-key" } }));
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  assert.equal(runtime.getModel("vault", "anything"), undefined);
  assert.equal(runtime.getProviderAuthStatus("vault").configured, false, "no stored credential is read in environment mode");
  assert.equal(runtime.getProviderAuthStatus(PROVIDER).configured, true);
  assert.deepEqual((await readdir(agentDir)).sort(), ["auth.json"], "no models-store.json is created");
});

test("a save that cannot be applied reports saved-but-not-applied instead of success", async () => {
  const failing = { refresh: async () => { throw new Error("runtime unavailable"); }, getRegisteredProviderIds: () => [] } as unknown as ModelRuntime;
  const target: ModelConfigTarget = { path: join(tmpdir(), "hepi-unapplied-" + Date.now(), "models.json"), runtime: failing };
  const result = await saveModelConfig(target, draft("http://127.0.0.1:1/v1"));
  assert.deepEqual(result, { status: "saved", applied: false, error: "the saved models.json could not be applied" });
  await rm(join(target.path, ".."), { recursive: true, force: true });
});

test("models.json reads accept the BOM, comments and trailing commas the upstream loader accepts", async (t) => {
  const agentDir = await agentDirectory(t);
  const path = join(agentDir, "models.json");
  await writeFile(path, "\uFEFF{\n  // Hand-edited provider\n  \"providers\": {\n    \"acme\": { \"baseUrl\": \"https://models.example.test/v1\", \"apiKey\": \"key,}\", \"models\": [{ \"id\": \"acme-2\", }] },\n  },\n}\n");
  assert.deepEqual(readModelConfig(path), { providers: { acme: { baseUrl: "https://models.example.test/v1", apiKey: "key,}", models: [{ id: "acme-2" }] } } });

  // A blank file is no providers, not an error; a file that does not parse is unusable and its bytes are never echoed.
  await writeFile(path, "\n");
  assert.deepEqual(readModelConfig(path), { providers: {} });
  await writeFile(path, "{ SECRET-abc");
  assert.throws(() => readModelConfig(path), (error: Error) => !error.message.includes("SECRET-abc"));
  assert.deepEqual(readModelConfig(join(agentDir, "missing.json")), { providers: {} }, "a missing file is no providers, not an error");
});

test("a saved models.json is written with private permissions", async (t) => {
  if (process.platform === "win32") return;
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  const { origin } = await startBackend(t, agentDir, runtime);
  const path = join(agentDir, "models.json");
  assert.equal((await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify(draft(endpoint.origin + "/v1")) })).status, 200);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(agentDir)).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
});

test("serializeModelConfig completes a partial cost group, drops an empty one and keeps a malformed one as written", () => {
  const text = serializeModelConfig({ providers: { acme: { baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "a", cost: { input: 1 } }, { id: "empty", cost: {} }, { id: "malformed", cost: "SECRET-COST" }, { id: "  " }, { id: 7 }] } } });
  assert.deepEqual(JSON.parse(text), { providers: { acme: { baseUrl: "http://x/v1", api: "openai-completions", models: [{ id: "a", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { id: "empty" }, { id: "malformed", cost: "SECRET-COST" }, { id: 7 }] } } });
});
test("an unconfigured environment deployment offers no model and no default", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  // The deployment configures no provider, writes no models.json and names no default. The offline scripted provider is
  // a test fixture and is never a production fallback, so the catalog is empty and states no default, and a request
  // settles natively as no_model instead of being answered by a model the operator never configured. The conversation
  // is not stuck: saving a provider and selecting one of its models serves the next turn.
  const runtime = await openEnvModelRuntime({ agentDir });
  const backend = await createBackendServer({ dbPath: join(agentDir, "empty-env.sqlite"), authToken: token, models: runtime, modelConfig: { path: join(agentDir, "models.json"), runtime } });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(() => backend.close());

  const catalog = await (await fetch(origin + "/api/models", { headers })).json() as { defaultModel: { provider: string; modelId: string } | null; models: { provider: string; id: string }[] };
  assert.equal(catalog.defaultModel, null, "no model is configured, so no default is stated");
  assert.deepEqual(catalog.models, [], "no provider is configured, so no model is offered");

  const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers })).json() as { conversationId: string };
  const stream = await openStream(origin, created.conversationId);
  let roles: string[] = [];
  try {
    // The baseline is read before the turn exists, so neither barrier below can be a frame this client already held.
    const before = await stream.follow((frame) => frame.event === "snapshot", "the baseline snapshot");
    const submitted = await fetch(origin + "/api/conversations/" + created.conversationId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "empty-env", text: "hello" }) });
    assert.equal(submitted.status, 202, "the request is admitted; the missing model is the framework's failure, not a refused command");
    // The settlement is the lifecycle frame the run itself publishes, and the state that reflects it is read after it,
    // so the turn's end is a fact the backend stated rather than an idle read that could precede the run.
    await stream.follow((frame) => frame.event === "submission" && String((frame.data as { requestId?: unknown }).requestId) === "empty-env" && (frame.data as { status?: unknown }).status === "unanswered", "the native no_model settlement");
    const settled = await stream.follow(idleAfter(before.window, 1), "the state that reflects the settlement");
    roles = settled.window.entries.map((entry) => entry.role);
  } finally { await stream.close(); }
  assert.deepEqual(roles, ["user"], "no scripted reply stands in for the missing model");
  const reported = await (await fetch(origin + "/api/conversations/" + created.conversationId + "/state", { headers })).json() as { settings: { model: unknown } };
  assert.equal(reported.settings.model, null, "the conversation reports no selected model, not a fabricated one");
  assert.equal(endpoint.requests.length, 0, "no request was made without a model");

  // Recovery is the operator's own configuration: a saved provider and an explicit selection serve the next turn.
  const saved = await fetch(origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify(draft(endpoint.origin + "/v1")) });
  assert.deepEqual(await saved.json(), { success: true, applied: true });
  const selected = await fetch(origin + "/api/conversations/" + created.conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: PROVIDER, modelId: MODEL } }) });
  assert.equal(selected.status, 200);
  await ask(origin, "after-configuration", created.conversationId);
  assert.equal(endpoint.requests.length, 1, "the configured provider serves the recovered conversation");
});

test("a conversation without an available model settles natively and stays recoverable", async (t) => {
  const agentDir = await agentDirectory(t);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: envProvider(endpoint.origin) });
  // No configured default at all: the backend still boots, and its settings API is reachable.
  const backend = await createBackendServer({ dbPath: join(agentDir, "no-model.sqlite"), authToken: token, models: runtime, defaultModel: null, modelConfig: { path: join(agentDir, "models.json"), runtime } });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  t.after(() => backend.close());

  assert.equal((await fetch(origin + "/api/models-config", { headers })).status, 200, "the settings API is reachable without a default model");
  // The public catalog states the same thing the configuration does: no default model at all, and no manufactured faux
  // entry standing in for one. A client that sees a default here would offer a model this backend was never asked to
  // serve, and the conversation's own selection would disagree with it.
  const catalog = await (await fetch(origin + "/api/models", { headers })).json() as { defaultModel: unknown; models: { provider: string }[] };
  assert.equal(catalog.defaultModel, null, "the catalog reports no default instead of a fabricated faux reference");
  assert.equal(catalog.models.some((model) => model.provider === "faux"), false, "no faux model is offered");

  const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers })).json() as { conversationId: string };
  const stream = await openStream(origin, created.conversationId);
  try {
    // The baseline is read before the turn exists, so neither barrier below can be a frame this client already held.
    const before = await stream.follow((frame) => frame.event === "snapshot", "the baseline snapshot");
    const submitted = await fetch(origin + "/api/conversations/" + created.conversationId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "no-model", text: "hello" }) });
    assert.equal(submitted.status, 202, "the request is admitted; the failure is the framework's, not a rejected command");
    // The settlement is the lifecycle frame the run itself publishes, and the state that reflects it is read after it,
    // so the turn's end is a fact the backend stated rather than an idle read that could precede the run.
    await stream.follow((frame) => frame.event === "submission" && String((frame.data as { requestId?: unknown }).requestId) === "no-model" && (frame.data as { status?: unknown }).status === "unanswered", "the native no_model settlement");
    const settled = await stream.follow(idleAfter(before.window, 1), "the state that reflects the settlement");
    assert.deepEqual(settled.window.entries.map((entry) => entry.role), ["user"], "the failure is never disguised as an assistant reply");
  } finally { await stream.close(); }
  const reported = await (await fetch(origin + "/api/conversations/" + created.conversationId + "/state", { headers })).json() as { settings: { model: unknown } };
  assert.equal(reported.settings.model, null, "the conversation reports no selected model, not a fabricated one");
  assert.equal(endpoint.requests.length, 0, "no request was made without a model");

  // The conversation is not stuck: an explicit selection is accepted and the next request is served normally.
  const patched = await fetch(origin + "/api/conversations/" + created.conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: PROVIDER, modelId: MODEL } }) });
  assert.equal(patched.status, 200);
  await ask(origin, "after-reselection", created.conversationId);
  assert.equal(endpoint.requests.length, 1);
});
