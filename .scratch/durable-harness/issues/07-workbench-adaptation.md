# 07: Add selected workbench capabilities through the gateway boundary

**What to build:** The Web UI provides a small verified subset of file browsing, diff/review, terminal, or Git/worktree behavior using the same workspace/gateway abstraction.

**Blocked by:** 05: Control one conversation from multiple Web UIs; 06: Execute an explicitly configured SSH workspace through the gateway

**Status:** complete (local read-only subset)

- [x] Select pi-gui file preview and changed-file contracts, file listing, status parser, and diff implementations.
- [x] Route selected file/status/diff reads through authenticated server and gateway APIs.
- [x] Keep terminal/PTY and worktree mutations deferred; no terminal state enters transcripts.
- [x] Verify listing/status/diff and confinement with two lightweight tests and a local HTTP smoke.
- [x] Keep Electron runtime and desktop supervisor outside the adaptation.

## Scope and evidence

The selected subset is local file browsing, bounded preview, changed-file status and diff review, served at /workbench. Source snapshots, MIT license and executable adaptations are preserved in packages/gateway/vendor/pi-gui/ and packages/gateway/src/workbench/. See docs/workbench.md for provenance, startup commands and verification limits.

Copied React pi-web file tree, text preview, changed files/diff and @ mention search now use this authenticated proxy. Local production UI/API smoke and live tool rendering passed. SSH coding-tool filesystem operations are separate; SSH workbench, interactive PTY and worktree writes remain outside the selected local read-only subset.

## Comments

2026-10-18: the "SSH workbench" half of the sentence above is superseded. `ssh-remote-workbench` ticket 01
(`impl/ssh-workbench-01` `bd80fc2`, merged into `integration/client-app` as `55a594e`) serves listing, preview, changed
files and diff for an SSH-backed workspace through this same `GatewayWorkbench`, its `SshFilesystem` session and its
`SshRunner` — see [workbench](../../../docs/workbench.md#the-ssh-workbench). This ticket stays resolved and is not
reopened: interactive PTY and worktree writes remain outside its selection, live watch and DOCX preview remain `501` by
decision, and the merged slice adds no terminal state to transcripts. Ticket files for that work live untracked under
`.scratch/ssh-remote-workbench/` (worktree-local), so no link to them is made here.
