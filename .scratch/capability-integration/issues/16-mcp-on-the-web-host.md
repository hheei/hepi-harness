# 16: MCP on the Web host: configuration, test and sign-in

**What to build:** MCP becomes a real capability of the Web host, owned by the service that already runs beside the Web
container: it reads, writes and removes MCP configuration for a global scope and a project scope, tests a server,
signs in and out for OAuth, keeps configuration and credentials on that host, and never hands a secret to the durable
backend.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** On the Web host, add an MCP server, test it against a controlled fake, sign in to an OAuth fake, sign
out, and show the configuration files live on the Web host and nowhere else.

**Stories:** 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90

**Seam:** the Web host service's public surface, plus the controlled fake MCP and OAuth fixture. No network, no real
provider, no paid call, no sleeps.

- [x] The Web host service reads, writes and removes MCP configuration for the global scope and for a project scope, in
      the upstream shapes, with OAuth state beside them.
- [x] A test action starts the server and reports a result; a failure reports a masked, useful reason, and an assertion
      proves no secret appears in any reported reason.
- [x] Sign-in and sign-out change the host's OAuth state, asserted against the controlled fake.
- [x] Project-scoped configuration is refused for a folder without a trust decision and accepted with one, reusing the
      existing trust store rather than adding a per-tool sandbox.
- [x] No MCP credential, token or secret is sent to or stored by the durable backend (assert the backend receives
      none).
- [x] A Web deployment with no host service able to serve MCP answers a named limit, and the rest of the settings keep
      working.

## What was built

**Owner and placement (decision 37).** `McpHostService` is a new operation on the co-located gateway's authenticated
surface (`POST /v1/mcp`), constructed only for a local gateway: MCP belongs to the Web host's account and filesystem,
which is the machine that gateway serves. An SSH gateway serves a remote host and therefore serves no MCP, answering
`mcp_unavailable` — a named limit, not a generic refusal — while `execute`, `files` and `workspaces` keep working.

**Configuration and OAuth state (decision 38).** `packages/gateway/src/mcp/config.ts` owns the global
`~/.pi/agent/mcp.json`, a trusted project's `<folder>/.pi/mcp.json` and `mcp-auth.json` beside them, all in the
upstream shapes. The account is the execution account's own `.pi/agent`; `PI_CODING_AGENT_DIR` is deliberately not
consulted. Writes keep every other key and the file's own indentation, and are written beside the target and renamed
over it at mode 0600, so no partial file is left behind. Reading creates nothing.

**Secret boundary (decision 39).** The Web process carries `/api/mcp` and `GET /api/project-trust` to that service
**directly** (`apps/web/adapters/mcp-host.ts`), never through the durable backend, so the backend is not an MCP
participant. `apps/web/adapters/mcp-host.test.mjs` asserts the route dispatches MCP before the durable adapter and
that the adapter names no backend variable; the gateway suite asserts the whole test/sign-in/sign-out cycle's outbound
requests all go to the configured MCP server and none to a backend address, with a canary secret in the answers.

**Trust gate (decision 40).** The host's own `trust.json` is the authority, read through the `trust` operation and
`GET /api/project-trust`. The service only reads it: recording a decision asks a person, so it stays with the `pi`
CLI or a trust dialog. A project write is refused with `project-untrusted` while no decision trusts the folder, and
the refusal names the folder whose recorded decision refused it. This is the answer to carried finding 2: MCP does
**not** depend on a route that answers nothing, because the decision now comes from the host that owns the folder.

**Masking (decision 41).** `packages/gateway/src/mcp/secrets.ts` masks every reported reason: the entry's literal
env and header values, the parts of its URL, command and arguments that look like credentials, and every value
actually resolved while connecting. pi-web's masking rules are preserved verbatim in `mcp-secrets.ts`. A listing
reports env and header *names* only, never a value. The suite asserts a secret appears in no reported reason.

**Sign-in.** The paste flow, not a loopback callback: the browser runs on the user's computer, not the Web host, so
the redirected address is handed back to the host. That is upstream's own fallback for an unreachable callback. A
flow waits 5 minutes, stays readable for a minute after it ends, and refuses a pasted address whose `state` is not
its own while continuing to wait.

**Tests.** `packages/gateway/test/mcp.test.ts` (7 cases) drives the public `POST /v1/mcp` surface on a real gateway
against controlled local fixtures: a stdio MCP server and a fake OAuth-protected MCP server with its own authorization
server, both local, no network, no paid call and no sleep. `apps/web/adapters/mcp-host.test.mjs` (6 cases) drives the
Web process's routes against a recording stand-in for the host service.

**Coverage of the seam choices.** Which concrete host operation carries MCP (decision 42) is `POST /v1/mcp`, one
operation per request on the existing authenticated surface, rather than a bridge or a second port.

## Verification (2026-10-11, revision `edf2fff`)

Run in a worktree of its own, following [verification practice](../../../docs/agents/verification.md). Every check below
ran against the code revision `edf2fff` (parent `76e75f7`, worktree clean). Only documentation files changed after it —
this ticket and `review-notes.md` finding 24 — so a re-run would measure the same code. The `compare:tests` run pins
both sides itself: base `76e75f7`, tip `edf2fff`.

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm -r typecheck` | 0 | Every workspace package, including `@hepi/gateway` and `@hepi/web` |
| `pnpm -r test` | 0 | 9 client, 46 protocol, 3 session, 87 gateway, 167 server; 0 fail. The gateway's 87 include the 8 new MCP cases |
| `node scripts/verify.mjs --profile=fast` | 0 | `workspace-typecheck` and `workspace-tests` PASS; report `.dev/verify/2026-10-11T15-03-07-203-verify-fast/verify.json` |
| `node scripts/compare-tests.mjs --base=76e75f7` | 0 | base 2083 tests / 24 failing names, tip 2089 / 24; **new on tip: 0**, only on base: 0 — identical failure set. Logs under `.dev/verify/2026-10-11T15-05-12-679-compare-tests/` |
| `node scripts/check-docs.mjs` | 0 | 131 Markdown files, 0 broken relative links, 0 guides missing from the index |
| `node scripts/check-entrypoints.mjs` | 0 | 50 entry files present, 2 known-missing (pre-existing, recorded), 0 newly missing |
| `node .scratch/capability-integration/check-tickets.mjs` | 0 | 18 tickets, no uncovered story, no blocker problem |
| `packages/client/scripts/smoke-pack.mjs` | 0 | Packed tarball, installed outside the checkout, real local and SSH gateways: the installed CLI answers a real MCP listing on `/v1/mcp` and refuses a bad token |

The Web unit suite keeps its **23-failure baseline** (24 `not ok` names) and is not reported green, per
[known failures](../../../docs/agents/verification.md). The comparison above shows the failing set is unchanged by
this ticket.

**Context:** [Spec](../spec.md) decisions 36–42; stories 80–90. The owner, the placement and the secret boundary are
fixed; which host operation carries MCP is this ticket's choice. The browser half is ticket 17.

## Review notes

**Finding 2 (carried, `investigate`) — resolved by this ticket.** `/api/project-trust` answered 501 for every cwd,
which had no user-visible effect while nothing consumed it. Project-scoped MCP configuration is gated on that trust
decision, and the answer now comes from the host that owns the folder: `GET /api/project-trust` reads the execution
host's own `trust.json` through the host service's `trust` operation, which is the same store the host's resource
loader and the `pi` CLI use. The gate is therefore a real decision rather than a route that always answers nothing,
and the MCP surface does not depend on the durable backend for it. Recording a decision is deliberately not part of
this ticket (it asks a person), so the route answers the read only; a write attempt is `405`.

New findings recorded by this ticket, following [review policy](../../../docs/agents/review-policy.md):

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 20 | The host's own process environment reaches a stdio MCP server, as upstream's default transport does. A literal `!`-command value or `${NAME}` reference in an entry therefore resolves against the Web host's environment, including any credential the gateway process itself holds. | The user configures the entry, on their own host, as they would for the `pi` CLI on that same machine; upstream behaves identically. A server entry is not a trust boundary, and the gateway already executes allowlisted commands as that account. | `record` | An entry arrives from a source the user did not choose (a synced config, an imported paste) and the deployment shows a material leak. |
| 21 | `validateServerConfig()` restates the SDK's validator rules because the SDK does not export its validator. An entry the SDK refuses for a rule not restated is stored, then refused at connect time and reported as a test failure. | The restated rules cover every field the SDK's validator checks. A future SDK rule would make an invalid entry storable until it is tested. | `record` | An SDK upgrade adds a validation rule, or an entry is stored that the SDK refuses at connect time. |
| 22 | A sign-in flow lives in the host service's memory: a restart during a sign-in loses the flow, and the panel's poll answers `sign-in-unknown`. | Upstream's flow is in-memory too, and a sign-in takes seconds. The user starts it again. | `record` | A host service is restarted routinely mid-sign-in. |
| 23 | `HEPI_WEB_GATEWAY_URL`/`HEPI_WEB_GATEWAY_TOKEN` are new Web-process variables, so the MCP surface answers `mcp_unavailable` on every deployment until an operator sets them. | The limit is named and every other setting keeps working; the panel says so. Ticket 17 presents it. | `record` | A deployment is expected to serve MCP and does not say why it cannot. |
