import type { McpHostResult } from "@hepi/protocol/gateway";
import { isUnboundCwd, workspaceIdOfRoutingPath } from "@hepi/protocol/files";
import { createMcpPanel, hostRefusalStatus, type McpPanelFolderResolver, type McpReply } from "./mcp-panel.ts";

/**
 * MCP configuration and project trust on the client ingress.
 *
 * These routes are not the Backend's, and they are not forwarded to it: the MCP configuration, its credentials and
 * every server process belong to the host this origin runs on, so the ingress answers them itself by reaching that
 * host's own authenticated `POST /v1/mcp`. No MCP credential is handed to the Backend, no client is given the host
 * service's token, and a deployment that configures no such service answers a named limit (`mcp_unavailable`) rather
 * than falling back to some other machine's configuration.
 *
 * A caller still needs an identity: these routes are answered after the ingress admitted one, and a device bearer is
 * re-verified while the request is in flight, so a revoked credential ends an MCP operation the same way it ends any
 * other — a test that starts a server is exactly the kind of request that outlives its admission.
 *
 * The shape of every answer is `@hepi/protocol/mcp-ui`'s, and the aggregate that composes it is `./mcp-panel.ts`'s:
 * the panel and its contract are the gateway's, because this is the entry that answers them. The aggregate is fresh per
 * request because a request's abort signal is what the host call carries.
 *
 * A folder is the one thing this surface does not take on the caller's word. The workspace id a client names is only
 * an address: the Backend owns which gateway a workspace belongs to, so the caller hands in that binding check and a
 * folder whose binding names another gateway is refused here — a name is not an identity, and two machines can each
 * serve a folder called `local`.
 */

/** Why the MCP surface cannot be served here, named rather than refused generically. */
export const MCP_UNAVAILABLE_ERROR = "No MCP host service is configured for this client origin: set HEPI_INGRESS_MCP_GATEWAY_URL and HEPI_INGRESS_MCP_GATEWAY_TOKEN to the gateway that owns this host's MCP configuration";

/** How long one host call may take: a test starts a server and connects it, so it is not a fast read. */
const MCP_HOST_TIMEOUT_MS = 60_000;

/** One admitted MCP request, as the ingress read it. */
export type McpIngressRequest = {
	readonly method: string;
	readonly search: URLSearchParams;
	readonly body: Record<string, unknown>;
	/** Aborted when the identity this request was admitted with stops being valid. */
	readonly signal: AbortSignal;
};

/**
 * The routes the ingress answers itself. They name the host this origin serves rather than a Backend resource, so the
 * entrance is the last place that may decide they are answered locally.
 */
export function handlesMcpRoute(route: string): boolean {
	return route === "mcp" || route.startsWith("mcp/") || route === "project-trust";
}

export function createMcpIngressSurface(
	host: { readonly origin: string; readonly token: string } | undefined,
	/**
	 * Whether the workspace id a client named is a folder on the host this origin's MCP service runs on, as the
	 * Backend binds it. It is the caller's fact — the Backend is reached with the ingress's own service credential —
	 * and the answer decides one question: may this request be sent to that host at all.
	 */
	servesFolder: (workspaceId: string) => Promise<boolean>,
) {
	async function callHost(body: Record<string, unknown>, signal: AbortSignal): Promise<McpHostResult> {
		if (host === undefined) return { ok: false, code: "mcp_unavailable", message: MCP_UNAVAILABLE_ERROR };
		let response: Response;
		try {
			response = await fetch(host.origin + "/v1/mcp", {
				method: "POST",
				headers: { authorization: "Bearer " + host.token, "content-type": "application/json" },
				body: JSON.stringify(body),
				// The request's own deadline, and the admission's: a revoked credential aborts the call, and a host that
				// never answers cannot hold the socket open past the deadline.
				signal: AbortSignal.any([AbortSignal.timeout(MCP_HOST_TIMEOUT_MS), signal]),
			});
		} catch (error) {
			// A host service that cannot be reached is a transport failure, reported as one rather than as an empty success.
			return { ok: false, code: "mcp_unreachable", message: error instanceof Error ? error.message : String(error) };
		}
		if (response.status === 401) return { ok: false, code: "unauthorized", message: "the MCP host service refused this client origin's credential" };
		try {
			return await response.json() as McpHostResult;
		} catch {
			return { ok: false, code: "operation_failed", message: "the MCP host service answered " + response.status };
		}
	}

	/**
	 * Where a browser cwd names a folder the host serves.
	 *
	 * The host is told the workspace id and never a path: which folders a host serves is its own registry's answer, so
	 * this ingress resolves no metadata and synthesizes no path, and a cwd naming another host's folder is refused by
	 * that host (`unknown-workspace`) rather than here. A path that is not the routing vocabulary at all names no
	 * folder this origin serves, which is refused as such; the sentinel that means "no folder" leaves the global
	 * configuration alone.
	 *
	 * The id is not enough on its own, and this is the one place that shows why: the registry of a host is a list of
	 * names it serves, so a request naming `local` would resolve on whichever machine happens to own a folder by that
	 * name. The Backend's binding is what says which gateway that workspace really is, and a request whose workspace
	 * belongs to another gateway is refused here — before it reaches a host that would have answered about its own,
	 * different folder.
	 */
	const resolveCwd: McpPanelFolderResolver = async (cwd) => {
		const workspaceId = workspaceIdOfRoutingPath(cwd);
		if (workspaceId === null) return isUnboundCwd(cwd) ? { kind: "unbound" } : { kind: "refused" };
		// A deployment with no host service answers the named limit for every request, so the folder question is not
		// asked twice: telling a caller "no such folder" when this origin serves no MCP at all would name the wrong
		// limit, and there is no host here whose configuration a wrong folder could reach.
		if (host !== undefined && !await servesFolder(workspaceId)) return { kind: "refused" };
		return { kind: "folder", ref: { workspaceId } };
	};

	async function handle(route: string, request: McpIngressRequest): Promise<McpReply> {
		const panel = createMcpPanel({ call: (body) => callHost(body, request.signal), status: hostRefusalStatus });
		if (route === "project-trust") {
			if (request.method !== "GET") return panel.methodNotAllowed();
			return await panel.projectTrust(request.search, resolveCwd);
		}
		const parts = route.split("/");
		if (parts[1] === "test") {
			if (request.method !== "POST") return panel.methodNotAllowed();
			return await panel.test(request.body, request.search, resolveCwd);
		}
		if (parts[1] === "sign-in") {
			const flowId = parts[2];
			if (flowId === undefined) {
				if (request.method !== "POST") return panel.methodNotAllowed();
				return await panel.signIn(request.body, request.search, resolveCwd);
			}
			if (request.method === "GET") return await panel.signInPoll(flowId, request.search, resolveCwd);
			if (request.method === "POST") return await panel.signInPaste(flowId, request.body, request.search, resolveCwd);
			if (request.method === "DELETE") return await panel.signInCancel(flowId, request.search, resolveCwd);
			return panel.methodNotAllowed();
		}
		if (parts[1] !== undefined) return panel.invalidRequest("unknown MCP route");
		if (request.method === "GET") return await panel.overview(request.search, resolveCwd);
		if (request.method !== "POST") return panel.methodNotAllowed();
		return await panel.action(request.body, request.search, resolveCwd);
	}

	return { handle };
}
