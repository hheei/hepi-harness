/**
 * The browser's file surface, through the **client ingress**, in a real browser.
 *
 * This is the entry a Web page or an App really reaches, so this is where the browser's own addresses have to work: the
 * explorer's XHR multipart upload, the viewer's `<img src>` read, the download link's own navigation, and the range
 * request a media element makes. The unit and ingress suites assert each layer; what only a browser can show is that
 * the surface answers the requests a browser actually makes — a form body it produces itself, an image element that
 * decodes, a download that lands under its own name.
 *
 * The Next entry is not part of this: ticket 05 moved the shared workbench to a Vite static build, and the browser
 * components' own rendering is asserted by `ux-workbench-scope.mjs`. What is under test here is the surface those
 * components call.
 *
 * Usage: node apps/web/e2e/files-transfer.mjs [--keep]
 *        HEPI_UXFILES_BACKEND_PORT=<port> HEPI_UXFILES_GATEWAY_PORT=<port> HEPI_UXFILES_INGRESS_PORT=<port>
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as probeServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const token = "ux-files-transfer-token";
const login = "ux-files-transfer-login";
const keep = process.argv.includes("--keep");

const artifacts = mkdtempSync(join(tmpdir(), "hepi-ux-files-"));
const dataDir = join(artifacts, "data");
const workspaceRoot = join(artifacts, "workspace");
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(workspaceRoot, "sub"), { recursive: true });
console.log("Artifacts: " + artifacts);
const childrenLog = createWriteStream(join(artifacts, "children.log"), { flags: "a" });

/** A PNG the browser has to decode: 2x2, one colour, real chunks. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7r6j4AAAAASUVORK5CYII=", "base64");
const PNG_BASE64 = PNG.toString("base64");
/** Past the 1 MiB JSON request the workbench proxy carries, so the byte route is the only way it can arrive. */
const LARGE_BYTES = 1400013;
const large = Buffer.alloc(LARGE_BYTES, 7);

const failures = [];
function check(condition, message) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
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
      if (response.status < 500) return true;
    } catch { /* not up yet */ }
    await delay(200);
  }
  return false;
}

/** Both child roles run from an allowlist, so no ambient HEPI_/PI_ value reaches them. */
function childEnv(home, extra) {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), ...extra };
}

const children = [];
function capture(child) {
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { chunks.push(chunk.toString()); childrenLog.write(chunk); });
  return () => chunks.join("");
}

try {
  const gatewayPort = await freePort(Number(process.env.HEPI_UXFILES_GATEWAY_PORT ?? 0));
  const gateway = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "gateway-home"), {
      HEPI_GATEWAY_PORT: String(gatewayPort),
      HEPI_GATEWAY_TOKEN: token,
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_DATA: dataDir,
      HEPI_WORKSPACE_ID: "local",
      HEPI_WORKSPACE_ROOT: workspaceRoot,
      HEPI_ALLOWED_COMMANDS: "bash",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(gateway);
  const gatewayLog = capture(gateway);
  const gatewayOrigin = "http://127.0.0.1:" + gatewayPort;
  assert.ok(await waitForHttp(gatewayOrigin + "/v1/files", {}, 45_000), "the gateway started: " + gatewayLog().slice(-500));

  const backendPort = await freePort(Number(process.env.HEPI_UXFILES_BACKEND_PORT ?? 0));
  const backend = spawn(process.execPath, [join(repoRoot, "apps", "server", "src", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "backend-home"), {
      PORT: String(backendPort),
      HEPI_BIND_HOST: "127.0.0.1",
      HEPI_AUTH_TOKEN: token,
      HEPI_DB: join(dataDir, "conversations.sqlite"),
      HEPI_SKILL_REPOSITORY: join(dataDir, "skill-repository.sqlite"),
      HEPI_PROJECTS: join(dataDir, "projects.sqlite"),
      HEPI_DEVICE_CREDENTIALS: join(dataDir, "device-credentials.sqlite"),
      HEPI_WORKSPACE_ID: "local",
      HEPI_GATEWAY_ID: "workstation",
      HEPI_GATEWAY_URL: gatewayOrigin,
      HEPI_GATEWAY_TOKEN: token,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(backend);
  const backendLog = capture(backend);
  const backendOrigin = "http://127.0.0.1:" + backendPort;
  assert.ok(await waitForHttp(backendOrigin + "/api/workspaces", { authorization: "Bearer " + token }, 45_000), "the backend started: " + backendLog().slice(-500));

  // The client ingress is the entry this surface really has: a Web cookie or an App bearer, and nothing else.
  const ingressPort = await freePort(Number(process.env.HEPI_UXFILES_INGRESS_PORT ?? 0));
  const ingress = spawn(process.execPath, [join(repoRoot, "packages", "gateway", "src", "ingress", "main.ts")], {
    cwd: repoRoot,
    env: childEnv(join(artifacts, "ingress-home"), {
      HEPI_INGRESS_BACKEND: backendOrigin,
      HEPI_INGRESS_SERVICE_TOKEN: token,
      HEPI_WEB_LOGIN_TOKEN: login,
      HEPI_INGRESS_DEFAULT_HOST: "workstation",
      HEPI_INGRESS_HOST: "127.0.0.1",
      HEPI_INGRESS_PORT: String(ingressPort),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(ingress);
  const ingressLog = capture(ingress);
  const origin = "http://127.0.0.1:" + ingressPort;
  assert.ok(await waitForHttp(origin + "/api/web-auth", {}, 45_000), "the ingress started: " + ingressLog().slice(-500));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    // A page on the ingress origin, so every request below is same-origin with the cookie the browser holds.
    await page.goto(origin + "/api/web-auth", { waitUntil: "domcontentloaded" });
    const enabled = JSON.parse(await page.evaluate(() => document.body.innerText));
    check(enabled.enabled === true, "the page reads the deployment's login state");

    // The Web session, as the page's own login sets it: one same-origin POST, and the cookie the browser then attaches.
    const loggedIn = await page.evaluate(async ({ origin, login }) => (await fetch(origin + "/api/web-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: login }) })).status, { origin, login });
    check(loggedIn === 200, "the page's login set the session cookie (" + loggedIn + ")");

    // --- 1. The explorer's own upload: an XHR form the browser builds, exactly as the copied control sends it. ----
    const uploaded = await page.evaluate(async ({ origin, bytes, png }) => {
      const form = new FormData();
      form.append("files", new File([new Uint8Array(bytes).fill(7)], "big.bin"));
      form.append("files", new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], "logo.png", { type: "image/png" }));
      return await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", origin + "/api/files/workspace/local/sub?type=upload&conflict=error");
        xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
        xhr.onerror = () => resolve({ status: 0, body: "network error" });
        xhr.send(form);
      });
    }, { origin, bytes: LARGE_BYTES, png: PNG_BASE64 });
    check(uploaded.status === 200, "the browser's own multipart upload was accepted (" + uploaded.status + ")");
    check(uploaded.body === JSON.stringify({ uploaded: ["big.bin", "logo.png"], skipped: [], errors: [] }), "and answered the shape the explorer reads: " + uploaded.body);
    const landed = (name) => join(workspaceRoot, "sub", name);
    check(existsSync(landed("big.bin")) && Buffer.compare(readFileSync(landed("big.bin")), large) === 0, "the large file landed byte for byte, past the JSON request limit");
    check(existsSync(landed("logo.png")) && Buffer.compare(readFileSync(landed("logo.png")), PNG) === 0, "the image landed byte for byte");

    // --- 2. The pre-flight check and the conflict answer, as the explorer asks for them. ------------------------
    const checked = await page.evaluate(async ({ origin }) => {
      const response = await fetch(origin + "/api/files/workspace/local/sub?type=upload-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileNames: ["big.bin", "free.txt"] }) });
      return { status: response.status, body: await response.json() };
    }, { origin });
    check(checked.status === 200 && JSON.stringify(checked.body.conflicts) === JSON.stringify(["big.bin"]), "the pre-flight check names the file that exists: " + JSON.stringify(checked.body));

    const conflicted = await page.evaluate(async ({ origin, png }) => {
      const form = new FormData();
      form.append("files", new File([Uint8Array.from(atob(png), (character) => character.charCodeAt(0))], "logo.png", { type: "image/png" }));
      const response = await fetch(origin + "/api/files/workspace/local/sub?type=upload&conflict=error", { method: "POST", body: form });
      return { status: response.status, body: await response.json() };
    }, { origin, png: PNG_BASE64 });
    check(conflicted.status === 409 && JSON.stringify(conflicted.body.conflicts) === JSON.stringify(["logo.png"]), "the conflict is refused with the names that exist (" + conflicted.status + ")");
    check(Buffer.compare(readFileSync(landed("logo.png")), PNG) === 0, "the refused upload left the existing file alone");

    // --- 3. The viewer: an <img> the browser decodes from the read address, and a range request it makes itself. --
    const rendered = await page.evaluate(async ({ origin }) => {
      const image = new Image();
      image.src = origin + "/api/files/workspace/local/sub/logo.png?type=read";
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    }, { origin });
    check(rendered.width === 2 && rendered.height === 2, "the browser decoded the image the upload wrote (" + rendered.width + "x" + rendered.height + ")");

    // A range is a byte request: the download address is the file's own bytes, and the host's reader answers the window.
    const ranged = await page.evaluate(async ({ origin }) => {
      const response = await fetch(origin + "/api/files/workspace/local/sub/big.bin?type=download", { headers: { range: "bytes=1048570-1048580" } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, range: response.headers.get("content-range"), length: bytes.length, first: bytes[0] };
    }, { origin });
    check(ranged.status === 206, "a range request is answered as one: " + ranged.status);
    check((ranged.range ?? "").endsWith("/" + LARGE_BYTES), "with the file's own size: " + ranged.range);
    check(ranged.length === 11 && ranged.first === 7, "and the window's own bytes (" + ranged.length + " bytes)");

    // --- 4. The download link: a browser navigation that lands the file under its own name. ---------------------
    const download = await Promise.all([
      page.waitForEvent("download"),
      page.evaluate(({ origin }) => {
        const link = document.createElement("a");
        link.href = origin + "/api/files/workspace/local/sub/big.bin?type=download";
        link.download = "big.bin";
        document.body.appendChild(link);
        link.click();
      }, { origin }),
    ]).then(([event]) => event);
    const savedPath = join(artifacts, "downloaded.bin");
    await download.saveAs(savedPath);
    check(download.suggestedFilename() === "big.bin", "the download carries its own name: " + download.suggestedFilename());
    check(Buffer.compare(readFileSync(savedPath), large) === 0, "and the browser saved the whole file (" + readFileSync(savedPath).byteLength + " bytes)");

    // --- 5. The capabilities that do not exist say so, in the browser. -----------------------------------------
    const absent = await page.evaluate(async ({ origin }) => {
      const watch = await fetch(origin + "/api/files/workspace/local/sub/big.bin?type=watch");
      return { status: watch.status, body: await watch.json() };
    }, { origin });
    check(absent.status === 501 && absent.body.code === "unsupported", "live file watch answers a named 501 (" + absent.status + " " + absent.body.code + ")");

    check(pageErrors.length === 0, "the page raised no error while uploading, rendering and downloading: " + JSON.stringify(pageErrors));
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.log("\nFAILURES:");
    for (const failure of failures) console.log("  - " + failure);
    process.exitCode = 1;
  } else {
    console.log("\nFILES TRANSFER UI PASSED");
  }
} finally {
  for (const child of children) child.kill("SIGTERM");
  await delay(200);
  if (!keep) rmSync(artifacts, { recursive: true, force: true });
  else console.log("kept: " + artifacts);
}
