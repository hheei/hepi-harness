# 05: 让 SDK 与 Web 使用同一历史规则

**Parent:** [Architecture consolidation spec](../spec.md)

**What to build:** SDK 与 Web 在窗口推进、已翻页历史保留、head 重置和完整替换上给出同义结果，并保留原生消息与状态字段。

**Blocked by:** None (can start immediately)

**Status:** resolved

## Acceptance criteria

- [x] 现有 session 纯根拥有唯一窗口/prefix 决策；Web prefix 规则迁入，SDK 真正委托同一规则，旧 Web 实现和旧重复决策体退出。
- [x] SDK 返回类型反映保留的原生 message、延迟块元数据及快照标量；不新增 id→payload 缓存，纯根不导入浏览器模块。
- [x] 归一化完整 transcript 后，同边界、重叠、整个旧窗口滚出、head 变化、无真实 prefix 与完整 active range 替换符合规格。
- [x] 无 prefix 不积累旧窗口；比较按身份、边界按位置，delta 使用实际 held baseRevision，等版本 snapshot 重述可用于 hydration。
- [x] Web 现有 prefix/重连与滚动行为通过；SDK、诊断页和生产者回归保持兼容用途；文档如实记录未见历史 gap 限制。

## Verification seam

复用 reducer/loaded-history 用例与真实 Backend reducer 检查；补必要的 payload/metadata、旧窗完全滚出、head 失效用例，运行历史 prefix 浏览器驱动。

## Integration notes

合成函数探针不是 live compaction 复现；不引入通用 fold，不改生产者预算或 frameFor，不将非重叠 snapshot 变成不断读取最新 state 的循环。

## Answer

**Status:** resolved（worktree `architecture-consolidation-05`，分支 `work/architecture-consolidation-05`）

一条规则，一份实现：`decidePrefix` + `LoadedPrefix`/`WindowFacts` 只在 `packages/session/src/index.ts` 声明与实现，
`apps/web/lib/history-prefix.ts` 删除，`apps/web/hooks/useAgentSession.ts:25` 改从 `@hepi/session` 导入（两处调用点
L839/L952 未改语义）。SDK 侧 `prefixOf` 函数体删除：`mergeWindow`/`advanceWindow` 把 state 按自身边界拆成
pages/window，再把 `WindowFacts` 交给同一个 `decidePrefix`，返回的 prefix 与窗口/tail 拼接。

状态类型改为原生保真：`SessionState<TMessage>` 保留 `ServerEntry.message`（payload 与延迟块元数据原样在对象里）
并声明 snapshot 的其余标量（`run`/`submissions`/`liveTools`/`settings`/`queuedMessages`/`historyHead`/`hasMore`…），
snapshot 分支整帧替换、delta 分支仍剔除 `baseRevision`/`appended`。没有新增 id→payload 缓存；纯根仍只有
`import type` 的 `@hepi/protocol`，无浏览器依赖。`historyHead` 可选声明，只在决策后写入，因此 head 判据读到的是
本状态加载时的 head。生产者一行未改。

### Final revision

- 交付提交 `3e00eb3`；与 `integration/architecture-consolidation` 合并后 HEAD `aaae57b`（`b49e44e` 为共同祖先）。
  下列命令全部在 `aaae57b` 上重跑，日志在 `.dev/verify/consolidation-05/`。
- `pnpm install --offline --frozen-lockfile` → exit 0（`install-final.log`）
- `pnpm -r test` → exit 0，各包 fail 0（`recursive-test-final.log`）
- `pnpm --filter @hepi/session test` → 31/31 pass；`typecheck` + `apps/web`/`apps/server` `tsc --noEmit` → exit 0
- `pnpm test:web:unit` → 106/106 pass，exit 0；`apps/web` `pnpm build` → exit 0（`web-build-final.log`）
- `apps/server/test/session-reducer.test.ts` → 4/4 pass（真实 Backend 字节）
- `node apps/web/e2e/ux-history-prefix.mjs` → 11/11 checks passed（`ux-history-prefix-final.log`）
- `node scripts/check-docs.mjs` → exit 1，12 个既有断链（`.scratch/design-fixes/host/*`、`.scratch/architecture-unification/*`、
  `.pi/skills/*`，指向本 worktree 中不存在的 git-ignored 文件），与本次改动无关，条目与改动前一致。

### Evidence

- `packages/session/test/decide-prefix.test.ts`（新增）：迁移、幂等、null/head 变动/`hasMore=false` 三门、整窗滚出、
  以及**完整 transcript 矩阵**（同边界、重叠、非重叠滚出、head 变动、完整替换、未见 gap）对 SDK fold 与浏览器
  （prefix+窗口拼接）两侧同值断言。
- `pnpm --filter @hepi/session test`：26/26 pass，exit 0（`.dev/verify/consolidation-05/session-*.log`）
- `pnpm --filter @hepi/session typecheck`、`apps/web` `tsc --noEmit`、`apps/server` `tsc --noEmit`：exit 0
- `pnpm test:web:unit`：63 files / 110 tests / 110 pass / 0 fail，exit 0（`history-prefix.test.mjs` 随其实现迁走）
- `apps/server/test/session-reducer.test.ts`（真实 Backend 字节）：4/4 pass；`browser-session`+`delta-frames`+
  `history-window`+`frame-size`：28/28 pass，exit 0
- 浏览器驱动 `node apps/web/e2e/ux-history-prefix.mjs`（先 `pnpm --filter @hepi/web build`，exit 0）：11/11 checks passed
- 文档：`docs/chat.md` 增补单一实现归属与「未见历史 gap 不恢复」限制；`docs/migration-status.md` 更新 prefix 所有者

### Notes

- 未见中间条目的 gap 恢复仍不在范围内（R1），未以反复 state 读取冒充桥接；非重叠 snapshot 不被当作缺口证据。
- `apps/web/package.json` 新增 `@hepi/session` 依赖，lockfile importer 同步（协调者负责 manifest 串行整合）。
- 07 需要的 API：`@hepi/session` 现导出 `reduceSseFrame<TMessage>`、`SessionState<TMessage>`、`HeldEntry<TMessage>`、
  `decidePrefix`/`LoadedPrefix`/`WindowFacts`；`reduceSseFrame` 对 `TMessage` 泛型，HTTP 投影可直接声明 `AgentMessage`。
