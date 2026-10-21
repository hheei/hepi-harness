/**
 * Representative transfer evidence: the batch bound, a large file's peak memory, backpressure and cancellation.
 *
 * The unit and ingress suites assert the contract. What they cannot say is what a representative transfer *costs*, and
 * ticket 08's acceptance is about memory as much as about bytes: an upload or a download that is "streamed" but peaks
 * with the file in it is not streamed. This script drives the real ingress, the real Backend and a real gateway with a
 * file at the stated size, measures this process's peak RSS, and asserts the bound and the cancellation.
 *
 * It is a measurement, not a gate: the numbers are printed with the revision so the record can name them.
 *
 * The size defaults to the host's own per-file ceiling (`MAX_FILE_BYTES`, 16 MiB), because that is the largest single
 * file this surface will ever move: a bigger one is refused by policy, not streamed. The batch bound is exercised with
 * several files whose total passes it.
 *
 * Usage: node packages/gateway/test/file-transfer-evidence.ts [--megabytes=16] [--keep]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway, WorkspaceRegistry } from "../src/index.ts";
import { LocalFilesystem } from "../src/filesystem.ts";
import { GatewayWorkbench } from "../src/workbench/index.ts";
import { createClientIngress } from "../src/ingress/index.ts";
import { createBackendServer } from "../../../apps/server/src/server.ts";
import { createDeviceCredentials } from "../../../apps/server/src/device-credentials.ts";
import { SERVER_MODEL } from "../../../apps/server/test/faux-fixture.ts";

const megabytes = Number((process.argv.find((argument) => argument.startsWith("--megabytes=")) ?? "--megabytes=16").split("=")[1]);
const keep = process.argv.includes("--keep");
const MEGABYTE = 1024 * 1024;
const SIZE = megabytes * MEGABYTE;
/** The batch bound: above one file, so the batch refusal is exercised with several files rather than one big one. */
const BOUND = Math.ceil(SIZE * 1.25 / MEGABYTE) * MEGABYTE;

const peakRss = (): number => process.resourceUsage().maxRSS * 1024;
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const format = (bytes: number): string => (bytes / MEGABYTE).toFixed(1) + " MiB";

const directory = await mkdtemp(join(tmpdir(), "hepi-transfer-evidence-"));
const root = join(directory, "workspace");
await mkdir(root);
const registry = new WorkspaceRegistry([{ id: "local", root }]);
const files = new LocalFilesystem(registry, { identity: { user: "operator", home: directory } });
const gateway = new GatewayRpcServer(
	new LocalGateway({ id: "workstation", token: "evidence-gateway-token", workspaces: registry, allowedCommands: [] }),
	new GatewayWorkbench(registry),
	files,
);
await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.server.address();
assert.ok(gatewayAddress !== null && typeof gatewayAddress === "object");
const binding = { gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "evidence-gateway-token" };
const models = createModels();
models.setProvider(fauxProvider().provider);
const credentials = createDeviceCredentials({ path: join(directory, "device-credentials.sqlite") });
const backend = await createBackendServer({
	dbPath: join(directory, "conversations.sqlite"),
	authToken: "evidence-backend-token",
	models,
	gateways: [binding],
	workspaces: [{ id: "local", ...binding }],
	deviceCredentials: credentials,
	defaultModel: SERVER_MODEL,
});
await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
const backendAddress = backend.server.address();
assert.ok(backendAddress !== null && typeof backendAddress === "object");
const ingress = createClientIngress({
	backend: { origin: "http://127.0.0.1:" + backendAddress.port, serviceToken: "evidence-backend-token" },
	webLoginToken: "evidence-login",
	uploadBatchBytes: BOUND,
});
await new Promise<void>((resolve) => ingress.server.listen(0, "127.0.0.1", resolve));
const ingressAddress = ingress.server.address();
assert.ok(ingressAddress !== null && typeof ingressAddress === "object");
const origin = "http://127.0.0.1:" + ingressAddress.port;

const login = await fetch(origin + "/api/web-login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: "evidence-login" }) });
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
const headers = { cookie, origin };

try {
	// ---- the upload: a body of the stated size, sent as a form the browser could really send.
	const payload = Buffer.alloc(SIZE, 9);
	const boundary = "----hepi-evidence-boundary";
	const form = new FormData();
	form.append("files", new Blob([new Uint8Array(payload)]), "large.bin");
	const beforeUpload = peakRss();
	const uploadStarted = process.hrtime.bigint();
	const uploaded = await fetch(origin + "/api/files/workspace/local?type=upload&conflict=error", { method: "POST", headers, body: form });
	const uploadMs = Number(process.hrtime.bigint() - uploadStarted) / 1e6;
	assert.equal(uploaded.status, 200, await uploaded.text().catch(() => ""));
	const landed = await readFile(join(root, "large.bin"));
	assert.equal(sha(landed), sha(payload), "the upload did not land byte for byte");
	const afterUpload = peakRss();
	console.log("upload  " + megabytes + " MiB form: " + uploadMs.toFixed(0) + " ms, peak RSS " + format(afterUpload) + " (before " + format(beforeUpload) + "), sha256 " + sha(landed).slice(0, 16));

	// ---- the download: read incrementally, with a reader that pauses, so backpressure is exercised rather than assumed.
	const downloadStarted = process.hrtime.bigint();
	const response = await fetch(origin + "/api/files/workspace/local/large.bin?type=download", { headers });
	assert.equal(response.status, 200);
	const reader = response.body!.getReader();
	const digest = createHash("sha256");
	let received = 0;
	let chunks = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		digest.update(value);
		received += value.byteLength;
		chunks += 1;
		// A reader that is slower than the socket: every pause is a moment the host cannot write, which is what the
		// relay's own drain wait is for. Without it the file would be collected in this process instead.
		if (chunks % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
	}
	const downloadMs = Number(process.hrtime.bigint() - downloadStarted) / 1e6;
	assert.equal(received, SIZE, "the download was not the whole file");
	assert.equal(digest.digest("hex"), sha(payload), "the download did not arrive byte for byte");
	const afterDownload = peakRss();
	console.log("download " + megabytes + " MiB in " + chunks + " chunks: " + downloadMs.toFixed(0) + " ms, peak RSS " + format(afterDownload));

	// ---- the range: a window of the same file, read from the host's own reader.
	const ranged = await fetch(origin + "/api/files/workspace/local/large.bin?type=download", { headers: { ...headers, range: "bytes=" + (SIZE - 4096) + "-" } });
	assert.equal(ranged.status, 206);
	const window = Buffer.from(await ranged.arrayBuffer());
	assert.equal(window.byteLength, 4096);
	assert.deepEqual(window, payload.subarray(SIZE - 4096));
	console.log("range   last 4096 bytes: 206, " + window.byteLength + " bytes, peak RSS " + format(peakRss()));

	// ---- cancellation: a download abandoned mid-body releases the host reader rather than holding it.
	const aborted = new AbortController();
	const stalled = await fetch(origin + "/api/files/workspace/local/large.bin?type=download", { headers, signal: aborted.signal });
	const stalledReader = stalled.body!.getReader();
	await stalledReader.read();
	const openBefore = files.readers.handles.size;
	assert.equal(openBefore, 1, "the host reader was not opened for the download");
	aborted.abort();
	await stalledReader.cancel().catch(() => undefined);
	for (let waited = 0; waited < 200 && files.readers.handles.size > 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(files.readers.handles.size, 0, "the host reader outlived the caller that opened it");
	console.log("abort   mid-download: host reader released, peak RSS " + format(peakRss()));

	// ---- the bound: a batch whose total passes it is refused while it is still arriving, and nothing is written. Each
	// file is inside the host's own ceiling, so the refusal is the batch bound's and not the host's.
	const batch = new FormData();
	const files_in_batch = 3;
	const each = Math.ceil(BOUND * 1.2 / files_in_batch);
	for (let index = 0; index < files_in_batch; index += 1) batch.append("files", new Blob([new Uint8Array(Buffer.alloc(each, index + 1))]), "over-" + index + ".bin");
	const over = await fetch(origin + "/api/files/workspace/local?type=upload&conflict=overwrite", { method: "POST", headers, body: batch });
	assert.equal(over.status, 413);
	const refusal = await over.json() as { error: string };
	assert.equal(refusal.error, "The upload is larger than the " + BOUND + " bytes one upload may carry in total");
	for (let index = 0; index < files_in_batch; index += 1) await assert.rejects(() => stat(join(root, "over-" + index + ".bin")), "a refused batch left a file behind");
	console.log("bound   " + format(BOUND) + " batch of " + files_in_batch + " x " + format(each) + ": 413 with the bound, nothing written, peak RSS " + format(peakRss()));

	console.log("peak RSS for a " + megabytes + " MiB transfer: " + format(peakRss()) + " (a whole-file buffer would be at least " + format(SIZE) + ")");
} finally {
	await ingress.close();
	await backend.close();
	credentials.close();
	gateway.server.closeAllConnections();
	await gateway.close();
	if (!keep) await rm(directory, { recursive: true, force: true });
	else console.log("kept: " + directory);
}
