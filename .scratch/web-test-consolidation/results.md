# Web test consolidation — accepted result

Completed2026-10-15 on dirty integration/architecture-unification, HEAD1758c1fb4479e9d4637a957857246c5998619d73. Final unchanged recursive entrypoint `pnpm test:web:unit --quiet --log-dir=.dev/verify/web-test-consolidation/accepted` exited0: **239 files,461 tests,461pass,0fail,0cancelled,0skipped,0todo**. No test discovery, default scripts, product or vendor source changed for this task.

## Measured result

| Measure | Before | After |
| --- | ---: | ---: |
| Actual recursive Node tests |2381|461|
| Pass / fail |2365 /16|461 /0|
| Files discovered |281|239|
| Skipped tests |0|0|

Actual registered tests decreased1920 (80.6%);42 original files were removed after merging or retirement. The before runner is `.dev/verify/architecture-unification/final-reading-web-unit.log`; this is comparison of recorded working-tree runs, not detached clean revisions or a claim of equivalent coverage. Before2573 and after477 source-call matches are estimates and are not Node counts.

| Ownership | Original files | Final files | Final Node contracts |
| --- | ---: | ---: | ---: |
| UI |71|49|120|
| State/lifecycle |50|46|105|
| Settings/MCP/models |52|37|81|
| Adapter/integration/helpers |108|107|155|

Every original path has a purpose, disposition and merge destination in [UI](ui-report.md), [State](state-report.md), [Settings](settings-report.md), or [Integration](integration-report.md). All281 dispositions were checked. Settings initially had80 tests; isolating its symlink privilege skip added one independent contract. Its four affected files passed18 tests, and the final recursive run includes the corrected81.

## What changed

Related assertions now share named behavioral contracts and labelled input rows, preserving fixture isolation and awaited asynchronous checks. Removed low-value styling/source-shape inventories, redundant cases, SDK-owned implementation assertions and tests for absent copied launchers, Web model runtime and proxy. The original16 failures are [diagnosed separately](known-failures.md); unsupported provider discover/API-key requests now assert501 unsupported at the current durableApi seam. Provider capabilities were not implemented by retiring stale tests.

Material retained seams include lifecycle revision acceptance/idempotency/queues/history, deferred original text and image bytes, message/tool pairing and expanded Code mode results, composer dispatch locks and fallback/attachments, cross-host identity/refusal, origin/path/secret boundaries, upload limits and terminal lifecycle. Detailed reports explicitly identify removed scenarios without an equivalent replacement. Browser coverage is not inferred from passing source checks or reduced counts.

## Review and verification

[Standards/Spec review](review.md) found8 material coverage losses across Settings and UI. All corrected inside owning contract matrices; symlink skips were isolated in their own test. State and integration had no material findings. An intermediate restoration imported a helper from the wrong owner; corrected to its original module before final acceptance. No material findings remain.

- Accepted raw TAP and metadata: `.dev/verify/web-test-consolidation/accepted/web-unit.tap` and `web-unit.json`.
- Immediately-before-test source snapshot: `.dev/verify/web-test-consolidation/final-source.json`, sourceHash `9e024ac4babd523066ed74ac600e9db2ad095d1af559f275c146f82132e061eb`. Later edits are documentation/derived artifacts.
- Original281 files were backed up byte-for-byte under `.dev/verify/web-test-consolidation/before/`. Task-only test patch: `.dev/verify/web-test-consolidation/test-changes.patch`; hash ledger: `test-source-hashes.json`; consolidated measurement: `summary.json`.
- Source comparison against the completed architecture snapshot found zero non-test/non-document changes. Product/package/discovery/runner bytes remain identical; prior48 production windowing and11 history-prefix browser checks and workspace verification are reused for that unchanged source.
- Disposition audit: `.dev/verify/web-test-consolidation/disposition-audit.json`, no unaccounted original paths.

Documentation and entrypoint checks passed, dispositions are complete, and the coordinator refreshed the default graph. Final diff check passed after whitespace cleanup on four blank lines. The final recursive runner was repeated against that exact snapshot and passed461/461 with zero skips. Docs:246 Markdown files, zero broken links or unindexed guides. Entrypoints:66 present, two recorded pre-existing missing browser scripts, zero newly missing. Default graph:11286nodes22079edges526communities. Deep graph remains frozen. No commit, production deployment or service restart was performed.
