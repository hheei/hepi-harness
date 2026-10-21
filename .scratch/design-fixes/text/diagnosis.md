# design-fixes/text — diagnosis

Revision: `1758c1fb4479e9d4637a957857246c5998619d73` (HEAD) plus the authorized audit dirty changes elsewhere in the tree.
Scope of this file: the two findings below, both in the accepted-text / history-read area.

**Chronology, stated exactly.** The classification reasoning below was established **before** any patch, on evidence
from the probes in the table, all of which ran against unmodified source. This file was **written after** the first
`history-window.ts` edit had already been applied — the parent observed the source patch before this record appeared —
so it is a written-up diagnosis, not a claim that the tree was untouched when it was recorded. What the evidence does
support is that every probe below ran against pre-patch source: R1 is an audit run from before this work, and R2–R5 are
my scratch probes, each executed before the first edit. The red proof required for completion is a separate,
explicitly-run check against the pre-fix backend, recorded at the end of this file.

Checks I ran myself, all on the revision above with `apps/server/src`, `packages/protocol/src` clean at the time:

| # | Command (cwd) | Exit | Log | What it establishes |
| --- | --- | --- | --- | --- |
| R1 | `node --import ./lib/register.mjs probe-frame-navigation-detail.mjs` (`.scratch/development-audit/perf-probes`) | 0 (audit run, re-read not re-run) | `.dev/research-performance/logs/frame-navigation-detail.log`, result JSON read directly | real 1.5 MiB POST → 202; after settlement `/state` 200 window `[36]` `hasMore:true oldestEntryId:"36"`; `?before=36` **200, entries [], hasMore true, oldestEntryId null**; `?before=35` **413** naming entry 30 (3,186,772 B); `/entries/30` 200, 3.0 MiB |
| R2 | `node --import ../../development-audit/perf-probes/lib/register.mjs explore-pagination.mjs` (`.scratch/design-fixes/text`) | 0 | `.dev/verify/design-fixes/text/explore-pagination.log` | my own native fixture: real 512 KiB POST accepted, settled by observation; `/state` 200 `[28]` `hasMore:true oldestEntryId:"28"`; `?before=28` **200 entries [] hasMore true oldestEntryId null** |
| R3 | `node --import ../../development-audit/perf-probes/lib/register.mjs explore-slice.mjs` | 0 | `.dev/verify/design-fixes/text/explore-slice.log` | the native active range and the view order for the R2 fixture: `ACTIVE_ASC 28,27(pi.system),26(pi.compaction head=22),22(pi.user 531,674 B),20..13`; `VIEW_ENTRIES 26(head 22),22,27,28`; pages `before=28 → [] hasMore true cursor null`, `before=27 → 413 entry 22`, `before=26 → [] hasMore false` |
| R4 | `node --import ../../development-audit/perf-probes/lib/register.mjs explore-pagination-raw.mjs` | 0 | `.dev/verify/design-fixes/text/explore-pagination-raw.log` | the same empty-page shape with **no** oversized text at all: a 700 KiB assistant `toolCall` input plus a `pi.system` entry — the pagination defect is independent of text deferral |
| R5 | `node --import ../../development-audit/perf-probes/lib/register.mjs explore-structured.mjs` | 0 | `.dev/verify/design-fixes/text/explore-structured.log` | a scripted 1.76 MB assistant `toolCall` lands as a real entry and `/state` answers 413 `frame_too_large entryId 19 bytes 1,760,968` — structured content is a genuine separate limit, out of this scope |

All four `explore-*` scripts are scratch probes of mine under `.scratch/design-fixes/text/`; each owns its own temp
directory and SQLite file, uses the native harness plus the faux provider, makes no network or model call, and touches no
repository source. The exit code of a probe says the probe completed, not that the behaviour under test is correct.

## Finding 1 — a deferred text block has no read block, so accepted text is unrecoverable by design

**Trigger and observed impact.** A user pastes ~0.5–1.5 MiB of text. The real `POST /messages` answers **202** and the
entry is committed (R1, R2). Afterwards the browser can neither read that message nor navigate past it: the window
drops it, the page that reaches back for it answers **413** (R1, R3) and the page one step nearer answers an empty body
that claims `hasMore: true` with no cursor (R2, R4). The content is not lost — `GET /entries/:id` serves it whole — but
no browser surface reaches it: the adapter forwards only `thinking` and `tool-result-image` read blocks
(`apps/web/adapters/durable-api.ts:501`), and the renderer has no text read block at all
(`apps/web/components/MessageView.tsx:998` renders `block.text` verbatim, `:349` the user's text, `:1151` the
tool-result text).

**Why this is a design gap, not a local logic bug.** The module's own Interface already states the obligation, in the
deferral contract: heavy history content is replaced by a bounded representation **because a read block restores it**
(`apps/server/src/history-window.ts:245-256`, restated for the reader in `docs/chat.md:93`). Thinking and images
satisfy that obligation; text is the one heavy class with no read block, so the Interface's stated losslessness does not
hold for the content class that ordinary use actually produces (a paste). The evidence for "design" and not "logic" is
the caller side, which the classification rule names explicitly: a browser that wants the full text must know a fact the
Interface never states — that the committed entry is readable **by id** through a route the frame does not name, and
that the projected `text` field is a preview rather than the content. A caller cannot discover either from the Interface,
which is exactly "the caller must understand a missing ownership/recovery policy".

- Interface obligations the current Interface does **not** state: how much of a heavy text a frame carries, which
  identity addresses the rest, and that `entry.text` is a preview rather than the content.
- Owner: the existing projection seam — `projectEntry` + `deferHistoryMessage` (`apps/server/src/server.ts:326`,
  `apps/server/src/history-window.ts:257`) and the existing read-block route family (`/entries/:id/thinking`,
  `/entries/:id/tool-result-image`).
- Deletion test: deleting the projection would scatter redaction, role filtering, preview rules and read-block URLs
  across four callers (state, SSE, paging, by-id). It earns its keep; the fix completes it, it does not replace it.
- Dependency categories: the projection rule is **in-process**; the native read is **local-substitutable** (existing
  temp SQLite + real harness); the browser-to-backend hop is **remote but owned** (existing Next adapter). No new port,
  registry or second store owner is introduced — the read block reuses the existing fork-aware `visibleEntry` primitive
  (`apps/server/src/server.ts:392`) that the thinking block already uses.

**Minimal coherent fix at the owner.** A third read block beside the two that exist, and a preview that replaces the
heavy text in **both** representations of the entry (the compatible `text` field and the message beside it), so the
projection keeps its one-expression property and the 2.03× wire amplification of the raw text disappears with the same
rule rather than a second one. Threshold and preview length are separate numbers: the threshold (`TEXT_DEFER_BYTES`,
64 KiB, measured in UTF-8 bytes once per block) keeps the framework's own ~50 KiB tool bound, ordinary answers, diffs and
code blocks inline — deferring those would charge a click for a reading experience that was never at risk — while the
preview length (`TEXT_PREVIEW_CHARS`, 2,000 characters) is small because the read block, not a larger preview, is what
makes the whole text reachable. A text-only prompt is stored as a plain string rather than an array of blocks; it is
deferred to the block shape so one preview shape and one read block serve both.

## Finding 2 — a raw-only page answers "more exists" with no way to continue (logic)

**Trigger and observed impact.** Whenever the byte budget empties a window's projectable entries, the page that reaches
back for them slices from the boundary the budget already moved past, drops the same entry again, and returns
`entries: []` with `hasMore: true` and `oldestEntryId: null` — a page with no cursor, so a paging client either stalls
or, reading "no entries" as the end, silently loses the messages behind it. R2/R4 show it on a large-text fixture and on
a fixture with **no** large text at all, so it is not a symptom of Finding 1.

**Why this is logic, not design.** The Interface is sufficient and already says the right thing: the projector's own
contract states that `hasMore` is about the transcript rather than the array, that "an entry a bound left behind is one
a caller can still page to", and that the newest entry is never dropped; the public suite asserts the matching
invariant `entries.length === 0 ⇒ hasMore === false`. The implementation violates its own stated obligation: the byte
loop dropped a **projectable** entry, moving the window's boundary past content no caller had received.

- Owner: `WindowProjector.advance` / `#drop` in `apps/server/src/history-window.ts` — the one place the window's
  boundary is decided, shared by the baseline read, the stream and every page.
- Deletion test: deleting it puts the byte budget, the count rule and the boundary back into three callers.
- Dependency category: in-process.

**Smallest coherent fix at that owner.** The rule is: **the byte budget never drops the last projectable entry.**
Stated precisely, the budget may drop a projectable entry only while at least one projectable entry remains in the
window (`#projectable > 1`); once one is left, it is kept even if the window still exceeds the target, and the
transport's own 960 KiB hard bound answers its named refusal for that frame instead of the budget deciding which message
to lose. The byte budget is a *target*, not a hard bound; only the transport's limit is hard.

**The one exception, recorded rather than hidden.** A **count** bound (the raw cap, or the visible cap) can still leave
a window whose entries all project to nothing — a suffix of bookkeeping entries — because the count rule is about
entries, not about messages. Such a window is widened back to the nearest entry that projects to a message
(`#widenToProjectable`), so its boundary is one a caller can page from; a range that holds no projectable entry at all
states no boundary, which is the honest answer to "nothing older is reachable". This widening is the only place the
count rule is relaxed, it is bounded by the raw cap it re-admits, and it is not a second size policy. No entry is
skipped, no arbitrary submission is rejected, and no whole-history rewrite is involved.

## Red proof against the pre-fix backend

The regression driver is `.scratch/design-fixes/text/red-proof.mjs`. It imports **nothing** from the changed source —
it drives the real HTTP routes and asserts the symptom — so a red run is the failure itself and never a missing export.
It was run twice against the same fixture:

| Run | Source | Command | Exit | Log |
| --- | --- | --- | --- | --- |
| Red | my three owned source files temporarily restored to `1758c1f` (the fixed copies were kept at `.dev/verify/design-fixes/text/prefix-src/` and restored immediately afterwards; `git diff --stat` confirmed the fixed diff was back) | `node --import ../../development-audit/perf-probes/lib/register.mjs red-proof.mjs` | **1** | `.dev/verify/design-fixes/text/red-proof-prefix.log` |
| Green | the fixed sources | same command | **0** | `.dev/verify/design-fixes/text/red-proof-green.log` |

Red output, verbatim: `FAIL the frame carries the accepted message as a bounded preview naming a read block — window ids
["28"]`, `FAIL every older page is carried and advances (no empty page claiming more) — empty page with hasMore true and
cursor null`, `FAIL the accepted message is reachable from the window or by paging` → `RED-PROOF: FAIL (3 of 6 checks)`.
That is the reported symptom exactly: the accepted message is not in the window, and the older page answers
`hasMore: true` with no cursor. Green output: all nine checks pass, including "the read block restores the whole text
byte for byte".

## What is deliberately out of scope (recorded, not fixed here)

- A **structured** heavy block with no read block of its own — a `toolCall` whose `arguments` carry a multi-megabyte
  string — still ships whole and can still answer the named 413 (R5). It is the same *class* of gap as Finding 1 but a
  different content class, and it is not the trigger the user reported; it is recorded here rather than fixed. It is
  also what the two existing oversize fixtures now use, since a large **text** output is deferred and can no longer
  exercise that path (`apps/server/test/frame-size.test.ts`, `apps/server/test/delta-frames.test.ts`).
- The caller's hard guard for content whose heavy part cannot be deferred stays valid and is unchanged.
- Live/streaming content stays exact: deferral is for history, and the live partial never passes through it.

## Reader contract this fix publishes (for the Web half, integrated by the parent)

- Block shape on the wire: `{ type: "text", text: <preview>, deferred: true, textUrl: "/api/sessions/<sessionId>/entries/<entryId>/text?blockIndex=<n>" }`,
  beside the existing image block's `{ type: "image", source: { type: "url", ... } }`. The block carries its own URL
  because a tool result has no `entryId` at render time, so the URL cannot be assembled by the renderer.
- Backend route: `GET /api/conversations/:id/entries/:entryId/text?blockIndex=n` → `{ protocol, conversationId, entryId, blockIndex, text }`;
  404 for an unknown or foreign entry (fork-aware, same primitive as `/thinking`), 400 for a `blockIndex` outside the
  entry's content, 404 for a block that is not text. A plain-string prompt answers index 0.
- Proxy: the existing read-block forward (`apps/web/adapters/durable-api.ts:501`) must accept `parts[4] === "text"` as
  JSON, exactly as it already does for `thinking`. Proposal with the exact patch: `web-adapter-proposal.md` beside this
  file.
- Renderer: the preview is rendered in place (user bubble, assistant text block, tool-result panel) with an
  **explicit** expand control that fetches the read block once and renders the full text as plain text. The prohibition
  is on **automatic** fetches — mount, reconnect, scroll — not on the user's own actions: an explicit copy must preserve
  the original full text rather than silently copying a truncated preview, and an edit-prefill must restore the full
  text before it fills the composer, so both may load it because the user asked for the message itself. Thinking and
  image rendering are unchanged. (The UI half is owned by the parallel UI worker; this is the contract it implements.)
