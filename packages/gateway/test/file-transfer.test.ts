import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GatewayRpcServer, LocalGateway } from "../src/index.ts";
import { LocalFilesystem, MAX_FILE_BYTES, type FileRequest, type FilesystemServer } from "../src/filesystem.ts";
import { UPLOAD_CHUNK_BYTES, uploadFile } from "../src/file-transfer.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { gatewayHttp, type GatewayHttp, type GatewayResponse } from "./gateway-http.ts";
import { fakeSsh } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/**
 * The file payload routes, asserted at the gateway's own HTTP seam.
 *
 * The JSON file RPC caps a request at 1 MiB, which base64 turns into about 768 KiB of file, against a file policy of
 * 16 MiB. These routes are the byte path: the body is streamed in bounded chunks, so a file larger than one JSON
 * request still arrives whole, a file over the policy is refused without a partial file left behind, and the conflict
 * rules the copied upload route enforced on its own directory are enforced here on the host that holds the directory.
 *
 * Every request goes through the gateway's real request parsing, routing, status and headers; only the transport below
 * that contract is this process's memory, so the suite binds no port and cannot collide with anything else on the
 * machine. A workspace is still a real directory, because the rules under test are the host filesystem's own: a
 * replacement keeps the target's mode, a symbolic link is not a regular file, and a rename is atomic.
 *
 * The remote-workspace case runs the gateway's own SSH filesystem over the in-memory host of `ssh-fake.ts` — the far
 * side of the frame protocol, in this process, with the helper's confinement and rename rules. Nothing here needs a
 * local system dependency: no python3, no ssh, no daemon, no key. What only a real transport can show (argv shape, the
 * real helper program, a real sshd) stays in `ssh-filesystem.test.ts`, the `ssh-transport`-backed suites and
 * `resource-snapshot.test.ts`'s sshd case.
 */

const TOKEN = "file-transfer-token";

type Host = {
  readonly root: string;
  /** The workspace id the payload routes name in this fixture. */
  readonly workspace: string;
  readonly http: GatewayHttp;
  close(): Promise<void>;
};

/** A workspace root, removed by the fixture that made it. The host filesystem is the thing under test, so it is real. */
async function workspaceRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

/** The local fixture: one workspace directory, served by the gateway's local filesystem. */
async function localHost(): Promise<Host> {
  const root = await workspaceRoot("hepi-file-transfer-");
  const workspaces = new WorkspaceRegistry([{ id: "ws", root }]);
  return await hostFor(root, "ws", workspaces, new LocalFilesystem(workspaces));
}

/**
 * The remote fixture: the same routes over the gateway's SSH filesystem, whose session transport is the deterministic
 * host in `ssh-fake.ts` rather than a python3 child. The workspace root is still a real directory, so the remote
 * paths keep real confinement, modes and atomic renames; the transport is the only thing this process supplies.
 */
async function sshHost(): Promise<Host> {
  const root = await workspaceRoot("hepi-file-transfer-ssh-");
  const remote = fakeSsh({ root });
  const profiles = [{ id: "loopback", host: "loopback.example", remoteRoot: root }];
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const files = new SshFilesystem({ id: "gateway-1", profiles, workspaces, runner: remote.runner });
  return await hostFor(root, "remote-loopback", workspaces, files);
}

/** The gateway a fixture serves: its own routes over an in-process connection, and the filesystem that answers them. */
async function hostFor(root: string, workspace: string, workspaces: WorkspaceRegistry, files: FilesystemServer): Promise<Host> {
  const gateway = new LocalGateway({ id: "gateway-1", token: TOKEN, workspaces, allowedCommands: [] });
  const server = new GatewayRpcServer({ gateway, files });
  const http = gatewayHttp(server.server);
  return {
    root,
    workspace,
    http,
    close: async () => {
      http.close();
      // The gateway's own close ends its filesystem: the SSH helper session included, so no child outlives the test.
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The body a JSON route answered. */
const answer = (response: GatewayResponse): unknown => JSON.parse(response.body.toString("utf8"));
/** The failure code a JSON route answered. */
const code = (response: GatewayResponse): string => (answer(response) as { code: string }).code;

const upload = (host: Host, path: string, body: Uint8Array, query = "", token = TOKEN) =>
  host.http.call({
    method: "POST",
    path: "/v1/files/upload?workspaceId=" + host.workspace + "&path=" + encodeURIComponent(path) + query,
    headers: { authorization: "Bearer " + token, "content-type": "application/octet-stream", "content-length": String(body.byteLength) },
    body,
  });

const check = (host: Host, path: string, names: string[]) =>
  host.http.call({
    method: "POST",
    path: "/v1/files/upload-check?workspaceId=" + host.workspace,
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ path, names }),
  });

const bytes = (host: Host, path: string, headers: Record<string, string> = {}) =>
  host.http.call({
    method: "GET",
    path: "/v1/files/bytes?workspaceId=" + host.workspace + "&path=" + encodeURIComponent(path),
    headers: { authorization: "Bearer " + TOKEN, ...headers },
  });

/** The same upload, for a workspace id this gateway holds no record of. */
const other = (host: Host, path = "/x.txt") => host.http.call({
  method: "POST",
  path: "/v1/files/upload?workspaceId=nowhere&path=" + encodeURIComponent(path),
  headers: { authorization: "Bearer " + TOKEN, "content-type": "application/octet-stream", "content-length": "1" },
  body: Buffer.from("x"),
});

/** The temporary files an upload stages in the workspace root: an upload that did not finish must leave none. */
async function staged(root: string): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith(".hepi-upload-"));
}

/**
 * A filesystem that reports the host calls the gateway makes, so a test waits for the state it cares about — a staging
 * chunk written, a staging file removed — instead of polling the directory for it.
 */
function observed(inner: FilesystemServer): { files: FilesystemServer; when(predicate: (request: FileRequest) => boolean): Promise<FileRequest> } {
  const waiters: { predicate: (request: FileRequest) => boolean; resolve: (request: FileRequest) => void }[] = [];
  const files: FilesystemServer = {
    execute: async (request) => {
      const result = await inner.execute(request);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(request)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(request);
      }
      return result;
    },
    close: async () => { await inner.close(); },
  };
  return { files, when: (predicate) => new Promise((resolve) => { waiters.push({ predicate, resolve }); }) };
}

/** A staging file, as the host sees it: the same prefix the upload stages under. */
const staging = (request: FileRequest): boolean => (request.path ?? "").startsWith("/.hepi-upload-");

test("a file larger than one JSON request arrives whole through the byte route", async () => {
  const host = await localHost();
  try {
    // Larger than the 1 MiB JSON reader that the /v1/files RPC enforces, and not a round number of chunks.
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    const response = await upload(host, "/big.bin", content);
    assert.equal(response.status, 200);
    assert.deepEqual(answer(response), { ok: true, value: { path: "/big.bin", size: content.byteLength, skipped: false } });
    assert.deepEqual(await readFile(join(host.root, "big.bin")), content);
    assert.deepEqual(await staged(host.root), []);
  } finally { await host.close(); }
});

test("an existing name is refused before anything is written, and the file it names is untouched", async () => {
  const host = await localHost();
  try {
    await writeFile(join(host.root, "notes.txt"), "original");
    const response = await upload(host, "/notes.txt", Buffer.from("replacement"));
    assert.equal(response.status, 409);
    assert.deepEqual(answer(response), { ok: false, code: "conflict", message: "the file already exists", conflicts: ["/notes.txt"], nonReplaceable: [] });
    assert.equal(await readFile(join(host.root, "notes.txt"), "utf8"), "original");
    assert.deepEqual(await staged(host.root), []);
  } finally { await host.close(); }
});

test("a skip leaves the existing file alone and reports it", async () => {
  const host = await localHost();
  try {
    await writeFile(join(host.root, "notes.txt"), "original");
    const response = await upload(host, "/notes.txt", Buffer.from("replacement"), "&conflict=skip");
    assert.equal(response.status, 200);
    assert.deepEqual(answer(response), { ok: true, value: { path: "/notes.txt", size: 8, skipped: true } });
    assert.equal(await readFile(join(host.root, "notes.txt"), "utf8"), "original");
  } finally { await host.close(); }
});

test("an overwrite replaces a regular file, and refuses a directory and a link", async () => {
  const host = await localHost();
  try {
    await writeFile(join(host.root, "notes.txt"), "original");
    await mkdir(join(host.root, "folder"));
    await writeFile(join(host.root, "elsewhere.txt"), "elsewhere");
    await symlink(join(host.root, "elsewhere.txt"), join(host.root, "link.txt"));

    const replaced = await upload(host, "/notes.txt", Buffer.from("replacement"), "&conflict=overwrite");
    assert.equal(replaced.status, 200);
    assert.deepEqual(answer(replaced), { ok: true, value: { path: "/notes.txt", size: 11, skipped: false } });
    assert.equal(await readFile(join(host.root, "notes.txt"), "utf8"), "replacement");

    // A directory and a link are not this file's to replace: the upload is refused and what it named still stands.
    const directory = await upload(host, "/folder", Buffer.from("x"), "&conflict=overwrite");
    assert.equal(directory.status, 409);
    assert.equal(code(directory), "not_replaceable");
    assert.ok((await lstat(join(host.root, "folder"))).isDirectory());

    const link = await upload(host, "/link.txt", Buffer.from("x"), "&conflict=overwrite");
    assert.equal(link.status, 409);
    assert.equal(code(link), "not_replaceable");
    assert.equal((await lstat(join(host.root, "link.txt"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(host.root, "elsewhere.txt"), "utf8"), "elsewhere");
  } finally { await host.close(); }
});

test("an overwrite keeps the mode the file had rather than the staging file's own", async () => {
  const host = await localHost();
  try {
    const target = join(host.root, "run.sh");
    await writeFile(target, "#!/bin/sh\necho original\n");
    // An executable in the workspace is the case that matters: it was 0755 and it must still be 0755 afterwards.
    await chmod(target, 0o755);

    const replaced = await upload(host, "/run.sh", Buffer.from("#!/bin/sh\necho replaced\n"), "&conflict=overwrite");
    assert.equal(replaced.status, 200);
    assert.equal(await readFile(target, "utf8"), "#!/bin/sh\necho replaced\n");
    assert.equal((await lstat(target)).mode & 0o777, 0o755);
    assert.deepEqual(await staged(host.root), []);

    // A private mode is preserved too, rather than every replacement widening to the staging file's mode.
    await chmod(target, 0o600);
    assert.equal((await upload(host, "/run.sh", Buffer.from("again"), "&conflict=overwrite")).status, 200);
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
  } finally { await host.close(); }
});

test("a body that throws mid-upload leaves no staging file", async () => {
  const root = await workspaceRoot("hepi-file-transfer-throw-");
  const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]));
  try {
    // More than one staging chunk, so the staging file is really written before the body dies.
    const body = (async function* () {
      yield Buffer.alloc(UPLOAD_CHUNK_BYTES + 1, 4);
      throw new Error("the caller went away");
    })();
    await assert.rejects(() => uploadFile(files, "ws", "/half.bin", "error", body), /the caller went away/);
    assert.deepEqual(await staged(root), []);
    assert.equal(existsSync(join(root, "half.bin")), false);
  } finally { await files.close(); await rm(root, { recursive: true, force: true }); }
});

// The barriers are the gateway's own host calls; the test's own bound is what fails it if the cleanup call never
// comes, so a regression reports a failure instead of waiting forever.
test("a caller that disconnects mid-upload leaves no partial file and no staging file", { timeout: 30_000 }, async () => {
  const root = await workspaceRoot("hepi-file-transfer-");
  // The gateway's own host calls are the barriers: the staging chunk it wrote, and the staging file it removed on the
  // way out. Nothing here depends on how long either takes, because the disconnect is raced against the first.
  const workspaces = new WorkspaceRegistry([{ id: "ws", root }]);
  const seen = observed(new LocalFilesystem(workspaces));
  const host = await hostFor(root, "ws", workspaces, seen.files);
  try {
    const wrote = seen.when((request) => request.method === "appendFile" && staging(request));
    const removed = seen.when((request) => request.method === "remove" && staging(request));
    const exchange = host.http.start({
      method: "POST",
      path: "/v1/files/upload?workspaceId=" + host.workspace + "&path=%2Fhalf.bin",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
    });
    exchange.write(Buffer.alloc(2 * UPLOAD_CHUNK_BYTES, 6));
    await wrote;
    // The staging file exists before the body is read, so the disconnect below happens with a stage that must be cleaned.
    assert.equal((await staged(host.root)).length, 1, "the upload staged a file");

    exchange.destroy();
    await removed;
    assert.deepEqual(await staged(host.root), []);
    assert.equal(existsSync(join(host.root, "half.bin")), false);
    assert.deepEqual(await readdir(host.root), []);
  } finally { await host.close(); }
});

test("the pre-flight check reports what exists and what cannot be replaced", async () => {
  const host = await localHost();
  try {
    await writeFile(join(host.root, "taken.txt"), "x");
    await mkdir(join(host.root, "folder"));
    await symlink(join(host.root, "taken.txt"), join(host.root, "link.txt"));

    const response = await check(host, "/", ["taken.txt", "free.txt", "folder", "link.txt"]);
    assert.equal(response.status, 200);
    assert.deepEqual(answer(response), { ok: true, value: { conflicts: ["taken.txt", "folder", "link.txt"], nonReplaceable: ["folder", "link.txt"] } });

    const nested = await check(host, "/folder", ["taken.txt"]);
    assert.deepEqual(answer(nested), { ok: true, value: { conflicts: [], nonReplaceable: [] } });
  } finally { await host.close(); }
});

test("a file over the policy is refused and leaves no partial file behind", async () => {
  const host = await localHost();
  try {
    const response = await upload(host, "/huge.bin", Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    assert.equal(response.status, 413);
    assert.deepEqual(answer(response), { ok: false, code: "file_too_large", message: "a file may be at most " + MAX_FILE_BYTES + " bytes" });
    assert.deepEqual(await readdir(host.root), []);
  } finally { await host.close(); }
});

test("a name that is not one file's own name, and a directory that is not there, are refused", async () => {
  const host = await localHost();
  try {
    // A path that is not one file's own name is refused here; a path that climbs out of the workspace is refused by
    // the host's own confinement, which is the authority on what a workspace path may name.
    const named = await upload(host, "/..", Buffer.from("x"));
    assert.equal(named.status, 400);
    assert.equal(code(named), "invalid_request");

    const escaped = await upload(host, "/../escape.bin", Buffer.from("x"));
    assert.equal(escaped.status, 403);
    assert.equal(code(escaped), "permission_denied");

    const missing = await upload(host, "/nowhere/notes.txt", Buffer.from("x"));
    assert.equal(missing.status, 404);
    assert.equal(code(missing), "unknown_directory");
    assert.deepEqual(await readdir(host.root), []);
  } finally { await host.close(); }
});

test("the same upload reaches an SSH workspace through the remote helper, conflict rules included", async () => {
  const host = await sshHost();
  try {
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 9);
    const written = await upload(host, "/remote.bin", content);
    assert.equal(written.status, 200);
    assert.deepEqual(await readFile(join(host.root, "remote.bin")), content);
    assert.deepEqual(await staged(host.root), []);

    // The staging file lives in the workspace root whatever directory the upload names, so neither place keeps one.
    await mkdir(join(host.root, "sub"));
    const nested = Buffer.from("nested content");
    assert.equal((await upload(host, "/sub/new.bin", nested)).status, 200);
    assert.deepEqual(await readFile(join(host.root, "sub", "new.bin")), nested);
    assert.deepEqual(await staged(join(host.root, "sub")), []);

    await writeFile(join(host.root, "taken.txt"), "original");
    const refused = await upload(host, "/taken.txt", Buffer.from("replacement"));
    assert.equal(refused.status, 409);
    assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "original");

    // The remote helper keeps the target's own mode on a replacement, exactly as the local filesystem does.
    await chmod(join(host.root, "taken.txt"), 0o750);
    const replaced = await upload(host, "/taken.txt", Buffer.from("replacement"), "&conflict=overwrite");
    assert.equal(replaced.status, 200);
    assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "replacement");
    assert.equal((await lstat(join(host.root, "taken.txt"))).mode & 0o777, 0o750);
    assert.deepEqual(await staged(host.root), []);

    const streamed = await bytes(host, "/remote.bin", { range: "bytes=0-15" });
    assert.equal(streamed.status, 206);
    assert.deepEqual(streamed.body, content.subarray(0, 16));

    // The workspace is the whole world here too: a path that climbs out of it is refused by the host's own helper,
    // for a write and for a read, and nothing is staged or created beside the root.
    assert.equal((await upload(host, "/../escape.bin", Buffer.from("escape"))).status, 403);
    const escapedRead = await bytes(host, "/../remote.bin");
    assert.equal(escapedRead.status, 403);
    assert.equal(existsSync(join(dirname(host.root), "escape.bin")), false);
    assert.deepEqual(await staged(host.root), []);
  } finally { await host.close(); }
});

// The ticket-02 parity question is narrower than "does the remote host work": for one request, does a browser or a
// relay get the same status and the same named code whether the workspace is this machine's directory or an SSH host's?
// The two fixtures above differ only in the transport, so every difference below is a contract difference in the SSH
// adapter rather than a different request.
// The remote write's own version of the disconnect case: a caller that goes away mid-upload must leave no staging
// file on the remote host either, and the bytes it had already sent must not arrive as a file. The barriers are the
// gateway's own host calls, so this is the same exchange the local case runs, over the SSH filesystem.
test("a caller that disconnects mid-upload to an SSH workspace leaves no partial file and no staging file", { timeout: 30_000 }, async () => {
  const root = await workspaceRoot("hepi-file-transfer-ssh-cut-");
  const remote = fakeSsh({ root });
  const profiles = [{ id: "loopback", host: "loopback.example", remoteRoot: root }];
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const seen = observed(new SshFilesystem({ id: "gateway", profiles, workspaces, runner: remote.runner }));
  const host = await hostFor(root, "remote-loopback", workspaces, seen.files);
  try {
    const wrote = seen.when((request) => request.method === "appendFile" && staging(request));
    const removed = seen.when((request) => request.method === "remove" && staging(request));
    const exchange = host.http.start({
      method: "POST",
      path: "/v1/files/upload?workspaceId=" + host.workspace + "&path=%2Fhalf.bin",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
    });
    exchange.write(Buffer.alloc(2 * UPLOAD_CHUNK_BYTES, 6));
    await wrote;
    assert.equal((await staged(host.root)).length, 1, "the remote upload staged a file");

    exchange.destroy();
    await removed;
    assert.deepEqual(await staged(host.root), []);
    assert.equal(existsSync(join(host.root, "half.bin")), false);
    assert.deepEqual(await readdir(host.root), []);
  } finally { await host.close(); remote.kill(); }
});

test("a local workspace and an SSH workspace answer the payload routes with the same statuses and codes", async () => {
  const local = await localHost();
  const remote = await sshHost();
  try {
    // The same tree on both hosts: one name that exists, one directory, one link, one file over the policy, and one
    // name in a directory that is not there.
    for (const host of [local, remote]) {
      await writeFile(join(host.root, "taken.txt"), "original");
      await mkdir(join(host.root, "folder"));
      await writeFile(join(host.root, "elsewhere.txt"), "elsewhere");
      await symlink(join(host.root, "elsewhere.txt"), join(host.root, "link.txt"));
      await writeFile(join(host.root, "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 3));
    }

    const cases: readonly (readonly [string, Promise<GatewayResponse>, Promise<GatewayResponse>])[] = [
      ["an existing name under the default strategy", upload(local, "/taken.txt", Buffer.from("x")), upload(remote, "/taken.txt", Buffer.from("x"))],
      ["a link that is not a regular file to replace", upload(local, "/link.txt", Buffer.from("x"), "&conflict=overwrite"), upload(remote, "/link.txt", Buffer.from("x"), "&conflict=overwrite")],
      ["a directory that is not a file to replace", upload(local, "/folder", Buffer.from("x"), "&conflict=overwrite"), upload(remote, "/folder", Buffer.from("x"), "&conflict=overwrite")],
      ["a path that is not one file's own name", upload(local, "/..", Buffer.from("x")), upload(remote, "/..", Buffer.from("x"))],
      ["a path that climbs out of the workspace", upload(local, "/../escape.bin", Buffer.from("x")), upload(remote, "/../escape.bin", Buffer.from("x"))],
      ["a directory the workspace does not have", upload(local, "/nowhere/notes.txt", Buffer.from("x")), upload(remote, "/nowhere/notes.txt", Buffer.from("x"))],
      ["a file over the policy", upload(local, "/over.bin", Buffer.alloc(MAX_FILE_BYTES + 1, 1)), upload(remote, "/over.bin", Buffer.alloc(MAX_FILE_BYTES + 1, 1))],
      ["a range that starts past the end", bytes(local, "/taken.txt", { range: "bytes=99-100" }), bytes(remote, "/taken.txt", { range: "bytes=99-100" })],
      ["more than one range", bytes(local, "/taken.txt", { range: "bytes=0-1,3-4" }), bytes(remote, "/taken.txt", { range: "bytes=0-1,3-4" })],
      ["the workspace root, which is no file", bytes(local, "/"), bytes(remote, "/")],
      ["a file the host does not have", bytes(local, "/missing.bin"), bytes(remote, "/missing.bin")],
      ["a file over the policy, asked for by the byte route", bytes(local, "/huge.bin"), bytes(remote, "/huge.bin")],
      ["a workspace this gateway does not serve", other(local), other(remote)],
    ];
    for (const [what, one, two] of cases) {
      const [a, b] = await Promise.all([one, two]);
      assert.equal(b.status, a.status, what + ": the status differs");
      assert.equal(code(b), code(a), what + ": the code differs (" + code(a) + " local, " + code(b) + " remote)");
    }

    // The pre-flight check answers the same two lists for the same directory on either host.
    for (const host of [local, remote]) {
      const checked = await check(host, "/", ["taken.txt", "folder", "link.txt", "free.txt"]);
      assert.equal(checked.status, 200);
      assert.deepEqual(answer(checked), { ok: true, value: { conflicts: ["taken.txt", "folder", "link.txt"], nonReplaceable: ["folder", "link.txt"] } }, host.workspace);
    }

    // A refusal that ends with a written file is the same on both hosts, and neither keeps a staging file.
    for (const host of [local, remote]) {
      const replaced = await upload(host, "/taken.txt", Buffer.from("replacement"), "&conflict=overwrite");
      assert.equal(replaced.status, 200, host.workspace);
      assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "replacement");
      assert.deepEqual(await staged(host.root), [], host.workspace);
    }
  } finally { await local.close(); await remote.close(); }
});

test("a payload refusal keeps its code and states the file the caller named, on either host", async () => {
  const local = await localHost();
  const remote = await sshHost();
  try {
    for (const host of [local, remote]) {
      await mkdir(join(host.root, "folder"));
      await writeFile(join(host.root, "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    }
    // The host found the failure on its own disk, so its own answer carries that disk path in its message and in its
    // `path` field. The browser's payload answer keeps the status and the code and speaks about the path the caller
    // named instead — which also makes the two hosts word a missing file identically, where one said "lstat" and the
    // other "open", and states no directory that only the host knows.
    const cases: readonly (readonly [string, string, number, string, string])[] = [
      ["a file the workspace does not have", "/gone.md", 404, "not_found", "no such file in this workspace: /gone.md"],
      ["a directory, which is no file", "/folder", 404, "not_a_file", "not a regular file in this workspace: /folder"],
      ["a file over the policy", "/huge.bin", 413, "file_too_large", "a file may be at most " + MAX_FILE_BYTES + " bytes"],
    ];
    for (const [what, path, status, expectedCode, message] of cases) {
      const [a, b] = await Promise.all([bytes(local, path), bytes(remote, path)]);
      assert.equal(a.status, status, what + ": the local route answered " + a.status);
      assert.deepEqual(answer(a), { ok: false, code: expectedCode, message }, what + ": the local answer");
      assert.equal(b.status, status, what + ": the remote route answered " + b.status);
      assert.deepEqual(answer(b), { ok: false, code: expectedCode, message }, what + ": the remote answer");
    }

    // The boundary this rewiring stops at: the general file RPC keeps the host's real path, because the execution
    // tools that call it act on it (ADR 0002). Only the browser-facing payload route rewords a host answer.
    const rpc = await local.http.call({
      method: "POST",
      path: "/v1/files",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: local.workspace, method: "fileInfo", path: "/gone.md" }),
    });
    const reported = (answer(rpc) as { error: { code: string; message: string; path?: string } }).error;
    assert.equal(reported.code, "not_found");
    assert.equal(reported.path, join(local.root, "gone.md"), "the file RPC stopped reporting the host path it must keep");
  } finally { await local.close(); await remote.close(); }
});
test("the payload routes are authenticated like every other gateway route", async () => {
  const host = await localHost();
  try {
    assert.equal((await upload(host, "/notes.txt", Buffer.from("x"), "", "wrong")).status, 401);
    const unauthorized = await host.http.call({ method: "GET", path: "/v1/files/bytes?workspaceId=" + host.workspace + "&path=%2Fnotes.txt" });
    assert.equal(unauthorized.status, 401);
  } finally { await host.close(); }
});

test("a file is streamed back whole, and one range is served as the caller asked", async () => {
  const host = await localHost();
  try {
    const content = Buffer.from("0123456789abcdefghij");
    await writeFile(join(host.root, "blob.bin"), content);

    const whole = await bytes(host, "/blob.bin");
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["content-length"], String(content.byteLength));
    assert.equal(whole.headers["accept-ranges"], "bytes");
    assert.deepEqual(whole.body, content);

    const middle = await bytes(host, "/blob.bin", { range: "bytes=5-9" });
    assert.equal(middle.status, 206);
    assert.equal(middle.headers["content-range"], "bytes 5-9/" + content.byteLength);
    assert.equal(middle.headers["content-length"], "5");
    assert.equal(middle.body.toString("utf8"), "56789");

    const suffix = await bytes(host, "/blob.bin", { range: "bytes=-4" });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers["content-range"], "bytes 16-19/" + content.byteLength);
    assert.equal(suffix.body.toString("utf8"), "ghij");

    const openEnded = await bytes(host, "/blob.bin", { range: "bytes=18-" });
    assert.equal(openEnded.status, 206);
    assert.equal(openEnded.body.toString("utf8"), "ij");
  } finally { await host.close(); }
});

test("a range past the end, a range it cannot serve and a file over the policy each keep their own answer", async () => {
  const host = await localHost();
  try {
    await writeFile(join(host.root, "blob.bin"), "0123456789");

    const past = await bytes(host, "/blob.bin", { range: "bytes=99-100" });
    assert.equal(past.status, 416);
    assert.equal(code(past), "unsatisfiable_range");

    const several = await bytes(host, "/blob.bin", { range: "bytes=0-1,3-4" });
    assert.equal(several.status, 400);
    assert.equal(code(several), "invalid_range");

    await writeFile(join(host.root, "huge.bin"), Buffer.alloc(MAX_FILE_BYTES + 1, 1));
    const huge = await bytes(host, "/huge.bin");
    assert.equal(huge.status, 413);
    assert.equal(code(huge), "file_too_large");

    const directory = await bytes(host, "/");
    assert.equal(directory.status, 404);
    assert.equal(code(directory), "not_a_file");
  } finally { await host.close(); }
});
