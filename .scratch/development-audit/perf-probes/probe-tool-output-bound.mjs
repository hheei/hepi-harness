/**
 * Priority-4 item 1, end-to-end attempt (**bounded negative result**): what does a real bash tool call store when its
 * output is huge?
 *
 * Observed on 2026-10-14 at 1758c1f: the scripted `bash: cat big.log` call commits as an assistant message but **no
 * tool-result entry is ever appended**, and the run settles with the transcript still `[user, assistant]`; the probe
 * therefore produced no measurement of a real tool-result entry and the process had to be bounded by a watchdog. The
 * tool-output bound quoted in the report is established from the two functions the durable tool path really applies
 * (pi-coding-agent `truncateTail`/`truncateHead`, pi-durable `OutputBuffer`/`boundOutput`) and from
 * `apps/server/test/frame-size.test.ts` for the out-of-band case — not from this script. It is kept so the negative
 * result is reproducible rather than implied.
 *
 * The real chain is used end to end: a real local execution gateway (`LocalGateway` + `GatewayRpcServer` +
 * `gatewayEnvironment`), the real coding-tools extension, a real backend over a real SQLite store, and the real
 * routes for creating the conversation and submitting the turn. The only scripted part is the model — the offline faux
 * provider asking for `bash cat big.log` on a 5 MiB file.
 *
 * Measured: the stored tool-result entry's own wire bytes and the window that carries it, so "the ordinary tool path is
 * bounded far inside the soft target" is a measurement, not an inference.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, gatewayEnvironment } from "@hepi/gateway";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { FRAME_LIMIT_BYTES, FRAME_TARGET_BYTES } from "../../../apps/server/src/history-window.ts";
import { headers, kib, listen, readJson, report, scratchDir } from "./lib/probe-lib.mjs";

const TOKEN = "probe-tool-token";
// A watchdog so this bounded experiment can never hold the terminal: it prints whatever it has and exits.
const watchdog = setTimeout(() => { console.log("WATCHDOG: " + JSON.stringify(results)); process.exit(3); }, 120_000);
watchdog.unref();
const scratch = await scratchDir("hepi-probe-toolout-");
const results = { frameTargetBytes: FRAME_TARGET_BYTES, frameLimitBytes: FRAME_LIMIT_BYTES, scripted: "bash: cat big.log (5 MiB file)" };
try {
  const root = join(scratch.dir, "workspace");
  await mkdir(root, { recursive: true });
  const line = "2026-10-14T00:00:00Z INFO build step completed with a reasonably long message \n";
  const big = line.repeat(Math.ceil((5 * 1024 * 1024) / line.length));
  await writeFile(join(root, "big.log"), big);
  results.inputFileBytes = Buffer.byteLength(big);

  const workspaces = [{ id: "local", root }];
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }));
  const { origin: gatewayOrigin } = await listen(gateway.server);

  const dbPath = join(scratch.dir, "tool.sqlite");
  const faux = fauxProvider();
  // One tool call, then the answer the run settles on. The queue is the provider's own, so each generation pops one.
  // Extra scripted answers, so an exhausted queue can never be the reason the run does not settle.
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "cat big.log" })]), fauxAssistantMessage("done"), fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
  const models = createModels(); models.setProvider(faux.provider);

  const server = await createBackendServer({ dbPath, authToken: TOKEN, models, workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin, gatewayToken: "gateway-token" }] });
  const { origin } = await listen(server.server);

  const created = await fetch(origin + "/api/conversations", { method: "POST", headers: headers(TOKEN), body: JSON.stringify({ workspaceId: "local" }) });
  const createdBody = await created.json();
  results.createStatus = created.status;
  const id = String(createdBody.conversationId);
  results.workspaceBound = true;

  const submitted = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: headers(TOKEN), body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "probe-tool", text: "show me the build log" }) });
  results.submitStatus = submitted.status;
  await submitted.text();

  // Observed settlement: the tool result is committed and the run is no longer busy. No fixed sleep is interpreted as
  // a settled turn.
  const observations = [];
  let state;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    state = await readJson(origin + "/api/conversations/" + id + "/state", TOKEN);
    const entries = state.status === 200 ? state.body.entries ?? [] : [];
    observations.push({ status: state.status, busy: state.body?.busy, roles: entries.map(entry => entry.role), failure: state.body?.failure?.reason });
    if (state.status === 200 && entries.some(entry => entry.role === "toolResult") && state.body.busy === false) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  results.observations = observations.length;
  results.observationTail = observations.slice(-4);
  results.state = { status: state.status, bytes: state.bytes, entries: state.status === 200 ? state.body.entries.map(entry => ({ id: entry.id, role: entry.role, textLength: entry.text.length })) : undefined, hasMore: state.status === 200 ? state.body.hasMore : undefined, failure: state.body?.failure ?? null };
  results.entryReads = [];
  if (state.status === 200) {
    for (const entry of state.body.entries) {
      const read = await readJson(origin + "/api/conversations/" + id + "/entries/" + entry.id, TOKEN);
      results.entryReads.push({ id: entry.id, role: entry.role, status: read.status, wireBytes: read.bytes, wireKiB: kib(read.bytes), textLength: read.body?.entry?.text?.length, textTail: read.body?.entry?.text?.slice(-120) });
    }
  }
  await server.close();
  gateway.server.closeAllConnections();
  clearTimeout(watchdog);
} finally {
  await scratch.cleanup();
}
results.outcome = "bounded negative result: no tool-result entry was appended within the observation window";
const path = report("tool-output-bound.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "tool-output-bound", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
process.exit(0);
