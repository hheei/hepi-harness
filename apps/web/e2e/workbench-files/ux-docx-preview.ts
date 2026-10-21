/**
 * A workspace Word document, read by a real browser.
 *
 * The gateway suites pin the transport: a docx is served as its own bytes, alike on a local and an SSH workspace
 * (`ingress-ssh-workbench.test.ts`), and the surface routes it to the byte route rather than a text preview
 * (`files-surface.test.ts`). What only a mounted page can show is the other half of ticket 05 — that the declared
 * `mammoth` dependency actually runs in this browser, that its text reaches the screen through both connection kinds a
 * person can have (a Web page's cookie, an App's device bearer), that a document's own markup arrives as words and never
 * executes, and that a document past the preview bound is refused **before its bytes are asked for**. That last one is
 * measured here as a request count, not as a sentence in the page.
 *
 * Usage: node apps/web/e2e/workbench-files/ux-docx-preview.ts [--keep]
 *        HEPI_DOCX_PREVIEW_PORT=<port>
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { makeDocx } from "../../../../packages/gateway/test/docx-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..", "..");
const keep = process.argv.includes("--keep");
const port = Number(process.env.HEPI_DOCX_PREVIEW_PORT ?? 43133);
const bearer = "ux-docx-bearer";
const cookiePair = "hepi-docx-session=viewer";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MEGABYTE = 1024 * 1024;
/** Must match DOCX_PREVIEW_MAX_BYTES; the page's bound is the protocol's, this fixture's sizes are chosen around it. */
const PREVIEW_LIMIT_BYTES = 10 * MEGABYTE;

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

/**
 * The documents the page is pointed at. The first is the interesting one: it carries a `<script>` inside a paragraph,
 * because the honest claim about rendering a file from another machine is that its markup cannot run here — and that is
 * only a measurement if something in the fixture tries to.
 */
const DOCX = makeDocx(["hello from the remote workspace", "<script>window.__pwned = 1</script> they say", "Q&A and a paragraph"]);
const BLANK = makeDocx(["   ", "  "]);
/** Past the bound: never fetched, so its real size is what the meta answer states. */
const BIG_SIZE = PREVIEW_LIMIT_BYTES + 1;

const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-docx-preview-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-docx-preview.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>docx preview</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-docx-preview.fixture.js\"></script>",
  "</body></html>",
].join("\n");

/** One file request the page made, with the credential it presented and the workspace it named. */
interface FileRequest {
  readonly url: string;
  readonly workspace: string;
  readonly authorization: string | null;
  readonly cookie: string | null;
}

/** Every file request the page made, with the credential it presented. */
const requests: FileRequest[] = [];
/** The routing workspace one request is about, read off the address the seam built. */
const workspaceOf = (url: string) => (decodeURIComponent(url).match(/\/workspace\/([a-z]+)/) ?? [])[1] ?? "";
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const path = url.split("?")[0];
  if (path === "/" || path === "/index.html") {
    response.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store", "set-cookie": cookiePair + "; Path=/" });
    response.end(indexHtml);
    return;
  }
  if (path.startsWith("/api/files/")) {
    const credential = { url, workspace: workspaceOf(url), authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null };
    requests.push(credential);
    // A bearer connection presents its token; a cookie connection lets the browser attach the session. Either way a
    // request that presents nothing is the bug this file exists to keep out.
    const authenticated = credential.authorization === "Bearer " + bearer || (credential.cookie ?? "").includes("hepi-docx-session=");
    if (!authenticated) { response.writeHead(401, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "unauthorized" })); return; }
    const workspace = credential.workspace;
    const bytes = workspace === "docx" ? DOCX : workspace === "blank" ? BLANK : Buffer.alloc(BIG_SIZE, 7);
    if (url.includes("type=meta")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ size: bytes.length, language: null, mime: DOCX_MIME, previewKind: "docx" }));
      return;
    }
    response.writeHead(200, { "content-type": DOCX_MIME, "content-length": String(bytes.length) });
    response.end(bytes);
    return;
  }
  const name = path.replace(/^\//, "");
  const type = name.includes("/") || name.includes("..") ? undefined : contentTypes[extname(name)];
  if (!type) { response.writeHead(404).end("not found"); return; }
  readFile(join(buildDir, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise<void>((ready, failed) => { server.once("error", failed); server.listen(port, "127.0.0.1", ready); });
const origin = "http://127.0.0.1:" + port;

const browser = await chromium.launch({ headless: true });
// The sections this driver reads, as the fixture mounts them: each one's own text and the elements it must not hold.
interface ViewerFacts {
  readonly name: string;
  readonly text: string;
  readonly paragraphs: number;
  readonly frames: number;
  readonly scripts: number;
}
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  await page.goto(origin);

  // Every wait is an observable: the document's own words, which exist only once the bytes arrived, the reader ran in
  // this browser, and the result was mounted.
  await page.waitForSelector("#viewer-cookie >> text=hello from the remote workspace", { timeout: 30_000 });
  await page.waitForSelector("#viewer-bearer >> text=hello from the remote workspace", { timeout: 30_000 });
  await page.waitForSelector("#viewer-empty >> text=no text", { timeout: 30_000 });
  await page.waitForSelector("#viewer-oversize >> text=larger than", { timeout: 30_000 });

  const viewers = await page.evaluate((): ViewerFacts[] => ["cookie", "bearer", "oversize", "empty"].map((name) => {
    const section = document.getElementById("viewer-" + name);
    return {
      name,
      text: section?.textContent ?? "",
      paragraphs: (section?.querySelectorAll("p") ?? []).length,
      frames: (section?.querySelectorAll("iframe, frame, object, embed") ?? []).length,
      scripts: (section?.querySelectorAll("script") ?? []).length,
    };
  }));
  const byName = Object.fromEntries(viewers.map((viewer) => [viewer.name, viewer]));

  // 1. A document's text arrives on a cookie connection, and the byte route (not a text preview) is what carried it.
  check(/hello from the remote workspace/.test(byName.cookie.text) && /Q&A and a paragraph/.test(byName.cookie.text), "the cookie viewer shows the document's own paragraphs: " + byName.cookie.text.slice(0, 200));
  check(byName.cookie.paragraphs === 3, "the document's three paragraphs did not reach the page as three blocks: " + byName.cookie.paragraphs);
  const docRequests = requests.filter((entry) => entry.workspace === "docx");
  check(docRequests.some((entry) => entry.url.includes("type=read")), "the document was fetched as bytes, not previewed as text: " + JSON.stringify(docRequests.map((entry) => entry.url)));

  // 2. The App's connection reads the same document through its bearer, because an element of a bundle cannot present it,
  //    and it reads it **once**: the viewer already holds the bytes its connection leased, so a second fetch would put the
  //    same remote document on the wire twice and keep two leases for one screen.
  check(/hello from the remote workspace/.test(byName.bearer.text), "the bearer viewer shows the same text: " + byName.bearer.text.slice(0, 200));
  const bearerReads = docRequests.filter((entry) => entry.authorization === "Bearer " + bearer && entry.url.includes("type=read"));
  const cookieReads = docRequests.filter((entry) => entry.authorization === null && entry.url.includes("type=read"));
  check(bearerReads.length === 1, "the App connection did not read the document exactly once: " + JSON.stringify(docRequests.map((entry) => [entry.url, entry.authorization === null ? "cookie" : "bearer"])));
  check(cookieReads.length === 1, "the cookie connection did not read the document exactly once: " + JSON.stringify(cookieReads));

  // 3. Nothing went out without a credential, and each request presented the one its own connection holds.
  check(requests.length > 0 && requests.every((entry) => entry.authorization === "Bearer " + bearer || (entry.cookie ?? "").includes("hepi-docx-session=")), "every file request carried its connection's credential: " + JSON.stringify(requests.filter((entry) => entry.authorization !== "Bearer " + bearer)));
  const unauthorised = requests.filter((entry) => !entry.url.includes("401") && entry.authorization === null && !(entry.cookie ?? "").includes("hepi-docx-session="));
  check(unauthorised.length === 0, "a request was made with nothing to present: " + JSON.stringify(unauthorised));

  // 4. The document's markup is words. The paragraph containing a script tag must read as text, no frame may exist to
  //    host it in, and the assignment inside it must not have run.
  check(/<script>window.__pwned = 1<\/script>/.test(byName.cookie.text), "the document's own markup is shown as text: " + byName.cookie.text.slice(0, 260));
  check(byName.cookie.frames === 0 && byName.cookie.scripts === 0, "a docx preview put content in a frame or script tag: " + JSON.stringify({ frames: byName.cookie.frames, scripts: byName.cookie.scripts }));
  const pwned = String(await page.evaluate("window.__pwned ?? 'unset'"));
  check(pwned === "unset", "a document's script ran on this page: window.__pwned = " + pwned);

  // 5. Past the bound: the refusal is stated, and the document's bytes were never asked for. This is the assertion that
  //    makes "bounded" a property of the client rather than a sentence about it.
  check(/larger than/.test(byName.oversize.text) && /download/i.test(byName.oversize.text), "the over-bound document states its bound and the alternative: " + byName.oversize.text.slice(0, 200));
  const bigRequests = requests.filter((entry) => entry.workspace === "big" && !entry.url.includes("type=meta"));
  check(bigRequests.length === 0, "a document past the bound was fetched anyway: " + JSON.stringify(bigRequests));

  // 6. A document with nothing to say says that, rather than showing a blank frame a reader has to interpret.
  check(/no text/i.test(byName.empty.text), "an empty document states that it holds no text: " + byName.empty.text.slice(0, 200));

  check(pageErrors.length === 0, "the page raised no error" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));

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
  await new Promise((closed) => server.close(closed));
}
