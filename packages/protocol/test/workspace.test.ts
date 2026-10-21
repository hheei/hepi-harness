import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkspace } from "../src/index.ts";

test("accepts local and SSH workspace metadata without secrets", () => {
  assert.deepEqual(validateWorkspace({ id: "w-local", gatewayId: "g-1", kind: "local", cwd: "/work/project" }), { ok: true });
  assert.deepEqual(validateWorkspace({ id: "w-ssh", gatewayId: "g-1", kind: "ssh", cwd: "/home/user/project", sshProfile: "cluster" }), { ok: true });
});

test("rejects workspace credentials and non-absolute paths", () => {
  assert.deepEqual(validateWorkspace({ id: "w", gatewayId: "g", kind: "local", cwd: "relative" }), { ok: false, code: "invalid_workspace_cwd" });
  assert.deepEqual(validateWorkspace({ id: "w", gatewayId: "g", kind: "ssh", cwd: "/work", sshProfile: "cluster", privateKey: "secret" }), { ok: false, code: "secret_field_not_allowed" });
});
