/**
 * Builtin Skills browser verification (ticket 04). Not a paid-provider smoke and not a CI test: it drives the real
 * Next UI in a headless Chromium against a real backend, a real local gateway, an SSH execution host and a controlled
 * repository fetch, so no network and no model credential are involved.
 *
 * The SSH execution host has two transports:
 *   --transport controlled  (default) the gateway's real Python helper through a controlled transport that makes the
 *                           helper's own account lookup answer as a temporary login and home, so both installation
 *                           scopes are exercised without touching any real account.
 *   --transport sshd        a real localhost sshd with its own host key, key pair and pinned known-hosts file, driven
 *                           by the gateway's real `ssh` runner. The account is therefore this machine's real login, so
 *                           the remote host is exercised at project scope (a temporary workspace) and its real account
 *                           home is asserted byte-identical before and after: a global installation would write into
 *                           the operator's own resource directory, which this check must never do.
 *
 * Two modes:
 *   --mode baseline-market  the previous standalone Market entry, used to reproduce B4 before the repair: an
 *                           installation's notice disappears as soon as the installed-state controls replace the
 *                           install controls, so the outcome is lost on the very refresh it should survive. Run this
 *                           against the pre-change baseline worktree; the entry it drives no longer exists after the
 *                           repair, so on the repaired tree it fails on purpose with "no Skill market entry".
 *   --mode builtin          the retained builtin Skills panel: the same user path, with the outcome kept outside the
 *                           installed/status switch, an explicit execution target, the Market entry gone, and the two
 *                           state questions (repository revision vs. local content) reported separately.
 *
 * The fixture's execution hosts are temporary: the local gateway serves a temporary account home and workspace, and
 * the SSH half is the gateway's real Python helper run through a controlled transport that makes the helper's own
 * account lookup answer as a different login and home. Nothing in the operator's home or workspace is read or written.
 *
 * Usage: node apps/server/scripts/skills-ui-smoke.ts [--mode builtin|baseline-market] [--transport controlled|sshd]
 *        [--web-root <dir>] [--keep]
 *        HEPI_SKILLS_SMOKE_WEB_PORT=<port> HEPI_SKILLS_SMOKE_BACKEND_PORT=<port>
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayRpcServer, LocalGateway, SshGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer, REMOTE_INSTALL_SCRIPT, SshInstallServer } from "../../../packages/gateway/src/install.ts";
import { REMOTE_FILESYSTEM_SCRIPT } from "../../../packages/gateway/src/ssh-filesystem-helper.ts";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { createSystemSshRunner, type SshRunner } from "../../../packages/gateway/src/runner.ts";
import { pythonSshRunner } from "../../../packages/gateway/test/ssh-transport.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createSkillMarket, type MarketFetch } from "../src/skill-repository.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../../../packages/gateway/src/workspaces.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const argv = new Set(process.argv.slice(2));
const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1]! : fallback;
};
const mode = argument("--mode", "builtin");
const transport = argument("--transport", "controlled");
if (!["controlled", "sshd"].includes(transport)) throw new Error("--transport is controlled or sshd");
const webRoot = resolve(argument("--web-root", join(repoRoot, "apps", "web")));
const keep = argv.has("--keep");
const webPort = Number(process.env.HEPI_SKILLS_SMOKE_WEB_PORT ?? 43104);
const backendPort = Number(process.env.HEPI_SKILLS_SMOKE_BACKEND_PORT ?? 44104);
const authToken = "skills-smoke-token";

const failures: string[] = [];
const notes: string[] = [];
function check(condition: unknown, message: string): void {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message: string): void { notes.push(message); console.log("  ..  " + message); }

const NOTES_V1 = "---\nname: notes\ndescription: Take notes\n---\n# Notes v1\n";
const NOTES_V2 = "---\nname: notes\ndescription: Take notes\n---\n# Notes v2\n";

async function freePort(preferred: number): Promise<number> {
  const probe = createServer();
  const taken = await new Promise<boolean>((resolveProbe) => {
    probe.once("error", () => resolveProbe(true));
    probe.listen(preferred, "127.0.0.1", () => probe.close(() => resolveProbe(false)));
  });
  if (!taken) return preferred;
  return await new Promise((resolvePort, reject) => {
    const next = createServer();
    next.on("error", reject);
    next.listen(0, "127.0.0.1", () => {
      const address = next.address();
      if (address === null || typeof address !== "object") { next.close(); reject(new Error("no port")); return; }
      const port = address.port;
      next.close(() => resolvePort(port));
    });
  });
}

/** Resolve one command, with its exit code on failure so a helper's own error text is what is reported. */
function run(command: string, args: readonly string[], options: { env?: Record<string, string> } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(command, [...args], { env: { ...process.env, ...options.env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error === null) { resolveRun({ stdout, stderr }); return; }
      const detail = (stderr || stdout || "").trim();
      rejectRun(new Error(command + " failed (" + String((error as { code?: unknown }).code) + ")" + (detail === "" ? "" : ": " + detail)));
    });
  });
}

/** A content digest of a directory tree, for "the real account resource directories are untouched". */
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { hash.update("dir " + path); await walk(path); continue; }
      hash.update("file " + path + " " + createHash("sha256").update(await readFile(path).catch(() => Buffer.alloc(0))).digest("hex"));
    }
  };
  await walk(root);
  return hash.digest("hex");
}

/**
 * A throwaway localhost sshd: one ephemeral port, its own key pair and host key, an absolute AuthorizedKeysFile, and
 * a known-hosts file pinned by scanning exactly that port. It accepts only this process's own user, so the execution
 * account the gateway resolves over it is the real login on this machine.
 */
type Sshd = { port: number; identity: string; knownHosts: string; stop(): Promise<void> };
async function startSshd(base: string): Promise<Sshd> {
  const dir = join(base, "sshd");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // An ephemeral port this fixture then binds: the kernel's own assignment is the reservation, and it is released
  // before sshd takes it, exactly as the backend and UI ports are chosen.
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); rejectPort(new Error("no port")); return; }
      const assigned = address.port;
      probe.close(() => resolvePort(assigned));
    });
  });
  const identity = join(dir, "client");
  const hostKey = join(dir, "host");
  const knownHosts = join(dir, "known_hosts");
  const authorized = join(dir, "authorized_keys");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  await writeFile(authorized, await readFile(identity + ".pub"), { mode: 0o600 });
  await writeFile(join(dir, "sshd_config"), [
    "Port " + port,
    "ListenAddress 127.0.0.1",
    'HostKey "' + hostKey + '"',
    'AuthorizedKeysFile "' + authorized + '"',
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "UsePAM no",
    // The fixture keys live in a temporary directory, so the daemon's own ownership checks are what would refuse them.
    "StrictModes no",
    "PermitRootLogin no",
    "AllowUsers " + userInfo().username,
    "AllowTcpForwarding no",
    "PermitTunnel no",
    'PidFile "' + join(dir, "sshd.pid") + '"',
    "",
  ].join("\n"), { mode: 0o600 });
  const daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  daemon.stderr?.on("data", (chunk: Buffer) => { log += chunk.toString(); });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("sshd did not report readiness: " + log)), 15000);
    daemon.stderr?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Server listening")) { clearTimeout(timer); resolveReady(); } });
    daemon.once("exit", (code) => { clearTimeout(timer); rejectReady(new Error("sshd exited " + String(code) + ": " + log)); });
  });
  await writeFile(knownHosts, (await run("ssh-keyscan", ["-p", String(port), "127.0.0.1"])).stdout);
  return {
    port, identity, knownHosts,
    stop: async () => {
      if (daemon.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => daemon.once("exit", () => resolveExit()));
      daemon.kill("SIGTERM");
      await exited;
    },
  };
}

/** Read a file until the text satisfies a condition, or the deadline passes: the host's content is the observable. */
async function waitForText(path: string, predicate: (text: string) => boolean, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text !== undefined && predicate(text)) return text;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  return undefined;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return false;
}

const children: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];
let base = "";
let exitCode = 0;

try {
  base = await mkdtemp(join(tmpdir(), "hepi-skills-ui-"));
  const home = join(base, "home");
  const root = join(base, "workspace");
  const remoteHome = join(base, "remote-home");
  const remoteRoot = join(base, "remote-workspace");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });

  // The local execution host: a temporary account home and workspace, served by the real local gateway.
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const files = new LocalFilesystem(workspaces, { identity: { user: "operator", home } });
  const installs = new LocalInstallServer(workspaces, { identity: { user: "operator", home } });
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files, installs);
  await new Promise<void>((resolveListen) => gateway.server.listen(0, "127.0.0.1", resolveListen));
  const gatewayAddress = gateway.server.address();
  if (gatewayAddress === null || typeof gatewayAddress !== "object") throw new Error("the local gateway did not start");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };
  closers.push(async () => { gateway.server.closeAllConnections(); await gateway.close(); });

  // The SSH execution host. The controlled transport makes the real helper's own account lookup answer as a
  // temporary login and home, so the global scope can be exercised safely; the real sshd runs on this machine's real
  // account, so only its project scope is written and its real account home is asserted unchanged.
  const realAccount = { user: userInfo().username, home: homedir() };
  const remoteAccount = transport === "sshd" ? realAccount : { user: "remote-operator", home: remoteHome };
  let runner: SshRunner;
  let profiles: { id: string; host: string; remoteRoot: string; port?: number; identityFile?: string; knownHostsFile?: string }[];
  if (transport === "sshd") {
    const sshd = await startSshd(base);
    closers.push(() => sshd.stop());
    runner = createSystemSshRunner();
    profiles = [{ id: "prod", host: realAccount.user + "@127.0.0.1", remoteRoot, port: sshd.port, identityFile: sshd.identity, knownHostsFile: sshd.knownHosts }];
  } else {
    runner = pythonSshRunner({ user: remoteAccount.user, home: remoteAccount.home }, [REMOTE_INSTALL_SCRIPT, REMOTE_FILESYSTEM_SCRIPT]).runner;
    profiles = [{ id: "prod", host: "build.example", remoteRoot }];
  }
  const sshWorkspaces = new WorkspaceRegistry(sshWorkspaceSeed(profiles));
  const sshGateway = new GatewayRpcServer(
    new SshGateway({ id: "workstation-ssh", token: "ssh-token", profiles, workspaces: sshWorkspaces, allowedCommands: ["bash"], runner }),
    undefined,
    new SshFilesystem({ id: "workstation-ssh", profiles, workspaces: sshWorkspaces, runner }),
    new SshInstallServer({ profiles, workspaces: sshWorkspaces, runner }),
  );
  await new Promise<void>((resolveListen) => sshGateway.server.listen(0, "127.0.0.1", resolveListen));
  const sshAddress = sshGateway.server.address();
  if (sshAddress === null || typeof sshAddress !== "object") throw new Error("the SSH gateway did not start");
  const sshBinding = { id: "remote-prod", gatewayId: "workstation-ssh", gatewayOrigin: "http://127.0.0.1:" + sshAddress.port, gatewayToken: "ssh-token" };
  closers.push(async () => { sshGateway.server.closeAllConnections(); await sshGateway.close(); });

  // The repository and the public catalog: a controlled fetch, so both sources are deterministic and nothing is
  // downloaded. The catalog answers one hit whose repository is the same curated source, so a hit is pinned and
  // installed through the same path the library uses; a query for "notes" makes it fail and any other query is empty.
  const repositoryFetch: MarketFetch = async (url, kind) => {
    if (url.startsWith("https://skills.sh/api/search")) {
      const query = new URL(url).searchParams.get("q") ?? "";
      if (query === "notes") throw new Error("the public catalog is unreachable");
      // A second repository whose branch cannot be read, and a row that is not a GitHub coordinate: each is one hit's
      // own failure, and neither may empty the answer or affect the hit beside it.
      if (query === "mixed") return { query, count: 3, skills: [
        { id: "owner/good/good", skillId: "good", name: "good", installs: 5, source: "owner/good" },
        { id: "owner/broken/broken", skillId: "broken", name: "broken", installs: 2, source: "owner/broken" },
        { id: "vendor/thing", skillId: "thing", name: "thing", installs: 1, source: "skills.volces.com" },
      ] };
      if (query !== "curated") return { query, count: 0, skills: [] };
      return { query, count: 1, skills: [{ id: "anthropics/skills/curated", skillId: "curated", name: "curated", installs: 9, source: "anthropics/skills" }] };
    }
    // The catalog row whose repository cannot be read: its own failure, reported for that hit alone.
    if (/^https:\/\/api\.github\.com\/repos\/owner\/broken$/.test(url)) throw new Error("repository unavailable");
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return { default_branch: "main" };
    if (url.includes("/owner/broken/")) throw new Error("no such branch");
    if (url.includes("/branches/")) return { commit: { sha: "aaaa1111bbbb2222" } };
    // The curated source is deliberately a different skill, so the `notes` bundle the assertions act on is the
    // harness-managed one; the catalog's own "good" hit lives under its own repository.
    if (url.includes("/git/trees/")) return { tree: url.includes("/owner/good/") ? [{ path: "skills/good/SKILL.md", type: "blob" }] : [{ path: "skills/curated/SKILL.md", type: "blob" }] };
    if (url.includes("SKILL.md")) {
      if (kind !== "text") return "";
      return url.includes("/owner/good/") ? "---\nname: good\ndescription: A catalog skill\n---\n# Good\n" : "---\nname: curated\ndescription: A curated skill\n---\n# Curated\n";
    }
    throw new Error("unexpected " + url);
  };
  const market = createSkillMarket({ path: join(base, "skill-repository.sqlite"), sources: [{ id: "anthropics", owner: "anthropics", repo: "skills", branch: "main" }], fetch: repositoryFetch });
  closers.push(async () => market.close());
  const published = market.publish({ name: "notes", version: "1.0.0", markdown: NOTES_V1, files: [{ path: "REFERENCE.md", content: "# Reference\n" }] });
  if (!published.ok) throw new Error("the fixture bundle could not be published");
  // A second bundle for the project scope: one name is one discovered skill, so a same-name install at both scopes on
  // one host would be discovered once (the nearest root wins) and the two placements could not be told apart.
  const projectBundle = market.publish({ name: "project-notes", version: "1.0.0", markdown: "---\nname: project-notes\ndescription: Project notes\n---\n# Project notes\n", files: [] });
  if (!projectBundle.ok) throw new Error("the fixture project bundle could not be published");

  const port = await freePort(backendPort);
  const backend: BackendServer = await createBackendServer({
    dbPath: join(base, "server.sqlite"),
    authToken,
    workspaces: [binding, sshBinding],
    workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }),
    skillMarket: market,
  });
  await new Promise<void>((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
  const backendOrigin = "http://127.0.0.1:" + port;
  closers.push(async () => { backend.server.closeAllConnections(); await backend.close(); });

  const headers = { authorization: "Bearer " + authToken, "content-type": "application/json" };
  const created = await fetch(backendOrigin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  const conversation = await created.json() as { conversationId?: string };
  check(created.status === 201 && typeof conversation.conversationId === "string", "the fixture backend created a conversation");
  const conversationId = conversation.conversationId!;

  // The real account's own resource directories, read before anything runs. The sshd transport runs on this real
  // account, so a global installation there would write into the operator's home: these digests are the proof it did
  // not, and in the controlled transport they are the same read of the same untouched directories.
  const realRoots = [join(realAccount.home, ".agents", "skills"), join(realAccount.home, ".pi", "agent", "skills")];
  const realBefore = await Promise.all(realRoots.map(async (path) => [path, await treeDigest(path)] as const));

  // The real Next UI, served from this worktree's own production build on its own port. The build is this worktree's
  // `.next`, never the deployed one's; `next build` must have run in `--web-root` first.
  const built = await readFile(join(webRoot, ".next", "BUILD_ID"), "utf8").catch(() => undefined);
  check(built !== undefined, "the Web UI has a production build in " + webRoot + " (run: pnpm --filter @hepi/web build)");
  const uiPort = await freePort(webPort);
  const ui = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(uiPort)], {
    cwd: webRoot,
    env: { ...process.env, HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: authToken, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(ui);
  const uiLog: string[] = [];
  ui.stdout?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
  ui.stderr?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
  const uiOrigin = "http://127.0.0.1:" + uiPort;
  const up = await waitForHttp(uiOrigin + "/", 120000);
  check(up, "the Web UI started" + (up ? "" : " (log tail: " + uiLog.join("").slice(-400) + ")"));

  if (up) {
    const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    try {
      await page.goto(uiOrigin + "/?session=" + conversationId);
      const password = page.locator('input[type="password"]');
      if (await password.count()) {
        await password.fill(authToken);
        await page.locator('button[type="submit"]').click();
      }
      await page.locator("textarea").first().waitFor({ timeout: 60000 });
      check(true, "the browser authenticated and the app rendered");

      const installNotice = (text: RegExp) => page.getByText(text).first();
      // Host labels carry the account the gateway resolved, its gateway id and the workspace id; the SSH scope differs
      // by transport, because the real sshd runs on this machine's real account and only its project scope is safe.
      const localHostLabel = "operator@workstation/local";
      const sshHostLabel = (transport === "sshd" ? realAccount.user : "remote-operator") + "@workstation-ssh/remote-prod";
      const sshScope = transport === "sshd" ? "project" : "global";
      const sshInstallNotice = transport === "sshd" ? /^Installed notes \(project\)/ : /^Installed notes \(global\)/;
      /** The library card of one bundle, so an action is always taken on the skill the assertion is about. */
      const card = (name: string) => page.locator(".market-card", { hasText: name }).first();
      /** The panel's own refresh, which re-reads the execution host's inventory. */
      const refresh = () => page.locator("footer").getByRole("button", { name: "Refresh", exact: true });
      /** One installed skill's sidebar row, by its own name rather than a substring of another skill's. */
      const installedRow = (name: string) => page.locator(".config-sidebar").getByRole("button", { name, exact: true }).first();
      /** The installation destination: the execution account's own skills, or the selected workspace's project folder. */
      const scopeOption = (name: "global" | "project") => page.locator(".config-save-target .config-scope-switch-option", { hasText: name }).first();

      if (mode === "baseline-market") {
        // B4, reproduced against the previous standalone Market entry: an installation whose Reload fails reports both
        // facts, and both are gone the moment the installed-state controls replace the install controls.
        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Skill market", exact: true }).click();
        await page.getByLabel("Search skills").fill("notes");
        await page.locator(".market-card", { hasText: "notes" }).first().click();
        const preview = page.getByRole("dialog", { name: "notes" });
        await preview.getByText("Notes v1").waitFor({ timeout: 30000 });
        await preview.getByRole("radio", { name: "Workspace (project)" }).click();
        await preview.getByRole("button", { name: "Install", exact: true }).click();
        // The notice appears only inside the install controls, and those are swapped out as soon as the host reports an
        // installation at this scope: the outcome is lost at the status switch.
        await preview.getByRole("button", { name: "Update", exact: true }).waitFor({ timeout: 30000 });
        const notice = await page.getByText(/^Installed notes \(workspace\)/).count();
        check(notice === 0, "B4 reproduced: the install outcome is gone once the status switch replaced the install controls (" + notice + " notice(s) rendered)");
        check(await page.getByText(/reloaded this conversation/).count() === 0, "B4 reproduced: no operation outcome survives the control switch");
      } else {
        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        // The standalone Market entry is gone: the retained panel is the one skills workflow.
        check(await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Skill market", exact: true }).count() === 0, "the standalone Market entry no longer exists");
        await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Skills", exact: true }).click();
        // The execution target is named: the account the gateway itself reported, on the gateway and workspace that
        // serve it. A host that could not be resolved would be named as such instead of shown as an account.
        await page.getByText(localHostLabel).first().waitFor({ timeout: 60000 });
        check(true, "the panel names the local execution host and account (" + localHostLabel + ")");
        await page.getByText(sshHostLabel).first().waitFor({ timeout: 30000 });
        check(true, "the panel names the SSH execution host and its own account (" + sshHostLabel + ")");

        // Install into global on this session's own workspace: the library browses and installs, and the session's
        // conversation is the one asked to adopt, because this target is exactly where that conversation runs.
        await page.getByRole("button", { name: "Add skill" }).click();
        await card("notes").waitFor({ timeout: 30000 });
        check(true, "the library lists the harness-managed bundle without an active run");

        // Both source kinds are their own labelled block with their own state, and the catalog is queried through the
        // controlled fixture: no catalog content is downloaded and every state is deterministic.
        const searchBox = page.locator(".config-add-source-input");
        const sourceBlock = (label: string) => page.locator(".market-source").filter({ hasText: label }).first();
        const catalogBlock = sourceBlock("skills.sh public catalog");
        await catalogBlock.waitFor({ timeout: 30000 });
        check(await page.locator(".market-source").count() === 2, "the add pane shows the harness library and the skills.sh catalog as two labelled sources");
        check(await catalogBlock.getByText(/type to search the public catalog/).count() > 0, "the catalog says it has not been queried yet instead of claiming no match");

        // A catalog that cannot be read is named as the failed source, and the harness library beside it still lists
        // its own content: the two sources never share a state.
        await searchBox.fill("notes");
        const catalogFailed = await catalogBlock.getByText(/skills\.sh public catalog could not be read/).waitFor({ timeout: 15000 }).then(() => true, () => false);
        check(catalogFailed, "the unreadable catalog is reported as that source's failure" + (catalogFailed ? "" : ": " + (await catalogBlock.innerText()).slice(0, 200)));
        check(await page.locator(".market-card", { hasText: "notes" }).count() > 0, "the harness library still lists its bundle while the other source failed");

        // An empty catalog answer is its own state, never the failure text and never the other source's results.
        await searchBox.fill("no-such-skill");
        const catalogEmpty = await catalogBlock.getByText(/no matching skill/).waitFor({ timeout: 15000 }).then(() => true, () => false);
        check(catalogEmpty, "an empty catalog answer is shown as no match, not as a failure" + (catalogEmpty ? "" : ": " + (await catalogBlock.innerText()).slice(0, 200)));

        // One bad row must not empty the answer: a query mixing a readable repository, an unreadable one and a
        // non-GitHub row still offers the readable hit, and names the other two with their own reasons.
        await searchBox.fill("mixed");
        const goodCard = catalogBlock.locator(".market-card", { hasText: "good" }).first();
        await goodCard.waitFor({ timeout: 15000 });
        check(true, "a readable hit survives an unreadable repository and an unusable row in the same query");
        const mixedNotice = await catalogBlock.innerText();
        check(/owner\/broken: could not be read/.test(mixedNotice), "the unreadable repository is named with its own reason: " + mixedNotice.replace(/\s+/g, " ").slice(0, 200));
        check(/skills\.volces\.com: not a GitHub repository/.test(mixedNotice), "the unusable row is named with its own reason");

        // A catalog hit carries the commit its content was pinned to and installs through the ordinary path.
        await searchBox.fill("curated");
        const curatedCard = catalogBlock.locator(".market-card", { hasText: "curated" }).first();
        await curatedCard.waitFor({ timeout: 15000 });
        check(await catalogBlock.getByText(/aaaa1111bbbb/).count() > 0, "the catalog hit names the commit its content was pinned to");
        await curatedCard.getByRole("button", { name: "Install", exact: true }).click();
        await installNotice(/^Installed curated \(global\)/).waitFor({ timeout: 30000 });
        check(await readFile(join(home, ".agents", "skills", "curated", "SKILL.md"), "utf8").then((text) => text.includes("# Curated")), "the catalog hit installed its whole bundle through the execution-side path");
        const curatedLock = JSON.parse(await readFile(join(home, ".agents", ".skill-lock.json"), "utf8")) as { skills: Record<string, { sourceType: string; ref?: string }> };
        check(curatedLock.skills.curated?.ref === "aaaa1111bbbb2222" && curatedLock.skills.curated?.sourceType === "github", "the catalog installation recorded the pinned commit as its provenance, never a branch");
        await searchBox.fill("");
        await card("notes").waitFor({ timeout: 30000 });

        await card("notes").getByRole("button", { name: "Install", exact: true }).click();
        await installNotice(/^Installed notes \(global\)/).waitFor({ timeout: 30000 });
        const globalNotice = await installNotice(/^Installed notes \(global\)/).innerText();
        check(/reloaded this conversation/.test(globalNotice), "the session's own conversation adopted the installation on its own workspace: " + globalNotice);
        check(await readFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "utf8") === NOTES_V1, "the global installation wrote the bundle bytes into the execution account's own home");
        check(await readFile(join(home, ".agents", "skills", "notes", "REFERENCE.md"), "utf8") === "# Reference\n", "the bundle's other file was installed too");
        check((await readdir(join(root, ".agents", "skills")).catch(() => [])).length === 0, "the workspace was not substituted for the account scope");

        // The outcome survives a list refresh, which is exactly where the previous panel lost it.
        await refresh().click();
        await card("notes").waitFor({ timeout: 30000 });
        check(await installNotice(/^Installed notes \(global\)/).count() > 0, "the install outcome survived the list refresh");

        // The project scope writes into the selected workspace's own directory.
        await scopeOption("project").click();
        await card("project-notes").getByRole("button", { name: "Install", exact: true }).click();
        await installNotice(/^Installed project-notes \(project\)/).waitFor({ timeout: 30000 });
        check(await readFile(join(root, ".agents", "skills", "project-notes", "SKILL.md"), "utf8").then((text) => text.includes("# Project notes")), "the project installation wrote into the selected workspace on the execution host");
        check((await readdir(join(home, ".agents", "skills"))).includes("notes") && !(await readdir(join(home, ".agents", "skills"))).includes("project-notes"), "the project scope did not write into the execution account's own skills");

        // The SSH execution host: selecting it installs onto that host, never into the local account. Under the real
        // sshd transport the remote account is this machine's real login, so the remote host is written at project
        // scope inside the fixture workspace and its real account directories must stay byte-identical.
        await scopeOption(sshScope).click();
        await page.getByRole("button", { name: sshHostLabel, exact: true }).click();
        await page.getByRole("button", { name: "Add skill" }).click();
        await card("notes").waitFor({ timeout: 30000 });
        await card("notes").getByRole("button", { name: "Install", exact: true }).click();
        await installNotice(sshInstallNotice).waitFor({ timeout: 30000 });
        const sshNotice = await installNotice(sshInstallNotice).innerText();
        check(!/reloaded/.test(sshNotice), "a target the session's conversation does not run on names no conversation, so none is claimed to reload: " + sshNotice);
        const sshInstalled = transport === "sshd" ? join(remoteRoot, ".agents", "skills", "notes", "SKILL.md") : join(remoteHome, ".agents", "skills", "notes", "SKILL.md");
        check(await readFile(sshInstalled, "utf8") === NOTES_V1, "the SSH installation wrote the bundle bytes onto the remote host (" + sshInstalled + ")");
        check(await readFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "utf8") === NOTES_V1, "the local account's installation was not rewritten by the remote one");
        if (transport === "sshd") {
          // The remote installation is inside the fixture workspace, and the local account's skills are still only
          // what the earlier scope wrote there.
          check((await readdir(join(remoteRoot, ".agents", "skills"))).includes("notes"), "the remote project installation landed in the remote workspace's own .agents/skills");
        }

        // Back to the local host for the revision and local-content states. Selecting the host clears the add pane, so
        // the installed-skill detail is where the two state questions are read. The local host's own inventory is
        // waited for before a row is chosen: the previous host's list is still on screen until its replacement arrives,
        // and a skill both hosts hold would otherwise be selected on the wrong host. "project-notes" only exists on the
        // selected local workspace, so its appearance is the proof the local list is the one rendered.
        // The remaining assertions are about the local host's global installation, so the destination is returned to
        // global first: the add pane and the detail pane are shown at one scope, and leaving it on project would show
        // the local global installation at a scope it does not belong to.
        await scopeOption("global").click();
        await page.getByRole("button", { name: localHostLabel, exact: true }).click();
        await installedRow("project-notes").waitFor({ timeout: 30000 });
        await installedRow("notes").click();
        // The selected skill's detail is what reports both state questions.
        await page.getByText("Repository revision").first().waitFor({ timeout: 30000 });
        await page.getByText("Up to date").first().waitFor({ timeout: 30000 });
        check(true, "the installed skill reports the repository revision it matches");
        // A newer repository version is the revision question; the directory itself is still the installed content.
        const newer = market.publish({ name: "notes", version: "1.1.0", markdown: NOTES_V2, files: [{ path: "REFERENCE.md", content: "# Reference\n" }] });
        check(newer.ok, "the fixture published a newer bundle version");
        await refresh().click();
        const newerShown = await page.getByText(/A newer version is available: 1\.1\.0/).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        if (!newerShown) {
          const inventory = await (await fetch(backendOrigin + "/api/skill-market/inventory?workspaceId=local", { headers })).json();
          note("inventory after publishing 1.1.0: " + JSON.stringify(inventory));
          note("panel text: " + (await page.locator(".config-detail").innerText()).slice(0, 800));
        }
        check(newerShown, "the panel separates the repository revision from the local content state");

        // A local edit is the other question, and an update keeps a backup of exactly what it replaces.
        await writeFile(join(home, ".agents", "skills", "notes", "REFERENCE.md"), "locally edited\n");
        await refresh().click();
        const modifiedShown = await page.getByText("Locally modified").first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        if (!modifiedShown) {
          const inventory = await (await fetch(backendOrigin + "/api/skill-market/inventory?workspaceId=local", { headers })).json();
          note("inventory after the local edit: " + JSON.stringify(inventory));
          note("panel text: " + (await page.locator(".config-detail").innerText()).slice(0, 600));
        }
        check(modifiedShown, "the panel reports the local modification separately from the available update");
        // A locally modified installation is never replaced on one press: the state is named and the replacement needs
        // a second, explicit confirmation.
        await page.locator(".config-detail").getByRole("button", { name: "Update", exact: true }).click();
        const confirmed = await page.getByText("Replace anyway").first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        if (!confirmed) {
          note("update prompt missing; panel text: " + (await page.locator(".config-detail").innerText()).slice(0, 600));
          const inventory = await (await fetch(backendOrigin + "/api/skill-market/inventory?workspaceId=local", { headers })).json();
          note("inventory after the update press: " + JSON.stringify(inventory));
        }
        check(confirmed, "the panel asked for an explicit confirmation before replacing the local edit");
        await page.getByText("This installed skill has local changes").first().waitFor({ timeout: 30000 });
        check(true, "the confirmation names the local modification it would discard");
        await page.getByRole("button", { name: "Replace anyway" }).click();
        await installNotice(/^Updated notes \(global\)/).waitFor({ timeout: 30000 });
        const updateNotice = await installNotice(/^Updated notes \(global\)/).innerText();
        check(/previous directory was kept at /.test(updateNotice), "the update reported the retained backup: " + updateNotice);
        const backup = /previous directory was kept at (\S+?)(?: and reloaded|;|$)/.exec(updateNotice)?.[1];
        check(backup !== undefined && (await readFile(join(backup, "REFERENCE.md"), "utf8")) === "locally edited\n", "the retained backup holds the locally edited bytes");
        check(await readFile(join(home, ".agents", "skills", "notes", "SKILL.md"), "utf8") === NOTES_V2, "the replacement installed the newer bundle bytes");
        // The outcome survives the refresh the update itself triggered.
        check(await installNotice(/^Updated notes \(global\)/).count() > 0, "the update outcome survived the status refresh");
        check(await page.getByText("Up to date").first().count() > 0, "the refreshed state reports the new version as current");

        // The per-skill switch writes the execution-side document, and the host's own discovery is what reports the
        // new state: the sidebar dot and the detail switch both follow the file, not an optimistic panel state.
        await installedRow("notes").click();
        const notesDocument = join(home, ".agents", "skills", "notes", "SKILL.md");
        check(!(await readFile(notesDocument, "utf8")).includes("disable-model-invocation"), "the installed document starts model-invocable");
        await page.locator(".config-detail").getByRole("switch").first().click();
        await page.getByText(/is now dormant|already in that state/).first().waitFor({ timeout: 30000 });
        const dormantDocument = await readFile(notesDocument, "utf8");
        check(/^disable-model-invocation: true$/m.test(dormantDocument), "the switch wrote the key into the document on the execution host: " + dormantDocument.split("\n").slice(0, 4).join(" | "));
        check(dormantDocument.includes("# Notes v2"), "the switch preserved the rest of the document it edited");
        const dormantLock = JSON.parse(await readFile(join(home, ".agents", ".skill-lock.json"), "utf8")) as { skills: Record<string, { files: Record<string, string>; ref?: string }> };
        check(dormantLock.skills.notes?.ref === "1.1.0", "the switch left the recorded provenance exactly as it was");
        // The baseline is not excused for the edited document: it really differs from what was installed, so the panel
        // reports a local modification, and the file's own bytes are the evidence.
        const modifiedByToggle = await page.getByText("Locally modified").first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        check(modifiedByToggle, "the toggled document reads as a local modification of the installation, because it is one");
        // Switching it back restores the installed bytes exactly, so the edit is reversible through the same seam.
        await page.locator(".config-detail").getByRole("switch").first().click();
        // The document on the host is the observable, not the notice: a notice from the previous press is still on
        // screen, so waiting on text would read the file before the second request had landed.
        const restoredDocument = await waitForText(notesDocument, (text) => !text.includes("disable-model-invocation"), 30000);
        check(restoredDocument !== undefined, "switching back removed the key from the document" + (restoredDocument === undefined ? ": " + (await readFile(notesDocument, "utf8")).split("\n").slice(0, 4).join(" | ") : ""));

        // A GitHub installation records the coordinate and the document path it came from, so the revision question
        // can be asked on demand: the check reaches the repository only because the user pressed it, and its answer
        // names the revision it compared.
        await installedRow("curated").click();
        await page.getByText("Repository revision").first().waitFor({ timeout: 30000 });
        await page.locator(".config-detail").getByRole("button", { name: /check for updates/i }).click();
        const checkNotice = await page.getByText(/up to date at|newer revision/i).first().waitFor({ timeout: 30000 }).then(() => true, () => false);
        if (!checkNotice) note("check notice missing; detail text: " + (await page.locator(".config-detail").innerText()).slice(0, 500));
        check(checkNotice, "the check reported the revision it compared against the repository");

        // A group switch answers each row in its own right: the local host's global group is switched off in one press,
        // and every document of that group carries the key afterwards. A row the host refuses keeps its state and is
        // named, which is why the group's answer is read per directory rather than as one verdict.
        // The group is chosen by its own heading, because more than one group holds a skill whose name contains "notes".
        const globalGroup = page.locator(".config-sidebar-group").filter({ has: page.locator(".config-sidebar-group-label-text", { hasText: /^global$/ }) }).first();
        const groupSkills = ["notes", "curated"];
        const groupDocument = (name: string) => join(home, ".agents", "skills", name, "SKILL.md");
        await globalGroup.locator(".config-sidebar-group-switch .config-switch").click();
        const bulkOn = await Promise.all(groupSkills.map(async (name) => [name, await waitForText(groupDocument(name), (text) => /^disable-model-invocation: true$/m.test(text), 30000)] as const));
        check(bulkOn.every(([, text]) => text !== undefined), "a bulk switch wrote the key into every document of the group: " + bulkOn.map(([name, text]) => name + "=" + (text === undefined)).join(", "));
        check(bulkOn.every(([, text]) => /Take notes|Curated/.test(text ?? "")), "the bulk edit preserved each document's own content");
        // Switching the group back on leaves every document without the key, so the bulk action is symmetric too.
        await globalGroup.locator(".config-sidebar-group-switch .config-switch").click();
        const bulkOff = await Promise.all(groupSkills.map(async (name) => [name, await waitForText(groupDocument(name), (text) => !text.includes("disable-model-invocation"), 30000)] as const));
        check(bulkOff.every(([, text]) => text !== undefined), "switching the group back on removed the key from every document it had written");

        check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));

        // Whatever transport ran, the real account's own resource directories are exactly as they were: nothing here
        // may write into the operator's home, and under the real sshd that is the account every remote call uses.
        const realAfter = await Promise.all(realRoots.map(async (path) => [path, await treeDigest(path)] as const));
        check(JSON.stringify(realBefore) === JSON.stringify(realAfter), "the real account's resource directories are byte-identical to before the run (" + realRoots.join(", ") + ")");
      }
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  failures.push("the smoke threw: " + (error instanceof Error ? error.message : String(error)));
  console.log("  FAIL the smoke threw: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  if (!keep) await rm(base, { recursive: true, force: true });
  else console.log("fixture kept at " + base);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)") + " (" + mode + ")");
for (const failure of failures) console.log("   - " + failure);
for (const noteText of notes) console.log("   note: " + noteText);
exitCode = failures.length === 0 ? 0 : 1;
process.exit(exitCode);
