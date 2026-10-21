import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { McpResponse, McpServerInfo, McpSignInFlowInfo, McpSignInPhase } from "@hepi/protocol/mcp-ui";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  mcpSignInBlock, mcpSignInLink, mcpSignInActive,
  mcpSignInRunAfterStart, mcpSignInRunAfterPoll, mcpSignInRunAfterPaste,
} = await jiti.import<typeof import("./mcp-sign-in-helpers.ts")>("./mcp-sign-in-helpers.ts");

/** One flow as a route answers it, in the shape `mcpSignInFlowInfo` reads. */
const flow = (phase: McpSignInPhase, extra: Partial<McpSignInFlowInfo> = {}): McpSignInFlowInfo =>
  ({ flowId: "f1", scope: "global", name: "docs", configKey: "k", phase, expiresInMs: 60_000, ...extra });

/** The two facts `mcpSignInBlock` reads of a server: its scope and whether it was validated. */
const server: Pick<McpServerInfo, "scope" | "invalidError" | "validated" | "webPasswordField"> = { scope: "global", validated: true };
/** The availability half of an overview: MCP on, and no project read. */
const data: Pick<McpResponse, "mcp" | "project"> = { mcp: { available: true } };

test("sign-in refuses untrusted projects and web-password forwarding, and restricts authorization URLs", () => {
  assert.equal(mcpSignInBlock(server, data), undefined);
  assert.equal(mcpSignInBlock({ ...server, webPasswordField: { kind: "header", name: "X" } }, data), "web-password");
  assert.equal(mcpSignInBlock({ ...server, scope: "project" }, {
    ...data, project: { cwd: "/repo", trust: { requiresTrust: true, trusted: false, decision: null, inherited: false } },
  }), "project-untrusted");
  for (const [url, expected] of [
    ["https://auth.example/authorize?state=s", "https://auth.example/authorize?state=s"],
    ["javascript:alert(1)", undefined], ["file:///etc/passwd", undefined],
  ] as const) assert.equal(mcpSignInLink(url), expected, url);
});

test("sign-in flow preserves redirect refusals until expiration clears the failed paste", () => {
  const started = mcpSignInRunAfterStart({ ok: true, data: flow("connecting") }, 1_000);
  assert.equal(mcpSignInActive(started), true);
  const waiting = mcpSignInRunAfterPoll(started, "f1", { ok: true, data: flow("authorize", { expiresInMs: 30_000 }) }, 2_000);
  assert.equal(waiting?.flow?.phase, "authorize");
  const refused = mcpSignInRunAfterPaste({ ...waiting!, pasting: true }, "f1", {
    ok: false, error: { error: "x", reason: "redirect-state-mismatch" },
  });
  assert.equal(refused?.pasteError?.reason, "redirect-state-mismatch");
  const expired = mcpSignInRunAfterPoll(refused, "f1", { ok: true, data: flow("expired", { expiresInMs: 0 }) }, 4_000, refused?.version);
  assert.equal(expired !== undefined && "pasteError" in expired, false);
});
