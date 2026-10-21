/**
 * What a host states about the connection its own descriptor read settled on.
 *
 * A host that mounts the workbench has facts a native shell cannot otherwise report: which Backend answered, under which
 * account scope, admitting which client. The workbench is the only place that reads the connection descriptor, so those
 * answers exist here and nowhere else, and a packaged run has to hear them from the read that actually happened rather
 * than re-ask them with a transport of its own outside the WebView.
 *
 * This exists because readiness used to be reported from the branch that *found a stored connection*, before any read
 * settled. A shell whose ingress refused its bearer then printed `workbench`, and a check that read that line would have
 * believed a WebView that never reached a Backend. Nothing is stated until the descriptor answer decides it: an admitted
 * read states the identity it confirmed, a refusal states the reason the gate already owns, and while the read is still
 * in flight there is no statement at all.
 *
 * The admitted readout carries no credential. `client` is the **id** the deployment named for the bearer it admitted —
 * what the Backend's own record calls it — and never the bearer itself, which the page holds only to present it.
 */
import type { Admission } from "./web-session-gate";
import type { ConnectionIdentity } from "./connection-scope";

export type ConnectionReadout =
  /** The descriptor answered: the four facts this connection was admitted as. */
  | {
      readonly kind: "admitted";
      readonly profile: string;
      readonly backendId: string;
      readonly accountScope: string;
      /** The client identity the deployment stated for this request: `device:<id>` or `web`. */
      readonly client: string;
    }
  /** The descriptor was refused, and the reason is the one the workbench itself shows. */
  | { readonly kind: "refused"; readonly reason: string };

/** The part of the descriptor's `client` field this readout reads, as an ingress answers it. */
export type DescriptorClient = { readonly kind?: unknown; readonly id?: unknown } | undefined;

/** How the descriptor stated the admitted client, or `""` when it stated none. */
function clientOf(client: DescriptorClient): string {
  if (client === undefined) return "";
  if (client.kind === "web") return "web";
  return client.kind === "device" && typeof client.id === "string" ? "device:" + client.id : "";
}

/**
 * The readout of one connection state, or `null` while it is undecided.
 *
 * `identity` is the descriptor-derived identity and `admission` the gate's decision; both start empty and both are settled
 * by the one read, so this ordering is the only rule a host could get wrong: a settled identity outranks a previous
 * refusal, because it *is* this read's answer, and an empty pair means nothing has been read yet — which reports
 * nothing, rather than reporting a connection the deployment never admitted.
 */
export function readoutOf(input: {
  readonly identity: ConnectionIdentity | null;
  readonly admission: Admission | null;
  readonly client?: DescriptorClient;
}): ConnectionReadout | null {
  if (input.identity !== null) {
    return {
      kind: "admitted",
      profile: input.identity.profile,
      backendId: input.identity.backendId,
      accountScope: input.identity.accountScope,
      client: clientOf(input.client),
    };
  }
  if (input.admission?.kind === "refused") return { kind: "refused", reason: input.admission.reason };
  // A sign-in surface is a Web page's own state and never an admitted connection: stating it as a refusal is what keeps a
  // host from reporting a workbench over a login form it has not passed.
  if (input.admission?.kind === "sign-in") return { kind: "refused", reason: "This deployment is asking for its Web login, which this connection does not hold." };
  return null;
}
