import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { gatewayEnvironment, type EnvironmentBinding, type ExecutionHostEnv } from "@hepi/gateway";
import { PROTOCOL_VERSION, type WorkspaceLocality } from "@hepi/protocol";
import { boundedMessage } from "./skill-install.ts";

/**
 * The deployment's execution targets, as one read: the workspaces this backend binds and the gateways it configured.
 *
 * Both answers are metadata and neither resolves a client's folder. A workspace row states its id, its gateway and the
 * account its tools actually run as, asked of that gateway's own executionHost answer, so a UI label can never
 * substitute this process's identity for the host's; an unreachable host is reported as such instead of being shown as
 * the backend's own account. A host row states the profiles that gateway offers — ids and names only, never a gateway
 * URL or token — so a caller can offer a remote host explicitly instead of guessing one.
 *
 * A binding a removal retained stays in the workspace list, because a conversation bound to it resolves its display
 * root from here, and says so; what keeps it out of a picker is that marker, not its absence.
 */

export type WorkspaceHttpOptions = {
  /** Every workspace this deployment binds, retained ones included, from the registry's one resolution. */
  readonly bindings: () => readonly (EnvironmentBinding & { readonly retained?: true })[];
  /** Every gateway this deployment configured, by id. */
  readonly gateways: () => readonly GatewayProfileSource[];
  /** One gateway's execution targets, or the code and status that say why they could not be read. */
  readonly profiles: (connection: GatewayProfileSource) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly status: number }>;
};

/** A configured gateway as its own client reaches it: the id its answer is keyed by, and its origin and token. */
type GatewayProfileSource = { readonly gatewayId: string; readonly gatewayOrigin: string; readonly gatewayToken: string };

export function createWorkspaceHttp(options: WorkspaceHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    // The execution workspaces this backend can bind, each with the account its tools actually run as.
    if (request.method === "GET" && url.pathname === "/api/workspaces") {
      const workspaces = await Promise.all(options.bindings().map(async (binding) => {
        const { id, gatewayId } = binding;
        const marker = binding.retained === true ? { retained: true as const } : {};
        const result = await (gatewayEnvironment(binding, "/") as ExecutionHostEnv).executionHost(BACKGROUND_CONTEXT);
        return result.ok
          ? { id, gatewayId, ...marker, host: { user: result.value.user, home: result.value.home }, workspaceRoot: result.value.workspaceRoot }
          : { id, gatewayId, ...marker, hostError: boundedMessage(result.error.message) };
      }));
      json(response, 200, { workspaces }); return true;
    }
    // The execution targets this deployment configured: each gateway's id, and for a gateway that serves remote
    // profiles, those profiles with the account the host itself reports.
    if (request.method === "GET" && url.pathname === "/api/hosts") {
      const hosts = await Promise.all(options.gateways().map(async (connection) => {
        const listed = await options.profiles(connection);
        return listed.ok
          ? { id: connection.gatewayId, profiles: listed.value }
          : { id: connection.gatewayId, profiles: [], error: listed.code };
      }));
      json(response, 200, { protocol: PROTOCOL_VERSION, hosts }); return true;
    }
    // The one question a client ingress asks about a folder it is about to serve locally: is this workspace a folder on
    // the machine of the gateway that ingress configured? The Backend owns the binding — which gateway a workspace id
    // belongs to — so it is the only process that can answer, and it answers one verdict instead of the two topology
    // listings a caller would otherwise have to join itself.
    //
    // Two facts have to agree, and neither alone is enough. A name is not an identity, so a workspace bound to another
    // gateway is not local even when the named gateway serves a folder of its own under that same id. And a gateway
    // that executes through SSH profiles serves folders on other machines (ADR 0005), so it is not the caller's own
    // host either. Membership is the workspace listing's own, retained bindings included, because a conversation bound
    // before a removal still resolves its root here; eligibility for a **new** target is a different decision and is not
    // asked on this route. The empty profile list is read together with the error beside it: a gateway that could not be
    // reached is reported as `{ profiles: [], error }`, and "no profiles" there states that nothing was asked — which is
    // why a failed query keeps its own non-success instead of being answered `local: false`.
    const locality = localityWorkspace(url.pathname);
    if (request.method === "GET" && locality !== undefined) {
      const gatewayId = url.searchParams.get("gatewayId") ?? "";
      if (gatewayId === "") { json(response, 400, { code: "invalid_request", error: "a gatewayId is required" }); return true; }
      const binding = options.bindings().find(candidate => candidate.id === locality);
      const connection = binding?.gatewayId === gatewayId ? options.gateways().find(candidate => candidate.gatewayId === gatewayId) : undefined;
      if (connection === undefined) { json(response, 200, { local: false } satisfies WorkspaceLocality); return true; }
      const listed = await options.profiles(connection);
      if (!listed.ok) { json(response, listed.status, { code: listed.code, error: "the execution host could not be read: " + listed.code }); return true; }
      json(response, 200, { local: Array.isArray(listed.value) && listed.value.length === 0 } satisfies WorkspaceLocality); return true;
    }
    return false;
  };
}

/** The workspace id a locality route names, or undefined when this path is some other route. */
function localityWorkspace(pathname: string): string | undefined {
  const prefix = "/api/workspaces/";
  const suffix = "/locality";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (encoded === "" || encoded.includes("/")) return undefined;
  try { return decodeURIComponent(encoded); } catch { return undefined; }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
