import { McpOAuthAuthorizationRequiredError } from "@earendil-works/pi-mcp/oauth";
import {
	MCP_LIST_DEADLINE_MS,
	MCP_LIST_MAX_PAGES,
	MCP_LIST_MAX_RESPONSE_BYTES,
	MCP_LIST_MAX_SCHEMA_BYTES,
	MCP_LIST_MAX_TEXT_CHARS,
	MCP_LIST_MAX_TOOLS,
	type McpToolDescriptor,
	type McpToolList,
	type McpToolListFailureCode,
	type McpToolListRequest,
	type McpToolListResult,
} from "@hepi/protocol/gateway";
import {
	McpAuthStore,
	REFUSED_BEFORE_START,
	connectServer,
	isRecord,
	isRefusedBeforeStart,
	message,
	redactorFor,
	type Redactor,
	type ServerTarget,
} from "./connection.ts";
import { CONFIGURATION_KEYS, READ_REFUSALS, SERVER_REFUSALS, entrySwitchedOff, exposureOf } from "./invocation.ts";

/**
 * The listing half of the MCP route: what one configured server's tools are, as that server itself answers.
 *
 * A gateway owns an MCP server's configuration, its resolved values and its credentials, so it is also the only process
 * that can answer what the server has. Everything that answers that here is already true of a test and of a call: the
 * same entry door (`#target`, which is where a project folder's trust decision is enforced), the same connection
 * (`connectServer`, so the same environment, headers, OAuth store and abort handling), the same masking (`redactorFor`,
 * which holds the entry's literals and every value a `${NAME}` or a `!command` resolved), and the same deadline shape.
 * What a test throws away — the names and schemas pi-mcp hands back, of which it keeps only a count — is what this
 * answers with, bounded and masked, because a tool list is a document a server authors about itself.
 *
 * What is deliberately not here:
 *
 * - No configuration, ever. Like an invocation, a request names a server and nothing else; a body carrying a command,
 *   an environment, a URL or a credential is refused by name before this host reads a file or starts a process.
 * - No listing to render an unrelated setting. `read` answers from the host's own files without touching a server, and
 *   this operation is the one a person asks when they want to see one named server's tools. It changes nothing a
 *   repetition could duplicate, which is why `control.ts` does not name it a mutation and a lost answer is a transport
 *   failure rather than an unknown outcome.
 * - No claim about a conversation. Whether one may call a tool is the Backend's selection plus the host's own `enabled`
 *   and exposure rules at call time; this only says what the server said.
 */

/** The one MCP method this operation is a request for. */
const LIST_METHOD = "tools/list";

/** What a listing needs from the host that owns the servers: the entry, the account, and whether this host is stopping. */
export type ListingHost = {
	readonly agentDir: string;
	/** One configured server, resolved exactly as a call and a test resolve it, refusal named as the host named it. */
	server(name: string, cwd: string | undefined): ServerTarget | { readonly refusal: string; readonly message: string };
	/** Aborted when the host stops, so a listing does not outlive the service that started the server it is reading. */
	readonly stopping: AbortSignal;
};

/** A refusal, before or without a connection. */
function refused(code: McpToolListFailureCode, text: string): McpToolListResult {
	return { ok: false, code, message: text };
}

/**
 * The request's own shape, checked before this host reads a file or starts a process.
 *
 * `config`, `command` and the rest of {@link CONFIGURATION_KEYS} are refused by the invocation's rule rather than a copy
 * of it: a listing has no business being a way to have this host connect something nobody configured. The check runs on
 * the raw body the route read, so a field this module's own type does not mention cannot slip through.
 */
function validate(request: McpToolListRequest): McpToolListResult | undefined {
	const body = request as unknown as Record<string, unknown>;
	const forbidden = CONFIGURATION_KEYS.filter((key) => key in body);
	if (forbidden.length > 0) return refused("invalid_request", "a listing names a configured server, not configuration: " + forbidden.join(", "));
	if (typeof body.name !== "string" || body.name.trim() === "") return refused("invalid_request", "a listing needs a server name");
	if (body.scope !== "global" && body.scope !== "project") return refused("invalid_request", 'scope must be "global" or "project"');
	if (body.scope === "project" && (body.cwd === undefined || body.cwd === "")) return refused("invalid_request", "a project-scoped listing names the folder it applies to");
	return undefined;
}

/** One page of a server's `tools/list`, read from the client directly rather than through its `listTools()`. */
type ListPage = { readonly tools?: unknown; readonly nextCursor?: unknown };

/**
 * The pages one listing is willing to read, and whether it stopped before the server finished.
 *
 * `client.listTools()` follows every cursor it is given, up to a thousand pages, inside one deadline. That is right for
 * a client that wants the whole list and wrong for a host that bounds what one request may cost: a server that
 * paginates with one tool per page could otherwise hold this host — and the process it started — for a thousand round
 * trips. So this reads at most {@link MCP_LIST_MAX_PAGES} pages, stops as soon as it has read enough to fill its own
 * answer, and says that it stopped rather than pretending the list ended.
 */
async function readPages(client: { request<Result = unknown>(method: string, params?: Record<string, unknown>, options?: { readonly signal?: AbortSignal }): Promise<Result> }, signal: AbortSignal): Promise<{ readonly items: readonly unknown[]; readonly pages: number; readonly stopped: boolean }> {
	const items: unknown[] = [];
	let cursor: string | undefined;
	let pages = 0;
	let stopped = false;
	while (true) {
		const page = await client.request<ListPage>(LIST_METHOD, cursor === undefined ? {} : { cursor }, { signal });
		if (!isRecord(page) || !Array.isArray(page.tools)) throw new Error(LIST_METHOD + " answered with no tools array");
		items.push(...page.tools);
		pages++;
		const next = page.nextCursor;
		if (typeof next !== "string" || next === "") break;
		if (next === cursor) throw new Error(LIST_METHOD + " repeated the cursor it was given");
		cursor = next;
		if (pages >= MCP_LIST_MAX_PAGES || items.length >= MCP_LIST_MAX_TOOLS) { stopped = true; break; }
	}
	return { items, pages, stopped };
}

/** The first non-empty line of server-authored text, or nothing when there is no line to show. */
function firstLine(value: unknown): string {
	if (typeof value !== "string") return "";
	const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
	return line === undefined ? "" : line;
}

/** Cut to a character bound at a safe boundary, with the ellipsis that says the rest exists. */
function clip(value: string, chars: number): { readonly text: string; readonly clipped: boolean } {
	if (value.length <= chars) return { text: value, clipped: false };
	return { text: value.slice(0, Math.max(0, chars - 1)) + "\u2026", clipped: true };
}

/**
 * One tool as its own server described it, for a surface that shows it to a person.
 *
 * pi-mcp validates only `name` and `inputSchema` on the way to this, so every other field is arbitrary server bytes and
 * is read by type, never by assumption: a number where a description should be becomes no description, an `annotations`
 * that is a string is not touched, and a name that is not a usable string means this is not a tool to describe. A
 * description falls back to the server's `title`, the way upstream's own panel presents one tool. `readOnly` is
 * `readOnlyHint === true` and nothing else, because an absent annotation is unknown, not a promise that a tool is safe.
 * Masking runs before clipping, so a bound is a bound of what a caller receives and a server cannot put its own token
 * past a cut. A schema over {@link MCP_LIST_MAX_SCHEMA_BYTES} is withheld rather than sent in pieces: half of an
 * argument shape invites a call that cannot be validated, and the descriptor says it was cut.
 */
function describeTool(tool: unknown, config: Record<string, unknown>, redact: Redactor): McpToolDescriptor | undefined {
	if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.trim() === "") return undefined;
	const described = firstLine(tool.description) === "" ? firstLine(tool.title) : firstLine(tool.description);
	const name = clip(redact.redact(tool.name), MCP_LIST_MAX_TEXT_CHARS);
	const description = clip(described === "" ? "" : redact.redact(described), MCP_LIST_MAX_TEXT_CHARS);
	const annotations = isRecord(tool.annotations) ? tool.annotations : {};
	const stated = exposureOf(config, tool.name);
	const entry: { -readonly [K in keyof McpToolDescriptor]: McpToolDescriptor[K] } = { name: name.text };
	let cut = name.clipped || description.clipped;
	if (description.text !== "") entry.description = description.text;
	if (annotations.readOnlyHint === true) entry.readOnly = true;
	if (stated !== undefined) {
		entry.exposure = stated.exposure;
		if (stated.overridden) entry.exposureOverridden = true;
	}
	const schema = isRecord(tool.inputSchema) ? JSON.stringify(tool.inputSchema) : "";
	if (schema !== "" && Buffer.byteLength(schema, "utf8") <= MCP_LIST_MAX_SCHEMA_BYTES) entry.inputSchema = JSON.parse(schema) as Record<string, unknown>;
	else cut = true;
	if (cut) entry.truncated = true;
	return entry;
}

/** The bytes one answer costs on the wire, as the caller will read it. */
function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * The descriptors this answer can carry, and the truth about what it left out.
 *
 * Two bounds are the host's and neither is a server's choice: how many tools one answer describes
 * ({@link MCP_LIST_MAX_TOOLS}) and how many bytes it costs ({@link MCP_LIST_MAX_RESPONSE_BYTES}). Both cut from the end
 * in the order the server listed, so an answer is always a prefix of what was read, never a selection of it, and
 * `total` keeps counting the items that were read even after the answer stopped carrying them. A gateway caps a
 * request body and puts no total cap of its own on a JSON answer, so without this bound one server's own list of
 * hundred-byte schemas would be a document of that server's choosing.
 */
function carried(items: readonly unknown[], base: Omit<McpToolList, "tools" | "total">, config: Record<string, unknown>, redact: Redactor): McpToolListResult {
	const tools: McpToolDescriptor[] = [];
	// Measured against the widest answer this walk can end up producing — every item counted, and the cut stated — so
	// the bound is the bound of the document actually sent rather than of one whose two fields are a digit shorter.
	let used = bytesOf({ ok: true, value: { ...base, tools: [], total: items.length, truncated: true } });
	let listed = 0;
	// `base.truncated` is the read's own cut (a page bound) and says nothing about how many
	// descriptors this answer can carry, so it must not stop the walk over the items already read.
	let cut = false;
	let undescribable = false;
	for (const item of items) {
		listed++;
		if (cut) continue;
		if (tools.length >= MCP_LIST_MAX_TOOLS) { cut = true; continue; }
		const described = describeTool(item, config, redact);
		// A tool the server did not name cannot be shown or selected, so it is not carried. The answer says it is
		// incomplete rather than letting one fewer tool look like the server's own count.
		if (described === undefined) { undescribable = true; continue; }
		const cost = bytesOf(described) + 1;
		if (used + cost > MCP_LIST_MAX_RESPONSE_BYTES) { cut = true; continue; }
		used += cost;
		tools.push(described);
	}
	return { ok: true, value: { ...base, tools, total: listed, truncated: cut || undescribable || base.truncated } };
}

/**
 * What a listing that produced no tools means, in the only readings that matter.
 *
 * A listing runs no tool and writes nothing, so — unlike a call whose server may have acted — a cancelled or timed-out
 * read is named as what happened and is worth asking for again. The one exception runs the other way: an attempt that
 * ended while this host was still resolving the entry's values built no transport and started no process, and says so
 * with those words rather than a claim about a server it never reached.
 */
function failure(error: unknown, state: { readonly timedOut: boolean; readonly caller: AbortSignal | undefined; readonly stopping: AbortSignal; readonly redactor: Redactor; readonly stderr: string }): McpToolListResult {
	const beforeStart = isRefusedBeforeStart(error);
	if (state.caller?.aborted === true) return refused("cancelled", beforeStart ? REFUSED_BEFORE_START : "the caller cancelled the listing; no server was started, and nothing ran for it");
	if (state.timedOut) return refused("timeout", beforeStart ? REFUSED_BEFORE_START : "the server did not answer the listing within its deadline; nothing was changed on this host");
	// This service stopping ends every operation it started, and says which of the two it was: a listing cut short by
	// its own host is not a server that refused to answer.
	if (state.stopping.aborted) return refused("cancelled", "this host service stopped, which ended the listing; nothing was changed on it");
	if (error instanceof McpOAuthAuthorizationRequiredError) return refused("needs-auth", "the server requires a sign-in, which this host does not have for it");
	const detail = state.stderr === "" ? message(error) : message(error) + ": " + state.stderr;
	return refused("operation_failed", state.redactor.redact(detail).slice(0, 2_000));
}

/**
 * List one configured server's tools, on the host that owns it.
 *
 * The deadline is composed with the caller's abort and with this host stopping, so a revoked credential or a stopping
 * service ends the connection this operation opened, and the connection is closed in a `finally` whatever happened:
 * a listing has no reason to leave a server running once it has asked what it has.
 */
export async function listServerTools(host: ListingHost, request: McpToolListRequest, signal?: AbortSignal): Promise<McpToolListResult> {
	const started = Date.now();
	const invalid = validate(request);
	if (invalid !== undefined) return invalid;

	const target = host.server(request.name, request.cwd);
	if ("refusal" in target) {
		// The host's own refusal name is kept when it is one both a call and a listing answer with, and reported as
		// `operation_failed` when it is a reader's problem the listing has no distinct name for.
		const code = target.refusal in SERVER_REFUSALS ? SERVER_REFUSALS[target.refusal] : READ_REFUSALS.has(target.refusal) ? "operation_failed" : undefined;
		return refused(code ?? "operation_failed", target.message);
	}
	if (entrySwitchedOff(target.config)) return refused("server-disabled", `server "${target.name}" is switched off, so none of its tools is listed`);

	const redactor = redactorFor(target.config);
	// A stdio server has no OAuth account, so the store is only built for a server that has a URL — the same rule a test
	// and a call apply, and the reason all three see one entry, one environment and one credential state.
	const url = typeof target.config.url === "string" ? target.config.url : undefined;
	const auth = url === undefined ? undefined : new McpAuthStore(host.agentDir, target.name, url);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, MCP_LIST_DEADLINE_MS);
	const deadline = AbortSignal.any([controller.signal, host.stopping, ...(signal === undefined ? [] : [signal])]);
	try {
		const opened = await connectServer(target, auth, redactor, deadline);
		if (!opened.ok) return failure(opened.error, { timedOut, caller: signal, stopping: host.stopping, redactor, stderr: opened.stderr });
		const connection = opened.connection;
		try {
			const read = await readPages(connection.client, deadline);
			const info = connection.client.serverInfo;
			return carried(read.items, {
				scope: target.scope,
				server: target.name,
				truncated: read.stopped,
				pages: read.pages,
				...(info === undefined ? {} : { serverInfo: { name: redactor.redact(String(info.name ?? "")), version: redactor.redact(String(info.version ?? "")) } }),
				durationMs: Date.now() - started,
				listedAt: Date.now(),
			}, target.config, redactor);
		} finally {
			await connection.close();
		}
	} catch (error) {
		return failure(error, { timedOut, caller: signal, stopping: host.stopping, redactor, stderr: "" });
	} finally {
		clearTimeout(timer);
	}
}

