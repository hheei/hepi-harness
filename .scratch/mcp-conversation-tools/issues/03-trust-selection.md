# 03 - Trust and selection

Status: resolved — discovery slice 03a only, integrated — implemented on `impl/mcp-conversation-03` (base `ebf26df`, approved tip
`d95d6d4a0839da62bd6c356b4109c173972b2cd7`), merged into `integration/client-app` as
**`8f71db4412e403ff93d835a0a1dda86aefd084e4`**; 03b is ready; 03c is blocked by 03b. Remaining grant/UI scope lives in those separate tickets; this ticket's resolved status covers 03a only.
Blocked by: 01, 02 — both integrated (`b7c49b3`, `61c2d66`). **Cut 03b/03c from `integration/client-app` at or after
`8f71db4`, not from `impl/mcp-conversation-03`** — the branch's base `ebf26df` predates subtree 03 (`20fcd17`) and the
ticket 16 acceptance batch (`84b7039`), and 03a's own surfaces (`packages/gateway/src/mcp/listing.ts`, the shared
`invocation.ts` exports) exist only on the integration tip now. The adapter this ticket selects through is `apps/server/src/mcp-conversation-tools.ts`, and the
declaration surface it must keep distinct is `apps/server/src/mcp-declarations.ts` (`HEPI_MCP_TOOLS`, `main.ts:115`).

Expose explicit trust/selection for configured MCP tools to a conversation. Keep configured, trusted and currently available states distinct. Default unselected tools to unavailable. Resolve project vs per-conversation storage and safe schema/name presentation within the approved architecture.

Acceptance: untrusted/unselected servers contribute no tools; selected tools are visible before invocation; revocation prevents new calls and handles in-flight calls explicitly; no credentials appear in browser state.

UX closeout (2026-10-19) adds the journey this ticket's slices must land: add/test server → list tools → explicit selection → real model invocation with a visible result, and named states for disabled/untrusted/offline/changed schema. Grants stay explicit and bounded to host tools that already exist; discovery never grants. See [`../../ux-closeout-research/02-provider-mcp-and-settings.md`](../../ux-closeout-research/02-provider-mcp-and-settings.md) (M1) and the cross-effort map [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md).

## The open details are answered (parent-approved 2026-10-19, defaults from the research report)

Research: [`../research/03-discovery-and-selection-contract.md`](../research/03-discovery-and-selection-contract.md) — every claim below carries a `path:line` read at `ebf26df`.

| Question | Decision |
| --- | --- |
| Discovery trigger | Explicit, one named server per request. Nothing lists a server to render a setting; `read` keeps answering from the host's own files and starts nothing. |
| Grant scope | **Per conversation**, an explicit allowlist. No project-scoped grant document until a folder-level need is demonstrated. |
| May the model grant or load a tool? | **No.** `tool_search` is not installed and is not added by this effort; a grant is a person's act. Re-checked before 03b that nothing else reaches `control.addTools` for an ungranted tool. |
| Descriptor storage | Durable per-conversation grant records the tool **identity** plus the descriptor read at grant time; host resolves trust and exposure on every call, so a stored descriptor is a presentation snapshot, never an authority. |
| `HEPI_MCP_TOOLS` | Kept as the **operator fallback**: identities and presentation a deployment states without asking a host, and an unknown entry fails startup. It offers nothing by itself and is no ceiling — 03b resolved this row: what a person may grant comes from the host's listing, and an offer needs the conversation's own grant. Not deleted by 03a. |
| Revocation | Stops **future** calls at once (`resolveTool` settles `tool_unavailable` before arguments and before the host). An in-flight call is left to settle through the caller's abort or the host's deadline; no implicit replay, per 02's `replay: "unsafe"`. |
| Exposure matching | **Exact tool name**, as `invocation.ts` `exposureOf` already behaves. Labels now say so (`packages/ui/src/lib/api-types.ts`); patterns are not implemented by this ticket. |
| List-all-servers call | Rejected. One server per request. |

## Delivered — 03a: the host can answer what a server's tools are

`operation: "tools"` on `POST /v1/mcp`: one configured server, its folder or workspace id, nothing else.

| Piece | Where |
| --- | --- |
| Wire shapes and bounds | `packages/protocol/src/gateway.ts` `MCP_LIST_*`, `McpToolListRequest`, `McpToolDescriptor`, `McpToolList`, `McpToolListFailureCode` |
| The operation | `packages/gateway/src/mcp/listing.ts` — `listServerTools`, a sibling of `#test` reusing `#target` (so **project trust is enforced here too**), `redactorFor`, `connectServer`, and `MCP_LIST_DEADLINE_MS` composed with the caller's abort and the service stopping |
| One rule, not two | `exposureOf`, `SERVER_REFUSALS`, `CONFIGURATION_KEYS` and the new `entrySwitchedOff` are exported from `invocation.ts` and read by the listing, so a listing cannot disagree with a call about exposure, refusal names, or what "off" means |
| Read-only, so a lost answer is retryable | `control.ts` `MCP_MUTATIONS` does not name `tools`, so the transport classifies a lost listing as `gateway_offline`, never `outcome_unknown` — asserted in `test/control.test.ts` |
| Bounds | 30 s; ≤ 8 `tools/list` pages (a server that paginates endlessly cannot hold a host and its child process for a thousand round trips); ≤ 256 descriptors; 300 chars of name/description; 32 KiB per schema (withheld above it, never half-sent); 256 KiB for the whole answer, because a gateway caps a **request** body and sets no total cap on a JSON answer |
| Presentation rules | Server text read by type (numeric description → `title`, non-object `annotations` untouched, `readOnlyHint === true` only); an unnamed tool is left out and the answer says `truncated`; `name`/`description` masked, `inputSchema` verbatim — the same rule `read` applies when it reports `env`/`headers` by name only |

Tests: `packages/gateway/test/mcp-list-tools.test.ts` (9 cases, real `GatewayRpcServer` + `McpHostService` + stdio fixture; the answer's own fields, hostile text, masking of a resolved value with the schema kept whole, the page bound, the byte bound, a configuration-carrying request, a missing/invalid/switched-off server, a folder no decision trusts, `unknown-workspace`, a gateway with no MCP capability, a caller that disconnects mid-listing, and `service.close()` ending a listing that was still reading), and two cases added to `test/control.test.ts`. The stdio fixture gained opt-in tools/cursors/bulk for exactly those cases (`PI_WEB_FIXTURE_LIST_TOOLS`, `PI_WEB_FIXTURE_PAGE_CURSOR`, `PI_WEB_FIXTURE_LIST_BULK`, `PI_WEB_FIXTURE_LIST_DELAY_MS`), so no existing fixture count assertion moved.

Docs: the operation, its bounds and its masking in `docs/mcp-on-the-web-host.md` ("Listing one server's tools"); `docs/migration-status.md and the two source comments that stated "no tool listing exists" now point at 03a and name 03b as the consumer; `GLOSSARY.md` adds Tool Listing, Tool Descriptor and MCP Exposure.

**Nothing consumes it yet, and that is the slice boundary.** The backend still installs what `HEPI_MCP_TOOLS` declares, and Settings › MCP still shows a test's count. No UI, panel or browser state changes in 03a.

## Still open — 03b, 03c (materialized as real ticket nodes 2026-10-19)

The proposal's 03b/03c are now their own numbered tickets; this ticket keeps 03a's delivered scope and history above verbatim.

- [03b - Durable per-conversation tool grant](03b-durable-grant.md) — the durable grant: a conversation-scoped document (identity + descriptor read at grant time, `fork: "initial"`), `deferred: true` registrations under `hepi.mcp`, and one backend writer for `pi.agent.modelTools`. Blocked by nothing outside itself now that 03a answers descriptors.
- [03c - Browser tool states, refresh and revocation surface](03c-browser-tool-states.md) — the browser's four states (configured / exposed / selected / currently available) with explicit per-server refresh and a revocation surface. Blocked by 03b's answer shape.

Both are cut from `integration/client-app` at or after `8f71db4`. Neither adds a second durable adapter or a second listing path; [ticket 04](04-child-fork-lifecycle.md) consumes 03b's grant document rather than defining its own.
