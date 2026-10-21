# 04 - Child and fork lifecycle

Type: implementation ticket
Status: resolved on `impl/mcp-lifecycle-next` (base `e99bed1`) and **integrated** into `integration/client-app`; a
follow-up pass on `impl/mcp-04-child-fork` (base `701add2`) closed the stop/resume and restricted-child grant gaps the
delivered audit had recorded as correct

Define and implement how selected MCP tool access propagates to child/subagent and forked conversations. Bound per-conversation tool concurrency; avoid mutable connection/request state leaking across sessions; close or retain Gateway connections according to ownership/lifecycle.

Consume [03b](03b-durable-grant.md)'s grant document as the only source of selection; do not define a parallel propagation store or a second tool registry. Its `fork: "initial"` field is the approved starting policy and this ticket is where the rest of the policy is decided and tested.

- **Fork**: `fork: "initial"` means the grant document starts from its initial value (an empty explicit grant), not the parent's current selection. Keep this default; any explicit inheritance policy must state how a grant is deliberately copied and recorded. Later grant/revoke never mutates another conversation. Existing operator fallback is separately identified, not misreported as an inherited human grant.
- **Child/subagent**: inheritance is explicit policy, never implicit. A child that was not granted a tool cannot acquire it, and discovery in a child is not a grant.
- **Restart**: a restarted backend re-reads the durable grant; a call that was in flight at restart stays settled as it was recorded — `replay: "unsafe"` and `outcome_unknown` semantics are not relaxed by lifecycle handling, and a restart must not silently repeat a non-idempotent call.
- **Concurrency and cleanup**: per-conversation bounds, no cross-conversation request or connection state, and Gateway connections closed or retained according to ownership.

Acceptance: child inheritance follows explicit policy, fork scope is isolated, concurrent calls do not cross routes, cancellation/parent stop semantics are defined, restart preserves recorded settlement without replay, and connection cleanup is verified.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (M1).

## Delivered (2026-10-21)

The audit came back mostly already-correct, and that is the honest finding: the grant document and the runtime's own
seams already decide fork, child, restart, cross-conversation state and connection cleanup. Two things were actually
missing, and only those were built. **No parallel registry, no second scheduler, no per-conversation connection pool.**

Already correct, cited rather than restated:

- **Fork scope isolation** — `McpGrantDoc` is `fork: "initial"` (`apps/server/src/mcp-grants.ts`), and `attach` →
  `adoptMcpOffer` → `reconcileMcpOffer` (`apps/server/src/server.ts:1473,1574`) drops the names a branch inherited
  in `pi.agent.modelTools`. A grant or revocation written on one conversation only ever commits against the id it is
  called with, so nothing reaches back to a source or forward to a child.
- **Child inheritance is explicit and off by default** — a child's grant document does not fork, so it holds none of its
  parent's grants, and the **same one reconciliation** that isolates a branch runs for it: `attach` → `adoptMcpOffer` →
  `reconcileMcpOffer` (`apps/server/src/server.ts:1473,1574`) strips the MCP names the runtime copied into the child's
  `pi.agent.modelTools` from its parent's agent document (`agent.js` `createAgent`). A second, independent statement sits
  at the delegation seam: `apps/server/src/subagents/delegate.ts:200` writes `modelTools: null`, so a child is created
  with no loaded filter at all. Because every MCP registration is `deferred`, an unset filter loads none, so a child
  that attempts its parent's tool meets the runtime's own `tool_unavailable` before arguments and before the host.
  Verified both ways: removing the delegation seam's `modelTools: null` **and** the attach reconciliation makes the child
  inherit the name; removing either alone leaves it isolated, so the reconciliation is the load-bearing gate and the
  seam is the belt. No inheritance policy was added — none is needed by anything in this repository, and deciding one is
  a product choice (see Remaining limit).
- **Restart**: a restarted backend re-reads the durable grant; a call that was in flight at restart stays settled as it was recorded — `replay: "unsafe"` and `outcome_unknown` semantics are not relaxed by lifecycle handling, and a restart must not silently repeat a non-idempotent call.
- **Concurrency and cleanup**: per-conversation bounds, no cross-conversation request or connection state, and Gateway connections closed or retained according to ownership.

Acceptance: child inheritance follows explicit policy, fork scope is isolated, concurrent calls do not cross routes, cancellation/parent stop semantics are defined, restart preserves recorded settlement without replay, and connection cleanup is verified.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (M1).

## Delivered (2026-10-21)

The audit came back mostly already-correct, and that is the honest finding: the grant document and the runtime's own
seams already decide fork, child, restart, cross-conversation state and connection cleanup. Two things were actually
missing, and only those were built. **No parallel registry, no second scheduler, no per-conversation connection pool.**

Already correct, cited rather than restated:

- **Fork scope isolation** — `McpGrantDoc` is `fork: "initial"` (`apps/server/src/mcp-grants.ts`), and `attach` →
  `adoptMcpOffer` → `reconcileMcpOffer` (`apps/server/src/server.ts:1473,1574`) drops the names a branch inherited
  in `pi.agent.modelTools`. A grant or revocation written on one conversation only ever commits against the id it is
  called with, so nothing reaches back to a source or forward to a child.
- **Child inheritance is explicit and off by default** — a child's grant document does not fork, so it holds none of its
  parent's grants, and the **same one reconciliation** that isolates a branch runs for it: `attach` → `adoptMcpOffer` →
  `reconcileMcpOffer` (`apps/server/src/server.ts:1473,1574`) strips the MCP names the runtime copied into the child's
  `pi.agent.modelTools` from its parent's agent document (pi-durable `agent.js` `createAgent`). A second, independent
  statement sits at the delegation seam: `apps/server/src/subagents/delegate.ts:200` writes `modelTools: null`, so the
  child is created with no loaded filter at all, and because every MCP registration is `deferred` an unset filter loads
  none. A child that attempts its parent's tool therefore meets the runtime's own `tool_unavailable`, before arguments
  and before the host. Verified by removing each gate: either alone still isolates the child (the seam's
  `modelTools: null` clears the filter the runtime's `createAgent` copied in, and the attach reconciliation strips any
  MCP name that reached the document some other way), and removing **both** makes the child inherit its parent's granted
  name. Two independent statements of one rule, which is the belt-and-braces this ticket's acceptance asks for rather
  than a second registry. No inheritance policy was added — none is needed by anything in this repository, and deciding one
  is a product choice (see Remaining limit).
- **Restart** — a reopened backend re-offers from the durable grant (`adoptMcpOffer` at boot) with nothing asked of a
  host, and `replay: "unsafe"` is untouched by lifecycle handling: an interrupted call settles `interrupted` and is never
  rerun. No code change; only the claim needed pinning.
- **No cross-conversation request or connection state** — a call's `callId`/`conversationId`/`workspaceId` come from the
  runtime's own api and the conversation's own binding, read **at the call** (`mcp-conversation-tools.ts` execute), the
  scope comes from that conversation's own grant (`scopeOf`), and the gateway client is constructed per request
  (`server.ts:1021`). The host's own `running` set is keyed `callId + conversationId`
  (`packages/gateway/src/mcp/invocation.ts:167`), so one conversation's identity can never address another's work.
- **Connection ownership and cleanup** — the host owns the process: one connection opened per call and closed in a
  `finally` (`invocation.ts:199`), a per-call deadline composed with the caller's abort and the service's `stopping`
  signal, and `McpHostService.close()` awaiting every in-flight call (`packages/gateway/src/mcp/host.ts:250`). Nothing on
  the backend retains an MCP connection, so there is nothing for a fork or a child to inherit or leak.
- **Cancellation and parent stop** — the caller's abort is handed to the host request and ends the server process
  (pinned by ``a caller that goes away ends the host request``), and a parent's stop stays local while
  `POST …/subtree-control` is the only seam that reaches children, each with its own captured outcome
  (`apps/server/src/subtree-control.ts`).

What was built:

1. `apps/server/src/mcp-conversation-tools.ts` — every MCP registration now carries `executionMode: "sequential"`, the
   runtime's own round rule (`generation.js` `startToolRound`: a round containing an offered sequential call starts its
   calls one after another in call order). This is the per-conversation bound ticket 04 asks for, stated with the
   framework's own field instead of new state: the host bounds eight calls **across every conversation**, so before this
   one model answer asking for nine tools took every slot and the ninth — and any other conversation's call — was refused
   `busy`. Two conversations still run at once; a round that mixes an MCP call with ordinary tools runs in call order.
2. `apps/server/test/mcp-conversation-tools.test.ts` — three cases at the public seam, in the existing rig (real backend,
   real gateway + stdio fixture, controlled model): nine calls in one round all settle in call order while a second
   conversation's call settles unrefused; a grant written on a **branch** is the branch's own and the source keeps its
   offer, and revoking on the branch takes nothing from the source; a **delegated child** — delegated from a conversation
   that holds a grant, under a deployment default that *does* select `hepi.mcp` for new conversations — selects the
   extension and is still offered no MCP tool, holds no grant, and its attempt settles `tool_unavailable` with no host
   outcome recorded.

Evidence that each case is meaningful, by mutation:

- Removing `executionMode: "sequential"` fails `--test-name-pattern="one at a time"` on the first of nine results with
  the host's own `busy` (`[true, false, false, …]`).
- Removing the attach reconciliation (`await adoptMcpOffer(...)`) fails both branch cases and makes the delegated child
  inherit its parent's name.
- Removing the delegation seam's `modelTools: null` alone, or the attach reconciliation alone, leaves the child isolated;
  removing both makes it inherit. Each statement therefore covers what the other does not.

## Follow-up pass (2026-10-22): what the delivered audit had wrong

The delivered pass above is correct about fork isolation, child non-inheritance, restart settlement, cross-conversation
identity and connection cleanup. Three things it recorded as "already correct" were not, and each is a case a person
actually hits.

1. **A stop did not end the call, and its resume was untested.** The delivered record cites `POST …/abort` only. A
   **stop** is a different contract — it holds the conversation, and its resume is a person's explicit act — and nothing
   pinned what it does to an in-flight MCP call. It works (the caller's abort reaches the invoke request, the host's
   server exits with it, the settlement is an uncertain end), but "works" was an accident of the abort plumbing rather
   than a stated guarantee, and the no-replay half on resume was never observed. Now pinned at the public seam.
2. **A definition-restricted child's report named tools it could not run.** `reportedSelection` applied
   `pi.agent.modelTools` but not `pi.agent.tools`, while the runtime applies `tools` **first**
   (`resolveAgent`: `filterTools(enabled, state.tools)` then `offeredTools(modelCallable, state.modelTools)`). A child
   delegated from a definition carries an exact enabled list (`read`), so its `toolNames` — and the selection seam's
   `offered` list — claimed `read, write, edit, bash`. The report and the run disagreed, which is exactly what the
   function's own docstring promises cannot happen.
3. **A grant written on such a child was answered 200 and offered nothing.** The same missing filter, seen from the
   writer's side: the grant was committed to `hepi.mcp-grants` and loaded into `modelTools`, and the runtime still
   filtered it out by the enabled list, so a person was told their act succeeded while no resolution could reach it. The
   grant write now appends the granted names to an **exact** `tools` list — and only to an exact list, because an unset or
   `{ remove }` filter states no allowlist of its own and widening it would be this writer editing a decision it does not
   own. `reconcileMcpOffer` runs the same reconciliation at boot and at fork, so a reopened backend restores the same
   reachable offer.

Each fix has a test at the public seam and each test is meaningful by mutation:

- Removing `executionMode: "sequential"` fails the nine-call case on the host's own `busy`.
- Removing the attach reconciliation fails both branch cases and makes the delegated child inherit its parent's name.
- Removing the delegation seam's `modelTools: null` alone, or the attach reconciliation alone, leaves the child isolated;
  removing both makes it inherit.
- Dropping the abort handoff (`context.abortSignal`) fails the stop case: the fixture server outlives the stop.
- Making `mcpEnabledOffer` a no-op fails the restricted-child grant case (200, offered nothing).
- Passing `modelTools` without `tools` to `reportedSelection` fails the restricted-child report case
  (`read, write, edit, bash` where `read` is the truth).

Nothing new was introduced: no second registry, no second writer, no scheduler, no per-conversation connection pool. The
three changes are one field read in the right order, one list widened where it is already an allowlist, and three tests
that pin a contract the code already had.

Remaining limit (recorded, not fixed): **inheritance as a product policy.** If a person later wants "this definition's
children may use these tools", the smallest shape is one explicit statement in the agent definition's own frontmatter
resolved by the delegation seam against the delegating conversation's grants — which would need `agent-definitions.ts` to
stop refusing `mcp` as an unsupported key. Nothing in the current tickets asks for that, so no policy, no key and no
frontmatter vocabulary was invented here.
