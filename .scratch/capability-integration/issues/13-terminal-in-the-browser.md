# 13: Terminal in the browser, with reconnect and the existing close behaviour

**What to build:** The existing terminal panel is wired to the host session from ticket 12: it opens in the
conversation's workspace folder, keystrokes and resizes reach the shell, output streams, a dropped connection
reconnects and replays what was missed within an explicit bound, and the earlier close behaviour is preserved.

**Blocked by:** 12: Interactive terminal on the execution host

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** In the browser, open a terminal from a conversation, run a command, resize, drop the connection,
reconnect and see the output produced while disconnected, then close the tab.

**Stories:** 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79

**Seam:** browser → existing Web adapter → durable backend → execution host, plus the host contracts for the
reconnect and replay cases. Every wait is an observable UI, request or stored-state change — no fixed sleeps.

- [x] The terminal opens in the conversation's workspace folder and keystrokes reach the shell (a command's output
      proves it).
- [x] A resize is applied and the panel lays out at the new size.
- [x] A dropped connection reconnects and shows the output produced while disconnected, bounded by an explicit replay
      bound stated in this ticket when it is implemented.
- [x] Input is never replayed after an ambiguous delivery failure: a command is executed exactly once across the
      failure and the retry.
- [x] A failed connection closes its tab rather than trapping it, and the existing close behaviour stays green.
- [x] Closing the tab ends the host process.
- [x] The reconnect window and the replayed-output bound are the only new numbers introduced, and each is asserted as
      the stated value.

**Context:** [Spec](../spec.md) decisions 30–34; stories 67–79. The reconnect window, the replay bound and exit
reporting were confirmed as proposed defaults with the testing seams; state them explicitly here.

## The two numbers

| Number | Value | What it bounds |
| --- | --- | --- |
| `TERMINAL_RECONNECT_MS` (`packages/gateway/src/terminal.ts`) | **120,000 ms** | How long a session with no caller attached is kept before it is closed. An attached caller holds the session outright; an ended session is forgotten when its window runs out. |
| `TERMINAL_REPLAY_CHARS` (`packages/gateway/src/terminal.ts`) | **128 KiB** (131,072 characters) | How much of a session's own output is retained for a reconnect. A cursor behind what is kept gets the retained tail with `reset: true`. |

Both are asserted as those values by `packages/gateway/test/terminal.test.ts` ("the reconnect window and the
replayed-output bound are the stated numbers…"), which also drives the window with a short one to prove the close
happens without any request. They are the only numbers this ticket introduces: the backend relay reuses the server's
own bounded body reader and the same 20-second host-request timeout the workbench proxy already applies, and the
event stream sets no timeout of its own because a session's stream lasts as long as the session does.

## What was built

The host session ticket 12 built is reached from the browser, and the three layers between them gained only what that
takes.

**`packages/gateway/src/terminal.ts`** — `TerminalSessions` keeps a bounded backlog of each session's output
(`TERMINAL_REPLAY_CHARS`, trimmed from the oldest chunk), counts the session's offset in the characters a caller sees
so a cursor read from one frame continues exactly from it, and hands an attaching caller what it missed. `subscribe`
takes the caller's cursor and answers `reset` when that cursor is behind the retained tail or ahead of the session, so
a stream is never silently inconsistent. A session may be opened under a caller-supplied `id`, which is how a reloaded
browser tab reaches the shell it started instead of a second one; an id already running in another workspace is
refused, and `describe(id)` reports what a session is — including that it has ended — without attaching to it. A
detached session runs out its reconnect window and is then closed; an ended one is forgotten when its window runs out.

**`packages/gateway/src/index.ts`** — `GET /v1/terminal/:id` answers that description, and the event stream takes the
caller's cursor from `Last-Event-ID` or `after`, replays first, then streams, and writes each output frame's offset as
the SSE `id` field, which is what a browser's own `EventSource` reconnect resumes from.

**`apps/server/src/terminal-relay.ts`** (new) — the backend's `/api/terminal` route. Every request names the tab's
routing cwd; the relay resolves it to a workspace binding through the same `ensureBinding` every other host-facing
route uses, so a project folder, a retained binding and a configured workspace all reach the host that owns them. It
keeps no session state of its own, so a backend restart loses no shell. Input and resize travel as one command surface,
and the event stream is piped through with its cursors and its close.

**`apps/web/adapters/terminal.ts`** (new) — the browser's half, dispatched from `adapters/durable-api.ts` and reached
through the existing catch-all route. It refuses a cwd that names no workspace as the capability's own named limit and
otherwise forwards, so the browser never learns a gateway URL or token.

**`apps/web/components/TerminalPanel.tsx`, `terminal-tab-state.ts`, `lib/terminal-client.ts`, `AppShell.tsx`** — the
panel is wired to that surface. Every request carries the tab's routing cwd. A restored tab asks what its session is
and reports an ended one instead of silently launching a replacement shell. The tab keeps its own workspace's folder
as its name, taken from the host's answer and from the workspace it was opened in, so switching projects no longer
relabels it. `lib/terminal-manager.ts` and its test — a `node-pty` shell inside the Web process, never routed — are
deleted; `lib/terminal-client.ts` now owns the writer and the request helper.

## Evidence

`integration/ux-follow-up` at `155a002` was merged into this branch (`git merge --no-ff`, merge commit `375b801`) and
every check below was run on the merged tree, in a worktree of its own (`/tmp/hepi-ux13-final`). The merge touched no
file this ticket owns beyond the two documents both tickets edit (`apps/web/README.md`, `docs/migration-status.md`),
where both additions are kept.

| Check | Command | Result |
| --- | --- | --- |
| Workspace types | `pnpm -r typecheck` | Passed (exit 0), protocol/client/gateway/session/web/server. |
| Workspace tests | `pnpm -r test` | Passed (exit 0): client 9, protocol 46, session 3, gateway 107, server 187 — 0 fail. |
| Host contract | `node --test packages/gateway/test/terminal.test.ts` | 11 pass, 0 fail, 0 skipped. Both the local gateway and the isolated localhost SSH gateway run the open/input/resize/exit cases, the reconnect-and-replay case and the caller-named-session case; the two numbers and the window-driven close are asserted once. |
| Browser boundary | `node --test apps/server/test/terminal-browser.test.ts` | 1 pass, 0 fail. A real gateway with a real shell behind a real backend: open, type, resize (`stty size` answers `30 100`), resume from a cursor without a reset, a cursor behind the tail resetting, `unknown_workspace` and `not_supported`, close, and the process gone from the host. |
| Browser, real UI | `pnpm --filter @hepi/web build && node apps/web/e2e/ux-terminal-session.mjs` | **exit 0**, 32 `ok`, "UX-13 BROWSER CHECKS PASSED". Four processes as a deployment composes them: Chromium → Next.js → backend → gateway. |
| Existing close behaviour | `node apps/web/e2e/ux-terminal-close.mjs` | **exit 0**, 8/8 `PASS`. The driver now controls the connected route rather than relying on its 501. |
| Whole-web source run | `node scripts/test-web-unit.mjs` | **2110 tests, 2088 pass, 22 fail** — the `edef2c0` baseline of 23 less `lib/terminal-manager.test.mjs`, which this ticket deletes. No other failure name is added. |
| Docs and entrypoints | `node scripts/check-docs.mjs`, `node scripts/check-entrypoints.mjs` | 131 files, 0 broken links, 0 uncovered guides; 52 present, the same 2 known-missing, 0 newly missing. |

Every wait in the new tests is a frame the host produced, a request's answer, a process fact the test itself reads, or
an observable UI/stored-state change. There are no fixed sleeps and no response-driven polling loops.

The SSH half of the reconnect contract runs against the isolated localhost `sshd` fixture, so a local pass cannot hide
an SSH difference. It is skipped only when that fixture is genuinely unavailable, and the skip is reported.

### Carried finding 1 — closed by this ticket

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | A terminal tab's name came from `activeDisplayCwd` — the folder of the project that is *currently* selected — not of the tab, so switching projects relabelled an open terminal tab. | `fixed` here. `TerminalTab` now carries its own `displayCwd`: a new tab takes the workspace it was opened in, and the host's answer for the folder the shell really runs in replaces it. `AppShell`'s tab label reads that, never the selected project. The browser case "a tab keeps its own workspace's label across a project switch" asserts the label is unchanged after a real switch through the sidebar's picker, that it names the tab's own workspace, and that the same shell still answers afterwards. |

### Recorded by this ticket

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | The backend relay resolves a session's workspace from the routing cwd on every request rather than from a registry, so a request that names the wrong cwd for a real session id answers `unknown_terminal` instead of reaching the session. | The browser always sends the tab's own cwd — it is the tab's identity — so this is reachable only by a hand-written request. The alternative is a registry in the backend, which a restart would lose and which could disagree with the host. | `record` | A client other than this panel drives the route and gets a cwd wrong. |
| 2 | A reconnecting browser whose cursor has fallen behind the retained tail receives the tail with `reset: true` and its scrollback is replaced, so output older than the bound is not shown after a very long disconnect. | 128 KiB is a large amount of terminal output and the ticket requires the replay to be bounded; a user who was away long enough to exceed it sees the tail rather than everything. | `record` | A user reports losing output they needed after a long disconnect. |
| 3 | `TERMINAL_RECONNECT_MS` is asserted as the default in the session store, and a deployment that composes `TerminalSessions` with another value changes it without that assertion covering the composition. | No deployment in this repository sets another value; the option exists so the window can be driven in a test, and the stated default is what the ticket asks to be asserted. | `record` | A deployment composes the store with a different window and the ticket's number is expected to hold there. |

### Fixed by the follow-up review

Four findings from the review of the merged ticket were material failures on ordinary paths, and each is fixed at the
layer that owned it.

| # | Finding | Trigger and impact | Fix |
| --- | --- | --- | --- |
| 1 | The backend relay cancelled its host request only inside the read loop, so a caller that disconnected while the stream was idle — the state a terminal stream is in almost all the time — left the host request attached. | A closed tab (or a lost browser connection) left the session attached forever: the host request stayed open, so the session never detached and its 120-second reconnect window never ran out. The shell lived for as long as the gateway did. | `apps/server/src/terminal-relay.ts` now cancels with the caller's own connection, during setup as well as mid-stream, through one `AbortController` armed before the fetch and passed to it as its `signal`. Regression: `apps/server/test/terminal-relay.test.ts`, which asserts against the host's own record of when its request closed. |
| 2 | The Web terminal adapter dropped the browser's automatic reconnect cursor: it forwarded only `?after=`, and `backendResponse` replaced the caller's header set, so the standard `Last-Event-ID` an `EventSource` sends by itself never reached the backend. | Every automatic reconnect arrived as a first attach, so the host answered with the retained tail and `reset: true` and the panel cleared its screen, losing output the user had already read. | `apps/web/adapters/terminal.ts` forwards `Last-Event-ID`; `apps/web/adapters/durable-api.ts` adds its own headers to the caller's instead of replacing them. Regression: `apps/web/adapters/terminal.test.mjs`. |
| 3 | The gateway wrote each output frame's cursor as `" id: <offset>"`. The field name was therefore `" id"`, not `id`, which no event-stream client recognises. | A browser's `EventSource` never recorded a cursor, so even a correctly forwarded reconnect had nothing to send and was answered with the retained tail and a reset — the same screen-clearing loss as finding 2, from the frame text itself. | `packages/gateway/src/index.ts` writes `id: <offset>`. Regression: the gateway suite's "each output frame carries its offset as the event stream's own id field", which asserts the frame text a client parses. |

| 4 | The relay's cancellation was armed only once the events branch had resolved the workspace binding, so a caller that disconnected while that resolution was in flight — the binding re-registers the workspace with the host, an ordinary await — had no listener yet. The relay then opened the host stream anyway, with nobody left to read it. | Same impact as finding 1, from the interval before the fix in finding 1 could apply: the session stayed attached with no reconnect window able to run out, so the shell outlived its only caller. Reachable whenever a caller closes a tab or loses its connection during the host round-trip the binding performs. | `apps/server/src/terminal-relay.ts` watches the caller's connection before the binding is resolved, checks it again before opening the host stream, and stops writing to a connection that has gone on every early exit; the event stream is dispatched ahead of the binding the other routes share, so it resolves that binding itself. Regression: the deferred-binding case in `apps/server/test/terminal-relay.test.ts`. |

The browser case "an automatic reconnect continues from the cursor the browser received" drives the real path in
`apps/web/e2e/ux-terminal-session.mjs`: it ends the panel's stream from the test process, produces output while the
panel is away, and asserts the browser's own `EventSource` attached again with no offline/online transition and that
output read before the drop is still on screen afterwards. The disconnect/cancellation behaviour is covered
deterministically at the relay seam rather than through the gateway, because a gateway session recovers from a leaked
request only once its own reconnect window elapses; the relay's contract is the narrower and directly observable one.

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md): a `record` disposition does not
reopen this ticket or add a blocking edge.
