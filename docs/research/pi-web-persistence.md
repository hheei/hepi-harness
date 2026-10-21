# pi-web persistence and session ownership

Date: 2026-10-09

**Dated research record — read-only findings from this date, kept as evidence.** It describes the upstream
pi-web/SDK behaviour as read then, not this repository's runtime. The "dormant runtime" and copied-UI notes that build
on it were acted on afterwards (the three unimported runtime entrypoints were moved to a vendor snapshot and removed
from executable `lib/`). Current entrypoints: [docs/verification.md](../verification.md).
Question: how does pi-web persist and recover sessions, and what is the relationship between resource loading (skills/prompts/context/config) and storage?
Scope: read-only. No fixes, no tests run.

## Sources

| Source | Revision | Path |
| --- | --- | --- |
| agegr/pi-web | `76bdc57027172eb381a216d647225a6d24f23360` | `/tmp/hepi-upstream-research/pi-web` |
| earendil-works/pi (monorepo checkout) | `6fb2e7815167e6b19006fc526d1a5d0f5f998787` | `/tmp/hepi-upstream-research/pi` |

SDK claims below are cited to the pi monorepo checkout. The flush rule, default session directory rule, and JSONL append path were additionally checked against the SDK actually installed by pi-web, `pi-web/node_modules/@earendil-works/pi-coding-agent/package.json` (`version` `1.0.0`) and its `dist/core/session-manager.js` (see §2). Other monorepo-vs-`1.0.0` drift was not checked and remains a caveat.

## Short answer

- pi-web has **no runtime store**. The runtime is a process-local `Map` of live wrappers over SDK `AgentSession`s (`lib/rpc-manager.ts:1929-1940`). Restart = empty map.
- **History persists; the run does not.** Everything durable is the SDK's own JSONL session file plus a few pi-web JSON sidecars. There is no event log, no resume-from-log, no replay of a half-finished turn.
- **Reconnect is a fresh subscription plus a snapshot**, not a cursor over a durable stream (`lib/agent-event-stream.ts:121-280`). The wrapper replays only what it still holds in memory.
- **Resources are not a storage layer.** Skills, prompts, context and config are read by the SDK's `DefaultResourceLoader`/file paths at session creation and by plain file reads in routes. There is **no custom resource URI and no sandbox** — `grep -rn "pi-resource|resource://" lib app components hooks` returns nothing.

## 1. Create and resume (real entry points)

| Action | Entry | Evidence |
| --- | --- | --- |
| New session | `POST /api/agent/new` → `startRpcSession(tempKey, "", cwd, …)` | `app/api/agent/new/route.ts:46-70` |
| Resume / prompt | `POST /api/agent/[id]` → `resolveSessionPath(id)` → `startRpcSession(id, filePath, undefined)` | `app/api/agent/[id]/route.ts:42-55` |
| Subscribe | `GET /api/agent/[id]/events` (SSE) | `app/api/agent/[id]/events/route.ts:8-31` |
| List | `GET /api/sessions` (persisted scan + runtime merge) | `app/api/sessions/route.ts:18-40` |
| Poll | `GET /api/agent/running` | `app/api/agent/running/route.ts:15-22` |

`startRpcSession` (`lib/rpc-manager.ts:2268`) is the only place a session starts. It reuses a live wrapper if one exists, coalesces concurrent starts through `globalThis.__piStartLocks`, waits for a closing wrapper, then opens the SDK manager:

```ts
// lib/rpc-manager.ts:2299-2303
if (sessionFile) sessionManager = SessionManager.open(sessionFile, undefined);
else { if (!cwd) throw ...; sessionManager = SessionManager.create(cwd, undefined); }
```

The temp-key trick in `/api/agent/new` (`__new__` + `randomUUID()`) exists precisely because start coalescing is keyed by the id (`app/api/agent/new/route.ts:60-66`).

## 2. SessionManager and the JSONL directory

Owned by the SDK, not pi-web.

- Directory: `<agentDir>/sessions/--<cwd with / and : replaced by ->--/` — `pi/packages/coding-agent/src/core/session-manager.ts:589-595`. `agentDir` defaults to `~/.pi/agent` (`.../src/config.ts:430-491`, `getAgentDir()`). **Verified in installed `1.0.0`**: the default session directory rule at `dist/core/session-manager.js:290-295`.
- File name: `<timestamp>_<sessionId>.jsonl` — `session-manager.ts:1080`.
- Header line then one JSON entry per line; entries form a parent-linked tree with a leaf pointer (`session-manager.ts:987-1000`).
- **Lazy first flush**: a file is created only once a user or assistant message exists, so a session that only set model/thinking leaves nothing on disk (`_hasConversation()`, `session-manager.ts:1166`; `_persist()`, `:1170-1189`). **Verified in installed `1.0.0`**: `_hasConversation` is user-or-assistant and the first flush follows it (`dist/core/session-manager.js:778-819`), and subsequent entries are appended to the JSONL (`:812`). pi-web compensates for shell-only sessions by writing the file itself (`persistBashOnlySession()`, `lib/rpc-manager.ts:624-641`).
- `open` reads the file into memory and builds the id index; `create` picks the default dir (`session-manager.ts:1755-1766`).

pi-web's read side does **not** use `SessionManager` for listing. `lib/session-list-scanner.ts` is a hand-rolled incremental scanner over the same directory: it reads only the header line for summaries (`:112-160`), full parses for details (`:196-280`), and keeps a persisted fingerprint index at `<agentDir>/pi-web-session-index.json` (`indexFilePath()`, `:291`; version at `:47`; incremental entry at `:365`). Rationale is stated in the file header: avoid building the SDK's unused `allMessagesText` and avoid re-reading every file per page load.

For single sessions pi-web caches read-only `SessionManager` instances behind a size+mtime fingerprint, with byte-budgeted LRU eviction (`SM_CACHE_LIMITS`, `lib/session-reader.ts:474-486`; `openSessionManager`, `:523`). Mutation paths must open fresh (`{ mutable: true }`).

## 3. Server-side runtime ownership

- Registry: `globalThis.__piSessions: Map<sessionId, AgentSessionWrapper>` (`lib/rpc-manager.ts:1929-1940`). `globalThis` is deliberate so Next.js hot reload and separately bundled route handlers share one map.
- Each wrapper owns the SDK `AgentSession`, its event listeners, extension binding, MCP host, and an idle timer.
- Idle eviction: default 10 minutes (`DEFAULT_SESSION_IDLE_TIMEOUT_MS`, `:140`), extended while a browser holds a liveness lease (below). Stop-uncancellable runs are force-reaped at the default delay (`:592-620`).
- **Disk-ahead eviction**: an *idle* wrapper whose JSONL has an entry the in-memory index never saw (another pi process appended) is destroyed and rebuilt from disk (`evictIfDiskAhead()`, `:374-384`; called from `GET /api/sessions/[id]?force=1`, `app/api/sessions/[id]/route.ts:44-56`). Two processes writing one JSONL is explicitly called unsupported.
- Lifecycle: SIGINT/SIGTERM shut every wrapper down (`:1931-1940`); SSE streams are closed separately (`instrumentation-node.ts`).

The browser never holds a session; it holds an id. Every request re-resolves id → wrapper or id → file path (`resolveSessionPath`, `lib/session-reader.ts:556`).

## 4. Disconnected client re-subscribing

`GET /api/agent/[id]/events` returns an SSE `ReadableStream` (`lib/agent-event-stream.ts:121`). On subscribe:

1. Acquire a liveness lease (`:167`, `acquireSessionLivenessLease`).
2. `session.onEvent(handleEvent)` — the wrapper first replays what it still holds: pending extension UI requests and the latest `tool_execution_start/update` per live tool call (`onEvent`, `lib/rpc-manager.ts:644-651`; `trackActiveToolEvent`, `:415-427`).
3. Emit `connected` with `isStreaming` and `pendingExtensionUiIds`, then the buffered events, then `message_start` with the current partial `streamingMessage` (`:262-280`).

So a reconnecting client gets **current state**, not the missed event sequence. That is the whole recovery story: what the wrapper still has in memory is replayed, everything else is reconstructed from the JSONL history the client reloads.

Backpressure is bounded: droppable deltas above 512 KB queued, hard close at a 16 MB backlog so the client reconnects and re-snapshots (`STREAM_HIGH_WATER_MARK_BYTES`/`DEFAULT_BACKLOG_LIMIT_BYTES`, `:36-37`; `enqueueText`, `:177-200`).

Client side: `AgentEventConnection` owns the `EventSource`, an agent-readiness handshake with timeout, and passive retry (`lib/agent-event-connection.ts:48-202`); reconnect delay 1 s (`hooks/useAgentSession.ts:224`). The selected session's stream stays open while idle; a non-selected session's stream closes after a 30 s grace window (`scheduleEventStreamClose`, `hooks/useAgentSession.ts:1183+`; documented at `docs/agents/sessions.md:34-35,55`).

**Liveness lease** (`lib/session-liveness.ts`): the open SSE holds a 90 s TTL lease (`:3`) renewed by `POST /api/agent/[id]/lease`. The idle timer skips shutdown while a lease is active (`lib/rpc-manager.ts:600-615`). Registry key is `Symbol.for` on `globalThis` so the separately bundled route handlers share it.

## 5. Process restart

Nothing recovers in flight.

- On restart `globalThis.__piSessions` is empty; no wrapper, no listener, no partial message.
- `GET /api/sessions` still lists everything, because it scans the JSONL directory (`lib/session-reader.ts:267-330`, `lib/session-list-scanner.ts:365`).
- `GET /api/agent/[id]` returns `{ running: false }` when no live wrapper exists (`app/api/agent/[id]/route.ts:70-80`; `app/api/sessions/[id]/state/route.ts:12-22`).
- The next prompt re-opens the file with `SessionManager.open` and continues from the leaf on disk. An interrupted turn is whatever pi already flushed; the rest is gone.

There is no durable event log, no replay, and no cross-process coordination beyond the disk-ahead eviction heuristic.

## 6. UI state and settings saving

| State | Path | Mechanism | Evidence |
| --- | --- | --- | --- |
| Session list index | `<agentDir>/pi-web-session-index.json` | best-effort, versioned, atomic write; rebuild on corrupt | `lib/session-list-scanner.ts:47,291,342-362` |
| Sidebar pins/archive/project order | `<agentDir>/pi-web-session-state.json` | `proper-lockfile` lock + atomic replace; corrupt file set aside, never overwritten | `lib/session-ui-state.ts:89,248-258`; doc `docs/agents/sessions.md:62,73` |
| Global settings | `<agentDir>/settings.json` | same lock the SDK `SettingsManager` takes; mode 0600 | `lib/global-settings-file.ts:10,55-75` |
| Models | `<agentDir>/models.json` | read-modify-write, refuses to replace an unreadable file, atomic write | `lib/models-config-store.ts:61,101-113` |
| Credentials | `<agentDir>/auth.json` | 0600 | `lib/provider-credential-store.ts:79,96` |
| Browser prefs (tab, groups, unread) | `localStorage` | per browser, never server | `docs/agents/sessions.md:73` |

Explicit design note from the repo: pins/archive are kept **out** of the JSONL, because a custom entry would advance the leaf, be evicted as a phantom branch, and be copied by every fork (`docs/agents/sessions.md:62`).

## 7. Skills, prompts, context, config: loading vs storage

This is the part most relevant to a split backend/gateway design.

- **No custom URI, no sandbox.** Skills are loaded by the SDK's `DefaultResourceLoader`, both at session start (`createAgentSessionServices(...)`, `lib/rpc-manager.ts:2371-2400`) and by the skills panel (`lib/skills-service.ts:8-14`). The panel comment states the intent plainly: "Uses DefaultResourceLoader (same logic as AgentSession startup) so settings.json skill paths, package skills, and .agents/skills directories are all included" (`app/api/skills/route.ts:14-15`).
- **Skill content is read with ordinary file reads.** Toggling a skill edits the `disable-model-invocation` key in the skill's own `SKILL.md` in place (`app/api/skills/route.ts:44-62`), guarded only by an allowed-roots check.
- **The boundary is a path allow-list, not a resource namespace.** `getAllowedFileRoots()` derives roots from known session cwds and project roots, cached 5 s (`lib/file-access.ts:15-45`); routes then check `isFilePathAllowed` (lexical) or `isExistingFilePathAllowed` (after symlink resolution). The skills edit roots additionally allow `<agentDir>` and `~/.agents/skills` because globally installed skills are symlinked in (`app/api/skills/route.ts:34-42`).
- **Context files** come from the same loader options passed at session start; subagent/chat-only paths explicitly set `noContextFiles` / `noSkills` / `noPromptTemplates` (`lib/rpc-manager.ts:2375-2400`, `lib/chat-only.ts:8-11`).
- **Config** (settings/models/auth) is read and written as plain JSON files under `agentDir` (table above). Nothing is proxied through an abstraction.

Implication: pi-web treats the agent directory and project trees as **the** storage, and has no equivalent of a `pi-resource://` indirection.

Scope limit on the above: `lib/file-access.ts`'s allow-list is the **Web route** boundary (what the browser API may read or write). It is not evidence about the **model tool** boundary — what the `read`/`write`/`edit` tools may touch inside the agent runtime was not inspected here, so no claim is made that the tools are scoped by the same allow-list or that they are unscoped.

## 8. What is worth borrowing, and the real split-deployment differences

Borrowable:

- **Id → (live wrapper | file path) resolution with an explicit fallback** (`resolveSessionPath`). Simple, testable, no hidden state.
- **Persisted fingerprint index for lists** (`pi-web-session-index.json`) with a versioned schema and "corrupt ⇒ rebuild", not error. Cheap first paint; details hydrated later.
- **Fingerprint-validated read-only manager cache** with a byte budget, plus a documented rule that writes bypass it.
- **Liveness lease** decoupling "browser is watching" from the idle timer. Small (`session-liveness.ts` is ~199 lines) and independent of the transport.
- **Disk-ahead eviction** as an honest, bounded answer to a second writer, instead of pretending two processes can share a session.
- **Reconnect = snapshot, not replay**, with `connected.pendingExtensionUiIds` so the client can drop requests closed while it was away.
- **Explicit backpressure policy** with a hard close that forces re-snapshot.

Real differences for a split backend + gateway design:

- pi-web's runtime lives in the same process as the SSE route and the filesystem, and its in-memory wrapper state (partial message, pending tool events) is process-local. That is a placement fact, not a defect to fix here.
- pi-web's recovery is *only* "reload the JSONL and re-prompt". In the target split, the backend owns the model runtime while the gateway executes tools; making a re-executed or resumed tool call safe (idempotent execution) and resuming a run after a gateway restart therefore need mechanisms of their own. pi-web supplies no artifact for that, and this research does not prescribe one.
- pi-web's file boundary is an in-process allow-list derived from known sessions. With a gateway, that check must run where the filesystem is, and the root set must be transmitted or re-derived.
- pi-web deliberately keeps UI state out of the session file. Any harness that adds its own metadata to the JSONL inherits the phantom-branch/fork-copy/leaf-advance problems documented at `docs/agents/sessions.md:62`.

## Unknowns

- Whether SDK `1.0.0` matches the monorepo revision outside the three mechanisms checked above (`_hasConversation` first flush, default session directory rule, JSONL append).
- Whether pi-web's `/api/skills` loader path is also what the runtime uses for skills a session loads (the comment asserts parity; not executed).
- Behavior when two processes write one JSONL concurrently — pi-web calls it unsupported and only detects it after the fact (`evictIfDiskAhead`).
- No measurement was taken of how much of an in-flight turn survives a gateway restart; the JSONL contents at that moment were not observed.
