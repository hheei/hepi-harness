/**
 * One private D-Bus session bus with its own Secret Service, for a run that must write real credentials.
 *
 * Why this exists: the App shell keeps its connection in the **OS credential store** — `keyring` → Secret Service, on the
 * session bus — and the headless operations that write it are the ones the native acceptance run performs (`hepi-app
 * --configure`, `--forget`). A driver that inherits the developer's `DBUS_SESSION_BUS_ADDRESS` therefore asks the
 * *developer's* gnome-keyring to store and delete `dev.hepi.app/connection`: an acceptance run that overwrites the one
 * entry a real install has is not a test of the shell's credential store, it is a write against the user's own. This
 * module owns the opposite: the run gets a bus, a keyring daemon and a home of its own, and the real session's store is
 * never addressed.
 *
 * What it starts, in order, and why each part is required:
 *
 * - `dbus-daemon --config-file=<own file> --nofork`: a session bus on a socket path this run created. A config file with
 *   an explicit `<listen>unix:path=…</listen>` is used rather than `--print-address` because the address must be known
 *   before the daemon is started, so a driver can hand it to a child and still be able to clean the socket up.
 * - `gnome-keyring-daemon --foreground --unlock --components=secrets` with an **empty** passphrase on stdin: this creates
 *   and unlocks a `login` collection under the run's own `HOME`. Without `--unlock` the daemon answers with only the
 *   in-memory `session` collection and every write to a *persistent* entry fails, which a driver would read as a broken
 *   shell rather than a missing keyring.
 * - a wait until `org.freedesktop.secrets` has a bus owner: the store being reachable is what the driver is asserting, so
 *   the run does not begin before it is.
 *
 * Nothing here falls back to the ambient bus. If a tool is missing or the name never appears, `startCredentialSandbox`
 * throws with what failed: a run that could not isolate the credential store must not write to the real one.
 *
 * The entry this repository's App writes is stated by `CONNECTION_ATTRIBUTES`, whose values are the Rust shell's own
 * `KEYRING_SERVICE` and `CONNECTION_ENTRY` (`apps/app/src-tauri/src/main.rs`).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The credential the App shell stores, as the Rust side files it. */
export const CONNECTION_ATTRIBUTES = Object.freeze({ service: "dev.hepi.app", username: "connection" });

/** The private keyring file a login collection is kept in, relative to a `HOME`. */
const LOGIN_KEYRING = join(".local", "share", "keyrings", "login.keyring");

const BUS_CONFIG = (socketPath) => [
  '<?xml version="1.0"?>',
  '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
  ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
  "<busconfig>",
  "  <type>session</type>",
  `  <listen>unix:path=${socketPath}</listen>`,
  "  <auth>EXTERNAL</auth>",
  "  <standard_session_servicedirs />",
  '  <policy context="default">',
  '    <allow send_destination="*" eavesdrop="true"/>',
  '    <allow eavesdrop="true"/>',
  '    <allow own="*"/>',
  "  </policy>",
  "</busconfig>",
  "",
].join("\n");

/**
 * The environment of one isolated credential session, built from a caller's base environment.
 *
 * Pure and exported on its own because this is the whole safety property in one function, and it must be checkable
 * without a D-Bus daemon: every variable that decides *which* credential store a process reaches is replaced by this
 * run's own directory, and the variables that would point a child at the developer's running session are removed rather
 * than left to be overridden later. Everything the platform needs that is not a credential path — `PATH`, and the
 * driver's own `DISPLAY` — is passed through untouched.
 */
export function sandboxEnvironment({ base = process.env, directory, busAddress }) {
  const home = join(directory, "home");
  const runtime = join(directory, "runtime");
  const scratch = join(directory, "tmp");
  const env = { ...base };
  // Replaced, in this order: the bus the Secret Service is reached through, and the three homes a session writes into.
  env.DBUS_SESSION_BUS_ADDRESS = busAddress;
  env.HOME = home;
  env.XDG_RUNTIME_DIR = runtime;
  env.TMPDIR = scratch;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.XDG_STATE_HOME = join(home, ".local", "state");
  // Removed rather than overridden: these name a *running* session's own daemon. A child that reads them would talk to
  // the developer's keyring control socket even with a private bus address set.
  delete env.GNOME_KEYRING_CONTROL;
  delete env.GNOME_KEYRING_PID;
  return env;
}

/**
 * The environment one packaged shell process may be started with, or a refusal.
 *
 * A driver that could not start its private store has no isolated environment to hand over, and **no environment is not
 * the same thing as an isolated one**: with `DBUS_SESSION_BUS_ADDRESS` unset, the library the shell's `keyring` crate is
 * built on still looks for a session bus and finds `/run/user/<uid>/bus`, the developer's running one. A run that passed
 * an empty environment to `--forget` would therefore delete the real user's `dev.hepi.app/connection` while believing it
 * had touched nothing — which is the exact failure this module exists to prevent, so it is refused here rather than by
 * each caller remembering to check. Every packaged process goes through this call: no store, no spawn.
 *
 * `extra` is the driver's own non-credential environment (its `DISPLAY`, the WebView's software-rendering flags).
 */
export function packagedEnvironment(credentials, extra = {}) {
  const busAddress = credentials?.busAddress;
  const env = credentials?.env;
  if (typeof busAddress !== "string" || env?.DBUS_SESSION_BUS_ADDRESS !== busAddress) {
    const state = credentials === null || credentials === undefined
      ? "no credential store was started"
      : "it names " + (env?.DBUS_SESSION_BUS_ADDRESS ?? "no session bus at all");
    throw new Error("a packaged credential process may not be started without this run's own Secret Service (" + state + "); an empty environment still reaches /run/user/" + process.geteuid() + "/bus");
  }
  return { ...env, ...extra };
}

/**
 * The digest of the real user's login keyring, or `null` when this host has none.
 *
 * This is read-only evidence for the one claim that matters to a person whose machine is running the tests: the file the
 * developer's own credential store is kept in did not change. It is deliberately not a path the run ever writes to, and
 * an absent keyring is reported as absent rather than as an empty digest, so a driver cannot turn "no file" into "same
 * file".
 */
export function loginKeyringDigest(base = process.env) {
  const home = base.HOME;
  if (home === undefined || home === "") return null;
  try {
    return createHash("sha256").update(readFileSync(join(home, LOGIN_KEYRING))).digest("hex");
  } catch {
    return null;
  }
}

/** A Secret Service answers this only when something owns the name on this bus. */
function secretsOwner({ busAddress }) {
  try {
    const out = execFileSync("gdbus", [
      "call", "--session",
      "--dest", "org.freedesktop.DBus",
      "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.GetNameOwner",
      "org.freedesktop.secrets",
    ], { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: busAddress }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    return /':\d+\.\d+'/.test(out);
  } catch {
    return false;
  }
}

/**
 * The item paths a Secret Service search answered, split the way the method returns them.
 *
 * `SearchItems` answers `( @[ '/o/1', … ], @[ '/o/2', … ] )`: unlocked items first, then the locked ones. An empty half
 * prints as `@ao []` and a filled one as `[objectpath '/o/1']`, so the two array literals are read in order rather than
 * counted — an empty unlocked half then stays empty instead of shifting the locked list into its place. Item paths
 * contain no brackets, so splitting on them needs no parser.
 */
function parseSearch(text) {
  const arrays = [...String(text).matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]);
  const paths = (part) => [...String(part ?? "").matchAll(/'(\/[^']*)'/g)].map((match) => match[1]);
  return { unlocked: paths(arrays[0]), locked: paths(arrays[1]) };
}

/** The longest path a `unix:path=` socket may occupy, from the kernel's `sockaddr_un`. */
const SOCKET_PATH_LIMIT = 107;

/**
 * The mount points under `directory`, deepest first, read from a mountinfo body.
 *
 * A store's `runtime/` directory is a session-private location by freedesktop's own rule, so the desktop's portal and
 * gvfs daemons mount `runtime/doc` and `runtime/gvfs` inside it unasked. Only paths strictly below this run's tree are
 * returned: a sibling that merely shares the prefix belongs to another run, and the session's own mounts belong to
 * somebody else — releasing one would be the same class of act against the session as writing its keyring was.
 */
export function mountPointsUnder(directory, mountinfo) {
  const prefix = directory.endsWith("/") ? directory : directory + "/";
  const found = [];
  for (const line of String(mountinfo).split("\n")) {
    // `major:minor root mount-point options optional-fields… - fstype source super-options`
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    // Mount points escape tab, newline, backslash and space; a tree whose own name needs that is not this run's.
    const point = fields[4].replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
    if (point.startsWith(prefix)) found.push(point);
  }
  return sortedDeepestFirst(found);
}

function sortedDeepestFirst(points) {
  return points.slice().sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b));
}

/**
 * Release whatever is mounted under `directory`, remove it, and **report** instead of throwing.
 *
 * The injected `mounts`/`unmount`/`remove` are what a test replaces; the defaults read this host's own mount table and
 * unmount through `fusermount3`/`fusermount`, the unprivileged path, falling back to `umount`.
 *
 * Removal is attempted whether or not every release succeeded: a leftover directory under `/tmp` is a leak, while an
 * unmounted tree is removable. A removal that still fails comes back as `leftover` rather than an exception, because a
 * driver that dies in its own cleanup states nothing at all — and the statements this one is running for (where its
 * store went, and that the developer's keyring is unchanged) come after it.
 */
export function releaseMountsUnder(directory, { mounts, unmount, mountedNow } = {}) {
  const release = unmount ?? defaultUnmount;
  const problems = [];
  let unmounted = 0;
  let points = [];
  const listing = mounts ?? (() => mountPointsUnder(directory, readFileSync("/proc/self/mountinfo", "utf8")));
  try { points = sortedDeepestFirst(listing()); }
  catch (error) { problems.push("could not read the mount table: " + String(error?.message ?? error)); }
  for (const point of points) {
    try { release(point); unmounted += 1; continue; }
    catch (error) {
      // The point may have gone away during the attempt, which is the outcome wanted. Asked of the mount table rather
      // than of the tool's wording, because "not found in /etc/mtab" and "busy" both arrive as a non-zero exit.
      const present = mountedNow !== undefined ? mountedNow(point) : listing().includes(point);
      if (!present) { unmounted += 1; continue; }
      problems.push("could not release " + point + ": " + String(error?.message ?? error));
    }
  }
  return { unmounted, problems };
}

export function releaseTree(directory, { mounts, unmount, mountedNow, remove } = {}) {
  const { unmounted, problems } = releaseMountsUnder(directory, { mounts, unmount, mountedNow });
  try {
    (remove ?? ((path) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))(directory);
    return { removed: true, unmounted, leftover: null, problems };
  } catch (error) {
    problems.push("could not remove " + directory + " (" + (error?.code ?? "unknown") + "): " + String(error?.message ?? error));
    return { removed: false, unmounted, leftover: directory, problems };
  }
}

function defaultUnmount(point) {
  // The unprivileged path first: a FUSE mount this user owns is released by the same mechanism that made it.
  for (const tool of ["fusermount3", "fusermount", "umount"]) {
    const found = spawnSync("sh", ["-c", "command -v " + tool], { encoding: "utf8" });
    if (found.status !== 0 || found.stdout.trim() === "") continue;
    const result = spawnSync(tool, ["-u", point], { encoding: "utf8", timeout: 15_000 });
    if (result.status === 0) return;
    throw new Error(String(result.stderr || result.stdout || tool + " exited " + result.status).trim());
  }
  throw new Error("no unmount tool on this host");
}

/**
 * Start one isolated credential session and hand back what a driver needs to use and to undo it.
 *
 * The working tree is always created directly under the system temp directory, and **not** under a caller's `root`: an
 * AF_UNIX socket name is limited to 107 bytes, and both the bus socket and gnome-keyring's control socket live inside
 * this tree, so a driver whose log directory is a deep worktree path (`.dev/worktrees/<name>/.dev/verify/<run>/…`) would
 * otherwise get a bus that cannot bind — measured at 146 bytes for ticket 15's artifact log directory, which produced a
 * store that never appeared. `root` is therefore the destination, not the home: with `keepStore` the finished tree is
 * moved there so retained evidence sits beside the run's logs, and without it the tree is simply removed.
 *
 * `stop()` is idempotent and signals only the two processes this call started.
 */
export async function startCredentialSandbox({ label = "cred", root = "", keepStore = false, log = () => {} } = {}) {
  // Resolved on PATH, not executed: a daemon's own `--version` is not a contract (`gdbus` exits 1 on it), and a missing
  // tool has to be named before the run starts rather than surfacing as a store that never appeared.
  for (const tool of ["dbus-daemon", "gnome-keyring-daemon", "gdbus"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
    if (found.status !== 0 || found.stdout.trim() === "") {
      throw new Error(`the isolated credential store needs ${tool}, which this host does not provide`);
    }
  }

  const directory = mkdtempSync(join(tmpdir(), `hepi-${label}-`));
  chmodSync(directory, 0o700);
  // Where the tree lives: the working path until `stop()` finishes, then the destination it moved to. Declared here, not
  // at the end, because every failure path below already has to clean the tree up.
  let storedAt = directory;
  let stopped = false;
  const home = join(directory, "home");
  const runtime = join(directory, "runtime");
  const scratch = join(directory, "tmp");
  for (const created of [home, runtime, scratch]) mkdirSync(created, { recursive: true, mode: 0o700 });
  const busAddress = "unix:path=" + join(directory, "bus");
  // Checked where it actually bites, rather than trusting the temp directory to be short: a host with a long TMPDIR would
  // otherwise fail as a store that silently never answered.
  const longest = Math.max(busAddress.length - "unix:path=".length, join(runtime, "keyring", "control").length);
  if (longest > SOCKET_PATH_LIMIT) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`the private bus socket path needs ${longest} bytes, over the ${SOCKET_PATH_LIMIT}-byte unix limit; this host's TMPDIR (${tmpdir()}) is too long for an isolated credential store`);
  }
  const env = sandboxEnvironment({ directory, busAddress });

  writeFileSync(join(directory, "bus.xml"), BUS_CONFIG(join(directory, "bus")));
  const bus = spawn("dbus-daemon", ["--config-file=" + join(directory, "bus.xml"), "--nofork", "--nopidfile", "--nosyslog"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let busError = "";
  bus.stderr.on("data", (chunk) => { busError += String(chunk); });
  bus.on("exit", (code, signal) => log(`credential bus exited (${signal ?? code})`));

  // An empty passphrase on stdin is what creates the persistent `login` collection and unlocks it for this run.
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let keyringLog = "";
  keyring.stdout.on("data", (chunk) => { keyringLog += String(chunk); });
  keyring.stderr.on("data", (chunk) => { keyringLog += String(chunk); });
  keyring.stdin.end("\n");

  let started = false;
  for (let attempt = 0; attempt < 60 && !started; attempt++) {
    if (bus.exitCode !== null) { await stop(); throw new Error("the private session bus exited before it answered: " + busError.slice(0, 400)); }
    if (keyring.exitCode !== null) { await stop(); throw new Error("the private Secret Service exited before it answered: " + keyringLog.slice(0, 400)); }
    started = secretsOwner({ busAddress });
    if (!started) await delay(200);
  }
  if (!started) {
    await stop();
    throw new Error("no Secret Service appeared on the private session bus within 12s: " + keyringLog.slice(0, 400));
  }

  /** Every item the private store holds for these attributes: unlocked and locked, as the Secret Service answered. */
  const search = (attributes = CONNECTION_ATTRIBUTES) => {
    const dict = "{" + Object.entries(attributes).map(([name, value]) => `"${name}":"${value}"`).join(",") + "}";
    try {
      const out = execFileSync("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.secrets",
        "--object-path", "/org/freedesktop/secrets",
        "--method", "org.freedesktop.Secret.Service.SearchItems",
        dict,
      ], { env, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      return parseSearch(out);
    } catch (error) {
      return { error: String(error?.message ?? error).slice(0, 300), unlocked: [], locked: [] };
    }
  };

  /** @returns {Promise<string>} where the tree finally lives: removed, relocated, or left in place. */
  async function stop() {
    if (stopped) return storedAt;
    stopped = true;
    // Only the processes this run started are signalled, by their own handle: no pattern matching, so a driver can never
    // signal the developer's session daemon by name collision. Both are then **awaited**, because a daemon that is still
    // alive while its tree is removed recreates directories under it and the removal fails with ENOTEMPTY — and a driver
    // that dies in its own `finally` never writes its report at all.
    const exited = [keyring, bus].map((child) => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
        // A daemon that ignores SIGTERM would hold the run's exit: its socket and directories are its own, so the tree is
        // removed regardless once this bound is reached.
        void delay(5_000).then(resolve, () => {});
      }));
    await Promise.allSettled(exited);
    // The tree can hold mounts this run never asked for: the desktop's portal and gvfs daemons mount inside any new
    // `XDG_RUNTIME_DIR`, and once their daemon is gone the path is not a directory but an error — `rmSync` then fails
    // with ENOTCONN. That throw used to escape `stop()` and kill the driver after its last two assertions, which are the
    // ones that state the run's isolation, so the release happens here and any remaining problem is only reported.
    if (!keepStore) {
      for (const problem of releaseTree(directory).problems) log(problem);
      return storedAt;
    }
    // Retention keeps the tree, so only what is mounted inside it is released — a `releaseTree` here would remove the
    // evidence before the rename that is meant to move it.
    for (const problem of releaseMountsUnder(directory).problems) log(problem);
    // The store is this run's evidence: the keyring file, the bus config and the runtime sockets say which store the run
    // addressed, so the finished tree moves next to the caller's logs instead of vanishing from a short temp path. A
    // destination on another device (a tmpfs TMPDIR and an on-disk log directory) cannot be renamed, so the copy path is
    // taken there rather than reporting a location that does not exist. A caller that asked to retain the store without
    // naming a destination keeps it where it ran and is told where that is — there is no third case.
    try {
      mkdirSync(root, { recursive: true });
      const destination = join(root, directory.split(/[\\/]/).pop());
      try {
        renameSync(directory, destination);
      } catch {
        cpSync(directory, destination, { recursive: true });
        for (const problem of releaseTree(directory).problems) log("the source of the retained store: " + problem);
      }
      storedAt = destination;
    } catch (error) {
      // A destination that cannot be written at all keeps the tree where it is and says so: a driver that reported a
      // location it could not read would be worse than one that reported the temp path it actually used.
      log("could not retain the credential store under " + root + ", left at " + directory + ": " + String(error?.message ?? error).slice(0, 160));
      storedAt = directory;
    }
    return storedAt;
  }

  return {
    directory, home, runtime, env, busAddress, keepStore,
    get storedAt() { return storedAt; },
    inheritedBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
    search,
    stop,
  };
}
