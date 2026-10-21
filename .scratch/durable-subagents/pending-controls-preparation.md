# 09 preparation — read-only

Source inspected by agent95:938d682, confirmed against accepted06 productb74f379. No tests, build or product edits in this preparation.09 remains blocked07; this note is navigation/reference, not a final schema or verification result. Approved behavior stays in [ticket09](issues/09-pending-item-controls.md) and [spec](spec.md).

## Native ownership

`InboxItem.content` owns queued input content. `SubmissionRecord` owns identity/status/requestId, not content. Edit through public `tx.doc(InboxDoc, conversationId)` in one commit: locate the same item, confirm still queued and compare the prior content token before changing content. Keep submissionId/requestId; edit neither the child original nor held control. There is no native edit helper to reuse and no new engine patch is needed.

Cancel uses public `Harness.abortSubmission(id, context, conversationId)`. First cancellation returns aborted; retry returns settled because the native record is now unanswered. Derive idempotent cancellation from that stored record; placed is a conflict. Original requestId remains lookupable. Deep-import inbox helpers are unnecessary.

07 retry must find the original submission before admission and preserve edits/cancellations. Normal idle recipients must auto-wake; global triggerTurn:false would violate07. Held recipients stay queued through the native atomic held gate and no agent resume. Running recipients use the follow-up boundary.

## Existing seams

- Server `conversation-operations.ts`: stop/continue/send/control and future item mutation. `conversation-input.ts`: admission/dedup under original requestId. `server.ts`: frame projection, submissions lookup, controls, whole-queue recall.
- Protocol `ServerSnapshot`: current queuedMessages are bare text arrays; submissions carry identity separately.09 needs one coherent item projection with id/mode/text/source/token. Derive compatibility strings only for a real consumer, not to preserve old assertions. No second authoritative queue.
- Web `durable-projection.ts` projects frame/control; `useAgentSession.ts` owns accepted session state, send/abort/recall and recovery. `lifecycle-projection.ts` remains the only pending-turn fold. An arriving report is a native queued item, not a browser PendingTurn.
- `ChatInput.tsx` owns queue rows and clears composer before dispatch. `draft-store.ts` owns durable draft restoration/merge. Adapter `durable-api.ts` has clear_queue but currently no explicit stop/continue/control command cases.

## Stopping and draft recovery

Native continue can return stopping with no submissionId while old ordinary tasks drain. Preserve composer and pending text; do not fabricate a receipt or leave a staged turn as a phantom Preparing bubble. Resume input keeps the caller original requestId. Empty continue consumes existing queue without appending a fake user message. Old HTTP responses must not overwrite newer stop/queue decisions. Existing requestId lookup remains authoritative for missing submission outcomes; no automatic resend under a new identity.

## Questions for07

Obtain actual guaranteed report InputEntry.kind/data schema, source conversation/dispatch/child submission/answer entry references and string-id conventions; stable delivery requestId rule; truncation flag/read reference; inbox mode; location of delivery terminal state such as recipient_deleted. Agent94 has these questions. Do not invent fields before that contract arrives.

## Verification when09 implements

Real HTTP/model/SQLite: stop→late report gives zero parent model requests; edit succeeds with matching token, stale tab/placed conflict; cancel/retry idempotent; control stays held with unchanged control revision. Reporter replay preserves edited/cancelled copies and original lookup. Continue stopping retains text; later authorized continuation consumes only retained content; empty continuation adds no input. Keep ordinary recall working.

Pinned SIGKILL/reopen must preserve edit/cancel/hold decisions. Production browser: actual late reports, edit/cancel then Continue, verify next real parent model request contains edited content and excludes cancelled content; two-tab conflict, reload and original child unchanged. No browser/build/test evidence exists yet for09.
