# Ticket proposal: MCP tools in conversations

Status: approved architecture; complete. 01-05 delivered and integrated (05 delivered `53ff1bc`, integrated `f2d9268`); the edges below are the order the work actually shipped in, not open blockers.

| Ticket | Blocked by | Delivery |
| --- | --- | --- |
| [01 - Gateway invocation contract](issues/01-gateway-invocation.md) — **done** | None | Narrow authorized invocation protocol, tool lookup, limits/cancellation/errors |
| [02 - Durable adapter](issues/02-durable-adapter.md) — **done** | 01 | Native tool exposure/invocation/settlement in backend |
| [03 - Trust and selection](issues/03-trust-selection.md) — **03a done** | 01, 02 | 03a host tool listing (integrated `8f71db4`); 03b/03c split out below |
| [03b - Durable per-conversation grant](issues/03b-durable-grant.md) | 03 (03a) | Conversation-scoped grant document, deferred registrations, one `modelTools` writer, explicit revoke |
| [03c - Browser tool states, refresh and revocation surface](issues/03c-browser-tool-states.md) | 03b | Configured/exposed/selected/available, explicit per-server discovery, revocation surface |
| [04 - Child/fork lifecycle](issues/04-child-fork-lifecycle.md) | 02, 03b | Propagation policy over the grant document, concurrency, restart-safe settlement, cleanup |
| [05 - System acceptance](issues/05-system-acceptance.md) — **done** | 03c, 04 (earlier tickets transitively covered) | Local/SSH/browser verification, docs and closeout; 58 checks, delegated-child row unexercised here |

03b/03c are cut from `integration/client-app` at or after `8f71db4`, not from `impl/mcp-conversation-03`. The tickets preserve Gateway execution and backend-owned durable tool settlement. Each vertical slice must keep credential material on Gateway; no ticket may work around limits by passing MCP secrets to backend. Grants are explicit, bounded to host tools that already exist, and never created automatically by discovery; child/fork/restart behavior follows the lifecycle ticket rather than an implicit inheritance rule.

Cross-effort execution map: [`../ux-closeout-research/spec.md`](../ux-closeout-research/spec.md) (M1, created by parent).
