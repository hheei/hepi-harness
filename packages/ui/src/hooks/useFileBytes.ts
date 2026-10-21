"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalWorkbenchConnection, useWorkbenchConnection } from "../lib/workbench-scope";
import { useWorkbenchHostCapabilities } from "../lib/navigation";
import { saveFile, type FileSaveHost, type SaveOutcome } from "../lib/file-save";

/**
 * One file's bytes, as a browser element may show them on this connection.
 *
 * The two hosts differ in a way no element can hide: a Web page is served from the origin it calls, so an `<img>`, a
 * media element or a download navigation carries the httpOnly cookie by itself and the bytes stream with the range the
 * element asks for; a packaged App's document is a bundle, so no element of it can present the device bearer and the
 * connection reads the bytes into a leased blob instead. This hook is that decision, once, so the image, audio, video
 * and document viewers do not each invent their own answer.
 *
 * The lease is released when the file changes and when the surface unmounts, and the connection's own disposal
 * revokes whatever is left: a page that switched connection cannot go on showing the previous one's file.
 *
 * The address is never guessed ahead of the connection. A cookie page's is known without reading anything, so it is
 * there in the first frame; a bearer connection's is not, and an address invented for it would be an element request the
 * Gateway answers `401` — which a viewer then reports as a failed image, before the bytes it really has have arrived.
 */
export interface FileBytesState {
  /** The address a browser element may point at, or null while there is none. */
  readonly url: string | null;
  /** Why there is no address, in words a surface can show. */
  readonly error: string | null;
}

/** The same state for a file whose bytes this connection cannot put in an element. */
const unsupported = (reason: string): FileBytesState => ({ url: null, error: reason });

export function useFileBytes(routingPath: string | null | undefined): FileBytesState {
  const files = useOptionalWorkbenchConnection()?.files ?? null;
  const [state, setState] = useState<FileBytesState>(() => {
    // The seam answers an address only where an element's own request carries the credential, so this is null until the
    // connection has read bytes it can show: nothing is mounted against a request that would be refused.
    const address = routingPath && files ? files.url(routingPath, "read") : null;
    return address === null ? { url: null, error: null } : { url: address, error: null };
  });

  useEffect(() => {
    if (files === null || !routingPath) { setState({ url: null, error: null }); return; }
    const controller = new AbortController();
    let release: (() => void) | null = null;
    // A cookie connection has the answer without a request: the browser's own element carries the credential, and
    // asking for the bytes here would read the file a second time for no reason.
    const address = files.url(routingPath, "read");
    if (address !== null) {
      setState({ url: address, error: null });
      return;
    }
    setState({ url: null, error: null });
    void files.bytes(routingPath, { signal: controller.signal }).then((answer) => {
      if (controller.signal.aborted) {
        if (answer.kind === "lease") answer.release();
        return;
      }
      if (answer.kind === "address") { setState({ url: answer.url, error: null }); return; }
      if (answer.kind === "lease") { release = answer.release; setState({ url: answer.url, error: null }); return; }
      setState(unsupported(answer.reason));
    }, (error: unknown) => {
      if (!controller.signal.aborted) setState(unsupported(error instanceof Error ? error.message : String(error)));
    });
    return () => {
      controller.abort();
      release?.();
    };
  }, [files, routingPath]);

  return state;
}

/**
 * One file's own facts — its size and the kind of preview it has — as the surface states them.
 *
 * The viewers show a size and refuse an oversized document before rendering it, so this is read once per file on the
 * connection rather than by each viewer's own request.
 */
export function useFileMeta(routingPath: string | null | undefined): { readonly size: number | null; readonly previewKind: string | null; readonly error: string | null } {
  const files = useOptionalWorkbenchConnection()?.files ?? null;
  const [meta, setMeta] = useState<{ size: number | null; previewKind: string | null; error: string | null }>({ size: null, previewKind: null, error: null });

  useEffect(() => {
    if (files === null || !routingPath) { setMeta({ size: null, previewKind: null, error: null }); return; }
    const controller = new AbortController();
    setMeta({ size: null, previewKind: null, error: null });
    void files.meta(routingPath).then((answer) => {
      if (controller.signal.aborted) return;
      setMeta({ size: typeof answer.size === "number" ? answer.size : null, previewKind: answer.previewKind ?? null, error: null });
    }, (error: unknown) => {
      if (!controller.signal.aborted) setMeta({ size: null, previewKind: null, error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
  }, [files, routingPath]);

  return meta;
}

/**
 * Where a download navigation may go, or the reason there is nowhere.
 *
 * A Web page's download is the browser's own: it streams the file to disk under its name without the page ever holding
 * it. A packaged App has no such path — a bundle has no download navigation — so its save is the shell's, and
 * {@link useFileSave} is that control instead. The refusal this states is what a surface offers in its place, never a
 * page that collects the file into memory and calls that a save.
 */
export function useFileDownload(routingPath: string | null | undefined): { readonly url: string | null; readonly reason: string | null } {
  const { files } = useWorkbenchConnection();
  if (!routingPath) return { url: null, reason: null };
  const answer = files.download(routingPath);
  return answer.kind === "address" ? { url: answer.url, reason: null } : { url: null, reason: answer.reason };
}

/**
 * One file's save control, on whichever path this host has.
 *
 * The two hosts differ here and the difference is not a preference: a Web page navigates, and the browser streams the
 * file to disk under its own name; a packaged App's document is a bundle, so its bytes are read through the connection
 * and written by the shell in bounded slices. This hook is that decision once, so the viewer and the explorer's row do
 * not each invent an answer — and so neither of them reaches for a platform module the shared tree must not import.
 *
 * The save is fixed when it starts: the connection, the routing path and the destination are captured by the call, so a
 * view that switches to another file or another connection cannot redirect bytes that are already moving. Aborting it
 * cancels the transfer and removes the partial file, and disposing the connection does the same through the read it
 * owns.
 */
export interface FileSaveState {
  /** Whether this host has any way to save this file: the browser's own download, or the shell's native save. */
  readonly available: boolean;
  /** The save host, when this host has one. */
  readonly host: FileSaveHost | null;
  /** The save in flight, or the last one's answer, as the surface shows it. */
  readonly state:
    | { readonly kind: "idle" }
    | { readonly kind: "saving"; readonly bytes: number }
    | { readonly kind: "saved"; readonly path: string; readonly bytes: number }
    | { readonly kind: "failed"; readonly reason: string };
  /** Save this file to a destination the person chooses. Cancelling the picker is not an error and states nothing. */
  readonly save: () => Promise<SaveOutcome | null>;
  /** Abandon the save in flight; the partial file is removed by the host that wrote it. */
  readonly cancel: () => void;
}

export function useFileSave(routingPath: string | null | undefined, suggestedName: string): FileSaveState {
  const { files, client } = useWorkbenchConnection();
  const { save: host } = useWorkbenchHostCapabilities();
  const [state, setState] = useState<FileSaveState["state"]>({ kind: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set in the effect body, not only cleared by it: React's StrictMode runs an effect, cleans it up and runs it again on
    // the same mount, and a flag that only ever went false would leave every later result unstated.
    mountedRef.current = true;
    return () => {
      // A viewer that goes away ends its own save: the partial file belongs to a transfer nothing is watching any more.
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const save = useCallback(async (): Promise<SaveOutcome | null> => {
    if (host === null || !routingPath) return null;
    // One save at a time per surface: a second click while the picker is open would otherwise be a second destination
    // for the same bytes.
    if (controllerRef.current !== null) return null;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "saving", bytes: 0 });
    try {
      const outcome = await saveFile(client, {
        routingPath,
        host,
        suggestedName,
        signal: controller.signal,
        onProgress: (bytes) => { if (!controller.signal.aborted) setState({ kind: "saving", bytes }); },
      });
      if (!mountedRef.current) return outcome;
      if (outcome.kind === "saved") setState({ kind: "saved", path: outcome.path, bytes: outcome.bytes });
      else if (outcome.kind === "failed") setState({ kind: "failed", reason: outcome.reason });
      // A cancelled save states nothing: a picker the person closed is not a result to report.
      else setState({ kind: "idle" });
      return outcome;
    } catch (error) {
      if (mountedRef.current) setState({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      controllerRef.current = null;
    }
  }, [client, host, routingPath, suggestedName]);

  const cancel = useCallback(() => { controllerRef.current?.abort(); }, []);

  // A cookie page needs no host of its own: the download navigation is the save. A bearer page has no address, so the
  // shell's host is the only way these bytes reach a disk.
  const available = routingPath ? host !== null || files.download(routingPath).kind === "address" : false;
  return { available, host, state, save, cancel };
}
