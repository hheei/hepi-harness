import type { IncomingMessage, ServerResponse } from "node:http";
import type { Extension } from "@earendil-works/pi-durable";
import { PROTOCOL_VERSION } from "@hepi/protocol";
import type { ExtensionInstallFailure, ServerHarness } from "./harness.ts";
import { installRequest, toggleRequest, updateRequest, type Installer } from "./skill-install.ts";
import { skillMarketRoute, type SkillMarket } from "./skill-repository.ts";

/**
 * The deployment's own extension surface: the durable extensions this backend installed, the global default
 * selection, and the skill market behind them.
 *
 * Both halves are about what this deployment offers rather than about one conversation. The installed set is the
 * runtime's registry and the tools and sections are those extensions' own, so nothing here can drift from what a
 * conversation is offered; the default is hepi state — it is what a conversation created after a change selects, and it
 * is never read again for a conversation that already exists. The market is repository and host work: browsing and
 * installation are decoupled from conversations, except that an installation names the conversation it installs for.
 */

export type ExtensionsHttpOptions = {
  /** The runtime's own registry: the installed set and each entry's own tools and sections. */
  readonly inventory: () => { readonly protocol: typeof PROTOCOL_VERSION; readonly installed: readonly { name: string; tools: string[]; sections: string[]; enabled: boolean }[]; readonly default: readonly string[]; readonly failures: readonly ExtensionInstallFailure[] };
  /** The selection a request asked to write, refused as a whole when it names something this backend does not have. */
  readonly requestedSelection: (body: unknown, workspaceBound: boolean) => { readonly ok: true; readonly names: readonly string[]; readonly extensions: readonly Extension[] } | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string };
  /** The session the global default is written on. */
  readonly session: ServerHarness["harness"];
  /** Write the global default selection: what the next conversation selects, never an existing one. */
  readonly writeDefault: (session: ServerHarness["harness"], names: readonly string[]) => Promise<unknown>;
  /** The market this deployment serves, when it serves one. */
  readonly market: SkillMarket | undefined;
  /** The installer that publishes and updates skills, when this deployment configured one. */
  readonly installer: Installer | undefined;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

export function createExtensionsHttp(options: ExtensionsHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    // The durable extensions this backend installed and the global default selection.
    if (url.pathname === "/api/extensions") {
      if (request.method === "GET") { json(response, 200, options.inventory()); return true; }
      if (request.method === "POST") {
        const asked = options.requestedSelection(await options.readBody(request), true);
        if (!asked.ok) { json(response, asked.status, { code: asked.code, error: asked.error }); return true; }
        await options.writeDefault(options.session, asked.names);
        json(response, 200, options.inventory()); return true;
      }
      json(response, 405, { error: "method not allowed" }); return true;
    }
    // Repository and market browsing are decoupled from conversations: no conversation is touched or listed here.
    // Installation is the one exception, and it names the conversation it installs for: publication and that
    // conversation's adoption are separate outcomes, and no other conversation is touched.
    if (options.market === undefined || !url.pathname.startsWith("/api/skill-market/")) return false;
    const method = request.method ?? "GET";
    const installer = options.installer;
    if (method === "POST" && url.pathname === "/api/skill-market/install") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const parsed = installRequest(await options.readBody(request));
      if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "a bundle id, an execution target and a scope are required" } }); return true; }
      const installed = await installer.install(parsed);
      json(response, installed.status, installed.body); return true;
    }
    // Updating an installed skill and asking what an update would do both name the installed skill, so they share one
    // body shape: the initiating conversation, the scope, and the bundle to install in its place.
    if (method === "GET" && url.pathname === "/api/skill-market/installed") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const status = await installer.status({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined }, url.searchParams.get("name"), url.searchParams.get("scope"));
      json(response, status.status, status.body); return true;
    }
    // The execution-side skill inventory of one workspace: what the host actually holds, with each installation's
    // provenance, baseline state and source-revision state. No conversation is needed, so browsing does not require an
    // active run; the workspace names the execution target explicitly.
    if (method === "GET" && url.pathname === "/api/skill-market/inventory") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const inventory = await installer.inventory({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined });
      json(response, inventory.status, inventory.body); return true;
    }
    // What one installed skill's source revision is. Asked for explicitly, so browsing a host's skills lists them
    // without reaching the repository: only this request resolves a current commit.
    if (method === "GET" && url.pathname === "/api/skill-market/check") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const checked = await installer.check({ workspaceId: url.searchParams.get("workspaceId") ?? undefined, conversationId: url.searchParams.get("conversationId") ?? undefined }, url.searchParams.get("name"), url.searchParams.get("scope"));
      json(response, checked.status, checked.body); return true;
    }
    // Switching one or many installed skills' model-invocation key. Each directory is answered on its own, so a refusal
    // applies to that directory alone; the edit is written on the execution host, never on this one.
    if (method === "PATCH" && url.pathname === "/api/skill-market/skills") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const parsed = toggleRequest(await options.readBody(request));
      if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "an execution target, a scope, at least one skill directory and the state to switch to are required" } }); return true; }
      const toggled = await installer.toggle(parsed);
      json(response, toggled.status, toggled.body); return true;
    }
    if (method === "POST" && url.pathname === "/api/skill-market/update") {
      if (installer === undefined) { json(response, 404, { error: "installation is not configured" }); return true; }
      const parsed = updateRequest(await options.readBody(request));
      if (parsed === undefined) { json(response, 400, { error: { code: "invalid_request", message: "a bundle id, installed skill name, execution target and scope are required" } }); return true; }
      const updated = await installer.update(parsed);
      json(response, updated.status, updated.body); return true;
    }
    const result = await skillMarketRoute(options.market, method, url.pathname, url.searchParams, method === "POST" ? await options.readBody(request) : undefined);
    if (result === undefined) { json(response, 404, { error: "not found" }); return true; }
    json(response, result.status, result.body); return true;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
