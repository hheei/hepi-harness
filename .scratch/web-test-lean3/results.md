# Further Web test compression

Accepted2026-10-15 on dirty integration/architecture-unification, HEAD1758c1fb4479e9d4637a957857246c5998619d73. User requested another reduction in test count and code volume. Compared with the saved142-test working tree, not Git HEAD:

| Measure | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Actual Node tests |142|111|31 (21.8%)|
| Files |69|64|5|
| Physical test lines |7097|4445|2652 (37.4%)|
| Test bytes |369090|238204|130886 (35.5%)|

The unchanged recursive command `pnpm test:web:unit --quiet --log-dir=.dev/verify/web-test-lean3/accepted` exited0: **111pass,0fail,0cancelled,0skipped,0todo across64files**. Raw TAP and command/source metadata: `.dev/verify/web-test-lean3/accepted/web-unit.tap` and `web-unit.json`. Immediately-before-run sourceHash: `755cbbbafd551b6f99cae5efeeaac1f1ee25b0b8fd2a99059857396fc8356d6c`. Later changes affect documents and derived graph only.

## Concrete cuts

- UI: unread markers now have one real source-effect flow; file viewing one revision-fenced transition; OAuth one submission/IME contract. Retire hint/class/PDF/alternate-key variants and synthetic clear/restore simulation. Real composer locks, owned commands, attachments and draft identity remain.10files20tests622lines.
- State: replace repeated reconnect, transcript, prefix, navigation and scroll fixtures with focused flows. Deferred text checks exact originals, deduplication, order, refusal and retry in one scenario. Remove duplicate lifecycle-acquisition helper suite; actual hook remains byte-for-byte326lines, including coherent stale busy-run payload.19files38tests1254lines.
- Integration: remove repeated adapter/backend fixtures; keep identity/acquisition/delta recovery, project ownership, dirty-worktree refusal, actual uploads and real remote deletion. Simplify terminal fan-in and origin/cache guards. Retire inactive output/link/text helpers and old Web command environment tests; sanitizer is only invoked by the inactive Web MCP transport factory.31files44tests2305lines.
- Settings: retain all four short active importer/secret/auth suites unchanged,9tests264lines.

Deleted: `lib/bash-output.test.mjs`, `lib/lifecycle-acquisition.test.mjs`, `lib/linked-directory.test.mjs`, `lib/project-command-env.test.mjs`, `lib/text-preview.test.mjs`. The acquisition checks have stronger hook/projection owners; other four cover inactive Web runtime helpers. No equivalent replacement is claimed for retired inactive code. Also intentionally retire cache-eviction internals, unavailable push permutations and low-priority storage/routing variants; this reduces historical coverage.

## Review and source boundary

Independent Standards/Spec reviews found one weakened retained assertion: streaming immutability compared against state preceding the start event. Corrected each delta to compare immediate input/output state/content identities and a cloned prior-content value. Focused1/1 passed; reviewer confirmed closure. UI and seven integration fixtures had no material findings. No remaining material findings in supplied scopes. No broader product review or new runtime behavior.

Product implementation, vendor, dependencies, package scripts, recursive discovery and runner are unchanged. Audit reports zero unexpected product changes and zero new source/test files. Existing runtime/browser checks are reused; no new browser/build/deploy result claimed. Source backups, per-file hashes, task-only patch, metrics, accepted command metadata and per-group dispositions are under `.dev/verify/web-test-lean3/` (`before/`, `after.json`, `test-changes.patch`, `summary.json`, `{ui,state,integration}-report.md`). Earlier state/integration worker measurements precede the coordinator assertion correction and final dormant-test deletion; this accepted recursive run is authoritative.

Owning guide updated. Docs, entrypoint and diff checks exited 0 on dirty1758c1f; entrypoint check retains its two pre-existing missing scripts, with zero newly missing. Raw logs use the same evidence directory. Default graph refreshed:10496 nodes,20707 edges,460 communities. Deep graph unchanged. No commit, deployment or service restart.
