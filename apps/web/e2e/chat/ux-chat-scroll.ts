/**
 * Browser regression: an existing conversation's transcript scrolls inside the page instead of growing past it.
 *
 * The reported failure was a page that could not scroll while its last turn sat below the viewport. The cause was not the
 * shell's sizing: `#root` was already bounded. It was that the shared workbench's Tailwind classes were never emitted —
 * Tailwind's automatic source detection scans each host's Vite root (`apps/web/src`, `apps/app/src`), and every class the
 * tree writes lives in `packages/ui`. `[data-chat-scroll]` therefore computed `overflow-y: visible; flex: 0 1 auto`
 * instead of `overflow-y: auto; flex: 1`, so it grew to its content and the page's own `overflow: hidden` swallowed the
 * rest. This driver reads the emitted stylesheet for the utilities the transcript needs, then measures the real page.
 *
 * The deployment shape only: the production Vite build served by the real client ingress, the real Backend over its own
 * SQLite store, a real execution gateway, and the driver's own controlled completions endpoint, so nothing contacts a
 * paid provider and no turn is sent from the page.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/chat/ux-chat-scroll.ts
 *        HEPI_CHAT_SCROLL_WEB_PORT / HEPI_CHAT_SCROLL_BACKEND_PORT / HEPI_CHAT_SCROLL_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { backendJson, type ConversationStateBody, type CreatedConversationBody, startAcceptanceStack, webLogin, webRoot } from "../acceptance/acceptance-stack.ts";

const TURNS = 14;
const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

// --- 1. The emitted stylesheet states the utilities the transcript is laid out with. --------------------------------
// This is the seam the failure lived at: the classes are written in `packages/ui`, and the build has to scan them.
const assets = join(webRoot, "dist", "assets");
const stylesheets = readdirSync(assets).filter((name) => name.endsWith(".css"));
assert.ok(stylesheets.length > 0, "the production build emitted a stylesheet: " + assets);
const css = stylesheets.map((name) => readFileSync(join(assets, name), "utf8")).join("\n");
for (const utility of ["overflow-y-auto", "flex-1", "min-h-0", "h-full", "flex-col"]) {
  check(new RegExp("\\." + utility + "\\s*\\{").test(css), "the build emits ." + utility + " for the classes the workbench writes");
}

const stack = await startAcceptanceStack({
  label: "ux-chat-scroll",
  ports: {
    app: Number(process.env.HEPI_CHAT_SCROLL_APP_PORT ?? 0),
    ingress: Number(process.env.HEPI_CHAT_SCROLL_WEB_PORT ?? 0),
    backend: Number(process.env.HEPI_CHAT_SCROLL_BACKEND_PORT ?? 0),
    gateway: Number(process.env.HEPI_CHAT_SCROLL_GATEWAY_PORT ?? 0),
  },
  log: (line) => console.log(line),
});

let browser;
try {
  console.log("Artifacts: " + stack.artifacts);
  const cookie = await webLogin(stack);

  // --- 2. One durable conversation, long enough that its transcript must overflow the viewport. ---------------------
  // The turns are submitted on the Backend's own route with the deployment's service credential: this driver measures a
  // transcript a person would read, and never sends a message from the page it is measuring.
  const created = await backendJson<CreatedConversationBody>(stack, "/api/conversations", { method: "POST", body: JSON.stringify({ workspaceId: "local" }) });
  const conversationId = created.conversationId;
  const paragraph = "A line of a long answer that a reader scrolls through, repeated so the transcript is taller than the page. ";
  for (let turn = 1; turn <= TURNS; turn += 1) {
    const submitted = await fetch(stack.backendOrigin + "/api/conversations/" + conversationId + "/messages", {
      method: "POST",
      headers: stack.backendHeaders,
      body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "chat-scroll-" + turn, text: "turn " + turn + ": " + paragraph.repeat(3) }),
    });
    assert.equal(submitted.status, 202, "turn " + turn + " was admitted: " + await submitted.text());
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await backendJson<ConversationStateBody>(stack, "/api/conversations/" + conversationId + "/state");
      if (!state.busy && state.entries.at(-1)?.role === "assistant") break;
      if (Date.now() > deadline) throw new Error("turn " + turn + " did not settle");
      await delay(50);
    }
  }
  const settled = await backendJson<ConversationStateBody>(stack, "/api/conversations/" + conversationId + "/state");
  check(settled.entries.length >= TURNS * 2, "the conversation is " + settled.entries.length + " entries long, so its transcript cannot fit one screen");

  // --- 3. The page a reader opens: the transcript scrolls, and the page itself does not. ---------------------------
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addCookies(cookie.split("; ").map((pair) => {
    const index = pair.indexOf("=");
    return { name: pair.slice(0, index), value: pair.slice(index + 1), url: stack.webOrigin, httpOnly: true };
  }));
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(stack.webOrigin + "/?session=" + encodeURIComponent(conversationId), { waitUntil: "domcontentloaded" });
  const scroll = page.locator("[data-chat-scroll]");
  await scroll.waitFor({ timeout: 60_000 });
  // The transcript is only measured once it holds the conversation: a turn of it is on screen.
  await page.locator(".markdown-user-message").first().waitFor({ timeout: 60_000 });

  const measured = await scroll.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rootElement = document.getElementById("root");
    if (rootElement === null) throw new Error("the page has no #root");
    const root = rootElement.getBoundingClientRect();
    // A transcript opens at its tail, so a downward gesture is only observable from the top: the reader's own position
    // is stated here rather than assumed, and the measurement starts where scrolling down has somewhere to go.
    element.scrollTop = 0;
    const before = element.scrollTop;
    element.scrollTop = before + 120;
    const afterDown = element.scrollTop;
    element.scrollTop = element.scrollHeight;
    return {
      viewport: window.innerHeight,
      rootHeight: root.height,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      bottom: rect.bottom,
      before,
      afterDown,
      afterTail: element.scrollTop,
      overflowY: getComputedStyle(element).overflowY,
      pageScrollHeight: document.documentElement.scrollHeight,
    };
  });
  console.log("  .. " + JSON.stringify(measured));
  check(measured.rootHeight <= measured.viewport + 1, "the host is bounded by the viewport: #root " + measured.rootHeight + " of " + measured.viewport);
  check(measured.scrollHeight > measured.clientHeight, "the transcript is taller than the box that shows it: " + measured.scrollHeight + " > " + measured.clientHeight);
  check(measured.overflowY === "auto", "the transcript is the page's one scroller: overflow-y " + measured.overflowY);
  check(measured.clientHeight < measured.viewport, "the transcript's box is shorter than the viewport, so it ends inside the page: " + measured.clientHeight + " of " + measured.viewport);
  check(measured.bottom <= measured.viewport + 1, "and its bottom edge is on screen: " + measured.bottom + " of " + measured.viewport);
  check(measured.afterDown > measured.before, "scrolling the transcript moves it: " + measured.before + " -> " + measured.afterDown);
  check(measured.afterTail > measured.afterDown, "and its tail is reachable: " + measured.afterTail);
  check(measured.pageScrollHeight <= measured.viewport + 1, "the page itself never scrolls: document " + measured.pageScrollHeight + " of " + measured.viewport);
  check(pageErrors.length === 0, "the page raised no error: " + JSON.stringify(pageErrors));
} finally {
  await browser?.close().catch(() => {});
  await stack.close();
}

if (failures.length > 0) {
  console.log("\n" + failures.length + " failure(s):\n- " + failures.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
