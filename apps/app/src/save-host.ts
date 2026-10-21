/**
 * The App's native save, as the shared workbench asks for it.
 *
 * The workbench names a seam — a destination picker and a file written a slice at a time — and this is the only
 * implementation of it. It lives in the host rather than in `@hepi/ui` for the same reason the connection does: it is
 * platform I/O, and a shared tree that imported it would put the shell's IPC in the Web page's bundle too.
 *
 * Nothing here decides where the bytes come from. The page has already read them through its connection, under the
 * device bearer, and hands them over one bounded slice at a time; this module writes what it is given and answers how
 * much the file holds. That division is what keeps the credential in the page's transport and the file in the shell's.
 */
import { invoke } from "@tauri-apps/api/core";
import type { FileSaveHost, SaveDestination, SaveHandle } from "@hepi/ui/lib/file/file-save";
import { inShell } from "./shell";

/**
 * The shell's save, or `null` when this document is not inside one.
 *
 * A page served as a Web page states no save host: its download is a navigation the browser performs, and the workbench
 * offers that control instead. The check is the shell's own marker rather than a build flag, so a development document
 * loaded without the shell says so instead of failing at the first click.
 */
export function nativeSaveHost(): FileSaveHost | null {
  if (!inShell()) return null;
  return {
    // A closed dialog answers null, which is not a failure: nothing was opened and nothing is transferred.
    chooseDestination(suggestedName: string): Promise<SaveDestination | null> {
      return invoke<SaveDestination | null>("app_save_choose", { suggestedName });
    },
    async begin(destination: SaveDestination): Promise<SaveHandle> {
      return await invoke<number>("app_save_begin", { path: destination.path, overwrite: destination.overwrite });
    },
    async append(handle: SaveHandle, chunk: Uint8Array): Promise<number> {
      // The slice crosses IPC as a byte array. It is already bounded by the seam, and the shell refuses one that is not,
      // so neither side is the only place the bound is stated.
      return await invoke<number>("app_save_append", { handle, chunk: Array.from(chunk) });
    },
    async finish(handle: SaveHandle): Promise<void> {
      await invoke("app_save_finish", { handle });
    },
    async abort(handle: SaveHandle): Promise<void> {
      await invoke<void>("app_save_abort", { handle });
    },
  };
}
