import assert from "node:assert/strict";
import { test } from "node:test";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  AGENT_DEFINITION_CONTEXT_STRATEGIES,
  AGENT_DEFINITION_TOOLS,
  applyDefinitionEdits,
  buildEffectiveAgentConfiguration,
  parseAgentDefinitionDocument,
  requireValidDefinition,
  serializeAgentDefinitionDocument,
} from "../src/agent-definitions.ts";
import { resolveAgentDefinitions, type StoredAgentDefinition } from "../src/agent-definitions-store.ts";

const DOCUMENT = [
  "---",
  "name: reviewer",
  "description: Review a change",
  "model: anthropic/claude-sonnet-4",
  "thinking: high",
  "tools:",
  "  - read",
  "  - write",
  "context: fresh",
  "enabled: true",
  "custom_field: kept",
  "---",
  "",
  "Review the change and report risks.",
  "",
].join("\n");

test("a whole document parses into its known fields and keeps unknown frontmatter", () => {
  const result = parseAgentDefinitionDocument(DOCUMENT);
  assert.deepEqual(result.issues, []);
  const definition = result.definition;
  assert.equal(definition.name, "reviewer");
  assert.equal(definition.description, "Review a change");
  assert.equal(definition.model, "anthropic/claude-sonnet-4");
  assert.equal(definition.thinking, "high");
  assert.deepEqual([...definition.tools], ["read", "write"]);
  assert.equal(definition.context, "fresh");
  assert.equal(definition.enabled, true);
  assert.equal(definition.instructions, "Review the change and report risks.");
  assert.deepEqual(definition.unknownFrontmatter, { custom_field: "kept" });
});

test("a round trip preserves unknown frontmatter and the unedited body", () => {
  const { definition } = parseAgentDefinitionDocument(DOCUMENT);
  const written = serializeAgentDefinitionDocument(definition);
  const reparsed = parseAgentDefinitionDocument(written);
  assert.deepEqual(reparsed.issues, []);
  assert.deepEqual(reparsed.definition.unknownFrontmatter, { custom_field: "kept" });
  assert.equal(reparsed.definition.instructions, "Review the change and report risks.");
  assert.equal(reparsed.definition.model, "anthropic/claude-sonnet-4");
});

test("a default context is fresh and the known strategies are exactly the registered ones", () => {
  const { definition } = parseAgentDefinitionDocument("---\nname: a\n---\nbody\n");
  assert.equal(definition.context, "fresh");
  assert.deepEqual([...AGENT_DEFINITION_CONTEXT_STRATEGIES], ["fresh", "fork", "compact"]);
});

test("an unknown context strategy is refused, never silently replaced", () => {
  const result = parseAgentDefinitionDocument("---\nname: a\ncontext: rewind\n---\nbody\n");
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]!.code, "unknown_context_strategy");
});

test("an unknown tool is refused and a known unsupported capability is refused explicitly", () => {
  const unknown = parseAgentDefinitionDocument("---\nname: a\ntools: read, teleport\n---\nbody\n");
  assert.equal(unknown.issues[0]!.code, "unknown_tool");
  assert.match(unknown.issues[0]!.message, /teleport/);
  const extension = parseAgentDefinitionDocument("---\nname: a\ntools: ext:codegraph\n---\nbody\n");
  assert.equal(extension.issues[0]!.code, "unsupported_capability");
});

test("the accepted tools are exactly the ones the runtime installs, so a save cannot name an unrunnable loadout", () => {
  // The vocabulary is read from the extension a run resolves, not written out here: a tool this build does not install
  // has no request that could offer it, so accepting the name would save a definition that runs with less than it says.
  assert.deepEqual([...AGENT_DEFINITION_TOOLS], (CodingTools.tools ?? []).map(tool => tool.name));
  for (const absent of ["grep", "find", "ls", "powershell", "codemode", "tool_search"]) {
    assert.equal(AGENT_DEFINITION_TOOLS.includes(absent), false, absent + " is not installed by this build's coding tools");
    const refused = parseAgentDefinitionDocument("---\nname: a\ntools: read, " + absent + "\n---\nbody\n");
    assert.equal(refused.issues[0]!.code, "unknown_tool", absent + " is refused rather than accepted and silently dropped");
    assert.equal(refused.definition.tools.includes(absent), false);
  }
  const accepted = parseAgentDefinitionDocument("---\nname: a\ntools: read, bash, edit, write\n---\nbody\n");
  assert.deepEqual(accepted.issues, []);
  assert.deepEqual([...accepted.definition.tools], ["read", "bash", "edit", "write"]);
});

test("a definition that asks for MCP servers or extensions is refused by name", () => {
  const mcp = parseAgentDefinitionDocument("---\nname: a\nmcp_servers:\n  - one\n---\nbody\n");
  assert.equal(mcp.issues[0]!.code, "unsupported_capability");
  assert.match(mcp.issues[0]!.message, /MCP servers/);
  const extensions = parseAgentDefinitionDocument("---\nname: a\nextensions: [pi-advisor]\n---\nbody\n");
  assert.equal(extensions.issues[0]!.code, "unsupported_capability");
});

test("an unclosed frontmatter fence is refused instead of guessed at", () => {
  const result = parseAgentDefinitionDocument("---\nname: a\n\nbody with no closing fence\n");
  assert.equal(result.issues[0]!.code, "invalid_frontmatter");
});

test("a form edit merges onto the existing document and keeps its unknown frontmatter", () => {
  const existing = parseAgentDefinitionDocument(DOCUMENT).definition;
  const merged = applyDefinitionEdits(existing, { description: "Review carefully", tools: ["read"] });
  assert.equal(merged.description, "Review carefully");
  assert.deepEqual([...merged.tools], ["read"]);
  assert.equal(merged.model, "anthropic/claude-sonnet-4", "an untouched field keeps the file's value");
  assert.deepEqual(merged.unknownFrontmatter, { custom_field: "kept" });
  assert.equal(merged.instructions, existing.instructions, "the body is untouched");
});

test("a cleared model is an explicit clear, not an inheritance", () => {
  const existing = parseAgentDefinitionDocument(DOCUMENT).definition;
  const merged = applyDefinitionEdits(existing, { model: "" });
  assert.equal(merged.model, undefined);
});

test("the effective configuration names every field, so nothing is inherited from a parent", () => {
  const { definition } = parseAgentDefinitionDocument("---\nname: worker\n---\ndo work\n");
  const effective = buildEffectiveAgentConfiguration(definition, { hostId: "workstation", workspaceId: "ws", scope: "project", name: "worker" }, "/ws/.pi/agents/worker.md");
  assert.equal(effective.version, 1);
  assert.equal(effective.model, null, "an unnamed model is fixed as null, never inherited");
  assert.equal(effective.thinking, null);
  assert.deepEqual([...effective.tools], []);
  assert.equal(effective.context, "fresh");
  assert.equal(effective.definition.workspaceId, "ws");
  assert.equal(effective.instructions, "do work");
});

test("project definitions override user definitions of the same name", () => {
  const make = (scope: "project" | "user", path: string): StoredAgentDefinition => ({
    source: { scope, hostId: "workstation", workspaceId: "ws", path },
    document: parseAgentDefinitionDocument("---\nname: reviewer\ndescription: " + scope + "\n---\nbody\n").definition,
    issues: [],
    raw: "",
  });
  const resolved = resolveAgentDefinitions([make("user", "/home/.pi/agent/agents/reviewer.md"), make("project", "/ws/.pi/agents/reviewer.md")]);
  assert.equal(resolved.effective.length, 1);
  assert.equal(resolved.effective[0]!.document.description, "project");
  assert.equal(resolved.shadowed.length, 1);
  assert.equal(resolved.shadowed[0]!.source.scope, "user");
});

test("requireValidDefinition names the failing field", () => {
  const result = parseAgentDefinitionDocument("---\nname: bad name\n---\nbody\n");
  assert.throws(() => requireValidDefinition(result), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /name/);
    return true;
  });
});
