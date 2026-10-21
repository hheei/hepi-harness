/**
 * Ticket 03 browser seam: selective subtree control, in a real browser, over the conversation API the page holds.
 *
 * The surfaces are the production ones — the child tree and `SubtreeControlPanel` arranged as the shell arranges them —
 * behind one real `createClient` whose transport is the fixture's and records every URL, body and credential. Nothing
 * about a subtree is decided here: the Backend owns the capture, the selection check and every child's control, and the
 * fixture answers with the shapes `apps/server` really publishes (per-child outcome, committed control, that child's own
 * catalogue row — as tickets 01 and 02 deliver them).
 *
 * What it asserts, in the order a person meets it:
 *   1. no request leaves the page before the confirmation, and the confirmation names the addressed root, the count, and
 *      every descendant with its own status — the addressed conversation itself is not offered, because its stop is a
 *      separate decision;
 *   2. a confirmed stop is exactly one POST, on the connection's own origin with its own credential, carrying no
 *      `selected` field so the Backend's capture governs the whole subtree;
 *   3. the answer keeps two facts per child: what the request **recorded** and what the child is doing **now**;
 *   4. a deselected child is excluded by id and a partial failure stays visible — a refusal and a removal each show the
 *      Backend's own reason, a removed child states no current row at all, and the set is labelled partial;
 *   5. the refresh re-reads the same request id and shows a drain that settled in the meantime while leaving the recorded
 *      outcome untouched — a lost race is refreshed, never rewritten;
 *   6. a lost answer is stated as lost, never re-sent under a new identity, and reading it back is a GET on the same id;
 *   7. a narrowed decision whose answer was lost survives the listing moving under it: resuming repeats the subset the
 *      user **confirmed** (not the one the current poll implies, and not nothing), a read-back that is still `pending`
 *      keeps the attempt, and a read-back that answers `completed` releases its identity so the next identical decision
 *      is a fresh capture rather than a replay of a finished request;
 *   8. a refusal is shown with the Backend's own code and message and made exactly one attempt;
 *   9. navigation stays available the whole time: a tree row still selects a conversation and a result row opens that
 *      child, and neither sends a control request.
 *
 * Usage: node apps/web/e2e/ux-subtree-control.mjs [--keep]
 *        HEPI_UX_SUBTREE_PORT=<port>
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_UX_SUBTREE_PORT ?? 43141);

const INGRESS_ORIGIN = "https://ingress.example:9443";
const BEARER = "subtree-device-bearer";

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-ux-subtree-"));
const { build } = await import(join(webRoot, "node_modules", "esbuild", "lib", "main.js"));
await build({
  entryPoints: [join(here, "ux-subtree-control.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});
await writeFile(join(buildDir, "index.html"), [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>subtree control</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-subtree-control.fixture.js\"></script>",
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

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    const requests = async () => await page.evaluate(() => window.__uxSubtree.connection);
    const opened = async () => await page.evaluate(() => window.__uxSubtree.opened);
    const setMode = async (mode) => { await page.evaluate((next) => window.__uxSubtree.setMode(next), mode); };
    const setListed = async (ids) => { await page.evaluate((next) => window.__uxSubtree.setListed(next), ids); };
    const posts = async () => (await requests()).filter((entry) => entry.method === "POST");
    const gets = async () => (await requests()).filter((entry) => entry.method === "GET");
    const row = (id) => page.locator(`[data-subtree-child="${id}"]`).first();
    const rowText = async (id) => (await row(id).innerText()).replace(/\s*\n\s*/g, " | ");
    const attrs = async (id) => [await row(id).getAttribute("data-subtree-status"), await row(id).getAttribute("data-subtree-now")];

    await page.locator("[data-subtree-control]").waitFor({ timeout: 30000 });

    // --- 1. Nothing leaves the page before the confirmation, which names what it is about to touch. -------------
    check((await requests()).length === 0, "an idle subtree surface asks for nothing: " + JSON.stringify(await requests()));
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    check((await posts()).length === 0, "opening the confirmation writes nothing");
    const confirmText = await page.locator("[data-subtree-confirm]").innerText();
    check(confirmText.includes("The addressed conversation"), "the confirmation names the addressed root: " + confirmText.slice(0, 80));
    check(confirmText.includes("3 descendant"), "and states how many it is about to reach");
    check((await page.locator('[data-subtree-choice="root"]').count()) === 0, "the addressed conversation is not offered: its own stop is a separate decision");
    for (const id of ["child-a", "child-b", "child-c"]) {
      check(await page.locator(`[data-subtree-choice="${id}"]`).isVisible(), "every descendant is listed for a decision: " + id);
    }
    const listed = await page.locator("[data-subtree-confirm] [data-run-status]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-run-status") + "=" + node.parentElement?.querySelector("input")?.checked));
    check(listed.join(",") === "running=true,held=true,running=true", "each one is shown with its own status and chosen by default: " + listed.join(","));
    // One confirmation can reach two execution hosts, so a host that is not the addressed conversation's own is named
    // before the button is pressed rather than discovered afterwards (spec open detail 2).
    check((await page.locator('[data-subtree-host="kr-box"]').count()) === 1, "a child running on another execution host is named as such in the confirmation");
    check((await page.locator("[data-subtree-confirm]").innerText()).includes("on kr-box"), "with the host its catalogue states, not this page's own");

    // Escape while a confirmation is open cancels it and writes nothing: the key means "not that", and it must not
    // fall through to the global Escape, which stops the addressed conversation — a different decision.
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.locator("[data-subtree-confirm]").waitFor({ state: "detached", timeout: 5000 });
    check((await posts()).length === 0, "Escape cancelled the confirmation and wrote nothing: " + JSON.stringify(await posts()));
    await page.locator('[data-subtree-action="stop"]').click();
    // --- 2. A confirmed whole-subtree stop is one POST on the connection's own origin, with its credential. -----
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });
    const written = await posts();
    check(written.length === 1, "a confirmed stop is exactly one write: " + written.length);
    check(written[0].url === INGRESS_ORIGIN + "/api/conversations/root/subtree-control", "addressed to the root, on the configured ingress origin: " + written[0].url);
    check(written[0].authorization === "Bearer " + BEARER, "presented the connection's own credential");
    const stopBody = JSON.parse(written[0].body);
    check(stopBody.action === "stop", "states the action the user chose");
    check(typeof stopBody.requestId === "string" && stopBody.requestId.length >= 8, "carries its own request identity: " + stopBody.requestId);
    check(stopBody.selected === undefined, "and names no selection, so the Backend's capture governs the whole subtree");
    check((await page.locator("[data-subtree-partial]").innerText()) === "3 child(ren) answered", "a clean result is not labelled partial");

    // --- 3. Two facts per child: what the request recorded, and what the child is doing now. --------------------
    const [aStatus, aNow] = await attrs("child-a");
    check(aStatus === "stopping" && aNow === "stopping", "a child the stop reached reads `stopping` recorded while it still drains");
    const [bStatus, bNow] = await attrs("child-b");
    check(bStatus === "held" && bNow === "held", "a child already held says so as its own outcome rather than `accepted`");
    const [cStatus, cNow] = await attrs("child-c");
    check(cStatus === "accepted" && cNow === "held", "a child that took the hold at once reads `accepted` over `held`, not one merged status");
    check((await rowText("child-a")).includes("Research the flaky suite"), "a child is named by its own title, not its id: " + await rowText("child-a"));

    // --- 4. A deselected child, and a partial failure that stays visible. ---------------------------------------
    await setMode("partial");
    await page.locator('[data-subtree-action="interrupt"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.locator('[data-subtree-choice="child-b"] input').click();
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });
    const interrupt = (await posts())[1];
    const interruptBody = JSON.parse(interrupt.body);
    check(interruptBody.action === "interrupt", "an interrupt is its own action, not an escalation of a stop");
    check(JSON.stringify(interruptBody.selected) === '["child-a","child-c"]', "the deselected child is named as excluded on the wire: " + interrupt.body);
    check(interruptBody.requestId !== stopBody.requestId, "a different decision is a different request identity");
    check((await page.locator("[data-subtree-partial]").innerText()) === "Partial: at least one child was not simply stopped", "the set is labelled partial rather than flattened");
    check((await rowText("child-a")).includes("refused · source_locked"), "a refusal shows the Backend's own reason: " + await rowText("child-a"));
    check((await rowText("child-c")).includes("conflict · it was removed"), "a removed child answers its own conflict");
    check((await attrs("child-c"))[1] === "unknown" && (await rowText("child-c")).includes("no current row"), "and states no current row, because no surface shows one");
    check((await page.locator('[data-subtree-child="child-b"]').count()) === 0, "the child this request excluded is answered as nothing at all, not as controlled");
    check((await posts()).length === 2, "a partial result is one write, not a retry per child");

    // --- 5. The refresh re-reads the same id: the race settles in `Now`, the record does not move. ---------------
    await setMode("answered");
    await page.locator("[data-subtree-refresh]").click();
    await page.locator("[data-subtree-pending]").waitFor({ state: "detached", timeout: 10000 });
    const readId = new URL((await gets()).at(-1).url).searchParams.get("requestId");
    check((await gets()).length === 1 && (await posts()).length === 2, "refreshing reads the request back and controls nothing new");
    check(readId === interruptBody.requestId, "under the id this attempt was made under: " + readId);
    check(((await attrs("child-a")).join("/")) === "stopping/held", "the drained child now reads `stopping` recorded over `held` now — refreshed, not rewritten");
    check((await attrs("child-c"))[1] === "idle", "and a settled one reads its own current state");
    check((await page.locator('[data-subtree-child="child-b"]').count()) === 0, "and the refresh still governs only the subset that request captured");

    // --- 6. A lost answer is stated as lost, never re-sent under a new identity. --------------------------------
    // The decision here is the narrowed one from step 4 (`child-b` stays excluded), so everything below concerns a subset.
    await setMode("dropped");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    const beforeLost = (await posts()).length;
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-lost]").waitFor({ timeout: 10000 });
    check((await posts()).length === beforeLost + 1, "a lost answer is not retried by the surface itself: " + (await posts()).length + " writes");
    const lost = JSON.parse((await posts()).at(-1).body);
    check(JSON.stringify(lost.selected) === '["child-a","child-c"]', "the lost decision named its own subset: " + JSON.stringify(lost.selected));
    const lostText = await page.locator("[data-subtree-lost]").innerText();
    check(lostText.includes("read it back"), "the user is told to read it back rather than send it again: " + lostText.slice(0, 90));

    // Deciding the same thing again — action button and confirmation both — is not a second request while the first one
    // is unresolved: the identity the Backend already captured under is repeated.
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-lost]").waitFor({ timeout: 10000 });
    const retried = JSON.parse((await posts()).at(-1).body);
    check(retried.requestId === lost.requestId, "the same decision retried keeps the same identity: " + retried.requestId);
    check((await posts()).length === beforeLost + 2, "and each attempt is exactly one write");

    // --- 7. What a resume repeats is the decision that was CONFIRMED, not the listing shown now. ----------------
    // A subtree listing is not still. The answer above was lost in transit, and before the user pressed `Resume` the poll
    // moved underneath the panel: `child-c` finished and left the family. Deriving the selection from the listing at that
    // moment would send `["child-a"]` instead, and sending no selection at all would let a request whose capture never
    // reached the Backend govern the WHOLE subtree — the deliberately excluded `child-b` included. Both quietly widen a
    // decision the user narrowed by hand. So the attempt (addressed conversation, action, identity, confirmed subset) is
    // persisted when the confirmation is accepted, and a resume reads it from there. No second confirmation is asked for:
    // that decision was already made.
    await setListed(["child-a", "child-b"]);
    await setMode("answered");
    const beforeResume = (await posts()).length;
    await page.locator("[data-subtree-resume]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });
    const resumed = JSON.parse((await posts()).at(-1).body);
    check((await posts()).length === beforeResume + 1, "a resume is one write, not a retry per child");
    check(resumed.requestId === lost.requestId, "resuming POSTs the same request id, so no second subtree is controlled: " + resumed.requestId);
    check(JSON.stringify(resumed.selected) === JSON.stringify(lost.selected), "with the confirmed subset unchanged though the listing moved: " + JSON.stringify(resumed.selected));
    check((await page.locator('[data-subtree-child="child-b"]').count()) === 0, "and the excluded child is governed by nothing here");

    // That answer completed, so the attempt is over: the same decision made again is a fresh capture. An identity held
    // past completion would be answered from the capture it already made, showing children as controlled while nothing
    // reached them. The listing comes back first, so this decision is the SAME narrowed subset and only the identity may
    // differ — anything else would be a different attempt by construction.
    await setListed(["child-a", "child-b", "child-c"]);
    await setMode("dropped");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-lost]").waitFor({ timeout: 10000 });
    const second = JSON.parse((await posts()).at(-1).body);
    check(JSON.stringify(second.selected) === JSON.stringify(lost.selected), "the same narrowed subset is still the decision on offer: " + JSON.stringify(second.selected));
    check(second.requestId !== lost.requestId, "and it is captured as a new request, because the settled answer released the identity: " + second.requestId);

    // --- 8. The read path settles the same two things. -------------------------------------------------------
    // `pending` is not the end of a request: the attempt survives an unfinished read whole — its id AND the subset that
    // was confirmed for it — and the panel offers that same attempt rather than a fresh write. The request is the one
    // section 7 left unanswered.
    await setMode("pending");
    const readsBefore = (await gets()).length;
    const writesBefore = (await posts()).length;
    await page.locator("[data-subtree-read]").click();
    await page.locator("[data-subtree-pending]").waitFor({ timeout: 10000 });
    check((await page.locator("[data-subtree-result]").getAttribute("data-subtree-result")) === "pending", "a half-answered request is stated as unfinished");
    check((await gets()).length === readsBefore + 1 && (await posts()).length === writesBefore, "reading it back wrote nothing and controlled nothing new");
    check(await page.locator("[data-subtree-resume]").isVisible(), "while the same attempt is still the one offered");
    await setMode("answered");
    await page.locator("[data-subtree-resume]").click();
    await page.locator("[data-subtree-pending]").waitFor({ state: "detached", timeout: 10000 });
    const resumedAgain = JSON.parse((await posts()).at(-1).body);
    check(resumedAgain.requestId === second.requestId, "resuming after that unfinished read repeats the same id: " + resumedAgain.requestId);
    check(JSON.stringify(resumedAgain.selected) === JSON.stringify(second.selected), "and the subset confirmed for that attempt: " + JSON.stringify(resumedAgain.selected));

    // A read-back that answers `completed` ends the request exactly as its own answer would, and releases the identity the
    // same way. This is where a lost race actually settles — no write of ours ever answered — so a release only wired to
    // the write path would leave a finished capture held, and the user's next decision on that subtree would be answered
    // from it: children shown as controlled, nothing reached.
    await setMode("dropped");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-lost]").waitFor({ timeout: 10000 });
    const pending = JSON.parse((await posts()).at(-1).body);
    await setMode("pending");
    await page.locator("[data-subtree-read]").click();
    await page.locator("[data-subtree-pending]").waitFor({ timeout: 10000 });
    await setMode("answered");
    const readsSettling = (await gets()).length;
    const writesSettling = (await posts()).length;
    await page.locator("[data-subtree-refresh]").click();
    await page.locator("[data-subtree-pending]").waitFor({ state: "detached", timeout: 10000 });
    check(new URL((await gets()).at(-1).url).searchParams.get("requestId") === pending.requestId, "the read that settled it names that same request: " + pending.requestId);
    check((await gets()).length === readsSettling + 1 && (await posts()).length === writesSettling, "and it settled with no write at all");
    await setMode("dropped");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-lost]").waitFor({ timeout: 10000 });
    const following = JSON.parse((await posts()).at(-1).body);
    check(JSON.stringify(following.selected) === JSON.stringify(lost.selected), "the same narrowed subset is still the decision the panel holds: " + JSON.stringify(following.selected));
    check(following.requestId !== pending.requestId, "while the completed read-back released its identity, so this is a fresh capture: " + following.requestId);
    await setMode("answered");
    await page.locator("[data-subtree-read]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });

    // --- 9. A refusal is the Backend's own statement, and it made exactly one attempt. -------------------------
    await setMode("refused");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    const writesBeforeRefusal = (await posts()).length;
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-refusal]").waitFor({ timeout: 10000 });
    check(await page.locator("[data-subtree-refusal]").getAttribute("data-subtree-refusal") === "outside_subtree", "the refusal carries the Backend's own code");
    check((await page.locator("[data-subtree-refusal]").innerText()).includes("not in the captured subtree of root"), "and its own message, not a paraphrase");
    check((await posts()).length === writesBeforeRefusal + 1, "a refused request made exactly one attempt, which the Backend rejected whole");

    // --- 10. Navigation stays available the whole time, and costs no control request. --------------------------
    // An exclusion the user made on a previous decision stays excluded until they choose it back: a refused or lost
    // request must not silently widen the next one. The Backend answers from its own capture either way.
    await setMode("answered");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    check((await page.locator('[data-subtree-choice="child-b"] input').isChecked()) === false, "a child excluded earlier is still excluded, so nothing is reached by silence");
    await page.locator('[data-subtree-choice="child-b"] input').click();
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator('[data-subtree-open="child-b"]').waitFor({ timeout: 10000 });
    const requestsBefore = (await requests()).length;
    await page.locator('[data-child-session="child-a"]').click();
    await page.locator('[data-subtree-open="child-b"]').click();
    await delay(200);
    check((await opened()).join(",") === "child-a,child-b", "a tree row still selects a child and a result row opens it: " + JSON.stringify(await opened()));
    check((await requests()).length === requestsBefore, "neither navigation act sent a request at all");
    check(await page.locator('[data-subtree-action="stop"]').isEnabled(), "the controls stay usable afterwards without a reload");
    check(await page.locator('[data-subtree-choice="child-b"] input').isVisible() === false, "the selection list is gone once the decision was made, so no stale choice remains to submit");

    const paths = new Set((await requests()).map((entry) => entry.url.slice(INGRESS_ORIGIN.length).split("?")[0]));
    check(paths.size === 1 && paths.has("/api/conversations/root/subtree-control"), "the subtree surface asked for no other route: " + JSON.stringify([...paths]));
    check((await requests()).every((entry) => entry.authorization === "Bearer " + BEARER), "every request presented the connection's own credential");
    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    // --- 11. The mixed matrix: the recorded outcome and the child's current row stay two columns. ---------------
    // The system acceptance needs one request that meets every state a real deployment produces. Every child takes the
    // hold here, so every recorded outcome is the same word; what differs is each child's OWN current row — blocked by the
    // runtime, interrupted by a restart, holding a queued report — and a surface that merged the two columns would have
    // nothing left to show.
    await setMode("mixed");
    await page.locator('[data-subtree-action="stop"]').click();
    await page.locator("[data-subtree-confirm]").waitFor({ timeout: 5000 });
    // An exclusion the user made earlier stays excluded until they choose it back — the previous sections narrowed this
    // subtree twice — so the whole-subtree decision below is the user choosing every child again, not a default.
    if ((await page.locator('[data-subtree-choice="child-b"] input').isChecked()) === false) await page.locator('[data-subtree-choice="child-b"] input').click();
    await page.locator("[data-subtree-confirm-submit]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });
    const mixedWrites = (await posts()).length;
    const mixedWritten = JSON.parse((await posts()).at(-1).body);
    check(mixedWritten.selected === undefined, "the mixed decision governs the whole subtree, as an omitted selection");
    check((await page.locator("[data-subtree-partial]").innerText()) === "3 child(ren) answered", "every child was controlled, so the set is not labelled partial");
    check((await attrs("child-a")).join("/") === "accepted/blocked", "a blocked child reads accepted over the runtime's own blocked row: " + (await attrs("child-a")).join("/"));
    check((await attrs("child-b")).join("/") === "accepted/interrupted", "an interrupted child reads accepted over interrupted: " + (await attrs("child-b")).join("/"));
    check((await attrs("child-c")).join("/") === "accepted/waiting-report", "a child whose report is queued reads accepted over waiting-report: " + (await attrs("child-c")).join("/"));
    // The rows are the same projection the child tree shows, in the same words and for the same ids: one conversation
    // never has two statuses on one screen. The tree lists them in tree order (a grandchild beneath its parent), so the
    // comparison is per id rather than positional.
    const treeRows = await page.locator("[data-child-session] [data-run-status]").evaluateAll((nodes) => nodes.map((node) => [node.closest("[data-child-session]")?.getAttribute("data-child-session"), node.getAttribute("data-run-status")]));
    const nowRows = await page.locator("[data-subtree-child]").evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("data-subtree-child"), node.getAttribute("data-subtree-now")]));
    const byId = (rows) => rows.slice().sort((left, right) => String(left[0]).localeCompare(String(right[0]))).map(([id, state]) => id + "=" + state).join(",");
    check(byId(treeRows) === byId(nowRows), "the tree states the same rows the answer does, per child: " + byId(treeRows) + " vs " + byId(nowRows));
    // A refresh re-reads the same id and states the same two columns: nothing is rewritten to match the present.
    const mixedReads = (await gets()).length;
    await page.locator("[data-subtree-refresh]").click();
    await page.locator("[data-subtree-result]").waitFor({ timeout: 10000 });
    check((await gets()).length === mixedReads + 1, "refreshing the mixed answer is one read");
    check((await posts()).length === mixedWrites, "and it made no write at all");
    check(new URL((await gets()).at(-1).url).searchParams.get("requestId") === mixedWritten.requestId, "the read names the request it was sent under");
    check((await attrs("child-a")).join("/") === "accepted/blocked" && (await attrs("child-b")).join("/") === "accepted/interrupted", "and the two columns are unchanged by the read");
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && error.code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_UX_SUBTREE_PORT"
    : "the fixture threw: " + (error instanceof Error ? error.stack ?? error.message : String(error));
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!keep) await rm(buildDir, { recursive: true, force: true });
  else console.log("build kept at " + buildDir);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
process.exit(exitCode);
