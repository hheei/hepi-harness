import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { saveFile, savePathOf, SAVE_CHUNK_BYTES } = await jiti.import("./file-save.ts");
const { createClient } = await jiti.import("../client.ts");

/**
 * Saving a file on the host that has no download navigation.
 *
 * A Web page's download is the browser's: the file streams to disk under its own name and the page never holds it. A
 * packaged App has no such path, so its save is a destination picker plus a file the shell writes while the connection
 * reads. What this asserts is the seam between those two: that the picker comes first, that the bytes cross in bounded
 * slices one awaited at a time, and that every way out of the middle removes what this run wrote and never touches the
 * source.
 */
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function connection(calls, answer) {
  return createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-token" },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return answer(String(url), init); },
  });
}

/**
 * A shell stand-in that records what it was asked to do.
 *
 * It is the App's own contract in the vocabulary the seam uses: a destination, a handle, appended slices, and a finish or
 * an abort. The bytes it is given are kept in `slices`, which is what makes "one awaited slice at a time" observable.
 */
function saveHost(options = {}) {
  const slices = [];
  const calls = [];
  let handle = 0;
  const host = {
    async chooseDestination(name) {
      calls.push(["choose", name]);
      return options.destination === undefined ? { path: "/home/me/" + name, overwrite: false } : options.destination;
    },
    async begin(destination) {
      calls.push(["begin", destination.path, destination.overwrite]);
      if (options.beginError) throw new Error(options.beginError);
      handle += 1;
      return handle;
    },
    async append(id, chunk) {
      calls.push(["append", id, chunk.byteLength]);
      if (options.appendError) throw new Error(options.appendError);
      slices.push(chunk);
      return slices.reduce((total, slice) => total + slice.byteLength, 0);
    },
    async finish(id) {
      calls.push(["finish", id]);
      if (options.finishError) throw new Error(options.finishError);
    },
    async abort(id) {
      calls.push(["abort", id]);
    },
  };
  return { host, calls, slices };
}

/** A body delivered in the chunks a transport actually produces, which may be far larger than the IPC bound. */
function bodyOf(size, chunkSize) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < size; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, Math.min(offset + chunkSize, size)));
      }
      controller.close();
    },
  });
}

test("the surfaces offer one save control and build no save address of their own", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (relative) => readFileSync(new URL("../" + relative, import.meta.url), "utf8");
  // The viewer and the explorer both offer the control; neither builds an anchor or a native call itself, so the two
  // paths are decided in one place rather than per surface.
  for (const file of ["components/FileViewer.tsx", "components/FileExplorer.tsx"]) {
    const source = read(file);
    assert.match(source, /FileSaveControl/, file + " offers the shared save control");
    assert.doesNotMatch(source, /href=\{download\.url\}/, file + " builds no download anchor of its own");
    assert.doesNotMatch(source, /__TAURI_INTERNALS__|@tauri-apps/, file + " reaches no platform module");
  }
  // The control itself names the two platform paths and nothing else: the browser's anchor and the shell's button.
  const control = read("components/FileSaveControl.tsx");
  assert.match(control, /savePathOf/);
  assert.doesNotMatch(control, /@tauri-apps/, "the shared tree imports no shell module");
});

test("a save reads the file it was given, in slices no larger than the IPC bound, one awaited at a time", async (t) => {
  const calls = [];
  const size = 3 * 1024 * 1024 + 17;
  const client = connection(calls, () => new Response(bodyOf(size, 5 * 1024 * 1024), { status: 200 }));
  t.after(() => client.dispose());
  const { host, slices, calls: hostCalls } = saveHost();

  const progress = [];
  const outcome = await saveFile(client, {
    routingPath: "/workspace/ws-1/big.bin",
    host,
    suggestedName: "big.bin",
    onProgress: (bytes) => progress.push(bytes),
  });

  assert.deepEqual(outcome, { kind: "saved", path: "/home/me/big.bin", bytes: size });
  // The read is the download kind: the file's own bytes, not a preview of them, and on this connection's own origin.
  assert.equal(calls[0].url, "https://gateway.example/api/files/workspace/ws-1/big.bin?type=download");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer device-token");
  // The picker is asked before anything is read: a cancelled choice is a save that never happens.
  assert.deepEqual(hostCalls[0], ["choose", "big.bin"]);
  // Every slice is at most the bound, and the file is exactly what was read.
  assert.ok(slices.length >= 4, "a 3 MiB body crossed in several slices, not one");
  for (const slice of slices) assert.ok(slice.byteLength <= SAVE_CHUNK_BYTES, "slice of " + slice.byteLength + " bytes");
  assert.equal(slices.reduce((total, slice) => total + slice.byteLength, 0), size);
  // Progress is cumulative and ends at the file's size, which is what a surface shows while it waits.
  assert.deepEqual(progress, progress.slice().sort((a, b) => a - b));
  assert.equal(progress.at(-1), size);
  assert.deepEqual(hostCalls.at(-1), ["finish", 1]);
});

test("a cancelled picker transfers nothing and is not a failure", async (t) => {
  const calls = [];
  const client = connection(calls, () => new Response(bodyOf(16, 16), { status: 200 }));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost({ destination: null });

  const outcome = await saveFile(client, { routingPath: "/workspace/ws-1/a.txt", host, suggestedName: "a.txt" });
  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(calls.length, 0, "a cancelled choice asked the Gateway for nothing");
  assert.deepEqual(hostCalls, [["choose", "a.txt"]], "and opened no file");
});

test("a refused read never creates the destination", async (t) => {
  const calls = [];
  const client = connection(calls, () => jsonResponse({ error: "The file is not there", code: "not_found" }, 404));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost();

  const outcome = await saveFile(client, { routingPath: "/workspace/ws-1/gone.txt", host, suggestedName: "gone.txt" });
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.path, null, "nothing was opened, so there is no destination to name");
  assert.match(outcome.reason, /no such file/);
  assert.deepEqual(hostCalls.map((call) => call[0]), ["choose"], "the destination was never opened");
});

test("a save that fails part-way removes the partial file and never reports success", async (t) => {
  const calls = [];
  const client = connection(calls, () => new Response(bodyOf(64 * 1024, 16 * 1024), { status: 200 }));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost({ appendError: "no space left on device" });

  const outcome = await saveFile(client, { routingPath: "/workspace/ws-1/big.bin", host, suggestedName: "big.bin" });
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.path, "/home/me/big.bin");
  assert.match(outcome.reason, /no space left/);
  assert.deepEqual(hostCalls.at(-1), ["abort", 1], "the partial file was removed by the host that wrote it");
  assert.equal(hostCalls.some((call) => call[0] === "finish"), false, "a failed save never finishes");
});

test("a failed flush is a failed save, not a file that looks complete", async (t) => {
  const calls = [];
  const client = connection(calls, () => new Response(bodyOf(32, 32), { status: 200 }));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost({ finishError: "the destination could not be committed" });

  const outcome = await saveFile(client, { routingPath: "/workspace/ws-1/a.bin", host, suggestedName: "a.bin" });
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.reason, /committed/);
  assert.deepEqual(hostCalls.at(-1), ["abort", 1]);
});

test("cancelling a save in flight stops the transfer and removes what was written", async (t) => {
  const calls = [];
  // A body that would keep producing: only the caller's abort stops it, and the source says so when it is cancelled.
  let stopped = false;
  const endless = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(64 * 1024);
      const timer = setInterval(() => {
        if (stopped) { clearInterval(timer); return; }
        try { controller.enqueue(chunk.slice()); } catch { clearInterval(timer); }
      }, 1);
    },
    cancel() { stopped = true; },
  });
  const client = connection(calls, () => new Response(endless, { status: 200 }));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost();

  const controller = new AbortController();
  const saving = saveFile(client, {
    routingPath: "/workspace/ws-1/stream.bin",
    host,
    suggestedName: "stream.bin",
    signal: controller.signal,
    onProgress: () => controller.abort(),
  });
  const outcome = await saving;
  assert.equal(outcome.kind, "cancelled");
  assert.deepEqual(hostCalls.at(-1), ["abort", 1], "the partial file this run wrote is gone");
  assert.equal(hostCalls.some((call) => call[0] === "finish"), false);
});

test("a closed connection cannot save, and a path that names no workspace is refused before anything is asked", async (t) => {
  const calls = [];
  const client = connection(calls, () => new Response(bodyOf(8, 8), { status: 200 }));
  const { host, calls: hostCalls } = saveHost();
  client.dispose();

  const closed = await saveFile(client, { routingPath: "/workspace/ws-1/a.txt", host, suggestedName: "a.txt" });
  assert.equal(closed.kind, "failed");
  assert.match(closed.reason, /closed/);
  assert.deepEqual(hostCalls, [], "a closed connection opens no destination");

  const live = connection([], () => new Response(bodyOf(8, 8), { status: 200 }));
  t.after(() => live.dispose());
  await assert.rejects(
    saveFile(live, { routingPath: "/home/me/a.txt", host, suggestedName: "a.txt" }),
    /workspace/,
  );
});

test("which path a host saves by is one decision: browser, shell, or neither", () => {
  const host = saveHost().host;
  // A cookie connection's element address is the browser's own save: nothing is read through the page.
  assert.deepEqual(savePathOf({ url: "https://gateway.example/api/files/x?type=download", reason: null }, host), {
    kind: "navigation",
    url: "https://gateway.example/api/files/x?type=download",
  });
  // A bearer connection has no address, so the shell's host is the save — and it wins over the absence, not over an
  // address: a host that had both would still be a page whose navigation already works.
  assert.deepEqual(savePathOf({ url: null, reason: "no element can carry this credential" }, host), { kind: "native", host });
  // Neither: a fixture with no shell, which states why rather than collecting the file into memory.
  assert.deepEqual(savePathOf({ url: null, reason: "no element can carry this credential" }, null), {
    kind: "none",
    reason: "no element can carry this credential",
  });
  assert.equal(savePathOf({ url: null, reason: null }, null).kind, "none");
});

test("the destination is fixed when the save starts, so a later view cannot redirect the bytes", async (t) => {
  const calls = [];
  const client = connection(calls, () => new Response(bodyOf(64, 64), { status: 200 }));
  t.after(() => client.dispose());
  const { host, calls: hostCalls } = saveHost();

  const first = saveFile(client, { routingPath: "/workspace/ws-1/one.txt", host, suggestedName: "one.txt" });
  // A second save on another file while the first is in flight is its own request and its own destination; neither
  // rewrites the other's handle.
  const second = saveFile(client, { routingPath: "/workspace/ws-1/two.txt", host, suggestedName: "two.txt" });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.kind, "saved");
  assert.equal(b.kind, "saved");
  assert.notEqual(a.path, b.path);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /one\.txt\?type=download$/);
  assert.match(calls[1].url, /two\.txt\?type=download$/);
  // Each save finished its own handle, in the order it opened them.
  assert.deepEqual(hostCalls.filter((call) => call[0] === "finish").map((call) => call[1]), [1, 2]);
});
