/**
 * Controlled backend for ticket 09's browser driver: a real backend on a real local execution host whose workspace is a
 * temporary directory, with the optional subagent extension enabled on one conversation and a real worker definition
 * written into that workspace.
 *
 * The gateway, the backend and the workspace live in this process; the model endpoint is the driver's own controlled
 * OpenAI-completions server. Nothing here contacts a paid provider, and nothing here is a second runtime: the child,
 * its anchor and the reporter are the real native tasks the production composition installs.
 *
 * Usage: node scripts/pending-items-fixture.ts   (driven by apps/web/e2e/ux-pending-item-controls.mjs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createBackendServer } from "../src/server.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const base = process.env.HEPI_UX09_FIXTURE ?? "";
const dbPath = process.env.HEPI_UX09_DB ?? "";
const port = Number(process.env.HEPI_UX09_BACKEND_PORT ?? 44109);
const token = process.env.HEPI_UX09_AUTH ?? "ux-pending-items-token";
const model = process.env.HEPI_UX09_MODEL ?? "controlled-1";
const endpoint = process.env.HEPI_UX09_ENDPOINT ?? "";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_UX09_FIXTURE, HEPI_UX09_DB and HEPI_UX09_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(join(root, ".pi", "agents"), { recursive: true });
// A real definition on the workspace's own host, which is what a delegation resolves.
await writeFile(join(root, ".pi", "agents", "worker.md"), "---\nname: worker\ndescription: worker\ntools:\n  - read\ncontext: fresh\n---\n\nAnswer the task briefly.\n");

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

const models = createModels({ authContext: { env: async () => "controlled-key", fileExists: async () => false } });
models.setProvider(createProvider({
  id: "magpie", name: "controlled subagents", baseUrl: endpoint + "/v1",
  auth: { apiKey: envApiKeyAuth("fixture key", ["FIXTURE_KEY"]) },
  models: [{ id: model, name: model, api: "openai-completions", provider: "magpie", baseUrl: endpoint + "/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4_000_000, maxTokens: 1_000_000 }],
  api: openAICompletionsApi(),
}));
const backend = await createBackendServer({ dbPath, authToken: token, workspaces: [binding], workspaceResources: createWorkspaceResources({ diagnostics: () => {}, projectTrusted: true }), models, defaultModel: { provider: "magpie", modelId: model } });
await new Promise<void>((resolveListen) => backend.server.listen(port, "127.0.0.1", resolveListen));
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
const origin = "http://127.0.0.1:" + port;
// One conversation, bound to this fixture's workspace, with delegation on: the parent a user drives in the browser.
const catalog = await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] };
if (catalog.conversations.length === 0) {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  if (created.status !== 201) throw new Error("the fixture backend could not create a conversation: " + created.status);
}
// Delegation is on for every conversation this fixture serves, which is what a user turning the capability on does.
for (const row of (await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] }).conversations) {
  const selected = await fetch(origin + "/api/conversations/" + row.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  if (selected.status !== 200) throw new Error("the fixture could not enable delegation: " + selected.status + " " + await selected.text());
}
console.log("hepi pending-items fixture on " + origin);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => gateway.close()).then(() => process.exit(0)); });
