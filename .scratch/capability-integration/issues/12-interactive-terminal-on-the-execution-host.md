# 12: Interactive terminal on the execution host

**What to build:** The execution host gains a long-lived shell session: open one in a registered root, stream its
output, send input, apply a resize, close it and have the process end on the host, and report its exit. The current
per-call execution surface does not model a session, so this is the substance of the block.

**Blocked by:** None (can start immediately)

**Status:** resolved — merged into `integration/ux-follow-up`.

**Demo path:** Against the gateway: open a terminal in a registered root, run a command and read its output, resize and
see a full-screen program answer the new size, close the session and confirm the process is gone.

**Stories:** 67, 68, 69, 70, 71, 75, 78, 79

**Seam:** the execution host's public contracts, asserted on the local gateway and on the isolated localhost SSH
gateway, with the SSH skip reported when the fixture is unavailable. Every wait is an observable event or state
change — no fixed sleeps.

- [x] The host surface opens a shell session in the bound root and streams output as it is produced (a long-running
      command shows output before it finishes).
- [x] Input reaches the shell: a command sent as input produces its output in the stream.
- [x] A resize is applied: a full-screen program's layout answers the new size.
- [x] Closing the session ends the process on the host (assert the process is gone, not merely disconnected).
- [x] An exit is reported as an exit with its code.
- [x] A host that cannot serve a terminal answers a named limit.
- [x] A terminal session writes no entry to the conversation's transcript (assert the conversation's entries are
      unchanged).
- [x] Every case above is asserted on a local gateway and on the isolated localhost SSH gateway.

**Context:** [Spec](../spec.md) decisions 30, 31, 34, 35; stories 67–79. The browser half is ticket 13.

## What was built

The gateway gained one new host capability and one new surface. `packages/gateway/src/terminal.ts` holds a framed
protocol over the session's two pipes (1-byte kind, 4-byte big-endian length, payload), a Python 3 helper that runs on
the execution host and owns the pseudoterminal, and `TerminalSessions`, which resolves a workspace id to its root and
profile, starts a session there, and answers input, resize, close and exit. The helper needs nothing but the standard
library, the same requirement the filesystem and workspace helpers already have, so the SSH half is the same program
on the far side of the runner the other surfaces use.

`GatewayRpcServer` serves it on `/v1/terminal`: `POST` opens a session in a registered root, `GET
/v1/terminal/<id>/events` streams output as server-sent events and ends with exactly one exit frame, `POST
/v1/terminal/<id>/input` and `.../resize` reach the shell, and `DELETE /v1/terminal/<id>` closes it and answers the
exit the host reported. A gateway composed without the capability, or whose host has no Python 3, answers `501
not_supported` with the limit named; an unknown session answers `unknown_terminal`; a cwd outside the workspace
answers `path_denied`. Both entrypoints (`packages/gateway/src/main.ts`, `packages/client/src/gateway.ts`) compose
the local or the SSH launcher for their mode, and the SSH runner gained `open()` — the same connection settings as
`execute()`, with the session's pipes left open. No `node-pty` dependency was added: the helper is Python, so the
gateway package keeps its dependency set.

Closing ends the process on the host, not merely the connection: the helper signals the session's process group
(`SIGHUP`, then `SIGKILL` five seconds later), and it does the same when its own standard input closes,
so a shell cannot outlive the gateway that started it. A shell's own `exit` is a reported exit with its code and
signal; a transport that disappears without an exit frame reports a null exit code rather than inventing one.

## Verification

Revision `76e75f7` plus this change, in a worktree of its own; the integration branch was merged in and the gates
re-run at `6fd32f5` with nothing to merge back.

- `node --test packages/gateway/test/terminal.test.ts` — 6 pass, 0 fail, 0 skipped. The SSH half ran against the
  isolated localhost `sshd` fixture, not a mock runner: the same two shared cases run against a local gateway and
  against a gateway whose shell really executes over SSH.
- `node --test apps/server/test/terminal-transcript.test.ts` — 2 pass, 0 fail, 0 skipped (local and SSH). A real
  backend with a real store, a real conversation with one settled turn, a terminal driven open → input → resize →
  close, and the conversation's entries and its catalogue row read back unchanged.
- `pnpm verify --profile=fast` — workspace-typecheck and workspace-tests pass at both revisions; the server suite
  runs 169 tests, all passing, including the two new ones. Logs:
  `.dev/verify/2026-10-11T15-30-13-839-verify-fast` (pre-merge), `.dev/verify/2026-10-11T15-34-12-772-verify-fast`
  (post-merge) and `.dev/verify/2026-10-11T15-35-38-757-verify-fast` (final, at `1d7e7ea`).
- `node scripts/check-docs.mjs` (130 files, 0 broken links, 0 uncovered guides) and
  `node scripts/check-entrypoints.mjs` (50 present, 2 known-missing, 0 newly missing) pass.

No case sleeps: every wait is a frame the host produced (output, exit), a request's answer, or a FIFO the test itself
opens.

## Fixed by the final code review

One finding from the review of the merged effort is fixed at this ticket's own host boundary.

| # | Finding | Trigger and impact | Fix |
| --- | --- | --- | --- |
| 1 | `TerminalSessions.open()` canonicalized the workspace root and the requested cwd with the gateway machine's own `node:fs/promises` `realpath` before the launcher ran, for every workspace. An SSH workspace's root is a directory of the *remote* host, so `realpath` answered `ENOENT` and no terminal could be opened in a remote Project's folder at all. The existing SSH fixture shares the test machine's filesystem, which is why it did not show this. | Resolution and confinement are the execution host's, as they already are for execution, files and workspaces. The gateway does only path arithmetic on the registered root; the helper on the host canonicalizes both paths, confines the cwd to the root, refuses a directory that does not exist there, and reports the accepted root and cwd in its ready frame, which the session records and answers. The SSH transport no longer changes directory before the helper starts, so a directory the host does not have is the helper's own named refusal rather than a shell exit the gateway cannot classify. Regression: `packages/gateway/test/terminal.test.ts` against an **isolated** SSH fixture (`sshd-fixture.ts` `isolated`, a private mount namespace) whose root exists only on that host. |

## Review notes

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | The exit stream reports `signal` as the shell's terminating signal and, for a session closed through `DELETE`, the same signal the helper's own `SIGHUP` produced (`exitCode` is then `128 + signal`). A caller cannot tell "the user closed the tab" from "the shell was killed by the same signal on its own" by these two numbers alone. | Ticket 13 is the first caller that could care, and it has the close it issued in hand when it reads the answer, so the two are distinguishable there. No user-visible effect: the browser shows an exit code either way. | `record` | Ticket 13 needs the distinction for a user-visible message, or a user reports a confusing exit code after closing a tab. |
| 2 | A session's output backlog lives in the event stream's queue only while a caller is attached; a session nobody is attached to keeps producing output that is dropped, and there is no replay buffer at the host. | Deliberate here: bounded replay across a reconnect is ticket 13's contract, which states the bound. Ticket 12's own criteria need no replay. | `record` | Ticket 13 states a replay bound and finds the host cannot serve it. |
| 3 | The helper resolves the shell from the host account's login shell (`SHELL`, then `pw_shell`, then `/bin/sh`) and starts it with `-l`. On a host whose login shell does not accept `-l` (or accepts it with different meaning), the session may start a non-interactive shell. | Not observed on any host this repository runs on: `zsh` and `bash` both accept `-l`, and the SSH fixture's host is the same machine. The upstream terminal surface starts the same way. | `record` | A supported host is found whose login shell does not accept `-l`. |

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
