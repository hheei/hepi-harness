/**
 * The pinned crash fixture of ticket 06's recovery matrix, composed from public seams only.
 *
 * The backend's own composition (`server.ts`) hides the Harness it opens, and the window this fixture has to pin is a
 * **commit publication** — the moment a state became durable and nothing after it has run. So the fixture composes the
 * same pieces the backend does, from the same public entry points: the real creation seam, the real optional extension
 * and its anchor task definition, over the real local execution host, a real SQLite store and a controlled model.
 *
 * The two seams a fixture needs on top of that are both native and public: `Harness.subscribeCommits()` to die inside a
 * named commit, and the extension's own `wraps` registration to hold the `agent_spawn` call open so no tool result can
 * be committed while the kill lands. Nothing here patches the engine, adds a test-only server hook, or fabricates a
 * child record: the delegation is a real model tool call, the child is a real conversation and the anchor is a real
 * native task.
 */
import assert from "node:assert/strict";
import type { Models } from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CommitPublication, ConversationId, Cursor, Extension, HarnessOptions, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { GatewayRpcServer, LocalGateway, gatewayEnvironment } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { openServerHarness, type ServerHarness } from "../src/harness.ts";
import { createConversationOperations, WorkspaceDoc, type ConversationOperations } from "../src/conversation-operations.ts";
import { createSubagentHost } from "../src/subagents/composition.ts";
import { createSubagentExtension } from "../src/subagents/extension.ts";
import { DispatchDoc, SUBAGENT_ANCHOR_TASK } from "../src/subagents/host.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/** The one workspace this fixture serves, named the way its conversations bind it. */
export const CRASH_WORKSPACE = "local";

export type CrashHarnessOptions = {
  readonly root: string;
  readonly home: string;
  /** Open with scheduling off, so a fixture can read the durable state before anything is resumed. */
  readonly startPaused?: boolean;
  /** Runs synchronously inside every commit publication, which is how a fixture dies in one named commit. */
  readonly onCommit?: (publication: CommitPublication) => void;
  /** Wraps the real `agent_spawn` registration through the extension's own `wraps` seam. */
  readonly wrapSpawn?: (tool: ToolRegistration) => ToolRegistration;
  /** The controlled model's script, installed before the harness can ask for a turn. */
  readonly script?: (faux: FauxProviderHandle) => void;
  /** Harness settings, for a stage that needs a compaction policy the default does not give it. */
  readonly settings?: HarnessOptions["settings"];
  /**
   * Replace the task definitions the extension installs, keeping its tools. A fixture that has to produce the durable
   * state an older definition left behind uses this to reserve the same records against that definition.
   */
  readonly tasks?: Extension["tasks"];
  /**
   * Run the workspace's commands on a gateway **process** this fixture does not own, while the file host stays the
   * composed in-process one. A fixture that has to lose a real execution host mid-call — the shape gap G3 describes —
   * points the execution binding at that process; the workspace identity, token and allowlist are the caller's.
   */
  readonly executionGateway?: { readonly gatewayId: string; readonly origin: string; readonly token: string };
};

export type CrashHarness = {
  readonly harness: ServerHarness;
  readonly operations: ConversationOperations;
  /** The optional extension as installed here, so a fixture selects it by its own object. */
  readonly extension: Extension;
  readonly models: Models;
  readonly faux: FauxProviderHandle;
  close(): Promise<void>;
};

export async function openCrashHarness(dbPath: string, options: CrashHarnessOptions): Promise<CrashHarness> {
  const workspaces = new WorkspaceRegistry([{ id: CRASH_WORKSPACE, root: options.root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, new LocalFilesystem(workspaces, { identity: { user: "operator", home: options.home } }));
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const host = { gatewayId: options.executionGateway?.gatewayId ?? "workstation", gatewayOrigin: options.executionGateway?.origin ?? "http://127.0.0.1:" + address.port, gatewayToken: options.executionGateway?.token ?? "gateway-token" };
  const binding = { id: CRASH_WORKSPACE, ...host };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  options.script?.(faux);
  // The environment is resolved from the conversation's own workspace document, exactly as the backend resolves it.
  const harness = await openServerHarness(dbPath, SERVER_MODEL, models, async (target, context) => {
    const stored = await target.read.snapshot(WorkspaceDoc, target.conversationId, context);
    return stored?.workspaceId === undefined ? undefined : gatewayEnvironment(binding, target.cwd ?? "/");
  }, { startPaused: true, ...(options.settings === undefined ? {} : { settings: options.settings }) });
  const operations = createConversationOperations(harness.harness);
  const extension = createSubagentExtension(createSubagentHost({
    operations,
    commit: (change) => harness.harness.commit(change, BACKGROUND_CONTEXT),
    // The fixture's controlled model only delegates, so the listing projection is never read here; the HTTP suite
    // covers it against the backend's own catalogue. Every other port entry is the real one.
    catalogue: () => [],
    workspace: async (conversationId) => (await harness.harness.snapshot(WorkspaceDoc, Number(conversationId) as ConversationId, BACKGROUND_CONTEXT))?.workspaceId,
    // The same rule the backend states: the preparation's branch point is the newest visible entry of the delegating
    // conversation, read through its own fork-aware context.
    sourceEntry: async (conversationId) => {
      const conversation = await harness.harness.conversation(Number(conversationId) as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) return undefined;
      const newest = (await conversation.context(BACKGROUND_CONTEXT)).entries.at(-1);
      return newest === undefined ? undefined : String(newest.id);
    },
    // The rule the backend states for its own host port: a delegation is at work while its anchor has not admitted it
    // yet, or while its child conversation has live ordinary work. A permanent idle anchor is not work, and it is a
    // background task, so it is not live ordinary work either — the same distinction the backend makes.
    activeChildren: async (conversationId) => {
      const delegating = Number(conversationId) as ConversationId;
      const children = new Map<string, string>();
      let conversationCursor: Cursor | undefined;
      do {
        const stored = await harness.harness.commit((tx) => tx.scanConversations({ ownerConversationId: delegating }, 100, conversationCursor), BACKGROUND_CONTEXT);
        for (const record of stored.items) if (record.owner !== undefined) children.set(String(record.id), String(record.owner.taskId));
        conversationCursor = stored.next;
      } while (conversationCursor !== undefined);
      if (children.size === 0) return 0;
      const admitting = new Set<string>();
      let anchorCursor: Cursor | undefined;
      do {
        const stored = await harness.harness.commit((tx) => tx.scanTasks({ conversationId: delegating, kind: SUBAGENT_ANCHOR_TASK }, 100, anchorCursor), BACKGROUND_CONTEXT);
        for (const record of stored.items) {
          if (record.state.status === "terminal" || record.state.status === "completing") continue;
          if ((record.state.checkpoint as { phase?: string } | undefined)?.phase === "admit") admitting.add(String(record.id));
        }
        anchorCursor = stored.next;
      } while (anchorCursor !== undefined);
      const live = new Set((await harness.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter((task) => !task.record.background).map((task) => String(task.record.conversationId)));
      let active = 0;
      for (const [childId, anchorId] of children) if (admitting.has(anchorId) || live.has(childId)) active += 1;
      return active;
    },
    readDispatch: (conversationId, requestId) => harness.harness.snapshot(DispatchDoc, Number(conversationId) as ConversationId, requestId, BACKGROUND_CONTEXT),
    // The backend's own retry write: the extension's document names the failed attempt, and the parked anchor wakes on it.
    retryPreparation: (conversationId, requestId, failedTaskId) => harness.harness.commit(async (tx) => {
      const record = await tx.doc(DispatchDoc, Number(conversationId) as ConversationId, requestId, null);
      record.preparationRetriedTaskId = failedTaskId;
    }, BACKGROUND_CONTEXT),
    definitionHost: () => ({ gatewayId: binding.gatewayId, workspaceId: binding.id, env: gatewayEnvironment(binding, "/") }),
    childExtensions: async () => [CodingTools],
    models,
    defaultModel: SERVER_MODEL,
    defaultThinkingLevel: undefined,
  }));
  const spawn = extension.tools?.find((tool) => tool.name === "agent_spawn");
  assert.ok(spawn !== undefined, "the optional extension registers agent_spawn");
  const withTasks: Extension = options.tasks === undefined ? extension : { ...extension, tasks: options.tasks };
  const installed: Extension = options.wrapSpawn === undefined ? withTasks : { ...withTasks, wraps: [{ tool: spawn.name, wrap: options.wrapSpawn }] };
  harness.install(installed);
  assert.deepEqual(harness.failures, [], "the fixture's extensions installed");
  if (options.onCommit !== undefined) harness.harness.subscribeCommits(options.onCommit);
  if (options.startPaused !== true) harness.harness.resume();
  return {
    harness,
    operations,
    extension: installed,
    models,
    faux,
    close: async () => { await harness.close(); gateway.server.closeAllConnections(); await gateway.close(); },
  };
}
