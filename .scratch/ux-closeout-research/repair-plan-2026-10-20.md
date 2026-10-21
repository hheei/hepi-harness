# Closeout repair plan — 2026-10-20

Status at `c2b6923`: R1 progress persistence, R2–R6 and the R7 Retry fix are integrated. R1 abort/outcome atomicity remains recorded; R7 combined acceptance and deployment alignment are complete with explicit platform and provider limits.
Baseline: `23d4f1e432ef8ca74c09e760596eadee36fe285e`.
Owner: coordinator. Existing capability specs own behavior; client-app 22 owns aggregate UX acceptance.

## Execution order

1. Coordinator verifies the combined revision, reusing evidence only against unchanged source.
2. Reconcile client-app 22 with final checks and explicit platform/provider limits; keep R7 pending until evidence exists.
3. Build a traceable immutable release, align services through the runbook, then verify the actual origin and finalize R7.

## Work and dependencies

| ID | Work / disposition | Owner and state | Blocked by |
| --- | --- | --- | --- |
| R1 | Subtree progress persistence — fixed; runtime abort/outcome gap remains recorded | worker-152; integrated as `e4de965`, reviewed with no material findings; main changed verification exit 0 | None for delivered fix; closing remaining gap requires runtime support |
| R2 | Keyboard history rail and compaction scope refresh — delivered | worker-157; integrated `d7a03b3` + read/lifetime/connection fence `04a14fc` | None |
| R3 | Raw-history response races and collapsed-sidebar focus — delivered | worker-154; integrated `96ffc28` + comment cleanup `11f84f9` | None |
| R4 | Concurrent image ownership and disposal — fixed | worker-155; `6414045` integrated on main after coordinator diff/log inspection; red 3/7 failures, green 7/7; changed verification passed against baseline plus the committed delta | None |
| R5 | Compact running-state polling — delivered; measured on real HTTP | integrated `ec7fd52`, direct call `defdeed`, strict answer `9d86b31` | None |
| R6 | Measured minimap preview optimization — delivered | worker-153; integrated `91e9213` + translation cleanup `4fde598` | None; recorded scan costs remain nonblocking |
| R7 | Combined acceptance, docs and deployment alignment — delivered | client-app 22 and coordinator; release `c2b6923` deployed and verified on workstation | None; retained limits below |

R2 and R3 each close two confirmed defects; implementation delivery does not complete R7 acceptance.

## R1 — Subtree interrupt progress and replay

Trigger: one captured child drains while another waits. `Promise.all` delayed all outcome commits; resuming the request could call unkeyed `conversation.abort()` again. Worker-152 reproduced the failure with deterministic, in-memory event gates, then moved each outcome commit into its concurrent child operation. The tests confirm mid-flight progress and a fresh operations instance leaving a settled child's new work running. They do not restart a process or reopen storage.

Disposition: progress persistence is delivered in `e4de965`. The remaining interrupt abort/outcome atomicity gap is recorded in `docs/chat.md` and subtree ticket 01: unlike `stop`, native `abort()` has no request receipt committed with its abort marks. Early outcome commits do not eliminate a crash between abort and outcome persistence. No coordinator shadow registry or vendor patch is added. Revisit when runtime receipt support exists, an actual incident supplies new evidence, or the user prioritizes the runtime change.

Scope: `apps/server/src/subtree-control.ts`, focused tests and the existing durable interruption owner if required.

Acceptance:

- GET shows each settled child while another remains pending.
- Repeating a request identity waits for its original interruption and leaves subsequently admitted work untouched.
- Recovery covers the receipt/abort/outcome gap. Early outcome commits alone do not close that crash window. Inspect the owning runtime transaction before choosing the fix; document any unsupported semantics candidly.
- Preserve captured descendants, selection, stop/interrupt distinction and per-child outcomes.
- Ordinary tests use deterministic gates and in-memory fixtures; process/disk crash checks belong to acceptance.

## R2 — History rail access and scope

Delivered in `d7a03b3` / `04a14fc`: keyboard opens and navigates the rail; scope changes refresh the outline and Retry coordinate. Reads are fenced by request, lifetime and connection. The original hover-only and stale-compaction defects are closed; R7 still owns combined acceptance.

Scope: `ChatMinimap.tsx`, its CSS, the outline integration in `ChatWindow.tsx`, `useHistoryNavigation.ts`; navigation library only where necessary.

Acceptance:

- Keyboard opens the rail, reaches anchors/page controls, activates unloaded anchors and closes the preview with predictable focus restoration.
- Changed history scope clears/replaces old outline and continuation, then reads the current outline. Ordinary appends within one scope do not restart outline paging.
- Obsolete scope/conversation/connection/lifetime responses cannot publish either success or failure over current state.
- Retry reaches a current coordinate after compaction. Target reads stay bounded without loading intermediate turns.

## R3 — Raw-history races and sidebar focus

Delivered in `96ffc28` / `11f84f9`: only the current raw-history block read publishes; closed sidebar content is inert and restores focus when needed. The reversed-response and hidden-Tab-stop defects are closed; R7 still owns combined acceptance.

Scope: `RawHistoryPanel.tsx`, `AppShell.tsx`, focused browser coverage.

Acceptance:

- Only the latest block request publishes success/error. Session/connection changes and unmount retire outstanding reads and stale block state.
- Collapsed/inactive sidebar content is inert. Closing with focus inside restores focus to a visible control; unrelated state changes do not steal focus.
- Mounted-component checks cover reversed successes, stale errors, session/connection replacement and desktop/narrow layouts.

## R4 — Image lease ownership

Synthetic repro: concurrent reads of one address create two URLs but retain one entry; disposal leaves one URL alive. Releasing the displaced lease can remove the newer entry under the same key. Trace real consumers before broadening the repair.

Scope: `packages/session/src/resources.ts` and resource behavior tests.

Acceptance:

- Concurrent reads preserve every live lease and accurate byte accounting.
- Releasing one lease cannot untrack/revoke another live image; disposal reclaims every URL owned by the reader.
- Preserve caller cancellation, independent leases, size limits and LRU semantics.
- Prefer the smallest ownership correction; add in-flight sharing only if required and compatible with per-caller cancellation.

## R5 — Compact running-state polling

Measured fixture: 1,000 sessions serialize to 548,648 B; the consumer keeps a 106 B projection. At 24 polls/minute this is 753.5 MiB/hour before compression. Parse/filter median: 0.584 ms. Actual HTTP/store cost and production catalogue size remain unmeasured.

Status: **delivered** in `ec7fd52` / `defdeed` / `9d86b31`. `ConversationApi.running()` directly reads
`GET /api/conversations?running=compact`; `catalogueRunning` accepts only `CompactRunningCatalogue`. Web and Backend
ship together; the full-catalogue fallback is removed. The existing catalogue owner still scans and projects rows using
`busy`; only the answer is smaller. `limit`/`cursor` beside the flag are refused by name; no new route, store or index.

Historical measurement at `36ba13d+dirty`, over real HTTP on an in-memory store, 1,000 sessions / two running (`node
apps/server/scripts/perf-running-poll.mjs`, 5 warmups + 25 samples per read, full round trip incl. `JSON.parse`):

| Read | Bytes | median | p95 | gzip | br |
| --- | --- | --- | --- | --- | --- |
| `GET /api/conversations` (what the poll used to pay) | 257,732 | 1.430 ms | 2.844 ms | 12,458 | 7,319 |
| `GET /api/conversations?running=compact` | 130 | 0.397 ms | 0.502 ms | 126 | 97 |

Raw log of that run: `/tmp/r5-running-poll-final.log` (fixture metadata line beside it). Timings vary run to run; the
byte counts, which are the claim, do not.

Reduction **99.95%**: 257,732 → 130 B per poll (**251.7 → 0.127 KiB**); **353.9 → 0.1785 MiB/hour** at 24 polls/minute. The compact answer states the
same running ids, list version, sidebar revision and projects revision as the full rows. Compression is reported
separately and is not applied by the Backend. The read is **not** constant-time: both shapes are O(sessions), and the
smaller answer is a bandwidth and client-parse saving only. This differs from the earlier 548,648 B fixture because that
payload was a synthetic catalogue built to the measured shape; these are real rows from a real Backend.

Scope: the current `/api/conversations` catalogue owner and connection-scoped `ConversationApi.running()`. Resolve a compact response at that seam; keep Backend authority and ingress routing.

Acceptance:

- Poll carries only running state and revision fields consumed by its callers; list reads retain their contract.
- Preserve running identities/status and session-list, project and sidebar revision invalidation.
- For 1,000 fixture sessions/two running conversations, reduce response bytes by at least 90% versus the measured full catalogue, with equivalent consumer behavior.
- Record before/after bytes and composed HTTP results, compression separately, plus median/p95. A smaller response alone does not establish constant-time server work.

## R6 — Measured rendering and recorded scan costs

Delivered in `91e9213` (stable preview callbacks and memoized rows) / `4fde598` (labels translated inside their memoized owners). No outline windowing was added.

Worker comparison: `04a14fc` → patch `79b9017569d4d14eb3376a8b4e133ec125d6fde9` (integrated as `91e9213`), Chromium 156 headless, 1280×800, nine samples per scene. These are historical fixture results, not a profile of `070ee50` or the deployed release:

- 40 pointer moves, 12 loaded previews: Markdown/parser/AssistantOutline calls **492 → 0**; initial hover still parses each preview once.
- 1,000 anchors / 50 loaded turns / long previews: median React commit sum **1,230.0 → 10.7 ms**; p95 frame gap **50.0 → 16.8 ms** (about 20 → 60 fps).
- `ChatMinimap` still commits 41 times; measured paged-outline DOM remains 8,184 nodes. More realistic long-list windowing remains unmeasured.

Evidence: main-workspace `.dev/worktrees/closeout-ssh-09/.dev/verify/perf-minimap-23d4f1e/stable-handlers.md`, matched `r2-before/` and `r2-after/` measurements/profiles. The worker summary records the comparison SHAs above; raw JSON retains the original `23d4f1e` source label. `4fde598` has no new timing claim here.

Nonblocking records:

- Outline with 50,000 tool records makes 501 page reads; injected JSON-decoding median is about 40–43 ms. Actual durable-store latency is unmeasured. Revisit on a slow normal history request or representative runtime/store evidence; no indexing migration is planned now.
- Transcript scrolling has linear geometry/key work. Synthetic 10,000-turn counts lack latency evidence. Revisit on measured long-scroll delay before adding geometry caches or binary search.

## R7 — Acceptance and release (delivered)

- Combined checks passed at clean `c2b69235872bde7404417bd795c180e88e390b40`: `bash .dev/review/lean-design-current/r7-browser.sh c2b6923 --with-acceptance`, exit 0, log `.dev/review/quality-next/r7.log`.
- Immutable release built on workstation with `node scripts/build-client-runtime.mjs --json=.dev/deploy/quality-next/build.json`, exit 0; release `/home/developer/.local/share/hepi/client/release-c2b6923`, backend image `hepi-backend:c2b6923-workstation`, image ID `sha256:8f0f9c827b31a53642a43917956e4f0b62816f94caa574d815c8ba777e72c809`.
- Backend, Gateway and ingress switched successfully. Actual origin smoke passed with 16 conversations and 6 models; desktop/mobile Chromium login, descriptor, conversation and logout passed with no page errors; four workspaces rehydrated with zero host errors. Evidence: `.dev/deploy/quality-next/`.
- Sidebar Q2 is recorded as inconclusive for PERF-02's live-only trigger: committed catalogue changes caused one follow-up per invalidation, stable polls carried 121 B with zero follow-ups, and the paced live-only stream did not remain open. No source fix justified; evidence `.dev/review/quality-next/sidebar/README.md`.

- Retry recovery rendering an empty transcript is fixed and integrated as `9b88584`; reviewed with no material findings. Corrected evidence is integrated through `6ecf123`. Coordinator reran `node apps/web/e2e/ux-closeout-accessibility.mjs` on clean `6ecf123`: exit 0, 28/28 checks. The combined R7 run then passed keyboard/focus, narrow Web, error recovery, Chinese IME and bounded-history journeys on `c2b6923`; unmeasured App/assistive-technology journeys stay explicit.
- Client-app 22 is reconciled against integrated fixes and supported-platform observations. The 390×844 result is a Chromium viewport; mobile platform, Android and real upstream OAuth remain named limits.
- Preserve completed native-save evidence: `cc772ec`, two 37/37 packaged debug runs. Repeat affected journeys only when later changes invalidate that evidence.
- Workers run focused red/green checks and `pnpm verify:changed --base=<actual-base>`. Coordinator checks the merged revision, reviews material corrections once, and updates owning guides for changed contracts.
- Keep ordinary Gateway/Server suites within the five-second goal. Historical 1.53–1.59s / 3.71–4.02s results are dated evidence, not fresh results for the repaired revision.
- Every claimed check names exact command, tested SHA/dirty state, exit and raw-log path. Distinguish browser, injected computation, real HTTP/store, packaged and deployed results.
- Build on workstation through existing packaging. Rust uses debug, six jobs, incremental and shared target; native tests isolate host keyring credentials.
- Historical deployment inspection: ingress `3d15c86`, gateway/backend `2c28d1c`. Coordinator must inspect the actual origin again, align services to the final release and verify health, entrance and affected authenticated flows before closing R7.
- Provider live upstream OAuth and deployed environment-mode credential/store mismatch remain explicit limits. This plan does not change credential ownership or runtime mode. Android, live watch, push, skill deletion and other parked capabilities retain their recorded disposition.

## Evidence

UI audit: main-workspace `.dev/verify/uiux-audit-23d4f1e/read-races.log` and `browser.log`; Chromium fixtures, exit 0.

Integrated subtree verification: `pnpm verify:changed --base=294787e`, clean `e4de965`, exit 0. Typecheck, 359/359 tests (Node duration 3.982s) and documentation checks all pass; 447 Markdown files, zero broken links. Report: `.dev/verify/2026-10-20T14-21-01-657-verify-changed/verify.json`. The worker checkout's three broken links are confined to its preexisting untracked dock spec and are absent on main.

Performance command: `node /tmp/closeout-poll-outline-23d4f1e.mjs > /tmp/closeout-poll-outline-23d4f1e.log 2>&1`; exit 0, 2.7s wall time. Catalogue: five warmups, 25 batches of 20 calls. Outline: three warmups, 15 samples. Injected measurements use no network or SQLite.

Resource repro: `/tmp/closeout-performance-resources-23d4f1e.mjs` and `.log`, exit 0. Preserve raw temporary artifacts with final repair reports before cleanup.
