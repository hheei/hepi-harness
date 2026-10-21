import { createHash } from "node:crypto";
import { rsort, valid } from "semver";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayHostClient, gatewayEnvironment, installFailure, sameDigests, safeInstallPath, type DirectoryInspection, type ExecutionHostEnv, type ExpectedDigests, type GatewayControl, type EnvironmentBinding, type InstallLockDocument, type InstallLockEntry, type InstallResult, type InstallScope, type PublishedDirectory, type PublishFile, type ToggledSkill } from "@hepi/gateway";
import { reloadResources, type ConversationTx, type WorkspaceResources } from "./workspace-resources.ts";
import type { Bundle, MarketFile, MarketPreview, SkillMarket } from "./skill-repository.ts";

/**
 * Explicit installation of one Skill Bundle onto the execution host of the conversation that asked for it (ADR 0002,
 * ticket 06). The repository supplies content; the gateway's installation capability publishes it. This module owns
 * only the orchestration between them: what the bundle's files are, what the install-time baseline is, what provenance
 * is recorded, and how installation and adoption are reported as two separate outcomes.
 *
 * Nothing here executes bundle content, and nothing reads or writes a host path directly: every host operation goes
 * through `/v1/installs`, which derives its own destination from the installation scope. An installation that cannot be
 * confirmed is reported as an unknown outcome and is never sent again.
 */

export type { InstallScope } from "@hepi/gateway";

/**
 * The installation surface of one binding, as this module asks it: the client's own control namespace, bound to the
 * workspace the installation belongs to, because `/v1/installs` derives its destination from the binding rather than
 * from the request. The route, the bearer header, the bound and the meaning of a lost answer stay in the gateway
 * package, so nothing here builds a host request.
 */
function installsOf(binding: EnvironmentBinding): Pick<GatewayControl, "installs"> {
  return new GatewayHostClient({ gatewayOrigin: binding.gatewayOrigin, gatewayToken: binding.gatewayToken, workspaceId: binding.id }).control;
}

/** The provenance and baseline this module writes for one installation, plus where it landed. */
export type InstalledSkill = {
  readonly name: string;
  readonly version?: string;
  readonly scope: InstallScope;
  readonly path: string;
  readonly files: readonly string[];
  readonly contentHash: string;
  /** Where the directory this installation replaced was retained, when it replaced one. */
  readonly backup?: string;
};

/**
 * Adoption is reported only when a conversation was named. Without one there is nothing to reload, and an absent
 * outcome says exactly that: it is never a fabricated success or a fabricated failure.
 */
export type InstallReload = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The execution target of an installation: an explicitly named workspace, or the initiating conversation's own. */
export type InstallTarget = { readonly workspaceId?: unknown; readonly conversationId?: unknown };

/** A published directory whose lock could not be written: the files are installed, their provenance is unknown. */
export type InstallWarning = { readonly code: string; readonly message: string };

export type InstallResponse =
  | { readonly status: 200; readonly body: { readonly installed: InstalledSkill; readonly reload?: InstallReload; readonly warning?: InstallWarning } }
  | { readonly status: 400 | 404 | 409 | 502; readonly body: { readonly error: { readonly code: string; readonly message: string }; readonly state?: UpdateState } };

/** What one installed skill's update would do, and what the host actually holds for it. */
export type UpdateResponse =
  | { readonly status: 200; readonly body: { readonly skill: { readonly name: string; readonly scope: InstallScope; readonly state: UpdateState; readonly path: string; readonly files: Readonly<Record<string, string>>; readonly version?: string } } }
  | { readonly status: 400 | 404 | 409; readonly body: { readonly error: { readonly code: string; readonly message: string } } };

export type InstallRequest = {
  readonly id: unknown;
  /** The explicitly chosen execution workspace. Absent means the initiating conversation's own binding. */
  readonly workspaceId?: unknown;
  /** The conversation asked to adopt the result. Optional: browsing and installation need no active conversation. */
  readonly conversationId?: unknown;
  readonly scope: unknown;
  readonly name?: unknown;
  readonly confirm?: unknown;
  /** The digest set the caller inspected, so a replacement is pinned to what it actually saw rather than to a fresh read. */
  readonly expect?: unknown;
};

/** What the installer needs from the rest of the backend, so it holds no route or conversation state of its own. */
export type InstallerOptions = {
  readonly market: SkillMarket;
  /**
   * Every execution workspace this backend can install into, read at the moment of the request. It is a lookup rather
   * than a list captured when the installer was built, because the set grows while the process runs: creating a
   * project registers a folder on its host through the public endpoint, and that folder is a valid installation target
   * from that moment on. A snapshot taken at boot would answer "unknown workspace" for a target the host itself is
   * already serving — after a restart it would be empty, since projects are recorded and replayed, not recreated.
   */
  readonly workspaces: () => readonly EnvironmentBinding[];
  /** The initiating conversation's bound workspace, or nothing when it is unknown to this process. */
  readonly boundWorkspace: (conversationId: string) => Promise<string | undefined>;
  readonly resources?: WorkspaceResources;
  readonly conversation: (conversationId: string) => ConversationTx | undefined;
  /**
   * Re-assert a workspace's root on its host before the request reaches it. A gateway keeps its workspaces in memory,
   * so one that restarted while this backend stayed up no longer serves a project's folder; this is the idempotent
   * registration that puts it back. It is best effort by contract — a host that is unreachable is reported by the
   * operation itself, not by this call — and it never repeats a publish or any other mutating request.
   */
  readonly ensure?: (workspaceId: string) => Promise<void>;
};

/** The one directory name an installation may use; a name that is not a slug cannot become a destination. */
const DIRECTORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * How many independent host round trips one request may have in flight at once. A bulk switch is one request per
 * directory and a listing inspects each installed directory, so a serial loop makes the panel wait once per skill on a
 * request that has no ordering need. The gateway already serializes per directory for its own safety, so distinct
 * directories are independent and only a bound is needed to keep one request from opening an unbounded number of
 * sockets at a single host. The bound is fixed rather than per-host tuned: it is a ceiling on fan-out, not a promise
 * about any host's capacity.
 */
const HOST_CONCURRENCY = 6;

/**
 * Run one promise-returning task per item, at most `limit` at a time, and collect the results in the input's order, so
 * a caller that answers each item on its own keeps that answer in the place it asked. Rejections propagate: this is for
 * tasks whose failures are already values, not for tasks that may throw.
 */
async function mapBounded<TItem, TResult>(items: readonly TItem[], limit: number, work: (item: TItem, index: number) => Promise<TResult>): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The bundle file a skill document always has. */
const SKILL_DOCUMENT = "SKILL.md";

/**
 * The install-time content baseline of one published directory: a sha256 per bundle-relative path, and one hash over
 * the directory's sorted path/hash pairs. Adapted from cc-switch `services/skill.rs` `compute_dir_hash` and
 * `collect_files_for_hash` (MIT, see apps/server/vendor/cc-switch/README.md), which hash a directory's entries in
 * sorted order the same way. Ticket 07 compares a host directory against this baseline to tell an unchanged
 * installation from a locally modified one; a missing baseline is unknown, never proof of modification.
 */
export function installContentHashes(files: readonly { readonly path: string; readonly content: string; readonly encoding: "utf8" | "base64" }[]): { files: Record<string, string>; contentHash: string } {
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file.path] = createHash("sha256").update(Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8")).digest("hex");
  const folder = createHash("sha256");
  for (const path of Object.keys(hashes).sort()) folder.update(path + "\u0000" + hashes[path] + "\n");
  return { files: hashes, contentHash: folder.digest("hex") };
}

/** The directory name an installed skill takes: the slug the repository already validated, refused if it is not one. */
export function installDirectoryName(name: string): string | undefined {
  return DIRECTORY_PATTERN.test(name) ? name : undefined;
}

/** The bundle's files as one publish request: its SKILL.md document plus every file it carries, bytes preserved. */
export function bundleFiles(markdown: string, files: readonly MarketFile[]): PublishFile[] {
  return [{ path: SKILL_DOCUMENT, content: markdown, encoding: "utf8" }, ...files.map((file) => ({ path: file.path, content: file.content, encoding: file.encoding }))];
}

/**
 * The bundle one market id names. A published bundle is read at its version; a curated source is read at the revision
 * its preview resolved, so what is installed is exactly the content that was inspected, not the branch's current state.
 */
/** One resolved bundle: its content, its provenance, and — for a pinned source — the coordinate a check reads. */
type ResolvedBundle = {
  readonly name: string;
  readonly version?: string;
  readonly ref?: string;
  readonly sourceType: "repository" | "github";
  /** The GitHub coordinate the content was read from, when it was read from GitHub at all. */
  readonly repository?: string;
  /** The document's path inside that repository, so a later check reads the same document rather than one it guesses. */
  readonly documentPath?: string;
  readonly markdown: string;
  readonly files: readonly MarketFile[];
};

async function resolveBundle(market: SkillMarket, id: string): Promise<ResolvedBundle | undefined> {
  const stored = /^repository:([^@]+)@(.+)$/.exec(id);
  if (stored !== null) {
    const bundle: Bundle | undefined = await market.retrieve(stored[1]!, stored[2]!);
    if (bundle === undefined) return undefined;
    return { name: bundle.skill.name, version: bundle.skill.version, ref: bundle.skill.version, sourceType: "repository", markdown: bundle.markdown, files: bundle.files };
  }
  const preview: MarketPreview | undefined = await market.preview(id);
  if (preview === undefined || preview.skill.source.kind !== "github") return undefined;
  return {
    name: preview.skill.name,
    version: preview.skill.version,
    ref: preview.skill.source.revision,
    sourceType: "github",
    repository: preview.skill.source.repository,
    documentPath: preview.skill.source.path,
    markdown: preview.markdown,
    files: preview.files,
  };
}

/** The provenance record one installation writes, built from the bundle and the directory the host reported. */
export function installLockEntry(input: { name: string; scope: InstallScope; skillPath: string; bundle: { version?: string; ref?: string; sourceType: "repository" | "github"; repository?: string; documentPath?: string }; hashes: { files: Record<string, string>; contentHash: string } }): InstallLockEntry {
  const source = input.bundle.sourceType === "repository" ? "repository:" + input.name + (input.bundle.version === undefined ? "" : "@" + input.bundle.version) : "github:" + input.name + "@" + (input.bundle.ref ?? "");
  return {
    source,
    sourceType: input.bundle.sourceType,
    // The repository coordinate and the document's own path are recorded with the pin: they are what an explicit
    // update check reads, so it never has to guess a repository from a skill's name and never reads a different
    // document than the one that was installed.
    ...(input.bundle.repository === undefined ? {} : { repository: input.bundle.repository }),
    ...(input.bundle.documentPath === undefined ? {} : { documentPath: input.bundle.documentPath }),
    ...(input.bundle.ref === undefined ? {} : { ref: input.bundle.ref }),
    ...(input.bundle.version === undefined ? {} : { version: input.bundle.version }),
    skillPath: input.skillPath,
    scope: input.scope,
    installedAtMs: Date.now(),
    files: input.hashes.files,
    contentHash: input.hashes.contentHash,
  };
}

/** Whether the host directory still holds exactly the content the install-time baseline recorded. */
export type UpdateState = "unchanged" | "locally-modified" | "unmanaged";

/**
 * Whether the repository holds a newer revision than the one recorded at installation. This is the *source* question
 * and is separate from the baseline question above: an installation can be unchanged by the user and still behind the
 * repository, and a locally modified one can be the newest revision. Unknown provenance answers neither way.
 */
export type RevisionState = "up-to-date" | "update-available" | "unknown";

/** One execution-side skill as the host actually holds it, with its provenance and both state questions. */
export type InstalledSkillSummary = {
  /** The declared name from the document's frontmatter: the skill's display name, which need not be its directory. */
  readonly name: string;
  /** The skill's real directory name on the host: what an installation, an update and the lock are keyed by. */
  readonly directory: string;
  readonly description: string;
  readonly filePath: string;
  /** Where the skill lives on the host: the account (global), the workspace (project), or an ancestor .agents root. */
  readonly scope: "global" | "project" | "path";
  readonly disableModelInvocation: boolean;
  /** The recorded installation, absent for a skill this scope has no baseline for (hand-written, git, Pi). */
  readonly install?: {
    readonly scope: InstallScope;
    readonly state: UpdateState;
    readonly source: string;
    readonly sourceType: string;
    readonly ref?: string;
    readonly version?: string;
    /** The GitHub coordinate the content came from, when it did: what an explicit update check asks about. */
    readonly repository?: string;
    readonly documentPath?: string;
    readonly path: string;
    /** The installed directory name, which is the bundle name an update replaces. */
    readonly directory: string;
    readonly files: Readonly<Record<string, string>>;
  };
  readonly revision: RevisionState;
  /** The repository's newest version of this bundle, when the repository holds one at all. */
  readonly availableVersion?: string;
};

/** What one execution workspace holds: the skills it discovers, and the account that holds them. */
export type InventoryResponse =
  | { readonly status: 200; readonly body: { readonly workspaceId: string; readonly host: { readonly user: string; readonly home: string }; readonly skills: readonly InstalledSkillSummary[] } }
  | { readonly status: 404 | 502; readonly body: { readonly error: { readonly code: string; readonly message: string } } };

/** What an update would do to one installed skill, and the digest set a confirmed overwrite is pinned to. */
export type UpdateStatus = { readonly name: string; readonly state: UpdateState; readonly baseline?: InstallLockEntry; readonly current?: DirectoryInspection };

/** One directory's outcome in a toggle request. A refused directory is reported beside the ones that changed. */
export type ToggleResult = { readonly directory: string; readonly changed?: boolean; readonly error?: { readonly code: string; readonly message: string } };

export type ToggleRequest = {
  readonly workspaceId?: unknown;
  readonly conversationId?: unknown;
  readonly scope: unknown;
  readonly directories: unknown;
  readonly disableModelInvocation: unknown;
};

/**
 * What one toggle reported. Each directory is answered on its own, so a directory the host refuses does not stop the
 * rest — the upstream bulk contract, kept — and the adoption outcome stays separate from what happened to the files.
 */
export type ToggleResponse =
  | { readonly status: 200; readonly body: { readonly results: readonly ToggleResult[]; readonly scope: InstallScope; readonly reload?: InstallReload } }
  | { readonly status: 400 | 404 | 409 | 502; readonly body: { readonly error: { readonly code: string; readonly message: string } } };

/**
 * The source-revision answer of one installation, asked for by the user. `unknown` is a real answer: an installation
 * with no recorded GitHub provenance, or a repository this process cannot read, has not been compared, and saying so is
 * the honest report. It is never presented as "up to date", and a newer revision brings the pinned selection an update
 * would install.
 */
export type CheckResponse =
  | { readonly status: 200; readonly body: { readonly state: RevisionState; readonly currentRevision?: string; readonly availableRevision?: string; readonly id?: string; readonly repository?: string } }
  | { readonly status: 400 | 404 | 409 | 502; readonly body: { readonly error: { readonly code: string; readonly message: string } } };

/**
 * Compare an installed directory with the baseline recorded at installation. The comparison is over the host's real
 * entries, so a file added, deleted, replaced or turned into a link all read as a modification. An installation this
 * scope has no baseline for is unmanaged: unknown provenance is never reported as an unmodified installation, and it
 * is never overwritten on the strength of a missing record.
 */
export function updateState(baseline: InstallLockEntry | undefined, current: DirectoryInspection | undefined): UpdateState {
  if (current === undefined) return "unmanaged";
  if (baseline === undefined) return "unmanaged";
  return sameDigests(baseline.files, current.files) && baseline.contentHash === current.contentHash ? "unchanged" : "locally-modified";
}

/**
 * A bounded, single-line form of a message that came from outside this process, for a response the browser renders.
 * A gateway error can be arbitrarily long and can carry newlines; neither is rendered, and truncating is visible.
 */
export function boundedMessage(message: string, limit = 300): string {
  const single = message.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : single.slice(0, limit - 1) + "…";
}

/**
 * The repository's newest version of one bundle, from the repository's own version list, or nothing when it holds no
 * such bundle or holds a version that is not a semantic version. Ordering is the semver library's own, never a string
 * comparison: `1.0.0-beta.10` is newer than `1.0.0-beta.2` even though it sorts before it lexically. A version the
 * library rejects — a malformed identifier, a leading zero — leaves the question unanswered rather than guessing a
 * newest version, and the caller then reports "not compared with the repository".
 */
async function newestVersion(market: SkillMarket, name: string): Promise<string | undefined> {
  const versions = (await market.versions(name).catch(() => [])).map((entry) => entry.version);
  if (versions.length === 0 || !versions.every((version) => valid(version) !== null)) return undefined;
  return rsort(versions)[0];
}

export function createInstaller(options: InstallerOptions) {
  const fail = (status: 400 | 404 | 409 | 502, code: string, message: string): InstallResponse => ({ status, body: { error: { code, message } } });
  // The same refusal, for the operations whose success body is a toggle's or a check's rather than an installation's.
  // Every response type here refuses with one shape, so the route answers an error the same way whatever was asked.
  const refuse = <TResponse>(status: 400 | 404 | 409 | 502, code: string, message: string): TResponse => ({ status, body: { error: { code, message } } }) as TResponse;

  const bindingOf = (workspaceId: string | undefined): EnvironmentBinding | undefined => options.workspaces().find((workspace) => workspace.id === workspaceId);

  /**
   * The execution target: the workspace the caller named, or the initiating conversation's own binding. A named
   * conversation and a named workspace must agree on the host, so a Reload can never be asked of a conversation that
   * runs somewhere else — including one bound to no workspace at all, which has nothing to adopt into. The refusal
   * happens here, before anything is published, so a target this process would adopt wrongly never reaches the host.
   */
  async function target(request: InstallTarget): Promise<InstallResult<EnvironmentBinding>> {
    const named = typeof request.workspaceId === "string" && request.workspaceId !== "" ? request.workspaceId : undefined;
    const conversationId = typeof request.conversationId === "string" && request.conversationId !== "" ? request.conversationId : undefined;
    if (conversationId !== undefined && options.conversation(conversationId) === undefined) return installFailure("not_found", "unknown conversation");
    const bound = conversationId === undefined ? undefined : await options.boundWorkspace(conversationId);
    if (named !== undefined && conversationId !== undefined && named !== bound) {
      return installFailure("conflict", bound === undefined ? "the conversation is bound to no execution workspace" : "the conversation is bound to a different workspace than the installation target");
    }
    const workspaceId = named ?? bound;
    const binding = bindingOf(workspaceId);
    if (binding === undefined) return installFailure("not_found", workspaceId === undefined ? "the installation needs an execution workspace" : "unknown workspace");
    await options.ensure?.(binding.id);
    return { ok: true, value: binding };
  }

  /** The initiating conversation, when one was named and this process knows it. */
  function initiator(conversationId: unknown): ConversationTx | undefined {
    return typeof conversationId === "string" && conversationId !== "" ? options.conversation(conversationId) : undefined;
  }

  /** Read the scope's lock and the host's real directory, and say how they differ. */
  async function inspect(binding: EnvironmentBinding, scope: InstallScope, directory: string): Promise<InstallResult<{ entry: InstallLockEntry | undefined; directory: DirectoryInspection }>> {
    const control = installsOf(binding);
    const lock = await control.installs<InstallLockDocument | undefined>({ operation: "readLock", scope });
    if (!lock.ok) return lock;
    const entry = lock.value?.skills[directory];
    const current = await control.installs<DirectoryInspection>({ operation: "inspectDirectory", scope, directory });
    // No directory at all is the caller's business, not an inspection failure: it means nothing is installed there.
    if (!current.ok && current.error.code === "not_found") return installFailure("not_found", current.error.message);
    if (!current.ok) return current;
    return { ok: true, value: { entry, directory: current.value } };
  }

  /**
   * Install one bundle, or update an installation the caller confirmed. Publication and adoption stay separate
   * outcomes, and a published directory whose lock could not be written is reported as published anyway: the files
   * are on the host, so reporting only a failure would hide them and make a retry look like a conflict.
   */
  async function publish(request: InstallTarget, id: unknown, scope: InstallScope, overwrite: boolean, expect?: ExpectedDigests): Promise<InstallResponse> {
    if (typeof id !== "string" || id === "") return fail(400, "invalid_bundle", "a bundle id is required");
    const conversation = initiator(request.conversationId);
    const binding = await target(request);
    if (!binding.ok) return fail(binding.error.code === "conflict" ? 409 : 404, binding.error.code, binding.error.message);

    const bundle = await resolveBundle(options.market, id);
    if (bundle === undefined) return fail(404, "unknown_bundle", "unknown skill bundle");
    const directory = installDirectoryName(bundle.name);
    if (directory === undefined) return fail(400, "invalid_bundle", "the bundle name is not a directory name this host can install");
    const files = bundleFiles(bundle.markdown, bundle.files);
    const control = installsOf(binding.value);
    // A replacement is pinned to the digest set the caller saw, never to a fresh read taken here: the host re-reads the
    // directory at the mutation boundary and refuses the replacement when it no longer matches, so an edit that arrived
    // after the caller looked is reported as a conflict with the edit intact instead of being silently discarded.
    const published = await control.installs<PublishedDirectory>({ operation: "publishDirectory", scope, directory, files, overwrite, ...(expect === undefined ? {} : { expect }) });
    if (!published.ok) {
      const conflict = published.error.code === "conflict";
      return fail(conflict ? 409 : published.error.code === "not_found" ? 404 : 502, published.error.code, published.error.message);
    }
    const hashes = installContentHashes(files);
    const entry = installLockEntry({ name: bundle.name, scope, skillPath: published.value.path, bundle, hashes });
    const recorded = await control.installs<InstallLockDocument>({ operation: "recordInstall", scope, name: directory, entry });
    const installed: InstalledSkill = {
      name: bundle.name,
      ...(bundle.version === undefined ? {} : { version: bundle.version }),
      scope,
      path: published.value.path,
      files: published.value.files,
      contentHash: hashes.contentHash,
      ...(published.value.backup === undefined ? {} : { backup: published.value.backup }),
    };
    // The directory is published. A lock that could not be written is reported as a warning on the published result,
    // because provenance is now unknown and a retry must not look like an unattempted installation.
    const reload = conversation === undefined ? undefined : await adopt(conversation, binding.value);
    return recorded.ok
      ? { status: 200, body: { installed, ...(reload === undefined ? {} : { reload }) } }
      : { status: 200, body: { installed, ...(reload === undefined ? {} : { reload }), warning: { code: recorded.error.code, message: recorded.error.message } } };
  }

  /** What an update of one installed skill would do, without changing anything on the host. */
  async function status(request: InstallTarget, name: unknown, scope: unknown): Promise<UpdateResponse> {
    if (scope !== "global" && scope !== "workspace") return { status: 400, body: { error: { code: "invalid_scope", message: "installation scope must be global or workspace" } } };
    if (typeof name !== "string") return { status: 400, body: { error: { code: "invalid_skill", message: "the installed skill name is required" } } };
    const directory = installDirectoryName(name);
    if (directory === undefined) return { status: 400, body: { error: { code: "invalid_skill", message: "a skill name is a directory name this host can hold" } } };
    const binding = await target(request);
    // A target the caller cannot install to is a conflict when its conversation is bound elsewhere, not a missing
    // skill: reporting 404 would say the installed directory does not exist when the request never reached the host.
    if (!binding.ok) return { status: binding.error.code === "conflict" ? 409 : 404, body: { error: { code: binding.error.code, message: binding.error.message } } };
    const inspected = await inspect(binding.value, scope, directory);
    if (!inspected.ok) return { status: 404, body: { error: { code: inspected.error.code, message: inspected.error.message } } };
    const state = updateState(inspected.value.entry, inspected.value.directory);
    return {
      status: 200,
      body: {
        skill: { name: directory, scope, state, path: inspected.value.directory.path, files: inspected.value.directory.files, ...(inspected.value.entry?.version === undefined ? {} : { version: inspected.value.entry.version }) },
      },
    };
  }

  async function install(request: InstallRequest): Promise<InstallResponse> {
    if (request.scope !== "global" && request.scope !== "workspace") return fail(400, "invalid_scope", "installation scope must be global or workspace");
    if (request.id === undefined || request.id === null) return fail(400, "invalid_bundle", "a bundle id is required");
    return await publish(request, request.id, request.scope, false);
  }

  /** Replace an installed skill the caller confirmed: the host retains the replaced directory before publishing. */
  async function update(request: InstallRequest): Promise<InstallResponse> {
    if (request.scope !== "global" && request.scope !== "workspace") return fail(400, "invalid_scope", "installation scope must be global or workspace");
    if (typeof request.name !== "string" || request.name === "") return fail(400, "invalid_skill", "the installed skill name is required");
    if (request.id === undefined || request.id === null) return fail(400, "invalid_bundle", "a bundle id is required");
    const installed = installDirectoryName(request.name);
    if (installed === undefined) return fail(400, "invalid_skill", "a skill name is a directory name this host can hold");
    const status_ = await status(request, installed, request.scope);
    // Nothing is installed, so there is nothing to discard and this is an installation rather than a replacement. The
    // host refuses if a directory appeared since the caller looked, rather than overwriting one it never confirmed.
    if (status_.status === 404 && status_.body.error.code === "not_found") return await publish(request, request.id, request.scope, false);
    if (status_.status !== 200) return status_;
    // An unchanged installation is replaced without a confirmation, because nothing would be discarded. A locally
    // modified or unmanaged one is only replaced when the caller confirmed that exact directory.
    if (status_.body.skill.state !== "unchanged" && request.confirm !== true) {
      return { status: 409, body: { error: { code: "confirmation_required", message: "the installed skill is " + status_.body.skill.state + "; confirm the overwrite to replace it" }, state: status_.body.skill.state } };
    }
    // The replacement is pinned to a snapshot the caller saw: the digest set it sent, or, when it sent none, the one
    // this status read. Either way the host compares against that snapshot at the mutation boundary, so an edit that
    // arrived after the snapshot answers 409 with the edit intact, and a confirmation of a stale preview is refused
    // rather than applied.
    return await publish(request, request.id, request.scope, true, expectedDigests(request.expect) ?? status_.body.skill.files);
  }

  /**
   * What one execution workspace holds: every skill the host discovers, each with the installation this scope recorded
   * for it (if any) and the two separate state questions. Discovery runs through the same Workspace Resource Loader the
   * runtime uses, so the list is the host's own content rather than a second source of truth, and an unreachable host
   * is reported as an error instead of an empty list. Nothing is changed and no conversation is needed.
   */
  async function inventory(request: InstallTarget): Promise<InventoryResponse> {
    const binding = await target(request);
    if (!binding.ok) return { status: 404, body: { error: { code: binding.error.code, message: binding.error.message } } };
    if (options.resources === undefined) return { status: 404, body: { error: { code: "not_configured", message: "resource loading is not configured" } } };
    const env = gatewayEnvironment(binding.value, "/") as ExecutionHostEnv;
    let state;
    try {
      state = await options.resources.discover(env, BACKGROUND_CONTEXT);
    } catch (error) {
      return { status: 502, body: { error: { code: "unreachable_host", message: boundedMessage(error instanceof Error ? error.message : String(error)) } } };
    }
    if (state.status === "failed") return { status: 502, body: { error: { code: "unreachable_host", message: boundedMessage(state.error) } } };
    const control = installsOf(binding.value);
    const locks: Record<InstallScope, Readonly<Record<string, InstallLockEntry>>> = { global: {}, workspace: {} };
    for (const scope of ["global", "workspace"] as const) {
      const lock = await control.installs<InstallLockDocument | undefined>({ operation: "readLock", scope });
      // A lock this host cannot read is reported as unknown provenance for every skill rather than failing the list:
      // the skills themselves are still there and still usable. A host that has never recorded an installation answers
      // with no lock at all - `undefined` from the local host, `null` through the SSH helper's JSON - and that is an
      // empty lock, not a failure to read one.
      if (lock.ok && lock.value != null) locks[scope] = lock.value.skills;
    }
    // Every skill in the catalog is inspected on its own, and each inspection is a host round trip. They are
    // independent, so they run together under one bound instead of one at a time; the list is sorted by name below, so
    // the order the host happened to answer in is not observable. `options.market` reads the repository the backend
    // already holds in this process, not the host, so it does not change what the bound covers.
    const catalog = state.catalog.filter((entry) => entry.kind === "skill");
    const skills = await mapBounded(catalog, HOST_CONCURRENCY, async (entry): Promise<InstalledSkillSummary> => {
      const directory = entry.baseDir.split("/").pop() ?? "";
      const managed = (["global", "workspace"] as const)
        .map((scope) => ({ scope, entry: locks[scope][directory] }))
        .find((candidate) => candidate.entry !== undefined && candidate.entry.skillPath === entry.baseDir);
      const install = managed?.entry === undefined ? undefined : await inspectInstall(control, managed.scope, directory, managed.entry);
      // Only an installation this repository itself published can be compared with it. A curated GitHub source is
      // pinned to a commit, not to a bundle version, so a repository bundle that merely shares the directory name is
      // a different artifact: its newest version says nothing about that installation, and reporting it as up to date
      // would claim a provenance the installation does not have.
      const available = install?.sourceType !== "repository" ? undefined : await newestVersion(options.market, directory);
      const revision: RevisionState = install?.version === undefined || available === undefined
        ? "unknown"
        : install.version === available ? "up-to-date" : "update-available";
      return {
        name: entry.name,
        directory,
        description: entry.description,
        filePath: entry.location,
        scope: entry.scope === "ancestor" ? "path" : entry.scope,
        disableModelInvocation: entry.disableModelInvocation === true,
        ...(install === undefined ? {} : { install }),
        revision,
        ...(available === undefined ? {} : { availableVersion: available }),
      };
    });
    return {
      status: 200,
      body: {
        workspaceId: binding.value.id,
        host: { user: state.user, home: state.home },
        skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
      },
    };
  }

  /**
   * Set or clear the model-invocation key on one installed skill's document per directory the caller named, and report
   * each on its own. The host does the edit inside the installation scope; this module only resolves the execution
   * target and forwards what the host answered. A directory that could not be edited is a result beside the others, not
   * a failure of the whole request, and the whole request is refused before anything runs when the target itself is not
   * the caller's to write to.
   */
  async function toggle(request: ToggleRequest): Promise<ToggleResponse> {
    if (request.scope !== "global" && request.scope !== "workspace") return refuse<ToggleResponse>(400, "invalid_scope", "installation scope must be global or workspace");
    // Narrowed once for the batch below: a property read is not narrowed inside the callbacks that outlive this frame.
    const scope: InstallScope = request.scope;
    if (typeof request.disableModelInvocation !== "boolean") return refuse<ToggleResponse>(400, "invalid_request", "disableModelInvocation must be a boolean");
    const disable: boolean = request.disableModelInvocation;
    const directories = request.directories;
    if (!Array.isArray(directories) || directories.length === 0 || !directories.every(directory => typeof directory === "string" && directory !== "")) {
      return refuse<ToggleResponse>(400, "invalid_request", "directories must be a non-empty list of skill directory names");
    }
    const conversation = initiator(request.conversationId);
    const binding = await target(request);
    if (!binding.ok) return refuse<ToggleResponse>(binding.error.code === "conflict" ? 409 : 404, binding.error.code, binding.error.message);
    const control = installsOf(binding.value);
    // Each directory is answered on its own, in the order asked, so a refusal is a result the panel can show beside the
    // directories that changed instead of an all-or-nothing batch. The directories are independent — the gateway
    // serializes per directory itself — so they run together under one bound rather than one host round trip at a time,
    // while the answers keep the order the caller named: one refused directory is still a result beside the rest.
    const results: ToggleResult[] = await mapBounded([...new Set(directories as string[])], HOST_CONCURRENCY, async (directory): Promise<ToggleResult> => {
      const name = installDirectoryName(directory);
      if (name === undefined) return { directory, error: { code: "invalid", message: "a skill directory name is a lowercase slug" } };
      const edited = await control.installs<ToggledSkill>({ operation: "toggleSkill", scope, directory: name, disableModelInvocation: disable });
      return edited.ok ? { directory: name, changed: edited.value.changed } : { directory: name, error: { code: edited.error.code, message: edited.error.message } };
    });
    // Only the conversation that runs on this target is asked to adopt, exactly as an installation does; the files are
    // already edited whether or not anything reloads, and a failed reload is the second, separate outcome.
    const reload = conversation === undefined ? undefined : await adopt(conversation, binding.value);
    return { status: 200, body: { results, scope, ...(reload === undefined ? {} : { reload }) } };
  }

  /**
   * Whether the repository holds a newer revision of one installed GitHub skill. This is the only path that reads the
   * repository's current commit, and it runs only because the user asked: listing a host's skills never reaches GitHub.
   * An installation with no GitHub provenance, and a repository this process cannot read, both answer `unknown` rather
   * than pretending to have compared anything.
   */
  async function check(request: InstallTarget, name: unknown, scope: unknown): Promise<CheckResponse> {
    if (scope !== "global" && scope !== "workspace") return { status: 400, body: { error: { code: "invalid_scope", message: "installation scope must be global or workspace" } } };
    if (typeof name !== "string" || name === "") return { status: 400, body: { error: { code: "invalid_skill", message: "the installed skill name is required" } } };
    const directory = installDirectoryName(name);
    if (directory === undefined) return { status: 400, body: { error: { code: "invalid_skill", message: "a skill name is a directory name this host can hold" } } };
    const binding = await target(request);
    if (!binding.ok) return { status: binding.error.code === "conflict" ? 409 : 404, body: { error: { code: binding.error.code, message: binding.error.message } } };
    const control = installsOf(binding.value);
    const lock = await control.installs<InstallLockDocument | undefined>({ operation: "readLock", scope });
    if (!lock.ok) return { status: 502, body: { error: { code: lock.error.code, message: lock.error.message } } };
    const entry = lock.value?.skills[directory];
    // The installed directory must still be there: a question about a skill the host no longer holds is a missing skill.
    const current = await control.installs<DirectoryInspection>({ operation: "inspectDirectory", scope, directory });
    if (!current.ok) return { status: current.error.code === "not_found" ? 404 : 502, body: { error: { code: current.error.code, message: current.error.message } } };
    // No recorded GitHub coordinate means there is no repository to ask about, which is not the same fact as a
    // repository that has not moved. Both are reported as unknown, and neither invents a newest revision.
    if (entry === undefined || entry.sourceType !== "github" || entry.repository === undefined || entry.documentPath === undefined || entry.ref === undefined) {
      return { status: 200, body: { state: "unknown" } };
    }
    const fresh_ = await options.market.refresh({ repository: entry.repository, documentPath: entry.documentPath }).catch(() => undefined);
    if (fresh_ === undefined) return { status: 200, body: { state: "unknown", currentRevision: entry.ref, repository: entry.repository } };
    const state: RevisionState = fresh_.revision === entry.ref ? "up-to-date" : "update-available";
    return {
      status: 200,
      body: {
        state,
        currentRevision: entry.ref,
        repository: entry.repository,
        ...(state === "update-available" ? { availableRevision: fresh_.revision, id: fresh_.id } : {}),
      },
    };
  }

  /** One recorded installation as the host holds it now: the recorded provenance plus the baseline comparison. */
  async function inspectInstall(host: ReturnType<typeof installsOf>, scope: InstallScope, directory: string, entry: InstallLockEntry): Promise<NonNullable<InstalledSkillSummary["install"]>> {
    const current = await host.installs<DirectoryInspection>({ operation: "inspectDirectory", scope, directory });
    const state = updateState(entry, current.ok ? current.value : undefined);
    return {
      scope,
      state,
      source: entry.source,
      sourceType: entry.sourceType,
      ...(entry.ref === undefined ? {} : { ref: entry.ref }),
      ...(entry.version === undefined ? {} : { version: entry.version }),
      ...(entry.repository === undefined ? {} : { repository: entry.repository }),
      ...(entry.documentPath === undefined ? {} : { documentPath: entry.documentPath }),
      path: entry.skillPath,
      directory,
      files: current.ok ? current.value.files : entry.files,
    };
  }

  /**
   * Ask the initiating conversation to adopt the new installation. This is the existing Reload path, so an active run
   * keeps its prefix and the candidate applies to the next run; a failure is reported as the second outcome and the
   * published files stay exactly as they were.
   */
  async function adopt(conversation: ConversationTx, binding: EnvironmentBinding): Promise<InstallReload> {
    if (options.resources === undefined) return { ok: false, error: "resource loading is not configured" };
    try {
      await reloadResources(conversation, options.resources, gatewayEnvironment(binding, "/") as ExecutionHostEnv, BACKGROUND_CONTEXT);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { install, update, status, inventory, toggle, check };
}

export type Installer = ReturnType<typeof createInstaller>;

/** The route body's shape, checked before the installer sees it. */
export function installRequest(body: unknown): InstallRequest | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  return { id: value.id, workspaceId: value.workspaceId, conversationId: value.conversationId, scope: value.scope };
}

/**
 * The digest set a caller says it inspected: relative file paths to sha256 digests, exactly the shape a status answer
 * reports. Anything else is not a snapshot of a host directory and is refused rather than treated as one.
 */
export function expectedDigests(value: unknown): ExpectedDigests | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([path, hash]) => safeInstallPath(path) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) return undefined;
  return Object.fromEntries(entries) as ExpectedDigests;
}

/**
 * The route body of an update or a status check: the installed skill, its scope, whether the overwrite is confirmed,
 * and the digest set the caller inspected. A body that names an inspected snapshot this module cannot read is refused
 * outright, so a caller can never downgrade its own confirmation to "whatever the host holds now".
 */
/**
 * The route body of a toggle: the execution target, the scope, the directories to switch and the state to switch them
 * to. A body that names no directory, or a state that is not a boolean, is refused here so a request can never reach
 * the host half-checked.
 */
export function toggleRequest(body: unknown): ToggleRequest | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.directories) || value.directories.length === 0) return undefined;
  if (!value.directories.every(directory => typeof directory === "string" && directory !== "")) return undefined;
  if (typeof value.disableModelInvocation !== "boolean") return undefined;
  return { workspaceId: value.workspaceId, conversationId: value.conversationId, scope: value.scope, directories: value.directories, disableModelInvocation: value.disableModelInvocation };
}

export function updateRequest(body: unknown): InstallRequest | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (typeof value.name !== "string" || value.name === "") return undefined;
  if (value.files !== undefined && expectedDigests(value.files) === undefined) return undefined;
  return { id: value.id, name: value.name, workspaceId: value.workspaceId, conversationId: value.conversationId, scope: value.scope, confirm: value.confirm === true, ...(value.files === undefined ? {} : { expect: value.files }) };
}
