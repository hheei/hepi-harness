import { emptyStreamState, reduceSseFrame, type SessionState } from "./index.ts";

/**
 * One frame as a conversation's stream delivers it: the event name plus that event's own fields.
 *
 * Declared here rather than imported from the Web wire projection, because this module is the transport the Web page
 * and the diagnostic page share: it is a browser-only module of `@hepi/session`, and `packages/*` never depends on
 * `apps/*`. The Web projection's own `AgentEventLike` is this same shape, so the two are one type structurally.
 */
export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

/** The native frame names a conversation's stream carries its window under. Anything else is a fact beside the window. */
const WINDOW_EVENTS = new Set(["snapshot", "state"]);

export interface AgentEventSourceLike {
  readonly readyState: number;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type AgentEventConnectionStatus = "ready_timeout" | "startup_error" | "closed";

export class AgentEventConnectionError extends Error {
  readonly status: AgentEventConnectionStatus;
  constructor(status: AgentEventConnectionStatus, message?: string) {
    super(message ?? (
      status === "ready_timeout"
        ? "Timed out starting the agent session. Please try again."
        : "Failed to connect to the agent event stream. Please try again."
    ));
    this.status = status;
    this.name = "AgentEventConnectionError";
  }
}

type Attempt = {
  promise: Promise<void>;
  ready: boolean;
  succeed(): void;
  fail(error: AgentEventConnectionError): void;
};

type Listener = (event: AgentEventLike) => void;

type Connection = {
  readonly sessionId: string;
  source: AgentEventSourceLike | null;
  attempt: Attempt | null;
  readonly listeners: Set<Listener>;
  retry: ReturnType<typeof setTimeout> | null;
  /**
   * Where this conversation's stream is now, as the frames it delivered assembled it.
   *
   * It belongs to the **source**, not to any reader: a conversation has one stream however many readers join it, so the
   * reader that joins last is handed the continuity the reader that joined first has been folding all along, instead of
   * an empty state no frame can continue. It is wire continuity and never an accepted fact — no projection, prefix or
   * lifecycle decision is made from it — and a frame this state cannot be folded by leaves it unstated rather than
   * presenting a window that is not the stream's.
   */
  held: SessionState | null;
};

export interface AgentEventConnectionOptions {
  createSource(sessionId: string): AgentEventSourceLike;
  readinessTimeoutMs: number;
  reconnectDelayMs: number;
  onUnexpectedError?(error: unknown): void;
}

const EVENT_SOURCE_OPEN = 1;

/**
 * One subscriber's place on a conversation's stream: what it waits on and how it leaves.
 */
export interface AgentEventSubscription<TMessage = unknown> {
  /** Wait for the handshake, opening the stream if nobody has it open. Rejects with the reason it failed. */
  ready(): Promise<void>;
  /** Drop the source and open a fresh one, keeping this subscription: a restarted backend is a new attachment. */
  reconnect(): void;
  /** Leave the stream. The source closes when its last subscriber leaves. */
  release(): void;
  /**
   * The stream's continuity at the moment this reader joined, or `null` when there was none to hand over — the
   * first reader of an attachment, or a stream whose frames could not be continued. A reader that starts from it
   * continues the stream it joined; a reader that starts from an empty state of its own would refuse the first delta it
   * received as a revision it does not hold. It is a transfer, taken once: what the stream receives afterwards is the
   * reader's own to fold.
   */
  continuity(): SessionState<TMessage> | null;
}

/**
 * Owns the EventSource, the agent-readiness handshake and the passive reconnect for every conversation the page
 * watches. A conversation has at most **one** source however many subscribers it has, because the conversation that is
 * on screen and a background interest in the same conversation are two readers of one stream, not two streams: the
 * first subscriber opens it and the last one to leave closes it.
 *
 * A subscription survives a reconnect, a failed handshake and a dropped stream, so the reader that joined is the
 * reader that keeps being told; what ends a subscription is the subscriber leaving, never a transport hiccup.
 */
export class AgentEventConnection {
  private readonly connections = new Map<string, Connection>();
  private readonly options: AgentEventConnectionOptions;

  constructor(options: AgentEventConnectionOptions) { this.options = options; }

  /** Join a conversation's stream, opening it when nobody is watching that conversation yet. */
  subscribe<TMessage = unknown>(sessionId: string, listener: Listener): AgentEventSubscription<TMessage> {
    const connection = this.connection(sessionId);
    connection.listeners.add(listener);
    this.openIfNeeded(connection);
    // Taken before the caller can fold anything, so it is the stream's state at the join and not one a frame the caller
    // has already received has moved on. The payload is the wire's and the reader's to name: this transport states where
    // the stream is, not what a consumer's messages are.
    const joined = connection.held as SessionState<TMessage> | null;
    let released = false;
    return {
      ready: () => this.ready(connection),
      continuity: () => (released ? null : joined),
      reconnect: () => {
        if (released) return;
        this.discard(connection, new AgentEventConnectionError("closed"));
        this.openIfNeeded(connection);
      },
      release: () => {
        if (released) return;
        released = true;
        connection.listeners.delete(listener);
        if (connection.listeners.size === 0) this.discard(connection, new AgentEventConnectionError("closed"));
      },
    };
  }

  /** Leave every conversation: the page is going away. */
  close(): void {
    for (const connection of [...this.connections.values()]) {
      connection.listeners.clear();
      this.discard(connection, new AgentEventConnectionError("closed"));
    }
  }

  private async ready(connection: Connection): Promise<void> {
    while (true) {
      this.openIfNeeded(connection);
      const attempt = connection.attempt;
      // No source and no handshake under way: the caller left, or the stream could not even be created.
      if (attempt === null) throw new AgentEventConnectionError("closed");
      if (attempt.ready && connection.source?.readyState === EVENT_SOURCE_OPEN) return;
      await attempt.promise;
      if (connection.source?.readyState === EVENT_SOURCE_OPEN) return;
      // A source that once became ready may otherwise remain CONNECTING indefinitely.
      this.discard(connection, new AgentEventConnectionError("closed"));
    }
  }

  private connection(sessionId: string): Connection {
    const existing = this.connections.get(sessionId);
    if (existing !== undefined) return existing;
    const created: Connection = { sessionId, source: null, attempt: null, listeners: new Set(), retry: null, held: null };
    this.connections.set(sessionId, created);
    return created;
  }

  private openIfNeeded(connection: Connection): void {
    if (connection.source !== null || connection.listeners.size === 0) return;
    this.clearRetry(connection);

    let source: AgentEventSourceLike;
    try {
      source = this.options.createSource(connection.sessionId);
    } catch (error) {
      const failure = new AgentEventConnectionError("closed", error instanceof Error ? error.message : String(error));
      this.options.onUnexpectedError?.(failure);
      this.scheduleRetry(connection);
      return;
    }

    let settled = false;
    let resolve!: () => void;
    let reject!: (error: AgentEventConnectionError) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A subscriber that never waits for the handshake — a background watch joins a stream it does not read a readiness
    // answer from — must not turn a closed source into an unhandled rejection. Attaching this marks the rejection
    // handled for the runtime while leaving the promise itself rejecting for whoever does await it.
    promise.catch(() => {});
    const timeout = setTimeout(() => {
      this.fail(connection, new AgentEventConnectionError("ready_timeout"));
    }, this.options.readinessTimeoutMs);
    const attempt: Attempt = {
      promise,
      ready: false,
      succeed() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      },
      fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    };
    connection.source = source;
    connection.attempt = attempt;

    source.onmessage = (message) => {
      // A source this conversation has already replaced delivers nothing: its frames belong to the attachment that
      // was closed, and the reader that stayed is waiting for the new one's.
      if (connection.source !== source) return;
      let event: AgentEventLike;
      try {
        event = JSON.parse(message.data) as AgentEventLike;
      } catch {
        return;
      }

      // The stream's own continuity, kept for the reader that joins next. It is folded here rather than by a reader so
      // that a conversation has one answer to "where is this stream" rather than one per reader, and it is never
      // published: what a frame means to a surface stays the fold's decision, made above this transport.
      if (event.type === "frame") {
        const frame = event as unknown as { event?: unknown; data?: unknown };
        const name = String(frame.event);
        if (WINDOW_EVENTS.has(name)) {
          const folded = reduceSseFrame(connection.held ?? emptyStreamState(connection.sessionId), name, frame.data);
          // A frame this state could not be folded by is a stream a joiner cannot be handed: it is unstated, and the
          // reader that joins next is answered the way a revision gap is rather than with a window that is not the
          // stream's.
          connection.held = folded.resyncRequired === true ? null : folded;
        }
      }
      if (event.type === "connected") {
        attempt.ready = true;
        attempt.succeed();
        this.clearRetry(connection);
      } else if (event.type === "startup_error") {
        const reason = typeof event.errorMessage === "string" ? event.errorMessage : undefined;
        this.fail(connection, new AgentEventConnectionError("startup_error", reason));
        return;
      }
      for (const listener of [...connection.listeners]) listener(event);
    };
    source.onerror = () => {
      this.fail(connection, new AgentEventConnectionError("closed"));
    };
  }

  private fail(connection: Connection, error: AgentEventConnectionError): void {
    this.discard(connection, error);
    // A startup error is the conversation refusing to run at all: retrying it would repeat a refusal that is not
    // transient. Anything else may be a hiccup, and a subscriber is still waiting, so the stream is opened again.
    if (error.status !== "startup_error") this.scheduleRetry(connection);
  }

  private discard(connection: Connection, error: AgentEventConnectionError): void {
    this.clearRetry(connection);
    connection.attempt?.fail(error);
    connection.source?.close();
    connection.attempt = null;
    connection.source = null;
    // The attachment that stated this continuity is gone. Its replacement opens with a baseline of its own, and until
    // that baseline arrives there is no stream to hand a joiner.
    connection.held = null;
    if (connection.listeners.size === 0) this.connections.delete(connection.sessionId);
  }

  private scheduleRetry(connection: Connection): void {
    if (connection.listeners.size === 0 || connection.retry !== null) return;
    const timer = setTimeout(() => {
      if (connection.retry !== timer) return;
      connection.retry = null;
      this.openIfNeeded(connection);
    }, this.options.reconnectDelayMs);
    connection.retry = timer;
  }

  private clearRetry(connection: Connection): void {
    if (connection.retry !== null) clearTimeout(connection.retry);
    connection.retry = null;
  }
}
