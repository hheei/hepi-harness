import { bearerSource } from "@hepi/session/browser";
import type { WorkbenchConfig } from "@hepi/ui/workbench";

/**
 * The connection the App was configured with.
 *
 * Three facts, and the App is the only place that knows any of them: the profile that names this connection, the
 * Gateway origin the client ingress answers on, and the device bearer this install was issued. None of them is a
 * service credential — the ingress presents those to the Backend itself, and the App never sees one.
 *
 * The storage itself is the shell's, not this module's: the Rust side reads the OS credential store (Secret Service on
 * the verified Linux target, ticket 04) and injects the three values at document start. A missing one is a refusal
 * rather than a guess at an address, which is what sends the page to the configuration surface instead of a workbench
 * pointed at the bundle's own origin.
 */
export interface AppConnection {
  readonly profile: string;
  readonly origin: string;
  readonly token: string;
}

/** What the shell injected, as a value rather than as a build-time substitution. */
type Injected = Partial<{ profile: unknown; origin: unknown; token: unknown }>;

/**
 * The workbench configuration this App states, from the connection the shell injected.
 *
 * Three facts and nothing else: the profile that names this connection, the Gateway origin the client ingress answers on,
 * and how it authenticates. The stream is the fourth, and it is the connection's own — the Gateway origin under the
 * device bearer — because a packaged App has no cookie jar and its document's own origin is the bundle, so a same-origin
 * address would ask the shell itself for a conversation it does not serve.
 */
export function workbenchConfig(connection: AppConnection): WorkbenchConfig {
  return {
    host: { kind: "app", ingressOrigin: connection.origin },
    profile: connection.profile,
    credential: { kind: "bearer", token: connection.token },
    createSource: () => bearerSource(connection.origin, connection.token),
  };
}

export function readConnection(): AppConnection {
  const value = (globalThis as { __HEPI_CONNECTION__?: Injected }).__HEPI_CONNECTION__ ?? {};
  const profile = typeof value.profile === "string" ? value.profile.trim() : "";
  const origin = typeof value.origin === "string" ? value.origin.trim().replace(/\/+$/, "") : "";
  const token = typeof value.token === "string" ? value.token : "";
  // A connection missing any of the three is not a connection this client may invent: an empty origin would resolve
  // every request against the bundle's own origin, and an empty token would be presented to a Gateway that refuses it.
  if (!profile || !origin || !token) throw new Error("This App has no Gateway connection configured.");
  return { profile, origin, token };
}
