# MCP Tools in Conversations

Status: approved architecture; tickets 01 (Gateway invocation) and 02 (durable adapter) implemented, reviewed and
**integrated** into `integration/client-app` (`b7c49b3` and `61c2d66`); ticket 03 delivered in slices — **03a integrated at
`8f71db4`**, **03b at `c070e7e`**, **03c at `5505f14`**; **04 integrated**, with a follow-up pass on
`impl/mcp-04-child-fork` (base `701add2`) closing the stop/resume and restricted-child grant gaps its delivered audit had
recorded as correct; **05 resolved** on `impl/mcp-conversation-05` (delivered `53ff1bc`, base `c1299df`) and
integrated on this line as `f2d9268` — 58 browser checks over the deployed shape, with its delegated-child row recorded as
unexercised there and pinned at 04's durable seam.
Labels: mcp, conversations, capability-gap
Date: 2026-10-17

## Problem and goal

Users can configure/test MCP servers through Web/Gateway management, but durable conversations cannot invoke MCP tools. Enable explicitly trusted, selected MCP tools in conversations while keeping credentials and MCP connections on Gateway and durable tool lifecycle in backend.

## Approved architecture

MCP servers, connections, config and OAuth credentials execute/remain in Gateway on the selected execution host. Backend owns conversation/tool-call lifecycle and records normal durable tool entries. Backend requests a selected tool through a narrow authenticated Gateway invocation interface; backend never receives MCP credentials and never launches MCP servers. Web does not execute tools.

```text
Backend durable tool lifecycle
  -> narrow authenticated Gateway MCP invocation
  -> selected Gateway MCP client/server connection
  -> MCP server on Gateway execution host
  -> bounded result to backend for durable recording
```

The invocation must bind to a server/tool that Gateway already knows and an authorized conversation/workspace context. It must not accept arbitrary server configuration, credentials or command execution from backend. Support local Gateway first; SSH Gateway behavior must be tested or explicitly unavailable, never implied.

## Principles

1. Reuse existing MCP management, config and OAuth ownership; no second config/auth store or OAuth rewrite.
2. Configured does not mean trusted or exposed. Tool selection is explicit and reviewable.
3. Backend remains source of truth for durable tool calls, result entries, cancellation and run settlement.
4. Tool calls can have external side effects. Restart/retry must not silently repeat a non-idempotent call.
5. Bound tool count, call deadline, output size, concurrent calls and connection lifetime; redact secrets from logs/errors.
6. Keep backend, Gateway and Web responsibilities distinct; use explicit protocol/client seams.

## First-slice scope

In scope: tools/call only; per-conversation exposure of selected already-configured servers/tools; Gateway invocation/result interface; normal durable tool-call/result entries; bounded timeout, cancellation, output and cleanup; honest availability/error states; explicit child/fork policy.

Out of scope: resources, prompts, subscriptions, automatic trust of all configured servers, arbitrary Web-host forwarding, exactly-once external side effects, MCP configuration UI redesign, and OAuth implementation.

## Existing evidence

- Management: `apps/web/adapters/mcp-surface.ts`, `apps/web/adapters/mcp-host.ts`, `packages/gateway/src/mcp/host.ts`.
- Runtime currently rejects/does not execute MCP: `apps/server/src/pi-config.ts`, `apps/server/src/agent-definitions.ts`.
- `@earendil-works/pi-mcp` is used by Gateway management but is not wired as a durable conversation tool provider.
- Backend owns native conversation/tool settlement; Gateway owns host configuration and MCP auth. Invocation is the missing seam.

## Delivery slices

1. **Gateway invocation contract and binding:** protocol, authorization, selected server/tool lookup, limits, cancellation, error/redaction semantics, local/SSH support boundary.
2. **Backend durable tool adapter:** expose selected tools to runtime, invoke Gateway, commit native tool results and settle cancellation/failure without blind replay.
3. **Trust and selection UX:** explicit trusted server/tool selection and clear configured/trusted/available distinctions.
4. **Child/fork scope and lifecycle:** inheritance/restriction, concurrency, connection reuse/isolation and cleanup.
5. **System acceptance:** local/SSH topology, browser journey, failure/replay/security behavior, docs.

## Acceptance

- Configured but untrusted or unselected server contributes no callable tools.
- Selected tools appear with stable names/schema; calls execute on the bound Gateway; results are committed through normal durable tool lifecycle.
- Backend receives neither raw MCP auth nor OAuth credentials; logs/errors redact configured secrets.
- Timeout, Gateway disconnect, malformed result, caller cancellation and backend restart settle explicitly. An uncertain side-effect outcome is surfaced and never silently retried.
- Concurrent conversations and child sessions cannot leak selected tools or request state across authorization scopes.
- Server/tool count, call duration, output bytes, concurrency and resource cleanup are bounded and tested.
- Local Gateway end-to-end journey passes. SSH Gateway is either tested end-to-end or reports explicit unsupported state.
- Focused protocol/Gateway/backend tests, package typechecks and browser acceptance are recorded with revision, commands, exit codes and logs.

## Open details for ticket work

- Whether selection is per conversation, project, or both (default recommendation: explicit per-conversation allowlist, optionally inherited only by an explicit child policy).
- Whether tool discovery/schema refresh occurs when opening a conversation or on explicit refresh; never call MCP servers merely to render unrelated settings.
- Whether Gateway invocation is one bounded request/response or supports progress streaming; cancellation must reach the underlying MCP request either way.
- Exact server/tool naming collision policy and large tool-schema handling.
- Which SSH Gateway configurations can be addressed by the backend's existing capability binding.


## Delivered position after tickets 01 and 02

Slices 1 and 2 are implemented and tested. Slice 1 is `POST /v1/mcp` with operation `invoke` (`packages/gateway/src/mcp/invocation.ts`): one already-configured server and tool, call and conversation identity from the caller, the host's own bounds (60 s default / 5 min deadline, 256 KiB result cut, 64 KiB arguments, 8 concurrent calls), one process per call closed in a `finally`, and a lost answer reported as `outcome_unknown` rather than replayed. Slice 2 is `apps/server/src/mcp-conversation-tools.ts`: one native durable tool per offered entry, `replay: "unsafe"`, the conversation's own `callId`/`conversationId`/`workspaceId`, and the caller's abort handed to the host request.


Two things the approved architecture assumed. The first was missing and 03a delivered it; the second is still slice 3's:

- **Tool discovery is now a Gateway operation.** Before 03a nothing on the MCP route answered "which tools does server *docs* have, and with what schema": `read` reports an entry's exposure and the count of names in its `toolExposure` map, `test` reports a count, and both would have had to connect a server to say more. So ticket 02 shipped a **deployment declaration** — `HEPI_MCP_TOOLS`, a JSON array of `{ gatewayId, scope, server, tool, description?, inputSchema? }` parsed in `apps/server/src/mcp-declarations.ts` — identities and presentation only, host-owned fields (`command`, `args`, `env`, `url`, `headers`, `auth`, `config`, `cwd`, `workspaceId`) refused at startup, and a tool the host does not have answered by the host as `unknown-tool`. Nothing in the declaration path is a second authority over the host's configuration.

  03a answers the question with `operation: "tools"` (`packages/gateway/src/mcp/listing.ts`): one named server, connected on purpose as a sibling of `test` and closed again whatever answered, project-trust-gated through the same `#target` door a call uses, bounded (30 s, at most 8 `tools/list` pages, 256 descriptors, 300 characters of a name or description, 32 KiB per schema, 256 KiB for the whole answer), masked on the server-authored fields, and **read-only** so a lost answer is a transport failure to retry rather than an outcome whose effects are unknown. Nothing consumes it yet: turning a listed descriptor into a conversation's grant is 03b, and the panel that shows a person a tool list is 03c.

- **Selection is per extension, not per tool.** A conversation selects `hepi.mcp` through the existing `PATCH /api/conversations/:id/extensions` seam, so "configured", "exposed by the host", "selected by this conversation" and "currently available" are distinct, but within the extension every offered tool arrives at once. Per-server and per-tool trust/selection, availability presentation and the revocation path are slice 3's. Where a discovered descriptor is stored is now decided: **per conversation**, as an explicit allowlist, with the descriptor read at grant time kept beside the identity — parent-approved 2026-10-19, recorded in `issues/03-trust-selection.md`.

## UX closeout addendum (2026-10-19)

The provider/MCP/settings UX closeout ([`../ux-closeout-research/02-provider-mcp-and-settings.md`](../ux-closeout-research/02-provider-mcp-and-settings.md), M1) found the missing seam is the same one this spec already names: the durable adapter exists and does not consume live listing, and user configuration alone does not grant a conversation individual tools. It changes no decision above and adds no slice:

- The proposal's 03b/03c are now real numbered tickets — [03b](issues/03b-durable-grant.md), [03c](issues/03c-browser-tool-states.md) — cut from `integration/client-app` at or after `8f71db4`. [04](issues/04-child-fork-lifecycle.md) consumes 03b's grant document.
- Grants stay **explicit and bounded to host tools that already exist**. Discovery, testing or listing a server never grants, and there is no automatic inheritance: child, fork and restart behavior is 04's explicit policy over the durable grant, with `replay: "unsafe"` / `outcome_unknown` settlement preserved.
- Configured / exposed / selected / available remain four distinct states; the browser journey is "add/test server → list tools → explicit selection → real invocation with a visible result", with named states for disabled, untrusted, offline and changed schema.
- Do not add a second durable adapter, a second listing path or a session tool registry to close this out.

Cross-effort execution map: [`../ux-closeout-research/spec.md`](../ux-closeout-research/spec.md) (created by parent).

## Integration with Hepi Full-Stack Rewrite

This effort remains a focused capability spec. It does not create a competing client ingress, Backend runtime, durable store, execution Gateway, or Web/App state layer. When implemented, its public seam, ownership and acceptance must integrate through the main full-stack rewrite spec and ticket breakdown; overlapping work belongs to the owning main ticket rather than a duplicate implementation.



Each implementation slice updates its owning current MCP/client-ingress guide and migration-status.md;05 verifies alignment. Normal configured/trusted lifecycle and existing evidence cover capability states; do not design/run bypass probes against authorization, preflight or system constraints.
