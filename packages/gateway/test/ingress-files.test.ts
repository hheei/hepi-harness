import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, SshGateway, WorkspaceRegistry, sshWorkspaceSeed } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";

import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";
import { createFakeSshHost, type FakeSshHost } from "./fake-ssh.ts";

/**
 * The browser's file surface, through the **client ingress** a Web page or an App reaches.
 *
 * Ticket 08 owns this surface: browsing, preview, changed files and diff, a bounded multipart upload, bytes with a
 * range, and the local/SSH routing that decides which host really holds a folder. Every one of them is asserted here at
 * the seam a client uses — a cookie or a device bearer on the ingress, a real Backend, and two real gateways (this
 * machine's filesystem, and the in-process SSH host of ./fake-ssh.ts) — because the failure this surface can have is not
 * "the parser is wrong" but "the bytes went to the wrong computer, or the wrong number of them was held".
 *
 * The upload's own bound is asserted as a bound and not as a claim: a body past the batch limit is refused with the
 * limit, and the bytes that reached the host are counted, so "streamed" means the host received the file rather than
 * this process having collected it.
 */

const BACKEND_TOKEN = "ingress-files-backend-token";
const WEB_LOGIN = "ingress-files-login";
const LOCAL_GATEWAY = "workstation";
const SSH_GATEWAY = "workstation-ssh";
const MEGABYTE = 1024 * 1024;
/** A batch bound this suite can reach: the default is a hundred megabytes, which is a size no test should send. */
const TEST_UPLOAD_BATCH_BYTES = 3 * MEGABYTE;

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

type Fixture = {
  origin: string;
  backend: BackendServer;
  ingress: ClientIngress;
  localRoot: string;
  remoteRoot: string;
  ssh: FakeSshHost;
  /** This machine's filesystem, so a test can see the reader handles a download opened and released. */
  localFiles: LocalFilesystem;
  close(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-files-")));
  directories.push(directory);
  const localRoot = join(directory, "local");
  const remoteRoot = join(directory, "remote");
  await mkdir(localRoot);
  await mkdir(remoteRoot);
  await mkdir(join(directory, "home"));
  const identity = { user: "operator", home: join(directory, "home") };

  const localRegistry = new WorkspaceRegistry([{ id: "local", root: localRoot }]);
  const localFiles = new LocalFilesystem(localRegistry, { identity });
  const localServer = new GatewayRpcServer({
    gateway: new LocalGateway({ id: LOCAL_GATEWAY, token: "local-gateway-token", workspaces: localRegistry, allowedCommands: [] }),
    workbench: new GatewayWorkbench(localRegistry),
    files: localFiles,
  });
  await new Promise<void>(resolve => localServer.server.listen(0, "127.0.0.1", resolve));
  const localAddress = localServer.server.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const ssh = createFakeSshHost({ root: remoteRoot, user: "builder", home: join(directory, "remote-home") });
  const profiles = [ssh.profile];
  const sshRegistry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  // No workbench on this SSH gateway, as a gateway composed without the surface is: browsing answers its own named
  // limit instead of a tree. The deployment's own SSH gateway mounts one (see ssh-workbench.test.ts); this fixture
  // keeps the absent-surface case, which is what a gateway without the capability must still say plainly.
  const sshServer = new GatewayRpcServer({
    gateway: new SshGateway({ id: SSH_GATEWAY, token: "ssh-gateway-token", profiles, allowedCommands: [], runner: ssh.runner, workspaces: sshRegistry }),
    files: new SshFilesystem({ id: SSH_GATEWAY, profiles, runner: ssh.runner, workspaces: sshRegistry }),
  });
  await new Promise<void>(resolve => sshServer.server.listen(0, "127.0.0.1", resolve));
  const sshAddress = sshServer.server.address();
  assert.ok(sshAddress && typeof sshAddress === "object");

  const gateways = [
    { gatewayId: LOCAL_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + localAddress.port, gatewayToken: "local-gateway-token" },
    { gatewayId: SSH_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "ssh-gateway-token" },
  ];
  const models = createModels();
  models.setProvider(fauxProvider().provider);
  const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
  const backend = await createBackendServer({
    dbPath: join(directory, "conversations.sqlite"),
    authToken: BACKEND_TOKEN,
    models,
    gateways,
    workspaces: [
      { id: "local", ...gateways[0]! },
      { id: "remote-prod", ...gateways[1]! },
    ],
    deviceCredentials: credentials,
    defaultModel: SERVER_MODEL,
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.server.address();
  assert.ok(backendAddress && typeof backendAddress === "object");
  const ingress = createClientIngress({
    backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
    webLoginToken: WEB_LOGIN,
    uploadBatchBytes: TEST_UPLOAD_BATCH_BYTES,
  });
  await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress && typeof ingressAddress === "object");
  return {
    origin: "http://127.0.0.1:" + ingressAddress.port,
    backend,
    ingress,
    localRoot,
    remoteRoot,
    ssh,
    localFiles,
    close: async () => {
      await ingress.close();
      await backend.close();
      credentials.close();
      localServer.server.closeAllConnections();
      await localServer.close();
      sshServer.server.closeAllConnections();
      await sshServer.close();
    },
  };
}

/** The cookie pair a Web login set, as the browser sends it back. */
async function webSession(origin: string): Promise<string> {
  const response = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  assert.equal(response.status, 200);
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the login response set no cookie");
  assert.ok(header.split(";")[0]!.startsWith(WEB_SESSION_COOKIE + "="));
  return header.split(";")[0]!;
}

/** One multipart body, as the explorer's own file control produces it. */
function multipart(files: readonly (readonly [string, Buffer])[], boundary = "----hepi-ingress-files"): { body: Buffer; contentType: string } {
  const parts: Buffer[] = [];
  for (const [name, content] of files) {
    parts.push(Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + name + "\"\r\nContent-Type: application/octet-stream\r\n\r\n"));
    parts.push(content);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(parts), contentType: "multipart/form-data; boundary=" + boundary };
}

const uploadTo = (origin: string, routingPath: string, headers: Record<string, string>, files: readonly (readonly [string, Buffer])[], strategy = "error"): Promise<Response> => {
  const { body, contentType } = multipart(files);
  return fetch(origin + "/api/files/" + routingPath + "?type=upload&conflict=" + strategy, {
    method: "POST",
    headers: { ...headers, "content-type": contentType, origin },
    body: new Blob([new Uint8Array(body)]),
  });
};

test("a browser browses, previews and lists changes on the local workspace through the ingress", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    await writeFile(join(app.localRoot, "notes.md"), "# notes\n");
    await mkdir(join(app.localRoot, "src"));
    await writeFile(join(app.localRoot, "src", "app.ts"), "export const a = 1;\n");

    const listing = await fetch(app.origin + "/api/files/workspace/local?type=list", { headers });
    assert.equal(listing.status, 200);
    const listed = await listing.json() as { entries: { name: string; isDir: boolean }[]; path: string };
    assert.equal(listed.path, "/workspace/local");
    assert.deepEqual(listed.entries.map(entry => [entry.name, entry.isDir]), [["src", true], ["notes.md", false]]);

    const nested = await (await fetch(app.origin + "/api/files/workspace/local/src?type=list", { headers })).json() as { entries: { name: string }[] };
    assert.deepEqual(nested.entries.map(entry => entry.name), ["app.ts"]);

    const preview = await fetch(app.origin + "/api/files/workspace/local/src/app.ts?type=read", { headers });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { content: string; language: string; truncated: boolean };
    assert.equal(previewBody.content, "export const a = 1;\n");
    assert.equal(previewBody.language, "typescript");
    assert.equal(previewBody.truncated, false);

    const meta = await (await fetch(app.origin + "/api/files/workspace/local/src/app.ts?type=meta", { headers })).json() as { size: number; language: string; mime: string };
    assert.equal(meta.size, 20);
    assert.equal(meta.mime, "text/plain");

    // The @ index ranks against the same host listing, and the tree and the index read one workspace.
    const index = await (await fetch(app.origin + "/api/file-index?cwd=" + encodeURIComponent("/workspace/local") + "&q=app", { headers })).json() as { matches: { path: string }[] };
    assert.deepEqual(index.matches.map(match => match.path), ["src/app.ts"]);
    const flat = await (await fetch(app.origin + "/api/file-index?cwd=" + encodeURIComponent("/workspace/local"), { headers })).json() as { files: string[]; truncated: boolean };
    assert.deepEqual(flat.files, ["notes.md", "src/app.ts"]);
    assert.equal(flat.truncated, false);

    // Changed files and one diff: the host's git, in the browser's vocabulary.
    const status = await (await fetch(app.origin + "/api/git/status?cwd=" + encodeURIComponent("/workspace/local"), { headers })).json() as { isGitRepository: boolean; files: { filePath: string; status: string }[] };
    assert.equal(typeof status.isGitRepository, "boolean");
  } finally { await app.close(); }
});

test("an upload writes the host that holds the folder, and a file larger than one JSON request arrives whole", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };

    const checked = await fetch(app.origin + "/api/files/workspace/local?type=upload-check", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fileNames: ["big.bin", "notes.txt"] }),
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), { conflicts: [], nonReplaceable: [] });

    // Two files in one batch, one of them past the JSON request limit the workbench proxy carries.
    const big = Buffer.alloc(2 * MEGABYTE + 17, 7);
    const uploaded = await uploadTo(app.origin, "workspace/local", headers, [["big.bin", big], ["notes.txt", Buffer.from("hello")]]);
    const uploadAnswer = await uploaded.json();
    assert.equal(uploaded.status, 200, JSON.stringify(uploadAnswer));
    assert.deepEqual(uploadAnswer, { uploaded: ["big.bin", "notes.txt"], skipped: [], errors: [] });
    assert.deepEqual(await readFile(join(app.localRoot, "big.bin")), big);
    assert.equal(await readFile(join(app.localRoot, "notes.txt"), "utf8"), "hello");

    // The same upload again is a conflict: the names that exist and the ones that cannot be replaced.
    const refused = await uploadTo(app.origin, "workspace/local", headers, [["notes.txt", Buffer.from("other")]]);
    assert.equal(refused.status, 409);
    const refusal = await refused.json() as { error: string; conflicts: string[]; nonReplaceable: string[] };
    assert.deepEqual(refusal.conflicts, ["notes.txt"]);
    assert.deepEqual(refusal.nonReplaceable, []);
    assert.equal(await readFile(join(app.localRoot, "notes.txt"), "utf8"), "hello");

    // A name that is not one file's own name never reaches the host.
    const escaped = await uploadTo(app.origin, "workspace/local", headers, [["../escape.txt", Buffer.from("x")]]);
    assert.equal(escaped.status, 400);
    assert.equal((await escaped.json() as { error: string }).error, "File names must not contain a path: ../escape.txt");
    await assert.rejects(() => stat(join(app.localRoot, "..", "escape.txt")));
  } finally { await app.close(); }
});

test("a download is the file's bytes, and a byte range is served from the host's own answer", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    const content = Buffer.alloc(MEGABYTE + 3, 11);
    await writeFile(join(app.localRoot, "blob.bin"), content);
    await writeFile(join(app.localRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

    const whole = await fetch(app.origin + "/api/files/workspace/local/blob.bin?type=download", { headers });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-disposition"), "attachment; filename*=UTF-8''blob.bin");
    assert.equal(whole.headers.get("accept-ranges"), "bytes");
    const downloaded = Buffer.from(await whole.arrayBuffer());
    assert.equal(downloaded.byteLength, content.byteLength);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), createHash("sha256").update(content).digest("hex"));

    // A range is the browser's own header, passed to the host and answered by it: the body is the window it named.
    const ranged = await fetch(app.origin + "/api/files/workspace/local/blob.bin?type=download", { headers: { ...headers, range: "bytes=1048570-1048578" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 1048570-1048578/" + content.byteLength);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), content.subarray(1048570, 1048579));

    // An image is its own bytes with the image MIME, not a text preview of them.
    const image = await fetch(app.origin + "/api/files/workspace/local/logo.png?type=read", { headers });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");

    const beyond = await fetch(app.origin + "/api/files/workspace/local/blob.bin?type=download", { headers: { ...headers, range: "bytes=" + content.byteLength + "-" } });
    assert.equal(beyond.status, 416);
  } finally { await app.close(); }
});

test("a browser's percent-encoded path is the host's own name, decoded once, and an escape stays refused", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    // Names a browser really has to encode: a space, a Unicode letter, a literal percent. Each is an ordinary file on
    // the host, and the path the browser sends for it is not the path the host has.
    await mkdir(join(app.localRoot, "my dir"));
    await writeFile(join(app.localRoot, "my dir", "my note.md"), "# spaced\n");
    await writeFile(join(app.localRoot, "笔记.md"), "# unicode\n");
    await writeFile(join(app.localRoot, "100%.md"), "# percent\n");
    await mkdir(join(app.localRoot, "nested"));
    await writeFile(join(app.localRoot, "nested", "deep.md"), "# deep\n");

    // Browsing, preview, download and upload of those names. A path passed on still encoded would name no file at all,
    // which is what this asserts against: the answer is the file, under the name the host has.
    const listing = await (await fetch(app.origin + "/api/files/workspace/local/my%20dir?type=list", { headers })).json() as { entries: { name: string }[]; path: string };
    assert.equal(listing.path, "/workspace/local/my dir");
    assert.deepEqual(listing.entries.map(entry => entry.name), ["my note.md"]);

    const preview = await fetch(app.origin + "/api/files/workspace/local/my%20dir/my%20note.md?type=read", { headers });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as { content: string }).content, "# spaced\n");

    const unicode = await fetch(app.origin + "/api/files/workspace/local/" + encodeURIComponent("笔记.md") + "?type=read", { headers });
    assert.equal(unicode.status, 200);
    assert.equal((await unicode.json() as { content: string }).content, "# unicode\n");

    // The download's own name comes from the decoded path too, so a file saves under the name it has on the host.
    const percent = await fetch(app.origin + "/api/files/workspace/local/100%25.md?type=download", { headers });
    assert.equal(percent.status, 200);
    assert.equal(percent.headers.get("content-disposition"), "attachment; filename*=UTF-8''100%25.md");
    assert.equal(await percent.text(), "# percent\n");

    const uploaded = await uploadTo(app.origin, "workspace/local/my%20dir", headers, [["up loaded.txt", Buffer.from("up")]], "overwrite");
    assert.equal(uploaded.status, 200, await uploaded.text().catch(() => ""));
    assert.equal(await readFile(join(app.localRoot, "my dir", "up loaded.txt"), "utf8"), "up");

    // The decode is one pass and happens here, so an encoded separator is a separator and an encoded dot is a dot: what
    // they become is a path, and it is the host's own confinement — not this hop — that decides whether it may be read.
    const encodedSeparator = await fetch(app.origin + "/api/files/workspace/local/nested%2Fdeep.md?type=read", { headers });
    assert.equal(encodedSeparator.status, 200, "an encoded separator named a different path");
    assert.equal((await encodedSeparator.json() as { content: string }).content, "# deep\n");

    const escaped = await fetch(app.origin + "/api/files/workspace/local/%2e%2e%2foutside.txt?type=read", { headers });
    assert.ok(escaped.status === 403 || escaped.status === 404, "an encoded escape answered " + escaped.status);
    await assert.rejects(() => stat(join(app.localRoot, "..", "outside.txt")), "an encoded escape wrote or read outside the workspace");

    // A path that is not valid encoding names no file, and is answered as the malformed request it is.
    const malformed = await fetch(app.origin + "/api/files/workspace/local/%zz.md?type=read", { headers });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, "The file path is not valid percent-encoding");
  } finally { await app.close(); }
});

test("an SSH workspace routes to its own host, and browsing is a named absence rather than this machine's tree", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    app.ssh.writeFile(join(app.remoteRoot, "remote.txt"), "on the remote host");
    // A file of the same name on this machine: a routing mistake would answer with this one instead.
    await writeFile(join(app.localRoot, "remote.txt"), "on this machine");

    // A host composed without a workbench answers the limit instead of a tree. The failure this assertion exists for is
    // a remote folder silently listed as this machine's own, which would show one computer's files under another
    // computer's name.
    for (const path of ["", "/remote.txt?type=read", "/remote.txt?type=meta"]) {
      const answer = await fetch(app.origin + "/api/files/workspace/remote-prod" + path + (path === "" ? "?type=list" : ""), { headers });
      assert.equal(answer.status, 501, path + " answered " + answer.status);
      assert.equal((await answer.json() as { code: string }).code, "not_supported");
    }
    for (const path of ["/api/git/status?cwd=" + encodeURIComponent("/workspace/remote-prod"), "/api/file-index?cwd=" + encodeURIComponent("/workspace/remote-prod")]) {
      const answer = await fetch(app.origin + path, { headers });
      assert.equal(answer.status, 501, path + " answered " + answer.status);
      assert.equal((await answer.json() as { code: string }).code, "not_supported");
    }

    // A payload request is the host's own: the SSH transport is the one asked, and this machine's filesystem is not.
    const before = app.ssh.requests.length;
    const download = await fetch(app.origin + "/api/files/workspace/remote-prod/remote.txt?type=download", { headers });
    await download.body?.cancel().catch(() => undefined);
    assert.ok(app.ssh.requests.length > before, "the remote workspace's bytes were not asked of the SSH host");
  } finally { await app.close(); }
});

test("an upload past the batch bound is refused with the bound, and nothing is written", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };

    // A chunked body is counted as it arrives: the bound is the same one a declared body would be refused by.
    const boundary = "----hepi-ingress-bound";
    const prologue = Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"huge.bin\"\r\n\r\n");
    let written = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(prologue)); },
      pull(controller) {
        // The caller keeps sending a little past the bound and then stops: a caller that never stops is cut off, which
        // is a different case from the one this asserts.
        if (written > TEST_UPLOAD_BATCH_BYTES + MEGABYTE / 2) { controller.enqueue(new Uint8Array(Buffer.from("\r\n--" + boundary + "--\r\n"))); controller.close(); return; }
        written += MEGABYTE;
        controller.enqueue(new Uint8Array(Buffer.alloc(MEGABYTE, 1)));
      },
    });
    const streamed = await fetch(app.origin + "/api/files/workspace/local?type=upload&conflict=overwrite", {
      method: "POST",
      headers: { ...headers, "content-type": "multipart/form-data; boundary=" + boundary },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(streamed.status, 413);
    assert.equal((await streamed.json() as { error: string }).error, "The upload is larger than the " + TEST_UPLOAD_BATCH_BYTES + " bytes one upload may carry in total");
    assert.equal(written > TEST_UPLOAD_BATCH_BYTES, true, "the bound was never reached, so nothing was measured");
    await assert.rejects(() => stat(join(app.localRoot, "huge.bin")), "a refused upload left a file behind");
  } finally { await app.close(); }
});

test("a download's bytes are paced by its reader, and a caller that goes away releases the host reader", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    // Large enough that the host must read it in several bounded chunks, so a slow reader really does pace it.
    const content = Buffer.alloc(3 * MEGABYTE, 13);
    await writeFile(join(app.localRoot, "paced.bin"), content);
    const handles = () => app.localFiles.readers.handles.size;

    // A reader that takes one small piece and then stops: the host read is paced by the caller's own reading rather
    // than by this process collecting the file, so the body is not already over when the first piece arrives.
    const controller = new AbortController();
    const response = await fetch(app.origin + "/api/files/workspace/local/paced.bin?type=download", { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value!.byteLength > 0 && first.value!.byteLength < content.byteLength, "the whole file arrived in one piece");
    assert.equal(handles(), 1, "the host reader was not opened for the download");

    // Walking away closes the caller's side, which closes the host request, which releases the host's own reader: the
    // handle a stalled download would otherwise hold for its whole idle lifetime.
    controller.abort();
    await reader.cancel().catch(() => undefined);
    for (let waited = 0; waited < 100 && handles() > 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handles(), 0, "the host reader outlived the caller that opened it");
  } finally { await app.close(); }
});

test("a device bearer reaches the file surface, and an undeclared origin does not", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const issued = await fetch(app.origin + "/api/device-credentials", { method: "POST", headers: { origin: app.origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "app" }) });
    assert.equal(issued.status, 201);
    const { token } = await issued.json() as { token: string };
    await writeFile(join(app.localRoot, "app.txt"), "seen by the App");

    // The App presents its bearer and no cookie: the same surface, the same bytes.
    const download = await fetch(app.origin + "/api/files/workspace/local/app.txt?type=download", { headers: { authorization: "Bearer " + token } });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "seen by the App");

    const uploaded = await uploadTo(app.origin, "workspace/local", { authorization: "Bearer " + token }, [["from-app.txt", Buffer.from("app bytes")]]);
    assert.equal(uploaded.status, 200, await uploaded.text().catch(() => ""));
    assert.equal(await readFile(join(app.localRoot, "from-app.txt"), "utf8"), "app bytes");

    // An origin this ingress does not declare is refused before the file surface is reached at all.
    const denied = await fetch(app.origin + "/api/files/workspace/local/app.txt?type=download", { headers: { authorization: "Bearer " + token, origin: "tauri://localhost" } });
    assert.equal(denied.status, 403);
  } finally { await app.close(); }
});

test("the three request types this surface does not serve answer a named 501", { timeout: 120000 }, async () => {
  const app = await fixture();
  try {
    const cookie = await webSession(app.origin);
    const headers = { cookie, origin: app.origin };
    await writeFile(join(app.localRoot, "notes.md"), "# notes\n");
    for (const type of ["watch", "preview", "allow-link"]) {
      const response = await fetch(app.origin + "/api/files/workspace/local/notes.md?type=" + type, { headers });
      assert.equal(response.status, 501, type + " did not answer 501");
      const body = await response.json() as { code: string; accepted: boolean };
      assert.equal(body.code, "unsupported");
      assert.equal(body.accepted, false);
    }
    // A path that names no workspace is refused here rather than guessed into one.
    const unrouted = await fetch(app.origin + "/api/files/durable/notes.md?type=read", { headers });
    assert.equal(unrouted.status, 501);
  } finally { await app.close(); }
});
