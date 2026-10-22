import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { packagedEnvironment, startCredentialSandbox } from "../../../scripts/lib/credential-sandbox.mjs";
import { cleanupInstallRoot, runOfflineInstall } from "./offline-install.mjs";

const run = promisify(execFile);

/**
 * The fixture client ingress: enough of the real contract to see what the App sends, and to answer it.
 *
 * It is optionally one that does not admit every bearer.
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

/** Private lifetime of one artifact journey; product assertions stay in the operation. */
export function createPackagedRun({ logDir }) {
  let display = null;
  let credentials = null;
  const fixtures = new Set();
  const runs = new Set();
  const installRoots = new Set();

  function packagedEnv(extra = {}) {
    return packagedEnvironment(credentials, { ...(display === null ? {} : { DISPLAY: display.display }), ...extra });
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

  /**
   * One Xvfb for this run, named so the App and `xdotool` share it.
   *
   * `xvfb-run` would pick its own display and keep it to the child, which leaves the driver typing into whatever display it
   * happens to have. A form is only driven through the real UI if both ends are on the same X server.
   */
  async function startDisplay() {
    const child = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const closed = new Promise(resolve => {
      child.once("error", resolve);
      child.once("exit", resolve);
    });
    async function stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      let timeout;
      const result = await Promise.race([closed.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), 4000); })]);
      clearTimeout(timeout);
      if (!result) { child.kill("SIGKILL"); await closed; }
    }
    let timer;
    const number = await Promise.race([
      new Promise(resolve => child.stdio[3].once("data", data => resolve(String(data).trim()))),
      closed.then(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    clearTimeout(timer);
    if (number === null || !/^\d+$/.test(number)) { await stop(); return null; }
    return { display: ":" + number, stop };
  }

  /** The window the packaged App opened, as X sees it, so a first-run form can be driven through the real UI. */
  async function findWindow() {
    const found = await run("xdotool", ["search", "--name", "Hepi"], { env: { ...process.env, DISPLAY: display.display } }).catch(() => ({ stdout: "" }));
    return String(found.stdout).trim().split("\n").filter(Boolean).pop() ?? null;
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
  function launch(binary, { logName }) {
    const env = packagedEnv({
      GDK_BACKEND: "x11",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    });
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
      env,
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
    let launchError = null;
    child.once("error", error => { launchError = error; });
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const packagedRun = {
      lines,
      async waitFor(predicate, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let quietSince = null;
        while (Date.now() < deadline) {
          if (launchError !== null) throw launchError;
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
        let timer;
        const stopped = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })]);
        clearTimeout(timer);
        if (stopped === null) signal("SIGKILL");
        await closed;
        stdoutLog.end();
        stderrLog.end();
        await Promise.all([finished(stdoutLog), finished(stderrLog)]);
        runs.delete(packagedRun);
      },
    };
    runs.add(packagedRun);
    return packagedRun;
  }

  return {
    get credentials() { return credentials; },
    packagedEnv,
    captureWithInput,
    launch,
    typeFirstRunForm,
    pressPrimaryAction,
    async start() {
      display = await startDisplay();
      if (display === null) throw new Error("no X display could be started for the packaged runs");
      credentials = await startCredentialSandbox({ label: "artifact-cred", log: line => console.log("credential store: " + line) });
    },
    async startFixture(options) {
      const fixture = await startFixtureIngress(options);
      fixtures.add(fixture);
      return fixture;
    },
    async install(deb) {
      const installed = await runOfflineInstall({ deb, packageName: "hepi" });
      installRoots.add(installed.root);
      return installed;
    },
    releaseInstall(installed) {
      cleanupInstallRoot(installed.root);
      installRoots.delete(installed.root);
    },
    async stop() {
      const failures = [];
      for (const packagedRun of runs) {
        try { await packagedRun.stop(); } catch (error) { failures.push(error); }
      }
      for (const fixture of fixtures) {
        try {
          fixture.server.closeAllConnections?.();
          if (fixture.server.listening) await new Promise((resolve, reject) => fixture.server.close(error => error ? reject(error) : resolve()));
        } catch (error) { failures.push(error); }
      }
      try { await credentials?.stop(); } catch (error) { failures.push(error); }
      try { await display?.stop(); } catch (error) { failures.push(error); }
      for (const installRoot of installRoots) {
        try { cleanupInstallRoot(installRoot); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "packaged run cleanup failed");
      return { completed: true };
    },
  };
}
