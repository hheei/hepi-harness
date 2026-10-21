/**
 * Split-distribution smoke: a real localhost sshd, the real SSH gateway, a separate backend process and the real
 * DeepSeek model. Not a CI test — it needs an operator credential and a working \`ssh\`/\`sshd\` — so it runs only from
 * this script with the operator env file present (HEPI_SMOKE_ENV_FILE, default /tmp/hepi-backend.env).
 *
 * Topology, all on 127.0.0.1 with ephemeral ports:
 *   this script (client)  ->  backend process (apps/server/src/main.ts, Pi config, real model)
 *                         ->  gateway process (packaged @hepi/client CLI when built, else packages/gateway main.ts)
 *                         ->  real ssh -> temporary sshd -> temporary workspace under $TMPDIR
 *
 * The remote account is the real login on this machine, so the remote home is the developer's own home. Nothing in
 * that home is modified: this smoke only reads it (and asserts before/after that its resource directories are
 * byte-identical), and every write goes into a unique temporary workspace fixture.
 *
 * Assertions, in order:
 *   1. sshd is a real pinned OpenSSH daemon: a control probe with the pinned known-hosts succeeds and the same probe
 *      with an empty known-hosts file is refused, so host verification is not disabled.
 *   2. the host reports the real account and home, and the adopted catalog contains skills discovered in the real
 *      account home — the backend resolved the remote home itself rather than a gateway-local path.
 *   3. an ordinary read returns the exact bytes of a file at its absolute remote path, and of a real account-home skill.
 *   4. a script in the remote workspace runs through the gateway bash tool.
 *   5. a skill body is read from the host at expansion time, while a prompt template keeps the text committed at
 *      adoption until an explicit Reload commits the edit.
 *   6. a published bundle installs into the remote workspace scope, including a zero-byte file; a locally modified
 *      installation refuses an unconfirmed update and keeps a backup when the replacement is confirmed.
 *   7. with sshd stopped, the conversation that already adopted its catalog keeps it, a Reload fails explicitly, a
 *      fresh conversation fails without any harness-local fallback, and nothing in the transcript names a local path.
 *
 * The gateway role runs the packaged CLI when it has been built (the distribution artifact); `--gateway-src` forces the
 * repository entrypoint instead, so both compositions can be exercised.
 *
 * Usage: node apps/server/scripts/split-resources-smoke.ts [--keep] [--gateway-src]
 *        HEPI_SMOKE_ENV_FILE=<file> HEPI_SMOKE_DEADLINE_MS=<ms>
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const run = promisify(execFile);
const argv = new Set(process.argv.slice(2));
const keep = argv.has("--keep");
const deadlineMs = Number(process.env.HEPI_SMOKE_DEADLINE_MS ?? 900000);

const failures: string[] = [];
const notes: string[] = [];
function check(condition: unknown, message: string): void {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message: string): void { notes.push(message); console.log("  ..  " + message); }

/** Everything this script logs passes a sanitizer: the operator credential and the fixture tokens are secrets. */
const redactions: string[] = [];
function sanitize(value: string): string {
  let safe = value;
  for (const secret of redactions) if (secret !== "") safe = safe.split(secret).join("[redacted]");
  return safe;
}
function sanitizeError(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

type Provider = { provider: string; modelId: string; baseUrl: string; apiKey: string };
async function readProviderEnv(): Promise<Provider> {
  const file = process.env.HEPI_SMOKE_ENV_FILE ?? "/tmp/hepi-backend.env";
  const values: Record<string, string> = {};
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  const provider = { provider: values.HEPI_PROVIDER ?? "", modelId: values.HEPI_MODEL ?? "", baseUrl: values.HEPI_PROVIDER_BASE_URL ?? "", apiKey: values.HEPI_PROVIDER_API_KEY ?? "" };
  if (!provider.provider || !provider.modelId || !provider.baseUrl || !provider.apiKey) throw new Error("the provider quartet is not set in the smoke env file");
  redactions.push(provider.apiKey, provider.baseUrl);
  return provider;
}

/** A child environment built from an allowlist, so no ambient HEPI_ / PI_ value can leak into a spawned role. */
function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir() };
  return { ...base, ...extra };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Capture a child's output for the failure path only; it is printed through the sanitizer. */
function capture(child: ChildProcess): { log: () => string } {
  const chunks: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return { log: () => sanitize(chunks.join("")).slice(-600) };
}

const hereUser = userInfo().username;
const hereHome = homedir();

/** The real account-home skill roots, read only, with the names and files the loader should discover there. */
async function realHomeSkills(): Promise<{ roots: string[]; names: string[]; sample?: { path: string; content: string } }> {
  const roots = [join(hereHome, ".agents", "skills"), join(hereHome, ".pi", "agent", "skills")];
  const names: string[] = [];
  let sample: { path: string; content: string } | undefined;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(root, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const content = await readFile(file, "utf8").catch(() => undefined);
      if (content === undefined) continue;
      // A symlink whose target is outside the root is skipped by the loader, so it is not an expected name here either.
      const target = await realpath(file);
      if (!target.startsWith(root + "/")) continue;
      const declared = /^name:\s*(.+)$/m.exec(content.split(/^---\s*$/m)[1] ?? "")?.[1].trim();
      names.push(declared && declared !== "" ? declared : entry.name);
      sample ??= { path: target, content };
    }
  }
  return { roots, names, ...(sample === undefined ? {} : { sample }) };
}

/** A content digest of a directory tree: what "the developer home was not modified" is checked against. */
async function treeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { hash.update("link " + path + " " + (await readlink(path).catch(() => "?"))); continue; }
      if (entry.isDirectory()) { hash.update("dir " + path); await walk(path); continue; }
      hash.update("file " + path + " " + createHash("sha256").update(await readFile(path).catch(() => Buffer.alloc(0))).digest("hex"));
    }
  };
  await walk(root);
  return hash.digest("hex");
}

// ---------------------------------------------------------------- sshd

type Sshd = { port: number; identity: string; knownHosts: string; emptyKnownHosts: string; stop(): Promise<void> };
async function startSshd(base: string): Promise<Sshd> {
  const sshDir = join(base, "ssh");
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  const identity = join(sshDir, "client");
  const hostKey = join(sshDir, "host");
  const knownHosts = join(sshDir, "known_hosts");
  const emptyKnownHosts = join(sshDir, "known_hosts.empty");
  const authorized = join(sshDir, "authorized_keys");
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", identity]);
  await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
  await writeFile(authorized, await readFile(identity + ".pub"), { mode: 0o600 });
  await writeFile(emptyKnownHosts, "");
  // A throwaway daemon for this user only: one ephemeral port, its own host key, an absolute AuthorizedKeysFile, no
  // password or keyboard-interactive auth, and a pid file inside the fixture. StrictModes is off because the fixture
  // keys live under a temporary directory; nothing outside the fixture is reachable through it.
  await writeFile(join(sshDir, "sshd_config"), [
    "Port " + port,
    "ListenAddress 127.0.0.1",
    'HostKey "' + hostKey + '"',
    'AuthorizedKeysFile "' + authorized + '"',
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "UsePAM no",
    "StrictModes no",
    "PermitRootLogin no",
    "AllowUsers " + hereUser,
    "AllowTcpForwarding no",
    "PermitTunnel no",
    'PidFile "' + join(sshDir, "sshd.pid") + '"',
    "",
  ].join("\n"), { mode: 0o600 });
  const daemon = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", join(sshDir, "sshd_config")], { stdio: ["ignore", "ignore", "pipe"] });
  const log = capture(daemon);
  await new Promise<void>((resolveListen, reject) => {
    const timer = setTimeout(() => reject(new Error("sshd did not report readiness: " + log.log())), 15000);
    daemon.stderr?.on("data", (chunk: Buffer) => { if (chunk.toString().includes("Server listening")) { clearTimeout(timer); resolveListen(); } });
    daemon.once("exit", (code) => { clearTimeout(timer); reject(new Error("sshd exited " + code + ": " + log.log())); });
  });
  // The host key is pinned by scanning exactly this daemon's port and writing it to a fixture known-hosts file.
  await writeFile(knownHosts, (await run("ssh-keyscan", ["-p", String(port), "127.0.0.1"])).stdout);
  return {
    port, identity, knownHosts, emptyKnownHosts,
    stop: async () => {
      if (daemon.exitCode !== null) return;
      const exited = new Promise<void>((resolveExit) => daemon.once("exit", () => resolveExit()));
      daemon.kill("SIGTERM");
      await exited;
    },
  };
}

function sshArgs(sshd: Sshd, knownHosts: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", String(sshd.port), "-i", sshd.identity, "-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile=" + knownHosts, "-o", "StrictHostKeyChecking=yes", "--", hereUser + "@127.0.0.1"];
}

// ---------------------------------------------------------------- backend / gateway processes

type Backend = { origin: string; token: string; close(): Promise<void> };
type GatewayProcess = { origin: string; token: string; mode: string; close(): Promise<void> };

async function startGateway(base: string, token: string, sshd: Sshd, workspaceRoot: string, profile: string): Promise<GatewayProcess> {
  const port = await freePort();
  const gatewayHome = join(base, "gateway-home");
  const dataDir = join(base, "gateway-data");
  await mkdir(gatewayHome, { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const tokenFile = join(base, "gateway.token");
  await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  // The packaged CLI is the distribution artifact; when it has not been built, the gateway's own entrypoint runs with
  // the same configuration so the SSH path is still exercised. Which one ran is recorded.
  const distCli = join(repoRoot, "packages", "client", "dist", "cli.js");
  const packaged = argv.has("--gateway-src") ? false : existsSync(distCli);
  const env = childEnv(gatewayHome, {
    HEPI_GATEWAY_TOKEN: token,
    HEPI_WORKSPACE_ROOT: workspaceRoot,
    HEPI_WORKSPACE_ID: "remote-" + profile,
    HEPI_GATEWAY_ID: "workstation",
    HEPI_ALLOWED_COMMANDS: "bash,sh",
    HEPI_GATEWAY_PORT: String(port),
    HEPI_GATEWAY_DATA: dataDir,
    HEPI_SSH_HOST: hereUser + "@127.0.0.1",
    HEPI_SSH_PROFILE: profile,
    HEPI_SSH_PORT: String(sshd.port),
    HEPI_SSH_IDENTITY: sshd.identity,
    HEPI_SSH_KNOWN_HOSTS: sshd.knownHosts,
  });
  const args = packaged
    ? [distCli, "gateway", "--host", hereUser + "@127.0.0.1", "--profile", profile, "--ssh-port", String(sshd.port), "--identity", sshd.identity, "--known-hosts", sshd.knownHosts, "--root", workspaceRoot, "--port", String(port), "--token-file", tokenFile, "--allowed-commands", "bash,sh", "--data-dir", dataDir]
    : [join(repoRoot, "packages", "gateway", "src", "main.ts")];
  const child = spawn(process.execPath, args, { cwd: packaged ? base : repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = capture(child);
  const origin = "http://127.0.0.1:" + port;
  const up = await waitForHttp(origin + "/v1/files", {}, 30000);
  if (!up) throw new Error("the gateway did not start: " + log.log());
  return { origin, token, mode: packaged ? "packaged-cli" : "gateway-src", close: async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((r) => child.once("exit", () => r())); } } };
}

async function startBackend(base: string, token: string, gateway: GatewayProcess, provider: Provider, agentDir: string): Promise<Backend> {
  const port = await freePort();
  const backendHome = join(base, "backend-home");
  await mkdir(backendHome, { recursive: true, mode: 0o700 });
  const env = childEnv(backendHome, {
    PORT: String(port),
    HEPI_BIND_HOST: "127.0.0.1",
    HEPI_AUTH_TOKEN: token,
    HEPI_DB: join(base, "conversations.sqlite"),
    HEPI_SKILL_REPOSITORY: join(base, "skill-repository.sqlite"),
    HEPI_WORKSPACE_ID: "remote-loopback",
    HEPI_GATEWAY_ID: "workstation",
    HEPI_GATEWAY_URL: gateway.origin,
    HEPI_GATEWAY_TOKEN: gateway.token,
    HEPI_CONFIG_SOURCE: "pi",
    PI_CODING_AGENT_DIR: agentDir,
    HEPI_PROVIDER: provider.provider,
    HEPI_MODEL: provider.modelId,
  });
  const child = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = capture(child);
  const origin = "http://127.0.0.1:" + port;
  const headers = { authorization: "Bearer " + token };
  const up = await waitForHttp(origin + "/api/workspaces", headers, 45000);
  if (!up) throw new Error("the backend did not start: " + log.log());
  return { origin, token, close: async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>((r) => child.once("exit", () => r())); } } };
}

/** The temporary Pi agent directory the backend reads in pi mode; the credential stays in memory and in a 0600 file. */
async function writePiAgentDir(base: string, provider: Provider): Promise<string> {
  const agentDir = join(base, "pi-agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider.provider]: {
        api: "openai-completions",
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        models: [{ id: provider.modelId, name: "Split smoke " + provider.modelId, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
      },
    },
  }, null, 2), { mode: 0o600 });
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider.provider, defaultModel: provider.modelId, enableSkillCommands: true, defaultProjectTrust: "always" }, null, 2), { mode: 0o600 });
  return agentDir;
}

/** The temporary remote workspace. Everything written here is unique to this run and removed at the end. */
async function writeWorkspace(base: string): Promise<{ root: string; notes: string }> {
  const root = join(base, "workspace");
  await mkdir(join(root, ".agents", "skills", "deploy", "scripts"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  const notes = "split-notes-exact-bytes\n";
  await writeFile(join(root, "notes.txt"), notes);
  await writeFile(join(root, "AGENTS.md"), "REMOTE SPLIT PROJECT CONTEXT\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nSplit deploy steps v1.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "scripts", "run.sh"), "printf 'split-script-ok\\n'\n");
  await writeFile(join(root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it v1.\nArgs: $@\n");
  return { root, notes };
}

// ---------------------------------------------------------------- backend protocol

type SnapshotEntry = { id: string; role: string; text: string; message: { isError?: boolean; stopReason?: string; errorMessage?: string; toolName?: string } };
type Snapshot = { busy: boolean; revision: number; entries: SnapshotEntry[]; resources?: { status: string; skills?: number; prompts?: number; pending?: boolean } };
type Events = { readonly frames: Snapshot[]; readonly latest: () => Snapshot; readonly waitFor: (predicate: (frame: Snapshot) => boolean, timeoutMs: number, fromIndex: number) => Promise<Snapshot>; readonly close: () => Promise<void> };

function openEvents(origin: string, headers: HeadersInit, id: string): Events {
  const frames: Snapshot[] = [];
  const controller = new AbortController();
  const started = fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: controller.signal }).then((response) => {
    if (!response.ok || response.body === null) throw new Error("event stream refused: " + response.status);
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frameText = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = frameText.split("\n").find((value) => value.startsWith("data: "));
          if (line === undefined) continue;
          const parsed = JSON.parse(line.slice(6)) as Snapshot;
          if (typeof parsed?.revision === "number" && Array.isArray(parsed.entries)) frames.push(parsed);
        }
      }
    })().catch(() => {});
  }).catch((error: unknown) => { failures.push("the event stream failed: " + sanitizeError(error)); });
  return {
    frames,
    latest: () => { const last = frames.at(-1); if (last === undefined) throw new Error("the event stream has not produced a state event"); return last; },
    waitFor: async (predicate, timeoutMs, fromIndex) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = frames.slice(fromIndex).find(predicate);
        if (match !== undefined) return match;
        if (Date.now() > deadline) throw new Error("no settled state event arrived within " + Math.round(timeoutMs / 1000) + "s; last revision " + (frames.at(-1)?.revision ?? "none"));
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: async () => { controller.abort(); await started.catch(() => {}); },
  };
}

type Turn = { snapshot: Snapshot; added: SnapshotEntry[]; results: SnapshotEntry[]; user?: SnapshotEntry };

/**
 * One turn, settled on the durable event stream: idle, a higher revision than the baseline, more entries, and this
 * turn's submitted text as the last user entry. \`expect\` names the tool output this turn must have produced.
 */
async function turn(events: Events, origin: string, headers: HeadersInit, id: string, text: string, needle: string, expect: readonly string[] = []): Promise<Turn> {
  const base = events.latest();
  const fromIndex = events.frames.length;
  const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: crypto.randomUUID(), text }) });
  if (submit.status !== 202) throw new Error("submit failed: " + submit.status + " " + sanitize(await submit.text()));
  const lastUser = (frame: Snapshot) => frame.entries.filter((entry) => entry.role === "user").at(-1);
  const settled = await events.waitFor((frame) => !frame.busy && frame.revision > base.revision && frame.entries.length > base.entries.length && lastUser(frame)?.text.includes(needle) === true, 240000, fromIndex);
  const baseIds = new Set(base.entries.map((entry) => entry.id));
  const added = settled.entries.filter((entry) => !baseIds.has(entry.id));
  const user = added.find((entry) => entry.role === "user" && entry.text.includes(needle));
  check(user !== undefined, "the turn was admitted as a new durable entry (\"" + needle + "\")");
  const assistants = added.filter((entry) => entry.role === "assistant");
  const results = added.filter((entry) => entry.role === "toolResult");
  check(assistants.length >= 1, "the turn produced an assistant entry (" + assistants.length + ")");
  check(assistants.every((entry) => entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted" && entry.message.errorMessage === undefined), "no assistant entry failed or was aborted (" + assistants.map((entry) => entry.message.stopReason).join(",") + ")");
  const last = assistants.at(-1);
  check(last?.message.stopReason === "stop" || last?.message.stopReason === "length", "the final assistant entry completed normally (" + last?.message.stopReason + ")");
  const errored = results.filter((entry) => entry.message.isError === true);
  if (errored.length > 0) note("the model ran " + errored.length + " tool call(s) this turn that failed (" + errored.map((entry) => entry.message.toolName ?? "tool").join(",") + "); no result this smoke relies on failed");
  for (const wanted of expect) {
    const matched = results.filter((entry) => entry.text.includes(wanted));
    check(matched.length >= 1, "this turn's new tool results include " + JSON.stringify(wanted));
    check(matched.every((entry) => entry.message.isError !== true), "the tool result carrying " + JSON.stringify(wanted) + " is not an error");
  }
  return { snapshot: settled, added, results, ...(user === undefined ? {} : { user }) };
}

async function state(origin: string, headers: HeadersInit, id: string): Promise<Snapshot> {
  return await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json() as Snapshot;
}
async function commands(origin: string, headers: HeadersInit, id: string): Promise<string[]> {
  const body = await (await fetch(origin + "/api/conversations/" + id + "/commands", { headers })).json() as { commands: { name: string }[] };
  return body.commands.map((command) => command.name).sort();
}
async function createConversation(origin: string, headers: HeadersInit): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "remote-loopback" }) });
  const body = await response.text();
  if (response.status !== 201) throw new Error("conversation creation failed: " + response.status + " " + sanitize(body));
  return (JSON.parse(body) as { conversationId: string }).conversationId;
}
async function reload(origin: string, headers: HeadersInit, id: string): Promise<{ status: number; body: { error?: unknown; resources?: unknown } }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/reload", { method: "POST", headers });
  return { status: response.status, body: await response.json() as { error?: unknown } };
}
/** One file-RPC read through the real SSH gateway: the claim about the remote host, not about this process. */
async function gatewayRead(gateway: GatewayProcess, path: string): Promise<string | undefined> {
  const response = await fetch(gateway.origin + "/v1/files", { method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" }, body: JSON.stringify({ workspaceId: "remote-loopback", method: "readTextFile", path }) });
  const body = await response.json() as { ok: boolean; value?: string; error?: { message: string } };
  if (!body.ok) { note("gateway read of " + path + " failed: " + sanitize(body.error?.message ?? "unknown")); return undefined; }
  return body.value ?? "";
}

// ---------------------------------------------------------------- run

const base = await mkdtemp(join(tmpdir(), "hepi-split-smoke-"));
// Every role this run starts is registered here as soon as it exists, so a throw before the normal close still stops
// the daemon and both processes instead of leaving them behind.
const started: (() => Promise<void>)[] = [];
let sshdForCleanup: Sshd | undefined;
let exitCode = 0;
try {
  console.log("== fixture " + base);
  const provider = await readProviderEnv();
  console.log("   provider " + provider.provider + " / model " + provider.modelId);
  const authToken = "split-smoke-server-" + Math.random().toString(36).slice(2);
  const gatewayToken = "split-smoke-gateway-" + Math.random().toString(36).slice(2);
  redactions.push(authToken, gatewayToken);
  const headers = { authorization: "Bearer " + authToken, "content-type": "application/json" };

  const home = await realHomeSkills();
  const homeBefore = await Promise.all(home.roots.filter((root) => existsSync(root)).map(async (root) => [root, await treeDigest(root)] as const));
  const host = await writeWorkspace(base);

  // 1. The daemon and its pinning.
  console.log("== step 1: sshd, pinned host keys, and the real remote account");
  const sshd = await startSshd(base);
  sshdForCleanup = sshd;
  started.push(() => sshd.stop());
  const daemon = childEnv(join(base, "probe-home"), {});
  await mkdir(daemon.HOME, { recursive: true, mode: 0o700 });
  const probe = await run("ssh", [...sshArgs(sshd, sshd.knownHosts), "cd -- " + JSON.stringify(host.root) + "; id -un; printf '%s\\n' \"$HOME\"; pwd"], { env: daemon }).then((result) => ({ ok: true as const, ...result })).catch((error: { stdout?: string; stderr?: string }) => ({ ok: false as const, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  const probeLines = probe.stdout.trim().split("\n");
  check(probe.ok, "a real sshd accepted the fixture key on 127.0.0.1:" + sshd.port + (probe.ok ? "" : ": " + sanitize(probe.stderr.trim())));
  check(probeLines[0] === hereUser && probeLines[1] === hereHome, "the remote account is the real login and home (" + probeLines[0] + ", " + probeLines[1] + ")");
  check(probeLines[2] === host.root, "the remote command ran in the fixture workspace (" + probeLines[2] + ")");
  const unpinned = await run("ssh", [...sshArgs(sshd, sshd.emptyKnownHosts), "true"], { env: daemon }).then(() => true).catch(() => false);
  check(unpinned === false, "the same host with an empty known-hosts file is refused, so host verification is not disabled");
  const knownHostsText = await readFile(sshd.knownHosts, "utf8");
  check(knownHostsText.includes("[" + "127.0.0.1" + "]:" + sshd.port), "the pinned known-hosts file holds this daemon's host key for its ephemeral port");
  check(!/StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/.test(JSON.stringify(sshArgs(sshd, sshd.knownHosts))), "no connection disables host verification");

  const agentDir = await writePiAgentDir(base, provider);
  const gateway = await startGateway(base, gatewayToken, sshd, host.root, "loopback");
  started.push(() => gateway.close());
  console.log("   gateway " + gateway.origin + " (" + gateway.mode + ")");
  const backend = await startBackend(base, authToken, gateway, provider, agentDir);
  started.push(() => backend.close());
  console.log("   backend " + backend.origin);
  const id = await createConversation(backend.origin, headers);
  console.log("   conversation " + id);
  const events = openEvents(backend.origin, headers, id);
  // The stream's first state event is the baseline every turn settles against, so the run waits for it once.
  await events.waitFor(() => true, 20000, 0);

  // 2. Discovery from the real remote host, the exact read, and the remote script.
  console.log("== step 2: remote discovery, exact read, remote script");
  const first = await turn(events, backend.origin, headers, id,
    "Use the read tool twice. First read the absolute path " + join(host.root, "notes.txt") + " . Then read the absolute path " + home.sample!.path + " . Reply with the first file's exact content on one line.",
    "notes.txt", ["split-notes-exact-bytes"]);
  const notesResult = first.results.find((entry) => entry.text === host.notes);
  check(notesResult !== undefined, "an ordinary read returned the file's exact bytes at its absolute remote path");
  check(notesResult?.message.isError !== true, "that remote read result is not an error");
  const homeResult = first.results.find((entry) => entry.text === home.sample!.content);
  check(homeResult !== undefined, "an ordinary read of a real account-home skill returned its exact bytes (" + home.sample!.path + ")");
  const firstState = await state(backend.origin, headers, id);
  check(firstState.resources?.status === "loaded", "the conversation adopted its catalog from the remote host: " + JSON.stringify(firstState.resources));
  const adopted = await commands(backend.origin, headers, id);
  check(adopted.includes("skill:deploy") && adopted.includes("ship"), "the adopted catalog holds the remote project skill and prompt: " + adopted.join(","));
  check(home.names.length > 0 && home.names.every((name) => adopted.includes("skill:" + name)), "the adopted catalog holds the skills discovered in the real account home: " + home.names.join(","));

  const second = await turn(events, backend.origin, headers, id,
    "Run this with the bash tool: sh .agents/skills/deploy/scripts/run.sh  — then reply with the script's output on one line.",
    "run.sh", ["split-script-ok"]);
  check(second.results.some((entry) => entry.text.includes("split-script-ok")), "the fixture script ran in the remote workspace through the gateway bash tool");

  // 3. Skill body live from the host; prompt template committed until an explicit Reload.
  console.log("== step 3: live skill body versus committed prompt template");
  await writeFile(join(host.root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nSplit deploy steps v2.\n");
  await writeFile(join(host.root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it v2.\nArgs: $@\n");
  const live = await turn(events, backend.origin, headers, id, "/skill:deploy again", "again");
  check(live.user?.text.includes("Split deploy steps v2.") === true, "the skill body is read from the host at expansion time");
  check(live.user?.text.includes("Split deploy steps v1.") === false, "the replaced remote skill body is no longer used");
  check(live.user?.text.includes("pi-resource://") === false, "no legacy resource URI appears in the skill expansion");
  const beforeReloadCommands = await commands(backend.origin, headers, id);
  check(beforeReloadCommands.join(",") === adopted.join(","), "editing the host files changed no catalog membership before any Reload: " + beforeReloadCommands.join(","));
  const committed = await turn(events, backend.origin, headers, id, "/ship before reload", "before reload");
  check(committed.user?.text.includes("Ship it v1.") === true, "before the Reload the prompt template still expands to its committed text");
  check(committed.user?.text.includes("Ship it v2.") === false, "the edited prompt template is not used before the Reload");
  check(committed.user?.text.includes("Args: before reload") === true, "the prompt template substituted $@ with the command's arguments");
  const reloaded = await reload(backend.origin, headers, id);
  check(reloaded.status === 200, "the explicit Reload succeeded: " + sanitize(JSON.stringify(reloaded.body.resources ?? reloaded.body.error)));
  const afterReload = await turn(events, backend.origin, headers, id, "/ship after reload", "after reload");
  check(afterReload.user?.text.includes("Ship it v2.") === true, "after the Reload the prompt template expands to the edited text");
  check(afterReload.user?.text.includes("Ship it v1.") === false, "the committed v1 text is no longer used once the Reload committed v2");

  // 4. Installation into the remote workspace scope, with a zero-byte file and a confirmed replacement.
  console.log("== step 4: remote install, zero-byte file, confirmed update and backup");
  const published = await fetch(backend.origin + "/api/skill-market/bundles", { method: "POST", headers, body: JSON.stringify({
    name: "split-bundle", version: "1.0.0", description: "Split smoke bundle",
    markdown: "---\nname: split-bundle\ndescription: Split smoke bundle\n---\nSplit bundle body.\n",
    files: [{ path: "notes.md", content: "split bundle note\n", encoding: "utf8" }, { path: "empty.txt", content: "", encoding: "utf8" }],
  }) });
  check(published.status === 201, "the repository published a bundle version: " + published.status + " " + sanitize((await published.text()).slice(0, 200)));
  const installed = await fetch(backend.origin + "/api/skill-market/install", { method: "POST", headers, body: JSON.stringify({ id: "repository:split-bundle@1.0.0", conversationId: id, scope: "workspace" }) });
  const installedBody = await installed.json() as { installed?: { path: string; files: string[]; backup?: string }; error?: unknown };
  check(installed.status === 200 && installedBody.installed !== undefined, "the bundle installed into the workspace scope on the remote host: " + sanitize(JSON.stringify(installedBody.error ?? installedBody.installed)));
  const installedDir = join(host.root, ".agents", "skills", "split-bundle");
  check(installedBody.installed?.path === installedDir, "the host reported the installed directory at its remote path (" + installedBody.installed?.path + ")");
  check(await gatewayRead(gateway, join(installedDir, "SKILL.md")) === "---\nname: split-bundle\ndescription: Split smoke bundle\n---\nSplit bundle body.\n", "a gateway read of the installed SKILL.md returns the published bytes");
  check(await gatewayRead(gateway, join(installedDir, "notes.md")) === "split bundle note\n", "a gateway read of the installed extra file returns the published bytes");
  const emptyText = await gatewayRead(gateway, join(installedDir, "empty.txt"));
  check(emptyText === "" && (await stat(join(installedDir, "empty.txt"))).size === 0, "the zero-byte published file installed as an empty file");
  check((await readdir(installedDir)).sort().join(",") === "SKILL.md,empty.txt,notes.md", "the installed directory holds exactly the bundle files");
  const afterInstall = await reload(backend.origin, headers, id);
  check(afterInstall.status === 200, "the installing conversation reloaded after the installation: " + sanitize(JSON.stringify((afterInstall.body as { resources?: unknown }).resources ?? afterInstall.body.error)));
  check((await commands(backend.origin, headers, id)).includes("skill:split-bundle"), "the conversation adopted the installed skill");
  await writeFile(join(installedDir, "notes.md"), "locally edited split note\n");
  const statusResponse = await fetch(backend.origin + "/api/skill-market/installed?conversationId=" + id + "&name=split-bundle&scope=workspace", { headers });
  const statusBody = await statusResponse.json() as { skill?: { state: string; files: Record<string, string> } };
  check(statusResponse.status === 200 && statusBody.skill?.state === "locally-modified", "the host reported the installed skill as locally modified (" + statusBody.skill?.state + ")");
  const refused = await fetch(backend.origin + "/api/skill-market/update", { method: "POST", headers, body: JSON.stringify({ id: "repository:split-bundle@1.0.0", name: "split-bundle", conversationId: id, scope: "workspace", confirm: false }) });
  check(refused.status === 409, "an unconfirmed replacement of a locally modified installation is refused: " + refused.status);
  const confirmed = await fetch(backend.origin + "/api/skill-market/update", { method: "POST", headers, body: JSON.stringify({ id: "repository:split-bundle@1.0.0", name: "split-bundle", conversationId: id, scope: "workspace", confirm: true, files: statusBody.skill?.files }) });
  const confirmedBody = await confirmed.json() as { installed?: { backup?: string }; error?: unknown };
  check(confirmed.status === 200 && confirmedBody.installed?.backup !== undefined, "the confirmed update published and reported a retained backup: " + sanitize(JSON.stringify(confirmedBody.error ?? confirmedBody.installed)));
  const backup = confirmedBody.installed?.backup ?? "";
  // The replaced directory is moved aside next to the scope's skills directory, so the backup is a real sibling
  // directory on the remote host and never the installed path itself.
  const backupRoot = dirname(dirname(installedDir));
  check(backup.startsWith(backupRoot + "/") && backup !== installedDir && (await stat(backup)).isDirectory(), "the retained backup directory exists outside the installed directory (" + backup + ")");
  check((await readFile(join(backup, "notes.md"), "utf8")) === "locally edited split note\n", "the backup holds the locally modified bytes");
  check(await gatewayRead(gateway, join(installedDir, "notes.md")) === "split bundle note\n", "the replacement restored the published bytes on the remote host");
  check(await gatewayRead(gateway, join(installedDir, "empty.txt")) === "", "the replacement kept the zero-byte file empty");

  // 5. Host outage: the adopted catalog stays, Reload fails, and nothing falls back to harness-local resources.
  console.log("== step 5: sshd stopped mid-deployment");
  // The catalog in effect just before the outage: the installation above already adopted the new skill.
  const beforeOutage = await commands(backend.origin, headers, id);
  await sshd.stop();
  const retainedState = await state(backend.origin, headers, id);
  check(retainedState.resources?.status === "loaded", "the conversation that already adopted keeps its committed resource state after the host goes away");
  const outageCommands = await commands(backend.origin, headers, id);
  check(outageCommands.join(",") === beforeOutage.join(","), "the command list is still served from committed state with the host gone: " + outageCommands.join(","));
  const outageReload = await reload(backend.origin, headers, id);
  check(outageReload.status === 500, "a Reload with the host gone fails explicitly: " + outageReload.status + " " + sanitize(String(outageReload.body.error ?? "")));
  check((await state(backend.origin, headers, id)).resources?.status === "loaded", "the failed Reload left the adopted resource state intact");
  const fresh = await createConversation(backend.origin, headers);
  const failedLoad = await fetch(backend.origin + "/api/conversations/" + fresh + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: crypto.randomUUID(), text: "hello" }) });
  const failedBody = await failedLoad.text();
  check(failedLoad.status === 500, "a fresh conversation cannot load from the unreachable host: " + failedLoad.status);
  check(/unreachable|unknown|offline|gateway/i.test(failedBody), "the failure names the transport rather than inventing a resource: " + sanitize(failedBody.slice(0, 160)));
  check(!failedBody.includes(host.root) && !failedBody.includes(repoRoot), "the failure carries no local path");

  // Final consistency, then the "the developer home was not modified" proof.
  await events.close();
  const finalState = await state(backend.origin, headers, id);
  check(events.frames.length > 0 && events.latest().revision <= finalState.revision, "the settled stream revision is not ahead of the durable state (" + events.latest().revision + " <= " + finalState.revision + ")");
  const durableIds = new Set(finalState.entries.map((entry) => entry.id));
  check(events.frames.every((frame) => frame.entries.every((entry) => durableIds.has(entry.id))), "every entry the stream reported is present in the durable transcript");
  for (const reliedOn of ["split-notes-exact-bytes", "split-script-ok"]) {
    const durable = finalState.entries.filter((entry) => entry.role === "toolResult" && entry.text.includes(reliedOn));
    check(durable.length >= 1 && durable.every((entry) => entry.message.isError !== true), "the durable transcript holds the successful result for " + JSON.stringify(reliedOn));
  }
  const userTexts = finalState.entries.filter((entry) => entry.role === "user").map((entry) => entry.text).join("\n");
  check(!userTexts.includes(repoRoot) && !userTexts.includes("pi-resource://"), "no submitted entry names a local checkout path or a legacy resource URI");
  check(finalState.entries.filter((entry) => entry.role === "assistant").every((entry) => entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted"), "no assistant entry in the durable transcript failed or was aborted");
  const homeAfter = await Promise.all(home.roots.filter((root) => existsSync(root)).map(async (root) => [root, await treeDigest(root)] as const));
  check(JSON.stringify(homeBefore) === JSON.stringify(homeAfter), "the real account resource directories are byte-identical to before the run (" + homeBefore.map(([root]) => root).join(", ") + ")");
  console.log("== durable transcript (" + finalState.entries.length + " entries, " + events.frames.length + " stream state events)");
  console.log("== model turns: 5, gateway mode: " + gateway.mode + ", sshd port: " + sshd.port);
} catch (error) {
  failures.push("smoke threw: " + sanitizeError(error));
  console.log("  FAIL smoke threw: " + sanitizeError(error));
} finally {
  // Reverse order: the processes stop before the daemon they dial, and the daemon stops before its keys are removed.
  for (const close of [...started].reverse()) await close().catch(() => {});
  // A daemon that would not answer its own SIGTERM is the only case left; the match is this fixture's config path, so
  // no system or operator sshd can be reached by it.
  await run("pkill", ["-f", join(base, "ssh", "sshd_config")]).catch(() => {});
  if (sshdForCleanup === undefined) await run("pkill", ["-f", join(base, "ssh")]).catch(() => {});
  if (!keep) await rm(base, { recursive: true, force: true });
  else console.log("fixture kept at " + base);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
for (const noteText of notes) console.log("   note: " + noteText);
exitCode = failures.length === 0 ? 0 : 1;
process.exit(exitCode);
