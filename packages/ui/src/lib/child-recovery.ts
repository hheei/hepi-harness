"use client";

import type { ChildRecoveryFacts } from "@hepi/protocol";
import type { WorkbenchClient } from "../client";
import { createConversationControl } from "@hepi/session/control";

/**
 * The child's recovery facts, read and retried over the **existing** control seam.
 *
 * Both calls are the same ones every other per-conversation operation uses — `@hepi/session/control` over the
 * connection the page holds, never the document's own origin — so this adds no transport, no second API factory and no
 * per-conversation stream: it is one GET, and one POST that carries the identities the GET returned.
 *
 * The retry is deliberately narrow. It sends `requestId` and `failedTaskId` **exactly as the read stated them**, which
 * is what makes it the retry of the failed preparation the delegation seam already supports rather than a new
 * delegation: same child, same dispatch, no second admission, and no automatic attempt anywhere in this module — a
 * caller that wants the facts again asks again.
 */

/**
 * The fence one surface's reads and retries are ordered by: the newest attempt, and nothing older.
 *
 * A read and a retry here are two requests to the same records, and the answers can arrive in either order — a refresh
 * asked while the first read is still in flight, a retry asked while a refresh is, or an answer that arrives after the
 * conversation was left or the connection was replaced. The one that must land is the **newest** decision the user made,
 * so each attempt takes a token, and an answer is published only while its token is still the newest. Releasing the fence
 * (on unmount, another conversation, another connection) invalidates every outstanding token, which is what makes a
 * disposed connection's late answer land nowhere instead of under the next read's name.
 *
 * It holds no data and does nothing on its own: it is the ordering rule the panel already needed, stated once, rather
 * than a second state store beside the facts.
 */
export type ReadFence = {
  /** Take the newest token, superseding every attempt still in flight. */
  begin(): number;
  /** Whether an answer taken under this token is still the one to publish. */
  settled(token: number): boolean;
  /** Invalidate every outstanding token: this surface no longer owns any answer. */
  release(): void;
};

export function createReadFence(): ReadFence {
  let newest = 0;
  return {
    begin: () => (newest += 1),
    settled: (token) => token === newest,
    release: () => { newest += 1; },
  };
}

/** One recovery read's answer: the facts, `null` for "this conversation is no delegation's child", or no answer. */
export type RecoveryRead =
  | { readonly ok: true; readonly facts: ChildRecoveryFacts | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** One retry answer: the child's facts after the write, or the Backend's own refusal. */
export type RecoveryRetry =
  | { readonly ok: true; readonly facts: ChildRecoveryFacts }
  | { readonly ok: false; readonly code: string; readonly message: string };

export async function readChildRecovery(client: WorkbenchClient, conversationId: string): Promise<RecoveryRead> {
  const control = createConversationControl({ conversationId, basePath: "/api/conversations", fetch: (input, init) => client.request(input, init) });
  const answered = await control.recovery();
  if (answered.ok) return { ok: true, facts: answered.value };
  // A refusal keeps the Backend's own code and message; a read that never answered says nothing about the child and is
  // not reported as a state of it.
  return answered.kind === "refused"
    ? { ok: false, code: answered.code, message: answered.message }
    : { ok: false, code: "network_unreachable", message: answered.reason };
}

export async function retryChildPreparation(client: WorkbenchClient, conversationId: string, identities: { readonly requestId: string; readonly failedTaskId: string }): Promise<RecoveryRetry> {
  const control = createConversationControl({ conversationId, basePath: "/api/conversations", fetch: (input, init) => client.request(input, init) });
  const answered = await control.retryPreparation(identities);
  if (answered.ok) {
    // The retry answer always restates the child's facts; `null` there would mean the record moved under the request.
    return answered.value === null
      ? { ok: false, code: "no_delegation", message: "the Backend no longer states a delegation for this conversation" }
      : { ok: true, facts: answered.value };
  }
  return answered.kind === "refused"
    ? { ok: false, code: answered.code, message: answered.message }
    : { ok: false, code: "network_unreachable", message: answered.reason };
}

/**
 * Whether the recovery facts offer a preparation retry: a stated failure the caller has not asked about yet, named by
 * both identities. Nothing else in these facts is retryable — that is the runtime's own predicate, restated here as a
 * condition on the two fields the write takes.
 */
export function retryablePreparation(facts: ChildRecoveryFacts | null): { readonly requestId: string; readonly failedTaskId: string } | null {
  if (facts === null || facts.preparation !== "unretried-failure" || facts.preparationFailedTaskId === undefined) return null;
  return { requestId: facts.requestId, failedTaskId: facts.preparationFailedTaskId };
}

/**
 * One row **per object**, in the order a reader acts on them: what the delegation's record says about its preparation,
 * then where this dispatch's report stands, then the anchor's own phase (the audit's G2, as a surface).
 *
 * The three are never merged: collapsing "preparation failed" and "reporter pending" into one child status is the
 * aggregate this projection exists to avoid. The Backend's own reason and outcome strings are shown beside their names
 * rather than paraphrased, and a word this build has no translation for is passed through by name, so a runtime that
 * grows a phase is still stated rather than dropped.
 */
export function childRecoveryWords(facts: ChildRecoveryFacts, t: (key: string) => string): readonly { readonly id: string; readonly text: string }[] {
  const word = (prefix: string, value: string | undefined): { readonly id: string; readonly text: string } | undefined => {
    if (value === undefined) return undefined;
    const key = prefix + "." + value;
    const translated = t(key);
    return { id: key, text: translated === key ? value : translated };
  };
  const words: { readonly id: string; readonly text: string }[] = [];
  const preparation = word("childRecovery.preparation", facts.preparation);
  if (preparation !== undefined) words.push({ ...preparation, text: facts.preparationOutcome === undefined ? preparation.text : preparation.text + " · " + facts.preparationOutcome });
  const delivery = word("childRecovery.delivery", facts.delivery);
  if (delivery !== undefined) words.push(delivery);
  const anchor = word("childRecovery.anchor", facts.anchorPhase);
  if (anchor !== undefined) words.push(anchor);
  return words;
}
