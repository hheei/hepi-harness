import assert from "node:assert/strict";
import test from "node:test";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "./file-links.ts";

test("file links resolve preview paths safely and keep browser gestures", () => {
  const cwd = "/home/me/project";
  for (const [href, base, expected] of [
    ["src/app.ts#L42", cwd, cwd + "/src/app.ts"],
    ["../file.js", cwd + "/docs/nested", cwd + "/docs/file.js"],
    ["../../../outside.js", cwd + "/docs/nested", null],
    ["../outside.md", cwd, null],
    ["/home/me/.config/file:12", cwd, "/home/me/.config/file"],
    ["/api/files/a.ts", cwd, null],
    ["https://example.com/a.ts", cwd, null],
    ["//example.com/a.ts", cwd, null],
    ["file:///home/me/project/C%23/report.html", cwd, cwd + "/C#/report.html"],
    ["file:///C:/Users/me/file.txt:10", cwd, "C:/Users/me/file.txt"],
  ]) assert.equal(resolveLocalFileHref(href, base, cwd), expected, href);
  const click = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  assert.equal(shouldOpenLocalFileInApp(click), true);
  assert.equal(shouldOpenLocalFileInApp({ ...click, ctrlKey: true }), true);
  assert.equal(shouldOpenLocalFileInApp({ ...click, button: 1 }), false);
  assert.equal(shouldOpenLocalFileInApp({ ...click, shiftKey: true }), false);
  assert.equal(shouldOpenLocalFileInApp({ ...click, defaultPrevented: true }), false);
  assert.equal(parsePdfPageFragment("/report.pdf#page=12"), 12);
  assert.equal(parsePdfPageFragment("/report.pdf#page=0"), null);
});
