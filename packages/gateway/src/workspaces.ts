import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkspaceConfig, WorkspaceRegistration, WorkspaceRequest, WorkspaceResult } from "@hepi/protocol/gateway";
import type { ExecutionHostIdentity } from "./filesystem.ts";
import { existingDir } from "./filesystem.ts";

// The shapes this surface answers with belong to the wire, so they are declared once in `@hepi/protocol/gateway` and
// re-exported here under the names this package has always exported.
export type { WorkspaceConfig, WorkspaceDirectory, WorkspaceListing, WorkspaceProfile, WorkspaceRegistration, WorkspaceRequest, WorkspaceResult } from "@hepi/protocol/gateway";

/** A workspace id a gateway and the backend both name: no path separators, no whitespace, bounded length. */
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_WORKSPACE_ID = 128;

/**
 * The workspaces one gateway serves, shared by its execution, filesystem, installation and workbench surfaces.
 *
 * Before this registry each of those held its own copy fixed at construction, so a root could only ever come from the
 * gateway's environment. Registration adds an existing directory to every one of them at once; it never creates or
 * renames a directory, and the root it stores is the canonical path it validated.
 */
export class WorkspaceRegistry {
	readonly #workspaces = new Map<string, WorkspaceConfig>();

	constructor(initial: readonly WorkspaceConfig[] = []) {
		for (const workspace of initial) this.#workspaces.set(workspace.id, workspace);
	}

	list(): readonly WorkspaceConfig[] { return [...this.#workspaces.values()]; }
	ids(): readonly string[] { return [...this.#workspaces.keys()]; }
	get(id: string): WorkspaceConfig | undefined { return this.#workspaces.get(id); }

	/**
	 * Register an existing directory under `id`. Registering the same id and root again is idempotent, because a
	 * backend replays its project bindings on every start; a different root for an id already in use is refused
	 * instead of silently moving a workspace another conversation may be bound to.
	 */
	async register(id: string, root: string): Promise<WorkspaceRegistration> {
		if (id.length === 0 || id.length > MAX_WORKSPACE_ID || !WORKSPACE_ID_PATTERN.test(id)) return { ok: false, code: "invalid_workspace_id" };
		if (!isAbsolute(root)) return { ok: false, code: "invalid_root" };
		const canonical = await existingDir(root);
		if (canonical === undefined) return { ok: false, code: "invalid_root" };
		const existing = this.#workspaces.get(id);
		if (existing !== undefined) {
			// A seeded root is stored as configured, so both sides are canonicalized before they are compared: the same
			// directory named twice (a symlinked parent, a trailing slash) is idempotent, not a conflict.
			const existingRoot = (await existingDir(existing.root)) ?? resolve(existing.root);
			return existingRoot === canonical
				? { ok: true, value: { id, root: canonical, created: false } }
				: { ok: false, code: "workspace_conflict" };
		}
		this.#workspaces.set(id, { id, root: canonical });
		return { ok: true, value: { id, root: canonical, created: true } };
	}

	/**
	 * Register a root another host already resolved and canonicalized, so an SSH folder is never validated against
	 * this machine's filesystem. The id rules and the conflict rule are the same as `register`: the same id with the
	 * same root is idempotent, a different root is refused rather than moving a workspace a conversation may hold.
	 */
	registerResolved(id: string, root: string, profileId: string): WorkspaceRegistration {
		if (id.length === 0 || id.length > MAX_WORKSPACE_ID || !WORKSPACE_ID_PATTERN.test(id)) return { ok: false, code: "invalid_workspace_id" };
		if (!isAbsolute(root)) return { ok: false, code: "invalid_root" };
		const existing = this.#workspaces.get(id);
		if (existing !== undefined) {
			return existing.root === root && existing.profileId === profileId
				? { ok: true, value: { id, root, created: false } }
				: { ok: false, code: "workspace_conflict" };
		}
		this.#workspaces.set(id, { id, root, profileId });
		return { ok: true, value: { id, root, created: true } };
	}
}

/** The workspace entries an SSH gateway starts with: one per profile, under the id the CLI contract already uses. */
export function sshWorkspaceSeed<TProfile extends { readonly id: string; readonly remoteRoot: string }>(profiles: readonly TProfile[]): readonly WorkspaceConfig[] {
	return profiles.map(profile => ({ id: "remote-" + profile.id, root: profile.remoteRoot, profileId: profile.id }));
}

/**
 * Which profile and root one workspace id names, resolved once for every SSH surface. The id is looked up as an
 * opaque key — never parsed — so a registered folder resolves to the profile it was registered with, and an id that
 * was never registered is unknown rather than defaulting to the first profile or to a prefix that happens to match.
 */
export function workspaceOwner<TProfile>(
	registry: WorkspaceRegistry,
	profiles: ReadonlyMap<string, TProfile>,
	workspaceId: string,
): { readonly profile: TProfile; readonly profileId: string; readonly root: string } | undefined {
	const workspace = registry.get(workspaceId);
	const profileId = workspace?.profileId;
	if (workspace === undefined || profileId === undefined) return undefined;
	const profile = profiles.get(profileId);
	return profile === undefined ? undefined : { profile, profileId, root: workspace.root };
}

export type WorkspaceServerOptions = {
	/** The execution account the browse runs as. The gateway passes its own process account; tests inject one. */
	readonly identity: ExecutionHostIdentity;
};

/**
 * The workspace management surface `GatewayRpcServer` serves on `/v1/workspaces`: which workspaces this gateway
 * serves, adding an existing directory to them, and listing the host's own directories so one can be chosen.
 *
 * Browsing is deliberately not confined to a workspace root — choosing a root is what it is for — so it is read-only
 * (directory names only, never file content) and runs as the gateway's own execution account. Nothing else changes:
 * every file and execution request stays confined to the workspace it names.
 */
export class WorkspaceServer {
	readonly #registry: WorkspaceRegistry;
	readonly #identity: ExecutionHostIdentity;

	constructor(registry: WorkspaceRegistry, options: WorkspaceServerOptions) {
		this.#registry = registry;
		this.#identity = options.identity;
	}

	async execute(request: WorkspaceRequest): Promise<WorkspaceResult> {
		if (request.operation === "list") return { ok: true, value: this.#registry.list() };
		// This gateway serves the machine it runs on and holds no configured SSH profile, so it offers no remote
		// execution target. The answer is the empty list, not a refusal: "none here" is a fact about this host.
		if (request.operation === "profiles") return { ok: true, value: [] };
		if (request.operation === "register") {
			if (typeof request.workspaceId !== "string" || typeof request.root !== "string") return { ok: false, code: "invalid_request" };
			// This surface serves the gateway's own machine: a profile names another host, and this gateway has none.
			if (request.profileId !== undefined) return { ok: false, code: "invalid_request" };
			const registered = await this.#registry.register(request.workspaceId, request.root);
			return registered.ok ? registered : { ok: false, code: registered.code };
		}
		if (request.operation === "browse") {
			if (request.profileId !== undefined) return { ok: false, code: "invalid_request" };
			return await this.browse(request.path);
		}
		return { ok: false, code: "invalid_request" };
	}

	/** The directories below `path`, or the execution account's home when no path is named. */
	async browse(path?: string): Promise<WorkspaceResult> {
		const requested = path === undefined || path.trim() === "" ? this.#identity.home : path;
		if (!isAbsolute(requested)) return { ok: false, code: "invalid_request" };
		try {
			const canonical = await realpath(requested);
			if (!(await stat(canonical)).isDirectory()) return { ok: false, code: "not_a_directory" };
			const entries = await readdir(canonical, { withFileTypes: true });
			const directories = entries
				.filter(entry => entry.isDirectory())
				.map(entry => ({ name: entry.name, path: join(canonical, entry.name) }))
				.sort((left, right) => left.name.localeCompare(right.name));
			const parent = join(canonical, "..");
			// The account travels with the listing: a UI can name the computer the folders are on instead of implying
			// that identical paths on two hosts are the same place.
			return { ok: true, value: { path: canonical, parentPath: parent === canonical ? null : resolve(parent), directories, host: this.#identity } };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, code: "not_found" };
			if (code === "EACCES" || code === "EPERM") return { ok: false, code: "permission_denied" };
			return { ok: false, code: "operation_failed" };
		}
	}
}
