import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { hasApi, type Message } from "@earendil-works/pi-ai";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createBackendServer } from "../src/server.ts";
import { streamFolder } from "./stream-window.ts";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** A real 1x1 RGBA PNG, so the data URL the endpoint receives is image bytes a decoder accepts, not a marker. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

type Captured = { path: string; authorization: string | undefined; body: Record<string, unknown> };
type Controlled = { origin: string; requests: Captured[]; close(): Promise<void> };

/** One OpenAI-completions endpoint that records every request and answers a minimal streamed completion. */
async function controlledEndpoint(t: TestContext): Promise<Controlled> {
  const requests: Captured[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: "http://127.0.0.1:" + address.port, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** One user turn carrying a real image block, so the framework's own content conversion is what the test observes. */
function userWithImage(): Message {
  return { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "look" }, { type: "image", data: TINY_PNG, mimeType: "image/png" }] };
}

function configured(origin: string, model: string) {
  const env = { HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: origin + "/v1", HEPI_PROVIDER_API_KEY: "secret-key" };
  const custom = customProviderFromEnv(env);
  assert.ok(custom, "a complete provider configuration is accepted");
  return custom;
}

test("the configured alias advertises the upstream image input of its model id", async (t) => {
  const endpoint = await controlledEndpoint(t);
  const custom = configured(endpoint.origin, "deepseek-v4.1-flash");
  const model = custom.models.getModel("magpie", "deepseek-v4.1-flash");
  assert.ok(model);
  assert.deepEqual([...model.input], ["text", "image"], "image capability comes from the upstream catalog entry for this id");
  assert.equal(model.provider, "magpie");
  assert.equal(model.baseUrl, endpoint.origin + "/v1");

  const directory = await mkdtemp(join(tmpdir(), "hepi-catalog-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "catalog.sqlite"), authToken: "token", models: custom.models, defaultModel: custom.defaultModel });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const catalog = await fetch(origin + "/api/models", { headers: { authorization: "Bearer token" } });
  assert.equal(catalog.status, 200);
  const body = await catalog.json() as { models: { provider: string; id: string; input: string[] }[] };
  const entry = body.models.find(candidate => candidate.provider === "magpie" && candidate.id === "deepseek-v4.1-flash");
  assert.ok(entry, "the catalog lists the configured alias");
  assert.deepEqual([...entry.input], ["text", "image"], "the public catalog advertises image input for the configured alias");
});

test("a text turn still uses the configured provider, endpoint and key", async (t) => {
  const endpoint = await controlledEndpoint(t);
  const custom = configured(endpoint.origin, "deepseek-v4.1-flash");
  const directory = await mkdtemp(join(tmpdir(), "hepi-routing-"));
  directories.push(directory);
  const backend = await createBackendServer({ dbPath: join(directory, "routing.sqlite"), authToken: "token", models: custom.models, defaultModel: custom.defaultModel });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  t.after(() => backend.close());
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const headers = { authorization: "Bearer token", "content-type": "application/json" };
  const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers })).json() as { conversationId: string };
  const submitted = await fetch(origin + "/api/conversations/" + created.conversationId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "req-1", text: "hello" }) });
  assert.equal(submitted.status, 202);
  // Settle on the frame that states the settlement: the assistant reply is appended and no run is in flight. Frames are
  // folded through the shared reducer a browser uses, so the window asserted on is the one a client holds. The stream is
  // opened after the submit was accepted, so an idle state before the run begins cannot be mistaken for a finished turn —
  // the reply is part of the condition. The wait is the frame's own barrier, not a sleep loop, and its deadline exists
  // only so a frame that never arrives fails the test instead of hanging it.
  type Entry = { role: string; text: string };
  const folder = streamFolder<Entry>(created.conversationId);
  const events = await fetch(origin + "/api/conversations/" + created.conversationId + "/events", { headers, signal: AbortSignal.timeout(10_000) });
  assert.equal(events.status, 200, "the conversation stream attaches");
  const reader = events.body!.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 10_000;
  let pending = "";
  let settled: { busy: boolean; entries: Entry[] } | undefined;
  try {
    while (settled === undefined) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the text turn to settle");
      const chunk = await reader.read();
      if (chunk.done) throw new Error("the event stream ended before the text turn settled");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while (settled === undefined && (boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = raw.split("\n").find(line => line.startsWith("event: "))?.slice(7);
        const data = raw.split("\n").find(line => line.startsWith("data: "))?.slice(6);
        if (data === undefined || (event !== "snapshot" && event !== "state")) continue;
        const window = folder.fold(event, JSON.parse(data));
        if (!window.busy && window.entries.some(entry => entry.role === "assistant" && entry.text === "ok")) settled = window;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  assert.ok(settled, "the text turn settled on an assistant reply before the deadline");
  assert.equal(endpoint.requests.length, 1, "exactly one model request reached the configured endpoint");
  const request = endpoint.requests[0]!;
  assert.equal(request.path, "/v1/chat/completions");
  assert.equal(request.authorization, "Bearer secret-key");
  assert.equal(request.body.model, "deepseek-v4.1-flash");
  const messages = request.body.messages as { role: string; content: unknown }[];
  assert.ok(messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("hello")));
});

test("an image content block reaches the configured endpoint as image bytes", async (t) => {
  const endpoint = await controlledEndpoint(t);
  const custom = configured(endpoint.origin, "deepseek-v4.1-flash");
  const model = custom.models.getModel("magpie", "deepseek-v4.1-flash");
  assert.ok(model);
  const result = await custom.models.streamSimple(model, { messages: [userWithImage()] }).result();
  assert.equal(result.stopReason, "stop", JSON.stringify(result));
  const request = endpoint.requests[0]!;
  const messages = request.body.messages as { role: string; content: unknown }[];
  const user = messages.find(message => message.role === "user");
  assert.deepEqual(user?.content, [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64," + TINY_PNG } }], "the endpoint receives the fixture's exact base64 image bytes");
  assert.doesNotMatch(JSON.stringify(request.body), /omitted/);
});

test("the provider's own catalog entry keeps its pricing and compatibility with the configured endpoint", async (t) => {
  const endpoint = await controlledEndpoint(t);
  const custom = customProviderFromEnv({ HEPI_PROVIDER: "deepseek", HEPI_MODEL: "deepseek-flash", HEPI_PROVIDER_BASE_URL: endpoint.origin + "/v1", HEPI_PROVIDER_API_KEY: "secret-key" });
  assert.ok(custom);
  const model = custom.models.getModel("deepseek", "deepseek-flash");
  assert.ok(model);
  assert.deepEqual([...model.input], ["text", "image"]);
  assert.equal(model.baseUrl, endpoint.origin + "/v1", "the configured endpoint replaces the catalog's own base URL");
  assert.deepEqual(model.cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, "pricing stays provider-specific");
  assert.ok(hasApi(model, "openai-completions"));
  assert.equal(model.compat?.thinkingFormat, "deepseek", "wire compatibility stays provider-specific");
});

test("a text-only or ambiguous model id is never given image input by provider name", async (t) => {
  const endpoint = await controlledEndpoint(t);
  // deepseek-v4-pro is text-only in every catalog; zai-org/GLM-5.3 disagrees across catalogs, so its modality is
  // unknown; no-such-model is absent. None of them may inherit an image capability from the provider name.
  for (const id of ["deepseek-v4-pro", "zai-org/GLM-5.3", "no-such-model"]) {
    const custom = configured(endpoint.origin, id);
    const model = custom.models.getModel("magpie", id);
    assert.ok(model);
    assert.deepEqual([...model.input], ["text"], id + " stays text-only");
  }
  // A model id every catalog agrees accepts images does keep that capability under the configured alias.
  const agreed = configured(endpoint.origin, "glm-5.3-flash");
  assert.deepEqual([...(agreed.models.getModel("magpie", "glm-5.3-flash")?.input ?? [])], ["text", "image"]);
  const custom = configured(endpoint.origin, "deepseek-v4-pro");
  const model = custom.models.getModel("magpie", "deepseek-v4-pro");
  assert.ok(model);
  const result = await custom.models.streamSimple(model, { messages: [userWithImage()] }).result();
  assert.equal(result.stopReason, "stop", JSON.stringify(result));
  const request = endpoint.requests.at(-1)!;
  assert.doesNotMatch(JSON.stringify(request.body), /image_url/, "a text-only model never receives image content");
  assert.match(JSON.stringify(request.body), /omitted/, "the framework replaces the image with its explicit placeholder");
});
