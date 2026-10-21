import assert from "node:assert/strict";
import test from "node:test";
import { validateCommand } from "../src/index.ts";

const context = {
  workspaces: [{ id: "workspace-1", gatewayId: "gateway-1", kind: "local" as const, cwd: "/workspace" }],
  gateways: [{ id: "gateway-1", kind: "workstation" as const, displayName: "Laptop" }],
};

test("rejects a command with an unsupported protocol version", () => {
  assert.deepEqual(validateCommand({ protocol: "hepi.v2", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello" }), { ok: false, code: "unsupported_protocol" });
});

test("accepts a valid submission with stable workspace and gateway references", () => {
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello", workspaceId: "workspace-1", gatewayId: "gateway-1" }, context), { ok: true });
});

test("rejects unknown workspace and gateway references", () => {
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello", workspaceId: "missing" }, context), { ok: false, code: "unknown_workspace" });
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello", gatewayId: "missing" }, context), { ok: false, code: "unknown_gateway" });
});

test("rejects a workspace and gateway mismatch", () => {
  const mismatch = { ...context, gateways: [...context.gateways, { id: "gateway-2", kind: "workstation" as const, displayName: "Other" }] };
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: "hello", workspaceId: "workspace-1", gatewayId: "gateway-2" }, mismatch), { ok: false, code: "workspace_gateway_mismatch" });
});

test("rejects empty request IDs and message text", () => {
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: " ", conversationId: "conversation-1", type: "conversation.submit", text: "hello" }), { ok: false, code: "invalid_request_id" });
  assert.deepEqual(validateCommand({ protocol: "hepi.v1", requestId: "req-1", conversationId: "conversation-1", type: "conversation.submit", text: " " }), { ok: false, code: "invalid_text" });
});
