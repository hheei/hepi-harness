import { GatewayHostClient } from "@hepi/gateway";
import { catalogueWorkspace, type CatalogueBinding, type CatalogueWorkspace } from "./catalogue-binding.ts";
import type { DefaultFolderChange, FolderAddition, FolderUnlink, NewProject, NewProjectFolder, ProjectFolder, ProjectRecord, ProjectRemoval, ProjectStore, RetainedBinding } from "./project-store.ts";
import type { EnvironmentBinding } from "@hepi/gateway";

/** One configured gateway: where a host is reached, and the credential this deployment reaches it with. */
export type GatewayConnection = { readonly gatewayId: string; readonly gatewayOrigin: string; readonly gatewayToken: string };

/** A binding a removal retained, as the workspace listing states it: resolvable, never a target. */
type RetainedEnvironmentBinding = EnvironmentBinding & { readonly retained: true };

export type ProjectRegistryOptions = {
	/** The workspaces this deployment configured, by id. */
	readonly workspaces?: readonly EnvironmentBinding[];
	/** Every gateway this deployment configured, by id. A recorded Project names one of them. */
	readonly gateways?: readonly GatewayConnection[];
	/**
	 * The durable Project metadata. Optional: a deployment that could not open the store still resolves, prepares and
	 * lists its configured workspaces, and every project mutation answers that nothing is recorded.
	 */
	readonly projects?: ProjectStore;
};

/**
 * The backend's project/workspace registry: the one owner of the configured workspaces, the optional ProjectStore, the
 * configured gateway connections and the live metadata a conversation resolves through.
 *
 * It exists because three things have to agree and used to be spliced together by HTTP routes: **which** workspace id a
 * conversation is bound to (configured, then retained, then a Project folder), **what** that means for a caller (the
 * catalogue row's host, root, group and retention), and **how** the root gets re-asserted on its host after a gateway
 * restart. A route that had to know all three could publish a Project it had not recorded, or record one no
 * conversation could reach.
 *
 * The three groups of operations are the callers' whole vocabulary:
 *
 * - **Read** — {@link ProjectRegistry.resolve}, {@link ProjectRegistry.catalogueOf},
 *   {@link ProjectRegistry.bindingOf}, {@link ProjectRegistry.projects}, {@link ProjectRegistry.retained},
 *   {@link ProjectRegistry.targets}, {@link ProjectRegistry.bindings}, {@link ProjectRegistry.isTarget},
 *   {@link ProjectRegistry.revision}. No host I/O: one catalogue row costs no round trip.
 * - **Execution preparation** — {@link ProjectRegistry.registerAll} and {@link ProjectRegistry.ensureBinding}. Both
 *   re-assert a recorded root on its own host, which is the only thing ever replayed; an execution or a write whose
 *   outcome was unknown is never repeated.
 * - **Mutation** — {@link ProjectRegistry.create}, {@link ProjectRegistry.addFolder},
 *   {@link ProjectRegistry.setDefault}, {@link ProjectRegistry.unlink}, {@link ProjectRegistry.remove}. Each owns the
 *   store write, the live snapshot and the publication revision, so no caller edits an array or increments a counter.
 *   The caller still validates and registers a root on its host **before** recording it (host I/O does not belong in a
 *   store transaction); a failed store write leaves the snapshot and the revision untouched.
 *
 * The live snapshot is this process's own view of the durable rows, refreshed by the mutations above and never read
 * back from the store on a lookup. {@link ProjectRegistry.revision} is process-local and opaque: it is published on the
 * catalogue read so another window can tell "nothing changed" from "a Project moved", and it implies no cross-process
 * synchronisation. The registry borrows the store's lifetime from its creator and never closes it.
 */
export type ProjectRegistry = {
	/** How one workspace id resolves, in this deployment's one precedence order. */
	resolve(workspaceId: string | undefined): CatalogueBinding | undefined;
	/** The catalogue row's workspace facts, from the same resolution. */
	catalogueOf(workspaceId: string | undefined): CatalogueWorkspace | undefined;
	/** The transport binding of one workspace, without re-asserting its root: a lookup, not a preparation. */
	bindingOf(workspaceId: string | undefined): EnvironmentBinding | undefined;
	/**
	 * The transport binding of one recorded folder of one Project. Separate from {@link ProjectRegistry.bindingOf}
	 * because a caller that holds the Project — a checkout about to become a folder, a listing resolving a Project's
	 * host account — names a folder, not a workspace id, and a folder it just recorded may not be in the snapshot yet.
	 */
	bindingOfFolder(project: ProjectRecord, folder: ProjectFolder): EnvironmentBinding | undefined;
	/** Every recorded Project, oldest first. */
	projects(): readonly ProjectRecord[];
	/** Every binding a removal retained, oldest first. */
	retained(): readonly RetainedBinding[];
	/** Every binding a **new** operation may name: the configured workspaces and the recorded Project folders. */
	targets(): readonly EnvironmentBinding[];
	/** Everything a bound conversation can resolve: every target, plus each retained binding with its marker. */
	bindings(): readonly (EnvironmentBinding & { readonly retained?: true })[];
	/** Whether a new conversation may bind this id: a configured workspace or a recorded Project folder. */
	isTarget(workspaceId: string | undefined): boolean;
	/** The publication revision: once per accepted mutation, never for a read or a refusal. */
	revision(): number;
	/** Whether this deployment can record Project metadata at all: the preflight a mutation route asks before host I/O. */
	canRecord(): boolean;
	/** The configured gateway a host id names, and every configured gateway. No host I/O. */
	connection(gatewayId: string): GatewayConnection | undefined;
	connections(): readonly GatewayConnection[];
	/** Replay every recorded folder and every retained root on its host. Boot does this once. */
	registerAll(): Promise<void>;
	/** Resolve once, re-assert a Project or retained root on its recorded host, and answer the transport binding. */
	ensureBinding(workspaceId: string | undefined): Promise<RetainedEnvironmentBinding | EnvironmentBinding | undefined>;
	/** Re-assert one recorded folder's root on its Project's host, for a caller that already holds the folder. */
	ensureFolder(project: ProjectRecord, folder: ProjectFolder): Promise<void>;
	/**
	 * The five recorded mutations. Each owns the store write, the live snapshot and the publication revision, and each
	 * answers `undefined` when this deployment records no Projects — the unavailable outcome every caller already
	 * reports, never a silent success.
	 */
	create(project: NewProject): ProjectRecord | undefined;
	addFolder(projectId: string, folder: NewProjectFolder, createdAt: string): FolderAddition | undefined;
	setDefault(projectId: string, folderId: string): DefaultFolderChange | undefined;
	unlink(projectId: string, folderId: string, replacementDefaultId?: string): FolderUnlink | undefined;
	remove(projectId: string): ProjectRemoval | undefined;
};

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
	const store = options.projects;
	const workspaces = options.workspaces ?? [];
	const gateways = new Map((options.gateways ?? []).map(connection => [connection.gatewayId, connection]));
	// The live metadata: the store's rows as this process last accepted them. A mutation replaces its own entry, so a
	// lookup never re-reads the store and a conversation's resolution cannot disagree with the row it was published with.
	let projects: ProjectRecord[] = [...(store?.list() ?? [])];
	let retained: RetainedBinding[] = [...(store?.retained() ?? [])];
	let revision = 0;
	const configured = new Map(workspaces.map(binding => [binding.id, binding]));

	const folderBinding = (project: ProjectRecord, folder: ProjectFolder): EnvironmentBinding | undefined => {
		const connection = gateways.get(project.hostId);
		return connection === undefined ? undefined : { id: folder.workspaceId, gatewayId: project.hostId, gatewayOrigin: connection.gatewayOrigin, gatewayToken: connection.gatewayToken };
	};
	const retainedBinding = (record: RetainedBinding): RetainedEnvironmentBinding | undefined => {
		const connection = gateways.get(record.hostId);
		return connection === undefined ? undefined : { id: record.workspaceId, gatewayId: record.hostId, gatewayOrigin: connection.gatewayOrigin, gatewayToken: connection.gatewayToken, retained: true };
	};
	/**
	 * One root re-asserted on its host, with the profile the Project is on. The answer is deliberately not read: every
	 * caller replays registration idempotently and reports nothing, because the request that follows decides whether the
	 * host can serve it, and a host that cannot be reached stays unreachable rather than being retried elsewhere.
	 */
	const register = async (connection: GatewayConnection, workspaceId: string, root: string, profileId: string | undefined): Promise<void> => {
		try {
			await new GatewayHostClient({ gatewayOrigin: connection.gatewayOrigin, gatewayToken: connection.gatewayToken }).control.workspaces({ operation: "register", workspaceId, root, ...(profileId === undefined ? {} : { profileId }) });
		} catch {
			// A lost registration is replayed by the next preparation of the same workspace; it is never reported as the
			// answer to the request that needed it.
		}
	};
	const registerFolder = async (project: ProjectRecord, folder: ProjectFolder): Promise<void> => {
		const connection = gateways.get(project.hostId);
		if (connection !== undefined) await register(connection, folder.workspaceId, folder.root, project.profileId);
	};
	const registerRetained = async (record: RetainedBinding): Promise<void> => {
		const connection = gateways.get(record.hostId);
		if (connection !== undefined) await register(connection, record.workspaceId, record.root, record.profileId);
	};
	/** The Project and folder a workspace id is, over every folder of every Project — never only a Project's default. */
	const folderOf = (workspaceId: string): { readonly project: ProjectRecord; readonly folder: ProjectFolder } | undefined => {
		for (const project of projects) {
			const folder = project.folders.find(candidate => candidate.workspaceId === workspaceId);
			if (folder !== undefined) return { project, folder };
		}
		return undefined;
	};
	const resolve = (workspaceId: string | undefined): CatalogueBinding | undefined => {
		if (workspaceId === undefined) return undefined;
		const direct = configured.get(workspaceId);
		if (direct !== undefined) return { kind: "configured", workspaceId, gatewayId: direct.gatewayId };
		const kept = retained.find(record => record.workspaceId === workspaceId);
		if (kept !== undefined) return { kind: "retained", record: kept, gatewayId: kept.hostId };
		const owner = folderOf(workspaceId);
		return owner === undefined ? undefined : { kind: "project", project: owner.project, folder: owner.folder, gatewayId: owner.project.hostId };
	};
	const transportOf = (resolved: CatalogueBinding): EnvironmentBinding | undefined => {
		if (resolved.kind === "configured") return configured.get(resolved.workspaceId);
		if (resolved.kind === "retained") return retainedBinding(resolved.record);
		return folderBinding(resolved.project, resolved.folder);
	};
	const targets = (): readonly EnvironmentBinding[] => [
		...workspaces,
		...projects.flatMap(project => project.folders.flatMap(folder => { const binding = folderBinding(project, folder); return binding === undefined ? [] : [binding]; })),
	];
	/** Replace one Project's live entry with the row a mutation just recorded, keeping the list's own order. */
	const replace = (project: ProjectRecord | null, projectId: string): void => {
		const index = projects.findIndex(candidate => candidate.id === projectId);
		if (index < 0) return;
		if (project === null) projects = projects.filter(candidate => candidate.id !== projectId);
		else projects = projects.map((candidate, position) => position === index ? project : candidate);
	};
	const accept = (): void => { revision += 1; };
	return {
		resolve,
		catalogueOf: (workspaceId) => { const resolved = resolve(workspaceId); return resolved === undefined ? undefined : catalogueWorkspace(resolved); },
		bindingOf: (workspaceId) => { const resolved = resolve(workspaceId); return resolved === undefined ? undefined : transportOf(resolved); },
		bindingOfFolder: folderBinding,
		projects: () => projects,
		retained: () => retained,
		targets,
		bindings: () => [...targets(), ...retained.flatMap(record => { const binding = retainedBinding(record); return binding === undefined ? [] : [binding]; })],
		isTarget: (workspaceId) => workspaceId !== undefined && (configured.has(workspaceId) || folderOf(workspaceId) !== undefined),
		revision: () => revision,
		canRecord: () => store !== undefined,
		connection: (gatewayId) => gateways.get(gatewayId),
		connections: () => [...gateways.values()],
		registerAll: async () => {
			// Every recorded folder's root lives in a gateway's memory, so all of them are replayed on every start: a
			// Project's extra folders hold no conversation yet, but a conversation created against one of them has to find
			// it registered.
			await Promise.all([
				...projects.flatMap(project => project.folders.map(folder => registerFolder(project, folder))),
				...retained.map(record => registerRetained(record)),
			]);
		},
		ensureBinding: async (workspaceId) => {
			// One resolution, and the record it names is what re-asserts the root: a Project folder through its own
			// folder, and a retained binding — which has no Project and no folder row left — through the record the removal
			// wrote. A configured workspace has nothing to re-assert: its root is the gateway's own.
			const resolved = resolve(workspaceId);
			if (resolved === undefined) return undefined;
			if (resolved.kind === "project") await registerFolder(resolved.project, resolved.folder);
			else if (resolved.kind === "retained") await registerRetained(resolved.record);
			return transportOf(resolved);
		},
		ensureFolder: registerFolder,
		create: (project) => {
			if (store === undefined) return undefined;
			const created = store.create(project);
			projects = [...projects, created];
			accept();
			return created;
		},
		addFolder: (projectId, folder, createdAt) => {
			if (store === undefined) return undefined;
			const added = store.addFolder(projectId, folder, createdAt);
			if (!added.ok) return added;
			replace(added.project, projectId);
			accept();
			return added;
		},
		setDefault: (projectId, folderId) => {
			if (store === undefined) return undefined;
			const changed = store.setDefault(projectId, folderId);
			if (!changed.ok) return changed;
			replace(changed.project, projectId);
			accept();
			return changed;
		},
		unlink: (projectId, folderId, replacementDefaultId) => {
			if (store === undefined) return undefined;
			const unlinked = store.unlink(projectId, folderId, replacementDefaultId);
			if (!unlinked.ok) return unlinked;
			replace(unlinked.project, projectId);
			retained = [...retained, unlinked.retained];
			accept();
			return unlinked;
		},
		remove: (projectId) => {
			if (store === undefined) return undefined;
			const removed = store.remove(projectId);
			if (!removed.ok) return removed;
			replace(null, projectId);
			retained = [...retained, ...removed.retained];
			accept();
			return removed;
		},
	};
}
