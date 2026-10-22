"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import type { EnabledModelsView } from "../lib/enabled-models";
import {
  enabledModelsBulkActions,
  enabledModelsProviderToggle,
  filterEnabledModels,
  findProviderView,
  isLastEnabledModel,
} from "./enabled-models-helpers";
import { errorText } from "@hepi/protocol/error-text";
import { unsupportedCapability, useCapabilityServed } from "../lib/capability-availability";
import { useApiRequest } from "../lib/api-request";
import { invalidateModelCatalog } from "../lib/models-cache";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";

/**
 * Model switches backed by pi's `enabledModels` setting.
 *
 * Every switch writes through `/api/models/enabled` right away, like the login
 * controls in the same panel and unlike the models.json editor around them,
 * which buffers until Save. Requests are serialized: each one is a
 * read-modify-write of one settings key, so overlapping edits from the same
 * panel could otherwise lose one of them.
 */

/** The route a catalog pass is asked of, and of nothing else: the control's own capability question. */
export const CATALOG_REFRESH_ROUTE = "/api/models/refresh";

/** Shape of `POST /api/models/refresh`, mirroring `CatalogRefreshResult`. */
interface CatalogRefreshResponse {
  completed?: boolean;
  changed?: boolean;
  reason?: "offline" | "runtime";
  error?: string;
}

interface Failure {
  /** Translation key for a known refusal. */
  messageKey?: string;
  /** Raw server text for everything else. */
  message?: string;
}

export interface EnabledModelsController {
  view: EnabledModelsView | null;
  loading: boolean;
  /**
   * True once this deployment's own answer for the setting was "I do not serve it" — HTTP 501 with
   * `code: "unsupported"` — rather than a failure of a route that is served.
   *
   * The panel then says that once, in one neutral sentence, and offers none of the controls that would only reach
   * the same refusal. What it must never do is pass that answer on as an error: the text belongs to the route, not
   * to the reader, and it reads like a fault of the models.json editor that saved successfully right before it.
   */
  unavailable: boolean;
  /** Control currently waiting on the server, or null when idle. */
  pending: string | null;
  failure: Failure | null;
  setModels: (key: string, refs: string[], enabled: boolean) => void;
  setProvider: (providerId: string, enabled: boolean) => void;
  clearScope: () => void;
  pruneStale: () => void;
  /** Re-read after models.json changed under the panel. */
  refresh: () => void;
  /** Re-verify the stored patterns after models.json was saved. */
  resync: (
    renames: { from: string; to: string }[],
    modelRenames: { from: string; to: string }[],
  ) => void;
}

type MutationBody =
  | { op: "models"; refs: string[]; enabled: boolean }
  | { op: "provider"; provider: string; enabled: boolean }
  | { op: "clear" }
  | { op: "prune" }
  | {
      op: "resync";
      renames: { from: string; to: string }[];
      modelRenames: { from: string; to: string }[];
      fullyEnabled: string[];
    };

const FAILURE_KEYS: Record<string, string> = {
  "last-model": "models.enabledLastModel",
  "project-scope": "models.enabledProjectScope",
};

export function useEnabledModels(cwd?: string | null): EnabledModelsController {
  const [view, setView] = useState<EnabledModelsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const pendingRef = useRef<string | null>(null);
  const queuedRef = useRef<{ key: string; body: MutationBody } | null>(null);
  const mutateRef = useRef<((key: string, body: MutationBody) => void) | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  // The setting belongs to the connection this panel is open under, so an App reads and writes it on the Gateway it was
  // admitted to, with that connection's own credential.
  const request = useApiRequest();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    request(`/api/models/enabled${query}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json() as EnabledModelsView & { error?: string };
        // Not served here is not a failure: the setting has no route to read, so there is nothing to report and
        // nothing to retry.
        if (unsupportedCapability(res, data)) {
          setUnavailable(true);
          setView(null);
          setFailure(null);
          return;
        }
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setUnavailable(false);
        setView(data);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure({ message: errorText(error) });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cwd, reloadKey, request]);

  const mutate = useCallback((key: string, body: MutationBody) => {
    // A save can land while a switch is still in flight; queue it rather than
    // dropping it, or the panel keeps describing the previous models.json.
    if (pendingRef.current) {
      queuedRef.current = { key, body };
      return;
    }
    pendingRef.current = key;
    setPending(key);
    setFailure(null);
    void (async () => {
      try {
        const res = await request("/api/models/enabled", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...(cwd ? { cwd } : {}) }),
        });
        const data = await res.json() as EnabledModelsView & { error?: string; reason?: string };
        // A write that reaches no route says the same thing as the read that already said it, so a save landing
        // here leaves the panel as it was rather than blaming the save.
        if (unsupportedCapability(res, data)) {
          setUnavailable(true);
          setFailure(null);
          return;
        }
        if (!res.ok || data.error) {
          const messageKey = data.reason ? FAILURE_KEYS[data.reason] : undefined;
          setFailure(messageKey ? { messageKey } : { message: data.error ?? `HTTP ${res.status}` });
          return;
        }
        setView(data);
        // The setting narrows the catalog every selector reads, so a write that landed changed what the deployment
        // offers — the same fact a `models.json` save or a credential change states, through the same rule. A refusal
        // above returns before this, so a save that did not happen claims no refresh.
        invalidateModelCatalog();
      } catch (error) {
        setFailure({ message: errorText(error) });
      } finally {
        pendingRef.current = null;
        setPending(null);
        const queued = queuedRef.current;
        queuedRef.current = null;
        if (queued) mutateRef.current?.(queued.key, queued.body);
      }
    })();
  }, [cwd, request]);

  mutateRef.current = mutate;

  const setModels = useCallback((key: string, refs: string[], enabled: boolean) => {
    mutate(key, { op: "models", refs, enabled });
  }, [mutate]);

  const setProvider = useCallback((providerId: string, enabled: boolean) => {
    mutate(`provider:${providerId}`, { op: "provider", provider: providerId, enabled });
  }, [mutate]);

  const clearScope = useCallback(() => mutate("clear", { op: "clear" }), [mutate]);
  const pruneStale = useCallback(() => mutate("prune", { op: "prune" }), [mutate]);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);
  // Resync writes and returns the fresh view, so it doubles as the reload
  // models.json needs after a save. The providers that are fully enabled right
  // now are the intent to preserve across whatever the save changed.
  const resync = useCallback((
    renames: { from: string; to: string }[],
    modelRenames: { from: string; to: string }[],
  ) => {
    const fullyEnabled = (view?.providers ?? [])
      .filter((provider) => provider.models.length > 0 && provider.enabledCount === provider.models.length)
      .map((provider) => provider.id);
    mutate("resync", { op: "resync", renames, modelRenames, fullyEnabled });
  }, [mutate, view]);

  return {
    view,
    loading,
    unavailable,
    pending,
    failure,
    setModels,
    setProvider,
    clearScope,
    pruneStale,
    refresh,
    resync,
  };
}

/** Panel-wide note shown while `enabledModels` narrows the selector. */
export function EnabledModelsBanner({ controller }: { controller: EnabledModelsController }) {
  const { t } = useI18n();
  const { view, pending } = controller;
  if (!view) return null;
  const scoped = !view.allEnabled;
  const stale = view.stalePatterns.length;
  if (!scoped && stale === 0) return null;

  return (
    <div className="enabled-models-banner">
      <span
        className="enabled-models-banner-text"
        {...(stale > 0 ? { title: t("models.enabledStaleHint") } : {})}
      >
        {/* Name the setting and the file that holds it: the count alone left
            the user guessing where the panel wrote, and both read the same in
            every language. A long path is what gets cut, never the numbers. */}
        <code className="enabled-models-banner-key" title={view.settingsPath}>
          {view.settingsPath}
        </code>
        <code className="enabled-models-banner-facts">
          {`· enabledModels ${view.enabledTotal}/${view.availableTotal}`}
          {stale > 0 && ` · ${t("models.enabledStale", { count: stale })}`}
        </code>
      </span>
      {view.editable && stale > 0 && (
        <ConfigButton
          size="small"
          onClick={controller.pruneStale}
          disabled={pending !== null}
          title={t("models.enabledPruneHint")}
        >
          {t("models.enabledPrune")}
        </ConfigButton>
      )}
      {view.editable && scoped && (
        <ConfigButton
          size="small"
          onClick={controller.clearScope}
          disabled={pending !== null}
          title={t("models.enabledClearHint")}
        >
          {t("models.enabledClear")}
        </ConfigButton>
      )}
    </div>
  );
}

/**
 * The single switch a models.json provider gets, for its detail header next to
 * the provider's own buttons.
 *
 * Such a provider has no rows of its own — the panel edits its models directly
 * — so this switch is the whole control, and it is checked only while every one
 * of those models is enabled. Why it cannot move is the note under the detail
 * header (`EnabledModelsProviderSwitchNote`), which the switch points at: a
 * tooltip alone never shows on a touch screen.
 */
export function EnabledModelsProviderSwitch({
  providerId,
  controller,
  noteId,
}: {
  providerId: string;
  controller: EnabledModelsController;
  /** The id `EnabledModelsProviderSwitchNote` renders under the header. */
  noteId: string;
}) {
  const { t } = useI18n();
  const { view, loading, unavailable, pending, failure } = controller;
  const provider = findProviderView(view, providerId);
  const message = failure ? (failure.messageKey ? t(failure.messageKey) : failure.message) : null;
  const describedBy = providerSwitchBlockKey(controller, providerId) ? noteId : undefined;

  if (loading && !view) return null;
  // No switch for a setting this deployment does not serve: the note under the header says so once, and a switch
  // that can only be refused is not a control.
  if (unavailable) return null;
  if (!provider) {
    return (
      <ConfigSwitch
        checked={false}
        disabled
        label={t("models.enabledProviderToggle", { provider: providerId })}
        describedBy={describedBy}
        onChange={() => {}}
      />
    );
  }

  const toggle = enabledModelsProviderToggle(view, provider);
  return (
    <>
      {message && <span className="enabled-models-switch-error">{message}</span>}
      <ConfigSwitch
        checked={toggle.checked}
        loading={pending === `provider:${provider.id}`}
        disabled={pending !== null || toggle.blocked}
        label={t("models.enabledProviderToggle", { provider: provider.name })}
        describedBy={describedBy}
        onChange={(checked) => controller.setProvider(provider.id, checked)}
      />
    </>
  );
}

/** Why a models.json provider's switch cannot move, as a message key, or null while it can or is not shown. */
function providerSwitchBlockKey(controller: EnabledModelsController, providerId: string): string | null {
  const { view, loading, unavailable } = controller;
  if (loading && !view) return null;
  // The setting itself is not served here, which is a different sentence from "this provider has no models yet":
  // nothing about the provider, its key or its sign-in is the reason, so none of that is named.
  if (unavailable) return "settings.capabilityUnavailable";
  const provider = findProviderView(view, providerId);
  // Missing from the runtime: edits not saved yet, no models, or a key that
  // does not work — never a sign-in, so do not send the user looking for one.
  if (!provider) return "models.enabledCustomEmpty";
  const { reason } = enabledModelsProviderToggle(view, provider);
  return reason ? FAILURE_KEYS[reason] : null;
}

/** The note under a models.json provider's detail header saying why its switch cannot move. */
export function EnabledModelsProviderSwitchNote({
  providerId,
  controller,
  id,
}: {
  providerId: string;
  controller: EnabledModelsController;
  id: string;
}) {
  const { t } = useI18n();
  const key = providerSwitchBlockKey(controller, providerId);
  return key ? <div id={id} className="config-detail-heading-note">{t(key)}</div> : null;
}

/** Per-model switches for a provider that owns its own model list. */
/**
 * State for the "refresh catalog" button.
 *
 * pi's built-in model lists are frozen at the SDK version pi-web pins, so a
 * model a provider shipped after that release only appears once the pi.dev
 * catalog overlay has been fetched (#914). The button is the whole feature:
 * nothing refreshes catalogs on its own.
 *
 * It is a *catalog* refresh, and so is gated as its own capability: the client ingress answers
 * `POST /api/models/refresh` as the named limit no process owns, because the pass that would fetch a provider's list
 * runs on the host that serves this deployment's models. Reading that answer as a fault — "could not reach the catalog"
 * — would blame the provider's endpoint for a route this deployment never had, and would offer a retry that reaches the
 * same limit. So the button is withheld on the deployment's own `501 unsupported`, and kept while the answer is anything
 * else, including no answer at all.
 *
 * What is *not* a refresh is availability. A provider credential lives on the host, and the Backend resolves which
 * models it authenticates on each read (docs/pi-config.md), so storing or removing a key needs no pass here; the only
 * stale answer is the one this page cached, and that is what a credential change drops.
 */
function useCatalogRefresh(providerId: string, onChanged: () => void) {
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const request = useApiRequest();
  const served = useCapabilityServed(CATALOG_REFRESH_ROUTE);

  // A note describes the provider it was produced for, never the next one.
  useEffect(() => setNote(null), [providerId]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setNote(null);
    void (async () => {
      try {
        const res = await request("/api/models/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: providerId }),
        });
        const data = await res.json() as CatalogRefreshResponse;
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.reason === "offline") setNote("models.catalogOffline");
        else if (!data.completed) setNote("models.catalogUnreachable");
        else setNote(data.changed ? "models.catalogUpdated" : "models.catalogUnchanged");
        // Reload even when nothing moved for this provider: the pass may have
        // updated another one, and a stale panel is worse than a second read.
        if (data.changed) onChanged();
      } catch {
        setNote("models.catalogUnreachable");
      } finally {
        setRefreshing(false);
      }
    })();
  }, [providerId, onChanged, request]);

  return { refreshing, note, refresh, served };
}

export function EnabledModelsSection({
  providerId,
  controller,
}: {
  providerId: string;
  controller: EnabledModelsController;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const { view, loading, pending, failure, unavailable } = controller;
  const provider = findProviderView(view, providerId);
  const catalog = useCatalogRefresh(providerId, controller.refresh);
  const noteId = useId();

  useEffect(() => setQuery(""), [providerId]);

  if (loading && !view) {
    return <div className="enabled-models-empty">{t("agents.modelsLoading")}</div>;
  }
  // One neutral sentence for the whole setting, with no switches, bulk actions or catalog button under it: every
  // one of them writes to the route that refused.
  if (unavailable) {
    return <div className="enabled-models-note">{t("settings.capabilityUnavailable")}</div>;
  }
  if (!provider) {
    return failure?.message
      ? <div className="enabled-models-error">{failure.message}</div>
      : <div className="enabled-models-empty">{t("models.enabledUnavailable")}</div>;
  }

  const shown = filterEnabledModels(provider.models, query);
  const bulk = enabledModelsBulkActions(view, shown);
  const filtered = shown.length !== provider.models.length;
  const busy = pending !== null;
  const bulkKey = `provider:${provider.id}`;
  // Why switches cannot move is visible text they point at: a tooltip never shows on a touch screen.
  const editable = view?.editable === true;
  const scopeNoteId = `${noteId}-scope`;
  const lastModelNoteId = `${noteId}-last`;
  const disableBlockedByLastModel = editable && !bulk.canDisable && bulk.disableRefs.length > 0;
  const showLastModelNote = disableBlockedByLastModel || (editable && shown.some((model) => isLastEnabledModel(view, model)));
  // A provider-wide action is resolved server-side so models the browser has
  // not seen yet follow it too; a filtered action names its rows explicitly.
  const runBulk = (enabled: boolean, refs: string[]) => {
    if (filtered) controller.setModels(bulkKey, refs, enabled);
    else controller.setProvider(provider.id, enabled);
  };

  return (
    <div className="enabled-models-section">
      <div className="enabled-models-header">
        <span className="enabled-models-title">{t("models.enabledSection")}</span>
        <span className="enabled-models-count">
          {t("models.enabledCount", { enabled: provider.enabledCount, total: provider.models.length })}
        </span>
        <ConfigButton
          size="small"
          disabled={busy || !bulk.canEnable}
          aria-describedby={editable ? undefined : scopeNoteId}
          onClick={() => runBulk(true, bulk.enableRefs)}
        >
          {filtered ? t("models.enableShown") : t("models.enableAll")}
        </ConfigButton>
        <ConfigButton
          size="small"
          disabled={busy || !bulk.canDisable}
          aria-describedby={!editable ? scopeNoteId : disableBlockedByLastModel ? lastModelNoteId : undefined}
          onClick={() => runBulk(false, bulk.disableRefs)}
        >
          {filtered ? t("models.disableShown") : t("models.disableAll")}
        </ConfigButton>
        {/* A catalog pass this deployment does not serve is offered as no control at all, the way a sign-in whose route
            answers the limit is: a disabled button would need a sentence, and the sentence is already in the picker's
            rule — this origin's host serves what it serves. */}
        {catalog.served !== false && (
          <ConfigButton
            size="small"
            disabled={busy || catalog.refreshing}
            title={t("models.refreshCatalogHint")}
            onClick={catalog.refresh}
          >
            {catalog.refreshing ? t("models.refreshingCatalog") : t("models.refreshCatalog")}
          </ConfigButton>
        )}
      </div>

      {catalog.note && <div className="enabled-models-note">{t(catalog.note)}</div>}

      {!editable && <div id={scopeNoteId} className="enabled-models-note">{t("models.enabledProjectScope")}</div>}
      {showLastModelNote && <div id={lastModelNoteId} className="enabled-models-note">{t("models.enabledLastModel")}</div>}
      {failure && (
        <div className="enabled-models-error">
          {failure.messageKey ? t(failure.messageKey) : failure.message}
        </div>
      )}

      {provider.models.length > 8 && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("models.enabledFilterPlaceholder", { count: provider.models.length })}
          aria-label={t("models.enabledFilter")}
          className="enabled-models-filter"
        />
      )}
      <div className="enabled-models-list">
        {shown.length === 0 ? (
          <div className="enabled-models-empty">{t("models.enabledNoMatches")}</div>
        ) : shown.map((model) => {
          const lastOne = isLastEnabledModel(view, model);
          return (
            <div key={model.ref} className="enabled-models-row">
              <span className="enabled-models-row-text">
                <span className="enabled-models-row-name">{model.name}</span>
                <code className="enabled-models-row-id">{model.id}</code>
              </span>
              {model.thinkingPin && (
                <span className="enabled-models-pin" title={t("models.enabledPinHint")}>
                  {model.thinkingPin}
                </span>
              )}
              <ConfigSwitch
                checked={model.enabled}
                loading={pending === model.ref}
                disabled={busy || !view?.editable || lastOne}
                label={t("models.enabledToggle", { model: model.name })}
                describedBy={!editable ? scopeNoteId : lastOne ? lastModelNoteId : undefined}
                onChange={(checked) => controller.setModels(model.ref, [model.ref], checked)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
