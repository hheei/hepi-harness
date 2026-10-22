/**
 * Controlled backend for ticket 11's browser driver: a real child conversation with a real background anchor, a real
 * compaction, a real image block and a real reference, over a real SQLite store and a real local execution host.
 *
 * The seed runs **before** the backend starts, because the backend attaches every listed conversation at boot and a
 * second writer on the same SQLite file would be a second session rather than a fixture. Everything written is written
 * through the public seams the product itself uses: the one creation seam with a created-task owner, the anchor task
 * definition the optional extension installs, the entry kinds the runtime defines, and the operations object's own
 * reference write. Nothing here fabricates a child record or patches the engine.
 *
 * Usage: node scripts/child-fork-fixture.ts   (driven by apps/web/e2e/ux-child-raw-history-fork.mjs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, defineExtension, UserEntry, type EntryId } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GatewayRpcServer, LocalGateway, gatewayEnvironment } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer } from "../src/server.ts";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createConversationOperations, WorkspaceDoc } from "../src/conversation-operations.ts";
import { openServerHarness } from "../src/harness.ts";
import { SubagentAnchorTask } from "../src/subagents/anchor.ts";
import { DispatchDoc } from "../src/subagents/host.ts";
import { tombstoneConversation } from "../src/session-tombstone.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const base = process.env.HEPI_UX11_FIXTURE ?? "";
const dbPath = process.env.HEPI_UX11_DB ?? "";
const port = Number(process.env.HEPI_UX11_BACKEND_PORT ?? 44111);
const token = process.env.HEPI_UX11_AUTH ?? "ux-child-fork-token";
const model = process.env.HEPI_UX11_MODEL ?? "deepseek-v4.1-flash";
const endpoint = process.env.HEPI_UX11_ENDPOINT ?? "";
const tombstoneParent = process.env.HEPI_UX11_TOMBSTONE_PARENT === "1";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_UX11_FIXTURE, HEPI_UX11_DB and HEPI_UX11_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(join(root, ".pi", "agents"), { recursive: true });
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\n---\n\nbody\n");

/** The tiny real PNG the image block carries; the policy checks the declared mime and the decoded size, not the pixels. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
const gateway = new GatewayRpcServer({
  gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
  files: new LocalFilesystem(workspaces, { identity: { user: "operator", home } }),
  installs: new LocalInstallServer(workspaces, { identity: { user: "operator", home } }),
});
await new Promise<void>((resolveListen) => gateway.server.listen(0, "127.0.0.1", resolveListen));
const gatewayAddress = gateway.server.address();
if (gatewayAddress === null || typeof gatewayAddress !== "object") throw new Error("the gateway did not start");
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };

const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: endpoint + "/v1", HEPI_PROVIDER_API_KEY: "controlled-key" });
if (custom === undefined) throw new Error("the controlled provider configuration was rejected");

/** What the driver reads back: the identities it needs to open, read, attach and fork. */
type Seed = { parentId: string; childId: string; preCompactionEntryId: string; imageEntryId: string; keptEntryId: string; summaryEntryId: string };

/**
 * The seed: one parent, one real delegated child owned by its own background anchor, a compaction that hides the
 * child's own prefix from the active window, an image block, and a reference from the child to the parent.
 */
async function seed(): Promise<Seed> {
  // The seeding harness carries the anchor's own task definition, exactly as the backend will when it resumes, so the
  // anchor this seed creates is resumable by the process that serves the browser.
  const seeding = await openServerHarness(dbPath, custom!.defaultModel, custom!.models, async (target, context) => {
    const stored = await target.read.snapshot(WorkspaceDoc, target.conversationId, context);
    return stored?.workspaceId === undefined ? undefined : gatewayEnvironment(binding, target.cwd ?? "/");
  }, { startPaused: true });
  seeding.install(defineExtension({ name: "hepi-subagents", tasks: [SubagentAnchorTask] }));
  const harness = seeding.harness;
  const operations = createConversationOperations(harness);
  const parent = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  const parentId = String(parent.id);
  await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc, parent.id)).workspaceId = "local"; }, BACKGROUND_CONTEXT);
  await harness.commit(tx => tx.appendEntry(UserEntry, parent.id, { model: [{ role: "user", content: "parent work", timestamp: 0 }] }), BACKGROUND_CONTEXT);

  // The child: a real delegation through the one creation seam, with the anchor task and the dispatch record written in
  // the creating commit — the same two writes the optional extension's own spawn makes.
  const requestId = "seed-dispatch";
  const child = await operations.spawn({
    requestId,
    ownership: {
      kind: "created-task",
      create: (tx) => tx.createTask(SubagentAnchorTask, { dispatchId: requestId, delegatingConversationId: parentId }, { ownership: { kind: "conversation" }, conversationId: parent.id, background: true }),
      created: async (tx, record) => {
        const dispatch = await tx.doc(DispatchDoc, parent.id, requestId, null);
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
    // The child's own configuration, set field by field as the extension's spawn does: nothing of the parent survives.
    agent: { ...(custom!.defaultModel === undefined ? {} : { model: custom!.defaultModel }), thinkingLevel: "off", extensions: [CodingTools], tools: [CodingTools.tools!.find(tool => tool.name === "read")!], modelTools: null, cwd: "/" },
    createdBy: parentId,
    displayParentId: parentId,
    workspaceId: "local",
    provenance: { origin: "agent", definition: { hostId: "workstation", scope: "project", name: "worker" }, context: { strategy: "fresh" } },
  });
  const childId = String(child.conversation.id);

  // The child's own work, and the entries the raw history must still reach after the compaction hides them.
  const preCompaction = await harness.commit(tx => tx.appendEntry(UserEntry, child.conversation.id, { model: [{ role: "user", content: "BEFORE THE COMPACTION", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const kept = await harness.commit(tx => tx.appendEntry(AssistantEntry, child.conversation.id, { model: [{ role: "assistant", content: [{ type: "text", text: "KEPT AFTER THE COMPACTION" }], api: "magpie", provider: "magpie", model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const image = await harness.commit(tx => tx.appendEntry(UserEntry, child.conversation.id, { model: [{ role: "user", content: [{ type: "text", text: "an attachment" }, { type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 }] }), BACKGROUND_CONTEXT);
  const summary = await harness.commit(tx => tx.appendEntry(CompactionEntry, child.conversation.id, { head: kept.id as EntryId, model: [{ role: "user", content: "summary of the above", timestamp: 0 }], data: { reason: "manual" } }), BACKGROUND_CONTEXT);
  // A reference from the child to the conversation it came from: structured, idempotent, and never a copy of it.
  await operations.addReference(childId, { conversationId: parentId, label: "the parent" });
  // A reference that names an entry the active window no longer carries. The raw read is the surface that still holds
  // it, so opening this reference must land on that entry instead of ending with the transcript showing nothing.
  await operations.addReference(childId, { conversationId: childId, entryId: String(preCompaction.id), label: "the dropped decision" });
  if (tombstoneParent) await tombstoneConversation(harness, parent.id, [parentId], Date.now());
  await seeding.close();

  const seed: Seed = { parentId, childId, preCompactionEntryId: String(preCompaction.id), imageEntryId: String(image.id), keptEntryId: String(kept.id), summaryEntryId: String(summary.id) };
  console.log("HEPI_UX11_SEED " + JSON.stringify(seed));
  return seed;
}

await seed();

const backend = await createBackendServer({ dbPath, authToken: token, workspaces: [binding], models: custom.models, defaultModel: custom.defaultModel });
await new Promise<void>((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
console.log("hepi child-fork fixture on http://127.0.0.1:" + port);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => gateway.close()).then(() => process.exit(0)); });
