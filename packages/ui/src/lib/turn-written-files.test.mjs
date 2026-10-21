import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { extractTurnWrittenFiles } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./turn-written-files.ts");
const call = (id, toolName, input) => ({ type: "toolCall", toolCallId: id, toolName, input });
const result = (id, extra = {}) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], ...extra });
const paths = (content, results, cwd) => extractTurnWrittenFiles(content, results, cwd).map((file) => file.filePath);

test("written files require a successful paired writing call and normalize only its explicit path", () => {
  for (const { label, content, results = [result("1")], cwd, expected } of [
    { label: "write file_path", content: [call("1", "write", { file_path: "/abs/out/report.html" })], expected: ["/abs/out/report.html"] },
    { label: "edit path", content: [call("1", "edit", { path: "/abs/src/a.ts" })], expected: ["/abs/src/a.ts"] },
    { label: "namespaced writing tools", content: [call("1", "write_file", { file_path: "/abs/a.txt" }), call("2", "fs.edit", { file_path: "/abs/b.txt" }), call("3", "str_replace_editor", { file_path: "/abs/c.txt" })], results: [result("1"), result("2"), result("3")], expected: ["/abs/a.txt", "/abs/b.txt", "/abs/c.txt"] },
    { label: "errored result", content: [call("1", "write", { file_path: "/abs/out/report.html" })], results: [result("1", { isError: true })], expected: [] },
    { label: "result not arrived", content: [call("1", "write", { path: "/abs/a" })], results: [], expected: [] },
    { label: "write then edit deduplicates", content: [call("1", "write", { path: "/abs/a" }), call("2", "edit", { path: "/abs/a" })], results: [result("1"), result("2")], expected: ["/abs/a"] },
    { label: "relative path", content: [call("1", "write", { file_path: "out/report.html" })], cwd: "/abs", expected: ["/abs/out/report.html"] },
    { label: "extensionless and hidden names", content: [call("1", "write", { path: "LICENSE" }), call("2", "write", { path: ".env" })], results: [result("1"), result("2")], cwd: "/repo", expected: ["/repo/LICENSE", "/repo/.env"] },
    { label: "href punctuation preserved", content: [call("1", "write", { path: "release#1.md" }), call("2", "write", { path: "query?.json" }), call("3", "write", { path: "report.md:42" })], results: [result("1"), result("2"), result("3")], cwd: "/repo", expected: ["/repo/release#1.md", "/repo/query?.json", "/repo/report.md:42"] },
    { label: "Windows relative path", content: [call("1", "write", { path: "src\\report.html" })], cwd: "C:\\repo", expected: ["C:/repo/src/report.html"] },
    { label: "nonwriting tools", content: [call("1", "read", { file_path: "/abs/a.ts" }), call("2", "bash", { command: "echo hi > /abs/a.txt" })], results: [result("1"), result("2")], expected: [] },
    { label: "prose alone is no write", content: [{ type: "text", text: "I saved /abs/out/report.html" }], results: [], expected: [] },
    { label: "prose cannot add files", content: [call("1", "write", { path: "/abs/real.html" }), { type: "text", text: "See /abs/imagined.html and /etc/passwd" }], expected: ["/abs/real.html"] },
    { label: "missing path", content: [call("1", "write", { content: "hi" })], expected: [] },
    { label: "empty turn", content: [], results: [], expected: [] },
    { label: "text only", content: [{ type: "text", text: "hi" }], results: [], expected: [] },
  ]) assert.deepEqual(paths(content, new Map(results.map((r) => [r.toolCallId, r])), cwd), expected, label);
  assert.deepEqual(paths([call("1", "write", { path: "/abs/a" })], undefined), [], "no result map while streaming");
});

test("apply_patch lists applied additions and moves, excludes deletes and respects partial failures", () => {
  const input = ["*** Begin Patch", "*** Add File: src/a.ts", "+hello", "*** Update File: old.ts", "*** Move to: renamed.ts", "-x", "+y", "*** Delete File: gone.ts", "*** End Patch"].join("\n");
  const files = [
    { filePath: "src/a.ts", operation: "add", diff: "+  1 hello" },
    { filePath: "old.ts", movePath: "renamed.ts", operation: "update", diff: "+  1 y" },
    { filePath: "gone.ts", operation: "delete", diff: "-  1 bye" },
  ];
  for (const [label, details, text, expected] of [
    ["applied additions and moves", { result: { appliedFiles: ["src/a.ts", "renamed.ts", "gone.ts"], failures: [] }, preview: { files } }, "ok", ["/repo/src/a.ts", "/repo/renamed.ts"]],
    ["all failed", { result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "boom" }] } }, "apply_patch failed.", []],
    ["partial success", { result: { appliedFiles: ["src/a.ts"], failures: [{ filePath: "old.ts", message: "miss" }] }, preview: { files: files.slice(0, 1) } }, "apply_patch partially failed.", ["/repo/src/a.ts"]],
    ["legacy preview fallback", { preview: { files: [files[0], files[2]] } }, "ok", ["/repo/src/a.ts"]],
  ]) {
    const toolResult = result("1", { details, content: [{ type: "text", text }] });
    assert.deepEqual(paths([call("1", "apply_patch", { input })], new Map([["1", toolResult]]), "/repo"), expected, label);
  }
});
