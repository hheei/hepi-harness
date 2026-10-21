/**
 * The credential store a native acceptance run owns, and the environment that makes it owned.
 *
 * What this protects is one concrete, already-happened failure: ticket 16's native driver inherited the developer's
 * `DBUS_SESSION_BUS_ADDRESS`, so the shell's `--configure` and `--forget` wrote and deleted `dev.hepi.app/connection` in
 * the **real** user's keyring. The isolation is entirely a property of the environment handed to the shell process, so
 * that mapping is asserted here as a pure function — deterministically, on any host, with no daemon started — and the
 * running sandbox is exercised only where the Secret Service toolchain exists, which is the same precondition the native
 * driver has.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONNECTION_ATTRIBUTES, loginKeyringDigest, mountPointsUnder, packagedEnvironment, releaseMountsUnder, releaseTree, sandboxEnvironment, startCredentialSandbox } from "./lib/credential-sandbox.mjs";

/** A developer's running session, as its own child processes see it. */
const SESSION_POINTER = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/dev",
  XDG_RUNTIME_DIR: "/run/user/1000",
  XDG_CONFIG_HOME: "/home/dev/.config",
  XDG_DATA_HOME: "/home/dev/.local/share",
  XDG_CACHE_HOME: "/home/dev/.cache",
  XDG_STATE_HOME: "/home/dev/.local/state",
  TMPDIR: "/home/dev/tmp",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  DBUS_SYSTEM_BUS_ADDRESS: "unix:path=/run/dbus/system_bus_socket",
  GNOME_KEYRING_CONTROL: "/run/user/1000/keyring",
  GNOME_KEYRING_PID: "1413",
  DISPLAY: ":0",
};

const sandbox = sandboxEnvironment({ base: SESSION_POINTER, directory: "/run/owned", busAddress: "unix:path=/run/owned/bus" });

test("every pointer to a session's own credential store is replaced by this run's directory", () => {
  assert.equal(sandbox.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/owned/bus", "the bus the Secret Service is reached through");
  assert.equal(sandbox.HOME, "/run/owned/home", "where a keyring file is created and read");
  assert.equal(sandbox.XDG_RUNTIME_DIR, "/run/owned/runtime");
  assert.equal(sandbox.TMPDIR, "/run/owned/tmp");
  // The XDG data/config/cache/state homes are replaced too: gnome-keyring resolves its keyring directory from them, so a
  // run that redirected only HOME could still be handed the developer's store by an explicit XDG_DATA_HOME.
  assert.equal(sandbox.XDG_DATA_HOME, "/run/owned/home/.local/share");
  assert.equal(sandbox.XDG_CONFIG_HOME, "/run/owned/home/.config");
  assert.equal(sandbox.XDG_CACHE_HOME, "/run/owned/home/.cache");
  assert.equal(sandbox.XDG_STATE_HOME, "/run/owned/home/.local/state");
  // Nothing that names a session pointer survives anywhere in the environment a shell process would receive.
  for (const [name, value] of Object.entries(sandbox)) {
    if (typeof value !== "string") continue;
    assert.ok(!value.includes("/run/user/1000"), name + " still points at the developer's runtime directory: " + value);
    assert.ok(!value.includes("/home/dev"), name + " still points at the developer's home: " + value);
  }
});

test("a keyring control socket of the running session is removed, not overridden", () => {
  // A daemon's control socket is consulted before the bus address by some clients, and an empty value is a different
  // statement from an absent one — so these are deleted outright rather than set to "".
  assert.ok(!("GNOME_KEYRING_CONTROL" in sandbox), "GNOME_KEYRING_CONTROL would name the developer's daemon");
  assert.ok(!("GNOME_KEYRING_PID" in sandbox), "GNOME_KEYRING_PID would name the developer's process");
});

test("what is not a credential path passes through untouched", () => {
  // The driver owns its X display and the platform needs PATH; withholding those would break the window, not the store.
  // A system bus is not the session's credential store either, so it stays as the host states it.
  assert.equal(sandbox.PATH, "/usr/bin:/bin");
  assert.equal(sandbox.DISPLAY, ":0");
  assert.equal(sandbox.DBUS_SYSTEM_BUS_ADDRESS, SESSION_POINTER.DBUS_SYSTEM_BUS_ADDRESS);
});

test("an absent keyring is stated as absent, not as an unchanged empty digest", () => {
  // The driver compares this digest before and after to prove the developer's store was never written to. A host with no
  // login keyring must read as "no file" rather than as the digest of an empty one, or the comparison would pass for a
  // store that did not exist and hide one that appeared mid-run.
  assert.equal(loginKeyringDigest({ HOME: "" }), null);
  assert.equal(loginKeyringDigest({ HOME: "/nonexistent-home-for-this-check" }), null);
  assert.equal(loginKeyringDigest({}), null, "no HOME at all states no keyring");
});

test("the entry the App files its connection under is the pair the shell writes", () => {
  // These two names are what a store write is keyed by; a drift here would have a run search for an entry the shell never
  // wrote and read "nothing stored" for a connection that was. They mirror KEYRING_SERVICE and CONNECTION_ENTRY in
  // apps/app/src-tauri/src/main.rs.
  assert.deepEqual(CONNECTION_ATTRIBUTES, { service: "dev.hepi.app", username: "connection" });
});

test("no packaged credential process is started without this run's own store", () => {
  // The failure this refuses already happened in the other direction: a driver whose store failed to start kept an
  // **empty** environment and still ran `--forget`, and an empty environment is not an isolated one — with no
  // DBUS_SESSION_BUS_ADDRESS the Secret Service library goes on to try `/run/user/<uid>/bus`, the developer's running
  // keyring. So "the store is missing" has to be a refusal that stops the run, not a smaller environment.
  for (const missing of [undefined, null]) {
    assert.throws(() => packagedEnvironment(missing), /no credential store was started/, "a run with no store cannot spawn a packaged credential process");
  }
  // A store whose own env does not name its bus is the same danger by another route (a caller that built the environment
  // by hand, or a future refactor that loses one field).
  assert.throws(
    () => packagedEnvironment({ busAddress: "unix:path=/run/owned/bus", env: {} }),
    /no session bus at all/, "an environment without this run's bus address is refused");
  assert.throws(
    () => packagedEnvironment({ busAddress: "unix:path=/run/owned/bus", env: { DBUS_SESSION_BUS_ADDRESS: SESSION_POINTER.DBUS_SESSION_BUS_ADDRESS } }),
    /\/run\/user\/1000/, "and one that names somebody else's bus is refused, with the address it actually held");
  // The refusal names the hazard so a reader of a failed run's log understands why nothing ran.
  assert.throws(() => packagedEnvironment(null), /run\/user/, "the message states the ambient bus an empty environment would reach");
});

test("packagedEnvironment hands over exactly the private store plus the driver's own additions", () => {
  const store = { busAddress: "unix:path=/run/owned/bus", env: sandboxEnvironment({ base: SESSION_POINTER, directory: "/run/owned", busAddress: "unix:path=/run/owned/bus" }) };
  const given = packagedEnvironment(store, { DISPLAY: ":71", GDK_BACKEND: "x11" });
  assert.equal(given.DBUS_SESSION_BUS_ADDRESS, store.busAddress, "the child reaches this run's bus");
  assert.equal(given.DISPLAY, ":71", "the driver's own display passes through");
  assert.ok(!("GNOME_KEYRING_CONTROL" in given), "and no session keyring control socket is added back by the merge");
  for (const value of Object.values(given)) {
    if (typeof value !== "string") continue;
    assert.ok(!value.includes("/run/user/1000") && !value.includes("/home/dev"), "nothing names the developer's session: " + value);
  }
});

test("neither native driver keeps an empty-environment fallback or starts its store before its cleanup is registered", () => {
  // The two seams the reviewer found: an artifact run that swallowed a store-start failure into `shellEnv = {}`, and a
  // native run that took a display and a whole stack before it owned any cleanup. Both are shape properties of the
  // drivers, asserted against their source because the failure only happens on a host where a tool is missing — and a
  // broken run must then touch no credential store at all rather than the developer's.
  const drivers = [
    // The artifact journey's implementation, not its operational entry point: `verify-artifacts.mjs` resolves flags and
    // exits, and the packaged environments it hands out are built here.
    "../apps/app/scripts/verify-artifacts.operation.mjs",
    "../apps/web/e2e/acceptance/ux-native-acceptance.ts",
  ];
  for (const file of drivers) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!/shellEnv\s*=\s*\{\s*\}/.test(source), file + " must not keep an empty packaged environment as a fallback");
    assert.ok(/packagedEnvironment\(/.test(source), file + " must take every packaged environment from the shared guard");
    assert.ok(/function packagedEnv\(|packagedEnvironment\(credentials,/.test(source), file + " builds its packaged environment through the guard, at one seam");
  }

  const native = readFileSync(new URL("../apps/web/e2e/acceptance/ux-native-acceptance.ts", import.meta.url), "utf8");
  const cleanup = native.indexOf("const shutdown = async () =>");
  const signals = native.indexOf('process.once(signal');
  const display = native.indexOf("await startDisplay()");
  const stack = native.indexOf("await startAcceptanceStack(");
  const store = native.indexOf("await startCredentialSandbox(");
  const firstSpawn = native.indexOf("spawn(binary");
  assert.ok(cleanup > 0 && cleanup < display && cleanup < stack && cleanup < store,
    "the native driver owns a cleanup before it takes any resource (shutdown " + cleanup + ", display " + display + ", stack " + stack + ", store " + store + ")");
  assert.ok(signals > cleanup && signals < display, "signal handlers are installed after the cleanup exists and before anything is started");
  assert.ok(store < firstSpawn, "and the credential store is decided before the first shell process is spawned");
});

const toolchain = ["dbus-daemon", "gnome-keyring-daemon", "gdbus"].every(
  (tool) => spawnSync("sh", ["-c", "command -v " + tool], { encoding: "utf8" }).stdout.trim() !== "",
);

test("a started sandbox answers on its own bus and leaves nothing behind", { skip: toolchain ? false : "no D-Bus Secret Service toolchain on this host" }, async () => {
  const store = await startCredentialSandbox({ label: "cred-test" });
  try {
    assert.notEqual(store.busAddress, process.env.DBUS_SESSION_BUS_ADDRESS ?? "", "the private bus is a different address from the inherited one");
    assert.ok(store.busAddress.startsWith("unix:path="), "the address names a socket this run created: " + store.busAddress);
    // A child of this environment sees only the private pointers — the exact property the native driver depends on.
    const seen = spawnSync("sh", ["-c", 'echo "$DBUS_SESSION_BUS_ADDRESS|$HOME|$XDG_DATA_HOME|${GNOME_KEYRING_CONTROL:-absent}"'], { env: store.env, encoding: "utf8" }).stdout.trim();
    const [bus, home, data, control] = seen.split("|");
    assert.equal(bus, store.busAddress, "a child reads the private bus: " + seen);
    assert.equal(home, store.home);
    assert.equal(data, join(store.home, ".local", "share"));
    assert.equal(control, "absent", "no session keyring control socket reaches a child");
    // The store answers a search for the App's own attributes, and it holds nothing before this run writes to it.
    assert.deepEqual(store.search(), { unlocked: [], locked: [] }, "the private store starts empty, so a --forget cannot delete a person's entry");
  } finally {
    await store.stop();
    await store.stop();
  }
  assert.equal(existsSync(store.directory), false, "stop() is idempotent and removes the tree it created, leaving no keyring behind");
});

test("a retained sandbox moves its store next to the caller's evidence", { skip: toolchain ? false : "no D-Bus Secret Service toolchain on this host" }, async () => {
  // `--keep` on the driver means the keyring file is the record of which store the run addressed, so the finished tree has
  // to arrive in the caller's directory rather than vanish from a temp path nobody will read.
  const destination = mkdtempSync(join(tmpdir(), "hepi-cred-destination-"));
  const store = await startCredentialSandbox({ label: "cred-keep-test", root: destination, keepStore: true });
  const livePath = store.directory;
  await store.stop();
  assert.notEqual(store.storedAt, livePath, "stop() relocated the tree into the caller's directory");
  assert.ok(store.storedAt.startsWith(destination), "and it is under the destination the caller named: " + store.storedAt);
  assert.equal(existsSync(join(store.storedAt, "bus.xml")), true, "the bus config the store ran under is part of the evidence");
  rmSync(destination, { recursive: true, force: true });
});

test("a temp directory too long for a unix socket is refused, not tried", { skip: toolchain ? false : "no D-Bus Secret Service toolchain on this host" }, async () => {
  // The real failure this guards: a driver rooting its store in `.dev/worktrees/<name>/.dev/verify/<run>/…` produced a
  // 146-byte bus path, the daemon could not bind, and the run reported a credential store that never answered. The refusal
  // has to name the limit instead.
  const previous = process.env.TMPDIR;
  const long = join(tmpdir(), "hepi-cred-toolong-" + "x".repeat(120));
  mkdirSync(long, { recursive: true });
  process.env.TMPDIR = long;
  try {
    await assert.rejects(() => startCredentialSandbox({ label: "cred-toolong" }), /unix limit/, "an over-long socket path is named as the cause");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(long, { recursive: true, force: true });
  }
});

/**
 * The store's own teardown, which is the one place this module can hand back a filesystem error.
 *
 * The failure a real run hit: the desktop's portal and gvfs daemons notice a new XDG_RUNTIME_DIR and auto-mount
 * runtime/doc and runtime/gvfs inside it. Nothing here started those mounts, and once the daemon behind one is gone the
 * path stops being a directory and becomes an error, so rmSync fails with ENOTCONN ("Transport endpoint is not connected")
 * and that throw escapes stop(). A native run that had already passed every check then died in its own cleanup without
 * printing the two statements that make the run trustworthy: where its store went, and that the developer's keyring is
 * unchanged. So the teardown releases what is mounted under the tree before removing it, and if removal still fails it
 * reports the path instead of throwing: a temp directory left behind is a leak, while a run that never states its
 * isolation claim is the failure this sandbox exists to prevent.
 */
test("every mount under the store is released deepest-first, and only its own", () => {
  const directory = "/tmp/hepi-cred-ABCD";
  const mountinfo = [
    "36 21 0:30 / /tmp rw - tmpfs tmpfs rw",
    "141 36 0:44 / /tmp/hepi-cred-ABCD/runtime/doc rw master:1 - fuse.portal fuse.portal rw,user_id=1000",
    "142 36 0:45 / /tmp/hepi-cred-ABCD/runtime/gvfs rw master:2 - fuse.gvfsd-fuse fuse.gvfsd-fuse rw,user_id=1000",
    "143 36 0:46 / /tmp/hepi-cred-ABCDX/runtime rw - tmpfs tmpfs rw",
    "144 36 0:47 /run/user/1000/doc rw - tmpfs tmpfs rw",
  ].join("\n") + "\n";
  // The two inside the tree, and deepest first: a parent released over a live child fails busy. A sibling whose name
  // merely shares a prefix, and a mount belonging to the session, are not this run's to release — unmounting the
  // developer's own portal mount is the same class of act against the session as writing its keyring was.
  assert.deepEqual(mountPointsUnder(directory, mountinfo), [
    "/tmp/hepi-cred-ABCD/runtime/doc",
    "/tmp/hepi-cred-ABCD/runtime/gvfs",
  ]);
  // A tree with nothing mounted under it is the ordinary case, and it asks for no release at all.
  assert.deepEqual(mountPointsUnder(directory, "36 21 0:30 / /tmp rw - tmpfs tmpfs rw\n"), []);
});

test("releaseTree unmounts before removing, removes when an unmount fails, and reports a tree it cannot remove", () => {
  const directory = "/tmp/hepi-cred-XYZ";
  // The paths a release was asked for, in the order it asked: the order is what a busy unmount depends on.
  const calls: string[] = [];
  const first = releaseTree(directory, {
    mounts: () => [directory, join(directory, "runtime", "doc")],
    unmount: (path: string) => { calls.push(path); },
    remove: () => {},
  });
  assert.equal(first.removed, true, "an ordinary removal is reported as removed");
  // Deepest first regardless of the order the mounts came in: releasing a parent over a live child fails busy, which is
  // the failure this function exists to avoid.
  assert.deepEqual(calls, [join(directory, "runtime", "doc"), directory], "everything mounted under the tree is released before it is removed");
  assert.equal(first.leftover, null, "and nothing is left behind to name");

  // A mount that will not go away must not stop the removal of the rest of the tree.
  const second = releaseTree(directory, {
    mounts: () => [join(directory, "runtime", "gvfs")],
    unmount: () => { throw new Error("device or resource busy"); },
    remove: () => {},
  });
  assert.equal(second.removed, true);
  assert.equal(second.unmounted, 0, "a failed release is not counted as one");
  assert.match(second.problems.join(" "), /busy/);

  // The case the run actually met: removal itself fails. Reported, never thrown.
  const third = releaseTree(directory, {
    mounts: () => [join(directory, "runtime", "doc")],
    unmount: () => { throw new Error("Transport endpoint is not connected"); },
    remove: () => { throw Object.assign(new Error("rm failed"), { code: "ENOTCONN" }); },
  });
  assert.equal(third.removed, false, "a tree that is still mounted is not claimed as removed");
  assert.equal(third.leftover, directory, "and where it lives is stated, so the driver's retention check fails honestly");
  assert.match(third.problems.join(" "), /ENOTCONN|not connected/);
});

test("a mount that is gone by the time it is released is released, not a problem", () => {
  // What the real run printed: the store's own daemons die first, so gvfs/portal tear their mounts down on their own,
  // and an unmount attempt then answers "entry for <point> not found in /etc/mtab". That is the outcome the teardown
  // wanted, and reporting it as a problem makes a clean run look like a leak.
  const directory = "/tmp/hepi-cred-GONE";
  const point = join(directory, "runtime", "gvfs");
  let listed = [point];
  const result = releaseMountsUnder(directory, {
    mounts: () => listed,
    unmount: () => { listed = []; throw new Error("fusermount3: entry for " + point + " not found in /etc/mtab"); },
    // The re-check after a failed attempt consults the mount table again; by then the point is not in it.
    mountedNow: () => listed.includes(point),
  });
  assert.deepEqual(result.problems, [], "and nothing is reported");
  assert.equal(result.unmounted, 1, "counted as released");
  // A mount that is really still there stays a problem: a busy portal mount is exactly the leak this must not hide.
  const held = releaseMountsUnder(directory, {
    mounts: () => [point],
    unmount: () => { throw new Error("device or resource busy"); },
    mountedNow: () => true,
  });
  assert.equal(held.unmounted, 0);
  assert.match(held.problems.join(" "), /busy/);
});
