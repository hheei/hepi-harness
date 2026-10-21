/**
 * Browser journey for cross-session references ticket 02: create, reload, follow, and every named unavailable state.
 *
 * Usage: node apps/web/e2e/ux-references.mjs [--keep]
 *
 * The production reference panel and the production `ChatWindow` are mounted with only their network boundary replaced,
 * so the creation this drives is the real write path through `ConversationControl.addReference`, and the entry follow is
 * the real bounded target coordinator in the transcript. Nothing is asserted about a copy of either.
 *
 * Waits are on observable state — a rendered selector, a counter the fixture advances when the request it stands for
 * arrives — rather than on elapsed time, so a slow machine makes this slower rather than flakier.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_REFERENCES_PORT ?? 43141);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-references-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-references.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>ux-references</title>",
  "<link rel=\"stylesheet\" href=\"./ux-references.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-references.fixture.js\"></script>",
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

/** The picker's own progress: choose the target, then the entry the target's outline offered. */
async function createReference(page, { entry }) {
  // The action toggles its own form, so it is opened only when it is not already open. Waiting on the form rather than
  // on a delay is what makes the next step a statement about the surface instead of about the machine.
  if (await page.locator("[data-reference-creator]").count() === 0) await page.locator("[data-reference-create]").click();
  await page.locator("[data-reference-creator]").waitFor({ timeout: 10000 });
  await page.locator("[data-reference-target]").selectOption("77");
  if (entry) {
    // The entry options are the target's own outline anchors, so their arrival is what says the picker is ready.
    await page.locator("[data-reference-entry] option[value=\"150\"]").waitFor({ state: "attached" });
    await page.locator("[data-reference-entry]").selectOption("150");
  }
  await page.locator("[data-reference-label]").fill(entry ? "the referenced entry" : "the target conversation");
  await page.locator("[data-reference-submit]").click();
}

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") console.log("  page: " + message.text()); });
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    // --- 1. The create action is in the ordinary references surface, with conversation-only as the default target. ---
    await page.locator("[data-reference-surface]").waitFor({ timeout: 20000 });
    check(true, "the references surface is on screen as part of the conversation");
    await page.locator("[data-reference-create]").click();
    await page.locator("[data-reference-creator]").waitFor({ timeout: 5000 });
    check(await page.locator("[data-reference-entry]").inputValue() === "", "the entry selector starts empty, so the conversation is the default target");
    check(await page.locator("[data-reference-submit]").isDisabled(), "submitting is refused until a target conversation is chosen");

    // --- 2. A conversation-only reference is created through the owner and listed. ---
    await createReference(page, { entry: false });
    await page.locator("[data-reference='77:']").waitFor({ timeout: 10000 });
    check(await page.evaluate(() => window.__references.writes) === 1, "exactly one creation request reached the Backend owner");
    check(await page.locator("[data-reference-outcome]").count() === 0, "a reference that resolves renders no outcome state");
    check(await page.evaluate(() => window.__references.stored.length) === 1, "the owner holds one link");

    // --- 3. An entry reference chosen from the picker's known entries. ---
    await createReference(page, { entry: true });
    await page.locator("[data-reference='77:150']").waitFor({ timeout: 10000 });
    check(true, "the entry reference is listed by target plus entry");
    check((await page.locator("[data-reference='77:150'] [data-reference-follow]").innerText()).includes("150"), "and names the entry the picker offered");
    const storedAfterCreate = await page.evaluate(() => window.__references.stored);
    check(storedAfterCreate.length === 2 && storedAfterCreate[1].entryId === "150" && storedAfterCreate[1].label === "the referenced entry", "the stored record carries the owner's own fields: " + JSON.stringify(storedAfterCreate[1]));

    // --- 4. Both survive a reload: the list a reader sees afterwards is the Backend's. ---
    await page.evaluate(() => window.__references.reload());
    await page.locator("[data-reference='77:']").waitFor({ timeout: 10000 });
    await page.locator("[data-reference='77:150']").waitFor({ timeout: 10000 });
    check(true, "both references are read back from the owner after a remount");
    check(await page.evaluate(() => window.__references.writes) === 2, "a reload issues no new creation");

    // --- 5. Following a conversation reference opens that conversation, with no target read. ---
    const readsBeforeFollow = await page.evaluate(() => window.__references.navigationReads);
    await page.locator("[data-reference-follow='77:']").click();
    await page.waitForFunction(() => window.__references.opened.length === 1, undefined, { timeout: 10000 });
    const firstOpen = await page.evaluate(() => window.__references.opened[0]);
    check(firstOpen.sessionId === "77" && firstOpen.entryId === undefined, "the conversation reference opens the target conversation alone: " + JSON.stringify(firstOpen));
    check(await page.evaluate(() => window.__references.navigationReads) === readsBeforeFollow, "and asks for no target window at all");

    // Back to the conversation that makes the links, so the entry follow is the next thing measured.
    await page.evaluate(() => window.__references.reload());
    await page.locator("[data-reference='77:150']").waitFor({ timeout: 10000 });

    // --- 6. Following an entry reference lands on that entry through one bounded target read. ---
    const readsBeforeEntryFollow = await page.evaluate(() => window.__references.navigationReads);
    const olderBefore = await page.evaluate(() => window.__references.olderPages);
    await page.locator("[data-reference-follow='77:150']").click();
    await page.waitForFunction(() => window.__references.opened.length >= 2, undefined, { timeout: 10000 });
    const entryOpen = await page.evaluate(() => window.__references.opened.at(-1));
    check(entryOpen.sessionId === "77" && entryOpen.entryId === "150", "the entry reference names the entry to the shell's navigation seam: " + JSON.stringify(entryOpen));
    // The fixture's target window carries DEEP_ENTRY; the follow names OUTLINE_ENTRY, so what this asserts is the shape
    // of the request rather than which entry the fixture happens to answer: one bounded target read, no page walk.
    await page.waitForFunction(() => window.__references.navigationReads === 1, undefined, { timeout: 10000 });
    check(await page.evaluate(() => window.__references.navigationReads) === 1, "the entry follow issues exactly one bounded target read");
    check(await page.evaluate(() => window.__references.olderPages) === olderBefore, "and no older-history page was read while it settled");

    // --- 7. Every unavailable state renders its own name, with the offers that match it. ---
    for (const outcome of ["target-missing", "target-unavailable", "entry-missing", "entry-out-of-scope", "stale", "error"]) {
      await page.evaluate((next) => {
        window.__references.resolveAs(next);
        window.__references.reload();
      }, outcome);
      await page.locator("[data-reference-outcome='" + outcome + "']").first().waitFor({ timeout: 10000 });
      const state = page.locator("[data-reference-outcome='" + outcome + "']").first();
      const words = await state.innerText();
      check(words.length > 20, outcome + " states what happened in words a reader can act on: " + JSON.stringify(words.slice(0, 80)));
      // The offers are the ones the outcome supports: a retry only where a retry can change the answer, and a view of
      // the target only where there is a target left to view.
      check(await state.locator("[data-reference-retry]").count() === (outcome === "error" ? 1 : 0), outcome + (outcome === "error" ? " offers the retry a failed read needs" : " offers no retry that cannot work"));
      const targetOffered = outcome === "entry-missing" || outcome === "entry-out-of-scope" || outcome === "stale";
      check(await state.locator("[data-reference-open-target]").count() === (targetOffered ? 1 : 0), outcome + (targetOffered ? " still offers the surviving conversation" : " offers no view of a target that is gone"));
    }

    // A follow of an unresolvable reference reports the state it already shows and opens nothing: no silent landing.
    const openedBeforeRefusal = await page.evaluate(() => window.__references.opened.length);
    await page.locator("[data-reference-follow='77:']").click();
    await page.locator("[data-reference-outcome='error']").first().waitFor({ timeout: 5000 });
    check(await page.evaluate(() => window.__references.opened.length) === openedBeforeRefusal, "following a reference the Backend reports as unresolvable opens nothing");

    // --- 8. A refused creation says so by name and stores nothing. ---
    for (const refusal of ["target-unavailable", "entry-out-of-scope"]) {
      await page.evaluate((next) => {
        window.__references.resolveAs(null);
        window.__references.reload();
      }, refusal);
      await page.locator("[data-reference-create]").waitFor({ timeout: 10000 });
      const storedBefore = await page.evaluate(() => window.__references.stored.length);
      await page.evaluate((next) => window.__references.refuseNext(next), refusal);
      await page.locator("[data-reference-create]").click();
      await page.locator("[data-reference-target]").selectOption("77");
      await page.locator("[data-reference-label]").fill("a link the owner refuses");
      await page.locator("[data-reference-submit]").click();
      await page.locator("[data-reference-write-outcome='" + refusal + "']").waitFor({ timeout: 10000 });
      check(true, "a creation refused as " + refusal + " shows that name");
      check((await page.locator("[data-reference-write-outcome]").innerText()).includes("Nothing was stored"), "and says nothing was stored");
      check(await page.evaluate(() => window.__references.stored.length) === storedBefore, "the owner holds no new link for " + refusal);
    }

    // Three creations were attempted and refused; two were stored.
    check(await page.evaluate(() => window.__references.stored.length) === 2, "the refused creations added nothing to the owner's list");
    check(pageErrors.length === 0, "no page error occurred" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_REFERENCES_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("fixture kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
