import { cutAtByteBudget } from "./conversation-read.ts";

/**
 * The read-block bounds: how much of one heavy history block a single answer carries, and how a client reaches the rest.
 *
 * A read block is what a deferred history entry names — the full text a preview replaced, the whole thinking a preview
 * replaced, the image bytes an address replaced. Restoring it must not mean handing a client a multi-megabyte body it
 * never asked for, so every answer here is bounded by default: a text answers at most {@link MAX_READ_BLOCK_BYTES} of
 * UTF-8 text and states where it stopped, and an image answers a **byte range** so a client that only needs a window of
 * it never has to hold the whole decode.
 *
 * The bound is on the wire and on the decode, and both matter for different reasons. The wire bound is what keeps a
 * response from being a body the transport cannot carry; the decode bound is what keeps a 10 MiB screenshot from being
 * turned into a second 10 MiB buffer just to serve its first kilobyte. Neither bound decides what is *reachable*: a
 * continuation, or a range, always reaches the whole block, which is why deferral stays lossless.
 *
 * The functions here are pure: they take the text or the block's base64 and return the answer. The HTTP route states
 * that answer, so the bounds and the projection that named the block cannot disagree about what a read is.
 */

/**
 * The most UTF-8 text one read-block answer carries by default, and the most a caller may ask for.
 *
 * It sits above {@link TEXT_DEFER_BYTES} (the size at which a text is deferred at all), so the ordinary deferred text
 * — a large paste or a tool output — is restored in one answer and nothing changes for it. Only a pathological text
 * pages, and a caller that asks for a bigger `limit` than this is answered with this: the bound is the server's, not a
 * parameter, because a caller that could raise it could reintroduce the unbounded body the bound exists to prevent.
 */
export const MAX_READ_BLOCK_BYTES = 256 * 1024;

/** One bounded text answer: the piece, where it starts, how large the whole block is, and where a continuation resumes. */
export type ReadBlockTextPage = {
	readonly text: string;
	/** The character offset this page starts at, which is what a continuation states and what the next one adds to. */
	readonly offset: number;
	/** The UTF-8 byte length of the **whole** block, so a caller can size a progress or a decision before paging. */
	readonly totalBytes: number;
	readonly truncated: boolean;
	/** Where the next page starts, in characters. Absent exactly when this page is the end of the block. */
	readonly nextOffset?: number;
};

/**
 * One bounded page of a text block.
 *
 * `offset` counts characters rather than bytes because a continuation has to name a position in a JavaScript string
 * without ever splitting a code point: a byte offset could land inside a multi-byte character, and rejoining the pages
 * would then produce something the block never contained. The cut itself is the native Read's own UTF-8-safe prefix
 * rule (`cutAtByteBudget`), so a page never emits a replacement character and the pieces rejoin byte for byte.
 *
 * An offset past the end is answered as an empty final page rather than as a refusal: a caller that paged to the end
 * has asked a well-formed question, and "there is nothing after this" is its answer.
 */
export function readBlockTextPage(text: string, offset = 0, limitBytes = MAX_READ_BLOCK_BYTES): ReadBlockTextPage {
	const totalBytes = Buffer.byteLength(text, "utf8");
	const start = Math.max(0, Math.min(offset, text.length));
	const rest = text.slice(start);
	if (Buffer.byteLength(rest, "utf8") <= limitBytes) return { text: rest, offset: start, totalBytes, truncated: false };
	const piece = cutAtByteBudget(rest, limitBytes);
	return { text: piece, offset: start, totalBytes, truncated: true, nextOffset: start + piece.length };
}

/**
 * The largest `limit` a caller may ask for: the server's bound, never a larger one from the query.
 *
 * A caller may ask for **less** — a surface that only shows the head of a text pays for the head — and a value that is
 * not a positive integer is refused by the route rather than silently replaced with the default.
 */
export function readBlockLimit(requested: number | undefined): number {
	if (requested === undefined) return MAX_READ_BLOCK_BYTES;
	return Math.min(requested, MAX_READ_BLOCK_BYTES);
}


/**
 * The `offset` and `limit` one read-block request asks for, or the refusal the route states.
 *
 * They are validated together because they are one question — which piece of the block is being asked for — and a
 * caller that states a bad one is told which, rather than being silently given the default page it did not ask for.
 * The limit is clamped by {@link readBlockLimit}, so a caller can ask for less and never for more.
 */
export function parseReadBlockQuery(query: URLSearchParams): { readonly ok: true; readonly offset: number; readonly limit: number } | { readonly ok: false; readonly error: string } {
	const rawOffset = query.get("offset");
	const rawLimit = query.get("limit");
	if (rawOffset !== null && !/^[0-9]+$/.test(rawOffset)) return { ok: false, error: "offset must be a non-negative integer" };
	if (rawLimit !== null && !/^[0-9]+$/.test(rawLimit)) return { ok: false, error: "limit must be a positive integer" };
	const offset = rawOffset === null ? 0 : Number(rawOffset);
	const limit = rawLimit === null ? undefined : Number(rawLimit);
	if (limit === 0) return { ok: false, error: "limit must be a positive integer" };
	return { ok: true, offset, limit: readBlockLimit(limit) };
}

/** One byte range of a block, half-open, as `Range: bytes=start-end` states it. */
export type ByteRange = { readonly start: number; readonly end: number };

/**
 * The one range a request asks for, or why it cannot be served.
 *
 * Only the single-range forms are interpreted — `bytes=start-end`, `bytes=start-` and the suffix `bytes=-length` —
 * because those are the three a media element or a viewer actually sends. A multi-range request, or a header that is
 * not a byte range at all, answers `undefined`, which means "serve the whole block": that is what RFC 9110 allows and
 * what every static server does, and inventing a multipart answer would be a second wire format for one edge case.
 * A syntactically valid range that starts at or past the end is `"unsatisfiable"`, which is a 416 and not a 200.
 */
export function parseByteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
	if (header === undefined) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return undefined;
	const [, first, second] = match as unknown as [string, string, string];
	if (first === "" && second === "") return undefined;
	if (first === "") {
		// A suffix range asks for the last N bytes, and a suffix of zero asks for nothing at all.
		const length = Number(second);
		if (!Number.isSafeInteger(length) || length <= 0) return "unsatisfiable";
		if (size === 0) return "unsatisfiable";
		return { start: Math.max(0, size - length), end: size };
	}
	const start = Number(first);
	if (!Number.isSafeInteger(start)) return undefined;
	if (start >= size) return "unsatisfiable";
	const stated = second === "" ? size - 1 : Number(second);
	if (!Number.isSafeInteger(stated) || stated < start) return "unsatisfiable";
	return { start, end: Math.min(stated + 1, size) };
}

/**
 * The bytes a base64 block holds, without decoding it.
 *
 * This is the number the range is parsed against and the length a whole answer states, so a request is answered from
 * arithmetic rather than from a decoded copy of the image.
 */
export function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor(data.length / 4) * 3 - padding);
}

/**
 * One byte range of a base64 block, decoded from **only the groups that range touches**.
 *
 * Base64 encodes three bytes in four characters, so a byte range maps onto a character range aligned outward to those
 * groups: the characters outside it are never sliced, never decoded and never allocated. Serving the first kilobyte of
 * a 10 MiB screenshot therefore costs a kilobyte, which is the whole reason a client may ask for a range instead of the
 * block.
 *
 * The alignment is exact rather than approximate: `first` is the group boundary at or before `start`, and the decoded
 * piece is sliced back to the requested bytes, so the answer is the block's own bytes and not a re-encoding of them.
 */
export function base64ByteRange(data: string, range: ByteRange): Buffer {
	const firstGroup = Math.floor(range.start / 3) * 3;
	const lastGroup = Math.ceil(range.end / 3) * 3;
	const charStart = (firstGroup / 3) * 4;
	const charEnd = Math.min(data.length, (lastGroup / 3) * 4);
	const decoded = Buffer.from(data.slice(charStart, charEnd), "base64");
	return decoded.subarray(range.start - firstGroup, range.end - firstGroup);
}

/** One image answer as the route writes it: the status, the headers that describe the bytes, and the bytes. */
export type ReadBlockImageAnswer = { readonly status: number; readonly headers: Record<string, string>; readonly body: Buffer };

/**
 * The answer to one image read block, bounded by the range the caller asked for.
 *
 * `accept-ranges` is stated on a whole answer too, because that is the one fact that tells a client it may ask for a
 * window next time; `cache-control` keeps a private image out of any shared cache, which is what makes a blob URL in a
 * client the only durable copy of it.
 */
export function readBlockImageAnswer(image: { readonly data: string; readonly mimeType: string }, rangeHeader: string | undefined): ReadBlockImageAnswer {
	const size = base64ByteLength(image.data);
	const headers: Record<string, string> = { "content-type": image.mimeType, "accept-ranges": "bytes", "cache-control": "private, max-age=0, no-cache" };
	const range = parseByteRange(rangeHeader, size);
	if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "content-range": "bytes */" + size }, body: Buffer.alloc(0) };
	if (range === undefined) return { status: 200, headers: { ...headers, "content-length": String(size) }, body: base64ByteRange(image.data, { start: 0, end: size }) };
	return { status: 206, headers: { ...headers, "content-length": String(range.end - range.start), "content-range": "bytes " + range.start + "-" + (range.end - 1) + "/" + size }, body: base64ByteRange(image.data, range) };
}
