# Docs fixes — audit priorities 1–2 (documentation half)

Baseline: master `1758c1fb4479e9d4637a957857246c5998619d73`, shared dirty workspace (other workers' edits present).
Documentation only: no source, test or deployment change; no commit, push, stash or reset. Original audit
[2026-10-14.md](2026-10-14.md) is the pre-change historical evidence.

## Changes

| File | Change | Reason / evidence |
| --- | --- | --- |
| `docs/architecture.md` | Protocol boundary and Submission lifecycle now state the delivered delta frames: one snapshot, then `baseRevision` + `appended` with full scalars and window bookkeeping, applied only on an exact base match. Execution section names the browser terminal's real PTY (`pty.fork`) and scopes the unsupported part to the pi-gui desktop `ExecutionEnv`. Current-subset section moves workspace file upload and binary preview/download out of "unimplemented". | `apps/server/src/server.ts` (`ServerDelta`, `continuationIndex`, delta build), `docs/chat.md` "After the baseline…", `packages/gateway/src/terminal.ts:118` (`pty.fork()`), `packages/gateway/src/index.ts:954-960` and `apps/server/src/file-relay.ts` (file payload routes). |
| `docs/migration-status.md` | The "~300 s idle SSE teardown" note is recorded at the diagnosis's revision, not a current gap: the delivered heartbeat (perf tickets 01/02, same file) keeps a quiet conversation stream alive. Scope paragraph lists the pi-gui `ExecutionEnv` interface as unsupported while the browser terminal runs a real PTY. | Same section already documents the delivered heartbeat; `packages/gateway/src/terminal.ts`. |
| `docs/README.md` | Historical-evidence bullet reads the 300 s teardown as dated evidence; added the retired demo evidence, the preserved demo and the initial project prompt to the index. | `docs/archive/README.md`, `docs/archive/durable-harness-demo.md`, `docs/prompts/PI_DURABLE_HARNESS_AGENT_PROMPT.md`; `pnpm check:docs` uncovered-guide report. |
| `apps/web/README.md` | Workspace *file* upload is no longer described as unsupported; upload and binary preview/download leave the 501 list; the implemented file payload routes are named. | `packages/gateway/src/index.ts`, `apps/server/src/file-relay.ts`, `docs/migration-status.md`. Provider/auth and `/api/web-auth` wording left untouched for the Settings worker's parent integration. |
| `.scratch/README.md` | Indexed perf-follow-up, files transfer and the development audit (audit, follow-up, web-test logs). | `docs/README.md` is the current-behaviour index; scratch rows point at each effort's record. |
| `.scratch/perf-follow-up/DESIGN-memo.md`, `.scratch/perf-follow-up/decisions.md` | The 13 dead links to sibling worktrees are replaced: the lane records are named for provenance (worktree + revision) without a link, their retained findings link the in-repo research notes and `evidence/README.md`/`evidence/terminal-pool-probe.json`, and the governing decisions point at local `docs/adr/0007`, `docs/adr/0006` and `docs/chat.md`. | The sibling worktrees (`perf-lane-c`, `perf-lane-b`, `chat-lifecycle-integration`) are not in this checkout; provenance is preserved, no missing evidence is invented. |

## Evidence

- `pnpm check:docs --json=.dev/verify/docs-fixes.json` — revision `1758c1f`, dirty workspace, exit `0`; 184 Markdown
  files, **0 broken relative links, 0 guides missing from the index**. Raw log: `.dev/verify/docs-fixes.json`
  (git-ignored).
- Before the change the same command reported 183 files, 13 broken links and 3 uncovered guides (see
  [2026-10-14.md](2026-10-14.md) "本次验证").

## Remaining limits

- Settings/logout wording (`apps/web/README.md` settings routes, `docs/migration-status.md` "Still open") is left for
  the parent to integrate after the Settings worker's result; this record does not claim that capability.
- `features-research.md` and `performance-research.md` do not exist yet and are deliberately not linked, so the index
  stays deadlink-free.
- Source/test fixes (client Worktree assembly, Web test-shape drift, container probe) belong to the other workers; no
  document here asserts a future implemented feature.
