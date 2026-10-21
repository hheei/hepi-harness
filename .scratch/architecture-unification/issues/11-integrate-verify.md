# 11: 统一实现整合、验证与旧路径收缩

> **Evidence location.** `.dev/verify/...` paths here are local, git-ignored logs from the 2026-10-14 working-tree
> acceptance, not tracked files; the commands, exits and counts each row states are the durable record. Current entrypoints are
> [verification](../../../docs/verification.md).
**What to build:** 操作者和维护者获得已验证、文档一致的新实现，Local/SSH 编码工作流保持；被替代双轨删除。

**Blocked by:** 02, 03, 04, 05, 07, 10

**Status:** done — 2026-10-15 UTC

**Spec:** [统一设计](../spec.md) · [审查](../review.md) · [非阻塞记录](../review-notes.md) · [复盘](../retro.md)

## Acceptance

- [x] 全11票交付；九方案映射见下表；旧 frame、queue、装配、发布、visibleCount 和 Web trust mutation 路径按 owning tickets 收缩。
- [x] 共享编辑按 owner 整合，材料性审查发现修复；Standards/Spec 保持分轴记录。
- [x] workspace typecheck/tests、script tests、entrypoints 完成；最终 Web 失败逐名记账，无新增。
- [x] installed Local/SSH CLI、terminal 慢读恢复、production browser 导航与 prefix/reconnect 验收完成。
- [x] 源码清单、command/exit/raw logs 可复核；owning guides 和 migration limits 已更新。
- [x] 默认 graph 最终整合更新；deep 图保持历史版本。
- [x] 保留未部署、未发布的任务范围；性能观察与功能验收、DOM 边界与 heap 边界分别记录。

## 九方案映射

| 方案 | Owning ticket | Evidence |
| --- | --- | --- |
| 公共投影帧 | 01 | protocol/session/server tests |
| 单一 Gateway 装配 | 02 | installed Local/SSH smoke6/6 |
| terminal 背压 | 03 | gateway slow-reader disconnect/replay tests |
| 线性输出捕获 | 04 | OutputCapture tests；非完整系统吞吐结论 |
| 缓存计量 | 05 | incremental totals/eviction tests |
| accepted beside state | 06 | lifecycle acceptance/queue tests |
| 如实能力与只读 trust | 07 | route/UI tests 与已记录 browser checks |
| turn 描述与 renderer | 08 | pairing/identity tests |
| 动态窗口与生产挂载 | 09/10 | production48 checks + prefix/reconnect11 checks |

## Final source and evidence

Source: HEAD1758c1fb4479e9d4637a957857246c5998619d73, dirty `integration/architecture-unification`. Final manifest: `.dev/verify/architecture-unification/completed-source.json`. This is working-tree acceptance, not a fresh pinned two-revision benchmark. All paths below are repository-relative.

| Command | Exit | Raw evidence |
| --- | --- | --- |
| `pnpm --filter @hepi/web build` | 0 | `.dev/verify/2026-10-14-ticket10/build-reading-view.log` |
| `node apps/web/e2e/ux-windowed-transcript.mjs` | 0;48/48 | `.dev/verify/2026-10-14-ticket10/real-app-reading-view.log` |
| `node apps/web/e2e/ux-history-prefix.mjs` | 0;11/11 | `.dev/verify/2026-10-14-ticket10/history-prefix-reading-view.log` |
| `pnpm verify:changed` | 1; final test correction followed by Web-only rerun below | `.dev/verify/2026-10-15T01-10-03-084-verify-changed/verify.json` |
| `pnpm test:web:unit` | 1;2381 tests,2365pass/16 known failures | `.dev/verify/architecture-unification/final-reading-web-unit.log`; runner report `.dev/verify/2026-10-15T01-13-25-562-web-unit/web-unit.json` |
| exact-name `compare-known` against `.dev/verify/design-fixes/verify-changed.log` | 0;16 names identical,0 new | `.dev/verify/architecture-unification/final-reading-known-set.json` |
| `pnpm check:docs` and `pnpm check:entrypoints` | 0 | `.dev/verify/architecture-unification/completion-checks.log` |
| `git diff --check` | 0 | coordinator check; no whitespace findings |
| `graphify update .` | 0 | `.dev/verify/architecture-unification/completed-graph-update.log` |

The changed run passed workspace-typecheck, workspace-tests, script-tests, check-entrypoints and check-docs. Web initially had one newly stale source assertion requiring an argument-free expansion hook. It now checks ownership without constraining initialization; the complete final recursive Web runner above confirms only16 accepted failures. Final Web TypeScript is also covered by the successful production build after expansion retention.

Reuse: installed CLI build/smoke6/6 and package tests remain tied to unchanged client/gateway/protocol source; `architecture-unification/integrated-cli-check.md`. Earlier search/deferred-original/browser evidence remains historical for unchanged seams in [10](10-bounded-transcript-window.md); the48-check run supersedes older window-navigation acceptance.

## Final findings resolved

[Review](../review.md) preserves original Standards/Spec findings and classifications. Final public failure split into allocation-driven React185, a queued stale correction overwriting explicit restore, and process expansion lost on session remount. The owning window compares geometry values and cancels obsolete correction on adoption; the existing reading snapshot carries expansion. Final turn offset stays−194px; message−79→−80px. Matched-block/tall/deep search, minimap identity, expansion remount and bounded mounting all pass. No temporary scroll monkeypatches remain.

Default graph is refreshed; supplemental deep graph remains frozen historical9855nodes/20443edges. Known single-turn, minimap, loaded-prefix heap and structured-argument limits retain explicit revisit conditions in [review notes](../review-notes.md). No new blockers.
