/**
 * The composer's model and reasoning readout: what the conversation is running on, and the one control that changes it.
 *
 * The readout is a *reader* of the conversation's own model state — it never keeps a second writable copy. The selected
 * model, whether it is the automatic choice for a fresh composer, the levels the runtime offers, and the label each level
 * maps to all arrive from the conversation's domain; this surface states them and reports the user's pick back through
 * one callback. The same is true of the "not offered by this deployment" label: it is computed from the catalog the
 * domain read, because a selection this catalog does not list is a fact about the selection, not about the surface.
 */
import type { ModelSelectorOption } from "../ModelSelector";
import { ModelSelector } from "../ModelSelector";
import { SelectorRow } from "../SelectorRow";
import { useI18n } from "../../hooks/useI18n";
import { useIsMobile } from "../../hooks/useIsMobile";

export type ThinkingLevel = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_DESC_KEYS: Record<ThinkingLevel, string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

export interface ModelReadout {
  /** The conversation's selected model, or `null` while it has none. */
  model?: { provider: string; modelId: string } | null;
  /** A fresh composer has not committed a model; it is running on the resolved default. */
  isAutoSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: readonly ModelSelectorOptionInput[];
  /** The catalog's own failure to read, stated where the model would be chosen. */
  modelError?: string | null;
  onModelChange?: (provider: string, modelId: string) => void;
  switching?: boolean;
}

export interface ModelSelectorOptionInput {
  id: string;
  name: string;
  provider: string;
  input?: string[];
}

/** The model picker, drawn from the catalog the conversation read. Rendered only when the conversation can change it. */
export function ComposerModelControl({ readout, disabled }: { readout: ModelReadout; disabled: boolean }) {
  const { t } = useI18n();
  const modelOptions: ModelSelectorOption[] = (() => {
    if (readout.modelList && readout.modelList.length > 0) {
      return readout.modelList.map((entry) => ({ provider: entry.provider, modelId: entry.id, name: entry.name }));
    }
    return Object.entries(readout.modelNames ?? {}).map(([modelId, name]) => ({
      provider: readout.model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();
  if (!readout.onModelChange || (modelOptions.length === 0 && !readout.model && !readout.modelError)) return null;
  // A selection the catalog no longer offers stays selected and is named as unavailable, so the user can see which model
  // their conversation is on instead of being shown a model this deployment does not serve. An empty list means the
  // catalog itself could not be read, which says nothing about this selection.
  const missingModel = readout.model !== null && readout.model !== undefined
    && (readout.modelList?.length ?? 0) > 0
    && !readout.modelList!.some((entry) => entry.provider === readout.model!.provider && entry.id === readout.model!.modelId);
  return (
    <ModelSelector
      options={modelOptions}
      value={readout.model}
      selectedLabel={missingModel ? t("chat.modelUnavailable", { model: readout.model!.provider + "/" + readout.model!.modelId }) : undefined}
      onChange={readout.onModelChange}
      disabled={disabled}
      busy={readout.switching}
      isAutoSelection={readout.isAutoSelection}
    />
  );
}

export interface ThinkingReadout {
  level?: ThinkingLevel;
  isAutoSelection?: boolean;
  onLevelChange?: (level: ThinkingLevel) => void;
  availableLevels?: string[] | null;
  levelMap?: Record<string, string | null> | null;
}

/**
 * The reasoning effort control.
 *
 * It states the level the conversation is on — including a resolved default — and offers the levels the runtime names.
 * A mapped label is shown beside the level it stands for, so the runtime's own naming is visible without the surface
 * inventing one.
 */
export function ComposerThinkingControl({ readout, isStreaming, open, onOpenChange }: {
  readout: ThinkingReadout;
  isStreaming: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  if (!readout.onLevelChange) return null;
  const resolved = readout.level && readout.level !== "auto" ? readout.level : null;
  const displayLabel = (() => {
    const level = resolved ?? "auto";
    if (level === "auto" || !readout.levelMap) return level;
    return readout.levelMap[level] ?? level;
  })();
  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => onOpenChange(!open)}
        title={isStreaming
          ? t("chat.currentReasoning", { level: displayLabel })
          : t("chat.changeReasoning", { level: displayLabel })}
        aria-label={t("chat.changeReasoningLabel")}
        aria-expanded={open ? true : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          padding: isMobile ? "0 6px" : "8px 12px",
          width: isMobile ? "auto" : undefined,
          height: 32,
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 9,
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
          <line x1="7" y1="18" x2="12" y2="18" />
          <line x1="8" y1="21" x2="11" y2="21" />
        </svg>
        {(!isMobile || open) && <span style={{ whiteSpace: "nowrap" }}>{displayLabel}</span>}
      </button>
      {open && (
        <div style={{
          position: "absolute", bottom: "calc(100% + 6px)",
          ...(isMobile ? { left: 0 } : { right: 0 }),
          zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
          overflow: "hidden", minWidth: 180,
        }}>
          {THINKING_LEVELS.filter((level) => {
            if (!readout.availableLevels || level === "auto") return true;
            return readout.availableLevels.includes(level);
          }).map((level) => {
            const isActive = level === "auto"
              ? readout.isAutoSelection === true
              : readout.isAutoSelection !== true && resolved === level;
            const mapped = (level !== "auto" && readout.levelMap) ? readout.levelMap[level] : undefined;
            const label = (mapped != null && mapped !== level) ? mapped : level;
            return (
              <SelectorRow
                key={level}
                active={isActive}
                onSelect={() => {
                  onOpenChange(false);
                  if (level === "auto") {
                    if (!readout.isAutoSelection) readout.onLevelChange?.("auto");
                    return;
                  }
                  if (!isActive || readout.isAutoSelection) readout.onLevelChange?.(level);
                }}
              >
                <span style={{ flex: 1 }}>
                  {label}
                  {mapped != null && mapped !== level && (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({level})</span>
                  )}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{t(THINKING_LEVEL_DESC_KEYS[level])}</span>
              </SelectorRow>
            );
          })}
        </div>
      )}
    </div>
  );
}
