/**
 * The browser's half of a workspace Word document.
 *
 * A ".docx" is a package, not text the host can decode, so the file surface serves the document's own bytes (the
 * protocol's "servesBytes") and the reading happens here, in two bounded steps: the body is streamed in **to a bound**,
 * and the document's text is extracted in the browser and mounted as text nodes. Never as HTML, never in a frame, never
 * as a script: a document from another machine carries markup this page must not execute, and text nodes make that
 * structurally impossible rather than depending on a sanitizer's rules. "mammoth" - the declared dependency this
 * repository had and never used - is the reader, imported only when a document is opened, so it stays off the first
 * paint. Its "convertToHtml" output is deliberately not used here.
 *
 * The bound is stated once, in "@hepi/protocol/files", and enforced twice: a "content-length" over it is refused before
 * anything is read, and a body that grows past it mid-stream is cancelled where it stands, because a document this
 * client cannot hold should not get to occupy the tab on its way to saying so. A document past the bound is still
 * downloadable through the byte route; what this refuses is previewing it here.
 */
import { DOCX_PREVIEW_MAX_BYTES } from "@hepi/protocol/files";

/** One document's readable text, or the reason there is none. */
export type DocxText =
  | { readonly ok: true; readonly paragraphs: readonly string[]; readonly bytes: number }
  | DocxRefusal;

/** Why one document produced no text. */
export type DocxRefusal = {
  readonly ok: false;
  readonly reason: "oversize" | "unavailable" | "aborted";
  readonly message: string;
};

/** One document's bytes, read no further than the bound. */
export type DocxBytesRead = { readonly ok: true; readonly arrayBuffer: ArrayBuffer; readonly bytes: number } | DocxRefusal;

/** How the bytes are reached: injectable, because this seam is tested without a Gateway. */
export type DocxBytesOptions = {
  readonly limitBytes?: number;
  readonly signal?: AbortSignal;
  readonly init?: RequestInit;
  readonly open?: (address: string, init?: RequestInit) => Promise<Response>;
};

/**
 * The abort that goes on the wire.
 *
 * "fetch" stops a request only when the request itself carries the signal, so the caller's
 * {@link DocxBytesOptions.signal} and any signal already named in {@link DocxBytesOptions.init} are composed into one:
 * leaving them apart is how a document whose preview had left the screen kept its remote read running.
 */
function previewSignal(options: DocxBytesOptions): AbortSignal | undefined {
  const caller = options.signal;
  const other = options.init?.signal ?? undefined;
  if (caller === undefined) return other;
  if (other === undefined || other === caller) return caller;
  return AbortSignal.any([caller, other]);
}

const ABORTED = "The preview was no longer on screen when its bytes arrived.";
const UNREADABLE = "The document could not be read from this connection.";

/**
 * One document's bytes, read no further than the bound. A refusal is a value: the viewer shows why there is no text
 * rather than an empty document, which is the state a caller cannot tell apart from a blank file.
 */
export async function readDocxBytes(
  address: string,
  options: DocxBytesOptions = {},
): Promise<DocxBytesRead> {
  const limitBytes = options.limitBytes ?? DOCX_PREVIEW_MAX_BYTES;
  const open = options.open ?? ((target: string, init?: RequestInit) => globalThis.fetch(target, init));
  const signal = previewSignal(options);
  const init: RequestInit | undefined = signal === undefined ? options.init : { ...options.init, signal };
  if (signal?.aborted) return { ok: false, reason: "aborted", message: ABORTED };
  let response: Response;
  try {
    response = await open(address, init);
  } catch {
    return { ok: false, reason: signal?.aborted ? "aborted" : "unavailable", message: signal?.aborted ? ABORTED : UNREADABLE };
  }
  if (!response.ok) return { ok: false, reason: "unavailable", message: "The Gateway answered HTTP " + response.status + " for this document." };
  const stated = Number(response.headers.get("content-length"));
  if (Number.isFinite(stated) && stated > limitBytes) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: "oversize", message: oversizeMessage(stated, limitBytes) };
  }
  if (response.body === null) return { ok: true, arrayBuffer: new ArrayBuffer(0), bytes: 0 };
  const reader = response.body.getReader();
  // A blocked "read()" settles when the stream closes, and a signal that is not fetch's own closes nothing: the abort
  // has to reach the reader. Cancelling it here is also what makes an injected source stop - a real fetch is already
  // cancelled by its own request init, a test's stream is not, and this seam is injectable on purpose.
  const stop = () => { void reader.cancel().catch(() => {}) };
  signal?.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "aborted", message: ABORTED };
      }
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: signal?.aborted ? "aborted" : "unavailable", message: signal?.aborted ? ABORTED : "The document stopped arriving." };
      }
      if (next.done === true) break;
      bytes += next.value.byteLength;
      // The stated length is a claim; this is the check. A body past the bound is abandoned at the bound, so the size a
      // refusal names is what was actually read.
      if (bytes > limitBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "oversize", message: oversizeMessage(bytes, limitBytes) };
      }
      chunks.push(next.value);
    }
    // An abort that lands on the final chunk still means nobody is watching: handing those bytes to the reader would
    // parse a document for a page that already moved on.
    if (signal?.aborted) { await reader.cancel().catch(() => {}); return { ok: false, reason: "aborted", message: ABORTED }; }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return { ok: true, arrayBuffer: buffer.buffer as ArrayBuffer, bytes };
}

const oversizeMessage = (bytes: number, limitBytes: number): string =>
  "This document is " + bytes + " bytes and this client previews at most " + limitBytes + " of one; download it instead.";

/**
 * The document's text, split into paragraphs. Whitespace-only lines are dropped: an empty run of a document is not
 * something a reader came to read, and dropping them keeps "the document holds no text" a statement the page can make
 * honestly rather than a blank frame.
 */
export function docxParagraphs(raw: string): readonly string[] {
  const breakLine = new RegExp("[" + String.fromCharCode(13) + String.fromCharCode(10) + "]");
  return raw.split(breakLine).map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * One document, start to text: bounded bytes, then the browser-side read.
 *
 * The reader is mammoth's **browser** entry, chosen by its `browser` package field when the page is bundled (esbuild and
 * Vite both honour it), which is what lets a document arrive as an `ArrayBuffer` with no Node global in sight. So this
 * function runs in a bundled page and nowhere else: the byte bounds and the paragraph split are unit-tested as their own
 * functions under Node, and the read itself is asserted in chromium.
 */
export async function loadDocxText(address: string, options: DocxBytesOptions = {}): Promise<DocxText> {
  // The bytes own the abort: readDocxBytes has already refused anything the caller stopped waiting for, so a document
  // that reaches the reader here is one somebody is still looking at.
  const bytes = await readDocxBytes(address, options);
  if (!bytes.ok) return bytes;
  // Imported only now, because a page that never opens a document never pays for the reader.
  const { default: mammoth } = await import("mammoth");
  try {
    const text = await mammoth.extractRawText({ arrayBuffer: bytes.arrayBuffer });
    return { ok: true, paragraphs: docxParagraphs(text.value), bytes: bytes.bytes };
  } catch {
    return { ok: false, reason: "unavailable", message: "This file is not a readable Word document." };
  }
}
