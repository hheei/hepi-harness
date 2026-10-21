/**
 * Display-only path shortening for the settings panels. Nothing reads these
 * strings back: authorization and API calls always use the full path.
 */

/** A path with a macOS or Linux home folder shown as `~`. */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/**
 * A path addressed under `routingRoot` shown as the folder it really is: the routing root — a
 * `/workspace/<id>` the API is reached by — is replaced by the folder the host reported for it. A path outside
 * that root, or a location with no folder known, is left as it is.
 */
export function displayPathUnder(path: string, routingRoot: string | null | undefined, displayRoot?: string | null): string {
  const base = (routingRoot ?? "").replace(/[/\\]+$/, "");
  if (!displayRoot || !base) return path;
  if (path !== base && !path.startsWith(`${base}/`) && !path.startsWith(`${base}\\`)) return path;
  return displayRoot.replace(/[/\\]+$/, "") + path.slice(base.length);
}

/**
 * A path inside `root` as `./relative`, anything else as `shortenPath()`.
 * Only a whole leading folder counts, so `/repo-other/x` is not inside `/repo`.
 */
export function displayPathWithin(path: string, root: string): string {
  const base = root.replace(/[/\\]+$/, "");
  if (base && (path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`))) {
    return `./${path.slice(base.length).replace(/^[/\\]/, "")}`;
  }
  return shortenPath(path);
}
