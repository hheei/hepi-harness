# 05: Control one conversation from multiple Web UIs

**What to build:** Two independently hosted Web UI instances observe the same durable conversation and can safely submit, steer, abort, reconnect, and resynchronize through one server.

**Blocked by:** 03: Run one durable conversation through the server; 04: Execute one workspace through a local gateway

**Status:** complete (independent localhost production UI integration verified)

- [x] Connect two independent Next production Web UI instances on localhost, with one authoritative backend.
- [x] Verify durable state/final replies and tool history in copied React UI. Live bash output before command completion also verified with FIFO gate.
- [x] Serialize concurrent commands through server semantics and request IDs.
- [x] Verify disconnect/reconnect, snapshot resync, no duplicate messages, and UI closure without stopping the agent.
- [x] Verify cross-instance control through local agent gateway tools using the approved localhost topology. See docs/local-integration.md.

## Comments

The server now deduplicates repeated request IDs through `pi-durable` submission admission, broadcasts one conversation event stream to multiple independent SSE clients, and keeps the durable run alive when one client disconnects. `packages/session` provides the first durable-session adapter seam: snapshot hydration, monotonic event reduction, duplicate-event suppression, gap-triggered resynchronization, and authenticated submissions.

Evidence: backend/session critical tests plus manual independent Next instances, close/reload/control and FIFO live-output smoke recorded in docs/local-integration.md. This does not claim full upstream UI parity.
