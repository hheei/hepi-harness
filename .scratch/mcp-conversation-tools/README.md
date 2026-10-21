# MCP tools in conversations

Status: approved architecture; tickets 01–02 implemented, reviewed and integrated into `integration/client-app`
(`b7c49b3`, `61c2d66`); 03a integrated at `8f71db4`; 03b/03c materialized as numbered tickets 2026-10-19; 03b integrated at `c070e7e`; 03c integrated at `5505f14`; 04 integrated, with a follow-up pass on `impl/mcp-04-child-fork` (base `701add2`) closing its stop/resume and restricted-child grant gaps; 05 resolved on `impl/mcp-conversation-05` (base `c1299df`), where the whole journey found and fixed two material browser defects — an unreachable conversation scope and a grant write that dropped the listing it was choosing from.

- [Specification](spec.md)
- [Ticket proposal](ticket-proposal.md)

| Ticket | Status |
| --- | --- |
| [01 - Gateway invocation contract](issues/01-gateway-invocation.md) | resolved on `impl/mcp-conversation-01` (base `95f9257`), integrated at `b7c49b3` |
| [02 - Durable conversation adapter](issues/02-durable-adapter.md) | resolved on `impl/mcp-conversation-02` (base `b7c49b3`), integrated at `61c2d66` — tool discovery deferred to 03 |
| [03 - Trust and selection](issues/03-trust-selection.md) | 03a resolved on `impl/mcp-conversation-03` (base `ebf26df`, tip `d95d6d4`), integrated at `8f71db4`; 03b/03c now their own tickets — **cut them from the integration tip, not that branch** |
| [03b - Durable per-conversation grant](issues/03b-durable-grant.md) | resolved on `fix/mcp-grants-owner-next`; integrated into `integration/client-app` at `c070e7e` |
| [03c - Browser tool states, refresh and revocation surface](issues/03c-browser-tool-states.md) | resolved on `impl/mcp-conversation-03c` (base `c070e7e`); integrated at `5505f14` |
| [04 - Child/fork lifecycle](issues/04-child-fork-lifecycle.md) | resolved on `impl/mcp-lifecycle-next` (base `e99bed1`), integrated; follow-up on `impl/mcp-04-child-fork` (base `701add2`) closed the stop/resume and restricted-child grant gaps |
| [05 - System acceptance](issues/05-system-acceptance.md) | resolved on `impl/mcp-conversation-05` (base `c1299df`, delivered `53ff1bc`), integrated as `f2d9268`; the journey found and fixed two material browser defects, and its delegated-child row is recorded as unexercised there (04 pins it at the durable seam) |
