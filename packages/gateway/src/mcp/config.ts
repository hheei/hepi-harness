import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { McpConfigFileInfo, McpConfigFileProblem, McpConfigRead, McpScope, McpServerInfo, McpTransportKind, ProjectTrust } from "@hepi/protocol/gateway";
import { maskedEntry } from "./secrets.ts";

// What this surface reports belongs to the wire, so those shapes are declared once in `@hepi/protocol/gateway` and
// re-exported here. The write refusals further down stay this service's own: no other process names them.
export type { McpConfigFileInfo, McpConfigFileProblem, McpConfigRead, McpScope, McpServerInfo, McpTransportKind, ProjectTrust } from "@hepi/protocol/gateway";

/**
 * The MCP configuration this Web host service owns, in the upstream shapes: the global
 * `mcp.json` and a project's `.pi/mcp.json`, both an `mcpServers` map, plus the OAuth state
 * beside them (`mcp-auth.json`). Nothing here starts a server.
 *
 * The account is the execution account of the host this gateway serves, resolved the way the
 * resource loader resolves it (ADR 0002): the account home's `.pi/agent`. `PI_CODING_AGENT_DIR`
 * is deliberately not consulted, so another process's agent directory can never stand in for the
 * host's own files.
 */

/** The agent directory of the execution account whose files this service owns. */
export function agentDirOf(home: string): string {
	return join(home, ".pi", "agent");
}

export function globalMcpConfigPath(agentDir: string): string {
	return join(agentDir, "mcp.json");
}

export function projectMcpConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}

/** Where this host keeps the OAuth state of its MCP servers, beside the configuration. */
export function mcpAuthPath(agentDir: string): string {
	return join(agentDir, "mcp-auth.json");
}

/**
 * The trust store, the one the pi CLI and the execution-side resource loader already use:
 * `<agent dir>/trust.json`, a map of canonical folder path to `true`/`false`/`null`, resolved by the
 * nearest decision at or above the folder. It is read here rather than through the SDK because this
 * service only reads it: the decision is recorded by whoever asks a person to make it (the pi CLI, or
 * a trust dialog), and MCP only honours it. Nothing in this service writes the store.
 */

/** The store's own key for a folder: resolved, then its real path when it exists. */
function trustKey(cwd: string): string {
	const resolved = resolve(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function readTrustFile(agentDir: string): Record<string, unknown> {
	const path = join(agentDir, "trust.json");
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`Invalid trust store ${path}: expected an object`);
	return parsed;
}

/** The nearest decision at or above a folder, as the store's own resolution rule finds it. */
function nearestDecision(store: Record<string, unknown>, cwd: string): { path: string; decision: boolean } | null {
	let current = trustKey(cwd);
	while (true) {
		const value = store[current];
		if (value === true || value === false) return { path: current, decision: value };
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export type McpWriteRefusal =
	| "unparsable"
	| "invalid-shape"
	| "server-invalid"
	| "name-taken"
	| "server-missing"
	/** The file defines the name as something other than an object, so it has no field to change. */
	| "entry-not-object"
	| "project-untrusted"
	| "trust-unreadable"
	| "file-too-large"
	| "operation_failed";

export type McpWriteOutcome = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly code: McpWriteRefusal; readonly message: string; readonly path: string };

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);
/** A project file larger than this is not read or rewritten: it is not a configuration a person wrote. */
export const MCP_CONFIG_MAX_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * One `mcpServers` entry, checked against the upstream rules: the shape every MCP client's
 * `mcp.json` uses, with the exposure names and the stdio/HTTP distinction the SDK's own validator
 * applies. The SDK does not export its validator, so the rules are restated here; an entry the SDK
 * refuses for a reason not restated here is refused by the SDK at connect time and reported as a
 * test failure rather than silently connected.
 */
export function validateServerConfig(name: string, raw: unknown): string | Record<string, unknown> {
	if (!SERVER_NAME.test(name)) return `invalid server name "${name}" (use letters, digits, "_" and "-")`;
	if (!isRecord(raw)) return `server "${name}" must be an object`;
	const { type, exposure, enabled, toolExposure, url, command } = raw;
	if (exposure !== undefined && (typeof exposure !== "string" || !EXPOSURES.has(exposure))) return `server "${name}": exposure must be one of "codemode", "deferred", "direct", "hidden"`;
	if (toolExposure !== undefined) {
		if (!isRecord(toolExposure)) return `server "${name}": toolExposure must map tool names to exposures`;
		for (const [tool, value] of Object.entries(toolExposure)) {
			if (typeof value !== "string" || !EXPOSURES.has(value)) return `server "${name}": toolExposure "${tool}" must be one of "codemode", "deferred", "direct", "hidden"`;
		}
	}
	if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
	if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
	if (url !== undefined && (type === undefined || type === "http" || type === "streamable-http")) {
		if (typeof url !== "string" || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return `server "${name}": url must be an http or https URL`;
		if (raw.headers !== undefined && !isStringRecord(raw.headers)) return `server "${name}": headers must map names to strings`;
		if (raw.auth !== undefined && (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || raw.auth.provider === "")) return `server "${name}": auth.provider must be a provider name`;
		return raw;
	}
	if (command !== undefined && (type === undefined || type === "stdio")) {
		if (typeof command !== "string" || command === "") return `server "${name}": command must be a non-empty string`;
		if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) return `server "${name}": args must be an array of strings`;
		if (raw.env !== undefined && !isStringRecord(raw.env)) return `server "${name}": env must map names to strings`;
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") return `server "${name}": cwd must be a string`;
		return raw;
	}
	return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/** The URL a server signs in at: an entry with a `url`, no `auth` and no `Authorization` header. */
export function oauthUrlOf(config: Record<string, unknown>): string | undefined {
	if (typeof config.url !== "string" || config.auth) return undefined;
	const headers = isRecord(config.headers) ? Object.keys(config.headers) : [];
	if (headers.some((header) => header.toLowerCase() === "authorization")) return undefined;
	try {
		return String(new URL(config.url));
	} catch {
		return undefined;
	}
}

/**
 * The key the SDK stores a server's OAuth state under, restated from its own rule: `mcp__<name>`
 * with `-` as `_`, a pipe, then the URL as `new URL()` spells it. The pi CLI on this host writes
 * the same file under the same keys, so both see one account per server.
 */
export function oauthStoreKey(name: string, url: string): string {
	return `mcp__${name.replace(/-/g, "_")}|${String(new URL(url))}`;
}

/** One folder's trust decision, read from the host's own trust store. */
export function readProjectTrust(cwd: string, agentDir: string): ProjectTrust {
	try {
		const entry = nearestDecision(readTrustFile(agentDir), cwd);
		return {
			cwd,
			trusted: entry?.decision === true,
			decision: entry?.decision ?? null,
			...(entry === null ? {} : { decisionPath: entry.path }),
			inherited: entry !== null && entry.path !== trustKey(cwd),
		};
	} catch (error) {
		return { cwd, trusted: false, decision: null, inherited: false, error: message(error) };
	}
}

/** The trust a project write needs, or the refusal naming what refused it. */
function projectTrustRefusal(scope: McpScope, cwd: string | undefined, agentDir: string, path: string): McpWriteOutcome | undefined {
	if (scope !== "project") return undefined;
	if (cwd === undefined || cwd === "") return { ok: false, code: "operation_failed", message: "a project scope names the folder it applies to", path };
	const trust = readProjectTrust(cwd, agentDir);
	if (trust.error !== undefined) return { ok: false, code: "trust-unreadable", message: trust.error, path };
	if (!trust.trusted) {
		const recorded = trust.decision === false ? `${trust.decisionPath ?? cwd} is recorded as not trusted` : `${cwd} has no trust decision`;
		return { ok: false, code: "project-untrusted", message: `${recorded}, so its .pi/mcp.json is not written`, path };
	}
	return undefined;
}

type ParsedConfigFile = { readonly servers: Record<string, unknown>; readonly indent: string; readonly text: string | undefined };

/** One `mcp.json`, parsed: the `mcpServers` map, the file's own indentation and the text it was read. */
function parseConfigFile(path: string): ParsedConfigFile | { readonly problem: McpConfigFileProblem } {
	if (!existsSync(path)) return { servers: {}, indent: "  ", text: undefined };
	try {
		if (statSync(path).size > MCP_CONFIG_MAX_BYTES) return { problem: { reason: "too-large", error: `${path} is larger than ${MCP_CONFIG_MAX_BYTES} bytes` } };
	} catch (error) {
		return { problem: { reason: "unreadable", error: message(error) } };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { problem: { reason: "unreadable", error: message(error) } };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { problem: { reason: "unparsable", error: message(error) } };
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		return { problem: { reason: "invalid-shape", error: `${path}: expected an object with an "mcpServers" object` } };
	}
	return { servers: (parsed.mcpServers as Record<string, unknown> | undefined) ?? {}, indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ", text };
}

/** One entry as a caller sees it: every env and header name, and no env or header value at all. */
function describeServer(name: string, raw: unknown, scope: McpScope, sourcePath: string, auth: Readonly<Record<string, unknown>>): McpServerInfo {
	const config = isRecord(raw) ? raw : {};
	const validation = validateServerConfig(name, raw);
	const invalidError = typeof validation === "string" ? validation : undefined;
	const url = typeof config.url === "string" ? config.url : undefined;
	const command = typeof config.command === "string" ? config.command : undefined;
	const shown = maskedEntry(config);
	const args = Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string") ? (config.args as string[]) : undefined;
	const masked = (command !== undefined && shown.command !== command)
		|| (url !== undefined && shown.url !== url)
		|| (args !== undefined && shown.args !== undefined && shown.args.join("\u0000") !== args.join("\u0000"));
	// A URL the validator refused has no key; it is refused, so it can have no stored state either.
	let record: unknown;
	if (url !== undefined) {
		try {
			record = auth[oauthStoreKey(name, url)];
		} catch {
			record = undefined;
		}
	}
	const exposure = typeof config.exposure === "string" && EXPOSURES.has(config.exposure) ? config.exposure : undefined;
	const toolExposureCount = isRecord(config.toolExposure) ? Object.keys(config.toolExposure).length : 0;
	return {
		name,
		scope,
		sourcePath,
		enabled: config.enabled !== false,
		...(invalidError === undefined ? { transport: (url === undefined ? "stdio" : "http") as McpTransportKind } : {}),
		...(invalidError === undefined ? {} : { invalidError }),
		...(isRecord(raw) ? {} : { notAnObject: true as const }),
		...(exposure === undefined ? {} : { exposure }),
		...(toolExposureCount === 0 ? {} : { toolExposureCount }),
		...(command === undefined ? {} : { command: shown.command ?? command }),
		...(args === undefined ? {} : { args: shown.args ?? args }),
		...(url === undefined ? {} : { url: shown.url ?? url }),
		masked,
		envNames: isRecord(config.env) ? Object.keys(config.env) : [],
		headerNames: isRecord(config.headers) ? Object.keys(config.headers) : [],
		usesOAuth: oauthUrlOf(config) !== undefined,
		signedIn: isRecord(record) && record.tokens !== undefined,
		oauthStateStored: record !== undefined,
	};
}

/** The host's OAuth state file, as the map the SDK writes: one record per server, keyed by name and URL. */
export function readOAuthState(agentDir: string): Record<string, unknown> {
	const path = mcpAuthPath(agentDir);
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Every configured server: the global file, then the project file when a folder is named. */
export function readMcpConfig(options: { agentDir: string; cwd?: string }): McpConfigRead {
	const files: McpConfigFileInfo[] = [];
	const servers: McpServerInfo[] = [];
	const auth = readOAuthState(options.agentDir);
	const collect = (scope: McpScope, path: string): void => {
		const parsed = parseConfigFile(path);
		const problem = "problem" in parsed ? parsed.problem : undefined;
		files.push({ scope, path, exists: existsSync(path), problems: problem === undefined ? [] : [problem] });
		if (problem !== undefined) return;
		for (const [name, raw] of Object.entries((parsed as ParsedConfigFile).servers)) servers.push(describeServer(name, raw, scope, path, auth));
	};
	collect("global", globalMcpConfigPath(options.agentDir));
	if (options.cwd !== undefined && options.cwd !== "") collect("project", projectMcpConfigPath(options.cwd));
	return { files, servers };
}

/** The refusal a parse problem becomes on a write, which is the same condition named for a caller. */
function writeRefusal(problem: McpConfigFileProblem): McpWriteRefusal {
	if (problem.reason === "too-large") return "file-too-large";
	if (problem.reason === "invalid-shape") return "invalid-shape";
	if (problem.reason === "unparsable") return "unparsable";
	return "operation_failed";
}

/**
 * Add, replace or remove one server in one of the two files, keeping every other key and the file's
 * own indentation. A project write requires the folder's trust decision: a project `mcp.json` is
 * trust-requiring content, and this host's loader reads it only for a trusted folder, so writing one
 * behind an untrusted folder would create a file nothing connects.
 */
export function editMcpConfig(options: {
	agentDir: string;
	scope: McpScope;
	cwd?: string;
	name: string;
	/** The entry to write, or undefined to remove the server. */
	config?: unknown;
	/** Refuse a name the file already defines instead of replacing it. */
	requireNew?: boolean;
}): McpWriteOutcome {
	const path = options.scope === "global" ? globalMcpConfigPath(options.agentDir) : projectMcpConfigPath(options.cwd ?? "");
	const refused = projectTrustRefusal(options.scope, options.cwd, options.agentDir, path);
	if (refused !== undefined) return refused;
	const parsed = parseConfigFile(path);
	if ("problem" in parsed) return { ok: false, code: writeRefusal(parsed.problem), message: parsed.problem.error, path };
	if (options.config === undefined) {
		if (!(options.name in parsed.servers)) return { ok: false, code: "server-missing", message: `${path} does not define server "${options.name}"`, path };
		delete parsed.servers[options.name];
	} else {
		if (options.requireNew === true && options.name in parsed.servers) return { ok: false, code: "name-taken", message: `${path} already defines server "${options.name}"`, path };
		const validation = validateServerConfig(options.name, options.config);
		if (typeof validation === "string") return { ok: false, code: "server-invalid", message: validation, path };
		if (options.scope === "project" && isRecord(options.config) && options.config.auth !== undefined) {
			return { ok: false, code: "server-invalid", message: `server "${options.name}": auth is only allowed in the global mcp.json`, path };
		}
		parsed.servers[options.name] = options.config;
	}
	try {
		writeConfigFile(path, parsed);
	} catch (error) {
		return { ok: false, code: "operation_failed", message: message(error), path };
	}
	return { ok: true, path };
}

/** Write the `mcpServers` map back, keeping every other key the file had and its indentation. */
function writeConfigFile(path: string, parsed: ParsedConfigFile): void {
	const existing = parsed.text === undefined ? {} : (JSON.parse(parsed.text) as Record<string, unknown>);
	const next = { ...existing, mcpServers: parsed.servers };
	mkdirSync(dirname(path), { recursive: true });
	// A partial file is never left behind: the content is written beside it and renamed over it.
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, parsed.indent)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		try {
			if (existsSync(temporary)) unlinkSync(temporary);
		} catch {
			/* the rename is what matters */
		}
		throw error;
	}
}

/** One server's raw entry as its file holds it, for a test or a sign-in to connect with. */
export function readServerConfig(options: { agentDir: string; scope: McpScope; cwd?: string; name: string }): { readonly config: Record<string, unknown>; readonly path: string } | { readonly refusal: McpWriteRefusal; readonly message: string; readonly path: string } {
	const path = options.scope === "global" ? globalMcpConfigPath(options.agentDir) : projectMcpConfigPath(options.cwd ?? "");
	const parsed = parseConfigFile(path);
	if ("problem" in parsed) return { refusal: writeRefusal(parsed.problem), message: parsed.problem.error, path };
	const raw = parsed.servers[options.name];
	if (raw === undefined) return { refusal: "server-missing", message: `${path} does not define server "${options.name}"`, path };
	if (!isRecord(raw)) return { refusal: "entry-not-object", message: `${path} defines MCP server "${options.name}" as something other than an object`, path };
	return { config: raw, path };
}

/**
 * Change named keys of one entry, keeping every other key and the value of every key not named: the
 * way to switch a server on or off, or to change its exposure, without a caller ever holding the
 * entry's secrets. A value of `null` removes the key. The entry after the change is validated like
 * any other write, and a project write passes the same trust gate.
 */
export function patchMcpServer(options: { agentDir: string; scope: McpScope; cwd?: string; name: string; patch: Record<string, unknown> }): McpWriteOutcome {
	const path = options.scope === "global" ? globalMcpConfigPath(options.agentDir) : projectMcpConfigPath(options.cwd ?? "");
	const refused = projectTrustRefusal(options.scope, options.cwd, options.agentDir, path);
	if (refused !== undefined) return refused;
	const found = readServerConfig(options);
	if ("refusal" in found) return { ok: false, code: found.refusal, message: found.message, path: found.path };
	const merged: Record<string, unknown> = { ...found.config };
	for (const [key, value] of Object.entries(options.patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return editMcpConfig({ agentDir: options.agentDir, scope: options.scope, ...(options.cwd === undefined ? {} : { cwd: options.cwd }), name: options.name, config: merged });
}
