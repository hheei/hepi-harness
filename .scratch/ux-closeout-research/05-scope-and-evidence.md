# Scope, source identity, and evidence rules

Research requested by user on 2026-10-19: defer extension platform and investigate UX closeout first. Runtime implementation and deployment are outside this research deliverable.

## Source of truth

- Code baseline: `/home/developer/Documents/dev/hepi-harness/.dev/worktrees/client-app-integration`, clean `9400dcc8ca970f42ba4e02d71022d793a684039a` on integration/client-app.
- Historical planning corpus: primary `/home/developer/Documents/dev/hepi-harness/.scratch`. Scratch copies differ between worktrees; another checkout can carry newer ticket evidence. The new research directory is untracked in primary checkout, not ignored (confirmed with git status and check-ignore). Do not infer delivered status from primary scratch headers.
- Live ingress: release `1873d244289db29e5aaa62118e3dfc1b30ffabb5`, independently identified by service unit and artifact provenance. See [runtime observation](evidence/runtime-observation.md).
- Branch-only work is named explicitly and not counted as baseline or deployed.

## Evidence tiers

1. Current live/browser observation: names target artifact, command, actual exit code, raw log and screenshots.
2. Current pinned source trace: names entry control, request, handler and rendered outcome. This supports a source-derived gap, not a browser reproduction claim.
3. Existing acceptance evidence: retain tested revision/date and scope; do not promote historical tests into current acceptance.
4. Planning/uncertain: existing spec or documentation establishes intent only. A missing Rust picker or missing button in one file cannot establish that shared UI flow is impossible.

For each finding record ordinary trigger and impact, actual delivery state, owning seam, minimum coherent closeout, dependencies, remaining decisions and acceptance scenario. Material normal-use blockers take priority over optional enhancements. Record uncertainties without inventing reproductions.

## Primary scratch metadata conflicts observed

At research start, primary scratch provider/MCP/subtree/child-recovery headers still claim ready or implementation not authorized. Current source and session delivery evidence already contain parts of those capabilities. Primary SSH scratch describes only tickets 01-04 although later source includes DOCX work from ticket 05. Primary client-app ticket 16 says blocked, despite live cutover and native acceptance branch work; ticket 17 remains an outstanding retirement scope.

These observations establish stale planning metadata, not universal completion. Research notes reconcile by actual source and branch evidence instead of rewriting all old specs during research. Future implementation should update owning ticket corpus where current implementation evidence resides.

## Excluded or parked scope

- Extension SDK/platform: user explicitly deferred. Existing settings controls can be checked for truthful availability without designing SDK.
- Session export: previously deferred.
- Global active subagent dock: previously parked. Existing conversation/subtree controls can still be evaluated.
- Terminal renderer replacement: retain xterm.js per prior decision.
- Android, live watch, native pickers/background push: record existing capability bounds and prerequisites; research alone does not promote them into release blockers.

## Verification boundary

No runtime source edits, migrations, credential changes or deployments. No full test/build rerun for research documents. No security-control bypass probes or fixtures. Existing source tests are useful navigation/acceptance references; proposed future checks describe normal user workflows only.
