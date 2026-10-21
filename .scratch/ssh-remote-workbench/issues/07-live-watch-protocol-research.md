# 07 - Live watch protocol research

Type: decision
Status: resolved — live watch stays deferred (2026-10-19)
Blocked by: (none)

Decide — in a document, not in code — what a remote file-watch protocol would have to be, or conclude that live watch
stays deferred. The browser seam already answers a named `501 not_supported` for `type=watch` and the UI's watch
indicator states the absence, so deferral is a supported outcome and nothing here is blocked on it.

What any proposal must answer, from `research.md` and the spec's invariant that watch "emits invalidation hints with
cursor/overflow/resync semantics":

- who produces the events on the execution host (a helper that owns a `read_dir_changed`-style subscription, since
  `fs.watch` semantics are per-platform and a poll is not an event source);
- the cursor and what a reconnect replays, and the overflow marker that forces a fresh bounded listing instead of a
  false continuity claim;
- teardown: how a lost caller ends the host's subscription, and what happens to in-flight invalidations;
- where the stream terminates — the gateway's capability boundary, never a browser-held host credential.

Explicitly out: an implementation, and polling dressed up as event semantics. The deliverable is a decision record (and
an ADR when the choice is hard to reverse), plus the ticket that would follow it if the answer is "build it".


## Answer — 2026-10-19

用户批准 UX 收口调研的 deferred 范围：live watch 继续 501 not_supported，静态 viewer 明示无实时更新；本票的选择结果为保持 deferred，不实现 helper、轮询或事件协议。既有 SSH 工作台不受阻塞。

再次开启条件：用户明确优先 live watch，或真实工作流证明静态刷新不可接受；届时需回答上列 producer/cursor/overflow/teardown/host boundary，再独立排实现。此决定可逆，未选择新的协议，无需 ADR；历史问题保留为未来研究检查表。
