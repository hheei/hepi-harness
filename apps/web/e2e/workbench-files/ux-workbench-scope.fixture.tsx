"use client";

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { createClient, type WorkbenchClient } from "@hepi/ui/client";
import { connectionIdentityOf, connectionScopeKey } from "@hepi/ui/lib/connection-scope";
import { getDraft, setDraft, setDraftScope } from "@hepi/ui/lib/draft-store";
import { getSessionViewSnapshot, setSessionViewSnapshot } from "@hepi/ui/lib/session-view-cache";
import { useHostNavigation } from "@hepi/ui/host-router";

/**
 * The connection-scope seam, in a real browser.
 *
 * The fixture mounts the real scoped stores and the real client behind two connections that share a session id, and
 * states what each one sees. What it is about is the acceptance that a connection switch cannot leak the previous one's
 * drafts, cached views, resources or in-flight answers into the next — the parts of that which are pure page state.
 *
 * It deliberately does not stand up an ingress: the routing, the client's own request/stream plumbing and the resource
 * leases are held by their own tests against a real Gateway, and a fixture that re-implemented one would prove only that
 * the fixture works. What is exercised here is the browser's own part — sessionStorage, blob URLs and the module-scope
 * stores — which no Node test can hold.
 */
type Report = Record<string, unknown>;

function Fixture() {
  const navigation = useHostNavigation();
  const [report, setReport] = useState<Report>({ state: "idle" });

  async function run() {
    const log: Report = {};
    const connectionA = connectionIdentityOf("profile-a", { backend: { id: "backend-1" }, account: { scope: "acct" } });
    const connectionB = connectionIdentityOf("profile-b", { backend: { id: "backend-1" }, account: { scope: "acct" } });
    const scopeA = connectionScopeKey(connectionA);
    const scopeB = connectionScopeKey(connectionB);
    log.scopesDiffer = scopeA !== scopeB;

    // A draft and a remembered view written on the first connection, under a conversation id both connections have.
    setDraftScope(scopeA);
    setDraft(scopeA === scopeB ? "never" : "conv", { value: "unsent on A", images: [] });
    setSessionViewSnapshot(scopeA, {
      sessionId: "conv", revision: "rev-a", messages: [{ role: "user", content: "A's history" }], entryIds: ["e1"],
      leafId: "e1", oldestEntryId: "e1", hasMore: false, historyHead: "h1", thinkingLevel: "off", model: null,
      loadedEntryIds: ["e1"], prefixEntryIds: [], prefixMessages: [], prefixHistoryHead: null,
    });
    log.draftOnA = getDraft("conv")?.value ?? null;
    log.viewOnA = getSessionViewSnapshot(scopeA, "conv")?.messages[0]?.role === "user"
      ? String((getSessionViewSnapshot(scopeA, "conv")?.messages[0] as { content?: unknown }).content ?? "")
      : null;

    // Switch connection. Nothing of the first may be readable, because the ids are only unique within one Backend and
    // a profile switch is exactly a different connection.
    setDraftScope(scopeB);
    log.draftOnB = getDraft("conv")?.value ?? null;
    log.viewOnB = getSessionViewSnapshot(scopeB, "conv");
    log.storageKeys = Object.keys(window.sessionStorage).length;

    // Write on the second connection and switch back: each connection still holds only its own.
    setDraft(scopeB === scopeA ? "never" : "conv", { value: "unsent on B", images: [] });
    setDraftScope(scopeA);
    log.draftBackOnA = getDraft("conv")?.value ?? null;

    // A client's resources belong to the connection that loaded them: disposing one revokes its blobs and refuses its
    // later requests, and does not touch the other.
    const clients: WorkbenchClient[] = [];
    const make = (token: string) => {
      const client = createClient({
        origin: window.location.origin,
        credential: { kind: "bearer", token },
        // No stream is joined here; the factory is stated because the client requires one, and a test that joined a
        // stream would be testing the transport's own suite.
        createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
        fetch: async () => new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), { status: 200 }),
      });
      clients.push(client);
      return client;
    };
    const clientA = make("token-a");
    const clientB = make("token-b");
    const imageA = await clientA.resources.image("/api/sessions/conv/entries/e1/tool-result-image");
    log.imageLoaded = imageA.ok === true;
    const urlA = imageA.ok ? imageA.value.url : null;
    log.imageResolvesBeforeDispose = urlA === null ? false : (await fetch(urlA).then(r => r.ok).catch(() => false));
    clientA.dispose();
    log.imageResolvesAfterDispose = urlA === null ? true : (await fetch(urlA).then(r => r.ok).catch(() => false));
    log.disposedClientRefuses = await clientA.request("/api/descriptor").then(() => false, () => true);
    // The other connection is untouched by that disposal: releasing one caller is not closing the shared stream.
    log.otherClientStillWorks = await clientB.request("/api/descriptor").then(response => response.ok, () => false);
    log.otherImageStillResolves = await clientB.resources.image("/api/sessions/conv/entries/e1/tool-result-image")
      .then(result => result.ok && fetch(result.value.url).then(r => r.ok).catch(() => false), () => false);
    clientB.dispose();

    // The logical query is the router's, not the page's own address: the fragment form a packaged App has resolves to
    // the same parameters this page's search string does.
    const query = new URLSearchParams(navigation.location.search);
    log.routeSession = query.get("session");
    log.routeCwd = query.get("cwd");
    setReport({ state: "done", ...log });
  }

  if (report.state === "idle") void run();
  return <pre id="report" data-state={String(report.state)}>{JSON.stringify(report)}</pre>;
}

const root = document.getElementById("root");
if (root === null) throw new Error("no root");
createRoot(root).render(<StrictMode><BrowserRouter><Fixture /></BrowserRouter></StrictMode>);
