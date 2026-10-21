import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_PORT, parseArgs, resolveSettings } from "../src/config.ts";
import { formatDoctor, runDoctor, systemProbe, type DoctorProbe } from "../src/doctor.ts";
import { USAGE, run } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function okProbe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    workspace: async () => ({ ok: true, detail: "/workspace" }),
    journal: async () => ({ ok: true, detail: "/journal" }),
    ssh: async () => ({ ok: true, detail: "account user, home /home/user" }),
    ...overrides,
  };
}

test("parses commands, flags and the two short forms, and names what it cannot parse", () => {
  assert.deepEqual(parseArgs(["gateway"]).command, "gateway");
  assert.deepEqual(parseArgs(["doctor"]).command, "doctor");
  assert.deepEqual(parseArgs(["--help"]).command, "help");
  assert.deepEqual(parseArgs(["-h"]).command, "help");
  assert.deepEqual(parseArgs(["--version"]).command, "version");
  const parsed = parseArgs(["doctor", "--root", "/workspace", "--json", "--port", "9000", "--host", "user@host"]);
  assert.equal(parsed.command, "doctor");
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.flags, { root: "/workspace", json: true, port: "9000", host: "user@host" });
  // A flag without a value, an unknown option and an unknown command are each reported, never guessed at.
  assert.deepEqual(parseArgs(["--root"]).problems, ["missing value for --root"]);
  assert.deepEqual(parseArgs(["--root", "--json"]).problems, ["missing value for --root"]);
  assert.deepEqual(parseArgs(["--nope", "x"]).problems, ["unknown option: --nope", "unknown command: x"]);
  assert.deepEqual(parseArgs(["serve"]).problems, ["unknown command: serve"]);
  assert.deepEqual(parseArgs(["doctor", "gateway"]).problems, ["unexpected argument: gateway"]);
});

test("resolves a local gateway from flags over environment over file", () => {
  const resolved = resolveSettings({
    flags: { root: "/from/flag", port: "9001" },
    env: { HEPI_GATEWAY_TOKEN: "env-token", HEPI_WORKSPACE_ROOT: "/from/env", HEPI_ALLOWED_COMMANDS: "bash, node ", HEPI_GATEWAY_DATA: "/from/env/data" },
    file: { HEPI_GATEWAY_TOKEN: "file-token", HEPI_WORKSPACE_ROOT: "/from/file", HEPI_WORKSPACE_ID: "from-file", HEPI_GATEWAY_ID: "file-gateway" },
    filePath: "/etc/hepi.json",
  });
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(resolved.settings, {
    mode: "local",
    gatewayId: "file-gateway",
    token: "env-token",
    workspaceId: "from-file",
    workspaceRoot: "/from/flag",
    allowedCommands: ["bash", "node"],
    port: 9001,
    databasePath: "/from/env/data/calls.sqlite",
    configFile: "/etc/hepi.json",
  });
  // Without a flag the environment wins; without either the file does; the workspace ID defaults to local.
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/env" }, file: { HEPI_WORKSPACE_ROOT: "/file" } }).settings?.workspaceRoot, "/env");
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t" }, file: { HEPI_WORKSPACE_ROOT: "/file" } }).settings?.workspaceRoot, "/file");
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/env" } }).settings?.workspaceId, "local");
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/env" } }).settings?.port, DEFAULT_PORT);
  // A token read from a file is used as-is and is never taken from anywhere else.
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "env", HEPI_WORKSPACE_ROOT: "/root" }, tokenFileValue: "file-token" }).settings?.token, "file-token");
});

test("resolves an SSH gateway to the remote profile and refuses an unusable configuration", () => {
  const ssh = resolveSettings({
    flags: {},
    env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/remote/root", HEPI_SSH_HOST: "user@host", HEPI_SSH_PORT: "2222", HEPI_SSH_IDENTITY: "/keys/id", HEPI_SSH_KNOWN_HOSTS: "/keys/known" },
  });
  assert.deepEqual(ssh.problems, []);
  assert.equal(ssh.settings?.mode, "ssh");
  assert.equal(ssh.settings?.workspaceId, "remote-loopback");
  assert.deepEqual(ssh.settings?.ssh, { profile: "loopback", host: "user@host", port: 2222, identityFile: "/keys/id", knownHostsFile: "/keys/known" });
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_SSH_HOST: "h", HEPI_SSH_PROFILE: "prod" } }).settings?.workspaceId, "remote-prod");
  // The gateway maps an SSH workspace to remote-<profile> and refuses any other ID, so a custom one would leave the
  // gateway advertising an ID its own RPC rejects. It is a configuration problem, reported instead of rewritten.
  const customId = resolveSettings({ flags: { workspaceId: "my-workspace" }, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_SSH_HOST: "h" } });
  assert.equal(customId.settings, undefined);
  assert.match(customId.problems.join("; "), /HEPI_WORKSPACE_ID\/--workspace-id must be remote-loopback for an SSH gateway \(profile loopback\)/);
  const customFromEnv = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_SSH_HOST: "h", HEPI_SSH_PROFILE: "prod", HEPI_WORKSPACE_ID: "remote-loopback" } });
  assert.match(customFromEnv.problems.join("; "), /must be remote-prod for an SSH gateway/);
  // The ID that matches the profile is accepted, and a local gateway still takes any ID.
  assert.equal(resolveSettings({ flags: { workspaceId: "remote-loopback" }, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_SSH_HOST: "h" } }).settings?.workspaceId, "remote-loopback");
  assert.equal(resolveSettings({ flags: { workspaceId: "my-workspace" }, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root" } }).settings?.workspaceId, "my-workspace");
  // Every unusable value is named, and no settings are returned to start a gateway with.
  const missingToken = resolveSettings({ flags: {}, env: { HEPI_WORKSPACE_ROOT: "/root" } });
  assert.equal(missingToken.settings, undefined);
  assert.match(missingToken.problems.join("; "), /HEPI_GATEWAY_TOKEN is required/);
  const relative = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "relative/root" } });
  assert.match(relative.problems.join("; "), /HEPI_WORKSPACE_ROOT must be an absolute path/);
  const badPort = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_GATEWAY_PORT: "70000" } });
  assert.match(badPort.problems.join("; "), /HEPI_GATEWAY_PORT\/--port must be an integer between 0 and 65535/);
  const badFile = resolveSettings({ flags: {}, env: {}, file: { HEPI_GATEWAY_TOKEN: 5 } });
  assert.match(badFile.problems.join("; "), /HEPI_GATEWAY_TOKEN in the config file must be a string/);
  // The terminal keepalive cadence: unset means the shared default, a stated number is carried through, and an
  // unusable value is refused by the same rule the gateway's own entrypoint applies instead of silently defaulting.
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root" } }).settings?.terminalHeartbeatMs, undefined);
  assert.equal(resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_TERMINAL_HEARTBEAT_MS: "0" } }).settings?.terminalHeartbeatMs, 0);
  assert.equal(resolveSettings({ flags: { terminalHeartbeatMs: "1500" }, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root" } }).settings?.terminalHeartbeatMs, 1500);
  const badHeartbeat = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_TERMINAL_HEARTBEAT_MS: "soon" } });
  assert.equal(badHeartbeat.settings, undefined);
  assert.match(badHeartbeat.problems.join("; "), /HEPI_TERMINAL_HEARTBEAT_MS\/--terminal-heartbeat-ms must be a non-negative number of milliseconds: soon/);
  // An SSH host with nothing allowed is a warning, not a failure: it starts and refuses every call.
  const warned = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/root", HEPI_SSH_HOST: "h" } });
  assert.deepEqual(warned.problems, []);
  assert.match(warned.warnings.join("; "), /no commands are allowed/);
});

test("doctor reports each check and never prints the token", async () => {
  const settings = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "super-secret-token", HEPI_WORKSPACE_ROOT: "/workspace" } }).settings!;
  const good = await runDoctor(settings, okProbe());
  assert.equal(good.ok, true);
  assert.deepEqual(good.checks.map(check => check.name), ["config", "workspace root", "journal directory"]);
  assert.equal(formatDoctor(good, false, [settings.token]).includes("super-secret-token"), false);
  // A failing probe makes the verdict fail and names the check that failed, in text and in JSON.
  const bad = await runDoctor(settings, okProbe({ workspace: async () => ({ ok: false, detail: "ENOENT: no such file or directory" }) }));
  assert.equal(bad.ok, false);
  assert.match(formatDoctor(bad, false, [settings.token]), /fail workspace root: ENOENT/);
  const asJson = JSON.parse(formatDoctor(bad, true, [settings.token])) as { ok: boolean; checks: { name: string; ok: boolean }[] };
  assert.equal(asJson.ok, false);
  assert.equal(asJson.checks.find(check => check.name === "workspace root")?.ok, false);
  // An SSH gateway checks the host it would execute on, not the gateway machine's filesystem.
  const sshSettings = resolveSettings({ flags: {}, env: { HEPI_GATEWAY_TOKEN: "t", HEPI_WORKSPACE_ROOT: "/remote", HEPI_SSH_HOST: "user@host" } }).settings!;
  const sshResult = await runDoctor(sshSettings, okProbe({ ssh: async () => ({ ok: false, detail: "unreachable" }) }));
  assert.deepEqual(sshResult.checks.map(check => check.name), ["config", "ssh host", "journal directory"]);
  assert.equal(sshResult.ok, false);
});

test("the CLI prints usage, exits non-zero for a usage error, and reports the packaged version", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const options = { env: {}, out: (text: string) => out.push(text), err: (text: string) => err.push(text), probe: okProbe() };
  assert.equal(await run(["--help"], options), 0);
  assert.match(out.join(""), /hepi-client \d+\.\d+\.\d+/);
  for (const flag of ["--config", "--token-file", "--root", "--workspace-id", "--gateway-id", "--port", "--allowed-commands", "--data-dir", "--host", "--profile", "--ssh-port", "--identity", "--known-hosts", "--terminal-heartbeat-ms", "--json"]) {
    assert.ok(USAGE.includes(flag), "usage documents " + flag);
  }
  out.length = 0;
  assert.equal(await run(["--version"], options), 0);
  assert.equal(out.join("").trim(), VERSION);
  out.length = 0;
  assert.equal(await run([], options), 2);
  assert.match(err.join(""), /Usage:/);
  err.length = 0;
  // A healthy configuration exits 0 and the token never reaches stdout or stderr, even though it is the value that
  // made the run possible.
  assert.equal(await run(["doctor", "--root", "/workspace"], { ...options, env: { HEPI_GATEWAY_TOKEN: "secret-value" } }), 0);
  assert.match(out.join(""), /hepi-client doctor: ok/);
  assert.equal(out.join("").includes("secret-value"), false);
  assert.equal(err.join("").includes("secret-value"), false);
  out.length = 0;
  // A failing check is exit 1, not a usage error: the configuration was usable and the host was not.
  assert.equal(await run(["doctor", "--root", "/workspace"], { ...options, probe: okProbe({ journal: async () => ({ ok: false, detail: "EACCES" }) }), env: { HEPI_GATEWAY_TOKEN: "t" } }), 1);
  assert.match(out.join(""), /fail journal directory: EACCES/);
  out.length = 0;
  err.length = 0;
  assert.equal(await run(["doctor"], options), 2);
  assert.match(err.join(""), /HEPI_GATEWAY_TOKEN is required/);
  err.length = 0;
  // A config file that cannot be read is reported instead of being ignored.
  assert.equal(await run(["doctor", "--config", "/nonexistent/hepi.json"], options), 2);
  assert.match(err.join(""), /cannot read config file/);
});

test("a malformed config file is reported without echoing its content", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-client-config-"));
  try {
    const out: string[] = [];
    const err: string[] = [];
    const options = { env: {}, out: (text: string) => out.push(text), err: (text: string) => err.push(text), probe: okProbe() };
    // The token sits in the file, so any parse error that quotes the source would put it on stderr.
    const marker = "hepi-config-secret-marker";
    const config = join(base, "hepi.json");
    await writeFile(config, "{\n  \"HEPI_GATEWAY_TOKEN\": \"" + marker + "\",\n  \"HEPI_WORKSPACE_ROOT\": \"/workspace\",\n}\n");
    assert.equal(await run(["doctor", "--config", config], options), 2);
    assert.match(err.join(""), /invalid JSON in config file /);
    assert.equal(out.join("").includes(marker), false);
    assert.equal(err.join("").includes(marker), false);
    // A file that parses but is not an object is named as such, and an unreadable one still names the path.
    await writeFile(config, "[1, 2]\n");
    err.length = 0;
    assert.equal(await run(["doctor", "--config", config], options), 2);
    assert.match(err.join(""), /config file must hold a JSON object/);
    err.length = 0;
    assert.equal(await run(["doctor", "--config", join(base, "missing.json")], options), 2);
    assert.match(err.join(""), /cannot read config file /);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("doctor rejects a journal directory that cannot be written", async () => {
  // The journal is opened for writing when the gateway starts, so a directory that exists but is read-only is a
  // failure doctor should report rather than pass. A root user can write anywhere, so the check is only meaningful
  // for an ordinary user.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const base = await mkdtemp(join(tmpdir(), "hepi-client-journal-"));
  const directory = join(base, "state");
  try {
    await mkdir(directory);
    const writable = await systemProbe.journal(directory);
    assert.equal(writable.ok, true);
    await chmod(directory, 0o500);
    const readOnly = await systemProbe.journal(directory);
    assert.equal(readOnly.ok, false);
    assert.match(readOnly.detail, /EACCES|permission denied/i);
  } finally {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
  }
});

test("the packaged version matches package.json", async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as { version: string; license: string; private: boolean; dependencies: Record<string, string> };
  assert.equal(VERSION, manifest.version);
  assert.equal(manifest.license, "UNLICENSED");
  assert.equal(manifest.private, false);
  for (const [name, range] of Object.entries(manifest.dependencies)) {
    assert.equal(/^(workspace:|file:|link:)/.test(range), false, name + " must not be a checkout-local dependency");
  }
});

test("doctor on a real directory checks the workspace and the journal without a host", async () => {
  const base = await mkdtemp(join(tmpdir(), "hepi-client-doctor-"));
  try {
    await writeFile(join(base, "AGENTS.md"), "context\n");
    const settings = resolveSettings({ flags: { root: base, dataDir: join(base, "state") }, env: { HEPI_GATEWAY_TOKEN: "t" } }).settings!;
    const result = await runDoctor(settings, {
      workspace: async root => ({ ok: true, detail: root }),
      journal: async directory => ({ ok: true, detail: directory }),
      ssh: async () => ({ ok: false, detail: "unused" }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "local");
  } finally { await rm(base, { recursive: true, force: true }); }
});
