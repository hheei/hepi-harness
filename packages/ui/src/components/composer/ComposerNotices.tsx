/**
 * The composer's own notices: what the model catalog, the newest run, the draft store and the attachment list have to say
 * above the input.
 *
 * None of them is a chat entry — they state a fact about the surface the user is about to send from — and none of them
 * decides anything: the model catalog states the error, the run's failure arrives already classified by the Backend, the
 * draft store reports its own refusal, and the attachment rule names a refused file. This module draws them and states
 * the one rule about pictures it can answer alone: whether a model is known to accept them.
 */
import { useI18n } from "../../hooks/useI18n";

function ModelNoticeBanner({ tone, title, body, onClose, action }: {
  tone: "error" | "warning";
  title: string;
  body: string;
  onClose?: () => void;
  /** The one step this notice can offer: stated by the notice that knows it can be recovered from. */
  action?: { label: string; onClick: () => void };
}) {
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            style={{ marginTop: 4, padding: "2px 7px", background: "none", border: `1px solid rgba(${color},0.4)`, borderRadius: 4, color: `rgb(${color})`, fontSize: 11, cursor: "pointer" }}
          >
            {action.label}
          </button>
        )}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The catalog could not be read: what failed, and the one step that can change it.
 *
 * The recovery is a read of the same catalog, never a resend and never a different selection — a list that failed to
 * arrive says nothing about the model the conversation is on, so the selection on screen stays and this only offers the
 * deployment another chance to state its list.
 */
export function ModelErrorBanner({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const { t } = useI18n();
  if (!error) return null;
  return (
    <ModelNoticeBanner
      tone="error"
      title={t("chat.modelError")}
      body={error}
      action={onRetry === undefined ? undefined : { label: t("i18n.retryLoad"), onClick: onRetry }}
    />
  );
}

/**
 * The framework's own outcome for the newest terminal run, as the backend projects it from its durable task record.
 * A missing model gets one explicit sentence naming the recovery, because the user's next move is to pick another
 * model; every other failure shows the backend's own message unchanged. This is a notice, not a chat entry: the
 * transcript keeps showing what really happened (a user turn that was never answered).
 */
export function RunFailureBanner({ failure }: { failure?: { reason: string; message: string } | null }) {
  const { t } = useI18n();
  if (!failure) return null;
  const body = failure.reason === "no_model"
    ? t("chat.runFailureNoModel", { message: failure.message })
    : failure.message;
  return <ModelNoticeBanner tone="error" title={t("chat.runFailureTitle")} body={body} />;
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  const { t } = useI18n();
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? t("chat.modelScopeWarnings") : t("chat.modelScopeWarning")}
      body={warnings.join("\n")}
    />
  );
}

/** The draft the browser refused to keep. It stays in memory; what it cannot promise is that a refresh would hold it. */
export function DraftStorageBanner({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <ModelNoticeBanner
      tone="warning"
      title={t("chat.draftNotStoredTitle")}
      body={t("chat.draftNotStoredBody")}
      onClose={onClose}
    />
  );
}

/** Every refused file named, because an unsupported type, an oversized image and a full list are three problems. */
export function ImageRejectionBanner({ rejections, onClose }: {
  rejections: readonly { name: string; reason: "unsupported" | "too-large" | "too-many" }[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  if (rejections.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={t("chat.imageRejectedTitle")}
      body={rejections.map((rejection) => t(
        rejection.reason === "unsupported"
          ? "chat.imageRejectedUnsupported"
          : rejection.reason === "too-large"
            ? "chat.imageRejectedTooLarge"
            : "chat.imageRejectedTooMany",
        { names: rejection.name },
      )).join("\n")}
      onClose={onClose}
    />
  );
}

/** Pictures attached to a model that is known not to read them (#584). Unknown modality info never blocks the user. */
export function ImageNotSupportedBanner({ modelLabel, onClose }: { modelLabel: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <ModelNoticeBanner
      tone="warning"
      title={t("chat.imageNotSupportedTitle")}
      body={t("chat.imageNotSupportedBody", { model: modelLabel })}
      onClose={onClose}
    />
  );
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}
