import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createSkillMarket, type MarketFetch } from "../src/skill-repository.ts";

const directories: string[] = [];
const token = "test-token";
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const SOURCES = [
  { id: "anthropics", owner: "anthropics", repo: "skills", branch: "main" },
  { id: "mattpocock", owner: "mattpocock", repo: "skills", branch: "main" },
];

/** A PNG's first bytes, so the round-trip test carries content that is not text at all. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe]);
const PNG_BASE64 = PNG_BYTES.toString("base64");

/**
 * Deterministic GitHub fixture: branch, tree and pinned raw documents, with every request recorded. The tree carries
 * a symlink and a nested skill directory, so a preview has to prove it drops the link and leaves the nested skill to
 * its own market entry.
 */
function github(state: { calls: string[]; offline?: string }): MarketFetch {
  const trees: Record<string, { path: string; type: string }[]> = {
    "anthropics/skills@aaaa1111": [
      { path: "skills/pdf/SKILL.md", type: "blob" },
      { path: "skills/pdf/reference.md", type: "blob" },
      { path: "skills/pdf/scripts/fill.py", type: "blob" },
      { path: "skills/pdf/assets/logo.png", type: "blob" },
      { path: "skills/pdf/escape.md", type: "symlink" },
      { path: "skills/pdf/nested/SKILL.md", type: "blob" },
      { path: "skills/pdf/nested/extra.md", type: "blob" },
      { path: "skills/frontend-design/SKILL.md", type: "blob" },
      { path: "template/SKILL.md", type: "blob" },
    ],
    "mattpocock/skills@bbbb2222": [
      { path: "skills/engineering/tdd/SKILL.md", type: "blob" },
      { path: "skills/engineering/tdd/tests.md", type: "blob" },
      { path: "README.md", type: "blob" },
    ],
  };
  const documents: Record<string, string> = {
    "anthropics/skills@aaaa1111/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF Processing Guide\n",
    "anthropics/skills@aaaa1111/skills/pdf/reference.md": "# Reference\n",
    "anthropics/skills@aaaa1111/skills/pdf/scripts/fill.py": "print('fill')\n",
    "anthropics/skills@aaaa1111/skills/pdf/nested/SKILL.md": "---\nname: nested\n---\n# Nested\n",
    "anthropics/skills@aaaa1111/skills/pdf/nested/extra.md": "# Extra\n",
    "mattpocock/skills@bbbb2222/skills/engineering/tdd/SKILL.md": "---\nname: tdd\ndescription: Test-driven development\n---\n# TDD\n",
  };
  return async (url, kind) => {
    state.calls.push(url);
    if (state.offline !== undefined && url.includes(state.offline)) throw new Error("source unavailable");
    const branch = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/.exec(url);
    if (branch !== null) return { commit: { sha: branch[1] === "anthropics/skills" ? "aaaa1111" : "bbbb2222" } };
    const tree = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
    if (tree !== null) return { tree: trees[tree[1] + "@" + tree[2]] ?? [] };
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url);
    if (raw !== null) {
      const path = raw[1] + "@" + raw[2] + "/" + raw[3];
      if (path.endsWith("assets/logo.png")) {
        if (kind !== "base64") throw new Error("a binary file must be read as bytes: " + url);
        return PNG_BASE64;
      }
      const body = documents[path];
      if (body === undefined) throw new Error("404 " + url);
      if (kind !== "text") throw new Error("a text file must be read as text: " + url);
      return body;
    }
    throw new Error("unexpected " + kind + " " + url);
  };
}

/**
 * The skills.sh catalog beside the curated sources: one repository whose tree holds two skills, a query endpoint that
 * answers with catalog rows (a repository plus a skill id, never content), and a repository entry that names its
 * default branch. Nothing here is a real network call.
 */
function catalog(state: { calls: string[]; offline?: string; repositoryOffline?: string; defaultBranch?: string; revision?: string }): MarketFetch {
  const trees: Record<string, { path: string; type: string }[]> = {
    "owner/one@cccc3333": [
      { path: "skills/alpha/SKILL.md", type: "blob" },
      { path: "skills/alpha/notes.md", type: "blob" },
      { path: "skills/beta/SKILL.md", type: "blob" },
      { path: "skills/twin-a/SKILL.md", type: "blob" },
      { path: "skills/twin-b/SKILL.md", type: "blob" },
    ],
    // The same repository after its branch moved: alpha's bytes differ, so any read that followed the branch instead
    // of the pinned commit would preview or install different content.
    "owner/one@dddd4444": [
      { path: "skills/alpha/SKILL.md", type: "blob" },
      { path: "skills/alpha/notes.md", type: "blob" },
      { path: "skills/twin-a/SKILL.md", type: "blob" },
      { path: "skills/twin-b/SKILL.md", type: "blob" },
    ],
    // A repository whose default branch is master, which is not a repository that cannot be read.
    "owner/legacy@eeee5555": [{ path: "legacy-skill/SKILL.md", type: "blob" }],
  };
  const documents: Record<string, string> = {
    "owner/one@cccc3333/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n",
    "owner/one@cccc3333/skills/alpha/notes.md": "# Notes\n",
    "owner/one@cccc3333/skills/beta/SKILL.md": "---\nname: beta\ndescription: Beta skill\n---\n# Beta\n",
    "owner/one@cccc3333/skills/twin-a/SKILL.md": "---\nname: twin\n---\n# Twin A\n",
    "owner/one@cccc3333/skills/twin-b/SKILL.md": "---\nname: twin\n---\n# Twin B\n",
    "owner/one@dddd4444/skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha (moved branch)\n",
    "owner/one@dddd4444/skills/alpha/notes.md": "# Notes (moved branch)\n",
    "owner/legacy@eeee5555/legacy-skill/SKILL.md": "---\nname: legacy\ndescription: Legacy skill\n---\n# Legacy\n",
  };
  return async (url, kind) => {
    state.calls.push(url);
    if (state.offline !== undefined && url.includes(state.offline)) throw new Error("source unavailable");
    if (state.repositoryOffline !== undefined && url.includes(state.repositoryOffline)) throw new Error("repository unavailable");
    if (url.startsWith("https://skills.sh/api/search")) {
      return { query: "alpha", searchType: "fuzzy", count: 3, duration_ms: 1, skills: [
        { id: "owner/one/alpha", skillId: "alpha", name: "alpha", installs: 12, source: "owner/one" },
        // A row whose skill id matches no directory and no frontmatter name: nothing here, reported as such.
        { id: "owner/one/unknown", skillId: "missing", name: "missing", installs: 3, source: "owner/one" },
        // A row whose id matches no directory while two documents declare that frontmatter name: ambiguous, and never
        // offered as a result the user would have to guess about.
        { id: "owner/one/twin", skillId: "twin", name: "twin", installs: 2, source: "owner/one" },
        // A row that is not a GitHub coordinate this module can pin.
        { id: "other/thing", skillId: "thing", name: "thing", installs: 1, source: "skills.volces.com" },
        // A row in a repository that cannot be read, and a row for a repository whose default branch is master.
        { id: "owner/broken/broken", skillId: "broken", name: "broken", installs: 2, source: "owner/broken" },
        { id: "owner/legacy/legacy-skill", skillId: "legacy", name: "legacy", installs: 1, source: "owner/legacy" },
      ] };
    }
    const branch = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(branches|git\/trees)\/([^?]+)(\?recursive=1)?$/.exec(url);
    if (branch !== null) {
      if (branch[2] === "branches") {
        if (branch[1] === "owner/broken") throw new Error("no such branch");
        if (branch[1] === "owner/legacy") return { commit: { sha: "eeee5555" } };
        return { commit: { sha: state.revision ?? "cccc3333" } };
      }
      return { tree: trees[branch[1] + "@" + branch[3]] ?? [] };
    }
    if (/^https:\/\/api\.github\.com\/repos\/owner\/broken$/.test(url)) throw new Error("repository unavailable");
    if (/^https:\/\/api\.github\.com\/repos\/owner\/legacy$/.test(url)) return { default_branch: "master" };
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return { default_branch: state.defaultBranch ?? "main" };
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url);
    if (raw !== null) {
      const body = documents[raw[1] + "@" + raw[2] + "/" + raw[3]];
      if (body === undefined) throw new Error("404 " + url);
      if (kind !== "text") throw new Error("a text file must be read as text: " + url);
      return body;
    }
    throw new Error("unexpected " + kind + " " + url);
  };
}

/**
 * A second controlled catalog for the rules that must never be guessed at: a repository whose metadata cannot be read
 * while a \`main\` branch exists, a repository whose root SKILL.md declares a name other than the requested one, a
 * repository with more documents than one query may inspect, file names that merely *end* in \`SKILL.md\`, and a healthy
 * repository beside every one of them.
 */
function awkwardCatalog(state: { calls: string[] }): MarketFetch {
  const wide = Array.from({ length: 30 }, (_, index) => ({ path: "skills/s" + String(index).padStart(2, "0") + "/SKILL.md", type: "blob" }));
  const trees: Record<string, { path: string; type: string }[]> = {
    "owner/denied@aaaa1111": [{ path: "skills/denied/SKILL.md", type: "blob" }],
    "owner/rooty@bbbb2222": [{ path: "SKILL.md", type: "blob" }],
    "owner/true-root@cccc3333": [{ path: "SKILL.md", type: "blob" }],
    "owner/suffix@dddd4444": [{ path: "MYSKILL.md", type: "blob" }, { path: "docs/NOTSKILL.md", type: "blob" }, { path: "skills/real/SKILL.md", type: "blob" }],
    "owner/wide@eeee5555": wide,
    "owner/fine@ffff6666": [{ path: "skills/fine/SKILL.md", type: "blob" }],
    "owner/twice@77778888": [{ path: "SKILL.md", type: "blob" }, { path: "skills/other/SKILL.md", type: "blob" }],
    "owner/name-only@9999aaaa": [{ path: "SKILL.md", type: "blob" }, { path: "skills/actual/SKILL.md", type: "blob" }],
  };
  const documents: Record<string, string> = {
    "owner/denied@aaaa1111/skills/denied/SKILL.md": "---\nname: denied\n---\n# Denied\n",
    "owner/rooty@bbbb2222/SKILL.md": "---\nname: bar\ndescription: The repository's own root skill\n---\n# Bar\n",
    "owner/true-root@cccc3333/SKILL.md": "---\nname: true-root\n---\n# True root\n",
    "owner/suffix@dddd4444/MYSKILL.md": "---\nname: my\n---\n# Not a skill document\n",
    "owner/suffix@dddd4444/docs/NOTSKILL.md": "---\nname: not\n---\n# Not a skill document either\n",
    "owner/suffix@dddd4444/skills/real/SKILL.md": "---\nname: real\n---\n# Real\n",
    "owner/fine@ffff6666/skills/fine/SKILL.md": "---\nname: fine\n---\n# Fine\n",
    // Both the root and a nested directory declare the requested name: the root is not the answer just because it is
    // the root, so this is a choice the module does not make.
    "owner/twice@77778888/SKILL.md": "---\nname: twice\n---\n# Root twice\n",
    "owner/twice@77778888/skills/other/SKILL.md": "---\nname: twice\n---\n# Nested twice\n",
    // The repository is named for the requested skill, but its root declares something else while a nested directory
    // declares the requested name. A repository name is not evidence about a document's contents.
    "owner/name-only@9999aaaa/SKILL.md": "---\nname: bar\n---\n# Bar\n",
    "owner/name-only@9999aaaa/skills/actual/SKILL.md": "---\nname: name-only\n---\n# Actual\n",
  };
  for (const entry of wide) {
    const name = entry.path.slice(0, -"/SKILL.md".length).split("/").pop()!;
    // Two documents declare the same name, and the second of them is past the number of documents one query inspects.
    documents["owner/wide@eeee5555/" + entry.path] = "---\nname: " + (name === "s05" || name === "s29" ? "wanted" : name) + "\n---\n# " + name + "\n";
  }
  const rows: Record<string, { id: string; skillId: string; name: string; installs: number; source: string }[]> = {
    denied: [
      { id: "owner/fine/fine", skillId: "fine", name: "fine", installs: 3, source: "owner/fine" },
      { id: "owner/denied/denied", skillId: "denied", name: "denied", installs: 1, source: "owner/denied" },
    ],
    foo: [{ id: "owner/rooty/foo", skillId: "foo", name: "foo", installs: 1, source: "owner/rooty" }],
    "true-root": [{ id: "owner/true-root/true-root", skillId: "true-root", name: "true-root", installs: 1, source: "owner/true-root" }],
    wanted: [
      { id: "owner/fine/fine", skillId: "fine", name: "fine", installs: 3, source: "owner/fine" },
      { id: "owner/wide/wanted", skillId: "wanted", name: "wanted", installs: 2, source: "owner/wide" },
    ],
    my: [{ id: "owner/suffix/my", skillId: "my", name: "my", installs: 1, source: "owner/suffix" }],
    real: [{ id: "owner/suffix/real", skillId: "real", name: "real", installs: 1, source: "owner/suffix" }],
    twice: [{ id: "owner/twice/twice", skillId: "twice", name: "twice", installs: 1, source: "owner/twice" }],
    "name-only": [{ id: "owner/name-only/name-only", skillId: "name-only", name: "name-only", installs: 1, source: "owner/name-only" }],
  };
  const revisions: Record<string, string> = {
    "owner/denied": "aaaa1111", "owner/rooty": "bbbb2222", "owner/true-root": "cccc3333",
    "owner/suffix": "dddd4444", "owner/wide": "eeee5555", "owner/fine": "ffff6666",
    "owner/twice": "77778888", "owner/name-only": "9999aaaa",
  };
  return async (url, kind) => {
    state.calls.push(url);
    if (url.startsWith("https://skills.sh/api/search")) {
      const query = new URL(url).searchParams.get("q") ?? "";
      return { query, searchType: "fuzzy", count: (rows[query] ?? []).length, duration_ms: 1, skills: rows[query] ?? [] };
    }
    // The metadata answers 403 while the \`main\` branch is perfectly readable: the branch is not guessed from that,
    // because the repository never said which branch is its default.
    if (/^https:\/\/api\.github\.com\/repos\/owner\/denied$/.test(url)) throw new Error("HTTP 403 for " + url);
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return { default_branch: url.includes("/owner/true-root") ? "trunk" : "main" };
    const branch = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/branches\/([^/]+)$/.exec(url);
    if (branch !== null) {
      const sha = revisions[branch[1]!];
      if (sha === undefined) throw new Error("no such branch " + url);
      return { commit: { sha } };
    }
    const tree = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\/([^?]+)\?recursive=1$/.exec(url);
    if (tree !== null) return { tree: trees[tree[1] + "@" + tree[2]] ?? [] };
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url);
    if (raw !== null) {
      const body = documents[raw[1] + "@" + raw[2] + "/" + raw[3]];
      if (body === undefined) throw new Error("404 " + url);
      if (kind !== "text") throw new Error("a text file must be read as text: " + url);
      return body;
    }
    throw new Error("unexpected " + kind + " " + url);
  };
}


async function start(t: TestContext, options: { fetch: MarketFetch; now?: () => number; dbPath?: string; repositoryPath?: string }): Promise<{ backend: BackendServer; origin: string; dbPath: string; repositoryPath: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "hepi-market-"));
  directories.push(directory);
  const dbPath = options.dbPath ?? join(directory, "server.sqlite");
  const repositoryPath = options.repositoryPath ?? join(directory, "skill-repository.sqlite");
  const skillMarket = createSkillMarket({ path: repositoryPath, sources: SOURCES, fetch: options.fetch, now: options.now });
  const backend = await createBackendServer({ dbPath, authToken: token, skillMarket });
  await new Promise<void>(resolve => backend.server.listen(0, resolve));
  const address = backend.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(() => backend.close());
  t.after(() => skillMarket.close());
  return { backend, origin: "http://127.0.0.1:" + address.port, dbPath, repositoryPath, directory };
}

function headers(): HeadersInit { return { authorization: "Bearer " + token, "content-type": "application/json" }; }
async function get(origin: string, path: string, auth = true) {
  const response = await fetch(origin + path, { headers: auth ? headers() : {} });
  return { status: response.status, body: await response.json() as any };
}
async function post(origin: string, path: string, body: unknown, auth = true) {
  const response = await fetch(origin + path, { method: "POST", headers: auth ? headers() : {}, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const byPath = <T extends { path: string }>(files: readonly T[]): T[] => [...files].sort((left, right) => left.path.localeCompare(right.path));

test("searches the skills.sh catalog and pins each hit to a commit before offering it", async (t) => {
  const calls: string[] = [];
  const server = await start(t, { fetch: catalog({ calls }) });

  const found = await get(server.origin, "/api/skill-market/search?q=alpha");
  assert.equal(found.status, 200, JSON.stringify(found.body));
  // Only the hit that could be pinned is offered: its repository, its commit and the SKILL.md found in it. The
  // ambiguous one, the one with no matching directory and the one that is not a GitHub coordinate are left out.
  const offered = found.body.skills as { id: string; name: string; source: { repository: string; revision: string; path: string } }[];
  // Offered in catalog order: a hit that cannot be offered is reported, not reordered around.
  assert.deepEqual(offered.map((skill) => skill.id), [
    "skills-sh:owner/one@cccc3333:skills/alpha/SKILL.md",
    "skills-sh:owner/legacy@eeee5555:legacy-skill/SKILL.md",
  ]);
  const alpha = offered.find((skill) => skill.name === "alpha")!;
  assert.equal(alpha.source.repository, "owner/one");
  assert.equal(alpha.source.revision, "cccc3333");
  assert.equal(alpha.source.path, "skills/alpha/SKILL.md");
  // A default branch called master is read like any other, and its own commit is what gets pinned.
  assert.equal(offered.find((skill) => skill.name === "legacy-skill")!.source.revision, "eeee5555");
  // Every hit that was not offered is reported with its own reason, and none of them is the whole answer: the
  // readable hits survive an unreadable repository, an ambiguous directory and an unusable row.
  assert.deepEqual((found.body.unavailable as { source: string; reason: string }[]).map((miss) => miss.source + ":" + miss.reason).sort(), [
    "owner/broken:unreadable",
    "owner/one:ambiguous",
    "owner/one:no-document",
    "skills.volces.com:not-github",
  ]);
  assert.ok(calls.some((url) => url.startsWith("https://skills.sh/api/search")));

  // A query requires words, and the catalog is only asked once per query inside the cache window.
  assert.equal((await get(server.origin, "/api/skill-market/search")).status, 400);
  assert.equal((await get(server.origin, "/api/skill-market/search?q=%20")).status, 400);
  const fetched = calls.filter((url) => url.startsWith("https://skills.sh")).length;
  await get(server.origin, "/api/skill-market/search?q=alpha");
  assert.equal(calls.filter((url) => url.startsWith("https://skills.sh")).length, fetched, "a repeated query inside the cache window must not ask the catalog again");

  // The pinned id previews the hit's whole subtree at the pin, so what is inspected is what an installation would get.
  const id = "skills-sh:owner/one@cccc3333:skills/alpha/SKILL.md";
  const preview = await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent(id));
  assert.equal(preview.status, 200);
  assert.match(preview.body.markdown, /# Alpha/);
  assert.deepEqual(byPath(preview.body.files), [{ path: "notes.md", content: "# Notes\n", encoding: "utf8" }]);
  assert.equal(preview.body.skill.source.revision, "cccc3333");
  // A path that would leave the repository is not a document this module previews.
  assert.equal((await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("skills-sh:owner/one@cccc3333:../../SKILL.md"))).status, 404);

  // The branch now points at a different commit whose alpha bytes differ. The pinned id must keep resolving to the
  // commit it carries, so no refresh or moved branch can retarget a selection the user already saw.
  const moved = await start(t, { fetch: catalog({ calls: [], revision: "dddd4444" }) });
  const afterMove = await get(moved.origin, "/api/skill-market/preview?id=" + encodeURIComponent(id));
  assert.equal(afterMove.status, 200, JSON.stringify(afterMove.body));
  assert.match(afterMove.body.markdown, /# Alpha/);
  assert.doesNotMatch(afterMove.body.markdown, /moved branch/);
  assert.deepEqual(byPath(afterMove.body.files), [{ path: "notes.md", content: "# Notes\n", encoding: "utf8" }]);
  assert.equal(afterMove.body.skill.source.revision, "cccc3333");
  // The difference is real and observable: a fresh query against the same moved repository pins the new commit, which
  // is exactly why the selection itself has to carry the commit it was shown.
  const fresh = await get(moved.origin, "/api/skill-market/search?q=alpha");
  const freshAlpha = (fresh.body.skills as { name: string; source: { revision: string } }[]).find((skill) => skill.name === "alpha")!;
  assert.equal(freshAlpha.source.revision, "dddd4444");
});

test("keeps a pinned selection across a backend restart", async (t) => {
  const id = "skills-sh:owner/one@cccc3333:skills/alpha/SKILL.md";
  const server = await start(t, { fetch: catalog({ calls: [] }) });
  assert.equal((await get(server.origin, "/api/skill-market/search?q=alpha")).status, 200);
  const before = await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent(id));
  assert.equal(before.status, 200);
  await server.backend.close();

  // A restart loses every in-memory cache, and the branch now points elsewhere. The pinned id resolves from nothing
  // but its own id, which is the proof the pin lives in the selection and not in a cache.
  const restarted = await start(t, { fetch: catalog({ calls: [], revision: "dddd4444" }), dbPath: server.dbPath, repositoryPath: server.repositoryPath });
  const after = await get(restarted.origin, "/api/skill-market/preview?id=" + encodeURIComponent(id));
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.skill.source.revision, "cccc3333");
  assert.match(after.body.markdown, /# Alpha/);
  assert.deepEqual(after.body.files, before.body.files);
});

test("resolves a legacy curated id through its listing, and a pinned id without one", async (t) => {
  // A legacy curated id carries no commit: it predates search, so it resolves through the curated listing. Its preview
  // reports whatever commit that listing read, and it is that commit an installation records — the installation is
  // still pinned. What a legacy id cannot promise is that two previews minutes apart name the same commit, and this
  // test states that limit rather than pretending the id is pinned.
  const legacy = "anthropics:skills/pdf";
  const first = await start(t, { fetch: github({ calls: [] }) });
  const legacyPreview = await get(first.origin, "/api/skill-market/preview?id=" + encodeURIComponent(legacy));
  assert.equal(legacyPreview.status, 200);
  assert.match(legacyPreview.body.skill.source.revision, /^aaaa1111/);
  assert.equal(legacyPreview.body.skill.source.path, "skills/pdf/SKILL.md");

  // The pinned id beside it asks the listing nothing at all: a branch resolution that fails still leaves a pinned
  // preview working, because the commit and the path are in the id the user was handed. (Enumerating the bundle's
  // files still reads the tree at that commit — the point is that nothing about *which* commit is re-decided here.)
  const offline = await start(t, { fetch: github({ calls: [], offline: "/branches/" }) });
  const pinned = await get(offline.origin, "/api/skill-market/preview?id=" + encodeURIComponent("skills-sh:anthropics/skills@aaaa1111:skills/pdf/SKILL.md"));
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.equal(pinned.body.skill.source.revision, "aaaa1111");
  assert.match(pinned.body.markdown, /# PDF Processing Guide/);
  assert.deepEqual(byPath(pinned.body.files).map((file) => file.path), ["assets/logo.png", "reference.md", "scripts/fill.py"]);
});

test("never guesses a default branch, a root document or a document it did not inspect", async (t) => {
  const calls: string[] = [];
  const server = await start(t, { fetch: awkwardCatalog({ calls }) });
  const misses = async (query: string) => {
    const found = await get(server.origin, "/api/skill-market/search?q=" + query);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    return {
      offered: (found.body.skills as { id: string; name: string }[]).map((skill) => skill.id),
      unavailable: (found.body.unavailable as { source: string; reason: string }[]).map((miss) => miss.source + ":" + miss.reason).sort(),
    };
  };

  // The repository's metadata cannot be read, so it never said which branch is its default. \`main\` exists and would
  // resolve — reading it anyway would be the guess this module must not make. The hit is reported, not offered.
  assert.deepEqual(await misses("denied"), {
    offered: ["skills-sh:owner/fine@ffff6666:skills/fine/SKILL.md"],
    unavailable: ["owner/denied:unreadable"],
  });

  // The catalog asked for \`foo\`; the repository's only document is its root, and that document declares \`bar\`. The
  // root is not an answer to a name it does not match, so this is no document — not the unrelated root skill.
  assert.deepEqual(await misses("foo"), { offered: [], unavailable: ["owner/rooty:no-document"] });

  // A root document that *is* the requested skill is still offered: refusing it outright would break real single-skill
  // repositories. Its repository's own default branch is \`trunk\`, which is read like any other.
  assert.deepEqual(await misses("true-root"), {
    offered: ["skills-sh:owner/true-root@cccc3333:SKILL.md"],
    unavailable: [],
  });

  // \`MYSKILL.md\` and \`docs/NOTSKILL.md\` merely end in the letters of SKILL.md; neither is a skill document. The
  // requested skill is matched by frontmatter name, and only the document that really is a SKILL.md can answer.
  assert.deepEqual(await misses("my"), { offered: [], unavailable: ["owner/suffix:no-document"] });
  assert.deepEqual(await misses("real"), {
    offered: ["skills-sh:owner/suffix@dddd4444:skills/real/SKILL.md"],
    unavailable: [],
  });

  // Thirty documents, and the second of the two that declare \`wanted\` sits past the number of documents one query
  // inspects. A unique match among the inspected prefix would be a guess about the documents it did not read, so the
  // hit is reported instead of offered — and the readable hit beside it still is.
  const wide = await misses("wanted");
  assert.deepEqual(wide.offered, ["skills-sh:owner/fine@ffff6666:skills/fine/SKILL.md"]);
  assert.deepEqual(wide.unavailable, ["owner/wide:unbounded"]);

  // The root declares the requested name and so does a nested directory. Returning the root on sight would hide the
  // second match: two documents claim the name, so nothing is offered rather than the root being picked for being
  // first in the tree.
  assert.deepEqual(await misses("twice"), { offered: [], unavailable: ["owner/twice:ambiguous"] });

  // The repository is named for the requested skill, but that is a fact about the catalog row, not about a document.
  // Its root declares \`bar\` and a nested directory declares the requested name, so the nested document is the
  // single match and is offered — the root is not, and the name alone is not treated as proof of a root hit.
  assert.deepEqual(await misses("name-only"), {
    offered: ["skills-sh:owner/name-only@9999aaaa:skills/actual/SKILL.md"],
    unavailable: [],
  });
});

test("reports an unreadable skills.sh catalog as a failed source, not as an empty result", async (t) => {
  const server = await start(t, { fetch: catalog({ calls: [], offline: "skills.sh/api/search" }) });
  const failed = await get(server.origin, "/api/skill-market/search?q=alpha");
  assert.equal(failed.status, 200);
  assert.deepEqual(failed.body.skills, []);
  assert.deepEqual(failed.body.unavailable, [{ source: "skills.sh", reason: "unreadable" }]);
});

test("repository and market routes require the backend token", async (t) => {
  const server = await start(t, { fetch: github({ calls: [] }) });
  assert.equal((await get(server.origin, "/api/skill-market/skills", false)).status, 401);
  assert.equal((await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "1.0.0", markdown: "# N" }, false)).status, 401);
  assert.equal((await get(server.origin, "/api/skill-market/skills")).status, 200);
});

test("lists curated skills at the resolved commit revision and caches them for five minutes", async (t) => {
  const calls: string[] = [];
  let now = 1_000_000;
  const server = await start(t, { fetch: github({ calls }), now: () => now });

  const first = await get(server.origin, "/api/skill-market/skills");
  assert.equal(first.status, 200);
  const listed = first.body.skills as { id: string; name: string; category: string; source: { kind: string; repository: string; revision: string } }[];
  assert.deepEqual(listed.map(skill => skill.id).sort(), ["anthropics:skills/frontend-design", "anthropics:skills/pdf", "anthropics:skills/pdf/nested", "mattpocock:skills/engineering/tdd"]);
  const pdf = listed.find(skill => skill.id === "anthropics:skills/pdf")!;
  assert.equal(pdf.name, "pdf");
  assert.equal(pdf.category, "docs");
  assert.equal(pdf.source.repository, "anthropics/skills");
  assert.equal(pdf.source.revision, "aaaa1111");
  assert.deepEqual(first.body.unavailableSources, []);
  const fetched = calls.length;
  assert.ok(fetched > 0);

  now += 60_000;
  const cached = await get(server.origin, "/api/skill-market/skills");
  assert.deepEqual(cached.body.skills, first.body.skills);
  assert.equal(calls.length, fetched, "a request inside the cache window must not refetch GitHub");

  now += 5 * 60_000;
  await get(server.origin, "/api/skill-market/skills");
  assert.ok(calls.length > fetched, "the cache must expire after five minutes");
});

test("lists the reachable sources when one curated source is unavailable", async (t) => {
  const server = await start(t, { fetch: github({ calls: [], offline: "mattpocock" }) });
  const response = await get(server.origin, "/api/skill-market/skills");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.skills.map((skill: { id: string }) => skill.id), ["anthropics:skills/pdf", "anthropics:skills/pdf/nested", "anthropics:skills/frontend-design"]);
  assert.deepEqual(response.body.unavailableSources, ["mattpocock/skills"]);
});

test("previews a curated skill's whole subtree at its pinned revision", async (t) => {
  const calls: string[] = [];
  const server = await start(t, { fetch: github({ calls }) });
  const preview = await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("anthropics:skills/pdf"));
  assert.equal(preview.status, 200);
  assert.equal(preview.body.skill.name, "pdf");
  assert.equal(preview.body.skill.description, "Work with PDF files");
  assert.match(preview.body.markdown, /# PDF Processing Guide/);
  assert.match(preview.body.skill.source.revision, /^aaaa1111/);
  // The whole directory comes with the document: markdown, scripts and bytes, but not a symlink and not a nested skill.
  assert.deepEqual(byPath(preview.body.files), [
    { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
    { path: "reference.md", content: "# Reference\n", encoding: "utf8" },
    { path: "scripts/fill.py", content: "print('fill')\n", encoding: "utf8" },
  ]);
  assert.deepEqual(Buffer.from(preview.body.files.find((file: { path: string }) => file.path === "assets/logo.png").content, "base64"), PNG_BYTES);

  const nested = await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("anthropics:skills/pdf/nested"));
  assert.match(nested.body.markdown, /# Nested/);
  assert.deepEqual(nested.body.files, [{ path: "extra.md", content: "# Extra\n", encoding: "utf8" }]);

  // Documents are cached too: a second preview must not fetch the source again.
  const fetched = calls.length;
  assert.deepEqual((await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("anthropics:skills/pdf"))).body, preview.body);
  assert.equal(calls.length, fetched, "a second preview inside the cache window must not refetch documents");
  assert.equal((await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("anthropics:skills/missing"))).status, 404);
});

test("publishes, lists and retrieves explicit bundle versions with every file intact", async (t) => {
  const server = await start(t, { fetch: github({ calls: [] }) });
  const script = "#!/usr/bin/env node\nconsole.log('install me, never run me here');\n";
  const files = [
    { path: "scripts/run.mjs", content: script },
    { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
    { path: "REFERENCE.md", content: "# Reference\n" },
  ];
  const first = await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "1.0.0", description: "Take notes", category: "workflow", markdown: "---\nname: notes\ndescription: Take notes\n---\n# Notes\n", files });
  assert.equal(first.status, 201);
  assert.equal((await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "1.1.0", description: "Take notes", markdown: "# Notes v2\n" })).status, 201);

  const names = await get(server.origin, "/api/skill-market/bundles");
  assert.deepEqual(names.body.names, ["notes"]);

  const listed = await get(server.origin, "/api/skill-market/bundles?name=notes");
  assert.deepEqual(listed.body.bundles.map((bundle: { version: string }) => bundle.version), ["1.0.0", "1.1.0"]);
  assert.deepEqual(listed.body.bundles[0].files, ["SKILL.md", "REFERENCE.md", "assets/logo.png", "scripts/run.mjs"]);
  assert.deepEqual(listed.body.bundles[1].files, ["SKILL.md"]);

  // The round trip is byte-for-byte: the stored script and image come back exactly as they were published.
  const exact = await get(server.origin, "/api/skill-market/bundles?name=notes&version=1.0.0");
  assert.equal(exact.body.bundle.markdown, "---\nname: notes\ndescription: Take notes\n---\n# Notes\n");
  assert.deepEqual(byPath(exact.body.bundle.files), byPath([
    { path: "scripts/run.mjs", content: script, encoding: "utf8" },
    { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
    { path: "REFERENCE.md", content: "# Reference\n", encoding: "utf8" },
  ]));
  assert.deepEqual(Buffer.from(exact.body.bundle.files.find((file: { path: string }) => file.path === "assets/logo.png").content, "base64"), PNG_BYTES);
  assert.equal((await get(server.origin, "/api/skill-market/bundles?name=notes&version=9.9.9")).status, 404);

  // A stored bundle previews through the same path a curated skill does.
  const preview = await get(server.origin, "/api/skill-market/preview?id=" + encodeURIComponent("repository:notes@1.0.0"));
  assert.equal(preview.status, 200);
  assert.deepEqual(byPath(preview.body.files), byPath(exact.body.bundle.files));

  const market = await get(server.origin, "/api/skill-market/skills");
  const published = (market.body.skills as { id: string; source: { kind: string } }[]).filter(skill => skill.source.kind === "repository");
  assert.deepEqual(published.map(skill => skill.id), ["repository:notes@1.0.0", "repository:notes@1.1.0"]);
});

test("refuses bundle files that would escape, collide or arrive malformed", async (t) => {
  const server = await start(t, { fetch: github({ calls: [] }) });
  const publish = (version: string, files: unknown) => post(server.origin, "/api/skill-market/bundles", { name: "notes", version, markdown: "# Notes\n", files });
  // A bundle's own SKILL.md is the document, and a nested one would make the installed directory ambiguous.
  assert.equal((await publish("1.0.0", [{ path: "SKILL.md", content: "# Other\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "skill.md", content: "# Other\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "nested/SKILL.md", content: "# Nested\n" }])).status, 400);
  // Traversal, absolute paths, directories and non-portable separators.
  assert.equal((await publish("1.0.0", [{ path: "../escape.md", content: "# Bad\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "a/../../escape.md", content: "# Bad\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "/etc/passwd", content: "x" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "docs\\win.md", content: "# Bad\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "docs/", content: "# Bad\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "docs//a.md", content: "# Bad\n" }])).status, 400);
  // The same file twice, including a case-only difference a host may not distinguish.
  assert.equal((await publish("1.0.0", [{ path: "a.md", content: "# A\n" }, { path: "a.md", content: "# B\n" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "a.md", content: "# A\n" }, { path: "A.md", content: "# B\n" }])).status, 400);
  // Malformed content and encodings.
  assert.equal((await publish("1.0.0", [{ path: "a.md", content: 5 }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "a.png", content: "not base64 !!", encoding: "base64" }])).status, 400);
  assert.equal((await publish("1.0.0", [{ path: "a.md", content: "# A\n", encoding: "utf16" }])).status, 400);
  // Version and name rules still hold.
  assert.equal((await post(server.origin, "/api/skill-market/bundles", { name: "../escape", version: "1.0.0", markdown: "# Bad\n" })).status, 400);
  assert.equal((await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "not-a-version", markdown: "# Bad\n" })).status, 400);
  assert.equal((await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "1.0.0" })).status, 400);
  // Nothing above was stored.
  assert.deepEqual((await get(server.origin, "/api/skill-market/bundles")).body.names, []);
});

test("keeps repository bundles after a restart without touching conversation history", async (t) => {
  const server = await start(t, { fetch: github({ calls: [] }) });
  await post(server.origin, "/api/skill-market/bundles", { name: "notes", version: "1.0.0", markdown: "# Notes\n", files: [{ path: "scripts/run.sh", content: "echo hi\n" }] });
  const conversations = await get(server.origin, "/api/conversations");
  await server.backend.close();

  const reopened = await start(t, { fetch: github({ calls: [] }), dbPath: server.dbPath, repositoryPath: server.repositoryPath });
  const bundle = await get(reopened.origin, "/api/skill-market/bundles?name=notes&version=1.0.0");
  assert.equal(bundle.body.bundle.markdown, "# Notes\n");
  assert.deepEqual(bundle.body.bundle.files, [{ path: "scripts/run.sh", content: "echo hi\n", encoding: "utf8" }]);
  assert.deepEqual((await get(reopened.origin, "/api/conversations")).body.conversations, conversations.body.conversations);
});
