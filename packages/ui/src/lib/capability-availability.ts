"use client";

import { useEffect, useState } from "react";
import { useWorkbenchConnection } from "./workbench-scope";

/**
 * Whether this connection's deployment serves one capability, asked before its control is offered.
 *
 * A Settings control whose route the deployment does not serve must not be offered and then refuse the click: the
 * surface asks the route itself, and the answer for a capability nothing serves — HTTP 501 with `code: "unsupported"` —
 * is what keeps the control out. Every other answer leaves the control in place, so a deployment that grows the route
 * enables the control with no panel change and no second list of capabilities to keep in step.
 *
 * The path is the route the control itself calls, so the question and the action can never name different surfaces.
 *
 * The request is the **connection's own**, never a relative `fetch`: a control on this surface belongs to the Gateway
 * the workbench was admitted to, and an App whose page is loaded from a bundle has no origin to resolve `/api` against.
 * The question therefore travels with the same origin and the same credential the action would use, which is what makes
 * the answer a statement about the deployment the control would write to. There is no fallback transport for a surface
 * with no connection: a panel is only ever mounted inside the workbench it would write to.
 *
 * A request that never arrives is not an answer about the deployment. Offline, a proxy in the way or a request that
 * timed out says nothing about which routes exist, so it reads `null` — unknown — and never `false`, which is the
 * deployment's own statement that it serves no such capability. Nothing is asked again by itself: the surface says the
 * answer is not in yet, and the next read of the panel asks again.
 */
export type CapabilityRequest = (path: string, init?: RequestInit) => Promise<Response>;

export async function capabilityServed(request: CapabilityRequest, path: string): Promise<boolean | null> {
  try {
    const response = await request(path, { headers: { accept: "application/json" } });
    if (response.status !== 501) return true;
    const body = await response.json().catch(() => null) as { code?: string } | null;
    return body?.code === "unsupported" ? false : true;
  } catch {
    // No answer arrived, so nothing is known about the capability: this is not the deployment's limit.
    return null;
  }
}

/**
 * The same limit read off an answer a panel already asked for, or null when the answer is anything else. A panel
 * whose own read is the capability's only surface — Sub-agents has no route of its own to probe — names the limit
 * from the answer it got instead of offering an editor the click would refuse.
 */
export function unsupportedCapability(response: { status: number }, body: unknown): string | null {
  if (response.status !== 501) return null;
  const answer = body as { code?: string; error?: string } | null;
  return answer?.code === "unsupported" ? answer.error ?? null : null;
}

/**
 * The text that says why a capability's control is not usable, or undefined while its route serves it: the
 * capability's own limit for the deployment's explicit unsupported reply, and "not confirmed" for an answer that
 * never arrived. One function decides both, so no panel can show a lost request as the deployment's limit, or the
 * limit as a lost request.
 */
export function capabilityNoticeKey(served: boolean | null, limitKey: string): string | undefined {
  if (served === true) return undefined;
  return served === null ? "settings.capabilityUnknown" : limitKey;
}

/**
 * The same question as state: `null` until an answer is in, then the answer itself — `false` only for the
 * deployment's explicit unsupported reply, and `null` again when no answer arrived at all. A surface offers its
 * control unless the answer was that explicit limit, and says which of the two it read.
 *
 * The question is asked through the connection this surface is rendered under: the same client the control would write
 * through. A surface asking about a route its page host serves rather than the Backend states that route's transport
 * itself at its own seam; every capability question here is about the Backend this workbench was admitted to.
 */
export function useCapabilityServed(path: string): boolean | null {
  const ask = useWorkbenchConnection().client.request;
  const [served, setServed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setServed(null);
    void capabilityServed(ask, path).then((value) => {
      if (!cancelled) setServed(value);
    });
    return () => {
      cancelled = true;
    };
  }, [ask, path]);
  return served;
}
