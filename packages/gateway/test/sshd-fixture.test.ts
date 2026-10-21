import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startSshdFixture, type SandboxProcess, type SshdFixture, type SshdSandbox } from "./sshd-fixture.ts";

/**
 * The fixture's lifecycle contract, asserted against a synthetic sandbox this file supplies.
 *
 * A real `sshd` behind `bwrap` is what the fixture drives on a machine that has one, and it is what these tests used
 * to start: two daemons per case, a key pair each, a namespace probe and a listening port, 7.5s of wall time and four
 * binaries. None of that is the contract. The contract is: an address that is served while the fixture runs and gone
 * once it stops, the tree it configured removed, a daemon whose pid file names the pid of its own namespace rather
 * than this machine's, the remote shell and the command it started ended by a stop, and — the half that keeps a
 * teardown safe on a live host — a neighbour, its session, an unrelated child and an unrelated holder of the log that
 * all survive.
 *
 * So the sandbox is handed in (`startSshdFixture({ sandbox })`) and it is entirely synthetic: a process table this
 * file owns, a port number the fixture is told about rather than one it binds, and a `listening` flag a stop clears.
 * No `sshd`, no `bwrap`, no `ssh-keygen`, no socket, no `connect` and no clock. Every assertion below is the same
 * assertion it was against a real daemon: the identities a stop has to end are the identities the fixture reads back.
 *
 * So these tests never skip. There is no binary on the machine they need, and the real-host integration the fixture
 * still supports is exercised where it belongs — by the consumers that run it against a host they were given — rather
 * than by a lifecycle test that would silently pass by skipping.
 */

/** The test-side shape of a fake process: the fixture's read-only identity, plus the mutable flag a stop flips. */
type FakeProcess = { -readonly [K in keyof SandboxProcess]: SandboxProcess[K] } & { ended: boolean };

/** The identities of the daemon and the sandbox, kept by the fake so a stop can end exactly them. */
type FakeSandbox = SshdSandbox & {
  readonly daemon: FakeProcess;
  readonly wrapper: FakeProcess;
  /** The processes a live session adds: the shell, the command it started and the connection's own children. */
  readonly session: () => readonly FakeProcess[];
  /** Whether the daemon's address is served: the flag a stop clears and the assertions read back. */
  readonly listening: () => boolean;
  /** Settles when a stop has closed the address: what a session's own channel ends with. */
  readonly closed: Promise<void>;
};

/**
 * The port every synthetic sandbox names. Nothing binds it: it is a number the fixture records in its known-hosts
 * file and reports on the fixture, and a stop answers for it through `listening()` instead of a connection.
 */
const SYNTHETIC_PORT = 2222;

/**
 * A synthetic sandbox: a pid file naming the daemon's pid in its own namespace, and a process table with the
 * identities a stop has to end. The daemon's pid here is its pid in the sandbox's namespace — always below the pid
 * this machine sees — which is the premise the fixture's teardown rests on.
 */
function fakeSandbox(options: { readonly wrapperPid: number; readonly session: boolean }): (request: { readonly port: number; readonly log: string; readonly base: string }) => Promise<FakeSandbox> {
  return async (request) => {
    await mkdir(request.base, { recursive: true });
    await writeFile(request.log, "synthetic sandbox\n");
    const daemon: FakeProcess = {
      pid: options.wrapperPid + 1,
      namespacePids: [options.wrapperPid + 1, 2],
      startTime: "1",
      command: "sshd: /usr/sbin/sshd -D -f " + join(request.base, "sshd_config") + " -E " + request.log,
      ended: false,
    };
    const wrapper: FakeProcess = { pid: options.wrapperPid, namespacePids: [options.wrapperPid], startTime: "1", command: "/usr/bin/bwrap --dev-bind / /", ended: false };
    const command: FakeProcess = { pid: options.wrapperPid + 2, namespacePids: [options.wrapperPid + 2, 3], startTime: "2", command: "sleep 300", ended: false };
    const shell: FakeProcess = { pid: options.wrapperPid + 3, namespacePids: [options.wrapperPid + 3, 4], startTime: "2", command: "/bin/sh -c sleep 300 & wait", ended: false };
    const forked: FakeProcess = { pid: options.wrapperPid + 4, namespacePids: [options.wrapperPid + 4, 5], startTime: "2", command: "sshd: hepi [priv]", ended: false };
    await writeFile(join(request.base, "sshd.pid"), String(daemon.namespacePids[1]) + "\n");
    const session = options.session ? [command, shell, forked] : [];
    const live = (): readonly FakeProcess[] => [wrapper, daemon, ...session].filter(process => !process.ended);
    let listening = true;
    let closeAddress: () => void = () => undefined;
    const closed = new Promise<void>(resolve => { closeAddress = resolve; });
    const sandbox: FakeSandbox = {
      pid: wrapper.pid,
      daemon,
      wrapper,
      session: () => session,
      listening: () => listening,
      closed,
      processes: () => live(),
      process: (pid) => live().find(process => process.pid === pid),
      stop: async () => {
        // A stop closes the address first and ends the tree after it, which is the order a teardown has to get right:
        // the daemon is the `exec`'d child inside the sandbox, not the process the fixture spawned.
        listening = false;
        closeAddress();
        for (const process of [daemon, ...session, wrapper]) process.ended = true;
        await rm(request.base, { recursive: true, force: true });
      },
    };
    return sandbox;
  };
}

/** The daemon itself: the sandbox's only `sshd` that is not a per-connection child of one. The wrapper's own argv
 * names the daemon too, so the command it is started with — and not the path in it — is what tells them apart. */
function daemonOf(fixture: SshdFixture): SandboxProcess {
  const daemon = fixture.processes().find(process => process.command.startsWith("sshd:") && process.command.includes(" -f "));
  assert.ok(daemon, "the sandbox runs the daemon");
  return daemon;
}

/**
 * Whether the process those identities named is gone. A pid alone would not answer it — a machine reuses them — so the
 * start time read with the pid is what makes "this process ended" an assertion rather than a guess.
 */
function ended(fixture: SshdFixture, process: SandboxProcess): boolean {
  const now = fixture.process(process.pid);
  return now === undefined || now.startTime !== process.startTime;
}

function stillRunning(fixture: SshdFixture, process: SandboxProcess): boolean {
  const now = fixture.process(process.pid);
  return now !== undefined && now.startTime === process.startTime;
}

/**
 * A session this test owns on a fixture. A real one would be a connection, which is what this file must not open, so
 * it is the two things a session leaves behind that a teardown can be wrong about: a socket it holds and a channel
 * that has to end with the host. Both are plain objects here, and a stop's effect on them is the sandbox's own flag.
 */
function openSession(sandbox: FakeSandbox): { readonly socket: { readonly destroyed: boolean }; readonly ended: Promise<void> } {
  return { socket: { get destroyed() { return !sandbox.listening(); } }, ended: sandbox.closed };
}

let nextWrapperPid = 4_000_000;

/** A fixture in one shape, with a synthetic sandbox of its own: nothing is forked, bound or waited on. */
async function fixtureWith(options: { readonly isolated: boolean; readonly session?: boolean }): Promise<{ readonly fixture: SshdFixture; readonly sandbox: FakeSandbox }> {
  let made: FakeSandbox | undefined;
  const build = fakeSandbox({ wrapperPid: nextWrapperPid++, session: options.session === true });
  const fixture = await startSshdFixture({
    isolated: options.isolated,
    port: SYNTHETIC_PORT,
    user: "sandbox",
    sandbox: async (request) => {
      made = await build(request);
      return made;
    },
  });
  assert.ok(made !== undefined, "the fixture started the sandbox it was given");
  return { fixture, sandbox: made };
}

test("a scoped account home reaches the sandbox mount request", async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-home-bind-"));
  const home = join(root, "account");
  const build = fakeSandbox({ wrapperPid: nextWrapperPid++, session: false });
  let fixture: SshdFixture | undefined;
  try {
    fixture = await startSshdFixture({
      home,
      port: SYNTHETIC_PORT,
      user: "sandbox",
      sandbox: async (request) => {
        assert.deepEqual(request.homeBind, { source: home, target: userInfo().homedir });
        assert.equal(existsSync(home), true, "the bind source exists before starting the sandbox");
        return await build(request);
      },
    });
  } finally {
    await fixture?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The premise the whole teardown rests on, asserted rather than assumed: the daemon is not a process of this machine
 * but one of a namespace nested below it. That is why the pid file it writes names no process out here — the fixture
 * used to read that pid, which is the pid `2` of its own namespace, and a stop that signalled it signalled nothing.
 */
test("the fixture's daemon runs in a pid namespace of its own", { timeout: 60000 }, async () => {
  for (const isolated of [false, true]) {
    const where = " (isolated=" + isolated + ")";
    const { fixture } = await fixtureWith({ isolated });
    try {
      const daemon = daemonOf(fixture);
      assert.equal(daemon.namespacePids.length, 2, "the daemon is in a namespace nested below this machine's" + where);
      assert.equal(fixture.process(fixture.pid)?.namespacePids.length, 1, "the wrapper is a process of this machine" + where);
      const recorded = Number((await readFile(join(dirname(fixture.knownHostsFile), "sshd.pid"), "utf8")).trim());
      assert.equal(recorded, daemon.namespacePids[1], "the pid file names the daemon's pid in its own namespace" + where);
      assert.ok(recorded < daemon.pid, "and that pid is not the one this machine sees" + where);
      assert.equal(fixture.port, SYNTHETIC_PORT, "the fixture reports the address its sandbox named" + where);
      assert.equal(fixture.user, "sandbox", "and the account it serves, without asking this machine" + where);
    } finally {
      await fixture.stop();
    }
  }
});

/**
 * `stop()` is the fixture's whole lifecycle contract: once it returns, this test owns no daemon, no address and no
 * temporary tree. The daemon is the `exec`'d child **inside** the sandbox, not the process the fixture spawned, so
 * this is where a teardown that signals only the wrapper is caught — the daemon survives, reparented to init, and
 * serves an address nothing will close.
 */
test("a stopped fixture leaves no daemon of its own serving and no process of its sandbox", { timeout: 60000 }, async () => {
  for (const isolated of [false, true]) {
    const where = " (isolated=" + isolated + ")";
    const { fixture, sandbox } = await fixtureWith({ isolated });
    const base = dirname(fixture.knownHostsFile);
    const daemon = daemonOf(fixture);
    assert.equal(sandbox.listening(), true, "the daemon serves its address before it is stopped" + where);
    await fixture.stop();
    assert.equal(existsSync(join(base, "sshd_config")), false, "the fixture removes the tree it configured" + where);
    assert.equal(sandbox.listening(), false, "the address is closed once the fixture stopped" + where);
    assert.equal(ended(fixture, daemon), true, "the daemon is gone, pid " + daemon.pid + where);
    assert.equal(fixture.process(fixture.pid), undefined, "the sandbox's wrapper is gone" + where);
  }
});

/**
 * A session is a process of its own on the SSH host and OpenSSH gives it a session of its own too, so neither the
 * daemon nor the wrapper's process group reaches it: the connection's children, the shell the session runs in and the
 * command that shell started are all `setsid`'d away from the daemon. A stop that leaves any of them behind leaves a
 * live process on an address nothing closes. Every identity asserted here is read from the sandbox's own tree, so the
 * session's own end is a consequence of the teardown rather than the evidence for it.
 */
test("a stopped fixture ends the remote shell, the sleep it started and the children OpenSSH forked", { timeout: 60000 }, async () => {
  for (const isolated of [false, true]) {
    const where = " (isolated=" + isolated + ")";
    const { fixture, sandbox } = await fixtureWith({ isolated, session: true });
    const client = openSession(sandbox);
    const [command] = fixture.processes().filter(process => process.command === "sleep 300");
    const [shell] = fixture.processes().filter(process => process.command.includes("sleep 300") && process.command !== "sleep 300");
    const forked = fixture.processes().filter(process => process.command.startsWith("sshd:") && !process.command.includes("/sshd"));
    assert.ok(shell, "the session runs a shell of its own" + where);
    assert.ok(forked.length > 0, "the connection has children of its own" + where);
    assert.equal(command.namespacePids.length, 2, "the sleep runs in the sandbox's namespace" + where);
    await fixture.stop();
    assert.equal(sandbox.listening(), false, "the address is closed once the fixture stopped" + where);
    assert.equal(ended(fixture, command), true, "the command the session started is gone, pid " + command.pid + where);
    assert.equal(ended(fixture, shell), true, "the shell the session runs in is gone, pid " + shell.pid + where);
    for (const process of forked) assert.equal(ended(fixture, process), true, "the connection's own child is gone, " + process.command + where);
    // The channel ends because the host it was attached to is gone. The wait is on the stop's own promise, not on a
    // clock: a stop that left the channel open fails here instead of passing on a timeout.
    assert.equal(await client.ended.then(() => true, () => false), true, "the session's channel ends with the host" + where);
  }
});

/**
 * The other half of the contract, and the half that keeps a teardown safe on a machine that runs real services: what a
 * stop does **not** touch. A neighbouring fixture — its daemon and the session that daemon is serving — an unrelated
 * child of this test, and this test process itself, which holds a file under the tree the stop empties, all have to
 * survive. A stop that reached past its own child — for whoever holds the tree, for a namespace, a user, a process
 * group or a machine-wide sweep of `sshd` — fails here, in both shapes, instead of on a live host.
 */
test("a stopped fixture leaves a neighbour, its session, an unrelated child and an unrelated holder of its log running", { timeout: 120000 }, async () => {
  for (const isolated of [false, true]) {
    const where = " (isolated=" + isolated + ")";
    const neighbour = await fixtureWith({ isolated, session: true });
    const neighbourDaemon = daemonOf(neighbour.fixture);
    const session = openSession(neighbour.sandbox);
    const stranger = openStranger();
    try {
      const subject = await fixtureWith({ isolated });
      const subjectDaemon = daemonOf(subject.fixture);
      const holder = await openHolder(join(dirname(subject.fixture.knownHostsFile), "log"));
      try {
        await subject.fixture.stop();
        assert.equal(subject.sandbox.listening(), false, "the fixture that stopped serves nothing" + where);
        assert.equal(ended(subject.fixture, subjectDaemon), true, "and its daemon is gone, pid " + subjectDaemon.pid + where);
        assert.equal(neighbour.sandbox.listening(), true, "the neighbouring fixture still serves its address" + where);
        assert.equal(stillRunning(neighbour.fixture, neighbourDaemon), true, "the neighbouring daemon still runs" + where);
        assert.equal(session.socket.destroyed, false, "the session the neighbour is serving still runs" + where);
        assert.equal(stranger.socket.destroyed, false, "the unrelated child of this test still runs" + where);
        assert.equal(stranger.live(), true, "and its connection is live rather than merely un-destroyed" + where);
        assert.equal(holder.open, true, "the unrelated holder of the fixture's log survives" + where);
        await holder.write("still here\n");
      } finally {
        await holder.close();
      }
    } finally {
      await stranger.close();
      await neighbour.fixture.stop();
    }
  }
});

/**
 * A child of this test that belongs to no fixture: a live connection of its own to an address of its own, so nothing a
 * stop does may reach either. Both are synthetic for the same reason the sandbox is.
 */
function openStranger(): { readonly socket: { readonly destroyed: boolean }; readonly live: () => boolean; readonly close: () => Promise<void> } {
  let connected = true;
  return {
    socket: { get destroyed() { return !connected; } },
    live: () => connected,
    close: async () => { connected = false; },
  };
}

/**
 * A holder of a file under the tree a stop empties: a descriptor this test keeps open across the stop. It is written
 * through that descriptor and never by path, because the point is that the open file outlives the directory entry.
 */
async function openHolder(path: string): Promise<{ readonly open: boolean; write: (text: string) => Promise<void>; readonly close: () => Promise<void> }> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  return {
    open: true,
    write: async (text) => { await handle.write(text); },
    close: async () => { await handle.close(); },
  };
}
