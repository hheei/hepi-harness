# 02: The lifecycle facts the wire is missing

**What to build:** The runtime's own facts travel to the browser: a terminal submission fact carries the answer it
produced; a snapshot carries the native run's inputs, null when there is no run; the backend's own projection identity
and its revision travel end-to-end on both the HTTP read and the stream; and the HTTP conversation read carries the
same lifecycle payload as the stream, so the two transports can agree. No new endpoint is added.

**Blocked by:** None (can start immediately)

**Status:** resolved — implemented on `impl/chat-lifecycle-wire-facts` at `f10e89f`, merged into `integration/chat-lifecycle` as `0787784`. Verification below.

**Stories:** 7–10, 37–39

**Seam:** the backend and protocol public contracts against a real backend and store — a real client's request and
response, following the existing backend server and submission suites.

- [x] A terminal input fact delivered by the stream carries its native answer identity, and the input/write
      discriminant and the unanswered reason are preserved.
- [x] A snapshot carries the native run's inputs, and null when there is no run; empty inputs alone are never read as
      no run.
- [x] The backend mints one opaque projection identity per attachment instance and carries it with the revision on
      every complete HTTP and stream snapshot; the identity is not a persisted counter and no table or epoch is added.
- [x] The HTTP conversation read carries the same lifecycle payload as the stream, and unrelated reads are not
      combined into a supposed atomic snapshot.
- [x] Within one projection identity a newer revision is accepted, an older one is ignored, and an equal one is
      idempotent; the identity is opaque and has no numerical order across identities.
- [x] A lifecycle frame is not a snapshot: a terminal record is never discarded because a state snapshot carries an
      equal or higher revision, and the frame's conversation is validated.
- [x] The projection contract is asserted against the real backend, including that both transports carry the same
      payload for one conversation.

**Context:** [Spec](../spec.md) decisions 2 and 3. The scoped submission lookup and the batch envelope stay
conditional and are not built here; a batch that is not forwarded is covered by the bounded answer-key dedup in ticket
01. Related: [design-validation.md](../design-validation.md).

## Verification

Implemented at `f10e89f7c6ef7a853bbda3cd1ccdf495ebe9c656`; merged into `integration/chat-lifecycle` as
`078778488474f3a98f42a89d09c835b843f9b80c`.

- `pnpm verify --profile=fast` at `f10e89f`, dirty=false, exit 0 — `.dev/verify/2026-10-12T17-00-51-508-verify-fast/`
  on `impl/chat-lifecycle-wire-facts`; workspace suites green (protocol 47, server 231, gateway 130, client 9, session 3,
  fail 0 each).
- Named cases in that log: `carries the native answer identity of a terminal input, and no answer anywhere else`
  (protocol); `a snapshot states the native run's inputs, and null when there is no run`, `both transports carry one
  complete lifecycle payload under one projection identity`, `a restarted backend mints a new projection identity and
  starts its revision again`, `the terminal frame carries the answer identity a notice is keyed by, and names its
  conversation` (server).
