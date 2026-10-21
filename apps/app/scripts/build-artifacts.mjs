/**
 * Build the current client's artifacts, and record what they were built from.
 *
 * Two products, one record: the static Web build (served by the client ingress on its own origin) and the desktop App
 * package (the shared workbench inside the Tauri shell). What this writes is the evidence the ticket asks for — source
 * revisions, host, target architecture, toolchain versions, the artifact checksums and the raw logs — and nothing that
 * has to be kept in sync by hand afterwards.
 *
 * **The profile is chosen, and it is stated.** `--profile=debug` (the default) is a development build: it keeps its
 * symbols, compiles incrementally and is what current development and its acceptance run. `--profile=release` is the
 * optimised build from `apps/app/src-tauri/Cargo.toml`'s own release profile (`opt-level = "s"`, LTO,
 * `codegen-units = 1`, stripped symbols, `panic = "abort"`) and is what a production package would be; it is never
 * the default, because a release rebuild is expensive and a debug artifact labelled "production" would be a false
 * claim. `provenance.json` records which profile produced the artifacts, and the App package's own name says so
 * (`--debug` builds land in `target/debug` and their `.deb` carries the Tauri debug marker).
 *
 * Usage:
 *   node apps/app/scripts/build-artifacts.mjs [--label=<name>] [--profile=debug|release] [--skip-web] [--skip-app]
 *                                             [--reproduce]
 *
 * `--reproduce` builds the shell a second time from the same sources and compares the two artifacts, so the claim
 * "rebuildable" is a measurement in the record rather than a statement about the build script.
 *
 * Both builds share one Cargo target directory (`apps/app/scripts/cargo-build.mjs`) with six jobs and incremental
 * compilation, so a second build reuses the first one's crates instead of compiling a second tree.
 *
 * Output: .dev/artifacts/<label>/ with the packages, a checksums file, provenance.json and logs/.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { PROFILES, cargoBuildEnvironment, cargoOutputPaths, sharedRepoRoot } from "./cargo-build.mjs";

const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");

const args = process.argv.slice(2);
const arg = (name, fallback) => args.find(a => a.startsWith("--" + name + "="))?.split("=").slice(1).join("=") ?? fallback;
const flag = name => args.includes("--" + name);

/** Which Rust profile this run builds. Development is the default; a release build is asked for explicitly. */
const profile = arg("profile", "debug");
if (!PROFILES.includes(profile)) {
  console.error("Unknown --profile=" + profile + ". Known: " + PROFILES.join(", "));
  process.exit(2);
}
const cargo = { profile, env: cargoBuildEnvironment(repo, profile), paths: cargoOutputPaths(repo, profile) };

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const label = arg("label", stamp);
const outDir = path.join(repo, ".dev", "artifacts", label);
const logDir = path.join(outDir, "logs");

async function git(...argv) {
  const { stdout } = await run("git", argv, { cwd: repo });
  return stdout.trim();
}

/** One command, its log kept verbatim, and a failure that carries the log path rather than a summary of it. */
async function step(name, command, commandArgs, options = {}) {
  const started = Date.now();
  const record = { name, command: [command, ...commandArgs].join(" "), exit: null, log: path.join(logDir, name + ".log"), seconds: 0 };
  try {
    const result = await run(command, commandArgs, { cwd: repo, maxBuffer: 64 * 1024 * 1024, ...options });
    await writeFile(record.log, String(result.stdout ?? "") + String(result.stderr ?? ""));
    record.exit = 0;
  } catch (error) {
    await writeFile(record.log, String(error.stdout ?? "") + String(error.stderr ?? "") + String(error?.stack ?? error));
    record.exit = typeof error.code === "number" ? error.code : 1;
  }
  record.seconds = Math.round((Date.now() - started) / 1000);
  steps.push(record);
  if (record.exit !== 0) throw new Error(`${name} failed (exit ${record.exit}); see ${record.log}`);
  return record;
}

async function toolchain() {
  const probe = async (command, commandArgs) => {
    try {
      const { stdout } = await run(command, commandArgs, { cwd: repo });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  return {
    node: process.version,
    pnpm: await probe("pnpm", ["--version"]),
    rustc: await probe("rustc", ["--version"]),
    cargo: await probe("cargo", ["--version"]),
    tauriCli: await probe(path.join(repo, "apps", "app", "node_modules", ".bin", "tauri"), ["--version"]),
    webkit2gtk: await probe("pkg-config", ["--modversion", "webkit2gtk-4.1"]),
    host: (await probe("uname", ["-a"])) ?? null,
    arch: process.arch === "x64" ? "x86_64" : process.arch,
  };
}

/**
 * The App's own release profile, read from its manifest rather than restated here.
 *
 * A record that says "release" without saying what the release profile optimises is a label, not evidence, and a
 * hand-copied table in this file would drift from the `Cargo.toml` that actually decides it.
 */
async function releaseProfile() {
  const manifest = await readFile(path.join(repo, "apps", "app", "src-tauri", "Cargo.toml"), "utf8");
  const section = manifest.split(/^\[profile\.release\]$/m)[1]?.split(/^\[/m)[0] ?? "";
  const settings = {};
  for (const line of section.split("\n")) {
    const match = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match) settings[match[1]] = match[2];
  }
  return settings;
}

/**
 * The cache this run builds into, measured rather than assumed: an evidence field, and what the retention rule bounds.
 *
 * `present: false` is a real answer — the first build of a fresh cache — and is kept apart from `bytes: null`, which
 * means the measurement itself failed. A record that merged the two would claim a size it never read.
 */
async function cacheUsage(directory) {
  if (!existsSync(directory)) return { directory, present: false, bytes: 0 };
  try {
    const { stdout } = await run("du", ["-s", "--block-size=1", directory]);
    const bytes = Number(stdout.trim().split(/\s+/)[0]);
    return { directory, present: true, bytes: Number.isFinite(bytes) ? bytes : null };
  } catch {
    return { directory, present: true, bytes: null };
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => createReadStream(file).on("data", chunk => hash.update(chunk)).on("end", resolve).on("error", reject));
  return hash.digest("hex");
}

const steps = [];

await mkdir(logDir, { recursive: true });

const revision = await git("rev-parse", "HEAD");
const dirty = (await git("status", "--porcelain")).length > 0;
const provenance = {
  kind: "hepi-client-artifacts",
  label,
  builtAt: new Date().toISOString(),
  revision,
  dirty,
  branch: await git("rev-parse", "--abbrev-ref", "HEAD"),
  toolchain: await toolchain(),
  // Which profile produced these artifacts, and the settings that profile really means. `production: false` on a debug
  // build is the record's own statement that this artifact is not a release package.
  build: {
    profile,
    production: profile === "release",
    cargo: { ...cargo.env },
    sharedRepository: sharedRepoRoot(repo),
    outputDir: cargo.paths.profileDir,
    releaseProfile: await releaseProfile(),
    cacheBefore: await cacheUsage(cargo.paths.targetDir),
  },
  artifacts: [],
  steps,
};

try {
  // The shell embeds the UI bundle, so the UI is always built here; the Web build is the second product.
  await step("app-ui-build", "pnpm", ["--filter", "@hepi/app", "build"]);
  if (!flag("skip-web")) await step("web-build", "pnpm", ["--filter", "@hepi/web", "build"]);

  if (!flag("skip-app")) {
    // The shell is stamped with the checkout it came from, so a packaged binary names its own source rather than
    // whatever tree happens to be open beside it. The profile is the caller's: `--debug` is what makes this a
    // development build, and the shared cache environment is what keeps the second build cheap.
    await step("shell-build", "pnpm", ["--filter", "@hepi/app", "exec", "tauri", "build", "--bundles", "deb", ...(profile === "debug" ? ["--debug"] : [])], {
      env: { ...process.env, ...cargo.env, HEPI_CLIENT_REVISION: revision, HEPI_SHELL_REVISION: revision },
    });
  }

  const first = { binary: await sha256(cargo.paths.binary) };

  const copies = [];
  const bundleDir = cargo.paths.bundleDir;
  if (!flag("skip-app")) {
    for (const name of await readdir(bundleDir)) {
      if (name.endsWith(".deb")) copies.push([path.join(bundleDir, name), path.join(outDir, name)]);
    }
    copies.push([cargo.paths.binary, path.join(outDir, "hepi-app")]);
  }
  if (!flag("skip-web")) {
    // The Web product is the directory the ingress will serve; its checksums are recorded per file so a served asset can be
    // matched to the revision that produced it.
    const webDist = path.join(repo, "apps", "web", "dist");
    for (const entry of await readdir(webDist, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const from = path.join(entry.parentPath ?? entry.path, entry.name);
      copies.push([from, path.join(outDir, "web", path.relative(webDist, from))]);
    }
  }

  let recordedPackageSha = null;
  for (const [from, to] of copies) {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    const info = await stat(to);
    const sha = await sha256(to);
    if (to.endsWith(".deb")) recordedPackageSha = sha;
    provenance.artifacts.push({
      path: path.relative(outDir, to),
      bytes: info.size,
      sha256: sha,
      target: to.includes("web" + path.sep) ? "static-web" : provenance.toolchain.arch,
    });
  }

  if (flag("reproduce")) {
    // The same sources, the same toolchain, the same revision, the same profile and the same cache: what a second
    // build produces is the measurement. Every one of those is passed again rather than inherited, because a rebuild
    // that silently used a different profile would compare two artifacts that were never meant to match.
    const second = path.join(outDir, "rebuild");
    await mkdir(second, { recursive: true });
    await step("shell-rebuild", "pnpm", ["--filter", "@hepi/app", "exec", "tauri", "build", "--bundles", "deb", ...(profile === "debug" ? ["--debug"] : [])], {
      env: { ...process.env, ...cargo.env, HEPI_CLIENT_REVISION: revision, HEPI_SHELL_REVISION: revision },
    });
    const rebuiltDeb = (await readdir(bundleDir)).find(name => name.endsWith(".deb"));
    await copyFile(path.join(bundleDir, rebuiltDeb), path.join(second, rebuiltDeb));
    const again = { binary: await sha256(cargo.paths.binary), package: await sha256(path.join(second, rebuiltDeb)) };
    provenance.reproducibility = {
      profile,
      executable: { first: first.binary, second: again.binary, identical: first.binary === again.binary },
      package: { first: recordedPackageSha, second: again.package, identical: recordedPackageSha === again.package },
      // The Tauri bundler writes the bundling time into the package's member mtimes and does not read
      // SOURCE_DATE_EPOCH, so two identical payloads differ as package bytes. Measured, not assumed.
      note: "the package container records its bundling time; the executable it carries is the compared artifact",
    };
  }

  // What the build left in the cache, so the retention rule has a measurement and not an assumption.
  provenance.build.cacheAfter = await cacheUsage(cargo.paths.targetDir);
  const sums = provenance.artifacts.map(a => `${a.sha256}  ${a.path}`).join("\n") + "\n";
  await writeFile(path.join(outDir, "checksums.sha256"), sums);
  await writeFile(path.join(outDir, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.log(JSON.stringify({
    outDir,
    revision,
    dirty,
    artifacts: provenance.artifacts.map(a => ({ path: a.path, bytes: a.bytes })),
    failedSteps: steps.filter(s => s.exit !== 0).map(s => s.name),
  }, null, 2));
} catch (error) {
  provenance.failure = String(error?.message ?? error);
  await writeFile(path.join(outDir, "provenance.json"), JSON.stringify(provenance, null, 2));
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
}
