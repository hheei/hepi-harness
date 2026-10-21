/**
 * Controlled backend for ticket 12's browser driver: a real backend on a real local execution host whose workspace is a
 * temporary directory, with delegation turned on for the one conversation the driver drives.
 *
 * The gateway, the backend and the workspace live in this process; the model endpoint is the driver's own controlled
 * OpenAI-completions server. Nothing here contacts a paid provider, and nothing here is a second runtime: the child, its
 * anchor and the reporter are the real native tasks the production composition installs.
 *
 * No agent definition is written here: the driver creates one through Settings, which is the point of the journey — the
 * definition the quick create runs has to be the one the Settings panel saved.
 *
 * A control server on its own port lets the driver take the execution host away, which is the only way to drive the
 * "the host cannot be reached" journey without stopping the backend the browser is talking to.
 *
 * Usage: node scripts/subagent-delegate-fixture.ts   (driven by apps/web/e2e/ux-subagent-delegate.mjs)
 */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GatewayRpcServer, LocalGateway } from "@hepi/gateway";
import { LocalFilesystem } from "../../../packages/gateway/src/filesystem.ts";
import { LocalInstallServer } from "../../../packages/gateway/src/install.ts";
import { createBackendServer } from "../src/server.ts";
import { customProviderFromEnv } from "../src/provider-config.ts";
import { createWorkspaceResources } from "../src/workspace-resources.ts";
import { WorkspaceRegistry } from "../../../packages/gateway/src/workspaces.ts";

const base = process.env.HEPI_UX12_FIXTURE ?? "";
const dbPath = process.env.HEPI_UX12_DB ?? "";
const port = Number(process.env.HEPI_UX12_BACKEND_PORT ?? 44112);
const controlPort = Number(process.env.HEPI_UX12_CONTROL_PORT ?? 44113);
const token = process.env.HEPI_UX12_AUTH ?? "ux-subagent-delegate-token";
const model = process.env.HEPI_UX12_MODEL ?? "controlled-1";
const endpoint = process.env.HEPI_UX12_ENDPOINT ?? "";
if (!base || !dbPath || !endpoint) throw new Error("Set HEPI_UX12_FIXTURE, HEPI_UX12_DB and HEPI_UX12_ENDPOINT");

const home = join(base, "backend-home");
const root = join(base, "workspace");
await mkdir(home, { recursive: true });
await mkdir(join(root, ".pi", "agents"), { recursive: true });

const workspaces = new WorkspaceRegistry([{ id: "local", root }]);
const gateway = new GatewayRpcServer(
  new LocalGateway({ id: "workstation", token: "gateway-token", workspaces, allowedCommands: ["bash"] }),
  undefined,
  new LocalFilesystem(workspaces, { identity: { user: "operator", home } }),
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
const catalog = await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] };
if (catalog.conversations.length === 0) {
  const created = await fetch(origin + "/api/conversations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "local" }) });
  if (created.status !== 201) throw new Error("the fixture backend could not create a conversation: " + created.status + " " + await created.text());
}
const rows = (await (await fetch(origin + "/api/conversations", { headers })).json() as { conversations: { id: string }[] }).conversations;
// Delegation is on for the conversation the driver drives, which is what a user turning the capability on does.
for (const row of rows) {
  const selected = await fetch(origin + "/api/conversations/" + row.id + "/extensions", { method: "PATCH", headers, body: JSON.stringify({ extensions: ["coding-tools", "hepi-subagents"] }) });
  if (selected.status !== 200) throw new Error("the fixture could not enable delegation: " + selected.status + " " + await selected.text());
}
console.log("HEPI_UX12_SEED " + JSON.stringify({ sessionId: rows[0].id }));

/** The driver's control of the execution host, which is how "the host cannot be reached" is driven for real. */
const control = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/offline") { void gateway.close().then(() => { response.writeHead(200).end("{}"); }); return; }
  response.writeHead(404).end();
});
await new Promise<void>((resolveListen) => control.listen(controlPort, "127.0.0.1", resolveListen));
console.log("hepi subagent-delegate fixture on " + origin);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => gateway.close()).then(() => control.close()).then(() => process.exit(0)); });
