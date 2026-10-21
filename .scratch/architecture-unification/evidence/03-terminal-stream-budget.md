# 03: Slow terminal consumers are disconnected at a finite budget and recover

**What to build:** a terminal receiver that stops reading cannot grow the gateway's memory without bound, its shell and
every other receiver keep running, and a reconnect gets truthful replay/reset.

**Blocked by:** None.

**Status:** complete — implemented and verified at the seams below, in the working tree.

Spec: [unified design](../spec.md). Navigation correction applied: there is no `docs/terminal.md`; the owning guide is
[docs/workbench.md](../../../docs/workbench.md) with the Gateway/client paragraph in
[docs/local-integration.md](../../../docs/local-integration.md).

## What changed

- **One private writer for every terminal byte.** Both event streams and the keepalive write through
  `GatewayRpcServer.#writeTerminalBytes` (`packages/gateway/src/index.ts`), which encodes the frame once, compares
  `response.writableLength` against the budget, and either writes or ends the connection. `#writeTerminalFrame` owns
  the frame's shape; `#writeTerminalComment` is the keepalive on the same path.
- **The two queue/wake/consumer loops are gone.** `#terminalEvents` and `#terminalFanIn` take their attachments
  before writing a byte and write synchronously from the session's own synchronous listener; the replay is written in
  the same turn, before any live event can arrive. No array of pending events and no `wake` promise exists on either
  route, so nothing is moved into a second queue.
- **One cleanup owner.** `#holdTerminalStream` arms the keepalive, waits for the request or the response to close, and
  in one `finally` clears the timer, releases every attachment and ends the response. A session's own exit on the
  per-session route writes its exit frame and ends that response.
- **Exit semantics kept.** A single session's exit ends its own response. A fan-in tab's exit writes that tab's exit
  frame and leaves the shared stream open for the tabs still running, and only the caller going away ends it — ending it
  on the last exit would make a page whose tabs have all exited reconnect on every retry.
- **The budget and why that number.** `TERMINAL_STREAM_BUDGET_BYTES = 4 MiB` (`packages/gateway/src/terminal.ts`),
  overridable per `TerminalSessions` for tests. It is one constant rather than a per-tab allowance, so a caller naming
  ten tabs does not get ten times the memory.

## Why the comparison is "already over", not "would go over"

This is the part that decides whether the bound itself causes reconnect loops. The writer ends the connection only when
`response.writableLength` is **already** greater than the budget; it never refuses a frame for the frame's own size.
That makes every attempt deliver at least one whole frame, so the caller's cursor always advances and a reconnect
converges. A "would go over" rule would refuse the very first frame of an attach whose replay exceeds the budget, the
caller would hold no cursor, and its reconnect would be answered with the same replay and the same refusal — a loop
caused by the bound. The bounded quantity is the *pending* bytes: the budget plus at most the one frame being written.

This is asserted directly: `a replay larger than the budget still advances the caller instead of looping` runs an
8 KiB budget against a 131,072-character retained tail and shows the first attach delivering a whole ~123,000-character
replay frame with its cursor, and the reconnect from that cursor being a continuation with no reset.

The other half of the policy is that back-pressure is not a disconnect: `write()` returning false only means the socket
passed its high-water mark. `a reading-but-slow consumer receives a large bounded replay whole: write back-pressure
alone never disconnects` drives a deliberately slow reader against a 512 KiB budget and shows it receiving the whole
128,115-character retained tail in one frame with the connection still open. A consumer is ended for being **already**
over budget, never for making the socket buffer.

## The number, from measurement

Probe: `.dev/architecture-unification/probe-terminal-replay-size.ts` (real `GatewayRpcServer`, real HTTP, real
sockets, real `ServerResponse`; the execution host is a fixture double that only calls the session's `onOutput`, so
this is the gateway's own wire and not a real PTY). Command and raw output are in the ticket's evidence section below.

These are what the fixture was driven with and what those frames measured on the wire — not a proof of the maximum a
legal frame can reach:

| Replay driven through the fixture | payload characters | measured wire bytes |
| --- | --- | --- |
| 3 tabs, realistic ANSI/CR/CJK/emoji output | 3 × 131,072 | 394,614 |
| 3 tabs, every character a control character | 3 × 131,072 | 1,327,572 |
| 1 tab, every character a control character | 131,072 | 442,524 |
| largest live frame (the helper reads at most 64 KiB per read) | 65,536 | 393,370 |

The fixture's control-character case trimmed 73,728 payload characters coarse-grained, so even those two rows are not
the worst case for their payload size. **The bound that matters is derived, not the fixture's maximum.** JSON escapes
every control character at six bytes, so a full 128 KiB retained tail of control characters — NUL, ESC — reaches
**786,432 bytes** plus frame metadata, and the aggregate a page attaches, three such tabs, reaches **~2.36 MiB**. A
4 MiB budget carries that conservative aggregate with margin while staying one stated limit, and it is the number the
source comment in `packages/gateway/src/terminal.ts` states. A budget below the conservative aggregate would end a
healthy consumer's legal replay.

## Acceptance criteria

- [x] **Shared private write point covers both event streams and the keepalive; encoded once and measured against real
      UTF-8 frame bytes.** `#writeTerminalBytes` is the only writer; `#writeTerminalFrame` and
      `#writeTerminalComment` both call it. Asserted by the whole terminal suite still passing through the same routes,
      and by the budget case ending a connection.
- [x] **Synchronous subscribers write directly; both queue/wake/consumer loops removed; no accumulation moved to
      another async queue.** Neither route has a pending array or a `wake`; the only per-route state is the attachment
      list and the replay captured in the same synchronous turn.
- [x] **Budget, single frame and aggregate replay have a finite strategy with raw experimental basis; legal replay does
      not loop; capacity does not scale with tab count.** The probe table above is the basis; the "already over" rule
      and its dedicated case are the loop exclusion; one constant, not per tab.
- [x] **Closing cleans up timer and subscriptions uniformly; single-session exit and fan-in partial exit behaviour
      preserved; a disconnect does not kill the shell.** `#holdTerminalStream`'s single `finally`;
      `one terminal stream carries every mounted tab...` asserts a tab's exit ends only its own frames; the budget case
      asserts the session is still live after its consumer was ended.
- [x] **A slow socket is ended at the budget; repeated disconnect/reconnect leaves no subscription leak; input/resize and
      an independent receiver still work.** `a slow consumer is ended at the stream budget...` (stalled socket ended at
      the budget after 6 MiB while a reading consumer received all of it and the session stayed live);
      `repeated attach and detach leaves no attachment behind...` (five attach/detach cycles, then the reconnect lease
      still closes and forgets the session — a leaked attachment would hold it forever).
- [x] **Last-Event-ID / per-session cursors, replay-before-live, reset and the 120 s lease preserved; the permanently
      slow reader's non-lossless limit recorded.** The existing `terminal.test.ts` reconnect and cursor cases pass
      unchanged; the limit is stated in `docs/workbench.md`.
- [x] **A normal, bounded, slow consumer is not disconnected by write back-pressure.** The dedicated case above; the
      policy compares "already over budget" rather than the frame's own size, so a frame is always the unit of progress.
- [x] **Real HTTP writer used for normal, multi-tab, Unicode/control encoding and slow-reader cases; fixture host and
      real PTY/SSH evidence kept distinct.** Every case in `terminal-stream-budget.test.ts` is a real gateway, real HTTP
      server and real socket; the shell is a real `pty.fork` helper on this machine (`localTerminalLauncher`), not a
      double — the fixture-host distinction applies to the *probe* above, which is labelled as such. The existing
      `terminal.test.ts` SSH cases run the same contract over a real localhost sshd.
- [x] **Terminal usage guide and capability limits updated; numbers, source fingerprint and log bound to this run.**
      `docs/workbench.md` and `docs/local-integration.md` updated; see Evidence below.

## Verification

Commands run in this working tree (`HEAD` `1758c1f`, dirty — this is not a clean-SHA claim):

```
pnpm --filter @hepi/gateway typecheck                                  # exit 0
node --test packages/gateway/test/terminal-stream-budget.test.ts       # 4 pass / 0 fail
node --test packages/gateway/test/terminal.test.ts \
  packages/gateway/test/terminal-heartbeat.test.ts \
  packages/gateway/test/execution.test.ts                              # 31 pass / 0 fail
pnpm --filter @hepi/gateway test                                       # 183 pass / 0 fail (3 concurrent runs)
node --import ./.scratch/development-audit/perf-probes/lib/register.mjs \
  .dev/architecture-unification/probe-terminal-replay-size.ts          # exit 0, table above
```

Raw logs for every run are under `.dev/architecture-unification/logs/`: `typecheck.log`,
`terminal-stream-budget.log`, `capture.log`, `terminal-and-execution.log`, `aggregate-replay-repeat.log` (eight
consecutive runs of the budget suite), `par-1..6.log` (six concurrent runs under four CPU-load processes) and
`gateway-broad.log`.

```
pnpm --filter @hepi/gateway test    # 184 pass / 0 fail / 0 skipped, exit 0 — no aggregate-replay regression
```

The aggregate-replay case this ticket owns was the one ticket 02's broad run caught failing. It is now green in eight
consecutive standalone runs and in six concurrent runs under CPU load, and in the full 184-case gateway run above.
Earlier, under three concurrent full gateway runs, one unrelated failure appeared in `sshd-fixture.test.ts` — a file
this ticket does not touch, which passes 6/6 standalone. No failure appeared in any terminal or capture case after the
test fix below.

### A flake this ticket's own case had, and its cause

The aggregate-replay case originally built `new Map(outputs.map(event => [event.id, event]))`, which keeps the **last**
frame per tab. A live prompt frame arriving after the replay overwrote the replay entry, so `reset` read as
`undefined`. It was intermittent because it depended on whether the shell's next prompt frame was coalesced into the
same TCP read. The case now asserts the **first** output frame per tab, which is where the replay is by contract. This
was a test bug, not a product one, and it is recorded here rather than silently fixed.

## Limits

- The probe's execution host is a fixture double: it proves the gateway's SSE write path, not a real PTY's throughput,
  a real shell's buffering or a real SSH terminal's. The behavioural cases in `terminal-stream-budget.test.ts` do use a
  real local PTY; the SSH path is covered by the existing `terminal.test.ts` sshd cases.
- No browser is driven here; `apps/web/e2e/ux-terminal-session.mjs` and `ux-terminal-budget.mjs` cover the page and
  are unchanged by this ticket.
- A permanently slow consumer is not promised lossless history: it is answered from the session's retained tail with
  `reset`. That is the recorded trade-off.
- The budget is a memory bound on one connection, not a throughput guarantee; a consumer slower than its socket but
  within the budget is served normally.
