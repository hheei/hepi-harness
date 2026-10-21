/**
 * A read that did not answer, as the surface that asked for it needs to state it.
 *
 * The workbench reads in exactly one place — the conversation hook's `loadSession` and its `loadContext` page read —
 * and every failure of those reads has to become the same small value so the surfaces above them can offer the same
 * recovery. What a reader is told and what a reader may do about it depend on **which** failure it was, and the two
 * facts that tell them apart are already on the wire: a read that never answered, a row the Backend says is gone, and a
 * read the Backend refused are three different states with three different next steps.
 *
 * It is deliberately not a copy of the error. A thrown read carries the Backend's own message, an HTTP status and
 * sometimes an entry id or a byte count, and none of that belongs on screen: the diagnostic is the reader's log, and
 * what the page shows is a sentence it owns. The raw reason is kept in `detail` so a caller can log it, and no surface
 * renders it.
 *
 * A cancelled read is classified rather than reported. Aborting is the surface's own intent — a superseded navigation,
 * a search the reader replaced — so it is a fact about the attempt and never a failure the reader has to answer for.
 */
export type ReadFailure = {
  /**
   * `unreachable`: the read did not answer at all (a lost connection, a Backend that is not up yet, a gateway in
   * between). Retrying is the honest next step because nothing said the read could not succeed.
   * `missing`: the Backend answered `not_found` — the conversation row, or the entry a navigation named, is not there
   * any more. Retrying the same read cannot bring it back, so the surface offers the valid context instead.
   * `refused`: the Backend answered and refused (an unreadable projection, a rejected credential, a bad request).
   * `cancelled`: the caller aborted the read. Not a state to show.
   */
  readonly kind: "unreachable" | "missing" | "refused" | "cancelled";
  /** The raw reason, for a log. Never rendered: it may carry the Backend's own diagnostics. */
  readonly detail?: string;
};

/** The HTTP status one thrown read carried, when it carried one. */
function statusOf(error: unknown): number | undefined {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}

/** The Backend's own code one thrown read carried, when it carried one. */
function codeOf(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** Whether one thrown read is an abort: the caller's own intent, stated by the DOM or by the fetch that honoured it. */
function isAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const named = error as { name?: unknown; code?: unknown };
  return named.name === "AbortError" || named.code === "ABORT_ERR";
}

/** The message of one thrown read, as a log line. An object that states none has none — "[object Object]" is not a reason. */
function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return error === undefined ? undefined : String(error);
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

/**
 * Classify one failed read.
 *
 * The order is the classification: an abort is the caller's own doing whatever status it would have had, a `not_found`
 * is the Backend's statement that the row is gone, and everything else that came back from the Backend — a 4xx or a
 * named refusal — is a refusal. A read with no status at all never reached an answer, which is the case a Retry is for.
 */
export function classifyReadFailure(error: unknown): ReadFailure {
  const detail = messageOf(error);
  if (isAbort(error)) return detail === undefined ? { kind: "cancelled" } : { kind: "cancelled", detail };
  const status = statusOf(error);
  const code = codeOf(error);
  if (status === 404 || code === "not_found") return detail === undefined ? { kind: "missing" } : { kind: "missing", detail };
  // A 4xx is the Backend refusing this read; a 5xx is the Backend failing to answer it, which is the case a Retry can
  // succeed at. Both arrive as a thrown read, so the status is what tells them apart.
  if (status !== undefined && status >= 400 && status < 500) return detail === undefined ? { kind: "refused" } : { kind: "refused", detail };
  return detail === undefined ? { kind: "unreachable" } : { kind: "unreachable", detail };
}

/**
 * The sentence a surface shows for one failure. A table rather than a chain, so a new kind is a compile error here
 * instead of a reader seeing a translation key where a sentence belongs.
 */
const FAILURE_KEYS: Record<ReadFailure["kind"], string> = {
  unreachable: "chat.readUnreachable",
  missing: "chat.readMissing",
  refused: "chat.readRefused",
  cancelled: "chat.readCancelled",
};

/** The i18n key naming one failure. */
export function readFailureKey(failure: ReadFailure): string {
  return FAILURE_KEYS[failure.kind];
}

/**
 * Whether a Retry is the honest next step. A read that never answered can answer; one the Backend says is gone, or
 * refused, will answer the same way, so the surface offers the valid context instead of a button that cannot work.
 */
export function readFailureRetryable(failure: ReadFailure): boolean {
  return failure.kind === "unreachable";
}
