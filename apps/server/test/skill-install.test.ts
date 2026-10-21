import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { contentText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { SERVER_MODEL } from "./faux-fixture.ts";
import { createBackendServer, type BackendServer } from "../src/server.ts";
import { createSkillMarket, type MarketFetch } from "../src/skill-repository.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff, 0xfe]);
const PNG_BASE64 = PNG.toString("base64");
const SCRIPT = "#!/usr/bin/env node\nconsole.log('install me, never run me');\n";
const NOTES = "---\nname: notes\ndescription: Take notes\n---\n# Notes\n";
const REFERENCE = "# Reference\n";
const SOURCES = [{ id: "anthropics", owner: "anthropics", repo: "skills", branch: "main" }];

/** Every message of one request, so a test can assert what the model was actually shown. */
function transcriptText(messages: readonly Message[]): string {
  return messages.map((message) => message.role === "system" ? contentText(message.content) + "\n" + JSON.stringify(message.sections ?? {}) : message.role === "user" ? contentText(message.content) : "").join("\n");
}

function offlineFetch(): MarketFetch { return async () => { throw new Error("repository is offline"); }; }

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "hepi-install-server-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  const root = join(repository, "app");
  const second = join(base, "second");
  const remoteHome = join(base, "remote-home");
  const remoteRoot = join(base, "remote-repo", "app");
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });

  const workspaces = new WorkspaceRegistry([{ id: "local", root }, { id: "second", root: second }]);
  const files = new GatewayFiles(workspaces, { identity: { user: "operator", home } });
  const installs = new LocalInstallServer(workspaces, { identity: { user: "operator", home } });
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files, installs);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const bindings = [binding, { ...binding, id: "second" }];

  // A second gateway in this process, serving a remote account and root that are distinct from both this process and
  // the local execution host. Its transport is memory rather than sshd or a helper process: the gateway's own HTTP
  // surface, installation capability and file surface are the production ones, bound to the remote account.
  const remoteWorkspaces = new WorkspaceRegistry([{ id: "remote-prod", root: remoteRoot }]);
  const remoteIdentity = { user: "remote-operator", home: remoteHome };
  const remoteGateway = new GatewayRpcServer(
    new LocalGateway({ id: "remote-host", token: "remote-token", workspaces: remoteWorkspaces, allowedCommands: ["bash"] }),
    undefined,
    new GatewayFiles(remoteWorkspaces, { identity: remoteIdentity }),
    new LocalInstallServer(remoteWorkspaces, { identity: remoteIdentity }),
  );
  await new Promise<void>((resolve) => remoteGateway.server.listen(0, "127.0.0.1", resolve));
  const remoteAddress = remoteGateway.server.address();
  assert.ok(remoteAddress !== null && typeof remoteAddress === "object");
  const remoteBinding = { id: "remote-prod", gatewayId: "remote-host", gatewayOrigin: "http://127.0.0.1:" + remoteAddress.port, gatewayToken: "remote-token" };

  const faux = fauxProvider();
  const responses: FauxResponseStep[] = [];
  const transcript: string[] = [];
  const recorder: FauxResponseFactory = async (context): Promise<AssistantMessage> => {
    faux.appendResponses([recorder]);
    transcript.push(transcriptText(context.messages));
    const step = responses.shift();
    return step === undefined || typeof step === "function" ? fauxAssistantMessage("done") : step;
  };
  faux.setResponses([recorder]);
  const models = createModels();
  models.setProvider(faux.provider);
  // The branch's commit is mutable, so a test can move it after a selection was already made and prove the selection
  // did not follow it. The document bytes differ between the two commits.
  const MOVED = "---\nname: notes\ndescription: Take notes\n---\n# Notes (moved branch)\n";
  let branchSha = "aaaa1111bbbb2222";
  // Every GitHub URL the market actually reads, so a test can assert that browsing makes no request at all: the
  // inventory must answer from the host and the lock, and only an explicit check may resolve a commit.
  const calls: string[] = [];
  const fetch: MarketFetch = async (url, kind) => {
    calls.push(url);
    // The skills.sh public catalog answers beside the curated sources, so both source kinds are exercised through the
    // same installation path and neither one downloads anything.
    if (url.startsWith("https://skills.sh/api/search")) {
      return { query: "notes", count: 1, skills: [{ id: "anthropics/skills/notes", skillId: "notes", name: "notes", installs: 4, source: "anthropics/skills" }] };
    }
    if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(url)) return { default_branch: "main" };
    if (url.includes("/branches/")) return { commit: { sha: branchSha } };
    if (url.includes("/git/trees/")) return { tree: [{ path: "skills/notes/SKILL.md", type: "blob" }] };
    if (url.includes("SKILL.md")) return kind === "text" ? (url.includes(branchSha) && branchSha !== "aaaa1111bbbb2222" ? MOVED : NOTES) : "";
    throw new Error("unexpected " + url);
  };
  // Move the repository's branch to a new commit whose content differs, so an unpinned read would change underneath.
  const moveBranch = (): void => { branchSha = "9999aaaa8888bbbb"; };
  const marketPath = join(base, "skill-repository.sqlite");
  const market = createSkillMarket({ path: marketPath, sources: SOURCES, fetch });
  const dbPath = join(base, "server.sqlite");
  const headers = { authorization: "Bearer server-token", "content-type": "application/json" };
  const opened: BackendServer[] = [];
  const startBackend = async (market2 = market, db = dbPath): Promise<string> => {
    const backend = await createBackendServer({ dbPath: db, authToken: "server-token", models, workspaces: [...bindings, remoteBinding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), skillMarket: market2, defaultModel: SERVER_MODEL });
    opened.push(backend);
    await new Promise<void>((resolve) => backend.server.listen(0, "127.0.0.1", resolve));
    const serverAddress = backend.server.address();
    assert.ok(serverAddress !== null && typeof serverAddress === "object");
    return "http://127.0.0.1:" + serverAddress.port;
  };
  const origin = await startBackend();
  // Both markets are closed by the test that opened them; closing one twice is a no-op here.
  const closeMarket = (value: { close(): void }) => { try { value.close(); } catch { /* already closed */ } };
  t.after(async () => { for (const backend of opened) { backend.server.closeAllConnections(); await backend.close(); } gateway.server.closeAllConnections(); await gateway.close(); remoteGateway.server.closeAllConnections(); await remoteGateway.close().catch(() => {}); closeMarket(market); await rm(base, { recursive: true, force: true }); });

  // A conversation with no workspace at all is created by naming none: it runs with no execution host, so it has
  // nothing an installation could adopt into.
  const createConversation = async (workspaceId?: string): Promise<string> => {
    const response = await fetch2(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify(workspaceId === undefined ? {} : { workspaceId }) });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return (JSON.parse(text) as { conversationId: string }).conversationId;
  };
  const publish = async (body: unknown) => {
    const response = await fetch2(origin + "/api/skill-market/bundles", { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const install = async (body: unknown) => {
    const response = await fetch2(origin + "/api/skill-market/install", { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const run = async (id: string, text: string) => {
    const submit = await fetch2(origin + "/api/conversations/" + id + "/messages", { method: "POST", headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: text, text }) });
    assert.equal(submit.status, 202, await submit.text());
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const current = await (await fetch2(origin + "/api/conversations/" + id + "/state", { headers })).json() as { busy: boolean };
      if (!current.busy) return;
    }
    throw new Error("run did not settle");
  };
  const commands = async (url: string, id: string): Promise<string[]> => ((await (await fetch2(url + "/api/conversations/" + id + "/commands", { headers })).json()) as { commands: { name: string }[] }).commands.map((command) => command.name).sort();

  return { origin, headers, home, root, second, repository, remoteHome, remoteRoot, dbPath, marketPath, market, marketFetch: fetch, calls, responses, transcript, startBackend, createConversation, publish, install, run, commands, remoteBinding, remoteGateway, moveBranch };
}

const fetch2 = fetch;

const BUNDLE_FILES = [
  { path: "scripts/run.mjs", content: SCRIPT },
  { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
  { path: "REFERENCE.md", content: REFERENCE },
];

/** A bundle with two zero-byte files, which a byte-count write loop would silently drop. */
const EMPTY_BUNDLE_FILES = [
  { path: "assets/empty.txt", content: "" },
  { path: "__init__.py", content: "" },
  { path: "REFERENCE.md", content: REFERENCE },
];

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Whether a document declares the key the loader reads, decided here independently of the gateway's own edit. */
function declaredDormant(markdown: string): boolean {
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (block === null) return false;
  const line = /^[ \t]*(?:"disable-model-invocation"|'disable-model-invocation'|disable-model-invocation)[ \t]*:[ \t]*(.*)$/m.exec(block[1]!);
  return line !== null && line[1]!.trim() === "true";
}

const readdirOrEmpty = async (path: string): Promise<string[]> => await readdir(path).catch(() => []);

test("installs a bundle with zero-byte files, byte for byte, on a local and a remote-account host", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: EMPTY_BUNDLE_FILES });
  const local = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: local, scope: "global" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const skillPath = join(server.home, ".agents", "skills", "notes");
  // Both empty files are present on the host with exactly zero bytes, not missing and not non-empty.
  for (const relative of ["assets/empty.txt", "__init__.py"]) {
    const bytes = await readFile(join(skillPath, ...relative.split("/")));
    assert.equal(bytes.byteLength, 0, relative);
  }
  // The recorded baseline describes those files too, with the sha256 of no bytes at all.
  const lock = JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8"));
  assert.equal(lock.skills.notes.files["assets/empty.txt"], EMPTY_SHA256);
  assert.equal(lock.skills.notes.files["__init__.py"], EMPTY_SHA256);
  // The host's own inspection agrees with the baseline, so the fresh installation reads as unchanged rather than as a
  // false local modification of a file the installation never actually wrote.
  const status = async (conversationId: string) => ((await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + conversationId + "&scope=global&name=notes", { headers: server.headers })).json()) as { skill: { state: string } }).skill.state;
  assert.equal(await status(local), "unchanged");

  // The same bundle onto the remote-account host: its installation capability publishes the empty files too.
  const remote = await server.createConversation("remote-prod");
  server.responses.push(fauxAssistantMessage("adopted remotely"));
  const remoteInstalled = await server.install({ id: "repository:notes@1.0.0", conversationId: remote, scope: "global" });
  assert.equal(remoteInstalled.status, 200, JSON.stringify(remoteInstalled.body));
  const remoteSkill = join(server.remoteHome, ".agents", "skills", "notes");
  for (const relative of ["assets/empty.txt", "__init__.py"]) {
    const bytes = await readFile(join(remoteSkill, ...relative.split("/")));
    assert.equal(bytes.byteLength, 0, relative);
  }
  // Parity: the two hosts describe the same bundle identically, so a status read cannot depend on which one holds it.
  const localFiles = JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8")).skills.notes.files;
  const remoteFiles = JSON.parse(await readFile(join(server.remoteHome, ".agents", ".skill-lock.json"), "utf8")).skills.notes.files;
  assert.deepEqual(remoteFiles, localFiles);
  assert.equal(await status(remote), "unchanged");
});

test("refuses an update that would discard an edit made after the status was read", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" })).status, 200);
  const skillPath = join(server.home, ".agents", "skills", "notes");

  // The status is read, the user confirms it, and then the installed skill is edited before the update is sent. The
  // replacement is pinned to the snapshot the user actually saw, so the edit is refused as a conflict with the edit
  // intact: it is never silently deleted on the strength of a fresh read taken at publication time.
  const unchanged = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { state: string; files: Record<string, string> } };
  assert.equal(unchanged.skill.state, "unchanged");
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: notes\ndescription: mine\n---\nedited after the status was read\n");

  const raced = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global", confirm: true, files: unchanged.skill.files }) });
  const racedBody = await raced.json() as { error: { code: string } };
  assert.equal(raced.status, 409, JSON.stringify(racedBody));
  assert.equal(racedBody.error.code, "conflict");
  // The edit is intact, no backup was taken, and nothing was published over it.
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited after the status was read\n");
  assert.deepEqual((await readdirOrEmpty(join(server.home, ".agents"))).filter((name) => name.endsWith(".bak")), []);

  // The same edit, sent without a confirmation at all, is refused for the confirmation it needs: the state is re-read
  // at update time, so an edit that landed after the user looked is never replaced by an unconfirmed request.
  const unconfirmed = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global" }) });
  assert.equal(unconfirmed.status, 409);
  assert.equal(((await unconfirmed.json()) as { error: { code: string } }).error.code, "confirmation_required");
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited after the status was read\n");

  // Confirmed against what the host actually holds, the replacement is taken and the edit is kept as a backup.
  const current = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { files: Record<string, string> } };
  server.responses.push(fauxAssistantMessage("updated"));
  const confirmed = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global", confirm: true, files: current.skill.files }) });
  const confirmedBody = await confirmed.json() as { installed?: { backup?: string }; reload?: { ok: boolean } };
  assert.equal(confirmed.status, 200, JSON.stringify(confirmedBody));
  assert.equal(confirmedBody.reload?.ok, true);
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  assert.equal(await readFile(join(confirmedBody.installed!.backup!, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited after the status was read\n");
  const after = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { state: string } };
  assert.equal(after.skill.state, "unchanged");
});

test("installs a bundle globally and shares it across two workspaces of the same host and account", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  const published = await server.publish({ name: "notes", version: "1.0.0", description: "Take notes", markdown: NOTES, files: BUNDLE_FILES });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));

  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.installed.scope, "global");
  assert.equal(installed.body.installed.name, "notes");
  assert.equal(installed.body.installed.path, join(server.home, ".agents", "skills", "notes"));
  // The bundle's own document is installed with it, so the skill directory is a complete skill.
  assert.deepEqual(installed.body.installed.files.sort(), ["REFERENCE.md", "SKILL.md", "assets/logo.png", "scripts/run.mjs"]);
  assert.deepEqual(installed.body.reload, { ok: true });

  // Exact bytes, including a script and a binary, with no staging directory left behind.
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "scripts", "run.mjs"), "utf8"), SCRIPT);
  assert.deepEqual(await readFile(join(server.home, ".agents", "skills", "notes", "assets", "logo.png")), PNG);
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
  assert.deepEqual(await readdir(join(server.home, ".agents", "skills")), ["notes"]);

  // The lock records provenance and the install-time baseline beside the skills directory.
  const lock = JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8"));
  assert.equal(lock.version, 1);
  assert.deepEqual(Object.keys(lock.skills), ["notes"]);
  const entry = lock.skills.notes;
  assert.equal(entry.source, "repository:notes@1.0.0");
  assert.equal(entry.sourceType, "repository");
  assert.equal(entry.ref, "1.0.0");
  assert.equal(entry.version, "1.0.0");
  assert.equal(entry.scope, "global");
  assert.equal(entry.skillPath, join(server.home, ".agents", "skills", "notes"));
  // The baseline is a sha256 per installed file plus one hash over the directory. Values are known-good literals.
  assert.deepEqual(entry.files, {
    "SKILL.md": "08b060dcd17974cb92338ecd02f377667ebfec89431766e8c0d9eb8901d42a15",
    "REFERENCE.md": "cb0730c7d12a2cc1ef8c9942bbc96ef996ecd3afaa6235b49d81c5e800572a81",
    "scripts/run.mjs": "e42229eb15a2e468681949da15067ad318811d3625b3acf8610c870ffce32ab5",
    "assets/logo.png": "96154acb8752a341f68f2d3e22ecd883d5e16bd018ff84aff8946fe2c89c3f5a",
  });

  // A second workspace on the same host and account sees the same global directory, without a per-workspace copy.
  const secondConversation = await server.createConversation("second");
  server.responses.push(fauxAssistantMessage("second"));
  await server.run(secondConversation, "second");
  assert.deepEqual(await server.commands(server.origin, secondConversation), ["skill:notes"]);
  assert.ok(server.transcript.join("\n").includes(join(server.home, ".agents", "skills", "notes", "SKILL.md")), "the global skill is advertised at the shared host path");
  assert.deepEqual(await readdirOrEmpty(join(server.second, ".agents", "skills")), []);
});

test("installs into the workspace scope and stays discoverable with the repository offline", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "workspace" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.installed.path, join(server.root, ".agents", "skills", "notes"));
  assert.equal(await readFile(join(server.root, ".agents", "skills", "notes", "scripts", "run.mjs"), "utf8"), SCRIPT);
  // The workspace scope keeps its own lock; nothing was written into the account home.
  const lock = JSON.parse(await readFile(join(server.root, ".agents", ".skill-lock.json"), "utf8"));
  assert.equal(lock.skills.notes.scope, "workspace");
  assert.deepEqual(await readdirOrEmpty(server.home), []);

  // The repository is now unreachable: the installed skill still discovers, lists and loads from the host.
  server.market.close();
  const offlineMarket = createSkillMarket({ path: server.marketPath, sources: SOURCES, fetch: offlineFetch() });
  const restarted = await server.startBackend(offlineMarket);
  server.responses.push(fauxAssistantMessage("offline"));
  const submit = await fetch2(restarted + "/api/conversations/" + id + "/messages", { method: "POST", headers: server.headers, body: JSON.stringify({ protocol: "hepi.v1", type: "conversation.submit", requestId: "offline", text: "hello" }) });
  assert.equal(submit.status, 202, await submit.text());
  const listing = await (await fetch2(restarted + "/api/skill-market/skills", { headers: server.headers })).json() as { unavailableSources: string[] };
  assert.deepEqual(listing.unavailableSources, ["anthropics/skills"]);
  assert.deepEqual(await server.commands(restarted, id), ["skill:notes"]);
  offlineMarket.close();
});

test("reports installation success separately from a later reload failure", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  await server.run(id, "adopt");
  // A malformed resource on the host makes the candidate reload fail after the installation has already been published.
  await mkdir(join(server.home, ".agents", "skills", "broken"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\ndescription: [unclosed\n---\nbody\n");
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  assert.equal(installed.body.installed.name, "notes");
  assert.equal(installed.body.reload.ok, false);
  assert.match(installed.body.reload.error, /frontmatter/);
  // The published files stay: a failed adoption never rolls back an otherwise successful installation.
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "REFERENCE.md"), "utf8"), REFERENCE);
  assert.equal(JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8")).skills.notes.version, "1.0.0");
  // The conversation keeps its adopted prefix and stays usable.
  assert.equal((await fetch2(server.origin + "/api/conversations/" + id + "/state", { headers: server.headers })).status, 200);
});

test("refuses traversal, an existing destination and an escaping symlink without touching unrelated files", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // A bundle that would escape is refused at publication, so it never becomes installable content.
  for (const path of ["../escape.md", "/etc/passwd", "nested/SKILL.md"]) {
    assert.equal((await server.publish({ name: "escape", version: "1.0.0", markdown: NOTES, files: [{ path, content: "x" }] })).status, 400, path);
  }
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  // An existing directory is a conflict until ticket 07 confirms an overwrite; its content is untouched.
  await mkdir(join(server.root, ".agents", "skills", "notes"), { recursive: true });
  await writeFile(join(server.root, ".agents", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: mine\n---\nmine\n");
  const conflict = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "workspace" });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error.code, "conflict");
  assert.match(await readFile(join(server.root, ".agents", "skills", "notes", "SKILL.md"), "utf8"), /mine/);
  assert.deepEqual(await readdir(join(server.root, ".agents", "skills")), ["notes"]);

  // A destination that is a symlink to somewhere else is refused rather than written through.
  await mkdir(join(server.second, ".agents", "skills"), { recursive: true });
  await symlink(server.home, join(server.second, ".agents", "skills", "notes"));
  const second = await server.createConversation("second");
  server.responses.push(fauxAssistantMessage("adopted"));
  const linked = await server.install({ id: "repository:notes@1.0.0", conversationId: second, scope: "workspace" });
  assert.equal(linked.body.error.code, "conflict");
  assert.deepEqual(await readdir(server.home), []);
});

test("publishes on a remote execution host and reports its failures without replay", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("remote-prod");
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  // The remote account's home is that host's, not this process's and not the local execution host's.
  assert.equal(installed.body.installed.path, join(server.remoteHome, ".agents", "skills", "notes"));
  assert.equal(await readFile(join(server.remoteHome, ".agents", "skills", "notes", "scripts", "run.mjs"), "utf8"), SCRIPT);
  assert.deepEqual(await readFile(join(server.remoteHome, ".agents", "skills", "notes", "assets", "logo.png")), PNG);
  assert.equal(JSON.parse(await readFile(join(server.remoteHome, ".agents", ".skill-lock.json"), "utf8")).skills.notes.scope, "global");
  assert.deepEqual(await readdir(server.home), []);

  // An unreachable host fails that installation and never reports success or replays it.
  const second = await server.createConversation("remote-prod");
  server.responses.push(fauxAssistantMessage("adopted"));
  server.remoteGateway.server.closeAllConnections();
  await server.remoteGateway.close();
  const offline = await server.install({ id: "repository:notes@1.0.0", conversationId: second, scope: "workspace" });
  assert.equal(offline.status, 502, JSON.stringify(offline.body));
  assert.equal(offline.body.installed, undefined);
  assert.equal(offline.body.error.code, "outcome_unknown");
  // The already-published global installation is untouched and no second copy appeared.
  assert.equal(await readFile(join(server.remoteHome, ".agents", "skills", "notes", "REFERENCE.md"), "utf8"), REFERENCE);
  assert.deepEqual(await readdirOrEmpty(join(server.remoteRoot, ".agents", "skills")), []);
});

test("updates an installed skill, confirms a modified one, and keeps a backup of what it replaced", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" })).status, 200);
  const skillPath = join(server.home, ".agents", "skills", "notes");

  // The status names the installed skill's real state without changing anything on the host.
  const unchanged = await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers });
  assert.equal(unchanged.status, 200);
  const unchangedBody = await unchanged.json() as { skill: { state: string; path: string; files: Record<string, string> } };
  assert.equal(unchangedBody.skill.state, "unchanged");
  assert.equal(unchangedBody.skill.path, skillPath);
  assert.deepEqual(Object.keys(unchangedBody.skill.files).sort(), ["REFERENCE.md", "SKILL.md", "assets/logo.png", "scripts/run.mjs"]);

  // A local edit is reported as such, and the update refuses to discard it without an explicit confirmation.
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: notes\ndescription: mine\n---\nedited by hand\n");
  const modified = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { state: string } };
  assert.equal(modified.skill.state, "locally-modified");
  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  const refused = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global" }) });
  const refusedBody = await refused.json() as { error: { code: string }; state: string };
  assert.equal(refused.status, 409);
  assert.equal(refusedBody.error.code, "confirmation_required");
  assert.equal(refusedBody.state, "locally-modified");
  // Nothing was replaced: the hand edit is still there and no backup was taken.
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited by hand\n");
  assert.deepEqual(await readdirOrEmpty(join(server.home, ".agents")).then((names) => names.filter((name) => name.endsWith(".bak"))), []);

  // The confirmed update replaces it, keeps what it replaced, and records the new baseline.
  server.responses.push(fauxAssistantMessage("updated"));
  const confirmed = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global", confirm: true }) });
  const confirmedBody = await confirmed.json() as { installed: { version?: string; backup?: string }; reload: { ok: boolean } };
  assert.equal(confirmed.status, 200, JSON.stringify(confirmedBody));
  assert.equal(confirmedBody.installed.version, "1.1.0");
  assert.equal(confirmedBody.reload.ok, true);
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  const backup = confirmedBody.installed.backup;
  assert.equal(backup, join(server.home, ".agents", "notes.bak"));
  assert.equal(await readFile(join(backup, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited by hand\n");
  const lock = JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8"));
  assert.equal(lock.skills.notes.version, "1.1.0");
  // The refreshed baseline matches what is on the host, so the next status reads as unchanged again.
  const after = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { state: string } };
  assert.equal(after.skill.state, "unchanged");

  // An unchanged installation is replaced without a confirmation, and a second update is still possible.
  await server.publish({ name: "notes", version: "1.2.0", markdown: NOTES, files: BUNDLE_FILES });
  server.responses.push(fauxAssistantMessage("updated again"));
  const again = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.2.0", name: "notes", conversationId: id, scope: "global" }) });
  assert.equal(again.status, 200, JSON.stringify(await again.json()));
});

test("treats an installation with no recorded baseline as unknown, not as unmodified", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  // A hand-made directory with no lock entry is unknown provenance, never an unchanged installation.
  const skillPath = join(server.home, ".agents", "skills", "notes");
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: notes\ndescription: hand written\n---\nby hand\n");
  const status = await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json() as { skill: { state: string } };
  assert.equal(status.skill.state, "unmanaged");
  // It is not replaced on a single press, and the hand-written content is still there afterwards.
  const refused = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", name: "notes", conversationId: id, scope: "global" }) });
  assert.equal(refused.status, 409, JSON.stringify(await refused.json()));
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: hand written\n---\nby hand\n");
  // Nothing is installed at all: the status says so rather than inventing a baseline.
  const absent = await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=absent", { headers: server.headers });
  assert.equal(absent.status, 404);
});

test("treats an added and a deleted file as local modifications", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" })).status, 200);
  const skillPath = join(server.home, ".agents", "skills", "notes");
  const state = async () => ((await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json()) as { skill: { state: string } }).skill.state;
  assert.equal(await state(), "unchanged");
  // A file added by hand is a modification: the installation is no longer the content that was installed.
  await writeFile(join(skillPath, "handwritten.md"), "mine\n");
  assert.equal(await state(), "locally-modified");
  await rm(join(skillPath, "handwritten.md"));
  assert.equal(await state(), "unchanged");
  // A file deleted by hand is equally a modification.
  await rm(join(skillPath, "REFERENCE.md"));
  assert.equal(await state(), "locally-modified");
  // And a link where a file was is a modification, never mistaken for the file's content.
  await writeFile(join(skillPath, "REFERENCE.md"), REFERENCE);
  await rm(join(skillPath, "REFERENCE.md"));
  await symlink(join(skillPath, "SKILL.md"), join(skillPath, "REFERENCE.md"));
  assert.equal(await state(), "locally-modified");
});

test("adopts an update in the initiating conversation only", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const initiator = await server.createConversation("local");
  const bystander = await server.createConversation("second");
  server.responses.push(fauxAssistantMessage("initiator"));
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: initiator, scope: "global" })).status, 200);
  // The bystander is a different workspace of the same host and account, so it sees the shared global installation.
  server.responses.push(fauxAssistantMessage("bystander"));
  await server.run(bystander, "adopt");
  assert.deepEqual(await server.commands(server.origin, bystander), ["skill:notes"]);
  const before = server.transcript.length;

  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  server.responses.push(fauxAssistantMessage("initiator update"));
  const updated = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: initiator, scope: "global" }) });
  const updatedBody = await updated.json() as { reload?: { ok: boolean } };
  assert.equal(updated.status, 200, JSON.stringify(updatedBody));
  // The Reload is scoped to the initiating conversation. It runs no model call of its own, and it does not re-adopt
  // resources for any other conversation: the bystander's state and catalog are exactly what they were.
  assert.equal(updatedBody.reload?.ok, true);
  assert.equal(server.transcript.length, before, "the update reloads one conversation, not every conversation");
  assert.deepEqual(await server.commands(server.origin, bystander), ["skill:notes"]);
  assert.deepEqual(await server.commands(server.origin, initiator), ["skill:notes"]);
  // The host holds the new version for everyone, while only the initiator was asked to adopt it: a conversation
  // created afterwards sees the new content on its own first load, without the update having touched it.
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
  const later = await server.createConversation("second");
  server.responses.push(fauxAssistantMessage("later"));
  await server.run(later, "first load");
  assert.deepEqual(await server.commands(server.origin, later), ["skill:notes"]);
});

test("reports an update that succeeded on disk separately from a failed Reload", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  server.responses.push(fauxAssistantMessage("adopted"));
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" })).status, 200);
  await server.run(id, "adopt");
  // A malformed resource on the host makes the reload fail after the replacement has been published.
  await mkdir(join(server.home, ".agents", "skills", "broken"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "broken", "SKILL.md"), "---\nname: broken\ndescription: [unclosed\n---\nbody\n");
  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  const updated = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global" }) });
  const body = await updated.json() as { installed?: { version?: string; backup?: string }; reload?: { ok: boolean; error?: string } };
  assert.equal(updated.status, 200, JSON.stringify(body));
  // The replacement is reported, the Reload failure is a separate second outcome, and nothing was rolled back.
  assert.equal(body.installed?.version, "1.1.0");
  assert.equal(body.reload?.ok, false);
  assert.match(body.reload?.error ?? "", /frontmatter/);
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
  assert.equal(JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8")).skills.notes.version, "1.1.0");
  assert.equal((await fetch2(server.origin + "/api/conversations/" + id + "/state", { headers: server.headers })).status, 200);
});

test("installs and updates a repository bundle against real files on a remote-account host", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("remote-prod");
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const skillPath = join(server.remoteHome, ".agents", "skills", "notes");
  // The bundle the repository served is the content that landed on the host, byte for byte.
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  assert.equal(await readFile(join(skillPath, "scripts", "run.mjs"), "utf8"), SCRIPT);
  assert.deepEqual(await readFile(join(skillPath, "assets", "logo.png")), PNG);

  // The host reports the real state of its own directory, and a remote edit is a modification.
  const status = async () => ((await (await fetch2(server.origin + "/api/skill-market/installed?conversationId=" + id + "&scope=global&name=notes", { headers: server.headers })).json()) as { skill: { state: string; path: string } }).skill;
  assert.equal((await status()).state, "unchanged");
  assert.equal((await status()).path, skillPath);
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: notes\ndescription: mine\n---\nedited on the host\n");
  assert.equal((await status()).state, "locally-modified");

  // A confirmed update replaces it, keeps the edited directory as a backup on the host, and refreshes the baseline.
  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  server.responses.push(fauxAssistantMessage("updated"));
  const updated = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.1.0", name: "notes", conversationId: id, scope: "global", confirm: true }) });
  const body = await updated.json() as { installed?: { version?: string; backup?: string }; reload?: { ok: boolean } };
  assert.equal(updated.status, 200, JSON.stringify(body));
  assert.equal(body.installed?.version, "1.1.0");
  assert.equal(body.reload?.ok, true);
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  assert.equal(await readFile(join(body.installed!.backup!, "SKILL.md"), "utf8"), "---\nname: notes\ndescription: mine\n---\nedited on the host\n");
  assert.equal(JSON.parse(await readFile(join(server.remoteHome, ".agents", ".skill-lock.json"), "utf8")).skills.notes.version, "1.1.0");
  assert.equal((await status()).state, "unchanged");
});

test("reports an installation whose lock could not be written as published, and never hides the files", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  // The lock path is a directory, so the host publishes the directory and then cannot record its provenance.
  await mkdir(join(server.home, ".agents", ".skill-lock.json"), { recursive: true });
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "global" });
  const body = installed.body as { installed?: { path: string }; warning?: { code: string }; error?: unknown };
  // The installation is reported as published: the files are on the host, so calling it a failure would hide them.
  assert.equal(installed.status, 200, JSON.stringify(body));
  assert.equal(body.installed?.path, join(server.home, ".agents", "skills", "notes"));
  assert.equal(body.warning?.code, "invalid");
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "REFERENCE.md"), "utf8"), REFERENCE);
});

test("requires the backend token and a bound conversation target", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const unauthorized = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "repository:notes@1.0.0", scope: "global" }) });
  assert.equal(unauthorized.status, 401);
  const id = await server.createConversation("local");
  assert.equal((await server.install({ id: "repository:missing@9.9.9", conversationId: id, scope: "global" })).status, 404);
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: "nope", scope: "global" })).status, 404);
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: id, scope: "elsewhere" })).status, 400);
});

/** The inventory of one workspace, as the builtin Skills panel reads it. */
async function inventory(server: Awaited<ReturnType<typeof fixture>>, workspaceId: string) {
  const response = await fetch2(server.origin + "/api/skill-market/inventory?workspaceId=" + workspaceId, { headers: server.headers });
  return { status: response.status, body: await response.json() as { workspaceId?: string; host?: { user: string; home: string }; skills?: { name: string; directory: string; filePath: string; scope: string; disableModelInvocation: boolean; revision: string; availableVersion?: string; install?: { state: string; scope: string; source: string; sourceType: string; version?: string; directory: string } }[]; error?: { code: string; message: string } } };
}

test("installs onto an explicitly named execution workspace with no active conversation", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  // No conversation exists at all: the workspace names the execution target and nothing is asked to adopt.
  const installed = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "local", scope: "global" }) });
  const body = await installed.json() as { installed?: { name: string; scope: string; path: string }; reload?: unknown };
  assert.equal(installed.status, 200, JSON.stringify(body));
  assert.equal(body.installed?.name, "notes");
  assert.equal(body.installed?.path, join(server.home, ".agents", "skills", "notes"));
  // Without a conversation there is nothing to reload, and no outcome is invented for it.
  assert.equal(body.reload, undefined);
  assert.equal(await readFile(join(server.home, ".agents", "skills", "notes", "REFERENCE.md"), "utf8"), REFERENCE);

  // The same workspace scope through the explicit target: the project destination is the workspace's own directory.
  const workspaceInstall = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "second", scope: "workspace" }) });
  assert.equal(workspaceInstall.status, 200, await workspaceInstall.text());
  assert.equal(await readFile(join(server.second, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
  // The other workspace's project directory is untouched, and an unknown workspace is refused rather than guessed.
  assert.deepEqual(await readdirOrEmpty(join(server.root, ".agents", "skills")), []);
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "missing", scope: "global" }) })).status, 404);
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", scope: "global" }) })).status, 404);
});

test("refuses a target whose conversation is bound to another workspace", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const id = await server.createConversation("local");
  // A Reload can never be asked of a conversation bound somewhere else than the installation target.
  const mismatch = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "second", conversationId: id, scope: "global" }) });
  const body = await mismatch.json() as { error?: { code: string } };
  assert.equal(mismatch.status, 409, JSON.stringify(body));
  assert.equal(body.error?.code, "conflict");
  assert.equal((await inventory(server, "second")).body.skills?.length, 0);
  // Nothing was published anywhere: the refusal is about the target, and it happens before the host is touched.
  assert.deepEqual(await readdirOrEmpty(join(server.home, ".agents", "skills")), []);
  assert.deepEqual(await readdirOrEmpty(join(server.second, ".agents", "skills")), []);

  // A conversation bound to no workspace has nothing to adopt into. It cannot be paired with a named workspace
  // either: that would install and then ask a host-less conversation to adopt, so the pair is refused before
  // anything is published, rather than installing and trying an adoption that could never be right.
  const unbound = await server.createConversation();
  const unboundMismatch = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "local", conversationId: unbound, scope: "global" }) });
  const unboundBody = await unboundMismatch.json() as { error?: { code: string; message: string } };
  assert.equal(unboundMismatch.status, 409, JSON.stringify(unboundBody));
  assert.equal(unboundBody.error?.code, "conflict");
  assert.match(unboundBody.error?.message ?? "", /bound to no execution workspace/);
  assert.deepEqual(await readdirOrEmpty(join(server.home, ".agents", "skills")), []);
  // The unbound conversation alone still resolves its own target, which is nothing at all: a legacy conversation-only
  // caller keeps its 404, and no workspace is silently substituted for the one it does not have.
  assert.equal((await server.install({ id: "repository:notes@1.0.0", conversationId: unbound, scope: "global" })).status, 404);
  // The matching target still installs and adopts in that conversation.
  server.responses.push(fauxAssistantMessage("adopted"));
  const installed = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "local", conversationId: id, scope: "global" }) });
  const installedBody = await installed.json() as { reload?: { ok: boolean } };
  assert.equal(installed.status, 200, JSON.stringify(installedBody));
  assert.equal(installedBody.reload?.ok, true);
});

test("lists one workspace's execution-side skills with provenance and both state questions", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  // A hand-written skill with no baseline, an installation at the repository's newest version, and a skill whose
  // recorded revision is older than the repository now holds.
  await mkdir(join(server.home, ".agents", "skills", "handmade"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "handmade", "SKILL.md"), "---\nname: handmade\ndescription: Written by hand\n---\nbody\n");
  await server.publish({ name: "older", version: "1.0.0", markdown: "---\nname: older\ndescription: Older bundle\n---\nbody\n" });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200);
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:older@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200);
  await server.publish({ name: "older", version: "1.1.0", markdown: "---\nname: older\ndescription: Older bundle\n---\nbody v2\n" });

  const listed = await inventory(server, "local");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.host?.user, "operator");
  assert.equal(listed.body.host?.home, server.home);
  const byName = new Map((listed.body.skills ?? []).map((skill) => [skill.name, skill]));
  // The host's own account and content, not the backend's: the global root is the fixture account's home.
  assert.deepEqual([...byName.keys()].sort(), ["handmade", "notes", "older"]);
  assert.equal(byName.get("notes")?.scope, "global");
  assert.equal(byName.get("notes")?.filePath, join(server.home, ".agents", "skills", "notes", "SKILL.md"));
  assert.equal(byName.get("notes")?.install?.state, "unchanged");
  assert.equal(byName.get("notes")?.install?.scope, "global");
  assert.equal(byName.get("notes")?.install?.source, "repository:notes@1.0.0");
  assert.equal(byName.get("notes")?.install?.version, "1.0.0");
  // The repository's newest version is the revision question, and it is answered separately from the baseline.
  assert.equal(byName.get("notes")?.revision, "up-to-date");
  assert.equal(byName.get("older")?.revision, "update-available");
  assert.equal(byName.get("older")?.availableVersion, "1.1.0");
  // A hand-written skill is installed content with no provenance: unknown revision, never "missing" or "modified".
  assert.equal(byName.get("handmade")?.install, undefined);
  assert.equal(byName.get("handmade")?.revision, "unknown");
  assert.equal(byName.get("handmade")?.disableModelInvocation, false);

  // The document's declared name is a display name and need not match the directory. The installation is annotated by
  // the directory the host holds and the lock is keyed by, so a name that differs can never be mistaken for it.
  await server.publish({ name: "aliased", version: "1.0.0", markdown: "---\nname: Take notes\ndescription: Aliased\n---\nbody\n" });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:aliased@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200);
  const aliased = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "aliased");
  assert.equal(aliased?.name, "Take notes");
  assert.equal(aliased?.directory, "aliased");
  assert.equal(aliased?.install?.directory, "aliased");
  assert.equal(aliased?.filePath, join(server.home, ".agents", "skills", "aliased", "SKILL.md"));

  // A local edit is the baseline question, and it does not change the revision question.
  await writeFile(join(server.home, ".agents", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: mine\n---\nedited\n");
  const modified = await inventory(server, "local");
  const modifiedNotes = (modified.body.skills ?? []).find((skill) => skill.name === "notes");
  assert.equal(modifiedNotes?.install?.state, "locally-modified");
  assert.equal(modifiedNotes?.revision, "up-to-date");

  // The project scope of another workspace is that workspace's directory, not this one's.
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "second", scope: "workspace" }) })).status, 200);
  const second = await inventory(server, "second");
  assert.equal((second.body.skills ?? []).find((skill) => skill.name === "notes")?.scope, "project");
  assert.equal((second.body.skills ?? []).find((skill) => skill.name === "notes")?.install?.scope, "workspace");
});

test("orders a bundle's versions by semver, and refuses to order a version that is not one", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // Prereleases are the case a string comparison gets wrong: "1.0.0-beta.10" is newer than "1.0.0-beta.2" even though
  // it sorts before it lexically, so the newest version is the semver library's answer rather than a string's.
  await server.publish({ name: "notes", version: "1.0.0-beta.2", markdown: NOTES, files: BUNDLE_FILES });
  await server.publish({ name: "notes", version: "1.0.0-beta.10", markdown: NOTES, files: BUNDLE_FILES });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0-beta.2", workspaceId: "local", scope: "global" }) })).status, 200);
  const behind = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(behind?.availableVersion, "1.0.0-beta.10");
  assert.equal(behind?.revision, "update-available");
  // Installing the newest prerelease makes the same comparison answer "up to date", which a lexical ordering would not.
  assert.equal((await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0-beta.10", name: "notes", workspaceId: "local", scope: "global" }) })).status, 200);
  const newest = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(newest?.revision, "up-to-date");
  assert.equal(newest?.availableVersion, "1.0.0-beta.10");

  // A version the semver library rejects is not a version this module will order. The repository accepts such a string
  // at publication, so the inventory answers "not compared with the repository" rather than naming a newest version.
  await server.publish({ name: "loose", version: "1.0.0-01", markdown: "---\nname: loose\ndescription: Loose\n---\nbody\n", files: BUNDLE_FILES });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:loose@1.0.0-01", workspaceId: "local", scope: "global" }) })).status, 200);
  const unorderable = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "loose");
  assert.equal(unorderable?.revision, "unknown");
  assert.equal(unorderable?.availableVersion, undefined);
});

test("compares an installation with the repository only when the repository published it", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // A curated GitHub source and a stored bundle can share a directory name and be entirely different artifacts. The
  // repository's newest "notes" says nothing about the GitHub installation that happens to be called "notes", so that
  // installation is never reported as up to date with a bundle it did not come from.
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  const curated = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "anthropics:skills/notes", workspaceId: "local", scope: "global" }) });
  assert.equal(curated.status, 200, await curated.text());
  const listed = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(listed?.install?.sourceType, "github");
  assert.equal(listed?.install?.source, "github:notes@aaaa1111bbbb2222");
  assert.equal(listed?.revision, "unknown");
  assert.equal(listed?.availableVersion, undefined);
  // The same directory installed from the repository itself is compared, so the distinction is provenance, not name.
  assert.equal((await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", name: "notes", workspaceId: "local", scope: "global" }) })).status, 200);
  const replaced = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(replaced?.install?.sourceType, "repository");
  assert.equal(replaced?.revision, "up-to-date");
});

test("installs a pinned skills.sh hit through the host, with its commit as provenance", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // The catalog is queried, and the hit it answers with is pinned to the repository's commit before it is offered.
  const searched = await fetch2(server.origin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const found = await searched.json() as { skills: { id: string; name: string; source: { revision: string } }[]; unavailable: string[] };
  assert.equal(searched.status, 200, JSON.stringify(found));
  assert.deepEqual(found.unavailable, []);
  assert.deepEqual(found.skills.map((skill) => skill.name), ["notes"]);
  const hit = found.skills[0]!;
  assert.equal(hit.source.revision, "aaaa1111bbbb2222");

  // Installing it is the ordinary installation path: the whole bundle is published on the execution host, and the
  // recorded provenance is the commit the content came from, never the branch that was searched.
  const installed = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, workspaceId: "local", scope: "global" }) });
  assert.equal(installed.status, 200, await installed.text());
  const skillPath = join(server.home, ".agents", "skills", "notes");
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  // Whatever the pinned subtree held, the installation holds: the fixture's tree is the document alone.
  assert.deepEqual(await readdir(skillPath), ["SKILL.md"]);
  const lock = JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8")) as { skills: Record<string, { source: string; sourceType: string; ref?: string; version?: string }> };
  assert.equal(lock.skills.notes!.sourceType, "github");
  assert.equal(lock.skills.notes!.source, "github:notes@aaaa1111bbbb2222");
  assert.equal(lock.skills.notes!.ref, "aaaa1111bbbb2222");
  assert.equal(lock.skills.notes!.version, undefined, "a catalog hit has a commit, not a bundle version");

  // Repeated refreshes are stable: the same installation is reported, unchanged, from the host's own content.
  const first = await fetch2(server.origin + "/api/skill-market/inventory?workspaceId=local", { headers: server.headers });
  const second = await fetch2(server.origin + "/api/skill-market/inventory?workspaceId=local", { headers: server.headers });
  const firstBody = await first.json() as { skills?: { directory: string; install?: { state: string; source: string; ref?: string }; revision: string }[] };
  const secondBody = await second.json() as typeof firstBody;
  assert.deepEqual(secondBody, firstBody);
  const listed = firstBody.skills?.find((skill) => skill.directory === "notes");
  assert.equal(listed?.install?.state, "unchanged");
  assert.equal(listed?.install?.ref, "aaaa1111bbbb2222");
  // A curated source is pinned to a commit, so it is never compared with the repository's version list.
  assert.equal(listed?.revision, "unknown");
});

test("installs the same pinned bytes after a list refresh, a moved branch and a restart", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  const searched = await fetch2(server.origin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const hit = ((await searched.json()) as { skills: { id: string; source: { revision: string } }[] }).skills[0]!;
  assert.equal(hit.source.revision, "aaaa1111bbbb2222");

  // A refresh of the other source, then an installation: the selection is the pinned id, so the bytes and the recorded
  // revision are the ones the query resolved, not whatever a later read of the branch would say.
  await fetch2(server.origin + "/api/skill-market/skills", { headers: server.headers });
  const installed = await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, workspaceId: "local", scope: "global" }) });
  assert.equal(installed.status, 200, await installed.text());
  const skillPath = join(server.home, ".agents", "skills", "notes");
  assert.equal(await readFile(join(skillPath, "SKILL.md"), "utf8"), NOTES);
  const digestOf = async () => createHash("sha256").update(await readFile(join(skillPath, "SKILL.md"))).digest("hex");
  const installedDigest = await digestOf();
  const lockEntry = async () => (JSON.parse(await readFile(join(server.home, ".agents", ".skill-lock.json"), "utf8")) as { skills: Record<string, { ref?: string; source: string; sourceType: string }> }).skills.notes!;
  assert.equal((await lockEntry()).ref, "aaaa1111bbbb2222");
  assert.equal((await lockEntry()).source, "github:notes@aaaa1111bbbb2222");
  assert.equal((await lockEntry()).sourceType, "github");

  // The branch moves to a commit whose content differs, and then the backend restarts. The pinned id is re-installed
  // as a replacement: the commit it names, the bytes it names, and nothing from the branch that moved or the caches
  // the restart dropped.
  server.moveBranch();
  const restarted = await server.startBackend();
  const again = await fetch2(restarted + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, name: "notes", workspaceId: "local", scope: "global" }) });
  assert.equal(again.status, 200, await again.text());
  assert.equal(await digestOf(), installedDigest);
  assert.doesNotMatch(await readFile(join(skillPath, "SKILL.md"), "utf8"), /MOVED|moved branch/);
  assert.equal((await lockEntry()).ref, "aaaa1111bbbb2222");
  // A fresh market — a new process, so no cache from the earlier query survives — pins the moved commit, which proves
  // the branch really moved and that the assertions above were reading a pin rather than a fixture that never changed.
  const reloaded = createSkillMarket({ path: server.marketPath, sources: SOURCES, fetch: server.marketFetch });
  const freshOrigin = await server.startBackend(reloaded);
  const requery = await fetch2(freshOrigin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const requeryBody = await requery.json() as { skills?: { source?: { revision: string } }[] };
  assert.equal(requeryBody.skills?.[0]?.source?.revision, "9999aaaa8888bbbb", JSON.stringify(requeryBody));
  reloaded.close();
});

test("names a bundle's newest version only from versions it can order, and bounds a host's own error text", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // The repository's own version list is the source of ordering: a version string this module cannot order leaves the
  // revision question unanswered rather than naming a revision it cannot justify.
  await server.publish({ name: "notes", version: "1.0.0", markdown: NOTES, files: BUNDLE_FILES });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:notes@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200);
  assert.equal((await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes")?.revision, "up-to-date");
  await server.publish({ name: "notes", version: "1.1.0", markdown: NOTES, files: BUNDLE_FILES });
  const newest = (await inventory(server, "local")).body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(newest?.revision, "update-available");
  assert.equal(newest?.availableVersion, "1.1.0");

  // A host's own error text is bounded into one line before it is rendered, so a long multi-line gateway message
  // cannot reach the browser as a layout-breaking blob. The remote host is closed, so its error is what is reported.
  await server.remoteGateway.close();
  const offline = await fetch2(server.origin + "/api/workspaces", { headers: server.headers });
  const offlineBody = await offline.json() as { workspaces: { id: string; hostError?: string }[] };
  const hostError = offlineBody.workspaces.find((workspace) => workspace.id === "remote-prod")?.hostError;
  assert.equal(offline.status, 200);
  assert.ok(hostError !== undefined && hostError.length > 0 && !/[\r\n]/.test(hostError) && hostError.length <= 300, "the reported host error is one bounded line: " + JSON.stringify(hostError));
});

test("lists a host whose lock was never written instead of failing the read", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // The remote host has never had an installation recorded, so its lock file does not exist and the host answers the read
  // with nothing. That is an empty lock, not an unreadable one: the skills it does hold are still listed.
  const empty = await inventory(server, "remote-prod");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.skills, []);
  assert.equal(empty.body.host?.user, "remote-operator");
});

test("reports an unreachable execution host instead of an empty inventory", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.remoteGateway.close();
  const listed = await fetch2(server.origin + "/api/skill-market/inventory?workspaceId=remote-prod", { headers: server.headers });
  const body = await listed.json() as { error?: { code: string; message: string }; skills?: unknown };
  assert.equal(listed.status, 502, JSON.stringify(body));
  assert.equal(body.error?.code, "unreachable_host");
  assert.equal(body.skills, undefined);
});

/**
 * Ticket 11's toggle: the panel's single and bulk switch writes the execution-side document, and every directory is
 * reported on its own. The lock's baseline is not bypassed for a toggled file: the edit is a real change to the
 * directory, so the existing comparison reports it as a local modification, and a later replacement still needs the
 * confirmation any locally modified installation needs.
 */
test("toggles an installed skill's document on the execution host, one directory at a time", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  const searched = await fetch2(server.origin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const hit = ((await searched.json()) as { skills: { id: string }[] }).skills[0]!;
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, workspaceId: "local", scope: "global" }) })).status, 200);
  const skillPath = join(server.home, ".agents", "skills", "notes");
  const document = () => readFile(join(skillPath, "SKILL.md"), "utf8");
  assert.doesNotMatch(await document(), /disable-model-invocation/);

  const toggle = async (body: unknown) => {
    const response = await fetch2(server.origin + "/api/skill-market/skills", { method: "PATCH", headers: server.headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as { results?: { directory: string; changed?: boolean; error?: { code: string } }[]; error?: { code: string }; reload?: { ok: boolean } } };
  };
  // One directory: the document on the host is the one the loader reads, and nothing else in the directory moves.
  const single = await toggle({ workspaceId: "local", scope: "global", directories: ["notes"], disableModelInvocation: true });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.deepEqual(single.body.results, [{ directory: "notes", changed: true }]);
  const dormant = await document();
  assert.match(dormant, /^disable-model-invocation: true$/m);
  assert.equal(declaredDormant(dormant), true);
  assert.deepEqual(await readdir(skillPath), ["SKILL.md"]);
  // The second call is a no-op the host reports as such, and switching back restores the original bytes.
  assert.deepEqual((await toggle({ workspaceId: "local", scope: "global", directories: ["notes"], disableModelInvocation: true })).body.results, [{ directory: "notes", changed: false }]);
  assert.equal((await toggle({ workspaceId: "local", scope: "global", directories: ["notes"], disableModelInvocation: false })).body.results?.[0]?.changed, true);
  assert.doesNotMatch(await document(), /disable-model-invocation/);

  // The baseline is not excused for the toggled file: the host's content really differs from what was installed, so
  // the installation reads as locally modified and its update still needs the confirmation. The revision question is
  // answered separately and is unchanged by the edit.
  // Switched back on, the host's own discovery reports it, and the baseline question is answered from the real
  // content: the toggled document differs from what was installed, so it reads as locally modified rather than as an
  // unchanged installation, and a later replacement still needs the confirmation any local edit needs.
  assert.equal((await toggle({ workspaceId: "local", scope: "global", directories: ["notes"], disableModelInvocation: true })).body.results?.[0]?.changed, true);
  const afterToggle = await inventory(server, "local");
  const listed = afterToggle.body.skills?.find((skill) => skill.directory === "notes");
  assert.equal(listed?.disableModelInvocation, true, "the discovery reports the edited document");
  assert.equal(listed?.install?.state, "locally-modified", "the edit is a real difference from the recorded baseline");
  assert.equal(listed?.install?.sourceType, "github", "the edit does not change what the skill was installed from");
});

test("a bulk toggle reports each directory's own outcome and one refused directory stops nothing", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  await server.publish({ name: "alpha", version: "1.0.0", markdown: "---\nname: alpha\ndescription: A\n---\n# Alpha\n", files: [] });
  await server.publish({ name: "beta", version: "1.0.0", markdown: "---\nname: beta\ndescription: B\n---\n# Beta\n", files: [] });
  for (const name of ["alpha", "beta"]) {
    assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:" + name + "@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200, name);
  }
  const response = await fetch2(server.origin + "/api/skill-market/skills", { method: "PATCH", headers: server.headers, body: JSON.stringify({ workspaceId: "local", scope: "global", directories: ["alpha", "missing", "beta"], disableModelInvocation: true }) });
  const body = await response.json() as { results: { directory: string; changed?: boolean; error?: { code: string } }[] };
  assert.equal(response.status, 200, JSON.stringify(body));
  // Every directory is answered on its own, in the order asked, and the two that exist are both switched.
  assert.deepEqual(body.results.map((result) => result.directory), ["alpha", "missing", "beta"]);
  assert.equal(body.results[0]!.changed, true);
  assert.equal(body.results[1]!.error?.code, "not_found");
  assert.equal(body.results[2]!.changed, true);
  for (const name of ["alpha", "beta"]) {
    assert.equal(declaredDormant(await readFile(join(server.home, ".agents", "skills", name, "SKILL.md"), "utf8")), true, name);
  }
  // A malformed request is refused before anything is written: no scope, no directories, and no boolean all fail.
  for (const invalid of [
    { workspaceId: "local", directories: ["alpha"], disableModelInvocation: true },
    { workspaceId: "local", scope: "global", directories: [], disableModelInvocation: true },
    { workspaceId: "local", scope: "global", directories: ["alpha"], disableModelInvocation: "yes" },
    { workspaceId: "local", scope: "global", directories: ["alpha"] },
  ]) {
    const refused = await fetch2(server.origin + "/api/skill-market/skills", { method: "PATCH", headers: server.headers, body: JSON.stringify(invalid) });
    assert.equal(refused.status, 400, JSON.stringify(invalid));
    // Whether the body's shape or its scope is what is wrong, the request is refused before any directory is read, and
    // the code says which: an unparseable body is a request problem, a scope that is not an installation scope is not.
    const code = ((await refused.json()) as { error?: { code: string } }).error?.code;
    assert.ok(["invalid_request", "invalid_scope"].includes(code ?? ""), JSON.stringify(invalid) + " gave " + String(code));
  }
});

/**
 * The source-revision question is asked only when the user asks it. Browsing a host's skills must not reach GitHub:
 * the inventory answers from the host and the lock, and an explicit check is what resolves a fresh commit.
 */
test("resolves a GitHub installation's commit only when the user asks, and never the wrong document", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  const searched = await fetch2(server.origin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const hit = ((await searched.json()) as { skills: { id: string }[] }).skills[0]!;
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, workspaceId: "local", scope: "global" }) })).status, 200);
  // The lock records the coordinate and the document path the content actually came from, not just a revision.
  const lockEntry = () => (JSON.parse(readFileSync(join(server.home, ".agents", ".skill-lock.json"), "utf8")) as { skills: Record<string, { repository?: string; documentPath?: string; ref?: string }> }).skills.notes!;

  const before = server.calls.length;
  await inventory(server, "local");
  await inventory(server, "local");
  assert.equal(server.calls.length, before, "listing a host's skills reaches no repository: " + server.calls.slice(before).join(", "));

  const check = async (query = "") => {
    const response = await fetch2(server.origin + "/api/skill-market/check?workspaceId=local&scope=global&name=notes" + query, { headers: server.headers });
    return { status: response.status, body: await response.json() as { state?: string; currentRevision?: string; availableRevision?: string; id?: string; error?: { code: string } } };
  };
  // Unchanged branch: the check asks, and answers that the installed revision is the current one.
  const same = await check();
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.state, "up-to-date");
  assert.equal(same.body.currentRevision, "aaaa1111bbbb2222");
  assert.equal(same.body.availableRevision, undefined);

  // The branch moves, and the next explicit check is what sees it, with a fresh pinned id for the update that follows.
  server.moveBranch();
  const moved = await check();
  assert.equal(moved.body.state, "update-available", JSON.stringify(moved.body));
  assert.equal(moved.body.currentRevision, "aaaa1111bbbb2222");
  assert.equal(moved.body.availableRevision, "9999aaaa8888bbbb");
  assert.ok(moved.body.id?.startsWith("skills-sh:anthropics/skills@9999aaaa8888bbbb:"), moved.body.id);

  // The update is the existing replacement: the new commit's bytes, a retained backup, and the new ref recorded.
  const updated = await fetch2(server.origin + "/api/skill-market/update", { method: "POST", headers: server.headers, body: JSON.stringify({ id: moved.body.id, name: "notes", workspaceId: "local", scope: "global", confirm: true }) });
  const updatedBody = await updated.json() as { installed?: { backup?: string }; error?: { code: string; message: string } };
  assert.equal(updated.status, 200, JSON.stringify(updatedBody));
  assert.notEqual(await readFile(join(server.home, ".agents", "skills", "notes", "SKILL.md"), "utf8"), NOTES);
  const backup = updatedBody.installed?.backup;
  assert.ok(backup !== undefined, "the replaced directory is retained");
  assert.equal(await readFile(join(backup!, "SKILL.md"), "utf8"), NOTES);
  assert.equal(lockEntry().ref, "9999aaaa8888bbbb");
  assert.equal(lockEntry().repository, "anthropics/skills");
  assert.equal(lockEntry().documentPath, "skills/notes/SKILL.md");
});

/**
 * An installation without recorded GitHub provenance is never reported as up to date, and a repository this process
 * cannot read at all is reported as the question unanswered. Neither is the same fact as "the newest revision".
 */
test("reports an unmanaged or unreadable provenance as unknown, never as up to date", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  // A hand-written skill on the host: nothing recorded it, so no repository can be asked about it.
  await mkdir(join(server.home, ".agents", "skills", "handmade"), { recursive: true });
  await writeFile(join(server.home, ".agents", "skills", "handmade", "SKILL.md"), "---\nname: handmade\ndescription: Mine\n---\n# Mine\n");
  const handmade = await fetch2(server.origin + "/api/skill-market/check?workspaceId=local&scope=global&name=handmade", { headers: server.headers });
  const handmadeBody = await handmade.json() as { state?: string; id?: string };
  assert.equal(handmade.status, 200, JSON.stringify(handmadeBody));
  assert.equal(handmadeBody.state, "unknown");
  assert.equal(handmadeBody.id, undefined);

  // A repository bundle is versioned rather than pinned to a commit, so it is not a GitHub question at all.
  await server.publish({ name: "stored", version: "1.0.0", markdown: "---\nname: stored\ndescription: S\n---\n# Stored\n", files: [] });
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: "repository:stored@1.0.0", workspaceId: "local", scope: "global" }) })).status, 200);
  const stored = await fetch2(server.origin + "/api/skill-market/check?workspaceId=local&scope=global&name=stored", { headers: server.headers });
  assert.equal(((await stored.json()) as { state: string }).state, "unknown");

  // A GitHub installation whose repository cannot be read answers unknown rather than up to date.
  const searched = await fetch2(server.origin + "/api/skill-market/search?q=notes", { headers: server.headers });
  const hit = ((await searched.json()) as { skills: { id: string }[] }).skills[0]!;
  assert.equal((await fetch2(server.origin + "/api/skill-market/install", { method: "POST", headers: server.headers, body: JSON.stringify({ id: hit.id, workspaceId: "local", scope: "global" }) })).status, 200);
  const live = await fetch2(server.origin + "/api/skill-market/check?workspaceId=local&scope=global&name=notes", { headers: server.headers });
  assert.equal(((await live.json()) as { state: string }).state, "up-to-date");
  // The same market, with a fetch that fails the way an unreachable repository does.
  const offline = createSkillMarket({ path: join(await mkdtemp(join(tmpdir(), "hepi-check-offline-")), "market.sqlite"), sources: SOURCES, fetch: async () => { throw new Error("repository is offline"); } });
  const offlineOrigin = await server.startBackend(offline);
  const unreadable = await fetch2(offlineOrigin + "/api/skill-market/check?workspaceId=local&scope=global&name=notes", { headers: server.headers });
  assert.equal(((await unreadable.json()) as { state: string }).state, "unknown");
  offline.close();
});

test("names each configured workspace's real execution account", { timeout: 30000 }, async (t) => {
  const server = await fixture(t);
  const listed = await fetch2(server.origin + "/api/workspaces", { headers: server.headers });
  const body = await listed.json() as { workspaces: { id: string; gatewayId: string; host?: { user: string; home: string }; hostError?: string }[] };
  assert.equal(listed.status, 200, JSON.stringify(body));
  const local = body.workspaces.find((workspace) => workspace.id === "local");
  const remote = body.workspaces.find((workspace) => workspace.id === "remote-prod");
  // The local host reports this fixture account, and the remote host reports the remote account it actually serves.
  assert.equal(local?.host?.user, "operator");
  assert.equal(local?.host?.home, server.home);
  assert.equal(remote?.host?.user, "remote-operator");
  assert.equal(remote?.host?.home, server.remoteHome);
  // An unreachable host is named as unreachable rather than shown as the backend's own account.
  await server.remoteGateway.close();
  const offline = await fetch2(server.origin + "/api/workspaces", { headers: server.headers });
  const offlineBody = await offline.json() as { workspaces: { id: string; host?: unknown; hostError?: string }[] };
  assert.equal(offline.status, 200);
  assert.equal(offlineBody.workspaces.find((workspace) => workspace.id === "remote-prod")?.host, undefined);
  assert.ok((offlineBody.workspaces.find((workspace) => workspace.id === "remote-prod")?.hostError ?? "").length > 0);
});
