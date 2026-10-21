/**
 * The child recovery surface, mounted as the product mounts it, with only its network boundary replaced.
 *
 * `ChildRecoveryPanel` is rendered inside StrictMode and a workbench connection, exactly as `ChatWindow` renders it for a
 * conversation whose catalogue row states a `subagent` relation, plus one ordinary conversation that must state nothing.
 * The panel's requests are held by this fixture until the driver answers them, so the driver decides the **order** the
 * answers arrive in — which is the only way to see whether a superseded answer is published or dropped.
 *
 * Everything the driver asserts is rendered DOM of the real component. No backend, no store, no clock: the transport is
 * two deferred promises, and the facts are the wire shape `GET /api/conversations/:id/recovery` answers with.
 */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChildRecoveryPanel } from "@hepi/ui/components/ChildRecoveryPanel";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import { createClient } from "@hepi/ui/client";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";

export interface Gate {
  /** How many recovery reads have been asked for, and which conversation each named. */
  readonly reads: number;
  readonly conversations: readonly string[];
  /** How many preparation retries have been asked for, and what each one carried. */
  readonly retries: number;
  readonly retryBodies: readonly unknown[];
  readonly retryConversations: readonly string[];
  /** Answer the nth held read (1-based) with these facts. */
  answerRead(attempt: number, facts: Record<string, unknown>): void;
  /** Fail the nth held read the way a dropped connection does. */
  failRead(attempt: number): void;
  /** Answer the nth held retry (1-based). */
  answerRetry(attempt: number, facts: Record<string, unknown>): void;
  /** Replace the workbench connection, as a reconnect does. The previous client is left able to answer. */
  swapConnection(): void;
  /** Show another conversation, as selecting another child does. */
  swapSession(): void;
}

declare global {
  interface Window { __recovery?: Gate }
}

type Pending = (outcome: { readonly response: Response } | { readonly error: Error }) => void;

const pendingReads: Pending[] = [];
const pendingRetries: Pending[] = [];
const conversations: string[] = [];
const retryBodies: unknown[] = [];
const retryConversations: string[] = [];
let reads = 0;
let retries = 0;
let swapConnection: () => void = () => undefined;
let swapSession: () => void = () => undefined;

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** One request whose answer the driver will state, by attempt number. */
function held(list: Pending[]): Promise<Response> {
  return new Promise<Response>((resolve, reject) => { list.push((outcome) => ("error" in outcome ? reject(outcome.error) : resolve(outcome.response))); });
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const path = url.split("?")[0];
  const matched = /\/api\/conversations\/([^/]+)\/recovery$/.exec(path);
  if (matched !== null) {
    const conversationId = decodeURIComponent(matched[1]);
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      retries += 1;
      retryConversations.push(conversationId);
      retryBodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      return held(pendingRetries);
    }
    reads += 1;
    conversations.push(conversationId);
    return held(pendingReads);
  }
  return realFetch(input, init);
};

window.__recovery = {
  get reads() { return reads; },
  get retries() { return retries; },
  get conversations() { return conversations.slice(); },
  get retryBodies() { return retryBodies.slice(); },
  get retryConversations() { return retryConversations.slice(); },
  answerRead: (attempt, facts) => {
    const settle = pendingReads[attempt - 1];
    if (settle === undefined) throw new Error("no held read " + attempt);
    settle({ response: json({ recovery: facts }) });
  },
  failRead: (attempt) => {
    const settle = pendingReads[attempt - 1];
    if (settle === undefined) throw new Error("no held read " + attempt);
    settle({ error: new Error("the connection dropped") });
  },
  answerRetry: (attempt, facts) => {
    const settle = pendingRetries[attempt - 1];
    if (settle === undefined) throw new Error("no held retry " + attempt);
    settle({ response: json({ recovery: facts }) });
  },
  swapConnection: () => { swapConnection(); },
  swapSession: () => { swapSession(); },
};

const IDENTITY = { profile: "ux-child-recovery", backendId: "ux-child-recovery", accountScope: "ux-child-recovery" };

/**
 * The panel's two hosts: one delegated child, and one ordinary conversation that must ask nothing and state nothing.
 *
 * A replaced connection is a **new client under a new identity**, which is what the product builds on a reconnect, and
 * the previous client is deliberately left undisposed so that the only thing that can keep its late answer off the
 * screen is the panel's own ordering rule rather than a closed transport.
 */
function Host() {
  const [generation, setGeneration] = useState(0);
  const [sessionId, setSessionId] = useState("child-1");
  swapConnection = () => setGeneration((current) => current + 1);
  swapSession = () => setSessionId((current) => (current === "child-1" ? "child-2" : "child-1"));

  const client = useMemo(() => createClient({
    origin: "",
    credential: { kind: "cookie" },
    createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
  }), [generation]);
  const connection = useMemo(() => workbenchConnection(client, { ...IDENTITY, backendId: IDENTITY.backendId + "-" + generation, accountScope: IDENTITY.accountScope + "-" + generation }), [client, generation]);

  return (
    <WorkbenchConnectionProvider value={connection}>
      <section id="child">
        <ChildRecoveryPanel session={{ id: sessionId, relation: { kind: "subagent", parentSessionId: "parent-1" } }} />
      </section>
      <section id="ordinary">
        <ChildRecoveryPanel session={{ id: "ordinary-1" }} />
      </section>
    </WorkbenchConnectionProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <Host />
    </I18nProvider>
  </StrictMode>,
);
