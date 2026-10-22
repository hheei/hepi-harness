import type { IncomingMessage, ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { gatewayEnvironment, type ExecutionHostEnv } from "@hepi/gateway";
import type { WorkbenchOperation } from "@hepi/protocol/gateway";
import { DEFAULT_HOST_HEADER, PROTOCOL_VERSION } from "@hepi/protocol";
import { WEB_HOST_REQUIRED, type GatewayConnection, type ProjectMutation, type ProjectRegistry } from "./project-registry.ts";
import type { ProjectRecord } from "./project-store.ts";
import { safeFailure } from "./public-errors.ts";
import { boundedMessage } from "./skill-install.ts";

/**
 * The recorded Projects and the checkouts of their folders: every route that changes project metadata or asks a host
 * for a checkout, plus the reads that hand a client the projects it may show.
 *
 * The registry is the authority behind all of it. These routes decode a request and encode an answer; the Project row,
 * the retained binding a removal leaves, the revision a mutation advances and the order of a checkout workflow all live
 * in the registry, so a route that wrote any of them itself could publish a Project no lookup resolves or resolve one
 * no store holds. What stays here is what a route owns: the method and path it answers, the body it reads, the status
 * it states and the projection a client reads.
 *
 * A Project's folders are on one recorded host, and a request may confirm that host or name another one. Naming another
 * host never redirects a Project — a Project on a host this Web origin does not serve is reported as belonging to that
 * host instead of showing this origin an account it does not have.
 */

export type ProjectHttpOptions = {
  /** The one owner of project metadata, retained bindings, checkout workflows and their publication revision. */
  readonly registry: ProjectRegistry;
  /** The gateways this deployment configured, by id: a Project's folders report the account of the host they are on. */
  readonly gateways: ReadonlyMap<string, GatewayConnection>;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

/** One project as a client sees it: its identity and name, the host every folder is on, and each recorded folder. */
type ProjectFolderView = { id: string; workspaceId: string; root: string; cwd: string; default: boolean };
type ProjectView = { id: string; name: string; hostId: string; profileId?: string; defaultFolderId: string; folders: ProjectFolderView[]; createdAt: string };

export function createProjectHttp(options: ProjectHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    const registry = options.registry;
    // The directories of the host named on the request, so a folder can be chosen on the computer that serves this Web
    // origin or on a configured remote host. Browsing is that host's own read-only listing: the backend never reads a
    // directory and never substitutes its own account, and the profile is passed through so the listing is the remote
    // host's, not the profile's configured root served locally.
    if (request.method === "GET" && url.pathname === "/api/host/directories") {
      const host = webHostOf(options.gateways, hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!host.ok) { json(response, 409, { code: "configuration_required", error: host.error }); return true; }
      const requested = url.searchParams.get("path");
      const profileId = namedHostId(url.searchParams.get("profileId"));
      const browsed = await registry.hostCall(host.connection, { operation: "browse", ...(requested === null ? {} : { path: requested }), ...(profileId === undefined ? {} : { profileId }) });
      if (!browsed.ok) { json(response, browsed.status, { code: browsed.code, error: "the Web host could not list that folder: " + browsed.code }); return true; }
      json(response, 200, browsed.value); return true;
    }
    // The recorded projects, each with the account of the host its folders live on. Listing is metadata for every
    // project — every folder, and which one is the default — but the account is resolved only for the host the calling
    // Web origin named: another host's projects are reported as belonging to that host instead of showing this origin
    // an account it does not serve.
    if (request.method === "GET" && url.pathname === "/api/projects") {
      const hostId = hostOfRequest(request, namedHostId(url.searchParams.get("hostId")));
      const listed = await Promise.all(registry.projects().map(async (project) => {
        if (project.hostId !== hostId) return { ...projectView(project), hostError: "this project's folders are on gateway " + project.hostId + ", which this Web origin does not serve" };
        // The account is the host's, and any folder of the project answers for it: they are all on that one host.
        const firstFolder = project.folders[0];
        const binding = firstFolder === undefined ? undefined : registry.bindingOfFolder(project, firstFolder);
        if (binding === undefined) return { ...projectView(project), hostError: "the configured gateway " + project.hostId + " is not available" };
        const result = await (gatewayEnvironment(binding, "/") as ExecutionHostEnv).executionHost(BACKGROUND_CONTEXT);
        return result.ok ? { ...projectView(project), host: { user: result.value.user, home: result.value.home } } : { ...projectView(project), hostError: boundedMessage(result.error.message) };
      }));
      json(response, 200, { protocol: PROTOCOL_VERSION, projects: listed }); return true;
    }
    // Creating a project records its identity, display name and the folders chosen on one computer, exactly one of
    // which is its default. Every folder must already exist on the Web host: the gateway validates and canonicalizes
    // each one, and nothing here creates or renames a directory. The request names one host, so a project can never
    // combine folders of two computers; a folder that is not a directory on that host fails the whole request, and no
    // project is recorded until every folder has been accepted.
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const body = await options.readBody(request) as { name?: unknown; folders?: unknown; hostId?: unknown; profileId?: unknown } | undefined;
      const folders = Array.isArray(body?.folders) ? body.folders.map(entry => { const folder = entry as { root?: unknown; default?: unknown }; return { root: typeof folder.root === "string" ? folder.root : "", isDefault: folder.default === true }; }) : undefined;
      if (folders === undefined) { json(response, 400, { code: "invalid_request", error: "at least one folder on the Web host is required" }); return true; }
      const profileId = typeof body?.profileId === "string" && body.profileId.trim() !== "" ? body.profileId.trim() : undefined;
      // The registry owns the whole creation: the host identity, the profile's validation, every folder's registration
      // before anything is recorded, the Project row, the live snapshot it publishes and the revision — a route that
      // wrote any of those itself could publish a Project no lookup resolves, or resolve one no store holds.
      let created: ProjectMutation<ProjectRecord>;
      try {
        created = await registry.create({ name: typeof body?.name === "string" ? body.name : "", folders, ...(profileId === undefined ? {} : { profileId }) }, hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      } catch (error) { json(response, 500, { error: safeFailure(error) }); return true; }
      if (!created.ok) { json(response, created.status, { ...(created.code === undefined ? {} : { code: created.code }), error: created.error }); return true; }
      json(response, 201, { protocol: PROTOCOL_VERSION, project: projectView(created.value) }); return true;
    }
    // Naming another of a project's own folders the default: new conversations bind it from then on, while every
    // conversation already bound keeps the folder it has. This is the metadata contract the project spec defines; no
    // editor for it is part of this phase.
    if (request.method === "PATCH" && url.pathname.startsWith("/api/projects/")) {
      const projectId = decodeURIComponent(url.pathname.slice("/api/projects/".length));
      const body = await options.readBody(request) as { hostId?: unknown; defaultFolderId?: unknown } | undefined;
      // The recorded Project names its host; a named one may only confirm it. Naming a remote Project's own host is what
      // a Web origin does when it edits a folder there, and it stays accepted.
      const changed = registry.setDefault(projectId, typeof body?.defaultFolderId === "string" ? body.defaultFolderId : "", hostOfRequest(request, namedHostId(typeof body?.hostId === "string" ? body.hostId : undefined)));
      if (!changed.ok) { json(response, changed.status, { ...(changed.code === undefined ? {} : { code: changed.code }), error: changed.error }); return true; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(changed.value) }); return true;
    }
    // Unlinking one folder of a project: the folder's own operation, separate from the default selector. A non-default
    // folder goes on its own and the project's default is unchanged. The default folder may only go when the request
    // names another folder of the same project as the replacement in this same call, so no project is ever left without
    // a default. The last folder's removal removes the project record in the same transaction, so no request ever reads
    // a project with no folders. Like a project removal this is metadata only — no directory is created, changed or
    // deleted, no conversation is deleted, no workspace id is reused, no host registration is undone — and it writes the
    // same retained binding for the folder that left, which is what keeps a conversation already bound to it executing
    // while the folder is never a target for a new conversation again.
    if (request.method === "DELETE" && folderUnlinkPath.test(url.pathname)) {
      const [, projectId, folderId] = folderUnlinkPath.exec(url.pathname)!;
      const unlinked = registry.unlink(decodeURIComponent(projectId!), decodeURIComponent(folderId!), namedHostId(url.searchParams.get("defaultFolderId")), hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!unlinked.ok) { json(response, unlinked.status, { ...(unlinked.code === undefined ? {} : { code: unlinked.code }), error: unlinked.error }); return true; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: unlinked.value.project === null ? null : projectView(unlinked.value.project), removedFolderId: unlinked.value.removedFolderId }); return true;
    }
    // Removing a project removes metadata only: the project record and its folder links go, in one transaction with the
    // retained binding of every folder, and nothing else changes. No directory on the host is created, changed or
    // deleted, no conversation is deleted, no workspace id is reused and no host registration is undone. Nothing is
    // refused because conversations are bound — no conversation is read here at all — and the retained bindings keep the
    // removed folders resolvable for the conversations that already hold them while never becoming a target for a new
    // one.
    if (request.method === "DELETE" && url.pathname.startsWith("/api/projects/")) {
      const removed = registry.remove(decodeURIComponent(url.pathname.slice("/api/projects/".length)), hostOfRequest(request, namedHostId(url.searchParams.get("hostId"))));
      if (!removed.ok) { json(response, removed.status, { ...(removed.code === undefined ? {} : { code: removed.code }), error: removed.error }); return true; }
      json(response, 200, { protocol: PROTOCOL_VERSION, project: projectView(removed.value) }); return true;
    }
    // One checkout of a folder: its listing, creation and removal. The registry owns the whole workflow — the host's own
    // git answer, the registration of a new root, the folder record and the publication — so this route decodes the
    // operation and states the answer. A refusal keeps its own status and code, including the partial outcome of a
    // checkout the host made and this deployment could not record.
    if (request.method === "POST" && url.pathname === "/api/worktrees") {
      const body = await options.readBody(request) as { workspaceId?: unknown; operation?: unknown; branch?: unknown; path?: unknown; force?: unknown } | undefined;
      const workspaceId = typeof body?.workspaceId === "string" ? body.workspaceId : "";
      const operation = typeof body?.operation === "string" ? body.operation : "";
      const result = operation === "list" ? await registry.listCheckouts(workspaceId)
        : operation === "create" ? await registry.createCheckout(workspaceId, typeof body?.branch === "string" ? body.branch : "")
        : operation === "remove" ? await registry.removeCheckout(workspaceId, typeof body?.path === "string" ? body.path : "", body?.force === true)
        : { ok: false as const, status: 400, code: "invalid_request", error: "unknown worktree operation" };
      if (result.ok) json(response, 200, { ok: true, value: result.value });
      else { const { status, ...refusal } = result; json(response, status, refusal); }
      return true;
    }
    // The read-only workbench proxy: one operation on the execution host of a resolved workspace. Every operation reads,
    // so nothing here may run twice and a lost answer is only an unreachable host; the host's own refusal keeps its code
    // and this route answers it with the status it always did.
    if (request.method === "POST" && url.pathname === "/api/workbench") {
      const body = await options.readBody(request) as { workspaceId?: string; operation?: string; path?: string } | undefined;
      const binding = await registry.ensureBinding(body?.workspaceId);
      if (binding === undefined) { json(response, 404, { ok: false, code: "unknown_workspace" }); return true; }
      if (!["files", "read", "changes", "diff"].includes(body?.operation ?? "")) { json(response, 400, { ok: false, code: "invalid_request" }); return true; }
      const operation = body!.operation as WorkbenchOperation;
      const target = body!.path;
      const result = await registry.workbench(binding, { workspaceId: binding.id, operation, ...(target === undefined ? {} : { path: target }) });
      json(response, result.ok ? 200 : result.code === "gateway_offline" ? 503 : 409, result);
      return true;
    }
    return false;
  };
}

/**
 * One folder of one project, as the unlink route addresses it: `/api/projects/<projectId>/folders/<folderId>`. The folder
 * is named inside the project's own path because it is the project's folder and not a workspace, and the two ids are
 * captured undecoded so a percent-encoded id reaches the store as the caller sent it.
 */
const folderUnlinkPath = /^\/api\/projects\/([^/]+)\/folders\/([^/]+)$/;

/** The gateway id a Web origin named for the host it serves, as it arrives on a host-scoped request. */
const namedHostId = (value: string | null | undefined): string | undefined => value === null || value === undefined || value.trim() === "" ? undefined : value.trim();
/**
 * The host a host-scoped route acts on: the one the request named, or the one the ingress stated when it named none. A
 * caller may still narrow a request to a host it knows, but it cannot substitute one for the deployment's default,
 * because naming a host the deployment does not serve is refused by the same resolution the stated one goes through.
 */
const hostOfRequest = (request: IncomingMessage, named: string | undefined): string | undefined => named ?? statedDefaultHost(request);
const statedDefaultHost = (request: IncomingMessage): string | undefined => {
  const header = request.headers[DEFAULT_HOST_HEADER];
  return namedHostId(typeof header === "string" ? header : undefined);
};
/**
 * The gateway a Web origin named for the host it serves, resolved against the configured connections. The Web UI server
 * owns that mapping (`HEPI_WEB_LOCAL_GATEWAY_ID`), because the host a browser is served from is a property of the Web
 * origin and not of this process: two origins can share one backend with a different local host each.
 */
const webHostOf = (gateways: ReadonlyMap<string, GatewayConnection>, hostId: string | undefined): { ok: true; connection: GatewayConnection } | { ok: false; error: string } => {
  if (hostId === undefined) return { ok: false, error: WEB_HOST_REQUIRED };
  const connection = gateways.get(hostId);
  return connection === undefined
    ? { ok: false, error: "the Web UI server named gateway " + hostId + ", which this deployment does not configure" }
    : { ok: true, connection };
};

function projectView(project: ProjectRecord): ProjectView {
  return {
    id: project.id,
    name: project.name,
    hostId: project.hostId,
    ...(project.profileId === undefined ? {} : { profileId: project.profileId }),
    defaultFolderId: project.defaultFolderId,
    folders: project.folders.map(folder => ({ id: folder.id, workspaceId: folder.workspaceId, root: folder.root, cwd: "/workspace/" + folder.workspaceId, default: folder.id === project.defaultFolderId })),
    createdAt: project.createdAt,
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
