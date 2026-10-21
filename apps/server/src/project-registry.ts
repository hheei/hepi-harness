import { randomUUID } from "node:crypto";
import { GatewayHostClient, HostTransportError, type EnvironmentBinding } from "@hepi/gateway";
import type { WorkspaceRequest, WorktreeRequest, WorktreeListing } from "@hepi/protocol/gateway";
import { catalogueWorkspace, type CatalogueBinding, type CatalogueWorkspace } from "./catalogue-binding.ts";
import type { NewProjectFolder, ProjectFolder, ProjectRecord, ProjectStore, RetainedBinding } from "./project-store.ts";

/**
 * What a project mutation answers: the committed metadata, or the reason nothing was recorded. A refusal carries its own
 * code, status and sentence, because those are properties of the workflow — a host that cannot be reached, a Project on
 * another host, a default folder that needs a replacement — and not of the transport the request happened to arrive on.
 * An HTTP route states the answer it is given instead of translating it.
 */
export type ProjectMutation<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly code?: string; readonly status: number; readonly error: string };

export type CheckoutResult<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly code: string; readonly status: number; readonly error: string; readonly dirty?: true };
export type CheckoutListing = Omit<WorktreeListing, "worktrees"> & { readonly worktrees: readonly (WorktreeListing["worktrees"][number] & { readonly workspaceId?: string })[] };

/** What a caller asks the registry to record, as it decoded it: the name and folders a request named. */
export type NewProjectRequest = {
	readonly name: string;
	readonly folders: readonly { readonly root: string; readonly isDefault: boolean }[];
	/** The one configured profile of that host its folders are on, when the host is an SSH gateway. */
	readonly profileId?: string;
};

/**
 * A Web origin names the gateway that serves its own execution host, and a request that names none cannot be turned
 * into a guessed host: two Web origins can be pointed at one backend, and the backend's own account is unrelated to
 * either. The message is stated once, here, because the workflow that records a Project and the route that browses a
 * host give the same refusal for the same omission.
 */
export const WEB_HOST_REQUIRED = "no Web host gateway is named: the Web UI server sends the configured gateway id it serves (HEPI_WEB_LOCAL_GATEWAY_ID) on every host-scoped request";

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
 * - **Mutation** — {@link ProjectRegistry.create}, {@link ProjectRegistry.setDefault},
 *   {@link ProjectRegistry.unlink}, {@link ProjectRegistry.remove} are the four workflows a project route performs, and
 *   the checkout workflows own host creation/removal through metadata publication. Each owns the host identity the operation acts on,
 *   the registration of a root on that host **before** anything is recorded (host I/O does not belong in a store
 *   transaction), the store write, the live snapshot and the publication revision. A caller decodes a request, names
 *   the host its Web origin serves and encodes the answer; it never looks a Project up to splice it, re-resolves the
 *   host, edits an array or increments a counter. A refusal, a failed store write and a read leave the snapshot and the
 *   revision untouched.
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
	 * The four Project workflows. Each takes the host id the calling Web origin named (`hostId`), resolves the host the
	 * operation belongs to, performs the host work it needs, records the outcome and publishes it; each answers a
	 * refusal, with its own status, instead of a half-applied change. A deployment that records no Projects answers
	 * "project storage is not configured".
	 *
	 * - `create` registers every folder on the named host first, so nothing is recorded unless the host accepted it.
	 * - `setDefault`, `unlink` and `remove` act on the host the **Project records**, which the request may only confirm.
	 *   They are metadata-only: no directory is created, changed or deleted, and no host registration is undone.
	 */
	create(request: NewProjectRequest, hostId: string | undefined): Promise<ProjectMutation<ProjectRecord>>;
	setDefault(projectId: string, folderId: string, hostId: string | undefined): ProjectMutation<ProjectRecord>;
	unlink(projectId: string, folderId: string, replacementDefaultId: string | undefined, hostId: string | undefined): ProjectMutation<{ readonly project: ProjectRecord | null; readonly removedFolderId: string }>;
	remove(projectId: string, hostId: string | undefined): ProjectMutation<ProjectRecord>;
	/** Host checkouts joined with recorded targets; reads never publish a metadata revision. */
	listCheckouts(workspaceId: string): Promise<CheckoutResult<CheckoutListing>>;
	/** Host creation, registration and metadata publication; partial host success answers not_recorded. */
	createCheckout(workspaceId: string, branch: string): Promise<CheckoutResult<{ readonly path: string; readonly branch: string; readonly workspaceId: string }>>;
	/** Default-folder preflight, host removal, then metadata unlink and retained publication. */
	removeCheckout(workspaceId: string, path: string, force: boolean): Promise<CheckoutResult<unknown>>;
};

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
	const store = options.projects;
	/** The one answer a deployment that records no Projects gives a mutation: its existing unavailable outcome. */
	const notRecorded: ProjectMutation<never> = { ok: false, status: 500, error: "project storage is not configured" };
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
	/**
	 * One request to a gateway's workspace surface, with the answer the workflow needs: a success, the host's own
	 * refusal (which keeps its code) or a transport failure classified by whether a repetition is safe. A registration
	 * may have run when its answer was lost, so it is reported as an unknown outcome instead of an offline host.
	 */
	const hostCall = async (connection: GatewayConnection, request: WorkspaceRequest): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly status: number }> => {
		try {
			const result = await new GatewayHostClient({ gatewayOrigin: connection.gatewayOrigin, gatewayToken: connection.gatewayToken }).control.workspaces(request);
			return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code, status: result.code === "workspace_conflict" ? 409 : 400 };
		} catch (error) {
			const code = error instanceof HostTransportError ? error.code : "gateway_offline";
			const mutating = request.operation === "register";
			if (code === "outcome_unknown" || (mutating && (code === "timeout" || code === "aborted"))) return { ok: false, code: "outcome_unknown", status: 503 };
			if (code === "gateway_offline" || code === "timeout" || code === "aborted") return { ok: false, code: "gateway_offline", status: 503 };
			return { ok: false, code: "gateway_error", status: 502 };
		}
	};
	/**
	 * The host a recorded Project's metadata operations act on: the one the Project itself names, which the request may
	 * only confirm. A Project's folders live on one host, recorded when it was created, and that is the identity the
	 * operation belongs to — the calling Web origin's own host mapping says which computer it serves, not which host
	 * every Project it can see is on.
	 */
	const projectHost = (project: ProjectRecord, named: string | undefined): { readonly ok: true; readonly connection: GatewayConnection } | { readonly ok: false; readonly code: "wrong_host" | "configuration_required"; readonly status: number; readonly error: string } => {
		if (named !== undefined && named !== project.hostId) return { ok: false, code: "wrong_host", status: 409, error: "this project's folders are on gateway " + project.hostId + ", which this Web origin does not serve" };
		const connection = gateways.get(project.hostId);
		return connection === undefined
			? { ok: false, code: "configuration_required", status: 409, error: "the gateway " + project.hostId + " this project's folders are on is not configured" }
			: { ok: true, connection };
	};
	const projectOf = (projectId: string): ProjectRecord | undefined => projects.find(candidate => candidate.id === projectId);
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
	const checkoutFailure = (code: string, error = code): CheckoutResult<never> => ({
		ok: false, code, error,
		status: code === "dirty" || code === "default_folder" ? 409 : code === "not_recorded" ? 502 : code === "not_supported" ? 501 : code === "unreachable" || code === "outcome_unknown" || code === "gateway_offline" ? 503 : code === "unknown_workspace" ? 404 : 400,
		...(code === "dirty" ? { dirty: true as const } : {}),
	});
	const checkoutCall = async (binding: EnvironmentBinding, request: WorktreeRequest): Promise<CheckoutResult<unknown>> => {
		try {
			const result = await new GatewayHostClient(binding).control.worktrees(request);
			return result.ok ? { ok: true, value: result.value } : checkoutFailure(result.code, result.message);
		} catch (error) {
			if (!(error instanceof HostTransportError)) return checkoutFailure("gateway_offline");
			if (error.code === "outcome_unknown" || (request.operation !== "list" && (error.code === "timeout" || error.code === "aborted"))) return checkoutFailure("outcome_unknown");
			if (error.code === "gateway_offline" || error.code === "timeout" || error.code === "aborted") return checkoutFailure("gateway_offline");
			return checkoutFailure("gateway_error", error.status === undefined ? undefined : "the execution host answered " + error.status);
		}
	};
	const checkoutProject = (workspaceId: string): ProjectRecord | undefined => {
		const resolved = resolve(workspaceId);
		return resolved?.kind === "project" ? resolved.project : undefined;
	};
	const folderForCheckout = async (projectId: string, root: string): Promise<ProjectFolder | undefined> => {
		const project = projectOf(projectId);
		if (project === undefined || store === undefined) return undefined;
		const existing = project.folders.find(folder => folder.root === root);
		if (existing !== undefined) { await registerFolder(project, existing); return existing; }
		const connection = gateways.get(project.hostId);
		if (connection === undefined) return undefined;
		const workspaceId = randomUUID();
		const registered = await hostCall(connection, { operation: "register", workspaceId, root, ...(project.profileId === undefined ? {} : { profileId: project.profileId }) });
		if (!registered.ok) return undefined;
		const before = projectOf(projectId);
		const added = store.addFolder(projectId, { id: randomUUID(), workspaceId, root: (registered.value as { root: string }).root }, new Date().toISOString());
		if (!added.ok) return undefined;
		replace(added.project, projectId);
		if (before?.folders.length !== added.project.folders.length) accept();
		return added.project.folders.find(folder => folder.root === (registered.value as { root: string }).root);
	};
	const registry: ProjectRegistry = {
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
		create: async (request, hostId) => {
			// The host a Web origin named is resolved before anything else, exactly as this route always did: an origin
			// that named no host, or one this deployment does not configure, cannot be turned into a guessed one.
			if (hostId === undefined) return { ok: false, code: "configuration_required", status: 409, error: WEB_HOST_REQUIRED };
			const connection = gateways.get(hostId);
			if (connection === undefined) return { ok: false, code: "configuration_required", status: 409, error: "the Web UI server named gateway " + hostId + ", which this deployment does not configure" };
			if (store === undefined) return notRecorded;
			// A remote Project names the one profile its folders are on, validated against what that gateway actually
			// serves: a Project can never be recorded against a profile the host does not have.
			if (request.profileId !== undefined) {
				const available = await hostCall(connection, { operation: "profiles" });
				if (!available.ok) return { ok: false, code: available.code, status: available.code === "gateway_offline" ? 503 : 502, error: "the host's execution targets could not be read: " + available.code };
				if (!(available.value as readonly { id: string }[]).some(profile => profile.id === request.profileId)) return { ok: false, code: "unknown_profile", status: 400, error: "gateway " + connection.gatewayId + " does not serve a profile named " + request.profileId };
			}
			const name = request.name.trim();
			if (name === "" || name.length > 120) return { ok: false, code: "invalid_request", status: 400, error: "a project name of 1 to 120 characters is required" };
			if (request.folders.length === 0) return { ok: false, code: "invalid_request", status: 400, error: "at least one folder on the Web host is required" };
			const requested = request.folders.map(folder => ({ root: folder.root.trim(), isDefault: folder.isDefault }));
			if (requested.some(folder => folder.root === "")) return { ok: false, code: "invalid_request", status: 400, error: "a folder on the Web host is required" };
			if (requested.filter(folder => folder.isDefault).length !== 1) return { ok: false, code: "invalid_request", status: 400, error: "exactly one folder must be the default" };
			if (new Set(requested.map(folder => folder.root)).size !== requested.length) return { ok: false, code: "invalid_request", status: 400, error: "the same folder cannot be added twice" };
			// Each folder's workspace id is opaque and unrelated to its path: a later default change picks another
			// workspace instead of moving one that existing conversations are already bound to. The ids are minted before
			// the roots are registered so a folder keeps its id across the whole request, and no Project is recorded until
			// every folder has been accepted by the host.
			const candidates = requested.map(folder => ({ id: randomUUID(), workspaceId: randomUUID(), root: folder.root, isDefault: folder.isDefault }));
			const folders: NewProjectFolder[] = [];
			for (const candidate of candidates) {
				const registered = await hostCall(connection, { operation: "register", workspaceId: candidate.workspaceId, root: candidate.root, ...(request.profileId === undefined ? {} : { profileId: request.profileId }) });
				if (!registered.ok) return { ok: false, code: registered.code, status: registered.status, error: "the folder was not accepted on the Web host: " + registered.code };
				folders.push({ id: candidate.id, workspaceId: candidate.workspaceId, root: (registered.value as { root: string }).root });
			}
			const created = store.create({
				id: randomUUID(),
				name,
				hostId: connection.gatewayId,
				...(request.profileId === undefined ? {} : { profileId: request.profileId }),
				defaultFolderId: candidates.find(candidate => candidate.isDefault)!.id,
				folders,
				createdAt: new Date().toISOString(),
			});
			projects = [...projects, created];
			accept();
			return { ok: true, value: created };
		},
		setDefault: (projectId, folderId, hostId) => {
			const project = projectOf(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project", status: 404, error: "no project with that id is recorded" };
			if (store === undefined) return notRecorded;
			const host = projectHost(project, hostId);
			if (!host.ok) return host;
			if (folderId === "") return { ok: false, code: "invalid_request", status: 400, error: "a folder of this project is required" };
			const changed = store.setDefault(projectId, folderId);
			if (!changed.ok) return changed.code === "unknown_project"
				? { ok: false, code: changed.code, status: 404, error: "no project with that id is recorded" }
				: { ok: false, code: changed.code, status: 400, error: "that folder does not belong to this project" };
			replace(changed.project, projectId);
			if (project.defaultFolderId !== changed.project.defaultFolderId) accept();
			return { ok: true, value: changed.project };
		},
		unlink: (projectId, folderId, replacementDefaultId, hostId) => {
			const project = projectOf(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project", status: 404, error: "no project with that id is recorded" };
			if (store === undefined) return notRecorded;
			const host = projectHost(project, hostId);
			if (!host.ok) return host;
			const unlinked = store.unlink(projectId, folderId, replacementDefaultId);
			if (!unlinked.ok) {
				if (unlinked.code === "unknown_project") return { ok: false, code: unlinked.code, status: 404, error: "no project with that id is recorded" };
				if (unlinked.code === "unknown_folder") return { ok: false, code: unlinked.code, status: 400, error: "that folder is not another folder of this project" };
				if (unlinked.code === "unexpected_replacement") return { ok: false, code: unlinked.code, status: 400, error: "only the default folder's removal names a replacement default" };
				return { ok: false, code: unlinked.code, status: 400, error: "removing this project's default folder requires another folder of this project as the replacement default" };
			}
			// The folder that left is gone from the live snapshot, the replacement it named is the default, the Project
			// itself is gone when its last folder was, the folder's binding is retained from here on and the revision moved
			// once — so a conversation that already holds the folder re-registers and resolves it like any retained record.
			replace(unlinked.project, projectId);
			retained = [...retained, unlinked.retained];
			accept();
			return { ok: true, value: { project: unlinked.project, removedFolderId: unlinked.removedFolderId } };
		},
		listCheckouts: async (workspaceId) => {
			const binding = await registry.ensureBinding(workspaceId === "" ? undefined : workspaceId);
			if (binding === undefined) return checkoutFailure("unknown_workspace", "this deployment serves no such workspace");
			const listed = await checkoutCall(binding, { operation: "list", workspaceId });
			if (!listed.ok) return listed;
			const listing = listed.value as WorktreeListing;
			const project = checkoutProject(workspaceId);
			return { ok: true, value: { ...listing, worktrees: listing.worktrees.map(entry => {
				const folder = project?.folders.find(candidate => candidate.root === entry.path);
				return { ...entry, ...(folder === undefined ? {} : { workspaceId: folder.workspaceId }) };
			}) } };
		},
		createCheckout: async (workspaceId, branch) => {
			const binding = await registry.ensureBinding(workspaceId === "" ? undefined : workspaceId);
			if (binding === undefined) return checkoutFailure("unknown_workspace", "this deployment serves no such workspace");
			const project = checkoutProject(workspaceId);
			if (project === undefined) return checkoutFailure("not_a_project_folder", "this folder is not a Project folder, so a worktree of it cannot be a conversation target");
			const created = await checkoutCall(binding, { operation: "create", workspaceId, branch });
			if (!created.ok) return created;
			const made = created.value as { path: string; branch: string };
			let folder: ProjectFolder | undefined;
			try { folder = await folderForCheckout(project.id, made.path); } catch { /* Host creation succeeded; metadata did not. */ }
			if (folder === undefined) return checkoutFailure("not_recorded", "the checkout was created on the host but this deployment could not record it as a target: " + made.path);
			return { ok: true, value: { path: made.path, branch: made.branch, workspaceId: folder.workspaceId } };
		},
		removeCheckout: async (workspaceId, path, force) => {
			const binding = await registry.ensureBinding(workspaceId === "" ? undefined : workspaceId);
			if (binding === undefined) return checkoutFailure("unknown_workspace", "this deployment serves no such workspace");
			if (path === "") return checkoutFailure("invalid_request", "a worktree path is required");
			const project = checkoutProject(workspaceId);
			const folder = project?.folders.find(candidate => candidate.root === path);
			if (project !== undefined && folder !== undefined && project.defaultFolderId === folder.id) return checkoutFailure("default_folder", "this checkout is this Project's default folder; name another folder the default first");
			const removed = await checkoutCall(binding, { operation: "remove", workspaceId, path, force });
			if (!removed.ok) return removed;
			if (project !== undefined && folder !== undefined) {
				try {
					const dropped = registry.unlink(project.id, folder.id, undefined, undefined);
					if (dropped.ok) return removed;
				} catch { /* Host removal succeeded; metadata did not. */ }
				return checkoutFailure("not_recorded", "the checkout was removed on the host but this deployment could not drop its folder record");
			}
			return removed;
		},
		remove: (projectId, hostId) => {
			const project = projectOf(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project", status: 404, error: "no project with that id is recorded" };
			if (store === undefined) return notRecorded;
			const host = projectHost(project, hostId);
			if (!host.ok) return host;
			const removed = store.remove(projectId);
			if (!removed.ok) return { ok: false, code: removed.code, status: 404, error: "no project with that id is recorded" };
			// This process keeps serving the removed folders from here on: the retained records are what the next
			// conversation request re-registers and what the workspace list answers their display root from.
			replace(null, projectId);
			retained = [...retained, ...removed.retained];
			accept();
			return { ok: true, value: removed.project };
		},
	};
	return registry;
}
