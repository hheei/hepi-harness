/**
 * Ticket 11 browser seam: the settings panels ask the connection's own origin with the connection's own credential.
 *
 * Ticket 02 (provider connection) extends it: the provider listing and the API-key write path belong to this origin's
 * **host**, not the Backend, so the driver runs a real set/list/remove cycle through the connection and proves the raw
 * key exists in exactly one request body and nowhere else — no response, no rendered panel, no browser storage.
 *
 * Everything is the production surface — the real `SettingsPanel` General section, `ModelsConfig`,
 * `ExtensionsConfig`, and `EnabledModelsSection` with its own `useEnabledModels` controller — behind one real
 * `createClient` configured with an ingress origin that is not this document's and one device bearer. No ingress and no
 * backend are needed: the client's own transport is the fixture's, and the assertions are about what the production
 * surfaces asked for and which credential they presented.
 *
 * What it asserts:
 *   1. every panel read resolves against the configured ingress origin, never the page's own;
 *   2. every panel read and write presents the connection's bearer;
 *   3. the General, Models, Extensions and Enabled-models surfaces each reach their own routes that way;
 *   4. a write (an enabled-models save and an extensions save) goes through the connection too;
 *   5. no panel route falls back to the page's own origin.
 *
 * Usage: node apps/web/e2e/auth-shell/ux-panel-ingress.ts [--keep]
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ConnectionRequest, View } from "./ux-panel-ingress.fixture.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_PANEL_INGRESS_PORT ?? 43133);

const INGRESS_ORIGIN = "https://ingress.example:9443";
const BEARER = "panel-ingress-device-bearer";
/** One raw API key, typed once by the driver. Nothing below may show it back. */
const RAW_KEY = "sk-panel-ingress-0123456789abcdef";
/** A key this origin's host refuses to store (its lock is held), so a failed write is an observation, not a stub. */
const REFUSED_KEY = "sk-refused-locked";
/** The hint the host masks on its own machine, which is the only form that ever leaves it. */
const MASKED_HINT = "sk-a…host";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-panel-ingress-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-panel-ingress.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>panel ingress</title>",
  "<link rel=\"stylesheet\" href=\"./ux-panel-ingress.fixture.css\">",
  "</head><body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-panel-ingress.fixture.js\"></script>",
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

let exitCode = 1;
try {
  console.log("== fixture " + origin + " (build " + buildDir + ")");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });

    const connection = async (): Promise<ConnectionRequest[]> => await page.evaluate(() => window.__uxPanelIngress!.connection);
    const pageRequests = async () => await page.evaluate(() => window.__uxPanelIngress!.page);
    const setView = async (view: View): Promise<void> => { await page.evaluate((next) => window.__uxPanelIngress!.setView(next), view); };
    /** The sign-in route's own requests: one path, the flow named in its query. */
    const signIns = async (method?: string, flow?: string): Promise<ConnectionRequest[]> => (await connection()).filter((entry) =>
      entry.url.startsWith(INGRESS_ORIGIN + "/api/auth/login/fixture-signin")
      && (method === undefined || entry.method === method)
      && (flow === undefined ? !entry.url.includes("flow=") : entry.url.includes(flow)));
    /** The flow id the host last handed the panel, read back from the request the panel made with it. */
    const lastFlowId = async (): Promise<string | null> => {
      const withFlow = (await signIns(undefined, "flow=")).at(-1);
      return withFlow === undefined ? null : new URL(withFlow.url).searchParams.get("flow");
    };
    const waitForPath = async (path: string, method?: string): Promise<void> => {
      await page.waitForFunction(
        ([wanted, verb]) => window.__uxPanelIngress!.connection.some((entry) => entry.url.startsWith(window.__uxPanelIngress!.origin + wanted) && (verb === null || entry.method === verb)),
        [path, method ?? null],
        { timeout: 30000 },
      );
    };

    // --- 1. General: the tool settings are read on the connection, and a bearer host is offered no cookie logout. --
    await page.locator(".settings-dialog-surface").waitFor({ timeout: 30000 });
    await waitForPath("/api/tools/settings", "GET");
    const general = await connection();
    check(general.some((entry) => entry.url === INGRESS_ORIGIN + "/api/tools/settings" && entry.method === "GET"), "the tool settings are read on the configured ingress origin: " + JSON.stringify(general.map((entry) => entry.url)));
    // This fixture's connection is a device bearer. A Web logout clears the ingress's HttpOnly cookie, which this host
    // does not hold and no route of this origin could clear: offering it would be a control whose only outcomes are
    // "did nothing" and "did something else". So the control is absent, and the login-state read it would need is never
    // asked either.
    check(!(await connection()).some((entry) => entry.url === INGRESS_ORIGIN + "/api/web-auth"), "a bearer host asks no Web login-state question");
    const generalBody = await page.locator(".settings-dialog-main").innerText();
    check(!/Log out/.test(generalBody), "and is offered no cookie logout control: " + JSON.stringify(generalBody.slice(0, 200)));
    check((await page.locator(".settings-dialog-main").getByRole("button", { name: /Log out/ }).count()) === 0, "no logout button exists in the panel");
    const generalPage = await pageRequests();
    check(generalPage.length === 0, "no General read fell back to the page's own origin: " + JSON.stringify(generalPage));

    // --- 2. Models: the models file and the provider list are read on the connection. --------------------------
    await setView("models");
    await waitForPath("/api/models-config", "GET");
    await waitForPath("/api/auth/providers", "GET");
    const models = await connection();
    check(models.some((entry) => entry.url === INGRESS_ORIGIN + "/api/models-config" && entry.method === "GET"), "the models file is read on the configured ingress origin");
    check(models.some((entry) => entry.url === INGRESS_ORIGIN + "/api/auth/providers" && entry.method === "GET"), "and so is the provider list");
    check(models.some((entry) => entry.url === INGRESS_ORIGIN + "/api/models-config/discover"), "the provider-discovery probe asks the same origin as the control it gates");

    // --- 2b. Provider credentials: set, re-read and remove this host's own key, on the connection. -------------
    // One mounted catalog reader — the composer of an open page, which follows the model domain's own rule — and one
    // read of the catalog it holds. Everything below happens with Settings › Models still open: a change this panel
    // applies must reach that reader now, not when the dialog closes.
    await page.evaluate(() => window.__uxPanelIngress!.followCatalog());
    await page.evaluate(() => window.__uxPanelIngress!.readCatalog());
    const catalogReads = async (): Promise<number> => (await page.evaluate(() => window.__uxPanelIngress!.cachedCatalog())).reads;
    const catalogEntries = async (): Promise<number> => (await page.evaluate(() => window.__uxPanelIngress!.cachedCatalog())).entries;
    /**
     * The read count once it has stopped moving.
     *
     * One change can owe more than one read — a `models.json` save also re-verifies the `enabledModels` patterns, which
     * is a write of its own — so a count read the instant it first moved would be a snapshot mid-sequence. This waits
     * until the page has been quiet long enough for a settled number, which is what the assertions below compare.
     */
    const settledCatalogReads = async (): Promise<number> => {
      let seen = await catalogReads();
      for (let quiet = 0; quiet < 8;) {
        await delay(250);
        const now = await catalogReads();
        if (now === seen) quiet += 1; else { seen = now; quiet = 0; }
      }
      return seen;
    };
    check(await catalogReads() === 1, "the page read its catalog once: " + (await catalogReads()));
    check(await catalogEntries() === 1, "and its mounted reader is holding that answer");

    // The picker lists what the host's listing said, and the key provider is unconfigured, so its detail is the field.
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: /Fixture Key/ }).click();
    const detail = page.locator(".config-detail");
    await detail.locator("input").first().fill(RAW_KEY);
    await detail.getByRole("button", { name: "Save", exact: true }).click();
    await waitForPath("/api/auth/api-key/fixture-key", "POST");

    const keyWrites = async () => (await connection()).filter((entry) => entry.method === "POST" && entry.url.endsWith("/api/auth/api-key/fixture-key"));
    check((await keyWrites()).length === 1, "the typed key produced exactly one provider key write: " + (await keyWrites()).length);
    const keyWrite = (await keyWrites())[0];
    check(keyWrite?.url === INGRESS_ORIGIN + "/api/auth/api-key/fixture-key", "the key write went to the configured ingress origin: " + keyWrite?.url);
    check(keyWrite?.authorization === "Bearer " + BEARER, "and presented the connection's own bearer");
    check(keyWrite?.body === JSON.stringify({ apiKey: RAW_KEY }), "the key travels as this surface's one request body: " + JSON.stringify(keyWrite?.body));
    // A listing re-read after the write: the panel shows the state the host answered, not what it asked for. The wait is
    // the render of that hint, so this is the panel's settled state rather than a snapshot mid-save.
    await detail.getByText(MASKED_HINT, { exact: false }).waitFor({ timeout: 30000 });
    const reads = (await connection()).filter((entry) => entry.method === "GET" && entry.url === INGRESS_ORIGIN + "/api/auth/providers");
    check(reads.length >= 2, "the panel re-read the host's listing after the write: " + reads.length + " reads");
    check(((await detail.textContent()) ?? "").includes(MASKED_HINT), "the detail shows only the hint the host masked: " + (await detail.textContent()));
    check(!(await page.content()).includes(RAW_KEY), "the raw key is in no response the panel rendered");
    check(!(await connection()).filter((entry) => entry.body !== null && entry.body.includes(RAW_KEY) && entry.url !== INGRESS_ORIGIN + "/api/auth/api-key/fixture-key").length, "the raw key left this side in exactly one request body");
    const stored = await page.evaluate(() => Object.keys(localStorage).map((key) => key + "=" + localStorage.getItem(key)));
    check(stored.every((entry) => !entry.includes(RAW_KEY)), "no browser storage holds the key: " + JSON.stringify(stored.map((entry) => entry.split("=")[0])));

    // The catalog is the answer the credential just decided, and the reader mounted above follows it: the stored key
    // supersedes the held answer, so that reader asks the deployment again **while this panel is still open** — no
    // close, no reload. The wait is the re-read itself, so this is a settled observation rather than a snapshot.
    await page.waitForFunction(() => window.__uxPanelIngress!.cachedCatalog().reads > 1, null, { timeout: 30000 });
    check(true, "a credential change re-read the catalog of a mounted reader with Settings still open");
    check(await catalogEntries() === 1, "and it is holding the answer the change produced");
    const readsAfterKeyStore = await settledCatalogReads();
    await page.evaluate(() => window.__uxPanelIngress!.readCatalog());
    check(await catalogReads() === readsAfterKeyStore, "a second read of one catalog asked again: the cache is not the page's");

    // A write the host refuses is not an applied change: the panel states the refusal and the held catalog is left
    // alone, because nothing about what the deployment serves changed.
    await detail.locator("input").first().fill(REFUSED_KEY);
    await detail.getByRole("button", { name: "Save", exact: true }).click();
    await detail.getByText(/another writer holds|ask again/i).first().waitFor({ timeout: 30000 });
    check(true, "a refused key write is stated in the words its recovery needs: " + (await detail.textContent())?.slice(0, 160));
    check(await settledCatalogReads() === readsAfterKeyStore, "a failed credential write claimed an applied change: " + (await catalogReads()));
    check(((await detail.textContent()) ?? "").includes(MASKED_HINT), "and the hint the host still stores is what the panel shows: a refused write changed nothing");

    // --- 2b-2. A `models.json` save: applied is a change, saved-but-not-applied is not. ----------------------
    // An applied save is two changes, not one: the catalog the runtime now serves, and the `enabledModels` patterns the
    // panel re-verifies through a write of their own. This check observes the combination, so the not-applied check
    // below is the one that isolates the condition — there, neither half may reach a catalog reader.
    const saveButton = page.locator(".config-footer").getByRole("button", { name: "Save", exact: true });
    const modelsFileReads = async (): Promise<number> => (await connection()).filter((entry) => entry.method === "GET" && entry.url === INGRESS_ORIGIN + "/api/models-config").length;
    /** The `enabledModels` writes this panel has made: a save re-verifies the switches through one of its own. */
    const enabledWrites = async (): Promise<number> => (await connection()).filter((entry) => entry.method === "PUT" && entry.url === INGRESS_ORIGIN + "/api/models/enabled").length;
    const enabledWritesBefore = await enabledWrites();
    const readsBeforeSave = await settledCatalogReads();
    await saveButton.click();
    const readsAfterSave = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await catalogReads() > readsBeforeSave) return await settledCatalogReads();
        await delay(250);
      }
      return await catalogReads();
    })();
    check(readsAfterSave > readsBeforeSave, "an applied models.json save re-read the catalog of the mounted reader (" + readsBeforeSave + " → " + readsAfterSave + ")");
    await saveButton.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>(".config-footer button")].find((candidate) => candidate.textContent?.trim() === "Save");
      return button !== undefined && !button.disabled;
    }, undefined, { timeout: 30000 });

    // The same save, answered as the file written and the running runtime unchanged. That is not a change to what the
    // deployment serves: the panel states it, re-reads the file it edited, and asks no catalog reader to re-read.
    // The applied save also re-verifies the switches, through an enabledModels write of their own that lands after it.
    // Both halves are changes, so the not-applied baseline below is taken once the panel has finished that pair: what
    // it then asserts is about the second save alone.
    await page.waitForFunction((wanted) => window.__uxPanelIngress!.connection.filter((entry) => entry.method === "PUT" && entry.url === window.__uxPanelIngress!.origin + "/api/models/enabled").length > wanted, enabledWritesBefore, { timeout: 30000 });
    await page.evaluate(() => window.__uxPanelIngress!.answerModelSave(false));
    const readsBeforeUnapplied = await settledCatalogReads();
    const fileReadsBeforeUnapplied = await modelsFileReads();
    await saveButton.click();
    await page.locator(".config-footer").getByText(/could not apply it/i).waitFor({ timeout: 30000 });
    check(true, "a save the runtime did not apply is stated as saved-but-not-applied, not as Saved: " + ((await page.locator(".config-footer").textContent()) ?? "").slice(0, 120));
    await delay(1_500);
    check(await settledCatalogReads() === readsBeforeUnapplied, "a save that was not applied claimed an applied catalog change (" + readsBeforeUnapplied + " → " + (await catalogReads()) + ")");
    check(await modelsFileReads() > fileReadsBeforeUnapplied, "and the panel read the file back rather than trusting the draft it sent (" + fileReadsBeforeUnapplied + " → " + (await modelsFileReads()) + " reads)");

    await page.evaluate(() => window.__uxPanelIngress!.answerModelSave(true));

    // Remove it again, guarded by the credential type the listing last said the host stored.
    const readsBeforeRemoval = await settledCatalogReads();
    await detail.getByRole("button", { name: "Disconnect", exact: true }).click();
    await waitForPath("/api/auth/api-key/fixture-key", "DELETE");
    const removed = (await connection()).find((entry) => entry.method === "DELETE");
    check(removed?.url === INGRESS_ORIGIN + "/api/auth/api-key/fixture-key?expectedType=api_key", "the removal states the type it expects to remove: " + removed?.url);
    await page.waitForFunction(() => window.__uxPanelIngress!.providerHostState().configured === false, null, { timeout: 30000 });
    check(true, "the host's own state is what the panel asked for: the stored key is gone");
    // The removal is a credential change too, and the mounted reader follows it exactly as it followed the store: the
    // answer the removed key produced is not served afterwards.
    await page.waitForFunction((wanted) => window.__uxPanelIngress!.cachedCatalog().reads > wanted, readsBeforeRemoval, { timeout: 30000 });
    check(true, "a removed credential asked the deployment again through the same reader: " + (await catalogReads()));
    check(await catalogEntries() === 1, "and the page holds one answer, the one that removal produced");

    // --- 2c. Provider sign-in is withheld while the route next to it is the deployment's named limit. -----------
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: /Fixture Subscription/ }).click();
    await waitForPath("/api/auth/login/fixture-oauth", "GET");
    const signInRead = (await connection()).find((entry) => entry.url === INGRESS_ORIGIN + "/api/auth/login/fixture-oauth");
    check(signInRead?.method === "GET" && signInRead?.authorization === "Bearer " + BEARER, "sign-in is asked of its own route, on the connection");
    check(!(await connection()).some((entry) => entry.method === "POST" && entry.url.startsWith(INGRESS_ORIGIN + "/api/auth/login/")), "no sign-in is started against a route the deployment refuses");
    // The withheld control and its sentence are one settled answer: while the route's reply is still in flight the panel
    // cannot know, so the wait is what makes "offers no sign-in control" a claim about the limit rather than a race.
    await detail.getByText("serves no provider sign-in", { exact: false }).waitFor({ timeout: 30000 });
    const detailText = (await detail.textContent()) ?? "";
    check(detailText.includes("This deployment serves no provider sign-in"), "the panel names the sign-in limit: " + detailText);
    check((await detail.getByRole("button").all()).length === 0, "and offers no sign-in control for it: " + (await detail.getByRole("button").count()));

    // --- 2d. A provider sign-in run on this origin's host: its steps, the answer given, and how it ends. --------
    // The flow is scripted by the fixture's host, so each step the panel shows arrives as a host-shaped answer and every
    // claim below is about what crossed the connection. One paste-back answer, one device code, one stored credential.
    const PASTED = "http://localhost:53692/callback?code=4tY4Kj7m2QsVbX&state=xyz";
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    await page.getByRole("button", { name: /Fixture Sign-in/ }).click();
    await waitForPath("/api/auth/login/fixture-signin", "GET");
    const signInProbe = (await connection()).find((entry) => entry.url === INGRESS_ORIGIN + "/api/auth/login/fixture-signin");
    check(signInProbe?.method === "GET" && signInProbe?.authorization === "Bearer " + BEARER, "a served sign-in is asked of its own route, on the connection");
    const loginButton = detail.getByRole("button", { name: "Login", exact: true });
    await loginButton.waitFor({ timeout: 30000 });
    check(true, "and the panel offers sign-in for a provider whose route serves it");

    await loginButton.click();
    await waitForPath("/api/auth/login/fixture-signin", "POST");
    const starts = await signIns("POST");
    check(starts.length === 1, "one click started one sign-in: " + starts.length);
    // A start carries an empty JSON object: the ingress reads every POST on this route as a JSON request, so the panel
    // sends {} rather than no body. Nothing else belongs in it — no key, no answer, no credential.
    check(starts[0]?.body === "{}", "a start carries an empty JSON body and nothing in it: " + JSON.stringify(starts[0]?.body));

    // The device step: a code meant for another screen is shown whole, beside the address it is typed into.
    await detail.getByText("GQV-GBNN", { exact: false }).waitFor({ timeout: 30000 });
    const deviceText = (await detail.textContent()) ?? "";
    check(deviceText.includes("GQV-GBNN"), "the flow's device code reaches the panel: " + deviceText);
    const deviceLinks = await detail.locator("a").allInnerTexts();
    check(deviceLinks.some((text) => text.includes("https://fixture.example/device")), "with the verification address it belongs to: " + JSON.stringify(deviceLinks));

    // The paste-back step: the flow's own question, and the address it had stated, still openable.
    await detail.getByText("Paste the redirect address", { exact: false }).waitFor({ timeout: 30000 });
    const promptLinks = await detail.locator("a").allInnerTexts();
    check(promptLinks.some((text) => text.includes("code_challenge=E9Melhoa")), "the authorization address stays whole rather than masked away: " + JSON.stringify(promptLinks));
    await detail.locator("input").last().fill(PASTED);
    await detail.getByRole("button", { name: "Submit", exact: true }).click();
    await waitForPath("/api/auth/login/fixture-signin?flow=", "POST");

    const answersSent = await signIns("POST", "flow=");
    check(answersSent.length === 1, "the typed answer produced exactly one sign-in request: " + answersSent.length);
    check(answersSent[0]?.body === JSON.stringify({ answer: PASTED }), "and it travels as this surface's one request body: " + JSON.stringify(answersSent[0]?.body));
    const flowId = await lastFlowId();
    check(typeof flowId === "string" && flowId.length >= 32, "the answer named the flow it answered: " + flowId);

    // The host stored what the flow produced, and the panel says so in the words a success earns.
    await page.waitForFunction(() => window.__uxPanelIngress!.signInHostState().stored === true, null, { timeout: 30000 });
    check(true, "the host recorded the answer and ended the flow by storing a credential");
    await detail.getByText("Connected successfully", { exact: false }).waitFor({ timeout: 30000 });
    const readsAfter = (await connection()).filter((entry) => entry.method === "GET" && entry.url === INGRESS_ORIGIN + "/api/auth/providers");
    check(readsAfter.length >= 3, "the panel re-read the host's listing after the flow stored: " + readsAfter.length + " reads");
    check((await detail.getByRole("button").allInnerTexts()).includes("Disconnect"), "the listing now offers the stored subscription: " + JSON.stringify(await detail.getByRole("button").allInnerTexts()));

    // Neither a success nor a refusal ever hands back what the person typed, and no other route carried it either.
    check(!(await page.content()).includes(PASTED), "the pasted answer is in nothing the panel rendered");
    const stray = (await connection()).filter((entry) => entry.body !== null && entry.body.includes("4tY4Kj7m2QsVbX") && entry.url !== INGRESS_ORIGIN + "/api/auth/login/fixture-signin?flow=" + flowId);
    check(stray.length === 0, "the pasted answer left this side in exactly one request body: " + JSON.stringify(stray.map((entry) => entry.url)));
    check(!(await connection()).some((entry) => entry.body !== null && entry.body.includes(RAW_KEY) && !entry.url.endsWith("/api/auth/api-key/fixture-key")), "the provider key never travelled on a sign-in route");
    const storageAfterSignIn = await page.evaluate(() => Object.keys(localStorage).map((key) => key + "=" + localStorage.getItem(key)));
    check(storageAfterSignIn.every((entry) => !entry.includes(PASTED) && !entry.includes(RAW_KEY)), "no browser storage holds an answer or a key: " + JSON.stringify(storageAfterSignIn.map((entry) => entry.split("=")[0])));

    // A second sign-in, then cancelled: a person's cancel is the one thing that ends a flow from this side.
    const relogin = detail.getByRole("button", { name: "Re-login", exact: true });
    await relogin.waitFor({ timeout: 30000 });
    await relogin.click();
    await detail.getByRole("button", { name: "Cancel", exact: true }).waitFor({ timeout: 30000 });
    check(!((await detail.textContent()) ?? "").includes("Connected successfully"), "a new sign-in replaced the last one's success line: " + (await detail.textContent()));
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitForPath("/api/auth/login/fixture-signin?flow=", "DELETE");
    const cancels = await signIns("DELETE", "flow=");
    check(cancels.length === 1, "the cancel named the flow it ended: " + JSON.stringify(cancels.map((entry) => entry.url)));
    await page.waitForFunction(() => window.__uxPanelIngress!.signInHostState().open === false, null, { timeout: 30000 });
    check(true, "and this host holds no flow for this caller afterwards");

    // Sign in again while the host still keeps that cancelled flow readable. The host answers a provider read with the
    // outcome it holds (a 200 and a terminal flow, not a refusal), so a panel that treated that as "a sign-in already
    // running" would show the old cancel and start nothing — a Login button that does nothing for a minute.
    await detail.getByRole("button", { name: "Re-login", exact: true }).waitFor({ timeout: 30000 });
    await detail.getByRole("button", { name: "Re-login", exact: true }).click();
    await waitForPath("/api/auth/login/fixture-signin", "POST");
    const startsAgain = await signIns("POST");
    check(startsAgain.length === 2, "a sign-in after an ended one started a new flow rather than reporting the outcome back: " + startsAgain.length);
    await detail.getByText("GQV-GBNN", { exact: false }).waitFor({ timeout: 30000 });
    check(true, "the new flow's own device step reached the panel");
    check(!((await detail.textContent()) ?? "").includes("this sign-in was cancelled"), "the panel shows the running sign-in, not the outcome it read past: " + (await detail.textContent()));
    await detail.getByRole("button", { name: "Cancel", exact: true }).click();
    await waitForPath("/api/auth/login/fixture-signin?flow=", "DELETE");
    check((await signIns("DELETE", "flow=")).length === 2, "and that flow is the one the second cancel ended");

    // A sign-out names the account, never a flow: the stored credential is dropped without one.
    await detail.getByRole("button", { name: "Disconnect", exact: true }).click();
    await waitForPath("/api/auth/logout/fixture-signin", "POST");
    await page.waitForFunction(() => window.__uxPanelIngress!.signInHostState().stored === false, null, { timeout: 30000 });
    check(true, "disconnecting drops the host's stored credential for that provider");

    // --- 3. Enabled models: the setting is read and its save written on the connection. ------------------------
    await setView("enabled");
    await waitForPath("/api/models/enabled", "GET");
    // A catalog pass is a route of its own, asked before its control is offered. Here the ingress answers the named
    // limit, so the button is withheld — and nothing is POSTed to a route that can only refuse it.
    await waitForPath("/api/models/refresh", "GET");
    check((await page.getByRole("button", { name: "Refresh catalog", exact: true }).count()) === 0, "no catalog-refresh control is offered for a route the deployment refuses");
    check(!(await connection()).some((entry) => entry.method === "POST" && entry.url.startsWith(INGRESS_ORIGIN + "/api/models/refresh")), "and no catalog pass is started against it");
    await page.locator(".enabled-models-row").first().getByRole("switch").click();
    await waitForPath("/api/models/enabled", "PUT");
    const enabledWrite = (await connection()).find((entry) => entry.method === "PUT" && entry.url.startsWith(INGRESS_ORIGIN + "/api/models/enabled"));
    check(enabledWrite !== undefined, "a model switch writes through the connection");
    check(enabledWrite?.url === INGRESS_ORIGIN + "/api/models/enabled", "the write names the configured ingress origin: " + JSON.stringify(enabledWrite?.url));
    // The setting narrows the catalog every selector reads, so an accepted switch is a change stated through the same
    // rule a credential write uses: the mounted reader asks the deployment again. A refusal would claim none.
    const readsBeforeSwitch = await settledCatalogReads();
    const switchesBefore = (await connection()).filter((entry) => entry.method === "PUT" && entry.url === INGRESS_ORIGIN + "/api/models/enabled").length;
    await page.locator(".enabled-models-row").first().getByRole("switch").click();
    await page.waitForFunction((wanted) => window.__uxPanelIngress!.connection.filter((entry) => entry.method === "PUT" && entry.url === window.__uxPanelIngress!.origin + "/api/models/enabled").length > wanted, switchesBefore, { timeout: 30000 });
    const readsAfterSwitch = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await catalogReads() > readsBeforeSwitch) return await settledCatalogReads();
        await delay(250);
      }
      return await catalogReads();
    })();
    check(readsAfterSwitch > readsBeforeSwitch, "an accepted enabledModels write re-read the catalog of the mounted reader (" + readsBeforeSwitch + " → " + readsAfterSwitch + ")");

    // --- 4. Extensions: the installed set, the conversation's selection and its write are on the connection. ---
    await setView("extensions");
    await page.getByRole("button", { name: "coding-tools", exact: true }).waitFor({ timeout: 30000 });
    await waitForPath("/api/conversations/session-1/state", "GET");
    const extensions = await connection();
    check(extensions.some((entry) => entry.url === INGRESS_ORIGIN + "/api/extensions" && entry.method === "GET"), "the installed extension set is read on the configured ingress origin");
    check(extensions.some((entry) => entry.url === INGRESS_ORIGIN + "/api/conversations/session-1/state" && entry.method === "GET"), "and so is the open conversation's own selection");
    await page.locator(".config-detail").getByRole("switch").click();
    await waitForPath("/api/extensions", "POST");
    const extensionWrite = (await connection()).find((entry) => entry.method === "POST" && entry.url === INGRESS_ORIGIN + "/api/extensions");
    check(extensionWrite !== undefined, "an extension toggle writes through the connection");

    // --- 5. Every request went to the connection's origin with the connection's credential. --------------------
    const all = await connection();
    check(all.length > 0, "the surfaces made requests to assert on: " + all.length);
    check(all.every((entry) => entry.url.startsWith(INGRESS_ORIGIN + "/")), "every panel request resolved against the configured ingress origin, never the page's: " + JSON.stringify(all.filter((entry) => !entry.url.startsWith(INGRESS_ORIGIN + "/")).map((entry) => entry.url)));
    check(all.every((entry) => entry.authorization === "Bearer " + BEARER), "every panel request presented the connection's own bearer: " + JSON.stringify([...new Set(all.map((entry) => entry.authorization))]));
    check(all.every((entry) => entry.credentials === "same-origin"), "every panel request kept the browser's own cookie policy: " + JSON.stringify([...new Set(all.map((entry) => entry.credentials))]));
    const expectedPaths = new Set([
      "/api/tools/settings",
      "/api/models-config",
      "/api/auth/providers",
      "/api/auth/api-key/fixture-key",
      "/api/auth/login/fixture-oauth",
      "/api/auth/login/fixture-signin",
      "/api/auth/logout/fixture-signin",
      "/api/models-config/discover",
      "/api/models/enabled",
      "/api/models/refresh",
      "/api/extensions",
      "/api/conversations/session-1/state",
    ]);
    const paths = all.map((entry) => entry.url.slice(INGRESS_ORIGIN.length).split("?")[0]);
    check(paths.every((path) => expectedPaths.has(path)), "every request named a route the deployment serves: " + JSON.stringify([...new Set(paths)]));
    check((await pageRequests()).length === 0, "no panel route fell back to the page origin");

    check(pageErrors.length === 0, "no page error occurred during the browser steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
    exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  const failure = error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE"
    ? "port " + port + " is already in use; stop the other fixture server or set HEPI_PANEL_INGRESS_PORT"
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
