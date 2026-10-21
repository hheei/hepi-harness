import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalGateway, MemoryLedger, OutputCapture, type ExecuteRequest } from "../src/index.ts";
import { WorkspaceRegistry } from "../src/workspaces.ts";

/**
 * Output capture, at the gateway's real execute seam.
 *
 * A call's output is captured per stream so a repeated call ID can be answered from the ledger without running the
 * command again. The capture is bounded in UTF-8 bytes, so a verbose command costs what it wrote rather than a scan of
 * everything retained, and the retained text ends on a complete character whatever the budget cut through.
 *
 * The cases below drive real commands through `LocalGateway.execute` — the same public seam the tool surface uses —
 * and read the result back, including the repeat lookup that must answer identically without a second run.
 */

async function workspace(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "hepi-capture-"));
}

function request(callId: string, command: readonly string[]): ExecuteRequest {
	return { gatewayId: "gateway-1", workspaceId: "workspace-1", callId, command };
}

test("each stream keeps its own budget, and a cut lands on a complete character", async () => {
	const root = await workspace();
	try {
		// 4 bytes of ASCII and then a three-byte character: a 5-byte budget keeps the ASCII and cannot fit the
		// character whole, so the retained text must be exactly the ASCII and must not carry a replacement character.
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"], captureBytes: 5 });
		const result = await gateway.execute(request("utf8-1", ["/bin/bash", "-c", "printf abcd; printf '\u4f60\u597d'"]));
		assert.equal(result.ok, true);
		assert.equal(result.ok === true && result.stdout, "abcd");
		assert.equal(result.ok === true && result.stdout.includes("\ufffd"), false, "the cut produced a replacement character");
		assert.equal(result.ok === true && result.truncated, true);

		// The budget is exactly the character's size: it fits, and the next one does not.
		const exact = await gateway.execute(request("utf8-2", ["/bin/bash", "-c", "printf '\u4f60\u597d'"]));
		assert.equal(exact.ok === true && exact.stdout, "\u4f60");
		assert.equal(exact.ok === true && exact.truncated, true);
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stdout and stderr are captured separately, each under its own budget", async () => {
	const root = await workspace();
	try {
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"], captureBytes: 4 });
		const result = await gateway.execute(request("streams-1", ["/bin/bash", "-c", "printf out-stdout; printf err-stderr >&2"]));
		assert.equal(result.ok, true);
		assert.equal(result.ok === true && result.stdout, "out-", "stdout was clipped to its own budget");
		assert.equal(result.ok === true && result.stderr, "err-", "stderr was clipped to its own budget, not to stdout's");
		assert.equal(result.ok === true && result.truncated, true);

		// An empty stream is not clipped, and a call with no output at all keeps the default shape.
		const quiet = await gateway.execute(request("streams-2", ["/bin/bash", "-c", "printf x"]));
		assert.equal(quiet.ok === true && quiet.stdout, "x");
		assert.equal(quiet.ok === true && quiet.stderr, "");
		assert.equal(quiet.ok === true && quiet.truncated, undefined, "output inside the budget is not reported as truncated");
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a repeated call ID is answered from the ledger with the same bounded capture and no second run", async () => {
	const root = await workspace();
	try {
		const counter = join(root, "runs");
		await writeFile(counter, "");
		// 1 KiB per stream with a 4-byte budget: the repeated call must return exactly what the first one returned.
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"], captureBytes: 4 });
		const repeat: ExecuteRequest = { gatewayId: "gateway-1", workspaceId: "workspace-1", callId: "repeat-1", command: ["/bin/bash", "-c", "printf 'x%.0s' {1..1024} >> runs; printf abcd; printf wxyz >&2"] };
		const first = await gateway.execute(repeat);
		const repeated = await gateway.execute(repeat);
		assert.deepEqual(repeated, first, "the repeated lookup answered differently from the first run");
		assert.equal(first.ok === true && first.stdout, "abcd");
		assert.equal(first.ok === true && first.stderr, "wxyz");
		assert.equal((await readFile(counter, "utf8")).length, 1024, "the repeated call ran the command again");
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

/**
 * The scaling this ticket is about, at the real seam: the same volume in many small chunks and in one large write.
 *
 * The two commands are the same number of bytes with a different chunk count, so the *result* must be identical — the
 * capture keeps what was written, not what the writes were shaped like. The wall time of each is recorded as a
 * diagnostic and never asserted: a shell writing 256 small chunks costs what the shell costs, which is not the
 * gateway's capture work and is not a stable number on a loaded machine. The measured range for the capture itself is
 * in the ticket's evidence probe (`.dev/architecture-unification/probe-capture-scaling.ts`, log beside it), which
 * compares the old per-chunk rescan against the new chunk list on the same volume in one process.
 */
test("the same volume in many small chunks and in one large write is captured identically", { timeout: 120_000 }, async (t) => {
	const root = await workspace();
	try {
		const gateway = new LocalGateway({ id: "gateway-1", token: "secret", workspaces: new WorkspaceRegistry([{ id: "workspace-1", root }]), allowedCommands: ["bash"], captureBytes: 4 * 1024 * 1024 });
		const run = async (callId: string, script: string): Promise<{ elapsedMs: number; result: Awaited<ReturnType<typeof gateway.execute>> }> => {
			const started = process.hrtime.bigint();
			const result = await gateway.execute(request(callId, ["/bin/bash", "-c", script]));
			return { elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, result };
		};
		// 1 MiB in 256 shell writes, against the same 1 MiB in one write: the volume is the only thing held constant.
		const small = await run("scale-small", "for i in $(seq 1 256); do printf '%*s' 4096 '' | tr ' ' x; done");
		const large = await run("scale-large", "printf '%*s' 1048576 '' | tr ' ' x");
		assert.equal(small.result.ok, true);
		assert.equal(large.result.ok, true);
		const smallOut = small.result.ok === true ? small.result.stdout : "";
		const largeOut = large.result.ok === true ? large.result.stdout : "";
		assert.equal(smallOut.length, largeOut.length, "the same volume was not captured the same way");
		assert.equal(smallOut, largeOut, "the capture's content depended on how the shell chunked it");
		assert.equal(small.result.ok === true && small.result.truncated, undefined, "1 MiB inside a 4 MiB budget is not truncated");
		t.diagnostic("1 MiB: 256 small writes " + small.elapsedMs.toFixed(1) + " ms; one write " + large.elapsedMs.toFixed(1) + " ms (shell cost included; the capture range is in the probe log)");
		gateway.close();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the capture itself appends in the volume it is given and joins once", () => {
	const capture = new OutputCapture(10);
	capture.append("abcde");
	capture.append("fgh");
	assert.equal(capture.clipped, false);
	assert.equal(capture.text(), "abcdefgh");
	// Past the budget every further chunk is dropped and reported, and the retained text never grows.
	capture.append("ijklm");
	assert.equal(capture.clipped, true);
	assert.equal(capture.text(), "abcdefghij");
	capture.append("nop");
	assert.equal(capture.text(), "abcdefghij");
	// Joining is once: the same value comes back however many times it is read.
	assert.equal(capture.text(), capture.text());
});
