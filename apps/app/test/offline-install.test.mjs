/**
 * Whether this host can run a real `dpkg` transaction, and what one transaction says.
 *
 * The App package was long verified by extraction because `dpkg --install` needs euid 0. That limit is a host fact, so
 * the support decision is asserted as a pure function: a driver has to name *why* it fell back, and `--force` flags or
 * `dpkg-deb -x` must not be reported as an install. The transaction is then exercised for real on a throwaway package
 * built by `dpkg-deb --build` in a fixture directory — one small package proves the namespace, the seeded database, the
 * status transitions and `dpkg -V` without depending on a 225 MB App artifact.
 *
 * The host comparison is asserted as a **record read twice**, not as a presence flag: the ordinary hepi workstation already
 * has the App installed, so "the host does not name the package" would fail a healthy machine for the wrong reason. What
 * survives both hosts is that the transaction left the host's own record of the package exactly as it found it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupInstallRoot, hostPackageRecord, installSupport, offlineInstallArgs, readHostPackageRecord, runOfflineInstall, seedStatus } from "../scripts/offline-install.mjs";

const has = (tool) => spawnSync("sh", ["-c", "command -v " + tool], { encoding: "utf8" }).stdout.trim() !== "";

test("the install path is decided by host facts, and only by them", () => {
  const all = { hasDpkg: true, hasBwrap: true, unprivilegedUserns: true };
  assert.equal(installSupport(all).supported, true);
  // Each missing fact names its own cause, so a driver reports the real limit instead of "unsupported".
  assert.match(installSupport({ ...all, hasDpkg: false }).reason, /no dpkg/);
  assert.match(installSupport({ ...all, hasBwrap: false }).reason, /euid 0/);
  assert.match(installSupport({ ...all, unprivilegedUserns: false }).reason, /user namespaces/);
});

test("a seeded database carries only packages already fully installed", () => {
  const host = [
    "Package: done\nStatus: install ok installed\nVersion: 1.0",
    "Package: broken\nStatus: half-installed broken 0.9\nVersion: 0.9",
    "Package: waiting\nStatus: not-installed waiting 0.1\nVersion: 0.1",
    "Package: config\nStatus: install ok installed\nVersion: 2.0",
  ].join("\n\n") + "\n";
  const seeded = seedStatus(host);
  assert.match(seeded, /Package: done/);
  assert.match(seeded, /Package: config/);
  // A half-installed or not-installed package would make dpkg plan work against the host's own state, outside this run's
  // tree, which is the one thing the isolation promise cannot survive.
  assert.equal(/Package: broken/.test(seeded), false);
  assert.equal(/Package: waiting/.test(seeded), false);
});

test("the install argv keeps the host read-only and the run's root the only writable tree", () => {
  const args = offlineInstallArgs({ root: "/run/owned", deb: "/run/pkg.deb", logFile: "/run/owned/var/log/dpkg.log" });
  assert.equal(args[0], "--unshare-all", "no host mount, pid, ipc, network or uts shared with the transaction");
  assert.ok(args.includes("--ro-bind"), "the host is read-only inside it: " + args.join(" "));
  assert.equal(args.filter((value) => value === "--bind").length, 1, "and exactly one writable bind, which is this run's root");
  assert.ok(args.includes("--install"), "the transaction is dpkg's own, not a re-implementation of it");
  // dpkg aborts when `ldconfig`/`start-stop-daemon` are not on PATH, and `--unshare-all` inherits the caller's, which in
  // an interactive shell often has no `/usr/sbin`. The namespace has to be given root's PATH or the same artifact
  // installs in one session and fails in another.
  const envNames = args.reduce((names, value, index) => (value === "--setenv" ? names.concat(args[index + 1]) : names), []);
  assert.ok(envNames.includes("PATH"), "the transaction namespace is given a PATH of its own: " + envNames.join(","));
  assert.ok(args[args.indexOf("PATH") + 1].includes("/usr/sbin"), "root's PATH, so dpkg's maintainer-script tools resolve");
});

test("a host that already has the package yields a record, not an absence", () => {
  const other = "Package: libc6\nStatus: install ok installed\nVersion: 2.41\nArchitecture: amd64";
  const installed = "Package: hepi\nStatus: install ok installed\nVersion: 0.1.0\nArchitecture: amd64";
  // The workstation case: dpkg's own answer, kept as a comparable string, so before/after is one read rule.
  const record = hostPackageRecord([other, installed].join("\n\n"), "hepi");
  assert.equal(record.present, true);
  assert.match(record.record, /Status: install ok installed/);
  assert.match(record.record, /Version: 0.1.0/);
  assert.equal(hostPackageRecord([other, installed].join("\n\n"), "hepi").record, record.record,
    "the same host text always compares equal to itself");
  assert.equal(hostPackageRecord(other, "hepi").present, false);
  // An unreadable host database is stated as unreadable, never silently as "absent".
  const missing = mkdtempSync(join(tmpdir(), "hepi-host-status-"));
  try {
    const unreadable = readHostPackageRecord(join(missing, "status"), "hepi");
    assert.equal(unreadable.readable, false);
    assert.match(unreadable.record, /unreadable/);
  } finally { rmSync(missing, { recursive: true, force: true }); }
});

test("a real dpkg transaction installs into the run's own root and dpkg itself confirms it",
  { skip: has("bwrap") && has("dpkg") && has("dpkg-deb") ? false : "no dpkg/bwrap on this host" }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "hepi-offline-fixture-"));
    let result = null;
    try {
      const deb = buildPackage(fixture);
      result = await runOfflineInstall({ deb, packageName: "hepi-offline-demo" });
      assert.equal(result.installExit, 0, "dpkg reported: " + result.installOutput);
      assert.equal(result.installed, true, "the run's own database states: " + result.state);
      assert.equal(result.verifyExit, 0, "dpkg -V disagrees with what it installed: " + result.verifyOutput);
      assert.equal(spawnSync(join(result.root, "usr", "bin", "hepi-offline-demo"), [], { encoding: "utf8" }).status, 0,
        "the payload landed at the package's own installed path and runs from there");
      // The transaction wrote inside the root and nowhere else: the host's own record of this package is what it was
      // before the run, which for a fixture nothing installs is "not present", and is the same comparison a host that
      // already runs the App would pass.
      assert.equal(result.hostBefore.readable && result.hostAfter.readable, true, "the host database has to be readable for the claim to mean anything");
      assert.equal(result.hostAfter.record, result.hostBefore.record,
        result.hostBefore.record + " -> " + result.hostAfter.record);
      assert.equal(result.hostBefore.present, false, "the fixture package must not have been installed onto the host: " + result.hostAfter.record);
      assert.match(readFileSync(result.logFile, "utf8"), /status installed hepi-offline-demo/);
    } finally {
      if (result !== null) cleanupInstallRoot(result.root);
      rmSync(fixture, { recursive: true, force: true });
    }
  });

test("a transaction over an already-installed package leaves the host's record alone",
  { skip: has("bwrap") && has("dpkg") && has("dpkg-deb") ? false : "no dpkg/bwrap on this host" }, async () => {
    // The workstation case, run for real. The host database this run reads already names the package, so the private root
    // starts with it installed and dpkg performs an install-over-existing. Absence was never the claim on such a host;
    // the host's record being untouched across the transaction is what the verifier compares.
    const fixture = mkdtempSync(join(tmpdir(), "hepi-offline-pre-"));
    let result = null;
    try {
      const deb = buildPackage(fixture);
      const hostStatusFile = join(fixture, "status");
      writeFileSync(hostStatusFile, [
        "Package: hepi-offline-demo",
        "Status: install ok installed",
        "Priority: optional",
        "Section: utils",
        "Architecture: all",
        "Version: 1.0",
        "Maintainer: hepi",
        "Description: demo",
        "  a package the fixture host already has installed",
        "",
      ].join("\n"));
      result = await runOfflineInstall({ deb, packageName: "hepi-offline-demo", hostStatusFile });
      assert.equal(result.seeded, true, "the pre-installed record has to reach the private root's database");
      assert.equal(result.installExit, 0, "dpkg reported: " + result.installOutput);
      assert.equal(result.installed, true, "the run's own database states: " + result.state);
      assert.equal(result.verifyExit, 0, "dpkg -V disagrees with what it installed: " + result.verifyOutput);
      assert.equal(result.hostBefore.present, true, "the fixture host states the package as installed");
      assert.equal(result.hostAfter.record, result.hostBefore.record,
        "the transaction changed the host's own record: " + result.hostBefore.record + " -> " + result.hostAfter.record);
      assert.equal(spawnSync(join(result.root, "usr", "bin", "hepi-offline-demo"), [], { encoding: "utf8" }).status, 0,
        "the payload the transaction placed runs from its installed path");
    } finally {
      if (result !== null) cleanupInstallRoot(result.root);
      rmSync(fixture, { recursive: true, force: true });
    }
  });

/**
 * One executable at its installed path, no dependencies, no maintainer scripts: the smallest real package.
 *
 * `--root-owner-group` is required, not cosmetic: built as an ordinary user the tarball would record uid 1000, which a
 * private user namespace has no mapping for, and dpkg's own `chown` of the payload then fails with EINVAL. The real App
 * package carries root ownership already, which is why the same transaction succeeds for it.
 */
function buildPackage(fixture) {
  const pkg = join(fixture, "pkg");
  mkdirSync(join(pkg, "DEBIAN"), { recursive: true });
  mkdirSync(join(pkg, "usr", "bin"), { recursive: true });
  writeFileSync(join(pkg, "DEBIAN", "control"), [
    "Package: hepi-offline-demo",
    "Version: 1.0",
    "Architecture: all",
    "Maintainer: hepi",
    "Description: demo",
    "  a throwaway package for the offline install check",
    "",
  ].join("\n"));
  writeFileSync(join(pkg, "usr", "bin", "hepi-offline-demo"), "#!/bin/sh\necho demo\n", { mode: 0o755 });
  const out = join(fixture, "hepi-offline-demo_1.0_all.deb");
  const built = spawnSync("dpkg-deb", ["--build", "--root-owner-group", pkg, out], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  return out;
}
