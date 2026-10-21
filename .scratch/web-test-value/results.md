# High-value Web tests — accepted result

Historical142-test result. The later user-requested [further reduction](../web-test-lean3/results.md) is the current measured result; this report retains its original tested source and counts.

Completed2026-10-15 on dirty integration/architecture-unification, HEAD1758c1fb4479e9d4637a957857246c5998619d73. User requested fewer than200 tests, primarily high-value checks, with substantially less code. The unchanged recursive entrypoint `pnpm test:web:unit --quiet --log-dir=.dev/verify/web-test-value/accepted` exited0: **142 tests,142pass,0fail,0cancelled,0skipped,0todo across69 files**.

| Measure | Before this pass | Accepted | Reduction |
| --- | ---: | ---: | ---: |
| Actual Node tests |461|142|319 (69.2%)|
| Test files |239|69|170 (71.1%)|
| Physical test lines |33303|7097|26206 (78.7%)|
| Test bytes |1605634|369090|1236544 (77.0%)|

Measurements compare saved working-tree bytes against this pass, not Git HEAD or the earlier2381-test source. Lines count newline-delimited source lines, without a trailing empty segment. Actual tests come from Node TAP, not static source matches (148).

## Retained value and intentional cuts

Keep failure/recovery checks for stale lifecycle views, request-ID recovery without duplicate send, queue/history ownership, complete deferred originals and attachments, cross-host refusal, auth/origin/path/secret boundaries, upload conflict/limits, terminal cleanup and transcript navigation. Keep actual composer callbacks and paired tool/error output. Each retained contract samples useful positive/negative behavior; it does not enumerate every historical representation.

Retired component style/prose/DOM-string/source-shape inventories, low-risk preferences/formatters, duplicate helper coverage, SDK internals, routine CRUD forwarding permutations and dormant copied implementations. Parent additionally removed six dormant Settings suites after checking current import/call sites: old mcp-add implementation, old transport factory, provider usage, push publisher and Web subagent input/profile runtime. Current gateway/parser/producer/auth checks remain. These cuts intentionally reduce coverage; no equivalent replacement is claimed for retired dormant or low-priority behavior.

| Owner | Before files | Final files | Actual retained contracts |
| --- | ---: | ---: | ---: |
| [UI](ui-report.md) |49|10|23|
| [State/lifecycle](state-report.md) |46|20|50|
| [Settings](settings-report.md) |37|4|9|
| [Integration](integration-report.md) |107|35|60|

All239 original paths have dispositions; no new unowned test files or discovery exclusions. Existing related contracts use concise labelled rows/scoped assertions, with awaited async fixtures. No count collectors, nested subtest tricks, disabled tests or empty test files.

## Verification and source boundary

- Raw accepted output and exact command/source metadata: `.dev/verify/web-test-value/accepted/web-unit.tap` and `web-unit.json`; exit0.
- Immediately-before-test source snapshot: `.dev/verify/web-test-value/after-source.json`, sourceHash `67fb9d2b78b852b7cc1bd0a3e4980d0ec775134af5437dd70da9921ab45e6bec`. Later edits affect documentation/derived artifacts only.
- Original239 source files: `.dev/verify/web-test-value/before/`; final per-file hashes/metrics: `inventory-after.json`; source/disposition audit: `audit.json`; measured totals: `summary.json`; task-only test patch: `test-changes.patch`.
- Product implementation, vendor files, dependencies and recursive discovery/runner bytes are unchanged. The only package changes migrate explicit test:skills and test:upstream target lists after genuine retirement; browser/smoke commands remain. Audit checks all other package fields unchanged.
- Prior runtime workspace and48 production windowing plus11 history-prefix browser checks are reused against unchanged implementation. No fresh browser/build/deploy result is claimed. Worker fixture mistakes were repaired and tested at affected seams; the final root run independently passed all retained tests.

Independent Standards/Spec review found one weakened stale-frame fixture; restoring its active run payload closed the finding. Focused hook8/8 passed; no material findings remain. Review and documentation/entrypoint/diff checks are recorded in [review.md](review.md). Docs253files passed with zero broken links/unindexed guides; entrypoints60present and two recorded pre-existing missing browser scripts, zero new missing targets; final diff check passed. Default graph refreshed10559nodes20749edges455communities; deep graph remains frozen. No commit, production deployment or service restart.
