/**
 * Browser regression for review 160's two UI P2 findings, on the production components.
 *
 * The first finding: the raw-history panel applied whichever block answer arrived last, so opening block A and then
 * block B, with A answering second, left B selected and A's body under it. The panel now fences every answer by the
 * generation of the request that asked for it. What this drives is exactly that ordering — both reads held, released in
 * the reverse of their issue order — plus the two ends of the same guard: a stale *failure* must not replace the current
 * block's body with an error either, and a session change (and the connection switch behind it) retires the read that
 * was in flight rather than letting it land on the new history. A current failure still shows, because that is the
 * state the reader retries from.
 *
 * The second finding: a collapsed sidebar was hidden by width on the desktop and by a transform on a phone, and its
 * buttons stayed focusable and activatable in both. The shell now states `inert` for the collapsed state as well as for
 * the right panel's full-width mode. This drives a keyboard's own path — `Tab` to reach, `Enter` to activate — at both
 * viewports, and checks that closing the sidebar while its focus was inside hands the focus back to the toggle that
 * opened it, while a close from somewhere else leaves the focus where the reader put it.
 *
 * Usage: node apps/web/e2e/ux-raw-history-sidebar-focus.mjs [--keep]
 *        HEPI_RAW_SIDEBAR_PORT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_RAW_SIDEBAR_PORT ?? 43151);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-raw-sidebar-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-raw-history-sidebar-focus.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  loader: { ".css": "css" },
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-raw-sidebar-focus</title>",
  "<link rel=\"stylesheet\" href=\"./ux-raw-history-sidebar-focus.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-raw-history-sidebar-focus.fixture.js\"></script>",
  "</body></html>",
].join("\n"));

const server = createServer((request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  const type = name.includes("/") || name.includes("..") ? undefined : contentTypes[extname(name)];
  if (!type) { response.writeHead(404).end("not found"); return; }
  readFile(join(buildDir, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

/** The body the panel currently shows, and the block it is labelled with. */
const blockBody = (page) => page.locator("[data-raw-block-body]").evaluate((node) => ({
  selected: node.getAttribute("data-raw-block-body"),
  text: node.innerText.trim(),
}));

/** The shell's own sidebar toggle, which is the control a close hands focus back to. */
const sidebarToggle = (page) => page.getByRole("button", { name: /Hide sidebar|Show sidebar/ });

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  try {
    // ------------------------------------------------------------------ the block read race
    const raw = await browser.newPage();
    const rawErrors = [];
    raw.on("pageerror", (error) => rawErrors.push(error.message));
    await raw.goto(origin + "/", { waitUntil: "domcontentloaded" });

    console.log("== two block reads, the second answering first");
    await raw.locator("[data-raw-block=\"1:0\"]").waitFor({ timeout: 20000 });
    await raw.locator("[data-raw-block=\"1:0\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 1, undefined, { timeout: 20000 });
    await raw.locator("[data-raw-block=\"1:1\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 2, undefined, { timeout: 20000 });
    check(true, "both blocks were opened, so both reads are in flight");

    // The later read answers first and is the one the reader is looking at.
    await raw.evaluate(() => window.__rawSidebarGate.blocks[1].release("NEW BLOCK B"));
    await raw.waitForFunction(() => document.querySelector("[data-raw-block-body]")?.innerText.includes("NEW BLOCK B"), undefined, { timeout: 20000 });
    const afterSecond = await blockBody(raw);
    check(afterSecond.selected === "1:1" && afterSecond.text === "NEW BLOCK B", "the second block's own body is shown under it (" + JSON.stringify(afterSecond) + ")");

    // The earlier read answers last. It is no longer the reader's, so it must not replace what is on screen.
    await raw.evaluate(() => window.__rawSidebarGate.blocks[0].release("OLD BLOCK A"));
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 2, undefined, { timeout: 20000 });
    // A settled render is what says the answer was applied or dropped; the body is read after it rather than raced.
    await raw.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterFirst = await blockBody(raw);
    check(afterFirst.selected === "1:1" && afterFirst.text === "NEW BLOCK B", "the stale answer did not overwrite the selected block (" + JSON.stringify(afterFirst) + ")");
    check(!afterFirst.text.includes("OLD BLOCK A"), "the block the reader moved away from never appears under the one they chose");

    console.log("== a stale failure is dropped the same way");
    await raw.locator("[data-raw-block=\"1:0\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 3, undefined, { timeout: 20000 });
    await raw.locator("[data-raw-block=\"1:1\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 4, undefined, { timeout: 20000 });
    await raw.evaluate(() => window.__rawSidebarGate.blocks[3].release("CURRENT B"));
    await raw.waitForFunction(() => document.querySelector("[data-raw-block-body]")?.innerText.includes("CURRENT B"), undefined, { timeout: 20000 });
    // The first of the pair fails, and that failure belongs to a block nobody is reading any more.
    await raw.evaluate(() => window.__rawSidebarGate.blocks[2].fail("the read the reader left behind failed"));
    await raw.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterStaleFailure = await blockBody(raw);
    check(afterStaleFailure.text === "CURRENT B", "a failure from the abandoned read does not replace the current body (" + JSON.stringify(afterStaleFailure) + ")");
    check(await raw.locator("[data-raw-block-body] [role=alert]").count() === 0, "and it is not reported as an error on the block being read");

    console.log("== a current failure still shows, because it is what the reader retries");
    await raw.locator("[data-raw-block=\"1:0\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 5, undefined, { timeout: 20000 });
    await raw.evaluate(() => window.__rawSidebarGate.blocks[4].fail("this block could not be read"));
    await raw.locator("[data-raw-block-body] [role=alert]").waitFor({ timeout: 20000 });
    check(true, "the failure of the block actually selected is shown");
    check((await blockBody(raw)).selected === "1:0", "under the block it belongs to");

    console.log("== a session change retires the read that was in flight");
    await raw.locator("[data-raw-block=\"1:1\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 6, undefined, { timeout: 20000 });
    // The panel is handed a different conversation while the answer is still outstanding.
    await raw.evaluate(() => window.__rawSidebarGate.setSession("2"));
    await raw.waitForFunction(() => document.querySelector("[data-raw-history]")?.getAttribute("data-raw-history") === "2", undefined, { timeout: 20000 });
    await raw.evaluate(() => window.__rawSidebarGate.blocks[5].release("A BODY FROM THE PREVIOUS SESSION"));
    await raw.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    check(!(await raw.locator("body").innerText()).includes("A BODY FROM THE PREVIOUS SESSION"), "the answer to the retired read is not applied anywhere on the page");

    // The other half of the same ownership: a connection replaced underneath the *same* session id is a different
    // client, so the panel must ask it again rather than keep reading through the one it was handed before.
    console.log("== a connection replaced under the same session id is the connection the panel reads");
    await raw.evaluate(() => window.__rawSidebarGate.setSession("1"));
    await raw.waitForFunction(() => document.querySelector("[data-raw-history]")?.getAttribute("data-raw-history") === "1", undefined, { timeout: 20000 });
    await raw.locator("[data-raw-block=\"1:1\"]").click();
    await raw.waitForFunction(() => window.__rawSidebarGate.blocks.length === 7, undefined, { timeout: 20000 });
    check(await raw.evaluate(() => window.__rawSidebarGate.blocks.at(-1).connection === 0), "the outstanding read went out on the first connection");
    await raw.evaluate(() => window.__rawSidebarGate.replaceConnection());
    await raw.waitForFunction(() => document.querySelector("[data-raw-history-text]")?.innerText.includes("PAGE FROM CONNECTION 1") === true, undefined, { timeout: 20000 });
    check(true, "the panel re-read the page through the replaced connection, not the one it held");
    // The first client's outstanding answer arrives after the switch: a body for a history no longer on screen, asked
    // through a connection the panel no longer reads, so the panel drops it.
    await raw.evaluate(() => window.__rawSidebarGate.blocks.filter((block) => block.connection === 0).at(-1).release("A BODY FROM THE OLD CONNECTION"));
    await raw.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    check(!(await raw.locator("body").innerText()).includes("A BODY FROM THE OLD CONNECTION"), "the old connection's answer is not applied to the new one's history");

    check(rawErrors.length === 0, "no page error occurred in the block scene" + (rawErrors.length === 0 ? "" : ": " + rawErrors.join(" | ")));
    await raw.close();

    // ------------------------------------------------------------------ the closed sidebar
    for (const viewport of [{ name: "desktop", width: 900, height: 700 }, { name: "mobile", width: 390, height: 780 }]) {
      console.log("== a collapsed sidebar is unreachable from the keyboard (" + viewport.name + ", " + viewport.width + "px)");
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(origin + "/?sidebar=collapsed", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => window.__rawSidebarGate.setView("shell"));
      // The shell's own mount reads settle, and the sidebar's toggle is the surface the check starts from.
      await sidebarToggle(page).waitFor({ timeout: 20000 });
      await page.waitForFunction(() => window.__rawSidebarGate.requests.some((request) => request.includes("/api/conversations")), undefined, { timeout: 20000 });

      check(await page.locator("#session-sidebar").evaluate((node) => node.hasAttribute("inert")), "the closed sidebar states inert");
      // Nothing inside it is reachable: the browser's own focus navigation is what decides, so this asks the document
      // whether any of the sidebar's controls can take focus at all.
      const reachable = await page.evaluate(() => {
        const sidebar = document.querySelector("#session-sidebar");
        if (sidebar === null) return ["no sidebar"];
        const controls = Array.from(sidebar.querySelectorAll("button, [href], input, select, textarea, [tabindex]"));
        return controls.filter((control) => {
          control.focus();
          return document.activeElement === control;
        }).map((control) => (control.id || control.getAttribute("aria-label") || control.textContent || "control").trim().slice(0, 40));
      });
      check(reachable.length === 0, "no control inside it can take focus (" + reachable.length + " reachable" + (reachable.length === 0 ? "" : ": " + JSON.stringify(reachable)) + ")");

      // The keyboard's own path, from the top of the document: the first Tab must not land inside the closed sidebar.
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press("Tab");
      const afterTab = await page.evaluate(() => {
        const active = document.activeElement;
        return { insideSidebar: active?.closest("#session-sidebar") !== null, label: (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim().slice(0, 40) };
      });
      check(afterTab.insideSidebar === false, "the first Tab does not enter the closed sidebar (it lands on " + JSON.stringify(afterTab.label) + ")");

      // And it cannot be activated: pressing Enter on a sidebar control the driver reaches directly must not do anything
      // a reader could observe, because the element cannot be focused or clicked in the first place.
      const activatable = await page.evaluate(() => {
        const button = document.querySelector("#session-sidebar button");
        if (button === null) return "no button";
        button.focus();
        const focused = document.activeElement === button;
        button.click();
        return { focused, stillInert: document.querySelector("#session-sidebar")?.hasAttribute("inert") === true };
      });
      check(activatable.focused === false, "a control inside the closed sidebar cannot take focus, so Enter has nothing to activate (" + JSON.stringify(activatable) + ")");
      check(pageErrors.length === 0, "no page error occurred in the " + viewport.name + " sidebar scene" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
      await page.close();
    }

    // ------------------------------------------------------------------ focus recovery on close
    console.log("== closing the sidebar from inside hands focus back to its toggle");
    const focusPage = await browser.newPage({ viewport: { width: 900, height: 700 } });
    const focusErrors = [];
    focusPage.on("pageerror", (error) => focusErrors.push(error.message));
    await focusPage.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await focusPage.evaluate(() => window.__rawSidebarGate.setView("shell"));
    await sidebarToggle(focusPage).waitFor({ timeout: 20000 });
    await focusPage.waitForFunction(() => window.__rawSidebarGate.requests.some((request) => request.includes("/api/conversations")), undefined, { timeout: 20000 });

    // Open the sidebar, move focus into it the way a keyboard would, then close it with the toggle.
    check(await focusPage.locator("#session-sidebar").evaluate((node) => node.hasAttribute("inert")) === false, "the open sidebar is reachable");
    const inner = focusPage.locator("#session-sidebar button").first();
    await inner.waitFor({ timeout: 20000 });
    await inner.focus();
    check(await focusPage.evaluate(() => document.activeElement?.closest("#session-sidebar") !== null), "focus is inside the sidebar");
    await sidebarToggle(focusPage).click();
    await focusPage.waitForFunction(() => document.querySelector("#session-sidebar")?.hasAttribute("inert") === true, undefined, { timeout: 20000 });
    const afterClose = await focusPage.evaluate(() => {
      const active = document.activeElement;
      return { label: (active?.getAttribute("aria-label") ?? "").trim(), insideSidebar: active?.closest("#session-sidebar") !== null };
    });
    check(afterClose.insideSidebar === false, "the closed sidebar no longer holds the focus");
    check(afterClose.label === "Show sidebar", "focus went back to the toggle that opened it (it is on " + JSON.stringify(afterClose.label) + ")");

    console.log("== a close from outside the sidebar leaves the focus where the reader put it");
    // Reopen, put the focus somewhere outside the sidebar, then close it without a pointer press on the toggle — the
    // `click()` a script performs does not move focus the way a mouse does, so what the focus does afterwards is the
    // shell's decision rather than the browser's. A close that stranded nothing must leave it exactly where it was.
    await sidebarToggle(focusPage).click();
    await focusPage.waitForFunction(() => document.querySelector("#session-sidebar")?.hasAttribute("inert") === false, undefined, { timeout: 20000 });
    const outsideLabel = await focusPage.evaluate(() => {
      const sidebar = document.querySelector("#session-sidebar");
      const outside = Array.from(document.querySelectorAll("button[aria-label]"))
        .find((button) => sidebar !== null && !sidebar.contains(button) && button.getAttribute("aria-label") !== "Hide sidebar");
      outside?.focus();
      return (document.activeElement?.getAttribute("aria-label") ?? "").trim();
    });
    check(outsideLabel !== "" && outsideLabel !== "Hide sidebar", "the reader's focus is outside the sidebar (" + JSON.stringify(outsideLabel) + ")");
    await focusPage.evaluate(() => {
      const sidebar = document.querySelector("#session-sidebar");
      const toggle = Array.from(document.querySelectorAll("button[aria-label]"))
        .find((button) => button.getAttribute("aria-label") === "Hide sidebar");
      if (sidebar === null || toggle === undefined) throw new Error("the open sidebar or its toggle is missing");
      toggle.click();
    });
    await focusPage.waitForFunction(() => document.querySelector("#session-sidebar")?.hasAttribute("inert") === true, undefined, { timeout: 20000 });
    await focusPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterUnrelated = await focusPage.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? "").trim());
    check(afterUnrelated === outsideLabel, "an unrelated close did not steal the focus (" + JSON.stringify(outsideLabel) + " stayed, focus is on " + JSON.stringify(afterUnrelated) + ")");
    console.log("== the right panel expanding over an open sidebar does not move the focus");
    // The sidebar goes inert while the panel covers it, but the reader never closed it: handing focus to the toggle
    // then would be the shell deciding for them.
    await sidebarToggle(focusPage).click();
    await focusPage.waitForFunction(() => document.querySelector("#session-sidebar")?.hasAttribute("inert") === false, undefined, { timeout: 20000 });
    await focusPage.locator("#session-sidebar button").first().focus();
    check(await focusPage.evaluate(() => document.activeElement?.closest("#session-sidebar") !== null), "focus is inside the open sidebar again");
    await focusPage.evaluate(() => { document.querySelector("button[aria-label='Show file panel']")?.click(); });
    await focusPage.evaluate(() => { document.querySelector("button[aria-label='Expand file panel']")?.click(); });
    await focusPage.waitForFunction(() => document.querySelector("#session-sidebar")?.hasAttribute("inert") === true, undefined, { timeout: 20000 });
    await focusPage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterExpand = await focusPage.evaluate(() => ({
      label: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40),
      inside: document.activeElement?.closest("#session-sidebar") !== null,
    }));
    check(afterExpand.label !== "Show sidebar" && afterExpand.label !== "Hide sidebar", "covering it did not hand focus to the sidebar toggle (focus is on " + JSON.stringify(afterExpand.label) + ", inside=" + afterExpand.inside + ")");

    check(focusErrors.length === 0, "no page error occurred in the focus scene" + (focusErrors.length === 0 ? "" : ": " + focusErrors.join(" | ")));
    await focusPage.close();
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_RAW_SIDEBAR_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("fixture kept at " + buildDir);
}

console.log(failures.length === 0 ? "\nUX RAW-HISTORY / SIDEBAR-FOCUS CHECKS PASSED" : "\nUX RAW-HISTORY / SIDEBAR-FOCUS FAILURES:\n- " + failures.join("\n- "));
process.exit(exitCode);
