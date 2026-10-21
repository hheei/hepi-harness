import type { ReferenceOutcome, ResolvedReference } from "@hepi/protocol";
import type { NavigationOutlinePage } from "@hepi/protocol/navigation";
import type { OperationResult } from "@hepi/session/control";

/**
 * What a reference surface decides, as one module rather than as lines inside a panel.
 *
 * A reference is a pointer the Backend's own owner stores and validates (cross-session references, decisions 1, 5, 6),
 * so everything this side does with one is a *reading* of that answer: which named state to show, whether a follow may
 * open anything at all, and whether a failed write states one of the Backend's names. Keeping that in one place is what
 * makes "no silent nearest-entry landing" checkable — a follow decision is a value here, not a branch a component
 * happens to take.
 *
 * Nothing here copies target content, keeps a reference cache, or invents an entry identity: an entry option is an
 * anchor the owning history surface already issued (the paged outline), and a follow hands the target's own
 * `conversationId`/`entryId` to the shell's existing navigation seam.
 */

/** Every named outcome a reference can carry, in the order a surface lists them. */
export const REFERENCE_OUTCOMES: readonly ReferenceOutcome[] = [
  "target-missing",
  "target-unavailable",
  "entry-missing",
  "entry-out-of-scope",
  "stale",
  "error",
];

/** The sentence a surface shows for one outcome: the outcome's own name, looked up rather than mapped to a neighbour. */
export const referenceOutcomeKey = (outcome: ReferenceOutcome): string => "references.outcome." + outcome;

/**
 * Whether retrying can change this outcome.
 *
 * `error` is the read itself failing, so nothing about the reference was established and a second read may establish
 * it. Every other name is a fact the Backend already stated — a target that is gone stays gone, an entry that is not in
 * that history is not in it — and a Retry there would be a button that cannot work.
 */
export const referenceOutcomeRetryable = (outcome: ReferenceOutcome): boolean => outcome === "error";

/** One reference's identity: target plus entry, which is also the Backend's own idempotency key. */
export const referenceKey = (reference: { readonly conversationId: string; readonly entryId?: string }): string =>
  reference.conversationId + ":" + (reference.entryId ?? "");

/**
 * What following one reference may do.
 *
 * `open` is a navigation the shell performs through the history owner's bounded target coordinator: a conversation
 * reference opens the conversation, and an entry reference names the one entry to land on. `refuse` is the honest
 * alternative — a stored reference the Backend reports as unresolvable opens nothing, because opening the nearest
 * surviving view would be the silent substitute the spec forbids.
 */
export type ReferenceFollow =
  | { readonly kind: "open"; readonly conversationId: string; readonly entryId?: string }
  | { readonly kind: "refuse"; readonly outcome: ReferenceOutcome };

export function referenceFollow(reference: ResolvedReference): ReferenceFollow {
  if (reference.outcome !== undefined) return { kind: "refuse", outcome: reference.outcome };
  return reference.entryId === undefined
    ? { kind: "open", conversationId: reference.conversationId }
    : { kind: "open", conversationId: reference.conversationId, entryId: reference.entryId };
}

/**
 * Whether an unresolvable reference still names a conversation worth opening.
 *
 * A target that does not exist and a target that was removed have nothing behind them, so offering their view would be
 * a dead control. A missing, out-of-scope or stale *entry* leaves a readable conversation behind it, and opening that
 * conversation — without an entry, so nothing is pretended to be the target — is the actionable next step.
 */
export const referenceTargetOpenable = (outcome: ReferenceOutcome): boolean =>
  outcome === "entry-missing" || outcome === "entry-out-of-scope" || outcome === "stale";

/**
 * The offers one unresolvable reference carries.
 *
 * They are derived from the outcome rather than chosen by whoever renders it, so a control that cannot work cannot
 * appear and a state that needs a way forward cannot lose one: a retry only where the read left the answer open, a view
 * of the target only where a target survives, and the raw-history offer only when an entry was named — the raw read is
 * addressed by an entry, so offering it for a conversation-only link would open an empty panel.
 */
export type ReferenceOffers = {
  readonly retry: boolean;
  readonly openTarget: boolean;
  readonly openRaw: boolean;
};

export function referenceOffers(outcome: ReferenceOutcome, reference: { readonly entryId?: string }): ReferenceOffers {
  const survives = referenceTargetOpenable(outcome);
  return {
    retry: referenceOutcomeRetryable(outcome),
    openTarget: survives,
    openRaw: survives && reference.entryId !== undefined,
  };
}

/** What one reference write answered: the stored list, or the named reason it was refused. */
export type ReferenceWrite =
  | { readonly ok: true; readonly references: readonly ResolvedReference[] }
  | { readonly ok: false; readonly outcome: ReferenceOutcome };

/**
 * Read one `addReference` answer as a named state.
 *
 * A refusal arrives with the Backend's outcome as its own code (ticket 01 relays it unchanged), so it is read here
 * rather than paraphrased: a code this vocabulary does not know is the `error` state — a write whose result could not
 * be established — and never a success. A write whose answer never arrived (`unknown`) is the same state for the same
 * reason, and the retry it offers is safe because creation is idempotent by target plus entry.
 */
export function referenceWrite(result: OperationResult<{ readonly references: readonly ResolvedReference[] }>): ReferenceWrite {
  if (result.ok) return { ok: true, references: result.value.references };
  if (result.kind === "refused" && (REFERENCE_OUTCOMES as readonly string[]).includes(result.code)) {
    return { ok: false, outcome: result.code as ReferenceOutcome };
  }
  return { ok: false, outcome: "error" };
}

/** One entry a picker may offer: an identity the history owner issued, with the preview it stated beside it. */
export type ReferenceEntryOption = { readonly entryId: string; readonly preview: string };

/**
 * The entries a picker offers for one target conversation.
 *
 * They come from the target's own paged outline — the same anchors the history rail lists — so an entry is never typed,
 * guessed or derived from an ordinal: what the picker offers is exactly what the owning history surface said exists.
 */
export function referenceEntryOptions(page: Pick<NavigationOutlinePage, "anchors">): readonly ReferenceEntryOption[] {
  return page.anchors.map((anchor) => ({ entryId: anchor.entryId, preview: anchor.preview }));
}

/**
 * The stored references after one creation, in the order they are shown.
 *
 * The Backend already answered the complete list and keeps idempotency by target plus entry; this only refuses to list
 * one identity twice if a retry and its first answer both land, so a surface cannot show the same link as two.
 */
export function mergeReferenceList(
  current: readonly ResolvedReference[],
  added: readonly ResolvedReference[],
): readonly ResolvedReference[] {
  const listed = new Map<string, ResolvedReference>();
  for (const reference of [...current, ...added]) {
    const key = referenceKey(reference);
    if (!listed.has(key)) listed.set(key, reference);
    else if (reference.outcome !== undefined) listed.set(key, reference);
  }
  return [...listed.values()];
}
