/**
 * Priority-4 probe: the execution-side resource snapshot at entry scale, its exclusions, and its bounds.
 *
 * Research only. Measures the current public surface without touching it:
 *   - resourceSnapshot / executionHost from packages/gateway/src/filesystem.ts (the one round trip the loader makes),
 *     imported through @hepi/gateway;
 *   - the loader's own discover from apps/server/src/workspace-resources.ts, over a real GatewayRpcServer, so the
 *     number is what a conversation actually pays.
 *
 * Tree shape is a realistic host: an account home with <home>/.pi/agent/SYSTEM.md, a repository (with a .git marker so
 * ancestor discovery stops there) and a workspace whose .agents/skills root holds group-N/skill-M.md files. Entry
 * counts below are the snapshot's own entries total (one per listed directory entry), so groups + groups*filesPerGroup
 * is the measured figure. Fixtures live under the system temp dir, not the repository, so an ancestor AGENTS.md or
 * .agents/skills of this checkout cannot contaminate the measurement.
 *
 * Runtime output goes under the git-ignored .dev/research-performance/resource-search/.
 * Run as: node --import ./lib/register.mjs probe-resource-search.mjs
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayRpcServer, LocalGateway, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ENTRIES, executionHost, gatewayEnvironment, resourceSnapshot } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { createWorkspaceResources } from "../../../apps/server/src/workspace-resources.ts";
import { kib, listen, outputRoot, timed } from "./lib/probe-lib.mjs";

const results = { maxSnapshotEntries: MAX_SNAPSHOT_ENTRIES, maxSnapshotBytes: MAX_SNAPSHOT_BYTES, direct: [], exclusion: {}, bounds: {}, loader: [] };
const scratch = await mkdtemp(join(tmpdir(), "hepi-probe-resource-search-"));
const identity = { user: "operator", home: "" };

/** One host tree: account home, repository (.git marker), workspace .agents/skills root. */
async function skillsTree(name, groups, filesPerGroup, options = {}) {
  const home = join(scratch, name, "home");
  const repository = join(scratch, name, "repo");
  const root = join(repository, "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "SYSTEM PROMPT");
  const body = "Body of the skill.\n".repeat(options.bodyLines ?? 1);
  for (let group = 0; group < groups; group += 1) {
    const directory = join(root, ".agents", "skills", "group-" + group);
    await mkdir(directory, { recursive: true });
    for (let file = 0; file < filesPerGroup; file += 1) {
      const index = group * filesPerGroup + file;
      await writeFile(join(directory, "skill-" + index + ".md"), "---\nname: skill-" + index + "\ndescription: Skill " + index + "\n---\n" + body);
    }
  }
  return { home, repository, root };
}

const snapshotEntries = (snapshot) => snapshot.directories.reduce((total, directory) => total + ("entries" in directory ? directory.entries.length : 0), 0);
const snapshotBytes = (snapshot) => Buffer.byteLength(JSON.stringify({ ok: true, value: snapshot }), "utf8");
const emit = (name, payload) => {
  const directory = join(outputRoot, "resource-search");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name + ".json");
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
};

try {
  // ---- the local public surface at realistic entry scale (100 / 1000 / 5000 entries)
  for (const [label, groups, filesPerGroup] of [["100 entries", 1, 99], ["1000 entries", 10, 99], ["5000 entries", 50, 99]]) {
    const tree = await skillsTree("direct-" + label.replace(/\W+/g, "-"), groups, filesPerGroup);
    identity.home = tree.home;
    const before = process.memoryUsage().heapUsed;
    const measured = await timed(() => resourceSnapshot(tree.root, identity));
    const after = process.memoryUsage().heapUsed;
    const snapshot = measured.value;
    results.direct.push({ label, expectedEntries: groups + groups * filesPerGroup, ms: measured.ms, entries: snapshotEntries(snapshot), directories: snapshot.directories.length, files: snapshot.files.length, responseKiB: kib(snapshotBytes(snapshot)), heapDeltaKiB: kib(after - before), roots: snapshot.host.roots.length });
  }

  // ---- exclusion: node_modules and dot entries are never listed or read; an ignored directory costs its one listing
  // entry and none of its content; an ignored file is listed but never read.
  {
    const tree = await skillsTree("exclusion", 1, 99);
    identity.home = tree.home;
    const skillsRoot = join(tree.root, ".agents", "skills");
    await writeFile(join(skillsRoot, ".gitignore"), "ignored-dir/\nsecret.md\n");
    await mkdir(join(skillsRoot, "node_modules", "pkg"), { recursive: true });
    for (let index = 0; index < 500; index += 1) await writeFile(join(skillsRoot, "node_modules", "pkg", "module-" + index + ".js"), "module.exports = " + index + ";\n");
    await mkdir(join(skillsRoot, ".hidden"), { recursive: true });
    for (let index = 0; index < 100; index += 1) await writeFile(join(skillsRoot, ".hidden", "hidden-" + index + ".md"), "hidden body\n");
    await mkdir(join(skillsRoot, "ignored-dir"), { recursive: true });
    for (let index = 0; index < 500; index += 1) await writeFile(join(skillsRoot, "ignored-dir", "ignored-" + index + ".md"), "---\nname: ignored-" + index + "\ndescription: d\n---\nbody\n");
    await writeFile(join(skillsRoot, "secret.md"), "---\nname: secret\ndescription: d\n---\nbody\n");
    const measured = await timed(() => resourceSnapshot(tree.root, identity));
    const snapshot = measured.value;
    const allPaths = [...snapshot.directories.map((directory) => directory.path), ...snapshot.files.map((file) => file.path)];
    const leaked = allPaths.filter((path) => /node_modules|\.hidden|ignored-dir|secret\.md/.test(path));
    const rootListing = snapshot.directories.find((directory) => directory.path === skillsRoot);
    const names = rootListing === undefined || !("entries" in rootListing) ? [] : rootListing.entries.map((entry) => entry.info.name);
    // Invariants: no excluded content is read or walked; the ignored directory is one listing entry; the ignored file is
    // listed but not read; node_modules and dot entries are absent from the listing entirely.
    assert.deepEqual(leaked, [], "excluded content must not appear in the snapshot");
    assert.ok(names.includes("ignored-dir"), "the ignored directory is one listing entry: " + JSON.stringify(names));
    assert.ok(names.includes("secret.md"), "the ignored file is listed: " + JSON.stringify(names));
    assert.ok(!names.includes("node_modules"), "node_modules is not listed");
    assert.ok(!names.includes(".hidden"), "a dot entry is not listed");
    assert.equal(snapshot.files.filter((file) => file.path.endsWith("secret.md")).length, 0, "an ignored file's text is never read");
    assert.equal(snapshot.directories.filter((directory) => directory.path.startsWith(join(skillsRoot, "ignored-dir"))).length, 0, "an ignored directory is never entered");
    results.exclusion = {
      ms: measured.ms,
      baselineEntriesWithoutExtras: 100,
      entries: snapshotEntries(snapshot),
      files: snapshot.files.length,
      directories: snapshot.directories.length,
      nodeModulesFilesOnDisk: 500,
      hiddenFilesOnDisk: 100,
      ignoredDirFilesOnDisk: 500,
      rootListingNames: names,
      leakedPaths: leaked.length,
      ignoredFileRead: false,
      ignoredDirectoryEntered: false,
    };
  }

  // ---- bound, truthful: just under the entry bound succeeds; over it the call refuses and names the bound, and no
  // partial snapshot is returned in either direction.
  {
    const tree = await skillsTree("under-entries", 190, 99);
    identity.home = tree.home;
    const measured = await timed(() => resourceSnapshot(tree.root, identity));
    results.bounds.underEntries = { expectedEntries: 190 + 190 * 99, ms: measured.ms, entries: snapshotEntries(measured.value), responseKiB: kib(snapshotBytes(measured.value)) };
    assert.equal(snapshotEntries(measured.value), 19000, "a snapshot under the bound is complete, not clipped");
  }
  {
    const tree = await skillsTree("over-entries", 201, 99);
    identity.home = tree.home;
    try {
      const snapshot = await resourceSnapshot(tree.root, identity);
      results.bounds.overEntries = { thrown: false, entries: snapshotEntries(snapshot), note: "expected the entry bound to refuse" };
      assert.fail("the entry bound must refuse rather than return a partial snapshot");
    } catch (error) {
      results.bounds.overEntries = { thrown: true, name: error?.constructor?.name, code: error?.code, message: String(error?.message ?? error), namesBound: String(error?.message ?? "").includes(String(MAX_SNAPSHOT_ENTRIES)) };
      assert.equal(error?.code, "invalid");
      assert.match(String(error?.message ?? ""), /exceeds 20000 entries/);
    }
  }
  {
    // Prompt templates are read whole (a skill is only read as frontmatter), so this is the shape that reaches the
    // 16 MiB payload bound: 90 x ~210 KiB of template text.
    const tree = await skillsTree("over-bytes", 1, 5);
    identity.home = tree.home;
    await mkdir(join(tree.root, ".pi", "prompts"), { recursive: true });
    for (let index = 0; index < 90; index += 1) await writeFile(join(tree.root, ".pi", "prompts", "template-" + index + ".md"), "---\ndescription: Template " + index + "\n---\n" + "padding line of template text\n".repeat(7000));
    try {
      const snapshot = await resourceSnapshot(tree.root, identity);
      results.bounds.overBytes = { thrown: false, responseKiB: kib(snapshotBytes(snapshot)), note: "expected the byte bound to refuse" };
      assert.fail("the byte bound must refuse rather than return a partial snapshot");
    } catch (error) {
      results.bounds.overBytes = { thrown: true, name: error?.constructor?.name, code: error?.code, message: String(error?.message ?? error), namesBound: String(error?.message ?? "").includes(String(MAX_SNAPSHOT_BYTES)) };
      assert.equal(error?.code, "invalid");
      assert.match(String(error?.message ?? ""), /exceeds 16777216 bytes/);
    }
  }

  // ---- the loader's own discover over a real gateway RPC server: the cost a conversation pays end to end.
  for (const [label, groups, filesPerGroup] of [["100 entries", 1, 99], ["1000 entries", 10, 99], ["5000 entries", 50, 99]]) {
    const tree = await skillsTree("loader-" + label.replace(/\W+/g, "-"), groups, filesPerGroup);
    const workspaces = [{ id: "local", root: tree.root }];
    const files = new GatewayFiles(workspaces, { identity: { user: "operator", home: tree.home } });
    const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files);
    const { origin } = await listen(gateway.server);
    const env = gatewayEnvironment({ id: "local", gatewayId: "workstation", gatewayOrigin: origin, gatewayToken: "gateway-token" }, "/");
    const resources = createWorkspaceResources({ diagnostics: () => undefined });
    const measured = await timed(() => resources.discover(env, BACKGROUND_CONTEXT));
    const hostFacts = await timed(() => executionHost(tree.root, { user: "operator", home: tree.home }));
    results.loader.push({
      label,
      expectedSkills: groups * filesPerGroup,
      status: measured.value.status,
      catalog: measured.value.status === "loaded" ? measured.value.catalog.length : undefined,
      prefixKiB: measured.value.status === "loaded" ? kib(Buffer.byteLength(measured.value.prefix)) : undefined,
      discoverMs: measured.ms,
      executionHostMs: hostFacts.ms,
    });
    assert.equal(measured.value.status, "loaded");
    assert.equal(measured.value.catalog.length, groups * filesPerGroup, "every skill of the tree is adopted");
    gateway.server.closeAllConnections();
    await new Promise((resolve) => gateway.server.close(resolve));
    await files.close();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const revision = execSync("git rev-parse HEAD", { cwd: outputRoot }).toString().trim();
const path = emit("resource-snapshot", { revision, probe: "resource-snapshot-scale", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
