import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createClientIngress, type ClientIngress, type ClientIngressSettings } from "../src/ingress/index.ts";

/**
 * The Web build, served by the client ingress itself, over real HTTP and a real Vite-shaped dist directory.
 *
 * The static root here is a real temporary directory holding the files a Vite build produces — a hashed asset
 * directory, the page shell, the manifest, the service worker and the offline page — because the things being checked
 * are properties of files: their MIME, their cache policy, and whether a path can leave the root it was configured with.
 * The Backend is a stand-in that records what reached it, which is how "an unknown /api route is still the API's 404"
 * is told apart from "the page was served instead".
 */

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

const INDEX_MARKER = "<title>Pi Web</title>";
const WEB_LOGIN = "web-login-material";
const SECRET = "outside-the-root";

type Fixture = {
	origin: string;
	root: string;
	backend: Server;
	requests: string[];
	ingress: ClientIngress;
	close(): Promise<void>;
};

/** A Vite-shaped dist: hashed assets, the page shell, the manifest, the worker and the offline page. */
async function webRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "hepi-static-root-"));
	directories.push(root);
	await mkdir(join(root, "assets"), { recursive: true });
	await mkdir(join(root, "icons"), { recursive: true });
	await writeFile(join(root, "index.html"), "<!doctype html><html><head>" + INDEX_MARKER + "</head><body><div id=\"root\"></div></body></html>");
	await writeFile(join(root, "assets", "index-a1b2c3d4.js"), "console.log('bundle');\n");
	await writeFile(join(root, "assets", "index-a1b2c3d4.css"), "body{color:#000}\n");
	await writeFile(join(root, "assets", "inter-9f8e7d6c.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
	await writeFile(join(root, "assets", "logo-5a4b3c2d.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
	await writeFile(join(root, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFile(join(root, "manifest.webmanifest"), JSON.stringify({ name: "Pi Web", start_url: "/" }));
	await writeFile(join(root, "sw.js"), "self.addEventListener('install', () => {});\n");
	await writeFile(join(root, "offline.html"), "<!doctype html><title>offline</title>");
	return root;
}

/** A Backend stand-in: it records what reached it, and answers the API's own 404 for anything it does not know. */
async function stubBackend(): Promise<{ server: Server; requests: string[]; origin: string }> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push((request.method ?? "GET") + " " + (request.url ?? "/"));
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "conversation not found" }));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	return { server, requests, origin: "http://127.0.0.1:" + address.port };
}

async function fixture(options: { staticDir?: string | null; webLoginToken?: string } = {}): Promise<Fixture> {
	const root = await webRoot();
	const backend = await stubBackend();
	const settings: ClientIngressSettings = {
		backend: { origin: backend.origin, serviceToken: "backend-service-token" },
		...(options.staticDir === null ? {} : { staticDir: options.staticDir ?? root }),
		...(options.webLoginToken === undefined ? {} : { webLoginToken: options.webLoginToken }),
	};
	const ingress = createClientIngress(settings);
	await new Promise<void>(resolve => ingress.server.listen(0, "127.0.0.1", resolve));
	const address = ingress.server.address();
	assert.ok(address && typeof address === "object");
	return {
		origin: "http://127.0.0.1:" + address.port,
		root,
		backend: backend.server,
		requests: backend.requests,
		ingress,
		close: async () => { await ingress.close(); await new Promise<void>(resolve => backend.server.close(() => resolve())); },
	};
}

test("the configured Web build is served on the ingress's own origin, page shell first", async () => {
	const target = await fixture();
	try {
		const page = await fetch(target.origin + "/");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
		assert.match(await page.text(), new RegExp(INDEX_MARKER));
		assert.equal(page.headers.get("cache-control"), "no-cache", "the page shell must be revalidated");
		assert.ok(page.headers.get("etag"), "the page shell states an entity tag so a revalidation can be answered");
		assert.equal(page.headers.get("x-content-type-options"), "nosniff");
	} finally {
		await target.close();
	}
});

test("a hashed asset is immutable and carries the MIME its extension names", async () => {
	const target = await fixture();
	try {
		const script = await fetch(target.origin + "/assets/index-a1b2c3d4.js");
		assert.equal(script.status, 200);
		assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(script.headers.get("cache-control"), "public, max-age=31536000, immutable");
		assert.equal(await script.text(), "console.log('bundle');\n");
		const expected: [string, string][] = [
			["/assets/index-a1b2c3d4.css", "text/css; charset=utf-8"],
			["/assets/logo-5a4b3c2d.svg", "image/svg+xml"],
			["/assets/inter-9f8e7d6c.woff2", "font/woff2"],
			["/icons/icon-192.png", "image/png"],
			["/manifest.webmanifest", "application/manifest+json"],
		];
		for (const [path, mime] of expected) {
			const response = await fetch(target.origin + path);
			assert.equal(response.status, 200, path + " was not served");
			assert.equal(response.headers.get("content-type"), mime, path + " was served with the wrong MIME");
			await response.body?.cancel();
		}
	} finally {
		await target.close();
	}
});

test("the worker, the manifest and the offline page are revalidated rather than cached forever", async () => {
	const target = await fixture();
	try {
		for (const path of ["/sw.js", "/manifest.webmanifest", "/offline.html"]) {
			const response = await fetch(target.origin + path);
			assert.equal(response.status, 200, path + " was not served");
			assert.equal(response.headers.get("cache-control"), "no-cache", path + " would outlive the build that wrote it");
			await response.body?.cancel();
		}
	} finally {
		await target.close();
	}
});

test("a revalidation that still matches the build is answered 304 without a body", async () => {
	const target = await fixture();
	try {
		const first = await fetch(target.origin + "/assets/index-a1b2c3d4.js");
		const etag = first.headers.get("etag");
		assert.ok(etag);
		await first.body?.cancel();
		const again = await fetch(target.origin + "/assets/index-a1b2c3d4.js", { headers: { "if-none-match": etag } });
		assert.equal(again.status, 304);
		assert.equal(await again.text(), "");
	} finally {
		await target.close();
	}
});

test("HEAD answers the same headers and no body", async () => {
	const target = await fixture();
	try {
		const head = await fetch(target.origin + "/assets/index-a1b2c3d4.js", { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(head.headers.get("content-length"), String(Buffer.byteLength("console.log('bundle');\n")));
		assert.equal(await head.text(), "");
		const page = await fetch(target.origin + "/", { method: "HEAD" });
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
		assert.equal(await page.text(), "");
	} finally {
		await target.close();
	}
});

test("a missing asset is a 404, not the page", async () => {
	const target = await fixture();
	try {
		for (const path of ["/assets/missing-0f1e2d3c.js", "/icons/none.png", "/assets/chunk.woff2"]) {
			const response = await fetch(target.origin + path);
			assert.equal(response.status, 404, path + " was answered instead of being absent");
			assert.doesNotMatch(await response.text(), new RegExp(INDEX_MARKER), path + " was answered with the page shell");
		}
	} finally {
		await target.close();
	}
});

test("a navigation path that is not a file is answered by the page shell", async () => {
	const target = await fixture();
	try {
		// A trailing slash is the router's URL too: it is not a directory listing this surface publishes.
		for (const path of ["/conversations/abc", "/settings/models", "/workspace/w1/files", "/conversations/abc/"]) {
			const response = await fetch(target.origin + path);
			assert.equal(response.status, 200, path + " was not answered by the page shell");
			assert.match(await response.text(), new RegExp(INDEX_MARKER));
			assert.equal(response.headers.get("cache-control"), "no-cache");
		}
		// A path with an extension is a request for that file, even when the caller says it wants HTML.
		const asset = await fetch(target.origin + "/conversations/abc.js", { headers: { accept: "text/html" } });
		assert.equal(asset.status, 404);
	} finally {
		await target.close();
	}
});

test("a path cannot leave the configured root, by encoding, by traversal or by symlink", async () => {
	const outside = await mkdtemp(join(tmpdir(), "hepi-static-outside-"));
	directories.push(outside);
	await writeFile(join(outside, "secret.txt"), SECRET);
	const target = await fixture();
	try {
		await symlink(join(outside, "secret.txt"), join(target.root, "linked.txt"));
		for (const path of [
			"/../secret.txt",
			"/%2e%2e/secret.txt",
			"/assets/../../secret.txt",
			"/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
			"/linked.txt",
			"/..%2fsecret.txt",
		]) {
			const response = await fetch(target.origin + path);
			assert.equal(response.status, 404, path + " escaped the static root");
			assert.doesNotMatch(await response.text(), new RegExp(SECRET), path + " served a file outside the root");
		}
	} finally {
		await target.close();
	}
});

test("an unknown API route stays the API's own 404 and never the page", async () => {
	const target = await fixture({ webLoginToken: WEB_LOGIN });
	try {
		const login = await fetch(target.origin + "/api/web-login", { method: "POST", headers: { origin: target.origin, "content-type": "application/json" }, body: JSON.stringify({ token: WEB_LOGIN }) });
		assert.equal(login.status, 200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
		const response = await fetch(target.origin + "/api/no-such-route", { headers: { cookie } });
		assert.equal(response.status, 404);
		assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
		assert.doesNotMatch(await response.text(), new RegExp(INDEX_MARKER));
		assert.deepEqual(target.requests, ["GET /api/no-such-route"], "the unknown API route was not forwarded to the Backend");
		// An `/api` path is the API's even without an identity: the refusal is the API's, never the page.
		const anonymous = await fetch(target.origin + "/api/no-such-route");
		assert.equal(anonymous.status, 401);
		assert.doesNotMatch(await anonymous.text(), new RegExp(INDEX_MARKER));
		// The bare API address is the API's too, and is not a navigation to the page.
		const bare = await fetch(target.origin + "/api");
		assert.equal(bare.status, 404);
		assert.doesNotMatch(await bare.text(), new RegExp(INDEX_MARKER));
		// The internal execution surface stays absent, and the static root does not answer it either.
		assert.equal((await fetch(target.origin + "/v1/execute")).status, 404);
		// A static request is answered here: nothing about it reaches the Backend.
		assert.equal((await fetch(target.origin + "/assets/index-a1b2c3d4.js")).status, 200);
		assert.deepEqual(target.requests, ["GET /api/no-such-route"], "a static request was forwarded to the Backend");
	} finally {
		await target.close();
	}
});

test("a release that repoints the configured path serves the new build on the next request", async () => {
	const releases = await mkdtemp(join(tmpdir(), "hepi-static-releases-"));
	directories.push(releases);
	const first = join(releases, "build-1"), second = join(releases, "build-2");
	for (const [directory, marker] of [[first, "build one"], [second, "build two"]] as [string, string][]) {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "index.html"), "<!doctype html><title>" + marker + "</title>");
	}
	const current = join(releases, "current");
	await symlink(first, current);
	const target = await fixture({ staticDir: current });
	try {
		assert.match(await (await fetch(target.origin + "/")).text(), /build one/);
		// The swap is what a deploy does; the listener is not restarted for it.
		await rm(current);
		await symlink(second, current);
		assert.match(await (await fetch(target.origin + "/")).text(), /build two/, "the ingress kept serving the replaced build");
	} finally {
		await target.close();
	}
});

test("without a configured static root the ingress serves no page at all", async () => {
	const target = await fixture({ staticDir: null });
	try {
		assert.equal((await fetch(target.origin + "/")).status, 404);
		assert.equal((await fetch(target.origin + "/assets/index-a1b2c3d4.js")).status, 404);
	} finally {
		await target.close();
	}
});

test("a method other than GET or HEAD is not answered by the static root", async () => {
	const target = await fixture();
	try {
		const response = await fetch(target.origin + "/assets/index-a1b2c3d4.js", { method: "POST", body: "{}" });
		assert.equal(response.status, 404);
		assert.deepEqual(target.requests, []);
	} finally {
		await target.close();
	}
});
