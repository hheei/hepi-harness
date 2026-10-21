import type { IncomingMessage, ServerResponse } from "node:http";
import type { FilesystemServer } from "../filesystem.ts";
import { installFailure, type InstallRequest, type InstallServer } from "../install.ts";
import type { GatewayWorkbench } from "../workbench/index.ts";
import type { WorkbenchRequest } from "@hepi/protocol/gateway";
import type { WorktreeRequest, WorktreeServer } from "../worktrees.ts";
import type { WorkspaceRequest, WorkspaceServer } from "../workspaces.ts";
import type { SshWorkspaceServer } from "../ssh-workspaces.ts";
import { readJson, writeJson } from "./http.ts";

/**
 * The host control family: every JSON surface that says what this host serves and changes part of it, besides execution
 * and MCP — the workspaces it was given, their worktrees, the read-only workbench, the JSON file RPC and the
 * installation scopes.
 *
 * What these routes share is one framing: a JSON body in, one declared answer out at 200, and a request whose body is not
 * an object refused as `invalid_request` before any capability is asked. Each route's own facts stay with the capability
 * behind it — the file RPC's methods, git's refusals for a worktree, the installation lock — so this file owns the part
 * no capability does:
 *
 * - An absent capability answers its own named limit rather than a generic failure, so a caller can tell "this host
 *   cannot do that" from "that request was wrong": `operation_failed` for workspaces, `not_supported` for worktrees and
 *   the workbench, a bare refusal for the file RPC and `not_supported` for installations.
 * - A workbench read runs on the host that really holds the workspace, so a caller that goes away ends it: the response's
 *   close aborts the signal the workbench was handed. It answers 409 for a refusal its caller classifies, and a call
 *   cancelled by the caller's own disconnect is not answered at all — there is nobody left to read it.
 * - An error a capability hands back is serialized as the code and message it carries, never as `{}`.
 */

/** The route this family answers, or undefined when the path and method name another family's request. */
export type ControlRoute = "workspaces" | "worktrees" | "workbench" | "files" | "installs";

/** The control route this request names: the exact request target and the method together, and nothing else decides it. */
export function controlRoute(target: string, method: string): ControlRoute | undefined {
	if (method !== "POST") return undefined;
	switch (target) {
		case "/v1/workspaces": return "workspaces";
		case "/v1/worktrees": return "worktrees";
		case "/v1/workbench": return "workbench";
		case "/v1/files": return "files";
		case "/v1/installs": return "installs";
		default: return undefined;
	}
}

/** The capabilities these routes borrow: each is absent on a host that cannot serve it. */
export type ControlCapabilities = {
	readonly files?: FilesystemServer;
	readonly installs?: InstallServer;
	readonly workspaces?: WorkspaceServer | SshWorkspaceServer;
	readonly worktrees?: WorktreeServer;
	readonly workbench?: GatewayWorkbench;
};

/** A capability's own error, as the wire carries it: its code and message, not an empty object. */
function serializedResult(_key: string, value: unknown): unknown {
	return value instanceof Error ? { code: (value as Error & { code?: string }).code, message: value.message } : value;
}

/** The host control routes of one gateway, over the capabilities it borrows. */
export class ControlTransport {
	readonly #capabilities: ControlCapabilities;

	constructor(capabilities: ControlCapabilities) {
		this.#capabilities = capabilities;
	}

	async handle(route: ControlRoute, request: IncomingMessage, response: ServerResponse): Promise<void> {
		const body = await readJson(request);
		// A workspace and a worktree operation are named by the body the capability dispatches on; the other three read
		// their own fields and answer their own refusals.
		const named = route === "workspaces" || route === "worktrees";
		if (!body || typeof body !== "object" || (named && typeof (body as { operation?: unknown }).operation !== "string")) {
			writeJson(response, 400, { ok: false, code: "invalid_request" });
			return;
		}
		if (route === "workbench") {
			const controller = new AbortController();
			response.on("close", () => { if (!response.writableEnded) controller.abort(); });
			const answered = await this.#capabilities.workbench?.execute(body as WorkbenchRequest, { signal: controller.signal }) ?? { ok: false, code: "not_supported" };
			// A cancelled call has no caller left to write to; a refused path keeps the workbench's own 409 and code.
			if (response.writableEnded || response.destroyed) return;
			writeJson(response, answered.ok ? 200 : 409, answered);
			return;
		}
		writeJson(response, 200, await this.#answer(route, body), serializedResult);
	}

	/** The answer one control capability gives, including the named limit of a host that serves no such capability. */
	async #answer(route: Exclude<ControlRoute, "workbench">, body: object): Promise<unknown> {
		if (route === "workspaces") return await this.#capabilities.workspaces?.execute(body as WorkspaceRequest) ?? { ok: false, code: "operation_failed" };
		if (route === "worktrees") return await this.#capabilities.worktrees?.execute(body as WorktreeRequest) ?? { ok: false, code: "not_supported", message: "this host cannot serve worktree operations" };
		if (route === "files") return await this.#capabilities.files?.execute(body as never) ?? { ok: false };
		return await this.#capabilities.installs?.execute(body as InstallRequest) ?? installFailure("not_supported", "installation is not enabled on this gateway");
	}
}
