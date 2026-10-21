/**
 * The wire shapes of the gateway's `/v1/*` surfaces, declared once for every production consumer.
 *
 * The gateway is the owner of these shapes: it validates a request, interprets its operation and serialises the answer.
 * The backend calls those routes and the Web host service reads one of them, and both used to redeclare the part they
 * touched — a copy that nothing kept in step, because a type is erased and a divergence between two declarations of the
 * same JSON is not a compile error. They read this file instead.
 *
 * This is a declaration of what the routes send, not a validator: a shared static type does not check a remote body,
 * and the assertions each consumer makes about the bytes it received stay where they are. It is also not a package of
 * the surfaces' internals — the failure codes a surface keeps to itself, the workbench's own path helpers and the
 * panel DTO the Web process builds from these shapes all stay with their owners.
 *
 * Nothing here is imported from the gateway implementation, so this file stays pure data: the protocol package is
 * consumed by the browser as well as by every Node process, and a wire declaration must not drag a runtime behind it.
 */

/**
 * The execution account and home of one execution host, as `/v1/workspaces` reports it in a listing. Declared
 * structurally rather than imported: the gateway's own `ExecutionHostIdentity` is the same pair, and the wire
 * shape is what a reader of the JSON needs.
 */
export type ExecutionHostIdentity = { readonly user: string; readonly home: string };

// ---------------------------------------------------------------------------
// /v1/workspaces
// ---------------------------------------------------------------------------

/**
 * One workspace a gateway serves: a logical id and the physical directory its tools run in. `profileId` is set only on
 * an SSH gateway and names the configured SSH profile the root lives on, so an id registered at runtime resolves to the
 * same account and transport as the profile's own seeded workspace instead of being guessed from the id's spelling.
 */
export type WorkspaceConfig = { readonly id: string; readonly root: string; readonly profileId?: string };

export type WorkspaceRegistration =
  | { readonly ok: true; readonly value: { readonly id: string; readonly root: string; readonly created: boolean } }
  | { readonly ok: false; readonly code: "invalid_workspace_id" | "invalid_root" | "workspace_conflict" };

export type WorkspaceDirectory = { readonly name: string; readonly path: string };
/** One host directory listing: where it is, its parent, the directories below it, and the account that listed them. */
export type WorkspaceListing = { readonly path: string; readonly parentPath: string | null; readonly directories: readonly WorkspaceDirectory[]; readonly host: ExecutionHostIdentity };

/**
 * One execution target the gateway can offer for a project: the profile's configured identity, the account the host
 * itself reports, and its own root. A host that could not answer keeps its configured identity and carries the reason
 * it could not be asked, so a picker names the target and its state truthfully instead of substituting another host.
 */
export type WorkspaceProfile = {
  readonly id: string;
  readonly host: string;
  readonly root: string;
  readonly user?: string;
  readonly home?: string;
  readonly error?: string;
};

export type WorkspaceRequest =
  | { readonly operation: "list" }
  | { readonly operation: "register"; readonly workspaceId: string; readonly root: string; readonly profileId?: string }
  | { readonly operation: "browse"; readonly path?: string; readonly profileId?: string }
  | { readonly operation: "profiles" };

export type WorkspaceResult =
  | { readonly ok: true; readonly value: readonly WorkspaceConfig[] | WorkspaceListing | readonly WorkspaceProfile[] | { readonly id: string; readonly root: string; readonly created: boolean } }
  | { readonly ok: false; readonly code: "invalid_request" | "invalid_workspace_id" | "invalid_root" | "workspace_conflict" | "not_found" | "not_a_directory" | "permission_denied" | "not_supported" | "unreachable" | "operation_failed" };

// ---------------------------------------------------------------------------
// /v1/worktrees
// ---------------------------------------------------------------------------

/** One checkout of a project: its real path, the branch checked out there, and whether it is the main one. */
export type WorktreeEntry = { readonly path: string; readonly branch: string | null; readonly isMain: boolean };

/**
 * What a listing answers: the project's root, its checkouts, and which of them the asked-about root is.
 *
 * Every field is required, as the gateway reports them. A reader tolerant of a host that predates a field keeps its own
 * default: widening the declaration would also make a current gateway that genuinely omits a field compile, which is
 * the failure the shared declaration exists to prevent.
 */
export type WorktreeListing = {
  readonly projectRoot: string;
  readonly isGit: boolean;
  readonly isTopLevel: boolean;
  readonly currentWorktreePath: string | null;
  readonly worktrees: readonly WorktreeEntry[];
};

export type WorktreeRequest =
  | { readonly operation: "list"; readonly workspaceId: string }
  | { readonly operation: "create"; readonly workspaceId: string; readonly branch: string }
  | { readonly operation: "remove"; readonly workspaceId: string; readonly path: string; readonly force?: boolean };

export type WorktreeFailureCode =
  | "invalid_request"
  | "unknown_workspace"
  | "invalid_root"
  | "not_a_worktree"
  | "main_worktree"
  | "dirty"
  | "not_supported"
  | "unreachable"
  | "outcome_unknown"
  | "operation_failed";

export type WorktreeResult =
  | { readonly ok: true; readonly value: WorktreeListing | { readonly path: string; readonly branch: string } | { readonly removed: string } }
  | { readonly ok: false; readonly code: WorktreeFailureCode; readonly message?: string };

// ---------------------------------------------------------------------------
// /v1/workbench
// ---------------------------------------------------------------------------

/**
 * One text preview of a workspace file, as `read` answers it.
 *
 * `shownBytes` is how much of the file this answer really carries and `sizeBytes` is the file's whole size as the host
 * stated it, so a bounded preview can say what it shows without claiming the rest was read: the two numbers are the
 * host's own, not a caller's estimate from the decoded text.
 */
export type WorkbenchFile = { readonly path: string; readonly content: string; readonly truncated: boolean; readonly binary: boolean; readonly sizeBytes: number; readonly shownBytes: number };
export type WorkbenchChangedFile = { readonly path: string; readonly previousPath?: string; readonly stagingSourcePath?: string; readonly status: "added" | "copied" | "deleted" | "modified" | "renamed" | "untracked"; readonly staged: boolean };
export type WorkbenchChanges = { readonly state: "available"; readonly files: readonly WorkbenchChangedFile[] } | { readonly state: "unavailable"; readonly error: { readonly code: string; readonly message: string } };
export type WorkbenchOperation = "files" | "read" | "changes" | "diff";
export type WorkbenchRequest = { readonly workspaceId: string; readonly operation: WorkbenchOperation; readonly path?: string };
/**
 * One workbench refusal.
 *
 * `not_supported` is a fact about the deployment: this gateway host was composed without a workbench at all.
 * `not_found` is the host's own statement that the path it was asked about is not there — the ordinary case of a file
 * deleted or moved after a tree was listed — and `path_denied` is the refusal of a path that left the workspace, which
 * is a different fact about a path that does exist somewhere else. The remaining two are the request's shape and the
 * operation's failure. A caller must not be told a capability is missing because a host that has it could not answer —
 * that is a different next move than a host that cannot serve reads at all, and a different one again from a file that
 * is simply gone.
 */
export type WorkbenchFailureCode = "unknown_workspace" | "path_denied" | "not_found" | "operation_failed" | "not_supported";
export type WorkbenchResult =
  | { readonly ok: true; readonly value: readonly string[] | WorkbenchFile | WorkbenchChanges | string }
  | { readonly ok: false; readonly code: WorkbenchFailureCode };

// ---------------------------------------------------------------------------
// /v1/mcp
// ---------------------------------------------------------------------------

export type McpScope = "global" | "project";
export type McpTransportKind = "stdio" | "http";

/** One `mcpServers` entry, described from the file: no value resolved and no secret value reported. */
export type McpServerInfo = {
  readonly name: string;
  readonly scope: McpScope;
  readonly sourcePath: string;
  readonly enabled: boolean;
  /** Absent when the entry is refused: it never connects, so it has no transport. */
  readonly transport?: McpTransportKind;
  /** The validator's reason for refusing the entry; it never connects. */
  readonly invalidError?: string;
  /** The entry is not a JSON object, so it has no `enabled` to switch: it can only be removed. */
  readonly notAnObject?: true;
  /** The entry's `exposure`, as written, when it names one the SDK accepts. */
  readonly exposure?: string;
  /** How many tools `toolExposure` names an exposure of their own. */
  readonly toolExposureCount?: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  /** Some of `command`, `args` or `url` was masked: the part that looked like a credential is not reported. */
  readonly masked: boolean;
  readonly envNames: readonly string[];
  readonly headerNames: readonly string[];
  /** An HTTP server without an `Authorization` header or `auth` signs in with OAuth when it answers 401. */
  readonly usesOAuth: boolean;
  /** Whether this host's OAuth state holds access tokens for the server, by name and URL. */
  readonly signedIn: boolean;
  /** Whether it holds anything for it: tokens, or what a sign-in stored before any (a registration, a verifier). */
  readonly oauthStateStored: boolean;
};

/**
 * Why one config file could not be used, as the gateway's own reader names it. The reason stays a plain string: it is
 * the host's diagnostic, and the panel that maps it to its own vocabulary owns that mapping.
 */
export type McpConfigFileProblem = { readonly reason: string; readonly error: string };

export type McpConfigFileInfo = {
  readonly scope: McpScope;
  readonly path: string;
  readonly exists: boolean;
  readonly problems: readonly McpConfigFileProblem[];
};

export type McpConfigRead = {
  readonly files: readonly McpConfigFileInfo[];
  readonly servers: readonly McpServerInfo[];
};

/** A folder's trust decision, as the host's own trust store records it. Read-only here: MCP only honours the store. */
export type ProjectTrust = {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly decision: boolean | null;
  /** The folder the nearest decision is recorded for, as the store keys it. */
  readonly decisionPath?: string;
  readonly inherited: boolean;
  /** Set when the trust store could not be read; the folder then counts as untrusted. */
  readonly error?: string;
};

export type McpTestState = "connected" | "needs-auth" | "failed";

export type McpTestResult = {
  readonly state: McpTestState;
  /** `failed` / `needs-auth`: why, masked. */
  readonly error?: string;
  /** `failed`, stdio: the last of what the server wrote to stderr, masked. */
  readonly stderr?: string;
  readonly toolCount?: number;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly durationMs: number;
  readonly testedAt: number;
};

/**
 * The bounds one tool listing is subject to, declared beside the shapes for the same reason the invocation bounds are:
 * they are part of the contract a caller writes against. They exist because a listing is a document a server authors
 * about itself, and a gateway caps a request body at 1 MiB but puts no total cap of its own on a JSON answer — so these
 * are the only bounds one listing has.
 */
export const MCP_LIST_DEADLINE_MS = 30_000;
/** How many of a server's tools one answer describes. What it did list stays in `total`, marked `truncated`. */
export const MCP_LIST_MAX_TOOLS = 256;
/** The characters of a tool name or description an answer carries. A longer one is cut at a UTF-8 boundary. */
export const MCP_LIST_MAX_TEXT_CHARS = 300;
/** The bytes one tool's input schema may cost as JSON. Over it the schema is withheld and the descriptor marked. */
export const MCP_LIST_MAX_SCHEMA_BYTES = 32 * 1024;
/** The bytes the whole answer may cost as JSON, which is what bounds a listing rather than a server's own count. */
export const MCP_LIST_MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * How many `tools/list` pages one listing reads. A server chooses its own page size and may hand back a cursor of its own
 * choosing, so without a page count the work one request asks for is unbounded. pi-mcp follows every cursor up to
 * 1 000 pages inside one deadline, which is a client's patience rather than a host's bound on a server it started: at
 * this bound a listing reads at most enough to fill its own answer, and says how far it read with `pages` and
 * `truncated`.
 */
export const MCP_LIST_MAX_PAGES = 8;

/**
 * What one request asks for: the tools one configured server has, as that server itself answers.
 *
 * Like an invocation it names a server the host already has configured and nothing else — no configuration, no
 * credential, no command — and it is folder-scoped exactly as `test` is, so a project server is listed only for a
 * folder this host's own trust store trusts. Unlike `test`, which reports a count and closes the connection it opened,
 * this answers what those tools are: the names, descriptions and argument schemas the server sent.
 */
export type McpToolListRequest = {
  readonly operation: "tools";
  readonly scope: McpScope;
  readonly cwd?: string;
  readonly workspaceId?: string;
  /** The configured server whose tools are listed. */
  readonly name: string;
};

/**
 * One tool, as its own server described it, for a surface that shows it to a person.
 *
 * `name` and `description` are the server's words, so they are masked like every other server-authored text this host
 * reports: a listing of a server that was handed a token can quote it. `inputSchema` is passed through as the server
 * wrote it, the way a configuration read reports a key's name and never its value — nothing resolves a `${NAME}` or a
 * `!command` inside a document, so no value of an entry can become part of an answer.
 */
export type McpToolDescriptor = {
  readonly name: string;
  /** The server's own description, first line only, masked. Absent when the server gave no line to show. */
  readonly description?: string;
  /** `annotations.readOnlyHint === true` and nothing else. An absent annotation is unknown, not a safe negative. */
  readonly readOnly?: boolean;
  /** How this host exposes it: the tool's own `toolExposure` when the entry names it, else the entry's `exposure`. */
  readonly exposure?: string;
  /** Whether that exposure came from the entry's per-tool map rather than the entry's own. */
  readonly exposureOverridden?: true;
  /** The server's own argument schema, absent when it was over the bound or was not a JSON object. */
  readonly inputSchema?: Record<string, unknown>;
  /** Something about this tool was cut or withheld: an over-long name or description, or an over-bound schema. */
  readonly truncated?: true;
};

/**
 * One server's listed tools, as this host read them at one moment. It is a snapshot of what the server answered: a
 * later request re-reads it. `pages` above one means the server paginates and this answer is the first pages of it.
 */
export type McpToolList = {
  readonly scope: McpScope;
  readonly server: string;
  /** The tools this answer describes. `total` is how many the server listed, so this may be the smaller number. */
  readonly tools: readonly McpToolDescriptor[];
  readonly total: number;
  /**
   * The listing was cut: the server listed more than this answer carries, or one of its tools was not a describable tool
   * at all. Either way an answer is a prefix of what was read and never a selection of it.
   */
  readonly truncated: boolean;
  readonly pages: number;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly durationMs: number;
  readonly listedAt: number;
};

/**
 * Why a listing produced no tools. Every one of these answers before or during a read that changes nothing on the host:
 * a listing starts a server the operator configured and closes it again, so a lost answer is worth asking for again
 * rather than treating as an outcome whose effects are unknown.
 */
export type McpToolListFailureCode =
  | "invalid_request"
  | "unknown-workspace"
  | "server-missing"
  | "server-invalid"
  | "server-disabled"
  | "not-authorized"
  | "needs-auth"
  | "cancelled"
  | "timeout"
  | "operation_failed";

/** One listing's answer. */
export type McpToolListResult =
  | { readonly ok: true; readonly value: McpToolList }
  | { readonly ok: false; readonly code: McpToolListFailureCode; readonly message: string };

export type McpSignInPhase = "authorize" | "finishing" | "done" | "failed" | "cancelled" | "expired";

export type McpSignInFlowInfo = {
  readonly flowId: string;
  readonly scope: McpScope;
  readonly name: string;
  readonly phase: McpSignInPhase;
  readonly authorizationUrl?: string;
  readonly redirectUrl?: string;
  readonly expiresInMs: number;
  readonly alreadySignedIn?: true;
  readonly result?: McpTestResult;
  readonly error?: string;
};

// ---------------------------------------------------------------------------
// /v1/mcp — invoking a selected tool
// ---------------------------------------------------------------------------

/**
 * The bounds one invocation is subject to, declared beside its shapes because they are part of the contract a caller
 * writes against: a call asks for a deadline no larger than this, and a result no larger than this comes back whole.
 */
export const MCP_INVOKE_DEADLINE_MS = 60_000;
export const MCP_INVOKE_MAX_DEADLINE_MS = 5 * 60_000;
/** The bytes of a tool result that are returned; a larger result is cut and marked truncated. */
export const MCP_INVOKE_MAX_RESULT_BYTES = 256 * 1024;
/** The bytes of arguments one call may carry. */
export const MCP_INVOKE_MAX_ARGUMENT_BYTES = 64 * 1024;

/**
 * What one tool call may carry.
 *
 * The caller names a server and a tool the host already has configured, and the conversation and workspace the call
 * belongs to. It names no configuration, no credential and no command: an invocation is a request to run a selection
 * that already exists on this host, so the host reads the entry from its own files and refuses a request that carries
 * one of those keys. `callId` is the caller's own identity for the call, so a repeat is recognizable rather than a
 * second anonymous call, and the host echoes it in the answer.
 */
export type McpToolCallRequest = {
  readonly operation: "invoke";
  readonly callId: string;
  /** The durable conversation the call belongs to, which this host does not know and the caller's selection does. */
  readonly conversationId: string;
  readonly workspaceId?: string;
  readonly scope: McpScope;
  readonly cwd?: string;
  /** The configured server, and the one tool of it that was selected for this conversation. */
  readonly server: string;
  readonly tool: string;
  readonly arguments?: Record<string, unknown>;
  /** How long the call may take: absent is the host's default, and a larger value is clamped to the host's maximum. */
  readonly deadlineMs?: number;
};

/** One block of a tool's result, in the two shapes a conversation can record: text and an image's bytes. */
export type McpToolContent = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/**
 * What one call answered: the tool's own result, cut to the host's output bound, and the identity it answered for.
 * Nothing here is a configuration value or a credential — a result is what the server said, masked.
 */
export type McpToolCallOutcome = {
  readonly callId: string;
  readonly server: string;
  readonly tool: string;
  readonly content: readonly McpToolContent[];
  /** The tool reported its own failure. That is an answer about the call, not a transport failure. */
  readonly isError: boolean;
  /** The result exceeded the host's output bound and was cut to it. */
  readonly truncated: boolean;
  readonly durationMs: number;
};

/** Why an invocation produced no outcome, named so a caller can tell a refusal from a call that may have run. */
export type McpInvocationFailureCode =
  | "invalid_request"
  | "unknown-workspace"
  | "server-missing"
  | "server-invalid"
  | "server-disabled"
  | "not-exposed"
  | "not-authorized"
  | "unknown-tool"
  | "arguments-too-large"
  | "busy"
  | "timeout"
  | "cancelled"
  | "needs-auth"
  | "operation_failed";

/**
 * One invocation's answer. A call that may have reached the server is never reported as a refusal: `timeout` and
 * `cancelled` state that its side effects are unknown rather than absent.
 */
export type McpToolCallResult =
  | { readonly ok: true; readonly value: McpToolCallOutcome }
  | { readonly ok: false; readonly code: McpInvocationFailureCode; readonly message: string };

/**
 * How a folder-scoped request names its folder. `cwd` is a path on the host's own filesystem, for a caller that
 * already resolved one (the Backend's control surface does); `workspaceId` is the browser's routing address, which
 * the host resolves against the folders it serves, so a client that only knows `/workspace/<id>` never synthesizes a
 * path and a folder belonging to another host is refused by the host itself rather than guessed at by the caller.
 */
export type McpHostRequest =
  | { readonly operation: "read"; readonly cwd?: string; readonly workspaceId?: string }
  /** The folder's trust decision, as this host's own trust store records it. Read-only. */
  | { readonly operation: "trust"; readonly cwd?: string; readonly workspaceId?: string }
  | { readonly operation: "write"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string; readonly config?: unknown; readonly requireNew?: boolean }
  /** Change named keys of an entry, keeping the rest of it: a value of `null` removes the key. */
  | { readonly operation: "patch"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string; readonly patch: Record<string, unknown> }
  | { readonly operation: "test"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string }
  | { readonly operation: "sign-in"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string }
  | { readonly operation: "sign-in-poll"; readonly flowId: string }
  | { readonly operation: "sign-in-paste"; readonly flowId: string; readonly redirectUrl: unknown }
  | { readonly operation: "sign-in-cancel"; readonly flowId: string }
  | { readonly operation: "sign-out"; readonly scope: McpScope; readonly cwd?: string; readonly workspaceId?: string; readonly name: string }
  /** List the tools one configured server has, as that server answers. See {@link McpToolListRequest}. */
  | McpToolListRequest
  /** Run one selected tool of one configured server. See {@link McpToolCallRequest}. */
  | McpToolCallRequest;

// ---------------------------------------------------------------------------
// /v1/providers/auth
// ---------------------------------------------------------------------------

/**
 * The credential kinds pi stores for a provider, as `Credential["type"]` names them. Declared here so a reader of the
 * JSON — the Web adapter, the panel above it — names a stored type without importing a runtime behind it.
 */
export type ProviderCredentialType = "api_key" | "oauth";

/** How one provider can be authenticated, read from the SDK's own provider definitions rather than a hardcoded list. */
export type ProviderAuthMethods = {
  /** The provider declares an API-key method (which may be ambient-only: env vars, AWS profile, ADC file). */
  readonly apiKey: boolean;
  /** The provider declares an OAuth method. */
  readonly oauth: boolean;
};

/**
 * One provider's connection state, as this host holds it.
 *
 * `configured` is the provider's own `resolve()` answering whether a request could be authenticated right now; it
 * covers both a stored credential and ambient sources. `storedType` is what `auth.json` holds for the provider, absent
 * when it holds nothing — a provider authenticated from the environment is configured with nothing stored.
 *
 * `maskedHint` is for display only and is never the value: it states a short prefix and suffix of a stored key so a
 * person can tell two keys apart. It is absent whenever nothing is stored, the stored credential is not an API key, or
 * the key is too short to disclose any part of.
 */
export type ProviderAuthStatus = {
  readonly providerId: string;
  readonly name: string;
  readonly methods: ProviderAuthMethods;
  readonly configured: boolean;
  /** The `source` the provider's own resolution reports, e.g. `ANTHROPIC_API_KEY` or `OAuth`. */
  readonly source?: string;
  readonly storedType?: ProviderCredentialType;
  readonly maskedHint?: string;
};

/**
 * One provider-auth operation. Every operation answers the whole listing as it stands after the operation, and a
 * mutation is write-only in an additional sense: nothing in that listing is or contains the value that was written.
 * `providerId` is validated against the providers this host serves before anything is read or written, so an unknown id
 * can neither create a file entry nor reveal which ids exist.
 */
export type ProviderAuthRequest =
  | { readonly operation: "list" }
  /** Store an API key. The key is written and never echoed: the answer is the listing. */
  | { readonly operation: "set-key"; readonly providerId: string; readonly apiKey: string }
  /**
   * Remove whatever is stored for a provider. Removing an entry that is not there is an idempotent success: a repeated
   * click, or a second panel, learns the same state rather than an error it cannot act on.
   *
   * `expectedType` is what the caller believed it was removing. When it does not match what is stored, the entry is left
   * alone and `credential_mismatch` is answered, so a stale panel cannot delete a credential that was replaced by a
   * different method in the meantime.
   */
  | { readonly operation: "remove"; readonly providerId: string; readonly expectedType?: ProviderCredentialType };

/**
 * Why a provider-auth operation failed. The codes are this surface's stable vocabulary; the `message` is sanitized
 * text for a person, and neither ever carries a credential value or a fragment of one.
 */
export type ProviderAuthFailureCode =
  | "invalid_request"
  | "unknown_provider"
  | "unsupported_operation"
  | "credential_mismatch"
  | "not_stored"
  | "auth_file_unreadable"
  | "lock_unavailable"
  | "permission_denied"
  | "operation_failed";

/**
 * One answer: the listing after the operation, or a refusal. There is deliberately no third shape — a caller that has to
 * narrow a mutation's own success value would be a caller that could render what it wrote.
 */
export type ProviderAuthResult =
  | { readonly ok: true; readonly value: readonly ProviderAuthStatus[] }
  | { readonly ok: false; readonly code: ProviderAuthFailureCode; readonly message: string };

// ---------------------------------------------------------------------------
// Provider sign-in: one upstream flow, owned by the gateway host
// ---------------------------------------------------------------------------

/**
 * One question a provider's own flow asks the person in front of a screen.
 *
 * It is the SDK's prompt, carried over unchanged: `select` answers with one of its option ids, and `manual_code` is the
 * step of a browser sign-in where the redirected address is pasted back because this host cannot receive it. A flow asks
 * one prompt at a time and a second answer before the first one lands is refused, so a panel never has two open questions
 * for the same flow.
 */
export type ProviderAuthPrompt =
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "select"; readonly message: string; readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[] }
  | { readonly type: "manual_code"; readonly message: string; readonly placeholder?: string };

/**
 * What a provider's flow says is happening, as the SDK reports it.
 *
 * The address a person has to open is a browser's business, so it travels as a link in an answer rather than as a page
 * this host serves. `userCode` is the code a device flow shows, and it is shown on purpose: a device code is only useful
 * together with the verification URI and expires with the flow.
 */
export type ProviderAuthEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly { readonly url: string; readonly label?: string }[] }
  | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
  | { readonly type: "device_code"; readonly userCode: string; readonly verificationUri: string; readonly intervalSeconds?: number; readonly expiresInSeconds?: number }
  | { readonly type: "progress"; readonly message: string };

/**
 * Where one sign-in stands.
 *
 * `waiting_for` is what the panel may offer next: `input` when a prompt is open, `browser` when the flow is waiting for
 * the person to finish in another browser, and both when the browser step and a paste-back question are open at once.
 * A terminal phase leaves nothing to offer and keeps answering for a window after it ends, so a poll that arrives late
 * still learns what happened rather than an id that never existed. `succeeded` carries the listing as the host now holds
 * it — that is how a panel learns what a flow stored without the credential ever travelling back through it. A cancelled
 * or expired flow reports the listing unchanged, because the file was not touched.
 */
export type ProviderLoginPhase = "running" | "waiting_for_input" | "waiting_for_browser" | "succeeded" | "failed" | "cancelled" | "expired";

export type ProviderLoginInfo = {
  readonly flowId: string;
  readonly providerId: string;
  readonly phase: ProviderLoginPhase;
  readonly waitingFor: readonly ("browser" | "input")[];
  /** The open prompt, present exactly while `phase` is `waiting_for_input`. */
  readonly prompt?: ProviderAuthPrompt;
  /** What the flow last said, newest of its own kind kept: a panel shows the address it is waiting for, not a history. */
  readonly event?: ProviderAuthEvent;
  /** Milliseconds until this host stops waiting. `0` in a terminal phase, which holds nothing open. */
  readonly expiresInMs: number;
  /** Only in a terminal phase: the listing as the host now holds it, or why the flow ended the way it did. */
  readonly value?: readonly ProviderAuthStatus[];
  readonly code?: ProviderLoginFailureCode;
  readonly message?: string;
  /** Only on `succeeded`: what the flow ended with, as its own kind, so a panel can say "signed in" apart from "key saved". */
  readonly storedType?: ProviderCredentialType;
};

/**
 * The sign-in operations, beside the listing and the API-key write path.
 *
 * A flow id is this host's: unguessable, bounded by a deadline, and answered only for the caller that started it.
 * `caller` is the identity the client ingress admitted the request as — a device credential id, or that ingress's own Web
 * session — stated by the ingress and never read from a client body, because one host bearer is shared by every client of
 * one ingress and is otherwise the only thing a host request arrives with. A flow is a waiting question with a browser
 * address attached to it, so another admitted caller must not answer or cancel it: a mismatch is refused exactly as an
 * unknown id is, which names nothing about the flows this host is running.
 *
 * Nothing in a `login-` operation carries a provider credential. The answer a person types goes to the flow that asked for
 * it; the credential the flow produces is stored by this host and never travels back through the caller.
 */
export type ProviderLoginRequest =
  | { readonly operation: "login-start"; readonly providerId: string; readonly caller: string }
  | { readonly operation: "login-poll"; readonly flowId: string; readonly caller: string }
  /**
   * The flow one caller has open for one provider, read without touching it.
   *
   * A client that lost its address — a reloaded panel, a second tab, a reconnect — asks this and resumes, which is also
   * why a repeated sign-in click cannot start a second flow for one account: the panel finds the flow it already has. A
   * caller with no open flow for that provider is answered `flow_unknown`, which is a state rather than an error there:
   * the same name an ended flow answers, and both mean "there is nothing to follow".
   */
  | { readonly operation: "login-status"; readonly providerId: string; readonly caller: string }
  /** Hand the flow the answer its current prompt asks for. A code or a pasted redirect address is that answer. */
  | { readonly operation: "login-submit"; readonly flowId: string; readonly caller: string; readonly answer: unknown }
  | { readonly operation: "login-cancel"; readonly flowId: string; readonly caller: string }
  /**
   * Drop every flow this caller has open, without following them.
   *
   * Only a client ingress has the fact this needs: a device credential it admitted was revoked. A revoked caller cannot
   * reach a flow any more — its next request is refused at the entrance — so it can neither answer nor cancel one, and a
   * flow nobody can act on is a flow that would sit out its deadline holding a provider exchange. The ingress issues
   * this best-effort on exactly that event; a client never does, and a caller can only ever name its own flows.
   */
  | { readonly operation: "login-forget"; readonly caller: string };

/**
 * Why a sign-in operation was refused.
 *
 * It is the provider-auth vocabulary plus the names a flow needs: `flow_unknown` for an id that never existed, is not this
 * caller's, ended past its readable window, or belongs to a host service that restarted; `flow_not_waiting` for an answer
 * handed to a flow with no open question; `answer_invalid` for one the open question would not take; `too_many_flows` for
 * a host already at its limit; and the provider-auth codes for what the flow itself ran into — a provider with no sign-in
 * method, a file that could not be written, a lock another writer holds. None of them carries a credential or a typed answer.
 */
export type ProviderLoginFailureCode =
  | ProviderAuthFailureCode
  | "flow_unknown"
  | "flow_not_waiting"
  | "answer_invalid"
  | "too_many_flows";

/**
 * The answer to dropping a caller's flows: how many this host ended. Nothing about them is reported, because the caller
 * that is now refused at the entrance must not learn what its own flows were doing.
 */
export type ProviderLoginDropped = { readonly dropped: number };

/** What {@link ProviderLoginRequest}'s `login-forget` answers: a count, and nothing about the flows it ended. */
export type ProviderLoginForgetResult =
  | { readonly ok: true; readonly value: ProviderLoginDropped }
  | { readonly ok: false; readonly code: ProviderLoginFailureCode; readonly message: string };

/**
 * One sign-in answer: the flow as it now stands, or a refusal. A started flow, an answered prompt and a cancelled flow all
 * report the same shape, so a caller never has to know which operation it sent to render what happened.
 *
 * A client that already maps `unsupported_operation` to a named limit and `lock_unavailable` to a retry maps a sign-in the
 * same way; `flow_unknown` is the one case that means "start again", and it is not a limit of the deployment.
 */
export type ProviderLoginResult =
  | { readonly ok: true; readonly value: ProviderLoginInfo | ProviderLoginDropped }
  | { readonly ok: false; readonly code: ProviderLoginFailureCode; readonly message: string };

/**
 * One host answer. `value` stays `unknown`: it is whatever the named operation answers, so a caller that
 * knows which operation it sent is the one that narrows it.
 */
export type McpHostResult =
  | { readonly ok: true; readonly value: unknown }
  /** `flow` rides on a paste refusal, so the caller keeps showing the flow that is still waiting. */
  | { readonly ok: false; readonly code: string; readonly message: string; readonly path?: string; readonly flow?: McpSignInFlowInfo };
