import type { ProjectFolder, ProjectRecord, RetainedBinding } from "./project-store.ts";

/**
 * The binding facts a catalogue row states about one conversation's workspace.
 *
 * The Backend owns these because it owns the metadata they come from: which configured gateway serves a workspace,
 * which Project folder a workspace is, which of that project's folders is its default, and whether a removal retained
 * the binding. A client that had to assemble them would read the catalogue, the project registry and the workspace
 * listing and then reconcile three answers — and a Project created or removed between two of those reads would be
 * reconciled against a stale one. Stating them on the row makes the assembly a projection of what this process already
 * holds, so a list costs no host round trip and no per-conversation read.
 *
 * The workspace id itself is the row's own field, not repeated here: one owner per fact.
 *
 * What is deliberately **not** here is the root the execution host reported for a configured workspace: this process
 * holds a configured workspace as an id and a host, never as a path, and asking each host per row is exactly the cost
 * this projection exists to avoid. A folder's recorded root is here, because the Project registry recorded it.
 */
export type CatalogueWorkspace = {
	/** The configured gateway that serves this workspace's host; absent when no configured connection serves it. */
	readonly gatewayId?: string;
	/** The root this deployment recorded for the folder — a Project folder's or a retained binding's, never a guess. */
	readonly root?: string;
	/** Present exactly when a Project removal or a folder unlink retained this binding: it is never a target again. */
	readonly retained?: true;
	/**
	 * The Project this folder belongs to, as the sidebar groups it: its identity, its name, the folder new
	 * conversations of the group bind, and the root that group is shown as (the default folder's own root).
	 */
	readonly project?: {
		readonly id: string;
		readonly name: string;
		readonly defaultWorkspaceId: string;
		readonly displayRoot: string;
	};
};

/**
 * How one workspace id resolves, in the one precedence order this deployment has: a configured workspace first, then a
 * binding a removal retained, then a folder of a recorded Project. A retained id resolves exactly like the folder it
 * came from did, which is what lets a conversation bound before the removal keep running; a folder of a project is
 * last because a configured workspace with the same id is the operator's own statement about that id.
 */
export type CatalogueBinding =
	| { readonly kind: "configured"; readonly workspaceId: string; readonly gatewayId: string }
	| { readonly kind: "retained"; readonly record: RetainedBinding; readonly gatewayId: string }
	| { readonly kind: "project"; readonly project: ProjectRecord; readonly folder: ProjectFolder; readonly gatewayId: string };

/** The catalogue row's workspace fact, from the binding that resolved. Nothing is derived that the binding did not state. */
export function catalogueWorkspace(binding: CatalogueBinding): CatalogueWorkspace {
	if (binding.kind === "configured") return { gatewayId: binding.gatewayId };
	if (binding.kind === "retained") return { gatewayId: binding.gatewayId, root: binding.record.root, retained: true };
	return projectWorkspace(binding.project, binding.folder, binding.gatewayId);
}

/**
 * A folder of a recorded Project: its own id and root, its project's host, and the group it belongs to. The group's
 * display root is its **default** folder's root, so a conversation bound to a non-default folder still shows the
 * project as the project, while its own `root` is the folder it really runs in.
 */
function projectWorkspace(project: ProjectRecord, folder: ProjectFolder, gatewayId: string): CatalogueWorkspace {
	const defaultFolder = project.folders.find(candidate => candidate.id === project.defaultFolderId) ?? folder;
	return {
		gatewayId,
		root: folder.root,
		project: { id: project.id, name: project.name, defaultWorkspaceId: defaultFolder.workspaceId, displayRoot: defaultFolder.root },
	};
}

/**
 * The version of one catalogue listing: a number that moves whenever the list does, so a client comparing it can tell
 * "nothing changed" from "re-read the list".
 *
 * A conversation's own committed revision is part of it, and so is the count: a new conversation's revision starts at
 * zero, so without the count a fork would be invisible to another window's poll — exactly the window with no other way
 * to hear of it. It is a sum rather than a joined string because a client compares versions with `!==`, and a string can
 * never equal the number it stored.
 */
export function catalogueListVersion(entries: readonly { readonly revision?: number }[]): number {
	return entries.length + entries.reduce((total, entry) => total + (entry.revision ?? 0), 0);
}
