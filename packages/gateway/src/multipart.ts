import { Readable, Transform } from "node:stream";
import busboy from "busboy";

/**
 * The multipart body of one upload, read as it arrives.
 *
 * A browser uploads with a form because that is what its file control produces, and the hop that owns the file policy is
 * the one that has to read it: parsing here rather than in the Web process means the batch bound, the per-file relay to
 * the execution host and the refusal that stops a body nobody wants are one implementation instead of one per hop. The
 * parser is the public `busboy`, not a private copy inside a framework: this package is the file surface's owner, and a
 * dependency that only one build happens to ship is a dependency this surface cannot state.
 *
 * Two rules keep an upload bounded. Every file is handed on as its own stream, so its bytes are on their way to the host
 * while the next part is still on the wire, and what is held at once is one chunk. And the whole request is counted
 * against `totalBytes` as it arrives, so a body that declares nothing (chunked) is bounded by the same number as one
 * that declares its length.
 */

/** The field an upload UI sends its files in. Any other field is read out and dropped. */
export const UPLOAD_FIELD = "files";

/** The most one upload request may carry across all its files, unless the caller states its own bound. */
export const MAX_UPLOAD_BATCH_BYTES = 100 * 1024 * 1024;

/** The whole request was larger than the bound one upload may carry. */
export class UploadTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super("one upload may carry at most " + limit + " bytes in total");
    this.name = "UploadTooLargeError";
    this.limit = limit;
  }
}

/** One file of the request, as the caller takes it: a name, and the bytes that follow it. */
export type UploadPart = { readonly fileName: string; readonly body: Readable };

/** The request's own description, as `node:http` gives it. */
export type UploadRequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

/** A request body as either runtime states it: a Node stream, or the web stream a `Request` carries. */
export type UploadBody = Readable | ReadableStream<Uint8Array>;

export type ReadUploadPartsOptions = {
  readonly headers: UploadRequestHeaders;
  /** The request's body, read as it arrives. */
  readonly body: UploadBody;
  /** The batch bound; absent reads {@link MAX_UPLOAD_BATCH_BYTES}. */
  readonly totalBytes?: number;
  /**
   * Takes one file. It must consume the part before it resolves — that is what keeps the request bounded, and what lets
   * the parser keep reading. A part the caller will not take is a refusal, and the request ends there.
   */
  readonly take: (part: UploadPart) => Promise<void>;
};

/** Read a part to its end when the caller did not: the wire is read out rather than left with nobody pulling on it. */
async function drain(part: Readable): Promise<void> {
  if (part.readableEnded || part.destroyed) return;
  await new Promise<void>((resolve) => {
    part.on("end", resolve);
    part.on("close", resolve);
    part.on("error", () => resolve());
    part.resume();
  });
}

function headerValue(headers: UploadRequestHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Read one multipart upload body, handing every file to `take` in the order it arrives.
 *
 * The reasons a request ends stay distinct: a body past the batch bound is {@link UploadTooLargeError}, and anything the
 * caller's own `take` threw is rethrown as it was, so a refusal the file surface already decided on is what the caller
 * answers with rather than a generic parse failure.
 */
export async function readUploadParts(options: ReadUploadPartsOptions): Promise<void> {
  const limit = options.totalBytes ?? MAX_UPLOAD_BATCH_BYTES;
  const body = options.body instanceof Readable ? options.body : Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0]);
  // A request that declares more than the bound is refused before a byte of it is read.
  const declared = headerValue(options.headers, "content-length");
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) throw new UploadTooLargeError(limit);

  const contentType = headerValue(options.headers, "content-type") ?? "";
  // `preservePath` keeps the name the browser sent rather than a basename this hop would silently substitute: a name that
  // is not one file's own name is refused by the upload's own rules, not rewritten on the way through.
  const parser = busboy({ headers: { "content-type": contentType }, preservePath: true });
  let overBound: UploadTooLargeError | undefined;
  /** The caller's own refusal, which ends the request where it stands: nothing else in this body is wanted. */
  let refused: unknown;
  let total = 0;
  let taken: Promise<void> = Promise.resolve();

  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        const error = new UploadTooLargeError(limit);
        overBound = error;
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });

  const parsed = new Promise<void>((resolve, reject) => {
    parser.on("error", (error: Error) => reject(overBound ?? refused ?? error));
    parser.on("close", () => resolve());
    parser.on("file", (field: string, stream: Readable, info: { filename?: string }) => {
      // A field this route does not serve is read out rather than left in the way of the parts that follow it.
      if (field !== UPLOAD_FIELD) { stream.resume(); return; }
      const fileName = typeof info.filename === "string" ? info.filename : "";
      taken = taken
        .then(async () => {
          await options.take({ fileName, body: stream });
          await drain(stream);
        })
        .catch((error: unknown) => {
          // The body is not this reader's to destroy: the caller owns it, and a request it still has to answer must
          // stay readable so the refusal can be delivered instead of the socket being reset under the caller.
          refused ??= error;
          body.unpipe(counted);
          counted.destroy();
          parser.destroy();
        });
    });
  });

  // An incoming body that dies is the request dying: the parser is told, so it cannot wait for bytes that never come.
  body.on("error", (error: Error) => parser.destroy(error));
  counted.on("error", (error: Error) => parser.destroy(error));
  body.pipe(counted).pipe(parser);
  try {
    await parsed;
    await taken;
  } catch (error) {
    // A parser that stopped early says only that the form ended: the reason the request ended is what the caller reads,
    // and a bound that was passed outranks whatever the part it stopped read as.
    throw overBound ?? refused ?? error;
  } finally {
    // The caller's body is left as it is: a hop that stopped reading a request still has to answer it, and destroying
    // the request here would answer it with a reset. Everything this reader created is released.
    body.unpipe(counted);
    counted.destroy();
    parser.destroy();
  }
  if (overBound !== undefined) throw overBound;
  if (refused !== undefined) throw refused;
}
