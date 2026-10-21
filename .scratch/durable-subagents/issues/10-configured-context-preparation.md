# 10: 按定义完成可恢复的 Fork／Compact 上下文准备

**What to build:** 用户配置的上下文策略通过真实 spawn 创建流程生效；框架固定来源、完成准备并提交结果后才派活，主 agent 无法改变策略。

**Blocked by:** [06 — 创建可恢复的独立子执行](06-durable-child-execution.md)

**Status:** accepted — merged `72d5ce9` on integration/durable-subagents. Integration server suite 406/406. Same-dispatch preparation retry is `7014be8`.

**Labels:** ready-for-agent

**Spec:** [D04](../spec.md#d04)、[D10](../spec.md#d10)、[D11](../spec.md#d11)、[D13](../spec.md#d13)、[D14](../spec.md#d14)；[验收 A13、A14、A19](../spec.md#testing-decisions)。

## Acceptance criteria

- [x] 在06的同一创建/准备接缝接入定义指定的fork-at、child上compact与显式注册策略；核心仍只接收解析结果，不猜策略。
- [x] 模型spawn/send参数不暴露策略、插件或source位置覆盖；越权参数拒绝，任务正文不替代配置；用户/定义是策略决策者。
- [x] 宿主依配置固定source conversation/entry、定义版本和处理策略provenance，后续父消息不混入；fullconfig不由历史来源隐式决定。
- [x] 准备结果持久提交前无child模型任务；失败显示可重试状态，按同一创建/派活身份恢复，不重复child，不静默退回fresh；fallback仅按定义声明。
- [x] 复用原生fork/context/compact及缺失工具结果配对语义，不把合成缺失结果说成原工具已执行；compact保留原始记录且明确有损。
- [x] 准备phase/checkpoint在SIGKILL后重取已提交结果；未安全完成的外部步骤遵守replay契约，不能以纯helper单测代替此恢复链。
- [x] 提供注册策略的现有宿主接缝，不提前实现通用插件平台或自动重要上下文选择；SSH/跨host历史fork未验证时明确不支持。

Parent acceptance: integration `72d5ce9`, `pnpm --filter @hepi/server test` 406/406 exit 0. Review P2 (terminal prep failure, no same-dispatch retry) closed in `7014be8` before merge.

## Verification seam

- 真实模型工具spawn使用配置fresh/fork/compact，对比child首个模型请求上下文、配置快照和sourceprovenance；主agent只传代理/任务。
- 受控compact失败、准备提交前后SIGKILL、父会话继续追加；检查无提前派活、重复child或隐式fallback。

## Scope and handoff

依赖06以验证实际创建与准备交接；无需等待07自动回报或09队列UI，可与它们并行。子分支用户导航由11负责。

遵守[共同完成条件](../README.md#completion-criteria)：实际证据、owning guide 更新和材料性问题处置随本票交付，不等最后一票代做。

## Read-only preparation (agent-96, product5574a49)

06 remains the prerequisite. Scout read public/native1.3.0 implementation and integration source atb912955 (docs-only successor); graph has no native-package nodes, so unsuccessful symbol queries were followed by exact dependency-source reads. No tests or product edits in this preparation.

- Immutable source: full Conversation.context(ctx,{at}) exposes the view fork(at) starts with. Persist source conversation/entry once; native Tx.forkConversation and Conversation.fork accept explicit task ownership. Fork agent doc is asOf; WorkspaceDoc is current; relations/references are initial. Apply the definition-derived full explicit AgentChange in creation so source/owner configuration does not grant extra tools/instructions/model. Use06 real preparation/creation seam.
- Public Conversation.compact(instructions,ctx) returns compaction TaskId; full Conversation is required because invocation ConversationHandle has only submit/abort/waitForIdle. Native manual compaction is conversation-owned and returns a write submissionId; completion alone does not prove summary placement. Confirm outcome plus actual submission/context head before admitting the first task input. A no-cut result may contain neither entryId nor submissionId, so resolve its documented meaning explicitly.
- createCompaction/selectCut/summarizedMessages/serializeConversation are private package helpers (deep imports unavailable). CompactionTask itself is publicly exported, as is Tx.createTask. Follow-up96 source audit and throwaway probes report that a host task can create CompactionTask atomically with task ownership and await its native result: blocking summary places entryId/head without a patch. Compaction status is display-only. Native compact() work also survives reopen without a host-held taskId; host follow-up must recover its durable identity/state and await actual preparation before first-input admission. This is probe evidence, not10 product/restart acceptance.
- Native compaction select/summarize/retry records pinned tail/cut and writes pi.compaction with head firstKept; original entries stay readable. Model/compaction policy comes from configured agent + harness settings. The framework may need to report no_model or failed/no-summary preparation without fallback or task admission.
- Native context normalization synthesizes missing_result for incomplete tool calls and drops unmatched results/aborted assistant contributions. Preserve those semantics. Mirroring the private compaction cut-candidate heuristic for general fork points is a scout suggestion, not an adopted requirement or public API. Arbitrary user-entry forks remain11 scope.

Verification after06: compare first realchild model request and complete configuration/provenance for fresh/fork/compact; pinning survives later parent appends; missing tool result is explicit; compaction failure admits no task; SIGKILL before/after preparation/task identity commits produces onechild and one logicalpreparation/admission. Registered strategy hooks stay within existing host/extension seams; no general plugin platform. Coordinate sharedcreation primitives with11 and runtime lifecycle with07.

Cross-ticket finding: definitions allowgrep/find/ls while actualinstalled CodingTools register onlyread/write/edit/bash. Coordinator confirmed tools/index.js and serverharness install source, classified as05 validation/integration error. Agent96 assigned targeted vocabulary/UI-capability repair on fix/durable-agent-definition-tools;95 handles06 actualspawn toolavailability validation. This repair precedes10; no aliases or new tool implementations implied.

Follow-up96 also observed a Draft footgun in optional pi.live status bookkeeping: `(live.compactions ??= []).push(...)` lost its detached-array mutation in a probe; use normal statement mutation or copy/reassign if status is needed. Reuse public task ownership and native missing_result semantics; private createCompaction helper is not required merely to obtain blocking summary placement.05 vocabulary repair returned07adddb with declared27backend/126Web/51browser checks, pending coordinator source/evidence acceptance separately from this preparation.

## Delivered

Context preparation is decided by the definition and executed by the host; the model's tool schema carries no policy at
all.

- `apps/server/src/subagents/anchor.ts` — `SubagentAnchorInput` gains `preparation?: "compact"` on the dispatch arm
  (the idle arm keeps `preparation?: never`, so a mixed shape is a type error), `initial` starts a `compact` delegation
  in the new `prepare` phase, and `prepare` creates a conversation-owned background `pi.compaction` task **of the
  child**, waits for it natively, and only then moves to `admit`. No version bump: the stored v1 inputs and checkpoints
  of ticket 06 remain valid members, and `admit` still guards `dispatchId === undefined`.
- `apps/server/src/subagents/host.ts` — the port gains `sourcePosition(conversationId)` and `dispatch(conversationId,
  requestId)`; `DispatchRecord` gains `preparation`, `preparationError` and `preparationOutcome`.
- `apps/server/src/subagents/extension.ts` — resolves `strategy = definition.effective.context`, asks the host for the
  source position, passes it as the creation seam's `source` (the native fork) and as `preparation: "compact"` to the
  anchor, and records the resolved strategy and position in `provenance.context`. `agent_get` accepts `requestId` and
  answers the delegation's own record with a `dispatched`/`preparation_failed` status.
- `apps/server/src/subagents/composition.ts` — builds `sourcePosition` from a new `sourceEntry` dependency;
  `server.ts` supplies it from the conversation's own fork-aware `context()`.

Nothing is added to the engine: `Tx.createTask`, the exported `CompactionTask`, the creation seam's `source` field and
the native Inbox control are the whole mechanism, and no private helper is imported.

### Verification (2026-10-16, worktree `durable-subagents-10`)

Focused suite `apps/server/test/context-preparation.test.ts`, six tests over a real backend, real SQLite and a
controlled model:

1. **compact before the first task** — the child's own first model request already carries the summary and ends with the
   task text, and its raw history keeps the pre-compaction entries readable.
2. **fork from the pinned position** — the child's `forkSource.at` equals the recorded `sourceEntryId`, a parent
   message appended afterwards is absent from the branch, and the definition's explicit snapshot is what the child runs
   (its tools, extensions, instructions, model and cwd), so none of the source's capabilities survive the fork.
3. **definition authority** — a `context` argument is refused as host configuration with nothing created; a failed
   preparation answers `agent_get` with `status: "preparation_failed"`, `preparationOutcome: "failed"` and the
   summarizer's own reason, and the child admits no task text and makes no work request.
4. **SIGKILL between the preparation commit and the admission** — the new `prepare` crash mode dies **synchronously
   inside the publication that creates the `pi.compaction` task**, stating `admissionDurable: false` from that
   publication. Reopening the same store resumes and yields one summary, one admission of the dispatch's own task text
   and one child answer, with one child conversation.
5. **reopened paused mid-preparation** — a live preparation task, no admission, no task text in the child and zero model
   requests of any kind, read before scheduling resumes.
6. **a user stop during preparation survives it** — the summarizer is held open, the child is stopped, then released:
   the child's model is never asked, the control state stays `held`, and the user's explicit continue places the
   summary before the work and runs the task text exactly once.

Commands and results:

- `pnpm --filter @hepi/server typecheck` — exit 0.
- `node --test test/context-preparation.test.ts` — 6 tests, 6 pass, 0 fail.
- `node --test --test-concurrency=4 test/*.test.ts` — 394 tests, 394 pass, 0 fail, exit 0
  (`/tmp/t10/full-server.log`). Ticket 06's refusals test was updated with this change: `context: compact` is now
  executable, so its refused case is a name outside the vocabulary (`rewind`) rather than a real strategy.

Known limits: cross-host historical fork is still not supported (spec D12), and the registered-strategy seam is the
existing Agent Definition vocabulary — no general plugin platform was introduced.

### Commits and final evidence (2026-10-16)

- `f4a579f` — the feature.
- `b69fb63` — the tests, the ticket record and the architecture guide.

Final `pnpm verify:changed --base=b74f379` at **`b69fb63`, dirty=false**:
`changed-typecheck` exit 0, `changed-test` exit 0 (**394 tests, 394 pass, 0 fail**), `check-docs` exit 1 on the
**12 pre-existing `.scratch/` links** the baseline carries (none of them in a file this change touched). Report:
`.dev/verify/2026-10-16T18-16-21-590-verify-changed/verify.json`. Logs: `/tmp/t10/`.

**Registered strategies.** The seam for a new strategy is the existing Agent Definition vocabulary
(`AGENT_DEFINITION_CONTEXT_STRATEGIES` in `apps/server/src/agent-definitions.ts`) plus one phase in
`SubagentAnchorTask`. No general plugin platform, no automatic "important context" selection and no model-facing
strategy parameter were introduced (spec D11, out of scope).

**Not verified here.** Cross-host historical fork remains unsupported and is refused/absent by construction rather than
tested (spec D12). The SSH path is exercised by ticket 06's suite, not by this ticket's cases; a preparation over an SSH
execution host is not separately proven.
