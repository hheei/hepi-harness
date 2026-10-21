# 03c - Browser tool states, refresh and revocation surface

Type: implementation ticket
Status: resolved
Blocked by: [03b](03b-durable-grant.md) (answer shape of the durable grant) — 03b integrated at `c070e7e`
Cut from: `integration/client-app` at or after `8f71db4`
Resolved on: `impl/mcp-conversation-03c`, base `382be5f`

Show the four states a person must be able to tell apart — **configured** (host entry exists), **exposed** (host lists it), **selected** (this conversation's grant names it) and **currently available** (a call would resolve now) — with explicit per-server discovery and an explicit revocation action.

Implementation:

- `packages/ui/src/lib/conversation-mcp.ts` — the pure helper: the seam's route and body builders (`?mcp=<server>`, one
  server's whole grant set), the state and listing readers, the four-state row derivation and `mcpPanelState`, an
  allowlisted projection of everything a panel keeps.
- `packages/ui/src/components/McpConversationTools.tsx` — the surface: server blocks, the four states, one "List tools"
  press per named server, one checkbox per grant, one revocation per server, progress and named refusals. Mounted by
  `ExtensionsConfig` in the conversation scope under `hepi.mcp`, so neither shared shell gains a prop.
- `apps/web/adapters/durable-api.ts` — forwards both halves of the seam (read, `?mcp=` query, write) at the backend's own
  status and reason.

Acceptance (from the ticket):

- **Discovery is per named server, on purpose.** Opening the panel makes one request, the state read, which starts no
  server; a server's tools appear only after that server's own press, and no listing is made by rendering a setting or by
  a write's answer to another server.
- **Progress and named reasons.** An empty listing reads as an empty listing, a truncated one states how many of how many,
  a refusal keeps the seam's own code, and a conversation with no execution workspace states that limit before any
  server's. No second status vocabulary.
- **Revocation through 03b's seam.** A grant writes one server's whole set (keeping the tools already chosen) and a
  revocation writes the empty set, which asks a host nothing and works on an offline one. No auto-grant on discovery and
  no grant inferred from a listing.
- **No credentials, resolved values or host paths in browser state.** `mcpPanelState` is an explicit allowlist published
  as a machine-readable attribute on the panel's own root, asserted against a hostile body carrying `sourcePath`,
  `command`, `args`, `env`, `url`, `headers`, `auth`, `token` and `cwd`.
- **An unread host configuration is unknown, not absent** (review follow-up). `serversKnown`/`serversRefusal` come from
  03b's own read, and the panel lists the union of the host's servers and this conversation's granted ones: a server only
  a grant names shows `configured: unknown` and `availability unknown`, keeps its grant, and keeps its revocation —
  which writes an empty set and asks the host nothing.
- **Every answer belongs to the conversation that asked it** (review follow-up). The block is mounted with
  `key={sessionId}`, and each read, listing and write is fenced by the conversation epoch it was made under, so an answer
  that lands after an ordinary switch is dropped instead of painting one conversation's grants, listings or refusals over
  another's; a write that lands while its own conversation is shown again re-reads it, so the next checkbox derives that
  conversation's real set. The extension switch above the block is read from its prop — grants stay, availability goes —
  and a flip re-reads the conversation rather than keeping a snapshot.

Tests: `packages/ui/src/lib/conversation-mcp.test.mjs` (unit, node:test), `apps/web/e2e/ux-mcp-tool-states.mjs`
(Playwright against the production panel with its network boundary replaced; run as
`node apps/web/e2e/ux-mcp-tool-states.mjs`, port override `HEPI_UX03C_PORT`), and
`apps/web/adapters/durable-api.test.mjs` (both spellings of the seam, its query and its refusals).

Docs: [`docs/mcp-on-the-web-host.md`](../../../docs/mcp-on-the-web-host.md) — "A conversation's tool states in the
browser (ticket 03c)" — and the 03c rows removed from "Not built" in the same document and from
[`docs/migration-status.md`](../../../docs/migration-status.md).

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (M1).
