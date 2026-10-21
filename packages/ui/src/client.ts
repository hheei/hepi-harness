import { AgentEventConnection, type AgentEventLike, type AgentEventSubscription, type ConversationSourceFactory } from "@hepi/session/browser";
import { createResourceReader, type ResourceLimits, type ResourceReader } from "@hepi/session/resources";
import { createExecutionResources, type ExecutionResources } from "@hepi/session/execution-resources";
import type { TerminalConnection } from "./lib/terminal-client";

/**
 * The connection this workbench was admitted to, and everything a page may only hold one of.
 *
 * A client is created **per connection**, never per mount: the profile, the Gateway origin and the identity the server
 * confirmed are what decide which conversations, drafts, cached views and resources belong to each other. Two clients
 * therefore share nothing, and switching connection disposes one and creates the other, so a late answer from the old
 * Gateway has no place to land — the client it was asked of is disposed.
 *
 * What the workbench asks it for is named, and the raw transport seam stays inside: no caller assembles an origin, a
 * header or a URL path, and no caller decides whether a request is still current. The four things it owns are:
 *
 * - **the stream**, through one {@link AgentEventConnection} for the whole page. A conversation's stream is opened by
 *   the first reader and closed by the last, so the open surface and a background interest in the same conversation are
 *   two readers of one connection. Releasing one reader is not a statement that the run is over and does not stop it.
 * - **read blocks**, through one {@link ResourceReader} scope, whose blob leases are revoked when this client is
 *   disposed — a page that switched connection cannot keep showing the previous one's image.
 * - **execution-side resources**, through one {@link ExecutionResources} scope: the repository reads and the skills,
 *   installations and agent definitions of a `select()`ed execution target. Which computer that target is on is the
 *   Backend's binding resolution, so a surface here names a workspace and never a host, and disposing the client retires
 *   every target it selected.
 *
 * It does not decide what a conversation means. The lifecycle projection, the reducer and the ordering rules stay with
 * the session hook that owns them; this only performs I/O and resource lifetime, and `dispose` stops being able to
 * talk to the Gateway rather than stopping any work the Backend is doing.
 */
export interface WorkbenchClient {
  /** The normalized Gateway origin every request and read block resolves against, with no trailing slash. */
  readonly origin: string;
  /**
   * How this connection authenticates, as the host stated it.
   *
   * It is stated because one surface needs it for a transport the client does not own: a browser reports upload
   * progress only from `XMLHttpRequest`, and that request must present the same credential as every other. The value is
   * the connection's own, not a token a surface may choose, and it is never put in an address.
   */
  readonly credential: WorkbenchClientOptions["credential"];
  /** Join one conversation's stream; the returned subscription is this reader's own interest and nothing more. */
  subscribe<TMessage = unknown>(conversationId: string, listener: (event: AgentEventLike) => void): AgentEventSubscription<TMessage>;
  /**
   * One named request against the client API, resolved against this connection's origin.
   *
   * It is ended by the connection's disposal and by the caller's own `init.signal` — never by another caller's, because a
   * request one consumer started may be the one another is waiting on.
   */
  request(path: string, init?: RequestInit): Promise<Response>;
  /**
   * One named request, read as JSON, against this connection's origin — the shape every caller below the workbench asks
   * for, so no surface assembles an origin, a header or a URL and none of them repeats the refusal handling.
   *
   * A non-2xx answer is a rejection carrying the status, the Backend's own `error`/`code` when it stated them, and its
   * body, because a named refusal is a fact a caller shows rather than an empty failure. A transport failure is passed
   * through as it is: it is not an answer about the conversation.
   */
  readJson<T>(path: string, init?: RequestInit): Promise<T>;
  /** The read-block reader for this scope: bounded texts and leased images. */
  readonly resources: ResourceReader;
  /** The repository reads and the `select()`ed execution targets of this connection. */
  readonly execution: ExecutionResources;
  /**
   * How this connection reaches the Gateway: its origin, its own credential and the platform's fetch.
   *
   * A surface that owns another stream — the page's one terminal stream is the case — is handed this rather than the raw
   * material, so it presents exactly the identity this client was admitted with and cannot disagree with it.
   */
  readonly connection: TerminalConnection;
  /** Whether `dispose` has run. A disposed client refuses every later request. */
  readonly disposed: boolean;
  /**
   * Revoke resources, close this connection's streams, abort its in-flight requests and refuse later work. A transport
   * that answers after this is refused too. Repeating it changes nothing.
   */
  dispose(): void;
}

/** One refusal this client's connection stated, as a caller needs to see it: its status, its code and its body. */
export class WorkbenchRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly body?: Record<string, unknown>;
  constructor(message: string, status: number, code?: string, body?: Record<string, unknown>) {
    super(message);
    this.name = "WorkbenchRequestError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type WorkbenchClientOptions = {
  /** The Gateway origin this connection was admitted to, as the host stated it. Empty means same-origin. */
  readonly origin: string;
  /** How this client authenticates: the browser's own cookie, or one device bearer. */
  readonly credential: { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly token: string };
  /** The host's fetch. A browser's cookie jar and a shell's TLS are platform facts, so they are injected. */
  readonly fetch?: typeof fetch;
  /** The stream factory for one conversation. Named by the host because a native shell assembles its own requests. */
  readonly createSource: ConversationSourceFactory;
  readonly readinessTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  /** Called for a transport failure this client could not attribute to a caller's own request. */
  readonly onUnexpectedError?: (error: unknown) => void;
  /**
   * How much of this connection's memory its read-block leases may hold. A page states it because the bound is the
   * host's: a shell with a small budget refuses a large preview rather than growing into it.
   */
  readonly limits?: Partial<ResourceLimits>;
};

/** One refusal a disposed connection states, wherever a caller meets it. */
const CLOSED_CONNECTION = "The connection this request belonged to is closed.";

/**
 * One request's abort signal: the connection's lifetime, and the caller's own interest in that one request.
 *
 * The two are combined by hand rather than with `AbortSignal.any()`, which this app's browser floor (Safari 16.2) does
 * not have. `release` detaches the forwarding listener, so a caller's long-lived controller does not accumulate one per
 * request it makes — and it is called when the response's body is done, not when its headers arrive, because a body is
 * the rest of the same request: a download or a stalled answer is still on the wire after `fetch` resolves.
 */
function requestSignal(lifetime: AbortSignal, caller: AbortSignal | undefined): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const release = () => {
    lifetime.removeEventListener("abort", forward);
    caller?.removeEventListener("abort", forward);
  };
  const forward = () => {
    controller.abort();
    release();
  };
  if (lifetime.aborted || caller?.aborted) controller.abort();
  else {
    lifetime.addEventListener("abort", forward, { once: true });
    caller?.addEventListener("abort", forward, { once: true });
  }
  return { signal: controller.signal, release };
}

/**
 * One answer whose abort signal stays the connection's and the caller's for as long as its body is being read.
 *
 * The platform aborts a body when the signal it was handed aborts, so the signal has to outlive `fetch`. It is released
 * when this request is over: when the body is read to its end, or where the abort is forwarded.
 */
function withRequestSignal(response: Response, release: () => void): Response {
  const body = response.body;
  // A response with no readable body is a request that is already over: there is nothing left for the signal to end.
  if (body === null || typeof body?.pipeThrough !== "function") {
    release();
    return response;
  }
  // A body that is read to its end releases here; one that is aborted releases where the abort is forwarded. A body the
  // transport errors without an abort is the one state that keeps a detached listener pair until the connection is
  // disposed, and it is the state in which nothing further can be asked of that request anyway.
  const settled = body.pipeThrough(new TransformStream({ flush() { release(); } }));
  return new Response(settled, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createClient(options: WorkbenchClientOptions): WorkbenchClient {
  const origin = options.origin.replace(/\/+$/, "");
  const send = options.fetch ?? globalThis.fetch;
  let disposed = false;
  // The connection's own lifetime. A request outlives the caller that started it — two consumers share one catalogue
  // read — so what ends every request of this connection is the connection going away, not one caller's interest.
  const lifetime = new AbortController();

  const connection = new AgentEventConnection({
    createSource: options.createSource,
    readinessTimeoutMs: options.readinessTimeoutMs ?? 60_000,
    reconnectDelayMs: options.reconnectDelayMs ?? 1_000,
    ...(options.onUnexpectedError === undefined ? {} : { onUnexpectedError: options.onUnexpectedError }),
  });

  const resources = createResourceReader({
    origin,
    credential: options.credential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });

  // One value, stated once: a caller compares it by identity to decide whether the streams it owns still belong to the
  // connection it is showing, so a fresh object per access would restart them on every render.
  const binding: TerminalConnection = {
    ...(origin === "" ? {} : { origin }),
    credential: options.credential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };

  /** One request against this connection: its origin, its credential, and a disposed connection answering nothing. */
  async function request(path: string, init?: RequestInit): Promise<Response> {
    // A disposed client is a connection that is gone: answering a caller's late request with the next connection's
    // data would be exactly the contamination the scope exists to prevent.
    if (disposed) throw new Error(CLOSED_CONNECTION);
    const url = origin + (path.startsWith("/") ? path : "/" + path);
    const headers = new Headers(init?.headers);
    if (options.credential.kind === "bearer") headers.set("authorization", "Bearer " + options.credential.token);
    const { signal, release } = requestSignal(lifetime.signal, init?.signal ?? undefined);
    let response: Response;
    try {
      response = await send(url, { ...init, signal, headers, credentials: "same-origin" });
    } catch (error) {
      release();
      throw error;
    }
    // A transport that answers after disposal is an answer from a connection that is gone: handing it to the caller
    // would put the previous connection's data under the next one's name.
    if (disposed) {
      release();
      throw new Error(CLOSED_CONNECTION);
    }
    // The headers are not the whole answer: this request is over when its body is, so that is when the signal is let go.
    return withRequestSignal(response, release);
  }

  const execution = createExecutionResources({
    origin,
    credential: options.credential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  return {
    origin,
    credential: options.credential,
    resources,
    execution,
    connection: binding,
    get disposed() {
      return disposed;
    },
    subscribe<TMessage = unknown>(conversationId: string, listener: (event: AgentEventLike) => void): AgentEventSubscription<TMessage> {
      return connection.subscribe<TMessage>(conversationId, listener);
    },
    request,
    async readJson<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await request(path, init);
      const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown } & Record<string, unknown>;
      // The body arrives after the answer did, so disposal can land in between: a caller is not handed the body of a
      // connection that is gone either.
      if (disposed) throw new Error(CLOSED_CONNECTION);
      if (!response.ok) {
        throw new WorkbenchRequestError(
          typeof body.error === "string" && body.error !== "" ? body.error : "HTTP " + response.status,
          response.status,
          typeof body.code === "string" ? body.code : undefined,
          body,
        );
      }
      return body as T;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      connection.close();
      resources.dispose();
      execution.dispose();
    },
  };
}
