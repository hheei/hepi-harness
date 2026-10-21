"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useI18n } from "../hooks/useI18n";
import { subscribeFontPreferences } from "../hooks/useFontPreferences";
import { readFontWeight } from "../lib/font-preferences";
import { createTerminalWriter, terminalPath, terminalRequest, type TerminalConnection } from "../lib/terminal-client";
import type { FanInSubscription } from "../lib/terminal-fan-in";
import type { TerminalTab } from "./terminal-tab-state";

interface Props {
  tab: TerminalTab;
  /** The folder behind the routing cwd, shown wherever a path is read by a person. */
  displayCwd?: string | null;
  active: boolean;
  /**
   * This tab's place on the page's one terminal stream. A tab is attached for exactly as long as it is mounted, which
   * is what keeps its shell running, and its frames arrive here instead of on a connection of its own.
   *
   * `null` is the page holding no stream for the connection it is showing yet — the stream belongs to a connection and
   * is created by the effect that shows it, so a panel can be rendered before there is one. There is then nothing to
   * attach, and this panel builds nothing until it is handed the stream: the next render states it and the effect below
   * runs once, with the widget, the host's own answer for the tab and the attachment made in that one pass.
   */
  stream: ((tab: { id: string; cwd: string; after?: number }, handlers: { onFrame: (frame: { type: string; data?: string; offset?: number; reset?: boolean; exitCode?: number | null }) => void; onOpen: () => void; onError: (failure: { fatal: boolean }) => void }) => FanInSubscription) | null;
  /**
   * How this panel reaches the Gateway: the connection scope's own origin and credential. The panel presents exactly
   * that identity on every request it makes, so a Web page's cookie and an App's device bearer reach the same routes
   * without a surface deciding one.
   */
  connection?: TerminalConnection;
  onRestart: () => void;
  onClosed: () => void;
  /** The host's own answer for the folder the shell runs in, so the tab can name its own workspace. */
  onCwdKnown?: (cwd: string) => void;
}

export function TerminalPanel({ tab, displayCwd, active, stream, connection, onRestart, onClosed, onCwdKnown }: Props) {
  const { t } = useI18n();
  const { id, cwd, restored } = tab;
  // The tab names its own workspace: the folder the host reported for it, or the one it was opened in.
  const shownCwd = tab.displayCwd ?? displayCwd ?? cwd;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const startRef = useRef<Promise<void>>(Promise.resolve());
  const writerRef = useRef<ReturnType<typeof createTerminalWriter> | null>(null);
  const callbacksRef = useRef({ onClosed, onCwdKnown });
  callbacksRef.current = { onClosed, onCwdKnown };
  const closedRef = useRef(false);
  const [status, setStatus] = useState<"connecting" | "ready" | "exited" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // No stream for this connection yet: this pass has nothing to attach, and building the widget here would only build
    // it again when the stream arrives, because the stream is one of this effect's dependencies.
    if (stream === null) return;
    let disposed = false;
    let attached: FanInSubscription | null = null;
    let offset: number | undefined;
    let connected = false;
    let exited = false;
    let inputFailed = false;
    setStatus("connecting");
    setError(null);
    setExitCode(null);

    const readTerminalFont = () => {
      const style = getComputedStyle(container);
      return {
        fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
        // Base weights stop at 600, so xterm's default bold (700) stays heavier.
        fontWeight: readFontWeight(style.getPropertyValue("--font-mono-weight")),
      };
    };
    const terminal = new Terminal({
      cursorBlink: true,
      ...readTerminalFont(),
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 8000,
      screenReaderMode: true,
      disableStdin: true,
      theme: {
        background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
        selectionBackground: "#365b8a",
        black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
        blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
        brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
        brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9", brightWhite: "#ffffff",
      },
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") return false;
      if ((event.ctrlKey || event.metaKey) && key === "c" && terminal.hasSelection()) return false;
      return true;
    });

    const writer = createTerminalWriter(id, cwd, (reason) => {
      if (disposed) return;
      inputFailed = true;
      terminal.options.disableStdin = true;
      setError(reason.message);
      setStatus("error");
    }, connection);
    writerRef.current = writer;
    const onData = terminal.onData((data) => {
      if (connected && !exited && !inputFailed) writer.write(data);
    });
    const fitAndResize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      fit.fit();
    };
    const onResize = terminal.onResize(({ cols, rows }) => {
      if (connected && !exited && !inputFailed) writer.resize(cols, rows);
    });
    const resizeObserver = new ResizeObserver(fitAndResize);
    resizeObserver.observe(container);
    const updateFont = () => {
      if (disposed) return;
      const font = readTerminalFont();
      terminal.options.fontFamily = font.fontFamily;
      terminal.options.fontWeight = font.fontWeight;
      fitAndResize();
    };
    const unsubscribeFonts = subscribeFontPreferences(updateFont);

    /**
     * Take this tab's place on the page's one terminal stream. The panel owns its widget and its writer; the connection
     * is the fan-in's, shared with every other mounted tab, so a page with four tabs holds one stream instead of four.
     *
     * The cursor is this widget's: it is stated on the way in and the fan-in keeps it for the reconnects that happen
     * underneath, which is what makes a dropped stream a continuation rather than a reattach to the retained tail.
     */
    const connect = () => {
      if (disposed || exited || !navigator.onLine) return;
      attached?.release();
      // The cursor named here is this widget's own read position. It is what makes a reconnect continue instead of
      // clearing the screen, and what makes a *new* widget on the same tab refill itself from the retained tail: this
      // variable is created with the terminal, so a re-render that replaces the widget has read nothing.
      attached = stream({ id, cwd, ...(offset === undefined ? {} : { after: offset }) }, {
        onFrame: (event) => {
          if (disposed) return;
          if (event.type === "output") {
            if (event.reset) terminal.reset();
            else if (offset !== undefined && (event.offset ?? 0) <= offset) return;
            terminal.write(event.data ?? "");
            offset = event.offset;
          } else {
            exited = true;
            connected = false;
            terminal.options.disableStdin = true;
            attached?.release();
            attached = null;
            setExitCode(event.exitCode ?? null);
            setStatus("exited");
          }
        },
        onOpen: () => {
          if (disposed) return;
          connected = true;
          if (inputFailed) return;
          terminal.options.disableStdin = false;
          setStatus("ready");
          fitAndResize();
          writer.resize(terminal.cols, terminal.rows);
          if (container.offsetWidth && container.offsetHeight) terminal.focus();
        },
        onError: (failure) => {
          if (disposed || exited) return;
          connected = false;
          terminal.options.disableStdin = true;
          // The fan-in reopens the stream within the host's reconnect window, so a dropped connection is a reconnecting
          // panel rather than a failed one. A stream the host refused is the host saying the session is gone, which is
          // what the panel's explicit reconnect exists for.
          setStatus(failure.fatal ? "error" : "connecting");
        },
      });
    };

    startRef.current = (async () => {
      fitAndResize();
      const describe = (await terminalRequest(terminalPath(restored || reconnectKey > 0 ? id : null, cwd), restored || reconnectKey > 0
        ? undefined
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, cwd, cols: terminal.cols, rows: terminal.rows }) }, connection)) as { cwd?: string; exited?: boolean; ok?: boolean; code?: string };
      if (describe.cwd) callbacksRef.current.onCwdKnown?.(describe.cwd);
      // A restored tab must never silently launch a replacement shell: a session the host no longer runs is reported
      // as such, and the panel offers the explicit reconnect instead.
      if (restored || reconnectKey > 0) {
        if (describe.ok === false || describe.exited === true) throw new Error(t(describe.code === "unknown_terminal" ? "terminal.sessionEnded" : "terminal.sessionUnknown"));
      }
      connect();
    })().catch((reason: Error) => {
      if (disposed) return;
      setError(reason.message);
      setStatus("error");
    });

    const pageHide = () => {
      connected = false;
      terminal.options.disableStdin = true;
      attached?.release();
      attached = null;
      if (!exited && !inputFailed) setStatus("connecting");
    };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) connect(); };
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("pageshow", pageShow);
    window.addEventListener("offline", pageHide);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      // Leaving the stream is what releases this tab's attachment: the host's reconnect lease then runs for a session
      // nobody is attached to, exactly as it did when the panel owned its own connection.
      attached?.release();
      void writer.stop();
      resizeObserver.disconnect();
      unsubscribeFonts();
      onData.dispose();
      onResize.dispose();
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("pageshow", pageShow);
      window.removeEventListener("offline", pageHide);
      window.removeEventListener("online", connect);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id, cwd, restored, reconnectKey, stream, connection, t]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!tab.closing || closedRef.current) return;
    // Closing is a local action: a creation or cleanup that is still pending, rejected, absent or offline must never
    // keep the tab on screen, so the UI and the saved layout drop it before any request settles.
    closedRef.current = true;
    if (terminalRef.current) terminalRef.current.options.disableStdin = true;
    const start = startRef.current;
    const writer = writerRef.current;
    callbacksRef.current.onClosed();
    void (async () => {
      // Cleanup stays best effort and waits for a pending creation to settle instead of racing it. The refs are
      // captured above because this panel is already unmounting.
      await start;
      await writer?.stop();
      await terminalRequest(terminalPath(id, cwd), { method: "DELETE", keepalive: true }, connection).catch(() => {});
    })();
  }, [id, cwd, tab.closing, connection]);

  return (
    <section className="terminal-panel" aria-label={t("terminal.title")}>
      <header className="terminal-panel-header">
        <div className="terminal-panel-path">
          <span className={`terminal-status-dot is-${status}`} title={t(`terminal.${status}`)} />
          <span title={shownCwd}>{shownCwd}</span>
        </div>
        {status === "error" && (
          <button type="button" onClick={() => setReconnectKey((key) => key + 1)} disabled={Boolean(tab.closing)} title={t("terminal.reconnect")} aria-label={t("terminal.reconnect")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
            </svg>
          </button>
        )}
        <button type="button" onClick={onRestart} disabled={Boolean(tab.closing)} title={t("terminal.restart")} aria-label={t("terminal.restart")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
      </header>
      <div>
        {error && <div className="terminal-panel-error" role="alert">{error}</div>}
        {status === "exited" && <div className="terminal-panel-exit" role="status">{exitCode === null ? t("terminal.exited") : t("terminal.exitCode", { code: exitCode })}</div>}
      </div>
      <div className="terminal-xterm"><div ref={containerRef} className="terminal-xterm-host" /></div>
    </section>
  );
}
