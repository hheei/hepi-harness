# 03b - Durable per-conversation tool grant

Type: implementation ticket
Status: integrated — delivered and reviewed on `fix/mcp-grants-owner-next`, integrated at `c070e7e` and covered by the
system acceptance ticket [05](05-system-acceptance.md) (`f2d9268`, 58 checks, its list → explicit selection → real
invocation rows). `git merge-base --is-ancestor c070e7e main` exits 0.
Blocked by: [03 / discovery slice 03a](03-trust-selection.md) (resolved; integrated at `8f71db4`)
Cut from: `integration/client-app` at or after `8f71db4`, not `impl/mcp-conversation-03`

Consume the host's read-only tool listing (03a, `packages/gateway/src/mcp/listing.ts`) by turning a person's explicit selection into a durable conversation grant. Reuse `apps/server/src/mcp-conversation-tools.ts` and `apps/server/src/mcp-declarations.ts`; **do not add a second adapter, a second listing path, a session tool registry or a browser-held schema.**

Approved shape (parent-approved 2026-10-19, research [`../research/03-discovery-and-selection-contract.md`](../research/03-discovery-and-selection-contract.md) §4-§5):

- **Per-conversation grant document.** Tool identity plus the descriptor read at grant time, `fork: "initial"`. The stored descriptor is a presentation snapshot, never an authority: the host re-resolves trust and exposure on every call.
- **Deferred registrations.** `hepi.mcp` stays the only extension and registers its tools `deferred: true`, so an unset `pi.agent.modelTools` offers nothing.
- **One writer.** The backend is the only writer of `pi.agent.modelTools` for MCP grants, through the existing `configure` seam — the same field the runtime's own `addTools` writes for `tool_search`.
- **Grant and revoke at the existing selection seam.** `PATCH /api/conversations/:id/extensions` answers the selection after the write, with the tools it offers; no new registry concept and no new route family.
- **No automatic grants.** Discovery never grants: listing a server's tools exposes nothing until a person selects it. The model cannot grant or load an ungranted tool (`tool_search` is not installed by this effort); re-check before implementation that nothing else reaches `control.addTools` for an ungranted tool.
- **`HEPI_MCP_TOOLS` keeps its role** as the operator fallback and gains no new ceiling.

Acceptance: a selected listed tool becomes an offered tool for that conversation only; an unselected or untrusted tool stays unavailable; the grant records identity plus the descriptor read at grant time and refuses host-owned keys by name; revocation stops future calls at once (`resolveTool` settles `tool_unavailable` before arguments and before the host) and leaves an in-flight call to the caller's abort or the host's deadline with no implicit replay; backend tests cover grant, re-grant, revoke, missing/unknown tool, descriptor change and no credential in the document.

Existing accepted ownership is unchanged: Gateway owns MCP execution and its configured credentials, the backend owns durable tool settlement with no replay, and no ticket may pass MCP secrets to the backend.

## Delivered

Implemented on `fix/mcp-grants-owner-next` (cherry-pick of `c9b75d9` onto `integration/client-app` `3e69c62`), then
corrected against the review of that commit. What the review changed, and what the code now does:

- **The declaration is not a ceiling.** `mcpListedServer` asks the host which of its files holds an entry of that name
  (`operation: "read"`, `mcpServerScope`) and then lists that scope (`operation: "tools"`). A server the host has no entry
  for is `server-missing`; a name the host did not list is `not_listed`. `undeclared_tool` is gone, and a tool
  `HEPI_MCP_TOOLS` never names is grantable the moment the host lists it.
- **The stored descriptor is the live offer.** `createMcpToolBridge` keeps a registration map and `stage()`s a
  conversation's granted descriptors into it; the extension's `tools` getter is what the runtime resolves, so the model's
  description and the schema its arguments are validated against are the host's, re-granted on the next resolution and
  restored from the store on restart. With a grant provider composed **every** registration is `deferred`, so a declared
  entry is a fallback descriptor and never an offer of its own.
- **One seam, no second route family.** `GET/PATCH /api/conversations/:id/extensions` carry the selection and the grants;
  `GET …/extensions?mcp=<server>` is the one request that lists a server. The `/mcp-grants` routes are gone.
- **Writes go through `configure`.** `writeMcpGrants` and `reconcileMcpOffer` write `pi.agent.modelTools` through the
  runtime's own seam (name carriers, because `AgentChange` narrows registrations to `.name`), and a grant request naming
  a host-owned key (`command`, `args`, `env`, `url`, `headers`, `auth`, `config`, `cwd`, `workspaceId`, `token`) is refused
  by name before anything is written.

A second review (of `b7d3317`) found three defects at these seams, all fixed in the same modules:

- **The scope of a call is the grant's, not the registration's.** One tool name is one registration process-wide, so a
  registration built from whichever descriptor was staged last sent a project grant as `global` and, after another
  conversation's descriptor changed, a global grant as `project`. `McpSelection` now answers `scopeOf(identity)` from
  the calling conversation's own grant, and the request states it; a registration's scope is used only when no grant
  document is composed (ticket 02). `stage()` also compares scope when deciding whether a descriptor changed.
- **An identical re-grant is still newer evidence.** `stage()` skipped a descriptor whose description and schema matched,
  so an older reading staged later (another conversation's attach order) could win. The newest `listedAt` is now always
  kept, and registrations are rebuilt only when presentation or scope actually changed.
- **A grant is admitted before it is written.** Granted descriptors are registered ahead of the operator's fallback, so
  `HEPI_MCP_TOOLS` filling one server's bound no longer suppresses a person's grant; the fallback past the bound is the
  entry named as refused. `McpToolBridge.admits` asks the same bound over the set the write would produce, and
  `writeMcpConversationGrants` answers `offer_unavailable` (409) with nothing written when a grant could not be offered.

Tests: `apps/server/test/mcp-grants.test.ts` (request shape, host-owned keys, the host's read answer, the descriptor, the
filter's shape, durability, adoption) and `apps/server/test/mcp-conversation-tools.test.ts` (a tool **no** declaration
names is listed, granted and run; a granted schema refuses a call before the host is addressed; host-owned keys write
nothing; a call's scope comes from its own conversation's grant across a descriptor change; the newest descriptor wins
over a later-staged older one; a grant is registered ahead of a full fallback and an unofferable grant is refused; plus
the restart, fork, revocation and SIGKILL cases).

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (M1).
