import { useEffect, useState } from "react";
import { TerminalFanIn } from "../lib/terminal-fan-in";
import type { TerminalConnection } from "../lib/terminal-client";

/**
 * The page's one terminal stream, owned by the effect that is showing this connection.
 *
 * A stream is a fact about a connection, not about a mount: it carries the connection's origin and credential, its tabs'
 * cursors and their attachments on the host. So it is created for one connection value and closed when that value is
 * replaced — a page that switched Gateway releases its tabs' attachments rather than carrying a stream, and a cursor,
 * into a scope where they mean something else.
 *
 * It is created by the effect and held in state rather than memoized, because closing it is exactly what the effect's
 * cleanup does. A memoized instance survives that cleanup and is handed back on the replay, already closed, so every
 * attachment the page makes afterwards is refused for the rest of its life — and both hosts run their roots in
 * `StrictMode`, which double-invokes effects in development. Creating the stream under the effect lifecycle means a
 * replay gets a live one and a real unmount still releases the one that was shown.
 *
 * The value is returned only for the connection it was created for, so the frame between a switch and the new stream
 * never hands a caller the previous connection's tabs. Until the effect has run there is no stream at all: a caller with
 * none has nothing to attach, and `null` says that rather than an instance whose attachments would be refused. A caller
 * that must offer a subscription anyway holds `detachedSubscription`.
 */
export function useTerminalFanIn(connection: TerminalConnection): TerminalFanIn | null {
  const [stream, setStream] = useState<{ readonly connection: TerminalConnection; readonly fanIn: TerminalFanIn } | null>(null);
  useEffect(() => {
    const fanIn = new TerminalFanIn(connection);
    setStream({ connection, fanIn });
    return () => {
      fanIn.close();
      setStream((current) => (current !== null && current.fanIn === fanIn ? null : current));
    };
  }, [connection]);
  return stream !== null && stream.connection === connection ? stream.fanIn : null;
}
