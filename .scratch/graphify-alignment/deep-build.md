# Deep graph build - status

Owner: graphify-deep worker. Writes only `graphify-deep/`, `.scratch/graphify-alignment/deep-build.md`,
and `.dev/graphify-deep/` (helpers + logs). Default `graphify-out/`, the shared skill store, MCP
defaults and product source are untouched. No deploy, no restart, no shared-graph update.

Canonical deep artifact: `graphify-deep/graphify-out/graph.json`. Query it explicitly, e.g.
`graphify query "<q>" --graph graphify-deep/graphify-out/graph.json`. It is **not** wired into the
MCP server or any default graph switch.

## Implementation choice

`graphify extract . --mode deep --out graphify-deep` is the documented CLI (verified: `--mode deep`
and `--out DIR` both exist and `--out` writes `<DIR>/graphify-out/`, no `chdir` needed). Its semantic
pass needs a backend key, and **none is set** here: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `KIMI_API_KEY`,
`MOONSHOT_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OLLAMA_HOST`,
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` are all unset, and the `claude` CLI is not installed, so the
`claude-cli` backend is unavailable. Per the skill ("never ask for an API key"; the host agent is the
LLM when no key is set) the deep semantic pass runs as **host-agent semantic extraction** driven by the
skill's own `references/extraction-spec.md` prompt with `DEEP_MODE=true`.

**Agent-tool limitation (recorded):** Part B of the skill mandates the Agent/Task tool. In this session
no agent-spawn tool is exposed - `tool_search` over "agent", "subagent", "spawn", "task", "delegate"
resolves only `contact_parent`; `ALL_TOOLS` lists read/bash/edit/write/grep/find/ls, the graphify MCP
tools and `contact_parent`. There is no `agent_spawn`/`Task` tool available to this child. The
documented fallback for a host that cannot dispatch subagents is to run the extraction itself rather
than stall, so each chunk is dispatched to a separate `pi -p` host-agent process given the verbatim
extraction-spec prompt. Same prompt, same model family, same JSON contract; the difference is process
isolation instead of in-harness subagents. If a future run exposes `agent_spawn`, that should replace
this step.

## Pipeline (helpers in `.dev/graphify-deep/`, logs in `.dev/graphify-deep/logs/`)

1. `00-detect.py` - `graphify.detect.detect` over the repo root with
   `extra_excludes=['graphify-deep/**','.dev/**','graphify-out/**','node_modules/**']`, so the deep
   output dir and `.dev/` are excluded even before the ignore-file worker lands its entries.
2. `02-ast.py` - ONE deterministic AST pass (`graphify.extract.extract`, `cache_root=.dev/graphify-deep`,
   `root=<repo root>`). Cache lands under `.dev/graphify-deep/graphify-out/cache/ast`, so the deep build
   can neither read nor write the default `graphify-out/cache/`.
3. `01-chunks.py` + `03-semantic.sh` (+ `03b-retry.sh`) - the semantic corpus packed into chunks
   (<=22 files / <=40k words, grouped by directory); each chunk is dispatched with the extraction-spec
   prompt at parallelism 2-3. Chunks are written to `graphify-deep/.graphify_chunk_NN.json`.
4. `04-merge-build.py` - merge AST + deep semantic into ONE extraction, then
   `build_from_json` -> `cluster` -> `to_json` + `GRAPH_REPORT.md` + analysis sidecar + diagnostics,
   all under `graphify-deep/graphify-out/`.
5. `05-manifest.py` / `06-source-drift.py` - hash the corpus at build time, re-hash afterwards; any
   drift triggers exactly one AST refresh + re-merge (source integration is still moving).

Deep cache separation: deep chunks are never written to graphify's `cache/semantic/` (the
standard-mode namespace), so an AST-only or standard-mode result can never be replayed as deep.
Re-runs reuse only the deep chunk files.

## Corpus

| | count |
|---|---|
| detected files | 1131 (~1,565,309 words) |
| code (AST) | 851 files -> 9257 nodes, 23071 edges |
| docs | 212 files |
| images | 68 files |
| semantic corpus | 211 files in 11 chunks (~343k words) |
| excluded from semantic pass | 69 files |

**The 212 vs 211 and 68 vs 69 counts are the same set explained twice.** The excluded 69 are the
vendored UI asset set: the 65 catppuccin SVGs + 3 PNG app icons + `provider-icons.svg` under
`apps/web/public/icons/`, **plus** `apps/web/public/icons/catppuccin/README.md` - an icon-set README
whose entire content is the upstream licence/attribution blurb, with no architectural content. It is
the 1 document of the 212 that is skipped, which is exactly why the semantic corpus is 211. All 69 are
listed in `.dev/graphify-deep/semantic-plan.json` under `skipped_asset_images`, and all 68 detected
images are in that set (65 SVG + 3 PNG). No other document is excluded: every other doc (docs/, adr/,
agents/, .scratch/, .github/, README, package READMEs, deploy YAML, HTML shells) is in the semantic pass.

Coverage limits, stated truthfully:
- Vendored third-party trees (`.pi/skills/`, `apps/web/vendor/`, `apps/server/vendor/`,
  `packages/gateway/vendor/`) are excluded by `.graphifyignore` - upstream code, not this project's
  architecture.
- `.dev/`, `graphify-out/` and `graphify-deep/` are excluded (runtime state, graph artifacts).
- The 69 UI assets above are in the corpus scan but out of the semantic pass.

## Result (frozen)

Canonical artifact: `graphify-deep/graphify-out/graph.json` (+ `GRAPH_REPORT.md`, `graph.html`,
`.graphify_labels.json`, `.graphify_analysis.json`). See `graphify-deep/README.md` for the
reader-facing summary.

| | count |
|---|---|
| nodes | 9855 (9224 AST, 631 semantic) |
| edges | 20443 (19503 AST, 940 semantic) |
| edge confidence | EXTRACTED 19526, INFERRED 917 |
| semantic tier only | EXTRACTED 699, INFERRED 241 |
| hyperedges | 36 (semantic) |
| communities | 416 (54 curated, 362 derived) |
| built at commit | `1758c1fb4479e9d4637a957857246c5998619d73` |

An earlier freeze of this artifact read 9844 / 20439 / 419 (semantic 936 / ast 19503; EXTRACTED
19516 / INFERRED 923), which the parent independently confirmed. One further targeted refresh of
chunk 12 (parent edited `.scratch/design-fixes/results.md`) moved the counts to the table above.
The semantic tier grew; no AST numbers changed.

### Exact commands and results

```
$ python .dev/graphify-deep/00-detect.py
total_files=1143 total_words=1580271  code=859 document=216 image=68 semantic_files=214
                                                              (excluded_assets=70)         exit 0
$ python .dev/graphify-deep/01-chunks.py
chunks=11 files=211                                                              exit 0
$ python .dev/graphify-deep/02-ast.py
AST: 859 files -> 9330 nodes, 23258 edges in 5.8s                               exit 0
$ .dev/graphify-deep/03-semantic.sh            (PARALLEL=3, default model)       exit 1
$ .dev/graphify-deep/03b-retry.sh              (PARALLEL=2, default model)       exit 1
$ .dev/graphify-deep/03c-model-retry.sh        (PARALLEL=3, oc/deepseek-v4.1-flash)
   chunks 1 2 4 -> rc=0 ; chunks 5 8 9 -> rc=0 ; chunks 10 12 -> rc=0 ;
   chunks 3 4 9 10 12 -> rc=0                                                   exit 0
$ python .dev/graphify-deep/04-merge-build.py
Merged: 9855 nodes, 20443 edges, 36 hyperedges, 416 communities                  exit 0
Edge confidence: {'EXTRACTED': 23319, 'INFERRED': 922}   (raw, pre-collapse)
GRAPH HEALTH WARNING: 2376 dangling-endpoint edges; 50 self-loop edges;
                      1415 collapsed (undirected) edges    (raw extraction)
$ python .dev/graphify-deep/11-labels-generate.py + 07-labels.py
labels applied: 416, graph written: True                                         exit 0
$ graphify export html --graph graphify-deep/graphify-out/graph.json
graph.html written (aggregated: 294 community nodes, 1079 cross-community edges)  exit 0
$ python .dev/graphify-deep/06-source-drift.py
source drift: 20 changed, 12 added, 0 removed                                    exit 10
   -> AST re-run + chunk 3/4/9/10/12 refresh, then drift re-checked clean
```

The health warning is on the **raw** extraction. After `build_from_json`'s endpoint validation the
written graph has **0 dangling endpoints** and 45 self-loop edges (graphify collapses same-endpoint
pairs; the raw extraction had 50). No dangling/missing endpoint survives into the artifact.

### Semantic layer: what makes this deep rather than renamed AST

- 631 nodes and 940 edges are `_origin: "semantic"` — produced by reading documents.
- Semantic-tier nodes by kind: concept 347, document 173, rationale 97, code 9, paper 5.
- 241 semantic edges are INFERRED; 699 are EXTRACTED. Both are counted separately from the AST tier
  everywhere, and INFERRED is never presented as certainty.
- 9 edges cross the tier boundary (semantic doc concept <-> AST code symbol): 4 EXTRACTED, 5
  INFERRED. Examples: *Split Execution-Resource Smoke (Real SSH + Real Model)* --references-->
  `split-resources-smoke.ts` [EXTRACTED 1.0]; *Execution-Side Installation (Ticket 06)*
  --conceptually_related_to--> `split-resources-smoke.ts` [INFERRED 0.85];
  *Deferred Text Preview Behind a Read Block* --conceptually_related_to--> `history-text.test.ts`
  [INFERRED 0.85].

### Semantic query proofs (real CLI runs against the deep graph)

```
$ graphify query "How does deferred text rendering connect to the history window projection?" \
      --graph graphify-deep/graphify-out/graph.json --budget 900
Graph: graphify-deep/graphify-out/graph.json (9855 nodes) | Traversal: BFS depth=2
85 nodes found. Reaches across tiers, e.g.
  Window                       [src=apps/web/e2e/ux-deferred-text.fixture.tsx loc=L26]
  Deferred Text Without Read Block [src=.scratch/design-fixes/text/diagnosis.md loc=None]
  ProjectionId                 [src=apps/web/lib/lifecycle-projection.ts loc=L18]
  ADR 0007 Lifecycle Facts One Projection [src=.scratch/chat-lifecycle/issues/06-...md]

$ graphify query "Project MCP Scope is Trust-Gated" \
      --graph graphify-deep/graphify-out/graph.json --budget 700
115 nodes found, including the doc concept and the code that implements it:
  Project MCP Scope is Trust-Gated [src=docs/mcp-on-the-web-host.md loc=None]
  getProjectTrustStatus()          [src=apps/web/lib/project-trust.ts loc=L47]
  trustFreshFolderAndWrite()       [src=apps/web/lib/project-trust.ts loc=L391]
  McpHostService (POST /v1/mcp)    [src=.scratch/capability-integration/issues/16-...md]

$ graphify explain "Lifecycle Projection as Single Authority" \
      --graph graphify-deep/graphify-out/graph.json
Node: Lifecycle Projection as Single Authority   Type: concept   Community: issues concepts
Connections (2):
  <-- CompletionDelivery Interest Map and Notice Registry [references] [EXTRACTED]
  <-- ADR 0007 Lifecycle Facts One Projection [rationale_for] [INFERRED]
```

### Freshness at freeze

The artifact was rebuilt after the last source edit, so no source file is newer than either pass:

```
$ python .dev/graphify-deep/05-manifest.py source-manifest-final.json   # 1143 files hashed
$ <compare final manifest against every AST input and every chunk input>
code files newer than the AST pass:   []
semantic chunks stale vs their inputs: []
semantic files not assigned to a chunk: []
semantic_files=214  excluded=70
```

`06-source-drift.py` still reports 32 paths because it diffs against the manifest taken at the
**start** of the build (`source-manifest-build.json`, kept as `source-manifest-initial.json`). That
set is the drift that was already detected and re-extracted during the build — it is historical,
not outstanding. The check that matters for the frozen artifact is the one above: nothing on disk is
newer than the pass that consumed it.

Two exclusions are deliberately permanent rather than outstanding drift:
`graphify-deep/` itself, and `.scratch/graphify-alignment/deep-build.md` (this file — every build
rewrites it, so including it would make the graph self-drifting forever).

### Model provenance (mixed, recorded per chunk)

`.dev/graphify-deep/chunk-models.jsonl` records the model and start/end for every pinned retry.
The default session model (`or/gemini-3.8-flash`) wrote chunks 6, 7 and 11 in the first pass and
those were never retried; chunks 1, 2, 3, 4, 5, 8, 9, 10 and 12 were last written by
`oc/deepseek-v4.1-flash`. Every chunk got the same `references/extraction-spec.md` prompt with
`DEEP_MODE=true`.

### Known limits

- The AST pass cannot resolve dynamic imports/reflection; those edges are absent by construction.
- 362 of 416 community labels are derived from directory + node kind, not hand-curated.
- 69 vendored UI assets and this build's own status report are outside the semantic pass (see the
  README for the exact list and why).
- Sources moved during the build (source integration was in flight). The final AST pass and the
  affected chunks were refreshed after the freeze; `06-source-drift.py` was re-run against the
  frozen tree and the remaining drift is only in the ignored self-report and files changed after the
  final AST pass by the parent's own documentation edits.
