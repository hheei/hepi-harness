import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveWorkspacePath } from "./filesystem.ts";
import { workspaceOwner, type WorkspaceRegistry } from "./workspaces.ts";
import type { SshProfile } from "./index.ts";
import type { SshRunner } from "./runner.ts";

/** Frames the host helper writes on its standard output. */
const FRAME_OUTPUT = 1;
const FRAME_EXIT = 2;
const FRAME_ERROR = 3;
const FRAME_READY = 4;
/** Frames the gateway writes on the helper's standard input. */
const FRAME_INPUT = 1;
const FRAME_RESIZE = 2;
const FRAME_CLOSE = 3;
/** A terminal dimension is clamped to this range, the bound the upstream terminal surface already applies. */
const MIN_DIMENSION = 2;
const MAX_DIMENSION = 1000;
/**
 * The two numbers this capability introduces, and the only ones.
 *
 * `TERMINAL_REPLAY_CHARS` bounds what a reconnecting caller can be shown of the output produced while it was away:
 * a session keeps at most this much of its own output, and a replay never exceeds it.
 * `TERMINAL_RECONNECT_MS` is the reconnect window: how long a session with no caller attached is kept alive before
 * it is closed, so a dropped browser connection has time to come back and a closed tab does not leave a shell.
 */
export const TERMINAL_REPLAY_CHARS = 128 * 1024;
export const TERMINAL_RECONNECT_MS = 120_000;
/**
 * The most unwritten output one terminal connection may hold before it is ended as a slow consumer.
 *
 * A terminal subscriber is synchronous and its listener returns nothing, so a consumer that stops reading cannot be
 * paced: the helper keeps reading its pseudoterminal and the only bounded answer is to stop writing to that consumer.
 * Every frame of both event streams and the keepalive alike goes through one writer that encodes the frame once and
 * compares this budget against `response.writableLength` — the bytes Node has queued beyond what the socket accepted —
 * *before* writing. The connection then ends; the shell is untouched, and the caller reconnects with the cursor it
 * read, which the session answers from its own retained tail (`TERMINAL_REPLAY_CHARS`). A permanently slow reader is
 * therefore left with the retained tail and a reset, never with a promise of the whole history.
 *
 * The comparison is "already over", never "would go over", so a frame is always written unless the connection is
 * already behind: the pending bytes stay bounded by this budget plus the one frame being written, and every attempt
 * still delivers a whole frame. That is what keeps a legal replay — even one larger than this budget — from becoming a
 * reconnect loop, because the caller's cursor advances on every attempt instead of standing still.
 *
 * The number is one constant rather than a per-tab allowance: a slow consumer costs this much whether it holds one tab
 * or ten, and the bound does not grow with the tabs a caller names. It is chosen from measured wire sizes (see
 * `.dev/architecture-unification/probe-terminal-replay-size.ts` and the ticket 03 evidence record): the largest legal
 * *single* frame is one session's retained tail in the worst encoding — 131,072 control characters, each escaped by
 * JSON at six bytes — about 786 KiB on the wire, and the largest legal aggregate a page attaches, three such tabs, is
 * about 2.36 MiB. A budget below those would end a *healthy* consumer's legal replay and make it reconnect in a loop,
 * which is the one outcome this bound must not cause; 4 MiB carries that aggregate with margin and stays one stated
 * limit.
 */
export const TERMINAL_STREAM_BUDGET_BYTES = 4 * 1024 * 1024;
/**
 * The terminal stream's keepalive cadence, and the comment frame it writes.
 *
 * A terminal is quiet between keystrokes, and a transport that bounds an idle body would tear the stream down and make
 * the panel reconnect — which it answers with a reset. A comment frame is bytes with no event, so it defeats the idle
 * bound without moving the caller's cursor: an `id:` line here would be read as an output offset and would make the
 * browser resume from a place no output exists.
 *
 * The writer is the origin — this gateway — because a frame boundary is what a comment frame must land on, and a proxy
 * that appended one to a body it does not frame could split a payload.
 */
export const TERMINAL_HEARTBEAT_MS = 30_000;
export const TERMINAL_HEARTBEAT_FRAME = ":\n\n";
/** After this long a session that has not ended is killed outright, so a shell ignoring SIGHUP cannot outlive its close. */
const TERMINAL_END_GRACE_MS = 5000;
/** How long the helper waits before it re-checks its own kill deadline. */
const HELPER_SELECT_SECONDS = 0.5;

/**
 * The host program that owns one terminal session. It runs on the execution host — this machine for a local gateway,
 * the SSH host for a remote one — and needs nothing but the standard library's Python 3, the same requirement the
 * filesystem and installation helpers already have. It gives the session a real pseudoterminal, applies the window
 * size, reports the shell's exit status and ends the process group when the session is closed or when the gateway
 * that owned it disappears.
 *
 * The framed protocol is the contract between the gateway and this program: 1 byte kind, a 4-byte big-endian length,
 * then the payload. Output and exit travel on standard output; input, resize and close travel on standard input.
 */
const TERMINAL_HELPER_SCRIPT = `import fcntl, json, os, pty, pwd, select, signal, struct, sys, termios, time

READY, OUTPUT, EXIT, ERROR = 4, 1, 2, 3
INPUT, RESIZE, CLOSE = 1, 2, 3
GRACE_SECONDS = @@GRACE@@
SELECT_SECONDS = @@SELECT@@


def send(kind, payload):
    sys.stdout.buffer.write(bytes([kind]) + struct.pack(">I", len(payload)) + payload)
    sys.stdout.buffer.flush()


def fail(code, message):
    send(ERROR, json.dumps({"code": code, "message": message}).encode("utf-8"))
    sys.exit(1)


def read_exact(fd, count):
    data = b""
    while len(data) < count:
        chunk = os.read(fd, count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def write_all(fd, data):
    while data:
        data = data[os.write(fd, data):]


def session_environment(account):
    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["HOME"] = env.get("HOME") or account.pw_dir
    env["USER"] = env.get("USER") or account.pw_name
    env["SHELL"] = env.get("SHELL") or account.pw_shell or "/bin/sh"
    env.setdefault("PATH", "/usr/bin:/bin")
    env.setdefault("LANG", "C.UTF-8")
    return env


root = os.path.realpath(sys.argv[1])
cwd = os.path.realpath(sys.argv[2])
if cwd != root and not cwd.startswith(root + os.sep):
    fail("path_denied", "the working directory is outside the workspace root")
if not os.path.isdir(cwd):
    fail("path_denied", "the working directory does not exist on this host")
try:
    cols, rows = int(sys.argv[3]), int(sys.argv[4])
except ValueError:
    fail("invalid_request", "cols and rows must be integers")
if cols <= 0 or rows <= 0:
    fail("invalid_request", "cols and rows must be positive")

env = session_environment(pwd.getpwuid(os.getuid()))
os.chdir(cwd)
pid, master = pty.fork()
if pid == 0:
    try:
        os.execve(env["SHELL"], [env["SHELL"], "-l"], env)
    except OSError as error:
        sys.stderr.write(str(error) + chr(10))
    os._exit(126)


def winsize(columns, lines):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", lines, columns, 0, 0))


winsize(cols, rows)
# What this host resolved, so the gateway records the folder the shell really runs in rather than one it resolved
# itself: a root on another machine cannot be canonicalized here at all.
send(READY, json.dumps({"root": root, "cwd": cwd}).encode("utf-8"))

stdin = sys.stdin.fileno()
watching = [stdin, master]
kill_at = None
status = None


def end_session():
    global kill_at
    if kill_at is not None:
        return
    try:
        os.killpg(pid, signal.SIGHUP)
    except OSError:
        pass
    kill_at = time.monotonic() + GRACE_SECONDS


while status is None:
    timeout = SELECT_SECONDS if kill_at is None else max(0.0, min(SELECT_SECONDS, kill_at - time.monotonic()))
    readable, _, _ = select.select(watching, [], [], timeout)
    if kill_at is not None and time.monotonic() >= kill_at:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass
        kill_at = None
    if stdin in readable:
        header = read_exact(stdin, 5)
        if header is None:
            # The gateway that owned this session is gone: the shell must not outlive it.
            watching.remove(stdin)
            end_session()
        else:
            length = struct.unpack(">I", header[1:5])[0]
            payload = read_exact(stdin, length) if length else b""
            if payload is None:
                watching.remove(stdin)
                end_session()
            elif header[0] == INPUT:
                write_all(master, payload)
            elif header[0] == RESIZE and len(payload) == 4:
                winsize(*struct.unpack(">HH", payload))
            elif header[0] == CLOSE:
                end_session()
    if master in readable:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            send(OUTPUT, data)
        else:
            watching.remove(master)
    done, raw = os.waitpid(pid, os.WNOHANG)
    if done:
        status = raw

if os.WIFSIGNALED(status):
    signalled = os.WTERMSIG(status)
    code = 128 + signalled
else:
    signalled = 0
    code = os.WEXITSTATUS(status)
send(EXIT, json.dumps({"exitCode": code, "signal": signalled}).encode("utf-8"))
`;

const TERMINAL_HELPER_BASE64 = Buffer.from(
	TERMINAL_HELPER_SCRIPT.replace("@@GRACE@@", TERMINAL_END_GRACE_MS + " / 1000.0").replace("@@SELECT@@", String(HELPER_SELECT_SECONDS)),
	"utf8",
).toString("base64");
/** The helper travels as one argv word, so no shell ever has to parse it; this bootstrap restores `sys.argv`. */
const TERMINAL_BOOTSTRAP = "import base64,sys;src=base64.b64decode(sys.argv[1]);sys.argv=[sys.argv[0]]+sys.argv[2:];exec(compile(src,'hepi-terminal','exec'))";

/** The command that starts one host session: `root cwd cols rows` follow the encoded helper. */
export function terminalHelperCommand(root: string, cwd: string, cols: number, rows: number): readonly string[] {
	return ["python3", "-c", TERMINAL_BOOTSTRAP, TERMINAL_HELPER_BASE64, root, cwd, String(cols), String(rows)];
}

/** A named reason a terminal operation did not happen. Every one of them is an outcome a caller can act on. */
export type TerminalFailureCode =
	| "invalid_request"
	| "unknown_gateway"
	| "unknown_workspace"
	| "path_denied"
	| "unknown_terminal"
	| "terminal_exited"
	| "not_supported"
	| "unreachable"
	| "operation_failed";

export type TerminalFailure = { readonly ok: false; readonly code: TerminalFailureCode; readonly message?: string };

export type TerminalOpenRequest = {
	readonly gatewayId: string;
	readonly workspaceId: string;
	readonly cwd?: string;
	readonly cols: number;
	readonly rows: number;
	/**
	 * The caller's own name for the session. A browser tab addresses its terminal by an id it generated itself, so the
	 * session keeps that name and a reloaded tab reaches the same shell instead of starting a second one. Opening an id
	 * that is already running in the same workspace answers that session rather than replacing it.
	 */
	readonly id?: string;
};

export type TerminalOpenResult = { readonly ok: true; readonly id: string; readonly workspaceId: string; readonly cwd: string; readonly cols: number; readonly rows: number } | TerminalFailure;

/** What one session reports about itself, so a caller can tell a live shell from one that already ended. */
export type TerminalDescription = { readonly ok: true; readonly id: string; readonly workspaceId: string; readonly cwd: string; readonly cols: number; readonly rows: number; readonly exited: boolean } | TerminalFailure;

/** What one attach delivers: the output that was missed, and the exit once the host process is gone. */
export type TerminalReplay = {
	readonly data: string;
	/** The session's output offset after this replay, which is the cursor a later attach continues from. */
	readonly offset: number;
	/** True when the replay is the retained tail rather than the exact continuation of the caller's cursor. */
	readonly reset: boolean;
};

export type TerminalSubscription = {
	/** What was produced while the caller was away, bounded by `TERMINAL_REPLAY_BYTES`. */
	readonly replay: TerminalReplay;
	/** The session's exit, when it has already ended; a live session reports none. */
	readonly exit?: TerminalExit;
	unsubscribe(): void;
};

/**
 * What one session reports: output as it is produced, and its exit once the process on the host is gone.
 *
 * `reset` marks an output event whose data is the retained tail rather than the exact continuation of the caller's
 * cursor. A caller that sees it replaces what it shows instead of appending, so a stream is never silently inconsistent.
 */
export type TerminalEvent =
	| { readonly type: "output"; readonly data: string; readonly offset: number; readonly reset?: boolean }
	| { readonly type: "exit"; readonly exitCode: number | null; readonly signal: number };

/**
 * One event of a session read through the gateway's fan-in, which is the shape the browser sees.
 *
 * The same session facts as {@link TerminalEvent}, with the session named: one stream carries every mounted tab's
 * output, so a frame has to say which tab it belongs to. `id` is the same output cursor the per-session stream puts in
 * its event id, and `exit` is the same exit, so nothing about a session's own behaviour changes — only how many
 * connections its frames travel on.
 */
export type TerminalFanInEvent =
	| { readonly type: "output"; readonly id: string; readonly data: string; readonly offset: number; readonly reset?: boolean }
	| { readonly type: "exit"; readonly id: string; readonly exitCode: number | null; readonly signal: number };

export type TerminalExit = Extract<TerminalEvent, { readonly type: "exit" }>;
export type TerminalCommandResult = { readonly ok: true } | TerminalFailure;
export type TerminalCloseResult = { readonly ok: true; readonly exit: TerminalExit } | TerminalFailure;

/** One host session the gateway has started. It owns the process; the transport is how its frames travel. */
export type TerminalHost = {
	/**
	 * Resolves once the host session is running and can take input, with the root and working directory that host
	 * resolved; rejects with a named failure otherwise.
	 */
	readonly ready: Promise<TerminalResolution>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** Ask the host session to end. The exit is reported through `exited`, never inferred from this call. */
	end(): void;
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: number }>;
};

export type TerminalLaunch = {
	readonly workspaceId: string;
	/** The registered root and the requested directory inside it, as paths this gateway addresses. The execution host
	 * canonicalizes and confines them: for a remote workspace neither path exists on the machine this gateway runs on. */
	readonly root: string;
	readonly cwd: string;
	readonly cols: number;
	readonly rows: number;
	readonly onOutput: (text: string) => void;
};

/** The root and the working directory the execution host itself resolved and accepted for one session. */
export type TerminalResolution = { readonly root: string; readonly cwd: string };

export type TerminalLauncher = (launch: TerminalLaunch) => TerminalHost;

function frame(kind: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(kind, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

/** What the transport reported when a session ended before it was ready. */
type HostEnd = { readonly code: number | null; readonly signal: string | null; readonly stderr: string; readonly spawnError?: string };

/**
 * One session's framed conversation with the host program. It is the only place frames are read, so a local and an
 * SSH session differ only in the child process carrying them: a direct spawn of the helper, or `ssh` running the
 * same helper on the far side.
 */
class FramedTerminal implements TerminalHost {
	readonly ready: Promise<TerminalResolution>;
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: number }>;
	readonly #child: ChildProcess;
	readonly #classify: (end: HostEnd) => TerminalFailure;
	readonly #onOutput: (text: string) => void;
	#buffer = Buffer.alloc(0);
	#stderr = "";
	#readySettled = false;
	#resolveReady!: (resolution: TerminalResolution) => void;
	#rejectReady!: (failure: TerminalFailure) => void;
	#resolveExit!: (exit: { readonly exitCode: number | null; readonly signal: number }) => void;

	constructor(child: ChildProcess, options: { readonly onOutput: (text: string) => void; readonly classify: (end: HostEnd) => TerminalFailure }) {
		this.#child = child;
		this.#onOutput = options.onOutput;
		this.#classify = options.classify;
		this.ready = new Promise<TerminalResolution>((resolveReady, rejectReady) => {
			this.#resolveReady = resolveReady;
			this.#rejectReady = rejectReady;
		});
		this.exited = new Promise((resolveExit) => { this.#resolveExit = resolveExit; });
		// A failure before readiness is the session's own outcome, never an unhandled rejection.
		this.ready.catch(() => {});
		child.stdout?.on("data", (chunk: Buffer) => this.#consume(chunk));
		child.stderr?.on("data", (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-4096); });
		child.on("error", (error) => this.#finish({ code: null, signal: null, stderr: this.#stderr, spawnError: (error as NodeJS.ErrnoException).code ?? error.message }));
		child.on("close", (code, signal) => this.#finish({ code, signal, stderr: this.#stderr }));
	}

	write(data: string): void {
		this.#child.stdin?.write(frame(FRAME_INPUT, Buffer.from(data, "utf8")));
	}

	resize(cols: number, rows: number): void {
		const payload = Buffer.alloc(4);
		payload.writeUInt16BE(cols, 0);
		payload.writeUInt16BE(rows, 2);
		this.#child.stdin?.write(frame(FRAME_RESIZE, payload));
	}

	end(): void {
		this.#child.stdin?.write(frame(FRAME_CLOSE, Buffer.alloc(0)));
	}

	#consume(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 5) {
			const kind = this.#buffer.readUInt8(0);
			const length = this.#buffer.readUInt32BE(1);
			if (this.#buffer.length < 5 + length) return;
			const payload = this.#buffer.subarray(5, 5 + length);
			this.#buffer = this.#buffer.subarray(5 + length);
			if (kind === FRAME_OUTPUT) this.#onOutput(payload.toString("utf8"));
			else if (kind === FRAME_READY) this.#settleReady(payload);
			else if (kind === FRAME_EXIT) {
				const exit = JSON.parse(payload.toString("utf8")) as { exitCode: number; signal: number };
				this.#resolveExit({ exitCode: exit.exitCode, signal: exit.signal });
			} else if (kind === FRAME_ERROR) {
				const failure = JSON.parse(payload.toString("utf8")) as { code?: string; message?: string };
				this.#reject(failure.code === "path_denied" ? "path_denied" : failure.code === "invalid_request" ? "invalid_request" : "operation_failed", failure.message);
			}
		}
	}

	#settleReady(payload: Buffer): void {
		if (this.#readySettled) return;
		const resolution = JSON.parse(payload.toString("utf8")) as TerminalResolution;
		this.#readySettled = true;
		this.#resolveReady(resolution);
	}

	#reject(code: TerminalFailureCode, message?: string): void {
		if (this.#readySettled) return;
		this.#readySettled = true;
		this.#rejectReady({ ok: false, code, ...(message === undefined ? {} : { message }) });
	}

	#finish(end: HostEnd): void {
		const failure = this.#classify(end);
		this.#reject(failure.code, failure.message);
		// The transport is gone: unless an exit frame already arrived, the process's fate is unknown, not an exit.
		this.#resolveExit({ exitCode: null, signal: 0 });
	}
}

/**
 * The host program is not there at all: this execution host cannot serve a terminal.
 *
 * A missing `python3` reaches this classifier two ways and is the same host fact both times: locally the spawn itself
 * fails (`ENOENT`), over SSH the host's shell reports it and ends with 127. Both answer the same named limit, the way
 * the SSH filesystem already answers that host fact (`ssh-filesystem.ts`'s `#death`), so a caller is not told that a
 * host without a helper has a gateway that malfunctioned.
 */
function missingHelper(end: HostEnd): TerminalFailure {
	if (end.spawnError === "ENOENT") return { ok: false, code: "not_supported", message: "this host has no python3 on PATH, which the gateway terminal needs" };
	if (/python3: (command )?not found/i.test(end.stderr)) return { ok: false, code: "not_supported", message: "this host has no python3 on PATH, which the gateway terminal needs" };
	if (end.stderr.includes("No module named 'pty'")) return { ok: false, code: "not_supported", message: "this host's python3 has no pty module, so it cannot serve a terminal" };
	return { ok: false, code: "operation_failed", message: end.stderr.trim().split(String.fromCharCode(10)).slice(-1)[0] ?? "the terminal session ended before it was ready" };
}

/** A session that never started: every operation answers the same named reason. */
function failedHost(failure: TerminalFailure): TerminalHost {
	const ready = Promise.reject<TerminalResolution>(failure);
	// The caller of `open` reads this rejection; nothing else may see it as an unhandled one.
	ready.catch(() => {});
	return {
		ready,
		write: () => {},
		resize: () => {},
		end: () => {},
		exited: Promise.resolve({ exitCode: null, signal: 0 }),
	};
}

/**
 * A terminal on this machine: the helper runs as a child of the gateway with the gateway's own environment, so the
 * shell a user reaches is the one they would get in a terminal on that host. The paths travel as the gateway
 * addresses them and the helper canonicalizes and confines them here, exactly as it does on an SSH host.
 */
export function localTerminalLauncher(options: { readonly python?: string } = {}): TerminalLauncher {
	const python = options.python ?? "python3";
	return (launch) => {
		const child = spawn(python, terminalHelperCommand(launch.root, launch.cwd, launch.cols, launch.rows).slice(1), { stdio: ["pipe", "pipe", "pipe"] });
		return new FramedTerminal(child, { onOutput: launch.onOutput, classify: missingHelper });
	};
}

/**
 * A terminal on the configured SSH host: the same helper, started through the runner's interactive transport, so it
 * runs on the far side of a real SSH connection and this gateway never runs the shell itself. The workspace root is a
 * directory of that host, so it is resolved there: nothing here reads the gateway machine's own filesystem.
 */
export function sshTerminalLauncher(options: { readonly profiles: readonly SshProfile[]; readonly runner: SshRunner; readonly workspaces: WorkspaceRegistry }): TerminalLauncher {
	const profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
	return (launch) => {
		const owner = workspaceOwner(options.workspaces, profiles, launch.workspaceId);
		const open = options.runner.open;
		if (owner === undefined || open === undefined) return failedHost({ ok: false, code: "not_supported", message: "this SSH transport cannot hold a terminal session open" });
		const child = open({
			profile: owner.profile.id,
			host: owner.profile.host,
			root: launch.root,
			cwd: launch.cwd,
			port: owner.profile.port,
			identityFile: owner.profile.identityFile,
			knownHostsFile: owner.profile.knownHostsFile,
			command: terminalHelperCommand(launch.root, launch.cwd, launch.cols, launch.rows),
		});
		return new FramedTerminal(child, { onOutput: launch.onOutput, classify: (end) => (end.code === 255 ? { ok: false, code: "unreachable", message: "the SSH host is unreachable" } : missingHelper(end)) });
	};
}

/** One piece of a session's retained output, with the range of the session's stream it covers. */
type OutputChunk = { readonly text: string; readonly start: number; readonly end: number };

type Session = {
	readonly id: string;
	readonly workspaceId: string;
	/** The directory this gateway asked for, which is what a caller naming the same session again has to repeat. */
	readonly requestedCwd: string;
	/** The directory the execution host resolved and accepted, which is what this session reports and runs in. */
	cwd: string;
	cols: number;
	rows: number;
	readonly listeners: Set<(event: TerminalEvent) => void>;
	host: TerminalHost;
	/** Length of the output this session has produced, which is the cursor every attach continues from. */
	offset: number;
	/** The retained tail of that output, at most `TERMINAL_REPLAY_CHARS` of it, oldest first. */
	backlog: OutputChunk[];
	backlogLength: number;
	/** The lease that closes this session when no caller has attached for the reconnect window. */
	lease?: ReturnType<typeof setTimeout>;
	exit?: TerminalExit;
};

/**
 * The gateway's terminal sessions: one long-lived shell per session, opened in a registered workspace root of this
 * execution host.
 *
 * A session streams output as the shell produces it, takes input and a resize, and ends with the process on the host —
 * either because the shell exited by itself or because the session was closed, which signals the process group and
 * reports the exit that follows. Nothing here touches a conversation: a terminal is a host session with its own
 * lifecycle, so it writes no entry to any transcript.
 */
export class TerminalSessions {
	readonly #id: string;
	readonly #workspaces: WorkspaceRegistry;
	readonly #launcher: TerminalLauncher;
	readonly #reconnectMs: number;
	readonly #heartbeatMs: number;
	readonly #streamBudgetBytes: number;
	readonly #sessions = new Map<string, Session>();

	constructor(options: { readonly id: string; readonly workspaces: WorkspaceRegistry; readonly launcher: TerminalLauncher; readonly reconnectMs?: number; readonly heartbeatIntervalMs?: number; readonly streamBudgetBytes?: number }) {
		this.#id = options.id;
		this.#workspaces = options.workspaces;
		this.#launcher = options.launcher;
		// The reconnect window is a property of this gateway's sessions, and a deployment that states another one says
		// so here. Everything else reads the stated default.
		this.#reconnectMs = options.reconnectMs ?? TERMINAL_RECONNECT_MS;
		// The keepalive cadence is the same kind of deployment fact: a stream behind a stricter idle bound is stated
		// here rather than discovered by watching a terminal reconnect.
		this.#heartbeatMs = options.heartbeatIntervalMs ?? TERMINAL_HEARTBEAT_MS;
		// The stream budget is the same kind of deployment fact as the cadence, and a test states a small one so a slow
		// consumer is reached without emitting megabytes.
		this.#streamBudgetBytes = options.streamBudgetBytes ?? TERMINAL_STREAM_BUDGET_BYTES;
	}

	/** The keepalive cadence this gateway's event streams write at. */
	get heartbeatIntervalMs(): number { return this.#heartbeatMs; }

	/** The most unwritten output one terminal connection may hold before it is ended as a slow consumer. */
	get streamBudgetBytes(): number { return this.#streamBudgetBytes; }

	async open(request: TerminalOpenRequest): Promise<TerminalOpenResult> {
		if (request.gatewayId !== this.#id) return { ok: false, code: "unknown_gateway" };
		const workspace = this.#workspaces.get(request.workspaceId);
		if (workspace === undefined) return { ok: false, code: "unknown_workspace" };
		const cols = dimension(request.cols);
		const rows = dimension(request.rows);
		if (cols === undefined || rows === undefined) return { ok: false, code: "invalid_request", message: "cols and rows must be positive numbers" };
		// The requested directory is pure path arithmetic on the registered root: the root may be a directory of
		// another machine, so nothing here reads a filesystem. The execution host canonicalizes both and confines the
		// directory to the root, and reports the pair it accepted.
		const requested = resolveWorkspacePath(workspace.root, request.cwd === undefined || request.cwd === "" ? "." : request.cwd);

		// A caller that named its own session and already has one here keeps it: a reloaded tab must reach the shell it
		// started rather than a second one, and a caller that names an id already running elsewhere is refused instead
		// of having its shell replaced.
		const id = request.id ?? randomUUID();
		const existing = this.#sessions.get(id);
		if (existing !== undefined) {
			if (existing.workspaceId !== request.workspaceId || existing.requestedCwd !== requested) return { ok: false, code: "invalid_request", message: "that terminal id already names a session in another workspace" };
			this.#renew(existing);
			return { ok: true, id, workspaceId: existing.workspaceId, cwd: existing.cwd, cols: existing.cols, rows: existing.rows };
		}
		const session: Session = { id, workspaceId: request.workspaceId, requestedCwd: requested, cwd: requested, cols, rows, listeners: new Set(), offset: 0, backlog: [], backlogLength: 0, host: failedHost({ ok: false, code: "operation_failed" }) };
		this.#sessions.set(id, session);
		session.host = this.#launcher({
			workspaceId: request.workspaceId,
			root: workspace.root,
			cwd: requested,
			cols,
			rows,
			onOutput: (text) => this.#record(session, text),
		});
		void session.host.exited.then((exit) => {
			if (session.exit !== undefined) return;
			const recorded: TerminalExit = { type: "exit", exitCode: exit.exitCode, signal: exit.signal };
			session.exit = recorded;
			this.#emit(session, recorded);
			this.#renew(session);
		});
		let resolved: TerminalResolution;
		try {
			resolved = await session.host.ready;
		} catch (failure) {
			this.#sessions.delete(id);
			this.#clearLease(session);
			return failure as TerminalFailure;
		}
		// The session runs where the host said it does, so every later answer and replay names that folder.
		session.cwd = resolved.cwd;
		// A session whose opener never attaches — a tab closed before its stream opened — is closed after the window
		// like any other detached one, so no shell outlives the caller that asked for it.
		this.#renew(session);
		return { ok: true, id, workspaceId: request.workspaceId, cwd: resolved.cwd, cols, rows };
	}

	/** What one session is, without attaching to it. A caller that only has to know whether its shell is still there. */
	describe(id: string): TerminalDescription {
		const session = this.#sessions.get(id);
		if (session === undefined) return { ok: false, code: "unknown_terminal" };
		return { ok: true, id: session.id, workspaceId: session.workspaceId, cwd: session.cwd, cols: session.cols, rows: session.rows, exited: session.exit !== undefined };
	}

	/**
	 * Attach to a session's events, replaying what the caller missed.
	 *
	 * `after` is the output offset the caller last saw, which is what makes a reconnect a continuation rather than a
	 * restart. A caller that names no offset, one that is behind the retained tail, or one ahead of the session's own
	 * offset gets the retained tail and is told so with `reset`, so a stream is never silently inconsistent. An attach
	 * also holds the session open: while at least one caller is attached, the reconnect lease does not run.
	 */
	subscribe(id: string, listener: (event: TerminalEvent) => void, after?: number): TerminalSubscription | undefined {
		const session = this.#sessions.get(id);
		if (session === undefined) return undefined;
		session.listeners.add(listener);
		this.#renew(session);
		const first = session.backlog[0];
		const retainedStart = first === undefined ? session.offset : first.start;
		const reset = after === undefined || !Number.isFinite(after) || after < retainedStart || after > session.offset;
		const kept = reset ? session.backlog : session.backlog.filter(chunk => chunk.end > after);
		// A kept chunk may straddle the cursor, so the offset is applied against the first kept chunk's own start.
		const base = kept[0]?.start ?? session.offset;
		const replay = { data: kept.map(chunk => chunk.text).join("").slice(reset ? 0 : after - base), offset: session.offset, reset };
		return {
			replay,
			...(session.exit === undefined ? {} : { exit: session.exit }),
			unsubscribe: () => {
				session.listeners.delete(listener);
				this.#renew(session);
			},
		};
	}

	write(id: string, data: string): TerminalCommandResult {
		const session = this.#sessions.get(id);
		if (session === undefined) return { ok: false, code: "unknown_terminal" };
		if (session.exit !== undefined) return { ok: false, code: "terminal_exited" };
		this.#renew(session);
		session.host.write(data);
		return { ok: true };
	}

	resize(id: string, cols: number, rows: number): TerminalCommandResult {
		const session = this.#sessions.get(id);
		if (session === undefined) return { ok: false, code: "unknown_terminal" };
		if (session.exit !== undefined) return { ok: false, code: "terminal_exited" };
		const width = dimension(cols);
		const height = dimension(rows);
		if (width === undefined || height === undefined) return { ok: false, code: "invalid_request", message: "cols and rows must be positive numbers" };
		session.cols = width;
		session.rows = height;
		this.#renew(session);
		session.host.resize(width, height);
		return { ok: true };
	}

	/** Close a session and answer the exit it produced, so a caller learns the process is gone from the host itself. */
	async close(id: string): Promise<TerminalCloseResult> {
		const session = this.#sessions.get(id);
		if (session === undefined) return { ok: false, code: "unknown_terminal" };
		this.#clearLease(session);
		if (session.exit === undefined) {
			session.host.end();
			await session.host.exited;
		}
		return { ok: true, exit: session.exit ?? { type: "exit", exitCode: null, signal: 0 } };
	}

	/** End every session this gateway holds, so no shell outlives the gateway that started it. */
	async closeAll(): Promise<void> {
		await Promise.all([...this.#sessions.values()].map(async (session) => {
			this.#clearLease(session);
			if (session.exit !== undefined) return;
			session.host.end();
			await session.host.exited;
		}));
	}

	/**
	 * One piece of output: counted on the session's stream, retained up to the stated bound, and delivered as it comes.
	 * The cursor is measured in the same units a caller sees — the characters of the output — so an offset taken from
	 * one event continues exactly from it, whatever the bytes behind it were.
	 */
	#record(session: Session, text: string): void {
		const start = session.offset;
		session.offset += text.length;
		session.backlog.push({ text, start, end: session.offset });
		session.backlogLength += text.length;
		// The bound is on the retained output, so a long-running command cannot grow a session's memory without limit.
		while (session.backlogLength > TERMINAL_REPLAY_CHARS && session.backlog.length > 1) {
			session.backlogLength -= session.backlog.shift()!.text.length;
		}
		this.#emit(session, { type: "output", data: text, offset: session.offset });
	}

	#emit(session: Session, event: TerminalEvent): void {
		for (const listener of session.listeners) listener(event);
	}

	/**
	 * Hold the session for another reconnect window. An attached caller holds it outright; a detached one runs out its
	 * window, and what the window runs out *on* depends on the session: a live shell is closed, so no shell outlives the
	 * last caller that cared about it, and a session that has already ended is forgotten, so a gateway's memory does not
	 * grow with every terminal a user ever opened.
	 */
	#renew(session: Session): void {
		this.#clearLease(session);
		if (session.listeners.size > 0) return;
		session.lease = setTimeout(() => { void this.#expire(session); }, this.#reconnectMs);
		session.lease.unref?.();
	}

	#clearLease(session: Session): void {
		if (session.lease === undefined) return;
		clearTimeout(session.lease);
		session.lease = undefined;
	}

	/** The reconnect window ran out with nobody attached: close the shell, or forget the session it already reported. */
	async #expire(session: Session): Promise<void> {
		session.lease = undefined;
		if (session.listeners.size > 0) return;
		if (session.exit !== undefined) {
			this.#sessions.delete(session.id);
			return;
		}
		session.host.end();
		// The exit that follows re-arms the window, which is what forgets the session once it is over.
		await session.host.exited.catch(() => {});
	}
}

function dimension(value: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.floor(value)));
}
