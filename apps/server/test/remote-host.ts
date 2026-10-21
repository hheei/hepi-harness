import { mkdirSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { SshProfile, SshRunner, SshRunnerRequest, SshRunnerResult } from "../../../packages/gateway/src/index.ts";
import { fakeSsh, type FakeSsh } from "../../../packages/gateway/test/ssh-fake.ts";

/**
 * The remote computer the SSH project tests run against, in this process.
 *
 * The seam is the gateway's own \`SshRunner\`: one transport carries three of the gateway's programs — the filesystem
 * helper on a long-lived session, the workspace helper as one short call, and the shell a conversation executes — so a
 * host is only a runner that answers those. The filesystem session is `ssh-fake.ts`'s deterministic host over a real
 * temporary tree, and the workspace helper and the shell are answered below from the host's own rules over that same
 * tree. Nothing here opens a socket, starts a daemon, generates a key, waits for a login or runs a system program, so a
 * test's barrier is the request the gateway sent rather than elapsed time or an installed tool.
 *
 * What stays real is what the assertions read: the paths, the files, the account the host reports, and the argv of every
 * command the gateway asked it to run (\`commands\`).
 */

/** One helper answer, in the shape both helpers emit: \`{"ok": true, "value": ...}\` or a named failure. */
type Answer = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } };

const answered = (value?: unknown): Answer => value === undefined ? { ok: true } : { ok: true, value };
const refused = (code: string, message: string): Answer => ({ ok: false, error: { code, message } });

export type RemoteHost = {
  /** The host name every profile of this computer carries. */
  readonly host: string;
  /** The account the host reports for itself. */
  readonly user: string;
  readonly home: string;
  /** The directory a profile's \`remoteRoot\` names by default. */
  readonly root: string;
  /** The transport every gateway surface of this computer is composed with. */
  readonly runner: SshRunner;
  /** Every command the transport was asked to run, in order: what the host saw. */
  readonly commands: readonly string[];
  /** One configured profile of this computer, rooted where the test says. */
  profile(id: string, remoteRoot: string): SshProfile;
};

const within = (root: string, path: string): boolean => path === root || path.startsWith(root.replace(/\/+$/, "") + sep);

/**
 * The workspace helper's operations, from the host's own filesystem: the account it resolves, the directories below a
 * path, and a root it confirms. The codes are the program's own, so the gateway's classification is the code under test.
 */
async function workspace(account: { readonly user: string; readonly home: string }, argv: readonly string[]): Promise<Answer> {
  const [mode, ...args] = argv;
  if (mode === "host") return answered({ user: account.user, home: await realpath(account.home) });
  if (mode === "browse" || mode === "register") {
    const requested = args[0] ?? "";
    const invalid = mode === "browse" ? "invalid_request" : "invalid_root";
    if (!isAbsolute(requested)) return refused(invalid, "an absolute path is required");
    const canonical = await realpath(requested).catch(() => undefined);
    if (canonical === undefined) return refused(mode === "browse" ? "not_found" : "invalid_root", requested);
    const info = await stat(canonical).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) return refused(mode === "browse" ? "not_a_directory" : "invalid_root", requested);
    if (mode === "register") return answered({ root: canonical });
    const entries = await readdir(canonical, { withFileTypes: true });
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, path: join(canonical, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const parent = join(canonical, "..");
    return answered({ path: canonical, parentPath: parent === canonical ? null : resolve(parent), directories });
  }
  return refused("not_supported", "unknown remote workspace operation: " + mode);
}

/** The workspace helper a request carries, by the program its argv names: another program is not this one. */
function workspaceCall(command: readonly string[]): readonly string[] | undefined {
  if (command[0] !== "python3" || command[1] !== "-c") return undefined;
  const source = Buffer.from(command[3] ?? "", "base64").toString("utf8");
  // The helper's source is not exported by its module; its own refusal is its fingerprint, so a rename there fails this
  // host loudly instead of silently answering as another program.
  return source.includes("unknown remote workspace operation") ? command.slice(4) : undefined;
}

/**
 * One shell command, in the workspace directory, answered by this host's own rule for the programs it serves: `pwd`
 * reports the directory the gateway confined the command to, and any other program is `command not found` with `127`,
 * exactly as a host without that program answers. No process is started, so a test's barrier is the request the gateway
 * sent rather than a system program being installed, and a test that starts running something else fails loudly here
 * instead of quietly borrowing this machine's tools.
 */
async function shell(request: SshRunnerRequest): Promise<SshRunnerResult> {
  const root = resolve(request.root ?? request.cwd);
  const cwd = resolve(request.cwd);
  if (!within(root, cwd)) return { stdout: "", stderr: "the working directory is outside the workspace", exitCode: 126 };
  if (request.signal.aborted) throw Object.assign(new Error("ssh aborted; remote outcome unknown"), { code: "outcome_unknown" });
  const [program, ...rest] = request.command;
  // A transport carries one program and its arguments, so only a shell's own `-c` script is read as a script here.
  const script = program !== undefined && /(?:^|\/)(?:ba|da|z)?sh$/.test(program) && rest[0] === "-c" ? rest.slice(1).join(" ").trim() : "";
  const outcome: SshRunnerResult = script === "pwd"
    ? { stdout: cwd + "\n", stderr: "", exitCode: 0 }
    : { stdout: "", stderr: (script.split(/\s+/)[0] || program || "") + ": command not found\n", exitCode: 127 };
  if (outcome.stdout !== "") void request.onOutput?.({ stream: "stdout", text: outcome.stdout });
  if (outcome.stderr !== "") void request.onOutput?.({ stream: "stderr", text: outcome.stderr });
  return outcome;
}

/**
 * One remote computer, held in this process. Every profile it serves resolves to the same account and host name, and its
 * filesystem sessions are created per workspace root, because one session serves exactly one root.
 */
export function startRemoteHost(options: { readonly root: string; readonly user?: string; readonly home?: string; readonly host?: string }): RemoteHost {
  const user = options.user ?? "builder";
  // Beside the root, not inside it: the account's home is another place on the host, and a browse of the root must not
  // see it as one of the workspace's own directories.
  const home = options.home ?? resolve(options.root, "..", "remote-home");
  mkdirSync(home, { recursive: true });
  const host = options.host ?? "ssh-host.example";
  const commands: string[] = [];
  const sessions = new Map<string, FakeSsh>();
  const sessionFor = (root: string): FakeSsh => {
    const existing = sessions.get(root);
    if (existing !== undefined) return existing;
    const created = fakeSsh({ root, account: { user, home } });
    sessions.set(root, created);
    return created;
  };
  const runner: SshRunner = {
    async execute(request) {
      commands.push(request.command.join(" "));
      const argv = workspaceCall(request.command);
      if (argv !== undefined) return { stdout: JSON.stringify(await workspace({ user, home }, argv)), stderr: "", exitCode: 0 };
      // A helper this host does not serve is the \`exit 127\` a host without that program gives, never a fabricated answer.
      if (request.command[0] === "python3") return { stdout: "", stderr: "python3: this host serves no such helper", exitCode: 127 };
      return await shell(request);
    },
    open: (request) => sessionFor(request.root ?? request.cwd).runner.open!(request),
  };
  return { host, user, home, root: options.root, runner, commands, profile: (id, remoteRoot) => ({ id, host, remoteRoot }) };
}
