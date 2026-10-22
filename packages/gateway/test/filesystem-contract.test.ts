import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalFilesystem, type FileRequest, type FilesystemServer } from "../src/filesystem.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { createSystemSshRunner } from "../src/runner.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";
import { sshdFixtureSkip, startSshdFixture } from "./sshd-fixture.ts";

// These are the same admitted requests on both adapters; only the host and registry setup differ.
async function workspaceContract(files: FilesystemServer, workspaceId: string): Promise<void> {
  const call = async (request: Omit<FileRequest, "workspaceId">): Promise<unknown> => {
    const result = await files.execute({ workspaceId, ...request }) as { ok: boolean; value?: unknown };
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  await call({ method: "createDir", path: "/src", options: { recursive: true } });
  await call({ method: "writeFile", path: "/src/report.txt", content: "alpha\nbeta\n" });
  assert.equal(await call({ method: "readTextFile", path: "/src/report.txt" }), "alpha\nbeta\n");
  const listing = await call({ method: "listDir", path: "/src" }) as { name: string; path: string; kind: string }[];
  assert.deepEqual(listing.map(({ name, path, kind }) => ({ name, path, kind })), [
    { name: "report.txt", path: "/src/report.txt", kind: "file" },
  ]);
  const handle = await call({ method: "openBinaryReader", path: "/src/report.txt" }) as string;
  try {
    assert.equal(await call({ method: "reader.read", handle, offset: 0, length: 5 }), "YWxwaGE=");
    const scan = await call({ method: "reader.scanLines", handle, options: { startLine: 1, endLine: 2 } }) as { newlines: number; start: number; end: number };
    assert.deepEqual({ newlines: scan.newlines, start: scan.start, end: scan.end }, { newlines: 2, start: 6, end: 10 });
    const info = await call({ method: "reader.info", handle }) as { path: string; size: number };
    assert.equal(info.path, "/src/report.txt");
    assert.equal(info.size, 11);
  } finally { await call({ method: "reader.close", handle }); }
  await call({ method: "writeFile", path: "/src/report.stage", content: "replacement\n" });
  await call({ method: "renameFile", path: "/src/report.stage", destinationPath: "/src/report.txt", options: { preserveMode: true } });
  assert.equal(await call({ method: "readTextFile", path: "/src/report.txt" }), "replacement\n");
  await call({ method: "writeFile", path: "/src/blob.bin", content: "AAEC/4A=", encoding: "base64" });
  assert.equal(await call({ method: "readBinaryFile", path: "/src/blob.bin" }), "AAEC/4A=");
  await call({ method: "remove", path: "/src", options: { recursive: true } });
  assert.equal(await call({ method: "exists", path: "/src" }), false);
}

test("local adapter serves the shared workspace contract", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-files-contract-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "workspace");
  const home = join(base, "home");
  await mkdir(root);
  await mkdir(home);
  const files = new LocalFilesystem(new WorkspaceRegistry([{ id: "ws", root }]), { identity: { user: "operator", home } });
  t.after(() => files.close());
  await workspaceContract(files, "ws");
});

test("loopback SSH adapter serves the shared workspace contract", { skip: sshdFixtureSkip(), timeout: 60_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-files-contract-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fixture = await startSshdFixture({ home: join(base, "home") });
  t.after(() => fixture.stop());
  const profiles = [{ id: "loopback", host: fixture.host, remoteRoot: fixture.root, port: fixture.port, identityFile: fixture.identityFile, knownHostsFile: fixture.knownHostsFile }];
  const files = new SshFilesystem({ id: "ssh", profiles, runner: createSystemSshRunner(), workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)) });
  t.after(() => files.close());
  await workspaceContract(files, "remote-loopback");
});
