import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { conversationTarget, hostLabel, initialWorkspaceId, selectableWorkspaces } =
  await createJiti(import.meta.url).import("./skill-inventory.ts");

test("skill installation targets the execution host and only its own conversation", () => {
  const workspaces = [
    { id: "local", gatewayId: "workstation", host: { user: "operator" } },
    { id: "remote", gatewayId: "ssh", host: { user: "remote-operator" } },
    { id: "offline", gatewayId: "unreachable", hostError: "gateway unavailable" },
    { id: "kept", gatewayId: "workstation", retained: true },
  ];
  assert.equal(hostLabel(workspaces[0]), "operator@workstation/local");
  assert.equal(hostLabel(workspaces[1]), "remote-operator@ssh/remote");
  assert.equal(hostLabel(workspaces[2]), "unreachable/offline");
  assert.equal(initialWorkspaceId(workspaces, "/workspace/remote"), "remote");
  assert.deepEqual(selectableWorkspaces(workspaces).map(({ id }) => id), ["local", "remote", "offline"]);
  assert.deepEqual(selectableWorkspaces([workspaces[3]]), []);
  for (const [label, sessionWorkspace, target, expected] of [
    ["own host adopts", "remote", "remote", "session-1"],
    ["other host never adopts", "remote", "local", null],
    ["unbound conversation never adopts", null, "local", null],
  ]) {
    assert.equal(conversationTarget("session-1", sessionWorkspace, target), expected, label);
  }
});
