import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isShellCommandDraft } = await jiti.import("./composer-limits.ts");

test("only an attachment-free draft that asks for a shell command is refused", () => {
  assert.equal(isShellCommandDraft("!ls -la", 0), true, "a leading ! asks for a shell command");
  assert.equal(isShellCommandDraft("!!ls", 0), true, "!! asks for one whose output stays local");
  assert.equal(isShellCommandDraft("   !ls", 0), true, "leading whitespace does not hide the request");
  assert.equal(isShellCommandDraft("!ls", 1), false, "an attachment makes the draft an ordinary prompt");
  assert.equal(isShellCommandDraft("hello !", 0), false, "an exclamation mark inside a prompt is not a request");
  assert.equal(isShellCommandDraft("/reload", 0), false, "a slash command is not a shell command");
  assert.equal(isShellCommandDraft("", 0), false);
});
