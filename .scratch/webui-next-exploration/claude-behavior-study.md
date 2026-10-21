# Claude multi-agent / multi-conversation behavior — primary-source study

Access date: **2026-10-16** (system date). All pages fetched from official docs on that date, as
`*.md` where the site serves it. Method: fetch official page, quote, cite URL. No secondary
write-ups. Documented facts are marked **D**; things the docs do not state are marked **U**
(unknown internals).

## 0. Sources fetched (official only)

| Page | URL |
| --- | --- |
| Cross-session messaging | https://code.claude.com/docs/en/cross-session-messaging |
| Subagents | https://code.claude.com/docs/en/sub-agents |
| Agent teams | https://code.claude.com/docs/en/agent-teams |
| Run agents in parallel | https://code.claude.com/docs/en/agents |
| Agent view (background sessions) | https://code.claude.com/docs/en/agent-view |
| Projects (Claude Code, public beta) | https://code.claude.com/docs/en/claude-projects |
| Sessions (resume / branch) | https://code.claude.com/docs/en/sessions |
| Interactive mode (Esc, queue, /btw) | https://code.claude.com/docs/en/interactive-mode |
| Tools reference (Agent, SendMessage, TaskStop, ListAgents) | https://code.claude.com/docs/en/tools-reference |
| CLI reference (`--fork-session`, `--resume`) | https://code.claude.com/docs/en/cli-reference |
| Agent SDK — subagents | https://code.claude.com/docs/en/agent-sdk/subagents |
| Agent SDK — sessions (continue/resume/fork) | https://code.claude.com/docs/en/agent-sdk/sessions |
| Claude apps: What are projects | https://support.claude.com/en/articles/9517075-what-are-projects |
| Claude apps: Create and manage projects | https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects |

Also fetched but not central: hooks, skills, slash-commands, headless, checkpointing, settings,
sandboxing, claude-code-on-the-web, channels, errors, cost-tracking, sdk overview/typescript/python.

## 1. Definitions (the docs' own vocabulary)

- **Subagent** — "Delegated workers inside one session that do a side task in their own context and
  return a summary" (`agents`). Spawned by the `Agent` tool.
- **Fork / forked subagent** — "a subagent that inherits the entire conversation so far instead of
  starting fresh" (`sub-agents`, "Fork the current conversation"). Started by Claude (fork mode) or
  by you with `/subtask`.
- **Agent team / teammate** — "Separate Claude Code instances that each work on assigned tasks" with
  a shared task list and a mailbox; one session is the **team lead** (`agent-teams`, Architecture).
  Experimental, off by default (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
- **Background session / agent view** — a full Claude Code conversation run by a separate
  *supervisor process* so "you can close agent view, close your shell, or start a new interactive
  session and your dispatched work keeps going" (`agent-view`).
- **Project / thread** (Claude Code, public beta) — "A project is one coordinating conversation with
  Claude plus the threads it starts to do the work… **Threads**: the workers. Each is a separate
  session with its own context window that does one piece of work and reports back to the
  conversation when it finishes" (`claude-projects`).
- **Cross-session messaging** — `SendMessage` / `ListAgents` between *your own* sessions;
  "A message is a piece of text one Claude writes to another, never the sender's conversation
  history or files" (`cross-session-messaging`).

**D**: the docs treat "session" as the durable unit (transcript + ID), and "agent" as a worker
inside or alongside a session. **U**: no doc defines a shared internal runtime object across these
surfaces; each surface names its own mechanism (Agent tool, mailbox files, Unix socket).

## 2. Surface matrix

| Surface | Context at start | Coordination | Lifetime | Talks to |
| --- | --- | --- | --- | --- |
| Subagent (non-fork) | **Fresh** context | Parent manages | One run; resumable by ID/name | Parent only (plus named siblings, see §5) |
| Fork | **Full parent history** | Parent manages | Background run | Parent |
| Agent team teammate | Fresh + spawn prompt | Shared task list + mailbox | Session-scoped; not restored by `/resume` | Any teammate by name, lead |
| Background session | Fresh (or resumed) | You / supervisor | Supervisor process; survives closing the UI | Other sessions via cross-session messaging |
| Project thread (beta) | Project instructions/memory/repos | Coordinating conversation | Cloud, survives laptop closed | Reports to the project conversation |
| Other local session | Own | You | Own process | `SendMessage` over socket |

## 3. Fresh vs fork context

**D** (`sub-agents`, "What loads at startup"): "Each subagent starts with a fresh, isolated context
window. It doesn't see your conversation history, the skills you've already invoked, or the files
Claude has already read… The exception is a fork, which inherits the parent conversation instead of
starting fresh."

Fork vs non-fork table (`sub-agents`): Context "Full conversation history" vs "Fresh context with
the prompt you pass"; System prompt/tools "Same as main session" vs "From the subagent's definition
file"; Model "Same as main session" vs definition's `model`; "Prompt cache: Shared with main
session" vs "Separate cache".

A fork also has a **fidelity ceiling**: "A fork can't spawn further forks." (`sub-agents`)

Agent teams: "A teammate also receives the spawn prompt from the lead. **The lead's conversation
history does not carry over.**" (`agent-teams`, Context and communication)

**U**: whether a fork's inherited history is copied or shared by reference; docs only say the fork's
tool calls "stay out of your conversation and only its final result comes back".

## 4. Foreground vs background

**D** (`sub-agents`): "**Foreground subagents** block the main conversation until complete…
**Background subagents** run concurrently while you continue working."

Selection order, first match wins:
1. teammate-spawned subagent → foreground (teammate's own background work "can't outlive the lead's
   process"; `background: true` is refused with an error).
2. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` → foreground everywhere.
3. Fork mode on (default in interactive sessions) → **background**, and "Claude Code also removes the
   Agent tool's `run_in_background` parameter, so Claude can't ask for the foreground."
4. Fork mode off (`-p`, Agent SDK by default) → background by default, foreground when Claude needs
   the result first; frontmatter `background: true` pins background.

Background subagents "run with a smaller built-in tool set than foreground subagents, except for
conversation forks and resumed foreground subagents", and "surface every permission prompt in your
main session" (Esc there "deny[s] that one tool call without stopping the subagent").

Results: "A background subagent's results reach Claude as a completion notification in a later turn."
A backgrounded Bash command that outlives a turn notifies the subagent when it ends.

## 5. Message delivery and auto-wake

**D** (`cross-session-messaging`, "Message delivery"):
- "The receiving Claude reads the message between tool calls during an active turn, so a running
  tool is never interrupted. **When the receiving session is idle, Claude Code starts a new turn
  with the message.**"
- Message is "plain text"; `@` mentions in it attach nothing.
- Three receive outcomes: "**Delivered** … **Held**: Claude Code sets the message aside undelivered.
  A held message reaches Claude only when you approve it or a later mode or settings change allows
  it. **Refused**: Claude Code drops the message without delivering it."
- Once delivered, "the message counts toward usage like a prompt you type".

**Idle subscription (auto-wake with subscription)**: `SendMessage`'s `notify_when_idle` input.
"On its own, Claude Code subscribes without starting a turn or spending tokens in the watched
session, and sends the notice right away if that session is already idle." "If the asking session is
idle, Claude Code starts a new turn with the notice." Scope limits (documented): "Only the Claude in
your main conversation can subscribe, and only to your sessions on this machine. When Claude asks for
a notice from any other target, such as a teammate, a subagent, or a session beyond this machine,
Claude Code refuses the whole call." Subscription expires after 12 hours.

**Agent teams**: "**Automatic message delivery**: when teammates send messages, they're delivered
automatically to recipients. The lead doesn't need to poll for updates." "**Idle notifications**:
when a teammate finishes and stops, it automatically notifies the lead and includes its final answer
in the notification." Also: "A message from the lead or another teammate wakes an in-process teammate
that is waiting to retry a failed API request."

**Subagent-to-subagent**: a subagent that has `SendMessage` can message a named sibling; "the
resumed agent then reports back to the subagent that resumed it, not to your main conversation. That
subagent waits for the result before finishing its own work. When a subagent messages an agent it
reports to, such as its own launcher, Claude Code resumes that agent without redirecting its
results." A subagent sees a "**Sibling roster**: a system reminder listing `main` and every other
named agent in the session… It is a snapshot taken when the subagent starts, so agents named later
don't appear."

**Loop safety**: "Message loops are throttled: in the receiving session, Claude Code rate-limits
repeated messages per sender, drops identical repeats arriving within a short window, and queues at
most 50 accepted messages for Claude to read."

## 6. Stop / cancel semantics (parent vs child)

Documented, and these are **distinct** mechanisms:

| Action | Effect | Source |
| --- | --- | --- |
| `Esc` in a session | "Interrupt Claude, or close a dialog… Stop the current response or tool call mid-turn so you can redirect. Claude keeps the work done so far." Queued messages then send. On a permission prompt, declines. | `interactive-mode` |
| `Ctrl+X Ctrl+K` (twice in 3s) | "Stop all running background subagents in this session" | `interactive-mode` |
| `x` in subagent panel | "Stop the selected fork if it's running, or dismiss its row" | `sub-agents` |
| `TaskStop` (tool) | "Stops a running background task by ID. It also accepts an agent-team teammate or a named background agent by agent ID or name." | `tools-reference` |
| `x` in `/tasks` or SDK `stop_task` | A subagent stopped this way **doesn't auto-resume** | `sub-agents` |
| `/stop` reply in agent view | "A reply that is exactly `/stop`: stops the session at once instead of being delivered to it" | `agent-view` |
| `Ctrl+X` / `claude stop` | Marks a background session `Stopped` (grey), distinct from `Completed` | `agent-view` |

Stopping a *background session* is not durable-loss: "If the minute passes first, the sessions stop,
but their saved conversations stay on disk: attach or reply to a session and it restarts from its
saved conversation." Machine shutdown: "Shutting down still stops running sessions" — the docs give a
recovery path, not an uninterrupted-durability guarantee.

**Important negative (must not be blurred):** the docs never state that pressing `Esc`/Stop, or
`TaskStop`, sets a session's `crossSessionInbound` value to `hold`. `hold` is documented purely as a
**configuration** value (`crossSessionInbound`: `accept` | `hold` | `refuse`, plus a permission-mode
derived default). "Beyond editing a settings file, you can select the value in the `/config` row
**Messages from your other sessions**." A held message is "set aside undelivered… only when you
approve it or a later mode or settings change allows it". So: **Stop ≠ hold**; the two are separate
concepts and the docs establish no link. (U: any internal coupling.)

Held-message expiry: interactive sessions open an approval dialog with a `dialogExpiry` deadline
("defaults to five minutes"); a `-p` session can't show the dialog and drops default-held messages
past the deadline; "A message held by an explicit `hold` setting doesn't expire". Cap: "Claude Code
holds at most 100 messages, and past that drops the oldest."

## 7. Resume / reuse

**Subagents** (`sub-agents`, "Resume subagents") — precise, and the parent's verified reading:
- "Each subagent invocation creates a new instance rather than continuing an earlier one."
- Resumed subagents "retain their full conversation history, including all previous tool calls,
  results, and reasoning"; they resume "in the background without a new `Agent` invocation".
- "The same applies to a subagent that Claude stopped with the `TaskStop` tool, **once its stopped run
  has exited**."
- "A subagent **you** stopped yourself, with `x` in `/tasks` or an SDK `stop_task` request, doesn't
  auto-resume. If Claude sends it a message, **the message is refused** and Claude is told the agent
  was cancelled."
- "While that subagent's row is still in the subagent panel, type into its transcript to resume it
  yourself. **After that, a message from Claude can auto-resume it again.**"
- "Resuming starts a new run of the agent under the same ID."
- Name safety: "`SendMessage` checks that a name still refers to the same agent it reached earlier…
  If a newer agent has taken the name… Claude Code refuses the send rather than delivering it to the
  wrong agent… The check is scoped to the current conversation and resets on `/clear`."
- One-shot agents: "The built-in Explore and Plan agents are one-shot and return no agent ID, so
  Claude can't resume them."
- Transcripts persist per session at `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.

**Teammates**: "When Claude messages an in-process teammate that is no longer running, Claude Code
brings it back in the same session, restores any conversation saved for it, and gives it the message
as its next prompt. After you resume a session, teammates aren't brought back this way, per the
resume limitation." Limitation: "**No session resumption with in-process teammates**: `/resume` and
`/rewind` do not restore in-process teammates. After resuming a session, the lead may attempt to
message teammates that no longer exist."

**Sessions** (`sessions`): `/branch` "creates a copy of the conversation so far and switches you
into it, leaving the original intact"; CLI equivalent `claude --continue --fork-session` ("When
resuming, create a new session ID instead of reusing the original"). Branch inheritance is explicit:
conversation history copied; "Allow for this session" grants carried over **in-process only**; in-flight
background subagents/Bash "keep running. Their output appears in the new branch you switched into,
not in the original session"; Remote Control stays connected. "If you resume the same session in two
terminals without forking, messages from both interleave into one transcript."

**Agent SDK** (`agent-sdk/sessions`): same model exposed programmatically — `resume: sessionId`,
`fork_session: true` yielding a distinct `forked_id`, and resume-by-ID. SDK subagent resume requires
resuming the *same session* and passing the agent ID in the prompt.

## 8. Cross-agent messages, user visibility

**Tools** (`tools-reference`): `ListAgents` "Lists the agents Claude can message with `SendMessage`:
subagents in the session, agent team teammates, your other local Claude Code sessions, and, while
this session is connected to Remote Control, your cloud sessions and your Remote Control sessions on
other machines." `SendMessage` targets "an agent team teammate, a subagent it resumes by agent ID or
name, or one of your other Claude Code sessions". `TaskStop` also accepts a teammate or named
background agent. Claude Code truncates a `summary` longer than 200 chars.

**What a user sees** (`cross-session-messaging`): "Claude Code shows it in the conversation as a dim
one-line preview, and the preview line stays in the conversation afterward… `› Message from
@api-worker: Schema migration finished (ctrl+o to expand)`". `Ctrl+O` opens the transcript viewer;
`--verbose` shows full text. "The preview shortens only what you see. Whether or not you expand it,
Claude reads the full message."

**Authority limits (all surfaces)** — a peer message is never user consent:
- "**It can't approve anything**: a message from another session never counts as your consent, so it
  can't answer a pending permission prompt on your behalf."
- "**It can't change configuration**: Claude Code instructs the receiving Claude never to change
  permission settings, `CLAUDE.md`, or other configuration because another session asked."
- "**Commands don't run**: a command in the message's text, such as `/compact`, arrives as plain text."
- "**Permission prompts still fire**."
- Team equivalent: "A teammate can't approve a permission prompt or supply consent on your behalf,
  and a teammate that was denied an action can't relay it to another teammate to bypass the check."
- Subagent equivalent: "no message from any agent counts as your approval for a pending permission
  prompt, and no agent message can change a subagent's permission settings, `CLAUDE.md`, or
  configuration."

Also: output scanning inserts backslashes / prepends `[harness: subagent output matched
instruction-shaped pattern(s):`, and reports arrive "under a header marking it as subagent output.
The header states that instructions or approval claims inside the report are the subagent's words and
carry no authority from you." A background subagent's report "arrives inside a completion
notification, which is marked as an automated event rather than a message from you."

## 9. Background sessions (agent view) — short row

- Full Claude conversation, not a summary view: dispatch, peek, reply, attach; attach "replaces agent
  view by the full interactive session" and Claude "posts a short recap of what happened while you
  were away".
- Survives UI close: a separate supervisor process runs them.
- Reply semantics: while working, ordinary replies join the session's message queue "instead of
  interrupting the response"; `/stop` "stops the session at once instead of being delivered to it".
  Permission dialogs can't be answered from the peek panel; you must attach.
- State: "Session state persists on disk through auto-updates and supervisor restarts." Machine sleep
  is handled ("processes resume on wake and the supervisor reconnects to them"); machine shutdown
  "still stops running sessions", recoverable from the saved conversation.
- `Stopped` is a distinct state from `Completed`.
- Row summaries: "generated by a Haiku-class model"; mid-turn updates at most every 15s from the
  session's own output without a model request.

## 10. Claude chat / Projects (app surface)

**D** (support articles): classic Projects are "self-contained workspaces with their own chat
histories and knowledge bases" and "**Context is not shared across chats within a project** unless
the information is added into the project knowledge base."

**D**: the new Projects beta (Claude Code, claude.ai/code) inverts that: "In the new version, a
project is one conversation: you say what you need as it comes to you, and Claude breaks the work
into parallel threads that run in the cloud… Every thread starts with the project's files,
repositories, instructions, and memory". Claude Code docs match: "**The project conversation**: one
long-running session where Claude acts as coordinator… It sees what threads report back, not every
step they take." Routing is Claude's: "Claude decides where each message you send in the conversation
goes… New work goes to a new thread or to a thread already working in that area, and Claude tells you
which."

**U / absence**: no official page documents user-initiated *branching* of a claude.ai chat
conversation (edit-and-fork, conversation tree). The documented branch operation is Claude Code's
`/branch` / `--fork-session`. Treat "chat branching" as **not documented**, not as "unsupported
forever".

## 11. SDK affordances vs product behavior

- Same conceptual model: programmatic `AgentDefinition`, `resume`, `fork_session`, agent IDs parsed
  from the Agent tool result (`agentId: <id>`), per-message `parent_tool_use_id` / `agent_id` to
  detect subagent output, task events, `stop_task`.
- Differences the docs state: fork mode is **off by default** in `-p` and the Agent SDK; "In
  non-interactive mode with the `-p` flag, including Agent SDK sessions, Claude doesn't spawn
  teammates"; a named subagent stays a subagent there. Nested background subagents behave differently:
  "In non-interactive mode and the Agent SDK, the launching subagent doesn't wait, so a nested
  background subagent that finishes after its launcher has ended reports to your main conversation
  instead."
- Interactive-only affordances: `/subtask`, fork panel, agent panel, `Ctrl+X Ctrl+K`, agent view,
  `notify_when_idle` subscriptions (main conversation only), permission dialogs.
- The cited team-spawn restrictions apply to non-interactive/SDK sessions. They do not establish
  that every cloud execution capability is interactive-only; keep each cloud/API surface separate.

## 12. Unknowns (do not assert)

1. Whether any single internal runtime object backs subagents, teammates, and peer sessions. Docs name
   different mechanisms per surface (Agent tool, mailbox JSON files, Unix socket).
2. Whether `Esc`/Stop/`TaskStop` has any effect on inbound-message admission (`hold`). Docs describe
   `hold` only as configuration/permission-mode-derived.
3. Whether a fork's history is a copy or a reference; whether a fork's later tool results are visible
   to the parent other than its final result (docs: only the final result returns).
4. How "between tool calls" delivery is scheduled internally; what happens if a message arrives while
   the receiver is mid-LLM-stream vs mid-tool.
5. Whether a resumed subagent's "new run under the same ID" shares prompt cache beyond the original
   run's warm cache (docs say the resumed run "can keep reading the prompt cache the original run
   warmed" — not a guarantee).
6. Whether teammates can be durably restored after a process restart (docs: `/resume`/`/rewind` do
   not restore in-process teammates; task list persists, teammates don't).
7. No documented claude.ai chat conversation branching.

## 13. Recommended behavioral model (synthesis, not implementation)

Model the system as **durable sessions + explicit delegation**, not as a pure team/hierarchy:

1. **A session is the unit of identity, transcript, and resume.** Subagents, forks, teammates,
   threads, and background sessions are all *ways to start a session-like worker*; only some have a
   durable identity (session ID, agent ID) and only some survive their parent.
2. **Context acquisition is a deliberate choice, not a default.** Fresh (subagent/teammate/thread) vs
   inherited (fork/`/branch`). Everything downstream — cost, cache reuse, what the worker knows —
   follows from this one decision.
3. **Two independent axes**: (a) *who coordinates* (parent turn vs shared task list vs you), and
   (b) *whether the worker outlives the parent* (foreground blocks, background notifies, supervisor
   survives UI, teammate restoration is explicitly limited).
4. **Delivery is admission-controlled.** Inbound peer messages are accepted / held / refused by
   policy; an accepted message either lands mid-turn (between tool calls) or starts a turn when the
   receiver is idle. Auto-wake without a message exists only as an explicit idle subscription from the
   main conversation to a same-machine session.
5. **Cancellation is per-mechanism and not interchangeable.** Esc interrupts a turn; `x`/stop_task
   marks a child user-cancelled and blocks auto-resume until you manually resume it; `TaskStop`
   stops a run that can still be resumed by message once it has exited; `/stop` on a background
   session stops the session. None of them are documented to alter message-admission policy.
6. **Peer authority is capped.** No message from any agent carries user consent, changes config, or
   executes commands; permissions still prompt.

### Scenarios

| Scenario | Documented behavior |
| --- | --- |
| Parent asks child for work, waits | Foreground subagent blocks; result returns as the Agent tool result |
| Parent starts child and keeps working | Background subagent; result arrives as a completion notification in a later turn |
| Parent messages a finished child | `SendMessage` resumes it in the background under the same ID; result returns to the resumer, not automatically to main |
| User stopped the child (`x`/`stop_task`) | `SendMessage` is **refused** ("the agent was cancelled"); user must resume from the transcript first |
| Child messages a peer child | Allowed if named and it has `SendMessage`; report goes back to the resuming child; launcher-directed messages don't get redirected |
| Other session messages an idle session | New turn starts in the receiver |
| Other session messages a busy session | Delivered between tool calls; running tool not interrupted |
| Receiver policy holds | Message shown, not delivered; released on approval or later `accept`; explicit `hold` doesn't expire |
| Receiver policy refuses | Dropped, nothing delivered, sender may see a refusal |
| Peer asks child to approve a permission | Impossible by design; prompts still fire |
| Session resumed after restart | Transcript restored; teammates not restored; subagent transcripts restored within the session |
| Branch a session | New session ID, copied history, in-flight background work continues and reports into the branch |
| Machine shutdown with background sessions | Sessions stop; saved conversations allow restart-on-attach/reply |

### Limits to design against

- Background subagents get a smaller tool set than foreground ones; teammates cannot spawn background
  subagents at all.
- One team per session, no nested teams, lead fixed, teammates not restorable on resume.
- Fork cannot spawn further forks; fork mode off by default in `-p`/SDK.
- `notify_when_idle` is main-conversation-only, same-machine-only; refuses teammates, subagents, and
  remote targets outright.
- Inbound caps: ~1M characters per same-machine message, burst refusal at the sender, 50 queued
  accepted messages, 100 held messages, 12h subscription expiry.
- Nesting depth default 3, concurrent subagent default 20.
- No documented claude.ai chat branching; no documented durable teammate restore.

## 14. Selected hepi behavior after this study

User confirmed: normally completed children retain their history and can receive follow-up work;
model calls cannot resume user-stopped targets, including agent_send(resume: true). Explicit user
continuation re-enables normal model dispatch. Final child answers are automatically reported by
the framework; proactive contact is for mid-task communication, not a required final return step.
Results may wake a normally idle parent; a user-stopped recipient keeps late reports pending.

These decisions are recorded in the [current design](conversation-api-proposal.md), not evidence
that the complete product is implemented. Claude cross-session hold remains an independently
documented policy: this study does not infer that Claude Stop itself sets that policy.
