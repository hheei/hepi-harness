# Graph-first code navigation

Use graphify to locate symbols, relationships and ownership before opening large source areas. Read the returned
source files to confirm behavior; the graph is a navigation index, not proof of runtime behavior or complete call
coverage.

## Find the owning code

1. From the repository root, use the configured graphify MCP when available (see [Repository MCP and child
   agents](#repository-mcp-and-child-agents)), or run one narrow query with an actual symbol, method or file name.
   Start with a small budget; natural-language topic words can seed unrelated communities. Use the CLI path below
   because bare `graphify` is not on this workstation shell's PATH.

   ```bash
   ~/.local/bin/graphify query "changedChecks" --budget 1000
   ~/.local/bin/graphify query "workspace-resources.ts" --budget 1000
   ```

2. Read the returned `source_file` near `source_location`, then inspect relevant callers, tests and the owning guide.
   For a relationship use `path`, for one concept's neighbors use `explain`, and for reverse impact — what breaks
   when a symbol changes — use `affected`.

   ```bash
   ~/.local/bin/graphify path "verify.mjs" "changedChecks"
   ~/.local/bin/graphify explain "changedChecks"
   ~/.local/bin/graphify affected "changedChecks" --depth 2
   ```

3. Each new discovery question starts from its own narrow query, including inside a delegated task: a second
   symbol, file or data flow gets its own `query`, not a broad read of the area around the first answer. Repeating
   the same query adds no evidence; a *new* question is what earns a new query.
4. If output is truncated or seeds are irrelevant, refine to a more specific symbol/file rather than repeatedly
   increasing the budget. `--budget` is a target, not a strict output cap. For call-flow questions, narrow edges with
   `~/.local/bin/graphify query "changedChecks" --context call --budget 1000`; for one symbol's immediate neighbors,
   use `explain` instead of a two-hop query. If `path` reports ambiguous matches, use a distinct file/symbol name;
   `--undirected` explores connectivity only and does not establish call direction. `affected` traverses edges in
   reverse and inherits the same ambiguity, so confirm each returned dependent in source.
5. Valid fallback reasons — a missing CLI or graph, stale locations, unsupported relationships, or a narrow retry
   that is still low-value — justify focused `grep`/file reads. State the reason briefly in the task notes or
   handoff. An absent edge does not prove absence of a dependency.
6. For broad navigation, use `graphify-out/wiki/index.md` if present. Otherwise start from
   [architecture](../architecture.md) and the [documentation index](../README.md), then query specific symbols.
   Read `graphify-out/GRAPH_REPORT.md` only for a broad structural review or when scoped navigation is insufficient.

Dirty graph outputs are expected and do not invalidate querying. Compare `built_at_commit` in graph metadata with
`git rev-parse HEAD` when relying on locations, but matching commits do not establish freshness: uncommitted edits
can shift lines too. Confirm locations against current source. A stale graph can still identify candidate files;
refresh when needed and record uncertainty instead of trusting stale line numbers.

## Deep semantic graph (supplemental)

`graphify-out/graph.json` is the default graph: the deterministic AST pass. A deep build adds a semantic pass over
docs and prose on top. Keep the two graphs separate; do not overwrite one with the other.

Two different axes describe an item, and neither alone identifies the tier:

- **`_origin`** is the tier that produced it: `ast` or `semantic`. The AST pass stamps `ast`; the semantic
  pass does not stamp, so a semantic item is recognized by the shape backfill graphify applies when it reads an
  existing graph for an incremental merge (`source_location: null` versus the `L<line>` a deterministic extractor
  emits). A missing marker is therefore unknown rather than proof of either tier.
- **`confidence`** is provenance of that one relationship: `EXTRACTED` was parsed from syntax, `INFERRED` is a
  judgment. The **AST pass emits `INFERRED` heuristic edges of its own** — `indirect_call`, and low-confidence
  `calls` near `confidence_score` 0.8 — so "default graph" does not mean "all edges parsed", and `INFERRED`
  alone does not mean "deep build".

A `semantic` item is not equivalent to an `ast` one just because both live in a `graph.json`.

The CLI writes under `<out>/graphify-out/`, so a deep build is directed away from the default in either of two
ways:

```bash
# Headless CLI: --out sets the parent directory, no change of working directory needed.
~/.local/bin/graphify extract . --mode deep --out graphify-deep   # -> graphify-deep/graphify-out/graph.json
```

The skill's own bash blocks write to `graphify-out/` relative to the working directory, so `/graphify <path>
--mode deep` run from a `graphify-deep/` working directory reaches the same layout. Both routes land on
`graphify-deep/graphify-out/graph.json`; that layout is this guide's convention, so confirm what a build actually
wrote. Building a deep graph is a deliberate, token-costing run — not routine navigation, not what
`graphify update .` does, and not run concurrently by children.

When a deep graph exists, query it as a supplemental layer:

```bash
~/.local/bin/graphify query "changedChecks" --graph graphify-deep/graphify-out/graph.json --budget 1000
~/.local/bin/graphify explain "changedChecks" --graph graphify-deep/graphify-out/graph.json
```

Use it for concept-level and cross-document relationships the AST pass cannot express. `semantic`-origin and
`INFERRED` edges are candidates, not facts: confirm each in source before relying on it, and prefer an
`EXTRACTED` `ast` edge from the default graph when the two disagree. The MCP server serves the default graph only,
so a deep graph is reached through the CLI.

Both `graphify-out/` and `graphify-deep/` are extraction output. Git and
[.graphifyignore](../../.graphifyignore) exclude both.

## Delegate without repeating discovery

A handoff states workspace, owned paths, relevant local checks, and either the graph location or a small query result
naming the query and source locations. Read-only children without CLI access use the supplied result, confirm in
source and report that limitation. Exact-file edits and reviews can reuse parent navigation; a genuinely new question
inside the task gets its own narrow query. Children report the queries they ran, their evidence, and the paths they
changed. Shell-enabled agents in other worktrees query the coordinator's graph:

```bash
~/.local/bin/graphify query "changedChecks" --graph /absolute/primary-checkout/graphify-out/graph.json --budget 1000
```

Results refer to the graph's source snapshot. Resolve relative source paths in the child checkout and recheck symbols
there; a shared graph is not evidence that worktrees have identical revisions or local edits. Children do not rebuild
the shared graph concurrently.

## Refresh once per completed code batch

The coordinator runs this once after integrating a batch of code edits, not per file, child agent or test run:

```bash
~/.local/bin/graphify update .
```

This is local AST extraction, no API cost. It is separate from product verification and does not belong in every
`verify:changed` run. Docs-only edits do not require a code graph refresh; refresh explicitly if updated headings
need to become discoverable. Failed refreshes are reported as navigation limitations, not product test failures.
Explicit `/graphify` requests load the installed skill and follow the requested query/rebuild mode. Routine queries
use the existing graph and do not start the full extraction pipeline.

## Coverage and interpretation

[.graphifyignore](../../.graphifyignore) defines the first-party extraction boundary: the skill store and submodule,
vendored upstream snapshots and generated graph output (`graphify-out/`, `graphify-deep/`) are excluded. First-party
tests and historical Markdown can still be returned; distinguish implementation from tests and dated evidence by
source path.

The default graph is the AST pass: deterministic parsing of imports, calls, containment and references. It is not a
semantic reading of prose — Markdown headings are indexed as document nodes, images are absent — and it is not
all-EXTRACTED: its own heuristic edges are `INFERRED` even though the pass is deterministic. Community names are
deterministic highest-degree hub names, not curated subsystem boundaries. Imports, calls and paths scope an
investigation but do not capture dynamic dispatch, HTTP/SSE contracts or runtime wiring. A deep graph adds
semantic-tier nodes and edges on top of that, extending coverage of prose and concepts with model judgments rather
than parsed structure. Read the owning implementation and guide for those contracts.

## Repository MCP and child agents

`.pi/mcp.json` adds a stdio `graphify` server to Pi's user-level MCP configuration; it does not copy global
credentials or replace unrelated servers. It starts `~/.local/bin/graphify-mcp` against
`graphify-out/graph.json` relative to the session directory, so start parent and children from the
repository/worktree root with its own graph; for a child using another directory or a shared graph, pass parent
navigation or adjust that workspace's server path explicitly. Project resources require Pi project trust.

Only graph navigation tools are exposed, deferred: `query_graph`, `get_node`, `get_neighbors`, `get_community`,
`god_nodes`, `graph_stats`, `shortest_path`. PR tools remain hidden. Discover with `tool_search` or codemode
`searchTools`; for a bounded local query use `question`, `depth: 1`, `token_budget: 1000` and, for call flow,
`context_filter: ["call"]`. Use `get_node` for immediate symbol inspection. The CLI remains a fallback, and the MCP
server serves the default graph only; reach a deep graph through the CLI.

Worker (`.pi/agents/worker.md`), reviewer (`.pi/agents/reviewer.md`) and scout (`.pi/agents/scout.md`) definitions
preserve each global role's model, thinking, baseline tool set and built-in role instructions. All three enable the
configured MCP servers with `mcp: true`, and all three add `tool_search`/`codemode` on top of that baseline so a
child can reach `query_graph` and friends directly — the deferred exposure means no graph tool is reachable without
one of those two. Reviewer retains read-only tools and its review skill list, plus graphify. Worker
uses `skills: ["+graphify"]` to retain the parent catalog and add graphify; scout narrows to `skills: [graphify]`
so reconnaissance carries the graph skill without the whole parent catalog. Child Hindsight isolation remains
enforced by pi-subagents; enabling MCP does not bypass it.

Each file's frontmatter only; the body is left empty on purpose, because a discovered definition with an empty body
keeps the built-in role instructions while its frontmatter merges onto the built-in defaults. Widening a built-in's
tool list this way is legal only because the project path is not the built-in's `<builtin>/` source path. Resolve
the definitions with the pi-subagents resolver after editing them; a frontmatter field the resolver rejects, or a
model the registry does not know, fails there rather than in a child session.

Pi agent discovery replaces a global same-name definition with a project definition: there is no `extends` or
dynamic global-agent merge. These three files are snapshots of current global role settings; reconcile them when
changing global models, tools or reviewer skills. MCP/settings resources still use Pi's native global + project
merge. The complete pinned skill repository lives under `.pi/skills/`; categorized skills are under
`.pi/skills/skills/<category>/<name>/`. `graphify` retains its link into the shared store. Pi discovers that
directory directly; there is no separate `.agents/skills` checkout or per-skill forwarding layer.
`.pi/settings.json` adds only the existing global ponytail-review skill path. Skill contents are reused, not copied;
shared links require the workstation skill store, and no automatic install occurs.

After editing configuration, run `/reload` in the parent and spawn fresh children; existing children retain their
resolved policy. From a trusted repository root, `pi mcp list --json` verifies connections without a model call.
A global MCP failure can make that command fail even when graphify connects; inspect per-server state.

## Installation and execution-host boundary

`.pi/skills/graphify` links into `~/.cc-switch/skills/graphify`. Keep skill files in that store and leave the link
in place; it is locally excluded in the skills submodule's `.git/info/exclude`. Inspect the installed version rather
than copying a version number into always-loaded instructions.

Upgrade deliberately with `uv tool install --upgrade graphifyy`, then copy the packaged `skill-agents.md` and
`skills/agents/references/` into the store. `graphify agents install` can be rerun. **Do not use `graphify uninstall`
against this linked layout:** it deletes through the link and can empty the shared store. Remove or upgrade the
installation manually, preserving shared resources.

This harness's execution-side loader rejects skill links resolving outside their resource root
(`apps/server/src/workspace-resources.ts`). It therefore skips this linked skill and reports the escape; upstream
Pi/Claude Code can load it normally. Keep that security boundary intact. Agents running through this harness can
follow this repository guide and invoke the CLI on the execution host when available; otherwise the coordinator
supplies graph results. A missing linked skill does not require changing the loader or suppressing its diagnostic.
