"use client";

/**
 * A workspace Word document, opened by a real browser.
 *
 * Four viewers, one per state a document can put a page in, each on the production FileViewer: a Web page's cookie
 * connection (whose element request carries the credential by itself), a packaged App's bearer connection (whose bytes the
 * connection reads into a leased blob), a document past the bound the preview holds itself to, and a document with no text.
 * The routing workspace each request names selects the answer the page's own server gives — see the .ts driver beside this file.
 *
 * What only a browser can show is that the text reaches the screen at all: the reader is mammoth's browser entry, chosen by
 * its "browser" package field at bundle time, and it runs against bytes that came through the same seam a person's browser
 * uses. The fixture document also carries a <script> in one paragraph, which is what makes "its markup stays inert" a
 * measurement rather than a claim: the assertion is that those words appear as words and no function of the document ever
 * executes on the page.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { FileViewer } from "@hepi/ui/components/FileViewer";

/** The credential the App connection presents, as the page's server checks it. */
export const BEARER = "ux-docx-bearer";

const identity = { profile: "ux-docx", backendId: "ux-docx", accountScope: "ux-docx" };

const cookieClient = createClient({
  origin: location.origin,
  credential: { kind: "cookie" },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const bearerClient = createClient({
  origin: location.origin,
  credential: { kind: "bearer", token: BEARER },
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});

/** One viewer per state, each mounting the file a real document would have. */
const MOUNTS = [
  { id: "cookie", client: cookieClient, workspace: "docx" },
  { id: "bearer", client: bearerClient, workspace: "docx" },
  { id: "oversize", client: cookieClient, workspace: "big" },
  { id: "empty", client: cookieClient, workspace: "blank" },
];

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      {MOUNTS.map((mount) => (
        <section id={"viewer-" + mount.id} key={mount.id}>
          <WorkbenchConnectionProvider value={workbenchConnection(mount.client, identity)}>
            <FileViewer filePath={"/workspace/" + mount.workspace + "/report.docx"} cwd={"/workspace/" + mount.workspace} />
          </WorkbenchConnectionProvider>
        </section>
      ))}
    </I18nProvider>
  </StrictMode>,
);
