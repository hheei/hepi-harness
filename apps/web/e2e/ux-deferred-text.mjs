/** Production MessageView + production Web proxy + real durable backend. No paid provider. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
assert.ok(existsSync(join(webRoot, ".next", "BUILD_ID")), "build production Web first");
const artifacts = mkdtempSync(join(tmpdir(), "hepi-deferred-text-"));
mkdirSync(join(artifacts, "data"));
const log = createWriteStream(join(artifacts, "children.log"));
console.log("Artifacts: " + artifacts);
const token = "deferred-text-browser-token";
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const webHeaders = { cookie: "hepi-web-token=" + token };
const userText = "USER-START\n" + "0123456789abcdef".repeat(98304) + "\nUSER-END";
const assistantText = "ASSISTANT-START\n" + "abcdefgh".repeat(65536) + "\nASSISTANT-END";
const children = [];
let browser;
let provider;
let fixture;
let backendOrigin;
let webOrigin;
let providerRequests = 0;
let failReads = false;
const textReads = [];
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; console.log("  ok " + message); }
async function listen(server) {
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return "http://127.0.0.1:" + server.address().port;
}
async function freePort() { const probe = createServer(); const origin = await listen(probe); await new Promise((done) => probe.close(done)); return Number(new URL(origin).port); }
function start(args, env, cwd = repoRoot) {
  const child = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), HOME: join(artifacts, "home"), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => log.write(data)); child.stderr.on("data", (data) => log.write(data)); children.push(child); return child;
}
async function ready(url, requestHeaders = {}) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { try { const response = await fetch(url, { headers: requestHeaders, signal: AbortSignal.timeout(2000) }); if (response.status < 500) return; } catch {} await delay(100); }
  throw new Error("service did not start: " + url);
}
async function json(origin, path, requestHeaders, init = {}) {
  const response = await fetch(origin + path, { headers: requestHeaders, ...init });
  assert.ok(response.ok, path + " HTTP " + response.status + " " + await response.clone().text());
  return response.json();
}
let sequence = 0;
async function say(id, text) {
  const response = await fetch(backendOrigin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "deferred-" + (++sequence), text }) });
  assert.equal(response.status, 202, await response.text());
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const read = await fetch(backendOrigin + "/api/conversations/" + id + "/state", { headers });
    if (read.ok) { const state = await read.json(); if (!state.busy && state.entries.at(-1)?.role === "assistant") return state; }
    else assert.equal(read.status, 413, "only documented live/pending frame refusal may interrupt polling");
    await delay(20);
  }
  throw new Error("turn did not settle");
}
async function mount(page, origin, id, ids, messages) {
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.fixtureReady === "true");
  await page.evaluate(({ id, ids, messages }) => window.__deferredText.setMessages(id, ids, messages), { id, ids, messages });
  await page.locator("[data-deferred-text]").first().waitFor();
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(5000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); })]);
}
try {
  provider = createServer((request, response) => {
    const parts = []; request.on("data", (part) => parts.push(part)); request.on("end", () => {
      if (request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
      JSON.parse(Buffer.concat(parts).toString());
      const text = ++providerRequests === 1 ? assistantText : "small answer " + providerRequests;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta, finish_reason = null) => "data: " + JSON.stringify({ id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled-1", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
      response.write(frame({ role: "assistant", content: text })); response.write(frame({}, "stop")); response.end("data: [DONE]\n\n");
    });
  });
  const providerOrigin = await listen(provider);
  const backendPort = await freePort(); backendOrigin = "http://127.0.0.1:" + backendPort;
  start([join(repoRoot, "apps/server/scripts/deferred-text-fixture.ts")], {
    HEPI_UX06_FIXTURE: join(artifacts, "backend"), HEPI_UX06_DB: join(artifacts, "data/history.sqlite"), HEPI_UX06_BACKEND_PORT: String(backendPort), HEPI_UX06_AUTH: token, HEPI_UX06_MODEL: "controlled-1", HEPI_UX06_ENDPOINT: providerOrigin,
  });
  await ready(backendOrigin + "/api/workspaces", headers);
  const webPort = await freePort(); webOrigin = "http://127.0.0.1:" + webPort;
  start([join(webRoot, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(webPort)], { HEPI_SERVER_URL: backendOrigin, HEPI_AUTH_TOKEN: token, HEPI_WEB_LOCAL_GATEWAY_ID: "workstation", NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" }, webRoot);
  await ready(webOrigin + "/");
  const id = (await json(backendOrigin, "/api/conversations", headers, { method: "POST", body: JSON.stringify({ workspaceId: "local" }) })).conversationId;
  await say(id, userText);
  for (let index = 0; index < 30; index++) await say(id, "later turn " + index);
  // The Web host forwards the backend's **native** snapshot and the backend's own entries page: the browser projects
  // them, so this reader reads the native fields the backend stated rather than a synthesized UI shape.
  const newest = await json(webOrigin, "/api/sessions/" + id, webHeaders);
  assert.equal(newest.protocol, "hepi.v1", "the conversation read is the backend's own snapshot");
  check(newest.hasMore, "large accepted text sits behind newest history window");
  const allMessages = newest.entries.map((entry) => entry.message); const allIds = newest.entries.map((entry) => entry.id);
  let window = newest;
  for (let page = 0; window.hasMore && page < 10; page++) {
    assert.ok(window.oldestEntryId, "paging retains a usable anchor");
    const answer = await json(webOrigin, "/api/sessions/" + id + "/context?before=" + encodeURIComponent(window.oldestEntryId), webHeaders);
    window = answer; allMessages.unshift(...window.entries.map((entry) => entry.message)); allIds.unshift(...window.entries.map((entry) => entry.id));
  }
  check(!window.hasMore, "normal back-paging reaches original large user and assistant entries");
  const index = allMessages.findIndex((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((block) => block.deferred && block.text.includes("USER-START")));
  const answerIndex = allMessages.findIndex((message) => message.role === "assistant" && message.content.some((block) => block.deferred && block.text.includes("ASSISTANT-START")));
  check(index >= 0 && answerIndex >= 0, "Web adapter preserves deferred text URLs for both roles");
  const messages = [allMessages[index], allMessages[answerIndex]];
  const ids = [allIds[index], allIds[answerIndex]];
  const bundle = await build({ entryPoints: [join(webRoot, "e2e/ux-deferred-text.fixture.tsx")], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", alias: { "@": webRoot }, define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty", ".svg": "dataurl" } });
  const script = bundle.outputFiles[0].text;
  fixture = createServer(async (request, response) => {
    try {
      if (request.url === "/fixture.js") { response.writeHead(200, { "content-type": "application/javascript" }).end(script); return; }
      if (request.url.startsWith("/api/")) {
        if (new URL(request.url, "http://fixture").pathname.endsWith("/text")) { textReads.push(request.url); if (failReads) { response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "controlled read refusal" })); return; } }
        const upstream = await fetch(webOrigin + request.url, { headers: webHeaders });
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer())); return;
      }
      response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><body style="font-family:sans-serif;--border:#888;--bg:#fff;--text:#111;--text-muted:#555;--user-bg:#eee;--font-mono:monospace"><div id="root"></div><script src="/fixture.js"></script></body></html>');
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  const fixtureOrigin = await listen(fixture);
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await mount(page, fixtureOrigin, id, ids, messages);
  const user = page.locator("[data-deferred-text]").first();
  const assistant = page.locator("[data-deferred-text]").nth(1);
  check(await user.getAttribute("data-deferred-state") === "preview", "large prompt initially renders bounded preview");
  await page.mouse.wheel(0, 400); await page.mouse.wheel(0, -400);
  check(textReads.length === 0, "mount and scroll issue no full-text GET");
  await user.getByRole("button").click();
  await page.waitForFunction(() => document.querySelector("[data-deferred-text]").dataset.deferredState === "expanded");
  check(await user.locator("pre").textContent() === userText, "explicit expand restores byte-exact 1.5 MiB prompt");
  await user.hover(); await page.locator('button[title="Copy message"]').first().click();
  await page.waitForFunction(() => document.querySelector('[data-copy-state="copied"]') !== null);
  check(await page.evaluate(() => navigator.clipboard.readText()) === userText, "standard copy writes original full prompt");
  check(textReads.length === 1, "expand and copy share one read");
  await user.getByRole("button").click();
  check(await user.getAttribute("data-deferred-state") === "preview" && !(await user.textContent()).includes("USER-END"), "collapse restores bounded preview");
  await assistant.getByRole("button").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-deferred-text]")[1].dataset.deferredState === "expanded");
  check(await assistant.locator("pre").textContent() === assistantText, "assistant expand restores original text");
  check(textReads.length === 2, "assistant has its own native read block");
  check(errors.length === 0, "component browser has no runtime errors");
  await context.close();
  const retryContext = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
  const retryPage = await retryContext.newPage(); await mount(retryPage, fixtureOrigin, id, [ids[0]], [messages[0]]);
  failReads = true;
  await retryPage.locator("[data-deferred-text]").hover(); await retryPage.locator('button[title="Copy message"]').click();
  await retryPage.locator('[data-copy-state="failed"]').waitFor();
  check(await retryPage.locator("[data-copy-state]").getAttribute("data-copy-state") === "failed", "failed copy never pretends success");
  const retryBlock = retryPage.locator("[data-deferred-text]"); await retryBlock.getByRole("button").click();
  await retryPage.locator('[data-deferred-state="error"]').waitFor();
  failReads = false; await retryBlock.getByRole("button").click();
  await retryPage.locator('[data-deferred-state="expanded"]').waitFor();
  check(await retryBlock.locator("pre").textContent() === userText, "explicit retry recovers failed full-text load");
  await retryContext.close();
  console.log("DEFERRED TEXT BROWSER CHECKS PASSED (" + checks + ")");
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child);
  for (const server of [fixture, provider]) if (server) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  log.end();
}
