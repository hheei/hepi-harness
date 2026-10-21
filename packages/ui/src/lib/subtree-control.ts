/**
 * The browser's subtree control calls, over the connection the page holds.
 *
 * Both are thin: they post what the Backend's subtree route reads and answer what it states. No scope is decided here —
 * the Backend computes the descendant set from durable relations and captures it under the request id, so what this
 * surface can *offer* as a selection is only a proposal and what governs is the capture (spec decisions 2-3). A selection
 * that names anything outside it is refused whole, before anything is written, and that refusal is shown as it arrived.
 *
 * The request identity belongs to the **attempt**, as it does for a delegation or a fork: the Backend answers a repeated
 * id from the capture that id already made, so a retry after a lost answer must carry the same one. That is what keeps a
 * dropped response from stopping a subtree twice, and it is why the identity is minted here and held by the caller that
 * knows which attempts are the same decision.
 *
 * A confirmed decision is one {@link SubtreeAttempt}, and it is what both calls below take: a retry after a lost answer
 * repeats the subset the user approved, not whatever the listing implies at that moment.
 *
 * The answer keeps its two halves apart, which is the whole shape of this operation: `status` is what the request
 * recorded when it reached a child, and the child's `session` row is what it is doing now, in the vocabulary the session
 * list already uses. Neither rewrites the other, so a stop that has drained still reads `stopping` over `held`, a child
 * the user resumed on its own reads `accepted` over `running`, and a child the catalogue does not list — a removed one —
 * states no current row at all rather than one a surface could never show.
 *
 * Both calls go through the connection's own client: the Gateway origin under this page's credential, never the
 * document's own.
 */

import type { CatalogueEntry, CatalogueRow } from "./conversation-catalogue";
import { catalogueRow } from "./conversation-catalogue";
import type { WorkbenchClient } from "../client";
import { createConversationControl, type SubtreeAnswer, type SubtreeControlAction } from "@hepi/session/control";

export type { SubtreeControlAction };

/** One subtree attempt's identity, keyed by the attempt itself. */
export type SubtreeAttempts = Map<string, string>;

/**
 * The key one attempt is held under: the conversation addressed, the action, and the selection.
 *
 * All three, because they are three different decisions: an interrupt is not a stop, and a subtree is not one of its
 * children. A retry of the same decision therefore repeats the same identity and is answered from the same capture,
 * while a changed selection is genuinely a new request the Backend has not governed yet.
 */
export function subtreeAttemptKey(conversationId: string, action: SubtreeControlAction, selected: readonly string[] | null): string {
  return conversationId + ":" + action + ":" + (selected === null ? "*" : [...selected].sort().join(","));
}

/** The identity to send for this attempt: the one already in flight, or a fresh one this call mints and keeps. */
function subtreeRequestId(attempts: SubtreeAttempts, key: string, mint: () => string): string {
  const held = attempts.get(key);
  if (held !== undefined) return held;
  const created = mint();
  attempts.set(key, created);
  return created;
}

/** A request that completed has answered itself; the next decision on that subtree is a new attempt. */
function subtreeSettled(attempts: SubtreeAttempts, key: string): void {
  attempts.delete(key);
}

/**
 * The decision the user confirmed, as one immutable record: what to address, what to do, which children, under which id.
 *
 * A confirmation is the moment the selection becomes a decision, so everything a later send or read needs is captured
 * then and never derived again. A descendant listing is not still — a child finishes and leaves it, another arrives —
 * and a retry that re-read the listing after a lost answer would send a different subset than the one the user approved:
 * narrower than the capture (refused whole as `outside_subtree`), or, if it sent no selection at all, an instruction to
 * the Backend to capture the **whole** subtree, the deliberately excluded children included. Both silently widen a
 * decision that was narrowed on purpose, so the subset travels with the identity rather than next to it.
 */
export type SubtreeAttempt = {
  readonly key: string;
  readonly requestId: string;
  readonly rootId: string;
  readonly action: SubtreeControlAction;
  readonly selected: readonly string[] | null;
};

/**
 * Record one confirmed decision: its identity minted under (conversation, action, selection) and its subset frozen.
 *
 * A decision already in flight — a second confirmation of the same subset, or a retry after an answer that never came —
 * is handed the identity the Backend already captured under, so it cannot control a second subtree. A decision that was
 * settled is not held: see {@link subtreeRelease}.
 */
export function subtreeConfirm(attempts: SubtreeAttempts, decision: {
  readonly rootId: string;
  readonly action: SubtreeControlAction;
  readonly selected: readonly string[] | null;
}, mint: () => string): SubtreeAttempt {
  const key = subtreeAttemptKey(decision.rootId, decision.action, decision.selected);
  return {
    key,
    requestId: subtreeRequestId(attempts, key, mint),
    rootId: decision.rootId,
    action: decision.action,
    selected: decision.selected,
  };
}

/**
 * Release a settled attempt, whichever path settled it: the identity is dropped so the next identical decision is a new
 * capture rather than a replay of a request that already finished.
 *
 * Both of them matter. A write whose answer completed and a **read-back** that states completion are the same fact — the
 * request is over — and a caller that released only on the write path would keep handing the user back a finished
 * capture: the Backend answers a known id from what it recorded, so the panel would display children as controlled while
 * nothing was reached.
 */
export function subtreeRelease(attempts: SubtreeAttempts, attempt: SubtreeAttempt): void {
  subtreeSettled(attempts, attempt.key);
}

/**
 * One child as the panel shows it.
 *
 * `status`/`reason` are the durable outcome the request recorded when it reached this child and `control` is its
 * committed control now; `session` is the child's **current** catalogue row, projected by the same `catalogueRow` the
 * session list and the running poll use, so the row a subtree answer hands the panel cannot disagree with the row the
 * sidebar shows for that conversation. Absent exactly when the Backend states none — a removed child, or one this
 * process holds no attachment for — and a panel that invented a row then would claim a state nobody read.
 *
 * The outcome name is passed through as the Backend states it: an outcome this build has no word for is a new outcome,
 * not a reason to lose a child's answer or to map it onto a nearby one.
 */
export type SubtreeChildView = {
  readonly conversationId: string;
  readonly status: string;
  readonly reason?: string;
  readonly control: { readonly state: string; readonly revision: number };
  readonly session?: CatalogueRow;
};

/** One subtree request as the panel reads it: what it governs, and what each child answered beside its own row. */
export type SubtreeView = {
  readonly requestId: string;
  readonly action: SubtreeControlAction;
  readonly status: "completed" | "pending";
  readonly scope: readonly string[];
  readonly selected: readonly string[] | null;
  readonly children: readonly SubtreeChildView[];
  readonly partial: boolean;
};

/** One subtree call's outcome: the Backend's answer, the refusal it stated, or an answer this caller does not have. */
export type SubtreeResult =
  | { readonly ok: true; readonly view: SubtreeView }
  | { readonly ok: false; readonly refusal: { readonly code: string; readonly message: string } }
  | { readonly ok: false; readonly unknown: true; readonly requestId: string; readonly reason: string };

/** One read-back: the same three outcomes, plus the Backend's own answer to "no such request". */
export type SubtreeReadResult =
  | SubtreeResult
  /** No request under that id captured anything — the Backend's own `unknown_request`, not a failed read. */
  | { readonly ok: true; readonly noRecord: true };

/** One child: its durable outcome, and its current row projected the way the session list projects it. */
function childView(outcome: SubtreeAnswer["outcomes"][number]): SubtreeChildView {
  return {
    conversationId: outcome.conversationId,
    status: outcome.status,
    ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
    control: { state: outcome.control.state, revision: outcome.control.revision },
    ...(outcome.session === undefined ? {} : { session: catalogueRow(outcome.session as CatalogueEntry) }),
  };
}

function view(answer: SubtreeAnswer): SubtreeView {
  return {
    requestId: answer.requestId,
    action: answer.action,
    status: answer.status,
    scope: answer.scope,
    selected: answer.selected,
    children: answer.outcomes.map(childView),
    partial: answer.partial,
  };
}

function failure(answered: { kind: "refused"; status: number; code: string; message: string } | { kind: "unknown"; requestId: string; reason: string }): SubtreeResult {
  if (answered.kind === "unknown") return { ok: false, unknown: true, requestId: answered.requestId, reason: answered.reason };
  return { ok: false, refusal: { code: answered.code === "" ? "HTTP " + answered.status : answered.code, message: answered.message } };
}

/**
 * One subtree request: stop or interrupt the captured subtree the attempt names, or the subset it confirmed.
 *
 * The attempt is the only input: the addressed conversation, the action, the identity and the subset are what the user
 * confirmed, so nothing here consults a listing that may have moved since. The addressed conversation is never included
 * — its own stop is a separate decision, and a subtree control does not cascade into it or into the parent's caller —
 * and no history, relation or tombstone is touched by this call. */
export async function subtreeControlFrom(client: WorkbenchClient, attempt: SubtreeAttempt): Promise<SubtreeResult> {
  const control = createConversationControl({ conversationId: attempt.rootId, basePath: "/api/conversations", fetch: (input, init) => client.request(input, init) });
  const answered = await control.subtreeControl({
    requestId: attempt.requestId,
    action: attempt.action,
    // `null` selection is sent as an omitted field: the Backend's capture governs the whole subtree.
    ...(attempt.selected === null ? {} : { selected: attempt.selected }),
  });
  return answered.ok ? { ok: true, view: view(answered.value) } : failure(answered);
}

/**
 * The durable record of one subtree request, read back under its id.
 *
 * This is the refresh a caller uses to see a race it lost settle, and it is idempotent by construction: it controls
 * nothing and records nothing. `null` is the Backend's own `unknown_request` — no request under that id captured
 * anything. A row the Backend stated no catalogue entry for keeps its outcome and states no current state.
 */
export async function subtreeReadFrom(client: WorkbenchClient, attempt: SubtreeAttempt): Promise<SubtreeReadResult> {
  const control = createConversationControl({ conversationId: attempt.rootId, basePath: "/api/conversations", fetch: (input, init) => client.request(input, init) });
  const answered = await control.subtreeRequest(attempt.requestId);
  if (!answered.ok) return failure(answered);
  if (answered.value === null) return { ok: true, noRecord: true };
  return { ok: true, view: view(answered.value) };
}
