/**
 * The running poll's bandwidth, over real HTTP against a real Backend: 1,000 sessions with two of them running.
 *
 * Read-only, no model call, no sleep, no clock: the store is `:memory:`, and the fixture's turns settle because the
 * scripted provider answers them. The two reads measured are the ones the sidebar actually makes — the full catalogue
 * that used to answer its poll, and the compact answer that replaces it — so the difference below is the difference the
 * repair makes on the wire, not a projection of one payload into another.
 *
 * What this does **not** claim: the compact read is not constant-time. Both reads walk the same catalogue and project
 * the same rows; only the answer is smaller, so the store/CPU cost behind a poll is O(sessions) either way. The measured
 * work below is the HTTP round trip and JSON serialization/parse of each answer, reported as median and p95 so a reader
 * can see the spread rather than a single number.
 *
 * Compression is reported **separately** and is not applied by the Backend: these are the sizes each payload would
 * become if a transport compressed it, which is what a deployment behind a compressing proxy would serve.
 *
 * Usage: node apps/server/scripts/perf-running-poll.mjs [--json=<path>]
 * Never run on the runtime host (AGENTS.md).
 */
import { createGzip, createBrotliCompress, constants } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { contentText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createBackendServer } from "../src/server.ts";
import { SERVER_MODEL } from "../test/faux-fixture.ts";

const TOKEN = "perf-running-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const SESSIONS = Number(process.env.SESSIONS ?? 1000);
const RUNNING = 2;
const WARMUP = 5;
const SAMPLES = 25;

const round = (value) => Math.round(value * 1000) / 1000;
const stats = (samples) => {
  const sorted = [...samples].sort((left, right) => left - right);
  return { medianMs: round(sorted[Math.floor(sorted.length / 2)]), p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)), samples: samples.length };
};

/** One payload's size after a compressor, so compression is reported as its own fact rather than mixed into the wire. */
async function compressed(bytes, transform) {
  const chunks = [];
  await pipeline(Readable.from([Buffer.from(bytes)]), transform, new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
  return Buffer.concat(chunks).length;
}

/**
 * One Backend over in-memory storage whose conversations are seeded through its own public create route.
 *
 * The provider answers every seeded turn, and holds a turn whose text starts with `hold:`. `entered` resolves once such
 * a turn has really reached the model, so "two conversations are running" is a state this script creates and waits for
 * as an event, never a delay it hopes is long enough.
 */
async function backend() {
  const faux = fauxProvider();
  const held = [];
  let entered;
  const enteredOnce = new Promise((resolve) => { entered = resolve; });
  const respond = async (transcript) => {
    faux.setResponses([respond]);
    const last = transcript.messages.findLast((message) => message.role === "user");
    const text = last === undefined ? "" : contentText(last.content);
    if (text.startsWith("hold:")) {
      entered();
      await new Promise((resolve) => { held.push(resolve); });
    }
    return fauxAssistantMessage("ok");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  const server = await createBackendServer({ dbPath: ":memory:", authToken: TOKEN, models, defaultModel: SERVER_MODEL });
  await new Promise((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  return { origin: "http://127.0.0.1:" + server.server.address().port, server, entered: enteredOnce, release: () => { for (const resolve of held.splice(0)) resolve(); } };
}

const create = async (origin) => {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) });
  if (response.status !== 201) throw new Error("create refused: " + response.status);
  return (await response.json()).conversationId;
};

/** Admit one turn and wait for its answer, so the conversation really has the preview and title a row renders. */
async function turn(origin, id, requestId) {
  const admitted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "Session " + id + " asks about the ordinary thing number " + requestId }) });
  if (admitted.status !== 202) throw new Error("admission refused: " + admitted.status);
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const state = await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json();
    if (state.busy === false && state.entries.length >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("the turn never settled");
}

const run = await backend();
try {
  const ids = [];
  for (let index = 0; index < SESSIONS; index += 1) ids.push(await create(run.origin));
  // Every conversation carries a real committed turn, so a row has the preview, count and last-run facts the list
  // renders rather than an empty shell that would flatter the full read's size.
  for (const [index, id] of ids.entries()) await turn(run.origin, id, "seed-" + index);
  // Two conversations keep a run in flight, which is what the poll is asked about: the provider holds their answers, and
  // the wait is the event that the model was really entered rather than a delay.
  const running = ids.slice(0, RUNNING);
  for (const [index, id] of running.entries()) {
    const admitted = await fetch(run.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "hold-" + index, text: "hold: a run this poll must see" }) });
    if (admitted.status !== 202) throw new Error("hold admission refused: " + admitted.status);
  }
  await run.entered;
  for (const id of running) {
    const state = await (await fetch(run.origin + "/api/conversations/" + id + "/state", { headers })).json();
    if (state.busy !== true) throw new Error("conversation " + id + " is not running, so the poll would be measured on an idle catalogue");
  }

  const fullUrl = run.origin + "/api/conversations";
  const compactUrl = run.origin + "/api/conversations?running=compact";
  const fullBody = await (await fetch(fullUrl, { headers })).text();
  const compactBody = await (await fetch(compactUrl, { headers })).text();
  const fullBytes = Buffer.byteLength(fullBody);
  const compactBytes = Buffer.byteLength(compactBody);
  const full = JSON.parse(fullBody);
  const compact = JSON.parse(compactBody);

  const time = async (url) => {
    const samples = [];
    for (let index = 0; index < WARMUP + SAMPLES; index += 1) {
      const started = performance.now();
      const response = await fetch(url, { headers });
      const body = await response.text();
      JSON.parse(body);
      const elapsed = performance.now() - started;
      if (index >= WARMUP) samples.push(elapsed);
    }
    return stats(samples);
  };

  console.log(JSON.stringify({
    kind: "metadata",
    sha: process.env.SHA ?? "dirty",
    node: process.version,
    date: new Date().toISOString(),
    fixture: { sessions: ids.length, running: running.length, storage: ":memory:", turnsPerSession: 1, transport: "real HTTP, loopback", samples: SAMPLES, warmup: WARMUP },
    timing: "wall ms per full round trip (request + JSON.parse) after warmup; no sleeps in the measured region",
    compression: "sizes are what each payload becomes under gzip/br if a transport compressed it; the Backend itself applies neither",
    serverWork: "O(sessions) for both reads: the compact answer is smaller, the scan and projection are the same",
  }));

  console.log(JSON.stringify({
    kind: "catalogue",
    sessions: ids.length,
    running: running.length,
    full: { bytes: fullBytes, rows: full.conversations.length, timing: await time(fullUrl) },
    compact: { bytes: compactBytes, ids: compact.runningConversationIds.length, timing: await time(compactUrl) },
    reduction: { bytes: fullBytes - compactBytes, percent: round(100 * (fullBytes - compactBytes) / fullBytes), factor: round(fullBytes / compactBytes) },
    equivalence: {
      runningMatchesList: JSON.stringify(compact.runningConversationIds) === JSON.stringify(full.conversations.filter((row) => row.busy).map((row) => row.id)),
      listVersionMatches: compact.sessionListVersion === full.sessionListVersion,
      sidebarRevisionMatches: compact.sidebarStateRevision === full.sidebarStateRevision,
      projectsRevisionMatches: compact.projectsRevision === full.projectsRevision,
      carriesNoRows: !("conversations" in compact),
    },
    compression: {
      fullGzip: await compressed(fullBody, createGzip()),
      compactGzip: await compressed(compactBody, createGzip()),
      fullBrotli: await compressed(fullBody, createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
      compactBrotli: await compressed(compactBody, createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
    },
    pollsPerMinute: 24,
    hourly: { fullMiB: round(fullBytes * 24 * 60 / 1024 ** 2), compactMiB: round(compactBytes * 24 * 60 / 1024 ** 2) },
  }));
} finally {
  run.release();
  run.server.server.closeAllConnections();
  await run.server.close();
}
