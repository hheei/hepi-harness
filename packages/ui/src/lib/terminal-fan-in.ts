/**
 * The page's one terminal stream.
 *
 * A browser allows six connections per origin over HTTP/1.1, and the page spends them on the conversation on screen,
 * the background watches and the terminals it has open. One stream per mounted terminal tab is what makes a page with a
 * few tabs unusable: the tab of a closed panel still spends a connection, because a mounted tab's shell has to stay
 * attached. This holds **one** stream for every mounted tab instead, and it is a peer of the chat transport
 * (\`@hepi/session/browser\`, whose connection serves one source per conversation) for
 * terminals: the same division the chat path already has, where the surface keeps its widget and its writer and stops
 * owning transport.
 *
 * What it owns is the attachment, not the shell. A tab that is attached has a live caller, so the host's reconnect
 * lease does not run for it and its shell keeps running; a tab that is detached releases its attachment and the lease
 * then does exactly what it did when a panel closed its own stream. Mounted is attached.
 *
 * **Read with \`fetch\`, not with \`EventSource\`.** \`EventSource\` states no credential of its own, so it can only ever be
 * the Web page's cookie path; an App holds a device bearer and presents it explicitly. One reader for both means the
 * cookie branch states nothing (the browser attaches its own HttpOnly cookie) and the bearer branch sets one header —
 * and neither branch can put a credential in a URL. The reader also owns the request's lifetime, so a dropped stream is
 * aborted and reopened by this module rather than left to the browser's own retry.
 *
 * Cursors are per tab, which is what makes a reconnect a continuation rather than a restart: every output frame reports
 * its session's own offset, the offset is kept here, and a reconnect names it in the query. The stream is therefore
 * reopened by this module rather than by the browser, which would repeat the first URL — and with it the cursors of the
 * first attach — and be answered with the retained tail and a reset.
 *
 * A cursor is the *widget's* read position, so the widget states it: a subscriber names the offset its own terminal has
 * read, and this keeps the latest offset each attached tab reported for the reconnects that happen underneath it. That is
 * what makes the two ways a stream starts again different, and both are right:
 *
 * - The stream dropped and the widget is still there (nothing re-rendered): the attachment continues from the cursor it
 *   was seeded with, so the screen a user is reading is not cleared and not replayed at them.
 * - A new widget joins the tab (a panel's effect re-ran, which a re-render does, and its terminal is new): a new widget
 *   has read nothing and names no cursor, so the host is asked for the retained tail and the terminal refills itself.
 *   Continuing from the old widget's cursor instead would leave it empty until the shell next wrote.
 */

import type { TerminalConnection } from "./terminal-client";

/** One terminal event as the fan-in stream states it: the session facts, with the session named. */
export type FanInFrame =
  | { type: "output"; id: string; data: string; offset: number; reset?: boolean }
  | { type: "exit"; id: string; exitCode: number | null; signal: number };

/**
 * One tab the stream is attached to: its session, the routing cwd its workspace is resolved from, and how much of it the
 * subscribing widget has already read. A widget that names no offset has read nothing and is given the retained tail.
 */
export type FanInTab = { readonly id: string; readonly cwd: string; readonly after?: number };

/** What one tab's reader is told: its own frames, and whether the shared stream is up. */
export interface FanInHandlers {
  readonly onFrame: (frame: FanInFrame) => void;
  /** The stream opened: this tab is attached on the host. */
  readonly onOpen?: () => void;
  /**
   * The stream dropped, or could not be established at all. A stream that is merely down is being reopened and this tab
   * keeps its place and its cursor; one the host refused is not retried, because repeating a refusal is not a repair.
   */
  readonly onError?: (failure: { readonly fatal: boolean }) => void;
}

/** One tab's place on the stream. The tab is attached while this exists and detached when it is released. */
export interface FanInSubscription {
  release(): void;
  /** Open the stream again from the cursors held, keeping this tab attached. */
  reconnect(): void;
}

export interface TerminalFanInOptions extends TerminalConnection {
  /** How long to wait before reopening a stream that dropped. */
  readonly reconnectDelayMs?: number;
}

const RECONNECT_DELAY_MS = 1000;

/**
 * The browser path of the fan-in stream: the tabs it attaches to and the cursor held for each.
 *
 * A tab is named with its routing cwd because a tab is addressed by the workspace that cwd resolves to, and two tabs of
 * one page may belong to two projects. Each field is percent-encoded, so a delimiter can never appear inside one.
 */
export function terminalFanInPath(tabs: readonly (FanInTab & { after?: number })[]): string {
  const named = tabs.map((tab) => [tab.id, tab.cwd, tab.after === undefined ? "" : String(tab.after)].map(encodeURIComponent).join("|")).join(",");
  return "/api/terminal/events?tabs=" + named;
}

/** One attached tab: what the host resolves it against, and who is reading it. */
type Attached = { tab: FanInTab; handlers: FanInHandlers };

/** The request one stream opened: its abort handle. */
type Open = { readonly controller: AbortController };

export class TerminalFanIn {
  private readonly attached = new Map<string, Attached>();
  private readonly cursors = new Map<string, number>();
  private open: Open | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: TerminalFanInOptions = {}) {}

  /**
   * Join the stream for one mounted tab. A tab already attached keeps the attachment it has — a second reader of one
   * tab is a second reader, not a second connection — and a tab that arrives while the stream is open reopens it,
   * because the stream names its tabs and one that is already running cannot be given another.
   */
  subscribe(tab: FanInTab, handlers: FanInHandlers): FanInSubscription {
    if (this.closed) return { release: () => {}, reconnect: () => {} };
    const existing = this.attached.get(tab.id);
    if (existing !== undefined && existing.tab.cwd === tab.cwd) {
      this.attached.set(tab.id, { tab, handlers });
      return this.subscription(tab.id);
    }
    // The cursor this attachment continues from is the one its own widget stated. A widget that names none has read
    // nothing — a new terminal on a tab that was open before — and asking for the retained tail is what refills it.
    if (tab.after === undefined) this.cursors.delete(tab.id);
    else this.cursors.set(tab.id, tab.after);
    this.attached.set(tab.id, { tab, handlers });
    this.reopen();
    return this.subscription(tab.id);
  }

  /** Open the stream again from the cursors it holds. Nothing is lost: the tabs stay attached and their offsets stay. */
  reopen(): void {
    if (this.closed) return;
    this.closeStream();
    if (this.attached.size === 0) return;
    const tabs = [...this.attached.values()].map(({ tab }) => {
      const after = this.cursors.get(tab.id);
      return after === undefined ? tab : { ...tab, after };
    });
    const open: Open = { controller: new AbortController() };
    this.open = open;
    void this.read(open, terminalFanInPath(tabs));
  }

  close(): void {
    this.closed = true;
    this.closeStream();
    this.attached.clear();
    this.cursors.clear();
  }

  /**
   * One stream's bytes, framed as the host wrote them.
   *
   * A frame is written whole once its terminating blank line arrives, so a chunk boundary in the middle of a frame is
   * not a frame boundary; a comment frame — the origin's keepalive — carries no data and is dropped, which is exactly
   * what it is for. The request is aborted when this connection is released, and a request that is aborted is not a
   * failure: it is the reader leaving, and nothing is told about it.
   */
  private async read(open: Open, path: string): Promise<void> {
    const send = this.options.fetch ?? globalThis.fetch;
    const credential = this.options.credential ?? { kind: "cookie" };
    const origin = (this.options.origin ?? "").replace(/\/+$/, "");
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (credential.kind === "bearer") headers.authorization = "Bearer " + credential.token;
    let response: Response;
    try {
      response = await send(origin + path, {
        headers,
        // The Web page's HttpOnly cookie is attached by the browser itself; an App has no cookie jar to present.
        credentials: credential.kind === "cookie" ? "same-origin" : "omit",
        signal: open.controller.signal,
      });
    } catch {
      this.failed(open, { fatal: false });
      return;
    }
    // A stream this module already replaced answers nothing: its request was aborted, and its bytes belong to the
    // attachment that is over.
    if (this.open !== open) { await response.body?.cancel().catch(() => {}); return; }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {});
      // A status is the host saying this stream is not going to work. Retrying it every second would be a request storm
      // against a refusal that will not change.
      this.failed(open, { fatal: true });
      return;
    }
    for (const { handlers } of [...this.attached.values()]) handlers.onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      while (!open.controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          this.deliver(open, frame);
        }
      }
    } catch {
      // The request was torn down: the answer is the reconnect below, not a second failure path.
    } finally {
      await reader.cancel().catch(() => {});
    }
    this.failed(open, { fatal: false });
  }

  /** One complete frame, delivered to the tab it names. A frame for a detached tab belongs to an attachment that is over. */
  private deliver(open: Open, frame: string): void {
    if (this.open !== open) return;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    let event: FanInFrame;
    try {
      event = JSON.parse(data.join("\n")) as FanInFrame;
    } catch {
      return;
    }
    if (typeof event?.id !== "string") return;
    const attached = this.attached.get(event.id);
    if (attached === undefined) return;
    if (event.type === "output") this.cursors.set(event.id, event.offset);
    attached.handlers.onFrame(event);
  }

  /**
   * The stream this request opened is over. The tabs are told, the request is released, and a stream that may still work
   * is scheduled to be reopened with the cursors held — which is what makes a reconnect a continuation.
   */
  private failed(open: Open, failure: { readonly fatal: boolean }): void {
    if (this.open !== open) return;
    for (const { handlers } of [...this.attached.values()]) handlers.onError?.(failure);
    this.closeStream();
    if (!failure.fatal) this.scheduleRetry();
  }

  private subscription(tabId: string): FanInSubscription {
    let released = false;
    return {
      reconnect: () => { if (!released) this.reopen(); },
      release: () => {
        if (released) return;
        released = true;
        if (!this.attached.delete(tabId)) return;
        // The last tab to leave closes the stream, and the host's own reconnect lease then runs for a session nobody is
        // attached to, exactly as it did when a panel closed its own stream.
        this.reopen();
      },
    };
  }

  private closeStream(): void {
    this.clearRetry();
    this.open?.controller.abort();
    this.open = null;
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== null) return;
    const timer = setTimeout(() => {
      if (this.retry !== timer) return;
      this.retry = null;
      this.reopen();
    }, this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS);
    this.retry = timer;
  }

  private clearRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }
}
