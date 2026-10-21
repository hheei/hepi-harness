# 05: 会话切换缓存一次计量且统一记账

**What to build:** 读者切回已有会话仍恢复原窗口和已加载 prefix，替换、过期和逐出不会重复计量整个缓存。

**Blocked by:** None (can start immediately)

**Status:** done — claimed and implemented by worker 05 on 2026-10-14; result and verification below

**Spec:** [统一设计](../spec.md)

## Acceptance criteria

- [x] Entry 保存 immutable snapshot 与一次测得的 units，store 保存总量；get/set/delete/clear Interface 保持。
- [x] replace、TTL、evict、explicit delete、clear 使用同一减账规则；touch 不 reserialize，oversize 拒绝行为保持。
- [x] 八会话、十分钟、32 Mi UTF-16 code-unit 预算保持，名称和文档不再伪称 heap/UTF-8 bytes。
- [x] 确认生产缓存载荷不可变，修改需求在真正拥有者处解决，避免额外整份 clone 与平行 sizes Map。
- [x] 切换后的 prefix/history head/entry identity 恢复与 deferred originals 流程保持。
- [x] 公开操作测试覆盖逐出和 replace/expiry/clear 后再写；旧覆盖声明及仅为废弃规则存在的 helper/test 删除。
- [x] 同一近预算夹具验证不重扫旧载荷，新 snapshot 序列化成本仍如实记录。

## Verification

现有 cache get/set 测试和生产浏览器 session-switch/prefix 场景；性能结果为 Node 合成或浏览器分别标明。 每次结果保存命令、源版本/dirty指纹、实际退出码和原始日志；本 ticket 更新自己的当前指南。

## Context

读取 [已定决策](../decisions.md)、[导航与 owning guides](../navigation.md) 和 [review notes](../review-notes.md)。按 spec 删除被替代知识与路径；可跨 Module 整理，最终 Interface 应统一且可维护。具体源位置在导航表，本 ticket 的行为目标不绑定过时文件布局。

## Result

Changed paths (only this ticket's owned paths; no caller was edited):

- `apps/web/lib/session-view-cache.ts` — one stored entry (`CacheEntry`: the snapshot by reference, its one `units`
  measure, `savedAt`) plus a store (`CacheStore`: LRU `entries`, running `totalUnits`). `measureSnapshotUnits` runs
  once per accepted write; `remove` is the single subtraction path used by replacement, TTL expiry, explicit delete,
  eviction and clear. `getSessionViewSnapshot`, `setSessionViewSnapshot`, `deleteSessionViewSnapshot`,
  `clearSessionViewCache`, `resetSessionViewCacheForTests` keep their signatures and meanings; the write now takes a
  plain `SessionViewSnapshot` (a settled view is immutable, so no copy and no `Omit<…, "savedAt">`). `MAX_TOTAL_BYTES`
  became `MAX_TOTAL_UNITS` = 32 Mi UTF-16 code units, with the comment naming the unit instead of "serialized bytes".
  No sizes Map, no second accounting owner, no cache framework.
- `apps/web/lib/session-view-cache.test.mjs` — public-Interface tests rewritten around the new rules: per-operation
  accounting (delete/clear/replace/TTL release a measure), an oversize refusal that leaves the store untouched, an
  unmeasurable (circular) payload refused, and prefix/head/identity restore **by reference**. A payload whose `stats`
  counts its own serializations proves the actual "no rescan" rule from outside the module: one measure per write, no
  measure on touch, eviction, delete or clear. The dormant `snapshotCoversLoadedEntries` helper and its test are
  removed — it had no production caller, its claim ("coverage" guarded the write) was already false, and construction
  guarantees the loaded ids are covered.
- `docs/chat.md` — new "The session-switch cache" section: page-memory-only contract, 8/32 Mi/10 min bounds, the unit
  stated as UTF-16 code units of the serialization (explicitly not heap and not UTF-8 bytes), one measure per write plus
  the running total, the single removal path, oversize/unmeasurable refusal, and the by-reference immutability contract.

Immutable caller contract (verified read-only, **no coordinated edit needed**):

- `useAgentSession.ts:873` writes `d.context.messages`/`d.context.entryIds` straight off the parsed response and
  `settled.messages`/`settledEntryIds` from the projection's own view; `useAgentSession.ts:2678` restores
  `prefixEntryIds`/`prefixMessages` into state. Nothing in `useAgentSession.ts`, `ChatWindow.tsx` or
  `lifecycle-projection.ts` mutates a message object, a message array or the cached window in place (no
  `push`/`splice`/`sort`/index assignment on those values; the two mutations in the file are the pure
  `replaceUserMessageText` helper's local `content` array). The old `Omit<…, "savedAt">` signature existed only because
  of the cache's own `savedAt`, not because a caller has a reason to mutate. **Ticket 06 needs no edit here**; if its
  work changes a caller to mutate a window it hands over, that caller must copy first.

Verification (command, source fingerprint, exit code, raw log):

| Check | Command (cwd) | Exit | Log |
| --- | --- | --- | --- |
| Focused public cache tests, 13/13 | `node --test --test-reporter=tap --test-timeout=60000 ./lib/session-view-cache.test.mjs` (`apps/web`) | 0 | `.dev/verify/2026-10-14T16-20-ticket05/cache-tap.log` |
| Session-prefix rule unchanged, 8/8 | `node --test --test-reporter=tap --test-timeout=60000 ./lib/history-prefix.test.mjs` (`apps/web`) | 0 | `.dev/verify/2026-10-14T16-20-ticket05/prefix-tap.log` |
| Web typecheck | `pnpm typecheck` (`apps/web`) | 0 | (stdout: `tsc --noEmit`, no diagnostics) |
| Workspace-memory suite, 12/12 | `node --test … ./components/AppShell.workspace-memory.test.mjs` (`apps/web`) | 0 | `.dev/verify/2026-10-14T16-20-ticket05/appshell-tap.log` |
| Lifecycle hook suite, 20/20 | `node --test … ./hooks/useAgentSession.lifecycle.test.mjs` (`apps/web`) | 0 | `.dev/verify/2026-10-14T16-20-ticket05/lifecycle-tap.log` |
| Docs link check, 0 broken | `node scripts/check-docs.mjs` (root) | 0 | (stdout: 233 files, 0 broken links) |
| Near-budget accounting, Node synthetic | `node --import ./.scratch/development-audit/perf-probes/lib/register.mjs .dev/verify/2026-10-14T16-20-ticket05/measure-accounting.mjs` (root) | 0 | `.dev/verify/2026-10-14T16-20-ticket05/measure-accounting.log` |

Source fingerprint for every run above: HEAD `1758c1fb4479e9d4637a957857246c5998619d73` plus the dirty working tree
(74 modified/untracked files at measurement time, including this ticket's three files and the retained earlier fixes).
No browser run and no production check was taken here — those are the coordinator's integrated step.

Measured limit (Node synthetic, 4 Mi code-unit window, median of 40 writes, **not** a browser or production number):
`writeMs_1_stored: 1.944`, `writeMs_7_stored: 2.087`, `writeMs_8_stored: 1.915`, `touchMs: 0.0001` — a write costs
the payload it stores, flat in the number of stored sessions. `rescanAllStoredMs: 6.972` is what the replaced
per-write accounting paid on every write (and again after an eviction) for the same seven stored payloads, i.e. ~3.5×
the whole new write; that figure is the rescan this change removes, not a browser measurement. The new snapshot's own
serialization cost is real and unchanged: it is the ~1.9 ms above. The `probe-loaded-history-cache.mjs` backend probe
was re-run and now fails at its own cache block (`cacheStore?.values is not a function`, exit 1) because it reads the
removed internal global shape; its backend measurements ran before that point. It is a historical scratch probe, not a
check in any suite, and it was left untouched.

Not done here (coordinator): production browser session-switch/prefix scenario, `pnpm verify:changed` /
`verify --profile=fast`, graph update, integration of the other workers' paths. No deploy, restart or commit was made.
