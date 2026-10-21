# Handoff to the UI worker — the two Web test premises my backend change invalidates

Owner of these files: the UI worker (25) / the adapter's owner. I do not edit them. Both failures below are the **same
class** as the backend fixtures I already re-expressed: they assert the *old* premise "a large **text** output has no read
block", which this fix removes. Neither is a regression in behaviour.

Run to reproduce (both were failing in my last full web-unit run: 18 failures vs the recorded 16 baseline, and these are
the two extra):

```
cd apps/web && node --test adapters/durable-api.test.mjs hooks/useAgentSession.lifecycle.test.mjs
```

## 1. `apps/web/adapters/durable-api.test.mjs:172` — the read-block name list

```diff
-  assert.match(blocks, /parts\[4\] === "thinking" \|\| parts\[4\] === "tool-result-image"/);
+  // Three read blocks now: thinking, the full text behind a deferred preview, and the tool-result image bytes.
+  assert.match(blocks, /parts\[4\] === "thinking" \|\| parts\[4\] === "text" \|\| parts\[4\] === "tool-result-image"/);
```

The adapter source already carries the widened list (the parent's proxy change). The test name is still accurate; only
the asserted name list moved. The parent's own `adapters/text-read-block.test.mjs` already covers the new branch
end-to-end, so this assertion is the shape check beside it.

## 2. `apps/web/hooks/useAgentSession.lifecycle.test.mjs:587` — the oversize fixture

The test seeds a conversation whose newest entry is a tool result carrying ~1.7 MB of **text**, then asserts
`/state` answers **413**. Text is now deferred to a preview behind a read block, so the frame is carried and the read
answers **200** — the exact behaviour this fix introduces, and the reason the test's own doc comment ("deferral has no
read block for a text output") no longer holds.

The fixture must use content no policy can defer, the same substitution I made in `apps/server/test/frame-size.test.ts`
and `delta-frames.test.ts`: a structured tool call whose `arguments` carry the bulk. Two edits inside this one test:

```diff
@@ imports (near line 593)
-  const { ToolResultEntry, UserEntry } = await jiti.import(file("../../server/node_modules/@earendil-works/pi-durable/dist/index.js"));
+  const { AssistantEntry, UserEntry } = await jiti.import(file("../../server/node_modules/@earendil-works/pi-durable/dist/index.js"));
@@ near line 597
   const { fauxProvider } = await jiti.import(serverAi + "providers/faux.js");
+  const { fauxAssistantMessage, fauxToolCall } = await jiti.import(serverAi + "providers/faux.js");

@@ the seeded entries (near line 608)
-    await tx.appendEntry(UserEntry, conversation, { model: [{ role: "user", content: "run the build", timestamp: 0 }] });
-    await tx.appendEntry(ToolResultEntry, conversation, { model: [{ role: "toolResult", toolCallId: "call-log", toolName: "bash", content: [{ type: "text", text: "build log line: ".repeat(110_000) }], isError: false, timestamp: 1 }], data: { diagnostics: [] } });
+    await tx.appendEntry(UserEntry, conversation, { model: [{ role: "user", content: "run the build", timestamp: 0 }] });
+    // A structured tool call whose arguments carry the bulk: no deferral policy applies to it, so the frame really
+    // cannot be shrunk and the backend really answers its named refusal.
+    await tx.appendEntry(AssistantEntry, conversation, { model: [fauxAssistantMessage(fauxToolCall("write", { path: "/tmp/build.log", content: "build log line: ".repeat(110_000) }), { timestamp: 1 })] });
```

The rest of the test (413, `reason`, `entryId`, `bytes > 1 MiB`, the stream's `state_oversize`, "settles nothing")
stays exactly as it is — the refusal path it locks down is unchanged; only the content that provokes it moved.

**Optional, same reasoning:** the test's doc comment at line ~580 says "deferral has no read block for a text output,
and an entry is never split or dropped". After this fix that sentence is false for text and true for a structured tool
call; worth one line of correction while the file is open.

## Why I did not fix these myself

They are in Web files owned by the UI worker / adapter owner, and my scope is the backend, history, read API, its tests,
`apps/web/lib/types.ts` and `normalizeToolCalls` if needed. Both edits are mechanical and each is covered by a real
behaviour check (the parent's `text-read-block.test.mjs` and my `history-text.test.ts`), so the risk is in leaving them
red, not in the change.
