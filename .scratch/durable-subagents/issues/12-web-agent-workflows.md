# 12: 贯通 Web 快速派活、子会话树与真实状态

**What to build:** 用户无需编写模型提示，在主会话快速选择或创建代理并派活，能从子会话树打开同一完整 ChatWindow、继续工作并查看真实执行/限制状态。

**Blocked by:** [08 — 复用子会话并统一派活与停止工具](08-reusable-agent-control.md)

**Status:** accepted — merged `fb04eb7`. Spec and standards reviews: no material finding. Worker report: server 437/437, web unit 144/144, ux-subagent-delegate 51/51. No verify.json; driver has 50 check() calls.

**Labels:** ready-for-agent

**Spec:** [D02](../spec.md#d02)、[D10](../spec.md#d10)、[D12](../spec.md#d12)、[D15](../spec.md#d15)；[验收 A01、A03、A12、A15、A18](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 主会话快速创建/派活使用05定义与08已完成五工具背后的同一宿主interface；用户配置策略，主agent派活没有策略覆盖。
- [x] Sidebar从catalogue展示真实parent关系与child状态，打开复用ChatWindow/原生流；展示running/held/stopping/等待报告/blocked/interrupted，不从父busy猜状态。
- [x] 用户可跳转已有child继续聊天或显式派活；直接普通child聊天不注册自动向父回报。
- [x] 继承本地/SSH/worktree/RetainedBinding实际执行正确，界面显示真实主机与不可达/超限错误；深度默认限制和并发拒绝不表现成隐藏排队。
- [x] Settings定义编辑和快速创建使用同一文档/校验接口，保存成功只影响后续创建；界面不泄露provider/backend token或内部调度细节。
- [x] 配置/委派入口按扩展capability显示；关闭工具不移除已有child历史、关系和通用控制，已安装兼容任务仍恢复；缺失定义显示明确状态。
- [x] 会话切换、后台运行与浏览器断开重连使用既有流与生命周期fold，不为每个catalogue项新增永久SSE，不丢composer草稿或误报完成。

## Verification seam

- 生产浏览器本地与SSH真实执行旅程：Settings定义→主会话快速派活→打开child→完成→再派活→关闭委派入口后读取历史。
- 运行中切换会话/重连和超限/离线负向场景；核对backend事实及实际执行文件，不仅看按钮可见。

## Scope and handoff

09独立负责待处理编辑/Continue，11负责历史来源/fork/引用；这些功能在13一起验收，不为并行实施重复建设界面。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Delivered (branch `impl/durable-subagents-12`, base `f1514cf`)

Every acceptance criterion is met at a public seam, and the verification seam is a real browser journey against the
production Next build, a real backend over real SQLite, a real local execution host and the real anchor/reporter tasks.

| Area | What it delivers |
| --- | --- |
| One delegation seam | `apps/server/src/subagents/delegate.ts` (`createSubagentDelegation`) is the operation `agent_spawn`/`agent_send` now call **and** the one `POST /api/conversations/:id/delegate` calls: same definition resolution, same depth/concurrency bounds, same atomic child+anchor+dispatch commit, same reporter. The HTTP body carries `name`, `task`, `requestId` and an optional `conversationId` — no context strategy, tool set or model, so a quick create cannot override the policy the definition owns (D01, D10, D11, D12). |
| Refusals are answers | `depth_exceeded`/`children_exceeded` (409), `unknown_definition`/`no_execution_host` (404), `host_unreachable`, `user_stopped`, `tool_unavailable`, `no_source_entry`, `definition_disabled` and the definition validation codes. Nothing is queued: a refused delegation creates no child and admits no submission. |
| Real child status | `apps/server/src/subagents/status.ts` (`projectRunStatus`) projects `running`, `held`, `stopping`, `waiting-report`, `blocked`, `interrupted`, `idle` from facts about **that** conversation: its `busy`, its committed control, its live tasks from one shared `harness.inspect`, and whether its report is queued. Background tasks never count as work, so a finished child is not "running forever", and no per-row SSE is opened (D12, D15). |
| Catalogue carries it | `CatalogueEntry` gained `runStatus` and `extensions`; the Web adapter maps both onto the session row, so the child tree and the delegate entry read the backend rather than guessing. |
| Web quick delegate | `QuickDelegatePanel` lists definitions through the same `/api/agent-definitions?cwd=` interface Settings edits, offers "a new child" or an existing one, holds one `requestId` per attempt (`lib/delegate-attempt.ts`), shows the backend's own refusal code and message, and opens the child in the same ChatWindow from the catalogue row the delegation answered with. |
| Child tree | `AgentSessionPanel` walks display parent → creator → subagent edge as a stable depth-first tree, states each conversation's own `runStatus` with the runtime's reason, marks a hidden display parent instead of promoting the child, and opens a row in the same window. |
| Capability gating | Both entries follow the conversation's own `extensions`. Turning `hepi-subagents` off removes the entry; child relations, histories and generic stop/continue stay, and a child offers no delegate entry because a child may not delegate in turn (D15, A01). |

Verification (2026-10-17, this branch):

- `apps/server/test/web-delegate.test.ts` — 7/7: the route creates a real child over the model tool's seam and a replay
  answers it once; a body naming a context strategy is not read (the definition's `fork` still refuses for want of
  history) and an unknown definition is 404 `unknown_definition`; an unusable capability is 400 `unsupported_capability`;
  the depth and concurrency bounds refuse by name and create nothing, and a finished child never blocks the next
  delegation; a user stop on the target refuses a dispatch and leaves the child's identity intact; the catalogue states
  `running`/`stopping`/`held`/`idle` for a child from that child's own facts while its idle parent stays idle; the
  catalogue states the child's own selection.
- Server suite 435/435 (`pnpm --filter @hepi/server test`), Web units 139/139 (`node scripts/test-web-unit.mjs`),
  `pnpm --filter @hepi/web typecheck` clean.
- `apps/web/e2e/ux-subagent-delegate.mjs` — 38/38 after `pnpm --filter @hepi/web build`, against the production build:
  Settings definition (asserted as a real file on the host account) → quick delegate → child opened in the same window
  → child answers in its own conversation and reports into the parent → child tree lists it with its own status and
  opens it → explicit "delegate again" to the same child (no second child, owner/display parent/task preserved) → a
  plain message in the child registers no report → capability off removes the entry while relations, history, stop and
  continue survive → four held children admitted and a fifth refused `children_exceeded` with the Web origin reporting
  the same 409 → the execution host taken away, where the definition list fails `configuration_required` and a
  delegation fails `host_unreachable`.


Follow-up (same branch, after the acceptance review): two gaps were previously asserted only by implication, and both now
have their own tests.

- **The real host is shown.** The catalogue already stated each conversation's `gatewayId`; the Web adapter dropped it and
  the tree did not show it, so a child running on a remote host looked like it ran on this origin. The row now carries the
  host the work really runs on and states none when the catalogue states none (`subagent-surface.test.mjs`, a catalogue-row
  case in `durable-api.test.mjs`, and a live assertion in the browser journey).
- **The delegation answer keeps the backend's status.** Re-wrapping the answer for the Web origin turned a `201 created`
  into a `200`, which is the one difference a caller can act on; the status now travels (`durable-api.test.mjs`).
- **No per-row SSE is asserted rather than promised.** `subagent-surface.test.mjs` proves neither surface opens a stream or
  reads a row's state, `web-delegate.test.ts` proves one catalogue read answers every child's status, and the browser
  journey records every `/events` request while the tree is open and asserts none names the listed child.
- **Settings and the quick create are one validation interface, proven end to end.** `web-delegate.test.ts` saves through
  `PUT /api/agent-definitions`, has an uninstalled tool refused there, shows the quick create's list does not offer it and
  the delegation route refusing it as `unknown_definition`, then saves an accepted definition and asserts the child's
  provenance names it.
- **No credential in the delegation answer.** `durable-api.test.mjs` asserts the answer carries no gateway token, API key,
  authorization header, reporter task id or anchor task id — only the child row and the delegation identity.
Known limits: the driver does not drive the SSH host for this ticket (the local host is the real execution host it
asserts against, and `ux-agent-definitions.mjs` owns the SSH definition journey); `blocked`/`interrupted`/
`waiting-report` are covered by the projection's own facts rather than by a crash fixture in the browser journey.
