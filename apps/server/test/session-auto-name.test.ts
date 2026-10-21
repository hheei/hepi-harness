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

const token = "auto-name-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const MODEL_ID = "deepseek-v4.1-flash";
const RUN_REPLY = "saw it";
/** The two upstream strings a naming request is recognised by: its own system prompt and its own prompt tail. */
const TITLE_SYSTEM_PROMPT = "You name chat sessions from a transcript. Reply with the title only.";
const TITLE_PROMPT_OPENING = "Create a concise title for this session based on the conversation above.";

type Captured = { path: string; body: Record<string, unknown> };
type Controlled = { origin: string; requests: Captured[]; setTitle: (title: string) => void; failNext: () => void };

/** One OpenAI-completions endpoint. A request carrying the title system prompt is a naming request; everything else is a run. */
async function controlledEndpoint(t: TestContext): Promise<Controlled> {
  const requests: Captured[] = [];
  let title = "Release checklist";
  let failures = 0;
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ path: request.url ?? "", body });
      if (failures > 0) { failures -= 1; response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "the provider refused this request" } })); return; }
      const content = isTitleRequest(body) ? title : RUN_REPLY;
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    origin: "http://127.0.0.1:" + address.port,
    requests,
    setTitle: (value: string) => { title = value; },
    failNext: () => { failures += 1; },
  };
}

/** True for the naming request: it carries the reused title system prompt, which no ordinary run does. */
/** The provider adapter renders the leading system message as `developer` for some catalogs; either role is it. */
function isTitleRequest(body: Record<string, unknown>): boolean {
  const messages = body.messages as { role?: string; content?: unknown }[] | undefined;
  const leading = messages?.find(message => message.role === "system" || message.role === "developer");
  return typeof leading?.content === "string" && leading.content.includes(TITLE_SYSTEM_PROMPT);
}

const titleRequests = (requests: Captured[]): Captured[] => requests.filter(request => isTitleRequest(request.body));
const runRequests = (requests: Captured[]): Captured[] => requests.filter(request => !isTitleRequest(request.body));
/** The one user turn of a title request: the bounded transcript followed by the reused prompt. */
function titleTranscript(request: Captured): string {
  const messages = request.body.messages as { role?: string; content?: unknown }[];
  const user = messages.find(message => message.role === "user");
  const content = user?.content;
  // The provider adapter renders a single text block as that block's own text for some catalogs and as a block list
  // for others; either is the transcript this backend sent.
  if (typeof content === "string") return content;
  assert.ok(Array.isArray(content));
  return (content as { type?: string; text?: string }[]).filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

async function start(t: TestContext, dbPath?: string, configured = true): Promise<{ backend: BackendServer; origin: string; requests: Captured[]; dbPath: string; models: MutableModels; endpoint: Controlled }> {
  const endpoint = await controlledEndpoint(t);
  const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: MODEL_ID, HEPI_PROVIDER_BASE_URL: endpoint.origin + "/v1", HEPI_PROVIDER_API_KEY: "secret-key" });
  assert.ok(custom);
  const directory = dbPath === undefined ? await mkdtemp(join(tmpdir(), "hepi-auto-name-")) : undefined;
  if (directory !== undefined) directories.push(directory);
  const path = dbPath ?? join(directory!, "auto-name.sqlite");
  // A backend with no configured model keeps the reference absent rather than inventing one, which is the failure the
  // naming request has to report instead of writing a name.
  const backend = configured
    ? await createBackendServer({ dbPath: path, authToken: token, models: custom.models, defaultModel: custom.defaultModel })
    : await createBackendServer({ dbPath: path, authToken: token, models: custom.models, defaultModel: null });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, requests: endpoint.requests, dbPath: path, models: custom.models as MutableModels, endpoint };
}

type Row = { id: string; title: string | null };
async function catalogue(origin: string): Promise<Row[]> {
  const response = await fetch(origin + "/api/conversations", { headers });
  assert.equal(response.status, 200);
  return (await response.json() as { conversations: Row[] }).conversations;
}
async function named(origin: string, id: string): Promise<string | null | undefined> {
  return (await catalogue(origin)).find(row => row.id === id)?.title;
}
async function conversation(origin: string): Promise<string> {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers });
  assert.equal(created.status, 201);
  return (await created.json() as { conversationId: string }).conversationId;
}
const autoName = (origin: string, id: string): Promise<Response> =>
  fetch(origin + "/api/conversations/" + id + "/auto-name", { method: "POST", headers });
const rename = (origin: string, id: string, name: string): Promise<Response> =>
  fetch(origin + "/api/conversations/" + id, { method: "PATCH", headers, body: JSON.stringify({ name }) });
type Entry = ServerSnapshot["entries"][number];
/** One frame as a client receives it: the event, its own payload, and the state a client holds after folding it. */
type Observed = { readonly event: string; readonly data: unknown; readonly window: HeldWindow<Entry> };

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
          frames.push({ event, data, window: folder.current() });
        }
      }
    },
    async close() { await reader.cancel().catch(() => {}); },
  };
}

/** The frame that states the turn is over: the run's answer is committed and nothing is in flight. */
const answered = (revision: number, text: string) => (frame: Observed): boolean =>
  (frame.event === "state" || frame.event === "snapshot")
  && !frame.window.busy
  && frame.window.revision > revision
  && frame.window.entries.some(entry => entry.role === "assistant" && entry.text === text);

/** Run one real turn and settle on the assistant reply, so the transcript the naming request reads exists. */
async function runTurn(origin: string, id: string, text: string): Promise<void> {
  const stream = await openStream(origin, id);
  try {
    const before = await stream.follow(frame => frame.event === "snapshot", "the baseline snapshot");
    const submitted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", requestId: "run-" + Math.random(), type: "conversation.submit", text }) });
    assert.equal(submitted.status, 202);
    await stream.follow(answered(before.window.revision, RUN_REPLY), "the answer to " + JSON.stringify(text));
  } finally { await stream.close(); }
}

test("an explicit auto-name request names the session from its own transcript", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "Plan the release checklist");
  assert.equal(await named(server.origin, id), null, "a conversation that ran turns is still unnamed");

  const answer = await autoName(server.origin, id);
  assert.equal(answer.status, 200);
  const body = await answer.json() as { protocol: string; conversationId: string; title: string };
  assert.equal(body.protocol, "hepi.v1");
  assert.equal(body.conversationId, id);
  assert.equal(body.title, "Release checklist");
  // The name is the hepi title state ticket 02 owns: the same catalogue read that lists the session carries it.
  assert.equal(await named(server.origin, id), "Release checklist");

  // The generation call is made from what this backend has: the reused prompt shape, the reused transcript budget
  // and the conversation's own transcript, with a one-shot request that reuses no live prefix.
  const [request] = titleRequests(server.requests);
  assert.ok(request, "the naming request reached the model endpoint");
  assert.equal(request.body.model, MODEL_ID);
  // The reused cap, under whichever field this provider's adapter names it: the request carries no other budget.
  assert.equal(request.body.max_tokens ?? request.body.max_completion_tokens, 256);
  const transcript = titleTranscript(request);
  assert.ok(transcript.includes("User: Plan the release checklist"), "the transcript carries the user's own turn: " + transcript.slice(0, 200));
  assert.ok(transcript.includes("Assistant: " + RUN_REPLY), "the transcript carries what came out of it");
  assert.ok(transcript.includes(TITLE_PROMPT_OPENING), "the reused prompt shape is sent");
  assert.ok(transcript.indexOf(TITLE_PROMPT_OPENING) > transcript.indexOf("User: Plan the release checklist"), "the prompt follows the transcript");
  assert.equal(runRequests(server.requests).length, 1, "only the run called the model, and it is not a naming request");
});

test("creating and running a conversation never names it by itself", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "An ordinary turn");
  await runTurn(server.origin, id, "Another turn");
  assert.equal(await named(server.origin, id), null, "nothing names a session implicitly");
  assert.deepEqual(titleRequests(server.requests), [], "no naming request was made without being asked");
  assert.equal(runRequests(server.requests).length, 2);
});

test("a name the user typed is kept until an explicit request replaces it", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  assert.equal((await rename(server.origin, id, "Mine")).status, 200);
  await runTurn(server.origin, id, "Keep my name");
  assert.equal(await named(server.origin, id), "Mine", "a run never replaces a typed name");
  assert.deepEqual(titleRequests(server.requests), []);

  const answer = await autoName(server.origin, id);
  assert.equal(answer.status, 200);
  assert.equal((await answer.json() as { title: string }).title, "Release checklist");
  assert.equal(await named(server.origin, id), "Release checklist", "only the explicit request replaces it");
});

test("a generation failure leaves the previous name in place and reports the failure", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "First turn");
  assert.equal((await rename(server.origin, id, "Kept")).status, 200);

  server.endpoint.failNext();
  const refused = await autoName(server.origin, id);
  assert.equal(refused.status, 502);
  assert.match((await refused.json() as { error: string }).error, /refused this request/);
  assert.equal(await named(server.origin, id), "Kept", "the previous name survives a failed generation");

  const answer = await autoName(server.origin, id);
  assert.equal(answer.status, 200, "the next explicit request is not poisoned by the failure");
  assert.equal(await named(server.origin, id), "Release checklist");
});

test("a conversation with no model configured reports that instead of naming anything", async (t) => {
  const server = await start(t, undefined, false);
  const id = await conversation(server.origin);
  const refused = await autoName(server.origin, id);
  assert.equal(refused.status, 409);
  const body = await refused.json() as { code: string; error: string };
  assert.equal(body.code, "no_model");
  assert.match(body.error, /no model is configured/i);
  assert.equal(await named(server.origin, id), null);
  assert.deepEqual(titleRequests(server.requests), [], "nothing was asked of a model that does not exist");
});

test("a selected model the catalog no longer serves is reported by name instead of being named from", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "First turn");
  // The selection is not rewritten when the catalog stops serving it (ticket 13), so the naming request names the
  // model rather than writing a name from a request it never made.
  server.models.deleteProvider("magpie");
  const refused = await autoName(server.origin, id);
  assert.equal(refused.status, 409);
  const body = await refused.json() as { code: string; error: string };
  assert.equal(body.code, "no_model");
  assert.match(body.error, /magpie\/deepseek-v4\.1-flash is not available/);
  assert.equal(await named(server.origin, id), null);
  assert.deepEqual(titleRequests(server.requests), [], "nothing was asked of a model the catalog no longer serves");
});

test("a conversation with no usable text is refused with a readable reason, and a removed one with its own", async (t) => {
  const server = await start(t);
  const empty = await conversation(server.origin);
  const refused = await autoName(server.origin, empty);
  assert.equal(refused.status, 409);
  const body = await refused.json() as { code: string; error: string };
  assert.equal(body.code, "no_transcript");
  assert.match(body.error, /no usable text/);
  assert.equal(await named(server.origin, empty), null);

  const removed = await conversation(server.origin);
  await runTurn(server.origin, removed, "Removed later");
  assert.equal((await fetch(server.origin + "/api/conversations/" + removed, { method: "DELETE", headers })).status, 200);
  const gone = await autoName(server.origin, removed);
  assert.equal(gone.status, 409);
  assert.equal((await gone.json() as { code: string }).code, "session_deleted");
  // A removed conversation leaves the catalogue, so its absence is what says no name was written for it.
  assert.equal(await named(server.origin, removed), undefined);
  assert.deepEqual(titleRequests(server.requests), []);
});

test("the generated name is bounded by the reused length cap and the transcript by the reused budget", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "x".repeat(900));
  server.endpoint.setTitle("y".repeat(200));

  const answer = await autoName(server.origin, id);
  assert.equal(answer.status, 200);
  const stored = (await answer.json() as { title: string }).title;
  assert.equal([...stored].length, 80, "the stored name is the reused cap, never cut in half: " + stored.length);
  assert.equal(await named(server.origin, id), stored);

  // The per-message cap of the reused transcript budget: the long turn arrives clipped, with the elision marker.
  const transcript = titleTranscript(titleRequests(server.requests)[0]!);
  assert.ok(transcript.includes("User: " + "x".repeat(800) + "\u2026"), "the user turn is clipped to the reused per-message cap");
  assert.ok(!transcript.includes("x".repeat(801)), "no more than the budget reaches the model");
});

test("a naming request is made from the conversation's own committed transcript, not from a live run", async (t) => {
  const server = await start(t);
  const id = await conversation(server.origin);
  await runTurn(server.origin, id, "First");
  await runTurn(server.origin, id, "Second");
  assert.equal((await autoName(server.origin, id)).status, 200);
  const transcript = titleTranscript(titleRequests(server.requests)[0]!);
  assert.ok(transcript.includes("User: First") && transcript.includes("User: Second"), "every user turn of the conversation is read");
  assert.ok(!transcript.includes(RUN_REPLY + " " + RUN_REPLY), "nothing is invented between the transcript and the prompt");
});

test("the name survives a backend restart, like the rename it shares state with", async (t) => {
  const first = await start(t);
  const id = await conversation(first.origin);
  await runTurn(first.origin, id, "Durable name");
  assert.equal((await autoName(first.origin, id)).status, 200);
  await first.backend.close();

  const second = await start(t, first.dbPath);
  assert.equal(await named(second.origin, id), "Release checklist");
});
