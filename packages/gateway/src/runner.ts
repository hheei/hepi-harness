import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { StreamDecoder } from "@earendil-works/pi-durable/env";
import type { OutputSink } from "./execution.ts";
import { TERMINAL_RECONNECT_MS } from "./terminal.ts";

export type SshRunnerRequest = {
	readonly profile: string;
	readonly host: string;
	readonly cwd: string;
	readonly command: readonly string[];
	readonly timeoutMs?: number;
	readonly signal: AbortSignal;
	readonly root?: string;
	readonly port?: number;
	readonly identityFile?: string;
	readonly knownHostsFile?: string;
	readonly env?: Record<string, string>;
	/**
	 * Output as it arrives. The runner holds this stream back while the returned promise is pending, so a sink that
	 * commits progress before answering paces the remote command.
	 */
	readonly onOutput?: OutputSink;
};
export type SshRunnerResult = { readonly stdout: string; readonly stderr: string; readonly exitCode: number };

/**
 * A long-lived program on the host whose standard streams stay open: one terminal session, addressed by the profile
 * that owns the workspace and the directory it runs in. The transport owns nothing about the session beyond its pipes.
 */
export type SshOpenRequest = {
	readonly profile: string;
	readonly host: string;
	readonly cwd: string;
	readonly command: readonly string[];
	readonly root?: string;
	readonly port?: number;
	readonly identityFile?: string;
	readonly knownHostsFile?: string;
};

export type SshRunner = {
	execute(request: SshRunnerRequest): Promise<SshRunnerResult>;
	/**
	 * Start one long-lived program over the same connection settings and return the child carrying its pipes. Absent
	 * on a transport that cannot hold a session open, which is then reported as a named limit rather than a failure.
	 */
	open?(request: SshOpenRequest): ChildProcess;
};

/** The connection settings one ssh process is built from, before any capability-specific option. */
export type SshConnection = {
	readonly host: string;
	readonly port?: number;
	readonly identityFile?: string;
	readonly knownHostsFile?: string;
};

/** The profile a managed master is keyed on: two profiles differing in any field cannot share one socket. */
type ControlKey = SshConnection & { readonly profile: string };

/**
 * A gateway-managed multiplexing socket: one SSH master per full connection profile, in a directory this gateway owns.
 * The gateway's own install and execution processes pass `ControlMaster=auto`, so the first call becomes the master and
 * the rest ride it; nothing here disables the user's own multiplexing, and the user's own `ssh` never reads this path.
 * `prepare` is what creates the directory, because ssh exits 255 with no fallback when the ControlPath directory is
 * missing, and a directory another account can write is a socket another account can hijack.
 */
export type ManagedControlMaster = {
	/** Create and mode-check the owned directory. A failure is reported, never worked around. */
	prepare(): Promise<void>;
	/** The `-o` words that put this request on its profile's master, remembering the master this instance used. */
	argsFor(request: ControlKey): string[];
	/** End every master this instance created and remove only its own sockets, bounded. */
	close(): Promise<void>;
};

/** The directory's own mode: ssh_config(5) requires a ControlPath directory no other account can write. */
const CONTROL_DIRECTORY_MODE = 0o700;
/** How long one `ssh -O exit` may take before teardown stops waiting for it. */
const CONTROL_EXIT_TIMEOUT_MS = 5000;

/**
 * One master per `(profileId, host, port, identityFile, knownHostsFile)`. `%C` is deliberately not used: it hashes
 * only login, host, port, user and jump host, so it cannot tell two profiles that share `user@host:port` apart.
 * The socket name also carries this process's pid, so a restart never collides with a live sibling and never reuses
 * another process's name.
 */
export function managedControlMaster(options: { directory: string }): ManagedControlMaster {
	const directory = options.directory;
	const persistSeconds = TERMINAL_RECONNECT_MS / 1000;
	const used = new Map<string, ControlKey>();
	let createdDirectory = false;
	const socketFor = (request: ControlKey) =>
		join(directory, "hepi-" + createHash("sha256")
			.update(JSON.stringify([request.profile, request.host, request.port ?? 22, request.identityFile ?? "", request.knownHostsFile ?? ""]))
			.digest("hex").slice(0, 16) + "-" + process.pid);
	return {
		async prepare() {
			const existing = await stat(directory).catch(() => undefined);
			await mkdir(directory, { recursive: true, mode: CONTROL_DIRECTORY_MODE });
			if (existing === undefined) createdDirectory = true;
			const current = await stat(directory).catch(() => undefined);
			if (current === undefined || !current.isDirectory()) throw new Error("the gateway's SSH control directory " + directory + " is not a directory");
			if ((current.mode & 0o777) !== CONTROL_DIRECTORY_MODE) throw new Error("the gateway's SSH control directory " + directory + " must be mode 0700, not 0" + (current.mode & 0o777).toString(8));
		},
		argsFor(request) {
			const socket = socketFor(request);
			used.set(socket, request);
			// `-S` and not `-o ControlPath=`: the `-o` word is re-parsed as a configuration line, where a space in
			// the path is an argument separator and ssh exits 255 before it authenticates. `-S` takes its own argv word
			// verbatim, so a state directory such as `.../hepi gateway data/ssh-control` works like any other.
			return ["-o", "ControlMaster=auto", "-S", socket, "-o", "ControlPersist=" + persistSeconds];
		},
		async close() {
			for (const [socket, request] of used) {
				// The only way to end a master this process started. A socket already gone answers 255, which is not a failure here.
				await new Promise<void>((resolveExit) => {
					execFile("ssh", [...sshConnectionArgs(request), "-S", socket, "-O", "exit", "--", request.host], { timeout: CONTROL_EXIT_TIMEOUT_MS }, () => resolveExit());
				});
				await rm(socket, { force: true });
			}
			used.clear();
			// The directory goes only when this instance created it and nothing else is in it: a sibling's socket is not ours to delete.
			if (createdDirectory) await rmdir(directory).catch(() => undefined);
		},
	};
}

/** The connection settings every ssh process of one capability shares, before any managed master option. */
export function sshConnectionArgs(request: SshConnection): string[] {
	return [
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		...(request.port ? ["-p", String(request.port)] : []),
		...(request.identityFile ? ["-i", request.identityFile, "-o", "IdentitiesOnly=yes"] : []),
		...(request.knownHostsFile ? ["-o", "UserKnownHostsFile=" + request.knownHostsFile, "-o", "StrictHostKeyChecking=yes"] : []),
	];
}

/** One argv word for the remote shell: single quotes, with an embedded quote closed and reopened. */
function quoteArg(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

type Pausable = { pause(): void; resume(): void };

/**
 * Decode one process stream chunk by chunk, hand each chunk to the sink, and hold the stream back until the sink
 * settles. A byte split across chunks is held until the rest arrives, so text is never cut mid-character.
 */
class StreamPump {
	readonly #decoder = new StreamDecoder();
	readonly #stream: Pausable;
	readonly #name: "stdout" | "stderr";
	readonly #sink: OutputSink;
	#tail: Promise<void> = Promise.resolve();

	constructor(stream: Pausable, name: "stdout" | "stderr", sink: OutputSink) {
		this.#stream = stream;
		this.#name = name;
		this.#sink = sink;
	}

	feed(chunk: Buffer): void {
		const text = this.#decoder.decode(chunk);
		if (text === "") return;
		// Hold the stream back until the sink settles, so a sink that commits progress paces the remote command.
		this.#stream.pause();
		this.#tail = this.#tail.then(async () => {
			// A sink that fails must not wedge the pump: the process still has to be waited for and reaped.
			try {
				await this.#sink({ stream: this.#name, text });
			} catch {
				/* ignored */
			}
			this.#stream.resume();
		});
	}

	/** Wait for the pending chunks, then flush the last incomplete character as a replacement character. */
	async flush(): Promise<void> {
		await this.#tail;
		const rest = this.#decoder.decode();
		if (rest !== "") await this.#sink({ stream: this.#name, text: rest });
	}
}

/**
 * Run a command over `ssh` using the workstation user's existing configuration, agent, ProxyJump, and host
 * verification. The command runs in a login-free environment with only the given variables, after the remote shell
 * confirmed that the working directory is inside the configured root.
 *
 * An SSH failure does not say whether the remote command ran: exit 255, a dropped connection, a timeout, and an abort
 * all report `outcome_unknown`, and nothing is retried.
 *
 * A master is given to the capability that wants one — installation and execution, which are one short `execute` per
 * step — and never added by default: the filesystem, workspace, worktree and terminal transports keep the user's own
 * SSH configuration untouched, and `open`, which carries a long-lived session, never rides a master either.
 */
export function createSystemSshRunner(master?: ManagedControlMaster): SshRunner {
	/** The connection settings every call of this transport shares. */
	const connection = (request: SshConnection) => sshConnectionArgs(request);
	return {
		open: (request) => {
			// No pseudo-terminal is allocated on the ssh side: the helper's frames are the transport, and the shell it
			// starts has the pseudoterminal the session is actually about. Nothing changes directory here: the program
			// does that itself, after it has canonicalized and confined the paths, so a directory the host does not have
			// is that program's own named refusal rather than a shell exit this side cannot tell from an unreachable host.
			const script = "exec " + request.command.map(quoteArg).join(" ");
			return spawn("ssh", [...connection(request), "--", request.host, script], { stdio: ["pipe", "pipe", "pipe"] });
		},
		execute: (request) =>
			new Promise((resolvePromise, rejectPromise) => {
				const script =
					"root=$(realpath -- " + quoteArg(request.root ?? request.cwd) + ") || exit 126; cd -- " + quoteArg(request.cwd) + " || exit 126; here=$(pwd -P); case \"$here/\" in \"$root/\"*) ;; *) exit 126 ;; esac; " +
					"exec env -i PATH=/usr/bin:/bin " +
					Object.entries(request.env ?? {}).map(([key, value]) => quoteArg(key + "=" + value)).join(" ") +
					" " +
					request.command.map(quoteArg).join(" ");
				// The managed options go on this spawn alone: a long-lived `open` session is never made to ride a master.
				const args = [...connection(request), ...(master === undefined ? [] : master.argsFor(request)), "--", request.host, script];
				const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				let settled = false;
				const pumps = request.onOutput === undefined
					? undefined
					: {
							stdout: new StreamPump(child.stdout!, "stdout", request.onOutput),
							stderr: new StreamPump(child.stderr!, "stderr", request.onOutput),
						};
				const finish = (result: SshRunnerResult | (Error & { code?: string })) => {
					if (settled) return;
					settled = true;
					result instanceof Error ? rejectPromise(result) : resolvePromise(result);
				};
				const timer = request.timeoutMs === undefined ? undefined : setTimeout(() => {
					child.kill("SIGTERM");
					finish(Object.assign(new Error("ssh timeout; remote outcome unknown"), { code: "outcome_unknown" as const }));
				}, request.timeoutMs);
				const abort = () => {
					child.kill("SIGTERM");
					finish(Object.assign(new Error("ssh aborted; remote outcome unknown"), { code: "outcome_unknown" as const }));
				};
				if (request.signal.aborted) abort();
				else request.signal.addEventListener("abort", abort, { once: true });
				const stop = () => {
					if (timer !== undefined) clearTimeout(timer);
					request.signal.removeEventListener("abort", abort);
				};
				const collect = (pump: StreamPump | undefined, target: "stdout" | "stderr") => (chunk: Buffer) => {
					if (pump !== undefined) pump.feed(chunk);
					else if (target === "stdout") stdout += chunk.toString("utf8");
					else stderr += chunk.toString("utf8");
				};
				child.stdout!.on("data", collect(pumps?.stdout, "stdout"));
				child.stderr!.on("data", collect(pumps?.stderr, "stderr"));
				child.on("error", (error) => {
					stop();
					finish(Object.assign(error, { code: "unreachable" as const }));
				});
				child.on("close", (code) => {
					stop();
					if (settled) return;
					// The last bytes may hold an incomplete character: flush it once the pending chunks have settled.
					void (async () => {
						await pumps?.stdout.flush();
						await pumps?.stderr.flush();
						if (settled) return;
						if (code === 0) finish({ stdout, stderr, exitCode: 0 });
						// 255 is ssh's own failure and a null code means it was killed: the remote command's fate is unknown.
						else if (code === 255 || code === null) finish(Object.assign(new Error("ssh outcome unknown"), { code: "outcome_unknown" as const }));
						else finish({ stdout, stderr, exitCode: code });
					})();
				});
			}),
	};
}
