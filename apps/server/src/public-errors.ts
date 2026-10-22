import type { Message } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

/**
 * Upstream credential and configuration failures embed the offending auth.json/models.json value in the thrown
 * message: `@earendil-works/pi-ai` dist/auth/resolve.js appends the cause through `withCauseDetail`, and
 * `@earendil-works/pi-coding-agent` dist/core/auth-storage.js formats the raw auth.json text into parse errors.
 * Those values are operator secrets, so the backend replaces such a message with a fixed one before it can reach an
 * HTTP response, an SSE frame or a conversation entry. Provider and protocol errors keep their own message.
 */
export const SAFE_CREDENTIAL_ERROR = "the model catalog or credentials could not be loaded; check the backend model and credential configuration";
const CREDENTIAL_FAILURE_PREFIXES: readonly string[] = [
  "Credential store read failed for",
  "Credential store modify failed for",
  "Credential store delete failed for",
  "Credential store read failed",
  "API key auth failed for provider",
  "API key auth check failed for provider",
  "OAuth refresh failed for",
  "OAuth auth derivation failed for",
  "OAuth refresh returned a token that expires too soon for",
  "Model refresh failed for",
  "Provider is not configured:",
  "Unknown provider:",
  "Read-only credential storage cannot modify auth.json",
  "Failed to read auth.json",
  "Invalid auth.json",
  "Failed to resolve ",
  // `models.json` accepts any string as a provider's `api`, so startup succeeds and the value is echoed only when a
  // model call reaches the api registry: dist/index.js throws this, and dist/api/lazy.js copies it into the entry.
  "No API provider registered for api:",
  "Mismatched api:",
];

function isCredentialFailure(message: string): boolean {
  return CREDENTIAL_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/**
 * A model carries the `api` id straight from `models.json`, which accepts any string, so an unregistered api would
 * echo the configured value to every client. Registered ids come from code or an extension, not from configuration.
 */
const SAFE_API = "unknown";

/** An assistant entry never carries a configured api id or a credential/configuration failure message. */
export function safeEntry(message: Message): Message {
  if (message.role !== "assistant") return message;
  const failure = message.errorMessage !== undefined && isCredentialFailure(message.errorMessage);
  const api = getApiProvider(message.api) === undefined ? SAFE_API : message.api;
  if (!failure && api === message.api) return message;
  return { ...message, ...(failure ? { errorMessage: SAFE_CREDENTIAL_ERROR } : {}), api };
}

/** A rejected request keeps a protocol or provider message; a credential/configuration one is replaced. */
export function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return isCredentialFailure(message) ? SAFE_CREDENTIAL_ERROR : message;
}
