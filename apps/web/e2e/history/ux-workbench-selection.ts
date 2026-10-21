/**
 * The workbench selection across a real page reload, driven in Chromium.
 *
 * The rules live in packages/ui/src/lib/workbench-selection.test.ts; this holds what only a browser can: the tab's and the
 * workspace's own memories surviving an actual reload, the shell's write-back to the address, and the composer's box coming
 * back with the text this tab was holding. It drives the reload half of N1 (an explicit URL is what opens), N2 (a reloaded
 * tab returns to the composer it was showing, with its draft; a workspace memory does not invent a first-frame restore) and
 * N7 (New is its own identity and parks what was on screen rather than losing it).
 *
 * Usage: node apps/web/e2e/history/ux-workbench-selection.ts [--keep]
 *        HEPI_WORKBENCH_SELECTION_PORT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_WORKBENCH_SELECTION_PORT ?? 43163);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-workbench-selection-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-workbench-selection.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  // The shipped Web build is Vite's, which compiles a `process.env.X` read to a property read off an object literal, so
  // the page never names `process`. A bare esbuild bundle does not, so the fixture states the same shape by hand: the
  // version the empty new-composer hero shows is that build's own answer, not something this scene is about.
  define: {
    "process.env.NODE_ENV": "\"production\"",
    "process.env.NEXT_PUBLIC_APP_VERSION": "undefined",
    "process.env.NEXT_PUBLIC_PI_VERSION": "undefined",
  },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>workbench selection</title></head>",
  "<body><div id=\"root\"></div><script type=\"module\" src=\"./ux-workbench-selection.fixture.js\"></script>",
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
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(port, "127.0.0.1", resolveListen);
});
const origin = "http://127.0.0.1:" + port;

const COMPOSER = "textarea[placeholder*=\"Message\"]";
const TAB_KEY = "pi-web:tab-open-session";
const WORKSPACE_KEY = "pi-web:last-open-by-workspace";

/** The composer's own box: the reader's view of a draft, not a store's. */
async function composerText(page: Page): Promise<string> {
  return await page.locator(COMPOSER).inputValue();
}

/** The connection's recorded reads, as the page states them. */
async function reads(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window.__uxSelectionFixture?.requests ?? []).map((r) => r.path));
}

async function memory(page: Page, key: string): Promise<string | null> {
  const store = key === TAB_KEY ? "sessionStorage" : "localStorage";
  return await page.evaluate(([name, entry]) => (window as unknown as Record<string, Storage>)[name].getItem(entry), [store, key]);
}

/** A page that has finished its first-frame restore: the composer's box is what the shell shows when it has a target. */
async function openAt(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push("page error: " + error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  // One browser profile, so the workspace memory is shared the way it is between a user's tabs, and each page owns its
  // own sessionStorage — which is exactly what makes a tab memory and a workspace memory two different things.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    // --- 1. An explicit ?session= is what the page opens, and both memories record what landed. --------------------
    const page = await openAt(context, origin + "/?session=two");
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    const initial = await reads(page);
    check(initial.some(path => path.startsWith("/api/conversations/two")), "the ?session target is the conversation the page read: " + JSON.stringify(initial.slice(0, 4)));
    check(await memory(page, TAB_KEY) === JSON.stringify({ kind: "session", sessionId: "two" }), "the tab remembers the conversation it is showing");
    check((await memory(page, WORKSPACE_KEY))?.includes("two") === true, "and the workspace memory records the accepted selection");

    // --- 2. A real reload of that address comes back to the same conversation, not to a blank page. -----------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(COMPOSER).waitFor({ timeout: 30000 });
    const reloaded = await reads(page);
    check(reloaded.some(path => path.startsWith("/api/conversations/two")), "a reload reads the same conversation again");
    check((await memory(page, TAB_KEY))?.includes("two") === true, "and the tab's memory survived the reload");

    // --- 3. A new tab of the same profile: the workspace memory is not a first-frame restore. ----------------------
    const fresh = await openAt(context, origin + "/");
    await fresh.locator(".sidebar-new-button").waitFor({ timeout: 30000 });
    await fresh.waitForTimeout(1500);
    const freshReads = await reads(fresh);
    check(!freshReads.some(path => /^\/api\/conversations\/(one|two)(\/|$)/.test(path)), "a tab with no URL and no tab memory opens no conversation: " + JSON.stringify(freshReads.slice(0, 4)));
    check(await memory(fresh, TAB_KEY) === null, "which is the tab's own memory, not the profile's");

    // --- 4. N1 again: a ?cwd= URL is a fresh composer's target, so no conversation is read at all. ------------------
    await fresh.goto(origin + "/?cwd=%2Fsrv%2Ftwo", { waitUntil: "domcontentloaded" });
    await fresh.locator(COMPOSER).waitFor({ timeout: 30000 });
    const cwdReads = await reads(fresh);
    check(!cwdReads.some(path => /^\/api\/conversations\/(one|two)(\/|$)/.test(path)), "a ?cwd= URL names a composer, so no conversation is read: " + JSON.stringify(cwdReads.slice(0, 6)));

    // --- 5. N2: the composer's own text comes back to the box across a real reload. -------------------------------
    await fresh.locator(COMPOSER).fill("half written before the reload");
    await fresh.waitForTimeout(400);
    const tabMemory = await memory(fresh, TAB_KEY);
    check(tabMemory?.includes('\"kind\":\"new\"') === true, "the tab remembers the composer it was showing: " + tabMemory);
    const draftKey = await fresh.evaluate((entry) => {
      const raw = window.sessionStorage.getItem(entry);
      return raw === null ? null : (JSON.parse(raw) as { draftKey?: string }).draftKey ?? null;
    }, TAB_KEY);
    check(draftKey !== null && draftKey.startsWith("new:"), "and it carries the composer's own draft key: " + draftKey);
    // The mirror entry's name is the connection's scope, then the composer's key: the same conversation id on another
    // profile is a different entry, which is what a draft isolation depends on. It is asserted by reading the page's own
    // store back rather than by naming a prefix, so a scope change cannot silently make this check vacuous.
    const mirrorNames = await fresh.evaluate((entry) => Object.keys(window.sessionStorage).filter(name => name.startsWith("pi-web:composer-draft:value:")), TAB_KEY);
    check(mirrorNames.length === 1 && mirrorNames[0]?.endsWith("/" + draftKey) === true, "the draft is mirrored under one entry, named by its connection's scope then the composer's key: " + JSON.stringify(mirrorNames));

    await fresh.reload({ waitUntil: "domcontentloaded" });
    await fresh.locator(COMPOSER).waitFor({ timeout: 30000 });
    check(await composerText(fresh) === "half written before the reload", "a real reload puts this tab's own unsent text back in the box");
    const reloadedKey = await fresh.evaluate((entry) => {
      const raw = window.sessionStorage.getItem(entry);
      return raw === null ? null : (JSON.parse(raw) as { draftKey?: string }).draftKey ?? null;
    }, TAB_KEY);
    check(reloadedKey === draftKey, "and the reloaded composer is the same identity, not a new one: " + reloadedKey);

    // --- 6. N7: New is a separate identity; the folder's text goes to the park, nothing is deleted. ----------------
    await fresh.locator(".sidebar-new-button").click();
    await fresh.waitForTimeout(500);
    check(await composerText(fresh) === "", "New starts an empty composer instead of carrying the text on screen");
    const newKey = await fresh.evaluate((entry) => {
      const raw = window.sessionStorage.getItem(entry);
      return raw === null ? null : (JSON.parse(raw) as { draftKey?: string }).draftKey ?? null;
    }, TAB_KEY);
    check(newKey !== null && newKey !== draftKey, "New is its own composer identity: " + newKey);
    await fresh.reload({ waitUntil: "domcontentloaded" });
    await fresh.locator(COMPOSER).waitFor({ timeout: 30000 });
    check(await composerText(fresh) === "", "and the reload keeps the new composer empty: the parked text is a different identity");

    // --- 7. Deleting the conversation on screen leaves for its folder's composer, and deletes no draft. --------------
    const doomed = await openAt(context, origin + "/?session=one");
    await doomed.locator(COMPOSER).waitFor({ timeout: 30000 });
    await doomed.locator(COMPOSER).fill("unsent in the conversation being removed");
    await doomed.waitForTimeout(400);
    // The folder's group opens first: its conversations are rows under it, not rows of the tree's spine.
    const collapsed = doomed.locator(".session-tree-group-toggle[aria-expanded='false']");
    for (let index = 0; index < await collapsed.count(); index += 1) await collapsed.nth(index).click();
    const keysNow = await doomed.evaluate(() => [...document.querySelectorAll("[data-row-key]")].map((node) => node.getAttribute("data-row-key")));
    check(keysNow.some((key) => key?.startsWith("session:")), "the folder's conversations are rows once its group is open: " + JSON.stringify(keysNow));
    const row = doomed.locator("[data-row-key='session:group:one']").first();
    await row.waitFor({ timeout: 15000 });
    await row.hover();
    // The button's own icon is what a pointer lands on, so it is what the click addresses.
    await row.getByRole("button", { name: "More actions" }).locator("svg").click();
    const menuNames = await doomed.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
    check(menuNames.length > 0, "the row menu opened with its actions: " + JSON.stringify(menuNames));
    // By position in the menu the sidebar itself just stated, so the scene does not depend on how an accessible name is
    // assembled from a label, an icon and a keyboard hint.
    await doomed.getByRole("menuitem").nth(menuNames.findIndex((name) => name.startsWith("Delete"))).evaluate((node) => (node as HTMLElement).click());
    const confirming = await doomed.locator(".session-tree-confirm-delete").count();
    check(confirming === 1, "Delete asks for its confirmation first: " + confirming);
    await doomed.locator(".session-tree-confirm-delete").click();
    // The removal is the selection's to hear: the conversation it was showing is gone, so the shell shows a composer for
    // the folder it was in rather than a conversation that no longer exists.
    await doomed.waitForFunction(() => window.sessionStorage.getItem("pi-web:tab-open-session")?.includes("\"kind\":\"new\"") === true, undefined, { timeout: 30000 });
    const afterDelete = JSON.parse((await memory(doomed, TAB_KEY)) ?? "{}") as { kind?: string; cwd?: string };
    check(afterDelete.kind === "new" && typeof afterDelete.cwd === "string" && afterDelete.cwd !== "", "deleting the open conversation leaves a composer rather than the removed conversation: " + JSON.stringify(afterDelete));
    check(await doomed.locator("[data-row-key='session:group:one']").count() === 0, "the removed row is gone from the sidebar without a reload");
    // The removal is not a draft deletion: the text this conversation held is still in this connection's store, so coming
    // back to it — or reading the entry — finds what the reader wrote.
    const survivingDrafts = await doomed.evaluate(() => Object.entries(window.sessionStorage)
      .filter(([name]) => name.startsWith("pi-web:composer-draft:value:"))
      .map(([name, value]) => name + "=" + String(value)));
    check(survivingDrafts.some((entry) => entry.includes("unsent in the conversation being removed")), "the removed conversation's unsent text is still stored, not deleted with it: " + JSON.stringify(survivingDrafts.map((entry) => entry.slice(0, 90))));

    // The landing is a fresh composer, not the removed conversation's text carried into it: what the reader typed there is
    // stored under that conversation's own key and is not theirs to lose.
    await doomed.locator(COMPOSER).waitFor({ timeout: 30000 });
    check(await doomed.locator(COMPOSER).inputValue() === "", "and the composer it leaves is empty: the conversation's text was not carried into it");

    // --- 8. A connection replacement is not a statement that the reader abandoned their text. ----------------------
    // The reviewer's P1: the composer's own unmount cleanup deleted its draft, so switching profiles lost the unsent text
    // and images of a fresh composer. Disposal is the selection's (it parks the draft), never a lifecycle cleanup's.
    const switched = await openAt(context, origin + "/?cwd=%2Fsrv%2Ftwo");
    await switched.locator(COMPOSER).waitFor({ timeout: 30000 });
    await switched.locator(COMPOSER).fill("unsent across the profile switch");
    await switched.waitForTimeout(500);
    const switchedKey = await switched.evaluate((entry) => {
      const raw = window.sessionStorage.getItem(entry);
      return raw === null ? null : (JSON.parse(raw) as { draftKey?: string }).draftKey ?? null;
    }, TAB_KEY);
    check(switchedKey !== null, "the composer has its own key before the switch: " + switchedKey);
    const storedBefore = await switched.evaluate(() => Object.entries(window.sessionStorage)
      .filter(([name]) => name.startsWith("pi-web:composer-draft:value:"))
      .map(([name, value]) => name + "=" + String(value)));
    check(storedBefore.some((entry) => entry.includes("unsent across the profile switch")), "its text is stored before the switch");
    await switched.evaluate(() => window.__uxSelectionFixture?.replaceConnection());
    await switched.locator(COMPOSER).waitFor({ timeout: 30000 });
    await switched.waitForTimeout(800);
    const storedAfter = await switched.evaluate(() => Object.entries(window.sessionStorage)
      .filter(([name]) => name.startsWith("pi-web:composer-draft:value:"))
      .map(([name, value]) => name + "=" + String(value)));
    check(storedAfter.some((entry) => entry.includes("unsent across the profile switch")),
      "a connection replacement leaves the previous connection's unsent text stored: " + JSON.stringify(storedAfter.map((entry) => entry.slice(0, 90))));

    // --- 9. A navigation only the raw-history surface can show opens it. -------------------------------------------
    // The reviewer's P2: the shell set the raw position but never opened the panel, so the offer landed on nothing.
    const deep = await openAt(context, origin + "/?session=one");
    await deep.locator(COMPOSER).waitFor({ timeout: 30000 });
    await deep.locator(".sidebar-search-toggle").first().click();
    await deep.locator("#session-search-input").fill("carried away");
    // The search results replace the tree while the query stands: one hit, in the conversation whose window does not
    // carry the entry.
    const hit = deep.locator("#session-sidebar button[aria-current]").filter({ hasText: "the one" }).first();
    await hit.waitFor({ timeout: 20000 });
    await hit.click();
    // The transcript's window does not carry the entry, so the surface states the named outcome and offers the raw read.
    const rawOffer = deep.getByRole("button", { name: "Open the raw history instead" });
    await rawOffer.waitFor({ timeout: 20000 });
    // The scene ships no stylesheet, so the phone drawer's backdrop — hidden by CSS in the product — sits over the page.
    // The click is the button's own, dispatched on the element the shell rendered.
    await rawOffer.evaluate((node) => (node as HTMLElement).click());
    const panel = deep.locator("[data-raw-history]");
    await panel.waitFor({ timeout: 20000 });
    check(await panel.getAttribute("data-raw-history") === "one", "the raw-history panel is on screen for the entry it was asked to show");
    await deep.locator("[data-raw-entry='gone']").waitFor({ timeout: 20000 });
    check(await deep.locator("[data-raw-focus='gone']").count() === 1, "and it is positioned on that entry");

    const unanswered = await doomed.evaluate(() => window.__uxSelectionFixture?.failures ?? []);
    check(unanswered.length === 0, "the fixture answered every route the removal asked: " + JSON.stringify(unanswered.slice(0, 5)));
    const errored = failures.filter(message => message.startsWith("page error:"));
    check(errored.length === 0, "no page error occurred during the browser steps: " + JSON.stringify(errored.slice(0, 3)));
  } finally {
    if (!keep) { await rm(buildDir, { recursive: true, force: true }); }
    await context.close();
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  check(false, "the driver threw: " + (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join(" | "));
} finally {
  // The fixture's own server is this process's last handle: left open, a passing run would look like a hang to whatever
  // invoked it, and its exit code would be the timeout's rather than the checks'.
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
if (failures.length > 0) for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
