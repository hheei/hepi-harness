# graphify workflow alignment — change record

Owned paths only: `AGENTS.md`, `docs/agents/graph-navigation.md`, `.pi/agents/{worker,reviewer,scout}.md`,
`.graphifyignore`, `.gitignore`, this file. No product source, `docs/README.md` index, `package.json`, shared
skill store or global MCP config was touched. No graph rebuild, no `graphify install`/`uninstall` was run.

## Review precision applied (second pass)

Five corrections after review of the first draft:

1. **OVITO parity claim was wrong.** `../ovito/AGENTS.md` already had narrow query + `path`/`explain` +
   parent-supplied navigation + coordinator refresh. `affected`, the per-new-question query rule and the
   handoff/report of queries+evidence are **requested additions**, not gaps OVITO has. The guide's opening line now
   says so, and this record lists the three explicitly. Fallback reasons were already OVITO's (L81-82); only their
   presentation moved.
2. **Deep CLI actually takes `--out`.** `extract . --mode deep --out graphify-deep` is documented and implemented;
   the earlier "run it from a `graphify-deep/` working directory" was one route stated as the only route. Both are
   now documented separately: `--out` for the headless CLI, the skill pipeline's CWD-relative
   `graphify-out/` for `/graphify --mode deep`.
3. **Default AST graph is not all-`EXTRACTED`.** It emits 669 `INFERRED` heuristic edges (`indirect_call`,
   low-confidence `calls`) of 21,398. The guide no longer equates "default" with "parsed" or `INFERRED` with
   "deep"; `_origin` (tier) and `confidence` (per-edge provenance) are stated as separate axes.
4. **`graphify-deep/` is a convention, not an artifact.** Nothing is there yet beyond in-progress build leftovers;
   the separate deep-build effort will produce it. The guide says so.
5. **No full `verify:changed` as a gate** while product source is in flight; docs own this change's validation. The
   one early run is recorded as a non-signal, with its cause named.

Fresh scout/worker/reviewer resolution was re-run against the real resolver after these edits; results below.

## What changed

| Path | Before | After |
| --- | --- | --- |
| `AGENTS.md` (Graph-first navigation) | query → source confirm; `path`, `explain`; parent supplies navigation; coordinator `update .` once | adds `affected` for reverse impact; one narrow query per *new* discovery question, including mid-task; named fallback reasons; children report queries/evidence/changed paths; deep-graph pointer stating that the AST default is not all-`EXTRACTED` and that `_origin` is the tier marker |
| `docs/agents/graph-navigation.md` | 5 sections, no `affected`, no deep graph | step 2 adds `affected`; step 3 is the per-question query rule; step 5 lists fallback reasons; **Deep semantic graph (supplemental)** rewritten around tier-vs-confidence and both `--out` and CWD routes; delegation, coverage and agent sections extended; opening paragraph marks the additions as beyond OVITO |
| `.pi/agents/scout.md` | did not exist | new: builtin scout baseline + `tool_search`/`codemode`, `mcp: true`, `skills: [graphify]`, model `or/gemini-3.8-flash`, thinking `low` |
| `.graphifyignore` | `graphify-out/` | also `graphify-deep/` |
| `.gitignore` | `graphify-out/` | also `graphify-deep/` |

Worker and reviewer frontmatter already carried `mcp: true` + `tool_search`/`codemode`; unchanged.

## Alignment with the OVITO checkout — shared pattern plus deliberate additions

Read `../ovito/AGENTS.md` (read-only). Its graph workflow is: one narrow `query --budget 1000` when the graph
exists, `path` for relationships, `explain` for concepts, parent-supplied navigation for read-only children,
`--graph <primary>/graphify-out/graph.json` for other worktrees, coordinator-only `graphify update .` (AST) after
code edits, dirty output tolerated, explicit `/graphify` uses its skill. The harness guide already matched that.

Three things in this change are **additions the user requested, not parity with OVITO** — OVITO's `AGENTS.md` has
none of them, so nothing here should be read as "closing an OVITO gap":

1. `affected` for reverse impact (OVITO names only `path` and `explain`).
2. One narrow query per *new* discovery question, including mid-task, instead of reading broadly around the first
   answer.
3. Handoffs and child reports that name the queries run, the evidence and the changed paths.

Explicit fallback reasons were already OVITO's rule (`AGENTS.md` L81-82: "Record missing/stale graph or low-value
results before falling back to focused source search"); consolidating them into one numbered step is presentation,
not new policy.

The guide's opening paragraph now says this in one line, so a reader does not take the OVITO reference as a claim of
full parity. OVITO's platform/build rules were not copied.

`../ovito` has no `docs/agents/graph-navigation.md`, so its `AGENTS.md` is the only sibling reference for this
workflow; `../ovito/.pi/mcp.json` uses an absolute graph path, while this repo keeps `cwd: "."` so parent and child
resolve their own worktree graph.

## Deep graph: tier vs confidence, and where it is written

Two corrections to the first draft, both from source:

**`EXTRACTED`/all-AST was wrong.** The AST pass emits its own heuristic edges. In this repository's
`graphify-out/graph.json` (21,398 links): 20,729 `EXTRACTED`, **669 `INFERRED`** — every one of them
`_origin: ast`, relations `indirect_call` (614) and `calls` (55), `confidence_score` 0.8/0.85. So
"default graph" does **not** mean "every edge parsed", and `INFERRED` alone does not mean "deep build". The real
tier marker is `_origin` (`ast` vs `semantic`), which the AST pass stamps and the semantic path does **not**
(`build.py` L1557-1568: "`_origin` is stamped at extraction time only (extract.py for AST, and the semantic path
never stamps)"; `_is_ast_tier` treats `_origin` as authoritative and falls back to the `L<line>` shape for
unstamped items). `confidence` is provenance of the individual edge. The guide and `AGENTS.md` now state both axes
separately and never equate them, and the guide says a missing marker is unknown rather than either tier.

**"Working directory required" was too strong.** `graphify extract` takes `--out DIR` / `--output DIR`
(`cli.py` L3275-3281; `out_root = out_dir.resolve() if out_dir else target`, then `out_root / "graphify-out"`), so
the headless CLI writes to `<out>/graphify-out/` from any directory:

```bash
~/.local/bin/graphify extract . --mode deep --out graphify-deep   # -> graphify-deep/graphify-out/graph.json
```

The CWD route is separate and belongs to the **skill's own pipeline**, whose bash blocks write
`graphify-out/graph.json`, `graphify-out/.graphify_python`, `.graphify_ast.json`, `.graphify_semantic.json`
relative to the working directory (`SKILL.md` L97-242). Running `/graphify <path> --mode deep` from
`graphify-deep/` therefore reaches the same layout. Both routes are documented in the guide as distinct; neither is
described as the only one.

**The layout is a convention, not an observed artifact.** No `graphify-deep/graphify-out/graph.json` exists in this
checkout yet — the directory holds only in-progress build leftovers and a `cache/`. A separate deep-build effort owns
producing it (`.scratch/graphify-alignment/deep-build.md`, `.dev/graphify-deep/` helpers, `graphify-deep/` output).
The guide says so explicitly rather than implying the file is there.

Both output trees are excluded from git and from extraction. The MCP server is pinned to the default path, so a deep
graph is CLI-only.

## Subagent graph access — verified against the resolver, not assumed

Read `packages/pi-subagents/src/{agent-resolver,builtin-agents,launch-spec,child-bridge}.ts`:

- Agent fields are validated against `SUPPORTED_FIELDS`; `mcp`, `skills`, `tools`, `model`, `thinking`,
  `description`, `hidden` are all implemented. Nothing added here is a deferred or unknown field.
- `mcp: true` → `parsePiSelection` returns `all` → `{enabled: true}`; the child is launched without `--no-mcp`
  and inherits project `.pi/mcp.json`, so the `graphify` server connects.
- The server's tools are `deferred` exposure. Without `tool_search` (or codemode) a child cannot call them, which is
  why all three definitions list both.
- `builtinAgentToolProblem` only constrains built-in source paths; a project definition of the same name has its own
  path, so widening the tool set is legal here.
- `PI_HINDSIGHT_DISABLE=1` plus the `mcp__hindsight__` block in `child-bridge.ts` keep memory isolation; enabling
  MCP does not bypass it.
- `skills` is a whitelist: `[graphify]` resolves the name against the parent catalog to an absolute path and passes
  `--no-skills --skill <path>`. Worker's `+graphify` is the modifier form (parent catalog plus graphify).

Scout is the one widening worth calling out: the builtin scout has `mcp: false` and no `tool_search`/`codemode`,
so it could not reach the graph at all and had no `bash` for the CLI. This definition keeps its read-only tool set and
adds the two indirect-access tools. Revert is a one-line frontmatter edit if that is judged too wide.

## Verification performed

- `~/.local/bin/graphify query "graph navigation workflow" --budget 1000` → returned `docs/agents/graph-navigation.md`
  sections at L8/L44/L59/L73/L84/L116, which matched the pre-edit file on disk and confirmed the guide is the owning
  document. Line numbers shift with this edit; the graph is stale for this file until the coordinator refreshes.
- `~/.local/bin/graphify --help` → `affected "X" [--relation R] [--depth N] [--graph PATH]`, `query --context`,
  `path/explain --graph` all exist as written in the guide.
- `~/.local/bin/graphify query "HelperFrame"` → `EXTRACTED`/`INFERRED` tags visible in real output, confirming the
  provenance vocabulary used in the deep-graph section.
- `.graphifyignore` parsing in the installed package (`graphify/detect.py`) merges `.gitignore` then
  `.graphifyignore` per directory, so both files needed the `graphify-deep/` entry.
- `git check-ignore -v` on `graphify-out/graph.json` → matched `.gitignore`; `graphify-deep/` now matches the same
  rule shape.
- Pi MCP docs (`docs/mcp.md`) confirm `deferred` exposure requires `tool_search`, and that a project entry replaces a
  user-level entry of the same name.
- `~/.local/bin/graphify affected "changedChecks" --depth 1` → `main()`, `verify()`, `verify.mjs`, confirming the
  reverse-impact command and its output shape.
- All three definitions resolved through the **actual** pi-subagents resolver
  (`dist/agent-resolver.js#resolveAgent`, real `discoverAgents`, a skill catalog and a registry stubbed to
  `settings.json`'s `enabledModels`), not just parsed:
  ```text
  scout    model=or/gemini-3.8-flash   thinking={level:low,source:agent}    mcp={enabled:true} skills=[.pi/skills/graphify]                    body=<builtin scout, 1181 chars>
  worker   model=oc/deepseek-v4.1-flash thinking={level:medium,source:agent} mcp={enabled:true} skills=[catalog…, .pi/skills/graphify]           body=<builtin worker, 2319 chars>
  reviewer model=or/gpt-6.1-sol        thinking={level:high,source:agent}   mcp={enabled:true} skills=[code-review, ponytail-review, graphify] body=<builtin reviewer, 1750 chars>
  ```
  `discovery:false` for all three (whitelist, not `--skills`), which is what the whitelist intent requires.
- Baseline preservation checked against the global files, not assumed: global worker/reviewer tool lists are exactly
  the resolved lists minus `tool_search`/`codemode`; global reviewer skills are exactly the resolved list minus
  graphify; global scout sets only `name`/`hidden`/`model`/`thinking`, so the project file supplies the rest.
  `resolveModel` rejects a model the registry does not know — a real guard, which is why the check used the
  registered IDs rather than arbitrary ones.
- `graphify-out/graph.json` read directly: 21,398 links, 20,729 `EXTRACTED` / 669 `INFERRED`, all `_origin: ast`.
- `cli.py` L3275-3281 read directly for `--out`/`--output` and `out_root / "graphify-out"`. `graphify --help`
  documents `extract <path> … [--out DIR, --output DIR] … --mode deep`.
- `graphify-deep/` inspected: in-progress artifacts from the separate deep-build effort (`.graphify_ast.json`,
  `.graphify_chunk_{03,06,11}.json`), `graphify-deep/graphify-out/` holding only `cache/`; **no `graph.json` yet**.
  `git check-ignore -v` matches `graphify-deep/` for both the artifacts and the output tree, and `.dev/` is already
  ignored by the pre-existing `.gitignore:8` rule.
- `_origin` semantics read in `build.py` `_load_existing_graph` L1557-1568 (AST stamps, semantic path never does;
  the shape backfill runs when an existing graph is read for an incremental merge, keying on `L<line>`) and
  `dedup.py` L462-468 (never inherits `_origin` from a dropped record), which is why the guide says a missing marker
  is unknown rather than either tier.
- Live graph keys confirmed: node keys include `_origin`, link keys include `_origin`, `confidence`,
  `confidence_score` — so the guide's two axes are read from real fields, not invented ones.

### `pnpm verify:changed` — deliberately not re-run as a gate

Docs own the validation for this change: the edits are Markdown, one ignore rule and three frontmatter-only agent
files, so there is no changed behavior at a product seam to test. A full `verify:changed` was **not** used as a
gate here, because the profile runs against the whole dirty worktree while product source is in flight under other
owners. One early run is recorded only to show why it is not a signal:

```text
apps/server test: ✖ a page that cannot be carried answers the same named refusal, and the entry stays readable by id
apps/server test:   AssertionError: 200 !== 413   at apps/server/test/frame-size.test.ts:121:10
```

That failure comes from concurrent edits to `apps/server/src/history-window.ts` and `apps/server/src/server.ts`
(`FRAME_LIMIT_BYTES` / `frame_too_large`), which are not owned paths here and share no file with this change. This
change is documentation and ignore-rule configuration only, so it adds no product check of its own; the graph guide's
own rule is that docs-only edits need no code-graph refresh.

## Limits

- No deep `graph.json` exists here yet; the `graphify-deep/` layout is a convention this guide establishes, not a
  verified build. A separate deep-build effort owns producing it (in progress; `.scratch/graphify-alignment/deep-build.md`).
- The guide states the tier rules from graphify's own source; a future graphify version could change when `_origin` is
  stamped. Re-read `build.py` if a query result contradicts the guide.
- The linked `.pi/skills/graphify` is still rejected by the execution-side loader
  (`apps/server/src/workspace-resources.ts`); the guide documents that boundary rather than changing it.
- The harness graph is a snapshot: confirm locations in source, as the guide already required.
- `docs/README.md` is owned by the parent; the guide stays reachable through the existing index line.
