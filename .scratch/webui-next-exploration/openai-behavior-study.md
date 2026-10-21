# OpenAI multi-agent / multi-conversation behavior — primary-source study

Research date (all accesses below): **2026-10-16**. Read-only external research: no product edits, no graph rebuild, no deploy.
Owner: this file. Contrast material for the local design is [conversation-api-proposal.md](conversation-api-proposal.md) (referenced, not modified).

## 0. Method, pins, and what this file does not claim

| Source tier | What was fetched | Pin / access |
| --- | --- | --- |
| Product docs (first party) | `developers.openai.com/codex/multi-agent.md`, `learn.chatgpt.com/docs/*.md` | live docs, 2026-10-16, HTTP 200 |
| Release notes (first party) | `learn.chatgpt.com/docs/changelog` (HTML only, 1.7 MB) | 2026-10-16, HTTP 200 |
| Source (first party) | `openai/codex` raw files | commit `a45b8ccb016fb74f63a6bc29e701568e387cbe38` (2026-10-16T04:42:32Z), from GitHub commits API |
| Source (first party, separate product) | `openai/openai-agents-python` `docs/multi_agent.md` | commit `17d994bd3045dae71acda676a4ef4762ed8ecd94` (2026-10-15) |

Boundaries applied:

- **Agents SDK is not ChatGPT internals.** Section 5 is a separate product (a library). No SDK statement is used to infer ChatGPT or Codex runtime behavior.
- `developers.openai.com/codex/multi-agent.md` and `learn.chatgpt.com/docs/agent-configuration/subagents.md` are **the same document** (identical 22 907-byte body, title "Subagents", per-surface content switches). There is no separate "multi-agent" doc.
- Docs are product statements, not a lifecycle spec. Where the docs stop, Section 7 records an unknown instead of guessing.
- Codex source statements are static source facts at the pin above. No Codex instance was executed; no integration test was run.

Worker source failures (parent verification supplements these below):

- `help.openai.com/en/articles/10169521-projects-in-chatgpt` → **HTTP 403** (JS/cookie challenge) for both plain and browser-header requests. The legacy help-center article could not be read; `learn.chatgpt.com` is treated as the current product-doc owner.
- `learn.chatgpt.com/docs/changelog.md` → **HTTP 404**. Only the HTML page exists; it was converted locally to text for grepping. Anchors used by the docs (e.g. `#codex-2026-03-18-app`) are not independently verified.
- Zendesk search API on `help.openai.com` → **HTTP 404** (host is no longer a plain Zendesk help center).
- `api.github.com` code search was not used; only known-path raw fetches and one directory listing. No repository clone.

---

## 1. ChatGPT: chats, Projects, branching, agent mode

**Parent verification supplement (2026-10-16):** configured web retrieval successfully fetched the official [Projects help article](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt) and [ChatGPT agent help article](https://help.openai.com/en/articles/11752874-chatgpt-agent). Thus worker HTTP 403 is an access-method limitation, not proof these docs are absent. Projects explicitly documents **Branch a chat**: continue an existing chat while preserving the original; branched chats appear alongside it. Project memory can **reference other conversations** within its configured boundary. This is cross-chat context retrieval, not automatic merging of every transcript or inter-agent execution. Agent mode documents mid-task guidance/interruption and user browser takeover, but not its hidden multi-agent runtime. Use this supplement when worker-only unknowns below conflict.

### 1.1 Chats and Projects (fact — [projects.md](https://learn.chatgpt.com/docs/projects.md), 2026-10-16)

- A project groups **related chats, files, instructions, and sources**. Project instructions apply across its chats; a **Sources** section holds uploaded files and connected context.
- Chat boundaries stay separate: "Start a separate chat for each distinct outcome so its messages and results stay focused while the project preserves shared context." A project "can hold parallel chats for research, drafting, review, and follow-up **without mixing every message into one context**."
- Projects share files/instructions/sources while preserving distinct chats. The official help article additionally documents cross-chat references under project memory and user branching. Distinguish selective context retrieval from merging every transcript, and branch provenance from runtime task ownership.
- Organization controls (pin/rename/search/archive) are explicitly context-neutral: "Pinning doesn't add context or change what ChatGPT can access."
- On web, Chat and ChatGPT Work chats both live in the project's **Chats** list; they remain distinct chats.

### 1.2 Long-running work and steering (fact — [long-running-work.md](https://learn.chatgpt.com/docs/long-running-work.md))

- Guidance is "keep related work in the same chat"; use **separate chats** when independent tasks can run in parallel; "avoid giving two tasks write access to the same connected source."
- Desktop app / CLI / IDE: `/goal` starts Goal mode. The progress row lets the user **pause, resume, edit, or clear** the goal while it works, and follow-up messages can be sent while the goal runs.
- Web: no Goal mode; "Continue in the same chat to add context, adjust constraints, or ask for a status recap."
- Parallelism is achieved by **multiple chats**, each with "its own context, messages, results, and goal"; worktrees are recommended for parallel coding chats.
- Pause is a first-class user control for a running goal ("Pause the goal before you expect to lose connectivity, then resume it").

### 1.3 Subagents in ChatGPT Work (fact — [subagents.md](https://learn.chatgpt.com/docs/agent-configuration/subagents.md))

- ChatGPT Work "exposes subagent workflows and activity to eligible accounts"; agents "run in ChatGPT's hosted environment, and the chat shows their activity and results."
- Trigger: "At most intelligence levels, ask for delegation explicitly. **With Ultra, ChatGPT can proactively delegate** work when parallel agents would materially improve speed or quality." Ultra is "maximum reasoning".
- Management UI is **read-only**: "Open **Subagents** to see read-only **Active** and **Done** lists. Select a completed subagent to inspect its details and result. The web sidebar reports subagent activity; **it doesn't provide controls to stop or steer an individual subagent**."
- Consolidation: "When many agents are running, Codex waits until all requested results are available, then returns a consolidated response" (orchestration, routing follow-ups, waiting and closing are described as handled by ChatGPT/Codex).
- Permissions: "Subagents use the tools available to the parent chat. Website and connector permissions remain tool-specific." No local sandbox/approval-mode control exists in ChatGPT Work.
- Terms defined: **Subagent workflow**, **Subagent**, **Agent thread** ("The thread where a subagent does its work. Supported clients let you open these threads to inspect progress or results.").

### 1.4 Completion signaling (fact — [notifications.md](https://learn.chatgpt.com/docs/notifications.md))

- Web: `Settings > Notifications` manages categories and channels (push/email/SMS); `Manage tasks` opens **Scheduled**.
- Desktop app: turn-completion alerts can be set to never / only in background / always; separate permission and question notifications.
- **Activity view** lists "chats that are unread, **running**, or **waiting for your response**"; the floating pet can show **Running / Needs input / Ready / Blocked**.
- The docs describe notifications and status surfaces only. They do **not** state that a completed child starts a new turn in a parent chat (see Section 7).

### 1.5 Branching / forking (partial fact, partial unknown)

- Worker found no dedicated branch/fork page in the inspected learn.chatgpt.com index. Parent then verified **Branch a chat** in the official Projects help article; absence from one index is not absence from official docs.
- What the first-party **release notes** do state (from `learn.chatgpt.com/docs/changelog`, HTML, 2026-10-16):
  - Codex app `26.210` (2026-02-12): "Added conversation forking" and a floating pop-out window.
  - Codex app `26.317`: "You can now **fork a conversation from an earlier message**, not just the latest turn." Later notes: "Added a link from forked conversations back to the original thread"; a fork shortcut "preserving drafts and **queued prompts**"; "Fixed worktree creation and chat forking for WSL repositories".
  - What's-new summary: "You could fork a chat from an earlier message, making it easier to try a new approach without losing the original path."
- Codex source corroborates only the *child-context* fork concept, not a UI branch tree: `SpawnAgentForkMode::FullHistory`, and changelog entries "Remove **partial-history** subagent forks" and "Add opt-in history prefix preservation for full agent forks".
- **Documented:** branching preserves the original and lists the branched chat alongside it. **Unknown:** exact copied entry/context/storage boundaries and task/report inheritance. Do not infer these from Codex fork internals.

### 1.6 "Agent mode" / other ChatGPT agents

- The current doc set exposes agent-shaped surfaces: ChatGPT Work (multi-step, reviewable result, cloud or local), Codex, **dots** (always-on agents with channels/controls/tasks-and-memory), and Space agents (`@ChatGPT`, `@dot` mentions and comment threads).
- Space agent usage (fact — [space/agents.md](https://learn.chatgpt.com/docs/space/agents.md)): mention `@ChatGPT` or `@dot` inline or in a comment; each mention "asks that agent to act on your request"; the user reviews the reply and any page edits. This is request/response delegation inside a page, not a persistent multi-conversation tree.
- Parent fetched the official ChatGPT agent help article (linked in §1 supplement): it documents mid-task interruption/guidance and browser takeover. It does not specify the hosted internal multi-agent lifecycle.

---

## 2. Codex app / CLI: multi-agent facts

### 2.1 Documented user model (fact — [subagents.md](https://learn.chatgpt.com/docs/agent-configuration/subagents.md))

- Enabled by default in current Codex releases; activity appears in the desktop app, CLI, and IDE extension. `/subagents` (CLI) inspects and switches between agent threads; the app "surfaces each subagent thread so you can inspect its work and the summary returned to the main chat."
- CLI: "The **main thread collects the subagent results into its final response**." App/IDE: expand the panel to see status, "**stop all active subagents**, or open an individual subagent thread."
- Steering/stopping is **not a dedicated UI contract** in the docs — it is a prompt-level capability: "Ask Codex directly to steer a running subagent, stop it, or close completed agent threads" (app, CLI, IDE).
- Approvals: subagents inherit the parent turn's current sandbox and approval settings (including `/permissions` or `--yolo`); a custom agent file **cannot** replace sandbox/approval settings. In the CLI, "approval requests can surface from inactive agent threads even while you are looking at the main thread"; the overlay shows the source thread label and `o` opens that thread. Non-interactive runs fail the action and surface the error to the parent workflow.
- Custom agents (`~/.codex/agents/*.toml`, `.codex/agents/*.toml`): required `name`, `description`, `developer_instructions`; may set `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity` and disable features/skills. They **inherit the parent's permissions, provider, and MCP servers**; `sandbox_mode`, `approval_policy`, `model_provider`, `mcp_servers` in an agent file do not override the parent. Built-ins: `default`, `worker`, `explorer`.
- Global settings (`[agents]` in config): `enabled` (default `true`), `max_concurrent_threads_per_session` (cap on concurrently open spawned-agent threads, **excluding the primary**; legacy alias `max_threads`), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message` (default `true`; whether an interrupted agent turn records a model-visible interruption message).
- Model resolution order: explicit spawn value → `[agents]` default → parent's value; a model chosen without a reasoning effort uses that model's default effort.

### 2.2 Tool surface: two versions, different in kind (source fact, pin `a45b8cc`)

`codex-rs/core/src/tools/handlers/multi_agents_spec.rs`:

- **V1** is the namespace `multi_agent_v1` — "Tools for spawning and managing sub-agents" — containing `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`.
- **V2** registers flat tools: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`, `interrupt_agent`.
- The protocol enumerates the union `spawnAgent | sendInput | resumeAgent | wait | closeAgent | sendMessage | followupTask | interruptAgent | listAgents`.

Verbatim tool descriptions that define behavior (same file):

| Tool | Description (verbatim, trimmed) |
| --- | --- |
| `spawn_agent` (V1 `agent_type`) | "Agent type override for the new agent. **Omit to inherit the parent agent type with a full-history fork**; otherwise, `default` is used." |
| `spawn_agent` (V2) | "Spawned agents inherit your current model by default. Do not set the `model` field unless the user explicitly asks for a different model." |
| `send_input` (V1) | "Send a message to an existing agent. Use `interrupt=true` to redirect work immediately. You should **reuse the agent** by send_input if you believe your assigned task is highly dependent on the context of a previous task." `interrupt` field: "True interrupts the current task and handles this message immediately; false or omitted **queues** it." |
| `send_message` (V2) | "Send a message to an existing agent. The message will be delivered promptly. **Does not trigger a new turn.**" |
| `followup_task` (V2) | "Send a follow-up task to an existing **non-root** target agent and **trigger a turn if it is idle**. If the target is already running, deliver the task promptly **at message boundaries while sampling, or after the pending tool call completes**." |
| `resume_agent` (V1) | "Resume a previously **closed** agent by id so it can receive send_input and wait_agent calls." |
| `wait_agent` (V1) | "Wait for agents to reach a final status. Completed statuses may include the agent's final message. Returns empty status when timed out. **Once the agent reaches a final status, a notification message will be received** containing the same completed status." |
| `wait_agent` (V2) | "Wait for a **mailbox update** from any live agent, including queued messages and final-status notifications. The wait also **ends early when new user input is steered into the active turn**. Does not return the content; returns a summary." |
| `close_agent` (V1) | "Close an agent **and any open descendants** when they are no longer needed, and return the target agent's previous status before shutdown was requested. **Completed agents remain open and count toward the concurrency limit until closed.**" |
| `interrupt_agent` (V2) | "Interrupt an agent's **current turn**, if any, and return its previous status. **The agent remains available for messages and follow-up tasks.**" |
| `list_agents` (V2) | "List **live agents in the current root thread tree**. Optionally filter by task-path prefix." |

Agent status enum in tool output: `pending_init | running | interrupted | shutdown | not_found | { completed: string | null }`.

### 2.3 Context inheritance: fresh vs fork (source fact)

`codex-rs/core/src/tools/handlers/multi_agents/spawn.rs`:

- `full_history_fork: args.fork_context`; `fork_mode = args.fork_context.then_some(SpawnAgentForkMode::FullHistory)`.
- Spawn records `fork_parent_spawn_call_id`, `fork_mode`, `parent_thread_id`, `parent_turn_id`, `root_turn_id`, and the creating turn's trigger.
- The handler module doc: "Sub-agents start from the **turn's effective config**, inherit **runtime-only state such as provider, approval policy, sandbox, and cwd**, and then optionally layer role-specific config on top."
- `codex-rs/core/src/agent/child_config.rs`: `reject_full_fork_agent_type_override` → "Full-history forked agents inherit the parent agent type; omit agent_type, or spawn without a full-history fork." Also: "Preserve activation for history forks without freezing the parent's model-owned prompts. **Fresh child startup restores configured preferences from the retained snapshot.**"
- Changelog entries at the pin: "**Remove partial-history subagent forks**"; "Preserve subagent capabilities independently of forked history"; "Enable dynamic tool inheritance for **fresh V2** subagents"; "Add opt-in history prefix preservation for full agent forks".
- Net: the two context modes are **fresh** (parent's effective config, no history) and **full-history fork** (inherits parent history *and* parent agent type). There is no partial-history fork.

### 2.4 Completion: notification, not auto-wake (source fact)

`codex-rs/core/src/agent/control.rs`:

- `maybe_start_completion_watcher` runs "only ... for `SubAgentSource::ThreadSpawn`, where a parent thread exists and can receive completion notifications." It subscribes to child status, waits for `is_final`, and skips tree-shutdown as a "lifecycle handoff, not a child result for the parent."
- The notification is delivered as `InterAgentCommunication::new(child_agent_path, parent_agent_path, ..., message, /*trigger_turn*/ false)`, kind `Result`. Nearby code branches on `communication.trigger_turn` for admission, and `if !communication.trigger_turn && !threads.contains_key(&agent_id)` treats a non-triggering message differently from a turn-starting one.
- The completion message is built by `format_inter_agent_completion_message` (parent path, child path, status); the tool text confirms the same: a completed agent also *notifies* the parent.
- So completion = a **non-triggering** delivery to the parent (plus a status/mailbox update), while `followup_task`/`send_input` are the operations that can start a turn.

**Same fact at the previous pin, re-fetched directly.** At `7ae831991792744434027c431dfbc7e81dd5c12c` the watcher body is byte-identical in shape (`codex-rs/core/src/agent/control.rs`, 27 101 B, same size as at `a45b8cc`):

- V2 path (lines ~527–546): `format_inter_agent_completion_message(parent_agent_path, child_agent_path, &status)` → `InterAgentCommunication::new(child_agent_path, parent_agent_path, Vec::new(), message, /*trigger_turn*/ false)` → `AgentCommunicationContext::new(AgentCommunicationKind::Result, child_thread_id)` → `send_inter_agent_communication(parent_thread_id, communication, context, TurnStartOptions::default())`.
- Legacy/V1 path (lines ~572–576): `parent_thread.inject_fragment_without_turn(SubagentNotification::new(child_reference.as_str(), status).with_metadata(ContentItemMetadata::tool(namespace)))` — the function name itself states "without turn".
- Admission itself branches on the flag: `if communication.trigger_turn { ... }` (line ~174) and `if !communication.trigger_turn && !threads.contains_key(&agent_id)` (line ~270), so a completion notification is handled differently from a turn-starting message at the point of admission, not merely at the call site.

Permalinks: [V2 branch at `7ae83199`](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control.rs#L527-L546) · [legacy branch at `7ae83199`](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control.rs#L572-L576) · [same region at `a45b8cc`](https://github.com/openai/codex/blob/a45b8ccb016fb74f63a6bc29e701568e387cbe38/codex-rs/core/src/agent/control.rs#L527-L546)

**Docs vs source — keep the two apart.** The official Subagents page never states whether a completed child starts a new parent turn; it only says results are collected ("the main thread collects the subagent results into its final response") and that completion is *notified*. The **non-triggering** delivery is a **source** fact, evidenced independently at two pins; it is the stronger claim and should be cited as source, not as documented product behavior.

### 2.5 Stop, interrupt, close, shutdown, resume (source fact)

- **Interrupt (V2)** — `agent/control/interrupt.rs`: "Applies V2 interruption rules to a registered agent **without loading its runtime**. **Root and self targets are rejected.** An unloaded or already-dead runtime is a **successful** interruption; this operation never reloads it." Self-interrupt error text: "an agent cannot interrupt itself; return your result and let the parent interrupt you if needed."
- **Close (V1)** — `agent/control/legacy.rs`: marks the persisted spawn edge `ThreadSpawnEdgeStatus::Closed`, then `shutdown_agent_tree(agent_id)`, which enumerates `live_thread_spawn_descendants` and shuts each down. Closing a subtree is an explicit operation, distinct from interrupting one turn.
- **Shutdown** — `shutdown_live_agent`: flush rollout, send `Op::Shutdown`, `wait_until_terminated`, then `remove_thread`, forget residency, release the spawned-thread slot, remove mailbox. It is not the same as marking the spawn edge closed.
- **Resume (V1)** — rebuilds config via `build_agent_resume_config` and calls `resume_agent(...)`; the tool text says the resumed agent can again receive `send_input`/`wait_agent`. Reuse of a closed child is an explicit, id-targeted operation.
- Depth and concurrency: `agent_max_depth` (spawn rejects past the limit) and `max_concurrent_threads_per_session`; completed-but-unclosed agents keep consuming the concurrency budget.
- Related release notes at the pin: "Overlap subagent spawn persistence and clean up cancelled children"; "Notify parent agents when Guardian stops a subagent"; "Track sub-agent result delivery outcomes"; "Record multi-agent wait duration by outcome"; "Prevent V2 agent eviction from racing with queued messages"; "Subagents now retain environments that are still starting and receive their configuration or preparation failure."

### 2.6 Queueing, steering, and user-side controls (docs + release notes)

- Codex app notes: "Send a follow-up while Codex is responding to **steer it immediately**. Interrupting a turn also stops active Code Mode cells and their nested tool calls." `instant_interrupt` (opt-in) "lets new input steer Codex during model responses or long-running code-mode calls" — i.e. steering during a running turn is a distinct, configurable capability from queueing.
- Queue semantics visible in app notes: "**Canceling a queued prompt returns recoverable text and attachments to the composer**"; "Unsent queued messages now resume after reconnection once uncertain submissions are resolved, avoiding duplicate sends"; "Fixed **duplicate queued follow-up messages across app windows**"; "Prefer Shift-arrow hints for queued messages and questions"; "Added support for parallel approvals"; "Added thread coordination for local projects and worktrees, including **separate background threads when explicitly requested**".
- User controls documented: `/subagents` to inspect/switch threads; panel to stop all active subagents or open one thread; ask the agent to steer/stop/close; `/goal` pause/resume/edit/clear (Goal mode); fork conversation; `/resume` for chats.
- Not documented anywhere: a per-subagent queue UI with item-level edit/cancel. The item-level recovery text above is about **queued prompts in a chat composer**, not about subagent inputs.

---

## 3. Codex Cloud: parallel tasks are separate workspaces (fact — [cloud.md](https://learn.chatgpt.com/docs/cloud.md), [environments/modes.md](https://learn.chatgpt.com/docs/environments/modes.md))

- Cloud tasks run from a **published environment**; "Each task has its own workspace and can keep working while your computer is asleep." Tasks can be started and continued from web, mobile, desktop, and from the CLI (`codex cloud` — browse active/completed chats, submit work, apply the result locally).
- Cloud tasks do **not** share the local machine: "Your computer's local files, running processes, browser sign-ins, and VPN access aren't automatically transferred." "File changes in a task don't update the reusable environment."
- Environment publishing, saved state reuse, and per-task working files are separate from the environment definition.
- This is a **parallel-task** model (independent conversations with independent workspaces), not a parent/child agent tree. No cross-task steering, no task-level queue, and no documented child-of-task relationship.
- Docs guidance for parallel work generally: separate chats, avoid two chats writing the same files, use worktrees for separate checkouts.

---

## 4. Agents SDK orchestration — a different product (fact, SDK pin `17d994b`)

From `openai-agents-python/docs/multi_agent.md` (2026-10-15):

- Two LLM-driven orchestration patterns: **Agents as tools** ("A manager agent keeps control of the conversation and calls specialist agents through `Agent.as_tool()`" — use when one agent owns the final answer) and **Handoffs** ("A triage agent routes the conversation to a specialist, and that specialist becomes the active agent for the rest of the turn").
- Code-driven orchestration is also described: chaining, evaluator loops, and "Running multiple agents in parallel, e.g. via Python primitives like `asyncio.gather`."
- This is library API guidance for application authors. It is **not evidence** about ChatGPT's hosted subagents, Codex's multi-agent runtime, or any auto-wake/queue semantics inside those products. Recorded here only to mark the boundary.

---

## 5. Scenario comparison (what each surface does, as documented)

| Scenario | ChatGPT (chat/Work) | Codex app/CLI (source at `a45b8cc`) | Codex Cloud |
| --- | --- | --- | --- |
| Start parallel work | Separate chats (or project chats); subagents in Work via explicit ask, or proactive with Ultra | `spawn_agent`; context = fresh (parent's effective config) or full-history fork | New task from a published environment |
| Queue while busy | Not specified; docs only say continue in the same chat to steer | `send_message` = deliver promptly, no new turn; `send_input interrupt=false` = queues; `followup_task` when running = deliver at message boundary / after pending tool call | Not documented |
| Steer running work | Follow-up message in same chat; Goal progress row (pause/resume/edit/clear) | `send_input interrupt=true`; `instant_interrupt` steers during model response | Not documented |
| Interrupt current turn | Not exposed for Work subagents (read-only panel) | `interrupt_agent` (V2): current turn only, target stays usable; rejects root and self | Not documented |
| Stop a subtree | "stop all active subagents" (app/IDE panel) | `close_agent` (V1): mark spawn edge closed + shut down live descendants | Task cancellation not documented in these pages |
| Resume / reuse child | Completed subagent is inspectable; no documented resume | `resume_agent` reopens a closed agent id; `send_input` explicitly recommended for reuse | Continue the task by sending a follow-up |
| Completion | Activity/pet status (Running / Needs input / Ready / Blocked), notification channels; results consolidated into the main response. Whether a parent turn starts is **not documented** | Non-triggering `trigger_turn: false` completion notification + `inject_fragment_without_turn` (V1 path) + status/mailbox update (source fact at both pins); `wait_agent` can also return final status | Task completes; result reviewed in web/app; CLI can apply locally |
| Who can stop whom | User stops all active subagents; no per-subagent control on web | Root/self interrupt rejected; parent closes; child returns result and lets the parent interrupt | Not documented |
| Concurrency bound | Not documented | `max_concurrent_threads_per_session` (primary excluded) + `agent_max_depth`; completed-unclosed agents still count | One workspace per task |

---

## 6. Unknowns (explicit — do not fill by inference)

1. **ChatGPT branch internals.** Parent successfully fetched the official Projects help article: branching creates a separately listed chat preserving the original. Exact storage-copy semantics, runtime ownership and automatic report subscriptions are not documented there.
2. **ChatGPT Work subagent lifecycle.** Whether a parent chat auto-starts a turn on child completion, how child inputs queue, and whether children can be reused/resumed are not documented. Only Active/Done lists and read-only inspection are documented.
3. **ChatGPT Work per-subagent control.** Docs state there are no controls to stop or steer an individual subagent on web; anything beyond that (e.g. prompt-level steering that the docs mention for Codex) is unstated for ChatGPT Work.
4. **Item-level queue editing.** Documented Codex behavior is composer-level ("canceling a queued prompt returns text to the composer"); no per-item subagent queue edit/cancel contract is documented.
5. **Codex interrupt-vs-queue timing.** The V1/V2 descriptions give boundaries ("message boundaries while sampling, after the pending tool call completes") but no atomicity guarantee; source-level ordering guarantees were not traced in this pass.
6. **Codex "full-history fork" payload details.** Prefix preservation is described as opt-in in changelog entries; the exact inherited entry set (compaction markers, attachments, tool output) was not audited here.
7. **ChatGPT agent-mode internals** remain unspecified by the official help article parent retrieved, despite documented interruption and browser takeover.
8. **Worker help-center retrieval** failed with HTTP 403. Parent retrieved the two specific help articles cited in §1; other unaccessed pages remain unverified.

---

### 6.1 Divergence to note: Codex completion watcher vs idle cross-session auto-start

- Codex's completion watcher is explicitly **non-triggering** (`trigger_turn: false`, `inject_fragment_without_turn`): a child finishing notifies the parent, it does not start a new parent turn.
- Parent-supplied context from a parallel study (Claude cross-session behavior, **not re-verified in this OpenAI-focused study**): an idle cross-session recipient can be **auto-started** with an injected boundary message, with accept/hold/refuse handling — and notably **no stop-to-hold**.
- These **specific mechanisms** differ: pinned Codex child-completion notification is non-triggering; Claude cross-session accepted messages can start an idle turn. Do not generalize this to every message/completion path or call one a superset: source surfaces and inbound-policy semantics differ. Our normal-recipient auto-wake with held-recipient queueing remains an explicit product policy.
- Verification status: the Codex half is source-verified at two pins (permalinks above). The Claude half is recorded as supplied context and must be re-checked against Anthropic primary docs before being quoted as fact.

## 7. Simplest behavior recommendations for hepi-harness

Derived from the facts above, not from inference about undocumented internals. Each is a small, defensible rule; none requires a new subsystem.

1. **Keep context selection explicit.** Codex distinguishes fresh from full-history fork. Its removed partial-history tool option does not establish that our native fork-at or explicit compact preparation is wrong. Retain user-approved preparation strategies unless independently reconsidered; do not remove them to copy a different runtime.
2. **Separate delivery from turn-start intent.** Codex V2 send_message vs followup_task illustrates this distinction. It is not identical to clearing our held state: permission to resume a user-paused conversation is an independent decision. The existing five-operation interface can expose clear intents without requiring another tool family.
3. **Completion is a notification, not a wake.** Codex delivers child completion with `trigger_turn: false` (V2 path) and `inject_fragment_without_turn` (V1 path), verified at two pins. Auto-wake is therefore our own added policy, not something to attribute to Codex: keep the persistent report receipt, and make parent turn-start an explicit, policy-checked step (never for a stopped/held recipient).
4. **Interrupt ≠ close ≠ shutdown.** Codex interruption preserves the thread; V1 close shuts the runtime subtree and releases concurrency slots, while resume_agent can reopen the conversation identity. Close does not mean immutable terminal conversation or deletion. Our agreed stop retains the conversation; no new subtree-control requirement follows from this comparison.
5. **Read authority restrictions precisely.** Audited V2 interrupt_spawned_agent rejects root and self; it does not establish a blanket ban on every non-root ancestor or sibling. Our authorized cross-conversation operations are an existing product choice, not something to remove by analogy. Preserve self-stop protection; review any further restriction on its own merits.
6. **Reuse is id-targeted, with clear work intent.** Codex V1 resume_agent reopens closed runtime state, while send_input handles related follow-up work. Claude also resumes completed children by message. Our send can intentionally start follow-up work on an existing Conversation; no extra mandatory resume API is justified for every normal completion. User-held targets remain a separate permission question.
7. **Bound concurrency and depth at the host, excluding the primary.** `max_concurrent_threads_per_session` + `agent_max_depth`; completed-unclosed children still count. Matches the proposal's configurable cap with an explicit over-limit error.
8. **Keep the notification/status surface separate from the control surface.** ChatGPT Work's panel is read-only (status + results) while Codex offers stop/steer via prompts and a stop-all panel. Our UI can show status read-only by default and expose per-item queue controls as our own explicit addition — that part has no OpenAI precedent to copy, so it stays our design decision.
9. **Distinguish project context, branches and task ownership.** Projects has shared inputs and memory-based references to other chats; branching creates another conversation. None alone proves automatic runtime ownership, child cancellation or report routing.
10. **Do not adopt Agents SDK handoff semantics as our runtime model.** "Handoff = specialist owns the remainder of the turn" is a library pattern; our child conversations are independent and outlive the parent turn.

---

## 8. Source list (URLs, access date 2026-10-16)

Product docs (first party, live):

- https://developers.openai.com/codex/multi-agent.md and https://developers.openai.com/codex/subagents.md — identical body (22 907 B); canonical content also at https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- https://learn.chatgpt.com/docs/projects.md
- https://learn.chatgpt.com/docs/long-running-work.md
- https://learn.chatgpt.com/docs/notifications.md
- https://learn.chatgpt.com/docs/use-chatgpt.md
- https://learn.chatgpt.com/docs/web.md
- https://learn.chatgpt.com/docs/app.md
- https://learn.chatgpt.com/docs/cloud.md
- https://learn.chatgpt.com/docs/environments/modes.md
- https://learn.chatgpt.com/docs/space/agents.md
- https://learn.chatgpt.com/docs/codex/cli.md
- https://learn.chatgpt.com/docs/feature-maturity.md
- https://learn.chatgpt.com/llms.txt and https://developers.openai.com/codex/llms.txt (doc indexes)
- https://learn.chatgpt.com/docs/changelog (HTML; `.md` twin returns 404) — release notes quoted in §1.5 and §2.6

Source (first party, pinned):

- `openai/codex` @ `a45b8ccb016fb74f63a6bc29e701568e387cbe38` (2026-10-16), paths:
  - `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
  - `codex-rs/core/src/tools/handlers/multi_agents.rs`
  - `codex-rs/core/src/tools/handlers/multi_agents/{spawn,send_input,wait,close_agent,resume_agent}.rs`
  - `codex-rs/core/src/agent/child_config.rs`
  - `codex-rs/core/src/agent/control.rs`
  - `codex-rs/core/src/agent/control/interrupt.rs`
  - `codex-rs/core/src/agent/control/legacy.rs`
- `openai/openai-agents-python` @ `17d994bd3045dae71acda676a4ef4762ed8ecd94` (2026-10-15): `docs/multi_agent.md`

Worker-only failed URL: https://help.openai.com/en/articles/10169521-projects-in-chatgpt (HTTP 403). Parent retrieved https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt and https://help.openai.com/en/articles/11752874-chatgpt-agent via configured web access; see §1 supplement.

Additional re-fetch for this study: `codex-rs/core/src/agent/control.rs` at `7ae831991792744434027c431dfbc7e81dd5c12c` (the pin of [codex-lifecycle-semantics.md](codex-lifecycle-semantics.md)), retrieved directly from `raw.githubusercontent.com` on 2026-10-16 — used for the two-pin completion-watcher evidence in §2.4.

Prior local studies this file supersedes for OpenAI behavior: [codex-subagents-research.md](codex-subagents-research.md) (pinned `922510f4`, 2026-10-15) and [codex-lifecycle-semantics.md](codex-lifecycle-semantics.md) (pinned `7ae83199`). Their conclusions are consistent with the newer pin; this file adds the current doc surface, the two-pin completion-notification evidence in `control.rs`, the docs-vs-source distinction, and the explicit unknown list.
