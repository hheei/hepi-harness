# Implementation ledger

Status: complete — all 13 tickets accepted; ticket 13 (combined acceptance) merged by the coordinator at `1062840`
Integration branch: integration/durable-subagents
Integration workspace: /home/developer/Documents/dev/hepi-harness/.dev/worktrees/durable-subagents-integration
Baseline: bb92185 (M0 + approved spec/research).

User explicitly approved implementation after reviewing the scope. The routine local deployment of 2026-10-17T10:54Z
(`hepi-backend:1062840-workstation` plus the gateway repacked from `1062840`) shipped this work and was the coordinator's, not
a ticket's; its record is `.dev/deploy/1062840/`. The acceptance gate still claims only what its isolated drivers
measured — no driver runs against the live stack.

## Active frontier

None. Every ticket is `resolved` and integrated; there is no owned seam waiting for a worker. The last entry of this
ledger states the closing evidence; the sections below are the historical record of how each slice was accepted and are
kept as written.

## Coordination

Tickets 01–13 are integrated and accepted; the combined acceptance gate is [ticket 13](issues/13-system-acceptance.md).
No child rebuilds shared graph; coordinator refreshes after integrated code batches. Each worktree owns
dependencies/build output/logs. Model/browser tests use isolated ports and SQLite. Test seams were already approved in
spec, no renewed permission request needed.

## Evidence

Integration bootstrap: pnpm install --offline --frozen-lockfile, exit0, all765 packages reused. Raw log: /home/developer/.pi/agent/sessions/--home-developer-Documents-dev-hepi-harness--/tasks/01a13947-7849-75fa-b740-9d8bbc7193c6/bash-8.log. This verifies dependency setup only, not subagent behavior. Per-ticket product results will be recorded when actually run.

Ticket03 (worker95, branch impl/durable-subagents-03): fast-forward merge `2197a18..a58a8e7` into integration, no source edits. Focused integration re-run at a58a8e7: `node --test test/conversation-relations.test.ts` (cwd apps/server), 6/6 pass, exit0, log `.dev/verify/durable-subagents-03-merge/test-conversation-relations.log`. `git diff --check 2197a18..HEAD` clean (exit0). Worker95 raw evidence preserved at `.dev/verify/durable-subagents-03-worker/`: protocol/server typecheck exit0, server 295/295, relation 6/6, protocol 47/47; `verify:changed` reported only 12 pre-existing docs-link findings (doc baseline). Source scope: apps/server/src/conversation-operations.ts (new), apps/server/src/server.ts, packages/protocol/src/index.ts, apps/server/test/conversation-relations.test.ts (new), docs/architecture.md. Ticket03 status resolved by worker; 01/04/05 remain open.

## Frontier updates

- Started01/03/04/05 in independent worktrees.02 waits for01;06 waits for02/03/04/05. Further dependencies remain in [ticket graph](README.md).
- Integrated03: fast-forward `2197a18..a58a8e7`; frontier tip a58a8e7. Focused relations test 6/6 at a58a8e7; raw evidence preserved under `.dev/verify/`. 01/04/05 still open.

Ticket03 selector report and complete step logs also preserved in `.dev/verify/durable-subagents-03-selector/` (original source f8483d4, base2197a18). Copied worker test-server.log explicitly reports295 tests/pass,0 fail,EXIT=0. This corrects the stale294 count in the ticket evidence table. Integration merge test remains6/6 at a58a8e7.

## Pending integration review

- Ticket04 corrected worker tip98e009b (codeff08535; selector29709bf) integrated atbe927cb. Three read/walk defects corrected at their owner: scoped block continuation, cumulative character offset, non-text entry inventory. Focused integrated test `node --test apps/server/test/conversation-read.test.ts`, sourcebe927cb clean, exit0,12/12; raw `.dev/verify/durable-subagents-04-merge/conversation-read.log`. Worker red/green,307/307 server, server typecheck and selector logs retained in `.dev/verify/durable-subagents-04-worker/`. Diff check found only ticket EOF whitespace, trimmed in coordinator docs commit.04 accepted; total2/13 (03/04).
- Ticket05 code948f183 integrated after source audit, preserving04 read route; frozeninstall exit0, server definitions24/24 and Web adapter5/5 exit0 on clean948f183. Raw `.dev/verify/definitions05-merge/{install,definitions,web-adapter}.log`. Browser local/actualsshd41-check success audited from archived logs; tested478a921 clean, onlyfourMarkdownfiles differ from948f183. Raw `.dev/verify/definitions05-merge/ux05-{build,e2e,run,checks}.log`, retainedsshd artifacts `.dev/verify/definitions05-browser-artifacts/`; selector `.dev/verify/definitions05-selector/` confirms workspace0/web123/script51/entrypoints0, docs1 only12knownlinks.05 accepted, total4/13 (01/03/04/05). Route suite has4 tests, Python SSH runner over realHTTP RPC; ticket corrected to distinguish that seam from actualsshd browser proof. Removed stale route-code cache fromticket; actualserver mount remains authority. No productfinding requiringnewloop.

- Ticket01 corrected tip e3c9abe integrated fast-forward from85c2c84; both P1 corrections audited at scheduler/control owner. Stop decisions precede abort marks; pending Continue checks source and recorded caller before settlement, refusing without overwriting original pending receipt. Integrated clean e3c9abe: `pnpm install --frozen-lockfile` exit0; `node --test apps/server/test/native-input-control.test.ts apps/server/test/native-input-control-migration.test.ts apps/server/test/native-input-control-crash.test.ts` exit0,20/20 including3 actual SIGKILL. Raw `.dev/verify/native01-merge/{install,control}.log`; worker selector source32a26e7 report copied to `.dev/verify/native01-selector/` (327 server tests; only12 recorded pre-existing docs links fail). `git diff --check 85c2c84 HEAD` exit0.01 accepted; total3/13 (01/03/04).02 assigned same worker94, preserving native context. Recorded native queued-request Continue advisory remains outside02 fresh-input path.

Graph refresh: `~/.local/bin/graphify update .` at43d802c, exit0; integration now has its own AST graph (9943nodes/20629edges) under `graphify-out/graph.json`. Log: primary session taskbash-9.log. It includes03 and predates04 merge; confirm new read symbols in source until next integrated batch refresh. Use integration graph for future children, primary graph remains untouched.

Graph refresh after integrated01/04 batch: `~/.local/bin/graphify update .`, sourcee3c9abe, exit0,10050nodes/19246edges; log `.dev/verify/native01-merge/graph-update.log`. Only integration graph updated.

Graph refresh05: source948f183, `~/.local/bin/graphify update .` exit0,10179nodes/19529edges; raw `.dev/verify/definitions05-merge/graph-update.log`.02worker should merge05 beforefinal to preserve mounted definitionsroute.

06 prep done: optionalserver-local extension with publichostport; install after existing operations creation but before currentstartPaused attach/resume boundary; preserve readonly failures through existing namedinstaller seam. See runtime-implementation-notes.md.02 is sole remaining06blocker.

Ticket02 worker correction (branchimpl/durable-subagents-02, same01worktree), after the coordinator's recovery-identity audit: the derived `<requestId>:input` admission identity is removed. One dispatch is now one request id end to end — a resume's input is admitted under the resume's own id, a message keeps the caller's own id on every path, and a dispatch whose id already names a submission is answered with that submission (and its resume receipt when one was recorded). A `continue` whose id already names a submission asks for the held queue instead of handing the known id to the admission (which would answer early, run no boundary, clear the hold and strand the queue); a send whose resume returns `allowed` after a concurrent explicit continue admits its message then. Focused `node --test apps/server/test/conversation-stop-continue.test.ts` exit0,18/18 (3 of the new tests red against the pre-correction source); server369/369, protocol47/47, web-unit123/123, server typecheck0. Awaiting coordinator audit and integration; not accepted by the worker.
##02 integration audit (returned7b2a9fe, not merged)

Worker94 returned trusted core/HTTP controls with14 focusedtests and365server checks, selector46743e8 clean. Coordinator found a material ordinary-message recovery identity gap: held send admits `<requestId>:input` but existing GETsubmissions and Web pending/SSE correlation use original requestId. Lost HTTP answer can therefore report no admission, despite the real message. Reopened02 at input/recovery owner; worker94 must prove heldsend→ignoreanswer→lookup original resolves same native submission and laterstop/retry never re-admits old original content. Keep internal control identity distinct if needed; avoid suffix-guessing aliases without native correlation. Native01 queued-input dedup advisory matters only if real correctedpathusesit. No newbroad review requested.02 remains sole06blocker, acceptedcount4/13 unchanged.09 owns browser Continue/stopping input preservation, but existing ordinary-message recovery contract must hold now.

##02 accepted;06 claimed

02 repair classified as integration/logic error at existing admission identity, no native patch change. Fast-forwardcf43e5e→ec0f99f. Public original requestId now names native submission in ordinary/held/queue paths; continue with already-admitted input id drains queue without duplicate admission. Lostanswer GETsubmissions(original), SSEprojection original, oldordinaryretryafterstop and continue/send race covered in4 newHTTPcases,3 demonstratedred atoldsource. ConcurrentContinue race not reproduced in40probeattempts, recorded; allowed fallback obeys admission invariant.

Workerselector7eeb6dc clean is product-identical toec0f99f (only02ticket Markdown differs). Copied report/logs `.dev/verify/control02-final-selector/`: changed-typecheck0, changed-test0 (server369, protocol47 and dependents), webunit0/123; docs1 same12preexistinglinks. Earlier sameSHA gatewaySSHfixture failure passed isolated and rerun; retain as recorded fixture sensitivity, no unrelatedrepair. Integrated `node --test apps/server/test/conversation-stop-continue.test.ts` at cleanec0f99f, exit0/18of18; raw copied `.dev/verify/control02-merge/focused.log`. Sourceaudited correction then no expandedreviewloop.02 accepted, total5/13(01/02/03/04/05).

Graph updateec0f99f exit0,10219nodes19602edges473communities. Raw `.dev/verify/control02-merge/graph-update.log`.06 assigned worker95, reuse clean03workspace under newimpl/durable-subagents-06 branch from integration. Nodes06+ then07/10/11 parallel frontier; no further tickets implemented ahead of blockers.09 must preserve input on stopping202/noid and retry originalrequestId; suffixinput contract eliminated.

## Parallel preparation and definitions follow-up

Worker97 read-only11prep archived in its ticket atb912955; oldknown-entry deferredblocks alreadyreadprecompact/inherited content, rawreadaddsdiscovery. Worker96 read-only10prep archived in10ticket; nativecompaction replay/taskidentityrequiresactualpublicAPIproof.10/11 remainblocked06, notimplemented. Newmaterial05validationgap confirmed: acceptedgrep/find/ls absent fromactualCodingTools. Worker96 now owns targetedfour-toolvocabulary/UIcapability repair onnewfix/durable-agent-definition-tools usingclean05workspace; worker95 notified and retains06actualspawn capability validation. Acceptedmilestones5/13 unchanged. The vocabulary follow-up is now integrated and verified; evidence below. No production changes.

## Definitions follow-up accepted; 06 integration review

Cherry-picked07adddb as a372da6. At clean a372da6, `node --test apps/server/test/agent-definitions.test.ts apps/server/test/agent-definitions-http.test.ts apps/server/test/agent-definitions-route.test.ts` exited0,27/27; `node --test apps/web/lib/agent-definitions.test.mjs apps/web/adapters/agent-definitions.test.mjs` exited0,8/8. Raw logs and command/revision metadata: `.dev/verify/definitions-tools-merge/`. Worker logs archived unchanged from `/tmp/fix05/` to `.dev/verify/definitions-tools-worker/`, including the51-check production browser local/loopback-sshd journey. Definitions vocabulary now follows installed CodingTools; spawn separately validates actual selected tools.

06 returned ce40b29, not yet merged or accepted. Standards/spec reviewers101/102 run read-only against fixed base3717a7a. Coordinator found material active-work accounting defect: counting permanent anchors consumes the four-child concurrency budget after completed work. Classify as responsibility-boundary error (persistent identity versus current work); worker95 repairs using native pending/active facts. Global opt-in also drops hepi-subagents because defaultSelectable is passed as the known installed set; repair selection resolution at that existing owner. Listing exhausted cursors currently restart at row0; correct local pagination logic. Worker95 owns corrections and focused public-seam regressions; no new abstraction or production changes. Accepted count stays5/13 until06 correction evidence is reviewed.

Reviewers101/102 completed standards/spec review at clean ce40b29. Both confirm safe replay rechecks mutable host/definition/capacity before durable creation deduplication: a committed child can be reported as refused on replay. Resolve existing dispatch before new-admission checks. Reviewer102 also reproduced global opt-in failure through actual HTTP. Its three isolated probes exited0; raw logs archived under `.dev/verify/subagents06-review/` (replay/global-selection/concurrency). Standards found no hard style breach.

Concurrency disposition: record/advisory. Reviewer101 direct extension/controlled-host parallel calls created5 against limit4; reviewer102 five simultaneous actual model calls over SQLite/gateway admitted4. Follow-up101 confirms native default toolExecution is parallel (defineTool leaves registration unchanged; settings choose parallel; scheduler starts eligible invocations concurrently), so no serial gate explains the real-path result. Normal-use over-admission remains unestablished; no mutex is required from this review. Keep the non-atomic count/create boundary recorded and revisit only on actual model-path over-cap reproduction or explicit user prioritization. SIGKILL evidence currently polls catalogue and cannot substantiate the claimed precise pre-receipt window;95 is tightening the verification at public commit boundaries. Graph refresh after tool-vocabulary integration at586fa7d exited0, raw `.dev/verify/definitions-tools-merge/graph-update.log`.

## User-priority fixes and 06 follow-up review

User-reported FAUX fallback and old pending message/Preparing residue are fixed in integration3022000 (FAUX3022000, lifecyclec6e52c0, status assertions4b20022). Clean full selector at3022000: workspace-typecheck0, workspace-tests0 (server372/372, gateway185/185), Web129/129, script51/51, entrypoints0; overall exit1 only12 historical docs links, compared line-for-line against retained clean detacheda12d20d baseline. Raw report `.dev/verify/2026-10-16T14-58-34-702-verify-changed/verify.json`; parent-review and exact docs comparison live beside it. No production deployment/restart. Graph update3022000 exit0,10240nodes19722edges446communities; graph remains pre-06 until that ticket merges.

06 worker rebased onto3022000, product source090203f, later ticket-only notes through1ea155d. Retained clean selector `.dev/worktrees/durable-subagents-03/.dev/verify/2026-10-16T15-01-56-870-verify-changed/verify.json`: typecheck0, server384/384, Web129/129, docs1. Source checks are reused across ticket-only commits; repeated stdout-only runs are not additional retained evidence.

### Standards

Reviewer101 found no material Standards findings. Native active-work capacity, replay-first dispatch lookup, global opt-in and exhausted-cursor corrections are resolved. Parallel capacity check/create race remains the recorded advisory; observing only synthetic over-capacity does not establish real-model impossibility.

### Spec

Reviewer102 confirms those runtime corrections; one P2 verification gap remains against06 creation/admission/tool-return SIGKILL criterion and specA19. Its actual paused inspection atf537467 found successful agent_spawn result and parent done already persisted in BOTH old crash modes. Holding the child final model response proves before-child-answer only. It does not pin pre-admission or interrupted native spawn execute/receipt. Raw proof archived under `.dev/verify/subagents06-followup-review/`.

Worker95 owns a test-boundary repair through existing public native composition seams, plus precise checkpoint/receipt facts and truthful ticket wording. Runtime logic is not demonstrated faulty by this finding.06 staysclaimed, accepted count5/13;07/10/11 wait. After corrected crash evidence and focused verification are reviewed, integrate06 and release frontier.07 preparationa829ac3 remains on notes branch awaiting that point.

## 06 accepted; parallel frontier07/10/11

Merged c3e2d9d into integration at11fe1e8, no product conflicts. Standards101 confirms no material finding; Spec102 narrow follow-up closed the sole A19 evidence gap. Revised fixture kills synchronously in real child-creation commit publication before anchor admission, or inside native agent_spawn wrapper after admission and before tool return. Paused reopen independently verifies no result and a live interrupted native call, then recovery produces the original child/admission and exactly one result naming its prior creation. Public native/SQLite/model/gateway composition; no production hook or runtime patch.

Retained clean938d682 selector copied unchanged to `.dev/verify/subagents06-final-selector/`: typecheck0, server384/384 including both pinned SIGKILL cases, Web129/129, docs1 same12knownlinks. c3e2d9d differs only in ticket notes; integrated product tree matches that verified source. Diff check found one ticket trailing blank line, fixed in acceptance notes. Tests reused per verification policy; no redundant full rerun. Prior failed-proof artifact and command preserved separately at `.dev/verify/subagents06-followup-review/`.

06resolved, accepted6/13.07/10/11 may now implement in independent worktrees.07 owns automatic-report admission/reporter,10 configured context preparation,11 core atomic fork primitive and user history/fork/reference surfaces. Shared conversation-operations changes coordinate by responsibility:07 deliver path,11 spawn-source;10 consumes the resolved fork source and owns definition/preparation logic. Anchor changes coordinate07 reporter-after-admission versus10 preparation-before-admission. Coordinator integrates each slice and checks combined behavior; workers do not rebuild graph or modify integration directly. No production deployment/restart.

## Shared fork foundation integrated; 11 remains claimed

Fast-forwardb74f379→fa6d766:7504f53 adds optional host-resolved `ConversationSpawnRequest.source` (`ConversationSpawnSource {conversationId,entryId}`) and native SQLite tests;fa6d766 corrects hidden-parent fixture, adds guide paragraph and retained raw evidence. Same created-task ownership/idempotent transaction now calls native fork; no policy interpretation or second registry. Exact-id membership follows native fork ancestry, confirmed in SQLite source. All reads precede writes.

Evidence `.scratch/durable-subagents/evidence/fork-source-7504f53.log`: source7504f53 with modified test/guide recorded explicitly, later committed unchanged infa6d766; server `npx tsc --noEmit` exit0, focused4/4 exit0, full388/388 exit0. Corrected fixture proves real task-owned child retains its hidden display-parent edge, inherited entries remain readable/forkable, and new branch has distinct ownership and allowed initial control. Parent diffcheckb74f379..fa6d766 exit0. Parent previously misread file-scoped gitshow as complete commit and incorrectly called the initial tests uncommitted; fullstat confirms7504f53 included193 lines of tests. No missing-test finding remains.

10/07 instructed to mergefa6d766 without losing their WIP;11 continues remaining routes/browser work. User-fork idle anchor input extension is coordinated across07/10/11; existing v1 dispatch/admit/idle records stay compatible.11 will verify whether an idle fork anchor on a finished source child affects its original parent active-work count before fixing the server owner. Acceptedcount remains6/13; this foundation is not complete11 delivery.

## Idle anchor input integrated; 11 remains claimed

Merged scoped `1e10e8c` into integration at `8054b95`. Only `subagents/anchor.ts` changed: legacy dispatch input remains valid; explicit idle input creates a permanent user-fork owner with no DispatchDoc or admission. Same task kind/version1; dispatch narrowing guard and `createForkAnchor(tx, conversationId)` helper reuse native background ownership. This releases a seam, not full11.

`pnpm verify:changed --base=5b2469d` at clean `8054b9571b3af3f705aacec8076ef3dd0ea64d20`: changed-typecheck exit0, changed-test exit0 (388/388 server tests, including06 commit/receipt SIGKILL cases). Raw logs, command, SHA and dirty=false retained in `.dev/verify/2026-10-16T17-40-01-992-verify-changed/verify.json`. Diffcheck exit0. No additional suite rerun needed against unchanged source.

Exact scoped SHA sent to94/96;96 extends dispatch input with optional preparation=compact, adds prepare phase before admit, and preserves idle user forks. All old v1 inputs/checkpoints remain compatible.07 owns reporting after actual admission;96 must communicate actual failure handling if preparation ends before a child submission exists. User hold must remain authoritative through preparation.11 still owns real fork/active-work regression, routes and browser evidence.

95 completed read-only09 preparation, stored in [pending-controls-preparation.md](pending-controls-preparation.md), with no implementation claim before07.101 now prepares08 read-only against8054b95, without tracked edits or execution claims.07/10/11 remain the implementation frontier; accepted count remains6/13. No deployment/restart.

## Closed: 13 accepted, combined acceptance green

Tickets 07–12 were integrated and accepted in sequence (07 `565c634`, 10 `72d5ce9`, 11 `649bce4`, 08 `cbb54aa`,
09 `9672a36`, 12 `fb04eb7`); each ticket's own record holds its evidence, and the frontier notes above stop being
current at that point. Ticket 13 is the closing gate: five drivers (8 tests) plus one production browser journey
(53 checks); the A01–A22 mapping and the review disposition are in
[13 — combined acceptance](issues/13-system-acceptance.md). The coordinator merged that branch into the integration
branch at `1062840`, whose own suite is green (server 448, gateway 277, Web 144; typed checks, docs and entrypoints
pass), and the routine local deployment of 2026-10-17T10:54Z shipped it. That deployment is a deployment check, not
recovery evidence: no acceptance driver ran against the live stack.

