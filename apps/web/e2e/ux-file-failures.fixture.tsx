"use client";

/**
 * The explorer and the viewer under a connection whose host answered, failed, or is gone.
 *
 * Four workspaces, one per answer a file surface can give, mounted in the components a person actually reads: the
 * tree's own failure, the changed-files panel, and the viewer's preview error. Which workspace a request names selects
 * the answer the page's server gives (see the .mjs beside this file), so all four states are on screen at once and the
 * assertions are about what the page says in each — not about what a stub returned.
 *
 * The HTTP contract itself belongs to the ingress suites (`ingress-ssh-workbench.test.ts` pins each cause to its status
 * and code against the real surface); what only a mounted component can show is whether a person is told the cause and
 * given a way to act on it, or is shown an empty list that reads as "nothing changed".
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { FileExplorer } from "@hepi/ui/components/FileExplorer";
import { FileViewer } from "@hepi/ui/components/FileViewer";

const identity = { profile: "ux-file-failures", backendId: "ux-file-failures", accountScope: "ux-file-failures" };
const client = createClient({
  origin: location.origin,
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

const WORKSPACES = ["ok", "failed", "offline", "absent"] as const;

/** What the shell-level hooks were asked to do, so the journey can assert a click reached them rather than the host. */
declare global {
  interface Window { fileFailureActions: { reloadFolder: number } }
}
window.fileFailureActions = { reloadFolder: 0 };

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
        {WORKSPACES.map((name) => (
          <section id={"panel-" + name} key={name} data-workspace={name}>
            <FileExplorer
              cwd={"/workspace/" + name}
              onOpenFile={() => {}}
              changesCollapsed={false}
            />
          </section>
        ))}
        <section id="viewer-failed">
          <FileViewer filePath="/workspace/failed/notes.md" cwd="/workspace/failed" />
        </section>
        {/* A file deleted after the listing was read: the panel's move is the folder reload the shell owns, not the
            same read repeated. The hook is the AppShell's own refresh in production. */}
        <section id="viewer-missing">
          <FileViewer
            filePath="/workspace/missing/notes.md"
            cwd="/workspace/missing"
            onReloadFolder={() => { window.fileFailureActions.reloadFolder += 1; }}
          />
        </section>
        {/* A preview the host bounded: the viewer states the chunk it shows and the size the host stated. */}
        <section id="viewer-truncated">
          <FileViewer filePath="/workspace/truncated/notes.md" cwd="/workspace/truncated" />
        </section>
      </WorkbenchConnectionProvider>
    </I18nProvider>
  </StrictMode>,
);
