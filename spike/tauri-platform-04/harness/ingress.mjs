#!/usr/bin/env node
/**
 * Ticket 04 live check: the real Tauri WebView against a real client ingress and a real
 * Backend from ticket 03, not a fixture server.
 *
 * What this adds over the fixture phase is the deployment's actual security surface: the
 * page origin is the Tauri custom protocol, so the ingress must answer it as a declared App
 * origin; the device bearer is what the WebView holds; and the conversation read, submit and
 * SSE path is the Backend's own contract through the ingress.
 *
 * Every material here is generated at run time: a literal would prove nothing about the
 * credential path this phase exists to exercise.
 *
 * Usage: node harness/ingress.mjs [--log-dir=<dir>]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const arg = (name, fallback) => args.find((a) => a.startsWith("--" + name + "="))?.split("=")[1] ?? fallback;
const root = resolve(import.meta.dirname, "..");
const logDir = resolve(arg("log-dir", join(root, "logs", "ingress")));
mkdirSync(logDir, { recursive: true });

const repo = resolve(root, "../..");
const assertions = [];
const assert = (name, ok, detail) => assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 700) });

const load = async (relative) => import(pathToFileURL(join(repo, relative)).href);
// The spike lives outside the workspace, so the packages it needs resolve through the
// repository's own links, and through their built entries: the "source" condition is only
// set by the repository's own runs.
const workspacePackage = async (packageDir, entry) => {
  const real = realpathSync(join(repo, "apps/server/node_modules", packageDir));
  return import(pathToFileURL(join(real, entry)).href);
};
const { BACKGROUND_CONTEXT } = await workspacePackage("@earendil-works/chord", "dist/context/index.js");
const { UserEntry } = await workspacePackage("@earendil-works/pi-durable", "dist/index.js");
const { openServerHarness } = await load("apps/server/src/harness.ts");
const { createBackendServer } = await load("apps/server/src/server.ts");
const { createDeviceCredentials } = await load("apps/server/src/device-credentials.ts");
const { createProjectStore } = await load("apps/server/src/project-store.ts");
const { fauxModels, SERVER_MODEL } = await load("apps/server/test/faux-fixture.ts");
const { createClientIngress } = await load("packages/gateway/src/ingress/index.ts");

// Materials generated for this run, so no value in the source can stand in for one.
const backendServiceMaterial = randomBytes(16).toString("hex");
const webLoginMaterial = randomBytes(16).toString("hex");
const TMP = await mkdtemp(join(tmpdir(), "hepi-spike04-ingress-"));

let display = null;
async function startDisplay() {
  for (let number = 90; number < 120; number += 1) {
    if (existsSync("/tmp/.X11-unix/X" + number)) continue;
    const candidate = ":" + number;
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

const credentials = createDeviceCredentials({ path: join(TMP, "device-credentials.sqlite") });
const projects = createProjectStore({ path: join(TMP, "projects.sqlite") });
const dbPath = join(TMP, "hepi.sqlite");

// A conversation whose prompt is large enough that the history projection defers it, so the
// read-block route ticket 07 added is exercised from the WebView rather than only in tests.
// TEXT_DEFER_BYTES is 64 KiB; this is comfortably past it.
const HEAVY_BYTES = 96 * 1024;
const HEAVY_SENTINEL = "deferred-prompt-sentinel";
const seeded = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
const seededConversation = await seeded.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
const heavyText = HEAVY_SENTINEL + "x".repeat(HEAVY_BYTES);
await seeded.harness.commit(async (tx) => {
  await tx.appendEntry(UserEntry, seededConversation.id, { model: [{ role: "user", content: heavyText, timestamp: 0 }] });
}, BACKGROUND_CONTEXT);
await seeded.close();

const backend = await createBackendServer({
  dbPath,
  authToken: backendServiceMaterial,
  models: fauxModels(),
  defaultModel: SERVER_MODEL,
  deviceCredentials: credentials,
  projects,
  buildId: "build-04",
  backendId: "backend-04",
  accountScope: "account-04",
});
await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
const backendPort = backend.server.address().port;

// The credential the WebView will hold, issued by the Backend's own store.
const issued = credentials.issue({ label: "spike-04" });

const ingress = createClientIngress({
  backend: { origin: "http://127.0.0.1:" + backendPort, serviceToken: backendServiceMaterial },
  webLoginToken: webLoginMaterial,
  // The WebView page origin. Answering a declared App origin cross-origin is the deployment
  // fact this phase exists to prove; the fixture phase never tested it.
  appOrigins: ["tauri://localhost", "http://tauri.localhost"],
});
// A fixed port, because the built CSP lists the gateway origin the app may reach. This is
// the deployment constraint the ticket asks about: an App's reachable gateway addresses are
// the ones its own content-security policy names, and a random port is not one of them.
const INGRESS_PORT = 18090;
await new Promise((r) => ingress.server.listen(INGRESS_PORT, "127.0.0.1", r));
const ingressOrigin = "http://127.0.0.1:" + INGRESS_PORT;

const served = [];
ingress.server.on("request", (request) =>
  served.push((request.method ?? "GET") + " " + (request.url ?? "/") + " origin=" + (request.headers.origin ?? "-") + " auth=" + (request.headers.authorization ? "bearer" : "none")),
);

let child = null;
try {
  display = await startDisplay();
  const stdoutLog = createWriteStream(join(logDir, "app-ingress.stdout.log"));
  const stderrLog = createWriteStream(join(logDir, "app-ingress.stderr.log"));
  child = spawn(join(root, "src-tauri/target/release/hepi-spike-04"), [], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      DISPLAY: display.number,
      SPIKE_MODE: "ingress",
      SPIKE_INGRESS_ORIGIN: ingressOrigin,
      SPIKE_INGRESS_TOKEN: issued.token,
      SPIKE_INGRESS_HEAVY_CONVERSATION: String(seededConversation.id),
      SPIKE_INGRESS_HEAVY_SENTINEL: HEAVY_SENTINEL,
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    },
  });
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);

  const exit = await Promise.race([
    new Promise((r) => child.on("close", (code, signal) => r({ code, signal }))),
    new Promise((r) => setTimeout(() => r({ code: "timeout" }), 180000)),
  ]);
  if (child.exitCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  assert("app-exited", exit.code === 0, JSON.stringify(exit));

  const pageLine = readResultLine();
  const page = pageLine ? JSON.parse(pageLine) : null;
  assert("page-reported", page !== null, pageLine ? "report line found" : "no report line in the app log");
  if (page) for (const entry of page.results) assert("page:" + entry.name, entry.ok === true, entry.detail);

  const appOriginLines = served.filter((line) => line.includes("origin=tauri://localhost") || line.includes("origin=http://tauri.localhost"));
  assert("ingress-answered-app-origin", appOriginLines.length > 0, appOriginLines.slice(0, 8).join(" | ") || served.slice(0, 8).join(" | "));
  assert("ingress-saw-device-bearer", served.some((line) => line.includes("auth=bearer")), "a device bearer reached the ingress");
  assert("ingress-served-descriptor", served.some((line) => line.includes("/api/descriptor")), "descriptor requested");
  assert("ingress-served-conversation", served.some((line) => line.includes("/api/conversations")), "conversation route used");
  assert("ingress-served-events", served.some((line) => line.includes("/events")), "SSE route used");
  assert("ingress-served-no-internal-v1", !served.some((line) => line.includes("/v1/")), "no internal route on the client listener");
  writeFileSync(join(logDir, "ingress-served.json"), JSON.stringify(served, null, 2));
} catch (error) {
  writeFileSync(join(logDir, "ingress-error.log"), String(error?.stack ?? error));
  assert("harness", false, String(error?.message ?? error));
} finally {
  await ingress.close();
  credentials.close();
  projects.close();
  await backend.close();
  if (display) display.xvfb.kill("SIGTERM");
  await rm(TMP, { recursive: true, force: true });
}

function readResultLine() {
  // The app writes one JSON line to stdout when its phase ends.
  try {
    const text = readFileSync(join(logDir, "app-ingress.stdout.log"), "utf8");
    // Only the final report carries the phase's results; intermediate lines are diagnostics.
    const lines = text.split("\n").filter((entry) => entry.startsWith("SPIKE_RESULT "));
    const report = lines.map((entry) => entry.slice("SPIKE_RESULT ".length)).filter((entry) => entry.includes('"results"'));
    return report.length > 0 ? report[report.length - 1] : null;
  } catch {
    return null;
  }
}

const report = { ticket: "04", kind: "live-ingress", ranAt: new Date().toISOString(), logDir, assertions };
writeFileSync(join(logDir, "report.json"), JSON.stringify(report, null, 2));
const failed = assertions.filter((a) => !a.ok);
console.log(JSON.stringify({ logDir, passed: assertions.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;