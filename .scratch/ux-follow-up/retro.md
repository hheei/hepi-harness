# UX follow-up retro

Bounded notes from the 14-ticket UX follow-up effort. Records what is already applied and what a future run should reuse,
plus the verification mistakes that were caught and corrected. No code changes are proposed here.

## Practice already in the work

- **Owner seams over caller patches.** Each ticket changed the abstraction that owned the failure (the execution owner
  for skills, the workspace owner for SSH projects, the durable task table for the missing-model failure) instead of
  guarding each caller. Review findings that could not be traced to an owner were recorded, not patched.
- **Native mechanisms over new machinery.** The missing-model failure is read from the framework's own committed task
  outcome and projected on the existing snapshot, so it survives reconnect and backend restart without a new registry,
  scheduler or status machine.
- **Public-seam proofs.** Verification drove real processes at public HTTP/durable/environment seams — a real localhost
  `sshd`, real Next production builds, real backend and gateway — rather than internal unit mocks.
- **Reused workers.** Isolated worktrees per ticket kept branches independent, and the same worker/agent ids were reused
  across phases rather than spawning a new one per task.
- **Docs as evidence.** Each merge recorded the pinned commit, the exact commands and the observed counts in
  `.scratch/ux-follow-up/validation.md`.

## Verification mistakes caught and corrected

- A whole-web count was reported from a bare `lib/*.test.mjs` glob, which missed the nested `lib/i18n/` tests, so the
  numbers did not describe the complete suite. Corrected to an explicit recursive file list (2065 tip / 2104 base).
- A "baseline" comparison re-ran the same unmodified tree, because `git stash` is shared across worktrees; the
  comparison was vacuous. Corrected with a detached worktree at the base revision.
- Failure sets were compared by count and by punctuation-normalized names. The honest measure is the exact `not ok`
  names including nested ones: 23 runner failures and 24 unique names are two counts of the same tree, identical on both.
- A license claim ("no new distribution obligation") was wrong for the published client tarball: the adapted
  `skill-frontmatter.ts` is bundled into `dist/cli.js`, and its copyright line was genuinely missing from the bundle,
  the notice table and the upstream record. Fixed, and the pack smoke now asserts the copyright string in the bundle.

Practice that prevents each of these is in [verification.md](../../docs/agents/verification.md).

## Known, non-blocking

- The SSH test fixture spawns `sshd` inside the gateway process. A gateway killed before its cleanup runs leaves that
  listener holding its port in `/tmp`. Observed twice; cleaned up manually; does not affect any ticket contract.
- The pack smoke's `npm install` step needs lifecycle scripts permitted. Under an `EALLOWSCRIPTS` policy it fails
  identically on an unmodified tree. That is an environment setting, not a packaging defect.
- The whole-web suite carries a historical set of environment/module-load failures unrelated to this effort. They stay
  recorded; they are not repaired.

## Future work

Deliberately no speculative items. Anything here would need real use as evidence before becoming a ticket.
