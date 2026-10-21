import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import type { WorkbenchClient } from "../../client.ts";
import type { FileSaveHost, SaveHandle } from "./file-save.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { saveFile, SAVE_CHUNK_BYTES } = await jiti.import<typeof import("./file-save.ts")>("./file-save.ts");
const { createClient } = await jiti.import<typeof import("../../client.ts")>("../../client.ts");

/**
 * The save seam against a real server and a real file.
 *
 * Everything here is measured rather than simulated: a Node HTTP server streams a body of a known digest, the seam reads
 * it through a real connection, and a host adapter writes the slices to a file this test owns. Three things are stated,
 * and each is why the path exists: the bytes on disk are the bytes that were served; no slice crossed the bound; and the
 * resident memory this process holds **while saving** does not scale with the file — which is what a whole-file buffer
 * would do, and what ticket 04 measured at ~3 GB when one WebView chunk crossed IPC.
 *
 * The memory figure is a sample, not a high-water mark: `process.resourceUsage().maxRSS` never falls, so comparing two
 * saves by it would measure the first one twice. The seam reports progress after every slice, which is where the sample
 * is taken, and the largest of those is what is compared.
 *
 * The fixture directory is this test's own, under the OS temp dir; nothing here reads or writes a file a person has.
 */

/** A body of `size` bytes with a digest the test can compare, written from one block so the server holds no copy. */
function payload(size: number): { block: Buffer; sha256: string } {
  const block = Buffer.alloc(64 * 1024);
  for (let index = 0; index < block.length; index += 1) block[index] = index % 251;
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += block.length) hash.update(block.subarray(0, Math.min(block.length, size - offset)));
  return { block, sha256: hash.digest("hex") };
}

/** One server that streams a body of exactly `size` bytes, or only `deliver` of them and then hangs up. */
async function serve(size: number, { deliver = size }: { deliver?: number } = {}): Promise<{ server: Server; sha256: string; port: number }> {
  const { block, sha256 } = payload(size);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size) });
    let sent = 0;
    const write = () => {
      while (sent < deliver) {
        const chunk = block.subarray(0, Math.min(block.length, deliver - sent));
        sent += chunk.length;
        if (!response.write(chunk)) { response.once("drain", write); return; }
      }
      // A host that hangs up mid-body: the stated length is never delivered and the connection goes away, which is what
      // a dropped SSH host or an interrupted relay looks like to a reader.
      if (deliver < size) response.destroy();
      else response.end();
    };
    write();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "the server states the port it listened on");
  return { server, sha256, port: address.port };
}

function client(port: number): WorkbenchClient {
  return createClient({
    origin: "http://127.0.0.1:" + port,
    credential: { kind: "bearer", token: "device-token" },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
  });
}

/** A host that writes to a real file, counting what it was handed. */
function fileHost(directory: string, name: string) {
  const path = join(directory, name);
  let stream: ReturnType<typeof createWriteStream> | null = null;
  let bytes = 0;
  let largest = 0;
  return {
    path,
    get bytes() { return bytes; },
    get largestSlice() { return largest; },
    host: {
      async chooseDestination() { return { path, overwrite: false }; },
      async begin() { stream = createWriteStream(path); stream.on("error", () => undefined); return 1; },
      async append(_handle: SaveHandle, chunk: Uint8Array) {
        largest = Math.max(largest, chunk.byteLength);
        bytes += chunk.byteLength;
        const writing = stream;
        assert.ok(writing !== null, "the destination was opened before a slice was appended");
        await new Promise<void>((resolve) => writing.write(Buffer.from(chunk), () => resolve()));
        return bytes;
      },
      async finish() {
        const ending = stream;
        assert.ok(ending !== null, "a finish follows a begin on this host");
        await new Promise<void>((resolve) => ending.end(() => resolve()));
      },
      async abort() {
        if (stream !== null) {
          const ending = stream;
          stream = null;
          ending.on("error", () => undefined);
          await new Promise<void>((resolve) => { ending.destroy(); resolve(); });
        }
        rmSync(path, { force: true });
      },
    },
  };
}

test("a real body is saved to a real file with the same digest, in bounded slices, without growing with the file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hepi-save-io-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  /** One measured save: the digest on disk, the largest slice, and the resident memory held while it ran. */
  async function measured(size: number, name: string): Promise<{ growthMb: number; largestSlice: number }> {
    const { server, sha256, port } = await serve(size);
    const connection = client(port);
    const target = fileHost(directory, name);
    try {
      const baseline = process.memoryUsage().rss;
      let peak = baseline;
      const outcome = await saveFile(connection, {
        routingPath: "/workspace/ws-1/" + name,
        host: target.host,
        suggestedName: name,
        onProgress: () => { peak = Math.max(peak, process.memoryUsage().rss); },
      });
      assert.deepEqual(outcome, { kind: "saved", path: target.path, bytes: size });
      assert.equal(statSync(target.path).size, size);
      assert.equal(createHash("sha256").update(readFileSync(target.path)).digest("hex"), sha256, "the file on disk is the body that was served");
      assert.equal(target.bytes, size);
      assert.ok(target.largestSlice <= SAVE_CHUNK_BYTES, "largest slice " + target.largestSlice + " bytes");
      return { growthMb: (peak - baseline) / 1024 / 1024, largestSlice: target.largestSlice };
    } finally {
      connection.dispose();
      server.closeAllConnections();
      server.close();
    }
  }

  const small = await measured(8 * 1024 * 1024, "small.bin");
  // Sixteen times the file. A path that collected the body would need sixteen times the memory; a bounded one needs what
  // the transport and the platform hand over, which does not scale with the file.
  const large = await measured(128 * 1024 * 1024, "large.bin");
  console.log("  8 MiB save: +" + small.growthMb.toFixed(1) + " MiB resident, largest slice " + small.largestSlice + " B");
  console.log("  128 MiB save: +" + large.growthMb.toFixed(1) + " MiB resident, largest slice " + large.largestSlice + " B");
  assert.ok(
    large.growthMb < small.growthMb + 32,
    "a sixteen-times-larger file held " + (large.growthMb - small.growthMb).toFixed(1) + " MiB more, which scales with the file",
  );
});

test("a host that hangs up mid-body is a failed save, not a short file that looks complete", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "hepi-save-io-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { server, port } = await serve(8 * 1024 * 1024, { deliver: 2 * 1024 * 1024 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const connection = client(port);
  t.after(() => connection.dispose());

  // A recording host: what this test states is the seam's decision about a truncated body, and the real-file cleanup of
  // an aborted save is measured above and in the shell's own tests.
  const path = join(directory, "partial.bin");
  let opened = false;
  let aborted = false;
  let finished = false;
  const host: FileSaveHost = {
    async chooseDestination() { return { path, overwrite: false }; },
    async begin() { opened = true; return 1; },
    async append(_handle: SaveHandle, chunk: Uint8Array) { return chunk.byteLength; },
    async finish() { finished = true; },
    async abort() { aborted = true; },
  };

  const outcome = await saveFile(connection, { routingPath: "/workspace/ws-1/partial.bin", host, suggestedName: "partial.bin" });
  assert.ok(opened, "the destination was opened before the body was read");
  assert.equal(outcome.kind, "failed", "a short body is not a saved file");
  assert.equal(finished, false, "a truncated body is never finished");
  assert.equal(aborted, true, "and what was written is removed");
});
