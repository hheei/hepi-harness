# @hheei/pi-subagents v0.3.0 — research for optional use in hepi-harness

Read-only research on the sibling checkout `../hepi-mono`; owned report path
`.scratch/webui-next-exploration/pi-subagents-research.md`. No source outside this file was edited; no builds, tests,
deploys or graph rebuilds. Codex worker 80 and native worker 79 were not touched.

**Baselines.** hepi-mono `519d7872` on `main` (2026-10-14), **dirty**: `M packages/pi-subagents/src/child-control.ts`,
`M src/rpc-events.ts`, `M src/state.ts`, `M test/child-control.test.ts`, `M test/state.test.ts`. Every line reference
below is from that working tree, not from a released tag. hepi-harness `68c2fb2` (detached) was read only.

**Graph queries used** (hepi-mono graph): `pi-subagents extension`, `settlement dedup retry report delivery`,
`registry persistence records file`, `launch spec child process spawn arguments`; each returned locations only and
was confirmed in source.

## 1. What the package is

`@hheei/pi-subagents` v0.3.0, MIT (`LICENSE`, "Copyright (c) 2026 hheei"), repository
`github.com/hheei/hepi-mono` directory `packages/pi-subagents`. It is a **Pi extension**, declared once:
`"pi": { "extensions": ["dist/extension.js"] }` in `package.json`. Dependencies: `@hheei/pi-ext-core`
(workspace). Peers: `@earendil-works/pi-coding-agent >=1.2.0`, `@earendil-works/pi-tui >=1.2.0`, `typebox`.
Source is 9,178 lines in 29 modules with 25 test files (`manager.test.ts` alone 76 KB).

It runs several **independent Pi child sessions** from one Pi session, each with its own session file, runtime and
durable identity, controlled over a Unix-domain-socket RPC bridge.

## 2. Registration and the two branches

One entry, two branches, chosen in `src/extension.ts` by environment: `childIdentityFromEnv(process.env)`.

- **Child branch** (`registerChildBridge`, `child-bridge.ts`): registers only `contact_parent` (`tools.ts`) and the
  reporting bridge; binds to the session id in `PI_SUBAGENTS_SESSION_ID`; on `session_start` dials the parent socket;
  `shouldLeaveBoundSession` unbinds when the process switches to another session (`new`/`resume`/`fork`) and then
  disposes the client for good, so a parent cannot adopt a process now serving someone else's session. `session_shutdown`
  disposes on `quit`/`reload` and reports `tui_quit` only when `mode === "tui"`. The child also blocks `mcp__hindsight__*`
  at the tool boundary and filters MCP servers by `PI_SUBAGENT_MCP_EXCLUDE`/`_SERVERS`.
- **Parent branch**: `registerSubagentInfo`, then `registerExtensionLifecycle(pi, { key: "@hheei/pi-subagents", start })`.
  `start` builds the registry and token store, the host choice (herdr, else cmux, else background), the parent report
  channel (reports wait for the parent to be idle and flush on `agent_start`/`agent_settled`), the `ChildBridgeServer`, the
  `SubagentManager` plus `recover()`, the four tools, the `/subagents` commands and the status line; disposables go on
  `runtime.resources.add`.
- **Tools**: `agent_spawn`, `agent_send`, `agent_get`, `agent_stop` — namespace `agent`, `exposure: "deferred"`,
  `defaultActive: false`, discovered through `tool_search`. The child's `contact_parent({message,reason?})` is the only
  child-facing tool.
- **Authorization**: the parent's socket `authorize` checks the frame's `runtimeIdentity` against the token store and the
  registry record's recorded runtime, so a child cannot name another child's id and take over its channel.

## 3. Control plane, lifecycle, resume, settlement, persistence

**Protocol** (`protocol.ts`, v1, typebox-validated): `hello`/`hello_ack`/`request`/`response`/`event` frames, capped at
1 MiB per frame, 128 pending requests and 256 buffered events. Parent→child: `prompt`, `steer`, `follow_up`, `abort`,
`get_state`, `get_entries`, `shutdown`. Child→parent: `contact_parent`, `task_result` — a refused report (for example a
second task result) is refused to the child that sent it.
Liveness is the connection itself: "no other channel can say whether this child is still running" (`manager.ts`,
`bridge-server.ts`).

**Dedup.** The parent keeps `#served` (answered requests keyed by **runtime identity + request id**, because a
relaunched child restarts its ids) and `#serving` (in-flight requests share one answer). The child mints one request id per
report (`bridge-client.ts`), so a retry after a lost connection repeats the id instead of reporting twice.
Advisory child events are compacted before they cross the socket (text 200 chars, tool text 1000, ≤32 content parts,
images replaced), duplicate streaming deltas in the same phase are dropped, and the current phase is resent on reconnect.

**Settlement.** `#scheduleAutoReport` batches automatic reports: **500 ms** when no child is working, up to **10 s**
otherwise; `#performAutoReport` re-checks `state`, `intent`, activity and work-version under the per-child mutation
lock before delivering, and takes the trailing assistant text via `extractLastAssistantText`. Idle background children
are reclaimed after `SUBAGENT_IDLE_TIMEOUT_MS = 15_000`; a settled panel is closed after
`SUBAGENT_SETTLED_CLOSE_TIMEOUT_MS = 15_000` and only when the host can report focus; stopping an adopted child waits
`SUBAGENT_EXIT_WAIT_MS = 2_000` before calling the exit unconfirmed.

**Resume.** `agent_send` resumes a `done`/`blocked`/`error` child by relaunching the same session (by path when
flushed, else `--session-id`) and re-creating the state projector. A **`stopped` child resumes too** — traced through
`send()` (manager.ts ~1258ff): it asks `#runtimeDoubt` and refuses only while that returns a reason, then reads
`#currentPlacement`, updates the record to `intent: "active"`/`state: "running"` and `#start`s the same session. That
matches `stop()`, which persists `intent: "stopped"` first but keeps the session (final record `state: "done"`, runtime
field dropped, token forgotten), and matches the tool description and README ("The child keeps its session, so a later
`agent_send` can resume it"). `STOPPED_SEND_REASON` (line 57) is **not** a global policy: it is one branch inside
`#runtimeDoubt` (~490–495), reached only when a panel attachment survives `#releasePanel` for an already-stopped child.
The neighbouring refusals are runtime doubt — a runtime this process still holds, or an adopted panel whose exit is
unconfirmed — and an explicit stop clears them. Input is persisted as `unacknowledgedInput` **before**
dispatch and reconciled on recovery with `sessionContainsUserInput`, so a send that may not have landed is not applied twice.

**Persistence.** Registry: `getAgentDir()/pi-subagents/registry/<parentSessionId>.json`, `REGISTRY_VERSION = 1`,
records carrying a positive integer `revision` with compare-and-set updates that fail `stale_revision`. Bridge tokens:
`<tmp>/pi-subagents-<uid>/tokens-<parentSessionId>.json`, a 0600 file in a 0700 directory, written temp-then-rename;
tokens never appear in registry snapshots. Socket: `parent-<parentSessionId>.sock`. Records hold state, intent,
presentation, persistence, the frozen launch config, runtime evidence, usage summary and interruption text.

## 4. Profiles, resources, selection

Agent definitions are Markdown with Pi frontmatter (`parseFrontmatter`): `name`, `display_name`, `description`,
`hidden`, `model`, `thinking`, `tools`, `exclude_tools`, `extensions`, `skills`, `mcp`, `codemode`. `model: inherit`
inherits the parent's model and thinking level; `DiscoveredAgent` carries an `enabled` compliance flag. Built-ins:
`scout` (read-only, disabled until a model is set), `worker`, `reviewer`.

`tools`/`skills`/`mcp` follow Pi's unified selection semantics: boolean toggle, exact list, or `+`/`-` modifiers
(`parsePiSelection`). The launch builder turns them into Pi CLI argv (`--tools`, `--no-mcp`, `--no-skills`,
`--no-extensions`, `-e`, `--skill`, `--append-system-prompt`, plus `--provider/--model/--thinking`), asserts the bridge
extension is inside the effective extension selection, and sets `PI_CODEMODE_MODE=only` for `codemodeOnly`.

## 5. Host coupling (why the architecture does not transfer)

Presentation is frozen per child: `panel` (a herdr tab or cmux surface that **owns** the process, stdio inherited,
`--approve`) or `background` (a child of the parent Pi, stdio piped, `--mode rpc`, held open by its stdin write end). `host-adapter.ts` probes hosts in order `herdr`, `cmux` and reports the fallback reason instead of failing
silently. `openChildPanel` treats a failed open as possibly-started: it keeps the handle and token and refuses a second
runtime until an explicit stop. The parent re-invokes the host CLI (`process.argv[1]`, or `PI_DEV_BIN`).

## 6. `pi-ext-core/src/subagents.ts` is a different module

The graph query surfaced it; source confirms it is **not** this implementation. It is an in-process coordinator
(`startConversation`, `startTask`, `startCompletion`, `retainTerminal`, `releaseRecord`, `getCoordinator`) with
modes `completion | task | conversation`, statuses `queued|running|blocked|idle|completed|failed|cancelled|limit_reached` and a
shared budget `{ maxActiveTurns: 8, maxPending: 16, maxRetainedTerminal: 32 }`. It spawns nothing and opens no socket.

## 7. Reuse: legally copyable vs recommended integration

**Legally copyable.** MIT (`LICENSE`, "Copyright (c) 2026 hheei"), v0.3.0 at `519d7872`; record version, license and
source path for anything adapted. Copyability is not usefulness here:

- *True copy candidates* — pure, self-contained, no Pi-host coupling: `agent-resolver.ts` (agent discovery and the
  `parsePiSelection` `+`/`-` semantics) and the prompt helpers in `launch-spec.ts` (`assembleChildPrompt`,
  `stripHindsightContent`). `json-lines.ts` is a candidate only if hepi ever needs a line stream.
- *Copyable in law, impractical here*: `registry.ts` (JSON-file records + revision CAS — durable documents already provide
  transactions and concurrency control), `runtime.ts` token store and `protocol.ts` (credentials and frames for a Unix
  socket hepi should not open), and the session-JSONL projection in `state.ts` (hepi reads entries through the durable
  session API).
- *Reference only*: `domain.ts` (state machine), `child-control.ts` (event compaction), `manager.ts` (lifecycle) — read for
  semantics, then express them against the Native equivalents (durable tasks, ownership, extension hooks).

**Recommended integration**, independent of what is copied: re-express the semantics as a hepi-owned extension over
durable tasks and owner-edged conversations — parent/child relationship and per-child identity; the four states plus
`intent`; automatic completion reporting with the do-not-poll contract; `blocked` vs `error` reporting; deferred tool
activation with guidance text; agent profiles with Pi selection semantics; unacknowledged-input reconciliation; idle
reclaim; adoption of a child that outlived its parent; one request id per report for idempotent retry.

**Do not port at all**: Pi CLI child processes (argv/session-dir/`--approve`/`--mode rpc`), the Unix-socket bridge, the
herdr/cmux panel layer and the TUI status line. The runtime backend here is the single durable runtime; a second control
channel or a second Pi process would duplicate session ownership, queueing and settlement it already performs.

## 8. What an optional extension needs *here*

Evidence from hepi-harness: extensions are **in-process `Extension` objects** installed into a pi-durable
`createRegistry()` (`apps/server/src/harness.ts`); a refused install is named at startup and the rest still start;
`/api/extensions` reports installed extensions and their tools; a conversation's `pi.agent.extensions` is durable state, and
`apps/server/src/extension-selection.ts` owns the global default new conversations snapshot. pi-durable's `Extension` is
`{ name, tools?, sections?, hooks?, wraps?, tasks? }`, with `defineExtension`/`defineTool`/`defineTask`, and tasks are
resolved by name for every task.

So a hepi-optional subagents plugin is an installed extension exposing `agent_*` tools, a prompt section and durable task
definitions, selectable per conversation, with its own documents for child records. Three gaps are visible:

1. `pi-subagents` peers require `pi-coding-agent >=1.2.0` and `pi-tui >=1.2.0`; hepi-harness pins `pi-coding-agent`
   1.1.0 and has no `pi-tui`, so the package cannot load in the backend process as-is.
2. Nothing in `apps/server` creates a **task-owned conversation**: every creation is
   `ownership: { kind: "ownerless" }`. The owner edge is already surfaced (`subagentParentConversationId`) and a fork of
   an owned conversation is refused — the seam exists with no producer.
3. Tool permissions stay with the gateway capability model; subagent `tools` selection would map onto extension/tool
   selection, not CLI flags.

Ranked reading of the options: (1) re-express the semantics as a hepi-owned extension over durable tasks and
owner-edged conversations; (2) copy the true copy candidates in §7; (3) defer every host/TUI/CLI module; (4) a real
Pi-CLI-child mode is a separate product decision conflicting with "single durable runtime".

## 9. Unresolved facts and discrepancies

- The README claims a "5 second settlement debounce" and "one automatic retry" for transient errors. **Neither policy
  is in this package's source**: delivery batches at **500 ms** (all children settled) or up to **10 s**, the only retry
  logic is transport-level redelivery deduped by runtime + request id, and `auto_retry`/`auto_retry_start`/`auto_retry_end` are
  only forwarded (`rpc-events.ts`, `state.ts`). Pi core carries retry configuration (`maxRetries`, `DEFAULT_MAX_RETRIES`,
  `retryAttempt`), so the behaviour may be owned by Pi rather than by this package — a placement question, not proof the
  README is wrong.
- The README's agent discovery list prints `<cwd>/.pi/agents/*.md` twice; the second root was not confirmed in source.
- Evidence comes from a dirty working tree (five modified files, two in the bridge/state path).
- Whether hepi wants task-owned conversations is a product decision, not a code fact.
