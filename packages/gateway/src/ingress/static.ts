import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

/**
 * The Web build, served by the client ingress from the directory an operator configured.
 *
 * This is the page half of the same listener the client API lives on: a Vite build is a directory of files, and serving
 * one is three decisions — which file a path names, what a file is, and how long a browser may keep it. Everything else
 * about a static host (routing, rewrites, a framework runtime) is a thing this deployment does not have, so this module
 * is a file lookup and not a second application server.
 *
 * The path rule is the one that matters: a request names a file *under* the configured root or it names nothing. The
 * root and the candidate are both resolved through their real paths, so neither a traversal segment nor a symbolic link
 * inside the build can answer with a file the operator did not publish, and a path that leaves the root is absent rather
 * than refused-with-detail.
 *
 * The cache rule follows from what a build can promise. A Vite asset carries its own content hash in its file name, so
 * that name can never mean different bytes and the browser may keep it for a year. Everything else — the page shell, the
 * manifest, the service worker, the offline page, an unhashed icon — is republished under the same name on the next
 * build, so it is revalidated every time and answered `304` when nothing changed. A stale service worker is a page that
 * cannot be replaced, which is why it is never cached immutably.
 *
 * A navigation path that names no file is answered with the page shell, because the workbench routes in the browser and
 * every one of its routes is a URL a caller may open directly. A path that does name a file — anything whose last
 * segment has an extension — is a request for that file and is answered `404` when it is absent; falling back to the
 * shell there would answer a missing script with HTML, which a browser reports as a syntax error in a script rather than
 * as the missing file it is.
 */

/** How a file is announced to a browser: the type its extension names, or an opaque download. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	map: "application/json",
	webmanifest: "application/manifest+json",
	txt: "text/plain; charset=utf-8",
	xml: "application/xml",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	wasm: "application/wasm",
	mp4: "video/mp4",
	webm: "video/webm",
	pdf: "application/pdf",
};

/** A hashed asset may be kept for a year: its name states its content, so a new build cannot reuse it. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Everything else is revalidated: the same name is republished by the next build. */
const REVALIDATED = "no-cache";

/** One file request, as the ingress already read it from the wire. */
export type StaticRequest = {
	readonly method: string;
	/** The request path, still percent-encoded. */
	readonly pathname: string;
	/** The caller's own entity tag, when it is revalidating. */
	readonly ifNoneMatch?: string;
};

/**
 * Answer a request from the configured build, or state that this surface has nothing to say about it.
 *
 * `false` means the path is not this surface's to answer — a method other than `GET` or `HEAD` — and the caller
 * answers it. Every other outcome is written here, including the `404` for a path that names nothing, because "there is
 * no such file" is this surface's answer and not something a caller should have to reconstruct.
 */
export type StaticSurface = (request: StaticRequest, response: ServerResponse, headers?: Record<string, string>) => Promise<boolean>;

/** The MIME a file is served with, from its own extension. */
export function staticMimeOf(filePath: string): string {
	return MIME_BY_EXTENSION[extname(filePath).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Whether a file name states its own content, as a Vite asset does: `index-a1b2c3d4.js`.
 *
 * The hash is what makes the long cache safe, so it is read from the name rather than assumed from the directory: a file
 * an operator drops beside the build's own assets is not hashed just because it sits in `assets/`.
 */
export function isContentHashed(filePath: string): boolean {
	return /-[0-9A-Za-z_-]{8,}\.[0-9a-z]+$/.test(filePath);
}

/**
 * The path segments a request names, or `undefined` when it names no path this surface will look up.
 *
 * Decoding happens per segment and before any comparison, so an encoded `..` is refused as the traversal it is instead
 * of being decoded into a file name later. A segment that decodes to a separator is refused for the same reason: it
 * would describe a path the request did not spell.
 */
function segmentsOf(pathname: string): string[] | undefined {
	const segments: string[] = [];
	for (const raw of pathname.split("/")) {
		if (raw === "") continue;
		let segment: string;
		try { segment = decodeURIComponent(raw); } catch { return undefined; }
		if (segment === "" || segment === "." || segment === "..") return undefined;
		if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) return undefined;
		segments.push(segment);
	}
	return segments;
}

/**
 * Whether a path is a navigation — a URL a browser opens — rather than a request for one named file.
 *
 * The only signal is the last segment: a name with an extension is a request for that file, and is answered as that file
 * even when it is absent; anything else is a route the page's own router owns. A trailing slash is not a signal at all,
 * because the router owns `/conversations/abc/` as much as `/conversations/abc`, and this surface publishes no directory
 * index below the root for the slash to name.
 */
function isNavigation(segments: readonly string[]): boolean {
	const last = segments[segments.length - 1];
	return last === undefined || !last.includes(".");
}

/** Whether a caller's entity tag still describes the file that would be served. */
function matchesEntityTag(ifNoneMatch: string | undefined, etag: string): boolean {
	if (ifNoneMatch === undefined) return false;
	const strip = (tag: string): string => tag.trim().replace(/^W\//, "");
	return ifNoneMatch.split(",").some(tag => { const candidate = strip(tag); return candidate === "*" || candidate === strip(etag); });
}

export function createStaticSurface(root: string): StaticSurface {
	const configured = resolve(root);
	/**
	 * The build's real path, read per request rather than remembered.
	 *
	 * A release that swaps a `current` link to a new build directory is the ordinary way to publish one, and a remembered
	 * path would keep serving the directory that link used to name — or nothing at all, once it is gone. One `realpath`
	 * per request is the cost of a deploy being a deploy.
	 */
	async function rootReal(): Promise<string | undefined> {
		try { return await realpath(configured); } catch { return undefined; }
	}

	/**
	 * The published file a segment list names, or `undefined` when it names none.
	 *
	 * Both sides are resolved, so the comparison is between real paths: a link inside the build that points outside it
	 * resolves outside it and is refused, which a string comparison against the configured path would not catch.
	 */
	async function fileUnder(base: string, segments: readonly string[]): Promise<{ path: string; size: number; modified: number } | undefined> {
		const candidate = join(base, ...segments);
		let real: string;
		try { real = await realpath(candidate); } catch { return undefined; }
		if (real !== base && !real.startsWith(base + sep)) return undefined;
		try {
			const info = await stat(real);
			if (!info.isFile()) return undefined;
			return { path: real, size: info.size, modified: info.mtimeMs };
		} catch { return undefined; }
	}

	/** Write one file: its type, its cache policy, its entity tag, and its bytes unless this is a `HEAD` or a `304`. */
	async function send(file: { path: string; size: number; modified: number }, request: StaticRequest, response: ServerResponse, headers: Record<string, string>): Promise<void> {
		const etag = 'W/"' + file.size.toString(16) + "-" + Math.floor(file.modified).toString(16) + '"';
		const common: Record<string, string> = {
			...headers,
			"content-type": staticMimeOf(file.path),
			"cache-control": isContentHashed(file.path) ? IMMUTABLE : REVALIDATED,
			// The type is stated from the file name, so the browser must not re-decide it from the bytes.
			"x-content-type-options": "nosniff",
			etag,
		};
		if (matchesEntityTag(request.ifNoneMatch, etag)) {
			// The caller's copy is current: it keeps the bytes it already has, and learns nothing new about them.
			response.writeHead(304, common);
			response.end();
			return;
		}
		response.writeHead(200, { ...common, "content-length": String(file.size) });
		if (request.method === "HEAD") { response.end(); return; }
		// The file is piped, not collected: a build asset is the caller's socket's business, and a caller that goes away
		// ends the read with it instead of leaving the descriptor open for the rest of the response.
		const body = createReadStream(file.path);
		body.on("error", () => response.destroy());
		response.on("close", () => body.destroy());
		body.pipe(response);
	}

	function absent(response: ServerResponse, headers: Record<string, string>): void {
		response.writeHead(404, { ...headers, "content-type": "application/json", "x-content-type-options": "nosniff" });
		response.end(JSON.stringify({ error: "not found" }));
	}

	return async (request, response, headers = {}) => {
		if (request.method !== "GET" && request.method !== "HEAD") return false;
		const base = await rootReal();
		const segments = segmentsOf(request.pathname);
		if (base === undefined || segments === undefined) { absent(response, headers); return true; }
		if (segments.length > 0) {
			const named = await fileUnder(base, segments);
			if (named !== undefined) { await send(named, request, response, headers); return true; }
			// A path that names a file is a request for that file. Only a navigation may be answered with the shell.
			if (!isNavigation(segments)) { absent(response, headers); return true; }
		}
		const shell = await fileUnder(base, ["index.html"]);
		if (shell === undefined) { absent(response, headers); return true; }
		await send(shell, request, response, headers);
		return true;
	};
}
