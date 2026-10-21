/**
 * The read blocks a conversation's history names, as a client fetches them.
 *
 * A history frame carries a **bounded** representation of heavy content: a preview of a large text or of a thinking
 * block, and, for an image, an address instead of the bytes. The rest is reachable through a read block, and those
 * addresses are wire facts built by the protocol (`textUrl`, `thinkingUrl`, `toolResultImageUrl`) under
 * `/api/sessions/:id/entries/:entryId/...`. A client therefore has two jobs and this module is both of them: resolve
 * such an address against the connection it was admitted to, and turn the answer into something a view can show without
 * keeping it forever.
 *
 * Three rules make it one seam rather than a helper per surface:
 *
 * - **The connection decides the origin and the credential.** A relative address resolves against the Gateway this
 *   connection was admitted to, never against whatever origin happens to be rendering — which is the failure a native
 *   shell has, where the page's own origin is the app bundle and a relative path would ask the shell itself for
 *   conversation history. A credential is only ever presented to that Gateway: an address on another origin is refused
 *   before a request is made, and no credential is ever put in a URL.
 * - **A read is bounded and a client assembles.** A text block answers one bounded page and says where it stopped, so a
 *   pathological text is never handed over whole by default; {@link ResourceReader.text} follows the continuation and
 *   returns the whole text, because that is what a caller asking for the block means.
 * - **An image is a lease, not a string.** The bytes become a blob URL, and the lease is what keeps it alive: releasing
 *   it, exceeding the retained budget, or disposing the whole connection scope revokes it, so a page that switches
 *   connection cannot go on showing an image the previous one loaded. The body is read through its stream and cancelled
 *   at that same budget, so a body the scope could never keep is refused rather than buffered first.
 */

/** Why a read block could not be shown. Every one of them is a fact a surface can name instead of showing nothing. */
export type ResourceRefusal =
	/** The identity was not accepted (401). */
	| "unauthorized"
	/** The identity is accepted but this request is not (403). */
	| "forbidden"
	/** The block, its entry or its conversation does not exist here (404, or an address this connection cannot serve). */
	| "not_found"
	/** The block exists but is outside the policy that would let it be served, or is larger than the bound (413, 415). */
	| "oversize"
	/** The Gateway could not be reached, or answered something that is not a block (5xx, a transport failure). */
	| "unavailable"
	/** The connection scope this reader belonged to is gone, and the answer arrived too late to be kept. */
	| "disposed";

export type ResourceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: ResourceRefusal };

/** How one read block is fetched: the cookie the browser attaches by itself, or one explicit device bearer. */
export type ResourceCredential = { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly token: string };

/** What one connection scope retains. Read by a caller that has to state its own memory use, and by tests. */
export type ResourceRetention = {
	readonly images: number;
	readonly imageBytes: number;
	readonly texts: number;
	readonly textBytes: number;
};

/** The bounds one scope keeps. Every one of them is a count and a byte total, because either alone is not a bound. */
export type ResourceLimits = {
	/** Blob URLs kept at once. A transcript's visible working set, not a store. */
	readonly images: number;
	/** Bytes of image data behind those blob URLs. */
	readonly imageBytes: number;
	/** Restored texts kept at once. */
	readonly texts: number;
	/** Bytes of restored text held, measured as JavaScript string bytes (two per code unit). */
	readonly textBytes: number;
};

/**
 * The default retention: enough for a screenful of tool screenshots and a few large expansions, and small enough that a
 * long session does not grow the tab by itself. A caller that knows better passes its own.
 */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
	images: 24,
	imageBytes: 32 * 1024 * 1024,
	texts: 32,
	textBytes: 16 * 1024 * 1024,
};

/**
 * One image held by a scope: the address that serves it, and the blob URL a view can point at.
 *
 * `release` is idempotent and drops only this lease; the blob is revoked when the last lease on that address is
 * released, so two views of one image never take it away from each other. `revoked` states whether the URL still
 * resolves, which is what a view needs after an eviction or a disposal instead of discovering it as a broken image.
 */
export type ImageLease = {
	readonly url: string;
	readonly mimeType: string;
	readonly bytes: number;
	readonly release: () => void;
	readonly revoked: boolean;
};

/** One read-block reader, owned by one connection scope. */
export type ResourceReader = {
	/** The absolute address one wire address resolves to here, or `undefined` when this connection may not serve it. */
	resolve(address: string): string | undefined;
	/** The whole text behind a deferred text or thinking block, assembled from its bounded pages. */
	text(address: string, options?: { readonly signal?: AbortSignal }): Promise<ResourceResult<string>>;
	/** One image block as a blob lease, with the address as the key that makes two views share one blob. */
	image(address: string, options?: { readonly signal?: AbortSignal }): Promise<ResourceResult<ImageLease>>;
	readonly retained: ResourceRetention;
	/** Revoke every blob this scope holds and refuse every later read. Repeating it changes nothing. */
	dispose(): void;
};

export type ResourceReaderOptions = {
	/** The Gateway origin this connection was admitted to. A wire address resolves against exactly this. */
	readonly origin: string;
	readonly credential: ResourceCredential;
	/** The platform's own fetch. Injected because that is where a browser's cookie jar and a shell's TLS live. */
	readonly fetch?: typeof fetch;
	readonly limits?: Partial<ResourceLimits>;
};

/**
 * One retained blob, with every lease ever handed out for it.
 *
 * `leases` keeps the released ones too, on purpose: `revoked` is a fact about the **blob**, so when the last live lease
 * goes and the blob is revoked, every view that ever pointed at that URL learns it no longer resolves — including one
 * that had already let go of its own lease. Counting only live leases would leave such a view holding a URL it believes
 * in.
 */
type HeldImage = {
	readonly url: string;
	readonly mimeType: string;
	readonly bytes: number;
	readonly leases: Set<MutableLease>;
	live: number;
	revoked: boolean;
};

type MutableLease = { readonly url: string; readonly mimeType: string; readonly bytes: number; readonly release: () => void; readonly revoked: boolean };

/** One page as the read block states it. */
type TextPage = { readonly text: string; readonly offset: number; readonly totalBytes: number; readonly truncated: boolean; readonly nextOffset?: number };

/** A status as the reason a surface can name. The two blocks answer 415/413 for "outside the policy", which is one answer. */
function reasonOf(status: number): ResourceRefusal {
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 413 || status === 415) return "oversize";
	return "unavailable";
}

const refusal = <T>(reason: ResourceRefusal): ResourceResult<T> => ({ ok: false, reason });

export function createResourceReader(options: ResourceReaderOptions): ResourceReader {
	const origin = options.origin.replace(/\/+$/, "");
	const send = options.fetch ?? globalThis.fetch;
	const limits: ResourceLimits = { ...DEFAULT_RESOURCE_LIMITS, ...options.limits };
	/** Insertion order is recency: a read moves its entry to the end, so the first key is the least recently used. */
	const images = new Map<string, HeldImage>();
	const texts = new Map<string, string>();
	let imageBytes = 0;
	let textBytes = 0;
	let disposed = false;

	/**
	 * The address one wire address names, or `undefined` when this connection may not serve it.
	 *
	 * A relative address is resolved against the connection's own Gateway — that is the whole point of the seam. A
	 * connection that states no origin is the Web host, where the document *is* the Gateway: its wire addresses stay
	 * relative, so the browser decides the origin and attaches its own cookie, and only a path is served. An absolute
	 * address is served only when its origin is that same Gateway: a credential presented to any other origin would be
	 * the client handing its identity to whatever a frame happened to name.
	 */
	function resolve(address: string): string | undefined {
		if (origin === "") return address.startsWith("/") && !address.startsWith("//") ? address : undefined;
		let url: URL;
		try {
			url = new URL(address, origin + "/");
		} catch {
			return undefined;
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.origin !== origin) return undefined;
		return url.toString();
	}

	/**
	 * The same block at the offset a previous page stated.
	 *
	 * A relative address stays relative: rebuilding it as an absolute URL would be the reader deciding an origin the
	 * connection never stated, which is exactly what a Web page must not do.
	 */
	function withOffset(target: string, offset: number | undefined): string {
		if (offset === undefined) return target;
		if (origin === "") return target + (target.includes("?") ? "&" : "?") + "offset=" + offset;
		const url = new URL(target);
		url.searchParams.set("offset", String(offset));
		return url.toString();
	}

	/** The one request shape this scope makes: its own origin, its own credential, and nothing of its own in the URL. */
	function request(target: string, signal: AbortSignal | undefined, extra: Record<string, string> = {}): Promise<Response> {
		const headers: Record<string, string> = { ...extra };
		if (options.credential.kind === "bearer") headers.authorization = "Bearer " + options.credential.token;
		return send(target, { method: "GET", headers, signal, credentials: options.credential.kind === "cookie" ? "same-origin" : "omit" }) as Promise<Response>;
	}

	function trimImages(): void {
		while (images.size > limits.images || imageBytes > limits.imageBytes) {
			const oldest = images.keys().next().value;
			if (oldest === undefined) return;
			const held = images.get(oldest)!;
			images.delete(oldest);
			revoke(held);
		}
	}

	function revoke(held: HeldImage): void {
		if (held.revoked) return;
		held.revoked = true;
		imageBytes -= held.bytes;
		for (const lease of held.leases) (lease as { revoked: boolean }).revoked = true;
		held.leases.clear();
		held.live = 0;
		if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(held.url);
	}

	function trimTexts(): void {
		while (texts.size > limits.texts || textBytes > limits.textBytes) {
			const oldest = texts.keys().next().value;
			if (oldest === undefined) return;
			const held = texts.get(oldest)!;
			texts.delete(oldest);
			textBytes -= held.length * 2;
		}
	}

	/**
	 * One image body, read through its own stream and abandoned the moment it exceeds what this scope could retain.
	 *
	 * The bound is the scope's own retained image budget: a blob larger than that could never be kept, so `oversize` is
	 * the honest answer and a reason a surface already knows. Reading the body whole and deciding afterwards would let a
	 * body this scope cannot hold — or one whose `content-length` was a lie — occupy the tab before the reader ever got
	 * to say no, so the stream is cancelled at the bound instead of buffered past it. A stated length over the bound is
	 * refused without reading at all.
	 */
	async function imageBody(response: Response): Promise<ResourceResult<{ readonly chunks: Uint8Array[]; readonly bytes: number }>> {
		const stated = Number(response.headers.get("content-length"));
		if (Number.isFinite(stated) && stated > limits.imageBytes) {
			await response.body?.cancel().catch(() => {});
			return refusal("oversize");
		}
		if (response.body === null) return { ok: true, value: { chunks: [], bytes: 0 } };
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > limits.imageBytes) {
					await reader.cancel().catch(() => {});
					return refusal("oversize");
				}
				chunks.push(value);
			}
		} catch {
			await reader.cancel().catch(() => {});
			return refusal(disposed ? "disposed" : "unavailable");
		}
		return { ok: true, value: { chunks, bytes } };
	}

	/** One page, with its reason when it is not a page: a caller never has to read a status code itself. */
	async function page(target: string, signal: AbortSignal | undefined): Promise<ResourceResult<TextPage>> {
		if (disposed) return refusal("disposed");
		let response: Response;
		try {
			response = await request(target, signal);
		} catch {
			return refusal(disposed ? "disposed" : "unavailable");
		}
		if (!response.ok) { await response.body?.cancel().catch(() => {}); return refusal(reasonOf(response.status)); }
		let body: Partial<TextPage> & { thinking?: unknown };
		try {
			body = await response.json() as Partial<TextPage> & { thinking?: unknown };
		} catch {
			return refusal("unavailable");
		}
		// A thinking block answers the same page shape under its own field name, so one reader serves both families and
		// neither route can grow a second interpretation of what a page is.
		const text = typeof body.text === "string" ? body.text : typeof body.thinking === "string" ? body.thinking : undefined;
		if (text === undefined) return refusal("unavailable");
		return { ok: true, value: { text, offset: typeof body.offset === "number" ? body.offset : 0, totalBytes: typeof body.totalBytes === "number" ? body.totalBytes : BufferLike.byteLength(text), truncated: body.truncated === true, ...(typeof body.nextOffset === "number" ? { nextOffset: body.nextOffset } : {}) } };
	}

	/** A byte length without assuming a Node global: the same UTF-8 count a browser's Blob would report. */
	const BufferLike = { byteLength: (value: string): number => (typeof Buffer === "undefined" ? new TextEncoder().encode(value).length : Buffer.byteLength(value, "utf8")) };

	return {
		resolve,
		retained: {
			get images() { return images.size; },
			get imageBytes() { return imageBytes; },
			get texts() { return texts.size; },
			get textBytes() { return textBytes; },
		},
		async text(address, readOptions) {
			const target = resolve(address);
			if (target === undefined) return refusal("not_found");
			const cached = texts.get(target);
			if (cached !== undefined) { texts.delete(target); texts.set(target, cached); return { ok: true, value: cached }; }
			if (disposed) return refusal("disposed");
			// The first page is the block as it was named; every later one is the same block at the offset it stated, so a
			// continuation can never address a different entry than the preview did.
			let assembled = "";
			let offset: number | undefined;
			for (let pages = 0; ; pages += 1) {
				if (pages > 512) return refusal("unavailable");
				const read = await page(withOffset(target, offset), readOptions?.signal);
				if (!read.ok) return read;
				if (disposed) return refusal("disposed");
				assembled += read.value.text;
				offset = read.value.nextOffset;
				if (offset === undefined) break;
			}
			if (disposed) return refusal("disposed");
			// A second reader of one address may have landed while this text was assembling. Retaining a second copy
			// would count its bytes twice against the budget and evict a block the scope is still under its bound for,
			// so the copy already held is the one that answers.
			const landed = texts.get(target);
			if (landed !== undefined) { texts.delete(target); texts.set(target, landed); return { ok: true, value: landed }; }
			texts.set(target, assembled);
			textBytes += assembled.length * 2;
			trimTexts();
			return { ok: true, value: assembled };
		},
		async image(address, readOptions) {
			const target = resolve(address);
			if (target === undefined) return refusal("not_found");
			const cached = images.get(target);
			// A read is a use: it moves its entry to the end, so the budget reclaims what this scope stopped looking at
			// rather than the blob it keeps reading.
			if (cached !== undefined && !cached.revoked) { images.delete(target); images.set(target, cached); return { ok: true, value: leaseOf(target, cached) }; }
			if (disposed) return refusal("disposed");
			let response: Response;
			try {
				response = await request(target, readOptions?.signal);
			} catch {
				return refusal(disposed ? "disposed" : "unavailable");
			}
			if (!response.ok) { await response.body?.cancel().catch(() => {}); return refusal(reasonOf(response.status)); }
			const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
			const body = await imageBody(response);
			if (!body.ok) return body;
			// The answer arrived after the scope it belonged to ended: it is dropped rather than retained into a scope
			// that is still being read, which is what keeps one connection's image out of the next one's view.
			if (disposed) return refusal("disposed");
			// Another read of this address may have landed while this body was arriving — two views of one image, a
			// replayed effect. The scope keeps one blob per address, so this read joins the blob already retained
			// instead of creating a second URL that no map entry would ever revoke.
			const landed = images.get(target);
			if (landed !== undefined) { images.delete(target); images.set(target, landed); return { ok: true, value: leaseOf(target, landed) }; }
			// The chunks are the body's own views; the cast is the one place the platform's Blob type insists on an
			// `ArrayBuffer`-backed view where a stream may hand over a `SharedArrayBuffer`-backed one.
			const held: HeldImage = { url: URL.createObjectURL(new Blob(body.value.chunks as BlobPart[], { type: mimeType })), mimeType, bytes: body.value.bytes, leases: new Set(), live: 0, revoked: false };
			images.set(target, held);
			imageBytes += held.bytes;
			trimImages();
			if (held.revoked) return refusal("oversize");
			return { ok: true, value: leaseOf(target, held) };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const held of images.values()) revoke(held);
			images.clear();
			imageBytes = 0;
			texts.clear();
			textBytes = 0;
		},
	};

	/** One lease on a retained blob: releasing it drops this lease, and the last one takes the blob with it. */
	function leaseOf(key: string, held: HeldImage): ImageLease {
		let released = false;
		const lease: MutableLease = {
			url: held.url,
			mimeType: held.mimeType,
			bytes: held.bytes,
			revoked: held.revoked,
			release: () => {
				if (released) return;
				released = true;
				held.live -= 1;
				if (held.live > 0 || held.revoked) return;
				// One address holds at most one blob — a later read of it joins the blob already retained rather than
				// replacing it — so this key still names this blob, and a lease can never untrack another one.
				images.delete(key);
				revoke(held);
			},
		};
		held.leases.add(lease);
		held.live += 1;
		return lease;
	}
}
