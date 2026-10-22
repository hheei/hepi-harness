/**
 * Resource-discovery RPC counter (PHASE 1 diagnostic, throwaway).
 *
 * Drives the real loader (apps/server/src/workspace-resources.ts discover()) through the real gateway RPC surface
 * (packages/gateway GatewayRpcServer + LocalFilesystem + gatewayEnvironment) over a synthetic execution host, and counts
 * every host round trip by method, the peak number in flight, and the wall time at a modelled RTT.
 *
 * The RTT is the measured live number (168 ms per authenticated round trip), injected as a fixed latency so the
 * scaling is a modelled number and not a busy machine's. Nothing here sleeps to decide anything.
 *
 * Usage: node .scratch/submit-stall/rpc-count.ts [--rtt=168] [--skills=130] [--nodes=179]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem, type FilesystemServer } from "../../packages/gateway/src/filesystem.ts";
import { gatewayEnvironment } from "../../packages/gateway/src/environment.ts";
import { createWorkspaceResources } from "../../apps/server/src/workspace-resources.ts";

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((value) => value.startsWith("--" + name + "="));
  return hit === undefined ? fallback : Number(hit.slice(name.length + 3));
};
const rttMs = arg("rtt", 168);
const skillCount = arg("skills", 130);
const nodeCount = arg("nodes", 179);

/** One gateway filesystem that counts round trips by method, tracks peak concurrency, and injects the modelled RTT. */
function instrumented(inner: LocalFilesystem, delayMs: number) {
  const state = { total: 0, inFlight: 0, peak: 0, byMethod: new Map<string, number>(), paths: new Map<string, number>() };
  const server: FilesystemServer = {
    execute: async (request) => {
      state.total += 1;
      state.inFlight += 1;
      state.peak = Math.max(state.peak, state.inFlight);
      state.byMethod.set(request.method, (state.byMethod.get(request.method) ?? 0) + 1);
      const key = request.method + " " + (request.path ?? "");
      state.paths.set(key, (state.paths.get(key) ?? 0) + 1);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await inner.execute(request);
      } finally { state.inFlight -= 1; }
    },
    close: () => inner.close(),
  };
  return { server, state };
}

/** The synthetic execution host: N markdown resources spread over M directories, shaped like the live deployment. */
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
  // Skills live in groups so the walk has real directories to descend, not one flat list.
  const groupCount = Math.max(1, Math.round(nodeCount / 12));
  const perGroup = Math.ceil(skillCount / groupCount);
  let written = 0;
  for (let group = 0; group < groupCount && written < skillCount; group += 1) {
    const home_ = group % 2 === 0;
    const dir = join(home_ ? home : root, ".agents", "skills", "group-" + group);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < perGroup && written < skillCount; index += 1) {
      const name = "skill-" + group + "-" + index;
      await mkdir(join(dir, name), { recursive: true });
      await writeFile(join(dir, name, "SKILL.md"), "---\nname: " + name + "\ndescription: Skill " + name + "\n---\nBody of " + name + "\n");
      written += 1;
    }
  }
  for (let index = 0; index < 3; index += 1) await writeFile(join(root, ".pi", "prompts", "prompt-" + index + ".md"), "---\ndescription: Prompt " + index + "\n---\nDo " + index + "\n");
  await writeFile(join(home, ".pi", "agent", "prompts", "global.md"), "---\ndescription: Global\n---\nGlobal\n");
  return { home, root };
}

const base = await mkdtemp(join(tmpdir(), "hepi-rpc-count-"));
try {
  const { home, root } = await buildHost(base);
  const workspaces = [{ id: "local", root }];
  const inner = new LocalFilesystem(workspaces, { identity: { user: "operator", home } });
  const { server, state } = instrumented(inner, rttMs);
  const gateway = new GatewayRpcServer(new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }), undefined, server);
  await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
  const address = gateway.server.address();
  if (address === null || typeof address !== "object") throw new Error("the gateway did not start");
  const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };
  const env = gatewayEnvironment(binding, "/");
  const resources = createWorkspaceResources({ projectTrusted: true, diagnostics: () => {} });

  const startedAt = Date.now();
  const discovered = await resources.discover(env, BACKGROUND_CONTEXT);
  const wallMs = Date.now() - startedAt;
  await gateway.close();

  const byMethod = [...state.byMethod.entries()].sort((left, right) => right[1] - left[1]);
  const repeated = [...state.paths.entries()].filter(([, count]) => count > 1).sort((left, right) => right[1] - left[1]);
  const report = {
    modelledRttMs: rttMs,
    requestedSkills: skillCount,
    requestedNodes: nodeCount,
    catalogSize: discovered.status === "loaded" ? discovered.catalog.length : null,
    contextFiles: discovered.status === "loaded" ? discovered.contextFiles.length : null,
    totalRoundTrips: state.total,
    peakInFlight: state.peak,
    serializedRttMs: state.total * rttMs,
    wallMs,
    byMethod: Object.fromEntries(byMethod),
    repeatedPaths: repeated.slice(0, 12),
    repeatedPathCount: repeated.length,
  };
  console.log(JSON.stringify(report, null, 1));
} finally {
  await rm(base, { recursive: true, force: true });
}
