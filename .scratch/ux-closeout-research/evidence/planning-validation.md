# Planning validation — 2026-10-19

Target application baseline: integration/client-app `9400dcc8ca970f42ba4e02d71022d793a684039a`, with documentation-only uncommitted planning changes. Primary and integration planning copies synchronized. No feature implementation or deployment.

- Python structural check via functions.python_eval:83 Markdown documents across seven effort directories; all local Markdown link paths resolve in primary and integration copies after copying referenced screenshots and landing-observation source/JSON. Existing integration-only source/guide citations point explicitly at integration workspace.
- Ticket dependency check:52 issue nodes,80 parsed blocking edges, DFS exits without cycle. MCP discovery03a is resolved as its own slice;03b is ready,03c/04/05 blocked. New client-app18–21 depend17;22 joins domain acceptance. SSH09 follows04 and17, no reverse dependency.
- Byte equality check:all83 Markdown copies identical between primary and integration worktrees.
- Command: `git -C .dev/worktrees/client-app-integration diff --check` from primary workspace. Exit0. Command: `git diff --check -- .scratch/README.md`. Exit0. Tool output recorded in session; no separate shell log claimed. Checks do not assert new untracked files are covered by git diff; those received explicit structural/link/field reads.
- Manual review:read both worker results and owning spec/ticket changes; corrected bad reference proposal paths, unmet ready labels, fork initial-value semantics, stale live-cutover summary and known deferred-state wording.

No builds/application tests run: this change plans future behavior. Prior browser evidence remains scoped to live1873d24; current source presence and branch history do not establish acceptance.


## Full anchor check and portability correction — continuation2026-10-19

The earlier83-file inspection checked path existence only; it did not validate heading anchors. Running the repository checker on docs branch `a0b90be` plus dirty link corrections checked427 Markdown files. It found newly introduced references outside the current checkout whose fragment headings are not indexed, and18–21 pointed to a nonexistent `ux-closeout-2026-10-19` anchor. Converted current-code/guide references to repository-relative links and linked18–21 to owning spec without a nonexistent fragment. These links now travel with every checkout; root planning mirrors may lack current application docs until that branch is integrated, so they are planning mirrors rather than code-validation targets.

Command: `node scripts/check-docs.mjs --json=.dev/verify/core-status/check-docs-portable.json` in worktree `client-core-status-next`, revision `a0b90be` with documentation link fixes dirty. Exit1; raw log `.dev/verify/core-status/check-docs-portable.log`, structured report alongside. Exactly12 broken links remain. Compared exact `(file,line,target)` tuples against retained Provider run at `b20d814` in `provider-conn-03/.dev/verify/provider03-review-fix-gates/check-docs.log`: new0, baseline-only0. Therefore no new link/anchor failures remain; the actual check still exits1 for retained historical `.dev`/`.pi` evidence links.
