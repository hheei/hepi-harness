#!/usr/bin/env node
/**
 * Pack the client, install the tarball in a clean directory outside this checkout, and use the installed CLI for
 * real: help, doctor, a local gateway serving authenticated reads and commands, and — when the machine has an
 * OpenSSH daemon — an SSH gateway against a real localhost sshd with isolated keys and a pinned known-hosts file.
 *
 * Nothing here reaches the checkout at run time: the installed package resolves its own dependencies, and the CLI is
 * started from a temporary working directory. This is the check the release workflow runs before uploading the
 * tarball, so a package that only works inside the repository fails here instead of at `npm install`.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const fail = (message) => { throw new Error(message); };
const record = (name, detail) => { checks.push(name + ": " + detail); process.stdout.write("ok   " + name + " — " + detail + "\n"); };

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectRun(new Error(command + " timed out: " + stderr.slice(-2000))); }, options.timeoutMs ?? 120_000);
    child.on("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ stdout, stderr });
      else rejectRun(new Error(command + " " + args.join(" ") + " exited " + code + "\n" + stdout + stderr));
    });
  });
}

/** Start the installed CLI and wait for its one-line readiness event, which carries no secret. */
async function startCli(bin, args, env, cwd) {
  const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("gateway did not report readiness: " + errors.join(""))), 60_000);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      for (const line of parts) {
        lines.push(line);
        try {
          const event = JSON.parse(line);
          if (event.event === "listening") { clearTimeout(timer); resolveReady(event); }
        } catch { /* not the readiness line */ }
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); rejectReady(new Error("gateway exited " + code + ": " + errors.join(""))); });
  });
  let event;
  try {
    event = await ready;
  } catch (error) {
    // A rejected readiness must not leave the child running: kill it and wait for the exit before rethrowing.
    child.kill("SIGKILL");
    await new Promise((resolveStop) => { if (child.exitCode !== null || child.signalCode !== null) resolveStop(); else child.once("close", resolveStop); });
    throw error;
  }
  return {
    event,
    output: () => lines.join("\n") + errors.join(""),
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolveStop) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolveStop(); }, 10_000);
        child.on("close", () => { clearTimeout(timer); resolveStop(); });
      });
    },
  };
}

/**
 * Wait until something accepts a TCP connection, bounded. sshd needs a moment to bind, and an SSH client that runs
 * before it listens fails for the wrong reason. Retries until the deadline and reports the last error.
 */
function waitForTcp(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const attempt = () => {
      const socket = connect({ host, port });
      socket.setTimeout(2_000);
      const retry = (error) => {
        if (settled) return;
        socket.destroy();
        if (Date.now() >= deadline) { settled = true; rejectReady(new Error("nothing accepted a connection on " + host + ":" + port + " within " + timeoutMs + "ms: " + error.message)); }
        else setTimeout(attempt, 50);
      };
      socket.once("connect", () => { if (settled) return; settled = true; socket.destroy(); resolveReady(); });
      socket.once("error", retry);
      socket.once("timeout", () => retry(new Error("connect timed out")));
    };
    attempt();
  });
}

async function post(origin, path, token, body) {
  const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/**
 * Run one call and return its result frame. `/v1/execute` answers with NDJSON: zero or more output frames, then the
 * single result frame that ends the response.
 */
async function execute(origin, token, body) {
  const response = await fetch(origin + "/v1/execute", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  const frames = text.split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line));
  const result = frames.findLast(frame => frame.type === "result");
  return { status: response.status, frames, result: result?.result };
}

/** Make `dir` a real repository with one commit, so the worktree surface has a branch to act on. */
async function gitRepository(dir) {
  await mkdir(dir, { recursive: true });
  await run("git", ["init", "-q", dir]);
  await run("git", ["-C", dir, "config", "user.email", "smoke@example.com"]);
  await run("git", ["-C", dir, "config", "user.name", "Smoke"]);
  await writeFile(join(dir, "README.md"), "baseline\n");
  await run("git", ["-C", dir, "add", "README.md"]);
  await run("git", ["-C", dir, "commit", "-qm", "baseline"]);
}

const workdir = await mkdtemp(join(tmpdir(), "hepi-client-smoke-"));
const workspace = join(workdir, "workspace");
const stateDir = join(workdir, "state");
let sshd;
try {
  // 1. Pack and install the tarball outside the checkout. `npm pack` runs no lifecycle script, so the tarball holds
  // exactly what `build` wrote plus the declared files.
  if (!existsSync(join(packageDir, "dist", "cli.js"))) fail("dist/cli.js is missing: run the client build before smoke:pack");
  const packed = await run("npm", ["pack", "--pack-destination", workdir, "--json"], { cwd: packageDir });
  const tarballName = JSON.parse(packed.stdout)[0].filename;
  const tarball = join(workdir, tarballName);
  const contents = (await run("tar", ["-tzf", tarball])).stdout.split("\n").filter(Boolean);
  for (const required of ["package/package.json", "package/dist/cli.js", "package/README.md", "package/LICENSE", "package/THIRD_PARTY_NOTICES.md"]) {
    if (!contents.includes(required)) fail("tarball is missing " + required + " (holds " + contents.join(", ") + ")");
  }
  // The tarball has to carry the manifest this package declares. Read it rather than assume a name and a version, so a
  // renamed scope or a later (or pre-release) version is checked against the truth instead of a hardcoded literal.
  const packedManifest = JSON.parse((await run("tar", ["-xzOf", tarball, "package/package.json"])).stdout);
  const sourceManifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (typeof sourceManifest.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(sourceManifest.name)) fail("package.json declares no usable package name: " + sourceManifest.name);
  if (typeof sourceManifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(sourceManifest.version)) fail("package.json declares no usable version: " + sourceManifest.version);
  if (packedManifest.name !== sourceManifest.name || packedManifest.version !== sourceManifest.version) {
    fail("packed identity " + packedManifest.name + "@" + packedManifest.version + " does not match package.json " + sourceManifest.name + "@" + sourceManifest.version);
  }
  for (const range of Object.values(packedManifest.dependencies ?? {})) {
    if (/^(workspace:|file:|link:)/.test(range)) fail("published dependency range is checkout-local: " + range);
  }
  // The bundled upstream MIT code needs its notice to travel with the copy, and the entry file is what runs.
  const bundled = (await run("tar", ["-xzOf", tarball, "package/dist/cli.js"])).stdout;
  // The MCP client's OAuth half adapts the Model Context Protocol TypeScript SDK (MIT, Copyright (c) 2024
  // Anthropic, PBC), whose notice the bundled dependency does not carry into the output; it travels in the
  // notice appended to the entry file, and this check is what keeps it there.
  // The gateway's remote helper carries a Python port of node-ignore's matching engine, so the port's copyright has
  // to travel with the bundle too, not only the npm package's own row.
  for (const notice of ["Copyright (c) 2025 Mario Zechner", "Earendil Works", "Kael Zhang", "node-ignore 7.0.5 port", "Copyright (c) 2026 Matthew Lam", "Copyright (c) 2026 agegr", "Copyright (c) 2024 Anthropic, PBC", "pi-coding-agent", "pi-mcp", "pi-web MCP masking rules", "Permission is hereby granted"]) {
    if (!bundled.includes(notice)) fail("dist/cli.js does not carry the bundled third-party notice: " + notice);
  }
  record("tarball", tarballName + " with " + contents.length + " entries, no checkout-local dependency, third-party notice bundled");

  const installDir = join(workdir, "install");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "package.json"), JSON.stringify({ name: "hepi-client-smoke", private: true, version: "1.0.0" }, null, 2) + "\n");
  await run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock", tarball], { cwd: installDir, timeoutMs: 300_000 });
  const bin = join(installDir, "node_modules", ".bin", "hepi-client");
  if (!existsSync(bin)) fail("installed package does not expose the hepi-client binary");
  record("install", "installed " + tarballName + " into a clean directory outside the checkout");

  // 2. The installed CLI from a working directory that is not the checkout.
  // Inside the workdir, so the cleanup below covers it: the CLI must run outside the checkout, not outside the cleanup.
  const outside = join(workdir, "cwd");
  await mkdir(outside, { recursive: true });
  const help = await run(bin, ["--help"], { cwd: outside, env: { PATH: process.env.PATH } });
  if (!/hepi-client \d+\.\d+\.\d+/.test(help.stdout) || !help.stdout.includes("--allowed-commands")) fail("--help did not print usage: " + help.stdout);
  const version = await run(bin, ["--version"], { cwd: outside, env: { PATH: process.env.PATH } });
  if (version.stdout.trim() !== packedManifest.version) fail("--version reported " + version.stdout.trim() + ", package is " + packedManifest.version);
  await run(bin, ["doctor", "--help"], { cwd: outside, env: { PATH: process.env.PATH } });
  record("cli", "help, version " + version.stdout.trim() + " and doctor --help run from " + outside);

  // 3. Doctor against a real workspace and journal directory, with a token that must not appear in the output.
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), "context\n");
  const token = "smoke-gateway-token";
  const doctor = await run(bin, ["doctor", "--root", workspace, "--data-dir", stateDir, "--json"], { cwd: outside, env: { PATH: process.env.PATH, HEPI_GATEWAY_TOKEN: token } });
  const doctorResult = JSON.parse(doctor.stdout);
  if (doctorResult.ok !== true || doctorResult.mode !== "local") fail("doctor did not report a healthy local gateway: " + doctor.stdout);
  if (doctor.stdout.includes(token) || doctor.stderr.includes(token)) fail("doctor printed the gateway token");
  const badDoctor = await run(bin, ["doctor", "--root", join(workdir, "missing"), "--data-dir", stateDir], { cwd: outside, env: { PATH: process.env.PATH, HEPI_GATEWAY_TOKEN: token } }).then(() => 0, (error) => error.message);
  if (badDoctor === 0 || !String(badDoctor).includes("fail workspace root")) fail("doctor accepted a missing workspace root: " + badDoctor);
  record("doctor", "healthy workspace and journal, failed root reported, token never printed");

  // 4. A real local gateway: authenticated read and command, refused without the token, traversal denied, and the
  // worktree surface acting on a real repository rather than answering a shape.
  await gitRepository(workspace);
  const local = await startCli(bin, ["gateway", "--root", workspace, "--data-dir", stateDir, "--allowed-commands", "node", "--port", "0"], { PATH: process.env.PATH, HEPI_GATEWAY_TOKEN: token }, outside);
  try {
    const read = await post(local.event.origin, "/v1/files", token, { workspaceId: "local", method: "readTextFile", path: "AGENTS.md" });
    if (read.status !== 200 || read.body?.ok !== true || read.body.value !== "context\n") fail("authenticated read failed: " + JSON.stringify(read));
    const unauthorized = await post(local.event.origin, "/v1/files", "wrong-token", { workspaceId: "local", method: "readTextFile", path: "AGENTS.md" });
    if (unauthorized.status !== 401) fail("an unauthenticated read was not refused: " + JSON.stringify(unauthorized));
    const traversal = await post(local.event.origin, "/v1/files", token, { workspaceId: "local", method: "readTextFile", path: "../outside.txt" });
    if (traversal.body?.ok !== false) fail("a traversal read was not refused: " + JSON.stringify(traversal));
    const executed = await execute(local.event.origin, token, { gatewayId: local.event.gatewayId, workspaceId: "local", callId: "smoke-call-1", command: [process.execPath, "-e", "process.stdout.write('smoke-command')"] });
    if (executed.result?.ok !== true || executed.result.stdout !== "smoke-command") fail("authenticated command failed: " + JSON.stringify(executed));
    // The host's MCP capability travels in the bundle: an installed CLI reads its own account's MCP
    // configuration and answers the operation. The account is the CLI process's own home, so the check
    // asserts the answer's shape and the file it names, not a particular user's configuration.
    const mcp = await post(local.event.origin, "/v1/mcp", token, { operation: "read" });
    if (mcp.status !== 200 || mcp.body?.ok !== true || !Array.isArray(mcp.body.value?.servers) || !Array.isArray(mcp.body.value?.files)) fail("the MCP operation did not answer a listing: " + JSON.stringify(mcp));
    if (!String(mcp.body.value.files[0]?.path).endsWith(join(".pi", "agent", "mcp.json"))) fail("the MCP listing did not name the account's own mcp.json: " + JSON.stringify(mcp.body.value.files));
    const mcpUnauthorized = await post(local.event.origin, "/v1/mcp", "wrong-token", { operation: "read" });
    if (mcpUnauthorized.status !== 401) fail("an unauthenticated MCP call was not refused: " + JSON.stringify(mcpUnauthorized));
    const listed = await post(local.event.origin, "/v1/worktrees", token, { operation: "list", workspaceId: "local" });
    if (listed.status !== 200 || listed.body?.ok !== true || listed.body.value?.isGit !== true) fail("the worktree listing did not describe the repository: " + JSON.stringify(listed));
    const created = await post(local.event.origin, "/v1/worktrees", token, { operation: "create", workspaceId: "local", branch: "smoke-worktree" });
    const worktreePath = created.body?.value?.path;
    if (created.body?.ok !== true || typeof worktreePath !== "string" || !existsSync(worktreePath)) fail("creating a worktree did not make a checkout: " + JSON.stringify(created));
    const removed = await post(local.event.origin, "/v1/worktrees", token, { operation: "remove", workspaceId: "local", path: worktreePath });
    if (removed.body?.ok !== true || existsSync(worktreePath)) fail("removing the worktree did not remove the checkout: " + JSON.stringify(removed));
    record("local gateway", "read, command, MCP listing, worktree list/create/remove and refusal of a bad token and a traversal path on " + local.event.origin);
  } finally { await local.stop(); }

  // 5. SSH mode against a real localhost sshd with isolated keys and a pinned known-hosts file. Skipped only when the
  // machine has no sshd or ssh-keygen to start; the release runner has both.
  const sshdBin = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find(candidate => existsSync(candidate));
  const sshKeygen = "/usr/bin/ssh-keygen";
  if (sshdBin === undefined || !existsSync(sshKeygen)) {
    // A release runner that must exercise SSH sets this, so a missing daemon fails the check instead of skipping it.
    if (process.env.HEPI_REQUIRE_SSH_SMOKE === "1") fail("HEPI_REQUIRE_SSH_SMOKE=1 but no local sshd or ssh-keygen is installed, so the SSH gateway could not be exercised");
    process.stdout.write("skip ssh gateway — no local sshd available on this machine\n");
  } else {
    const sshDir = join(workdir, "sshd");
    await mkdir(sshDir, { recursive: true });
    await run(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", join(sshDir, "hostkey")]);
    await run(sshKeygen, ["-q", "-t", "ed25519", "-N", "", "-f", join(sshDir, "userkey")]);
    const authorized = await readFile(join(sshDir, "userkey.pub"), "utf8");
    await writeFile(join(sshDir, "authorized_keys"), authorized);
    await chmod(join(sshDir, "authorized_keys"), 0o600);
    const user = (await run("id", ["-un"])).stdout.trim();
    // A pinned known-hosts file written from the generated host key: the client verifies the host it generated itself,
    // so no trust-on-first-use prompt can make this pass.
    const hostPublic = (await readFile(join(sshDir, "hostkey.pub"), "utf8")).trim();
    const sshPort = 22000 + (process.pid % 2000);
    await writeFile(join(sshDir, "known_hosts"), "[" + "127.0.0.1" + "]:" + sshPort + " " + hostPublic + "\n");
    await writeFile(join(sshDir, "sshd_config"), [
      "Port " + sshPort,
      "ListenAddress 127.0.0.1",
      "HostKey " + join(sshDir, "hostkey"),
      "PidFile " + join(sshDir, "sshd.pid"),
      "AuthorizedKeysFile " + join(sshDir, "authorized_keys"),
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "Subsystem sftp internal-sftp",
      "",
    ].join("\n"));
    const sshdLog = join(sshDir, "log");
    sshd = spawn(sshdBin, ["-D", "-f", join(sshDir, "sshd_config"), "-E", sshdLog], { stdio: "ignore" });
    // Wait for the daemon to listen before the client connects, and fail on an early exit (bad config, port in use)
    // rather than letting doctor race a daemon that never came up.
    const sshdFailed = new Promise((_, rejectExit) => {
      sshd.once("exit", (code, signal) => {
        void readFile(sshdLog, "utf8").catch(() => "no sshd log").then(log => rejectExit(new Error("sshd exited before accepting a connection (code " + code + ", signal " + signal + "): " + log.trim())));
      });
    });
    await Promise.race([waitForTcp("127.0.0.1", sshPort, 15_000), sshdFailed]);
    const remoteRoot = join(workdir, "remote-root");
    await mkdir(remoteRoot, { recursive: true });
    await writeFile(join(remoteRoot, "remote.txt"), "remote-content\n");
    // The worktree surface is a host capability of the gateway in both modes, so the SSH host gets a repository too.
    await gitRepository(remoteRoot);
    const sshEnv = {
      PATH: process.env.PATH,
      HEPI_GATEWAY_TOKEN: token,
      HEPI_WORKSPACE_ROOT: remoteRoot,
      HEPI_SSH_HOST: user + "@127.0.0.1",
      HEPI_SSH_PORT: String(sshPort),
      HEPI_SSH_IDENTITY: join(sshDir, "userkey"),
      HEPI_SSH_KNOWN_HOSTS: join(sshDir, "known_hosts"),
      HEPI_ALLOWED_COMMANDS: "node",
      HEPI_GATEWAY_DATA: stateDir,
    };
    const sshDoctor = await run(bin, ["doctor", "--json"], { cwd: outside, env: sshEnv }).then(result => JSON.parse(result.stdout), error => fail("doctor did not reach the sshd host: " + error.message));
    if (sshDoctor.mode !== "ssh" || sshDoctor.ok !== true) fail("doctor did not report a reachable SSH host: " + JSON.stringify(sshDoctor));
    const remote = await startCli(bin, ["gateway", "--port", "0"], sshEnv, outside);
    try {
      if (remote.event.workspaceId !== "remote-loopback") fail("an SSH gateway did not address the workspace as remote-<profile>: " + remote.event.workspaceId);
      const host = await post(remote.event.origin, "/v1/files", token, { workspaceId: "remote-loopback", method: "executionHost" });
      if (host.body?.ok !== true || host.body.value.user !== user) fail("the remote host did not report its own account: " + JSON.stringify(host));
      const read = await post(remote.event.origin, "/v1/files", token, { workspaceId: "remote-loopback", method: "readTextFile", path: "remote.txt" });
      if (read.body?.ok !== true || read.body.value !== "remote-content\n") fail("remote read failed: " + JSON.stringify(read));
      const executed = await execute(remote.event.origin, token, { gatewayId: remote.event.gatewayId, workspaceId: "remote-loopback", callId: "smoke-call-ssh", command: [process.execPath, "-e", "process.stdout.write('smoke-remote')"] });
      if (executed.result?.ok !== true || executed.result.stdout !== "smoke-remote") fail("remote command failed: " + JSON.stringify(executed));
      const remoteCreated = await post(remote.event.origin, "/v1/worktrees", token, { operation: "create", workspaceId: "remote-loopback", branch: "smoke-remote-worktree" });
      const remoteWorktreePath = remoteCreated.body?.value?.path;
      if (remoteCreated.body?.ok !== true || typeof remoteWorktreePath !== "string" || !existsSync(remoteWorktreePath)) fail("creating a worktree on the SSH host did not make a checkout: " + JSON.stringify(remoteCreated));
      const remoteRemoved = await post(remote.event.origin, "/v1/worktrees", token, { operation: "remove", workspaceId: "remote-loopback", path: remoteWorktreePath });
      if (remoteRemoved.body?.ok !== true || existsSync(remoteWorktreePath)) fail("removing the worktree on the SSH host did not remove the checkout: " + JSON.stringify(remoteRemoved));
      record("ssh gateway", "real localhost sshd on port " + sshPort + ": account, read, command and worktree create/remove through remote-loopback");
    } finally { await remote.stop(); }
  }

  process.stdout.write("smoke:pack ok — " + checks.length + " checks\n");
  for (const check of checks) process.stdout.write("  " + check + "\n");
} finally {
  if (sshd !== undefined) sshd.kill("SIGKILL");
  await rm(workdir, { recursive: true, force: true });
}
