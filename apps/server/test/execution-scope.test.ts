import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, EnvTarget, Extension, EntryRecord } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { GatewayRpcServer, LocalGateway, MemoryLedger, gatewayEnvironment } from "@hepi/gateway";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/**
 * The execution scope of one tool call, observed at the durable runtime's own seam: a tool runs in the environment the
 * harness built for its call, and the identity each command runs under is what the gateway's ledger records.
 *
 * Three environments are driven through the same installed `coding-tools` selection: a gateway environment that has a
 * call scope, an ordinary upstream `ExecutionEnv` that has none, and no environment at all. A wrapper that assumed the
 * private method would break the last two, so they are asserted, not assumed.
 */
const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

/** The gateway's ledger, with the call IDs it admitted: the identity each execution really ran under. */
class RecordingLedger extends MemoryLedger {
  readonly admitted: string[] = [];
  override begin(callId: string, fingerprint: string): boolean {
    this.admitted.push(callId);
    return super.begin(callId, fingerprint);
  }
}

/** The call ID inside a ledger key: the gateway scopes a key by its own id, the workspace, and the call. */
function callIdOf(recorded: string): string {
  return recorded.split("\u0000").at(-1)!;
}

function toolResults(page: { items: readonly EntryRecord[] }): { text: string; isError: boolean }[] {
  return page.items.filter(entry => entry.kind === "pi.tool-result").map(entry => {
    const message = entry.model?.[0];
    const result = message !== undefined && message.role === "toolResult" ? message : undefined;
    return { text: result === undefined ? "" : contentText(result.content), isError: result?.isError === true };
  });
}

test("a coding-tools call runs in its own call scope, and an environment without one still runs the tool", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-execution-scope-"));
  directories.push(directory);
  // The execution host's own account: a workspace root that exists, because the gateway canonicalizes it on the host.
  const root = join(directory, "workspace");
  await mkdir(root, { recursive: true });
  const ledger = new RecordingLedger();
  const gateway = new GatewayRpcServer({
    gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces: new WorkspaceRegistry([{ id: "local", root }]), allowedCommands: ["bash"] }, ledger),
  });
  await new Promise<void>(resolve => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const plain = new NodeExecutionEnv({ cwd: root });
  let scopedId: string | undefined;
  let plainId: string | undefined;
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  // The factory answers per conversation, which is the state a real deployment resolves too: the bound conversation
  // reaches the gateway, one test conversation gets an ordinary upstream environment, and one gets nothing at all.
  const harness = await openServerHarness(join(directory, "scope.sqlite"), SERVER_MODEL, models, async (target: EnvTarget) => {
    const id = String(target.conversationId);
    if (id === scopedId) return gatewayEnvironment(binding, target.cwd ?? "/");
    if (id === plainId) return plain;
    return undefined;
  });
  try {
    const codingTools = harness.registry.snapshot().extension("coding-tools") as Extension;
    assert.ok(codingTools !== undefined, "the coding-tools extension is installed");
    const opened = async (): Promise<Conversation> => harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, extensions: [codingTools] } }, BACKGROUND_CONTEXT);
    const scoped = await opened();
    const ordinary = await opened();
    const unbound = await opened();
    scopedId = String(scoped.id);
    plainId = String(ordinary.id);

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf scoped-output" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("scoped done"),
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf ordinary-output" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ordinary done"),
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf unbound-output" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("unbound done"),
    ]);
    const settle = async (conversation: Conversation, requestId: string): Promise<void> => {
      const submission = await conversation.submit({ type: "input", content: "run bash", requestId }, BACKGROUND_CONTEXT);
      await submission.wait(BACKGROUND_CONTEXT);
    };

    await settle(scoped, "scope-1");
    const scopedResults = toolResults(await scoped.entries({}, 20, undefined, BACKGROUND_CONTEXT));
    assert.equal(scopedResults.at(0)?.isError, false, scopedResults.at(0)?.text);
    assert.match(scopedResults.at(0)?.text ?? "", /scoped-output/);
    // The command ran under the call's own identity: the conversation, the task and the call, then the command's own
    // ordinal within that scope. A bare random ID would mean the scope never reached the command.
    assert.equal(ledger.admitted.length, 1, "the scoped call reached the gateway exactly once");
    const execCallId = callIdOf(ledger.admitted[0]!);
    assert.match(execCallId, /#1$/, execCallId);
    assert.ok(execCallId.startsWith(scopedId + ":"), execCallId);

    await settle(ordinary, "scope-2");
    const ordinaryResults = toolResults(await ordinary.entries({}, 20, undefined, BACKGROUND_CONTEXT));
    assert.equal(ordinaryResults.at(0)?.isError, false, ordinaryResults.at(0)?.text);
    assert.match(ordinaryResults.at(0)?.text ?? "", /ordinary-output/);
    assert.equal(ledger.admitted.length, 1, "an environment without a call scope never reached the gateway");

    await settle(unbound, "scope-3");
    const unboundResults = toolResults(await unbound.entries({}, 20, undefined, BACKGROUND_CONTEXT));
    assert.equal(unboundResults.at(0)?.isError, true, "a conversation with no environment reports it instead of throwing");
    assert.match(unboundResults.at(0)?.text ?? "", /No execution environment is configured/);
  } finally {
    await plain.cleanup(BACKGROUND_CONTEXT);
    await harness.close();
    await gateway.close();
  }
});

test("a lost gateway answer reaches the model as an outcome-unknown tool result and is never resent", { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "hepi-execution-unknown-"));
  directories.push(directory);
  const root = join(directory, "workspace");
  await mkdir(root, { recursive: true });
  // A gateway that dispatches the call, streams one output frame and then dies: the answer is lost, the command may have run.
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push(String((JSON.parse(body) as { callId: string }).callId));
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(JSON.stringify({ type: "output", stream: "stdout", text: "partial-output" }) + "\n");
      setImmediate(() => response.destroy());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let conversationId: string | undefined;
  const harness = await openServerHarness(join(directory, "unknown.sqlite"), SERVER_MODEL, models, async (target: EnvTarget) => {
    conversationId = String(target.conversationId);
    return gatewayEnvironment(binding, target.cwd ?? "/");
  });
  try {
    const codingTools = harness.registry.snapshot().extension("coding-tools") as Extension;
    assert.ok(codingTools !== undefined, "the coding-tools extension is installed");
    const conversation = await harness.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: SERVER_MODEL, extensions: [codingTools] } }, BACKGROUND_CONTEXT);
    conversationId = String(conversation.id);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "printf partial-output" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("seen"),
    ]);
    const submission = await conversation.submit({ type: "input", content: "run bash", requestId: "unknown-1" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
    const results = toolResults(await conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT));
    assert.equal(results.at(0)?.isError, true, results.at(0)?.text);
    // The recovery vocabulary survives to the model: the lost answer says may-have-run and names the spent call ID, so
    // "unknown outcome" is not read as "failed" or "timed out" by the caller that has to decide what to do next.
    assert.match(results.at(0)?.text ?? "", /outcome_unknown:/, results.at(0)?.text);
    assert.match(results.at(0)?.text ?? "", /may have run/, results.at(0)?.text);
    assert.match(results.at(0)?.text ?? "", /never replayed/, results.at(0)?.text);
    assert.match(results.at(0)?.text ?? "", new RegExp(conversationId + ":[^\\s,)]+#1"), results.at(0)?.text);
    assert.equal(requests.length, 1, "the lost answer was not sent again under any identity");
    assert.match(results.at(0)?.text ?? "", /partial-output/, "output delivered before the loss is kept");
  } finally {
    await harness.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
