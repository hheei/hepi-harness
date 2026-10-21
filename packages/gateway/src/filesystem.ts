import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { chmod, lstat, open, readFile, readdir, realpath, mkdtemp, stat, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FileError, type BinaryReader, type FileErrorCode, type FileInfo, type LineScan } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ResourceIgnoreRules } from "./resource-ignore.ts";
import type { WorkspaceRegistry } from "./workspaces.ts";
import { CONTEXT_FILE_NAMES, findShadowedContextFile } from "./worktree-shadow.ts";

/** Largest payload one gateway filesystem request moves: text/binary reads, reader reads and writes, local or remote. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Idle lifetime of an open binary reader handle. Expiry is enforced on request, so no timer holds the process open. */
export const READER_TTL_MS = 5 * 60 * 1000;
/** Maximum open binary reader handles per filesystem; the least recently used handle is closed first. */
export const MAX_READERS = 64;

export type FileRequest = {
  workspaceId: string;
  method: string;
  path?: string;
  destinationPath?: string;
  content?: string;
  encoding?: "utf8" | "base64";
  size?: number;
  prefix?: string;
  suffix?: string;
  options?: { recursive?: boolean; force?: boolean; noFollow?: boolean; startLine?: number; endLine?: number; preserveMode?: boolean };
  handle?: string;
  offset?: number;
  length?: number;
  /**
   * A restricted resource surface this request is allowed to reach beyond the workspace. \`agent-definitions\` opens
   * the two agent definition directories of the host — the project's \`<workspace>/.pi/agents\` and the account's
   * \`<agent dir>/agents\` — for reading, and the account one for atomic mutation. It is a named capability, not a
   * general home write: a request without it stays confined to the workspace exactly as before.
   */
  resource?: "agent-definitions";
};

/**
 * The filesystem surface \`GatewayRpcServer\` serves on \`/v1/files\`. A local workspace and an SSH workspace implement it.
 * A dispatched mutation is never replayed: a lost response stays unknown to the caller instead of running twice.
 */
export type FilesystemServer = { execute(request: FileRequest): Promise<unknown>; close(): Promise<void> };

/**
 * The filesystem surface \`GatewayRpcServer\` accepts for \`/v1/files\`: any \`FilesystemServer\`, local or SSH. The type
 * stays structural so the RPC server can take either implementation, and the value keeps its existing import working.
 */
export type GatewayFiles = FilesystemServer;

/** Bounded reader operations the gateway exposes as \`reader.*\` methods; both filesystems implement this shape. */
export type GatewayReader = {
  info(): Promise<{ ok: true; value: FileInfo } | { ok: false; error: FileError }>;
  read(offset: number, length: number): Promise<{ ok: true; value: string } | { ok: false; error: FileError }>;
  scanLines(options: { startLine: number; endLine?: number }): Promise<{ ok: true; value: LineScan } | { ok: false; error: FileError }>;
};

/** A reader handle closes its resource when it is dropped; the remote helper's is stateless, so its close is optional. */
export type ReaderHandle<TReader extends { close?(context: Context): Promise<void> }> = { readonly workspaceId: string; readonly root: string; readonly reader: TReader; lastUsed: number };

/** Open reader handles with a count bound, an idle bound, and cleanup on shutdown. */
export class ReaderRegistry<TReader extends { close?(context: Context): Promise<void> }> {
  readonly handles = new Map<string, ReaderHandle<TReader>>();
  readonly #ttlMs: number;
  readonly #max: number;
  constructor(ttlMs: number, max: number) { this.#ttlMs = ttlMs; this.#max = max; }
  /** Close every handle idle for longer than the TTL. */
  reap(now = Date.now()): void {
    for (const [handle, item] of this.handles) if (now - item.lastUsed >= this.#ttlMs) this.#close(handle, item);
  }
  /** The handle when it exists and belongs to the workspace; touching it resets its idle time. */
  take(handle: string, workspaceId: string): ReaderHandle<TReader> | undefined {
    const item = this.handles.get(handle);
    if (item === undefined || item.workspaceId !== workspaceId) return undefined;
    item.lastUsed = Date.now();
    return item;
  }
  add(workspaceId: string, root: string, reader: TReader): string {
    this.reap();
    while (this.handles.size >= this.#max) {
      const oldest = this.#oldest();
      if (oldest === undefined) break;
      this.#close(oldest, this.handles.get(oldest)!);
    }
    const handle = randomUUID();
    this.handles.set(handle, { workspaceId, root, reader, lastUsed: Date.now() });
    return handle;
  }
  remove(handle: string): void { this.handles.delete(handle); }
  async close(): Promise<void> {
    const items = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(items.map(item => item.reader.close?.(BACKGROUND_CONTEXT).catch(() => {})));
  }
  #oldest(): string | undefined {
    let oldest: string | undefined;
    for (const [handle, item] of this.handles) if (oldest === undefined || item.lastUsed < this.handles.get(oldest)!.lastUsed) oldest = handle;
    return oldest;
  }
  #close(handle: string, item: ReaderHandle<TReader>): void { this.handles.delete(handle); void item.reader.close?.(BACKGROUND_CONTEXT).catch(() => {}); }
}

/**
 * The execution account and home of one execution host. It is the pair that defines global installation scope
 * (ADR 0002), so it is resolved from the host the filesystem actually serves, never from the backend or gateway
 * process environment when a caller supplies it.
 */
export type ExecutionHostIdentity = { readonly user: string; readonly home: string };

/**
 * Where execution-side resources are looked for, in discovery order. `skills` roots are the workspace, its ancestors
 * and the account; `prompts` roots follow the same precedence rule, so the workspace's `.pi/prompts` precedes the
 * account's `<agent dir>/prompts` and the first prompt of a name wins the collision upstream.
 */
export type ResourceRoot = {
  readonly scope: "project" | "ancestor" | "global";
  readonly kind: "skills" | "prompts";
  readonly path: string;
  /** The loader honours this root only when the project is trusted: upstream gates project `.pi` resources that way. */
  readonly requiresTrust?: boolean;
};

/** A read-only resource file that is not below a resource root: a system prompt, an append prompt or a context file. */
export type ResourceFile = { readonly scope: "project" | "global"; readonly path: string };

export type ExecutionHost = {
  readonly user: string;
  readonly home: string;
  readonly workspaceRoot: string;
  /** The execution account's Pi directory, \`<home>/.pi/agent\`, resolved on the host (ADR 0002). */
  readonly agentDir: string;
  readonly roots: readonly ResourceRoot[];
  /** Context files in upstream order: the account directory first, then ancestors outermost first. */
  readonly contextFiles: readonly string[];
  /** Candidates of the system prompt; a project file is used only when the harness trusts the project. */
  readonly systemPromptFiles: readonly ResourceFile[];
  readonly appendSystemPromptFiles: readonly ResourceFile[];
  /**
   * Canonical host path of the main repository's context file that this workspace, as a linked git worktree, shadows,
   * or absent when nothing is shadowed. Resolved on the host because git metadata is not a resource the loader may read.
   */
  readonly shadowedContextFile?: string;
};

/** Default identity of a local gateway: the account this process runs as. Tests inject an explicit one. */
export function localExecutionHostIdentity(): ExecutionHostIdentity {
  // The process account, not an inherited `USER` value: an environment variable can name a different login than the
  // one whose home and files the tools actually use (ADR 0002).
  return { user: userInfo().username, home: homedir() };
}

/** An existing directory at `path` as its canonical path, or undefined when it is absent or not a directory. */
export async function existingDir(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** An existing regular file at `path` as its canonical path, or undefined when it is absent or not a file. */
async function existingFile(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The first conventional context file present in `dir`, as its canonical path. */
async function contextFileIn(dir: string): Promise<string | undefined> {
  for (const name of CONTEXT_FILE_NAMES) {
    const found = await existingFile(join(dir, name));
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Context files in upstream `loadProjectContextFiles` order: the account directory first, then the workspace and each
 * ancestor outermost first. Adapted from `@earendil-works/pi-coding-agent@1.1.0` `dist/core/resource-loader.js` (MIT,
 * earendil-works/pi at revision 6fb2e7815167e6b19006fc526d1a5d0f5f998787). The linked-worktree shadow rule that
 * upstream applies when the workspace is a nested `git worktree` is not adapted.
 */
async function contextFiles(workspaceRoot: string, agentDir: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const push = (path: string | undefined): void => {
    if (path === undefined || seen.has(path)) return;
    seen.add(path);
    files.push(path);
  };
  push(await contextFileIn(agentDir));
  const chain: string[] = [];
  let dir = resolve(workspaceRoot);
  while (true) {
    const found = await contextFileIn(dir);
    if (found !== undefined && !seen.has(found)) chain.unshift(found);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const path of chain) push(path);
  return files;
}

/** The system or append prompt candidates of one file name: the account file and the project file, when each exists. */
async function promptFiles(workspaceRoot: string, agentDir: string, name: string): Promise<ResourceFile[]> {
  const files: ResourceFile[] = [];
  const global = await existingFile(join(agentDir, name));
  if (global !== undefined) files.push({ scope: "global", path: global });
  const project = await existingFile(join(workspaceRoot, ".pi", name));
  if (project !== undefined) files.push({ scope: "project", path: project });
  return files;
}

/** The nearest enclosing directory that contains `.git`, which is where ancestor discovery stops (upstream rule). */
function repositoryRoot(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Execution-side resource roots for one workspace, in the order a name collision resolves: the workspace's own
 * `.pi/skills`, then its `.agents/skills` and each ancestor's up to the repository root, then the account's
 * `<home>/.pi/agent/skills` and `<home>/.agents/skills`, then the workspace's `.pi/prompts` and the account's
 * prompts directory. Only existing directories are returned, so a root that appears later is picked up by the next
 * resolution; `home` itself is not a root.
 *
 * The order is upstream's `addAutoDiscoveredResources` collection order after `toResolvedPaths` sorts by
 * `resourcePrecedenceRank`: a project `local` resource (`.pi`) outranks a project auto-discovered one (`.agents`),
 * which outranks a user `local` one (`<home>/.pi/agent`), which outranks a user auto-discovered one
 * (`<home>/.agents`); within one rank the collection order holds, so the workspace precedes its ancestors.
 * Adapted from `@earendil-works/pi-coding-agent@1.1.0` `dist/core/package-manager.js`
 * (`addAutoDiscoveredResources`, `collectAncestorAgentsSkillDirs`, `findGitRepoRoot`, `resourcePrecedenceRank`, MIT,
 * earendil-works/pi at revision 6fb2e7815167e6b19006fc526d1a5d0f5f998787). The upstream function returns candidate
 * paths; this one keeps only the directories that exist on the host being served. Two upstream details are honoured
 * here: the account's `.agents/skills` is filtered out of the ancestor walk so a workspace below the account home does
 * not re-tag it as an ancestor, and the project prompts directory is collected before the account one.
 */
export async function resourceRoots(workspaceRoot: string, home: string, agentDir: string): Promise<ResourceRoot[]> {
  const roots: ResourceRoot[] = [];
  const seen = new Set<string>();
  const add = async (path: string, scope: ResourceRoot["scope"], kind: ResourceRoot["kind"], requiresTrust = false): Promise<void> => {
    const real = await existingDir(path);
    if (real === undefined || seen.has(real)) return;
    seen.add(real);
    roots.push({ scope, kind, path: real, ...(requiresTrust ? { requiresTrust: true } : {}) });
  };
  const stop = repositoryRoot(workspaceRoot);
  const accountAgents = resolve(join(home, ".agents", "skills"));
  await add(join(workspaceRoot, ".pi", "skills"), "project", "skills", true);
  await add(join(workspaceRoot, ".agents", "skills"), "project", "skills");
  let dir = resolve(workspaceRoot);
  while (true) {
    // When the workspace is below the account home this walk reaches the account's own `.agents/skills` too. Upstream
    // filters that directory out of the ancestor list, so it keeps the global rank it is added with below.
    if (resolve(join(dir, ".agents", "skills")) !== accountAgents) await add(join(dir, ".agents", "skills"), "ancestor", "skills");
    if (stop !== undefined && dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  await add(join(agentDir, "skills"), "global", "skills");
  await add(join(home, ".agents", "skills"), "global", "skills");
  await add(join(workspaceRoot, ".pi", "prompts"), "project", "prompts", true);
  await add(join(agentDir, "prompts"), "global", "prompts");
  return roots;
}

/**
 * The execution host one workspace is served on: its account, its canonical home, and every execution-side resource it
 * offers. The account's Pi directory is its home's `.pi/agent` (upstream's default); a `PI_CODING_AGENT_DIR` override
 * is not consulted, so the backend's own configuration can never stand in for the host's resources.
 */
export async function executionHost(workspaceRoot: string, identity: ExecutionHostIdentity): Promise<ExecutionHost> {
  const canonicalHome = await realpath(identity.home).catch(() => resolve(identity.home));
  const canonicalWorkspace = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
  const agentDir = join(canonicalHome, ".pi", "agent");
  // Resolved on the host, where git metadata is readable: the loader may read only resource roots and the workspace, so
  // it can subtract the shadowed file but cannot find it. Absent for anything that is not a linked worktree.
  const shadowedContextFile = await findShadowedContextFile(canonicalWorkspace);
  return {
    user: identity.user,
    home: canonicalHome,
    workspaceRoot: canonicalWorkspace,
    agentDir,
    ...(shadowedContextFile === undefined ? {} : { shadowedContextFile }),
    roots: await resourceRoots(canonicalWorkspace, canonicalHome, agentDir),
    contextFiles: await contextFiles(canonicalWorkspace, agentDir),
    systemPromptFiles: await promptFiles(canonicalWorkspace, agentDir, "SYSTEM.md"),
    appendSystemPromptFiles: await promptFiles(canonicalWorkspace, agentDir, "APPEND_SYSTEM.md"),
  };
}

export type GatewayFilesOptions = { readerTtlMs?: number; maxReaders?: number; identity?: ExecutionHostIdentity };

/** Local-workspace filesystem: resolves workspace-relative paths against the configured root and serves them through the upstream \`NodeExecutionEnv\`. */
export class LocalFilesystem implements FilesystemServer {
  /** The workspaces this filesystem serves: the gateway's shared registry, so a runtime registration is served at once. */
  readonly workspaces: WorkspaceRegistry;
  readonly readers: ReaderRegistry<BinaryReader>;
  readonly #identity: ExecutionHostIdentity;
  constructor(workspaces: WorkspaceRegistry, options: GatewayFilesOptions = {}) {
    this.workspaces = workspaces;
    this.readers = new ReaderRegistry(options.readerTtlMs ?? READER_TTL_MS, options.maxReaders ?? MAX_READERS);
    this.#identity = options.identity ?? localExecutionHostIdentity();
  }

  async execute(request: FileRequest): Promise<unknown> {
    try {
      const workspace = this.workspaces.get(request.workspaceId);
      if (workspace === undefined) return fileFailure(new FileError("permission_denied", "unknown workspace"));
      const root = await realpath(workspace.root);
      this.readers.reap();
      const host = await executionHost(root, this.#identity);
      // Reads resolve the workspace first and an execution-side resource root second; every other method stays confined
      // to the workspace, so the account home is readable where a resource lives and never writable through it.
      // A resource read keeps its real host path in results; a workspace read keeps the logical workspace path.
      let resourceRead = false;
      // The agent definition directories are the one named capability that reaches outside the workspace, and only
      // when the request declares it. An ordinary request keeps the resource roots plus the workspace.
      const agentDefinitions = request.resource === "agent-definitions";
      const isAgentDefinition = (path: string | undefined): path is string =>
        agentDefinitions && path !== undefined && isAbsolute(path)
        && agentDefinitionRoots(host).some((candidate) => within(candidate, resolve(path)));
      const readable = async (path: string | undefined): Promise<string> => {
        const resource = await resourceReadPath(host, path);
        if (resource !== undefined) { resourceRead = true; return resource; }
        if (isAgentDefinition(path)) { resourceRead = true; return await confineAgentDefinition(host, path); }
        return await confinedPath(root, path);
      };
      const reportInfo = (info: FileInfo): FileInfo => resourceRead ? info : relativeInfo(root, info);
      const reportPath = (path: string): string => resourceRead ? path : relativePath(root, path);
      const mutable = (path: string | undefined): Promise<string> => isAgentDefinition(path)
        ? confineAgentDefinition(host, path)
        : mutationPath(host, root, path);
      if (request.handle !== undefined) return await this.#reader(workspace.id, request);
      const env = new NodeExecutionEnv({ cwd: root });
      switch (request.method) {
        case "executionHost": return { ok: true, value: host };
        case "resourceSnapshot": return { ok: true, value: await resourceSnapshot(root, this.#identity) };
        case "readTextFile": return await this.#readText(env, await readable(request.path));
        case "readBinaryFile": return await this.#readBinary(env, await readable(request.path));
        case "writeFile": return fromResult(await env.writeFile(await mutable(request.path), contentOf(request), BACKGROUND_CONTEXT));
        case "appendFile": return fromResult(await env.appendFile(await mutable(request.path), contentOf(request), BACKGROUND_CONTEXT));
        case "truncateFile": return fromResult(await env.truncateFile(await mutable(request.path), request.size ?? 0, BACKGROUND_CONTEXT));
        case "flushFile": return fromResult(await env.flushFile(await mutable(request.path), BACKGROUND_CONTEXT));
        case "renameFile": return await this.#rename(env, await mutable(request.path), await mutable(request.destinationPath), request.options?.preserveMode === true);
        case "remove": return fromResult(await env.remove(await mutable(request.path), request.options, BACKGROUND_CONTEXT));
        case "createDir": return fromResult(await env.createDir(await mutable(request.path), request.options, BACKGROUND_CONTEXT));
        case "createTempDir": return { ok: true, value: relativePath(root, await mkdtemp(join(root, tempName(request.prefix ?? "tmp-")))) };
        case "createTempFile": { const path = join(root, tempName(request.prefix ?? "tmp-") + randomUUID() + tempName(request.suffix ?? "")); await writeFile(path, "", { flag: "wx", mode: 0o600 }); return { ok: true, value: relativePath(root, path) }; }
        case "fileInfo": return fromResult(await env.fileInfo(await readable(request.path), BACKGROUND_CONTEXT), reportInfo);
        case "listDir": return fromResult(await env.listDir(await readable(request.path), BACKGROUND_CONTEXT), value => value.map(reportInfo));
        case "canonicalPath": return fromResult(await env.canonicalPath(await readable(request.path), BACKGROUND_CONTEXT), reportPath);
        case "exists": return fromResult(await env.exists(await readable(request.path), BACKGROUND_CONTEXT));
        case "openBinaryReader": return await this.#open(env, workspace.id, root, request, await readable(request.path));
        default: return fileFailure(new FileError("not_supported", request.method + " is not supported by the gateway filesystem"));
      }
    } catch (error) { return fileFailure(asFileError(error)); }
  }

  async close(): Promise<void> { await this.readers.close(); }

  /**
   * Rename a staged file over its destination, keeping the destination's own permissions when asked. A replacement
   * writes a private staging file (0600), so without this the file that was there would come back with the staging
   * file's mode rather than the mode it had.
   */
  async #rename(env: NodeExecutionEnv, source: string, destination: string, preserveMode: boolean): Promise<unknown> {
    if (preserveMode) {
      const existing = await lstat(destination).catch(() => undefined);
      if (existing?.isFile() === true) await chmod(source, existing.mode & 0o777);
    }
    return fromResult(await env.renameFile(source, destination, BACKGROUND_CONTEXT));
  }

  async #readText(env: NodeExecutionEnv, path: string): Promise<unknown> {
    const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
    if (!info.ok) return fileFailure(info.error);
    if (info.value.kind !== "file") return fileFailure(notRegular(info.value, path));
    if (info.value.size > MAX_FILE_BYTES) return fileFailure(tooLarge(info.value.size));
    return fromResult(await env.readTextFile(path, BACKGROUND_CONTEXT));
  }

  async #readBinary(env: NodeExecutionEnv, path: string): Promise<unknown> {
    const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
    if (!info.ok) return fileFailure(info.error);
    if (info.value.kind !== "file") return fileFailure(notRegular(info.value, path));
    if (info.value.size > MAX_FILE_BYTES) return fileFailure(tooLarge(info.value.size));
    const result = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
    return result.ok ? { ok: true, value: Buffer.from(result.value).toString("base64") } : fileFailure(result.error);
  }

  async #open(env: NodeExecutionEnv, workspaceId: string, root: string, request: FileRequest, path: string): Promise<unknown> {
    const info = await env.fileInfo(path, BACKGROUND_CONTEXT);
    if (!info.ok) return fileFailure(info.error);
    if (info.value.kind !== "file") return fileFailure(notRegular(info.value, path));
    if (info.value.size > MAX_FILE_BYTES) return fileFailure(tooLarge(info.value.size));
    const opened = await env.openBinaryReader(path, request.options, BACKGROUND_CONTEXT);
    if (!opened.ok) return fileFailure(opened.error);
    return { ok: true, value: this.readers.add(workspaceId, root, opened.value) };
  }

  async #reader(workspaceId: string, request: FileRequest): Promise<unknown> {
    this.readers.reap();
    const stored = this.readers.take(request.handle!, workspaceId);
    if (stored === undefined) return fileFailure(new FileError("invalid", "unknown or expired reader"));
    if (request.method === "reader.close") { this.readers.remove(request.handle!); await stored.reader.close(BACKGROUND_CONTEXT); return { ok: true }; }
    return await readerMethod({
      info: async () => { const result = await stored.reader.info(BACKGROUND_CONTEXT); return result.ok ? { ok: true as const, value: relativeInfo(stored.root, result.value) } : result; },
      read: async (offset, length) => { const result = await stored.reader.read(offset, length, BACKGROUND_CONTEXT); return result.ok ? { ok: true as const, value: Buffer.from(result.value).toString("base64") } : result; },
      scanLines: options => stored.reader.scanLines(options, BACKGROUND_CONTEXT),
    }, request);
  }
}

/** Keeps the existing \`GatewayFiles\` import in \`index.ts\` working: the local filesystem is the gateway's default surface. */
export const GatewayFiles = LocalFilesystem;

/**
 * Largest resource snapshot one discovery may return. Over it discovery fails with a clear error: the response is one
 * value or none, never a silent truncation and never a second request for the rest.
 */
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** Most directory entries one snapshot may carry, bounded for the same reason as the byte bound. */
export const MAX_SNAPSHOT_ENTRIES = 20_000;
/**
 * Bytes of a skill file a snapshot reads. A skill is advertised by its frontmatter alone, and frontmatter can only be
 * at the start of a file, so a head that does not open one settles the question.
 */
export const MAX_FRONTMATTER_BYTES = 256 * 1024;

/** One entry of one walked directory: what `listDir` reports, the target it resolves to, and that target's kind. */
export type SnapshotEntry = {
  readonly info: FileInfo;
  /** Canonical target of the logical entry, so a link is followed by its target. */
  readonly real: string;
  /** `stat` kind of the target, or `missing` for a link that resolves to nothing. */
  readonly realKind: FileInfo["kind"] | "missing";
};

/** One directory the resource scope set reaches, by the logical path the walk entered it at. */
export type SnapshotDirectory = { readonly path: string; readonly real: string; readonly entries: readonly SnapshotEntry[] };

/**
 * A host read that failed, in the shape the loader rebuilds into the host's own error. A failure is a fact about one
 * path, not a failed snapshot: a directory the walk could not list, or a file it could not read, is carried as what
 * happened and the loader raises it only if its own walk reaches that path. Reading a path eagerly must not turn a
 * file the loader would never open — one an ignore rule excludes, or a supporting document beside a declared skill —
 * into a failed discovery, which is what a per-file walk does not do either.
 */
export type SnapshotFailure = { readonly code: FileErrorCode; readonly message: string };

/** One directory the scope set could not list: it exists, but its entries are unknown rather than empty. */
export type SnapshotUnreadableDirectory = {
  readonly path: string;
  readonly real: string;
  readonly failure: SnapshotFailure;
};

/** One file text the walk may need, with the read that was performed for it, or the failure that read produced. */
export type SnapshotFile = {
  readonly path: string;
  readonly real: string;
  /** `whole` when the body matters, `frontmatter` when only a skill's declaration is needed. */
  readonly read: "whole" | "frontmatter";
} & ({ readonly text: string } | { readonly failure: SnapshotFailure });

/**
 * The complete execution-side resource scope set of one host, read in one pass (ADR 0002). It carries every root the
 * host offers, the host's own context, system and append prompt files, every directory of every root with its entries,
 * and the text of every ignore file, skill declaration and prompt template. A consumer walks it in memory, so a
 * discovery costs one round trip rather than one per file, and no decision about resources is made here.
 */
export type ResourceSnapshot = {
  readonly host: ExecutionHost;
  readonly directories: readonly (SnapshotDirectory | SnapshotUnreadableDirectory)[];
  readonly files: readonly SnapshotFile[];
};

/**
 * The codes the loader's own canonical step treats as "this path is not there to walk" and skips silently. The producer
 * must not decide that for a different code, because the loader raises the rest; both sides answer to the same rule.
 */
const UNRESOLVABLE: ReadonlySet<FileErrorCode> = new Set<FileErrorCode>(["not_found", "not_directory", "permission_denied", "invalid"]);

/**
 * One host read failure as a file error. The errno keeps its meaning, so a permission or I/O failure stays a failure
 * the loader raises rather than an absence it silently walks past.
 */
function snapshotError(error: unknown): FileError {
  if (error instanceof FileError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  const mapped: FileErrorCode =
    code === "ENOENT" ? "not_found"
    : code === "EACCES" || code === "EPERM" ? "permission_denied"
    : code === "ENOTDIR" ? "not_directory"
    : code === "EISDIR" ? "is_directory"
    : code === "EINVAL" || code === "ELOOP" || code === "ENXIO" ? "invalid"
    : "unknown";
  return new FileError(mapped, error instanceof Error ? error.message : String(error));
}

/** One file error in the shape the snapshot carries it. */
function failureOf(error: FileError): SnapshotFailure {
  return { code: error.code, message: error.message };
}

/** The ignore file names the resource loader reads in every directory it enters. */
const SNAPSHOT_IGNORE_NAMES: readonly string[] = [".gitignore", ".ignore", ".fdignore"];

/**
 * A skill's declaration: the frontmatter block when the file opens one, and the head itself when it does not, because
 * frontmatter lives only at the start of a file. A head that opens frontmatter without ending it is a refusal rather
 * than a truncated declaration.
 */
export function skillHead(text: string, complete: boolean, path: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
  if (match !== null) return match[0];
  if (text.startsWith("---") && !complete) throw new FileError("invalid", "execution-side skill " + path + " does not end its frontmatter within " + MAX_FRONTMATTER_BYTES + " bytes");
  return text;
}

/**
 * One file's text for a snapshot: whole, or the declaration of a skill. Absent and non-regular files are skipped; a
 * file that is there but cannot be read, or that is past the per-file limit, comes back as that failure rather than as
 * a missing file, so the loader fails where it would have failed reading the host one file at a time.
 */
async function snapshotText(path: string, real: string, read: SnapshotFile["read"]): Promise<{ text: string } | { failure: SnapshotFailure } | undefined> {
  const info = await stat(real).catch(snapshotError);
  if (info instanceof FileError) return { failure: failureOf(info) };
  if (!info.isFile()) return undefined;
  // The per-file limit is the one `readTextFile` enforces, and a skill is read through that same limit however little
  // of it the snapshot keeps: a file over it fails a load instead of being advertised from a truncated head.
  if (info.size > MAX_FILE_BYTES) return { failure: failureOf(tooLarge(info.size)) };
  if (read === "whole") {
    return await readFile(real, "utf8").then((text) => ({ text }), (error: unknown) => ({ failure: failureOf(snapshotError(error)) }));
  }
  const length = Math.min(info.size, MAX_FRONTMATTER_BYTES);
  try {
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(length);
      const read = await handle.read(buffer, 0, length, 0);
      return { text: skillHead(buffer.subarray(0, read.bytesRead).toString("utf8"), info.size <= MAX_FRONTMATTER_BYTES, path) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    // `skillHead`'s own refusal is a judgement about the file's content, which the loader raises the same way.
    return { failure: failureOf(snapshotError(error)) };
  }
}

/**
 * The whole resource scope set of one host in a single pass: every root walked once, every ignore file and every
 * candidate resource file read where it lives. The walk prunes as it goes — an ignored directory is never entered, an
 * ignored file is never read, a directory that declares a skill is terminal and a prompts root is read one level deep —
 * so content the loader would ignore is neither read, nor transmitted, nor counted against the bounds. The loader still
 * owns every decision and reaches the same one over what the snapshot holds.
 */
export async function resourceSnapshot(workspaceRoot: string, identity: ExecutionHostIdentity): Promise<ResourceSnapshot> {
  const host = await executionHost(workspaceRoot, identity);
  const directories: (SnapshotDirectory | SnapshotUnreadableDirectory)[] = [];
  const files = new Map<string, SnapshotFile>();
  let bytes = 0;
  let entries = 0;

  /**
   * The payload bound, measured on the response as it is serialized: every value counted as the JSON it becomes, so
   * escaping and the metadata beside a text count too, and the host metadata counts once. That running total is a lower
   * bound which stops a runaway walk early; the whole response is measured exactly again before it is returned.
   */
  const spend = (value: unknown): void => {
    bytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new FileError("invalid", "the execution-side resource snapshot exceeds " + MAX_SNAPSHOT_BYTES + " bytes");
  };
  spend(host);

  // Keyed by the logical path alone. One file reached through a link as well as directly is two logical paths of one
  // canonical target, and both must be in the snapshot: the loader reads a regular file at the path the walk reached
  // and deduplicates by the canonical one, so dropping either name would change what it adopts.
  const remember = (file: SnapshotFile): void => {
    spend(file);
    files.set(file.path, file);
  };

  /**
   * One directory whose entries could not be listed. It is carried as unreadable rather than left out: a directory the
   * snapshot omits answers the loader "not there", and a discovery that walked past a root it could not open would
   * adopt a prefix of the catalog where reading the host one file at a time fails outright.
   */
  const unreadable = (path: string, real: string, error: FileError): void => {
    const directory: SnapshotUnreadableDirectory = { path, real, failure: failureOf(error) };
    spend(directory);
    directories.push(directory);
  };

  /** One file's text, at the logical path the walk reached it by and the canonical target it resolves to. */
  const take = async (path: string, real: string, read: SnapshotFile["read"]): Promise<void> => {
    if (files.get(path)?.read === read) return;
    const found = await snapshotText(path, real, read);
    if (found === undefined) return;
    // Absence is absence, not a failure: an ignore file a directory does not have is what a per-file read reports as
    // not_found too, and carrying one fact per missing candidate would fill the payload with nothing.
    if ("failure" in found && found.failure.code === "not_found") return;
    remember("text" in found ? { path, real, read, text: found.text } : { path, real, read, failure: found.failure });
  };

  /**
   * The ignore files of one directory, read before anything in it is decided, so the walk prunes exactly where the
   * loader's own rules will ignore. Their text is carried because the loader reads it again to reach the same decision
   * over the snapshot; a directory that has none contributes nothing and costs nothing.
   */
  const ignoreFiles = async (directory: string, prefix: string, rules: ResourceIgnoreRules): Promise<void> => {
    for (const name of SNAPSHOT_IGNORE_NAMES) {
      const path = join(directory, name);
      const real = await realpath(path).catch(() => path);
      const found = await snapshotText(path, real, "whole");
      if (found === undefined) continue;
      if ("failure" in found) {
        if (found.failure.code !== "not_found") remember({ path, real, read: "whole", failure: found.failure });
        continue;
      }
      rules.addText(found.text, prefix);
      remember({ path, real, read: "whole", text: found.text });
    }
  };

  /**
   * One directory of one root. A link may reach a directory another branch already walked — the loader decides what to
   * adopt from the logical paths it is given, and a link is how it reaches a directory an ignore rule hid from the walk
   * — so a directory is not pruned for having been seen. Only a link that reaches a directory already on this path is a
   * cycle, and that is what terminates the walk.
   */
  const walk = async (directory: string, rootPath: string, kind: ResourceRoot["kind"], ancestors: ReadonlySet<string>, rules: ResourceIgnoreRules): Promise<void> => {
    const real = await realpath(directory).catch(snapshotError);
    // A path that is not there to walk is the one case the loader also walks past, so it is left out. Any other failure
    // to resolve it is raised here exactly as the loader's canonical step would raise it.
    if (real instanceof FileError) {
      if (UNRESOLVABLE.has(real.code)) return;
      throw real;
    }
    if (ancestors.has(real)) return;
    const own = await stat(real).catch(snapshotError);
    if (own instanceof FileError) { unreadable(directory, real, own); return; }
    if (!own.isDirectory()) { unreadable(directory, real, new FileError("not_directory", directory + " is not a directory", directory)); return; }
    const visited = new Set(ancestors);
    visited.add(real);
    const names = await readdir(directory).catch(snapshotError);
    if (names instanceof FileError) { unreadable(directory, real, names); return; }
    const relativeDir = relative(rootPath, directory);
    await ignoreFiles(directory, relativeDir === "" ? "" : relativeDir + "/", rules);
    const found: SnapshotEntry[] = [];
    for (const name of [...names].sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const path = join(directory, name);
      // A listing that fails part way through is not a listing: the directory is reported unreadable rather than with
      // the entries that happened to be readable before the failure, which is what the host's own \`listDir\` does.
      const link = await lstat(path).catch(snapshotError);
      if (link instanceof FileError) { unreadable(directory, real, link); return; }
      const entryKind = fileKindOf(link);
      if (entryKind === undefined) continue;
      const target = await realpath(path).catch(() => undefined);
      const targetInfo = target === undefined ? undefined : await stat(target).catch(() => undefined);
      entries += 1;
      if (entries > MAX_SNAPSHOT_ENTRIES) throw new FileError("invalid", "the execution-side resource snapshot exceeds " + MAX_SNAPSHOT_ENTRIES + " entries");
      found.push({ info: fileInfoOf(path, link, entryKind), real: target ?? path, realKind: targetInfo === undefined ? "missing" : fileKindOf(targetInfo) ?? "missing" });
    }
    const readable: SnapshotDirectory = { path: directory, real, entries: found };
    spend(readable);
    directories.push(readable);
    // A directory that declares a skill is that one skill: the loader stops there, so nothing else in it and nothing
    // below it is a resource.
    const terminal = kind === "skills" && found.some((entry) => entry.info.name === "SKILL.md");
    for (const entry of found) {
      // A link is followed only while it stays inside the root it was reached from, exactly as the loader's own walk
      // refuses a target outside it; nothing outside a root is read into the snapshot.
      if (!within(rootPath, entry.real)) continue;
      const logical = entry.info.path;
      if (terminal && entry.info.name !== "SKILL.md") continue;
      const relativePath = relative(rootPath, logical);
      if (rules.ignores(entry.realKind === "directory" ? relativePath + "/" : relativePath)) continue;
      if (terminal) { await take(logical, entry.real, "frontmatter"); continue; }
      if (entry.realKind === "directory") {
        // A prompts root is read one level deep, as the loader reads it; a skills root is searched.
        if (kind === "skills") await walk(logical, rootPath, kind, visited, rules);
        continue;
      }
      if (entry.realKind !== "file" || !entry.info.name.endsWith(".md")) continue;
      await take(logical, entry.real, kind === "skills" ? "frontmatter" : "whole");
    }
  };

  for (const root of host.roots) await walk(root.path, root.path, root.kind, new Set<string>(), new ResourceIgnoreRules());
  // Context, system and append prompt files live outside every resource root, so they are read by name.
  for (const path of host.contextFiles) await take(path, await realpath(path).catch(() => path), "whole");
  for (const file of [...host.systemPromptFiles, ...host.appendSystemPromptFiles]) await take(file.path, await realpath(file.path).catch(() => file.path), "whole");
  const snapshot: ResourceSnapshot = { host, directories, files: [...files.values()] };
  const response = Buffer.byteLength(JSON.stringify({ ok: true, value: snapshot }), "utf8");
  if (response > MAX_SNAPSHOT_BYTES) throw new FileError("invalid", "the execution-side resource snapshot exceeds " + MAX_SNAPSHOT_BYTES + " bytes");
  return snapshot;
}
/** The `FileInfo` of one path, from the metadata already read for it. */
function fileInfoOf(path: string, stats: Stats, kind: FileInfo["kind"]): FileInfo {
  return { name: basename(path), path, kind, size: stats.size, mtimeMs: stats.mtimeMs };
}

/**
 * The gateway's own kind names, matching the ones `NodeExecutionEnv` reports. A fifo, socket or device is not a file
 * the gateway serves, so it has no kind and the walk leaves it out, exactly as `listDir` leaves it out locally.
 */
function fileKindOf(stats: Stats): FileInfo["kind"] | undefined {
  return stats.isDirectory() ? "directory" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : undefined;
}


/** The execution-side resource root a path is lexically inside, or undefined when it is not inside any of them. */
export function resourceRootOf(host: ExecutionHost, path: string | undefined): ResourceRoot | undefined {
  if (path === undefined || path === "" || !isAbsolute(path)) return undefined;
  const resolved = resolve(path);
  return host.roots.find((resource) => within(resource.path, resolved));
}

/** Every read-only resource file of one host: each context, system and append prompt file that exists on it. */
function authorizedResourceFiles(host: ExecutionHost): Set<string> {
  return new Set([
    ...host.contextFiles,
    ...host.systemPromptFiles.map((file) => file.path),
    ...host.appendSystemPromptFiles.map((file) => file.path),
  ]);
}

/**
 * The read-only resource file a request path names exactly, or undefined when it names no such file. The authorized
 * paths are canonical, so the request must name one of them directly; a link to one is not that file.
 */
export function resourceFileOf(host: ExecutionHost, path: string | undefined): string | undefined {
  if (path === undefined || path === "" || !isAbsolute(path)) return undefined;
  const resolved = resolve(path);
  return authorizedResourceFiles(host).has(resolved) ? resolved : undefined;
}

/**
 * The canonical path of a read-only request that names a file below an execution-side resource root or one of the
 * host's resource files, or undefined when it names neither. Both the lexical and the canonical path must stay inside
 * the root, so a link out of a resource root is refused the same way a workspace link out of the workspace is; an
 * absent or unauthorized path falls back to workspace resolution.
 */
export async function resourceReadPath(host: ExecutionHost, path: string | undefined): Promise<string | undefined> {
  const resource = resourceRootOf(host, path);
  if (resource !== undefined) {
    try {
      const real = await realpath(path!);
      return within(resource.path, real) ? real : undefined;
    } catch {
      // Absent, dangling, or unreadable. It is still refused as a mutation target below, so the fall-through cannot write.
      return undefined;
    }
  }
  if (resourceFileOf(host, path) === undefined) return undefined;
  try {
    const real = await realpath(path!);
    return authorizedResourceFiles(host).has(real) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a mutating request's path. A path inside an execution-side resource root, or one naming a resource file, is
 * refused rather than remapped into the workspace: those are read-only host locations, and silently writing somewhere
 * else would be a surprise.
 *
 * Both the raw request and the workspace-resolved path are checked, because every accepted path form names the same
 * file: `/.agents/skills/deploy/SKILL.md` (the logical workspace form) and `AGENTS.md` (relative) reach the same file as
 * the physical absolute path. Checking only the raw string would let a relative or logical alias write a resource.
 */
export async function mutationPath(host: ExecutionHost, root: string, path: string | undefined): Promise<string> {
  const resolved = resolveWorkspacePath(root, path);
  // Both the raw request and the workspace-resolved path are checked: the raw one is how a resource outside the
  // workspace is named, the resolved one is what a logical or relative alias turns into.
  if (namesResource(host, path) || namesResource(host, resolved)) throw new FileError("permission_denied", "execution-side resource locations are read-only", path);
  return await confinedPath(root, resolved);
}

/**
 * The two agent definition directories of one host: the project's \`<workspace>/.pi/agents\` and the account's
 * \`<agent dir>/agents\`. They are configuration the user edits through the definition API, not workspace files, so
 * they are addressed by a restricted resource surface (\`FileRequest.resource\`) rather than by the workspace mapping.
 */
export function agentDefinitionRoots(host: ExecutionHost): readonly string[] {
  return [join(host.agentDir, "agents"), join(host.workspaceRoot, ".pi", "agents")];
}

/**
 * Resolve a request path inside one of the host's agent definition directories, or refuse it. The directory itself may
 * not exist yet, so the nearest existing ancestor is what is confined: it must stay inside the account home (or the
 * workspace, for the project directory), and an existing part below the definition directory must not resolve through
 * a link out of it. The lexical path is returned, so a create names the file the caller asked for.
 */
export async function confineAgentDefinition(host: ExecutionHost, path: string): Promise<string> {
  const resolved = resolve(path);
  const root = agentDefinitionRoots(host).find((candidate) => within(candidate, resolved));
  if (root === undefined) throw new FileError("permission_denied", "path outside the agent definition directories", path);
  const boundary = within(host.workspaceRoot, root) ? host.workspaceRoot : host.home;
  let candidate = resolved;
  while (true) {
    try {
      const real = await realpath(candidate);
      if (!within(boundary, real)) throw new FileError("permission_denied", "symlink outside the agent definition directories", path);
      if (within(root, candidate) && !within(root, real)) throw new FileError("permission_denied", "symlink outside the agent definition directories", path);
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await lstat(candidate).catch(() => undefined))?.isSymbolicLink()) throw new FileError("permission_denied", "dangling symlink", path);
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Whether one path names an execution-side resource root or resource file. */
function namesResource(host: ExecutionHost, path: string | undefined): boolean {
  return resourceRootOf(host, path) !== undefined || resourceFileOf(host, path) !== undefined;
}

/** Serve one \`reader.*\` request against a bounded reader, with the shared offset/length bounds. */
export async function readerMethod(reader: GatewayReader, request: FileRequest): Promise<unknown> {
  switch (request.method) {
    case "reader.info": { const result = await reader.info(); return result.ok ? { ok: true, value: result.value } : fileFailure(result.error); }
    case "reader.read": {
      const offset = request.offset ?? -1;
      const length = request.length ?? -1;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return fileFailure(new FileError("invalid", "offset and length must be non-negative safe integers"));
      if (length > MAX_FILE_BYTES) return fileFailure(new FileError("invalid", "read length exceeds the " + MAX_FILE_BYTES + " byte gateway limit"));
      const result = await reader.read(offset, length);
      return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
    }
    case "reader.scanLines": {
      const result = await reader.scanLines({ startLine: request.options?.startLine ?? 0, endLine: request.options?.endLine });
      return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
    }
    default: return fileFailure(new FileError("not_supported", request.method + " is not a reader method"));
  }
}

export function fileFailure(error: FileError): unknown {
  return { ok: false, error: { code: error.code, message: error.message, ...(error.path === undefined ? {} : { path: error.path }) } };
}

export function asFileError(error: unknown): FileError {
  if (error instanceof FileError) return error;
  return new FileError("unknown", error instanceof Error ? error.message : String(error));
}

export function tempName(value: string): string {
  if (/[\/\\\0]/.test(value) || value === "..") throw new FileError("invalid", "temporary name must not contain path separators");
  return value;
}

/**
 * A result's path: the logical workspace path inside the root, and the real host path outside it. A resource root lives
 * outside the workspace, and its real path is the one ordinary host tools can read (ADR 0002), so it is reported as-is
 * rather than mangled into a workspace-relative form that names no file.
 */
export function relativePath(root: string, path: string): string { return within(root, path) ? "/" + relative(root, path) : path; }

export function relativeInfo(root: string, info: FileInfo): FileInfo { return { ...info, path: relativePath(root, info.path) }; }

export function tooLarge(size: number): FileError { return new FileError("invalid", "file is " + size + " bytes; the gateway limit is " + MAX_FILE_BYTES + " bytes"); }

export function notRegular(info: FileInfo, path: string): FileError {
  return new FileError(info.kind === "directory" ? "is_directory" : "invalid", "Not a regular file", path);
}

export function contentOf(request: FileRequest): string | Uint8Array {
  if (request.content === undefined) throw new FileError("invalid", "content is required");
  if (request.encoding === "base64") {
    const bytes = Buffer.from(request.content, "base64");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit");
    return bytes;
  }
  if (request.encoding !== undefined && request.encoding !== "utf8") throw new FileError("invalid", "unsupported content encoding: " + request.encoding);
  if (Buffer.byteLength(request.content, "utf8") > MAX_FILE_BYTES) throw new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit");
  return request.content;
}

function fromResult<T>(result: { ok: true; value: T } | { ok: false; error: FileError }, map?: (value: T) => unknown): unknown {
  return result.ok ? { ok: true, value: map === undefined ? result.value : map(result.value) } : fileFailure(result.error);
}

/**
 * Map one caller-supplied path to a real path inside \`root\`, then refuse anything that leaves it, following existing
 * symlinks. Three forms name the same file and all resolve here: a relative path (\`src/app.ts\`), the logical workspace
 * absolute path the file tools use (\`/src/app.ts\`), and the physical absolute path a shell prints (\`<root>/src/app.ts\`).
 * Absolute paths inside root are physical; other absolute paths retain logical-workspace semantics.
 * Neither form grants access outside root.
 */
export async function confinedPath(root: string, path: string | undefined): Promise<string> {
  const resolved = resolveWorkspacePath(root, path);
  await confined(root, resolved);
  return resolved;
}

/** The three accepted path forms resolved to one physical path. Confinement is the caller's next step. */
export function resolveWorkspacePath(root: string, path: string | undefined): string {
  if (path === undefined || path === "") throw new FileError("invalid", "path is required");
  // The physical form: what a shell prints for this root. Local callers pass a canonical root. The prefix
  // boundary is part of the root, so a sibling like \`<root>-other\` is not mistaken for a path inside it.
  const physical = resolve(root);
  if (path === physical || within(physical, path)) return resolve(path);
  // Every other absolute path is the logical workspace form the file tools use (\`/src/app.ts\`), mapped under the root.
  // It cannot escape: a leading \`..\` is resolved against the root and then refused by the confinement check.
  return resolve(physical, path.replace(/^\/+/, ""));
}

async function confined(root: string, path: string): Promise<void> {
  if (!within(root, path)) throw new FileError("permission_denied", "path outside workspace", path);
  let candidate = path;
  while (true) {
    try {
      if (!within(root, await realpath(candidate))) throw new FileError("permission_denied", "symlink outside workspace", path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink makes realpath report ENOENT, the same code a genuinely absent path gives, so the ascent
      // below would treat it as missing and let a following create or write run through the link. Its own target is
      // unverifiable, so it is refused outright rather than followed. This narrows the window; it is not a
      // TOCTOU guarantee against a link swapped in after the check.
      if ((await lstat(candidate).catch(() => undefined))?.isSymbolicLink()) throw new FileError("permission_denied", "dangling symlink", path);
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}


export function within(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(".." + "/") && child !== ".." && !child.startsWith("/"));
}
