import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createSyntheticSourceInfo, formatSkillsForPrompt, parseFrontmatter, stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { defineDoc, defineExtension, LiveDoc, section, type ConversationId, type DocumentReader, type Extension, type Tx } from "@earendil-works/pi-durable";
import { FileError } from "@earendil-works/pi-durable/env";
import { ResourceIgnoreRules } from "@hepi/gateway";
import type { ExecutionHost, ExecutionHostEnv, ResourceRoot, ResourceSnapshot, SnapshotEntry, SnapshotFile, SnapshotFailure } from "@hepi/gateway";
import { parseCommandArgs, substituteArgs } from "./prompt-templates.ts";
import { errorText } from "@hepi/protocol/error-text";

/**
 * The Workspace Resource Loader (ADR 0002): skills, prompt templates, system/append prompts and context files are all
 * discovered and read through the conversation's ExecutionEnv, on the execution host and account that environment
 * actually runs as. Nothing here reads the harness filesystem, and a host that cannot be reached or read is an error
 * rather than a reason to fall back to harness-local content.
 *
 * Discovery rules, frontmatter parsing and prompt formatting come from
 * `@earendil-works/pi-coding-agent@1.1.0` (MIT, earendil-works/pi at revision 6fb2e7815167e6b19006fc526d1a5d0f5f998787):
 * `dist/core/skills.js` for skill discovery, ignore files and collision handling, `dist/core/prompt-templates.js` for
 * prompt templates, and `dist/core/resource-loader.js` for context and system/append prompt precedence. The linked
 * worktree context shadow rule and the package/extension resource kinds are deliberately not adapted.
 *
 * The adopted result is conversation-owned durable state: a restored conversation renders the committed catalog, so a
 * runtime restart is not a hidden reload and host changes enter only through an explicit Reload (ticket 03). A load
 * that fails for any candidate commits a failed state and blocks only the attempted run.
 */

/** One discovered execution-side resource, as advertised to the model and persisted with the conversation. */
export type ResourceCatalogEntry = {
  kind: "skill" | "prompt";
  name: string;
  description: string;
  /** Real execution-host path, readable by ordinary file tools. */
  location: string;
  /** Directory relative references resolve against. */
  baseDir: string;
  scope: ResourceRoot["scope"];
  /** Prompt templates only: the template body the command expands. */
  content?: string;
  disableModelInvocation?: boolean;
};

export type LoadedResourceState = {
  status: "loaded";
  user: string;
  home: string;
  workspaceRoot: string;
  roots: string[];
  systemPrompt?: { path: string; content: string };
  appendPrompt?: { path: string; content: string };
  contextFiles: { path: string; content: string }[];
  catalog: ResourceCatalogEntry[];
  /** Rendered system-prompt contribution, committed so restart replays it instead of rediscovering. */
  prefix: string;
  loadedAtMs: number;
};

/** What one conversation adopted from its execution host, or why the initial load failed. */
export type WorkspaceResourceState = LoadedResourceState | { status: "failed"; error: string; loadedAtMs: number };

/**
 * Conversation-owned adopted resource result. `adopted` is the promoted baseline; a successful Reload while a run is
 * active commits its candidate here instead, waiting for the next run. `deferredForRun` is the run
 * (`pi.live.run.inputs[0]`, stable across a run's generations) that was active when the candidate committed, so a
 * render for that run keeps the baseline and successive reloads inside one run cannot revert it to an earlier result.
 */
export type WorkspaceResourcesDocValue = {
  adopted?: WorkspaceResourceState;
  candidate?: WorkspaceResourceState;
  deferredForRun?: number;
};

export const WorkspaceResourcesDoc = defineDoc<WorkspaceResourcesDocValue>({
  kind: "hepi.workspace-resources",
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
  // Version 1 stored the single committed result as `state`; that result was the adopted baseline.
  migrate: (value) => (value.state === undefined ? {} : { adopted: value.state as WorkspaceResourceState }),
});

/** What a client needs to know about committed resource state; `pending` marks a reload waiting for the next run. */
export type ResourceSummary =
  | { status: "loaded"; skills: number; prompts: number; loadedAtMs: number; pending: boolean }
  | { status: "failed"; error: string; pending: boolean };

export type WorkspaceResourcesOptions = {
  /** Whether project `.pi` prompts and project system/append prompts load, as upstream project trust decides. */
  readonly projectTrusted?: boolean;
  /** Whether `/skill:<name>` commands are listed, from Pi's own `enableSkillCommands` setting. Default true. */
  readonly enableSkillCommands?: boolean;
  /** Where discovery diagnostics go. Defaults to `console.warn`. */
  readonly diagnostics?: (message: string) => void;
};

export type WorkspaceResources = {
  /** Fixed application extension: the `resources` prompt section. */
  readonly extension: Extension;
  /** Discover the complete catalog from the execution host. Throws when a candidate cannot be read or parsed. */
  discover(env: ExecutionHostEnv | undefined, context: Context): Promise<WorkspaceResourceState>;
  /** Commands of an adopted catalog: prompt templates by name, skills as `skill:<name>` unless disabled. */
  commands(state: WorkspaceResourceState): { name: string; description: string; source: "prompt" | "skill" }[];
  /** Expand one `/skill:<name>` or prompt-template command, reading skill bodies from their real host paths. */
  expand(state: WorkspaceResourceState, env: ExecutionHostEnv | undefined, text: string, context: Context): Promise<string>;
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"] as const;

/**
 * One discovered entry: the logical path the walk reached, its canonical target, and the target's kind. A link is
 * followed by its target, so a link to a file is not walked as a directory.
 */
type ResolvedEntry = { path: string; real: string; kind: string };

/**
 * What a resource walk needs from an execution environment: the host it runs on, and reads of that host's files. One
 * discovery's snapshot answers every one of them from memory, so the walk below is the same walk a live host would be
 * given and the loader stays the one authority on precedence, ignore rules and frontmatter.
 */
type SnapshotReader = Pick<ExecutionHostEnv, "executionHost" | "listDir" | "canonicalPath" | "readTextFile" | "fileInfo">;

/**
 * The context file a linked git worktree shadows, when the host reports one. Upstream drops that file from the ancestor
 * chain because the worktree's own file is the one in effect. Computing it needs host git metadata — the nearest
 * `.git`, a `.git` file's `gitdir:`, the `commondir` file, and whether `<main repo>/.git` is the common git directory —
 * none of which this loader may read, since the loader only reads resource roots and the workspace. The gateway
 * therefore resolves that path on the host and this loader only subtracts it. See docs/execution-side-skills.md.
 */
export type ShadowedContextHost = { readonly shadowedContextFile?: string };

/**
 * Context files with the shadowed one removed, the upstream `loadProjectContextFiles` filter: both sides are canonical
 * host paths, so a file that appears again under another name is not hidden.
 */
export function visibleContextFiles(contextFiles: readonly string[], shadowedContextFile: string | undefined): string[] {
  return contextFiles.filter((path) => path !== shadowedContextFile);
}

export function createWorkspaceResources(options: WorkspaceResourcesOptions = {}): WorkspaceResources {
  const report = options.diagnostics ?? ((message: string) => console.warn("workspace-resources: " + message));
  const projectTrusted = options.projectTrusted ?? false;
  const enableSkillCommands = options.enableSkillCommands ?? true;

  async function discover(env: ExecutionHostEnv | undefined, context: Context): Promise<WorkspaceResourceState> {
    const loadedAtMs = Date.now();
    // A plain ExecutionEnv cannot read its resources in one snapshot, so it is refused instead of guessing a home
    // directory and walking the host one file at a time. An unreachable host fails here; nothing falls back to
    // harness-local content (ADR 0002).
    if (env === undefined || typeof env.resourceSnapshot !== "function") throw new Error("the conversation has no execution environment that can read its execution-side resources");
    const snapshot = await env.resourceSnapshot(context);
    if (!snapshot.ok) throw snapshot.error;
    const view = snapshotEnvironment(snapshot.value);
    const host = snapshot.value.host;
    const skills: ResourceCatalogEntry[] = [];
    const prompts: ResourceCatalogEntry[] = [];
    const seenPaths = new Set<string>();
    for (const root of host.roots) {
      // Project and ancestor `.agents/skills` resources are host content the operator placed there, not Pi packages:
      // they load whether or not the project is trusted, exactly as ticket 01 established. The workspace's own `.pi`
      // skills and prompts follow upstream's project-trust rule (`addAutoDiscoveredResources`), which the gateway marks
      // on the root.
      if (root.requiresTrust === true && !projectTrusted) continue;
      if (root.kind === "skills") skills.push(...await discoverSkills(view, root, context, seenPaths));
      else prompts.push(...await discoverPrompts(view, root, context, seenPaths));
    }
    const catalog = [...uniqueByName(skills, "skill"), ...uniqueByName(prompts, "prompt")];
    const systemPrompt = await readPromptFile(view, choose(host.systemPromptFiles), context);
    const appendPrompt = await readPromptFile(view, choose(host.appendSystemPromptFiles), context);
    const contextFiles: { path: string; content: string }[] = [];
    for (const path of visibleContextFiles(host.contextFiles, (host as ExecutionHost & ShadowedContextHost).shadowedContextFile)) {
      contextFiles.push({ path, content: await requiredText(view, path, context) });
    }
    const prefix = renderPrefix(systemPrompt, appendPrompt, contextFiles, catalog);
    return { status: "loaded", user: host.user, home: host.home, workspaceRoot: host.workspaceRoot, roots: host.roots.map((root) => root.path), ...(systemPrompt === undefined ? {} : { systemPrompt }), ...(appendPrompt === undefined ? {} : { appendPrompt }), contextFiles, catalog, prefix, loadedAtMs };
  }

  /**
   * The nearest candidate of one prompt name: a project file replaces the account file when the project is trusted, and
   * the account file is the only candidate otherwise (upstream `discoverSystemPromptFile`).
   */
  function choose(files: readonly { scope: "project" | "global"; path: string }[]): string | undefined {
    if (projectTrusted) {
      const project = files.find((file) => file.scope === "project");
      if (project !== undefined) return project.path;
    }
    return files.find((file) => file.scope === "global")?.path;
  }

  async function readPromptFile(env: SnapshotReader, path: string | undefined, context: Context): Promise<{ path: string; content: string } | undefined> {
    return path === undefined ? undefined : { path, content: await requiredText(env, path, context) };
  }

  /**
   * The rendered system-prompt contribution in upstream order: system prompt, append prompt, project context, skills.
   * `dist/core/system-prompt.js` `buildSystemPromptSections` places `addendum` (the append prompt) before
   * `project_context` and `skills`, and renders context inside `<project_instructions path="...">` elements.
   */
  function renderPrefix(systemPrompt: { path: string; content: string } | undefined, appendPrompt: { path: string; content: string } | undefined, contextFiles: readonly { path: string; content: string }[], catalog: readonly ResourceCatalogEntry[]): string {
    const parts: string[] = [];
    if (systemPrompt !== undefined) parts.push(systemPrompt.content.trimEnd());
    if (appendPrompt !== undefined) parts.push(appendPrompt.content.trimEnd());
    if (contextFiles.length > 0) {
      parts.push(["Project-specific instructions and guidelines:", ...contextFiles.map((file) => '<project_instructions path="' + file.path + '">\n' + file.content + "\n</project_instructions>")].join("\n\n"));
    }
    const skills = catalog.filter((entry) => entry.kind === "skill");
    const metadata = formatSkillsForPrompt(skills.map(toUpstreamSkill), "read").trim();
    if (metadata !== "") parts.push(metadata);
    return parts.filter((part) => part !== "").join("\n\n");
  }

  /**
   * Skills below one resource root, applying the verified upstream rules of `dist/core/skills.js`
   * `loadSkillsFromDirInternal`: a directory holding `SKILL.md` is one skill and is not searched further, a directory
   * without one contributes its `.md` children, subdirectories are searched recursively, hidden entries and
   * `node_modules` are skipped, and `.gitignore`/`.ignore`/`.fdignore` rules filter the tree by the logical entry path.
   * Symlinks are followed when they resolve inside the same root, as upstream follows them; the same file reached twice
   * is adopted once by canonical path (`loadSkills` `realPathSet`) and the same directory is walked once per root, so a
   * link to a directory that contains itself terminates.
   */
  async function discoverSkills(env: SnapshotReader, root: ResourceRoot, context: Context, seenPaths: Set<string>): Promise<ResourceCatalogEntry[]> {
    const found: ResourceCatalogEntry[] = [];
    const matcher = new ResourceIgnoreRules();
    await walkSkills(env, root.path, root.path, root.scope, context, matcher, found, seenPaths, new Set());
    return found;
  }

  /**
   * One directory of a resource root. Traversal, listing and ignore-file prefixes all use the logical path, as upstream
   * walks it, so a rule matches the names the operator wrote rather than a link's target and a link's own directory
   * keeps its own rules. A link whose target is a directory of the same root already entered — itself, an ancestor, or
   * any other directory — is walked once per root: the directory actually entered is recorded by canonical path. A
   * directory the walk never entered, because an ignore rule excluded it, is not recorded, so a link can still reach it.
   */
  async function walkSkills(env: SnapshotReader, dir: string, rootPath: string, scope: ResourceRoot["scope"], context: Context, matcher: ResourceIgnoreRules, found: ResourceCatalogEntry[], seenPaths: Set<string>, visitedDirs: Set<string>): Promise<void> {
    // The directory really entered, by canonical path. A link that leads back into the tree already walked — including
    // to the root itself, where an unguarded walk would descend the same link forever — is visited once, while a
    // directory the walk never entered, because an ignore rule excluded it, is not recorded and does not shadow it.
    const entered = await canonical(env, dir, context);
    if (entered === undefined) return;
    if (visitedDirs.has(entered)) return;
    visitedDirs.add(entered);
    await addIgnoreRules(matcher, env, dir, rootPath, context);
    const listing = await entries(env, dir, context);
    if (listing === undefined) return;
    const declared = listing.find((entry) => entry.name === "SKILL.md");
    if (declared !== undefined) {
      const resolved = await resolveEntry(env, rootPath, posix.join(dir, declared.name), declared.kind, context);
      if (resolved !== undefined && resolved.kind === "file" && !matcher.ignores(posix.relative(rootPath, resolved.path))) {
        await adopt(env, resolved, scope, context, found, seenPaths);
      }
      return;
    }
    for (const entry of listing) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const logical = posix.join(dir, entry.name);
      const resolved = await resolveEntry(env, rootPath, logical, entry.kind, context);
      if (resolved === undefined) continue;
      const relative = posix.relative(rootPath, resolved.path);
      if (matcher.ignores(resolved.kind === "directory" ? relative + "/" : relative)) continue;
      if (resolved.kind === "directory") { await walkSkills(env, resolved.path, rootPath, scope, context, matcher, found, seenPaths, visitedDirs); continue; }
      if (resolved.kind !== "file" || !entry.name.endsWith(".md")) continue;
      await adopt(env, resolved, scope, context, found, seenPaths);
    }
  }

  /** One candidate file, adopted once per canonical path: the same file reached by two links is one skill. */
  async function adopt(env: SnapshotReader, resolved: ResolvedEntry, scope: ResourceRoot["scope"], context: Context, found: ResourceCatalogEntry[], seenPaths: Set<string>): Promise<void> {
    const key = (await canonical(env, resolved.real, context)) ?? resolved.real;
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    const skill = await readSkill(env, resolved.real, scope, context);
    if (skill === undefined) seenPaths.delete(key);
    else found.push(skill);
  }

  /** The `.md` files directly in one prompts root, non-recursive as upstream `loadTemplatesFromDir` is. */
  async function discoverPrompts(env: SnapshotReader, root: ResourceRoot, context: Context, seenPaths: Set<string>): Promise<ResourceCatalogEntry[]> {
    const matcher = new ResourceIgnoreRules();
    await addIgnoreRules(matcher, env, root.path, root.path, context);
    const listing = await entries(env, root.path, context);
    if (listing === undefined) return [];
    const found: ResourceCatalogEntry[] = [];
    for (const entry of listing) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || !entry.name.endsWith(".md")) continue;
      const logical = posix.join(root.path, entry.name);
      const resolved = await resolveEntry(env, root.path, logical, entry.kind, context);
      if (resolved === undefined || resolved.kind !== "file") continue;
      if (matcher.ignores(posix.relative(root.path, resolved.path))) continue;
      const key = (await canonical(env, resolved.real, context)) ?? resolved.real;
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      found.push(await readPrompt(env, resolved.real, root.scope, context));
    }
    return found;
  }

  /**
   * One entry as its logical path, its canonical target and the kind of that target. The logical path is the one the
   * host walk reached, which is what upstream matches ignore rules against; the gateway's directory listings report
   * canonical paths, so the loader rebuilds the logical path from the directory it is walking and the entry name. A
   * symlink is followed only when its target resolves inside its own resource root; an escaping or broken link is
   * skipped and reported, because a resource root is the only host location this loader is authorized to read. The
   * canonical target is what deduplication and file reads use.
   */
  async function resolveEntry(env: SnapshotReader, rootPath: string, logical: string, kind: string, context: Context): Promise<ResolvedEntry | undefined> {
    if (kind !== "symlink") return { path: logical, real: logical, kind };
    const real = await canonical(env, logical, context);
    if (real === undefined || !inside(rootPath, real)) {
      report("execution-side resource " + logical + " resolves outside " + rootPath + " and was skipped");
      return undefined;
    }
    const info = await env.fileInfo(real, context);
    if (!info.ok) throw new Error("execution-side resource " + real + " could not be read: " + info.error.message);
    return { path: logical, real, kind: info.value.kind };
  }

  /** One skill file: upstream's frontmatter parser, a required description, and the file's real host path. */
  async function readSkill(env: SnapshotReader, filePath: string, scope: ResourceRoot["scope"], context: Context): Promise<ResourceCatalogEntry | undefined> {
    const text = await requiredText(env, filePath, context);
    const { frontmatter } = parse(text, filePath);
    const description = frontmatter.description;
    if (typeof description !== "string" || description.trim() === "") {
      // A `SKILL.md` without a description is a declared skill that cannot be advertised, so the load fails rather
      // than silently dropping it. A loose `.md` file is not a declared skill, so it is simply not one.
      if (posix.basename(filePath) === "SKILL.md") throw new Error("execution-side skill " + filePath + " has no description");
      return undefined;
    }
    const declared = frontmatter.name;
    const baseDir = posix.dirname(filePath);
    const name = typeof declared === "string" && declared !== "" ? declared : posix.basename(baseDir);
    return { kind: "skill", name, description, location: filePath, baseDir, scope, disableModelInvocation: frontmatter["disable-model-invocation"] === true };
  }

  /** One prompt template, named and described as upstream `loadTemplateFromFile` does. */
  async function readPrompt(env: SnapshotReader, filePath: string, scope: ResourceRoot["scope"], context: Context): Promise<ResourceCatalogEntry> {
    const text = await requiredText(env, filePath, context);
    const { frontmatter, body } = parse(text, filePath);
    let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
    if (description === "") {
      const firstLine = body.split("\n").find((line) => line.trim() !== "");
      if (firstLine !== undefined) description = firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
    }
    return { kind: "prompt", name: posix.basename(filePath).replace(/\.md$/, ""), description, location: filePath, baseDir: posix.dirname(filePath), scope, content: body };
  }

  /** One name is one resource: the first path in load order wins and every later one is reported, as upstream does. */
  function uniqueByName(items: readonly ResourceCatalogEntry[], kind: string): ResourceCatalogEntry[] {
    const winners = new Map<string, ResourceCatalogEntry>();
    for (const item of items) {
      const winner = winners.get(item.name);
      if (winner === undefined) { winners.set(item.name, item); continue; }
      report(kind + " " + item.name + " from " + item.location + " was skipped: " + winner.location + " already declares that name");
    }
    return [...winners.values()];
  }

  function commands(state: WorkspaceResourceState): { name: string; description: string; source: "prompt" | "skill" }[] {
    if (state.status !== "loaded") return [];
    // Pi's `enableSkillCommands` setting decides whether skill commands are listed; a skill body stays readable either
    // way, exactly as upstream lists commands and reads skill files independently.
    return state.catalog
      .filter((entry) => entry.kind !== "skill" || enableSkillCommands)
      .map((entry) => ({ name: entry.kind === "skill" ? "skill:" + entry.name : entry.name, description: entry.description, source: entry.kind }));
  }

  /**
   * Command expansion. The catalog comes from the adopted state, so a command never rediscovers the host; a skill body
   * is read from its real host path at the moment the command runs, and relative references resolve against that
   * directory (adapted from PI-Desktop `apps/desktop/electron/main/skill-document.ts` `formatSkillToolContent`,
   * revision ed54ce9774c41cefb5d0cdcdf922de7e6df22621).
   */
  async function expand(state: WorkspaceResourceState, env: ExecutionHostEnv | undefined, text: string, context: Context): Promise<string> {
    if (state.status !== "loaded" || !text.startsWith("/")) return text;
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (match === null) return text;
    const name = match[1]!;
    const argsString = match[2] ?? "";
    if (name.startsWith("skill:")) {
      const skill = state.catalog.find((entry) => entry.kind === "skill" && entry.name === name.slice("skill:".length));
      if (skill === undefined || env === undefined) return text;
      const body = await requiredText(env, skill.location, context);
      const args = parseCommandArgs(argsString);
      const block = '<skill name="' + skill.name + '" location="' + skill.location + '">\nReferences are relative to ' + skill.baseDir + "/.\n\n" + stripFrontmatter(body).trimEnd() + "\n</skill>";
      return args.length === 0 ? block : block + "\n\n" + args.join(" ");
    }
    const template = state.catalog.find((entry) => entry.kind === "prompt" && entry.name === name);
    if (template === undefined) return text;
    return substituteArgs(template.content ?? "", parseCommandArgs(argsString));
  }

  /** The committed catalog, or nothing when this conversation has not adopted one yet. */
  const extension = defineExtension({
    name: "workspace-resources",
    sections: [section("resources", (input, context) => renderAdopted(input.read, input.conversationId, context))],
  });

  return { extension, discover, commands, expand };
}

/**
 * The result a render or a command expansion must use: the promoted baseline, or the deferred candidate when it was
 * committed for an earlier run than the one active now. A candidate tagged with the active run is not in effect, so an
 * in-flight run (including its steering, retries and tool rounds) keeps the prefix it adopted, and a reload during that
 * run applies to the next one. A read, not a write.
 */
export async function readEffectiveResources(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<WorkspaceResourceState | undefined> {
  const doc = await read.snapshot(WorkspaceResourcesDoc, conversationId, context);
  if (doc === undefined) return undefined;
  return effectiveState(doc, await activeRunInput(read, conversationId, context));
}

/** The result in effect for one document value and the active run's input ID. */
function effectiveState(doc: WorkspaceResourcesDocValue, runInput: number | undefined): WorkspaceResourceState | undefined {
  const deferred = doc.candidate !== undefined && doc.deferredForRun !== undefined && doc.deferredForRun === runInput;
  return doc.candidate !== undefined && !deferred ? doc.candidate : doc.adopted;
}

/** `pi.live.run.inputs[0]`: the ID that stays fixed across one run's generations, retries and tool rounds. */
async function activeRunInput(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<number | undefined> {
  return (await read.snapshot(LiveDoc, conversationId, context))?.run?.inputs[0];
}

/**
 * The one initialisation path for a conversation without committed resource state: discover the complete catalog from
 * the execution host and commit it as one value. A load failure is committed as a failed state, so the conversation can
 * report it and retry; it is then rethrown to the caller, which scopes the failure to that attempted run.
 */
export async function ensureAdoptedResources(conversation: ConversationTx, read: DocumentReader, resources: WorkspaceResources, env: ExecutionHostEnv | undefined, context: Context): Promise<WorkspaceResourceState> {
  const existing = await readEffectiveResources(read, conversation.id, context);
  if (existing?.status === "loaded") return existing;
  const state = await discoverOrFail(resources, env, context);
  await conversation.commit(async (tx) => { (await tx.doc(WorkspaceResourcesDoc, conversation.id)).adopted = state; }, context);
  if (state.status === "failed") throw new Error(state.error);
  return state;
}

/**
 * Reload: discover a complete candidate loading result, then commit it in one transaction that also reads the run
 * status. An active run keeps its adopted baseline and the candidate is deferred to the next run; an idle conversation
 * adopts it at once. A discovery failure throws before any commit, so the previous prefix and catalog are untouched and
 * the caller reports an explicit error.
 */
export async function reloadResources(conversation: ConversationTx, resources: WorkspaceResources, env: ExecutionHostEnv | undefined, context: Context): Promise<void> {
  const candidate = await resources.discover(env, context);
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    const doc = await tx.doc(WorkspaceResourcesDoc, conversation.id);
    const runInput = live.run?.inputs[0];
    if (runInput === undefined) {
      doc.adopted = candidate;
      delete doc.candidate;
      delete doc.deferredForRun;
      return;
    }
    // A candidate deferred for an earlier run is the baseline the active run adopted; promote it before recording this
    // run's candidate, so repeated reloads inside one run cannot revert the run to an earlier result.
    if (doc.candidate !== undefined && doc.deferredForRun !== runInput) doc.adopted = doc.candidate;
    doc.candidate = candidate;
    doc.deferredForRun = runInput;
  }, context);
}

/** One discovery pass, with a candidate failure captured as a failed state instead of thrown. */
async function discoverOrFail(resources: WorkspaceResources, env: ExecutionHostEnv | undefined, context: Context): Promise<WorkspaceResourceState> {
  try {
    return await resources.discover(env, context);
  } catch (error) {
    return { status: "failed", error: errorText(error), loadedAtMs: Date.now() };
  }
}

/** The committed state as a client-safe summary; `pending` marks a candidate deferred to the next run. */
export async function resourceSummary(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<ResourceSummary> {
  const doc = await read.snapshot(WorkspaceResourcesDoc, conversationId, context);
  const runInput = await activeRunInput(read, conversationId, context);
  // Deferred: committed while the run now active was active, so it applies to the next run. Once that run ends the
  // candidate is already the effective result, so it is no longer pending.
  const pending = doc?.candidate !== undefined && runInput !== undefined && doc.deferredForRun === runInput;
  const effective = doc === undefined ? undefined : effectiveState(doc, runInput);
  if (effective?.status !== "loaded") return { status: "failed", error: effective?.error ?? "no resource loading result has been committed", pending };
  return { status: "loaded", skills: effective.catalog.filter((entry) => entry.kind === "skill").length, prompts: effective.catalog.filter((entry) => entry.kind === "prompt").length, loadedAtMs: effective.loadedAtMs, pending };
}

/** The transaction-committing surface these helpers need from a conversation. */
export type ConversationTx = { readonly id: ConversationId; commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> };

/**
 * The adopted prefix, read from committed state. A conversation without one renders no section; the run path commits
 * one before the first resource-dependent run. `undefined` is the section API's "omit this section".
 */
export async function renderAdopted(read: DocumentReader, conversationId: ConversationId, context: Context): Promise<string | undefined> {
  const state = await readEffectiveResources(read, conversationId, context);
  return state === undefined || state.status !== "loaded" || state.prefix === "" ? undefined : state.prefix;
}

/** The upstream prompt formatter needs a skill with its real path and a source description. */
function toUpstreamSkill(skill: ResourceCatalogEntry): Skill {
  return { name: skill.name, description: skill.description, filePath: skill.location, baseDir: skill.baseDir, sourceInfo: createSyntheticSourceInfo(skill.location, { source: "local", scope: skill.scope === "global" ? "user" : "project", baseDir: skill.baseDir }), disableModelInvocation: skill.disableModelInvocation === true };
}

/**
 * Frontmatter parsing through upstream's parser. A YAML error is a malformed candidate resource, which fails the whole
 * load instead of dropping one file's content from the adopted result.
 */
function parse(text: string, filePath: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    return parseFrontmatter(text);
  } catch {
    throw new Error("execution-side resource " + filePath + " has malformed frontmatter");
  }
}

/**
 * One discovery's snapshot as an environment. Every path the walk reached on the host is answered from the snapshot: a
 * directory by its entries, a path by its canonical target, a file by the text the host already read for it, and a
 * link's target by the kind the host reported for it. A path the snapshot does not hold is absent, exactly as an absent
 * file is on the host — the snapshot is the whole scope set, so nothing else can be reached through it.
 *
 * A path the host could not read answers with that failure rather than with absence, so the walk fails on the path it
 * would have failed on and walks past the ones it never opens. Reading a directory the walk never enters, or a file
 * beside a declared skill, is not a discovery failure on the host either.
 */
function snapshotEnvironment(snapshot: ResourceSnapshot): SnapshotReader {
  const directories = new Map<string, { entries: readonly SnapshotEntry[] }>();
  const unreadable = new Map<string, SnapshotFailure>();
  const byPath = new Map<string, SnapshotEntry>();
  const byReal = new Map<string, SnapshotEntry>();
  const canonical = new Map<string, string>();
  const files = new Map<string, SnapshotFile>();
  const failed = (failure: SnapshotFailure): { ok: false; error: FileError } => ({ ok: false, error: new FileError(failure.code, failure.message) });
  for (const directory of snapshot.directories) {
    // The canonical target is recorded for an unreadable directory too: it resolved, so the walk enters it and meets
    // the failure at the listing, which is where a per-file walk would have met it.
    canonical.set(directory.path, directory.real);
    canonical.set(directory.real, directory.real);
    if (!("entries" in directory)) { unreadable.set(directory.path, directory.failure); continue; }
    directories.set(directory.path, directory);
    for (const entry of directory.entries) {
      byPath.set(entry.info.path, entry);
      byReal.set(entry.real, entry);
      // A link that resolves to nothing has no canonical target, exactly as `realpath` refuses one on the host, so it
      // is left out of the canonical map and the walk reports it as unresolvable instead of following it.
      if (entry.realKind === "missing") continue;
      canonical.set(entry.info.path, entry.real);
      canonical.set(entry.real, entry.real);
    }
  }
  for (const file of snapshot.files) {
    files.set(file.path, file);
    files.set(file.real, file);
  }
  const absent = (path: string): { ok: false; error: FileError } => ({ ok: false, error: new FileError("not_found", "execution-side resource " + path + " is not part of this discovery's snapshot") });
  return {
    executionHost: async () => ({ ok: true, value: snapshot.host }),
    listDir: async (path: string) => {
      const failure = unreadable.get(path);
      if (failure !== undefined) return failed(failure);
      const directory = directories.get(path);
      return directory === undefined ? absent(path) : { ok: true, value: directory.entries.map((entry) => entry.info) };
    },
    canonicalPath: async (path: string) => {
      const real = canonical.get(path);
      return real === undefined ? absent(path) : { ok: true, value: real };
    },
    readTextFile: async (path: string) => {
      const file = files.get(path);
      if (file === undefined) return absent(path);
      return "text" in file ? { ok: true, value: file.text } : failed(file.failure);
    },
    fileInfo: async (path: string) => {
      const entry = byPath.get(path) ?? byReal.get(path);
      if (entry === undefined || entry.realKind === "missing") return absent(path);
      return { ok: true, value: entry.info.path === path ? entry.info : { ...entry.info, path, kind: entry.realKind } };
    },
  };
}

/** One directory's entries, through the execution environment. Absence is empty; any other failure is raised. */
async function entries(env: SnapshotReader, path: string, context: Context): Promise<{ name: string; path: string; kind: string }[] | undefined> {
  const result = await env.listDir(path, context);
  if (result.ok) return result.value;
  const code = result.error.code;
  if (code === "not_found" || code === "not_directory") return undefined;
  throw new Error("execution-side resource directory " + path + " could not be read: " + result.error.message);
}

/** One host file's text, through the execution environment. Absence is undefined; any other failure is raised. */
async function optionalText(env: SnapshotReader, path: string, context: Context): Promise<string | undefined> {
  const result = await env.readTextFile(path, context);
  if (result.ok) return result.value;
  const code = result.error.code;
  if (code === "not_found" || code === "is_directory") return undefined;
  throw new Error("execution-side resource " + path + " could not be read: " + result.error.message);
}

/** One host file's text that must exist: an unreadable candidate resource fails the load. */
async function requiredText(env: SnapshotReader, path: string, context: Context): Promise<string> {
  const text = await optionalText(env, path, context);
  if (text === undefined) throw new Error("execution-side resource " + path + " could not be read");
  return text;
}

/** One path's canonical form through the execution environment; an absent or refused path is simply unresolvable. */
async function canonical(env: SnapshotReader, path: string, context: Context): Promise<string | undefined> {
  const result = await env.canonicalPath(path, context);
  if (result.ok) return result.value;
  const code = result.error.code;
  if (code === "not_found" || code === "not_directory" || code === "permission_denied" || code === "invalid") return undefined;
  throw new Error("execution-side resource " + path + " could not be resolved: " + result.error.message);
}

/** Whether `path` is `root` itself or below it. */
function inside(root: string, path: string): boolean {
  const child = posix.relative(root, path);
  return child === "" || (!child.startsWith("../") && child !== ".." && !posix.isAbsolute(child));
}

/**
 * The ignore rules of one resource root, accumulated per directory through the same `ResourceIgnoreRules` the
 * execution-side snapshot applies while it walks. One implementation, used twice on the same tree, is what keeps the
 * snapshot's pruning and the loader's own decisions in step: the loader reads the same files and reaches the same
 * answer, and the host side never had to guess what a resource is.
 */
async function addIgnoreRules(rules: ResourceIgnoreRules, env: SnapshotReader, dir: string, rootPath: string, context: Context): Promise<void> {
  const relativeDir = posix.relative(rootPath, dir);
  const prefix = relativeDir === "" ? "" : relativeDir + "/";
  for (const name of IGNORE_FILE_NAMES) {
    const text = await optionalText(env, posix.join(dir, name), context);
    if (text !== undefined) rules.addText(text, prefix);
  }
}
