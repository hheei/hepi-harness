# Chat lifecycle design — consolidated (A shape, B contract, C lessons, 73 ordering)

Design only. No product source, protocol build, or deployment change. Baseline **83cc7c8**; branch
`design/chat-lifecycle-ui`. Inputs: **A** `minimal.md` (`c0c650a`), **B** `facts.md` (`725cb4c`), **C** `ui-session.md`
(`4e003be`); evidence **a7a5ef5**, **31a11f9**; `chat-lifecycle-review/diagnosis.md`; critical validation **73**
`chat-lifecycle-design-validation/design-validation.md` (accepted, incorporated). Vocabulary: GLOSSARY (Pending Submission,
Committed Message, Submission Outcome Unknown), ADR 0001, ADR 0006.

**Proven red:** a locally invented running state plus the initial native idle snapshot plays the completion sound before
the provider is entered; a held HTTP read separately keeps the UI on Loading though complete SSE arrived. **Unknown:** the
reported multi-second stall; this document does not claim to fix it.

## Chosen shape — A's pure fold, B's invariants, no new I/O owner

Deepen **`apps/web/lib/submission-reconciliation.ts`** into a pure, conversation-scoped projection module with two entry
points; the transport and hook stay thin callers keeping connection, remount and rendering. The module owns no socket, timer,
store, registry, scheduler, React, or retry queue — no new client/IO controller — and its invariants are testable without a
browser. A beats C: B is deep but shallow for callers, and C buys depth with a second stream owner.

~~~ts
type ProjectionId = string;   // opaque, minted by the backend once per attachConversation
type Acquisition = number;    // client generation g, stamped when a read/stream begins
type Scope = { composerKey: string; conversationId?: string };
type Subject = { requestId: string } | { submissionId: string };
type Submission = { type: "input" | "write"; id: string; requestId?: string } & (  // native SubmissionRecord
  | { status: "queued" } | { status: "placed"; entryId: string }
  | { status: "done"; entryId: string; answerId: string }        // answerId: inputs only
  | { status: "unanswered"; entryId?: string; reason: string });
type Snapshot = { projectionId: ProjectionId; revision: number; data: SessionData;
  run: null | { inputs: readonly string[] }; submissions: readonly Submission[] };
type Observation = { conversationId: string } & (
  | { kind: "snapshot"; acquisition: Acquisition; via: "http" | "sse"; snapshot: Snapshot }
  | { kind: "lifecycle"; acquisition: Acquisition; records: readonly Submission[];   // not a snapshot; own connection
      endedRuns: readonly { inputs: readonly string[] }[] }
  | { kind: "receipt"; requestId: string; submissionId: string }
  | { kind: "lookup"; acquisition: Acquisition; subject: Subject; record: Submission | null }
  | { kind: "refusal"; requestId: string; reason: string });
type Input = Observation
  | { kind: "stage"; requestId: string; content: StagedContent; whenBusy: "steer" | "followUp" | "reject" }
  | { kind: "promote"; conversationId: string }
  | { kind: "begin"; acquisition: Acquisition; via: "http" | "sse" }   // caller stamps g when acquisition starts
  | { kind: "unavailable"; acquisition: Acquisition; requestId?: string; reason: string };
type View = { ready: "loading" | "ready" | "unread";   // "unread": no complete projection, readable failure
  data?: SessionData; messages: readonly AgentMessage[];             // committed history only
  pending: readonly PendingTurn[];                // overlay: this input's own user entry not yet committed
  outstanding: readonly AnswerInterest[];         // user entry committed; answer not terminal yet
  activity: null | { inputs: readonly string[] };  // the native run only
  issue?: { kind: "transport" | "protocol" | "outcome-unknown"; message: string } };
type Notice = { kind: "answered"; answerId: string; inputs: readonly string[] }
  | { kind: "unanswered"; submissionId: string; reason: string }
  | { kind: "refused"; requestId: string; restore: StagedContent };
type Effect = { kind: "lookup"; acquisition: Acquisition; subject: Subject }   // requested I/O; fold does no I/O
  | { kind: "reattach"; acquisition: Acquisition };
type Step = { state: State; view: View; notices: readonly Notice[]; effects: readonly Effect[] };
function createProjection(scope: Scope): Step;      // pure; no I/O
function advance(state: State, input: Input): Step; // pure; validates, orders, folds
~~~

`Input` is five top-level cases expanding to nine kinds once Observation's five are counted — real lifecycle vocabulary,
not a small interface; callers never order transports, join identities, or decide completion. The four `View` fields above
stay separate concepts, and none ends at a `busy` edge.

## Ordering — backend projection identity, client acquisition fence (73)

The backend `revision` is a counter **per attachConversation instance** (`server.ts:378`, `:426–430`), not a native commit
sequence: HTTP state (`:1325`) and SSE (`:1453–1459`) read one cached runtime object, and two instances are two clocks — an
attachment id alone cannot order them.

1. The backend mints an opaque **`projectionId` once inside `attachConversation`**, stable for that object and carried with
   `revision` on every complete snapshot, HTTP and SSE; a random instance token suffices and no durable epoch is needed.
2. The caller assigns `g` when acquisition **begins**, and every HTTP request and SSE callback captures it then; the fold
   rejects older `g`. Cancellation alone is insufficient (a response may already be queued); adapter-local `g` is not backend
   identity.
3. A first complete HTTP projection may hydrate immediately. SSE acquisition selects the authoritative `projectionId` for
   that `g`: rebase across different IDs even at a smaller revision, keep the newer revision within the same ID, never wait
   for a pending HTTP response. After SSE acquisition, HTTP with another `projectionId` cannot rebase — keep the accepted
   view and request fresh acquisition; a new backend seen first via HTTP follows the same path, and opaque IDs have no
   numerical order.
4. New acquisition fences old callbacks: within the selected `projectionId` accept newer revisions, ignore older, treat
   equal as idempotent; HTTP-only operation needs serialized acquisitions, not arrival order. Preserve the good view during
   reattachment — readiness never reverts to `loading` on reconnect.
5. **Lifecycle frames are not snapshots.** Fence their connection, validate conversation and a monotone submission
   transition, and never discard a terminal record because a state snapshot has an equal or higher revision. Today's
   submission frames carry no revision (`server.ts:420–450`); a shared total frame sequence is new protocol work.

Schedules this must reject (source-grounded, not claimed browser reproductions): delayed old-HTTP over fresh SSE after restart
under "max revision within g"; late old HTTP rebasing backwards under "every new attachment rebases"; an old-HTTP token
mismatch still rolling back; a cancelled `g1` read stamped at completion defeating the fence; and the legitimate case, HTTP
B7 ignored after SSE B8 within one backend identity.

## Invariants

1. **Only the fold orders**, per the five rules above. Terminal > `placed` > `queued`; a receipt or an older projection
   cannot regress a known fact.
2. **Overlay ends at the user entry; the answer interest survives it.** No committed entry, no `busy` edge, and no absence
   can end a turn — the proven premature sound becomes unrepresentable.
3. **Completion is a native terminal fact.** `answered` requires an input record `done` carrying its native `answerId`, or
   the committed answer entry joined by `answerId` — never `run_end`, `turn_end`, idle, a write's `entry`, or a `busy` edge.
4. **One answer, many inputs.** Native `endRun` settles every input of `run.inputs` with one settlement
   (`harness/live.js:24–28`), so a steer group produces **one** `answered` notice keyed by `(conversationId, answerId)` —
   not input ID, `run_end`, or a busy transition. A queued follow-up is a later run with its own answer and stays
   `pending`/`outstanding` across the earlier one; dropping group bookkeeping after the first individual terminal frame is
   unsafe when a second steer shares its answer.
5. **Readiness from either transport.** The first applied complete projection, HTTP or SSE, leaves `loading`; an in-flight
   HTTP read never gates an SSE projection, and a lifecycle-only frame never claims hydration.
6. **Failure is a state, not indefinite loading.** A read that fails with no prior complete projection yields
   `ready: "unread"` with `issue.kind === "transport"`; a failed read after a good one keeps the last view and sets the
   issue — no spinner without an end and no fabricated outcome.
7. **Absence is not a fact.** A null lookup answers nothing — the interest stays outstanding, unknown, never rejected, never
   resent (ADR 0006). A gap looks up unfinished interest by `requestId` or known `submissionId`, committed ones included.
8. **Idempotent admission, inert, bounded.** The caller supplies `requestId`; the same id is admitted once. Duplicate
   facts are no-ops; nothing opens a connection or runs a timer. State holds only the transcript's identities, unresolved
   interests and per-acquisition bookkeeping — no facts log, no unbounded ledger, no growing dedup set; the
   unfinished-interest registry has a maximum count and evicts settled entries.
9. **Errors.** `refused` alone restores the draft. A protocol contradiction (wrong conversation, invalid transition,
   input `done` without `answerId`) yields `issue.kind === "protocol"`, keeps the last good view, emits no notice.

## Store ownership and lifetime

The **caller** owns the value: the page creates it with `createProjection({ composerKey })` and passes `state` through the
composer→session promotion and the remount promotion causes, exactly as the draft and pending store are passed today. It is
not a module-global registry and not a new controller; the subscriber that keeps a background interest alive is the owning
parent, not the fold. `promote` binds the conversation to the same value, so a lookup reaches turns staged under the
composer key, and the value dies with the page. Scopes are bounded and tested: one value per composer/conversation, its own
value reachable only by its key; a switch uses another value; nothing cross-conversation, cross-tab, or persisted.

## Wire facts: required, conditional, pending (73)

**Existing, reused:** the snapshot (entries, run, generation, `revision`), the submission frame, the by-id lookup by
`requestId` (`server.ts:1330–1334`, adapter `:435–437`), `resync_required`, `SubmissionRecord`, `run_end` `inputs`.

| addition | verdict / evidence |
| --- | --- |
| input `done` `answerId` | **Required.** `protocol/src/index.ts:153–177` drops `answer`; native `types.d.ts:337–340` supplies it. Preserve the input/write discriminant and the `unanswered` reason. |
| `runInputs`, null when no run | **Required for the chosen activity view.** `server.ts:243` exposes only `busy`; native `harness/live.d.ts:43–47` has `inputs`. Empty inputs alone must not imply no run. |
| `projectionId` + `revision` | **Required for the selected ordering contract**, preserved end-to-end on complete HTTP/SSE snapshots. Not a persisted restart counter. |
| complete HTTP lifecycle payload | **Required.** Native activity, outstanding submissions and identities travel with the transcript; unrelated HTTP reads are not combined into a supposedly atomic snapshot. |
| native batch envelope | **Optional representation.** Either forward native groups or retain bounded answer-group dedup until all interested inputs reconcile; never sound once per record. |
| lifecycle wire revision/ordinal | **Conditional.** Needed only if lifecycle joins a common ordered-envelope protocol; unnecessary if the snapshot clock and fenced lifecycle transitions stay separate. |
| scoped `submissionId` lookup | **Conditional on interests without `requestId`**, not required for every local send and not itself a background feed. Extends the existing route; no separate endpoint. |

**Recovery uses the existing capability first.** Browser-owned inputs already carry `requestId` (`durable-api.ts:450–451`);
preserve it after placement and through remount. Native `requestId` is optional (`types.d.ts:313–317`). If the contract
tracks **all** native run inputs, a missing-`requestId` interest needs the scoped lookup after a gap (`Harness.submission`,
`types.d.ts:844–849`; verify `record.conversationId`); if scope is restricted to `requestId`-bearing interests, omit the
query and document the uncovered inputs. Null or error stays unknown, never a resend; recovery lookups stay silent.

## Product defaults

- Success sound: **one per shared answer** (a steer group sounds once), from an `answered` notice only; a queued follow-up is
  a distinct turn with its own later answer and its own notice.
- Initial hydration and recovery lookups are **silent**; there is no history or recovery audio.
- `unanswered` (abort, failure, reset) and a recall reason are **not** success: no done sound, the reason is shown. Native
  queued withdrawal uses `reason: aborted` (`harness/submissions.js:64–76`), and a user action is distinguished only when
  its receipt proves it. With no native `recalled` status, recall and failure are indistinguishable without a native
  primitive — reported, not invented here.

## Background notification — prerequisite, not a stream per session (73)

Today's path maps the catalogue to running IDs (`durable-api.ts:357–363`), treats busy disappearance as completion
(`SessionSidebar.tsx:800–835`) and plays audio (`AppShell.tsx:137–139`); the catalogue (`server.ts:753–761`) has no
terminal records or answer identity, so busy disappearance cannot tell answered from aborted, and a lookup repairs state
silently rather than signalling success. The guarantee therefore stays the **existing coalesced poll**: this design does
**not** invent a universal catch-up, and a finished-between-poll silence the native channel cannot cover is reported as a
**user decision**, not patched.

Scoping options, all bounded by actual unfinished work and none requiring all-catalogue streams, a new harness, a global
controller, or a durable epoch: keep the existing SSE only for active/interested conversations after navigation, stopping
on settlement (specify the poll-to-subscribe race and ownership transfer so no notification is duplicated or lost); or
project native terminal facts through the existing catalogue/running poll, where a newest-answer summary is bounded and
replaces today's coalesced signal but loses intermediate answer groups between polls, so it is insufficient for universal
one-per-group. `Harness.scanSubmissions`/`submission` can support scoped fact retrieval; an admission-ID cursor alone misses
older queued inputs settling later, and outstanding interests must be revisited — the delta/paging contract is integration
work, not a missing capability.

**Unresolved coverage gate:** choose scoped terminal-fact delivery with acquisition/gap behaviour **before** deleting the old
sound source. Acceptance must demonstrate selected→background completion; foreign or previously-unmounted run; grouped
steers; follow-up; abort/failure; restart; duplicate delivery; no history/recovery audio; and the unread/subagent
suppression policy. No complete coverage is claimed today.

## Replace paths, tests, phases

**Replace, do not layer.** Remove: `becameIdle` → `notifyPromptStage`, `promptRunIdRef`/`notifiedPromptRunIdRef`,
`finishPromptWithoutStream`, `waitForPromptSettlement` and `checkServerIdle` polling, `loadSession`'s independent `loading`
gate, the duplicated `durable_state` hydration, `sdkAgentActiveRef`/`rpcPromptPendingRef` as durable authorities,
`pendingByKey`/`keyAliases`/`lastPublished` fallback, `ChatWindow`'s unqualified `onAgentEnd` sound, and the sidebar's
`completedInBackground` sound. The hook keeps transport, cache, remount and rendering.

**Tests at the seam, no source-regex assertions.** Replace `submission-reconciliation.test.mjs`'s helper-microstate cases
with `createProjection`/`advance` behaviour cases: stage plus idle snapshot emits no notice; a placed entry drops the overlay
and keeps the interest; a late receipt cannot regress; a steer group answers once for all its inputs; a follow-up stays
pending across the earlier answer; write `done`, `unanswered` and abort are not `answered`; HTTP-first and SSE-first
readiness; a held HTTP read cannot hide a complete SSE projection; each ordering counterexample above; a duplicate batch is
silent; a null lookup stays unknown; a failed first read yields `unread`, not `loading`; a contradiction yields `protocol`.
Native projection contract tests cover the wire additions against the real backend; the black-box browser regression at the
real composer, SSE, held endpoint and recorded sound callback (31a11f9) keeps the negative controls.

**Phases** (proposal; no production patch spec yet): (1) protocol — forward `answerId`, `runInputs`, and `projectionId` +
`revision` on complete HTTP/SSE snapshots, make the HTTP lifecycle payload complete, conformance tests against the real
backend; (2) projection — the pure module and its seam tests beside the existing implementation, no caller switched; (3) hook
— switch `useAgentSession`/`ChatWindow` to the view and notices and delete the replaced authorities; (4) background
acceptance — the coverage gate is decided with the user first, old path until then. Owning-guide updates (docs/chat.md, the
verification guide) are **deferred to the implementation ticket**.

## Validation dependencies, ADR proposal, open items

Proposed ADR — **not written to `docs/adr/`, awaiting user review**: *A conversation's lifecycle facts have one pure
projection, and completion is a native terminal fact* — the overlay/answer-interest split, completion only from native
terminal identity, readiness from either transport, and cross-transport ordering by backend `projectionId` plus a client
acquisition fence.

- **73 — incorporated.** `design-validation.md` (`review/chat-lifecycle-design-validation`, base `83cc7c8`) supplied the
  ordering contract, the wire verdicts, the recovery guidance and the coverage gate above.
- **70 — pending.** A concrete design of the poll-to-subscribe race, interest lifetimes and background scope is requested
  from worker 70 and is incorporated when that report arrives, not before.
- **Background proof — pending.** The coverage gate stays unresolved until the acceptance evidence exists.

Open: (1) approve the wire additions (`answerId`, `runInputs`, `projectionId` + `revision`, complete HTTP lifecycle
payload); (2) background coverage — scoped terminal-fact delivery, or the current coalesced path meanwhile?; (3)
recall-versus-failure attribution — accept the runtime's `unanswered` reasons, or a native primitive?; (4) whether the
`requestId`-bearing scope is enough, or the scoped `submissionId` lookup is required for all run inputs.
