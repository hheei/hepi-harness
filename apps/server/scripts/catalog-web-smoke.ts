/**
 * Manual operator smoke: the model catalog as a real Web client sees it, plus one real text turn.
 *
 * The Web origin is exercised, not just the backend API, because the ticket's first outcome is what the browser's
 * catalog request reports. A controlled OpenAI-completions endpoint stands in for the paid provider: it records the
 * exact request body, so this proves the configured provider, endpoint, key and text route are preserved.
 *
 * Requires a production Web build (pnpm --filter @hepi/web build) and a free loopback port. Not part of the test suite.
 *
 *   pnpm --filter @hepi/server exec node scripts/catalog-web-smoke.ts
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createBackendServer } from "../src/server.ts";

const providerId = process.env.HEPI_SMOKE_PROVIDER ?? "magpie";
const modelId = process.env.HEPI_SMOKE_MODEL ?? "deepseek-v4.1-flash";
const token = "catalog-web-smoke-token";
const webRoot = resolve(import.meta.dirname, "..", "..", "web");

type Captured = { path: string; authorization: string | undefined; body: Record<string, unknown> };
const requests: Captured[] = [];

/**
 * The endpoint the configured provider points at. Only the completions call is recorded, so the captured requests
 * are exactly the model traffic; anything else is answered with an empty 404 instead of being parsed as JSON.
 */
function controlledEndpoint(): Promise<Server> {
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const frame = (payload: unknown): string => "data: " + JSON.stringify(payload) + "\n\n";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: "catalog web smoke OK" }, finish_reason: null }] }));
      response.write(frame({ id: "chatcmpl-smoke", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }));
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server));
  });
}

/** A throwaway listener, so probing for a free UI port cannot be mistaken for model traffic. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolveListen => probe.listen(0, "127.0.0.1", resolveListen));
  const address = probe.address();
  if (address === null || typeof address !== "object") throw new Error("no probe port");
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()));
  return address.port;
}

async function waitForWeb(origin: string): Promise<boolean> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { await fetch(origin + "/api/models"); return true; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  return false;
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log((condition ? "ok   " : "FAIL ") + message);
}

const endpoint = await controlledEndpoint();
const endpointAddress = endpoint.address();
if (endpointAddress === null || typeof endpointAddress !== "object") throw new Error("controlled endpoint did not bind");
const endpointOrigin = "http://127.0.0.1:" + endpointAddress.port;
const custom = customProviderFromEnv({ HEPI_PROVIDER: providerId, HEPI_MODEL: modelId, HEPI_PROVIDER_BASE_URL: endpointOrigin + "/v1", HEPI_PROVIDER_API_KEY: "smoke-key" });
if (custom === undefined) throw new Error("provider configuration was rejected");
const directory = await mkdtemp(join(tmpdir(), "hepi-catalog-web-smoke-"));
const backend = await createBackendServer({ dbPath: join(directory, "smoke.sqlite"), authToken: token, models: custom.models, defaultModel: custom.defaultModel });
await new Promise<void>(resolveListen => backend.server.listen(0, "127.0.0.1", resolveListen));
const backendAddress = backend.server.address();
if (backendAddress === null || typeof backendAddress !== "object") throw new Error("backend did not bind");
const backendOrigin = "http://127.0.0.1:" + backendAddress.port;
const uiPort = await freePort();
// Its own process group: `next start` runs the server as a child, so the group is what has to be stopped.
const ui = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(uiPort)], { cwd: webRoot, env: { ...process.env, HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
const uiLog: string[] = [];
ui.stdout?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
ui.stderr?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
const uiOrigin = "http://127.0.0.1:" + uiPort;

try {
  check(await waitForWeb(uiOrigin), "the Web UI started on " + uiOrigin);
  const login = await fetch(uiOrigin + "/api/durable-login", { method: "POST", headers: { "content-type": "application/json", origin: uiOrigin, host: "127.0.0.1:" + uiPort }, body: JSON.stringify({ token }) });
  check(login.status === 200, "the browser session authenticated against the Web origin");
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");

  const catalog = await fetch(uiOrigin + "/api/models", { headers: { cookie } });
  const catalogBody = await catalog.json() as { modelList?: { provider: string; id: string; input: string[] }[]; models?: Record<string, string>; defaultModel?: { provider: string; modelId: string } };
  check(catalog.status === 200, "the Web origin served GET /api/models");
  const entry = (catalogBody.modelList ?? []).find(candidate => candidate.provider === providerId && candidate.id === modelId);
  check(entry !== undefined, "the catalog lists " + providerId + "/" + modelId);
  check(entry?.input.includes("image") === true, "the catalog advertises image input for " + providerId + "/" + modelId + ": " + JSON.stringify(entry?.input));
  check(catalogBody.defaultModel?.provider === providerId && catalogBody.defaultModel.modelId === modelId, "the configured alias is the default model");

  const headers = { cookie, "content-type": "application/json", origin: uiOrigin, host: "127.0.0.1:" + uiPort };
  const created = await (await fetch(uiOrigin + "/api/agent/new", { method: "POST", headers, body: JSON.stringify({ cwd: "/durable" }) })).json() as { sessionId?: string };
  check(typeof created.sessionId === "string", "the Web origin created a conversation");
  const sent = await fetch(uiOrigin + "/api/agent/" + created.sessionId, { method: "POST", headers, body: JSON.stringify({ type: "prompt", message: "catalog web smoke", requestId: "catalog-web-smoke" }) });
  check(sent.status === 200, "the Web origin accepted a text prompt");
  // Settle on the Web origin's own session view: idle AND carrying the assistant reply the controlled endpoint
  // streamed. Checking only for "not streaming" would pass on the state before the run starts.
  const deadline = Date.now() + 30000;
  let settled = false;
  while (!settled && Date.now() < deadline) {
    const [agent, session] = await Promise.all([
      (await fetch(uiOrigin + "/api/agent/" + created.sessionId, { headers: { cookie } })).json() as Promise<{ state?: { isStreaming?: boolean } }>,
      (await fetch(uiOrigin + "/api/sessions/" + created.sessionId, { headers: { cookie } })).json() as Promise<{ context?: { messages?: { role?: string; content?: unknown }[] } }>,
    ]);
    settled = agent.state?.isStreaming === false && (session.context?.messages ?? []).some(message => message.role === "assistant" && JSON.stringify(message.content).includes("catalog web smoke OK"));
    if (!settled) await new Promise(resolve => setTimeout(resolve, 200));
  }
  check(settled, "the text turn settled on the assistant reply through the Web origin");
  const request = requests[0];
  check(requests.length === 1 && request?.path === "/v1/chat/completions", "exactly one request reached the configured endpoint: " + JSON.stringify(requests.map(item => item.path)));
  check(request?.authorization === "Bearer smoke-key", "the configured key authenticated the request");
  check(request?.body.model === modelId, "the request names the configured model id");
  check(JSON.stringify(request?.body.messages).includes("catalog web smoke"), "the text turn carried the prompt");
} finally {
  if (ui.pid !== undefined) process.kill(-ui.pid, "SIGTERM");
  await backend.close();
  await new Promise<void>(resolveClose => endpoint.close(() => resolveClose()));
  await rm(directory, { recursive: true, force: true });
  if (failures.length > 0) { console.error("Web-origin catalog smoke failed: " + failures.join(" | ")); console.error("UI log tail: " + uiLog.join("").slice(-500)); process.exit(1); }
  console.log("Web-origin catalog smoke passed");
}
export {};
