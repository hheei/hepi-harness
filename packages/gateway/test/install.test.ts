import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalInstallServer, SshInstallServer, folderContentHash, installScopeRoot, safeInstallPath, sameDigests, validLockDocument } from "../src/install.ts";
import type { SshProfile } from "../src/index.ts";
import { fakeInstallHost } from "./install-host.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe]);
const SKILL = "---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF Processing Guide\n";
const SCRIPT = "print('fill')\n";

function value(result: unknown): any { return (result as { value: unknown }).value; }
function error(result: unknown): { code: string; message: string } { return (result as { error: { code: string; message: string } }).error; }

async function localFixture() {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  const root = join(repository, "app");
  const other = join(base, "other");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(other, { recursive: true });
  // The account home and the workspace roots are real directories, so a test can make them realpath-stable.
  const realHome = await import("node:fs/promises").then((module) => module.realpath(home));
  const workspaces = new WorkspaceRegistry([{ id: "local", root }, { id: "second", root: other }]);
  const installs = new LocalInstallServer(workspaces, { identity: { user: "operator", home: realHome } });
  return { base, home: realHome, repository, root, other, workspaces, installs };
}

const FILES = [
  { path: "reference.md", content: "# Reference\n", encoding: "utf8" as const },
  { path: "scripts/fill.py", content: SCRIPT, encoding: "utf8" as const },
  { path: "assets/logo.png", content: PNG.toString("base64"), encoding: "base64" as const },
];

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A bundle with two zero-byte files: a byte-count write loop would send neither of them. */
const EMPTY_FILES = [
  { path: "SKILL.md", content: SKILL, encoding: "utf8" as const },
  { path: "assets/empty.txt", content: "", encoding: "utf8" as const },
  { path: "__init__.py", content: "", encoding: "utf8" as const },
];

test("publishes zero-byte files byte for byte on a local and an SSH host, with the same digests", async () => {
  const fixture = await localFixture();
  const base = await mkdtemp(join(tmpdir(), "hepi-install-empty-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    const local = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "empty", files: EMPTY_FILES });
    assert.equal(local.ok, true, JSON.stringify(local));
    assert.deepEqual(value(local).files, ["SKILL.md", "assets/empty.txt", "__init__.py"]);

    const { runner } = fakeInstallHost({ home, root });
    const installs = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner });
    const remote = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "empty", files: EMPTY_FILES });
    assert.equal(remote.ok, true, JSON.stringify(remote));

    // Both hosts hold both empty files, and their bytes are exactly zero, not merely missing or non-empty.
    for (const skillsRoot of [join(fixture.home, ".agents", "skills"), join(home, ".agents", "skills")]) {
      for (const relative of ["assets/empty.txt", "__init__.py"]) {
        const bytes = await readFile(join(skillsRoot, "empty", ...relative.split("/")));
        assert.equal(bytes.byteLength, 0, relative + " is empty on " + skillsRoot);
      }
      assert.equal(await readFile(join(skillsRoot, "empty", "SKILL.md"), "utf8"), SKILL);
      assert.deepEqual(await readdir(join(skillsRoot, "empty", "assets")), ["empty.txt"]);
    }

    // The two hosts describe the same directory identically, so a status read cannot depend on which one holds it.
    const localInspection = await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "empty" });
    const remoteInspection = await installs.execute({ workspaceId: "remote-prod", operation: "inspectDirectory", scope: "global", directory: "empty" });
    assert.deepEqual(value(localInspection).files, {
      "SKILL.md": "e3912810f2682aaf579bd8dd50c39edb8595b5afad243a0ee9a978c1114e0316",
      "assets/empty.txt": EMPTY_SHA256,
      "__init__.py": EMPTY_SHA256,
    });
    assert.deepEqual(value(remoteInspection).files, value(localInspection).files);
    assert.equal(value(remoteInspection).contentHash, value(localInspection).contentHash);
    assert.equal(value(localInspection).contentHash, folderContentHash(value(localInspection).files));
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test("publishes a whole directory into global and workspace scopes with exact bytes", async () => {
  const fixture = await localFixture();
  try {
    const global = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(global.ok, true, JSON.stringify(global));
    assert.deepEqual(value(global).files, ["reference.md", "scripts/fill.py", "assets/logo.png"]);
    assert.equal(value(global).path, join(fixture.home, ".agents", "skills", "pdf"));
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "scripts", "fill.py"), "utf8"), SCRIPT);
    assert.deepEqual(await readFile(join(fixture.home, ".agents", "skills", "pdf", "assets", "logo.png")), PNG);

    // The workspace scope lands in the project directory, not the account home, and never in the harness home.
    const workspace = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(value(workspace).path, join(fixture.root, ".agents", "skills", "pdf"));
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
    // No staging directory is left behind in either scope.
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(fixture.home, ".agents", "skills")), ["pdf"]);
    assert.deepEqual(await readdir(join(fixture.root, ".agents", "skills")), ["pdf"]);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("refuses an existing destination, traversal, and a symlinked destination", async () => {
  const fixture = await localFixture();
  try {
    const first = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(first.ok, true);
    // Ticket 07 owns confirmed overwrite; until then an existing directory is a conflict, not a silent replacement.
    const conflict = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(error(conflict).code, "conflict");
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");

    // The bundle's own document is the one root SKILL.md; a nested or differently-cased one is refused.
    for (const path of ["../escape.md", "a/../../escape.md", "/etc/passwd", "docs\\win.md", "nested/SKILL.md", "skill.md", "docs/Skill.Md"]) {
      const refused = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "other-skill", files: [{ path, content: "x", encoding: "utf8" }] });
      assert.equal(error(refused).code, "invalid", path);
    }
    for (const directory of ["../escape", "a/b", "..", "Notes"]) {
      const refused = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory, files: FILES });
      assert.equal(error(refused).code, "invalid", directory);
    }

    // A destination that is a symlink to somewhere else is refused rather than written through.
    await mkdir(join(fixture.other, ".agents", "skills"), { recursive: true });
    await symlink(fixture.home, join(fixture.other, ".agents", "skills", "linked"));
    const linked = await fixture.installs.execute({ workspaceId: "second", operation: "publishDirectory", scope: "workspace", directory: "linked", files: FILES });
    assert.equal(error(linked).code, "conflict");
    assert.deepEqual(await import("node:fs/promises").then(m => m.readdir(fixture.home)), []);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("records provenance and an install-time hash baseline in one scope lock", async () => {
  const fixture = await localFixture();
  try {
    assert.deepEqual(await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" }), { ok: true, value: undefined });
    const entry = {
      source: "repository:pdf@1.0.0", sourceType: "repository" as const, ref: "1.0.0", version: "1.0.0",
      skillPath: join(fixture.home, ".agents", "skills", "pdf"), scope: "global" as const, installedAtMs: 1700000000000,
      files: { "reference.md": "a".repeat(64), "scripts/fill.py": "b".repeat(64), "assets/logo.png": "c".repeat(64) },
      contentHash: "d".repeat(64),
    };
    const recorded = await fixture.installs.execute({ workspaceId: "local", operation: "recordInstall", scope: "global", name: "pdf", entry });
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    assert.deepEqual(value(recorded).skills.pdf, entry);
    // It is metadata, beside the skills directory, and it survives a re-read.
    assert.deepEqual(await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" }), { ok: true, value: value(recorded) });
    assert.deepEqual(JSON.parse(await readFile(join(fixture.home, ".agents", ".skill-lock.json"), "utf8")), value(recorded));
    // The workspace scope keeps its own lock: a global install is shared, a workspace one is not.
    assert.deepEqual(await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "workspace" }), { ok: true, value: undefined });

    // A malformed lock is refused, never overwritten, and an invalid record never reaches the host.
    await writeFile(join(fixture.home, ".agents", ".skill-lock.json"), "{ not json");
    const corrupt = await fixture.installs.execute({ workspaceId: "local", operation: "recordInstall", scope: "global", name: "pdf", entry });
    assert.equal(error(corrupt).code, "invalid");
    assert.equal(await readFile(join(fixture.home, ".agents", ".skill-lock.json"), "utf8"), "{ not json");
    assert.equal(validLockDocument({ version: 1, skills: {} }), true);
    assert.equal(validLockDocument({ version: 2, skills: {} }), false);
    assert.equal(safeInstallPath("a/../b.md"), false);
    assert.equal(safeInstallPath("SKILL.md"), true);
    assert.equal(safeInstallPath("nested/SKILL.md"), false);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("confines the scope to its authorized root, so a linked scope cannot redirect a publication", async () => {
  const fixture = await localFixture();
  try {
    // The account's own .agents directory is a link out of the account home: the scope resolves outside its root.
    const outside = join(fixture.base, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(fixture.home, ".agents"), "dir");
    const escaped = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(error(escaped).code, "permission_denied");
    assert.deepEqual(await readdir(outside), []);
    // The scope lock is refused through the same resolution, so nothing is written beside the escape either.
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" })).code, "permission_denied");

    // The workspace scope is confined the same way, one level higher: a linked .agents cannot leave the workspace.
    await symlink(outside, join(fixture.other, ".agents"), "dir");
    const workspace = await fixture.installs.execute({ workspaceId: "second", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(error(workspace).code, "permission_denied");
    assert.deepEqual(await readdir(outside), []);

    // A link that stays inside the authorized root is still followed: confinement is about leaving, not about links.
    await mkdir(join(fixture.root, "real-skills"), { recursive: true });
    await symlink(join(fixture.root, "real-skills"), join(fixture.root, ".agents"), "dir");
    const inside = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(inside.ok, true, JSON.stringify(inside));
    assert.equal(await readFile(join(fixture.root, "real-skills", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("keeps every concurrent lock record and reports host failures as results, not rejections", async () => {
  const fixture = await localFixture();
  try {
    const entry = (name: string) => ({
      source: "repository:" + name + "@1", sourceType: "repository" as const, skillPath: join(fixture.home, ".agents", "skills", name),
      scope: "global" as const, installedAtMs: 1700000000000, files: { "SKILL.md": "a".repeat(64) }, contentHash: "b".repeat(64),
    });
    const names = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const recorded = await Promise.all(names.map((name) => fixture.installs.execute({ workspaceId: "local", operation: "recordInstall", scope: "global", name, entry: entry(name) })));
    assert.ok(recorded.every((result) => result.ok), JSON.stringify(recorded));
    // One read-merge-write at a time: five records produce five entries, not the last writer's single entry.
    const lock = JSON.parse(await readFile(join(fixture.home, ".agents", ".skill-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.skills).sort(), [...names].sort());

    // A lock that cannot be read is a result the RPC can report, never an exception out of the handler.
    await chmod(join(fixture.home, ".agents", ".skill-lock.json"), 0o000);
    const unreadable = await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" });
    assert.equal(unreadable.ok, false);
    await chmod(join(fixture.home, ".agents", ".skill-lock.json"), 0o600);
    // A lock path that is a directory is a result too, not an EISDIR rejection.
    await rm(join(fixture.home, ".agents", ".skill-lock.json"));
    await mkdir(join(fixture.home, ".agents", ".skill-lock.json"));
    assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" })).ok, false);
    // A lock that is a link is refused rather than followed.
    const outsideLock = join(fixture.base, "outside-lock.json");
    await writeFile(outsideLock, JSON.stringify({ version: 1, skills: {} }));
    await rm(join(fixture.home, ".agents", ".skill-lock.json"), { recursive: true });
    await symlink(outsideLock, join(fixture.home, ".agents", ".skill-lock.json"));
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "readLock", scope: "global" })).code, "invalid");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("serializes one scope lock across workspaces, so a global installation is never lost to a workspace one", async () => {
  const fixture = await localFixture();
  try {
    const entry = (name: string, scope: "global" | "workspace") => ({
      source: "repository:" + name + "@1", sourceType: "repository" as const, skillPath: "/x/" + name,
      scope, installedAtMs: 1700000000000, files: { "SKILL.md": "a".repeat(64) }, contentHash: "b".repeat(64),
    });
    // Global is one scope for every workspace of this host and account, so records from two workspaces contend for one
    // lock path. They are serialized by that path, not by workspace.
    const records = await Promise.all([
      ...["alpha", "beta", "gamma"].map((name) => fixture.installs.execute({ workspaceId: "local", operation: "recordInstall", scope: "global", name, entry: entry(name, "global") })),
      ...["delta", "epsilon"].map((name) => fixture.installs.execute({ workspaceId: "second", operation: "recordInstall", scope: "global", name, entry: entry(name, "global") })),
    ]);
    assert.ok(records.every((result) => result.ok), JSON.stringify(records));
    const lock = JSON.parse(await readFile(join(fixture.home, ".agents", ".skill-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.skills).sort(), ["alpha", "beta", "delta", "epsilon", "gamma"]);
    // The workspace scope keeps its own lock, and a workspace record never lands in the global one.
    assert.equal((await fixture.installs.execute({ workspaceId: "second", operation: "recordInstall", scope: "workspace", name: "alpha", entry: entry("alpha", "workspace") })).ok, true);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(fixture.other, ".agents", ".skill-lock.json"), "utf8")).skills), ["alpha"]);
    assert.equal(JSON.parse(await readFile(join(fixture.home, ".agents", ".skill-lock.json"), "utf8")).skills.alpha.scope, "global");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("refuses a confirmed replacement when the directory changed after it was inspected", async () => {
  const fixture = await localFixture();
  try {
    const original = [{ path: "SKILL.md", content: "---\nname: pdf\n---\noriginal\n", encoding: "utf8" as const }];
    const incoming = [{ path: "SKILL.md", content: "---\nname: pdf\n---\nrelease\n", encoding: "utf8" as const }];
    assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: original })).ok, true);
    const inspected = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };

    // An edit that lands after the inspection is never silently deleted by the confirmed replacement.
    await writeFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\nedited while confirming\n");
    const raced = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: incoming, overwrite: true, expect: inspected.files });
    assert.equal(error(raced).code, "conflict");
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), "---\nname: pdf\n---\nedited while confirming\n");
    // The refusal left no staging directory and no backup of an edit it did not take.
    assert.deepEqual(await readdir(join(fixture.home, ".agents", "skills")), ["pdf"]);
    assert.deepEqual((await readdir(join(fixture.home, ".agents"))).filter((name) => name.endsWith(".bak")), []);

    // An added and a deleted entry are equally disqualifying, not just a changed file.
    const current = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };
    await writeFile(join(fixture.home, ".agents", "skills", "pdf", "added.md"), "added\n");
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: incoming, overwrite: true, expect: current.files })).code, "conflict");
    await rm(join(fixture.home, ".agents", "skills", "pdf", "added.md"));
    await writeFile(join(fixture.home, ".agents", "skills", "pdf", "kept.md"), "kept\n");
    const withKept = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };
    await rm(join(fixture.home, ".agents", "skills", "pdf", "kept.md"));
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: incoming, overwrite: true, expect: withKept.files })).code, "conflict");

    // The confirmed replacement that does match the inspection is published and keeps what it replaced.
    const matching = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };
    const published = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: incoming, overwrite: true, expect: matching.files });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), incoming[0]!.content);
    assert.equal(await readFile(join(value(published).backup, "SKILL.md"), "utf8"), "---\nname: pdf\n---\nedited while confirming\n");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("settles two simultaneous confirmed replacements deterministically, with no orphaned backup", async () => {
  const fixture = await localFixture();
  try {
    const files = (text: string) => [{ path: "SKILL.md", content: "---\nname: pdf\n---\n" + text + "\n", encoding: "utf8" as const }];
    assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("original") })).ok, true);
    // Both replacements are confirmed against the same inspected snapshot, which is what a confirmation pins: the
    // first to reach the directory replaces it, and the second no longer finds the content it was confirmed against.
    const inspected = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };
    const results = await Promise.all([
      fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("first"), overwrite: true, expect: inspected.files }),
      fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("second"), overwrite: true, expect: inspected.files }),
    ]);
    // Exactly one replacement wins; the other loses the race explicitly instead of reporting a host failure, and it
    // loses it by finding the destination already replaced rather than by moving that directory aside itself.
    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    const loser = results.find((result) => !result.ok) as { error: { code: string; message: string } };
    assert.equal(loser.error.code, "conflict", JSON.stringify(results));
    // The directory is still there, holding the winner's content, and the loser left no staging directory behind.
    const content = await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8");
    assert.equal(content, winners[0] === results[0] ? files("first")[0]!.content : files("second")[0]!.content);
    assert.deepEqual(await readdir(join(fixture.home, ".agents", "skills")), ["pdf"]);
    // The loser never moved the winner's directory aside, so the single retained backup holds the original content
    // rather than a second replacement, and no backup was orphaned under a stepped-over name.
    const backups = (await readdir(join(fixture.home, ".agents"))).filter((name) => name.endsWith(".bak"));
    assert.deepEqual(backups, ["pdf.bak"]);
    assert.equal(await readFile(join(fixture.home, ".agents", "pdf.bak", "SKILL.md"), "utf8"), files("original")[0]!.content);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("serializes replacements of one destination across server instances, so a second replacement is refused", async () => {
  const fixture = await localFixture();
  try {
    const files = (text: string) => [{ path: "SKILL.md", content: "---\nname: pdf\n---\n" + text + "\n", encoding: "utf8" as const }];
    // Two servers over the same account home: the same global destination is reachable from both, exactly as two
    // workspaces of one host are. The destination check, the move-aside and the publish must be one serialized section.
    const other = new LocalInstallServer(fixture.workspaces, { identity: { user: "operator", home: fixture.home } });
    assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("original") })).ok, true);
    const inspected = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" })) as { files: Record<string, string> };
    const results = await Promise.all([
      fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("first"), overwrite: true, expect: inspected.files }),
      other.execute({ workspaceId: "second", operation: "publishDirectory", scope: "global", directory: "pdf", files: files("second"), overwrite: true, expect: inspected.files }),
    ]);
    const winners = results.filter((result) => result.ok);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.equal((results.find((result) => !result.ok) as { error: { code: string } }).error.code, "conflict");
    // One retained backup holds the original, and the surviving directory is the winner's: no orphaned backup, no
    // stepped-over backup name, no lost directory.
    const backups = (await readdir(join(fixture.home, ".agents"))).filter((name) => name.endsWith(".bak"));
    assert.deepEqual(backups, ["pdf.bak"]);
    assert.equal(await readFile(join(fixture.home, ".agents", "pdf.bak", "SKILL.md"), "utf8"), files("original")[0]!.content);
    const content = await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8");
    assert.ok(content === files("first")[0]!.content || content === files("second")[0]!.content, content);
    assert.deepEqual(await readdir(join(fixture.home, ".agents", "skills")), ["pdf"]);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("keeps the installed directory when a replacement cannot be published", async () => {
  const fixture = await localFixture();
  try {
    const original = [{ path: "SKILL.md", content: "---\nname: pdf\n---\noriginal\n", encoding: "utf8" as const }];
    assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: original })).ok, true);
    // A file path the host cannot write fails the staged publication after the destination was moved aside. The
    // replacement is refused and the directory that was there is put back, not left missing.
    const failing = [{ path: "SKILL.md", content: "---\nname: pdf\n---\nrelease\n", encoding: "utf8" as const }, { path: "nested/SKILL.md", content: "x", encoding: "utf8" as const }];
    const refused = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: failing, overwrite: true });
    assert.equal(refused.ok, false);
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), original[0]!.content);
    assert.deepEqual(await readdir(join(fixture.home, ".agents", "skills")), ["pdf"]);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("inspects an installed directory and reports added, deleted and linked entries against the baseline", async () => {
  const fixture = await localFixture();
  try {
    const published = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(published.ok, true, JSON.stringify(published));
    const inspected = await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const baseline = value(inspected);
    assert.deepEqual(Object.keys(baseline.files).sort(), ["assets/logo.png", "reference.md", "scripts/fill.py"]);
    assert.match(baseline.files["reference.md"], /^[0-9a-f]{64}$/);
    // The folder hash is the same rule the install-time baseline uses, over sorted path/hash pairs.
    assert.equal(baseline.contentHash, folderContentHash(baseline.files));
    assert.equal(sameDigests(baseline.files, { ...baseline.files }), true);
    assert.equal(sameDigests(baseline.files, { ...baseline.files, "extra.md": "a".repeat(64) }), false);

    // An added file, a deleted file and a link all change the digest set, so none of them can pass as unchanged.
    const added = await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" });
    await writeFile(join(fixture.home, ".agents", "skills", "pdf", "extra.md"), "extra\n");
    const withExtra = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" }));
    assert.equal(sameDigests(value(added).files, withExtra.files), false);
    await rm(join(fixture.home, ".agents", "skills", "pdf", "extra.md"));
    await rm(join(fixture.home, ".agents", "skills", "pdf", "reference.md"));
    const deleted = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" }));
    assert.equal(sameDigests(value(added).files, deleted.files), false);
    await symlink("scripts/fill.py", join(fixture.home, ".agents", "skills", "pdf", "linked.py"));
    const linked = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" }));
    assert.match(linked.files["linked.py"], /^link:[0-9a-f]{64}$/);
    assert.equal(sameDigests(deleted.files, linked.files), false);

    // A directory that is not there is reported as such, and a linked one is refused rather than followed.
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "absent" })).code, "not_found");
    await symlink(fixture.home, join(fixture.home, ".agents", "skills", "linked"));
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "linked" })).code, "permission_denied");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("replaces an installed directory only when confirmed, keeping the replaced one and its pinned content", async () => {
  const fixture = await localFixture();
  try {
    const original = [{ path: "SKILL.md", content: "---\nname: pdf\n---\noriginal\n", encoding: "utf8" as const }];
    const replacement = [{ path: "SKILL.md", content: "---\nname: pdf\n---\nreplacement\n", encoding: "utf8" as const }];
    const first = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: original });
    assert.equal(first.ok, true, JSON.stringify(first));
    // Without a confirmation an existing destination stays a conflict, and the directory is untouched.
    const refused = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: replacement });
    assert.equal(error(refused).code, "conflict");
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), original[0]!.content);

    // A confirmed replacement retains the directory it replaced, beside the skills directory, not inside it.
    const replaced = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: replacement, overwrite: true });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), replacement[0]!.content);
    const backup = value(replaced).backup as string;
    assert.equal(backup, join(fixture.home, ".agents", "pdf.bak"));
    assert.equal(await readFile(join(backup, "SKILL.md"), "utf8"), original[0]!.content);
    // No staging directory survives the replacement.
    assert.deepEqual((await readdir(join(fixture.home, ".agents", "skills"))).sort(), ["pdf"]);

    // A replacement pinned to content that changed in the meantime is refused instead of discarding the change.
    const inspected = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" }));
    await writeFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\nedited locally\n");
    const stale = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: original, overwrite: true, expect: inspected.files });
    assert.equal(error(stale).code, "conflict");
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), "---\nname: pdf\n---\nedited locally\n");
    // A replacement pinned to the content that is actually there is published.
    const current = value(await fixture.installs.execute({ workspaceId: "local", operation: "inspectDirectory", scope: "global", directory: "pdf" }));
    const published = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: original, overwrite: true, expect: current.files });
    assert.equal(published.ok, true, JSON.stringify(published));

    // Each replacement keeps its own backup under a unique path: a later one never destroys an earlier one.
    const backupsBefore = (await readdir(join(fixture.home, ".agents"))).filter((name) => name.endsWith(".bak"));
    const second = await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "pdf", files: replacement, overwrite: true });
    assert.ok(value(second).backup !== undefined, JSON.stringify(second));
    const backupsAfter = (await readdir(join(fixture.home, ".agents"))).filter((name) => name.endsWith(".bak"));
    // A second replacement adds a backup rather than overwriting the first one.
    assert.equal(backupsAfter.length, backupsBefore.length + 1, backupsAfter.join(","));
    assert.equal(await readFile(join(fixture.home, ".agents", "pdf.bak", "SKILL.md"), "utf8"), original[0]!.content);
    // Each backup holds what was actually replaced at that moment, and none of them is overwritten.
    assert.equal(await readFile(join(value(second).backup, "SKILL.md"), "utf8"), original[0]!.content);
    // Backups sit beside the skills directory, so they are never scanned as an installation.
    assert.deepEqual((await readdir(join(fixture.home, ".agents", "skills"))).sort(), ["pdf"]);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

/**
 * The remote host here is `install-host.ts`: the gateway's own request shape and helper program, answered by a
 * stand-in that runs the helper's rules against this filesystem instead of over a process. These cases therefore assert
 * the gateway's transport contract — what it sends, what it does with each answer, and what lands on the host — and the
 * production Python helper keeps its own coverage in `apps/server/test/skill-install.test.ts` and the gateway's
 * `ssh-resources`/`file-transfer` suites.
 */
test("publishes a directory on a controlled SSH host and records its lock there", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    const { runner, requests } = fakeInstallHost({ home, root });
    const profiles: SshProfile[] = [{ id: "prod", host: "build.example", remoteRoot: root }];
    const installs = new SshInstallServer({ profiles, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)), runner });
    const published = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(value(published).path, join(home, ".agents", "skills", "pdf"));
    assert.equal(await readFile(join(home, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
    assert.deepEqual(await readFile(join(home, ".agents", "skills", "pdf", "assets", "logo.png")), PNG);
    // The remote account is the transport's, not this process's, and the profile's root is the confinement root.
    assert.ok(requests.length > 0);
    assert.equal(requests[0]!.command[0], "python3");
    assert.ok(requests.every(request => request.root === root && request.cwd === root));

    const entry = {
      source: "repository:pdf@1.0.0", sourceType: "repository" as const, ref: "1.0.0", version: "1.0.0",
      skillPath: join(home, ".agents", "skills", "pdf"), scope: "global" as const, installedAtMs: 1700000000000,
      files: { "reference.md": "a".repeat(64) }, contentHash: "d".repeat(64),
    };
    assert.equal((await installs.execute({ workspaceId: "remote-prod", operation: "recordInstall", scope: "global", name: "pdf", entry })).ok, true);
    const lock = await installs.execute({ workspaceId: "remote-prod", operation: "readLock", scope: "global" });
    assert.deepEqual(value(lock).skills.pdf, entry);

    const conflict = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(error(conflict).code, "conflict");
    // A symlink on the host is not written through.
    await symlink(home, join(root, ".agents", "skills", "linked")).catch(async () => { await mkdir(join(root, ".agents", "skills"), { recursive: true }); await symlink(home, join(root, ".agents", "skills", "linked")); });
    const linked = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "workspace", directory: "linked", files: FILES });
    assert.equal(error(linked).code, "conflict");
    // The workspace scope publishes under the profile root, not the account home.
    const scoped = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "workspace", directory: "deploy", files: FILES });
    assert.equal(value(scoped).path, join(root, ".agents", "skills", "deploy"));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("inspects, updates and backs up an installed directory on a controlled SSH host", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    const { runner } = fakeInstallHost({ home, root });
    const installs = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner });
    const original = [{ path: "SKILL.md", content: "---\nname: pdf\n---\noriginal\n", encoding: "utf8" as const }, { path: "reference.md", content: "# Reference\n", encoding: "utf8" as const }];
    const replacement = [{ path: "SKILL.md", content: "---\nname: pdf\n---\nrelease\n", encoding: "utf8" as const }];
    assert.equal((await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: original })).ok, true);
    // The remote helper hashes the directory it actually holds, with the same rule the gateway uses.
    const inspected = await installs.execute({ workspaceId: "remote-prod", operation: "inspectDirectory", scope: "global", directory: "pdf" });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.deepEqual(Object.keys(value(inspected).files).sort(), ["SKILL.md", "reference.md"]);
    assert.equal(value(inspected).contentHash, folderContentHash(value(inspected).files));

    // A local edit is seen as a modification, and a confirmed replacement pinned to it keeps the edited directory.
    await writeFile(join(home, ".agents", "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\nedited on the host\n");
    const edited = await installs.execute({ workspaceId: "remote-prod", operation: "inspectDirectory", scope: "global", directory: "pdf" });
    assert.equal(sameDigests(value(inspected).files, value(edited).files), false);
    // A stale confirmation is refused: the pinned digests no longer describe the directory.
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: replacement, overwrite: true, expect: value(inspected).files })).code, "conflict");
    assert.equal(await readFile(join(home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), "---\nname: pdf\n---\nedited on the host\n");
    const published = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: replacement, overwrite: true, expect: value(edited).files });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(await readFile(join(home, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), replacement[0]!.content);
    const backup = value(published).backup as string;
    assert.equal(backup, join(home, ".agents", "pdf.bak"));
    assert.equal(await readFile(join(backup, "SKILL.md"), "utf8"), "---\nname: pdf\n---\nedited on the host\n");

    // Concurrent records on one remote lock are serialized by the host, so none is lost.
    await Promise.all(["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => installs.execute({
      workspaceId: "remote-prod", operation: "recordInstall", scope: "global", name,
      entry: { source: "repository:" + name + "@1", sourceType: "repository", skillPath: "/x/" + name, scope: "global", installedAtMs: 1, files: { "SKILL.md": "a".repeat(64) }, contentHash: "b".repeat(64) },
    })));
    const lock = JSON.parse(await readFile(join(home, ".agents", ".skill-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.skills).sort(), ["alpha", "beta", "delta", "epsilon", "gamma"]);
    // The remote helper validates an entry with the same rules the gateway does.
    const malformed = await installs.execute({ workspaceId: "remote-prod", operation: "recordInstall", scope: "global", name: "bad", entry: { source: "repository:bad@1", sourceType: "repository", skillPath: "/x/bad", scope: "global", installedAtMs: 1, files: { "../escape.md": "NOT-A-HASH" }, contentHash: "nope" } as never });
    assert.equal(error(malformed).code, "invalid");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("confines a remote scope to its authorized root through a linked .agents directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  const outside = join(base, "outside");
  await mkdir(join(home, ".agents"), { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(outside, join(home, ".agents", "skills"), "dir");
    const { runner } = fakeInstallHost({ home, root });
    const installs = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner });
    const escaped = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES });
    assert.equal(error(escaped).code, "permission_denied");
    assert.deepEqual(await readdir(outside), []);
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "readLock", scope: "global" })).code, "permission_denied");
    // The workspace scope is confined to the profile's root the same way.
    await rm(join(home, ".agents", "skills"));
    await symlink(outside, join(root, ".agents"), "dir");
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES })).code, "permission_denied");
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("reports an unreachable SSH host as a failed installation, never as success", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  try {
    const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: join(base, "app") }]));
    const failing = { execute: async () => { throw Object.assign(new Error("unreachable"), { code: "unreachable" }); } };
    const installs = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: join(base, "app") }], workspaces: sshWorkspaces, runner: failing });
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES })).code, "unknown");
    assert.equal(error(await installs.execute({ workspaceId: "remote-missing", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES })).code, "permission_denied");
    // A lost response is an unknown outcome: the installation is not reported as published and is never replayed.
    const calls: unknown[] = [];
    const lost = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: join(base, "app") }], workspaces: sshWorkspaces, runner: { execute: async request => { calls.push(request); throw Object.assign(new Error("lost"), { code: "outcome_unknown" }); } } });
    assert.equal(error(await lost.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: FILES })).code, "outcome_unknown");
    assert.equal(calls.length, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("global installation is one directory shared by two workspaces of the same host and account", async () => {
  const fixture = await localFixture();
  try {
    await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "global", directory: "shared", files: FILES });
    // The second workspace publishes nothing, yet the global skill is the same host path for both.
    assert.equal(installScopeRoot("global", fixture.root, fixture.home), installScopeRoot("global", fixture.other, fixture.home));
    assert.equal(installScopeRoot("workspace", fixture.root, fixture.home), join(fixture.root, ".agents", "skills"));
    assert.notEqual(installScopeRoot("workspace", fixture.other, fixture.home), installScopeRoot("workspace", fixture.root, fixture.home));
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "shared", "reference.md"), "utf8"), "# Reference\n");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

/** A skill document as the loader reads it: the key's value, decided independently of the gateway's own edit. */
function declaredDormant(markdown: string): boolean {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (block === null) return false;
  const line = /^[ \t]*(?:"disable-model-invocation"|'disable-model-invocation'|disable-model-invocation)[ \t]*:[ \t]*(.*)$/m.exec(block[1]!);
  return line !== null && line[1]!.trim() === "true";
}

const TOGGLE_DOCUMENT = "---\nname: pdf\ndescription: Work with PDF files\n---\n# PDF Processing Guide\n";

test("toggles the document's own key on a local host without touching the rest of the directory", async () => {
  const fixture = await localFixture();
  try {
    await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: [{ path: "SKILL.md", content: TOGGLE_DOCUMENT, encoding: "utf8" }, ...FILES] });
    const skillPath = join(fixture.root, ".agents", "skills", "pdf", "SKILL.md");
    const before = await readFile(skillPath, "utf8");

    const on = await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "pdf", disableModelInvocation: true });
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(value(on).changed, true);
    const updated = await readFile(skillPath, "utf8");
    assert.equal(updated, "---\ndisable-model-invocation: true\nname: pdf\ndescription: Work with PDF files\n---\n# PDF Processing Guide\n");
    assert.equal(declaredDormant(updated), true);
    // Every other file of the bundle is the same bytes: the toggle edits one document, not the directory.
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
    assert.deepEqual(await readFile(join(fixture.root, ".agents", "skills", "pdf", "assets", "logo.png")), PNG);

    // The key is already set, so the second call reports no change and does not rewrite the file at all: the inode
    // and its timestamps are the ones the first edit left, not merely the same bytes.
    const unchanged = await lstat(skillPath, { bigint: true });
    const again = await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "pdf", disableModelInvocation: true });
    assert.equal(value(again).changed, false);
    assert.equal(await readFile(skillPath, "utf8"), updated);
    const after = await lstat(skillPath, { bigint: true });
    assert.deepEqual([after.ino, after.mtimeNs, after.ctimeNs], [unchanged.ino, unchanged.mtimeNs, unchanged.ctimeNs], "an unchanged document is not rewritten");

    // Clearing removes the key and returns the document to exactly what it held before; clearing again is a no-op.
    const off = await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "pdf", disableModelInvocation: false });
    assert.equal(value(off).changed, true);
    assert.equal(await readFile(skillPath, "utf8"), before);
    assert.equal(value(await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "pdf", disableModelInvocation: false })).changed, false);
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("refuses a toggle the scope cannot own, and reports it as a result rather than a host failure", async () => {
  const fixture = await localFixture();
  try {
    // Nothing is installed at that directory, so there is no document to edit.
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "pdf", disableModelInvocation: true })).code, "not_found");
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "global", directory: "pdf", disableModelInvocation: true })).code, "not_found");
    // A name that is not a slug is refused before any path is built.
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "Notes", disableModelInvocation: true })).code, "invalid");
    // A directory that is a link out of the scope is refused instead of followed, and its target is untouched.
    await mkdir(join(fixture.other, ".agents", "skills"), { recursive: true });
    await mkdir(join(fixture.home, ".agents", "skills", "elsewhere"), { recursive: true });
    await writeFile(join(fixture.home, ".agents", "skills", "elsewhere", "SKILL.md"), TOGGLE_DOCUMENT);
    await symlink(join(fixture.home, ".agents", "skills", "elsewhere"), join(fixture.other, ".agents", "skills", "linked"));
    assert.equal(error(await fixture.installs.execute({ workspaceId: "second", operation: "toggleSkill", scope: "workspace", directory: "linked", disableModelInvocation: true })).code, "permission_denied");
    assert.equal(await readFile(join(fixture.home, ".agents", "skills", "elsewhere", "SKILL.md"), "utf8"), TOGGLE_DOCUMENT, "the link's target is untouched");
    // A document whose frontmatter cannot be edited honestly is refused, never rewritten into something the loader drops.
    await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope: "workspace", directory: "odd", files: [{ path: "SKILL.md", content: "---\n{ name: odd }\n---\nBody.\n", encoding: "utf8" }] });
    assert.equal(error(await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope: "workspace", directory: "odd", disableModelInvocation: true })).code, "invalid");
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "odd", "SKILL.md"), "utf8"), "---\n{ name: odd }\n---\nBody.\n");
  } finally { await rm(fixture.base, { recursive: true, force: true }); }
});

test("toggles the document's own key on a controlled SSH host with the same bytes", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    const { runner } = fakeInstallHost({ home, root });
    const installs = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner });
    await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "global", directory: "pdf", files: [{ path: "SKILL.md", content: TOGGLE_DOCUMENT, encoding: "utf8" }, ...FILES] });
    const skillPath = join(home, ".agents", "skills", "pdf", "SKILL.md");

    const on = await installs.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "pdf", disableModelInvocation: true });
    assert.equal(on.ok, true, JSON.stringify(on));
    assert.equal(value(on).changed, true);
    // The remote host writes the byte-for-byte document the local host writes: one rule, two hosts.
    assert.equal(await readFile(skillPath, "utf8"), "---\ndisable-model-invocation: true\nname: pdf\ndescription: Work with PDF files\n---\n# PDF Processing Guide\n");
    assert.equal(value(await installs.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "pdf", disableModelInvocation: true })).changed, false);
    assert.equal(value(await installs.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "pdf", disableModelInvocation: false })).changed, true);
    assert.equal(await readFile(skillPath, "utf8"), TOGGLE_DOCUMENT);
    // An absent directory and an unnameable one are the helper's own results, not transport failures.
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "ghost", disableModelInvocation: true })).code, "not_found");
    assert.equal(error(await installs.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "../escape", disableModelInvocation: true })).code, "invalid");
    // The other bundle files are untouched by the edit.
    assert.equal(await readFile(join(home, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a toggle's outcome is never replayed when the host's response is lost", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-ssh-"));
  try {
    const calls: unknown[] = [];
    const lost = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: join(base, "app") }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: join(base, "app") }])), runner: { execute: async (request) => { calls.push(request); throw Object.assign(new Error("lost"), { code: "outcome_unknown" }); } } });
    const result = await lost.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope: "global", directory: "pdf", disableModelInvocation: true });
    assert.equal(error(result).code, "outcome_unknown");
    assert.equal(calls.length, 1, "an uncertain edit is reported, never sent twice");
  } finally { await rm(base, { recursive: true, force: true }); }
});

/**
 * The two hosts must not drift. The local edit is src/skill-frontmatter.ts and the remote one is that rule transcribed
 * into the stdlib-only helper, so every document shape is pushed through both and the resulting bytes, the change flag
 * and the refusal are compared. A shape one host accepts and the other refuses would be a divergence the user would
 * only ever meet on the other host.
 */
test("edits the same document identically on a local and an SSH host, for every frontmatter shape", async () => {
  const fixture = await localFixture();
  const base = await mkdtemp(join(tmpdir(), "hepi-install-parity-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  try {
    const { runner } = fakeInstallHost({ home, root });
    const ssh = new SshInstallServer({ profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner });
    const documents: [string, string][] = [
      ["plain", "---\nname: pdf\ndescription: Work with PDF files\n---\n# Guide\n"],
      ["explicit-false", "---\nname: pdf\ndisable-model-invocation: false\ndescription: Docs\n---\nBody.\n"],
      ["no-frontmatter", "Just a body, no frontmatter at all.\n"],
      ["indented", "---\n  name: pdf\n  description: Docs\n---\nBody.\n"],
      ["quoted", "---\n  name: pdf\n  \"disable-model-invocation\": false\n---\nBody.\n"],
      ["crlf", "---\r\nname: pdf\r\ndescription: Docs\r\n---\r\nBody.\r\n"],
      ["bom", "\uFEFF---\nname: pdf\ndescription: Docs\n---\nBody.\n"],
      ["cr-only", "---\rname: pdf\rdescription: Docs\r---\rBody.\r"],
      ["comments", "---\nname: pdf\n# a comment\nallowed-tools: [ read, write ]\ndescription: Docs\n---\nBody.\n"],
      ["nested", "---\nname: pdf\nmetadata:\n  disable-model-invocation: false\n---\nBody.\n"],
      ["flow", "---\n{ name: pdf }\n---\nBody.\n"],
      ["sequence", "---\n- one\n- two\n---\nBody.\n"],
      ["empty-block", "---\n---\nBody.\n"],
      ["truncated", "---\nname: pdf\n"],
    ];
    for (const [name, document] of documents) {
      for (const scope of ["workspace", "global"] as const) {
        const files = [{ path: "SKILL.md", content: document, encoding: "utf8" as const }];
        assert.equal((await fixture.installs.execute({ workspaceId: "local", operation: "publishDirectory", scope, directory: name, files })).ok, true, name);
        assert.equal((await ssh.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope, directory: name, files })).ok, true, name);
        const localRoot = scope === "workspace" ? fixture.root : fixture.home;
        const remoteRoot = scope === "workspace" ? root : home;
        for (const disable of [true, false]) {
          const local = await fixture.installs.execute({ workspaceId: "local", operation: "toggleSkill", scope, directory: name, disableModelInvocation: disable });
          const remote = await ssh.execute({ workspaceId: "remote-prod", operation: "toggleSkill", scope, directory: name, disableModelInvocation: disable });
          // The refusal is compared too: the same shape is refused on both hosts, or accepted on both.
          assert.deepEqual(
            local.ok ? { ok: true, changed: value(local).changed } : { ok: false, code: error(local).code },
            remote.ok ? { ok: true, changed: value(remote).changed } : { ok: false, code: error(remote).code },
            name + " disable=" + disable,
          );
          assert.equal(
            await readFile(join(localRoot, ".agents", "skills", name, "SKILL.md"), "utf8"),
            await readFile(join(remoteRoot, ".agents", "skills", name, "SKILL.md"), "utf8"),
            name + " disable=" + disable + " bytes",
          );
        }
      }
    }
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});
