# 08: Integrated regression, evidence, and owning guides

**What to build:** the whole effort is verified together on one revision, with the measured reductions recorded and every affected guide updated in the same change.

**Blocked by:** 1, 2, 3, 4, 5, 6, 7.

**Status:** complete and closed — accepted at `6899a8c` (`integration/perf-follow-up`). Integrated checks ran on
`b068a90`, reductions recorded, guides updated; docs and evidence only, product trees identical to `b068a90`.

Context pointers: [`spec.md`](../spec.md) (approved), [`design-history.md`](../design-history.md),
[`design-ssh.md`](../design-ssh.md), [`decisions.md`](../decisions.md), [`ticket-proposal.md`](../ticket-proposal.md).
Integration branch `integration/perf-follow-up` at `b068a90`.

- [x] The full required check set passes on the integration revision, including the new budget e2e with terminals in the count, the history benchmark, and the SSH helper-run and layer measurements.
      `b068a90`: `verify --profile=fast` PASS/PASS; `perf-history-scaling.mjs` "all history-scaling claims hold";
      `ux-terminal-budget.mjs` 15 checks / 0 failed; `ux-history-prefix.mjs` all checks; `stream-heartbeat-idle.mjs`
      all checks; `check-docs` 179 files / 0 broken; the SSH lane's `ssh-measurements.mjs` exit 0. Logs under
      `.dev/verify/ticket-08/`.
- [x] Evidence is labelled by what produced it: the chat and connection numbers come from the **deployed** topology, the SSH numbers from the **build host against the real-sshd fixture** because that path is latent in production.
      Labelled per row in [the integrated record](../../../docs/perf-follow-up-verification.md): every browser and
      history number is from the deployment **shape** (prebuilt production Next build, real backend over a real SQLite
      store, real local gateway, controlled completions endpoint) and the SSH numbers from the build host against the
      real-sshd fixture (agent-98's lane: `.dev/verify/ticket-08/SSH-EVIDENCE.md`), which also records that the SSH
      path is latent in production. See *Deviation* below.
- [x] Each route's claimed reduction is a **measurement against the recorded baseline**, with the before-numbers pinned to the worktree and revision that produced them, and any claim that did not reproduce is recorded as a failure rather than smoothed over.
      Baselines: lane B `cb4494b` (`.dev/worktrees/perf-lane-b/.scratch/perf-b/REPORT.md`), lane C `cb4494b`
      (`.scratch/perf-follow-up/evidence/terminal-pool-probe.json`, `BUILD_ID vRBY79KO3pFNmp2MFtFCX`), lane A
      `b9b28dd` (`.dev/worktrees/chat-lifecycle-integration/.scratch/perf-a/logs/`), and the recorded 300 s idle
      SSE teardown in `.scratch/submit-stall/diagnosis.md`. Every claim reproduced; none is recorded as a failure.
- [x] The owning guides are updated in the same change: the chat/lifecycle guide for the window, deltas, paging and the read blocks; the deployment notes for the gateway-managed socket directory and the behaviour change for hosts whose SSH config previously had no multiplexing; the capability-limits record for the named unsupported session case, the oversized non-deferrable content, and the crash residue.
      `docs/chat.md` (window, deltas, paging, `413 frame_too_large`, loaded prefix) and `docs/deployment.md`
      (socket directory, ControlMaster, the behaviour change for gateway-spawned processes) carry the behaviour from
      tickets 01–07; this ticket adds `docs/perf-follow-up-verification.md` (linked from `docs/README.md`) and, in
      `docs/migration-status.md`, the delivered record for tickets 01 and 02 with its limits, plus the named
      `not_supported` session limit and the staging-file residue.
- [x] Published records name hosts by role and paths by placeholder; no personal host name, address, account or credential path appears in the change.
      The new record names the build host and the runtime host by role only, the fixture target as
      `<account>@127.0.0.1`, and paths as placeholders.
- [x] No verification runs a compile or build on the runtime host, and no paid model call is made.
      Every command ran on the build host; the one build is `pnpm --filter @hepi/web build` in this worktree. No
      container was deployed and no provider was contacted — the browser checks use this repository's controlled
      completions endpoint.

## Evidence

- `.dev/verify/ticket-08/` (git-ignored): `verify-fast.log` + `verify-fast/verify.json` (at `b068a90`),
  `verify-fast-clean.log` + `verify-fast-clean/verify.json` (clean tree, `dirty: false`, at the docs commit
  `394422a`, Markdown-only on top of `b068a90`),
  `perf-history-scaling.log`/`.json`, `ux-terminal-budget.log`, `ux-history-prefix.log`,
  `stream-heartbeat-idle.log`, `web-build.log`, and the SSH lane's `ssh-measurements.mjs`, its narrative
  `SSH-EVIDENCE.md`, its structured `ssh-measurements.json`, and the two raw runs `current-b068a90.json` /
  `baseline-52b0131.json` (agent-98's lane, at `b068a90` and the branch point `52b0131`). The pack index is
  `.dev/verify/ticket-08/MANIFEST.md`.
- The heartbeat acceptance report is tracked with the effort at
  `.scratch/perf-follow-up/evidence/stream-heartbeat-idle/report.json`.
- The integrated record is [docs/perf-follow-up-verification.md](../../../docs/perf-follow-up-verification.md).

## Deviation

The criterion's `deployed` topology is met in the **shape** sense only: the chat, connection and history numbers come
from a prebuilt production Web build, the real backend over a real SQLite store and a real local gateway on the build
host — the same shape that produced every recorded baseline — and **not** from the running split deployment. No
deployment was performed in this ticket, so the live `<client-host>`/`<runtime-host>` pair is unmeasured here. The
record states this in *What this record does not claim* rather than implying a deployed reading.

## Closure — accepted at `6899a8c`, 2026-10-14

Closed by agent-99 at pin `6899a8c` (`integration/perf-follow-up`), accepted here as the integration coordinator.

**Docs and evidence only.** `b068a90..6899a8c` changes the tracker, the new record, two guide files, `docs/README.md` and
one evidence JSON — product trees are **identical** at both revisions (`apps abfab3ae`, `packages 9d46deb6`), so this
ticket adds no product code and the product evidence from tickets 01–07 carries over unchanged. The one build in the
pack (`pnpm --filter @hepi/web build`) ran on the build host; nothing was compiled on the runtime host and no provider
was contacted.

**Checks re-confirmed read-only on this pin:** `check:docs` 179 files / 0 broken / 0 missing; the evidence pack is
present with `verify-fast-clean/verify.json` reporting `ok: true, dirty: false`, plus the history-scaling, terminal
budget, history-prefix, heartbeat, web-build and SSH logs.

**Privacy criterion holds for the change, not just by intent.** No added line in this ticket names a host, address,
account or credential path; every added host reference is a role placeholder (`<client-host>`, `<runtime-host>`,
`<account>@127.0.0.1`). The `remote-host`/`workstation` mentions in `docs/README.md` are pre-existing lines untouched by this
change.

**Accepted deviation.** The chat, connection and history numbers come from the deployment **shape** on the build host —
prebuilt production Web build, real backend over a real SQLite store, real local gateway, controlled completions
endpoint, the same shape as every recorded baseline — and **not** from the running split pair, because this ticket
deployed nothing. The record states that under *What this record does not claim* instead of implying a deployed
reading, and that framing is accepted here as documented. The SSH rows are likewise build-host loopback measurements
against the real-sshd fixture, labelled as latent in production.

**Not claimed.** The minimap page request, the oversized non-deferrable **text** entry, the `not_supported` session case
and the unswept socket/staging residue stay recorded limits. The reported sustained multi-second stall is neither
reproduced nor claimed fixed.

## Review notes

No separate reviewer round: the ticket is verification itself, and its deviation is accepted as documented (above).
