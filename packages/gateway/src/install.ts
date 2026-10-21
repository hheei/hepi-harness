import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SshProfile, SshRunner, SshRunnerResult } from "./index.ts";
import { localExecutionHostIdentity, type ExecutionHostIdentity } from "./filesystem.ts";
import { setDisableModelInvocation } from "./skill-frontmatter.ts";
import { workspaceOwner, type WorkspaceRegistry } from "./workspaces.ts";

/**
 * The installation capability (ADR 0002, tickets 06 and 07). It is deliberately narrow: it publishes one whole
 * directory atomically into one of the two installation scopes, inspects an installed directory against the scope's
 * recorded baseline, and stores one JSON lock document per scope. It is not a general filesystem and it does not
 * accept a caller-chosen destination path, so no request can write outside the execution account's .agents directory
 * or the bound workspace's .agents directory.
 *
 * Both scope roots are confined before anything is written: the resolved scope root must stay inside the execution
 * account's canonical home (global) or the bound workspace's canonical root (workspace). A link inside that root is
 * followed; a link that leaves it is refused, so a symlinked .agents directory cannot redirect a publication,
 * an inspection or the scope lock somewhere else.
 *
 * Publication is staged and atomic. Files are written into a staging directory that is a sibling of the destination
 * (same filesystem), and one rename publishes it, so a failed or interrupted installation leaves no partial skill
 * directory. Replacing an existing directory moves it into a retained backup first and puts it back if the publish
 * rename fails, so an overwrite never leaves the destination missing. A dispatched mutation whose response is lost is
 * reported as an unknown outcome and is never replayed.
 */

/** Where an installation belongs: the execution host and login (global), or the bound workspace (workspace). */
export type InstallScope = "global" | "workspace";

/** One file of a published directory. utf8 is its text, base64 is its bytes; a file is never a link. */
export type PublishFile = { readonly path: string; readonly content: string; readonly encoding: "utf8" | "base64" };

export type InstallFailureCode = "conflict" | "invalid" | "not_found" | "permission_denied" | "aborted" | "outcome_unknown" | "not_supported" | "unknown";
export type InstallError = { readonly code: InstallFailureCode; readonly message: string };
export type InstallResult<T = unknown> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: InstallError };

/**
 * What is recorded about one installed skill. The shape is borrowed from pi-web's .skill-lock.json entry
 * (lib/skill-lock.ts: source, sourceType, skillPath, ref, folder hash) with the install-time baseline spelled out as
 * one hash per file, which is what distinguishes unmanaged, unchanged and locally modified content (cc-switch
 * services/skill.rs compute_dir_hash / contentHash). An absent entry or an absent baseline is unknown provenance,
 * never proof that content was modified.
 */
export type InstallLockEntry = {
  /** What the skill came from: a repository bundle, a curated source, or a hand-made local record. */
  readonly source: string;
  readonly sourceType: "repository" | "github" | "local";
  /** The pinned revision the content was read at: a bundle version, or the source's commit. */
  readonly ref?: string;
  /**
   * The GitHub coordinate the content came from, when it did: `owner/repo`. Recorded beside the pinned revision so an
   * update check can ask that repository for its current commit without guessing it from a name, and so a source that
   * later moved or vanished is still nameable. Absent for a repository bundle, which is versioned, not pinned.
   */
  readonly repository?: string;
  /** The document's path inside that repository, exactly as installed, so a check reads the same document. */
  readonly documentPath?: string;
  /** Absolute host path of the installed skill directory. */
  readonly skillPath: string;
  readonly scope: InstallScope;
  readonly version?: string;
  readonly installedAtMs: number;
  /** sha256 per bundle-relative file path, as installed. */
  readonly files: Readonly<Record<string, string>>;
  /** One hash over the directory's sorted path/content hashes. */
  readonly contentHash: string;
};

/** The whole lock document of one scope. Metadata only: it holds no resource content. */
export type InstallLockDocument = { readonly version: 1; readonly skills: Readonly<Record<string, InstallLockEntry>> };

/** One installed directory as the host actually holds it: a digest per entry, and one over the whole set. */
export type DirectoryInspection = {
  readonly path: string;
  /** Relative path to digest: a file's sha256, or link:<sha256 of the target> for a symbolic link. */
  readonly files: Readonly<Record<string, string>>;
  readonly contentHash: string;
};

export type InstallRequest =
  | { readonly workspaceId: string; readonly operation: "publishDirectory"; readonly scope: InstallScope; readonly directory: string; readonly files: readonly PublishFile[]; readonly overwrite?: boolean; readonly expect?: Readonly<Record<string, string>> }
  | { readonly workspaceId: string; readonly operation: "inspectDirectory"; readonly scope: InstallScope; readonly directory: string }
  | { readonly workspaceId: string; readonly operation: "readLock"; readonly scope: InstallScope }
  | { readonly workspaceId: string; readonly operation: "recordInstall"; readonly scope: InstallScope; readonly name: string; readonly entry: InstallLockEntry }
  | { readonly workspaceId: string; readonly operation: "toggleSkill"; readonly scope: InstallScope; readonly directory: string; readonly disableModelInvocation: boolean };

/** The installation surface GatewayRpcServer serves on /v1/installs. A local host and an SSH host implement it. */
export type InstallServer = { execute(request: InstallRequest): Promise<InstallResult> };

/** One request without its workspace: the gateway binding supplies that, exactly as it does for the file RPC. */
type WithoutWorkspace<T> = T extends { workspaceId: string } ? Omit<T, "workspaceId"> : never;
export type InstallOperation = WithoutWorkspace<InstallRequest>;

/** The digest set a caller inspected before it asked to replace a directory. */
export type ExpectedDigests = Readonly<Record<string, string>>;

/** Whether two digest sets describe the same entries, whatever order they arrived in. */
export function sameDigests(left: ExpectedDigests, right: ExpectedDigests): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

/** A published directory: its real host path, the relative paths it now holds, and where a replaced one was kept. */
export type PublishedDirectory = { readonly path: string; readonly files: readonly string[]; readonly backup?: string };

/**
 * The outcome of one document edit: whether the file was actually rewritten. A skill already in the requested state is
 * reported as unchanged, which is what makes "the file was not touched" a fact the caller can rely on rather than a
 * claim the host cannot support.
 */
export type ToggledSkill = { readonly changed: boolean };

/** The one directory name an installation may use. A slug cannot traverse, and it cannot be "." or "..". */
export const INSTALL_DIRECTORY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** A symbolic link never hashes like a file, so a link added after installation always reads as a modification. */
export const LINK_DIGEST_PREFIX = "link:";

/** The suffix a retained replacement directory carries. It is never scanned as an installation. */
export const BACKUP_SUFFIX = ".bak";

/**
 * A file path inside one skill directory: relative, portable, and never a directory. The bundle's own document is the
 * one SKILL.md at the top level; any other SKILL.md would make the installed directory ambiguous, and it is
 * refused case-insensitively because a host filesystem may not distinguish the two names.
 */
export function safeInstallPath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > 256) return false;
  if (path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (!segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")) return false;
  const last = segments[segments.length - 1]!;
  return last === "SKILL.md" ? segments.length === 1 : last.toLowerCase() !== "skill.md";
}

export function installFailure(code: InstallFailureCode, message: string): InstallResult<never> {
  return { ok: false, error: { code, message } };
}

/** The lock file of one scope, beside the skills directory it describes. */
export function installLockPath(scopeRoot: string): string {
  return join(dirname(scopeRoot), ".skill-lock.json");
}

/** The skills directory an installation scope publishes into. */
export function installScopeRoot(scope: InstallScope, workspaceRoot: string, home: string): string {
  return scope === "global" ? join(home, ".agents", "skills") : join(workspaceRoot, ".agents", "skills");
}

/** Whether a value is a lock entry this capability may store. Anything else is refused before it reaches the host. */
export function validLockEntry(value: unknown): value is InstallLockEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.source !== "string" || entry.source === "") return false;
  if (entry.sourceType !== "repository" && entry.sourceType !== "github" && entry.sourceType !== "local") return false;
  if (typeof entry.skillPath !== "string" || !isAbsolute(entry.skillPath)) return false;
  if (entry.scope !== "global" && entry.scope !== "workspace") return false;
  if (typeof entry.installedAtMs !== "number" || !Number.isFinite(entry.installedAtMs)) return false;
  if (typeof entry.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.contentHash)) return false;
  if (entry.files === null || typeof entry.files !== "object" || Array.isArray(entry.files)) return false;
  if (!Object.entries(entry.files as Record<string, unknown>).every(([path, hash]) => safeInstallPath(path) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) return false;
  if (entry.repository !== undefined && (typeof entry.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(entry.repository))) return false;
  if (entry.documentPath !== undefined && (typeof entry.documentPath !== "string" || entry.documentPath === "")) return false;
  return (entry.ref === undefined || typeof entry.ref === "string") && (entry.version === undefined || typeof entry.version === "string");
}

/** Whether a parsed value is a lock document this capability may extend. A corrupt lock is refused, never overwritten. */
export function validLockDocument(value: unknown): value is InstallLockDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.version !== 1) return false;
  if (document.skills === null || typeof document.skills !== "object" || Array.isArray(document.skills)) return false;
  return Object.entries(document.skills as Record<string, unknown>).every(([name, entry]) => INSTALL_DIRECTORY_PATTERN.test(name) && validLockEntry(entry));
}

export function emptyLockDocument(): InstallLockDocument {
  return { version: 1, skills: {} };
}

/** Whether a path is the root itself or inside it. Used to confine a resolved scope root to its authorized root. */
function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One hash over a directory's sorted path/digest pairs. The same rule the install-time baseline uses. */
export function folderContentHash(digests: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const path of Object.keys(digests).sort()) hash.update(path + "\u0000" + digests[path] + "\n");
  return hash.digest("hex");
}

/**
 * Resolve the scope root and confine it to the root that scope is authorized to write: the execution account's
 * canonical home, or the bound workspace's canonical root. Each component is resolved before it is created, so a
 * symlinked .agents directory is followed only while it stays inside that root and is refused before any write when
 * it does not.
 */
async function confinedScopeRoot(scope: InstallScope, workspaceRoot: string, home: string): Promise<InstallResult<string>> {
  const authorized = await realpath(scope === "global" ? home : workspaceRoot).catch(() => undefined);
  if (authorized === undefined) return installFailure("permission_denied", "the installation root of this scope is not reachable");
  let current = authorized;
  for (const segment of [".agents", "skills"]) {
    const next = join(current, segment);
    if ((await lstat(next).catch(() => undefined)) === undefined) {
      await mkdir(next, { recursive: true });
      current = await realpath(next);
      continue;
    }
    const existing = await realpath(next).catch(() => undefined);
    if (existing === undefined || !within(authorized, existing)) return installFailure("permission_denied", "the installation scope resolves outside " + authorized);
    current = existing;
  }
  return { ok: true, value: current };
}

/** Every entry of an installed directory: a file's sha256, a link's target digest, or the fact that it is neither. */
async function directoryDigests(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const key = relative(root, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) entries[key] = LINK_DIGEST_PREFIX + digest(await readlink(path));
      else if (info.isDirectory()) await walk(path);
      else if (info.isFile()) entries[key] = digest(await readFile(path));
      else entries[key] = "other";
    }
  };
  await walk(root);
  return entries;
}

/** Where one replaced directory is retained: a uniquely named sibling of the skills directory, never inside it. */
export function backupPath(scopeRoot: string, directory: string): string {
  return join(dirname(scopeRoot), directory + BACKUP_SUFFIX);
}

/**
 * Move a replaced directory aside under a unique `.bak` path beside the skills directory. It is a rename, so the
 * replaced content is never copied and never partially written, and a name already in use is stepped over rather than
 * overwritten: a previous replacement's backup is never destroyed by the next one.
 */
async function moveToBackup(scopeRoot: string, destination: string, directory: string): Promise<InstallResult<string>> {
  const parent = dirname(scopeRoot);
  const realParent = await realpath(parent);
  if (realParent !== parent) return installFailure("permission_denied", "the backup location resolves outside " + parent);
  let target = backupPath(scopeRoot, directory);
  for (let counter = 1; (await lstat(target).catch(() => undefined)) !== undefined; counter += 1) target = join(realParent, directory + "." + counter + BACKUP_SUFFIX);
  try {
    await rename(destination, target);
  } catch (error) {
    // A destination that vanished means another request published or replaced it between the check and the rename.
    // That is a lost race, not a host failure, and it is reported as a conflict so the caller can retry deliberately.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return installFailure("conflict", "the installed directory was replaced by another request");
    return installFailure("unknown", "the replaced directory could not be backed up: " + (error instanceof Error ? error.message : String(error)));
  }
  return { ok: true, value: target };
}

/** Inspect one installed directory on the local host. A missing or linked directory is reported, never followed. */
async function inspectLocalDirectory(scopeRoot: string, directory: string): Promise<InstallResult<DirectoryInspection>> {
  if (!INSTALL_DIRECTORY_PATTERN.test(directory)) return installFailure("invalid", "a skill directory name is a lowercase slug");
  const path = join(scopeRoot, directory);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return installFailure("not_found", "no installed directory at " + path);
  if (info.isSymbolicLink() || !info.isDirectory()) return installFailure("permission_denied", "the installed directory is not a directory this host can inspect");
  const files = await directoryDigests(path);
  return { ok: true, value: { path: await realpath(path), files, contentHash: folderContentHash(files) } };
}

/**
 * Set or clear the \`disable-model-invocation\` key on one installed skill's own document. The edit is confined exactly
 * like a publication — the same scope root, the same slug, a document that must be a regular file — and it takes the
 * same per-destination lock as a replacement, so an edit cannot read a directory that is being exchanged underneath it.
 * A document already in the requested state is not written at all, so its mtime is untouched; a document whose
 * frontmatter cannot be edited honestly is refused rather than rewritten into something the loader would drop.
 */
async function toggleLocalSkill(scopeRoot: string, directory: string, disableModelInvocation: boolean): Promise<InstallResult<ToggledSkill>> {
  if (!INSTALL_DIRECTORY_PATTERN.test(directory)) return installFailure("invalid", "a skill directory name is a lowercase slug");
  return await serialized(join(await realpath(scopeRoot).catch(() => scopeRoot), directory), async (): Promise<InstallResult<ToggledSkill>> => {
    const path = join(scopeRoot, directory);
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return installFailure("not_found", "no installed directory at " + path);
    if (info.isSymbolicLink() || !info.isDirectory()) return installFailure("permission_denied", "the installed directory is not a directory this host can edit");
    const document = join(path, "SKILL.md");
    const documentInfo = await lstat(document).catch(() => undefined);
    if (documentInfo === undefined) return installFailure("not_found", "no skill document at " + document);
    if (documentInfo.isSymbolicLink() || !documentInfo.isFile()) return installFailure("permission_denied", "the skill document is not a regular file this host can edit");
    const content = await readFile(document, "utf8");
    let updated: string;
    try {
      updated = setDisableModelInvocation(content, disableModelInvocation);
    } catch (error) {
      return installFailure("invalid", "the skill document's frontmatter cannot be edited: " + (error instanceof Error ? error.message : String(error)));
    }
    if (updated === content) return { ok: true, value: { changed: false } };
    // The document is replaced through a temporary file in its own directory, so a reader never sees a half-written
    // skill and the previous content stays readable until the rename.
    const temporary = join(path, "." + basename(document) + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, updated, { encoding: "utf8", mode: documentInfo.mode & 0o777 });
      await rename(temporary, document);
    } catch (error) {
      await rm(temporary, { force: true });
      return installFailure("unknown", "the skill document could not be written: " + (error instanceof Error ? error.message : String(error)));
    }
    return { ok: true, value: { changed: true } };
  });
}

export type LocalInstallOptions = { readonly identity?: ExecutionHostIdentity };

/**
 * One workspace's installation server: the execution account's own home, or the workspace's project directory.
 * Lock records are serialized per lock path, because two concurrent read-merge-write cycles would otherwise each
 * write a document that lacks the other's entry.
 */
export class LocalInstallServer implements InstallServer {
  /** The gateway's shared registry, so a workspace registered at runtime can be installed into at once. */
  readonly workspaces: WorkspaceRegistry;
  readonly #identity: ExecutionHostIdentity;

  constructor(workspaces: WorkspaceRegistry, options: LocalInstallOptions = {}) {
    this.workspaces = workspaces;
    this.#identity = options.identity ?? localExecutionHostIdentity();
  }

  async execute(request: InstallRequest): Promise<InstallResult> {
    const workspace = this.workspaces.get(request.workspaceId);
    if (workspace === undefined) return installFailure("permission_denied", "unknown workspace");
    const scope = await confinedScopeRoot(request.scope, workspace.root, this.#identity.home);
    if (!scope.ok) return scope;
    try {
      switch (request.operation) {
        case "publishDirectory": return await this.#publish(scope.value, request.directory, request.files, request.overwrite === true, request.expect);
        case "inspectDirectory": return await inspectLocalDirectory(scope.value, request.directory);
        case "readLock": return await readLocalLock(scope.value);
        case "recordInstall": return await recordLocalInstall(scope.value, request.name, request.entry);
        case "toggleSkill": return await toggleLocalSkill(scope.value, request.directory, request.disableModelInvocation);
      }
    } catch (error) {
      // A host failure is reported as a result, never as a rejection: the RPC layer must not turn it into a 500.
      return installFailure("unknown", "the installation host failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  /** Stage every file inside a fresh sibling directory, then publish the directory with one rename. */
  async #publish(scopeRoot: string, directory: string, files: readonly PublishFile[], overwrite: boolean, expect?: ExpectedDigests): Promise<InstallResult<PublishedDirectory>> {
    if (!INSTALL_DIRECTORY_PATTERN.test(directory)) return installFailure("invalid", "a skill directory name is a lowercase slug");
    for (const file of files) {
      if (!safeInstallPath(file.path)) return installFailure("invalid", "bundle file paths stay inside the skill directory: " + file.path);
      if (typeof file.content !== "string" || (file.encoding !== "utf8" && file.encoding !== "base64")) return installFailure("invalid", "a bundle file is utf8 text or base64 bytes");
    }
    const destination = join(scopeRoot, directory);
    const staging = await mkdtemp(join(scopeRoot, ".hepi-install-"));
    const abandon = async <T>(failure: InstallResult<T>): Promise<InstallResult<T>> => { await rm(staging, { recursive: true, force: true }); return failure; };
    try {
      for (const file of files) {
        const target = join(staging, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"));
      }
      // The mutation boundary — re-read the destination, move it aside, publish — is serialized per canonical
      // destination, so two replacements of one directory cannot both check it, both move it aside and both publish.
      // The queue is module-wide, so it covers every server instance in this process and both scopes; a second writer
      // in another process is still refused by the rename itself.
      return await serialized(join(await realpath(scopeRoot), directory), async (): Promise<InstallResult<PublishedDirectory>> => {
        // The destination is re-read here, immediately before it is replaced, and a confirmed replacement is checked
        // against the directory the caller actually inspected. An edit that arrived while this request was staging is
        // therefore refused, never silently discarded.
        const present = await lstat(destination).catch(() => undefined);
        if (present !== undefined && !overwrite) return await abandon(installFailure("conflict", "a skill directory already exists at " + destination));
        if (present !== undefined && expect !== undefined) {
          if (present.isSymbolicLink() || !present.isDirectory()) return await abandon(installFailure("conflict", "the installed directory is no longer a directory that can be replaced"));
          if (!sameDigests(await directoryDigests(destination), expect)) return await abandon(installFailure("conflict", "the installed directory changed since it was inspected"));
        }
        let backup: string | undefined;
        if (present !== undefined) {
          const moved = await moveToBackup(scopeRoot, destination, directory);
          if (!moved.ok) return await abandon(moved);
          backup = moved.value;
        }
        try {
          await rename(staging, destination);
        } catch (error) {
          // The replaced directory goes back: a failed publish must not leave the destination missing.
          if (backup !== undefined) await rename(backup, destination).catch(() => undefined);
          return await abandon(installFailure("unknown", "the skill directory could not be published: " + (error instanceof Error ? error.message : String(error))));
        }
        // The published directory must be the one that was staged: a destination that resolves elsewhere is not accepted.
        // A destination that is simply gone was replaced by a concurrent request; that is a lost race, not a host failure.
        const realDestination = await realpath(destination).catch(() => undefined);
        const finalInfo = realDestination === undefined ? undefined : await lstat(realDestination).catch(() => undefined);
        if (realDestination === undefined || finalInfo === undefined) return installFailure("conflict", "the installed directory was replaced by another request");
        if (dirname(realDestination) !== scopeRoot || finalInfo.isSymbolicLink()) return installFailure("permission_denied", "the published directory did not stay inside " + scopeRoot);
        return { ok: true, value: { path: realDestination, files: files.map((file) => file.path), ...(backup === undefined ? {} : { backup }) } };
      });
    } catch (error) {
      // A failure outside the boundary leaves nothing staged, and a failure inside it has already cleaned up its own.
      await rm(staging, { recursive: true, force: true });
      return installFailure("unknown", "the skill directory could not be published: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}

/** The lock file itself must be a regular file: a link is refused, so a lock cannot be redirected elsewhere. */
async function lockTarget(path: string): Promise<InstallResult<string | undefined>> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return { ok: true, value: undefined };
  if (info.isSymbolicLink() || !info.isFile()) return installFailure("invalid", "the install lock at " + path + " is not a regular file");
  return { ok: true, value: path };
}

/** One scope's lock, or nothing when no installation has ever recorded one. A corrupt lock is an explicit failure. */
async function readLocalLock(scopeRoot: string): Promise<InstallResult<InstallLockDocument | undefined>> {
  const path = installLockPath(scopeRoot);
  const target = await lockTarget(path);
  if (!target.ok) return target;
  if (target.value === undefined) return { ok: true, value: undefined };
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return installFailure("invalid", "the install lock at " + path + " is not valid JSON"); }
  if (!validLockDocument(parsed)) return installFailure("invalid", "the install lock at " + path + " is not a lock document this gateway can extend");
  return { ok: true, value: parsed };
}

/**
 * Read, merge one entry and write the lock back through a temporary file in the same directory. Records of one lock
 * path are serialized: without that, two concurrent installations each merge against the same document and the later
 * write drops the earlier entry.
 */
async function recordLocalInstall(scopeRoot: string, name: string, entry: InstallLockEntry): Promise<InstallResult<InstallLockDocument>> {
  if (!INSTALL_DIRECTORY_PATTERN.test(name)) return installFailure("invalid", "a skill name is a lowercase slug");
  if (!validLockEntry(entry)) return installFailure("invalid", "the install record is not a lock entry");
  const path = installLockPath(scopeRoot);
  return await serialized(path, async () => {
    const existing = await readLocalLock(scopeRoot);
    if (!existing.ok) return existing;
    const document: InstallLockDocument = { version: 1, skills: { ...(existing.value?.skills ?? {}), [name]: entry } };
    const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      return installFailure("unknown", "the install lock could not be written: " + (error instanceof Error ? error.message : String(error)));
    }
    return { ok: true, value: document };
  });
}

/** One lock path is written by one read-merge-write at a time, whichever caller asked for it. */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = LocalInstallServerQueue.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  LocalInstallServerQueue.set(key, next.catch(() => undefined));
  return await next;
}
const LocalInstallServerQueue = new Map<string, Promise<unknown>>();

/**
 * The remote helper for installations: a self-contained Python 3 program, sent over the existing SSH runner as one
 * argv word, that publishes a staged directory, inspects an installed one and stores the scope lock. It runs on the
 * host, so the gateway machine writes nothing and the host needs Python 3 and nothing else. Every path it touches is
 * derived from the scope root it resolves itself and confined to the account's canonical home or the profile's
 * canonical workspace root, so no request can name a destination outside an installation scope.
 */
export const REMOTE_INSTALL_SCRIPT = [
  "import base64, fcntl, hashlib, json, os, pwd, re, shutil, sys, tempfile, time",
  "",
  "def emit(value):",
  "    sys.stdout.write(json.dumps(value))",
  "    sys.exit(0)",
  "",
  "def fail(code, message):",
  "    emit({\"ok\": False, \"error\": {\"code\": code, \"message\": message}})",
  "",
  "def account_home():",
  "    try:",
  "        entry = pwd.getpwuid(os.getuid())",
  "        name, home = entry.pw_name, entry.pw_dir",
  "    except Exception as error:",
  "        fail(\"unknown\", \"the remote host did not report the execution account: \" + str(error))",
  "    if not name or not home:",
  "        fail(\"unknown\", \"the remote host reported an incomplete execution account\")",
  "    return os.path.realpath(home)",
  "",
  "def authorized_root(scope):",
  "    if scope == \"global\":",
  "        return account_home()",
  "    if scope == \"workspace\":",
  "        return root",
  "    fail(\"invalid\", \"unknown installation scope: \" + scope)",
  "",
  "def within(parent, child):",
  "    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)",
  "",
  "def confined_scope(scope):",
  "    base = authorized_root(scope)",
  "    current = base",
  "    for part in (\".agents\", \"skills\"):",
  "        nxt = os.path.join(current, part)",
  "        if not os.path.lexists(nxt):",
  "            os.makedirs(nxt, exist_ok=True)",
  "            current = os.path.realpath(nxt)",
  "            continue",
  "        real = os.path.realpath(nxt)",
  "        if not within(base, real):",
  "            fail(\"permission_denied\", \"the installation scope resolves outside \" + base)",
  "        current = real",
  "    return current",
  "",
  "def lock_path(scope):",
  "    return os.path.join(os.path.dirname(confined_scope(scope)), \".skill-lock.json\")",
  "",
  "def move_to_backup(scope_root, destination, directory):",
  "    parent = os.path.dirname(scope_root)",
  "    real_parent = os.path.realpath(parent)",
  "    if real_parent != parent:",
  "        fail(\"permission_denied\", \"the backup location resolves outside \" + parent)",
  "    target = os.path.join(parent, directory + BACKUP_SUFFIX)",
  "    counter = 1",
  "    while os.path.lexists(target):",
  "        target = os.path.join(real_parent, directory + \".\" + str(counter) + BACKUP_SUFFIX)",
  "        counter += 1",
  "    try:",
  "        os.rename(destination, target)",
  "    except FileNotFoundError:",
  "        fail(\"conflict\", \"the installed directory was replaced by another request\")",
  "    return target",
  "",
  "def slug(value, what):",
  "    if not value or len(value) > 64 or re.match(r\"^[a-z0-9][a-z0-9-]*$\", value) is None:",
  "        fail(\"invalid\", \"a skill \" + what + \" is a lowercase slug\")",
  "    return value",
  "",
  "def rel_parts(path):",
  "    if not path or len(path) > 256 or path.startswith(\"/\") or \"\\\\\" in path or path.endswith(\"/\"):",
  "        fail(\"invalid\", \"bundle file paths stay inside the skill directory: \" + path)",
  "    parts = path.split(\"/\")",
  "    if any(part in (\"\", \".\", \"..\") for part in parts):",
  "        fail(\"invalid\", \"bundle file paths stay inside the skill directory: \" + path)",
  "    last = parts[-1]",
  "    if (last == \"SKILL.md\" and len(parts) != 1) or (last != \"SKILL.md\" and last.lower() == \"skill.md\"):",
  "        fail(\"invalid\", \"bundle file paths stay inside the skill directory: \" + path)",
  "    return parts",
  "",
  "def known_staging(staging):",
  "    real = os.path.realpath(staging)",
  "    if not os.path.basename(real).startswith(\".hepi-install-\") or not os.path.isdir(real):",
  "        fail(\"invalid\", \"unknown install staging directory\")",
  "    for scope in (\"global\", \"workspace\"):",
  "        if os.path.dirname(real) == confined_scope(scope):",
  "            return real",
  "    fail(\"invalid\", \"unknown install staging directory\")",
  "",
  "def valid_entry(entry):",
  "    if not isinstance(entry, dict):",
  "        return False",
  "    if not isinstance(entry.get(\"source\"), str) or entry[\"source\"] == \"\":",
  "        return False",
  "    if entry.get(\"sourceType\") not in (\"repository\", \"github\", \"local\"):",
  "        return False",
  "    skill_path = entry.get(\"skillPath\")",
  "    if not isinstance(skill_path, str) or not skill_path.startswith(\"/\"):",
  "        return False",
  "    if entry.get(\"scope\") not in (\"global\", \"workspace\"):",
  "        return False",
  "    installed = entry.get(\"installedAtMs\")",
  "    if not isinstance(installed, (int, float)) or isinstance(installed, bool):",
  "        return False",
  "    if re.match(r\"^[0-9a-f]{64}$\", str(entry.get(\"contentHash\"))) is None:",
  "        return False",
  "    files = entry.get(\"files\")",
  "    if not isinstance(files, dict) or not files:",
  "        return False",
  "    for path, value in files.items():",
  "        if re.match(r\"^[0-9a-f]{64}$\", str(value)) is None:",
  "            return False",
  "        try:",
  "            rel_parts(path)",
  "        except SystemExit:",
  "            return False",
  "    return True",
  "",
  "def lock_file(scope):",
  "    path = lock_path(scope)",
  "    if os.path.islink(path) or (os.path.lexists(path) and not os.path.isfile(path)):",
  "        fail(\"invalid\", \"the install lock at \" + path + \" is not a regular file\")",
  "    return path",
  "",
  "def read_lock(scope):",
  "    path = lock_file(scope)",
  "    if not os.path.exists(path):",
  "        return None",
  "    try:",
  "        with open(path, \"r\", encoding=\"utf-8\") as handle:",
  "            document = json.load(handle)",
  "    except (OSError, ValueError):",
  "        fail(\"invalid\", \"the install lock at \" + path + \" is not a lock document this gateway can extend\")",
  "    if not isinstance(document, dict) or document.get(\"version\") != 1 or not isinstance(document.get(\"skills\"), dict):",
  "        fail(\"invalid\", \"the install lock at \" + path + \" is not a lock document this gateway can extend\")",
  "    for name, entry in document[\"skills\"].items():",
  "        if re.match(r\"^[a-z0-9][a-z0-9-]*$\", name) is None or not valid_entry(entry):",
  "            fail(\"invalid\", \"the install lock at \" + path + \" holds an entry this gateway cannot extend\")",
  "    return document",
  "",
  "def digest_file(path):",
  "    hasher = hashlib.sha256()",
  "    with open(path, \"rb\") as handle:",
  "        for chunk in iter(lambda: handle.read(65536), b\"\"):",
  "            hasher.update(chunk)",
  "    return hasher.hexdigest()",
  "",
  "def directory_digests(base):",
  "    entries = {}",
  "    for current, directories, names in os.walk(base):",
  "        directories.sort()",
  "        for name in sorted(names) + sorted(directories):",
  "            path = os.path.join(current, name)",
  "            key = os.path.relpath(path, base).replace(os.sep, \"/\")",
  "            if os.path.islink(path):",
  "                entries[key] = \"link:\" + hashlib.sha256(os.readlink(path).encode(\"utf-8\")).hexdigest()",
  "            elif os.path.isdir(path):",
  "                continue",
  "            elif os.path.isfile(path):",
  "                entries[key] = digest_file(path)",
  "            else:",
  "                entries[key] = \"other\"",
  "    return entries",
  "",
  "def folder_hash(entries):",
  "    hasher = hashlib.sha256()",
  "    for path in sorted(entries):",
  "        hasher.update((path + \"\\u0000\" + entries[path] + \"\\n\").encode(\"utf-8\"))",
  "    return hasher.hexdigest()",
  "",
  "# The one frontmatter edit the installation capability makes, transcribed from src/skill-frontmatter.ts so the two",
  "# hosts write the same bytes: a surgical line edit inside the frontmatter block, the document's own key found by",
  "# indentation rather than by a YAML parser (this helper is stdlib Python), an explicit false replaced in place, an",
  "# already-set key leaving the file untouched, and a shape no top-level key can be added to refused, never corrupted.",
  "FRONTMATTER_KEY = " + JSON.stringify("disable-model-invocation"),
  "FRONTMATTER_BREAK = re.compile(r\"\\r\\n|\\n|\\r\")",
  "FRONTMATTER_OPENING = re.compile(r\"^\\ufeff?---[ \\t]*(\\r\\n|\\n|\\r)\", re.S)",
  "FRONTMATTER_CLOSING = re.compile(r\"(^|\\r\\n|\\n|\\r)---\", re.S)",
  "FRONTMATTER_KEY_LINE = re.compile(r\"^([ \\t]*)((?:\\\"\" + FRONTMATTER_KEY + r\"\\\"|'\" + FRONTMATTER_KEY + r\"'|\" + FRONTMATTER_KEY + r\")[ \\t]*:)([^\\r\\n]*)$\")",
  "FRONTMATTER_ANY_KEY = re.compile(r\"^[ \\t]*(?:[^ \\t:\\r\\n]+|\\\"[^\\\"\\r\\n]+\\\"|'[^'\\r\\n]+')[ \\t]*:\")",
  "FRONTMATTER_LINE = re.compile(r\"[^\\r\\n]*?(\\r\\n|\\n|\\r|$)\", re.S)",
  "",
  "def frontmatter_lines(head):",
  "    lines = []",
  "    position = 0",
  "    while position < len(head):",
  "        match = FRONTMATTER_LINE.match(head, position)",
  "        if match is None:",
  "            break",
  "        span = match.span()",
  "        if span[1] <= span[0]:",
  "            break",
  "        text = match.group(0)",
  "        lines.append((FRONTMATTER_BREAK.sub(\"\", text, count=1), span[0], span[1]))",
  "        position = span[1]",
  "    return lines",
  "",
  "def frontmatter_shape(lines):",
  "    indentation = lambda text: len(re.match(r\"^[ \\t]*\", text).group(0))",
  "    filled = [line for line in lines if line[0].strip() != \"\" and not line[0].strip().startswith(\"#\")]",
  "    if not filled:",
  "        return 0, []",
  "    keys = [line for line in filled if FRONTMATTER_ANY_KEY.match(line[0])]",
  "    if not keys:",
  "        return None",
  "    base = min(indentation(line[0]) for line in keys)",
  "    at_base = [line for line in filled if indentation(line[0]) == base]",
  "    if any(not FRONTMATTER_ANY_KEY.match(line[0]) for line in at_base):",
  "        return None",
  "    own = [line for line in at_base if FRONTMATTER_KEY_LINE.match(line[0])]",
  "    if len(own) > 1:",
  "        return None",
  "    return base, own",
  "",
  "def set_frontmatter_key(content, disable):",
  "    # The document itself when it already holds the requested state, so the host writes nothing and its mtime is",
  "    # untouched. The same rules as the local host's src/skill-frontmatter.ts, transcribed for a stdlib-only host.",
  "    opening = FRONTMATTER_OPENING.match(content)",
  "    if opening is None:",
  "        if not disable:",
  "            return content",
  "        starts = content.startswith(\"---\", 1) if content.startswith(\"\\ufeff\") else content.startswith(\"---\")",
  "        if starts:",
  "            fail(\"invalid\", \"the skill document's frontmatter cannot be edited\")",
  "        bom = \"\\ufeff\" if content.startswith(\"\\ufeff\") else \"\"",
  "        body = content[1:] if bom else content",
  "        return bom + \"---\\n\" + FRONTMATTER_KEY + \": true\\n---\\n\" + body",
  "    rest = content[opening.end():]",
  "    closing = FRONTMATTER_CLOSING.search(rest)",
  "    if closing is None:",
  "        fail(\"invalid\", \"the skill document's frontmatter cannot be edited\")",
  "    opening_end = opening.end()",
  "    head = content[opening_end:opening_end + closing.start() + len(closing.group(1))]",
  "    shape = frontmatter_shape(frontmatter_lines(head))",
  "    if shape is None:",
  "        fail(\"invalid\", \"the skill document's frontmatter cannot be edited\")",
  "    base, own = shape",
  "    if not own:",
  "        if not disable:",
  "            return content",
  "        return content[:opening_end] + \" \" * base + FRONTMATTER_KEY + \": true\" + opening.group(1) + content[opening_end:]",
  "    text, start, end = own[0]",
  "    if disable:",
  "        # The line break that ended the key line travels with its span, so it is carried over explicitly and the",
  "        # next line keeps exactly one break in front of it, as the local host's edit does.",
  "        replacement = FRONTMATTER_KEY_LINE.sub(lambda match: match.group(1) + match.group(2) + \" true\", text, count=1) + head[start + len(text):end]",
  "    else:",
  "        # Clearing drops the key's whole line, break included: the line before it already ends in its own break, so",
  "        # nothing is left behind and no blank line appears where the key was.", 
  "        replacement = \"\"",
  "    return content[:opening_end] + head[:start] + replacement + head[end:] + content[opening_end + len(head):]",
  "",
  "def toggle_document(scope, directory, disable):",
  "    real_scope = confined_scope(scope)",
  "    path = os.path.join(real_scope, directory)",
  "    if not os.path.lexists(path):",
  "        fail(\"not_found\", \"no installed directory at \" + path)",
  "    if os.path.islink(path) or not os.path.isdir(path):",
  "        fail(\"permission_denied\", \"the installed directory is not a directory this host can edit\")",
  "    document = os.path.join(path, \"SKILL.md\")",
  "    if not os.path.lexists(document):",
  "        fail(\"not_found\", \"no skill document at \" + document)",
  "    if os.path.islink(document) or not os.path.isfile(document):",
  "        fail(\"permission_denied\", \"the skill document is not a regular file this host can edit\")",
  "    # The same guard a replacement of this directory takes, so an edit cannot read a directory being exchanged.",
  "    guard = open(os.path.join(os.path.dirname(real_scope), \".hepi-publish-\" + directory + \".lock\"), \"a+\")",
  "    fcntl.flock(guard.fileno(), fcntl.LOCK_EX)",
  "    try:",
  "        # newline=\"\" keeps the document's own line endings: text mode would otherwise rewrite CRLF on the way in",
  "        # and out, and the edit would not be byte for byte the one the local host makes.",
  "        with open(document, \"r\", encoding=\"utf-8\", newline=\"\") as handle:",
  "            content = handle.read()",
  "        updated = set_frontmatter_key(content, disable)",
  "        # A document already in the requested state is not written at all: its mtime stays as the loader left it.",
  "        if updated == content:",
  "            emit({\"ok\": True, \"value\": {\"changed\": False}})",
  "        handle_out, temporary = tempfile.mkstemp(prefix=\".SKILL-\", suffix=\".tmp\", dir=path)",
  "        mode = os.stat(document).st_mode",
  "        with os.fdopen(handle_out, \"w\", encoding=\"utf-8\", newline=\"\") as out:",
  "            out.write(updated)",
  "            out.flush()",
  "            os.fsync(out.fileno())",
  "        os.chmod(temporary, mode)",
  "        os.replace(temporary, document)",
  "    finally:",
  "        fcntl.flock(guard.fileno(), fcntl.LOCK_UN)",
  "        guard.close()",
  "    emit({\"ok\": True, \"value\": {\"changed\": True}})",
  "",
  "BACKUP_SUFFIX = " + JSON.stringify(BACKUP_SUFFIX),
  "root = os.path.realpath(sys.argv[1])",
  "mode = sys.argv[2]",
  "args = sys.argv[3:]",
  "",
  "try:",
  "    if mode == \"publish_begin\":",
  "        scope = args[0]",
  "        directory = slug(args[1], \"directory name\")",
  "        overwrite = args[2] == \"1\"",
  "        expect = json.loads(base64.b64decode(args[3]).decode(\"utf-8\")) if args[3] else None",
  "        real_scope = confined_scope(scope)",
  "        destination = os.path.join(real_scope, directory)",
  "        if os.path.lexists(destination) and not overwrite:",
  "            fail(\"conflict\", \"a skill directory already exists at \" + destination)",
  "        staging = tempfile.mkdtemp(prefix=\".hepi-install-\", dir=real_scope)",
  "        emit({\"ok\": True, \"value\": {\"staging\": staging, \"destination\": destination}})",
  "    elif mode == \"publish_file\":",
  "        staging = known_staging(args[0])",
  "        parts = rel_parts(args[1])",
  "        data = base64.b64decode(args[2], validate=True)",
  "        current = staging",
  "        for part in parts[:-1]:",
  "            current = os.path.join(current, part)",
  "            if os.path.islink(current):",
  "                fail(\"permission_denied\", \"refusing to write through a symbolic link\")",
  "            os.makedirs(current, exist_ok=True)",
  "        target = os.path.join(current, parts[-1])",
  "        if os.path.islink(target):",
  "            fail(\"permission_denied\", \"refusing to write through a symbolic link\")",
  "        with open(target, \"ab\" if args[3] == \"1\" else \"wb\") as handle:",
  "            handle.write(data)",
  "        real = os.path.realpath(target)",
  "        if real != staging and not within(staging, real):",
  "            fail(\"permission_denied\", \"the staged file did not stay inside the staging directory\")",
  "        emit({\"ok\": True})",
  "    elif mode == \"publish_commit\":",
  "        staging = known_staging(args[0])",
  "        scope = args[1]",
  "        directory = slug(args[2], \"directory name\")",
  "        expect = json.loads(base64.b64decode(args[3]).decode(\"utf-8\")) if len(args) > 3 and args[3] else None",
  "        real_scope = confined_scope(scope)",
  "        destination = os.path.join(real_scope, directory)",
  "        backup = None",
  "        # The mutation boundary - re-read the destination, move it aside, publish - is serialized per destination",
  "        # across helper processes with an exclusive lock on a sidecar guard. This helper exits immediately after it",
  "        # emits, so the lock is held for exactly this critical section and the operating system releases it.",
  "        guard = open(os.path.join(os.path.dirname(real_scope), \".hepi-publish-\" + directory + \".lock\"), \"a+\")",
  "        fcntl.flock(guard.fileno(), fcntl.LOCK_EX)",
  "        # The destination is re-read here, immediately before it is replaced, so an edit that arrived while this",
  "        # request was staging is refused instead of being silently discarded.",
  "        if os.path.lexists(destination):",
  "            if expect is not None:",
  "                if os.path.islink(destination) or not os.path.isdir(destination):",
  "                    fail(\"conflict\", \"the installed directory is no longer a directory that can be replaced\")",
  "                if directory_digests(destination) != expect:",
  "                    fail(\"conflict\", \"the installed directory changed since it was inspected\")",
  "            backup = move_to_backup(real_scope, destination, directory)",
  "        try:",
  "            os.rename(staging, destination)",
  "        except OSError:",
  "            if backup is not None and not os.path.lexists(destination):",
  "                os.rename(backup, destination)",
  "            raise",
  "        real = os.path.realpath(destination)",
  "        if os.path.dirname(real) != real_scope or os.path.islink(destination):",
  "            fail(\"permission_denied\", \"the published directory did not stay inside \" + real_scope)",
  "        emit({\"ok\": True, \"value\": {\"path\": real, \"backup\": backup}})",
  "    elif mode == \"publish_abort\":",
  "        shutil.rmtree(known_staging(args[0]), ignore_errors=True)",
  "        emit({\"ok\": True})",
  "    elif mode == \"inspect\":",
  "        scope = args[0]",
  "        directory = slug(args[1], \"directory name\")",
  "        path = os.path.join(confined_scope(scope), directory)",
  "        if not os.path.lexists(path):",
  "            fail(\"not_found\", \"no installed directory at \" + path)",
  "        if os.path.islink(path) or not os.path.isdir(path):",
  "            fail(\"permission_denied\", \"the installed directory is not a directory this host can inspect\")",
  "        entries = directory_digests(path)",
  "        emit({\"ok\": True, \"value\": {\"path\": os.path.realpath(path), \"files\": entries, \"contentHash\": folder_hash(entries)}})",
  "    elif mode == \"toggle\":",
  "        toggle_document(args[0], slug(args[1], \"directory name\"), args[2] == \"1\")",
  "    elif mode == \"lock_read\":",
  "        emit({\"ok\": True, \"value\": read_lock(args[0])})",
  "    elif mode == \"lock_record\":",
  "        scope = args[0]",
  "        name = slug(args[1], \"name\")",
  "        entry = json.loads(base64.b64decode(args[2]).decode(\"utf-8\"))",
  "        if not valid_entry(entry):",
  "            fail(\"invalid\", \"the install record is not a lock entry\")",
  "        path = lock_file(scope)",
  "        os.makedirs(os.path.dirname(path), exist_ok=True)",
  "        guard = open(path + \".lock\", \"a+\")",
  "        fcntl.flock(guard.fileno(), fcntl.LOCK_EX)",
  "        try:",
  "            document = read_lock(scope) or {\"version\": 1, \"skills\": {}}",
  "            document[\"skills\"][name] = entry",
  "            handle, temporary = tempfile.mkstemp(prefix=\".skill-lock-\", suffix=\".tmp\", dir=os.path.dirname(path))",
  "            with os.fdopen(handle, \"w\", encoding=\"utf-8\") as out:",
  "                json.dump(document, out, indent=2)",
  "                out.write(\"\\n\")",
  "                out.flush()",
  "                os.fsync(out.fileno())",
  "            os.chmod(temporary, 0o600)",
  "            os.replace(temporary, path)",
  "        finally:",
  "            fcntl.flock(guard.fileno(), fcntl.LOCK_UN)",
  "            guard.close()",
  "        emit({\"ok\": True, \"value\": document})",
  "    else:",
  "        fail(\"not_supported\", \"unknown installation operation: \" + mode)",
  "except OSError as error:",
  "    fail(\"unknown\", str(error))",
  "except ValueError as error:",
  "    fail(\"invalid\", str(error))",
  "",
].join("\n");

const REMOTE_INSTALL_BASE64 = Buffer.from(REMOTE_INSTALL_SCRIPT, "utf8").toString("base64");
/** ssh hands the command to the remote shell, so the program travels as one argv word and sys.argv is restored. */
const REMOTE_BOOTSTRAP = "import base64,sys;src=base64.b64decode(sys.argv[1]);sys.argv=[sys.argv[0]]+sys.argv[2:];exec(compile(src,'hepi-install','exec'))";

/** Bytes of one base64 chunk per publish_file call; a remote shell accepts roughly 128 KiB per argument. */
const WRITE_CHUNK_BYTES = 32 * 1024;
const SSH_INSTALL_TIMEOUT_MS = 60_000;

export type SshInstallOptions = {
  readonly profiles: readonly SshProfile[];
  readonly runner: SshRunner;
  /**
   * The gateway's shared registry. Given, a folder registered at runtime installs into its own root on the profile it
   * was registered with, instead of every request being pinned to the profile's configured \`remoteRoot\`.
   */
  readonly workspaces: WorkspaceRegistry;
};

/**
 * One SSH host's installation server. It resolves the account, the scope root and the destination on the host itself,
 * so the gateway never guesses a remote home directory, and a host that cannot report its account fails explicitly.
 */
export class SshInstallServer implements InstallServer {
  readonly #profiles: ReadonlyMap<string, SshProfile>;
  readonly #workspaces: WorkspaceRegistry;
  readonly #runner: SshRunner;

  constructor(options: SshInstallOptions) {
    this.#profiles = new Map(options.profiles.map((profile) => [profile.id, profile]));
    this.#workspaces = options.workspaces;
    this.#runner = options.runner;
  }

  async execute(request: InstallRequest): Promise<InstallResult> {
    // The registry owns the id-to-root mapping, so an installation names the same root execution and files serve.
    const owner = workspaceOwner(this.#workspaces, this.#profiles, request.workspaceId);
    if (owner === undefined) return installFailure("permission_denied", "unknown workspace");
    const profile = owner.profile;
    switch (request.operation) {
      case "publishDirectory": return await this.#publish(profile, owner.root, request.scope, request.directory, request.files, request.overwrite === true, request.expect);
      case "inspectDirectory": return await this.#call(profile, owner.root, ["inspect", request.scope, request.directory]);
      case "readLock": return await this.#call(profile, owner.root, ["lock_read", request.scope]);
      case "toggleSkill": return await this.#call(profile, owner.root, ["toggle", request.scope, request.directory, request.disableModelInvocation ? "1" : "0"]);
      case "recordInstall": {
        const entry = Buffer.from(JSON.stringify(request.entry), "utf8").toString("base64");
        return await this.#call(profile, owner.root, ["lock_record", request.scope, request.name, entry]);
      }
    }
  }

  /** Stage each file in a sibling directory on the host, then publish the directory with one remote rename. */
  async #publish(profile: SshProfile, root: string, scope: InstallScope, directory: string, files: readonly PublishFile[], overwrite: boolean, expect?: ExpectedDigests): Promise<InstallResult<PublishedDirectory>> {
    if (!INSTALL_DIRECTORY_PATTERN.test(directory)) return installFailure("invalid", "a skill directory name is a lowercase slug");
    for (const file of files) {
      if (!safeInstallPath(file.path)) return installFailure("invalid", "bundle file paths stay inside the skill directory: " + file.path);
      if (typeof file.content !== "string" || (file.encoding !== "utf8" && file.encoding !== "base64")) return installFailure("invalid", "a bundle file is utf8 text or base64 bytes");
    }
    const expectArg = expect === undefined ? "" : Buffer.from(JSON.stringify(expect), "utf8").toString("base64");
    const begun = await this.#call(profile, root, ["publish_begin", scope, directory, overwrite ? "1" : "0", expectArg]);
    if (!begun.ok) return begun;
    const staging = String((begun.value as { staging: string }).staging);
    for (const file of files) {
      const bytes = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
      // An empty file still needs one publish_file call: a byte-count loop would send none, and the file would be
      // missing on the host while the response and the recorded baseline both claimed it.
      const chunks = Math.max(1, Math.ceil(bytes.byteLength / WRITE_CHUNK_BYTES));
      for (let index = 0; index < chunks; index += 1) {
        const offset = index * WRITE_CHUNK_BYTES;
        const chunk = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES).toString("base64");
        const written = await this.#call(profile, root, ["publish_file", staging, file.path, chunk, index === 0 ? "0" : "1"]);
        if (!written.ok) { await this.#call(profile, root, ["publish_abort", staging]); return written; }
      }
    }
    const committed = await this.#call(profile, root, ["publish_commit", staging, scope, directory, expect === undefined ? "" : Buffer.from(JSON.stringify(expect), "utf8").toString("base64")]);
    if (!committed.ok) { await this.#call(profile, root, ["publish_abort", staging]); return committed; }
    const published = committed.value as { path: string; backup?: string | null };
    return { ok: true, value: { path: String(published.path), files: files.map((file) => file.path), ...(published.backup ? { backup: String(published.backup) } : {}) } };
  }

  /** One helper call. A transport failure is an unknown outcome: nothing is retried and nothing is reported as done. */
  async #call(profile: SshProfile, root: string, argv: readonly string[]): Promise<InstallResult> {
    let result: SshRunnerResult;
    try {
      result = await this.#runner.execute({ profile: profile.id, host: profile.host, cwd: root, root, port: profile.port, identityFile: profile.identityFile, knownHostsFile: profile.knownHostsFile, command: ["python3", "-c", REMOTE_BOOTSTRAP, REMOTE_INSTALL_BASE64, root, ...argv], timeoutMs: SSH_INSTALL_TIMEOUT_MS, signal: AbortSignal.timeout(SSH_INSTALL_TIMEOUT_MS) });
    } catch (error) {
      const code = (error as { code?: string }).code;
      return installFailure(code === "unreachable" ? "unknown" : "outcome_unknown", code === "unreachable" ? "ssh host unreachable" : "ssh installation outcome unknown");
    }
    if (result.exitCode === 127 || /python3: (command )?not found/i.test(result.stderr)) return installFailure("not_supported", "the SSH host needs Python 3 on PATH for gateway installation operations");
    if (result.exitCode !== 0) return installFailure("unknown", "remote installation failed: " + (result.stderr.trim() || "exit " + result.exitCode));
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { return installFailure("outcome_unknown", "the remote host returned no installation result"); }
    const payload = parsed as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
    if (payload.ok === true) return { ok: true, value: payload.value };
    const code = payload.error?.code;
    return installFailure(INSTALL_FAILURE_CODES.includes(code as InstallFailureCode) ? code as InstallFailureCode : "unknown", payload.error?.message ?? "remote installation failed");
  }
}

const INSTALL_FAILURE_CODES: readonly InstallFailureCode[] = ["conflict", "invalid", "not_found", "permission_denied", "aborted", "outcome_unknown", "not_supported", "unknown"];

/**
 * The installation surface a caller reaches over HTTP is `GatewayHostClient.control.installs`, which owns the route,
 * the bearer header, the bound and the meaning of a lost answer. Nothing here constructs a request of its own: this
 * module owns the host-side work of one installation, not the transport that carries it.
 */
