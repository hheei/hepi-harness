import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseTerminalHeartbeatMs, startGateway, terminalHeartbeatProblem, type GatewayStartupSettings, type RunningGateway } from "../src/startup.ts";
import { createFakeSshHost } from "./fake-ssh.ts";

const git = promisify(execFile);
const TOKEN = "startup-token";

/**
 * The one Gateway composition, driven at its public seam: the HTTP surface the backend and the browser speak.
 *
 * Both entries start a gateway through this Module, so what is asserted here is what either entry serves — one
 * registry behind every capability, a listener that reports its own port, a close that releases it, and a startup
 * that fails without leaving its journal or its SSH master behind. The entrypoints keep only configuration, signals
 * and their own output; the CLI's own tarball is exercised by `smoke:pack`.
 */

/** A real repository with one commit, so the worktree surface has a branch to act on. */
async function gitRepository(base: string): Promise<string> {
  const root = join(base, "repo");
  await mkdir(root, { recursive: true });
  await git("git", ["init", "-q", root]);
  await git("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await git("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), "baseline\n");
  await git("git", ["-C", root, "add", "README.md"]);
  await git("git", ["-C", root, "commit", "-qm", "baseline"]);
  return await realpath(root);
}

async function fixture(): Promise<{ base: string; root: string; settings: GatewayStartupSettings }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-startup-")));
  const root = await gitRepository(base);
  return {
    base,
    root,
    settings: { mode: "local", gatewayId: "workstation", token: TOKEN, workspaceId: "local", workspaceRoot: root, allowedCommands: ["node", "bash"], port: 0, databasePath: join(base, "state", "calls.sqlite") },
  };
}

async function post(origin: string, path: string, body: unknown, token = TOKEN): Promise<{ status: number; body: any }> {
  const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** One execution call: the route answers NDJSON, so the result frame is the last line the host wrote. */
async function execute(origin: string, body: unknown): Promise<any> {
  const response = await fetch(origin + "/v1/execute", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  const frames = (await response.text()).split("\n").filter(line => line.trim() !== "").map(line => JSON.parse(line));
  return frames.at(-1)?.result;
}

test("the shared startup serves every capability over one registry and releases its listener on close", async () => {
  const { base, root, settings } = await fixture();
  const running = await startGateway(settings);
  try {
    // The listener reports the port it actually bound, which is what an entry prints and a caller reaches.
    assert.match(running.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(running.origin.endsWith(":" + running.port), true);

    // Execution, files and worktrees answer for the configured workspace, and workspace management lists the same one:
    // the capabilities share one registry instead of each keeping its own copy of the configured root.
    const executed = await execute(running.origin, { gatewayId: "workstation", workspaceId: "local", callId: "startup-1", command: [process.execPath, "-e", "process.stdout.write('composed')"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(executed.stdout, "composed");
    const read = await post(running.origin, "/v1/files", { workspaceId: "local", method: "readTextFile", path: "README.md" });
    assert.equal(read.body?.ok, true, JSON.stringify(read.body));
    assert.equal(read.body.value, "baseline\n");
    const listed = await post(running.origin, "/v1/workspaces", { operation: "list" });
    assert.deepEqual(listed.body?.value, [{ id: "local", root }]);
    const worktrees = await post(running.origin, "/v1/worktrees", { operation: "list", workspaceId: "local" });
    assert.equal(worktrees.body?.ok, true, JSON.stringify(worktrees.body));
    assert.equal(worktrees.body.value.isGit, true);
    // MCP belongs to this host's own account, so a local gateway serves it; an SSH one does not.
    const mcp = await post(running.origin, "/v1/mcp", { operation: "read" });
    assert.equal(mcp.body?.ok, true, JSON.stringify(mcp.body));
    // The token is the gateway's own credential: without it nothing is served.
    const unauthorized = await post(running.origin, "/v1/files", { workspaceId: "local", method: "readTextFile", path: "README.md" }, "wrong-token");
    assert.equal(unauthorized.status, 401);
  } finally {
    await running.close();
    await rm(base, { recursive: true, force: true });
  }
  // Close released the socket and settled the handle's own promise; repeating it closes nothing twice.
  await running.closed;
  await running.close();
  await assert.rejects(fetch(running.origin + "/v1/workspaces", { method: "POST", headers: { authorization: "Bearer " + TOKEN } }));
});

test("local and SSH settings are mutually exclusive, and a half-stated mode is refused before anything starts", async () => {
  const { base, root, settings } = await fixture();
  try {
    // A local gateway that was handed SSH settings, and an SSH gateway with none, are both refused: the mode is what
    // the resolved settings say, and neither shape is silently reinterpreted as the other.
    await assert.rejects(startGateway({ ...settings, ssh: { profile: "loopback", host: "user@host" } }), /a local gateway must not be given SSH settings/);
    await assert.rejects(startGateway({ ...settings, mode: "ssh" }), /an SSH gateway needs its SSH settings/);
    // A stated cadence that is not a non-negative number is refused, and `0` is a value rather than an absence.
    assert.equal(terminalHeartbeatProblem("soon"), "HEPI_TERMINAL_HEARTBEAT_MS/--terminal-heartbeat-ms must be a non-negative number of milliseconds: soon");
    assert.equal(terminalHeartbeatProblem("-1"), "HEPI_TERMINAL_HEARTBEAT_MS/--terminal-heartbeat-ms must be a non-negative number of milliseconds: -1");
    assert.equal(terminalHeartbeatProblem(""), "HEPI_TERMINAL_HEARTBEAT_MS/--terminal-heartbeat-ms must be a non-negative number of milliseconds: ");
    assert.equal(terminalHeartbeatProblem("0"), undefined);
    assert.equal(parseTerminalHeartbeatMs("2500"), 2500);
    assert.throws(() => parseTerminalHeartbeatMs("soon"), /must be a non-negative number of milliseconds/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a startup that cannot bind releases what it created and leaves the running gateway alone", async () => {
  const { base, root, settings } = await fixture();
  const first = await startGateway(settings);
  try {
    // The same port is already bound by the first gateway, so this startup fails at the listener rather than
    // half-composing a second one over the same journal.
    const blocked: GatewayStartupSettings = { ...settings, port: first.port, databasePath: join(base, "state-2", "calls.sqlite") };
    await assert.rejects(startGateway(blocked), (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE" || /EADDRINUSE|address already in use/i.test(error.message));
    // The first gateway is unaffected, and the failed attempt left nothing that would stop the port being used again.
    const served = await post(first.origin, "/v1/workspaces", { operation: "list" });
    assert.equal(served.body?.ok, true, JSON.stringify(served.body));
    // The failed attempt released its own journal: the same state directory can be opened again at once, which a
    // journal still held open by the attempt would refuse.
    const retried = await startGateway({ ...blocked, port: 0 });
    const reused = await post(retried.origin, "/v1/workspaces", { operation: "list" });
    assert.equal(reused.body?.ok, true, JSON.stringify(reused.body));
    await retried.close();
  } finally {
    await first.close();
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * Read one event stream into the frames it produced, so a wait is for a frame the gateway wrote.
 *
 * Every wait is woken by the stream itself: a frame that arrived, or an end. There is no polling loop and no sleep —
 * the deadline only turns a stream that stays silent into a failure instead of a hang, and it is cleared as soon as
 * the frame it was waiting for arrives.
 */
type FrameReader = {
  /** Every frame received so far, in order. A comment frame is exactly `":"`. */
  frames(): string[];
  /** Resolves with the frames once the predicate holds over them, or fails at the deadline. */
  until(predicate: (frames: string[]) => boolean, description: string, deadlineMs: number): Promise<string[]>;
  /** Resolves once the stream is over, however it ended. */
  readonly ended: Promise<void>;
  cancel(): Promise<void>;
};

function frameReader(response: Response): FrameReader {
  const frames: string[] = [];
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of [...waiters]) waiter(); };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let over = false;
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => { resolveEnded = resolve; });
  const finish = () => { if (over) return; over = true; wake(); resolveEnded(); };
  void (async () => {
    while (true) {
      const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) { finish(); return; }
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) { frames.push(pending.slice(0, boundary)); pending = pending.slice(boundary + 2); }
      wake();
    }
  })();
  return {
    frames: () => [...frames],
    async until(predicate, description, deadlineMs) {
      // The wait ends on the next frame, the stream's end, or the deadline — never on a poll: a quiet stream produces no
      // wake-up of its own, and the deadline is what turns that silence into a failure rather than a hang.
      while (!predicate(frames)) {
        if (over) assert.fail("the stream ended before " + description + "; frames: " + JSON.stringify(frames));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const signalled = await new Promise<"frame" | "deadline">((resolve) => {
          waiters.add(() => resolve("frame"));
          timer = setTimeout(() => resolve("deadline"), deadlineMs);
        });
        waiters.clear();
        clearTimeout(timer);
        if (signalled === "deadline") assert.fail("timed out waiting for " + description + "; frames: " + JSON.stringify(frames));
      }
      return [...frames];
    },
    ended,
    async cancel() { await reader.cancel().catch(() => {}); },
  };
}

async function openSession(running: RunningGateway, workspaceId: string): Promise<string> {
  const opened = await post(running.origin, "/v1/terminal", { gatewayId: "workstation", workspaceId, cols: 80, rows: 24 });
  assert.equal(opened.body?.ok, true, JSON.stringify(opened.body));
  return opened.body.id as string;
}

test("the terminal keepalive cadence the resolved settings state is what both terminal streams write", async () => {
  const { base, settings } = await fixture();
  // The cadence travels in the settings, so an entry that states one states it for every terminal stream: here it is
  // shortened so the wait is for a frame the gateway wrote rather than a sleep.
  const running = await startGateway({ ...settings, terminalHeartbeatMs: 40 });
  try {
    const id = await openSession(running, "local");
    const response = await fetch(running.origin + "/v1/terminal/" + encodeURIComponent(id) + "/events", { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(response.status, 200);
    const events = frameReader(response);
    try {
      // The replay is still the first frame, with its own cursor, and the comment frame carries none.
      const frames = await events.until((current) => current.filter(frame => frame === ":").length >= 2, "two comment frames on a quiet session stream", 5_000);
      assert.match(frames[0]!, /^id: [0-9]+\ndata: /);
      for (const frame of frames) if (frame !== ":") assert.match(frame, /^(id: [0-9]+\n)?data: /);
    } finally { await events.cancel(); }
    // The page's one stream carries the same cadence, and only while it holds a session.
    const fanIn = await fetch(running.origin + "/v1/terminal/events?tabs=" + encodeURIComponent(id) + ":", { headers: { authorization: "Bearer " + TOKEN } });
    assert.equal(fanIn.status, 200);
    const page = frameReader(fanIn);
    try {
      await page.until((current) => current.includes(":"), "a comment frame on the page's terminal stream", 5_000);
    } finally { await page.cancel(); }
  } finally {
    await running.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("a stated cadence of zero writes no keepalive, and the stream stays open", async (t) => {
  const { base, settings } = await fixture();
  // The gateway is composed in this process, so the cadence it arms is this process's own interval. Mocking intervals
  // only — every other timer stays real — makes the silence a fact instead of a wait: a cadence of zero arms nothing,
  // and a mocked clock turned far past any cadence cannot write the comment frame a positive one would have.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const running = await startGateway({ ...settings, terminalHeartbeatMs: 0 });
  try {
    const id = await openSession(running, "local");
    const response = await fetch(running.origin + "/v1/terminal/" + encodeURIComponent(id) + "/events", { headers: { authorization: "Bearer " + TOKEN } });
    const events = frameReader(response);
    try {
      await events.until((current) => current.length >= 1, "the replay", 5_000);
      t.mock.timers.tick(600_000);
      // The stream is still attached, and its own ordering is the barrier: this output is written after anything the
      // mocked clock would have written, so a comment frame would already be in front of it.
      const input = await fetch(running.origin + "/v1/terminal/" + encodeURIComponent(id) + "/input", { method: "POST", headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: JSON.stringify({ data: "printf 'still-open\\n'\n" }) });
      assert.equal(input.status, 200);
      const frames = await events.until((current) => current.some(frame => frame.includes("still-open")), "output after the mocked clock", 5_000);
      assert.deepEqual(frames.filter(frame => frame === ":"), []);
      const described = await fetch(running.origin + "/v1/terminal/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + TOKEN } });
      assert.equal((await described.json() as { ok: boolean }).ok, true);
    } finally { await events.cancel(); }
  } finally {
    await running.close();
    t.mock.timers.reset();
    await rm(base, { recursive: true, force: true });
  }
});

test("the SSH composition serves the profile's remote host, refuses a foreign workspace id, and leaves no state of its own", async () => {
  // The composition is the one both entries start; the host is the in-process fake of ./fake-ssh.ts, handed in as the
  // gateway's transport. So what is asserted below is the composition's own behaviour — the registry it seeds, the
  // capabilities it serves and the state it does or does not create — against a host that answers the same program
  // contracts a real one does, with no daemon, port, key or login involved.
  const host = createFakeSshHost({ root: "/srv/app", user: "remote-operator", home: "/home/remote-operator" });
  host.writeFile("/srv/app/remote.txt", "remote-content\n");
  host.mkdir("/srv/app/.agents/skills/deploy");
  host.writeFile("/srv/app/.agents/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: On the remote host\n---\nDeploy body.\n");
  host.initRepository("/srv/app", "main");
  const base = await realpath(await mkdtemp(join(tmpdir(), "hepi-startup-ssh-")));
  const databasePath = join(base, "state", "calls.sqlite");
  const ssh = { profile: "loopback", host: host.profile.host, port: 2222, identityFile: "/keys/one", knownHostsFile: "/keys/known" };
  const settings: GatewayStartupSettings = { mode: "ssh", gatewayId: "workstation", token: TOKEN, workspaceId: "remote-loopback", workspaceRoot: host.root, allowedCommands: ["node", "bash"], port: 0, databasePath, ssh, sshTransport: { plain: host.runner, controlDirectory: false } };
  let running: RunningGateway | undefined;
  try {
    // The workspace id an SSH gateway serves is derived from the profile, so a foreign one is refused before anything
    // is composed or listened on, with the same wording the CLI reports.
    await assert.rejects(startGateway({ ...settings, workspaceId: "local" }), /must be remote-loopback for an SSH gateway/);
    running = await startGateway(settings);
    // The registry is seeded from the profile, so the workspace the protocol addresses is the remote root, and the
    // host answers with its own account rather than the gateway machine's.
    const identity = await post(running.origin, "/v1/files", { workspaceId: "remote-loopback", method: "executionHost" });
    assert.equal(identity.body?.ok, true, JSON.stringify(identity.body));
    assert.equal(identity.body.value.user, "remote-operator");
    assert.equal(identity.body.value.home, "/home/remote-operator");
    const read = await post(running.origin, "/v1/files", { workspaceId: "remote-loopback", method: "readTextFile", path: "remote.txt" });
    assert.equal(read.body?.value, "remote-content\n", JSON.stringify(read.body));
    // Execution asks the transport for the command and reports the host's own answer, which for a program this host
    // does not serve is the shell's own 127 — the exit code, not a gateway-invented success.
    const executed = await execute(running.origin, { gatewayId: "workstation", workspaceId: "remote-loopback", callId: "startup-ssh-1", command: [process.execPath, "-e", "process.stdout.write('remote')"] });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    assert.equal(executed.exitCode, 127, JSON.stringify(executed));
    assert.deepEqual(host.requests.at(-1)?.command, [process.execPath, "-e", "process.stdout.write('remote')"], "the transport was handed the command as it stands");
    assert.equal(host.requests.at(-1)?.root, host.root, "and the profile's root, which is the workspace it serves");
    // The resource scope set comes back over the same composition: one helper request carries the host's account, its
    // roots and the declaration of every resource the walk holds.
    const snapshot = await post(running.origin, "/v1/files", { workspaceId: "remote-loopback", method: "resourceSnapshot" });
    assert.equal(snapshot.body?.ok, true, JSON.stringify(snapshot.body).slice(0, 400));
    assert.equal(snapshot.body.value.host.user, "remote-operator");
    assert.ok((snapshot.body.value.files as { path: string }[]).some((file) => file.path === "/srv/app/.agents/skills/deploy/SKILL.md"), "the remote skill is in the snapshot");
    // Worktrees are a host capability: the profile's own root is the repository this gateway lists.
    const worktrees = await post(running.origin, "/v1/worktrees", { operation: "list", workspaceId: "remote-loopback" });
    assert.equal(worktrees.body?.ok, true, JSON.stringify(worktrees.body));
    assert.equal(worktrees.body.value.isGit, true, JSON.stringify(worktrees.body));
    // A remote host has no MCP capability of this Web host's, and the route says so by name rather than failing.
    const mcp = await post(running.origin, "/v1/mcp", { operation: "read" });
    assert.equal(mcp.body?.code, "mcp_unavailable", JSON.stringify(mcp.body));
    // The read-only workbench is mounted on this gateway too, over the same registry: the preview is read on the remote
    // host, and the answer is the same `WorkbenchFile` the local gateway serves.
    const preview = await post(running.origin, "/v1/workbench", { workspaceId: "remote-loopback", operation: "read", path: "remote.txt" });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body, { ok: true, value: { path: "remote.txt", content: "remote-content\n", truncated: false, binary: false, sizeBytes: 15, shownBytes: 15 } });
    // A path outside the remote workspace keeps the workbench's own refusal, and the route's own status for it.
    const denied = await post(running.origin, "/v1/workbench", { workspaceId: "remote-loopback", operation: "read", path: "../outside.txt" });
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.body, { ok: false, code: "path_denied" });
    // A transport that answers the host itself binds no master socket, so the composition creates no control
    // directory to leave behind — the state it owns is only its journal.
    assert.equal(existsSync(join(dirname(databasePath), "ssh-control")), false, "a stated in-process transport creates no master directory");
  } finally {
    if (running !== undefined) {
      await running.close();
      // Close settled the handle's own promise, and repeating it closes nothing twice.
      await running.closed;
      await running.close();
    }
    assert.deepEqual(await readdir(join(base, "state")).catch(() => []), ["calls.sqlite"], "the gateway left its journal and nothing else");
    await rm(base, { recursive: true, force: true });
  }
});
