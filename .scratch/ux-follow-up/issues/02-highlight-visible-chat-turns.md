# 02: 右侧导航高亮全部可见 turn

**What to build:** 右侧导航反映所有与聊天视口相交的 turn，同时保留独立的点击/键盘导航焦点。

**Blocked by:** None (can start immediately within the authorized dispatch phase)

**Status:** complete — merged as 8ffe804; browser regression green on the merged tree

**Dispatch phase:** A — bug fixes (01–04 first)

**Stories:** 4, 5

- [x] 完整可见及上下边缘部分可见的 turn 均高亮，离开视口后取消。
- [x] 流式内容增长、窗口调整和折叠/展开后重新计算，点击及键盘导航仍正常。
- [x] 使用确定的浏览器布局验证多个可见项，不依赖固定等待或私有状态断言。

**Context:** [Approved spec](../spec.md). Before choosing work, read [dispatch order](../ticket-breakdown.md#dispatch-order).

## Implementation

`apps/web/components/ChatMinimap.tsx` 用两个独立状态换掉了单一的 `activeIndex`：

- `visibleIndices`：与视口相交的 turn，由 scroll/resize/measure 重算；判定使用每个 turn 的
  `scrollTop` 与 `bottom`。`bottom` 取下一个 turn 的起点，最后一个 turn 取
  `scrollHeight`，因此 turn 覆盖自己的回答以及最后一个 turn 的流式尾段。
- `focusedIndex`：仅由点击/拖拽/键盘导航设置，不再有 1600ms 锁，也不再被滚动覆盖。

DOM 契约：`data-minimap-node-visible`（视口内）与 `data-minimap-node-focused`（导航焦点）。
高亮填充/边框跟随 visible，焦点环跟随 focused。

## Red / green evidence

红（`git show HEAD:apps/web/components/ChatMinimap.tsx` 还原改动前组件，其余不变）：

```
node apps/web/e2e/ux-visible-turns.mjs
UX-02 FAILURES: 22 项
- at the top only the intersecting turns highlight -> expected [0,1], visible [], focused []
- the clicked turn becomes the navigation focus -> expected [3], visible [], focused []
- a taller viewport highlights every turn it now intersects -> expected [1,2,3], visible [], focused []
```

改动前没有任何 visible/focused 契约，且单一 activeIndex 只挑视口 30% 处最近的一个 turn。

绿（当前分支，同一命令）：

```
UX-02 BROWSER CHECKS PASSED
  ..  turn spans [0,300,600,900] heights [300,300,300,300], content 1200px, viewport 400px
  ok  at the top only the intersecting turns highlight -> [0,1]
  ok  a turn whose header is scrolled offscreen still highlights from its answer -> [1,2]
  ok  adjacent clipped turns are highlighted together
  ok  collapsing a turn recomputes which turns cover the viewport -> [1,2,3]
  ok  the clicked turn becomes the navigation focus -> [3]
  ok  a taller viewport highlights every turn it now intersects -> [1,2,3]
```

## Verification seam

`apps/web/e2e/ux-visible-turns.mjs`（`pnpm --filter @hepi/web test:visible-turns`）用工作区自带
esbuild 打包真实 `ChatMinimap` 与固定布局 fixture（`ux-visible-turns.fixture.tsx`），
在 127.0.0.1:43102 提供临时构建目录，用已安装 Playwright 读取真实 DOM 属性、滚动位置和真实鼠标/键盘事件。
期望的可见集合由 fixture 自身渲染出的 turn 矩形独立计算（oracle），不是复制实现的公式。
无固定 sleep，全部等待可观察 DOM 条件；不读取组件私有状态或源码字符串。

已运行：`pnpm -r typecheck`（6/6）、`pnpm -r test`（151 通过）、`pnpm --filter @hepi/web test:upstream`
（15 通过）、ChatWindow/ChatMinimap/MessageView/useAgentSession 相关 web 子集（138 通过）、本 ticket 浏览器回归。
未改动生产 `.next`、未重启任何服务、未调用付费 provider。
