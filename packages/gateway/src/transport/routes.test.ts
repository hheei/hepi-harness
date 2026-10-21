import assert from "node:assert/strict";
import { test } from "node:test";
import { controlRoute } from "./control.ts";
import { executionRoute } from "./execution.ts";
import { mcpRoute } from "./mcp.ts";
import { providerRoute } from "./providers.ts";

/**
 * The routes the remaining transport families answer, at the modules that own them.
 *
 * A route is the request target and the method together, and each family decides that for itself: the execution routes
 * answer a POST, the MCP and provider routes answer their own POST, and the control routes name the remaining JSON
 * surfaces. Nothing decides it by prefix or by a table of every route in the gateway, which is what keeps a new route a
 * change to one family. What a caller reads on the wire — statuses, envelopes, cancellation — stays in the suites that
 * drive the gateway's ordinary admitted entry: `test/gateway.test.ts`, `test/execution.test.ts`,
 * `test/mcp.test.ts`, `test/provider-login.test.ts`, `test/control.test.ts`.
 */

test("the execution family answers a POST to its own two routes and nothing else", () => {
	assert.equal(executionRoute("/v1/execute", "POST"), "execute");
	assert.equal(executionRoute("/v1/abort", "POST"), "abort");
	// An abort is a request of its own: a GET never ends a running call, and a query is never a route.
	assert.equal(executionRoute("/v1/execute", "GET"), undefined);
	assert.equal(executionRoute("/v1/abort", "GET"), undefined);
	assert.equal(executionRoute("/v1/execute?x=1", "POST"), undefined);
	assert.equal(executionRoute("/v1/executes", "POST"), undefined);
	assert.equal(executionRoute("/v1/terminal", "POST"), undefined);
});

test("the MCP family answers one POST, and a GET is no route at all", () => {
	assert.equal(mcpRoute("/v1/mcp", "POST"), "mcp");
	assert.equal(mcpRoute("/v1/mcp", "GET"), undefined);
	assert.equal(mcpRoute("/v1/mcp/", "POST"), undefined);
	assert.equal(mcpRoute("/v1/mcp?operation=read", "POST"), undefined);
});

test("the provider family names the route its request asked for, by method and target together", () => {
	assert.equal(providerRoute("/v1/providers/auth", "POST"), "auth");
	assert.equal(providerRoute("/v1/providers/login", "POST"), "login");
	assert.equal(providerRoute("/v1/providers/auth", "GET"), undefined);
	assert.equal(providerRoute("/v1/providers/login", "GET"), undefined);
	assert.equal(providerRoute("/v1/providers", "POST"), undefined);
	assert.equal(providerRoute("/v1/providers/login/", "POST"), undefined);
});

test("the control family answers the five JSON surfaces it was composed for, and no prefix of one", () => {
	assert.equal(controlRoute("/v1/workspaces", "POST"), "workspaces");
	assert.equal(controlRoute("/v1/worktrees", "POST"), "worktrees");
	assert.equal(controlRoute("/v1/workbench", "POST"), "workbench");
	assert.equal(controlRoute("/v1/files", "POST"), "files");
	assert.equal(controlRoute("/v1/installs", "POST"), "installs");
	// The payload routes are their own family, and the file RPC is not reached through a query or a prefix.
	assert.equal(controlRoute("/v1/files/bytes", "POST"), undefined);
	assert.equal(controlRoute("/v1/files/upload", "POST"), undefined);
	assert.equal(controlRoute("/v1/files?workspaceId=w1", "POST"), undefined);
	assert.equal(controlRoute("/v1/workspaces", "GET"), undefined);
	assert.equal(controlRoute("/v1/terminal", "POST"), undefined);
	assert.equal(controlRoute("/v1/mcp", "POST"), undefined);
});
