# Codex lifecycle semantics — source audit

Product update: hepi-harness now chooses one stop operation that interrupts work while retaining the conversation; parent stop does not cascade to workers. Results are saved independently of wake requests: normal operation may wake an idle recipient; user stop suppresses automatic wake until explicit new input resumes it. Codex close/interrupt distinctions below are source facts, not additional product operations. Current contract: [design proposal](conversation-api-proposal.md).

Research date: 2026-10-16. Primary source fetched at current GitHub HEAD `7ae831991792744434027c431dfbc7e81dd5c12c` (GitHub commits API checked during this research). This updates the earlier comparison pinned to `922510f4`. Static source audit, not an executed Codex integration test.

## Confirmed semantics

1. Ordinary interruption targets a thread current turn. `session/handlers.rs:60-62` routes Op::Interrupt to `Session.interrupt_task`; `session/mod.rs:5347-5353` calls `abort_all_tasks(Interrupted)`. `tasks/mod.rs:564-592` takes that session active turn and aborts it; it does not traverse spawned conversations. `agent/control.rs` sends Op::Interrupt to one named target. This differs from shutting down a subtree.
2. Child work is independently scheduled after successful spawn; normal parent turn completion is not child-thread shutdown. The normal `on_task_finished` path in `tasks/mod.rs:646+` settles that turn and emits its terminal lifecycle. An in-progress spawn cancelled before completion can instead discard the newly admitted child: `agent/control_tests.rs:828`, `cancelled_spawn_after_input_admission_discards_child`. That creation cleanup is not an established-child cancellation policy.
3. V1 close is stronger than interrupt. `agent/control/legacy.rs:49-105` marks the spawn edge closed, then calls `shutdown_agent_tree`; lines 108-127 enumerate live descendants and shut them down. `control_tests.rs:5435` and `5520` cover descendant shutdown. These are live descendants reachable from the runtime spawn tree, not arbitrary reference edges.
4. V2 `interrupt_spawned_agent` does not close the conversation. `agent/control/interrupt.rs:14-52` interrupts the target and treats an unloaded/dead runtime as already interrupted. It rejects the root and self. This source does not establish a blanket sibling prohibition, so the initial scout statement that siblings cannot be stopped was not adopted.
5. Closing the entire runtime tree is a separate action. `thread_manager/shutdown.rs:151-167` fences starts and requests the shared tree runtime shutdown; `agent/control/runtime.rs:297-301` closes admission and mailboxes and cancels the tree shutdown token. This is not equivalent to ordinary user turn interruption.
6. V2 delivery distinguishes QueueOnly and TriggerTurn. Parent completion notifications use non-triggering delivery (`agent/control.rs`, completion watcher, `trigger_turn: false`). A notification therefore is not a promise of starting a new idle-parent turn.

## Mapping to the current hepi-harness design

The selected product contract retains one stop operation: parent completion or ordinary interruption does not implicitly stop independently running workers. Codex subtree shutdown remains a source distinction, not an added product operation. Already-created independent main conversations are outside child cancellation policy. Native task ownership/background settings implement this contract rather than deriving cancellation from the visible tree.

Our backend runs a shared durable Harness; a Web tab closing or one conversation stopping must not close that entire Harness. Codex runtime-tree shutdown is an operation-level analogy, not a direct mapping to `Harness.close()`. The selected design automatically reports final results after the child Submission settles, without requiring contact_conversation or contact_parent. Proactive contact is mid-task communication. Normal completion preserves reusable conversation history; user stop can only be cleared by explicit user continuation. These are design contracts, not claims that the complete product has shipped.

## Primary sources

All links pinned to `7ae831991792744434027c431dfbc7e81dd5c12c`:

- [Interrupt dispatch](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/session/handlers.rs#L60)
- [Session interrupt](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/session/mod.rs#L5347)
- [Turn cancellation and completion](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/tasks/mod.rs#L564)
- [V1 close and subtree shutdown](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control/legacy.rs#L49)
- [V2 target interruption](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control/interrupt.rs#L14)
- [Shutdown tests](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control_tests.rs#L5435)
- [Interrupted spawn cleanup](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control_tests.rs#L828)
- [Tree shutdown admission](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/thread_manager/shutdown.rs#L151)
- [Notification watcher](https://github.com/openai/codex/blob/7ae831991792744434027c431dfbc7e81dd5c12c/codex-rs/core/src/agent/control.rs)
