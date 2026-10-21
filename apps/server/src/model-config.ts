import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

/** Pi's own agent-directory override. Read by both configuration modes. */
export const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const MODEL_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** The backend agent directory models.json lives in, plus the runtime that serves it. */
export type ModelConfigTarget = { readonly path: string; readonly runtime: ModelRuntime };

export type SaveResult =
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "saved"; readonly applied: true }
  | { readonly status: "saved"; readonly applied: false; readonly error: string };

/** models.json exists but its contents cannot be used, so it must not be replaced by a draft built from something else. */
export class ModelConfigUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigUnreadableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One agent-directory path: the explicit override, else Pi's own default. Never mutates the environment. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AGENT_DIR_ENV]?.trim();
  if (!configured) return join(homedir(), CONFIG_DIR_NAME, "agent");
  if (configured === "~") return homedir();
  return resolve(configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured);
}

export function modelsConfigPath(agentDir: string): string {
  return join(agentDir, "models.json");
}

/**
 * Strip \`//\` line comments and trailing commas, as Pi's own loader does before parsing. Pi's function is not part of
 * the package entry point, and this file is the backend's one reader of the same file, so the behavior is mirrored here
 * instead of reaching into \`dist/\` internals.
 */
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail?: string) => tail ?? (match[0] === '"' ? match : ""));
}

/**
 * Reads models.json with the leniency the backend's own loader accepts (BOM, line comments, trailing commas). A missing
 * or blank file is no providers, which the editor can save over. Unusable contents throw, because the panel replaces the
 * whole file and a draft built from an unreadable file would discard it.
 */
export function readModelConfig(path: string): Record<string, unknown> {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw new ModelConfigUnreadableError("models.json could not be read");
  }
  const trimmed = content.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(trimmed));
  } catch {
    // The parser message quotes the offending bytes, and this file can hold a credential reference, so it is never
    // repeated: the editor only needs to know the file is not usable.
    throw new ModelConfigUnreadableError("models.json is not valid JSON");
  }
  if (!isRecord(parsed)) throw new ModelConfigUnreadableError("models.json must contain a JSON object");
  return parsed;
}

/** Upstream failures that mean the whole file could not be loaded, as opposed to one provider's overlay failing. */
const CONFIG_LOAD_FAILURE_PREFIXES: readonly string[] = ["Failed to load models.json", "Failed to parse models.json", "Invalid models.json schema"];

/** True when a runtime error says models.json itself could not be loaded (parse, schema or read). */
export function isConfigLoadFailure(message: string): boolean {
  return CONFIG_LOAD_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

const INVALID_FILE_ERROR = "models.json is not valid; fix the file before saving";
const UNAPPLIED_ERROR = "the saved models.json could not be applied";

/**
 * The one upstream failure that echoes the draft's own bytes is a parse error, because the JSON parser quotes what it
 * could not read: a file that holds a credential reference would hand it to any client that asked for the diagnostic.
 * Whole-file load failures therefore collapse to a fixed sentence. Everything else upstream reports — a schema path or
 * a provider/model id — is kept, because that is the diagnosis an operator needs and the ids are the caller's own
 * input. `File:` suffixes are dropped since the path is the backend's business, not the browser's.
 */
export function sanitizeModelConfigError(message: string): string {
  const withoutPath = message.replace(/\n\nFile: [\s\S]*$/u, "");
  if (isConfigLoadFailure(withoutPath)) return INVALID_FILE_ERROR;
  return withoutPath;
}

/**
 * Reads one cost group the editor wrote: known rates only, each a finite number. Anything else — a string, an array, a
 * null, an unknown key, a rate that is not a finite number — is not a group this code understands, so it is left for the
 * loader to judge rather than being repaired into something valid.
 */
function costGroupOf(value: unknown): { readonly group: Record<string, number> } | { readonly empty: true } | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.some((key) => !(MODEL_COST_KEYS as readonly string[]).includes(key))) return undefined;
  if (!keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))) return undefined;
  if (keys.length === 0) return { empty: true };
  return { group: Object.fromEntries(MODEL_COST_KEYS.map((key) => [key, (value[key] as number | undefined) ?? 0])) };
}

/**
 * The one draft repair the editor's own model does: a cost group it left empty is omitted, and a partially filled group
 * of known finite rates is completed with zero. A malformed group is written through unchanged, so the loader rejects
 * the draft instead of the serializer quietly repairing it into something valid that would then replace a working file.
 */
export function normalizeModelConfigCosts(data: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(data);
  if (!isRecord(normalized.providers)) return normalized;
  for (const provider of Object.values(normalized.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
    for (const model of provider.models) {
      if (!isRecord(model) || !("cost" in model)) continue;
      const cost = costGroupOf(model.cost);
      if (cost === undefined) continue;
      if ("empty" in cost) delete model.cost;
      else model.cost = cost.group;
    }
  }
  return normalized;
}

/** Drop blank model rows; a row without a usable id cannot be a model. Other schema errors stay for the loader to report. */
function sanitizeModelConfig(data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(data.providers)) return data;
  const providers = Object.fromEntries(Object.entries(data.providers).map(([providerId, provider]) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return [providerId, provider];
    const models = provider.models.filter((model) => !isRecord(model) || typeof model.id !== "string" || model.id.trim().length > 0);
    return [providerId, { ...provider, models }];
  }));
  return { ...data, providers };
}

/** The bytes a save writes for one draft. */
export function serializeModelConfig(draft: Record<string, unknown>): string {
  return JSON.stringify(normalizeModelConfigCosts(sanitizeModelConfig(draft)), null, 2);
}

function writePrivateFile(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, "." + basename(path) + "-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** The environment-owned base providers of a runtime, so a candidate is validated against the same base set. */
function nativeProviders(runtime: ModelRuntime): Provider[] {
  return runtime.getRegisteredProviderIds().flatMap((id) => {
    const provider = runtime.getRegisteredNativeProvider(id);
    return provider === undefined ? [] : [provider];
  });
}

/**
 * Validates candidate bytes on a throwaway runtime before the real file is touched, so an invalid draft can never
 * replace a working configuration. The probe skips its create-time refresh, which is what keeps a configured
 * \`!command\` credential reference from running during a save.
 */
async function validateModelConfig(target: ModelConfigTarget, text: string): Promise<string | undefined> {
  const directory = dirname(target.path);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, "." + basename(target.path) + "-" + randomUUID() + ".tmp");
  try {
    writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const probe = await ModelRuntime.create({ modelsPath: tempPath, modelsStore: new InMemoryModelsStore(), credentials: new InMemoryCredentialStore(), allowModelNetwork: false, refreshOnCreate: false });
    for (const provider of nativeProviders(target.runtime)) probe.registerNativeProvider(provider);
    const error = probe.getError();
    return error === undefined ? undefined : sanitizeModelConfigError(error);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/**
 * One save, end to end: validate the candidate on a throwaway runtime, replace the file atomically and refresh the live
 * runtime against exactly that content. Each save replaces the file, so the last completed write is the one that stands
 * and a read that follows answers with it; an ordinary `PUT` therefore needs no scheduler in front of it.
 */
export async function saveModelConfig(target: ModelConfigTarget, draft: unknown): Promise<SaveResult> {
  if (!isRecord(draft)) return { status: "invalid", error: "models.json must contain a JSON object" };
  const text = serializeModelConfig(draft);
  const invalid = await validateModelConfig(target, text);
  if (invalid !== undefined) return { status: "invalid", error: invalid };
  writePrivateFile(target.path, text);
  try {
    await target.runtime.refresh({ allowNetwork: false });
  } catch {
    return { status: "saved", applied: false, error: UNAPPLIED_ERROR };
  }
  const error = target.runtime.getError();
  return error === undefined ? { status: "saved", applied: true } : { status: "saved", applied: false, error: sanitizeModelConfigError(error) };
}

/**
 * The environment-mode runtime. It is the same ModelRuntime the Pi mode uses, over the backend agent directory, so the
 * editor's models.json is authoritative in both modes. Only the credential store differs: environment mode keeps its
 * credentials in memory and reads no auth.json. The configured deployment is re-applied every boot as an
 * environment-owned base provider, so the alias, endpoint and credential reference survive a restart without being
 * copied into a file.
 */
export async function openEnvModelRuntime(options: { agentDir: string; env?: NodeJS.ProcessEnv; custom?: Provider }): Promise<ModelRuntime> {
  const env = options.env ?? process.env;
  const runtime = await ModelRuntime.create({ modelsPath: modelsConfigPath(options.agentDir), modelsStore: new InMemoryModelsStore(), credentials: new InMemoryCredentialStore(), allowModelNetwork: false, refreshOnCreate: false });
  // The configured provider replaces the built-in collection, as before. Without one no environment-owned base
  // provider is registered: whatever models.json defines stays the whole catalog, and there is no offline scripted
  // fallback — the scripted provider is a test fixture (test/faux-fixture.ts). A deployment with no default then starts
  // its conversations with none, and they settle natively as no_model until one is selected.
  if (options.custom) runtime.registerNativeProvider(options.custom);
  else if (env.OPENAI_API_KEY) runtime.registerNativeProvider(openaiProvider());
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}
