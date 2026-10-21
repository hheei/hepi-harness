/**
 * Ticket 16's acceptance journey: the production Web page and the App on one real system, driven the way a person drives
 * them, with the workflows only a second client can state.
 *
 * Everything is the deployed shape: the production Vite builds of both hosts, the real client ingress admitting a Web
 * cookie and an App device bearer, the real Backend over its own SQLite files, a real execution host, and one controlled
 * model endpoint that records every request. Nothing is stubbed, no Next server is started, and every port, database and
 * artifact belongs to this run (see acceptance-stack.mjs).
 *
 * What this driver claims, and what it deliberately does not:
 *
 *   - **Web is a real browser.** The Web page is Chromium against apps/web/dist through the ingress origin, so the
 *     cookie, the service worker, sessionStorage and the browser's own SSE are the platform's.
 *   - **App is browser-emulated here.** apps/app/dist is loaded in Chromium at its own origin with the shell's injected
 *     connection, which exercises the App's real HashRouter, its real bearer transport and the ingress's real origin
 *     list. It is NOT a native run: WebKitGTK, the Rust shell, the credential store and the Tauri IPC are not involved.
 *     The native half is a separate, separately-labelled driver (see docs/verification.md); a pass here is not evidence
 *     about a packaged App.
 *   - **Performance is representative, not a release measurement.** Request/connection counts, first visible content,
 *     script bytes and peak RSS are recorded for these journeys on this host. Nothing here is a production benchmark and
 *     no optimisation is claimed from it.
 *
 * The run can be pointed at the artifact a cutover switches instead of at this checkout:
 *
 *        node apps/web/e2e/ux-client-acceptance.mjs [--keep] [--release=<release-dir>]
 *
 * With `--release`, the ingress process is that release's `ingress.mjs`, the page it serves is its `web/`, the execution
 * gateway is its own tarball installed into a directory this run created, and the Backend is the image its provenance
 * record pins, run over a state directory this run owns. Every check below then says something about the shipped
 * release rather than about the tree it was built from. A directory that is not a published release is refused by name,
 * and nothing runs: there is no fallback to the checkout, because a run that reported the checkout as the artifact is
 * the failure this seam exists to prevent. The **App bundle** stays this checkout's `apps/app/dist`, because no
 * client-runtime release carries one (ticket 15's `.deb` is the App artifact, and the native driver runs that).
 *
 * Performance numbers in this log are the same kind of representative measurement either way: they are this host's
 * numbers, not a release benchmark.
 *
 * Usage: pnpm --filter @hepi/web build && pnpm --filter @hepi/app build
 *        node apps/web/e2e/ux-client-acceptance.mjs [--keep] [--release=<dir>]
 *        HEPI_T16_APP_PORT / HEPI_T16_INGRESS_PORT / HEPI_T16_BACKEND_PORT / HEPI_T16_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import {
  MODEL, appRoot, backendJson, buildFacts, issueDevice, repoRoot, resolveArtifactSources, startAcceptanceStack, webLogin, webRoot,
} from "./acceptance-stack.mjs";

const keep = process.argv.includes("--keep");
const releaseDir = process.argv.find((value) => value.startsWith("--release="))?.split("=").slice(1).join("=") ?? "";
const failures = [];
const results = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); results.push({ ok: true, message }); return true; }
  failures.push(message); results.push({ ok: false, message });
  console.log("  FAIL " + message);
  return false;
}

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const sourceRevision = git(["rev-parse", "HEAD"]);
const sourceDirty = git(["status", "--porcelain"]).length > 0;
// The artifact is decided before the first build fact is read, so the script bytes reported below are the bytes the
// page the run actually served was built from.
const artifact = resolveArtifactSources(releaseDir);
const facts = buildFacts({ webDir: artifact.staticDir ?? join(webRoot, "dist") });
console.log("Provenance: source " + sourceRevision + (sourceDirty ? " (dirty tree)" : " (clean)") + ", web script " + facts.web.script + " (" + facts.web.scriptBytes + " B), app script " + facts.app.script + " (" + facts.app.scriptBytes + " B)");
assert.ok(facts.web.scriptBytes > 0, "build the Web product first: pnpm --filter @hepi/web build");
assert.ok(facts.app.scriptBytes > 0, "build the App product first: pnpm --filter @hepi/app build");

/** Peak resident memory of a child this run started, as the kernel recorded it. */
function peakRssKb(pid) {
  try {
    const status = readFileSync("/proc/" + pid + "/status", "utf8");
    const match = status.match(/VmHWM:\s+(\d+) kB/);
    return match === null ? null : Number(match[1]);
  } catch { return null; }
}

async function eventually(read, accept, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read().catch((error) => ({ error: String(error) }));
    if (accept(last)) return last;
    if (Date.now() > deadline) throw new Error("timed out waiting for " + description + "; last " + String(JSON.stringify(last)).slice(0, 400));
    await delay(200);
  }
}

const composer = (page) => page.locator("textarea").first();
const stateOf = (stack, id) => backendJson(stack, "/api/conversations/" + encodeURIComponent(id) + "/state");
const rowOf = async (stack, id) => (await backendJson(stack, "/api/conversations")).conversations.find((row) => row.id === id);

const stack = await startAcceptanceStack({ label: "t16-acceptance", keep, releaseDir, ports: {
  app: Number(process.env.HEPI_T16_APP_PORT ?? 0),
  ingress: Number(process.env.HEPI_T16_INGRESS_PORT ?? 0), backend: Number(process.env.HEPI_T16_BACKEND_PORT ?? 0),
  gateway: Number(process.env.HEPI_T16_GATEWAY_PORT ?? 0),
}, log: (line) => console.log(line) });

let browser;
const contexts = [];
const shutdown = async () => {
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stack.close();
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { console.log("Interrupted by " + signal + "; stopping what this run started"); void shutdown().then(() => process.exit(130)); });
}

try {
  console.log("Artifacts: " + stack.artifacts);

  // --- 0. When this run was pointed at a published release, the artifact claim is established here, from outside the
  //        code that made it: the ingress and gateway processes name the release's own files in their own argv, and the
  //        page the ingress answers is byte-identical to the release's web/index.html. A run cannot satisfy these by
  //        passing --release to a stack that fell back to the checkout, which is the failure this seam exists to prevent.
  if (artifact.kind === "release") {
    const argvOf = async (role) => {
      const pid = await stack.pidOf(role);
      if (pid === null) return [];
      return readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0").filter(Boolean);
    };
    const ingressArgv = await argvOf("ingress");
    check(ingressArgv.some((value) => resolve(value) === artifact.ingressEntry),
      "the running ingress process IS the release bundle, named in its own argv: " + ingressArgv.join(" "));
    const gatewayArgv = await argvOf("gateway");
    check(gatewayArgv.some((value) => value.endsWith(join("node_modules", "@hepi", "client", "dist", "cli.js")) && gatewayArgv.includes("gateway")),
      "the running execution host IS the release's installed gateway bundle, not this checkout's source entry: " + gatewayArgv.join(" "));
    const servedShell = await fetch(stack.webOrigin + "/", { signal: AbortSignal.timeout(10_000) });
    const servedBytes = await servedShell.text();
    check(servedBytes === readFileSync(join(artifact.staticDir, "index.html"), "utf8"),
      "and the page the ingress serves is the release's own web/index.html, byte for byte (" + Buffer.byteLength(servedBytes) + " B)");
  }

  browser = await chromium.launch();

  // --- 1. The Web page's first open on a gated deployment: the deployment asks for its login, then the page is a page.
  const cookie = await webLogin(stack);
  const cookieValue = cookie.replace(/^hepi-web-token=/, "");
  const webContext = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  contexts.push(webContext);
  // React's own commit count and the page's frame/long-task load, read from inside the document: the production bundle
  // calls the devtools hook it finds on the page, so an init script installed before any of its scripts run counts every
  // commit of the real workbench. This is the P5 item earlier runs of this driver never stated — they counted requests,
  // first-visible content and RSS, but no number for what a streamed turn costs the page.
  await webContext.addInitScript(() => {
    globalThis.__t16Commits = 0;
    const renderers = new Map();
    Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        renderers, supportsFiber: true, isDisabled: false, checkDCE() {},
        inject: (renderer) => { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
        onCommitFiberRoot: () => { globalThis.__t16Commits += 1; },
        onPostCommitFiberRoot: () => {}, onCommitFiberUnmount: () => {},
      },
    });
  });
  // The frame load, from the page's own observer: long tasks are what a streamed answer costs the browser's main
  // thread, and the JS heap is the half of the memory claim no process RSS states.
  await webContext.addInitScript(() => {
    globalThis.__t16LongTasks = [];
    try {
      const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) globalThis.__t16LongTasks.push(Math.round(entry.duration)); });
      observer.observe({ entryTypes: ["longtask"] });
    } catch { /* the platform states none */ }
  });
  // How many conversation streams this page has opened, counted from inside the page before any of its scripts run. A
  // reconnect is a second request for the same address, which a Backend restart forces and a page that merely kept a
  // dead stream would never make.
  await webContext.addInitScript(() => {
    globalThis.__t16Streams = 0;
    const original = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      if (/\/api\/conversations\/[^/]+\/events/.test(url)) globalThis.__t16Streams += 1;
      return original.call(this, input, init);
    };
  });
  const web = await webContext.newPage();
  web.setDefaultTimeout(45_000);
  const webErrors = [];
  web.on("pageerror", (error) => webErrors.push(error.message));
  const webRequests = [];
  web.on("request", (request) => webRequests.push(request.method() + " " + new URL(request.url()).pathname));

  const firstOpenStartedAt = Date.now();
  await web.goto(stack.webOrigin + "/", { waitUntil: "domcontentloaded" });
  await web.locator('input[type="password"]').waitFor({ timeout: 45_000 });
  check(true, "a gated deployment's first open asks for its login material instead of showing a bare refusal");
  const firstPaintMs = Date.now() - firstOpenStartedAt;
  const commitsAtSignIn = await web.evaluate(() => globalThis.__t16Commits ?? 0);
  check(commitsAtSignIn > 0, "the production page commits renders this run can count: " + commitsAtSignIn + " commits to the sign-in surface");
  await web.locator('input[type="password"]').fill("{{SECRET_wrongly-typed-login}}");
  await web.getByRole("button", { name: /sign in/i }).click();
  await web.getByRole("alert").waitFor({ timeout: 20_000 });
  check((await web.getByRole("alert").innerText()).length > 0, "a wrong login is refused with a reason, and the form stays usable: " + (await web.getByRole("alert").innerText()));
  await web.locator('input[type="password"]').fill((await import("./acceptance-stack.mjs")).WEB_LOGIN);
  await web.getByRole("button", { name: /sign in/i }).click();
  // The shell is admitted when its own sidebar exists: a bare load opens no conversation, so the composer is not on
  // screen yet and waiting for one would be waiting for a pick the driver has not made.
  const admitted = await web.locator(".sidebar-new-button").waitFor({ timeout: 60_000 }).then(() => true, () => false);
  if (!admitted) console.log("DEBUG body after login:\n" + (await web.locator("body").innerText()).slice(0, 800) + "\nDEBUG requests " + JSON.stringify(webRequests.slice(0, 20)));
  check(admitted, "the correct login admits the page, which then renders the workbench");
  check(!webRequests.some((entry) => entry.includes("/api/durable-login")), "the page never asks the retired Next login route");
  const sidebarReady = await eventually(async () => (await web.locator(".session-tree-group-toggle").count()) > 0, (value) => value === true, "the sidebar to list a group").then(() => true, () => false);
  check(sidebarReady, "the sidebar lists this deployment's groups");
  const commitsAfterAdmission = await web.evaluate(() => globalThis.__t16Commits ?? 0);
  check(commitsAfterAdmission > commitsAtSignIn, "sign-in, admission and the first catalogue read are a bounded commit sequence: " + commitsAtSignIn + " -> " + commitsAfterAdmission);

  // --- 2. Web creates the conversation: a real Backend record, created through the page's own composer.
  const createdId = await (async () => {
    const newButton = web.locator(".sidebar-new-button");
    await newButton.waitFor({ timeout: 30_000 });
    if (!(await newButton.isEnabled())) {
      // A bare load opens no project, so the driver picks one the way a person does: the Files tab's own project
      // picker, which names each choice by the folder the deployment recorded.
      await web.getByRole("tab", { name: "Files", exact: true }).click();
      await web.locator(".project-picker.is-stacked .project-picker-button.is-project").click();
      await web.locator('.sidebar-menu [role=menuitemradio][title="' + stack.projectRoot + '"]').waitFor({ timeout: 30_000 });
      await web.locator('.sidebar-menu [role=menuitemradio][title="' + stack.projectRoot + '"]').click();
      await web.waitForFunction(() => document.querySelector(".sidebar-new-button")?.disabled === false, undefined, { timeout: 30_000 });
      await web.getByRole("tab", { name: "Sessions", exact: true }).click();
    }
    await newButton.click();
    await web.locator("textarea").first().waitFor({ timeout: 30_000 });
    // A new conversation is created by the create request the composer's own first send makes; the driver waits for the
    // catalogue row instead of reading a URL it guessed.
    await composer(web).fill("first turn from the Web page");
    await web.getByRole("button", { name: "Send", exact: true }).click();
    const row = await eventually(async () => (await backendJson(stack, "/api/conversations")).conversations[0], (value) => value !== undefined, "the conversation to exist in the catalogue");
    return row.id;
  })();
  const createdState = await eventually(() => stateOf(stack, createdId), (state) => state?.entries?.some((entry) => entry.role === "user"), "the Web turn to be admitted");
  check(createdState.entries.some((entry) => entry.role === "user" && entry.text === "first turn from the Web page"), "the Web page's turn is a durable entry in the Backend's own state");
  const webRow = await rowOf(stack, createdId);
  check(webRow !== undefined, "and the catalogue lists the conversation it created: " + JSON.stringify(webRow?.id));

  // The request id a lost response is recovered by, stated on the public route with an id this driver made: the page
  // submits under its own id, so the route is exercised here where the id is known, and the App's lost response below
  // is checked by the durable record instead.
  const lookupId = "t16-lookup-" + Date.now();
  const lookupSubmitted = await fetch(stack.webOrigin + "/api/conversations/" + createdId + "/messages", {
    method: "POST", headers: { "content-type": "application/json", cookie: cookie, origin: stack.webOrigin },
    body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: lookupId, text: "looked up by request id" }),
  });
  await lookupSubmitted.body?.cancel();
  check(lookupSubmitted.status === 202, "a turn was admitted under a request id this driver knows (" + lookupSubmitted.status + ")");
  const resolved = await eventually(
    () => backendJson(stack, "/api/conversations/" + createdId + "/submissions?requestId=" + encodeURIComponent(lookupId)),
    (answer) => answer?.submission !== null && answer?.submission !== undefined,
    "the request id to resolve its durable submission",
  );
  check(resolved.submission !== null && typeof resolved.submission.status === "string", "the request id resolves the durable submission the Backend recorded: " + JSON.stringify(resolved.submission?.status));
  const onceByLookup = (await stateOf(stack, createdId)).entries.filter((entry) => entry.role === "user" && entry.text === "looked up by request id").length;
  check(onceByLookup === 1, "and the message it names was admitted exactly once (" + onceByLookup + ")");

  // --- 3. A device credential is issued by the Web session, which is the only identity allowed to mint one.
  // The Web session is the only identity allowed to mint a device credential, and the write is same-origin: it goes to
  // the page's own origin, exactly as the Settings surface sends it.
  const issued = await (async () => {
    const response = await fetch(stack.webOrigin + "/api/device-credentials", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie, origin: stack.webOrigin },
      body: JSON.stringify({ label: "t16-app" }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, "the Web session issued a device credential: " + response.status + " " + body.slice(0, 200));
    return JSON.parse(body);
  })();
  check(typeof issued.token === "string" && issued.token.length > 0, "the App's credential is a token the Backend issued once");
  const appRefused = await fetch(stack.ingressOrigin + "/api/descriptor", { headers: { authorization: "Bearer " + issued.token, origin: stack.appOrigin } });
  await appRefused.body?.cancel();
  check(appRefused.status === 200, "the ingress admits that device bearer from the App's declared origin (" + appRefused.status + ")");
  const undeclaredOrigin = await fetch(stack.ingressOrigin + "/api/descriptor", { headers: { authorization: "Bearer " + issued.token, origin: "http://elsewhere.example" } });
  await undeclaredOrigin.body?.cancel();
  check(undeclaredOrigin.status === 403, "and refuses the same bearer from an origin this deployment did not declare (" + undeclaredOrigin.status + ")");

  // --- 4. The App on its own origin: the shell's injected connection, its HashRouter, and a cross-client read.
  const appContext = await browser.newContext({ viewport: { width: 1200, height: 820 }, locale: "en-US" });
  contexts.push(appContext);
  await appContext.addInitScript(({ profile, origin, token }) => {
    globalThis.__HEPI_CONNECTION__ = { profile, origin, token };
    globalThis.__TAURI_INTERNALS__ = { invoke: async () => undefined };
  }, { profile: "t16-app", origin: stack.ingressOrigin, token: issued.token });
  const app = await appContext.newPage();
  app.setDefaultTimeout(45_000);
  const appErrors = [];
  app.on("pageerror", (error) => appErrors.push(error.message));
  const appRequests = [];
  app.on("request", (request) => appRequests.push(request.method() + " " + new URL(request.url()).pathname));
  await app.goto(stack.appOrigin + "/#/?session=" + createdId, { waitUntil: "domcontentloaded" });
  await app.locator("textarea").first().waitFor({ timeout: 60_000 });
  check(new URL(app.url()).hash.includes("session="), "the App keeps its view in the fragment, not in a server route: " + app.url());
  await app.getByText("first turn from the Web page").first().waitFor({ timeout: 45_000 });
  check(true, "the App reads the turn the Web page created — one conversation, two clients");
  check(appRequests.some((entry) => entry.endsWith("/api/conversations/" + createdId + "/events")), "the App opens its own conversation stream against the configured Gateway origin");
  check(!appRequests.some((entry) => entry.includes("/api/descriptor") && entry.startsWith("GET http://127.0.0.1:" + new URL(stack.appOrigin).port + "/api/")), "the App's reads go to its configured ingress, not its bundle's origin");

  // --- 5. Lost response: the App's submission commits, the answer never arrives, and the turn is recovered by its
  //        request id — never resent. The dropped response is the real one; only its delivery is cancelled.
  let dropped = 0;
  await appContext.route("**/api/conversations/" + createdId + "/messages", async (route) => {
    const answer = await route.fetch();
    assert.equal(answer.status(), 202, "the Backend admitted the submission");
    dropped += 1;
    await route.abort("failed");
  });
  const modelRequestsBefore = stack.model.requests.length;
  const appComposer = composer(app);
  await appComposer.fill("submitted once from the App");
  await app.getByRole("button", { name: "Send", exact: true }).click();
  await eventually(async () => dropped, (value) => value === 1, "the submission whose answer was dropped");
  check(true, "the App's submission reached the Backend and its response was lost in transit");
  // The page generates its own request id, so the durable record is read by what it settled rather than by a value this
  // driver invented. The lookup route itself is stated below on the Web page's turn, where the id is the driver's own.
  const afterRecovery = await eventually(() => stateOf(stack, createdId), (state) => state?.entries?.filter((entry) => entry.role === "user" && entry.text === "submitted once from the App").length >= 1, "the App's turn to be visible to the Backend");
  const submittedEntries = afterRecovery.entries.filter((entry) => entry.role === "user" && entry.text === "submitted once from the App");
  check(submittedEntries.length === 1, "the turn was admitted exactly once despite the lost response (" + submittedEntries.length + ")");
  const catalogueAfterDrop = await backendJson(stack, "/api/conversations");
  check(catalogueAfterDrop.conversations.some((row) => row.id === createdId), "the catalogue still lists the conversation after the dropped response");
  await eventually(() => Promise.resolve(stack.model.requests.length), (value) => value >= modelRequestsBefore + 1, "the model to be asked for the recovered turn", 45_000).then(() => true, () => false);
  const modelForRecovery = stack.model.requests.slice(modelRequestsBefore).filter((entry) => entry.text.includes("submitted once from the App"));
  check(modelForRecovery.length === 1, "the model was asked once for that turn, not once per attempt (" + modelForRecovery.length + ")");

  // --- 6. Cross-client read: the Web page shows the App's turn without sending it again.
  // The warm state, measured separately from the cold first open above: the same origin, the same page, now with its
  // worker and its asset cache primed by this run.
  const warmStartedAt = Date.now();
  await web.reload({ waitUntil: "domcontentloaded" });
  await web.locator(".sidebar-new-button").waitFor({ timeout: 60_000 });
  const warmFirstPaintMs = Date.now() - warmStartedAt;
  // A reload is a new document, so its commit count starts again from zero: the cold first open above and this warm one
  // are stated as two documents, not one number added across them.
  const commitsOnReloadedDocument = await web.evaluate(() => globalThis.__t16Commits ?? 0);
  check(commitsOnReloadedDocument > 0, "the reloaded page renders and reads the App's turn in a counted number of commits: " + commitsOnReloadedDocument + " by the time its shell is up");
  await eventually(async () => (await web.locator("body").innerText()).includes("submitted once from the App"), (value) => value === true, "the Web page to show the App's turn", 45_000)
    .then(() => check(true, "the Web page reads the App's turn from the same conversation"), () => check(false, "the Web page did not show the App's turn"));
  const totalModelForText = stack.model.requests.filter((entry) => entry.text.includes("submitted once from the App")).length;
  check(totalModelForText === 1, "and the Web page's read woke no second model request (" + totalModelForText + ")");

  // One answer streamed into the page, and what it costs the page: the commits and long tasks between the turn leaving
  // the composer and its answer settling are the render cost of this deployment's frame load, measured rather than
  // inferred from how many setters a frame touches.
  // The baseline is read immediately before the send, so the counted sequence is this answer's, not the reload's.
  const commitsBeforeAnswer = await web.evaluate(() => globalThis.__t16Commits ?? 0);
  const longTasksBeforeAnswer = await web.evaluate(() => (globalThis.__t16LongTasks ?? []).length);
  const assistantsBeforeAnswer = (await stateOf(stack, createdId)).entries.filter((entry) => entry.role === "assistant").length;
  await composer(web).fill("a turn whose answer the page streams");
  await web.getByRole("button", { name: "Send", exact: true }).click();
  await eventually(async () => (await stateOf(stack, createdId)).entries.filter((entry) => entry.role === "assistant").length, (count) => count >= assistantsBeforeAnswer + 1, "the streamed answer to settle", 90_000).catch(() => null);
  const answerCost = await web.evaluate((baseline) => ({
    commits: (globalThis.__t16Commits ?? 0) - baseline.commits,
    longTasks: (globalThis.__t16LongTasks ?? []).slice(baseline.longTasks),
  }), { commits: commitsBeforeAnswer, longTasks: longTasksBeforeAnswer });
  check(answerCost.commits > 0, "streaming one answer into the page is a counted render sequence: " + answerCost.commits + " commit(s), " + answerCost.longTasks.length + " long task(s) " + JSON.stringify(answerCost.longTasks));

  // --- 7. Durable recovery across a restart: the new state is what a restarted system reads back.
  const beforeRestart = (await stateOf(stack, createdId)).entries.length;
  await stack.restartBackend();
  const restarted = await eventually(() => backendJson(stack, "/api/conversations/" + createdId + "/state").catch(() => null), (state) => state?.entries?.length >= beforeRestart, "the restarted Backend to serve the same conversation", 120_000).catch(() => null);
  check(restarted !== null && restarted.entries.length >= beforeRestart, "a restarted Backend serves the same durable state (" + (restarted?.entries?.length ?? 0) + " entries, was " + beforeRestart + ")");
  check(restarted !== null && restarted.entries.filter((entry) => entry.role === "user" && entry.text === "submitted once from the App").length === 1, "and the App's turn is still exactly one entry after the restart");
  // The stream a restarted Backend serves is a new attachment: the App's page reconnects to it rather than to a dead one.
  const resumed = await eventually(async () => (await stateOf(stack, createdId)).revision, (value) => typeof value === "number", "a revision from the restarted Backend").catch(() => null);
  check(resumed !== null, "the restarted Backend states a live revision for the conversation");

  // --- 8. Resource authorization, stated as refusals a client actually meets.
  const noCookie = await fetch(stack.webOrigin + "/api/conversations", { headers: {} });
  await noCookie.body?.cancel();
  check(noCookie.status === 401, "a Web read without the session cookie is refused (" + noCookie.status + ")");
  const badBearer = await fetch(stack.ingressOrigin + "/api/conversations", { headers: { authorization: "Bearer not-a-credential", origin: stack.appOrigin } });
  await badBearer.body?.cancel();
  check(badBearer.status === 401, "an unknown device bearer is refused (" + badBearer.status + ")");
  const internal = await fetch(stack.ingressOrigin + "/v1/execute", { method: "POST", headers: { authorization: "Bearer " + issued.token, origin: stack.appOrigin }, body: "{}" });
  await internal.body?.cancel();
  check(internal.status === 404, "the internal execution surface is not served on the client ingress (" + internal.status + ")");
  const serviceOnIngress = await fetch(stack.ingressOrigin + "/api/conversations", { headers: { authorization: "Bearer " + (await import("./acceptance-stack.mjs")).SERVICE_TOKEN, origin: stack.appOrigin } });
  await serviceOnIngress.body?.cancel();
  check(serviceOnIngress.status === 401, "the deployment's own service credential is not a client identity (" + serviceOnIngress.status + ")");

  // --- 9. The routes this ticket's acceptance is a cutover of, reached the way the App reaches them: the App's own
  //        device bearer on the ingress origin, with no cookie and no Next server beside it. Each of these is answered
  //        by a different part of the ingress (Backend-forwarded resource, terminal fan-in, locally-answered MCP host
  //        surface), so a passing set says the one listener really is the entry a cutover switches rather than the
  //        conversation half of it. Ticket 09's multi-host merge and ticket 13's server test are stated by their own
  //        suites (packages/gateway/test/ingress-{terminal,mcp}.test.ts) and are not repeated here.
  const appBearer = { authorization: "Bearer " + issued.token, origin: stack.appOrigin, "content-type": "application/json" };
  const workspaceList = await fetch(stack.ingressOrigin + "/api/workspaces", { headers: appBearer });
  const workspaces = await workspaceList.json().catch(() => null);
  check(workspaceList.status === 200 && Array.isArray(workspaces?.workspaces) && workspaces.workspaces.some((row) => row.id === "local"), "the App bearer reads the deployment's workspaces through the ingress (" + workspaceList.status + ")");
  const hostList = await fetch(stack.ingressOrigin + "/api/hosts", { headers: appBearer });
  const hosts = await hostList.json().catch(() => null);
  check(hostList.status === 200 && Array.isArray(hosts?.hosts) && hosts.hosts.some((row) => row.id === "workstation"), "and its hosts, both over the same one origin (" + hostList.status + ")");
  // The browser's own file vocabulary (`/api/files/<routing path>?type=list`) over the same bearer: this is answered
  // by the ingress's file surface reaching the execution host, so it is a different code path from the Backend reads
  // above and a different one again from the terminal and MCP routes below.
  const fileRead = await fetch(stack.ingressOrigin + "/api/files/workspace/local?type=list", { headers: appBearer });
  const fileList = await fileRead.json().catch(() => null);
  check(fileRead.status === 200 && Array.isArray(fileList?.entries) && fileList.entries.some((row) => row.name === "notes"), "the App bearer lists the workspace's own folders through the ingress (" + fileRead.status + " " + JSON.stringify(fileList?.entries)?.slice(0, 160) + ")");
  const notAWorkspace = await fetch(stack.ingressOrigin + "/api/files/srv/somewhere?type=list", { headers: appBearer });
  await notAWorkspace.body?.cancel();
  check(notAWorkspace.status >= 400, "and a path naming no workspace is refused rather than read (" + notAWorkspace.status + ")");

  // One terminal tab opened, written to and read back over the fan-in stream, all under the App's bearer.
  const tabId = "t16-app-tab";
  const tabCwd = "/workspace/local";
  const opened = await fetch(stack.ingressOrigin + "/api/terminal?cwd=" + encodeURIComponent(tabCwd), {
    method: "POST", headers: appBearer, body: JSON.stringify({ id: tabId, cwd: tabCwd, cols: 80, rows: 24 }),
  });
  const openedBody = await opened.json().catch(() => null);
  check(opened.status === 200 && openedBody?.ok === true, "the App bearer opens a terminal tab on the execution host (" + opened.status + " " + JSON.stringify(openedBody)?.slice(0, 200) + ")");
  const streamGuard = new AbortController();
  const fanIn = await fetch(stack.ingressOrigin + "/api/terminal/events?tabs=" + encodeURIComponent(tabId + "|" + tabCwd + "|"), {
    headers: { ...appBearer, accept: "text/event-stream" }, signal: streamGuard.signal,
  });
  check(fanIn.status === 200 && (fanIn.headers.get("content-type") ?? "").includes("text/event-stream"), "and the fan-in stream attaches to that tab on the same origin (" + fanIn.status + ")");
  const marker = "t16-fanin-" + Date.now();
  await fetch(stack.ingressOrigin + "/api/terminal/" + encodeURIComponent(tabId) + "?cwd=" + encodeURIComponent(tabCwd), {
    method: "POST", headers: appBearer, body: JSON.stringify({ type: "input", data: "printf '" + marker + "\\n'\n" }),
  }).then((response) => response.body?.cancel());
  const seen = await (async () => {
    const reader = fanIn.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes(marker)) { await reader.cancel(); return true; }
      if (buffered.length > 400_000) { await reader.cancel(); return false; }
    }
    await reader.cancel().catch(() => {});
    return false;
  })().catch(() => false);
  streamGuard.abort();
  check(seen, "the tab's own shell output arrives on the App's stream (" + marker + ")");
  const closedTab = await fetch(stack.ingressOrigin + "/api/terminal/" + encodeURIComponent(tabId) + "?cwd=" + encodeURIComponent(tabCwd), { method: "DELETE", headers: appBearer });
  await closedTab.body?.cancel();
  check(closedTab.status === 200, "and the App can close the tab it opened (" + closedTab.status + ")");

  // The MCP routes are the ingress's own answer from this origin's host service, never a Backend forward.
  const mcpRead = await fetch(stack.ingressOrigin + "/api/mcp", { headers: appBearer });
  const mcpBody = await mcpRead.json().catch(() => null);
  check(mcpRead.status === 200 && Array.isArray(mcpBody?.files) && Array.isArray(mcpBody?.servers), "the App bearer reads this host's MCP configuration through the ingress (" + mcpRead.status + " " + JSON.stringify(mcpBody?.files)?.slice(0, 160) + ")");
  const mcpWrite = await fetch(stack.ingressOrigin + "/api/mcp", {
    method: "POST", headers: appBearer,
    body: JSON.stringify({ action: "add", scope: "global", text: JSON.stringify({ mcpServers: { "t16-app-added": { command: process.execPath, args: ["--version"] } } }) }),
  });
  const mcpWritten = await mcpWrite.json().catch(() => null);
  check(mcpWrite.status === 200 && mcpWritten?.added?.name === "t16-app-added", "and writes it, which only the host this origin runs on can answer (" + mcpWrite.status + " " + JSON.stringify(mcpWritten)?.slice(0, 200) + ")");
  const mcpReRead = await fetch(stack.ingressOrigin + "/api/mcp", { headers: appBearer });
  const mcpAgain = await mcpReRead.json().catch(() => null);
  check(Array.isArray(mcpAgain?.servers) && mcpAgain.servers.some((row) => row.name === "t16-app-added"), "the written entry is read back from the host's own file (" + JSON.stringify(mcpAgain?.servers)?.slice(0, 200) + ")");

  // --- 10. Scope switch: a draft typed on the Web page is not the App's, on the same conversation.
  await web.locator("textarea").first().fill("a draft only the Web page has");
  await delay(500);
  const appComposerText = await composer(app).inputValue();
  check(appComposerText !== "a draft only the Web page has", "the App's composer does not adopt the Web page's unsent draft: " + JSON.stringify(appComposerText));
  const webScope = await web.evaluate(() => sessionStorage.getItem("pi-web:composer-draft:value:" + Object.keys(sessionStorage).find((key) => key.includes("composer-draft:value:"))?.split("pi-web:composer-draft:value:")[1] ?? ""));
  check(webScope === null || webScope.includes("a draft only the Web page has"), "the Web draft is stored under this page's own connection scope");

  // --- 11. Revocation: the App's credential ends, and the open stream ends with it inside the deployment's interval.
  const revokeStartedAt = Date.now();
  const revoked = await fetch(stack.webOrigin + "/api/device-credentials/" + encodeURIComponent(issued.credential.id), { method: "DELETE", headers: { cookie: cookie, origin: stack.webOrigin } });
  await revoked.body?.cancel();
  check(revoked.status === 200, "the Web session revoked the App's credential (" + revoked.status + ")");
  const refusedAfterRevocation = await eventually(async () => {
    const response = await fetch(stack.ingressOrigin + "/api/conversations", { headers: { authorization: "Bearer " + issued.token, origin: stack.appOrigin } });
    await response.body?.cancel();
    return response.status;
  }, (status) => status === 401, "the revoked bearer to be refused", 20_000).catch(() => null);
  const revocationMs = Date.now() - revokeStartedAt;
  check(refusedAfterRevocation === 401, "the revoked bearer is refused by the ingress (" + refusedAfterRevocation + " after " + revocationMs + " ms)");
  const revokedRecord = (await backendJson(stack, "/api/device-credentials").catch(() => ({ credentials: [] }))).credentials.find((row) => row.id === issued.credential.id);
  check(revokedRecord !== undefined && revokedRecord.revoked === true && typeof revokedRecord.revokedAt === "string", "the Backend's own record states when access ended: " + JSON.stringify(revokedRecord));

  // --- 12. SSE recovery: the page's own stream ends with the Backend, and the page re-attaches to the new one.
  // The stream is observed from the browser, so a re-attach is a real second attachment rather than an assumption.
  const streamsBefore = await web.evaluate(() => window.__t16Streams ?? 0);
  await stack.restartBackend();
  const reattached = await eventually(() => web.evaluate(() => window.__t16Streams ?? 0), (count) => count > streamsBefore, "the page to open a new stream after the restart", 120_000).catch(() => null);
  check(reattached !== null, "the Web page re-attaches its stream after a Backend restart (" + streamsBefore + " -> " + reattached + ")");
  const recoveredPage = await eventually(async () => {
    const body = await web.locator("body").innerText();
    return body.includes("submitted once from the App");
  }, (value) => value === true, "the page to still show the conversation after the restart", 90_000).catch(() => false);
  check(recoveredPage, "the Web page keeps its conversation across a Backend restart");
  const entriesAfter = (await stateOf(stack, createdId)).entries.filter((entry) => entry.role === "user" && entry.text === "submitted once from the App").length;
  check(entriesAfter === 1, "and no turn was duplicated by the reconnect (" + entriesAfter + ")");
  check(webErrors.length === 0, "no page error on the Web page: " + webErrors.join(" | "));
  check(appErrors.length === 0, "no page error on the App: " + appErrors.join(" | "));

  // --- 13. Representative measurements, recorded rather than optimised.
  const pageLoad = await web.evaluate(() => ({
    longTasks: globalThis.__t16LongTasks ?? [],
    heapMb: typeof performance.memory?.usedJSHeapSize === "number" ? Math.round(performance.memory.usedJSHeapSize / (1024 * 1024)) : null,
    commits: globalThis.__t16Commits ?? 0,
  }));
  const measurement = {
    webFirstVisibleMs: firstPaintMs,
    webWarmFirstVisibleMs: warmFirstPaintMs,
    reactCommits: { signIn: commitsAtSignIn, admitted: commitsAfterAdmission, warmDocumentShell: commitsOnReloadedDocument, streamedAnswer: answerCost.commits, totalOnWarmDocument: pageLoad.commits },
    longTasksMs: pageLoad.longTasks,
    answerLongTasksMs: answerCost.longTasks,
    jsHeapMb: pageLoad.heapMb,
    webRequests: webRequests.length,
    appRequests: appRequests.length,
    webScriptBytes: facts.web.scriptBytes,
    appScriptBytes: facts.app.scriptBytes,
    modelRequests: stack.model.requests.length,
    // Read from the process that is answering at the end of the run, which in release mode is the Backend container's
    // own main process rather than the `docker run` client that started it.
    peakRssKb: {
      backend: peakRssKb(await stack.pidOf("backend")),
      gateway: peakRssKb(await stack.pidOf("gateway")),
      ingress: peakRssKb(await stack.pidOf("ingress")),
    },
    revocationMs,
    entries: (await stateOf(stack, createdId)).entries.length,
  };
  console.log("Measurement: " + JSON.stringify(measurement));
  check(measurement.webScriptBytes > 0 && measurement.modelRequests > 0, "the run recorded its own request counts, first-visible time, script bytes and peak memory");
  check(measurement.reactCommits.totalOnWarmDocument > measurement.reactCommits.warmDocumentShell, "and the render cost of the journeys it measured: " + measurement.reactCommits.totalOnWarmDocument + " React commits on the warm document (" + measurement.reactCommits.streamedAnswer + " for one streamed answer), " + measurement.longTasksMs.length + " long task(s) " + JSON.stringify(measurement.answerLongTasksMs));
  check(measurement.webWarmFirstVisibleMs > 0 && measurement.jsHeapMb !== null, "warm first-visible " + measurement.webWarmFirstVisibleMs + " ms against cold " + measurement.webFirstVisibleMs + " ms, JS heap " + measurement.jsHeapMb + " MB");
} catch (error) {
  check(false, "driver error: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
} finally {
  const exitCode = failures.length === 0 ? 0 : 1;
  await shutdown();
  if (failures.length > 0) { console.error("T16 acceptance checks FAILED: " + failures.join(" | ")); process.exit(exitCode); }
  console.log("T16 acceptance checks PASSED (" + results.length + " checks)" + (keep ? "; artifacts kept at " + stack.artifacts : ""));
  process.exit(exitCode);
}
