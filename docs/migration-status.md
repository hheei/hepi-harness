# Migration and cleanup status

## Deployment tooling

Routine deployments follow the [short path](deployment-runbook.md#routine-deployment-default), using existing host
build/transfer and service wrappers. Repository tooling currently supplies `deploy:inspect` and `deploy:plan`
(the full-runbook reference); a universal build/apply command is not implemented. Routine operations do not
require a new spec, full verification cycle or tracked deployment report.

## Development tooling

`pnpm dev` owns local hot reload; `pnpm verify:changed` selects checks from Git paths and transitive workspace
dependencies, reusing the evidence runner. Selection is at package granularity; cross-service contracts and browser
flows still need task-specific checks. Known Web unit failures remain visible. See [verification](verification.md).

Repository Pi configuration adds the graphify MCP and local worker/reviewer policies preserving current global
role settings plus graphify, and a scout policy that enables the same graph discovery tools. MCP merges global and project servers; role definitions are snapshots, not dynamic
inheritance. The pinned project skill checkout lives only under `.pi/skills`; shared graphify/ponytail-review store paths require local setup. See [graph navigation](agents/graph-navigation.md).

Graph-first discovery and delegation follow [graph navigation](agents/graph-navigation.md), aligned with OVITO's
narrow-query and coordinator-update pattern. Each new discovery question uses a scoped graph query, including within
subagent tasks. The default graph is an AST index; the separate deep graph adds semantic relationships over docs.
Dynamic dispatch, inferred relationships and cross-service contracts still require source/guide confirmation. The linked graphify skill remains
unavailable to the harness loader outside its resource root; use repository instructions/CLI or parent-supplied results.

## Retired Next browser drivers (2026-10-21)

The E2E directory regrouping deletes 33 `.mjs` drivers that directly require the removed Next binary or
`.next/BUILD_ID`, their dead package scripts, and the deferred-text driver's exclusive fixture. The surviving
drivers live in the theme directories listed in the [developer guide](developer-guide.md#directory-map). Historical
results keep their original revision and paths in [verification](verification.md).

Retirement repairs the executable test surface; it does not establish browser parity. Existing owner tests and
current drivers protect narrower seams:

| Retired journeys | Current verification seam | Remaining browser gap |
| --- | --- | --- |
| Submission stalls, pending controls, missing-model recovery, image submission | Backend submission, pending-item, missing-model and image suites; client acceptance covers its own submit/reload journey | The complete retired recovery and image-submission browser scenes have not been ported |
| Session rename/delete/search/auto-name/fork, navigation and shared sidebar state | Backend session/catalogue/sidebar suites; current sidebar-ingress fixture | No replacement claim for each retired end-to-end catalogue action |
| Default workspace, project creation/removal, routing and worktree picker | Existing workspace/project API and UI rule tests; SSH-project and workbench-scope drivers | Current drivers do not replace every local project/picker journey |
| Agent definitions, extension selection, model-config save and the old MCP surface | Backend settings suites; current MCP and extensions-panel drivers | Agent-definition and model-save end-to-end journeys remain unported |
| Foreground/background lifecycle, heartbeat, truthfulness and terminal budget | Lifecycle/completion projections, Backend heartbeat and Gateway stream-budget tests; current terminal drivers | The retired audio/watch-budget and exact terminal-budget browser scenarios remain uncovered at that seam |
| History prefix, child raw-history fork, windowed transcript and deferred text | Backend history/read suites; current history-navigation, visible-turns and raw-history fixtures | No claim that the full retired scaling, deferred-content or child-fork scenarios were re-run |
| Subagent delegation and the old system acceptance | Backend delegation suites; current child-recovery, subtree-control and client/provider/native acceptance drivers | Each current driver verifies only its named scope; there is no blanket replacement for the retired system journey |

Reopen an individual gap when its browser contract changes or a user prioritizes it; port that journey to the
current ingress/Backend stack rather than restoring a Next launcher.

## TypeScript test migration (2026-10-21)

Active unit suites use `.test.ts`; Web browser drivers, test-only helpers, MCP process fixtures and Backend
performance probes also use `.ts`. Test discovery, package scripts and CI point at these files. Tests participate in
strict typechecking; the root `pnpm typecheck` covers workspace tests and tooling tests. Module tests stay beside
their implementation, package-contract/integration suites stay under their owner's `test/`, and browser journeys
stay under the themed E2E directories. See the [test convention](developer-guide.md#test-layout-and-typescript).

Earlier revision-bound records below and in [verification](verification.md) retain the filenames their commands
actually used. Changing the test language adds no replacement browser journey for the retired-driver gaps above.

## Verified replacements

Image submission and history display now have **21/21 passing browser checks**, including fresh-browser and backend
restart restoration. The prior three C1 failures were stale test observation: they searched only inline data URLs,
while the visible committed images were served through authenticated deferred-image URLs. The driver now checks
successful decoding and exact original bytes; no product image capability changed. See
[the correction and evidence](verification.md#image-display-across-recovery--observation-corrected-2026-10-15).

- Single authoritative durable backend: create/open/admission/dedup/settings/steer/follow-up/abort, SQLite restart and snapshot SSE. Conversation restoration handles catalogue scan pagination (102 conversations manually verified).
- Copied React pi-web presentation: two independently hosted localhost production instances observe/control the same conversation; close/reload recovery and live bash output before command completion manually verified. The session list and the running poll are one catalogue read (`GET /api/conversations` answering workspace, busy state, revision, entry count and first user message) instead of a per-conversation state fan-out; a queued input is withdrawn by `POST /api/conversations/:id/recall-queue`.
- Local gateway upstream read/write/edit/bash; SSH Python3 filesystem read/write/edit path and real localhost SSH RPC verified. No remote Pi or daemon installed.
- Backend crash during a dispatched unsafe bash: SIGKILL restart produces interrupted tool result, no side-effect replay. Upstream default unsafe tool recovery is retained.
- Copied React workbench now uses authenticated server proxy for local files/preview/status/diff/search. Preview limits are explicit; incomplete downloads refused, transport failures not disguised as empty success.
- **File surface (client-app ticket 08).** The browser's file routes are one implementation —
  `packages/gateway/src/files-surface.ts`, with its rules (routing parse, MIME/preview table, `@` index scorer, upload
  conflict strategies, name validation) in `packages/protocol/src/files.ts` — served by the **client ingress** for a
  Web page's cookie or an App's device bearer, and served on the ingress over the same Backend calls. Since
  2026-10-18 the workstation's Web origin **is** the client ingress ([the 1873d24 record](records/1873d24-deployment.md));
  client-app ticket 17 then deleted the Next presentation layer and its remaining `apps/web` adapters. The multipart body
  is read by `packages/gateway/src/multipart.ts` over the public `busboy` 1.6.0; the old `next/dist/compiled/busboy`
  import, the Next file/git/upload helpers and the duplicate routing parser are gone. Bounds: one file's
  16 MiB is the host's policy, the batch bound (`MAX_UPLOAD_BATCH_BYTES`, or `HEPI_UPLOAD_BATCH_BYTES` on the ingress)
  is enforced while the body is read, a range is the host's own answer, and a caller that goes away mid-download
  releases the host reader. **Browsing serves both kinds of gateway**: an SSH-backed workspace lists, previews and
  reports changes and diff through the `SshFilesystem` session and the `SshRunner` the other remote surfaces already
  use, so a gateway composed *without* a workbench is the only shape that answers `501 not_supported` for listing,
  preview, meta, changes, diff and the index — and it answers that rather than answering from this machine. Web acceptance
  (ticket 03) kept that claim true: the browser's file surface answers each refusal cause as the cause it has
  (`unknown_workspace` 404, `path_denied` 403, `not_found` 404 since ticket 09, `gateway_offline` 503,
  `not_supported` 501, anything else 500 `operation_failed`) instead of calling every one of them a missing capability;
  `not_supported` joins the workbench's
  refusal codes and is what a gateway without the surface says on `POST /v1/workbench`; and a payload refusal states the
  failure about the path the caller named rather than the host's own filesystem path. Both hosts were asked the whole
  journey at the ingress seam with the workbench mounted, and answer alike. Protocol and
  error parity (ticket 02) made the two hosts' answers equal where they were not: an operation the host never answered
  (transport loss, its own deadline, a caller that disconnects) is `operation_failed` on either host rather than an empty
  listing, change set or diff; a caller that goes away on `POST /v1/workbench` ends the host command it started, which is
  bound at 15 s and so answers inside the control route's 20 s window instead of losing the call; an in-workspace symlink
  previews its target on both hosts; and the file payload routes answer one set of statuses and codes for either
  workspace, including the conflict strategies and a mid-upload disconnect leaving no staging file. One preview
  difference is kept by decision: a text file past the gateway's 16 MiB read policy previews (truncated at 200 KiB)
  locally and is refused on an SSH host, because the remote preview rides the shared filesystem reader. File watch and
  linked-directory approval remain `501` by decision. A `.docx` is previewed in the browser since ticket 05, as bounded
  text over the byte route the file surface already served, on the packaged App as well as the Web page: `packages/ui`
  declares the reader it imports, and both hosts' builds resolve mammoth's browser entry
  (`apps/app/test/docx-preview-bundle.test.mjs`). The
  App's save is its own shell's (client-app ticket 20: the platform dialog plus bounded slices, see
  [native save](workbench.md#native-save-the-apps-own-write-path)), and ticket 04's desktop measurements (cross-origin
  `tauri://localhost` origin, no `ReadableStream` request body, ≤1 MiB IPC slicing before a native save) are what that
  path enforces; Android remains unsupported. Two limits ticket 03 records rather than closes, both since closed: a
  file the tree no longer has used to answer `500 operation_failed` on both hosts because the workbench had no `not_found`
  code, and the truncated text preview used to draw its own delivered size as the file's end beside a "Load more" the host
  cannot serve. Ticket 09 named the missing file (`not_found` in the refusal vocabulary, 404 on the browser surface, told
  from this machine's `ENOENT` and an SSH helper's `not_found`, with no host path in the answer), gave the preview the
  host's own `shownBytes` and `size` (nullable, no offset continuation, no fake completion) and made the viewer state the
  cause with the action that fits it — Retry for a host that did not answer, folder reload for a file that is gone, Close
  for the tab — and the changed-files panel
  now states what failed and offers Retry. The SSH workbench spec's "existing browser DOCX rendering" premise was not
  true — `mammoth` was declared by `packages/ui` and `apps/web` and imported by nothing — so ticket 05 implemented the
  preview rather than claiming it: text-only extraction, 10 MiB bound, browser-side, over the existing byte route. See
  [the Word document preview](workbench.md#the-word-document-preview) and
  [Workbench](workbench.md#the-file-surface-is-one-implementation).
- Executed split deployment: Oracle ARM64 durable backend, local gateway and production React UI through loopback SSH forwards. Five real DeepSeek tool results, 3/3 fixture tests, local proof file, UI login/reload and backend restart persistence passed; see docs/deployment.md.
- Browser file payload capability deployed and smoke-tested at `0628888e5a85`: the gateway's `POST /v1/files/upload`, `POST /v1/files/upload-check` and `GET /v1/files/bytes` routes, the backend's relay at the same three paths, and the Web explorer and viewer above them. Read-only checks covered auth, ranges, traversal, unknown workspaces and both workspaces the deployment serves; the mutating half was exercised only against a disposable fixture gateway, never a user directory. See [the 0628888e5a85 record](records/0628888e5a85-deployment.md).
- Dependency-complete critical upstream baselines rerun; see docs/upstream-sources.md for passes and environment failures.

## Idle-stream keepalive and the page's connection budget (delivered; perf tickets 01 and 02)

A stream that is quiet is no longer mistaken for a dead one. The gateway's own conversation and terminal event
streams write a **comment frame** — an event-stream line with no field name — on the cadence stated per deployment
(`HEPI_HEARTBEAT_MS` for the conversation stream, `HEPI_TERMINAL_HEARTBEAT_MS` for the terminal stream; both default
to 30 s and `0` states no keepalive), armed with the attachment and cleared with it. It carries no `id:` line,
because a cursor on a comment frame would move a caller's reconnect position to an offset no output exists at, and both
Web proxies pass it through byte-for-byte and never write one of their own. A deployment behind a hop with a stricter
idle bound states its own cadence rather than discovering the bound by watching sessions reconnect.

Every mounted terminal tab shares **one** page-level stream instead of holding one source each: the relay merges the
hosts' streams and the tabs attach to it, each widget naming the cursor **it** read (a widget that has read nothing is
answered with the retained tail rather than resuming mid-stream), the first host stream to finish ends the page's
stream and releases the others so the page reopens and re-attaches every tab, and a trailing partial frame is
discarded rather than repeated from a cursor that never moved. The conversation side keeps a derived budget: at most
the derived number of background watches hold a source, the selected conversation's source is never given up, and a
nomination over budget keeps its projection and acquires when a slot frees.

Measured: with two mounted terminal tabs and four held runs the page held **6** open sources and its ordinary in-page
read did not settle within 3000 ms; it now holds **4** (one terminal + three conversation) and the read settles in
3 ms. See [Chat](chat.md#the-pages-connection-budget) and the
[integrated verification](perf-follow-up-verification.md).

Recorded limits: the keepalive is a **stated cadence**, not a probe of the fronting hop's real deadline, so a hop
stricter than the stated value still ends a quiet stream; the fan-in's tabs must be sessions the gateway actually
runs, and a request naming a session it does not run is answered as an unknown tab rather than held open.

## Bounded history and the read blocks, incremental state frames, and loaded history (delivered; perf tickets 03, 04 and 05)

The transcript is bounded on every surface that returns it: the state read, the stream's first frame and the client's
own view carry the newest **50 visible messages** normally capped at **300 raw entries**, with a real `hasMore` and the window's
own `oldestEntryId` (the first entry it carries, or `null` when it carries the whole active range), and no unbounded
mode exists on the state route. Older history is served by entry id through
GET /api/conversations/:id/entries?before=<id>&tail=<n>, which slices the **native active range** in the runtime's own
active order — so a compaction's summary, whose id is newer than the entries it keeps, is reachable exactly once and
an entry a compaction or a reset dropped is never paged back. A `historyRevision` token derived from two committed,
immutable facts (newest head marker, newest visible entry) travels with every window and survives a backend restart,
which is what lets a client keep the history it paged in. History entries carry heavy content as a **read block**: a
image inside the wire policy (now one policy in `packages/protocol` instead of two Web copies) becomes a URL served by
GET /api/conversations/:id/entries/:entryId/tool-result-image — and that policy belongs to the message that carries the
image, whatever its role, so a user's own accepted prompt image and a mixed prompt's image go behind the same block
rather than being refused as an oversize read. A thinking block becomes a preview with its provider signature
dropped, restorable from .../thinking. Historical text above 64 KiB of UTF-8 content becomes a 2,000-character
preview with `deferred` and `textUrl`, restored through .../text?blockIndex=N. User prompts, assistant text and textual
tool results share the rule; ordinary answers and the framework's ~50 KiB tool output stay inline. GET
/api/conversations/:id/entries/:entryId reads one entry, projected and
redacted as the stream projects it, resolved through the conversation's **fork-aware** history so another
conversation's id is 404 while an ancestor entry a fork inherited is served.

Recorded limits: large structured tool arguments and live partials still ship whole. A frame that cannot be carried
answers a named `frame_too_large` reason with entry id and size instead of destroying the connection into an endless
resync. The window retains its last projectable message; a bookkeeping-only count-bounded suffix is extended to the
nearest projectable anchor, which can exceed the usual raw cap. Paging therefore exposes a usable cursor or a named
refusal rather than an empty page that advertises more history without a cursor. **Every** surface that returns a
window asks that same question, pages included, so a page that cannot be carried is the same named refusal rather than
a multi-megabyte body. `historyRevision` and the window are kept **incrementally** per attachment — an append-only
advance projects only what it appended and advances the token's two facts from those entries, and only a head marker, a
truncation, a replacement or an overflow recomputes them — so a publication costs what the turn produced rather than
what the transcript holds. The per-attachment state is bounded by the window itself. **After the baseline a state frame carries only what the advance produced** —
`baseRevision` plus the appended entries and the window bookkeeping, with every scalar full — so the per-turn cost is
proportional to the turn rather than to the transcript; the rule that decides whether a frame continues the window the
clients hold is one function beside the window rule (`continuationIndex`), a head-marker move restates the window
instead of continuing it, and the server keeps no per-client cursor, buffer, ack or epoch. The measured reduction is
apps/server/scripts/perf-history-scaling.mjs: bytes per turn (~721 to ~726), the largest frame (~1.04 KB) and the first
load are flat from 10 to 240 turns, against lane B's recorded 5,524 to 152,175 bytes/turn and 4.7 MB first loads. See
[Chat](chat.md).

Ticket 04 was approved at `96c10b75efb08ba4d79a8cbfa849dc19e639a0fe` (reviewer100, Standards 0 / Spec 0) and its
clean fast validation was taken on 2026-10-14 UTC with a clean tree
(`.dev/verify/2026-10-14T03-10-54-910-verify-fast`, `dirty: false`, `ok: true`); the reviewer's own wire and live repros
report 50/50 held entries against a fresh read with `gaps: []`. At that historical revision large text still lacked
a read block; the design-fix follow-up completes text recovery. See [current Chat behavior](chat.md).

The history a reader **loaded** survives the window moving. An entry the client already had on screen — sitting
directly below the window and contiguous with the pages it paged — is migrated into the loaded prefix when the window's
start advances, instead of being dropped, so scrolling back and then receiving a turn does not lose the message being
read. The decision is one pure function of the ids and the two history facts — `decidePrefix`, owned by the shared
session pure root `packages/session` and called by both the browser (`packages/ui/src/hooks/useAgentSession.ts`) and the SDK
reducer (`reduceSseFrame`) — keyed on **nothing** about an attachment, so a reconnect — a new
lifecycle clock for the same history — decides the same way and keeps the prefix, and a read and a stream advance cannot
disagree. A `null` boundary is a complete range and **replaces** the prefix rather than merging with it; a boundary the
client does not hold is a resync, never a guess; and a client that never paged holds no prefix, so a fresh transcript is
exactly the window. The prefix and the head marker it was loaded under live in the runtime page-memory cache
(`packages/ui/src/lib/session-view-cache.ts`) and in the state a caller holds — **never on disk**, so there is no persisted
shape here and no compatibility code was added or needed. The consolidation revision moved that one rule and the
window fold's own state type into the shared pure root: `decidePrefix` is now declared and implemented only in
`packages/session/src/index.ts` (the retired Web copy `apps/web/lib/history-prefix.ts` is deleted, and `SessionState` carries the
native entry payload, the frame metadata and the head marker a prefix was loaded under). Recorded limit, now that the
outline contract exists: the Backend answers the full-history anchor page and the bounded target window a coordinate
from it addresses ([Chat](chat.md#the-full-history-navigation-outline)), so what the rail shows for the unloaded range
and what a jump lands on are decided. The minimap reads both since ticket 04: it lists the conversation's committed
anchors as rail nodes (loaded ones measured, unloaded ones by identity, order and a bounded preview) and a click on an
unloaded node goes through the one jump coordinator. Ticket 05's system acceptance matrix is what remains of
[history navigation](../.scratch/history-navigation-research/spec.md), not an open design question.

The **raw** history is a separate, bounded read of the same conversation (`GET /api/conversations/:id/read`, durable
subagents ticket 04): the entry table's own fork-aware record rather than the active window, so a compaction's dropped
prefix and a fork's inherited prefix stay readable there. It serves 2 000 lines or 50 KiB per page, its continuation
cursor names the entry, the block, the line inside that block, the character offset inside that line and the snapshot it
belongs to, and the first page pins the snapshot's end so an entry appended while a caller pages cannot move a line the
caller already read. A single line larger than the whole byte budget is cut on a UTF-8 boundary with a cursor that
continues inside the same line, and no shell hint is emitted. Recorded limits: a first read with a large `offset`
locates its start by counting lines from the oldest entry — no line index is built or persisted — and one entry is
decoded whole before it is split, so the byte budget bounds the **output** and not the memory one entry costs. See
[Chat](chat.md).

## Durable subagents (delivered; tickets 01–13, acceptance closed)

The optional `hepi-subagents` extension is connected end to end: one delegation seam behind `agent_spawn`,
`agent_send`, `agent_stop`, `agent_get`, `agent_read` and `POST /api/conversations/:id/delegate`; a durable child with
its own conversation, native owner, workspace binding and full configuration snapshot; an automatic reporter that
delivers the child's own answer once; the native stop/continue control with a per-item pending queue; definition-driven
`fresh`/`fork`/`compact` preparation; raw history, structured references and a child fork in the Web UI; and the Web
quick create, child tree and per-conversation run status. Current behaviour is in
[architecture](architecture.md#durable-child-execution-optional-subagents-extension) and [chat](chat.md#quick-delegation-and-the-child-tree).

Acceptance closed 2026-10-17 at `b6b6745` on an isolated production stack built from this branch: five drivers
(8 tests) covering the multi-kill chain, the three mid-drain control windows, unsafe-tool recovery with a missing
definition, a retained binding in a multi-session family, and the shared answer of merged inputs; and one production
browser journey (53 checks) running the whole feature as a single session. Commands, exit codes and raw logs are in
[verification](verification.md#durable-subagents-the-combined-acceptance-gate-2026-10-17).

Subtree control is delivered beside that work, backend first and Web surface second. `POST
/api/conversations/:id/subtree-control` stops or interrupts the **captured** descendant subtree with one durable outcome
per child plus that child's current session row (the same `runStatus` projection the session list and the running poll
use), and a parent's own stop stays local. Ticket 03 put that route behind a user decision: the Agents panel of the
workbench carries selective `Stop subtree` / `Interrupt subtree` with confirmation, two-column Requested/Now outcomes and
read-back recovery of a lost answer, shipped in both clients through `AppShell` (see
[where the surface lives](notes/subtree-control-web-ux.md)). Ticket 04 closed the system acceptance across nested scope
(a four-level tree beneath a hidden middle conversation, beside a second subtree), races (concurrent duplicate requests,
a child created during a capture, a live completion and a user's own continue), restart replay (a real `SIGKILL`
between the first child's outcome and the rest, resumed under the same request id, each child controlled exactly once)
and Gateway interruption (a delegated child whose execution host process is killed mid-command, then reached by a
subtree request while its own turn is in flight). Its commands, exit codes and logs are in
[verification](verification.md#subtree-control-system-acceptance-2026-10-20). See
[chat](chat.md#subtree-stop-and-interrupt).

Recorded limits: an external side effect is never claimed to happen exactly once — a call interrupted inside `execute`
settles as "interrupted and may have partially run" and is not replayed; a task whose definition this build does not
install is `blocked` with the runtime's own reason rather than migrated or guessed; and a conversation bound to a
binding the deployment no longer serves keeps running on the retained binding while new targets cannot name it.

The deployment gap this section first recorded is **closed**: the routine deployment of 2026-10-17T10:54Z ships the
backend and gateway from this work, so Settings › Agents and definition-resolving quick create answer from the real
definition surface instead of 503 `host_unreachable`. That deployment's read-only smoke is a deployment check, not
acceptance evidence — **no driver of the acceptance gate ran against the live stack**, and the crash-safety results
stay claims about the isolated stacks they were measured on.

## Child task recovery (tickets 01–04 complete: G1 fixed, G3–G5 measured)

The audit of child recovery against pi-durable's contracts is at
[capability audit evidence](../.scratch/child-task-recovery/issues/01-capability-audit-evidence.md): 24 durable
objects/states mapped to the spec's buckets, the crash-window identities, and what is verified rather than
reimplemented. Ticket 02 fixed the one mislabeled seam it found (G1): a gateway command whose answer was lost reached
the model as an ordinary `unknown` execution failure, so "may have run" and "did not run" read the same at the tool
result. The conversion owner (`packages/gateway/src/environment.ts`) now keeps the gateway's three-way distinction —
`timeout`, `aborted` and a definitive refusal unchanged, a lost answer stated as `outcome_unknown` with the spent call
ID — and nothing was added to task state, replay policy or the retry path to carry it. See
[gateway integration](local-integration.md) and [architecture](architecture.md#durable-child-execution-optional-subagents-extension).

Ticket 04 measured the three gaps the audit left as evidence rather than defect (at `1873d24`, and again at the current
integration tip with no source in between touching these paths), each stage a real `SIGKILL` against the process that owns
the state (`apps/server/test/recovery-acceptance.test.ts`): a child's `bash` whose gateway dies mid-command lands **one**
`isError` result naming `outcome_unknown` and the child's own spent call ID, and the restarted gateway answers the identical
request with the same call ID and `outcome-unknown` without running it again (G3, the G1 conversion's claim checked across
two processes); a backend killed inside the commit publishing a generation partial reopens as **one** assistant entry whose
response ended (`stopReason: "aborted"`) holding the committed prefix, and the reopened run takes the interrupted turn up
itself with **one** model request handed the user's own turn (G4); and a recovered anchor whose stored task version and
installed definition disagree projects the runtime's own `task_too_old` / `migration_failed` reason while the child
conversation, its entries and the dispatch record stay readable (G5, previously only `missing_task` had end-to-end
evidence). No product source changed to produce these results, and no exactly-once claim was added: the cross-process check
bounds duplicate execution to one journal, and `SIGKILL` evidence does not extend to power loss or disk corruption.

One **capability limit** surfaced with the measurement: an interrupted generation is **restated, not continued**. The partial
the dead process committed survives as a readable ended entry, but it is not handed back as model context, so the resumed
request answers the same turn from the user content alone. Continuing from a dead process's own partial output would be an
upstream generation-checkpoint change, not a projection this application can add, and it is why the resumed transcript holds
the abandoned prefix and one new answer rather than one completed answer.

Ticket 03 resolved as evidence, not implementation: the audit's question — does a task that cannot resume need an explicit
continuation fork — is answered by behavior that already exists and is already crashed-tested, so nothing was added
(see [the decision note](../.scratch/child-task-recovery/issues/03-explicit-fork.md)).

**G2 and G6 delivered (2026-10-20).** The two surface gaps the audit left open are built as client surface over the
facts the runtime already records, with no `RecoveryBucket` redesign and no change to task state, replay policy or
recovery semantics:

- `GET /api/conversations/:id/recovery` (`apps/server/src/subagents/recovery.ts`) answers **one child's** facts per
  durable object — the dispatch's preparation state with its failed attempt's own task id and the runtime's reason, the
  anchor's own phase, and where this dispatch's report stands — read from the child's owner anchor task, the
  `DispatchDoc` and `ReportDoc` snapshots and the live task inspection, and `null` for a conversation that is no
  delegation's child. The child's single `runStatus` stays `projectRunStatus`'s and is not restated, so a reporter
  waiting on a running child and a parked preparation are no longer flattened into it.
- `POST /api/conversations/:id/recovery` retries a failed preparation under the **existing** dispatch/request identity and
  the failed attempt's own task id, validated against the record first (`identity_stale`, `already_retried`, `not_failed`,
  `not_a_delegation`), so the parked anchor of the same child prepares again and admits once — no second child, no fresh
  identity, no second admission.
- The client reaches both over `packages/session/src/control.ts` (`recovery`, `retryPreparation`) and shows them in
  `packages/ui/src/components/ChildRecoveryPanel.tsx`, mounted once above a delegated child's transcript: one read per
  conversation, no stream, no polling, and the retry offered only from the identities that read returned.

## Chat lifecycle (delivered; tickets 01–06, effort complete)

The open conversation's lifecycle is one pure projection (`packages/ui/src/lib/lifecycle-projection.ts`) fed by the
runtime's own committed facts; `packages/ui/src/hooks/useAgentSession.ts` reads its view for the transcript, the staged overlay, the
answer interest and the running indicator, and the completion tone has exactly one owner — the `answered` notice a live
terminal fact produces. The replaced authorities (the became-idle completion path, the prompt-settlement polling, the
independent loading gate on the conversation read, the duplicated stream hydration, the pending-by-key fallback maps)
are deleted rather than layered. Background completion from live facts is delivered:
`@hepi/session/browser` serves one source per conversation with a subscriber list,
`packages/ui/src/lib/completion-delivery.ts` is the shell's interest map and the page's one registry of live settlements —
every owner reports there, and the first to name an answer is the one that sounds it — and the existing poll nominates
candidates rather than deciding completions. A leave hands the surface's own projection to the watch that keeps the
stream (`CompletionDelivery.handover`), so a queued follow-up placed after the first answer is still waited for. The absence-based background tone and its sidebar boolean are removed
(ticket 06), and the unread marker no longer comes from the poll's absence at all: the catalogue reports when each
conversation's newest run ended, from the run's own durable receipt, so a run that started and finished between two polls
is marked as well as silent. The catalogue also reports a task-created conversation's creator edge, so a subagent's
completion is silent from a real source rather than from a filter that was always empty. The reported sustained multi-second stall is neither reproduced nor claimed fixed. See [Chat](chat.md) and
[verification](verification.md#chat-lifecycle-the-open-conversation).

## Execution-side resources (delivered; tickets 01–08)

Current behaviour and its verification are in [execution-side resources](execution-side-skills.md) and
[execution-side installation](execution-side-installation.md).

Tickets 01 and 02 are implemented: gateway execution-host identity, read-only execution-side resource access over
ordinary file RPC, one loader for skills, prompt templates, system/append prompts and context with verified upstream
precedence, real host paths in the model transcript, durable conversation-owned adoption of the complete result, fixed
workspace binding, and conversation-scoped load failure. Tickets 03, 04, 05, 06, 07 and 08 are implemented too:
atomic Reload with run-pinned adoption, SSH host identity, the cloud Skill Repository with its management surface,
explicit installation with update conflict handling and retained backups, and the removal of the legacy `apps/server/src/pi-resources.ts` module with its `pi-resource://` namespace,
`read_pi_resource` tool and harness-local resource loading. The two prompt-template helpers it held now live in
`apps/server/src/prompt-templates.ts`. See docs/execution-side-skills.md.

Both halves of this work are merged into `integration/chat-lifecycle` (`3a571cb`, `0f9f5ab`), verified at
`0f9f5ab`; the combined evidence is in [verification](verification.md#integrated-revision). Nothing was deployed, and
no production latency was measured after the change.

One discovery is now one request: `resourceSnapshot` returns the entire resource scope set — every root, context,
system and append prompts, prompt templates, skills and ignore files — in a single bounded response, and the loader
walks that snapshot in memory. The previous shape issued one serialized host round trip per file, which on the live
deployment made a first submission wait for the whole walk before it was committed; the new shape is one round trip
whatever the host holds. The producer prunes while it walks, applying the same ignore rules the loader applies and
stopping at a declared skill or at the prompts root's own level, so ignored and supporting content is neither read nor
transmitted nor counted. Both producers read a gitignore pattern with the same grammar: the SSH helper matches with a Python port of the
`node-ignore` 7.0.5 engine the loader and the local producer already use
(`packages/gateway/src/ssh-filesystem-helper.ts`, license kept in `packages/gateway/src/node-ignore.LICENSE`), so an ignored
file or subtree is pruned before it is read on either host. A declared skill directory stays terminal, so supporting
documents are never read into the snapshot.

The SSH filesystem now runs its helper as **one persistent session per (profile, root)** over the runner's
interactive transport instead of spawning a process per operation, and the per-request redundancy is corrected: the
account and the scope set come back in one `discover` request, the size pre-check folded into the read at contract
parity, and the three methods that named no path and passed no allow list no longer resolve an authorization at all.
A request the session never wrote is reported as not sent; one whose frame was written is the host's outcome, unknown
when the session dies or when it passes the gateway's own file deadline (`SSH_FILE_TIMEOUT_MS`, the same bound the
one-shot transport applied), and nothing is replayed. A transport that cannot hold a session open reports
`not_supported` and has no filesystem capability. Every end the gateway initiates — an idle close, a cancellation, a
deadline — asks the helper to close and gives it a bounded grace to remove the staging files it recorded itself, so a
gateway-ended session does not leave a half-written temporary file behind.
Counts and logs: [verification](verification.md#persistent-remote-filesystem-session-ticket-06).
Limits: a host that has already gone cannot be asked to clean up, so an abnormal session death still leaves its own
staging file in the target directory (never swept, and never collided with because the name carries a fresh UUID); the
grace is 5 seconds, so a helper blocked in a long operation can still be killed with its staging file in place; a
120-second idle window means the first request after a quiet period pays one session setup; and this path is latent in
production, so the reduction is a measurement, not a deployed latency.

Remaining limits: a snapshot over 16 MiB or 20,000 entries is refused rather than streamed, and nothing here
parallelizes a walk, so the per-listing cost of a very large tree is still paid — once, instead of once per file.
The port is parity-checked, not proven for every pattern `node-ignore` accepts:
`packages/gateway/test/ignore-parity.test.ts` requires the two engines to agree over a generated corpus, and
`.scratch/submit-stall/ignore-review-repro.mjs` prints what each producer answers for the reviewed shapes, while
`.scratch/submit-stall/ignore-engine-reds.mjs` degrades the engine one capability at a time to show which test catches
it. Recorded at its own revision: the ~300 s idle SSE teardown (`BodyTimeoutError`) that
[the measured diagnosis](../.scratch/submit-stall/diagnosis.md) names as a separate finding from resource discovery.
The delivered heartbeat (perf tickets 01 and 02, above) now keeps a quiet conversation stream alive, so that teardown
is historical rather than a current gap. The reported sustained multi-second stall is still neither reproduced nor
claimed fixed.

## Capability integration (complete)

All 18 tickets are merged. Tickets 01, 02, 03, 04, 07, 10, 12, 14, 16 and 17 landed on `integration/ux-follow-up`
directly; tickets 05, 06, 08, 09, 11, 13, 15 and 18 landed on `integration/ux-wave3`, which `integration/ux-follow-up`
fast-forwards to, so every ticket is on the parent branch once that fast-forward runs. They deliver pins, archive,
project order and the unread marker as one session-scoped durable document per backend, reached at
`/api/sidebar-state` (the Next adapter spelled it `/api/sessions/ui-state` and was retired by client-app ticket 17), with
the pure rules in `packages/protocol/src/sidebar-state.ts` applied by both sides; a session carries a hepi-owned name the catalogue lists; a session is removed from the catalogue as a hepi
tombstone with its records retained; a conversation forks through the runtime's own `Conversation.fork()`; session
search is a bounded scan of the conversations the catalogue lists, through the runtime's public paginated entry reads
with upstream pi-web's matcher, bounds and response shape and no index; removing a
Project keeps its folders' retained bindings; the gateway lists, creates and removes worktrees on its execution host;
the gateway serves a long-lived terminal session on its own `/v1/terminal` surface; the backend answers the installed
extensions from pi-durable's own registry, stores the global default selection as hepi application state,
materializes each conversation's selection explicitly when the conversation is created, accepts a per-conversation
override, and reports an extension that failed to install at startup; and a session is named from its own committed
transcript on an explicit request only, with pi-web's reused transcript budget and prompt shape and this backend's own
model call, written as the same hepi title document the rename owns, so no implicit pass ever replaces a typed name; and the Web host's own service — the co-located
gateway — owns the global and project `mcp.json`, the OAuth state and the folder trust decision, serves them as one
`POST /v1/mcp` operation, tests a configured server and signs in and out against a controlled fixture, while the Web
process carries the browser's calls to it at `/api/mcp` and `GET /api/project-trust` and never through the backend,
so no MCP credential reaches the durable runtime. A gateway or a Web origin that serves no MCP answers a named limit
and every other setting keeps working. "Extensions" here means durable extensions exclusively; Pi packages, the Pi
package manager, Pi plugins and any Agent Plugins bundle format remain out of scope. The browser halves of these
surfaces are separate tickets, and the MCP dialogs (17), the worktree picker (11), the terminal panel (13) and the
Project menu (09) are wired (see below), and the closing pass over all of them (18) is merged; see
[the breakdown](../.scratch/capability-integration/ticket-breakdown.md).

Ticket 18 (truthfulness and submission invariants) is merged from `impl/capability-18`: every control the new
surfaces present either performs its action or is visibly unavailable before it is clicked — the sidebar's
file-manager button is disabled and names the reason, because the availability answer now has the shape that surface
reads — a backend-answered failure is shown with its reason and a transport failure as a transport failure, and a
dropped read is never reported as an empty result. The durable-extension selection is verified in a browser against
the real backend and store: a change to the default survives a restart, a conversation created afterwards selects it,
one created before it keeps its own, and a per-conversation override leaves the default alone and survives a reload.
The submission rules of [ADR 0006](adr/0006-durable-submission-lifecycle.md) are re-asserted, including that only a
readable rejection restores the draft. See [Verification](verification.md) for the drivers.

Ticket 15 (Settings › Extensions) is implemented on `impl/capability-15`: the panel lists exactly the extensions the
backend installed, enables and disables each one as the default for new conversations or as the open conversation's
own selection, and switches several at once in one request, because the backend stores a selection whole. It offers no
install, remove, update, check or generic per-extension editor; an extension whose own surface is another Settings
section — the resource loader's is Settings › Skills — links to it. The copied Pi package-manager panel
(`apps/web/components/PluginsConfig.tsx`) and its update-check helper (`apps/web/lib/plugin-updates.ts`) were removed
with the package manager they drove, so no Pi package or bundle wording is reachable from the UI.

Ticket 13 (the terminal in the browser) is merged from `impl/capability-13`: the panel reaches the host session ticket
12 built, through the client ingress at `/api/terminal` and the backend's own relay. The terminal is resolved on the
execution host it runs on — the gateway does only path arithmetic on the registered root and the helper on that host
canonicalizes and confines both paths — so a remote Project's folder, which exists only on the SSH host, opens like
any other. Every request names the tab's routing
cwd, so the backend resolves the workspace per call and keeps no session state; a session keeps the caller's own id, so
a reloaded tab reaches the same shell and a restored tab is told when its session has ended instead of launching a
replacement. Output streams as server-sent events whose `id` is the output offset, so a dropped connection resumes from
the last event the browser received and the host replays what was missed within **128 KiB**; a detached session is kept
for a **120-second reconnect window** and then closed. Closing the tab ends the process group on the host. An open
terminal's label comes from the tab's own workspace rather than the currently selected project, which closes the carried
finding 1 from the UX follow-up review notes.

Ticket 09 (Project removal and folder unlink in the UI) is merged from `impl/capability-09`: a Project's own
menu in the sidebar lists its folders — each named by its own path on its host — and offers the Project's removal.
Unlinking a non-default folder confirms first, in copy that says only hepi metadata is removed and that no directory
on disk and no conversation is; unlinking the default folder asks which of the Project's other folders becomes the
default before anything is sent, and its control stays unavailable until one is chosen, while the last folder's
removal says the Project goes with it. A refusal changes nothing and reads as the reason the backend gave. After
either operation the sidebar and the target picker drop the Project without a page reload, its directories are
untouched, and a conversation bound to one of its folders stays listed and still runs a workspace tool there. Every
window of one backend hears the change from the poll it already runs, through the registry's own revision on the
catalogue read. See [Projects](projects.md).

Not every sidebar group is a Project, and only a recorded Project has a removal. A group named after a folder nobody
recorded — the deployment's own configured workspace is the common case, because the sidebar names a group by the last
segment of its folder — is a fallback grouping of the sessions bound to that folder: its menu offers pinning, ordering,
"archive sessions older than 7 days" and the files tab, and no removal or unlink, because there is no project record and
no folder row to remove. Removing such a workspace from a deployment is a deployment change (its id and root come from
the environment), not a UI operation, so it stays a recorded limit rather than a control. The runtime's own root
conversation is not a group either: it is a framework record, so the catalogue never lists it. See
[Projects](projects.md) for the groups and [Chat](chat.md) for the catalogue.

Ticket 07 (retained workspace bindings) is merged from `impl/capability-integration-07`: `DELETE /api/projects/:id`
removes a Project's metadata only — the project record and its folder links in one transaction with a retained binding
per folder — so no directory is touched and a conversation bound to one of its folders keeps its execution environment,
while the retained id is never a target for a new conversation, never answers `GET /api/home` or
`POST /api/default-cwd`, and re-registers the removed root after its host's gateway restarts. A Project's own metadata
operations act on the host the Project records, so a Project on a configured remote gateway is changed, unlinked and
removed from the Web origin that is showing it. Its browser half (the
Project menu) is ticket 09 and is wired (see below). See [Projects](projects.md).

Ticket 08 (unlink a folder, keep a Project's default valid) is implemented on `impl/capability-08`:
`DELETE /api/projects/:projectId/folders/:folderId` unlinks one folder, metadata only. A non-default folder goes on
its own with the Project's default untouched; the default folder's removal must name another folder of the same Project
as the replacement in the same call (`400` `default_replacement_required` otherwise); the last folder's removal
removes the Project record in the same transaction, so no read returns a folderless Project. Every unlink writes the
same retained binding ticket 07's Project removal writes, so a conversation already bound to the unlinked folder keeps
executing where it is while the folder is never a target again. The unlink control and the replacement prompt are the
browser half and belong to ticket 09 and are wired (see below). See [Projects](projects.md).

Ticket 10 (worktrees on the execution host) is merged from `impl/capability-10`: `POST /v1/worktrees`
on the gateway lists a registered root's checkouts, creates one on a branch, and removes one, with pi-web's semantics —
a create requires a registered root that is a checkout and a non-blank branch and writes nothing when either is missing,
a removal of a dirty worktree answers `dirty` and needs an explicit `force`, a listing for a checkout that is already
gone falls back to the repository the `-worktrees` convention names, and a host that cannot serve the capability answers
`not_supported` rather than a generic failure. A local gateway and an isolated localhost SSH gateway are asserted
through the same public route. The browser picker (ticket 11) is not wired to it yet.

Ticket 16 (MCP on the Web host) is merged from `impl/capability-16` and ticket 17 (the MCP surface in the browser)
from `integration/ux-follow-up`: see the merged statement above and [MCP on the Web host](mcp-on-the-web-host.md).
Settings › MCP is wired to the host service, and the dialog offers no control that service cannot perform: no Code
mode rows (the sessions' runtime owns those settings), no Undo of a removal (the host keeps no copy), and no
trust-recording dialog (the decision belongs to the `pi` CLI on the host that owns the folder). A test reports the
tool count the host found, not a per-tool list.

On the **client ingress** the same routes are answered from the host this origin runs on
(`HEPI_INGRESS_MCP_GATEWAY_URL`/`HEPI_INGRESS_MCP_GATEWAY_TOKEN`/`HEPI_INGRESS_MCP_GATEWAY_ID`, stated together or not
at all), and are the only `/api` routes it does not forward to the Backend; a folder is named to that host as a
workspace id, checked first against the Backend's own binding (which gateway that workspace is on, and that it serves no
SSH profile) and then resolved by the host's own registry, so a workspace bound to another gateway is refused before any
host is asked and one that host does not serve is refused there (`unknown-workspace` → 403 `cwd-denied`); absent
configuration answers 503 `mcp_unavailable` naming the three variables. The cookie's same-origin write guard applies to
a Web session only, so an App's declared origin writes with its own bearer, and a revocation or a client disconnect
aborts the host's own operation rather than letting it finish. The panel's answer shapes are declared once in
`@hepi/protocol/mcp-ui` and composed once, by `packages/gateway/src/ingress/mcp-panel.ts`; the panel and the trust
dialog ask through the connection's client, so the App reaches the client API on its own origin. See
[client ingress](client-ingress.md#host-local-mcp-and-project-trust).

MCP trust is read-only on the Web origin, host and browser alike. `GET /api/project-trust` reads the host's own
`trust.json` through the MCP host service; there is no `POST /api/project-trust`, no Web trust writer and no path
that would carry a decision through the durable backend. The page's trust dialog and Settings › MCP's notice state
the folder's trust and where the decision belongs — the `pi` CLI's own `/trust` prompt on the host that owns the
folder — instead of offering a button whose request this deployment does not serve; a project server is written only
where a decision already trusts the folder, and the add pane says so for one that does not. See
[MCP on the Web host](mcp-on-the-web-host.md).

MCP tools are callable from a durable conversation (ticket 02 of [the MCP conversation
effort](../.scratch/mcp-conversation-tools/spec.md)), through one seam and with no new credential path. The Gateway half
is unchanged — `POST /v1/mcp` with `operation: "invoke"` runs one tool of one configured server with a bounded
deadline, result, concurrency and cancellation, a masked answer, and a refusal for any body carrying configuration.
The Backend half is `apps/server/src/mcp-conversation-tools.ts`: one optional extension `hepi.mcp` holding one native
durable tool per declared MCP tool, named `mcp__<gatewayId>__<server>__<tool>` (sanitized to the provider alphabet,
bounded to 64 characters, a collision refused by name rather than silently renamed), whose call resolves the
conversation's **own** execution binding at the moment it runs and reaches `GatewayControl.invoke` — the
the conversation's identity, the runtime's `callId` and the workspace id, never a path and never a model-supplied host.
The host's answers stay the host's: `server-disabled`, `not-exposed`, `not-authorized`, `unknown-tool` are recorded as
they arrive, and the backend keeps no parallel trust or configuration store. No MCP credential crosses the seam in
either direction. `HEPI_MCP_TOOLS` (a JSON array of `{ gatewayId, scope, server, tool, description?, inputSchema? }`,
validated at startup: a host-configuration field, an unknown gateway or an over-long list stops the process rather than
shipping a silently smaller offer) is the operator's **fallback presentation**, no ceiling over what a person may grant.
Since 03b what one conversation is offered is its own grants, what it may be granted comes from the host's own listing,
and no declared entry is an offer in its own right.

A call that may have acted is never repeated: each registration is `replay: "unsafe"`, so a crash inside a call
settles as `interrupted` ("may have partially run") without re-running it, and an outcome the transport cannot settle
(`outcome_unknown`, `timeout`, `aborted`, `protocol_error`) or the host's own `timeout`/`cancelled` is recorded as an
uncertain refusal carrying that notice. A caller's abort is handed to the invoke request, so the host's server process
exits with the call. Verified over a real local gateway with a real stdio fixture server, and by a real SIGKILL inside
a call whose side effect was already on disk (`apps/server/test/mcp-conversation-tools.test.ts`,
`test/mcp-replay-crash-child.ts`).

**A conversation's grants (03b).** What one conversation is offered is its own durable allowlist, written only by a
person's act, and what it may be granted comes from the host's own listing. `apps/server/src/mcp-grants.ts` defines
`hepi.mcp-grants` (conversation scope, `fork: "initial"`), holding each granted tool's identity
(`gatewayId`/`scope`/`server`/`tool`) plus the host's own masked descriptor as it stood at `listedAt`. The seam is the
one that already carries a conversation's selection: `GET /api/conversations/:id/extensions` answers the extensions, the
offered tool names and the MCP state (the host's configured servers, the grants, the offered MCP names) without asking a
host; `GET …/extensions?mcp=<server>` adds that server's listing, the only request that starts one; and `PATCH
…/extensions` writes `{ extensions }`, `{ mcp: { server, tools } }` or both, one commit for the grants and the offer. With
a grant provider composed, every MCP registration is `deferred`, so the framework's own `pi.agent.modelTools` filter
decides the offer, and that field is written for MCP tools by the same commit that writes the grants — one writer, one
fact. A granted descriptor is also the **live** registration: the extension's tools are rebuilt from the stored grants,
so a re-grant after the host changed a schema takes effect on the next resolution and a restart restores the same
registrations from the store. A revocation takes the name out of the offer, so the next call settles `tool_unavailable` before its arguments are
validated and before anything leaves the process; the call body also re-reads the grants and answers `not_granted` with the
claim that nothing was sent. Nothing grants a tool to itself: no `tool_search` extension is installed, a wildcard grant is
refused by name rather than expanded, a grant naming a host-owned key (`command`, `args`, `env`, `url`, `headers`,
`auth`, `config`, `cwd`, `workspaceId`, `token`) is refused by name, and a grant of a name the host did not list
(`not_listed`) or of a server the host has no entry for (`server-missing`) writes nothing. Because `modelTools` is durable, a restarted backend re-offers exactly
what the grants state with no listing asked of anyone, and the backend's attach path reconciles a fork or a copy — which
inherits its source's agent document and none of its grants — so a branch is offered none of its source's tools.
A descriptor is a presentation snapshot, never an authority: trust, `enabled`, exposure and whether a server still holds a
name stay the host's answer, re-read at every call.

**What is not built here.** A grant is per conversation: there is no project-scoped grant document and no "grant these to
every conversation I start" default — a deployment that wants tools broadly available has its declaration path, which is
an operator fallback and is never read as a grant. The browser surface for a conversation's own tools is [A
conversation's tool states in the browser](mcp-on-the-web-host.md#a-conversations-tool-states-in-the-browser-ticket-03c): Settings ›
Extensions, in the conversation scope, under `hepi.mcp`, shows the four states, an explicit per-server discovery and a
revocation control on the same seam. A conversation selects the whole
`hepi.mcp` extension through that seam or none of it, and one bound to no execution workspace is
refused both the selection (409 `unavailable_extension`) and any grant (409 `host_unavailable`). Because MCP belongs to the
local gateway, an SSH gateway serves none of this: a call over SSH settles as the host's own `mcp_unavailable`, and a
listing or a grant of such a host is refused with that same code. See
[MCP on the Web host](mcp-on-the-web-host.md#a-conversations-own-grants-ticket-03b).

**Child and fork lifecycle (04).** A child inherits nothing: the delegation seam creates a child with `modelTools: null`,
so a task-owned child — which the runtime gives a copy of its parent's `pi.agent` — is offered none of its parent's MCP
tools and its own grant document starts empty, and an attempt at a tool its parent holds settles `tool_unavailable` before
any request leaves the backend. Inheritance is an explicit policy a definition would state, not a consequence of being
delegated to, and none is configured today. A grant written on a branch or a child is that conversation's own and never
moves its source's offer — the same `fork: "initial"` rule read in the other direction. Per conversation, every MCP
registration carries `executionMode: "sequential"`, so one round cannot take the host's eight-call bound and starve another
conversation; two conversations still run at once. A call in flight when the process dies stays settled as recorded:
`replay: "unsafe"` is unchanged by any lifecycle handling, so recovery settles it `interrupted` and never repeats a side
effect. A **stop** (not just an abort) ends an in-flight call through the conversation's own scope, the host's server
process exits with it, the call settles as an uncertain end, and the resume that follows starts no work of its own — so
the settlement stands and the side effect stays one. A child is still a conversation, so a grant written on it is offered
and really runs; the case that needed a change is a child delegated from a **definition**, whose `pi.agent.tools` is an
exact enabled list the runtime filters *before* `modelTools` decides the offer. The grant write now appends the granted
names to that exact list (and only to an exact list — an unset or `{ remove }` filter states no allowlist of its own), and
`reportedSelection` applies `tools` before `modelTools` in the runtime's own order, so a restricted conversation's
reported offer and the offer a call meets cannot disagree.

**The whole journey, observed (05).** One browser journey — `apps/web/e2e/mcp-skills/ux-mcp-acceptance.mjs` (58 checks) against
the deployed shape — runs add/test → list → explicit selection → a real model invocation whose answer is in the
transcript, then disabled, changed-schema, offline, restart, cancellation, fork and untrusted-project states, and an SSH
gateway stating its own `mcp_unavailable` limit to the MCP route. It found two material browser defects, both fixed here:
the conversation scope of Settings › Extensions asked the retired `/api/sessions/:id/…` vocabulary this deployment does
not serve (so no person could reach a conversation's MCP tools at all), and a grant write's answer, which carries no
listing, made the panel drop every row of that server once the first grant was written. The delegated-child row is stated
as unexercised on this deployment (no worker definition) and stays pinned by 04 at the durable seam. See
[MCP on the Web host](mcp-on-the-web-host.md#the-whole-journey-observed-ticket-05).

Verified by `apps/server/test/mcp-conversation-tools.test.ts`
(nine calls in one round all settling while a second conversation's call is not refused `busy`, a grant written on a
branch staying there while the source keeps its own, a delegated child offered none of its parent's tools with its attempt
refused before any host is addressed, a conversation's own stop ending the call it was running with a resume repeating
nothing, and a definition-restricted child reporting only its own tools while a grant written on it is offered and runs).

## UX follow-up (delivered; tickets 01–14)

All fourteen tickets of [the UX follow-up effort](../.scratch/ux-follow-up/spec.md) are implemented, verified and
merged on `integration/ux-follow-up`, with the two material code-review findings fixed, and the tip is deployed to the
split test topology ([39c168d record](records/39c168d-deployment.md)).

Delivered: a terminal tab that fails to connect closes instead of trapping the session; the visible-turn navigation
highlight follows the turns actually on screen; DeepSeek image capability metadata is stated under the configured
provider alias; the built-in Skills surface reports installation, update and toggle outcomes and the standalone Market
UI was retired; configurable response-footer token icons; image submission as native content blocks with durable
history across reconnect and restart; single-host Projects with one default folder per project; SSH remote Projects
through one configured profile; dual-source skill search and download; skills update/toggle with a project target;
backend-owned Pi model configuration through Settings › Models; and explicit recovery when a conversation's selected
model is no longer offered.

Capability integration (tickets 01–18 of [the effort](../.scratch/capability-integration/spec.md)) is complete; session fork (ticket 04),
session delete (ticket 03), session search (ticket 05) and the Project menu (ticket 09) are delivered. `GET /api/sessions/search?q=` reaches the
backend's `GET /api/search`, which reads each conversation's entries through the runtime's public paginated reads and
applies upstream pi-web's matcher, limits and response shape — 500 conversations examined, 30 results, a 3 s budget,
16 MiB per conversation, a 1 MiB entry and a 200-character query — with no index and nothing to rebuild, reports a hit
bound as `truncated`, refuses an over-long query with a readable reason, and never searches a removed conversation.
`POST /api/sessions/[id]/fork` reaches the backend's
`POST /api/conversations/:id/fork`, which forks through the one creation seam's native fork, answers the new identity
with its catalogue row, leaves the source's live run undisturbed, refuses a missing, unsaved or empty source without
creating anything, and carries the caller's `requestId` so a retry after a lost answer returns the branch the first
attempt created. A **child** conversation a task owns is no longer refused: the branch keeps it as its display parent
and its native fork source and gets its own background anchor task in that child's scope, so it dispatches, queues and
stops on its own without reusing the child's task or falling back to an ownerless conversation, and the catalogue
reports that branch by its fork and display edges rather than as a delegated subagent. The branch starts from the
configuration in force at its entry — the native agent document forks `asOf` — and an explicit `model` or
`thinkingLevel` on the fork request replaces that field, validated exactly as the settings route validates it. The
toolbar's Full history control opens the raw-history panel, which is `GET /api/conversations/:id/read`: it lists the
entries behind the window with each block's inventory, shows the page's text, fetches one block on demand (an image as
its bytes), lists the conversation's structured references and forks at any entry it lists. The composer's pending queue is
**item by item**: `GET /api/conversations/:id/items` states the same queue the snapshot does, with each item's native
`submissionId`, mode, text, source (a user input, or the child and dispatch a report came from) and content token — and
`PATCH`/`DELETE /api/conversations/:id/items/<submissionId>` reach the backend's own per-item edit and cancel. An edit is validated against the token the caller read, so a stale tab is refused with the
current item instead of overwriting a newer decision; a cancel goes through the runtime's own `abortSubmission`. Neither
clears the user's hold nor starts a model run — only the trusted Continue does, and an empty one appends no user
message. The whole-queue recall is unchanged beside them. `DELETE /api/conversations/:id` removes a conversation from the
catalogue by writing the conversation-scoped `hepi.deleted` document through the
durable document path — pi-durable 1.1.0 has no conversation deletion, so the records are retained and the removal is
presented as an ordinary one — and clears the session's pin, archive and unread entries in the same commit. A run in
flight is answered at once and settles into those records; a new turn on a removed session is refused with
`code: "session_deleted"`.

Web logout is connected at the Web session owner: `GET /api/web-auth` reports the configured token gate and
`DELETE /api/web-auth` clears the durable login cookie, then Settings reloads `/` to show the login form.

**A capability is unavailable only when the deployment says so.** Settings reads each capability's own route before
offering its control, and only an explicit unsupported answer — HTTP 501 with `code: "unsupported"` — reads as
unavailable. Any other answer (200, 401, 403, 405, 500, or a 501 without that code) leaves the control in place, and a
request that never arrived (offline, a proxy, a timeout) reads as **unknown**, never as the deployment's limit: the
surface says it could not confirm the capability and asks again on the next read. Nothing retries on its own, and no
capability registry or second list of capabilities exists — the path a control calls is the path it asks about. This
covers model discovery, connection test, catalog fill, model visibility, the catalog-refresh pass, Sub-agents and push;
models.json editing, per-conversation model/thinking selection, provider listing/API-key set/remove and provider
sign-in/sign-out remain connected — the last four because the client ingress answers them from this host's own gateway service rather than from
a Backend route, so an unserved provider key is a 503 `provider_auth_unavailable` naming the variables to set, which is
not the 501 a capability gate reads as a limit. Provider sign-in keeps that gate: a host composed without the sign-in
service answers the 501 and `OAuthDetail` withholds Login, while the key path and sign-out beside it stay usable. These
availability notices do not implement the underlying routes.

The [2026-10-14 design review](../.scratch/development-audit/design-review.md) follow-up fixes four reproduced
failures in source: foreign Execution Host folders are refused by the local MCP resolver; rejected HTTP/SSE snapshots
cannot replace frame-derived metadata; committed large text has explicit full-text recovery through ordinary history
paging; and SSH worktree listing uses the surviving resolved checkout after the initial linked root is deleted.
Classification, red reproductions and integration evidence are in the [design-fix results](../.scratch/design-fixes/results.md).
These working-tree changes have not been deployed. Structured tool-call arguments and live/pending payloads remain
subject to frame limits. Active loaded-history DOM cost still needs focused investigation; the bounded snapshot LRU
does not bound current rendered history. See the
[performance measurements](../.scratch/development-audit/performance-research.md) for fixture sizes and limits.

Still open: the remaining Settings/provider surfaces that answer 501 (the MCP capability is implemented, host and
browser alike; see the capability-integration section). Provider listing and API-key set/remove are a gateway host
operation — `POST /v1/providers/auth` on the local gateway — and the browser relay is now ticket 02 delivered:
the client ingress answers `/api/auth/providers` and `/api/auth/api-key/:id` over that same configured host service, and
Settings › Models reads and writes it through `packages/ui/src/lib/provider/provider-auth.ts`. Ticket 03 is delivered too: the
pi-ai device, manual and copy-code flows now run on that host (`POST /v1/providers/login`) and reach the browser as
`/api/auth/login/:id` and `/api/auth/logout/:id`, polled rather than streamed so a reloaded tab neither loses nor cancels
a sign-in, with each flow keyed to the caller this ingress admitted and masked in both directions
(`packages/gateway/src/provider-login.ts`, `packages/ui/src/lib/provider/provider-login.ts`,
`packages/ui/src/components/OAuthDetail.tsx`). Ticket 04 — what a credential change owes model availability — is delivered
too, and its answer is that no signal is owed. Each Backend catalog read re-resolves which models a credential
authenticates from the account that process was configured with: in Pi mode that account is the very file the Gateway
writes and it is re-read rather than cached, so a stored credential arrives and a removed one withdraws with no restart
and no message; in environment mode — the deployed shape — no file is consulted and a Web-host credential is not this
backend's concern, by design rather than for want of a route. The stale answer a credential change does create is the
catalog **this page** caches per connection, and the owning surface drops it
(`packages/ui/src/lib/models-cache.ts`, `invalidateModelCatalog()`). A catalog *pass* is a different capability — a
network read of which models exist at a provider — and stays the named limit docs/client-ingress.md states; the
enabled-models view used to POST to it and report the refusal as an unreachable provider endpoint, and now asks the
route before offering its button. Seam: `apps/server/test/provider-availability.test.ts` (Gateway service writes,
Backend route reads, both modes, no credential value in any answer). Ticket 05 closes the acceptance gap those seams left:
`apps/web/e2e/acceptance/ux-provider-connection-acceptance.mjs` drives one composed real system in Pi file-backed mode — production
Web build, real ingress, real Gateway, real Backend, a real device-code sign-in against a run-owned RFC 8628 stand-in —
and shows a credential stored in Settings becoming a model the composer offers with no reload. That run found a shipped
client defect: the composer read the retired Next BFF's catalog shape, so the Backend's own `models` list (the only
answer this ingress serves) reached a selector as model objects and the composer failed to render. The read now goes
through `packages/ui/src/lib/catalog-answer.ts`, which holds both shapes. See
[Provider connection state](architecture.md#provider-connection-state),
[ticket 04's answer](../.scratch/provider-connection/issues/04-model-refresh.md). See
[docs/projects.md](projects.md), [docs/chat.md](chat.md), [docs/pi-config.md](pi-config.md) and
[docs/execution-side-installation.md](execution-side-installation.md) for the current contracts.

## Retained and removed

Upstream pi-web source and MIT licences are preserved as vendor snapshots with recorded revisions in
[upstream sources](upstream-sources.md); they are provenance, not executable paths. The executable presentation was
extracted into `packages/ui`, and client-app tickets 04, 09 and 17 then retired the dormant Web helpers, the dead event
surface and finally the whole Next layer (`apps/web/app`, `apps/web/adapters`, `apps/web/lib`, `apps/web/vendor`,
`next.config.ts`). What remains executable is the shared workbench plus the two thin hosts; the retirement record with its
per-file dispositions and check runs is
[ticket 17](../.scratch/client-app/issues/17-retire-next-and-transition-paths.md).

Standalone demo/durable-harness (including its separate npm lock/dependency tree and unauthenticated entrypoint) was removed after its behaviours passed replacement tests and manual recovery. Source fingerprints and historical README are archived under docs/archive/. Do not treat the archive instructions as current startup commands.

## Performance follow-up: SSH reuse (tickets 06 and 07 delivered)

Installation and execution on an SSH-profile gateway now share one gateway-managed `ControlMaster`, keyed on the full
connection profile and living in `<HEPI_GATEWAY_DATA>/ssh-control` (0700). Measured against a real localhost sshd, one
real publication plus one execution call went from **7 authentications to 1**; the transport the deployment actually
uses is local and runs no SSH profile, so this path is latent in production and the numbers come from the build host.
Current behaviour is in [Gateway integration](local-integration.md#ssh-prerequisites) and
[Execution-side installation](execution-side-installation.md#the-ssh-transport), the check and its log in
[Verification](verification.md#gateway-managed-controlmaster-for-install-and-execution-ticket-07).

Recorded limits, not silently handled:

- **Crash residue.** An abnormal gateway exit leaves its master sockets in the gateway's own directory. They are
  deliberately not swept: nothing is deleted because a name or a pid looks dead. A socket's name carries the pid that
  created it, which keeps two gateways running at once apart; the pid is not a nonce, so a restarted process whose pid
  was recycled could name a socket an earlier crash left behind. `ControlMaster=auto` replaces such a stale socket file
  rather than failing (observed against a real sshd), but the name alone is not an isolation guarantee from that
  residue.
- **Same-account writers (advisory).** The 0700 directory keeps other *accounts* on the host from creating or replacing
  the socket. It does not separate processes running as the gateway's own account: a same-UID process could in
  principle connect to or replace the socket. Nothing is implemented against that here, and its impact on the
  single-account workstations this is deployed to is unverified; it is recorded rather than fixed.
- **One reuse mechanism per capability.** The master is not applied to the filesystem, workspace, worktree or terminal
  transports, and it is not layered under the persistent filesystem session that ticket 06 introduces. A remote file
  read therefore pays its handshake once per session (ticket 06), not once per helper run, and never through the
  gateway's install/exec master.
- **A transport without a session has no filesystem capability at all.** A runner that cannot hold a session open
  answers the named `not_supported` limit ("this SSH transport cannot hold a filesystem session open"); the one-shot
  `execute` path is deleted rather than kept as a per-call fallback, so a host without Python 3 or a gateway composed
  without the capability is refused by name instead of silently degrading. An abnormal session end can also leave its
  own staging file (`.hepi-write-<uuid>.tmp`) in the target directory; it is never swept, and a later write cannot
  collide with it because the name carries a fresh UUID.
- **Gateway-spawned processes only.** The explicit `ControlPath` overrides the user's SSH configuration for the
  gateway's own install and execution processes; the user's interactive `ssh` keeps its own `ControlPath` and its own
  master, and nothing under `~/.ssh` is read, written or deleted by this feature.

## Composer drafts across a refresh (delivered)

The composer's unsent text and images survive a hard refresh of the same tab: `packages/ui/src/lib/draft-store.ts` keeps its
synchronous memory as the owner and mirrors each draft into the tab's own `sessionStorage`, with the text and the
attachment list stored separately so typing never re-serializes attachments. The fresh composer's transient key travels
in the tab's navigation memory, so a reload returns to the composer the tab was showing. A store that refuses the write
drops the stale entry, reports the limit to the composer instead of implying the draft is kept, and does not re-offer an
unchanged oversized attachment list on every keystroke — a draft too large to store stays as cheap to hold as a small
one, and the draft itself remains this page's to send. Behaviour, the limits, the
no-resend/no-re-notify rules and the verification are in
[Chat](chat.md#composer-drafts-across-a-refresh) and
[verification](verification.md#composer-drafts-across-a-refresh).

**Recorded limit at the Web contract switch.** A page running the pre-switch build holds its drafts in memory only, so
that build cannot checkpoint them: unsent text and any attached image must be copied or saved by hand before that page's
first refresh, per the [deployment runbook](deployment-runbook.md#existing-open-pages-at-a-web-contract-switch). No
compatibility bridge for the old in-memory store is implemented or planned.

## Client ingress and device credentials (ticket 02)

The client ingress, its Web session and the Backend-owned device credentials are implemented and tested over real HTTP,
and as of 2026-10-18 the ingress **is** the deployed Web entry on the workstation ([the 1873d24 record](records/1873d24-deployment.md)),
started as its own unit from a client-runtime release. The Backend's own port and the execution gateway's loopback
listener keep the binds they always had, and nothing in a package default starts the ingress: it runs because the
deployment states it. Starting it by hand remains an explicit operator act
(`pnpm --filter @hepi/gateway start:ingress`) with its own configuration. Four materials are separated — Web login
material, device credential, ingress-to-Backend service credential and execution token — the Backend stores only token
digests in `device-credentials.sqlite` beside the conversation database, and every request is checked with no cached
success. The declared revocation bound for an already attached stream is one re-check interval (1000 ms by default), and
revoking access ends access without aborting the agent run. Routes, configuration and limits are in
[Client ingress](client-ingress.md); the evidence is in
[verification](verification.md#client-ingress-and-device-credentials-ticket-02). The cutover that makes this the running
entry is ticket 16, and the deployment runbook is deliberately unchanged until then.

## Backend-owned ingress locality verdict (ingress-binding ticket 01)

The client ingress's folder question is now a Backend answer instead of two listings joined in the Gateway. `GET
/api/workspaces/:workspaceId/locality?gatewayId=…` (`workspace-http.ts`, shape `WorkspaceLocality` in
`@hepi/protocol`) states whether a workspace is a folder on the machine of the gateway the caller named. It is the
predicate the ingress used to assemble itself: membership of the workspace listing, retained bindings included, the
owner's gateway id, and a host-profile answer with no error and no profiles. A workspace this deployment does not bind,
an owner that is another gateway, an SSH-profile host and any host result that predicate does not accept all answer
`{ local: false }`; a query the Backend could not evaluate keeps its own non-success (`503 gateway_offline` for a
gateway it cannot reach) rather than a fabricated negative. `/api/workspaces` and `/api/hosts` keep their shapes and
their catalogue callers.

Still open: the ingress itself still composes the two listings, so this route has no product caller yet
([ticket 02](../.scratch/ingress-binding/issues/02-ingress-migration.md)). Nothing is cached, no path is resolved and no
filesystem is probed by the verdict.

## Client ingress conversation slice (ticket 03)

One conversation now works end to end through the client listener: a real caller creates it, reads its state and
history, submits input, stops and continues, and follows the Backend's own `snapshot` / `state` / `submission` /
`resync_required` / `state_oversize` frames — all with the Backend's statuses, bodies and wire codes, and nothing
re-projected in the Gateway. The stream is piped rather than parsed, so a frame, the keepalive comment frame and a chunk
boundary reach the caller exactly as written, and a caller's cancellation ends the ingress's own upstream request. A
submission whose answer was never read is settled by looking up the caller's `requestId`: the same id converges on the
same submission and the same conversation, so a retry after a lost answer neither repeats an unknown write nor creates a
second turn.

Routing is now stated rather than guessed: the ingress forwards the execution host it serves
(`HEPI_INGRESS_DEFAULT_HOST`) as trusted configuration, the Backend resolves that name against the gateways it was
configured with, and a caller cannot substitute one. The Backend still reaches a host only through the execution
gateway's internal listener with the execution token; the client listener serves no `/v1` route, that internal listener
refuses the client cookie, the ingress service credential and any client bearer, and nothing is proxied from one
listener to the other, so there is no recursion. Behaviour is in [Client ingress](client-ingress.md#the-conversation-slice);
evidence is in [verification](verification.md#client-ingress-conversation-slice-ticket-03).

Still open, unchanged by this slice: no TLS listener is claimed. (The deployed-entry half closed on 2026-10-18; ticket 16
itself stays open for the native/App and browser journeys.)
The shared React UI above it is ticket 05, which is in progress: its conversation path now uses this contract, while the
native App journey and the cross-host acceptance remain with tickets 04 and 16.

## Catalogue binding and host selection (ticket 06)

The catalogue projection, Project/workspace binding and host selection are delivered in the Backend and consumed by the
shared workbench over the client ingress. The workbench's own catalogue row
(`packages/ui/src/lib/conversation-catalogue.ts`) projects the same row for both hosts, and the sidebar's own reads now
ask the Backend's vocabulary through the connection rather than the retired Next BFF's: `packages/ui/src/lib/workspace-api.ts`
(`createWorkspaceApi` / `useWorkspaceApi`) is the one seam behind the sidebar, the folder picker, the New Project dialog
and the New Session context bar — `/api/workspaces`, `/api/projects` (create, remove, unlink), `/api/hosts`,
`/api/host/directories` and `POST /api/worktrees { workspaceId, operation }`, with the sidebar document on
`/api/sidebar-state`. The BFF's `/api/sessions/ui-state`, `/api/home`, `/api/default-cwd`, `/api/cwd/browse` and
`/api/worktrees?cwd=` are no longer asked: home and "use default directory" are derived from the two listings, a folder
picker offers existing directories only, and "open in file manager" is stated as the unsupported platform capability it is.
No client names the computer it is served from — the deployment states it on the forwarded request
(`HEPI_INGRESS_DEFAULT_HOST`; `HEPI_WEB_LOCAL_GATEWAY_ID` for the Web process) and only a remote target the Backend itself
listed is named by the caller. Every catalogue row now states its workspace's own binding facts —
`gatewayId`, the root the deployment recorded for it (`workspace.root`), whether a removal retained it
(`workspace.retained`) and the Project it is a folder of (`workspace.project`: id, name, default folder, display root) —
and the catalogue answer carries the list version (`sessionListVersion`) the Backend computed. The workbench therefore
assembles a session list from **one** catalogue read plus **one** workspace listing, with no per-conversation read and
no second derivation of the list version, instead of reconciling the catalogue against a separate project read and a
separate workspace read (review note P3). One fact stays outside the row on purpose: a **configured** workspace's root is
the execution host's answer and this deployment holds that workspace only as an id and a host, so it comes from
`GET /api/workspaces` once for the whole list. A conversation already bound keeps its workspace, its host and its root
after a Project removal or a folder unlink, and a created or removed worktree keeps the same binding contract. See
[Projects](projects.md#behaviour-worth-knowing) and [Chat](chat.md); evidence is in
[verification](verification.md#catalogue-project-binding-and-host-selection-ticket-06).

Remaining limits, recorded rather than closed. The request count per list assembly is measured only as *which reads
happen* (the adapter suite asserts the catalogue and workspace listing and no per-conversation call), not as a latency or
allocation figure; no number in this entry is a performance claim. When this entry was written the deployed Web UI still
ran the Next presentation layer (`deploy/compose.yaml`'s `web` service), so this adapter had to forward the two native routes
the shared workbench now asks — `/api/host/directories` and `/api/sidebar-state` — under their own names and contribute only
the gateway id `HEPI_WEB_LOCAL_GATEWAY_ID` names. The workstation's Web origin moved to the client ingress on 2026-10-18
([the 1873d24 record](records/1873d24-deployment.md)), which forwards those same `/api` routes to the Backend instead of answering
them from `apps/web`; those Next handlers were deleted by client-app ticket 17. `next build` was already broken at that
revision for a pre-existing reason outside this ticket (`c0579bd` moved `gfm-autolink-email-loader.cjs` to
`packages/ui/src/lib/` while `apps/web/next.config.ts` still named `apps/web/lib/`), so the Next-based e2e journeys could
not be run for this change; the seam is covered by a real-HTTP ingress test and an esbuild browser fixture instead.

## History, context and authenticated media resources (ticket 07)

A conversation's heavy content reaches a client as a **read block**: a history frame carries a bounded preview of a
large text or a thinking block and an address for an image, and the block serves the rest. Those addresses are wire facts
the protocol builds (`/api/sessions/:id/entries/:entryId/text|thinking|tool-result-image`), and the client ingress now
serves them under the same cookie or device bearer as everything else — the only route translation the ingress makes, and
one that leaves the Backend's single history projection where it is.

Both read blocks are **bounded by default**. Text and thinking answer at most 256 KiB of UTF-8 with `offset`,
`totalBytes`, `truncated` and `nextOffset`, and following the continuation rejoins the block byte for byte; an image
honours a byte `Range` (`206`/`416`, `accept-ranges: bytes`) and decodes only the base64 groups the range touches, so a
window of a 10 MiB screenshot costs a window. The one implementation is `apps/server/src/read-block.ts`; the Web's own
`loadDeferredText` and thinking loader follow the same continuation, so a preview still expands to the whole text.

The client half is `packages/session/src/resources.ts`, one reader per connection scope: it resolves a wire address
against the Gateway it was admitted to (an address on any other origin is refused before a request is made, which is what
a native shell needs), assembles a text from its pages, and turns an image into a **blob lease** — shared by every
reader of one address, revoked when the last one releases it, reclaimed least-recently-used beyond 24 blobs / 32 MiB and
32 texts / 16 MiB, and revoked wholesale by `dispose()`. An answer that arrives after disposal is dropped rather than
retained, so one connection's image never appears in the next one's view. Refusals are named
(`unauthorized`, `forbidden`, `not_found`, `oversize`, `unavailable`, `disposed`).

Behaviour, the route table and the bounds are in [Client ingress](client-ingress.md); the evidence is in
[verification](verification.md#history-context-and-authenticated-media-resources-ticket-07). Not evidenced here: any
native platform (Android still has no SDK; the desktop shell is evidenced separately by tickets 04 and 15) and the shared
React surfaces that will use this contract (ticket 05, whose primary conversation path now does; its history panels still read the raw history through the
connection's own read). The in-stream JSON round trip stays a recorded measurement candidate; this change adds no parser and
removes no string bridge.

## Conversation control, queue, fork and relations (ticket 10)

The conversation's control surface is now reachable through the client ingress, and the client module that calls it is
`packages/session/src/control.ts`. Stop and continue, the queue (steer, follow-up, per-item edit and cancel, recall),
fork, delegation, structured references, rename and removal all reach the Backend's own routes, so the durable control
revision, the receipt a request id names, the queued item, the branch and the tombstone stay the Backend's alone: the
client holds no second copy, infers no "busy" and schedules no retry.

One rule covers a lost answer across the whole surface. A response that never arrived — a dropped connection, a 5xx from
the hop in front of the Backend, a body this build cannot read — is an **unknown outcome** carrying the request id the
attempt was made under, and it is resolved by asking the conversation about that id (`control(id)`, the submission
lookup, or the same attempt id for a fork or a delegation). It is never retried. A 4xx is a refusal and carries the
Backend's own code. That is [ADR 0006](adr/0006-durable-submission-lifecycle.md)'s rule for a pending submission
applied to the rest of the surface, so one conversation has one vocabulary for a lost write instead of two.

Provenance stays intact on the creation paths: a fork keeps its native branch point, a delegation keeps the definition,
scope and host it came from, and a child's creator, display parent and owner are its own relations. A retried attempt is
answered with the conversation it already made, so a lost answer cannot manufacture a second copy.

Operations, the three outcomes and the ownership split are in
[Client ingress](client-ingress.md#conversation-control-queue-fork-and-relations); the evidence is in
[verification](verification.md#conversation-control-queue-fork-and-relations-ticket-10). Not delivered by this ticket:
the React surfaces that call these operations (ticket 05 owns the shared UI) and the deployed entry (ticket 16, since
delivered — [the 1873d24 record](records/1873d24-deployment.md)). The old
The Next adapter's own `/api/agent/:id` command path and `/api/sessions/:id` routes existed at this ticket's revision and
were retired with the rest of that layer by client-app ticket 17; this ticket added the client seam that replaced them
and did not modify them. Ticket 05 has since moved the
workbench's own stop, continue, queue, fork and delegation callers onto this seam (see
[above](#shared-client-and-the-app-conversation-api-cutover-ticket-05-integrated)).

## Shared client and the App conversation API cutover (ticket 05, integrated)

The shared React workbench is delivered and both hosts mount it, but the **App's conversation path was not working** until
this cutover: the workbench asked the retired Next BFF's `/api/sessions…` and `/api/agent…` vocabulary, the client ingress
forwards everything except the deferred read block unchanged, and the Backend implements only `/api/conversations…`. A
device bearer on the App therefore received the Backend's own `404 {code:"not_found"}` for the session list, the running
poll and the conversation stream. Ticket 10 had already assigned those old React consumers to ticket 05.

The primary session path — list, running poll, search, create, read, by-id open, bounded history, send, the named control
operations, the request-id submission lookup and the conversation event stream — now asks the Backend's own vocabulary
through the connection's client. `packages/ui/src/lib/conversation-api.ts` is the one conversation API
(`createConversationApi`), assembled once per connection with the connection itself (`workbenchConnection`) rather than
rebuilt by each surface that reads it; `packages/ui/src/lib/conversation-catalogue.ts` is the catalogue-row projection,
writes go through the existing `@hepi/session/control` three-outcome rule, and `@hepi/session/browser`'s
`conversationSource()` replaced the BFF-named source. Idempotency and bounded history are unchanged: a `requestId` is still the attempt identity,
`/submissions?requestId=` is still the only recovery, a 4xx refusal is still distinct from an unknown outcome, and history is
still the Backend's `/entries?before|tail` page. No compatibility route was added to the Gateway or the Backend, and the
routes owned by tickets 06–15 were not touched.

Two review findings on this cutover are fixed at their owners. An attachment on a **busy** steer or follow-up used to
disappear between the composer and the conversation: the queue-only path dropped the images at the client and the
Backend's `POST /api/conversations/:id/busy` read text only. That route is the same admission seam as an ordinary
submission with `resume: false`, so it now takes the protocol's own text **and** image blocks, validates them with the
shared `validateCommand` and image-capability check the message and resume routes use, and refuses a draft it cannot
admit before anything is queued — the composer keeps the text and the images instead of being told the turn was staged.
A delegation answer's catalogue row was handed to the shell unprojected, so a child created in the same folder read as
a folder change and cleared the file tabs; `delegateFrom` now projects that row with the same function the list uses, so
the child arrives with its folder, its Project and its relation. Recorded, not fixed: `recallQueue()` hands back the
**text** of a recalled item, so an attachment on a recalled queued draft is not returned — that is ticket 10's recall
semantics and no evidence of a material failure has been reported.

**What is still open.** The cutover is integrated in the integration tip (`b0a9f62`), and the ticket stays open for the one
acceptance item it cannot close here. The evidence is a real-HTTP seam — `packages/ui/src/lib/conversation-api.http.test.mjs`
runs the workbench modules against a real client ingress and a real Backend under a device bearer, and asserts both that the
old vocabulary is `404` there and that the workbench now makes no `/api/sessions` or `/api/agent` request at all. That is
not a native App journey: opening, sending, refreshing and reopening a conversation inside a real Tauri/WebKitGTK shell is
ticket 04/16's evidence, and the cross-host acceptance (Web creates, App submits, the answer is lost, the original
`requestId` is queried and one submission exists) is ticket 16's. Surfaces that still use a relative `fetch` belong to
their own tickets — files and git (08), sidebar UI state and the project/worktree/cwd routes (06), models and auth (11),
skills and agent definitions (12), MCP and project trust (13), terminal (09), notifications and the durable login (14/17) —
and the bash full-output route `/api/agent/:id/bash-output` has no Backend implementation, so it stays recorded against 08.
Those Next BFF route handlers were deleted with the rest of that layer by client-app ticket 17. Behaviour is in
[Client ingress](client-ingress.md#the-shared-workbench-and-whose-state-a-page-holds); the ticket's own record is
[ticket 05](../.scratch/client-app/issues/05-shared-ui-routing-and-scope.md#the-conversation-api-cutover-2026-10-17-scout-223).

## Desktop platform evidence (ticket 04)

The first desktop target is now evidenced on real hardware rather than assumed: Linux x86_64 on `workstation`, WebKitGTK 4.1
(2.52.3), Tauri v2 (crate 2.12.4, CLI 2.12.3), measured inside a real Tauri shell with the fixture servers' own records
as the counter-evidence. SSE arrives incrementally; a stream the server drops ends the caller's reader cleanly with no
exception, so recovery keys on `resync_required` and the lifecycle facts and never on a throw; the page origin is
`tauri://localhost`, which makes every gateway cross-origin and CSP-bound; WebKitGTK rejects streamed `fetch` request
bodies outright, so uploads stay bounded bodies; a 96 MiB download streams correctly but crossing IPC with the WebView's
own multi-tens-of-MB chunks peaks at ~3.06 GB RSS, while 1 MiB slices save the same bytes at ~225 MB; and the OS
credential store round-trips across processes through Secret Service.

The live phase ran the same WebView against the real ticket 03/07 client ingress and a real Backend: descriptor,
conversation create and submit, the Backend's own `snapshot`/`submission`/`state` frames, the settled transcript, and
the ticket-07 deferred read block named by the frame all served on the client listener with a device bearer.

Still not evidenced, and therefore not claimed: **Android**. This host has no SDK, no `adb`, no `sdkmanager`, no device
and no emulator, and `tauri android init` exits 1. The absence remains recorded; Android support is withdrawn from scope
and no longer gates ticket 04.
A system `dpkg -i` needs root the host does not grant, so no host was ever installed onto; the package's real installed
layout was inspected and its binary executed, and since `bdc8746` that runs as a **real dpkg transaction inside a
throwaway root in an unprivileged user namespace**
([offline-install.mjs](../apps/app/scripts/offline-install.mjs)). Behaviour, commands and logs:
[verification](verification.md#tauri-desktop-platform-spike-ticket-04); reproduction:
[spike](../spike/tauri-platform-04/README.md).

The branch was integrated into `integration/client-app` by fast-forward to `2584b78` on top of `2a41b2e`, and the three
native suites plus the selected checks were run again on that integrated tree: the same assertions hold and the
measurements repeat within a few percent, so the ticket stays `in-progress (desktop evidenced; mobile support withdrawn)` —
desktop evidence is complete and mobile support is withdrawn. Ticket 08 inherits the file-path constraints as recorded requirements: the
`tauri://localhost` origin must be in both `HEPI_APP_ORIGINS` and the built CSP, uploads are bounded `Blob` bodies
because WebKitGTK rejects streamed request bodies, a large download is sliced to ≤1 MiB before IPC, and an abrupt stream
drop is recovered through `resync_required` rather than an exception.

## App shell and client artifacts (ticket 15)

The App is now a real Tauri v2 shell rather than a Vite bundle with an injected global. It reads this install's connection
— profile, Gateway origin and the device bearer the Backend issued — from the OS credential store (Secret Service on the
verified Linux target), names the configured origin in the window's CSP **before the window exists** (an address outside
it is refused by the WebView before the request leaves it, which is ticket 04's measured constraint), and hands the three
values to the page at document start. A first run has no connection and renders a configuration surface; storing one
restarts the process, because a running document cannot be handed a new policy. The same two operations are reachable
without a display, with the bearer on stdin rather than in a process list (`hepi-app --configure` / `--forget`).

Artifacts are one command per half. `apps/app/scripts/build-artifacts.mjs` builds the UI, the static Web product and the
`.deb`, stamps the shell with the client and shell revisions it was built from, and writes provenance — revision, dirty
state, host, target architecture, toolchain versions, per-artifact checksums, per-step exit codes and logs — plus a
reproducibility measurement: two builds produce a **byte-identical executable**, while the `.deb` container records its
bundling time (the Tauri bundler does not read `SOURCE_DATE_EPOCH`), so the package checksums differ and the payloads do
not. `apps/app/scripts/verify-artifacts.mjs` is the entry point that resolves the artifact and calls one concrete
operation (`apps/app/scripts/verify-artifacts.operation.mjs`), which asserts against the produced package: contents,
architecture, dependencies, resolved libraries, no internal credential or Node/Next payload, a cold start with no
connection, a cold start from a stored one where a fixture Gateway sees `GET /api/descriptor` arrive with
`Origin: tauri://localhost` and the stored bearer, the first-run form driven through the real window, and a cold start
after forgetting the connection.

Behaviour, commands and limits: [apps/app README](../apps/app/README.md); evidence:
[verification](verification.md#app-shell-and-packaged-artifacts-ticket-15). Not delivered here: the deployed entry and
the cutover (ticket 16), and **any mobile artifact** — Android has no SDK, no `adb`, no device on this host, so the
absence remains recorded; mobile support is withdrawn from scope and no Android support is claimed. The ≤1 MiB IPC
slice rule is now enforced by the App's native save (client-app ticket 20), which is the write path that consumes it.
The install limit was closed differently than it was
blocked: `dpkg --install` still needs root the host does not grant, but the host grants unprivileged user namespaces, so
the package now goes through a **real dpkg transaction as root of a throwaway tree**, the packaged binary executes from the
layout dpkg itself wrote, and the host's own record of the package is read before and after the transaction and compared
(unchanged, not "absent" — a workstation that already runs the App has such a record). `systemInstall` stays `false` — nothing
was installed onto a system — and the transaction's own outcome is recorded under `offlineDpkgInstall`.
[apps/app/scripts/offline-install.mjs](../apps/app/scripts/offline-install.mjs).
## App connection refusal and recovery (ticket 19)

A stored App connection is not an admitted one: the device bearer can be revoked, or the Gateway can be unreachable. The
App used to render a refusal paragraph with nothing to press, so the only way back was `hepi-app --configure`. The
refusal is now a surface with the step that can change it, and the two failures are stated as the different states they
are: a **refused credential** (401/403) offers *Configure connection…* (primary, focused) and *Disconnect…* and no retry,
because repeating the read cannot admit a credential the Gateway refused; an **unreachable Gateway** offers *Try again*
first, with the same two management actions beside it. A Web page offers none of them — its credential is the ingress's
cookie, so its refusal is the deployment's sign-in form.

Replacing a connection is not deleting one. The form opens **over** the stored connection, starts from the stored profile
and origin, requires the credential to be typed again, and writes nothing until Connect; **Cancel keeps the stored
connection**, which the packaged test asserts by reading the run's own Secret Service entry before and after the
keypress. A successful replacement restarts and reports the profile, Backend, account scope and client identity of the
**new** descriptor the Gateway admitted. **Disconnect** asks first, in a panel that states what it does — delete this
machine's stored connection — and what it does not: it does not revoke the device credential on the Gateway and does not
stop a durable run on the execution host.

Where the seam is: the rule that classifies a refusal (`web-session-gate.ts`'s `admissionOf`, now stating `state`), the
surface that renders it (`packages/ui/src/components/ConnectionRecovery.tsx`, shared by both hosts), and the host that
supplies the two actions (`apps/app/src/main.tsx` passes `connectionManagement`; the Web page passes nothing). The
workbench owns the retry, so "Try again" is a new descriptor read of the same connection rather than a replayed write.

Evidence: [verification](verification.md#app-connection-refusal-and-recovery-ticket-19) — packaged artifact test 54/54 on
the two fixture ingresses (one refusing, one admitting), the private credential bus with the developer's own login keyring
digest unchanged, and the selected checks. Behaviour and commands: [apps/app README](../apps/app/README.md).
Not claimed: an Android artifact, or a recovery journey against a real Gateway and Backend.

## Execution-side resources through the client entry (ticket 12)

Skills, installations and agent definitions are now reachable through the **client ingress**, on the execution host the
Backend resolves for the workspace the caller names. The route set is the Backend's own: `/api/skill-market/{inventory,
installed,check,install,update,skills}` and `/api/agent-definitions[/document]`, with the repository's
`{skills,search,preview,bundles}` beside them. The client half is `packages/session/src/execution-resources.ts`: one
connection scope, the repository reads, and a `select(workspaceId)`ed target whose disposal is what retires its
answers, so an inventory that arrives after the selection moved is refused as `disposed` instead of replacing the new
host's view.

**No client request names a computer.** An operation names a `workspaceId`; which gateway and which account serve it is
the Backend's binding resolution, the same one a conversation uses. That closes the review's G3 for these surfaces: the
Web `/api/agent-definitions` proxy used to read this deployment's workspace and project listings to pick a gateway id,
and that read is gone — it now forwards the workspace and no host, so a folder on the entry's own machine and a Project
folder on an SSH host are addressed by the same call and the entry's stated default host cannot override a Project's
recorded binding. The host-side contracts are unchanged: `apps/server/src/skill-install.ts` still owns the baseline,
provenance and the two separate outcomes, `apps/server/src/agent-definitions-http.ts` still owns validation and the
whole-document write, and the gateway's installation and `agent-definitions` resource seams are the only writers.

**The shared workbench consumes the seam, on both hosts.** The Skills panel, the Agents panel, the quick delegate and
the composer's skill-dormancy annotation read through the connection (`useExecutionTarget`) rather than by a relative
`fetch`, because the address and the credential are the connection's: a Web page's own origin and cookie, an App's
configured Gateway and device bearer. A relative call inside the shared tree would ask the App's bundle for a host's
skills, which is the failure the seam exists to prevent. The two Next adapters that spelled the same operations a second
way were removed with that layer: the `PATCH /api/skills` branch (and the SKILL.md-path-to-directory translation behind it) is
deleted, and the `/api/agent-definitions` proxy now forwards a workspace it is given — the shared client's
`workspaceId`, or a Web page's own `cwd=/workspace/<id>` — instead of resolving a host.

**A selection is a lifecycle, not a memo.** `useExecutionTarget` creates its target inside the effect that holds it, so
the replay both hosts run in StrictMode gets a live target instead of the one its own cleanup just disposed, and the
frame between two selections hands out no target at all. That is what makes the scope the fence rather than a request
counter: a read whose target is no longer the one on screen writes nothing — not the previous host's inventory, not its
error, and not the end of the loading state the new host is still in. The committed inventory-race browser regression
drives one order independently — the previous host answering while the selected host is still loading — and the other
order (the previous host answering after the selected host did) was driven by the reviewer's development-React checks,
not by a committed assertion. The same identity check covers the panels whose reads answer later than the folder change
(agents, quick delegate), and a Project-scope add pane holds a target for the folder its scope resolves to, so an
installation lands on the project's own default folder instead of being refused for having no target. These review
findings are merged into `integration/client-app` at `e5a9d18` and re-run there; the ticket is resolved.

StrictMode replay is the one claim the browser fixtures do not carry: they bundle with
`process.env.NODE_ENV="production"`, and production React does not double-invoke effects. The replay is covered by
`packages/ui/src/lib/workbench-scope.test.mjs` (the real hook driven through an effect/cleanup/replay harness) and by the
reviewer's development-React checks; the browser regression covers the observable consequence — the selected target is
alive and stays the one being read.

Refusals keep their own words rather than being flattened: an unreachable host is `unreachable_host` with a one-line
reason, an unbound workspace is the installer's `not_found`, an unconfirmed replacement is `confirmation_required` with
the state it saw, a stale confirmation is `conflict` with the edit intact, a document naming a capability this build
cannot execute is `unsupported_capability` with its field, and a publication whose answer was lost is
`outcome_unknown` and is never replayed. Adoption remains a second outcome beside what happened to the files. The
repository's upstream provenance records are untouched by this migration.

Behaviour and the route table are in [Client ingress](client-ingress.md#execution-side-resources-skills-installations-and-agent-definitions);
the commands, revision, exit codes and logs are in
[ticket 12's answer](../.scratch/client-app/issues/12-execution-side-resources.md#answer). Not
evidenced here: any native platform beyond ticket 04's desktop result, and the Web surfaces outside this contract
(models, providers, extensions and the terminal) that still call their own routes. The Next BFF files this ticket worked beside were deleted by client-app ticket 17, and no caller of the execution-side
routes resolves a host outside the ingress.

Capability limits that remain, and are not claimed: a skill cannot be **uninstalled** on any host — the installation
capability publishes and replaces, so the panel offers no delete; `HEPI_INGRESS_DEFAULT_HOST` selects nothing by itself
for these routes, because the caller names a workspace and the Backend resolves it, so a deployment that only states a
default host still needs a recorded workspace or Project binding; and the Next-build browser smokes that used to drive
install feedback and the delegation journey cannot run on this tree now that the Web build is Vite, so those behaviours
are evidenced by the ingress and shared-UI suites plus the esbuild-mounted browser fixtures, not by those journeys. No
native platform beyond ticket 04's desktop result was exercised for these operations, and the production-React browser
fixtures are not evidence about StrictMode's replay — that one is the hook suite's, as stated above.

## Web install, offline and page notifications (ticket 14)

The Vite Web host now owns its install surface. `apps/web/public/manifest.webmanifest` is linked from
`apps/web/src/index.html`, the entry registers the versioned worker (`/sw.js?v=<package version>`, scope `/`) through
`apps/web/src/pwa.ts` after the first render, and the worker (`apps/web/public/sw.js`) precaches the offline page, the
manifest and the icons, answers a navigation the ingress cannot reach with `offline.html` behind an 8 s first-byte
timeout, and serves Vite's hashed `/assets/` files cache-first. `/api/` is never intercepted and never cached, and the
worker installs no `push`, `sync` or `periodicsync` handler. The App registers no worker: its own bundle-boundary test
asserts that. The Web Push prototype is retired — `packages/ui/src/lib/push-client.ts` and its call sites are gone, and
Settings General offers no register-push control — so the page's completion notice is the only notification, delivered by
`packages/ui/src/lib/browser-notifications.ts` for an `answered` lifecycle fact while the page is not in the foreground,
through the worker's registration where one exists and the page's own `Notification` where it does not. Recovery reads,
reconnects, acquired baselines and `resync_required` produce no notice, so a repair cannot manufacture a completion.
Universal background push stays a non-goal. Evidence: [verification](verification.md#web-install-offline-and-page-notifications-ticket-14).

Limits this record carries: the browser's own install prompt is not exercised (headless Chromium cannot accept one), so
what is verified is the install surface — a parsed manifest with no error, both icons served, an activated worker
controlling the site root; the Next entry, its `PwaRegistration` component and the vendored upstream `push-client.ts`
snapshot were deleted by client-app ticket 17, and `apps/web/public/sw.js` is the shared path the old Next site also
served, so its static-asset policy changed with the direct replacement; the cache name is the package version, so
same-version rebuilds share it and rely on hashed asset names plus network-first navigation, with the release identity
belonging to ticket 15; and the App's notification capability is whatever its WebView provides, which this ticket did not
measure.

## The page's one terminal stream (ticket 09)

Every mounted terminal tab attaches through **one** `text/event-stream` per page, read with `fetch` rather than `EventSource`:
the Web branch states no credential and the browser attaches its own HttpOnly cookie, an App states one device bearer, and
neither can put a credential in a URL. The reader owns the request, so releasing the last tab aborts it instead of leaving
the browser to retry, and a reopen names the tab's own cursor. The stream belongs to the connection value the shell already
holds (`WorkbenchClient.connection`), so a connection switch closes it and opens the next rather than carrying a tab's
cursor into a scope where it means something else. The relay, the host's retained tail and the Backend's merge over the
gateways it routes to are unchanged, and no client ever addresses an execution host or holds an execution token.

The stream is created by the effect that shows the connection and held in state, not memoized across the cleanup that closes
it: both hosts mount their roots in `StrictMode`, whose development build replays an effect by running the cleanup and
then the effect again on the same state, and a memoized instance would be handed back closed — every attachment the page made
afterwards would be refused for the life of the page. Until that effect has run there is no stream, and a panel is handed
**none** rather than the stream of the connection being replaced: it builds nothing, and the next render states the stream and
the panel's effect runs once, with the widget, the host's answer and the attachment all in that one pass.

Limits this record carries: the evidence is the real HTTP/SSE integration test and the browser fixture under a development
React build, not a real Tauri/WebKitGTK or mobile host (ticket 04's Android half is still missing), and the browser fixture
loads the terminal surface through esbuild rather than through the Next entry that ticket 17 has since deleted. Behaviour is in
[Client ingress](client-ingress.md#the-terminal-fan-in); the ticket's own evidence is
[ticket 09](../.scratch/client-app/issues/09-terminal-fan-in.md).

## Read and navigation failure recovery (ticket 21)

A conversation read now has four named outcomes instead of a spinner, a raw error string or a console line. The
classification is one pure module, `packages/ui/src/lib/read-recovery.ts`: `unreachable` (no answer, or a 5xx),
`missing` (the Backend's own `not_found`), `refused` (any other 4xx or a named refusal) and `cancelled` (the surface
aborted the read). The raw reason is carried in `ReadFailure.detail` for the log and is never rendered; the sentence a
reader sees is a fixed key per kind (`chat.readUnreachable`, `chat.readMissing`, `chat.readRefused`), so a diagnostic
cannot leak onto the page through a failure state.

`packages/ui/src/components/ReadFailurePanel.tsx` states them in two placements. A read that failed with nothing on
screen takes the transcript's place; a read that failed a **refresh** keeps the accepted window — the projection already
holds it — and the panel is a dismissible banner above it, so a transient error does not discard content the reader had.
Retry is a real `<button>` (`aria-busy`, disabled in flight) and appears only for `unreachable`, because a `missing` or
`refused` read answers the same way however often it is asked; those offer the way back to a working conversation
instead, which is the same composer fallback the sidebar's delete already uses and clears no draft.

The recovery is a **read**: `useAgentSession.retryRead` forces one `GET /api/conversations/:id/state` under a fresh
acquisition and issues nothing else. A staged turn, a stop or an upload whose outcome was never established keeps its
request id and goes back through the submission lookup that owns it (ADR 0006); the lifecycle test asserts the request
list and the unchanged non-GET count across a recovery. `AppShell.handleOpenSession` — the by-id read a deep link or a
reference resolves — now states the same classified failure over the chat area instead of a console line, and
`loadContext` reports a failed page through `onReadFailure` rather than answering `undefined` twice, because a
re-baselined page and a failed page are different facts. History-navigation ticket 03 removed that channel's only
production caller: a deep **search** hit now resolves through the navigation coordinator's one bounded target read and
reports that coordinator's own named outcomes (below), so the option remains the page read's own statement with no
consumer in the shipped surface rather than a second reader. The history/reference target read keeps its own owner.

Limits this record carries: the evidence is the render and hook seams (`read-recovery.test.mjs`,
`ReadFailurePanel.test.mjs`, three cases in `useAgentSession.lifecycle.test.mjs`) and the changed-profile run, not an
authenticated browser journey. Driving a live failure would need a Backend that fails one specific conversation read on
demand, which the repository's no-bypass-testing rule puts out of scope. Behaviour is in
[Chat](chat.md#read-failures-and-their-recovery); the ticket's own evidence is
[ticket 21](../.scratch/client-app/issues/21-read-and-navigation-recovery.md).

## Full-history navigation (history-navigation tickets 01–05)

Delivered: the Backend-owned reads over a conversation's fork-aware committed history.
`GET /api/conversations/:id/navigation?limit=&cursor=&scope` answers one bounded page of user-message anchors with an
opaque coordinate, an ordering cursor, the snapshot/scope identities and capped previews, plus the named outcomes
`malformed`, `wrong-scope` and `stale-snapshot`, and an explicit `prefix` state for content that precedes the first
anchor. `GET /api/conversations/:id/navigation/around?anchor=&before=&after=&snapshot=&entry=&block=` answers the bounded
target window that coordinate addresses, in the transcript's own projected entry shape. Both are declared once in
`@hepi/protocol/navigation`; each route is a thin adapter over the runtime's membership-checked scan; the client ingress
relays both unchanged. Compaction keeps every committed anchor enumerable and retires the coordinates issued before it;
a fork enumerates and reads inherited anchors in native order and names a sibling's entry `missing`; an append extends
the outline without moving an existing anchor's identity, and does not move a window pinned to the snapshot it came
from — which is the identity that window then states back, so the answer always describes the history its bytes were
read against. `hasOlder`/`hasNewer` state whether committed history lies that way within that pinned history, not whether
this read carried any of it, so a window asked for no context still names the boundary beyond its target.
See [Chat](chat.md#the-full-history-navigation-outline).

Review finding N1 (a page stated a byte count excluding its own `bytes` field, 14 bytes low at the ceiling) is closed
here rather than repeated: the shared measurement `navigationSerializedBytes` settles the field's own width and both
assemblers use it, so a stated size equals the serialized response. Asserted at the contract seam against
`JSON.stringify` of the built page and window, and at both routes against the bytes the caller received.

Capability limits this record carries, with the condition that closes each:

- **The rail lists the committed history, and a jump to it costs one read (ticket 04).** `ChatMinimap` joins the
  paged outline with the measured transcript through one rule (`buildRailNodes`,
  `packages/ui/src/lib/history-rail.ts`): a node the transcript carries keeps every local measured
  user/assistant/heading jump, and a node it does not carry is listed by entry identity, server cursor and bounded
  preview alone — drawn hollow, never claiming visibility, with no height invented for it. A click on an unloaded node
  hands over one coordinate to the navigation coordinator and issues no outline page read; the landing is held beside
  the shell's search target so the older-history sentinel stays silent from the click until the alignment ends. One
  outline page is read when a conversation opens and one per activation in the rail; a failed page is named in the rail
  and reaching again is its retry. The assistant-only prefix is not turned into a node (spec decision 10), while a
  measured turn newer than the newest listed anchor is one, because the reader's window sits at the tail.
- **The client evidence is unit, real-HTTP and two browser scenes — not the full journeys.** Ticket 03's boundary is
  asserted at the coordinator (22 cases: one read per jump, none for a loaded target, refusal-to-name mapping, switch
  cancellation, busy deferral including a Retry taken after the run ended, the identity fence read after the await,
  outline accumulation), at the rendered outcome (7 named states, each with its own sentence and its
  retry/raw-history/dismissal offers), at the transcript owner (`landWindow` merging through the prefix rule), over a
  real Backend and ingress for both reads plus a refusal's code across the connection seam, and in a browser for the one
  scene this ticket owns — a failed deep hit, its Retry and the landing that follows, with the production `ChatWindow`
  under `StrictMode` and no older page read during the settlement (`apps/web/e2e/history/ux-navigation-retry.mjs`). Ticket
  04 adds the rail's own scene (`apps/web/e2e/history/ux-history-rail.mjs`): nodes beyond the loaded window listed in server
  order with bounded previews, hollow unloaded dots that never claim visibility, one coordinate and zero outline-page
  reads on an unloaded click, the unchanged local measured jump, one read per "more" activation and a named failed page
  that keeps the anchors it held.
- **The real-Backend matrix is delivered (ticket 05).** One browser journey drives the whole capability on the deployed
  shape — `apps/web/dist` through the real ingress, the ingress cookie, the real Backend over SQLite, and this run's own
  controlled model endpoint — over a conversation of 130 committed anchors that is longer than its window, carries a
  compaction over turn 20 and a fork at turn 40
  (`apps/web/e2e/history/ux-history-navigation-acceptance.mjs`, 82 checks, exit 0 on `ed0e4a1`). It observes: the rail's first
  page plus only the measured tail past it against a transcript mounting 42 of 262 entries; one bounded target read and
  zero outline-page reads per unloaded anchor; a free local jump; one continuation read from the Backend's own cursor;
  an append that grows the rail 130 → 131 without moving an anchor; a deep search hit resolved through the same
  coordinator with its own entry and block addressing; fork inheritance read under the fork's own scope; and each named
  outcome — `stale-snapshot`, `wrong-scope` and `missing` refused by the Backend over the ingress, `deferred-busy`
  against a genuinely held run whose Retry lands, and read `error` from an aborted read whose Retry lands. `cancelled`
  is asserted at the coordinator seam it is decided in, plus its mounted consequence (a real sidebar switch mid-read
  lands the abandoned target nowhere and leaves no stale banner). See
  [verification](verification.md#full-history-navigation-system-acceptance-ticket-05-2026-10-20).
- **Two rail defects the matrix found are fixed.** A rail click was a silent no-op for a node the transcript had
  *measured* and then unmounted: the jump scrolled to the stored offset of a coordinate the window had since moved, and
  named nothing. The anchor element is now kept beside the measurement, an unmounted turn is treated as an unmeasured
  one, both the click and the reveal alignment read the element's offset in the DOM now, and the reveal alignment stays
  pending across the measurements that replace the transcript's estimates (bounded to 12 re-aims). A conversation switch
  during a read also threw `Cannot read properties of null (reading 'signal')`, because the navigation hook cleared its
  abort controller ref in a cleanup; the aborted controller is now left in place.
- **One scan per page and per window.** A page walks the entry table from its cursor forward until it holds enough
  anchors; a window walks outward from its target on both sides, bounded by the loaded window's own raw-entry cap
  (`NAVIGATION_TARGET_MAX_RAW_ENTRIES`) and stating what it could not reach through `hasOlder`/`newerCursor`. There is
  no persisted anchor index, no count field and no O(1) random access. Revisit only if measured cost matters in normal
  use.
- **A navigation response's size is bounded once.** `bytes` is the shipped size including its own field; a page the
  64 KiB budget shortened says `hasMore` and hands back the cursor that reaches what it dropped, and a window whose
  target alone cannot fit answers `frame_too_large` with that entry rather than an emptied or truncated body. Safe
  because an anchor's preview is capped at 240 UTF-8 bytes and a heavy entry block is deferred by the transcript's own
  projection into the read blocks that restore it.
- **`missing` is a target-read outcome only.** An outline page has no target to be missing, so ticket 01's page answers
  the three page-level codes and the window adds `missing` (404) and `frame_too_large` (413). Spec item 9's
  `cancelled`, `deferred-busy` and read `error` are now delivered with them: the coordinator names them, and a code the
  surface has no sentence for (the shared `frame_too_large` is the shipped example) is rendered as the read's `error`
  with the Backend's own detail kept beside it rather than given a second vocabulary.

Both reads are **in `integration/client-app`** as of tip `701add2` (carried by `c070e7e`), with the navigation source
byte-identical to the branch that was reviewed; the re-run at the tip and the whole server/gateway acceptance suites are
recorded in [verification](verification.md#history-navigation-ticket-02-integration-2026-10-20).

Evidence: `pnpm verify:changed --base=integration/client-app` on the delivering branch (command, SHA, dirty state and exit
codes in the run's own `.dev/verify/` logs) and the tickets' own records in
[ticket 01](../.scratch/history-navigation-research/issues/01-historical-anchor-contract.md) and
[ticket 02](../.scratch/history-navigation-research/issues/02-bounded-target-window.md). The system acceptance matrix and
the two fixes it produced are recorded in
[verification](verification.md#full-history-navigation-system-acceptance-ticket-05-2026-10-20).

## Scope and external gates

Selected cleanup ticket 08 is complete after the real SSH interruption matrix passed; deployment readiness remains a separate verification. Selected MVP subset is not full pi-web/pi-gui/ExecutionEnv parity. The pi-gui desktop `ExecutionEnv` interface, session export, file watch/line/dir readers, branch tree and advanced session UI mutations remain deliberately unsupported, not silent stubs, while the browser terminal itself already runs a real PTY on the gateway; worktree list, create and remove are a gateway host capability since ticket 10 and the browser picker is wired to it since ticket 11 (see above). Workspace file upload and binary UI preview/download are implemented through the file payload routes (`POST /v1/files/upload`, `POST /v1/files/upload-check`, `GET /v1/files/bytes`, relayed by the backend and reached by the copied explorer and viewer), which is why the workbench proxy's 1 MiB JSON request no longer bounds them; a file over the 16 MiB per-payload policy is refused with a named limit rather than streamed unbounded, an upload request may carry up to the copied route's own 100 MiB batch bound while its multipart body is streamed rather than buffered, and a replacement keeps the target's permissions, and live watch remains unsupported; a `.docx` is previewed in the browser as text since ticket 05 (see
[the Word document preview](workbench.md#the-word-document-preview)). Image *submission* (native image content blocks on a prompt) is implemented and covered by `apps/server/test/submission-images.test.ts`; the browser driver that also observed it (`ux-image-submit`) depended on the retired Next build and was deleted with it, so submission's own browser half is a recorded coverage gap. It is a different capability from writing a file into the workspace, which is now supported. SSH open reader verifies inode identity per request rather than retaining a remote fd. Hostile concurrent path changes are outside trusted personal-workspace assumptions.

Real-provider text/SSE smoke now passes with user-authorized locally configured magpie/deepseek-v4.1-flash and isolated supplied Models; see docs/verification.md. This is remote inference using local configuration, with subsequent real-model read/edit/bash diagnosis, protected-file integrity, compile and SQLite reopen checks passed (docs/real-model-coding-verification.md); not real-model abort coverage, and remains outside fast tests. pi-gui Electron/Node26 guard blockers remain documented, not suppressed. Final execution review fixed spent-ID eviction replay using tombstones, bounded NDJSON writes, awaited each client output callback, rejected malformed RPC bodies/frames, and projected output loss warnings. Gateway and workspace regressions pass. Git status errors now fail rather than report a fake clean repository; truncated previews disable unavailable load-more. Broken tests importing retired runtime files were removed from app lib (original copies remain in vendor). Ticket 08 covers only proven-obsolete runtime removal; these external/full-parity checks are not falsely marked passed.

## Cross-conversation references, target validation (ticket 01)

Delivered: the existing reference owner now validates what it stores. `ConversationReference`, `ReferencesDoc`, the
`references` action of `ConversationOperations` and the Backend reference route remain the single owner of link
storage; what they add is a resolving read and creation-time validation over the **target's** own facts. No schema,
store, index, copied history or model tool was added — the record still carries `conversationId`, `entryId?` and
`label?` and nothing else, and `entryId` is the stable entry identity the history owner already issues.

The verdict is one function in `apps/server/src/conversation-operations.ts` (`unresolvedReference`), read by creation
and by the resolving read, so a refused creation and a follow cannot disagree about the same reference:

- `target-missing` (404) — no conversation record holds that id.
- `target-unavailable` (409) — the target exists and is tombstoned. This closes the gap the earlier existence check
  left: a removed conversation keeps its records, so it passed a record check while being out of every visible
  surface.
- `entry-missing` (404) — no conversation holds the entry id.
- `entry-out-of-scope` (409) — the entry exists, and it is not in that target's **visible committed fork-aware
  history**. Membership is the runtime's own membership-checked entry scan, the same fence a read block, a raw page and
  a navigation window use, so an inherited fork entry validates in the fork, an entry behind a compaction still
  validates, and another conversation's or a sibling branch's entry does not.
- `stale` and `error` are follow-time outcomes reported beside a stored reference (`ReferenceOutcome` in
  `@hepi/protocol`); a stored reference is never rewritten, dropped or repointed, so a removal does not cascade into
  another conversation's state and the user's link is not silently lost.

`POST /api/conversations/:id/references` refuses an unresolvable reference with that outcome's own code and stores
nothing; `GET /api/conversations/:id` and `ConversationOperations.references` answer each stored reference with its
outcome when it has one. Idempotency stays by target **plus entry**, and a fork still starts with no inherited
references. `packages/session/src/control.ts` relays the answer unchanged, so the named outcome is what a surface
renders rather than a message it parses. Behaviour is in
[Chat](chat.md#bounded-history-older-pages-and-the-read-blocks).

Evidence: `apps/server/test/conversation-references.test.ts` (five cases at the core seam and the HTTP route) plus the
updated assertions in `apps/server/test/conversation-relations.test.ts` and
`packages/gateway/test/ingress-control.test.ts`; the ticket record carries the exact commands, revision and exit codes.

Limits this record carries:

- **`stale` is stated by the client coordinator, not by this Backend read.** The Backend distinguishes the four
  creation/follow facts above; a snapshot or scope that moved under a page is the navigation contract's
  `stale-snapshot`, and a reference whose target went away after it resolved is reported as `target-unavailable` or
  `entry-missing` at follow time.
- **Creation and follow were delivered by ticket 02.** The create action, the picker and the named client states are
  the section below; the two limits this list stated before it (no surface, no entry follow) no longer hold.

## Cross-conversation references, creation and follow (ticket 02)

Delivered: a user can create a reference from the conversation they are in, see it in the existing Full-history surface,
and follow it with a named result when the target or entry is gone. The surface is `ReferencePanel` /
`ReferenceSurface` in `packages/ui/src/components/ReferencePanel.tsx`, placed by `RawHistoryPanel` where the reference
list already was, and its decisions are one pure module (`packages/ui/src/lib/references.ts`) so no branch inside a
component decides what a reader is told.

Scope held as the spec states it: creation is a **deliberate user action**; the target **defaults to the conversation**
with an entry optional; entry options are the chosen target's own paged navigation outline, so an entry is chosen from an
identity the history owner already issued rather than typed or inferred from an ordinal; the label uses the record's
existing field; the write is `POST /api/conversations/:id/references` through the client ingress via
`ConversationControl.addReference`, so no store, cache, schema, copied history or model tool was added. Nothing creates
a reference automatically on dispatch, fork, subagent spawn or model output, and fork/tombstone behaviour is unchanged —
a fork still starts with no inherited references.

Following reuses both existing owners rather than adding a second path. A conversation reference calls the shell's
open-session seam with the conversation only. An entry reference calls it with the entry, which is the same
`searchTarget` hand-over a deep search hit uses, resolved by `useHistoryNavigation`: one bounded
`GET /api/conversations/:id/navigation/around` read, exact block placement, presentation-only scroll. A reference the
Backend reports as unresolvable opens nothing; the nearest surviving entry is never substituted.

Each named outcome renders its own state with the offers it can support (`referenceOffers`): `target-missing` and
`target-unavailable` offer nothing, `entry-missing`/`entry-out-of-scope`/`stale` offer the surviving conversation and
its raw history, and only `error` offers a retry. A refused creation shows the Backend's own outcome name and states
that nothing was stored.

One seam fix was needed to make an entry follow land: `ChatWindow` now waits for the conversation's accepted
`snapshotRevision` before issuing a locate. The coordinator mints its coordinate from the conversation **and its scope**,
and a conversation the page already remembers renders ready with messages while its read has not yet stated the scope —
so the follow was refused as `malformed` for a coordinate that was never issued. The gate is the existing identity, not
a timer.

Remaining limits this record carries:

- **`target-unavailable` is a statement about the stored target, not a live subscription.** A target removed *after* a
  panel read is listed again as unavailable on the next read or reload; the surface does not watch for the tombstone.
- **The picker lists the catalogue's conversations.** A conversation hidden from the catalogue is not offered, which is
  the same visibility rule the sidebar follows; it can still be referenced by id through the API, and the Backend
  validates whatever it is given.
- **Entry options are one bounded outline page.** A very long target offers the anchors that page states rather than
  every committed entry; choosing one from a later page is not a UI capability yet, and conversation-only references are
  unaffected.
- **`entry-missing` and `entry-out-of-scope` are not reachable from the picker.** The picker offers the target's own
  outline anchors and the owner validates them, so an entry reference created through the surface cannot name one of
  those. Their rendering is proven at the client seam (ticket 02's browser scene) and their refusal at the owner and
  route seams (ticket 01); no browser journey produces them through the ordinary lifecycle.
- **A reference's own route has no dedicated retry budget.** A failed list read is named and retried by the reader
  (`references.retry`); nothing retries on its own.

The source is integrated on this line (cherry-picked from `impl/xref-02-03` at `6191f82`, record at `42dcbc3`) and was
re-measured here rather than inherited. The **system acceptance is met** at `0a3d065` and re-run on this line at `0acf499`: `apps/web/e2e/chat/ux-references-acceptance.mjs`
runs the creation, reload and follow journeys over the deployed shape — the production Web build served by the client
ingress, the real Backend over SQLite, a controlled model endpoint and no intercepted route — including the
**inherited-fork-entry follow** in the fork's own coordinate and a **real Backend outage** whose retry lands once the
Backend answers again. The rows that stack cannot reach through an ordinary lifecycle stay at the seams listed above;
[ticket 03](../.scratch/cross-session-references/issues/03-acceptance.md) records which and why.

