# Codex subagents: what current Codex actually supports

Research report, read-only. No product edits, tests, builds or graph updates. Question: what does **current Codex**
support for subagents — tools, roles, context inheritance, lifecycle, background completion — across CLI, Web, Cloud and
SDK, and what is worth adopting here given that our subagent support must be an **optional plugin/extension, not
mandatory**.

**Pinned sources.** Docs fetched 2026-10-16: [developers.openai.com/codex/subagents](https://developers.openai.com/codex/subagents)
(markdown at `/codex/subagents.md`), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference.md),
[build plugins](https://learn.chatgpt.com/docs/build-plugins.md), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk.md).
Source: [openai/codex @ `922510f4`](https://github.com/openai/codex/tree/922510f4d7570b42838e015787ed53abfa8761a1) (committed 2026-10-15, from
`api.github.com/repos/openai/codex/commits?per_page=1`); every path below links to that commit.

**Scope boundary.** Our Pi package `../hepi-mono/packages/pi-subagents/` is cited once, only as evidence about
*extension shape*; its tools and semantics are **not** evidence about Codex, and no claim crosses over.

## 1. The tool surface is versioned, and the versions differ in kind

V1 is a namespace — `MULTI_AGENT_V1_NAMESPACE = "multi_agent_v1"`, "Tools for spawning and managing sub-agents."
([spec.rs:14-15](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L14-L15)) — holding `spawn_agent`
([L70](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L70)), `send_input` ([L166](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L166)),
`resume_agent` ([L275](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L275)), `wait_agent`
([L287](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L287)), `close_agent` ([L336](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L336)).
V2 registers plain-name tools: `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `list_agents`
([L315](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L315)), `interrupt_agent` ([L361](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L361)).
The protocol enumerates the union: `CollabAgentTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" |
"closeAgent" | "sendMessage" | "followupTask" | "interruptAgent" | "listAgents"`
([CollabAgentTool.ts](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/app-server-protocol/schema/typescript/v2/CollabAgentTool.ts)).

**Message delivery is where the two versions stop being the same tool set.** V1 `send_input` is
**start-or-steer with an optional interrupt**: its schema takes `target`, `message`/`items`, and
`interrupt` — "True interrupts the current task and handles this message immediately; false or omitted queues it."
([spec.rs:183](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L183)) — and it is described as "Send a
message to an existing agent. Use interrupt=true to redirect work immediately." The handler calls
`local_agent_control.send_input(...)` ([multi_agents/send_input.rs:96-115](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs#L96-L115)),
which routes to `thread.start_or_steer_turn(TurnInputRequest::user_input(input).on_start(start_options))`
([agent/control.rs:137-160](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control.rs#L137-L160)): it starts a turn when the child
is idle and steers it when it is busy, and returns an opaque `submission_id`. V2 splits that one verb in two by
`MessageDeliveryMode` — `QueueOnly` ("Deliver to the mailbox without starting an idle agent") vs `TriggerTurn`
("Deliver to the active turn or start work if the agent is idle")
([agent/types.rs:59-64](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/types.rs#L59-L64)): `send_message` uses `QueueOnly` and
`followup_task` uses `TriggerTurn`, both through one shared handler
([multi_agents_v2/message_tool.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs)). So V1
"queue" is an argument on a start-or-steer tool; V2 makes queueing and turn-triggering separate tools.

Other verbs, per their own spec text: `spawn_agent` "Returns the spawned agent id plus the user-facing nickname when
available." ([L79](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L79)); `resume_agent` — "Resume a
previously closed agent by id so it can receive send_input and wait_agent calls", depth-guarded by
`turn.config.agent_max_depth` with "Agent depth limit reached. Solve the task yourself."
([resume_agent.rs:55-60](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs#L55-L60));
`wait_agent` V1 — "Wait for agents to reach a final status… Returns empty status when timed out. Once the agent
reaches a final status, a notification message will be received containing the same completed status."
([L293](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L293)); `wait_agent` V2 — "Wait for a mailbox
update from any live agent… The wait also ends early when new user input is steered into the active turn"
([L303-312](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L303-L312)), implemented against
`min_wait_timeout_ms` / `max_wait_timeout_ms` / `default_wait_timeout_ms`
([multi_agents_v2/wait.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)); `list_agents` — "List
live agents in the current root thread tree. Optionally filter by task-path prefix."

## 2. Roles and configuration

Docs: built-in agents are `default`, `worker`, `explorer`; custom agents are standalone TOML files under
`~/.codex/agents/` or `.codex/agents/`, requiring `name`, `description`, `developer_instructions`, optionally
`model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`.

**"Reduces capability" needs qualifying: it holds for the permission surface, not for behaviour.** A role can *reduce*
the permission/feature surface — `features.shell_tool`, `features.apps`, `features.plugins`, `features.memories`,
`features.request_permissions_tool` set to `false`, skills disabled via `skills.config` — and cannot override the
parent's `sandbox_mode`, `approval_policy`, `model_provider` or `mcp_servers`. But a role *does* change model,
reasoning effort, summary/verbosity and developer instructions, i.e. it changes what the child does and how, just not
the permissions it may exceed. Model/effort precedence is explicit spawn value → `[agents]` default → parent value,
with a role file's value taking precedence.

Config (`[agents]`): `enabled` (default `true`), `max_concurrent_threads_per_session` (legacy alias
`max_threads`), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message` (default
`true`), `agents.<name>.description`, `agents.<name>.config_file`, `agents.max_depth`. Source defaults:
`DEFAULT_AGENT_MAX_THREADS: Option<usize> = Some(6)` and `DEFAULT_AGENT_MAX_DEPTH: i32 = 1`
([config/mod.rs:255, 265](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/config/mod.rs#L255-L265)), with `agent_max_depth` documented
as "Maximum nesting depth for V1 agent threads. **Ignored by V2**"
([config/mod.rs:975-976](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/config/mod.rs#L975-L976)). Roles load in a separate crate
(`codex-rs/agent-roles/`) and are applied by `apply_role_to_config`
([child_config.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/child_config.rs)), which also gates models:
`model_supports_multi_agent_backend` rejects a preset that disables multi-agent.

The gate for the whole feature is `features.multi_agent` — "stable; on by default", also *pinnable* for managed users.
Codex keeps delegation authorised by prompt, not by flag: the `spawn_agent` description states "Do not spawn
sub-agents unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation, or
parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not
count as permission to spawn." ([spec.rs:728-731](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L728-L731)).

## 3. Context inheritance defaults differ by version

V1 and V2 do **not** default to the same context. V1's `spawn_agent` takes a boolean `fork_context` — "True forks
the current thread history into the new agent; false or omitted starts with only the initial prompt."
([spec.rs:627-630](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L627-L630)). V2 replaces it with
`fork_turns` — "Parent history to inherit. Defaults to `all`; use `none` to start without parent history. Only
`all` and `none` are supported." ([spec.rs:665-667](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L665-L667)),
and the V2 spawn description states the tradeoff explicitly: `fork_turns="none"` "will not pass any surrounding
context to the spawned subagent, which may cause the agent to lack the context it needs to complete its task, whereas
`fork_turns="all"` will provide the subagent with all surrounding context."
([spec.rs:808](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L808)). The default therefore flipped
from **fresh unless asked** to **full history unless asked** — the opposite design pressure from V1. Note also that V2
ties role selection to it: "The selected role applies regardless of how much parent history is inherited."
([spec.rs:661-663](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L661-L663)). Context inheritance is
a *spawn-time* axis and must stay distinct from **reusing an existing worker**, which is `resume_agent` / `send_input`
(V1) or `followup_task` (V2): one decides how much of the parent a new child starts with, the other decides whether a
worker that already has its own context is reused.

## 4. Lifecycle, background completion

A child is a **thread in the parent's tree**: `SubAgentSource` = `"review" | "compact" | { "thread_spawn": {
parent_thread_id, depth, agent_path, agent_nickname, agent_role } } | "memory_consolidation" | { "other": string }`
([SubAgentSource.ts](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/app-server-protocol/schema/typescript/SubAgentSource.ts)); status is
`CollabAgentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound"`
([CollabAgentStatus.ts](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/app-server-protocol/schema/typescript/v2/CollabAgentStatus.ts)).

Spawning is **background by default**: the call returns an id, and the shared spawn description tells the parent to do
"meaningful non-overlapping work immediately" while the child runs, to "call wait_agent very sparingly… only when you
need the result immediately for the next critical-path step", and not to "redo delegated subagent tasks yourself"
([spec.rs:754-760](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L754-L760)). Completion is
**notification-driven and best effort**: `control/completion.rs` documents "Sessions capture terminal state; the
controller owns routing and queue-only delivery. Delivery remains best effort; metrics distinguish queue acceptance from
delivery failure." ([completion.rs:1-6](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control/completion.rs#L1-L6)), and the parent
receives `<subagent_notification>{"agent_path":…,"status":…}</subagent_notification>`
([context/subagent_notification.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/context/subagent_notification.rs)). Idle children are
unloaded with their state preserved ([residency.rs:1-2](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control/residency.rs#L1-L2)),
and interruption visibility is configurable via `agents.interrupt_message`. Cost is **not** per-subagent: rollout
budget is session-wide and off by default (`features.rollout_budget.enabled`); concurrency is the subagent-specific
limit.

## 5. Surfaces differ, and the docs say so per surface

- **CLI, desktop app, IDE extension**: on by default; `/subagents` switches between agent threads and the user can
  steer, stop or close them; an approval request from an inactive agent thread surfaces in the CLI with a source-thread
  label, and in non-interactive runs a fresh-approval action fails and reports back to the parent.
- **Web (ChatGPT Work)**: hosted; the UI shows **read-only** Active/Done lists, with no per-subagent stop or steer.
  Delegation must be asked for at most intelligence levels; `Ultra` may delegate proactively — modelled as
  `MultiAgentMode = { "custom": string } | "explicitRequestOnly" | "proactive"`
  ([MultiAgentMode.ts](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/app-server-protocol/schema/typescript/MultiAgentMode.ts)).
- **Codex Cloud**: the cloud doc page contains no subagent or multi-agent claim at all.
- **SDK**: both SDKs are documented as starting, continuing and resuming **local threads**, with no subagent promise;
  programmatic *observation* exists through app-server collab enums, including
  `SubAgentActivityKind = "started" | "interacted" | "interrupted" | "completed"`
  ([SubAgentActivityKind.ts](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/app-server-protocol/schema/typescript/v2/SubAgentActivityKind.ts)).

## 6. The extension boundary Codex actually has

Codex **did not pluginize subagents**. They are built-in tools behind a stable, default-on feature flag, switchable in
config or pinned by an administrator; roles are configuration files, not installable packages. Its extension seams are
**MCP servers** (configured on the parent, inherited by children), **skills**, **role TOML files** and per-role
capability keys. "Plugins" in these docs are a *ChatGPT* packaging of apps and skills, and `features.plugins` appears
only as a capability a role may disable. Nothing in the sources shows a subagent plugin format. The local shape that
matches "optional, not mandatory" is instead `../hepi-mono/packages/pi-subagents/`: an independent package
(`@hheei/pi-subagents` 0.3.0) declaring `"pi": { "extensions": ["dist/extension.js"] }` and removable.

## 7. Worth adopting, and worth avoiding

Adopt: (1) one tool per lifecycle stage, with `resume_agent` as an explicit *reopen* of a closed child rather than
implicit reuse; (2) distinct delivery intents — "deliver and stay quiet" vs "deliver and work on it"; (3) completion by
notification, with `wait_agent` scarce and time-boxed rather than a polling loop; (4) small numeric defaults (depth 1,
six threads) plus a documented precedence chain for model and effort; (5) declarative role files whose permission
surface can only shrink while their instructions and model may differ; (6) idle-child eviction that preserves state;
(7) interruption visibility as a policy flag; (8) administrative pinning.

Caution: (1) two versions and two namespaces is migration debt, and V2's six plain-name tools are the leaner target;
(2) packaging subagent support as an optional extension changes *whether the tools exist*, not *who authorises
delegation* — Codex answers the latter with a prompt-level prohibition, and that policy question survives any packaging
choice; (3) there is no per-subagent cost cap; (4) surface behaviour is not portable — web panels are read-only and the
Cloud page makes no subagent claim.

## 8. Primary links (pinned `922510f4`)

- [multi_agents_spec.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) — tool schemas, descriptions, V1/V2 spawn guidance, `fork_context` / `fork_turns`.
- [multi_agents/send_input.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs) and [agent/control.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control.rs) — V1 start-or-steer + interrupt.
- [multi_agents_v2/send_message.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/send_message.rs), [followup_task.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs), [message_tool.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs), [agent/types.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/types.rs) — V2 `QueueOnly` / `TriggerTurn`.
- [multi_agents_v2/wait.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs), [multi_agents/resume_agent.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs).
- [agent/control/completion.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control/completion.rs), [residency.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/agent/control/residency.rs) — completion delivery and idle eviction.
- [config/mod.rs](https://github.com/openai/codex/blob/922510f4d7570b42838e015787ed53abfa8761a1/codex-rs/core/src/config/mod.rs) — `DEFAULT_AGENT_MAX_THREADS`, `DEFAULT_AGENT_MAX_DEPTH`, `agent_max_depth` V1-only.
- Docs: [subagents](https://developers.openai.com/codex/subagents), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference.md), [build plugins](https://learn.chatgpt.com/docs/build-plugins.md), [SDK](https://learn.chatgpt.com/docs/codex-sdk.md).
