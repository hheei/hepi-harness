# 04: Verbose execution capture accumulates linearly

**What to build:** a command whose output is very fragmented is still forwarded live in full, a repeated call ID gets the
same bounded result from the ledger, and capture does not rescan the retained prefix per chunk.

**Blocked by:** None.

**Status:** complete — implemented and verified at the seams below, in the working tree.

Spec: [unified design](../spec.md).

## What changed

- **One capture object per stream, in `packages/gateway/src/execution.ts`.** `OutputCapture` owns its chunks, its
  retained UTF-8 byte count and its `clipped` state. `append` measures only the text it is handed; `text()` joins once
  and caches. The previous `Gateway.#append` — which recomputed `Buffer.byteLength(current)` on every chunk and
  re-concatenated the whole retained string — is deleted.
- **The gateway uses two of them.** `Gateway.#execute` builds `{ stdout: new OutputCapture(captureBytes), stderr: new
  OutputCapture(captureBytes) }`, appends through the sink, and joins once when the call ends. The `truncated` fact now
  comes from either capture's `clipped`.
- **Cutting at a complete character is one shared rule.** `completeCharacters` walks back over UTF-8 continuation bytes
  and is used by both `OutputCapture.append` and the retained `capOutput` (which the ledgers still use for their own
  per-entry `maxBytes`), so the two bounds cannot disagree about what a partial character is.
- **Contracts unchanged.** Live delivery still forwards every chunk to the caller untouched; `spill`,
  `spillUnsupported`, `truncated`, failure and `outcome-unknown` shapes are unchanged; journal ownership is unchanged.
  No generic buffer or budget framework was introduced — this is one class with one job.

## Why it is linear

The old shape was quadratic in the retained size: each chunk paid `Buffer.byteLength` over everything kept so far plus a
string concatenation of everything kept so far. The new shape pays one `Buffer.from` over the chunk it was given and one
`push`. The relative comparison in the probe below is the direct evidence.

## Acceptance criteria

- [x] **stdout and stderr each own chunks, UTF-8 retained bytes and clipped; only the new chunk is measured; joined
      once.** `OutputCapture`; asserted by `the capture itself appends in the volume it is given and joins once` and by
      the two-stream case.
- [x] **A budget edge does not break a multibyte character; each stream has its own limit; zero/empty output and the
      default capture behaviour are unchanged.** `each stream keeps its own budget, and a cut lands on a complete
      character` (a 5-byte budget keeps `abcd` and drops a 3-byte character whole, with no U+FFFD) and
      `stdout and stderr are captured separately...`.
- [x] **live sink, spill, spillUnsupported, truncated, failure and outcome-unknown contracts preserved.**
      `execution.test.ts` passes unchanged, including the spill, `spillUnsupported` and outcome-unknown cases.
- [x] **Real execute and repeat-call lookup show the same result with no second execution; not merely an append
      probe.** `a repeated call ID is answered from the ledger with the same bounded capture and no second run` drives
      real commands through `LocalGateway.execute` and reads the command's own run counter file.
- [x] **The same output volume is compared in small and large chunks, with a measured range recorded, and no claim that
      every real command is frozen.** `the same volume in many small chunks and in one large write is captured
      identically` asserts the *content* is identical; the wall-time range is in the probe log below and is explicitly
      not asserted, because the shell's own cost dominates and is not stable under load.
- [x] **The old per-chunk rescan is deleted; journal ownership kept; no generic buffer/budget framework.** See the
      deleted `#append`; `MemoryLedger` and `GatewayExecutionJournal` are untouched apart from sharing
      `completeCharacters`.

## Verification

Commands run in this working tree (`HEAD` `1758c1f`, dirty):

```
pnpm --filter @hepi/gateway typecheck                                  # exit 0
node --test packages/gateway/test/capture.test.ts                      # 5 pass / 0 fail
pnpm --filter @hepi/gateway test                                       # 184 pass / 0 fail / 0 skipped, exit 0
node --import ./.scratch/development-audit/perf-probes/lib/register.mjs \
  .dev/architecture-unification/probe-capture-scaling.ts \
  > .dev/architecture-unification/probe-capture-scaling.log            # exit 0
```

### Measured range

Raw logs: `.dev/architecture-unification/logs/capture.log`, `terminal-and-execution.log`,
`gateway-broad.log`, and `probe-capture-scaling.log` beside the probe.

Real `LocalGateway.execute` and a real `/bin/bash` on this machine, 4 MiB capture budget. The shell writes the same
volume in different chunk sizes; the elapsed time is one whole call, so it includes the shell and is **not** a pure
capture measurement:

| volume | chunk | chunks | retained | elapsed |
| --- | --- | --- | --- | --- |
| 1 MiB | 256 B | 4,096 | 1,048,576 B | 1,285.1 ms |
| 1 MiB | 1 KiB | 1,024 | 1,048,576 B | 310.6 ms |
| 1 MiB | 4 KiB | 256 | 1,048,576 B | 81.4 ms |
| 1 MiB | 16 KiB | 64 | 1,048,576 B | 23.2 ms |
| 4 MiB | 256 B | 16,384 | 4,194,304 B | 6,489.5 ms |
| 4 MiB | 1 KiB | 4,096 | 4,194,304 B | 1,300.3 ms |
| 4 MiB | 4 KiB | 1,024 | 4,194,304 B | 366.5 ms |
| 4 MiB | 16 KiB | 256 | 4,194,304 B | 100.5 ms |
| 4 MiB | 1 KiB | 4,096 | **8 B** (clipped) | 1,557.6 ms |

The clipped row is the important control: 4 MiB of output under an 8-byte budget costs about what 4 MiB under a 4 MiB
budget costs (1,557.6 ms vs 1,300.3 ms), because once the budget is reached each further chunk is one comparison. The
old shape paid more the *longer* it had been retaining.

The append-shape comparison on the same volume in one process, from the same log
(`appendReplicaNote` in the log says "relative only"):

| volume | chunk | old per-chunk rescan | new chunk list |
| --- | --- | --- | --- |
| 1 MiB | 1 KiB | 117.5 ms | 0.5 ms |
| 4 MiB | 1 KiB | 1,371.3 ms | 2.0 ms |
| 4 MiB | 256 B | 5,381.9 ms | 2.9 ms |

This replica is a *relative* comparison and is not live gateway latency; it exists only to show the rescan is gone, and
it is not used to claim anything about real commands.

## Limits

- The wall-time rows include the shell and the machine's load, so they are a range, not a latency promise. The
  algorithmic claim rests on the replica column and on the deleted code.
- One machine, one shell, one Node version; no browser and no real model was involved.
- The ledger's own per-entry `maxBytes` and `capOutput` are unchanged: this ticket is about how the gateway
  accumulates a call's output, not about journal retention policy.
