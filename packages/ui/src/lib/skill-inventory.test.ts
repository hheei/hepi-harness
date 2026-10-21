import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { ExecutionWorkspace } from "./skill-inventory.ts";

const { conversationTarget, hostLabel, initialWorkspaceId, selectableWorkspaces } =
  await createJiti(import.meta.url).import<typeof import("./skill-inventory.ts")>("./skill-inventory.ts");

/** A workspace as the gateway reports one; the account's home is not what any of these cases read. */
const workspace = (id: string, gatewayId: string, extra: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace =>
  ({ id, gatewayId, ...extra });

test("skill installation targets the execution host and only its own conversation", () => {
  const workspaces: ExecutionWorkspace[] = [
    workspace("local", "workstation", { host: { user: "operator", home: "/home/operator" } }),
    workspace("remote", "ssh", { host: { user: "remote-operator", home: "/home/remote-operator" } }),
    workspace("offline", "unreachable", { hostError: "gateway unavailable" }),
    workspace("kept", "workstation", { retained: true }),
  ];
  assert.equal(hostLabel(workspaces[0]), "operator@workstation/local");
  assert.equal(hostLabel(workspaces[1]), "remote-operator@ssh/remote");
  assert.equal(hostLabel(workspaces[2]), "unreachable/offline");
  assert.equal(initialWorkspaceId(workspaces, "/workspace/remote"), "remote");
  assert.deepEqual(selectableWorkspaces(workspaces).map(({ id }) => id), ["local", "remote", "offline"]);
  assert.deepEqual(selectableWorkspaces([workspaces[3]]), []);
  const targets: readonly (readonly [label: string, sessionWorkspace: string | null, target: string, expected: string | null])[] = [
    ["own host adopts", "remote", "remote", "session-1"],
    ["other host never adopts", "remote", "local", null],
    ["unbound conversation never adopts", null, "local", null],
  ];
  for (const [label, sessionWorkspace, target, expected] of targets) {
    assert.equal(conversationTarget("session-1", sessionWorkspace, target), expected, label);
  }
});
