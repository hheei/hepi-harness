import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import type { SshRunner } from "../src/index.ts";
import { fakeSsh, type FakeSsh } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/**
 * The remote filesystem over a persistent session: one helper process per (profile, root) whose standard streams carry
 * framed requests, instead of a fresh ssh process, a 51 KB helper payload and a Python start per operation.
 *
 * Every assertion here is made through the file RPC (`SshFilesystem.execute`) and the runner's own `open` — the two
 * public seams — so nothing below depends on how the session is implemented, only on what it does: which requests the
 * host sees, what a death reports, and what confinement still refuses.
 *
 * The host is `ssh-fake.ts`: the far side of the frame protocol over a real temporary tree, so a session's death,
 * lost answer, deadline and oversized frame are acted out deterministically. The barriers are the frames the host was
 * handed, never an elapsed time, so the whole file finishes in milliseconds instead of spawning a Python helper per
 * request.
 */

function failure(result: unknown): { code: string; message: string; path?: string } {
  return (result as { error: { code: string; message: string; path?: string } }).error;
}
function value(result: unknown): unknown { return (result as { value: unknown }).value; }

function files(host: FakeSsh, root: string, options: { sessionIdleMs?: number; requestTimeoutMs?: number } = {}): SshFilesystem {
  return new SshFilesystem({ id: "ssh", profiles: [{ id: "loopback", host: "loopback.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "loopback", host: "loopback.example", remoteRoot: root }])), runner: host.runner, ...options });
}

/** The helper modes the host was handed by one operation: the session's own traffic, measured at the transport. */
function modes(host: FakeSsh, run: () => Promise<unknown>): Promise<string[]> {
  const before = host.frames.length;
  return run().then(() => host.frames.slice(before).map((frame) => frame.mode));
}

test("one session serves a profile and root, and each operation runs the helper only where it must", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "src"));
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  const host = fakeSsh({ root });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const call = (request: Record<string, unknown>) => remote.execute({ workspaceId: "remote-loopback", ...request } as never);

  // The corrected counts: discovery is one run and carries the account (A1'), the size pre-check is gone (A2), and the
  // three methods that provably ignore the allow list run no authorization at all (A0).
  assert.deepEqual(await modes(host, async () => await call({ method: "executionHost" })), ["discover"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "readTextFile", path: "/src/app.ts" })), ["discover", "read_text"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "fileInfo", path: "/src/app.ts" })), ["discover", "info"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "listDir", path: "/src" })), ["discover", "list"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "createTempDir", prefix: "hepi-" })), ["tmpdir"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "createTempFile", prefix: "hepi-", suffix: ".tmp" })), ["tmpfile"]);
  const handle = value(await call({ method: "openBinaryReader", path: "/src/app.ts" })) as string;
  assert.deepEqual(await modes(host, async () => await call({ method: "reader.close", handle })), []);
  assert.deepEqual(await modes(host, async () => await call({ method: "writeFile", path: "/src/app.ts", content: "export const value = 2;\n" })), ["discover", "write_begin", "write_chunk", "write_commit"]);
  assert.deepEqual(await modes(host, async () => await call({ method: "resourceSnapshot" })), ["snapshot"]);
  assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(host.opens(), 1, "every operation rode the one session");

  // The frames themselves: every request carries the session's own root, a read carries the resource locations the host
  // reported, and a mutation carries none of them.
  const realRoot = realpathSync(root);
  assert.ok(host.frames.every((frame) => frame.root === realRoot), "every request frame claims the session root");
  const read = host.frames.find((frame) => frame.mode === "read_text")!;
  assert.ok(read.allow.roots.includes(join(realRoot, ".agents", "skills")), "a read names the host's own resource root: " + JSON.stringify(read.allow.roots));
  const mutation = host.frames.find((frame) => frame.mode === "write_begin")!;
  assert.deepEqual(mutation.allow, { roots: [], files: [] }, "a mutation names no read location");
});

test("a transport that cannot hold a session open reports the named limit and keeps no second path", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "app.ts"), "x\n");
  let executed = 0;
  const runner: SshRunner = { execute: async () => { executed += 1; return { stdout: JSON.stringify({ ok: true, value: "x\n" }), stderr: "", exitCode: 0 }; } };
  const remote = new SshFilesystem({ id: "ssh", profiles: [{ id: "loopback", host: "loopback.example", remoteRoot: root }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "loopback", host: "loopback.example", remoteRoot: root }])), runner });
  t.after(async () => { await remote.close(); });
  const result = await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/app.ts" });
  assert.equal(failure(result).code, "not_supported");
  assert.match(failure(result).message, /session/);
  assert.equal(executed, 0, "the per-call path is gone, not a fallback");
});

test("a request that waited unwritten fails as not sent, and a dispatched one as unknown", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "a.txt"), "a\n");
  // Every discovery is answered, and the first operation that is not one is left unanswered: that request was written,
  // and the one behind it waits for a turn the dead session never gives.
  const host = fakeSsh({ root, fault: (frame) => frame.mode === "discover" ? undefined : "hang" });
  t.after(() => host.kill());
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const dispatched = host.next("read_text");
  const first = remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/a.txt" });
  const second = remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/b.txt" });
  await dispatched;
  host.kill();
  const answers = [failure(await first), failure(await second)];
  const dispatchedAnswer = answers.find((answer) => answer.code === "unknown");
  const waitedAnswer = answers.find((answer) => answer.code === "aborted");
  assert.ok(dispatchedAnswer !== undefined, "the request whose frame was written is an unknown outcome: " + JSON.stringify(answers));
  assert.match(dispatchedAnswer.message, /unknown/);
  assert.ok(waitedAnswer !== undefined, "the request the host never saw is not sent: " + JSON.stringify(answers));
  assert.match(waitedAnswer.message, /not sent/);
  assert.equal(host.opens(), 1, "both requests rode the one session");
  // Both requests resolved their own discovery before queueing, and only one read frame was ever written: the waiter's
  // operation was never handed to the host.
  assert.deepEqual(host.frames.map((frame) => frame.mode), ["discover", "discover", "read_text"]);
  assert.deepEqual(host.frames.filter((frame) => frame.mode === "read_text").map((frame) => frame.args[0]), [join(realpathSync(root), "a.txt")]);
});

test("a dispatched request whose response is lost is unknown and is never sent again", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const host = fakeSsh({ root, fault: (frame) => frame.mode === "discover" ? undefined : "exit" });
  t.after(() => host.kill());
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const written = remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/a.txt", content: "x" });
  assert.equal(failure(await written).code, "unknown");
  // The discovery and the one write request: the lost write is never written a second time.
  assert.deepEqual(host.frames.map((frame) => frame.mode), ["discover", "write_begin"]);
  assert.equal(host.opens(), 1, "a dead session is not replaced under a write");
});

test("a frame above the response bound fails the request and drops the session", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "b.txt"), "b\n");
  const host = fakeSsh({ root, fault: (frame, session) => frame.mode === "read_text" && session === 0 ? "oversize" : undefined });
  t.after(() => host.kill());
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const oversized = remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/a.txt" });
  assert.equal(failure(await oversized).code, "unknown");
  assert.match(failure(await oversized).message, /above the/);
  // The dropped session is not reused: the next request opens its own rather than reading a stream that is out of step.
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/b.txt" })), "b\n");
  assert.equal(host.opens(), 2);
});

test("a request past its deadline is unknown when it was written, and not sent when it only waited", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-deadline-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "a.txt"), "a\n");
  await writeFile(join(root, "c.txt"), "c\n");
  // The host answers discovery and then never answers an operation: the session's own deadline is the only thing that
  // can settle the request, and the request behind it must settle too instead of waiting for a turn that never comes.
  const host = fakeSsh({ root, fault: (frame, session) => frame.mode === "read_text" && session === 0 ? "hang" : undefined });
  t.after(() => host.kill());
  const remote = files(host, root, { requestTimeoutMs: 250 });
  t.after(async () => { await remote.close(); });
  const dispatched = host.next("read_text");
  const first = remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/a.txt" });
  const second = remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/b.txt" });
  await dispatched;
  const answers = [failure(await first), failure(await second)];
  const sent = answers.find((answer) => answer.code === "unknown");
  const waited = answers.find((answer) => answer.code === "aborted");
  assert.ok(sent !== undefined, "the request whose frame was written times out as unknown: " + JSON.stringify(answers));
  assert.match(sent.message, /unknown/);
  assert.ok(waited !== undefined, "the request that only waited is not sent: " + JSON.stringify(answers));
  assert.match(waited.message, /not sent/);
  // The timed-out operation is never sent again, and the next request opens its own session rather than reusing one
  // whose stream is out of step.
  assert.equal(host.frames.filter((frame) => frame.mode === "read_text").length, 1);
  assert.equal(value(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/c.txt" })), "c\n");
  assert.equal(host.opens(), 2);
});

test("a session end after the staging file exists removes it and leaves the target unchanged", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-close-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "target.txt"), "original");
  // The host answers the begin and then holds the first chunk unanswered: the write is mid-flight, with its staging file
  // already created, at the moment the test ends the session.
  const host = fakeSsh({ root, fault: (frame) => frame.mode === "write_chunk" ? "hang" : undefined });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const written = remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/target.txt", content: "y".repeat(4 * 1024 * 1024) });
  // The barrier is the host's own answer: `write_begin` is committed before the gateway sends a chunk, so the first
  // `write_chunk` frame proves the staging file exists — a submitted frame alone would not.
  await host.next("write_chunk");
  const staged = (await readdir(root)).filter((name) => name.startsWith(".hepi-write-"));
  assert.equal(staged.length, 1, "the helper created its staging file: " + staged.join(", "));
  await remote.close();
  assert.equal(failure(await written).code, "unknown", "a write cut off by the session end is unknown, never a success");
  assert.equal(await readFile(join(root, "target.txt"), "utf8"), "original", "the target is untouched");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".hepi-write-")), [], "the helper removed the staging file it created");
  assert.equal(host.opens(), 1);
});

test("a multi-part write stays on one session, so an idle close cannot move a half-written file", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  // An idle session is closed the moment its last request settles: without a pin, each chunk of the write would need
  // its own session. One session for the whole write is what the pin guarantees.
  const host = fakeSsh({ root });
  const remote = files(host, root, { sessionIdleMs: 0 });
  t.after(async () => { await remote.close(); });
  const content = "x".repeat(700_000);
  assert.deepEqual(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/big.txt", content }), { ok: true, value: undefined });
  assert.equal(await readFile(join(root, "big.txt"), "utf8"), content);
  assert.equal(host.opens(), 1, "the whole write rode the one session");
  assert.ok(host.frames.filter((frame) => frame.mode === "write_chunk").length > 1, "the write really was multi-part");
});

test("a session that dies mid-write leaves its staging file, and a later session never sweeps it", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const host = fakeSsh({ root, fault: (frame) => frame.mode === "write_chunk" ? "exit" : undefined });
  t.after(() => host.kill());
  const remote = files(host, root);
  const written = remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/target.txt", content: "payload" });
  assert.equal(failure(await written).code, "unknown");
  assert.equal(host.opens(), 1, "a dead session is never replaced in the middle of a write");
  const residue = (await readdir(root)).filter((name) => name.startsWith(".hepi-write-"));
  assert.equal(residue.length, 1, "the staging file the session created is left behind: " + residue.join(", "));
  await remote.close();
  // A later session on the same root must not delete a file it did not create.
  const later = files(fakeSsh({ root }), root);
  await later.execute({ workspaceId: "remote-loopback", method: "listDir", path: "/" });
  await later.close();
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".hepi-write-")), residue, "nothing is deleted by pattern");
});

test("a session end removes the staging file it created and leaves the target unchanged", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "target.txt"), "original");
  const host = fakeSsh({ root });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const written = remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: "/target.txt", content: "y".repeat(2 * 1024 * 1024) });
  await remote.close();
  const result = await written as { ok: boolean };
  assert.equal(result.ok, false);
  assert.equal(await readFile(join(root, "target.txt"), "utf8"), "original", "a failed write changes nothing");
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".hepi-write-")), [], "the helper removed the staging file it created");
  assert.equal(host.opens(), 1);
});

test("read diagnostics keep the code, message and path a size pre-check used to produce", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "dir"));
  const host = fakeSsh({ root });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const directory = failure(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/dir" }));
  assert.deepEqual({ code: directory.code, message: directory.message, path: directory.path }, { code: "is_directory", message: "Not a regular file", path: join(realpathSync(root), "dir") });
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "readBinaryFile", path: "/dir" })).message, "Not a regular file");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path: "/missing.txt" })).code, "not_found");
  // The pre-check is gone: a refused read is one helper run, not two.
  assert.equal(host.frames.filter((frame) => frame.mode === "info").length, 0, "no separate size pre-check remains");
});

test("confinement and write refusal still run per operation on the one session", { timeout: 20_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-session-"));
  const root = join(base, "workspace");
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await mkdir(join(base, "outside"));
  await writeFile(join(base, "outside", "secret.txt"), "secret");
  await writeFile(join(root, "inside.txt"), "inside");
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const host = fakeSsh({ root });
  const remote = files(host, root);
  t.after(async () => { await remote.close(); });
  const read = (path: string) => remote.execute({ workspaceId: "remote-loopback", method: "readTextFile", path });
  await symlink(join(root, "inside.txt"), join(root, "link.txt"));
  assert.equal(value(await read("link.txt")), "inside");
  // The same link, re-pointed between two operations: the second read is refused at the operation, not cached away.
  await rm(join(root, "link.txt"));
  await symlink(join(base, "outside", "secret.txt"), join(root, "link.txt"));
  assert.equal(failure(await read("link.txt")).code, "permission_denied");
  assert.equal(failure(await read("escape/secret.txt")).code, "not_found");
  // A project resource inside the workspace stays read-only through the alias form too.
  await writeFile(join(root, ".agents", "skills", "x.md"), "---\nname: x\ndescription: X\n---\nX\n");
  assert.equal(value(await read(".agents/skills/x.md")), "---\nname: x\ndescription: X\n---\nX\n");
  assert.equal(failure(await remote.execute({ workspaceId: "remote-loopback", method: "writeFile", path: ".agents/skills/x.md", content: "changed" })).code, "permission_denied");
  assert.equal(await readFile(join(root, ".agents", "skills", "x.md"), "utf8"), "---\nname: x\ndescription: X\n---\nX\n");
  assert.equal(host.opens(), 1, "all of it on one session");
});
