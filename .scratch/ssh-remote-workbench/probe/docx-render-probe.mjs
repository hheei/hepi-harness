/**
 * Probe: does the declared mammoth dependency parse a workspace docx's text inside the browser this project ships?
 *
 * Ticket 05 renders a .docx from the bytes the file surface already serves, so the question the implementation rests
 * on is whether mammoth survives esbuild's browser-field mapping (its Node unzip and file readers are replaced by
 * browser ones) and runs with no Node global. This bundles a module that imports mammoth, fetches a document's bytes
 * and reports both answers in chromium, then states what the ticket concluded from them.
 *
 * Usage: node .scratch/ssh-remote-workbench/probe/docx-render-probe.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDocx } from "./make-docx.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const { chromium } = await import("file://" + join(repoRoot, "apps/web/node_modules/playwright/index.mjs"));
const { build } = await import("file://" + join(repoRoot, "apps/web/node_modules/esbuild/lib/main.js"));
const uiRoot = join(repoRoot, "packages/ui");

const NL = String.fromCharCode(10);
const buildDir = await mkdtemp(join(tmpdir(), "hepi-docx-probe-"));
const source = join(buildDir, "entry.js");
await writeFile(source, [
  'const mammoth = (await import("mammoth")).default;',
  'const answer = { loaded: typeof mammoth?.extractRawText === "function" };',
  'try {',
  '  const bytes = await (await fetch("/docx/report.docx")).arrayBuffer();',
  '  answer.bytes = bytes.byteLength;',
  '  answer.text = (await mammoth.extractRawText({ arrayBuffer: bytes })).value;',
  '  answer.html = (await mammoth.convertToHtml({ arrayBuffer: bytes })).value;',
  '} catch (error) { answer.error = String(error && error.message ? error.message : error); }',
  'document.title = JSON.stringify(answer);',
].join(NL));
await build({
  stdin: { contents: await readFile(source, "utf8"), resolveDir: uiRoot, sourcefile: "probe-entry.js", loader: "js" },
  bundle: true, format: "esm", outfile: source, absWorkingDir: uiRoot, logLevel: "warning",
});

const LESS = String.fromCharCode(60);
const DOCX = makeDocx(["hello remote docx", LESS + "script>window.__pwned = 1" + LESS + "/script> they say"]);
const server = createServer(async (request, response) => {
  const path = (request.url ?? "/").split("?")[0];
  if (path === "/docx/report.docx") { response.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "content-length": String(DOCX.length) }); response.end(DOCX); return; }
  if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><html><body><script type=module src=/entry.js></script></body></html>"); return; }
  if (path !== "/entry.js") { response.writeHead(404).end("nope"); return; }
  response.writeHead(200, { "content-type": "text/javascript" });
  response.end(await readFile(source));
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  await page.goto(origin);
  await page.waitForFunction("document.title.startsWith('{')", null, { timeout: 30000 });
  console.log("ANSWER=" + (await page.title()));
  console.log("PWNED=" + String(await page.evaluate("window.__pwned ?? 'unset'")));
  console.log("PAGE_ERRORS=" + JSON.stringify(pageErrors));
  console.log("BUNDLE_BYTES=" + (await readFile(source)).length);
} finally {
  await browser.close();
  await new Promise((closed) => server.close(closed));
  await rm(buildDir, { recursive: true, force: true });
}
