/**
 * Controlled backend for the ticket-06 browser driver: the real backend bound to a real local gateway whose
 * workspace is a temporary directory, so a conversation has a genuine execution host and its resource load succeeds.
 *
 * The gateway, the backend and the workspace live in this process; the model endpoint is the driver's own controlled
 * local OpenAI-completions server. Nothing here contacts a paid provider.
 *
 * Usage: node scripts/image-submit-fixture.ts   (driven by apps/web/e2e/ux-image-submit.mjs)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { GatewayFiles } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer } from "../src/server.ts";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const base = process.env.HEPI_UX06_FIXTURE ?? "";
const dbPath = process.env.HEPI_UX06_DB ?? "";
const port = Number(process.env.HEPI_UX06_BACKEND_PORT ?? 44106);
const token = process.env.HEPI_UX06_AUTH ?? "ux-image-submit-token";
const model = process.env.HEPI_UX06_MODEL ?? "deepseek-v4.1-flash";
const endpoint = process.env.HEPI_UX06_ENDPOINT ?? "";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_UX06_FIXTURE, HEPI_UX06_DB and HEPI_UX06_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(root, { recursive: true });

const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
const gateway = new GatewayRpcServer(
  new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
  undefined,
  new GatewayFiles(workspaces, { identity: { user: "operator", home } }),
  new LocalInstallServer(workspaces, { identity: { user: "operator", home } }),
);
await new Promise<void>((resolveListen) => gateway.server.listen(0, "127.0.0.1", resolveListen));
const gatewayAddress = gateway.server.address();
if (gatewayAddress === null || typeof gatewayAddress !== "object") throw new Error("the gateway did not start");
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };

const custom = customProviderFromEnv({ HEPI_PROVIDER: "magpie", HEPI_MODEL: model, HEPI_PROVIDER_BASE_URL: endpoint + "/v1", HEPI_PROVIDER_API_KEY: "controlled-key" });
if (custom === undefined) throw new Error("the controlled provider configuration was rejected");
const backend = await createBackendServer({ dbPath, authToken: token, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), models: custom.models, defaultModel: custom.defaultModel });
await new Promise<void>((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const origin = "http://127.0.0.1:" + port;
// Every listed conversation is one this fixture created in its own workspace: the runtime's framework root record is
// never listed, so the count needs no filter.
const findBound = async (): Promise<number> => {
  const catalog = await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { workspaceId: string | null }[] };
  return catalog.conversations.length;
};
if (await findBound() === 0) {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  if (created.status !== 201) throw new Error("the fixture backend could not create a conversation: " + created.status);
}
console.log("hepi image-submit fixture on " + origin);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => gateway.close()).then(() => process.exit(0)); });
