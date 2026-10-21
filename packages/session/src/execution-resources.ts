/**
 * Execution-side resources through the client entry: the skills one selected execution host holds, the repository an
 * installation comes from, and the agent definitions of that host.
 *
 * Three rules make this one seam rather than a helper per surface, and they are the same three the read-block reader
 * states for history:
 *
 * - **The connection decides the origin and the credential.** Every address here is resolved against the Gateway this
 *   connection was admitted to, never against whatever origin happens to be rendering — a native shell's page origin is
 *   the app bundle, where a relative path would ask the shell for the skills of a computer it is not on. A credential is
 *   only ever presented to that Gateway, and never put in a URL.
 * - **The Backend resolves the execution host, and this client never does.** An operation names a *workspace*; which
 *   gateway and which account serve it is the Backend's binding resolution, exactly as it is for a conversation. Naming
 *   a host here would be the client choosing a computer, and the deployment's own default host would then be able to
 *   override a Project's binding. So no operation sends a host id at all: a folder on the entry's own machine and a
 *   folder on an SSH host are addressed by the same call.
 * - **A target is a scope, not a snapshot.** A selection is a `select()`ed target; when the user selects another one,
 *   the old target is disposed, and an answer that arrives after that is refused as `disposed` instead of published into
 *   the new selection's view. That is the inventory race the panel already had to solve, kept as a property of the
 *   scope rather than of one component's request counter.
 *
 * What crosses the wire is the Backend's own contract for these resources (`/api/skill-market/...`,
 * `/api/agent-definitions`). This module owns the transport and the vocabulary of a refusal; it does not re-derive the
 * Backend's installation, update, toggle or definition decisions, and it never reads a host path itself.
 */

import type { ResourceCredential } from "./resources.ts";

/**
 * Why an execution-resource operation did not answer.
 *
 * The five transport-level kinds are the read-block reader's own vocabulary; the three operation-level ones are what a
 * host-scoped write adds. `code` carries the Backend's or the host's own word for the refusal — `confirmation_required`,
 * `conflict`, `unknown_workspace`, `configuration_required`, `unreachable_host`, `not_configured` — so a surface that
 * already shows one of those keeps showing exactly it, and no second naming of the same outcome is invented here.
 */
export type ExecutionRefusal =
	/** The identity was not accepted (401). */
	| "unauthorized"
	/** The identity is accepted but this operation is not (403). */
	| "forbidden"
	/** The target, the bundle or the definition does not exist here (404). */
	| "not_found"
	/** The operation is refused in the state the host is in: a stale confirmation, an edited directory (409). */
	| "conflict"
	/** The request itself is not one this contract accepts (400). */
	| "invalid"
	/** This deployment or this host does not offer the capability at all (501, `not_configured`, `not_supported`). */
	| "unsupported"
	/** The Gateway or the execution host could not be reached, or answered something that is not the contract (5xx). */
	| "unavailable"
	/** The target or the connection scope this operation belonged to is gone, and the answer arrived too late to keep. */
	| "disposed";

export type ExecutionFailure = {
	readonly kind: ExecutionRefusal;
	/** The Backend's or the host's own code for this refusal, when it stated one. */
	readonly code?: string;
	/** A single bounded line, safe to show: the host's own message, never a credential and never a stack. */
	readonly message: string;
	/** The installed skill's state, on a `confirmation_required` refusal: what a confirmed replacement would discard. */
	readonly state?: string;
	/** The validation issues a definition refusal carried, so a form can point at its fields. */
	readonly issues?: readonly DefinitionIssue[];
};

export type ExecutionResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ExecutionFailure };

/** The installation scope a host writes: the execution account, or the bound workspace (a Project's folder). */
export type InstallScope = "global" | "workspace";

/** One skill as the selected execution host holds it, with the two state questions answered separately. */
export type InstalledSkill = {
	readonly name: string;
	readonly directory: string;
	readonly description: string;
	readonly filePath: string;
	readonly scope: "global" | "project" | "path";
	readonly disableModelInvocation: boolean;
	readonly install?: {
		readonly scope: InstallScope;
		readonly state: "unchanged" | "locally-modified" | "unmanaged";
		readonly source: string;
		readonly sourceType: string;
		readonly ref?: string;
		readonly version?: string;
		readonly repository?: string;
		readonly documentPath?: string;
		readonly path: string;
		readonly directory: string;
		readonly files: Readonly<Record<string, string>>;
	};
	readonly revision: "up-to-date" | "update-available" | "unknown";
	readonly availableVersion?: string;
};

/** What the selected execution host holds, and the account it holds it as. */
export type SkillInventory = {
	readonly workspaceId: string;
	readonly host: { readonly user: string; readonly home: string };
	readonly skills: readonly InstalledSkill[];
};

/**
 * Adoption is reported only when a conversation was named, and its outcome is separate from what happened to the files:
 * a published directory whose conversation could not reload is installed and not adopted, which is two facts.
 */
export type ReloadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** What an installation or a replacement reported. `warning` is a published directory whose provenance was not recorded. */
export type InstalledOutcome = {
	readonly installed: {
		readonly name: string;
		readonly version?: string;
		readonly scope: InstallScope;
		readonly path: string;
		readonly files: readonly string[];
		readonly contentHash: string;
		readonly backup?: string;
	};
	readonly reload?: ReloadOutcome;
	readonly warning?: { readonly code: string; readonly message: string };
};

/** One directory's outcome in a bulk switch. A refused directory is reported beside the ones that changed. */
export type ToggleResult = { readonly directory: string; readonly changed?: boolean; readonly error?: { readonly code: string; readonly message: string } };

export type ToggleOutcome = { readonly results: readonly ToggleResult[]; readonly scope: InstallScope; readonly reload?: ReloadOutcome };

/** What one explicit revision check answered. `unknown` is a real answer: nothing was compared. */
export type UpdateCheck = {
	readonly state: "up-to-date" | "update-available" | "unknown";
	readonly currentRevision?: string;
	readonly availableRevision?: string;
	readonly id?: string;
	readonly repository?: string;
};

/**
 * One skill the repository offers, as a browse hit: the bundle an installation names and the document a preview reads.
 *
 * `source` is the repository's own coordinate — a stored bundle's `{ kind: "repository", name, version }` or a curated
 * source's `{ kind: "github", repository, revision, path }` — and is passed through as it was stated, because the panel
 * reads the kind to decide what an update would install and which revision it would name.
 */
export type LibrarySkill = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly source: { readonly kind: "repository"; readonly name: string; readonly version: string } | { readonly kind: "github"; readonly repository: string; readonly revision: string; readonly path: string };
	readonly version?: string;
	readonly category?: string;
	readonly installs?: number;
};

/** A source that could not be offered, with the repository's own reason word rather than prose to parse. */
export type LibraryMiss = { readonly source: string; readonly reason: string };

export type LibraryPreview = { readonly markdown: string; readonly files: readonly { readonly path: string; readonly content: string; readonly encoding: "utf8" | "base64" }[] };

/**
 * What a repository read reported. The listing's own shape is kept — the stored bundles and curated sources, and the
 * sources that could not be read — because the panel names each unavailable source rather than folding it into "no
 * match", and a search carries its own per-source reasons beside the hits it did return.
 */
export type LibraryListing = {
	readonly skills: readonly LibrarySkill[];
	readonly unavailableSources: readonly string[];
	readonly unavailable?: readonly LibraryMiss[];
};

/** One validation issue a definition refusal carried: the field, the code and the sentence a form shows. */
export type DefinitionIssue = { readonly field: string; readonly code: string; readonly message: string };

export type DefinitionScope = "project" | "user";

/** One whole agent definition document, as the execution host holds it. */
export type AgentDefinition = {
	readonly name: string;
	readonly description: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools: readonly string[];
	readonly context: string;
	readonly enabled: boolean;
	readonly instructions: string;
	readonly scope: DefinitionScope;
	readonly hostId: string;
	readonly workspaceId: string;
	readonly path: string;
	readonly effective: boolean;
	readonly issues: readonly DefinitionIssue[];
	readonly raw: string;
};

/** The vocabulary a save is validated against, stated by the build that will accept it. */
export type DefinitionCapabilities = { readonly tools: readonly string[]; readonly thinking: readonly string[]; readonly contextStrategies: readonly string[] };

export type DefinitionList = {
	readonly hostId: string;
	readonly workspaceId: string;
	readonly capabilities?: DefinitionCapabilities;
	readonly definitions: readonly AgentDefinition[];
	readonly shadowed: readonly AgentDefinition[];
};

/** The fields a form submits; the Backend merges them onto the document already on the host. */
export type DefinitionFields = {
	readonly name?: string;
	readonly description?: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly tools?: readonly string[];
	readonly context?: string;
	readonly enabled?: boolean;
	readonly instructions?: string;
};

/** What a save reported: the stored document, and the configuration a conversation created from it would run. */
export type DefinitionSave = { readonly definition: AgentDefinition; readonly dryRun?: true; readonly effective?: unknown };

/** One operation of one selected execution target. Disposing it refuses every later operation and every late answer. */
export type ExecutionTarget = {
	readonly workspaceId: string;
	/** Every skill the host discovers, with each installation's provenance and both state questions. */
	inventory(): Promise<ExecutionResult<SkillInventory>>;
	/** Publish one bundle into a scope of this target, or replace the installation the caller confirmed. */
	install(request: { readonly id: string; readonly scope: InstallScope; readonly conversationId?: string }): Promise<ExecutionResult<InstalledOutcome>>;
	update(request: { readonly id: string; readonly name: string; readonly scope: InstallScope; readonly confirm?: boolean; readonly files?: Readonly<Record<string, string>>; readonly conversationId?: string }): Promise<ExecutionResult<InstalledOutcome>>;
	/** Switch the model-invocation key of one or more installed directories, each answered on its own. */
	toggle(request: { readonly directories: readonly string[]; readonly disableModelInvocation: boolean; readonly scope: InstallScope; readonly conversationId?: string }): Promise<ExecutionResult<ToggleOutcome>>;
	/** Ask the repository what revision an installation is at. The only operation here that reads the repository's head. */
	check(request: { readonly name: string; readonly scope: InstallScope }): Promise<ExecutionResult<UpdateCheck>>;
	/** The definitions of this target's host: the effective set and the ones a nearer scope shadows. */
	definitions(): Promise<ExecutionResult<DefinitionList>>;
	/** One whole document, raw and parsed. */
	definition(request: { readonly scope: DefinitionScope; readonly name: string }): Promise<ExecutionResult<AgentDefinition>>;
	/** Validate, and unless `dryRun`, save one document. A raw document names itself; fields are merged onto the host's. */
	saveDefinition(request: { readonly scope: DefinitionScope; readonly name: string; readonly document?: string; readonly fields?: DefinitionFields; readonly dryRun?: boolean }): Promise<ExecutionResult<DefinitionSave>>;
	removeDefinition(request: { readonly scope: DefinitionScope; readonly name: string }): Promise<ExecutionResult<{ readonly scope: DefinitionScope; readonly name: string }>>;
	dispose(): void;
};

/** The repository reads. They are not host operations, so they belong to the connection rather than to a target. */
export type SkillLibrary = {
	/** The bundles the deployment's own repository holds, and the sources it could not list. */
	list(): Promise<ExecutionResult<LibraryListing>>;
	search(query: string, options?: { readonly signal?: AbortSignal }): Promise<ExecutionResult<LibraryListing>>;
	/** One bundle's document and files, exactly the content an installation would publish. */
	preview(id: string): Promise<ExecutionResult<LibraryPreview>>;
};

export type ExecutionResources = {
	/** The connection's repository reads. */
	readonly library: SkillLibrary;
	/** Select one execution target. The caller disposes the previous selection, which is what retires its answers. */
	select(workspaceId: string): ExecutionTarget;
	/** Dispose every target this connection created and refuse every later operation. Repeating it changes nothing. */
	dispose(): void;
};

export type ExecutionResourcesOptions = {
	/** The Gateway origin this connection was admitted to. Every address resolves against exactly this. */
	readonly origin: string;
	readonly credential: ResourceCredential;
	/** The platform's own fetch. Injected because that is where a browser's cookie jar and a shell's TLS live. */
	readonly fetch?: typeof fetch;
};

/** A bounded, single-line form of a message that came from outside this process, for a surface to render. */
function bounded(message: string, limit = 300): string {
	const single = message.replace(/\s+/g, " ").trim();
	return single.length <= limit ? single : single.slice(0, limit - 1) + "…";
}

const failure = (kind: ExecutionRefusal, message: string, extra: { code?: string; state?: string; issues?: readonly DefinitionIssue[] } = {}): ExecutionFailure =>
	({ kind, message: bounded(message), ...(extra.code === undefined ? {} : { code: extra.code }), ...(extra.state === undefined ? {} : { state: extra.state }), ...(extra.issues === undefined ? {} : { issues: extra.issues }) });
const refused = <T>(kind: ExecutionRefusal, message: string, extra: { code?: string; state?: string; issues?: readonly DefinitionIssue[] } = {}): ExecutionResult<T> => ({ ok: false, error: failure(kind, message, extra) });
const value = <T>(answer: T): ExecutionResult<T> => ({ ok: true, value: answer });

/** The refusal kind a status states, before the body is read: the body may narrow it, never widen it. */
function kindOf(status: number): ExecutionRefusal {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 501) return "unsupported";
	if (status >= 400 && status < 500) return "invalid";
	return "unavailable";
}

/**
 * A code the Backend states for a capability this deployment does not configure at all, whatever status carried it.
 *
 * `unsupported_capability` is deliberately not one of these: it is a **validation** refusal of one document — a tool or
 * an MCP server this build cannot execute — which the form shows against its field, and reporting it as a missing
 * capability would hide the field the user has to fix.
 */
const UNSUPPORTED_CODES = new Set(["not_configured", "not_supported"]);

/** The one error body shape these routes use: `{ error: { code, message } }`, `{ code, error }`, or a bare sentence. */
function errorOf(body: unknown, status: number): ExecutionFailure {
	const kind = kindOf(status);
	if (body === null || typeof body !== "object") return failure(kind, "the request failed with status " + status);
	const record = body as { code?: unknown; error?: unknown; state?: unknown; issues?: unknown; message?: unknown };
	const code = typeof record.code === "string" ? record.code : undefined;
	const nested = record.error !== null && typeof record.error === "object" ? (record.error as { code?: unknown; message?: unknown }) : undefined;
	const stated = typeof record.error === "string" ? record.error : typeof nested?.message === "string" ? nested.message : typeof record.message === "string" ? record.message : undefined;
	const statedCode = code ?? (typeof nested?.code === "string" ? nested.code : undefined);
	const issues = Array.isArray(record.issues) ? (record.issues as DefinitionIssue[]) : undefined;
	const kindOfCode = statedCode !== undefined && UNSUPPORTED_CODES.has(statedCode) ? "unsupported" : kind;
	return failure(kindOfCode, stated ?? "the request failed with status " + status, {
		...(statedCode === undefined ? {} : { code: statedCode }),
		...(typeof record.state === "string" ? { state: record.state } : {}),
		...(issues === undefined ? {} : { issues }),
	});
}

/** The list fields these answers state, narrowed one by one so a shape this build does not know is a refusal. */
function listOf<T>(input: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(input)) return undefined;
	const out: T[] = [];
	for (const item of input) {
		const read_ = read(item);
		if (read_ === undefined) return undefined;
		out.push(read_);
	}
	return out;
}

const stringOf = (input: unknown): string | undefined => (typeof input === "string" ? input : undefined);
/** One optional string field, under its own name: absent when the host stated none, so the reader never invents one. */
const optionalString = (key: string, input: unknown): Record<string, string> => (typeof input === "string" ? { [key]: input } : {});

function readIssue(input: unknown): DefinitionIssue | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const field = stringOf(item.field), code = stringOf(item.code), message = stringOf(item.message);
	return field === undefined || code === undefined || message === undefined ? undefined : { field, code, message };
}

function readDefinition(input: unknown): AgentDefinition | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const name = stringOf(item.name), description = stringOf(item.description), context = stringOf(item.context);
	const scope = item.scope === "project" || item.scope === "user" ? item.scope : undefined;
	const hostId = stringOf(item.hostId), workspaceId = stringOf(item.workspaceId), path = stringOf(item.path), raw = stringOf(item.raw);
	const instructions = stringOf(item.instructions);
	const tools = listOf(item.tools, (entry) => stringOf(entry));
	const issues = listOf(item.issues ?? [], readIssue);
	if (name === undefined || description === undefined || context === undefined || scope === undefined || hostId === undefined || workspaceId === undefined || path === undefined || raw === undefined || instructions === undefined || tools === undefined || issues === undefined) return undefined;
	return {
		name, description, context, scope, hostId, workspaceId, path, raw, instructions, tools, issues,
		enabled: item.enabled === true,
		effective: item.effective === true,
		...optionalString("model", item.model),
		...optionalString("thinking", item.thinking),
	};
}

function readSkill(input: unknown): InstalledSkill | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const name = stringOf(item.name), directory = stringOf(item.directory), description = stringOf(item.description), filePath = stringOf(item.filePath);
	const scope = item.scope === "global" || item.scope === "project" || item.scope === "path" ? item.scope : undefined;
	const revision = item.revision === "up-to-date" || item.revision === "update-available" || item.revision === "unknown" ? item.revision : undefined;
	if (name === undefined || directory === undefined || description === undefined || filePath === undefined || scope === undefined || revision === undefined) return undefined;
	const install = item.install;
	let recorded: InstalledSkill["install"];
	if (install !== null && typeof install === "object") {
		const entry = install as Record<string, unknown>;
		const installScope = entry.scope === "global" || entry.scope === "workspace" ? entry.scope : undefined;
		const state = entry.state === "unchanged" || entry.state === "locally-modified" || entry.state === "unmanaged" ? entry.state : undefined;
		const source = stringOf(entry.source), sourceType = stringOf(entry.sourceType), path = stringOf(entry.path), dir = stringOf(entry.directory);
		const files = entry.files !== null && typeof entry.files === "object" ? (entry.files as Record<string, string>) : undefined;
		if (installScope === undefined || state === undefined || source === undefined || sourceType === undefined || path === undefined || dir === undefined || files === undefined) return undefined;
		recorded = { scope: installScope, state, source, sourceType, path, directory: dir, files, ...optionalString("ref", entry.ref), ...optionalString("version", entry.version), ...optionalString("repository", entry.repository), ...optionalString("documentPath", entry.documentPath) };
	}
	return {
		name, directory, description, filePath, scope, revision,
		disableModelInvocation: item.disableModelInvocation === true,
		...(recorded === undefined ? {} : { install: recorded }),
		...optionalString("availableVersion", item.availableVersion),
	};
}

/** A repository coordinate, in either of the two shapes the repository states. Anything else is not one. */
function readLibrarySource(input: unknown): LibrarySkill["source"] | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	if (item.kind === "repository") {
		const name = stringOf(item.name), version = stringOf(item.version);
		return name === undefined || version === undefined ? undefined : { kind: "repository", name, version };
	}
	if (item.kind === "github") {
		const repository = stringOf(item.repository), revision = stringOf(item.revision), path = stringOf(item.path);
		return repository === undefined || revision === undefined || path === undefined ? undefined : { kind: "github", repository, revision, path };
	}
	return undefined;
}

function readLibrarySkill(input: unknown): LibrarySkill | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const id = stringOf(item.id), name = stringOf(item.name), description = stringOf(item.description), source = readLibrarySource(item.source);
	if (id === undefined || name === undefined || description === undefined || source === undefined) return undefined;
	return { id, name, description, source, ...optionalString("version", item.version), ...optionalString("category", item.category), ...(typeof item.installs === "number" ? { installs: item.installs } : {}) };
}

function readMiss(input: unknown): LibraryMiss | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const source = stringOf(item.source), reason = stringOf(item.reason);
	return source === undefined || reason === undefined ? undefined : { source, reason };
}

function readReload(input: unknown): ReloadOutcome | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	if (item.ok === true) return { ok: true };
	return typeof item.error === "string" ? { ok: false, error: item.error } : undefined;
}

/** One installed outcome, from either the install or the update route: they answer the same body. */
function readInstalled(input: unknown): InstalledOutcome | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const installed = item.installed;
	if (installed === null || typeof installed !== "object") return undefined;
	const entry = installed as Record<string, unknown>;
	const name = stringOf(entry.name);
	const scope = entry.scope === "global" || entry.scope === "workspace" ? entry.scope : undefined;
	const path = stringOf(entry.path), contentHash = stringOf(entry.contentHash);
	const files = listOf(entry.files ?? [], (file) => stringOf(file));
	if (name === undefined || scope === undefined || path === undefined || contentHash === undefined || files === undefined) return undefined;
	const reload = readReload(item.reload);
	const warning = item.warning !== null && typeof item.warning === "object" ? (item.warning as { code?: unknown; message?: unknown }) : undefined;
	return {
		installed: { name, scope, path, contentHash, files, ...optionalString("version", entry.version), ...optionalString("backup", entry.backup) },
		...(reload === undefined ? {} : { reload }),
		...(warning === undefined || typeof warning.code !== "string" || typeof warning.message !== "string" ? {} : { warning: { code: warning.code, message: warning.message } }),
	};
}

function readToggle(input: unknown): ToggleOutcome | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const scope = item.scope === "global" || item.scope === "workspace" ? item.scope : undefined;
	const results = listOf(item.results ?? [], (entry): ToggleResult | undefined => {
		if (entry === null || typeof entry !== "object") return undefined;
		const row = entry as Record<string, unknown>;
		const directory = stringOf(row.directory);
		if (directory === undefined) return undefined;
		const error = row.error !== null && typeof row.error === "object" ? (row.error as { code?: unknown; message?: unknown }) : undefined;
		return {
			directory,
			...(row.changed === true ? { changed: true } : {}),
			...(error === undefined ? {} : { error: { code: stringOf(error.code) ?? "unknown", message: stringOf(error.message) ?? "the host refused this directory" } }),
		};
	});
	if (scope === undefined || results === undefined) return undefined;
	const reload = readReload(item.reload);
	return { results, scope, ...(reload === undefined ? {} : { reload }) };
}

function readCheck(input: unknown): UpdateCheck | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const state = item.state === "up-to-date" || item.state === "update-available" || item.state === "unknown" ? item.state : undefined;
	if (state === undefined) return undefined;
	return { state, ...optionalString("currentRevision", item.currentRevision), ...optionalString("availableRevision", item.availableRevision), ...optionalString("id", item.id), ...optionalString("repository", item.repository) };
}

function readInventory(input: unknown): SkillInventory | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const workspaceId = stringOf(item.workspaceId);
	const host = item.host !== null && typeof item.host === "object" ? (item.host as { user?: unknown; home?: unknown }) : undefined;
	const user = stringOf(host?.user), home = stringOf(host?.home);
	const skills = listOf(item.skills ?? [], readSkill);
	if (workspaceId === undefined || user === undefined || home === undefined || skills === undefined) return undefined;
	return { workspaceId, host: { user, home }, skills };
}

function readDefinitionList(input: unknown): DefinitionList | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const hostId = stringOf(item.hostId), workspaceId = stringOf(item.workspaceId);
	const definitions = listOf(item.definitions ?? [], readDefinition);
	const shadowed = listOf(item.shadowed ?? [], readDefinition);
	if (hostId === undefined || workspaceId === undefined || definitions === undefined || shadowed === undefined) return undefined;
	const stated = item.capabilities !== null && typeof item.capabilities === "object" ? (item.capabilities as Record<string, unknown>) : undefined;
	const tools = stated === undefined ? undefined : listOf(stated.tools ?? [], (entry) => stringOf(entry));
	const thinking = stated === undefined ? undefined : listOf(stated.thinking ?? [], (entry) => stringOf(entry));
	const strategies = stated === undefined ? undefined : listOf(stated.contextStrategies ?? [], (entry) => stringOf(entry));
	return {
		hostId, workspaceId, definitions, shadowed,
		...(tools === undefined || thinking === undefined || strategies === undefined ? {} : { capabilities: { tools, thinking, contextStrategies: strategies } }),
	};
}

function readLibraryListing(input: unknown): LibraryListing | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const skills = listOf(item.skills ?? [], readLibrarySkill);
	if (skills === undefined) return undefined;
	// A listing names the sources it could not read; a search names each miss beside the hits it did return. A source
	// that answered neither field is a listing with nothing unavailable, which is the answer this contract states.
	const sources = item.unavailableSources === undefined ? [] : listOf(item.unavailableSources, (entry) => stringOf(entry));
	const misses = item.unavailable === undefined ? undefined : listOf(item.unavailable, readMiss);
	if (sources === undefined) return undefined;
	if (misses === undefined && item.unavailable !== undefined) return undefined;
	return { skills, unavailableSources: sources, ...(misses === undefined ? {} : { unavailable: misses }) };
}

function readPreview(input: unknown): LibraryPreview | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const item = input as Record<string, unknown>;
	const markdown = stringOf(item.markdown);
	const files = listOf(item.files ?? [], (entry): LibraryPreview["files"][number] | undefined => {
		if (entry === null || typeof entry !== "object") return undefined;
		const file = entry as Record<string, unknown>;
		const path = stringOf(file.path), content = stringOf(file.content);
		const encoding = file.encoding === "base64" ? "base64" : "utf8";
		return path === undefined || content === undefined ? undefined : { path, content, encoding };
	});
	return markdown === undefined || files === undefined ? undefined : { markdown, files };
}

export function createExecutionResources(options: ExecutionResourcesOptions): ExecutionResources {
	const origin = options.origin.replace(/\/+$/, "");
	const send = options.fetch ?? globalThis.fetch;
	/** Every target this connection selected, so the connection can retire them all at once. */
	const targets = new Set<{ dispose(): void }>();
	let disposed = false;

	/**
	 * One request shape this connection makes: its own origin, its own credential, and nothing of its own in the URL.
	 *
	 * The credential is the connection's — the browser's own cookie, which it attaches by itself, or one explicit device
	 * bearer — and it is presented to no other origin, because the address was built from this connection's origin and
	 * cannot name another one.
	 */
	async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (options.credential.kind === "bearer") headers.authorization = "Bearer " + options.credential.token;
		return await send(origin + path, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			credentials: options.credential.kind === "cookie" ? "same-origin" : "omit",
			cache: "no-store",
			...(signal === undefined ? {} : { signal }),
		}) as Response;
	}

	/**
	 * One call, as the contract's own answer: a refusal keeps the Backend's status, code and reason, and an answer whose
	 * shape this build does not know is `unavailable` rather than an empty result — "the host said nothing I understand"
	 * is not "the host holds nothing".
	 */
	async function call<T>(read: (body: unknown) => T | undefined, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<ExecutionResult<T>> {
		let response: Response;
		try {
			response = await request(method, path, body, signal);
		} catch {
			return refused<T>("unavailable", "the client Gateway could not be reached");
		}
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			await response.body?.cancel().catch(() => {});
			return response.ok ? refused<T>("unavailable", "the Gateway answered something that is not this contract") : refused<T>(kindOf(response.status), "the request failed with status " + response.status);
		}
		if (!response.ok) return { ok: false, error: errorOf(parsed, response.status) };
		const read_ = read(parsed);
		return read_ === undefined ? refused<T>("unavailable", "the Gateway answered something that is not this contract") : value(read_);
	}

	/** A target whose operations are all refused for the same reason, so a caller keeps one shape. */
	function refusingTarget(workspaceId: string, dispose: () => void): ExecutionTarget {
		const stop = <T>(): Promise<ExecutionResult<T>> => Promise.resolve(refused<T>("disposed", "the execution target this operation belonged to was disposed"));
		return {
			workspaceId,
			inventory: stop, install: stop, update: stop, toggle: stop, check: stop,
			definitions: stop, definition: stop, saveDefinition: stop, removeDefinition: stop,
			dispose,
		};
	}

	return {
		library: {
			list: () => disposed ? Promise.resolve(refused("disposed", "this connection scope was disposed")) : call(readLibraryListing, "GET", "/api/skill-market/skills"),
			search: (query, searchOptions) => disposed
				? Promise.resolve(refused("disposed", "this connection scope was disposed"))
				: call(readLibraryListing, "GET", "/api/skill-market/search?q=" + encodeURIComponent(query), undefined, searchOptions?.signal),
			preview: (id) => disposed
				? Promise.resolve(refused("disposed", "this connection scope was disposed"))
				: call(readPreview, "GET", "/api/skill-market/preview?id=" + encodeURIComponent(id)),
		},
		select(workspaceId) {
			if (disposed) return refusingTarget(workspaceId, () => {});
			let targetDisposed = false;
			const entry = { dispose: () => { targetDisposed = true; targets.delete(entry); } };
			targets.add(entry);
			/** A target's own operations: refused once the target or the connection is gone, and never published after. */
			const run = async <T>(work: () => Promise<ExecutionResult<T>>): Promise<ExecutionResult<T>> => {
				if (targetDisposed || disposed) return refused<T>("disposed", "the execution target this operation belonged to was disposed");
				const answer = await work();
				// The answer arrived after the selection moved: it is dropped rather than written into the new target's view,
				// which is what keeps one host's inventory from replacing another's.
				if (targetDisposed || disposed) return refused<T>("disposed", "the execution target this operation belonged to was disposed");
				return answer;
			};
			const query = "?workspaceId=" + encodeURIComponent(workspaceId);
			return {
				workspaceId,
				dispose: entry.dispose,
				inventory: () => run(() => call(readInventory, "GET", "/api/skill-market/inventory" + query)),
				install: (request_) => run(() => call(readInstalled, "POST", "/api/skill-market/install", { id: request_.id, scope: request_.scope, workspaceId, ...(request_.conversationId === undefined ? {} : { conversationId: request_.conversationId }) })),
				update: (request_) => run(() => call(readInstalled, "POST", "/api/skill-market/update", {
					id: request_.id, name: request_.name, scope: request_.scope, workspaceId,
					confirm: request_.confirm === true,
					...(request_.files === undefined ? {} : { files: request_.files }),
					...(request_.conversationId === undefined ? {} : { conversationId: request_.conversationId }),
				})),
				toggle: (request_) => run(() => call(readToggle, "PATCH", "/api/skill-market/skills", {
					directories: [...request_.directories], disableModelInvocation: request_.disableModelInvocation, scope: request_.scope, workspaceId,
					...(request_.conversationId === undefined ? {} : { conversationId: request_.conversationId }),
				})),
				check: (request_) => run(() => call(readCheck, "GET", "/api/skill-market/check" + query + "&name=" + encodeURIComponent(request_.name) + "&scope=" + encodeURIComponent(request_.scope))),
				definitions: () => run(() => call(readDefinitionList, "GET", "/api/agent-definitions" + query)),
				definition: (request_) => run(() => call((body) => {
					if (body === null || typeof body !== "object") return undefined;
					return readDefinition((body as { definition?: unknown }).definition);
				}, "GET", "/api/agent-definitions/document" + query + "&scope=" + encodeURIComponent(request_.scope) + "&name=" + encodeURIComponent(request_.name))),
				saveDefinition: (request_) => run(() => call((body): DefinitionSave | undefined => {
					if (body === null || typeof body !== "object") return undefined;
					const record = body as { definition?: unknown; dryRun?: unknown };
					const definition = readDefinition(record.definition);
					return definition === undefined ? undefined : { definition, ...(record.dryRun === true ? { dryRun: true as const } : {}) };
				}, "PUT", "/api/agent-definitions", {
					workspaceId, scope: request_.scope, name: request_.name,
					...(request_.document === undefined ? {} : { document: request_.document }),
					...(request_.fields === undefined ? {} : { fields: request_.fields }),
					...(request_.dryRun === true ? { dryRun: true } : {}),
				})),
				removeDefinition: (request_) => run(() => call((body): { scope: DefinitionScope; name: string } | undefined => {
					if (body === null || typeof body !== "object") return undefined;
					const removed = (body as { deleted?: unknown }).deleted;
					if (removed === null || typeof removed !== "object") return undefined;
					const entry_ = removed as { scope?: unknown; name?: unknown };
					const scope = entry_.scope === "project" || entry_.scope === "user" ? entry_.scope : undefined;
					const name = stringOf(entry_.name);
					return scope === undefined || name === undefined ? undefined : { scope, name };
				}, "DELETE", "/api/agent-definitions" + query + "&scope=" + encodeURIComponent(request_.scope) + "&name=" + encodeURIComponent(request_.name))),
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const target of targets) target.dispose();
			targets.clear();
		},
	};
}
