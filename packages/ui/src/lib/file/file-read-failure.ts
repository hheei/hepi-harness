/**
 * One failed file read, as the surface that asked for it states it.
 *
 * The file surface reads in one place — the viewer's `files.read` through {@link ./file-seam.ts} — and every failure of
 * that read becomes this small value, so the viewer offers one set of actions for all of them rather than a special
 * case per answer. The cause is already on the wire: the surface's own status and code say whether the host is gone,
 * the path was refused, the file is not there any more, or the operation itself failed, and those are three different
 * next steps for the person reading the screen.
 *
 * It is deliberately not a copy of the error. A thrown read carries the surface's own words and may carry the host's
 * diagnostics; the raw reason is kept in `detail` for a log and no panel renders it — the panel shows a sentence this
 * client owns, so a host's own path never reaches the screen.
 */
export type FileReadFailure = {
  /**
   * `missing`: the surface answered `not_found` — a file deleted or moved after the tree was listed. Retrying the same
   * read cannot bring it back, so the valid move is to reload the folder.
   * `denied`: the host refused the path (`path_denied`), which is its confinement speaking and not a lost read.
   * `offline`: the host serving the workspace could not be reached. Retrying is the honest next step.
   * `failed`: the workbench exists and did not complete — anything else.
   */
  readonly kind: "missing" | "denied" | "offline" | "failed";
  /** The surface's own words, for a log. Never rendered: they may carry a host path. */
  readonly detail?: string;
};

/** The status one thrown read carried, when it carried one. */
function statusOf(error: unknown): number | undefined {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : undefined;
}

/** The surface's own code one thrown read carried, when it carried one. */
function codeOf(error: unknown): string | undefined {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The message of one thrown read, as a log line. */
function messageOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return error === undefined ? undefined : String(error);
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message !== "" ? message : undefined;
}

/**
 * Classify one failed file read.
 *
 * The named codes come first because they are the surface's own vocabulary: `not_found` is a file that is gone,
 * `path_denied` is the host's confinement, and `gateway_offline` is a host that did not answer. The status stands in
 * where a nameless answer must still be told apart — a `404`, a `403` and a `503` are those same three facts.
 */
export function classifyFileReadFailure(error: unknown): FileReadFailure {
  const detail = messageOf(error);
  const failure = (kind: FileReadFailure["kind"]): FileReadFailure => (detail === undefined ? { kind } : { kind, detail });
  const code = codeOf(error);
  const status = statusOf(error);
  if (code === "not_found" || status === 404) return failure("missing");
  if (code === "path_denied" || status === 403) return failure("denied");
  if (code === "gateway_offline" || status === 503) return failure("offline");
  return failure("failed");
}

/** The i18n key naming one failure, in the file panel's own words. */
const FAILURE_KEYS: Record<FileReadFailure["kind"], string> = {
  missing: "files.readMissing",
  denied: "files.readDenied",
  offline: "files.readOffline",
  failed: "files.readFailed",
};

export function fileReadFailureKey(failure: FileReadFailure): string {
  return FAILURE_KEYS[failure.kind];
}

/**
 * Whether a Retry is the honest next step. A host that never answered can answer; a path it refused will be refused
 * again, and a file it says is gone needs the folder reloaded rather than the same read repeated.
 */
export function fileReadFailureRetryable(failure: FileReadFailure): boolean {
  return failure.kind === "offline" || failure.kind === "failed";
}
