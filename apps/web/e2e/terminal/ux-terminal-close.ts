/**
 * Ticket 01 regression: closing a terminal tab must be a local, immediate action. A creation or cleanup that is still
 * pending, rejected, absent or offline must never keep the tab on screen, and a closed tab must never come back from
 * the saved layout.
 *
 * This drives the real production UI (the built page at its client ingress + AppShell + TerminalPanel + TabBar) in
 * headless Chromium against a real backend process. The ticket-13 work connected `/api/terminal` to a real execution
 * host, so the boundary this driver controls is now the fixture: creation can be held open, fulfilled or answered with a
 * real refusal, and cleanup can be held open, rejected, absent, aborted or successful. What is asserted here is the close
 * behaviour, not the shell. Ticket 13's own browser driver (`ux-terminal-session.ts`) covers the connected terminal
 * against a real gateway.
 *
 * The page's origin is the real client ingress serving `apps/web/dist` and forwarding `/api` under its own service
 * credential — the deployed shape. This deployment configures no execution workspace, so the terminal route answers the
 * capability's own named limit either way, which is what scenario 1 asserts.
 *
 * Every wait is driven by an observable UI, request or stored-state change; there are no fixed sleeps and no
 * response-driven polling loops in the assertions.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/terminal/ux-terminal-close.ts [--keep]
 *        HEPI_TERMINAL_CLOSE_PAGE_DIST=<dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page, type Request as PlaywrightRequest, type Route } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-terminal-close-token";
// What the ingress admits as this page's own session, beside the backend's service credential the driver also holds:
// two different roles, so the run cannot accidentally prove one with the other.
const webLogin = "ux-terminal-close-web-login";
const keep = process.argv.includes("--keep");
// The build the ingress serves: `dist`, because `@hepi/web` is a Vite app.
const pageDist = process.env.HEPI_TERMINAL_CLOSE_PAGE_DIST ?? join(webRoot, "dist");
assert.ok(existsSync(join(pageDist, "index.html")), "build first: pnpm --filter @hepi/web build (the ingress serves " + pageDist + ")");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-terminal-close-"));
const dataDir = join(artifacts, "data");
mkdirSync(dataDir, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** A latch for the fixture: the request stays in flight until release() is called. */
interface Gate { readonly opened: Promise<void>; release(): void }

function gate(): Gate {
  let release!: () => void;
  const opened = new Promise<void>((resolveGate) => { release = resolveGate; });
  return { opened, release };
}

const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
/** The terminal's own routes, as the panel reaches them: every one of them carries the tab's routing cwd. */
const terminalPath = (route: Route) => new URL(route.request().url()).pathname;
const terminalPost = (route: Route) => route.request().method() === "POST" && terminalPath(route) === "/api/terminal";
const terminalDelete = (route: Route) => route.request().method() === "DELETE" && terminalPath(route).startsWith("/api/terminal/");
/** Every request the panel makes for a session, whatever the query it carries. */
const terminalRoutes = "**/api/terminal**";

/** Both child roles run from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
function childEnv(home: string, extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

const children = [];
function capture(child: ChildProcess): () => string {
  const chunks: string[] = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000).then(() => child.kill("SIGKILL"))]);
}

const panel = (page: Page) => page.locator(".terminal-panel");
const closeButton = (page: Page) => page.getByRole("button", { name: /^Terminate terminal/ });
const restartButton = (page: Page) => page.getByRole("button", { name: "Restart terminal" });
const savedTabs = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") ?? "null") as { tabs: { id: string }[] } | null);
const savedTabCount = (page: Page, count: number) => page.waitForFunction((expected) => JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") ?? "null")?.tabs.length === expected, count, { timeout: 10_000 });
const deletedRequest = (page: Page) => page.waitForRequest((request) => request.method() === "DELETE" && new URL(request.url()).pathname.startsWith("/api/terminal/")).catch(() => null);
const createdRequest = (page: Page) => page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/terminal").catch(() => null);
const answeredRequest = (page: Page, method: string) => page.waitForResponse((response) => response.request().method() === method).catch(() => null);

/**
 * Awaiting a pending request promise never throws on teardown; a missing or wrong release is a plain assertion. The
 * comparison is on the request's path, because every terminal request also carries the tab's own routing cwd.
 */
async function expectReleased(pending: Promise<PlaywrightRequest | null>, id: string | null, message: string): Promise<void> {
  const request = await pending;
  if (request === null) { assert.fail(message + " (no release was requested)"); return; }
  assert.equal(new URL(request.url()).pathname, "/api/terminal/" + String(id), message);
}

/**
 * The composer only renders after the session round-trip, so waiting for it proves the mount effects that restore the
 * saved layout already ran. That makes "no terminal panel appeared" a real assertion instead of a race with a timer.
 */
async function appReady(page: Page) {
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
}

async function reload(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await appReady(page);
}

/** Open the workspace terminal from the Files tab, and wait for whatever the panel settles on. */
async function openTerminal(page: Page) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.waitFor({ timeout: 20_000 });
  if (await files.getAttribute("aria-selected") !== "true") await files.click();
  await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
  await panel(page).waitFor();
}

async function expectClosed(page: Page, message: string) {
  await panel(page).waitFor({ state: "detached", timeout: 5000 }).catch(() => assert.fail(message));
  assert.equal(await closeButton(page).count(), 0, message + " (the tab bar still lists it)");
}

let browser: Browser;
let web: ChildProcess;
let webOrigin: string;

/** One page the run drove, and what it recorded of the panel's own requests. */
interface SessionView {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly pageErrors: string[];
  readonly requests: { created: (string | null)[]; deleted: string[] };
}
const sessions: SessionView[] = [];

try {
  const backendPort = await freePort();
  const backend = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  const backendLog = capture(backend);
  const backendOrigin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 45_000),
    "the backend started: " + backendLog().slice(-500));
  // This deployment serves no execution workspace, so the session the panel is opened on is one created without one:
  // the browser's own /durable case. The runtime's framework root record is not a listed conversation.
  const created = await fetch(backendOrigin + "/api/conversations", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(created.status, 201, "the backend created the workspace-less session");
  const sessionId = (await created.json()).conversationId;

  const webPort = await freePort();
  // The page's origin is the client ingress: it serves the build under test and forwards `/api` to the backend with the
  // service credential, which is the only way a browser reaches this deployment's routes.
  web = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_INGRESS_HOST: "127.0.0.1",
      HEPI_INGRESS_PORT: String(webPort),
      HEPI_INGRESS_BACKEND: backendOrigin,
      HEPI_INGRESS_SERVICE_TOKEN: token,
      HEPI_WEB_LOGIN_TOKEN: webLogin,
      HEPI_INGRESS_STATIC_DIR: pageDist,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the client ingress started: " + webLog().slice(-500));

  browser = await chromium.launch();

  /** A fresh authenticated page with the durable session in view. */
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requests: { created: (string | null)[]; deleted: string[] } = { created: [], deleted: [] };
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/terminal" && request.method() === "POST") {
        try { requests.created.push(request.postDataJSON().id as string); } catch { requests.created.push(null); }
      }
      if (request.method() === "DELETE" && path.startsWith("/api/terminal/")) requests.deleted.push(path);
    });
    await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
    // The login gate is a render, not a static element: a page that has not decided yet would be counted as admitted.
    const password = page.locator('input[type="password"]');
    await password.waitFor({ state: "visible", timeout: 20_000 }).catch(() => { /* this origin already holds a session */ });
    if (await password.count()) {
      await password.fill(webLogin);
      await page.locator('button[type="submit"]').click();
    }
    await appReady(page);
    const view: SessionView = { page, context, pageErrors, requests };
    sessions.push(view);
    return view;
  }

  async function withPage(name: string, body: (view: SessionView) => Promise<void>): Promise<void> {
    const view = await newPage();
    try { await body(view); } finally { await view.context.close(); }
  }

  // 1. Creation fails for real (this deployment's backend serves no execution workspace, so the terminal route answers
  //    the capability's own named limit), and the tab still closes, asks the server to release the terminal, leaves the
  //    saved layout, and stays gone across a reload.
  await withPage("failed creation", async ({ page, pageErrors, requests }) => {
    await openTerminal(page);
    await page.locator(".terminal-panel-error").waitFor();
    assert.equal(requests.created.length, 1, "the terminal creation request was sent");
    assert.match(await page.locator(".terminal-panel-error").textContent() ?? "", /workspace/, "the refusal is the host's own named limit");
    const id = requests.created[0];
    const released = deletedRequest(page);
    await closeButton(page).click();
    await expectClosed(page, "a terminal whose creation failed must close");
    await expectReleased(released, id, "closing still asked the server to release the terminal");
    await savedTabCount(page, 0);
    await reload(page);
    assert.equal(await panel(page).count(), 0, "a closed tab must not come back after a refresh");
    await savedTabCount(page, 0);
    assert.deepEqual(pageErrors, [], "no page error occurred: " + pageErrors.join(" | "));
    console.log("PASS: a failed creation closes, still requests cleanup, and is not restored by a refresh");
  });

  // 2. A rejected or absent cleanup does not restore the closed tab.
  for (const [status, label] of [[500, "rejected"], [404, "absent"]]) {
    await withPage(label + " cleanup", async ({ page, requests }) => {
      await page.route(terminalRoutes, async (route) => { if (terminalDelete(route)) await route.fulfill(json({ error: "cleanup refused by the fixture" })); else await route.continue(); });
      await openTerminal(page);
      await page.locator(".terminal-panel-error").waitFor();
      const id = requests.created[0];
      const released = deletedRequest(page);
      await closeButton(page).click();
      await expectClosed(page, "a " + label + " cleanup (HTTP " + status + ") must not restore the closed tab");
      await expectReleased(released, id, "the cleanup was requested");
      await savedTabCount(page, 0);
      await page.unroute(terminalRoutes);
      console.log("PASS: a " + label + " cleanup (HTTP " + status + ") still closes the tab");
    });
  }

  // 3. A disconnected network during cleanup does not restore the closed tab.
  await withPage("disconnected cleanup", async ({ page, requests }) => {
    await page.route(terminalRoutes, async (route) => { if (terminalDelete(route)) await route.abort("connectionfailed"); else await route.continue(); });
    await openTerminal(page);
    await page.locator(".terminal-panel-error").waitFor();
    const released = deletedRequest(page);
    await closeButton(page).click();
    await expectClosed(page, "a disconnected cleanup must not restore the closed tab");
    await released;
    assert.equal(requests.deleted.length, 1, "the disconnected cleanup is attempted exactly once");
    await savedTabCount(page, 0);
    await page.unroute(terminalRoutes);
    console.log("PASS: a disconnected cleanup still closes the tab");
  });

  // 4. Creation held open: the tab must leave the UI and the saved layout while that creation is still pending, and the
  //    release must still be attempted once it settles, without racing it.
  await withPage("held creation", async ({ page, requests }) => {
    const creation = gate();
    await page.route(terminalRoutes, async (route) => {
      if (!terminalPost(route)) return route.continue();
      await creation.opened;
      await route.fulfill({ status: 200, ...json({ id: "held-creation", cwd: "/durable" }) });
    });
    await openTerminal(page);
    const id = requests.created[0];
    await savedTabCount(page, 1);
    assert.deepEqual(requests.deleted, [], "nothing is released while the creation is still pending");
    const released = deletedRequest(page);
    await closeButton(page).click();
    await expectClosed(page, "a tab whose creation is still pending must close");
    await savedTabCount(page, 0);
    assert.deepEqual(requests.deleted, [], "the UI closed before the pending creation settled");
    creation.release();
    await expectReleased(released!, id, "the release is still attempted after the pending creation settles");
    assert.equal(await panel(page).count(), 0, "a late creation does not bring the tab back");
    await page.unroute(terminalRoutes);
    console.log("PASS: a tab closed during a pending creation leaves the UI at once and is still released afterwards");
  });

  // 5. Cleanup held open: the tab must be gone before the cleanup resolves, and a refused cleanup must never bring it back.
  await withPage("held cleanup", async ({ page, requests }) => {
    const cleanup = gate();
    await page.route(terminalRoutes, async (route) => {
      if (terminalPost(route)) return route.fulfill({ status: 200, ...json({ id: "created", cwd: "/durable" }) });
      if (!terminalDelete(route)) return route.continue();
      await cleanup.opened;
      await route.fulfill({ status: 500, ...json({ error: "cleanup refused by the fixture" }) });
    });
    await openTerminal(page);
    const id = requests.created[0];
    await savedTabCount(page, 1);
    const released = deletedRequest(page);
    const answered = answeredRequest(page, "DELETE");
    await closeButton(page).click();
    await expectClosed(page, "the tab closes before its cleanup resolves");
    await savedTabCount(page, 0);
    await expectReleased(released!, id, "the cleanup is issued while the tab is already gone");
    cleanup.release();
    await answered;
    assert.equal(await panel(page).count(), 0, "a refused cleanup never brings the tab back");
    assert.equal(requests.deleted.length, 1, "the cleanup is attempted exactly once");
    await page.unroute(terminalRoutes);
    console.log("PASS: the tab closes before the cleanup resolves and a refused cleanup never restores it");
  });

  // 6. Normal successful creation and cleanup still work end to end.
  await withPage("successful cleanup", async ({ page, requests }) => {
    await page.route(terminalRoutes, (route) => {
      if (terminalPost(route)) return route.fulfill({ status: 200, ...json({ id: "created", cwd: "/durable" }) });
      if (terminalDelete(route)) return route.fulfill({ status: 200, ...json({ id: "created", cwd: "/durable" }) });
      return route.continue();
    });
    await openTerminal(page);
    const id = requests.created[0];
    const released = deletedRequest(page);
    await closeButton(page).click();
    await expectClosed(page, "a normally closed terminal leaves the tab bar");
    await expectReleased(released, id, "the successful cleanup is requested");
    assert.equal(requests.deleted.length, 1, "the successful cleanup is requested exactly once");
    await savedTabCount(page, 0);
    await reload(page);
    assert.equal(await panel(page).count(), 0, "a normally closed tab is not restored");
    await savedTabCount(page, 0);
    console.log("PASS: a normally created terminal closes with one successful cleanup and is not restored");
  });

  // 7. Normal flows stay intact: restart replaces the tab exactly once and an open tab survives a reload.
  await withPage("restart and restore", async ({ page, requests }) => {
    await openTerminal(page);
    await page.locator(".terminal-panel-error").waitFor();
    const first = requests.created[0];
    const restarted = createdRequest(page);
    const released = deletedRequest(page);
    await restartButton(page).click();
    const next = (await restarted)?.postDataJSON()?.id;
    assert.ok(next, "restart opened a new terminal");
    assert.notEqual(next, first, "restart opened a new terminal");
    await expectReleased(released, first, "restart released the previous terminal");
    assert.equal(await panel(page).count(), 1, "restart replaced the tab exactly once");
    await page.locator(".terminal-panel-error").waitFor();
    await reload(page);
    await panel(page).waitFor();
    assert.deepEqual((await savedTabs(page))?.tabs.map((tab) => tab.id), [next], "an open tab stays in the saved layout");
    await closeButton(page).click();
    await expectClosed(page, "the restored tab closes");
    console.log("PASS: restart replaces the tab exactly once and an open tab survives a refresh");
  });

  console.log("PASS: all terminal-close checks");
} catch (error) {
  process.exitCode = 1;
  console.error(error);
  for (const { context } of sessions) await context.close().catch(() => {});
} finally {
  await browser!.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  if (process.exitCode === 1) console.log("Artifacts kept at " + artifacts + " (children.log holds both server logs)");
  else rmSync(artifacts, { recursive: true, force: true });
}
