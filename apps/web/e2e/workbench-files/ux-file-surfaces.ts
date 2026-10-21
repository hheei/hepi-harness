/**
 * The file surfaces a user sees, under an App's credential, in a real browser.
 *
 * The gateway's ingress suite and the seam's own unit tests drive the routes; what only a mounted component shows is
 * whether the page's own elements carry the credential. A packaged App is a bundle on `tauri://localhost` with a device
 * bearer and no cookie jar, so an element pointed at a relative `/api/files/…` is a request the Gateway answers `401`
 * for — and the markdown body's local image and the viewer's own image are the two places that used to build one. The
 * server here answers only a request that carries the bearer and records the ones that do not, so "the surface shows
 * the file" and "no request went out without the credential" are the same measurement.
 *
 * Usage: node apps/web/e2e/workbench-files/ux-file-surfaces.ts [--keep]
 *        HEPI_FILE_SURFACES_PORT=<port>
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_FILE_SURFACES_PORT ?? 43131);
const bearer = "ux-file-surfaces-bearer";

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

/** A PNG the browser has to decode: 2x2, one colour, real chunks. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7r6j4AAAAASUVORK5CYII=", "base64");

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-file-surfaces-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-file-surfaces.fixture.tsx")],
  outdir: buildDir,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  tsconfig: join(webRoot, "tsconfig.json"),
  define: { "process.env.NODE_ENV": "\"production\"" },
  logLevel: "warning",
});

const indexHtml = [
  "<!doctype html>",
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>file surfaces</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-file-surfaces.fixture.js\"></script>",
  "</body></html>",
].join("\n");

/** One file request the page made, with the credential it presented. */
interface FileRequest {
  readonly url: string;
  readonly authorization: string | null;
}

/** Every file request the page made, with the credential it presented. */
const requests: FileRequest[] = [];
const server = createServer(async (request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.replace(/^\//, "");
  if (name === "index.html") { response.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store" }); response.end(indexHtml); return; }
  if (path.startsWith("/api/files/")) {
    requests.push({ url: request.url ?? path, authorization: request.headers.authorization ?? null });
    // The App's credential is a header and nothing else: a request without it is the 401 this test exists for.
    if (request.headers.authorization !== "Bearer " + bearer) {
      response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    if ((request.url ?? "").includes("type=meta")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ size: PNG.length, language: "text", mime: "image/png", previewKind: null }));
      return;
    }
    response.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
    response.end(PNG);
    return;
  }
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.waitForTimeout(1500);

  const dom = await page.evaluate(() => Object.fromEntries(["message", "viewer"].map((id) => {
    const section = document.getElementById(id);
    const image = section?.querySelector("img");
    // The download control states its own limit in a title, which is the only place a disabled control can say it.
    const download = section?.querySelector("[role=\"img\"]");
    return [id, {
      text: section?.textContent ?? "",
      src: image?.getAttribute("src") ?? null,
      width: image?.naturalWidth ?? 0,
      downloadTitle: download?.getAttribute("title") ?? download?.getAttribute("aria-label") ?? null,
    }];
  })));

  check(pageErrors.length === 0, "the page raised no error" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
  check(requests.length > 0, "the surfaces asked the connection for their files");
  const unauthenticated = requests.filter((entry) => entry.authorization === null);
  check(unauthenticated.length === 0, "no file request went out without the credential" + (unauthenticated.length ? ": " + JSON.stringify(unauthenticated) : ""));
  check(requests.every((entry) => entry.authorization === "Bearer " + bearer), "every file request presented the connection's bearer");

  // A markdown body's local image is a file of this workspace: on a bearer connection it is read into a lease, so the
  // element points at the lease and not at a path the shell cannot authenticate.
  check(dom.message.width === 2, "the markdown body's local image decoded (" + dom.message.width + "px)");
  check((dom.message.src ?? "").startsWith("blob:"), "the markdown body's image is the connection's own lease (" + dom.message.src + ")");

  // The viewer's image is the same decision, made once by the connection rather than by the viewer.
  check(dom.viewer.width === 2, "the viewer's image decoded (" + dom.viewer.width + "px)");
  check((dom.viewer.src ?? "").startsWith("blob:"), "the viewer's image is the connection's own lease (" + dom.viewer.src + ")");
  check(requests.some((entry) => entry.url.includes("type=meta")), "the viewer asked for the file's own metadata");

  // Saving a file on this host has no element address at all: the control states the capability the shell would need
  // instead of navigating to a 401. A host that states no save host is a page with neither path.
  check(/native save/.test(dom.viewer.downloadTitle ?? ""), "the save control names the missing native save (" + dom.viewer.downloadTitle + ")");

  // And a host that states one — the App's shell — saves the file through it: the control is a button, the bytes come
  // from the connection under the bearer, and what crosses to the shell is bounded slices rather than a page blob.
  /** The save host's own record, as the fixture publishes it on the page: what crossed to the shell and whether it ended. */
  interface SaveRecord {
    readonly largest: number;
    readonly bytes: number;
    readonly path: string;
    readonly finished: boolean;
    readonly aborted: boolean;
  }
  const native = await page.evaluate(async (): Promise<{ clicked: boolean; record: SaveRecord | null }> => {
    const button = document.querySelector<HTMLButtonElement>("#native-save button");
    if (button === null) return { clicked: false, record: null };
    button.click();
    const record = (globalThis as { __HEPI_SAVED__?: SaveRecord }).__HEPI_SAVED__ ?? null;
    const deadline = Date.now() + 5000;
    while (record !== null && !record.finished && !record.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { clicked: true, record };
  });
  check(native.clicked === true && native.record !== null, "the App host's control is a save button, not an anchor");
  check(native.record?.finished === true && native.record.aborted === false, "the save finished rather than being abandoned");
  check(native.record?.bytes === PNG.length, "the shell was handed the whole file (" + (native.record?.bytes ?? 0) + " of " + PNG.length + " bytes)");
  check((native.record?.largest ?? Number.POSITIVE_INFINITY) <= 1024 * 1024, "no slice crossed the bound (" + (native.record?.largest ?? 0) + " bytes)");
  check((native.record?.path ?? "").endsWith("logo.png"), "the destination was the file's own name (" + (native.record?.path ?? "none") + ")");
  const downloadRequests = requests.filter((entry) => entry.url.includes("type=download"));
  check(downloadRequests.length === 1, "the save read the file once through the connection (" + downloadRequests.length + ")");
  check(downloadRequests.every((entry) => entry.authorization === "Bearer " + bearer), "and presented the connection's bearer");

  // The explorer's row hides its save control until the row is hovered. Hiding it must not own the transfer: a pointer
  // that leaves the row while a save is still running is the ordinary case, and it must not delete what was written.
  const row = page.locator("#explorer-row [title]").first();
  await row.hover();
  const visibleBeforeSave = await page.locator("#explorer-row button").isVisible();
  check(visibleBeforeSave === true, "hovering the row reveals its save control");
  await page.locator("#explorer-row button").click();
  // Move the pointer off the row while the host is still writing. The save host waits per slice, so this lands mid-save.
  await page.mouse.move(0, 0);
  const rowGoneWhileSaving = await page.evaluate(() => {
    const record = (globalThis as {
      __HEPI_ROW_SAVED__?: { readonly finished: boolean; readonly aborted: boolean };
    }).__HEPI_ROW_SAVED__;
    return record !== undefined && record.finished === false && record.aborted === false;
  });
  check(rowGoneWhileSaving === true, "the save was still running when the pointer left the row");
  const hiddenWhileSaving = await page.locator("#explorer-row button").isVisible();
  check(hiddenWhileSaving === false, "the control is hidden once the pointer leaves the row");
  const rowSave = await page.evaluate(async () => {
    const record = (globalThis as {
      __HEPI_ROW_SAVED__?: { readonly bytes: number; readonly finished: boolean; readonly aborted: boolean };
    }).__HEPI_ROW_SAVED__;
    const deadline = Date.now() + 8000;
    while (record !== undefined && !record.finished && !record.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return record === undefined ? null : { ...record };
  });
  check(rowSave !== null, "the row's save was recorded");
  check(rowSave !== null && rowSave.aborted === false, "leaving the row did not abort the save");
  check(rowSave !== null && rowSave.finished === true, "the save finished after the pointer left the row");
  check(rowSave !== null && rowSave.bytes === PNG.length, "the whole file reached the shell (" + (rowSave?.bytes ?? 0) + " of " + PNG.length + " bytes)");
  // And the control comes back when the row is hovered again, so hiding it did not leave the row without one.
  await row.hover();
  const visibleAgain = await page.locator("#explorer-row button").isVisible();
  check(visibleAgain === true, "hovering the row again reveals the control it kept");

  if (failures.length > 0) {
    console.log("\n" + failures.length + " check(s) failed");
    if (keep) console.log("Artifacts kept: " + buildDir);
    process.exitCode = 1;
  } else {
    console.log("\nall checks passed");
    if (!keep) await rm(buildDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
