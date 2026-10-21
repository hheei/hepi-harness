import {
  AgentEventConnection,
  AgentEventConnectionError,
  type AgentEventConnectionStatus,
  type AgentEventLike,
  type AgentEventSourceLike,
  type AgentEventSubscription,
} from "./agent-event-connection.ts";
import type { ServerFrame, SubmissionProjection } from "@hepi/protocol";
import { DurableSession, type SessionState } from "./index.ts";

export {
  AgentEventConnection,
  AgentEventConnectionError,
  type AgentEventConnectionStatus,
  type AgentEventLike,
  type AgentEventSourceLike,
  type AgentEventSubscription,
};

/**
 * How one conversation's stream is obtained: the transport's one assembly point, so the connection above it serves
 * every consumer while each consumer keeps its own way in.
 *
 * Two ways in exist and they are not interchangeable. The Web page reaches the backend through its own authenticated
 * BFF on the page's origin, where the credential is an httpOnly cookie the browser sends by itself and no script can
 * read — so its source adds no authentication material and must not. The diagnostic page under `apps/server` talks to
 * the backend directly and authenticates with a bearer token the operator typed into that page, which is the one
 * context where a token in the browser is the point.
 */
export type ConversationSourceFactory = (conversationId: string) => AgentEventSourceLike;

/**
 * One conversation's stream as this transport delivers it: the backend's own frames, under the names the backend gives
 * them, plus the one event the transport states for itself.
 *
 * The names are the backend's, not a translation of them: `snapshot` and `state` carry the native `ServerFrame`,
 * `submission` one `SubmissionProjection`, `resync_required` the marker that this reader's revision is not the one
 * the publisher holds, and `state_oversize` the named refusal of a frame that could not be carried. Nothing here
 * folds, projects or synthesizes a window: what a frame means is decided once, above this transport.
 *
 * What the transport adds is `connected` — the handshake the connection above waits for, stated when the baseline
 * frame arrives, because the baseline is what says the attachment is up.
 */
export type ConversationStreamEvent =
  | { readonly type: "connected"; readonly sessionId: string }
  | { readonly type: "frame"; readonly sessionId: string; readonly event: "snapshot" | "state"; readonly data: ServerFrame }
  | { readonly type: "submission"; readonly sessionId: string; readonly submission: SubmissionProjection }
  | { readonly type: "resync"; readonly sessionId: string }
  | { readonly type: "oversize"; readonly sessionId: string; readonly reason: string; readonly entryId: string | null; readonly bytes: number | null; readonly revision: number | null };

/**
 * The one physical stream reader, for both ways in: the backend's own SSE bytes through `fetch`, spoken as the
 * `onmessage`/readyState contract the connection above consumes.
 *
 * `fetch` rather than `EventSource` because the backend names its frames — `EventSource.onmessage` fires only for
 * unnamed ones — and because the diagnostic page must set `Authorization`, which `EventSource` cannot. One parser for
 * both means the Web page and the diagnostic page cannot disagree about what the wire said. The connection above owns
 * reconnection: this reader reports a closed or failed stream through `onerror` and is replaced.
 */
class StreamSource implements AgentEventSourceLike {
  readyState = 0;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly controller = new AbortController();
  /** Whether this attachment has stated its handshake, which the baseline frame is. */
  private handshaken = false;
  private readonly sessionId: string;
  constructor(sessionId: string, url: string, headers: Record<string, string>) {
    this.sessionId = sessionId;
    void this.read(url, headers);
  }
  close(): void { this.readyState = 2; this.controller.abort(); }
  async read(url: string, headers: Record<string, string>): Promise<void> {
    try {
      // Same-origin credentials by default, which is what carries the Web page's httpOnly cookie to its own BFF and
      // what keeps the diagnostic page's direct read from carrying anything but the header it states.
      const response = await fetch(url, { headers, credentials: "same-origin", signal: this.controller.signal });
      if (!response.ok || !response.body) throw new Error("Stream failed: " + response.status);
      this.readyState = 1;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!this.controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            this.deliver(frame);
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!this.controller.signal.aborted) this.onerror?.(new Event("error"));
    } catch { if (!this.controller.signal.aborted) this.onerror?.(new Event("error")); }
  }
  /**
   * One complete frame, as the stream named it. A comment frame — the origin's keepalive — carries no event and is not
   * one, so it is exactly what this reader drops: it is bytes that defeat an idle bound, not a fact about a
   * conversation.
   */
  private deliver(frame: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const value = JSON.parse(data.join("\n")) as Record<string, unknown>;
    if (event === "snapshot" || event === "state") {
      if (!this.handshaken) { this.handshaken = true; this.emit({ type: "connected", sessionId: this.sessionId }); }
      this.emit({ type: "frame", sessionId: this.sessionId, event, data: value as ServerFrame });
      return;
    }
    if (event === "submission") { this.emit({ type: "submission", sessionId: this.sessionId, submission: value as SubmissionProjection }); return; }
    if (event === "resync_required") { this.emit({ type: "resync", sessionId: this.sessionId }); return; }
    if (event === "state_oversize") {
      this.emit({
        type: "oversize", sessionId: this.sessionId,
        reason: typeof value.reason === "string" ? value.reason : "frame_too_large",
        entryId: typeof value.entryId === "string" ? value.entryId : null,
        bytes: typeof value.bytes === "number" ? value.bytes : null,
        revision: typeof value.revision === "number" ? value.revision : null,
      });
    }
  }
  private emit(event: ConversationStreamEvent): void { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) })); }
}

/**
 * The Web page's source: a same-origin address under the ingress, with nothing attached to the request.
 *
 * Authentication is the ingress's own cookie check, so no header is stated here and none may be: the browser sends the
 * httpOnly cookie by itself, and a Web page must not be handed the backend's token to set one with.
 *
 * The path is the Backend's own conversation vocabulary, because that is the route the client ingress forwards: a
 * same-origin `/api/conversations/:id/events` reaches the conversation's stream on either host, and the retired Next
 * BFF's `/api/agent/:id/events` does not exist behind this origin at all.
 */
export function conversationSource(basePath = "/api/conversations"): ConversationSourceFactory {
  return (conversationId) => new StreamSource(conversationId, basePath + "/" + encodeURIComponent(conversationId) + "/events", {});
}

/** The diagnostic page's source: one conversation's authenticated event stream on `origin`. */
export function bearerSource(origin: string, token: string): ConversationSourceFactory {
  return (conversationId) => new StreamSource(conversationId, origin + "/api/conversations/" + encodeURIComponent(conversationId) + "/events", { authorization: "Bearer " + token });
}

/**
 * The diagnostic page's session: the durable conversation, read over the shared browser transport.
 *
 * The connection is the same one the Web page drives, so the diagnostic fallback keeps no second connection lifecycle.
 * What belongs to this class is the bearer assembly and the one reader's fold of the frames that arrive.
 */
export class BrowserDurableSession {
  readonly session: DurableSession;
  readonly connection: AgentEventConnection;
  readonly origin: string;
  readonly token: string;
  readonly conversationId: string;
  readonly subscription: AgentEventSubscription;
  active = false;
  constructor(origin: string, token: string, conversationId: string, onState: (state: SessionState) => void, onError: (error: unknown) => void) {
    this.origin = origin; this.token = token; this.conversationId = conversationId;
    this.session = new DurableSession(origin, token, conversationId);
    this.connection = new AgentEventConnection({
      createSource: bearerSource(origin, token),
      readinessTimeoutMs: 10000, reconnectDelayMs: 1000,
      onUnexpectedError: onError,
    });
    this.subscription = this.connection.subscribe(conversationId, (event) => {
      if (!this.active) return;
      // The stream's own frames are the two the backend names for a window; the diagnostic page folds them with the
      // shared reducer, exactly as the Web page does. A resync marker is the backend saying this reader's revision is
      // not the one it holds, so a fresh bounded read is taken — the same answer a gap gets.
      if (event.type === "frame") {
        const state = this.session.apply(String(event.event), event.data as ServerFrame);
        onState(state);
        return;
      }
      if (event.type === "resync") void this.session.stateSnapshot().then(onState).catch(onError);
    });
  }
  async connect(): Promise<void> { this.active = true; await this.subscription.ready(); }
  close(): void { this.active = false; this.connection.close(); }
  submit(requestId: string, text: string) { return this.session.submit(requestId, text); }
  async abort(): Promise<void> {
    const response = await fetch(this.origin + "/api/conversations/" + encodeURIComponent(this.conversationId) + "/abort", { method: "POST", headers: { authorization: "Bearer " + this.token } });
    if (!response.ok) throw new Error("Abort failed: " + response.status);
  }
}
