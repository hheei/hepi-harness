import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTROL_TIMEOUT_MS, GatewayHostClient, HostTransportError, type GatewayHostClientOptions } from "../src/index.ts";

const TOKEN = "{{SECRET_ctrl7w1z}}";
const ORIGIN = "http://127.0.0.1:7042";

type Call = { readonly url: string; readonly init: RequestInit };

/** A fetch that records what the control capability sent and answers from the test. */
function recording(respond: (call: Call) => Promise<Response> | Response): { readonly calls: Call[]; readonly fetch: typeof fetch } {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return await respond(call);
	};
	return { calls, fetch: impl as unknown as typeof fetch };
}

/** A gateway answer: a JSON body and the status the route answers with. */
function answer(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch that fails the way an unreachable or dropped connection does. */
function lost(): typeof fetch {
	return (async () => {
		throw new TypeError("fetch failed");
	}) as unknown as typeof fetch;
}

/** A fetch that never answers until its signal aborts, so a bound is what ends the call. */
function pending(): typeof fetch {
	return (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		return await new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const fail = () => reject(signal?.reason ?? new Error("aborted"));
			if (signal?.aborted) fail();
			else signal?.addEventListener("abort", fail, { once: true });
		});
	}) as unknown as typeof fetch;
}

function control(fetchImpl: typeof fetch, extra: Partial<GatewayHostClientOptions> = {}) {
	return new GatewayHostClient({ gatewayOrigin: ORIGIN, gatewayToken: TOKEN, fetch: fetchImpl, ...extra }).control;
}

/** The error a call rejected with, asserted to be this package's typed transport failure. */
async function rejection(call: Promise<unknown>): Promise<HostTransportError> {
	try {
		await call;
	} catch (error) {
		assert.ok(error instanceof HostTransportError, "expected a HostTransportError, got " + String(error));
		return error;
	}
	throw new Error("the call was expected to fail");
}

/** What the recorded call sent: the request body as this package encoded it, and the bearer header it carried. */
function sent(call: Call): { readonly body: Record<string, unknown>; readonly authorization: string; readonly contentType: string | undefined } {
	return {
		body: JSON.parse(String(call.init.body)) as Record<string, unknown>,
		authorization: (call.init.headers as Record<string, string>).authorization,
		contentType: (call.init.headers as Record<string, string>)["content-type"],
	};
}

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

test("a workspace listing is read-only, answered as the shared declaration describes it", async () => {
	const recorder = recording(() => answer({ ok: true, value: [{ id: "w1", root: "/srv/w1" }] }));
	const result = await control(recorder.fetch).workspaces({ operation: "list" });

	assert.deepEqual(result, { ok: true, value: [{ id: "w1", root: "/srv/w1" }] });
	assert.equal(recorder.calls[0].url, ORIGIN + "/v1/workspaces");
	const request = sent(recorder.calls[0]);
	assert.equal(request.authorization, "Bearer " + TOKEN);
	assert.equal(request.contentType, "application/json");
	assert.deepEqual(request.body, { operation: "list" });
});

test("a lost workspace listing is offline, because repeating it cannot change the host", async () => {
	const error = await rejection(control(lost()).workspaces({ operation: "list" }));
	assert.equal(error.code, "gateway_offline");
});

test("a lost workspace registration is an unknown outcome, never an offline failure to retry", async () => {
	const recorder = recording(() => {
		throw new TypeError("fetch failed");
	});
	const error = await rejection(control(recorder.fetch).workspaces({ operation: "register", workspaceId: "w1", root: "/srv/w1" }));

	assert.equal(error.code, "outcome_unknown");
	assert.equal(recorder.calls.length, 1, "an unknown mutation is not sent again");
	assert.equal(sent(recorder.calls[0]).body.workspaceId, "w1");
});

test("a workspace conflict the gateway answered is its own result, not a transport failure", async () => {
	const conflict = await control(recording(() => answer({ ok: false, code: "workspace_conflict" }, 409)).fetch).workspaces({ operation: "register", workspaceId: "w1", root: "/srv/w1" });
	assert.deepEqual(conflict, { ok: false, code: "workspace_conflict" });
});

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

test("a worktree listing keeps the host's own fields, optional compatibility fields included", async () => {
	const listing = { projectRoot: "/srv/p", isGit: true, isTopLevel: true, currentWorktreePath: "/srv/p", worktrees: [{ path: "/srv/p", branch: "main", isMain: true }] };
	const result = await control(recording(() => answer({ ok: true, value: listing })).fetch).worktrees({ operation: "list", workspaceId: "w1" });
	assert.deepEqual(result, { ok: true, value: listing });
});

test("a lost worktree create is an unknown outcome: a lost response is never an ordinary refusal", async () => {
	const error = await rejection(control(lost()).worktrees({ operation: "create", workspaceId: "w1", branch: "feature" }));
	assert.equal(error.code, "outcome_unknown");
	assert.notEqual(error.code, "gateway_offline");
});

test("a lost worktree remove is an unknown outcome too, and is not replayed", async () => {
	const recorder = recording(() => {
		throw new TypeError("fetch failed");
	});
	const error = await rejection(control(recorder.fetch).worktrees({ operation: "remove", workspaceId: "w1", path: "/srv/w1-feature" }));
	assert.equal(error.code, "outcome_unknown");
	assert.equal(recorder.calls.length, 1);
});

test("a lost worktree listing is only offline, because nothing was changed", async () => {
	const error = await rejection(control(lost()).worktrees({ operation: "list", workspaceId: "w1" }));
	assert.equal(error.code, "gateway_offline");
});

test("git's own worktree refusals keep their names instead of collapsing into one generic failure", async () => {
	const dirty = await control(recording(() => answer({ ok: false, code: "dirty", message: "uncommitted work" })).fetch).worktrees({ operation: "remove", workspaceId: "w1", path: "/srv/w1-feature" });
	const unsupported = await control(recording(() => answer({ ok: false, code: "not_supported" })).fetch).worktrees({ operation: "create", workspaceId: "w1", branch: "b" });

	assert.deepEqual(dirty, { ok: false, code: "dirty", message: "uncommitted work" });
	assert.deepEqual(unsupported, { ok: false, code: "not_supported" });
});

test("a worktree refusal the gateway answered is not an unknown outcome", async () => {
	const refused = await control(recording(() => answer({ ok: false, code: "main_worktree" }, 400)).fetch).worktrees({ operation: "remove", workspaceId: "w1", path: "/srv/p" });
	assert.deepEqual(refused, { ok: false, code: "main_worktree" });
});

// ---------------------------------------------------------------------------
// workbench
// ---------------------------------------------------------------------------

test("every workbench operation is a read: a lost answer is offline, never an unknown mutation", async () => {
	for (const operation of ["files", "read", "changes", "diff"] as const) {
		const error = await rejection(control(lost()).workbench({ workspaceId: "w1", operation, ...(operation === "files" ? {} : { path: "/srv/w1/a.txt" }) }));
		assert.equal(error.code, "gateway_offline", operation + " must stay a read");
	}
});

test("a workbench refusal keeps the host's own code even though it answers with a 409", async () => {
	const denied = await control(recording(() => answer({ ok: false, code: "path_denied" }, 409)).fetch).workbench({ workspaceId: "w1", operation: "read", path: "/etc/passwd" });
	assert.deepEqual(denied, { ok: false, code: "path_denied" });
});

test("a workbench preview is handed back as the gateway wrote it", async () => {
	const file = { path: "/srv/w1/a.txt", content: "hi", truncated: false, binary: false, sizeBytes: 2 };
	const read = await control(recording(() => answer({ ok: true, value: file })).fetch).workbench({ workspaceId: "w1", operation: "read", path: "/srv/w1/a.txt" });
	assert.deepEqual(read, { ok: true, value: file });
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("an MCP read passes the host's masked values through unchanged", async () => {
	const body = { ok: true, value: { files: [], servers: [{ name: "srv", scope: "global", sourcePath: "/home/u/.mcp.json", enabled: true, masked: true, envNames: ["TOKEN"], headerNames: [], usesOAuth: false, signedIn: false, oauthStateStored: false, command: "npx", args: ["-y", "***"] }] } };
	const result = await control(recording(() => answer(body)).fetch).mcp({ operation: "read" });
	assert.deepEqual(result, body);
});

/** One listing, as a caller asking what one configured server has would send it. */
const LIST = { operation: "tools", scope: "global", name: "fixture" } as const;

test("a lost MCP read is offline while a lost MCP write is an unknown outcome", async () => {
	const read = await rejection(control(lost()).mcp({ operation: "read" }));
	// A listing starts nothing a repetition could duplicate: it connects a server the operator configured and closes it
	// again, so a lost answer is this host being unreachable and asking again is the right thing to do. That reading
	// follows from the operation not being named a mutation.
	const listed = await rejection(control(lost()).mcp(LIST));
	const write = await rejection(control(lost()).mcp({ operation: "write", scope: "global", name: "srv", config: { command: "npx" } }));
	const patch = await rejection(control(lost()).mcp({ operation: "patch", scope: "global", name: "srv", patch: { enabled: true } }));
	const signIn = await rejection(control(lost()).mcp({ operation: "sign-in", scope: "global", name: "srv" }));
	const signOut = await rejection(control(lost()).mcp({ operation: "sign-out", scope: "global", name: "srv" }));

	assert.equal(read.code, "gateway_offline");
	assert.equal(listed.code, "gateway_offline", "a lost listing is a transport failure, not an unknown outcome");
	for (const [name, error] of [["write", write], ["patch", patch], ["sign-in", signIn], ["sign-out", signOut]] as const) assert.equal(error.code, "outcome_unknown", name + " is a mutation");
});

/**
 * A listing's answer is a document a caller shows a person, so neither half of it may be reshaped on the way:
 * the descriptors pass through whole, and the reason a listing produced none keeps the host's own name.
 */
test("a listing passes the host's descriptors through unchanged, and keeps its own refusal code", async () => {
	const listed = {
		scope: "global",
		server: "fixture",
		tools: [{ name: "search", description: "Search the docs", readOnly: true, exposure: "direct", inputSchema: { type: "object" } }],
		total: 1,
		truncated: false,
		pages: 1,
		durationMs: 12,
		listedAt: 1,
	};
	const recorder = recording(() => answer({ ok: true, value: listed }));
	const result = await control(recorder.fetch).mcp(LIST);
	assert.deepEqual(result, { ok: true, value: listed }, "a descriptor answer is not reshaped by the transport");
	assert.deepEqual(sent(recorder.calls[0]).body, LIST, "a listing names a server and nothing else");
	assert.equal(recorder.calls[0].url, ORIGIN + "/v1/mcp");

	// The refusal vocabulary is the host service's own, so a listing's reason reaches a caller by name rather than
	// as a transport failure the caller cannot tell a timeout from a server that was never there.
	const refused = await control(recording(() => answer({ ok: false, code: "needs-auth", message: "the server requires a sign-in" })).fetch).mcp(LIST);
	assert.deepEqual(refused, { ok: false, code: "needs-auth", message: "the server requires a sign-in" });
});
test("an MCP refusal keeps the host service's own code, not a generic transport failure", async () => {
	const unavailable = await control(recording(() => answer({ ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" })).fetch).mcp({ operation: "read" });
	assert.deepEqual(unavailable, { ok: false, code: "mcp_unavailable", message: "this gateway host serves no MCP capability" });
});

test("a sign-in refusal keeps the flow the host is still waiting on", async () => {
	const flow = { flowId: "f1", scope: "global", name: "srv", phase: "authorize", authorizationUrl: "https://auth.example/x", expiresInMs: 1000 };
	const refused = await control(recording(() => answer({ ok: false, code: "redirect-state-mismatch", message: "state", flow })).fetch).mcp({ operation: "sign-in-paste", flowId: "f1", redirectUrl: "http://127.0.0.1/cb" });
	assert.deepEqual(refused, { ok: false, code: "redirect-state-mismatch", message: "state", flow });
});

// ---------------------------------------------------------------------------
// installs
// ---------------------------------------------------------------------------

test("an installation is addressed with the workspace the binding names", async () => {
	const recorder = recording(() => answer({ ok: true, value: { path: "/home/u/.hepi/skills/s", files: ["SKILL.md"] } }));
	const published = await control(recorder.fetch, { workspaceId: "w1" }).installs<{ path: string }>({ operation: "publishDirectory", scope: "global", directory: "s", files: [{ path: "SKILL.md", content: "# s", encoding: "utf8" }] });

	assert.deepEqual(published, { ok: true, value: { path: "/home/u/.hepi/skills/s", files: ["SKILL.md"] } });
	assert.equal(recorder.calls[0].url, ORIGIN + "/v1/installs");
	assert.equal(sent(recorder.calls[0]).body.workspaceId, "w1");
	assert.equal(sent(recorder.calls[0]).body.operation, "publishDirectory");
});

test("a per-call workspace overrides the one the capability was built with", async () => {
	const recorder = recording(() => answer({ ok: true, value: { path: "/srv/w2/s", files: [] } }));
	await control(recorder.fetch, { workspaceId: "w1" }).installs({ operation: "inspectDirectory", scope: "workspace", directory: "s" }, { workspaceId: "w2" });
	assert.equal(sent(recorder.calls[0]).body.workspaceId, "w2");
});

test("a lost installation is an unknown outcome with no replay, exactly as this surface always reported it", async () => {
	const publisher = recording(() => {
		throw new TypeError("fetch failed");
	});
	const published = await control(publisher.fetch, { workspaceId: "w1" }).installs({ operation: "publishDirectory", scope: "global", directory: "s", files: [] });

	assert.deepEqual(published, { ok: false, error: { code: "outcome_unknown", message: "the gateway installation outcome is unknown; nothing was replayed" } });
	assert.equal(publisher.calls.length, 1, "an unknown installation is not sent again");

	const inspector = recording(() => {
		throw new TypeError("fetch failed");
	});
	const inspected = await control(inspector.fetch, { workspaceId: "w1" }).installs({ operation: "inspectDirectory", scope: "global", directory: "s" });
	// One spelling for the whole surface: the install route has always reported every lost call this way, so a caller
	// moving to this capability sees no changed result.
	assert.deepEqual(inspected, { ok: false, error: { code: "outcome_unknown", message: "the gateway installation outcome is unknown; nothing was replayed" } });
	assert.equal(inspector.calls.length, 1);
});

test("an installation the gateway refused is a known failure, spelled as this surface has always spelled it", async () => {
	const refused = await control(recording(() => answer({ ok: false, code: "invalid_request" }, 400)).fetch, { workspaceId: "w1" }).installs({ operation: "publishDirectory", scope: "global", directory: "s", files: [] });
	assert.deepEqual(refused, { ok: false, error: { code: "unknown", message: "the gateway refused the installation request: 400" } });
});

test("an installation refusal the host itself names is passed through, unchanged", async () => {
	const refused = await control(recording(() => answer({ ok: false, error: { code: "conflict", message: "that directory exists" } })).fetch, { workspaceId: "w1" }).installs({ operation: "publishDirectory", scope: "global", directory: "s", files: [], overwrite: false });
	assert.deepEqual(refused, { ok: false, error: { code: "conflict", message: "that directory exists" } });
});

test("an installation with no bound workspace is a named protocol error, not a request to the wrong host", async () => {
	const error = await rejection(control(lost()).installs({ operation: "readLock", scope: "global" }) as Promise<unknown>);
	assert.equal(error.code, "protocol_error");
});

// ---------------------------------------------------------------------------
// invocation
// ---------------------------------------------------------------------------

/** One invocation, as the backend's durable tool lifecycle would send it. */
const CALL = { operation: "invoke", callId: "call-1", conversationId: "conversation-1", scope: "global", server: "fixture", tool: "record", arguments: { note: "hello" } } as const;

test("an invocation is a mutation on its own route, answered with the tool result itself", async () => {
	const outcome = { callId: "call-1", server: "fixture", tool: "record", content: [{ type: "text", text: "{\"recorded\":\"hello\"}" }], isError: false, truncated: false, durationMs: 4 };
	const recorder = recording(() => answer({ ok: true, value: outcome }));
	const result = await control(recorder.fetch).invoke(CALL);

	assert.deepEqual(result, { ok: true, value: outcome });
	assert.equal(recorder.calls[0].url, ORIGIN + "/v1/mcp");
	const request = sent(recorder.calls[0]);
	assert.equal(request.authorization, "Bearer " + TOKEN);
	// The body is the call and nothing else: no configuration, no command, no credential.
	assert.deepEqual(request.body, CALL);
	assert.deepEqual(Object.keys(request.body).sort(), ["arguments", "callId", "conversationId", "operation", "scope", "server", "tool"]);
});

test("a lost invocation is an unknown outcome, never a refusal a caller might repeat", async () => {
	// A tool call can have external side effects, so the connection dropping after the request was sent is not a
	// failure that says "nothing happened": it is exactly the state a caller must not retry.
	const recorder = recording(() => {
		throw new TypeError("fetch failed");
	});
	const error = await rejection(control(recorder.fetch).invoke(CALL));
	assert.equal(error.code, "outcome_unknown");
	assert.equal(recorder.calls.length, 1, "an unknown invocation is not sent again");
});

test("an invocation the host refused keeps the host's own code, and a body this call does not accept is a protocol error", async () => {
	const refused = await control(recording(() => answer({ ok: false, code: "timeout", message: "the call did not finish within its deadline; the server may have acted" })).fetch).invoke(CALL);
	assert.deepEqual(refused, { ok: false, code: "timeout", message: "the call did not finish within its deadline; the server may have acted" });

	// A success body without a call identity is not a tool result, so it is refused rather than recorded as one.
	const malformed = await rejection(control(recording(() => answer({ ok: true, value: { content: [] } })).fetch).invoke(CALL));
	assert.equal(malformed.code, "protocol_error");
});

test("an invocation a caller cancels is a cancellation, not a timeout", async () => {
	const controller = new AbortController();
	const call = control(pending()).invoke(CALL, { signal: controller.signal });
	controller.abort();
	const error = await rejection(call);
	assert.equal(error.code, "aborted");
});

// ---------------------------------------------------------------------------
// shared transport behaviour
// ---------------------------------------------------------------------------

test("a malformed success body is a protocol error, never an empty result", async () => {
	const malformed = await rejection(control(recording(() => new Response("{not json", { status: 200 })).fetch).workspaces({ operation: "list" }));
	const wrong = await rejection(control(recording(() => answer({ ok: true })).fetch).worktrees({ operation: "list", workspaceId: "w1" }));
	assert.equal(malformed.code, "protocol_error");
	assert.equal(wrong.code, "protocol_error");
});

test("each route keeps its own bound, and a caller may name a tighter one", async () => {
	const recorder = recording(() => answer({ ok: true, value: [] }));
	await control(recorder.fetch).mcp({ operation: "read" }, { timeoutMs: 5 });
	assert.deepEqual(Object.values(CONTROL_TIMEOUT_MS), [10_000, 5 * 60_000, 20_000, 60_000, 5 * 60_000 + 30_000, 60_000]);

	const timedOut = await rejection(control(pending()).worktrees({ operation: "list", workspaceId: "w1" }, { timeoutMs: 10 }));
	assert.equal(timedOut.code, "timeout");
});

test("a caller's own cancellation reaches the request and is reported as a cancellation", async () => {
	const controller = new AbortController();
	const call = control(pending()).mcp({ operation: "read" }, { signal: controller.signal });
	controller.abort();
	const error = await rejection(call);
	assert.equal(error.code, "aborted");
});

test("an unauthorized answer is the gateway's credential refusal, not a domain refusal", async () => {
	const error = await rejection(control(recording(() => answer({ ok: false, code: "unauthorized" }, 401)).fetch).workspaces({ operation: "list" }));
	assert.equal(error.code, "unauthorized");
	assert.equal(error.status, 401);
});

test("no control failure carries the token", async () => {
	const errors = [
		await rejection(control(lost()).workspaces({ operation: "register", workspaceId: "w1", root: "/srv/w1" })),
		await rejection(control(recording(() => answer({ ok: false, code: "unauthorized" }, 401)).fetch).worktrees({ operation: "list", workspaceId: "w1" })),
		await rejection(control(pending()).workbench({ workspaceId: "w1", operation: "files" }, { timeoutMs: 10 })),
	];
	for (const error of errors) {
		assert.ok(!error.message.includes(TOKEN), "the message leaked the token: " + error.message);
		assert.ok(!String(error.stack).includes(TOKEN), "the stack leaked the token");
	}
});
