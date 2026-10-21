/**
 * Ticket 04's stages: the recovery windows the capability audit left unmeasured, each reached by a real process.
 *
 * Each stage is its own process over the test's own SQLite file, and prints one JSON line of the facts it read at its
 * own window. A stage that reaches no window fails instead of hanging, so a green run can never be read as a kill
 * nobody made.
 *
 * - `child-bash` (gap G3): a delegated child runs `bash` on a gateway **process** the test started, and this stage ends
 *   that process with `SIGKILL` mid-command. What the child is then told is read from its own committed transcript —
 *   the model seam, before any reopen — together with the durable identities the dispatch carries. The process that
 *   dies here is the execution host, and the test that started it ends it, so this stage exits on its own once the
 *   loss has been answered and reported.
 * - `mid-generation` (gap G4): the answer streams slowly enough that the runtime commits a partial. The stage reads
 *   that partial back through the product's own state route and then kills **itself**, so the store holds exactly what
 *   a dead process had committed and nothing after it.
 * - `anchor-legacy` / `anchor-v2` (gap G5): a real delegation admitted by a real anchor task, then the process dies
 *   inside the admission. The one difference between the two stores is the **version stamped on the anchor record**,
 *   which is what a build behind or ahead of this one either cannot take at all or cannot take without a migration.
 *
 * Usage: node test/recovery-acceptance-child.ts <stage> <dbPath> <base> [gatewayOrigin]
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryRecord, TaskId } from "@earendil-works/pi-durable";
import { DispatchDoc } from "../src/subagents/host.ts";
import { createBackendServer } from "../src/server.ts";
import { openCrashHarness, CRASH_WORKSPACE, type CrashHarness } from "./subagents-crash-harness.ts";
import { MigratedFutureAnchorTask } from "./subagent-anchor-v2.ts";
import { LegacyAnchorTask } from "./subagent-legacy-anchor.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";

const [, , stage, dbPath, base, gatewayOrigin] = process.argv;
assert.ok(dbPath !== undefined && base !== undefined, "usage: recovery-acceptance-child <stage> <db> <base> [gatewayOrigin]");
const TOKEN = "recovery-acceptance-token";
const headers = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };
const root = join(base, "workspace");
const home = join(base, "home");
/** The command's one durable effect: its line count is the replay evidence, stronger than any status field. */
const effectPath = join(root, "effect.log");
/** One line, then the host that owed the answer is ended: the call was admitted, dispatched and is unanswered. */
const HANGING_COMMAND = "printf running >> effect.log; sleep 60";
/** Long enough, and paced finely enough, that the runtime commits a partial of it before the answer ends. */
const STREAMED_TEXT = Array.from({ length: 120 }, (_value, index) => "tok-" + index).join(" ");

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent"), { recursive: true });

type Snapshot = {
  busy: boolean;
  partial: string;
  entries: { id: string; role: string; text: string; message: { stopReason?: string; isError?: boolean; toolName?: string } }[];
};

async function readState(origin: string, conversationId: string): Promise<Snapshot> {
  const answer = await fetch(origin + "/api/conversations/" + conversationId + "/state", { headers });
  assert.equal(answer.status, 200, await answer.clone().text());
  return await answer.json() as Snapshot;
}

async function waitFor<T>(ready: () => Promise<T | undefined>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await ready();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(25);
  }
}

const effects = async (): Promise<string[]> => (await readFile(effectPath, "utf8").catch(() => "")).split("\n").filter(Boolean);

/** The last user text of a transcript, which is what decides whose turn the controlled model is answering. */
function lastUserText(messages: readonly { role: string; content?: unknown }[]): string {
  const last = messages.findLast(message => message.role === "user");
  return last === undefined ? "" : contentText(last.content as never);
}

/** One committed entry as its role or kind and the text its model was given. */
function projectEntry(entry: EntryRecord): [string, string] {
  return [entry.kind ?? "", entry.model === undefined ? "" : contentText(entry.model[0]?.content as never)];
}

function kill(facts: Record<string, unknown>): never {
  console.log(JSON.stringify({ stage, ...facts }));
  process.kill(process.pid, "SIGKILL");
  return undefined as never;
}

if (stage === "child-bash") {
  assert.ok(gatewayOrigin !== undefined, "the child-bash stage is given the gateway origin the test started");
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - bash\ncontext: fresh\n---\n\nRun the command you are given, once.\n");
  await writeFile(effectPath, "");
  const crash: CrashHarness = await openCrashHarness(dbPath, {
    root,
    home,
    // The child's commands go to the **process** the test started; the composed in-process host still serves the files,
    // so the only thing that differs from every other crash fixture here is where a command runs.
    executionGateway: { gatewayId: "workstation", origin: gatewayOrigin, token: TOKEN },
    script: (faux: FauxProviderHandle) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
        if (messages.some(message => message.role === "toolResult" && message.toolName === "bash")) return fauxAssistantMessage("child settled");
        if (messages.some(message => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
        if (lastUserText(messages) === "child work") return fauxAssistantMessage([fauxToolCall("bash", { command: HANGING_COMMAND }, { id: "call-hang" })], { stopReason: "toolUse" });
        return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-anchor" })], { stopReason: "toolUse" });
      };
      faux.setResponses([respond]);
    },
  });
  const parent = await crash.operations.spawn({
    requestId: "recovery-03-parent",
    ownership: { kind: "ownerless" },
    workspaceId: CRASH_WORKSPACE,
    agent: { model: SERVER_MODEL, extensions: [crash.extension] },
  });
  const parentId = String(parent.conversationId);
  await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "recovery-03-turn" }, BACKGROUND_CONTEXT);
  const dispatchId = parentId + ":call-anchor";
  const admitted = await waitFor(async () => {
    const record = await crash.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);
    return record?.childConversationId === undefined ? undefined : record;
  }, "the anchor to create and admit its child");
  const childId = String(admitted.childConversationId);
  // The host that owed the answer was ended by the test that started it, at the window this stage's own command effect
  // states. Nothing arrives now: the answer that never comes is the window, and what the child is told instead is
  // committed to its own transcript, which is the seam its model reads.
  const settled = await waitFor(async () => {
    const child = await crash.harness.harness.conversation(Number(childId) as ConversationId, BACKGROUND_CONTEXT);
    assert.ok(child !== undefined, "the delegated child conversation exists");
    const page = await child.entries({}, 50, undefined, BACKGROUND_CONTEXT);
    const toolResults = page.items.filter((entry: EntryRecord) => entry.kind === "pi.tool-result");
    return toolResults.length === 0 ? undefined : { child, toolResults };
  }, "the child's tool result after its execution host died");
  const message = settled.toolResults[0]!.model?.[0] as { content?: unknown; isError?: boolean } | undefined;
  const context = await settled.child.context(BACKGROUND_CONTEXT);
  // The child's own report reaches its parent through the reporter task, which is a separate durable run: wait for the
  // parent to have been told, so the facts state a settled delegation rather than a half-read one.
  const reported = await waitFor(async () => {
    const source = await crash.harness.harness.conversation(Number(parentId) as ConversationId, BACKGROUND_CONTEXT);
    if (source === undefined) return undefined;
    const entries = (await source.context(BACKGROUND_CONTEXT)).entries.map(projectEntry);
    return entries.some(entry => entry[1].includes("finished with status")) ? entries : undefined;
  }, "the parent to be told its child finished");
  const inspection = await crash.harness.harness.inspect(BACKGROUND_CONTEXT);
  const facts = {
    stage,
    parentId,
    childId,
    dispatchId,
    anchorTaskId: String(admitted.anchorTaskId ?? ""),
    reporterTaskId: String(admitted.reporterTaskId ?? ""),
    submissionId: String(admitted.submissionId ?? ""),
    resultText: contentText(message?.content as never),
    resultIsError: message?.isError === true,
    resultCount: settled.toolResults.length,
    // What the child's model was handed after the loss, oldest first: the transcript its next request reads.
    childTranscript: context.entries.map(projectEntry),
    // The parent's own transcript: the report the child's run produced, which the lost command does not change.
    parentTranscript: reported,
    // The live work each conversation holds afterwards, as the runtime states it. Nothing here is a run the loss made up.
    tasks: inspection.tasks.filter(task => [parentId, childId].includes(String(task.record.conversationId)))
      .map(task => ({ conversation: String(task.record.conversationId), kind: task.record.kind, background: task.record.background === true, state: task.state.kind })),
    effects: await effects(),
  };
  await crash.close();
  console.log(JSON.stringify(facts));
  process.exit(0);
} else if (stage === "mid-generation") {
  // One token per chunk, paced: whether a partial exists, and how far it got, stay the runtime's own facts.
  const faux = fauxProvider({ tokensPerSecond: 300, tokenSize: { min: 1, max: 1 } });
  const respond: FauxResponseFactory = async (transcript) => {
    faux.setResponses([respond]);
    return fauxAssistantMessage(lastUserText(transcript.messages as readonly { role: string; content?: unknown }[]) === "stream the answer" ? STREAMED_TEXT : "idle");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  // A partial commit every 5 ms, so the window is the runtime's own progress policy and not a sleep.
  const backend = await createBackendServer({ dbPath, authToken: TOKEN, models, defaultModel: SERVER_MODEL, settings: { progress: { partialIntervalMs: 5 } } });
  await new Promise<void>((resolveListen) => backend.server.listen(0, "127.0.0.1", resolveListen));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({}) })).json() as { conversationId: string };
  const parentId = created.conversationId;
  const submitted = await fetch(origin + "/api/conversations/" + parentId + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "stream-1", text: "stream the answer" }) });
  assert.equal(submitted.status, 202, await submitted.clone().text());
  // The committed partial is read back through the product's own state route: what that route states, the store holds.
  const partial = await waitFor(async () => {
    const current = await readState(origin, parentId);
    return current.partial.startsWith("tok-0 tok-1 tok-2") ? current.partial : undefined;
  }, "a committed partial of the streaming answer");
  const before = await readState(origin, parentId);
  kill({ parentId, partial, busy: before.busy, providerRequests: faux.state.callCount, committedAnswer: before.entries.some(entry => entry.role === "assistant"), fullText: STREAMED_TEXT });
} else if (stage === "anchor-legacy" || stage === "anchor-v2") {
  await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");
  const crash: CrashHarness = await openCrashHarness(dbPath, {
    root,
    home,
    script: (faux: FauxProviderHandle) => {
      const respond: FauxResponseFactory = async (transcript) => {
        faux.setResponses([respond]);
        const messages = transcript.messages as readonly { role: string; content?: unknown; toolName?: string }[];
        if (messages.some(message => message.role === "toolResult" && message.toolName === "agent_spawn")) return fauxAssistantMessage("parent done");
        if (lastUserText(messages) === "delegate") return fauxAssistantMessage([fauxToolCall("agent_spawn", { name: "worker", task: "child work" }, { id: "call-anchor" })], { stopReason: "toolUse" });
        return fauxAssistantMessage("child answer");
      };
      faux.setResponses([respond]);
    },
    // The one difference between the two stores: which definition reserved the anchor record, and so which version is
    // stamped on it. Everything else is the real composition, the real `agent_spawn` tool and the real storage. Both
    // admit without creating a reporter, so the only live task the parent holds afterwards is its own anchor.
    tasks: stage === "anchor-v2" ? [MigratedFutureAnchorTask] : [LegacyAnchorTask],
  });
  const parent = await crash.operations.spawn({
    requestId: "anchor-parent",
    ownership: { kind: "ownerless" },
    workspaceId: CRASH_WORKSPACE,
    agent: { model: SERVER_MODEL, extensions: [crash.extension] },
  });
  const parentId = String(parent.conversationId);
  await parent.conversation.submit({ type: "input", content: [{ type: "text", text: "delegate" }], requestId: "anchor-turn" }, BACKGROUND_CONTEXT);
  const dispatchId = parentId + ":call-anchor";
  const admitted = await waitFor(async () => {
    const record = await crash.harness.harness.snapshot(DispatchDoc, Number(parentId) as ConversationId, dispatchId, BACKGROUND_CONTEXT);
    return record?.submissionId === undefined ? undefined : record;
  }, "the anchor to admit the child");
  const stored = await crash.harness.harness.commit(tx => tx.task(Number(admitted.anchorTaskId) as TaskId), BACKGROUND_CONTEXT);
  assert.ok(stored !== undefined, "the admitted anchor task's record is readable");
  kill({
    parentId,
    childId: String(admitted.childConversationId ?? ""),
    dispatchId,
    submissionId: String(admitted.submissionId),
    anchorTaskId: String(admitted.anchorTaskId ?? ""),
    anchorKind: stored.kind,
    anchorVersion: stored.version,
    anchorState: stored.state.status,
    anchorPhase: (stored.state.checkpoint as { phase?: string } | undefined)?.phase,
  });
} else {
  throw new Error("unknown stage " + String(stage));
}

// Every window above ends a process or exits deliberately; reaching here would state a kill that never happened.
process.exit(1);
