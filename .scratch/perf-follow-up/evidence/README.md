# Terminal-in-pool evidence

Measurement for `../research/sse-connection-budget.md` §15. Untracked diagnostic scratch: no tracked product file
is modified, nothing is built, no production host or paid model is used.

- `backend-fixture.ts` — real backend + real local gateway that serves terminals (the `TerminalSessions` wiring
  `apps/server/scripts/image-submit-fixture.ts` omits), pointed at the driver's own completions endpoint.
- `terminal-pool-probe.mjs` — the driver: prebuilt Next from the `perf-lane-c` worktree, headless Chromium, the
  page-side EventSource/fetch recorder, held runs at a named barrier, bounded deadlines.
- `terminal-pool-probe.json` — the recorded run (revision, BUILD_ID, node, protocol, every check, every source).
- `children.log` — the fixture and Next server output of that run.

Run it (reuses the existing `.next` build; it never builds):

    node .scratch/perf-follow-up/evidence/terminal-pool-probe.mjs

Overrides: `HEPI_PROBE_WORKTREE`, `HEPI_PROBE_WEB_PORT` (45580), `HEPI_PROBE_BACKEND_PORT` (45581),
`HEPI_PROBE_CONVERSATIONS` (4), `HEPI_PROBE_FETCH_MS` (3000), `HEPI_PROBE_BARRIER_MS` (20000).

Scenarios: A = 2 restored terminal tabs with the panel open; C = the same with the panel closed at load;
B = 1 terminal tab. Each holds 4 real runs (1 selected + 3 background). The page's ordinary same-origin read
(`GET /api/agent/running`) is raced against `HEPI_PROBE_FETCH_MS`.
