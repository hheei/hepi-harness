/**
 * What a person reads when a file surface fails, in a browser.
 *
 * The ingress suites pin each refusal cause to its status and code (`ingress-ssh-workbench.test.ts`,
 * `files-surface.test.ts`); what only a mounted page can show is whether those answers become words a person can act
 * on. Two failures this journey exists for were both invisible in HTTP bodies alone: the changed-files panel cleared
 * itself to an empty list when the host refused, so "nothing could be asked" read as "nothing changed"; and every
 * failed read was worded as a capability the deployment never had, so a person was told their gateway cannot browse
 * files at the moment its gateway merely went quiet.
 *
 * Four workspaces, four answers, mounted side by side in the real `FileExplorer` and `FileViewer`: one that serves,
 * one whose read failed, one whose host could not be reached, and one composed without a workbench. The page's own
 * server is the Backend stand-in and answers by the routing workspace each request names.
 *
 * Two more `FileViewer` cases are the file's own lifetime and its own bound: a read that answered `404 not_found`
 * (a file deleted after the listing was read), and a preview that is one bounded chunk of a larger file. Neither is
 * visible in an HTTP body alone — a truncation flag says nothing about whether the person is shown the bytes they
 * actually hold, and a status code says nothing about whether the panel gives them a way out.
 *
 * Usage: node apps/web/e2e/workbench-files/ux-file-failures.ts [--keep]
 *        HEPI_FILE_FAILURES_PORT=<port>
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
const port = Number(process.env.HEPI_FILE_FAILURES_PORT ?? 43132);

const failures: string[] = [];
function check(condition: boolean, message: string) {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}

/**
 * The four answers one file surface can give, in the bodies the real surface writes. Each is the status and code
 * `packages/gateway/src/files-surface.ts` produces for that cause, so the page is reading the contract as it is now,
 * not as a stand-in invented for this test.
 */
const ANSWERS = {
  ok: { status: 200, body: { entries: [{ name: "notes.md", isDir: false, size: 8, modified: "" }], path: "/workspace/ok" } },
  failed: { status: 500, body: { ok: false, code: "operation_failed", error: "the host could not answer for a file listing" } },
  offline: { status: 503, body: { ok: false, code: "gateway_offline", error: "the host serving this workspace could not be reached for a file listing" } },
  absent: { status: 501, body: { ok: false, code: "not_supported", error: "this host is composed without a workbench, so it serves no a file listing" } },
};
const CHANGES = {
  ok: { status: 200, body: { isGitRepository: true, repositoryRoot: "/workspace/ok", files: [{ filePath: "/workspace/ok/src/app.ts", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }], additions: 0, deletions: 0 } },
  failed: { status: 500, body: { ok: false, code: "operation_failed", error: "the host could not answer for changed files" } },
  offline: { status: 503, body: { ok: false, code: "gateway_offline", error: "the host serving this workspace could not be reached for changed files" } },
  absent: { status: 501, body: { ok: false, code: "not_supported", error: "this host is composed without a workbench, so it serves no changed files" } },
};
const PREVIEW = {
  failed: { status: 500, body: { ok: false, code: "operation_failed", error: "the host could not answer for a file preview" } },
  // A file the host says is not there: the workbench's own name for it, as files-surface answers it — 404 and
  // `not_found`, stated without the host's own path.
  missing: { status: 404, body: { ok: false, code: "not_found", error: "the host has no such path, so it cannot answer for a file preview" } },
  // One bounded chunk of a bigger file, carrying the host's own two numbers: 200 KiB shown of a 3 MiB file.
  truncated: { status: 200, body: { content: "# notes\n", language: "markdown", shownBytes: 200 * 1024, size: 3 * 1024 * 1024, truncated: true, previewOnly: true } },
};

/** One API request the page made, with the routing workspace it named. */
interface SeenRequest {
  readonly url: string;
  readonly workspace: string;
}

const seen: SeenRequest[] = [];
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const buildDir = await mkdtemp(join(tmpdir(), "hepi-file-failures-"));
const { build } = await import("esbuild");
await build({
  entryPoints: [join(here, "ux-file-failures.fixture.tsx")],
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
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>file failures</title></head>",
  "<body><div id=\"root\"></div>",
  "<script type=\"module\" src=\"./ux-file-failures.fixture.js\"></script>",
  "</body></html>",
].join("\n");

// The browser sends a routing cwd as a query parameter, so it is percent-encoded there and decoded here.
const workspaceOf = (url: string) => (decodeURIComponent(url).match(/\/workspace\/([a-z]+)/) ?? [])[1] ?? "";
/** One answer this stand-in gives: the status and the body the real surface writes for that cause. */
interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  const path = url.split("?")[0];
  if (path === "/" || path === "/index.html") { response.writeHead(200, { "content-type": contentTypes[".html"], "cache-control": "no-store" }); response.end(indexHtml); return; }
  if (path.startsWith("/api/")) {
    const workspace = workspaceOf(url);
    seen.push({ url, workspace });
    // The routing workspace decides which answer this stand-in gives; an unknown one reads as the served workspace.
    const answers: Record<string, Answer> = ANSWERS;
    const answer: Answer = path === "/api/git/status" ? ((CHANGES as Record<string, Answer>)[workspace] ?? ANSWERS.ok)
      : url.includes("type=read") ? ((PREVIEW as Record<string, Answer>)[workspace] ?? ANSWERS.ok)
      : (answers[workspace] ?? ANSWERS.ok);
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(JSON.stringify(answer.body));
    return;
  }
  const name = path.replace(/^\//, "");
  const type = name.includes("..") ? undefined : contentTypes[extname(name)];
  if (!type) { response.writeHead(404).end("not found"); return; }
  readFile(join(buildDir, name)).then(
    (body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); },
    () => { response.writeHead(404).end("not found"); },
  );
});
await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(port, "127.0.0.1", resolveListen); });
const origin = "http://127.0.0.1:" + port;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin);
  // Every wait is an observable: the served workspace's own entry, which only exists once the surface has answered.
  // The panel shows its changed files instead of the tree when the host reports any, so the served workspace's own
  // observable is its change row.
  await page.waitForSelector("#panel-ok >> text=app.ts", { timeout: 15_000 });

  const panels = await page.evaluate(() => ["ok", "failed", "offline", "absent"].map((name) => {
    const panel = document.getElementById("panel-" + name);
    return {
      name,
      alerts: [...(panel?.querySelectorAll("[role=\"alert\"]") ?? [])].map((node) => node.textContent?.trim() ?? ""),
      buttons: [...(panel?.querySelectorAll("button") ?? [])].map((node) => node.textContent?.trim() ?? ""),
      text: panel?.textContent ?? "",
    };
  }));
  const byName = Object.fromEntries(panels.map((panel) => [panel.name, panel]));

  check(seen.length > 0 && seen.every((entry) => entry.workspace !== ""), "each request named the workspace it asked about");

  // 1. The served workspace says what it serves, and no failure wording appears anywhere in it.
  check(/app\.ts/.test(byName.ok.text), "the served workspace names its own changed file: " + byName.ok.text.slice(0, 120));
  check(byName.ok.alerts.length === 0, "a workspace that answered shows no failure" + (byName.ok.alerts.length ? ": " + byName.ok.alerts.join(" | ") : ""));
  check(!/could not|without the workbench|not connected/.test(byName.ok.text), "the served workspace states no failure at all");

  // 2. A read that failed is said as a failure, in the panel's own words, with a way to ask again. Before this
  //    revision the changes panel was cleared to an empty list and said nothing at all.
  const failedAlerts = byName.failed.alerts.join(" | ");
  check(/could not answer/.test(failedAlerts), "a failed read is stated as a failure the host made: " + failedAlerts);
  check(/changed files/.test(failedAlerts), "and names which surface failed: " + failedAlerts);
  check(byName.failed.buttons.some((label) => /Retry/i.test(label)), "the panel offers to ask again: " + byName.failed.buttons.join(","));
  check(!/without the workbench/.test(failedAlerts), "a failed read was reported as a missing capability: " + failedAlerts);

  // 3. An unreachable host is named as unreachable — the spec's "offline state stays actionable" — and not as a
  //    deployment fact about what the gateway was composed to serve.
  const offlineAlerts = byName.offline.alerts.join(" | ");
  check(/could not be reached/.test(offlineAlerts), "an unreachable host is named as one: " + offlineAlerts);
  check(!/without the workbench/.test(offlineAlerts), "an offline host was reported as a missing capability: " + offlineAlerts);

  // 4. The absent capability keeps its own wording, so the three states are distinguishable on screen and not one
  //    message repeated. This is the only case where "composed without a workbench" is true.
  const absentAlerts = byName.absent.alerts.join(" | ");
  check(/composed without a workbench/.test(absentAlerts), "an absent capability is still named as one: " + absentAlerts);
  check(failedAlerts !== offlineAlerts && offlineAlerts !== absentAlerts, "the three causes are worded apart from each other");

  // 5. The viewer: the file it was pointed at failed, and says so, rather than rendering an empty document.
  const text = (id: string) => page.evaluate((name) => document.getElementById(name)?.textContent ?? "", id);
  const viewer = await text("viewer-failed");
  // The viewer states the cause in its own sentence rather than the surface's body, so the host's words and any path
  // inside them never become the screen's text; the cause it names is still the host's failure, not a capability claim.
  check(/The file could not be read: the host did not complete the read\./.test(viewer), "the viewer states the failed preview as its own failure: " + viewer.slice(0, 160));
  check(!/without the workbench/.test(viewer), "the viewer called a failed preview a missing capability: " + viewer.slice(0, 160));
  check(!/could not answer for a file preview/.test(viewer), "the viewer echoed the surface's raw body: " + viewer.slice(0, 160));

  // 6. A file deleted after the listing was read is stated as gone, and its next move is the folder the shell reloads —
  //    not the same read repeated. The surface's own 404 body is not on screen, so no host path is either.
  const missing = await page.evaluate(() => {
    const panel = document.getElementById("viewer-missing");
    return {
      text: panel?.textContent ?? "",
      kind: panel?.querySelector("[data-file-read-failure]")?.getAttribute("data-file-read-failure") ?? "",
      buttons: [...(panel?.querySelectorAll("button") ?? [])].map((node) => node.textContent?.trim() ?? ""),
    };
  });
  check(missing.kind === "missing", "a 404 read is classified as a file that is gone, not a host that failed: " + missing.kind);
  check(/no longer in the folder/.test(missing.text), "the deleted file is stated as gone: " + missing.text.slice(0, 160));
  check(missing.buttons.some((label) => /^Reload folder$/.test(label)), "the panel offers the folder reload: " + missing.buttons.join(" | "));
  check(!missing.buttons.some((label) => /^Retry$/.test(label)), "a gone file is not offered the same read again: " + missing.buttons.join(" | "));
  check(!/\/workspace\/missing|\/home\/|\/srv\//.test(missing.text), "a host path reached the screen: " + missing.text.slice(0, 200));

  await page.click("#viewer-missing button:has-text('Reload folder')");
  const reloads = await page.evaluate(() => window.fileFailureActions.reloadFolder);
  check(reloads === 1, "the reload button reached the shell's own folder refresh, got " + reloads);

  // 7. A bounded preview states the bytes it shows against the size the host stated. It used to draw its own delivered
  //    size as the file's end — every truncated file read as complete — beside a "Load more" the host cannot serve.
  const truncatedViewer = await text("viewer-truncated");
  check(/Showing the first 200\.0 KB of 3\.0 MB/.test(truncatedViewer), "the preview states shown bytes of the host's total: " + truncatedViewer.slice(0, 220));
  check(!/Load more/i.test(truncatedViewer), "a preview-only chunk offered a continuation the host does not serve");
  check(!/100%|200\.0 KB \/ 200\.0 KB/.test(truncatedViewer), "a bounded preview still read as a complete file: " + truncatedViewer.slice(0, 220));

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
  await new Promise((resolveClose) => server.close(resolveClose));
}
