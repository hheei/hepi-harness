/**
 * Controlled backend for the terminal-in-pool probe: the real backend bound to a real local gateway that serves
 * terminals, with this probe's own controlled completions endpoint as the model. Nothing here contacts a paid
 * provider, and no tracked product file is touched: this fixture only adds the TerminalSessions argument the
 * image-submit fixture omits, so a browser terminal can really be opened.
 *
 * Diagnostic only — lives under .scratch/perf-follow-up/evidence/, driven by terminal-pool-probe.mjs.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const worktree = process.env.HEPI_PROBE_WORKTREE ?? "";
const base = process.env.HEPI_PROBE_FIXTURE ?? "";
const dbPath = process.env.HEPI_PROBE_DB ?? "";
const port = Number(process.env.HEPI_PROBE_BACKEND_PORT ?? 45580);
const token = process.env.HEPI_PROBE_AUTH ?? "probe-token";
const model = process.env.HEPI_PROBE_MODEL ?? "probe-model";
const endpoint = process.env.HEPI_PROBE_ENDPOINT ?? "";
if (!worktree || !base || !dbPath || !endpoint) throw new Error("Set HEPI_PROBE_WORKTREE, HEPI_PROBE_FIXTURE, HEPI_PROBE_DB and HEPI_PROBE_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(join(root, "sub"), { recursive: true });

const gw = await import(worktree + "/packages/gateway/src/index.ts");
const { LocalFilesystem } = await import(worktree + "/packages/gateway/src/filesystem.ts");
const { LocalInstallServer } = await import(worktree + "/packages/gateway/src/install.ts");
const { createBackendServer } = await import(worktree + "/apps/server/src/server.ts");
const { customProviderFromEnv } = await import(worktree + "/apps/server/src/provider-config.ts");
const { createWorkspaceResources } = await import(worktree + "/apps/server/src/workspace-resources.ts");

const registry = new gw.WorkspaceRegistry([{ id: "local", root }]);
const gateway = new gw.LocalGateway({ id: "workstation", token: "gateway-token", workspaces: registry, allowedCommands: ["bash"] });
const identity = gw.localExecutionHostIdentity();
const terminals = new gw.TerminalSessions({ id: "workstation", workspaces: registry, launcher: gw.localTerminalLauncher() });
const rpc = new gw.GatewayRpcServer(
  gateway,
  undefined,
  new LocalFilesystem(registry),
  new LocalInstallServer(registry, { identity }),
  new gw.WorkspaceServer(registry, { identity }),
  new gw.GatewayWorktrees(registry),
  terminals,
);
await new Promise((resolveListen) => rpc.server.listen(0, "127.0.0.1", resolveListen));
const address = rpc.server.address();
if (address === null || typeof address !== "object") throw new Error("the gateway did not start");
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + address.port, gatewayToken: "gateway-token" };

const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: endpoint + "/v1", HEPI_PROVIDER_API_KEY: "controlled-key" });
if (custom === undefined) throw new Error("the controlled provider configuration was rejected");
const backend = await createBackendServer({
  dbPath,
  authToken: token,
  workspaces: [binding],
  workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }),
  models: custom.models,
  defaultModel: custom.defaultModel,
});
await new Promise((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
console.log("probe fixture on http://127.0.0.1:" + port + " (gateway " + binding.gatewayOrigin + ", workspace root " + root + ")");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void backend.close().then(() => rpc.close()).then(() => process.exit(0)); });
