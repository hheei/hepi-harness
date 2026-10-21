import { DatabaseSync } from "node:sqlite";
import type { ShellOutputSkip, ShellOutputWindow } from "@earendil-works/pi-durable/env";

/** One decoded chunk of a running command's output. `skipped` counts output omitted immediately before it. */
export type OutputChunk = { readonly stream: "stdout" | "stderr"; readonly text: string; readonly skipped?: ShellOutputSkip };

/**
 * Where a gateway sends a running command's output. Returning a promise holds the next chunk back until it settles, so
 * a sink that commits progress before answering keeps the command from outrunning its consumer. A runner that owns the
 * process, like the SSH one, pauses its streams while the returned promise is pending; `NodeExecutionEnv` does not wait
 * for its callback, so the local path cannot be paced that way.
 */
export type OutputSink = (chunk: OutputChunk) => void | Promise<void>;

/** Output limits a caller passes through to the environment that runs the command. */
export type ShellLimits = {
	readonly spill?: { readonly afterBytes: number; readonly afterLines: number };
	readonly window?: ShellOutputWindow;
};

export type ExecuteFailureCode =
	| "gateway_offline"
	| "ssh_unreachable"
	| "unauthorized"
	| "unknown_gateway"
	| "unknown_workspace"
	| "path_denied"
	| "command_denied"
	| "invalid_request"
	| "timeout"
	| "aborted"
	| "outcome-unknown"
	| "execution_failed";

export type ExecuteRequest = {
	readonly gatewayId: string;
	readonly workspaceId: string;
	/** Durable call ID: the identity of one execution. The same ID is never run twice by one gateway. */
	readonly callId: string;
	readonly cwd?: string;
	readonly command: readonly string[];
	readonly timeoutMs?: number;
	readonly env?: Record<string, string>;
	/** Ask the environment to spill the complete output to a file past these thresholds. Only local execution can. */
	readonly spill?: ShellLimits["spill"];
	/** Ask the environment to keep only this tail and to report what it omitted. */
	readonly window?: ShellOutputWindow;
};

export type ExecuteResult =
	| {
			readonly ok: true;
			readonly gatewayId: string;
			readonly workspaceId: string;
			readonly callId: string;
			readonly stdout: string;
			readonly stderr: string;
			readonly exitCode: number;
			/** Path of the complete output, when the environment spilled it. Only local execution can report one. */
			readonly spillPath?: string;
			/**
			 * The request asked for a spill file and this transport cannot write one the caller can read. The output is
			 * still streamed in full; only the preserved copy is missing, so this is a warning, not a failure.
			 */
			readonly spillUnsupported?: true;
			/** `stdout`/`stderr` are not the complete output and no spill file preserves the rest. */
			readonly truncated?: true;
	  }
	| {
			readonly ok: false;
			readonly code: ExecuteFailureCode;
			readonly callId?: string;
			readonly message?: string;
			/** Complete output preserved before the failure, when the environment spilled it. */
			readonly spillPath?: string;
	  };

/** What a gateway records about a call it will not run again. The ids are the request's, so they are not stored twice. */
export type LedgerOutcome =
	| { readonly ok: true; readonly exitCode: number; readonly spillPath?: string; readonly truncated?: true; readonly spillUnsupported?: true }
	| { readonly ok: false; readonly code: ExecuteFailureCode; readonly message?: string; readonly spillPath?: string };

/**
 * Whether a body states a call at all: the fields every gateway reads before its ledger is asked, and nothing more.
 *
 * The rest of a request — whether the workspace, the cwd or the command are this gateway's to serve — is the gateway's
 * own validation, so this predicate is the wire's shape and stays the protocol's, beside the frames it arrives in.
 */
export function validExecuteRequest(value: unknown): value is ExecuteRequest {
	const r = value as ExecuteRequest;
	return !!r && typeof r === "object" && typeof r.gatewayId === "string" && typeof r.workspaceId === "string" && typeof r.callId === "string" && !!r.callId.trim() && Array.isArray(r.command) && r.command.length > 0 && r.command.every((c) => typeof c === "string" && !c.includes("\0")) && (r.cwd === undefined || typeof r.cwd === "string") && (r.timeoutMs === undefined || (Number.isFinite(r.timeoutMs) && r.timeoutMs >= 0));
}

/** One frame of the streaming execute protocol: newline-delimited JSON, output frames then exactly one result frame. */
export type ExecuteFrame =
	| { readonly type: "output"; readonly stream: "stdout" | "stderr"; readonly text: string; readonly skipped?: ShellOutputSkip }
	| { readonly type: "result"; readonly result: ExecuteResult };

export function encodeFrame(frame: ExecuteFrame): string {
	return JSON.stringify(frame) + "\n";
}

/** Split complete NDJSON lines off `buffer`, returning the frames and the unterminated remainder. */
export function parseFrames(buffer: string): { frames: ExecuteFrame[]; rest: string } {
	const frames: ExecuteFrame[] = [];
	let rest = buffer;
	let boundary = rest.indexOf("\n");
	while (boundary >= 0) {
		const line = rest.slice(0, boundary);
		rest = rest.slice(boundary + 1);
		if (line.trim() !== "") {
      const frame = JSON.parse(line);
      if (!frame || (frame.type !== "output" && frame.type !== "result")) throw new Error("invalid gateway frame");
      if (frame.type === "output" && (!["stdout", "stderr"].includes(frame.stream) || typeof frame.text !== "string")) throw new Error("invalid output frame");
      if (frame.type === "result" && (!frame.result || typeof frame.result.ok !== "boolean" || (frame.result.ok ? typeof frame.result.exitCode !== "number" || typeof frame.result.stdout !== "string" || typeof frame.result.stderr !== "string" : typeof frame.result.code !== "string"))) throw new Error("invalid result frame");
      frames.push(frame as ExecuteFrame);
    }
		boundary = rest.indexOf("\n");
	}
	return { frames, rest };
}

/**
 * How many bytes of `bytes` fit inside `budget` without splitting the character that straddles the edge: a cut at a
 * continuation byte would decode as U+FFFD, so the last complete character is where the retained text ends.
 */
function completeCharacters(bytes: Buffer, budget: number): number {
	let end = Math.min(budget, bytes.length);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return end;
}

/** Keep at most `maxBytes` of the head: the first output a caller would have seen, ending on a complete character. */
export function capOutput(text: string, maxBytes: number): { readonly text: string; readonly clipped: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return { text, clipped: false };
	return { text: bytes.subarray(0, completeCharacters(bytes, maxBytes)).toString("utf8"), clipped: true };
}

/**
 * One stream's captured output: the chunks as they arrived, the UTF-8 bytes they retain, and whether the bound cut them.
 *
 * Appending measures only the text it is given, so a command that writes very many small chunks costs what it wrote
 * rather than the size of everything retained so far, and the retained text is joined once, when the call ends. The
 * bound is on retained UTF-8 bytes and a cut lands on a complete character, so the answer a repeated call reads back is
 * never a broken one. The whole of it is one stream's own: stdout and stderr are separate captures with separate limits.
 */
export class OutputCapture {
	readonly #limit: number;
	readonly #chunks: string[] = [];
	#bytes = 0;
	#clipped = false;
	#joined: string | undefined;

	constructor(limit: number) {
		this.#limit = limit;
	}

	/** Keep what fits of `text`; anything past the bound is dropped and reported through {@link clipped}. */
	append(text: string): void {
		// Whatever was joined before is about to be out of date.
		this.#joined = undefined;
		if (this.#bytes >= this.#limit) {
			this.#clipped = true;
			return;
		}
		const bytes = Buffer.from(text, "utf8");
		if (this.#bytes + bytes.length <= this.#limit) {
			this.#chunks.push(text);
			this.#bytes += bytes.length;
			return;
		}
		this.#clipped = true;
		this.#chunks.push(bytes.subarray(0, completeCharacters(bytes, this.#limit - this.#bytes)).toString("utf8"));
		// The retained text is what a caller reads back; a later chunk is past the bound whether or not the cut left a
		// character's worth of room, so nothing more is appended and every further chunk is reported as clipped.
		this.#bytes = this.#limit;
	}

	/** Whether anything was dropped: the call's `truncated` fact, unless a spill file preserved the whole output. */
	get clipped(): boolean {
		return this.#clipped;
	}

	/** The retained output, joined once. */
	text(): string {
		return (this.#joined ??= this.#chunks.join(""));
	}
}

/** The output a call produced, per stream, so a repeated call can be answered without running it again. */
export type LedgerOutput = { readonly stdout: string; readonly stderr: string };

export type LedgerEntry = {
	readonly state: "admitted" | "dispatched" | "completed" | "outcome-unknown";
	readonly outcome?: LedgerOutcome;
	/** The head of the output the call produced; the outcome says whether the rest was dropped. */
	readonly output: LedgerOutput;
	/** The request the call ID was first used for, so the same ID with a different request is refused, not answered. */
	readonly fingerprint: string;
};

/**
 * What a gateway knows about the call IDs it has seen, and the only thing that decides whether a call may run.
 *
 * It answers one question: may this call ID run again? Never for a call this gateway already admitted or dispatched,
 * because the outcome of a command it no longer runs is unknown, not absent. A row left `admitted` or `dispatched`
 * when the process starts is therefore `outcome-unknown`, and the gateway reports that instead of re-executing.
 *
 * Call IDs are model-generated and repeat across conversations, so the key a gateway passes here is scoped to the
 * workspace, and the fingerprint pins the request the ID was used for.
 *
 * This is duplicate protection, not recovery: it does not resume, replay, or reconcile a call.
 */
export interface ExecutionLedger {
	/** Record a call as admitted. False when this gateway already knows the call ID and must not run it again. */
	begin(callId: string, fingerprint: string): boolean;
	dispatch(callId: string): void;
	complete(callId: string, outcome: LedgerOutcome, output: LedgerOutput): void;
	/**
	 * Refuse a call before it is admitted, for an abort that arrived first. False when the call is already known, which
	 * means it is running or answered and the abort belongs to the running process instead.
	 */
	refuse(callId: string, fingerprint: string, outcome: LedgerOutcome): boolean;
	lookup(callId: string): LedgerEntry | undefined;
	close(): void;
}

/** Note that stored output was cut short, so a repeated call's answer is not mistaken for the complete output. */
function noteClipping(outcome: LedgerOutcome, clipped: boolean): LedgerOutcome {
	return clipped && outcome.ok ? { ...outcome, truncated: true } : outcome;
}

/** A ledger for a gateway that is not given a database path: it forgets every call when the process ends. */
export class MemoryLedger implements ExecutionLedger {
	readonly #entries = new Map<string, LedgerEntry>();
	readonly #maxEntries: number;
	readonly #maxBytes: number;

	constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
		this.#maxEntries = options.maxEntries ?? 1000;
		this.#maxBytes = options.maxBytes ?? 1024 * 1024;
	}

	begin(callId: string, fingerprint: string): boolean {
		if (this.#entries.has(callId)) return false;
		if (this.#entries.size >= this.#maxEntries) {
			// Evict an answered call only: a call still admitted or dispatched is what keeps it from running twice.
			for (const [key, entry] of this.#entries) {
				if (entry.state === "completed") {
					this.#entries.set(key, { ...entry, state: "outcome-unknown", outcome: { ok: false, code: "outcome-unknown", message: "retained output expired; call will not be replayed" }, output: { stdout: "", stderr: "" } });
					break;
				}
			}
		}
		this.#entries.set(callId, { state: "admitted", output: { stdout: "", stderr: "" }, fingerprint });
		return true;
	}

	dispatch(callId: string): void {
		const entry = this.#entries.get(callId);
		if (entry !== undefined) this.#entries.set(callId, { ...entry, state: "dispatched" });
	}

	complete(callId: string, outcome: LedgerOutcome, output: LedgerOutput): void {
		const stdout = capOutput(output.stdout, this.#maxBytes);
		const stderr = capOutput(output.stderr, this.#maxBytes);
		this.#entries.set(callId, {
			state: "completed",
			outcome: noteClipping(outcome, stdout.clipped || stderr.clipped),
			output: { stdout: stdout.text, stderr: stderr.text },
			// The request the ID was admitted for stays on the record: it is what a repeated ID is checked against.
			fingerprint: this.#entries.get(callId)?.fingerprint ?? "",
		});
	}

	refuse(callId: string, fingerprint: string, outcome: LedgerOutcome): boolean {
		if (this.#entries.has(callId)) return false;
		this.#entries.set(callId, { state: "completed", outcome, output: { stdout: "", stderr: "" }, fingerprint });
		return true;
	}

	lookup(callId: string): LedgerEntry | undefined {
		return this.#entries.get(callId);
	}

	close(): void {
		this.#entries.clear();
	}
}

export type GatewayExecutionJournalOptions = { readonly path: string; readonly maxBytes?: number; readonly maxCalls?: number };

/**
 * The same ledger over SQLite, so it survives the gateway process.
 *
 * A row left `admitted` or `dispatched` when the process starts is `outcome-unknown`: the command may or may not have
 * run, and the gateway says so instead of running it again. Output retention is bounded by `maxBytes` per stream and `maxCalls` completed payloads.
 * Expired rows remain small outcome-unknown tombstones so old call IDs cannot be replayed. Identity storage grows with calls.
 */
export class GatewayExecutionJournal implements ExecutionLedger {
	readonly #db: DatabaseSync;
	readonly #maxBytes: number;
	readonly #maxCalls: number;

	constructor(options: GatewayExecutionJournalOptions) {
		this.#maxBytes = options.maxBytes ?? 1024 * 1024;
		this.#maxCalls = options.maxCalls ?? 1000;
		this.#db = new DatabaseSync(options.path);
		this.#db.exec("PRAGMA journal_mode = WAL");
		this.#db.exec("CREATE TABLE IF NOT EXISTS gateway_call (call_id TEXT PRIMARY KEY, state TEXT NOT NULL, outcome TEXT, stdout TEXT, stderr TEXT, fingerprint TEXT NOT NULL DEFAULT '', updated_ms INTEGER NOT NULL)");
		// A journal written before the fingerprint existed keeps working: the missing column is added, and its empty
		// value never matches a request, so such a call is refused rather than answered with another request's output.
		try {
			this.#db.exec("ALTER TABLE gateway_call ADD COLUMN fingerprint TEXT NOT NULL DEFAULT ''");
		} catch {
			/* already present */
		}
		this.#db
			.prepare("UPDATE gateway_call SET state = 'outcome-unknown', outcome = ?, updated_ms = ? WHERE state IN ('admitted','dispatched')")
			.run(JSON.stringify({ ok: false, code: "outcome-unknown", message: "gateway restarted while the call was running" } satisfies LedgerOutcome), Date.now());
		this.#prune();
	}

	begin(callId: string, fingerprint: string): boolean {
		return this.#db.prepare("INSERT OR IGNORE INTO gateway_call (call_id, state, fingerprint, updated_ms) VALUES (?, 'admitted', ?, ?)").run(callId, fingerprint, Date.now()).changes === 1;
	}

	dispatch(callId: string): void {
		this.#db.prepare("UPDATE gateway_call SET state = 'dispatched', updated_ms = ? WHERE call_id = ? AND state = 'admitted'").run(Date.now(), callId);
	}

	complete(callId: string, outcome: LedgerOutcome, output: LedgerOutput): void {
		const stdout = capOutput(output.stdout, this.#maxBytes);
		const stderr = capOutput(output.stderr, this.#maxBytes);
		this.#db
			.prepare("UPDATE gateway_call SET state = 'completed', outcome = ?, stdout = ?, stderr = ?, updated_ms = ? WHERE call_id = ?")
			.run(JSON.stringify(noteClipping(outcome, stdout.clipped || stderr.clipped)), stdout.text, stderr.text, Date.now(), callId);
		// Pruning only at open would let a long-lived gateway grow without bound; it costs one indexed delete per call.
		this.#prune();
	}

	refuse(callId: string, fingerprint: string, outcome: LedgerOutcome): boolean {
		return this.#db
			.prepare("INSERT OR IGNORE INTO gateway_call (call_id, state, outcome, fingerprint, updated_ms) VALUES (?, 'completed', ?, ?, ?)")
			.run(callId, JSON.stringify(outcome), fingerprint, Date.now()).changes === 1;
	}

	lookup(callId: string): LedgerEntry | undefined {
		const row = this.#db.prepare("SELECT state, outcome, stdout, stderr, fingerprint FROM gateway_call WHERE call_id = ?").get(callId) as
			| { state: LedgerEntry["state"]; outcome: string | null; stdout: string | null; stderr: string | null; fingerprint: string }
			| undefined;
		if (row === undefined) return undefined;
		return {
			state: row.state,
			...(row.outcome === null ? {} : { outcome: JSON.parse(row.outcome) as LedgerOutcome }),
			output: { stdout: row.stdout ?? "", stderr: row.stderr ?? "" },
			fingerprint: row.fingerprint,
		};
	}

	#prune(): void {
		this.#db
			.prepare("UPDATE gateway_call SET state = 'outcome-unknown', outcome = ?, stdout = NULL, stderr = NULL WHERE state = 'completed' AND call_id NOT IN (SELECT call_id FROM gateway_call WHERE state = 'completed' ORDER BY updated_ms DESC LIMIT ?)")
			.run(JSON.stringify({ ok: false, code: "outcome-unknown", message: "retained output expired; call will not be replayed" }), this.#maxCalls);
	}

	close(): void {
		this.#db.close();
	}
}
