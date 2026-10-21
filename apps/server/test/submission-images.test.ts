import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import type { MutableModels } from "@earendil-works/pi-ai";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createBackendServer, type BackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** A real 1x1 RGBA PNG, so the bytes the endpoint receives are an image a decoder accepts, not a marker. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = { type: "image", data: TINY_PNG, mimeType: "image/png" };
const token = "test-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };

type Captured = { path: string; body: Record<string, unknown> };

/** One OpenAI-completions endpoint that records every request and answers a minimal streamed completion. */
async function controlledEndpoint(t: TestContext): Promise<{ origin: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // Only the provider's own completion call is recorded: an unrelated probe that reaches this ephemeral port
      // (a scanner, a health check) must not be counted as a model request or parsed as JSON.
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: { role: "assistant", content: "saw it" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "deepseek-v4.1-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: "http://127.0.0.1:" + address.port, requests };
}

async function start(t: TestContext, dbPath?: string, modelId = "deepseek-v4.1-flash"): Promise<{ backend: BackendServer; origin: string; requests: Captured[]; dbPath: string; models: MutableModels }> {
  const endpoint = await controlledEndpoint(t);
  const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: modelId, HEPI_PROVIDER_BASE_URL: endpoint.origin + "/v1", HEPI_PROVIDER_API_KEY: "secret-key" });
  assert.ok(custom);
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-images-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "images.sqlite");
  const backend = await createBackendServer({ dbPath: path, authToken: token, models: custom.models, defaultModel: custom.defaultModel });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, requests: endpoint.requests, dbPath: path, models: custom.models as MutableModels };
}

async function conversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}

async function state(origin: string, id: string): Promise<ServerSnapshot> {
  const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
  assert.equal(response.status, 200);
  return await response.json() as ServerSnapshot;
}

type Entry = ServerSnapshot["entries"][number];
/**
 * A settled turn as a client holds it: the folded window beside the scalars the frame that stated it carried. The
 * reducer spreads the frame it folded, so the snapshot's own scalars — the selection among them — ride the folded
 * window, and this is the type that says which ones a test reads.
 */
type Held = HeldWindow<Entry> & Pick<ServerSnapshot, "settings">;
/** One frame as a client receives it: the event, its own payload, and the state a client holds after folding it. */
type Observed = { readonly event: string; readonly data: unknown; readonly window: Held };

/**
 * One conversation's event stream, read the way a client reads it: the frames as they arrive, folded through the shared
 * reducer. A wait is the frame that states the fact, so nothing is polled and nothing is slept on, and the connection's
 * own bound is what fails a stream that goes quiet.
 */
async function openStream(origin: string, id: string): Promise<{ follow: (match: (frame: Observed) => boolean, description: string) => Promise<Observed>; close: () => Promise<void> }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(15_000) });
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
          const line = raw.split("\n").find(value => value.startsWith("data: "));
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

/** One queue-only admission: the busy composer's steer or follow-up, on its own route. */
const queueOnly = (origin: string, id: string, body: Record<string, unknown>) =>
  fetch(origin + "/api/conversations/" + id + "/busy", { method: "POST", headers, body: JSON.stringify(body) });

/** Wait for a conversation to settle with at least `count` committed entries, and answer its state. */
async function awaitSettled(origin: string, id: string, count: number): Promise<ServerSnapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await state(origin, id);
    if (!current.busy && current.entries.length >= count) return current;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("the conversation never settled");
}

const submit = (origin: string, id: string, body: Record<string, unknown>) =>
  fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", requestId: "req-" + Math.random(), type: "conversation.submit", ...body }) });

/**
 * The terminal lifecycle frame of one submission: the run's own settlement, answered or not. An idle read cannot stand
 * in for it, because a state that is not busy may be published before the run it belongs to has started.
 */
const settledSubmission = (requestId: string) => (frame: Observed): boolean => {
  const data = frame.data as { requestId?: unknown; status?: unknown };
  return frame.event === "submission" && data.requestId === requestId && (data.status === "done" || data.status === "unanswered");
};

/** The state frame published after a settlement, which is where the transcript is read. */
const settledState = (revision: number) => (frame: Observed): boolean =>
  (frame.event === "state" || frame.event === "snapshot") && !frame.window.busy && frame.window.revision > revision;

/** Submit one turn and settle on the frames that state it is over. */
async function turn(origin: string, id: string, body: Record<string, unknown>, admitted = "the submission is admitted"): Promise<Held> {
  const stream = await openStream(origin, id);
  try {
    await stream.follow(frame => frame.event === "snapshot", "the baseline snapshot");
    const response = await submit(origin, id, body);
    assert.equal(response.status, 202, admitted);
    const { requestId } = await response.json() as { requestId: string };
    const settlement = await stream.follow(settledSubmission(requestId), "the settlement of " + requestId);
    return (await stream.follow(settledState(settlement.window.revision), "the state that reflects the settlement")).window;
  } finally { await stream.close(); }
}

/**
 * A user's own accepted image on the wire: the read block, never the bytes. The image policy belongs to the message
 * that carries the image, so a prompt attachment is deferred exactly as a tool result's screenshot is.
 */
const deferredImage = (id: string, entryId: string, blockIndex: number) => ({ type: "image", source: { type: "url", media_type: "image/png", url: "/api/sessions/" + id + "/entries/" + entryId + "/tool-result-image?blockIndex=" + blockIndex } });

/** The bytes the read block a deferred image names serves, so "deferred" is asserted to be lossless. */
async function readBlockBytes(origin: string, id: string, entryId: string, blockIndex: number): Promise<string> {
  const response = await fetch(origin + "/api/conversations/" + id + "/entries/" + entryId + "/tool-result-image?blockIndex=" + blockIndex, { headers });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer()).toString("base64");
}

test("an image submission reaches the configured model as native content and keeps the text", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  const settled = await turn(server.origin, id, { text: "look at this", images: [image] });
  const user = settled.entries.find(entry => entry.role === "user")!;
  // The durable entry keeps the image, and the wire states it as its read block: carrying the base64 inline is what
  // made the sender's own next read a 413.
  assert.deepEqual(user.message.content, [{ type: "text", text: "look at this" }, deferredImage(id, user.id, 1)], "the projection defers the accepted image to its read block");
  assert.equal(JSON.stringify(settled).includes(TINY_PNG), false, "the bytes do not ride the frame");
  assert.equal(await readBlockBytes(server.origin, id, user.id, 1), TINY_PNG, "and the read block serves exactly those bytes");
  const messages = server.requests[0]?.body.messages as { role: string; content: unknown }[];
  assert.deepEqual(messages.find(message => message.role === "user")?.content, [
    { type: "text", text: "look at this" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + TINY_PNG } },
  ], "the configured endpoint receives the fixture's exact base64 bytes");
});

test("a queue-only steer admits its image instead of dropping it", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  // The busy composer's steer or follow-up is the same admission of the same content as an ordinary send, so the
  // queue-only route carries the protocol's own image blocks: a draft is never staged with less than it was written
  // with. It is still queue-only — it starts no run of its own and never resumes a held conversation.
  const queued = await queueOnly(server.origin, id, { requestId: "steer-1", text: "look while you work", mode: "steer", images: [image] });
  assert.equal(queued.status, 202, await queued.text());
  const settled = await awaitSettled(server.origin, id, 2);
  const user = settled.entries.find(entry => entry.role === "user")!;
  assert.deepEqual(user.message.content, [{ type: "text", text: "look while you work" }, deferredImage(id, user.id, 1)], "the queued draft kept its image behind the read block");
  assert.equal(await readBlockBytes(server.origin, id, user.id, 1), TINY_PNG, "and the read block serves exactly those bytes");
  const messages = server.requests[0]?.body.messages as { role: string; content: unknown }[];
  assert.deepEqual(messages.find(message => message.role === "user")?.content, [
    { type: "text", text: "look while you work" },
    { type: "image_url", image_url: { url: "data:image/png;base64," + TINY_PNG } },
  ], "the configured endpoint receives the image the user attached");
});

test("a queue-only steer refuses what it cannot admit instead of staging a draft without its image", async (t) => {
  const blind = await start(t, undefined, "deepseek-v4-pro");
  const blindId = await conversation(blind.origin);
  const refused = await queueOnly(blind.origin, blindId, { requestId: "steer-2", text: "look", mode: "steer", images: [image] });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { code: string }).code, "unsupported_model_images");
  assert.equal(blind.requests.length, 0, "the model is never called with content it cannot read");
  assert.equal((await state(blind.origin, blindId)).entries.length, 0, "a refused draft writes nothing");

  const server = await start(t);
  const id = await conversation(server.origin);
  // An empty draft and an attachment the protocol refuses are answered before anything is admitted, so the surface can
  // keep the text and the images instead of being told the turn was queued.
  assert.equal((await queueOnly(server.origin, id, { requestId: "steer-3", text: "  ", mode: "steer" })).status, 400);
  const badImage = await queueOnly(server.origin, id, { requestId: "steer-4", text: "x", mode: "steer", images: [{ ...image, mimeType: "text/plain" }] });
  assert.equal(badImage.status, 400);
  assert.equal((await badImage.json() as { code: string }).code, "invalid_images");
  assert.equal((await queueOnly(server.origin, id, { requestId: "steer-5", text: "x", mode: "steer", images: "not-an-array" })).status, 400);
  assert.equal((await state(server.origin, id)).entries.length, 0, "no refusal left a partial draft behind");
});

test("an image-only submission needs no text and survives a backend restart", async (t) => {
  const first = await start(t);
  const id = await conversation(first.origin);
  await turn(first.origin, id, { text: "", images: [image] });
  await first.backend.close();
  const second = await start(t, first.dbPath);
  const reopened = await state(second.origin, id);
  const user = reopened.entries.find(entry => entry.role === "user")!;
  assert.deepEqual(user.message.content, [deferredImage(id, user.id, 0)], "restart restores the image behind its read block");
  assert.equal(await readBlockBytes(second.origin, id, user.id, 0), TINY_PNG, "and the committed bytes are still the ones that were sent");
  assert.equal(reopened.entries.find(entry => entry.role === "assistant")?.text, "saw it");
});

test("an event client observes the image entry in the durable projection", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  const response = await fetch(server.origin + "/api/conversations/" + id + "/events", { headers, signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const stream = streamFolder<ServerSnapshot["entries"][number]>(id);
  await submit(server.origin, id, { text: "streamed", images: [image] });
  try {
    outer: while (true) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended");
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = frame.split("\n").find(line => line.startsWith("data: "));
        if (!data || !/^event: state$/m.test(frame)) continue;
        // The stream states its window once and appends after it, so the frames are folded the way a client folds them.
        const current = stream.fold("state", JSON.parse(data.slice(6)));
        const user = current.entries.find((entry: ServerSnapshot["entries"][number]) => entry.role === "user");
        if (!current.busy && user !== undefined && Array.isArray(user.message.content)) {
          assert.deepEqual(user.message.content, [{ type: "text", text: "streamed" }, deferredImage(id, user.id, 1)]);
          break outer;
        }
      }
    }
  } finally { await reader.cancel(); }
});

test("a model without image input refuses the submission instead of silently downgrading it", async (t) => {
  const server = await start(t, undefined, "deepseek-v4-pro");
  const id = await conversation(server.origin);
  const rejected = await submit(server.origin, id, { text: "look", images: [image] });
  assert.equal(rejected.status, 400);
  const body = await rejected.json() as { code: string; message: string };
  assert.equal(body.code, "unsupported_model_images");
  assert.match(body.message, /does not accept image input/);
  assert.equal(server.requests.length, 0, "the model is never called with content it cannot read");
  assert.equal((await state(server.origin, id)).entries.length, 0, "a refused submission writes nothing");
});

test("a selected model the catalog no longer serves admits the submission and fails natively", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  assert.deepEqual((await state(server.origin, id)).settings.model, { provider: "magpie", modelId: "deepseek-v4.1-flash" });
  // The operator removed the model from the catalog; the conversation keeps its selection.
  server.models.deleteProvider("magpie");
  const settled = await turn(server.origin, id, { text: "look at this", images: [image] }, "a missing model is not a statement about image input, so the submission is admitted");
  assert.deepEqual(settled.settings.model, { provider: "magpie", modelId: "deepseek-v4.1-flash" }, "the selected model reference is preserved");
  const kept = settled.entries.find(entry => entry.role === "user")!;
  assert.deepEqual(kept.message.content, [{ type: "text", text: "look at this" }, deferredImage(id, kept.id, 1)], "the submission kept its image behind the read block");
  assert.equal(settled.entries.some(entry => entry.role === "assistant"), false, "the framework's failure is not disguised as an assistant reply");
  assert.equal(server.requests.length, 0, "no model was called");
});

test("text-only submissions and rejections keep their existing behavior", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  const settled = await turn(server.origin, id, { text: "hello" });
  assert.equal(settled.entries.find(entry => entry.role === "user")?.message.content, "hello");
  const oversized = "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4);
  for (const [images, pattern] of [
    [[{ ...image, mimeType: "text/plain" }], /image data/],
    [[{ ...image, data: oversized }], /10MB/],
    [[{ ...image, type: "text" }], /must be an image/],
  ] as [unknown, RegExp][]) {
    const rejected = await submit(server.origin, id, { text: "x", images });
    assert.equal(rejected.status, 400);
    const body = await rejected.json() as { code: string; message: string };
    assert.equal(body.code, "invalid_images");
    assert.match(body.message, pattern);
  }
  assert.equal((await submit(server.origin, id, { text: " " })).status, 400);
  // An empty image list is not an image submission, so the command still needs text.
  const emptyImages = await submit(server.origin, id, { text: "", images: [] });
  assert.equal(emptyImages.status, 400);
  assert.equal((await emptyImages.json() as { code: string }).code, "invalid_text");
  assert.equal((await submit(server.origin, id, { text: "", images: Array.from({ length: 11 }, () => image) })).status, 400);
  assert.equal(server.requests.length, 1, "a rejected submission never reaches the model");
});
