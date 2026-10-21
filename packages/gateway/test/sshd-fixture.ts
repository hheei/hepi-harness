import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const SSHD_BINARIES = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"];
const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const BWRAP = "/usr/bin/bwrap";

export type SshdFixture = {
  /** The host a client names: `<account>@127.0.0.1`, exactly as the smoke scripts configure it. */
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  /** A directory that exists on the SSH host, for a root or a folder to be chosen from. */
  readonly root: string;
  /**
   * True when the daemon runs inside a mount namespace of its own, so `root` exists on the SSH host and **not** on
   * the machine the test itself runs on. A test that needs "a path only the remote host has" reads this, and is what
   * tells an execution-host resolution apart from one done on the gateway's own machine.
   */
  readonly isolated: boolean;
  /** The daemon's own log on this machine, which is where an authentication it accepted is recorded. */
  readonly logFile: string;
  /** The process this fixture spawned — the sandbox wrapper, and the only process `stop` ever signals. */
  readonly pid: number;
  /** The sandbox's own processes, read when this is called: what a stop has to end, and nothing outside it. */
  processes(): readonly SandboxProcess[];
  /** One process of the sandbox by the pid this machine sees, or `undefined` once it is gone. */
  process(pid: number): SandboxProcess | undefined;
  stop(): Promise<void>;
};

/**
 * What a sandbox is asked for: the daemon's own port, config, log and root, and the tree the fixture wrote them into.
 * Everything a real `bwrap` + `sshd` needs to start is here, so a caller can supply a sandbox of its own — a
 * deterministic one — without the fixture reaching for a binary, a key or a namespace.
 */
export type SshdSandboxRequest = {
  readonly port: number;
  readonly config: string;
  readonly log: string;
  readonly root: string;
  readonly isolatedMount: string | undefined;
  readonly homeBind?: { readonly source: string; readonly target: string };
  readonly base: string;
};

/**
 * The one child a fixture owns, and everything the fixture needs from it: the process tree it can read, and a stop that
 * ends that tree and nothing else. The default is the `bwrap` sandbox below; a test can hand in its own.
 */
export type SshdSandbox = {
  /** The sandbox's pid 1 — the wrapper, and the only process a stop signals. */
  readonly pid: number;
  processes(): readonly SandboxProcess[];
  process(pid: number): SandboxProcess | undefined;
  /** End the sandbox and every process below it. Nothing outside it is signalled. */
  stop(): Promise<void>;
};

export type StartSshdFixtureOptions = {
  root?: string;
  profileRoot?: string;
  isolated?: boolean;
  home?: string;
  /**
   * The sandbox to run the daemon in. The default starts a real `sshd` under `bwrap`; a deterministic stand-in takes
   * the same request and answers the same contract, so a test of the fixture's lifecycle needs no binary at all.
   */
  sandbox?: (request: SshdSandboxRequest) => Promise<SshdSandbox>;
  /**
   * The port the fixture's address names. Only meaningful with a supplied sandbox: a real `sshd` needs a port the
   * kernel has confirmed is free, while a deterministic one names its own address, so the fixture must not bind a
   * probe port to find one.
   */
  port?: number;
  /** The account the fixture's address names. Only meaningful with a supplied sandbox: no `id` is spawned to ask. */
  user?: string;
};

/**
 * One process of a fixture's sandbox, read from `/proc` without signalling anything: a test names what a stop has to
 * end by these identities, so it asserts on the sandbox's own processes rather than on a client that may exit for a
 * reason of its own.
 */
export type SandboxProcess = {
  /** The pid this machine sees. */
  readonly pid: number;
  /**
   * The `NSpid` field: the pid in this machine's namespace, then the pid in each namespace below it. Two entries mean
   * the process really runs in a pid namespace nested under this one — the sandbox's own — and the last entry is the
   * pid that namespace gives it. It is why a pid file written inside the sandbox names no process out here.
   */
  readonly namespacePids: readonly number[];
  /** `/proc/<pid>/stat` field 22: a pid reused after a stop carries a different start time. */
  readonly startTime: string;
  readonly command: string;
};

/**
 * Every shape of the fixture runs the daemon inside this sandbox: a pid namespace of its own, mounted `/proc`, and a
 * private `/run` holding the privilege-separation directory sshd refuses to start without. `--die-with-parent` ties
 * the sandbox's life to this test, so a run that is killed outright leaves nothing behind either.
 *
 * The network namespace stays the machine's — no `--unshare-net` — because a client has to reach the daemon on
 * loopback, and the sandbox's pid 1 stays bwrap's reaper — no `--as-pid-1` — because that reaper is what turns the
 * death of one process this test owns into the death of everything the daemon forked.
 *
 * `isolatedMount` adds the tmpfs that gives the daemon a filesystem of its own, so its root is a path this machine
 * does not have; without it the sandbox shares this machine's filesystem, which is the ordinary "localhost SSH host"
 * shape the gateway tests use for everything that does not need a remote-only path.
 */
function sandboxArguments(isolatedMount?: string, homeBind?: { readonly source: string; readonly target: string }): string[] {
  return [
    "--dev-bind", "/", "/",
    "--unshare-pid",
    "--proc", "/proc",
    "--die-with-parent",
    "--tmpfs", "/run",
    "--dir", "/run/sshd",
    ...(isolatedMount === undefined ? [] : ["--tmpfs", isolatedMount]),
    // A caller that scopes the account home gets a private directory mounted at the account's own home path. The
    // daemon and everything it runs still report the passwd entry's home, so a write the host performs lands in the
    // caller's directory: a fixture can exercise the account's own `.pi/agent` without touching the real one.
    ...(homeBind === undefined ? [] : ["--bind", homeBind.source, homeBind.target]),
  ];
}

function sshdBinary(): string | undefined {
  return SSHD_BINARIES.find(candidate => existsSync(candidate));
}

let sandboxSupport: boolean | undefined;

/**
 * Whether this machine can run the fixture at all. The binaries are not the question: a `bwrap` that exists but
 * cannot unshare a pid namespace would start a sandbox that *looks* fine and then leave a daemon behind, so this
 * really starts one and asks whether it ran.
 */
export function sshdAvailable(): boolean {
  if (sandboxSupport === undefined) sandboxSupport = probeSandbox();
  return sshdBinary() !== undefined && existsSync(SSH_KEYGEN) && sandboxSupport;
}

/**
 * The reason to skip these tests, or `false` to run them. `HEPI_REQUIRE_SSH_SMOKE=1` names a machine that has the
 * prerequisites, so a missing one fails there — with `startSshdFixture`'s own assertion — instead of quietly
 * skipping the coverage.
 */
export function sshdFixtureSkip(options: { readonly sandbox?: boolean } = {}): false | string {
  // A test that supplies its own sandbox needs none of the binaries, so there is nothing to skip for.
  if (options.sandbox === true) return false;
  if (sshdAvailable()) return false;
  if (process.env.HEPI_REQUIRE_SSH_SMOKE === "1") return false;
  return "no sshd, ssh-keygen and bwrap sandbox on this machine";
}

function probeSandbox(): boolean {
  if (!existsSync(BWRAP)) return false;
  const probe = mkdtempSync(join(tmpdir(), "hepi-sshd-probe-"));
  try {
    const mount = join(probe, "mount");
    mkdirSync(mount, { recursive: true });
    execFileSync(BWRAP, [...sandboxArguments(mount), "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Read-only: the process a pid names, or `undefined` once it is gone. Nothing here signals anything, and nothing reads
 * the machine at large.
 */
export function sandboxProcess(pid: number): SandboxProcess | undefined {
  try {
    const status = readFileSync("/proc/" + pid + "/status", "utf8");
    const namespace = /^NSpid:\s+(.+)$/m.exec(status);
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      namespacePids: (namespace?.[1] ?? String(pid)).trim().split(/\s+/).map(Number),
      startTime: fields[19],
      command: readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").join(" ").trim(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Read-only: every process the fixture's sandbox owns, walked from the wrapper's own children — the daemon, the
 * children OpenSSH forks per connection, and the shells and commands those children `setsid` into a session of their
 * own. The walk never leaves this fixture's own subtree, and it is why a test can name a remote command's process
 * without scanning the machine for it.
 */
export function sandboxProcesses(wrapperPid: number): SandboxProcess[] {
  const processes: SandboxProcess[] = [];
  const queue = [wrapperPid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    if (processes.some(process => process.pid === pid)) continue;
    const process = sandboxProcess(pid);
    if (process === undefined) continue;
    processes.push(process);
    queue.push(...childPids(pid));
  }
  return processes;
}

/**
 * The process this machine sees for a pid a command **inside** the sandbox reported. A remote shell's `$$` is a pid of
 * the sandbox's own namespace, so a test that asks whether that shell is still running has to map it through here —
 * a namespace pid on this machine names something else, or nothing at all.
 */
export function sandboxProcessByNamespacePid(wrapperPid: number, namespacePid: number): SandboxProcess | undefined {
  return sandboxProcesses(wrapperPid).find(process => process.namespacePids.length > 1 && process.namespacePids[process.namespacePids.length - 1] === namespacePid);
}

function childPids(pid: number): number[] {
  const children: number[] = [];
  for (const task of readdirSync("/proc/" + pid + "/task")) {
    try {
      const listed = readFileSync("/proc/" + pid + "/task/" + task + "/children", "utf8");
      children.push(...listed.trim().split(/\s+/).filter(Boolean).map(Number));
    } catch {
      // A task that ended between the readdir and the read has no children to add.
    }
  }
  return children;
}

/**
 * Wait until the daemon really accepts a connection on its address. A probe that only *binds* the port answers before
 * the daemon has bound it — the port is free until then — so the wait has to connect, and a daemon that never listens
 * is reported as a failure rather than left to the first client's own refused connection.
 */
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>(resolve => {
      const probe = connect(port, host);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => { probe.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error("the fixture sshd never listened on " + host + ":" + port);
}

/**
 * A real OpenSSH daemon on loopback, owned by this test: its own host key and user key, a known-hosts file written
 * from the generated host key, an absolute AuthorizedKeysFile, `AllowUsers <this user>`, `StrictModes no` and an
 * ephemeral port. The same shape `packages/client/scripts/smoke-pack.mjs` uses for its SSH check, so a test that
 * drives the packaged gateway and a test that drives the library run against the same kind of host. No mock runner
 * stands in for the transport: the remote helper really runs on the far side of a real SSH connection.
 *
 * The daemon runs in the sandbox `sandboxArguments` describes, so this fixture's whole process tree is reachable
 * through the one process it spawned. `isolated` adds a private tmpfs and creates the root inside it, which gives the
 * host a path this machine does not have — the shape a test of remote-only resolution needs.
 */
export async function startSshdFixture(options: StartSshdFixtureOptions = {}): Promise<SshdFixture> {
  // A supplied sandbox is the whole reason to skip nothing: the binaries and the namespace probe below are what the
  // default sandbox needs, and a deterministic one needs neither.
  const sandbox = options.sandbox;
  const sshdBin = sandbox === undefined ? sshdBinary() : "/usr/sbin/sshd";
  if (sandbox === undefined) {
    assert.ok(sshdBin, "the SSH fixture needs an sshd binary at " + SSHD_BINARIES.join(" or "));
    assert.ok(existsSync(SSH_KEYGEN), "the SSH fixture needs " + SSH_KEYGEN);
    assert.ok(sshdAvailable(), "the SSH fixture needs a bwrap that can run a process in a pid namespace of its own (" + BWRAP + ")");
  }
  const isolated = options.isolated === true;
  const base = await mkdtemp(join(tmpdir(), "hepi-sshd-"));
  if (sandbox === undefined) {
    await run(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", join(base, "hostkey")]);
    await run(SSH_KEYGEN, ["-q", "-t", "ed25519", "-N", "", "-f", join(base, "userkey")]);
    await writeFile(join(base, "authorized_keys"), await readFile(join(base, "userkey.pub"), "utf8"));
    await chmod(join(base, "authorized_keys"), 0o600);
  }
  // A supplied sandbox names the account it serves, so the fixture spawns nothing to discover it.
  const user = options.user ?? (await run("id", ["-un"])).stdout.trim();
  // A supplied sandbox pins its own host key, so the known-hosts file is written from that key rather than generated.
  const hostPublic = sandbox === undefined
    ? (await readFile(join(base, "hostkey.pub"), "utf8")).trim()
    : "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFIx0dXUr3edZQ0z9gNWZzc0M2JhcmUtc2FuZGJveC1ob3N0 a-deterministic-host-key";
  // Same for the address: a supplied sandbox already knows which port it listens on, and binding a probe to pick one
  // would be the local dependency this seam exists to avoid.
  const port = options.port ?? await freePort();
  await writeFile(join(base, "known_hosts"), "[" + "127.0.0.1" + "]:" + port + " " + hostPublic + "\n");
  await writeFile(join(base, "sshd_config"), [
    "Port " + port,
    "ListenAddress 127.0.0.1",
    "HostKey " + join(base, "hostkey"),
    "PidFile " + join(base, "sshd.pid"),
    "AuthorizedKeysFile " + join(base, "authorized_keys"),
    "StrictModes no",
    "UsePAM no",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "",
  ].join("\n"));
  const config = join(base, "sshd_config");
  const log = join(base, "log");
  // The mount point itself is an empty directory here; under the sandbox's tmpfs the root exists only on that host.
  const mount = join(base, "remote-filesystem");
  if (isolated) await mkdir(mount, { recursive: true });
  // The scoped home is a real directory this machine holds and the sandbox mounts over the account's home, so it must
  // be a directory of its own and never the account's own home, which would make the bind a no-op.
  const homeBind = options.home === undefined ? undefined : { source: resolve(options.home), target: userInfo().homedir };
  if (homeBind !== undefined) {
    assert.ok(homeBind.source.startsWith("/"), "a scoped home must be an absolute path");
    assert.notEqual(homeBind.source, homeBind.target, "a scoped home must not be the account's own home");
    await mkdir(homeBind.source, { recursive: true });
  }
  const root = options.root ?? (isolated ? join(mount, "remote-root") : join(base, "remote-root"));
  if (isolated) assert.ok(root.startsWith(mount + "/"), "an isolated fixture's root must live inside its mount");
  const request: SshdSandboxRequest = { port, config, log, root, isolatedMount: isolated ? mount : undefined, ...(homeBind === undefined ? {} : { homeBind }), base };
  let started: { readonly sandbox: SshdSandbox; readonly failed: Promise<never> } | undefined;
  try {
    started = sandbox === undefined ? await bwrapSandbox(request, sshdBin) : { sandbox: await sandbox(request), failed: new Promise<never>(() => undefined) };
    // Only a real daemon has to be waited for: it binds its port asynchronously, so a start that returns early would
    // race the first client. A supplied sandbox reports itself started, and probing its port would mean connecting.
    if (sandbox === undefined) await Promise.race([waitForTcp("127.0.0.1", port, 15_000), started.failed]);
  } catch (error) {
    // A start that never listened still owns whatever it spawned, so it is torn down the way a stopped fixture is.
    if (started !== undefined) await started.sandbox.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    throw error;
  }
  assert.ok(started !== undefined, "the fixture started its sandbox");
  const { sandbox: running } = started;
  return {
    host: user + "@127.0.0.1",
    port,
    user,
    identityFile: join(base, "userkey"),
    knownHostsFile: join(base, "known_hosts"),
    root,
    isolated,
    logFile: log,
    pid: running.pid,
    processes: () => running.processes(),
    process: (pid) => running.process(pid),
    stop: async () => { await running.stop(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); },
  };
}

/**
 * The default sandbox: one `bwrap` child whose pid 1 is the reaper, running the real daemon. The fixture only ever
 * signals that child, and the kernel's namespace is what ends everything the daemon forked.
 */
async function bwrapSandbox(request: SshdSandboxRequest, sshdBin: string | undefined): Promise<{ readonly sandbox: SshdSandbox; readonly failed: Promise<never> }> {
  const command = "mkdir -p " + shellWord(request.root) + " && exec " + shellWord(sshdBin!) + " -D -f " + shellWord(request.config) + " -E " + shellWord(request.log);
  const child = spawn(BWRAP, [...sandboxArguments(request.isolatedMount, request.homeBind), "/bin/sh", "-c", command], { stdio: "ignore" });
  const wrapperPid = child.pid;
  assert.ok(wrapperPid !== undefined, "the fixture's sandbox has a pid");
  const failed = new Promise<never>((_, reject) => child.once("exit", (code, signal) => {
    void readFile(request.log, "utf8").catch(() => "no sshd log").then(text => reject(new Error("sshd exited before accepting a connection (code " + code + ", signal " + signal + "): " + text.trim())));
  }));
  // A start that listened is not a failure, and the exit that follows a stop is expected: only the race above reads it.
  void failed.catch(() => undefined);
  return {
    sandbox: {
      pid: wrapperPid,
      processes: () => sandboxProcesses(wrapperPid),
      process: pid => sandboxProcess(pid),
      stop: async () => release(request.base, child),
    },
    failed,
  };
}

/**
 * The fixture's whole teardown, used by stop() and by a start that failed. The one process signalled is this fixture's
 * own child: the sandbox's pid 1 and its reaper, whose death the kernel answers by killing every process in the
 * namespace — the daemon, the children OpenSSH forked per connection, and the sessions those children `setsid` out of
 * the daemon's reach. Nothing else on the machine is signalled, nothing is searched for, and the tree goes once that
 * child has exited.
 */
async function release(base: string, child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => { child.once("exit", () => { resolve(); }); });
    child.kill("SIGKILL");
    await Promise.race([exited, delay(5_000).then(() => { throw new Error("the fixture's sandbox did not exit after SIGKILL"); })]);
  }
  await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
}

/** One argv word for the fixture's own bootstrap shell. */
function shellWord(value: string): string {
  return "'" + value.replaceAll("'", "'" + "'\"'" + "'") + "'";
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}
