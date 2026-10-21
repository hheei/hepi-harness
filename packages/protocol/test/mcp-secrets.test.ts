import assert from "node:assert/strict";
import test from "node:test";
import { SECRET_MASK as mask, literalSecretFields, looksLikeSecretValue, maskArgs, maskUrl, urlSecretParts } from "../src/mcp-secrets.ts";

test("secret URLs mask userinfo, query and path tokens while preserving public URL text", () => {
  for (const [input, expected] of [
    ["https://mcp.example.com/mcp", "https://mcp.example.com/mcp"],
    ["https://user:hunter2@mcp.example.com/mcp", `https://${mask}@mcp.example.com/mcp`],
    ["https://mcp.example.com/mcp?api_key=a%2Bb&region=eu#frag", `https://mcp.example.com/mcp?api_key=${mask}&region=eu#frag`],
    ["https://actions.example.com/mcp/sk-ak-abcdefghijklmnopqrstuvwx/sse", `https://actions.example.com/mcp/${mask}/sse`],
    ["https://mcp.example.com/mcp?KEY=${MCP_KEY}", "https://mcp.example.com/mcp?KEY=${MCP_KEY}"],
  ]) assert.equal(maskUrl(input).value, expected, input);
  assert.deepEqual(urlSecretParts("https://user:hunter2@mcp.example.com/mcp?api_key=a%2Bb&region=eu"),
    ["user:hunter2", "hunter2", "a%2Bb", "a+b"]);
});

test("literal secrets are masked and classified without hiding references or normal arguments", () => {
  assert.deepEqual(maskArgs(["--header", "Authorization: Bearer abc", "--token", "${TOKEN}", "--port", "8080"]), {
    args: ["--header", `Authorization: ${mask}`, "--token", "${TOKEN}", "--port", "8080"], masked: true,
  });
  assert.deepEqual(literalSecretFields({
    url: "https://x.example/mcp?token=abc",
    headers: { Authorization: "Bearer abc", "X-Ref": "Bearer ${TOKEN}" },
    oauth: { clientSecret: "literal" },
  }), [{ kind: "header", name: "Authorization" }, { kind: "oauth-client-secret" }, { kind: "url" }]);
  assert.deepEqual(literalSecretFields({ command: "node", env: { API_KEY: "literal", REF: "${TOKEN}", NODE_ENV: "production" } }),
    [{ kind: "env", name: "API_KEY" }]);
});

test("a bare value is classified by the shape a credential has, not by its length alone", () => {
  for (const token of [
    "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "ya29.a0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9",
    // Google's refresh token carries slashes, so only a named prefix catches it: the generic rule reads three segments
    // as a path. A provider flow whose message quotes one is the case that found this.
    "1//0abcdefghijklmnopqrstuvwx1234567890ABCDEFGH",
    "ghp_AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRr",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNprY_9q4u0E",
    "Zm9vYmFyMDEyMzQ1Njc4OTBhYmNkZWY=",
  ]) assert.equal(looksLikeSecretValue(token), true, token);
  for (const plain of [
    "", "GQV-GBNN", "mcp-server-postgres", "https://mcp.example.com/mcp", "~/agent/auth.json", "auth.json",
    "some.directory.value", "a/b/c", "${OPENAI_API_KEY}", "workspace-choice-acc-b",
    "sk-live-short", "8080",
  ]) assert.equal(looksLikeSecretValue(plain), false, plain);
});
