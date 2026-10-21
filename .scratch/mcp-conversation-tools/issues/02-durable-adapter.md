# 02 - Durable conversation adapter

Status: resolved and **integrated** — implemented on `impl/mcp-conversation-02` (base `b7c49b3`, integration `1873d24` merged
in), reviewed APPROVED on the final tip `ebf26df` (`5a485db` first, then the spec-body restore), merged into
`integration/client-app` as `61c2d6692821e1d040ef8d2b3a8d898d0eec440a`; ticket 03 owes the tool-discovery decision recorded below
Blocked by: 01

Adapt selected Gateway MCP tools into the native durable conversation tool set. Invoke through the Gateway contract; persist tool call/result using existing lifecycle and handle caller cancellation, Gateway failure and uncertain side-effect outcomes without blind retry.

Acceptance: end-to-end server test observes native tool entries and correct settlement; restart/replay cannot silently repeat an uncertain external call; backend never sees MCP credentials.

## Delivered

The seam between a conversation's durable tool lifecycle and the host's MCP route, in two files and no new wire
surface: `apps/server/src/mcp-conversation-tools.ts` (the adapter) and `apps/server/src/mcp-declarations.ts` (what a
deployment is allowed to say about the tools it offers).

| Piece | What it is |
| --- | --- |
| `hepi.mcp` | One extension, installed when the deployment declares tools (03b widened this to "when a gateway is configured", because an extension installed only by a declaration would make that declaration a ceiling), and an **optional** one: it is out of the default selection, and a conversation bound to no execution workspace is refused it with 409 `unavailable_extension` — the same rule `coding-tools` already has |
| `mcp__<gatewayId>__<server>__<tool>` | One native tool per declaration. Segments sanitized to `[A-Za-z0-9_-]`, joined name bounded to 64 characters, a collision refused by naming **both** tools rather than silently renaming one; 128 per server, 256 per backend, and every dropped tool is reported by name at startup |
| Call-time binding | The conversation's own `WorkspaceDoc` → `ensureBinding` → that gateway's client, resolved when the call runs, not when the tool was installed. The request carries the runtime's `callId`, the conversation id, the workspace id and the entry's scope — never a path, never a model-named host, and no `deadlineMs`, because the host's bound is the host's policy |
| `replay: "unsafe"` | The whole no-repeat rule, stated where the runtime reads it. Nothing retries at any layer: not the tool body, not the transport, not this adapter |
| Settlement | The server's own blocks as ordinary tool output; the host's facts (`callId`, gateway, server, tool, `isError`, `truncated`, `durationMs`) on the entry's `details`; the host's refusal codes preserved (`not_exposed`, `server_disabled`, `unknown_tool`, `mcp_unavailable`, …); an uncertain end — the transport's `outcome_unknown`/`timeout`/`aborted`/`protocol_error` or the host's own `timeout`/`cancelled` — recorded with the notice that the server may have acted |
| Cancellation | `context.abortSignal` is handed to the invoke request, so the host's abort path runs and the server process it started exits with the call |
| Credential boundary | The request carries names and arguments; the answer carries the host's masked blocks. No `mcp.json`, no resolved value, no OAuth state and no credential reaches this process in either direction — observed as a fixture server echoing the token it was started with and reading back only `SECRET_MASK` |
| `HEPI_MCP_TOOLS` | The deployment's declarations, validated at startup: a host-owned field (`command`, `args`, `env`, `url`, `headers`, `auth`, `config`, `cwd`, `workspaceId`), a gateway this backend does not configure, an over-long list or a malformed entry **stops the process**, naming the entry and the field and never echoing the input |

## The dependency this ticket could not close: no tool discovery on the route

Ticket 01's surface answers `read`, `trust`, `write`, `patch`, `test`, the sign-in operations and `invoke**. None of
them reports a server's **tool names or their schemas**: `read` describes an entry and its exposure, `test` reports the
count of tools it found, and the panel says so ("the host reports how many tools it found, not what they were"). A
listing would have to connect the server to answer, which would put an unrelated call behind a connect.

So this adapter takes its offer from the deployment, and the acceptance criterion "Adapt **selected** Gateway MCP tools"
is met in two parts: the *selection* half is real (per-conversation extension selection, enforced by the runtime's own
per-conversation agent state, with the coarse switch already refusing an unbound conversation), while the *catalogue*
half is declaration-driven. Two consequences are deliberate, not gaps to hide:

- **A declared tool the host does not have is not a callable one**, and the answer is the host's own `unknown-tool` —
  observed by a test that declares exactly that. The backend keeps no second inventory and re-derives nothing.
- **`inputSchema` comes from the declaration**, and is carried verbatim (`Type.Unsafe`) so the runtime validates the
  model's arguments before anything leaves. A shape that cannot be an argument object, a schema larger than 64 KiB, or
  an unparseable one is refused rather than offered unvalidated.

**What ticket 03 has to decide** (with the gateway, since it is a wire question): an operation that answers tool names
and schemas for a configured entry without the caller having to `test` each one, its bounds and its masking, and the
per-server/per-tool trust that narrows today's whole-extension switch. Recording it here rather than in code because
inventing a discovery-shaped port that nothing on the host can answer would be a second authority, not a seam.

## Deliberately left to ticket 04

A fork and a child inherit the **extension** selection through the runtime's own `pi.agent.extensions` (fork
`current`), so a fork of a conversation that selected `hepi.mcp` keeps the offer; there is no MCP-specific inheritance
rule yet, and none was invented. Per spec the child/fork policy — including whether an uncertain MCP call may repeat
there, and connection reuse and cleanup across the tree — is ticket 04's decision.

## Verification

Branch `impl/mcp-conversation-02`: base `b7c49b3`, implementation `bf1634f`, then the merge and cleanup commits this
record names below; tree clean after each. **The runs to reuse are the last table's** — this first one is the original
implementation tip, before the integration line moved and before the cleanup pass.

| Command (cwd `apps/server`), at `bf1634f` | Result |
| --- | --- |
| `node --test test/mcp-conversation-tools.test.ts` | 15 tests, 15 pass, 0 fail |
| `node --test test/mcp-declarations.test.ts` | 6 tests, 6 pass, 0 fail |
| `pnpm exec tsc --noEmit -p tsconfig.json` | exit 0 |

The adapter tests run against a **real** gateway surface (`GatewayRpcServer` + `LocalGateway` + `McpHostService`) with
the real stdio fixture server, and a **real** backend (`createBackendServer`) on its own SQLite file, driven through
the routes a conversation uses (`POST /api/conversations`, `PATCH /api/conversations/:id/extensions`,
`POST /api/conversations/:id/messages`, `/abort`, `/state`, `GET /api/extensions`). Each acceptance claim has its own
test:

| Acceptance | Test |
| --- | --- |
| Native entries and correct settlement | `a selected tool is offered, runs on the bound gateway, and is committed as an ordinary durable tool result` — the call and its result are ordinary durable entries, the host's facts are on `details`, the tool is in the conversation's `toolNames` and only after selection |
| Configured but unselected → no call | `a conversation that never selected the extension is refused before any request leaves the backend` — the runtime's own unavailable-tool settlement, and the fixture's pid file never written |
| Restart cannot silently repeat | `a real SIGKILL inside an MCP call settles it as interrupted and never repeats the side effect` (`test/mcp-replay-crash-child.ts`): the kill lands **inside** the body after its external effect is on disk, the effect stays one line, a reopened process reaches the host **zero** times and the call settles as `interrupted` / "may have partially run"; a second reopen still shows one result |
| No credential in the backend | `the host masks a credential before it reaches the backend, in either direction` — the server echoes the value it was started with, the entry carries `SECRET_MASK`, and no part of the conversation state contains the literal |
| The host's answers stay the host's | `the host's own refusals…`, `a gateway that serves no MCP answers its own named limit…` (`mcp_unavailable`, nothing sent), `a conversation bound to no execution workspace…` |
| Cancellation | `a caller that goes away ends the host request, and the uncertain call is not run again` — the fixture's server process exits with the abort, the settlement names an uncertain end, and a later turn runs the call exactly once |
| Declaration boundary | `mcp-declarations.test.ts` — a host-config field, an unknown gateway, an over-long list and each malformed entry stop startup; a declaration that names nothing installs nothing |

The branch moved twice while this ticket was in progress: integration advanced to `bbd0d59` (subtree, SSH-workbench,
provider work) and then to `283caa0`, both merged in (`5bf3b65`, `10c5b4b`) with no conflict in any path this ticket
owns; a cleanup pass then removed the adapter's dead surface and repeated test setup (`56e38b5`). The profile was run
again on each merged, clean tip, and the last run is the one to reuse:

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm verify:changed --base=integration/client-app` on `56e38b5` | 1 — `check-docs` only | `.dev/verify/2026-10-18T17-52-09-581-verify-changed/verify.json` |
| ↳ `changed-typecheck` (`pnpm --filter @hepi/server -r typecheck`, the server and its dependents) | 0 | `changed-typecheck.log` |
| ↳ `changed-test` (`pnpm --filter @hepi/server -r test`) | 0 | `changed-test.log`: **493 pass, 0 fail** on the merged tree |
| ↳ `check-docs` | 1 | 12 broken relative links, **the repository's pre-existing set**: the same command on a detached base worktree yields a byte-identical sorted `BROKEN` list (`diff` exits 0), none in a file this change touched |
| `node --test test/mcp-conversation-tools.test.ts test/mcp-declarations.test.ts` (cwd `apps/server`) | 0 | 20 tests, 20 pass — 14 adapter + 6 declaration |
| `pnpm exec tsc --noEmit -p tsconfig.json` (cwd `apps/server`) | 0 | also run alone on every tip |
| `node scripts/check-entrypoints.mjs --root=<worktree>` | 0 | 76 entry files present, the 2 recorded known-missing Web entries, no new one |

## Merged: what the integration tip re-proved

Merged as `61c2d66` (parents `c2d9089` + `ebf26df`), preview `f5be8be` clean, no conflict. `git merge-base` against the
integration tip was `283caa0` — the branch merged that exact commit at `10c5b4b` — so `apps/server` at the merged tip is
byte-identical to the `56e38b5` tree this table reports and the 493-case result is about the merged code. The combination
question was one path wide: `docs/migration-status.md` is edited by this ticket and by SSH 03; `server.ts` is edited only
here. And because `mcp-conversation-tools.ts:39-40` imports `@hepi/protocol/gateway` and `@hepi/gateway` symbols that moved
since the tested tree, `@hepi/server`+`@hepi/app`, `@hepi/protocol` and `@hepi/gateway` were typechecked at the merged tip
(exit 0) instead of inherited.

At the merged tip: the two files above alone 20/20 (`mcp-focused.log`), the server suite with
`node --test --test-concurrency=1 test/*.test.ts` **493/493** (`server-serial.log`), `pnpm verify:changed --base=c2d9089`
→ `changed-typecheck` 0, `changed-test` 0, `check-docs` 1 on the 12 baseline links over 386 files
(`merged-verify-changed.json`, sha `61c2d66`, `dirty: false`). One concurrent run of the package script failed
`provider-config.test.ts` on the known stub-parses-empty-body flake — file untouched by this merge, passes 5/5 alone three
times; see `docs/verification.md`.

Also mine, and worth stating: `test/mcp-replay-crash-child.ts` is **not** a test file. It is the two-stage child process the
restart case spawns; running it directly under `node --test` fails its own stage assertion. Any focused command that globs
it in reports a false failure.

An earlier run on the pre-merge tip (`2d4d7e1`, base `1873d24`) is at
`.dev/verify/2026-10-18T17-17-13-483-verify-changed/`: 489 pass, 0 fail, same `check-docs` set.

The cleanup pass removed, with no behaviour change and no test lost: the exported `MCP_TOOL_PREFIX` and
`McpToolDefinition` (nothing outside the file named them), `McpToolBridge.registrations()` (the extension **is** the
offer, and the runtime's registry is the one authority on what is installed), a three-field identity guard the
declaration parser upstream already refuses, and three one-use helper fns (`mcpBlockOf`, `diagnostic`, `warning`).
Two host-less-refusal tests became one table-driven case, and four hand-written single-call faux scripts became one
`calls()` helper: 88 lines out, 48 in.

## Comments

- The name shape is `mcp__<gatewayId>__<server>__<tool>` rather than `mcp__<server>__<tool>`: two configured gateways
  can each have a server called `docs`, and the tool that runs is a fact about the host, so a name that cannot say
  which host it means would be one tool silently standing in for another.
