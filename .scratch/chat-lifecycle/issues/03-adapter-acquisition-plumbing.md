# 03: Transport facts and the acquisition fence

**What to build:** The browser's adapter feeds the projection with what the wire now carries and with a client-side
acquisition generation stamped when a read or a stream begins. A first complete HTTP projection may hydrate
immediately; stream acquisition selects the authoritative projection identity for that generation; a later HTTP
response from another identity cannot rebase the accepted view and asks for a fresh acquisition instead; a new
acquisition fences old callbacks so a delayed older read or a cancelled read that lands late cannot overwrite fresher
data. The adapter drops no field the projection needs.

**Blocked by:** 01: One pure lifecycle projection, 02: The lifecycle facts the wire is missing

**Status:** resolved — implemented on `impl/chat-lifecycle-03` at `6471038`, merged into `integration/chat-lifecycle` as `7226473` with reviewer finding P3 fixed during the merge. Verification below.

**Stories:** 4–10, 37–39

**Seam:** the browser adapter's public contract, driven through the existing browser-driven end-to-end pattern, with
the pure rules covered at the seam-1 module. Prior art: the existing adapter and browser-driven scripts.

- [x] The adapter forwards the answer identity, the run inputs, the projection identity and the revision on both
      transports; nothing the projection consumes is dropped in mapping.
- [x] A first complete HTTP projection hydrates; stream acquisition then selects the identity for that generation, and
      a rebase across identities is allowed even at a smaller revision while a newer revision wins within one identity.
- [x] After stream acquisition, an HTTP response carrying another identity does not rebase: the accepted view is kept
      and a fresh acquisition is requested.
- [x] A delayed old read that lands after a fresh stream cannot overwrite it, and a read cancelled by a new acquisition
      cannot be stamped as current when it completes.
- [x] Reattachment preserves the good view and never reverts readiness to loading.
- [x] Each ordering counterexample from the validation is a named case at the pure seam, driven through the adapter's
      real request and response shape.

**Context:** [Spec](../spec.md) decision 2 and the ordering counterexamples in
[design-validation.md](../design-validation.md). The projection module lands in ticket 01 and the wire facts in ticket
02; no caller is switched to the projection yet.

## Verification

Implemented at `6471038210f299d5b67c65d5b2a9950fc447294e`; merged into `integration/chat-lifecycle` as
`72264730160a2da07598f3f22ef367496095108e` (parents `0787784` and `6471038`).

- `pnpm verify --profile=fast` at `6471038`, dirty=false, exit 0 — `.dev/verify/2026-10-12T17-50-19-925-verify-fast/`
  on `impl/chat-lifecycle-03`.
- `pnpm test:web:unit` at `6471038` — 2196 tests, 2174 pass, 22 fail, the recorded pre-existing baseline set, no
  lifecycle name among the failures — `.dev/verify/2026-10-12T17-47-01-411-web-unit/`.
- On the merged tip `7226473`,
  `node --test adapters/durable-api.test.mjs adapters/durable-lifecycle.test.mjs lib/lifecycle-projection.test.mjs`
  — exit 0, 58 pass, 0 fail — `.dev/verify/focused-ticket03/web-lifecycle.log` in the integration worktree. The
  behavioral cases in `adapters/durable-lifecycle.test.mjs` drive both transports through the real adapter.

Reviewer finding P3 (nonblocking under [review policy](../../../docs/agents/review-policy.md)) was fixed during the
merge at `7226473`: the source-regex lifecycle assertions duplicated from the behavioral adapter suite were removed from
`apps/web/adapters/durable-api.test.mjs` — the whole payload test, and the two submission-frame regex assertions inside
the resync test, which now covers only the resync marker. The behavioral suite is unchanged, which is why the focused
count is 58 rather than 59.
