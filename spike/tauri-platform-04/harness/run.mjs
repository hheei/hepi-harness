#!/usr/bin/env node
/**
 * Ticket 04 desktop harness: starts the fixture servers, runs the real Tauri binary
 * (built WebKitGTK 4.1 WebView) under a real X display, then asserts the platform
 * facts from *server-side* records plus the page's own report.
 *
 * Phases: run (all transport/storage checks) -> persist (write credential) -> cold
 * (new process must read it, proving the store outlives the process).
 *
 * Usage: node harness/run.mjs [--log-dir=<dir>] [--skip-build]
 * Exit 0 only when every assertion holds; each run writes raw logs beside its report.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createState, startServer, PORTS } from "./server.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => args.find((a) => a.startsWith("--" + name + "="))?.split("=")[1] ?? fallback;
const root = resolve(import.meta.dirname, "..");
const logDir = resolve(arg("log-dir", join(root, "logs", new Date().toISOString().replace(/[:.]/g, "-"))));
const skipBuild = args.includes("--skip-build");
mkdirSync(logDir, { recursive: true });

const binPath = join(root, "src-tauri/target/release/hepi-spike-04");
const savePath = join(logDir, "saved.bin");
const assertions = [];
const assert = (name, ok, detail) => assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 500) });

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, commandArgs, { cwd: root, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function build() {
  const started = Date.now();
  const result = await run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], {
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
  });
  writeFileSync(join(logDir, "cargo-build.log"), result.stdout + result.stderr);
  writeFileSync(
    join(logDir, "cargo-build.json"),
    JSON.stringify({ command: "cargo build --release --manifest-path src-tauri/Cargo.toml", exitCode: result.code, ms: Date.now() - started }, null, 2),
  );
  return result.code === 0;
}

// Fail fast instead of a raw EADDRINUSE stack when another run still holds the ports.
async function portsFree() {
  const net = await import("node:net");
  for (const port of Object.values(PORTS)) {
    const free = await new Promise((resolveFree) => {
      const probe = net.createServer();
      probe.once("error", () => resolveFree(false));
      probe.once("listening", () => probe.close(() => resolveFree(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (!free) return port;
  }
  return null;
}

const busyPort = await portsFree();
if (busyPort !== null) {
  console.error("fixture port " + busyPort + " is already in use; stop the other run first");
  process.exit(3);
}

const state = createState();
let servers = [];

// One X server for the whole run, with the app started directly under it. Wrapping the
// binary in `xvfb-run` would leave the WebView process orphaned when the harness kills
// the wrapper, which is exactly what the process-death phase must not do.
let display = null;
async function startDisplay() {
  for (let number = 90; number < 120; number += 1) {
    const candidate = ":" + number;
    if (existsSync("/tmp/.X11-unix/X" + number)) continue;
    const xvfb = spawn("Xvfb", [candidate, "-screen", "0", "1280x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
    const started = await new Promise((resolveStart) => {
      const deadline = Date.now() + 10000;
      const poll = () => {
        if (existsSync("/tmp/.X11-unix/X" + number)) return resolveStart(true);
        if (Date.now() > deadline || xvfb.exitCode !== null) return resolveStart(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    if (started) return { number: candidate, xvfb };
    xvfb.kill("SIGKILL");
  }
  throw new Error("could not start an Xvfb display");
}

async function launch(mode) {
  const stdoutLog = createWriteStream(join(logDir, `app-${mode}.stdout.log`));
  const stderrLog = createWriteStream(join(logDir, `app-${mode}.stderr.log`));
  const child = spawn(
    binPath,
    [],
    {
      cwd: root,
      detached: true,
      env: {
        ...process.env,
        DISPLAY: display.number,
        SPIKE_MODE: mode,
        SPIKE_RESULT_URL: `http://127.0.0.1:${PORTS.main}/result`,
        SPIKE_MAIN_ORIGIN: `http://127.0.0.1:${PORTS.main}`,
        SPIKE_CORS_ORIGIN: `http://127.0.0.1:${PORTS.cors}`,
        SPIKE_BLOCKED_ORIGIN: `http://127.0.0.1:${PORTS.blocked}`,
        SPIKE_SAVE_PATH: savePath,
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      },
    },
  );
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);
  const exit = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
  return { child, exit };
}

function signal(child, name) {
  try {
    process.kill(-child.pid, name);
  } catch {
    child.kill(name);
  }
}

async function waitForPhase(mode, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.phases[mode]) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function stop(handle) {
  if (!handle) return;
  if (handle.child.exitCode === null) signal(handle.child, "SIGTERM");
  const result = await Promise.race([handle.exit, new Promise((r) => setTimeout(() => r({ code: "timeout" }), 15000))]);
  if (handle.child.exitCode === null) signal(handle.child, "SIGKILL");
  return result;
}

try {
  display = await startDisplay();
  servers = await Promise.all([
    startServer({ port: PORTS.main, state }),
    startServer({ port: PORTS.cors, state, cors: true }),
    startServer({ port: PORTS.blocked, state }),
  ]);

  if (!skipBuild) {
    const built = await build();
    assert("cargo-build", built, join(logDir, "cargo-build.log"));
    if (!built) throw new Error("build failed; see cargo-build.log");
  }

  const runPhase = await launch("run");
  const runOk = await waitForPhase("run", 240000);
  const runExit = await stop(runPhase);
  assert("run-phase-reported", runOk, runOk ? "report received" : "no report within 240s");
  assert("run-process-exit", runExit.code === 0 || runExit.signal === "SIGTERM", JSON.stringify(runExit));

  for (const memMode of ["mem-bare", "mem-ipc", "mem-ipc-small", "upload"]) {
    const handle = await launch(memMode);
    const ok = await waitForPhase(memMode, 180000);
    await stop(handle);
    assert(memMode + "-reported", ok, String(ok));
  }

  // Process kill while a stream is attached: the server must observe the disconnect.
  const killPhase = await launch("kill");
  const killAttached = await waitForPhase("kill-attached", 90000);
  await new Promise((r) => setTimeout(r, 2000));
  const streamsBeforeKill = state.streams.length;
  signal(killPhase.child, "SIGKILL");
  const killExit = await killPhase.exit;
  await new Promise((r) => setTimeout(r, 1500));
  const killedStream = state.streams[streamsBeforeKill - 1];
  const killMarks = state.marks.filter((m) => m.name === "stream-attached");
  assert("kill-phase-attached", killAttached && killPhase.child.exitCode !== 0, JSON.stringify({ killAttached, exit: killExit }));
  assert("kill-closes-attached-stream", killedStream?.closedAt !== null && killedStream?.closedAt !== undefined, JSON.stringify(killedStream ?? null));
  assert(
    "kill-was-not-a-graceful-exit",
    killMarks.length === 1 && (killedStream?.closedAt ?? 0) > killMarks[0].at + 1000,
    JSON.stringify({ marks: killMarks, stream: killedStream ?? null }),
  );

  const persistPhase = await launch("persist");
  const persistOk = await waitForPhase("persist", 60000);
  await stop(persistPhase);
  assert("persist-phase-reported", persistOk, String(persistOk));

  const coldPhase = await launch("cold");
  const coldOk = await waitForPhase("cold", 90000);
  await stop(coldPhase);
  assert("cold-phase-reported", coldOk, String(coldOk));

  const facts = state.facts();
  const page = facts.results;

  const pageAssertion = (name) => page.find((r) => r.name === name);
  const expectPage = (name, extra) => {
    const found = pageAssertion(name);
    assert("page:" + name, found?.ok === true, found ? found.detail : "missing");
    if (extra) extra(found);
  };
  // Observations are recorded as measured facts, not as pass/fail expectations.
  const expectObservation = (name) => {
    const found = pageAssertion(name);
    assert("observed:" + name, Boolean(found), found ? found.detail : "missing");
  };

  expectPage("webview-user-agent", (found) => {
    assert("webview-is-webkitgtk", /WebKit/i.test(found?.detail ?? ""), found?.detail ?? "");
    assert("webview-not-chromium", !/Chrome\//i.test(found?.detail ?? ""), found?.detail ?? "");
  });
  expectPage("fetch-basic");
  expectPage("sse-frames");
  expectPage("sse-status");
  expectPage("sse-incremental");
  expectPage("sse-cancel-client");
  expectPage("sse-truncation-needs-protocol-signal");
  expectObservation("sse-drop-observation");
  expectObservation("big-chunk-shape");
  expectObservation("page-origin");
  expectObservation("tauri-internals");
  expectPage("submit-twice");
  expectPage("cors-allowed-origin");
  expectPage("csp-blocks-unlisted-origin");
  expectPage("big-stream-received");
  expectPage("big-native-save");
  expectPage("big-arraybuffer");
  expectObservation("big-stream-noipc");
  // Measured negative capability: WebKitGTK rejects a ReadableStream request body.
  expectObservation("upload-readable-stream");
  expectPage("upload-blob");
  expectObservation("mem-bare");
  expectObservation("mem-ipc");
  expectObservation("mem-ipc-small");
  expectObservation("upload-memory");
  // Uploads: the platform rejected a streamed request body, so only the Blob body reached
  // the server; its arrival is what proves the accepted path end to end.
  const uploads = facts.uploads;
  assert(
    "server-saw-blob-upload",
    uploads.length === 1 && uploads[0].label === "blob" && uploads[0].bytes === 48 * 1024 * 1024,
    JSON.stringify(uploads.map((u) => ({ label: u.label, bytes: u.bytes, chunks: u.chunks, totalMs: u.totalMs }))),
  );
  assert(
    "server-saw-no-streamed-upload",
    !uploads.some((u) => u.label === "readable-stream"),
    JSON.stringify(uploads.map((u) => u.label)),
  );

  // Memory invariant: handing the WebView's own multi-tens-of-MB chunk to IPC makes the
  // peak follow the chunk, while slicing before IPC keeps it bounded.
  const memValue = (name) => {
    const found = pageAssertion(name);
    try {
      return found ? JSON.parse(found.detail) : null;
    } catch {
      return null;
    }
  };
  const ipc = memValue("mem-ipc");
  const ipcSmall = memValue("mem-ipc-small");
  const bare = memValue("mem-bare");
  assert("mem-ipc-whole-chunk-peak", (ipc?.hwmAfterKb ?? 0) > 1_000_000, JSON.stringify(ipc));
  assert("mem-ipc-bounded-peak", (ipcSmall?.hwmAfterKb ?? Number.MAX_SAFE_INTEGER) < 1_000_000, JSON.stringify(ipcSmall));
  assert(
    "mem-ipc-bounded-saves-same-bytes",
    ipcSmall?.received === ipc?.received && ipcSmall?.received === 96 * 1024 * 1024,
    JSON.stringify({ whole: ipc?.received, bounded: ipcSmall?.received }),
  );
  assert("mem-bare-stays-bounded", (bare?.hwmAfterKb ?? Number.MAX_SAFE_INTEGER) < 1_000_000, JSON.stringify(bare));
  expectPage("credential-roundtrip");
  expectPage("credential-delete");
  expectPage("resume-fetch");
  expectPage("process-memory");
  expectPage("cold-credential-survives");
  expectPage("cold-credential-deleted");

  // Server-side facts: the WebView really connected, really disconnected, really saved.
  assert("server-saw-streams", facts.streams.length >= 3, JSON.stringify(facts.streams.map((s) => ({ id: s.id, sent: s.sent, aborted: s.aborted }))));
  const cancelledStream = facts.streams.find((s) => s.frames === 50 && s.dropAfter === 0);
  assert("server-saw-cancel", cancelledStream?.aborted === true, JSON.stringify(cancelledStream ?? null));
  const droppedStream = facts.streams.find((s) => s.dropAfter > 0);
  assert("server-dropped-stream", droppedStream?.sent === droppedStream?.dropAfter, JSON.stringify(droppedStream ?? null));
  assert("server-saw-one-submission", facts.submissions.length === 1, JSON.stringify(facts.submissions));
  assert("server-saw-big-requests", facts.bigRequests.length >= 2, JSON.stringify(facts.bigRequests));

  const savedSize = existsSync(savePath) ? statSync(savePath).size : -1;
  const savedSha = existsSync(savePath) ? createHash("sha256").update(readFileSync(savePath)).digest("hex") : "";
  assert("native-save-file-size", savedSize === 96 * 1024 * 1024, savedSize + " bytes, sha256 " + savedSha);
  // The saved payload is a 96 MiB fixture; its size and digest are the evidence, so the
  // bytes themselves are dropped unless a reproduction asks to keep them.
  if (existsSync(savePath) && !args.includes("--keep-artifacts")) unlinkSync(savePath);
  assert("blocked-origin-never-reached-server", !facts.results.some((r) => r.name === "blocked-origin-server-hit"), "no hit recorded");

  const report = {
    ticket: "04",
    target: "desktop: Linux x86_64 / WebKitGTK 4.1 / Tauri v2",
    ranAt: new Date().toISOString(),
    logDir,
    assertions,
    pageResults: page,
    serverFacts: facts,
  };
  writeFileSync(join(logDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(logDir, "report.md"),
    [
      "# Spike 04 desktop run",
      "",
      "- ran at: " + report.ranAt,
      "- log dir: " + logDir,
      "- assertions: " + assertions.filter((a) => a.ok).length + "/" + assertions.length + " passed",
      "",
      "| assertion | result | detail |",
      "| --- | --- | --- |",
      ...assertions.map((a) => `| ${a.name} | ${a.ok ? "pass" : "FAIL"} | ${a.detail.replace(/\|/g, "\\|").slice(0, 160)} |`),
      "",
    ].join("\n"),
  );

  const failed = assertions.filter((a) => !a.ok);
  console.log(JSON.stringify({ logDir, passed: assertions.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  writeFileSync(join(logDir, "harness-error.log"), String(error?.stack ?? error));
  console.error(error);
  process.exitCode = 2;
} finally {
  for (const server of servers) server?.close();
  if (display) display.xvfb.kill("SIGTERM");
}
