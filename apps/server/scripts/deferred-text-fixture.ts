/** Real backend/local gateway for deferred-text browser regression. Wide controlled model prevents compaction from replacing test input; no paid provider. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer } from "../src/server.ts";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
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
const gateway = new GatewayRpcServer({
  gateway: new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
  files: new LocalFilesystem(workspaces, { identity: { user: "operator", home } }),
  installs: new LocalInstallServer(workspaces, { identity: { user: "operator", home } }),
});
await new Promise<void>((resolveListen) => gateway.server.listen(0, "127.0.0.1", resolveListen));
const gatewayAddress = gateway.server.address();
if (gatewayAddress === null || typeof gatewayAddress !== "object") throw new Error("the gateway did not start");
const binding = { id: "local", gatewayId: "workstation", gatewayOrigin: "http://127.0.0.1:" + gatewayAddress.port, gatewayToken: "gateway-token" };

// Keep this transport regression below the controlled model's context limit; compaction is a separate contract.
const models = createModels({ authContext: { env: async () => "controlled-key", fileExists: async () => false } });
models.setProvider(createProvider({
  id: "magpie", name: "controlled transport", baseUrl: endpoint + "/v1",
  auth: { apiKey: envApiKeyAuth("fixture key", ["FIXTURE_KEY"]) },
  models: [{ id: model, name: model, api: "openai-completions", provider: "magpie", baseUrl: endpoint + "/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4_000_000, maxTokens: 1_000_000 }],
  api: openAICompletionsApi(),
}));
const backend = await createBackendServer({ dbPath, authToken: token, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), models, defaultModel: { provider: "magpie", modelId: model } });
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
