import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [stage, database, packageRoot] = process.argv.slice(2);
const require = createRequire(join(packageRoot, "package.json"));
const durablePath = require.resolve("@earendil-works/pi-durable");
const { Harness, createRegistry, InboxDoc } = await import(durablePath);
const { openNodeSqliteStorage } = await import(require.resolve("@earendil-works/pi-durable/storage/sqlite/node"));
const { Type } = await import(createRequire(durablePath).resolve("typebox"));
const { createModels } = await import(pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/models.js")));
const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(join(packageRoot, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js")));
const context = {};
const faux = fauxProvider();
let modelCalls = 0;
let toolCalls = 0;
faux.setResponses([async () => {
  modelCalls += 1;
  return stage === "tool-crash"
    ? fauxAssistantMessage([fauxToolCall("probe", { value: "legacy-args" })], { stopReason: "toolUse" })
    : fauxAssistantMessage("recovered");
}]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install({ name: "upgrade-probe", tools: [{
  name: "probe", description: "Replay-safe migration probe", parameters: Type.Object({ value: Type.String() }), replay: "safe",
  async execute(args) {
    assert.equal(args.value, "legacy-args");
    toolCalls += 1;
    if (stage === "tool-crash") process.kill(process.pid, "SIGKILL");
    return { output: [{ type: "text", text: "replayed legacy task" }] };
  },
}] });
const harness = await Harness.open(await openNodeSqliteStorage(database), { models, registry }, context);
const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
try {
  if (stage === "queue-crash") {
    await conversation.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const submission = await tx.createSubmission({ conversationId: conversation.id, requestId: "legacy-queued", type: "input", status: "queued" });
      inbox.items.push({ id: submission.id, mode: "followUp", content: "edited legacy input" });
    }, context);
    process.kill(process.pid, "SIGKILL");
  } else if (stage === "queue-reopen") {
    harness.resume();
    await conversation.waitForIdle(context);
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].content, "edited legacy input");
    assert.equal(modelCalls, 0);
    const receipt = await harness.commit(tx => tx.submissionByRequest(conversation.id, "legacy-queued"), context);
    assert.equal(receipt.status, "queued");
    assert.equal(await harness.abortSubmission(receipt.id, context, conversation.id), "aborted");
    console.log(JSON.stringify({ case: "1.1 SQLite held queue -> SIGKILL -> 1.3 reopen, no wake, native cancel", passed: true }));
  } else if (stage === "tool-crash") {
    await conversation.submit({ type: "input", content: "run migration probe", requestId: "legacy-running" }, context);
    await conversation.waitForIdle(context);
    throw new Error("Expected SIGKILL during legacy tool execution");
  } else if (stage === "tool-reopen") {
    harness.resume();
    await conversation.waitForIdle(context);
    assert.equal(toolCalls, 1);
    assert.equal(modelCalls, 1);
    const receipt = await harness.commit(tx => tx.submissionByRequest(conversation.id, "legacy-running"), context);
    assert.equal(receipt.status, "done");
    console.log(JSON.stringify({ case: "1.1 in-flight replay-safe pi.tool v1 -> SIGKILL -> 1.3 native v2 migration and completion", passed: true }));
  } else throw new Error("Unknown stage");
} finally { await harness.close(context); }
