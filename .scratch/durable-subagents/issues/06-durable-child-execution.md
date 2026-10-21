# 06: 创建可恢复的独立子执行

**What to build:** 主 agent 选择定义并提供任务，框架创建持久 child、保存派活身份、提交初始工作并先返回 ID；主会话继续工作，用户能打开 child，并通过 get/read 获取真实状态和结果。

**Blocked by:** [02 — 将可信 Stop／Continue 接入会话 API](02-conversation-stop-continue.md)；[03 — 持久化会话来源、展示关系与引用](03-conversation-relations.md)；[04 — 提供有界原始会话读取与可靠续读](04-bounded-conversation-read.md)；[05 — 管理 Execution Host 上的代理定义](05-agent-definitions.md)

**Status:** resolved — coordinator accepted after Standards/Spec review and pinned A19 recovery proof; worker c3e2d9d merged at 11fe1e8. Tested product source938d682; later changes are ticket notes only.

**Labels:** ready-for-agent

**Spec:** [D01](../spec.md#d01)、[D02](../spec.md#d02)、[D03](../spec.md#d03)、[D04](../spec.md#d04)、[D10](../spec.md#d10)、[D11](../spec.md#d11)、[D12](../spec.md#d12)、[D13](../spec.md#d13)；[验收 A02、A03、A13、A15、A16、A19](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 可选扩展注册 child background anchor/执行所需原生任务，明确 conversation-owned background 范围和 native ownership；核心不依赖扩展包私有实现。
- [x] agent_spawn 只接收代理选择/任务等已授权参数，真实 caller 来自工具上下文；模型策略/插件/source位置覆盖拒绝，任务正文不作为宿主配置。
- [x] 按已解析定义固定完整 effective configuration 与来源，显式设置/清除父自动继承字段；fresh 准备提交后才 admission，首条演示使用配置为 fresh 的定义。
- [x] 对尚未实现的 fork/compact 准备明确返回未支持或准备未完成，不静默改 fresh；10随后接入同一准备接缝。
- [x] 稳定请求/checkpoint 保存 child、dispatch、submission 和 recipient；创建/初始 admission/工具返回交接点重试及 SIGKILL 不重复身份或工作。
- [x] spawn 先返回 child/dispatch 身份，主会话不等待其执行；child 接入现有 catalogue/watch/ChatWindow，模型 agent_get/agent_read 直接适配核心状态/读取，无额外busy或历史库。
- [x] 实际本地/SSH/retained worktree 执行绑定与父一致；跨 host fresh 只接受宿主已有明确绑定。默认 child 不再 spawn，限额在 admission 前按宿主事实校验，超限不创建隐藏排队工作。
- [x] 主 stop 不取消 child；child 自然结束保留 Conversation 身份与终态，unsafe 工具依原生策略处理中断，不复活 terminal task。

## Verification seam

- 受控模型经真实模型工具/HTTP 调用 spawn→取ID→主会话继续→child执行→get/read；不能用假child记录替代。
- 在 child 创建、初始 admission 和 receipt 前 SIGKILL 后重开同库；检查模型请求、child数量、submission与副作用计数。

## Scope and handoff

本票阶段结果可通过get/read验证；自动推送结果由07交付，复用send/stop由08交付，不将本票描述为完整subagents已上线。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

Claimed by agent-95 on impl/durable-subagents-06, reusing `.dev/worktrees/durable-subagents-03` after clean branch switch from integration.02 accepted ec0f99f; current graph refreshed there. Read runtime-implementation-notes.md for confirmed paused bootstrap and public native APIs; source/restart evidence supersedes design sketches.

## Delivered

Core (no extension knowledge in it):

- `apps/server/src/conversation-operations.ts` — `ConversationSpawnRequest.ownership` accepts one added form,
  `{ kind: "created-task", create, created? }`. The callback creates the owning task **inside** the creating commit
  (after every table read the seam makes, before the conversation record), so anchor task + child record + the caller's
  own durable dispatch record are one atomic commit under the caller's `requestId`; a replay answers the child the
  first call created. No anchor, dispatch or task vocabulary enters the core.
- `apps/server/src/harness.ts` — `ServerHarness.install(extension)` exposes the installer's own failure policy
  (named failure, backend keeps running) so a composition can install an optional extension after open without a second
  install path.

Optional extension (`apps/server/src/subagents/`):

- `host.ts` — the host port, the `hepi.subagent.dispatch` document family (one member per caller request identity,
  `fork: "initial"`), and the delegation limits.
- `anchor.ts` — `hepi.subagent-anchor`, a **conversation-owned background task** of the delegating conversation. Its
  `admit` phase resolves the child through the invocation-bound handle and submits the task text under the dispatch's
  own stable request id, then commits `submissionId` and moves to a permanent `idle` phase. A restart rewinds the
  running task to `pending` and the phase re-admits the same submission instead of making a second one.
- `extension.ts` — the extension `hepi-subagents` with `agent_spawn`, `agent_get`, `agent_read` (`replay: "safe"`),
  plus the anchor task definition. The trusted caller is `ToolExecutionApi.conversationId`/`callId`; the creation
  request identity is `<conversationId>:<callId>` so a session-scoped index cannot collide across conversations. Every
  argument outside `{name, task}` is refused as host configuration. The definition is resolved on the conversation's
  own Execution Host; unknown definition, disabled definition, a non-`fresh` context strategy, a tool the child's real
  selection does not provide, an unknown model/thinking level, an unbound workspace, and the host's depth/concurrency
  limits are each a named refusal before anything is created. The child's `pi.agent` is the definition's own snapshot
  with `modelTools` cleared, and the child does not select this extension.
- `composition.ts` — the host port built from the backend's own seams (creation operations, catalogue projection,
  workspace binding, workspace agent definitions, the host's own materialized selection).

Server composition:

- `server.ts` installs the extension through `runtime.install` after the creation seam exists and before the boot
  scan/resume; `selectionFor` never offers it by default (the task definition still resolves for every task, so a
  recovered anchor resumes), and withholds it from a child and from an unbound conversation. A commit listener attaches
  any newly created conversation (queued off the session line), so a child created by a model tool is in the catalogue,
  the watch and the ChatWindow immediately rather than after the next boot.

## Review fixes (recorded 2026-10-16, local workstation)

Reviewers 101/102 reproduced five material defects on `ce40b29` through the real extension host and real SQLite, and
this change fixes each at its owning seam:

1. **Concurrency bounded identities, not work.** `liveChildren` counted non-terminal `hepi.subagent-anchor` tasks, but
   the anchor is a permanent identity: after four finished delegations the fifth was refused forever. The host port now
   answers `activeChildren` — a child whose anchor has not admitted its initial input yet, or whose own conversation has
   live work — read from the native owner edge (`scanConversations({ ownerConversationId })`) and the live task table.
   Finished children keep their conversation, their owner and their anchor, and no longer consume capacity.
2. **A replay re-checked current state.** `agent_spawn` resolved the definition, the tool set and the capacity before
   reaching the creation dedupe, so an interrupted delegation whose work was already committed could be refused by a
   later limit, or by a definition edited in between. `existingDispatch` now reads the durable `hepi.subagent.dispatch`
   record **first**, and a replay answers that child's identity without re-resolving anything.
3. **The global opt-in was silently dropped.** Both selection helpers resolved the stored default against the
   *selectable* set, which excludes the optional extension, so `POST /api/extensions {coding-tools, hepi-subagents}`
   stored nothing usable. The stored default now resolves against **every installed** extension — the same set the write
   is validated against — while the fallback (no default ever stored) stays the selectable set; a child and an unbound
   conversation still withhold it.
4. **Cursor exhaustion restarted the listing.** `Math.max(0, findIndex(...))` turned "no id beyond the cursor" into
   page one, so following `nextCursor` looped. Both listing surfaces now share `conversationPage`
   (`apps/server/src/conversation-page.ts`), where a cursor at or past the last row answers an empty page with no
   cursor.
5. **The crash evidence overclaimed.** The stage polled the catalogue, which does not pin the window it claimed, and
   holding the **child's** model response open pins neither of the two windows the acceptance criteria name: it only
   keeps a child answer out of the way. A review at `f537467` ran both modes and found both transcripts already carried
   the `agent_spawn` result and the parent's `parent done` answer before the kill, so the "commit" window had really
   been "creation + admission + tool receipt", and the "receipt" window had really been "everything already receipted".
   The replayed-HTTP call the old test made also exercised only core creation dedupe, never an interrupted native call.

   The fixture is now pinned at the seams that actually separate the states, composed from public entry points
   (`test/subagents-crash-harness.ts`: the real creation seam, the real extension and anchor definition, the real local
   execution host, real SQLite, a controlled model — the backend's own composition hides the Harness, and the window is
   a commit publication):
   - `commit` kills **synchronously inside the commit publication** that carries the child conversation, and reads both
     of its facts from that publication — the child record is in it, no submission for the child is, no `pi.tool-result`
     entry is. The anchor's `admit` phase is a later commit, so "child committed, not yet admitted" is a property of the
     seam, not of timing luck.
   - `receipt` wraps the real `agent_spawn` registration through the extension's own native `wraps` seam, waits until
     the anchor's commit records the admitted submission, and kills **before the wrapper returns** — the calling
     `pi.tool` task is still running, so "child admitted, no tool result" is again structural.

   Each stage prints the facts it read at its own kill point; the test reopens the same SQLite **paused**, reads the
   recovered child, dispatch record, admission, anchor and interrupted `pi.tool` task before scheduling resumes, then
   resumes and asserts one child, one anchor, one admission, one `agent_spawn` result and one `pi.user` entry in the
   child. No `pause()` was invented and no production runtime or test-only server hook was added.

Not fixed here, recorded instead: **parallel `agent_spawn` calls check capacity before their commits**, so several
concurrent calls can each observe room and all create (reviewer 101's synthetic five-call host probe). The native tool
scheduler really is parallel, but the model path admitted exactly four of five (reviewer 102, real backend). The
over-capacity admission has so far been observed only through the synthetic direct-`execute` host probe, which is
evidence that the real model path did not exhibit it, not proof that it cannot: the window is a property of the
check-before-commit seam itself. No lock was added on that evidence; the condition to revisit is an over-capacity
admission observed on the real model path. Recorded as an advisory limit of the current admission seam, not a
delivered guarantee.

## Verification (recorded 2026-10-16, local workstation)

`pnpm verify:changed --base=integration/durable-subagents` at `938d682` (clean tree, based on `3022000`), logs
in `.dev/verify/2026-10-16T16-39-08-535-verify-changed`:

- `changed-typecheck` exit 0 — `pnpm --filter @hepi/server --filter @hepi/web -r typecheck`.
- `changed-test` exit 0 — `pnpm --filter @hepi/server -r test`: **384/384** (11 in `test/subagents.test.ts`).
- `web-unit` exit 0 — 129/129 (the run's own TAP summary in `web-unit.log`; an earlier revision of this record
  carried a stale 123 count).
- `check-docs` exit 1 — the same 12 pre-existing broken relative links under `.scratch/` that fail on the base
  revision; no new link is broken and the new architecture section is indexed.

The two crash windows were also driven directly, each stage run as its own process at `938d682`
(`node test/subagents-crash-child.ts <db> <workspace> <home> <commit|receipt>`), both exiting 137 with the stage's own
last line naming the window and the facts it read at the kill point:

- `commit` — `{"checkpoint":"child-committed","admissionDurable":false,"toolResultCommitted":false}`, read from the
  commit publication that carried the child.
- `receipt` — `{"checkpoint":"child-admitted","admissionDurable":true,"toolResultCommitted":false}` with the anchor task
  id and the admitted submission id, read inside the real `agent_spawn` call before it returned.

The `check-docs` failure above is the only failing step, and it is the base revision's own.

`node --test test/subagents.test.ts` (11/11) covers, through real HTTP/model-tool calls over a real SQLite store, a
real local or SSH execution host and a controlled model: spawn → identity → parent continues → child runs →
`agent_get`/`agent_read`; creator/display parent/native owner/provenance and the child's own configuration snapshot;
the SSH host resolution and the inherited binding; the named refusals (unknown definition, unavailable tool,
non-`fresh` context, model-supplied host configuration, unbound workspace, depth); a user stop of the parent leaving
the child and its anchor running; four delegations that hold, a fifth refused with `children_exceeded`, and a sixth
admitted after the four finish while every finished child keeps its owner; a replay of an already-created delegation
answered from the durable record while the limit is full and the definition is gone; two real `SIGKILL` windows
(`commit` and `receipt`) after which exactly one child, one anchor owner and one admitted submission survive under the
caller's own request id, the child still answers once, and a replay answers the same child; and a global default that
opts delegation in for a new conversation while its child still does not select it.

Not yet covered by this ticket (later tickets own them): automatic result delivery (07), a second dispatch to a
finished child and `agent_send`/`agent_stop` (08), fork/compact context preparation (10), child forks (11) and the
browser journey (12).
