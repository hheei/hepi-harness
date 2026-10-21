import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalFilesystem, MAX_FILE_BYTES } from "../src/filesystem.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";

async function workspace(): Promise<string> { return await mkdtemp(join(tmpdir(), "hepi-files-")); }
function failure(result: unknown): { code: string; message: string } { return (result as { error: { code: string; message: string } }).error; }
function value(result: unknown): unknown { return (result as { value: unknown }).value; }
async function gone(path: string): Promise<boolean> { return await lstat(path).then(() => false, () => true); }

test("reads, writes, edits and inspects a local workspace through bounded requests", async () => {
  const root = await workspace();
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/src/app.ts" })), "export const value = 1;\n");
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/src/app.ts", content: "export const value = 2;\n" }), { ok: true, value: undefined });
    assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "export const value = 2;\n");
    const info = value(await files.execute({ workspaceId: "ws", method: "fileInfo", path: "/src/app.ts" })) as { name: string; path: string; kind: string; size: number };
    assert.deepEqual({ name: info.name, path: info.path, kind: info.kind, size: info.size }, { name: "app.ts", path: "/src/app.ts", kind: "file", size: 24 });
    assert.deepEqual((value(await files.execute({ workspaceId: "ws", method: "listDir", path: "/src" })) as { name: string }[]).map(entry => entry.name), ["app.ts"]);
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "canonicalPath", path: "/src/app.ts" })), "/src/app.ts");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "exists", path: "/src/missing.ts" })), false);
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "createDir", path: "/out/nested", options: { recursive: true } }), { ok: true, value: undefined });
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "renameFile", path: "/src/app.ts", destinationPath: "/out/nested/app.ts" }), { ok: true, value: undefined });
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/out/nested/app.ts" })), "export const value = 2;\n");
    const temporary = value(await files.execute({ workspaceId: "ws", method: "createTempFile", prefix: "hepi-", suffix: ".tmp" })) as string;
    assert.ok(temporary.startsWith("/hepi-") && temporary.endsWith(".tmp"));
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: temporary })), "");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "createTempDir", prefix: "../../escape-" })).code, "invalid");
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "remove", path: "/out", options: { recursive: true } }), { ok: true, value: undefined });
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "exists", path: "/out" })), false);
    const bytes = Buffer.from("héllo", "utf8");
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/blob.bin", content: bytes.toString("base64"), encoding: "base64" }), { ok: true, value: undefined });
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readBinaryFile", path: "/blob.bin" })), bytes.toString("base64"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("keeps the account's own .agents/skills global when the workspace lives below the account home", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-files-"));
  const home = join(base, "home");
  const root = join(home, "site", "app");
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(base, ".agents", "skills", "ancestor"), { recursive: true });
  await mkdir(join(base, ".git"));
  await mkdir(root, { recursive: true });
  try {
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]), { identity: { user: "operator", home } });
    const host = value(await files.execute({ workspaceId: "ws", method: "executionHost" })) as { roots: { scope: string; kind: string; path: string }[] };
    const realHome = await realpath(home);
    const realBase = await realpath(base);
    // The ancestor walk passes through the account home, so upstream filters the account's own `.agents/skills` out of
    // it (`collectAncestorAgentsSkillDirs`): the directory stays the single user-ranked root it is added as below.
    assert.deepEqual(host.roots.map(item => [item.scope, item.path]), [
      ["ancestor", join(realBase, ".agents", "skills")],
      ["global", join(realHome, ".agents", "skills")],
    ]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("refuses paths and symlinks outside the local workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-files-"));
  const root = join(directory, "workspace");
  await mkdir(root);
  try {
    await writeFile(join(directory, "outside.txt"), "secret");
    await symlink(directory, join(root, "escape"));
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "../outside.txt" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/escape/outside.txt" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "renameFile", path: "/escape/outside.txt", destinationPath: "/inside.txt" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/escape/outside.txt", content: "changed" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "remove", path: "/escape", options: { recursive: true } })).code, "permission_denied");
    assert.equal(await readFile(join(directory, "outside.txt"), "utf8"), "secret");
    assert.equal(failure(await files.execute({ workspaceId: "other", method: "readTextFile", path: "/" })).code, "permission_denied");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("refuses writes and appends through dangling symlinks that point outside the workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-files-"));
  const root = join(directory, "workspace");
  const outside = join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  try {
    // A dangling symlink resolves to ENOENT, so an ENOENT-only confinement check treats it as a missing path and lets
    // the following create run through the link. Both the leaf and an ancestor component must be refused instead.
    await symlink(join(outside, "created-leaf.txt"), join(root, "dangling-leaf.txt"));
    await symlink(join(outside, "created-dir"), join(root, "dangling-dir"));
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/dangling-leaf.txt", content: "escaped" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "appendFile", path: "/dangling-leaf.txt", content: "escaped" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/dangling-dir/created.txt", content: "escaped" })).code, "permission_denied");
    assert.ok(await gone(join(outside, "created-leaf.txt")), "the dangling leaf target was never created");
    assert.ok(await gone(join(outside, "created-dir")), "the dangling ancestor target was never created");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accepts the physical absolute path a shell prints, and refuses one outside the workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-files-"));
  const root = join(directory, "workspace");
  const other = join(directory, "workspace-other");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(other);
  try {
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(join(other, "app.ts"), "outside");
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
    const physical = join(root, "src", "app.ts");
    // The physical absolute path and the logical workspace path name the same file.
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: physical })), "export const value = 1;\n");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/src/app.ts" })), "export const value = 1;\n");
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "writeFile", path: physical, content: "export const value = 2;\n" }), { ok: true, value: undefined });
    assert.equal(await readFile(physical, "utf8"), "export const value = 2;\n");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "writeFile", path: join(root, "src", "other.ts"), content: "x" })), undefined);
    assert.equal(await readFile(join(root, "src", "other.ts"), "utf8"), "x");
    const info = value(await files.execute({ workspaceId: "ws", method: "fileInfo", path: physical })) as { path: string };
    assert.equal(info.path, "/src/app.ts", "a result still reports the logical workspace path");
    // A host path outside the root never reaches the host: it is read as a logical path and simply is not there. The
    // prefix boundary holds too, so a sibling whose name starts with the root's is not taken as inside the workspace.
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(other, "app.ts") })).code, "not_found");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(root + "-other", "app.ts") })).code, "not_found");
    // A write to a host path outside the root lands inside the workspace, at the path that host path maps to; the
    // host file is never touched, and the same mapping reads the bytes back.
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "writeFile", path: join(other, "app.ts"), content: "changed" }), { ok: true, value: undefined });
    assert.equal(await readFile(join(other, "app.ts"), "utf8"), "outside");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(other, "app.ts") })), "changed");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/etc/hosts" })).code, "not_found");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "../outside.txt" })).code, "permission_denied");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resolves the execution account and serves resource roots read-only", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-exec-host-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  const root = join(repository, "app");
  await mkdir(join(home, ".agents", "skills", "notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "skills", "account"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "shared"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy"), { recursive: true });
  await mkdir(join(root, ".pi", "skills", "workspace"), { recursive: true });
  await mkdir(join(repository, ".git"));
  await writeFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "global body\n");
  await writeFile(join(home, ".pi", "agent", "skills", "account", "SKILL.md"), "account pi body\n");
  await writeFile(join(repository, ".agents", "skills", "shared", "SKILL.md"), "ancestor body\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "project body\n");
  await writeFile(join(root, ".pi", "skills", "workspace", "SKILL.md"), "workspace pi body\n");
  try {
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]), { identity: { user: "operator", home } });
    const host = value(await files.execute({ workspaceId: "ws", method: "executionHost" })) as {
      user: string; home: string; workspaceRoot: string; roots: { scope: string; kind: string; path: string; requiresTrust?: boolean }[];
    };
    assert.equal(host.user, "operator");
    assert.equal(host.home, await realpath(home));
    assert.equal(host.workspaceRoot, await realpath(root));
    // The order is upstream's precedence: the workspace's own `.pi` skills, its `.agents` skills, each ancestor's
    // `.agents` skills, the account's `.pi/agent` skills, then its `.agents` skills. Both `.pi` roots are marked as
    // project-trust gated, which the loader honours.
    const realHome = await realpath(home);
    const realRepository = await realpath(repository);
    const realRoot = await realpath(root);
    assert.deepEqual(host.roots.map(item => [item.kind, item.scope, item.path, item.requiresTrust === true]), [
      ["skills", "project", join(realRoot, ".pi", "skills"), true],
      ["skills", "project", join(realRoot, ".agents", "skills"), false],
      ["skills", "ancestor", join(realRepository, ".agents", "skills"), false],
      ["skills", "global", join(realHome, ".pi", "agent", "skills"), false],
      ["skills", "global", join(realHome, ".agents", "skills"), false],
    ]);
    // An ordinary read reaches the global and ancestor skill files, which live outside the workspace root.
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(host.home, ".agents", "skills", "notes", "SKILL.md") })), "global body\n");
    const listed = value(await files.execute({ workspaceId: "ws", method: "listDir", path: join(host.home, ".agents", "skills") })) as { name: string; path: string }[];
    assert.deepEqual(listed.map(entry => entry.name), ["notes"]);
    assert.equal(listed[0]!.path, join(host.home, ".agents", "skills", "notes"));
    const ancestorRoot = host.roots.find((item) => item.scope === "ancestor")!;
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(ancestorRoot.path, "shared", "SKILL.md") })), "ancestor body\n");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(host.workspaceRoot, ".agents", "skills", "deploy", "SKILL.md") })), "project body\n");
    // The account's `.pi/agent/skills` and the workspace's own `.pi/skills` are roots too: an ordinary read reaches
    // them at their real host paths, inside the workspace for the project one.
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(realHome, ".pi", "agent", "skills", "account", "SKILL.md") })), "account pi body\n");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(realRoot, ".pi", "skills", "workspace", "SKILL.md") })), "workspace pi body\n");
    // Prompts and context are execution-side resources too: their real host paths are readable, and neither the
    // account's credentials nor any other file outside a resource root is.
    await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
    await mkdir(join(root, ".pi", "prompts"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "Summarize $1.\n");
    await writeFile(join(root, ".pi", "prompts", "ship.md"), "Ship it.\n");
    await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "GLOBAL SYSTEM\n");
    await writeFile(join(root, ".pi", "SYSTEM.md"), "PROJECT SYSTEM\n");
    await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "GLOBAL CONTEXT\n");
    await writeFile(join(repository, "AGENTS.md"), "ANCESTOR CONTEXT\n");
    await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT\n");
    await writeFile(join(home, ".pi", "agent", "auth.json"), "SECRET-account-key\n");
    const hostWithPrompts = value(await files.execute({ workspaceId: "ws", method: "executionHost" })) as {
      roots: { scope: string; kind: string; path: string }[];
      contextFiles: string[];
      systemPromptFiles: { scope: string; path: string }[];
      appendSystemPromptFiles: { scope: string; path: string }[];
    };
    assert.deepEqual(hostWithPrompts.roots.map(item => [item.kind, item.scope]), [["skills", "project"], ["skills", "project"], ["skills", "ancestor"], ["skills", "global"], ["skills", "global"], ["prompts", "project"], ["prompts", "global"]]);
    assert.deepEqual(hostWithPrompts.contextFiles, [join(realHome, ".pi", "agent", "AGENTS.md"), join(await realpath(repository), "AGENTS.md"), join(realRoot, "AGENTS.md")]);
    assert.deepEqual(hostWithPrompts.systemPromptFiles.map(file => [file.scope, file.path]), [["global", join(realHome, ".pi", "agent", "SYSTEM.md")], ["project", join(realRoot, ".pi", "SYSTEM.md")]]);
    assert.deepEqual(hostWithPrompts.appendSystemPromptFiles, []);
    for (const path of [join(realHome, ".pi", "agent", "prompts", "summarize.md"), join(realRoot, ".pi", "prompts", "ship.md"), join(realHome, ".pi", "agent", "SYSTEM.md"), join(realRoot, ".pi", "SYSTEM.md"), join(realHome, ".pi", "agent", "AGENTS.md"), join(realRoot, "AGENTS.md")]) {
      assert.ok((await files.execute({ workspaceId: "ws", method: "readTextFile", path })) && (value(await files.execute({ workspaceId: "ws", method: "readTextFile", path })) as string).length > 0, path);
    }
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(realHome, ".pi", "agent", "auth.json") })).code, "not_found");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: join(realHome, ".pi", "agent", "SYSTEM.md"), content: "changed" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: join(realHome, ".pi", "agent", "AGENTS.md"), content: "changed" })).code, "permission_denied");
    assert.equal(await readFile(join(home, ".pi", "agent", "SYSTEM.md"), "utf8"), "GLOBAL SYSTEM\n");
    // A link to a resource file is not that file: the authorized path is the canonical one, not a path that reaches it.
    await symlink(join(home, ".pi", "agent", "SYSTEM.md"), join(root, ".pi", "alias.md"));
    const alias = await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(root, ".pi", "alias.md") });
    assert.ok(["not_found", "permission_denied"].includes(failure(alias).code), JSON.stringify(alias));
    await rm(join(root, ".pi", "alias.md"));
    // Resource roots are read-only, and the execution account home itself is not one.
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: join(host.home, ".agents", "skills", "notes", "SKILL.md"), content: "changed" })).code, "permission_denied");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "remove", path: join(host.home, ".agents", "skills"), options: { recursive: true } })).code, "permission_denied");
    // Every accepted path form names the same file, so a logical or relative alias of a resource is refused too:
    // checking only the physical path would let these write the project's skill and context files.
    for (const alias of ["/.agents/skills/deploy/SKILL.md", "AGENTS.md", "/.pi/skills/workspace/SKILL.md"]) {
      assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: alias, content: "changed" })).code, "permission_denied", alias);
      assert.equal(failure(await files.execute({ workspaceId: "ws", method: "remove", path: alias })).code, "permission_denied", alias);
      assert.equal(failure(await files.execute({ workspaceId: "ws", method: "renameFile", path: alias, destinationPath: "/moved.md" })).code, "permission_denied", alias);
      assert.equal(failure(await files.execute({ workspaceId: "ws", method: "renameFile", path: "/note.md", destinationPath: alias })).code, "permission_denied", alias);
    }
    assert.equal(await readFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "utf8"), "project body\n");
    assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "PROJECT CONTEXT\n");
    assert.equal(await readFile(join(root, ".pi", "skills", "workspace", "SKILL.md"), "utf8"), "workspace pi body\n");
    await writeFile(join(home, "id_rsa"), "SECRET-key");
    const secret = await files.execute({ workspaceId: "ws", method: "readTextFile", path: join(host.home, "id_rsa") });
    assert.equal(JSON.stringify(secret).includes("SECRET-key"), false, "the execution account home is not a resource root");
    assert.equal(await readFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), "global body\n");
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("bounds oversized reads and writes and rejects non-regular files", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "small.txt"), "one line\ntwo\n");
    await writeFile(join(root, "huge.bin"), "");
    await truncate(join(root, "huge.bin"), MAX_FILE_BYTES + 1);
    await mkdir(join(root, "dir"));
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
    const tooLarge = "file is " + (MAX_FILE_BYTES + 1) + " bytes; the gateway limit is " + MAX_FILE_BYTES + " bytes";
    for (const method of ["readTextFile", "readBinaryFile", "openBinaryReader"]) {
      const result = await files.execute({ workspaceId: "ws", method, path: "/huge.bin" });
      assert.deepEqual(failure(result), { code: "invalid", message: tooLarge });
    }
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "readTextFile", path: "/dir" })).code, "is_directory");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/dir", content: "x" })).code, "is_directory");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "writeFile", path: "/big.txt", content: "x".repeat(MAX_FILE_BYTES + 1) })).code, "invalid");
    const opened = await files.execute({ workspaceId: "ws", method: "openBinaryReader", path: "/small.txt" });
    const handle = value(opened) as string;
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "reader.read", handle, offset: 0, length: MAX_FILE_BYTES + 1 })).code, "invalid");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "reader.read", handle, offset: -1, length: 1 })).code, "invalid");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "reader.rename", handle })).code, "not_supported");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "watch", path: "/" })).code, "not_supported");
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "reader.info", handle: "missing" })).code, "invalid");
    await files.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reads opened files by handle and expires handles by idle time and count", async () => {
  const root = await workspace();
  try {
    await writeFile(join(root, "a.txt"), "alpha\nbeta\n");
    await writeFile(join(root, "b.txt"), "second\n");
    const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]), { maxReaders: 1 });
    const first = value(await files.execute({ workspaceId: "ws", method: "openBinaryReader", path: "/a.txt" })) as string;
    const second = value(await files.execute({ workspaceId: "ws", method: "openBinaryReader", path: "/b.txt" })) as string;
    assert.equal(failure(await files.execute({ workspaceId: "ws", method: "reader.info", handle: first })).code, "invalid");
    assert.equal(value(await files.execute({ workspaceId: "ws", method: "reader.read", handle: second, offset: 0, length: 6 })), Buffer.from("second").toString("base64"));
    const scan = value(await files.execute({ workspaceId: "ws", method: "reader.scanLines", handle: second, options: { startLine: 0 } })) as { newlines: number };
    assert.equal(scan.newlines, 1);
    assert.deepEqual(await files.execute({ workspaceId: "ws", method: "reader.close", handle: second }), { ok: true });
    const expiring = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]), { readerTtlMs: 0 });
    const handle = value(await expiring.execute({ workspaceId: "ws", method: "openBinaryReader", path: "/a.txt" })) as string;
    assert.equal(failure(await expiring.execute({ workspaceId: "ws", method: "reader.info", handle })).code, "invalid");
    await files.close();
    await expiring.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
