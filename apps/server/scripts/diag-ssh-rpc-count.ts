/**
 * SSH resource-discovery transport counter (PHASE 1 diagnostic, throwaway).
 *
 * The same loader walk as diag-rpc-count.ts, but over the real SSH filesystem and the real remote Python helper, through
 * a counting transport. It reports how many requests one discovery makes of the remote helper session, which is what
 * the live deployment pays: one request for the whole scope set, instead of one per file plus one more for each
 * request's authorization.
 *
 * Usage: node apps/server/scripts/diag-ssh-rpc-count.ts [--skills=130] [--flat]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SshFilesystem } from "../../../packages/gateway/src/ssh-filesystem.ts";
import { sshWorkspaceSeed, WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";
import { pythonSshRunner } from "../../../packages/gateway/test/ssh-transport.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
};
const skillCount = arg("skills", 130);
const flat = process.argv.includes("--flat");

async function buildHost(base: string): Promise<{ home: string; root: string }> {
  const home = join(base, "home");
  const root = join(base, "workspace");
  await mkdir(join(home, ".pi", "agent", "prompts"), { recursive: true });
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  await mkdir(join(root, ".agents", "skills"), { recursive: true });
  await mkdir(join(root, ".pi", "prompts"), { recursive: true });
  await writeFile(join(home, ".pi", "agent", "SYSTEM.md"), "SYSTEM\n");
  await writeFile(join(home, ".pi", "agent", "AGENTS.md"), "CONTEXT\n");
  await writeFile(join(root, "AGENTS.md"), "PROJECT CONTEXT\n");
  const groupCount = 12;
  const perGroup = Math.ceil(skillCount / groupCount);
  let written = 0;
  for (let group = 0; group < groupCount && written < skillCount; group += 1) {
    const dir = join(group % 2 === 0 ? home : root, ".agents", "skills", "group-" + group);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < perGroup && written < skillCount; index += 1) {
      const name = "skill-" + group + "-" + index;
      if (flat) await writeFile(join(dir, name + ".md"), "---\nname: " + name + "\ndescription: Skill " + name + "\n---\nBody of " + name + "\n");
      else { await mkdir(join(dir, name), { recursive: true }); await writeFile(join(dir, name, "SKILL.md"), "---\nname: " + name + "\ndescription: Skill " + name + "\n---\nBody of " + name + "\n"); }
      written += 1;
    }
  }
  for (let index = 0; index < 3; index += 1) await writeFile(join(root, ".pi", "prompts", "prompt-" + index + ".md"), "---\ndescription: Prompt " + index + "\n---\nDo " + index + "\n");
  await writeFile(join(home, ".pi", "agent", "prompts", "global.md"), "---\ndescription: Global\n---\nGlobal\n");
  return { home, root };
}

const base = await mkdtemp(join(tmpdir(), "hepi-ssh-rpc-"));
try {
  const { home, root } = await buildHost(base);
  const { runner, frames } = pythonSshRunner({ user: "remote-operator", home });
  const profiles = [{ id: "a", host: "host-a", remoteRoot: root, identityFile: join(base, "id"), knownHostsFile: join(base, "known_hosts") }];
  const files = new SshFilesystem({ id: "ssh-gateway", profiles, runner, workspaces: new WorkspaceRegistry(sshWorkspaceSeed(profiles)) });
  // The environment the backend builds for an SSH workspace: every method is the gateway file RPC over the transport.
  const env = {
    // One discovery is one snapshot request; every read the walk needs is answered from it, so no other method runs.
    resourceSnapshot: async () => await files.execute({ workspaceId: "remote-a", method: "resourceSnapshot" }),
    executionHost: async () => await files.execute({ workspaceId: "remote-a", method: "executionHost" }),
    listDir: async (path: string) => await files.execute({ workspaceId: "remote-a", method: "listDir", path }),
    readTextFile: async (path: string) => await files.execute({ workspaceId: "remote-a", method: "readTextFile", path }),
    canonicalPath: async (path: string) => await files.execute({ workspaceId: "remote-a", method: "canonicalPath", path }),
    fileInfo: async (path: string) => await files.execute({ workspaceId: "remote-a", method: "fileInfo", path }),
  };
  const resources = createWorkspaceResources({ projectTrusted: true, diagnostics: () => {} });
  const startedAt = Date.now();
  const discovered = await resources.discover(env as never, BACKGROUND_CONTEXT);
  const wallMs = Date.now() - startedAt;
  await files.close();
  // One session frame is one helper request: the mode it names is the operation the host runs for it.
  const byMode = new Map<string, number>();
  for (const frame of frames) byMode.set(frame.mode, (byMode.get(frame.mode) ?? 0) + 1);
  const helperRuns = frames.length;
  // The account and the scope set come back together, so every request that resolves authorization is one discovery.
  const authorizationRuns = byMode.get("discover") ?? 0;
  console.log(JSON.stringify({
    skills: skillCount,
    flat,
    catalogSize: discovered.status === "loaded" ? discovered.catalog.length : null,
    helperRuns,
    authorizationRuns,
    wallMs,
    byMode: Object.fromEntries([...byMode.entries()].sort((left, right) => right[1] - left[1])),
  }, null, 1));
} finally {
  await rm(base, { recursive: true, force: true });
}
