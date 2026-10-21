# 05: Session search over full conversation bodies

**What to build:** Search reads conversation entries through the runtime's public paginated reads and matches the
upstream matcher over the whole body of each conversation, returning the session and a matching excerpt, under a
bounded concurrency, a bounded result count and a bounded time budget. No index is introduced.

**Blocked by:** 03: Session delete

**Status:** resolved — merged into `integration/ux-wave3`.

**Demo path:** Search for a phrase that appears only deep in a past transcript, get the session and the matching
excerpt, and open it from the result.

**Stories:** 38, 39, 40, 41, 42, 43, 44, 45

**Seam:** browser → existing Web adapter → durable backend, with the real store.

- [x] A match deep in a conversation's body returns that session and an excerpt containing the match, not only a
      first-message match.
- [x] A result names the session and the excerpt, and opening it opens that session.
- [x] The search is bounded in result count and in time, and a search that hit a bound reports that it was truncated.
- [x] An over-long query is refused with a readable reason, not a silent empty result.
- [x] A deleted session never appears in results.
- [x] No index exists: an entry appended after a previous search is found by the next search with no rebuild step.
- [x] The reading half uses the runtime's public paginated entry reads; the matcher, limits and response shape follow
      upstream.

**Context:** [Spec](../spec.md) decisions 14, 15; stories 38–45. [Design notes](../design-notes.md) record the
upstream bounds (files, results, time, query length) that the reused matcher carries.

## What was built

- `apps/server/src/session-search.ts` — the owning seam. `searchConversationBodies()` reads each conversation's
  entries through the runtime's public paginated `Conversation.entries()` and applies upstream's matcher, bounds and
  result shape: a literal, case-insensitive match over the user and assistant text of the whole body, at most one
  result per conversation, the entry, block and an excerpt around the match. Every upstream bound is applied and
  named in `SEARCH_LIMITS` — 500 conversations examined, 30 results, a 3 s budget, 16 MiB of text per conversation, a
  1 MiB entry and a 200-character query — and hitting one is reported as `truncated`. The scan is sequential, because
  entry reads are serialized on the runtime's session line, so workers would only queue behind one another. `now`
  and `limits` are injectable for the same reason the skill repository's cache clock is: a test proves the bounds
  without waiting for them or building 500 conversations.
- `apps/server/src/server.ts` — `GET /api/search?q=` over the conversations the catalogue lists, so a conversation
  removed as a tombstone is never a candidate. An over-long query is answered `400` with `code: "query_too_long"`;
  every other failure is the backend's own.
- `apps/web/adapters/durable-api.ts` — `GET /api/sessions/search?q=` (the browser's own upstream route name) forwards
  to that operation and rebuilds each result's row through the same `catalogueRow()` the session list uses, so a
  result and the next list read cannot show two different rows for one conversation. A refusal keeps the backend's
  status and code.
- `apps/web/lib/session-search.ts` — the response shape the sidebar renders, byte-for-byte upstream's, plus the one
  `MAX_SEARCH_QUERY_CHARS` the input, the panel and the backend all name. The upstream file-reading matcher is gone
  from this half: the durable conversation is not a file to stream.
- `apps/web/components/SessionSearch.tsx` — the panel reads the backend's `query_too_long` code and reports the bound
  it is, instead of rendering a refusal as "no matching conversations"; the input's own cap is the same number.
- `apps/web/lib/i18n/messages/{en,zh-CN,zh-TW}.ts` — `sidebar.sessionSearchTooLong`, in all three locale packages.

## Verification

Commands, revisions and logs, all on `impl/session-search-05` after merging `integration/ux-follow-up` at
`155a002`. The tip verified here is `0d926919aef1ce59139be975567117c490607fa5`; the only commit after it changes this
ticket file.

- `pnpm --filter @hepi/server typecheck`, `pnpm --filter @hepi/web typecheck` — exit 0.
- `pnpm verify --profile=fast` — exit 0, PASS/PASS on a clean tree at `0d926919`: workspace typecheck, and workspace
  tests (server 195, gateway 103, protocol 46, client 9, session 3); log
  `.dev/verify/2026-10-11T18-18-53-118-verify-fast/`.
- `node --test apps/server/test/session-search.test.ts` — 9 pass, 0 fail.
- `node --test apps/web/adapters/session-search.test.mjs components/SessionSearch.test.mjs adapters/durable-api.test.mjs
  components/SessionSidebar.test.mjs lib/i18n/registry.test.mjs` — 68 pass, 0 fail.
- `node scripts/test-web-unit.mjs` — 258 files, 2108 tests, 23 failures, the recorded pre-existing baseline with the
  same 24 names as the base run at `78678f9` (`new on tip: []`, `only on base: []`); the removed
  `lib/session-search.test.mjs` is the only file-list change.
- `pnpm --filter @hepi/web build` — exit 0; `node apps/web/e2e/ux-session-search.mjs` — pass, 28 checks: production
  Next build, real backend over a real SQLite store, real local gateway, a real browser window and the sidebar's own
  search box and result rows.
- `node scripts/check-docs.mjs` — exit 0, 131 Markdown files; `node scripts/check-entrypoints.mjs` — exit 0, 0 newly
  missing.

The acceptance list, checked one by one:

- A match deep in the body returns the session and an excerpt containing the match: yes — the backend suite asserts the
  deep-turn phrase returns the conversation with an excerpt around it and names the entry the transcript holds, and the
  driver asserts the result's excerpt is around the match and not the session's first message.
- A result names the session and the excerpt, and opening it opens that session: yes — the driver asserts the result row
  shows the session's name and the excerpt, that clicking it opens that session at the matching turn with the turn on
  screen, and that the result becomes the sidebar's current session.
- Bounded in result count and time, and a hit bound reports truncation: yes — the backend suite builds 31 matching
  conversations and asserts 30 results with `truncated: true`, exercises the wall-clock budget through the injectable
  clock, and the driver asserts the panel reports "Search limit reached" with 30 rows. The scan is sequential and each
  read is bounded at 200 entries, because the runtime serializes entry reads on its session line.
- An over-long query is refused with a readable reason: yes — `400` with `code: "query_too_long"` and no `results`
  field at the backend, the code read by the panel into `sidebar.sessionSearchTooLong`, asserted in the backend suite,
  the adapter suite, the panel suite and the driver.
- A deleted session never appears in results: yes — the backend suite removes a conversation whose retained records
  still hold the phrase and asserts it is gone from results, and the driver does the same through the browser with the
  removal performed over the durable API.
- No index, and an appended entry is found by the next search: yes — the backend suite searches, appends a turn,
  searches again and finds it, then creates a conversation afterwards and finds that too; the driver does the same
  through the panel, and the seam's source is asserted to contain no file, store or index access.
- The reading half uses the public paginated reads; the matcher, limits and response shape follow upstream: yes — the
  backend suite asserts the seam calls `conversation.entries({ order: "ascending" }, ENTRY_PAGE, cursor, ...)`, and
  reads the vendored upstream file to assert every limit's number and the `{ results, truncated }` shape.

## Review notes

| # | Finding | Trigger and impact | Disposition | Revisit if |
| --- | --- | --- | --- | --- |
| 1 | A search reads every listed conversation's entries in full (bounded at 16 MiB of text each) before it can report `truncated`, and the runtime serializes entry reads on its session line, so a deployment with hundreds of large conversations can reach the 3 s budget on the first search. | Upstream scans files under the same budget with the same serialization; the answer is bounded and truthful either way, and the panel says the answer may be incomplete. | `record` | Measured latency on a real deployment makes search feel stalled, or a user reports results missing from a search they expected to be complete. |
| 2 | Newest-first ordering uses the conversation id, because the runtime's `ConversationRecord` carries no timestamp. Ids are minted in creation order, so a conversation created by a fork sorts beside its source rather than by its own age. | The order is a presentation detail and every result is still returned; the sidebar's own list shows creation order for the same reason. | `record` | The runtime adds a conversation timestamp, or a user reports a search result order that is misleading. |
| 3 | `maxEntryChars` bounds one entry's *text* rather than upstream's one JSONL line, so a single entry whose text is over 1 MiB is skipped with `truncated` set instead of being read in parts. | The entry is not searched but the answer says it may be incomplete, and the next entry in the same conversation is still searched. | `record` | A real transcript is shown to hold an entry whose text alone exceeds 1 MiB and is expected to be searchable. |

Findings recorded here follow [review policy](../../../docs/agents/review-policy.md).
