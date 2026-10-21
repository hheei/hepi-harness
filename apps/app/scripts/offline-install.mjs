/**
 * A real `dpkg --install` transaction, into a root this run owns.
 *
 * `dpkg --install` needs euid 0, which this build host does not grant the session, so the packaged App was verified by
 * extraction only (`dpkg-deb -x`). Extraction is not the same statement as "the package installs": it never runs dpkg's
 * own database, its dependency resolution, its unpack-to-final-paths, or the `installed` state a supervisor reads.
 *
 * Where the host allows an unprivileged user namespace, the transaction can run for real inside a namespace that is root
 * of **its own tree only**: the host is bind-mounted read-only, the only writable paths are a throwaway root and its own
 * log file, and dpkg maintains its status database there. Nothing on the host is installed, configured or written; the
 * host's `/var/lib/dpkg/status` is read only as the seed that lets the package's own dependencies resolve.
 *
 * Whether that path exists is a host fact, decided by `installSupport` from values the caller read. There is deliberately
 * no fallback to `--force` flags or to extraction: a run that reported either as an install would be the false statement
 * this module exists to prevent.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The database the host itself reads and writes. */
export const HOST_STATUS_FILE = "/var/lib/dpkg/status";

/** The command every name below runs as: root of its own namespace, host read-only, `root` the only writable tree. */
function namespaced(args, root) {
  // No `--tmpfs /tmp`: the archive being installed usually lives under the host's temp directory, and a tmpfs over it
  // would hide the very file the transaction is reading. Instead the whole host is read-only and this run's scratch is
  // its own writable directory, named by TMPDIR so dpkg puts its unpack work there and nowhere else.
  return ["--unshare-all", "--uid", "0", "--gid", "0",
    "--ro-bind", "/", "/",
    "--dir", root, "--bind", root, root,
    "--dev", "/dev", "--proc", "/proc",
    "--setenv", "TMPDIR", join(root, "tmp"),
    // dpkg refuses the transaction when its maintainer-script tools are not on PATH, and it says so as root's PATH:
    // "root's PATH should usually contain /usr/local/sbin, /usr/sbin and /sbin". `--unshare-all` inherits the caller's
    // environment, and an interactive developer PATH does not necessarily hold `/usr/sbin`, where `ldconfig` and
    // `start-stop-daemon` live. A transaction root is root, so the namespace is given root's PATH rather than the
    // shell's: without this the same artifact installs in one session and fails in another for a reason that has
    // nothing to do with the package.
    "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...args];
}

/**
 * Whether this host can run the transaction, from facts the caller read.
 *
 * Exported as a pure function because the honest answer differs per host, and the driver has to be able to state the
 * reason it fell back to extraction rather than decide it by trial and error at run time.
 */
export function installSupport({ hasDpkg, hasBwrap, unprivilegedUserns }) {
  if (!hasDpkg) return { supported: false, reason: "this host has no dpkg" };
  if (!hasBwrap) return { supported: false, reason: "no bwrap on this host, and dpkg --install needs euid 0, which this session does not have" };
  if (!unprivilegedUserns) return { supported: false, reason: "this kernel does not allow unprivileged user namespaces, so no private root can be created" };
  return { supported: true, reason: "a real dpkg transaction runs in a private user namespace over a root this run owns" };
}

/** The `dpkg` argv of one offline install, with the run's own log file so its transitions are evidence. */
export function offlineInstallArgs({ root, deb, logFile }) {
  return namespaced(["dpkg", "--root=" + root, "--log=" + logFile, "--install", deb], root);
}

/** The `dpkg -V <package>` argv that asks dpkg whether the files it installed are still its own. */
export function offlineVerifyArgs({ root, packageName, logFile }) {
  return namespaced(["dpkg", "--root=" + root, "--log=" + logFile, "-V", packageName], root);
}

/**
 * The status text a seeded root may carry, from the host's own.
 *
 * Only packages already in the `install ok installed` state are copied: dpkg would otherwise plan work against a
 * half-installed package that lives on the host, and configuring one is neither this run's job nor inside its tree.
 */
export function seedStatus(hostStatusText) {
  const blocks = String(hostStatusText).split("\n\n").filter((block) => /(^|\n)Package: /.test(block));
  return blocks.filter((block) => /(^|\n)Status: install ok installed\s/.test(block + " ")).join("\n\n") + "\n";
}

/**
 * What the host's own database says about one package, as a comparable string.
 *
 * This is the record the transaction must leave alone. It is deliberately not a presence flag: a workstation that already
 * has the App installed has a host record — same version, same state — and the isolation claim there is "unchanged", not
 * "absent". Reading `Status` and `Version` says the weaker thing the claim actually is, and a run cannot pass it by
 * looking for an absence the host never promised.
 */
export function hostPackageRecord(hostStatusText, packageName) {
  const block = String(hostStatusText).split("\n\n")
    .find((entry) => new RegExp("(^|\\n)Package: " + packageName + "$", "m").test(entry));
  if (block === undefined) return { readable: true, present: false, record: "not in the host's database" };
  const lines = block.split("\n");
  const field = (name) => lines.find((line) => line.startsWith(name + ":")) ?? "no " + name + " field";
  return { readable: true, present: true, record: [field("Status"), field("Version"), field("Architecture")].join(" / ") };
}

/** The host's statement about one package, or an explicit unreadable instead of a silent "absent". */
export function readHostPackageRecord(hostStatusFile, packageName) {
  try { return hostPackageRecord(readFileSync(hostStatusFile, "utf8"), packageName); }
  catch (error) { return { readable: false, present: null, record: "unreadable: " + String(error?.message ?? error) }; }
}

/**
 * Create one throwaway root with dpkg's own directories and a seeded database.
 *
 * `TMPDIR` by design: a `--bind` source has to be reachable from the namespace's own read-only mount of `/`, and a deep
 * worktree log path buys nothing.
 */
export function prepareInstallRoot({ prefix = "hepi-offline-install-", hostStatusFile = HOST_STATUS_FILE } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  for (const created of ["var/lib/dpkg/updates", "var/log", "var/cache/apt/archives/parts", "tmp"]) mkdirSync(join(root, created), { recursive: true });
  const logFile = join(root, "var/log/dpkg.log");
  let seeded = false;
  try {
    const seed = seedStatus(readFileSync(hostStatusFile, "utf8"));
    if (seed.trim() !== "") { writeFileSync(join(root, "var/lib/dpkg/status"), seed); seeded = true; }
  } catch {
    // A host that states no status database is a root with no dependency answers; the install then reports the
    // dependency failure it hits rather than pretending the seed existed.
  }
  return { root, logFile, seeded };
}

/**
 * Run one offline install of `deb` and report dpkg's own answers.
 *
 * `state` is the package's `Status:` line in the run's own database, `verifyExit` is dpkg's verdict on the files it
 * placed, and `payload` is the binary path the transaction created inside the root. Failures come back as fields, never
 * as a throw: the caller has to be able to state which part of the transaction did not happen.
 */
export async function runOfflineInstall({ deb, packageName = "hepi", hostStatusFile = HOST_STATUS_FILE, timeoutMs = 300_000 } = {}) {
  // Read the host's record on both sides of the transaction. This is the only way to state the isolation claim on a host
  // that already has the package installed, which is the ordinary case on a real hepi workstation.
  const hostBefore = readHostPackageRecord(hostStatusFile, packageName);
  const { root, logFile, seeded } = prepareInstallRoot({ hostStatusFile });
  const install = await capture("bwrap", offlineInstallArgs({ root, deb, logFile }), timeoutMs);
  const verify = await capture("bwrap", offlineVerifyArgs({ root, packageName, logFile }), timeoutMs);
  let state = "";
  try {
    const block = readFileSync(join(root, "var/lib/dpkg/status"), "utf8")
      .split("\n\n")
      .find((entry) => new RegExp("(^|\\n)Package: " + packageName + "$", "m").test(entry));
    state = (block ?? "").split("\n").find((line) => line.startsWith("Status:")) ?? "no record for " + packageName;
  } catch (error) { state = "unreadable: " + String(error?.message ?? error); }
  return {
    root, logFile, seeded,
    hostBefore, hostAfter: readHostPackageRecord(hostStatusFile, packageName),
    installExit: install.status,
    installOutput: (install.stdout + install.stderr).trim().slice(-1200),
    verifyExit: verify.status,
    verifyOutput: (verify.stdout + verify.stderr).trim().slice(-800),
    state,
    installed: state === "Status: install ok installed",
    payload: join(root, "usr", "bin", "hepi-app"),
  };
}

/** Remove one offline-install root, including a tree dpkg left mid-transaction. */
export function cleanupInstallRoot(root) {
  rmSync(root, { recursive: true, force: true });
}

function capture(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ status: code ?? 1, stdout, stderr }); });
    child.on("error", (error) => { clearTimeout(timer); resolveRun({ status: 1, stdout: "", stderr: String(error?.message ?? error) }); });
  });
}
