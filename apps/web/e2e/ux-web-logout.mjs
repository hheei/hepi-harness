/**
 * Ticket 18's Web logout contract, in a real browser against an isolated system this run owns.
 *
 * The journey is the ordinary one: a signed-in cookie session clicks Settings › General › Log out, the page returns to
 * a usable entrance, and signing in again works. What this driver is about is the three places that journey was wrong
 * or unstated:
 *
 *   1. the control asks **the route the ingress serves** (`DELETE /api/web-logout`), not the login-state read beside
 *      it, and the deployment answers by clearing the session cookie;
 *   2. a logout that **fails** says so and claims nothing: no reload, no login form for a cookie that was never cleared,
 *      and the session is still admitted afterwards;
 *   3. the entrance is an entrance: the same browser signs in again.
 *
 * Everything is real: the production Vite Web build served by the real client ingress on this run's own port, the real
 * Backend over its own SQLite files, and Chromium holding the cookie. No deployment, no developer session and no shared
 * port is touched — every credential and byte of state belongs to this run and is removed with it.
 *
 * The bearer half of the contract — an App is offered no cookie logout, and the route ends no device credential — is
 * held at its own seams: `apps/web/e2e/ux-panel-ingress.mjs` mounts the production Settings panel under a device bearer,
 * and `packages/gateway/test/ingress.test.ts` asks the route as a device.
 *
 * Usage: pnpm --filter @hepi/web build && node apps/web/e2e/ux-web-logout.mjs [--keep]
 *        HEPI_UX_LOGOUT_BACKEND_PORT=<port> HEPI_UX_LOGOUT_INGRESS_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const keep = process.argv.includes("--keep");
const token = "ux-logout-service-token";
const login = "ux-logout-web-login-material";
const webDist = join(webRoot, "dist");
assert.ok(existsSync(join(webDist, "index.html")), "build the Web product first: pnpm --filter @hepi/web build");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux-logout-"));
const dataDir = join(artifacts, "data");
const workspaceRoot = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspaceRoot, { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return true; }
  failures.push(message);
  console.log("  FAIL " + message);
  return false;
}

function freePort(preferred) {
  return new Promise((resolvePort, reject) => {
    const probe = probeServer();
    probe.on("error", reject);
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) { await response.body?.cancel(); return true; }
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** Both child roles run from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
const childEnv = (home, extra) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra });

const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}
async function stop(child) {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000).then(() => child.kill("SIGKILL"))]);
  await Promise.race([exited, delay(5_000)]);
}

/** Open Settings › General the way a person does: the rail's Settings button, then the General tab. */
async function openGeneral(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "General", exact: true }).click();
  await page.locator(".settings-dialog-main").waitFor({ timeout: 30_000 });
}

let exitCode = 1;
let pageErrors = [];
try {
  const backendPort = await freePort(Number(process.env.HEPI_UX_LOGOUT_BACKEND_PORT ?? 0));
  const backend = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort), HEPI_BIND_HOST: "127.0.0.1", HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_DEVICE_CREDENTIALS: join(dataDir, "device-credentials.sqlite"),
      HEPI_WORKSPACE_ID: "local", HEPI_GATEWAY_ID: "workstation",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  const backendLog = capture(backend);
  const backendOrigin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 45_000), "the backend started: " + backendLog().slice(-500));

  // The ingress is the page's origin and its API's: one listener, so the cookie the login sets is the cookie the page
  // presents, exactly as the deployment serves it.
  const ingressPort = await freePort(Number(process.env.HEPI_UX_LOGOUT_INGRESS_PORT ?? 0));
  const ingress = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "ingress-home"), {
      HEPI_INGRESS_BACKEND: backendOrigin, HEPI_INGRESS_SERVICE_TOKEN: token,
      HEPI_WEB_LOGIN_TOKEN: login,
      HEPI_INGRESS_DEFAULT_HOST: "workstation",
      HEPI_INGRESS_HOST: "127.0.0.1", HEPI_INGRESS_PORT: String(ingressPort),
      HEPI_INGRESS_STATIC_DIR: webDist,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(ingress);
  const ingressLog = capture(ingress);
  const origin = "http://127.0.0.1:" + ingressPort;
  assert.ok(await waitForHttp(origin + "/api/web-auth", {}, 45_000), "the ingress started: " + ingressLog().slice(-800));

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    /** Every request the page made to the deployment, so the route a control asks is observed rather than inferred. */
    const asked = [];
    page.on("request", (request) => { if (request.url().startsWith(origin + "/api/")) asked.push({ method: request.method(), path: new URL(request.url()).pathname }); });

    // --- 1. A browser with no session gets the deployment's own entrance. --------------------------------------
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 30_000 });
    check(true, "a browser with no session gets the deployment's sign-in form");

    // --- 2. The ordinary login, through the form a person types into. -----------------------------------------
    await page.locator("#web-login-token").fill(login);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).first().waitFor({ timeout: 45_000 });
    check(true, "a valid login admits the workbench");

    // --- 3. Settings › General offers the logout, because this host's session is the cookie. -------------------
    await openGeneral(page);
    const logout = page.locator(".settings-dialog-main").getByRole("button", { name: /Log out/ });
    check(await logout.count() === 1, "Settings › General offers the logout for a cookie session");

    // --- 4. A failing logout claims nothing: no reload, and the session is still admitted. ---------------------
    // The route is refused for this one attempt, so the failure path runs without changing the deployment: the page
    // must stay where it is, say the attempt failed, and keep the cookie it never lost.
    let navigations = 0;
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations += 1; });
    await page.route("**/api/web-logout", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "authority unreachable" }) }));
    await logout.click();
    const failure = page.locator(".settings-dialog-main [role=alert]");
    await failure.waitFor({ timeout: 30_000 });
    const failureText = await failure.innerText();
    check(/Could not log out/.test(failureText), "a refused logout says it could not log out: " + JSON.stringify(failureText));
    check(/503/.test(failureText), "and names the status a person can act on: " + JSON.stringify(failureText));
    check(navigations === 0, "and does not reload the page into a session that was never ended");
    check((await page.getByRole("heading", { name: /Welcome back/ }).count()) === 0, "so no sign-in form is shown for a cookie that is still there");
    const stillAdmitted = await page.evaluate(async (target) => (await fetch(target + "/api/conversations")).status, origin);
    check(stillAdmitted === 200, "and the session really is still admitted (" + stillAdmitted + ")");
    await page.unroute("**/api/web-logout");

    // --- 5. The real logout: the ingress's own route clears the cookie and the page returns to the entrance. ----
    asked.length = 0;
    await logout.click();
    await page.getByRole("heading", { name: /Welcome back/ }).waitFor({ timeout: 45_000 });
    check(true, "a successful logout returns the page to a usable sign-in form");
    const logoutRequests = asked.filter((entry) => entry.path === "/api/web-logout");
    check(logoutRequests.length === 1 && logoutRequests[0].method === "DELETE", "and it asked DELETE /api/web-logout: " + JSON.stringify(logoutRequests));
    check(!asked.some((entry) => entry.path === "/api/web-auth" && entry.method === "DELETE"), "never a DELETE on the login-state read");
    const afterLogout = await page.evaluate(async (target) => (await fetch(target + "/api/conversations")).status, origin);
    check(afterLogout === 401, "the cookie the page had is gone, so a business read needs admission again (" + afterLogout + ")");
    const cookieNames = (await context.cookies(origin)).map((cookie) => cookie.name);
    check(!cookieNames.includes("hepi-web-session"), "and the session cookie is not in the browser jar: " + JSON.stringify(cookieNames));

    // --- 6. Signing in again works: the entrance is an entrance, not a dead end. ------------------------------
    await page.locator("#web-login-token").fill(login);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).first().waitFor({ timeout: 45_000 });
    check(true, "the same browser signs in again after logging out");
    await openGeneral(page);
    check(await page.locator(".settings-dialog-main").getByRole("button", { name: /Log out/ }).count() === 1, "and the logout is offered again for the new session");

    // --- 7. The session this run created is the session it ended: nothing of it is left behind. ---------------
    const ended = await page.evaluate(async (target) => (await fetch(target + "/api/web-logout", { method: "DELETE" })).status, origin);
    check(ended === 200, "the run's own session ends cleanly (" + ended + ")");
    check(pageErrors.length === 0, "no page error occurred during the journey" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
  } finally {
    await browser.close();
  }

  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.log("  FAIL " + (error instanceof Error ? error.message : String(error)));
  failures.push(String(error));
  exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  if (!keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("kept: " + artifacts);
}

console.log(failures.length === 0 ? "web logout contract: PASS" : "web logout contract: " + failures.length + " failure(s)");
for (const failure of failures) console.log("  - " + failure);
process.exit(exitCode);
