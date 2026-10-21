import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayRpcServer, LocalGateway } from "../src/index.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { gatewayHttp, type GatewayHttp, type GatewayResponse } from "./gateway-http.ts";
import { fakeSsh, type FakeFrame } from "./ssh-fake.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

/**
 * The file payload routes against an SSH workspace: a workspace root on this machine, the gateway's own SSH filesystem,
 * and no daemon, no key pair, no port and no child process anywhere in the fixture.
 *
 * The transport is the repository's in-process host fake (`ssh-fake.ts`): it answers the same request frames a remote
 * helper answers, applies the same confinement, the same mode-preserving replacement and the same staging cleanup, and
 * opens no subprocess — so a machine needs neither `ssh` nor Python to run this. The gateway's own SSH filesystem is
 * still the code under test: it builds the frames, decides the conflict rules, and reads the answers. The HTTP seam is
 * in-process too (`gateway-http.ts`): the server's own parsing, routing, status and headers run unmodified over a
 * duplex pair, so nothing binds a port and no other test can collide with this one.
 *
 * What this proves, and what the local suite beside it does not: the same payload routes reach a workspace through the
 * SSH filesystem the deployment uses — an upload's bytes, a replacement's permissions, a range, a path that climbs out
 * of the workspace, and the frames the upload actually sends (one `tmpfile` in the root, one `append` per chunk, one
 * `rename` that carries the preserve-mode flag). A real `ssh` client and a real helper program are
 * `ssh-filesystem.test.ts`, the `ssh-transport`-backed suites and `resource-snapshot.test.ts`'s sshd case.
 */

const TOKEN = "file-transfer-sshd-token";

type Host = {
  readonly root: string;
  readonly http: GatewayHttp;
  /** Every request frame the remote host was handed, in order: the protocol the upload actually speaks. */
  readonly frames: readonly FakeFrame[];
  close(): Promise<void>;
};

/** An SSH workspace served through the in-process host, with the gateway's own routes over an in-process seam. */
async function sshHost(): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "hepi-file-transfer-sshd-"));
  const remote = fakeSsh({ root });
  // The SSH filesystem seeds its workspace ids as "remote-" + the profile id, so the profile is "sshd" and the
  // workspace the routes name is "remote-sshd".
  const profiles = [{ id: "sshd", host: "remote-sshd.example", remoteRoot: root }];
  const workspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const files = new SshFilesystem({ id: "gateway-1", profiles, workspaces, runner: remote.runner });
  const gateway = new LocalGateway({ id: "gateway-1", token: TOKEN, workspaces, allowedCommands: [] });
  const server = new GatewayRpcServer(gateway, undefined, files);
  const http = gatewayHttp(server.server);
  return {
    root,
    http,
    frames: remote.frames,
    close: async () => {
      http.close();
      // The gateway's own close ends its filesystem, so no helper session outlives the test.
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const answer = (response: GatewayResponse): unknown => JSON.parse(response.body.toString("utf8"));
const code = (response: GatewayResponse): string => (answer(response) as { code: string }).code;

const upload = (host: Host, path: string, body: Uint8Array, query = "") =>
  host.http.call({
    method: "POST",
    path: "/v1/files/upload?workspaceId=remote-sshd&path=" + encodeURIComponent(path) + query,
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/octet-stream", "content-length": String(body.byteLength) },
    body,
  });

const bytes = (host: Host, path: string, headers: Record<string, string> = {}) =>
  host.http.call({
    method: "GET",
    path: "/v1/files/bytes?workspaceId=remote-sshd&path=" + encodeURIComponent(path),
    headers: { authorization: "Bearer " + TOKEN, ...headers },
  });

const staged = async (root: string): Promise<string[]> => (await readdir(root)).filter((name) => name.startsWith(".hepi-upload-"));
const modes = (frames: readonly FakeFrame[], mode: string): FakeFrame[] => frames.filter((frame) => frame.mode === mode);

test("an upload reaches an SSH workspace whole, and a replacement keeps the target's permissions", async () => {
  const host = await sshHost();
  try {
    // Larger than the 1 MiB JSON reader the file RPC enforces, so it can only arrive through the byte route. Each
    // staging chunk is a request of its own, so the payload stays just past that reader rather than a size the local
    // case already covers.
    const content = Buffer.alloc(1024 * 1024 + 17, 11);
    const written = await upload(host, "/big.bin", content);
    assert.equal(written.status, 200);
    assert.deepEqual(answer(written), { ok: true, value: { path: "/big.bin", size: content.byteLength, skipped: false } });
    assert.deepEqual(await readFile(join(host.root, "big.bin")), content);
    assert.deepEqual(await staged(host.root), []);

    // A replacement keeps the mode the file had: the staging file is private, and the target was executable.
    const script = join(host.root, "run.sh");
    await writeFile(script, "#!/bin/sh\necho original\n");
    await chmod(script, 0o755);
    const replaced = await upload(host, "/run.sh", Buffer.from("#!/bin/sh\necho replaced\n"), "&conflict=overwrite");
    assert.equal(replaced.status, 200);
    assert.equal(await readFile(script, "utf8"), "#!/bin/sh\necho replaced\n");
    assert.equal((await lstat(script)).mode & 0o777, 0o755);
    assert.deepEqual(await staged(host.root), []);

    // One range, served from the host's own bytes.
    const ranged = await bytes(host, "/big.bin", { range: "bytes=1048570-1048580" });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers["content-range"], "bytes 1048570-1048580/" + content.byteLength);
    assert.deepEqual(ranged.body, content.subarray(1048570, 1048581));
    assert.equal(content.byteLength > 1024 * 1024, true);

    // The workspace is the whole world here too, and nothing is created beside it.
    const escaped = await upload(host, "/../escape.bin", Buffer.from("escape"));
    assert.equal(escaped.status, 403);
    assert.equal(code(escaped), "permission_denied");
    assert.equal(existsSync(join(host.root, "..", "escape.bin")), false);
    assert.deepEqual(await staged(host.root), []);

    // The frames say what the route did over the remote host, not just what came back: every request carried this
    // session's own root, the staging file was created by the host in that root, its bytes were appended there, and
    // the commit is a rename that carries the preserve-mode flag exactly when there was a target to preserve.
    assert.deepEqual(new Set(host.frames.map((frame) => frame.root)), new Set([host.root]), "every frame carries the profile's remote root");
    const prefixes = modes(host.frames, "tmpfile").map((frame) => frame.args[0]);
    assert.deepEqual(new Set(prefixes), new Set([".hepi-upload-"]), "the upload asks the host for its own staging file");
    const appended = modes(host.frames, "append");
    assert.ok(appended.length > 1, "a file past one chunk arrives as more than one append");
    assert.equal(appended.every((frame) => frame.args[0]!.startsWith(join(host.root, ".hepi-upload-"))), true, "every append lands in the staging file");
    const renames = modes(host.frames, "rename");
    assert.deepEqual(renames.map((frame) => frame.args[2]), ["0", "1"], "a create preserves nothing; a replacement preserves the target's mode");
    assert.deepEqual(renames.map((frame) => frame.args[1]), [join(host.root, "big.bin"), join(host.root, "run.sh")]);
  } finally { await host.close(); }
  // The fixture's own cleanup, asserted rather than assumed: the gateway's close took the workspace root with it.
  assert.equal(existsSync(host.root), false, "the workspace root is gone once the host closed");
});

test("an SSH workspace applies the same conflict rules, including a link it may not replace", async () => {
  const host = await sshHost();
  try {
    // A staging file lives in the workspace root whatever directory the upload names, so neither place keeps one.
    await mkdir(join(host.root, "sub"));
    const nested = Buffer.from("nested content");
    assert.equal((await upload(host, "/sub/new.bin", nested)).status, 200);
    assert.deepEqual(await readFile(join(host.root, "sub", "new.bin")), nested);
    assert.deepEqual(await staged(join(host.root, "sub")), []);
    assert.deepEqual(await staged(host.root), []);

    await writeFile(join(host.root, "taken.txt"), "original");
    await writeFile(join(host.root, "elsewhere.txt"), "elsewhere");
    await symlink(join(host.root, "elsewhere.txt"), join(host.root, "link.txt"));

    // An existing name is refused before anything is written, and the host is asked for no staging file at all.
    const before = host.frames.length;
    const refused = await upload(host, "/taken.txt", Buffer.from("replacement"));
    assert.equal(refused.status, 409);
    assert.deepEqual(answer(refused), { ok: false, code: "conflict", message: "the file already exists", conflicts: ["/taken.txt"], nonReplaceable: [] });
    assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "original");
    assert.deepEqual(modes(host.frames.slice(before), "tmpfile"), [], "a refused upload never asks the host to stage");
    assert.deepEqual(await staged(host.root), []);

    // A link is not this file's to replace: the helper reports it as a link, and the upload is refused.
    const link = await upload(host, "/link.txt", Buffer.from("x"), "&conflict=overwrite");
    assert.equal(link.status, 409);
    assert.equal(code(link), "not_replaceable");
    assert.equal((await lstat(join(host.root, "link.txt"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(host.root, "elsewhere.txt"), "utf8"), "elsewhere");
    assert.deepEqual(await staged(host.root), []);
  } finally { await host.close(); }
});
