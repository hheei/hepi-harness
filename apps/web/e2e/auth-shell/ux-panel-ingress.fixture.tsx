/**
 * Ticket 11 browser seam: a settings panel asks the connection's own origin, with the connection's own credential.
 *
 * The fixture mounts the real surfaces — `SettingsPanel`'s General, Models and Extensions sections, and the production
 * `EnabledModelsSection` with its own `useEnabledModels` controller — behind one real `createClient` whose origin is a
 * configured ingress and whose credential is one device bearer. The client's `fetch` is the connection's own transport
 * (the host's, in a packaged App) and records every URL and header it is handed, so what the panels asked for and which
 * credential they presented is the assertion, not what a stub was told.
 *
 * Every read and write below belongs to the connection. The page's own transport is still recorded, because a panel
 * route that fell back to the page's origin instead of the configured ingress is exactly what this fixture must be able
 * to see — and nothing on this surface belongs there any more: the push prototype that used to was retired in ticket 14.
 *
 * The provider section answers this origin's **host** routes (the listing, the API-key set/remove and the sign-in flow),
 * so the fixture keeps a small host state of its own — configured flag, stored type and a hint it masked itself — and a
 * set/remove changes that state rather than replaying a canned body. It never holds the caller's value: the driver sends
 * one raw key and the fixture is free to answer only a hint, which is what makes "no response echoes the key" a real
 * assertion instead of a tautology about a static stub.
 *
 * The sign-in host is the same idea for a flow: it scripts the steps one provider's OAuth flow would report (a device
 * code, then a paste-back question, then a stored subscription), advances them per read, and holds the answer a caller
 * gave only as a recorded request body. Everything the panel shows about a flow therefore comes from a host-shaped
 * answer rather than from the panel's own wish, which is what makes "the flow's steps reach a person" and "the answer is
 * never echoed" testable at this seam at all.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@hepi/ui/client";
import { connectionIdentityOf } from "@hepi/ui/lib/connection-scope";
import { workbenchConnection, WorkbenchConnectionProvider } from "@hepi/ui/lib/workbench-scope";
import { SettingsPanel } from "@hepi/ui/components/SettingsPanel";
import { ModelsConfig } from "@hepi/ui/components/ModelsConfig";
import { ExtensionsConfig } from "@hepi/ui/components/ExtensionsConfig";
import { EnabledModelsSection, useEnabledModels } from "@hepi/ui/components/EnabledModelsSection";
import { modelsScopeOf, pageModelsCache, subscribeModelCatalog } from "@hepi/ui/lib/models-cache";
import { I18nProvider } from "@hepi/ui/hooks/useI18n";
import "./ux-panel-ingress.fixture.css";

/** A configured ingress origin: not the origin this document was loaded from. */
export const INGRESS_ORIGIN = "https://ingress.example:9443";
/** The one device credential this connection presents. */
export const BEARER = "panel-ingress-device-bearer";

export type ConnectionRequest = {
  method: string;
  url: string;
  authorization: string | null;
  credentials: string | null;
  /** The body the connection was handed, when the request had one — a typed API key exists here and nowhere else. */
  body: string | null;
};
export type PageRequest = { method: string; url: string };
export type View = "general" | "models" | "enabled" | "extensions";

export interface Gate {
  connection: ConnectionRequest[];
  page: PageRequest[];
  origin: string;
  bearer: string;
  setView(view: View): void;
  /** The host's own stored state for the key provider, after whatever the panel just asked for. */
  providerHostState(): { configured: boolean; storedType: string | null; maskedHint: string | null };
  /** The page's own cached model catalog, so a driver can state what a credential change left behind. */
  cachedCatalog(): { reads: number; entries: number };
  readCatalog(): Promise<void>;
  /**
   * Put a mounted catalog reader on the page: it follows the model domain's own rule and re-reads the page's cache, which
   * is exactly what a composer on screen does. Until this is called the page holds a cache and no reader, so a change
   * costs it no request — the other half of the same contract.
   */
  followCatalog(): void;
  /** What the next `models.json` save is answered with: the running runtime took it, or the file was written and it was not. */
  answerModelSave(applied: boolean): void;
  /** The sign-in host: what its flow was given, and whether it ended up storing a credential. */
  signInHostState(): { answers: string[]; stored: boolean; open: boolean; step: number };
}

declare global {
  interface Window { __uxPanelIngress?: Gate }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const gate: Gate = {
  connection: [], page: [], origin: INGRESS_ORIGIN, bearer: BEARER,
  setView: () => undefined,
  providerHostState: () => ({ ...keyHostState }),
  cachedCatalog: () => ({ reads: catalogReads, entries: pageModelsCache().size }),
  readCatalog: async () => { await pageModelsCache().load(modelsScopeOf(identity), "/workspace/local", async () => { catalogReads += 1; return { models: [], defaultModel: null }; }); },
  followCatalog: () => {
    if (following) return;
    following = true;
    subscribeModelCatalog(() => void gate.readCatalog());
  },
  answerModelSave: (applied) => { modelsFileState.applied = applied; },
  signInHostState: () => ({ answers: signInHost.answers.slice(), stored: signInHost.stored, open: signInHost.flowId !== null && signInHost.ended === null, step: signInHost.step }),
};
window.__uxPanelIngress = gate;

const inventory = {
  protocol: "hepi.v1",
  installed: [
    { name: "coding-tools", tools: ["read"], sections: [], enabled: true },
    { name: "workspace-resources", tools: [], sections: ["resources"], enabled: false },
  ],
  default: ["coding-tools"],
  failures: [],
};

const enabledView = {
  allEnabled: false,
  patterns: ["openai/*"],
  stalePatterns: [],
  enabledTotal: 2,
  availableTotal: 2,
  providers: [{
    id: "openai",
    name: "OpenAI",
    kind: "builtin" as const,
    enabledCount: 2,
    models: [
      { id: "gpt-4o", name: "GPT-4o", ref: "openai/gpt-4o", enabled: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini", ref: "openai/gpt-4o-mini", enabled: true },
    ],
  }],
  scope: "global" as const,
  settingsPath: "~/.pi/agent/settings.json",
  editable: true,
};

const toolSettings = { isWindows: false, powerShellEnabled: false, codemode: "never", codemodeMode: "off", codemodeInlineBudget: "default" };

/**
 * The host's provider listing, as this origin's gateway service answers it.
 *
 * One provider whose key this host does not hold yet (so the panel offers the key field), and one subscription whose
 * sign-in flow no entry serves (so the panel asks the sign-in route and withholds the control). The stored state is the
 * fixture's, not the panel's: a set writes it, a remove clears it, and every answer carries only the hint this host
 * would have masked — never the value the caller sent.
 */
const KEY_PROVIDER = "fixture-key";
const OAUTH_PROVIDER = "fixture-oauth";
/** A provider whose sign-in this host does serve, so the panel follows a flow step by step. */
const SIGN_IN_PROVIDER = "fixture-signin";
const keyHostState: { configured: boolean; storedType: string | null; maskedHint: string | null } =
  { configured: false, storedType: null, maskedHint: null };
/** The models.json this origin's Backend serves, and what it says about applying the next write. */
const modelsFileState: { file: { providers: Record<string, unknown> }; applied: boolean } = {
  file: { providers: { openai: { models: [{ id: "gpt-4o", name: "GPT-4o" }] } } },
  applied: true,
};
const signInHostState = { configured: false, storedType: null as string | null };

/**
 * The scripted flow, as the host would report it: one step per read, the last one storing a credential.
 *
 * `provider` is the host's own JSON (`ProviderLoginInfo`) and nothing else, so the panel is driven by the same shape the
 * gateway writes rather than by a fixture's invention of a friendlier one.
 *
 * Including its readable-window behaviour: `ProviderLoginService` keeps a flow's outcome reportable for `keepMs` after it
 * ends, and `login-status` answers it when no flow is open — so a read that names no flow can legitimately return a
 * *terminal* flow. That is what a panel must not mistake for a sign-in to follow, and the reason the record is modelled
 * here rather than dropped at the moment the flow ends.
 */
const FLOW_STEPS: Record<string, unknown>[] = [
  {
    phase: "waiting_for_browser", waitingFor: ["browser"], expiresInMs: 540_000,
    event: { type: "device_code", userCode: "GQV-GBNN", verificationUri: "https://fixture.example/device", intervalSeconds: 5, expiresInSeconds: 900 },
  },
  {
    phase: "waiting_for_input", waitingFor: ["browser", "input"], expiresInMs: 528_000,
    event: { type: "auth_url", url: "https://fixture.example/oauth/authorize?code_challenge=E9Melhoa2Owv&state=abc", instructions: "Approve the sign-in in the browser" },
    prompt: { type: "manual_code", message: "Paste the redirect address", placeholder: "http://localhost:53692/callback?code=…" },
  },
  { phase: "succeeded", waitingFor: [], expiresInMs: 0, storedType: "oauth" },
];

const signInHost = {
  /** The open flow's id, or null once it ended: a second read then answers the host's own `flow_unknown`. */
  flowId: null as string | null,
  /** Steps this panel has been handed so far. The first read of a started flow reports step 0. */
  step: 0,
  /** Every answer the flow was given, kept only as the body the connection was handed. */
  answers: [] as string[],
  ended: null as string | null,
  /** The host's view of what the flow did: only a step that stored a credential sets it. */
  stored: false,
  /**
   * The outcome the host still reports after its flow ended, id and all.
   *
   * Set by the step that ends a flow — a cancel, or the credential being stored — and cleared when a new one opens, which
   * is the host's own rule that an open flow wins a read.
   */
  readable: null as Record<string, unknown> | null,
  start(): string {
    this.flowId = "11111111-1111-4111-8111-00000000000" + (this.answers.length + 1);
    this.step = 0;
    this.ended = null;
    this.readable = null;
    return this.flowId;
  },
  /** The step a read reports. A flow waiting on a browser may move on its own; one waiting on an answer may not. */
  report(): Record<string, unknown> {
    const shown = this.current();
    if (String(shown.phase) === "waiting_for_browser") this.step += 1;
    return shown;
  },
  /** The step an answer produced: the flow moved because a person acted on it. */
  advanced(): Record<string, unknown> {
    this.step = Math.min(this.step + 1, FLOW_STEPS.length - 1);
    const shown = this.current();
    if (String(shown.phase) === "succeeded") {
      this.stored = true;
      signInHostState.configured = true;
      signInHostState.storedType = "oauth";
      // The flow is over, and its outcome stays reportable under the id it had.
      this.readable = shown;
      this.flowId = null;
    }
    return shown;
  },
  /**
   * What a read that names no flow answers: the open flow's step, or the outcome still held from the last one.
   *
   * Both are 200s with a flow in them, exactly as the host answers `login-status`; nothing held at all is undefined, which
   * the route below answers as the host's `flow_unknown`.
   */
  status(): Record<string, unknown> | undefined {
    if (this.flowId !== null && this.ended === null) return this.current();
    return this.readable ?? undefined;
  },
  current(): Record<string, unknown> {
    const info = FLOW_STEPS[Math.min(this.step, FLOW_STEPS.length - 1)];
    return { flowId: this.flowId ?? "none", providerId: SIGN_IN_PROVIDER, ...info };
  },
};

function providerSections() {
  const keyRow = {
    id: KEY_PROVIDER,
    name: "Fixture Key",
    displayName: "Fixture Key",
    configured: keyHostState.configured,
    loggedIn: keyHostState.configured,
    ...(keyHostState.storedType === null ? {} : { storedType: keyHostState.storedType }),
    ...(keyHostState.maskedHint === null ? {} : { maskedHint: keyHostState.maskedHint }),
    supportsApiKey: true,
    supportsOAuth: false,
  };
  const oauthRow = {
    id: OAUTH_PROVIDER, name: "Fixture Subscription", displayName: "Fixture Subscription",
    configured: false, loggedIn: false, supportsApiKey: false, supportsOAuth: true,
  };
  const signinRow = {
    id: SIGN_IN_PROVIDER, name: "Fixture Sign-in", displayName: "Fixture Sign-in",
    configured: signInHostState.configured, loggedIn: signInHostState.configured,
    ...(signInHostState.storedType === null ? {} : { storedType: signInHostState.storedType }),
    supportsApiKey: false, supportsOAuth: true,
  };
  return { oauthProviders: [oauthRow, signinRow], apiKeyProviders: [keyRow] };
}

/** The deployment's answers, as the real routes answer them. An unlisted route is a request the fixture did not expect. */
function answer(url: string, init?: RequestInit): Response {
  const path = url.slice(INGRESS_ORIGIN.length).split("?")[0];
  const method = init?.method ?? "GET";
  // No Web login state is answered here: this fixture's connection is a device bearer, so the production panel asks no
  // cookie-session question and offers no cookie logout. An unlisted route is a request the fixture did not expect.
  if (path === "/api/tools/settings" && method === "GET") return json(toolSettings);
  if (path === "/api/models-config" && method === "GET") {
    return json(modelsFileState.file);
  }
  // The Backend's own save: the file is written either way, and whether the running runtime took it is its answer.
  if (path === "/api/models-config" && method === "PUT") {
    modelsFileState.file = JSON.parse(String(init?.body ?? "{}")) as { providers: Record<string, unknown> };
    return json(modelsFileState.applied
      ? { success: true, applied: true }
      : { success: true, applied: false, error: "the running runtime could not apply this file" });
  }
  if (path === "/api/auth/providers" && method === "GET") return json(providerSections());
  // The API-key write path of this origin's provider host: it accepts the key, stores a masked hint, and answers the
  // listing that resulted — never the value it was given.
  if (path === "/api/auth/api-key/" + KEY_PROVIDER && method === "POST") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { apiKey?: unknown };
    if (typeof sent.apiKey !== "string" || sent.apiKey.trim() === "") {
      return json({ success: false, code: "invalid_request", error: "The request must carry an API key" }, 400);
    }
    // The host's own retryable refusal: another writer holds `auth.json`. The panel states it as a retry and the stored
    // credential is left exactly as it was, which is what makes "a failed write claims no applied change" observable.
    if (sent.apiKey === "sk-refused-locked") {
      return json({ success: false, code: "lock_unavailable", error: "another writer holds auth.json on this host" }, 503);
    }
    keyHostState.configured = true;
    keyHostState.storedType = "api_key";
    keyHostState.maskedHint = "sk-a…host";
    return json({ success: true, providers: providerSections().apiKeyProviders });
  }
  if (path === "/api/auth/api-key/" + KEY_PROVIDER && method === "DELETE") {
    // The removal is guarded by the type the panel read, exactly as the ingress sends it.
    const expected = new URL(url).searchParams.get("expectedType");
    if (expected !== "api_key") {
      return json({ success: false, code: "credential_mismatch", error: "This host stores a different kind of credential" }, 409);
    }
    keyHostState.configured = false;
    keyHostState.storedType = null;
    keyHostState.maskedHint = null;
    return json({ success: true, providers: providerSections().apiKeyProviders });
  }
  // One provider whose sign-in this deployment does not serve: the host states its limit and the panel withholds the
  // control, while the key path and the served sign-in flow beside it keep working.
  if (path === "/api/auth/login/" + OAUTH_PROVIDER) {
    return json({ code: "unsupported", error: "provider sign-in is not served by this client API" }, 501);
  }
  // The served sign-in flow: the route the panel probes, starts, reads, answers and cancels, all on one path with the
  // flow id in the query. A read of no open flow is the host's own `flow_unknown`, never an empty flow.
  if (path === "/api/auth/login/" + SIGN_IN_PROVIDER) {
    const flowId = new URL(url).searchParams.get("flow");
    if (method === "GET" && flowId === null) {
      // The capability probe and the resume read. A host with no open flow still reports the outcome of the last one for as
      // long as it keeps it readable, so this answers a flow rather than a refusal in that case too.
      const reported = signInHost.status();
      if (reported === undefined) {
        return json({ success: false, code: "flow_unknown", error: "no sign-in has that id: it ended, it belongs to another client, or this host service restarted" }, 404);
      }
      return json({ success: true, flow: reported });
    }
    // A start opens a flow when none is open, and answers the one that is when it is: the host keeps one sign-in per
    // caller and provider, so a repeated click or a lost response rejoins the flow rather than opening a second address.
    if (method === "POST" && flowId === null) {
      if (signInHost.flowId === null && signInHost.ended !== null) signInHost.ended = null;
      if (signInHost.flowId === null) { signInHost.start(); signInHost.step = 0; signInHost.stored = false; }
      return json({ success: true, flow: signInHost.current() });
    }
    if (flowId === null) return json({ success: false, code: "invalid_request", error: "the request names no flow" }, 400);
    if (signInHost.ended !== null || signInHost.flowId === null) return json({ success: false, code: "flow_unknown", error: "no sign-in has that id" }, 404);
    if (flowId !== signInHost.flowId) return json({ success: false, code: "flow_unknown", error: "no sign-in has that id" }, 404);
    if (method === "GET") return json({ success: true, flow: signInHost.report() });
    if (method === "POST") {
      const sent = JSON.parse(String(init?.body ?? "{}")) as { answer?: unknown };
      if (typeof sent.answer !== "string" || sent.answer.trim() === "") return json({ success: false, code: "answer_invalid", error: "The request must carry an answer" }, 400);
      signInHost.answers.push(sent.answer);
      return json({ success: true, flow: signInHost.advanced() });
    }
    if (method === "DELETE") {
      signInHost.ended = "cancelled";
      const id = signInHost.flowId;
      signInHost.flowId = null;
      const ended = { flowId: id, providerId: SIGN_IN_PROVIDER, phase: "cancelled", waitingFor: [], expiresInMs: 0, code: "operation_failed", message: "this sign-in was cancelled" };
      signInHost.readable = ended;
      return json({ success: true, flow: ended });
    }
    return json({ success: false, code: "invalid_request", error: "method not allowed for a sign-in route" }, 405);
  }
  // A sign-out names the account, never a flow: it drops whatever the host stored for that provider.
  if (path === "/api/auth/logout/" + SIGN_IN_PROVIDER && method === "POST") {
    signInHostState.configured = false;
    signInHostState.storedType = null;
    signInHost.stored = false;
    return json({ success: true, providers: providerSections().apiKeyProviders });
  }
  // The routes no owner serves, answered as the ingress answers them.
  if (path === "/api/models-config/discover" || path === "/api/models-config/test" || path === "/api/models-config/catalog" || path === "/api/models/refresh") {
    return json({ code: "unsupported", error: "not served by this client API" }, 501);
  }
  if (path === "/api/models/enabled" && method === "GET") return json(enabledView);
  if (path === "/api/models/enabled" && method === "PUT") {
    // The save's answer: the first model is now off, which is what the switch asked for.
    return json({
      ...enabledView,
      enabledTotal: 1,
      providers: [{
        ...enabledView.providers[0],
        enabledCount: 1,
        models: enabledView.providers[0].models.map((model, index) => ({ ...model, enabled: index !== 0 })),
      }],
    });
  }
  if (path === "/api/extensions" && method === "GET") return json(inventory);
  if (path === "/api/extensions" && method === "POST") return json(inventory);
  // The Backend's own vocabulary, which is the only one this deployment serves: the panel reads a conversation's
  // extension selection from `/api/conversations/:id/state`, not the retired Next BFF's `/api/sessions/...`.
  if (path === "/api/conversations/session-1/state" && method === "GET") return json({ sessionId: "session-1", extensions: ["coding-tools"] });
  return json({ error: "the fixture does not answer " + method + " " + path }, 404);
}

/** The connection's own transport: it records the request and answers it, and never reaches the network. */
const connectionFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers);
  gate.connection.push({
    method: init?.method ?? "GET",
    url,
    authorization: headers.get("authorization"),
    credentials: init?.credentials ?? null,
    body: typeof init?.body === "string" ? init.body : null,
  });
  return answer(url, init);
};

// The page's own transport: a relative request is recorded here so the driver can tell it apart from the connection's,
// and anything relative would reach the fixture server instead of the deployment.
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  gate.page.push({ method: init?.method ?? "GET", url });
  return realFetch(input, init);
};

const identity = connectionIdentityOf("profile-panel", { backend: { id: "backend-1" }, account: { scope: "acct" } });
const client = createClient({
  origin: INGRESS_ORIGIN,
  credential: { kind: "bearer", token: BEARER },
  fetch: connectionFetch,
  // No stream is joined here; the factory is stated because the client requires one.
  createSource: () => ({ readyState: 2, onmessage: null, onerror: null, close() {} }),
});
const connection = workbenchConnection(client, identity);

/** The production section with its own production controller: the read and the write both belong to that hook. */
function EnabledModelsSurface() {
  const controller = useEnabledModels("/workspace/local");
  return <EnabledModelsSection providerId="openai" controller={controller} />;
}

const noop = () => undefined;

/** How many times the page's own catalog cache has actually asked, so a drop is visible as a second read. */
let catalogReads = 0;
/** Whether a mounted reader is following the catalog, as the composer of an open page does. */
let following = false;

function Fixture() {
  const [view, setView] = useState<View>("general");
  gate.setView = setView;
  return (
    <>
      {/* General is the one section whose reads (tool settings, the page's own login state) are the panel's, so the
          production SettingsPanel is mounted for it. The others are mounted as the production surfaces themselves. */}
      {view === "general" && (
        <SettingsPanel
          key="general"
          cwd="/workspace/local"
          displayCwd="/workspace/local"
          sessionId={null}
          initialSection="general"
          onClose={noop}
          quoteSelectionEnabled={false}
          onQuoteSelectionChange={noop}
          projectTrust={null}
        />
      )}
      {view === "models" && <ModelsConfig key="models" embedded cwd="/workspace/local" onClose={noop} />}
      {view === "extensions" && <ExtensionsConfig key="extensions" sessionId="session-1" onClose={noop} />}
      {view === "enabled" && <EnabledModelsSurface key="enabled" />}
    </>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("the fixture root element is missing");
createRoot(rootElement).render(
  <WorkbenchConnectionProvider value={connection}>
    <I18nProvider>
      <Fixture />
    </I18nProvider>
  </WorkbenchConnectionProvider>,
);
