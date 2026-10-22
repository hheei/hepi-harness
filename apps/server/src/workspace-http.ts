import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { gatewayEnvironment, type EnvironmentBinding, type ExecutionHostEnv } from "@hepi/gateway";
import { PROTOCOL_VERSION } from "@hepi/protocol";
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
  /** One gateway's execution targets, or the code that says why they could not be read. */
  readonly profiles: (connection: GatewayProfileSource) => Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string }>;
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
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
