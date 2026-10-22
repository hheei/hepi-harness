import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";

/**
 * The startup contract for the default model, at the seam the deployment actually runs: the backend entrypoint in its
 * own process, with only the environment this test states.
 *
 * The claim under test is that environment mode has exactly one way to name a default — the paired
 * `HEPI_PROVIDER`+`HEPI_MODEL` selection that `provider-config.ts` validates. A model id on its own names no endpoint,
 * so it selects no default and never infers a provider from a built-in catalog, and the backend starts rather than
 * refusing to boot over an id it was never asked to serve.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENTRYPOINT = join(REPO_ROOT, "apps", "server", "src", "main.ts");
const TOKEN = "startup-default-model-token";
const headers = { authorization: "Bearer " + TOKEN };

const directories: string[] = [];
after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(() => rejectPort(new Error("no free port"))); return; }
      probe.close(() => resolvePort(address.port));
    });
  });
}

type Catalog = { defaultModel: { provider: string; modelId: string } | null; models: { provider: string; id: string }[] };
type Started = { catalog: Catalog; output(): string };

/**
 * Starts the entrypoint over a fresh agent directory and waits until it answers its own catalog route, so "it booted"
 * is a fact this test read from the process rather than a sleep. `env` is the whole environment: nothing ambient (an
 * inherited `OPENAI_API_KEY`, say) can decide what the assertions see.
 */
async function start(t: TestContext, env: Record<string, string>): Promise<Started> {
  const base = await mkdtemp(join(tmpdir(), "hepi-startup-default-"));
  directories.push(base);
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: base,
      TMPDIR: tmpdir(),
      HEPI_BIND_HOST: "127.0.0.1",
      PORT: String(port),
      HEPI_DB: join(base, "hepi.sqlite"),
      HEPI_AUTH_TOKEN: TOKEN,
      PI_CODING_AGENT_DIR: join(base, "agent"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const reported: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  let ended: { code: number | null; signal: string | null } | undefined;
  child.on("exit", (code, signal) => { ended = { code, signal }; });
  t.after(() => { if (ended === undefined) child.kill("SIGKILL"); });

  const origin = "http://127.0.0.1:" + port;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (ended !== undefined) throw new Error("the backend exited (" + JSON.stringify(ended) + ") before answering: " + reported.join(""));
    const answered = await fetch(origin + "/api/models", { headers }).then(response => response.status === 200 ? response.json() as Promise<Catalog> : undefined).catch(() => undefined);
    if (answered !== undefined) return { catalog: answered, output: () => reported.join("") };
    if (Date.now() > deadline) throw new Error("the backend did not answer within the deadline: " + reported.join(""));
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
}

test("HEPI_MODEL alone selects no default, even when the catalog offers that id", async (t) => {
  // OPENAI_API_KEY makes the built-in OpenAI catalog available, so the id below is a model this backend can serve. It is
  // still not a default: a model id is not a provider, and nothing infers one on the operator's behalf.
  const backend = await start(t, { OPENAI_API_KEY: "startup-test-key", HEPI_MODEL: "gpt-4o" });
  assert.equal(backend.catalog.defaultModel, null, "a model id without a provider states no default");
  assert.ok(backend.catalog.models.some(model => model.provider === "openai" && model.id === "gpt-4o"), "the id is still offered by the catalog that owns it, just not selected");
  assert.doesNotMatch(backend.output(), /Unknown default model/, "the id was never read as a built-in catalog default");
});

test("an unknown HEPI_MODEL id alone does not fail startup", async (t) => {
  // The removed branch validated this id against the built-in OpenAI catalog and refused to boot on a miss. A model id
  // that selects nothing cannot be unknown, so the backend starts and states no default.
  const backend = await start(t, { HEPI_MODEL: "no-such-model-id" });
  assert.equal(backend.catalog.defaultModel, null, "an unpaired id names no default to validate");
  assert.doesNotMatch(backend.output(), /Unknown default model/);
});

test("the paired HEPI_PROVIDER/HEPI_MODEL selection is the one way to name a default", async (t) => {
  const backend = await start(t, {
    HEPI_PROVIDER: "magpie",
    HEPI_MODEL: "deepseek-v4.1-flash",
    HEPI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
    HEPI_PROVIDER_API_KEY: "startup-test-key",
  });
  assert.deepEqual(backend.catalog.defaultModel, { provider: "magpie", modelId: "deepseek-v4.1-flash" }, "the validated pair is the default");
  assert.ok(backend.catalog.models.some(model => model.provider === "magpie" && model.id === "deepseek-v4.1-flash"), "the configured provider and model are listed");
});

test("a provider without its model still fails startup", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "hepi-startup-default-"));
  directories.push(base);
  const child = spawn(process.execPath, [ENTRYPOINT], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: base,
      TMPDIR: tmpdir(),
      HEPI_BIND_HOST: "127.0.0.1",
      PORT: String(await freePort()),
      HEPI_DB: join(base, "hepi.sqlite"),
      HEPI_AUTH_TOKEN: TOKEN,
      PI_CODING_AGENT_DIR: join(base, "agent"),
      HEPI_PROVIDER: "magpie",
      HEPI_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
      HEPI_PROVIDER_API_KEY: "startup-test-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const reported: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  child.stderr.on("data", (chunk: Buffer) => { reported.push(chunk.toString()); });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    const deadline = setTimeout(() => rejectExit(new Error("the backend neither started nor failed: " + reported.join(""))), 60_000);
    child.on("exit", exitCode => { clearTimeout(deadline); resolveExit(exitCode); });
  });
  assert.notEqual(code, 0, "a half-set provider configuration is a startup failure");
  assert.match(reported.join(""), /HEPI_PROVIDER and HEPI_MODEL are required/, "the failure names the missing pair");
});
