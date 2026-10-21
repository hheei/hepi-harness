import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, SshGateway, WorkspaceRegistry, sshWorkspaceSeed, type SshRunner, type SshRunnerRequest } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { SshFilesystem } from "../src/ssh-filesystem.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";
import { sshWorkbench } from "../src/workbench/ssh-files.ts";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";
import { fakeSsh, type FakeSsh } from "./ssh-fake.ts";
import { makeDocx } from "./docx-fixture.ts";

/**
 * The browser's file surface on an SSH workspace whose gateway **mounts** a workbench.
 *
 * `ingress-files.test.ts` composes an SSH gateway deliberately *without* one, which is the right fixture for the
 * routing question it asks (a remote folder must never be listed as this machine's tree). That left the other half of
 * the journey unasked at this seam: whether an SSH workspace really serves browsing, preview, changed files, diff,
 * upload and download to a browser, and what a browser reads when the host fails instead of succeeding. Ticket 03's
 * acceptance line — "offline/error states remain actionable" — is only measurable here, because the answer a person
 * acts on is the browser's, not the gateway's DTO.
 *
 * Everything is the deployment's own code: the real client ingress, the real Backend, two real gateways, the real
 * `sshWorkbench` over the in-process host of ./ssh-fake.ts with git run on a real temporary tree, and the real local
 * workbench on the same tree. Nothing reaches a machine outside this process, and no refusal is probed for what it
 * protects: the escaping path below is one a normal browser makes, asserted as the refusal it already is.
 *
 * What is asserted is the answer: both hosts alike, each refusal cause keeping its own name, and no refusal stating
 * where the workspace lives on its host.
 */

const git = promisify(execFile);
const BACKEND_TOKEN = "ssh-ingress-backend-token";
const WEB_LOGIN = "ssh-ingress-login";
const LOCAL_GATEWAY = "workstation";
const SSH_GATEWAY = "workstation-ssh";
const MEGABYTE = 1024 * 1024;
const PROFILE = { id: "prod", host: "builder@fake-host", remoteRoot: "/srv/app", port: 2222, identityFile: "/keys/id", knownHostsFile: "/keys/known" };
const REMOTE = "/workspace/remote-prod";
const LOCAL = "/workspace/local";

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The helper session plus git on the tree the gateway named — the two capabilities a workbench reads. */
function hostRunner(host: FakeSsh, root: string): SshRunner {
  return {
    open: (request) => host.runner.open!(request),
    execute: async (request: SshRunnerRequest) => {
      if (request.cwd !== root && !request.cwd.startsWith(root + "/")) return { stdout: "", stderr: "outside root", exitCode: 126 };
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

/** One checkout: a tracked file edited after its baseline commit, one untracked file, one directory. */
async function makeCheckout(root: string): Promise<void> {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  await git("git", ["init", "-q", root]);
  await git("git", ["-C", root, "config", "user.email", "t@example.com"]);
  await git("git", ["-C", root, "config", "user.name", "T"]);
  await git("git", ["-C", root, "add", "-A"]);
  await git("git", ["-C", root, "commit", "-qm", "baseline"]);
  await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
  await writeFile(join(root, "notes.md"), "# notes\n");
  // One Word document, the same bytes on both trees: the preview bound is a routing question the two hosts must answer
  // alike, so the fixture gives them the same package rather than two approximations of it.
  await writeFile(join(root, "report.docx"), makeDocx(["hello from the host", "second paragraph"]));
}
type Fixture = {
  origin: string;
  localRoot: string;
  remoteRoot: string;
  host: FakeSsh;
  headers: Record<string, string>;
  /** The SSH gateway's own listener, so a test can take one host away and leave the deployment standing. */
  sshServer: GatewayRpcServer;
  close(): Promise<void>;
};

/**
 * Both entry points at once: the ingress a Web page reaches, the Backend behind it, and one gateway per host — this
 * machine's filesystem and workbench, and an SSH gateway holding the same workspace shape through the fake host.
 * `mountWorkbench: false` composes the SSH gateway without the surface, which is the deployment fact its `501` states.
 */
async function fixture(options: { mountWorkbench?: boolean } = {}): Promise<Fixture> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-ingress-ssh-workbench-")));
  directories.push(directory);
  const localRoot = join(directory, "local");
  const remoteRoot = join(directory, "remote");
  await mkdir(localRoot);
  await mkdir(remoteRoot);
  await mkdir(join(directory, "home"));
  await makeCheckout(localRoot);
  await makeCheckout(remoteRoot);
  const identity = { user: "operator", home: join(directory, "home") };

  const localRegistry = new WorkspaceRegistry([{ id: "local", root: localRoot }]);
  const localServer = new GatewayRpcServer(
    new LocalGateway({ id: LOCAL_GATEWAY, token: "local-gateway-token", workspaces: localRegistry, allowedCommands: [] }),
    new GatewayWorkbench(localRegistry),
    new LocalFilesystem(localRegistry, { identity }),
  );
  await new Promise<void>(resolve => localServer.server.listen(0, "127.0.0.1", resolve));
  const localAddress = localServer.server.address();
  assert.ok(localAddress && typeof localAddress === "object");

  const host = fakeSsh({ root: remoteRoot });
  const profile = { ...PROFILE, remoteRoot };
  const profiles = [profile];
  const sshRegistry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const runner = hostRunner(host, remoteRoot);
  const sshFiles = new SshFilesystem({ id: SSH_GATEWAY, profiles, runner, workspaces: sshRegistry });
  const sshServer = new GatewayRpcServer(
    new SshGateway({ id: SSH_GATEWAY, token: "ssh-gateway-token", profiles, allowedCommands: [], runner, workspaces: sshRegistry }),
    options.mountWorkbench === false ? undefined : sshWorkbench({ workspaces: sshRegistry, profiles, files: sshFiles, runner }),
    sshFiles,
  );
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
  const backend: BackendServer = await createBackendServer({
    dbPath: join(directory, "conversations.sqlite"),
    authToken: BACKEND_TOKEN,
    models,
    gateways,
    workspaces: [{ id: "local", ...gateways[0]! }, { id: "remote-prod", ...gateways[1]! }],
    deviceCredentials: credentials,
    defaultModel: SERVER_MODEL,
  });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.server.address();
  assert.ok(backendAddress && typeof backendAddress === "object");

  const ingress: ClientIngress = createClientIngress({
    backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: BACKEND_TOKEN },
    webLoginToken: WEB_LOGIN,
    uploadBatchBytes: 3 * MEGABYTE,
  });
  await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
  const ingressAddress = ingress.server.address();
  assert.ok(ingressAddress && typeof ingressAddress === "object");
  const origin = "http://127.0.0.1:" + ingressAddress.port;
  const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  const cookie: string = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="), "the web login set no session cookie");

  return {
    origin,
    localRoot,
    remoteRoot,
    host,
    sshServer,
    headers: { cookie, origin },
    close: async () => {
      await ingress.close();
      await backend.close();
      credentials.close();
      localServer.server.closeAllConnections();
      await localServer.close();
      sshServer.server.closeAllConnections();
      await sshFiles.close();
      await sshServer.close();
      host.kill();
    },
  };
}

type Answer = { status: number; body: unknown; text: string };
async function ask(app: Fixture, path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(app.origin + path, { headers: app.headers, ...init });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* bytes or empty */ }
  return { status: response.status, body, text };
}
const codeOf = (answer: Answer): string => ((answer.body ?? {}) as { code?: string }).code ?? "";
const wordsOf = (answer: Answer): string => JSON.stringify(answer.body);
test("an SSH workspace with a mounted workbench serves the browser the journey the local one does", { timeout: 120000 }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  // One table, both hosts, and the answer must be the same. This is what the migration rests on: a remote folder is
  // browsable, previewable, uploadable and downloadable exactly as a local one, through the browser's own addresses,
  // with nothing the Web layer had to learn twice.
  const cases: readonly (readonly [string, (routing: string) => string])[] = [
    ["a listing", (routing) => "/api/files" + routing + "?type=list"],
    ["a nested listing", (routing) => "/api/files" + routing + "/src?type=list"],
    ["a text preview", (routing) => "/api/files" + routing + "/src/app.ts?type=read"],
    ["a file's metadata", (routing) => "/api/files" + routing + "/notes.md?type=meta"],
    ["the @ index", (routing) => "/api/file-index?cwd=" + encodeURIComponent(routing) + "&q=app"],
    ["changed files", (routing) => "/api/git/status?cwd=" + encodeURIComponent(routing)],
    ["one file's diff", (routing) => "/api/git/diff?cwd=" + encodeURIComponent(routing) + "&path=" + encodeURIComponent(routing + "/src/app.ts")],
  ];
  for (const [what, build] of cases) {
    const local = await ask(app, build(LOCAL));
    const remote = await ask(app, build(REMOTE));
    assert.equal(local.status, 200, what + " on the local host answered " + local.status + " " + local.text.slice(0, 200));
    assert.equal(remote.status, 200, what + " on the remote host answered " + remote.status + " " + remote.text.slice(0, 200));
    // One answer, two hosts: the only difference allowed is the workspace the listing is of, which each host names
    // with the routing path the caller used. Anything else a host reports is the same fact about the same tree.
    const remoteAsLocal = remote.text.split(REMOTE).join(LOCAL);
    assert.equal(remoteAsLocal, local.text, what + " differs between the two hosts\n  local:  " + local.text.slice(0, 300) + "\n  remote: " + remote.text.slice(0, 300));
  }

  // The upload is the explorer's own request, and the file lands on the remote host rather than on this machine.
  const form = (): FormData => {
    const body = new FormData();
    body.append("files", new File(["uploaded on the browser\n"], "fresh.txt", { type: "text/plain" }));
    return body;
  };
  const uploaded = await ask(app, "/api/files" + REMOTE + "?type=upload&conflict=error", { method: "POST", body: form() });
  assert.equal(uploaded.status, 200, "the upload answered " + uploaded.status + " " + uploaded.text);
  assert.deepEqual(uploaded.body, { uploaded: ["fresh.txt"], skipped: [], errors: [] });
  assert.equal(await readFile(join(app.remoteRoot, "fresh.txt"), "utf8"), "uploaded on the browser\n");
  assert.ok(!(await readdir(app.localRoot)).includes("fresh.txt"), "the remote upload wrote into the local workspace");

  // The same name again is the conflict the explorer asks about, and `overwrite` replaces it on the host.
  const conflicted = await ask(app, "/api/files" + REMOTE + "?type=upload&conflict=error", { method: "POST", body: form() });
  assert.equal(conflicted.status, 409, "a second upload answered " + conflicted.status);
  assert.deepEqual((conflicted.body as { conflicts: string[] }).conflicts, ["fresh.txt"]);
  const overwritten = await ask(app, "/api/files" + REMOTE + "?type=upload&conflict=overwrite", { method: "POST", body: form() });
  assert.equal(overwritten.status, 200, "the overwrite answered " + overwritten.status + " " + overwritten.text);

  // A download is the file's own bytes, whole; a directory is not a file on either host.
  const download = await ask(app, "/api/files" + REMOTE + "/fresh.txt?type=download");
  assert.equal(download.status, 200);
  assert.equal(download.text, "uploaded on the browser\n");
  const directory = await ask(app, "/api/files" + REMOTE + "/src?type=download");
  assert.equal(directory.status, 404, "a directory download answered " + directory.status);
});

test("a Word document reaches the browser as its own bytes, on both hosts", { timeout: 120000 }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  // A .docx is a package, so a text preview of it says nothing about it: the surface serves the document and the browser
  // reads it (packages/ui/src/lib/docx-preview.ts). Both hosts must hand over the same bytes under the same MIME, and the
  // meta answer must name the kind, which is what lets the viewer refuse an over-bound document before fetching it.
  const served: Record<string, { status: number; mime: string | null; length: string | null; digest: string; zip: string }> = {};
  for (const routing of [LOCAL, REMOTE]) {
    const read = await fetch(app.origin + "/api/files" + routing + "/report.docx?type=read", { headers: app.headers });
    const bytes = Buffer.from(await read.arrayBuffer());
    served[routing] = {
      status: read.status,
      mime: read.headers.get("content-type"),
      length: read.headers.get("content-length"),
      digest: createHash("sha256").update(bytes).digest("hex"),
      zip: bytes.subarray(0, 4).toString("hex"),
    };
    const meta = await ask(app, "/api/files" + routing + "/report.docx?type=meta");
    assert.equal(meta.status, 200, routing + " meta answered " + meta.status + " " + meta.text);
    assert.equal((meta.body as { previewKind?: string }).previewKind, "docx", routing + " meta lost the preview kind: " + meta.text);
  }
  assert.notEqual(served[LOCAL].digest, "", "no document bytes were served");
  assert.equal(served[LOCAL].status, 200, "the docx read answered " + served[LOCAL].status + " " + JSON.stringify(served[LOCAL]));
  assert.equal(served[LOCAL].mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  for (const field of ["status", "mime", "length", "digest", "zip"] as const) {
    assert.equal(served[REMOTE][field], served[LOCAL][field], "a docx " + field + " differs between the two hosts: " + JSON.stringify(served));
  }
  // A range is the byte route's own contract, and a bounded reader depends on it: half a document arrives as a 206 with
  // the range the host stated rather than as a silent truncation.
  const ranged = await fetch(app.origin + "/api/files" + REMOTE + "/report.docx?type=read", { headers: { ...app.headers, range: "bytes=0-3" } });
  assert.equal(ranged.status, 206, "a docx range answered " + ranged.status);
  assert.equal(Buffer.from(await ranged.arrayBuffer()).toString("hex"), served[REMOTE].zip, "the ranged bytes are not the document's own start");
});
test("each refusal cause reaches the browser as its own answer, on both hosts", { timeout: 120000 }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  // A file the tree no longer has is the ordinary case rather than a corner: the listing is cached by the host and
  // again by the surface, so a file deleted while a page holds its name is read from a tree that still shows it. Both
  // hosts name it as the missing file it is — a 404 of the workbench's own `not_found` — rather than the 500 it used
  // to be, and neither answer names where the host keeps its files.
  for (const routing of [LOCAL, REMOTE]) {
    const missing = await ask(app, "/api/files" + routing + "/gone.md?type=read");
    assert.equal(missing.status, 404, routing + " missing file answered " + missing.status + " " + missing.text);
    assert.equal(codeOf(missing), "not_found");
    assert.match(wordsOf(missing), /no such path/, routing + " states what is missing: " + wordsOf(missing));
    assert.ok(!/home|\/home\/|\/tmp|\/var\/|workspace-host:/.test(wordsOf(missing)), routing + " a missing file named the host's own path: " + wordsOf(missing));
    assert.ok(!wordsOf(missing).includes("without the workbench"), routing + " called a missing file a missing capability");

    const unknown = await ask(app, "/api/files/workspace/nope?type=list");
    assert.equal(unknown.status, 404, routing + " unknown workspace answered " + unknown.status);
    assert.equal(codeOf(unknown), "unknown_workspace");

    // The path a browser's own relative link can produce, refused by the host that owns the workspace. The refusal
    // stays the host's 403 on both, because a remote confinement decision is not a local one restated.
    const escaped = await ask(app, "/api/files" + routing + "/%2fetc%2fpasswd?type=read");
    assert.equal(escaped.status, 403, routing + " escaping path answered " + escaped.status + " " + escaped.text);
    assert.equal(codeOf(escaped), "path_denied");
  }
});

test("a host that goes away is offline, not a capability that was never there", { timeout: 120000 }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const before = await ask(app, "/api/files" + REMOTE + "?type=list");
  assert.equal(before.status, 200, "the remote workspace was not serving first: " + before.status + " " + before.text.slice(0, 160));

  // Take one gateway's listener away and leave the ingress, the Backend and the other gateway standing: the state a
  // person reaches by the remote machine going to sleep. The transport reads a refused connection on a read as
  // offline, the Backend's workbench route answers its 503, and the surface must pass that truth on rather than
  // replace it with a claim about what the host was composed to do.
  app.sshServer.server.close();
  app.sshServer.server.closeAllConnections();

  const offline = await ask(app, "/api/files" + REMOTE + "?type=list");
  assert.equal(offline.status, 503, "an unreachable host answered " + offline.status + " " + offline.text);
  assert.equal(codeOf(offline), "gateway_offline");
  assert.match(wordsOf(offline), /could not be reached/);
  assert.ok(!wordsOf(offline).includes("without the workbench"), "an offline host was reported as a missing capability");

  // The other host this deployment serves is untouched by this one going away.
  const localStill = await ask(app, "/api/files" + LOCAL + "?type=list");
  assert.equal(localStill.status, 200, "the local listing broke with the remote host: " + localStill.status);
});

test("a gateway composed without the workbench says so, and says only that", { timeout: 120000 }, async (t) => {
  const app = await fixture({ mountWorkbench: false });
  t.after(() => app.close());
  for (const path of [
    "/api/files" + REMOTE + "?type=list",
    "/api/files" + REMOTE + "/notes.md?type=read",
    "/api/git/status?cwd=" + encodeURIComponent(REMOTE),
    "/api/file-index?cwd=" + encodeURIComponent(REMOTE),
  ]) {
    const answer = await ask(app, path);
    assert.equal(answer.status, 501, path + " answered " + answer.status + " " + answer.text);
    assert.equal(codeOf(answer), "not_supported");
    assert.match(wordsOf(answer), /composed without a workbench/);
  }
  // Bytes are the filesystem's own capability, which this gateway still has: an absent workbench must not make a
  // workspace unreadable as a whole, and must not claim the file is missing when it is there.
  const download = await ask(app, "/api/files" + REMOTE + "/notes.md?type=download");
  assert.equal(download.status, 200, "the byte route lost a capability it has: " + download.status + " " + download.text);
  assert.equal(download.text, "# notes\n");
});

test("a refusal states what went wrong about the file the caller named, not where the workspace lives", { timeout: 120000 }, async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  for (const routing of [LOCAL, REMOTE]) {
    const download = await ask(app, "/api/files" + routing + "/gone.md?type=download");
    assert.equal(download.status, 404, routing + " answered " + download.status);
    assert.equal(codeOf(download), "not_found");
    // The host's own filesystem path — a temporary directory here, a profile's remote root on a real deployment — is
    // nothing a browser can act on, and not this answer's to state.
    assert.ok(!download.text.includes(app.localRoot), "the local root leaked: " + download.text);
    assert.ok(!download.text.includes(app.remoteRoot), "the remote root leaked: " + download.text);
    assert.match(download.text, /gone\.md/, "the answer must still name the file that was asked for: " + download.text);

    const directory = await ask(app, "/api/files" + routing + "/src?type=download");
    assert.equal(directory.status, 404);
    assert.equal(codeOf(directory), "not_a_file");
    assert.ok(!directory.text.includes(app.localRoot) && !directory.text.includes(app.remoteRoot), "a directory refusal leaked a host path: " + directory.text);
  }
});
