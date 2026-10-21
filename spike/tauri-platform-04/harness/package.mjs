/**
 * Ticket 04 packaging evidence: inspect the produced .deb, extract it, and run the
 * packaged binary's own embedded UI under Xvfb.
 *
 * Installing needs root on this host, so the run uses the package's real installed
 * layout after extraction. That is package contents plus packaged-binary execution;
 * it is not a system install, and the report says so.
 *
 * Usage: node harness/package.mjs [--log-dir=<dir>]
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createState, startServer, PORTS } from "./server.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const arg = (name, fallback) => args.find((a) => a.startsWith("--" + name + "="))?.split("=")[1] ?? fallback;
const root = resolve(import.meta.dirname, "..");
const logDir = resolve(arg("log-dir", join(root, "logs", "package")));
const extractDir = join(logDir, "extract");
mkdirSync(extractDir, { recursive: true });

const assertions = [];
const assert = (name, ok, detail) => assertions.push({ name, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 600) });

const bundleDir = join(root, "src-tauri/target/release/bundle/deb");
const deb = readdirSync(bundleDir).find((f) => f.endsWith(".deb"));
const debPath = join(bundleDir, deb);

async function capture(name, command, commandArgs, options) {
  try {
    const result = await run(command, commandArgs, { maxBuffer: 32 * 1024 * 1024, ...options });
    writeFileSync(join(logDir, name + ".log"), result.stdout + result.stderr);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    writeFileSync(join(logDir, name + ".log"), String(error.stdout ?? "") + String(error.stderr ?? "") + String(error));
    return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

const state = createState();
const server = await startServer({ port: PORTS.main, state });

try {
  const info = await capture("dpkg-deb-info", "dpkg-deb", ["-I", debPath]);
  const contents = await capture("dpkg-deb-contents", "dpkg-deb", ["-c", debPath]);
  assert("deb-package-exists", statSync(debPath).size > 0, deb + " " + statSync(debPath).size + " bytes");
  assert("deb-declares-depends", /Depends:/.test(info.stdout), info.stdout.split("\n").filter((l) => l.includes("Depends")).join(" "));
  assert("deb-arch-amd64", /Architecture: amd64/.test(info.stdout), "amd64");
  assert("deb-has-usr-bin", contents.stdout.includes("usr/bin/hepi-spike-04"), "usr/bin entry present");
  assert("deb-has-desktop-entry", /applications\/.*\.desktop/.test(contents.stdout), "desktop entry present");

  const unpack = await capture("dpkg-deb-extract", "dpkg-deb", ["-x", debPath, extractDir]);
  assert("deb-extract", unpack.ok, join(logDir, "dpkg-deb-extract.log"));
  const packagedBin = join(extractDir, "usr/bin/hepi-spike-04");
  assert("packaged-binary-present", statSync(packagedBin).isFile(), packagedBin);

  const ldd = await capture("ldd-packaged", "ldd", [packagedBin]);
  const missing = ldd.stdout.split("\n").filter((l) => l.includes("not found"));
  assert("packaged-binary-deps-resolved", missing.length === 0, missing.join("; ") || "all shared libraries resolved");

  const stdoutLog = createWriteStream(join(logDir, "packaged-run.stdout.log"));
  const stderrLog = createWriteStream(join(logDir, "packaged-run.stderr.log"));
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1024x768x24", packagedBin], {
    env: {
      ...process.env,
      SPIKE_MODE: "smoke",
      SPIKE_RESULT_URL: "http://127.0.0.1:" + PORTS.main + "/result",
      SPIKE_MAIN_ORIGIN: "http://127.0.0.1:" + PORTS.main,
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    },
  });
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !state.phases.smoke) await new Promise((r) => setTimeout(r, 250));
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  if (child.exitCode === null) child.kill("SIGKILL");

  assert("packaged-binary-reported", Boolean(state.phases.smoke), state.phases.smoke ? "report received" : "no report within 120s");
  const smoke = state.facts().results.filter((r) => r.name === "smoke-fetch");
  assert("packaged-binary-fetch", smoke[0]?.ok === true, smoke[0]?.detail ?? "missing");
  const origin = state.facts().results.find((r) => r.name === "page-origin");
  assert("packaged-binary-origin", Boolean(origin), origin?.detail ?? "missing");

  const report = { ticket: "04", kind: "packaging", ranAt: new Date().toISOString(), logDir, deb: debPath, assertions, pageResults: state.facts().results };
  writeFileSync(join(logDir, "report.json"), JSON.stringify(report, null, 2));
  const failed = assertions.filter((a) => !a.ok);
  console.log(JSON.stringify({ logDir, passed: assertions.length - failed.length, failed: failed.map((f) => f.name) }, null, 2));
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  writeFileSync(join(logDir, "package-error.log"), String(error?.stack ?? error));
  console.error(error);
  process.exitCode = 2;
} finally {
  server.close();
}