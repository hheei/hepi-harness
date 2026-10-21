/**
 * The builtin Skills workflow's data shapes and pure decisions. The panel fetches and renders; what an execution
 * workspace is, how its account is labelled, what the host holds, and what an install or update actually reported are
 * decided here. Nothing here reads a host path or a browser: the backend's inventory is the only source of installed
 * skills, because installed resources belong to the execution host (ADR 0002).
 */

/** One configured execution workspace as the backend reports it, with the account its tools actually run as. */
export type ExecutionWorkspace = {
  readonly id: string;
  readonly gatewayId: string;
  /** The account resolved on the host itself; absent when the host could not be reached. */
  readonly host?: { readonly user: string; readonly home: string };
  /** The workspace's real root on that host. */
  readonly workspaceRoot?: string;
  /** Why the host's account is unknown, when it could not be resolved. */
  readonly hostError?: string;
  /**
   * True when this workspace is one a Project removal retained. It is reported so a conversation bound to it keeps
   * resolving its root; it is never a target, so no picker offers it and nothing may be installed into it.
   */
  readonly retained?: boolean;
};

/**
 * The execution targets a surface may offer: every workspace except the ones a Project removal retained. A retained
 * binding resolves for the conversations that hold it and is not a folder any new work may be sent to.
 */
export function selectableWorkspaces(workspaces: readonly ExecutionWorkspace[]): ExecutionWorkspace[] {
  return workspaces.filter((workspace) => workspace.retained !== true);
}

/** Where a skill lives on its execution host: the account (global), the workspace (project), or an ancestor root. */
export type SkillPlacement = "global" | "project" | "path";

/**
 * The installation scope a host uses: the execution account (global), or the bound workspace. The UI names the latter
 * `project`; one name is used per layer so neither has to translate the other's vocabulary mid-call.
 */
export type InstallScopeName = "global" | "workspace";

/** The installation a scope recorded for one skill, with both state questions answered by the host. */
export type InstalledSkillRecord = {
  readonly scope: "global" | "workspace";
  /** The install-time baseline comparison: what the user did to the directory, not what the repository holds. */
  readonly state: "unchanged" | "locally-modified" | "unmanaged";
  readonly source: string;
  readonly sourceType: string;
  readonly ref?: string;
  readonly version?: string;
  /** The GitHub coordinate the content came from, when it did: an update check asks about it rather than guessing. */
  readonly repository?: string;
  readonly documentPath?: string;
  /** The installed directory's real host path. */
  readonly path: string;
  /** The installed directory name, which is also the bundle name an update replaces. */
  readonly directory: string;
  /** Relative path to sha256, as the host holds it now: the snapshot a confirmed replacement is pinned to. */
  readonly files: Readonly<Record<string, string>>;
};

/** One skill the selected execution workspace holds, installed by any means. */
export type InstalledSkill = {
  /** The skill document's declared name: a display name that need not match its directory. */
  readonly name: string;
  /** The skill's real directory on the host, which is what an installation and an update are keyed by. */
  readonly directory: string;
  readonly description: string;
  readonly filePath: string;
  readonly scope: SkillPlacement;
  readonly disableModelInvocation: boolean;
  readonly install?: InstalledSkillRecord;
  /** The source-revision question, answered separately from the baseline question. */
  readonly revision: "up-to-date" | "update-available" | "unknown";
  readonly availableVersion?: string;
};

export type SkillInventory = {
  readonly workspaceId: string;
  readonly host: { readonly user: string; readonly home: string };
  readonly skills: readonly InstalledSkill[];
};

/**
 * What one search source is showing. A source is not asked yet, loading, ready with results, ready with none, or
 * failed; "no results" is never folded into the failure text, because an empty catalog and an unreachable one mean
 * different things to the user, and neither is the same as a query that was never sent. Each source is decided on its
 * own, so one failing source still leaves the other usable.
 */
export type SourceState = "idle" | "loading" | "ready" | "empty" | "failed";

export function sourceState(input: { readonly loading: boolean; readonly error: string | null; readonly count: number }): SourceState {
  if (input.error !== null) return "failed";
  if (input.loading) return "loading";
  return input.count === 0 ? "empty" : "ready";
}

/** One catalog hit the backend could not offer, with the reason word it reported rather than prose to parse. */
export type SearchMiss = { readonly source: string; readonly reason: "unreadable" | "no-document" | "ambiguous" | "unbounded" | "not-github" };
const MISS_REASONS: readonly SearchMiss["reason"][] = ["unreadable", "no-document", "ambiguous", "unbounded", "not-github"];

/**
 * The misses one search answer reported. A body this module does not recognize yields nothing rather than a guess: an
 * unknown reason is dropped instead of being rendered as a sentence that might be untrue. Each miss is named by its
 * source and its reason, so an unreadable repository, an ambiguous directory and a repository too large to prove a
 * name in are told apart in the UI.
 */
export function searchMisses(value: unknown): SearchMiss[] {
  if (!Array.isArray(value)) return [];
  const misses: SearchMiss[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const { source, reason } = item as { source?: unknown; reason?: unknown };
    if (typeof source !== "string" || source === "") continue;
    if (typeof reason !== "string" || !MISS_REASONS.includes(reason as SearchMiss["reason"])) continue;
    misses.push({ source, reason: reason as SearchMiss["reason"] });
  }
  return misses;
}

/**
 * The catalog's own state. A query that returned hits is ready even when some rows were dropped, because the rows it
 * did return are usable; only a query that returned nothing **and** has a reason it could not offer anything is that
 * source's failure. An idle box is a query that was never sent, which is not an empty catalog.
 */
export function catalogState(input: { readonly queried: boolean; readonly loading: boolean; readonly error: string | null; readonly count: number; readonly misses: readonly SearchMiss[] }): SourceState {
  if (input.error !== null) return "failed";
  if (input.loading) return "loading";
  if (!input.queried) return "idle";
  if (input.count > 0) return "ready";
  return input.misses.length > 0 ? "failed" : "empty";
}

/** Adoption outcome of one installation, as the backend reports it: absent means no conversation was named. */
export type ReloadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** What an operation reported: what happened to the files, and what happened to the conversation separately. */
export type OperationOutcome = { readonly notice: string | null; readonly error: string | null };

/**
 * The workspace the UI's `cwd` names. A conversation's cwd is `/workspace/<id>`, which is how the panel finds the
 * execution target of the session it was opened from without inventing a second mapping.
 */
export function workspaceIdFromCwd(cwd: string | null | undefined): string | null {
  const match = cwd === null || cwd === undefined ? null : /^\/workspace\/([^/]+)$/.exec(cwd);
  return match === null ? null : match[1]!;
}

/**
 * One execution workspace as a label: the account the gateway itself reported, on the gateway that reported it, with
 * the workspace id when it has one, so two workspaces served by the same gateway are still told apart. Every part
 * comes from the gateway's own `executionHost` answer or the deployment's configuration; a host this process cannot
 * reach is named as unreachable rather than labelled with a name the Web process guessed.
 */
export function hostLabel(workspace: ExecutionWorkspace | undefined): string {
  if (workspace === undefined) return "";
  const where = workspace.id !== "" && workspace.id !== workspace.gatewayId ? workspace.gatewayId + "/" + workspace.id : workspace.gatewayId;
  return workspace.host === undefined ? where : workspace.host.user + "@" + where;
}

/**
 * The conversation an operation may name for adoption, given the execution target it is about to install to.
 *
 * A conversation can only adopt what its own execution host received, so it is named only when the target is exactly
 * the workspace that conversation is bound to. Any other target — another workspace, or a conversation bound to none —
 * is an independent installation: it names no conversation at all, rather than asking one to adopt content that landed
 * on a host it does not run on.
 */
export function conversationTarget(sessionId: string | null | undefined, sessionWorkspaceId: string | null, workspaceId: string | null): string | null {
  if (typeof sessionId !== "string" || sessionId === "" || workspaceId === null) return null;
  return sessionWorkspaceId !== null && sessionWorkspaceId === workspaceId ? sessionId : null;
}

/** The workspace a fresh panel should show: the session's own when it is configured, otherwise the first one. */
export function initialWorkspaceId(workspaces: readonly ExecutionWorkspace[], cwd: string | null | undefined): string | null {
  const requested = workspaceIdFromCwd(cwd);
  if (requested !== null && workspaces.some((workspace) => workspace.id === requested)) return requested;
  return workspaces[0]?.id ?? null;
}

/**
 * Whether a library bundle is already installed at the chosen scope, so the action says Update rather than Install.
 * The comparison is the directory name, because that is what an installation becomes on the host.
 */
export function installedAt(skills: readonly InstalledSkill[], directory: string, scope: InstallScopeName): InstalledSkill | undefined {
  return skills.find((skill) => skill.install?.scope === scope && skill.install.directory === directory);
}

/** The bundle id an update would install: the repository's newest version of this installation's bundle. */
export function availableBundleId(skill: InstalledSkill): string | undefined {
  if (skill.install?.sourceType !== "repository" || skill.availableVersion === undefined) return undefined;
  return "repository:" + skill.install.directory + "@" + skill.availableVersion;
}

/**
 * Whether the panel offers an update check for this installation. Only an installation with recorded GitHub provenance
 * has a repository to ask about, and only the user's own press may ask it, so the action is offered exactly there. A
 * repository bundle is compared against its version list instead, which is what its Update action already does.
 */
export function canCheckForUpdate(skill: InstalledSkill): boolean {
  return skill.install?.sourceType === "github" && skill.install.repository !== undefined && skill.install.documentPath !== undefined && skill.install.ref !== undefined;
}

/** What one update check reported. `unknown` is a real answer: nothing was compared, so nothing is claimed. */
export type UpdateCheck = {
  readonly state: "up-to-date" | "update-available" | "unknown";
  readonly currentRevision?: string;
  readonly availableRevision?: string;
  /** The pinned selection an update would install, present only when a newer revision was found. */
  readonly id?: string;
};

/** One update check's answer as a conclusion, or the reason the question could not be asked at all. */
export function checkOutcome(input: { readonly check: UpdateCheck | undefined; readonly error: string | null; readonly skill: InstalledSkill }): OperationOutcome {
  if (input.error !== null) return { notice: null, error: input.error };
  const placement = input.skill.install?.scope === "workspace" ? "project" : "global";
  const check = input.check;
  if (check === undefined || check.state === "unknown") {
    return { notice: "No newer revision is known for " + input.skill.directory + " (" + placement + ").", error: null };
  }
  if (check.state === "up-to-date") return { notice: input.skill.directory + " is up to date at " + (check.currentRevision ?? "").slice(0, 12) + ".", error: null };
  return { notice: check.availableRevision === undefined
    ? "A newer revision is available for " + input.skill.directory + "."
    : "A newer revision of " + input.skill.directory + " is available: " + check.availableRevision.slice(0, 12) + ".", error: null };
}

/** What one toggle reported: the directories that changed, and the ones the host refused, named on their own. */
export type ToggleOutcome = { readonly changed: readonly string[]; readonly failed: readonly { readonly directory: string; readonly error: string }[] };

/** Read a toggle answer into what happened per directory, without inventing an outcome for a directory it omits. */
export function toggleOutcome(value: unknown): ToggleOutcome {
  const changed: string[] = [];
  const failed: { directory: string; error: string }[] = [];
  const results = value !== null && typeof value === "object" && Array.isArray((value as { results?: unknown }).results) ? (value as { results: unknown[] }).results : [];
  for (const item of results) {
    if (item === null || typeof item !== "object") continue;
    const { directory, changed: didChange, error } = item as { directory?: unknown; changed?: unknown; error?: unknown };
    if (typeof directory !== "string" || directory === "") continue;
    if (error !== null && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") failed.push({ directory, error: (error as { message: string }).message });
    else if (didChange === true) changed.push(directory);
  }
  return { changed, failed };
}

/**
 * Whether replacing this installation discards content the user did not publish. An unchanged installation discards
 * nothing; a locally modified or unmanaged one holds content the replacement would destroy, so the choice is theirs.
 */
export function needsUpdateConfirmation(state: InstalledSkillRecord["state"]): boolean {
  return state !== "unchanged";
}

/** The version a detail row shows for an installation: the recorded version, else the pinned revision. */
export function installedVersion(skill: InstalledSkill): string | undefined {
  return skill.install?.version ?? skill.install?.ref;
}

/**
 * What an installation reported. Publication and adoption stay separate facts, and an installation with no
 * conversation says exactly that instead of claiming a Reload: there was nothing to reload, so no outcome is invented.
 */
export function installOutcome(input: { name: string; scope: InstallScopeName; adopted: boolean; reload?: ReloadOutcome }): OperationOutcome {
  const placement = input.scope === "global" ? "global" : "project";
  const installed = "Installed " + input.name + " (" + placement + ")";
  if (input.reload === undefined) return { notice: installed + (input.adopted ? "" : "; no conversation was asked to reload"), error: null };
  if (input.reload.ok) return { notice: installed + " and reloaded this conversation", error: null };
  return { notice: installed, error: "Reload failed: " + input.reload.error };
}

/** What a replacement reported, including the directory it retained and the separate Reload outcome. */
export function updateOutcome(input: { name: string; scope: InstallScopeName; adopted: boolean; backup?: string; reload?: ReloadOutcome }): OperationOutcome {
  const placement = input.scope === "global" ? "global" : "project";
  const kept = input.backup === undefined ? "" : "; the previous directory was kept at " + input.backup;
  const updated = "Updated " + input.name + " (" + placement + ")" + kept;
  if (input.reload === undefined) return { notice: updated + (input.adopted ? "" : "; no conversation was asked to reload"), error: null };
  if (input.reload.ok) return { notice: updated + " and reloaded this conversation", error: null };
  return { notice: updated, error: "Reload failed: " + input.reload.error };
}
