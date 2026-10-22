import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, GatewayWorktrees, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { createFakeGitHost } from "./fake-git-host.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/** Every message of one request, so a test can assert what the model was actually shown. */
function transcriptText(messages: readonly Message[]): string {
  return messages.map((message) => message.role === "system" ? contentText(message.content) + "\n" + JSON.stringify(message.sections ?? {}) : message.role === "user" ? contentText(message.content) : "").join("\n");
}

/**
 * A real HTTP/SSE backend over a **remote-account** gateway served in this process.
 *
 * The transport is memory, not a process: the gateway is the real `GatewayRpcServer` listening on loopback and the
 * backend reaches it through the real `GatewayHostClient` over HTTP, so routing, authentication, the resource
 * snapshot round trip and every error classification are the production ones. What is replaced is only the thing
 * underneath the gateway: no `sshd`, no Python helper, no git process and no child process. The gateway's filesystem
 * surface is bound to a temporary account whose home and repository are distinct from the harness home, so the account,
 * home and roots the conversation adopts still come from the host the ExecutionEnv resolved rather than from this
 * process.
 */
async function fixture(t: { after(fn: () => unknown): void }, transcript?: string[], options: { linkedWorktree?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "hepi-ssh-server-"));
  const home = join(base, "remote-home");
  const repository = join(base, "remote-repo");
  const root = join(repository, "app");
  // The host answers the git argv the gateway's worktree surface runs, and a linked worktree is the metadata that host
  // reports: the gateway resolves the shadow from that layout rather than from a fixture's claim.
  const host = createFakeGitHost();
  if (options.linkedWorktree === true) {
    await mkdir(repository);
    host.initRepository(repository, "main");
    host.worktree(repository, "feature", root);
  }
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "skills", "account-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "skills", "dup"), { recursive: true });
  await mkdir(join(home, ".agents", "skills", "dup"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "ancestor"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy"), { recursive: true });
  await mkdir(join(root, ".pi", "skills", "proj"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "proj"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  if (options.linkedWorktree !== true) { await mkdir(join(repository, ".git")); await mkdir(root, { recursive: true }); }
  await writeFile(join(home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
  await writeFile(join(repository, ".agents", "skills", "ancestor", "SKILL.md"), "---\nname: ancestor\ndescription: Ancestor rule\n---\nAncestor body.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
  await writeFile(join(home, ".pi", "agent", "skills", "account-notes", "SKILL.md"), "---\nname: account-notes\ndescription: Account pi notes\n---\nAccount pi notes body.\n");
  await writeFile(join(home, ".pi", "agent", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account pi duplicate\n---\nAccount pi duplicate body.\n");
  await writeFile(join(home, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account agents duplicate\n---\nAccount agents duplicate body.\n");
  await writeFile(join(root, ".pi", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Workspace pi skill\n---\nWorkspace pi body.\n");
  await writeFile(join(root, ".agents", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Workspace agents skill\n---\nWorkspace agents body.\n");
  await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1.\n");
  await writeFile(join(root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "REMOTE SYSTEM PROMPT");
  await writeFile(join(root, ".pi", "SYSTEM.md"), "REMOTE PROJECT SYSTEM PROMPT");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "REMOTE GLOBAL CONTEXT");
  await writeFile(join(repository, "AGENTS.md"), "REMOTE ANCESTOR CONTEXT");
  await writeFile(join(root, "AGENTS.md"), "REMOTE PROJECT CONTEXT");
  await writeFile(join(home, ".pi", "agent", "auth.json"), '{"local":{"key":"SECRET-REMOTE-ACCOUNT"}}');
  await writeFile(join(home, "id_rsa"), "SECRET-REMOTE-KEY");

  const workspaces = new WorkspaceRegistry([{ id: "remote-prod", root }]);
  const identity = { user: "remote-operator", home };
  const gateway = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
    files: new LocalFilesystem(workspaces, { identity }),
    worktrees: new GatewayWorktrees(workspaces, host.git),
  });
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const binding = { id: "remote-prod", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };

  const faux = fauxProvider();
  const responses: FauxResponseStep[] = [];
  const recorder: FauxResponseFactory = async (context): Promise<AssistantMessage> => {
    faux.appendResponses([recorder]);
    transcript?.push(transcriptText(context.messages));
    const step = responses.shift();
    return step === undefined || typeof step === "function" ? fauxAssistantMessage("done") : step;
  };
  faux.setResponses([recorder]);
  const models = createModels();
  models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(base, "resources.sqlite"), authToken: "server-token", models, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), defaultModel: SERVER_MODEL });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address();
  assert.ok(serverAddress !== null && typeof serverAddress === "object");
  const origin = "http://127.0.0.1:" + serverAddress.port;
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  const opened: BackendServer[] = [backend];
  t.after(async () => { for (const server of opened) { server.server.closeAllConnections(); await server.close(); } gateway.server.closeAllConnections(); await gateway.close(); await rm(base, { recursive: true, force: true }); });
  const dbPath = join(base, "resources.sqlite");
  return {
    origin, headers, home, repository, root, binding, gateway, responses, opened, models, dbPath,
    startBackend: async (bound: typeof binding[] = [binding], db = dbPath): Promise<string> => {
      const server = await createBackendServer({ dbPath: db, authToken: "server-token", models, workspaces: bound, workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), defaultModel: SERVER_MODEL });
      opened.push(server);
      await new Promise<void>((resolve) => server.server.listen(0, "127.0.0.1", resolve));
      const address2 = server.server.address();
      assert.ok(address2 !== null && typeof address2 === "object");
      return "http://127.0.0.1:" + address2.port;
    },
  };
}

async function createConversation(origin: string, headers: HeadersInit, workspaceId = "remote-prod"): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId }) });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return (JSON.parse(body) as { conversationId: string }).conversationId;
}

async function run(origin: string, headers: HeadersInit, id: string, text: string): Promise<{ entries: { role: string; text: string; message: { isError?: boolean } }[] }> {
  const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text }) });
  assert.equal(submit.status, 202, await submit.text());
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const current = await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json() as { busy: boolean; entries: { role: string; text: string; message: { isError?: boolean } }[] };
    if (!current.busy) return current;
  }
  throw new Error("run did not settle");
}

test("a remote-account conversation adopts host resources and reads a global skill through an ordinary tool call", { timeout: 30000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  const skillPath = join(server.home, ".agents", "skills", "global-notes", "SKILL.md");
  const piSkillPath = join(server.root, ".pi", "skills", "proj", "SKILL.md");
  server.responses.push(
    fauxAssistantMessage("adopted"),
    fauxAssistantMessage([fauxToolCall("read", { path: skillPath })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: "/.pi/skills/proj/SKILL.md" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: piSkillPath })], { stopReason: "toolUse" }),
    fauxAssistantMessage("read done"),
  );
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  const commands = await (await fetch(server.origin + "/api/conversations/" + id + "/commands", { headers: server.headers })).json() as { commands: { name: string }[] };
  // The remote host's `.pi/agent/skills` and `.pi/skills` roots load too, and upstream precedence holds: the `.pi` root
  // wins a duplicate name over the `.agents` root of the same scope.
  assert.deepEqual(commands.commands.map((command) => command.name).sort(), ["ship", "skill:account-notes", "skill:ancestor", "skill:deploy", "skill:dup", "skill:global-notes", "skill:proj", "summarize"]);
  const seen = transcript.join("\n");
  assert.match(seen, /Account pi duplicate/);
  assert.doesNotMatch(seen, /Account agents duplicate/);
  assert.match(seen, /Workspace pi skill/);
  assert.doesNotMatch(seen, /Workspace agents skill/);
  assert.ok(seen.includes(join(server.home, ".pi", "agent", "skills", "dup", "SKILL.md")), "the remote .pi root is advertised at its real path");
  // The prompt carries the remote host's own system prompt, project-over-global precedence and the real remote paths.
  assert.match(seen, /REMOTE PROJECT SYSTEM PROMPT/);
  assert.doesNotMatch(seen, /REMOTE SYSTEM PROMPT/);
  assert.match(seen, /REMOTE GLOBAL CONTEXT/);
  assert.match(seen, /REMOTE ANCESTOR CONTEXT/);
  assert.match(seen, /REMOTE PROJECT CONTEXT/);
  assert.match(seen, new RegExp(skillPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // An ordinary read reaches the skill file at its real remote path, and the host's other files stay out of reach.
  const final = await run(server.origin, server.headers, id, "read the global skill");
  const results = final.entries.filter((entry) => entry.role === "toolResult");
  assert.equal(results.length, 3, JSON.stringify(final.entries));
  assert.match(results[0]!.text, /Global notes body\./);
  // The remote `.pi/skills` root is reachable through an ordinary tool call by both the logical and the physical path.
  assert.match(results[1]!.text, /Workspace pi body\./);
  assert.match(results[2]!.text, /Workspace pi body\./);
  assert.doesNotMatch(results.map((entry) => entry.text).join("\n"), /SECRET-REMOTE-ACCOUNT/);
});

test("a remote workspace that is a linked git worktree drops the shadowed main-repository context file", { timeout: 30000 }, async (t) => {
  const transcript: string[] = [];
  // The remote repository is the worktree's main repository, so its AGENTS.md is the file the worktree's own shadows.
  const server = await fixture(t, transcript, { linkedWorktree: true });
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  const seen = transcript.join("\n");
  assert.match(seen, /REMOTE PROJECT CONTEXT/, "the worktree's own context file is the one in effect");
  assert.doesNotMatch(seen, /REMOTE ANCESTOR CONTEXT/, "the main repository's shadowed file is not loaded");
  // The main repository's file is still reachable on the host: the shadow is a loading rule, not a permission one.
  await mkdir(join(server.root, ".agents", "skills", "extra"), { recursive: true });
  assert.match(seen, /REMOTE GLOBAL CONTEXT/);
});

test("a remote host outage fails that conversation only and never falls back to harness files", { timeout: 30000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const adopted = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, adopted, "adopt");
  server.gateway.server.closeAllConnections();
  await server.gateway.close();
  // A second conversation cannot load from the unreachable host: no gateway-local or harness-local resource appears.
  const broken = await createConversation(server.origin, server.headers);
  transcript.length = 0;
  const failed = await fetch(server.origin + "/api/conversations/" + broken + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "outage", text: "hello" }) });
  const body = await failed.text();
  assert.equal(failed.status, 500, body);
  assert.match(body, /unreachable|gateway unavailable/);
  // No model call happened, so no harness-local or gateway-local resource could have stood in for the host.
  assert.deepEqual(transcript, []);
  // The service, the conversation list and the conversation that already adopted stay usable.
  assert.equal((await fetch(server.origin + "/api/conversations", { headers: server.headers })).status, 200);
  assert.equal((await fetch(server.origin + "/api/conversations/" + broken + "/state", { headers: server.headers })).status, 200);
});

test("a backend restart over a remote host restores the committed loading result", { timeout: 30000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  // The host's file changes after adoption; a restart replays the committed prefix rather than rediscovering it.
  await writeFile(join(server.root, ".pi", "SYSTEM.md"), "REMOTE REWRITTEN SYSTEM PROMPT");
  transcript.length = 0;
  const restarted = await server.startBackend();
  server.responses.push(fauxAssistantMessage("second"));
  await run(restarted, server.headers, id, "second run");
  const seen = transcript.join("\n");
  assert.match(seen, /REMOTE PROJECT SYSTEM PROMPT/, "the committed prefix is replayed");
  assert.doesNotMatch(seen, /REMOTE REWRITTEN SYSTEM PROMPT/, "restart does not rediscover the host");
  const commands = await (await fetch(restarted + "/api/conversations/" + id + "/commands", { headers: server.headers })).json() as { commands: { name: string }[] };
  assert.deepEqual(commands.commands.map((command) => command.name).sort(), ["ship", "skill:account-notes", "skill:ancestor", "skill:deploy", "skill:dup", "skill:global-notes", "skill:proj", "summarize"]);
});
