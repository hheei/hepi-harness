import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  mcpSignInBlock, mcpSignInLink, mcpSignInActive,
  mcpSignInRunAfterStart, mcpSignInRunAfterPoll, mcpSignInRunAfterPaste,
} = await jiti.import("./mcp-sign-in-helpers.ts");

const flow = (phase, extra = {}) => ({ flowId: "f1", scope: "global", name: "docs", configKey: "k", phase, expiresInMs: 60_000, ...extra });

test("sign-in refuses untrusted projects and web-password forwarding, and restricts authorization URLs", () => {
  const server = { scope: "global", validated: true };
  const data = { mcp: { available: true } };
  assert.equal(mcpSignInBlock(server, data), undefined);
  assert.equal(mcpSignInBlock({ ...server, webPasswordField: { kind: "header", name: "X" } }, data), "web-password");
  assert.equal(mcpSignInBlock({ ...server, scope: "project" }, {
    ...data, project: { cwd: "/repo", trust: { requiresTrust: true, trusted: false, decision: null, inherited: false } },
  }), "project-untrusted");
  for (const [url, expected] of [
    ["https://auth.example/authorize?state=s", "https://auth.example/authorize?state=s"],
    ["javascript:alert(1)", undefined], ["file:///etc/passwd", undefined],
  ]) assert.equal(mcpSignInLink(url), expected, url);
});

test("sign-in flow preserves redirect refusals until expiration clears the failed paste", () => {
  const started = mcpSignInRunAfterStart({ ok: true, data: flow("connecting") }, 1_000);
  assert.equal(mcpSignInActive(started), true);
  const waiting = mcpSignInRunAfterPoll(started, "f1", { ok: true, data: flow("authorize", { expiresInMs: 30_000 }) }, 2_000);
  assert.equal(waiting.flow.phase, "authorize");
  const refused = mcpSignInRunAfterPaste({ ...waiting, pasting: true }, "f1", {
    ok: false, error: { error: "x", reason: "redirect-state-mismatch" },
  });
  assert.equal(refused.pasteError.reason, "redirect-state-mismatch");
  const expired = mcpSignInRunAfterPoll(refused, "f1", { ok: true, data: flow("expired", { expiresInMs: 0 }) }, 4_000, refused.version);
  assert.equal("pasteError" in expired, false);
});
