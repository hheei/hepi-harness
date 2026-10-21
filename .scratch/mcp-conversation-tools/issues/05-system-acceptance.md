# 05 - System acceptance

Type: acceptance ticket
Status: resolved
Blocked by: [03c](03c-browser-tool-states.md), [04](04-child-fork-lifecycle.md) — delivered 01/02/03a and durable grant 03b are covered transitively

Run local Gateway end-to-end configuration-to-tool-call journey and SSH Gateway acceptance or explicit unsupported check. Verify trust, native tool entries, cancellation/timeouts, bounded output, secret redaction, restart/replay, child policy, docs and package checks. Record exact revision, commands, exit codes and logs; resolve material failures before completion.

Journey this ticket must actually observe (UX closeout M1, 2026-10-19): add/test server → list tools → explicit selection → real model invocation with a visible result; disabled, untrusted, offline and changed-schema each yield a named state; child/fork selection follows the approved policy; restart/cancel preserve `replay: "unsafe"` and `outcome_unknown` semantics; no auto grants appear at any point. MCP over SSH remains a separate capability limit — SSH file support does not imply MCP server execution on a remote host.

Evidence rule: branch existence, merged adapter code or a green unit test is not acceptance. Record the revision, the commands, the exit codes and the log paths for the run that was observed.

No deployment/restart is implied.

Cross-effort execution map: [`../../ux-closeout-research/spec.md`](../../ux-closeout-research/spec.md) (M1).

## Delivered (2026-10-20)

Resolved on `impl/mcp-conversation-05`, base `c1299df` (`client-app-integration`). One browser journey,
`apps/web/e2e/ux-mcp-acceptance.mjs`, drives the deployed shape rather than a fixture: the production Vite Web build
served by the real client ingress, the real Backend over its own SQLite files, a real execution gateway on an agent
directory the run owns, the real MCP host service, and one Chromium, with the stdio fixture server as the only stand-in
(it is the host's server, not the code under test). Configuration mode is Pi file-backed, which is the one mode whose
agent directory is both the Gateway's and the Backend's — that is what makes "the credential this run stores" and "the
model this run can call" facts about one account. The credential is stored through the Web ingress; the provider is an
SDK built-in and only its base URL is the run's own controlled completions endpoint, which decides tool calls from the
transcript it is handed, so no paid request is made and no sleep stands in for a fact.

**Journey rows, each observed:**

- add/test: a server added by pasting a config into Settings › MCP is tested there, and the host's own `mcp.json` holds
  it (including the configured value) while no configured value reaches the page.
- no auto grant: the panel names the host's own servers before anything was selected, a conversation that selected
  nothing holds no grant, selecting `hepi.mcp` writes no grant, and the runtime resolves no MCP tool for it.
- list → explicit selection: one press lists one server; a listed tool reads exposed and not selected; three ticks are
  three grants; the runtime's own resolution offers exactly those three names; the grant document names identities and a
  presentation only.
- real invocation: the model asks for the granted tool by its own name, the transcript shows the server's answer, the
  entry carries `gatewayId`/`server`/`tool`/duration, and the configured value never reached the model's prompt.
- bounded output: a 400 KB result commits truncated and under the 256 KiB bound.
- changed schema: a changed description makes that grant read `descriptorChanged`.
- disabled: a switched-off server is stated, its tools all read unavailable, a call settles `server_disabled` without a
  "may have acted" claim, and no earlier entry was repeated or replaced.
- offline: `serversKnown: false` with a named reason, the conversation's grants kept, a listing a named refusal, and a
  revocation that still works because it asks a host nothing; a grant is asked of the host again once it is back.
- restart / replay: a restarted Backend answers the same grant from the store alone, re-offers exactly it, and one
  submitted call is one committed result — the restart replayed nothing.
- cancellation: an in-flight call ends with the caller's abort, settles as an error entry naming an uncertain end, and is
  recorded once and never re-run.
- fork: a branch starts from the grant document's initial value, holds none of the source's grants, is offered no MCP
  tool, and the source keeps its own offer.
- child: this deployment has no worker definition, so the delegated half is **recorded as unexercised here** rather than
  claimed; 04 pins it at the durable seam.
- untrusted: a project server in a folder with no trust decision is refused by the host's own name (`not-authorized`)
  with the missing decision stated, a grant of it writes nothing, and the conversation holds no grant after the refusal.
- SSH: a gateway started with `HEPI_SSH_HOST` answers `read`, `tools` and `invoke` with `mcp_unavailable` — the
  capability limit is stated by the host that lacks it, not inferred by the client.
- no page error occurred at any point in the journey.

**Two material browser defects were found here and fixed at their own seams**, which is what a system acceptance is for:

1. `ExtensionsConfig` read and wrote `/api/sessions/:id/…` — the retired Next BFF's vocabulary — while this deployment
   serves only the Backend's `/api/conversations/:id/…`, so the conversation scope answered "conversation not found" and
   the panel offered the default scope alone. No person could reach a conversation's MCP tools on this deployment. Fixed
   in the component that owns the read.
2. A grant write's answer states the conversation's selection but carries no listing (only a listing read does), and the
   panel read that absence as "no listing held", dropping every tool of that server the moment the first grant was
   written — the person's own tick hid the rows they were choosing from. `withHeldListings` now keeps the readings the
   panel already holds for the servers an answer says nothing about, and `appliedWrite` is the write's own use of it.
   The same rule then proved necessary for the plain **state read**, which the panel's existing fixture journey caught: a
   re-read after a refused listing — and the re-read an extension flip triggers — would otherwise drop the rows a person
   was looking at, so the retention belongs to the seam's reading and not to one caller's write.

The fixture server gained `PI_WEB_FIXTURE_LIST_ECHO_FILE`, and `acceptance-stack.mjs` gained an optional `respond`
script for the controlled model plus `stopGateway`/`restartGateway`, all additive: an existing journey's behaviour is
unchanged when they are absent.

Verification (revision `c1299df` + this worktree's changes, `dirty: true`):

| Check | Command | Result |
| --- | --- | --- |
| The journey, 58 checks | `node apps/web/e2e/ux-mcp-acceptance.mjs` (also `pnpm --filter @hepi/web test:mcp-acceptance`) | exit 0, 58 ok, 0 failed — `.dev/verify/mcp05/journey-final.log` |
| Production Web build it serves | `pnpm --filter @hepi/web build` | exit 0 — `.dev/verify/b16.log` |
| Production App build, so the composed client is unchanged | `pnpm --filter @hepi/app build` | exit 0 |
| UI suite, incl. the two new listing-retention cases | `pnpm --filter @hepi/ui test` | exit 0, 346/346 — `.dev/verify/mcp05/ui-final.log` |
| The browser seam's own unit file | `node --test packages/ui/src/lib/conversation-mcp.test.mjs` | exit 0, 13/13 |
| Typecheck, `packages/ui` and `apps/web` (app and vite configs) | `tsc --noEmit` in each | exit 0 |
| Selected gates over the changed packages and their dependents | `node scripts/verify.mjs --profile=changed --base=c1299df` | `changed-typecheck` 0, `changed-test` 0 (ui 346, app 26, gateway 166, server 352), `web-unit` 0 (14/14); `check-docs` 1 on the unchanged pre-existing broken-link baseline — `.dev/verify/mcp05/verify-changed2.log` |
| The panel's existing fixture journeys, whose stubs moved to the Backend's vocabulary with the fix | `node apps/web/e2e/ux-mcp-tool-states.mjs`, `node apps/web/e2e/ux-extensions-panel.mjs` | exit 0, PASS each |

**Integrated and re-verified by the parent on this line:** source `f2d9268`, 58/58 browser checks and 356 UI tests, every
gate exit 0, run with a stale `.next` moved aside and then restored — so the MCP path does not depend on it. No deployment,
restart or security-boundary probe is implied by that run.

Named limits of this run: the delegated-child row is stated as unexercised on this deployment (no worker definition) and
is pinned at the durable seam by 04; the SSH scene checks the host's own `mcp_unavailable` answer to the MCP route and
does not attempt to run a server over SSH, because that capability is not claimed; and no security-boundary probing was
performed — every request in the journey is an ordinary admitted one.
