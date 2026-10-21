import type { ImageLease, ResourceReader, ResourceRefusal } from "@hepi/session/resources";

/**
 * The shared workbench's one reading of a read block.
 *
 * A history frame names heavy content by address (`textUrl`, `thinkingUrl`, `toolResultImageUrl`), and the
 * connection's own {@link ResourceReader} is what resolves and fetches it. This module is the small seam between that
 * reader and a React surface, so the two facts every consumer needs live in one place instead of at each call site:
 *
 * - **A refusal is a named value, not an empty failure.** The reader answers `{ ok: false, reason }` and never throws,
 *   so a loader turns it into a {@link ResourceReadError} carrying the reason and a surface names it through
 *   {@link resourceRefusalKey} rather than showing "something went wrong". A surface with no connection at all — one
 *   mounted outside the workbench — is the same kind of answer (`unavailable`), never a relative `fetch` against
 *   whatever origin happens to be rendering.
 * - **An image is a lease with an owner.** {@link openResourceImage} hands the surface a blob URL and returns the
 *   release for it: the caller calls that on unmount or when the address changes, and an answer that arrives after
 *   either one is released instead of published. The blob is therefore revoked when the image leaves the screen or the
 *   connection is replaced, and never outlives the scope that loaded it.
 */

/** Why a read block could not be shown, as the surface that asked for it needs to state it. */
export class ResourceReadError extends Error {
  readonly reason: ResourceRefusal;
  constructor(reason: ResourceRefusal) {
    super(reason);
    this.name = "ResourceReadError";
    this.reason = reason;
  }
}

/** The i18n key naming one refusal. Kept as a table so a new reason is a compile error here, not a blank label. */
const REFUSAL_KEYS: Record<ResourceRefusal, string> = {
  unauthorized: "i18n.resourceUnauthorized",
  forbidden: "i18n.resourceForbidden",
  not_found: "i18n.resourceNotFound",
  oversize: "i18n.resourceOversize",
  unavailable: "i18n.resourceUnavailable",
  disposed: "i18n.resourceDisposed",
};

/** The label for one refusal, for a surface that has to say which one it got. */
export function resourceRefusalKey(reason: ResourceRefusal): string {
  return REFUSAL_KEYS[reason];
}

/**
 * The whole text behind a deferred text or thinking block.
 *
 * The reader follows the block's own bounded pages and keeps its own bounded cache, so a caller asking twice for one
 * block pays for it once and this function adds nothing to remember. A refusal rejects with the reason; a surface that
 * must not act on a preview (copy, edit) refuses instead of proceeding with one.
 */
export async function readResourceText(
  reader: ResourceReader | null,
  address: string,
  options?: { readonly signal?: AbortSignal },
): Promise<string> {
  if (reader === null) throw new ResourceReadError("unavailable");
  const result = await reader.text(address, options);
  if (result.ok) return result.value;
  throw new ResourceReadError(result.reason);
}

/** What an image surface is showing: nothing yet, the leased blob, or the named reason it may show nothing. */
export type ResourceImageState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string; readonly mimeType: string }
  | { readonly status: "refused"; readonly reason: ResourceRefusal };

/**
 * Load one image read block as a blob lease and report the state it reaches.
 *
 * The returned function is the surface's release: it marks this read closed and releases the lease it holds, so it is
 * what an effect cleanup calls on unmount and what a change of address or connection calls before the next read. An
 * answer that arrives after the release is released too — a lease handed to a surface that already left is a blob
 * nobody would ever revoke — and it is never published into the state of the surface that stopped asking.
 */
export function openResourceImage(
  reader: ResourceReader | null,
  address: string,
  onState: (state: ResourceImageState) => void,
  options?: { readonly signal?: AbortSignal },
): () => void {
  let closed = false;
  let lease: ImageLease | null = null;
  onState({ status: "loading" });
  if (reader === null) {
    onState({ status: "refused", reason: "unavailable" });
    return () => {};
  }
  void reader.image(address, options).then((result) => {
    if (closed) {
      if (result.ok) result.value.release();
      return;
    }
    if (!result.ok) {
      onState({ status: "refused", reason: result.reason });
      return;
    }
    lease = result.value;
    onState({ status: "ready", url: lease.url, mimeType: lease.mimeType });
  }).catch(() => {
    if (!closed) onState({ status: "refused", reason: "unavailable" });
  });
  return () => {
    closed = true;
    lease?.release();
    lease = null;
  };
}
