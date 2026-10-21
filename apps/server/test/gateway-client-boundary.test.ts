import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The backend's gateway transport boundary, asserted as a property of the source.
 *
 * One client owns the origin join, the bearer header, each route's bound and the classification of a lost answer. A
 * route that built its own `/v1/*` request would be a second policy: it would pick its own timeout, forget that a lost
 * mutation may have run, or spell an error code of its own. That divergence is invisible to a type — both spellings
 * compile — and only shows up between two routes at runtime, so it is checked here instead: production server code
 * reaches a gateway through `GatewayHostClient`, and the relays that own Node streams do so through the capability
 * methods that hand back a response.
 */

const SERVER_SOURCE = new URL("../src/", import.meta.url);

/** A source with its comments removed, so prose about a route is never read as a route. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Every production source file of this backend. Tests are not production call sites. */
async function sources(): Promise<{ readonly path: string; readonly text: string }[]> {
	const found: { path: string; text: string }[] = [];
	for (const entry of await readdir(SERVER_SOURCE, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
		found.push({ path: entry.name, text: code(await readFile(join(SERVER_SOURCE.pathname, entry.name), "utf8")) });
	}
	return found;
}

test("no server production source builds a gateway request of its own", async () => {
	const offenders: string[] = [];
	for (const source of await sources()) {
		// The route and the header are the client's. A `/v1/*` path, a fetch of a resolved binding origin or a bearer
		// header carrying that binding's token would each be a second transport written beside the one that owns them.
		if (/["`]\/v1\//.test(source.text)) offenders.push(source.path + " writes a /v1 route");
		if (/fetch\([^)]*gatewayOrigin/.test(source.text)) offenders.push(source.path + " fetches a binding origin itself");
		if (/Bearer[\s\S]{0,40}gatewayToken|gatewayToken[\s\S]{0,40}Bearer/.test(source.text)) offenders.push(source.path + " writes a gateway bearer header");
	}
	assert.deepEqual(offenders, [], "a gateway request was constructed outside GatewayHostClient:\n" + offenders.join("\n"));
});

test("no server production source names a deleted gateway client", async () => {
	const offenders = (await sources()).filter(source => /gatewayInstalls|GatewayRpcClient/.test(source.text)).map(source => source.path);
	assert.deepEqual(offenders, [], "a deleted gateway client is still referenced: " + offenders.join(", "));
});
