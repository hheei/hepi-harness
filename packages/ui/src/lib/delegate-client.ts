/**
 * The browser's two delegation calls, over the connection the page holds.
 *
 * Both are thin: they post the body the Backend's delegation route expects and read the answer it states. No policy is
 * decided here — the definition the user picked decides the configuration and the context strategy, and the Backend
 * resolves the definition, checks the depth and concurrency limits and refuses with its own code and message. A
 * refusal is therefore shown as it arrived rather than rephrased, so an unreachable execution host or an over-limit
 * request says what really happened (spec D11, D12, D15).
 *
 * Both are asked on the connection's own client: the Gateway origin under this page's credential, never the document's
 * own origin — in the App that origin is the bundle and serves neither route.
 */

import type { WorkbenchClient } from "../client";
import type { ExecutionTarget } from "@hepi/session/execution-resources";
import { createConversationControl } from "@hepi/session/control";
import { catalogueRow, type CatalogueEntry } from "./conversation-catalogue";
import { readDelegateRefusal, type DelegateResult } from "./delegate-attempt";

/** One definition the Settings panel and the quick create both list, as the backend's own vocabulary states it. */
export type DelegateDefinition = {
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly enabled: boolean;
  readonly context: string;
  /** The known capability issues the backend parsed; a definition with any is offered as unusable, not hidden. */
  readonly issues: readonly { readonly field: string; readonly code: string; readonly message: string }[];
};

/**
 * The definitions the quick create offers for one execution target, read through the **same** connection seam the
 * Settings panel uses. One document and one validation interface means the definition the quick create runs is the one
 * Settings saved, and a name that Settings would refuse cannot be offered here — on whichever computer the folder
 * names, which is the Backend's binding resolution and not this panel's guess.
 */
export async function listDelegateDefinitions(target: ExecutionTarget): Promise<readonly DelegateDefinition[]> {
  const answer = await target.definitions();
  if (!answer.ok) throw new Error(answer.error.message === "" ? answer.error.code ?? answer.error.kind : answer.error.message);
  return answer.value.definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    scope: definition.scope,
    enabled: definition.enabled,
    context: definition.context,
    issues: [...definition.issues],
  }));
}

/**
 * One delegation: a new child of `delegating`, or one more task for a conversation that already exists.
 *
 * `conversationId` is what tells the two apart — its absence asks for a child, and its presence gives that
 * conversation another task whose report goes back to `delegating`. The Backend owns both operations, and the
 * attempt identity is the caller's, so a retry after a lost answer is answered with the child the first attempt made.
 */
export async function delegateFrom(client: WorkbenchClient, delegating: string, request: {
  readonly requestId: string;
  readonly definition: string;
  readonly task: string;
  readonly conversationId?: string;
}): Promise<DelegateResult> {
  const control = createConversationControl({
    conversationId: delegating,
    basePath: "/api/conversations",
    fetch: (input, init) => client.request(input, init),
  });
  const answered = await control.delegate({
    name: request.definition,
    task: request.task,
    requestId: request.requestId,
    ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
  });
  if (answered.ok) {
    // The operation already reads the answer's two identity spellings into one shape, so the surface reads a child
    // identity whether this request created it or dispatched to one that existed.
    return {
      ok: true,
      answer: {
        childConversationId: answered.value.conversationId,
        dispatchId: answered.value.dispatchId,
        requestId: answered.value.requestId,
        created: answered.value.created,
        ...(answered.value.definition === undefined ? {} : { definition: answered.value.definition }),
        ...(answered.value.displayParentId === undefined ? {} : { displayParentId: answered.value.displayParentId }),
        // The Backend's delegation answer carries the child's own catalogue entry, and the panel opens the child from
        // this row rather than waiting for a list read. It is the same row the catalogue states, so it is projected by
        // the same function the list projects with: the child then arrives with its folder, its Project and its
        // relation, and opening it cannot be read as a move to another workspace. Handing the raw entry on instead is
        // what made a same-workspace delegation look like a folder change and clear the file tabs.
        ...(answered.value.conversation === undefined ? {} : { session: catalogueRow(answered.value.conversation as unknown as CatalogueEntry) }),
      },
    };
  }
  // A refusal is the Backend's own statement; an outcome this caller could not establish is the network's, reported as
  // such so a user can retry the same attempt identity rather than being told the delegation failed.
  return {
    ok: false,
    refusal: answered.kind === "refused"
      ? readDelegateRefusal(answered.body, answered.status)
      : { code: "network_unreachable", message: answered.reason },
  };
}
