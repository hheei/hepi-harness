import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { fakeSsh } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/**
 * The remote filesystem over a persistent session, against the deterministic host in `ssh-fake.ts`: the far side of
 * the frame protocol over a real temporary tree, so every operation, confinement refusal, reader identity and host
 * failure is asserted without spawning a helper or waiting on a clock.
 */

function failure(result: unknown): { code: string; message: string } { return (result as { error: { code: string; message: string } }).error; }
function value(result: unknown): unknown { return (result as { value: unknown }).value; }
function files(host: ReturnType<typeof fakeSsh>, root: string, options?: { readerTtlMs?: number; maxReaders?: number }): SshFilesystem {
  return new SshFilesystem({ id: "ssh", profiles: [{ id: "loopback", host: "loopback.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "loopback", host: "loopback.example", remoteRoot: root }])), runner: host.runner, ...options });
}

test("reads, writes and lists an SSH workspace through the remote helper", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi ssh-"));
  const remote = files(fakeSsh({ root }), root);
  t.after(async () => { await remote.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/src/app.ts" })), "export const value = 1;\n");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/src/app.ts", content: "export const value = 2;\n" }), { ok: true, value: undefined });
  assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "export const value = 2;\n");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/src/app.ts", content: "x".repeat(700_000) }), { ok: true, value: undefined });
  assert.equal((await readFile(join(root, "src", "app.ts"), "utf8")).length, 700_000);
  const info = value(await remote.execute({ workspaceId: "remote-loopback", method: "fileInfo", path: "/src/app.ts" })) as { path: string; kind: string };
  assert.deepEqual({ path: info.path, kind: info.kind }, { path: "/src/app.ts", kind: "file" });
  assert.deepEqual((value(await remote.execute({ workspaceId: "remote-loopback", method: "listDir", path: "/src" })) as { name: string }[]).map(entry => entry.name), ["app.ts"]);
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "canonicalPath", path: "/src/../src/app.ts" })), "/src/app.ts");
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "exists", path: "/src/missing.ts" })), false);
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "createDir", path: "/out", options: { recursive: true } }), { ok: true, value: undefined });
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "renameFile", path: "/src/app.ts", destinationPath: "/out/app.ts" }), { ok: true, value: undefined });
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "remove", path: "/out", options: { recursive: true, force: true } }), { ok: true, value: undefined });
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "exists", path: "/out" })), false);
  const tempDir = value(await remote.execute({ workspaceId: "remote-loopback", method: "createTempDir", path: "/", prefix: "hepi-" })) as string;
  assert.equal(tempDir.startsWith("/"), true);
  const tempFile = value(await remote.execute({ workspaceId: "remote-loopback", method: "createTempFile", path: "/", prefix: "hepi-", suffix: ".tmp" })) as string;
  assert.equal((await readFile(join(root, tempFile.slice(1)), "utf8")), "");
  const bytes = Buffer.from("héllo", "utf8");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/blob.bin", content: bytes.toString("base64"), encoding: "base64" }), { ok: true, value: undefined });
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "readBinaryFile", path: "/blob.bin" })), bytes.toString("base64"));
});

test("accepts the physical absolute path a remote shell prints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi ssh-"));
  const root = join(directory, "workspace");
  const other = join(directory, "workspace-other");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(other);
  const remote = files(fakeSsh({ root }), root);
  t.after(async () => { await remote.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  await writeFile(join(other, "app.ts"), "outside");
  const physical = join(root, "src", "app.ts");
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: physical })), "export const value = 1;\n");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: physical, content: "export const value = 2;\n" }), { ok: true, value: undefined });
  assert.equal(await readFile(physical, "utf8"), "export const value = 2;\n");
  assert.equal((value(await remote.execute({ workspaceId: "remote-loopback", method: "fileInfo", path: physical })) as { path: string }).path, "/src/app.ts");
  // A path outside the remote root is not a physical path there either: it maps under the root and is not found.
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: join(other, "app.ts") })).code, "not_found");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: join(root + "-other", "app.ts") })).code, "not_found");
  assert.equal(await readFile(join(other, "app.ts"), "utf8"), "outside");
});

test("confines remote paths, symlinks and unknown workspaces", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hepi ssh-"));
  const root = join(directory, "workspace");
  await mkdir(root);
  const remote = files(fakeSsh({ root }), root);
  t.after(async () => { await remote.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "outside.txt"), "secret");
  await symlink(directory, join(root, "escape"));
  const call = (path: string, method = "readTextFile") => remote.execute({ workspaceId: "remote-loopback", method, path });
  assert.equal(failure(await call("/../outside.txt")).code, "permission_denied");
  assert.equal(failure(await call("escape/outside.txt")).code, "permission_denied");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/escape/outside.txt", content: "changed" })).code, "permission_denied");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "remove", path: "/escape", options: { recursive: true } })).code, "permission_denied");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "renameFile", path: "/escape/outside.txt", destinationPath: "/inside.txt" })).code, "permission_denied");
  assert.equal(failure(await remote.execute({ workspaceId: "missing", method: "readTextFile", path: "/" })).code, "permission_denied");
  assert.equal(await readFile(join(directory, "outside.txt"), "utf8"), "secret");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "watch", path: "/" }), { ok: false, error: { code: "not_supported", message: "watch is not supported by the SSH filesystem" } });
});

test("reads opened remote files by handle and refuses a replaced file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi ssh-"));
  const remote = files(fakeSsh({ root }), root);
  t.after(async () => { await remote.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "a.txt"), "alpha\nbeta\n");
  const handle = value(await remote.execute({ workspaceId: "remote-loopback", method: "openBinaryReader", path: "/a.txt" })) as string;
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "reader.read", handle, offset: 0, length: 5 })), Buffer.from("alpha").toString("base64"));
  const scan = value(await remote.execute({ workspaceId: "remote-loopback", method: "reader.scanLines", handle, options: { startLine: 1, endLine: 2 } })) as { newlines: number; start: number; end: number };
  assert.deepEqual({ newlines: scan.newlines, start: scan.start, end: scan.end }, { newlines: 2, start: 6, end: 10 });
  assert.equal((value(await remote.execute({ workspaceId: "remote-loopback", method: "reader.info", handle })) as { path: string }).path, "/a.txt");
  // The reader identity is the device and inode it was opened as: a file replaced in place is refused, not re-read.
  await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/a.txt", content: "gamma\n" });
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "reader.read", handle, offset: 0, length: 5 })).code, "invalid");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "reader.close", handle }), { ok: true });
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "reader.info", handle })).code, "invalid");
  const expiring = files(fakeSsh({ root }), root, { readerTtlMs: 0 });
  t.after(async () => { await expiring.close(); });
  const expired = value(await expiring.execute({ workspaceId: "remote-loopback", method: "openBinaryReader", path: "/a.txt" })) as string;
  assert.equal(failure(await expiring.execute({ workspaceId: "remote-loopback", method: "reader.info", handle: expired })).code, "invalid");
});

test("bounds remote reads and reports unsupported, missing Python and unreachable outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi ssh-"));
  const host = fakeSsh({ root });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "huge.bin"), "x".repeat(1024));
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "truncateFile", path: "/huge.bin", size: -1 })).code, "invalid");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "reader.read", handle: "missing", offset: 0, length: 1 })).code, "invalid");
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "truncateFile", path: "/huge.bin", size: 2 }), { ok: true, value: undefined });
  assert.equal((await readFile(join(root, "huge.bin"), "utf8")).length, 2);
  // A host without Python 3 and a connection ssh itself refuses are both named failures, not unknown outcomes: the
  // session never answered, so what it said on stderr and the code it exited with are the whole diagnosis.
  const noPython = files(fakeSsh({ root, startup: { stderr: "bash: python3: command not found\n", exitCode: 127 } }), root);
  assert.equal(failure(await noPython.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/huge.bin" })).code, "not_supported");
  const unreachable = files(fakeSsh({ root, startup: { stderr: "ssh: connect to host loopback.example port 22: Connection refused\n", exitCode: 255 } }), root);
  assert.match(failure(await unreachable.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/huge.bin" })).message, /unreachable/);
  assert.match(failure(await unreachable.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/huge.bin", content: "y" })).message, /unreachable/);
  await noPython.close();
  await unreachable.close();
  assert.equal(await readFile(join(root, "huge.bin"), "utf8"), "xx");
  assert.ok(host.frames.some((frame) => frame.mode === "truncate"), "the successful operations still ran on the one session");
});
