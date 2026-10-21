/**
 * Real-model execution-resource smoke (ticket 08 step 1). Not a CI test: it needs an operator credential and a live
 * OpenAI-compatible endpoint, so it runs only when `HEPI_SMOKE_ENV_FILE` (default `/tmp/hepi-backend.env`) holds the
 * documented provider quartet. Nothing secret is printed, logged or written into the repository: the credential is read
 * in memory, copied into a mode-0600 temporary Pi agent directory outside the repository, and never echoed.
 *
 * It drives the real Harness with a real model over a temporary execution host (temporary account home, temporary
 * workspace, temporary SQLite) and asserts:
 *   1. skill command discovery and /skill:<name> expansion against the adopted catalog,
 *   2. an ordinary read of a referenced file and a harmless bash script execution inside the workspace,
 *   3. prompt and skill edits plus explicit Reload adoption on the next turn: after a Reload the skill body and the
 *      prompt template both expand to the edited text,
 *   4. a backend restart that retains the adopted prefix while the disk changed underneath it: the committed prompt
 *      template still expands to its pre-restart text until an explicit Reload, while a skill body is read live,

 *   5. the local UI in a real browser: publish a bundle, install it into the workspace, edit the installed file, and
 *      confirm the 409-confirmed update that keeps a backup, with the exact filesystem bytes checked on disk.
 *
 * Every turn is settled from the conversation's durable event stream: a settled turn is a state event that carries
 * more entries than the turn's baseline and a higher revision, so a stale idle revision from an earlier turn can never
 * be mistaken for this turn's result, and the entries this turn added are known rather than assumed.
 *
 * The per-turn assertions are about the turn's own new entries: the final assistant message completed (not errored or
 * aborted) and the tool result this smoke relies on is present and successful. A real model may also run commands this
 * smoke never asked for, and one of those may fail (here: git in a directory that is not a repository); such results
 * are recorded as notes with their tool name, because this smoke asserts the execution-resource contract rather than
 * the model's tool discipline. The results it does rely on are asserted positively and are never exempted.
 *
 * Usage: node apps/server/scripts/real-model-smoke.ts [--no-ui] [--keep]
 *        HEPI_SMOKE_ENV_FILE=<file> HEPI_SMOKE_DEADLINE_MS=<ms>
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const serverRoot = resolve(repoRoot, "apps", "server");
const webRoot = resolve(repoRoot, "apps", "web");

const argv = new Set(process.argv.slice(2));
const withUi = !argv.has("--no-ui");
const keep = argv.has("--keep");

const failures: string[] = [];
const notes: string[] = [];
function check(condition: unknown, message: string): void {
  if (condition) { console.log("  ok  " + message); return; }
  failures.push(message);
  console.log("  FAIL " + message);
}
function note(message: string): void { notes.push(message); console.log("  ..  " + message); }

/**
 * Everything this script logs or reports is scrubbed of the operator's values before it is written. The credential and
 * endpoint come from the env file and an own-configuration failure (a missing file, a malformed value, a provider
 * rejection that quotes the key) would otherwise carry them into this operator-shared log. Stack traces are never
 * printed: an upstream error stack can embed the raw configuration it failed to parse.
 */
const redactions: string[] = ["smoke-server-token", "smoke-gateway-token"];
function sanitize(value: string): string {
  let safe = value;
  for (const secret of redactions) if (secret !== "") safe = safe.split(secret).join("[redacted]");
  return safe;
}
function sanitizeError(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

/** A provider/model pair read from an operator env file. Values stay in memory; only the ids are ever printed. */
async function readProviderEnv(): Promise<{ provider: string; modelId: string; baseUrl: string; apiKey: string }> {
  const file = process.env.HEPI_SMOKE_ENV_FILE ?? "/tmp/hepi-backend.env";
  const text = await readFile(file, "utf8");
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]!] = match[2]!;
  }
  const provider = values.HEPI_PROVIDER ?? "";
  const modelId = values.HEPI_MODEL ?? "";
  const baseUrl = values.HEPI_PROVIDER_BASE_URL ?? "";
  const apiKey = values.HEPI_PROVIDER_API_KEY ?? "";
  if (!provider || !modelId || !baseUrl || !apiKey) throw new Error("the provider quartet is not set in the smoke env file");
  // Every value from that file is treated as a secret, so a later failure that quotes one is scrubbed.
  redactions.push(apiKey, baseUrl);
  return { provider, modelId, baseUrl, apiKey };
}

/**
 * The temporary Pi agent directory: a copy of the safe subset of a Pi configuration (models.json catalog entry,
 * an empty auth.json, and the settings this backend forwards) with the credential supplied in memory. Mode 0600,
 * outside the repository, removed when the run ends.
 */
async function writePiAgentDir(base: string, provider: { provider: string; modelId: string; baseUrl: string; apiKey: string }): Promise<string> {
  const agentDir = join(base, "pi-agent");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const models = {
    providers: {
      [provider.provider]: {
        api: "openai-completions",
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        models: [{
          id: provider.modelId,
          name: "Smoke " + provider.modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        }],
      },
    },
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify(models, null, 2), { mode: 0o600 });
  await writeFile(join(agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider.provider, defaultModel: provider.modelId, enableSkillCommands: true, defaultProjectTrust: "always" }, null, 2), { mode: 0o600 });
  return agentDir;
}

/** The temporary execution host: its own account home, its own workspace, and one referenced script of our own. */
async function writeExecutionHost(base: string): Promise<{ home: string; root: string; notesBytes: string; scriptBytes: string }> {
  const home = join(base, "home");
  const root = join(base, "repo");
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy", "scripts"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
  // The prompt template carries a placeholder so its expansion both identifies the turn and proves substitution: an
  // argument-less template stores identical text on every turn and would make a turn's own submission unrecognizable.
  await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps v1.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\necho smoke-script-ok\n", { mode: 0o755 });
  await writeFile(join(root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it v1.\nArgs: $@\n");
  await writeFile(join(root, "AGENTS.md"), "Workspace rules for the smoke fixture.\n");
  const notesBytes = "smoke-notes-exact-bytes\n";
  await writeFile(join(root, "notes.txt"), notesBytes);
  const scriptBytes = await readFile(join(root, ".agents", "skills", "deploy", "scripts", "run.sh"), "utf8");
  return { home, root, notesBytes, scriptBytes };
}

type SnapshotEntry = { id: string; role: string; text: string; message: { isError?: boolean; stopReason?: string; errorMessage?: string; toolName?: string } };
type Snapshot = {
  busy: boolean;
  revision: number;
  entries: SnapshotEntry[];
  resources?: { status: string; skills?: number; prompts?: number; pending?: boolean };
};

/** The conversation's durable event stream, open for as long as one backend instance is up. */
type Events = { readonly frames: Snapshot[]; readonly latest: () => Snapshot; readonly waitFor: (predicate: (frame: Snapshot) => boolean, timeoutMs: number, fromIndex: number) => Promise<Snapshot>; readonly close: () => Promise<void> };

function openEvents(origin: string, headers: HeadersInit, id: string): Events {
  const frames: Snapshot[] = [];
  const controller = new AbortController();
  const started = fetch(origin + "/api/conversations/" + id + "/events", { headers, signal: controller.signal }).then((response) => {
    if (!response.ok || response.body === null) throw new Error("event stream refused: " + response.status);
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frameText = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = frameText.split("\n").find((value) => value.startsWith("data: "));
          if (line === undefined) continue;
          const parsed = JSON.parse(line.slice(6)) as Snapshot;
          if (typeof parsed?.revision === "number" && Array.isArray(parsed.entries)) frames.push(parsed);
        }
      }
    })().catch(() => {});
  }).catch((error: unknown) => { failures.push("the event stream failed: " + sanitizeError(error)); });
  return {
    frames,
    latest: () => { const last = frames.at(-1); if (last === undefined) throw new Error("the event stream has not produced a state event"); return last; },
    waitFor: async (predicate, timeoutMs, fromIndex) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = frames.slice(fromIndex).find(predicate);
        if (match !== undefined) return match;
        if (Date.now() > deadline) throw new Error("no settled state event arrived within " + Math.round(timeoutMs / 1000) + "s; last revision " + (frames.at(-1)?.revision ?? "none"));
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: async () => { controller.abort(); await started.catch(() => {}); },
  };
}

type Turn = { snapshot: Snapshot; added: SnapshotEntry[]; results: SnapshotEntry[]; assistants: SnapshotEntry[]; errored: SnapshotEntry[] };

/**
 * Submit one turn and settle it on the stream rather than on a bare idle poll: admission is a new entry carrying this
 * turn's text, and settlement is an idle state event at a higher revision with that entry present. The turn's own new
 * entries are then a fact of the stream, not the whole history re-examined. `expect` names the tool output this turn
 * must have produced; every named output is asserted present and successful.
 */
async function turn(events: Events, origin: string, headers: HeadersInit, id: string, text: string, needle: string, expect: readonly string[] = [], timeoutMs = 240000): Promise<Turn> {
  const base = events.latest();
  const fromIndex = events.frames.length;
  const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: crypto.randomUUID(), text }) });
  if (submit.status !== 202) throw new Error("submit failed: " + submit.status + " " + sanitize(await submit.text()));
  // The submitted text is stored as the expansion of the command, so a prompt with no placeholders stores the same
  // text every time. The turn is therefore identified by the last user entry — this turn's, since the run's own entries
  // follow it — and by the transcript having grown past the baseline, never by a text that earlier turns also hold.
  const lastUser = (frame: Snapshot) => frame.entries.filter((entry) => entry.role === "user").at(-1);
  const settled = await events.waitFor((frame) => !frame.busy && frame.revision > base.revision && frame.entries.length > base.entries.length && lastUser(frame)?.text.includes(needle) === true, timeoutMs, fromIndex);
  const baseIds = new Set(base.entries.map((entry) => entry.id));
  const added = settled.entries.filter((entry) => !baseIds.has(entry.id));
  check(added.some((entry) => entry.role === "user" && entry.text.includes(needle)), "the turn was admitted as a new durable entry");
  const assistants = added.filter((entry) => entry.role === "assistant");
  const results = added.filter((entry) => entry.role === "toolResult");
  check(assistants.length >= 1, "the turn produced an assistant entry (" + assistants.length + ")");
  check(assistants.every((entry) => entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted" && entry.message.errorMessage === undefined), "no assistant entry failed or was aborted (" + assistants.map((entry) => entry.message.stopReason).join(",") + ")");
  const last = assistants.at(-1);
  check(last?.message.stopReason === "stop" || last?.message.stopReason === "length", "the final assistant entry completed normally (" + last?.message.stopReason + ")");
  const errored = results.filter((entry) => entry.message.isError === true);
  if (errored.length > 0) note("the model ran " + errored.length + " tool call(s) this turn that failed (" + errored.map((entry) => entry.message.toolName ?? "tool").join(",") + "); no result this smoke relies on failed");
  for (const wanted of expect) {
    const matched = results.filter((entry) => entry.text.includes(wanted));
    check(matched.length >= 1, "this turn's new tool results include " + JSON.stringify(wanted));
    check(matched.every((entry) => entry.message.isError !== true), "the tool result carrying " + JSON.stringify(wanted) + " is not an error");
  }
  return { snapshot: settled, added, results, assistants, errored };
}

async function state(origin: string, headers: HeadersInit, id: string): Promise<Snapshot> {
  return await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json() as Snapshot;
}

async function commands(origin: string, headers: HeadersInit, id: string): Promise<string[]> {
  const body = await (await fetch(origin + "/api/conversations/" + id + "/commands", { headers })).json() as { commands: { name: string }[] };
  return body.commands.map((command) => command.name).sort();
}

async function reload(origin: string, headers: HeadersInit, id: string): Promise<{ status: number; body: { error?: string; resources?: unknown } }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/reload", { method: "POST", headers });
  return { status: response.status, body: await response.json() as { error?: string } };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address !== "object") { probe.close(); reject(new Error("no port")); return; }
      const port = address.port;
      probe.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.status < 500) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const base = await mkdtemp(join(tmpdir(), "hepi-real-smoke-"));
const children: ChildProcess[] = [];
const closers: (() => Promise<void>)[] = [];
let exitCode = 0;
try {
  console.log("== fixture " + base);
  const provider = await readProviderEnv();
  console.log("   provider " + provider.provider + " / model " + provider.modelId);
  const agentDir = await writePiAgentDir(base, provider);
  const host = await writeExecutionHost(base);
  const dbPath = join(base, "conversations.sqlite");
  const marketPath = join(base, "skill-repository.sqlite");

  const { GatewayRpcServer, LocalGateway } = await import("../../../packages/gateway/src/index.ts");
  const { LocalFilesystem } = await import("../../../packages/gateway/src/filesystem.ts");
  const { LocalInstallServer } = await import("../../../packages/gateway/src/install.ts");
  const { loadPiConfig } = await import("../src/pi-config.ts");
  const { createBackendServer } = await import("../src/server.ts");
  const { createWorkspaceResources } = await import("../src/workspace-resources.ts");
  const { createSkillMarket } = await import("../src/skill-repository.ts");

  const workspaces = new WorkspaceRegistry([{ id: "local", root: host.root }]);
  const identity = { user: process.env.USER ?? "smoke", home: host.home };
  const files = new LocalFilesystem(workspaces, { identity });
  const installs = new LocalInstallServer(workspaces, { identity });
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "smoke-gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files, installs);
  await new Promise<void>((r) => gateway.server.listen(0, "127.0.0.1", r));
  const gatewayPort = (gateway.server.address() as { port: number }).port;
  closers.push(async () => { gateway.server.closeAllConnections(); await gateway.close(); });
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayPort, gatewayToken: "smoke-gateway-token" };
  const headers = { authorization: "Bearer smoke-server-token", "content-type": "application/json" };

  const piConfig = await loadPiConfig({ HEPI_CONFIG_SOURCE: "pi", PI_CODING_AGENT_DIR: agentDir, HEPI_PROVIDER: provider.provider, HEPI_MODEL: provider.modelId } as NodeJS.ProcessEnv);
  if (piConfig === undefined) throw new Error("pi configuration did not load");
  // This smoke always passes an explicit HEPI_PROVIDER/HEPI_MODEL pair, which is strict: it must resolve.
  if (piConfig.defaultModel === undefined) throw new Error("the explicit smoke model did not resolve in the pi catalog");
  console.log("   pi mode default model " + piConfig.defaultModel.provider + "/" + piConfig.defaultModel.modelId + ", thinking " + piConfig.defaultThinkingLevel);

  const market = createSkillMarket({ path: marketPath, sources: [] });
  closers.push(async () => market.close());

  const startBackend = async (db = dbPath): Promise<{ origin: string; close: () => Promise<void> }> => {
    const backend = await createBackendServer({
      dbPath: db,
      authToken: "smoke-server-token",
      models: piConfig.models,
      defaultModel: piConfig.defaultModel,
      defaultThinkingLevel: piConfig.defaultThinkingLevel,
      workspaces: [binding],
      workspaceResources: createWorkspaceResources({ projectTrusted: true, enableSkillCommands: piConfig.resourceSettings.enableSkillCommands, diagnostics: () => {} }),
      skillMarket: market,
    });
    await new Promise<void>((r) => backend.server.listen(0, "127.0.0.1", r));
    const port = (backend.server.address() as { port: number }).port;
    return { origin: "http://127.0.0.1:" + port, close: async () => { backend.server.closeAllConnections(); await backend.close(); } };
  };

  let backend = await startBackend();
  closers.push(async () => backend.close());
  console.log("== backend " + backend.origin);

  const created = await (await fetch(backend.origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) })).json() as { conversationId: string };
  const id = created.conversationId;
  let events = openEvents(backend.origin, headers, id);
  await events.waitFor(() => true, 15000, 0);
  console.log("   conversation " + id);

  // 1. Adoption and discovery: the first turn loads the execution host, and the command list is the adopted catalog.
  console.log("== step 1: discovery and /skill expansion");
  const first = await turn(events, backend.origin, headers, id, "Use the read tool on notes.txt and reply with its exact content on one line.", "notes.txt", ["smoke-notes-exact-bytes"]);
  check(first.results.length >= 1, "turn 1 produced a tool result (" + first.results.length + ")");
  // The read tool returns the selected line bounded by its own head truncation. This file is one short line plus one
  // newline, so the result is the file's bytes exactly, trailing newline included and no truncation notice appended.
  const notesResult = first.results.find((entry) => entry.text.includes("smoke-notes-exact-bytes"));
  check(notesResult?.text === host.notesBytes, "an ordinary read returned the file's exact bytes: " + JSON.stringify(notesResult?.text));
  check(notesResult?.text?.endsWith("\n") === true, "the read result keeps the file's trailing newline");
  check((notesResult?.text?.length ?? 0) < 512, "the read result carries no truncation or diagnostic text beyond the bytes");
  const summary = first.snapshot.resources;
  check(summary?.status === "loaded", "resource state loaded: " + JSON.stringify(summary));
  check(summary?.skills === 2 && summary?.prompts === 2, "adopted 2 skills and 2 prompts from the execution host");
  const listed = await commands(backend.origin, headers, id);
  check(listed.includes("skill:deploy") && listed.includes("skill:global-notes") && listed.includes("ship"), "command list is the adopted catalog: " + listed.join(","));

  // 2. A harmless script of our own, run through the gateway bash tool, and the expanded skill command.
  console.log("== step 2: script execution and skill command expansion");
  const second = await turn(events, backend.origin, headers, id, "Run this with the bash tool: sh .agents/skills/deploy/scripts/run.sh  — then reply with the script's output on one line.", "run.sh", ["smoke-script-ok"]);
  check(second.results.some((entry) => entry.text.includes("smoke-script-ok")), "the workspace script ran through the gateway and printed its output");
  const expanded = await turn(events, backend.origin, headers, id, "/skill:deploy production", "production");
  const expandedUser = expanded.added.find((entry) => entry.role === "user");
  check(expandedUser?.text?.includes('<skill name="deploy"') === true, "/skill:deploy expanded into a skill block");
  check(expandedUser?.text?.includes("References are relative to") === true, "the expansion carries the real host base directory");
  check(expandedUser?.text?.includes("Deploy steps v1.") === true, "the expansion carries the skill body read from the host");
  check(expandedUser?.text?.includes("production") === true, "command arguments are appended");
  check(expandedUser?.text?.includes("pi-resource://") === false, "no legacy resource URI appears");

  // 3. Edits on disk plus explicit Reload: the next turn expands the new body.
  console.log("== step 3: prompt/skill edit and explicit Reload");
  await writeFile(join(host.root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps v2.\n");
  await writeFile(join(host.root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it v2.\nArgs: $@\n");
  const beforeReload = await turn(events, backend.origin, headers, id, "/ship before reload", "Ship it v1.");
  const beforeReloadUser = beforeReload.added.find((entry) => entry.role === "user");
  check(beforeReloadUser?.text?.includes("Ship it v1.") === true, "before the Reload the committed prompt template still expands to its adopted text");
  check(beforeReloadUser?.text?.includes("Ship it v2.") === false, "the edited template is not used before the Reload");
  check(beforeReloadUser?.text?.includes("Args: before reload") === true, "the prompt template substituted $@ with the command's arguments: " + JSON.stringify(beforeReloadUser?.text?.slice(0, 120)));
  check(beforeReloadUser?.text?.includes("$@") === false, "no placeholder text survived the substitution");
  const reloaded = await reload(backend.origin, headers, id);
  check(reloaded.status === 200, "explicit Reload succeeded: " + JSON.stringify(reloaded.body.resources ?? reloaded.body.error));
  const afterReload = await turn(events, backend.origin, headers, id, "/skill:deploy again", "again");
  const afterReloadUser = afterReload.added.find((entry) => entry.role === "user");
  check(afterReloadUser?.text?.includes("Deploy steps v2.") === true, "the turn after the Reload expands the edited skill body");
  check(afterReloadUser?.text?.includes("Deploy steps v1.") === false, "the replaced body is no longer used");
  const shipAfterReload = await turn(events, backend.origin, headers, id, "/ship after reload", "Ship it v2.");
  const shipAfterReloadUser = shipAfterReload.added.find((entry) => entry.role === "user");
  check(shipAfterReloadUser?.text?.includes("Ship it v2.") === true, "the turn after the Reload expands the edited prompt template to v2");
  check(shipAfterReloadUser?.text?.includes("Ship it v1.") === false, "the replaced prompt template text is no longer used");
  check(shipAfterReloadUser?.text?.includes("pi-resource://") === false, "no legacy resource URI appears in the prompt expansion");

  // 4. A backend restart with the disk changed again. The committed prompt template is replayed rather than
  // rediscovered, so it still expands to v2 until an explicit Reload; a skill body is read from its host path at
  // expansion time by design, so that expansion already shows the disk.
  console.log("== step 4: backend restart retains the adopted prefix");
  await events.close();
  await backend.close();
  await mkdir(join(host.root, ".agents", "skills", "brand-new"), { recursive: true });
  await writeFile(join(host.root, ".agents", "skills", "brand-new", "SKILL.md"), "---\nname: brand-new\ndescription: Brand new skill\n---\nBrand new body.\n");
  await writeFile(join(host.root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps v3.\n");
  await writeFile(join(host.root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it v3.\nArgs: $@\n");
  backend = await startBackend();
  events = openEvents(backend.origin, headers, id);
  await events.waitFor(() => true, 15000, 0);
  const afterRestart = await commands(backend.origin, headers, id);
  check(afterRestart.includes("skill:brand-new") === false, "the restarted backend did not rediscover the new skill on disk");
  check(afterRestart.includes("skill:deploy") && afterRestart.includes("ship"), "the adopted catalog survived the restart: " + afterRestart.join(","));
  const restartState = await state(backend.origin, headers, id);
  check(restartState.resources?.status === "loaded", "the restarted backend still reports the committed resource state");
  const restartTurn = await turn(events, backend.origin, headers, id, "/skill:deploy after restart", "after restart");
  const restartUser = restartTurn.added.find((entry) => entry.role === "user");
  check(restartUser?.text?.includes('<skill name="deploy"') === true, "the replayed catalog still expands /skill:deploy");
  check(restartUser?.text?.includes("Deploy steps v3.") === true, "the skill body is read from the host at expansion time, as designed");
  const shipAfterRestart = await turn(events, backend.origin, headers, id, "/ship across the restart", "Ship it v2.");
  const shipAfterRestartUser = shipAfterRestart.added.find((entry) => entry.role === "user");
  check(shipAfterRestartUser?.text?.includes("Ship it v2.") === true, "the restarted backend replays the committed prompt template (v2), not the disk's v3");
  check(shipAfterRestartUser?.text?.includes("Ship it v3.") === false, "the edited template is not rediscovered without a Reload");
  const reloadAfterRestart = await reload(backend.origin, headers, id);
  check(reloadAfterRestart.status === 200, "an explicit Reload after the restart succeeds");
  const adopted = await commands(backend.origin, headers, id);
  check(adopted.includes("skill:brand-new"), "the explicit Reload adopted the new skill: " + adopted.join(","));
  const v3 = await turn(events, backend.origin, headers, id, "/skill:deploy now", "now");
  const v3User = v3.added.find((entry) => entry.role === "user");
  check(v3User?.text?.includes("Deploy steps v3.") === true, "the adopted reload reads the current host body");
  // The stored text is the expansion, so the needle names the committed template text, not the command line.
  const shipAfterRestartReload = await turn(events, backend.origin, headers, id, "/ship now", "Ship it v3.");
  const shipAfterRestartReloadUser = shipAfterRestartReload.added.find((entry) => entry.role === "user");
  check(shipAfterRestartReloadUser?.text?.includes("Ship it v3.") === true, "the Reload after the restart committed the disk's prompt template v3");
  check(shipAfterRestartReloadUser?.text?.includes("Ship it v2.") === false, "the pre-restart template text is no longer used once the Reload committed v3");

  // 5. The real UI: publish, install, edit the installed file, and confirm the update that keeps a backup.
  if (withUi) {
    console.log("== step 5: local UI (Playwright) publish/install/update");
    const uiPort = await freePort();
    const uiEnv = { ...process.env, HEPI_SERVER_URL: backend.origin, HEPI_AUTH_TOKEN: "smoke-server-token", PORT: String(uiPort), NODE_ENV: "production" };
    const ui = spawn(process.execPath, [join(webRoot, "node_modules", "next", "dist", "bin", "next"), "start", "-H", "127.0.0.1", "-p", String(uiPort)], { cwd: webRoot, env: uiEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.push(ui);
    const uiLog: string[] = [];
    ui.stdout?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
    ui.stderr?.on("data", (chunk: Buffer) => uiLog.push(chunk.toString()));
    const uiOrigin = "http://127.0.0.1:" + uiPort;
    const up = await waitForHttp(uiOrigin, 60000);
    check(up, "the local UI started" + (up ? "" : " (log tail: " + uiLog.join("").slice(-300) + ")"));
    if (up) {
      const { chromium } = await import(join(webRoot, "node_modules", "playwright", "index.mjs"));
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error: Error) => pageErrors.push(error.message));
        await page.goto(uiOrigin + "/?session=" + id);
        const password = page.locator('input[type="password"]');
        if (await password.count()) {
          await password.fill("smoke-server-token");
          await page.locator('button[type="submit"]').click();
        }
        await page.locator("textarea").first().waitFor({ timeout: 30000 });
        check(true, "the browser authenticated and the composer appeared");
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "Skill market", exact: true }).click();
        await page.getByRole("tab", { name: "Repository" }).click();
        await page.getByRole("button", { name: "Publish a version" }).click();
        const publishPanel = page.locator(".config-detail").first();
        await publishPanel.getByText("Name", { exact: true }).locator("..").locator("input").fill("smoke-bundle");
        await publishPanel.getByText("Version", { exact: true }).locator("..").locator("input").fill("1.0.0");
        await publishPanel.getByText("SKILL.md", { exact: true }).locator("..").locator("textarea").fill("---\nname: smoke-bundle\ndescription: Smoke bundle\n---\nBundle body v1.\n");
        await publishPanel.getByRole("button", { name: "Add file" }).click();
        await publishPanel.getByLabel("Path").fill("notes.md");
        await publishPanel.getByLabel("Content").fill("bundle note v1\n");
        await publishPanel.getByRole("button", { name: "Publish", exact: true }).click();
        await page.locator(".market-card", { hasText: "smoke-bundle" }).waitFor({ timeout: 20000 });
        check(true, "the UI published a bundle version and the repository lists it");

        // The preview is the surface that names the conversation an installation targets, so the published bundle is
        // opened from the market list, where the same conversation is bound.
        await page.getByRole("tab", { name: "Market" }).click();
        await page.getByLabel("Search skills").fill("smoke-bundle");
        await page.locator(".market-card", { hasText: "smoke-bundle" }).first().click();
        const preview = page.getByRole("dialog", { name: "smoke-bundle" });
        await preview.getByText("Bundle body v1.").waitFor({ timeout: 20000 });
        check(true, "the UI opened the published bundle's preview from the market");
        await preview.getByRole("radio", { name: "Workspace (project)" }).click();
        await preview.getByRole("button", { name: "Install", exact: true }).click();
        // A confirmed installation swaps the install controls for the update controls: the host now holds the skill at
        // this scope. The install notice itself is part of the controls that just disappeared, so this is the signal.
        await preview.getByRole("button", { name: "Update", exact: true }).waitFor({ timeout: 30000 });
        check(true, "the UI installed the bundle into the workspace scope");
        const installedDir = join(host.root, ".agents", "skills", "smoke-bundle");
        const installedSkill = await readFile(join(installedDir, "SKILL.md"), "utf8");
        check(installedSkill.includes("Bundle body v1."), "the installed SKILL.md holds the published bytes");
        check((await readFile(join(installedDir, "notes.md"), "utf8")) === "bundle note v1\n", "the installed extra file holds the published bytes");
        const adoptedAfterInstall = await commands(backend.origin, headers, id);
        check(adoptedAfterInstall.includes("skill:smoke-bundle"), "the installing conversation adopted the new skill: " + adoptedAfterInstall.join(","));

        await writeFile(join(installedDir, "notes.md"), "locally edited note\n");
        // Re-open the preview so it re-reads the host: the state now reports the local edit rather than the baseline.
        await preview.getByRole("button", { name: "Close" }).click();
        await page.locator(".market-card", { hasText: "smoke-bundle" }).first().click();
        const reopened = page.getByRole("dialog", { name: "smoke-bundle" });
        await reopened.waitFor({ timeout: 20000 });
        // The state is per scope, so the workspace scope has to be chosen again before the host is asked about it.
        await reopened.getByRole("radio", { name: "Workspace (project)" }).click();
        await reopened.getByRole("button", { name: "Update", exact: true }).click();
        // A locally modified installation is never replaced on one press: the state is named and the replacement needs
        // a second, explicit confirmation.
        await page.getByText(/This installed skill has local changes/).first().waitFor({ timeout: 20000 });
        check(true, "the UI reported the installed skill as locally modified and asked for confirmation");
        await page.getByRole("button", { name: "Replace anyway" }).click();
        const updateNotice = page.getByText(/^Updated smoke-bundle \(workspace\)/);
        await updateNotice.waitFor({ timeout: 30000 });
        const noticeText = await updateNotice.innerText();
        check(noticeText.includes("previous directory kept at"), "the update reported the retained backup: " + noticeText);
        const backupPath = /previous directory kept at ([^)]+)/.exec(noticeText)?.[1] ?? "";
        check(backupPath !== "" && (await stat(backupPath)).isDirectory(), "the retained backup directory exists");
        check((await readFile(join(backupPath, "notes.md"), "utf8")) === "locally edited note\n", "the backup holds the locally modified bytes");
        check((await readFile(join(installedDir, "notes.md"), "utf8")) === "bundle note v1\n", "the replacement restored the published bytes");
        check((await readdir(installedDir)).sort().join(",") === "SKILL.md,notes.md", "the installed directory holds exactly the bundle files");
        check(pageErrors.length === 0, "no page error occurred during the UI steps" + (pageErrors.length === 0 ? "" : ": " + pageErrors.join(" | ")));
      } finally {
        await browser.close();
      }
    }
  } else {
    note("UI step skipped by --no-ui");
  }

  // The fixture's own script is the only executable content this run touched, and its bytes are unchanged: nothing
  // downloaded or untrusted was executed, and the temporary fixture is removed when the run ends.
  check((await readFile(join(host.root, ".agents", "skills", "deploy", "scripts", "run.sh"), "utf8")) === host.scriptBytes, "the fixture's own script bytes are unchanged");

  await events.close();
  const finalState = await state(backend.origin, headers, id);
  // The stream and the state endpoint must agree: every settled stream revision is at or behind the durable state, and
  // no entry the stream reported is missing from it.
  check(events.frames.length > 0 && events.latest().revision <= finalState.revision, "the settled stream revision is not ahead of the durable state (" + events.latest().revision + " <= " + finalState.revision + ")");
  // Every result this smoke relied on is in the durable transcript too, successfully, and the entries the stream
  // reported are a prefix of the durable state.
  const durableIds = new Set(finalState.entries.map((entry) => entry.id));
  check(events.frames.every((frame) => frame.entries.every((entry) => durableIds.has(entry.id))), "every entry the stream reported is present in the durable transcript");
  for (const reliedOn of ["smoke-notes-exact-bytes", "smoke-script-ok"]) {
    const durableMatch = finalState.entries.filter((entry) => entry.role === "toolResult" && entry.text.includes(reliedOn));
    check(durableMatch.length >= 1 && durableMatch.every((entry) => entry.message.isError !== true), "the durable transcript holds the successful result for " + JSON.stringify(reliedOn));
  }
  const finalAssistants = finalState.entries.filter((entry) => entry.role === "assistant");
  check(finalAssistants.length > 0 && finalAssistants.every((entry) => entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted" && entry.message.errorMessage === undefined), "no assistant entry in the durable transcript failed or was aborted");
  console.log("== durable transcript (" + finalState.entries.length + " entries, " + events.frames.length + " stream state events)");
  for (const entry of finalState.entries) console.log("   " + entry.role.padEnd(11) + " " + JSON.stringify(entry.text.slice(0, 110)));
} catch (error) {
  failures.push("smoke threw: " + sanitizeError(error));
  console.log("  FAIL smoke threw: " + sanitizeError(error));
} finally {
  for (const close of closers.reverse()) await close().catch(() => {});
  for (const child of children) { if (child.exitCode === null) child.kill("SIGTERM"); }
  if (!keep) await rm(base, { recursive: true, force: true });
  else console.log("fixture kept at " + base);
}

console.log("== result: " + (failures.length === 0 ? "PASS" : failures.length + " FAILED CHECK(S)"));
for (const failure of failures) console.log("   - " + failure);
for (const noteText of notes) console.log("   note: " + noteText);
exitCode = failures.length === 0 ? 0 : 1;
process.exit(exitCode);
