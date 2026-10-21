import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadPiConfig } from "../src/pi-config.ts";

const dirs: string[] = [];
async function agentDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hepi-pi-config-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, "utf8");
  return dir;
}
after(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

const MODELS_JSON = JSON.stringify({
  providers: {
    local: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "test-key", models: [{ id: "local-1", reasoning: false }] },
  },
});

test("env source stays untouched, unknown source is rejected", async () => {
  const dir = await agentDir({ "models.json": "{ this is not json SECRET-abc" });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.equal(await loadPiConfig({}), undefined);
    assert.equal(await loadPiConfig({ HEPI_CONFIG_SOURCE: "  " }), undefined);
    assert.equal(await loadPiConfig({ HEPI_CONFIG_SOURCE: "env" }), undefined);
    assert.equal(process.env.PI_CODING_AGENT_DIR, dir);
    await assert.rejects(() => loadPiConfig({ HEPI_CONFIG_SOURCE: "unknown" }), /is not supported/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("models, thinking level, durable settings and warnings come from the agent directory", async () => {
  const dir = await agentDir({
    "models.json": MODELS_JSON,
    "auth.json": JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
    "settings.json": JSON.stringify({
      defaultProvider: "local",
      defaultModel: "local-1",
      defaultThinkingLevel: "high",
      steeringMode: "all",
      followUpMode: "all",
      transport: "sse",
      retry: { enabled: false, maxRetries: 7, baseDelayMs: 11, maxAgentDelayMs: 22 },
      compaction: { enabled: false, reserveTokens: 111, keepRecentTokens: 222 },
      skills: ["/skills"], prompts: ["/prompts"], enableSkillCommands: false, defaultProjectTrust: "never",
      theme: "dark", defaultTools: ["read"], httpProxy: "http://proxy.invalid",
    }),
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  const config = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: dir });
  assert.ok(config);
  assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
  assert.equal(config.agentDir, dir);
  assert.deepEqual(config.defaultModel, { provider: "local", modelId: "local-1" });
  assert.equal(config.models.getModel("local", "local-1")?.id, "local-1");
  assert.equal(config.models.getModel("local", "local-1")?.baseUrl, "http://127.0.0.1:9/v1");
  // "high" clamps to "off" because the configured model is not a reasoning model.
  assert.equal(config.defaultThinkingLevel, "off");
  assert.deepEqual(config.settings?.stream, { transport: "sse", maxRetryDelayMs: 60000 });
  assert.deepEqual(config.settings?.retry, { enabled: false, maxRetries: 7, baseDelayMs: 11, maxAgentDelayMs: 22 });
  assert.deepEqual(config.settings?.compaction, { enabled: false, reserveTokens: 111, keepRecentTokens: 222 });
  assert.equal(config.settings?.steeringMode, "all");
  assert.equal(config.settings?.followUpMode, "all");
  assert.deepEqual(config.resourceSettings, { skills: ["/skills"], prompts: ["/prompts"], enableSkillCommands: false, defaultProjectTrust: "never" });
  assert.deepEqual(config.warnings, ["Settings not applied by the backend: defaultTools, httpProxy, theme"]);
});

test("unusable settings.json values fail startup with a sanitized message, not a raw upstream error", async () => {
  const cases: Record<string, unknown>[] = [
    { compaction: { reserveTokens: "SECRET-abc" } },
    { retry: { maxRetries: "SECRET-abc" } },
    { retry: { enabled: "yes" } },
    { transport: "SECRET-abc" },
    { steeringMode: "SECRET-abc" },
    { followUpMode: "SECRET-abc" },
    { prompts: 42 },
  ];
  for (const settings of cases) {
    const dir = await agentDir({ "models.json": MODELS_JSON, "auth.json": JSON.stringify({ local: { type: "api_key", key: "test-key" } }), "settings.json": JSON.stringify(settings) });
    await assert.rejects(
      () => loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: dir }),
      (error: Error) => error.message.startsWith("Invalid Pi configuration:") && !error.message.includes("SECRET-abc") && !(error instanceof TypeError),
      JSON.stringify(settings),
    );
  }
});

test("settings.json fields the backend ignores are all reported", async () => {
  const dir = await agentDir({
    "models.json": MODELS_JSON,
    "auth.json": JSON.stringify({ local: { type: "api_key", key: "test-key" } }),
    "settings.json": JSON.stringify({ defaultProvider: "local", defaultModel: "local-1", tuiMode: "fullscreen", doubleEscapeAction: "fork", outputPad: 1 }),
  });
  const config = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: dir });
  assert.deepEqual(config?.warnings, ["Settings not applied by the backend: doubleEscapeAction, outputPad, tuiMode"]);
});

test("malformed Pi configuration fails startup without echoing file contents", async () => {
  const malformed = await agentDir({ "models.json": "{ \"providers\": SECRET-abc" });
  await assert.rejects(
    () => loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: malformed }),
    (error: Error) => error.message.startsWith("Invalid Pi configuration:") && !error.message.includes("SECRET-abc"),
  );

  for (const file of ["auth.json", "settings.json"]) {
    const broken = await agentDir({ "models.json": MODELS_JSON, [file]: "{ SECRET-abc" });
    await assert.rejects(
      () => loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: broken }),
      (error: Error) => error.message.startsWith("Invalid Pi configuration:") && !error.message.includes("SECRET-abc"),
    );
  }

  // An explicit operator pair stays strict: it names a model that must already be in the catalog.
  const unknown = await agentDir({ "models.json": MODELS_JSON, "auth.json": JSON.stringify({ local: { type: "api_key", key: "test-key" } }) });
  await assert.rejects(() => loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: unknown, HEPI_PROVIDER: "local", HEPI_MODEL: "missing" }), /model local\/missing is not in the Pi catalog/);
});

test("a valid configuration whose default is unavailable or unauthenticated still loads, preserving the reference", async () => {
  const keylessModels = JSON.parse(MODELS_JSON);
  delete keylessModels.providers.local.apiKey;
  const keyless = await agentDir({ "models.json": JSON.stringify(keylessModels), "settings.json": JSON.stringify({ defaultProvider: "local", defaultModel: "local-1" }) });
  const unauthenticated = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: keyless });
  assert.ok(unauthenticated, "a catalog model without credentials does not stop the backend from booting");
  assert.deepEqual(unauthenticated.defaultModel, { provider: "local", modelId: "local-1" });
  assert.ok(unauthenticated.warnings.some((warning) => warning.includes("no credentials for local")), JSON.stringify(unauthenticated.warnings));

  // The settings.json default outlives the catalog entry: the reference is kept and reported instead of throwing.
  const deleted = await agentDir({ "models.json": JSON.stringify({ providers: {} }), "settings.json": JSON.stringify({ defaultProvider: "local", defaultModel: "local-1" }) });
  const gone = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: deleted });
  assert.ok(gone);
  assert.deepEqual(gone.defaultModel, { provider: "local", modelId: "local-1" });
  assert.ok(gone.warnings.some((warning) => warning.includes("local/local-1 is not in the models.json catalog")), JSON.stringify(gone.warnings));

  // No default anywhere and no authenticated catalog entry: still reachable, with no default reference at all.
  const empty = await agentDir({ "models.json": JSON.stringify({ providers: {} }) });
  const none = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: empty });
  assert.ok(none);
  assert.equal(none.defaultModel, undefined);
  assert.ok(none.warnings.some((warning) => warning.includes("no authenticated model is available")), JSON.stringify(none.warnings));
});
