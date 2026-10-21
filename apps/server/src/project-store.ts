import { DatabaseSync } from "node:sqlite";

/**
 * The Project registry: one project's display identity, the execution host its folders are on, and the folder its new
 * conversations bind. A project may hold several existing folders of one computer, exactly one of which is the
 * default; the others are metadata and never a tool root. It never creates or renames a directory (a folder is chosen
 * and validated before it is recorded), and it holds no gateway token: a project names its host by the configured
 * gateway id, and the connection stays in the deployment's environment.
 *
 * A project on an SSH host records the one configured profile all of its folders are on (`profile_id`, nullable: a
 * local project has none). That is what lets a folder's opaque workspace id resolve back to the right account and
 * transport after a restart, instead of being guessed from the id's spelling.
 *
 * Metadata lives in its own SQLite database next to the conversation database, the same way repository metadata does
 * (ADR 0002): a project is neither conversation history nor an execution role, so the durable session database keeps
 * its own ownership. Each folder's workspace id is opaque and independent of the path, so a later default change picks
 * a different workspace instead of moving one that existing conversations are bound to.
 *
 * `projects.default_folder_id` references `project_folders` while `project_folders.project_id` references
 * `projects`: the two tables form one reference cycle, so the default reference is DEFERRABLE INITIALLY DEFERRED and
 * the pair is written in one transaction (:create). That keeps foreign keys enforced by the schema rather than by a
 * convention, and it is why the default folder is a column: one row can hold one default.
 */

export type ProjectFolder = {
	readonly id: string;
	/** The single-root workspace this folder's conversations bind. Opaque, stable, never derived from the path. */
	readonly workspaceId: string;
	/** The canonical directory chosen on the project's host. */
	readonly root: string;
	readonly createdAt: string;
};

export type ProjectRecord = {
	readonly id: string;
	readonly name: string;
	/** The configured gateway id that serves every folder of this project. */
	readonly hostId: string;
	/**
	 * The SSH profile every folder of this project lives on, when the host is an SSH gateway. A project is still one
	 * computer: one gateway id plus, for a remote host, the one configured profile all of its folders are on.
	 */
	readonly profileId?: string;
	/** The folder new conversations bind. Always one of `folders`. */
	readonly defaultFolderId: string;
	readonly folders: readonly ProjectFolder[];
	readonly createdAt: string;
};

/**
 * What a folder's workspace address keeps after its Project is removed (spec decisions 19-23). It carries the four
 * values a binding needs - the workspace id and root from the folder row, the host id and profile id from the project
 * row - because removing the project row removes those two with it, and a folder row alone cannot name its host. It is
 * written in the same transaction as the removal, is never pruned and is never offered back: a workspace id is minted
 * per folder and the host refuses a different root for an id it already holds, so a retained id cannot be re-pointed.
 */
export type RetainedBinding = {
	readonly workspaceId: string;
	readonly hostId: string;
	readonly profileId?: string;
	readonly root: string;
	readonly retainedAt: string;
};

/** A folder as the caller describes it, before the store assigns the project's own bookkeeping. */
export type NewProjectFolder = { readonly id: string; readonly workspaceId: string; readonly root: string };

export type NewProject = {
	readonly id: string;
	readonly name: string;
	readonly hostId: string;
	/** The configured SSH profile of that host, or absent for a local one. */
	readonly profileId?: string;
	readonly defaultFolderId: string;
	readonly folders: readonly NewProjectFolder[];
	readonly createdAt: string;
};

/** The outcome of recording one more folder of a project: the project as it stands, or no such project. */
export type FolderAddition =
	| { readonly ok: true; readonly project: ProjectRecord }
	| { readonly ok: false; readonly code: "unknown_project" };

/** The outcome of naming another folder the default. Membership, not mere existence, is what is checked. */
export type DefaultFolderChange =
	| { readonly ok: true; readonly project: ProjectRecord }
	| { readonly ok: false; readonly code: "unknown_project" | "unknown_folder" };

/** The outcome of removing a project: what went, and the retained binding of every folder it held. */
export type ProjectRemoval =
	| { readonly ok: true; readonly project: ProjectRecord; readonly retained: readonly RetainedBinding[] }
	| { readonly ok: false; readonly code: "unknown_project" };

/**
 * The outcome of unlinking one folder: the project as it stands afterwards, or `null` when the folder was the last
 * one and the project went with it, plus the retained binding written for the folder that left. The refusals are the
 * ways an unlink can be asked for something a project cannot become: a project or folder that is not there, a default
 * folder removed without its replacement named, a replacement named for a folder that is not the default, and a
 * replacement that is not another folder of the same project.
 */
export type FolderUnlink =
	| { readonly ok: true; readonly removedFolderId: string; readonly project: ProjectRecord | null; readonly retained: RetainedBinding }
	| { readonly ok: false; readonly code: "unknown_project" | "unknown_folder" | "default_replacement_required" | "unexpected_replacement" };

export type ProjectStore = {
	list(): readonly ProjectRecord[];
	/** Record one project and its folders in one transaction. The caller has already validated every root on its host. */
	create(project: NewProject): ProjectRecord;
	/**
	 * Record one more existing folder of a project — a git checkout hepi created for it — without touching any other
	 * folder and without changing the default. A root the project already records is answered as it is, so a checkout
	 * seen twice is one folder with one workspace id.
	 */
	addFolder(projectId: string, folder: NewProjectFolder, createdAt: string): FolderAddition;
	/**
	 * Name one of a project's own folders the default. New conversations bind it from then on; an existing
	 * conversation keeps the folder it was bound to, which is why this moves no workspace.
	 */
	setDefault(projectId: string, folderId: string): DefaultFolderChange;
	/**
	 * Remove one project's metadata: the project record and its folder links go, and the retained binding of every one
	 * of its folders is written, in **one** transaction. No directory is touched, no conversation is deleted, no
	 * workspace id is reused and no host registration is undone. Nothing is refused because conversations are bound:
	 * this never reads a conversation, so there is no bound-conversation count to compute.
	 */
	remove(projectId: string): ProjectRemoval;
	/**
	 * Unlink one of a project's own folders, keeping its default valid. A non-default folder goes on its own and the
	 * default is unchanged. The default folder may only go when `replacementDefaultId` names another folder of the
	 * same project in this call, and the last folder's removal removes the project record in the same transaction, so
	 * no request ever reads a project without folders. Like a project removal this is metadata only — no directory is
	 * touched, no conversation is deleted, no workspace id is reused — and it writes the same retained binding for the
	 * folder that left, in the same transaction, so a conversation already bound to it keeps its execution environment
	 * while the folder is never a target for a new conversation again.
	 */
	unlink(projectId: string, folderId: string, replacementDefaultId?: string): FolderUnlink;
	/** Every retained binding, oldest first: the roots a removal kept resolvable for the conversations that hold them. */
	retained(): readonly RetainedBinding[];
	close(): void;
};

export type ProjectStoreOptions = { readonly path: string };

/** A project row, and the foreign key its default folder is behind: the pair is what an open database is checked for. */
const PROJECTS_TABLE = "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, host_id TEXT NOT NULL, profile_id TEXT, default_folder_id TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (default_folder_id) REFERENCES project_folders(id) DEFERRABLE INITIALLY DEFERRED)";
const FOLDERS_TABLE = "CREATE TABLE IF NOT EXISTS project_folders (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL UNIQUE, root TEXT NOT NULL, created_at TEXT NOT NULL)";
/**
 * The bindings a removal retains, additive to the schema beside the two tables above. It references neither of them on
 * purpose: the whole point is that it outlives the project and folder rows, so a conversation bound to a removed
 * folder still resolves its host, its root and its execution environment.
 */
const RETAINED_TABLE = "CREATE TABLE IF NOT EXISTS retained_bindings (workspace_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, profile_id TEXT, root TEXT NOT NULL, retained_at TEXT NOT NULL)";

type ProjectRow = { id: string; name: string; host_id: string; profile_id: string | null; default_folder_id: string; created_at: string; folder_id: string; workspace_id: string; root: string; folder_created_at: string };
type RetainedRow = { workspace_id: string; host_id: string; profile_id: string | null; root: string; retained_at: string };
type ColumnRow = { name: string };
type TableRow = { name: string };

function recordsOf(db: DatabaseSync): ProjectRecord[] {
	const rows = db.prepare(
		"SELECT p.id, p.name, p.host_id, p.profile_id, p.default_folder_id, p.created_at, f.id AS folder_id, f.workspace_id, f.root, f.created_at AS folder_created_at FROM projects p JOIN project_folders f ON f.project_id = p.id ORDER BY p.created_at, p.id, f.created_at, f.id",
	).all() as unknown as ProjectRow[];
	const byId = new Map<string, { base: ProjectRow; folders: ProjectFolder[] }>();
	for (const row of rows) {
		const entry = byId.get(row.id);
		const folder: ProjectFolder = { id: row.folder_id, workspaceId: row.workspace_id, root: row.root, createdAt: row.folder_created_at };
		if (entry === undefined) byId.set(row.id, { base: row, folders: [folder] });
		else entry.folders.push(folder);
	}
	return [...byId.values()].map(({ base, folders }) => ({ id: base.id, name: base.name, hostId: base.host_id, ...(base.profile_id === null ? {} : { profileId: base.profile_id }), defaultFolderId: base.default_folder_id, folders, createdAt: base.created_at }));
}

/**
 * Bring an opened file to the current shape. A file from the single-folder version holds one `workspace_id` and one
 * `root` column per project, and neither can simply be dropped: SQLite refuses to drop a UNIQUE column, so the whole
 * `projects` table is rebuilt. The rebuild keeps every id, workspace id and root exactly as they were, gives each
 * project one folder — its own old root, named the default — and commits as one transaction, so a failure leaves the
 * previous file untouched rather than a half-migrated one. Foreign keys are checked inside that transaction and the
 * pragma is restored before it returns, whether it succeeded or not.
 */
function migrate(db: DatabaseSync): void {
	const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as TableRow[]).map(row => row.name);
	if (!tables.includes("projects")) { db.exec(PROJECTS_TABLE); db.exec(FOLDERS_TABLE); db.exec(RETAINED_TABLE); return; }
	// The retained table is additive and independent of the project tables' shape, so a file of either released version
	// gets it here, before any branch below can return.
	db.exec(RETAINED_TABLE);
	const columns = (db.prepare("SELECT name FROM pragma_table_info('projects')").all() as unknown as ColumnRow[]).map(column => column.name);
	// The profile column is additive and nullable: a file from the multi-folder version gets it in place, and every
	// project already in it is local, so none of them needs the rebuild below.
	if (!columns.includes("workspace_id") && !columns.includes("root")) {
		if (!columns.includes("profile_id")) db.exec("ALTER TABLE projects ADD COLUMN profile_id TEXT");
		return;
	}
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec("BEGIN IMMEDIATE");
		db.exec("ALTER TABLE projects RENAME TO projects_single_folder");
		// The replacement tables, then the rows: the project's default points at a folder row inserted right after it,
		// which the deferred reference admits and the commit then checks.
		// The replacement carries `profile_id`, left null: a single-folder file predates SSH projects, so every
		// project in it is local.
		db.exec(PROJECTS_TABLE);
		db.exec(FOLDERS_TABLE);
		db.exec("INSERT INTO project_folders (id, project_id, workspace_id, root, created_at) SELECT id || '-folder', id, workspace_id, root, created_at FROM projects_single_folder");
		db.exec("INSERT INTO projects (id, name, host_id, profile_id, default_folder_id, created_at) SELECT id, name, host_id, NULL, id || '-folder', created_at FROM projects_single_folder");
		db.exec("DROP TABLE projects_single_folder");
		const inconsistent = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
		if (inconsistent.length > 0) throw new Error("the project database could not be migrated: " + inconsistent.length + " inconsistent reference(s)");
		db.exec("COMMIT");
	} catch (error) {
		try { db.exec("ROLLBACK"); } catch { /* the transaction is already over: the original file stands */ }
		throw error;
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

export function createProjectStore(options: ProjectStoreOptions): ProjectStore {
	const db = new DatabaseSync(options.path);
	db.exec("PRAGMA journal_mode = WAL");
	migrate(db);
	const read = (id: string): ProjectRecord | undefined => recordsOf(db).find(project => project.id === id);
	const readRetained = (): RetainedBinding[] => (db.prepare("SELECT workspace_id, host_id, profile_id, root, retained_at FROM retained_bindings ORDER BY retained_at, workspace_id").all() as unknown as RetainedRow[]).map(row => ({ workspaceId: row.workspace_id, hostId: row.host_id, ...(row.profile_id === null ? {} : { profileId: row.profile_id }), root: row.root, retainedAt: row.retained_at }));
	const ownsFolder = db.prepare("SELECT 1 AS owned FROM project_folders WHERE id = ? AND project_id = ?");
	return {
		list: () => recordsOf(db),
		create: (project) => {
			if (!project.folders.some(folder => folder.id === project.defaultFolderId)) throw new Error("a project's default must be one of its own folders");
			db.exec("BEGIN IMMEDIATE");
			try {
				db.prepare("INSERT INTO projects (id, name, host_id, profile_id, default_folder_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(project.id, project.name, project.hostId, project.profileId ?? null, project.defaultFolderId, project.createdAt);
				const insert = db.prepare("INSERT INTO project_folders (id, project_id, workspace_id, root, created_at) VALUES (?, ?, ?, ?, ?)");
				for (const folder of project.folders) insert.run(folder.id, project.id, folder.workspaceId, folder.root, project.createdAt);
				db.exec("COMMIT");
			} catch (error) {
				try { db.exec("ROLLBACK"); } catch { /* nothing was written */ }
				throw error;
			}
			const created = read(project.id);
			if (created === undefined) throw new Error("the project was recorded but cannot be read back");
			return created;
		},
		addFolder: (projectId, folder, createdAt) => {
			const project = read(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project" };
			// The root decides: a checkout the project already records is that folder, whatever id the caller minted,
			// so a second create of one worktree cannot record two workspaces for one directory.
			if (!project.folders.some(existing => existing.root === folder.root)) {
				db.prepare("INSERT INTO project_folders (id, project_id, workspace_id, root, created_at) VALUES (?, ?, ?, ?, ?)").run(folder.id, projectId, folder.workspaceId, folder.root, createdAt);
			}
			const after = read(projectId);
			if (after === undefined) throw new Error("the folder was recorded but the project cannot be read back");
			return { ok: true, project: after };
		},
		setDefault: (projectId, folderId) => {
			if (read(projectId) === undefined) return { ok: false, code: "unknown_project" };
			if (ownsFolder.get(folderId, projectId) === undefined) return { ok: false, code: "unknown_folder" };
			db.prepare("UPDATE projects SET default_folder_id = ? WHERE id = ?").run(folderId, projectId);
			const project = read(projectId);
			return project === undefined ? { ok: false, code: "unknown_project" } : { ok: true, project };
		},
		remove: (projectId) => {
			const project = read(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project" };
			const retainedAt = new Date().toISOString();
			// The retained rows are inserted before the delete so both are one transaction: either the project's metadata
			// and every one of its folder links go with the bindings kept, or nothing changed at all. A workspace id that
			// is already retained is refused by the primary key rather than silently re-pointed at another root.
			db.exec("BEGIN IMMEDIATE");
			try {
				const keep = db.prepare("INSERT INTO retained_bindings (workspace_id, host_id, profile_id, root, retained_at) VALUES (?, ?, ?, ?, ?)");
				for (const folder of project.folders) keep.run(folder.workspaceId, project.hostId, project.profileId ?? null, folder.root, retainedAt);
				// The project's folders follow through the cascade; the deferred default-folder reference is checked at
				// COMMIT, by which point the row that held it is gone.
				db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
				db.exec("COMMIT");
			} catch (error) {
				try { db.exec("ROLLBACK"); } catch { /* the project and its folders are untouched */ }
				throw error;
			}
			return { ok: true, project, retained: project.folders.map(folder => ({ workspaceId: folder.workspaceId, hostId: project.hostId, ...(project.profileId === undefined ? {} : { profileId: project.profileId }), root: folder.root, retainedAt })) };
		},
		unlink: (projectId, folderId, replacementDefaultId) => {
			const project = read(projectId);
			if (project === undefined) return { ok: false, code: "unknown_project" };
			const folder = project.folders.find(candidate => candidate.id === folderId);
			if (folder === undefined) return { ok: false, code: "unknown_folder" };
			const remaining = project.folders.filter(candidate => candidate.id !== folderId);
			const isDefault = project.defaultFolderId === folderId;
			// A replacement is only meaningful for the default folder, and only a folder that stays can be it: the folder being
			// unlinked is no longer one of the project's own by the time this call returns.
			if (replacementDefaultId !== undefined) {
				if (!isDefault) return { ok: false, code: "unexpected_replacement" };
				if (!remaining.some(candidate => candidate.id === replacementDefaultId)) return { ok: false, code: "unknown_folder" };
			} else if (isDefault && remaining.length > 0) return { ok: false, code: "default_replacement_required" };
			const retainedAt = new Date().toISOString();
			// The retained row, the default change and the folder's own removal are one transaction: the folder never leaves the
			// project without its binding kept, and no commit ever holds a project without a default.
			db.exec("BEGIN IMMEDIATE");
			try {
				db.prepare("INSERT INTO retained_bindings (workspace_id, host_id, profile_id, root, retained_at) VALUES (?, ?, ?, ?, ?)").run(folder.workspaceId, project.hostId, project.profileId ?? null, folder.root, retainedAt);
				if (isDefault && remaining.length > 0) db.prepare("UPDATE projects SET default_folder_id = ? WHERE id = ?").run(replacementDefaultId!, projectId);
				// The last folder takes the project with it through the same cascade a project removal uses; otherwise only the
				// folder row goes, and the default reference it may have held now points at its replacement.
				if (remaining.length === 0) db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
				else db.prepare("DELETE FROM project_folders WHERE id = ?").run(folderId);
				db.exec("COMMIT");
			} catch (error) {
				try { db.exec("ROLLBACK"); } catch { /* the project and its folders are untouched */ }
				throw error;
			}
			const retained: RetainedBinding = { workspaceId: folder.workspaceId, hostId: project.hostId, ...(project.profileId === undefined ? {} : { profileId: project.profileId }), root: folder.root, retainedAt };
			if (remaining.length === 0) return { ok: true, removedFolderId: folderId, project: null, retained };
			const after = read(projectId);
			if (after === undefined) throw new Error("the folder was unlinked but the project cannot be read back");
			return { ok: true, removedFolderId: folderId, project: after, retained };
		},
		retained: readRetained,
		close: () => db.close(),
	};
}
