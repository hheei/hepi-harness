"use client";

/**
 * The file surfaces themselves, under an App's credential.
 *
 * A packaged App's document is a bundle on `tauri://localhost` with a device bearer and no cookie jar, so no element of
 * it can present that credential: a markdown body's local image and the viewer's own image must both come through the
 * connection. This fixture mounts the production components behind a real `createClient`; the page's server answers
 * only a request that carries the bearer, and the test asserts which ones did.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { WorkbenchCapabilitiesProvider } from "@hepi/ui/lib/navigation";
import type { FileSaveHost } from "@hepi/ui/lib/file-save";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { FileViewer } from "@hepi/ui/components/FileViewer";
import { FileSaveControl } from "@hepi/ui/components/FileSaveControl";
import { TreeNode } from "@hepi/ui/components/FileExplorer";
import { MarkdownBody } from "@hepi/ui/components/MarkdownBody";
import { useI18n } from "@hepi/ui/hooks/useI18n";

/** The credential this connection presents, as the page's server checks it. */
export const BEARER = "ux-file-surfaces-bearer";

const identity = { profile: "ux-files", backendId: "ux-files", accountScope: "ux-files" };
const client = createClient({
  origin: location.origin,
  credential: { kind: "bearer", token: BEARER },
  // No stream is joined here; the factory is stated because the client requires one.
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

/**
 * The save the App's shell would perform, as the fixture stands in for it.
 *
 * A packaged App's save is the shell's: a destination picker, then bounded slices written by the shell. The shell is not
 * here, so this records the same calls the App's own host makes and keeps the bytes — which is what lets a real browser
 * state that the control hands the file over in bounded slices instead of collecting it into a page blob. The record is
 * published on the document so the driver can read it.
 */
const saved = { slices: 0, largest: 0, bytes: 0, path: "", finished: false, aborted: false };
const saveHost: FileSaveHost = {
  async chooseDestination(name) {
    saved.path = "/tmp/" + name;
    return { path: saved.path, overwrite: false };
  },
  async begin() { return 1; },
  async append(_handle, chunk) {
    saved.slices += 1;
    saved.largest = Math.max(saved.largest, chunk.byteLength);
    saved.bytes += chunk.byteLength;
    return saved.bytes;
  },
  async finish() { saved.finished = true; },
  async abort() { saved.aborted = true; },
};
(globalThis as { __HEPI_SAVED__?: typeof saved }).__HEPI_SAVED__ = saved;

/**
 * The same save host, but slow — a device that takes a moment per slice, which is the ordinary case the explorer's row
 * has to survive. Published separately so a driver can tell the two records apart.
 */
const rowSaved = { slices: 0, bytes: 0, path: "", finished: false, aborted: false };
const slowSaveHost: FileSaveHost = {
  async chooseDestination(name) {
    rowSaved.path = "/tmp/" + name;
    return { path: rowSaved.path, overwrite: false };
  },
  async begin() { return 1; },
  async append(_handle, chunk) {
    // The wait is what makes the transfer observably in flight: without it the whole file crosses in one slice before a
    // pointer could move.
    await new Promise((resolve) => setTimeout(resolve, 400));
    rowSaved.slices += 1;
    rowSaved.bytes += chunk.byteLength;
    return rowSaved.bytes;
  },
  async finish() { rowSaved.finished = true; },
  async abort() { rowSaved.aborted = true; },
};
(globalThis as { __HEPI_ROW_SAVED__?: typeof rowSaved }).__HEPI_ROW_SAVED__ = rowSaved;

/**
 * One explorer row, mounted with the App's own save host.
 *
 * The row is the surface the control's lifetime belongs to: it decides when the control exists, and the control is what
 * owns the save. Mounting it here — rather than only the control — is what lets a driver move the pointer off a row whose
 * save is still running and see whether the transfer it started survives.
 */
function ExplorerRow() {
  const { t } = useI18n();
  return (
    <section id="explorer-row">
      <TreeNode
        node={{ name: "row-save.png", fullPath: "/workspace/ws/row-save.png", isDir: false, size: 68, loaded: true }}
        depth={0}
        cwd="/workspace/ws"
        onOpenFile={() => {}}
        expandedPaths={new Set<string>()}
        onToggleExpanded={() => {}}
        highlightedPaths={new Set<string>()}
        gitStatusByPath={new Map()}
        changedDirectoryPaths={new Set<string>()}
        t={t}
      />
    </section>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <WorkbenchConnectionProvider value={workbenchConnection(client, identity)}>
        <section id="message">
          <MarkdownBody cwd="/workspace/ws">{"![local](./logo.png)"}</MarkdownBody>
        </section>
        <section id="viewer">
          <FileViewer filePath="/workspace/ws/logo.png" cwd="/workspace/ws" />
        </section>
        {/* A host that states a save host is the App; the same connection and the same control. */}
        <WorkbenchCapabilitiesProvider value={{ save: saveHost }}>
          <section id="native-save">
            <FileSaveControl filePath="/workspace/ws/logo.png" />
          </section>
        </WorkbenchCapabilitiesProvider>
        {/* The explorer's own row, whose control is revealed by hovering it. */}
        <WorkbenchCapabilitiesProvider value={{ save: slowSaveHost }}>
          <ExplorerRow />
        </WorkbenchCapabilitiesProvider>
      </WorkbenchConnectionProvider>
    </I18nProvider>
  </StrictMode>,
);
