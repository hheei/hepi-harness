import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import { MCP_INVOKE_DEADLINE_MS, MCP_INVOKE_MAX_ARGUMENT_BYTES, MCP_INVOKE_MAX_DEADLINE_MS, MCP_INVOKE_MAX_RESULT_BYTES, type McpInvocationFailureCode, type McpToolCallOutcome, type McpToolCallRequest, type McpToolCallResult, type McpToolContent, type McpToolListFailureCode } from "@hepi/protocol/gateway";
import { McpAuthStore, REFUSED_BEFORE_START, connectServer, isRecord, isRefusedBeforeStart, message, redactorFor, type ServerTarget } from "./connection.ts";

/**
 * Invoking one already-selected MCP tool on the host that owns it.
 *
 * This is the Gateway half of a durable tool call: the Backend conversation lifecycle asks for one tool of one
 * configured server, and this runs it and answers with the result. Nothing here is a second configuration surface —
 * the entry is read from this host own files, the credential from this host own OAuth state, and the server
 * process is this host own — so a caller never sends, and never receives, MCP configuration or a credential.
 *
 * What a call may and may not say is the whole contract:
 *
 * - It names a **configured** server and **one** of its tools, plus the conversation and workspace it belongs to. It
 *   cannot name a command, an environment, a URL or a header; a request that carries one is refused rather than read.
 * - It is **bounded**: one call deadline, one result byte bound, and a fixed number of calls running at once. A call
 *   over the concurrency bound is refused as busy rather than queued behind an unbounded wait.
 * - Its **outcome is never silently repeated**. A deadline that passes and a caller that goes away both leave the
 *   server having possibly done something, so they answer timeout and cancelled — never a refusal a caller might
 *   read as "nothing happened".
 * - It **redacts**: every reported reason and every returned block is masked with the entry own secrets and the
 *   values resolved for it, because a server answer can quote the token it was given.
 */

/** How many calls this host runs at once, across every conversation and server. */
export const MCP_INVOKE_MAX_CONCURRENT = 8;

/**
 * What an invocation needs from the host that owns the servers.
 *
 * It is deliberately four facts and no capability: the account directory the credentials live in, the one configured
 * server a name resolves to, the calls this host is running, and the signal that says the host is stopping. Everything
 * else an invocation does — connecting, calling, masking, bounding — is this module own, so the host stays the owner of
 * configuration and this stays the owner of running one call.
 */
export type InvocationHost = {
	readonly agentDir: string;
	server(name: string, cwd: string | undefined): ServerTarget | { readonly refusal: string; readonly message: string };
	/** The calls running on this host, so the concurrency bound is this host own count rather than the process one. */
	readonly running: Set<string>;
	/** Aborted when the host stops, so no call outlives the service that started it. */
	readonly stopping: AbortSignal;
};

/**
 * What a refusal of one server entry becomes. A server that is not there, is invalid, or is switched off is refused
 * as itself: none of those is "the call failed", and none of them may be reported as a call that might have run.
 *
 * It is exported for {@link ./listing.ts}, which resolves an entry through the same host door and must answer about a
 * missing, invalid or untrusted entry with the same words a call does: one rule, named in one place. That is why the
 * value type is the intersection of the two vocabularies — every entry refusal is a name both a call and a listing
 * answers with, and a code only one of them has (`not-exposed, `busy) could not be written here by accident.
 */
export const SERVER_REFUSALS: Readonly<Record<string, McpInvocationFailureCode & McpToolListFailureCode>> = {
	"server-missing": "server-missing",
	"entry-not-object": "server-invalid",
	"server-invalid": "server-invalid",
	"project-untrusted": "not-authorized",
	"trust-unreadable": "not-authorized",
} as const;

/** A refusal the file reader names that has no invocation meaning of its own: the entry could not be read at all. */
export const READ_REFUSALS: ReadonlySet<string> = new Set(["unparsable", "invalid-shape", "file-too-large", "operation_failed"]);

/**
 * Whether this host will use one entry at all.
 *
 * A switched-off server is neither called nor listed, whatever an earlier selection recorded: the entry's own
 * `enabled` is the switch the host panel writes, and honouring it in both operations is what makes switching a server
 * off mean something. Shared with {@link ./listing.ts} so the two cannot disagree about what "off" means.
 */
export function entrySwitchedOff(config: Record<string, unknown>): boolean {
	return config.enabled === false;
}

/** The exposures this host understands, as the configuration validator spells them. */
const EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred", "direct", "hidden"]);

/**
 * How this host exposes one tool of one entry: the tool's own `toolExposure` when it names one, else the entry's.
 *
 * The two keys are the same vocabulary the host panel writes, and only `hidden` changes what may be called — the
 * others describe how a model-facing surface presents a tool, which is the Backend's business.
 *
 * `overridden` says which of the two answered, because a surface that shows a person a tool has to be able to tell
 * them "this one is marked on the tool" from "this is the server's own setting". This is the one exposure rule the host
 * has, so the listing ({@link ../mcp/listing.ts}) reads it from here rather than restating it: a listing that disagreed
 * with the call about what is hidden would be a listing a person could not trust.
 */
export function exposureOf(config: Record<string, unknown>, tool: string): { readonly exposure: string; readonly overridden: boolean } | undefined {
	if (isRecord(config.toolExposure)) {
		const own = config.toolExposure[tool];
		if (typeof own === "string" && EXPOSURES.has(own)) return { exposure: own, overridden: true };
	}
	return typeof config.exposure === "string" && EXPOSURES.has(config.exposure) ? { exposure: config.exposure, overridden: false } : undefined;
}

/** The bytes a value costs on the wire, as UTF-8. */
function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * The blocks of one result, cut to the output bound.
 *
 * A tool result is content a model reads, so text and image bytes pass through and everything else — audio, a
 * resource link, an embedded binary — becomes a short text statement that it was omitted. That is upstream own
 * conversion, kept because it is the shape a conversation can record; the cut is this host own, because a server
 * result is not a size a caller chose. Masking runs before measuring, so the bound is the bound of what is returned.
 */
function blocksOf(result: Pick<CallToolResult, "content" | "structuredContent">, redact: (text: string) => string): { readonly blocks: McpToolContent[]; readonly truncated: boolean } {
	const blocks: McpToolContent[] = [];
	let used = 0;
	for (const block of toLlmContent(result)) {
		if (block.type === "image") {
			// An image is kept whole or not at all: half of one is not an image, and the bytes are base64 already.
			if (used + block.data.length > MCP_INVOKE_MAX_RESULT_BYTES) return { blocks, truncated: true };
			used += block.data.length;
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			continue;
		}
		const text = redact(block.text);
		const cost = Buffer.byteLength(text, "utf8");
		if (used + cost <= MCP_INVOKE_MAX_RESULT_BYTES) {
			used += cost;
			blocks.push({ type: "text", text });
			continue;
		}
		// Text is cut where the bound is reached rather than dropped whole, so a caller still reads the beginning of
		// what the server said, and `truncated` is what says the rest exists.
		const room = MCP_INVOKE_MAX_RESULT_BYTES - used;
		const cut = Buffer.from(text, "utf8").subarray(0, Math.max(0, room)).toString("utf8");
		if (cut !== "") blocks.push({ type: "text", text: cut });
		return { blocks, truncated: true };
	}
	return { blocks, truncated: false };
}

/**
 * One invocation, answered as its own result.
 *
 * The deadline is composed with the caller own cancellation, so a revoked credential ends a running tool exactly as
 * the deadline does — and both are reported as what they are, because the server may have acted before either ended
 * the connection.
 */
export async function invokeTool(host: InvocationHost, request: McpToolCallRequest, signal?: AbortSignal): Promise<McpToolCallResult> {
	const started = Date.now();
	const refused = validate(request);
	if (refused !== undefined) return refused;

	const target = host.server(request.server, request.cwd);
	if ("refusal" in target) {
		const code = SERVER_REFUSALS[target.refusal] ?? (READ_REFUSALS.has(target.refusal) ? "operation_failed" : undefined);
		if (code === undefined) return { ok: false, code: "operation_failed", message: target.message };
		return { ok: false, code, message: target.message };
	}
	// A switched-off server is not invoked, whatever an earlier selection recorded: the entry own `enabled` is the
	// switch the host panel writes, and honouring it here is what makes switching a server off mean something.
	if (entrySwitchedOff(target.config)) return { ok: false, code: "server-disabled", message: `server "${target.name}" is switched off, so none of its tools is callable` };
	// Configured is not the same as exposed. The entry own `exposure`, and its per-tool `toolExposure`, are the host
	// statement that a server or one tool of it is hidden from model-facing surfaces, and a hidden tool is not
	// callable through this one either: otherwise "hidden" would mean only "not listed".
	if (exposureOf(target.config, request.tool)?.exposure === "hidden") return { ok: false, code: "not-exposed", message: `tool "${request.tool}" of server "${target.name}" is hidden by this host configuration` };

	const key = request.callId + "\u0000" + request.conversationId;
	if (host.running.has(key)) return { ok: false, code: "busy", message: "a call with this id is already running for this conversation" };
	if (host.running.size >= MCP_INVOKE_MAX_CONCURRENT) return { ok: false, code: "busy", message: `this host is already running ${MCP_INVOKE_MAX_CONCURRENT} MCP calls` };

	const redactor = redactorFor(target.config);
	const deadlineMs = Math.min(request.deadlineMs ?? MCP_INVOKE_DEADLINE_MS, MCP_INVOKE_MAX_DEADLINE_MS);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadlineMs);
	// The deadline is this call own; the caller abort is the caller own; the host stopping is the service own. Any one of
	// them ends the call, and the connection closes with it, so nothing keeps running after the reason it ran for is gone.
	const deadline = AbortSignal.any([controller.signal, host.stopping, ...(signal === undefined ? [] : [signal])]);
	const url = typeof target.config.url === "string" ? target.config.url : undefined;
	// A stdio server has no OAuth account, so the store is only built for a server that has a URL.
	const auth = url === undefined ? undefined : new McpAuthStore(host.agentDir, target.name, url);

	host.running.add(key);
	try {
		const opened = await connectServer(target, auth, redactor, deadline);
		if (!opened.ok) return failure(opened.error, { timedOut, caller: signal, redactor, stderr: opened.stderr });
		const connection = opened.connection;
		try {
			// The tool is looked up before it is called. A name the server does not list is refused by name here, so a
			// caller learns the tool is not there instead of receiving whatever a server makes of an unknown name, and
			// nothing is sent to the server that a selection could not have named.
			const listed = await connection.client.listTools({ signal: deadline, timeoutMs: deadlineMs });
			if (!listed.some((tool) => tool.name === request.tool)) return { ok: false, code: "unknown-tool", message: `server "${target.name}" lists no tool "${request.tool}"` };
			const result = await connection.client.callTool(request.tool, request.arguments ?? {}, { signal: deadline, timeoutMs: deadlineMs });
			const { blocks, truncated } = blocksOf(result, redactor.redact);
			return {
				ok: true,
				value: {
					callId: request.callId,
					server: target.name,
					tool: request.tool,
					content: blocks,
					isError: result.isError === true,
					truncated,
					durationMs: Date.now() - started,
				} satisfies McpToolCallOutcome,
			};
		} finally {
			await connection.close();
		}
	} catch (error) {
		return failure(error, { timedOut, caller: signal, redactor, stderr: "" });
	} finally {
		clearTimeout(timer);
		host.running.delete(key);
	}
}

/**
 * What a call that produced no result means, in the only three readings that matter: the caller went away, the
 * deadline passed, or the server itself failed. The first two leave the server having possibly acted, so neither is
 * ever spelled as a refusal; the third is the server own answer, masked.
 */
function failure(error: unknown, state: { readonly timedOut: boolean; readonly caller: AbortSignal | undefined; readonly redactor: { redact(text: string): string }; readonly stderr: string }): McpToolCallResult {
	// Resolution belongs to the attempt, so a caller or deadline that ends it mid-`!command` is the connection seam's
	// refusal: this host never built a transport or started a process, so nothing ran and no outcome is unknown. The
	// code stays what ended the call; only the claim is corrected — reporting "may have acted" here would make a call
	// that definitely did not run look like one that might have.
	const refusedBeforeStart = isRefusedBeforeStart(error);
	if (state.caller?.aborted === true) return { ok: false, code: "cancelled", message: refusedBeforeStart ? REFUSED_BEFORE_START : "the caller cancelled the call; the server may have acted before the connection ended" };
	if (state.timedOut) return { ok: false, code: "timeout", message: refusedBeforeStart ? REFUSED_BEFORE_START : "the call did not finish within its deadline; the server may have acted before the connection ended" };
	if (error instanceof McpOAuthAuthorizationRequiredError) return { ok: false, code: "needs-auth", message: "the server requires a sign-in, which this host does not have for it" };
	// A stdio server that would not start says why on its own stderr, and that is the useful part of the answer. The
	// words are the server's, so they are masked like every other reported reason.
	const detail = state.stderr === "" ? message(error) : message(error) + ": " + state.stderr;
	return { ok: false, code: "operation_failed", message: state.redactor.redact(detail).slice(0, 2000) };
}

/**
 * The keys a configuration entry has that no request on this route may carry, because carrying one would be one.
 *
 * Exported for {@link ./listing.ts}: a listing is not a call, but it is the same rule about who owns a configuration,
 * and a second list of those keys is a list that can drift.
 */
export const CONFIGURATION_KEYS = ["config", "command", "args", "env", "url", "headers", "auth"] as const;

/**
 * The request own shape, checked before anything is read or started.
 *
 * This is where an invocation differs from a configuration operation: the caller may not send a configuration. A body
 * carrying config, command, args, env, url, headers or auth is refused by name, so a request can never be a way to
 * have this host run something the selection did not name — and the check runs on the raw body the route read, not
 * only on the fields this service own type mentions.
 */
function validate(request: McpToolCallRequest): McpToolCallResult | undefined {
	const body = request as unknown as Record<string, unknown>;
	const forbidden = CONFIGURATION_KEYS.filter((key) => key in body);
	if (forbidden.length > 0) return { ok: false, code: "invalid_request", message: "an invocation names a configured server and tool, not configuration: " + forbidden.join(", ") };
	for (const field of ["callId", "conversationId", "server", "tool"] as const) {
		const value = body[field];
		if (typeof value !== "string" || value.trim() === "") return { ok: false, code: "invalid_request", message: "an invocation needs a " + field };
	}
	if (body.scope !== "global" && body.scope !== "project") return { ok: false, code: "invalid_request", message: 'scope must be "global" or "project"' };
	if (body.scope === "project" && (body.cwd === undefined || body.cwd === "")) return { ok: false, code: "invalid_request", message: "a project-scoped invocation names the folder it applies to: cwd or workspaceId" };
	if (body.deadlineMs !== undefined && (typeof body.deadlineMs !== "number" || !Number.isFinite(body.deadlineMs) || body.deadlineMs <= 0)) return { ok: false, code: "invalid_request", message: "deadlineMs must be a positive number of milliseconds" };
	if (body.arguments !== undefined && !isRecord(body.arguments)) return { ok: false, code: "invalid_request", message: "arguments must be an object" };
	if (body.arguments !== undefined && bytesOf(body.arguments) > MCP_INVOKE_MAX_ARGUMENT_BYTES) return { ok: false, code: "arguments-too-large", message: `the arguments exceed ${MCP_INVOKE_MAX_ARGUMENT_BYTES} bytes` };
	return undefined;
}

