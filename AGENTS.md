# Agent Workflow

This repository uses agent-driven TypeScript work.

## Skills

Skills are installed under `.pi/skills/skills/<category>/<name>/SKILL.md`; use the skill catalog's exact path. Local additions may be linked directly under `.pi/skills/`. Load skills relevant to the task; the catalog is a toolbox, not a mandatory sequence. The configured workflow is described in `docs/agents/`.

Inspect only the files the current task requires; do not scan the repository or run a planning workflow at the start of every conversation.

## Workflow

Choose the smallest flow that completes the user's task:

- **Routine operations (deploy, restart, inspect):** follow the [routine deployment path](docs/deployment-runbook.md#routine-deployment-default), execute established commands, verify the affected service, report the result. A deploy request authorizes the routine switch and restart.
- **Small fixes and docs/config edits:** inspect the owning files, make the change, run relevant checks, review the diff. The user request is sufficient scope; specs, tickets, formal review skills and retro are optional.
- **Feature work:** continue approved specs/tickets when they exist. Create a spec or tickets when scope, unresolved decisions or multiple sessions warrant them. Test changed behavior at its public seam and review material changes before delivery.
- **Research or design:** use `research` for external facts; record domain language in `GLOSSARY.md` and hard-to-reverse decisions in `docs/adr/` when needed.

The default development loop is **edit → verify → inspect the diff → deliver**. Use `pnpm dev` for hot reload and
`pnpm verify:changed` to select checks and retain logs automatically; for committed branch work pass
`--base=<branch-or-SHA>`. The selector covers packages and their dependents, not runtime contracts or browser flows;
add focused integration/browser checks when changed behavior requires them. See [verification](docs/verification.md)
and [verification practice](docs/agents/verification.md).

Use `writing-for-agents` for agent-facing documents. Use `handoff` when work moves to another session, harness, directory or person. Reuse verification against unchanged source; a deployment alone does not start a new implementation, full-test, code-review or retro cycle.

Completion means the requested behavior works, relevant checks are accounted for, and material findings are resolved. Record unrelated issues and finish.

## Tickets and decisions

Update the owning guide linked from [docs/README.md](docs/README.md) in the same change that alters behavior, configuration or deployment instructions. Shipping a revision through an unchanged deployment mechanism needs an operational result, not a documentation commit; see the deployment runbook. Keep validation reports tied to their tested revision and date, and add a current-guide pointer when they become historical. Record remaining capability limits in `docs/migration-status.md`.

Local specs, tickets and review notes live under `.scratch/<feature-slug>/`; see the [issue tracker](docs/agents/issue-tracker.md). Use sequential ADR names such as `docs/adr/0001-short-title.md`, for hard-to-reverse, surprising trade-offs only.

Delivered behavior is documented in [docs/README.md](docs/README.md); `docs/prompts/` is historical context.

## Build and deployment hosts

Build on `workstation` (the local workstation) or in CI. The current test backend runs on `workstation` beside the gateway; see [current local backend](docs/local-tailscale-deployment.md#current-local-backend). The remote-host build restriction below applies whenever deploying to `remote-host`.

**Never run a compile or build task on `remote-host`** — no `pnpm build`, no workspace build such as
`pnpm --filter @hepi/web build`, no client-runtime release build, no TypeScript emit (`tsc` without `--noEmit`), no
`docker build`/`docker buildx` and no remote builder, and no dependency install that compiles native modules. That
host is a small remote box meant to run containers, not to build them. Build where the toolchain and CPU budget are,
match the target architecture `remote-host` runs (`linux/arm64`), then move the **prebuilt** artifact to
`remote-host` — a pinned image tag/digest pulled from the registry, or a tarball transferred over SSH. `remote-host` then
only deploys, runs and does read-only verification.

This applies to every task in this repository, including one that only touches deployment docs: the constraint is a property of the host, not of the change.

## Integration, review and fixes

Preserve upstream TypeScript implementations and record their versions and licenses; adapt through explicit adapters and integration seams. See [copy-first integration](docs/agents/copy-first.md) and the [domain docs](docs/agents/domain.md).

## Breaking Changes

Prefer direct replacement or removal over preserving obsolete code for compatibility. Valuable changes may break source APIs, CLI/protocol contracts, configuration or persisted-state formats, and file layouts. Migrate current callers and remove obsolete implementations in the same change; do not add aliases, shims, fallback readers, dual paths or deprecated wrappers solely for old-code compatibility. Retain a compatibility contract only when the current task or an approved spec explicitly requires that named contract to remain supported.

This permits destructive code and format changes; it does not authorize overwriting user changes or deleting user data without an explicit data-migration scope.

Before comparing baselines or reporting verification, read [verification practice](docs/agents/verification.md). Before reviewing findings or starting a bug fix, read [review policy](docs/agents/review-policy.md): judge trigger likelihood in normal use and actual user impact, fix material failures, and record negligible ones without blocking delivery. Check whether the abstraction or responsibility boundary causes the failure, then correct that owner with the smallest coherent change instead of stacking caller guards. This governs review and implementation loops, including skills that say to fix all findings.

### No bypass testing

**Never conduct bypass testing.** That covers tests, probes, fixtures or drivers whose purpose is to bypass — or to test bypassing — an authentication, authorization, preflight or other safety boundary. Boundaries are exercised only through the ordinary admitted workflow the product ships, and a bypass probe is never a precondition for delivering a feature.

## Graph-first navigation

Before discovering code, run one narrow `~/.local/bin/graphify query "<symbol or file>" --budget 1000` when
`graphify-out/graph.json` exists, then confirm the returned locations in source. Use `path` for relationships,
`explain` for one concept's neighbors and `affected` for reverse impact. Every new discovery question — including
one that appears mid-task — gets its own narrow query rather than a broad read around the previous answer. Dirty graph
output is expected; a missing or stale graph, an unsupported relationship or a retry that stays low-value justifies
focused source search once the reason is stated.

A delegation states the workspace, owned paths, local checks and either the graph location or a scoped query result. Read-only children reuse the parent's navigation; another worktree queries with `--graph <primary>/graphify-out/graph.json`. Workers query their own new symbols and report queries, evidence and changed paths back. The coordinator runs `~/.local/bin/graphify update .` once after integrated code edits; children do not rebuild the graph concurrently.

The deep semantic graph under `graphify-deep/graphify-out/graph.json` is supplemental and reached with `--graph`; read `_origin` and `confidence` on its edges and confirm both kinds in source. See [graph navigation](docs/agents/graph-navigation.md) for query refinement, freshness, extraction limits and installation diagnostics.
