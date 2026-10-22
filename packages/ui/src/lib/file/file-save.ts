import { fileApiPath } from "./file-paths";
import type { WorkbenchClient } from "../../client";
import { workspaceRoutingLocation } from "@hepi/protocol/files";
import { errorText } from "@hepi/protocol/error-text";

/**
 * Saving one file's bytes to a destination the person chose.
 *
 * A download is not a page's business on every host. A Web page navigates, and the browser streams the file to disk
 * under its own name — the credential rides the navigation, no script holds the bytes, and there is nothing to build.
 * A packaged App has no such path: its document is a bundle on `tauri://localhost`, so a navigation would ask the shell
 * for a file it does not serve, and no element of it can present the device bearer. Its save is therefore the shell's
 * own, and what crosses into it is a **stream the shell paces**.
 *
 * This module is the seam between those two, and it states three things once:
 *
 * - **Where the bytes come from.** The connection reads them, from its own origin under its own credential. No surface
 *   assembles an address and no token is ever put in a URL.
 * - **How much is in flight.** The bytes are handed over in slices no larger than {@link SAVE_CHUNK_BYTES}, one at a
 *   time, and each slice is awaited before the next is read. Ticket 04 measured what the alternative costs: handing the
 *   WebView's own 69–73 MB chunk to the native save peaked at ~3.02 GB RSS, while 1 MiB slices saved the same 96 MiB at
 *   ~224 MB. The bound therefore belongs at the IPC boundary, which is where this loop puts it.
 * - **Who owns the partial file.** The destination is opened by the shell, written by the shell and removed by the
 *   shell. A save that fails or is cancelled leaves no file of this run's behind and never touches the source: the
 *   workspace file is read, never written.
 *
 * The save is fixed at the moment it starts. The connection, the routing path and the destination are captured by the
 * caller that started it, so a view that switches to another file, another workspace or another connection cannot
 * redirect bytes that are already moving; and the connection's own disposal ends the request, which is what turns a
 * closed connection into a cleaned-up partial file rather than a file from someone else's Gateway.
 */

/** The most this client hands to the shell in one slice, measured at the IPC boundary (ticket 04). */
export const SAVE_CHUNK_BYTES = 1024 * 1024;

/** One save's destination, as the native host names it: a path the person chose, and whether it already existed. */
export interface SaveDestination {
  /** The absolute destination path, as the platform's own picker stated it. */
  readonly path: string;
  /** Whether the person confirmed replacing a file that already exists. */
  readonly overwrite: boolean;
}

/**
 * The shell's half of a save: a destination picker, and a file written a slice at a time.
 *
 * It is stated as an interface because the App host is the only implementation and the shared tree must not depend on
 * it: a Web page has no save host at all, which is what {@link FileSaveHost} being absent means. Every method is the
 * platform's own work — a dialog, a file handle, a flush — and none of them decides where the bytes come from.
 */
export interface FileSaveHost {
  /**
   * Ask the person where this file should go, under the name it has on the host.
   *
   * `null` is a cancelled choice, which is not a failure: nothing was opened and nothing is transferred.
   */
  chooseDestination(suggestedName: string): Promise<SaveDestination | null>;
  /** Open the destination for one save and answer this save's handle, or the platform's refusal. */
  begin(destination: SaveDestination): Promise<SaveHandle>;
  /** Append one slice and answer how many bytes the file holds afterwards. */
  append(handle: SaveHandle, chunk: Uint8Array): Promise<number>;
  /** Finish the file: flush it to the platform and close it. */
  finish(handle: SaveHandle): Promise<void>;
  /** Abandon this save: close the file and remove what this run wrote. Never removes anything it did not open. */
  abort(handle: SaveHandle): Promise<void>;
}

/** One save's handle, as the shell's `begin` answered it. Opaque here on purpose: it is the host's own token. */
export type SaveHandle = number | string;

/** What one save settled to, in the words a surface can show. */
export type SaveOutcome =
  /** The file was written whole: the destination, and the bytes this client handed over. */
  | { readonly kind: "saved"; readonly path: string; readonly bytes: number }
  /** The person closed the picker, or cancelled a save in flight. Nothing was transferred and nothing is shown. */
  | { readonly kind: "cancelled" }
  /** The save did not finish: the destination is named, and what this run wrote has been removed. */
  | { readonly kind: "failed"; readonly path: string | null; readonly reason: string };

/** One save as a caller starts it: the file, its name, and the host that writes it. */
export interface SaveRequest {
  /** The routing path of the file to read: `/workspace/<id>/…`, parsed by the protocol's own parser. */
  readonly routingPath: string;
  /** The shell's own save host. A host without one has no save path, and the seam says so. */
  readonly host: FileSaveHost;
  /** The name to suggest in the picker, as the host's path names the file. */
  readonly suggestedName: string;
  /** The caller's own interest in this save; aborting it cancels the transfer and removes the partial file. */
  readonly signal?: AbortSignal;
  /** Progress, in bytes handed to the shell, after each slice. */
  readonly onProgress?: (bytes: number) => void;
}

/**
 * How this host saves one file, decided once so the surfaces cannot disagree.
 *
 * Three answers and no fourth: a browser navigation when the connection has an element address (a Web page's cookie
 * rides it), the shell's own save when the host states one (an App's bundle has no navigation), and no path at all when
 * neither holds — which a fixture mounted without a shell really is, and which a control states rather than inventing a
 * blob download for.
 */
export type SavePath =
  /** The browser navigates and saves the stream itself; the page never holds the bytes. */
  | { readonly kind: "navigation"; readonly url: string }
  /** The shell writes the file from slices the connection reads. */
  | { readonly kind: "native"; readonly host: FileSaveHost }
  /** This host cannot save, and why. */
  | { readonly kind: "none"; readonly reason: string };

export function savePathOf(answer: { readonly url: string | null; readonly reason: string | null }, host: FileSaveHost | null): SavePath {
  if (answer.url !== null) return { kind: "navigation", url: answer.url };
  if (host !== null) return { kind: "native", host };
  return { kind: "none", reason: answer.reason ?? "This host has no way to save a file." };
}

const NOT_A_WORKSPACE = "Only a configured /workspace/<id> path names a file this connection can save";

/** The words a save's failure is shown with, from the status the Gateway answered. */
function reasonOfStatus(status: number, message: string): string {
  if (status === 401) return "This connection is not accepted by the Gateway any more.";
  if (status === 403) return "The Gateway refused this file for this identity.";
  if (status === 404) return "The Gateway has no such file.";
  if (status === 413) return "This file is larger than the Gateway's file policy, so it cannot be saved here.";
  if (status >= 500) return "The Gateway could not be reached for this file.";
  return message;
}

/**
 * Read one file from the connection and write it to the destination the person chose.
 *
 * The order is the promise: the picker first, so a cancelled choice transfers nothing; the read second, so a refused
 * file never creates a destination; the slices one at a time, so neither the page nor the shell holds the whole file;
 * and the abort last, so every way out of the middle removes what this run wrote.
 *
 * A failure is a value rather than a throw, because a surface shows the reason beside the file it did not save — and
 * because "cancelled" and "failed" are different answers a person acts on differently.
 */
export async function saveFile(client: WorkbenchClient, request: SaveRequest): Promise<SaveOutcome> {
  if (workspaceRoutingLocation(request.routingPath) === null) throw new Error(NOT_A_WORKSPACE);
  if (client.disposed) return { kind: "failed", path: null, reason: "The connection this file belonged to is closed." };

  const destination = await request.host.chooseDestination(request.suggestedName);
  // A closed picker is not a failure: nothing was opened, nothing is transferred, and the surface says nothing.
  if (destination === null) return { kind: "cancelled" };
  if (request.signal?.aborted) return { kind: "cancelled" };

  let response: Response;
  try {
    // The same address the rest of the file surface uses: this connection's origin, this connection's credential, and
    // the file's own bytes rather than a preview of them.
    response = await client.request(fileApiPath(request.routingPath, "download"), request.signal === undefined ? {} : { signal: request.signal });
  } catch (error) {
    return { kind: "failed", path: null, reason: errorText(error) };
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
    const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "HTTP " + response.status;
    await response.body?.cancel().catch(() => undefined);
    // A refused read is refused before the destination exists: nothing was opened, so there is nothing to remove.
    return { kind: "failed", path: null, reason: reasonOfStatus(response.status, message) };
  }

  let handle: SaveHandle;
  try {
    handle = await request.host.begin(destination);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: "failed", path: destination.path, reason: errorText(error) };
  }

  const written = await writeSlices(response, request, handle);
  if (written.kind === "failed") {
    await request.host.abort(handle).catch(() => undefined);
    return { kind: "failed", path: destination.path, reason: written.reason };
  }
  if (written.kind === "cancelled") {
    await request.host.abort(handle).catch(() => undefined);
    return { kind: "cancelled" };
  }
  try {
    await request.host.finish(handle);
  } catch (error) {
    await request.host.abort(handle).catch(() => undefined);
    return { kind: "failed", path: destination.path, reason: errorText(error) };
  }
  return { kind: "saved", path: destination.path, bytes: written.bytes };
}

/**
 * One body, sliced and handed over one awaited slice at a time.
 *
 * The bound is applied here rather than to the transport: the platform may hand over a chunk of any size, and it is the
 * slice crossing IPC that ticket 04 measured, not the read. Slicing is a view over the same buffer, so it costs no copy
 * of the file — what it costs is the wait between slices, which is the backpressure this is for.
 */
async function writeSlices(
  response: Response,
  request: SaveRequest,
  handle: SaveHandle,
): Promise<{ kind: "written"; bytes: number } | { kind: "cancelled" } | { kind: "failed"; reason: string }> {
  const body = response.body;
  if (body === null) return { kind: "written", bytes: 0 };
  const reader = body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      if (request.signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        return { kind: "cancelled" };
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      for (let offset = 0; offset < value.byteLength; offset += SAVE_CHUNK_BYTES) {
        const slice = value.subarray(offset, Math.min(offset + SAVE_CHUNK_BYTES, value.byteLength));
        bytes = await request.host.append(handle, slice);
        request.onProgress?.(bytes);
        if (request.signal?.aborted) {
          await reader.cancel().catch(() => undefined);
          return { kind: "cancelled" };
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    // A connection disposed under a save is not a transport fault to retry: the bytes already written belong to a
    // connection that is gone, and the destination is this run's to remove.
    return { kind: "failed", reason: errorText(error) };
  }
  return { kind: "written", bytes };
}
