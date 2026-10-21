import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionResources } from "../src/execution-resources.ts";

/**
 * The client seam for execution-side resources, at its own boundary: one connection scope, one selected execution
 * target, and the Backend's own contract on the other side.
 *
 * What is asserted here is what a surface can rely on and nothing about a host: the address is the connection's, the
 * credential is never in a URL and never sent to another origin, a target names a workspace and never a computer, a
 * refusal keeps the Backend's own code, and an answer that arrives after the selection moved is dropped. The host-side
 * behaviour — which account and which machine the write really landed on — is the ingress test's subject, over real
 * HTTP against real gateways.
 */

const ORIGIN = "http://gateway.test";
const INVENTORY = { workspaceId: "alpha", host: { user: "operator", home: "/home/operator" }, skills: [] };

/**
 * One installation with every field its provenance may carry. It is here because a reader that renamed a field on the
 * way through would leave a surface asking the repository about a revision it can no longer name.
 */
const INSTALLED = {
	workspaceId: "alpha",
	host: { user: "operator", home: "/home/operator" },
	skills: [{
		name: "notes", directory: "notes", description: "Take notes",
		filePath: "/work/alpha/.agents/skills/notes/SKILL.md",
		scope: "project", revision: "unknown", disableModelInvocation: true, availableVersion: "1.2.0",
		install: {
			scope: "workspace", state: "unchanged", source: "github:notes@aaaa1111bbbb2222", sourceType: "github",
			ref: "aaaa1111bbbb2222", version: "1.2.0", repository: "anthropics/skills", documentPath: "skills/notes/SKILL.md",
			path: "/work/alpha/.agents/skills/notes", directory: "notes", files: { "SKILL.md": "0".repeat(64) },
		},
	}],
};

type Call = { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body?: unknown; readonly credentials?: string };

/** A stub connection: the requests it was handed, and the answer it hands back for each. */
function connection(answers: readonly (Response | (() => Promise<Response>))[], credential: { kind: "cookie" } | { kind: "bearer"; token: string } = { kind: "cookie" }) {
	const calls: Call[] = [];
	let index = 0;
	const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({
			url, method: init.method ?? "GET",
			headers: Object.fromEntries(new Headers(init.headers as HeadersInit).entries()),
			...(typeof init.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
			...(init.credentials === undefined ? {} : { credentials: init.credentials }),
		});
		const answer = answers[index++];
		if (answer === undefined) throw new Error("the connection was asked for more than this test queued: " + url);
		return typeof answer === "function" ? await answer() : answer;
	}) as typeof globalThis.fetch;
	return { calls, fetch, resources: () => createExecutionResources({ origin: ORIGIN, credential, fetch }) };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("an inventory names the selected workspace and never a computer", async () => {
	const stub = connection([json(INVENTORY)]);
	const target = stub.resources().select("alpha");
	const listed = await target.inventory();
	assert.equal(listed.ok, true);
	assert.deepEqual(listed.ok ? listed.value : undefined, INVENTORY);
	const [call] = stub.calls;
	assert.equal(call!.url, ORIGIN + "/api/skill-market/inventory?workspaceId=alpha");
	assert.equal(call!.credentials, "same-origin", "a cookie is attached by the browser, never read by script");
	assert.equal(call!.headers.authorization, undefined, "a cookie connection sends no bearer");
	assert.ok(!call!.url.includes("hostId"), "the client does not choose the execution host: " + call!.url);
});

test("an installation keeps every provenance field under its own name", async () => {
	const stub = connection([json(INSTALLED)]);
	const listed = await stub.resources().select("alpha").inventory();
	assert.equal(listed.ok, true);
	const [skill] = listed.ok ? listed.value.skills : [];
	assert.deepEqual(skill?.install, {
		scope: "workspace", state: "unchanged", source: "github:notes@aaaa1111bbbb2222", sourceType: "github",
		ref: "aaaa1111bbbb2222", version: "1.2.0", repository: "anthropics/skills", documentPath: "skills/notes/SKILL.md",
		path: "/work/alpha/.agents/skills/notes", directory: "notes", files: { "SKILL.md": "0".repeat(64) },
	});
	assert.equal(skill?.availableVersion, "1.2.0");
});

test("a device bearer is presented to the connection's own Gateway and nothing else", async () => {
	const stub = connection([json({ ...INVENTORY, workspaceId: "alpha" })], { kind: "bearer", token: "device-token" });
	const target = stub.resources().select("alpha");
	assert.equal((await target.inventory()).ok, true);
	const [call] = stub.calls;
	assert.equal(call!.headers.authorization, "Bearer device-token");
	assert.equal(call!.credentials, "omit", "a bearer states its own authority instead of riding on a cookie");
	assert.ok(!call!.url.includes("device-token"), "a credential is never in a URL");
});

test("an install, a switch and a revision check name the target's scope and forward adoption only when asked", async () => {
	const installed = { installed: { name: "notes", scope: "workspace", path: "/srv/work/.agents/skills/notes", files: ["SKILL.md"], contentHash: "a".repeat(64) }, reload: { ok: true } };
	const stub = connection([
		json(installed),
		json({ results: [{ directory: "notes", changed: true }], scope: "workspace" }),
		json({ state: "unknown" }),
		json(installed),
	]);
	const target = stub.resources().select("beta");
	assert.equal((await target.install({ id: "repository:notes@1.0.0", scope: "workspace" })).ok, true);
	assert.equal((await target.toggle({ directories: ["notes"], disableModelInvocation: true, scope: "workspace" })).ok, true);
	assert.equal((await target.check({ name: "notes", scope: "workspace" })).ok, true);
	assert.equal((await target.update({ id: "repository:notes@1.1.0", name: "notes", scope: "workspace", confirm: true, files: { "SKILL.md": "b".repeat(64) }, conversationId: "c1" })).ok, true);

	const [install, toggle, check, update] = stub.calls;
	assert.deepEqual(install!.body, { id: "repository:notes@1.0.0", scope: "workspace", workspaceId: "beta" }, "no conversation was named, so none is sent");
	assert.deepEqual(toggle!.body, { directories: ["notes"], disableModelInvocation: true, scope: "workspace", workspaceId: "beta" });
	assert.equal(check!.url, ORIGIN + "/api/skill-market/check?workspaceId=beta&name=notes&scope=workspace");
	assert.equal(update!.body && (update!.body as { conversationId?: string }).conversationId, "c1");
	assert.equal(update!.body && (update!.body as { confirm?: boolean }).confirm, true);
	for (const call of stub.calls) assert.ok(!call.url.includes("hostId") && !JSON.stringify(call.body ?? {}).includes("hostId"), "no request names a host: " + call.url);
});

test("a definition save sends the workspace, the scope and the document, and a refusal keeps its issues", async () => {
	const stub = connection([json({ code: "unsupported_capability", error: "this build cannot execute MCP servers", field: "mcp_servers", issues: [{ field: "mcp_servers", code: "unsupported_capability", message: "no" }] }, 400)]);
	const target = stub.resources().select("remote-prod");
	const refused = await target.saveDefinition({ scope: "project", name: "reviewer", document: "---\nname: reviewer\n---\nbody\n" });
	assert.equal(refused.ok, false);
	assert.equal(refused.ok ? undefined : refused.error.kind, "invalid");
	assert.equal(refused.ok ? undefined : refused.error.code, "unsupported_capability");
	assert.deepEqual(refused.ok ? undefined : refused.error.issues, [{ field: "mcp_servers", code: "unsupported_capability", message: "no" }]);
	const [call] = stub.calls;
	assert.equal(call!.method, "PUT");
	assert.deepEqual(call!.body, { workspaceId: "remote-prod", scope: "project", name: "reviewer", document: "---\nname: reviewer\n---\nbody\n" });
});

test("the host's own refusal word is kept, and an unknown shape is not an empty answer", async () => {
	const stub = connection([
		json({ error: { code: "confirmation_required", message: "the installed skill is locally-modified; confirm the overwrite to replace it" }, state: "locally-modified" }, 409),
		json({ error: { code: "unknown_workspace", message: "this deployment binds no workspace gone" } }, 404),
		json({ error: { code: "not_configured", message: "resource loading is not configured" } }, 404),
		json({ error: "backend unreachable" }, 503),
		json({ unexpected: true }),
	]);
	const target = stub.resources().select("alpha");
	const stale = await target.update({ id: "repository:notes@1.1.0", name: "notes", scope: "workspace" });
	assert.equal(stale.ok ? undefined : stale.error.kind, "conflict");
	assert.equal(stale.ok ? undefined : stale.error.code, "confirmation_required");
	assert.equal(stale.ok ? undefined : stale.error.state, "locally-modified");
	const unknown = await target.inventory();
	assert.equal(unknown.ok ? undefined : unknown.error.kind, "not_found");
	assert.equal(unknown.ok ? undefined : unknown.error.code, "unknown_workspace");
	const unconfigured = await target.inventory();
	assert.equal(unconfigured.ok ? undefined : unconfigured.error.kind, "unsupported", "a capability this deployment does not configure is its own kind");
	const unreachable = await target.definitions();
	assert.equal(unreachable.ok ? undefined : unreachable.error.kind, "unavailable");
	assert.equal(unreachable.ok ? undefined : unreachable.error.message, "backend unreachable");
	const shapeless = await target.inventory();
	assert.equal(shapeless.ok ? undefined : shapeless.error.kind, "unavailable", "a body this build does not know is a refusal, never an empty host");
});

test("a selection that moved does not receive the previous target's answer", async () => {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const stub = connection([
		async () => { await held; return json({ ...INVENTORY, workspaceId: "alpha", skills: [{ name: "alpha-skill", directory: "alpha-skill", description: "a", filePath: "/srv/alpha/.agents/skills/alpha-skill/SKILL.md", scope: "project", disableModelInvocation: false, revision: "unknown" }] }); },
		json({ ...INVENTORY, workspaceId: "beta", skills: [{ name: "beta-skill", directory: "beta-skill", description: "b", filePath: "/srv/beta/.agents/skills/beta-skill/SKILL.md", scope: "project", disableModelInvocation: false, revision: "unknown" }] }),
	]);
	const resources = stub.resources();
	const first = resources.select("alpha");
	const pending = first.inventory();
	// The user selects another execution target while the first read is still in flight.
	first.dispose();
	const second = resources.select("beta");
	const current = await second.inventory();
	assert.equal(current.ok, true);
	assert.deepEqual(current.ok ? current.value.skills.map((skill) => skill.directory) : [], ["beta-skill"]);
	release();
	const late = await pending;
	assert.equal(late.ok, false);
	assert.equal(late.ok ? undefined : late.error.kind, "disposed", "a late answer is refused rather than published into the new selection");
});

test("a disposed connection refuses every later operation and the library reads with it", async () => {
	const stub = connection([json({ skills: [] })]);
	const resources = stub.resources();
	const target = resources.select("alpha");
	resources.dispose();
	const listed = await resources.library.list();
	assert.equal(listed.ok ? undefined : listed.error.kind, "disposed");
	const later = resources.select("beta");
	const inventory = await later.inventory();
	assert.equal(inventory.ok ? undefined : inventory.error.kind, "disposed");
	const definitions = await target.definitions();
	assert.equal(definitions.ok ? undefined : definitions.error.kind, "disposed");
	assert.equal(stub.calls.length, 0, "a disposed scope makes no request at all");
});

test("the repository reads are the connection's, and a search that could not be offered keeps its reasons", async () => {
	const stub = connection([
		json({ skills: [{ id: "repository:notes@1.0.0", name: "notes", description: "Notes", category: "notes", source: { kind: "repository", name: "notes", version: "1.0.0" }, version: "1.0.0" }], unavailableSources: ["github"] }),
		json({ skills: [], unavailable: [{ source: "github", reason: "unbounded" }] }),
		json({ markdown: "# Notes", files: [{ path: "SKILL.md", content: "# Notes", encoding: "utf8" }] }),
	]);
	const resources = stub.resources();
	const listing = await resources.library.list();
	assert.equal(listing.ok, true);
	assert.deepEqual(listing.ok ? listing.value.unavailableSources : undefined, ["github"]);
	const searched = await resources.library.search("note");
	assert.equal(searched.ok, true);
	assert.deepEqual(searched.ok ? searched.value.unavailable : undefined, [{ source: "github", reason: "unbounded" }]);
	const preview = await resources.library.preview("repository:notes@1.0.0");
	assert.equal(preview.ok, true);
	assert.equal(stub.calls[1]!.url, ORIGIN + "/api/skill-market/search?q=note");
	assert.equal(stub.calls[2]!.url, ORIGIN + "/api/skill-market/preview?id=repository%3Anotes%401.0.0");
});
