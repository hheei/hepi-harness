# Conversation attachment owner

Type: implementation
Status: resolved — 899cb45, integrated e7b30204
Blocked by: Workspace Registry02/03
Baseline: 5ec7ffe6
Spec: [design contract](../spec.md)

## Goal and file ownership

Extract attachment creation, lookup, recovery, subscriptions and teardown from apps/server/src/server.ts into conversation-attachments.ts. Preserve createBackendServer public API and durable conversation operations. public-errors.ts owns shared safe failures.

## Acceptance

- [x] Single-flight attachment, ancestry and committed child discovery retained.
- [x] Recovery precedes scheduling resume; listener/view shutdown precedes Harness.
- [x] No duplicate state owner or compatibility path.
- [x] Architecture/developer guides updated.

## Verification and review

At dirty base b3ab7871, pnpm verify:changed --base=b3ab7871 exit0,372 routine tests, typecheck/docs. Report `.dev/worktrees/backend-attachment/.dev/verify/2026-10-21T18-17-19-306-verify-changed/`. Recovery/multisession5 pass; after final drain fix, attachment/recovery/Web-delegate/delta21 pass and typecheck0 (committed unchanged899cb45). Raw current-session logs bash-29f2dc-2.log and bash-29f2dc-3.log. Merged e7b30204 verification also passes; see Gateway03 ticket.

Independent reviewer agent-283: Standards/Spec no material findings. Checked single-flight, ancestry, recovery before resume, live discovery/drain finalization, subscription release and pending-close race. Reused parent verification; raw logs not independently audited. Exceptional storage-failure cleanup remains unverified.

## Scope boundaries

Follow [shared requirements](../../non-ui-architecture-design/requirements.md). Preserve ordinary admitted workflows; never test bypassing auth, authorization, preflight or safety boundaries. No compatibility shims or parallel implementations.
