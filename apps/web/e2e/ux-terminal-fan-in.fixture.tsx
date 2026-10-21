/**
 * Browser fixture for the terminal fan-in: the production `TerminalPanel`, the production `TerminalFanIn` and the
 * production terminal client, mounted over the page's one stream.
 *
 * It is deliberately not a copy of the shell. The panel under test is the real one, and the only thing this file states is
 * the connection a page would have — the Web page's own cookie, or an App's device bearer — and how many tabs are
 * mounted. What the driver then observes is the browser's own network: the requests the panel and the stream really made,
 * their headers, their credentials, and whether the stream outlived its last tab.
 *
 * The tree is mounted in `StrictMode`, as both hosts mount theirs. A production React build does not replay effects, so
 * the same fixture also serves the development build, where the replay really happens — and `effectRuns()` is how the
 * driver knows which of the two it is looking at.
 *
 * `?credential=bearer&token=…` mounts the App's branch; anything else mounts the Web page's.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPanel } from "@hepi/ui/components/TerminalPanel";
import type { TerminalTab } from "@hepi/ui/components/terminal-tab-state";
import { useTerminalFanIn } from "@hepi/ui/hooks/useTerminalFanIn";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import type { TerminalConnection } from "@hepi/ui/lib/terminal-client";
// The panel's own layout, so a mounted tab is a real terminal of a real size rather than an unlaid-out div.
import "./ux-terminal-fan-in.fixture.css";

const parameters = new URLSearchParams(window.location.search);
const connection: TerminalConnection = parameters.get("credential") === "bearer"
  ? { credential: { kind: "bearer", token: parameters.get("token") ?? "" } }
  : { credential: { kind: "cookie" } };
const cwd = parameters.get("cwd") ?? "/workspace/fixture";
const initial: TerminalTab[] = (parameters.get("tabs") ?? "tab-a,tab-b").split(",").filter(Boolean).map(id => ({ id, cwd }));

/** How many times this mount's own effect body ran: one in a production build, two under a development `StrictMode`. */
const probe = { effectRuns: 0 };

declare global {
  interface Window { __terminalFixture?: { close(): void; mounted(): number; effectRuns(): number } }
}

function Fixture() {
  const [tabs, setTabs] = useState<TerminalTab[]>(initial);
  const stream = useTerminalFanIn(connection);
  window.__terminalFixture = {
    close() { setTabs([]); },
    mounted() { return tabs.length; },
    effectRuns() { return probe.effectRuns; },
  };
  useEffect(() => { probe.effectRuns += 1; }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {tabs.map(tab => (
        <div key={tab.id} data-tab={tab.id} style={{ height: 220 }}>
          <TerminalPanel
            tab={tab}
            active={false}
            stream={stream === null ? null : (named, handlers) => stream.subscribe(named, handlers)}
            connection={connection}
            onRestart={() => {}}
            onClosed={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("the fixture root element is missing");
createRoot(root).render(<StrictMode><I18nProvider><Fixture /></I18nProvider></StrictMode>);
