# Next batch after quality review — 2026-10-21

Status: complete (2026-10-21); implementation, focused measurements, combined acceptance and deployment are recorded below.
Reviewed revision: `c5287dbb33354593fca413d4020878e2e5206269`; OCR base: `36ba13dc3db895bb297e9528a660ab27039828cd`.

## Review result

OCR delegate review covered 97/97 selected files: Core 26, UI/Session 47, Platform/CI 24; zero skipped. The selector excluded 57 other changed files, including documentation and tests; six excluded fixture compositions were checked separately. This is complete coverage of the selected review set, supplemented by hot-path performance and lean-design audits, not an exhaustive correctness proof of every repository file. No delivery-blocking finding was established.

Evidence is local under `.dev/review/quality-c5287db/`: `core-review.{md,json}`, `ui-review.{md,json}`, `platform-review.{md,json}`, `performance.{md,json}`, `ponytail.{md,json}`. Preserve these artifacts when cleaning worktrees.

- Core record: overlapping saves with 2,000 models reproduced disk/live-runtime divergence in 6/10 authenticated HTTP trials; 100/200/400-model probes did not reproduce it. Both saves may report `applied:true`. Ordinary incident frequency and downstream model-request effect remain unknown. Keep last-write-wins; revisit after an incident, stronger normal-use evidence, or explicit prioritization.
- Performance: live-only frames recreate unchanged assistant identities. A pure-function probe changed all 25 assistant refs in a 50-message window; 10,000 synthetic prefix messages cost median 2.83 ms / p95 4.26 ms, excluding React, Markdown and DOM. No measured material user delay established.
- Lean: two P3 cuts, estimated 76 lines combined, with no current production caller for the removed behavior. Estimates include legacy-only tests.

## Work order

### Q1 — Combined acceptance and immutable deployment — complete

Priority: first operational closeout. Owner: [client-app 22](../client-app/issues/22-ux-system-acceptance.md), [deployment runbook](../../docs/deployment-runbook.md).

1. Pin the final clean source SHA. Reuse passing checks against unchanged source; run outstanding R7 browser journeys and bounded history acceptance. Existing driver: `.dev/review/lean-design-current/r7-browser.sh`; inspect its actual flags before invoking. Two focused rail/scope drivers already passed at the reviewed SHA.
2. Build the immutable release on workstation through the established runtime builder. Existing prepared deployment reference: `.dev/review/lean-design-current/prepare-deploy/PREPARED-DEPLOY.md`; current runbook is authoritative.
3. Align backend, execution Gateway and ingress to the prepared release, following routine service order. Read-only unit inspection currently names ingress `release-3d15c86`, Gateway `release-2c28d1c`, backend `hepi-backend:2c28d1c-workstation`; these are configured targets, not proof of running process/artifact identity.
4. Verify actual origin: entrance/login, authenticated descriptor/models/conversation reads, affected browser journeys, service health and loaded artifact identity. Update ticket 22 with exact SHA, command, exit code and raw-log paths.

Done: required journeys accounted for, all three services verified against intended artifacts, ticket 22 reconciled honestly. Provider live OAuth and parked capabilities keep their documented limits. Native tests are reused when unchanged. Release evidence is under `.dev/deploy/quality-next/`.

### Q2 — Measure composed sidebar polling during streaming — recorded

Priority: one focused investigation, parallel with acceptance preparation. Owning source: `packages/ui/src/components/SessionSidebar.tsx:685`, `apps/server/src/catalogue-binding.ts:79`, and the existing catalogue publication seam.

Mount the actual sidebar with one representative catalogue size. Keep committed messages/sidebar rows fixed while live scalars advance. Count compact and unpaged full-catalogue requests, total response bytes per poll cycle and list-refresh duration. A 1,000-row source-function probe already proves that revision-only changes invalidate the list despite identical sidebar projections; actual composed HTTP cost remains unmeasured.

Done: pinned real HTTP trace recorded no material ordinary-use failure, but did not establish the live-only stream invariant because the paced run settled early. Committed changes caused one full follow-up per invalidation; stable polls were 121 B with zero follow-ups. No repair or second cache/index added. Evidence: `.dev/review/quality-next/sidebar/README.md`.

### Q3 — Small independent lean cuts

Priority: optional P3 cleanup; does not block deployment. Two independent changes:

- `packages/ui/src/lib/conversation-api.ts:192`: remove test-only `history()` and `HistoryPage`; migrate its sole HTTP assertion to existing `historyPage()`. Estimated -14 production lines. Check conversation API HTTP seam and UI typecheck.
- `packages/session/src/index.ts:200` and `packages/protocol/src/index.ts`: remove orphan legacy `events` batch fold/types and legacy-only fixtures. Preserve native snapshot/state/delta/resync behavior and diagnostic DurableSession. Estimated -28 production / -34 test lines. Check session reducer/delta/window behavior.

Done: current workspace references checked, existing behavior verified at those seams, diff contains only the cuts. External direct legacy protocol consumers were not audited; confirm package exposure before removing exported types.

### Q4 — Reconcile status and operational evidence

Priority: small maintenance; can run independently.

- [SSH 09](../ssh-remote-workbench/issues/09-file-failure-and-preview-feedback.md): replace stale pending-integration status with integrated delivery evidence.
- [MCP 03b](../mcp-conversation-tools/issues/03b-durable-grant.md): replace `ready-for-agent` with integrated status (`c070e7e`, covered by MCP 05).
- [Client-app 17](../client-app/issues/17-retire-next-and-transition-paths.md): reconcile completed Next manifest/type residue cleanup (`cc772ec`) with header and checklist.
- [Pi configuration guide](../../docs/pi-config.md): remove obsolete promise-chain serialization claim at line 83. Describe atomic file replacement/last-write-wins and the recorded overlapping-refresh limitation without claiming an implementation guarantee that source lacks.
- [CI evidence](../../docs/ci.md): observe an ordinary push/PR hosted run, retain run URL/head SHA, six job conclusions/durations and artifacts. Record real apt/toolchain failures only when observed; verify cache restore/save on a later ordinary run. Current workflow has no manual dispatch.
- Graph maintenance after source/docs freeze: refresh AST once, reuse 21 existing semantic chunks, apply relevant document deltas and assemble the deep graph. Existing `deep-validation.json` says `ready` with `health: pending`; the published deep graph exists but dates to 2026-10-14 and remains stale. Inspect `build-deep.py` required flags (`--ast`, `--semantic-dir`, `--final-sha`) and validate provenance/health before publishing. External semantic extraction need not be repeated.

Done: headers agree with source/checklists; docs describe delivered behavior; hosted CI and graph freshness have explicit evidence or remain accurately marked pending. Source-only graph results retain AST/semantic provenance.

## Verification already available

All below target clean `c5287dbb33354593fca413d4020878e2e5206269`; local evidence under `.dev/review/quality-c5287db/` unless stated otherwise.

| Command | Result | Raw evidence |
| --- | --- | --- |
| `node --test apps/app/test/shell.test.mjs apps/app/test/save-host.test.mjs apps/app/test/host-config.test.mjs` | exit 0; 9/9 | `platform-app-seams.log` and JSON provenance |
| `node apps/web/e2e/ux-rail-keyboard.mjs` | exit 0; PASS | `ui-browser-0.log`, `ui-review.json` |
| `node apps/web/e2e/ux-history-scope.mjs` | exit 0; PASS | `ui-browser-1.log`, `ui-review.json` |
| `pnpm check:entrypoints` | exit 0; 162 present, zero missing | `entrypoints.log` |
| `pnpm verify:changed --base=870908c651723a6fc5ec23c598e84edd37aaeb65` | reused; selected steps exit 0 | `.dev/verify/2026-10-20T16-18-18-951-verify-changed/verify.json` |

Committed-snapshot documentation checks passed at OCR base and tip; commands/logs are in `platform-docs-evidence.json`. Performance probes are pure/source-function measurements, not deployed acceptance. This plan alone does not require rerunning product tests.

## Parked

Subtree abort/outcome atomicity needs runtime receipt semantics; existing per-child progress persistence remains delivered. Live upstream OAuth needs external credentials. Android, push, live watch, skills uninstall, session export and global dock retain existing parked status. None becomes a new implementation ticket through this review.
