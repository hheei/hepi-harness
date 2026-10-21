import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { thinkingUrl } from "@hepi/protocol";
import { createBackendServer, type BackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { openServerHarness } from "../../../apps/server/src/harness.ts";
import { MAX_READ_BLOCK_BYTES } from "../../../apps/server/src/read-block.ts";
import { fauxModels, SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";
import { createClientIngress, WEB_SESSION_COOKIE, type ClientIngress } from "../src/ingress/index.ts";
import { createResourceReader, type ResourceReader } from "../../session/src/resources.ts";

/**
 * The history, context and media resource contract, at the public seam a client really uses.
 *
 * A conversation's heavy content reaches a client as a **read block**: the history frame carries a bounded preview (or,
 * for an image, an address) and the block serves the rest. Those addresses are wire facts — the protocol builds them
 * under /api/sessions/:id/entries/:entryId/... — so a client on the client ingress has to be able to fetch them there,
 * under the same cookie or device bearer as every other call, and without the credential ever travelling in a URL.
 *
 * What this file asserts is the outcome a reader depends on: the block is served on the ingress, it is bounded by
 * default so a pathological text is never handed over whole, following its continuation rejoins the text byte for byte,
 * an image comes back as a blob lease that is revoked when it is released, every refusal is named, and a disposed
 * connection scope takes its blobs with it instead of leaking them into the next one. The Backend and the ingress are
 * the real ones; only the platform's own fetch is wrapped, because that is where a browser's cookie jar sits.
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const BACKEND_TOKEN = "backend-service-token";
const WEB_LOGIN = "web-login-material";
/** A real 1x1 RGBA PNG, so the bytes the read block serves are an image a decoder accepts. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const SENTINEL = "SENTINEL-END-OF-THE-HEAVY-TEXT";
/** Above one read-block page, so the default answer is bounded and the continuation is exercised. */
const HEAVY_TEXT_BYTES = MAX_READ_BLOCK_BYTES + 1024 * 1024;

/** A body of exactly the requested number of UTF-8 bytes whose **last** bytes are a sentinel only the whole text holds. */
function asciiText(bytes: number, sentinel: string): string {
	const line = "build log line: " + "y".repeat(60) + "\n";
	const tail = "\n" + sentinel;
	let text = "";
	while (text.length + line.length + tail.length <= bytes) text += line;
	return text + "z".repeat(bytes - text.length - tail.length) + tail;
}

/**
 * One conversation seeded on the runtime's own write path, before the Backend boots (it attaches every listed
 * conversation at startup): a heavy user text, an assistant thinking block, and a tool result carrying three images the
 * policy serves plus one it refuses.
 */
async function seed(dbPath: string): Promise<string> {
	const harness = await openServerHarness(dbPath, SERVER_MODEL, fauxModels(), undefined, { startPaused: true });
	const created = await harness.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
	const id = created.id as ConversationId;
	await harness.harness.commit(async (tx) => {
		await tx.appendEntry(UserEntry, id, { model: [{ role: "user", content: asciiText(HEAVY_TEXT_BYTES, SENTINEL), timestamp: 0 }] });
		await tx.appendEntry(AssistantEntry, id, { model: [fauxAssistantMessage([fauxThinking("a long private reasoning\nand a second line"), { type: "text", text: "the answer" }], { timestamp: 1 })] });
		await tx.appendEntry(ToolResultEntry, id, { model: [{ role: "toolResult", toolCallId: "call-image", toolName: "screenshot", content: [
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			{ type: "image", data: TINY_PNG, mimeType: "image/tiff" },
		], isError: false, timestamp: 2 }], data: { diagnostics: [] } });
	}, BACKGROUND_CONTEXT);
	await harness.close();
	return String(id);
}

type Fixture = {
	origin: string;
	backend: BackendServer;
	ingress: ClientIngress;
	conversationId: string;
	cookie: string;
	deviceToken: string;
};

/** One real Backend behind one real client ingress, with a Web session and a device bearer already admitted. */
async function fixture(t: TestContext): Promise<Fixture> {
	const directory = await mkdtemp(join(tmpdir(), "hepi-ingress-resources-"));
	directories.push(directory);
	const dbPath = join(directory, "hepi.sqlite");
	const conversationId = await seed(dbPath);
	const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
	const backend = await createBackendServer({ dbPath, authToken: BACKEND_TOKEN, models: fauxModels(), defaultModel: SERVER_MODEL, deviceCredentials: credentials, buildId: "build-1", backendId: "backend-1", accountScope: "account-1" });
	await new Promise<void>(resolve => backend.server.listen(0, "127.0.0.1", resolve));
	const address = backend.server.address();
	assert.ok(address && typeof address === "object");
	const ingress = createClientIngress({ backend: { origin: "http://127.0.0.1:" + address.port, serviceToken: BACKEND_TOKEN }, webLoginToken: WEB_LOGIN, appOrigins: ["http://app.example"] });
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const ingressAddress = ingress.server.address();
	assert.ok(ingressAddress && typeof ingressAddress === "object");
	const origin = "http://127.0.0.1:" + ingressAddress.port;
	t.after(async () => { await ingress.close(); credentials.close(); await backend.close(); });
	const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
	assert.equal(login.status, 200);
	const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
	assert.ok(cookie.startsWith(WEB_SESSION_COOKIE + "="), "the login set the Web session cookie");
	const issued = await fetch(origin + "/api/device-credentials", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "phone" }) });
	assert.equal(issued.status, 201);
	const deviceToken = ((await issued.json()) as { token: string }).token;
	return { origin, backend, ingress, conversationId, cookie, deviceToken };
}

/** A fetch that behaves the way a browser's does for a same-origin read: the HttpOnly cookie travels by itself. */
function browserFetch(cookie: string, seen: string[] = []): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		seen.push(url);
		const headers = new Headers(init?.headers);
		if (url.startsWith("http://") || url.startsWith("https://")) headers.set("cookie", cookie);
		return await fetch(input, { ...init, headers });
	}) as typeof fetch;
}

/** A fetch that states a bearer of its own, the way a native shell does: no cookie jar, one explicit credential. */
function bearerFetch(token: string): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set("authorization", "Bearer " + token);
		return await fetch(input, { ...init, headers });
	}) as typeof fetch;
}

type WireEntry = { id: string; role: string; text: string; message: { content: unknown } };
type WireBlock = { type: string; text?: string; deferred?: boolean; textUrl?: string; thinking?: string; source?: { type: string; media_type?: string; url?: string } };
const blocksOf = (entry: WireEntry): WireBlock[] => Array.isArray(entry.message.content) ? entry.message.content as WireBlock[] : [{ type: "text", text: entry.message.content as string }];

type Window = { entries: WireEntry[]; revision: number; hasMore: boolean; oldestEntryId: string | null; historyHead: string | null };

/** The conversation's window, read on the ingress: the frames' own projection, not a second model of history. */
async function windowOf(origin: string, id: string, headers: Record<string, string>): Promise<Window> {
	const response = await fetch(origin + "/api/conversations/" + id + "/state", { headers });
	assert.equal(response.status, 200);
	return await response.json() as Window;
}

/** The deferred text block the window carried, and the read-block address it names. */
function heavyTextAddress(entries: readonly WireEntry[]): string {
	const user = entries.find(entry => entry.role === "user");
	assert.ok(user !== undefined, "the heavy prompt is in the window");
	const block = blocksOf(user).find(candidate => candidate.deferred === true);
	assert.ok(block?.textUrl !== undefined, "the heavy text is deferred to a read block");
	return block.textUrl;
}

/** The image blocks the window's tool result carries, as the read-block addresses the frame named. */
function imageAddresses(entries: readonly WireEntry[]): string[] {
	const toolResult = entries.find(entry => entry.role === "toolResult");
	assert.ok(toolResult !== undefined, "the tool result is in the window");
	return blocksOf(toolResult).filter(block => block.type === "image").map(block => block.source!.url!);
}

test("a deferred text is served on the ingress in bounded pages that rejoin the whole text byte for byte", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const user = entries.find(entry => entry.role === "user")!;
	const address = heavyTextAddress(entries);
	// The wire names the protocol's own read block, under the conversation this connection was admitted to.
	assert.equal(address, "/api/sessions/" + target.conversationId + "/entries/" + user.id + "/text?blockIndex=0");

	// The block is served where the frame named it — on the client ingress, under the Web session — rather than only on
	// the Backend's internal vocabulary, which is what a client on this origin can reach.
	const first = await fetch(target.origin + address, { headers: { cookie: target.cookie } });
	assert.equal(first.status, 200, "the read block is served on the client ingress");
	const page = await first.json() as { text: string; offset: number; totalBytes: number; truncated: boolean; nextOffset?: number };
	assert.equal(page.offset, 0);
	assert.equal(page.totalBytes, HEAVY_TEXT_BYTES, "the answer states the whole text's size rather than only the piece it carried");
	assert.equal(page.truncated, true, "a text larger than one page is bounded by default");
	assert.ok(Buffer.byteLength(page.text, "utf8") <= MAX_READ_BLOCK_BYTES, "one page is bounded: " + Buffer.byteLength(page.text, "utf8"));
	assert.equal(page.text.includes(SENTINEL), false, "the tail does not ride the first page");
	assert.ok(typeof page.nextOffset === "number" && page.nextOffset > 0, "a bounded page states where it stopped");

	// Following the continuation rejoins exactly what was committed: no page is repeated, dropped or re-encoded.
	let text = page.text;
	let next: number | undefined = page.nextOffset;
	let pages = 1;
	while (next !== undefined) {
		const response: Response = await fetch(target.origin + address + "&offset=" + next, { headers: { cookie: target.cookie } });
		assert.equal(response.status, 200);
		const continued = await response.json() as { text: string; offset: number; truncated: boolean; nextOffset?: number };
		assert.equal(continued.offset, next, "the page states the offset it starts at");
		text += continued.text;
		next = continued.nextOffset;
		pages += 1;
		if (pages > 20) throw new Error("paging did not terminate");
	}
	assert.equal(Buffer.byteLength(text, "utf8"), HEAVY_TEXT_BYTES);
	assert.equal(text.endsWith(SENTINEL), true, "the last page carries the end of the text");
	assert.equal(text, asciiText(HEAVY_TEXT_BYTES, SENTINEL), "the pages rejoin the committed text exactly");
});

test("the client reader resolves the wire's read-block address against the connection origin and assembles the text", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const address = heavyTextAddress(entries);
	const seen: string[] = [];
	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie, seen) });
	t.after(() => reader.dispose());

	// A relative address resolves against the connection's Gateway, never against whatever origin happens to be
	// rendering — which is the whole failure a native shell has, where the page's own origin is the app bundle.
	assert.equal(reader.resolve(address), target.origin + address);
	const read = await reader.text(address);
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.equal(read.ok && read.value, asciiText(HEAVY_TEXT_BYTES, SENTINEL), "the reader returns the whole text, not one page");
	assert.ok(seen.length >= 2, "the reader followed the continuation instead of truncating: " + seen.length);
	assert.equal(seen.every(url => url.startsWith(target.origin + "/api/sessions/")), true, "every page was fetched from the connection's Gateway");
	assert.equal(seen.some(url => url.includes("token")), false, "no credential travels in a URL");

	// An address on another origin is refused before any request is made: a credential is only ever presented to the
	// Gateway this connection was admitted to.
	const before = seen.length;
	const foreign = await reader.text("https://elsewhere.example/api/sessions/1/entries/2/text?blockIndex=0");
	assert.deepEqual(foreign, { ok: false, reason: "not_found" }, "an address this connection does not serve is not a block it has");
	assert.equal(seen.length, before, "a foreign address was never requested");
	assert.deepEqual(await reader.text("blob:http://elsewhere.example/123"), { ok: false, reason: "not_found" });
});

test("a tool-result image becomes a blob lease that serves exactly its bytes and is reclaimed when released", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const toolResult = entries.find(entry => entry.role === "toolResult")!;
	const address = imageAddresses(entries)[0]!;
	// The frame carries the read block's address, not the bytes, and the address is this conversation's own block.
	assert.equal(address, "/api/sessions/" + target.conversationId + "/entries/" + toolResult.id + "/tool-result-image?blockIndex=0");

	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie) });
	t.after(() => reader.dispose());
	const first = await reader.image(address);
	assert.equal(first.ok, true, JSON.stringify(first));
	if (!first.ok) return;
	assert.equal(first.value.bytes, Buffer.from(TINY_PNG, "base64").byteLength);
	assert.equal(first.value.mimeType, "image/png");
	assert.equal(first.value.url.startsWith("blob:"), true, "a bounded image is a blob URL, not a re-wrapped base64 string");
	// The blob serves exactly the committed bytes, which is what makes deferral lossless for a reader.
	const served = await fetch(first.value.url);
	assert.equal(served.status, 200);
	assert.equal(Buffer.from(await served.arrayBuffer()).toString("base64"), TINY_PNG);
	assert.equal(reader.retained.images, 1);

	// One blob is shared by both readers of one address, and it is revoked only when the last lease is released.
	const second = await reader.image(address);
	assert.equal(second.ok && second.value.url, first.value.url, "one address is one retained blob");
	assert.equal(reader.retained.images, 1);
	first.value.release();
	assert.equal(first.value.revoked, false, "the blob outlives a release another lease still holds");
	assert.equal(reader.retained.images, 1);
	if (second.ok) second.value.release();
	assert.equal(reader.retained.images, 0);
	assert.equal(first.value.revoked, true);
	await assert.rejects(() => fetch(first.value.url), "a released blob URL no longer resolves");
});

test("an image read block honours a byte range, so a client never has to hold the whole image", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const address = imageAddresses(entries)[0]!;
	const total = Buffer.from(TINY_PNG, "base64").byteLength;

	const partial = await fetch(target.origin + address, { headers: { cookie: target.cookie, range: "bytes=0-9" } });
	assert.equal(partial.status, 206, "a ranged read is answered as a range");
	assert.equal(partial.headers.get("content-range"), "bytes 0-9/" + total);
	assert.equal(partial.headers.get("accept-ranges"), "bytes");
	const piece = Buffer.from(await partial.arrayBuffer());
	assert.equal(piece.byteLength, 10);
	assert.deepEqual(piece, Buffer.from(TINY_PNG, "base64").subarray(0, 10));

	// The range is answered from the block's own bytes, so a window of an image costs a window, not the whole decode.
	const tail = await fetch(target.origin + address, { headers: { cookie: target.cookie, range: "bytes=" + (total - 4) + "-" } });
	assert.equal(tail.status, 206);
	assert.equal(tail.headers.get("content-range"), "bytes " + (total - 4) + "-" + (total - 1) + "/" + total);
	assert.deepEqual(Buffer.from(await tail.arrayBuffer()), Buffer.from(TINY_PNG, "base64").subarray(total - 4));

	const unsatisfiable = await fetch(target.origin + address, { headers: { cookie: target.cookie, range: "bytes=" + total + "-" } });
	assert.equal(unsatisfiable.status, 416, "a range outside the image is refused as a range, not served anyway");
	// A whole read still states that ranges are available, which is what tells a client it may stream.
	const whole = await fetch(target.origin + address, { headers: { cookie: target.cookie } });
	assert.equal(whole.status, 200);
	assert.equal(whole.headers.get("accept-ranges"), "bytes");
	assert.equal(whole.headers.get("content-length"), String(total));
	await whole.arrayBuffer();
});

test("a device bearer reads the same blocks, and the tool-result image policy still decides what is served", async (t) => {
	const target = await fixture(t);
	const bearer = { authorization: "Bearer " + target.deviceToken };
	const entries = (await windowOf(target.origin, target.conversationId, bearer)).entries;
	const textAddress = heavyTextAddress(entries);
	const address = imageAddresses(entries)[0]!;
	const reader = createResourceReader({ origin: target.origin, credential: { kind: "bearer", token: target.deviceToken }, fetch: bearerFetch(target.deviceToken) });
	t.after(() => reader.dispose());

	const text = await reader.text(textAddress);
	assert.equal(text.ok, true, "a device reads a deferred text");
	assert.equal(text.ok && text.value.endsWith(SENTINEL), true);
	const image = await reader.image(address);
	assert.equal(image.ok, true, "a device reads a tool-result image");
	if (image.ok) {
		assert.equal(Buffer.from(await (await fetch(image.value.url)).arrayBuffer()).toString("base64"), TINY_PNG);
	}
	// The block index the policy refused in the frame is refused here too: the frame and the read block cannot disagree.
	const refused = await reader.image(address.replace("blockIndex=0", "blockIndex=3"));
	assert.deepEqual(refused, { ok: false, reason: "oversize" });
});

test("the thinking read block is reachable on the ingress and restores what the preview replaced", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const assistant = entries.find(entry => entry.role === "assistant")!;
	const thinking = blocksOf(assistant).find(block => block.type === "thinking")!;
	assert.equal(thinking.deferred, true);
	assert.equal(thinking.thinking, "a long private reasoning", "the frame carries a bounded preview");
	// The preview names no address of its own — the protocol's builder is the one fact for it, and it is the same shape.
	const address = thinkingUrl(target.conversationId, assistant.id, 0);
	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie) });
	t.after(() => reader.dispose());
	const restored = await reader.text(address);
	assert.equal(restored.ok, true, JSON.stringify(restored));
	assert.equal(restored.ok && restored.value, "a long private reasoning\nand a second line", "the whole thinking is restored, not the preview");
});

test("every refusal is named, so a surface can say what happened instead of showing an empty block", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const user = entries.find(entry => entry.role === "user")!;
	const address = heavyTextAddress(entries);

	// No identity at all: the ingress refuses before the Backend is reached.
	const anonymous = createResourceReader({ origin: target.origin, credential: { kind: "bearer", token: "" } });
	t.after(() => anonymous.dispose());
	assert.deepEqual(await anonymous.text(address), { ok: false, reason: "unauthorized" });
	// An origin this deployment never declared is refused, and the refusal is the caller's answer too.
	const foreignOrigin = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: (async (input: string | URL | Request, init?: RequestInit) => await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), cookie: target.cookie, origin: "http://unknown.example" } })) as typeof fetch });
	t.after(() => foreignOrigin.dispose());
	assert.deepEqual(await foreignOrigin.text(address), { ok: false, reason: "forbidden" });

	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie) });
	t.after(() => reader.dispose());
	// An entry this conversation does not hold is a named absence, not an empty string a surface would render as one.
	assert.deepEqual(await reader.text("/api/sessions/" + target.conversationId + "/entries/999999/text?blockIndex=0"), { ok: false, reason: "not_found" });
	assert.deepEqual(await reader.image("/api/sessions/" + target.conversationId + "/entries/" + user.id + "/tool-result-image?blockIndex=0"), { ok: false, reason: "not_found" });
	// A Backend that cannot answer is a refusal rather than a remembered success.
	const gone = await fixture(t);
	const goneReader = createResourceReader({ origin: gone.origin, credential: { kind: "bearer", token: gone.deviceToken }, fetch: bearerFetch(gone.deviceToken) });
	t.after(() => goneReader.dispose());
	await gone.ingress.close();
	await gone.backend.close();
	assert.deepEqual(await goneReader.text(address), { ok: false, reason: "unavailable" });
});

test("a disposed connection scope revokes its blobs and never writes into the next one", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const addresses = imageAddresses(entries);
	assert.ok(addresses.length >= 3);

	let release: (() => void) | undefined;
	const gate = new Promise<void>(resolve => { release = resolve; });
	let gated = true;
	const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		if (gated) await gate;
		const headers = new Headers(init?.headers);
		headers.set("cookie", target.cookie);
		return await fetch(input, { ...init, headers });
	}) as typeof fetch;

	const first = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: slowFetch });
	const inFlight = first.image(addresses[0]!);
	first.dispose();
	gated = false;
	release!();
	// The response arrives after the scope it belonged to is gone: it is dropped, not retained into a scope that is
	// still being read.
	assert.deepEqual(await inFlight, { ok: false, reason: "disposed" });
	assert.equal(first.retained.images, 0);
	assert.deepEqual(await first.text(addresses[1]!), { ok: false, reason: "disposed" });

	// The next connection is a different scope with nothing inherited from the previous one.
	const second: ResourceReader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie) });
	t.after(() => second.dispose());
	assert.equal(second.retained.images, 0);
	assert.equal(second.retained.imageBytes, 0);
	const lease = await second.image(addresses[1]!);
	assert.equal(lease.ok, true);
	// Disposing the scope takes what it held with it, so a page that switches connection cannot keep showing an image
	// the previous one loaded.
	const url = lease.ok ? lease.value.url : "";
	second.dispose();
	assert.equal(second.retained.images, 0);
	if (url !== "") await assert.rejects(() => fetch(url), "a disposed scope leaves no live blob");
});

test("the retained image budget is bounded and reclaims the least recently used blob", async (t) => {
	const target = await fixture(t);
	const entries = (await windowOf(target.origin, target.conversationId, { cookie: target.cookie })).entries;
	const addresses = imageAddresses(entries);
	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie), limits: { images: 2, imageBytes: 1024 * 1024, texts: 4, textBytes: 1024 * 1024 } });
	t.after(() => reader.dispose());

	const first = await reader.image(addresses[0]!);
	assert.equal(first.ok, true);
	const second = await reader.image(addresses[1]!);
	assert.equal(reader.retained.images, 2);
	// Reading a blob the scope already holds is a use of it, so the budget reclaims what the scope stopped looking at
	// rather than the blob it is still showing.
	const again = await reader.image(addresses[0]!);
	assert.equal(again.ok && first.ok && again.value.url, first.ok ? first.value.url : "", "a repeat read is the same blob");
	// A third blob over the count bound reclaims the least recently used one instead of growing the scope without limit.
	await reader.image(addresses[2]!);
	assert.equal(reader.retained.images, 2);
	assert.equal(second.ok && second.value.revoked, true, "the least recently used blob is revoked");
	if (second.ok) await assert.rejects(() => fetch(second.value.url), "a reclaimed blob URL no longer resolves");
	assert.equal(first.ok && first.value.revoked, false, "the blob read most recently is the one the budget keeps");
});

test("paging and the window stay the Backend's own, unchanged by reading resources", async (t) => {
	const target = await fixture(t);
	const before = await windowOf(target.origin, target.conversationId, { cookie: target.cookie });
	// Older history, by the entry id the window states as its boundary: one page, one projection, served on the ingress
	// under the same identity the stream uses.
	const boundary = before.entries.at(-1)!.id;
	const page = await fetch(target.origin + "/api/conversations/" + target.conversationId + "/entries?before=" + boundary + "&tail=50", { headers: { cookie: target.cookie } });
	assert.equal(page.status, 200);
	const body = await page.json();
	const direct = await fetch("http://127.0.0.1:" + (target.backend.server.address() as { port: number }).port + "/api/conversations/" + target.conversationId + "/entries?before=" + boundary + "&tail=50", { headers: { authorization: "Bearer " + BACKEND_TOKEN } });
	assert.deepEqual(body, await direct.json(), "the ingress forwards the Backend's page rather than projecting its own");
	// The same page under a device bearer: paging is the caller's identity, not a branch of the route.
	const byDevice = await fetch(target.origin + "/api/conversations/" + target.conversationId + "/entries?before=" + boundary + "&tail=50", { headers: { authorization: "Bearer " + target.deviceToken } });
	assert.equal(byDevice.status, 200);
	assert.deepEqual(await byDevice.json(), body, "a device pages the same history a Web session does");

	// Reading every read block the window names does not move the window, its revision or its history facts: resources
	// are transport, and the admitted snapshot stays the one fact a caller pages from.
	const reader = createResourceReader({ origin: target.origin, credential: { kind: "cookie" }, fetch: browserFetch(target.cookie) });
	t.after(() => reader.dispose());
	await reader.text(heavyTextAddress(before.entries));
	await reader.image(imageAddresses(before.entries)[0]!);
	const afterRead = await windowOf(target.origin, target.conversationId, { cookie: target.cookie });
	assert.deepEqual(afterRead, before, "a resource read leaves the admitted window exactly as it was");
});
