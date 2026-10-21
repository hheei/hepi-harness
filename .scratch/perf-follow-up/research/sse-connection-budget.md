# SSE connection budget and durable chat lifecycle semantics

Research note. **No code changed, no production write, no paid model.** Compiled from the repository at the
revisions pinned below plus the official external sources cited inline.

## 0. Revision map — what "current" means here

| tree | revision | role |
| --- | --- | --- |
| `integration/chat-lifecycle` (worktree `.dev/worktrees/chat-lifecycle-integration`) | `b9b28dd` | **the intended base** for this research |
| `deploy/cb4494b0` (branch) | `b9b28dd` | **the production deployment revision's branch**; `cb4494b` is its ancestor |
| `cb4494b` (`perf/lane-c`, `.dev/worktrees/perf-lane-c`) | `cb4494b` | the measured lane revision; `git diff --stat cb4494b b9b28dd` is **docs only** (5 files under `docs/`), so the code is identical to the base |
| repository root checkout | `fa495b4` on `impl/capability-11` | **unrelated capability work — not this base.** It lacks ADR 0007, `CompletionDelivery`, the acquisition fence and the catalogue marker; do not read it as "current" |
| `@earendil-works/pi-durable` | `1.1.0` | `watchEvents`, `CommittedWatch` |

Because the code at `b9b28dd` and `cb4494b` is byte-identical, every code citation below is valid for both; line
numbers are from `b9b28dd`.

The deferred-acquisition budget is a **design + red only** proposal in
`.dev/worktrees/perf-lane-c/.scratch/perf-c-sse-budget/spec.md`; it is in no committed tree.

## 1. The browser per-origin connection budget (external, primary sources)

- The WHATWG HTML standard defines `EventSource` and its reconnection model but **specifies no per-origin connection
  limit**; the limit is an implementation choice.
  <https://html.spec.whatwg.org/multipage/server-sent-events.html> (§9.2, "The `EventSource` interface").
- Chromium: the normal socket-pool group allows **6** connections per host/proxy chain —
  `g_max_sockets_per_group = { 6 /* kNormal */, 255 /* kWebSocket */ }`.
  <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/client_socket_pool_manager.cc>.
- Firefox: `pref("network.http.max-persistent-connections-per-server", 6)`.
  <https://searchfox.org/mozilla-central/source/modules/libpref/init/all.js> (line 1147).
- HTTP/2 removes the per-connection socket ceiling by multiplexing streams on one connection, subject to
  `SETTINGS_MAX_CONCURRENT_STREAMS` (recommended ≥ 100, initially unlimited).
  <https://www.rfc-editor.org/rfc/rfc9113.html> (§5.1; §6.5.2).
- HTTP/1.1 defines persistent connections but no client connection ceiling.
  <https://www.rfc-editor.org/rfc/rfc9112.html> (§9.3).

Measured at `cb4494b` (worktree `perf-lane-c`), production Next build over HTTP/1.1:

- Pool control with **no app code**: 1–5 same-origin `EventSource`s → an ordinary same-origin `fetch` settles
  `200` in 4 ms; **6 streams → the fetch never settles** (5 s deadline); 7 requested → 6 live.
  `.dev/worktrees/perf-lane-c/.scratch/perf-c/connection-pool.json`.
- Real app, 6 held runs: entry page never reaches the composer (`composerMs: null`), 9–11 requests pending, a switch
  times out at 40 079 ms. `.dev/worktrees/perf-lane-c/.scratch/perf-c/sse-budget-6.json`.
- The deployed host answers `HTTP/1.1 200`; `--http2-prior-knowledge` is refused
  (`.dev/worktrees/perf-lane-c/.scratch/perf-c/FINDINGS.md`, "Readonly production probes").

## 2. Active durable-path sources at the base — the full inventory

A budget must account for **every source that reaches `readyState === 1` (OPEN)** on the page's origin, not only the
chat streams. At `b9b28dd` there are exactly four `new EventSource` sites in production code (excluding
`vendor/`):

| # | site | route | backend/adaptor status | holds a connection? |
| --- | --- | --- | --- | --- |
| 1 | `.dev/worktrees/chat-lifecycle-integration/apps/web/components/AppShell.tsx:151` — the shell's one source per conversation, created for both the open surface and background delivery | `/api/agent/<id>/events` | **implemented** — `apps/web/adapters/durable-api.ts:670` (`events()`) → `apps/server/src/server.ts:1531` | **yes**, one per conversation with an interest |
| 2 | `apps/web/components/TerminalPanel.tsx:125` | `/api/terminal/<id>/events?cwd=…` | **implemented** — `apps/web/adapters/durable-api.ts:349` → `apps/web/adapters/terminal.ts:74` ("the event stream is the backend's stream … passed through as they are") | **yes**, one per mounted terminal tab |
| 3 | `apps/web/components/FileViewer.tsx:501,673,826,1011,1321` | `/api/files/<path>?type=watch` | **501** — `apps/web/adapters/workbench.ts:341`: `if (type === "watch") return unsupported("Live file watching is not connected to the gateway workbench yet")` | **no** (see §3) |
| 4 | `apps/web/components/ModelsConfig.tsx:1336` | `/api/auth/login/<provider>` | **501** — no `auth` branch in `durable-api.ts`; falls through to `apps/web/adapters/durable-api.ts:667` `return unsupported("This capability is not connected to the durable server yet")` | **no** (see §3) |

Source 1 is already multiplexed per conversation at the base: `AgentEventConnection.subscribe`
(`apps/web/lib/agent-event-connection.ts:76`, `openIfNeeded` `:127`) keeps one `EventSource` per conversation and a
listener set; `useAgentSession` joins it through the shell (`apps/web/hooks/useAgentSession.ts:1073-1090`) rather than
constructing its own. So the live chat count is `|{selected} ∪ nominated|`, and the selected conversation's source is
opened by the warm effect even while its agent is idle
(`apps/web/hooks/useAgentSession.ts:1120-1132`: "Keep the selected session warm even while its agent is idle").

**Terminal sources are not gated by visibility.** `AppShell` renders the right-panel container unconditionally
("always mounted, width animated via CSS", `apps/web/components/AppShell.tsx:2671-2672`) and maps every terminal tab
(`:2771-2779`). `TerminalPanel`'s stream effect has deps `[id, cwd, restored, reconnectKey, t]`
(`apps/web/components/TerminalPanel.tsx:205`) and **no `active`/`rightPanelOpen` guard** — `active` is only used to
focus the terminal (`:208-210`). Tabs are restored from `sessionStorage` (`TERMINAL_TABS_KEY`,
`apps/web/components/terminal-tab-state.ts`) and stay mounted until closed. A reload with N saved terminal tabs
therefore opens N terminal streams on page load.

**File watch and auth login are not held.** `getFileApiUrl(filePath, "watch", …)`
(`apps/web/components/FileViewer.tsx:232`) builds `/api/files/<path>?type=watch`, which the durable adapter routes to
the workbench slice (`apps/web/adapters/durable-api.ts:346`, `isWorkbenchPath` `apps/web/adapters/workbench.ts:448`),
where `type === "watch"` answers 501 (`workbench.ts:341`); DOCX preview is refused the same way (`:342`). The
`FileViewer` only opens its watch when `watchEnabled` is true, and `AppShell` passes `watchEnabled={rightPanelOpen}`
(`apps/web/components/AppShell.tsx:2752`).

## 3. What a 501 does to an `EventSource` (why those two are not pool consumers)

Per the WHATWG processing model, an `EventSource` whose response is not `200` with `Content-Type: text/event-stream`
**fails the connection**: it sets `readyState` to `CLOSED` (2) and fires `error`. "Fail the connection" is distinct
from "reestablish the connection" — the former is **not** retried, only the latter is.
<https://html.spec.whatwg.org/multipage/server-sent-events.html> (§9.2.6, "Interpreting an event stream", and the
`fail the connection` definition in §9.2.5).

Consequences that the tests must respect:

- The file-watch and auth-login sites consume a **transient** connection attempt and then hold nothing; they never
  reach `OPEN`.
- The base measurement harness already draws exactly this line: it records every constructed `EventSource` but counts
  as live only `window.__sse.filter((e) => e.readyState === 1)`
  (`.dev/worktrees/perf-lane-c/apps/web/e2e/perf-lane-c-sse-budget.mjs:139,221,230,249`). So "constructed" and "held"
  must stay separate quantities in any accounting.

## 4. Server SSE and state frames at the base

Backend route `GET /api/conversations/:id/events` — `apps/server/src/server.ts:1531-1536`: writes
`content-type: text/event-stream`, then a `snapshot` frame, then `resync_required` when the client's `?after=`
revision is not the current one.

Frames:

- `snapshot` / `state` — the **full-replacement** projection (no deltas), carrying `revision`, `projectionId`,
  committed entries, live message/tools, busy, settings, queued inputs and the outstanding `submissions`
  (`apps/server/src/server.ts:270` `project`, `:337` `send`, `:407` fan-out).
- `submission` — one lifecycle transition, live and **never buffered or replayed**
  (`apps/server/src/server.ts:411-415`, `:439-441`; `docs/adr/0006-durable-submission-lifecycle.md`).
- `resync_required` — the "a frame was missed" marker (`apps/server/src/server.ts:1536`).

Backpressure — the only server-side byte cap on the durable path:

```ts
// apps/server/src/server.ts:337 (b9b28dd == cb4494b)
function send(response: ServerResponse, event: string, data: unknown): boolean {
  if (response.writableEnded || response.destroyed) return false;
  if (response.writableLength > 1024 * 1024) { response.destroy(); return false; }
  ...
```

A slow client is destroyed at **1 MiB pending output** and reconnects to a fresh snapshot — matching
`docs/architecture.md` ("Slow SSE connections are disconnected once their pending output exceeds 1 MiB").

The Next adapter `apps/web/adapters/durable-api.ts:670` (`events()`) proxies that stream and re-emits
`connected` / `durable_state` / `durable_submission` / `durable_resync`; it sets `X-Accel-Buffering: no`
(`:710`) and has **no byte cap of its own**, relying on `ReadableStream` pull backpressure. The 512 KiB high-water /
16 MiB backlog limits in `apps/web/lib/agent-event-stream.ts` belong to the retained pi-web path and have **no
production importer** at the base (only its own `agent-event-stream.test.mjs` calls `createAgentEventStream`).

Upstream durable retention: `pi-durable` 1.1.0 keeps at most **100 pending watch frames**, beyond which the queue is
cleared and replaced by one snapshot.
`node_modules/.pnpm/@earendil-works+pi-durable@1.1.0.../dist/session/observation.js:3`
(`MAX_PENDING_WATCH_FRAMES = 100`), `:209` (overflow branch); `watchEvents` supplies the replacement through its
`replace` callback (`dist/harness/events.js`).

## 5. Durable chat lifecycle facts

- **`watchEvents(harness, conversationId, context)`** returns one atomic snapshot plus committed event batches;
  overflow collapses to a fresh snapshot instead of an unbounded buffer.
  `.../pi-durable/dist/harness/events.d.ts:160-165`; `dist/harness/events.js:33-58`.
- **A submission has a durable lifecycle** (admitted → placed → terminal); admission is deduplicated by the
  browser-generated `requestId`, and an unknown outcome is looked up by id and never resent.
  `docs/adr/0006-durable-submission-lifecycle.md`; lookup route `apps/server/src/server.ts:1411-1413`.
- **A settlement is a live frame, never retained**; a late client reads the outstanding set from the snapshot and asks
  the by-id lookup. `docs/architecture.md`; `apps/server/src/server.ts:411-415`.
- **Reconnect begins with an authoritative snapshot**; delivery revisions are process-local and reset after a backend
  restart. `docs/architecture.md` "Protocol boundary".
- **Acquisition fence**: the backend mints an opaque `projectionId` per attachment
  (`apps/server/src/server.ts:453`, `:270`) and carries it with the revision on every snapshot; the browser assigns an
  acquisition generation and rejects older ones. `docs/adr/0007-lifecycle-facts-one-projection.md`;
  `apps/web/lib/lifecycle-acquisition.ts:54,93`; `apps/web/lib/completion-delivery.ts:219-296`.

## 6. Budget arithmetic — why "3 background + 1 selected" does not reserve room

The lane proposal computes `maxBackgroundStreams = 6 − 1 (selected) − 2 (headroom) = 3`
(`.scratch/perf-c-sse-budget/spec.md:30-33`). That equation has no term for **terminal** streams, and terminals are
held sources (§2), so the real worst case at the base is:

```
live sources = 1 (selected conversation) + B (background nominations) + T (mounted terminal tabs)
pool          = 6 (HTTP/1.1, one origin)
```

- `B = 3, T = 0` → 4 live, 2 spare: the proposal's own worst case, healthy.
- `B = 3, T = 1` → 5 live, 1 spare: still workable, but the "2 headroom" claim is already spent.
- `B = 3, T = 2` → 6 live: the pool is full, and the proposal's guarantee (composer ready, switch < 1 s, in-page
  `fetch` settles) fails for the same reason the six-conversation case does.
- Terminal tabs are restored from `sessionStorage` and never gated by panel visibility (§2), so `T ≥ 2` is reachable
  without the user doing anything beyond having had two terminals open before a reload.

Two further facts that constrain any accounting:

- The selected conversation's source is opened by the warm effect and **kept while idle**
  (`apps/web/hooks/useAgentSession.ts:1120-1132`), so the "1" is a constant, not an average.
- A terminal stream is **not** a background conversation stream: it is owned by `TerminalPanel`, never passes through
  `CompletionDelivery`, and no `nominate`/`reconsider` path can defer or release it. A budget that counts only
  `CompletionDelivery` nominations leaves `T` uncounted by construction.

## 7. What a deferred acquisition budget can guarantee

The proposal bounds **background** streams and *defers* rather than drops: an over-budget watch keeps its projection
and its `nominated` flag and opens no source until a slot frees. No timer, no scheduler.

| # | guarantee | how it is preserved |
| --- | --- | --- |
| G1 | the selected conversation is **never deferred** | its subscription is the surface's own (`AppShell.tsx:151,192`); not counted against the background budget |
| G2 | one notice per `(conversationId, answerKey)` | `settle`/`claim` untouched (`apps/web/lib/completion-delivery.ts:167,171`; dedup bound 256 at `:69`) |
| G3 | no duplicate audio | same claim |
| G4 | failure/reconnect survive | `AgentEventConnection` ready/retry untouched (`:105`, `:217`); a deferred watch that acquires later gets a fresh source and baseline |
| G5 | unread marker unaffected | the marker is the catalogue's `lastRunEndedAt`, not the live path (§9) |
| G6 | silent baselines stay silent | acquisition/resync/reconnect fold as silent (`completion-delivery.ts:261-290`) |
| G7 | subagent suppression | `isSuppressed` unchanged (`AppShell.tsx:164`) |
| G8 | no idle source retained | `reconsider` release rule unchanged (`:212`) |

**What it cannot guarantee.** A conversation that is deferred and whose run ends before a slot frees produces **no
audio notice**; its answer still marks unread. This is the limit ADR 0007 already accepts for a run never observed
live: "a run that starts and finishes entirely between the poll and the acquisition, or while the tab is hidden, is
never observed live. It produces no audio notice, and it leaves the unread marker … The product guarantee is one
notice per answer group for every run observed while an interest exists, with the marker otherwise."
`docs/adr/0007-lifecycle-facts-one-projection.md:72-78`.

The budget bounds **live browser connections**, not durable retention: the backend keeps no per-turn buffer and the
upstream watch keeps at most 100 pending frames (§4). Deferring acquisition loses no server state a fresh snapshot
does not already carry.

## 8. Factual constraints for shared active-source accounting and terminal tests

These are constraints, not a design. They follow only from the base's own behavior.

**What must be counted**

- The unit of accounting is a source that reached `readyState === 1` (OPEN), never one that was merely constructed
  (§3). Both 501 sites must be excluded; counting constructions would make the file viewer look like a pool consumer
  and the auth panel like a second one.
- The counted set is exactly the two implemented routes of §2: `/api/agent/<id>/events` (one per conversation with
  an interest, including the idle-but-warm selected one) and `/api/terminal/<id>/events` (one per mounted terminal
  tab).
- Accounting must be measured in the page, not derived from a constant: the existing recorder pattern
  (`perf-lane-c-sse-budget.mjs:87-105,139`) already keeps every source with its `readyState` transitions and is the
  right instrument.

**What the terminal case adds**

- A terminal source is created by the tab's mount effect, so the test must open real terminal tabs (the backend
  `/api/terminal` path is implemented, and `apps/web/e2e/ux-terminal-session.mjs` already drives it) and keep them
  open across the measurement.
- Because `AppShell` renders every terminal tab in an always-mounted container and `TerminalPanel`'s effect ignores
  `active`, the count must be read with the panel **closed** and with a **non-active** terminal tab selected; those
  are the states in which a naive "only what is visible" count would report 0.
- Restored tabs are part of the case: seed `sessionStorage[TERMINAL_TABS_KEY]` with N tabs and reload, then assert the
  observed OPEN count on page load.
- "Deferred" and "failed" must be distinguishable: a deferred watch constructs no source at all, a starved one
  constructs one that stays `CONNECTING` (the base's readiness timeout is 60 s and the retry delay 1 s,
  `apps/web/hooks/useAgentSession.ts:265-266`, so a starved source is long-lived and never errors promptly).

**Determinism and controls**

- Holds must be named barriers, not sleeps (the existing `heldResolvers` pattern,
  `perf-lane-c-sse-budget.mjs:57,71`), and reads that may stall must be bounded by a deadline
  (`bounded`/`Promise.race`, `:127-135`).
- Assertions on readiness and responsiveness should be expressed against the **observed** live count, not against a
  hardcoded budget: the pool arithmetic of §6 is `6 − 1 − T`, and `T` varies per scenario.
- Every over-budget scenario needs its under-budget control on the same script and fixture (the four-run control in
  the existing script is the precedent) so a failure is attributable to the count and not to load.
- `readyState === 1` is a browser-side fact; a server-side count of `item.clients` entries
  (`apps/server/src/server.ts:1537`, ended at `:542`) can corroborate it but must not replace it, because the pool is
  a browser-side constraint.

## 9. Unread marker, notification, audio semantics

- The marker is the catalogue's `lastRunEndedAt`, read from the run's own durable receipt and diffed by the pure
  `advanceRunMarks` (`apps/web/lib/run-marks.ts`; `apps/web/components/SessionSidebar.tsx:808` → `:824`
  `writeUnread`; `apps/web/adapters/durable-api.ts:94,142`). Because it comes from the catalogue, narrowing live
  stream coverage cannot break it — only the tone.
- Audio: one completion tone per answer, decided by the page's one registry. `CompletionDelivery.onAnswered` plays
  only when `soundEnabled` (`apps/web/components/AppShell.tsx:167-169`); `useAudio` reuses a single `AudioContext`
  and resumes on user gesture (`apps/web/hooks/useAudio.ts:34-57`). Subagent completions are claimed but suppressed
  (`AppShell.tsx:164`). Browser notifications are a **separate** path
  (`shouldShowBrowserNotification`, `claimExtensionAttentionNotification`; `AppShell.tsx:1076-1089`).

## 10. Reconnect and recovery

- Passive reconnect delay 1 s, readiness timeout 60 s
  (`apps/web/hooks/useAgentSession.ts:265-266`; `AppShell.tsx:160-161`).
- `AgentEventConnection` retries on any non-`startup_error` failure and keeps the subscription across the retry
  (`apps/web/lib/agent-event-connection.ts:208-227`).
- On `connected` or `durable_resync` the watch folds a `recover` input: it asks about every turn still waiting, by
  the `requestId` it was sent under, and never resends (`apps/web/lib/completion-delivery.ts:261-290`; ADR 0006).
- `packages/session/src/browser.ts` (`DurableEventSource`) is a fetch-based `AgentEventSourceLike` with
  `reconnectDelayMs: 1000`, `readinessTimeoutMs: 10000`; a `snapshot` frame emits a synthetic `connected`, and
  `resyncRequired` triggers `stateSnapshot()` (`packages/session/src/index.ts`).
- A terminal stream is reconnected by the browser's own `EventSource` and resumed by the cursor in the stream's id
  field (`apps/web/components/TerminalPanel.tsx:120-135`, `apps/web/lib/terminal-client.ts:18-22`).

## 11. Transport options — what is a proposal and what is a decision

- **HTTP/2 termination** is listed by the lane memo as its option 0: a deployment-side change in front of
  `next start` (h1-only), "deployment only; keeps the bug on any direct HTTP port; not verifiable in this harness"
  (`.scratch/perf-c/DESIGN-lane-c-sse-cap.md:97`). It is a memo option, not a user decision; the production probe
  found h1 only (§1).
- **An application-level multiplex endpoint** (`/api/agent/events?ids=…`) is the lane memo's option 3. The memo
  itself marks it "violates I10" and lists it under **non-goals** ("No endpoint, no protocol, no ADR change",
  `spec.md:39,78`). That is the memo's own recommendation, **not a decision the user has taken** — the memo's
  invariant `I10` is quoted from its own issue-05 checklist
  (`DESIGN-lane-c-sse-cap.md:27`). Treating the endpoint as ruled out would be reading a proposal as an authority;
  what is established is only that the memo does not propose it.
- Independently of transport, the upstream durable retention bound is unchanged: `CommittedWatch` still holds at most
  100 pending frames and collapses to a snapshot (§4).

## 12. Unknowns and gaps

- **HTTP/2 availability on the runtime deployment host is not verified**; only the observed host probe (h1) exists.
- **Safari's per-origin limit was not confirmed from a primary source**; only Chromium and Firefox were.
- **The deferred-acquisition budget is not implemented** — design plus red tests only
  (`.scratch/perf-c-sse-budget/spec.md`; red e2e `apps/web/e2e/perf-lane-c-sse-budget.mjs`). Its guarantees are
  assertions about untouched semantics, not shipped behavior.
- **Terminal streams in the pool: measured on 2026-10-13, see §15.** The six-run numbers in `perf-c/` were taken with
  no terminal open; §15 supplies the missing `T ≥ 1` case at `cb4494b0`.
- **`apps/web/lib/agent-event-stream.ts` byte caps are on no live path** (no production importer at the base);
  confirm before treating the backend's 1 MiB as the only server cap.
- **Intermediary buffering is unknown**: the adapter sets `X-Accel-Buffering: no` and the backend
  `connection: keep-alive`, but no reverse proxy between browser and Next was inspected.


## 13. Can a hidden terminal's SSE detach and reattach? (facts, at the base)

**Yes, and it is already the mechanism the panel uses — but only within two stated numbers.** A detached browser
stream does not kill the shell by itself; the shell's life is held by the gateway's reconnect lease, and the output a
reconnecting caller can be shown is bounded. Both numbers exist and are asserted:

| bound | value | where |
| --- | --- | --- |
| retained output per session (replay) | `TERMINAL_REPLAY_CHARS = 128 * 1024` characters | `packages/gateway/src/terminal.ts:28`; asserted `packages/gateway/test/terminal.test.ts:444` |
| reconnect window (no caller attached) | `TERMINAL_RECONNECT_MS = 120_000` ms | `packages/gateway/src/terminal.ts:29`; asserted `packages/gateway/test/terminal.test.ts:442-484` |
| kill grace after the window | `TERMINAL_END_GRACE_MS = 5000` ms | `packages/gateway/src/terminal.ts:31` |

**Cursor.** The cursor is the session's output **offset in characters**, not a byte position
(`#record`: `session.offset += text.length`, `terminal.ts:646-661`). It travels on output frames only, as the SSE
`id:` field (`terminal.ts` `#terminalEvents` `send`: `id: <offset>` for output, none for exit). On reattach the
gateway reads the standard `Last-Event-ID` header **or** the `?after=` query and lets the header win, because it is
what the browser actually received (`terminalCursor`, `packages/gateway/src/index.ts:896-905`). The Next adapter
forwards both unchanged (`apps/web/adapters/terminal.ts:74-88`) and the backend relay does too
(`apps/server/src/terminal-relay.ts`, events branch). A **deliberate** detach/reattach therefore has to name the
cursor itself: `Last-Event-ID` belongs to one `EventSource` object, so a new object starts with none. The panel
already does this — `connect()` builds `…&after=<offset>` from the offset of the last frame it processed
(`apps/web/components/TerminalPanel.tsx:120-135`) — but that offset lives in the mount-scoped effect closure, so a
reattach that keeps the component mounted continues exactly, while a remount (tab close/reopen, reload) has no cursor.

**Replay and gap signalling.** `TerminalSessions.subscribe(id, listener, after)`
(`packages/gateway/src/terminal.ts:574-598`) answers the retained tail with `reset: true` when `after` is absent,
non-finite, older than the retained start, or **ahead of** the session's own offset; otherwise it returns the exact
continuation from `after`. `reset` is the **only** gap signal, and it is not optional: it is how a stream is never
silently inconsistent (type comment at `terminal.ts:252-256`; computed at `:581`). The panel honours it by clearing the screen before
writing (`if (event.reset) terminal.reset();` `apps/web/components/TerminalPanel.tsx:129`) and drops frames at or
behind its cursor (`:130`). Consequence to state plainly: after more than 128 KiB of output while detached, the user
loses the scrollback older than the tail, visibly.

**Lease.** A session with zero attached callers gets a 120 s lease; attaching clears it, and the lease is re-armed on
detach, on input, on resize, on open, and on exit (`#renew`, `terminal.ts:668-673`; expiry at `:682-693`). When the window runs out on a
live shell the shell is **closed** (`#expire` → `host.end()`); when it runs out on a session that already exited the
session is **forgotten** (`#sessions.delete`), so a later attach answers `unknown_terminal` (404). Only `open`,
`subscribe`, `write` and `resize` renew the lease — `describe` (`GET /v1/terminal/<id>`) does **not**
(`terminal.ts:560-563`), so polling a session's description cannot hold it open. The behavior is directly tested with a
short `reconnectMs` (`packages/gateway/test/terminal.test.ts:442-484`).

**Restored tabs.** Terminal tabs persist to `sessionStorage` under `pi-web:terminal-tabs` as
`{tabs:[{id,cwd,displayCwd}], activeId, open}` (`apps/web/components/terminal-tab-state.ts`;
`apps/web/components/AppShell.tsx:580-602`) and are restored with `restored: true`. On mount the panel asks the host
what the session is (`GET /api/terminal/<id>`); an `ok === false` or `exited === true` answer is surfaced as
"session ended"/"unknown" with the explicit reconnect button rather than a silent replacement shell
(`apps/web/components/TerminalPanel.tsx:167-171`). A tab that restores successfully attaches **without a cursor**, so
its first frame is the retained tail with `reset: true` — a reload clears the screen and repaints from the tail. That
is the behavior today, and it is the same behavior a detach/reattach would produce after a remount.

**Cleanup ownership.** Three owners, each with one job:

- **Browser**: unmount closes the source (`TerminalPanel.tsx:191-200` cleanup → `events?.close()`); `pagehide`/`offline`
  close it too and `online`/`pageshow(persisted)` reopen (`:179-189`); closing a tab issues
  `DELETE /api/terminal/<id>` with `keepalive: true` (`:215-233`).
- **Backend relay**: watches the caller's own connection *before* resolving the binding and aborts the host request
  with it, so a request left behind by a vanished caller cannot hold a session past its window
  (`apps/server/src/terminal-relay.ts`, events branch; tested `apps/server/test/terminal-relay.test.ts:150-165`).
  The relay and the Web adapter keep no session state at all — the cwd travels on every call, so a Web-process restart
  loses no terminal (`apps/web/adapters/terminal.ts:4-14`).
- **Gateway**: owns the process and the lease, and ends every session on shutdown (`closeAll()`,
  `packages/gateway/src/index.ts:835`).

**Native pi-web, second reference** (`apps/web/vendor/pi-web/lib/terminal-manager.ts`, preserved upstream copy, no
production importer at the base): the same two numbers — `MAX_BACKLOG = 128 * 1024` (`:29`) and
`TERMINAL_RECONNECT_MS = 120_000` (`:30`) — the same `reset` rule (`after === undefined || after < start || after >
offset`, `:150-156`), the same "attached listeners cancel the lease" rule (`scheduleCleanup` returns while
`listeners.size`, `:64-68`), and a SIGKILL fallback 2 s after a soft kill (`:186-200`). Two differences matter for
pool accounting: pi-web's registry is process-global (`globalThis.__piWebTerminals`, `:24-26`, created in `registry()` `:36-44`) and therefore dies with
the Web process, whereas the durable gateway runs on the execution host and survives a Web/backend restart; and
pi-web emits a `{type:"closed"}` event on kill (`:199`) that the durable `TerminalEvent` union does not have.

## 14. Terminal tabs and the pool — candidate proposals only, no decision taken

**Status: nothing in this section is approved policy, and none of it is a user decision.** §13 records how the
terminal stream behaves; this section records *candidates* a reader might derive from it and why the first is
rejected. Where a statement below is a proposal it says so. A proposal in this note — or in the lane memo — is not
authority: only the user decides product behavior, and the parent agent is currently designing a multiplex/fan-in
transport that would **preserve host attachments**, so this section must not be read as having ruled that out.

### 14.1 Rejected candidate: cap stream-holding terminal tabs at 3 and defer the surplus

*Proposal — researcher's, rejected as written.* Count mounted terminal streams (`T`) and background conversation
watches (`B`) in one shared budget of `6 − 1 (selected) − 2 (headroom) = 3`, set `B = max(0, 3 − T)`, and
give surplus streams deferred acquisition. The number 3 is the **researcher's** arithmetic from an assumed headroom,
not a user requirement; the "no new endpoint, no scheduler" framing is the lane memo's own invariant I10
(`.scratch/perf-c/DESIGN-lane-c-sse-cap.md:27`), also not a user decision (§11).

**Why it is rejected: it would kill the user's long-running work.** Three facts from §13 make it fail:

1. **A detached shell dies after 120 s.** `TERMINAL_RECONNECT_MS = 120_000` (`packages/gateway/src/terminal.ts:29`)
   is a lease held only while a caller is attached; when it runs out on a live shell the gateway **closes** it
   (`#expire` → `host.end()`, `:682-693`). A user's long task in tab 4 — a build, a server, a test run —
   would be killed by the policy, not by an error.
2. **Nothing except an attached caller renews the lease.** `open`, `subscribe`, `write` and `resize` renew
   it (`:541, :578, :600, :614`); `describe` does **not** (`:560-563`). So there is no "keep it alive cheaply"
   option inside the existing contract: a periodic `describe` poll would not hold the shell, and a periodic
   `resize` would be a new scheduler.
3. **The lease can start before any deferral is even reached.** The panel's mount effect creates the session and then
   attaches (`apps/web/components/TerminalPanel.tsx`, stream effect deps at `:205`). If the attach is deferred by
   the budget, the session exists with **zero attached callers**, so the window is armed at open and runs out on a
   shell the user never touched. Deferral at mount time is therefore not a neutral wait — it is a 120 s countdown to
   killing the tab.

Consequences to state rather than hide: with unchanged tab semantics a cap cannot be "silent" or "transient". It is
either (a) a visible, explained kill of the user's shell, or (b) a new keepalive/hold contract the current gateway
does not have. Neither is available to a researcher; both are product decisions.

### 14.2 What §13 does and does not establish

- It establishes that a **user-initiated or page-lifecycle-driven** detach within 120 s is safe and already used
  (`pagehide`/`offline` → `close`, `online`/`pageshow` → reconnect, `TerminalPanel.tsx:179-200`). That is
  existing behavior, not a cap: the page closes and reopens the same stream, and the panel reattaches with its own
  cursor.
- It does **not** establish that a policy may hold a terminal detached for an arbitrary time. The opposite: past the
  window the shell is closed, or an exited session is forgotten (`unknown_terminal` on a later attach).
- It does **not** establish that a hidden tab can be parked without loss. A remount has no cursor, so it repaints
  from the retained tail with `reset: true` — bounded, visible scrollback loss.

### 14.3 Alternatives, all still open

| # | alternative | status |
| --- | --- | --- |
| A | **Multiplex / fan-in preserving host attachments** — one browser stream carrying several sessions' frames while the host side keeps each session attached | **being designed by the parent agent**; not ruled out here. Avoids the lease problem entirely, because every session keeps an attached host consumer |
| B | **HTTP/2 termination** in front of `next start` | lane memo option 0 (`DESIGN-lane-c-sse-cap.md:97`), a deployment-side change; not verifiable in this harness, not a user decision (§11) |
| C | **Terminal tab cap with deferred acquisition** | rejected as written for §14.1; would need a product decision plus a hold contract the gateway lacks |
| D | **Status quo** — every mounted tab keeps its stream, the pool can be exhausted | measured failure mode of §6; the one option that preserves unchanged tab semantics |

A–D are product/architecture decisions. This note records the facts each must satisfy and recommends nothing.

## 15. Measurement: terminal tabs in the browser pool (2026-10-13)

**This is a measurement, not a decision.** It closes the gap §12 used to list. It changes no candidate in §14: the
120 s lease analysis of §14.1 stands, and nothing here was chosen or approved by anyone.

**Method.** A diagnostic fixture and driver, both untracked, under this effort's
`.scratch/perf-follow-up/evidence/` directory:

| file | role |
| --- | --- |
| `backend-fixture.ts` | the real backend (`apps/server/src/server.ts`) bound to a real local gateway that serves terminals (`TerminalSessions` + `localTerminalLauncher`, the wiring `packages/gateway/src/main.ts` uses and `apps/server/scripts/image-submit-fixture.ts` omits) |
| `terminal-pool-probe.mjs` | the driver: controlled completions endpoint, prebuilt Next, headless Chromium, the page-side EventSource/fetch recorder |
| `terminal-pool-probe.json` | the run's own output |

Pinned facts of the run: worktree `perf-lane-c`, revision `cb4494b0b4429bda1d9940257f661239171ce502`,
`.next/BUILD_ID = vRBY79KO3pFNmp2MFtFCX` (prebuilt; **nothing was built or deployed for this measurement**), node
`v26.5.1`, page `nextHopProtocol = http/1.1`, no production host, no paid model, no tracked file changed.

Setup per scenario: 4 conversations, each holding a real run at a named barrier (so 1 selected + 3 running
background), and real terminal sessions opened through the backend's own relay. The page's terminal tabs are supplied
the way the app itself restores them — `sessionStorage["pi-web:terminal-tabs"]` with real session ids and
`restored: true`, which is the reload case §2 and §8 name. Two tabs need two cwds because `restoreTerminalTabs`
drops a second tab with the same cwd; `/workspace/local` and `/workspace/local/sub` were used. Holds are named
barriers, waits are bounded, and the in-page read is the sidebar's own poll (`GET /api/agent/running`) raced against a
3000 ms deadline.

**Result** (7 checks, 0 failed; `terminal-pool-probe.json`):

| scenario | live sources (terminal / conversation) | in-page ordinary fetch | right panel |
| --- | --- | --- | --- |
| A — 2 terminal tabs, panel open | **6** (2 / 4) | **did not settle** (3000 ms deadline); 9 requests pending | open |
| C — the same 2 tabs, panel closed at load | **6** (2 / 4) | **did not settle** (3000 ms deadline) | `right-panel-closed`, and both terminal sources still `readyState === 1` |
| B — 1 terminal tab | **5** (1 / 4) | **settled**, HTTP 200 in 46 ms | open |

So: **1 selected + 3 running background + 2 mounted terminal tabs = 6 held sources, and an ordinary same-origin
fetch from the page queues behind them**; one fewer terminal (5 held) and the same fetch settles in tens of
milliseconds. The closed-panel scenario shows the §2 claim directly: hiding the panel does not release the terminal
streams — the container is always mounted, so a closed panel still spends pool connections.

**Pinned facts (verbatim from the run).** Raw `terminal-pool-probe.json`: worktree `perf-lane-c`, revision
`cb4494b0b4429bda1d9940257f661239171ce502`, `.next/BUILD_ID = vRBY79KO3pFNmp2MFtFCX` (prebuilt; **nothing was built or
deployed for this measurement**), node `v26.5.1`, page `nextHopProtocol = http/1.1`, and **7 checks with 0 failures**,
with the fixture and server output in `children.log`. **No prebuilt lane C artifact was rebuilt, replaced or touched**
by this measurement: the existing `.next` build was reused as-is.

**Restated limits, in the words the evidence supports.** The tabs are **restored from storage** rather than clicked
open (the click path is covered by `apps/web/e2e/ux-terminal-session.mjs`); the terminal sessions are created
out-of-band through the backend relay before the page loads, so the page attaches to a live shell rather than creating
one; **one fixture, one browser (Chromium), one Next build**; the numbers are Chromium's HTTP/1.1 pool at one origin and
say nothing about HTTP/2 (a stream is not a connection there, §1); and **nothing here measures how long a detached
session survives — the 120 s lease of §13 is not exercised by this run**.

**Limits of this measurement.** The tabs are restored from storage rather than clicked open (the click path is covered
by `apps/web/e2e/ux-terminal-session.mjs`); the terminal sessions are created out-of-band through the backend relay
before the page loads, so the page attaches to a live shell rather than creating one; one fixture, one browser, one
Next build; the numbers are Chromium's HTTP/1.1 pool at one origin and say nothing about HTTP/2 (a stream is not a
connection there, §1). Nothing here measures how long a detached session survives — that is §13's 120 s lease, which
this run does not exercise.
