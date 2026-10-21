import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, gatewayEnvironment } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type ServerSnapshot } from "../src/server.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

type Entry = ServerSnapshot["entries"][number];

/**
 * One SSE reader over a conversation's event stream: the frames as they arrive, in order, and the window those frames
 * build as a client folds them through the shared reducer a real client uses. `follow` is the barrier — it resolves on
 * the frame that satisfies the predicate, so a wait costs a frame instead of a delay that hopes the frame arrived.
 */
async function openStream(origin: string, conversationId: string, timeoutMs: number) {
  // The connection carries its own bound, so a stream that goes quiet fails the test instead of hanging it.
  const response = await fetch(origin + "/api/conversations/" + conversationId + "/events", { headers: { authorization: "Bearer server-token" }, signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const stream = streamFolder<Entry>(conversationId);
  let pending = "";
  const held: HeldWindow<Entry>[] = [];
  return {
    async follow(match: (window: HeldWindow<Entry>) => boolean): Promise<HeldWindow<Entry>> {
      while (true) {
        const found = held.findIndex(window => match(window));
        if (found >= 0) return held[found];
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the event stream ended before the frame that states the state arrived");
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          if (event !== "snapshot" && event !== "state") continue;
          const line = frame.split("\n").find(value => value.startsWith("data: ")); if (line === undefined) continue;
          // The stream states its window once and appends after it, so a frame is folded the way a client folds it.
          held.push(stream.fold(event, JSON.parse(line.slice(6))));
        }
      }
    },
    async close(): Promise<void> { await reader.cancel(); },
  };
}

test("durable tools write edit read and execute through authenticated gateway", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-tools-"));
  const workspace = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: workspace, allowedCommands: ["bash"] }), undefined, new GatewayFiles(workspace));
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address(); assert.ok(address && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("write", { path: "nested/note.txt", content: "before" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("edit", { path: "nested/note.txt", edits: [{ oldText: "before", newText: "after" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: "nested/note.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bash", { command: "printf shell-output" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("tools done"),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const backend = await createBackendServer({ dbPath: join(root, "test.sqlite"), authToken: "server-token", models, workspaces: [binding], defaultModel: SERVER_MODEL });
  await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
  const serverAddress = backend.server.address(); assert.ok(serverAddress && typeof serverAddress === "object");
  const origin = "http://127.0.0.1:" + serverAddress.port;
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  let events: Awaited<ReturnType<typeof openStream>> | undefined;
  try {
    const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) })).json();
    const path = origin + "/api/conversations/" + created.conversationId;
    events = await openStream(origin, created.conversationId, 2000);
    assert.equal((await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "tools-1", text: "use tools" }) })).status, 202);
    // The frame that states the run is over is the barrier: it arrives when the tools have run, so the wait is the
    // stream's own fact rather than a loop asking whether the run has finished yet.
    const current = await events.follow(window => !window.busy && window.entries.at(-1)?.text === "tools done");
    const results = current.entries.filter((entry: Entry) => entry.role === "toolResult");
    assert.equal(results.length, 4); assert.ok(results.every((entry: Entry) => entry.message.role !== "toolResult" || entry.message.isError !== true));
    assert.equal(results[2].text, "after"); assert.equal(results[3].text, "shell-output");
    assert.equal(await readFile(join(root, "nested/note.txt"), "utf8"), "after");
    await symlink(tmpdir(), join(root, "escape"));
    const env = gatewayEnvironment(binding);
    const denied = await env.writeFile("escape/hepi-denied.txt", "no", BACKGROUND_CONTEXT);
    assert.equal(denied.ok, false);
  } finally { await events?.close(); backend.server.closeAllConnections(); await backend.close(); await gateway.close(); await rm(root, { recursive: true, force: true }); }
});

test("a gateway conversation adopts workspace .agents skills, expands the skill command and reads its files at ordinary host paths", { timeout: 8000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "hepi-skills-gateway-"));
  const home = await mkdtemp(join(tmpdir(), "hepi-home-"));
  const workspace = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: workspace, allowedCommands: ["bash"] }), undefined, new GatewayFiles(workspace, { identity: { user: "operator", home } }));
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address(); assert.ok(address && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  try {
    // The ordinary execution-side shapes: a project skill directory with its own referenced script, and no harness-local
    // agent directory anywhere in the fixture.
    await mkdir(join(root, ".agents", "skills", "deploy", "scripts"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Workspace rules.");
    await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
    await writeFile(join(root, ".agents", "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho deploy\n");
    const skillFile = join(await realpath(root), ".agents", "skills", "deploy", "SKILL.md");
    const scriptFile = join(await realpath(root), ".agents", "skills", "deploy", "scripts", "run.sh");
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("expanded"),
      fauxAssistantMessage([fauxToolCall("read", { path: skillFile })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("read", { path: scriptFile })], { stopReason: "toolUse" }),
      fauxAssistantMessage("reads done"),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const backend = await createBackendServer({ dbPath: join(root, "skills.sqlite"), authToken: "server-token", models, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: false }), defaultModel: SERVER_MODEL });
    await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
    const serverAddress = backend.server.address(); assert.ok(serverAddress && typeof serverAddress === "object");
    const origin = "http://127.0.0.1:" + serverAddress.port;
    const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
    try {
      const created = await (await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) })).json();
      const path = origin + "/api/conversations/" + created.conversationId;
      // The stream is opened before the first submit, so the frames that state each turn are folded as they arrive.
      const events = await openStream(origin, created.conversationId, 5000);
      try {
        // The barrier is the frame that states this turn's answer committed and no run in flight. The expected answer
        // names the turn, because a conversation that already settled an earlier turn would otherwise look settled at
        // the moment its stream opens.
        const settle = async (requestId: string, text: string, answer: string) => {
          const submit = await fetch(path + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text }) });
          assert.equal(submit.status, 202, await submit.text());
          return await events.follow(window => !window.busy && window.entries.some(entry => entry.role === "assistant" && entry.text === answer));
        };
        const expanded = await settle("skill-1", "/skill:deploy ship it", "expanded");
        const submitted = expanded.entries.find((entry: Entry) => entry.role === "user");
        // The command expands against the adopted catalog and the real host path: no pi-resource:// URI anywhere.
        assert.ok(submitted !== undefined, JSON.stringify(expanded.entries));
        assert.match(submitted.text, /<skill name="deploy" location="/);
        assert.ok(submitted.text.includes(skillFile), submitted.text);
        assert.match(submitted.text, /References are relative to /);
        assert.match(submitted.text, /Deploy steps\./);
        assert.match(submitted.text, /ship it/);
        assert.doesNotMatch(submitted.text, /pi-resource:\/\//);
        const commands = await (await fetch(path + "/commands", { headers })).json();
        assert.deepEqual(commands.commands.map((command: { name: string }) => command.name), ["skill:deploy"]);
        const read = await settle("skill-2", "read the skill files", "reads done");
        const results = read.entries.filter((entry: Entry) => entry.role === "toolResult");
        assert.equal(results.length, 2, JSON.stringify(read.entries));
        assert.ok(results.every((entry: Entry) => entry.message.role !== "toolResult" || entry.message.isError !== true));
        assert.match(results[0].text, /Deploy steps\./);
        assert.match(results[1].text, /echo deploy/);
      } finally { await events.close(); }
    } finally { backend.server.closeAllConnections(); await backend.close(); }
  } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); }
});
