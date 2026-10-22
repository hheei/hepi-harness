import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { REMOTE_FILESYSTEM_SCRIPT } from "../src/ssh-filesystem-helper.ts";

/**
 * The helper reads as Python now, but the encoding is still a template literal, and that fails silently: a backslash
 * it consumes, a backtick it closes early or a `${` it evaluates changes the program the host runs while the
 * TypeScript still compiles. These observations pin the program itself — Python 3 compiles it, its lines are the
 * program's lines, and the constructs the ported engine is built from survive verbatim.
 */
test("the helper source is the Python 3 program the host runs", () => {
  assert.equal(REMOTE_FILESYSTEM_SCRIPT.includes("\r"), false, "the program carries no carriage return");
  assert.equal(REMOTE_FILESYSTEM_SCRIPT.includes("${"), false, "no interpolation reached the program text");
  assert.ok(REMOTE_FILESYSTEM_SCRIPT.split("\n").length > 1000, "one Python line is one source line");
  assert.equal(REMOTE_FILESYSTEM_SCRIPT.startsWith("import base64, codecs, errno"), true, "the program starts at its own imports");
  for (const text of [
    "node-ignore@7.0.5",
    "Kael Zhang and contributors",
    String.raw`_TEST_INVALID_TRAILING_BACKSLASH = re.compile(r'(?:[^\\]|^)\\$')`,
    String.raw`self.bom = head[:3] == b"\xef\xbb\xbf"`,
    String.raw`index = chunk.find(b"\n", index + 1)`,
  ]) assert.ok(REMOTE_FILESYSTEM_SCRIPT.includes(text), "the program carries " + JSON.stringify(text));
  // The interpreter the remote host runs it with is the one that has to accept it; nothing here parses Python itself.
  execFileSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'hepi', 'exec')"], { input: REMOTE_FILESYSTEM_SCRIPT, encoding: "utf8" });
});
