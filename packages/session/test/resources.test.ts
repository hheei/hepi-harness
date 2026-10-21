import assert from "node:assert/strict";
import test from "node:test";
import { createResourceReader } from "../src/resources.ts";

/**
 * The read-block reader at its own boundary: which origin a wire address belongs to, and how much of an image body it
 * will read before it refuses.
 *
 * The ingress test drives this reader against a real Gateway. What is asserted here is the part that is the reader's
 * own decision and cannot be observed from the other side of a request: the Web host's relative addressing, and a body
 * that is abandoned at the scope's budget instead of buffered past it.
 */

const LIMITS = { images: 2, imageBytes: 8, texts: 2, textBytes: 1024 };

/** A platform fetch that answers with a body of the given chunks and records how many of them were pulled. */
function streaming(chunks: readonly Uint8Array[], headers: Record<string, string> = {}) {
	const pulled: number[] = [];
	let cancelled = false;
	const fetch = (async () => new Response(new ReadableStream({
		pull(controller) {
			if (pulled.length === chunks.length) { controller.close(); return; }
			pulled.push(pulled.length);
			controller.enqueue(chunks[pulled.length - 1]!);
		},
		cancel() { cancelled = true; },
	}, { highWaterMark: 0 }), { status: 200, headers })) as typeof globalThis.fetch;
	return { fetch, pulled, cancelled: () => cancelled };
}

test("a Web connection keeps read-block addresses relative, so the browser decides the origin and the cookie", async () => {
	const requested: string[] = [];
	const pages: Record<string, unknown> = {
		"/api/sessions/s/entries/e/text?blockIndex=0": { text: "first ", nextOffset: 6 },
		"/api/sessions/s/entries/e/text?blockIndex=0&offset=6": { text: "second" },
	};
	const reader = createResourceReader({
		origin: "",
		credential: { kind: "cookie" },
		fetch: (async (input: string | URL | Request) => {
			const url = String(input);
			requested.push(url);
			return new Response(JSON.stringify(pages[url]), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof globalThis.fetch,
	});
	assert.equal(reader.resolve("/api/sessions/s/entries/e/text?blockIndex=0"), "/api/sessions/s/entries/e/text?blockIndex=0");
	// A connection that states no origin is the document's own Gateway, so nothing else is served — and an absolute
	// address would be the reader deciding an origin the connection never stated.
	assert.equal(reader.resolve("https://elsewhere.example/api/sessions/s/entries/e/text?blockIndex=0"), undefined);
	assert.equal(reader.resolve("//elsewhere.example/api/sessions/s/entries/e/text?blockIndex=0"), undefined);
	assert.deepEqual(await reader.text("/api/sessions/s/entries/e/text?blockIndex=0"), { ok: true, value: "first second" });
	assert.deepEqual(requested, [
		"/api/sessions/s/entries/e/text?blockIndex=0",
		"/api/sessions/s/entries/e/text?blockIndex=0&offset=6",
	], "a continuation stays on the same relative address the block named");
	reader.dispose();
});

test("an image body is abandoned at the scope's budget instead of being buffered whole first", async () => {
	// Four 4-byte chunks against an 8-byte budget: the third crosses it, and the rest is never pulled.
	const body = streaming([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], { "content-type": "image/png" });
	const reader = createResourceReader({ origin: "https://gateway.test", credential: { kind: "cookie" }, fetch: body.fetch, limits: LIMITS });
	const read = await reader.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0");
	assert.deepEqual(read, { ok: false, reason: "oversize" });
	assert.equal(body.pulled.length, 3, "the body was read up to the bound, not to its end");
	assert.equal(body.cancelled(), true, "the unread rest of the body was cancelled");
	assert.equal(reader.retained.images, 0);
	assert.equal(reader.retained.imageBytes, 0);
	reader.dispose();
});

test("an image whose stated length is over the budget is refused without reading it at all", async () => {
	const body = streaming([new Uint8Array(4), new Uint8Array(4), new Uint8Array(4)], { "content-type": "image/png", "content-length": "12" });
	const reader = createResourceReader({ origin: "https://gateway.test", credential: { kind: "cookie" }, fetch: body.fetch, limits: LIMITS });
	assert.deepEqual(await reader.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0"), { ok: false, reason: "oversize" });
	assert.deepEqual(body.pulled, [], "a length the scope could never retain is refused before the body is read");
	reader.dispose();
});

/**
 * Two reads of one address that overlap in time, as two views of one image — or one view a development StrictMode
 * replay — produce. The scope keeps one blob per address, so the second read joins the blob the first retained rather
 * than creating a second URL nothing in the scope points at.
 */
test("two simultaneous reads of one image address keep one blob, and every lease on it is honoured", async () => {
	const live = new Set<string>();
	const create = URL.createObjectURL.bind(URL);
	const revokeObjectURL = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = (blob: Blob) => { const url = create(blob); live.add(url); return url; };
	URL.revokeObjectURL = (url: string) => { live.delete(url); revokeObjectURL(url); };
	try {
		let requests = 0;
		const reader = createResourceReader({
			origin: "https://gateway.test",
			credential: { kind: "cookie" },
			// Both reads are released together, so they are both in flight when the first body lands.
			fetch: (async () => { requests += 1; return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }); }) as typeof globalThis.fetch,
			limits: LIMITS,
		});
		const reads = await Promise.all([reader.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0"), reader.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0")]);
		assert.equal(reads[0]!.ok, true);
		assert.equal(reads[1]!.ok, true);
		const [first, second] = reads.map((read) => read.ok ? read.value : null);
		assert.ok(first !== null && second !== null);
		// One address is one blob: the second read is a second lease on it, not a second URL.
		assert.equal(second.url, first.url);
		assert.equal(live.size, 1, "one blob URL exists for the one address");
		// The budget counts the bytes actually retained, once.
		assert.equal(reader.retained.images, 1);
		assert.equal(reader.retained.imageBytes, 3);

		// Releasing one lease keeps the blob for the other, and disposal takes it whichever lease is still held.
		first.release();
		assert.equal(live.size, 1);
		assert.equal(second.revoked, false, "the remaining lease still resolves");
		reader.dispose();
		assert.equal(live.size, 0, "disposal revokes every URL the scope handed out");
		assert.equal(second.revoked, true);
		assert.equal(first.revoked, true, "a lease that already let go still learns the blob is gone");
	} finally {
		URL.createObjectURL = create;
		URL.revokeObjectURL = revokeObjectURL;
	}
});

test("a late image answer for an address read again joins the blob the scope holds", async () => {
	const live = new Set<string>();
	const create = URL.createObjectURL.bind(URL);
	const revokeObjectURL = URL.revokeObjectURL.bind(URL);
	URL.createObjectURL = (blob: Blob) => { const url = create(blob); live.add(url); return url; };
	URL.revokeObjectURL = (url: string) => { live.delete(url); revokeObjectURL(url); };
	try {
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		let requests = 0;
		const reader = createResourceReader({
			origin: "https://gateway.test",
			credential: { kind: "cookie" },
			fetch: (async () => {
				requests += 1;
				const body = requests === 1 ? [1, 2, 3] : [4, 5, 6];
				if (requests === 1) await firstGate;
				return new Response(new Uint8Array(body), { headers: { "content-type": "image/png" } });
			}) as typeof globalThis.fetch,
			limits: LIMITS,
		});
		const address = "/api/sessions/s/entries/e/tool-result-image?blockIndex=0";
		const slow = reader.image(address);
		// The address is read again while the first body is still on the wire, so two reads of it are outstanding.
		const second = await reader.image(address);
		assert.equal(second.ok, true);
		releaseFirst!();
		const late = await slow;
		assert.equal(late.ok, true, JSON.stringify(late));
		// One address is one blob: the late answer joins the blob already retained, so no URL is orphaned and the bytes
		// the scope states are the bytes it actually holds.
		assert.equal(reader.retained.images, 1);
		assert.equal(reader.retained.imageBytes, 3);
		assert.equal(live.size, 1, "one blob URL is live for the one address");
		if (late.ok && second.ok) assert.equal(late.value.url, second.value.url);
		// Releasing one lease of the address keeps the blob for the other, and the scope still tracks it: a lease can
		// only ever drop the blob it was handed, never one the scope holds for the same address.
		if (late.ok) late.value.release();
		assert.equal(reader.retained.images, 1, "the blob is still tracked after one of its leases is released");
		if (second.ok) assert.equal(second.value.revoked, false, "the remaining lease still resolves");
		reader.dispose();
		assert.equal(live.size, 0, "disposal leaves no live blob URL");
	} finally {
		URL.createObjectURL = create;
		URL.revokeObjectURL = revokeObjectURL;
	}
});

test("two simultaneous reads of one text address retain one copy of it", async () => {
	const reader = createResourceReader({
		origin: "https://gateway.test",
		credential: { kind: "cookie" },
		fetch: (async () => new Response(JSON.stringify({ text: "assembled" }), { headers: { "content-type": "application/json" } })) as typeof globalThis.fetch,
		limits: LIMITS,
	});
	const address = "/api/sessions/s/entries/e/text?blockIndex=0";
	const reads = await Promise.all([reader.text(address), reader.text(address)]);
	assert.deepEqual(reads, [{ ok: true, value: "assembled" }, { ok: true, value: "assembled" }]);
	// The budget counts the text the scope retains, so a second copy would be counted twice and evict a block the scope
	// is still under its bound for.
	assert.equal(reader.retained.texts, 1);
	assert.equal(reader.retained.textBytes, "assembled".length * 2);
	reader.dispose();
});

test("an image within the budget is still served as one blob of exactly its bytes", async () => {
	const body = streaming([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { "content-type": "image/png" });
	const reader = createResourceReader({ origin: "https://gateway.test", credential: { kind: "cookie" }, fetch: body.fetch, limits: LIMITS });
	const read = await reader.image("/api/sessions/s/entries/e/tool-result-image?blockIndex=0");
	assert.equal(read.ok, true, JSON.stringify(read));
	if (!read.ok) return;
	assert.equal(read.value.bytes, 5);
	assert.deepEqual(new Uint8Array(await (await fetch(read.value.url)).arrayBuffer()), new Uint8Array([1, 2, 3, 4, 5]));
	read.value.release();
	reader.dispose();
});
