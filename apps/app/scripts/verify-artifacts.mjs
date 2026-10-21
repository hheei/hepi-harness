/**
 * The production artifact test: install the package, start it, and make it talk to a Gateway.
 *
 * Every assertion below is made against the artifact this checkout produced — the `.deb` extracted into its real install
 * layout, the packaged binary executed from there — rather than against the sources that produced it. What it holds:
 *
 * - the package's own contents, architecture and dependencies;
 * - the shared libraries the packaged binary resolves;
 * - that neither the binary nor the embedded UI carries an internal credential or a Node/Next runtime;
 * - a **cold start with no connection**, which must render the configuration surface and say so;
 * - a **credential-store round trip across processes**: one process stores a connection, a second one starts from it, and
 *   the fixture Gateway sees the descriptor request arrive with `Origin: tauri://localhost` and the device bearer — which
 *   is only possible because the configured origin was named in the window's policy;
 * - a **cold start after forgetting it**, back to the configuration surface.
 *
 * **The credential store is this run's own.** The packaged binary's `--configure` and `--forget` write and delete
 * `dev.hepi.app/connection` in whatever Secret Service its environment names, so a run that inherited the developer's
 * `DBUS_SESSION_BUS_ADDRESS` would overwrite and delete the entry a real installed App on this machine lives on. Every
 * packaged run below therefore gets `scripts/lib/credential-sandbox.mjs`: a private session bus, a private keyring under a
 * temp `HOME`, and the report records the digest of the developer's own login keyring from before and after to state that
 * it was not the target. (The store cannot live in the log directory: a socket path there measured 146 bytes against the
 * kernel's 107-byte limit, and a bus that cannot bind looks like a store that never answered.)
 *
 * Installing needs root, which this run does not have, so the package is extracted into its real installed layout and the
 * packaged binary is executed from there. That is package contents plus packaged execution; it is not a system `dpkg -i`,
 * and the report says so.
 *
 * Usage: node apps/app/scripts/verify-artifacts.mjs [--artifact-dir=<dir>] [--log-dir=<dir>]
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CONNECTION_ATTRIBUTES, loginKeyringDigest, packagedEnvironment, startCredentialSandbox } from "../../../scripts/lib/credential-sandbox.mjs";
import { cleanupInstallRoot, installSupport, runOfflineInstall } from "./offline-install.mjs";
const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => args.find(a => a.startsWith("--" + name + "="))?.split("=").slice(1).join("=") ?? fallback;

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.resolve(arg("artifact-dir", await newestArtifactDir()));
const logDir = path.resolve(arg("log-dir", path.join(artifactDir, "verify-" + stamp)));
await mkdir(logDir, { recursive: true });

// Taken before any packaged process runs, so the report can state at the end that the developer's own login keyring —
// the store this test used to write into through the inherited session bus — is byte-for-byte what it found.
const keyringDigestBefore = loginKeyringDigest();

const assertions = [];
const assert = (name, ok, detail) => {
  assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 800) });
  return Boolean(ok);
};

async function newestArtifactDir() {
  const root = path.join(repo, ".dev", "artifacts");
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
  if (dirs.length === 0) throw new Error("no artifact directory under " + root + "; run scripts/build-artifacts.mjs first");
  const times = await Promise.all(dirs.map(async dir => [dir, (await stat(dir)).mtimeMs]));
  return times.sort((a, b) => b[1] - a[1])[0][0];
}

async function capture(name, command, commandArgs, options = {}) {
  const log = path.join(logDir, name + ".log");
  try {
    const result = await run(command, commandArgs, { maxBuffer: 64 * 1024 * 1024, ...options });
    await writeFile(log, String(result.stdout ?? "") + String(result.stderr ?? ""));
    return { ok: true, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), log };
  } catch (error) {
    await writeFile(log, String(error.stdout ?? "") + String(error.stderr ?? "") + String(error?.stack ?? error));
    return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), log };
  }
}

/** One command with something on stdin — how a device bearer reaches the shell without appearing in a process list. */
function captureWithInput(name, command, commandArgs, input, options = {}) {
  const log = path.join(logDir, name + ".log");
  return new Promise(resolve => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("exit", async code => {
      await writeFile(log, stdout + stderr);
      resolve({ ok: code === 0, stdout, stderr, log });
    });
    child.stdin.end(input);
  });
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

/** The fixture client ingress: enough of the real contract to see what the App sends, and to answer it. */
/**
 * A fixture ingress, optionally one that does not admit every bearer.
 *
 * `admitted` is what lets this test stand in for a Gateway whose device credential was revoked: the descriptor answers
 * 401 for a bearer it does not know and 200 for one it does, which is exactly the state ticket 19's recovery surface is
 * shown for. Without it the fixture admits everything, which is what the other packaged runs below need.
 */
function startFixtureIngress(options = {}) {
  const admitted = options.admitted ?? (() => true);
  const descriptor = options.descriptor ?? {
    backend: { id: "fixture-backend" },
    account: { scope: "fixture-account" },
    client: { kind: "device", id: "cred-fixture" },
    build: { id: "fixture" },
    capabilities: {},
  };
  const requests = [];
  const server = createServer((request, response) => {
    const headers = {
      "Access-Control-Allow-Origin": "tauri://localhost",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        origin: request.headers.origin ?? null,
        authorization: request.headers.authorization ?? null,
      });
      if (request.url?.startsWith("/api/descriptor") && !admitted(request.headers.authorization ?? "")) {
        // The refusal a revoked bearer gets: an answer, not an outage. The recovery surface is what must tell the two apart.
        response.writeHead(401, headers);
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = request.url?.startsWith("/api/descriptor")
        ? descriptor
        : request.url?.startsWith("/api/sessions")
          ? []
          : {};
      response.writeHead(200, headers);
      response.end(JSON.stringify(body));
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port }));
  });
}

/**
 * One Xvfb for this run, named so the App and `xdotool` share it.
 *
 * `xvfb-run` would pick its own display and keep it to the child, which leaves the driver typing into whatever display it
 * happens to have. A form is only driven through the real UI if both ends are on the same X server.
 */
async function startDisplay() {
  for (let number = 90; number < 100; number++) {
    const display = ":" + number;
    const child = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
    let alive = true;
    child.on("exit", () => { alive = false; });
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        await run("xdpyinfo", ["-display", display], { timeout: 5000 });
        return { display, stop: () => { if (alive) child.kill("SIGTERM"); } };
      } catch {
        // not up yet
      }
    }
    if (alive) child.kill("SIGTERM");
  }
  return null;
}

/** The window the packaged App opened, as X sees it, so a first-run form can be driven through the real UI. */
async function findWindow() {
  for (const name of ["Hepi", "Pi"]) {
    const found = await run("xdotool", ["search", "--name", name], { env: { ...process.env, DISPLAY: display.display } }).catch(() => ({ stdout: "" }));
    const id = String(found.stdout).trim().split("\n").filter(Boolean).pop();
    if (id !== undefined) return id;
  }
  return null;
}

/**
 * Fill the connection form the way a person does: focus the window, type the Gateway address and the device credential,
 * press Enter. It is the only path that proves the page's own `app_configure` command, its argument names and the restart
 * it triggers, rather than the CLI path beside it.
 *
 * Each field is cleared before it is typed into, because the replacement form starts from the stored profile and origin:
 * typing into a prefilled field would append to the address rather than replace it, and a driver that did that would be
 * testing a string no person could produce. The token field is empty on both surfaces — the refused credential is the
 * value being replaced — so clearing it is a no-op there.
 */
async function typeFirstRunForm(origin, token) {
  const window = await findWindow();
  if (window === null) return { ok: false, detail: "no window to type into" };
  const env = { ...process.env, DISPLAY: display.display };
  const clear = async () => run("xdotool", ["key", "--delay", "60", "ctrl+a"], { env });
  try {
    await run("xdotool", ["windowfocus", "--sync", window], { timeout: 10_000, env });
    await run("xdotool", ["key", "--delay", "60", "Tab", "Tab"], { env });
    await clear();
    await run("xdotool", ["type", "--delay", "30", origin], { env });
    await run("xdotool", ["key", "--delay", "60", "Tab"], { env });
    await clear();
    await run("xdotool", ["type", "--delay", "30", token], { env });
    await run("xdotool", ["key", "--delay", "60", "Return"], { env });
    return { ok: true, detail: "form submitted through window " + window };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

/**
 * One recovery step, driven through the real window with the keyboard.
 *
 * The ticket's acceptance is that the refusal's actions are reachable by keyboard, so this presses keys rather than calling
 * anything: the primary action is the focused control, and Enter on it is what a person does. The window is located again
 * because a refusal is shown by the document that mounted after the restart, which may be a different process.
 */
async function pressPrimaryAction() {
  const window = await findWindow();
  if (window === null) return { ok: false, detail: "no window to press a key in" };
  const env = { ...process.env, DISPLAY: display.display };
  try {
    await run("xdotool", ["windowfocus", "--sync", window], { timeout: 10_000, env });
    await run("xdotool", ["key", "--delay", "80", "Return"], { env });
    return { ok: true, detail: "Enter pressed in window " + window };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

/** One packaged run: start the extracted binary under Xvfb and read the lines it reports on stdout. */
function launch(binary, { logName, extraEnv = {} }) {
  // Asked before the process exists: a window run restarts into the stored connection, so it writes the same store the
  // headless paths do and must not be spawned with an environment that names somebody else's.
  const stdoutLog = createWriteStream(path.join(logDir, logName + ".stdout.log"));
  const stderrLog = createWriteStream(path.join(logDir, logName + ".stderr.log"));
  // Its own process group: configuring a connection restarts the App, and a restart that replaces the process must not
  // leave one behind holding the display.
  const child = spawn(binary, [], {
    detached: true,
    // The base is the run's private credential session, never `process.env`: the packaged binary's `--configure` and
    // `--forget` write to whatever Secret Service its environment names, and every window run below also restarts into a
    // stored connection.
    env: {
      ...packagedEnv(),
      // GTK otherwise picks a non-X backend on this host and the window never reaches the display the driver watches.
      GDK_BACKEND: "x11",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      ...extraEnv,
    },
  });
  const lines = [];
  let buffered = "";
  child.stdout.on("data", chunk => {
    stdoutLog.write(chunk);
    buffered += String(chunk);
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) {
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
    }
  });
  child.stderr.pipe(stderrLog);
  const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })));
  return {
    lines,
    async waitFor(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let quietSince = null;
      while (Date.now() < deadline) {
        const match = lines.find(predicate);
        if (match !== undefined) return match;
        // A restart replaces the process, so an exited child is not the end of the run: it is only over once nothing has
        // been written for a few seconds.
        quietSince = child.exitCode === null ? null : quietSince ?? Date.now();
        if (quietSince !== null && Date.now() - quietSince > 5000) return null;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return null;
    },
    async stop() {
      const signal = name => { try { process.kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } } };
      signal("SIGTERM");
      const stopped = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 4000))]);
      if (stopped === null) signal("SIGKILL");
      await exited;
      stdoutLog.end();
      stderrLog.end();
    },
  };
}

const report = {
  kind: "hepi-app-artifact-test",
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

const display = await startDisplay();

// The credential session every packaged run below is started under. It lives under this host's temp directory because a
// D-Bus socket path has to fit the kernel's limit — a log directory inside `.dev/verify/<run>/` does not — and the report
// states where it went when the run finished, so the developer's own store is never the one written to.
let credentials = null;
if (display !== null) {
  try {
    credentials = await startCredentialSandbox({ label: "artifact-cred", log: (line) => console.log("credential store: " + line) });
    report.credentialStore = { busAddress: credentials.busAddress, directory: credentials.directory, inheritedSessionBusUsed: false };
  } catch (error) {
    // No fallback to the session bus. The failure used to leave the run with an **empty** environment, and an empty
    // environment is not an isolated one: with no `DBUS_SESSION_BUS_ADDRESS` the Secret Service library still finds
    // `/run/user/<uid>/bus` — the developer's own running keyring — so the `--forget` below would delete a person's real
    // App connection while this report claimed no store was addressed. `packagedEnv` therefore throws unless it is handed
    // this run's own store, and every packaged spawn asks it for its environment: no store, no packaged process.
    report.credentialStore = { error: String(error?.message ?? error).slice(0, 400) };
  }
}

/** The environment of one packaged process: this run's Secret Service and this display, or a refusal that stops the run. */
function packagedEnv(extra = {}) {
  return packagedEnvironment(credentials, { ...(display === null ? {} : { DISPLAY: display.display }), ...extra });
}

let fixture = null;
try {
  if (display === null) throw new Error("no X display could be started for the packaged runs");
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
    const installed = await runOfflineInstall({ deb, packageName: "hepi" });
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
      try { await copyFile(installed.logFile, retained); retainedText = readFileSync(retained, "utf8"); }
      catch (error) { retainedText = "copy failed: " + String(error?.code ?? error?.message ?? error); }
      report.offlineDpkgInstall.log = retained;
      assert("the-dpkg-transaction-log-survives-the-private-root", /status installed hepi:/.test(retainedText),
        retainedText.trim().split("\n").slice(-2).join(" | ") || retainedText);
      cleanupInstallRoot(installed.root);
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
  fixture = await startFixtureIngress();
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
  const formFixture = await startFixtureIngress();
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
  formFixture.server.closeAllConnections?.();
  formFixture.server.close();
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
  const refusedFixture = await startFixtureIngress({ admitted: authorization => authorization !== "Bearer " + revokedToken });
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
  const replaceFixture = await startFixtureIngress({
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
  replaceFixture.server.closeAllConnections?.();
  replaceFixture.server.close();
  refusedFixture.server.closeAllConnections?.();
  refusedFixture.server.close();

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
  await credentials?.stop();
  report.loginKeyringAfterRun = loginKeyringDigest() ?? "absent";
  report.loginKeyringUntouched = (keyringDigestBefore ?? "absent") === report.loginKeyringAfterRun;
  // Where the run's store went, stated rather than left to a reader: this caller does not retain it, so the path it lived
  // at is gone with the run and the report says which is which.
  if (report.credentialStore !== null && credentials !== null) {
    report.credentialStore.retained = credentials.keepStore ? credentials.storedAt : "removed with the run";
  }
  assert("packaged-runs-addressed-a-private-credential-store", credentials !== null && credentials.env.DBUS_SESSION_BUS_ADDRESS === credentials.busAddress, JSON.stringify(report.credentialStore));
  assert("developer-login-keyring-unchanged", report.loginKeyringUntouched === true, report.loginKeyringBeforeRun.slice(0, 12) + "… -> " + report.loginKeyringAfterRun.slice(0, 12) + "…");
  fixture?.server.closeAllConnections?.();
  fixture?.server.close();
  display?.stop();
}

report.passed = assertions.filter(a => a.ok).length;
report.failed = assertions.filter(a => !a.ok).map(a => a.name);
await writeFile(path.join(logDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ logDir, passed: report.passed, failed: report.failed }, null, 2));
// An explicit exit: the launched App's own process group can outlive the assertions, and a report that exists but never
// returns is not a check anyone can run.
process.exit(report.failed.length === 0 ? 0 : 1);
