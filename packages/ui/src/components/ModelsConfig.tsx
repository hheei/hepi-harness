"use client";

import { useState, useEffect, useCallback, useId, useRef } from "react";
import { useI18n } from "../hooks/useI18n";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "../lib/model-catalog";
import type { DiscoveredModel } from "../lib/model-discovery";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "../lib/settings-navigation";
import { errorText } from "@hepi/protocol/error-text";
import {
  hasModelCostDraftValue,
  modelCostToDraft,
  parseCompleteModelCost,
  savedModelIds,
  serializeHeaderRows,
  setCompatBool,
  trackAddedModels,
  collectModelRenames,
  renameProviderEntry,
  updateHeaderRow,
  type HeaderRow,
  type ModelCostDraft,
  type ModelCostKey,
} from "./models-config-helpers";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";
import {
  EnabledModelsBanner,
  EnabledModelsProviderSwitch,
  EnabledModelsProviderSwitchNote,
  EnabledModelsSection,
  useEnabledModels,
  type EnabledModelsController,
} from "./EnabledModelsSection";
import { invalidateModelCatalog } from "../lib/models-cache";
import { providerBadgeLabel } from "./enabled-models-helpers";
import { OAuthDetail } from "./OAuthDetail";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsageSummary } from "./ProviderUsageSummary";
import { capabilityNoticeKey, useCapabilityServed } from "../lib/capability-availability";
import { useApiRequest } from "../lib/api-request";
import {
  PROVIDER_AUTH_ROUTE,
  providerApiKeyBody,
  providerApiKeyRemoveRoute,
  providerApiKeyRoute,
  providerAuthNotice,
  providerAuthRefusal,
  providerConnection,
  readProviderAuthListing,
  type ProviderAuthNotice,
  type ProviderPanelRow,
} from "../lib/provider/provider-auth";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One provider as the host lists it, and the panel's own word for the two sections it appears in.
 *
 * The names are the panel's existing ones, so a panel on this connection renders what it rendered before; what changed is
 * who answers (`packages/gateway/src/ingress/providers.ts`) and that a row now states the host's credential *file* as well
 * as its resolution — `storedType` and `maskedHint`, which is the only part of a stored key this side ever sees.
 */
type OAuthProvider = ProviderPanelRow;
type ApiKeyProvider = ProviderPanelRow;


interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: unknown };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

type ModelCatalogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; recommendation: ModelCatalogRecommendation; appliedCount: number }
  | { phase: "error"; message: string };

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

function readRememberedSelection(): Selection | null {
  const raw = getLastSettingsSelection("models");
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (selection.type === "provider" && typeof selection.name === "string") {
      return { type: "provider", name: selection.name };
    }
    if (selection.type === "model"
      && typeof selection.providerName === "string"
      && typeof selection.index === "number"
      && Number.isInteger(selection.index)
      && selection.index >= 0) {
      return { type: "model", providerName: selection.providerName, index: selection.index };
    }
    if ((selection.type === "oauth" || selection.type === "apikey")
      && typeof selection.providerId === "string") {
      return { type: selection.type, providerId: selection.providerId };
    }
  } catch {
    // Ignore malformed browser state.
  }
  return null;
}

function customSelectionExists(config: ModelsJson, selection: Selection): boolean {
  if (selection.type === "provider") return Boolean(config.providers?.[selection.name]);
  if (selection.type !== "model") return true;
  return Boolean(config.providers?.[selection.providerName]?.models?.[selection.index]);
}

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
         aria-label={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
         title={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}>
       {!required && <option value="">— {t("i18n.default")} / none —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <ConfigSectionTitle>{children}</ConfigSectionTitle>;
}

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({ name, editingName, provider, onChange, onEditingNameChange, onRename, onDelete, onAddModels, enabledModels }: {
  name: string; editingName: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onEditingNameChange: (n: string) => void;
  onRename: (n: string) => void; onDelete: () => void;
  onAddModels: (models: DiscoveredModel[]) => void; enabledModels: EnabledModelsController;
}) {
  const { t } = useI18n();
  // Discovery is the provider's own route on the deployment this panel is showing, so it is asked of the connection the
  // panel was opened under rather than of the origin the page happens to be served from.
  const request = useApiRequest();
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  // Fetching the provider's own model list is a route this Web origin may not serve; the control is offered only once
  // the route answers, so a deployment without it shows no button whose only possible answer is a refusal — and an
  // answer that never arrived is said to be unconfirmed rather than read as a deployment without the route.
  // The question goes through the workbench's own connection, so an App whose page came from a bundle asks its
  // Gateway rather than resolving the route against an origin it does not have.
  const discoveryServed = useCapabilityServed("/api/models-config/discover");
  const discoveryNotice = capabilityNoticeKey(discoveryServed, "models.discoveryUnavailable");
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const discoveryRequestIdRef = useRef(0);
  const selectShownRef = useRef<HTMLInputElement>(null);
  const switchNoteId = useId();
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    discoveryRequestIdRef.current += 1;
    setDiscoveryState({ phase: "idle" });
    setDiscoveryQuery("");
    setSelectedModelIds([]);
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const handleDiscoverModels = useCallback(async () => {
    if (discoveryState.phase === "loading") return;
    const requestId = ++discoveryRequestIdRef.current;
    setDiscoveryState({ phase: "loading" });
    setSelectedModelIds([]);
    try {
      const res = await request("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider: { ...provider, models: undefined } }),
      });
      const data = await res.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (requestId !== discoveryRequestIdRef.current) return;
      if (!res.ok || data.error || !data.models) {
        setDiscoveryState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setDiscoveryState({ phase: "success", models: data.models, endpoint: data.endpoint ?? provider.baseUrl ?? "" });
    } catch (error) {
      if (requestId !== discoveryRequestIdRef.current) return;
      setDiscoveryState({ phase: "error", message: errorText(error) });
    }
  }, [discoveryState.phase, name, provider, request]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discoveredModels = discoveryState.phase === "success" ? discoveryState.models : [];
  const normalizedDiscoveryQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filteredDiscoveredModels = discoveredModels.filter((model) => !normalizedDiscoveryQuery
    || model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedDiscoveryQuery));
  const shownDiscoveredModels = filteredDiscoveredModels.slice(0, 300);
  const selectableShownIds = shownDiscoveredModels
    .filter((model) => !existingModelIds.has(model.id))
    .map((model) => model.id);
  const selectedCount = selectedModelIds.filter((id) => !existingModelIds.has(id)).length;
  const allShownSelected = selectableShownIds.length > 0
    && selectableShownIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected
    && selectableShownIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleDiscoveredModel = (id: string) => {
    setSelectedModelIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const toggleShownModels = () => {
    const shownIds = new Set(selectableShownIds);
    setSelectedModelIds((current) => allShownSelected
      ? current.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...current, ...selectableShownIds])));
  };

  const addSelectedModels = () => {
    if (discoveryState.phase !== "success") return;
    const selected = new Set(selectedModelIds);
    const additions = discoveryState.models.filter((model) => selected.has(model.id) && !existingModelIds.has(model.id));
    if (additions.length === 0) return;
    onAddModels(additions);
    setSelectedModelIds([]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="config-detail-heading">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <SectionTitle>{t("i18n.provider")}</SectionTitle>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <EnabledModelsProviderSwitch providerId={name} controller={enabledModels} noteId={switchNoteId} />
            <ConfigButton variant="danger" size="small" onClick={onDelete}>{t("i18n.delete")}</ConfigButton>
          </ConfigDetailActions>
        </ConfigDetailHeader>
        <EnabledModelsProviderSwitchNote providerId={name} controller={enabledModels} id={switchNoteId} />
      </div>

       <Field label={t("i18n.providerName")}>
        <TextInput value={editingName} onChange={onEditingNameChange} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "var(--accent-contrast)", cursor: "pointer", fontSize: 11, alignSelf: "flex-start" }}>
             {t("i18n.rename")}
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Leave empty for a built-in provider to use the endpoint pi ships
        </span>
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder="ENV_VAR_NAME, !shell-command, or literal key" mono />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Prefix with <code style={{ fontFamily: "var(--font-mono)" }}>!</code> to run a shell command, or use an env var name
        </span>
      </Field>

      <Field label="API">
        <Select value={provider.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <Field label="Headers">
        <HeaderListEditor
          headers={provider.headers}
          onChange={(headers) => set("headers", headers)}
        />
        <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          Added to every request from this provider (e.g. User-Agent). Useful for gateways with bot detection.
        </span>
      </Field>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {discoveryNotice && (
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
            {t(discoveryNotice)}
          </p>
        )}

        {discoveryServed === true && discoveryState.phase !== "success" && (
          <button
            onClick={handleDiscoverModels}
            disabled={discoveryState.phase === "loading"}
            style={{
              alignSelf: "flex-start", height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)", color: discoveryState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: discoveryState.phase === "loading" ? "not-allowed" : "pointer", fontSize: 11,
            }}
          >
            {discoveryState.phase === "loading" ? t("models.discoveryFetching") : t("models.discoveryFetch")}
          </button>
        )}

        {discoveryState.phase === "error" && (
          <div style={{ padding: "7px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 5, color: "#ef4444", fontSize: 11, lineHeight: 1.4 }}>
            {discoveryState.message}
          </div>
        )}

        {discoveryState.phase === "success" && (
          <>
            <input
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder={t("models.discoveryFilterPlaceholder", { count: discoveryState.models.length })}
              aria-label={t("models.discoveryFilter")}
              style={{ ...inputStyle, width: "100%", minWidth: 0 }}
            />

            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
              <label
                style={{
                  minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8,
                  position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid var(--border)",
                  background: "var(--bg)", cursor: selectableShownIds.length ? "pointer" : "default",
                  color: "var(--text-muted)", fontSize: 10, fontWeight: 600,
                }}
              >
                <input
                  ref={selectShownRef}
                  type="checkbox"
                  checked={allShownSelected}
                  disabled={selectableShownIds.length === 0}
                  onChange={toggleShownModels}
                  style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                />
                {t("models.discoverySelectShown")}
              </label>
              {shownDiscoveredModels.length === 0 ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11 }}>{t("models.discoveryNoMatches")}</div>
              ) : shownDiscoveredModels.map((model, index) => {
                const alreadyAdded = existingModelIds.has(model.id);
                const checked = selectedModelIds.includes(model.id);
                return (
                  <label
                    key={model.id}
                    style={{
                      minHeight: 36, padding: "6px 9px", display: "flex", alignItems: "center", gap: 8,
                      borderTop: index === 0 ? "none" : "1px solid var(--border)", cursor: alreadyAdded ? "default" : "pointer",
                      opacity: alreadyAdded ? 0.65 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked || alreadyAdded}
                      disabled={alreadyAdded}
                      onChange={() => toggleDiscoveredModel(model.id)}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11 }}>{model.name ?? model.id}</span>
                      {model.name && <code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{model.id}</code>}
                    </span>
                    {alreadyAdded && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("models.discoveryAdded")}</span>}
                  </label>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span title={discoveryState.endpoint} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>
                {filteredDiscoveredModels.length > shownDiscoveredModels.length
                  ? t("models.discoveryShowing", { shown: shownDiscoveredModels.length, total: filteredDiscoveredModels.length })
                  : t("models.discoveryFetched", { count: discoveryState.models.length })}
              </span>
              <button
                onClick={addSelectedModels}
                disabled={selectedCount === 0}
                style={{ height: 28, padding: "0 11px", border: "none", borderRadius: 5, background: selectedCount ? "var(--accent)" : "var(--bg-panel)", color: selectedCount ? "var(--accent-contrast)" : "var(--text-dim)", cursor: selectedCount ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {selectedCount
                  ? t("models.discoveryAddSelectedCount", { count: selectedCount })
                  : t("models.discoveryAddSelected")}
              </button>
            </div>
          </>
        )}
      </div>

    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
  max:     "#ef4444",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                Default
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                Disabled
              </button>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color 0.1s" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                Custom
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

// Compat can be configured at the provider or model level; provider-composer
// merges them (model wins) at runtime. The UI reads the effective value so
// hand-edited models.json settings are reflected correctly, while toggles
// write to the model entry so a per-model override is explicit.
function effectiveCompat(provider: ProviderEntry, model: ModelEntry): Record<string, unknown> {
  return { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
}

// Editable key/value request-header list for a provider or model. Rows stay
// local so a blank draft is never persisted as an invalid HTTP header name.
function HeaderListEditor({ headers, onChange }: {
  headers: Record<string, string> | undefined;
  onChange: (h: Record<string, string> | undefined) => void;
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers ?? {}).map(
    ([name, value], id) => ({ id, name, value }),
  ));
  const nextRowIdRef = useRef(rows.length);

  const applyRows = (next: HeaderRow[]): void => {
    setRows(next);
    onChange(serializeHeaderRows(next));
  };
  const setEntry = (id: number, changes: Partial<Pick<HeaderRow, "name" | "value">>): void => {
    applyRows(updateHeaderRow(rows, id, changes));
  };
  const removeEntry = (id: number): void => {
    applyRows(rows.filter((row) => row.id !== id));
  };
  const rowBtnStyle = {
    padding: "6px 9px",
    background: "none",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 4,
    color: "#ef4444",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1,
  } satisfies React.CSSProperties;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", gap: 6 }}>
          <input value={row.name} onChange={(e) => setEntry(row.id, { name: e.target.value })}
            placeholder="Header-Name" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <input value={row.value} onChange={(e) => setEntry(row.id, { value: e.target.value })}
            placeholder="value" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <button onClick={() => removeEntry(row.id)} style={rowBtnStyle}>✕</button>
        </div>
      ))}
      <button onClick={() => setRows((current) => [
        ...current,
        { id: nextRowIdRef.current++, name: "", value: "" },
      ])}
        style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, alignSelf: "flex-start" }}>
        + Add header
      </button>
    </div>
  );
}

function fillEmptyModelFields(
  model: ModelEntry,
  preset: ModelCatalogPreset,
): { model: ModelEntry; appliedCount: number } {
  const next = { ...model };
  let appliedCount = 0;
  if (!model.name?.trim() && preset.name) {
    next.name = preset.name;
    appliedCount += 1;
  }
  if (model.reasoning === undefined && preset.reasoning === true) {
    next.reasoning = true;
    appliedCount += 1;
  }
  if (!model.input?.length && preset.input?.length) {
    next.input = [...preset.input];
    appliedCount += 1;
  }
  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
  if (model.maxTokens === undefined && preset.maxTokens !== undefined) {
    next.maxTokens = preset.maxTokens;
    appliedCount += 1;
  }

  if (preset.cost) {
    const cost = { ...(model.cost ?? {}) };
    let filledCostCount = 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (cost[key] === undefined && preset.cost[key] !== undefined) {
        cost[key] = preset.cost[key];
        filledCostCount += 1;
      }
    }
    const completeCost = parseCompleteModelCost(modelCostToDraft(cost));
    if (filledCostCount > 0 && completeCost) {
      next.cost = { ...cost, ...completeCost };
      appliedCount += filledCostCount;
    }
  }
  return { model: next, appliedCount };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const { t } = useI18n();
  const request = useApiRequest();
  const [catalogState, setCatalogState] = useState<ModelCatalogState>({ phase: "idle" });
  // The connection test and the catalog fill are two more routes this Web origin may not serve; each control is
  // offered only when its own route answers, so neither can be clicked into a refusal.
  const testServed = useCapabilityServed("/api/models-config/test");
  const catalogServed = useCapabilityServed("/api/models-config/catalog");
  const testNotice = capabilityNoticeKey(testServed, "models.testUnavailable");
  const catalogNotice = capabilityNoticeKey(catalogServed, "models.catalogUnavailable");
  const [costEditing, setCostEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<ModelCostDraft>(() => modelCostToDraft(model.cost));
  const costDraftRef = useRef(costDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  const costTemplateRef = useRef(model.cost);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const setCost = (key: ModelCostKey, value: string) => {
    const nextDraft = { ...costDraftRef.current, [key]: value };
    const completeCost = parseCompleteModelCost(nextDraft);
    const nextModel = { ...model };
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    if (completeCost) {
      nextModel.cost = { ...(costTemplateRef.current ?? {}), ...completeCost };
      costTemplateRef.current = nextModel.cost;
    } else {
      delete nextModel.cost;
    }
    onChange(nextModel);
  };
  const toggleCostEditing = () => {
    if (costEditing) {
      setCostEditing(false);
      return;
    }
    costTemplateRef.current = model.cost;
    const nextDraft = modelCostToDraft(model.cost);
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    setCostEditing(true);
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
     if (testState.phase === "testing") return t("i18n.testingModel");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
       return [t("i18n.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
     return [t("i18n.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, provider.baseUrl, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await request("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: errorText(e) });
    }
  }, [model, provider, providerName, request, testState.phase]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (provider.baseUrl?.trim()) params.set("baseUrl", provider.baseUrl.trim());
      const res = await request(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const filled = fillEmptyModelFields(model, data.recommendation.preset);
      if (filled.appliedCount > 0) {
        catalogUndoRef.current = model;
        onChange(filled.model);
      }
      setCostEditing(false);
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.appliedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: errorText(error) });
    }
  }, [catalogState.phase, model, onChange, provider.baseUrl, providerName, request]);

  const undoCatalogFill = () => {
    const previous = catalogUndoRef.current;
    if (!previous) return;
    catalogUndoRef.current = null;
    onChange(previous);
    setCatalogState({ phase: "idle" });
  };

  const catalogResultSummary = (() => {
    if (catalogState.phase !== "success") return null;
    const { recommendation, appliedCount } = catalogState;
    const applied = appliedCount > 0
      ? t("models.catalogFilled", { count: appliedCount })
      : t("models.catalogNoEmptyFields");
    if (recommendation.price.status === "unreliable") {
      const price = recommendation.price.reason === "no-exact-match"
        ? t("models.catalogNoExactMatch")
        : t("models.catalogPriceUnreliable");
      return `${applied} · ${price}`;
    }
    const price = recommendation.price.method === "provider"
      ? t("models.catalogPriceProvider", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
      : recommendation.price.method === "base-url"
        ? t("models.catalogPriceBaseUrl", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
        : t("models.catalogPriceConsensus", {
            support: recommendation.price.support,
            total: recommendation.price.total,
          });
    return `${applied} · ${price}`;
  })();
  const catalogStatusText = catalogState.phase === "error"
    ? catalogState.message
    : catalogResultSummary;
  const catalogStatusColor = catalogState.phase === "error"
    ? "#ef4444"
    : catalogState.phase === "success" && catalogState.recommendation.price.status === "unreliable"
      ? "#d97706"
      : "var(--text-dim)";
  const costFields = [
    { key: "input", label: t("models.costInput") },
    { key: "output", label: t("models.costOutput") },
    { key: "cacheRead", label: t("models.costCacheRead") },
    { key: "cacheWrite", label: t("models.costCacheWrite") },
  ] as const;
  const formatCost = (key: ModelCostKey): string => {
    const value = model.cost?.[key];
    return value === undefined ? t("models.notProvided") : `$${String(value)}`;
  };
  const remainingCompatKeys = new Set(Object.keys(model.compat ?? {}));
  let compatibilityOverrideCount = 0;
  if (hasDeepseekCompat(model)) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("thinkingFormat");
    remainingCompatKeys.delete("requiresReasoningContentOnAssistantMessages");
  }
  if (Object.prototype.hasOwnProperty.call(model.compat ?? {}, "supportsDeveloperRole")) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("supportsDeveloperRole");
  }
  compatibilityOverrideCount += remainingCompatKeys.size;
  const advancedSummaryParts = [
    model.api ? `API: ${model.api}` : null,
    Object.keys(model.headers ?? {}).length
      ? t("models.headersSummary", { count: Object.keys(model.headers ?? {}).length })
      : null,
    compatibilityOverrideCount
      ? t("models.compatSummary", { count: compatibilityOverrideCount })
      : null,
    Object.keys(model.thinkingLevelMap ?? {}).length
      ? t("models.thinkingSummary", { count: Object.keys(model.thinkingLevelMap ?? {}).length })
      : null,
  ].filter((part): part is string => Boolean(part));
  const advancedSummary = advancedSummaryParts.length
    ? advancedSummaryParts.join(" · ")
    : t("models.providerDefaults");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.model")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          {testServed === true && testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 28,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          {testServed === true && (
            <ConfigButton
              size="small"
              variant={testState.phase === "success" ? "primary" : "secondary"}
              onClick={testState.phase === "success" ? () => setTestState({ phase: "idle" }) : handleTest}
              disabled={!model.id.trim() || testState.phase === "testing"}
              title={t("i18n.testConnection")}
              className={testState.phase === "success" ? "is-success" : undefined}
            >
              {testState.phase === "success" && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
               {testState.phase === "testing" ? t("i18n.checking") : testState.phase === "success" ? t("common.ok") : t("i18n.test")}
            </ConfigButton>
          )}
          <ConfigButton variant="danger" size="small" onClick={onDelete}>{t("i18n.remove")}</ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {testNotice && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
          {t(testNotice)}
        </p>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label="Name"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder="Display name" /></Field>
      </div>

      <div style={{ padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {catalogNotice && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.5 }}>
              {t(catalogNotice)}
            </span>
          )}
          {catalogServed === true && (
            <button
              onClick={() => void handleCatalogFill()}
              disabled={!model.id.trim() || catalogState.phase === "loading"}
              style={{
                height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5,
                background: "var(--bg-panel)",
                color: !model.id.trim() || catalogState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
                cursor: !model.id.trim() || catalogState.phase === "loading" ? "not-allowed" : "pointer",
                fontSize: 11,
              }}
            >
              {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFill")}
            </button>
          )}
          <a
            href="https://github.com/anomalyco/models.dev"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, textDecoration: "none" }}
          >
            {t("models.catalogSource")}
          </a>
        </div>

        {catalogStatusText && (
          <div
            aria-live="polite"
            style={{
              marginTop: 8, display: "flex", alignItems: "center",
              justifyContent: "space-between", gap: 8, color: catalogStatusColor, fontSize: 10,
            }}
          >
            <span
              title={catalogStatusText}
              style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {catalogStatusText}
            </span>
            {catalogUndoRef.current && (
              <button
                onClick={undoCatalogFill}
                style={{ flexShrink: 0, padding: "0 2px", border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
              >
                {t("models.catalogUndo")}
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        <SectionTitle>{t("models.capabilities")}</SectionTitle>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 8 }}>
          <Check label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
          <Check label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
        </div>
      </div>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SectionTitle>{t("models.modelSpecs")}</SectionTitle>
          <button
            type="button"
            onClick={toggleCostEditing}
            aria-expanded={costEditing}
            style={{ padding: "2px 4px", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
          >
            {costEditing ? t("models.finishEditingCosts") : t("models.editCosts")}
          </button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          <Field label={t("models.contextWindow")}>
            <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
          </Field>
          <Field label={t("models.maxOutputTokens")}>
            <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>
            {t("models.costPerMillion")}
          </div>
          {costEditing ? (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
              {costFields.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <NumInput value={costDraft[key]} onChange={(v) => setCost(key, v)} placeholder="0" />
                </Field>
              ))}
              {hasModelCostDraftValue(costDraft) && !parseCompleteModelCost(costDraft) && (
                <div aria-live="polite" style={{ gridColumn: "1 / -1", color: "#d97706", fontSize: 10 }}>
                  {t("models.costAllRequired")}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))", gap: "8px 16px" }}>
              {costFields.map(({ key, label }) => {
                const missing = model.cost?.[key] === undefined;
                return (
                  <div key={key} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                    <div style={{ marginTop: 3, color: missing ? "var(--text-dim)" : "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                      {formatCost(key)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section style={{ borderTop: "1px solid var(--border)", paddingTop: 4 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="model-advanced-settings"
          style={{
            width: "100%", minHeight: 48, padding: "8px 0", border: "none", background: "transparent",
            display: "grid", gridTemplateColumns: "minmax(0, 1fr) 18px", alignItems: "center", gap: 10,
            color: "var(--text)", cursor: "pointer", textAlign: "left",
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600 }}>{t("models.advancedSettings")}</span>
            <span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {advancedSummary}
            </span>
          </span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: "var(--text-dim)", transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {advancedOpen && (
          <div id="model-advanced-settings" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 16px" }}>
            <Field label={t("models.apiOverride")}>
              <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
            </Field>

            <Field label={t("models.headers")}>
              <HeaderListEditor
                headers={model.headers}
                onChange={(headers) => set("headers", headers)}
              />
              <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                {t("models.headersHelp")}
              </span>
            </Field>

            {model.reasoning && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SectionTitle>{t("models.compatibility")}</SectionTitle>
                <Check
                  label={t("models.deepSeekThinkingCompat")}
                  checked={hasDeepseekCompat(model)}
                  onChange={(v) => onChange(setDeepseekCompat(model, v))}
                />
                <Check
                  label={t("models.developerRole")}
                  checked={effectiveCompat(provider, model)["supportsDeveloperRole"] !== false}
                  onChange={(v) => onChange(setCompatBool(model, "supportsDeveloperRole", v))}
                />
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                    <SectionTitle>{t("models.thinkingLevelMap")}</SectionTitle>
                    {model.thinkingLevelMap && (
                      <button
                        type="button"
                        onClick={() => set("thinkingLevelMap", undefined)}
                        style={{ fontSize: 10, padding: "2px 5px", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
                      >
                        {t("models.clearAll")}
                      </button>
                    )}
                  </div>
                  <ThinkingLevelMapEditor
                    value={model.thinkingLevelMap}
                    onChange={(v) => set("thinkingLevelMap", v)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}



// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh, enabledModels }: {
  provider: ApiKeyProvider; onRefresh: () => void; enabledModels: EnabledModelsController;
}) {
  // The typed key lives here and nowhere else: it is read into one request body, cleared the moment that body has been
  // sent, and never written to browser storage or rendered back after a save. What the host stores is shown only as the
  // hint it masked on its own machine.
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const { t } = useI18n();
  const request = useApiRequest();
  const connection = providerConnection(provider);

  /**
   * One answer of this surface, told to the person in the words their next action needs.
   *
   * The host's refusal is a stable code, so a retryable one — another writer holds `auth.json`, the host could not be
   * reached, the credential turned out to be a different kind than this listing said — reads as "ask again", and one that
   * cannot be fixed by asking again names whose state it is. The host's own sentence is kept as the detail: it is fixed
   * text that never carries a credential, and "an error occurred" would throw the reason away.
   */
  const report = useCallback(async (res: Response) => {
    const body = await res.json().catch(() => null);
    const refusal = providerAuthRefusal({ status: res.status }, body);
    if (refusal === undefined) return null;
    const detail = refusal.detail === "" ? "" : " " + refusal.detail;
    return (refusal.key === undefined ? "" : t(refusal.key)) + detail;
  }, [t]);

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await request(providerApiKeyRoute(provider.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: providerApiKeyBody(key),
      });
      // The typed value is dropped whether or not the write worked: a retry re-types it, and nothing on this side holds
      // a key that the host has not confirmed storing.
      setApiKey("");
      const message = await report(res);
      if (message !== null) {
        setError(message);
      } else {
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        // The host answered the listing after the write, so the panel reads the state that really holds rather than
        // assuming a save did what it asked.
        onRefresh();
      }
    } catch (e) {
      setApiKey("");
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, onRefresh, provider.id, report, request]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      // The guard is the type this listing said the host held, so a credential that was replaced by a different method
      // elsewhere is refused rather than deleted by a panel that has not re-read yet.
      const res = await request(providerApiKeyRemoveRoute(provider.id, connection?.storedType), { method: "DELETE" });
      const message = await report(res);
      if (message !== null) setError(message);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [connection?.storedType, onRefresh, provider.id, report, request]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>API Key</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
               {provider.configured ? t("i18n.configured") : t("i18n.notConfigured")}
            </span>
          </div>
          {/* Disconnect is offered for a credential this host actually stores, and not for a provider the host
              authenticates from its own environment: no write here reaches that key, so the button would claim an
              effect it could not have. */}
          {connection?.removable && (
            <ConfigButton
              variant="danger"
              size="small"
              onClick={handleRemove}
              disabled={removing}
            >
               {removing ? t("i18n.removing") : t("i18n.disconnect")}
            </ConfigButton>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {/* What the host stores, in the only form it ever leaves the host in. */}
      {connection?.maskedHint !== undefined && (
        <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {t("models.providerAuth.stored", { hint: connection.maskedHint })}
        </p>
      )}
      {connection?.noteKey !== undefined && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>{t(connection.noteKey)}</p>
      )}
      {!provider.configured && connection?.canEnterKey && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {t("models.providerAuth.enterKey", { name: provider.displayName })}
        </p>
      )}

      {/* A key field is offered only to a provider whose definitions this host can read a key from; a record it holds for
          some other method is shown and disconnected above, never overwritten with a value nothing would resolve. */}
      {connection?.canEnterKey && (
      <div style={{ display: "flex", gap: 6 }}>
        <SecretTextInput
          value={apiKey}
          onChange={setApiKey}
          onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
          placeholder={provider.configured ? "Enter new key to replace…" : "sk-…"}
          style={{ flex: 1 }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim() || savedOk}
          style={{
            padding: "6px 12px",
            background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
            border: "none", borderRadius: 5,
            color: savedOk ? "#fff" : apiKey.trim() ? "var(--accent-contrast)" : "var(--text-dim)",
            cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600, flexShrink: 0,
            display: "flex", alignItems: "center", gap: 5,
          }}
        >
          {savedOk && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
           {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
        </button>
      </div>
      )}

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

      <ProviderUsageSummary providerId={provider.id} enabled={provider.configured} />

      {provider.configured && <EnabledModelsSection providerId={provider.id} controller={enabledModels} />}
    </div>
  );
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  /**
   * Whether this Web origin serves provider sign-in and API-key routes: `null` while the answer is not in yet or
   * never arrived, and `false` for a host that answered that it serves none. Either way the picker says which,
   * and lists the configured providers either way.
   */
  providerAuthServed: boolean | null;
  oauthProviders: readonly OAuthProvider[];
  apiKeyProviders: readonly ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  providerAuthServed, oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const [search, setSearch] = useState("");
  const { t } = useI18n();
  const providerAuthNotice = capabilityNoticeKey(providerAuthServed, "models.providerAuthUnavailable");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q)));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };



  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Search */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
             placeholder={t("i18n.searchProviders")}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {providerAuthNotice && (
            <div style={{ padding: "0 0 12px", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              {t(providerAuthNotice)}
            </div>
          )}
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.noProviders")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                 <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.custom")}</div>
              )}
              {showCustom && (
                <button
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>OpenAI / Anthropic compatible</div>
                     <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("i18n.customEndpoint")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                 <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>API Key</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>API Key</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose, embedded = false, cwd = null }: {
  onClose: () => void; embedded?: boolean; cwd?: string | null;
}) {
  const { t } = useI18n();
  // The models file and the provider list are the deployment's own state, so every read and write below goes through the
  // connection this panel was opened under: an App asks its Gateway origin with its own credential.
  const request = useApiRequest();
  // `enabledModels` lives in pi's settings, not models.json, so these switches
  // apply immediately instead of waiting for this panel's Save button.
  const enabledModels = useEnabledModels(cwd);
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Set when models.json could not be read. Saving stays disabled: the draft
  // would not contain the file's providers, and a save replaces the whole file.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(readRememberedSelection);
  const [oauthProviders, setOauthProviders] = useState<readonly OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<readonly ApiKeyProvider[]>([]);
  /**
   * Why the provider listing is not on screen right now, as a message key or the host's own sentence.
   *
   * It is separate from the capability gate because it is a different claim: the gate is what this deployment serves, this
   * is whether this read arrived. A host that could not be reached or whose file another writer holds keeps its providers on
   * screen and says so; a deployment that serves no provider host is the gate's answer, and says nothing here.
   */
  const [providerAuthFault, setProviderAuthFault] = useState<ProviderAuthNotice | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Provider sign-in and API keys are routes of their own (GET /api/auth/providers, /api/auth/login/<id>,
  // /api/auth/api-key/<id>), separate from the models.json editor: a Web origin that serves none names that in the
  // picker instead of listing no subscription at all, and one whose answer never arrived says so instead.
  const providerAuthServed = useCapabilityServed(PROVIDER_AUTH_ROUTE);
  /** Provider ids as models.json has them on disk, and where renames moved them. */
  const savedProvidersRef = useRef<Set<string>>(new Set());
  const renamesRef = useRef<Map<string, string>>(new Map());
  /**
   * Per provider, the model id saved at each slot, or null for a model added
   * since. Mirroring the draft's array moves is what lets a save tell a rename
   * from an unrelated edit without guessing.
   */
  const savedModelIdsRef = useRef<Map<string, (string | null)[]>>(new Map());
  /**
   * The provider name field while it differs from the provider's id. Save
   * applies it like every other visible edit; Rename applies it right away.
   */
  const [providerNameDraft, setProviderNameDraft] = useState<{ provider: string; name: string } | null>(null);

  /**
   * Re-read the host's own listing, and say what came back.
   *
   * Three outcomes, because they are three different facts to a person: the listing arrived, this deployment stated that
   * it serves no provider host (`501 unsupported`, which the capability gate above reads the same way), or the answer never
   * arrived / the host could not serve it, which is a fault the panel shows and re-asks rather than a limit it hides.
   * A listing that read fine before a failed refresh is kept — a lost request does not make this host unconfigured — and the
   * notice names what could not be confirmed.
   */
  const refreshAuthProviders = useCallback(() => {
    request(PROVIDER_AUTH_ROUTE)
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
      .then(({ status, body }) => {
        const refusal = providerAuthRefusal({ status }, body);
        if (refusal !== undefined) {
          setProviderAuthFault(refusal);
          // A deployment that states this limit is not a fault to retry against: the capability gate says the same thing
          // in the picker, and the listing is honestly empty. Anything else is a read that did not produce a listing, so
          // the last one the panel really read stays on screen with this notice above it.
          if (status === 501) setProviderAuthFault(null);
          return;
        }
        const sections = readProviderAuthListing(body);
        if (sections === undefined) {
          setProviderAuthFault({ retry: false, detail: "" });
          return;
        }
        setProviderAuthFault(null);
        setOauthProviders(sections.oauthProviders);
        setApiKeyProviders(sections.apiKeyProviders);
      })
      .catch(() => setProviderAuthFault(providerAuthNotice("provider_auth_unreachable")))
  }, [request]);

  /**
   * A credential of this host's file just changed, so say what the listing now holds and drop what this page cached from
   * the models that credential decided.
   *
   * Both halves are needed and neither reaches the other on its own. The listing is this surface's own state, re-read
   * here; the model catalog belongs to the composer, which reads it through the Backend and holds the answer for a
   * minute. The Backend resolves availability from `auth.json` afresh on each of its own reads (see
   * docs/pi-config.md), so a stored or removed key needs no signal sent to it — only this page's cached answer to the
   * question it already asked. A panel that stored a subscription and left that entry in place would be the one thing
   * a person can see as wrong: signed in, still offered nothing.
   */
  const credentialChanged = useCallback(() => {
    invalidateModelCatalog();
    refreshAuthProviders();
  }, [refreshAuthProviders]);

  /**
   * Read `models.json` as the file holds it, and say so.
   *
   * It is the panel's one read of that file, used by the mount and by the readback a write that the runtime could not
   * apply owes: that answer means the file changed and the running backend did not, so what the panel shows from then
   * on has to be the file's own content rather than the draft it sent. A draft that is not the file's is exactly what a
   * person would otherwise edit on top of a write whose effect nobody confirmed.
   */
  const readConfig = useCallback(() => request("/api/models-config")
    .then(async (r) => {
      const d = await r.json() as ModelsJson & { error?: string };
      if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d;
    })
    .then((d) => {
      const normalized = d.providers ? d : { ...d, providers: {} };
      setConfig(normalized);
      savedProvidersRef.current = new Set(Object.keys(normalized.providers ?? {}));
      savedModelIdsRef.current = savedModelIds(normalized);
      const keys = Object.keys(normalized.providers ?? {});
      setSelection((current) => current && customSelectionExists(normalized, current)
        ? current
        : keys[0]
          ? { type: "provider", name: keys[0] }
          : null);
    })
    .catch((e: unknown) => setLoadError(errorText(e))), [request]);

  useEffect(() => {
    readConfig().finally(() => setLoading(false));
    refreshAuthProviders();
  }, [readConfig, refreshAuthProviders]);

  useEffect(() => {
    if (selection) setLastSettingsSelection("models", JSON.stringify(selection));
  }, [selection]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  /** Moves a provider in `draft`; returns the moved config, or null when the id is taken. */
  const applyProviderRename = useCallback((draft: ModelsJson, oldName: string, newName: string): ModelsJson | null => {
    // Remember where each saved provider ended up, so the enabledModels entries
    // can follow it on save instead of pointing at an id that no longer exists.
    const next = renameProviderEntry(draft, {
      savedProviders: savedProvidersRef.current,
      renames: renamesRef.current,
      slots: savedModelIdsRef.current,
    }, oldName, newName);
    if (!next) return null;
    setConfig(next);
    setProviderNameDraft(null);
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
    return next;
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    if (applyProviderRename(config, oldName, newName)) setSaveError(null);
    else setSaveError(t("models.providerNameTaken", { name: newName }));
  }, [applyProviderRename, config, t]);

  const deleteProvider = useCallback((name: string) => {
    savedModelIdsRef.current.delete(name);
    setProviderNameDraft((prev) => prev?.provider === name ? null : prev);
    setConfig((prev) => {
      const providers = { ...(prev.providers ?? {}) };
      delete providers[name];
      return { ...prev, providers };
    });
    setConfig((prev) => {
      const remaining = Object.keys(prev.providers ?? {});
      setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
      return prev;
    });
  }, []);

  const addModel = useCallback((providerName: string) => {
    trackAddedModels(savedModelIdsRef.current, providerName, 1);
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const addDiscoveredModels = useCallback((providerName: string, discovered: DiscoveredModel[]) => {
    setConfig((prev) => {
      const known = new Set((prev.providers?.[providerName]?.models ?? []).map((model) => model.id));
      trackAddedModels(
        savedModelIdsRef.current,
        providerName,
        discovered.filter((model) => !known.has(model.id)).length,
      );
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existingIds = new Set(models.map((model) => model.id));
      for (const discoveredModel of discovered) {
        if (existingIds.has(discoveredModel.id)) continue;
        existingIds.add(discoveredModel.id);
        models.push({ id: discoveredModel.id, name: discoveredModel.name });
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const removeModel = useCallback((providerName: string, index: number) => {
    savedModelIdsRef.current.get(providerName)?.splice(index, 1);
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
  }, []);

  const handleSave = useCallback(async () => {
    if (loadError) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    // A provider name typed but not applied with Rename is still a visible
    // edit: move the provider before writing, like every other field.
    let draft = config;
    const pendingName = providerNameDraft?.name.trim();
    if (providerNameDraft && pendingName && config.providers?.[providerNameDraft.provider]) {
      const renamed = applyProviderRename(config, providerNameDraft.provider, pendingName);
      if (!renamed) {
        setSaveError(t("models.providerNameTaken", { name: pendingName }));
        setSaving(false);
        return;
      }
      draft = renamed;
    }
    try {
      const res = await request("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = await res.json() as { success?: boolean; applied?: boolean; error?: string };
      if (!res.ok || (d.error !== undefined && d.applied !== false)) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        setTimeout(() => setSavedOk(false), 2000);
        // The backend reports a write it could not apply as saved-but-not-applied rather than as success, and the two
        // are different facts about the same file: only an applied save is a catalog the running backend now serves.
        if (d.applied === false) {
          setSaveError(t("models.savedNotApplied", { error: d.error ?? "" }));
          // Saved but not applied: the file is the authority for what this panel now edits, so it is read back rather
          // than the draft being assumed — and the switches are left alone, because the catalog they are verified
          // against is still the one the runtime is serving.
          void readConfig();
        } else {
          setSavedOk(true);
          // The catalog the runtime serves just changed: this page's one rule says so, which drops the held answer and
          // re-reads every mounted composer — while Settings is open, not when it closes.
          invalidateModelCatalog();
          // models.json changed under the switches too: providers may have been renamed, models added, deleted or
          // renamed, so the stored patterns are re-verified against the catalog that save produced.
          const renames = [...renamesRef.current].map(([from, to]) => ({ from, to }));
          const modelRenames = collectModelRenames(draft, savedModelIdsRef.current, renamesRef.current);
          savedProvidersRef.current = new Set(Object.keys(draft.providers ?? {}));
          savedModelIdsRef.current = savedModelIds(draft);
          renamesRef.current.clear();
          enabledModels.resync(renames, modelRenames);
        }
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, [applyProviderRename, config, enabledModels, loadError, providerNameDraft, readConfig, request, t]);

  const providers = Object.entries(config.providers ?? {});
  // `12/40` next to a provider makes a narrowed selector visible at a glance.
  const scopeBadge = (providerId: string) => {
    const label = providerBadgeLabel(enabledModels.view, providerId);
    return label ? <span className="models-sidebar-badge">{label}</span> : null;
  };
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={credentialChanged} enabledModels={enabledModels} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={credentialChanged} enabledModels={enabledModels} />;
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          editingName={providerNameDraft?.provider === selection.name ? providerNameDraft.name : selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onEditingNameChange={(n) => setProviderNameDraft(n === selection.name ? null : { provider: selection.name, name: n })}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
          onAddModels={(models) => addDiscoveredModels(selection.name, models)}
          enabledModels={enabledModels}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
    {/* The file lives in the backend process's agent directory, which this process never reads or writes; the label names
          the authority rather than a path this host would not own. */}
    <ConfigPanelShell embedded={embedded} title={t("common.models")} subtitle={t("models.configLocation")} closeLabel={t("i18n.close")} onClose={onClose}>

        <EnabledModelsBanner controller={enabledModels} />

        {/* Why the provider list on the left is not the host's list, when it is not: a listing that could not be read
          keeps what it last read and says so, rather than showing an empty set that would read as "nothing is
          configured on this host". A deployment that serves no provider credentials at all is named by the capability
          gate in the picker instead, not here. */}
        {providerAuthFault !== null && (
          <div style={{ padding: "0 14px 8px", fontSize: 11, color: "#f87171", lineHeight: 1.5 }} role="status">
            {providerAuthFault.key === undefined ? providerAuthFault.detail : t(providerAuthFault.key)}
            {providerAuthFault.retry && (
              <button
                type="button"
                onClick={refreshAuthProviders}
                style={{ marginLeft: 8, fontSize: 11, padding: "2px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", cursor: "pointer" }}
              >
                {t("i18n.retryLoad")}
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <ConfigSplitView>

          {/* Left: tree */}
          <ConfigSidebar>
            <ConfigSidebarList>
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.name}</ConfigSidebarText>
                    {scopeBadge(p.id)}
                  </ConfigSidebarItem>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.displayName}</ConfigSidebarText>
                    {scopeBadge(p.id)}
                  </ConfigSidebarItem>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
              )}

              {/* Custom providers */}
              {loading ? (
                 <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} style={{ marginBottom: 2 }}>
                    {/* Provider row */}
                    <ConfigSidebarItem
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      active={isProviderSelected}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                      <ConfigSidebarText className="is-grow">
                        {pName}
                      </ConfigSidebarText>
                      {scopeBadge(pName)}
                    </ConfigSidebarItem>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <ConfigSidebarItem
                          key={i}
                          active={isModelSelected}
                          className="models-sidebar-indented-item"
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                        >
                          <ConfigSidebarText className="is-grow" style={{ color: m.id ? "var(--text-muted)" : "var(--text-dim)" }}>
                             {m.id || t("i18n.newModel")}
                          </ConfigSidebarText>
                          {m.reasoning && (
                            <span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.8)", borderRadius: 3, flexShrink: 0 }}>T</span>
                          )}
                        </ConfigSidebarItem>
                      );
                    })}

                    {/* Add model button */}
                    <ConfigSidebarItem
                      className="models-sidebar-indented-item models-sidebar-add-item"
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                    >
                       <ConfigSidebarText>+ {t("i18n.model")}</ConfigSidebarText>
                    </ConfigSidebarItem>
                  </div>
                );
              })}
            </ConfigSidebarList>

            {/* Add provider */}
            <ConfigListAction onClick={() => setPickerOpen(true)}>{t("i18n.addProvider")}</ConfigListAction>
          </ConfigSidebar>

          {/* Right: detail */}
          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {loading ? null : detailContent ?? (
                <ConfigEmptyState>{t("i18n.selectProviderModel")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>

        {/* Footer */}
        <ConfigFooter status={(loadError || saveError) && (
          <span style={{ color: "#f87171" }}>
            {loadError ? t("models.configUnreadable", { error: loadError }) : saveError}
          </span>
        )}>
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
          <ConfigButton
            variant="primary"
            onClick={handleSave}
            disabled={saving || savedOk || loadError !== null}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
             <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}</span>
          </ConfigButton>
        </ConfigFooter>
    </ConfigPanelShell>
    {pickerOpen && (
      <AddProviderPicker
        providerAuthServed={providerAuthServed}
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
