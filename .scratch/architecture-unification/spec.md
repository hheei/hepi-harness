# 统一 Module 设计与有界呈现

Status: resolved — implementation and functional acceptance complete on the then-current working tree (2026-10-14/15),
per-ticket state in [the ticket breakdown](ticket-breakdown.md). Current behavior: [Chat](../../docs/chat.md).
Authorization: 2026-10-14 用户授权将全部可执行方案落实为 spec 与 tickets；设计目标为统一、优美、简洁、易维护，不以最小修改为目标。
Baseline: master 1758c1fb4479e9d4637a957857246c5998619d73 + 当前未提交的 audit/design 修复。不是线上部署，也不是该 SHA 的纯净源码。

## Problem Statement

用户需要一个在本地和 SSH Execution Host 上行为一致、长历史依然可用、慢终端消费者不会拖累网关的工具。当前持久事实的归属正确，但装配、旁证发布和原始帧声明重复；终端无在途预算，历史挂载持续增长，缓存重复计量，部分控件把能力未知或未实现呈现为错误操作。

零散补守卫只能延长这些重复路径。维护者需要更深的 Module：共同事实与规则各有一个拥有者，真实变化由 Adapter 表达，替换完成时删除旧表示与旧流程。

## Solution

保持 native durable 的唯一权威、Execution Host 身份与主机凭据归属。统一 Gateway 启动、原始投影帧与快照接收；终端按有限积压断开慢消费者并用既有 replay/reset 恢复；缓存一次计量；已加载历史独立于挂载窗口；界面如实呈现只读 trust 与未知能力。

九项可执行方案全部包含。允许跨模块整理 Interface、派生状态和测试；设计统一不等于把不同单位、不同生产者合同或不同来源动作合进万能 Module。最终不存在长期双轨实现、兼容 shim 或废弃 fallback。

## User Stories

1. As a terminal user, I want slow receivers detached without killing my Terminal Session, so that the shell continues.
2. As a terminal user, I want cursor-based reconnect and explicit reset after a replay gap, so that displayed output is truthful.
3. As a multi-tab user, I want normal aggregate replay to succeed, so that budget enforcement does not cause reconnect loops.
4. As a terminal user, I want input, resize and another receiver to remain usable during slow output delivery, so that slow delivery does not interrupt interaction.
5. As an operator, I want idle heartbeat and cleanup consistent across terminal routes, so that either startup route stays usable when idle.
6. As an operator, I want CLI and standalone Gateway startup to apply the same resolved configuration and capabilities.
7. As an operator, I want SSH workspace identity errors rejected consistently rather than silently ignored, so that requests cannot run in another workspace.
8. As an operator, I want surfaces closed before their SSH master and journal resources are released, so that shutdown does not strand owned resources.
9. As an agent user, I want duplicate call lookup to return the original bounded capture without executing again.
10. As an agent user, I want UTF-8 capture truncation and spill reporting unchanged while verbose output costs less CPU, so that verbose tools remain responsive without corrupting output.
11. As a chat user, I want recently visited settled history restored immediately with the same LRU and TTL policy.
12. As a chat user, I want replacing or expiring cached history to release its budget accurately, so that normal later snapshots remain cacheable.
13. As a chat user, I want stale HTTP/SSE observations rejected for both messages and accompanying facts, so that an older transport cannot rewind accepted state.
14. As a chat user, I want equal-revision remount hydration to remain supported, so that returning to a conversation hydrates its metadata.
15. As a chat user, I want model overrides, tool loadout, failure and queued-message facts applied only by their rightful observation, so that all displayed facts describe the same accepted observation.
16. As a chat user, I want older loaded history preserved across reconnect, with compaction re-baselining it explicitly, so that recovery retains my readable context.
17. As a long-history reader, I want only nearby complete turns mounted, so that loading more pages does not retain all DOM.
18. As a long-history reader, I want prepend and dynamic height changes to preserve the message I am reading, so that reading older history remains stable.
19. As a chat user, I want tail-follow only when appropriate, so that live output does not move me away from old history.
20. As a search user, I want unloaded and unmounted entries located and revealed using their stable identities, so that I can navigate beyond the mounted window.
21. As a chat user, I want minimap navigation, process expansion and session-switch restoration preserved after windowing, so that existing navigation remains usable.
22. As a chat user, I want deferred copy/edit to recover full originals regardless of mounting state, so that my copied or edited prompt preserves its original content.
23. As a Settings user, I want transient fetch failure distinguished from explicitly unsupported capability, so that a transient network problem does not erase useful controls.
24. As an MCP user, I want trust status and host-side instructions instead of a button that always fails, so that the interface describes the served trust contract.
25. As a maintainer, I want one raw wire definition consumed by backend, clients and Web while presentation adaptation stays explicit, so that one wire change cannot drift across transports.
26. As a maintainer, I want one snapshot acceptance/publication owner rather than duplicated guards, so that adding a fact requires one owning change.
27. As a maintainer, I want changed behavior tested through existing public Seams and replaced scaffolding removed, so that behavioral evidence survives refactoring.
28. As a maintainer, I want evidence tied to exact source and fixtures, so that synthetic timings are not presented as browser or production results.

## Implementation Decisions

1. **Ownership stays fixed.** Backend owns durable facts, admission and storage; Web projects and presents; Gateway owns Execution Environment capabilities. MCP reaches the Web Execution Host directly. Opaque workspace identity never becomes a parsed path. Existing ADRs 0001, 0005, 0006 and 0007 remain authoritative.
2. **One raw frame contract.** Protocol exports transport-neutral raw snapshot/delta and related facts. All production consumers migrate in one green slice where feasible. Web display types remain Adapter output. Runtime parsing and recovery contracts remain intact; no serialization format or database migration is required.
3. **One Gateway composition.** A shared startup Module consumes resolved local/SSH configuration and returns the existing running-handle behavior. It owns registry, journal, runners, surfaces, listening and close. Entries retain configuration acquisition, signals and presentation. Defaults, state directory semantics, runtime registration and Local/SSH capability differences are preserved. Heartbeat and SSH workspace validation become consistent.
4. **Bounded terminal connection.** All event and heartbeat writes share encoding/budget/closed handling. Synchronous subscribers write directly; a slow connection is disconnected at a finite stated byte budget. Connection-owned cleanup unsubscribes every attachment and clears timers once; shell lifecycle is untouched. Single-session exit closes its response; fan-in exit affects only that session. Remove queue/wake/consumer loops instead of adding drain-driven queues.
5. **Replay feasibility is a completion condition.** Choose and document finite limits using normal multi-tab and worst encoding fixtures. Large legal replay must have a bounded initial-delivery path or explicit capacity outcome; it must not trigger endless reconnect. A budget cannot grow without bound with tab count. Preserve offsets and reset meaning; permanently slow consumers are not promised lossless history. Numeric choices are resolved by ticket evidence, not silently guessed.
6. **Capture representation.** Each stdout/stderr capture owns chunks, retained UTF-8 byte count and clipping state. Append measures new input, cuts at complete character boundaries and finalizes once. Live delivery, ledger replay, outcome-unknown, spill and unsupported-spill semantics stay unchanged. This is independent from terminal producer pacing.
7. **Measured cache entries.** Existing cache Interface stores an immutable settled snapshot with its one-time UTF-16 serialized-length measure and a running total. Replacement, expiry, explicit deletion, eviction and clear use consistent accounting. LRU touch is not remeasurement. Preserve eight-session, nominal 32 Mi code-unit and ten-minute policies. Correct unit names and stale coverage claims; remove helper/tests that describe an abandoned cache rule.
8. **One accepted-facts receiver.** HTTP and SSE normalize shared statements into one ingestion Interface which asks the pure lifecycle fold and commits common facts only on acceptance. Acceptance is not a second clock. Source-specific prefix/cache/checkpoint and live rendering effects remain explicit and use the same decision. Independent agent-state reads keep their own ordering. Consolidate duplicated derived state when selectors can express it; the pure fold remains free of I/O.
9. **Data and mounting are separate.** Existing grouping becomes stable complete-turn render descriptions before JSX creation. Include leading/non-user history, tool pairing and trailing live/pending surfaces. Loaded history and cursors belong to data acquisition; viewport/overscan belong to rendering. Remove monotonic visibility expansion and full-history JSX creation.
10. **Windowing is evidence-led.** A runnable experiment selects a mature dynamic-height solution or validated platform implementation, then production adopts one implementation. Preserve measured heights, anchors, tail intent, search/minimap reveal, expanded state across unmount, history-head changes, session switching and deferred text recovery. A single huge turn remains a stated limitation; content-visibility alone is not a mounted-memory solution.
11. **Honest capability UI.** Only explicit unsupported replies mean unavailable. Fetch failure remains unknown/retryable without automatic background retry. The present trust contract is read-only plus host-side action instructions; remove the Web trust mutation and its dead state. Do not add a new trust writer or route credentials through the backend.
12. **Unified by responsibility.** Frame bytes, capture UTF-8 bytes and cache code units have different owners. Reuse platform primitives and genuine existing Adapters, not a general budget engine, capability registry, factory hierarchy or scheduler. Source length may increase for necessary window behavior, but duplicated authority and superseded paths must disappear.

## Testing Decisions

- Test the highest existing Seams: real Gateway HTTP/socket and installed CLI; real backend HTTP/SSE consumed through protocol/session/Web; cache get/set; pure fold plus HTTP/SSE acquisition; production-browser transcript/Settings/MCP routes. Never equate callback waiting in the RPC client with server producer pacing.
- Retain existing prior art: terminal replay/lease/heartbeat and SSH smoke, capture/journal replay, snapshot ordering/remount, cached-prefix reconnect, deferred text, visible turns/search/minimap and Settings browser scenes. Replace obsolete tests after equivalent public behavior is covered; do not layer assertions mirroring implementation.
- Window experiment and production comparison use the same fixture, viewport, source fingerprint and machine. Compare 200 versus 2,000 messages: mounted-history DOM must plateau within 2x for comparable bounded turns at fixed viewport/overscan, and returning to tail releases offscreen historical mounts. Report huge-turn limitations separately. Prototype chooses reproducible interaction/long-task targets before production adoption; report p95/max and post-GC heap rather than fabricated universal timings.
- Terminal slow-socket experiments are bounded by emitted volume and deadline, clean up owned PIDs, prove finite queue behavior and recovery. Include control-character/Unicode encoding, aggregate replay, an independent consumer and repeated connect/disconnect. Public input/resize and lease behavior must remain intact.
- Compare capture chunk-size scaling at its real execute seam, with multibyte clipping, stdout/stderr separation and repeat-call lookup. Algorithm replicas cannot establish live Gateway latency.
- Integration runs changed checks and the fast gate; focused browser/SSH/installed-artifact checks cover behavior selectors cannot infer. Account for the existing Web failure-name set explicitly; do not claim the suite green or delete unrelated tests. Reuse unchanged evidence.
- Every reported run records command, tested SHA plus dirty/source fingerprint, actual exit and raw log. Old logs and overwritten runs cannot be mixed. Fixtures are not production PTYs, browser traces or live-host measurements unless actually run at those Seams.

## Out of Scope

Deployment/restart/publishing; any build on remote-host; database changes; new durable runtime, provider/OAuth/push/export features; remote workbench; branch navigation; Web trust mutation; lossless output for permanently slow consumers; a universal queue/cache/budget framework.

No speculative rewrite of synchronous journal, catalogue indexing, session search, SSH transport reuse or Terminal Session admission limits. Those recorded items remain covered by explicit revisit conditions. The user's approval covers all actionable solutions, not arbitrary features invented from every advisory.

## Further Notes

Source evidence: [architecture synthesis](../architecture-routes/README.md), [solution comparison](../architecture-routes/solutions.md). Process: [ask matt route and settled decisions](decisions.md). Work graph: [ticket breakdown](ticket-breakdown.md). Implementation navigation and guide ownership: [navigation](navigation.md). Non-blocking limits: [review notes](review-notes.md).

This document is the approved-scope synthesis, not a claim that its prose was separately line-by-line approved or that anything is implemented. Runnable selections are explicitly delegated to tickets 03 and 09. Current product guides remain current until each implementing ticket updates its owning guide.
