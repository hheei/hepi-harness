import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { GitCommandExecutor } from "../src/workbench/app-store-diff.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";

const TIMEOUT_MS = 15_000;

/** One Git answer a fake checkout gives, and the arguments it was asked for. */
type GitAnswer = { readonly stdout?: string; readonly error?: Error };

/**
 * A checkout as Git would report it, with no process behind it. Every answer is a scripted
 * stdout for one argument list, and the record of what was asked keeps the workbench's own
 * Git calls visible to the assertions.
 */
function fakeGit(answers: (args: readonly string[]) => GitAnswer) {
  const calls: string[][] = [];
  const executeGit: GitCommandExecutor = async (args) => {
    calls.push([...args]);
    const answer = answers(args);
    return { error: answer.error ?? null, stdout: answer.stdout ?? "" };
  };
  return { calls, executeGit };
}

/** The Git subcommand of one call, past the global options the workbench puts first. */
function subcommand(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

/** A workspace checkout holding one tracked file, `src/app.ts`, edited after its baseline commit. */
function checkout(): (args: readonly string[]) => GitAnswer {
  return (args) => {
    switch (subcommand(args)) {
      // The folder is its own checkout, not one its enclosing repository ignores.
      case "check-ignore": return { error: Object.assign(new Error("not ignored"), { code: "ENOENT" }) };
      case "ls-files": return { stdout: args.includes("--stage") ? "100644 0f1e2d3 0\tsrc/app.ts\0" : "" };
      case "status": return { stdout: " M src/app.ts\0" };
      case "diff":
        // The unstaged diff is the one that answers for this file; the staged and untracked
        // forms stay empty, so the fallback order is asserted too.
        if (args.includes("--cached") || args.includes("--no-index")) return { stdout: "" };
        return { stdout: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n" };
      default: throw new Error("unscripted git call: " + args.join(" "));
    }
  };
}

test("browses workspace files and reports changed files and diff", { timeout: TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
    const git = fakeGit(checkout());
    const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: git.executeGit });
    const files = await workbench.execute({ workspaceId: "ws1", operation: "files" });
    const changes = await workbench.execute({ workspaceId: "ws1", operation: "changes" });
    const diff = await workbench.execute({ workspaceId: "ws1", operation: "diff", path: "src/app.ts" });
    assert.deepEqual(files, { ok: true, value: ["src/app.ts"] });
    assert.deepEqual(changes, { ok: true, value: { state: "available", files: [{ path: "src/app.ts", status: "modified", staged: false }] } });
    assert.equal(diff.ok && diff.value.toString().includes("+export const value = 2;"), true);
    // The workbench asked the checkout for its listing, its status and this file's diff — no more.
    assert.deepEqual(git.calls, [
      ["check-ignore", "-q", "."],
      ["ls-files", "-z", "--stage"],
      ["ls-files", "-z", "--deleted"],
      ["ls-files", "-z", "--others", "--exclude-standard"],
      ["status", "--porcelain=v1", "-z"],
      ["--literal-pathspecs", "diff", "--", "src/app.ts"],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a workspace Git refuses to describe is reported unavailable, never thrown", { timeout: TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  try {
    await writeFile(join(root, "note.txt"), "hi\n");
    const git = fakeGit((args) => {
      if (args[0] === "status") return { error: new Error("fatal: not a git repository") };
      if (args[0] === "ls-files") return { error: Object.assign(new Error("not a repository"), { code: "ENOENT" }) };
      if (args[0] === "check-ignore") return { error: Object.assign(new Error("not a repository"), { code: "ENOENT" }) };
      throw new Error("unscripted git call: " + args.join(" "));
    });
    const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: git.executeGit });
    // The listing falls back to the folder itself, and the change list says Git could not describe it.
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "files" }), { ok: true, value: ["note.txt"] });
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "changes" }), {
      ok: true,
      value: { state: "unavailable", error: { code: "git-status-failed", message: "Git status is unavailable for this workspace." } },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The two answers a host that could not produce one is allowed to give, asserted to be the same on either host: a
 * command that never answered is the operation's failure, and a checkout Git cannot describe stays unavailable.
 *
 * The local executor is scripted with the shapes this machine's own execFile produces — a killed process for a
 * deadline, an ABORT_ERR for a caller's cancellation — because those are the failures the SSH adapter maps onto the
 * same decision. The listing is not part of this: when Git cannot answer for the checkout, both hosts list the folder
 * from disk, which is the walk's own job and the same answer either way.
 */
test("a command that never answered is an operation failure, not an empty listing, change set or diff", { timeout: TIMEOUT_MS }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  await writeFile(join(root, "note.txt"), "hi\n");
  try {
    for (const never of [
      Object.assign(new Error("Command failed: git"), { killed: true, code: null as string | null }),
      Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" as string | null }),
      Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" as string | null }),
    ]) {
      const git = fakeGit(() => ({ error: never }));
      const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: git.executeGit });
      for (const request of [{ operation: "changes" as const }, { operation: "diff" as const, path: "note.txt" }]) {
        assert.deepEqual(await workbench.execute({ workspaceId: "ws1", ...request }), { ok: false, code: "operation_failed" }, request.operation);
      }
    }

    // Output past the bound is a different fact: Git ran and said more than the surface can hold, which keeps the
    // existing unavailable answer. The SSH adapter reports the same error code for the same overflow, so the two
    // hosts cannot disagree about it.
    const oversized = fakeGit(() => ({ error: Object.assign(new Error("maxBuffer exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) }));
    const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: oversized.executeGit });
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "changes" }), {
      ok: true,
      value: { state: "unavailable", error: { code: "git-status-failed", message: "Git status is unavailable for this workspace." } },
    });
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "diff", path: "note.txt" }), { ok: true, value: "" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * A workspace whose directories cannot be read at all is a failure, not an empty listing: the walk used to report a
 * listing error at the root as a workspace with no files, which is the answer a remote transport failure produced
 * here. A root that is simply not there keeps the empty listing it has always had.
 */
test("a workspace whose directories cannot be read is a failure, not an empty listing", { timeout: TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  const root = join(directory, "workspace");
  await mkdir(join(root, "src"), { recursive: true });
  try {
    const git = fakeGit(() => ({ error: Object.assign(new Error("not a repository"), { code: "ENOENT" }) }));
    const unreadable = (code: string) => new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), {
      executeGit: git.executeGit,
      host: () => ({
        executeGit: git.executeGit,
        readFile: async () => { throw new Error("not asked"); },
        resolveExisting: async () => {},
        tree: {
          list: async () => { throw Object.assign(new Error("cannot read"), { code }); },
          readTextFile: async () => { throw Object.assign(new Error("cannot read"), { code }); },
        },
      }),
    });
    assert.deepEqual(await unreadable("EACCES").execute({ workspaceId: "ws1", operation: "files" }), { ok: false, code: "operation_failed" });
    assert.deepEqual(await unreadable("unknown").execute({ workspaceId: "ws1", operation: "files" }), { ok: false, code: "operation_failed" });
    assert.deepEqual(await unreadable("not_found").execute({ workspaceId: "ws1", operation: "files" }), { ok: true, value: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The ordinary lifetime of a listed file: a tree is read, the file is deleted or moved while a page still holds its
// name, and the read that follows is the host saying it does not have that path. That is 'not_found', not a broken
// operation and not a refusal - the two answers a person's next move differs for.
test("a file deleted after it was listed is read as missing, not as a failed operation", { timeout: TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  const root = join(directory, "workspace");
  await mkdir(root);
  try {
    await writeFile(join(root, "note.txt"), "hi\n");
    const git = fakeGit(() => ({ stdout: "" }));
    const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: git.executeGit });
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "read", path: "note.txt" }), {
      ok: true,
      value: { path: "note.txt", content: "hi\n", truncated: false, binary: false, sizeBytes: 3, shownBytes: 3 },
    }, "a file that is there did not read");

    await rm(join(root, "note.txt"));
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "read", path: "note.txt" }), { ok: false, code: "not_found" });
    // A read of a path whose folder is gone is the same fact, whatever part of it is missing.
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "read", path: "gone/notes.md" }), { ok: false, code: "not_found" });
    // A diff still asks the deleted file's directory, so a deletion stays Git's own answer rather than a missing path
    // the workbench invented for a checkout it can describe.
    const deleted = fakeGit((args) => subcommand(args) === "diff" ? { stdout: "" } : { error: Object.assign(new Error("not ignored"), { code: "ENOENT" }) });
    const diffing = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]), { executeGit: deleted.executeGit });
    assert.equal((await diffing.execute({ workspaceId: "ws1", operation: "diff", path: "note.txt" })).ok, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("denies file reads outside the configured workspace", { timeout: TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-workbench-"));
  const root = join(directory, "workspace");
  const outside = join(directory, "outside.txt");
  await mkdir(root);
  try {
    await writeFile(outside, "secret");
    const workbench = new GatewayWorkbench(new WorkspaceRegistry([{ id: "ws1", root }]));
    assert.deepEqual(await workbench.execute({ workspaceId: "ws1", operation: "read", path: "../outside.txt" }), { ok: false, code: "path_denied" });
    assert.equal(await readFile(outside, "utf8"), "secret");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
