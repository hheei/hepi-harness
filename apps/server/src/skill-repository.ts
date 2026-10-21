import { DatabaseSync } from "node:sqlite";

/**
 * The Skill Repository: it stores and versions Skill Bundles and answers market browsing. It never supplies content
 * to agent execution and holds no execution role (ADR 0002); installing a bundle onto a host is ticket 06 work.
 *
 * Metadata lives in its own SQLite database, independent of conversation history. Curated GitHub sources are read
 * through plain HTTPS and cached in memory for five minutes, keyed by the commit the source's branch resolved to. A
 * source's revision is reported as the resolved commit SHA, not the branch name: the branch is a moving target and the
 * SHA is what the content actually came from.
 *
 * A bundle is a whole directory: its SKILL.md is the document, and every other file it carries is stored verbatim,
 * including scripts and binaries. Text is stored as UTF-8 and binary as base64, so nothing is decoded, rewritten or
 * lost on the way to the host. Stored content is never executed here - not when it is published, and not when it is read.
 */

export type MarketFetch = (url: string, kind: "json" | "text" | "base64") => Promise<unknown>;

/** One curated GitHub source, read at its branch's current commit. */
export type MarketSource = { readonly id: string; readonly owner: string; readonly repo: string; readonly branch: string };

export type MarketSkillSource =
  | { readonly kind: "repository"; readonly name: string; readonly version: string }
  | { readonly kind: "github"; readonly repository: string; readonly revision: string; readonly path: string };

export type MarketSkill = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: MarketSkillSource;
  /** A repository bundle advertises its own version; a curated source has none. */
  readonly version?: string;
};

/**
 * One file of a bundle. The encoding says how the content is written to the host: utf8 is the file's text and base64
 * is its bytes. There is no third case: a bundle file is either text or bytes, never a link.
 */
export type MarketFile = { readonly path: string; readonly content: string; readonly encoding: "utf8" | "base64" };
export type BundleFileInput = { path: string; content: string; encoding?: "utf8" | "base64" };

export type MarketDocument = { readonly markdown: string; readonly files: readonly MarketFile[] };
export type MarketPreview = { readonly skill: MarketSkill; readonly markdown: string; readonly files: readonly MarketFile[] };
export type MarketListing = { readonly skills: readonly MarketSkill[]; readonly unavailableSources: readonly string[] };
/**
 * One query against the skills.sh public catalog: the hits that could be pinned to a revision, and what could not be
 * offered. A hit is dropped for one of four distinct reasons, and they stay distinct: a source that could not be read
 * at all is not the same fact as a repository that holds no such document, and neither is the same as a document this
 * module cannot choose between. An unreachable catalog is reported, never returned as an empty result.
 */
export type MarketSearchMissReason = "unreadable" | "no-document" | "ambiguous" | "unbounded" | "not-github";
export type MarketSearchMiss = { readonly source: string; readonly reason: MarketSearchMissReason };
export type MarketSearchResult = { readonly skills: readonly MarketSkill[]; readonly unavailable: readonly MarketSearchMiss[] };
export type PublishInput = { name: string; version: string; description?: string; category?: string; markdown: string; files?: readonly BundleFileInput[] };
export type PublishResult = { readonly ok: true; readonly skill: MarketSkill } | { readonly ok: false; readonly status: number; readonly error: string };
/** One stored version, without content: the SKILL.md plus every other file path it carries. */
export type BundleSummary = { readonly version: string; readonly description: string; readonly category: string; readonly files: readonly string[] };
export type Bundle = { readonly skill: MarketSkill; readonly markdown: string; readonly files: readonly MarketFile[] };

export type SkillMarket = {
  list(): Promise<MarketListing>;
  /** Query the skills.sh public catalog; a hit is pinned to its repository's commit before it is offered. */
  search(query: string): Promise<MarketSearchResult>;
  /**
   * The commit an already-installed GitHub document lives at **now**, and a new pinned selection for it. Called only by
   * an explicit user check or update: the inventory never resolves a commit, so browsing a host's skills makes no
   * GitHub request. The document's own recorded path is read, never a name matched from it, because the installed
   * document is the fact being asked about: a repository that no longer holds that path answers nothing.
   */
  refresh(input: { readonly repository: string; readonly documentPath: string }): Promise<{ readonly revision: string; readonly id: string } | undefined>;
  preview(id: string): Promise<MarketPreview | undefined>;
  publish(input: PublishInput): PublishResult;
  /** Every bundle name the repository holds, for the management view. */
  names(): Promise<string[]>;
  /** Every version of one bundle, without content. */
  versions(name: string): Promise<BundleSummary[]>;
  retrieve(name: string, version: string): Promise<Bundle | undefined>;
  close(): void;
};

export type SkillMarketOptions = {
  /** SQLite path for repository metadata; independent of the conversation database. */
  path: string;
  sources?: readonly MarketSource[];
  fetch?: MarketFetch;
  /** Cache clock, injectable so a test proves the five-minute window without waiting. */
  now?: () => number;
};

export const CURATED_SOURCES: readonly MarketSource[] = [
  { id: "anthropics", owner: "anthropics", repo: "skills", branch: "main" },
  { id: "mattpocock", owner: "mattpocock", repo: "skills", branch: "main" },
];

const CACHE_TTL_MS = 5 * 60_000;
/** The public catalog searched alongside the repository's own bundles; a source, never a third installation target. */
const SKILLS_SH_API = "https://skills.sh/api/search";
export const SKILLS_SH_SOURCE = "skills.sh";
/** The most hits one skills.sh query is asked for; a catalog page, not a crawl. */
const SEARCH_LIMIT = 50;
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
/**
 * How many documents one catalog hit may read while looking for a frontmatter name, so a query stays a query. It is
 * also the point past which a name lookup stops proving anything: a unique match among a prefix of the documents is
 * not a unique match in the repository, so a repository with more documents than this is reported rather than guessed
 * about (unless the hit was matched authoritatively, which needs no reading at all).
 */
const MAX_NAME_LOOKUPS = 25;

/** Two documents match one catalog row's name. The caller reports this as its own reason; neither candidate is chosen. */
class MarketSearchAmbiguous extends Error {
  constructor(repository: string) { super("ambiguous document for " + repository); }
}

/**
 * More documents than one query may read, and none of them matched authoritatively, so a frontmatter lookup could not
 * prove the name unique. Reported instead of offering a result that might be contradicted by a document not read.
 */
class MarketSearchUnbounded extends Error {
  constructor(repository: string) { super("too many documents to prove a name in " + repository); }
}

/** A skill document is a file called exactly SKILL.md: `MYSKILL.md` merely ends in the same letters. */
function isSkillDocument(path: string): boolean {
  return path === "SKILL.md" || path.endsWith("/SKILL.md");
}
/**
 * A catalog hit's own id, which carries the repository, the commit and the SKILL.md path it was pinned to. The pin is
 * in the id itself rather than in process memory, so a preview or an installation after a restart resolves the same
 * content, and never a branch that has moved since the query.
 */
const SKILLS_SH_ID = /^skills-sh:([\w.-]+\/[\w.-]+)@([0-9a-f]{7,64}):(.+)$/;
/** The reason words one search answer reports, so a caller can localize them instead of parsing prose. */
export const MARKET_SEARCH_MISS_REASONS: readonly MarketSearchMissReason[] = ["unreadable", "no-document", "ambiguous", "unbounded", "not-github"];
/** A curated preview reads at most this many files, so one huge source cannot stall a browse. */
const MAX_CURATED_FILES = 50;
/** The most files one published bundle may carry; the request body limit already caps the bytes. */
const MAX_BUNDLE_FILES = 200;
/** The five categories the lean market filters by; the UI offers the same set. */
export const MARKET_CATEGORIES = ["workflow", "writing", "coding", "data", "docs"] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number];

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** File kinds that travel as bytes; everything else is read as text. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "tar", "xz", "zst", "7z", "jar", "war",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "webm", "wav", "ogg", "flac",
  "xlsx", "xls", "docx", "pptx", "odt", "ods", "sqlite", "db",
  "so", "dylib", "dll", "exe", "bin", "wasm", "node", "pyc", "class",
]);

/** Keyword categories adapted from PI-Desktop's skill market scan (see apps/server/vendor/pi-desktop/README.md). */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [MarketCategory, readonly string[]]> = [
  ["data", ["data", "sql", "database", "analytics", "dataset", "spreadsheet", "excel", "xlsx", "csv", "dashboard", "chart"]],
  ["workflow", ["workflow", "review", "planning", "checklist", "process", "handoff", "retro", "audit", "security", "triage", "verification"]],
  ["coding", ["code", "test", "debug", "api", "git-", "dev", "engineer", "typescript", "python", "react", "frontend", "backend", "refactor", "deploy", "lint", "mcp", "agent", "script", "automation", "cli"]],
  ["writing", ["writing", "write", "comms", "email", "blog", "content", "copy", "editorial", "story", "article", "newsletter", "summar", "art", "design", "creative", "gif", "image", "poster", "diagram", "logo", "typography"]],
  ["docs", ["doc", "pdf", "pptx", "docx", "word", "slide", "presentation", "report", "wiki", "manual", "guide", "readme", "changelog", "brand", "canvas", "theme"]],
];

export function guessCategory(text: string): MarketCategory {
  const haystack = text.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(keyword => haystack.includes(keyword))) return category;
  }
  return "workflow";
}

/** The frontmatter name and description of a skill document; its metadata, not its body. */
export function describeSkill(markdown: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (match === null) return {};
  const read = (key: string): string | undefined => {
    const line = new RegExp("^" + key + ":\\s*(.+)$", "m").exec(match[1]!);
    if (line === null) return undefined;
    const value = line[1]!.trim().replace(/^["']|["']$/g, "");
    return value === "" ? undefined : value;
  };
  const name = read("name");
  const description = read("description");
  return { ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) };
}

/**
 * A bundle file path is relative, portable, and cannot leave the bundle directory or collide with the bundle's own
 * SKILL.md. The collision check ignores case because a host filesystem may not distinguish the two names, and a
 * nested skill directory's own SKILL.md belongs to that skill, not to this bundle.
 */
export function safeBundlePath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > 256) return false;
  if (path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return false;
  const segments = path.split("/");
  if (!segments.every(segment => segment !== "" && segment !== "." && segment !== "..")) return false;
  return segments[segments.length - 1]!.toLowerCase() !== "skill.md";
}

/** Whether a bundle file travels as bytes rather than as text. */
export function binaryPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function invalidFile(file: BundleFileInput | undefined): string | undefined {
  if (typeof file?.content !== "string") return "every bundle file needs string content";
  if (!safeBundlePath(file?.path)) return "bundle file paths must be relative paths inside the bundle, without a SKILL.md of their own";
  if (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64") return "bundle file encoding must be utf8 or base64";
  if (file.encoding === "base64" && (file.content.length % 4 !== 0 || !BASE64_PATTERN.test(file.content))) return "a base64 bundle file must carry valid base64 content";
  return undefined;
}

type BundleRow = { name: string; version: string; description: string; category: string; markdown: string; created_at: number };
type FileRow = { path: string; content: string; encoding: string };

export function createSkillMarket(options: SkillMarketOptions): SkillMarket {
  const now = options.now ?? Date.now;
  const sources = options.sources ?? CURATED_SOURCES;
  const request: MarketFetch = options.fetch ?? (async (url, kind) => {
    const response = await fetch(url, { headers: { accept: kind === "json" ? "application/json" : "application/octet-stream" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
    if (kind === "json") return await response.json();
    if (kind === "text") return await response.text();
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  });
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS skill_bundles (name TEXT NOT NULL, version TEXT NOT NULL, description TEXT NOT NULL, category TEXT NOT NULL, markdown TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (name, version))");
  db.exec("CREATE TABLE IF NOT EXISTS skill_bundle_files (name TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, content TEXT NOT NULL, encoding TEXT NOT NULL, PRIMARY KEY (name, version, path))");

  const catalogCache = new Map<string, { at: number; entries: MarketSkill[] }>();
  const documentCache = new Map<string, { at: number; document: MarketDocument }>();
  const searchCache = new Map<string, { at: number; result: MarketSearchResult }>();
  /** The commit one repository's current content lives at, so one query decides a commit and keeps it. */
  const treeCache = new Map<string, { at: number; commit: string }>();

  function fresh<T>(cache: Map<string, { at: number } & T>, key: string): T | undefined {
    const hit = cache.get(key);
    if (hit === undefined || now() - hit.at >= CACHE_TTL_MS) return undefined;
    return hit;
  }

  const json = (url: string) => request(url, "json") as Promise<Record<string, unknown>>;
  const text = (url: string) => request(url, "text") as Promise<string>;
  const repositoryUrl = (source: MarketSource) => source.owner + "/" + source.repo;

  /** The commit a source's branch currently points at; the honest revision of everything read from that source. */
  async function resolveRevision(source: MarketSource): Promise<string> {
    const body = await json("https://api.github.com/repos/" + repositoryUrl(source) + "/branches/" + source.branch);
    const sha = (body.commit as { sha?: unknown } | undefined)?.sha;
    if (typeof sha !== "string" || !REVISION_PATTERN.test(sha)) throw new Error("no commit for " + repositoryUrl(source));
    return sha;
  }

  /**
   * The blobs of a source at one commit. Trees, submodules and symlinks are dropped: a bundle carries regular files
   * only, so nothing in it can point somewhere else on the host.
   */
  async function treeBlobs(repository: string, revision: string): Promise<{ path: string; type: string }[]> {
    const [owner, repo] = repository.split("/");
    const tree = await json("https://api.github.com/repos/" + owner + "/" + repo + "/git/trees/" + revision + "?recursive=1");
    return (tree.tree as { path?: unknown; type?: unknown }[] | undefined ?? []).flatMap(item =>
      typeof item.path === "string" ? [{ path: item.path, type: typeof item.type === "string" ? item.type : "blob" }] : []);
  }

  /** One file of a repository at a pinned revision, as raw bytes GitHub serves without the API's rate limits. */
  function rawRepoFile(repository: string, revision: string, path: string): string {
    const [owner, repo] = repository.split("/");
    return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + revision + "/" + path;
  }

  async function curatedSkills(source: MarketSource): Promise<MarketSkill[]> {
    const revision = await resolveRevision(source);
    const repository = repositoryUrl(source);
    const skills: MarketSkill[] = [];
    for (const entry of await treeBlobs(repository, revision)) {
      // `template/` holds the scaffolding shape, not an installable skill, and a symlink is not a file.
      if (entry.type !== "blob" || !entry.path.endsWith("/SKILL.md") || entry.path.startsWith("template/")) continue;
      const directory = entry.path.slice(0, -"/SKILL.md".length);
      const name = directory.split("/").pop()!;
      skills.push({ id: source.id + ":" + directory, name, description: "", category: guessCategory(directory + " " + name), source: { kind: "github", repository, revision, path: entry.path } });
    }
    return skills;
  }

  /** Read one file at its pinned revision, as text or as base64 bytes. */
  async function readFile(url: string, path: string): Promise<MarketFile> {
    return binaryPath(path)
      ? { path, content: await request(url, "base64") as string, encoding: "base64" }
      : { path, content: await text(url), encoding: "utf8" };
  }

  /**
   * A curated skill's whole subtree at its pinned revision: the SKILL.md plus every other regular file below its
   * directory, with a nested skill's own directory left to that skill's market entry.
   */
  async function curatedDocument(source: { repository: string; revision: string; path: string }): Promise<MarketDocument> {
    const key = source.repository + "@" + source.revision + "/" + source.path;
    const hit = fresh(documentCache, key);
    if (hit !== undefined) return hit.document;
    const raw = (path: string) => rawRepoFile(source.repository, source.revision, path);
    const markdown = await text(raw(source.path));
    const directory = source.path.slice(0, -"SKILL.md".length);
    const blobs = (await treeBlobs(source.repository, source.revision)).filter(entry => entry.type === "blob" && entry.path.startsWith(directory));
    // A nested skill's own directory belongs to that skill's market entry, not to this bundle.
    const nestedRoots = blobs
      .filter(entry => entry.path !== source.path && entry.path.endsWith("/SKILL.md"))
      .map(entry => entry.path.slice(directory.length, -"SKILL.md".length));
    const files: MarketFile[] = [];
    for (const entry of blobs) {
      if (entry.path === source.path) continue;
      const path = entry.path.slice(directory.length);
      if (nestedRoots.some(root => path.startsWith(root))) continue;
      if (!safeBundlePath(path)) continue;
      if (files.length >= MAX_CURATED_FILES) break;
      files.push(await readFile(raw(entry.path), path));
    }
    const document: MarketDocument = { markdown, files };
    documentCache.set(key, { at: now(), document });
    return document;
  }

  /** A document path is relative, inside its repository, and names a SKILL.md: nothing else is a skill document. */
  function safeDocumentPath(path: string): boolean {
    if (typeof path !== "string" || path === "" || path.length > 256) return false;
    if (path.startsWith("/") || path.includes("\\") || path.endsWith("/")) return false;
    const segments = path.split("/");
    if (!segments.every(segment => segment !== "" && segment !== "." && segment !== "..")) return false;
    return segments[segments.length - 1] === "SKILL.md";
  }

  /** A search hit read back from its own id: the same repository, commit and document path that were shown. */
  function pinnedSkill(id: string): MarketSkill | undefined {
    const match = SKILLS_SH_ID.exec(id);
    if (match === null || !safeDocumentPath(match[3]!)) return undefined;
    const [repository, revision, path] = [match[1]!, match[2]!, match[3]!];
    const directory = path === "SKILL.md" ? repository.split("/")[1]! : path.slice(0, -"/SKILL.md".length).split("/").pop()!;
    return { id, name: directory, description: "", category: guessCategory(id), source: { kind: "github", repository, revision, path } };
  }

  function curatedSkillById(id: string): MarketSkill | undefined {
    const pinned = pinnedSkill(id);
    if (pinned !== undefined) return pinned;
    for (const cache of catalogCache.values()) {
      const found = cache.entries.find(entry => entry.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * The skills.sh public catalog, queried through the same injected fetch the curated sources use, so a controlled
   * transport covers it and nothing is downloaded here. A hit names a repository and a skill id, not content: the
   * repository's current commit and the SKILL.md inside it are resolved before the hit is offered, because a branch is
   * a moving target and an installation must record the revision its bytes actually came from. Each hit is therefore
   * registered under an id that carries its own pin, which is what a later preview and installation read.
   *
   * A hit this module cannot pin is not offered: an ambiguous directory (two skills declaring the same name), a
   * repository that cannot be read, or a tree without a matching SKILL.md leaves the hit out and the reason is
   * reported, rather than a result the host would have to guess about.
   */
  async function search(query: string): Promise<MarketSearchResult> {
    const key = query.trim().toLocaleLowerCase();
    const cached = fresh(searchCache, key);
    if (cached !== undefined) return cached.result;
    let body: Record<string, unknown>;
    try {
      body = await json(SKILLS_SH_API + "?q=" + encodeURIComponent(query) + "&limit=" + SEARCH_LIMIT);
    } catch {
      // A catalog that cannot be read is a failed source, not an empty result: the caller names it and shows the rest.
      const result: MarketSearchResult = { skills: [], unavailable: [{ source: SKILLS_SH_SOURCE, reason: "unreadable" }] };
      searchCache.set(key, { at: now(), result });
      return result;
    }
    const hits = Array.isArray(body.skills) ? body.skills as Record<string, unknown>[] : [];
    const misses = new Map<string, MarketSearchMiss>();
    const skills: MarketSkill[] = [];
    for (const hit of hits) {
      const repository = typeof hit.source === "string" ? hit.source.trim() : "";
      // A catalog row that is not a GitHub coordinate is not something this module can pin. It is reported as that
      // reason rather than skipped silently, and it never stops the rows beside it: one bad row is one bad row.
      if (!REPOSITORY_PATTERN.test(repository) || repository.split("/").length !== 2) {
        const source = repository === "" ? "unknown source" : repository;
        misses.set(source + "\u0000not-github", { source, reason: "not-github" });
        continue;
      }
      const name = typeof hit.skillId === "string" && hit.skillId !== "" ? hit.skillId : typeof hit.name === "string" ? hit.name : "";
      if (name === "") continue;
      let pinned: { revision: string; path: string } | undefined;
      try {
        pinned = await pinHit(repository, name);
      } catch (error) {
        // An ambiguous directory is this module refusing to choose for the user; anything else is the repository not
        // being readable at all. Both are one hit's own failure, isolated per repository, and neither empties the
        // answer or touches the rows beside it.
        const reason: MarketSearchMissReason = error instanceof MarketSearchAmbiguous ? "ambiguous" : error instanceof MarketSearchUnbounded ? "unbounded" : "unreadable";
        misses.set(repository + "\u0000" + reason, { source: repository, reason });
        continue;
      }
      if (pinned === undefined) {
        misses.set(repository + "\u0000no-document", { source: repository, reason: "no-document" });
        continue;
      }
      const id = "skills-sh:" + repository + "@" + pinned.revision + ":" + pinned.path;
      // An id this module will not read back (a path over its own length bound, say) is not offered: the row would be
      // a selection that cannot be resolved, and reporting it is the honest answer.
      const skill = pinnedSkill(id);
      if (skill === undefined) { misses.set(repository + "\u0000no-document", { source: repository, reason: "no-document" }); continue; }
      if (!skills.some(entry => entry.id === id)) skills.push(skill);
    }
    const result: MarketSearchResult = { skills, unavailable: [...misses.values()].sort((left, right) => left.source.localeCompare(right.source)) };
    searchCache.set(key, { at: now(), result });
    return result;
  }

  /**
   * The commit one catalog hit's SKILL.md is read at, and the document's path within it. A directory whose last
   * segment is the requested name is authoritative and settles the hit without reading anything. Otherwise every
   * skill document in the repository — the root one included, on equal footing — is read and its frontmatter name
   * compared: exactly one match is the hit, two or more are ambiguous, and none is no document. The repository's own
   * name is a fact about the catalog row, not about any document, so it is not evidence for the root document or for
   * anything else.
   *
   * The tree is decided **once**, here, and everything after this reads the commit it named: the offered id carries
   * the commit and the exact path, so a later list refresh, a five-minute cache expiry, a branch that has since moved
   * or a backend restart cannot retarget the content the user was shown. The commit is also an immutable git object,
   * so re-reading the same tree from it is the same bytes.
   */
  async function pinHit(repository: string, name: string): Promise<{ revision: string; path: string } | undefined> {
    const revision = await defaultCommit(repository);
    const documents = (await treeBlobs(repository, revision)).filter(entry => entry.type === "blob" && isSkillDocument(entry.path) && !entry.path.startsWith("template/"));
    const wanted = name.toLocaleLowerCase();
    const segment = (path: string) => path === "SKILL.md" ? "" : path.slice(0, -"/SKILL.md".length).split("/").pop()!;
    const direct = documents.filter(entry => segment(entry.path).toLocaleLowerCase() === wanted);
    if (direct.length === 1) return { revision, path: direct[0]!.path };
    // Two directories named for the requested skill are a choice this module does not make for the user.
    if (direct.length > 1) throw new MarketSearchAmbiguous(repository);
    // No directory settles it, so every document is read once and the ones that declare the requested name are
    // collected. The root is one of them, not a privileged fallback: a root that declares another name is not an
    // answer to a question about this name, and a root that declares this one is only an answer if no other document
    // declares it too. Stopping at the root would hide that second match.
    //
    // A repository with more documents than one query may read cannot be decided this way: a unique match among the
    // documents it did read proves nothing about the ones it did not, so it is reported, never offered.
    if (documents.length > MAX_NAME_LOOKUPS) throw new MarketSearchUnbounded(repository);
    const named: string[] = [];
    for (const entry of documents) {
      const described = describeSkill(await text(rawRepoFile(repository, revision, entry.path)));
      if (described.name?.toLocaleLowerCase() === wanted) named.push(entry.path);
      if (named.length > 1) throw new MarketSearchAmbiguous(repository);
    }
    if (named.length === 1) return { revision, path: named[0]! };
    return undefined;
  }

  /**
   * The commit a repository's current content lives at, and the tree to read it from. The repository's own default
   * branch is read and that branch's **commit** is asked for: the branches answer carries the commit the branch points
   * at (`commit.sha` is a commit, not a tree), and GitHub's `git/trees` endpoint accepts that commit and resolves the
   * tree inside it. The commit is therefore the one thing this reads, and it is what gets pinned.
   *
   * The default branch is never assumed. A repository whose metadata cannot be read, or that does not name a default
   * branch, has not said which branch its content lives on; reading `main` anyway would be a guess about the user's
   * selection, so the repository is reported as unreadable instead. (A repository whose default branch is `master` is
   * not such a repository: it said so, and it is read like any other.)
   */
  async function defaultCommit(repository: string, current = false): Promise<string> {
    // A check asks about **now**, so it reads past the cache: a branch that moved since the last query has moved, and
    // answering from a cached commit would report the user's installation as current when it is not. Everything that
    // resolves a selection reads the cached commit, so one query decides one commit and every read of it agrees.
    const cached = current ? undefined : fresh(treeCache, repository);
    if (cached !== undefined) return cached.commit;
    const { owner, repo } = { owner: repository.split("/")[0]!, repo: repository.split("/")[1]! };
    const info = await json("https://api.github.com/repos/" + owner + "/" + repo);
    const branch = info.default_branch;
    if (typeof branch !== "string" || branch === "") throw new Error("no default branch for " + repository);
    const answer = await json("https://api.github.com/repos/" + owner + "/" + repo + "/branches/" + branch);
    const commit = (answer.commit as { sha?: unknown } | undefined)?.sha;
    if (typeof commit !== "string" || !REVISION_PATTERN.test(commit)) throw new Error("no commit for " + repository);
    treeCache.set(repository, { at: now(), commit });
    return commit;
  }

  function bundleRows(name?: string, version?: string): BundleRow[] {
    if (name === undefined) return db.prepare("SELECT * FROM skill_bundles ORDER BY name, version").all() as unknown as BundleRow[];
    if (version === undefined) return db.prepare("SELECT * FROM skill_bundles WHERE name = ? ORDER BY version").all(name) as unknown as BundleRow[];
    return db.prepare("SELECT * FROM skill_bundles WHERE name = ? AND version = ?").all(name, version) as unknown as BundleRow[];
  }

  function fileRows(name: string, version: string): FileRow[] {
    return db.prepare("SELECT path, content, encoding FROM skill_bundle_files WHERE name = ? AND version = ? ORDER BY path").all(name, version) as unknown as FileRow[];
  }

  function bundleSkill(row: BundleRow): MarketSkill {
    return { id: "repository:" + row.name + "@" + row.version, name: row.name, version: row.version, description: row.description, category: row.category, source: { kind: "repository", name: row.name, version: row.version } };
  }

  async function list(): Promise<MarketListing> {
    const unavailableSources: string[] = [];
    const curated: MarketSkill[] = [];
    const settled = await Promise.allSettled(sources.map(async source => {
      const key = repositoryUrl(source);
      const hit = fresh(catalogCache, key);
      if (hit !== undefined) return hit.entries;
      const entries = await curatedSkills(source);
      catalogCache.set(key, { at: now(), entries });
      return entries;
    }));
    settled.forEach((result, index) => {
      const source = sources[index]!;
      // One unreachable source must not empty the market: it is reported by name, and the rest still list.
      if (result.status === "rejected") unavailableSources.push(repositoryUrl(source));
      else curated.push(...result.value);
    });
    return { skills: [...curated, ...bundleRows().map(bundleSkill)], unavailableSources };
  }

  /**
   * One skill's document and files. A stored bundle is read at its version, and a search hit is read at the commit and
   * path its own id carries — neither of those asks the catalog anything, so a refresh, a cache expiry or a restart
   * cannot change what a selection resolves to.
   *
   * A legacy curated id (`<source>:<directory>`) carries no commit of its own, because it was minted before search
   * existed. It still resolves, through the curated listing, and the revision it resolves at is the one its preview
   * reports — which is the revision an installation then records, so the **installation** is still pinned to a commit
   * rather than to a branch. What such an id cannot promise is that two previews minutes apart name the same commit;
   * that is what a pinned search id exists for, and the panel offers pinned ids for every new selection.
   */
  async function preview(id: string): Promise<MarketPreview | undefined> {
    const stored = /^repository:([^@]+)@(.+)$/.exec(id);
    if (stored !== null) return await retrieve(stored[1]!, stored[2]!);
    // A pinned hit is resolved from its own id alone: no listing, no cache lookup, nothing that can move under it.
    const pinned = pinnedSkill(id);
    if (pinned !== undefined) {
      const document = await curatedDocument(pinned.source as { repository: string; revision: string; path: string });
      const described = describeSkill(document.markdown);
      return { skill: { ...pinned, name: described.name ?? pinned.name, description: described.description ?? "" }, markdown: document.markdown, files: document.files };
    }
    await list();
    const curated = curatedSkillById(id);
    if (curated === undefined || curated.source.kind !== "github") return undefined;
    const document = await curatedDocument(curated.source);
    const described = describeSkill(document.markdown);
    return { skill: { ...curated, name: described.name ?? curated.name, description: described.description ?? "" }, markdown: document.markdown, files: document.files };
  }

  function publish(input: PublishInput): PublishResult {
    if (typeof input.name !== "string" || !NAME_PATTERN.test(input.name)) return { ok: false, status: 400, error: "bundle name must be a lowercase slug" };
    if (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) return { ok: false, status: 400, error: "bundle version must be a semantic version" };
    if (typeof input.markdown !== "string" || input.markdown.trim() === "") return { ok: false, status: 400, error: "bundle markdown is required" };
    const files = input.files ?? [];
    if (files.length > MAX_BUNDLE_FILES) return { ok: false, status: 400, error: "a bundle carries at most " + MAX_BUNDLE_FILES + " files" };
    const seen = new Set<string>();
    for (const file of files) {
      const invalid = invalidFile(file);
      if (invalid !== undefined) return { ok: false, status: 400, error: invalid };
      const key = file.path.toLowerCase();
      if (seen.has(key)) return { ok: false, status: 400, error: "bundle file paths must be unique: " + file.path };
      seen.add(key);
    }
    // A published version is immutable: republishing it is a conflict, never an overwrite.
    if (bundleRows(input.name, input.version).length > 0) return { ok: false, status: 409, error: "that bundle version already exists" };
    const category = input.category !== undefined && (MARKET_CATEGORIES as readonly string[]).includes(input.category) ? input.category : guessCategory(input.name + " " + (input.description ?? ""));
    db.exec("BEGIN");
    try {
      db.prepare("INSERT INTO skill_bundles (name, version, description, category, markdown, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.name, input.version, input.description ?? "", category, input.markdown, now());
      for (const file of files) db.prepare("INSERT INTO skill_bundle_files (name, version, path, content, encoding) VALUES (?, ?, ?, ?, ?)").run(input.name, input.version, file.path, file.content, file.encoding ?? "utf8");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, skill: bundleSkill(bundleRows(input.name, input.version)[0]!) };
  }

  async function names(): Promise<string[]> {
    return (db.prepare("SELECT DISTINCT name FROM skill_bundles ORDER BY name").all() as unknown as { name: string }[]).map(row => row.name);
  }

  async function versions(name: string): Promise<BundleSummary[]> {
    return bundleRows(name).map(row => ({ version: row.version, description: row.description, category: row.category, files: ["SKILL.md", ...fileRows(row.name, row.version).map(file => file.path)] }));
  }

  async function retrieve(name: string, version: string): Promise<Bundle | undefined> {
    const row = bundleRows(name, version)[0];
    if (row === undefined) return undefined;
    return { skill: bundleSkill(row), markdown: row.markdown, files: fileRows(name, version).map(file => ({ path: file.path, content: file.content, encoding: file.encoding === "base64" ? "base64" as const : "utf8" as const })) };
  }

  /**
   * The current commit of one installed document. The repository's own default branch is resolved (never assumed), and
   * the recorded path must still exist in that commit's tree: a moved or renamed document is not a newer revision of
   * what was installed, so it answers nothing rather than proposing a different skill. The answer carries a fresh
   * pinned id in the same shape a search hit uses, so the update that follows is the existing installation path and the
   * content it publishes is pinned to the commit it was read at.
   */
  async function refresh(input: { repository: string; documentPath: string }): Promise<{ revision: string; id: string } | undefined> {
    if (!REPOSITORY_PATTERN.test(input.repository) || input.repository.split("/").length !== 2) return undefined;
    if (!safeDocumentPath(input.documentPath)) return undefined;
    let revision: string;
    try {
      revision = await defaultCommit(input.repository, true);
    } catch {
      // A repository that cannot be read at all has not said anything about a newer revision, so the caller reports the
      // question as unanswered rather than as up to date.
      return undefined;
    }
    const present = (await treeBlobs(input.repository, revision)).some(entry => entry.type === "blob" && entry.path === input.documentPath);
    if (!present) return undefined;
    return { revision, id: "skills-sh:" + input.repository + "@" + revision + ":" + input.documentPath };
  }

  return { list, search, refresh, preview, publish, names, versions, retrieve, close: () => db.close() };
}

export type SkillMarketRouteResult = { readonly status: number; readonly body: unknown } | undefined;

/**
 * The market's HTTP surface, kept here so server.ts only forwards authenticated requests. It reads and mutates no
 * conversation state, so browsing and publishing are decoupled from active sessions.
 */
export async function skillMarketRoute(market: SkillMarket, method: string, pathname: string, search: URLSearchParams, body: unknown): Promise<SkillMarketRouteResult> {
  if (method === "GET" && pathname === "/api/skill-market/skills") return { status: 200, body: await market.list() };
  // The skills.sh catalog is searched through the repository's own injected fetch, so one query is answered here and
  // what could not be offered is named, with its reason, rather than reported as an empty result.
  if (method === "GET" && pathname === "/api/skill-market/search") {
    const query = search.get("q");
    if (query === null || query.trim() === "") return { status: 400, body: { error: "q is required" } };
    const found = await market.search(query);
    return { status: 200, body: { skills: found.skills, unavailable: found.unavailable } };
  }
  if (method === "GET" && pathname === "/api/skill-market/preview") {
    const id = search.get("id");
    if (id === null || id === "") return { status: 400, body: { error: "id is required" } };
    const preview = await market.preview(id);
    return preview === undefined ? { status: 404, body: { error: "unknown skill" } } : { status: 200, body: preview };
  }
  if (pathname === "/api/skill-market/bundles") {
    if (method === "GET") {
      const name = search.get("name");
      // Without a name the repository lists what it holds, which is what the management view opens on.
      if (name === null || name === "") return { status: 200, body: { names: await market.names() } };
      const version = search.get("version");
      if (version === null) return { status: 200, body: { bundles: await market.versions(name) } };
      const bundle = await market.retrieve(name, version);
      return bundle === undefined ? { status: 404, body: { error: "unknown bundle version" } } : { status: 200, body: { bundle } };
    }
    if (method === "POST") {
      if (typeof body !== "object" || body === null) return { status: 400, body: { error: "bundle is required" } };
      const published = market.publish(body as PublishInput);
      return published.ok ? { status: 201, body: { skill: published.skill } } : { status: published.status, body: { error: published.error } };
    }
  }
  return undefined;
}
