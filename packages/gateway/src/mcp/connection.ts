import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { McpClient, StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import { McpOAuthProvider, adaptOAuthProvider, type McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type { McpScope } from "@hepi/protocol/gateway";
import { mcpAuthPath, oauthStoreKey } from "./config.ts";
import { createRedactor } from "./secrets.ts";

// One configured server, connected: the entry read from this host's own files, the values its env and headers
// reference resolved here, its OAuth state read from this host's own store, and the transport that reaches it.
//
// Both capabilities that run a server share this — a test that starts one to report what it found, and an invocation
// that runs one selected tool — so the two cannot disagree about which environment a server sees, which headers it is
// given, which credential store it uses, or how a caller's cancellation reaches the process. Nothing here decides what
// an operation answers; that stays with the operation.

/** How long one request to a server may take. */
export const MCP_REQUEST_TIMEOUT_MS = 15_000;
/** How long a `!command` value may take before the entry is refused. */
const COMMAND_VALUE_TIMEOUT_MS = 10_000;

/** The redirect URI used when a server's own config names none: a loopback address, never listened on here. */
const FALLBACK_REDIRECT_URL = "http://127.0.0.1/callback";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One template, in the SDK's own grammar: `$$` and `$!` are the escapes for a literal `$` and `!`, `${NAME}` and
 * `$NAME` are this host's environment, and everything else is used as written.
 *
 * The escapes are the half that matters to an imported configuration: the importer escapes a foreign literal's `$` and
 * leading `!` so the value arrives as text rather than as a command or an expansion, and this is the reader that turns
 * it back into the text the person pasted. A resolver that expanded `$NAME` inside an escaped literal would corrupt a
 * password containing a dollar sign, and one that left `$$` as written would hand the server two dollars.
 */
const CONFIG_VALUE_TEMPLATE = /\$([$!])|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Resolve one configured value the way the SDK's transport does before it connects: `${NAME}` and
 * `$NAME` read this host's environment, `!command` runs on this host and its trimmed stdout is the
 * value, and anything else is used as written.
 *
 * The caller's abort is threaded in, because this runs while the caller still has nothing to close: a
 * `!command` that would take ten seconds must not hold a cancelled request open for all ten, and the
 * reason a cancelled caller learns is {@link REFUSED_BEFORE_START} rather than an opaque abort.
 */
async function resolveValue(value: string, redactor: { add(value: string): void }, signal: AbortSignal | undefined): Promise<string> {
	if (signal?.aborted === true) throw new Error(REFUSED_BEFORE_START);
	if (value.startsWith("!")) {
		const command = value.slice(1);
		const output = await new Promise<string>((resolve, reject) => {
			execFile("/bin/sh", ["-c", command], { timeout: COMMAND_VALUE_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, stdout) => {
				if (error) reject(signal?.aborted === true ? new Error(REFUSED_BEFORE_START) : error);
				else resolve(stdout);
			});
		});
		const resolved = output.trim();
		redactor.add(resolved);
		return resolved;
	}
	const replaced = value.replace(CONFIG_VALUE_TEMPLATE, (_match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
		// An escape is the literal character, and nothing was resolved into it.
		if (escaped !== undefined) return escaped;
		const name = braced ?? bare ?? "";
		const resolved = process.env[name] ?? "";
		redactor.add(resolved);
		return resolved;
	});
	return replaced;
}

/** A value that is only a reference, so nothing was resolved into it and it is not a literal secret. */
function isReference(value: string): boolean {
	// `$$` and `$!` are the escapes for a literal `$` and `!`, never a reference — the same rule the importer escapes by.
	return value.startsWith("!") || /\$\{?[A-Za-z_]/.test(value.replace(/\$[$!]/g, "_x"));
}

export type Redactor = { add(value: string): void; redact(text: string): string };

/** The masking for one connection: the entry's literal secrets plus every value actually resolved. */
export function redactorFor(config: Record<string, unknown>): Redactor {
	const extra: string[] = [];
	const base = createRedactor(config, extra);
	return {
		add: (value: string) => {
			if (value !== "" && !isReference(value)) extra.push(value);
		},
		redact: (text: string) => createRedactor(config, extra)(text),
	};
}

/**
 * The resolved env of a stdio server, and the resolved headers of an HTTP one.
 *
 * Given the caller's abort, resolution stops with it instead of running every remaining `!command` to its own bound,
 * and throws {@link REFUSED_BEFORE_START} — a caller that is gone has nothing to wait for.
 */
export async function resolveConnectionValues(config: Record<string, unknown>, redactor: Redactor, signal?: AbortSignal): Promise<{ env: Record<string, string>; headers: Record<string, string> }> {
	const env: Record<string, string> = {};
	if (isRecord(config.env)) {
		for (const [name, value] of Object.entries(config.env)) {
			if (typeof value === "string") env[name] = await resolveValue(value, redactor, signal);
		}
	}
	const headers: Record<string, string> = {};
	if (isRecord(config.headers)) {
		for (const [name, value] of Object.entries(config.headers)) {
			if (typeof value === "string") headers[name] = await resolveValue(value, redactor, signal);
		}
	}
	return { env, headers };
}

/**
 * The per-server OAuth state in the host's `mcp-auth.json`, under the SDK's own key for the server,
 * written whole and atomically so a reader never sees a partial file. A save runs read, merge and rename
 * without yielding, so it cannot interleave with another save in this process.
 */
export class McpAuthStore {
	readonly #path: string;
	readonly #key: string;

	constructor(agentDir: string, name: string, url: string) {
		this.#path = mcpAuthPath(agentDir);
		this.#key = oauthStoreKey(name, url);
	}

	load(): McpOAuthState | undefined {
		return this.#read()[this.#key];
	}

	async save(state: McpOAuthState): Promise<void> {
		const records = this.#read();
		records[this.#key] = state;
		this.#write(records);
	}

	/** Remove everything stored for the server. True when the file held a record for it. */
	remove(): boolean {
		const records = this.#read();
		if (!(this.#key in records)) return false;
		delete records[this.#key];
		this.#write(records);
		return true;
	}

	#read(): Record<string, McpOAuthState> {
		if (!existsSync(this.#path)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
			return isRecord(parsed) ? (parsed as Record<string, McpOAuthState>) : {};
		} catch {
			return {};
		}
	}

	#write(records: Record<string, McpOAuthState>): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.#path);
	}
}

/** One configured server, as this host resolved it: its entry, the scope it came from, and the account that owns it. */
export type ServerTarget = { readonly name: string; readonly config: Record<string, unknown>; readonly scope: McpScope; readonly cwd?: string; readonly agentDir: string };

/** The redirect URI a server's own config names, else the fixed loopback address this host never listens on. */
export function redirectUrlOf(config: Record<string, unknown>): string {
	if (!isRecord(config.oauth)) return FALLBACK_REDIRECT_URL;
	const callbackUrl = config.oauth.callbackUrl;
	if (typeof callbackUrl === "string" && URL.canParse(callbackUrl)) return String(new URL(callbackUrl));
	const port = config.oauth.callbackPort;
	return typeof port === "number" ? `http://127.0.0.1:${port}/callback` : FALLBACK_REDIRECT_URL;
}

/** A fetch that adds the entry's resolved headers to every request the OAuth flow makes. */
export function fetchWithHeaders(headers: Record<string, string>): typeof fetch | undefined {
	if (Object.keys(headers).length === 0) return undefined;
	return (input, init) => fetch(input, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
}

/** One connected server: the client that speaks to it, its stderr so far, and the one way to end it. */
export type OpenConnection = { readonly client: McpClient; stderr(): string; close(): Promise<void> };

/**
 * What one connection attempt produced.
 *
 * A failure carries the server's own stderr, because that is what a caller has to show a person when a process would
 * not start: the reason it printed is the reason, and a transport that was closed again before returning would
 * otherwise take it with it.
 */
export type ConnectResult = { readonly ok: true; readonly connection: OpenConnection } | { readonly ok: false; readonly error: unknown; readonly stderr: string };

/**
 * Connect one configured server and hand back the client that reaches it.
 *
 * The caller's abort is the connection's: a caller that goes away — a revoked credential, a closed socket, an
 * invocation's deadline — closes the transport, so the process a call started does not outlive the request that
 * started it. {@link OpenConnection.close} removes that listener and closes the client, and is what every caller runs
 * in a `finally`; closing twice is safe, which is what makes "nothing is left running" checkable.
 *
 * The listener only reaches an abort that lands after it is attached, so the window before it is owned here as well:
 * value resolution runs first, is given the same signal, and the attempt is refused if the caller went away during it,
 * before any transport or process exists. A cancellation is never a way to have this host start a server for a caller
 * that already left.
 */
export async function connectServer(target: ServerTarget, auth: McpAuthStore | undefined, redactor: Redactor, signal: AbortSignal): Promise<ConnectResult> {
	// Resolution is part of the attempt, so what it throws is reported through the same channel as a server that would
	// not start: a failure with the caller's reason, and nothing started.
	let resolved: { env: Record<string, string>; headers: Record<string, string> };
	try {
		resolved = await resolveConnectionValues(target.config, redactor, signal);
	} catch (error) {
		return { ok: false, error, stderr: "" };
	}
	if (signal.aborted) return { ok: false, error: new Error(REFUSED_BEFORE_START), stderr: "" };
	const { env, headers } = resolved;
	const url = typeof target.config.url === "string" ? target.config.url : undefined;
	let transport: McpTransport;
	if (url !== undefined) {
		const provider = new McpOAuthProvider({
			serverUrl: url,
			redirectUrl: redirectUrlOf(target.config),
			clientMetadata: { client_name: "hepi Web host", redirect_uris: [redirectUrlOf(target.config)] },
			...(auth === undefined ? {} : { store: { load: () => auth.load(), save: (state) => storeUnlessCancelled(auth, state, signal) } }),
			onRedirect: () => {},
		});
		transport = new StreamableHttpTransport({ url, headers, authProvider: adaptOAuthProvider(provider), openGetStream: false });
	} else {
		transport = new StdioTransport({ command: String(target.config.command), args: Array.isArray(target.config.args) ? (target.config.args as string[]) : [], ...(typeof target.config.cwd === "string" ? { cwd: target.config.cwd } : {}), env, stderr: "pipe" });
	}
	const client = new McpClient({ name: "hepi-web-host", version: "0.1.0", requestTimeoutMs: MCP_REQUEST_TIMEOUT_MS });
	const onAbort = (): void => { void transport.close().catch(() => {}); };
	signal.addEventListener("abort", onAbort, { once: true });
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		signal.removeEventListener("abort", onAbort);
		await client.close().catch(() => {});
	};
	try {
		await client.connect(transport);
	} catch (error) {
		// The server's own words are read after it has exited, because a process that refuses to start says why and
		// then leaves: closing first is what lets its last stderr bytes arrive before this reads them.
		await close();
		const stderr = transport instanceof StdioTransport ? transport.stderr.trim() : "";
		return { ok: false, error, stderr };
	}
	return { ok: true, connection: { client, stderr: () => (transport instanceof StdioTransport ? transport.stderr.trim() : ""), close } };
}

/**
 * What a caller is told when the attempt ended before this host started anything for it.
 *
 * This is the words for the window before a transport exists — resolving a `!command` value, building the transport —
 * and, unlike {@link CANCELLED_BEFORE_STORE}, it is a claim this host can make: nothing was run, so there is no unknown
 * outcome to report. It is deliberately neutral about *why* the attempt ended, because any of the signals that reach
 * {@link connectServer} can land there: the caller going away, a deadline passing, or the host stopping.
 */
export const REFUSED_BEFORE_START = "the attempt ended while this host was still resolving the entry's values: no server was started, and nothing ran for it";

/** Whether a connection failure is exactly that refusal: thrown by this seam, so no transport and no process was ever made. */
export function isRefusedBeforeStart(error: unknown): boolean {
	return error instanceof Error && error.message === REFUSED_BEFORE_START;
}

/**
 * What a caller is told when it went away before this host stored what a flow produced.
 *
 * This is the commit point's own words, and they are deliberately about what did *not* happen here: the exchange with
 * the authorization server may well have completed before the caller left, so claiming the sign-in was undone would
 * be a claim this host cannot make. The outcome is unknown, and it is reported as unknown.
 */
export const CANCELLED_BEFORE_STORE = "the caller went away before this host stored the sign-in: the provider exchange may have completed, and nothing was stored here";

/**
 * Store what a flow produced, unless the caller is already gone.
 *
 * A revoked credential or a disconnected client aborts the request that started the work, and an OAuth exchange is
 * exactly the kind of work that outlives the request that asked for it: the provider may have already handed over
 * tokens. Refusing the write here is what keeps a credential for a revoked caller off this host — while leaving any
 * record this host did store earlier alone, because deleting it would be a rollback nothing here performed.
 */
export async function storeUnlessCancelled(auth: McpAuthStore, state: McpOAuthState, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted === true) throw new Error(CANCELLED_BEFORE_STORE);
	await auth.save(state);
}
