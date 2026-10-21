/**
 * Ticket 13 regression: a terminal in the browser is a session on the conversation's execution host, reached through
 * the existing Web adapter and the durable backend.
 *
 * The whole path is the user's and the deployment's: headless Chromium drives the real production page (its client
 * ingress serving `apps/web/dist`, + AppShell + TerminalPanel) against a real backend process and a real gateway process,
 * which runs the shell. Every
 * assertion is about an observable outcome — what the shell printed, what the host reports about the process, what the
 * page shows — and every wait is an observable UI, request or stored-state change. There are no fixed sleeps.
 *
 * What is asserted, in order:
 *   1. the terminal opens in the conversation's workspace folder, keystrokes reach the shell, and a resize is applied;
 *   2. a dropped connection reconnects and shows the output produced while it was away, bounded by the stated bound;
 *   3. a stream the host ends is reopened by the page's own terminal stream, which names each tab's cursor and so
 *      continues rather than clearing the screen; the page reads it with `fetch`, so the same reader is the Web page's
 *      cookie path and an App's device-bearer path;
 *   4. input is never replayed after an ambiguous delivery failure: a command runs exactly once across the failure;
 *   4. an exited terminal reports its exit, and closing a tab ends the process on the host;
 *   5. an open terminal keeps its own workspace's label across a project switch;
 *   6. a host that cannot serve a terminal names the limit and the tab still closes.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/terminal/ux-terminal-session.ts [--keep]
 *        HEPI_UX13_WEB_PORT=<port> HEPI_UX13_BACKEND_PORT=<port> HEPI_UX13_GATEWAY_PORT=<port>
 *        HEPI_UX13_PAGE_DIST=<dir>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-terminal-session-token";
// What the ingress admits as this page's own session. It is deliberately not the backend's service credential: the
// browser proves the cookie path and this process proves the service path, and only the first is the deployed page.
const webLogin = "ux-terminal-session-web-login";
const keep = process.argv.includes("--keep");
// The build the ingress serves: `dist`, because `@hepi/web` is a Vite app.
const pageDist = process.env.HEPI_UX13_PAGE_DIST ?? join(webRoot, "dist");
assert.ok(existsSync(join(pageDist, "index.html")), "build first: pnpm --filter @hepi/web build (the ingress serves " + pageDist + ")");
/**
 * The Web session's cookie exactly as the ingress issues it: the admitted material under the ingress's own cookie name.
 * Only this process's own reads of a host-side stream need it — the browser gets the same one from the form it submits.
 */
const pageCookie = "hepi-web-session=" + webLogin;

/** The replayed-output bound this ticket states, named here so the assertion is against the stated value. */
const TERMINAL_REPLAY_CHARS = 128 * 1024;

const artifacts = mkdtempSync(join(tmpdir(), "hepi-terminal-session-"));
const dataDir = join(artifacts, "data");
// Two folders of one execution host: the conversation runs in the first, and the second is another project to switch
// to while a terminal stays open.
const workspaceRoot = join(artifacts, "workspace");
const otherRoot = join(artifacts, "other-workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(otherRoot, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

function freePort(preferred = 0) {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(preferred, "127.0.0.1", () => {
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

/** True while the process exists, read from the host itself rather than inferred from a connection. */
function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const panel = (page: Page) => page.locator(".terminal-panel");
const closeButton = (page: Page) => page.getByRole("button", { name: /^Terminate terminal/ });
const savedTabs = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") ?? "null") as { tabs: TerminalTab[] } | null);
const savedTabCount = (page: Page, count: number) => page.waitForFunction((expected) => JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") ?? "null")?.tabs.length === expected, count, { timeout: 15_000 });
const deletedRequest = (page: Page) => page.waitForRequest((request) => request.method() === "DELETE" && new URL(request.url()).pathname.startsWith("/api/terminal/")).catch(() => null);
const dot = (page: Page, state: string) => page.locator(".terminal-status-dot.is-" + state);

/** One terminal tab as the page's own store states it: the identity and folder a session is addressed by. */
interface TerminalTab { readonly id: string; readonly cwd: string }

/** The composer only renders after the session round-trip, so waiting for it proves the mount effects have run. */
async function appReady(page: Page) {
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
}

/** Open the workspace terminal from the Files tab, and wait for the panel to appear. */
async function openTerminal(page: Page) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.count()) await showSidebar.click();
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.waitFor({ timeout: 20_000 });
  if (await files.getAttribute("aria-selected") !== "true") await files.click();
  await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
  await panel(page).waitFor();
}

/** What the terminal shows, read from xterm's own accessibility tree: the rows it actually rendered. */
async function screen(page: Page) {
  return await panel(page).locator(".xterm-accessibility-tree").innerText().catch(() => "");
}

/** Wait for the terminal to show something the shell printed: the wait is the terminal's own rendered output. */
async function waitForScreen(page: Page, predicate: (text: string) => boolean, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    last = await screen(page);
    if (predicate(last)) return last;
    await delay(50);
  }
  assert.fail("timed out waiting for " + description + "; the terminal shows " + JSON.stringify(last.slice(-400)));
}

/**
 * Type into the terminal the way a person does: wait for the panel to say it is connected, focus it, then press the
 * keys. Waiting for the connected state is what makes the typing deterministic: a panel that is still connecting
 * ignores input, and that is a state the page shows rather than a delay a test would guess.
 */
async function type(page: Page, text: string) {
  await dot(page, "ready").waitFor({ timeout: 30_000 });
  await panel(page).locator("textarea.xterm-helper-textarea").focus();
  await page.keyboard.type(text);
}

/** The tab the page is showing, as the browser itself stores it. */
const activeTab = (page: Page) => page.evaluate(() => (JSON.parse(sessionStorage.getItem("pi-web:terminal-tabs") ?? "null") as { tabs: TerminalTab[] }).tabs[0]);

/**
 * Scroll the terminal back to its oldest retained line and report the rows it then shows.
 *
 * The scroll is the terminal's own: Shift+PageUp is the key xterm binds for it, and the loop ends when the view stops
 * moving, which is the top of the scrollback. That makes the oldest line a fact the page renders rather than a number a
 * test would have to read out of xterm's internals.
 */
async function scrollToTop(page: Page) {
  await panel(page).locator("textarea.xterm-helper-textarea").focus();
  let previous = "";
  for (let i = 0; i < 400; i++) {
    const rows = await screen(page);
    if (rows === previous) return rows;
    previous = rows;
    await page.keyboard.press("Shift+PageUp");
    // The keypress's own effect, waited for: the view moves, or it cannot move because the scrollback is already at
    // its top. Reading again straight away would compare two reads that happened to land together and call that the
    // top, which is the difference between "the oldest retained line" and "whatever was on screen at the time".
    await page.waitForFunction((before) => document.querySelector<HTMLElement>(".terminal-panel .xterm-accessibility-tree")?.innerText !== before, rows, { timeout: 5000 }).catch(() => {});
  }
  return previous;
}

let browser: Browser;
/** The ingress process this page's origin is: the deployment's own, serving the build under test. */
let web: ChildProcess;
let webOrigin: string;
let backendOrigin: string;

/** One browser the run drove, and what the pages it opened recorded. */
interface PageView {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly pageErrors: string[];
  readonly requests: { events: string[]; deleted: string[] };
}
const contexts: PageView[] = [];

try {
  const gatewayPort = await freePort(Number(process.env.HEPI_UX13_GATEWAY_PORT ?? 45210));
  const gateway = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), {
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_PORT: String(gatewayPort),
      HEPI_GATEWAY_DATA: join(dataDir, "gateway"),
      HEPI_WORKSPACE_ROOT: workspaceRoot,
      HEPI_WORKSPACE_ID: "local",
      HEPI_ALLOWED_COMMANDS: "bash, sh",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(gateway);
  const gatewayLog = capture(gateway);
  const gatewayOrigin = "http://127.0.0.1:" + gatewayPort;
  assert.ok(await waitForHttp(gatewayOrigin + "/v1/workspaces", { authorization: "Bearer " + token, "content-type": "application/json" }, 60_000),
    "the gateway started: " + gatewayLog().slice(-500));

  const backendPort = await freePort(Number(process.env.HEPI_UX13_BACKEND_PORT ?? 44210));
  const backend = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_WORKSPACE_ID: "local",
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: gatewayOrigin,
      HEPI_GATEWAY_TOKEN: token,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  const backendLog = capture(backend);
  backendOrigin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 60_000),
    "the backend started: " + backendLog().slice(-500));

  // A conversation bound to the first folder: the terminal opens in its workspace, which is the ticket's first story.
  const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
  const created = await (await fetch(backendOrigin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) })).json();
  const sessionId = created.conversationId;
  // A second folder, recorded as its own project with a conversation of its own, is the project the page switches to
  // while a terminal stays open. A project is offered by the picker once it has a conversation, which is why one is
  // created here: the switch the ticket's carried finding is about is a switch a user can really make.
  const other = await (await fetch(backendOrigin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Other project", hostId: "workstation", folders: [{ root: otherRoot, default: true }] }) })).json();
  check(typeof other.project?.id === "string", "the second project was recorded: " + JSON.stringify(other).slice(0, 200));
  const otherWorkspaceId = other.project.folders[0].workspaceId;
  const otherSession = await (await fetch(backendOrigin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: otherWorkspaceId }) })).json();
  check(typeof otherSession.conversationId === "string", "the second project has a conversation: " + JSON.stringify(otherSession).slice(0, 200));

  /**
   * A command sent to a session from this process rather than from the browser. It is how the shell is driven while the
   * browser's own connection is down, so the output a reconnect has to replay is produced by the host, not by the page.
   */
  const sendInput = async (tab: TerminalTab, data: string) => {
    const response = await fetch(backendOrigin + "/api/terminal/" + encodeURIComponent(tab.id) + "?cwd=" + encodeURIComponent(tab.cwd), { method: "POST", headers, body: JSON.stringify({ type: "input", data }) });
    return await response.json();
  };

  /**
   * Read a session's own event stream from this process, up to a predicate. `replay` is the first output frame — what
   * the host sent for the cursor this reader named — and `text` is everything the stream delivered, so a caller can
   * tell the replay from the live output that followed it.
   */
  const readStream = async (tab: TerminalTab, after: number, predicate: (text: string) => boolean, timeoutMs = 20_000) => {
    const response = await fetch(backendOrigin + "/api/terminal/" + encodeURIComponent(tab.id) + "/events?cwd=" + encodeURIComponent(tab.cwd) + "&after=" + after, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (response.body === null) throw new Error("the session's own event stream answered with no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let text = "";
    let replay = "";
    let reset = false;
    let offset = after;
    let frames = 0;
    try {
      while (!predicate(text)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const line = frame.split("\n").find((value) => value.startsWith("data: "));
          if (line === undefined) continue;
          const event = JSON.parse(line.slice(6));
          if (event.type !== "output") continue;
          if (frames === 0) { reset = event.reset === true; replay = event.data; }
          frames += 1;
          offset = event.offset;
          text += event.data;
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
    return { text, replay, reset, offset, frames };
  };

  const webPort = await freePort(Number(process.env.HEPI_UX13_WEB_PORT ?? 43210));
  // The page's origin is the client ingress: it serves the build under test and forwards `/api` to the backend with the
  // service credential, so the cookie, the origin checks and the host resolution are the deployed ones. Which execution
  // host this origin serves is the deployment's own fact, stated here the way the retired Next origin stated it.
  web = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "web-home"), {
      HEPI_INGRESS_HOST: "127.0.0.1",
      HEPI_INGRESS_PORT: String(webPort),
      HEPI_INGRESS_BACKEND: backendOrigin,
      HEPI_INGRESS_SERVICE_TOKEN: token,
      HEPI_WEB_LOGIN_TOKEN: webLogin,
      HEPI_INGRESS_DEFAULT_HOST: "workstation",
      HEPI_INGRESS_STATIC_DIR: pageDist,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(web);
  const webLog = capture(web);
  webOrigin = "http://127.0.0.1:" + webPort;
  assert.ok(await waitForHttp(webOrigin + "/", {}, 60_000), "the client ingress started: " + webLog().slice(-500));

  browser = await chromium.launch();

  /** A fresh authenticated page with the durable session in view, and its own record of terminal requests. */
  async function newPage() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    const page = await context.newPage();    page.setDefaultTimeout(30_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const requests: { events: string[]; deleted: string[] } = { events: [], deleted: [] };
    page.on("request", (request) => {
      const url = new URL(request.url());
      // The cursor each attach named is part of what the attach *is*, so the whole query is kept: a reconnect that
      // arrived with no cursor is the difference this test exists to tell apart from one that continued.
      if (url.pathname.endsWith("/events") && url.pathname.startsWith("/api/terminal/")) requests.events.push(url.pathname + url.search);
      if (request.method() === "DELETE" && url.pathname.startsWith("/api/terminal/")) requests.deleted.push(url.pathname);
    });
    await page.goto(webOrigin + "/?session=" + sessionId, { waitUntil: "domcontentloaded" });
    // The login gate is a render, not a static element, so it is waited for rather than sampled: a page that has not
    // decided yet would otherwise count as admitted and the run would fail later as a mystery.
    const password = page.locator('input[type="password"]');
    await password.waitFor({ state: "visible", timeout: 20_000 }).catch(() => { /* this origin already holds a session */ });
    if (await password.count()) {
      await password.fill(webLogin);
      await page.locator('button[type="submit"]').click();
    }
    await appReady(page);
    const view: PageView = { page, context, pageErrors, requests };
    contexts.push(view);
    return view;
  }

  async function withPage(name: string, body: (view: PageView) => Promise<void>): Promise<void> {
    const view = await newPage();
    try { await body(view); } finally { await view.context.close(); }
  }

  // 1. The terminal opens in the conversation's workspace folder, keystrokes reach the shell, and a resize is applied.
  await withPage("open, type and resize", async ({ page, pageErrors }) => {
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the shell's first output");
    const shownPath = await panel(page).locator(".terminal-panel-path span").last().textContent();
    check(shownPath?.includes(realpathSync(workspaceRoot)) ?? false, "the panel names the folder the shell opened in: " + JSON.stringify(shownPath));

    const marker = "open-" + Math.random().toString(36).slice(2);
    await type(page, "printf '" + marker + "-%s\\n' ok; printf 'cwd-%s\\n' \"$PWD\"\r");
    const opened = await waitForScreen(page, (text) => text.includes(marker + "-ok") && /cwd-\//.test(text), "the command's own output");
    check(opened.includes("cwd-" + realpathSync(workspaceRoot)), "the shell ran in the conversation's workspace folder");
    check(/cwd-\/\S+/.test(opened), "keystrokes reached the shell: a command was executed and printed its answer");

    // The shell reports the window size it was given, before and after a resize: that is the resize reaching the PTY.
    await type(page, "printf 'win-%s\\n' \"$(stty size)\"\r");
    const before = await waitForScreen(page, (text) => /win-\d+ \d+/.test(text), "the shell to report its window size");
    const widthBefore = Number(/win-\d+ (\d+)/.exec(before)![1]);
    const resized = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".terminal-xterm");
      if (host === null) return null;
      const before = host.getBoundingClientRect();
      host.style.width = "40%";
      return { before: before.width };
    });
    check(resized !== null, "the terminal's own container was resized");
    // The resize is waited for as the request it is, so the next command is typed after the shell has been told.
    await page.waitForResponse((response) => response.request().method() === "POST" && response.request().postDataJSON()?.type === "resize", { timeout: 20_000 });
    await type(page, "printf 'win2-%s\\n' \"$(stty size)\"\r");
    const after = await waitForScreen(page, (text) => /win2-\d+ \d+/.test(text), "the shell to answer at the new size");
    const widthAfter = Number(/win2-\d+ (\d+)/.exec(after)![1]);
    check(widthAfter < widthBefore, "the resize reached the shell and it laid out at the new width: " + widthBefore + " -> " + widthAfter);
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));
    await closeButton(page).click();
    await panel(page).waitFor({ state: "detached", timeout: 10_000 });
    console.log("PASS: the terminal opens in the conversation's workspace, keystrokes reach the shell and a resize is applied");
  });

  // 2. A dropped connection reconnects and replays what was produced while it was away, within the stated bound.
  await withPage("reconnect and bounded replay", async ({ page, requests, pageErrors }) => {
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the shell's first output");
    const tab = await activeTab(page);
    const marker = "reconnect-" + Math.random().toString(36).slice(2);
    await type(page, "printf '" + marker + "-before-%s\\n' ok\r");
    await waitForScreen(page, (text) => text.includes(marker + "-before-ok"), "output before the drop");
    // The cursor a caller has read up to, taken from the session's own stream: what the page has read at this moment.
    const atDrop = await readStream(tab, 0, (text) => text.includes(marker + "-before-ok"));
    const cursor = atDrop.offset;
    check(cursor > 0, "the session reported an output offset to resume from");

    // The browser goes offline: its stream ends and the panel is reconnecting rather than failed.
    await page.context().setOffline(true);
    await dot(page, "connecting").waitFor({ timeout: 20_000 });
    // The shell keeps producing output while the browser is away. This command travels through this process, which is
    // the point: what a reconnect has to show is the host's output, not something the page itself sent.
    assert.deepEqual(await sendInput(tab, "printf '" + marker + "-missed-%s\\n' ok\r"), { ok: true });
    check((await screen(page)).includes(marker + "-missed-ok") === false, "the output produced while offline had not reached the page");

    // Back online: the page's own attach resumes and the host replays what was missed. The fact waited for is the
    // shell's own output.
    await page.context().setOffline(false);
    await waitForScreen(page, (text) => text.includes(marker + "-missed-ok"), "the output produced while the connection was dropped", 60_000);
    check(requests.events.length >= 2, "the page attached again after the drop: " + requests.events.length + " attaches");
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));

    // What a caller resuming from that cursor is shown: the output produced while it was away, and nothing it had
    // already read. The replay frame is what the host sent for the cursor, not the live output that followed it.
    const resumed = await readStream(tab, cursor, (text) => text.includes(marker + "-missed-ok"));
    check(resumed.replay.includes(marker + "-missed-ok"), "a resumed stream replays the output produced while the caller was away");
    check(resumed.replay.includes(marker + "-before-ok") === false, "the resumed stream did not repeat output the cursor had already read");
    check(resumed.reset === false, "a cursor inside the retained tail continues instead of resetting");

    // Past the bound the caller is told the stream reset, and what it receives is the retained tail rather than
    // everything that was produced.
    const tail = "tail-" + Math.random().toString(36).slice(2);
    await page.context().setOffline(true);
    await dot(page, "connecting").waitFor({ timeout: 20_000 });
    // More output than the stated bound, so a caller at cursor zero can only be given the retained tail. The wait is
    // the host's own completion marker, so the next attach happens once the burst is really behind us.
    assert.deepEqual(await sendInput(tab, "for i in $(seq 1 20000); do echo pad-" + tail + "-$i; done\r"), { ok: true });
    assert.deepEqual(await sendInput(tab, "printf '" + tail + "-after-%s\\n' ok\r"), { ok: true });
    await readStream(tab, resumed.offset, (text) => text.includes(tail + "-after-ok"), 90_000);
    const fromBehind = await readStream(tab, 0, (text) => text.includes(tail + "-after-ok"), 60_000);
    check(fromBehind.reset, "a caller behind the retained tail is told the stream reset");
    check(fromBehind.replay.length <= TERMINAL_REPLAY_CHARS, "the replay never exceeds the stated bound: " + fromBehind.replay.length + " of " + TERMINAL_REPLAY_CHARS);
    check(fromBehind.replay.includes("pad-" + tail + "-20000"), "the replay is the retained tail of the output produced while away");
    await page.context().setOffline(false);
    await waitForScreen(page, (text) => text.includes(tail + "-after-ok"), "the retained tail after the bound was passed", 60_000);
    console.log("PASS: a dropped connection reconnects and replays what was missed, bounded by the stated bound");
  });

  // 3. A stream the host ends is reopened by the page's own fan-in reader, which continues from the cursor it received:
  //    the panel is never cleared, so output it had already read survives a reconnect.
  await withPage("an automatic reconnect continues from the cursor the browser received", async ({ page, requests, pageErrors }) => {
    const before = "before-" + Math.random().toString(36).slice(2);
    const missed = "missed-" + Math.random().toString(36).slice(2);
    const tail = "tail-" + Math.random().toString(36).slice(2);
    let ended = 0;
    // The page's terminal stream is ended once, from this process, exactly as a host stream that ends is. Nothing else
    // happens: there is no offline/online transition and no user action, so the only thing that can attach again is the
    // page's own terminal stream reopening itself — and it names each tab's cursor when it does, which is the path that
    // continues rather than restarting from the retained tail.
    await page.route(/\/api\/terminal\/events\?tabs=/, async (route) => {
      if (ended++ > 0) return route.continue();
      // A direct request rather than \`route.fetch()\`: the latter waits for the whole response body, and a terminal
      // stream has no end. The head is read here and the response this process fulfils is what the panel receives.
      const upstream = await fetch(route.request().url(), { headers: { cookie: pageCookie, accept: "text/event-stream" } });
      if (upstream.body === null) throw new Error("the intercepted stream answered with no body");
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The head is kept up to the frame carrying the marker, and the cut is always on a frame boundary: a body that
      // ended mid-frame would leave the browser with an event it must discard, so the id it carries would never be
      // recorded and the reconnect would arrive with no cursor at all.
      const framed = () => { const boundary = text.lastIndexOf("\n\n"); return boundary >= 0 && text.indexOf(before) < boundary; };
      while (!framed()) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel().catch(() => {});
      await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }, body: text.slice(0, text.lastIndexOf("\n\n") + 2) });
    });
    await openTerminal(page);
    const tab = await activeTab(page);
    // The marker travels through this process, so it is the host's output: the panel reads it from the stream that is
    // about to end, and the cursor it is at is the one a reconnect has to continue from.
    assert.deepEqual(await sendInput(tab, "printf '" + before + "-ok\\n'\r"), { ok: true });
    await waitForScreen(page, (text) => text.includes(before + "-ok"), "the marker the panel read before its stream ended");

    // The stream is over and the browser is retrying by itself. Output is produced while the panel is away — less than
    // the host's replay bound, so a reconnect that continued from the cursor is handed exactly what it missed, while one
    // that arrived with no cursor is handed the retained tail and told to reset.
    await dot(page, "connecting").waitFor({ timeout: 30_000 });
    assert.deepEqual(await sendInput(tab, "for i in $(seq 1 300); do echo " + tail + "-$i; done\r"), { ok: true });
    assert.deepEqual(await sendInput(tab, "printf '" + missed + "-ok\\n'\r"), { ok: true });

    // What proves the reconnect happened is the output it delivered, and what proves it continued is that the marker
    // read before the drop is still on screen rather than cleared and replaced by the retained tail.
    await waitForScreen(page, (text) => text.includes(missed + "-ok"), "the output produced while the panel was away", 60_000);
    check(requests.events.length >= 2, "the page attached again by itself, with no offline/online transition: " + requests.events.length + " attaches");
    const oldest = await scrollToTop(page);
    check(oldest.includes(before + "-ok"), "the reconnect continued from the cursor instead of clearing the panel: output read before the drop is still there; attaches " + JSON.stringify(requests.events) + ", the oldest rows show " + JSON.stringify(oldest.slice(0, 200)));
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));
    await page.unroute(/\/api\/terminal\/events\?tabs=/);
    console.log("PASS: an automatic reconnect continues from the cursor the browser received");
  });

  // 4. Input is never replayed after an ambiguous delivery failure: the command runs exactly once.
  await withPage("no input replay after an ambiguous failure", async ({ page, requests, pageErrors }) => {
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the shell's first output");
    const tab = await activeTab(page);
    const marker = "once-" + Math.random().toString(36).slice(2);
    // The input reaches the host and its answer is lost: the delivery is ambiguous, so the command must not be sent
    // again. The marker counts runs, so a second delivery would show as a second line in the shell's own output.
    await page.route(/\/api\/terminal\/.+\?cwd=/, async (route) => {
      const body = route.request().postDataJSON();
      if (route.request().method() !== "POST" || body?.type !== "input" || !body.data.includes(marker)) return route.continue();
      await route.fetch().catch(() => {});
      await route.abort("connectionfailed").catch(() => {});
    });
    await type(page, "printf '" + marker + "-run\\n'\r");
    await page.locator(".terminal-panel-error").waitFor({ timeout: 20_000 });
    check(/ambiguous|failed|network|Failed to fetch/i.test(await page.locator(".terminal-panel-error").textContent() ?? ""), "the failure is reported to the user rather than hidden");

    // A separate reader sees the host's own output, so the count is the shell's, not the page's. The marker is printed
    // on a line of its own, so a line equal to it is one run: the echoed command line is a different line.
    const seen = await readStream(tab, 0, (text) => text.includes(marker + "-run"));
    const runs = seen.text.split("\n").filter((line) => line.trim() === marker + "-run").length;
    check(runs === 1, "the command ran exactly once across the ambiguous failure: " + runs + " run(s) in the host's output");
    check(requests.deleted.length === 0, "no cleanup was issued while the terminal is still open");
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));
    await page.unroute(/\/api\/terminal\/.+\?cwd=/);
    console.log("PASS: input is never replayed after an ambiguous delivery failure");
  });

  // 5. An exited terminal reports its exit, and closing a tab ends the process on the host.
  await withPage("exit is reported and closing ends the host process", async ({ page, pageErrors }) => {
    // The shell's own exit is reported as an exit with its code, and the shell is gone afterwards.
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the shell's first output");
    await type(page, "echo shell-$$\r");
    const first = await waitForScreen(page, (text) => /shell-\d+/.test(text), "the shell to report its own pid");
    const shellPid = Number(/shell-(\d+)/.exec(first)![1]);
    check(alive(shellPid), "the shell is running before it exits");
    await type(page, "exit 7\r");
    await page.locator(".terminal-panel-exit").waitFor({ timeout: 20_000 });
    check(/7/.test(await page.locator(".terminal-panel-exit").textContent() ?? ""), "the panel reports the exit code the host gave");
    const exitedBy = Date.now() + 20_000;
    while (alive(shellPid) && Date.now() < exitedBy) await delay(50);
    check(alive(shellPid) === false, "the shell is gone once it has exited");
    await closeButton(page).click();
    await panel(page).waitFor({ state: "detached", timeout: 10_000 });

    // A second shell and a child it owns, closed from the tab: the close must end the process group on the host, not
    // merely the connection.
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the second shell's first output");
    await type(page, "echo second-$$; sleep 300 & echo child-$!\r");
    const second = await waitForScreen(page, (text) => /second-\d+/.test(text) && /child-\d+/.test(text), "the second shell to report its own pids");
    const secondPid = Number(/second-(\d+)/.exec(second)![1]);
    const childPid = Number(/child-(\d+)/.exec(second)![1]);
    check(alive(secondPid) && alive(childPid), "the second shell and the process it started are running before the tab is closed");
    const released = deletedRequest(page);
    await closeButton(page).click();
    await panel(page).waitFor({ state: "detached", timeout: 10_000 });
    await released;
    await savedTabCount(page, 0);
    const deadline = Date.now() + 20_000;
    while ((alive(secondPid) || alive(childPid)) && Date.now() < deadline) await delay(50);
    check(alive(secondPid) === false, "closing the tab ended the shell on the host");
    check(alive(childPid) === false, "a process the shell started did not outlive the closed tab");
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));
    console.log("PASS: an exit is reported, and closing the tab ends the host process");
  });

  // 6. An open terminal keeps its own workspace's label across a project switch, and keeps its shell.
  await withPage("a tab keeps its own workspace's label across a project switch", async ({ page, pageErrors }) => {
    await openTerminal(page);
    await waitForScreen(page, (text) => text.length > 0, "the shell's first output");
    const labelBefore = await page.getByRole("tab", { name: /^Terminal:/ }).getAttribute("aria-label");
    const tab = await activeTab(page);
    check(tab.cwd.startsWith("/workspace/"), "the tab is addressed by its own routing cwd: " + tab.cwd);

    // Switch to the other project through the sidebar's own picker: the real control, not a URL.
    await page.locator(".sidebar-files-head .project-picker .project-picker-button.is-project").click();
    const item = page.locator('.sidebar-menu-item[title="' + realpathSync(otherRoot) + '"]');
    await item.waitFor({ timeout: 20_000 });
    await item.click();
    // The switch is observable in the sidebar's own picker before the tab's label is read.
    await page.locator(".sidebar-files-head .project-picker-button.is-project").filter({ hasText: "other-workspace" }).waitFor({ timeout: 30_000 });
    const labelAfter = await page.getByRole("tab", { name: /^Terminal:/ }).getAttribute("aria-label");
    check(labelAfter === labelBefore, "an open terminal's label did not change with the project: " + JSON.stringify({ before: labelBefore, after: labelAfter }));
    check((labelAfter ?? "").includes("workspace") && !(labelAfter ?? "").includes("other-workspace"), "the label names the tab's own workspace: " + JSON.stringify(labelAfter));

    // And it is still the same live shell: the switch did not replace or detach it.
    const marker = "switch-" + Math.random().toString(36).slice(2);
    await type(page, "printf '" + marker + "-%s\\n' ok\r");
    await waitForScreen(page, (text) => text.includes(marker + "-ok"), "the same shell to answer after the project switch");
    check(pageErrors.length === 0, "no page error occurred: " + pageErrors.join(" | "));
    console.log("PASS: a terminal tab keeps its own workspace's label and its shell across a project switch");
  });

  // 7. A host that cannot serve a terminal says so plainly, and the tab still closes.
  await withPage("a host that cannot serve a terminal names the limit", async ({ page }) => {
    await page.route(/\/api\/terminal\?cwd=/, (route) => route.request().method() === "POST"
      ? route.fulfill({ status: 501, json: { ok: false, code: "not_supported", message: "this gateway has no terminal capability: its execution host is not configured to serve one" } })
      : route.continue());
    await openTerminal(page);
    const error = page.locator(".terminal-panel-error");
    await error.waitFor({ timeout: 20_000 });
    check(/terminal capability/.test(await error.textContent() ?? ""), "the panel names the host's own limit: " + JSON.stringify(await error.textContent()));
    await closeButton(page).click();
    await panel(page).waitFor({ state: "detached", timeout: 10_000 });
    check(await panel(page).count() === 0, "a failed connection closes its tab rather than trapping it");
    await page.unroute(/\/api\/terminal\?cwd=/);
    console.log("PASS: a host that cannot serve a terminal names the limit and the tab closes");
  });

  if (failures.length > 0) {
    process.exitCode = 1;
    console.error("\nFAILURES (" + failures.length + "):\n- " + failures.join("\n- "));
  } else {
    console.log("\nUX-13 BROWSER CHECKS PASSED");
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser!.close().catch(() => {});
  for (const child of children.reverse()) await stop(child).catch(() => {});
  childrenLog.end();
  if (process.exitCode === 1 || keep) console.log("Artifacts kept at " + artifacts + " (children.log holds every server log)");
  else rmSync(artifacts, { recursive: true, force: true });
}
