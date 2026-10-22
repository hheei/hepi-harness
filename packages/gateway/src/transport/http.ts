import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The two facts every transport family shares about an HTTP exchange, and nothing else.
 *
 * A family owns its own framing: which statuses its routes answer, what an envelope says, whether the body is a stream.
 * What is shared is only how a JSON request is read and how a JSON answer is written, so no family keeps a second
 * copy of the 1 MiB request bound or of the content type every one of them sends.
 */

/** The most one JSON request may be. A file that does not fit arrives as a payload body instead. */
const MAX_JSON_BYTES = 1024 * 1024;

/**
 * The JSON body of one request, or undefined when it is not JSON or is larger than a JSON request may be.
 *
 * The bound is checked while the body arrives, so an oversized request is refused without being held; what was read
 * is then dropped rather than parsed.
 */
export async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		bytes += chunk.length;
		if (bytes > MAX_JSON_BYTES) return undefined;
		chunks.push(chunk as Buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Answer one request with a JSON body at the status its route's contract names.
 *
 * A `replacer` is the one thing a family may state about how its answer is written: a capability that hands back an
 * `Error` is serialized by the code and message it carries rather than as an empty object, and that rule belongs to the
 * family whose capability can produce one.
 */
export function writeJson(response: ServerResponse, status: number, body: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body, replacer));
}
