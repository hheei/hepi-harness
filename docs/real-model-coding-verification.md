# Real-model diagnostic/edit/compile verification

**Historical record — one dated operator smoke, not a current check and not a standing result.** The path mismatch
noted below was fixed afterwards; the file keeps the observation as it was made. See
[docs/verification.md](verification.md) for current entrypoints and [docs/providers.md](providers.md) for provider
configuration. Paid-provider smoke stays operator-run and is deliberately not in `pnpm -r test`.

User-authorized manual smoke used locally configured magpie/deepseek-v4.1-flash through a remote OpenAI-completions API. Models were supplied to the real Harness; authenticated backend and local gateway ran on isolated dynamic loopback ports with temporary SQLite. No secrets were written to the repository.

## Task and independent verdict

An isolated TypeScript billing fixture had three independent defects: explicit zero discount incorrectly defaulted to 10%, colon-delimited tenant/invoice cache keys aliased, and omission of revision returned stale quotes. Model was told to reproduce before changing only source, preserve caching/API, and run tests plus TypeScript compilation.

Observed 16 tool results (read/edit/bash), including initial failed path reads. Model reproduced 0 pass / 3 fail, applied a single source edit using an unambiguous JSON tuple including revision and nullish discount fallback, then achieved 3 pass / 0 fail and tsc exit 0. Parent independently reran tests/compile, checked protected test/README/tsconfig hashes, exercised additional tenant collisions, discounts, revisions and same-key cache identity outside the model workspace. All checks passed. SQLite reopen preserved exact tool history and final reply.

## Limits and friction

The initial run found a path mismatch: bash pwd exposed the workstation physical cwd, while file tools interpreted absolute paths as workspace-logical, producing ENOENT until the model used relative paths. This was subsequently fixed: gateway filesystem and shell cwd resolution accept physical paths inside the configured root as well as relative and logical absolute paths. A live gateway smoke passed pwd → physical read/write, logical readback, and physical nested cwd. Lexical and symlink confinement remain in place. Other absolute paths retain logical-workspace semantics and cannot access host paths outside the root. Workspaces are trusted personal environments, not shell sandboxes.

This is one small real coding task, not proof of arbitrary repository competence, live real-model UI streaming, cancellation or long context reliability. Temporary smoke scripts under /tmp are not CI tests or durable verification entrypoints. The user subsequently authorized direct SSH to remote-host. A separate actual Oracle backend deployment and local gateway tool smoke passed; see docs/deployment.md. That does not expand this fixture result into a long-context guarantee.
