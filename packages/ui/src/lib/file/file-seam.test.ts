import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { WorkbenchClient, WorkbenchRequestError } from "../../client.ts";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createFileSeam } = await jiti.import<typeof import("./file-seam.ts")>("./file-seam.ts");
const { createClient } = await jiti.import<typeof import("../../client.ts")>("../../client.ts");

/**
 * The file surface as a surface calls it: one named seam on the connection.
 *
 * A page's explorer, viewer and composer all ask the same connection for the same things, so what they may not do is
 * assemble an address. The App is why: its document is loaded from a bundle, so a relative `/api/files/...` would ask
 * the shell itself for a file it does not serve. The seam resolves every address against the connection's own origin,
 * presents the connection's own credential, and names a file with the routing path the protocol parses — nothing here
 * knows whether it is talking to a Web page or an App.
 */
const jsonResponse = (body: unknown, status: number = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** One request a connection was asked for, as the case reads it back. */
type RecordedCall = { url: string; init: RequestInit };

/** One client over a stated answer, recording every request it was handed. */
function connection(calls: RecordedCall[], answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => jsonResponse({ ok: true })): WorkbenchClient {
  return createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-token" },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return answer(String(url), init); },
  });
}

test("a file is named by its routing path, on the connection's origin and under its own credential", async (t) => {
  const calls: RecordedCall[] = [];
  const client = connection(calls);
  t.after(() => client.dispose());
  const files = createFileSeam(client);

  await files.list("/workspace/ws-1/src");
  assert.equal(calls[0].url, "https://gateway.example/api/files/workspace/ws-1/src?type=list");
  assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bearer device-token");

  // A path is a routing path, never a filesystem one: the same file under a host's own root would name a directory
  // this connection has no address for, and is refused before a request is made.
  await assert.rejects(files.list("/home/me/project"), /workspace/);
  assert.equal(calls.length, 1, "a path that names no workspace sent nothing");

  // The upload's pre-flight check and its own body are the surface's vocabulary, on the same connection.
  await files.checkUpload("/workspace/ws-1", ["a.txt"]);
  assert.equal(calls[1].url, "https://gateway.example/api/files/workspace/ws-1?type=upload-check");
  assert.equal(calls[1].init.method, "POST");

  // Changed files and one diff are asked with the routing cwd, so the host is resolved by the Backend rather than here.
  await files.changedFiles("/workspace/ws-1");
  assert.equal(calls[2].url, "https://gateway.example/api/git/status?cwd=" + encodeURIComponent("/workspace/ws-1"));
  await files.diff("/workspace/ws-1", "/workspace/ws-1/a.txt");
  assert.equal(calls[3].url, "https://gateway.example/api/git/diff?cwd=" + encodeURIComponent("/workspace/ws-1") + "&path=" + encodeURIComponent("/workspace/ws-1/a.txt"));

  // The `@` index, both shapes.
  await files.index("/workspace/ws-1");
  assert.equal(calls[4].url, "https://gateway.example/api/file-index?cwd=" + encodeURIComponent("/workspace/ws-1"));
  await files.index("/workspace/ws-1", "app");
  assert.match(calls[5].url, /&q=app$/);
});

test("an element's address is the cookie connection's own, and a bearer connection hands out none", async (t) => {
  const cookieClient = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "cookie" },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
    fetch: async () => jsonResponse({}),
  });
  t.after(() => cookieClient.dispose());
  const files = createFileSeam(cookieClient);
  assert.equal(files.url("/workspace/ws-1/logo.png", "read"), "https://gateway.example/api/files/workspace/ws-1/logo.png?type=read");
  assert.equal(files.url("/workspace/ws-1/big.bin", "download"), "https://gateway.example/api/files/workspace/ws-1/big.bin?type=download");
  // A preview has no continuation to name: the host serves one bounded chunk, so an address that carried an offset
  // would be a request the surface answers as a limit and a viewer would draw as a "load more" that loads nothing.
  assert.equal(files.url("/workspace/ws-1/a.ts", "read"), "https://gateway.example/api/files/workspace/ws-1/a.ts?type=read");

  // The address is a path in the browser's own vocabulary, so a name the browser has to encode is encoded here: the
  // surface decodes it once, and the host is asked for the name it has. A raw space or a raw percent in the path would
  // be a different request — or, for the percent, none at all.
  assert.equal(files.url("/workspace/ws-1/my note.md", "read"), "https://gateway.example/api/files/workspace/ws-1/my%20note.md?type=read");
  assert.equal(files.url("/workspace/ws-1/100%.md", "read"), "https://gateway.example/api/files/workspace/ws-1/100%25.md?type=read");
  assert.equal(files.url("/workspace/ws-1/笔记.md", "read"), "https://gateway.example/api/files/workspace/ws-1/%E7%AC%94%E8%AE%B0.md?type=read");

  // A device bearer cannot ride an element, so this connection has no element address at all: an address invented for
  // one would be a request the Gateway answers 401 for, which a surface then reports as a failed image.
  const bearerClient = connection([]);
  t.after(() => bearerClient.dispose());
  const bearerFiles = createFileSeam(bearerClient);
  assert.equal(bearerFiles.url("/workspace/ws-1/logo.png", "read"), null);
  assert.equal(bearerFiles.url("/workspace/ws-1/big.bin", "download"), null);
  const bearerDownload = bearerFiles.download("/workspace/ws-1/big.bin");
  assert.equal(bearerDownload.kind, "unsupported");
  assert.match(bearerDownload.reason, /native save/);

  cookieClient.dispose();
  // An element that kept an address from a closed connection is pointed at nothing rather than at the next
  // connection's Gateway: a download that saved a file from another connection would be the worst kind of leak.
  assert.equal(files.url("/workspace/ws-1/big.bin", "download"), null);
  await assert.rejects(files.list("/workspace/ws-1"), /closed/);
});

test("a refusal keeps the surface's own words, so a surface shows the reason instead of an empty success", async (t) => {
  const client = connection([], () => jsonResponse({ error: "Live file watching is not connected", code: "unsupported" }, 501));
  t.after(() => client.dispose());
  const files = createFileSeam(client);
  await assert.rejects(files.list("/workspace/ws-1"), (error: WorkbenchRequestError) => {
    assert.equal(error.status, 501);
    assert.equal(error.code, "unsupported");
    assert.equal(error.message, "Live file watching is not connected");
    return true;
  });
});
test("bytes follow the credential: a cookie page streams by element, an App reads a bounded lease", async (t) => {
  const cookieCalls = [];
  const cookieClient = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "cookie" },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
    fetch: async (url, init) => { cookieCalls.push(String(url)); return jsonResponse({}); },
  });
  t.after(() => cookieClient.dispose());
  const cookieFiles = createFileSeam(cookieClient);

  // The browser's own element request carries the httpOnly cookie, so the answer is an address and nothing is read here.
  const addressed = await cookieFiles.bytes("/workspace/ws-1/a.png");
  assert.deepEqual(addressed, { kind: "address", url: "https://gateway.example/api/files/workspace/ws-1/a.png?type=read" });
  assert.equal(cookieCalls.length, 0, "a cookie page reads nothing through the connection");
  // A download is the same kind of answer: the browser navigates and saves the stream itself.
  assert.deepEqual(cookieFiles.download("/workspace/ws-1/big.bin"), {
    kind: "address",
    url: "https://gateway.example/api/files/workspace/ws-1/big.bin?type=download",
  });

  const bearerCalls: RecordedCall[] = [];
  const bearerClient = connection(bearerCalls, () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } }));
  t.after(() => bearerClient.dispose());
  const bearerFiles = createFileSeam(bearerClient);

  // No element of an App's document can present the device bearer, so the connection reads the bytes into a lease the
  // surface can show and revoke. The lease is the only address this connection hands out for them.
  const leased = await bearerFiles.bytes("/workspace/ws-1/a.png");
  assert.equal(leased.kind, "lease");
  assert.match(leased.url, /^blob:/);
  assert.equal(bearerCalls[0].url, "https://gateway.example/api/files/workspace/ws-1/a.png?type=read");
  leased.release();

  // A download on a bearer connection has no element address: the shell's native save reads this same connection and
  // writes the bytes itself, so a page that collected them into a blob instead would be doing the wrong job twice.
  const refusal = bearerFiles.download("/workspace/ws-1/big.bin");
  assert.equal(refusal.kind, "unsupported");
  assert.match(refusal.reason, /native save/);
});

test("a file larger than the connection holds in memory is refused, not silently truncated", async (t) => {
  const client = createClient({
    origin: "https://gateway.example/",
    credential: { kind: "bearer", token: "device-token" },
    limits: { imageBytes: 2 },
    createSource: () => ({ conversationId: "unused", readyState: 1, closed: false, onmessage: null, onerror: null, close() {} }),
    fetch: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } }),
  });
  t.after(() => client.dispose());
  const files = createFileSeam(client);
  const answer = await files.bytes("/workspace/ws-1/big.png");
  assert.equal(answer.kind, "unsupported");
  // The refusal is about showing this file, not about saving it: a preview past the lease's budget is refused with the
  // bound, and the surface states that reason rather than framing an empty element.
  assert.match(answer.reason, /larger than this client holds in memory, so it cannot be shown here/);
});

// The one preview request, pinned: the seam asks for the chunk and nothing else, and answers with the host's own two
// numbers. A viewer's truncation notice is drawn from those, so a preview that said its own delivered size was the
// file's end would be the false completion this contract removed.
test("a preview is one bounded chunk, asked for by the file's path alone", async (t) => {
  const calls: RecordedCall[] = [];
  const client = connection(calls, () => jsonResponse({ content: "half", language: "ts", shownBytes: 4, size: 900, truncated: true, previewOnly: true }));
  t.after(() => client.dispose());
  const files = createFileSeam(client);
  const preview = await files.read("/workspace/ws-1/a.ts");
  assert.equal(calls.length, 1, "a preview is asked for once");
  assert.equal(calls[0].url, "https://gateway.example/api/files/workspace/ws-1/a.ts?type=read");
  assert.deepEqual(preview, { content: "half", language: "ts", shownBytes: 4, size: 900, truncated: true, previewOnly: true });
});

test("the surfaces that show files assemble no address of their own", async () => {
  const { readFileSync } = await import("node:fs");
  const owned = [
    "components/FileExplorer.tsx",
    "components/SourceFilePreview.tsx",
    "components/DiffFilePreview.tsx",
    "components/MarkdownFilePreview.tsx",
    "components/ImageFilePreview.tsx",
    "components/MediaFilePreview.tsx",
    "components/DocumentFilePreview.tsx",
    "components/TextFilePreview.tsx",
    "components/ChatInput.tsx",
    "components/ChatWindow.tsx",
    "components/MarkdownBody.tsx",
    "components/MessageView.tsx",
    "lib/file/file-upload-client.ts",
  ];
  for (const file of owned) {
    const source = readFileSync(new URL("../../" + file, import.meta.url), "utf8");
    // A relative `/api/files/…` or `/api/file-index` is the one thing an App's page cannot do: the address would be the
    // shell's own, and the request would carry no credential. Every one of them goes through the seam instead.
    assert.doesNotMatch(source, /["`]\/api\/(files|file-index|git)\b/, file + " assembles a file address");
    assert.doesNotMatch(source, /new EventSource\(/, file + " opens a watcher the surface answers 501 for");
  }
});
