import { dirname, resolve } from "node:path";
import { createBackendServer } from "./server.ts";
import { customProviderFromEnv } from "./provider-config.ts";
import { loadPiConfig } from "./pi-config.ts";
import { modelsConfigPath, openEnvModelRuntime, resolveAgentDir, type ModelConfigTarget } from "./model-config.ts";
import { createSkillMarket, type SkillMarket } from "./skill-repository.ts";
import { createProjectStore, type ProjectStore } from "./project-store.ts";
import { createDeviceCredentials, type DeviceCredentials } from "./device-credentials.ts";
import { parseMcpToolDeclarations } from "./mcp-declarations.ts";

const dbPath = process.env.HEPI_DB ?? resolve(process.cwd(), "data/hepi.sqlite");
const bindHost = process.env.HEPI_BIND_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(bindHost) && !process.env.HEPI_AUTH_TOKEN) throw new Error("HEPI_AUTH_TOKEN is required for non-loopback binding");
const authToken = process.env.HEPI_AUTH_TOKEN ?? "local-development-token";
const port = Number(process.env.PORT ?? 8787);
// The gateway connections this deployment configured, each as this process reaches it (in a split deployment that is
// the tunnel's loopback address, not the Web host's own). A workspace binding is one connection plus a workspace id; a
// project names a connection by its id and adds the folder it was created from, so project metadata stores no gateway
// token and a project can never be routed to a host the operator did not configure. `HEPI_GATEWAYS` lists several as
// a JSON array of `{ "id", "url", "token" }`; the `HEPI_GATEWAY_*` triple is the single-connection form.
function configuredGateways(): { gatewayId: string; gatewayOrigin: string; gatewayToken: string }[] {
  const listed = process.env.HEPI_GATEWAYS;
  if (listed !== undefined && listed.trim() !== "") {
    // A SyntaxError from JSON.parse quotes the offending input, which here is a list of gateway tokens: the deployment's
    // own secrets must not be written to a log or an error page, so the failure is reported as a fixed message. Each
    // entry is validated field by field for the same reason (an entry's own text is never echoed back).
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed);
    } catch {
      throw new Error("HEPI_GATEWAYS is not valid JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("HEPI_GATEWAYS must be a JSON array of { id, url, token }");
    return parsed.map((entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("HEPI_GATEWAYS entry " + index + " must be an object with a string id, url and token");
      const value = entry as { id?: unknown; url?: unknown; token?: unknown };
      if (typeof value.id !== "string" || typeof value.url !== "string" || typeof value.token !== "string") throw new Error("HEPI_GATEWAYS entry " + index + " needs a string id, url and token");
      return { gatewayId: value.id, gatewayOrigin: value.url, gatewayToken: value.token };
    });
  }
  return process.env.HEPI_GATEWAY_URL && process.env.HEPI_GATEWAY_TOKEN
    ? [{ gatewayId: process.env.HEPI_GATEWAY_ID ?? "workstation", gatewayOrigin: process.env.HEPI_GATEWAY_URL, gatewayToken: process.env.HEPI_GATEWAY_TOKEN }]
    : [];
}
const gateways = configuredGateways();
// The connection this deployment's own workspace binding uses, and the one a split deployment's tunnel addresses.
const gateway = gateways.find(connection => connection.gatewayId === process.env.HEPI_GATEWAY_ID) ?? gateways[0];
const workspaces = gateway !== undefined && process.env.HEPI_WORKSPACE_ID ? [{ id: process.env.HEPI_WORKSPACE_ID, ...gateway }] : [];
const piConfig = await loadPiConfig();
// Both modes are served by one kind of authority: a ModelRuntime over the backend agent directory's models.json, which is
// what the Settings editor reads and saves. Pi mode builds it from that directory (including auth.json); environment mode
// builds the same runtime but registers the deployment's configured provider as an environment-owned base layer and keeps
// credentials in memory, so its alias, endpoint and credential reference survive a restart without being copied to disk.
const agentDir = piConfig?.agentDir ?? resolveAgentDir();
const customProvider = piConfig ? undefined : customProviderFromEnv();
const models = piConfig?.models ?? await openEnvModelRuntime({ agentDir, custom: customProvider?.provider });
const modelConfig: ModelConfigTarget = { path: modelsConfigPath(agentDir), runtime: models };
// Every mode names its default explicitly, including "none configured". A deployment that configured no model names no
// default: new conversations start with none and settle natively as no_model until one is selected, rather than being
// handed a scripted placeholder that would answer as if a model were configured. Models the file or the ambient
// environment does offer are still listed and selectable. A default is only ever the paired HEPI_PROVIDER/HEPI_MODEL
// selection that provider-config.ts validated; HEPI_MODEL alone names no provider and therefore selects nothing.
const defaultModel = piConfig ? piConfig.defaultModel ?? null : customProvider?.defaultModel ?? null;
// Every execution-side resource — skills, prompts, context and system prompts — comes from the bound workspace's
// execution host through one loader (ADR 0002). Project `.pi` prompts follow the same project-trust setting Pi uses.
const { createWorkspaceResources } = await import("./workspace-resources.ts");
const workspaceResources = createWorkspaceResources({ projectTrusted: piConfig?.resourceSettings.defaultProjectTrust === "always", ...(piConfig ? { enableSkillCommands: piConfig.resourceSettings.enableSkillCommands } : {}) });
// Pi settings can name backend-side resource paths; execution-side resources are host content, so those paths no
// longer apply and are reported instead of silently loading harness-local files.
if (piConfig !== undefined) {
  const ignored = [...piConfig.resourceSettings.skills, ...piConfig.resourceSettings.prompts];
  if (ignored.length > 0) console.warn("Pi resource paths are not applied: execution-side resources come from the workspace's execution host: " + ignored.join(", "));
}
for (const warning of piConfig?.warnings ?? []) console.warn("Pi config: " + warning);
// Repository metadata has its own SQLite file next to the conversation database, so resource management never
// redefines durable session ownership (ADR 0002). A failed open must not stop the backend: the market is optional.
const repositoryPath = process.env.HEPI_SKILL_REPOSITORY ?? resolve(dirname(dbPath), "skill-repository.sqlite");
let skillMarket: SkillMarket | undefined;
try {
  skillMarket = createSkillMarket({ path: repositoryPath });
} catch (error) {
  console.warn("Skill repository unavailable at " + repositoryPath + ": " + (error instanceof Error ? error.message : String(error)));
}
// Project metadata has its own SQLite file next to the conversation database, the same way repository metadata does
// (ADR 0002). A failed open must not stop the backend: without it no project can be created, and everything else works.
const projectsPath = process.env.HEPI_PROJECTS ?? resolve(dirname(dbPath), "projects.sqlite");
let projects: ProjectStore | undefined;
try {
  projects = createProjectStore({ path: projectsPath });
} catch (error) {
  console.warn("Project store unavailable at " + projectsPath + ": " + (error instanceof Error ? error.message : String(error)));
}
// Device credentials have their own SQLite file beside the conversation database, the same ownership split the project
// and repository stores use (ADR 0002): a credential is not durable conversation state, so it never shares the
// conversation database. A failed open must not stop the backend, but without it no device can be issued or verified.
const credentialsPath = process.env.HEPI_DEVICE_CREDENTIALS ?? resolve(dirname(dbPath), "device-credentials.sqlite");
let deviceCredentials: DeviceCredentials | undefined;
try {
  deviceCredentials = createDeviceCredentials({ path: credentialsPath });
} catch (error) {
  console.warn("Device credential store unavailable at " + credentialsPath + ": " + (error instanceof Error ? error.message : String(error)));
}
// The keepalive cadence this deployment states for its conversation streams, in milliseconds. It exists because a
// hop in front of the backend bounds how long a response body may stay silent; `0` states no keepalive at all, and an
// unset value reads the protocol's stated default.
const heartbeatIntervalMs = process.env.HEPI_HEARTBEAT_MS === undefined ? undefined : Number(process.env.HEPI_HEARTBEAT_MS);
if (heartbeatIntervalMs !== undefined && !Number.isFinite(heartbeatIntervalMs)) throw new Error("HEPI_HEARTBEAT_MS must be a number of milliseconds");
// The MCP tools this deployment offers its conversations, read from its own environment and validated against the
// gateways configured above. The route has a tool listing since 03a, and this composition does not read it: a
// conversation's offer is a grant a person made, and 03b is the slice that turns a listing into one, so for now the
// offer (see src/mcp-declarations.ts) is what the deployment declares; a bad entry stops startup rather than leaving a
// conversation without a tool it
// was supposed to have.
const mcpTools = parseMcpToolDeclarations(process.env.HEPI_MCP_TOOLS, gateways.map(connection => connection.gatewayId));
const backend = await createBackendServer({ dbPath, authToken, workspaces, gateways, projects, defaultModel, modelConfig, workspaceResources, skillMarket, deviceCredentials, defaultThinkingLevel: piConfig?.defaultThinkingLevel, settings: piConfig?.settings, models, heartbeatIntervalMs, mcpTools });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void backend.close().then(() => { skillMarket?.close(); projects?.close(); deviceCredentials?.close(); process.exit(0); }); });
backend.server.listen(port, bindHost, () => {
  const address = backend.server.address();
  console.log("hepi backend: http://localhost:" + (address && typeof address === "object" ? address.port : port));
});
