# 01 - Gateway invocation contract

Status: resolved — implemented on `impl/mcp-conversation-01` (base `95f9257`), see *Delivered* below.
Blocked by: None

Define protocol and Gateway service for invoking an already-configured, explicitly authorized MCP tool. Bind request to conversation/workspace and selected server/tool; reject arbitrary config/command input. Bound deadlines, output, concurrency and resource lifetime. Support cancellation and sanitized errors. Establish local Gateway behavior and report SSH support boundary.

Acceptance: protocol validation, auth/scope rejection, tool lookup, success/error, timeout, cancellation, output cap, disconnect, secret redaction and cleanup tested. No credentials returned to backend.

## Delivered

One new operation on the surface that already exists — `POST /v1/mcp` with `operation: "invoke"` — and no second
configuration store, credential store, MCP client or process owner. The route, the bearer token, the folder resolution
and the caller's abort are the ones every MCP operation already uses.

| Piece | Where | What changed |
| --- | --- | --- |
| Wire shapes | `packages/protocol/src/gateway.ts` | `McpToolCallRequest`, `McpToolCallOutcome`, `McpInvocationFailureCode`, `McpToolCallResult`, four bound constants; `McpHostRequest` gains the variant |
| Connection seam | `packages/gateway/src/mcp/connection.ts` (new) | The connect path `host.ts` already had, extracted so a test and an invocation cannot disagree about environment, headers, credential store, timeout or close; `connectServer` returns the server's stderr with a failed start |
| Invocation | `packages/gateway/src/mcp/invocation.ts` (new) | Validation, entry lookup, exposure gate, tool lookup, deadline, concurrency, result conversion and cut, masking, cleanup |
| Host service | `packages/gateway/src/mcp/host.ts` | Dispatches `invoke`; tracks in-flight calls so `close()` waits for them; a project entry is now read only for a folder this host's trust store trusts (the gate the write path already applied) |
| Client | `packages/gateway/src/control.ts` | `GatewayControl.invoke`, classified as a mutation so a lost answer is `outcome_unknown` and never replayed |
| Tests | `packages/gateway/test/mcp-invocation.test.ts` (new), `control.test.ts` | Public-seam tests over the real HTTP route; client classification tests |
| Fixture | `packages/gateway/test/fixtures/mcp/stdio-server.mjs` | Opt-in `slow`, `big` and `fail` tools (`PI_WEB_FIXTURE_INVOKE_TOOLS`), so a deadline, a cancellation and an output cut each have a real server behind them |
| Guide | `docs/mcp-on-the-web-host.md` | The operation, its bounds, its failure vocabulary and the local-only boundary |

The request binds the call to a conversation and a workspace (`callId`, `conversationId`, `workspaceId` or `cwd`) and
to one configured server and one of its tools. It cannot carry `config`, `command`, `args`, `env`, `url`, `headers` or
`auth`: each is refused by name before anything is read or started, so an invocation is never a way to have the host
run something the selection did not name.

Bounds: 60 s default deadline clamped to 5 min, 256 KiB result (cut and `truncated`), 64 KiB arguments, 8 concurrent
calls per host (over the bound is `busy`, never queued), one process and connection per call closed in a `finally`,
and the service's `close()` aborts and awaits whatever is still running.

Failure vocabulary, each of which is either "nothing ran" or "it may have run": `invalid_request`, `unknown-workspace`,
`server-missing`, `server-invalid`, `server-disabled`, `not-exposed`, `not-authorized`, `unknown-tool`,
`arguments-too-large`, `busy`, `timeout`, `cancelled`, `needs-auth`, `operation_failed`. `timeout` and `cancelled`
say in their message that the server may have acted; nothing is replayed.

No credential crosses the seam in either direction: the entry is read from the host's own files, the OAuth state from
the host's own store, and every returned block and reported reason is masked with the entry's literal secrets and the
values resolved for it.

### Evidence

| Behaviour | Test |
| --- | --- |
| Protocol validation, configuration keys refused, nothing started | `an invocation names a configured server and tool…` |
| Authentication, unknown/invalid/disabled/hidden server, hidden tool, unknown tool, folder trust, foreign folder, unknown workspace | `the invocation is authenticated and refuses…` |
| Success, attribution, no configuration in the answer, secret masked in a result, the tool's own failure, output cut | `a selected tool runs on the host…` |
| Deadline → `timeout`, server reached, process gone | `a call past its deadline…` |
| Caller cancellation → `cancelled`, process gone | `a caller that cancels…` |
| Cancellation during `!command` value resolution → no server started, value command ended | `a caller that cancels while a \`!command\` value is still resolving…` |
| A caller already gone has no value command run for it | `a caller already gone is refused before any value command runs` |
| Connection dropped mid-call, process gone | `a caller that disconnects mid-call…` |
| Duplicate call identity and the concurrency bound | `one call identity is not run twice…` |
| `needs-auth`, a server that will not start (masked), service stop ending a running call | `a server that needs a sign-in, or will not start…` |
| Client: body is the call only, lost answer is `outcome_unknown` and not resent, a refusal keeps its code, cancellation | `control.test.ts` invocation cases |

## Verification

Run in the worktree `.dev/worktrees/mcp-conversation-01` on branch `impl/mcp-conversation-01`.

| Command | Revision | Exit | Log |
| --- | --- | --- | --- |
| `pnpm verify:changed --base=95f9257` | `2926363a4d8b50242e6cf12e1beefb3028eee71e`, clean tree | 1 (see below) | `.dev/verify/2026-10-18T08-28-35-120-verify-changed/` |

Its steps, from that run's own `verify.json`:

| Step | Exit | Log |
| --- | --- | --- |
| `changed-typecheck` (app, server, web, gateway, protocol, session, ui) | 0 | `changed-typecheck.log` |
| `changed-test` (recursive package tests) | 0 | `changed-test.log` |
| `web-unit` | 0 | `web-unit.log` |
| `check-docs` | 1 | `check-docs.log` |

`check-docs` is **the pre-existing failure set, not this change**. The base revision was checked out on its own
(`git worktree add --detach /tmp/mcp01-base 95f9257`) and `node scripts/check-docs.mjs --root=/tmp/mcp01-base` exits 1
with the same 12 broken relative links (11 of them `.dev/verify/...` paths under other efforts, one
`.pi/skills/...` link under `development-audit`); `diff` of the two `BROKEN` line sets is empty, and the tip run
reports the same 12 for 352 files against the base's 344 — the extra 8 files are this ticket's own scratch documents,
none of which is reported broken. Logs: `/tmp/mcp01-docs-base.log`, `/tmp/mcp01-docs-tip.log` (retained outside the
worktree; the tip copy is also `check-docs.log` in the run directory above).

`node scripts/check-entrypoints.mjs --root=<worktree>` exits 0 with the repository's two recorded known-missing Web
entry files and no newly missing one (`/tmp/mcp01-entrypoints.log`).

The focused gateway runs behind this ticket's claims, each on the same revision, all exit 0:

| Command (cwd `packages/gateway`) | Result |
| --- | --- |
| `node --test --test-reporter=tap test/mcp-invocation.test.ts` | 8 tests, 8 pass |
| `node --test --test-reporter=tap test/mcp.test.ts test/mcp-invocation.test.ts test/ingress-mcp.test.ts` | 26 tests, 26 pass |
| `node --test --test-reporter=tap test/control.test.ts` | 32 tests, 32 pass |
| `pnpm --filter @hepi/gateway test` | 386 tests, 386 pass |

The branch's tip is `integration/client-app` (`95f9257`) plus this ticket's one commit;
`git merge-base --is-ancestor integration/client-app HEAD` is true, and the tree is clean after it.

### Cancellation fix (`10b2170`)

Run in the same worktree on `impl/mcp-conversation-01`, tree clean, after merging the integration tip into the branch.

| Command | Revision | Exit | Log |
| --- | --- | --- | --- |
| `pnpm --filter @hepi/gateway typecheck` | `87f5e32b` (merge of `b51926b` into `10b2170`) | 0 | `/tmp/mcp01-post-typecheck.log` |
| `pnpm --filter @hepi/gateway test` | `87f5e32b` | 0 — 395 tests, 395 pass, 0 fail | `/tmp/mcp01-post-gateway.log` |
| `node --test --test-reporter=tap test/mcp.test.ts test/mcp-invocation.test.ts test/ingress-mcp.test.ts` (cwd `packages/gateway`) | `10b2170` | 0 — 28 tests, 28 pass | `/tmp/mcp01-mcp-tests.log` |
| `pnpm --filter @hepi/session typecheck` / `test` (dependent package) | `87f5e32b` | 0 / 0 — 52 tests, 52 pass | `/tmp/mcp01-session-typecheck.log`, `/tmp/mcp01-session-test.log` |
| `node scripts/check-docs.mjs` | `87f5e32b` | 1 — 12 broken relative links, 367 files | `/tmp/mcp01-checkdocs.log` |

`check-docs` exits 1 on the repository's **pre-existing set**: its 12 `BROKEN` lines are byte-for-byte the base
revision's set recorded above (`diff` of the sorted `BROKEN` lines exits 0), and none is in a file this change touched.

The two new tests were also run against the seam deliberately reverted to the previous behaviour: both fail
(`# pass 0`, `# fail 2`, `/tmp/mcp01-*` above), so they hold the fix rather than the current code by construction.

## Merge into `integration/client-app`

Merged as `b7c49b3` (`--no-ff`, `ort`, parents `926341c` + `0a98dfa`) with no conflict and no hand resolution. The
merge-base with the integration line was `b51926b`: the branch already carried that tip (`87f5e32` merges it) but not
the provider work (`git merge-base --is-ancestor db1470f 0a98dfa` exits 1), so the only real intersection was between
this ticket's protocol additions and provider ticket 01's.

Two paths overlapped, both auto-merged. `packages/protocol/src/gateway.ts` is the one code intersection: the provider
branch appended the `ProviderAuth*` declarations, this branch appended `MCP_INVOKE_*` and the
`McpToolCall*`/`McpInvocationFailureCode` declarations, at disjoint tails of one file. The merged file is a strict
union — `diff` against the branch tip's copy removes **0** lines and adds 83 (the provider side), and against the
integration tip's copy removes 1 line only (the sign-out union member this branch extends to carry the new
`McpToolCallRequest` variant) and adds 87. `docs/migration-status.md` overlapped second, at ~405 here vs ~476 there.
Neither branch touched the other's owner: `control.ts` and `packages/gateway/src/mcp/*` are this branch's alone,
`index.ts` and `startup.ts` the provider's alone, so the 9-argument `GatewayRpcServer`/`startGateway` composition and
both `profile === undefined` local-only wirings survive unchanged.

| Check | Command | Revision | Exit | Raw log |
| --- | --- | --- | --- | --- |
| Combined seam (invocation 10, control 32, provider-auth 15, startup 6) | `node --test packages/gateway/test/mcp-invocation.test.ts packages/gateway/test/control.test.ts packages/gateway/test/provider-auth.test.ts packages/gateway/test/startup.test.ts` | `b7c49b3` | 0 (63/63) | `.dev/verify/merge-client-app-10/combined-gateway-seam.log` |
| Gateway, protocol and session typecheck on the merged tree | `pnpm --filter @hepi/gateway typecheck`, then `@hepi/protocol`, `@hepi/session` | `b7c49b3` | 0 / 0 / 0 | `.dev/verify/merge-client-app-10/gateway-typecheck.log`, `protocol-typecheck.log`, `session-typecheck.log` |
| Whole changed tree | `pnpm verify:changed --base=926341c` | `b7c49b3` (`dirty: false`) | 1 — `check-docs` only | `.dev/verify/2026-10-18T11-39-14-316-verify-changed/verify.json` |

`verify:changed` selected `@hepi/app, gateway, protocol, server, session, ui, web` and ran them: `changed-typecheck` 0,
`changed-test` 0 with **gateway 410** (the provider tip's 396 plus this ticket's 14 net new — 10 invocation, 4 control),
server 467, ui 193, session 52, protocol 51, app 9, 0 fail; `web-unit` 0 (52). This branch changed no dependency
manifest, so no install step was needed (unlike the provider merge before it).

Source equivalence both ways is what lets this ticket's `87f5e32` rows stand: `git diff --exit-code 0a98dfa` over
`packages/gateway/src/mcp`, `control.ts`, `mcp-invocation.test.ts`, `control.test.ts`, the MCP fixture,
`packages/protocol/src/gateway.ts`, `docs/mcp-on-the-web-host.md` and `.scratch/mcp-conversation-tools` exits **0**, and
the provider paths exit 0 against `926341c`. The merged tree differs from the branch tip in 21 paths, all
provider-side, and from the integration tip in 18 paths, all MCP-side.

`check-docs` exits 1 on the unchanged baseline: 12 `BROKEN` lines over 376 files (+9 files are this ticket's own, all
valid), and `.dev/verify/merge-client-app-10/broken-tip-mcp.txt` diffs empty against the `80608d6` baseline in
`.dev/verify/merge-client-app-8/broken-base-80608d6.txt`. Recorded, not repaired here.

## Review notes

**Fixed — cancellation during value resolution started a server anyway** (review of `b37fbd1`).
`connectServer` attached the caller's abort listener after `resolveConnectionValues`, so an abort that landed while a
`!command` value was running neither killed that command nor stopped the attempt: it went on to `client.connect` and
started a process for a caller that had already left, unreachable by the listener that was never attached. Fixed in the
owning seam (`packages/gateway/src/mcp/connection.ts`): resolution is given the same signal, the value command runs
under it, and the attempt is refused if the signal is aborted before a transport exists. The seam's own words are
`REFUSED_BEFORE_START`, and an invocation reports that refusal under its code (`cancelled` or `timeout`) without the
"may have acted" claim, because a refusal made before a transport exists is one this host knows ran nothing. The
sign-in path threads its caller's abort into header resolution too. Regression: the two table rows above, both of which
fail against the previous seam.

**Recorded, not fixed — the advisories below are not normal-use failures and reopen nothing.**

- **The OAuth store is not in an entry's masking set.** `resolveConnectionValues` adds every resolved env and header
  value to the redactor, but a token read back from `mcp-auth.json` never goes through it, so a reason that quoted an
  access token verbatim would not be masked. Trigger: an authorization server echoing the token it was given into an
  error body — speculative, and the reported reasons come from the SDK's own messages. Revisit on evidence of a real
  answer quoting one.
- **An image block is not redacted.** `blocksOf` masks text and keeps an image whole or drops it, because half a base64
  payload is not an image. So a secret inside image bytes travels unmasked. Trigger: a server returning a credential as
  an image, which is not how any configured server here behaves; masking bytes would destroy the block. Revisit if a
  real server is seen doing it.

## SSH boundary

MCP belongs to the local gateway beside the Web container; a gateway serving an SSH host constructs no MCP service and
answers `mcp_unavailable` (unchanged, asserted by `mcp.test.ts`). An invocation over SSH is therefore **not
implemented and not implied** by this ticket: nothing here was tested against a remote gateway, and a deployment whose
Backend can reach only a remote gateway has no invocation path today. Ticket 05 owns stating that boundary end to end.

## Not in this ticket

No Backend tool exposure, durable tool entry or settlement (02). No selection or trust UI (03). No child/fork policy
(04). No progress streaming: the contract is one bounded request and one bounded answer, and cancellation reaches the
underlying MCP request through the composed abort signal.
