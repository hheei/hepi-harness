// Ticket 04 spike driver. Runs inside the real WebKitGTK WebView and reports what it
// observed to the fixture server, so results come from the native runtime, not a mock.
const tauri = window.__TAURI__;
const invoke = tauri?.core?.invoke;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail: String(detail ?? "").slice(0, 400) });
  document.getElementById("status").textContent = results.filter((r) => !r.ok).length + " failures / " + results.length;
};

let env = { resultUrl: "", mainOrigin: "http://127.0.0.1:18080" };
const report = async (phase, exit = true) => {
  if (!env.resultUrl) return;
  try {
    await fetch(env.resultUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ results, phase }),
    });
  } catch (error) {
    record("report:" + phase, false, error);
  }
  if (exit) await invoke("spike_done", { code: 0 });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sse({ url, stopAfter, onFrame, signal, headers, stopOn }) {
  const response = await fetch(url, { signal, headers: { accept: "text/event-stream", ...(headers ?? {}) } });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let count = 0;
  const seen = [];
  const events = [];
  const arrival = [];
  const started = performance.now();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      if (event === undefined) continue;
      events.push(event);
      arrival.push({ event, at: Math.round(performance.now() - started) });
      if (event === "frame") {
        count += 1;
        seen.push(count);
        onFrame?.(count);
        if (stopAfter && count >= stopAfter) {
          await reader.cancel();
          return { count, seen, events, arrival, status: response.status, cancelled: true };
        }
      }
      if (event === "done") return { count, seen, events, arrival, status: response.status, cancelled: false, sawDone: true };
      if (stopOn && events.filter((name) => stopOn.includes(name)).length >= stopOn.length) {
        await reader.cancel();
        return { count, seen, events, arrival, status: response.status, cancelled: true };
      }
    }
  }
  return { count, seen, events, arrival, status: response.status, cancelled: false, sawDone: false };
}

async function main() {
  if (!invoke) {
    record("tauri-invoke", false, "window.__TAURI__ missing");
    return;
  }
  env = await invoke("spike_env");
  record("webview-user-agent", Boolean(navigator.userAgent), navigator.userAgent);
  record("page-origin", Boolean(location.origin), location.origin + " | protocol=" + location.protocol);
  record("tauri-internals", Boolean(window.__TAURI_INTERNALS__), Object.keys(window.__TAURI__ ?? {}).join(","));
  // The environment carries the live phase's device bearer; it is reported by presence only,
  // because a report is written to disk and a credential must never be.
  record("env", true, JSON.stringify({ ...env, ingressToken: env.ingressToken ? "(present, not recorded)" : "" }));
  const mode = env.mode;
  const main = env.mainOrigin;


  if (mode === "run") {
    // 1. plain fetch through the WebView's own network stack
    const hello = await fetch(main + "/hello").then((r) => r.text());
    record("fetch-basic", hello.startsWith("hello from"), hello);

    // 2. incremental SSE: first frame must arrive well before the last
    const arrival = [];
    const started = performance.now();
    const stream = await sse({
      url: main + "/sse?frames=5&interval=200",
      onFrame: (n) => arrival.push({ n, at: Math.round(performance.now() - started) }),
    });
    record("sse-frames", stream.count === 5, JSON.stringify(stream.seen));
    record("sse-status", stream.status === 200, stream.status);
    record(
      "sse-incremental",
      arrival.length === 5 && arrival[0].at < arrival[4].at - 300,
      JSON.stringify(arrival),
    );

    // 3. client cancellation reaches the server (server marks stream aborted)
    const cancelled = await sse({ url: main + "/sse?frames=50&interval=100", stopAfter: 3 });
    record("sse-cancel-client", cancelled.cancelled && cancelled.count === 3, JSON.stringify(cancelled.seen));

    // 4. abrupt server drop: does the WebView surface an error, or a clean end?
    let dropError = "";
    let dropResult = null;
    try {
      dropResult = await sse({ url: main + "/sse?frames=50&interval=100&drop_after=3" });
    } catch (error) {
      dropError = String(error);
    }
    record("sse-drop-observation", true, JSON.stringify({ error: dropError, sawDone: dropResult?.sawDone, frames: dropResult?.count }));
    record(
      "sse-truncation-needs-protocol-signal",
      dropResult !== null && dropResult.sawDone === false,
      "stream ended after " + dropResult?.count + " frames without a done event and without an error",
    );

    // 5. submission idempotency: same requestId twice -> one server record
    const requestId = "spike-" + Date.now();
    const submit = (text) =>
      fetch(main + "/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, text }),
      }).then((r) => r.json());
    const first = await submit("first");
    const second = await submit("retry-after-lost-response");
    record("submit-twice", first.count === 1 && second.count === 1, JSON.stringify([first, second]));

    // 6. CORS: an origin inside the built CSP but on another port
    const cors = await fetch(env.corsOrigin + "/hello", { headers: { "content-type": "text/plain" } })
      .then((r) => r.text())
      .catch((error) => "ERR " + error);
    record("cors-allowed-origin", cors.startsWith("hello from"), cors);

    // 7. an origin outside the built CSP is refused by the WebView, before the server
    const blocked = await fetch(env.blockedOrigin + "/hello")
      .then((r) => r.text())
      .catch((error) => "ERR " + error);
    record("csp-blocks-unlisted-origin", blocked.startsWith("ERR"), blocked);

    // 8. large body: streamed read, JS never holds the whole file
    const bytes = 96 * 1024 * 1024;
    const savePath = env.savePath;
    const response = await fetch(main + "/big?bytes=" + bytes);
    const saveId = await invoke("begin_save", { path: savePath });
    const reader = response.body.getReader();
    const memBefore = await invoke("spike_mem");
    let received = 0;
    let peakChunk = 0;
    let chunks = 0;
    const sizes = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      chunks += 1;
      sizes.push(value.byteLength);
      peakChunk = Math.max(peakChunk, value.byteLength);
      await invoke("append_save", { id: saveId, chunk: Array.from(value) });
    }
    const memAfterStream = await invoke("spike_mem");
    const written = await invoke("finish_save", { id: saveId });
    record("big-stream-received", received === bytes, received + "/" + bytes);
    record("big-native-save", written === bytes, written + " bytes -> " + savePath);
    record("big-chunk-shape", true, JSON.stringify({ chunks, peakChunk, firstSizes: sizes.slice(0, 8), memBefore, memAfterStream }));

    // 8b. same read without IPC, to separate WebView chunking from IPC serialization cost
    const memA = await invoke("spike_mem");
    const bare = await fetch(main + "/big?bytes=" + bytes);
    const bareReader = bare.body.getReader();
    let bareBytes = 0;
    let bareChunks = 0;
    let barePeak = 0;
    for (;;) {
      const { value, done } = await bareReader.read();
      if (done) break;
      bareBytes += value.byteLength;
      bareChunks += 1;
      barePeak = Math.max(barePeak, value.byteLength);
    }
    const memB = await invoke("spike_mem");
    record(
      "big-stream-noipc",
      bareBytes === bytes,
      JSON.stringify({ bareBytes, bareChunks, barePeak, before: memA.vmHwmKb, after: memB.vmHwmKb }),
    );

    // 9. response memory ceiling: a single whole-body read, for comparison
    const whole = await fetch(main + "/big?bytes=" + bytes).then((r) => r.arrayBuffer());
    record("big-arraybuffer", whole.byteLength === bytes, whole.byteLength);

    // 10. credential store: set, read back, delete, read again
    const key = "spike-credential";
    await invoke("store_credential", { key, value: "token-" + Date.now() });
    const readBack = await invoke("read_credential", { key });
    const deleted = await invoke("delete_credential", { key });
    const afterDelete = await invoke("read_credential", { key });
    record("credential-roundtrip", typeof readBack === "string" && readBack.startsWith("token-"), readBack);
    record("credential-delete", deleted === true && afterDelete === null, JSON.stringify([deleted, afterDelete]));

    // 11. lifecycle: hide/restore through the real window, then re-read facts
    await invoke("spike_window", { action: "hide" });
    await sleep(1200);
    await invoke("spike_window", { action: "show" });
    const afterResume = await fetch(main + "/hello").then((r) => r.text());
    record("resume-fetch", afterResume.startsWith("hello from"), afterResume);

    const mem = await invoke("spike_mem");
    record("process-memory", mem.vmHwmKb > 0, JSON.stringify({ ...mem, jsHeap: performance.memory ? performance.memory.usedJSHeapSize : "unavailable" }));
    await report("run");
  }

  if (mode === "cold") {
    // 12. cold start: what survives a process kill (credential from the run phase)
    const value = await invoke("read_credential", { key: "spike-persist" });
    record("cold-credential-survives", typeof value === "string" && value.length > 0, value ?? "(none)");
    await invoke("delete_credential", { key: "spike-persist" });
    const gone = await invoke("read_credential", { key: "spike-persist" });
    record("cold-credential-deleted", gone === null, String(gone));
    await report("cold");
  }

  if (mode === "mem-bare" || mode === "mem-ipc" || mode === "mem-ipc-small") {
    // Isolated memory measurement: one fresh process per path, so the peak is this
    // path's own high-water mark rather than a previous phase's.
    const bytes = 96 * 1024 * 1024;
    const before = await invoke("spike_mem");
    const response = await fetch(main + "/big?bytes=" + bytes);
    const reader = response.body.getReader();
    let received = 0;
    let chunks = 0;
    let peak = 0;
    let saveId = null;
    if (mode !== "mem-bare") saveId = await invoke("begin_save", { path: env.savePath });
    const SLICE = 1024 * 1024;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      chunks += 1;
      peak = Math.max(peak, value.byteLength);
      if (saveId === null) continue;
      if (mode === "mem-ipc") {
        await invoke("append_save", { id: saveId, chunk: Array.from(value) });
      } else {
        // bounded variant: never hand the WebView's whole chunk to IPC at once
        for (let offset = 0; offset < value.byteLength; offset += SLICE) {
          const slice = value.subarray(offset, Math.min(offset + SLICE, value.byteLength));
          await invoke("append_save", { id: saveId, chunk: Array.from(slice) });
        }
      }
    }
    if (saveId !== null) await invoke("finish_save", { id: saveId });
    const after = await invoke("spike_mem");
    record(
      mode,
      received === bytes,
      JSON.stringify({ received, chunks, peakChunk: peak, rssBeforeKb: before.vmRssKb, hwmBeforeKb: before.vmHwmKb, rssAfterKb: after.vmRssKb, hwmAfterKb: after.vmHwmKb }),
    );
    await report(mode);
  }

  if (mode === "upload") {
    // Upload paths: a streamed request body versus a fully buffered Blob body.
    const total = 48 * 1024 * 1024;
    const chunk = new Uint8Array(1024 * 1024);
    const memStart = await invoke("spike_mem");

    let sent = 0;
    const streamBody = new ReadableStream({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk.slice());
      },
    });
    let streamResult = "";
    try {
      const response = await fetch(main + "/upload?label=readable-stream", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: streamBody,
        duplex: "half",
      });
      streamResult = await response.text();
    } catch (error) {
      streamResult = "ERR " + error;
    }
    record("upload-readable-stream", streamResult.includes('"bytes":' + total), streamResult);

    const blob = new Blob([new Uint8Array(total)]);
    const blobResult = await fetch(main + "/upload?label=blob", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
    }).then((r) => r.text()).catch((error) => "ERR " + error);
    record("upload-blob", blobResult.includes('"bytes":' + total), blobResult);

    const memEnd = await invoke("spike_mem");
    record("upload-memory", true, JSON.stringify({ before: memStart, after: memEnd }));
    await report("upload");
  }

  if (mode === "kill") {
    // Process-death evidence: open a long stream, report that it is attached, then keep
    // reading until the harness kills this process. The server records the disconnect.
    await fetch(main + "/mark?name=stream-attached");
    await report("kill-attached", false);
    const response = await fetch(main + "/sse?frames=100000&interval=100");
    const reader = response.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return;
  }

  if (mode === "smoke") {
    // Packaged-artifact smoke: the installed binary must start, render its embedded UI
    // and reach the fixture server from the packaged WebView.
    const hello = await fetch(main + "/hello").then((r) => r.text());
    record("smoke-fetch", hello.startsWith("hello from"), hello);
    await report("smoke");
  }

  if (mode === "ingress") {
    // Live ticket-03 ingress: the real Backend's conversation contract, read/submit/SSE, from
    // the real WebView, holding a device bearer the Backend issued for this run.
    const origin = env.ingressOrigin;
    const bearer = { authorization: "Bearer " + env.ingressToken, "content-type": "application/json" };
    const descriptor = await fetch(origin + "/api/descriptor", { headers: bearer }).then(async (r) => ({ status: r.status, body: await r.json() }));
    record("ingress-descriptor", descriptor.status === 200, JSON.stringify(descriptor.body).slice(0, 300));

    const created = await fetch(origin + "/api/conversations", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ requestId: "create-" + Date.now() }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    record("ingress-create", created.status === 201, JSON.stringify(created.body).slice(0, 300));
    const id = created.body?.conversationId;

    // Subscribe first, so the submission's lifecycle is observed as it arrives.
    const streamed = sse({
      url: origin + "/api/conversations/" + id + "/events",
      signal: undefined,
      headers: bearer,
      stopOn: ["submission", "state"],
    });

    const submitted = await fetch(origin + "/api/conversations/" + id + "/messages", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", conversationId: id, requestId: "req-" + Date.now(), text: "hello from the WebView" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    record("ingress-submit", submitted.status === 202, JSON.stringify(submitted.body).slice(0, 200));

    const frames = await streamed;
    record("ingress-sse-snapshot", frames.events.includes("snapshot"), JSON.stringify(frames.events));
    record("ingress-sse-submission", frames.events.includes("submission"), JSON.stringify(frames.events));
    record("ingress-sse-incremental", frames.arrival.length >= 2 && frames.arrival[0].at < frames.arrival[frames.arrival.length - 1].at, JSON.stringify(frames.arrival));

    // A read after the turn settles is the Backend's own durable transcript.
    const state = await fetch(origin + "/api/conversations/" + id + "/state", { headers: bearer }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const texts = (state.body?.entries ?? []).map((entry) => entry.text);
    record("ingress-durable-transcript", state.status === 200 && texts.includes("hello from the WebView"), JSON.stringify(texts));

    // Cancellation reaches the Backend: the caller's read ends and the ingress stream closes.
    // A conversation stream has no "frame" events, so the cancel is keyed on the first named
    // event it does send.
    const cancelled = await sse({ url: origin + "/api/conversations/" + id + "/events", headers: bearer, stopOn: ["snapshot"] });
    record("ingress-cancel", cancelled.cancelled === true && cancelled.events.includes("snapshot"), JSON.stringify(cancelled.events));

    // Ticket 07 resources: a deferred history text names a read-block address, and the WebView
    // must be able to fetch it on this origin. A policy that hides it would make the address in
    // the frame unusable for the client that received it.
    const heavy = await fetch(origin + "/api/conversations/" + env.heavyConversation + "/state", { headers: bearer }).then((r) => r.json());
    const heavyEntry = (heavy.entries ?? []).find((entry) => entry.role === "user");
    const blocks = Array.isArray(heavyEntry?.message?.content) ? heavyEntry.message.content : [];
    const deferred = blocks.find((block) => block.deferred === true);
    record("ingress-deferred-text-named", Boolean(deferred?.textUrl), JSON.stringify(deferred?.textUrl ?? blocks.map((b) => b.type)));
    if (deferred?.textUrl) {
      const page = await fetch(origin + deferred.textUrl, { headers: bearer }).then(async (r) => ({ status: r.status, body: await r.json() }));
      const restored = page.body?.text ?? "";
      record(
        "ingress-read-block-served",
        page.status === 200 && restored.startsWith(env.heavySentinel) && restored.length >= 96 * 1024,
        JSON.stringify({ status: page.status, bytes: restored.length, totalBytes: page.body?.totalBytes, truncated: page.body?.truncated }),
      );
    }

    await invoke("spike_result", { json: JSON.stringify({ results }) });
    await invoke("spike_done", { code: results.every((r) => r.ok) ? 0 : 1 });
    return;
  }

  if (mode === "persist") {
    await invoke("store_credential", { key: "spike-persist", value: "persisted-" + Date.now() });
    record("persist-write", true, "stored spike-persist");
    await report("persist");
  }

  document.getElementById("status").textContent = "done " + results.length;
}

main().catch(async (error) => {
  record("fatal", false, error?.stack ?? error);
  // The fixture phases report over HTTP; a phase with no fixture server reports on stdout,
  // so a failure inside the live-ingress phase is still visible in its own log.
  await invoke("spike_result", { json: JSON.stringify({ results }) });
  await invoke("spike_done", { code: 1 });
  await report("fatal");
});
