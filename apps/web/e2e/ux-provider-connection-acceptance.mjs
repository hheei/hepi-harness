/**
 * Ticket 05 acceptance: the provider connection journeys, through the real Web ingress, in a named configuration mode.
 *
 * The owning tickets each state their own seam — the host's POST /v1/providers/auth and POST /v1/providers/login, the
 * client ingress's /api/auth/* routes, the panel's contracts. What none of them can state is the journey a person takes:
 * Settings > Models asks the ingress, the ingress asks this origin's own host, the host writes its account's auth.json,
 * and the composer then offers the models that credential authenticates — or honestly does not, and says why.
 *
 * So everything here is the deployed shape: the production Vite Web build served by the real client ingress, the real
 * Backend over its own SQLite files, a real execution gateway on an agent directory this run owns, and one Chromium. The
 * two provider services this run talks to are **stand-ins for the upstream**, not for the code under test: a Kimi
 * device-code authorization server (RFC 8628) on a loopback port, and this run's own catalog. Upstream's own flow runs
 * against them — the device authorization, the poll, the token exchange, the credential shape and its storage are
 * @earendil-works/pi-ai's code — so no paid provider, no real account and no live credential is involved.
 *
 * Configuration mode is stated by the run and printed as its first lines:
 *
 *   - Pi file-backed (HEPI_CONFIG_SOURCE=pi): the Backend's model registry is this run's own agent directory, which is the
 *     directory the Gateway writes. That is the one mode where "the host stored it" and "this runtime can use it" are
 *     facts about one account, so it is the mode the stored-vs-usable observations are made in.
 *   - Environment (the deployment's default): the Backend's account is its own process environment and an in-memory
 *     credential store, so a credential the Gateway stores is deliberately *not* its account's. That limit is asserted
 *     where it is cheap to assert — this file states the mode it ran and points at docs/providers.md for the other one.
 *
 * What it deliberately does not claim:
 *
 *   - No loopback-callback OAuth. A redirect flow that opens a listener on the host completes only for a caller on that
 *     host; this run drives the device-code shape that is portable over a remote ingress. Ticket 03 states the limit.
 *   - No SSH-gateway credential surface. A provider account belongs to the account whose auth.json this host owns, so an
 *     SSH gateway serves neither the listing nor a flow. That is asserted at the host seam (the gateway tests), not
 *     re-probed here.
 *   - No security-control probe. Every request below is an ordinary admitted Web request; the refusals it reads are the
 *     ones a person meets by being signed out, not attempts to get past anything.
 *
 * Usage: pnpm --filter @hepi/web build
 *        node apps/web/e2e/ux-provider-connection-acceptance.mjs [--keep]
 *        HEPI_PC05_INGRESS_PORT / HEPI_PC05_BACKEND_PORT / HEPI_PC05_GATEWAY_PORT
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { repoRoot, startAcceptanceStack, webLogin, webRoot } from "./acceptance-stack.mjs";

const keep = process.argv.includes("--keep");
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

/** A loopback port this run picks, so the authorization server's own address is stated rather than assumed. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = probeServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * The upstream Kimi device-code authorization server, as RFC 8628 states it.
 *
 * It answers the two requests upstream's flow makes — the device authorization and the token poll — and nothing else. The
 * approval is this run's own: the driver opens the verification page, which flips the grant, exactly as a person finishing
 * the flow in another browser would. Every request is recorded so "the flow really polled" and "the flow was cancelled
 * before the exchange" are observations rather than sleeps.
 */
async function startDeviceAuthorization() {
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const state = {
    /** Whether a person has approved the grant the verification page names. */
    approved: false,
    /** Set by the driver to make the next token poll answer an expired grant instead of a pending one. */
    expired: false,
    deviceAuthorizations: 0,
    tokenPolls: 0,
    /** Every request the flow made, as method + path, so the flow's own progress is visible from here. */
    requests: [],
    deviceCode: null,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    state.requests.push((request.method ?? "GET") + " " + url.pathname);
    if (url.pathname === "/api/oauth/device_authorization" && request.method === "POST") {
      state.deviceAuthorizations += 1;
      state.deviceCode = "device-" + state.deviceAuthorizations + "-" + Math.random().toString(36).slice(2, 10);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        device_code: state.deviceCode,
        user_code: "KIMI-ACCEPT",
        verification_uri: origin + "/device",
        verification_uri_complete: origin + "/device?user_code=KIMI-ACCEPT",
        // One second is RFC 8628's floor for a client, which keeps the flow's own poll visible in a short run.
        interval: 1,
        expires_in: 600,
      }));
      return;
    }
    // The verification page a person opens in the other browser. Opening it is the approval.
    if (url.pathname === "/device" && request.method === "GET") {
      state.approved = true;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>approved</title><p>Approved.</p>");
      return;
    }
    if (url.pathname === "/api/oauth/token" && request.method === "POST") {
      state.tokenPolls += 1;
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }
      if (state.expired) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "expired_token" }));
        return;
      }
      if (!state.approved) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "authorization_pending" }));
        return;
      }
      // The token shape upstream's own Kimi flow parses, and the value this run then asserts is nowhere on this side.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        access_token: ACCEPTED_ACCESS, refresh_token: ACCEPTED_REFRESH, expires_in: 3600,
      }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(port, "127.0.0.1", resolveListen); });
  return { origin, state, close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}

/**
 * One value of each kind the run must never see again.
 *
 * A brace-wrapped placeholder proves nothing about a masking rule, so these are the shapes upstream really hands back: a
 * Kimi access token is an opaque bearer, and the API key is the value a person types into the field.
 */
const ACCEPTED_ACCESS = "kimi-access-pc05ac9f2b";
const ACCEPTED_REFRESH = "kimi-refresh-pc05rf4d71";
/** The key this run types into the API-key field, which must reach the host's file and nowhere else. */
const TYPED_KEY = "sk-pc05-key-4c1f8a27e93b";
const KEY_PROVIDER = "deepseek";
/** The subscription this run signs in to: an SDK built-in whose own device-code flow upstream implements. */
const SUBSCRIPTION = "kimi-coding";

/** Whether a value a person never should see again appears in a haystack this run collected. */
const leaks = (haystack, needle) => String(haystack).includes(needle);

const browserRequests = [];
let stack;
let browser;
let device;
const shutdown = async () => {
  await browser?.close().catch(() => {});
  await stack?.close().catch(() => {});
  await device?.close().catch(() => {});
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { console.log("Interrupted by " + signal + "; stopping what this run started"); void shutdown().then(() => process.exit(130)); });
}

let exitCode = 1;
try {
  device = await startDeviceAuthorization();
  console.log("Provenance: source " + sourceRevision + (sourceDirty ? " (dirty tree)" : " (clean)") + ", Web build " + join(webRoot, "dist"));
  console.log("Upstream stand-in: Kimi device authorization on " + device.origin + " (RFC 8628; no paid provider, no real account)");
  console.log("Configuration mode: Pi file-backed (HEPI_CONFIG_SOURCE=pi over this run's own agent directory) — the mode in which the Gateway's auth.json is the Backend's own account");

  stack = await startAcceptanceStack({
    label: "pc05-provider",
    keep,
    piConfigSource: "pi",
    // The device-code endpoint upstream's flow reads from its own environment. It is this run's stand-in for the
    // provider's authorization server, and it is stated to the host service rather than to this driver's shell.
    extraGatewayEnv: { KIMI_CODE_OAUTH_HOST: device.origin },
    // The catalog this mode reads, stated to the stack so the Backend loads it at startup: one file-owned provider whose
    // model is offered only while its credential exists. The provider is an SDK built-in, so its models are the ones the
    // composer would really show; only its base URL is this run's unused endpoint.
    piModels: { providers: { [KEY_PROVIDER]: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "acceptance-model", name: "Acceptance Model" }] } } },
    ports: {
      ingress: Number(process.env.HEPI_PC05_INGRESS_PORT ?? 0),
      backend: Number(process.env.HEPI_PC05_BACKEND_PORT ?? 0),
      gateway: Number(process.env.HEPI_PC05_GATEWAY_PORT ?? 0),
    },
    log: (line) => console.log(line),
  });
  console.log("Artifacts: " + stack.artifacts);
  console.log("Agent directory (the Gateway's account, and in this mode the Backend's): " + stack.agentDir);

  const authPath = join(stack.agentDir, "auth.json");
  // A fresh home, not a machine's existing credentials. The file itself may already exist because the Backend's own runtime
  // opens it at startup; what matters is that it holds no provider record, which is the fact the first listing reads.
  const freshAuth = existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {};
  assert.deepEqual(freshAuth, {}, "the run starts with no stored provider credential: a fresh home, not a machine's existing auth.json");

  const backend = (path, init) => fetch(stack.backendOrigin + path, { headers: stack.backendHeaders, ...init });
  /** The Backend's own catalog read: what the composer's list is made of, asked of the route it asks. */
  const catalog = async () => {
    const response = await backend("/api/models");
    assert.equal(response.status, 200, "the Backend answered its catalog route");
    return await response.json();
  };
  const offeredBy = (body, provider) => (body.models ?? []).filter((model) => model.provider === provider).map((model) => model.id);
  /** The ingress's own listing, read the way the panel reads it, with this run's Web cookie. */
  const listing = async (cookie) => {
    const response = await fetch(stack.ingressOrigin + "/api/auth/providers", { headers: { cookie, origin: stack.webOrigin } });
    assert.equal(response.status, 200, "the ingress answered the provider listing: " + response.status);
    return await response.json();
  };
  /** The account's file as it is on disk right now. */
  const storedAuth = () => existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")) : {};
  const mode = (path) => (statSync(path).mode & 0o777).toString(8);

  // ---- Observation 0. The mode, the topology, and the surface the journey runs on. ------------------------------
  const cookie = await webLogin(stack);
  const beforeListing = await listing(cookie);
  check(Array.isArray(beforeListing.oauthProviders) && beforeListing.oauthProviders.length > 0, "the ingress answers the host's provider listing with the subscriptions it serves: " + beforeListing.oauthProviders.length + " rows");
  check(beforeListing.oauthProviders.some((row) => row.id === SUBSCRIPTION && row.supportsOAuth === true && row.loggedIn === false), "the SDK's own Kimi subscription is listed and not connected on a fresh home");
  check(offeredBy(await catalog(), KEY_PROVIDER).length === 0, "the Backend offers none of the file-named provider's models while its credential is absent: the stored-vs-usable pair starts empty on both sides");

  // ---- Observation 1. API key: set / list / remove through the ingress, read back from the account's file. ------
  const setKey = await fetch(stack.ingressOrigin + "/api/auth/api-key/" + KEY_PROVIDER, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: stack.webOrigin },
    body: JSON.stringify({ apiKey: TYPED_KEY }),
  });
  const setKeyBody = await setKey.text();
  check(setKey.status === 200, "the Web ingress accepted an API key for a provider the host serves (" + setKey.status + ")");
  check(!leaks(setKeyBody, TYPED_KEY), "the write's own answer carries no part of the value it was given");
  const keyRow = JSON.parse(setKeyBody).providers.find((row) => row.id === KEY_PROVIDER);
  check(keyRow !== undefined && keyRow.storedType === "api_key", "the answer restates the listing: this host stores an api_key for it");
  check(typeof keyRow?.maskedHint === "string" && !leaks(keyRow.maskedHint, TYPED_KEY), "and only the hint it masked itself: " + JSON.stringify(keyRow?.maskedHint));
  check(storedAuth()[KEY_PROVIDER]?.key === TYPED_KEY, "the account's auth.json is what accepted the credential — the Gateway's own file, on this host");
  check(mode(authPath) === "600" && mode(stack.agentDir) === "700", "auth.json is 0600 inside a 0700 agent directory (" + mode(authPath) + "/" + mode(stack.agentDir) + ")");
  // The write is atomic: the file is one whole document, and no temporary was left beside it.
  check(readFileSync(authPath, "utf8").trimEnd().endsWith("}"), "the file it wrote is one whole JSON document, not a partial write");
  check(!execFileSync("ls", ["-1", stack.agentDir], { encoding: "utf8" }).split("\n").some((name) => name.includes(".tmp")), "and no temporary file was left in the agent directory");

  // Stored vs runtime-usable, stated separately, in this mode: the Backend resolves availability from the same file on
  // its next read, so the model appears with no restart, no refresh route and no credential sent to it.
  const afterKeyCatalog = await catalog();
  check(offeredBy(afterKeyCatalog, KEY_PROVIDER).includes("acceptance-model"), "the Backend's catalog offers the model that key authenticates, with no restart: " + JSON.stringify(offeredBy(afterKeyCatalog, KEY_PROVIDER)));
  check(!leaks(JSON.stringify(afterKeyCatalog), TYPED_KEY), "and its catalog answer carries no credential value");
  check((await listing(cookie)).apiKeyProviders.find((row) => row.id === KEY_PROVIDER)?.maskedHint !== undefined, "the listing still states presence and a hint, never the value");

  const removeKey = await fetch(stack.ingressOrigin + "/api/auth/api-key/" + KEY_PROVIDER + "?expectedType=api_key", {
    method: "DELETE",
    headers: { cookie, origin: stack.webOrigin },
  });
  const removeKeyBody = await removeKey.text();
  check(removeKey.status === 200, "the ingress removed the stored key (" + removeKey.status + ")");
  check(!leaks(removeKeyBody, TYPED_KEY), "the removal's answer carries no part of the value it removed");
  check(storedAuth()[KEY_PROVIDER] === undefined, "the account's auth.json no longer holds it");
  check(offeredBy(await catalog(), KEY_PROVIDER).length === 0, "and the Backend's next read withdraws the model it authenticated");

  // ---- Observation 2. Interactive sign-in: the browser journeys, in one page. ------------------------------------
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, locale: "en-US" });
  const sessionValue = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("hepi-web-session="))?.split("=").slice(1).join("=");
  if (sessionValue !== undefined) await context.addCookies([{ name: "hepi-web-session", value: decodeURIComponent(sessionValue), url: stack.webOrigin, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => browserRequests.push({ method: request.method(), url: request.url(), body: request.postData() ?? null }));
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(message.type() + ": " + message.text()));

  await page.goto(stack.webOrigin + "/", { waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-new-button").waitFor({ timeout: 90_000 });
  check(true, "the production Web page is admitted by the ingress and renders the workbench");

  /** Settings > Models, opened the way a person opens it. */
  const openModels = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Models", exact: true }).click();
    await page.locator(".config-panel-root").waitFor({ timeout: 60_000 });
  };
  const closeSettings = async () => {
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("navigation", { name: "Settings" }).waitFor({ state: "detached", timeout: 30_000 });
  };
  const detail = () => page.locator(".config-detail");
  /**
   * Pick a provider from the Add-provider picker, the way a person starts a connection.
   *
   * A provider with no stored credential is not in the sidebar yet — the sidebar lists what this host is connected to — so
   * the entry point for a first connection is the picker, and the detail it opens is the surface under test.
   */
  const pickProvider = async (card) => {
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: card, exact: false }).first().click();
    await detail().waitFor({ timeout: 30_000 });
  };

  // 2a. A fresh home's first sign-in: the panel offers Login, the host starts a device flow, and its code reaches a person.
  await openModels();
  await pickProvider(/Kimi For Coding/);
  const loginButton = detail().getByRole("button", { name: "Login", exact: true });
  await loginButton.waitFor({ timeout: 60_000 });
  check(true, "a fresh home's first sign-in offers Login for a subscription this host serves");
  await loginButton.click();
  // The device step: a code meant for another screen, shown whole beside the address it is typed into.
  await detail().getByText("KIMI-ACCEPT", { exact: true }).waitFor({ timeout: 90_000 });
  const deviceText = await detail().textContent();
  check(deviceText.includes("KIMI-ACCEPT"), "the flow's own device code reaches the panel: " + JSON.stringify(deviceText.slice(0, 160)));
  const deviceLinks = await detail().locator("a").allInnerTexts();
  check(deviceLinks.some((text) => text.includes(device.origin + "/device")), "with the verification address it belongs to: " + JSON.stringify(deviceLinks));
  check(device.state.deviceAuthorizations === 1, "one device authorization was asked of the provider, which is one flow");
  // The flow's own poll cadence is RFC 8628's (one second here), so this waits for the first poll rather than assuming it.
  const polled = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (device.state.tokenPolls >= 1) return true;
      await delay(200);
    }
    return false;
  })();
  check(polled, "and the flow polled it while the panel showed the code (" + device.state.tokenPolls + " poll(s))");
  const cancelControl = detail().getByRole("button", { name: "Cancel", exact: true });
  check(await cancelControl.count() === 1, "a running sign-in offers exactly one control that ends it: Cancel");

  // 2b. Cancel: the host ends the flow, the provider's own wait is reached, and nothing is stored.
  await cancelControl.click();
  await detail().getByText(/cancelled/i).waitFor({ timeout: 60_000 });
  check(true, "the panel reports the cancel in the host's own words");
  check(storedAuth()[SUBSCRIPTION] === undefined, "a cancelled sign-in stores nothing: the account's file still has no Kimi credential");
  check((await listing(cookie)).oauthProviders.find((row) => row.id === SUBSCRIPTION)?.loggedIn === false, "and the listing still reports it as not connected");

  // 2c. Reconnect to a pending flow: a sign-in started in one document is resumed by another, not restarted.
  await detail().getByRole("button", { name: "Re-login", exact: true }).or(detail().getByRole("button", { name: "Login", exact: true })).first().click();
  await detail().getByText("KIMI-ACCEPT", { exact: true }).waitFor({ timeout: 90_000 });
  const authorizationsBeforeReload = device.state.deviceAuthorizations;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-new-button").waitFor({ timeout: 90_000 });
  await openModels();
  // The sign-in is still pending, so this provider is still not in the sidebar: the picker is how a person gets back to it.
  await pickProvider(/Kimi For Coding/);
  await detail().getByText("KIMI-ACCEPT", { exact: true }).waitFor({ timeout: 90_000 });
  check(device.state.deviceAuthorizations === authorizationsBeforeReload, "a reloaded page rejoins the flow that is still pending instead of opening a second one (" + device.state.deviceAuthorizations + " authorizations)");
  check(true, "the resumed panel shows the same device step, from the host's own record");

  // 2d. Completion: a person finishes in another browser, and the credential lands on the host — never in the panel.
  const approval = await fetch(device.origin + "/device");
  await approval.body?.cancel();
  check(approval.status === 200, "the run approved the grant the way a person finishes a device flow, in another window");
  await detail().getByText(/Connected successfully/i).waitFor({ timeout: 120_000 });
  check(true, "the flow completed and the panel says so in the words a success earns");
  const kimi = storedAuth()[SUBSCRIPTION];
  check(kimi?.type === "oauth" && kimi.access === ACCEPTED_ACCESS && kimi.refresh === ACCEPTED_REFRESH, "the credential the flow produced is the account's auth.json, in upstream's own record shape");
  check(mode(authPath) === "600", "and the file it was written to is still 0600");
  check(await detail().getByRole("button", { name: "Disconnect", exact: true }).count() === 1, "the panel now offers Disconnect for the stored subscription");
  // Stored vs runtime-usable, stated separately: the Backend's catalog now offers the models that credential authenticates.
  const afterSignInCatalog = await catalog();
  check(offeredBy(afterSignInCatalog, SUBSCRIPTION).length > 0, "the Backend's catalog offers the subscription's models after the sign-in, with no restart: " + JSON.stringify(offeredBy(afterSignInCatalog, SUBSCRIPTION)));
  check(!leaks(JSON.stringify(afterSignInCatalog), ACCEPTED_ACCESS) && !leaks(JSON.stringify(afterSignInCatalog), ACCEPTED_REFRESH), "and its answer carries no token");

  // Nothing the flow produced reached the browser's own storage, the page, or an ordinary request body.
  const renderedAfterSignIn = await page.content();
  check(!leaks(renderedAfterSignIn, ACCEPTED_ACCESS) && !leaks(renderedAfterSignIn, ACCEPTED_REFRESH), "no token is in anything the panel rendered");
  const storageAfterSignIn = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  check(!leaks(JSON.stringify(storageAfterSignIn), ACCEPTED_ACCESS) && !leaks(JSON.stringify(storageAfterSignIn), ACCEPTED_REFRESH), "no browser storage holds a token: " + JSON.stringify(storageAfterSignIn.local.map((entry) => entry[0])));
  const providerBodies = browserRequests.filter((entry) => entry.url.includes("/api/auth/") && entry.body !== null).map((entry) => entry.body);
  check(!providerBodies.some((body) => leaks(body, ACCEPTED_ACCESS) || leaks(body, ACCEPTED_REFRESH)), "no request this page made carried a token in its body: " + providerBodies.length + " provider request body/bodies");
  const providerOrigins = new Set(browserRequests.filter((entry) => entry.url.includes("/api/auth/")).map((entry) => new URL(entry.url).origin));
  check(providerOrigins.size === 1 && providerOrigins.has(stack.ingressOrigin), "and every provider request the page made went to the one ingress origin: " + JSON.stringify([...providerOrigins]));

  // 2e. Re-login after a terminal flow, then removal: the two ends a stored subscription has.
  await detail().getByRole("button", { name: "Re-login", exact: true }).click();
  await detail().getByText("KIMI-ACCEPT", { exact: true }).waitFor({ timeout: 90_000 });
  check(device.state.deviceAuthorizations === authorizationsBeforeReload + 1, "Re-login after a completed flow starts a new one rather than reporting the last outcome back");
  await detail().getByRole("button", { name: "Cancel", exact: true }).click();
  await detail().getByText(/cancelled/i).waitFor({ timeout: 60_000 });
  check(storedAuth()[SUBSCRIPTION]?.access === ACCEPTED_ACCESS, "cancelling a re-login leaves the credential the earlier flow stored in place");
  await detail().getByRole("button", { name: "Disconnect", exact: true }).click();
  const removedKimi = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (storedAuth()[SUBSCRIPTION] === undefined) return true;
      await delay(200);
    }
    return false;
  })();
  check(removedKimi, "Disconnect drops the stored subscription from the account's file");
  check(offeredBy(await catalog(), SUBSCRIPTION).length === 0, "and the Backend's catalog withdraws the models it authenticated");

  // 2f. Expiry: a flow whose grant expired ends as a failed flow — never as a stored credential, and never as a hang.
  //
  // What this observes, honestly: the host reports the end as `failed` in its own fixed words, because upstream hands the
  // expiry back as an ordinary error and this surface deliberately forwards no provider text. The phase the host reserves
  // for expiry (`expired`) is its own fifteen-minute deadline, covered at the host seam. The person is left with a Login
  // control and no stored credential, which is the actionable half; the reason is not distinguished. Recorded as a named
  // limit in the ticket rather than papered over here.
  device.state.expired = true;
  await detail().getByRole("button", { name: "Login", exact: true }).or(detail().getByRole("button", { name: "Re-login", exact: true })).first().click();
  const expiryEnded = await (async () => {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const text = await detail().textContent();
      if (/sign-in failed|failed on this host/i.test(text ?? "")) return true;
      await delay(300);
    }
    return false;
  })();
  check(expiryEnded, "a flow whose device grant expired ends as a failed sign-in instead of hanging");
  check(storedAuth()[SUBSCRIPTION] === undefined, "and an expired flow stores no credential");
  check(await detail().getByRole("button", { name: "Login", exact: true }).or(detail().getByRole("button", { name: "Re-login", exact: true })).first().isEnabled(), "with a control to start again, which is what an expired grant leaves a person to do");
  device.state.expired = false;

  // ---- Observation 3. The composer's own catalog reflects the change without a reload. -------------------------
  // A conversation exists, its composer holds the page's catalog, and a credential change made in Settings is visible in
  // that composer when Settings closes — no browser reload, no restart.
  await closeSettings();
  const newSession = page.locator(".sidebar-new-button");
  if (!(await newSession.isEnabled())) {
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.locator(".project-picker.is-stacked .project-picker-button.is-project").click();
    await page.locator('.sidebar-menu [role=menuitemradio][title="' + stack.projectRoot + '"]').waitFor({ timeout: 30_000 });
    await page.locator('.sidebar-menu [role=menuitemradio][title="' + stack.projectRoot + '"]').click();
    await page.waitForFunction(() => document.querySelector(".sidebar-new-button")?.disabled === false, undefined, { timeout: 30_000 });
    await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  }
  await newSession.click();
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  /** The composer's model selector, as a person reads it: its own list of options, opened and closed. */
  const modelOptions = async () => {
    // The composer re-renders as the catalog arrives, so the control can be replaced under the click: that is the page
    // working, not the selector missing, and the next attempt reads whichever control is there then.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await page.locator(".model-selector button").count() === 0) return [];
      try {
        await page.locator(".model-selector button").first().click({ timeout: 15_000 });
        const options = await page.getByRole("option").allInnerTexts({ timeout: 15_000 });
        await page.keyboard.press("Escape");
        await page.locator('[role="listbox"]').waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
        return options;
      } catch {
        await page.keyboard.press("Escape").catch(() => undefined);
        await delay(500);
      }
    }
    return [];
  };
  // With no credential stored anywhere, this mode's catalog is empty and the composer honestly offers no model at all —
  // which is the state the credential change below has to be visible from.
  const beforeComposerOptions = await modelOptions();
  check(beforeComposerOptions.length === 0, "the composer offers no model while no credential is stored in this mode: " + JSON.stringify(beforeComposerOptions.slice(0, 6)));
  const documentBeforeChange = await page.evaluate(() => performance.timeOrigin);

  // Store the key through the panel, then close Settings: the page's cached catalog is dropped on the change and the
  // composer's next read asks the deployment again — no reload, no restart.
  await openModels();
  await pickProvider(/DeepSeek/);
  const keyField = detail().locator('input[type="password"]').first();
  await keyField.fill(TYPED_KEY);
  await detail().getByRole("button", { name: "Save", exact: true }).click();
  await detail().getByText(/stored|configured/i).first().waitFor({ timeout: 60_000 });
  await closeSettings();
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  // The bound is under the catalog cache's own lifetime (60s), so a stale answer cannot pass by expiring: what makes
  // this read fresh is the invalidation the change caused, not the passage of time.
  const afterComposerOptions = await (async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const options = await modelOptions();
      if (options.some((name) => name.includes("Acceptance Model")) || Date.now() > deadline) return options;
      await delay(500);
    }
  })();
  check(afterComposerOptions.some((name) => name.includes("Acceptance Model")), "the composer's model list offers the newly authenticated model after the credential change, without a page reload: " + JSON.stringify(afterComposerOptions.filter((name) => name.includes("Acceptance")).slice(0, 3)));
  check(await page.evaluate(() => performance.timeOrigin) === documentBeforeChange, "and the document that offers it is the one this run admitted: nothing was reloaded to see the change");
  check(storedAuth()[KEY_PROVIDER]?.key === TYPED_KEY, "the key the panel saved through the ingress is in the account's file, not only in the page's state");
  check(offeredBy(await catalog(), KEY_PROVIDER).includes("acceptance-model"), "the Backend's catalog agrees with the composer: the credential and its models are one account's facts");

  // And the removal is visible the same way: the model it authenticated leaves the composer's list.
  await openModels();
  await page.locator(".config-sidebar-item").filter({ hasText: "DeepSeek" }).first().click();
  await detail().getByRole("button", { name: "Disconnect", exact: true }).click();
  const removedFromPanel = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (storedAuth()[KEY_PROVIDER] === undefined) return true;
      await delay(200);
    }
    return false;
  })();
  check(removedFromPanel, "the panel's own Disconnect drops the stored key");
  await closeSettings();
  await page.locator("textarea").first().waitFor({ timeout: 30_000 });
  const afterRemovalOptions = await (async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const options = await modelOptions();
      if (!options.some((name) => name.includes("Acceptance Model")) || Date.now() > deadline) return options;
      await delay(500);
    }
  })();
  check(!afterRemovalOptions.some((name) => name.includes("Acceptance Model")), "and the composer's list no longer offers it after the removal, still without a reload: " + JSON.stringify(afterRemovalOptions.slice(0, 6)));
  check(await page.evaluate(() => performance.timeOrigin) === documentBeforeChange, "the same admitted document saw both ends of the change");

  // ---- Observation 4. Nothing secret reached a log, a request body or a stored file this run owns. --------------
  const childrenLog = readFileSync(join(stack.artifacts, "children.log"), "utf8");
  check(!leaks(childrenLog, TYPED_KEY), "the typed API key is in no child process's log (gateway, ingress, Backend)");
  check(!leaks(childrenLog, ACCEPTED_ACCESS) && !leaks(childrenLog, ACCEPTED_REFRESH), "and neither token the sign-in produced is in one");
  const keyBodies = browserRequests.filter((entry) => entry.body !== null && leaks(entry.body, TYPED_KEY));
  check(keyBodies.length === 1 && keyBodies[0].url === stack.ingressOrigin + "/api/auth/api-key/" + KEY_PROVIDER, "exactly one request body ever held the key, and it was the ingress's own write: " + JSON.stringify(keyBodies.map((entry) => entry.method + " " + new URL(entry.url).pathname)));
  check(!leaks(await page.content(), TYPED_KEY), "the typed key is in nothing the page rendered");
  const finalStorage = await page.evaluate(() => ({ local: Object.entries(localStorage), session: Object.entries(sessionStorage) }));
  check(!leaks(JSON.stringify(finalStorage), TYPED_KEY), "and no browser storage holds it");
  // The durable Backend serves no provider route at all: these belong to the host this origin runs on.
  const backendProviderRoute = await backend("/api/auth/providers");
  await backendProviderRoute.body?.cancel();
  check(backendProviderRoute.status !== 200, "the Backend serves no provider listing of its own (" + backendProviderRoute.status + "): the credential path is the ingress to this host");
  check(pageErrors.length === 0, "the page raised no uncaught error across the journeys: " + JSON.stringify(pageErrors.slice(0, 3)));
  const consoleLeaks = consoleLines.filter((line) => leaks(line, TYPED_KEY) || leaks(line, ACCEPTED_ACCESS) || leaks(line, ACCEPTED_REFRESH));
  check(consoleLeaks.length === 0, "and the page's own console carries no credential: " + JSON.stringify(consoleLeaks.slice(0, 3)));

  console.log("");
  console.log("Checks: " + results.length + ", failures: " + failures.length);
  for (const failure of failures) console.log("  FAILED  " + failure);
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.log("FAILED to complete the journey: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
  exitCode = 1;
} finally {
  await shutdown();
}
process.exit(exitCode);
