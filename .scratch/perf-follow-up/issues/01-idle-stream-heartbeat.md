# 01: Idle-stream keepalive at the origin writers

**What to build:** a quiet conversation stream and a quiet terminal stream stay connected instead of being killed by the transport's idle bound and silently re-baselining; the two Web proxies forward the comment frame untouched.

**Blocked by:** None (can start immediately).

**Status:** complete — implemented and verified at the seams below. Merged into `integration/perf-follow-up`.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Implemented on `impl/perf-01-heartbeat`, merged as `33335a8786752b4432853fbc86c724086fd2c777` (base `52b0131`;
tree `7efd5af472e89b7fdd9380e4b9b4e663adb15ae7`).

- [x] A held conversation stream with no application frames stays attached across a window longer than the transport's idle bound and receives heartbeat frames; the page observes **one** source with no reconnect over that window.
      Proven at the browser in `apps/web/e2e/stream-heartbeat-idle.mjs`: enabled run holds the stream across three stated
      idle windows behind a hop with a genuine idle deadline, and the page holds exactly one source per stream with no
      error and exactly one `connected` frame. Red at base `b9b28dd` with the same fixture: the bound cut both streams,
      one source became two, and the page re-baselined.
- [x] The same holds for the gateway's terminal stream, and a terminal reconnect still continues from `Last-Event-ID` or is told `reset: true` exactly as today.
      The fixture measures the terminal stream beside the conversation stream in the same runs. Reconnect and replay
      behaviour is unchanged and still asserted by `packages/gateway/test/terminal-heartbeat.test.ts` (the replay keeps
      its own cursor and stays the only cursor) and by the existing `apps/web/e2e/ux-terminal-session.mjs`.
- [x] The two proxies pass a comment frame through byte-for-byte and never inject one; a test drives a frame split across chunk boundaries and asserts the payload arrives intact.
      `apps/web/adapters/stream-heartbeat.test.mjs` (3 tests): the conversation proxy forwards a comment frame on the
      boundary it already found and writes none when the origin writes none; the terminal proxy passes it through
      byte-for-byte. Red at base (2 of 3 failed, including the chunk-split case).
- [x] The test runs against a shortened, controlled idle bound with the clock advanced by event barriers — no sleep and no real multi-minute wait; the bound under test is the idle one, not a total-duration timeout.
      The cadence is stated per deployment (`HEPI_HEARTBEAT_MS`, `HEPI_TERMINAL_HEARTBEAT_MS`) and the fixture's hop
      bounds a **silent body** — armed at response start and re-armed by every byte — so the bound under test is the idle
      one. Named barriers `conversation_first_frame` and `terminal_first_frame` gate the window on both origins having
      really published, and `idle_disconnect` is the hop's own record of the control run. The window is real wall time
      for the stated bound (3 × 1200 ms); no clock is faked, and the only waits are for frames the origins wrote or for
      the hop's deadline to fire.
- [x] No process-global dispatcher or global timeout change is introduced.
      `apps/web/lib/http-dispatcher.ts` is untouched and still has no production caller; the idle deadline exists only
      inside the fixture's hop.

**Negative control.** The same fixture with the cadence stated as `0` — no keepalive — crosses the same window behind
the same bound and is torn down: the hop destroys both quiet streams, zero comment frames reach the browser, and the
page's own source records the disconnect. `0` states no keepalive on both writers, so the control needs no second code
path. The cadence-zero control lives in the acceptance fixture; the three merged seam suites assert the enabled path
only.

## Evidence

- `apps/web/e2e/stream-heartbeat-idle.mjs` — run with `pnpm --filter @hepi/web build` first; report at
  `HEPI_SHB_OUT` (default `.scratch/perf-follow-up/evidence/stream-heartbeat-idle/report.json`).
- Green at `33335a8`: 22 checks, exit 0. Red at `b9b28dd` with the identical fixture file: 10 checks failed, exit 1.
- Seam suites: `apps/server/test/conversation-heartbeat.test.ts` (3), `packages/gateway/test/terminal-heartbeat.test.ts`
  (3), `apps/web/adapters/stream-heartbeat.test.mjs` (3) — each red at base, green at the merged revision.
- Affected regression at `33335a8`: typecheck server/gateway/web exit 0; `test:server` 247/247; `test:gateway` 143/143;
  the four web adapter suites 30/30; `test:web:unit` exit 1 with the same 22 failed tests / 23 failing-name entries as
  base `b9b28dd` and no new name; `check:docs` 178 files 0 broken; `check:entrypoints` 0 newly missing.

## Limits

- The measured window is a few stated idle windows (seconds), not a multi-minute soak; the bound is real, the duration
  is shortened.
- One fixture, one browser (headless Chromium), one Next build, HTTP/1.1.
- The hop's idle deadline is the fixture's own transport, not a reverse proxy or the deployed topology.
- The merged origin seam suites assert the enabled path (frames arrive, none is folded into a data frame, the timer
  stops with the connection); the disabled path is asserted at the browser by the fixture's `disabled` run.

## Superseded work

An unreviewed origin-test replacement was written on `impl/perf-01-heartbeat` alongside the guide notes below and is
**not** part of this slice: it added a cadence-zero control per origin suite. The approved browser fixture
(`apps/web/e2e/stream-heartbeat-idle.mjs`) closes the central gap that replacement was aimed at — the keepalive is
proven where it is consumed, across the whole proxy chain, with its own disabled control — so the merged suites stay as
they were reviewed and no further test loop is opened. The replacement is preserved as a labeled stash and a patch under
`.dev/verify/t01/` for provenance only.

The guide half of those notes (the `HEPI_HEARTBEAT_MS` / `HEPI_TERMINAL_HEARTBEAT_MS` knobs in
`docs/local-integration.md` and `docs/deployment.md`) is real and was recovered from that saved patch into its own
docs-only branch; see the guide sections themselves.

## Review notes

Reviewed by reviewer100 at `33335a8` and approved (Standards 0 findings, Spec 0 findings); the earlier request-changes
was that the acceptance be measured at the browser rather than at an origin seam, which the fixture now does.
