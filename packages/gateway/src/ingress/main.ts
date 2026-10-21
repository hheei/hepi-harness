import { createClientIngress } from "./index.ts";

/**
 * The client ingress's own entrypoint: read the environment, then start the client listener.
 *
 * It is a separate start on purpose. Today's running entry is the Backend's port and the execution gateway's loopback
 * listener; neither gains a new public bind from this file, and neither is changed by it. An operator that wants a
 * client ingress running states the Backend it fronts and the materials it admits, and this entry starts exactly that
 * listener and nothing else.
 *
 * The four materials are configuration here, and they stay distinct:
 *
 * - `HEPI_WEB_LOGIN_TOKEN` — the Web login material a browser exchanges for the ingress's own HttpOnly cookie. Absent
 *   states that this deployment gates no page behind a login, which is a legitimate deployment.
 * - `HEPI_INGRESS_SERVICE_TOKEN` — what this ingress presents to the Backend. It is never sent to a client, and the
 *   Backend refuses every client request that presents it.
 * - `HEPI_APP_ORIGINS` — the App origins answered cross-origin. An origin not listed is refused.
 * - The device credentials themselves are the Backend's records; this process never holds one and never stores one.
 * - `HEPI_INGRESS_DEFAULT_HOST` — the execution host this origin serves, as the gateway id the Backend was configured
 *   with. It is this deployment's own fact, so it is stated here and forwarded on every admitted request; a caller's
 *   request never names the computer it is served from.
 * - `HEPI_INGRESS_MCP_GATEWAY_URL`, `HEPI_INGRESS_MCP_GATEWAY_TOKEN` and `HEPI_INGRESS_MCP_GATEWAY_ID` — the gateway
 *   running on this origin's own computer, which owns its MCP configuration, and the name the Backend knows it by. They
 *   are this deployment's own fact, and the token is outbound only: it reaches the host service and no client. The id is
 *   what a folder-scoped request is checked against, so a workspace the Backend binds to another gateway is refused
 *   rather than answered by this host's folder of the same name. Absent states that this origin serves no MCP host
 *   service, and the MCP
 *   routes answer a named limit while every other route keeps working.
 *
 * - `HEPI_INGRESS_STATIC_DIR` — the directory this listener serves the Web build from, on the same origin as `/api`.
 *   It is a Vite `dist`, stated as the deployment's own fact like every other line above; absent states that this
 *   ingress serves no page, which is what an App-only ingress or one behind a proxy that already serves the build
 *   states. Nothing is guessed from the working directory, because a listener that serves whatever happens to sit
 *   beside it is a listener whose page is decided by where it was started.
 *
 * The execution token is not configuration here at all: the ingress serves no `/v1` route, so an execution credential
 * has nothing to reach on this listener.
 */

const backendOrigin = process.env.HEPI_INGRESS_BACKEND;
const serviceToken = process.env.HEPI_INGRESS_SERVICE_TOKEN;
if (!backendOrigin || !serviceToken) throw new Error("Set HEPI_INGRESS_BACKEND and HEPI_INGRESS_SERVICE_TOKEN");

// A non-loopback bind is a public listener, so it must state the Web login material it admits: a public ingress with no
// login is a public ingress with no Web identity at all, which is not a default worth guessing.
const host = process.env.HEPI_INGRESS_HOST ?? "127.0.0.1";
const port = Number(process.env.HEPI_INGRESS_PORT ?? 8790);
const webLoginToken = process.env.HEPI_WEB_LOGIN_TOKEN;
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !webLoginToken) throw new Error("HEPI_WEB_LOGIN_TOKEN is required for a non-loopback client ingress");
const appOrigins = (process.env.HEPI_APP_ORIGINS ?? "").split(",").map(origin => origin.trim()).filter(Boolean);
const defaultHostId = process.env.HEPI_INGRESS_DEFAULT_HOST;
// Stated together or not at all: a host service named without the material to reach it is a configuration error, not a
// deployment that serves no MCP — answering "no MCP here" would hide a typo behind a legitimate answer.
const mcpOrigin = process.env.HEPI_INGRESS_MCP_GATEWAY_URL;
const mcpToken = process.env.HEPI_INGRESS_MCP_GATEWAY_TOKEN;
const mcpGatewayId = process.env.HEPI_INGRESS_MCP_GATEWAY_ID;
if ([mcpOrigin, mcpToken, mcpGatewayId].some(value => value !== undefined) && [mcpOrigin, mcpToken, mcpGatewayId].some(value => value === undefined)) {
	throw new Error("Set HEPI_INGRESS_MCP_GATEWAY_URL, HEPI_INGRESS_MCP_GATEWAY_TOKEN and HEPI_INGRESS_MCP_GATEWAY_ID together, or none of them");
}
const revocationCheckIntervalMs = process.env.HEPI_REVOCATION_CHECK_MS === undefined ? undefined : Number(process.env.HEPI_REVOCATION_CHECK_MS);
if (revocationCheckIntervalMs !== undefined && !(revocationCheckIntervalMs > 0)) throw new Error("HEPI_REVOCATION_CHECK_MS must be a positive number of milliseconds");
// The batch bound one browser upload may carry. Absent keeps the surface's own default, so a deployment that says
// nothing gets the same number the previous hop enforced.
const uploadBatchBytes = process.env.HEPI_UPLOAD_BATCH_BYTES === undefined ? undefined : Number(process.env.HEPI_UPLOAD_BATCH_BYTES);
if (uploadBatchBytes !== undefined && !(uploadBatchBytes > 0)) throw new Error("HEPI_UPLOAD_BATCH_BYTES must be a positive number of bytes");
// The Web build this listener serves, when it serves one. An empty value is a configuration mistake, not "no page":
// the second is stated by leaving the variable out, and a page that silently disappears is worse than a start that fails.
const staticDir = process.env.HEPI_INGRESS_STATIC_DIR;
if (staticDir === "") throw new Error("HEPI_INGRESS_STATIC_DIR must name a directory, or be unset to serve no page");

const ingress = createClientIngress({
	backend: { origin: backendOrigin, serviceToken },
	...(webLoginToken === undefined ? {} : { webLoginToken }),
	appOrigins,
	...(revocationCheckIntervalMs === undefined ? {} : { revocationCheckIntervalMs }),
	...(defaultHostId === undefined ? {} : { defaultHostId }),
	...(uploadBatchBytes === undefined ? {} : { uploadBatchBytes }),
	...(mcpOrigin === undefined || mcpToken === undefined || mcpGatewayId === undefined ? {} : { mcp: { origin: mcpOrigin, token: mcpToken, gatewayId: mcpGatewayId } }),
	...(staticDir === undefined ? {} : { staticDir }),
});
await new Promise<void>((resolveListen, rejectListen) => {
	ingress.server.once("error", rejectListen);
	ingress.server.listen(port, host, () => { ingress.server.off("error", rejectListen); resolveListen(); });
});
const address = ingress.server.address();
console.log("hepi client ingress: http://" + host + ":" + (address && typeof address === "object" ? address.port : port));

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void ingress.close().then(() => process.exit(0)); });
