import { reduceSseFrame, type SessionState } from "@hepi/session";
import type { SubmissionProjection } from "@hepi/protocol";

/**
 * A conversation stream folded the way a client folds it, for tests that read a transcript off the wire.
 *
 * The stream states its window once, at the baseline, and every later frame carries only what it appended. A test
 * that reads entries out of a `state` frame therefore has to fold the frames the way a real client does — which is
 * what this does, through the **shared reducer a real client uses** (`@hepi/session`), so a test and the browser
 * cannot disagree about the rule: a frame with `entries` is the window, a frame with `appended` extends what is held
 * and is then pruned to the frame's own `oldestEntryId`.
 *
 * The entry type is the caller's — a test declares the fields it reads — and every scalar rides the folded frame the
 * way it rides the wire, so a test can assert on the lifecycle facts beside the entries.
 */
export type HeldWindow<E> = {
  protocol: "hepi.v1";
  conversationId: string;
  entries: E[];
  revision: number;
  busy: boolean;
  partial: string;
  oldestEntryId: string | null;
  hasMore: boolean;
  projectionId?: string;
  workspaceId?: string;
  run?: null | { readonly inputs: readonly string[] };
  submissions?: readonly SubmissionProjection[];
  liveTools?: readonly { readonly callId: string; readonly name: string; readonly status: string; readonly output?: string }[];
  queuedMessages?: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
};

export function streamFolder<E>(conversationId: string): { fold: (event: string, data: unknown) => HeldWindow<E>; current: () => HeldWindow<E> } {
  let state: SessionState = { protocol: "hepi.v1", conversationId, revision: 0, entries: [], partial: "", busy: false };
  let workspaceId: string | undefined;
  const held = (): HeldWindow<E> => {
    // The reducer spreads the frame it folded, so the scalars beside the window are the frame's own. `resyncRequired`
    // is the client's own signal that it cannot continue, not a scalar of the frame, so it is not carried here.
    const { resyncRequired: _resync, ...scalars } = state as unknown as Omit<HeldWindow<E>, "entries" | "oldestEntryId" | "hasMore" | "workspaceId"> & { resyncRequired?: boolean };
    return {
      ...scalars,
      entries: state.entries as unknown as E[],
      oldestEntryId: state.oldestEntryId ?? null,
      hasMore: state.hasMore === true,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    };
  };
  return {
    current: held,
    fold(event: string, data: unknown): HeldWindow<E> {
      const carried = data as { workspaceId?: unknown } | null;
      if (typeof carried?.workspaceId === "string") workspaceId = carried.workspaceId;
      state = reduceSseFrame(state, event, data);
      return held();
    },
  };
}
