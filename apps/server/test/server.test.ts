import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentState } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder } from "./stream-window.ts";
import { loadPiConfig } from "../src/pi-config.ts";
import { SERVER_MODEL, fauxModels } from "./faux-fixture.ts";

const directories: string[] = [];
const token = "test-token";
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

async function start(t: TestContext, dbPath?: string, defaultThinkingLevel?: AgentState["thinkingLevel"]): Promise<{ backend: BackendServer; origin: string; dbPath: string }> {
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-server-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "server.sqlite");
  // This suite's turns really settle, so it injects the offline scripted catalog and its model explicitly: production
  // registers no such provider and defaults to none.
  const backend = await createBackendServer({ dbPath: path, authToken: token, models: fauxModels(), defaultModel: SERVER_MODEL, defaultThinkingLevel });
  await new Promise<void>((resolve) => backend.server.listen(0, resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath: path };
}

function headers(): HeadersInit { return { authorization: "Bearer " + token, "content-type": "application/json" }; }
/** The conversation these tests talk to: created here, because a fresh backend lists none of its own. */
async function createConversation(origin: string): Promise<{ id: string }> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers: headers(), body: JSON.stringify({}) });
  assert.equal(created.status, 201);
  const { conversationId } = await created.json() as { conversationId: string };
  const response = await fetch(origin + "/api/conversations", { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.json() as { conversations: { id: string }[] };
  assert.deepEqual(body.conversations.map(entry => entry.id), [conversationId]);
  return { id: conversationId };
}
async function state(origin: string, id: string): Promise<ServerSnapshot> { const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers: headers() }); assert.equal(response.status, 200); return await response.json() as ServerSnapshot; }

async function waitForEntries(origin: string, id: string): Promise<ServerSnapshot> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) { const current = await state(origin, id); if (current.entries.length === 2 && !current.busy) return current; }
  throw new Error("timed out waiting for durable response");
}

test("lists the conversations a client created, and no framework record", async (t) => {
  const server = await start(t);
  const fresh = await fetch(server.origin + "/api/conversations", { headers: headers() });
  assert.equal(fresh.status, 200);
  const body = await fresh.json() as { conversations: { id: string }[] };
  assert.deepEqual(body.conversations, [], "the runtime's own root conversation is a framework record, not a listed one");
  // The record itself is untouched — it is only never projected — so nothing here deletes anything.
  assert.equal((await fetch(server.origin + "/api/conversations/1/state", { headers: headers() })).status, 404);
  await createConversation(server.origin);
});

test("requires authentication and exposes a durable conversation", async (t) => {
  const server = await start(t);
  assert.equal((await fetch(server.origin + "/api/conversations")).status, 401);
  const conversation = await createConversation(server.origin);
  assert.equal((await state(server.origin, conversation.id)).protocol, "hepi.v1");
  const catalog = await fetch(server.origin + "/api/models", { headers: headers() });
  assert.equal(catalog.status, 200);
  assert.ok((await catalog.json()).models.some((model: { provider: string }) => model.provider === "faux"));
});

test("submits with request correlation, streams events, and survives restart", async (t) => {
  const first = await start(t);
  const conversation = await createConversation(first.origin);
  const eventResponse = await fetch(first.origin + "/api/conversations/" + conversation.id + "/events", { headers: headers() });
  assert.equal(eventResponse.status, 200);
  const reader = eventResponse.body!.getReader();
  const firstFrame = new TextDecoder().decode((await reader.read()).value);
  assert.match(firstFrame, /event: snapshot/);
  const response = await fetch(first.origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v1", requestId: "req-1", type: "conversation.submit", text: "hello" }) });
  assert.equal(response.status, 202);
  const final = await waitForEntries(first.origin, conversation.id);
  assert.equal(final.entries[1]?.text, "Server reply to: hello");
  assert.equal(final.entries[1]?.message.role, "assistant");
  assert.deepEqual(final.entries[1]?.message.content, [{ type: "text", text: "Server reply to: hello" }]);
  await reader.cancel();
  await first.backend.close();
  const second = await start(t, first.dbPath);
  const reopened = await state(second.origin, conversation.id);
  assert.equal(reopened.entries.length, 2);
  assert.equal(reopened.entries[1]?.text, "Server reply to: hello");
});


test("signals resync when a reconnect revision is not current", async (t) => {
  const server = await start(t);
  const conversation = await createConversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + conversation.id + "/events?after=999", { headers: headers() });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 3 && !text.includes("event: resync_required"); index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  assert.match(text, /event: snapshot/);
  assert.match(text, /event: resync_required/);
});

test("deduplicates the same request ID across independent clients", async (t) => {
  const server = await start(t);
  const conversation = await createConversation(server.origin);
  const body = JSON.stringify({ protocol: "hepi.v1", requestId: "shared-request", type: "conversation.submit", text: "once" });
  const first = await fetch(server.origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body });
  const second = await fetch(server.origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  const firstBody = await first.json() as { submissionId: string };
  const secondBody = await second.json() as { submissionId: string };
  assert.equal(secondBody.submissionId, firstBody.submissionId);
  const final = await waitForEntries(server.origin, conversation.id);
  assert.deepEqual(final.entries.map((entry) => entry.text), ["once", "Server reply to: once"]);
});

test("two event clients observe one run and closing one client does not stop it", async (t) => {
  const server = await start(t);
  const conversation = await createConversation(server.origin);
  const first = await fetch(server.origin + "/api/conversations/" + conversation.id + "/events", { headers: headers() });
  const second = await fetch(server.origin + "/api/conversations/" + conversation.id + "/events", { headers: headers() });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstReader = first.body!.getReader();
  const secondReader = second.body!.getReader();
  assert.match(new TextDecoder().decode((await firstReader.read()).value), /event: snapshot/);
  assert.match(new TextDecoder().decode((await secondReader.read()).value), /event: snapshot/);
  await firstReader.cancel();
  const response = await fetch(server.origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v1", requestId: "multi-client-1", type: "conversation.submit", text: "shared" }) });
  assert.equal(response.status, 202);
  const final = await waitForEntries(server.origin, conversation.id);
  assert.equal(final.entries[1]?.text, "Server reply to: shared");
  await secondReader.cancel();
});

test("the catalogue states when a conversation's newest run ended, whether or not anyone saw it running", async (t) => {
  // The one fact an unobserved run leaves: it was never reported busy, so a client that only compared running flags
  // could not tell that anything had happened. The run's own durable receipt says it did, and the catalogue reports it
  // without a per-conversation read — the value is read once at attach and kept current from the commit stream.
  const server = await start(t);
  const conversation = await createConversation(server.origin);
  const rows = async () => ((await (await fetch(server.origin + "/api/conversations", { headers: headers() })).json()) as { conversations: { id: string; busy: boolean; lastRunEndedAt?: number }[] }).conversations;
  const rowOf = (id: string) => rows().then((all) => all.find((entry) => entry.id === id));
  assert.equal((await rowOf(conversation.id))?.lastRunEndedAt, undefined, "a conversation that has run nothing states no end");
  assert.equal((await submit(server.origin, conversation.id, "first")).status, 202);
  const settled = await waitForEntries(server.origin, conversation.id);
  assert.equal(settled.busy, false);
  const first = await rowOf(conversation.id);
  assert.equal(typeof first?.lastRunEndedAt, "number", "a finished run states when it ended, from its own receipt");
  // A second run moves the value forward, so a client comparing it sees one event per run and never a repeat.
  assert.equal((await submit(server.origin, conversation.id, "second")).status, 202);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && ((await rowOf(conversation.id))?.lastRunEndedAt ?? 0) <= (first?.lastRunEndedAt ?? 0)) await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await rowOf(conversation.id);
  assert.ok((second?.lastRunEndedAt ?? 0) > (first?.lastRunEndedAt ?? 0), "a later run states a later end");
  // A run in flight states no new end yet, which is what keeps a marker off work that has not finished.
  assert.equal((await submit(server.origin, conversation.id, "third")).status, 202);
  const inFlight = await rowOf(conversation.id);
  assert.ok((inFlight?.lastRunEndedAt ?? 0) >= (second?.lastRunEndedAt ?? 0));
});

test("persists conversation settings and rejects unknown models", async (t) => {
  const first = await start(t);
  const { id } = await createConversation(first.origin);
  const endpoint = first.origin + "/api/conversations/" + id + "/settings";
  const update = await fetch(endpoint, { method: "PATCH", headers: headers(), body: JSON.stringify({ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "high" }) });
  assert.equal(update.status, 200);
  assert.equal((await state(first.origin, id)).settings.thinkingLevel, "high");
  assert.equal((await fetch(endpoint, { method: "PATCH", headers: headers(), body: JSON.stringify({ model: { provider: "unknown", modelId: "missing" } }) })).status, 400);
  await first.backend.close();
  const second = await start(t, first.dbPath);
  const settings = await (await fetch(second.origin + "/api/conversations/" + id + "/settings", { headers: headers() })).json();
  assert.deepEqual(settings.model, { provider: "faux", modelId: "faux-1" });
  assert.equal(settings.thinkingLevel, "high");
});

test("defaults apply to new conversations without overwriting persisted choices", async (t) => {
  const first = await start(t, undefined, "high");
  const { id } = await createConversation(first.origin);
  assert.equal((await state(first.origin, id)).settings.thinkingLevel, "high");
  await first.backend.close();
  const second = await start(t, first.dbPath, "low");
  assert.equal((await state(second.origin, id)).settings.thinkingLevel, "high");
  const created = await fetch(second.origin + "/api/conversations", { method: "POST", headers: headers() });
  assert.equal(created.status, 201);
  const { conversationId } = await created.json() as { conversationId: string };
  assert.equal((await state(second.origin, conversationId)).settings.thinkingLevel, "low");
  const catalog = await (await fetch(second.origin + "/api/models", { headers: headers() })).json();
  assert.equal(catalog.defaultThinkingLevel, "low");
});

test("queues steer and follow-up while busy without timing sleeps", { timeout: 2000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-queue-")); directories.push(directory);
  let markEntered!: () => void;
  let releaseResponse!: () => void;
  const entered = { promise: new Promise<void>(resolve => { markEntered = resolve; }), resolve: () => markEntered() };
  const release = { promise: new Promise<void>(resolve => { releaseResponse = resolve; }), resolve: () => releaseResponse() };
  const faux = fauxProvider();
  faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("first answer"); }, fauxAssistantMessage("queued answer")]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(directory, "queue.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, resolve));
  t.after(async () => { release.resolve(); await backend.close(); });
  const address = backend.server.address(); assert.ok(address && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const { id } = await createConversation(origin);
  const endpoint = origin + "/api/conversations/" + id;
  const submit = (text: string, whenBusy?: string) => fetch(endpoint + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text, whenBusy }) });
  assert.equal((await submit("first")).status, 202);
  await entered.promise;
  assert.equal((await submit("rejected", "reject")).status, 409);
  assert.equal((await submit("steering", "steer")).status, 202);
  assert.equal((await fetch(endpoint + "/busy", { method: "POST", headers: headers(), body: JSON.stringify({ mode: "follow-up", text: "later", requestId: "later" }) })).status, 202);
  assert.deepEqual((await state(origin, id)).queuedMessages, { steering: ["steering"], followUp: ["later"] });
  release.resolve();
  const stream = await fetch(endpoint + "/events", { headers: headers(), signal: AbortSignal.timeout(1500) });
  const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let pending = "";
  // The stream states its window once and appends after it, so the frames are folded the way a client folds them.
  const folder = streamFolder<ServerSnapshot["entries"][number]>(id);
  try {
    outer: while (true) {
      const chunk = await reader.read(); if (chunk.done) throw new Error("stream ended");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        if (event !== "snapshot" && event !== "state") continue;
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const current = folder.fold(event, JSON.parse(data.slice(6)));
        if (!current.busy && current.entries.length >= 5) {
          assert.deepEqual(current.entries.filter(entry => entry.role === "user").map(entry => entry.text), ["first", "steering", "later"]);
          assert.deepEqual(current.queuedMessages, { steering: [], followUp: [] }); break outer;
        }
      }
    }
  } finally { await reader.cancel(); }
});

test("rejects invalid protocol commands", async (t) => {
  const server = await start(t);
  const conversation = await createConversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v2", requestId: "req-2", type: "conversation.submit", text: "no" }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: "unsupported_protocol" });
});


const PI_MODELS = {
  providers: {
    local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "k", models: [{ id: "local-1", name: "Local One" }] },
  },
};

async function startPi(t: TestContext, models: unknown): Promise<{ origin: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "hepi-pi-server-"));
  directories.push(dir);
  await writeFile(join(dir, "models.json"), JSON.stringify(models));
  await writeFile(join(dir, "auth.json"), JSON.stringify({ local: { type: "api_key", key: "k" } }));
  await writeFile(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "local-1" }));
  const config = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: dir });
  assert.ok(config);
  const backend = await createBackendServer({ dbPath: join(dir, "pi.sqlite"), authToken: token, models: config.models, defaultModel: config.defaultModel });
  await new Promise<void>((resolve) => backend.server.listen(0, resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { origin: "http://127.0.0.1:" + address.port, dir };
}

async function submit(origin: string, id: string, text: string): Promise<Response> {
  return fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v1", requestId: text, type: "conversation.submit", text }) });
}

test("model catalog exposes only reconstructed nested metadata", async (t) => {
  const { origin } = await startPi(t, {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "k",
        models: [{
          id: "local-1",
          name: "Local One",
          reasoning: true,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, apiKey: "SECRET-cost", extra: "SECRET-extra", tiers: [{ inputTokensAbove: 10, input: 5, output: 6, cacheRead: 7, cacheWrite: 8, extra: "SECRET-tier" }] },
          thinkingLevelMap: { high: "provider-specific-high", minimal: null, nested: { authorization: "SECRET-nested" } },
        }],
      },
    },
  });
  const response = await fetch(origin + "/api/models", { headers: headers() });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(!body.includes("SECRET"), body);
  const catalog = JSON.parse(body) as { models: { id: string; cost: unknown; thinkingLevelMap: unknown }[]; thinkingLevelMaps: Record<string, unknown> };
  const model = catalog.models.find((entry) => entry.id === "local-1");
  assert.deepEqual(model?.cost, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers: [{ inputTokensAbove: 10, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }] });
  assert.deepEqual(model?.thinkingLevelMap, { high: "provider-specific-high", minimal: null });
  assert.deepEqual(catalog.thinkingLevelMaps["local:local-1"], { high: "provider-specific-high", minimal: null });
});

test("credential and configuration failures are sanitized for HTTP and event clients", async (t) => {
  const { origin, dir } = await startPi(t, PI_MODELS);
  // Runtime corruption after startup: the credential store re-reads auth.json on demand, and the JSON parse error
  // quotes the file's first bytes, so neither the secret nor the file path may survive into the response.
  await writeFile(join(dir, "auth.json"), '{ "local": SECRET-live-auth }');
  const catalog = await fetch(origin + "/api/models", { headers: headers() });
  assert.equal(catalog.status, 500);
  const catalogBody = await catalog.text();
  assert.ok(!catalogBody.includes("SECRET-live-auth"), catalogBody);
  assert.ok(!catalogBody.includes("auth.json") && !catalogBody.includes(dir), catalogBody);
  assert.match(catalogBody, /could not be loaded/);
  const conversation = await createConversation(origin);
  assert.equal((await submit(origin, conversation.id, "hello")).status, 202);
  const current = await waitForEntries(origin, conversation.id);
  assert.ok(!JSON.stringify(current).includes("SECRET-live-auth"));
  assert.match((current.entries[1]?.message as { errorMessage?: string }).errorMessage ?? "", /could not be loaded/);
});

test("a real Pi config with an unregistered api is sanitized across HTTP, durable state and events", async (t) => {
  // `models.json` accepts any string as `api`, so startup succeeds and the failure surfaces only when a model call
  // reaches the api registry: `@earendil-works/pi-ai` dist/index.js throws `No API provider registered for api: <api>`
  // and `dist/api/lazy.js` copies that message into the assistant entry, quoting the configured value.
  const { origin } = await startPi(t, {
    providers: {
      local: { baseUrl: "http://127.0.0.1:9/v1", api: "SECRET-invalid-api", apiKey: "k", models: [{ id: "local-1", name: "Local One" }] },
    },
  });
  const catalog = await fetch(origin + "/api/models", { headers: headers() });
  assert.equal(catalog.status, 200);
  assert.ok(!(await catalog.text()).includes("SECRET-invalid-api"));
  const conversation = await createConversation(origin);
  assert.equal((await submit(origin, conversation.id, "hello")).status, 202);
  const current = await waitForEntries(origin, conversation.id);
  assert.ok(!JSON.stringify(current).includes("SECRET-invalid-api"), JSON.stringify(current));
  assert.match((current.entries[1]?.message as { errorMessage?: string }).errorMessage ?? "", /could not be loaded/);
  const stream = await fetch(origin + "/api/conversations/" + conversation.id + "/events", { headers: headers(), signal: AbortSignal.timeout(1500) });
  const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let pending = "";
  try {
    outer: while (true) {
      const chunk = await reader.read(); if (chunk.done) throw new Error("stream ended");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        if (!/^event: (snapshot|state)$/m.test(frame)) continue;
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data) continue;
        const frameText = data.slice(6);
        assert.ok(!frameText.includes("SECRET-invalid-api"), frameText);
        if (JSON.parse(frameText).revision === current.revision) break outer;
      }
    }
  } finally { await reader.cancel(); }
});

test("unrelated provider and protocol errors keep their own message", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-provider-error-"));
  directories.push(directory);
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" })]);
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(directory, "provider-error.sqlite"), authToken: token, models, defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => backend.server.listen(0, resolve));
  t.after(() => backend.close());
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const conversation = await createConversation(origin);
  assert.equal((await submit(origin, conversation.id, "hello")).status, 202);
  const current = await waitForEntries(origin, conversation.id);
  assert.equal((current.entries[1]?.message as { errorMessage?: string }).errorMessage, "Provider finish_reason: content_filter");
  const invalid = await fetch(origin + "/api/conversations/" + conversation.id + "/messages", { method: "POST", headers: headers(), body: JSON.stringify({ protocol: "hepi.v2", requestId: "bad", type: "conversation.submit", text: "no" }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { ok: false, code: "unsupported_protocol" });
});

