"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppShell } from "./components/AppShell";
import { ConnectionRecovery, type ConnectionManagement } from "./components/ConnectionRecovery";
import { WebSignIn } from "./components/WebSignIn";
import { I18nProvider } from "./hooks/useI18n";
import { createClient, WorkbenchRequestError } from "./client";
import { connectionIdentityOf, connectionScopeKey, type ConnectionIdentity, type ScopedDescriptor } from "./lib/connection-scope";
import { connectionKeyOf } from "./lib/connection-lifetime";
import { readoutOf, type ConnectionReadout, type DescriptorClient } from "./lib/connection-readout";
import { setDraftScope } from "./lib/draft-store";
import { admissionOf, type Admission } from "./lib/web-session-gate";
import { WorkbenchCapabilitiesProvider, WorkbenchNavigationProvider, type WorkbenchHost, type WorkbenchNavigation } from "./lib/navigation";
import type { FileSaveHost } from "./lib/file/file-save";
import { workbenchConnection, WorkbenchConnectionProvider, type WorkbenchConnection } from "./lib/workbench-scope";

/**
 * What the host states before a connection exists.
 *
 * The workbench is the same tree on both hosts; what differs is stated here and nowhere below. A Web page is served from
 * its own ingress origin and reads its identity from the deployment itself, so it states neither: it is `web`, its
 * origin is empty (the browser's own), and the descriptor it reads is the one its own origin answers. A packaged App was
 * loaded from a bundle, so it states the Gateway it was configured with, the profile that names it, and how it
 * authenticates — facts no surface inside the workbench may invent.
 */
export interface WorkbenchHostConfig {
  readonly host: WorkbenchHost;
  /** The profile this client connected as. Part of the connection scope, so two profiles never share drafts. */
  readonly profile: string;
  /**
   * How this client authenticates against its ingress.
   *
   * A Web page states `cookie` and nothing else: the browser attaches its own httpOnly cookie and no script reads it. An
   * App states the device bearer it holds. Neither is chosen by a surface.
   */
  readonly credential: { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly token: string };
  /** The platform's fetch. Injected because a browser's cookie jar and a shell's TLS are platform facts. */
  readonly fetch?: typeof fetch;
  /**
   * How this host opens one conversation's stream, on the connection it stated.
   *
   * Every host states it, because the stream is the connection's own I/O and the credential is the host's fact: a Web
   * page's stream is a same-origin address with no header (the httpOnly cookie goes by itself), and a packaged App's is
   * its configured Gateway origin with the device bearer — neither can be inferred from the other. A host that stated a
   * Gateway origin and then let the workbench fall back to a same-origin address would open the App's stream against the
   * bundle's own document, which serves no conversation.
   */
  readonly createSource: (credential: WorkbenchHostConfig["credential"], origin: string) => Parameters<typeof createClient>[0]["createSource"];
  /**
   * What this host states about the connection the descriptor read settled on, asked of the host and not of a surface.
   *
   * It is called for the readouts the workbench itself decided — admitted, or refused with its own reason — and never for
   * a connection still being read, because "not yet" is not a fact a host should publish. A Web page passes nothing: its
   * login state is on screen. A packaged App is the host that has no other way to say what its WebView reached, and
   * reports it over its shell's own transport.
   */
  readonly onConnectionReadout?: (readout: ConnectionReadout) => void;
  /**
   * The native save this host performs, when it has one.
   *
   * A Web page states nothing: its download is a navigation the browser performs, and the bytes never enter the page. A
   * packaged App states its shell's save, because a bundle has no download navigation and no element of it can present
   * the device bearer. Stated by the host so that the shared tree names the seam and never imports a platform module.
   */
  readonly save?: FileSaveHost | null;
  /**
   * The host's own connection management, when this host owns the credential.
   *
   * A packaged App is the only host that does: its credential lives in the OS credential store and only its shell can
   * replace or delete it, so a refused App offers those two steps and nothing else could make them. A Web page states
   * nothing here, because its credential is the ingress's cookie and its recovery is the deployment's own login form.
   * Stating it as host configuration is what keeps the surface from offering an action no host can perform.
   */
  readonly connectionManagement?: ConnectionManagement;
}

/** The descriptor as the workbench reads it: the identity the scope keys by, and the client the deployment admitted. */
type ReadDescriptor = ScopedDescriptor & { readonly client?: DescriptorClient };

/**
 * The whole workbench, on either host.
 *
 * It is the composition root and nothing more: it reads the connection descriptor once, builds the one client for that
 * connection, states the scope every store keys by, and renders the shared tree inside it. A descriptor that changes —
 * a different Backend, a different account, a different profile — is a different connection, so the client is disposed,
 * the tree is replaced (the `key` is what makes that a remount rather than a re-render), and the new connection starts
 * from its own empty scope instead of the previous one's drafts, cached views and open conversations.
 *
 * A descriptor that cannot be read is stated as such. The workbench does not guess an identity: a scope invented from a
 * failed read is exactly how one connection's state ends up under another's key.
 */
/** The status a failed connection read stated, when the refusal came from the deployment rather than the transport. */
function statusOf(error: unknown): number | undefined {
  return error instanceof WorkbenchRequestError ? error.status : undefined;
}

export function Workbench({ config: stated, navigation }: { config: WorkbenchHostConfig; navigation: WorkbenchNavigation }) {
  /**
   * The host's configuration, as the newest render stated it.
   *
   * Both hosts state it as an object literal, and the functions in it — the platform's `fetch` and the host's own
   * `createSource` — are written inline, so their identity changes on every render while nothing about the connection
   * did. A lifetime that depended on that identity would dispose and rebuild the connection on every keystroke, and a
   * surface would then send through a client that had already been replaced. What identifies a connection is stated
   * below as values: which host, which ingress origin, which profile, which credential. Those decide the lifetime; the
   * functions are read from the latest render when they are used.
   */
  const config = stated;
  const configRef = useRef(config);
  configRef.current = config;
  const connectionKey = connectionKeyOf(config);
  const [descriptor, setDescriptor] = useState<ReadDescriptor | null>(null);
  const [admission, setAdmission] = useState<Admission | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // The descriptor is the first read of this connection, so it is the connection's own read: same origin, same
    // credential, same refusal handling as every request below the workbench. A page that asked it with a global fetch
    // and then built a client would be answering one connection's identity question with another's transport.
    const probe = createClient({
      origin: config.host.ingressOrigin,
      credential: config.credential,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      createSource: config.createSource(config.credential, config.host.ingressOrigin),
    });
    const settled = probe.readJson<ReadDescriptor>("/api/descriptor", { signal: controller.signal })
      .then(next => ({ kind: "ok" as const, next }))
      .catch(error => ({ kind: "failed" as const, status: statusOf(error) }));
    // The deployment's own login state is asked beside the descriptor and never instead of it: it is a public fact this
    // page needs only to decide whether a refusal has a form to show, so it must not delay an admitted connection.
    const asked = fetch("/api/web-auth", { signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<{ enabled?: unknown }> : null)
      .then(body => typeof body?.enabled === "boolean" ? body.enabled : undefined)
      .catch(() => undefined);
    void Promise.all([settled, asked]).then(([read, enabled]) => {
      if (controller.signal.aborted) return;
      if (read.kind === "ok") { setDescriptor(read.next); setAdmission({ kind: "admitted" }); return; }
      // The refusal is decided by the one function that owns the rule, so this page cannot state a different reason for
      // the same failure than the surface below it would.
      setDescriptor(null);
      setAdmission(admissionOf({ credential: config.credential.kind, read: { kind: "failed", ...(read.status === undefined ? {} : { status: read.status }) }, ...(enabled === undefined ? {} : { loginEnabled: enabled }) }));
    }).finally(() => probe.dispose());
    return () => controller.abort();
  }, [connectionKey, attempt]);

  /** One login attempt on this connection's own origin; the descriptor is re-read because the cookie is new. */
  const signIn = useMemo(() => async (token: string) => {
    const response = await fetch("/api/web-login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    await response.body?.cancel();
    if (response.ok) setAttempt(current => current + 1);
    return { ok: response.ok, status: response.status };
  }, []);

  /**
   * The connection's identity, which is what the tree is keyed by — read during render and creating nothing.
   *
   * A descriptor that names no Backend or no account is not a connection whose state may be keyed at all, so it states
   * no identity rather than inventing a shared scope for one.
   */
  const identity = useMemo<ConnectionIdentity | null>(() => {
    if (descriptor === null) return null;
    try {
      return connectionIdentityOf(configRef.current.profile, descriptor);
    } catch {
      return null;
    }
  }, [connectionKey, descriptor]);
  const scope = identity === null ? null : connectionScopeKey(identity);

  /**
   * What this connection read settled to, as the host is allowed to state it.
   *
   * One value, from the two states the descriptor read decided, so a host cannot report a workbench over a connection the
   * deployment refused, and cannot report anything at all while the read is still in flight.
   */
  const readout = useMemo(
    () => readoutOf({ identity, admission, ...(descriptor === null ? {} : { client: descriptor.client }) }),
    [identity, admission, descriptor],
  );
  useEffect(() => {
    // The callback is read from the newest render rather than depended on: both hosts state their configuration as an
    // object literal, so its identity changes every render and a dependency on it would re-report an unchanged readout.
    if (readout !== null) configRef.current.onConnectionReadout?.(readout);
  }, [readout]);
  // The scope is installed during render rather than in an effect below: effects run from the leaves up, so a composer
  // that waited for one would read its draft under the previous connection's scope — or under none at all on the first
  // mount — and then save that text under this one. Installing it before the tree exists is what makes the first render
  // of every composer a read inside its own connection.
  if (scope !== null) setDraftScope(scope);

  /**
   * The connection's client, created and disposed by **one effect pair**.
   *
   * It is not memoized from render, and that is a correction rather than a style: React's StrictMode (and a replayed
   * effect on any route transition) runs an effect, cleans it up, and runs it again on the same memoized value. A client
   * created during render and disposed by that cleanup would be handed back to the replay already disposed, so the page
   * would render a workbench whose every request answers "the connection this request belonged to is closed" — which is
   * exactly what a first-open send did on both hosts. Creating it in the effect means a replay gets a live client, and
   * the cleanup still owns disposal, so one client lives at a time and a replaced connection releases the previous one's
   * streams and blobs.
   */
  const [connection, setConnection] = useState<WorkbenchConnection | null>(null);
  useEffect(() => {
    if (identity === null || scope === null) { setConnection(null); return; }
    const current = configRef.current;
    const client = createClient({
      origin: current.host.ingressOrigin,
      credential: current.credential,
      ...(current.fetch === undefined ? {} : { fetch: current.fetch }),
      createSource: current.createSource(current.credential, current.host.ingressOrigin),
    });
    // One assembly for one client: the scope, the identity, the file surface and the conversation API all describe this
    // connection, and a replaced connection is a replaced value rather than a patched one.
    setConnection(workbenchConnection(client, identity));
    return () => {
      setConnection((previous) => previous?.client === client ? null : previous);
      client.dispose();
    };
    // The lifetime is the connection's identity, never the object the host happened to render this time.
  }, [connectionKey, identity, scope]);

  /**
   * What this host can do for a surface, as one value.
   *
   * It is a host fact, not a connection fact, so it does not take part in the connection's lifetime: a host states one
   * save host for its whole life, and a surface that read it from a per-render object would restart whatever it owned
   * on every render.
   */
  const save = stated.save ?? null;
  const capabilities = useMemo(() => ({ save }), [save]);
  if (admission?.kind === "refused") {
    return (
      <ConnectionRecovery
        state={admission.state}
        reason={admission.reason}
        {...(config.connectionManagement === undefined ? {} : { management: config.connectionManagement })}
        // A retry is a new descriptor read of the same connection: the connection key is unchanged, so the effect that
        // owns the read is what runs again, and nothing the tree holds is thrown away on a read that may still fail.
        retry={() => setAttempt(current => current + 1)}
      />
    );
  }
  if (admission?.kind === "sign-in") return <WebSignIn submit={signIn} />;
  if (connection === null) return <p style={{ padding: 24 }}>Connecting…</p>;

  return (
    <WorkbenchCapabilitiesProvider value={capabilities}>
      <WorkbenchNavigationProvider value={navigation}>
        <WorkbenchConnectionProvider value={connection}>
          {/* The connection's own scope is the tree's key: a different connection is a different tree, not a re-render
              of the previous one's state. */}
          <I18nProvider key={connection.scope}>
            <AppShell />
          </I18nProvider>
        </WorkbenchConnectionProvider>
      </WorkbenchNavigationProvider>
    </WorkbenchCapabilitiesProvider>
  );
}

export type { WorkbenchHostConfig as WorkbenchConfig, ReactNode, ConnectionReadout };
