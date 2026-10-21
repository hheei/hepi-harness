import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openEnvModelRuntime } from "../src/model-config.ts";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The deployment's own alias, registered from the environment on every boot and never written to models.json. */
const ENV_PROVIDER = "magpie";
const ENV_MODEL = "deepseek-v4.1-flash";
/** A model only models.json owns, so removing its file entry really removes the model. */
const FILE_PROVIDER = "fileonly";
const FILE_MODEL = "ephemeral-1";
const API_KEY_VAR = "HEPI_PROVIDER_API_KEY";
const token = "missing-model-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

type Controlled = { origin: string; requests: { model: unknown }[]; failNext: () => void };

/** One OpenAI-completions endpoint. It records only real completions calls, so an empty list means no traffic at all. */
async function controlledEndpoint(t: TestContext): Promise<Controlled> {
  const requests: { model: unknown }[] = [];
  let failures = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      requests.push({ model: body.model });
      if (failures > 0) { failures -= 1; response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "the provider refused this request" } })); return; }
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: "http://127.0.0.1:" + address.port, requests, failNext: () => { failures += 1; } };
}

/** One provider over the controlled endpoint: the environment alias and the file-owned model both reach it. */
function providerOf(id: string, modelId: string, origin: string): Provider {
  return createProvider({
    id,
    name: id,
    baseUrl: origin + "/v1",
    auth: { apiKey: envApiKeyAuth(id + " API key", [API_KEY_VAR]) },
    models: [{ id: modelId, name: modelId, api: "openai-completions", provider: id, baseUrl: origin + "/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
    api: openAICompletionsApi(),
  });
}

type State = { busy: boolean; entries: { role: string; text: string }[]; settings: { model: { provider: string; modelId: string } | null }; failure: { reason: string; message: string } | null };

async function stateOf(origin: string, id: string): Promise<State> {
  return await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json() as State;
}

type Entry = ServerSnapshot["entries"][number];
/**
 * A settled turn as a client holds it: the folded window beside the scalars the frame that stated it carried. The
 * reducer spreads the frame it folded, so the snapshot's own scalars — the framework's failure and the selection among
 * them — ride the folded window, and this is the type that says which ones a test reads.
 */
type Held = HeldWindow<Entry> & Pick<ServerSnapshot, "failure" | "settings">;
/** One frame as a client receives it: the event, its own payload, and the state a client holds after folding it. */
type Observed = { readonly event: string; readonly data: unknown; readonly window: Held };

/**
 * One conversation's event stream, read the way a client reads it: the frames as they arrive, folded through the shared
 * reducer. A wait is therefore the frame that states the fact — nothing is polled and nothing is slept on.
 *
 * The connection carries its own bound, so a stream that goes quiet fails the test instead of hanging it.
 */
async function openStream(origin: string, id: string): Promise<{ follow: (match: (frame: Observed) => boolean, description: string) => Promise<Observed>; close: () => Promise<void> }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  const frames: Observed[] = [];
  let pending = "";
  return {
    async follow(match, description) {
      while (true) {
        const found = frames.findIndex(match);
        if (found >= 0) return frames.splice(found, 1)[0];
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the event stream ended before " + description);
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const line = raw.split("\n").find((value) => value.startsWith("data: "));
          if (event === undefined || line === undefined) continue;
          const data = JSON.parse(line.slice(6));
          if (event === "snapshot" || event === "state") folder.fold(event, data);
          frames.push({ event, data, window: folder.current() as Held });
        }
      }
    },
    async close() { await reader.cancel().catch(() => {}); },
  };
}

/**
 * The terminal lifecycle frame of one submission: the run's own settlement. An idle read cannot stand in for it, because
 * a state that is not busy may be published before the run it belongs to has started.
 */
const settled = (requestId: string) => (frame: Observed): boolean =>
  frame.event === "submission"
  && (frame.data as { requestId?: unknown }).requestId === requestId
  && ((frame.data as { status?: unknown }).status === "done" || (frame.data as { status?: unknown }).status === "unanswered");

/** The state frame published after a settlement, which is where the transcript and the framework's own failure are read. */
const settledState = (revision: number) => (frame: Observed): boolean =>
  (frame.event === "state" || frame.event === "snapshot") && !frame.window.busy && frame.window.revision > revision;

/** Submit one prompt and settle on the frames that state the turn is over. */
async function submit(origin: string, id: string, text: string): Promise<Held> {
  const stream = await openStream(origin, id);
  try {
    const submitted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text }) });
    assert.equal(submitted.status, 202, "the submission is admitted; a missing model is the framework's failure, not a rejected command");
    const settlement = await stream.follow(settled(text), "the settlement of " + JSON.stringify(text));
    return (await stream.follow(settledState(settlement.window.revision), "the state that reflects the settlement")).window;
  } finally { await stream.close(); }
}

async function createConversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

async function startBackend(t: TestContext, agentDir: string, runtime: Awaited<ReturnType<typeof openEnvModelRuntime>>, defaultModel: { provider: string; modelId: string }, settings?: { retry?: { baseDelayMs: number } }): Promise<{ origin: string; backend: BackendServer }> {
  const backend = await createBackendServer({ dbPath: join(agentDir, "missing-model.sqlite"), authToken: token, models: runtime, defaultModel, modelConfig: { path: join(agentDir, "models.json"), runtime }, ...(settings === undefined ? {} : { settings }) });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { origin: "http://127.0.0.1:" + address.port, backend };
}

test("a provider failure is shown through its assistant entry, not projected a second time", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "hepi-missing-model-"));
  directories.push(agentDir);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  endpoint.failNext();
  const runtime = await openEnvModelRuntime({ agentDir, custom: providerOf(ENV_PROVIDER, ENV_MODEL, endpoint.origin) });
  // The durable retry policy is what makes this test's case what it is — a refused attempt that the next attempt answers
  // — so retrying stays on and only its backoff is shortened: the default two-second base is a deployment's patience,
  // not the behavior under test, and waiting it out would cost every run of this file two seconds.
  const started = await startBackend(t, agentDir, runtime, { provider: ENV_PROVIDER, modelId: ENV_MODEL }, { retry: { baseDelayMs: 1 } });
  const conversationId = await createConversation(started.origin);

  const failed = await submit(started.origin, conversationId, "provider-refused");
  // The framework appends the error entry for this outcome, so the turn is visible in the transcript and the public
  // snapshot adds nothing: the user is told once, in the place that fails, not also above the composer.
  assert.equal(failed.failure, null, "a rejected request is not additionally projected as a run failure");
  assert.equal(failed.entries.at(-1)?.role, "assistant", "the failure is carried by the assistant entry the framework appends");
  assert.ok(endpoint.requests.length >= 1, "the request the provider refused was actually made");
});

test("a deleted selected model reports the framework's failure and recovers on an explicit reselection", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "hepi-missing-model-"));
  directories.push(agentDir);
  process.env[API_KEY_VAR] = "env-key";
  const endpoint = await controlledEndpoint(t);
  const runtime = await openEnvModelRuntime({ agentDir, custom: providerOf(ENV_PROVIDER, ENV_MODEL, endpoint.origin) });
  const started = await startBackend(t, agentDir, runtime, { provider: ENV_PROVIDER, modelId: ENV_MODEL });

  // The file is the only owner of the second model, so saving it and then removing it is a real deletion: the
  // environment alias is a separate provider and is not touched.
  const saved = await fetch(started.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { [FILE_PROVIDER]: { baseUrl: endpoint.origin + "/v1", api: "openai-completions", apiKey: "$" + API_KEY_VAR, models: [{ id: FILE_MODEL }] } } }) });
  assert.deepEqual(await saved.json(), { success: true, applied: true });

  const conversationId = await createConversation(started.origin);
  const selected = await fetch(started.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: FILE_PROVIDER, modelId: FILE_MODEL } }) });
  assert.equal(selected.status, 200, "the file-owned model can be selected while it exists");

  // Delete it. The conversation's selection is not rewritten: it stays the reference the user chose.
  const deleted = await fetch(started.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: {} }) });
  assert.deepEqual(await deleted.json(), { success: true, applied: true });
  const catalog = await (await fetch(started.origin + "/api/models", { headers })).json() as { models: { provider: string; id: string }[] };
  assert.equal(catalog.models.some((model) => model.provider === FILE_PROVIDER), false, "the deleted model is gone from the catalog");
  assert.deepEqual((await stateOf(started.origin, conversationId)).settings.model, { provider: FILE_PROVIDER, modelId: FILE_MODEL }, "the selection is preserved instead of being switched to another model");

  // The next request settles natively: no assistant entry is manufactured, and the model is never called.
  const failed = await submit(started.origin, conversationId, "after-deletion");
  assert.deepEqual(failed.entries.map((entry) => entry.role), ["user"], "the failure is never disguised as an assistant reply");
  assert.equal(endpoint.requests.length, 0, "no request was made for a model that does not exist");
  assert.equal(failed.busy, false, "the run is not left busy");
  assert.equal(failed.failure?.reason, "no_model", "the framework's own no_model reason is reported");
  assert.match(failed.failure?.message ?? "", new RegExp(FILE_PROVIDER + "/" + FILE_MODEL), "the failure names the model the conversation selected");

  // Another conversation on a model that still exists is unaffected.
  const otherId = await createConversation(started.origin);
  const served = await submit(started.origin, otherId, "other-session");
  assert.equal(endpoint.requests.length, 1, "a session on a valid model is served normally");
  assert.deepEqual(served.entries.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(served.failure, null, "a session that did not fail reports no failure");

  // An explicit reselection plus a new submission is the recovery: the controlled provider receives the new selection
  // and the stale failure is gone.
  const reselected = await fetch(started.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: ENV_PROVIDER, modelId: ENV_MODEL } }) });
  assert.equal(reselected.status, 200);
  const recovered = await submit(started.origin, conversationId, "after-reselection");
  assert.deepEqual(recovered.entries.map((entry) => entry.text), ["after-deletion", "after-reselection", "ok"], "the reselected model serves the next turn");
  assert.equal(endpoint.requests.length, 2, "the newly selected model reached the provider");
  assert.equal(recovered.failure, null, "a new valid input clears the historical failure");

  // A backend restart keeps both the selection and the observable failure: neither is an in-memory callback.
  await started.backend.close();
  const restarted = await openEnvModelRuntime({ agentDir, custom: providerOf(ENV_PROVIDER, ENV_MODEL, endpoint.origin) });
  const again = await startBackend(t, agentDir, restarted, { provider: ENV_PROVIDER, modelId: ENV_MODEL });
  await fetch(again.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: { [FILE_PROVIDER]: { baseUrl: endpoint.origin + "/v1", api: "openai-completions", apiKey: "$" + API_KEY_VAR, models: [{ id: FILE_MODEL }] } } }) });
  await fetch(again.origin + "/api/conversations/" + conversationId + "/settings", { method: "PATCH", headers, body: JSON.stringify({ model: { provider: FILE_PROVIDER, modelId: FILE_MODEL } }) });
  await fetch(again.origin + "/api/models-config", { method: "PUT", headers, body: JSON.stringify({ providers: {} }) });
  const reread = await stateOf(again.origin, conversationId);
  assert.deepEqual(reread.settings.model, { provider: FILE_PROVIDER, modelId: FILE_MODEL }, "the selection survives a restart");
  const refailed = await submit(again.origin, conversationId, "after-restart");
  assert.deepEqual(refailed.entries.map((entry) => entry.role), ["user", "user", "assistant", "user"], "the restarted run settles the same way: the last turn is a user input, never an assistant reply");
  assert.equal(refailed.failure?.reason, "no_model", "the native failure is observed again after a restart");
  assert.equal(endpoint.requests.length, 2, "no request was made across the restart for the deleted model");
});
