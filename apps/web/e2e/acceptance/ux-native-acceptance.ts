/**
 * Ticket 16's native half: the packaged App shell (WebKitGTK + Tauri) against the same real system, in DEBUG, inside a
 * credential store this run owns.
 *
 * This is the separate, separately-labelled counterpart to ux-client-acceptance.ts. That driver loads the App's bundle
 * in Chromium, which states the App host's own logic (HashRouter, device bearer, the ingress origin list) but says
 * nothing about the native shell: WebKitGTK, the Rust process, the credential store, the CSP the shell writes before the
 * window exists and the Tauri IPC are all absent there. This driver starts the real binary and reads what it reports.
 *
 * **It owns its credential store.** The shell keeps its connection in the OS credential store — `keyring` → Secret
 * Service on the session bus — and the two headless operations this run performs write there: `--configure` stores
 * `dev.hepi.app/connection` and `--forget` deletes it. Inheriting the developer's `DBUS_SESSION_BUS_ADDRESS` therefore
 * made the acceptance run read, overwrite and delete the **real** user's entry for that pair, which is a destructive act
 * against a person's own installed App rather than a test of this one. Every process that touches the store now runs
 * under `scripts/lib/credential-sandbox.ts`: a private session bus, a private gnome-keyring with its own unlocked
 * `login` collection under a temp `HOME`, and no ambient bus, keyring control socket or XDG directory reaching a child.
 * The driver states the two addresses it did not use and checks that the developer's own keyring file is byte-for-byte
 * what it was before the run.
 *
 * It is a DEBUG build. The shell is compiled with Cargo's dev profile (symbols retained, no LTO, no release
 * optimisation), because this workflow needs a fast, debuggable binary rather than a release artifact. Everything below is
 * therefore native FUNCTIONAL evidence: the real shell renders, stores a credential, restarts into it and reaches a real
 * ingress. It is not release-performance evidence, and no timing or memory number here is a production claim.
 *
 * Four kinds of statement are kept apart, because they are not equally strong:
 *
 *   - **A transport observation from inside the rendered document.** `HEPI_APP_READY {"surface":…,"backend":…,"scope":…,
 *     "client":…,"profile":…,"reason":…}` is printed by the App's own bundle (apps/app/src/main.tsx) over the shell's IPC.
 *     The four connection fields exist only in the answer to `GET /api/descriptor`, which the workbench reads through the
 *     WebView's own `fetch` under the stored bearer, so a line that names a Backend, a scope and the client id the
 *     deployment stated is an observation that the WebView reached this ingress and was admitted by it. A surface is
 *     never stated from the branch that merely found a stored connection: before the read settles the line says
 *     `connecting` with empty fields, and a refused read says `refused` with the reason the page shows. That is what makes
 *     this more than "the shell process started".
 *   - **A UI assertion from the rendered document** — the `surface` field above, from the branch that rendered it.
 *   - **A platform assertion, asked of the X server.** `xdotool search --name Hepi` proves a real WebKitGTK window exists
 *     on a real display, which a spawned process by itself would not.
 *   - **Pixel evidence, and nothing more.** See captureWindow. The capture is kept beside the log so a person can look at
 *     it; the driver only states that the bytes are not one flat colour. It does not read text out of them and does not
 *     claim the captured frame is the settled workbench — under Xvfb with software rendering, the window paints its first
 *     frame and may well be showing the App's transient `Connecting…` line while the first read is still in flight.
 *
 * The journeys, in order:
 *   1. a cold start with no stored connection renders the configuration surface, and states no connection;
 *   2. the connection is stored through the path the shell ships, in this run's own store, and the restarted process is
 *      admitted by the real ingress — the workbench line naming the Backend, scope and client id the deployment stated;
 *   3. the restarted shell's window is a real WebKitGTK window on a real X display;
 *   4. a file the person saves out of the workbench is written by the shell itself — the real GTK dialog is answered,
 *      the destination holds the workspace file's bytes, and a cancelled choice leaves nothing behind;
 *   5. the native App's stored bearer is what the real ingress admits, its revocation is refused afterwards, and a shell
 *      restarted **with that revoked credential still stored** reports `refused` rather than a workbench — the credential
 *      is the shell's, so no page can repair it;
 *   6. the conversation another client wrote is readable through the same Backend the shell is connected to.
 *
 * Journey 4 needs the rendered document, which a WebKitGTK window does not expose to a peer process. So it drives
 * the workbench through the WebView's own inspector: the shell is a debug build, `WEBKIT_INSPECTOR_HTTP_SERVER` is set for
 * this run on a port it owns, and the clicks below are dispatched inside the same document the person's window shows.
 * The GTK save dialog that opens is native, outside that document, and is answered with `xdotool` keystrokes against the
 * dialog's own window id. What that proves is the packaged journey end to end — picker, IPC, chunked append, flush — not
 * a JS unit test of the save loop.
 *
 * What it cannot state, and says so rather than inventing it: there is no Android target on this host (no SDK, no adb,
 * no device), so nothing here is evidence about a mobile App; no assertion below depends on what the screenshot happens
 * to show; and the save journey is measured on a debug profile, so its numbers are functional, not release, figures.
 *
 * Usage: node apps/web/e2e/acceptance/ux-native-acceptance.ts [--keep] [--binary=<path>] [--release=<dir>]
 *        The binary defaults to the debug build in the shared Cargo target directory.
 *
 * With `--release=<dir>` every process the shell talks to is the published release: the ingress it is configured
 * against is `release-<id>/ingress.mjs` serving `release-<id>/web/`, its execution host is the release's own installed
 * gateway bundle, and the Backend that mints and revokes its device credential is the release's recorded image, run over
 * a state directory this run owns. The shell itself is the debug binary this checkout built — the release carries no App
 * package — and `HEPI_APP_BUILD` below states which revision that binary is.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync, type WriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { packagedEnvironment, startCredentialSandbox, loginKeyringDigest, CONNECTION_ATTRIBUTES } from "../../../../scripts/lib/credential-sandbox.mjs";
import { sharedCargoTargetDir } from "../../../app/scripts/cargo-build.mjs";
import {
  backendJson, type AcceptanceStack, type ConversationStateBody, type CreatedConversationBody, freePort, issueDevice, repoRoot,
  startAcceptanceStack, WEB_LOGIN,
} from "./acceptance-stack.ts";

const run = promisify(execFile);
const keep = process.argv.includes("--keep");
const binaryArg = process.argv.find((value) => value.startsWith("--binary="));
const releaseDir = process.argv.find((value) => value.startsWith("--release="))?.split("=").slice(1).join("=") ?? "";
// The shared cache is computed the way the repository's own build computes it, from the main checkout's `.dev/`. Naming
// `repoRoot/.dev` would look in this worktree's directory and send a worktree run to build a 3 GiB second tree.
const sharedTarget = process.env.CARGO_TARGET_DIR ?? sharedCargoTargetDir(repoRoot);
const binary = binaryArg !== undefined ? binaryArg.split("=").slice(1).join("=") : join(sharedTarget, "debug", "hepi-app");

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}

/** What a thrown value says about itself, for a message that has to state why a resource never started. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The same, with the stack when the value has one: a resource that never started is worth the frames it failed in. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * The shapes this driver reads off the resources it starts, stated once here rather than inferred per call site.
 *
 * Each is the answer of one thing this run really started: the X display it owns, the isolated credential store, one shell
 * process with its captured lines, and the descriptor the ingress answers. They are the driver's own statements about its
 * children, so no field below is a second projection of a product record.
 */
interface DisplayHandle {
  readonly display: string;
  readonly stop: () => void;
}
/** What one headless shell call answered: its exit code and the two streams a person would read. */
interface ShellCall { readonly code: number | null; readonly stdout: string; readonly stderr: string }
/** What a shell process reported about itself while it ran: the kernel's high-water mark, sampled. */
interface ShellMemory { peakKb: number; samples: number; stop: () => void }
/** One shell process this run started, with the lines its own document printed and the measurement kept of it. */
interface ShellRun {
  readonly lines: string[];
  readonly peakRssKb: () => number;
  readonly waitFor: (predicate: (line: string) => boolean, timeoutMs: number) => Promise<string | null>;
  readonly stop: () => Promise<void>;
}
/** One connection a readiness line states, in the four fields the ingress answered. */
interface StatedConnection { readonly backend: string; readonly scope: string; readonly client: string; readonly profile: string }
/** What one capture kept: where it is, and whether its bytes are one flat surface. */
interface WindowCapture {
  readonly captured: boolean;
  readonly path: string;
  /** Distinct grey levels at the 24x24 reduction, or null when the capture or the reduction itself did not answer. */
  readonly levels: number | null;
  readonly detail?: string;
}
/** The WebView's document, reached over the debug inspector the shell serves on this run's own port. */
interface InspectedDocument {
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly close: () => void;
}
/** One message the inspector's socket carries: a target event, or one inner answer to a call this driver made. */
interface InspectorMessage {
  readonly method?: string;
  readonly params?: { readonly message?: string; readonly targetInfo?: { readonly type?: string; readonly targetId?: string } };
}
/** The answer to one inner call, as the protocol states it: its own id, and the bound this driver put on the socket. */
interface InspectorAnswer {
  readonly id?: number;
  readonly timeout?: true;
  readonly result?: { readonly result?: { readonly value?: unknown } };
}
/** The credential store this run started, as the driver reads it. */
type CredentialSandbox = Awaited<ReturnType<typeof startCredentialSandbox>>;
/** The Backend's issuing answer for one device credential: the record it keeps, and the token it hands over once. */
interface IssuedDevice {
  readonly credential: { readonly id: string };
  readonly token: string;
}
/**
 * The ingress's descriptor answer: the identity the deployment states for this admitted client.
 *
 * Narrow on purpose — the fields this driver compares with what the WebView named — because the check below is about those,
 * and a second projection of the whole descriptor would be a shape nothing here reads.
 */
interface DescriptorBody {
  readonly client?: { readonly kind?: string; readonly id?: string };
  readonly backend?: { readonly id?: string };
  readonly account?: { readonly scope?: string };
}

if (!existsSync(binary)) {
  console.error("No debug shell at " + binary + ". Build it first:\n  cd apps/app/src-tauri && CARGO_TARGET_DIR=" + sharedTarget + " CARGO_BUILD_JOBS=6 CARGO_INCREMENTAL=1 cargo build");
  process.exit(2);
}
const sourceRevision = await run("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot }).then((result) => result.stdout.trim(), () => "unknown");
console.log("Native shell: " + binary + " (debug profile, source " + sourceRevision + ")");
console.log("Native functional evidence on a debug build; not release performance and not a release artifact check.");

/** One Xvfb this run owns, so the App and xdotool share a display. */
async function startDisplay(): Promise<DisplayHandle | null> {
  for (let number = 70; number < 80; number++) {
    const display = ":" + number;
    const child = spawn("Xvfb", [display, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
    let alive = true;
    child.on("exit", () => { alive = false; });
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
      await delay(100);
      try {
        await run("xdpyinfo", ["-display", display], { timeout: 5000 });
        return { display, stop: () => { if (alive) child.kill("SIGTERM"); } };
      } catch { /* not up yet */ }
    }
    if (alive) child.kill("SIGTERM");
  }
  return null;
}

/**
 * The resources this run owns, released in the opposite order they were taken.
 *
 * Each one outlives the driver if the driver dies while a later one is still starting: an `Xvfb` holding a display, a
 * gateway/Backend/ingress trio bound to this run's ports and state, and a private session bus with its own keyring.
 * Starting the credential store last is therefore only safe if the two acquisitions before it are already owned by a
 * cleanup that runs on the failure path too — which is why the handles below are declared first, the signal handlers are
 * installed before anything is started, and acquisition failure releases what it managed to take before exiting.
 *
 * The cleanup runs on the paths where a later acquisition never finished, so this holder is the one place a handle may be
 * absent. The journey below reads the same objects from its own bindings, which exist by the time it runs.
 */
const owned: { display?: DisplayHandle; stack?: AcceptanceStack; credentials?: CredentialSandbox } = {};
const logs: WriteStream[] = [];
let child: ChildProcess | undefined;

const shutdown = async () => {
  // The shell's process group, when one was started and is still running: a run that failed before its first launch has no
  // group of its own to signal, and the kernel needs the pid to address one.
  const running = child;
  const pid = running?.pid;
  if (running !== undefined && pid !== undefined && running.exitCode === null && running.signalCode === null) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
    await delay(2000);
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // Awaited: the store's daemons have to be gone before its tree is removed, or the removal races a live daemon that
  // recreates directories under it. Each release is conditional because this runs on the paths where a later resource
  // never finished starting — a run that could not start its store still owes the display and the stack it did take.
  await owned.credentials?.stop();
  await owned.stack?.close();
  owned.display?.stop();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { console.log("Interrupted by " + signal); void shutdown().then(() => process.exit(130)); });
}

const startedDisplay = await startDisplay();
if (startedDisplay === null) {
  console.error("no X display could be started");
  await shutdown();
  process.exit(1);
}
owned.display = startedDisplay;
// The display this run owns, as every helper below reads it: the null case above ended the run, so the handle the closures
// capture is the one that exists rather than a value each of them has to re-doubt.
const display: DisplayHandle = startedDisplay;

// The shell's document origin is the WebView's own, so the ingress is told to answer it: this is the deployment's own
// configuration (HEPI_APP_ORIGINS), not a relaxation of the check — an undeclared origin is still refused.
const stack = await startAcceptanceStack({
  label: "t16-native",
  keep,
  releaseDir,
  extraAppOrigins: ["tauri://localhost"],
  log: (line: string) => console.log(line),
}).catch(async (error: unknown) => {
  console.error("the acceptance stack failed to start: " + describeFailure(error).slice(0, 500));
  await shutdown();
  return process.exit(1);
});
owned.stack = stack;

// The credential store this run owns. It lives under the host's temp directory while the run addresses it — a socket path
// inside `.dev/verify/<run>/` measured 146 bytes against the kernel's 107-byte unix limit, and a bus that cannot bind looks
// like a store that never answered — and `--keep` moves the finished tree next to this run's artifacts so the keyring file
// is evidence rather than a side effect. The digest of the developer's own login keyring is taken here and compared at the
// end: the run must leave that file exactly as it found it.
//
// A store that fails to start ends the run before a shell process is spawned, rather than continuing with an environment
// that has no bus address in it: an empty environment is not an isolated one, because the Secret Service library still
// finds `/run/user/<uid>/bus` and the `--forget` this run performs would then delete the developer's real App connection.
const keyringDigestBefore = loginKeyringDigest();
const credentials = await startCredentialSandbox({ label: "t16-native-cred", root: stack.artifacts, keepStore: keep, log: (line?: string) => console.log("  credential store: " + (line ?? "")) })
  .catch(async (error: unknown) => {
    console.error("no isolated credential store, so no shell process was started: " + describeError(error).slice(0, 400));
    await shutdown();
    return process.exit(2);
  });
owned.credentials = credentials;
console.log("Credential store: private bus " + credentials.busAddress + " at " + credentials.directory + " (the inherited session bus address is used by no shell process started here)");

/**
 * The environment every shell process runs under.
 *
 * `credentials.env` replaces the session bus, the home and the XDG directories; the display and the WebView's software
 * rendering flags are this driver's own. Nothing here inherits `DBUS_SESSION_BUS_ADDRESS`, `GNOME_KEYRING_CONTROL` or
 * `HOME` from the developer's shell.
 */
// The debug build's own inspector, on a port this run took and no other run holds. It exists so the save journey below
// can dispatch clicks inside the rendered document; nothing else here needs it, and a release shell would have none.
const inspectorPort = await freePort();
const shellEnv = packagedEnvironment(credentials, {
  DISPLAY: display.display,
  GDK_BACKEND: "x11",
  WEBKIT_DISABLE_DMABUF_RENDERER: "1",
  WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  WEBKIT_INSPECTOR_HTTP_SERVER: "127.0.0.1:" + inspectorPort,
});

/** One run of the shell under this display, in its own process group so a restart replaces the process. */
function launch(name: string): ShellRun {
  const out = createWriteStream(join(stack.artifacts, name + ".stdout.log"));
  const err = createWriteStream(join(stack.artifacts, name + ".stderr.log"));
  const started = spawn(binary, [], {
    detached: true,
    env: shellEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = started;
  // The kernel's own high-water mark for this process, sampled while it is alive: the native peak-memory item of the
  // ticket's performance box. A debug-profile number, stated as one, not a release measurement.
  // Its own stop names the sampler it owns: the closure is read when it is called, after the interval exists.
  const memory: ShellMemory = { peakKb: 0, samples: 0, stop: () => clearInterval(sampler) };
  const sampler = setInterval(() => {
    if (started.exitCode !== null || started.signalCode !== null) { memory.stop(); return; }
    try {
      const match = readFileSync("/proc/" + started.pid + "/status", "utf8").match(/VmHWM:\s+(\d+) kB/);
      if (match !== null) { memory.peakKb = Math.max(memory.peakKb, Number(match[1])); memory.samples += 1; }
    } catch { /* the process ended between the checks */ }
  }, 500);
  const lines: string[] = [];
  let buffered = "";
  started.stdout.on("data", (chunk) => {
    out.write(chunk);
    buffered += String(chunk);
    for (let index = buffered.indexOf("\n"); index >= 0; index = buffered.indexOf("\n")) { lines.push(buffered.slice(0, index)); buffered = buffered.slice(index + 1); }
  });
  started.stderr.pipe(err);
  logs.push(out, err);
  return {
    lines,
    peakRssKb: () => memory.peakKb,
    async waitFor(predicate: (line: string) => boolean, timeoutMs: number): Promise<string | null> {
      const deadline = Date.now() + timeoutMs;
      let quietSince: number | null = null;
      while (Date.now() < deadline) {
        const match = lines.find(predicate);
        if (match !== undefined) return match;
        // A restart replaces the process, so an exited child is not the end of the run until nothing is written for a
        // few seconds.
        quietSince = started.exitCode === null ? null : quietSince ?? Date.now();
        if (quietSince !== null && Date.now() - quietSince > 5000) return null;
        await delay(250);
      }
      return null;
    },
    stop: async () => {
      memory.stop();
      const pid = started.pid;
      if (pid === undefined || started.exitCode !== null || started.signalCode !== null) return;
      try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
      await delay(1500);
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    },
  };
}

/** The headless configure path the shell ships: the device bearer goes in on stdin, never in the process list. */
function configure(origin: string, token: string, profile: string): Promise<ShellCall> {
  return new Promise<ShellCall>((resolve) => {
    const configured = spawn(binary, ["--configure"], { env: shellEnv });
    let stdout = "";
    let stderr = "";
    configured.stdout.on("data", (chunk) => { stdout += String(chunk); });
    configured.stderr.on("data", (chunk) => { stderr += String(chunk); });
    configured.on("exit", (code) => resolve({ code, stdout, stderr }));
    configured.stdin.end(JSON.stringify({ profile, origin, token }));
  });
}
/** The shell's own `--forget`, whose answer is its exit code and what it printed: it reports nothing on stderr. */
function forget(): Promise<ShellCall> {
  return new Promise<ShellCall>((resolve) => {
    const forgotten = spawn(binary, ["--forget"], { env: shellEnv });
    let stdout = "";
    forgotten.stdout.on("data", (chunk) => { stdout += String(chunk); });
    forgotten.on("exit", (code) => resolve({ code, stdout, stderr: "" }));
  });
}

/**
 * The window's own pixels, captured from the X server as **pixel evidence** — deliberately not a UI assertion.
 *
 * A WebKitGTK window's DOM is not reachable from this process, and reading words out of a screenshot would make the
 * driver depend on an OCR toolchain it does not own. So the honest statement is the narrow one: the capture exists and
 * it is not one flat colour, which is what separates a painted window from an X root with nothing on it. Which surface
 * the shell rendered is stated by `HEPI_APP_READY` above, and this driver would still pass its UI assertions if the
 * capture were blank, because a software-rendered first frame is not evidence of a document state.
 */
async function captureWindow(file: string): Promise<WindowCapture> {
  try {
    await run("xwd", ["-root", "-display", display.display, "-out", file + ".xwd"], { env: { ...process.env, DISPLAY: display.display }, timeout: 30_000 });
    // ffmpeg is present on this host; when it is not, the raw XWD is still the evidence and the driver says so.
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", file + ".xwd", file], { timeout: 60_000 });
  } catch (error) {
    return { captured: false, path: file, levels: null, detail: describeError(error).slice(0, 200) };
  }
  // Distinct grey levels at a 24x24 reduction. One value means a flat surface; a window that painted anything at all
  // has edges, and edges survive the reduction.
  try {
    const { stdout } = await run("sh", ["-c", 'ffmpeg -v error -i ' + file + ' -vf scale=24:24 -f rawvideo -pix_fmt gray - 2>/dev/null | od -An -tu1 -v | tr -s " " "\n" | grep -v "^$" | sort -nu | wc -l'], { timeout: 60_000 });
    return { captured: true, path: file, levels: Number(stdout.trim()) };
  } catch (error) {
    return { captured: true, path: file, levels: null, detail: describeError(error).slice(0, 120) };
  }
}

/** The window id of a native dialog with this name, or null while it is not on the display. */
async function windowNamed(name: string): Promise<string | null> {
  try {
    // Visible windows only: GTK keeps a dismissed dialog's window around until the toolkit gets to it, so a search
    // that counted unmapped windows would still see a dialog the person has already closed.
    const { stdout } = await run("xdotool", ["search", "--onlyvisible", "--name", name], { env: { ...process.env, DISPLAY: display.display }, timeout: 10_000 });
    return stdout.trim().split("\n").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Answer the native save dialog with an absolute destination, the way a person does: focus it, open the location bar,
 * type the path, confirm.
 *
 * Bounded retry, not a fallback path: a dialog that is still mapping can take the focus after the keystrokes have gone,
 * which loses the whole sequence while leaving the dialog on screen. The retry repeats the same interaction against the
 * same window; a dialog that is no longer there is not retried at all. What lands is located by the destination's own
 * basename, because GTK appends the active filter's suffix to a name typed without it — the picker's answer, not this
 * driver's guess.
 */
async function answerSaveDialog(id: string, destination: string): Promise<string[]> {
  const x = { ...process.env, DISPLAY: display.display };
  const basename = destination.slice(destination.lastIndexOf("/") + 1).replace(/\.txt$/, "");
  const landed = () => readdirSync(stack.artifacts).filter((name) => name.startsWith(basename));
  for (let attempt = 0; attempt < 2; attempt++) {
    await focusWindow(id);
    await run("xdotool", ["key", "--window", id, "--delay", "120", "ctrl+l"], { env: x, timeout: 20_000 });
    await delay(800);
    await run("xdotool", ["type", "--window", id, "--delay", "30", destination], { env: x, timeout: 60_000 });
    await delay(800);
    await run("xdotool", ["key", "--window", id, "--delay", "120", "Return"], { env: x, timeout: 20_000 });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const found = landed();
      if (found.length > 0) return found;
      // The dialog closing without a file is the end of this attempt; a dialog still open is asked again.
      if ((await windowNamed("Save file")) === null) break;
      await delay(250);
    }
  }
  return landed();
}

/**
 * Give a native dialog the keyboard.
 *
 * `windowfocus`, not `windowactivate`: activation goes through the window manager's own policy and, under this display,
 * handed the keyboard back to the App window while the dialog stayed mapped — the keystrokes below then went nowhere and
 * the dialog sat unanswered. Focusing the dialog's own window is what the X server needs here, and it is retried because
 * a dialog that is still mapping can refuse the sync form.
 */
async function focusWindow(id: string): Promise<void> {
  const x = { ...process.env, DISPLAY: display.display };
  for (let attempt = 0; attempt < 20; attempt++) {
    try { await run("xdotool", ["windowfocus", "--sync", id], { env: x, timeout: 20_000 }); return; } catch { await delay(250); }
  }
  await run("xdotool", ["windowfocus", id], { env: x, timeout: 20_000 }).catch(() => {});
}

/**
 * The WebView's own document, reached through the debug build's inspector.
 *
 * A WebKitGTK window exposes no DOM to a peer process, so the only way into the rendered workbench is the inspector the
 * debug shell carries: `WEBKIT_INSPECTOR_HTTP_SERVER` is set for this run on a port the run owns, the served page names
 * the WebPage socket, and the clicks below are `Runtime.evaluate` calls inside the document the person's window shows.
 * This is a driver for a debug build; a release shell has no inspector and this journey states nothing about one.
 *
 * Nothing here reads state out of the shell's own C ABI: the evaluations only dispatch what a person would (a click on a
 * named control) and answer what the document then says, which is the same class of assertion as `HEPI_APP_READY`.
 */
async function openDocument(): Promise<InspectedDocument | null> {
  const deadline = Date.now() + 90_000;
  let socketUrl: string | null = null;
  while (Date.now() < deadline && socketUrl === null) {
    try {
      const html = await (await fetch("http://127.0.0.1:" + inspectorPort + "/", { signal: AbortSignal.timeout(2000) })).text();
      const match = /socket\/(\d+)\/(\d+)\/WebPage/.exec(html);
      if (match !== null) socketUrl = "ws://127.0.0.1:" + inspectorPort + "/socket/" + match[1] + "/" + match[2] + "/WebPage";
    } catch { /* not listening yet, or the window is still being created */ }
    if (socketUrl === null) await delay(500);
  }
  if (socketUrl === null) return null;
  const socket = new WebSocket(socketUrl);
  const pending = new Map<number, (answer: InspectorAnswer) => void>();
  let pageTarget: string | null = null;
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    let message: InspectorMessage;
    try { message = JSON.parse(String(event.data)) as InspectorMessage; } catch { return; }
    const created = message.params?.targetInfo;
    if (message.method === "Target.targetCreated" && created?.type === "page") pageTarget = created.targetId ?? null;
    if (message.method !== "Target.dispatchMessageFromTarget") return;
    let inner: InspectorAnswer;
    try { inner = JSON.parse(message.params?.message ?? "") as InspectorAnswer; } catch { return; }
    const settle = inner.id === undefined ? undefined : pending.get(inner.id);
    if (settle !== undefined && inner.id !== undefined) { pending.delete(inner.id); settle(inner); }
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  const send = (method: string, params?: object): Promise<InspectorAnswer> => new Promise<InspectorAnswer>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id: 100_000 + id, method: "Target.sendMessageToTarget", params: { targetId: pageTarget, message: JSON.stringify({ id, method, params }) } }));
    setTimeout(() => { if (pending.delete(id)) resolve({ timeout: true }); }, 25_000);
  });
  // The page target exists before this socket attaches, so it is asked for rather than waited on.
  await send("Target.setDiscoverTargets", { discover: true });
  for (let attempt = 0; attempt < 50 && pageTarget === null; attempt++) await delay(100);
  if (pageTarget === null) { socket.close(); return null; }
  await send("Runtime.enable", {});
  return {
    async evaluate(expression: string): Promise<unknown> {
      const answer = await send("Runtime.evaluate", { expression, returnByValue: true });
      return answer.result?.result?.value;
    },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

/** Whether the shell really put a window on this display, asked of the X server rather than of the process. */
async function windowPresent(): Promise<boolean> {
  try {
    const { stdout } = await run("xdotool", ["search", "--name", "Hepi"], { env: { ...process.env, DISPLAY: display.display }, timeout: 10_000 });
    return stdout.trim().split("\n").filter(Boolean).length > 0;
  } catch {
    return false;
  }
}

const QUOTE = String.fromCharCode(34);
const field = (line: string | null | undefined, name: string): string => {
  const match = new RegExp(QUOTE + name + QUOTE + ":" + QUOTE + "([^" + QUOTE + "]*)" + QUOTE).exec(line ?? "");
  return match === null ? "" : match[1];
};
const isReady = (line: string | null | undefined): boolean => line !== undefined && line !== null && line.startsWith("HEPI_APP_READY");
const surfaceOf = (line: string | null | undefined): string => field(line, "surface");
const surfaceIs = (line: string | null | undefined, name: string): boolean => isReady(line) && surfaceOf(line) === name;

/**
 * The connection this document's own read settled on, as its readiness line states it.
 *
 * Every field is one the ingress answered: `backend` and `scope` are the descriptor's identity and `client` is the
 * credential the ingress admitted, which the driver compares with the id it issued. A line that names all four is proof
 * that the WebView performed that read against this deployment, so no check below can be satisfied by a process that
 * started, a window that painted, or a credential the shell stored without ever presenting.
 */
function statedConnection(line: string | null | undefined): StatedConnection | null {
  if (!surfaceIs(line, "workbench")) return null;
  const stated = { backend: field(line, "backend"), scope: field(line, "scope"), client: field(line, "client"), profile: field(line, "profile") };
  return Object.values(stated).every((value) => value !== "") ? stated : null;
}

/** Wait until the store answers with the item the shell wrote, or with nothing. */
async function storedItems(deadlineMs = 10_000): Promise<ReturnType<CredentialSandbox["search"]>> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = credentials.search(CONNECTION_ATTRIBUTES);
    if (found.unlocked.length + found.locked.length > 0) return found;
    if (Date.now() > deadline) return found;
    await delay(200);
  }
}

try {
  console.log("Artifacts: " + stack.artifacts);
  // The conversation the native App reads is created and written by the Web session, which is what makes this a
  // cross-client read rather than a shell reading its own write.
  const login = await fetch(stack.webOrigin + "/api/web-login", { method: "POST", headers: { "content-type": "application/json", origin: stack.webOrigin }, body: JSON.stringify({ token: WEB_LOGIN }) });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  await login.body?.cancel();
  // The issued credential, as the Backend's own issuing answer states it: the token the shell stores, and the record the
  // revocation below names. It is narrowed here because the shared helper answers the JSON it read.
  const device = (await issueDevice(stack, "t16-native")) as IssuedDevice;
  const conversation = await backendJson<CreatedConversationBody>(stack, "/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
  const conversationId = conversation.conversationId;
  const submitted = await fetch(stack.webOrigin + "/api/conversations/" + conversationId + "/messages", {
    method: "POST", headers: { "content-type": "application/json", cookie, origin: stack.webOrigin },
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "t16-native-seed", text: "a turn the Web session wrote" }),
  });
  await submitted.body?.cancel();
  check(submitted.status === 202, "the Web session wrote a turn for the native App to read (" + submitted.status + ")");

  // 0. The store must be one this run created and this run can delete: a private Secret Service that answered with the
  //    developer's item would mean the bus address never took effect, and the `--forget` below would be deleting a
  //    person's own App connection. An empty answer is the only proof that the store on this bus is the empty one.
  const beforeStore = credentials.search(CONNECTION_ATTRIBUTES);
  check(beforeStore.unlocked.length === 0 && beforeStore.locked.length === 0, "the run's own credential store starts with no " + CONNECTION_ATTRIBUTES.service + " entry: " + JSON.stringify(beforeStore));
  // And the address this run did **not** use. The environment the driver inherited is stated in the log rather than
  // asserted, because a host with no session bus is a legal host for this driver; what is not legal is a shell process
  // that reaches one, so the child environment is checked against the private bus instead.
  check(shellEnv.DBUS_SESSION_BUS_ADDRESS === credentials.busAddress && shellEnv.GNOME_KEYRING_CONTROL === undefined,
    "every shell process is handed this run's bus and no keyring control socket (inherited: " + (credentials.inheritedBusAddress === "" ? "none" : credentials.inheritedBusAddress) + ")");

  // 1. Cold start with no stored connection.
  const forgotten = await forget();
  check(forgotten.code === 0, "the cold start cleared this run's own store, not a session bus it inherited (" + forgotten.stdout.trim() + ")");
  const cold = launch("cold-start");
  const unconfigured = await cold.waitFor((line) => surfaceIs(line, "configure"), 120_000);
  check(unconfigured !== null, "UI assertion, from the rendered document: a cold start with no stored connection renders the configuration surface: " + String(unconfigured));
  check(unconfigured !== undefined && field(unconfigured, "backend") === "" && field(unconfigured, "client") === "",
    "and states no connection, because nothing was read: " + String(unconfigured));
  const buildLine = cold.lines.find((line) => line.startsWith("HEPI_APP_BUILD"));
  check(buildLine !== undefined, "the shell reports the build it is: " + String(buildLine));
  await cold.stop();

  // 2. The stored connection, and the workbench that comes back after the restart it triggers.
  const stored = await configure(stack.ingressOrigin, device.token, "t16-native");
  check(stored.code === 0 && stored.stdout.includes("HEPI_APP_CONFIGURE ok"), "the shell stored the connection: " + (stored.stdout.trim() || stored.stderr.trim()).slice(0, 200));
  // The write is seen in this run's store through the Secret Service's own answer, so the entry the shell created is
  // located rather than inferred from a successful exit code.
  const written = await storedItems();
  check(written.unlocked.length + written.locked.length > 0, "the stored entry is in the run's own credential store, unlocked and readable by the next process: " + JSON.stringify(written.unlocked));

  const configured = launch("configured");
  // The read settles after the mount, so this waits for the admitted state rather than for the first line: a `connecting`
  // line is the same process, the same window and no statement about the connection.
  const ready = await configured.waitFor((line) => statedConnection(line) !== null, 180_000);
  const stated = statedConnection(ready);
  check(stated !== null, "transport observation, from the rendered document: the WebView's own descriptor read was admitted, and its line names what the deployment answered: " + String(ready));
  check(stated !== null && stated.client === "device:" + device.credential.id,
    "the admitted client is the device credential this run issued, presented by the shell: " + (stated === null ? "no connection stated" : stated.client + " vs device:" + device.credential.id));
  check(stated !== null && stated.profile === "t16-native" && stated.backend !== "" && stated.scope !== "",
    "and the same read states the profile, Backend and account scope it connected as: " + JSON.stringify(stated));

  // 3. A real WebKitGTK window exists on this display: the shell did not merely start a process. Asked of the X server,
  //    so it is a platform fact rather than the same claim the surface line already made.
  const windowed = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await windowPresent()) return true; await delay(500); }
    return false;
  })();
  check(windowed, "platform assertion, asked of the X server: the shell put a real window on the display (xdotool found it)");
  // The capture is kept as pixel evidence beside the log. Given a few seconds of settled time first, so the frame is not
  // simply the first paint the window happened to have when xdotool first saw it.
  await delay(5000);
  const capture = await captureWindow(join(stack.artifacts, "native-workbench.png"));
  check(capture.captured, "pixel evidence kept (not a UI assertion): the window's own bytes were captured to " + capture.path + (capture.detail === undefined ? "" : " (" + capture.detail + ")"));
  check(capture.levels !== null && capture.levels > 1, "and the capture is not one flat surface (" + capture.levels + " distinct grey levels at 24x24). What surface it shows is stated by HEPI_APP_READY above, not read out of these pixels");

  // 4. The packaged save journey. The workbench is driven in the window's own document over the debug inspector, and the
  //    native GTK dialog the shell opens is answered with keystrokes against the dialog's own window id — the picker, the
  //    IPC stream and the flush are all the shipped path. Nothing is written through a test-only save flag.
  const drawn = launch("save-journey");
  const saving = await drawn.waitFor((line) => statedConnection(line) !== null, 180_000);
  check(statedConnection(saving) !== null, "the shell for the save journey reached the workbench: " + String(saving));
  // The file the person saves is written into the workspace this stack serves, at the root the App's session opens on:
  // the execution host's workspace root is the routing path the shell's session names, so the tree lists it directly.
  const savedBytes = Buffer.from("native save acceptance\n" + "0123456789abcdef".repeat(64) + "\n");
  writeFileSync(join(stack.workspaceRoot, "native-save.txt"), savedBytes);
  const destination = join(stack.artifacts, "saved-by-shell.txt");
  const document = await openDocument();
  check(document !== null, "the debug shell answered on its inspector port, so the rendered document is reachable at 127.0.0.1:" + inspectorPort);
  let dialogAnswer = null;
  if (document !== null) {
    try {
      // The person's own path into the tree: a session in the project, the Files tab, then the file row.
      const click = async (describe: string, expression: string): Promise<boolean> => {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const answer = await document.evaluate(expression);
          if (answer === "clicked") return true;
          if (Date.now() > deadline) {
            // What the document showed is part of the failure: a missing control is either a surface that never rendered
            // or one this driver looked in the wrong place for, and the two are told apart by what is on screen.
            const shown = String(await document.evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(0, 400);
            check(false, "the document never offered " + describe + " (last answer: " + String(answer) + "; the document showed: " + shown + ")");
            return false;
          }
          await delay(500);
        }
      };
      await click("the project's New session control",
        '(()=>{const b=[...document.querySelectorAll("button[aria-label]")].find(x=>/^New session in /.test(x.getAttribute("aria-label")||"")); if(!b) return "none"; b.click(); return "clicked";})()');
      await delay(4000);
      await click("the Files tab",
        '(()=>{const b=[...document.querySelectorAll("[role=tab]")].find(x=>x.textContent.includes("Files")); if(!b) return "none"; b.click(); return "clicked";})()');
      await click("the saved file's row in the tree",
        // The tree names the file by its own basename; the row's click is the same one a person makes on it.
        '(()=>{const row=[...document.querySelectorAll("div")].filter(x=>x.textContent.trim()==="native-save.txt"); if(!row.length) return "no row"; row[row.length-1].click(); return "clicked";})()');
      // The viewer's own save control, named the way the shell names it in this locale.
      const openedSave = await click("the viewer's Download file control",
        '(()=>{const b=[...document.querySelectorAll("button[aria-label]")].find(x=>x.getAttribute("aria-label")==="Download file"); if(!b) return "none"; b.click(); return "clicked";})()');
      check(openedSave, "the workbench's own save control was clicked in the rendered document");
      // The dialog is native and outside the document, so it is answered where an X client sees it.
      let dialogWindow = null;
      for (let attempt = 0; attempt < 60 && dialogWindow === null; attempt++) { dialogWindow = await windowNamed("Save file"); if (dialogWindow === null) await delay(250); }
      check(dialogWindow !== null, "platform assertion, asked of the X server: the shell's real GTK Save file dialog is on the display");
      if (dialogWindow !== null) {
        const landed = await answerSaveDialog(dialogWindow, destination);
        dialogAnswer = landed.length === 1 ? landed[0] : null;
        check(dialogAnswer !== null, "the shell wrote the file the dialog was answered with (" + JSON.stringify(landed) + " under " + stack.artifacts + ")");
        if (dialogAnswer !== null) {
          const saved = readFileSync(join(stack.artifacts, dialogAnswer));
          check(saved.length === savedBytes.length && createHash("sha256").update(saved).digest("hex") === createHash("sha256").update(savedBytes).digest("hex"),
            "and the bytes are the workspace file's own (" + saved.length + " bytes, sha256 " + createHash("sha256").update(saved).digest("hex").slice(0, 16) + "…), not a truncated or re-encoded copy");
        }
        // A cancelled choice is not a failure and leaves nothing behind: the same control, dismissed.
        const relabelled = await (async () => {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const label = await document.evaluate('(()=>{const b=[...document.querySelectorAll("button[aria-label]")].find(x=>/^Download file$/.test(x.getAttribute("aria-label")||"")); return b?"ready":"none";})()');
            if (label === "ready") return true;
            await delay(500);
          }
          return false;
        })();
        check(relabelled, "the control returned to its idle state after the save, so a second save is offered");
        if (relabelled) {
          await document.evaluate('(()=>{const b=[...document.querySelectorAll("button[aria-label]")].find(x=>x.getAttribute("aria-label")==="Download file"); if(!b) return "none"; b.click(); return "clicked";})()');
          let second = null;
          for (let attempt = 0; attempt < 60 && second === null; attempt++) { second = await windowNamed("Save file"); if (second === null) await delay(250); }
          check(second !== null, "a second save opens the picker again, so a cancelled choice is not a stuck control");
          if (second !== null) {
            // Delivered to the focused window rather than addressed to the dialog's id: a GTK dialog closes on the key its
            // own focus holds, and a synthetic event addressed at the toplevel is not the same keystroke to the toolkit.
            await focusWindow(second);
            await run("xdotool", ["key", "--clearmodifiers", "--delay", "120", "Escape"], { env: { ...process.env, DISPLAY: display.display }, timeout: 20_000 });
            // The dismissal is asynchronous in the toolkit, so the window is waited for rather than sampled once.
            const gone = await (async () => {
              const deadline = Date.now() + 30_000;
              while (Date.now() < deadline) { if ((await windowNamed("Save file")) === null) return true; await delay(500); }
              return false;
            })();
            const afterCancel = readdirSync(stack.artifacts).filter((name) => name.startsWith("saved-by-shell"));
            check(afterCancel.length === 1, "the cancelled choice left no second file and no partial one: " + JSON.stringify(afterCancel));
            check(gone, "and the dialog is gone after Escape");
          }
        }
      }
    } catch (error) {
      check(false, "save journey error: " + (error instanceof Error ? error.message : String(error)).slice(0, 400));
    } finally {
      document.close();
    }
  }
  await drawn.stop();

  // 5. The native App reaches the ingress with the bearer the shell stored, and that bearer is refused once revoked.
  const admitted = await fetch(stack.ingressOrigin + "/api/descriptor", { headers: { authorization: "Bearer " + device.token, origin: "tauri://localhost" } });
  const descriptor = (await admitted.json().catch(() => null)) as DescriptorBody | null;
  check(admitted.status === 200, "the ingress admits the stored bearer from the tauri origin (" + admitted.status + ")");
  check(descriptor?.client?.kind === "device" && descriptor.client.id === device.credential.id, "and states it as the device credential the shell stored: " + JSON.stringify(descriptor?.client));
  check(descriptor?.backend?.id === stated?.backend && descriptor?.account?.scope === stated?.scope,
    "and the Backend and account the WebView named are the ones this descriptor read answered: " + JSON.stringify({ fromWebView: stated, fromDriver: { backend: descriptor?.backend?.id, scope: descriptor?.account?.scope } }));
  const revoked = await fetch(stack.webOrigin + "/api/device-credentials/" + encodeURIComponent(device.credential.id), { method: "DELETE", headers: { cookie, origin: stack.webOrigin } });
  await revoked.body?.cancel();
  check(revoked.status === 200, "the Web session revoked the native App credential (" + revoked.status + ")");
  const refused = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await fetch(stack.ingressOrigin + "/api/descriptor", { headers: { authorization: "Bearer " + device.token, origin: "tauri://localhost" } });
      await response.body?.cancel();
      if (response.status === 401) return 401;
      await delay(300);
    }
    return null;
  })();
  check(refused === 401, "the revoked native credential is refused by the ingress");
  await configured.stop();

  // 4b. And the shell that starts holding that revoked credential does not claim a workbench. This is the P2 contract in
  //     the only place it can be shown: a stored connection is a fact about the install, not about the deployment, so
  //     readiness has to follow the admission rather than the storage. The credential is the shell's, so no page can
  //     repair it — the surface the document reaches is the refusal.
  const revokedRun = launch("revoked-credential");
  const revokedState = await revokedRun.waitFor((line) => surfaceIs(line, "refused") || surfaceIs(line, "workbench"), 180_000);
  check(surfaceIs(revokedState, "refused"), "the shell restarted with the revoked bearer reports the refusal its own read got, not a workbench: " + String(revokedState));
  check(field(revokedState, "backend") === "" && field(revokedState, "client") === "", "and that refusal states no connection: " + String(revokedState));
  check(revokedRun.lines.every((line) => statedConnection(line) === null), "and no line of that run ever stated an admitted connection");
  const peaks = { coldStart: cold.peakRssKb(), configured: configured.peakRssKb(), revokedCredential: revokedRun.peakRssKb() };
  await revokedRun.stop();
  // The native half of the ticket's performance box: the peak resident size of each shell process this run started,
  // read from the kernel's own record while the process was alive. Debug profile, so it is a functional-run cost, not a
  // release figure, and it is stated per run rather than averaged across them.
  check(Object.values(peaks).every((kb) => kb > 0), "native peak RSS per shell run (debug, VmHWM kB): " + JSON.stringify(peaks));

  // 5. The conversation the Web session wrote is still served by the Backend the shell was admitted to before it was
  //    revoked: the reads above went through the ingress the shell itself was configured against.
  const durable = await backendJson<ConversationStateBody>(stack, "/api/conversations/" + conversationId + "/state");
  check((durable.entries ?? []).some((entry) => (entry.text ?? "").includes("a turn the Web session wrote")), "the turn the Web session wrote is durable in the Backend this deployment runs: " + (durable.entries ?? []).length + " entries");
  // Where the run's own store is kept is stated in the summary below: `stop()` moves the tree into the driver's artifacts
  // directory only once it is no longer addressed, so the check belongs after shutdown rather than here.
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  await shutdown();
  for (const log of logs) log.end();
  // Retention is a property of the run's own cleanup, so it is checked after `stop()` has moved or removed the tree: with
  // `--keep` the keyring the run wrote sits beside the artifacts as evidence, without it nothing of the store is left.
  check(keep === existsSync(join(credentials.storedAt, "home", ".local", "share", "keyrings")), "the run's credential store " + (keep ? "is retained as evidence at " + credentials.storedAt : "left nothing behind (no --keep)") + " (" + credentials.storedAt + ")");
  // The one statement that matters to whoever's machine this ran on: the developer's own credential store was not the
  // target of this run's writes. A host with no login keyring at all is reported as such rather than as "unchanged".
  const keyringDigestAfter = loginKeyringDigest();
  if (keyringDigestBefore !== null) {
    check(keyringDigestAfter === keyringDigestBefore, "the developer's own login keyring is byte-for-byte what it was before this run (" + keyringDigestBefore.slice(0, 12) + "…): " + (keyringDigestAfter === keyringDigestBefore ? "unchanged" : "CHANGED TO " + keyringDigestAfter?.slice(0, 12)));
  } else {
    console.log("  note  this host states no login keyring, so there was nothing to compare: the run's own store was the only one addressed");
  }
  if (failures.length > 0) { console.error("T16 native acceptance checks FAILED: " + failures.join(" | ")); process.exit(1); }
  console.log("T16 native acceptance checks PASSED (debug build; native functional evidence only)");
  process.exit(0);
}
