import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SshGateway, SshInstallServer, WorkspaceRegistry, createSystemSshRunner, managedControlMaster, sshConnectionArgs, sshWorkspaceSeed, type SshProfile } from "../src/index.ts";
import { TERMINAL_RECONNECT_MS } from "../src/terminal.ts";
import { installSshStandIn, sshHost, type SshHost } from "./ssh-binary-standin.ts";

/**
 * The gateway-managed ControlMaster for installation and execution, against a stand-in ssh host: one master keyed on
 * the full connection profile, a gateway-owned socket directory, and a teardown that reaps only what this gateway
 * created. The assertions are the host's own authentication count and the socket files on disk — the transport's
 * public facts — not the argv the gateway happens to build.
 *
 * The transport is `ssh-standin.ts`: the argv the gateway builds, the socket it binds, the answers it reads and the
 * files a publication writes are all real, while the `ssh` binary and the host behind it are not. A real localhost
 * sshd keeps its own coverage in `sshd-fixture.test.ts` and the file-transfer suites; nothing here needs one, a
 * process, a poll or a sleep.
 */

const FILES = [
  { path: "SKILL.md", content: "---\nname: pdf\n---\n# PDF\n", encoding: "utf8" as const },
  { path: "reference.md", content: "# Reference\n", encoding: "utf8" as const },
  { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" as const },
];

/** How many times the host authenticated a client: one per master, none per call that rode one. */
function accepted(host: SshHost): number {
  return host.accepted;
}

/** The profile a test connects with: a full connection profile, and the root a workspace scope installs into. */
function profileOf(root: string): SshProfile {
  return { id: "prod", host: "build.example", port: 2222, identityFile: "/keys/one", knownHostsFile: "/keys/known", remoteRoot: root };
}

/**
 * One stand-in host: the account home a global scope installs into, the profile's root a workspace scope installs into,
 * and the transport that reaches them. `restore` puts the real `ssh` back.
 */
async function hostFixture() {
  const base = await mkdtemp(join(tmpdir(), "hepi-controlmaster-host-"));
  const home = join(base, "remote-home");
  const root = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const host = sshHost();
  const restore = installSshStandIn(host, { home });
  /** End the fixture: put the real transport back first, so a failing case cannot leave it installed. */
  const stop = async (): Promise<void> => {
    restore();
    await rm(base, { recursive: true, force: true });
  };
  return { base, home, root, host, stop };
}

/** The socket directory one gateway owns. */
async function workspace(spaced = false): Promise<{ base: string; directory: string }> {
  const base = await mkdtemp(join(tmpdir(), spaced ? "hepi controlmaster " : "hepi-controlmaster-"));
  return { base, directory: join(base, "ssh-control") };
}

/** The one socket a prepared master hands to its own ssh processes. */
function socketOf(directory: string): Promise<string[]> {
  return readdir(directory);
}

test("a gateway-managed master carries installation and execution through one authentication", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  try {
    const master = managedControlMaster({ directory });
    await master.prepare();
    assert.equal((await stat(directory)).mode & 0o777, 0o700, "the socket directory is private to the gateway account");

    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    const runner = createSystemSshRunner(master);
    const installs = new SshInstallServer({ profiles: [profile], runner, workspaces: registry });
    const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner, workspaces: registry });
    assert.equal(accepted(fixture.host), 0);

    // A publication is several helper calls on the host; one master means one authentication for all of them.
    const published = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "pdf", "SKILL.md"), "utf8"), FILES[0]!.content);
    assert.equal(accepted(fixture.host), 1, "the whole publication authenticated once");
    assert.ok(fixture.host.calls.length > 1, "the publication really was several calls on the host");

    const executed = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "cm-1", command: ["bash", "-c", "echo exec-ok"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.match(executed.ok === true ? executed.stdout : "", /exec-ok/);
    assert.equal(accepted(fixture.host), 1, "execution rode the master the publication created");

    const sockets = await socketOf(directory);
    assert.equal(sockets.length, 1, "one master, keyed on the one profile: " + sockets.join(", "));
    assert.match(sockets[0]!, /^hepi-[0-9a-f]{16}-\d+$/);
    assert.equal((await stat(join(directory, sockets[0]!))).mode & 0o077, 0, "the socket is not reachable by another account");

    await master.close();
    assert.equal(existsSync(join(directory, sockets[0]!)), false, "shutdown removed this gateway's own socket");
    assert.equal(existsSync(directory), false, "and the owned directory it created");
    assert.equal(accepted(fixture.host), 1, "reaping the master opened nothing new");
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("a state directory with a space still carries install and execution through one master", { timeout: 60000 }, async () => {
  // `HEPI_GATEWAY_DATA` is the operator's choice, and a path such as `.../hepi gateway data` is a path like any other.
  const fixture = await hostFixture();
  const { base, directory } = await workspace(true);
  try {
    const master = managedControlMaster({ directory });
    await master.prepare();
    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    const runner = createSystemSshRunner(master);
    const installs = new SshInstallServer({ profiles: [profile], runner, workspaces: registry });
    const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner, workspaces: registry });

    const published = await installs.execute({ workspaceId: "remote-prod", operation: "publishDirectory", scope: "workspace", directory: "pdf", files: FILES });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(await readFile(join(fixture.root, ".agents", "skills", "pdf", "reference.md"), "utf8"), "# Reference\n");
    assert.equal(accepted(fixture.host), 1, "the publication authenticated once through its master");

    const executed = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "cm-spaced", command: ["bash", "-c", "echo exec-ok"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.match(executed.ok === true ? executed.stdout : "", /exec-ok/);
    assert.equal(accepted(fixture.host), 1, "execution rode the master the publication created");

    await master.close();
    assert.equal(existsSync(directory), false, "the spaced directory was this gateway's own and was reaped");
    assert.equal(accepted(fixture.host), 1, "reaping the master opened nothing new");
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("the master is opt-in per runner: a capability composed without it opens its own connection", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  try {
    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    const master = managedControlMaster({ directory });
    await master.prepare();
    const shared = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner: createSystemSshRunner(master), workspaces: registry });
    const plain = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner: createSystemSshRunner(), workspaces: registry });
    const call = (gateway: SshGateway, callId: string) => gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId, command: ["bash", "-c", "true"] });
    assert.equal((await call(shared, "cm-a")).ok, true);
    assert.equal(accepted(fixture.host), 1);
    assert.equal((await call(shared, "cm-b")).ok, true);
    assert.equal(accepted(fixture.host), 1, "the second call reused the master");
    assert.equal((await call(plain, "cm-c")).ok, true);
    assert.equal(accepted(fixture.host), 2, "a runner composed without a master opens a connection of its own");
    await master.close();
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("the managed options are one master per full profile, and a plain runner carries none", () => {
  const master = managedControlMaster({ directory: "/tmp/hepi-control-test" });
  const base = { profile: "prod", host: "build.example" };
  const first = master.argsFor({ ...base, port: 22, identityFile: "/keys/one", knownHostsFile: "/keys/known" });
  const same = master.argsFor({ ...base, port: 22, identityFile: "/keys/one", knownHostsFile: "/keys/known" });
  const otherIdentity = master.argsFor({ ...base, port: 22, identityFile: "/keys/two", knownHostsFile: "/keys/known" });
  const otherKnownHosts = master.argsFor({ ...base, port: 22, identityFile: "/keys/one", knownHostsFile: "/keys/other" });
  const otherPort = master.argsFor({ ...base, port: 2222, identityFile: "/keys/one", knownHostsFile: "/keys/known" });
  const otherProfile = master.argsFor({ ...base, profile: "staging", port: 22, identityFile: "/keys/one", knownHostsFile: "/keys/known" });

  // The socket is its own argv word after `-S`, never a `-o ControlPath=` configuration line: ssh re-parses that
  // word, so a space in the gateway's state directory would end the path there and fail the call before it authenticates.
  const controlPath = (args: readonly string[]) => {
    const index = args.indexOf("-S");
    return index === -1 ? undefined : args[index + 1];
  };
  assert.ok(controlPath(first), "the managed options name a socket");
  assert.deepEqual(same, first, "the same profile is the same master");
  for (const different of [otherIdentity, otherKnownHosts, otherPort, otherProfile]) {
    assert.notEqual(controlPath(different), controlPath(first), "a different profile is a different master: " + different.join(" "));
  }
  assert.deepEqual(first.filter((arg) => arg.startsWith("Control")), ["ControlMaster=auto", "ControlPersist=" + TERMINAL_RECONNECT_MS / 1000]);
  assert.equal(first.some((arg) => arg.includes("ControlPath=")), false, "the socket path is never a re-parsed configuration word");
  assert.equal(first.some((arg) => arg.includes("ControlMaster=no")), false, "the gateway never disables the user's own multiplexing");
  assert.match(controlPath(first)!, /\/tmp\/hepi-control-test\/hepi-[0-9a-f]{16}-\d+$/);

  // A state directory with a space is one argv word, whole, and the same directory is used for reaping.
  const spaced = managedControlMaster({ directory: "/tmp/hepi control test" });
  const spacedArgs = spaced.argsFor({ ...base, port: 22 });
  assert.match(controlPath(spacedArgs)!, /^\/tmp\/hepi control test\/hepi-[0-9a-f]{16}-\d+$/);
  assert.equal(spacedArgs.filter((arg) => arg.includes("/tmp/hepi control test")).length, 1, "one whole path, one word: " + spacedArgs.join(" "));

  // The plain transport is byte-for-byte what it was: no managed option is added behind a caller's back.
  const plain = sshConnectionArgs({ host: "build.example" });
  assert.equal(plain.some((arg) => arg.includes("Control")), false, plain.join(" "));
  assert.deepEqual(plain, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
  assert.equal(sshConnectionArgs({ host: "build.example", port: 2222, identityFile: "/keys/one" }).includes("ControlMaster=auto"), false);
});

test("the managed options go on the short-lived execute spawn, never on a long-lived open session", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  try {
    const master = managedControlMaster({ directory });
    await master.prepare();
    const runner = createSystemSshRunner(master);
    const profile = { profile: "prod", host: "build.example" };
    const opened = runner.open!({ ...profile, cwd: "/srv/app", command: ["sh", "-c", "true"] });
    opened.kill();
    const executed = await runner.execute({ ...profile, cwd: "/srv/app", root: "/srv/app", command: ["true"], signal: new AbortController().signal });
    assert.equal(executed.exitCode, 0);

    // Two processes, in the order they were spawned: the session first, then the one-shot call that rode the master.
    const [session, oneShot] = fixture.host.calls;
    assert.equal(fixture.host.calls.length, 2, fixture.host.calls.map((call) => call.mode).join(", "));
    assert.equal(session!.mode, "open");
    assert.equal(session!.socket, undefined, "a long-lived session carries no master: " + session!.argv.join(" "));
    assert.equal(session!.argv.some((arg) => arg.includes("Control")), false, "a long-lived session carries no control option: " + session!.argv.join(" "));
    assert.equal(oneShot!.mode, "execute");
    assert.equal(oneShot!.argv.includes("ControlMaster=auto"), true, "the execution spawn rides the master: " + oneShot!.argv.join(" "));
    assert.equal(oneShot!.socket !== undefined && oneShot!.socket.startsWith(join(directory, "hepi-")), true, "the socket path is its own argv word: " + oneShot!.argv.join(" "));
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("a missing or wrongly-permissioned socket directory is a reported failure, never a silent fallback", { timeout: 60000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-controlmaster-"));
  try {
    const directory = join(base, "ssh-control");
    const master = managedControlMaster({ directory });
    assert.equal(existsSync(directory), false, "nothing is created until the gateway asks for it");
    await master.prepare();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await master.prepare();
    assert.equal((await stat(directory)).mode & 0o777, 0o700, "preparing twice is the same directory");

    // ssh refuses a ControlPath directory another account can write, and the gateway reports it rather than moving on.
    const wrong = join(base, "shared");
    await mkdir(wrong, { mode: 0o777 });
    await assert.rejects(managedControlMaster({ directory: wrong }).prepare(), /0700|mode|permission/i);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unprepared master fails the call instead of falling back to a direct connection", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  try {
    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    // The directory was never created: ssh cannot bind its socket, and nothing here quietly connects without it.
    const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner: createSystemSshRunner(managedControlMaster({ directory })), workspaces: registry });
    const executed = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "cm-missing", command: ["bash", "-c", "true"] });
    // ssh connects and authenticates before it discovers it cannot bind its own socket, and then exits 255: the call is
    // an unknown outcome, the failure is reported rather than swallowed, and the one attempt is not retried.
    assert.equal(executed.ok, false, JSON.stringify(executed));
    assert.equal(executed.ok === false ? executed.code : "", "outcome-unknown");
    assert.equal(accepted(fixture.host), 1, "the failed call was attempted once and never retried");
    assert.equal(fixture.host.calls.length, 1, "one attempt, not a second connection behind the caller's back");
    assert.equal(existsSync(directory), false, "the gateway did not create the directory behind the caller's back");
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("a foreign socket and a crash residue are left alone, and shutdown reaps only this gateway's master", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  try {
    // The residue of an earlier gateway process, written before this one starts: a socket whose name looks dead.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const foreign = join(directory, "hepi-0000000000000000-1");
    await writeFile(foreign, "");
    const master = managedControlMaster({ directory });
    await master.prepare();
    assert.equal(existsSync(foreign), true, "preparing swept nothing");

    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner: createSystemSshRunner(master), workspaces: registry });
    const executed = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "cm-residue", command: ["bash", "-c", "true"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(accepted(fixture.host), 1, "the live master opened the one connection");
    assert.equal(existsSync(foreign), true, "a dead-looking socket is not deleted on a guess");

    await master.close();
    assert.equal(existsSync(foreign), true, "a socket this gateway did not create is never removed");
    assert.equal(existsSync(directory), true, "the directory stays while it holds something this gateway does not own");
    await rm(foreign, { force: true });
  } finally {
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});

test("the gateway's own ssh is multiplexed while the user's own configuration and master are untouched", { timeout: 60000 }, async () => {
  const fixture = await hostFixture();
  const { base, directory } = await workspace();
  const userDirectory = await mkdtemp(join(tmpdir(), "hepi-user-ssh-"));
  const userSocket = join(userDirectory, "master.sock");
  try {
    // The user's own master, open the way their own ssh opens one: a socket of their own, in their own directory.
    await writeFile(userSocket, "");

    const profile = profileOf(fixture.root);
    const registry = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
    const master = managedControlMaster({ directory });
    await master.prepare();
    const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [profile], allowedCommands: ["bash"], runner: createSystemSshRunner(master), workspaces: registry });
    const executed = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "cm-user", command: ["bash", "-c", "true"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(accepted(fixture.host), 1, "the gateway opened its own connection instead of riding the user's master");
    // The gateway's own ssh never resolves, names or reaches the user's ControlPath: the profile it was given carries no
    // path of the user's, and nothing it spawned mentioned one.
    assert.equal(sshConnectionArgs(profile).some((arg) => arg.includes(userDirectory)), false, "the user's own ssh never resolves the gateway's ControlPath");
    assert.deepEqual(fixture.host.calls.filter((call) => call.argv.some((arg) => arg.includes(userDirectory))), [], "the gateway spawned nothing against the user's master");
    assert.equal(fixture.host.calls.some((call) => call.argv.includes("ControlMaster=no")), false, "the gateway never disables the user's own multiplexing");

    await master.close();
    assert.equal(existsSync(userSocket), true, "reaping the gateway's master left the user's alone");
    assert.equal(existsSync(userDirectory), true, "and the user's own directory");
    assert.equal(existsSync(directory), false, "only the gateway's own directory was removed");
  } finally {
    await rm(userDirectory, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
    await fixture.stop();
  }
});
