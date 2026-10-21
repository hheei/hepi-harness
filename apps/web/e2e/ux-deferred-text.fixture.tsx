/**
 * Browser fixture for the deferred-text slice: the production MessageView, mounted on the messages a real backend
 * projected, inside the production connection scope.
 *
 * It is deliberately not a copy of the chat app. The component under test is the production one, and the only things the
 * driver needs from this file are a way to hand it messages and a connection to read them through. Every message it
 * renders — the bounded preview and the read block that restores it — is the backend's own /state answer, so the URL the
 * component reads is the real one the real proxy serves, resolved by the connection's own reader exactly as a Web page
 * resolves it.
 *
 * The driver reads rendered DOM and the clipboard; it inspects no component internals.
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { MessageView } from "@hepi/ui/components/MessageView";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { WorkbenchConnectionProvider, workbenchConnection } from "@hepi/ui/lib/workbench-scope";
import type { AgentMessage } from "@hepi/ui/lib/types";

interface FixtureController {
  /** Mount what the backend's /state answered: the messages and the entry ids they belong to. */
  setMessages(sessionId: string, entryIds: string[], messages: AgentMessage[]): void;
}

declare global {
  interface Window { __deferredText?: FixtureController }
}

/** The Web host's connection: no stated origin, the browser's own cookie, and a stream this fixture never joins. */
function useFixtureConnection() {
  const client = useMemo(() => createClient({
    origin: "",
    credential: { kind: "cookie" },
    createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
  }), []);
  useEffect(() => () => client.dispose(), [client]);
  return useMemo(() => workbenchConnection(client, { profile: "deferred-text", backendId: "deferred-text", accountScope: "deferred-text" }), [client]);
}

function Fixture() {
  const connection = useFixtureConnection();
  const [state, setState] = useState<{ sessionId: string; entryIds: string[]; messages: AgentMessage[] }>({ sessionId: "", entryIds: [], messages: [] });

  useEffect(() => {
    window.__deferredText = {
      setMessages(sessionId, entryIds, messages) { setState({ sessionId, entryIds, messages }); },
    };
    document.body.dataset.fixtureReady = "true";
    return () => { delete window.__deferredText; };
  }, []);

  return (
    <WorkbenchConnectionProvider value={connection}>
      <div data-fixture-chat>
        {state.messages.map((message, index) => (
          <MessageView
            key={state.entryIds[index] ?? index}
            message={message}
            entryId={state.entryIds[index]}
            sessionId={state.sessionId}
          />
        ))}
      </div>
    </WorkbenchConnectionProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
