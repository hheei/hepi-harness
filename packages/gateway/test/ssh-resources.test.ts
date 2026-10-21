import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { fakeSsh } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

function failure(result: unknown): { code: string; message: string } { return (result as { error: { code: string; message: string } }).error; }
function value(result: unknown): unknown { return (result as { value: unknown }).value; }

/**
 * A controlled SSH host whose remote account, home, workspace and repository are distinct from this machine's: the
 * host answers its own account and home, so a resource found under the remote home can only have come from the host the
 * environment resolved. The tree is real (a temporary directory), the protocol is the deterministic fake in
 * `ssh-fake.ts`, and every assertion is a file RPC or a frame the host was handed.
 */
async function fixture(options: { remoteHome?: string; nestedHome?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-resources-"));
  const home = options.remoteHome ?? join(base, "remote-home");
  // A nested layout puts the workspace below the account home and the repository above it, so the ancestor walk passes
  // through the account home on its way up.
  const repository = options.nestedHome === true ? base : join(base, "remote-repo");
  const root = options.nestedHome === true ? join(home, "site", "app") : join(repository, "app");
  const other = join(base, "other");
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "dup"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "skills", "dup"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "skills", "account-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "ancestor"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "proj"), { recursive: true });
  await mkdir(join(root, ".pi", "skills", "proj"), { recursive: true });
  await mkdir(join(root, ".pi", "skills", "workspace-notes"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  await mkdir(join(repository, ".git"));
  await mkdir(other, { recursive: true });
  await writeFile(join(home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
  await writeFile(join(repository, ".agents", "skills", "ancestor", "SKILL.md"), "---\nname: ancestor\ndescription: Ancestor rule\n---\nAncestor body.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
  // Same-name pairs, so the catalog shows which root wins: the account's `.pi/agent/skills` beats its `.agents/skills`,
  // and the workspace's own `.pi/skills` beats its `.agents/skills`.
  await writeFile(join(home, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account agents duplicate\n---\nAccount agents duplicate body.\n");
  await writeFile(join(home, ".pi", "agent", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account pi duplicate\n---\nAccount pi duplicate body.\n");
  await writeFile(join(home, ".pi", "agent", "skills", "account-notes", "SKILL.md"), "---\nname: account-notes\ndescription: Account pi notes\n---\nAccount pi notes body.\n");
  await writeFile(join(root, ".agents", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Project agents skill\n---\nProject agents body.\n");
  await writeFile(join(root, ".pi", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Project pi skill\n---\nProject pi body.\n");
  await writeFile(join(root, ".pi", "skills", "workspace-notes", "SKILL.md"), "---\nname: workspace-notes\ndescription: Workspace pi notes\n---\nWorkspace pi notes body.\n");
  await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1.\n");
  await writeFile(join(root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "REMOTE SYSTEM\n");
  await writeFile(join(root, ".pi", "SYSTEM.md"), "REMOTE PROJECT SYSTEM\n");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "REMOTE GLOBAL CONTEXT\n");
  await writeFile(join(repository, "AGENTS.md"), "REMOTE ANCESTOR CONTEXT\n");
  await writeFile(join(root, "AGENTS.md"), "REMOTE PROJECT CONTEXT\n");
  await writeFile(join(home, ".pi", "agent", "auth.json"), "SECRET-REMOTE-ACCOUNT-KEY\n");
  const account = { user: "remote-operator", home };
  const ssh = fakeSsh({ root, account });
  const files = new SshFilesystem({ id: "ssh", profiles: [{ id: "prod", host: "build.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: root }])), runner: ssh.runner });
  const read = (path: string, method = "readTextFile") => files.execute({ workspaceId: "remote-prod", method, path });
  return {
    base, home, repository, root, other, account, files, ssh, read,
    host: async () => value(await files.execute({ workspaceId: "remote-prod", method: "executionHost" })) as {
      user: string; home: string; workspaceRoot: string;
      roots: { scope: string; kind: string; path: string; requiresTrust?: boolean }[];
      contextFiles: string[]; systemPromptFiles: { scope: string; path: string }[]; appendSystemPromptFiles: { scope: string; path: string }[];
    },
    cleanup: async () => { await files.close(); await rm(base, { recursive: true, force: true }); },
  };
}

test("resolves the remote execution account and home from the host, never from the gateway", async () => {
  const server = await fixture();
  try {
    const host = await server.host();
    assert.equal(host.user, server.account.user);
    assert.equal(host.home, await realpath(server.home));
    assert.equal(host.workspaceRoot, await realpath(server.root));
    // The gateway's own account and home are never consulted: the helper asks the host it runs on.
    assert.notEqual(host.user, userInfo().username);
    assert.notEqual(host.home, homedir());
    // Upstream's precedence order: the workspace's own `.pi/skills`, its `.agents/skills`, each ancestor's
    // `.agents/skills`, the account's `.pi/agent/skills`, its `.agents/skills`, then the workspace's own
    // `.pi/prompts` ahead of the account's prompts directory, because project `local` outranks user `local`.
    assert.deepEqual(host.roots.map((root) => [root.kind, root.scope, root.requiresTrust === true]), [
      ["skills", "project", true], ["skills", "project", false], ["skills", "ancestor", false], ["skills", "global", false], ["skills", "global", false],
      ["prompts", "project", true], ["prompts", "global", false],
    ]);
    const realHome = await realpath(server.home);
    const realRepository = await realpath(server.repository);
    const realRoot = await realpath(server.root);
    assert.deepEqual(host.roots.map((root) => root.path), [
      join(realRoot, ".pi", "skills"),
      join(realRoot, ".agents", "skills"),
      join(realRepository, ".agents", "skills"),
      join(realHome, ".pi", "agent", "skills"),
      join(realHome, ".agents", "skills"),
      join(realRoot, ".pi", "prompts"),
      join(realHome, ".pi", "agent", "prompts"),
    ]);
    assert.deepEqual(host.contextFiles, [join(realHome, ".pi", "agent", "AGENTS.md"), join(realRepository, "AGENTS.md"), join(realRoot, "AGENTS.md")]);
    assert.deepEqual(host.systemPromptFiles.map((file) => [file.scope, file.path]), [["global", join(realHome, ".pi", "agent", "SYSTEM.md")], ["project", join(realRoot, ".pi", "SYSTEM.md")]]);
    assert.deepEqual(host.appendSystemPromptFiles, []);
    // The account and the scope set are one request, so the read authorization comes from the host's own answer while
    // a request that needs it pays one round trip instead of two.
    assert.deepEqual(server.ssh.frames.map((frame) => frame.mode), ["discover"]);
  } finally { await server.cleanup(); }
});

test("reads remote global, ancestor and project resources through ordinary file calls", async () => {
  const server = await fixture();
  try {
    const host = await server.host();
    const realHome = host.home;
    const realRepository = await realpath(server.repository);
    const realRoot = host.workspaceRoot;
    // A read keeps the real remote path outside the workspace and the logical path inside it.
    assert.equal(value(await server.read(join(realHome, ".agents", "skills", "global-notes", "SKILL.md"))), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
    assert.equal(value(await server.read(join(realRepository, ".agents", "skills", "ancestor", "SKILL.md"))), "---\nname: ancestor\ndescription: Ancestor rule\n---\nAncestor body.\n");
    assert.equal(value(await server.read("/.agents/skills/deploy/SKILL.md")), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
    const listed = value(await server.read(join(realHome, ".agents", "skills"), "listDir")) as { name: string; path: string }[];
    assert.deepEqual(listed.map((entry) => entry.name).sort(), ["dup", "global-notes"]);
    assert.equal(listed.find((entry) => entry.name === "global-notes")!.path, join(realHome, ".agents", "skills", "global-notes"));
    const info = value(await server.read(join(realHome, ".agents", "skills", "global-notes", "SKILL.md"), "fileInfo")) as { path: string; kind: string };
    assert.deepEqual({ path: info.path, kind: info.kind }, { path: join(realHome, ".agents", "skills", "global-notes", "SKILL.md"), kind: "file" });
    // The account's `.pi/agent/skills` and the workspace's `.pi/skills` are roots too, read at their real paths.
    assert.equal(value(await server.read(join(realHome, ".pi", "agent", "skills", "account-notes", "SKILL.md"))), "---\nname: account-notes\ndescription: Account pi notes\n---\nAccount pi notes body.\n");
    assert.equal(value(await server.read(join(realRoot, ".pi", "skills", "workspace-notes", "SKILL.md"))), "---\nname: workspace-notes\ndescription: Workspace pi notes\n---\nWorkspace pi notes body.\n");
    assert.equal(value(await server.read("/.pi/skills/workspace-notes/SKILL.md")), "---\nname: workspace-notes\ndescription: Workspace pi notes\n---\nWorkspace pi notes body.\n");
    // Prompts, system prompts and context are readable at their real remote paths too.
    for (const path of [join(realHome, ".pi", "agent", "prompts", "summarize.md"), join(server.root, ".pi", "prompts", "ship.md"), join(realHome, ".pi", "agent", "SYSTEM.md"), join(server.root, ".pi", "SYSTEM.md"), join(realHome, ".pi", "agent", "AGENTS.md"), join(server.root, "AGENTS.md")]) {
      assert.ok((value(await server.read(path)) as string).length > 0, path);
    }
    // Every one of those reads named its resource locations in the frame, so the host refused nothing: the locations
    // came from the host's own discovery answer rather than from this test.
    const reads = server.ssh.frames.filter((frame) => frame.mode === "read_text");
    assert.ok(reads.every((frame) => frame.allow.roots.length > 0 && frame.allow.files.length > 0), "a resource read carries the discovered locations");
  } finally { await server.cleanup(); }
});

test("refuses remote paths outside the workspace and the resource locations", async () => {
  const server = await fixture();
  try {
    const host = await server.host();
    // The account's other files are not resources: no blanket home authorization. An unauthorized absolute path is
    // reported missing, exactly as the local filesystem reports it, so it cannot be used to probe the host.
    assert.equal(failure(await server.read(join(host.home, ".pi", "agent", "auth.json"))).code, "not_found");
    assert.equal(failure(await server.read(join(host.home, "id_rsa"))).code, "not_found");
    assert.equal(failure(await server.read(join(server.other, "note.txt"))).code, "not_found");
    assert.equal(failure(await server.read("/../outside.txt")).code, "permission_denied");
    // Resource locations stay read-only: a mutation is confined to the workspace, not remapped to a resource root.
    const skill = join(host.home, ".agents", "skills", "global-notes", "SKILL.md");
    assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "writeFile", path: skill, content: "changed" })).code, "permission_denied");
    assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "remove", path: join(host.home, ".agents", "skills"), options: { recursive: true } })).code, "permission_denied");
    assert.equal(value(await server.read(skill)), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
    assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "truncateFile", path: skill, size: 0 })).code, "permission_denied");
    assert.equal(value(await server.read(skill)), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
    // Every accepted path form names the same file, so the logical and relative aliases of a resource are refused too.
    for (const alias of ["/.agents/skills/deploy/SKILL.md", "AGENTS.md", "/.pi/skills/workspace-notes/SKILL.md"]) {
      assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "writeFile", path: alias, content: "changed" })).code, "permission_denied", alias);
      assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "remove", path: alias })).code, "permission_denied", alias);
      assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "renameFile", path: alias, destinationPath: "/moved.md" })).code, "permission_denied", alias);
      assert.equal(failure(await server.files.execute({ workspaceId: "remote-prod", method: "renameFile", path: "/note.md", destinationPath: alias })).code, "permission_denied", alias);
    }
    assert.equal(value(await server.read("/.agents/skills/deploy/SKILL.md")), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
    assert.equal(value(await server.read("/AGENTS.md")), "REMOTE PROJECT CONTEXT\n");
    assert.equal(value(await server.read("/.pi/skills/workspace-notes/SKILL.md")), "---\nname: workspace-notes\ndescription: Workspace pi notes\n---\nWorkspace pi notes body.\n");
    // An absolute path that is not a resource keeps the workspace mapping, so it names nothing on the host.
    assert.equal(failure(await server.read(join(host.home, "id_rsa"), "canonicalPath")).code, "not_found");
    // The mutations that were refused never reached the host: the refusal is the gateway's, not a helper answer.
    assert.deepEqual(server.ssh.frames.filter((frame) => frame.mode === "write_begin" || frame.mode === "remove" || frame.mode === "rename"), []);
  } finally { await server.cleanup(); }
});

test("classifies and canonicalizes remote symlinks with the same rules as the local host", async () => {
  const server = await fixture();
  try {
    await mkdir(join(server.root, "links"));
    // A link inside the workspace resolves, and the canonical path is what a caller sees.
    await symlink(join(server.root, ".agents", "skills", "deploy"), join(server.root, "links", "deploy"));
    const info = value(await server.read("/links/deploy", "fileInfo")) as { kind: string };
    assert.equal(info.kind, "symlink");
    assert.equal(value(await server.read("/links/deploy", "canonicalPath")), "/.agents/skills/deploy");
    assert.equal(value(await server.read("/links/deploy/SKILL.md")), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
    // A link inside a resource root resolves inside it; a link out of every allowed location is refused.
    const host = await server.host();
    await symlink(join(server.home, ".agents", "skills", "global-notes"), join(server.home, ".agents", "skills", "zzz-alias"));
    assert.equal(value(await server.read(join(host.home, ".agents", "skills", "zzz-alias", "SKILL.md"))), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
    await writeFile(join(server.other, "SKILL.md"), "outside body\n");
    await symlink(server.other, join(server.home, ".agents", "skills", "leak"));
    assert.equal(failure(await server.read(join(host.home, ".agents", "skills", "leak", "SKILL.md"))).code, "permission_denied");
  } finally { await server.cleanup(); }
});

test("keeps the account's own .agents/skills global when the workspace lives below the account home", async () => {
  const server = await fixture({ nestedHome: true });
  try {
    const host = await server.host();
    const realHome = await realpath(server.home);
    const realRepository = await realpath(server.repository);
    const realRoot = await realpath(server.root);
    // The ancestor walk from the workspace reaches the account home, and upstream filters the account's own
    // `.agents/skills` out of that list (`collectAncestorAgentsSkillDirs`) so the directory keeps the user rank. It
    // appears once, as a global root, and never as an ancestor of the workspace.
    const agents = host.roots.filter((item) => item.kind === "skills" && item.path.endsWith("/.agents/skills"));
    assert.deepEqual(agents.map((item) => [item.scope, item.path]), [
      ["project", join(realRoot, ".agents", "skills")],
      ["ancestor", join(realRepository, ".agents", "skills")],
      ["global", join(realHome, ".agents", "skills")],
    ]);
  } finally { await server.cleanup(); }
});

test("reports an unreachable host without falling back to gateway or harness resources", async () => {
  const server = await fixture();
  try {
    const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: server.root }]));
    const unreachable = new SshFilesystem({ id: "ssh", profiles: [{ id: "prod", host: "build.example", remoteRoot: server.root }], workspaces: sshWorkspaces, runner: fakeSsh({ root: server.root, startup: { stderr: "ssh: connect to host build.example port 22: Connection refused\n", exitCode: 255 } }).runner });
    assert.match(failure(await unreachable.execute({ workspaceId: "remote-prod", method: "executionHost" })).message, /unreachable/);
    assert.match(failure(await unreachable.execute({ workspaceId: "remote-prod", method: "readTextFile", path: join(server.home, ".agents", "skills", "global-notes", "SKILL.md") })).message, /unreachable/);
    assert.match(failure(await unreachable.execute({ workspaceId: "remote-prod", method: "writeFile", path: "/note.txt", content: "x" })).message, /unreachable/);
    // The host's account database is required: a host that cannot report one fails explicitly.
    const anonymous = new SshFilesystem({ id: "ssh", profiles: [{ id: "prod", host: "build.example", remoteRoot: server.root }], workspaces: sshWorkspaces, runner: fakeSsh({ root: server.root, account: { user: "nobody", home: server.home, unresolvable: true } }).runner });
    assert.match(failure(await anonymous.execute({ workspaceId: "remote-prod", method: "executionHost" })).message, /did not report the execution account/);
    assert.match(failure(await anonymous.execute({ workspaceId: "remote-prod", method: "readTextFile", path: "/note.txt" })).message, /did not report the execution account/);
    await unreachable.close();
    await anonymous.close();
  } finally { await server.cleanup(); }
});
