import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress } from "../src/ingress/index.ts";
import { fakeSsh, type FakeSsh } from "./ssh-fake.ts";

const git = promisify(execFile);
const BACKEND_TOKEN = "probe-backend-token";
const WEB_LOGIN = "probe-login";
const LOCAL_GATEWAY = "workstation";
const SSH_GATEWAY = "workstation-ssh";
const MEGABYTE = 1024 * 1024;
const PROFILE = { id: "prod", host: "builder@fake-host", remoteRoot: "/srv/app", port: 2222, identityFile: "/keys/id", knownHostsFile: "/keys/known" };
const directories: string[] = [];
after(async () => { for (const d of directories) await rm(d, { recursive: true, force: true }); });

/** The helper session plus real git on the same temporary tree, as ssh-workbench.test.ts composes it. */
function hostRunner(host: FakeSsh, root: string, dead?: "git"): SshRunner {
  return {
    open: (request) => host.runner.open!(request),
    execute: async (request: SshRunnerRequest) => {
      if (request.cwd !== root && !request.cwd.startsWith(root + "/")) return { stdout: "", stderr: "outside root", exitCode: 126 };
      if (request.command[0] !== "git") return { stdout: "", stderr: request.command[0] + ": command not found", exitCode: 127 };
      if (dead === "git") return { stdout: "", stderr: "ssh: connect to host failed", exitCode: 255 };
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

async function fixture(options: { workbench: boolean; dead?: "session" | "git" }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hepi-probe-ssh-")));
  directories.push(directory);
  const localRoot = join(directory, "local");
  const remoteRoot = join(directory, "remote");
  await mkdir(localRoot); await mkdir(remoteRoot); await mkdir(join(directory, "home"));
  const localRegistry = new WorkspaceRegistry([{ id: "local", root: localRoot }]);
  const localFiles = new LocalFilesystem(localRegistry, { identity: { user: "operator", home: join(directory, "home") } });
  const localServer = new GatewayRpcServer(
    new LocalGateway({ id: LOCAL_GATEWAY, token: "local-token", workspaces: localRegistry, allowedCommands: [] }),
    new GatewayWorkbench(localRegistry), localFiles);
  await new Promise<void>((r) => localServer.server.listen(0, "127.0.0.1", r));
  const localAddress = localServer.server.address(); assert.ok(localAddress && typeof localAddress === "object");

  const host = fakeSsh({ root: remoteRoot, ...(options.dead === undefined ? {} : { startup: options.dead === "session" ? { stderr: "python3: not found", exitCode: 255 } : undefined }) });
  const profile = { ...PROFILE, remoteRoot };
  const profiles = [profile];
  const sshRegistry = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const runner = hostRunner(host, remoteRoot, options.dead === "git" ? "git" : undefined);
  const sshFiles = new SshFilesystem({ id: SSH_GATEWAY, profiles, runner, workspaces: sshRegistry });
  const sshGateway = new SshGateway({ id: SSH_GATEWAY, token: "ssh-token", profiles, allowedCommands: [], runner, workspaces: sshRegistry });
  const sshServer = new GatewayRpcServer(
    sshGateway,
    options.workbench ? sshWorkbench({ workspaces: sshRegistry, profiles, files: sshFiles, runner }) : undefined,
    sshFiles);
  await new Promise<void>((r) => sshServer.server.listen(0, "127.0.0.1", r));
  const sshAddress = sshServer.server.address(); assert.ok(sshAddress && typeof sshAddress === "object");

  const gateways = [
    { gatewayId: LOCAL_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + localAddress.port, gatewayToken: "local-token" },
    { gatewayId: SSH_GATEWAY, gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "ssh-token" },
  ];
  const models = createModels(); models.setProvider(fauxProvider().provider);
  const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
  const backend = await createBackendServer({
    dbPath: join(directory, "conversations.sqlite"), authToken: BACKEND_TOKEN, models, gateways,
    workspaces: [{ id: "local", ...gateways[0]! }, { id: "remote-prod", ...gateways[1]! }],
    deviceCredentials: credentials, defaultModel: SERVER_MODEL });
  await new Promise<void>((r) => backend.server.listen(0, "127.0.0.1", r));
  const backendAddress = backend.server.address(); assert.ok(backendAddress && typeof backendAddress === "object");
  const origin = "http://127.0.0.1:" + (ingressAddressOf(await makeIngress("http://127.0.0.1:" + backendAddress.port))).port;
  const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
  const cookieHeader = login.headers.get("set-cookie"); assert.ok(cookieHeader);
  return {
    origin, localRoot, remoteRoot, host, sshFiles,
    headers: { cookie: cookieHeader.split(";")[0]!, origin },
    close: async () => { await ingressHandle.close(); await backend.close(); credentials.close(); localServer.server.closeAllConnections(); await localServer.close(); sshServer.server.closeAllConnections(); await sshServer.close(); },
  };
}

let ingressHandle: ReturnType<typeof createClientIngress> & { server: { address(): unknown; listen(p: number, h: string, cb: () => void): void } } | null = null as never;
function ingressAddressOf(ingress: NonNullable<typeof ingressHandle>): { port: number } {
  const address = ingress.server.address();
  assert.ok(address && typeof address === "object");
  return address as { port: number };
}
async function makeIngress(backendOrigin: string) {
  const ingress = createClientIngress({ backend: { origin: backendOrigin, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN, uploadBatchBytes: 3 * MEGABYTE });
  await new Promise<void>((r) => ingress.server.listen(0, "127.0.0.1", r));
  ingressHandle = ingress as never;
  return ingress;
}

type App = Awaited<ReturnType<typeof fixture>>;
async function get(app: App, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(app.origin + path, { headers: { cookie: app.headers.cookie, origin: app.headers.origin } });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 80); }
  return { status: response.status, body };
}
function log(name: string, answer: { status: number; body: unknown }): void {
  console.log("PROBE " + name + " => " + answer.status + " " + JSON.stringify(answer.body).slice(0, 200));
}
const REMOTE = "/workspace/remote-prod";
async function makeCheckout(root: string): Promise<void> {
  await git("git", ["init", "-q", root]);
  await git("git", ["-C", root, "config", "user.email", "t@example.com"]);
  await git("git", ["-C", root, "config", "user.name", "T"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
  await git("git", ["-C", root, "add", "-A"]);
  await git("git", ["-C", root, "commit", "-qm", "baseline"]);
  await writeFile(join(root, "src", "app.ts"), "export const value = 2;\n");
  await writeFile(join(root, "notes.md"), "# remote notes\n");
  await writeFile(join(root, "report.docx"), "fake docx bytes\n");
  await writeFile(join(root, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7r6j4AAAAASUVORK5CYII=", "base64"));
  await writeFile(join(root, "huge.txt"), "y".repeat(21 * 1024 * 1024));
}

test("probe: remote workbench journey at the browser seam", { timeout: 180000 }, async (t) => {
  const app = await fixture({ workbench: true });
  t.after(() => app.close());
  await makeCheckout(app.remoteRoot);

  log("list", await get(app, "/api/files" + REMOTE + "?type=list"));
  log("read", await get(app, "/api/files" + REMOTE + "/notes.md?type=read"));
  log("meta", await get(app, "/api/files" + REMOTE + "/notes.md?type=meta"));
  log("index", await get(app, "/api/file-index?cwd=" + encodeURIComponent(REMOTE) + "&q=app"));
  log("status", await get(app, "/api/git/status?cwd=" + encodeURIComponent(REMOTE)));
  log("diff", await get(app, "/api/git/diff?cwd=" + encodeURIComponent(REMOTE) + "&path=" + encodeURIComponent(REMOTE + "/src/app.ts")));
  log("missing read", await get(app, "/api/files" + REMOTE + "/nope.txt?type=read"));
  log("missing meta", await get(app, "/api/files" + REMOTE + "/nope.txt?type=meta"));
  log("directory read", await get(app, "/api/files" + REMOTE + "/src?type=read"));
  log("traversal read", await get(app, "/api/files" + REMOTE + "/%2e%2e/outside.txt?type=read"));

  const up = (name: string, bytes: Buffer, strategy = "error") => {
    const boundary = "----probe";
    const body = Buffer.concat([
      Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"files\"; filename=\"" + name + "\"\r\n\r\n"),
      bytes, Buffer.from("\r\n--" + boundary + "--\r\n")]);
    return fetch(app.origin + "/api/files" + REMOTE + "?type=upload&conflict=" + strategy, {
      method: "POST", headers: { cookie: app.headers.cookie, origin: app.headers.origin, "content-type": "multipart/form-data; boundary=" + boundary }, body: new Blob([new Uint8Array(body)]) });
  };
  const first = await up("fresh.txt", Buffer.from("remote bytes"));
  log("upload", { status: first.status, body: await first.json().catch(() => "no json") });
  log("read uploaded", await get(app, "/api/files" + REMOTE + "/fresh.txt?type=read"));
  const again = await up("fresh.txt", Buffer.from("other"));
  log("upload conflict", { status: again.status, body: await again.json().catch(() => "no json") });
  const over = await up("fresh.txt", Buffer.from("overwritten"), "overwrite");
  log("upload overwrite", { status: over.status, body: await over.json().catch(() => "no json") });
  log("bytes of symlinked kind: download", await get(app, "/api/files" + REMOTE + "/fresh.txt?type=download"));
  const listed = await get(app, "/api/files" + REMOTE + "?type=list");
  log("listing shows the upload", { status: listed.status, body: (listed.body as { entries?: { name: string }[] }).entries?.map((e) => e.name) });
  const onDisk = await readdir(app.remoteRoot);
  log("remote tree on disk", { status: 0, body: onDisk });

  // The transport goes away: what does the browser get?
  app.host.kill();
  log("list after host death", await get(app, "/api/files" + REMOTE + "?type=list"));
  log("read after host death", await get(app, "/api/files" + REMOTE + "/notes.md?type=read"));
  log("status after host death", await get(app, "/api/git/status?cwd=" + encodeURIComponent(REMOTE)));
});

test("probe: local and remote answers, side by side, at the browser seam", { timeout: 180000 }, async (t) => {
  const app = await fixture({ workbench: true });
  t.after(() => app.close());
  await makeCheckout(app.remoteRoot);
  await makeCheckout(app.localRoot);
  const paths: [string, string][] = [
    ["missing read", "/nope.txt?type=read"],
    ["missing meta", "/nope.txt?type=meta"],
    ["directory read", "/src?type=read"],
    ["directory meta", "/src?type=meta"],
    ["traversal read", "/%2e%2e/outside.txt?type=read"],
    ["absolute read", "/%2fetc%2fpasswd?type=read"],
    ["missing download", "/nope.txt?type=download"],
    ["docx read", "/report.docx?type=read"],
    ["docx meta", "/report.docx?type=meta"],
    ["docx preview kind", "/report.docx?type=preview"],
    ["watch", "/notes.md?type=watch"],
    ["image read", "/pic.png?type=read"],
    ["big read", "/huge.txt?type=read"],
    ["big download", "/huge.txt?type=download"],
  ];
  for (const [name, suffix] of paths) {
    const remote = await get(app, "/api/files/workspace/remote-prod" + suffix);
    const local = await get(app, "/api/files/workspace/local" + suffix);
    console.log("PAIR " + name + " remote=" + remote.status + " " + JSON.stringify(remote.body).slice(0, 110));
    console.log("PAIR " + name + " local =" + local.status + " " + JSON.stringify(local.body).slice(0, 110));
  }
});

test("probe: an unreachable remote host at the browser seam", { timeout: 180000 }, async (t) => {
  for (const dead of ["session", "git"] as const) {
    const app = await fixture({ workbench: true, dead });
    t.after(() => app.close());
    if (dead === "git") await makeCheckout(app.remoteRoot); else app.host && (await writeFile(join(app.remoteRoot, "notes.md"), "# remote notes\n"));
    log("DEAD " + dead + " list", await get(app, "/api/files" + REMOTE + "?type=list"));
    log("DEAD " + dead + " read", await get(app, "/api/files" + REMOTE + "/notes.md?type=read"));
    log("DEAD " + dead + " status", await get(app, "/api/git/status?cwd=" + encodeURIComponent(REMOTE)));
    log("DEAD " + dead + " download", await get(app, "/api/files" + REMOTE + "/notes.md?type=download"));
  }
});

test("probe: the same workspace on a gateway composed without the workbench", { timeout: 180000 }, async (t) => {
  const app = await fixture({ workbench: false });
  t.after(() => app.close());
  await makeCheckout(app.remoteRoot);
  log("no-surface list", await get(app, "/api/files" + REMOTE + "?type=list"));
  log("no-surface read", await get(app, "/api/files" + REMOTE + "/notes.md?type=read"));
  log("no-surface status", await get(app, "/api/git/status?cwd=" + encodeURIComponent(REMOTE)));
  log("no-surface download", await get(app, "/api/files" + REMOTE + "/notes.md?type=download"));
});
