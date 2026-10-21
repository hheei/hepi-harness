/**
 * The browser's side of one terminal session: requests that carry the tab's routing cwd, and a writer that keeps shell
 * input ordered, batched and never replayed.
 *
 * Every call names the cwd the terminal belongs to, because the backend resolves a terminal's workspace from that cwd
 * on each request rather than keeping a registry of its own. Nothing here is pi-web's terminal manager: that one
 * spawned a shell in the Web process, and a terminal is a session on the conversation's execution host.
 *
 * The credential is the connection scope's, not this file's: a Web page states nothing and lets the browser attach its
 * own HttpOnly cookie, while an App presents one device bearer. That is the same choice \`@hepi/session\`'s readers make,
 * so no surface below the scope decides an identity, and a credential never travels in a URL.
 */

/** What one session reports: output as it is produced, and its exit once the process on the host is gone. */
export type TerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number | null; signal: number };

/** What a session is, as the host reports it: a tab restored from storage asks this before it attaches to anything. */
export type TerminalDescription = { ok: boolean; id?: string; cwd?: string; cols?: number; rows?: number; exited?: boolean; code?: string; message?: string };

/**
 * The credential one connection presents: the Web page's own cookie (attached by the browser, stated by nothing here) or
 * one explicit device bearer. The connection scope decides which, exactly as `@hepi/session`'s readers do, so no surface
 * below it chooses an identity.
 */
export type TerminalCredential = { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly token: string };

/**
 * How one connection reaches the Gateway: the origin it was admitted to, the credential it presents, and the platform's
 * own fetch. A tab's stream and its writer are both handed this one value — a client states it once, as
 * `WorkbenchClient.connection` — so the two can never disagree about the identity they were admitted with. Absent fields
 * read the page's own origin, its own cookie and the runtime's fetch.
 */
export type TerminalConnection = {
  readonly origin?: string;
  readonly credential?: TerminalCredential;
  readonly fetch?: typeof fetch;
};

/** The browser path of one terminal request, carrying the routing cwd it must be resolved against. */
export function terminalPath(id: string | null, cwd: string, action?: "events"): string {
  const base = id === null ? "/api/terminal" : "/api/terminal/" + encodeURIComponent(id) + (action === undefined ? "" : "/" + action);
  return base + "?cwd=" + encodeURIComponent(cwd);
}

/** One request on this connection: its own origin, its own credential, and nothing of the credential in the URL. */
function send(path: string, options: RequestInit, connection: TerminalConnection | undefined): Promise<Response> {
  const credential = connection?.credential ?? { kind: "cookie" };
  const origin = (connection?.origin ?? "").replace(/\/+$/, "");
  const headers = new Headers(options.headers);
  if (credential.kind === "bearer") headers.set("authorization", "Bearer " + credential.token);
  return (connection?.fetch ?? globalThis.fetch)(origin + path, {
    ...options,
    headers,
    credentials: credential.kind === "cookie" ? "same-origin" : "omit",
  });
}

export async function terminalRequest(path: string, options?: RequestInit, connection?: TerminalConnection): Promise<TerminalDescription> {
  const response = await send(path, { ...options, signal: AbortSignal.timeout(15_000) }, connection);
  const data = await response.json().catch(() => {
    throw new Error("Terminal request failed (HTTP " + response.status + "): server returned an empty or invalid JSON response. Check the pi-web server log.");
  });
  if (!data || typeof data !== "object") throw new Error("Terminal request failed (HTTP " + response.status + "): invalid JSON response. Check the pi-web server log.");
  // The backend and the host both name their refusals, so the panel shows the reason they gave rather than a status.
  if (!response.ok) throw new Error(data.message ?? data.error ?? data.code ?? "HTTP " + response.status);
  return data as TerminalDescription;
}

export function createTerminalWriter(id: string, cwd: string, onError: (error: Error) => void, connection?: TerminalConnection) {
  let pending = Promise.resolve();
  let stopped = false;
  let bufferedInput: { type: "input"; data: string } | null = null;
  const enqueue = (body: Record<string, unknown>) => {
    if (stopped) return;
    pending = pending.then(async () => {
      if (stopped) return;
      if (body === bufferedInput) bufferedInput = null;
      await terminalRequest(terminalPath(id, cwd), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, connection);
    }).catch((error: Error) => {
      // Delivery is ambiguous after a network error. Never replay shell input.
      stopped = true;
      onError(error);
    });
  };
  return {
    write(data: string) {
      if (stopped) return;
      for (const chunk of data.match(/[\s\S]{1,32768}/gu) ?? []) {
        if (bufferedInput && bufferedInput.data.length + chunk.length <= 65536) bufferedInput.data += chunk;
        else {
          bufferedInput = { type: "input", data: chunk };
          enqueue(bufferedInput);
        }
      }
    },
    resize(cols: number, rows: number) {
      bufferedInput = null;
      enqueue({ type: "resize", cols, rows });
    },
    stop() { stopped = true; bufferedInput = null; return pending; },
  };
}
