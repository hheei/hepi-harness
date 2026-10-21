import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GatewayHostClient, LocalGateway, GatewayRpcServer, type ExecuteRequest } from "../src/index.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";

test("executes an allowlisted command inside the configured workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-gateway-"));
  try {
    const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["node"] });
    const result = await gateway.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-1", command: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err')"] });
    assert.deepEqual(result, { ok: true, gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-1", stdout: "out", stderr: "err", exitCode: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects traversal and commands outside the allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-gateway-"));
  try {
    const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["node"] });
    const traversal = await gateway.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-2", cwd: "../", command: [process.execPath, "-e", ""] });
    const denied = await gateway.execute({ gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-3", command: ["sh", "-c", "echo no"] });
    assert.deepEqual(traversal, { ok: false, code: "path_denied", callId: "call-2" });
    assert.deepEqual(denied, { ok: false, code: "command_denied", callId: "call-3" });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("authenticates the gateway RPC and returns an offline outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-gateway-"));
  const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["node"] });
  const server = new GatewayRpcServer({ gateway });
  await new Promise<void>((resolve) => server.server.listen(0, resolve));
  const address = server.server.address(); assert.ok(address !== null && typeof address === "object");
  const request: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "call-5", command: [process.execPath, "-e", ""] };
  const unauthorized = await fetch("http://127.0.0.1:" + address.port + "/v1/execute", { method: "POST", body: JSON.stringify(request) });
  assert.equal(unauthorized.status, 401);
  await server.close(); await rm(root, { recursive: true, force: true });
  const client = new GatewayHostClient({ gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "secret" });
  assert.deepEqual(await client.process.execute(request), { ok: false, code: "gateway_offline", callId: "call-5" });
});
