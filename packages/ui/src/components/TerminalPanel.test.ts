import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createTerminalWriter, terminalPath, terminalRequest, type TerminalConnection } from "../lib/terminal-client.ts";

/**
 * A platform fetch the test owns, installed on `globalThis` for the length of one case.
 *
 * The terminal seam reads `globalThis.fetch` when a connection states none, so the stub is the platform: it is what the
 * cases below replace, and what they answer through.
 */
type Answer = (url: string, init: RequestInit) => Promise<Response>;
function platformFetch(t: TestContext) {
  const previous = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: Answer = async () => Response.json({ ok: true });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });
  return {
    calls,
    answer(next: Answer) { answer = next; },
    answered: calls.length,
  };
}

test("terminal requests preserve cwd routing and surface server failures", async (t) => {
  const platform = platformFetch(t);
  const cwd = "/workspace/ws-1/sub";
  for (const [id, action, method] of [[null, undefined, "POST"], ["id", "events", "GET"], ["id", undefined, "DELETE"]] as const) {
    await terminalRequest(terminalPath(id, cwd, action), { method });
  }
  assert.deepEqual(platform.calls.map((call) => call.url), ["/api/terminal", "/api/terminal/id/events", "/api/terminal/id"].map((path) => path + "?cwd=" + encodeURIComponent(cwd)));
  platform.answer(async () => new Response("<html>Server error</html>", { status: 500 }));
  await assert.rejects(terminalRequest("/api/terminal"), /HTTP 500.*pi-web server log/);
  platform.answer(async () => Response.json({ error: "shell refused" }, { status: 403 }));
  await assert.rejects(terminalRequest("/api/terminal"), /shell refused/);
});

test("a device bearer is one explicit header, and the cookie branch states none", async (t) => {
  const platform = platformFetch(t);
  const sent = (call: { url: string; init: RequestInit }) =>
    ({ url: call.url, headers: Object.fromEntries(new Headers(call.init.headers)), credentials: call.init.credentials });
  // An App: one origin, one bearer, no cookie jar.
  const app: TerminalConnection = { origin: "https://gateway.example", credential: { kind: "bearer", token: "device-secret" } };
  await terminalRequest(terminalPath("id", "/workspace/ws"), undefined, app);
  assert.deepEqual(sent(platform.calls.at(-1)!), { url: "https://gateway.example/api/terminal/id?cwd=%2Fworkspace%2Fws", headers: { authorization: "Bearer device-secret" }, credentials: "omit" });
  // The Web page: its own origin, and the cookie the browser attaches by itself.
  await terminalRequest(terminalPath(null, "/workspace/ws"), undefined, { credential: { kind: "cookie" } });
  assert.deepEqual(sent(platform.calls.at(-1)!), { url: "/api/terminal?cwd=%2Fworkspace%2Fws", headers: {}, credentials: "same-origin" });
  // A writer presents the same identity as the stream it belongs to.
  const writer = createTerminalWriter("id", "/workspace/ws", assert.fail, app);
  try {
    writer.write("x");
    await setImmediate();
  } finally {
    await writer.stop();
  }
  assert.deepEqual(sent(platform.calls.at(-1)!), { url: "https://gateway.example/api/terminal/id?cwd=%2Fworkspace%2Fws", headers: { authorization: "Bearer device-secret", "content-type": "application/json" }, credentials: "omit" });
});

test("slow terminal delivery batches typing and keeps resize in order", async (t) => {
  const platform = platformFetch(t);
  const received: unknown[] = [];
  let releaseFirst: (() => void) | undefined;
  platform.answer(async (_url, init) => {
    received.push(JSON.parse(String(init.body)));
    if (received.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    return Response.json({ ok: true });
  });
  const writer = createTerminalWriter("id", "/workspace/ws", assert.fail);
  try {
    writer.write("a");
    writer.resize(100, 30);
    writer.write("b");
    writer.write("c\r");
    await setImmediate();
    assert.deepEqual(received, [{ type: "input", data: "a" }]);
    releaseFirst?.();
    await setImmediate();
    assert.deepEqual(received, [
      { type: "input", data: "a" }, { type: "resize", cols: 100, rows: 30 }, { type: "input", data: "bc\r" },
    ]);
  } finally {
    releaseFirst?.();
    await writer.stop();
  }
});

test("large terminal pastes preserve Unicode and failed delivery never retries queued commands", async (t) => {
  const platform = platformFetch(t);
  const chunks: string[] = [];
  platform.answer(async (_url, init) => {
    chunks.push((JSON.parse(String(init.body)) as { data: string }).data);
    return Response.json({ ok: true });
  });
  const writer = createTerminalWriter("unicode", "/workspace/ws", assert.fail);
  try {
    const text = "a".repeat(32767) + "\u{1f600}".repeat(40000);
    writer.write(text);
    await setImmediate();
    assert.equal(chunks.join(""), text);
    assert.ok(chunks.every((chunk) => chunk.length <= 65536 && chunk.isWellFormed()));
  } finally {
    await writer.stop();
  }
  const errors: string[] = [];
  let delivered = 0;
  platform.answer(async () => { delivered += 1; return Response.json({ error: "gone" }, { status: 404 }); });
  const failed = createTerminalWriter("failed", "/workspace/ws", (error) => errors.push(error.message));
  try {
    failed.write("first");
    failed.write("second");
    await setImmediate();
    assert.deepEqual(errors, ["gone"]);
    assert.equal(delivered, 1);
  } finally {
    await failed.stop();
  }
  failed.write("third");
  await setImmediate();
  assert.equal(delivered, 1);
});
