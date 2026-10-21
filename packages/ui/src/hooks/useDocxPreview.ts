import { useEffect, useState } from "react";
import { loadDocxText, type DocxText } from "../lib/docx-preview";

/**
 * One workspace Word document, as far as its bytes have already been reached.
 *
 * The caller hands over the address {@link useFileBytes} resolved for the connection, because that is the one read a
 * document gets: a Web page's address carries its own cookie on the element's request, and a packaged App's address is
 * the leased blob its connection already filled. Fetching the file again here would put the same remote document on the
 * wire twice for a bearer connection and hold two leases for one viewer, so this hook adds only what a document needs
 * beyond an element - reading the body no further than the preview bound and turning the package into paragraphs - and
 * stops that read when the document leaves the screen, so switching files cannot leave a page still pulling a document
 * nobody is looking at.
 *
 * Passing null reads nothing: a viewer that decided not to preview (a document over the bound it was told about before
 * any bytes moved, or one whose bytes failed to arrive) asks for nothing.
 */
export type DocxPreviewState = {
  readonly loading: boolean;
  readonly answer: DocxText | null;
};

export function useDocxPreview(address: string | null): DocxPreviewState {
  const [state, setState] = useState<DocxPreviewState>({ loading: address !== null, answer: null });

  useEffect(() => {
    if (address === null) { setState({ loading: false, answer: null }); return; }
    const controller = new AbortController();
    setState({ loading: true, answer: null });
    void loadDocxText(address, { signal: controller.signal, init: { credentials: "same-origin" } }).then(
      (answer) => { if (!controller.signal.aborted) setState({ loading: false, answer }); },
      (error: unknown) => { if (!controller.signal.aborted) setState({ loading: false, answer: { ok: false, reason: "unavailable", message: error instanceof Error ? error.message : String(error) } }); },
    );
    return () => controller.abort();
  }, [address]);

  return state;
}
