"use client";

import type { CapabilityRequest } from "./capability-availability";
import { useWorkbenchConnection } from "./workbench-scope";

/**
 * The request a settings surface makes against the deployment it is showing.
 *
 * A panel's reads and writes belong to the connection the workbench was admitted under, not to the page's own address:
 * an App whose document came from a bundle has no origin that resolves `/api`, and the Gateway it was admitted to is the
 * one that owns the models, providers and extensions the panel configures. Going through the connection is also what
 * presents that connection's credential — the browser's own cookie on Web, one device bearer on an App — without the
 * panel assembling either.
 *
 * There is no fallback to the page's own origin: a panel is mounted inside the connection it configures, and a browser
 * fixture that mounts one panel replaces that connection's transport rather than the document's. A relative `fetch`
 * here would reach the App bundle's own origin, which serves no `/api` at all.
 */
export function useApiRequest(): CapabilityRequest {
  return useWorkbenchConnection().client.request;
}
