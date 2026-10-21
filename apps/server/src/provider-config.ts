import { createModels, createProvider, envApiKeyAuth, hasApi, type AuthContext, type Model, type Models, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getAllBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Documented backend provider environment. The pi credential store and pi config files are never read. */
export const PROVIDER_ENV = { provider: "HEPI_PROVIDER", model: "HEPI_MODEL", baseUrl: "HEPI_PROVIDER_BASE_URL", apiKey: "HEPI_PROVIDER_API_KEY" } as const;

const DEFAULT_BASE_URLS: Readonly<Record<string, string>> = { deepseek: "https://api.deepseek.com" };

export type CustomProvider = { readonly provider: Provider; readonly models: Models; readonly defaultModel: { readonly provider: string; readonly modelId: string } };

const CONFIGURED_API = "openai-completions" as const;
type ChatModel = Model<typeof CONFIGURED_API>;
/** Every upstream chat entry of this api, across provider catalogs. One read at module load. */
const CATALOG: readonly ChatModel[] = getBuiltinProviders().flatMap(provider => getAllBuiltinModels(provider)).filter((model): model is ChatModel => hasApi(model, CONFIGURED_API));

/**
 * Model facts that do not depend on who serves the model: what it accepts, how it thinks and how large it is.
 * Pricing and wire compatibility stay provider-specific, so they are never adopted across catalogs.
 */
type PortableFacts = Pick<ChatModel, "name" | "reasoning" | "thinkingLevelMap" | "input" | "inputLimits" | "contextWindow" | "maxTokens">;
const PORTABLE_FIELDS: readonly (keyof PortableFacts)[] = ["name", "reasoning", "thinkingLevelMap", "input", "inputLimits", "contextWindow", "maxTokens"];

function identical(entries: readonly ChatModel[], field: keyof PortableFacts): boolean {
  const first = entries[0]?.[field];
  if (first === undefined) return false;
  return entries.every(entry => JSON.stringify(entry[field]) === JSON.stringify(first));
}

/**
 * Upstream facts for one model id. The configured provider's own catalog entry wins, because it also carries that
 * provider's pricing and wire compatibility. Otherwise a model id identifies the same model in whichever catalog
 * carries it, so facts every entry agrees on are adopted — and a field the catalogs disagree about (a gateway that
 * serves one model id with different modalities) stays unknown rather than being guessed.
 */
function upstreamFacts(id: string, provider: string): Partial<PortableFacts> | undefined {
  const own = CATALOG.filter(model => model.provider === provider && model.id === id);
  const entries = own.length > 0 ? own : CATALOG.filter(model => model.id === id);
  if (entries.length === 0) return undefined;
  const facts: Partial<PortableFacts> = {};
  for (const field of PORTABLE_FIELDS) if (identical(entries, field)) Object.assign(facts, { [field]: entries[0]![field] });
  return facts;
}

/**
 * The catalog entry of the configured provider's own catalog, with the configured base URL. Falls back to the
 * upstream facts shared by every catalog that knows this id, and only then to a placeholder.
 */
function chatModel(id: string, provider: string, baseUrl: string): ChatModel {
  const own = CATALOG.find(model => model.provider === provider && model.id === id);
  if (own) return { ...own, baseUrl };
  const facts = upstreamFacts(id, provider);
  // Zero cost means "unknown", not free: accounting under-reports spend for a model reached through another
  // provider's endpoint. The placeholder's window/limit numbers are conservative and reasoning stays off.
  const unknown: ChatModel = { id, name: id + " (unverified)", api: CONFIGURED_API, provider, baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
  return facts === undefined ? unknown : { ...unknown, ...facts };
}

/**
 * Builds one OpenAI-completions provider from HEPI_PROVIDER/HEPI_MODEL/HEPI_PROVIDER_BASE_URL/HEPI_PROVIDER_API_KEY.
 * Returns undefined when unconfigured, so the backend registers only the built-in OPENAI_API_KEY provider, if any.
 * Misconfiguration throws here, at startup, rather than surfacing as a failed request later. The returned `provider`
 * is the same object environment mode registers as the runtime's environment-owned base layer, so its alias, endpoint
 * and credential reference are re-applied on every boot without being written to a configuration file.
 */
export function customProviderFromEnv(env: NodeJS.ProcessEnv = process.env): CustomProvider | undefined {
  const provider = env[PROVIDER_ENV.provider]?.trim();
  const modelId = env[PROVIDER_ENV.model]?.trim();
  const hasCustomEndpoint = env[PROVIDER_ENV.baseUrl] !== undefined || env[PROVIDER_ENV.apiKey] !== undefined;
  if (!provider && !hasCustomEndpoint) return undefined;
  if (!provider || !modelId) throw new Error("HEPI_PROVIDER and HEPI_MODEL are required for provider configuration");
  if (provider === "faux") throw new Error(PROVIDER_ENV.provider + "=faux is reserved for the offline scripted test fixture");
  const configuredBaseUrl = env[PROVIDER_ENV.baseUrl]?.trim();
  if (provider === "openai" && !configuredBaseUrl) return undefined;
  const baseUrl = configuredBaseUrl || DEFAULT_BASE_URLS[provider];
  if (!baseUrl) throw new Error(PROVIDER_ENV.baseUrl + " is required for provider " + provider);
  let baseUrlProtocol: string;
  try { baseUrlProtocol = new URL(baseUrl).protocol; } catch { throw new Error(PROVIDER_ENV.baseUrl + " is not a valid URL"); }
  if (baseUrlProtocol !== "http:" && baseUrlProtocol !== "https:") throw new Error(PROVIDER_ENV.baseUrl + " must be an http or https URL");
  const rawApiKey = env[PROVIDER_ENV.apiKey];
  const apiKeyValue = rawApiKey?.trim();
  if (rawApiKey !== undefined && !apiKeyValue) throw new Error(PROVIDER_ENV.apiKey + " is set but empty");
  if (!apiKeyValue) throw new Error(PROVIDER_ENV.apiKey + " is required for custom provider " + provider);
  const keyAuth = envApiKeyAuth(provider + " API key", [PROVIDER_ENV.apiKey]);
  // Upstream OpenAI-completions requires a key even for local endpoints that ignore authentication.
  const apiKey = keyAuth;
  // Ambient lookup is restricted to this deployment's env; no pi credential store or pi config files are consulted.
  const authContext: AuthContext = { env: async name => env[name], fileExists: async () => false };
  const configured = createProvider({ id: provider, name: provider, baseUrl, auth: { apiKey }, models: [chatModel(modelId, provider, baseUrl)], api: openAICompletionsApi() });
  const models = createModels({ authContext });
  models.setProvider(configured);
  return { provider: configured, models, defaultModel: { provider, modelId } };
}
