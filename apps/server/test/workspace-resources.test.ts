import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSyntheticSourceInfo, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { openServerHarness } from "../src/harness.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { streamFolder, type HeldWindow } from "./stream-window.ts";
import { migrateLegacySkillsState, createWorkspaceResources, LegacyWorkspaceSkillsDoc, visibleContextFiles, WorkspaceResourcesDoc, type LegacySkillCatalogEntry, type LegacyWorkspaceSkillsState, type ResourceSummary } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/** Every message of one request, so a test can assert what the model was actually shown. */
function transcriptText(messages: readonly Message[]): string {
  return messages.map((message) => message.role === "system" ? contentText(message.content) + "\n" + JSON.stringify(message.sections ?? {}) : message.role === "user" ? contentText(message.content) : "").join("\n");
}

/**
 * A local gateway over a temporary execution account home and a temporary repository, plus a backend bound to one of its
 * workspaces. The account home is deliberately unrelated to the harness home, so a resource found there can only have
 * come from the execution host the environment resolved.
 */
async function fixture(t: { after(fn: () => unknown): void }, transcript?: string[], options: { projectTrusted?: boolean; enableSkillCommands?: boolean; shadowedContextFile?: (repository: string) => string; diagnostics?: string[] } = {}) {
  const base = await mkdtemp(join(tmpdir(), "hepi-resources-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  const root = join(repository, "app");
  const other = join(base, "other");
  const outside = join(base, "outside");
  await mkdir(join(home, ".agents", "skills", "global-notes"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(repository, ".agents", "skills", "ancestor"), { recursive: true });
  await mkdir(join(root, ".agents", "skills", "deploy"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  await mkdir(join(repository, ".git"));
  await mkdir(other, { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nGlobal notes body.\n");
  await writeFile(join(repository, ".agents", "skills", "ancestor", "SKILL.md"), "---\nname: ancestor\ndescription: Ancestor rule\n---\nAncestor body.\n");
  await writeFile(join(root, ".agents", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Deploy the app\n---\nDeploy steps.\n");
  await writeFile(join(home, ".pi", "agent", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1 with $2.\n");
  // A same-name prompt in both roots, so the catalog shows which root won the collision and the loser is reported.
  await writeFile(join(root, ".pi", "prompts", "summarize.md"), "---\ndescription: Project summarize\n---\nProject summarize $1.\n");
  await writeFile(join(root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nShip it.\n");
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "GLOBAL SYSTEM PROMPT");
  await writeFile(join(home, ".pi", "agent", "APPEND_SYSTEM.md"), "GLOBAL APPEND");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "GLOBAL CONTEXT");
  await writeFile(join(home, ".pi", "agent", "auth.json"), '{"local":{"key":"SECRET-EXECUTION-ACCOUNT"}}');
  await writeFile(join(root, ".pi", "SYSTEM.md"), "PROJECT SYSTEM PROMPT");
  await writeFile(join(root, ".pi", "APPEND_SYSTEM.md"), "PROJECT APPEND");
  await writeFile(join(repository, "AGENTS.md"), "ANCESTOR CONTEXT");
  await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT");

  const workspaces = new WorkspaceRegistry([{ id: "local", root }, { id: "second", root: other }]);
  // A local gateway cannot be a linked worktree here, so the shadowed context path the host would resolve for one is
  // injected exactly as the gateway would report it: the loader must drop that file and keep the others.
  const shadowed = options.shadowedContextFile?.(repository);
  const gatewayFiles = (): LocalFilesystem => {
    const files = new LocalFilesystem(workspaces, { identity: { user: "operator", home } });
    if (shadowed === undefined) return files;
    return new (class extends LocalFilesystem {
      override async execute(request: Parameters<LocalFilesystem["execute"]>[0]): Promise<unknown> {
        const result = await super.execute(request) as { ok?: boolean; value?: Record<string, unknown> };
        if (result.ok !== true || result.value === undefined) return result;
        if (request.method === "executionHost") return { ...result, value: { ...result.value, shadowedContextFile: shadowed } };
        // A discovery reports the host it resolved, so the shadow the host would report appears inside the snapshot too.
        if (request.method === "resourceSnapshot") {
          const host = result.value.host as Record<string, unknown> | undefined;
          return host === undefined ? result : { ...result, value: { ...result.value, host: { ...host, shadowedContextFile: shadowed } } };
        }
        return result;
      }
    })(workspaces, { identity: { user: "operator", home } });
  };
  // The execution host is a separate process in production: a test can disconnect it, and reconnect it on a fresh port
  // over the same account home and repository.
  const gateways: GatewayRpcServer[] = [];
  const startGateway = async (): Promise<{ id: string; gatewayId: string; gatewayOrigin: string; gatewayToken: string }> => {
    const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, gatewayFiles());
    gateways.push(gateway);
    await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
    const address = gateway.server.address();
    assert.ok(address !== null && typeof address === "object");
    return { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  };
  const closeGateways = async (): Promise<void> => { for (const gateway of gateways.splice(0)) await gateway.close(); };
  const binding = await startGateway();
  const bindings = [binding, { ...binding, id: "second" }];

  const faux = fauxProvider();
  // One recorder factory serves every run, including after a restart: it captures what the model was actually shown and
  // answers from the live queue, re-arming itself because a provider consumes each queued step once.
  const responses: FauxResponseStep[] = [];
  // A deterministic provider gate: no sleeps. A test arms `pending.promise` before submitting and the next provider
  // request waits on it, which holds a run open while the test issues a Reload.
  const pending: { promise?: Promise<void> } = {};
  const recorder: FauxResponseFactory = async (context): Promise<AssistantMessage> => {
    faux.appendResponses([recorder]);
    transcript?.push(transcriptText(context.messages));
    const held = pending.promise;
    if (held !== undefined) { pending.promise = undefined; await held; }
    const step = responses.shift();
    return step === undefined || typeof step === "function" ? fauxAssistantMessage("done") : step;
  };
  faux.setResponses([recorder]);
  const models = createModels();
  models.setProvider(faux.provider);
  const dbPath = join(base, "resources.sqlite");
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  const opened: BackendServer[] = [];
  const startBackend = async (bound = bindings, db = dbPath): Promise<string> => {
    const backend = await createBackendServer({ dbPath: db, authToken: "server-token", models, workspaces: bound, workspaceResources: createWorkspaceResources({ diagnostics: (message: string) => options.diagnostics?.push(message), projectTrusted: options.projectTrusted ?? true, ...(options.enableSkillCommands === undefined ? {} : { enableSkillCommands: options.enableSkillCommands }) }), defaultModel: SERVER_MODEL });
    opened.push(backend);
    await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
    const serverAddress = backend.server.address();
    assert.ok(serverAddress !== null && typeof serverAddress === "object");
    return "http://127.0.0.1:" + serverAddress.port;
  };
  const origin = await startBackend();
  t.after(async () => { for (const backend of opened) { backend.server.closeAllConnections(); await backend.close(); } await closeGateways(); await rm(base, { recursive: true, force: true }); });
  return { origin, headers, responses, pending, home, root, repository, outside, dbPath, models, binding, bindings, opened, startBackend, startGateway, closeGateways };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function createConversation(origin: string, headers: HeadersInit, workspaceId: string | null = "local"): Promise<string> {
  const response = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId }) });
  assert.equal(response.status, 201);
  return (await response.json() as { conversationId: string }).conversationId;
}

type Entry = { id: string; role: "user" | "assistant" | "toolResult"; text: string; message: { isError?: boolean } };
/** One frame as the backend wrote it, and the state a client holds after folding it. */
type Observed = { readonly event: string; readonly data: Record<string, unknown>; readonly window: HeldWindow<Entry> };
type Events = { until(predicate: (frame: Observed) => boolean, description: string): Promise<Observed>; close(): Promise<void> };
/** A hang guard, not a timing fact: every wait below settles on a frame the backend wrote. */
const DEADLINE_MS = 10_000;

/**
 * A conversation's event stream, waited on by **barrier** instead of by poll.
 *
 * `until` resolves on the frame that satisfies the predicate, folding every frame through the shared reducer a real
 * client uses, so a wait ends on a byte the backend wrote rather than on the next tick of a sleep loop. The deadline
 * exists only so a frame that never arrives fails the test instead of hanging it, and a stream that ends is a failure
 * for the same reason.
 */
async function follow(origin: string, headers: HeadersInit, id: string): Promise<Events> {
  const response = await fetch(origin + "/api/conversations/" + encodeURIComponent(id) + "/events", { headers });
  assert.equal(response.status, 200);
  const body = response.body!.getReader();
  const decoder = new TextDecoder();
  const folder = streamFolder<Entry>(id);
  const frames: Observed[] = [];
  const waiters = new Set<() => void>();
  let ended = false;
  let pending = "";
  const wake = (): void => { for (const waiter of [...waiters]) waiter(); };
  const pump = (async () => {
    for (;;) {
      const chunk = await body.read().catch(() => ({ done: true as const, value: undefined }));
      if (chunk.done) return;
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const line = raw.split("\n").find((value) => value.startsWith("data: "));
        if (event === undefined || line === undefined) continue;
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event === "snapshot" || event === "state") folder.fold(event, data);
        frames.push({ event, data, window: folder.current() });
        wake();
      }
    }
  })().finally(() => { ended = true; wake(); });
  return {
    until(predicate, description) {
      return new Promise<Observed>((resolve, reject) => {
        const settle = (): void => {
          const at = frames.findIndex(predicate);
          if (at >= 0) { clearTimeout(timer); waiters.delete(settle); resolve(frames.splice(at, 1)[0]!); return; }
          if (!ended) return;
          clearTimeout(timer); waiters.delete(settle);
          reject(new Error("the stream ended before " + description + "; frames: " + frames.map((frame) => frame.event).join(",")));
        };
        const timer = setTimeout(() => { waiters.delete(settle); reject(new Error("timed out waiting for " + description + "; frames: " + frames.map((frame) => frame.event).join(","))); }, DEADLINE_MS);
        waiters.add(settle);
        settle();
      });
    },
    async close() { waiters.clear(); await body.cancel().catch(() => {}); await pump.catch(() => {}); },
  };
}

/**
 * The frame that says the run admitted as `submissionId` is over: no live run, and no outstanding submission left for
 * it. The stream is opened **after** the submit was answered, so its baseline is already the state of this run and can
 * never be a view from before the input was admitted.
 */
const settled = (submissionId: string) => (frame: Observed): boolean =>
  !frame.window.busy && (frame.window.submissions ?? []).every((submission) => submission.submissionId !== submissionId);

/** Submit and wait for the settled transcript on the conversation's own stream. */
async function run(origin: string, headers: HeadersInit, id: string, text: string): Promise<{ entries: Entry[] }> {
  const submit = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text }) });
  assert.equal(submit.status, 202, submit.status === 202 ? "" : await submit.text());
  const { submissionId } = await submit.json() as { submissionId: string };
  const events = await follow(origin, headers, id);
  try {
    const { window } = await events.until(settled(submissionId), "the run of " + JSON.stringify(text) + " to settle");
    return { entries: window.entries };
  } finally { await events.close(); }
}

/** Wait for the conversation's own stream to state a live run, without a timing sleep. */
async function waitBusy(origin: string, headers: HeadersInit, id: string): Promise<void> {
  const events = await follow(origin, headers, id);
  try { await events.until((frame) => frame.window.busy, "the conversation to report a live run"); }
  finally { await events.close(); }
}

/** Submit without waiting for settlement, so a run can be held open at the provider. */
async function submit(origin: string, headers: HeadersInit, id: string, text: string, whenBusy?: "steer" | "followUp"): Promise<number> {
  const response = await fetch(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text, ...(whenBusy === undefined ? {} : { whenBusy }) }) });
  return response.status;
}

async function reload(origin: string, headers: HeadersInit, id: string): Promise<{ status: number; body: { error?: string; resources?: ResourceSummary } }> {
  const response = await fetch(origin + "/api/conversations/" + id + "/reload", { method: "POST", headers });
  return { status: response.status, body: await response.json() as { error?: string; resources?: ResourceSummary } };
}

async function stateResources(origin: string, headers: HeadersInit, id: string): Promise<ResourceSummary> {
  const current = await (await fetch(origin + "/api/conversations/" + id + "/state", { headers })).json() as { resources?: ResourceSummary };
  assert.ok(current.resources !== undefined, "the state snapshot carries committed resource state");
  return current.resources;
}

async function commands(server: Fixture, id: string): Promise<string[]> {
  const body = await (await fetch(server.origin + "/api/conversations/" + id + "/commands", { headers: server.headers })).json() as { commands: { name: string }[] };
  return body.commands.map((command) => command.name).sort();
}

function order(text: string, ...needles: string[]): void {
  let previous = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle);
    assert.ok(index > previous, needle + " must appear after the previous entry in:\n" + text);
    previous = index;
  }
}

test("adopts system, append, context, prompts and skills from the execution host", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("catalog seen"));
  const id = await createConversation(server.origin, server.headers);
  // The committed loading result is observable on the existing SSE stream, so a reconnecting client sees it too.
  const events = await follow(server.origin, server.headers, id);
  t.after(events.close);
  const baseline = await events.until((frame) => frame.event === "snapshot", "the baseline snapshot");
  assert.equal(baseline.data.protocol, "hepi.v1");
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);
  const seen = transcript.join("\n");
  // Project system and append replace their global counterparts, and the append prompt precedes context and skills.
  assert.match(seen, /PROJECT SYSTEM PROMPT/);
  assert.doesNotMatch(seen, /GLOBAL SYSTEM PROMPT/);
  assert.match(seen, /PROJECT APPEND/);
  assert.doesNotMatch(seen, /GLOBAL APPEND/);
  // Context files follow upstream order: the account directory first, then ancestors outermost first, then the workspace.
  order(seen, "GLOBAL CONTEXT", "ANCESTOR CONTEXT", "PROJECT CONTEXT");
  order(seen, "PROJECT APPEND", "GLOBAL CONTEXT");
  // Skills advertise their real execution-host paths, not a workspace-relative stand-in.
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(seen, new RegExp("<location>" + escape(join(server.home, ".agents", "skills", "global-notes", "SKILL.md")) + "</location>"));
  assert.match(seen, new RegExp("<location>" + escape(join(server.root, ".agents", "skills", "deploy", "SKILL.md")) + "</location>"));
});

test("loads the account and workspace .pi skills roots with upstream precedence and no harness fallback", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  // The account's `.pi/agent/skills` and the workspace's `.pi/skills` are roots too. A duplicate name in each pair
  // proves the precedence: a `.pi` root outranks the `.agents` root of the same scope, and the workspace's own root
  // outranks the account's.
  await mkdir(join(server.home, ".pi", "agent", "skills", "dup"), { recursive: true });
  await writeFile(join(server.home, ".pi", "agent", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account pi duplicate\n---\nAccount pi duplicate body.\n");
  await mkdir(join(server.home, ".agents", "skills", "dup"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account agents duplicate\n---\nAccount agents duplicate body.\n");
  await mkdir(join(server.root, ".pi", "skills", "proj"), { recursive: true });
  await writeFile(join(server.root, ".pi", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Workspace pi skill\n---\nWorkspace pi body.\n");
  await mkdir(join(server.root, ".agents", "skills", "proj"), { recursive: true });
  await writeFile(join(server.root, ".agents", "skills", "proj", "SKILL.md"), "---\nname: proj\ndescription: Workspace agents skill\n---\nWorkspace agents body.\n");
  await mkdir(join(server.home, ".pi", "agent", "skills", "account-only"), { recursive: true });
  await writeFile(join(server.home, ".pi", "agent", "skills", "account-only", "SKILL.md"), "---\nname: account-only\ndescription: Account pi only\n---\nAccount pi only body.\n");
  server.responses.push(fauxAssistantMessage("catalog"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.deepEqual(await commands(server, id), ["ship", "skill:account-only", "skill:ancestor", "skill:deploy", "skill:dup", "skill:global-notes", "skill:proj", "summarize"]);
  const seen = transcript.join("\n");
  assert.ok(seen.includes("<location>" + join(server.home, ".pi", "agent", "skills", "dup", "SKILL.md") + "</location>"), "the account .pi root is advertised");
  assert.ok(seen.includes("<location>" + join(server.root, ".pi", "skills", "proj", "SKILL.md") + "</location>"), "the workspace .pi root is advertised");
  assert.match(seen, /Account pi duplicate/, "the account .pi root wins the duplicate name");
  assert.doesNotMatch(seen, /Account agents duplicate/);
  assert.match(seen, /Workspace pi skill/, "the workspace .pi root wins over its .agents root");
  assert.doesNotMatch(seen, /Workspace agents skill/);
  // Every advertised location is under the execution account home or the bound workspace: nothing comes from the
  // harness home, so a harness-local skill could never stand in for a host one.
  const locations = [...seen.matchAll(/<location>([^<]*)<\/location>/g)].map((match) => match[1]!);
  assert.ok(locations.length >= 6, JSON.stringify(locations));
  for (const location of locations) assert.ok(location.startsWith(server.home) || location.startsWith(server.repository) || location.startsWith(server.root), location + " is not on the execution host");
  // An ordinary read reaches both `.pi` roots at their real host paths.
  server.responses.push(
    fauxAssistantMessage([fauxToolCall("read", { path: join(server.home, ".pi", "agent", "skills", "dup", "SKILL.md") })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: join(server.root, ".pi", "skills", "proj", "SKILL.md") })], { stopReason: "toolUse" }),
    fauxAssistantMessage("read done"),
  );
  const final = await run(server.origin, server.headers, id, "read the pi skills");
  const results = final.entries.filter((entry) => entry.role === "toolResult");
  assert.equal(results.length, 2, JSON.stringify(final.entries));
  assert.match(results[0]!.text, /Account pi duplicate body\./);
  assert.match(results[1]!.text, /Workspace pi body\./);
});

test("expands a prompt template and a skill command from the adopted catalog", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const diagnostics: string[] = [];
  const server = await fixture(t, transcript, { diagnostics });
  const id = await createConversation(server.origin, server.headers);
  server.responses.push(fauxAssistantMessage("adopted"), fauxAssistantMessage("template"), fauxAssistantMessage("skill"));
  await run(server.origin, server.headers, id, "adopt");
  transcript.length = 0;
  await run(server.origin, server.headers, id, "/summarize one two");
  // The same command name exists in the workspace's `.pi/prompts` and the account's prompts directory. Project
  // `local` outranks user `local`, so the workspace file is the one that expands, exactly as upstream's
  // `resourcePrecedenceRank` decides.
  assert.match(transcript.join("\n"), /Project summarize one\./, "the project prompt wins the name collision");
  assert.doesNotMatch(transcript.join("\n"), /Summarize one with two\./, "the account prompt of the same name loses");
  assert.deepEqual(diagnostics, ["prompt summarize from " + join(await realpath(server.home), ".pi", "agent", "prompts", "summarize.md") + " was skipped: " + join(await realpath(server.root), ".pi", "prompts", "summarize.md") + " already declares that name"]);
  transcript.length = 0;
  // The skill body is read from the real host path when the command runs, so editing the file changes the expansion.
  await writeFile(join(server.home, ".agents", "skills", "global-notes", "SKILL.md"), "---\nname: global-notes\ndescription: Take global notes\n---\nEdited body.\n");
  await run(server.origin, server.headers, id, "/skill:global-notes keep this");
  const submitted = transcript.join("\n");
  assert.match(submitted, /Edited body\./, "the command reads the current host file");
  assert.match(submitted, /References are relative to /);
  assert.match(submitted, /keep this/);
});

test("Pi's enableSkillCommands setting hides skill commands without making a skill unreadable", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript, { enableSkillCommands: false });
  const id = await createConversation(server.origin, server.headers);
  server.responses.push(fauxAssistantMessage("adopted"));
  await run(server.origin, server.headers, id, "adopt");
  // Listing follows the setting, exactly as upstream's command list does.
  assert.deepEqual(await commands(server, id), ["ship", "summarize"]);
  // The setting lists commands; it does not uninstall a skill, so an explicit command still expands from the host file.
  transcript.length = 0;
  await run(server.origin, server.headers, id, "/skill:global-notes keep this");
  assert.match(transcript.join("\n"), /Global notes body\./);
});

test("an ordinary read reaches execution-side prompts, context and skills outside the workspace", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  const promptFile = join(server.home, ".pi", "agent", "prompts", "summarize.md");
  const contextFile = join(server.home, ".pi", "agent", "AGENTS.md");
  const skillFile = join(server.home, ".agents", "skills", "global-notes", "SKILL.md");
  const secret = join(server.home, ".pi", "agent", "auth.json");
  server.responses.push(
    fauxAssistantMessage([fauxToolCall("read", { path: promptFile })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: contextFile })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: skillFile })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("read", { path: secret })], { stopReason: "toolUse" }),
    fauxAssistantMessage("reads done"),
  );
  const id = await createConversation(server.origin, server.headers);
  const final = await run(server.origin, server.headers, id, "read the resources");
  const results = final.entries.filter((entry) => entry.role === "toolResult");
  assert.equal(results.length, 4, JSON.stringify(final.entries));
  assert.match(results[0]!.text, /Summarize \$1 with \$2\./);
  assert.match(results[1]!.text, /GLOBAL CONTEXT/);
  assert.match(results[2]!.text, /Global notes body\./);
  // The execution account's other files are not resource roots: its credentials never become readable.
  assert.equal(results[3]!.message.isError, true, JSON.stringify(results[3]));
  assert.doesNotMatch(results[3]!.text, /SECRET-EXECUTION-ACCOUNT/);
});

test("restart replays the adopted result while ordinary reads see current host files", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const first = await fixture(t, transcript);
  first.responses.push(fauxAssistantMessage("first"));
  const id = await createConversation(first.origin, first.headers);
  await run(first.origin, first.headers, id, "first run");
  assert.match(transcript.join("\n"), /PROJECT SYSTEM PROMPT/);
  // The host changes while the conversation is stopped; restart is not a reload.
  await writeFile(join(first.root, ".pi", "SYSTEM.md"), "REWRITTEN SYSTEM");
  await writeFile(join(first.root, "AGENTS.md"), "REWRITTEN CONTEXT");
  await writeFile(join(first.root, ".pi", "prompts", "ship.md"), "---\ndescription: Ship\n---\nRewritten ship.\n");
  for (const backend of first.opened) { backend.server.closeAllConnections(); await backend.close(); }
  transcript.length = 0;
  const restarted = await first.startBackend();
  first.responses.push(fauxAssistantMessage("second"), fauxAssistantMessage("expanded"), fauxAssistantMessage([fauxToolCall("read", { path: join(first.root, "AGENTS.md") })], { stopReason: "toolUse" }), fauxAssistantMessage("read done"));
  await run(restarted, first.headers, id, "second run");
  const seen = transcript.join("\n");
  assert.match(seen, /PROJECT SYSTEM PROMPT/, "the committed prefix is replayed");
  assert.doesNotMatch(seen, /REWRITTEN SYSTEM/, "restart does not rediscover the host");
  // The committed catalog carries the prompt content too, so a command still expands the adopted template.
  assert.deepEqual(await commands({ ...first, origin: restarted } as Fixture, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);
  transcript.length = 0;
  await run(restarted, first.headers, id, "/ship");
  assert.match(transcript.join("\n"), /Ship it\./, "the committed prompt catalog is replayed");
  assert.doesNotMatch(transcript.join("\n"), /Rewritten ship\./, "restart does not rediscover the host");
  transcript.length = 0;
  const final = await run(restarted, first.headers, id, "read the context");
  // Persisted resource state is not a frozen directory: an ordinary read still sees the current host file.
  const read = final.entries.find((entry) => entry.role === "toolResult");
  assert.ok(read !== undefined, JSON.stringify(final.entries));
  assert.match(read.text, /REWRITTEN CONTEXT/);
});

test("project trust off keeps project prompts, system prompt and project .pi skills out while context still loads", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript, { projectTrusted: false });
  // A workspace `.pi/skills` root is upstream's project `local` resource, so project trust gates it exactly as it gates
  // the workspace's `.pi` prompts; the `.agents/skills` roots are auto-discovered host content and still load.
  await mkdir(join(server.root, ".pi", "skills", "trusted-only"), { recursive: true });
  await writeFile(join(server.root, ".pi", "skills", "trusted-only", "SKILL.md"), "---\nname: trusted-only\ndescription: Needs project trust\n---\nTrusted only body.\n");
  server.responses.push(fauxAssistantMessage("untrusted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.deepEqual(await commands(server, id), ["skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);
  assert.doesNotMatch(transcript.join("\n"), /Needs project trust/);
  const seen = transcript.join("\n");
  assert.match(seen, /GLOBAL SYSTEM PROMPT/);
  assert.doesNotMatch(seen, /PROJECT SYSTEM PROMPT/);
  assert.doesNotMatch(seen, /Ship it\./);
  // Context files are not gated by project trust upstream, so the workspace and ancestor ones still load.
  assert.match(seen, /PROJECT CONTEXT/);
  assert.match(seen, /ANCESTOR CONTEXT/);
});

test("a malformed skill fails that conversation's load and leaves an adopted conversation usable", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  const adopted = await createConversation(server.origin, server.headers);
  server.responses.push(fauxAssistantMessage("adopted"));
  await run(server.origin, server.headers, adopted, "adopt");
  await writeFile(join(server.home, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\ndescription: [PRIVATE-YAML\n---\nBroken body.\n").catch(async () => {
    await mkdir(join(server.home, ".agents", "skills", "broken"), { recursive: true });
    await writeFile(join(server.home, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\ndescription: [PRIVATE-YAML\n---\nBroken body.\n");
  });
  const fresh = await createConversation(server.origin, server.headers);
  const failed = await fetch(server.origin + "/api/conversations/" + fresh + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "broken", text: "hello" }) });
  assert.equal(failed.status, 500);
  const failure = JSON.stringify(await failed.json());
  assert.match(failure, /malformed frontmatter/);
  assert.doesNotMatch(failure, /PRIVATE-YAML/);
  // The conversation list and a conversation that already adopted stay usable.
  assert.equal((await fetch(server.origin + "/api/conversations", { headers: server.headers })).status, 200);
  server.responses.push(fauxAssistantMessage("still usable"));
  await run(server.origin, server.headers, adopted, "still there");
});

test("an unreadable candidate file fails the load instead of silently dropping it", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  const promptFile = join(server.home, ".pi", "agent", "prompts", "summarize.md");
  const skillFile = join(server.home, ".agents", "skills", "global-notes", "SKILL.md");
  await chmod(promptFile, 0o000);
  try {
    const id = await createConversation(server.origin, server.headers);
    const response = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "unreadable-prompt", text: "hello" }) });
    assert.equal(response.status, 500, await response.text());
  } finally { await chmod(promptFile, 0o644); }
  await chmod(skillFile, 0o000);
  try {
    const id = await createConversation(server.origin, server.headers);
    const response = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "unreadable-skill", text: "hello" }) });
    assert.equal(response.status, 500, await response.text());
  } finally { await chmod(skillFile, 0o644); }
});

test("ignore files exclude candidate skills and symlinks are deduplicated or refused", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  await mkdir(join(server.root, ".agents", "skills", "ignored"), { recursive: true });
  await writeFile(join(server.root, ".agents", "skills", "ignored", "SKILL.md"), "---\nname: ignored\ndescription: Ignored skill\n---\nIgnored body.\n");
  await writeFile(join(server.root, ".agents", "skills", ".gitignore"), "ignored/\n");
  // A supported symlink inside the root resolves to a skill that is already adopted; an escaping one is not followed.
  await symlink(join(server.home, ".agents", "skills", "global-notes"), join(server.home, ".agents", "skills", "zzz-alias"));
  await writeFile(join(server.outside, "SKILL.md"), "---\nname: leak\ndescription: Outside description\n---\nOutside body.\n");
  await symlink(join(server.outside), join(server.home, ".agents", "skills", "leak"));
  server.responses.push(fauxAssistantMessage("catalog"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);
  const seen = transcript.join("\n");
  assert.doesNotMatch(seen, /Ignored skill/);
  assert.doesNotMatch(seen, /Outside description/);
  assert.equal((seen.match(/<name>global-notes<\/name>/g) ?? []).length, 1, "the alias is adopted once");
});

test("a self-referential symlink directory terminates and ignore rules match the logical link path", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  const skills = join(server.root, ".agents", "skills");
  await mkdir(join(skills, "looped"), { recursive: true });
  await writeFile(join(skills, "looped", "SKILL.md"), "---\nname: looped\ndescription: Looped skill\n---\nLooped body.\n");
  // Links that reach an ancestor of the tree, and the tree itself: without a visited-directory guard the walk never ends.
  await symlink(skills, join(skills, "looped", "self"));
  await symlink(skills, join(skills, "up"));
  // The ignore rule names the real directory, and the link is the only way in: upstream matches the logical entry path,
  // so following the link is what discovers this skill.
  await mkdir(join(skills, "keep", "secret"), { recursive: true });
  await writeFile(join(skills, "keep", "secret", "SKILL.md"), "---\nname: secret\ndescription: Reachable only through the link\n---\nSecret body.\n");
  await symlink(join(skills, "keep", "secret"), join(skills, "public"));
  await writeFile(join(skills, ".gitignore"), "keep/\n");
  server.responses.push(fauxAssistantMessage("loop"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "skill:looped", "skill:secret", "summarize"]);
  const seen = transcript.join("\n");
  assert.equal((seen.match(/<name>looped<\/name>/g) ?? []).length, 1, "a looped directory is adopted once");
  assert.match(seen, /Reachable only through the link/, "the ignore rule is matched against the logical link path");
});

test("a worktree-shadowed context file is dropped, and a self-referential symlink terminates", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  // The gateway reports a linked worktree's main-repo context file as shadowed; the loader drops exactly that file and
  // keeps the worktree's own. An absent field is not a shadow, so an ordinary repo is unaffected.
  assert.deepEqual(visibleContextFiles(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(visibleContextFiles(["a"], undefined), ["a"]);
  server.responses.push(fauxAssistantMessage("shadow"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "what resources do you have");
  assert.match(transcript.join("\n"), /PROJECT CONTEXT/);
  assert.match(transcript.join("\n"), /ANCESTOR CONTEXT/, "an ordinary repo reports no shadow, so the ancestor file stays");

  const worktreeTranscript: string[] = [];
  // A linked worktree whose main repository is the ancestor directory: the main repo's own context file is shadowed.
  const worktree = await fixture(t, worktreeTranscript, { shadowedContextFile: (repository) => join(repository, "AGENTS.md") });
  worktree.responses.push(fauxAssistantMessage("worktree"));
  const worktreeId = await createConversation(worktree.origin, worktree.headers);
  await run(worktree.origin, worktree.headers, worktreeId, "what resources do you have");
  const seen = worktreeTranscript.join("\n");
  assert.match(seen, /PROJECT CONTEXT/, "the worktree's own file is the one in effect");
  assert.doesNotMatch(seen, /ANCESTOR CONTEXT/, "the shadowed main-repo file is dropped");
});

test("a conversation refuses to switch workspace while idle", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  const id = await createConversation(server.origin, server.headers, "local");
  const switched = await fetch(server.origin + "/api/conversations/" + id + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "switch", text: "move me", workspaceId: "second" }) });
  assert.equal(switched.status, 400);
  assert.deepEqual(await switched.json(), { ok: false, code: "workspace_immutable" });
});

test("an unreachable execution host fails that conversation only and permits retry", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  // An unreachable execution host: the workspace is configured, its gateway is not listening.
  const dead = { id: "second", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:1", gatewayToken: "gateway-token" };
  const offlineOrigin = await server.startBackend([dead], server.dbPath + ".offline");
  const broken = await createConversation(offlineOrigin, server.headers, "second");
  const submit = await fetch(offlineOrigin + "/api/conversations/" + broken + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "offline", text: "hello" }) });
  assert.equal(submit.status, 500);
  assert.match(JSON.stringify(await submit.json()), /gateway unavailable|no execution environment/);
  // The conversation list and a healthy conversation are unaffected by that failure.
  assert.equal((await fetch(offlineOrigin + "/api/conversations", { headers: server.headers })).status, 200);
  assert.equal((await fetch(offlineOrigin + "/api/conversations/" + broken + "/state", { headers: server.headers })).status, 200);
  // Retry is allowed: the failed attempt left no adopted catalog behind.
  const retry = await fetch(offlineOrigin + "/api/conversations/" + broken + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "offline-2", text: "hello again" }) });
  assert.equal(retry.status, 500);
});

test("a workspace without an execution host obtains no harness-local resources", { timeout: 15000 }, async (t) => {
  const server = await fixture(t);
  // A conversation created without a workspace: it has no execution host to adopt resources from, which is the
  // browser's own unbound case rather than the runtime's framework root record.
  const unbound = await createConversation(server.origin, server.headers, null);
  const commands = await (await fetch(server.origin + "/api/conversations/" + unbound + "/commands", { headers: server.headers })).json() as { commands: unknown[] };
  assert.deepEqual(commands.commands, []);
  const submit = await fetch(server.origin + "/api/conversations/" + unbound + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "no-env", text: "hello" }) });
  assert.equal(submit.status, 500);
  assert.match(JSON.stringify(await submit.json()), /no execution environment/);
});

test("a stored version-1 resource result migrates to the adopted baseline", () => {
  // A conversation written before the reload schema stored its single committed result as `state`; that result was
  // the adopted baseline, so a restart of an existing database must replay it rather than lose it.
  const migrated = WorkspaceResourcesDoc.definition.migrate!({ state: { status: "failed", error: "old failure", loadedAtMs: 7 } }, 1);
  assert.deepEqual(migrated, { adopted: { status: "failed", error: "old failure", loadedAtMs: 7 } });
  assert.deepEqual(WorkspaceResourcesDoc.definition.migrate!({}, 1), {});
});

test("explicit reload adopts a complete candidate for the next run and keeps it across repeated reloads", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);
  const adopted = await stateResources(server.origin, server.headers, id);
  assert.deepEqual(adopted, { status: "loaded", skills: 3, prompts: 2, loadedAtMs: adopted.status === "loaded" ? adopted.loadedAtMs : 0, pending: false });

  // The host gains one skill and loses one prompt while the conversation is idle.
  await mkdir(join(server.home, ".agents", "skills", "reloaded"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "reloaded", "SKILL.md"), "---\nname: reloaded\ndescription: Reloaded skill\n---\nReloaded body.\n");
  await rm(join(server.root, ".pi", "prompts", "ship.md"));
  const first = await reload(server.origin, server.headers, id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual({ status: first.body.resources?.status, pending: first.body.resources?.pending }, { status: "loaded", pending: false });
  assert.deepEqual(await commands(server, id), ["skill:ancestor", "skill:deploy", "skill:global-notes", "skill:reloaded", "summarize"]);

  // A second reload while idle adopts again; the earlier baseline is not resurrected.
  await mkdir(join(server.home, ".agents", "skills", "again"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "again", "SKILL.md"), "---\nname: again\ndescription: Again skill\n---\nAgain body.\n");
  const second = await reload(server.origin, server.headers, id);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(await commands(server, id), ["skill:again", "skill:ancestor", "skill:deploy", "skill:global-notes", "skill:reloaded", "summarize"]);

  transcript.length = 0;
  server.responses.push(fauxAssistantMessage("next run"));
  await run(server.origin, server.headers, id, "next run");
  const seen = transcript.join("\n");
  assert.match(seen, /Again skill/);
  assert.match(seen, /Reloaded skill/);
  assert.doesNotMatch(seen, /Ship it\./, "the removed prompt is no longer in the prefix");
});

test("a reload during an active run defers to the next run and never reverts an adopted baseline", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");

  // Hold the next run open at the provider, then reload twice while it is active.
  // The held response is a tool call, so releasing it continues the same run into a tool round: the deferred
  // candidate must stay out of that round too.
  let release!: () => void;
  server.pending.promise = new Promise<void>((resolve) => { release = resolve; });
  server.responses.push(fauxAssistantMessage([fauxToolCall("read", { path: join(server.root, "AGENTS.md") })], { stopReason: "toolUse" }));
  assert.equal(await submit(server.origin, server.headers, id, "held run"), 202);
  await waitBusy(server.origin, server.headers, id);

  await mkdir(join(server.home, ".agents", "skills", "mid-one"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "mid-one", "SKILL.md"), "---\nname: mid-one\ndescription: Mid one\n---\nMid one body.\n");
  const first = await reload(server.origin, server.headers, id);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.resources?.pending, true, "a reload during a run is deferred");
  // The host changes again before the second reload, so the latest candidate differs from the first one.
  await rm(join(server.home, ".agents", "skills", "mid-one"), { recursive: true, force: true });
  await mkdir(join(server.home, ".agents", "skills", "mid-two"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "mid-two", "SKILL.md"), "---\nname: mid-two\ndescription: Mid two\n---\nMid two body.\n");
  const second = await reload(server.origin, server.headers, id);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.resources?.pending, true);

  // The in-flight request still sees the catalog its run adopted.
  const inRun = transcript.join("\n");
  assert.match(inRun, /Deploy the app/, "the active run keeps its adopted catalog");
  assert.doesNotMatch(inRun, /Mid one/, "the first deferred candidate is not applied to the active run");
  assert.doesNotMatch(inRun, /Mid two/);

  // The run continues after the reloads: a steer joins the same run, and the held answer starts a tool round. Both
  // keep the run's adopted baseline, so a deferred candidate never changes the prefix of the run that was active.
  transcript.length = 0;
  assert.equal(await submit(server.origin, server.headers, id, "steer text", "steer"), 202);
  release();
  await run(server.origin, server.headers, id, "held run");
  const inRunLater = transcript.join("\n");
  assert.match(inRunLater, /Deploy the app/, "the steering round of the same run keeps the adopted catalog");
  assert.doesNotMatch(inRunLater, /Mid one/, "a deferred candidate is not applied inside the run that was active");
  assert.doesNotMatch(inRunLater, /Mid two/);

  // The next run adopts the latest candidate, not the initial state and not the earlier candidate.
  transcript.length = 0;
  server.responses.push(fauxAssistantMessage("after"));
  await run(server.origin, server.headers, id, "after");
  const next = transcript.join("\n");
  assert.match(next, /Mid two/, "the latest deferred candidate is promoted");
  assert.doesNotMatch(next, /Mid one/, "the earlier candidate is not resurrected");
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "skill:mid-two", "summarize"]);
  assert.equal((await stateResources(server.origin, server.headers, id)).pending, false);
});

test("a failed reload keeps the previous prefix and catalog and reports an explicit error", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  const before = await stateResources(server.origin, server.headers, id);
  // A healthy second conversation adopts first, so the failure below is shown to affect only the reloading one.
  const other = await createConversation(server.origin, server.headers);
  server.responses.push(fauxAssistantMessage("other"), fauxAssistantMessage("still usable"));
  await run(server.origin, server.headers, other, "other conversation");

  // A malformed candidate resource fails the complete load, so nothing is committed.
  await mkdir(join(server.home, ".agents", "skills", "broken"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\ndescription: [PRIVATE-YAML\n---\nBroken body.\n");
  const failed = await reload(server.origin, server.headers, id);
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.match(failed.body.error ?? "", /malformed frontmatter/);
  assert.doesNotMatch(JSON.stringify(failed.body), /PRIVATE-YAML/);
  // The previous result is retained, and the failure is visible on the state snapshot too.
  assert.deepEqual(await stateResources(server.origin, server.headers, id), before);
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:global-notes", "summarize"]);

  // The failure is conversation-scoped: the list and a healthy conversation keep working, and this one still runs.
  assert.equal((await fetch(server.origin + "/api/conversations", { headers: server.headers })).status, 200);
  transcript.length = 0;
  server.responses.push(fauxAssistantMessage("healthy"));
  await run(server.origin, server.headers, id, "still usable");
  assert.match(transcript.join("\n"), /PROJECT SYSTEM PROMPT/, "the retained prefix is replayed after a failed reload");

  // Retry after the host is fixed adopts the new result.
  await rm(join(server.home, ".agents", "skills", "broken"), { recursive: true, force: true });
  await mkdir(join(server.home, ".agents", "skills", "fixed"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "fixed", "SKILL.md"), "---\nname: fixed\ndescription: Fixed skill\n---\nFixed body.\n");
  const retried = await reload(server.origin, server.headers, id);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.deepEqual(await commands(server, id), ["ship", "skill:ancestor", "skill:deploy", "skill:fixed", "skill:global-notes", "summarize"]);
});

test("a reload racing a run start settles deterministically and never mixes prefixes", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const server = await fixture(t, transcript);
  server.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(server.origin, server.headers);
  await run(server.origin, server.headers, id, "adopt");
  const before = await commands(server, id);

  // A new skill appears and the reload and the next run are issued together, without awaiting the first.
  await mkdir(join(server.home, ".agents", "skills", "raced"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "raced", "SKILL.md"), "---\nname: raced\ndescription: Raced skill\n---\nRaced body.\n");
  transcript.length = 0;
  server.responses.push(fauxAssistantMessage("raced run"));
  const [reloadResponse] = await Promise.all([
    fetch(server.origin + "/api/conversations/" + id + "/reload", { method: "POST", headers: server.headers }),
    submit(server.origin, server.headers, id, "raced run"),
  ]);
  assert.equal(reloadResponse.status, 200, await reloadResponse.text());
  const after = await run(server.origin, server.headers, id, "raced run");
  assert.ok(after.entries.length > 0);

  // Whichever order the two commits took, the run used one complete catalog: it either kept the adopted one (the
  // reload landed mid-run and was deferred) or used the new one (the reload landed first). The reload is never lost
  // and the prefix is never a mix of the two.
  const seen = transcript.join("\n");
  assert.ok(seen.includes("Deploy the app"), "the run's prefix still carries the adopted skills");
  assert.deepEqual(await commands(server, id), [...before, "skill:raced"].sort(), "the reload is never lost");
  const summary = await stateResources(server.origin, server.headers, id);
  assert.deepEqual({ status: summary.status, pending: summary.pending }, { status: "loaded", pending: false });

  // Either way the conversation keeps working and the next run sees the newest host content.
  transcript.length = 0;
  server.responses.push(fauxAssistantMessage("settled"));
  await run(server.origin, server.headers, id, "settled");
  assert.match(transcript.join("\n"), /Raced skill/);
});

test("restart replays the deferred candidate committed before the restart without a hidden reload", { timeout: 15000 }, async (t) => {
  const transcript: string[] = [];
  const first = await fixture(t, transcript);
  first.responses.push(fauxAssistantMessage("adopted"));
  const id = await createConversation(first.origin, first.headers);
  await run(first.origin, first.headers, id, "adopt");

  // Defer a candidate during an active run, settle that run, then restart before the next run.
  let release!: () => void;
  first.pending.promise = new Promise<void>((resolve) => { release = resolve; });
  first.responses.push(fauxAssistantMessage("held"));
  assert.equal(await submit(first.origin, first.headers, id, "held run"), 202);
  await waitBusy(first.origin, first.headers, id);
  await mkdir(join(first.home, ".agents", "skills", "deferred"), { recursive: true });
  await writeFile(join(first.home, ".agents", "skills", "deferred", "SKILL.md"), "---\nname: deferred\ndescription: Deferred skill\n---\nDeferred body.\n");
  const deferred = await reload(first.origin, first.headers, id);
  assert.equal(deferred.status, 200, JSON.stringify(deferred.body));
  assert.equal(deferred.body.resources?.pending, true);
  release();
  await run(first.origin, first.headers, id, "held run");
  assert.equal((await stateResources(first.origin, first.headers, id)).pending, false, "the settled run promoted the candidate");

  // The host changes again while the conversation is stopped; restart must not rediscover it.
  await mkdir(join(first.home, ".agents", "skills", "post-restart"), { recursive: true });
  await writeFile(join(first.home, ".agents", "skills", "post-restart", "SKILL.md"), "---\nname: post-restart\ndescription: Post restart skill\n---\nPost restart body.\n");
  for (const backend of first.opened) { backend.server.closeAllConnections(); await backend.close(); }
  transcript.length = 0;
  const restarted = await first.startBackend();
  first.responses.push(fauxAssistantMessage("after restart"));
  await run(restarted, first.headers, id, "after restart");
  const seen = transcript.join("\n");
  assert.match(seen, /Deferred skill/, "the committed candidate is replayed");
  assert.doesNotMatch(seen, /Post restart skill/, "restart does not rediscover the host");
  assert.deepEqual(await commands({ ...first, origin: restarted } as Fixture, id), ["ship", "skill:ancestor", "skill:deferred", "skill:deploy", "skill:global-notes", "summarize"]);
});


test("maps a retired skills-only result to the current adopted shape without reading the host", () => {
  const skill: LegacySkillCatalogEntry = { name: "global-notes", description: "Take global notes", location: "/exec/.agents/skills/global-notes/SKILL.md", baseDir: "/exec/.agents/skills/global-notes", disableModelInvocation: true, scope: "global" };
  const legacy: LegacyWorkspaceSkillsState = { status: "loaded", user: "operator", home: "/exec", workspaceRoot: "/exec/repo", roots: ["/exec/.agents/skills"], skills: [skill], prefix: "<resources>\nlegacy prefix\n</resources>", loadedAtMs: 7 };
  const mapped = migrateLegacySkillsState(legacy);
  assert.deepEqual(mapped, {
    status: "loaded",
    user: "operator",
    home: "/exec",
    workspaceRoot: "/exec/repo",
    roots: ["/exec/.agents/skills"],
    contextFiles: [],
    catalog: [{ kind: "skill", name: "global-notes", description: "Take global notes", location: "/exec/.agents/skills/global-notes/SKILL.md", baseDir: "/exec/.agents/skills/global-notes", scope: "global", disableModelInvocation: true }],
    prefix: "<resources>\nlegacy prefix\n</resources>",
    loadedAtMs: 7,
  });
  // A failed retired result is carried over unchanged, so its conversation can still report and retry it.
  assert.deepEqual(migrateLegacySkillsState({ status: "failed", error: "old failure", loadedAtMs: 9 }), { status: "failed", error: "old failure", loadedAtMs: 9 });
  // The retired kind is read only for this mapping; it stays the ticket-01 document, never a live resource source.
  assert.equal(LegacyWorkspaceSkillsDoc.definition.kind, "hepi.workspace-skills");
  assert.equal(LegacyWorkspaceSkillsDoc.definition.version, 1);
});

test("a restart preserves a legacy adopted catalog until an explicit reload", { timeout: 20000 }, async (t) => {
  const transcript: string[] = [];
  const first = await fixture(t, transcript);
  // A conversation created by the previous code: the current document does not exist, and its adopted result lives
  // under the retired kind.
  const id = await createConversation(first.origin, first.headers);
  const legacySkill = (name: string, description: string, dir: string): LegacySkillCatalogEntry => ({ name, description, location: join(dir, "SKILL.md"), baseDir: dir, disableModelInvocation: false, scope: "global" });
  const skills = [legacySkill("global-notes", "Take global notes", join(first.home, ".agents", "skills", "global-notes")), legacySkill("deploy", "Deploy the app", join(first.root, ".agents", "skills", "deploy"))];
  const legacyPrefix = formatSkillsForPrompt(skills.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.location, baseDir: skill.baseDir, sourceInfo: createSyntheticSourceInfo(skill.location, { source: "local", scope: "user", baseDir: skill.baseDir }), disableModelInvocation: skill.disableModelInvocation })), "read");
  const legacy: LegacyWorkspaceSkillsState = { status: "loaded", user: "operator", home: first.home, workspaceRoot: first.root, roots: [join(first.home, ".agents", "skills"), join(first.root, ".agents", "skills")], skills, prefix: legacyPrefix, loadedAtMs: 1234 };
  // Stop the service, write the retired document through the durable harness itself, and disconnect the execution host.
  for (const backend of first.opened) { backend.server.closeAllConnections(); await backend.close(); }
  const writer = await openServerHarness(first.dbPath, SERVER_MODEL, first.models, undefined, { startPaused: true });
  const conversation = await writer.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
  assert.ok(conversation !== undefined);
  await conversation.commit(async (tx) => { (await tx.doc(LegacyWorkspaceSkillsDoc, Number(id) as ConversationId)).state = legacy; }, BACKGROUND_CONTEXT);
  await writer.close();
  // The host changes and is reconnected on a new address: only the mapping can explain a replayed old prefix.
  await first.closeGateways();
  await mkdir(join(first.home, ".agents", "skills", "brand-new"), { recursive: true });
  await writeFile(join(first.home, ".agents", "skills", "brand-new", "SKILL.md"), "---\nname: brand-new\ndescription: Brand new skill\n---\nBrand new body.\n");
  await writeFile(join(first.home, ".pi", "agent", "prompts", "brand-new.md"), "---\ndescription: Brand new prompt\n---\nBrand new prompt body.\n");
  const rebound = await first.startGateway();
  const restarted = await first.startBackend([rebound, { ...rebound, id: "second" }]);

  transcript.length = 0;
  first.responses.push(fauxAssistantMessage("replayed"));
  await run(restarted, first.headers, id, "after restart");
  const seen = transcript.join("\n");
  assert.match(seen, /Take global notes/, "the retired prefix is replayed");
  assert.match(seen, /Deploy the app/);
  assert.doesNotMatch(seen, /Brand new skill/, "a restart is not a reload and does not rediscover the host");
  // Commands come from the mapped catalog: the retired result had no prompts, so none are advertised yet.
  assert.deepEqual(await commands({ ...first, origin: restarted } as Fixture, id), ["skill:deploy", "skill:global-notes"]);
  const summary = await stateResources(restarted, first.headers, id);
  assert.deepEqual(summary, { status: "loaded", skills: 2, prompts: 0, loadedAtMs: 1234, pending: false });
  // The committed result is on the SSE snapshot too, so a reconnecting client sees the adopted catalog.
  const events = await follow(restarted, first.headers, id);
  t.after(events.close);
  const baseline = await events.until((frame) => frame.event === "snapshot", "the baseline snapshot after the restart");
  assert.match(JSON.stringify(baseline.data), /"resources":\{"status":"loaded","skills":2,"prompts":0/);

  // The mapping is persisted under the current kind, so the next restart no longer needs the retired document.
  for (const backend of first.opened) { backend.server.closeAllConnections(); await backend.close(); }
  await first.closeGateways();
  const offline = await first.startBackend([{ ...rebound, gatewayOrigin: "http://127.0.0.1:1" }, { ...rebound, id: "second", gatewayOrigin: "http://127.0.0.1:1" }]);
  transcript.length = 0;
  first.responses.push(fauxAssistantMessage("still replayed"));
  await run(offline, first.headers, id, "offline restart");
  assert.match(transcript.join("\n"), /Take global notes/, "the mapped result is replayed with the host unreachable");
  assert.doesNotMatch(transcript.join("\n"), /Brand new skill/);

  // Only an explicit Reload adopts the changed host, including the prompts the retired kind never had.
  const reloaded = await reload(offline, first.headers, id);
  assert.equal(reloaded.status, 500, "an unreachable host fails the reload without changing the adopted catalog");
  assert.deepEqual(await stateResources(offline, first.headers, id), summary);
  const fresh = await first.startGateway();
  const reachable = await first.startBackend([fresh, { ...fresh, id: "second" }]);
  const adopted = await reload(reachable, first.headers, id);
  assert.equal(adopted.status, 200, JSON.stringify(adopted.body));
  // The explicit Reload discovers the whole host, not just the one new skill: the prompts and the ancestor skill the
  // retired kind could not carry are adopted now.
  assert.deepEqual(await commands({ ...first, origin: reachable } as Fixture, id), ["brand-new", "ship", "skill:ancestor", "skill:brand-new", "skill:deploy", "skill:global-notes", "summarize"]);
  const reloadedSummary = adopted.body.resources;
  assert.ok(reloadedSummary?.status === "loaded");
  assert.deepEqual({ ...reloadedSummary, loadedAtMs: 0 }, { status: "loaded", skills: 4, prompts: 3, loadedAtMs: 0, pending: false });
  transcript.length = 0;
  first.responses.push(fauxAssistantMessage("adopted"));
  await run(reachable, first.headers, id, "after reload");
  assert.match(transcript.join("\n"), /Brand new skill/, "the explicit reload adopts the changed host");
});
