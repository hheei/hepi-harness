import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import<typeof import("react")>("react");
const { renderToStaticMarkup } = await jiti.import<typeof import("react-dom/server")>("react-dom/server");
const { classifyFileReadFailure, fileReadFailureKey, fileReadFailureRetryable } = await jiti.import<typeof import("../lib/file/file-read-failure.ts")>("../lib/file/file-read-failure.ts");
const { FileReadFailurePanel } = await jiti.import<typeof import("./FileReadFailurePanel.tsx")>("./FileReadFailurePanel.tsx");
const { FilePreviewLimitNotice } = await jiti.import<typeof import("./FilePreviewLimitNotice.tsx")>("./FilePreviewLimitNotice.tsx");
const { I18nProvider } = await jiti.import<typeof import("../hooks/useI18n.tsx")>("../hooks/useI18n.tsx");

/** One thrown file read, in the shape the connection's own error carries. */
const thrown = (init: { status?: number; code?: string }, message = "the host could not answer for a file preview") =>
  Object.assign(new Error(message), init);

type PanelProps = Parameters<typeof FileReadFailurePanel>[0];
const panel = (props: PanelProps) => React.createElement(I18nProvider, null, React.createElement(FileReadFailurePanel, props));

/**
 * What a failed file read is told apart as, before any surface draws it.
 *
 * Four causes reach the viewer through one throw and each needs a different next move: a file that is gone is reloaded
 * from the folder, a refused path is not, a host that went quiet may answer next time, and an operation that failed is
 * its own statement. The status and code are the file surface's own (`packages/gateway/src/files-surface.ts`), so the
 * classification is pinned against them and not against a stand-in.
 */
test("each cause a file read can fail for is classified by what the surface stated", () => {
  const cases = [
    { label: "404 not_found", error: thrown({ status: 404, code: "not_found" }, "the host has no such path"), kind: "missing", key: "files.readMissing", retryable: false },
    { label: "403 path_denied", error: thrown({ status: 403, code: "path_denied" }, "the host refused that path"), kind: "denied", key: "files.readDenied", retryable: false },
    { label: "503 gateway_offline", error: thrown({ status: 503, code: "gateway_offline" }, "could not be reached"), kind: "offline", key: "files.readOffline", retryable: true },
    { label: "500 operation_failed", error: thrown({ status: 500, code: "operation_failed" }), kind: "failed", key: "files.readFailed", retryable: true },
    { label: "no answer at all", error: new Error("fetch failed"), kind: "failed", key: "files.readFailed", retryable: true },
    // A named code decides even when a proxy in between rewrote the status it travelled with.
    { label: "code without status", error: thrown({ code: "not_found" }), kind: "missing", key: "files.readMissing", retryable: false },
  ] as const;
  for (const { label, error, kind, key, retryable } of cases) {
    const failure = classifyFileReadFailure(error);
    assert.equal(failure.kind, kind, label);
    assert.equal(fileReadFailureKey(failure), key, label + " key");
    assert.equal(fileReadFailureRetryable(failure), retryable, label + " retryability");
  }
});

/**
 * A host's own path stays out of what a person reads.
 *
 * The surface's message is kept as the log's `detail` and never rendered; the panel's sentence is this build's own
 * translation key. A remote host that names where it keeps a workspace must not end up on a screen that a person shares.
 */
test("the failure's raw reason is kept for a log and never drawn", () => {
  const hostPath = "/home/operator/.hepi/workspaces/ws-7/gone.md";
  const failure = classifyFileReadFailure(thrown({ status: 404, code: "not_found" }, "no such file: " + hostPath));
  assert.match(failure.detail ?? "", new RegExp(hostPath.replace(/[/.]/g, (c) => "\\" + c)), "the raw reason is kept beside the kind");
  const html = renderToStaticMarkup(panel({ failure, onRetry() {}, onReloadFolder() {}, onClose() {} }));
  assert.ok(!html.includes(hostPath), "a host path reached the screen: " + html.slice(0, 300));
});

/** The actions a person can take are decided by the cause, not offered as one row of buttons. */
test("a missing file offers the folder reload and never a retry of the same read", () => {
  const calls: string[] = [];
  const html = renderToStaticMarkup(panel({
    failure: { kind: "missing" },
    onRetry: () => calls.push("retry"),
    onReloadFolder: () => calls.push("reload"),
    onClose: () => calls.push("close"),
  }));
  assert.match(html, /data-file-read-failure="missing"/);
  assert.match(html, /role="status"/, "the state is announced, not drawn as decoration");
  assert.match(html, /no longer in the folder/, "a gone file is stated as gone: " + html.slice(0, 200));
  assert.match(html, /Reload folder/);
  assert.match(html, /Close/);
  assert.equal(/Retry<\/button>/.test(html), false, "reading the same missing path again cannot answer differently");
  assert.deepEqual(calls, [], "rendering a panel never acts by itself");
});

test("a host that did not answer offers Retry; a refused path offers none", () => {
  for (const { kind, retry } of [{ kind: "offline", retry: true }, { kind: "failed", retry: true }, { kind: "denied", retry: false }] as const) {
    const html = renderToStaticMarkup(panel({
      failure: { kind },
      onRetry() {},
      onReloadFolder() {},
      onClose() {},
    }));
    assert.equal(/Retry<\/button>/.test(html), retry, kind + " offers a retry" + (retry ? "" : " only when it can work"));
    assert.equal(/Reload folder/.test(html), false, kind + " is not a missing file, so no folder reload is offered");
  }
});

/** A retry in flight says so and cannot be started twice. */
test("a retry in flight is disabled and states its own progress", () => {
  const html = renderToStaticMarkup(panel({
    failure: { kind: "offline" },
    retrying: true,
    onRetry() {},
  }));
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled/);
});

/**
 * A bounded preview states the two numbers it really has.
 *
 * The notice used to draw the delivered size as the file's end and offer a "load more" for an offset the host does not
 * serve, so every truncated preview read as complete and every continuation as reachable. Here the shown bytes and the
 * host's own total are both said, and a total the host did not state is said as unknown rather than filled in with the
 * numerator — which is what made the old bar reach 100%.
 */
test("a truncated preview names the bytes it shows and the size the host stated", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(FilePreviewLimitNotice, { shownBytes: 200 * 1024, size: 3 * 1024 * 1024 })));
  assert.match(html, /data-preview-truncated="true"/);
  assert.match(html, /Showing the first 200\.0 KB of 3\.0 MB/);
  assert.match(html, /the rest is not loaded here/);
  assert.equal(/Load more|load more/.test(html), false, "a bounded preview offers a continuation the host does not serve");
});

test("a preview whose host stated no total says so instead of inventing a denominator", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(FilePreviewLimitNotice, { shownBytes: 1024, size: null })));
  assert.match(html, /Showing the first 1\.0 KB/);
  assert.match(html, /did not state the file&#x27;s total size/);
  assert.equal(/of /.test(html), false, "a total the host never stated was invented from the shown bytes");
  assert.equal(/100%/.test(html), false, "a bounded chunk is never drawn as a complete file");
});
