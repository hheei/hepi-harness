import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalFilesystem } from "../src/filesystem.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { fakeSsh } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/** The host's answer for one workspace, as the loader reads it. */
function value(result: unknown): Record<string, unknown> { return (result as { value: Record<string, unknown> }).value; }

type Host = { workspaceRoot: string; contextFiles: string[]; shadowedContextFile?: string };

/**
 * The git metadata of one layout, written as files instead of produced by git: the rule reads `.git`, a `.git` file's
 * `gitdir:` target, the `commondir` file and `HEAD`, and nothing else, so a directory tree with those four entries is
 * the same input the rule sees on a host. Each writer below spells one layout, and the fixture is deterministic, has no
 * repository state and no git binary in it.
 */
async function repository(directory: string, name = ".git"): Promise<void> {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, "HEAD"), "ref: refs/heads/main\n");
}

/** A linked worktree's `.git` file, its own git directory and the `commondir` that points at the repository's. */
async function linkedWorktree(worktree: string, ownGitDir: string, commonGitDir: string): Promise<void> {
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, ".git"), "gitdir: " + ownGitDir + "\n");
  await mkdir(ownGitDir, { recursive: true });
  await writeFile(join(ownGitDir, "HEAD"), "ref: refs/heads/feature\n");
  await writeFile(join(ownGitDir, "commondir"), "../..\n");
  await mkdir(commonGitDir, { recursive: true });
}

const host = async (files: LocalFilesystem, workspaceId: string): Promise<Host> =>
  value(await files.execute({ workspaceId, method: "executionHost" })) as Host;

/**
 * The linked-worktree context shadow, against the git layouts git writes: a nested worktree's own context file is the
 * one in effect, so the main repository's file of the same name is reported as shadowed. A sibling worktree, an
 * ordinary repository, a bare layout and a submodule share none of that shape and must not be reported as shadowed, or
 * a repository would silently lose a context file it has.
 */
test("reports the shadowed main-repository context file of a nested linked worktree", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-worktree-"));
  try {
    const main = join(base, "main");
    await mkdir(main);
    await repository(main);
    const mainContext = join(main, "AGENTS.md");
    await writeFile(mainContext, "MAIN REPO CONTEXT\n");
    const worktree = join(main, "nested", "wt");
    await linkedWorktree(worktree, join(main, ".git", "worktrees", "wt"), join(main, ".git"));
    const ownContext = join(worktree, "AGENTS.md");
    await writeFile(ownContext, "WORKTREE OWN CONTEXT\n");
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "wt", root: worktree }]));
    const reported = await host(files, "wt");
    assert.equal(reported.shadowedContextFile, await realpath(mainContext));
    assert.deepEqual(new Set(reported.contextFiles), new Set([await realpath(ownContext), await realpath(mainContext)]));
    assert.equal(value(await files.execute({ workspaceId: "wt", method: "readTextFile", path: ownContext })), "WORKTREE OWN CONTEXT\n");
    // The main repository's file is still a real file on the host; only the loader stops loading it.
    assert.equal(value(await files.execute({ workspaceId: "wt", method: "readTextFile", path: mainContext })), "MAIN REPO CONTEXT\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("does not report a shadow for layouts whose main repository is not an ancestor", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-worktree-"));
  try {
    const main = join(base, "main");
    await mkdir(main);
    await repository(main);
    const mainContext = join(main, "AGENTS.md");
    await writeFile(mainContext, "MAIN REPO CONTEXT\n");
    // The main repository itself is an ordinary checkout: it is its own repository root.
    const ordinary = await host(new LocalFilesystem(new WorkspaceRegistry([{ id: "main", root: main }])), "main");
    assert.equal(ordinary.shadowedContextFile, undefined);
    // A sibling worktree's main repository is not its ancestor.
    const sibling = join(base, "sibling");
    await linkedWorktree(sibling, join(main, ".git", "worktrees", "sibling"), join(main, ".git"));
    await writeFile(join(sibling, "AGENTS.md"), "SIBLING OWN CONTEXT\n");
    assert.equal((await host(new LocalFilesystem(new WorkspaceRegistry([{ id: "sib", root: sibling }])), "sib")).shadowedContextFile, undefined);
    // A bare layout: the directory holding the common git directory tracks nothing, so nothing is shadowed.
    const bare = join(base, "bare.git");
    await mkdir(bare);
    await writeFile(join(bare, "HEAD"), "ref: refs/heads/main\n");
    const bareWorktree = join(base, "bare-main");
    await linkedWorktree(bareWorktree, join(bare, "worktrees", "bare-main"), bare);
    await writeFile(join(bareWorktree, "AGENTS.md"), "BARE WORKTREE CONTEXT\n");
    assert.equal((await host(new LocalFilesystem(new WorkspaceRegistry([{ id: "bare", root: bareWorktree }])), "bare")).shadowedContextFile, undefined);
    // A submodule's git directory is the superproject's modules directory, and it carries no `commondir`: the git
    // directory it names is its own common directory, which is not the superproject's, so the second check rejects it.
    const submodule = join(main, "lib");
    await mkdir(submodule, { recursive: true });
    const submoduleGitDir = join(main, ".git", "modules", "lib");
    await writeFile(join(submodule, ".git"), "gitdir: " + submoduleGitDir + "\n");
    await mkdir(submoduleGitDir, { recursive: true });
    await writeFile(join(submoduleGitDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(submodule, "AGENTS.md"), "SUBMODULE OWN CONTEXT\n");
    assert.equal((await host(new LocalFilesystem(new WorkspaceRegistry([{ id: "lib", root: submodule }])), "lib")).shadowedContextFile, undefined);
    assert.ok(mainContext.length > 0);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("resolves the same shadow on a remote host through the SSH helper", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-worktree-"));
  try {
    const main = join(base, "main");
    await mkdir(main);
    await repository(main);
    const mainContext = join(main, "AGENTS.md");
    await writeFile(mainContext, "MAIN REPO CONTEXT\n");
    const home = join(base, "remote-home");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    const worktree = join(main, "nested", "wt");
    await linkedWorktree(worktree, join(main, ".git", "worktrees", "wt"), join(main, ".git"));
    await writeFile(join(worktree, "AGENTS.md"), "REMOTE WORKTREE OWN CONTEXT\n");
    // The host serves the session in this process: the same helper operations, over the same real tree, with no Python
    // child and no transport to wait for.
    const ssh = fakeSsh({ root: worktree, account: { user: "remote-operator", home } });
    const files = new SshFilesystem({ id: "ssh", profiles: [{ id: "prod", host: "build.example", remoteRoot: worktree }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: worktree }])), runner: ssh.runner });
    try {
      const reported = value(await files.execute({ workspaceId: "remote-prod", method: "executionHost" })) as Host;
      assert.equal(reported.workspaceRoot, await realpath(worktree));
      assert.equal(reported.shadowedContextFile, await realpath(mainContext));
      assert.ok(reported.contextFiles.includes(await realpath(join(worktree, "AGENTS.md"))));
      assert.deepEqual(ssh.frames.map((frame) => frame.mode), ["discover"], "one discovery answers the whole host");
    } finally { await files.close(); }
  } finally { await rm(base, { recursive: true, force: true }); }
});
