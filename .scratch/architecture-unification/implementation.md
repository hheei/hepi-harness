# Implementation frontier

Branch: `integration/architecture-unification`; shared checkout retains approved pre-existing dirty fixes. [Spec](spec.md), [tickets](ticket-breakdown.md), [source ownership](navigation.md).

| Owner | Tickets | Assigned work |
| --- | --- | --- |
| agent-34 | 01 → 06 | 01/06 done。01：protocol45/session20/server285 + coordinatorAdapter41。06：focused155（扩展集184）；全 Web 18 fail 为该源码状态观察值，其中 3 处本票断言漂移已修（其余 sibling 在飞）。证据 `.dev/ticket01/RESULTS-01.md`、`RESULTS-06.md` |
| agent-36 | 02 | done；shared startup + installed CLI6/standalone Local+SSH4/startup6通过 |
| agent-35 | 03 → 04 | done；有界同步终端writer/线性capture，Gateway184通过；fixture-host throughput不冒称PTY实测 |
| agent-38 | 05 | Done；public cache13/prefix8/workspace12/lifecycle20 + Web typecheck 通过；integrated browser 待11 |
| agent-39 | 07 | done；能力unknown/unsupported区分、trust只读，unit289/browser15/typecheck通过 |
| agent-37 | 08 → 09 → 10 | done；production窗口unit70/fixture68/real-app20，prepend/异步高度/search通过 |
| coordinator | 11 | Integration, evidence, two-axis review, docs/graph |

Ticket10 waits for06 and09. Workers report automatically; coordinator steers ownership/Interface gaps and handles final shared checks. Ticket status lives in individual issue, not this assignment table.

06 interface for ticket10 (stable): `apps/web/lib/lifecycle-acquisition.ts` exports `httpStatement`/`sseStatement`/`submissionStatement`/`unavailableStatement`/`receiveAccepted`/`nextAcquisition`/`StatementReceipt`, plus the retained observation builders. `AcceptedStatement<TSession>` carries `facts`; `receiveAccepted` reports `accepted` (= `Step.snapshotAccepted`) and the hook's `receive()` is the single publisher of the accepted history. History/scroll ownership is unchanged: loaded history, cursors, prefix and view cache in the hook; viewport/overscan/mounted turns, anchors, tail intent and search/minimap reveal in ChatWindow plus the turn model.

Planning check: `pnpm check:docs --json=.dev/verify/architecture-unification-docs-start.json`, exit0,232 Markdown files,0 broken relative links/0 missing indexed guides. Tested HEAD `1758c1fb4479e9d4637a957857246c5998619d73` with dirty planning/source tree.

Plan-publication source manifest: `.dev/verify/architecture-unification/plan-published-source.json`; source hash `75ee5118f77d4486d875e9d55f7bf6a41dc063ea625c5ae85ab200779c4c5f68`. This is a timestamped manifest, not a clean HEAD or immutable build.

Fingerprint helper scopeVersion2 also includes root package/lock/workspace/TypeScript configuration and standards references. Earlier plan-publication manifest omitted those root files and was captured after worker kickoff; use it as a checkpoint/scope aid, not a complete immutable pre-implementation baseline. Final review covers all ticket-owned paths even if an early edit preceded that checkpoint.

Known Web failure names come from `.dev/verify/design-fixes/verify-changed.log` (16 exact names). Subsequent comparison must state whether it is observed-known-set accounting or a fresh pinned two-revision comparison; never substitute a same-count claim. Source snapshots/comparison helper: `.dev/verify/architecture-unification-evidence.mjs`. Pre-integration observed-known comparison of `.dev/ticket06/web-unit-2/web-unit.tap`:16 reference names/18 current names, only new names are turn-description renderer source guard and negative-scroll adjustment; no resolved names. Those two belong to in-flight10. Record `.dev/verify/architecture-unification/pre-integration-known-set.json`; this is not final-current or pinned two-revision evidence.

Adapter合同验收：coordinator已替换01迁移引起的旧局部类型声明断言，用真实HTTP模型缺省/SSE资源loaded与failed行为验证。最终bash-24 exit0,41/41；记录 `.dev/verify/architecture-unification/adapter-contract-check.md`。途中自身新增测试用了不存在的agent路由，已修正，不为此修改产品。

No deployment/restart/publishing. Final delivery requires completed behavior and material review findings resolved, beyond this planning check.
