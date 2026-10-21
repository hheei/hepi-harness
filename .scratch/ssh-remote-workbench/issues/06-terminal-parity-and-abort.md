# 06 - SSH terminal parity and abort

Status: resolved — reviewed and integrated at `0994ffe`; delivered (2026-10-19) on `impl/ssh-workbench-acceptance-next` `5527f68` — two launcher rows had no owner and are
closed; see the record at the end of this file.
Blocked by: (none)

Verify the existing SSH terminal against the failures the spec names, and add a test only where a named failure has no
owner. The capability exists end to end (`sshTerminalLauncher`, `SshRunner.open`, the Python terminal helper, the
gateway's terminal SSE, the Backend relay, the browser panel); this ticket is parity and reliability acceptance, never a
protocol replacement.

Named failures and where each is already asserted — measured on `impl/ssh-workbench-03` `bc6c71a`, where these four
gateway files run 41 tests / 0 fail:

| Failure the spec names | Owning seam today |
| --- | --- |
| reconnect cursor, bounded replay | `packages/gateway/test/terminal-stream-budget.test.ts`, `terminal-heartbeat.test.ts` |
| resize | `terminal.test.ts`, `host-terminal.test.ts`, `ingress-terminal.test.ts`, `terminal-stream-budget.test.ts` |
| caller close / abort | the same files, plus `apps/web/e2e/ux-terminal-close.mjs` |
| unreachable host | `terminal.test.ts` (host seam) and `host-terminal.test.ts` |
| missing PTY / missing helper | `host-terminal.test.ts`, `test/ssh-fake.ts` helper faults |
| relay and transcript behaviour | `apps/server/test/terminal-relay.test.ts`, `terminal-transcript.test.ts`, `terminal-browser.test.ts` |

Work: run them at the current revision, then close whatever row the run shows uncovered. `docs/verification.md` records
the revision, the exact commands and the counts. No live host, no deployment.

## Delivered (2026-10-19, `impl/ssh-workbench-acceptance-next`)

Ran the six rows at `integration/client-app` `3e69c62` and then at the merged tip `5527f68` (which contains
`integration/client-app` `68ce3ca`). Five rows had owners and stayed green. **Two did not**: the file this ticket lists
for "missing PTY / missing helper" and for the caller-facing half of "unreachable host" asserted neither — `terminal.test.ts`
lists "a host with no `python3`" and "an SSH transport that cannot hold a session open" in a comment as cases it dropped
because they belong to the **launcher**, and no launcher test existed. Closed with
`packages/gateway/test/terminal-launcher.test.ts` (10 tests), on the repository's own fake transport
(`test/ssh-transport.ts`, a real child process that writes what a host writes and ends with the code a host ends with):
SSH `255` -> `unreachable`, SSH `127` with the host's "python3: command not found" -> `not_supported`, a python3 without
`pty` -> `not_supported`, an unnameable host end -> `operation_failed` carrying the host's own last line, a runner with no
session path -> `not_supported` before any host is contacted, a workspace no profile owns -> `unknown_workspace` with the
transport never asked, a machine with no `python3` on PATH through a real `spawn` -> `not_supported`, and the same answers
read back off `POST /v1/terminal` on both gateway kinds. Each refused open asserts the store keeps nothing behind it
(`describe` -> `unknown_terminal`) — the "never an empty success" half.

**One real parity defect, fixed:** over SSH a host with no `python3` arrived as exit 127 + host stderr, which the shared
`missingHelper` did not read, so the SSH host answered `operation_failed` where the local host and the SSH filesystem both
answered `not_supported` naming python3. Now one classification, both hosts, same words
(`packages/gateway/src/terminal.ts`).

**The two guides that were wrong were corrected, not the code.** They said a host with no Python 3 answers `501`; it does
not — a refused open keeps the route's single refusal status `409` with the reason in the body, and `501` is the answer of
a gateway composed *without* the capability (`terminal.test.ts`, `host-terminal.test.ts`). The `501` legitimately
reappears one hop later: `lifecycleStatus` (`apps/server/src/terminal-relay.ts`) maps a `not_supported` answer to `501`.
See [the record](../../../docs/verification.md) — counts, exit codes and logs are in
`.dev/verify/ssh-workbench-06-08/`. No live host, no deployment, no bypass or confinement probe.
