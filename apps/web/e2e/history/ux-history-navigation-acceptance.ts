/**
 * Browser acceptance for history-navigation ticket 05: the whole journey a person makes across a long, compacted and
 * forked conversation, on the shipped Web build, the real client ingress and a real Backend over SQLite.
 *
 * Everything is the deployed shape and nothing is stubbed: `apps/web/dist` is served by the ingress on the same origin
 * as `/api`, the session is the ingress's own HttpOnly cookie, the Backend is the real one over a store this run
 * created, and the model endpoint is this driver's controlled server. The fixture
 * (`apps/server/scripts/history-navigation-acceptance-fixture.ts`) seeds the three facts the ticket names — a
 * conversation longer than the active window, a user message a compaction dropped from that window, and a fork that
 * inherited the long history — through the runtime's own public seams.
 *
 * What each check is for, and why it is a browser check:
 *
 *  - the rail lists committed anchors the transcript does not carry, with bounded previews, in the server's order;
 *  - a click on one of those anchors costs **one** bounded target read and lands on the exact entry — no walk over the
 *    pages between the transcript and the target, and nothing issued for the nodes the animation crosses;
 *  - a loaded anchor's local jump still costs nothing;
 *  - the outline's continuation is one read per activation, and the page it answers is listed without another read;
 *  - a turn committed after the outline was read extends the rail without changing an anchor it already held;
 *  - the fork lists the anchors it inherited, in its own conversation coordinate, and lands on one of them;
 *  - a deep search result whose entry is outside the window resolves through that same coordinator: one read, the exact
 *    block mounted, no page walk;
 *  - and no journey ends as a silently handled failure: the outcome names are read off the DOM in the second half of
 *    this driver, one journey each.
 *
 * The transcript is virtualized, so "the conversation is longer than what is mounted" is a fact this reads from the
 * DOM (mounted entries against the history's own entry count) rather than from a fixture's say-so.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/history/ux-history-navigation-acceptance.ts [--keep]
 *        HEPI_HN05_BACKEND_PORT / HEPI_HN05_INGRESS_PORT / HEPI_HN05_WEB_PORT
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright";
import type { NavigationOutlinePage } from "@hepi/protocol";
import {
  buildFacts, childEnv, freePort, repoRoot, startControlledModel, waitForHttp, webRoot, type ConversationStateBody,
} from "../acceptance/acceptance-stack.ts";

/** The identities the fixture states it seeded, read off its own line rather than guessed at. */
interface SeedFacts {
  readonly longId: string;
  readonly forkId: string;
  readonly userEntryIds: string[];
  readonly compactedEntryId: string;
  readonly compactedText: string;
  readonly summaryEntryId: string;
  readonly forkPointText: string;
  readonly forkPointEntryId: string;
}

/** One rail node as the DOM states it. */
interface RailNode {
  readonly index: number;
  readonly entryId: string | null;
  readonly loaded: boolean;
  readonly visible: boolean;
}

/** Where a mounted entry sits against the viewport, and whether that is "on screen". */
interface Placement {
  readonly top: number;
  readonly height: number;
  readonly onScreen: boolean;
}

/** The banner an unresolved lookup leaves: its own name, its sentence, and whether it offers a retry. */
interface OutcomeBanner {
  readonly name: string | null;
  readonly text: string;
  readonly retry: boolean;
}

/** One answer this driver reads a status and, on a refusal, a code off. */
interface StatusAnswer {
  readonly code?: string;
  readonly entries?: unknown;
}

/** One search answer, as far as this driver reads it. */
interface SearchAnswer {
  readonly results: { readonly session: { readonly id: string }; readonly entryId: string | number }[];
}

const keep = process.argv.includes("--keep");
const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}
function note(message: string) { console.log("  ..  " + message); }

/** The revision, and whether the tree it was measured on was clean, read before the first process starts. */
const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const sourceRevision = git(["rev-parse", "HEAD"]);
const sourceDirty = git(["status", "--porcelain"]).length > 0;
const facts = buildFacts({ webDir: join(webRoot, "dist") });
console.log("Provenance: source " + sourceRevision + (sourceDirty ? " (dirty tree)" : " (clean)") + ", web script " + facts.web.script + " (" + facts.web.scriptBytes + " B)");
assert.ok(facts.web.scriptBytes > 0, "build the Web product first: pnpm --filter @hepi/web build");

const LOGIN = "ux-history-navigation-login";
const TOKEN = "ux-history-navigation-token";
const artifacts = await mkdtemp(join(tmpdir(), "hepi-hn05-"));
const fixtureRoot = join(artifacts, "fixture");
await mkdir(fixtureRoot, { recursive: true });

const model = await startControlledModel();
const backendPort = await freePort(Number(process.env.HEPI_HN05_BACKEND_PORT ?? 0));
const ingressPort = await freePort(Number(process.env.HEPI_HN05_INGRESS_PORT ?? 0));
const origin = "http://127.0.0.1:" + ingressPort;

const children: ChildProcess[] = [];
const capture = (child: ChildProcess) => {
  const chunks: string[] = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return () => chunks.join("");
};
const stop = async (child: ChildProcess | undefined) => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let index = 0; index < 40 && child.exitCode === null && child.signalCode === null; index += 1) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

let browser: Browser | undefined;
let exitCode = 1;
try {
  const fixture = spawn(process.execPath, [join(repoRoot, "apps", "server", "scripts", "history-navigation-acceptance-fixture.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "home"), {
      HEPI_HN05_FIXTURE: fixtureRoot,
      HEPI_HN05_DB: join(artifacts, "hn05.sqlite"),
      HEPI_HN05_BACKEND_PORT: String(backendPort),
      HEPI_HN05_INGRESS_PORT: String(ingressPort),
      HEPI_HN05_AUTH: TOKEN,
      HEPI_HN05_WEB_LOGIN: LOGIN,
      HEPI_HN05_ENDPOINT: model.origin,
      HEPI_HN05_WEB: join(webRoot, "dist"),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(fixture);
  const fixtureLog = capture(fixture);
  assert.ok(await waitForHttp(origin + "/api/web-auth", {}, 180_000), "the fixture's Backend and ingress started: " + fixtureLog().slice(-1500));
  const seeded = fixtureLog().match(/HEPI_HN05_SEED (\{.*\})/);
  assert.ok(seeded !== null, "the fixture stated the identities it seeded: " + fixtureLog().slice(-1500));
  const seed = JSON.parse(seeded[1]) as SeedFacts;
  note("seed: long " + seed.longId + ", fork " + seed.forkId + ", " + seed.userEntryIds.length + " committed anchors");

  const login = await fetch(origin + "/api/web-login", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(origin).host },
    body: JSON.stringify({ token: LOGIN }),
  });
  assert.equal(login.status, 200, "the browser session authenticated");
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const cookieValue = cookie.replace(/^hepi-web-session=/, "");

  /** One request under this page's credential, for the facts a browser check must not have to infer. */
  const backendJson = async <T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const headers: Record<string, string> = { cookie, origin, ...(init.headers as Record<string, string> | undefined) };
    const response = await fetch(origin + path, { ...init, headers });
    return { status: response.status, body: await response.json() as T };
  };

  // The seeded facts, read from the Backend before a browser opens: the compaction really hid the prefix from the
  // active window, and the fork really inherited the long conversation's history.
  const longState = await backendJson<ConversationStateBody>("/api/conversations/" + seed.longId + "/state");
  check(longState.status === 200, "the long conversation's state read answers");
  const activeIds = (longState.body.entries ?? []).map((entry) => String(entry.id));
  check(String(longState.body.historyHead) === seed.summaryEntryId, "the active window is led by the compaction's head marker (" + longState.body.historyHead + ")");
  check(!activeIds.includes(seed.compactedEntryId), "the compacted prefix is not in the active window (" + seed.compactedEntryId + " absent)");
  const longPage = await backendJson<NavigationOutlinePage>("/api/conversations/" + seed.longId + "/navigation");
  check(longPage.status === 200 && longPage.body.hasMore === true, "the outline's first page is bounded and states more history behind it (" + longPage.body.anchors.length + " anchors, hasMore " + longPage.body.hasMore + ")");
  const forkPage = await backendJson<NavigationOutlinePage>("/api/conversations/" + seed.forkId + "/navigation");
  check(forkPage.status === 200, "the fork's outline answers");
  check(
    forkPage.body.anchors.some((anchor) => anchor.entryId === seed.compactedEntryId),
    "the fork lists the anchor it inherited from the long conversation, in its own coordinate",
  );
  check(
    forkPage.body.scope !== longPage.body.scope,
    "and the two histories are stated as two scopes (" + longPage.body.scope + " / " + forkPage.body.scope + ")",
  );

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  await context.addCookies([{ name: "hepi-web-session", value: cookieValue, url: origin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  /** Every navigation read this page issues, so "one read" is counted rather than believed. */
  const reads: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/navigation")) reads.push(request.url().replace(origin, "")); });
  const aroundReads = () => reads.filter((url) => url.includes("/around"));
  const outlineReads = () => reads.filter((url) => !url.includes("/around"));

  /** The rail's nodes, in the order it renders them. */
  const nodes = async (): Promise<RailNode[]> => await page.evaluate(() => Array.from(document.querySelectorAll("[data-minimap-node-index]")).map((element) => ({
    index: Number(element.getAttribute("data-minimap-node-index")),
    entryId: element.getAttribute("data-minimap-node-entry"),
    loaded: element.hasAttribute("data-minimap-node-loaded"),
    visible: element.hasAttribute("data-minimap-node-visible"),
  })));
  /** The entry one rail node names, which a journey states rather than passing a name it hoped was there. */
  const entryIdOf = (node: RailNode): string => {
    if (node.entryId === null) throw new Error("the rail node at " + node.index + " names no entry");
    return node.entryId;
  };
  /** The entries the transcript has actually mounted — the DOM, not the history. */
  const mounted = async (): Promise<(string | null)[]> => await page.evaluate(() => Array.from(document.querySelectorAll("[data-entry-id]")).map((element) => element.getAttribute("data-entry-id")));
  const outcomeNames = async (): Promise<(string | null)[]> => await page.evaluate(() => Array.from(document.querySelectorAll("[data-navigation-outcome]")).map((element) => element.getAttribute("data-navigation-outcome")));
  /** Hover the rail at one node's own row, which is what a reader does before picking that node. */
  const hoverNode = async (index: number) => {
    const box = await page.locator('[data-minimap-node-index="' + index + '"]').boundingBox();
    assert.ok(box !== null, "the rail node " + index + " has geometry to hover");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('[data-minimap-preview-index="' + index + '"]').waitFor({ state: "visible", timeout: 20_000 });
  };
  /** Where a mounted entry sits against the viewport, and whether that is "on screen". */
  const placement = async (entryId: string): Promise<Placement | null> => await page.evaluate((id) => {
    const element = document.querySelector('[data-entry-id="' + id + '"]');
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top), height: Math.round(box.height), onScreen: box.top > -40 && box.top < window.innerHeight - 40 };
  }, entryId);
  const waitForPlacement = async (entryId: string, timeoutMs = 30_000): Promise<Placement> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const box = await placement(entryId);
      if (box !== null && box.onScreen) return box;
      if (Date.now() > deadline) throw new Error("the target " + entryId + " never came on screen; last placement " + JSON.stringify(box));
      await delay(150);
    }
  };

  console.log("== the rail lists the conversation's committed history, not only what the transcript mounted");
  await page.goto(origin + "/?session=" + seed.longId, { waitUntil: "domcontentloaded" });
  await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-loaded]").length > 0, undefined, { timeout: 60_000 });
  await delay(600);
  const listed = await nodes();
  const mountedIds = await mounted();
  const pageEntries = longPage.body.anchors.map((anchor) => anchor.entryId);
  const newestPageEntry = Number(pageEntries[pageEntries.length - 1]);
  // A *loaded* node is one the rail measured the geometry of. The transcript is virtualized, so that is a superset of
  // what is mounted at this instant: the window measures turns it is not currently painting. The mount set is therefore
  // checked as a subset, and the two rules below are stated separately rather than folded into one equality.
  const listedIds = listed.map((node) => node.entryId);
  note("rail " + listed.length + " nodes, transcript mounted " + mountedIds.length + " entries, history " + seed.userEntryIds.length + " anchors, first page " + pageEntries.length);
  check(pageEntries.every((entryId) => listedIds.includes(entryId)), "every anchor of the first page is listed (" + pageEntries.length + ")");
  check(
    listed.filter((node) => !node.loaded).length > 0,
    "and the rail lists anchors the transcript never measured (" + listed.filter((node) => !node.loaded).length + ")",
  );
  check(
    listedIds.join(",") === listedIds.slice().sort((left, right) => Number(left) - Number(right)).join(","),
    "in the server's cursor order, oldest first",
  );
  check(new Set(listedIds).size === listedIds.length, "with no anchor repeated");
  check(listed.filter((node) => !node.loaded).every((node) => !node.visible), "an unloaded node claims no visibility, because the rail has no geometry for it");
  // The one ordering rule the merge could get wrong: a loaded turn the *page* does not enumerate is a node only when it
  // is newer than the newest listed anchor. That is what keeps the rail's bottom edge level with the transcript without
  // fabricating an identity for the assistant-only prefix or the compaction marker.
  const tail = listed.filter((node) => !pageEntries.includes(node.entryId ?? ""));
  check(
    tail.every((node) => Number(node.entryId) > newestPageEntry) && tail.every((node) => node.loaded),
    "the nodes past the page are measured turns newer than its newest anchor (" + tail.length + " at " + tail.map((node) => node.entryId).join(",") + ")",
  );
  const mountedUserIds = await page.evaluate(() => Array.from(document.querySelectorAll("[data-entry-id]"))
    .map((element) => element.getAttribute("data-entry-id"))
    .filter((id) => document.querySelector('[data-entry-id="' + id + '"] .markdown-user-message, [data-entry-id="' + id + '"] [data-message-text]') !== null));
  check(
    mountedUserIds.every((entryId) => !listedIds.includes(entryId) || listed.find((node) => node.entryId === entryId)?.loaded === true),
    "every mounted turn the rail lists is marked loaded (" + mountedUserIds.length + " mounted)",
  );
  check(mountedIds.length < seed.userEntryIds.length * 2 + 4, "the transcript itself stays bounded rather than mounting the whole history (" + mountedIds.length + " of " + (seed.userEntryIds.length * 2 + 2) + " entries)");
  const railReads = outlineReads().length;
  check(railReads === 1, "opening the conversation cost one outline page and nothing else (" + railReads + " outline read)");

  console.log("== an unloaded anchor previews the committed text, bounded");
  const compactedNode = listed.find((node) => node.entryId === seed.compactedEntryId);
  check(compactedNode !== undefined && compactedNode.loaded === false, "the compacted opening question is listed as an unloaded anchor");
  if (compactedNode === undefined) throw new Error("the compacted entry is not listed as a node of the rail");
  await hoverNode(compactedNode.index);
  const preview = await page.locator('[data-minimap-preview-index="' + compactedNode.index + '"] [data-minimap-preview-user]').innerText();
  check(preview.trim() === seed.compactedText, "its preview is the committed text the active window no longer holds: " + JSON.stringify(preview.trim().slice(0, 60)));
  check(preview.trim().length <= 241, "and it is bounded rather than the whole message (" + preview.trim().length + " chars)");
  check(
    await page.locator('[data-minimap-preview-index="' + compactedNode.index + '"]').getAttribute("data-minimap-preview-loaded") === null,
    "the preview row of an unloaded anchor says so",
  );

  console.log("== one click on an unloaded anchor costs one bounded read and lands on that exact entry");
  check(!mountedIds.includes(seed.compactedEntryId), "the compacted entry is not mounted before the jump");
  const readsBefore = aroundReads().length;
  const outlineBefore = outlineReads().length;
  await page.locator('[data-minimap-preview-index="' + compactedNode.index + '"] [data-minimap-preview-user]').click();
  const landed = await waitForPlacement(seed.compactedEntryId);
  await delay(1200);
  check(true, "the compacted entry came on screen at " + landed.top + "px, " + landed.height + "px tall");
  check(aroundReads().length === readsBefore + 1, "the jump cost exactly one target read (" + (aroundReads().length - readsBefore) + ")");
  check(aroundReads()[readsBefore].includes("anchor=nav1."), "addressed by the coordinate the outline issued: " + aroundReads()[readsBefore].slice(0, 90));
  check(outlineReads().length === outlineBefore, "and no outline page was read on the way: a jump is a target read, never a walk toward it");
  check((await outcomeNames()).length === 0, "the landing is a landing, not a named failure");
  const landedText = await page.locator('[data-entry-id="' + seed.compactedEntryId + '"]').innerText();
  check(landedText.includes(seed.compactedText), "the landed turn carries the committed text, not a neighbour's");
  check(
    (await nodes()).find((node) => node.entryId === seed.compactedEntryId)?.loaded === true,
    "and the node the reader jumped to is now a loaded node of the rail",
  );

  console.log("== a loaded anchor's local jump issues no navigation read at all");
  const loadedNode = (await nodes()).find((node) => node.loaded && node.entryId !== seed.compactedEntryId);
  if (loadedNode === undefined) throw new Error("the rail lists no loaded node other than the compacted one");
  const loadedEntryId = entryIdOf(loadedNode);
  const beforeLocal = reads.length;
  await hoverNode(loadedNode.index);
  await page.locator('[data-minimap-preview-index="' + loadedNode.index + '"] [data-minimap-preview-user]').click();
  await waitForPlacement(loadedEntryId);
  check(true, "clicking a loaded anchor scrolled to its measured turn: " + loadedEntryId);
  check(reads.length === beforeLocal, "and it issued no navigation read, because the turn was already measured");

  console.log("== the outline's continuation is one read per activation, and the page it answers is listed for free");
  await hoverNode(compactedNode.index);
  const listedBeforeMore = await nodes();
  const nodesBefore = listedBeforeMore.length;
  const beforeMore = reads.length;
  check(await page.locator("[data-minimap-outline-more]").count() === 1, "the rail offers exactly one continuation control, and only because a page is still outstanding");
  const continuationReads = outlineReads().length;
  await page.locator("[data-minimap-outline-request]").click();
  // The state the ticket names is reached when the continuation is consumed, not by a sleep: the control is drawn only
  // while a page is outstanding or a read failed, so its absence is the answer that the last page arrived.
  await page.locator("[data-minimap-outline-more]").waitFor({ state: "detached", timeout: 30_000 });
  await delay(400);
  check(reads.length === beforeMore + 1, "reaching for the rest of the history asked for exactly one page (" + (reads.length - beforeMore) + ")");
  check(outlineReads().length === continuationReads + 1, "and that read was an outline page, not a target window");
  check(
    decodeURIComponent(reads[beforeMore]).includes("navigation?cursor="),
    "continued from the cursor the Backend issued rather than from a position the rail computed: " + decodeURIComponent(reads[beforeMore]).slice(0, 70),
  );
  check(reads.length === beforeMore + 1, "and nothing was read for the anchors it answered with");
  const afterMore = await nodes();
  check(
    listedBeforeMore.every((node, index) => afterMore[index].entryId === node.entryId && afterMore[index].loaded === node.loaded),
    "every anchor the rail already held kept its identity, its position and its loadedness (" + nodesBefore + " → " + afterMore.length + " nodes)",
  );
  // The tail the transcript measured is already listed, so the second page mostly *confirms* anchors the rail holds
  // from measurement rather than adding rows: what it adds is the anchors past the measured tail, if any, and what it
  // must never do is renumber or drop one.
  check(
    seed.userEntryIds.every((entryId) => afterMore.some((node) => node.entryId === entryId)),
    "after both pages every committed user anchor of the conversation is a node of the rail (" + seed.userEntryIds.filter((entryId) => afterMore.some((node) => node.entryId === entryId)).length + "/" + seed.userEntryIds.length + ")",
  );
  check(await page.locator("[data-minimap-outline-more]").count() === 0, "and the continuation is gone once the history it reached is complete");

  console.log("== a turn committed after the outline was read extends the rail without moving an anchor");
  const identitiesBefore = (await nodes()).map((node) => node.entryId);
  const requestId = "hn05-append-" + Date.now();
  const submitted = await backendJson<StatusAnswer>("/api/conversations/" + seed.longId + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId, text: "a turn committed after the outline was read" }),
  });
  check(submitted.status === 202, "the append was admitted (" + submitted.status + ")");
  let grown = false;
  for (let index = 0; index < 120 && !grown; index += 1) {
    const current = await nodes();
    grown = current.length > identitiesBefore.length || current.some((node) => !identitiesBefore.includes(node.entryId));
    if (!grown) await delay(250);
  }
  const identitiesAfter = (await nodes()).map((node) => node.entryId);
  check(grown, "the rail grew with the committed turn (" + identitiesBefore.length + " → " + identitiesAfter.length + " nodes)");
  check(
    identitiesBefore.every((entryId, index) => identitiesAfter[index] === entryId),
    "and every anchor it already held kept its identity and its position",
  );
  check(identitiesAfter.length > 0 && !identitiesBefore.includes(identitiesAfter[identitiesAfter.length - 1]), "the new anchor is the newest one, appended at the tail: " + identitiesAfter[identitiesAfter.length - 1]);
  check((await outcomeNames()).length === 0, "an append is not a re-baseline: no outcome was named for the anchors that survived it");

  console.log("== a deep search result outside the window resolves through the same coordinator");
  const searched = await backendJson<SearchAnswer>("/api/search?q=" + encodeURIComponent(seed.forkPointText));
  const hitIndex = searched.body.results.findIndex((result) => result.session.id === seed.longId && String(result.entryId) === seed.forkPointEntryId);
  check(hitIndex >= 0, "the search indexes the committed question by its entry (" + seed.forkPointEntryId + ")");
  const searchTargetMounted = (await mounted()).includes(seed.forkPointEntryId);
  note("the searched entry is " + (searchTargetMounted ? "already mounted" : "outside the mounted window"));
  const beforeSearch = aroundReads().length;
  const outlineAtSearch = outlineReads().length;
  await page.locator('[aria-label="Search conversations"]').first().click();
  await page.locator('[aria-label="Search all conversations..."]').first().fill(seed.forkPointText);
  await page.waitForFunction(() => document.querySelectorAll("mark").length > 0, undefined, { timeout: 30_000 });
  await page.locator("button:has(mark)").nth(hitIndex).click();
  await waitForPlacement(seed.forkPointEntryId);
  await delay(800);
  check(true, "the searched entry came on screen");
  check(
    aroundReads().length === beforeSearch + (searchTargetMounted ? 0 : 1),
    "the locate cost " + (aroundReads().length - beforeSearch) + " target read(s), which is what a hit outside the window owes (" + (searchTargetMounted ? "it was already mounted" : "it was not") + ")",
  );
  check(outlineReads().length === outlineAtSearch, "and no outline page: a deep result never walks the pages between it and the window");
  check(
    (aroundReads()[beforeSearch] ?? "").includes("entry=" + seed.forkPointEntryId + "&block="),
    "the read carried the hit's own entry and block addressing",
  );
  check((await outcomeNames()).length === 0, "the deep locate is a landing, not a named failure");
  const searchPlacement = await placement(seed.forkPointEntryId);
  check(
    searchPlacement !== null && searchPlacement.onScreen && searchPlacement.top > 0 && searchPlacement.top < 500,
    "and the searched entry is placed at the head of the viewport rather than beside it (" + JSON.stringify(searchPlacement) + ")",
  );
  // The exact *block* is the search hit's own addressing, and the driver already proved the read carried it. What the
  // DOM can add is that the mounted turn is the entry's own: the block marker a user message renders is the message
  // itself, so the element the selector names is the one the hit resolved to.
  const searchedText = await page.locator('[data-entry-id="' + seed.forkPointEntryId + '"]').innerText();
  check(searchedText.includes(seed.forkPointText), "and the landed turn is the block the query matched, not a neighbour");

  console.log("== the fork lists the anchors it inherited and lands on one of them");
  const beforeFork = reads.length;
  await page.goto(origin + "/?session=" + seed.forkId, { waitUntil: "domcontentloaded" });
  await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-loaded]").length > 0, undefined, { timeout: 60_000 });
  await delay(600);
  const forkNodes = await nodes();
  check(
    forkNodes.some((node) => node.entryId === seed.compactedEntryId),
    "the fork's rail lists the anchor inherited from its source (" + seed.compactedEntryId + ")",
  );
  check(
    forkNodes.some((node) => node.entryId === seed.forkPointEntryId),
    "and the anchor the branch was taken at (" + seed.forkPointEntryId + ")",
  );
  const forkInherited = forkNodes.find((node) => node.entryId === seed.compactedEntryId);
  if (forkInherited === undefined) throw new Error("the fork's rail does not list the anchor inherited from its source");
  // Whether the fork's *rail* marks an inherited anchor loaded is the transcript's own measurement, not a claim about
  // the fork's active window: a virtualized transcript measures a far wider span than it mounts. What the fork must do
  // is list the anchor in its own coordinate and land on it, which the checks below assert.
  check(forkNodes.length > 0 && forkInherited !== undefined, "the inherited anchor is a node of the fork's rail");
  await hoverNode(forkInherited.index);
  const forkAroundBefore = aroundReads().length;
  await page.locator('[data-minimap-preview-index="' + forkInherited.index + '"] [data-minimap-preview-user]').click();
  await waitForPlacement(seed.compactedEntryId);
  check(true, "the fork landed on the inherited anchor");
  // A node the fork's transcript has already measured is a local jump and costs nothing; one it has not is a bounded
  // target read. Both are correct, and which one this is is stated by the node itself rather than assumed.
  const forkCost = aroundReads().length - forkAroundBefore;
  check(
    forkCost === (forkInherited.loaded ? 0 : 1),
    "for " + forkCost + " target read(s), which is what a " + (forkInherited.loaded ? "measured" : "unmeasured") + " inherited anchor owes in the fork",
  );
  if (!forkInherited.loaded) {
    check(
      aroundReads()[forkAroundBefore].includes("anchor=nav1.")
        && decodeURIComponent(aroundReads()[forkAroundBefore]).includes('"c":"' + seed.forkId + '"'),
      "addressed in the fork's own conversation coordinate rather than the source's",
    );
  } else {
    check(
      forkNodes.map((node) => node.entryId).join(",") === forkPage.body.anchors.map((anchor) => anchor.entryId).join(","),
      "and the fork's rail is the fork's own anchor list, inherited prefix included, in its native order (" + forkNodes.length + " nodes)",
    );
    check(
      outlineReads()[outlineReads().length - 1] !== undefined
        && decodeURIComponent(outlineReads()[outlineReads().length - 1]).includes("scope=" + seed.forkId),
      "read under the fork's own scope rather than the source's",
    );
  }

  console.log("== every unresolved lookup is a named outcome, and none of them is silently handled");
  // The other half of the ticket: a lookup that does not land must be *named*. Each journey below provokes one outcome
  // against the real Backend or the real client, reads the name off the banner the reader sees, and asserts the facts
  // that make the name actionable — a retry offer, no read where none is owed, and never a landing on a neighbour.

  /** The banner's own name and sentence, for one journey. */
  const bannerOf = async (): Promise<OutcomeBanner | null> => await page.evaluate(() => {
    const element = document.querySelector("[data-navigation-outcome]");
    if (element === null) return null;
    return {
      name: element.getAttribute("data-navigation-outcome"),
      text: element instanceof HTMLElement ? element.innerText.trim() : (element.textContent ?? "").trim(),
      retry: element.querySelector("[data-navigation-retry]") !== null,
    };
  });
  /** Every sentence this driver has seen a banner state, by outcome name. A landing retires its banner, so the
   * sentences are collected while the banners are on screen rather than after the journeys that ended them. */
  const seenOutcomes = new Map<string, string>();
  /** Wait for the banner to state one name, and return what it states. */
  const awaitOutcome = async (name: string, timeoutMs = 30_000): Promise<OutcomeBanner | null> => {
    await page.locator('[data-navigation-outcome="' + name + '"]').waitFor({ timeout: timeoutMs });
    const banner = await bannerOf();
    if (banner !== null) seenOutcomes.set(name, banner.text);
    return banner;
  };
  /** Reopen the long conversation, so one journey's outcome cannot be read as another's. */
  const openLong = async () => {
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await page.goto(origin + "/?session=" + seed.longId, { waitUntil: "domcontentloaded" });
    await page.locator("[data-minimap-node-index]").first().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll("[data-minimap-node-loaded]").length > 0, undefined, { timeout: 60_000 });
    await delay(600);
  };
  /** Click an anchor the transcript does not carry, which is the reader's own route to a bounded read. */
  const clickUnloaded = async (entryId: string) => {
    const node = (await nodes()).find((candidate) => candidate.entryId === entryId);
    assert.ok(node !== undefined, "the anchor " + entryId + " is on the rail");
    await hoverNode(node.index);
    await page.locator('[data-minimap-preview-index="' + node.index + '"] [data-minimap-preview-user]').click();
  };

  console.log("== a coordinate from a history that re-baselined is refused as stale, and a foreign one as wrong-scope");
  await openLong();
  const staleBefore = aroundReads().length;
  const stalePage = await backendJson<NavigationOutlinePage>("/api/conversations/" + seed.longId + "/navigation?limit=2");
  const staleAnchor = stalePage.body.anchors[0].anchor;
  const staleSnapshot = seed.longId + "|9|" + stalePage.body.anchors[0].entryId;
  const staleAnswer = await backendJson<StatusAnswer>(
    "/api/conversations/" + seed.longId + "/navigation/around?anchor=" + encodeURIComponent(staleAnchor) + "&snapshot=" + encodeURIComponent(staleSnapshot),
  );
  check(
    staleAnswer.status === 409 && staleAnswer.body.code === "stale-snapshot",
    "the Backend refuses a coordinate whose head marker moved, by name (" + staleAnswer.status + " " + staleAnswer.body.code + ")",
  );
  check(aroundReads().length === staleBefore, "and the refusal cost this page no navigation read of its own");
  const wrongScopeAnswer = await backendJson<StatusAnswer>("/api/conversations/" + seed.longId + "/navigation/around?anchor=" + encodeURIComponent(forkPage.body.anchors[0].anchor));
  check(
    wrongScopeAnswer.status === 409 && wrongScopeAnswer.body.code === "wrong-scope",
    "and a coordinate minted for another conversation is refused as wrong-scope (" + wrongScopeAnswer.status + " " + wrongScopeAnswer.body.code + ")",
  );

  console.log("== an entry this history does not hold is named missing, never answered with a window beside it");
  const missingCoordinate = "nav1." + Buffer.from(JSON.stringify({ v: 1, c: seed.longId, s: stalePage.body.scope, e: "999999" })).toString("base64url");
  const missingAnswer = await backendJson<StatusAnswer>("/api/conversations/" + seed.longId + "/navigation/around?anchor=" + encodeURIComponent(missingCoordinate));
  check(
    missingAnswer.status === 404 && missingAnswer.body.code === "missing",
    "the Backend names an entry it does not hold (" + missingAnswer.status + " " + missingAnswer.body.code + ")",
  );
  check(missingAnswer.body.entries === undefined, "and it answers no window at all, so a client cannot land on a neighbour");

  console.log("== a jump a conversation switch retires lands nothing on the conversation the reader moved to");
  // `cancelled` is the coordinator's own name for a request whose surface identity moved under it, and it is proved at
  // that seam (packages/ui/src/lib/history-navigation.test.ts: "a jump retired by a switch says so rather than
  // landing"). What the mounted surface adds is the other half of the same fact, and it is the half a reader can be
  // wronged by: the switch must land the abandoned target *nowhere*, on either conversation, and must not leave the new
  // one holding a request for an entry it does not carry. That is asserted here, on a real switch through the sidebar.
  await openLong();
  const switchReadsBefore = aroundReads().length;
  await page.route("**/navigation/around**", async (route) => {
    await delay(1500);
    await route.continue().catch(() => {});
  });
  const switchingNode = (await nodes()).find((node) => !node.loaded);
  if (switchingNode === undefined) throw new Error("the rail lists no unloaded node to jump to before the switch");
  await hoverNode(switchingNode.index);
  await page.locator('[data-minimap-preview-index="' + switchingNode.index + '"] [data-minimap-preview-user]').click();
  await delay(250);
  const switched = await page.evaluate((fork) => {
    const row = Array.from(document.querySelectorAll("[data-row-key]")).find((element) => (element.getAttribute("data-row-key") ?? "").includes(fork));
    const button = row?.querySelector<HTMLElement>(".session-tree-main") ?? row?.querySelector<HTMLElement>("button");
    if (button === undefined || button === null) return false;
    button.click();
    return true;
  }, seed.forkId);
  check(switched, "the reader switched conversations through the sidebar while the jump was still reading");
  await delay(3500);
  check(page.url().includes("session=" + seed.forkId), "and the surface moved to the fork (" + page.url().split("?")[1] + ")");
  check(aroundReads().length > switchReadsBefore, "the abandoned jump had issued its read before the switch");
  const switchingEntryId = entryIdOf(switchingNode);
  check(
    !(await mounted()).includes(switchingEntryId),
    "and it landed nothing on the conversation the reader moved to (" + switchingEntryId + " absent)",
  );
  check(
    (await outcomeNames()).length === 0,
    "with no stale banner about the conversation they left (" + JSON.stringify(await outcomeNames()) + ")",
  );
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});

  console.log("== a jump asked for while a run is in flight is named deferred-busy, and its Retry lands it");
  await openLong();
  model.hold("hn05 busy gate");
  const busySubmit = await backendJson<StatusAnswer>("/api/conversations/" + seed.longId + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "hn05-busy-" + Date.now(), text: "hn05 busy gate: hold this run open" }),
  });
  check(busySubmit.status === 202, "a turn was admitted, so the conversation really is mid-run (" + busySubmit.status + ")");
  let busy = false;
  for (let index = 0; index < 100 && !busy; index += 1) {
    const state = await backendJson<ConversationStateBody>("/api/conversations/" + seed.longId + "/state");
    busy = state.body.busy === true;
    if (!busy) await delay(250);
  }
  check(busy, "and it reports itself busy");
  const busyBefore = aroundReads().length;
  const busyNode = (await nodes()).find((node) => !node.loaded);
  if (busyNode === undefined) throw new Error("the rail lists no unloaded node to jump to while the run is busy");
  await hoverNode(busyNode.index);
  await page.locator('[data-minimap-preview-index="' + busyNode.index + '"] [data-minimap-preview-user]').click();
  const deferred = await awaitOutcome("deferred-busy");
  check(deferred !== null && deferred.retry, "the busy conversation names the jump deferred-busy and offers its Retry (" + JSON.stringify(deferred?.name) + ")");
  check(aroundReads().length === busyBefore, "and it read no history behind a run that is still settling (" + (aroundReads().length - busyBefore) + " reads)");
  check(!(await mounted()).includes(entryIdOf(busyNode)), "and nothing was mounted for it while it waits");
  model.release();
  await delay(3000);
  await page.locator("[data-navigation-retry]").click();
  const busyEntryId = entryIdOf(busyNode);
  for (let index = 0; index < 100; index += 1) {
    const box = await placement(busyEntryId);
    if (box !== null && box.onScreen) break;
    await delay(250);
  }
  const busySettled = await placement(busyEntryId);
  check(busySettled !== null && busySettled.onScreen, "the Retry lands the parked jump once the run settled (" + JSON.stringify(busySettled) + ")");
  check(await page.locator("[data-navigation-outcome]").count() === 0, "and the banner is gone because the jump arrived");

  console.log("== a read that fails is named error, and its Retry lands the entry");
  await openLong();
  let failedOnce = false;
  // A read that never answers is the one outcome with no refusal code of its own: not stale, not missing, just a read
  // that failed. It must still be named, and it must still be retryable.
  await page.route("**/navigation/around**", async (route) => {
    if (failedOnce) { await route.continue().catch(() => {}); return; }
    failedOnce = true;
    await route.abort("failed").catch(() => {});
  });
  const errorNode = (await nodes()).find((node) => !node.loaded);
  if (errorNode === undefined) throw new Error("the rail lists no unloaded node to jump to after the failed read");
  await hoverNode(errorNode.index);
  await page.locator('[data-minimap-preview-index="' + errorNode.index + '"] [data-minimap-preview-user]').click();
  const errored = await awaitOutcome("error");
  check(errored !== null && errored.retry, "a failed read is named error with its Retry (" + JSON.stringify(errored?.name) + ")");
  check(!(await mounted()).includes(entryIdOf(errorNode)), "and nothing was landed beside the entry it could not read");
  await page.locator("[data-navigation-retry]").click();
  const errorEntryId = entryIdOf(errorNode);
  for (let index = 0; index < 100; index += 1) {
    const box = await placement(errorEntryId);
    if (box !== null && box.onScreen) break;
    await delay(250);
  }
  const errorSettled = await placement(errorEntryId);
  check(errorSettled !== null && errorSettled.onScreen, "the Retry lands the entry the failed read could not carry (" + JSON.stringify(errorSettled) + ")");
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});

  console.log("== the outcomes are distinct names, not one collapsed failure");
  // Every name this driver provoked is a *sentence*, and no two of them share one: a single generic message for all of
  // them would satisfy "a banner appeared" while telling the reader nothing about what to do next.
  check(seenOutcomes.size >= 2, "the journeys provoked " + seenOutcomes.size + " distinct outcome names: " + JSON.stringify([...seenOutcomes.keys()]));
  check(
    [...seenOutcomes.values()].every((text) => text.length > 10),
    "and each of them carried a sentence of its own: " + JSON.stringify([...seenOutcomes.values()]),
  );
  check(
    new Set([...seenOutcomes.values()]).size === seenOutcomes.size,
    "with no two names sharing a sentence (" + seenOutcomes.size + " names, " + new Set([...seenOutcomes.values()]).size + " sentences)",
  );

  check(pageErrors.length === 0, "no page error occurred across the whole journey" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  const failure = error instanceof Error ? error.stack ?? error.message : String(error);
  failures.push(failure);
  console.log("  FAIL " + failure);
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) await stop(child);
  await model.close().catch(() => {});
  if (!keep) await rm(artifacts, { recursive: true, force: true });
  else console.log("artifacts kept in " + artifacts);
  console.log(failures.length === 0 ? "\nHISTORY-NAVIGATION ACCEPTANCE PASSED" : "\nHISTORY-NAVIGATION FAILURES:\n- " + failures.join("\n- "));
}
process.exit(exitCode);
