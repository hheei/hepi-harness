# 02: Terminal fan-in plus the conversation stream budget, end to end

**What to build:** the page stays usable with terminal tabs open and several conversations running — the composer is reachable, a switch is fast, and an ordinary read settles — while every mounted terminal tab keeps its shell.

**Blocked by:** None (the fan-in and the budget land in one slice so the count is true; if they are split, the fan-in blocks the budget).

**Status:** complete — merged into `integration/perf-follow-up` as `4cdadb8af50f29bffcbf9e065ca76acad23dfbed`
(fast-forward onto `98e0448`, no conflicts). Implemented on `impl/perf-02-terminal-fan-in`; reviewer102 approved the
product at `98ad18c` (three fixes plus the ticket 01 compatibility work, 0 material) and confirmed the merged pin
`4cdadb8` is source-equivalent on a quick identity check.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `98e0448` when this landed (`b9b28dd` was the branch point the
first draft was written against).

- [x] With N real mounted terminal tabs (including the panel closed and a non-active tab selected) plus held chat runs, the observed count of OPEN sources is within the pool budget and the composer is ready, a session switch completes and an in-page read settles inside their deadlines. — `apps/web/e2e/ux-terminal-budget.mjs` scenario A: 4 live (1 terminal + 3 conversation), composer ready, switch 63 ms, in-page read settled in 3 ms.
- [x] The 4-held control with no terminals passes today's behaviour unchanged, so a failure is attributable to the count and not to load. — scenario B: no terminal stream, 4 conversation sources, read settled in 3 ms.
- [x] Every mounted terminal tab's shell is the **same** session after the measurement, keystrokes still echo, and a reattach inside the retained tail does not reset the screen. — scenario A: the selected tab's own output arrives on the page, the hidden tab's shell answers through its own stream, and the reattach reports `reset: false`.
- [x] At most the derived number of background conversation watches hold a source; a nomination over budget opens nothing, keeps its projection, and acquires when a slot frees. — `apps/web/lib/completion-delivery.test.mjs`: three with no terminal mounted, two with one, and the deferred watch acquires a freed slot and reports its answer once.
- [x] The selected conversation's source is never given up, one notice per answer still holds, no duplicate audio, and an idle source is still released. — the same suite's existing cases plus the reserved-selected case; all 20 pass.
- [x] The counting is test instrumentation inside the page (the existing recorder pattern); no production diagnostics module is added. — the recorder is `RECORDER` inside `ux-terminal-budget.mjs`; the fan-in is the transport itself, not a diagnostic.
- [x] The measurement this ticket extends is reused, not re-derived: the recorded terminal-in-pool run (worktree `perf-lane-c`, revision `cb4494b0b4429bda1d9940257f661239171ce502`, prebuilt `BUILD_ID = vRBY79KO3pFNmp2MFtFCX`, node `v26.5.1`, HTTP/1.1, 7 checks / 0 failures, nothing rebuilt or deployed) is the baseline, and its limits are respected: restored tabs rather than clicked, sessions created out-of-band, one fixture, one browser (Chromium), one Next build, no HTTP/2 claim, and **no assertion about the 120 s detached-session lease** — that lease is tested separately with a short configured window if a criterion needs it.

## Review notes

An independent review (fixtures under `.dev/verify/ticket02-independent/`, untracked) found three defects in the first
cut of the fan-in. All three are fixed on this branch, and each fixture is preserved with a `.fixed.mjs` beside it that
asserts the corrected contract:

- **A cursor belongs to the widget that read it, not to a subscriber.** The first cut kept a tab's offset across a
  subscription handover, so a panel whose effect re-ran — a new terminal, which has read nothing — resumed mid-stream and
  was left blank instead of refilling. `FanInTab.after` now carries the widget's own read position; a widget that has
  read nothing names nothing and is answered with the retained tail (`terminal-fan-in.ts`, `TerminalPanel.tsx`).
- **A host stream that ends ends the page's stream.** The relay merged the hosts' streams and then waited for all of
  them, so one host going away left its tabs attached to a stream that would never carry them again and nothing told the
  page. The first upstream to finish now ends the response and the remaining hosts are released with it, so the page
  reopens the stream and re-attaches every tab, cursors included (`terminal-relay.ts`).
- **The page's terminal stream is owned by the tabs attached to it, not by a component mount.** `AppShell` closed the
  shared fan-in instance in an effect cleanup, which a double-invoked effect (development StrictMode) turns into a
  permanently closed instance and a page with no terminal stream at all. The cleanup is gone; the fan-in opens on the
  first tab and closes on the last (`AppShell.tsx`).

A fourth defect was found by a direct probe of the fan-in route: a stream that named no session this gateway runs had
no frame to write, and Node holds a response head until the first write, so the caller waited on a status that never
arrived instead of reading a stream it could decide about (an unknown-tab request never resolved; a request naming a real
session answered 200 in 2 ms). The head is now flushed with the headers (`packages/gateway/src/index.ts`).

The fan-in also carries ticket 01's keepalive on the merge: the cadence is awaited inside the loop that already owns
this response's frame boundaries rather than by a second timer, it is armed only while the stream actually holds
sessions, and the comment frame is written by the same writer as every other frame. Two cases in ticket 01's own
`packages/gateway/test/terminal-heartbeat.test.ts` cover the fan-in's side of it.

A fifth defect was found at the relay's own seam: a host frame split at the end of a stream was forwarded as half a
frame, which the next attach would repeat from a cursor that never moved. It is now discarded. Two cases cover P1 end to
end — one host's stream ending ends the page's stream and releases the host still running, and a trailing partial frame
never reaches the caller — and both were red against the integration tip's relay before the fix.

The READY verification pack for this ticket is `.dev/verify/ticket02-ready/` (untracked), with a `MANIFEST.md` naming
every command, its exit code, its raw log and the revision it ran at.

**Approval and merge identity (reviewer102).** Approved at `98ad18c` — the three fixes (cursor ownership on the
widget that read it, a host stream ending ends the page's stream, the shared fan-in owned by its tabs rather than a
component mount) plus the ticket 01 compatibility work, **0 material**. The merged pin `4cdadb8` is `98ad18c` with the
approved ticket 03 close `98e0448` merged in, and the union is clean: `git diff --name-only 87c7dcc 4cdadb8 -- apps
packages` is byte-identical to 03's approved 16-file list, with **zero** overlap against this ticket's own product files,
so 02's own source is unchanged from the approved revision. The fan-in writer carries ticket 01's keepalive on the merge
(cadence awaited inside the loop that already owns the response's frame boundaries, armed only while the stream holds
sessions, the comment written by the same writer as every other frame), and 01's own
`packages/gateway/test/terminal-heartbeat.test.ts` covers the fan-in's side.

**What is not claimed.** The gateway suite (167 tests) and the fast 97-test pack cover this ticket's own scope and the
01/SSH/heartbeat seams — they are **not** evidence for ticket 03, whose source is covered by its own approved 53-test
seam. No broad suite was re-run for this merge: it is a pure source union of two already-approved changes.

One test defect was found and fixed while measuring: `ux-terminal-session.mjs`'s `scrollToTop` compared two reads that
could land before its own `Shift+PageUp` had been applied, and returned the current viewport as "the oldest retained
line". It now waits for the view to move (or for the scrollback to be at its top). The failing assertion was never the
fan-in: a recording run showed the reconnect naming the cursor and receiving `reset: false` with the missed output.
