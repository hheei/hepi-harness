# Design exploration and review record

Date: 2026-10-21. Source baseline: `5ec7ffe6`. Scope: [six specs](README.md), planning only. Dispositions follow [review policy](../../docs/agents/review-policy.md). User has explicitly prioritized maintainability/depth/lightness, so design coherence is in scope; speculative runtime failures are not confirmed bugs.

## Scout alternatives and parent disposition

| Area / scouts | Distinct alternatives considered | Parent recommendation and reason |
| --- | --- | --- |
| Backend / 237,238,239 | Public dispatch facade; whole ConversationEngine vertical slice; router registration modules; concrete domain HTTP modules | Keep existing small BackendServer. Concrete handlers plus attachment ownership localize implementation without replacing durable operations or adding registration protocol. |
| Registry / 237,238,239 | Resolver-only; cohesive ProjectWorkspaceRegistry; separate resolver/service/store | Cohesive backend registry composed over existing ProjectStore. Preserve workspaceId resolution across configured/retained/non-default cases, include worktree record paths and host preparation. |
| Gateway / 240,241,242 | Capability descriptor; prefix/handle/close plugins; static dispatcher | Object naming alone is insufficient. Choose concrete transport families under existing listener/lifecycle owner; preserve distinct MCP/login lifetimes. |
| Filesystem / 240,241,242 | Keep inline string; new filesystem factory; standalone Python asset; existing FilesystemServer with helper extraction | Preserve current real seam, readable statically imported helper constant and positive shared observations. Source-run/bundle friction makes .py loader/generation unjustified here. |
| Ingress / 243,244,245 | New checker/locator object; keep existing two-fetch closure; router/proxy rewrite | Keep callback, move the exact predicate into one narrow Backend verdict. Merely wrapping list parsing leaves topology knowledge with the wrong caller. |
| Native / 243,244,245 | Display/sandbox helper; PackagedSmokeSession; generic verifier classes; keep script and change report | Choose concrete callable verification with private environment lifetime, reuse existing sandbox/install owners and preserve report. Generic classes or report redesign do not serve this effort. |

## Source corrections applied before independent review

- Source interface is `BackendServer = { server: Server; close(): Promise<void> }`; no existing public dispatch/listen facade. Preserve it.
- FileRequest actually uses `method`, including `readTextFile`; FilesystemServer returns Promise<unknown>. GatewayFiles is currently both a type alias and a LocalFilesystem constructor alias, not a separate capability implementation.
- Python helper contains 1,191 decoded lines. Source locations inside that decoded program are not TypeScript file line numbers.
- SshFilesystem already requires persistent runner.open and returns not_supported without it. No one-shot filesystem fallback exists to delete.
- Gateway already closes terminals, login, MCP, files, sockets and execution resources centrally. No absent-shutdown bug or need for a supervisor is established.
- Locality requires both matching binding and a usable host with a valid empty profiles array; owner.error plus empty profiles must not be treated as local.
- Native verification uses a real private Secret Service; custom error classes, altered assertion counts/schema and new installation ownership were not adopted.
- Scout suggestions to delete host validation, introduce generic capability plugins, route tests directly past admission, merge durable/live truth or claim unmeasured net LOC/performance gains were rejected.

## Independent reviews

Both independent reviewers completed read-only reviews of all six specs and shared requirements; no tests run. See dispositions below.

Agent-247 completed independent depth/lightness review across all six specs. Reviewed specs and shared requirements against source and graph navigation; no edits/tests/bypass probes. No material findings for Backend composition, Gateway transport, Filesystem adapters or Native verification. Confirmed Registry aggregation and Ingress Backend verdict are substantive boundaries; their main component designs are appropriately scoped.

| Finding | Disposition |
| --- | --- |
| Registry design must preserve configured workspace reads and execution preparation when optional ProjectStore is absent; project/worktree operations retain current unavailable outcomes. | Fixed in `workspace-registry/spec.md`; WR1 now covers startup both with and without store. |
| Define/test `projectsRevision` for persisted checkout create/remove metadata changes so catalogue consumers observe updates. | Fixed in `workspace-registry/spec.md`; revision advances exactly once on persisted metadata change, not refusal/no-op/failure/read; WR5 covers admitted worktree/catalogue observations. |
| Registry checkout record/reconcile methods left host-operation ordering at callers; ordinary remove must reject default folder before host removal (`server.ts:2256`). | Fixed in `workspace-registry/spec.md`: `createCheckout`/`removeCheckout` now own preflight, host call, registration, persistence and publication; host clients retain git semantics. |
| Ingress wording “eligible listing” could mean new-target eligibility, but current `/api/workspaces` membership includes retained bindings. | Fixed before review completion: explicitly preserve workspace-list membership including retained bindings, distinct from new-target eligibility. |

Agent-246 confirmed no material findings for Backend composition, Gateway transport, filesystem adapters, ingress or native verification. Two registry requirements were clarified: optional ProjectStore behavior and `projectsRevision` semantics.

## Non-blocking limits

| Observation | Disposition | Revisit condition |
| --- | --- | --- |
| Python is still maintained in a TypeScript source constant after representation cleanup. | record: explicit tradeoff preserving the existing bundle/source execution mechanism. | Demonstrated Python-editing/tooling cost outweighs an asset or build-loader mechanism, with all artifact/source consumers mapped. |
| Native environment availability depends on actual Linux tools and OS support. | record: existing integration requirement; no new platform support promised. | Actual supported-runner incident or explicit new-platform scope. |
| All areas may still contain unrelated correctness/performance issues. | record: static design work, not exhaustive correctness audit. | Normal-use report or measured failure with material impact. |
