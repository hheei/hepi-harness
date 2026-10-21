/**
 * The deployment's MCP declarations, read from `HEPI_MCP_TOOLS`, before anything reaches the adapter.
 *
 * This is the composition boundary ticket 02 installs behind: what a deployment is allowed to say about the tools it
 * offers, and what it is refused permission to say. The tests are synchronous and start no server, because the question
 * is the shape of the variable, not the behaviour of a call — which `mcp-conversation-tools.test.ts` observes over a real
 * gateway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MCP_TOOLS_ENV, parseMcpToolDeclarations } from "../src/mcp-declarations.ts";
import { MCP_MAX_TOOLS } from "../src/mcp-conversation-tools.ts";

const GATEWAYS = ["workstation", "build-box"];
const ONE = [{ gatewayId: "workstation", scope: "global", server: "docs", tool: "search" }];

test("a deployment that declares nothing installs no MCP tools", () => {
  for (const blank of [undefined, "", "   "]) assert.deepEqual(parseMcpToolDeclarations(blank, GATEWAYS), []);
});

test("a declared tool carries its identities and its presentation, and nothing else", () => {
  const declared = parseMcpToolDeclarations(JSON.stringify([
    { gatewayId: "workstation", scope: "project", server: "docs", tool: "search", description: "Search the docs.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { gatewayId: "build-box", scope: "global", server: "notes", tool: "record" },
  ]), GATEWAYS);
  assert.deepEqual(declared, [
    { gatewayId: "workstation", scope: "project", server: "docs", tool: "search", description: "Search the docs.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    // An absent description stays absent rather than becoming an empty string: the adapter's own fallback is what a
    // model reads, and one entry's shape does not depend on another's.
    { gatewayId: "build-box", scope: "global", server: "notes", tool: "record" },
  ]);
});

test("a host this backend does not configure is refused, not installed as a tool that always fails", () => {
  // The declaration is a routing claim, so it can only name a gateway the operator already configured with its URL and
  // token. A name from a stale file must not become a conversation-visible tool.
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ gatewayId: "laptop", scope: "global", server: "docs", tool: "search" }]), GATEWAYS), /names gateway laptop, which this backend does not configure/);
});

test("a declaration that carries host configuration is refused by the field it named", () => {
  // The whole reason the invocation route refuses a body carrying configuration is reproduced at the boundary that
  // builds it: this file is not a way to have the host start something no selection named.
  for (const field of ["command", "args", "env", "url", "headers", "auth", "config"]) {
    const entry = { ...ONE[0], [field]: field === "args" ? [] : "x" };
    assert.throws(() => parseMcpToolDeclarations(JSON.stringify([entry]), GATEWAYS), new RegExp("carries " + field + ", which the host owns"), field);
  }
  // A folder is not an identity a backend may claim for a call either: the host resolves its own workspace binding.
  for (const field of ["cwd", "workspaceId"]) {
    assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ ...ONE[0], [field]: "/home/operator/secret" }]), GATEWAYS), new RegExp("carries " + field), field);
  }
});

test("a malformed declaration names its entry and stops the backend from starting", () => {
  // A deployment that believes it offers a tool and does not is a wrong belief about a conversation, so nothing here is
  // skipped quietly. Each message names the index and the field, and never the offending text (operators paste real
  // configuration into this variable).
  assert.throws(() => parseMcpToolDeclarations("{", GATEWAYS), new RegExp(MCP_TOOLS_ENV + " is not valid JSON"));
  assert.throws(() => parseMcpToolDeclarations("{}", GATEWAYS), /must be a JSON array/);
  assert.throws(() => parseMcpToolDeclarations("[\"docs\"]", GATEWAYS), /entry 0 must be an object/);
  assert.throws(() => parseMcpToolDeclarations("[{}]", GATEWAYS), /entry 0 needs a non-empty string gatewayId/);
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ gatewayId: "workstation", scope: "global", server: "  ", tool: "search" }]), GATEWAYS), /needs a non-empty string server/);
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ ...ONE[0], scope: "conversation" }]), GATEWAYS), /scope must be "global" or "project"/);
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ ...ONE[0], description: 7 }]), GATEWAYS), /description must be a string/);
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify([{ ...ONE[0], inputSchema: "true" }]), GATEWAYS), /inputSchema must be a JSON object/);
});

test("a declaration list over the adapter's own bound is a startup failure, not a silent drop", () => {
  const many = Array.from({ length: MCP_MAX_TOOLS + 1 }, (_, index) => ({ gatewayId: "workstation", scope: "global" as const, server: "s" + index, tool: "t" }));
  assert.throws(() => parseMcpToolDeclarations(JSON.stringify(many), GATEWAYS), new RegExp("declares " + (MCP_MAX_TOOLS + 1) + " tools, and one backend installs no more than " + MCP_MAX_TOOLS));
});
