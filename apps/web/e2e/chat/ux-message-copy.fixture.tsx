/**
 * Browser fixture for the prompt copy seam: one production `MessageView` holding a deferred prompt, mounted under a real
 * connection whose reader answers the read block the prompt names.
 *
 * Nothing here decides what a copy does. The message is the shape the projection publishes (a bounded preview plus an
 * inline block beside it), the connection is `createClient` with a fixture transport that records every read, and the
 * clipboard is the browser's own — replaced by a recorder so the driver can read what was written. The only controls on
 * the page are the production ones: the deferred block's expand button and the prompt's copy button.
 */
import { createRoot } from "react-dom/client";
import { MessageView } from "@hepi/ui/components/MessageView";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { WorkbenchConnectionProvider, workbenchConnection } from "@hepi/ui/lib/workbench-scope";
import type { AgentMessage } from "@hepi/ui/lib/types";
import { INLINE_TEXT, PREVIEW_TEXT, WHOLE_TEXT } from "./ux-message-copy-prompt.ts";

declare global {
  interface Window {
    reads: string[];
    copies: string[];
  }
}

window.reads = [];
window.copies = [];
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => { window.copies.push(text); } },
});

const client = createClient({
  origin: location.origin,
  credential: { kind: "cookie" },
  createSource: () => { throw new Error("the copy seam opens no conversation stream"); },
  fetch: async (url) => {
    window.reads.push(String(url));
    return new Response(JSON.stringify({ text: WHOLE_TEXT, offset: 0, totalBytes: WHOLE_TEXT.length, truncated: false }), {
      headers: { "content-type": "application/json" },
    });
  },
});
const connection = workbenchConnection(client, { profile: "copy", backendId: "fixture", accountScope: "copy" });

const prompt: AgentMessage = {
  role: "user",
  content: [
    { type: "text", text: PREVIEW_TEXT, deferred: true, textUrl: "/api/sessions/s/entries/prompt/text?blockIndex=0" },
    { type: "text", text: INLINE_TEXT },
  ],
  timestamp: 1700000000000,
};

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <I18nProvider>
    <WorkbenchConnectionProvider value={connection}>
      <div id="prompt">
        <MessageView message={prompt} entryId="prompt" />
      </div>
    </WorkbenchConnectionProvider>
  </I18nProvider>,
);
