import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { REMOTE_FILESYSTEM_SCRIPT } from "../src/ssh-filesystem-helper.ts";
import type { SshRunner, SshRunnerRequest } from "../src/index.ts";

const run = promisify(execFile);

/**
 * The account a controlled SSH transport reports for the host it stands in for. `unresolvable` makes the host's own
 * account lookup fail, which is what a host without a usable account database does.
 */
export type SshTransportAccount = { readonly user: string; readonly home: string; readonly unresolvable?: boolean };

/** One request frame the remote helper was handed, as the transport saw it. */
export type HelperFrame = { readonly mode: string; readonly args: readonly string[]; readonly allow: { readonly roots?: readonly string[]; readonly files?: readonly string[] } };

/**
 * Decode the request frames a session child is handed, so a test can assert which helper operations ran over the one
 * session instead of reading a log line. The child's own `write` is left in place: this observes, it does not intercept.
 */
export function recordFrames(child: ChildProcess, frames: HelperFrame[], onFrame?: (frame: HelperFrame) => void): void {
  const stdin = child.stdin!;
  const write = stdin.write.bind(stdin) as unknown as (chunk: Buffer) => boolean;
  let buffer = Buffer.alloc(0);
  (stdin as unknown as { write: (chunk: Buffer) => boolean }).write = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) break;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (payload.length > 0) {
        const frame = JSON.parse(payload.toString("utf8")) as { mode: string; args?: string[]; allow?: HelperFrame["allow"] };
        const recorded: HelperFrame = { mode: frame.mode, args: frame.args ?? [], allow: frame.allow ?? {} };
        frames.push(recorded);
        onFrame?.(recorded);
      }
    }
    return write(chunk);
  };
}

/**
 * The gateway's SSH runner contract, executed on this machine: the remote helper is the real Python 3 program, the
 * command is the exact argv the gateway builds, and only the transport is local. A one-shot request runs through
 * `execute` and a persistent session through `open`, exactly as the gateway uses them.
 *
 * When an account is given, a generated `sitecustomize` module makes the helper's own
 * `pwd.getpwuid(os.getuid())` answer with that login and home. This is a controlled transport fixture, not a
 * production mechanism: only the child Python process sees it, the gateway and this test keep their real identity, and
 * the helper's identity resolution, discovery and confinement run unmodified.
 *
 * `scripts` names the helpers the request may carry: the filesystem helper by default, or both it and the
 * installation helper when one gateway serves both capabilities. A request carrying any other program is refused.
 */
export function pythonSshRunner(account?: SshTransportAccount, scripts: string | readonly string[] = REMOTE_FILESYSTEM_SCRIPT): { runner: SshRunner; requests: SshRunnerRequest[]; frames: HelperFrame[] } {
  const allowed = new Set(typeof scripts === "string" ? [scripts] : scripts);
  const requests: SshRunnerRequest[] = [];
  const frames: HelperFrame[] = [];
  let pythonPath: string | undefined;
  if (account !== undefined) {
    pythonPath = join(dirname(account.home), "ssh-stub");
    mkdirSync(pythonPath, { recursive: true });
    writeFileSync(join(pythonPath, "sitecustomize.py"), [
      "import pwd",
      "class _Entry:",
      "    pw_name = " + JSON.stringify(account.user),
      "    pw_dir = " + JSON.stringify(account.home),
      account.unresolvable === true
        ? "def _missing(uid): raise KeyError('no such user: ' + str(uid))" + String.fromCharCode(10) + "pwd.getpwuid = _missing"
        : "pwd.getpwuid = lambda uid: _Entry()",
      "",
    ].join(String.fromCharCode(10)));
  }
  const env = pythonPath === undefined ? process.env : { ...process.env, PYTHONPATH: pythonPath };
  /** The helper program one request names, checked against what this transport is willing to run. */
  const program = (command: readonly string[]): string => {
    assert.equal(command[0], "python3");
    assert.equal(command[1], "-c");
    const encoded = command[3];
    const source = Buffer.from(encoded!, "base64").toString("utf8");
    assert.ok(allowed.has(source), "the request carries a helper this transport does not serve");
    return source;
  };
  const runner: SshRunner = {
    execute: async (request) => {
      requests.push(request);
      program(request.command);
      const [bootstrap, encoded, ...rest] = request.command.slice(2);
      // Both helpers take the profile's root as their first argument, and both are pinned here, so a request cannot
      // smuggle another program into the transport.
      assert.equal(rest[0], request.root);
      try {
        const { stdout, stderr } = await run("python3", ["-c", bootstrap!, encoded!, ...rest], { cwd: request.cwd, env });
        return { stdout, stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { code?: number | string; stdout?: string; stderr?: string };
        if (typeof failure.code === "number") return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: failure.code };
        throw Object.assign(new Error("unreachable"), { code: "unreachable" });
      }
    },
    open: (request) => {
      program(request.command);
      const [bootstrap, encoded, ...rest] = request.command.slice(2);
      assert.equal(rest[0], request.root);
      const child = spawn("python3", ["-c", bootstrap!, encoded!, ...rest], { cwd: request.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      recordFrames(child, frames);
      return child;
    },
  };
  return { runner, requests, frames };
}

/**
 * A transport whose host never serves a session: it writes what a failing host writes and exits. `code 255` is ssh's
 * own connection failure and `code 127` with a "command not found" stderr is a host without Python 3, so a test can
 * assert how each is reported without a network and without a sleep.
 */
export function failingSshRunner(options: { readonly stderr?: string; readonly exitCode?: number; readonly spawnError?: string }): SshRunner {
  const script = "process.stderr.write(" + JSON.stringify(options.stderr ?? "") + "); process.exit(" + (options.exitCode ?? 255) + ");";
  return {
    execute: async () => { throw Object.assign(new Error("the session transport has no one-shot path"), { code: "unreachable" }); },
    open: () => {
      if (options.spawnError !== undefined) {
        const child = spawn("python3", ["-c", "0"], { stdio: ["pipe", "pipe", "pipe"] });
        // A transport that cannot even start the connection reports it the way `spawn` does: as an error event.
        setImmediate(() => child.emit("error", Object.assign(new Error(options.spawnError), { code: options.spawnError })));
        return child;
      }
      return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    },
  };
}
