# 13: 组合验收恢复链并同步当前指南

**What to build:** 用户获得经真实多会话、真实进程中断和浏览器旅程验证的完整 subagents 功能；当前指南清楚区分已交付行为、配置方式及剩余限制。

**Blocked by:** [09 — 编辑取消待处理结果并在 Web 明确继续](09-pending-item-controls.md)；[10 — 按定义完成可恢复的 Fork／Compact 上下文准备](10-configured-context-preparation.md)；[11 — 打开原始历史、引用并创建独立子分支](11-child-forks-history-references.md)；[12 — 贯通 Web 快速派活、子会话树与真实状态](12-web-agent-workflows.md)

**Status:** resolved — combined acceptance green on branch `impl/durable-subagents-13` (base `b6b6745`). Full mapping below; no product change beyond the acceptance drivers except two test-fixture fixes that made existing assertions deterministic. The follow-up review is dispositioned at the end of this file: one fix (interrupted-run cleanup, plus the provenance line that makes a recorded browser log name its build), the rest recorded.

**Labels:** ready-for-agent

**Spec:** [D01](../spec.md#d01)、[D02](../spec.md#d02)、[D04](../spec.md#d04)、[D05](../spec.md#d05)、[D06](../spec.md#d06)、[D07](../spec.md#d07)、[D08](../spec.md#d08)、[D09](../spec.md#d09)、[D10](../spec.md#d10)、[D11](../spec.md#d11)、[D12](../spec.md#d12)、[D13](../spec.md#d13)、[D14](../spec.md#d14)、[D15](../spec.md#d15)、[D16](../spec.md#d16)；[验收 A01、A02、A03、A04、A05、A06、A07、A08、A09、A10、A11、A12、A13、A14、A15、A16、A17、A18、A19、A20、A21、A22](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 按spec全部A01–A22建立结果映射；复用未变源码已有证据，只补组合旅程或尚未验证的交接，不把基础M0探针算作产品验收。
- [x] 独立backend进程+同一测试独占SQLite+受控模型/工具，在child创建、admission、完整终态至投送、报告queued至确认各窗口真实SIGKILL重开，身份/结果不重复。
- [x] 在stop已提交但尚drain、continue入队至HTTP答复、编辑/取消后、较新stop后旧continue重试等窗口真实SIGKILL；用户来源、held与队列最终决定保持。
- [x] 组合验证正常完成复用、idle唤醒、running边界、parentstop不杀child、userstop拒绝模型恢复、共享answer引用、recipient_deleted和不循环回报。
- [x] 验证本地/SSH/worktree、定义快照/配置策略、原始历史/继承附件/childfork、工具关闭、任务缺失/版本不兼容、safe/unsafe恢复；不外推exactly-once外部副作用。
- [x] 生产浏览器贯通快速创建、Settings、子树/完整child、晚报告编辑取消Continue、历史/引用/fork；保留既有提交恢复、窗口历史和图片读取行为。
- [x] 完成相关pnpm verify:changed与必要的隔离生产browser/process检查；逐项记录实际命令、revision/dirty、退出码和原始日志，固定端口/产物各自独占。
- [x] 将当前架构、聊天/Web操作、执行侧资源、验证及migration-status指南同步到实测结果，旧研究加当前入口而不伪造历史报告；每个先行ticket也已经更新其owning guide。
- [x] 材料性失败按review policy在责任边界修复；其余记录触发/影响/重访条件，不循环扩scope；完整通过前不宣称产品crash-safe，不部署或重启生产。

## Verification seam

- 以spec验收表为唯一完整覆盖清单，browser检查用户可见链，HTTP/工具与native检查原子性，SIGKILL矩阵检查实际持久恢复。
- 隔离构建仅在工作站/CI，remote-host只可运行预构建产物；本票不包含生产部署。

## Scope and handoff

不新增用户未要求的功能，也不为本轮文档准备提前运行产品不存在的测试。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Delivered (branch `impl/durable-subagents-13`, base `b6b6745`)

Five acceptance drivers, each at a seam no owning ticket could reach, plus the guide sync. Nothing here is a product
feature: every file is a test, a fixture, or documentation.

| Driver | What only it can state |
| --- | --- |
| `apps/server/test/acceptance-chain.test.ts` + `acceptance-chain-child.ts` | **Two real SIGKILLs in one chain.** A backend process admits a child, is killed; a second process admits the report, is killed; a third finishes. Across all three: one child, one dispatch, one child submission, one report entry, one permanent anchor (A19). |
| `apps/server/test/acceptance-recovery.test.ts` + `acceptance-crash-backend.ts` | **The three control windows that only exist mid-drain**, each an isolated backend process over its own SQLite, killed without a close: a stop committed while its ordinary scope still drains (hold + receipt + the report that arrived after it survive, A07/A08/A20); a continue whose HTTP answer never reached the caller (one receipt, one consumption, A10/A20); a newer stop that supersedes an older continue whose retry then arrives (409 `superseded`, newer hold in force, A10/A20). |
| `apps/server/test/acceptance-failure.test.ts` + `acceptance-failure-child.ts` | **Unsafe recovery and a missing definition.** A tool task killed inside `execute` is reopened: the call settles as "interrupted and may have partially run" and the file its body appended still holds **one** line, so the body is never replayed (A20, D16). A store reopened by a build that installs no anchor definition states `missing_task` and keeps the child's history readable (A01/A21). |
| `apps/server/test/acceptance-multisession.test.ts` | **One parent, an independent main conversation, a child and a branch of that child**, every edge read back after the work ran, with the child inheriting a **retained** workspace binding — the one binding shape no ticket exercised for a delegated child — and the file the child's tool wrote on that host (A02/A15/A17). |
| `apps/server/test/acceptance-shared-answer.test.ts` | **Two merged inputs settle on one answer.** With `followUpMode: "all"`, two admitted inputs cost one model request, both submissions name the same committed `answerId`, each still answers its own request id, and one answer entry serves both (A05, D05). |
| `apps/web/e2e/ux-system-acceptance.mjs` (53 checks) | **The whole feature as one session**, against the production Next build, the real backend over real SQLite, a real local execution host and one controlled OpenAI-completions endpoint: Settings saves a definition as a real file → the composer's quick create offers it and opens the child → the child runs and reports → the tree lists both children with their own `idle` → the seeded child opens with its own relations → a late report queues under the user's own stop (no model woken), is edited and survives a reload, then Continue consumes the kept text → the child's raw history shows the compacted prefix, reads an inherited image as its own bytes, and opens a structured reference → a fork from a chosen entry opens a branch with its own owner, fork source and no inherited hold. It then re-checks three behaviours that must not regress beside them: a submission recovered by its request id exactly once, a bounded history stating its truncation and continuation, and an image block read by address (A18, plus A04/A06/A07/A11/A16/A17). |

Two fixture fixes were needed for determinism, both in test code:

- `acceptance-failure-child.ts` waited for the tool task's `execute` checkpoint and then killed. A checkpoint is stated
  **before** the body runs, so the killed process could lose the append and the reopened store then saw an empty log (the
  test failed once under `verify:changed`, five consecutive targeted runs passed, then it failed again). It now waits
  for the **file the body appends**, and the body then never returns — the window is the body's own hang, not a race
  with it. Repeated 5/5 after the change.
- `subagent-acceptance-fixture.ts` seeded the parent through the raw creation seam, which left it with no model, so the
  browser journey's first ordinary turn had nothing to answer with. It now spawns the parent through
  `ConversationOperations.spawn` with the fixture's model, which is the same seam a person's conversation comes from.

## Acceptance mapping (A01–A22)

Every row names the **command** that proves it. "Reused" means the source those tests read is byte-identical on this
branch to the revision that measured them, so the earlier record stands; "combined" means this ticket adds evidence.

| Spec | Evidence | Kind |
| --- | --- | --- |
| A01 扩展关闭时普通聊天无退化，兼容任务仍恢复，历史可读，缺失定义显示真实 blocked 原因 | `subagents.test.ts` "disabling the delegation tools…"; `acceptance-failure.test.ts` "a store whose task definition this build does not have…"; `ux-subagent-delegate.mjs` (capability toggle) | reused + combined |
| A02 创建者/展示 parent/owner/fork source/recipient 各正确，跨会话操作不改关系 | `conversation-relations.test.ts` (6 tests); `acceptance-multisession.test.ts` (all four edges in one session) | reused + combined |
| A03 模型工具恰为五个 agent_*；不泄露凭据；caller 不由正文自报；self-stop 被拒 | `subagents.test.ts` "the tool set this ticket fixes…", "an agent stop holds and is resumable…"; `web-delegate.test.ts` | reused |
| A04 child 自动回报完整 Submission 终态一次；工具轮不提前回报 | `subagent-reports.test.ts` "a child's final answer is delivered…"; `acceptance-chain.test.ts` (one report across two kills) | reused + combined |
| A05 保留 child ID/历史，可直接 send；合并输入共享 answer 引用，各 dispatch receipt 正确 | `subagents.test.ts` "a second explicit send…"; `acceptance-shared-answer.test.ts` | reused + combined |
| A06 allowed idle 被唤醒；running 按边界接收；普通聊天不循环回报 | `subagent-reports.test.ts` "a report queues at the running recipient's own boundary…"; `ux-system-acceptance.mjs` (report wakes nothing while held, then Continue) | reused + combined |
| A07 主 stop 不取消 child/reporter；迟到结果 queued 且无父模型请求 | `subagent-reports.test.ts` "a user-stopped recipient queues the late report…"; `acceptance-recovery.test.ts` stop-drain window; browser journey §4 | reused + combined |
| A08 stop 提交点撤回输入、之后报告保留；重复 stop 不再次清空 | `native-input-control.test.ts` "a stop withdraws the input queued at its commit point…"; `acceptance-recovery.test.ts` | reused + combined |
| A09 用户停止后模型 send/resume/agent_stop 无法解除 | `subagents.test.ts` "a user stop refuses a model dispatch…"; `native-input-control.test.ts` "a user stop is only cleared by a trusted user continue" | reused |
| A10 stopping 时 continue 保留输入；idle 后原子恢复；空 continue 无虚假消息；旧请求不覆盖新 stop | `conversation-stop-continue.test.ts`; `acceptance-recovery.test.ts` continue-answer and newer-stop windows | reused + combined |
| A11 queued 项编辑/取消不启动模型；旧 token 冲突；reporter 重试不覆盖；重开后决定保留 | `pending-item-controls.test.ts` (8), `pending-item-routes.test.ts` (5); browser journey §4 (edit + reload, no revision move) | reused + combined |
| A12 本地/SSH 定义 project 覆盖 user；dryRun 不落盘；保存原子；未知字段保留 | `agent-definitions.test.ts` (13); `ux-agent-definitions.mjs`; browser journey §1 (the saved file read from disk) | reused + combined |
| A13 配置完整快照无父能力残留；策略只由定义/用户决定 | `context-preparation.test.ts` "a fork definition branches…", "the definition's strategy is not overridable"; `subagents.test.ts` "an unknown definition, an unavailable tool… are all refused" | reused |
| A14 fork/compact 准备失败显式可重试，不重复 child/派活，不静默 fallback | `context-preparation.test.ts` "a failed preparation is retryable…", "…survives a SIGKILL" | reused |
| A15 child 继承完整本地/SSH/worktree/Retained Binding；超限拒绝且不引入第二队列 | `subagents.test.ts` SSH binding test; `acceptance-multisession.test.ts` retained binding + the file the child's tool wrote | reused + combined |
| A16 agent_read/HTTP 共享完整原始历史；多行/超长行/续读/图片可用 | `conversation-read.test.ts` (12); browser journey §5 (compacted prefix, image bytes, reference) and §7b/7c | reused + combined |
| A17 child fork 独立 owner/任务/队列/控制；compact 前历史可读；父 tombstone 不破坏 | `conversation-fork-source.test.ts` (4); `subagents.test.ts` "a branch of a child is its own owner…"; browser journey §6 | reused + combined |
| A18 Web 可快速创建、打开完整 child、编辑定义、查看真实状态、编辑取消待处理项、继续、浏览历史/fork、打开引用 | `ux-system-acceptance.mjs` — one journey covering all of them | combined |
| A19 创建/admission/终态至回报/回报入队至确认后 SIGKILL 保持同一身份 | `acceptance-chain.test.ts` (two kills, one chain); `subagents.test.ts` send crash; `subagent-reports.test.ts` settlement→delivery and admission→acknowledgement | reused + combined |
| A20 stop drain、continue、编辑/取消后 SIGKILL 保留最新意图；unsafe 不盲重放 | `acceptance-recovery.test.ts` (3 windows); `acceptance-failure.test.ts` (unsafe); `pending-item-controls.test.ts` edit/cancel crash | reused + combined |
| A21 旧 SQLite 迁移和不兼容 runtime/任务版本行为明确；不伪造成功；不声称 exactly-once | `native-input-control-migration.test.ts`; `acceptance-failure.test.ts` `missing_task`; the unsafe result's own "may have partially run" text | reused + combined |
| A22 recipient tombstone 结束为 recipient_deleted 并保留源结果；父隐藏不级联 child | `subagent-reports.test.ts` "a removed recipient terminates the delivery…"; `conversation-relations.test.ts` "a tombstoned display parent…" | reused |

## Verification (2026-10-17, this branch)

| Command | Exit | Result | Log |
| --- | --- | --- | --- |
| `pnpm verify:changed --base=b6b6745` | 0 | typecheck, server suite and Web units all PASS (`ok: true`), `sha` `b6b6745`, `dirtyFiles` = the ten files below | `.dev/verify/2026-10-17T04-00-29-199-verify-changed/` |
| `node --test --test-reporter=tap test/acceptance-chain.test.ts test/acceptance-failure.test.ts test/acceptance-multisession.test.ts test/acceptance-recovery.test.ts test/acceptance-shared-answer.test.ts` (cwd `apps/server`) | 0 | 8 tests, 8 pass | `.scratch/durable-subagents/logs/13/acceptance-tests.log` |
| `node apps/web/e2e/ux-system-acceptance.mjs` with `HEPI_UX13_WEB_PORT=32013 HEPI_UX13_BACKEND_PORT=42013` after `pnpm --filter @hepi/web build` | 0 | 53 checks, 0 failures, "UX-13 system acceptance checks PASSED"; the log's own first line names the Next build id and the git revision | `.scratch/durable-subagents/logs/13/ux-system-acceptance.log` |
| `node --test --test-reporter=tap test/agent-definitions.test.ts test/conversation-read.test.ts test/pending-item-controls.test.ts test/pending-item-routes.test.ts test/conversation-relations.test.ts` (cwd `apps/server`) | 0 | 44 tests, 44 pass — the per-file counts the mapping table cites | re-measured for this table; no log retained |

Counts in the mapping table are the **files' own** test counts, re-measured here rather than carried over: `agent-definitions.test.ts` 13, `conversation-read.test.ts` 12, `pending-item-controls.test.ts` 8, `pending-item-routes.test.ts` 5, `conversation-relations.test.ts` 6.

Tree state: tracked files clean at `b6b6745`; the dirty-before paths are exactly the ten new files this ticket adds
(five test drivers, three stage fixtures, one browser driver, one backend fixture). Ports, SQLite files, artifact
directories and the Next build are this ticket's own; `apps/web/e2e/ux-system-acceptance.mjs` removes its artifact
directory unless `--keep` is passed, and every stage fixture writes only under the test's `mkdtemp` directory.

The browser check runs an **isolated production stack built from this branch**, not the live deployment:
`pnpm --filter @hepi/web build`, then `next start` on `127.0.0.1:32013` in front of a backend process on
`127.0.0.1:42013` whose own local gateway serves the fixture's workspace and agent directory.

## Environment finding: the pre-deploy gateway lacked the definition surface (closed)

Read-only inspection of the running stack before the routine deploy found `GET /api/agent-definitions?cwd=…`
answering **503 `host_unreachable`** with `TypeError: path must be of type string, received undefined`, while
project-scope document reads and writes inside the workspace root still succeeded. The cause was the then-deployed
gateway client bundle, `release-56ff08f`, which had no `agent-definitions` resource and no `agentDir` on its
`executionHost` answer, so listing or resolving a user-scope definition reached the file surface with an undefined
path. Settings › Agents listing and any definition-resolving quick create were affected on the live stack only.

**Closed by the routine deployment of 2026-10-17T10:54Z** (coordinator, outside this ticket): backend
`hepi-backend:1062840-workstation`, gateway repacked from `1062840` in place of `56ff08f`, Web reused the unchanged
production source. Its read-only smoke returned `GET /api/agent-definitions` 200 with 4 definitions, all 16 existing
conversations readable with 200 entries, 1 host and 4 workspaces with no host error. That smoke is a deployment check,
not acceptance evidence: **no driver in this ticket was run against the live stack**, so nothing here claims the live
deployment is crash-safe, and the multi-kill and mid-drain results stay claims about the isolated stacks they ran on.
Deployment record: `.dev/deploy/1062840/` (git-ignored, coordinator's).

## Review disposition (2026-10-17)

Six findings were carried into this closing pass. Each is dispositioned by
[review policy](../../../docs/agents/review-policy.md) — trigger, evidence, normal-use likelihood, user impact — and no
seventh review loop was opened.

| Finding | Disposition | Why |
| --- | --- | --- |
| **Production-build vs live framing.** A green log could be read as a statement about the live deployment, and the ticket first recorded the live stack's missing definition surface as a standing limit. | `fix` | Ordinary use of this record decides whether a deployment is trusted. The browser driver now prints the Next build id and the git revision as its own first line, and the ticket, `verification`, `architecture` and `migration-status` all state the same split: the drivers measure isolated production builds, the 2026-10-17T10:54Z deploy closed the definition-surface gap as a deployment check, and no driver ran against the live stack. |
| **Failure/signal process cleanup.** The browser driver closed its children only in `finally`, so a `SIGINT` (Ctrl-C) left the production Next server and the backend holding their ports — the leaked-listener failure the verification guide names. | `fix` | Interrupting a long browser run is ordinary. Cleanup is now one `shutdown()` reached by `finally` and by `SIGINT`/`SIGTERM`/`SIGHUP`, and `stop()` awaits the exit it already waited for instead of re-arming `once()` on an already-emitted event. |
| **`freePort` TOCTOU.** The driver probes a port, closes the probe, then starts a process on it, so another run can take the port in between. | `record` | Every acceptance driver in this repository uses this shape, the window is microseconds, and both processes are spawned by this run with their own ports recorded in the log. A collision fails loudly at startup with a bind error, not silently; nothing here would be fixed by a probe-once-then-bind helper that every other driver does not share. Revisit if a driver is ever observed failing to bind under parallel runs. |
| **Exactly-once scope.** The gate must not be read as an exactly-once claim for external side effects. | `record` | Already stated three times — the unsafe stage's own "interrupted and may have partially run" result is asserted, and `architecture`, `verification` and `migration-status` each repeat the limit. Nothing to change; the risk is that a future reader drops it, and the assertion in `acceptance-failure.test.ts` is what keeps it honest. |
| **Measurement provenance.** The verification table cited counts and a `verify:changed` result without the SHA/dirty state the guide requires, and three per-file counts in the mapping table were stale (`agent-definitions` 14, `conversation-read` 11, `pending-item-controls` 7). | `fix` | A wrong count is a wrong result under [verification practice](../../../docs/agents/verification.md). The table now names the SHA and the ten `dirtyFiles` from `verify.json`, the counts are re-measured (13/12/8/5/6) with the command that measured them, and the browser row states that its log carries its own provenance. |
| **AC references.** The mapping table cited test titles and per-file counts that must actually exist. | `fix` | Every cited file and title exists; the three stale counts above are the only mismatch, and they are corrected. No cited seam was missing. |

The one product-visible consequence of the cleanup fix is confined to the driver: a run that is interrupted now reports
`Interrupted by <signal>` and exits 130 after stopping its own children, rather than leaving them behind.
