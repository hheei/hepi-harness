# 09: 用可运行场景选择动态高度窗口

**What to build:** 在独立夹具中证明完整 turn 可有限挂载且保持滚动/导航，输出可直接指导生产实现的窗口选择。

**Blocked by:** 08

**Status:** done (2026-10-14, worker chat-window); **measurement caveats corrected 2026-10-14** after a review of
this record — see "Caveats" below. The decision (platform measured-height windowing) stands as an architecture choice;
the earlier record overstated what the numbers proved and omitted the prepend scenario the criterion requires.

**Primary source:** the prototype lives in the working tree, not a branch (this session may not commit):
`apps/web/e2e/window-experiment.mjs` (driver) + `apps/web/e2e/window-experiment.fixture.tsx` (fixture). Both are marked
as a prototype and nothing in `apps/` imports them; the production renderer is unchanged, so there is no dual renderer.

**Decision record.** Interface the production window needs, measured here: a window takes the ticket-08 turn
descriptions, the scrolling element, an `overscan` and a **`revealKey`** — the stable identity of one turn the surface
must include even though it is far outside the viewport — and reports how many turns are mounted. A reveal mounts the
named turn *alone*, as a second slice, instead of spanning the distance to it: spanning is exactly what a window exists
to avoid (the platform candidate first mounted 1300 turns for one reveal; the sliced version mounts 7). `ChatMinimap`'s
`onRevealHistory` now passes the turn index, because a windowed transcript cannot scroll to an unmounted node and must
be told which turn to mount.

| Candidate | version / license | mounted turns 200 → 2000 | mounted-turn DOM 200 → 2000 | heap | 20 scroll steps / long tasks | tail return p95/max |
| --- | --- | --- | --- | --- | --- | --- |
| **platform** (selected): ResizeObserver + spacers + remembered per-turn heights | no dependency | 6 → 6 (ratio 1.00) | 201 → 206 (ratio 1.02) | 40 MB | 657 ms / none | 10 ms / 10 ms |
| `@tanstack/react-virtual` (rejected) | 3.14.19, MIT (dev dependency) | 7 → 7 (ratio 1.00) | 234 → 239 (ratio 1.02) | 73 MB | 699 ms / one 51 ms task | 7 ms / 8 ms |

**DOM scope.** The earlier record reported 630 → 4235 "DOM nodes" as if that were the transcript's plateau. It is the
whole scene, and the growth is almost entirely the **minimap**, which draws one node per turn by design and is the
transcript's outline rather than its mounted history: the breakdown at 2000 messages is ~240 elements inside the
mounted turns, ~2 spacers, and ~4000 in the minimap. The number that windowing bounds — the mounted turns' own
subtrees — plateaus at 201 → 206, and both candidates reach it. Bounding the minimap is not this ticket's question; it
is recorded in ticket 10's guide as the outline's own cost.

Both candidates passed the checks the fixture then had: the historical turn mounted while reading is released at the
tail; the turn under the reader stays put through a process expansion plus a 6000-character stream growth (anchor delta
0 for both); a manual process expansion survives its turn being unmounted and remounted; search reveals an unmounted
turn by identity and leaves a bounded window; no page error.

**Caveats on the selection (added after review).** Three things the first record did not say:

- **The fixture never prepended.** The prepend criterion was not exercised by this ticket at all; ticket 10's driver
  does it, and the prototypes fail it (a prepended page leaves the reader's turn unmounted) because they measure
  heights but never correct the scroll position. That is why ticket 10 needed a new module rather than a lift-and-shift
  of the prototype.
- **The fixture's own measurement was the gap, not the candidates' internals.** The fixture measured inside a React
  ref, which runs only on render, so a height change with no re-render (an image decoding, a font swapping in) was
  invisible to it — and the fixture grew turns through React state, which is why the old run appeared to pass. The
  current driver appends a node to the turn directly, which is the real scenario. What is verified about each
  candidate: the **platform prototype's own source** registers a ResizeObserver on the *scroll element only*, never on
  a turn node, so it cannot see that change. The library is **not** claimed to have the same gap: the fixture's
  `measureElement` call is the virtualizer's own registration method, and whether it observes the element internally
  was not examined. The library's failure on that check in the current run is therefore recorded as an observation
  about this fixture, not as a property of the library.
- **The heap comparison is provisional.** The candidates ran in a fixed order in one browser, so 40 vs 73 MB is one
  observation, not a controlled comparison, and it is not the reason for the choice. The reason is that the platform
  primitives are ones the surface already uses and the library's own measurements were not better, so it buys no
  capability for a dependency and a second measurement authority.

**Selection: the platform implementation.** The library's own measurements are not better (one 51 ms long task the
platform does not have, more heap at the same mounted count — provisionally, see the caveat above) and the platform
primitives it wraps are the ones the surface already uses, so the extra dependency and a second measurement authority
buy nothing. Rejected: `@tanstack/react-virtual` for that reason; CSS `content-visibility` alone is not a candidate
at all — it improves layout and paint while keeping every node mounted.

**Stated limitations (not claimed as solved).** A single huge turn cannot be bounded by turn-granularity windowing:
the 2000-message fixture deliberately includes turns with a 2000x tool result and a 400x answer, and a turn that size
mounts whole. `content-visibility` reduces their layout/paint cost and does nothing for their mounted memory. The
loaded (not mounted) history still holds every page the reader paged in; windowing bounds the DOM, not the data.

**Verification:** command `node e2e/window-experiment.mjs` run with the working directory `apps/web` (equivalently
`node apps/web/e2e/window-experiment.mjs` from the repository root — the path exists and the script resolves its own
directory; the earlier record's mismatch was the assumed cwd, not a missing file), exit 0. Raw logs, all from cwd
`apps/web`:
`.dev/verify/2026-10-14-ticket09/experiment-dom.log` (the DOM breakdown), `.dev/verify/2026-10-14-ticket10/experiment12.log`
(the current run, which is the one carrying the prepend and async-height scenarios) and its
`report.json`. Source fingerprint: HEAD `1758c1fb4479e9d4637a957857246c5998619d73` with a dirty tree; the measured
files are the two prototype files, `apps/web/lib/chat-turn-model.ts`, `apps/web/components/ChatMinimap.tsx`, and now
`apps/web/lib/transcript-window.ts` + `apps/web/lib/transcript-window-surface.tsx` for the production candidate.
Dependency, version and license recorded in [docs/upstream-sources.md](../../../docs/upstream-sources.md) ("Windowed
transcript experiment").

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [ ] 基于已采用 turn 描述运行 Markdown、图片、expanded process、streaming、prepend 和 search 场景，不以固定行高掩盖变化。
- [ ] 比较成熟动态高度库或已有平台方案，选择一个并记录 Interface、实际 Adapter、依赖/license、选择理由与被拒方案。
- [ ] 200/2000 messages 同机器/viewport/overscan 比较，mounted-history DOM 增长不超过 2x；回尾部后 offscreen historical mounts 释放。
- [ ] 记录 anchor/tail/search/minimap/展开状态跨卸载结果，选择可重复的 interaction/long-task 验收目标，绑定源码和原始日志。
- [ ] single huge turn 的限制与 content-visibility 只改善 layout/paint 的限制单列，不冒称内存有界。
- [ ] 保留可复用夹具与决策记录，不启用生产双轨 renderer；原型若另开目录/会话，按 handoff/prototype 记录 primary source。

## Verification

运行真实浏览器窗口场景；不做 CSS-only 或 Node element-allocation 比较替代 browser 证据。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。
