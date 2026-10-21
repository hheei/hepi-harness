import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayRpcServer, LocalGateway, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, ResourceIgnoreRules, gatewayEnvironment } from "@hepi/gateway";
import { GatewayFiles, type FileRequest } from "../../../packages/gateway/src/filesystem.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

/**
 * One discovery is one request. The whole resource scope set — every root, context files, system and append prompts,
 * prompt templates, skills and ignore files — arrives in a single response, so the walk costs one round trip instead of
 * one per file. These tests count the gateway methods a real discovery actually issues, over the real HTTP surface and
 * the real adapter, and assert the adopted result is unchanged.
 */

type Counts = Map<string, number>;

/** A gateway filesystem that counts the method of every request it serves, without changing any answer. */
class CountingFiles extends GatewayFiles {
  readonly counts: Counts = new Map();
  async execute(request: FileRequest): Promise<unknown> {
    this.counts.set(request.method, (this.counts.get(request.method) ?? 0) + 1);
    return await super.execute(request);
  }
}

/**
 * A temporary execution account home, repository and workspace on the local gateway, with the skill and prompt shapes a
 * real host has: skills spread over several roots, one of them nested a directory per skill, plus an ignore file.
 */
async function host(t: { after(fn: () => unknown): void }, options: { skills?: number; nested?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), "hepi-snapshot-"));
  const home = join(base, "home");
  const repository = join(base, "repo");
  const root = join(repository, "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  const skills = options.skills ?? 40;
  for (let index = 0; index < skills; index += 1) {
    const name = "skill-" + index;
    const dir = options.nested === true ? join(root, ".agents", "skills", name) : join(root, ".agents", "skills");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, options.nested === true ? "SKILL.md" : name + ".md"), "---\nname: " + name + "\ndescription: Skill " + name + "\n---\nBody of " + name + ".\n");
  }
  // One rule excludes the same skill in either layout: a loose file, or the directory a nested skill lives in.
  await writeFile(join(root, ".agents", "skills", ".gitignore"), "skill-3.md\nskill-3/\n");
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "SYSTEM PROMPT");
  await writeFile(join(home, ".pi", "agent", "APPEND_SYSTEM.md"), "APPEND PROMPT");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "ACCOUNT CONTEXT");
  await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT");
  await writeFile(join(root, ".pi", "prompts", "summarize.md"), "---\ndescription: Summarize\n---\nSummarize $1.\n");
  const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
  const files = new CountingFiles(workspaces, { identity: { user: "operator", home } });
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(async () => { await gateway.close(); await rm(base, { recursive: true, force: true }); });
  const env = gatewayEnvironment({ id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" }, "/");
  return { files, env, root };
}

const perFileMethods = ["listDir", "canonicalPath", "readTextFile", "readBinaryFile", "fileInfo", "exists"];

/** How many requests a discovery issued per file, which is the count this test exists to remove. */
function perFileTotal(counts: Counts): number {
  return perFileMethods.reduce((total, method) => total + (counts.get(method) ?? 0), 0);
}

test("one discovery issues one snapshot request and no per-file request", async (t) => {
  const { files, env } = await host(t, { skills: 40, nested: true });
  const resources = createWorkspaceResources({ projectTrusted: true });
  const state = await resources.discover(env, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded");
  if (state.status !== "loaded") return;
  assert.equal(state.catalog.filter((entry) => entry.kind === "skill").length, 39, "one skill is excluded by the ignore file");
  assert.equal(state.catalog.filter((entry) => entry.kind === "prompt").length, 1);
  assert.match(state.prefix, /SYSTEM PROMPT/);
  assert.match(state.prefix, /APPEND PROMPT/);
  assert.match(state.prefix, /PROJECT CONTEXT/);
  assert.match(state.prefix, /Skill skill-38/);
  assert.equal(files.counts.get("resourceSnapshot"), 1, "the whole scope set arrives in one request, not " + perFileTotal(files.counts) + " per-file requests");
  for (const method of perFileMethods) assert.equal(files.counts.get(method) ?? 0, 0, method + " must not be called per file");
});

test("one discovery stays one request as the host grows", async (t) => {
  const small = await host(t, { skills: 5 });
  const large = await host(t, { skills: 200, nested: true });
  const resources = createWorkspaceResources({ projectTrusted: true });
  assert.equal((await resources.discover(small.env, BACKGROUND_CONTEXT)).status, "loaded");
  assert.equal((await resources.discover(large.env, BACKGROUND_CONTEXT)).status, "loaded");
  assert.equal(small.files.counts.get("resourceSnapshot"), 1);
  assert.equal(large.files.counts.get("resourceSnapshot"), 1, "a larger host is still one request, not " + perFileTotal(large.files.counts) + " per-file requests");
});

test("a snapshot over the byte bound fails clearly instead of truncating", async (t) => {
  const { env, root } = await host(t, { skills: 1 });
  await writeFile(join(root, "AGENTS.md"), "x".repeat(17 * 1024 * 1024));
  const resources = createWorkspaceResources({ projectTrusted: true });
  await assert.rejects(async () => await resources.discover(env, BACKGROUND_CONTEXT), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /byte/);
    return true;
  });
});

test("a skill body is never carried by the snapshot and is read from its real path on demand", async (t) => {
  const { files, env } = await host(t, { skills: 2, nested: true });
  const resources = createWorkspaceResources({ projectTrusted: true });
  const state = await resources.discover(env, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded");
  if (state.status !== "loaded") return;
  const before = files.counts.get("readTextFile") ?? 0;
  const expanded = await resources.expand(state, env, "/skill:skill-0", BACKGROUND_CONTEXT);
  assert.match(expanded, /Body of skill-0\./, "the body is read when the command runs");
  assert.equal(files.counts.get("readTextFile"), before + 1, "one read, at command time");
});

test("the snapshot covers the discovery's own trees and nothing else", async (t) => {
  const { files, env, root } = await host(t, { skills: 3, nested: true });
  // Content that is not a resource and is not on any resource path: a full project walk would reach it, a discovery
  // of the resource scope set must not, because the loader may read only resource roots and the workspace.
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await writeFile(join(root, "src", "deep", "notes.md"), "---\nname: not-a-resource\ndescription: Not a resource\n---\nBody.\n");
  await writeFile(join(root, "README.md"), "readme\n");
  const resources = createWorkspaceResources({ projectTrusted: true });
  const state = await resources.discover(env, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded");
  if (state.status !== "loaded") return;
  assert.deepEqual(state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort(), ["skill-0", "skill-1", "skill-2"]);
  const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const paths = snapshot.value.files.map((file) => file.path);
  assert.ok(!paths.some((path) => path.includes("/src/")), "an unrelated project directory is not walked: " + paths.join(", "));
  assert.ok(!paths.includes(join(root, "README.md")), "a project file outside a resource root is not read");
  // Every file the snapshot carries is on a resource path: below a root, or one of the host's own resource files.
  const roots = snapshot.value.host.roots.map((entry) => entry.path);
  const authorized = [...snapshot.value.host.contextFiles, ...snapshot.value.host.systemPromptFiles.map((file) => file.path), ...snapshot.value.host.appendSystemPromptFiles.map((file) => file.path)];
  for (const path of paths) assert.ok(roots.some((entry) => path === entry || path.startsWith(entry + "/")) || authorized.includes(path), path + " is not on a resource path");
  for (const directory of snapshot.value.directories) assert.ok(roots.some((entry) => directory.path === entry || directory.path.startsWith(entry + "/")), directory.path + " is not below a resource root");
});

test("one snapshot answers every read the loader's walk makes, so nothing is deferred to a second request", async (t) => {
  // A host with the shapes a walk exercises: a nested skill directory, a loose skill, an ignore file, a link, and a
  // link that resolves outside its root. The snapshot must be enough for all of them, because there is no second call.
  const { files, env, root } = await host(t, { skills: 4, nested: true });
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, "loose.md"), "---\nname: loose\ndescription: Loose skill\n---\nLoose body.\n");
  await symlink(join(skills, "skill-0"), join(skills, "alias"));
  const outside = join(root, "..", "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "SKILL.md"), "---\nname: escaped\ndescription: Outside\n---\nOutside body.\n");
  await symlink(outside, join(skills, "escaped"));
  const resources = createWorkspaceResources({ projectTrusted: true, diagnostics: () => {} });
  const state = await resources.discover(env, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded");
  if (state.status !== "loaded") return;
  const names = state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort();
  // skill-3 is excluded by the fixture's own ignore rule, the alias is adopted once, and the escaping link is skipped.
  assert.deepEqual(names, ["loose", "skill-0", "skill-1", "skill-2"], "the link is one skill and the escaping link is skipped");
  assert.equal(files.counts.get("resourceSnapshot"), 1);
  for (const method of perFileMethods) assert.equal(files.counts.get(method) ?? 0, 0, method + " must not be called after the snapshot");
});

test("the snapshot is what a per-file walk of the same host would have read", async (t) => {
  // Parity: the loader's walk is unchanged, so what it must not lose is what the per-file walk read. This walks the
  // same roots directly off the filesystem — independently of the gateway and of the loader — applying the same
  // ignore rules and the same terminal-directory rule, and requires the snapshot to hold exactly those directories,
  // those entries and those file texts. A producer that skipped, extra-listed or re-read anything would differ here.
  const { env, root } = await host(t, { skills: 4, nested: true });
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, "loose.md"), "---\nname: loose\ndescription: Loose skill\n---\nLoose body.\n");
  await symlink(join(skills, "skill-0"), join(skills, "alias"));
  const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const reference = new Map<string, string[]>();
  const texts = new Map<string, string>();
  const walk = async (directory: string, rootPath: string, kind: "skills" | "prompts", rules: ResourceIgnoreRules): Promise<void> => {
    const names = (await readdir(directory)).filter((name) => !name.startsWith(".") && name !== "node_modules").sort();
    const relativeDir = relative(rootPath, directory);
    for (const name of [".gitignore", ".ignore", ".fdignore"]) {
      const text = await readFile(join(directory, name), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      rules.addText(text, relativeDir === "" ? "" : relativeDir + "/");
      texts.set(join(directory, name), text);
    }
    const declared = names.includes("SKILL.md");
    const terminal = kind === "skills" && declared;
    reference.set(directory, terminal ? names.filter((name) => name === "SKILL.md") : names);
    for (const name of names) {
      if (terminal && name !== "SKILL.md") continue;
      const path = join(directory, name);
      const info = await lstat(path);
      const target = await realpath(path).catch(() => path);
      const targetInfo = await stat(target).catch(() => undefined);
      const targetKind = targetInfo === undefined ? "missing" : targetInfo.isDirectory() ? "directory" : targetInfo.isFile() ? "file" : "other";
      const relativePath = relative(rootPath, path);
      if (rules.ignores(targetKind === "directory" ? relativePath + "/" : relativePath)) continue;
      if (terminal) { texts.set(path, frontmatterOf(await readFile(path, "utf8"))); continue; }
      if (targetKind === "directory") { if (kind === "skills") await walk(path, rootPath, kind, rules); continue; }
      if (targetKind !== "file" || !name.endsWith(".md")) continue;
      const content = await readFile(path, "utf8");
      texts.set(path, kind === "skills" ? frontmatterOf(content) : content);
    }
  };
  for (const entry of snapshot.value.host.roots) if (entry.kind === "skills") await walk(entry.path, entry.path, "skills", new ResourceIgnoreRules());
  const byPath = new Map(snapshot.value.directories.map((entry) => [entry.path, "entries" in entry ? entry.entries.map((item) => item.info.name).sort() : undefined]));
  for (const [directory, names] of reference) {
    const held = byPath.get(directory);
    assert.ok(held !== undefined, directory + " is missing from the snapshot");
    assert.deepEqual(held, names, directory + " holds the same entries");
  }
  const heldTexts = new Map(snapshot.value.files.filter((file) => "text" in file).map((file) => [file.path, "text" in file ? file.text : ""]));
  for (const [path, text] of texts) assert.equal(heldTexts.get(path), text, path + " holds the same text");
});

/** The frontmatter block of a file, or the whole head when it opens none — what a skills-root read keeps. */
function frontmatterOf(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---/.exec(text);
  return match === null ? text : match[0];
}

test("an ignored subtree is never read, transmitted or counted", async (t) => {
  // A supporting tree under a skills root: ignored content, plus a directory the walk could not open at all. Neither
  // may appear in the snapshot, and neither may fail it — the loader never enters either, so reading them eagerly
  // would turn a working discovery into a failed one and spend payload on content no one asked for.
  const { env, root } = await host(t, { skills: 2, nested: true });
  const skills = join(root, ".agents", "skills");
  await mkdir(join(skills, "support", "docs"), { recursive: true });
  await writeFile(join(skills, "support", "README.md"), "---\nname: support\ndescription: Supporting note\n---\nSupporting body.\n");
  await writeFile(join(skills, "support", "docs", "notes.md"), "# Notes\n");
  await mkdir(join(skills, "locked"), { recursive: true });
  await writeFile(join(skills, "locked", "SKILL.md"), "---\nname: locked\ndescription: Locked\n---\nLocked body.\n");
  // Both are excluded by the fixture's own ignore rule, and one of them could not be read at all: an ignored path is
  // pruned before it is opened, so a directory the walk would fail on is never the walk's problem.
  await writeFile(join(skills, ".gitignore"), "support/\nlocked/\n");
  await chmod(join(skills, "locked"), 0o000);
  try {
    const resources = createWorkspaceResources({ projectTrusted: true });
    const state = await resources.discover(env, BACKGROUND_CONTEXT);
    assert.equal(state.status, "loaded", JSON.stringify(state).slice(0, 300));
    if (state.status !== "loaded") return;
    assert.deepEqual(state.catalog.filter((entry) => entry.kind === "skill").map((entry) => entry.name).sort(), ["skill-0", "skill-1"]);
    const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
    assert.equal(snapshot.ok, true);
    if (!snapshot.ok) return;
    const paths = snapshot.value.files.map((file) => file.path);
    assert.ok(!paths.some((path) => path.includes("/support/")), "an ignored subtree is not read: " + paths.join(", "));
    assert.ok(!paths.some((path) => path.includes("/locked/")), "an ignored directory is not entered: " + paths.join(", "));
    const directories = snapshot.value.directories.map((entry) => entry.path);
    assert.ok(!directories.includes(join(skills, "support")), "an ignored subtree is not walked");
    assert.ok(!directories.includes(join(skills, "locked")), "an ignored directory is not listed");
  } finally { await chmod(join(skills, "locked"), 0o755); }
});

test("a directory that declares a skill contributes only its declaration", async (t) => {
  // A skill directory is terminal: the loader adopts its SKILL.md and stops, so a supporting document beside it is
  // not a resource and must not be read into the snapshot, where it would cost bytes and advertise nothing.
  const { env, root } = await host(t, { skills: 1, nested: true });
  const skills = join(root, ".agents", "skills");
  await writeFile(join(skills, "skill-0", "reference.md"), "# Reference\n");
  await writeFile(join(skills, "skill-0", "examples.md"), "---\nname: example\ndescription: Example\n---\nBody.\n");
  await mkdir(join(skills, "skill-0", "assets"), { recursive: true });
  await writeFile(join(skills, "skill-0", "assets", "deep.md"), "# Deep\n");
  const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const paths = snapshot.value.files.map((file) => file.path);
  assert.ok(paths.includes(join(skills, "skill-0", "SKILL.md")), "the declaration is carried");
  assert.ok(!paths.some((path) => path.endsWith("reference.md")), "a supporting document is not read: " + paths.join(", "));
  assert.ok(!paths.some((path) => path.endsWith("examples.md")), "a sibling markdown file is not read: " + paths.join(", "));
  assert.ok(!paths.some((path) => path.includes("/assets/")), "nothing below a declared skill is walked: " + paths.join(", "));
  const directories = snapshot.value.directories.map((entry) => entry.path);
  assert.ok(!directories.includes(join(skills, "skill-0", "assets")), "nothing below a declared skill is listed");
});

test("a skill past the per-file limit fails instead of being advertised from a head", async (t) => {
  // The per-file limit is the one a plain read enforces, and a skill is read through it however little the snapshot
  // keeps: a declaration taken from an oversized file would advertise a skill the host refuses to read.
  const { env, root } = await host(t, { skills: 1, nested: true });
  await writeFile(join(root, ".agents", "skills", "skill-0", "SKILL.md"), "---\nname: skill-0\ndescription: Huge\n---\n" + "x".repeat(17 * 1024 * 1024));
  // The refusal is a fact about that one file, not a 16 MiB payload: the snapshot stays small and the discovery fails
  // where a per-file read would have failed, rather than advertising a skill the host refuses to read.
  const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot).slice(0, 200));
  if (!snapshot.ok) return;
  const resources = createWorkspaceResources({ projectTrusted: true });
  await assert.rejects(async () => await resources.discover(env, BACKGROUND_CONTEXT), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /gateway limit/);
    return true;
  });
});

test("the serialized payload bound is measured on the serialized response", async (t) => {
  // A bound measured on text alone would let a response past it: every path, every kind, every mtime and every JSON
  // escape crosses the wire too, and so does the host metadata. Two prompt templates, each within the per-file limit,
  // are read whole, so the response can be pushed past the payload bound while no single file is refused; the boundary
  // is then bisected and the largest accepted response must be a serialized reply just under the bound. A check that
  // measured something smaller would accept a reply over it, and one that reserved headroom would refuse one that fits.
  const { env, root } = await host(t, { skills: 1 });
  const prompts = join(root, ".pi", "prompts");
  // The fixed part of the response, written once: a single template's headroom is the bound minus it, and every probe
  // below only moves the second file inside that headroom.
  await writeFile(join(prompts, "a.md"), "a".repeat(1024 * 1024));
  const responseOf = async (length: number): Promise<{ ok: boolean; size: number }> => {
    await writeFile(join(prompts, "b.md"), "b".repeat(length));
    const snapshot = await env.resourceSnapshot(BACKGROUND_CONTEXT);
    return snapshot.ok ? { ok: true, size: Buffer.byteLength(JSON.stringify({ ok: true, value: snapshot.value }), "utf8") } : { ok: false, size: 0 };
  };
  // Each answer is kept as it arrives rather than asked for again: every write gives the file a new mtime, whose
  // serialized width shifts the boundary by a few bytes, so a second call at the same length is not the same question.
  //
  // The bracket is calibrated, not guessed: one probe at the empty second template states the fixed part's serialized
  // size, and because the response grows one byte per byte of ASCII here, the length that crosses the bound is that
  // size below it. Bisecting the whole [0, per-file limit] range instead spends every one of ~24 probes carrying a
  // payload far from the boundary, which is the same boundary question asked with megabytes the answer does not depend
  // on. The window below is 64 bytes either side of the estimate — the estimate can only be off by the width of the
  // size field it was measured without — and the bisection still decides the exact byte.
  let low = 0;
  let high = MAX_FILE_BYTES;
  const fixed = await responseOf(0);
  assert.equal(fixed.ok, true, "the fixed part of the response is under the bound");
  const estimate = MAX_SNAPSHOT_BYTES - fixed.size;
  assert.ok(estimate > 0 && estimate < MAX_FILE_BYTES, "the estimate is a length a single template may have: " + estimate);
  const window = 64;
  low = Math.max(0, estimate - window);
  high = Math.min(MAX_FILE_BYTES, estimate + window);
  let accepted = await responseOf(low);
  let refused = await responseOf(high);
  assert.equal(accepted.ok, true, "a host under the bound loads");
  assert.equal(refused.ok, false, "a host over the bound fails clearly");
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    const answer = await responseOf(middle);
    if (answer.ok) { low = middle; accepted = answer; } else { high = middle; refused = answer; }
  }
  assert.equal(accepted.ok, true, "the largest response that fits is accepted");
  assert.equal(refused.ok, false, "the smallest response that does not fit is refused");
  assert.ok(accepted.size <= MAX_SNAPSHOT_BYTES, "an accepted response is within the bound: " + accepted.size);
  assert.ok(accepted.size > MAX_SNAPSHOT_BYTES - 4096, "the bound is measured on the response itself: " + accepted.size);
});

test("the catalog, the prefix and the diagnostics survive the snapshot unchanged", async (t) => {
  // The loader owns precedence and reporting, and it now runs over a snapshot. What must not change is what it
  // adopts and what it says: the nearest root wins a name collision and the loser is reported, and a link that
  // resolves outside its root is reported and skipped. Both are the loader's own decisions over the same facts.
  const { env, root } = await host(t, { skills: 2, nested: true });
  const home = join(root, "..", "..", "home");
  // The same skill name in a project root and in the account root: the project root outranks the account one.
  await mkdir(join(root, ".agents", "skills", "dup"), { recursive: true });
  await writeFile(join(root, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Project dup\n---\nProject body.\n");
  await mkdir(join(home, ".agents", "skills", "dup"), { recursive: true });
  await writeFile(join(home, ".agents", "skills", "dup", "SKILL.md"), "---\nname: dup\ndescription: Account dup\n---\nAccount body.\n");
  const outside = join(root, "..", "outside-dup");
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "SKILL.md"), "---\nname: escaped\ndescription: Outside\n---\nOutside body.\n");
  await symlink(outside, join(root, ".agents", "skills", "escaped"));
  const messages: string[] = [];
  const resources = createWorkspaceResources({ projectTrusted: true, diagnostics: (message: string) => messages.push(message) });
  const state = await resources.discover(env, BACKGROUND_CONTEXT);
  assert.equal(state.status, "loaded");
  if (state.status !== "loaded") return;
  const dup = state.catalog.filter((entry) => entry.name === "dup");
  assert.equal(dup.length, 1, "one name is one resource");
  assert.equal(dup[0].description, "Project dup", "the nearest root wins the collision");
  assert.equal(state.catalog.filter((entry) => entry.name === "escaped").length, 0, "a link out of its root is skipped");
  assert.ok(messages.some((message) => message.includes("dup") && message.includes("was skipped") && message.includes("already declares that name")), "the losing duplicate is reported: " + messages.join(" | "));
  assert.ok(messages.some((message) => message.includes("escaped") && message.includes("resolves outside")), "the escaping link is reported: " + messages.join(" | "));
  // The prefix is the rendered adopted result: both descriptions the catalog kept are in it, and neither loser is.
  assert.match(state.prefix, /Project dup/);
  assert.doesNotMatch(state.prefix, /Account dup/);
  assert.doesNotMatch(state.prefix, /Outside/);
});

