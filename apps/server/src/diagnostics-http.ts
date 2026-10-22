import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { PROTOCOL_VERSION } from "@hepi/protocol";
import type { DeviceCredentials } from "./device-credentials.ts";

/**
 * The diagnostics surface: the two operator pages this process serves, the descriptor that states what this build is,
 * and the device-credential routes the client ingress admits callers with.
 *
 * None of it is conversation work. The pages are static files served before admission, the descriptor states the
 * identity a caller is connected to and the capabilities this build really has, and the credential routes are the one
 * place a device credential is listed, issued, revoked and checked. A capability a deployment did not configure is
 * absent from the descriptor rather than stated as false-by-hope, because a client acts on what is there.
 */

/** The identity the ingress admitted, as it states it on every request it forwards. */
type ClientIdentity = { readonly kind: "web" } | { readonly kind: "device"; readonly id: string; readonly label: string };

export type DiagnosticsHttpOptions = {
  /** The build id this deployment states, or undefined when it states none. */
  readonly buildId: string | undefined;
  /** The identity this backend reports for itself, which a client is connected to. */
  readonly backendId: string;
  /** The account scope every conversation, project and credential here belongs to. */
  readonly accountScope: string;
  /** Which optional capabilities this deployment actually configured. */
  readonly capabilities: Record<string, boolean>;
  /** The device credentials this deployment issues, when it issues any. */
  readonly deviceCredentials: DeviceCredentials | undefined;
  /** Read a bounded JSON request body, or `undefined` when it is absent or malformed. */
  readonly readBody: (request: IncomingMessage, limitBytes?: number) => Promise<unknown>;
};

/**
 * The two operator pages, served **before** admission.
 *
 * They are the surface an operator opens to paste a token into, so requiring one to load them would be a lock with its
 * key inside. They are still this module's: they are what this build shows about itself, and the entry states only the
 * order — pages, then admission, then everything a client may read.
 */
export function createDiagnosticsPages(): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    const script = url.pathname.endsWith(".js");
    const name = url.pathname === "/diagnostics" || url.pathname === "/diagnostics.js" ? "diagnostics"
      : url.pathname === "/workbench" || url.pathname === "/workbench.js" ? "workbench"
      : undefined;
    if (request.method !== "GET" || name === undefined) return false;
    const page = await readFile(new URL(script ? "../public/" + name + ".js" : "../public/" + name + ".html", import.meta.url));
    response.writeHead(200, { "content-type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" }); response.end(page); return true;
  };
}

export function createDiagnosticsHttp(options: DiagnosticsHttpOptions): (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<boolean> {
  return async (request, response, url) => {
    // The one client-facing description of this Backend. It states the identity a caller is connected to, the account
    // scope it is scoped to, the build that answered and the capabilities this build really has — and nothing a client
    // could infer a version negotiation from, because there is none: a client speaks this protocol or it does not
    // connect. The caller's own identity is added by the ingress that admitted it, so this route never guesses one.
    if (url.pathname === "/api/descriptor" && request.method === "GET") {
      const identity = readIdentity(request, response);
      if (identity === undefined) return true;
      json(response, 200, {
        protocol: PROTOCOL_VERSION,
        client: identity,
        backend: { id: options.backendId },
        account: { scope: options.accountScope },
        build: { id: options.buildId ?? null },
        capabilities: options.capabilities,
      });
      return true;
    }
    if (url.pathname === "/api/device-credentials") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return true; }
      if (request.method === "GET") { json(response, 200, { credentials: options.deviceCredentials.list() }); return true; }
      if (request.method === "POST") {
        const body = await options.readBody(request) as { label?: unknown } | undefined;
        if (typeof body?.label !== "string" || body.label.trim() === "") { json(response, 400, { error: "a label is required" }); return true; }
        json(response, 201, options.deviceCredentials.issue({ label: body.label.trim() })); return true;
      }
      json(response, 405, { error: "method not allowed" }); return true;
    }
    if (url.pathname.startsWith("/api/device-credentials/") && request.method === "DELETE") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return true; }
      const id = decodeURIComponent(url.pathname.slice("/api/device-credentials/".length));
      const revoked = options.deviceCredentials.revoke(id);
      json(response, revoked ? 200 : 404, revoked ? { ok: true, id } : { error: "unknown credential" }); return true;
    }
    // One client request's authority, asked by the client ingress on every request it admits and again on the revocation
    // interval for a response that stays open. It is a check, never an issuance, and it answers with the credential's
    // identity only: the digest it was looked up by is never in the answer.
    if (url.pathname === "/internal/credentials/verify" && request.method === "POST") {
      if (options.deviceCredentials === undefined) { json(response, 404, { error: "device credentials are not configured" }); return true; }
      const body = await options.readBody(request) as { token?: unknown } | undefined;
      const checked = typeof body?.token === "string" && body.token !== "" ? options.deviceCredentials.check(body.token) : { ok: false as const, reason: "unknown" as const };
      json(response, 200, checked); return true;
    }
    return false;
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * The client identity the ingress admitted, which it states on every request it forwards.
 *
 * It travels on the ingress's own service-credential request, so this server does not have to re-derive an identity it
 * never saw: the ingress is the one surface that admits a client, and a header it sets is a fact about the request it
 * already authorized. A malformed one is refused rather than defaulted, because a descriptor that names the wrong
 * client is worse than no descriptor.
 */
function readIdentity(request: IncomingMessage, response: ServerResponse): ClientIdentity | undefined {
  const header = request.headers["x-hepi-client"];
  const value = typeof header === "string" ? header : undefined;
  if (value === undefined) { json(response, 400, { error: "the client identity is required" }); return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { json(response, 400, { error: "the client identity is malformed" }); return undefined; }
  if (typeof parsed !== "object" || parsed === null) { json(response, 400, { error: "the client identity is malformed" }); return undefined; }
  const stated = parsed as { kind?: unknown; id?: unknown; label?: unknown };
  if (stated.kind === "web") return { kind: "web" };
  if (stated.kind === "device" && typeof stated.id === "string" && typeof stated.label === "string") return { kind: "device", id: stated.id, label: stated.label };
  json(response, 400, { error: "the client identity is malformed" });
  return undefined;
}
