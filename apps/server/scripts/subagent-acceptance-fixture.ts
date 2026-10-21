/**
 * Controlled backend for ticket 13's combined browser journey: a real backend on a real local execution host, one
 * conversation with delegation on, and a seeded child whose history carries a compaction, an inherited attachment and a
 * structured reference — so one browser session can drive the quick create, the child tree, the late report's per-item
 * decisions, the raw history, a reference and a fork against the same store.
 *
 * The gateway, the backend and the workspace live in this process; the model endpoint is the driver's own controlled
 * OpenAI-completions server. Nothing here contacts a paid provider and nothing here is a second runtime: the child, its
 * anchor and the reporter are the real native tasks the production composition installs.
 *
 * Usage: node scripts/subagent-acceptance-fixture.ts   (driven by apps/web/e2e/ux-system-acceptance.mjs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, UserEntry, type EntryId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GatewayRpcServer, LocalGateway, gatewayEnvironment } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer } from "../src/server.ts";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createConversationOperations, WorkspaceDoc } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SubagentAnchorTask } from "../src/subagents/anchor.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { defineExtension } from "@earendil-works/pi-durable";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const base = process.env.HEPI_UX13_FIXTURE ?? "";
const dbPath = process.env.HEPI_UX13_DB ?? "";
const port = Number(process.env.HEPI_UX13_BACKEND_PORT ?? 44131);
const token = process.env.HEPI_UX13_AUTH ?? "ux-system-acceptance-token";
const model = process.env.HEPI_UX13_MODEL ?? "controlled-1";
const endpoint = process.env.HEPI_UX13_ENDPOINT ?? "";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_UX13_FIXTURE, HEPI_UX13_DB and HEPI_UX13_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await mkdir(join(home, ".pi", "agent", "agents"), { recursive: true });
// A real project definition on the workspace's own host, which is what a delegation resolves.
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\nmodel: magpie/controlled-1\nthinking: off\n---\n\nAnswer the task briefly.\n");

/** The tiny real PNG the seeded image block carries; the read policy checks the declared mime and decoded size. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
const gateway = new GatewayRpcServer(
  new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
  undefined,
  new GatewayFiles(workspaces, { identity: { user: "operator", home } }),
  new LocalInstallServer(workspaces, { identity: { user: "operator", home } }),
);
await new Promise<void>((resolveListen) => gateway.server.listen(0, "127.0.0.1", resolveListen));
const gatewayAddress = gateway.server.address();
if (gatewayAddress === null || typeof gatewayAddress !== "object") throw new Error("the gateway did not start");
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };

const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: endpoint + "/v1", HEPI_PROVIDER_API_KEY: "controlled-key" });
if (custom === undefined) throw new Error("the controlled provider configuration was rejected");

/** The identities the driver opens, reads and forks: a child with a compacted prefix, an attachment and a reference. */
type Seed = { sessionId: string; childId: string; preCompactionEntryId: string; imageEntryId: string; keptEntryId: string; summaryEntryId: string };

async function seed(): Promise<Seed> {
  // The seed runs **before** the backend starts: the backend attaches every listed conversation at boot, so a second
  // writer on the same file would be a second session rather than a fixture.
  const seeding = await openServerHarness(dbPath, custom!.defaultModel, custom!.models, async (target, context) => {
    const stored = await target.read.snapshot(WorkspaceDoc, target.conversationId, context);
    return stored?.workspaceId === undefined ? undefined : gatewayEnvironment(binding, target.cwd ?? "/");
  }, { startPaused: true });
  // The anchor definition is installed so the records this seed creates are resumable by the process that serves the
  // browser, exactly as the backend will when it resumes.
  seeding.install(defineExtension({ name: "hepi-subagents", tasks: [SubagentAnchorTask] }));
  const harness = seeding.harness;
  const operations = createConversationOperations(harness);
  // The parent is an ordinary conversation with a model of its own, created through the one creation seam so the
  // browser journey drives the same kind of conversation a person has.
  const parent = await operations.spawn({
    requestId: "seed-parent",
    ownership: { kind: "ownerless" },
    workspaceId: "local",
    ...(custom!.defaultModel === undefined ? {} : { agent: { model: custom!.defaultModel } }),
  });
  const parentId = String(parent.conversationId);
  await harness.commit((tx) => tx.appendEntry(UserEntry, parent.conversation.id, { model: [{ role: "user", content: "parent work", timestamp: 0 }] }), BACKGROUND_CONTEXT);

  // A real delegation through the one creation seam, with the anchor and the dispatch record written in the creating
  // commit — the same writes the optional extension's own spawn makes.
  const requestId = "seed-dispatch";
  const child = await operations.spawn({
    requestId,
    ownership: {
      kind: "created-task",
      create: (tx) => tx.createTask(SubagentAnchorTask, { dispatchId: requestId, delegatingConversationId: parentId }, { ownership: { kind: "conversation" }, conversationId: parent.conversation.id, background: true }),
      created: async (tx, record) => {
        const dispatch = await tx.doc(DispatchDoc, parent.conversation.id, requestId, null);
        dispatch.version = 1;
        dispatch.dispatchId = requestId;
        dispatch.requestId = requestId;
        dispatch.task = "child task";
        dispatch.childConversationId = String(record.id);
        dispatch.anchorTaskId = record.owner === undefined ? undefined : String(record.owner.taskId);
        dispatch.submissionRequestId = requestId;
        dispatch.createdAt = Date.now();
      },
    },
    agent: { ...(custom!.defaultModel === undefined ? {} : { model: custom!.defaultModel }), thinkingLevel: "off", extensions: [CodingTools], tools: [CodingTools.tools!.find((tool) => tool.name === "read")!], modelTools: null, cwd: "/" },
    createdBy: parentId,
    displayParentId: parentId,
    workspaceId: "local",
    provenance: { origin: "agent", definition: { hostId: "workstation", scope: "project", name: "worker" }, context: { strategy: "fresh" } },
  });
  const childId = String(child.conversation.id);

  // The child's own work, and the entries a raw read must still reach after the compaction hides them.
  const preCompaction = await harness.commit((tx) => tx.appendEntry(UserEntry, child.conversation.id, { model: [{ role: "user", content: "BEFORE THE COMPACTION", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const kept = await harness.commit((tx) => tx.appendEntry(AssistantEntry, child.conversation.id, { model: [{ role: "assistant", content: [{ type: "text", text: "KEPT AFTER THE COMPACTION" }], api: "magpie", provider: "magpie", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const image = await harness.commit((tx) => tx.appendEntry(UserEntry, child.conversation.id, { model: [{ role: "user", content: [{ type: "text", text: "an attachment" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const summary = await harness.commit((tx) => tx.appendEntry(CompactionEntry, child.conversation.id, { head: kept.id as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  // A structured reference from the child to the conversation it came from: an id and a label, never a copy of it.
  await operations.addReference(childId, { conversationId: parentId, label: "the parent" });
  await seeding.close();
  const seed: Seed = { sessionId: parentId, childId, preCompactionEntryId: String(preCompaction.id), imageEntryId: String(image.id), keptEntryId: String(kept.id), summaryEntryId: String(summary.id) };
  console.log("HEPI_UX13_SEED " + JSON.stringify(seed));
  return seed;
}

await seed();

const backend = await createBackendServer({ dbPath, authToken: token, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), models: custom!.models, defaultModel: custom!.defaultModel });
await new Promise<void>((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const origin = "http://127.0.0.1:" + port;
// Delegation is on for the seeded conversation, which is what a user turning the capability on does.
const rows = (await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] }).conversations;
for (const row of rows) {
  const selected = await fetch(origin + "/api/conversations/" + row.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "workspace-resources", "hepi-subagents"] }) });
  if (selected.status !== 200) throw new Error("the fixture could not enable delegation: " + selected.status + " " + await selected.text());
}
console.log("hepi subagent-acceptance fixture on " + origin);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => gateway.close()).then(() => process.exit(0)); });
