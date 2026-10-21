import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { GatewayRpcServer, SshGateway, type SshRunner, type SshRunnerRequest, type SshRunnerResult } from "../src/index.ts";
import { CONTROL_TIMEOUT_MS } from "../src/control.ts";
import type { WorkbenchChanges, WorkbenchFile, WorkbenchOperation } from "@hepi/protocol/gateway";
import { GatewayWorkbench } from "../src/workbench/index.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { sshWorkbench } from "../src/workbench/ssh-files.ts";
import { sshWorkspaceSeed, WorkspaceRegistry } from "../src/workspaces.ts";
import { gatewayHttp } from "./gateway-http.ts";
import { fakeSsh, type FakeSsh } from "./ssh-fake.ts";

/**
 * The read-only workbench of an SSH gateway, at the seam a caller uses: `POST /v1/workbench`, over the same
 * `SshFilesystem` session and the same `SshRunner` the deployment composes.
 *
 * The host is the in-process one of ./ssh-fake.ts — a real temporary tree, the helper's own operations and confinement
 * — plus git run on that tree, because the two capabilities the workbench needs are exactly those: a bounded file read
 * and a git read. What is asserted here is therefore the workbench's own contract, not a second implementation of it:
 * the listing, the preview bound, the changed-file and diff shapes the local host already answers with, and the named
 * refusals a remote host gives instead of a local tree.
 */

const git = promisify(execFile);
const TIMEOUT_MS = 30_000;
const PROFILE = { id: "prod", host: "builder@fake-host", remoteRoot: "/srv/app", port: 2222, identityFile: "/keys/id", knownHostsFile: "/keys/known" };
const WORKSPACE_ID = "remote-prod";
const TOKEN = "workbench-token";

/**
 * One SSH transport serving both capabilities: the helper session the filesystem opens, and `git` run in the directory
 * the gateway named — the same argv, in the same confined root, that `sshGitExecutor` hands the real runner. A request
 * for anything else is the shell's own 127, and a working directory outside the profile's root is the runner's own
 * refusal, so a path that left the workspace cannot become a git call here either.
 */
function hostRunner(host: FakeSsh, root: string, requests: SshRunnerRequest[]): SshRunner {
  return {
    open: (request) => host.runner.open!(request),
    execute: async (request: SshRunnerRequest): Promise<SshRunnerResult> => {
      requests.push(request);
      const confined = request.cwd === root || request.cwd.startsWith(root + "/");
      if (!confined) return { stdout: "", stderr: "", exitCode: 126 };
      if (request.command[0] !== "git") return { stdout: "", stderr: request.command[0] + ": command not found", exitCode: 127 };
      try {
        const { stdout, stderr } = await git("git", ["-C", request.cwd, ...request.command.slice(1)], { env: { ...process.env, ...request.env } });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
      }
    },
  };
}

type Fixture = {
  root: string;
  host: FakeSsh;
  files: SshFilesystem;
  workbench: ReturnType<typeof sshWorkbench>;
  /** The one transport both the filesystem session and the Git reads ride. */
  runner: SshRunner;
  requests: SshRunnerRequest[];
  close(): Promise<void>;
};

/** One remote host holding a checkout with one tracked file edited after its baseline commit. */
async function fixture(options: { repository?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
  await writeFile(join(root, "notes.md"), "# notes\n");
  if (options.repository !== false) {
    await git("git", ["init", "-q", root]);
    await git("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await git("git", ["-C", root, "config", "user.name", "Test"]);
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    await git("git", ["-C", root, "add", "-A"]);
    await git("git", ["-C", root, "commit", "-qm", "baseline"]);
    await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
  }
  const host = fakeSsh({ root });
  const requests: SshRunnerRequest[] = [];
  const runner = hostRunner(host, root, requests);
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner, workspaces });
  const workbench = sshWorkbench({ workspaces, profiles: [profile], files, runner });
  return {
    root,
    host,
    files,
    workbench,
    runner,
    requests,
    async close() {
      await files.close();
      host.kill();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function value(result: unknown): unknown {
  const answer = result as { ok: boolean; value?: unknown };
  assert.equal(answer.ok, true, "the workbench answered a refusal: " + JSON.stringify(result));
  return answer.value;
}

test("an SSH workspace lists files, reads a preview, reports changes and diffs them", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  // The listing is git's own view of the checkout, asked on the remote host: the tracked file and the untracked one,
  // with no local directory ever read for it.
  const files = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "files" })) as string[];
  assert.deepEqual(files, ["notes.md", "src/app.ts"]);

  // A path is workspace-relative, exactly as the local workbench reads one: an absolute path is not remapped into the
  // root, so the two hosts agree about what a request's path means.
  const preview = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "src/app.ts" })) as {
    path: string; content: string; truncated: boolean; binary: boolean; sizeBytes: number; shownBytes: number;
  };
  assert.deepEqual(preview, { path: "src/app.ts", content: "export const value = 2;\n", truncated: false, binary: false, sizeBytes: 24, shownBytes: 24 });

  // The changed-file answer is the local DTO, from git's own porcelain on the remote host.
  assert.deepEqual(value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "changes" })), {
    state: "available",
    files: [{ path: "src/app.ts", status: "modified", staged: false }],
  });

  const diff = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "diff", path: "src/app.ts" })) as string;
  assert.match(diff, /^diff --git a\/src\/app\.ts b\/src\/app\.ts/m);
  assert.match(diff, /^-export const value = 1;$/m);
  assert.match(diff, /^\+export const value = 2;$/m);

  // Every git command ran in the workspace root the gateway resolved, over the profile's own connection settings: no
  // path from the request became a working directory, and the credential is the profile's, never the caller's.
  const gitRequests = app.requests.filter((request) => request.command[0] === "git");
  assert.ok(gitRequests.length > 0, "git did not run on the host");
  for (const request of gitRequests) {
    assert.equal(request.cwd, app.root, "git ran outside the workspace root");
    assert.equal(request.profile, PROFILE.id);
    assert.equal(request.host, PROFILE.host);
    assert.equal(request.port, PROFILE.port);
    assert.equal(request.identityFile, PROFILE.identityFile);
  }
});

test("the remote preview is bounded by the workbench's own limit and releases the host reader", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture({ repository: false });
  t.after(() => app.close());
  // One file past the preview bound: the answer says it is longer, and exactly the bound's bytes came back.
  const content = "x".repeat(300 * 1024);
  await writeFile(join(app.root, "big.txt"), content);

  const preview = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "big.txt" })) as {
    content: string; truncated: boolean; sizeBytes: number; shownBytes: number;
  };
  assert.equal(preview.truncated, true);
  assert.equal(preview.sizeBytes, content.length);
  // The two numbers a truncated preview is asked to state: what this answer holds, and the file's whole size as the
  // host stated it. A viewer draws them as they are, so neither is derived from the decoded text.
  assert.equal(preview.shownBytes, 200 * 1024);
  assert.equal(preview.content.length, 200 * 1024);
  // The read asked the host for one byte past the bound and no more, so the bound is the transport's too.
  const reads = app.host.frames.filter((frame) => frame.mode === "reader_read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.args[4], String(200 * 1024 + 1));
  assert.equal(app.files.readers.handles.size, 0, "the remote reader handle was left open");
});

// The gateway read bound is a policy both filesystems enforce, and the workbench preview reads through the same
// reader: a file past it is refused, not streamed. The two hosts are asserted side by side because they differ here
// — the local preview uses its own file handle and never asks the filesystem, so it still truncates at the preview
// bound. Recorded as a limit in docs/workbench.md rather than fixed by raising the read bound for a preview.
test("a file past the gateway read bound is previewed locally and refused on the remote host", { timeout: TIMEOUT_MS }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  // Sparse, so the fixture does not write 17 MiB: the bound is a size check, not a content read.
  const handle = await open(join(root, "huge.txt"), "w");
  await handle.truncate(16 * 1024 * 1024 + 1);
  await handle.close();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const host = fakeSsh({ root });
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner: host.runner, workspaces });
  t.after(async () => { await files.close(); host.kill(); });
  const ssh = sshWorkbench({ workspaces, profiles: [profile], files, runner: host.runner });

  const local = await new GatewayWorkbench(new WorkspaceRegistry([{ id: "local", root }])).execute({ workspaceId: "local", operation: "read", path: "huge.txt" });
  assert.equal(local.ok, true, "the local preview of a large file stopped working: " + JSON.stringify(local));
  assert.deepEqual(await ssh.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "huge.txt" }), { ok: false, code: "operation_failed" });
});

test("a path that leaves the remote workspace is refused as path_denied, before any host read", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  // A file outside the root that a traversal or a symlink would reach: neither may be served.
  const outside = join(app.root, "..", "outside.txt");
  await writeFile(outside, "not yours\n");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(app.root, "escape.txt"));

  // A traversal and an absolute path are refused here, before the host is asked anything at all.
  for (const path of ["../outside.txt", "/etc/passwd"]) {
    const before = app.host.frames.length;
    assert.deepEqual(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path }), { ok: false, code: "path_denied" }, path);
    assert.deepEqual(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "diff", path }), { ok: false, code: "path_denied" }, path);
    assert.equal(app.host.frames.length, before, "the host was asked for a path that had already left the workspace: " + path);
  }
  // A symlink inside the root is the case no lexical check can decide, so the host's own confinement decides it: the
  // helper refuses the real location and the workbench reports that as the same path refusal.
  assert.deepEqual(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "escape.txt" }), { ok: false, code: "path_denied" });
  assert.deepEqual(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "diff", path: "escape.txt" }), { ok: false, code: "path_denied" });

  // The same root's own files stay readable, so the refusal is the boundary and not a broken host.
  const inside = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "notes.md" })) as { content: string };
  assert.equal(inside.content, "# notes\n");
});

test("a workspace that is no checkout reports unavailable changes, not a transport failure", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture({ repository: false });
  t.after(() => app.close());
  const changes = value(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "changes" })) as { state: string };
  assert.equal(changes.state, "unavailable");
});

test("a transport that cannot answer is an operation failure, never an empty listing or an empty diff", { timeout: TIMEOUT_MS }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  await writeFile(join(root, "notes.md"), "# notes\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = fakeSsh({ root });
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  // A transport whose session works and whose one-shot calls are gone: the filesystem answers, git cannot.
  const runner: SshRunner = {
    open: (request) => host.runner.open!(request),
    execute: async () => { throw Object.assign(new Error("ssh outcome unknown"), { code: "outcome_unknown" }); },
  };
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner, workspaces });
  t.after(async () => { await files.close(); host.kill(); });
  const workbench = sshWorkbench({ workspaces, profiles: [profile], files, runner });

  // The listing falls back to the directory walk the filesystem serves, so it still answers the host's real files.
  assert.deepEqual(value(await workbench.execute({ workspaceId: WORKSPACE_ID, operation: "files" })), ["notes.md"]);
  // The Git reads have no host answer at all: that is the operation's failure, not an empty change set.
  assert.deepEqual(await workbench.execute({ workspaceId: WORKSPACE_ID, operation: "changes" }), { ok: false, code: "operation_failed" });
  assert.deepEqual(await workbench.execute({ workspaceId: WORKSPACE_ID, operation: "diff", path: "notes.md" }), { ok: false, code: "operation_failed" });
});

test("an unknown workspace is refused by name, and a missing path is not a denial", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  assert.deepEqual(await app.workbench.execute({ workspaceId: "local", operation: "files" }), { ok: false, code: "unknown_workspace" });
  // A file the host does not have is the host's own not_found, which the workbench reports under its own name rather
  // than as a failed operation or a path it refused.
  assert.deepEqual(await app.workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "missing.txt" }), { ok: false, code: "not_found" });
});

// ---------------------------------------------------------------------------
// local / SSH parity (ticket 02): the same tree, asked of both hosts
// ---------------------------------------------------------------------------

/**
 * One workspace tree, served twice: by the local workbench (this process reads the directory) and by `sshWorkbench`
 * over the in-process host. A checkout with a staged rename, an unstaged modification, a deletion, an untracked file,
 * a binary file, a file past the preview bound, a symbolic link that stays inside the workspace and one that does not.
 * The point of the fixture is that both hosts are asked about the *same* paths, so any difference in the answer is a
 * contract difference and not a different workspace.
 */
async function parity(): Promise<{ local: GatewayWorkbench; ssh: GatewayWorkbench; close(): Promise<void> }> {
  const app = await fixture();
  const root = app.root;
  const run = (...args: string[]) => git("git", ["-C", root, ...args]);
  await run("mv", "notes.md", "renamed.md");
  await writeFile(join(root, "gone.txt"), "to be deleted\n");
  await run("add", "gone.txt");
  await run("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "second");
  await rm(join(root, "gone.txt"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 3;\n");
  await writeFile(join(root, "new.txt"), "untracked\n");
  await writeFile(join(root, "blob.bin"), Buffer.from([0x89, 0, 1, 2, 0xff]));
  await writeFile(join(root, "big.txt"), "x".repeat(300 * 1024));
  await symlink(join(root, "renamed.md"), join(root, "link.md"));
  await writeFile(join(root, "..", "outside.txt"), "not yours\n");
  await symlink(join(root, "..", "outside.txt"), join(root, "escape.txt"));

  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner: app.runner, workspaces });
  const ssh = sshWorkbench({ workspaces, profiles: [profile], files, runner: app.runner });
  const local = new GatewayWorkbench(new WorkspaceRegistry([{ id: "local", root }]));
  const inner = app.close;
  return { local, ssh, close: async () => { await files.close(); await inner(); } };
}

/** Both hosts' answers to one request, so the comparison is always between the two of them. */
async function both(hosts: { local: GatewayWorkbench; ssh: GatewayWorkbench }, operation: WorkbenchOperation, path?: string) {
  const body = { ...(path === undefined ? {} : { path }) };
  return await Promise.all([
    hosts.local.execute({ workspaceId: "local", operation, ...body }),
    hosts.ssh.execute({ workspaceId: WORKSPACE_ID, operation, ...body }),
  ]);
}

test("the two hosts answer the same operations about the same workspace the same way", { timeout: TIMEOUT_MS }, async (t) => {
  const hosts = await parity();
  t.after(() => hosts.close());

  for (const [operation, path] of [["files", undefined], ["changes", undefined]] as const) {
    const [local, ssh] = await both(hosts, operation, path);
    assert.deepEqual(ssh, local, operation + " differs between hosts");
    assert.equal(local.ok, true, operation + " refused: " + JSON.stringify(local));
  }
  const listing = await both(hosts, "files");
  assert.deepEqual(listing[0], { ok: true, value: ["big.txt", "blob.bin", "escape.txt", "link.md", "new.txt", "renamed.md", "src/app.ts"] });
  const changes = (await both(hosts, "changes"))[0] as { ok: true; value: WorkbenchChanges };
  assert.equal(changes.value.state, "available");

  for (const path of ["src/app.ts", "renamed.md", "gone.txt", "new.txt", "not-there.txt", "big.txt"]) {
    const [local, ssh] = await both(hosts, "diff", path);
    assert.deepEqual(ssh, local, "the diff of " + path + " differs between hosts");
  }

  for (const path of ["renamed.md", "link.md", "blob.bin", "big.txt", "new.txt", "src/app.ts", "gone.txt", "not-there.txt"]) {
    const [local, ssh] = await both(hosts, "read", path);
    assert.deepEqual(ssh, local, "the read of " + path + " differs between hosts");
  }
  const preview = await both(hosts, "read", "link.md");
  assert.equal((preview[0] as { ok: true; value: WorkbenchFile }).value.content, "# notes\n", "an in-workspace link is not previewed");

  for (const path of ["../outside.txt", "/etc/passwd", "escape.txt"]) {
    for (const operation of ["read", "diff"] as const) {
      const [local, ssh] = await both(hosts, operation, path);
      assert.deepEqual(ssh, local, operation + " of " + path + " differs between hosts");
      assert.deepEqual(local, { ok: false, code: "path_denied" }, path);
    }
  }
  assert.deepEqual(await hosts.local.execute({ workspaceId: "nope", operation: "files" }), { ok: false, code: "unknown_workspace" });
  assert.deepEqual(await hosts.ssh.execute({ workspaceId: "nope", operation: "files" }), { ok: false, code: "unknown_workspace" });
});

// ---------------------------------------------------------------------------
// deadlines, caller abort and transport loss (ticket 02)
// ---------------------------------------------------------------------------

/**
 * A one-shot transport that has the host but never answers: it reports the way `createSystemSshRunner` does when its
 * process is ended — the command's fate is unknown — but only once its own signal fires. That is what makes a deadline
 * and a caller's cancellation observable at this seam without waiting on a clock or a real connection: the runner's
 * request is the record, and an abort that never reached it would leave the promise pending instead of failing.
 */
function hangingRunner(): { runner: SshRunner; readonly requests: SshRunnerRequest[]; started(): Promise<SshRunnerRequest> } {
  const requests: SshRunnerRequest[] = [];
  const waiting: ((request: SshRunnerRequest) => void)[] = [];
  return {
    requests,
    started: () => requests.length > 0
      ? Promise.resolve(requests[0]!)
      : new Promise<SshRunnerRequest>((resolve) => { waiting.push(resolve); }),
    runner: {
      execute: (request) => {
        requests.push(request);
        waiting.shift()?.(request);
        return new Promise<SshRunnerResult>((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("ssh aborted; remote outcome unknown"), { code: "outcome_unknown" as const }));
          if (request.signal.aborted) fail();
          else request.signal.addEventListener("abort", fail, { once: true });
        });
      },
    },
  };
}

test("a deadline or a caller's cancellation ends the host command and fails the operation", { timeout: TIMEOUT_MS }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  await writeFile(join(root, "notes.md"), "# notes\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const hanging = hangingRunner();
  // The session the listing and previews read through works; only the one-shot Git transport hangs.
  const host = fakeSsh({ root });
  const runner: SshRunner = { open: (request) => host.runner.open!(request), execute: hanging.runner.execute };
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner, workspaces, sessionIdleMs: 60_000 });
  t.after(async () => { await files.close(); host.kill(); });
  const workbench = sshWorkbench({ workspaces, profiles: [profile], files, runner });

  // A caller that gives up: the command it started is ended, and the operation reports its failure rather than an
  // empty change set a caller would read as "nothing has changed".
  const controller = new AbortController();
  const cancelled = workbench.execute({ workspaceId: WORKSPACE_ID, operation: "changes" }, { signal: controller.signal });
  const sent = await hanging.started();
  assert.equal(sent.signal.aborted, false, "the command was ended before the caller gave up");
  controller.abort();
  assert.deepEqual(await cancelled, { ok: false, code: "operation_failed" });
  assert.equal(hanging.requests[0]!.signal.aborted, true, "the caller's cancellation did not reach the host command");

  // The same for a diff, which is the operation whose empty answer looks most like a real one.
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await workbench.execute({ workspaceId: WORKSPACE_ID, operation: "diff", path: "notes.md" }, { signal: aborted.signal }), { ok: false, code: "operation_failed" });

  // Every host command carries its own bound, so a host that never answers cannot be waited on forever, and that
  // bound sits inside the deadline the caller applies: the host answers its own failure instead of the caller
  // losing the call to a timeout at the same instant.
  for (const request of hanging.requests) {
    assert.equal(typeof request.timeoutMs, "number", "a host Git read was sent with no deadline");
    assert.ok(request.timeoutMs! < CONTROL_TIMEOUT_MS.workbench, "the host deadline outlasts the caller's: " + request.timeoutMs);
    assert.equal(request.cwd, root, "the command did not name the workspace root it was confined to");
    assert.equal(request.identityFile, PROFILE.identityFile, "the command used the profile's own credentials");
  }
});

test("a host that cannot answer for the listing fails it, instead of answering an empty one", { timeout: TIMEOUT_MS }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  await writeFile(join(root, "notes.md"), "# notes\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  // Nothing serves the host at all: no session for the directory walk, and no command for Git. Both listing sources
  // fail, which is the case that used to be reported as a workspace with no files at all.
  const runner: SshRunner = {
    open: () => { throw Object.assign(new Error("ssh host unreachable"), { code: "unreachable" }); },
    execute: async () => { throw Object.assign(new Error("ssh outcome unknown"), { code: "outcome_unknown" }); },
  };
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner, workspaces });
  const workbench = sshWorkbench({ workspaces, profiles: [profile], files, runner });
  t.after(() => files.close());

  for (const operation of ["files", "changes", "diff"] as const) {
    assert.deepEqual(await workbench.execute({ workspaceId: WORKSPACE_ID, operation, ...(operation === "diff" ? { path: "notes.md" } : {}) }), { ok: false, code: "operation_failed" }, operation);
  }
  assert.deepEqual(await workbench.execute({ workspaceId: WORKSPACE_ID, operation: "read", path: "notes.md" }), { ok: false, code: "operation_failed" });
});

// The route's own half of the caller-deadline contract: the workbench reads on a host it does not own, so a caller
// that goes away has left no reason for that read to keep running. The MCP route already ends its work this way; the
// workbench is the surface that had no way to be told, and a remote git command outliving the browser that asked for
// it is the failure this asserts against.
test("a caller that disconnects from /v1/workbench ends the host command it started", { timeout: TIMEOUT_MS }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hepi-ssh-workbench-")));
  await writeFile(join(root, "notes.md"), "# notes\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = { ...PROFILE, remoteRoot: root };
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
  const host = fakeSsh({ root });
  const hanging = hangingRunner();
  const runner: SshRunner = { open: (request) => host.runner.open!(request), execute: hanging.runner.execute };
  const files = new SshFilesystem({ id: "gateway", profiles: [profile], runner, workspaces });
  const server = new GatewayRpcServer(
    new SshGateway({ id: "gateway", token: TOKEN, profiles: [profile], allowedCommands: [], runner, workspaces }),
    sshWorkbench({ workspaces, profiles: [profile], files, runner }),
    files,
  );
  const http = gatewayHttp(server.server);
  t.after(async () => { http.close(); await files.close(); host.kill(); });

  const body = JSON.stringify({ workspaceId: WORKSPACE_ID, operation: "changes" });
  const exchange = http.start({
    method: "POST",
    path: "/v1/workbench",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
  exchange.write(Buffer.from(body));
  exchange.end();
  const sent = await hanging.started();
  assert.equal(sent.signal.aborted, false, "the host command ended before the caller went away");
  const disconnected = Date.now();
  exchange.destroy();
  // The cancellation reaches the transport that runs the command, not merely the promise this process awaits, and it
  // reaches it because the caller went away — not when the command's own deadline happens to expire.
  await new Promise<void>((resolve) => { if (sent.signal.aborted) resolve(); else sent.signal.addEventListener("abort", () => resolve(), { once: true }); });
  assert.ok(Date.now() - disconnected < 5_000, "the host command was only ended by its deadline, not by the caller: " + (Date.now() - disconnected) + "ms");
});

test("the SSH gateway mounts the workbench on /v1/workbench with the local protocol", { timeout: TIMEOUT_MS }, async (t) => {
  const app = await fixture();
  const profiles = [{ ...PROFILE, remoteRoot: app.root }];
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const requests: SshRunnerRequest[] = [];
  const runner = hostRunner(app.host, app.root, requests);
  const files = new SshFilesystem({ id: "gateway", profiles, runner, workspaces });
  const server = new GatewayRpcServer(
    new SshGateway({ id: "gateway", token: TOKEN, profiles, allowedCommands: [], runner, workspaces }),
    sshWorkbench({ workspaces, profiles, files, runner }),
    files,
  );
  await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  assert.ok(address !== null && typeof address === "object");
  const origin = "http://127.0.0.1:" + address.port;
  const post = async (body: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(origin + "/v1/workbench", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const listing = await post({ workspaceId: WORKSPACE_ID, operation: "files" });
    assert.equal(listing.status, 200, JSON.stringify(listing.body));
    assert.deepEqual(listing.body, { ok: true, value: ["notes.md", "src/app.ts"] });

    // A refusal keeps the local route's status and code: the host's own path boundary is a 409, as it always was.
    const denied = await post({ workspaceId: WORKSPACE_ID, operation: "read", path: "../outside.txt" });
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, { ok: false, code: "path_denied" });

    const unknown = await post({ workspaceId: "local", operation: "files" });
    assert.equal(unknown.status, 409);
    assert.deepEqual(unknown.body, { ok: false, code: "unknown_workspace" });

    // The route is the gateway's own: the credential the browser holds is the gateway's, and no SSH material appears in
    // any answer.
    const unauthorized = await fetch(origin + "/v1/workbench", { method: "POST", body: JSON.stringify({ workspaceId: WORKSPACE_ID, operation: "files" }) });
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.server.close(() => resolve()));
    await files.close();
    await app.close();
  }
});
