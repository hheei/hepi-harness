# 01: One pure lifecycle projection

**What to build:** A conversation's lifecycle facts fold in exactly one place. A pure, conversation-scoped projection
with two entry points — create and advance — turns observations from either transport into one view, a set of notices
and a set of requested effects. It orders facts, ends the pending overlay at the submission's own committed entry,
keeps the answer interest until a terminal fact for that input, derives readiness from the first complete projection on
either transport, reports a failure as unread rather than an endless spinner, and keeps state bounded. It owns no
socket, timer, store, registry, scheduler or retry queue, and no existing caller is switched to it yet.

**Blocked by:** None (can start immediately)

**Status:** resolved — implemented on `impl/chat-lifecycle-01` at `77e115c`, merged into `integration/chat-lifecycle` as `0787784`. Verification below.

**Stories:** 1–21

**Seam:** the pure projection itself, tested directly — the highest seam that carries these rules, with no browser, no
stream and no timer. Prior art: the existing pure-rule suites beside the vendored presentation.

- [x] Creating a projection yields a loading view with no notices; advancing a staged turn plus an idle snapshot emits
      no notice, so a sound can never precede the answer.
- [x] The pending overlay ends when the input's own committed user entry appears, and the answer interest survives that
      commitment.
- [x] A placed entry drops the overlay without dropping the interest; a receipt or an older projection cannot regress a
      known fact; terminal beats placed beats queued.
- [x] A terminal input fact carrying its answer produces one answered notice keyed by conversation and answer; a steer
      group sharing one answer produces exactly one notice; separately delivered frames for the same answer are
      deduplicated by a bounded set.
- [x] A queued follow-up is its own later answer and its own notice, and stays pending across an earlier answer.
- [x] A write's completion, an unanswered fact with its reason, and an abort are not success notices.
- [x] A refused submission restores the staged content; a protocol contradiction (wrong conversation, invalid
      transition, a terminal input without an answer identity) keeps the last good view, reports a protocol issue and
      emits no notice.
- [x] Readiness leaves loading on the first complete projection from either transport; a lifecycle-only frame never
      hydrates; a held HTTP read cannot hide a complete stream projection.
- [x] A read that fails with no prior complete projection yields unread with a transport issue; a failed read after a
      good one keeps the last view.
- [x] A null lookup leaves the interest outstanding and unknown, never rejected and never resent.
- [x] Admission is idempotent; duplicate facts are no-ops; the unfinished-interest registry has a cap and evicts
      settled entries; no connection or timer is opened by the module.

**Context:** [Spec](../spec.md) decisions 1, 5, 6 and 8. Vocabulary: **Pending Submission**, **Committed Message**,
**Submission Outcome Unknown** in [the glossary](../../../GLOSSARY.md); [ADR 0006](../../../docs/adr/0006-durable-submission-lifecycle.md)
for the no-resend rule. Ordering rules from the validation land in ticket 03; the wire facts the projection consumes
land in ticket 02.

## Verification

Implemented at `77e115c2993c55ae24d5fe139df42607538aac12`; merged into `integration/chat-lifecycle` as
`078778488474f3a98f42a89d09c835b843f9b80c` (ticket 02 landed in the same merge).

- `pnpm verify --profile=fast` at `77e115c`, dirty=false, exit 0 — `.dev/verify/2026-10-12T17-01-31-907-verify-fast/`
  on `impl/chat-lifecycle-01`.
- `pnpm test:web:unit` at `77e115c` — 2185 tests, 2163 pass, 22 fail, that run's recorded pre-existing baseline set
  with no projection case among the failures; every `lib/lifecycle-projection.test.mjs` case is `ok`, including the
  ordering, readiness, protocol-contradiction and bounded-state cases — `.dev/verify/2026-10-12T17-02-59-262-web-unit/`
  on the same worktree.
