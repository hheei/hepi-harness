# pi-web pinned source snapshots (gateway / Backend provenance)

Verbatim source snapshots, not imported modules. Nothing in this directory is on a runtime import path or inside a
TypeScript include list; they are kept so an adaptation can be compared against the original bytes.

- Source: `https://github.com/agegr/pi-web`
- Revision: `76bdc57027172eb381a216d647225a6d24f23360` (v0.10.0)
- License: MIT (`LICENSE`, copied from the same revision; Copyright (c) 2026 agegr)

Ticket 17 (client-app) retired `apps/web/vendor/pi-web/` with the rest of the Next app. These files are the ones a
surviving executable path in this repository still points at, moved here with `cp` so their bytes stay identical to
the upstream pin. Each one's live consumer is named below.

| File | sha256 | Live consumer |
| --- | --- | --- |
| `session-search.ts` | `b4756418688ef210c01d4f3be300a7d6bab6e198df61de678064c07188a5c4b1` | `apps/server/src/session-search.ts` keeps upstream's matcher, bounds and response shape; `apps/server/test/session-search.test.ts` reads this file and asserts every number against it, so the two cannot drift |
| `skill-frontmatter.ts` | `028ce341f1184a0b3770fd145a6119a97b9de2820bc3fe7d3d3b8a18d2e7897f` | `packages/gateway/src/skill-frontmatter.ts` (`setDisableModelInvocation`), whose cases came from the upstream helper's own test file |
| `worktree.ts` | `b19e8cdce9123b03f5d65906df88856b426c5e222d7c4480234a1bdeab323598` | `packages/gateway/src/worktrees.ts`, whose listing resolves a project root through the repository's shared git directory the way this file does |
| `mcp-secrets.ts` | `982c17fe8ddbef7f228c46db2aabbc40a1a38dfb0dd292af28ca2b6e7cedea4d` | `packages/protocol/src/mcp-secrets.ts` was a byte-identical copy of this file; this snapshot stays the provenance |
| `frontmatter.ts` | `93f452802ebcbbdbd336c2a5568addf48e3f9af7c4b5c52746004f3a0aac1d04` | `apps/server/src/agent-definitions.ts` adapts its frontmatter reader |
| `subagents.ts` | `81b36e5e9f5a87d783169ff927ed0bc979d95ed848d2aa5c34509ef1de0f816d` | `apps/server/src/agent-definitions.ts` adapts its profile rules |

Nothing else was carried over: the rest of the snapshot (the app routes, the components, the hooks, the test fixtures
and the remaining helpers) had no executable consumer after ticket 17 and was retired with the directory it lived in.
The upstream project itself is the place to read those.

This is provenance, not a runnable package: there is no `package.json` and no `bin/` here. See
[docs/upstream-sources.md](../../../../docs/upstream-sources.md) for the reuse matrix and the pin.
