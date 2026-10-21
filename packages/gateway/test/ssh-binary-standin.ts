import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { REMOTE_INSTALL_SCRIPT } from "../src/install.ts";
import { remoteInstall } from "./install-host.ts";

/**
 * A stand-in for the `ssh` binary the gateway spawns, and for the host it reaches.
 *
 * The managed ControlMaster is an argv contract — `-S <socket>` on the short-lived `execute` spawn and nothing on the
 * long-lived `open` one — together with the host's own multiplexing: a master authenticates once, a call naming a
 * socket the host already holds rides it, and a call whose socket directory is missing fails the way ssh fails (255,
 * after it authenticated). Both are modelled here by replacing `spawn`/`execFile` on `node:child_process` for the
 * duration of one test, so no process starts and nothing is waited for. The gateway's argv, the answers it reads and the
 * socket files it leaves behind are still real; only the transport is not.
 *
 * A host-side command is answered by the same stand-in host the installation tests use (`install-host.ts`), so a
 * publication really writes its files and really records its lock, through the argv the gateway built.
 */

/** One ssh process the gateway spawned, as the argv it was given and what that argv asks for. */
export type SshCall = {
  /** `execute` is the short-lived call, `open` the long-lived session, `exit` a teardown of one master. */
  readonly mode: "execute" | "open" | "exit";
  readonly argv: readonly string[];
  /** The master socket the argv names after `-S`, if any. */
  readonly socket?: string;
  readonly host: string;
};

/** The host's own view: how many connections it authenticated, and which masters it holds. */
export type SshHost = {
  /** Connections authenticated: one per master the first time it is named, and one per call that rides nothing. */
  accepted: number;
  /** The master sockets this host holds. */
  readonly masters: Map<string, SshCall>;
  /** Every process the gateway spawned, in order. */
  readonly calls: SshCall[];
};

export function sshHost(): SshHost {
  return { accepted: 0, masters: new Map(), calls: [] };
}

/** Split one argv word written by `quoteArg`: single quotes, with an embedded quote closed and reopened. */
function unquote(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "'") throw new Error("a remote word was not quoted: " + value);
    index += 1;
    while (index < value.length) {
      if (value.startsWith("'\"'\"'", index)) { out += "'"; index += 5; continue; }
      if (value[index] === "'") break;
      out += value[index];
      index += 1;
    }
    index += 1;
  }
  return out;
}

/** The argv words of a remote shell command, as `quoteArg` wrote them. */
function words(command: string): string[] {
  const found: string[] = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] === " ") { index += 1; continue; }
    if (command[index] !== "'") throw new Error("a remote word was not quoted: " + command.slice(index));
    let end = index + 1;
    while (end < command.length) {
      if (command.startsWith("'\"'\"'", end)) { end += 5; continue; }
      if (command[end] === "'") break;
      end += 1;
    }
    found.push(unquote(command.slice(index, end + 1)));
    index = end + 1;
  }
  return found;
}

type Answer = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };

/** What the host prints for one command it was asked to run, or nothing when it has no such program. */
async function answer(options: { readonly home: string; readonly cwd: string; readonly command: readonly string[] }): Promise<Answer | undefined> {
  const command = options.command;
  // The installation capability sends its stdlib-only helper as one base64 program, exactly as it does to a real host.
  if (command[0] === "python3" && command[1] === "-c") {
    assert.equal(Buffer.from(command[3]!, "base64").toString("utf8"), REMOTE_INSTALL_SCRIPT, "the request carries the installation helper program");
    assert.equal(command[4], options.cwd, "the helper is pinned to the directory the remote shell changed into");
    const [mode, ...args] = command.slice(5);
    const reply = await remoteInstall({ home: options.home, root: command[4]!, mode: mode!, args });
    return { stdout: JSON.stringify(reply), stderr: "", exitCode: 0 };
  }
  // A plain command: the stand-in host runs the few shapes the tests ask for and nothing else.
  const shell = command.length === 3 && command[0] === "bash" && command[1] === "-c" ? command[2]! : command.length === 1 ? command[0]! : undefined;
  if (shell === "true") return { stdout: "", stderr: "", exitCode: 0 };
  if (shell === "false") return { stdout: "", stderr: "", exitCode: 1 };
  if (shell?.startsWith("echo ")) return { stdout: shell.slice(5) + "\n", stderr: "", exitCode: 0 };
  if (shell?.startsWith("printf ")) return { stdout: shell.slice(7), stderr: "", exitCode: 0 };
  return undefined;
}

/** A child whose properties this file assigns: `ChildProcess` declares its pipes and `kill` read-only. */
type MutableChild = { -readonly [Key in keyof ChildProcess]: ChildProcess[Key] };

/** A child that never starts: it holds its pipes, reports what the host printed, then closes. */
function fakeProcess(settle: () => Promise<Answer | undefined>): ChildProcess {
  const child = new EventEmitter() as unknown as MutableChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new PassThrough();
  child.kill = () => true;
  void (async () => {
    let result: Answer | undefined;
    try {
      result = await settle();
    } catch (error) {
      // A failure of the stand-in itself is the child's own error, which the runner reports instead of swallowing it.
      child.emit("error", error);
      return;
    }
    if (result === undefined) {
      child.emit("error", Object.assign(new Error("the stand-in host has no such program"), { code: "ENOENT" }));
      return;
    }
    // The runner attaches its listeners as soon as it has the child, before this continuation runs, so the bytes and the
    // close event it reads are the host's own answer.
    stdout.end(result.stdout);
    stderr.end(result.stderr);
    child.emit("close", result.exitCode, null);
  })();
  return child;
}

/** A long-lived session: it stays open until the caller ends it, exactly like a process holding its pipes. */
function fakeSession(): ChildProcess {
  const child = new EventEmitter() as unknown as MutableChild;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = new PassThrough();
  child.kill = () => {
    stdout.end();
    stderr.end();
    setImmediate(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

/**
 * Install the stand-in for one test and return the function that puts the real `ssh` back. Every spawn is recorded, and
 * the host it reaches authenticates and multiplexes the way a real one does.
 */
export function installSshStandIn(host: SshHost, options: { readonly home: string }): () => void {
  const originalSpawn = childProcess.spawn;
  const originalExecFile = childProcess.execFile;

  const record = (argv: readonly string[], mode: SshCall["mode"]): SshCall => {
    const index = argv.indexOf("-S");
    const socket = index === -1 ? undefined : argv[index + 1];
    const separator = argv.indexOf("--");
    const call: SshCall = { mode, argv: [...argv], ...(socket === undefined ? {} : { socket }), host: separator === -1 ? "" : argv[separator + 1] ?? "" };
    host.calls.push(call);
    return call;
  };

  /** End one master the way `ssh -O exit` does: 0 while something is listening, 255 once nothing is. */
  const endMaster = (call: SshCall): { readonly live: boolean; readonly stderr: string; readonly exitCode: number } => {
    const live = call.socket !== undefined && existsSync(call.socket);
    if (call.socket !== undefined) host.masters.delete(call.socket);
    return { live, stderr: live ? "" : "Control socket connect: No such file or directory\n", exitCode: live ? 0 : 255 };
  };

  const spawn = ((file: string, args: readonly string[]) => {
    assert.equal(file, "ssh", "the gateway's transport is ssh");
    const argv = [...args];
    const script = argv[argv.length - 1]!;
    if (argv.includes("-O")) {
      const call = record(argv, "exit");
      const ended = endMaster(call);
      return fakeProcess(async () => ({ stdout: "", stderr: ended.stderr, exitCode: ended.exitCode }));
    }
    // A long-lived session is spawned as `exec <program>`; a short-lived call runs the confinement preamble and then
    // `exec env -i PATH=...`, which is what carries the managed options and the remote program.
    const preamble = "exec env -i PATH=/usr/bin:/bin ";
    const at = script.indexOf(preamble);
    if (at === -1) {
      record(argv, "open");
      // A session is its own connection and never names a master.
      host.accepted += 1;
      return fakeSession();
    }
    const call = record(argv, "execute");
    const command = words(script.slice(at + preamble.length));
    const cwd = /cd -- ('(?:[^']|'"'"')*')/.exec(script);
    const directory = cwd === null ? "" : unquote(cwd[1]!);
    // Every connection authenticates once: a transport composed without a master opens one of its own, and a call that
    // names a master the host already holds rides it without authenticating again.
    const riding = call.socket !== undefined && host.masters.has(call.socket);
    if (!riding) host.accepted += 1;
    if (call.socket === undefined) return fakeProcess(async () => await answer({ home: options.home, cwd: directory, command }));
    // ssh authenticates before it discovers it cannot bind its own socket, so a socket directory that is missing or
    // wrongly permissioned fails the call after that authentication and the remote program never runs.
    const socketDirectory = dirname(call.socket);
    if (!existsSync(socketDirectory)) return fakeProcess(async () => ({ stdout: "", stderr: "Control socket path is not a directory\n", exitCode: 255 }));
    // A master the host does not hold yet is bound by this call: the socket is created owner-only, as ssh creates it.
    if (!riding) {
      host.masters.set(call.socket, call);
      writeFileSync(call.socket, "", { mode: 0o600 });
    }
    return fakeProcess(async () => await answer({ home: options.home, cwd: directory, command }));
  }) as unknown as typeof childProcess.spawn;

  const execFile = ((file: string, args: readonly string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null) => void) => {
    const done = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as (error: Error | null) => void;
    const call = record([...args], "exit");
    const ended = endMaster(call);
    setImmediate(() => done(ended.live ? null : Object.assign(new Error(ended.stderr), { code: 255 })));
    return {} as unknown;
  }) as unknown as typeof childProcess.execFile;

  childProcess.spawn = spawn;
  childProcess.execFile = execFile;
  syncBuiltinESMExports();
  return () => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
  };
}
