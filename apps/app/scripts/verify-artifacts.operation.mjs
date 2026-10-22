/**
 * The artifact verification operation: one packaged App, checked end to end, and the evidence it leaves.
 *
 * The operational entry point resolves the flags and exits; everything a run of the packaged artifact does lives here,
 * so importing this module performs no artifact lookup, creates no directory, spawns nothing and never exits. What the
 * operation holds: the package's contents, architecture and dependencies; the shared libraries the packaged binary
 * resolves; that neither the binary nor the embedded UI carries an internal credential or a Node/Next runtime; a cold
 * start with no connection; a credential-store round trip across processes; the first-run form driven through the real
 * window; the refused-connection recovery; and a cold start after forgetting the connection.
 *
 * Every packaged run is addressed to this run's own Secret Service (`scripts/lib/credential-sandbox.mjs`) and this run's
 * own Xvfb, and the report states the developer's login keyring digest from before and after, so the store a real
 * installed App lives on is provably not the target. The package is extracted into its real install layout, and where
 * the host allows it a real dpkg transaction runs over a private root (`offline-install.mjs`); the report says which
 * happened rather than letting extraction stand in for an install.
 *
 * The journey is written as the product operations a person meets: inspect the prebuilt artifact, cold start
 * unconfigured, configure into this run's private store, restart and observe the fixture, forget, cold start
 * unconfigured, dispose, publish evidence. That order is the check. The report and the raw logs are the artifact's
 * evidence, and they are finalized only after the teardown above them has completed.
 */
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, createReadStream, mkdirSync, readFileSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { CONNECTION_ATTRIBUTES, loginKeyringDigest } from "../../../scripts/lib/credential-sandbox.mjs";
import { installSupport } from "./offline-install.mjs";

import { createPackagedRun } from "./packaged-run.mjs";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

/** The report kind, unchanged: an existing report stays readable by whoever already parses it. */
const REPORT_KIND = "hepi-app-artifact-test";

/**
 * The assertions one run records, in the order it made them.
 *
 * A detail is stated as text and bounded, because it is written into the report: one runaway value must not bury the
 * other assertions, and an absent detail is an empty string rather than the word null.
 */
export function createAssertions() {
  const entries = [];
  const assert = (name, ok, detail) => {
    entries.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 800) });
    return Boolean(ok);
  };
  return { entries, assert };
}

/** What a finished run states about its assertions: how many passed, and which failed, by name. */
export function summarize(assertions) {
  return {
    passed: assertions.filter(a => a.ok).length,
    failed: assertions.filter(a => !a.ok).map(a => a.name),
  };
}

/**
 * The artifact a run with no artifact-dir verifies: the newest directory this checkout built under its own .dev
 * artifacts directory, so a bare invocation checks the artifact that was just produced.
 */
export async function newestArtifactDir() {
  const root = path.join(repo, ".dev", "artifacts");
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
  if (dirs.length === 0) throw new Error("no artifact directory under " + root + "; run scripts/build-artifacts.mjs first");
  const times = await Promise.all(dirs.map(async dir => [dir, (await stat(dir)).mtimeMs]));
  return times.sort((a, b) => b[1] - a[1])[0][0];
}

/** Whether a command exists on this run's PATH. */
function executableOnPath(name) {
  return spawnSync("sh", ["-c", "command -v " + name], { encoding: "utf8" }).status === 0;
}

/** The kernel's own answer about unprivileged user namespaces; an absent switch is not evidence they are on. */
function readUsernsSwitch() {
  for (const file of ["/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces"]) {
    try { if (Number(readFileSync(file, "utf8").trim()) > 0) return true; } catch { /* the next path decides */ }
  }
  return false;
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", resolve).on("error", reject));
  return hash.digest("hex");
}

/**
 * Verify one prebuilt App artifact, and return the completed report.
 *
 * The artifact directory is one this checkout's build-artifacts.mjs produced; the log directory is created here and
 * holds every raw log, screenshot and the report itself. The caller owns the process: this operation returns once the
 * run's display, fixture listeners and packaged process groups have been stopped and the evidence is written.
 */
export async function runArtifactVerification({ artifactDir, logDir }) {
  mkdirSync(logDir, { recursive: true });

  // Taken before any packaged process runs, so the report can state at the end that the developer's own login keyring —
  // the store this test used to write into through the inherited session bus — is byte-for-byte what it found.
  const keyringDigestBefore = loginKeyringDigest();

  const { entries: assertions, assert } = createAssertions();

  async function capture(name, command, commandArgs, options = {}) {
    const log = path.join(logDir, name + ".log");
    try {
      const result = await run(command, commandArgs, { maxBuffer: 64 * 1024 * 1024, ...options });
      await writeFile(log, String(result.stdout ?? "") + String(result.stderr ?? ""));
      return { ok: true, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
    } catch (error) {
      await writeFile(log, String(error.stdout ?? "") + String(error.stderr ?? "") + String(error?.stack ?? error));
      return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
    }
  }

  const report = {
    kind: REPORT_KIND,
    artifactDir,
    logDir,
    ranAt: new Date().toISOString(),
    systemInstall: false,
    // Replaced by the transaction below when the host can run one. Initialised so a run that failed earlier still states
    // that no install was claimed, rather than leaving the field absent.
    offlineDpkgInstall: { supported: false, reason: "not reached: the run failed before the install step" },
    // The credential store the packaged runs were addressed to, and the one they were not: the developer's own login
    // keyring is digested before the first write and after the last, so the report can state that the real store was left
    // alone rather than a reader having to trust the environment variables.
    credentialStore: null,
    loginKeyringBeforeRun: keyringDigestBefore ?? "absent",
    assertions,
    requests: [],
  };

  const environment = createPackagedRun({ logDir });
  const { packagedEnv, captureWithInput, launch, typeFirstRunForm, pressPrimaryAction } = environment;
  let credentials = null;
  try {
    await environment.start();
    credentials = environment.credentials;
    report.credentialStore = { busAddress: credentials.busAddress, directory: credentials.directory, inheritedSessionBusUsed: false };
    const provenance = JSON.parse(await readFile(path.join(artifactDir, "provenance.json"), "utf8"));
    const debName = (await readdir(artifactDir)).find(name => name.endsWith(".deb"));
    const deb = path.join(artifactDir, debName);
    const packageJson = JSON.parse(await readFile(path.join(repo, "apps", "app", "package.json"), "utf8"));

    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
    assert("provenance-names-the-built-revision", provenance.revision === head, provenance.revision + " (HEAD " + head + ")");
    assert("provenance-records-the-toolchain", Boolean(provenance.toolchain?.rustc && provenance.toolchain?.webkit2gtk), JSON.stringify(provenance.toolchain ?? {}));
    assert("provenance-records-checksums", Array.isArray(provenance.artifacts) && provenance.artifacts.every(a => /^[0-9a-f]{64}$/.test(a.sha256)), (provenance.artifacts ?? []).map(a => a.path).join(", "));

    const recorded = provenance.artifacts.find(a => a.path === debName);
    assert("checksum-matches-the-record", recorded !== undefined && recorded.sha256 === await sha256(deb), recorded?.sha256 ?? "not recorded");

    const info = await capture("dpkg-deb-info", "dpkg-deb", ["-I", deb]);
    assert("deb-declares-amd64", /Architecture: amd64/.test(info.stdout), info.stdout.split("\n").filter(l => l.includes("Architecture")).join(" "));
    assert("deb-version-matches-the-package", new RegExp("Version: " + packageJson.version).test(info.stdout), packageJson.version);
    assert("deb-depends-on-the-webview", /libwebkit2gtk-4\.1-0/.test(info.stdout), info.stdout.split("\n").filter(l => l.includes("Depends")).join(" "));

    const contents = await capture("dpkg-deb-contents", "dpkg-deb", ["-c", deb]);
    assert("deb-installs-the-binary", /usr\/bin\/hepi-app/.test(contents.stdout), "usr/bin/hepi-app");
    assert("deb-installs-a-desktop-entry", /usr\/share\/applications\/.*\.desktop/.test(contents.stdout), "desktop entry present");
    assert("deb-installs-an-icon", /usr\/share\/icons\/.*\.png/.test(contents.stdout), "icon present");
    assert("deb-carries-no-node-runtime", !/node_modules|\/\.next\/|node\/bin/.test(contents.stdout), "no Node/Next payload");

    const extractDir = path.join(logDir, "extract");
    const unpack = await capture("dpkg-deb-extract", "dpkg-deb", ["-x", deb, extractDir]);
    const binary = path.join(extractDir, "usr", "bin", "hepi-app");
    assert("packaged-binary-present", unpack.ok && (await stat(binary)).isFile(), binary);

    const ldd = await capture("ldd-packaged-binary", "ldd", [binary]);
    const missing = ldd.stdout.split("\n").filter(line => line.includes("not found"));
    assert("packaged-binary-resolves-its-libraries", missing.length === 0, missing.join("; ") || "all shared libraries resolved");

    // What may not travel in the artifact. The device bearer is issued per install and stored in the credential store, so no
    // internal credential of any kind has a reason to be here.
    const strings = await capture("strings-packaged-binary", "strings", [binary]);
    for (const name of ["HEPI_AUTH_TOKEN", "HEPI_INGRESS_SERVICE_TOKEN", "HEPI_WEB_LOGIN_TOKEN", "serviceToken"]) {
      assert("no-internal-credential-" + name, !strings.stdout.includes(name), name);
    }
    assert("no-next-runtime-in-the-binary", !strings.stdout.includes("next/dist/compiled"), "next/dist/compiled");

    // --- A real dpkg transaction, over a root this run owns.
    //
    // The three statements extraction cannot make: that the package's dependencies resolve, that dpkg's own database
    // reaches `install ok installed`, and that the payload the transaction placed — not a directory this script unpacked —
    // is a binary that runs. dpkg is then asked, in its own words, whether those files are still what it installed.
    const host = { hasDpkg: executableOnPath("dpkg"), hasBwrap: executableOnPath("bwrap"), unprivilegedUserns: readUsernsSwitch() };
    const support = installSupport(host);
    report.offlineDpkgInstall = { ...support, host };
    if (support.supported) {
      const installed = await environment.install(deb);
      report.offlineDpkgInstall.seededFromHostStatus = installed.seeded;
      report.offlineDpkgInstall.hostPackageBefore = installed.hostBefore.record;
      report.offlineDpkgInstall.hostPackageAfter = installed.hostAfter.record;
      report.offlineDpkgInstall.dpkgState = installed.state;
      report.offlineDpkgInstall.installExit = installed.installExit;
      report.offlineDpkgInstall.verifyExit = installed.verifyExit;
      try {
        assert("dpkg-transaction-reaches-installed-state", installed.installExit === 0 && installed.installed,
          installed.state + " | " + installed.installOutput.slice(-400));
        assert("dpkg-verify-agrees-with-what-it-installed", installed.verifyExit === 0, installed.verifyOutput.slice(-400) || "clean");
        // The binary the transaction placed executes, and its credential operation lands in the store this run owns — the
        // same isolation rule the extracted runs follow, now applied to the installed path.
        const fromInstalled = await capture("installed-binary-forget", installed.payload, ["--forget"], { env: packagedEnv(), timeout: 60_000 });
        assert("the-installed-binary-executes-into-this-run's-own-store", fromInstalled.stdout.includes("HEPI_APP_FORGET ok")
          && credentials.search(CONNECTION_ATTRIBUTES).unlocked.length === 0,
          fromInstalled.stdout.trim().slice(0, 160) + " | store " + JSON.stringify(credentials.search(CONNECTION_ATTRIBUTES)));
        // Nothing reached the host's own packaging state. The claim is the host's record of this package **before and after**
        // the transaction, compared as read: on a workstation that already runs the App the host does name the package, and
        // "absent" there would be a false statement — the passing claim is that a real transaction left its record alone.
        assert("the-host's-own-dpkg-record-of-this-package-is-unchanged",
          installed.hostAfter.readable && installed.hostBefore.readable && installed.hostAfter.record === installed.hostBefore.record,
          installed.hostBefore.record + " -> " + installed.hostAfter.record);
      } finally {
        // The transaction's own log is dpkg's record of its status transitions, and it lives inside the root this run
        // removes. Copy it out **before** cleanup, then assert the copy: an assertion that the log existed inside a tree
        // about to be deleted would be a statement no later reader could check.
        const retained = path.join(logDir, "dpkg-transaction.log");
        let retainedText = "";
        try { copyFileSync(installed.logFile, retained); retainedText = readFileSync(retained, "utf8"); }
        catch (error) { retainedText = "copy failed: " + String(error?.code ?? error?.message ?? error); }
        report.offlineDpkgInstall.log = retained;
        assert("the-dpkg-transaction-log-survives-the-private-root", /status installed hepi:/.test(retainedText),
          retainedText.trim().split("\n").slice(-2).join(" | ") || retainedText);
        environment.releaseInstall(installed);
        report.offlineDpkgInstall.root = installed.root;
        report.offlineDpkgInstall.rootRemoved = true;
      }
    } else {
      // Stated as the limit it is, in the run's own output, so no reader has to infer which half happened.
      console.log("  note  no dpkg transaction on this host: " + support.reason + " — the layout checks above are extraction only");
    }

    // A first run with no connection: the configuration surface, reported by the page that mounted it.
    //
    // The store is confirmed empty through the Secret Service's own answer before anything is written: an entry already
    // there would mean this run was looking at somebody else's keyring, and the `--forget` below would be deleting it.
    const beforeStore = credentials?.search(CONNECTION_ATTRIBUTES);
    assert("the-run's-store-starts-empty", beforeStore !== undefined && beforeStore.unlocked.length === 0 && beforeStore.locked.length === 0, JSON.stringify(beforeStore));
    await capture("forget-before-cold-start", binary, ["--forget"], { env: packagedEnv() });
    const cold = launch(binary, { logName: "cold-start-unconfigured" });
    const unconfigured = await cold.waitFor(line => line.includes('"surface":"configure"'), 120_000);
    assert("cold-start-renders-the-configuration-surface", unconfigured !== null, unconfigured ?? "no configuration readiness line within 120s");
    assert("cold-start-states-no-connection", unconfigured !== null && !/"backend":"[^"]/.test(unconfigured) && !/"client":"[^"]/.test(unconfigured), unconfigured ?? "no line to read");
    const buildLine = cold.lines.find(line => line.startsWith("HEPI_APP_BUILD"));
    assert("packaged-binary-reports-its-build", buildLine !== undefined && buildLine.includes(provenance.revision.slice(0, 12)), buildLine ?? "no build line");
    await cold.stop();

    // The credential-store round trip, across processes: this process stores a connection, the App process reads it.
    const fixture = await environment.startFixture();
    const token = "device-" + randomBytes(12).toString("hex");
    const configured = await captureWithInput("configure-connection", binary, ["--configure"], JSON.stringify({
      profile: "fixture",
      origin: "http://127.0.0.1:" + fixture.port,
      token,
    }), { env: packagedEnv() });
    assert("configure-stores-the-connection", configured.ok && configured.stdout.includes("HEPI_APP_CONFIGURE ok"), configured.stdout.trim() || configured.stderr.trim());
    // The entry the packaged binary wrote is located in this run's own store, so "the store round trip" is about a named
    // entry rather than about an exit code.
    const written = await (async () => {
      const until = Date.now() + 10_000;
      for (;;) {
        const found = credentials?.search(CONNECTION_ATTRIBUTES) ?? { unlocked: [], locked: [], error: "no credential store was started" };
        if (found.unlocked.length + found.locked.length > 0 || found.error !== undefined || Date.now() > until) return found;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    })();
    assert("the-stored-entry-is-in-the-run's-own-store", written.unlocked.length + written.locked.length > 0, JSON.stringify(written));

    const configuredRun = launch(binary, { logName: "cold-start-configured" });
    // The admitted state, not the first readiness line: the page now reports `connecting` when it mounts and only names a
    // workbench once its own descriptor read has been admitted.
    const workbench = await configuredRun.waitFor(line => line.includes('"surface":"workbench"'), 120_000);
    assert("cold-start-with-a-stored-connection-renders-the-workbench", workbench?.includes('"surface":"workbench"') === true, workbench ?? "no readiness line within 120s");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !fixture.requests.some(r => r.url?.startsWith("/api/descriptor"))) await new Promise(r => setTimeout(r, 250));
    await configuredRun.stop();

    report.requests = fixture.requests;
    const descriptor = fixture.requests.find(request => request.url?.startsWith("/api/descriptor"));
    assert("the-app-reads-the-descriptor-from-the-configured-gateway", descriptor !== undefined, JSON.stringify(fixture.requests.slice(0, 5)));
    assert("the-request-comes-from-the-tauri-origin", descriptor?.origin === "tauri://localhost", String(descriptor?.origin));
    assert("the-request-carries-the-stored-device-bearer", descriptor?.authorization === "Bearer " + token, String(descriptor?.authorization));
    assert("the-bearer-is-not-in-the-binary", !strings.stdout.includes(token), "the token only exists after this run issued it");

    // The same round trip through the page's own surface: an unconfigured install is configured by typing into the form,
    // which is what a person does on first use. The CLI path above proves the store; this proves the page reaches it.
    const formFixture = await environment.startFixture();
    const formToken = "device-" + randomBytes(12).toString("hex");
    const formOrigin = "http://127.0.0.1:" + formFixture.port;
    await capture("forget-before-first-run", binary, ["--forget"], { env: packagedEnv() });
    const firstRun = launch(binary, { logName: "first-run-form" });
    const firstRunSurface = await firstRun.waitFor(line => line.includes('"surface":"configure"'), 120_000);
    assert("first-run-shows-the-configuration-surface", firstRunSurface?.includes('"surface":"configure"') === true, firstRunSurface ?? "no readiness line within 120s");
    const typed = await typeFirstRunForm(formOrigin, formToken);
    const afterForm = typed.ok ? await firstRun.waitFor(line => line.includes('"surface":"workbench"'), 120_000) : null;
    assert("first-run-form-configures-the-app", afterForm !== null, typed.detail + " | " + String(afterForm));
    const formDeadline = Date.now() + 30_000;
    while (Date.now() < formDeadline && !formFixture.requests.some(r => r.url?.startsWith("/api/descriptor"))) await new Promise(r => setTimeout(r, 250));
    await firstRun.stop();
    const formDescriptor = formFixture.requests.find(request => request.url?.startsWith("/api/descriptor"));
    assert("first-run-connection-reaches-the-typed-gateway", formDescriptor !== undefined, JSON.stringify(formFixture.requests.slice(0, 5)));
    assert("first-run-connection-carries-the-typed-credential", formDescriptor?.authorization === "Bearer " + formToken, String(formDescriptor?.authorization));
    assert("first-run-connection-comes-from-the-tauri-origin", formDescriptor?.origin === "tauri://localhost", String(formDescriptor?.origin));
    await capture("forget-after-first-run", binary, ["--forget"], { env: packagedEnv() });

    // --- A refused connection, and the recovery it offers.
    //
    // A stored bearer the Gateway does not admit is the state ticket 19 exists for: before it, the App rendered a refusal
    // paragraph with nothing to press, and the only way out was a command line. What is asserted here is the packaged
    // behaviour, in the order a person meets it — the refusal is stated, its primary action is reachable by the keyboard, the
    // form it opens keeps the stored connection, and a replacement is admitted by the new credential alone.
    const revokedToken = "device-" + randomBytes(12).toString("hex");
    const admittedToken = "device-" + randomBytes(12).toString("hex");
    // One Gateway that does not know this bearer — a revoked credential is an answer, not an outage — and one that admits
    // the replacement. They are separate servers so the refusal cannot be explained by a fixture that changed its mind.
    const refusedFixture = await environment.startFixture({ admitted: authorization => authorization !== "Bearer " + revokedToken });
    const revoked = await captureWithInput("configure-revoked-connection", binary, ["--configure"], JSON.stringify({
      profile: "revoked",
      origin: "http://127.0.0.1:" + refusedFixture.port,
      token: revokedToken,
    }), { env: packagedEnv() });
    assert("a-revoked-connection-can-be-stored", revoked.ok && revoked.stdout.includes("HEPI_APP_CONFIGURE ok"), revoked.stdout.trim() || revoked.stderr.trim());
    const refusedRun = launch(binary, { logName: "cold-start-refused" });
    const refused = await refusedRun.waitFor(line => line.includes('"surface":"refused"'), 120_000);
    assert("a-refused-connection-is-reported-as-refused", refused !== null, refused ?? "no refusal readiness line within 120s");
    assert("a-refusal-names-no-connection", refused !== null && !/"backend":"[^"]/.test(refused) && !/"client":"[^"]/.test(refused),
      refused ?? "no line to read");
    assert("a-refusal-states-the-credential-as-its-reason", refused !== null && /credential/i.test(refused), refused ?? "no line to read");
    // The refusal surface's primary action is a focused control, and opening the replacement form is not a deletion: the
    // stored entry is read before and after the keypress. A surface that had to forget the connection first would leave the
    // store empty here, and a cancellation after that would be a lost connection rather than a kept one.
    const beforePress = credentials?.search(CONNECTION_ATTRIBUTES);
    const pressed = await pressPrimaryAction();
    const afterPress = credentials?.search(CONNECTION_ATTRIBUTES);
    assert("the-refusal-primary-action-is-reachable-by-keyboard", pressed.ok, pressed.detail);
    assert("opening-the-replacement-form-does-not-delete-the-stored-connection",
      (beforePress?.unlocked.length ?? 0) + (beforePress?.locked.length ?? 0) > 0
        && (afterPress?.unlocked.length ?? 0) + (afterPress?.locked.length ?? 0) > 0,
      JSON.stringify({ beforePress, afterPress }));
    assert("the-refused-gateway-saw-the-descriptor-read-it-refused",
      refusedFixture.requests.some(request => request.url?.startsWith("/api/descriptor") && request.authorization === "Bearer " + revokedToken),
      JSON.stringify(refusedFixture.requests.slice(0, 5)));
    await refusedRun.stop();
    // The refused Gateway stays up through the replacement below: a closed one would make the stored connection *unreachable*
    // rather than *refused*, which is the other recovery state and a different primary action.

    // Replacing it: the form's own `app_configure`, driven through the window, with a credential the fixture admits. The
    // readiness line after the restart is the *new* connection's — the profile, backend, scope and client the fixture named
    // — so a replacement cannot be reported as connected on the old descriptor.
    // A second Gateway with its own identity, so the admitted readout proves the replacement's descriptor was read: a run
    // that carried the refused connection's descriptor over would report the first fixture's Backend and client here.
    const replaceFixture = await environment.startFixture({
      admitted: authorization => authorization === "Bearer " + admittedToken,
      descriptor: {
        backend: { id: "replacement-backend" },
        account: { scope: "replacement-account" },
        client: { kind: "device", id: "cred-replacement" },
        build: { id: "fixture" },
        capabilities: {},
      },
    });
    const replaceRun = launch(binary, { logName: "refused-replace" });
    await replaceRun.waitFor(line => line.includes('"surface":"refused"'), 120_000);
    const openedForm = await pressPrimaryAction();
    const typedReplace = openedForm.ok ? await typeFirstRunForm("http://127.0.0.1:" + replaceFixture.port, admittedToken) : { ok: false, detail: "no form was opened" };
    const replaced = typedReplace.ok ? await replaceRun.waitFor(line => line.includes('"surface":"workbench"'), 120_000) : null;
    assert("replacing-a-refused-connection-admits-the-new-credential", replaced !== null, typedReplace.detail + " | " + String(replaced));
    // The profile is the one the form was typed with, and the identity is the one this fixture admitted — not the revoked
    // connection's. A run that carried the old descriptor over would report the old profile here.
    const replacement = replaceFixture.requests.find(request => request.url?.startsWith("/api/descriptor"));
    assert("the-replacement-request-carries-the-new-bearer", replacement?.authorization === "Bearer " + admittedToken, String(replacement?.authorization));
    assert("the-replacement-is-reported-as-the-admitted-connection",
      replaced !== null
        && replaced.includes('"backend":"replacement-backend"')
        && replaced.includes('"scope":"replacement-account"')
        && replaced.includes('"client":"device:cred-replacement"'),
      replaced ?? "no admitted line");
    await replaceRun.stop();

    // Forgetting it is a real state change: the next start is unconfigured again.
    const forgotten = await capture("forget-after-use", binary, ["--forget"], { env: packagedEnv() });
    assert("forget-removes-the-connection", forgotten.ok && forgotten.stdout.includes("HEPI_APP_FORGET ok"), forgotten.stdout.trim() || forgotten.stderr.trim());
    assert("forget-emptied-the-run's-own-store", credentials?.search(CONNECTION_ATTRIBUTES).unlocked.length === 0, JSON.stringify(credentials?.search(CONNECTION_ATTRIBUTES)));
    const afterForget = launch(binary, { logName: "cold-start-after-forget" });
    const unconfiguredAgain = await afterForget.waitFor(line => line.includes('"surface":"configure"'), 120_000);
    assert("cold-start-after-forget-is-unconfigured", unconfiguredAgain?.includes('"surface":"configure"') === true, unconfiguredAgain ?? "no readiness line within 120s");
    await afterForget.stop();
  } catch (error) {
    await writeFile(path.join(logDir, "verify-error.log"), String(error?.stack ?? error));
    assertions.push({ name: "artifact-test-ran-to-completion", ok: false, detail: String(error?.message ?? error).slice(0, 800) });
  } finally {
    // `packaged-runs-addressed-a-private-credential-store` below is what a reader checks this against: when the store could
    // not start, the first packaged spawn threw here and no credential process ran at all.
    // The packaged binary's credential operations are the point of this test, so every one of them ran under the private
    // store; the store is stopped first so nothing can write to it after the digest below is taken.
    // Awaited: the store's daemons have to be gone before its tree is moved or removed, or the shutdown races a live
    // daemon that recreates directories under it.
    try {
      report.runCleanup = await environment.stop();
    } catch (error) {
      report.runCleanup = { completed: false, error: String(error?.message ?? error) };
      assert("packaged-run-cleanup-completed", false, String(error?.stack ?? error));
    }
    report.loginKeyringAfterRun = loginKeyringDigest() ?? "absent";
    report.loginKeyringUntouched = (keyringDigestBefore ?? "absent") === report.loginKeyringAfterRun;
    // Where the run's store went, stated rather than left to a reader: this caller does not retain it, so the path it lived
    // at is gone with the run and the report says which is which.
    if (report.credentialStore !== null && credentials !== null) {
      report.credentialStore.retained = credentials.keepStore ? credentials.storedAt : "removed with the run";
    }
    assert("packaged-runs-addressed-a-private-credential-store", credentials !== null && credentials.env.DBUS_SESSION_BUS_ADDRESS === credentials.busAddress, JSON.stringify(report.credentialStore));
    assert("developer-login-keyring-unchanged", report.loginKeyringUntouched === true, report.loginKeyringBeforeRun.slice(0, 12) + "… -> " + report.loginKeyringAfterRun.slice(0, 12) + "…");
  }

  // Finalized after the teardown above: a report that exists is not by itself proof the run finished, so the counts
  // and the file are written only once the display, listeners and packaged groups are gone.
  Object.assign(report, summarize(assertions));
  await writeFile(path.join(logDir, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
