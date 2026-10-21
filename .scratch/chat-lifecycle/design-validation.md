# Chat lifecycle design — critical validation

Validation only; product baseline **83cc7c8**. Reviewed consolidated design **81771fa** and B **725cb4c**;
A **c0c650a** supplies the earlier projectionId proposal. Date: 2026-10-12. Own branch: review/chat-lifecycle-design-validation.
Paths below reference product baseline unless explicitly marked design/native. No application changes or deployment.
Standards and Spec passes performed by this reviewer, sequentially; no further delegation.
Source aliases: server.ts = apps/server/src/server.ts; durable-api.ts = apps/web/adapters/durable-api.ts;
protocol/src/index.ts = packages/protocol/src/index.ts; UI basenames = apps/web/components/.
Native paths refer to @earendil-works/pi-durable 1.1.0 dist/ (pinned in baseline pnpm-lock.yaml:649).

## Standards

No material documented-standard violation. Pure projection plus existing transport ownership follows copy-first policy.
Protocol changes must land at their owning backend/protocol/adapter seams, not as caller-specific clock guards.

## Spec — findings first

- **P1 / fix before implementation:** design.md:106–108 and B facts.md:90–91 equate client attachment with backend
  clock lineage. Delayed HTTP from the old backend can suppress or overwrite fresh SSE after restart. Require backend
  projection identity plus an explicit acquisition/fencing rule; an opaque token alone does not order different clocks.
- **P1 / coverage gate:** design.md:144–147,164,183–184 leave background sound on busy disappearance until a later phase.
  Keeping it violates explicit-terminal-only success; deleting it loses notifications when ChatWindow is unmounted.
  Replace fact delivery and acceptance coverage before either removal or claiming lifecycle completion. All-catalogue
  streams are not necessary, and no background delivery guarantee exists in the present catalogue response.

## Actual authority and object lifetime

- server.ts:354–356 acquires two native watches; :378 initializes revision=0 **per attachConversation instance**;
  :405–416 publishes snapshots, :426–430 advances that instance's counter. This is not a native commit sequence.
- server.ts:679–682,740–747 caches ConversationRuntime by conversation; :765–781 attaches stored conversations at boot;
  :1539 closes them at shutdown. An SSE connection neither creates nor resets that runtime's clock.
- HTTP state (:1325) and SSE acquisition (:1453–1459) both read item.snapshot(). Subsequent SSE state uses the same
  runtime (:415). Their revisions are comparable only when both originated from that **same runtime object**.
- Browser reconnect to the same backend can retain that lineage; backend restart/replacement recreates it at zero.
  No projection identity travels today. Adapter durable-api.ts:65–68 drops revision; :407 returns only sessionData;
  :681 adds busy/submissions to SSE but still drops revision. HTTP is not yet the complete lifecycle snapshot design assumes.
- Native watchEvents has batches, run inputs and generation (native harness/events.js:16–20,213–234), but backend
  events.start forwards only submission records, individually (server.ts:435–450). Native fields are not existing wire fields.

## Counterexamples: two independent clocks, not one client token

Let old runtime A be at r100, replacement B at r0. A/B denote backend identities; g denotes client acquisition generation.

| schedule | defective rule | visible failure |
| --- | --- | --- |
| HTTP samples A100; B restarts; SSE B0 arrives; delayed HTTP A100 arrives, both stamped g | max revision within g | B0 ignored if A100 came first; otherwise stale A100 wins |
| Same schedule, but HTTP and SSE each get a distinct client attachment | every different attachment rebases | late A100 rebases backwards over B0 |
| SSE B0 selected; old HTTP A100 arrives carrying backend token A | every different backend token rebases | token identifies mismatch but still allows rollback |
| Cancel g1; accept SSE B0 in g2; old HTTP finishes and adapter stamps g2 at completion | token assigned on delivery | cancellation fence defeated; stale read masquerades as current |
| HTTP B7 and SSE B8, one backend object, same g | compare within backend identity | ignore late B7; correct |

These are source-grounded schedules, not claimed browser reproductions. Delayed reads and deploy/restart overlap are
ordinary; wrong busy/transcript/readiness is material. Local staged intent must remain separate whichever frame wins.

## Minimal ordering contract

1. Backend mints an opaque **projectionId once inside attachConversation**, stable for that object and carried with
   revision on every complete snapshot, HTTP and SSE. A random instance token suffices; no durable epoch/table needed.
2. Caller assigns g when acquisition begins; every HTTP request and SSE callback captures it then. Fold rejects older g.
   Cancellation alone is insufficient: a response may already be queued. Adapter-local g is not backend identity.
3. A first complete HTTP projection may hydrate immediately. SSE acquisition selects the authoritative projectionId
   for that g. Rebase across different IDs even at a smaller revision; within the same ID keep the newer revision.
   This never waits for a pending HTTP response.
4. After SSE acquisition, HTTP with another projectionId cannot rebase. Keep accepted view; request fresh acquisition.
   A genuinely new backend seen first via HTTP follows this same path. Different opaque IDs have no numerical order.
5. New acquisition fences old callbacks. Within selected projectionId accept newer snapshot revisions, ignore older;
   equal snapshot is idempotent. HTTP-only operation needs explicitly serialized acquisition generations, not arrival order.
   Preserve good view during reattachment; readiness does not revert to Loading merely because a stream reconnects.
6. Lifecycle frames are not snapshots: fence their connection, validate conversation and monotone submission transition.
   Do not discard a terminal record solely because a state snapshot has an equal/higher revision. Today's submission
   frames have no revision (:420–450); a shared total frame sequence would be additional protocol work, not an existing fact.

ProjectionId is necessary for this design's cross-transport comparison. A strict single-transport generation barrier could
avoid it by forbidding cross-source comparison entirely, but is a different ordering contract, not proof g shares a clock.
It would also need to handle an HTTP request reaching an old backend after SSE acquisition; token makes that detectable.
Two native watches still advance independently; this recommendation does not promise a commit-atomic combined snapshot.

## Required vs conditional protocol changes

| addition | verdict / evidence |
| --- | --- |
| input done answerId | **Required.** protocol/src/index.ts:153–177 drops answer; native types.d.ts:337–340 supplies it. Preserve input/write discriminant and unanswered reason. |
| runInputs, null when no run | **Required for chosen activity view.** server.ts:243 exposes only busy; native harness/live.d.ts:43–47 has inputs. Empty inputs alone must not imply no run. |
| projectionId + revision | **Required for selected ordering contract**, preserved end-to-end on complete HTTP/SSE snapshots. Not a persisted restart counter. |
| complete HTTP lifecycle payload | **Required.** Include native activity, outstanding submissions and identities with transcript; do not combine unrelated HTTP reads into a supposedly atomic snapshot. |
| native batch envelope | **Optional representation.** Existing SSE splits records. Either forward native groups or retain bounded answer-group dedup until all interested inputs reconcile; never sound once per record. |
| lifecycle wire revision/ordinal | **Conditional.** Needed if lifecycle participates in a common ordered-envelope protocol; unnecessary if snapshot clock and fenced lifecycle transitions stay separate. |
| scoped submissionId lookup | **Conditional on interests without requestId**, not required for every local send and not itself a background feed. Can extend existing route; no separate endpoint required. |

Native endRun settles every run input with the same answer (harness/live.js:24–28; generation.js:419–421).
Success notice key is (conversationId, answerId), not input ID, run_end, or busy transition. A follow-up has its own answer.
A batch is useful but not intrinsically required; dropping all group bookkeeping after the first individual terminal
frame is unsafe when a second steer shares its answer. Test separate-frame delivery as well as grouped delivery.

## Recovery lookup: use existing capability first

- Browser-owned inputs already carry requestId (durable-api.ts:450–451); preserve it after placement and through remount.
  Existing backend :1330–1334 / adapter :435–437 looks up that durable record. Lost receipt does not require a new ID query.
- For another browser's observed inputs, supplied requestId also suffices. Native requestId is optional (types.d.ts:313–317).
  If chosen contract tracks **all** native run inputs, a missing-requestId interest requires scoped ID lookup after a gap.
  Harness.submission already exists (types.d.ts:844–849); verify record.conversationId before returning it. No new primitive.
- If scope is restricted to requestId-bearing interests, omit that query and document uncovered native inputs; do not emit
  an unusable lookup-by-ID effect. Null/error stays unknown, never resend. History and recovery lookup remain silent.
- Abort/recall show native unanswered reason, never success audio. Native queued withdrawal uses reason=aborted
  (harness/submissions.js:64–76); distinguish user action only when its receipt proves it. No recalled primitive needed.

## Background delivery: prerequisite, not a stream-per-session mandate

Current path: durable-api.ts:357–363 maps catalogue to running IDs; SessionSidebar.tsx:800–835 treats disappearance as
completion and invokes AppShell.tsx:137–139 audio. Catalogue server.ts:753–761 has no terminal records/answer identity.
Busy disappearance cannot distinguish answered from aborted. A submission lookup repairs state silently; it is not a
substitute success signal, so adding scoped ID lookup alone cannot satisfy the background requirement.

Existing backend already watches attached conversations whether a browser follows them (:765–781). Options to scope:
- Keep existing SSE only for active/interested conversations after navigation; stop on settlement. This is bounded by
  actual unfinished work, not every catalogue entry. Specify poll-to-subscribe race and ownership transfer to avoid duplicates.
- Project native terminal facts through existing catalogue/running poll. A newest-answer summary is bounded and replaces
  today's coalesced signal, but loses intermediate answer groups between polls. It is insufficient for universal one/group.
  Native Harness.scanSubmissions/submission (types.d.ts:844–849) can support scoped fact retrieval; admission-ID cursor
  alone misses older queued inputs settling later. Outstanding interests must also be revisited. Exact delta/paging contract
  remains integration work, not a missing runtime capability and not permission to invent a replay framework here.
  Initial poll and post-gap recovery baseline are silent; only subsequent explicit live facts can notify.

**Unresolved coverage gate:** choose scoped terminal-fact delivery with acquisition/gap behavior before deleting the old
sound source. Demonstrate selected→background completion, foreign/previously-unmounted run, grouped steers, follow-up,
abort/failure, restart, duplicate delivery and no history/recovery audio. Preserve unread/subagent suppression policy.
No claim of complete coverage today; no arbitrary all-catalogue streams, new harness, global controller or durable epoch.

## Validation boundary / next step

Static source/native-1.1.0 inspection plus counterexample schedules only; no new browser/server/model run, live writes,
paid calls, or cleanup. Existing reds were not rerun. Source remains 83cc7c8; report is design advice, not patch approval.
Doc-only validation command/log: .dev/verify/chat-lifecycle-design-validation/check.log in this worktree.
Accept A's seam and B's native semantics; amend ordering and resolve background coverage, then write implementation tickets.
