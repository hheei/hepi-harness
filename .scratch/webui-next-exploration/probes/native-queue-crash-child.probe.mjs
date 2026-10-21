import assert from "node:assert/strict";
import { createRequire } from "node:module";
const serverRoot = new URL("../../../apps/server/", import.meta.url);
const require = createRequire(new URL("package.json", serverRoot));
const { Harness, MemoryStorage, createRegistry, InboxDoc } = await import(require.resolve("@earendil-works/pi-durable"));
const { createModels } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/models.js", serverRoot));
const { fauxProvider, fauxAssistantMessage } = await import(new URL("node_modules/@earendil-works/pi-ai/dist/providers/faux.js", serverRoot));
const context = {};
let modelCalls = 0;
const faux = fauxProvider();
faux.setResponses(Array.from({ length: 6 }, () => async () => { modelCalls += 1; return fauxAssistantMessage("done"); }));
const models = createModels();
models.setProvider(faux.provider);
const { openNodeSqliteStorage } = await import(require.resolve("@earendil-works/pi-durable/storage/sqlite/node"));
const stage = process.argv[2];
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[3]), { models, registry: createRegistry() }, context);
const conversation = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
try {
  if (stage === "crash") {
    await conversation.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, conversation.id);
      const record = await tx.createSubmission({ conversationId: conversation.id, requestId: "crash-report", type: "input", status: "queued" });
      inbox.items.push({ id: record.id, mode: "followUp", content: "before-edit" });
    }, context);
    await conversation.commit(async tx => { (await tx.doc(InboxDoc, conversation.id)).items[0].content = "edited-before-crash"; }, context);
    process.kill(process.pid, "SIGKILL");
  } else if (stage === "reopen") {
    harness.resume();
    await conversation.waitForIdle(context);
    const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].content, "edited-before-crash");
    assert.equal(modelCalls, 0);
    const record = await harness.commit(tx => tx.submissionByRequest(conversation.id, "crash-report"), context);
    assert.equal(record.status, "queued");
    assert.equal(await harness.abortSubmission(record.id, context, conversation.id), "aborted");
    console.log(JSON.stringify({ case: "SIGKILL then SQLite reopen preserves native queue and edit without wake", passed: true }));
  } else if (stage === "reopen-cancel") {
    const record = await harness.commit(tx => tx.submissionByRequest(conversation.id, "crash-report"), context);
    assert.equal(record.status, "unanswered");
    assert.equal(record.reason, "aborted");
    assert.equal((await harness.snapshot(InboxDoc, conversation.id, context)).items.length, 0);
    console.log(JSON.stringify({ case: "native cancellation receipt survives reopen", passed: true }));
  } else throw new Error("Unknown stage");
} finally { await harness.close(context); }
