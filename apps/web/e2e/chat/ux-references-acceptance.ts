/**
 * Browser acceptance for cross-session references ticket 03: the reference journeys over the **deployed shape**, not over
 * a replaced network boundary.
 *
 * Everything here is the real system: `apps/web/dist` served by the client ingress on the same origin as `/api`, the
 * session the ingress's own HttpOnly cookie, the real Backend over SQLite files this run created, and one controlled
 * model endpoint (see `acceptance-stack.ts`). Nothing is stubbed and no route is intercepted, so a creation driven here
 * is a real `POST /api/conversations/:id/references` answered by the reference owner's own membership check against a
 * real committed history, and a follow is the real bounded target coordinator asking the real navigation route.
 *
 * What each section is for:
 *
 *  - create a conversation-only reference and an entry reference through the picker, and read both back from the Backend
 *    after a full page reload;
 *  - follow the conversation reference: the target opens, and no target window is read at all;
 *  - follow the entry reference: exactly one bounded `/navigation/around` request, the exact entry placed, and no
 *    history paged toward it;
 *  - follow a reference into a **fork**, pinned to an entry the fork inherited from its source: the read is addressed in
 *    the fork's own conversation coordinate and the inherited entry lands;
 *  - a creation refused by the real owner stores nothing (the target was deleted while the picker was open, which is the
 *    ordinary way a stored target stops being one);
 *  - a stored reference to a target the user then removes is reported as `target-unavailable` on the next read;
 *  - a **real** outage on the reference route is named `read-failed` and its retry lands once the Backend answers again —
 *    the Backend is stopped and restarted, never intercepted.
 *
 * Named states that this stack cannot reach through an ordinary lifecycle are not faked here: `entry-missing` and
 * `entry-out-of-scope` cannot be produced from the picker by construction — the picker offers the target's own outline
 * anchors and the owner validates them — so those rows stay at the seams that prove them (ticket 01's route assertions,
 * ticket 02's browser scene for their rendering). No journey here probes an authorization, scope or capability boundary.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/chat/ux-references-acceptance.ts [--keep]
 *        HEPI_XREF03_INGRESS_PORT / HEPI_XREF03_BACKEND_PORT / HEPI_XREF03_GATEWAY_PORT / HEPI_XREF03_APP_PORT
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import type { NavigationOutlinePage, ResolvedReference } from "@hepi/protocol";
import { backendJson, buildFacts, type ConversationStateBody, type CreatedConversationBody, repoRoot, startAcceptanceStack, webLogin, webRoot } from "../acceptance/acceptance-stack.ts";

const keep = process.argv.includes("--keep");
const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}
function note(message: string) { console.log("  ..  " + message); }

/** One encoded navigation coordinate, decoded: the conversation, its history scope and the entry it names. */
interface NavigationCoordinateWire {
  readonly v: number;
  readonly c: string;
  readonly s: string;
  readonly e: string;
}

/** One request the page made, kept as the method and the same-origin path a count is read off. */
interface PageRequest {
  readonly method: string;
  readonly url: string;
}

const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const sourceRevision = git(["rev-parse", "HEAD"]);
const sourceDirty = git(["status", "--porcelain"]).length > 0;
const facts = buildFacts({ webDir: join(webRoot, "dist") });
console.log("Provenance: source " + sourceRevision + (sourceDirty ? " (dirty tree)" : " (clean)") + ", web script " + facts.web.script + " (" + facts.web.scriptBytes + " B)");
assert.ok(facts.web.scriptBytes > 0, "build the Web product first: pnpm --filter @hepi/web build");

/** Turns of the target conversation: enough that its oldest entries are outside the active window, so an entry follow
 * is a real bounded target read rather than a scroll. */
const TURNS = 30;
/**
 * The turn the fork branches at: the newest one, so the branch inherits the whole long history and the entry a reference
 * pins is an **inherited** anchor its own active window does not carry — a real bounded target read in the fork's
 * coordinate rather than a scroll of what the fork already holds.
 */
const FORK_TURN = TURNS;

const stack = await startAcceptanceStack({
  label: "xref03",
  keep,
  ports: {
    app: Number(process.env.HEPI_XREF03_APP_PORT ?? 0),
    ingress: Number(process.env.HEPI_XREF03_INGRESS_PORT ?? 0),
    backend: Number(process.env.HEPI_XREF03_BACKEND_PORT ?? 0),
    gateway: Number(process.env.HEPI_XREF03_GATEWAY_PORT ?? 0),
  },
  log: (line) => console.log(line),
});

let browser: Browser | undefined;
const shutdown = async () => {
  await browser?.close().catch(() => {});
  await stack.close().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { console.log("Interrupted by " + signal + "; stopping what this run started"); void shutdown().then(() => process.exit(130)); });
}

// ---------------------------------------------------------------- seed, through the Backend's own public routes

const createConversation = async (requestId: string): Promise<string> => (await backendJson<CreatedConversationBody>(stack, "/api/conversations", {
  method: "POST",
  body: JSON.stringify({ workspaceId: "local", requestId }),
})).conversationId;

const outlineOf = (id: string) => backendJson<NavigationOutlinePage>(stack, "/api/conversations/" + encodeURIComponent(id) + "/navigation?limit=200");

/** One committed turn: submitted the way a client submits, and awaited by the anchor it commits. */
async function submitTurn(id: string, turn: number): Promise<NavigationOutlinePage> {
  await backendJson(stack, "/api/conversations/" + encodeURIComponent(id) + "/messages", {
    method: "POST",
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "xref03-" + id + "-" + turn, text: "turn " + turn + " of the target conversation" }),
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const page = await outlineOf(id);
    if (page.anchors.length >= turn) return page;
    if (Date.now() > deadline) throw new Error("turn " + turn + " of conversation " + id + " was never committed");
    await delay(120);
  }
}

let exitCode = 1;
try {
  const sourceId = await createConversation("xref03-source");
  const longId = await createConversation("xref03-long");
  const goneId = await createConversation("xref03-gone");
  const raceId = await createConversation("xref03-race");
  note("seeded conversations: source " + sourceId + ", long " + longId + ", to-be-removed " + goneId + ", to-be-deleted-mid-picker " + raceId);

  let longOutline: NavigationOutlinePage | undefined;
  for (let turn = 1; turn <= TURNS; turn += 1) {
    longOutline = await submitTurn(longId, turn);
  }
  if (longOutline === undefined) throw new Error("the target conversation committed no turn");
  const deepEntry = String(longOutline.anchors[0].entryId);
  const forkPointEntry = String(longOutline.anchors[FORK_TURN - 1].entryId);
  const fork = await backendJson<CreatedConversationBody>(stack, "/api/conversations/" + encodeURIComponent(longId) + "/fork", {
    method: "POST",
    body: JSON.stringify({ at: forkPointEntry, requestId: "xref03-fork" }),
  });
  const forkId = fork.conversationId;
  const forkOutline = await outlineOf(forkId);
  // The second inherited anchor, not the first: a distinct entry from the one the conversation follow lands on, and one
  // the fork's own active window still does not carry, so following it is a bounded read the fork really has to make.
  const inheritedEntry = String(forkOutline.anchors[1].entryId);
  const forkState = await backendJson<ConversationStateBody>(stack, "/api/conversations/" + encodeURIComponent(forkId) + "/state");
  check(
    forkOutline.anchors.length >= 2 && longOutline.anchors.some((anchor) => String(anchor.entryId) === inheritedEntry),
    "the fork inherited the source's committed anchors, in its own outline (" + forkOutline.anchors.length + " anchors)",
  );
  check(forkOutline.scope !== longOutline.scope, "and the fork's outline answers in its own scope (" + longOutline.scope + " / " + forkOutline.scope + ")");
  check(
    !(forkState.entries ?? []).map((entry) => String(entry.id)).includes(inheritedEntry),
    "the entry the fork reference pins (" + inheritedEntry + ") is inherited and outside the fork's own active window",
  );
  const longState = await backendJson<ConversationStateBody>(stack, "/api/conversations/" + encodeURIComponent(longId) + "/state");
  const windowIds = (longState.entries ?? []).map((entry) => String(entry.id));
  check(!windowIds.includes(deepEntry), "the oldest anchor (" + deepEntry + ") is outside the target's active window, so following it is a bounded read rather than a scroll");

  // ------------------------------------------------------------- the browser, admitted the way the page is admitted

  const cookie = await webLogin(stack);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-session", value: cookie.replace(/^hepi-web-session=/, ""), url: stack.webOrigin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  /** Every request the page made, so "one target read" and "no creation" are counted rather than believed. */
  const requests: PageRequest[] = [];
  page.on("request", (request) => requests.push({ method: request.method(), url: request.url().replace(stack.webOrigin, "") }));
  const countOf = (method: string, needle: string) => requests.filter((entry) => entry.method === method && entry.url.includes(needle)).length;
  const aroundReads = () => requests.filter((entry) => entry.url.includes("/navigation/around")).map((entry) => entry.url);
  /** The coordinate a target read was addressed by, decoded: the conversation, its scope and the entry it named. */
  const coordinateOf = (url: string): NavigationCoordinateWire | null => {
    const anchor = new URL(url, stack.webOrigin).searchParams.get("anchor") ?? "";
    if (!anchor.startsWith("nav1.")) return null;
    try { return JSON.parse(Buffer.from(anchor.slice("nav1.".length), "base64url").toString("utf8")) as NavigationCoordinateWire; } catch { return null; }
  };
  const referenceWrites = () => countOf("POST", "/references");
  /** Whether an entry is mounted and on screen: the landing, read off the DOM. */
  const placement = (entryId: string) => page.evaluate((id) => {
    const element = document.querySelector('[data-entry-id="' + id + '"]');
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top), height: Math.round(box.height), onScreen: box.top > -40 && box.top < window.innerHeight - 40 };
  }, entryId);
  const waitForPlacement = async (entryId: string, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const box = await placement(entryId);
      if (box !== null && box.onScreen) return box;
      if (Date.now() > deadline) throw new Error("the target entry " + entryId + " never came on screen; last placement " + JSON.stringify(box));
      await delay(150);
    }
  };
  const openFullHistory = async () => {
    const button = page.getByRole("button", { name: "Full history", exact: true });
    await button.first().click();
  };
  /** Navigate to the conversation that makes the links and open the panel that carries the surface. */
  const openSource = async () => {
    await page.goto(stack.webOrigin + "/?session=" + encodeURIComponent(sourceId), { waitUntil: "domcontentloaded" });
    await openFullHistory();
    await page.locator("[data-reference-surface]").waitFor({ timeout: 60_000 });
  };
  /** Create one reference the way a user does: the action, the picker, the target, the optional entry, the label. */
  const createReference = async ({ target, entry, label }: { target: string; entry?: string; label: string }) => {
    if (await page.locator("[data-reference-creator]").count() === 0) await page.locator("[data-reference-create]").click();
    await page.locator("[data-reference-creator]").waitFor({ timeout: 30_000 });
    await page.locator("[data-reference-target]").selectOption(target);
    if (entry !== undefined) {
      await page.locator('[data-reference-entry] option[value="' + entry + '"]').waitFor({ state: "attached", timeout: 30_000 });
      await page.locator("[data-reference-entry]").selectOption(entry);
    }
    await page.locator("[data-reference-label]").fill(label);
    await page.locator("[data-reference-submit]").click();
  };
  const referencesOf = async (id: string): Promise<readonly ResolvedReference[]> =>
    (await backendJson<{ readonly references?: readonly ResolvedReference[] }>(stack, "/api/conversations/" + encodeURIComponent(id))).references ?? [];

  console.log("== the reference surface is part of the deployed page, over the real Backend");
  await openSource();
  check(true, "the references surface renders inside the Full history panel of the real page");
  await page.locator("[data-reference-empty]").waitFor({ timeout: 30_000 });
  check(await page.locator("[data-reference-empty]").count() === 1, "a conversation with no links says so rather than showing nothing");

  console.log("== creation: a conversation-only reference and an entry reference, through the picker");
  const writesBefore = referenceWrites();
  await createReference({ target: goneId, label: "the conversation to remove" });
  await page.locator("[data-reference='" + goneId + ":']").waitFor({ timeout: 30_000 });
  check(referenceWrites() === writesBefore + 1, "creating a conversation reference issued exactly one creation request to the Backend");
  await createReference({ target: longId, entry: deepEntry, label: "the deep entry" });
  await page.locator("[data-reference='" + longId + ":" + deepEntry + "']").waitFor({ timeout: 30_000 });
  check(referenceWrites() === writesBefore + 2, "creating an entry reference issued one more, and nothing else wrote");
  const storedAfterCreate = await referencesOf(sourceId);
  check(storedAfterCreate.length === 2, "the Backend's own list holds the two links: " + JSON.stringify(storedAfterCreate.map((reference) => reference.conversationId + ":" + (reference.entryId ?? ""))));
  check(
    storedAfterCreate.some((reference) => reference.conversationId === goneId && reference.entryId === undefined)
      && storedAfterCreate.some((reference) => reference.conversationId === longId && reference.entryId === deepEntry),
    "and each record carries exactly the target and entry the picker stated, with no copied content",
  );

  console.log("== both survive a full page reload, read back from the Backend");
  const writesBeforeReload = referenceWrites();
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFullHistory();
  await page.locator("[data-reference-surface]").waitFor({ timeout: 60_000 });
  await page.locator("[data-reference='" + goneId + ":']").waitFor({ timeout: 60_000 });
  await page.locator("[data-reference='" + longId + ":" + deepEntry + "']").waitFor({ timeout: 30_000 });
  check(true, "both links are listed again after the page reloaded");
  check(referenceWrites() === writesBeforeReload, "and the reload issued no creation");

  console.log("== following the conversation reference opens that conversation, with no target read");
  const aroundBeforeConversationFollow = aroundReads().length;
  await page.locator("[data-reference-follow='" + goneId + ":']").click();
  await page.waitForFunction((id) => new URLSearchParams(window.location.search).get("session") === id, goneId, { timeout: 60_000 });
  check(true, "the conversation reference opened the target conversation (" + page.url().split("?")[1] + ")");
  check(aroundReads().length === aroundBeforeConversationFollow, "and asked for no target window at all (" + (aroundReads().length - aroundBeforeConversationFollow) + " reads)");

  console.log("== following the entry reference lands on that entry through one bounded target read");
  await openSource();
  const aroundBeforeEntryFollow = aroundReads().length;
  const olderPagesBefore = countOf("GET", "/navigation?cursor=");
  await page.locator("[data-reference-follow='" + longId + ":" + deepEntry + "']").click();
  const landed = await waitForPlacement(deepEntry);
  check(true, "the referenced entry came on screen at " + landed.top + "px, " + landed.height + "px tall");
  await delay(1200);
  const entryFollowReads = aroundReads().slice(aroundBeforeEntryFollow);
  check(entryFollowReads.length === 1, "the entry follow issued exactly one bounded target read (" + entryFollowReads.length + ")");
  const entryCoordinate = entryFollowReads[0] === undefined ? null : coordinateOf(entryFollowReads[0]);
  check(
    entryCoordinate !== null && entryCoordinate.e === deepEntry && entryCoordinate.c === longId,
    "addressed by that entry's own identity in the target's own conversation: " + JSON.stringify(entryCoordinate),
  );
  check(countOf("GET", "/navigation?cursor=") === olderPagesBefore, "and no outline continuation page: a jump is a target read, never a walk toward it");
  check(await page.locator("[data-navigation-outcome]").count() === 0, "the landing is a landing, not a named failure");
  const landedText = await page.locator('[data-entry-id="' + deepEntry + '"]').innerText();
  check(landedText.includes("turn 1 of the target conversation"), "the landed turn carries the committed text of the entry that was named");

  console.log("== a reference into a fork resolves the entry the fork inherited, in the fork's own scope");
  await openSource();
  await createReference({ target: forkId, entry: inheritedEntry, label: "an inherited entry" });
  await page.locator("[data-reference='" + forkId + ":" + inheritedEntry + "']").waitFor({ timeout: 30_000 });
  check(true, "a reference to the fork, pinned to an entry it inherited from its source, was accepted and listed");
  const aroundBeforeForkFollow = aroundReads().length;
  await page.locator("[data-reference-follow='" + forkId + ":" + inheritedEntry + "']").click();
  const forkLanding = await waitForPlacement(inheritedEntry);
  check(true, "the inherited entry came on screen in the fork at " + forkLanding.top + "px");
  await delay(1200);
  const forkFollowReads = aroundReads().slice(aroundBeforeForkFollow);
  check(forkFollowReads.length === 1, "the fork follow issued exactly one bounded target read (" + forkFollowReads.length + ")");
  const forkCoordinate = forkFollowReads[0] === undefined ? null : coordinateOf(forkFollowReads[0]);
  check(
    forkCoordinate !== null && forkCoordinate.c === forkId && forkCoordinate.e === inheritedEntry,
    "and addressed the fork's own conversation coordinate rather than the source's: " + JSON.stringify(forkCoordinate),
  );
  check(new URL(page.url()).searchParams.get("session") === forkId, "the surface is the fork (" + page.url().split("?")[1] + ")");
  check((await referencesOf(forkId)).length === 0, "and the fork starts with no inherited references of its own");

  console.log("== a creation the real owner refuses stores nothing");
  // The ordinary way a stored target stops being one: the user removes it. Here it is removed while the picker that
  // chose it is still open, which is the same refusal a stale second window meets.
  await openSource();
  await page.locator("[data-reference-create]").click();
  await page.locator("[data-reference-creator]").waitFor({ timeout: 30_000 });
  await page.locator("[data-reference-target]").selectOption(raceId);
  await page.locator("[data-reference-label]").fill("a link to a conversation removed mid-picker");
  const storedBeforeRefusal = (await referencesOf(sourceId)).length;
  await backendJson(stack, "/api/conversations/" + encodeURIComponent(raceId), { method: "DELETE" });
  await page.locator("[data-reference-submit]").click();
  await page.locator("[data-reference-write-outcome='target-unavailable']").waitFor({ timeout: 30_000 });
  check(true, "the refused creation shows the Backend's own outcome name (target-unavailable)");
  check((await page.locator("[data-reference-write-outcome]").innerText()).includes("Nothing was stored"), "and says that nothing was stored");
  const storedAfterRefusal = await referencesOf(sourceId);
  check(storedAfterRefusal.length === storedBeforeRefusal, "the owner's list gained no link for the refused creation (" + storedAfterRefusal.length + " held)");
  check(!storedAfterRefusal.some((reference) => reference.conversationId === raceId), "and no record names the removed target");

  console.log("== a stored reference to a target the user removes is reported by name");
  await backendJson(stack, "/api/conversations/" + encodeURIComponent(goneId), { method: "DELETE" });
  await openSource();
  await page.locator("[data-reference='" + goneId + ":']").waitFor({ timeout: 60_000 });
  const removedState = page.locator("[data-reference-outcome='target-unavailable']").first();
  await removedState.waitFor({ timeout: 30_000 });
  const removedWords = await removedState.innerText();
  check(removedWords.length > 20, "the removed target states what happened in words a reader can act on: " + JSON.stringify(removedWords.slice(0, 80)));
  check(await removedState.locator("[data-reference-open-target]").count() === 0, "and offers no view of a target that is gone");
  check(await removedState.locator("[data-reference-retry]").count() === 0, "nor a retry that cannot change a removal");
  const stillStored = await referencesOf(sourceId);
  check(stillStored.some((reference) => reference.conversationId === goneId), "the record itself is kept rather than cascaded away by the removal");

  console.log("== a real outage on the reference route is named, and its retry lands");
  // A genuine transient failure: the Backend process is stopped and started again. Nothing is intercepted, so what fails
  // is a real read over a real socket, and what lands is the same read answered by the restarted Backend.
  const backendPid = await stack.pidOf("backend");
  check(typeof backendPid === "number" && backendPid > 0, "this run knows the process it is about to stop (" + backendPid + ")");
  if (backendPid === null) throw new Error("this run could not name the Backend process it is about to stop");
  process.kill(backendPid, "SIGTERM");
  let stopped = false;
  for (let index = 0; index < 240 && !stopped; index += 1) {
    stopped = await fetch(stack.backendOrigin + "/api/workspaces", { headers: stack.backendHeaders, signal: AbortSignal.timeout(1000) })
      .then(() => false, () => true);
    if (!stopped) await delay(250);
  }
  check(stopped, "the Backend is really down (its own read no longer answers)");
  // Remount the panel: the reference list is read again on mount, which is the read that now fails. The panel is a
  // toggle, so closing and reopening it is what a reader does to ask again.
  await openFullHistory();
  await page.locator("[data-reference-surface]").waitFor({ state: "detached", timeout: 30_000 });
  await openFullHistory();
  await page.locator("[data-reference-surface]").waitFor({ timeout: 30_000 });
  const readFailed = page.locator("[data-reference-read-failed]");
  await readFailed.waitFor({ timeout: 60_000 });
  check(true, "the outage is named rather than shown as a conversation with no links");
  check(await page.locator("[data-reference-empty]").count() === 0, "and it is not reported as an empty list");
  await page.locator("[data-reference-reload]").click();
  await delay(1500);
  check(await page.locator("[data-reference-read-failed]").count() === 1, "a retry while the Backend is still down reports the same named failure again");
  await stack.restartBackend();
  await page.locator("[data-reference-reload]").click();
  await page.locator("[data-reference='" + longId + ":" + deepEntry + "']").waitFor({ timeout: 60_000 });
  check(true, "the retry after the Backend answered again lists the stored links");
  check(await page.locator("[data-reference-read-failed]").count() === 0, "and the failure state is gone because the read landed");
  // The links a live outage did not disturb are the ones the Backend still holds: an outage is not a write.
  const afterOutage = await referencesOf(sourceId);
  check(afterOutage.length === 3, "the stored links survived the outage unchanged (" + afterOutage.length + " held)");

  console.log("== following still works on the reference surface after the outage");
  const aroundBeforeRecovery = aroundReads().length;
  await page.locator("[data-reference-follow='" + longId + ":" + deepEntry + "']").click();
  await waitForPlacement(deepEntry);
  check(true, "the entry follow landed on the same bounded read it did before");
  check(aroundReads().length === aroundBeforeRecovery + 1, "for exactly one target read (" + (aroundReads().length - aroundBeforeRecovery) + ")");

  check(pageErrors.length === 0, "no page error occurred across the whole journey" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error ? error.stack ?? error.message : String(error);
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await browser?.close().catch(() => {});
  await stack.close().catch(() => {});
  if (keep) console.log("artifacts kept in " + stack.artifacts);
  console.log(failures.length === 0 ? "\nCROSS-SESSION REFERENCES ACCEPTANCE PASSED" : "\nCROSS-SESSION REFERENCES FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
