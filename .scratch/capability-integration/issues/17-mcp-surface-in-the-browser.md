# 17: MCP surface in the browser

**What to build:** The existing MCP dialogs are wired to the Web host service from ticket 16: list, add, edit, remove
and test servers, and sign in and out, with a masked failure reason and no control the host cannot perform.

**Blocked by:** 16: MCP on the Web host: configuration, test and sign-in

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** In the browser, open the MCP settings dialog, list and add a server, test it and see a masked failure,
sign in and sign out, and remove the server.

**Stories:** 80, 81, 82, 83, 84, 85, 86, 87, 90

**Seam:** browser → Web host service, with the controlled fake MCP and OAuth fixture.

- [x] The MCP dialogs read and write through the Web host service and show the host's real configuration.
- [x] Add, edit and remove each change the host configuration and the list without a page reload.
- [x] Test shows a result, and a failure shows a masked reason with no secret in it.
- [x] Sign-in and sign-out are reachable and change the host state.
- [x] An unavailable host service is shown as a named limit in the dialog, and no hidden refusal is left behind.
- [x] No control is presented in the dialog that the host cannot perform.

**Context:** [Spec](../spec.md) stories 80–90; decisions 36–41. The host half is ticket 16.

## What was built

**One client, one aggregate.** `apps/web/adapters/mcp-host.ts` is now only the host service's client: one operation
per call to `POST /v1/mcp`, and the host's own answer. `apps/web/adapters/mcp-surface.ts` is the aggregate the panel
reads, composing `GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/test`, `POST|GET|DELETE /api/mcp/sign-in[/<id>]`
and `GET /api/project-trust` from the host's own read, its trust decision and one operation per write. The catch-all
route hands it `hostCwdOf` so it never names a backend address itself, and the route test asserts the MCP branch
returns before the durable adapter.

**The browser's cwd is resolved to the host's path (a real gap this ticket found).** A browser cwd is a routing
address — `/workspace/<id>`, a project group or the unbound sentinel — which the Web host service knows nothing
about; the panel had always sent it as if it were a path. The surface now resolves it through the same rule every
other host-facing route uses (`hostCwdOf()` in `durable-api.ts`) and sends the folder's own path to the host, while
telling the panel the address it sent. The unbound sentinel leaves the global configuration alone, and a path this
deployment serves no folder for is refused as one.

**One new host operation, `patch` (decision 42 left the operation to the ticket).** A switch, an exposure change and
a bulk switch are now one change to named keys of an entry, so a value the Web process never sees — an env or header
value — is left exactly as the file holds it; `null` removes a key, and the entry after the change passes the same
validator and the same trust gate as any write. The listing also reports what a change and the panel need without any
value: the exposure, the per-tool exposure count, whether a value was masked, whether the entry is an object at all
(`notAnObject`), and whether the OAuth state holds tokens or only what a cancelled sign-in left (`oauthStateStored`).

**What the panel is given, and what it is not.** The host reports how many tools a test found, not what they were, so
`McpTestResult.tools` is optional and the panel shows the count and no list. A test's last answer is kept in the Web
process, keyed by the entry the host described, so reopening Settings still shows the Connection row; the host keeps no
test history, as upstream keeps none, so a Web process restart loses it and the row reads `on` until the next test.
`McpResponse.codemode` is optional: the Code mode settings belong to the sessions' runtime, which this Web origin
does not serve, so the panel is given none and shows no Code mode row, no Always-on switch and no budget field — a
control the host cannot perform. No Undo is offered after a removal, because the host keeps no copy of an entry. The
trust dialog is no longer wired to the panel: recording a decision asks a person on the host that owns the folder, so
the notice says where it is recorded instead of offering a write this deployment does not serve.

**The named limit, in the dialog.** A refusal that is the deployment's own (`mcp_unavailable`, `mcp_unreachable`)
is carried with its code and shown as the limit it is — the variables to set, or that the host service did not answer
— with no server list and no controls, rather than as a refusal of what the panel asked for.

**Kept from the copied panel.** The whole Settings › MCP surface — the sidebar, the detail pane, the add wizard with
its importer, the sign-in panel with its paste flow and poll, the group switches, the file-problem footer — is the
existing component, wired to the new surface.

## Verification

Commands and revisions, following [verification practice](../../../docs/agents/verification.md). Every check below
ran against the code revision `3198b6b` in a worktree of its own at `/tmp/hepi-t17-verify`, whose tree was **clean**
(`pnpm compare:tests` records `caller.dirty: false`, the base `78678f9` pinned by the run itself).

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm -r typecheck` | 0 | Every workspace package |
| `pnpm -r test` | 0 | 9 client, 46 protocol, 3 session, 103 gateway, 186 server; 0 fail. The gateway's 103 include the new `patch` and listing cases |
| `pnpm test:web:unit` | 1 | The recorded 23-failure baseline, 24 `not ok` names, 2110 tests / 2087 pass. Report `.dev/verify/2026-10-11T18-01-43-572-web-unit/web-unit.json` |
| `pnpm compare:tests --base=78678f9` | 0 | base 2108 tests / 23 failing names, tip 2110 / 23; **new on tip: 0**, only on base: 0 — identical failure set. Report `.dev/verify/2026-10-11T18-04-32-756-compare-tests/comparison.json` |
| `cd apps/web && node --test adapters/mcp-surface.test.mjs` | 0 | 8 cases on the browser's own routes against a stand-in host service and a stand-in backend |
| `pnpm --filter @hepi/web build && node apps/web/e2e/ux-mcp-surface.mjs` | 0 | 26 checks in the worktree: the real Web UI, the real backend and a real gateway with the controlled stdio and OAuth fixtures |
| `node scripts/verify.mjs --profile=fast` | 0 | `workspace-typecheck` and `workspace-tests` PASS. Report `.dev/verify/2026-10-11T17-58-47-253-verify-fast/verify.json` |
| `node scripts/check-docs.mjs` | 0 | 131 Markdown files, 0 broken relative links, 0 guides missing from the index |
| `node scripts/check-entrypoints.mjs` | 0 | 51 entry files present, 2 known-missing (pre-existing, recorded), 0 newly missing |
| `node .scratch/capability-integration/check-tickets.mjs` | 0 | 18 tickets, no uncovered story, no blocker problem |
The Web unit suite keeps its **23-failure baseline** (24 `not ok` names) and is not reported green, per
[known failures](../../../docs/agents/verification.md). The comparison above shows the failing set is unchanged by
this ticket, which is what the E2E driver is the evidence for.

The demo path, driven end to end by `apps/web/e2e/ux-mcp-surface.mjs` against a real gateway and the controlled
fixtures: the dialog lists the host's own `mcp.json`; a test of a server that cannot start shows the mask where the
server's own words carried the secret, and no secret appears anywhere in the page; a test that answers reports the
tool count; a pasted config is added and appears in the host's file without a reload; signing in against the fake
authorization server stores the token it issued in the host's `mcp-auth.json` and never on the page, and signing out
removes it; a removal reaches the host's file and offers no Undo; a project's server reads untrusted until the host's
own `trust.json` records a decision, a project write is refused with the host's `project-untrusted` before that, and
the project server connects after it; and a stopped host service is the named limit with no list and no controls. Every
wait is an observable UI, request or file change — no sleeps.

**Context:** [Spec](../spec.md) decisions 36–42; stories 80–90. The host half is ticket 16; this ticket adds the
browser surface, one host operation (`patch`) and the listing fields the panel needs.

## Review notes

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 24 | A test's last answer lives in the Web process's memory, keyed by the entry the host described. The host keeps no test history, as upstream keeps none, so a Web process restart loses every Connection row and the rows read `on` until each server is tested again. | The panel is read-mostly and a restart is an operator event; the state it loses is a report of a past connection, not configuration, and a session that connects the server reports its own state again. | `record` | A deployment restarts the Web process routinely and a user reports the Connection rows as missing or wrong. |
| 25 | A group switch is one patch per server, so a group of n servers is n host calls in one request, and a failure partway through leaves the earlier ones applied. Each answer is reported per server and the listing after the last one is what the panel shows. | The bulk switch is offered for the servers a person configured by hand; upstream's own panel writes the file once, but the host service's operation is one entry per call by design (decision 42's one-operation-per-request shape), and a partly applied switch is visible rather than silent. | `record` | A deployment shows groups large enough for the request to time out, or a partial switch is reported as complete. |
| 26 | The Web process's own aggregate is what the panel reads, so the panel's `cwd` (a routing address) and the host's path differ, and a test's answer is keyed by the entry as this process described it rather than by a hash of the file's JSON. Two Web origins on one backend therefore each keep their own test answers. | That is the intended split: each Web origin serves its own host's MCP configuration, and the entry's description holds no value. | `record` | A second Web origin's test answer is shown for another origin's entry. |
