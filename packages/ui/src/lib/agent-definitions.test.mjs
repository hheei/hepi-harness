import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AGENT_DEFINITION_TOOLS, capabilitiesOf } = await jiti.import("./agent-definitions.ts");

/**
 * The panel offers the vocabulary the backend states, so a tool a build does not install is never offered and a save
 * built from the panel cannot be refused for naming one. A stated vocabulary wins; an answer that carries none falls
 * back to this build's own list rather than leaving the panel with nothing to show.
 */
test("the panel offers the backend's stated capabilities", () => {
  const stated = capabilitiesOf({ capabilities: { tools: ["read", "write", "edit", "bash"], thinking: ["low"], contextStrategies: ["fresh", "fork"] } });
  assert.deepEqual([...stated.tools], ["read", "write", "edit", "bash"]);
  assert.deepEqual([...stated.thinking], ["low"]);
  assert.deepEqual([...stated.contextStrategies], ["fresh", "fork"]);
});

test("an answer with no stated capabilities falls back to this build's own vocabulary", () => {
  for (const body of [undefined, {}, { capabilities: undefined }, { capabilities: {} }, { capabilities: { tools: [] } }]) {
    const fallback = capabilitiesOf(body);
    assert.deepEqual([...fallback.tools], [...AGENT_DEFINITION_TOOLS], "a tool list is always offered");
    assert.equal(fallback.tools.length > 0, true);
    assert.deepEqual([...fallback.contextStrategies], ["fresh", "fork", "compact"]);
  }
});

test("the fallback names only tools the durable runtime installs", () => {
  // The one list that must never drift from the runtime: a tool with no implementation behind it would save and then
  // run with a smaller loadout than the definition states.
  assert.deepEqual([...AGENT_DEFINITION_TOOLS], ["read", "write", "edit", "bash"]);
});
