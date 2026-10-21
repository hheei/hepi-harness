import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer } from "../src/server.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/**
 * The file payload routes end to end: the browser's own addresses on the backend, a real gateway, and the real
 * filesystem the workspace lives on. This is the seam the browser cannot test for itself — the Web adapter's half is
 * asserted against a stand-in backend, and the gateway's half against its own HTTP surface; what is asserted here is
 * that the three agree, and that a file larger than the workbench proxy's JSON request arrives whole.
 */

const SERVER_TOKEN = "server-token";
const GATEWAY_TOKEN = "gateway-token";

async function stack(): Promise<{ root: string; origin: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "hepi-files-e2e-"));
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: GATEWAY_TOKEN, workspaces, allowedCommands: [] }), undefined, new LocalFilesystem(workspaces));
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const backend = await createBackendServer({
    dbPath: join(root, "test.sqlite"),
    authToken: SERVER_TOKEN,
    workspaces: [{ id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: GATEWAY_TOKEN }],
  });
  await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.server.address();
  assert.ok(backendAddress !== null && typeof backendAddress === "object");
  return {
    root,
    origin: "http://127.0.0.1:" + backendAddress.port,
    close: async () => {
      gateway.server.closeAllConnections();
      backend.server.closeAllConnections();
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
      await new Promise<void>((resolve) => backend.server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const auth = { authorization: "Bearer " + SERVER_TOKEN };

test("a file past the workbench proxy's own request limit arrives whole, and comes back as its own bytes", async () => {
  const host = await stack();
  try {
    // Two chunks, so the relay is exercised with a body it cannot read in one piece, and a size that is not a
    // round number of anything.
    const content = Buffer.alloc(2 * 1024 * 1024 + 17, 3);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(content.subarray(0, 1024 * 1024))); controller.enqueue(new Uint8Array(content.subarray(1024 * 1024))); controller.close(); },
    });
    const uploaded = await fetch(host.origin + "/api/files/upload?cwd=" + encodeURIComponent("/workspace/local/big.bin") + "&conflict=error", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: stream,
      // Node's fetch needs the half-duplex hint for a streamed request body.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await uploaded.json(), { ok: true, value: { path: "/big.bin", size: content.byteLength, skipped: false } });
    assert.deepEqual(await readFile(join(host.root, "big.bin")), content);

    const whole = await fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/workspace/local/big.bin"), { headers: auth });
    assert.equal(whole.status, 200);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), content);

    const ranged = await fetch(host.origin + "/api/files/bytes?cwd=" + encodeURIComponent("/workspace/local/big.bin"), { headers: { ...auth, range: "bytes=1048570-1048580" } });
    assert.equal(ranged.status, 206);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), content.subarray(1048570, 1048581));
  } finally { await host.close(); }
});

test("the pre-flight check and the conflict answer are the host's own, over the real gateway", async () => {
  const host = await stack();
  try {
    await writeFile(join(host.root, "taken.txt"), "original");

    const checked = await fetch(host.origin + "/api/files/upload-check", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ cwd: "/workspace/local", fileNames: ["taken.txt", "free.txt"] }),
    });
    assert.equal(checked.status, 200);
    assert.deepEqual(await checked.json(), { ok: true, value: { conflicts: ["taken.txt"], nonReplaceable: [] } });

    const refused = await fetch(host.origin + "/api/files/upload?cwd=" + encodeURIComponent("/workspace/local/taken.txt") + "&conflict=error", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: new Blob([new Uint8Array(Buffer.from("replacement"))]),
    });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { ok: false, code: "conflict", message: "the file already exists", conflicts: ["/taken.txt"], nonReplaceable: [] });
    assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "original");

    const skipped = await fetch(host.origin + "/api/files/upload?cwd=" + encodeURIComponent("/workspace/local/taken.txt") + "&conflict=skip", {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: new Blob([new Uint8Array(Buffer.from("replacement"))]),
    });
    assert.equal(skipped.status, 200);
    assert.deepEqual(await skipped.json(), { ok: true, value: { path: "/taken.txt", size: 8, skipped: true } });
    assert.equal(await readFile(join(host.root, "taken.txt"), "utf8"), "original");
  } finally { await host.close(); }
});
