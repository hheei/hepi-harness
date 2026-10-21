/**
 * Spike fixture server for ticket 04 (Linux x86_64 / WebKitGTK 4.1 / Tauri v2).
 *
 * Three listeners, because the spike must show what the *real* WebView enforces:
 *   18080 main: SSE, submissions, large body, result collection.
 *   18081 allowed-by-CSP second origin: CORS preflight/allow behaviour.
 *   18082 origin deliberately absent from the built CSP connect-src.
 *
 * It records server-side facts (frames actually sent, client disconnect, submission
 * count) so the harness can assert them instead of trusting the page's own report.
 */
import { createServer } from "node:http";

export const PORTS = { main: 18080, cors: 18081, blocked: 18082 };

// The WebView page origin is the Tauri custom protocol, so every fixture endpoint is
// cross-origin and must answer CORS; the first spike run proved that missing it fails
// the request with WebKit's "Load failed".
function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

export function startServer({ port, state, cors = false }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    for (const [name, value] of Object.entries(corsHeaders(req.headers.origin))) {
      res.setHeader(name, value);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/sse") return sse(req, res, url, state);
    if (url.pathname === "/submit") return submit(req, res, state);
    if (url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.facts()));
      return;
    }
    if (url.pathname === "/big") return big(req, res, url, state);
    if (url.pathname === "/upload" && req.method === "POST") return upload(req, res, url, state);
    if (url.pathname === "/mark") {
      state.marks.push({ name: url.searchParams.get("name"), at: Date.now() });
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/result" && req.method === "POST") return collect(req, res, state);
    if (url.pathname === "/hello") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from " + port);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function sse(req, res, url, state) {
  const frames = Number(url.searchParams.get("frames") ?? 5);
  const interval = Number(url.searchParams.get("interval") ?? 120);
  const dropAfter = Number(url.searchParams.get("drop_after") ?? 0);
  const id = state.facts().streams.length;
  const record = { id, frames, sent: 0, closedAt: null, aborted: false, dropAfter };
  state.streams.push(record);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    record.sent = n;
    res.write(`id: ${n}\nevent: frame\ndata: {"seq":${n},"t":${Date.now()}}\n\n`);
    if (dropAfter > 0 && n >= dropAfter) {
      clearInterval(timer);
      res.socket.destroy();
      return;
    }
    if (n >= frames) {
      clearInterval(timer);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    }
  }, interval);
  req.on("close", () => {
    clearInterval(timer);
    record.closedAt = Date.now();
    record.aborted = record.sent < frames && dropAfter === 0;
  });
}

function submit(req, res, state) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const requestId = parsed.requestId ?? "(none)";
    if (!state.submissions.has(requestId)) state.submissions.set(requestId, { requestId, text: parsed.text ?? "" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ requestId, accepted: true, count: state.submissions.size }));
  });
}

function big(req, res, url, state) {
  const bytes = Number(url.searchParams.get("bytes") ?? 1024);
  state.bigRequests.push(bytes);
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes) });
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  let sent = 0;
  const pump = () => {
    while (sent < bytes) {
      const size = Math.min(chunk.length, bytes - sent);
      sent += size;
      if (!res.write(chunk.subarray(0, size))) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  pump();
}

function upload(req, res, url, state) {
  const label = url.searchParams.get("label") ?? "upload";
  const record = { label, bytes: 0, chunks: 0, firstChunkAt: null, lastChunkAt: null, startedAt: Date.now() };
  state.uploads.push(record);
  req.on("data", (chunk) => {
    record.bytes += chunk.length;
    record.chunks += 1;
    if (record.firstChunkAt === null) record.firstChunkAt = Date.now();
    record.lastChunkAt = Date.now();
  });
  req.on("end", () => {
    record.totalMs = Date.now() - record.startedAt;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ label, bytes: record.bytes, chunks: record.chunks }));
  });
}

function collect(req, res, state) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body);
      for (const result of parsed.results ?? []) state.results.push(result);
      if (parsed.phase) state.phases[parsed.phase] = true;
    } catch (error) {
      state.results.push({ name: "harness-parse", ok: false, detail: String(error) });
    }
    res.writeHead(204);
    res.end();
  });
}

export function createState() {
  const streams = [];
  const submissions = new Map();
  const results = [];
  const bigRequests = [];
  const uploads = [];
  const marks = [];
  const phases = {};
  return {
    streams, submissions, results, bigRequests, uploads, marks, phases,
    facts() {
      return {
        streams: streams.map((s) => ({ ...s })),
        submissions: [...submissions.values()],
        bigRequests: [...bigRequests],
        uploads: uploads.map((u) => ({ ...u })),
        marks: [...marks],
        results: [...results],
        phases: { ...phases },
      };
    },
  };
}
