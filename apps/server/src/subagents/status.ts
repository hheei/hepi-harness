/**
 * One conversation's own execution status, as the child tree shows it.
 *
 * The status is a projection of facts about **that conversation**, and it is stated from the conversation's own state
 * rather than inferred from anything about its parent: a child that is working is working because its own run is in
 * flight, and a child the user stopped is held because its own committed control says so (spec D15). Nothing here reads
 * a parent's busy flag, and nothing here is a second scheduler: every fact is either the published snapshot the
 * conversation already holds or the one live-work read a whole catalogue shares.
 *
 * The vocabulary is deliberately the user's, and it is the smallest set that names a real state:
 *
 * - `running` — the conversation has a live run, or live work in its own **ordinary** scope.
 * - `held` — its committed control is held: the user (or an agent) stopped it and only a trusted continue resumes it.
 * - `stopping` — held, and the stop's ordinary scope has not drained yet, so nothing is admitted until it does.
 * - `waiting-report` — its delegated result is sitting in the delegating conversation's queue, waiting for that
 *   conversation to consume it. It is a fact about the report's own admission, not a guess from a parent being busy.
 * - `blocked` — a live task of this conversation cannot be taken by any definition this build has, with the runtime's
 *   own reason (`missing_task`, `task_too_old`, `migration_failed`). A missing definition is stated, never faked.
 * - `interrupted` — a live task of this conversation was abandoned by a restart, so what it was doing is unknown and
 *   must not be silently replayed (spec D16).
 * - `idle` — none of the above.
 *
 * A **background** task is never "work" here. A child's permanent anchor and a delegation's reporter are background
 * tasks that live for the life of the child, so counting them would show every finished child as running forever — the
 * same mistake the concurrency limit already had to avoid (spec D12).
 */

import type { HarnessInspection, TaskInspection } from "@earendil-works/pi-durable";

/** The states the child tree shows. `idle` is stated rather than omitted, so a surface never invents a default. */
export type ConversationRunState = "running" | "held" | "stopping" | "waiting-report" | "blocked" | "interrupted" | "idle";

/** One conversation's status, with the runtime's own reason when the state has one. */
export type ConversationRunStatus = {
  readonly state: ConversationRunState;
  /** Why, for the states that carry a reason: the runtime's own task reason, never a sentence invented here. */
  readonly reason?: string;
};

/** The facts one status is projected from; every one of them is about the conversation itself. */
export type ConversationRunFacts = {
  /** The native run's own flag, as the published snapshot states it. */
  readonly busy: boolean;
  /** The conversation's committed input control. */
  readonly control: { readonly state: "allowed" | "held" };
  /** The live tasks of this conversation, from the one inspection read a catalogue shares. */
  readonly tasks: readonly TaskInspection[];
  /** Whether the delegating conversation is holding this conversation's report as a queued item. */
  readonly waitingReport: boolean;
};

/** Whether a live task belongs to the conversation's own ordinary scope, which is what a user's stop reaches. */
function ordinary(task: TaskInspection): boolean {
  return !task.record.background;
}

/**
 * Project one conversation's status. The order is the order of the facts that decide what the user is told: a task
 * nobody can take and a task a restart abandoned come first because they are states in which nothing happens on its
 * own, then the control facts, then the work, then the waiting report.
 */
export function projectRunStatus(facts: ConversationRunFacts): ConversationRunStatus {
  const blocked = facts.tasks.find((task) => task.state.kind === "blocked");
  if (blocked !== undefined && blocked.state.kind === "blocked") return { state: "blocked", reason: blocked.state.reason };
  const interrupted = facts.tasks.find((task) => task.record.abortReason === "restart");
  if (interrupted !== undefined) return { state: "interrupted", reason: "restart" };
  const working = facts.busy || facts.tasks.some(ordinary);
  if (facts.control.state === "held") return working ? { state: "stopping" } : { state: "held" };
  if (working) return { state: "running" };
  if (facts.waitingReport) return { state: "waiting-report" };
  return { state: "idle" };
}

/** The live tasks of one conversation, from an inspection the caller already made. */
export function tasksOf(inspection: HarnessInspection, conversationId: string): readonly TaskInspection[] {
  return inspection.tasks.filter((task) => String(task.record.conversationId) === conversationId);
}
