import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, InMemoryModelsStore, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { HarnessSettings, ModelRef } from "@earendil-works/pi-durable";
import { modelsConfigPath, resolveAgentDir } from "./model-config.ts";

/** Explicit opt-in variable for the Pi configuration source: `pi` loads Pi's agent directory, `env` keeps the environment source. */
export const CONFIG_SOURCE_ENV = "HEPI_CONFIG_SOURCE";
const PI_SOURCE = "pi";
const ENV_SOURCE = "env";

/** Resource paths and trust the backend may load. Pi's settings.json is the only source that names them. */
export type PiResourceSettings = {
  skills: string[];
  prompts: string[];
  enableSkillCommands: boolean;
  defaultProjectTrust: "ask" | "always" | "never";
};

export type PiConfig = {
  agentDir: string;
  models: ModelRuntime;
  /** The configured default, or undefined when the directory names none that is available; a conversation then settles natively. */
  defaultModel: ModelRef | undefined;
  defaultThinkingLevel: ModelThinkingLevel;
  settings: HarnessSettings;
  resourceSettings: PiResourceSettings;
  warnings: string[];
};

function invalid(message: string): Error {
  return new Error("Invalid Pi configuration: " + message);
}

// Upstream parse and credential-command errors can contain secrets; never forward their raw messages.
function configFailure(): Error {
  return invalid("the model catalog or credentials could not be loaded; check models.json and auth.json");
}

async function validateAuthFile(agentDir: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(join(agentDir, "auth.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw invalid("auth.json could not be read");
  }
  try {
    const parsed: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
  } catch {
    throw invalid("auth.json must contain a valid JSON object");
  }
}

/**
 * The HEPI_PROVIDER/HEPI_MODEL pair selects one model from the Pi catalog. A blank or half-set pair is a startup error,
 * and an explicit pair never falls back to settings.json.
 */
function selectExplicit(models: ModelRuntime, env: NodeJS.ProcessEnv): ModelRef | undefined {
  for (const name of ["HEPI_PROVIDER_BASE_URL", "HEPI_PROVIDER_API_KEY"] as const) {
    if (env[name] !== undefined) throw invalid(name + " is not supported in pi mode; configure endpoints and keys in the Pi agent directory (models.json, auth.json)");
  }
  const provider = env.HEPI_PROVIDER?.trim();
  const modelId = env.HEPI_MODEL?.trim();
  if (env.HEPI_PROVIDER !== undefined && !provider) throw invalid("HEPI_PROVIDER is set but empty");
  if (env.HEPI_MODEL !== undefined && !modelId) throw invalid("HEPI_MODEL is set but empty");
  if ((provider === undefined) !== (modelId === undefined)) throw invalid("HEPI_PROVIDER and HEPI_MODEL must be set together in pi mode");
  if (provider === undefined || modelId === undefined) return undefined;
  if (!models.getModel(provider, modelId)) throw invalid("model " + provider + "/" + modelId + " is not in the Pi catalog");
  return { provider, modelId };
}

/**
 * Durable policies Pi settings.json configures that this backend honors. Everything else in that file is ignored and
 * reported through `warnings`.
 */
function harnessSettings(settings: SettingsManager): HarnessSettings {
  const retry = settings.getRetrySettings();
  const provider = settings.getProviderRetrySettings();
  const transport = settings.getTransport();
  const steeringMode = settings.getSteeringMode();
  const followUpMode = settings.getFollowUpMode();
  const compaction = settings.getCompactionSettings();
  // Upstream forwards several of these values without checking them, so a wrong-typed settings.json would otherwise
  // reach the runtime as a value its own type forbids.
  const counts: unknown[] = [retry.maxRetries, retry.baseDelayMs, retry.maxAgentDelayMs, compaction.reserveTokens, compaction.keepRecentTokens, provider.maxRetryDelayMs, provider.timeoutMs, provider.maxRetries];
  const wrongType = counts.some((count) => count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0))
    || typeof retry.enabled !== "boolean" || typeof compaction.enabled !== "boolean"
    || !TRANSPORTS.includes(transport) || !QUEUE_MODES.includes(steeringMode) || !QUEUE_MODES.includes(followUpMode);
  if (wrongType) throw new Error("unusable value");
  return {
    stream: {
      transport,
      ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
      ...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
      ...(provider.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: provider.maxRetryDelayMs }),
    },
    retry: { enabled: retry.enabled, maxRetries: retry.maxRetries, baseDelayMs: retry.baseDelayMs, maxAgentDelayMs: retry.maxAgentDelayMs },
    compaction: { enabled: compaction.enabled, reserveTokens: compaction.reserveTokens, keepRecentTokens: compaction.keepRecentTokens },
    steeringMode,
    followUpMode,
  };
}

const TRANSPORTS: readonly string[] = ["auto", "sse", "websocket"];
const QUEUE_MODES: readonly string[] = ["all", "one-at-a-time"];

/** Resource paths are backend filesystem paths; a value that is not a list of strings cannot be one. */
function resourceSettings(settings: SettingsManager): PiResourceSettings {
  const skills = settings.getSkillPaths();
  const prompts = settings.getPromptTemplatePaths();
  const usable = [skills, prompts].every((paths) => Array.isArray(paths) && paths.every((path) => typeof path === "string"));
  if (!usable) throw new Error("unusable value");
  return { skills, prompts, enableSkillCommands: settings.getEnableSkillCommands(), defaultProjectTrust: settings.getDefaultProjectTrust() };
}

/** Settings.json fields this backend does not forward, reported once so a Pi user can see what is ignored. */
function unsupportedWarnings(settings: SettingsManager): string[] {
  const raw = settings.getSettings() as Record<string, unknown> & { compaction?: { modelOverrides?: unknown } };
  const unsupported = ["theme", "keybindings", "mcp", "extensions", "packages", "themes", "defaultTools", "codemode", "cacheWarming", "thinkingBudgets", "terminal", "images", "markdown", "hideThinkingBlock", "showCacheMissNotices", "quietStartup", "externalEditor", "shellPath", "shellCommandPrefix", "npmCommand", "sessionDir", "enabledModels", "httpProxy", "websocketConnectTimeoutMs", "httpIdleTimeoutMs", "enableAnalytics", "enableInstallTelemetry", "warnings", "branchSummary", "lastChangelogVersion", "collapseChangelog", "trackingId", "deviceId", "doubleEscapeAction", "treeFilterMode", "editorPaddingX", "outputPad", "autocompleteMaxVisible", "showHardwareCursor", "tuiMode", "fullscreenExitOutput", "fullscreenScrollbar", "fullscreenCopyOnSelect", "fullscreenWheelScrollLines"];
  const ignored = unsupported.filter((key) => raw[key] !== undefined);
  if (raw.compaction?.modelOverrides !== undefined) ignored.push("compaction.modelOverrides");
  if (ignored.length === 0) return [];
  return ["Settings not applied by the backend: " + ignored.sort().join(", ")];
}

/**
 * Reads Pi's agent directory (models.json, auth.json, settings.json) as this backend's model/auth/settings source.
 * Only runs when `HEPI_CONFIG_SOURCE=pi`; `env` keeps the environment source, and any other value is a startup error
 * rather than a silent fallback. Missing or malformed configuration throws here, at startup.
 */
export async function loadPiConfig(env: NodeJS.ProcessEnv = process.env): Promise<PiConfig | undefined> {
  const source = env[CONFIG_SOURCE_ENV]?.trim();
  if (!source || source === ENV_SOURCE) return undefined;
  if (source !== PI_SOURCE) throw invalid(CONFIG_SOURCE_ENV + "=" + source + " is not supported; use " + PI_SOURCE + " or " + ENV_SOURCE);

  const agentDir = resolveAgentDir(env);
  const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
  const loadErrors = settings.drainErrors();
  if (loadErrors.length > 0) throw invalid("settings.json could not be read");
  await validateAuthFile(agentDir);

  let models: ModelRuntime;
  try {
    models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: modelsConfigPath(agentDir), modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
  } catch {
    throw configFailure();
  }
  // A malformed models.json is still a startup error: nothing can be served from a file that does not parse. A file
  // that parses but names an unavailable or unauthenticated default is not: the settings API stays reachable, the
  // reference is preserved, and the next request settles natively instead of the backend failing to boot.
  if (models.getError()) throw configFailure();

  const explicit = selectExplicit(models, env);
  const settingsProvider = settings.getDefaultProvider();
  const settingsModel = settings.getDefaultModel();
  if (Boolean(settingsProvider) !== Boolean(settingsModel)) throw invalid("settings.json defaultProvider and defaultModel must be set together");
  const warnings = unsupportedWarnings(settings);
  let resolved = explicit ? models.getModel(explicit.provider, explicit.modelId) : undefined;
  let defaultModel: ModelRef | undefined;
  if (resolved !== undefined) {
    defaultModel = { provider: resolved.provider, modelId: resolved.id };
  } else if (settingsProvider && settingsModel) {
    // An explicit HEPI_PROVIDER/HEPI_MODEL pair is an operator instruction and stays strict; a settings.json default is
    // durable state that can outlive the catalog, so its reference is kept whether or not the catalog still offers it.
    resolved = models.getModel(settingsProvider, settingsModel);
    defaultModel = { provider: settingsProvider, modelId: settingsModel };
    if (resolved === undefined) warnings.push("settings.json default " + settingsProvider + "/" + settingsModel + " is not in the models.json catalog; a request will report it as unavailable");
  } else {
    // Like Pi, no configured default picks an authenticated model. The catalog order makes the pick deterministic.
    const available = await models.getAvailable().catch(() => { throw configFailure(); });
    resolved = available[0];
    if (resolved === undefined) warnings.push("no authenticated model is available; run `pi /login` or configure models.json with a key");
    else defaultModel = { provider: resolved.provider, modelId: resolved.id };
  }
  // A default the catalog does not offer, or one without credentials, is reported through `warnings`; only the
  // resolution itself can fail the boot.
  const authenticated = resolved !== undefined && await models.getAuth(resolved).catch(() => { throw configFailure(); });
  if (resolved !== undefined && !authenticated) warnings.push("no credentials for " + resolved.provider + "; run `pi /login " + resolved.provider + "` or set the provider's API-key variable");

  // Pi's own fallback level is medium; a level the model cannot serve clamps to one it can.
  const configuredLevel = resolved === undefined
    ? settings.getDefaultThinkingLevel() ?? "medium"
    : settings.getModelThinkingLevel(resolved.provider, resolved.id) ?? settings.getDefaultThinkingLevel() ?? "medium";

  // Upstream settings accessors throw with the offending value in the message, and a value read from settings.json is
  // never repeated in an error that may reach a log.
  let applied: { settings: HarnessSettings; resourceSettings: PiResourceSettings };
  try {
    applied = { settings: harnessSettings(settings), resourceSettings: resourceSettings(settings) };
  } catch {
    throw invalid("settings.json contains values the backend cannot apply; check its transport, retry, compaction, steering and resource path settings");
  }

  return {
    agentDir,
    models,
    defaultModel,
    defaultThinkingLevel: resolved === undefined ? "medium" : clampThinkingLevel(resolved, configuredLevel),
    ...applied,
    warnings,
  };
}
