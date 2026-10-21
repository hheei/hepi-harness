# High-value Web test pass

User-authorized second reduction: fewer than200 actual recursive Node tests and substantially less test code. Previous measured working tree:239 files,461 pass/0fail/0skip; evidence `.dev/verify/web-test-value/before-web-unit.json`. Current source is dirty integration/architecture-unification at1758c1f. This is not a clean-revision baseline comparison.

Keep tests for costly, plausible user failures: lost or stale conversation state, admission/idempotency/queue recovery, incomplete message originals/attachments, cross-host execution mistakes, auth/origin/path/secret boundaries, upload limits, terminal cleanup and transcript navigation. Remove low-value presentation/source-shape inventories, duplicate helper coverage and dormant or SDK-owned behavior. Historical coverage need not be preserved wholesale. Do not merge unrelated domains merely to lower the counter.

| Owner | Original files | Test budget | Preferred test lines |
| --- | ---: | ---: | ---: |
| UI |49|35|2200|
| State/lifecycle |46|55|6500|
| Settings |37|40|2800|
| Integration |107|60|4500|

Ownership manifests partition all239 paths. Workers change their tests only, report every path disposition and run their actual remaining list. Parent owns explicit package-script target migration, final unchanged recursive discovery, source invariant audit, independent material review, owning guide and default graph refresh. No product implementation, vendor, discovery filters, browser fixtures or services change. Reuse prior runtime verification for unchanged source.

Accepted output: [results.md](results.md),142pass/0fail/0skip across69files. Test code33303→7097lines. Per-group reports record all239 dispositions; raw evidence is under `.dev/verify/web-test-value/`.
