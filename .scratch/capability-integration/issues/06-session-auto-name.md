# 06: Session auto-name on request

**What to build:** An explicit request generates a session name from that conversation's own transcript, using the
reused transcript budget and prompt shape. Nothing names a session implicitly: a conversation that is created and run
keeps its name empty until the user asks.

**Blocked by:** 02: Session rename and the catalogue title

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** With the controlled fake model, ask for a name on a session that has a transcript and see the name
appear in the list; create and run another session and see it stay unnamed.

**Stories:** 24, 25, 26

**Seam:** browser → existing Web adapter → durable backend, with the controlled fake model. No paid model call, no
sleeps.

- [x] An explicit auto-name request sets a non-empty name derived from the conversation's transcript, bounded by the
      reused length cap.
- [x] Creating a conversation and running turns never sets a name by itself.
- [x] A name the user typed is not replaced by any implicit naming pass; only an explicit auto-name request replaces
      it.
- [x] A generation failure (no model configured, provider error) leaves the previous name in place and reports the
      failure.
- [x] The transcript budget and prompt shape are the reused upstream ones; the generation call is made from what this
      backend has.

**Context:** [Spec](../spec.md) decisions 16, 8; stories 24–26. The upstream entry point drives a session type this
backend does not own, so only its reusable parts are taken.

## Comments

**Missing contract report (before any code).** No title framework was added. Two existing pieces were reused unchanged
and one existing shape carried the answer.

| What was missing | Existing equivalent reused |
| --- | --- |
| No backend route answered the naming request the shell already posts. | Upstream's own contract: `POST /api/sessions/[id]/auto-name`, answered at the backend as `POST /api/conversations/:id/auto-name` with `{ protocol, conversationId, title }`. |
| The generated name had nowhere to go. | The conversation-scoped `hepi.title` document ticket 02 owns, written by the same commit the rename writes, so the catalogue read that lists the session carries the name. |
| The upstream entry point drives an SDK `AgentSession` this backend does not own (spec decision 16). | The harness's own `Models`, the conversation's own committed model context through `Conversation.context()`, and the conversation's selected model reference. |

**Implementation.** `apps/server/src/session-title.ts` adapts pi-web's `lib/session-title.ts` (MIT,
`agegr/pi-web@76bdc570`): the transcript budget with its per-message caps and head/tail elision, the image marker, the
system prompt and the prompt shape, the parser and its cleanup, the thinking-level choice, the one-shot request options
and the timeout are all reused; only the entry point is replaced, and the message kinds a durable transcript never holds
(branch summaries, custom messages, bash executions) are dropped rather than kept as unreachable code. The route reads
the conversation's committed context, refuses a removed conversation (`session_deleted`), a selection the catalog no
longer serves or a deployment with no model (`no_model`, with the framework's own wording), and a transcript with no
usable text (`no_transcript`), then writes the name and answers it. A failed generation writes nothing and answers
`502` with the provider's reason. `apps/web/adapters/durable-api.ts` carries the shell's own request to that route and
passes the backend's status and reason through; `apps/web/e2e/ux-session-auto-name.mjs` drives it through the real
production Web UI and the toolbar's own control.

**Verification.** Red first: `apps/server/test/session-auto-name.test.ts` (the route answered 404) and
`apps/web/adapters/session-auto-name.test.mjs` (the adapter answered 501) both failed against the unchanged code.

| Boundary | Command | Result |
| --- | --- | --- |
| Backend HTTP + controlled model | `node --test apps/server/test/session-auto-name.test.ts` | exit 0, 10/10 — the explicit request names the session and the same catalogue read carries it; a run makes no naming request and a typed name survives one; a provider refusal keeps the previous name and reports the reason, and the next request still works; no model configured, a deleted selection and an empty transcript are each refused by code; the name is capped at 80 code points and the transcript at the reused per-message cap; every user turn of the conversation is read; the name survives a restart. |
| Web adapter | `node --test apps/web/adapters/session-auto-name.test.mjs apps/web/adapters/session-rename.test.mjs apps/web/adapters/durable-api.test.mjs` | exit 0, 19/19 — the browser's own request reaches the backend route, and a refusal keeps the backend's status and reason. |
| Real browser, real Web origin | `pnpm --filter @hepi/web build` (exit 0) then `HEPI_AUTONAME_WEB_PORT=39712 HEPI_AUTONAME_BACKEND_PORT=44312 node apps/web/e2e/ux-session-auto-name.mjs` | **exit 0**, 22 `ok`, "UX-06 session auto-name checks PASSED". Scenes: a run makes no naming request and leaves the row showing its first message; the toolbar's own Generate title names the row and the catalogue without a reload, with the conversation's transcript and the reused prompt in the one request it made; the name survives a page reload and a later run; a typed name survives later runs and is replaced only by an explicit request; a provider refusal shows "Generation failed" with the provider's reason and leaves the stored name; a backend restart keeps the name. |
| Workspace | `pnpm -r typecheck`; `pnpm -r test` | exit 0, 6/6; server 196, protocol 15, client 9, session 3, gateway 59 — 0 fail. |
| Web unit baseline | `node scripts/compare-tests.mjs --base=78678f9 --cleanup` | exit 0, identical failure set: base 2108 tests / 2085 pass / 23 fail, tip 2110 / 2087 / 23, 0 new, 0 only-on-base. The 23 pre-existing failures are the recorded whole-Web baseline and are not claimed as a pass. |
| Repository checks | `node scripts/check-docs.mjs`; `node scripts/check-entrypoints.mjs` | exit 0, 131 Markdown files, 0 broken links; 52 entry files present, 2 recorded pre-existing missing, 0 newly missing. |

**Limits.** No paid or live provider was called: the model endpoint is the driver's and the test's own controlled
OpenAI-completions server. The generation call follows the deployment's own curated stream options, so a transport this
repository does not exercise (websocket, deferred) is not covered here.

## Review notes

None. Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
