import assert from "node:assert/strict";
import { test } from "node:test";
import { SshGateway, type SshRunner } from "../src/index.ts";
import { WorkspaceRegistry, sshWorkspaceSeed } from "../src/workspaces.ts";

test("executes an allowlisted command through an explicit SSH profile", async () => {
  const calls: { profile: string; cwd: string; command: readonly string[] }[] = [];
  const runner: SshRunner = { execute: async (request) => { calls.push(request); return { stdout: "remote-out", stderr: "", exitCode: 0 }; } };
  const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }])), allowedCommands: ["node"], runner });
  const result = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-1", cwd: "src", command: ["node", "-e", ""] });
  assert.deepEqual(result, { ok: true, gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-1", stdout: "remote-out", stderr: "", exitCode: 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.profile, "prod");
  assert.equal(calls[0]!.cwd, "/srv/app/src");
  assert.deepEqual(calls[0]!.command, ["node", "-e", ""]);
});

test("rejects unknown profiles, remote traversal, and non-allowlisted commands", async () => {
  const runner: SshRunner = { execute: async () => ({ stdout: "", stderr: "", exitCode: 0 }) };
  const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }])), allowedCommands: ["node"], runner });
  assert.deepEqual(await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "missing", callId: "ssh-2", command: ["node"] }), { ok: false, code: "unknown_workspace", callId: "ssh-2" });
  assert.deepEqual(await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-3", cwd: "../../etc", command: ["node"] }), { ok: false, code: "path_denied", callId: "ssh-3" });
  assert.deepEqual(await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-4", command: ["sh"] }), { ok: false, code: "command_denied", callId: "ssh-4" });
});

test("maps an unreachable SSH host without retrying", async () => {
  const runner: SshRunner = { execute: async () => { throw Object.assign(new Error("unreachable"), { code: "unreachable" }); } };
  const gateway = new SshGateway({ id: "gateway-ssh", token: "secret", profiles: [{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }], workspaces: new WorkspaceRegistry(sshWorkspaceSeed([{ id: "prod", host: "build.example", remoteRoot: "/srv/app" }])), allowedCommands: ["node"], runner });
  const unreachable = await gateway.execute({ gatewayId: "gateway-ssh", workspaceId: "remote-prod", callId: "ssh-5", command: ["node"] });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.ok === false && unreachable.code, "ssh_unreachable");
  assert.equal(unreachable.callId, "ssh-5");
});
