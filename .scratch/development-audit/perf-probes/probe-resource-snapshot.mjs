/**
 * Priority-4 item 2: the execution-side resource snapshot — cost at normal scale, the 20 000-entry and 16 MiB bounds,
 * and what a conversation sees when a bound is hit.
 *
 * Real public contracts: `resourceSnapshot` / `executionHost` from `@hepi/gateway` (the function the loader's one
 * round trip calls) and the loader's own `discover` over a real `GatewayRpcServer`. Trees are synthetic but shaped
 * like a real host's: a repository, an account home, project and ancestor `.agents/skills` roots.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayRpcServer, LocalGateway, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_ENTRIES, executionHost, gatewayEnvironment, resourceSnapshot } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { createWorkspaceResources } from "../../../apps/server/src/workspace-resources.ts";
import { kib, listen, report, scratchDir, timed } from "./lib/probe-lib.mjs";

const results = { maxSnapshotBytes: MAX_SNAPSHOT_BYTES, maxSnapshotEntries: MAX_SNAPSHOT_ENTRIES, direct: [], loader: [], limits: {} };
const scratch = await scratchDir("hepi-probe-resources-");

/** One host tree: an account home, a repository and a workspace, with `skills` skill directories. */
async function host(base, name, options) {
  const home = join(base, name, "home");
  const repository = join(base, name, "repo");
  const root = join(repository, "app");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  const skills = options.skills ?? 40;
  const body = "Body of the skill.\n".repeat(options.bodyLines ?? 1);
  for (let index = 0; index < skills; index += 1) {
    const dir = join(root, ".agents", "skills", "skill-" + index);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: skill-" + index + "\ndescription: Skill " + index + "\n---\n" + body);
  }
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "SYSTEM PROMPT");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "ACCOUNT CONTEXT");
  await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT");
  return { home, repository, root };
}

/** A tree with exactly `files` regular entries spread over directories, so the entry bound is the only variable. */
async function flatTree(base, name, files) {
  const home = join(base, name, "home");
  const root = join(base, name, "repo", "app");
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "SYSTEM");
  const perDirectory = 100;
  for (let index = 0; index < files; index += 1) {
    const dir = join(root, ".agents", "skills", "group-" + Math.floor(index / perDirectory));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "skill-" + index + ".md"), "---\nname: s" + index + "\ndescription: d" + index + "\n---\nbody\n");
  }
  return { home, root };
}

try {
  // ---- direct snapshot cost, normal scale and larger
  // Each skill is one directory plus its SKILL.md, and both are counted as entries, so ~9 800 skills is the largest
  // tree that fits inside the 20 000-entry bound.
  for (const [label, skills, bodyLines] of [["40 skills (test scale)", 40, 1], ["1000 skills", 1000, 1], ["5000 skills", 5000, 1], ["9800 skills (~19 600 entries)", 9800, 1]]) {
    const tree = await host(scratch.dir, "direct-" + skills, { skills, bodyLines });
    const identity = { user: "operator", home: tree.home };
    const before = process.memoryUsage().heapUsed;
    try {
      const measured = await timed(() => resourceSnapshot(tree.root, identity));
      const after = process.memoryUsage().heapUsed;
      const snapshot = measured.value;
      results.direct.push({
        label,
        skills,
        ms: measured.ms,
        directories: snapshot.directories.length,
        files: snapshot.files.length,
        entries: snapshot.directories.reduce((total, directory) => total + ("entries" in directory ? directory.entries.length : 0), 0),
        responseKiB: kib(Buffer.byteLength(JSON.stringify({ ok: true, value: snapshot }))),
        heapDeltaKiB: kib(after - before),
      });
    } catch (error) {
      results.direct.push({ label, skills, thrown: true, code: error?.code, message: String(error?.message ?? error) });
    }
  }

  // ---- the entry bound
  {
    const tree = await flatTree(scratch.dir, "over-entries", 20_100);
    try {
      await resourceSnapshot(tree.root, { user: "operator", home: tree.home });
      results.limits.entries = { thrown: false };
    } catch (error) {
      results.limits.entries = { thrown: true, name: error?.constructor?.name, code: error?.code, message: String(error?.message ?? error) };
    }
  }

  // ---- the byte bound: skill frontmatter at 256 KiB each, well inside the per-file read cap
  try {
    const tree = await host(scratch.dir, "over-bytes", { skills: 5, bodyLines: 1 });
    // Prompt templates are read **whole** (a skill is only read as frontmatter), so this is the shape that can reach
    // the 16 MiB payload bound: 120 × 200 KiB of template text.
    for (let index = 0; index < 120; index += 1) {
      await writeFile(join(tree.root, ".pi", "prompts", "template-" + index + ".md"), "---\ndescription: Template " + index + "\n---\n" + "padding line of template text\n".repeat(7500));
    }
    const measured = await timed(() => resourceSnapshot(tree.root, { user: "operator", home: tree.home }));
    if (measured.value !== undefined) results.limits.bytes = { thrown: false, responseKiB: kib(Buffer.byteLength(JSON.stringify({ ok: true, value: measured.value }))), ms: measured.ms };
  } catch (error) {
    results.limits.bytes = { thrown: true, code: error?.code, message: String(error?.message ?? error) };
  }

  // ---- the loader's own discover over a real gateway RPC server (what a conversation actually pays)
  for (const [label, skills] of [["40 skills", 40], ["1000 skills", 1000], ["5000 skills", 5000]]) {
    const tree = await host(scratch.dir, "loader-" + skills, { skills });
    const workspaces = [{ id: "local", root: tree.root }];
    const files = new LocalFilesystem(workspaces, { identity: { user: "operator", home: tree.home } });
    const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, files);
    const { origin } = await listen(gateway.server);
    const env = gatewayEnvironment({ id: "local", gatewayId: "workstation", gatewayOrigin: origin, gatewayToken: "gateway-token" }, "/");
    const resources = createWorkspaceResources({ diagnostics: () => undefined });
    const measured = await timed(() => resources.discover(env, BACKGROUND_CONTEXT));
    const hostFacts = await timed(() => executionHost(tree.root, { user: "operator", home: tree.home }));
    results.loader.push({ label, skills, discoverMs: measured.ms, status: measured.value.status, catalog: measured.value.status === "loaded" ? measured.value.catalog.length : undefined, contextFiles: measured.value.status === "loaded" ? measured.value.contextFiles.length : undefined, prefixKiB: measured.value.status === "loaded" ? kib(Buffer.byteLength(measured.value.prefix)) : undefined, executionHostMs: hostFacts.ms });
    gateway.server.closeAllConnections();
    await new Promise(resolve => gateway.server.close(resolve));
  }
} finally {
  await scratch.cleanup();
}
const path = report("resource-snapshot-scale.json", { revision: "1758c1fb4479e9d4637a957857246c5998619d73", probe: "resource-snapshot-scale", results });
console.log(JSON.stringify(results, null, 2));
console.log("report: " + path);
