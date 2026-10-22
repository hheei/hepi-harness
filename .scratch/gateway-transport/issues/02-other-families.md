# MCP, provider and remaining transports

Type: implementation
Status: resolved — integrated e7b30204
Blocked by: Gateway01 and Filesystem02
Baseline: 5ec7ffe6
Spec: [design contract](../spec.md)

## Goal and file ownership

Extract execution, control, MCP and provider transports. MCP disconnect cancels; provider login survives caller departure. Concrete families own framing and lifetime, with no generic pipeline. Own remaining index.ts dispatch and family modules.

## Acceptance

- [x] GT1, GT4: preserve ordinary-workflow semantics in spec.
- [x] Moved branches removed; ownership explicit; no constructor compatibility path.
- [x] Public lifecycle and admitted transport verification recorded.
- [x] Architecture/developer/workbench guides updated.

## Verification evidence

Gateway03 `d24eac04`, base `b3ab7871`, integrated with Backend01 `899cb45` at `e7b30204`. Parent diff review: no material findings. At clean `d24eac04`, `pnpm verify:changed --base=b3ab7871` exit0; report `.dev/worktrees/nonui-gateway-03/.dev/verify/nonui-gateway-03/verify-changed-postcommit/verify.json`. Full Gateway enumeration:512/513 (exit1); focused transport/lifecycle74/74 (exit0). Logs under same worktree `.dev/verify/nonui-gateway-03/manual/{gateway-acceptance,focused-transport-committed}.log`. Client build exit0, tests10/10.

Known failure: ingress-catalogue device bearer case, projectsRevision `6 !== 3`. Worker reproduced at b3ab7871 with changes stashed; `manual/baseline-ingress-catalogue-at-b3ab7871.log`. Same-checkout evidence does not satisfy isolated pinned-baseline policy. Prior integration also recorded failure at ce8aa223. Keep recorded; revisit on actual catalogue incident or explicit prioritization.

At merged `e7b30204`, `pnpm verify:changed --base=b3ab7871` exit0: typecheck, routine tests including372 server, web14, docs463. Report `.dev/worktrees/architecture-consolidation/.dev/verify/2026-10-21T18-34-37-774-verify-changed/verify.json`. `pnpm --filter @hepi/gateway exec node --test test/composition.test.ts test/transport-lifetimes.test.ts` exit0,7/7. Graph update exit0. Full raw log `/home/chlo/.pi/agent/sessions/--home-chlo-Documents-dev-hepi-harness--/tasks/01a15c17-51ee-75d2-80b8-9ae57d3c15af/bash-29f2dc-5.log`.

## Scope boundaries

Follow [shared requirements](../../non-ui-architecture-design/requirements.md). Preserve ordinary admitted workflows; never test bypassing auth, authorization, preflight or safety boundaries. No compatibility shims or parallel implementations.
