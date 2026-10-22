import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Models } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, wrapTool, type HarnessOptions, type ToolExecutionApi, type ToolRegistration, type Conversation, type ModelRef, type AgentState, type Extension, type Registry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ExecutionHostEnv } from "@hepi/gateway";
import { errorText } from "@hepi/protocol/error-text";

/**
 * The extension whose tools reach the conversation's execution environment. A conversation bound to no workspace has no
 * environment for them, so it cannot select them — a selected tool it cannot run would be offered and then refused.
 * The name comes from the extension object, so it cannot drift from the registry entry it refers to.
 */
export const ENVIRONMENT_EXTENSION: string = CodingTools.name;

/**
 * The environment of one tool call. A tool call is one scope however many commands it runs, so each command gets its
 * own identity from the scope rather than sharing the call's. The runtime hands the call's identity to the environment
 * here and nowhere else: the environment factory knows the conversation, not the call.
 *
 * A plain `ExecutionEnv` has no scope to open, and no environment stays none, so both pass through untouched and the
 * tool runs exactly as it did — including the runtime's own "no execution environment" report for the second case.
 */
function withCallScope(api: ToolExecutionApi): ToolExecutionApi {
  const env = api.env as (ExecutionEnv & Partial<Pick<ExecutionHostEnv, "forCall">>) | undefined;
  if (env === undefined || typeof env.forCall !== "function") return api;
  return { ...api, env: env.forCall({ conversationId: String(api.conversationId), taskId: String(api.taskId), callId: api.callId }) };
}

/**
 * `coding-tools` as this deployment installs it: the published tools with their own names and metadata, wrapped by the
 * extension that carries them, so choosing the tools and giving their commands a call scope are one selection. A
 * separate extension could be left unselected, and the tools would then run without the scope they are meant to have.
 */
function environmentCodingTools(): Extension {
  return {
    ...CodingTools,
    wraps: (CodingTools.tools ?? []).map(tool => wrapTool(tool as ToolRegistration, (target: ToolRegistration) => ({
      ...target,
      execute: (args, api, context) => target.execute(args, withCallScope(api), context),
    }))),
  };
}

/** One extension the registry refused, with the runtime's own reason, so a broken extension is named and not absent. */
export type ExtensionInstallFailure = { readonly name: string; readonly message: string };

/**
 * `model` is the reference new conversations start with, or undefined when the caller configured none. `registry` is
 * the application-owned registry itself, because the installed set is answered from it and never from a parallel list.
 */
export type ServerHarness = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly registry: Registry;
  /** Every extension the registry refused, in the same array the installer keeps appending to. */
  readonly failures: readonly ExtensionInstallFailure[];
  /**
   * Install one extension with the same failure policy the built-ins get: a refused install is named and reported, and
   * the rest of the backend keeps running. A caller that composes an optional extension after open (the subagent
   * extension, whose task definitions must exist before scheduling resumes) uses this instead of `registry.install()`,
   * which would throw and take the whole backend down over one broken extension.
   */
  install(extension: Extension): void;
  model: ModelRef | undefined;
  models: Models;
  close(): Promise<void>;
};

export type HarnessConfiguration = { defaultThinkingLevel?: AgentState["thinkingLevel"]; settings?: HarnessOptions["settings"]; resourceExtension?: Extension; startPaused?: boolean; diagnostics?: (message: string) => void };

/**
 * Opens the durable harness. A caller that supplies `models` owns the catalog, so a default the catalog does not offer
 * is declared state, not a startup error. The built-in registry below still fails loudly on an unknown default, because
 * nothing else would.
 *
 * `defaultModel` has three states and they stay distinct: omitted means the caller configured no default, so new
 * conversations start with no model and settle natively as `no_model` until one is selected; `null` says the same
 * thing explicitly; a reference is stored as given.
 *
 * There is no built-in model and no built-in default: a backend that configured none manufactures none, and the offline
 * scripted provider is a test fixture (test/faux-fixture.ts) that a test injects as its own catalog.
 */
export async function openServerHarness(dbPath: string, defaultModel?: ModelRef | null, suppliedModels?: Models, env?: HarnessOptions["env"], configuration: HarnessConfiguration = {}): Promise<ServerHarness> {
  // A conversation keeps the reference it was created with, so its next request settles natively as no_model instead of
  // silently switching models. `null` is never turned back into a reference: a deployment that configured none must
  // not be handed a manufactured one.
  const model = defaultModel ?? undefined;
  const configuredModels = createModels();
  if (process.env.OPENAI_API_KEY) configuredModels.setProvider(openaiProvider());
  const models = suppliedModels ?? configuredModels;
  // A caller that built its own registry declares which model its conversations start with, including none at all, and
  // its reference is kept even while the catalog does not offer it, so a later request can settle natively as no_model
  // and name the model instead of the backend pretending it never existed. Only the built-in registry fails startup on
  // an unknown one, because nothing else would.
  if (suppliedModels === undefined && model !== undefined && !models.getModel(model.provider, model.modelId)) {
    throw new Error("Unknown default model: " + model.provider + "/" + model.modelId);
  }
  // An extension the runtime refuses — a duplicate tool name, an unusable section key, a task name already taken —
  // fails that one install and nothing else. The backend starts, the failure is named at startup, and the registry
  // keeps the extensions that did install, so a broken extension is visible rather than silently missing.
  const registry = createRegistry();
  const failures: ExtensionInstallFailure[] = [];
  const report = configuration.diagnostics ?? ((message: string) => console.error(message));
  const install = (extension: Extension): void => {
    try {
      registry.install(extension);
    } catch (error) {
      const message = errorText(error);
      failures.push({ name: extension.name, message });
      report("extension " + extension.name + " failed to install: " + message);
    }
  };
  if (env) install(environmentCodingTools());
  if (configuration.resourceExtension) install(configuration.resourceExtension);
  const harness = await Harness.open(await openNodeSqliteStorage(dbPath), { models, registry, env, settings: configuration.settings, onReport: error => console.error("harness report", error) }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model, thinkingLevel: configuration.defaultThinkingLevel, extensions: configuration.resourceExtension ? [configuration.resourceExtension] : undefined } });
  if (!configuration.startPaused) harness.resume();
  return { harness, root, registry, failures, install, model, models, close: () => harness.close(BACKGROUND_CONTEXT) };
}
