# Integration review inputs

Review agreed [spec](spec.md), [tickets](ticket-breakdown.md), [owned paths](navigation.md), [recorded limits](review-notes.md). Standards and Spec remain separate axes; both follow [review policy](../../docs/agents/review-policy.md).

Source commit anchor:1758c1fb4479e9d4637a957857246c5998619d73; branch integration/architecture-unification has no new commits. Actual subject is integrated dirty working tree, including new untracked implementation files. Use `git diff HEAD -- <owned paths>` plus new file contents, never empty HEAD...HEAD as the implementation diff. Prior approved audit/design/graph fixes remain in tree; review unification behavior, with earlier hunks as context, not an invitation to reopen recorded issues.

The initial plan-publication manifest was captured after workers began, omitted root package configuration, and contains hashes rather than a baseline checkout. It is a checkpoint/scope aid, not complete before/after evidence. Review all ticket-owned paths regardless of checkpoint equality. Final scopeVersion2 manifest covers root package/lock/workspace/TypeScript files plus source/docs; identify its timestamp/hash when review starts.

Standards references: [root instructions](../../AGENTS.md), [Web instructions](../../apps/web/AGENTS.md), [verification practice](../../docs/agents/verification.md), [current verification guide](../../docs/verification.md), [architecture](../../docs/architecture.md), approved spec/decisions, codebase-design skill vocabulary. Focused search found no repository-owned CODING_STANDARDS/CONTRIBUTING or nested package instructions. Web Next.js version instructions apply if reviewing changed Next-specific APIs; generated Web instruction file remains reference data.

Graph navigation: reuse exact owned paths/source locations in navigation; default graphify-out/graph.json is not updated until coordinator integrates code. Supplemental deep graphify-deep/graphify-out/graph.json remains historical. Neither graph replaces source confirmation. No reviewer mutations/rebuilds/deploys.

Evidence: package/CLI checks are recorded by owners; integrated client rebuild + installed Local/real localhostSSH smoke6/6 is `.dev/verify/architecture-unification/integrated-cli-check.md`. Whole-Web comparison is observed known-name accounting against16 historical names, not a fresh pinned two-revision comparison. Final full-source gates and browser window proofs are required before completion.
